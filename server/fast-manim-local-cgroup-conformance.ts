import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type {
  FastManimSandboxBoundedOutputLifecycleV1,
  LinuxCgroupV2ResourceControllerV1,
  LinuxCgroupV2ResourceJobV1,
} from "./fast-manim-linux-cgroup-v2";
import { deriveLinuxCgroupV2OrchestratorPathV1 } from "./fast-manim-linux-cgroup-v2";
import {
  FAST_MANIM_SANDBOX_BOUNDED_OUTPUT_SCHEMA_V1,
  FAST_MANIM_SANDBOX_OUTPUT_CLOSED_SCHEMA_V1,
  type FastManimSandboxResourceFailureCodeV1,
  type FastManimSandboxResourceLimitsV1,
  type FastManimSandboxResourceTerminationReasonV1,
  fastManimSandboxResourceControlErrorCode,
  parseFastManimSandboxResourceLimitsV1,
} from "./fast-manim-sandbox-resources";

const CGROUP2_SUPER_MAGIC = 0x63677270;
const DELEGATED_ROOT_NAME = "poietra-sandbox-v1";
const DEFAULT_SHELL = "/bin/sh";
const DEFAULT_PRLIMIT = "/usr/bin/prlimit";
const DEFAULT_UNSHARE = "/usr/bin/unshare";
const MAX_COMMAND_ARGUMENTS = 128;
const MAX_COMMAND_ARGUMENT_BYTES = 4096;
const MAX_COMMAND_BYTES = 64 * 1024;
const STOP_WAIT_MS = 2_000;

const MOUNT_NAMESPACE_SCRIPT = String.raw`
set -eu
runtime_bytes=$1
runtime_inodes=$2
shared_bytes=$3
shared_inodes=$4
runtime_dir=$5
shift 5
mount -t tmpfs -o "size=$runtime_bytes,nr_inodes=$runtime_inodes,mode=700,nodev,nosuid,noexec" tmpfs "$runtime_dir"
mkdir "$runtime_dir/shared-memory"
mount -t tmpfs -o "size=$shared_bytes,nr_inodes=$shared_inodes,mode=700,nodev,nosuid,noexec" tmpfs "$runtime_dir/shared-memory"
cd "$runtime_dir"
exec "$@"
`;

const STOPPED_LAUNCH_SCRIPT = 'kill -STOP "$$"; exec "$@"';

export type LinuxCgroupV2LocalConformanceSkipCodeV1 =
  | "cgroup-controllers-unavailable"
  | "cgroup-delegation-not-writable"
  | "cgroup-root-invalid"
  | "cgroup-root-not-configured"
  | "cgroup-root-not-exclusive"
  | "cgroup-runner-outside-delegation"
  | "linux-required"
  | "local-tools-unavailable"
  | "mount-namespace-unavailable"
  | "not-cgroup-v2";

export type LinuxCgroupV2LocalConformanceAvailabilityV1 =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ code: LinuxCgroupV2LocalConformanceSkipCodeV1; kind: "skip" }>;

/** Read-only local lane probe. It returns a bounded reason and never returns the configured host path. */
export function probeLinuxCgroupV2LocalConformanceV1(
  root: string | undefined,
): LinuxCgroupV2LocalConformanceAvailabilityV1 {
  if (process.platform !== "linux") return { code: "linux-required", kind: "skip" } as const;
  if (!root) return { code: "cgroup-root-not-configured", kind: "skip" } as const;
  if (!isAbsolute(root) || basename(resolve(root)) !== DELEGATED_ROOT_NAME) {
    return { code: "cgroup-root-invalid", kind: "skip" } as const;
  }
  let relativeRoot: string;
  try {
    relativeRoot = deriveLinuxCgroupV2OrchestratorPathV1(root);
  } catch {
    return { code: "cgroup-root-invalid", kind: "skip" } as const;
  }
  try {
    const canonical = realpathSync(root);
    const filesystem = statfsSync(root);
    if (canonical !== resolve(root) || filesystem.type !== CGROUP2_SUPER_MAGIC) {
      return { code: "not-cgroup-v2", kind: "skip" } as const;
    }
    if (readFileSync(join(root, "cgroup.type"), "utf8").trim() !== "domain") {
      return { code: "cgroup-root-invalid", kind: "skip" } as const;
    }
    if (readFileSync(join(root, "cgroup.procs"), "utf8").trim().length !== 0) {
      return { code: "cgroup-root-not-exclusive", kind: "skip" } as const;
    }
    const controllers = new Set(readFileSync(join(root, "cgroup.controllers"), "utf8").trim().split(/\s+/u));
    if (["cpu", "memory", "pids"].some((controller) => !controllers.has(controller))) {
      return { code: "cgroup-controllers-unavailable", kind: "skip" } as const;
    }
    accessSync(root, fsConstants.W_OK);
    accessSync(join(root, "cgroup.subtree_control"), fsConstants.W_OK);
    accessSync(join(root, "cgroup.kill"), fsConstants.W_OK);
    accessSync(join(dirname(root), "cgroup.procs"), fsConstants.W_OK);
  } catch {
    return { code: "cgroup-delegation-not-writable", kind: "skip" } as const;
  }
  let processCgroup: string | undefined;
  try {
    processCgroup = /^0::(\/[^\n]*)$/u.exec(readFileSync("/proc/self/cgroup", "utf8").trim())?.[1];
  } catch {
    // The bounded code below covers an unreadable or non-unified proc view.
  }
  const relativeParent = dirname(relativeRoot);
  const delegatedParent = relativeParent === "." ? "/" : `/${relativeParent}`;
  const runnerIsDelegated =
    delegatedParent === "/"
      ? processCgroup?.startsWith("/")
      : processCgroup === delegatedParent || processCgroup?.startsWith(`${delegatedParent}/`);
  if (!runnerIsDelegated) {
    return { code: "cgroup-runner-outside-delegation", kind: "skip" } as const;
  }
  try {
    accessSync(DEFAULT_PRLIMIT, fsConstants.X_OK);
    accessSync(DEFAULT_SHELL, fsConstants.X_OK);
    accessSync(DEFAULT_UNSHARE, fsConstants.X_OK);
  } catch {
    return { code: "local-tools-unavailable", kind: "skip" } as const;
  }
  const namespaceDirectory = mkdtempSync(join(tmpdir(), "poietra-cgroup-probe-"));
  let namespaceProbe: ReturnType<typeof spawnSync>;
  try {
    namespaceProbe = spawnSync(
      DEFAULT_UNSHARE,
      [
        "--user",
        "--map-root-user",
        "--mount",
        DEFAULT_SHELL,
        "-c",
        'set -eu; /bin/mount -t tmpfs -o size=1048576,nr_inodes=16,nodev,nosuid,noexec tmpfs "$1"; /bin/umount "$1"',
        "poietra-probe-v1",
        namespaceDirectory,
      ],
      { stdio: "ignore", timeout: 2_000 },
    );
  } finally {
    rmSync(namespaceDirectory, { force: true, recursive: true });
  }
  if (namespaceProbe.status !== 0) return { code: "mount-namespace-unavailable", kind: "skip" } as const;
  return { kind: "ready" } as const;
}

export type LocalCgroupConformanceRunV1 = Readonly<{
  command: readonly string[];
  limits: FastManimSandboxResourceLimitsV1;
  signal?: AbortSignal;
}>;

export type LocalCgroupConformanceResultV1 =
  | Readonly<{
      kind: "failed";
      reason: FastManimSandboxResourceFailureCodeV1;
      stderrByteCount: number;
      stderrSha256: string | null;
    }>
  | Readonly<{
      kind: "ok";
      stderrByteCount: number;
      stderrSha256: string | null;
      stdout: Uint8Array;
    }>;

export type LocalLinuxCgroupV2ConformanceHarnessOptionsV1 = Readonly<{
  controller: LinuxCgroupV2ResourceControllerV1;
  prlimitPath?: string;
  shellPath?: string;
  unsharePath?: string;
}>;

function executablePath(value: string, name: string) {
  if (!isAbsolute(value) || value.includes("\0")) throw new TypeError(`${name} must be an absolute executable path.`);
  return value;
}

function commandArguments(value: readonly string[]) {
  if (value.length === 0 || value.length > MAX_COMMAND_ARGUMENTS) {
    throw new TypeError("The local conformance command has an invalid argument count.");
  }
  let bytes = 0;
  const command = value.map((argument) => {
    const argumentBytes = Buffer.byteLength(argument, "utf8");
    if (argument.includes("\0") || argumentBytes === 0 || argumentBytes > MAX_COMMAND_ARGUMENT_BYTES) {
      throw new TypeError("The local conformance command contains an invalid argument.");
    }
    bytes += argumentBytes;
    return argument;
  });
  if (bytes > MAX_COMMAND_BYTES) throw new TypeError("The local conformance command exceeds its byte budget.");
  return Object.freeze(command);
}

function failedResult(
  reason: FastManimSandboxResourceFailureCodeV1,
  stderrByteCount = 0,
  stderrSha256: string | null = null,
): LocalCgroupConformanceResultV1 {
  return Object.freeze({ kind: "failed", reason, stderrByteCount, stderrSha256 });
}

function classifyExit(code: number | null, signal: NodeJS.Signals | null): FastManimSandboxResourceTerminationReasonV1 {
  if (code === 0) return "completed";
  if (signal === "SIGXCPU") return "cpu-limit";
  if (signal === "SIGXFSZ" || code === 74) return "file-limit";
  if (code === 73) return "fd-limit";
  if (code === 75) return "tmpfs-limit";
  return "launch-failed";
}

/**
 * Local-only adversarial harness. The trusted shell self-stops before prlimit,
 * unshare, or the target command runs; only then is that stopped PID attached
 * to the prepared cgroup. Production must use the launch.cgroupsPath contract.
 */
export class LocalLinuxCgroupV2ConformanceHarnessV1 {
  readonly #controller: LinuxCgroupV2ResourceControllerV1;
  readonly #prlimitPath: string;
  readonly #shellPath: string;
  readonly #unsharePath: string;

  constructor(options: LocalLinuxCgroupV2ConformanceHarnessOptionsV1) {
    this.#controller = options.controller;
    this.#prlimitPath = executablePath(options.prlimitPath ?? DEFAULT_PRLIMIT, "prlimit");
    this.#shellPath = executablePath(options.shellPath ?? DEFAULT_SHELL, "shell");
    this.#unsharePath = executablePath(options.unsharePath ?? DEFAULT_UNSHARE, "unshare");
  }

  async run(input: LocalCgroupConformanceRunV1): Promise<LocalCgroupConformanceResultV1> {
    const command = commandArguments(input.command);
    const limits = parseFastManimSandboxResourceLimitsV1(input.limits);
    if (input.signal?.aborted) return failedResult("aborted");
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "poietra-cgroup-conformance-"));
    let child: ChildProcess | null = null;
    let childClosed = false;
    let closeOutputPromise: Promise<void> | null = null;
    let settleChildClose!: (exit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void;
    let settleChildExit!: (exit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void;
    const childExit = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
      (resolvePromise) => {
        settleChildExit = resolvePromise;
      },
    );
    const childClose = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
      (resolvePromise) => {
        settleChildClose = resolvePromise;
      },
    );
    const output: FastManimSandboxBoundedOutputLifecycleV1 = {
      async close() {
        closeOutputPromise ??= (async () => {
          child?.stdin?.destroy();
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          if (child?.pid && child.exitCode === null && child.signalCode === null) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // The kernel may already have reaped the local wrapper through cgroup.kill.
            }
          }
          if (child) await childClose;
          await rm(runtimeDirectory, { force: true, recursive: true });
          childClosed = true;
        })();
        return closeOutputPromise;
      },
      closureEvidence: () =>
        childClosed
          ? {
              resultClosed: true,
              schema: FAST_MANIM_SANDBOX_OUTPUT_CLOSED_SCHEMA_V1,
              stderrClosed: true,
              stdoutClosed: true,
              version: 1,
            }
          : null,
      descriptor: {
        maxResultBytes: limits.maxResultBytes,
        maxStderrBytes: limits.maxStderrBytes,
        maxStdoutBytes: limits.maxStdoutBytes,
        schema: FAST_MANIM_SANDBOX_BOUNDED_OUTPUT_SCHEMA_V1,
        version: 1,
      },
    };

    let job: LinuxCgroupV2ResourceJobV1;
    try {
      job = await this.#controller.admit(limits, output);
    } catch (error) {
      await output.close("launch-failed").catch(() => undefined);
      const code = fastManimSandboxResourceControlErrorCode(error);
      return failedResult(code === "capacity" ? "capacity" : code === "cleanup" ? "cleanup-failed" : "launch-failed");
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stderrDigest = createHash("sha256");
    let finishRequested = false;
    const requestFinish = (reason: FastManimSandboxResourceTerminationReasonV1) => {
      if (finishRequested) return;
      finishRequested = true;
      void job.finish(reason).catch(() => undefined);
    };

    try {
      const cpuSeconds = Math.ceil(limits.maxCpuTimeMicros / 1_000_000);
      const constrainedCommand = [
        this.#prlimitPath,
        `--core=0:0`,
        `--cpu=${cpuSeconds}:${cpuSeconds}`,
        `--fsize=${limits.maxFileBytes}:${limits.maxFileBytes}`,
        `--nofile=${limits.maxOpenFiles}:${limits.maxOpenFiles}`,
        "--",
        this.#unsharePath,
        "--user",
        "--map-root-user",
        "--mount",
        "--fork",
        "--",
        this.#shellPath,
        "-c",
        MOUNT_NAMESPACE_SCRIPT,
        "poietra-mount-v1",
        String(limits.maxRuntimeTmpfsBytes),
        String(limits.maxRuntimeTmpfsInodes),
        String(limits.maxSharedMemoryBytes),
        String(limits.maxSharedMemoryInodes),
        runtimeDirectory,
        ...command,
      ];
      child = spawn(this.#shellPath, ["-c", STOPPED_LAUNCH_SCRIPT, "poietra-stopped-v1", ...constrainedCommand], {
        cwd: runtimeDirectory,
        detached: true,
        env: {
          HOME: runtimeDirectory,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/bin:/bin",
          TEMP: runtimeDirectory,
          TMP: runtimeDirectory,
          TMPDIR: runtimeDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.once("error", () => requestFinish("launch-failed"));
      child.once("exit", (code, signal) => settleChildExit({ code, signal }));
      child.once("close", (code, signal) => {
        settleChildExit({ code, signal });
        settleChildClose({ code, signal });
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (finishRequested) return;
        const nextBytes = stdoutBytes + chunk.byteLength;
        if (nextBytes > limits.maxStdoutBytes) {
          stdoutBytes = limits.maxStdoutBytes + 1;
          stdoutChunks.length = 0;
          requestFinish("stdout-overflow");
          return;
        }
        if (nextBytes > limits.maxResultBytes) {
          stdoutBytes = limits.maxResultBytes + 1;
          stdoutChunks.length = 0;
          requestFinish("result-overflow");
          return;
        }
        stdoutBytes = nextBytes;
        stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (finishRequested) return;
        const nextBytes = stderrBytes + chunk.byteLength;
        if (nextBytes > limits.maxStderrBytes) {
          stderrBytes = limits.maxStderrBytes + 1;
          requestFinish("stderr-overflow");
          return;
        }
        stderrBytes = nextBytes;
        stderrDigest.update(chunk);
      });

      const pid = child.pid;
      if (!pid) {
        requestFinish("launch-failed");
      } else {
        await this.#waitForStopped(pid, child);
        await job.attachStoppedPidForLocalConformance(pid, {
          processState: "stopped",
          trust: "local-conformance-only",
        });
        process.kill(pid, "SIGCONT");
      }

      const abort = () => requestFinish("aborted");
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) requestFinish("aborted");
      let reason: FastManimSandboxResourceTerminationReasonV1;
      try {
        const first = await Promise.race([
          childExit.then((exit) => ({ exit, kind: "exit" as const })),
          job.completion.then((completionReason) => ({ completionReason, kind: "resource" as const })),
        ]);
        if (first.kind === "resource") {
          reason = first.completionReason;
        } else {
          const evidence = await job.inspect().catch(() => null);
          reason = evidence?.reason ?? classifyExit(first.exit.code, first.exit.signal);
          await job.finish(reason);
          reason = await job.completion;
        }
      } finally {
        input.signal?.removeEventListener("abort", abort);
      }
      const stderrSha256 = stderrBytes > 0 && stderrBytes <= limits.maxStderrBytes ? stderrDigest.digest("hex") : null;
      if (reason !== "completed") return failedResult(reason, stderrBytes, stderrSha256);
      return Object.freeze({
        kind: "ok",
        stderrByteCount: stderrBytes,
        stderrSha256,
        stdout: Uint8Array.from(Buffer.concat(stdoutChunks, stdoutBytes)),
      });
    } catch {
      requestFinish("launch-failed");
      const reason = await job.completion.catch(() => "cleanup-failed" as const);
      return failedResult(reason === "completed" ? "launch-failed" : reason, stderrBytes, null);
    }
  }

  async #waitForStopped(pid: number, child: ChildProcess) {
    const deadline = performance.now() + STOP_WAIT_MS;
    while (performance.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("The stopped wrapper exited early.");
      try {
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        if (/^State:\s+[Tt]/mu.test(status)) return;
      } catch {
        // The bounded loop will classify a missing wrapper as launch failure.
      }
      await delay(5);
    }
    throw new Error("The local conformance wrapper did not self-stop.");
  }

  shutdown() {
    return this.#controller.shutdown();
  }
}
