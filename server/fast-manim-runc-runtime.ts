import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";

import { z } from "zod";

const RUNC_CONTAINER_ID_PATTERN = /^poietra-job-v1-[0-9a-f]{32}-[1-9a-z][0-9a-z]*$/u;
const MAX_RUNC_CONTROL_STDOUT_BYTES = 8 * 1024;
const MAX_RUNC_CONTROL_STDERR_BYTES = 32 * 1024;
const MAX_RUNC_CONTROL_TIMEOUT_MS = 30_000;
const RUNC_CONTROL_ENV_V1 = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/bin:/usr/sbin:/bin:/sbin",
});

const runcStateBaseV1 = {
  bundle: z.string(),
  id: z.string().regex(RUNC_CONTAINER_ID_PATTERN),
};
const runcStateV1Schema = z.discriminatedUnion("status", [
  z.object({ ...runcStateBaseV1, pid: z.number().int().positive(), status: z.literal("created") }).passthrough(),
  z.object({ ...runcStateBaseV1, pid: z.number().int().positive(), status: z.literal("running") }).passthrough(),
  // OCI does not require an init PID after exit; runc may report zero for a
  // retained stopped container while its immutable ID and bundle remain.
  z.object({ ...runcStateBaseV1, pid: z.literal(0), status: z.literal("stopped") }).passthrough(),
]);

export type FastManimRuncStateV1 = Readonly<z.infer<typeof runcStateV1Schema>>;

export type FastManimRuncCreatedProcessV1 = Readonly<{
  /** Resolves when the runc create client exits successfully; OCI init remains stopped in `created`. */
  created: Promise<void>;
  stderr: Readable;
  stdin: Writable;
  stdout: Readable;
  terminateCreateClient: () => void;
}>;

export interface FastManimRuncRuntimeV1 {
  assertReady(deadlineEpochMs: number, signal: AbortSignal): Promise<void>;
  create(
    options: Readonly<{ bundlePath: string; containerId: string; deadlineEpochMs: number }>,
  ): FastManimRuncCreatedProcessV1;
  delete(containerId: string, deadlineEpochMs: number): Promise<void>;
  kill(containerId: string, deadlineEpochMs: number): Promise<void>;
  start(containerId: string, deadlineEpochMs: number, signal?: AbortSignal): Promise<void>;
  state(containerId: string, deadlineEpochMs: number, signal?: AbortSignal): Promise<FastManimRuncStateV1>;
}

type SpawnRuncV1 = typeof spawn;
const productionRuncRuntimes = new WeakSet<object>();

export type FastManimRuncCliRuntimeOptionsV1 = Readonly<{
  bundleRoot: string;
  /** Test-only process seam. Production must use the default `/usr/bin/runc`. */
  spawnProcess?: SpawnRuncV1;
  stateRoot: string;
}>;

function canonicalAbsoluteDirectory(value: string, label: string) {
  if (!isAbsolute(value) || value !== resolve(value)) {
    throw new TypeError(`${label} must be an absolute canonical path.`);
  }
  return value;
}

function boundedDeadline(value: number) {
  if (!Number.isSafeInteger(value) || value <= Date.now()) {
    throw new TypeError("The runc operation deadline must be a future epoch millisecond integer.");
  }
  return Math.min(value - Date.now(), MAX_RUNC_CONTROL_TIMEOUT_MS);
}

function parseContainerId(value: string) {
  if (!RUNC_CONTAINER_ID_PATTERN.test(value)) throw new TypeError("The runc container ID is not server-generated.");
  return value;
}

function isStrictDescendant(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function appendBounded(chunks: Buffer[], chunk: unknown, currentBytes: number, maximumBytes: number) {
  if (!(chunk instanceof Uint8Array)) throw new TypeError("runc emitted a non-byte stream chunk.");
  const bytes = Buffer.from(chunk);
  const nextBytes = currentBytes + bytes.byteLength;
  if (!Number.isSafeInteger(nextBytes) || nextBytes > maximumBytes) {
    throw new RangeError("runc control output exceeded its fixed byte budget.");
  }
  chunks.push(bytes);
  return nextBytes;
}

/**
 * Closed production CLI adapter. There is deliberately no generic command,
 * argv, environment, cwd, or executable option. The only subprocess is the
 * host-owned `/usr/bin/runc`, with an explicit state root and empty stdin for
 * control operations.
 */
export class FastManimRuncCliRuntimeV1 implements FastManimRuncRuntimeV1 {
  readonly #bundleRoot: string;
  readonly #spawn: SpawnRuncV1;
  readonly #stateRoot: string;

  constructor(options: FastManimRuncCliRuntimeOptionsV1) {
    this.#bundleRoot = canonicalAbsoluteDirectory(options.bundleRoot, "The runc bundle root");
    this.#stateRoot = canonicalAbsoluteDirectory(options.stateRoot, "The runc state root");
    if (this.#bundleRoot === this.#stateRoot) {
      throw new TypeError("The runc bundle and state roots must be distinct.");
    }
    this.#spawn = options.spawnProcess ?? spawn;
    if (options.spawnProcess === undefined) productionRuncRuntimes.add(this);
  }

  async assertReady(deadlineEpochMs: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const [canonicalStateRoot, metadata] = await Promise.all([realpath(this.#stateRoot), lstat(this.#stateRoot)]);
    signal.throwIfAborted();
    if (typeof process.getuid !== "function" || typeof process.getgid !== "function" || process.getuid() === 0) {
      throw new Error("The fixed runc runtime requires a non-root POSIX process identity.");
    }
    if (
      canonicalStateRoot !== this.#stateRoot ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() ||
      metadata.gid !== process.getgid() ||
      (metadata.mode & 0o7777) !== 0o700
    ) {
      throw new Error("The fixed runc state root does not satisfy its ownership and mode contract.");
    }
    signal.throwIfAborted();
    await this.#control(["--version"], deadlineEpochMs, true, signal);
    signal.throwIfAborted();
  }

  create(options: Readonly<{ bundlePath: string; containerId: string; deadlineEpochMs: number }>) {
    const containerId = parseContainerId(options.containerId);
    const bundlePath = canonicalAbsoluteDirectory(options.bundlePath, "The runc job bundle");
    if (!isStrictDescendant(this.#bundleRoot, bundlePath)) {
      throw new TypeError("The runc job bundle must be below the configured bundle root.");
    }
    const timeoutMs = boundedDeadline(options.deadlineEpochMs);
    const child = this.#spawn(
      "/usr/bin/runc",
      ["--rootless=true", "--root", this.#stateRoot, "create", "--bundle", bundlePath, containerId],
      {
        cwd: "/",
        env: RUNC_CONTROL_ENV_V1,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    let forcedError: Error | undefined;
    let settled = false;
    let rejectCreated!: (error: Error) => void;
    let resolveCreated!: () => void;
    const created = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveCreated = resolvePromise;
      rejectCreated = rejectPromise;
    });
    created.catch(() => undefined);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) rejectCreated(error);
      else resolveCreated();
    };
    const onError = () => settle(new Error("The fixed runc create client could not start."));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (forcedError) settle(forcedError);
      else if (code === 0 && signal === null) settle();
      else settle(new Error("The fixed runc create operation failed."));
    };
    const timer = setTimeout(() => {
      forcedError ??= new Error("The fixed runc create operation exceeded its deadline.");
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.once("error", onError);
    // `close` waits for the OCI init process to close inherited pipes. The
    // create gate is the CLI process exit, while those pipes remain attached.
    child.once("exit", onExit);
    return Object.freeze({
      created,
      stderr: child.stderr,
      stdin: child.stdin,
      stdout: child.stdout,
      terminateCreateClient: () => {
        if (settled) return;
        forcedError ??= new Error("The fixed runc create operation was terminated.");
        child.kill("SIGKILL");
      },
    });
  }

  async state(containerId: string, deadlineEpochMs: number, signal?: AbortSignal) {
    const result = await this.#control(["state", parseContainerId(containerId)], deadlineEpochMs, true, signal);
    let value: unknown;
    try {
      value = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new Error("The fixed runc state response was not bounded JSON.");
    }
    const state = runcStateV1Schema.parse(value);
    if (state.id !== containerId) throw new Error("The fixed runc state response changed container identity.");
    const bundle = resolve(state.bundle);
    if (state.bundle !== bundle || !isStrictDescendant(this.#bundleRoot, bundle)) {
      throw new Error("The fixed runc state response returned an untrusted bundle path.");
    }
    return Object.freeze({ ...state, bundle });
  }

  async start(containerId: string, deadlineEpochMs: number, signal?: AbortSignal) {
    await this.#control(["start", parseContainerId(containerId)], deadlineEpochMs, false, signal);
  }

  async kill(containerId: string, deadlineEpochMs: number) {
    await this.#control(["kill", parseContainerId(containerId), "KILL"], deadlineEpochMs, false);
  }

  async delete(containerId: string, deadlineEpochMs: number) {
    await this.#control(["delete", "--force", parseContainerId(containerId)], deadlineEpochMs, false);
  }

  #control(arguments_: readonly string[], deadlineEpochMs: number, allowStdout: boolean, signal?: AbortSignal) {
    const timeoutMs = boundedDeadline(deadlineEpochMs);
    signal?.throwIfAborted();
    return new Promise<Readonly<{ stderr: Buffer; stdout: Buffer }>>((resolveRun, rejectRun) => {
      const child = this.#spawn("/usr/bin/runc", ["--rootless=true", "--root", this.#stateRoot, ...arguments_], {
        cwd: "/",
        env: RUNC_CONTROL_ENV_V1,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputFailure: Error | undefined;
      let terminationError: Error | undefined;
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) rejectRun(error);
        else resolveRun(Object.freeze({ stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) }));
      };
      const onAbort = () => {
        terminationError ??= new Error("The fixed runc control operation was aborted.");
        child.kill("SIGKILL");
      };
      const capture = (target: Buffer[], maximum: number, current: number, chunk: unknown) => {
        if (outputFailure) return current;
        try {
          return appendBounded(target, chunk, current, maximum);
        } catch (error) {
          outputFailure = error instanceof Error ? error : new Error("runc control output was rejected.");
          child.kill("SIGKILL");
          return current;
        }
      };
      child.stdout?.on("data", (chunk) => {
        stdoutBytes = capture(stdout, allowStdout ? MAX_RUNC_CONTROL_STDOUT_BYTES : 0, stdoutBytes, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderrBytes = capture(stderr, MAX_RUNC_CONTROL_STDERR_BYTES, stderrBytes, chunk);
      });
      child.once("error", () => settle(new Error("The fixed runc control client could not start.")));
      child.once("close", (code, signal) => {
        if (outputFailure) settle(outputFailure);
        else if (terminationError) settle(terminationError);
        else if (code !== 0 || signal !== null) settle(new Error("The fixed runc control operation failed."));
        else settle();
      });
      const timer = setTimeout(() => {
        terminationError ??= new Error("The fixed runc control operation exceeded its deadline.");
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

export function isProductionFastManimRuncRuntimeV1(value: unknown): value is FastManimRuncCliRuntimeV1 {
  return (
    value instanceof FastManimRuncCliRuntimeV1 &&
    Object.getPrototypeOf(value) === FastManimRuncCliRuntimeV1.prototype &&
    productionRuncRuntimes.has(value)
  );
}
