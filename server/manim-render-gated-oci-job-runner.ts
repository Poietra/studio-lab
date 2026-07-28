import { createHash } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { fastManimSandboxBackendControlErrorCode } from "./fast-manim-sandbox-backend";
import {
  assertFastManimGatedOciSeccompV1,
  cleanupFastManimGatedOciContainerV1,
  FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
  FastManimGatedOciDockerClientV1,
  type FastManimGatedOciRunningIdentityV1,
  type FastManimGatedOciCgroupKillPolicyV1,
  inspectFastManimGatedOciRunningCgroupV1,
  inspectFastManimGatedOciRunningResourcesV1,
  parseFastManimGatedOciSingleInspectionV1,
  readFastManimGatedOciProcessStartTimeV1,
  reapFastManimGatedOciAttachedDockerClientV1,
} from "./fast-manim-gated-oci-job-runner";
import {
  digestManimRenderStagingRootV1,
  digestManimRenderSandboxExecutionV1,
  MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  type ManimRenderSandboxDescriptorV1,
  type ManimRenderSandboxTerminalV1,
  manimRenderStagingIdV1,
  MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1,
  type SealedManimRenderSandboxRequestV1,
  verifySealedManimRenderSandboxRequestV1,
} from "./manim-render-sandbox-contract";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const CONTAINER_NAME = /^poietra-render-[a-f0-9]{32}$/u;
const READY = Buffer.from("POIETRA_RENDER_GATE_READY_V1\n", "ascii");
const REQUEST_WIRE_BYTES = 80;
const BROKER_READABLE_PROCESS_NAME = "poietra-ready";
const FIXED_EXPORT_COMMAND = "/bin/cat";
const FIXED_TERMINAL_PATH = "/run/poietra/output/terminal.json";
const FIXED_ARTIFACT_PATHS = Object.freeze({
  "image/png": "/run/poietra/output/artifact.png",
  "video/mp4": "/run/poietra/output/artifact.mp4",
} as const);
const MAX_CONTROL_BYTES = 64 * 1024;
const CONTROL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const MAX_ACTIVE_JOBS = 8;
const MAX_STAGED_ARTIFACTS = 64;
const MAX_STAGED_MANIFEST_BYTES = 8 * 1024;
const STAGING_RESERVATION_BYTES = MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1 + MAX_STAGED_MANIFEST_BYTES;
const MAX_STAGED_BYTES = 16 * STAGING_RESERVATION_BYTES;
const TMPFS_BYTES = 256 * 1024 * 1024;
const MEMORY_BYTES = 512 * 1024 * 1024;
const PIDS_LIMIT = 64;
const CPU_NANOSECONDS = 1_000_000_000;
const SHM_BYTES = 64 * 1024;
const FIXED_ENTRYPOINT = Object.freeze(["/opt/venv/bin/python", "/opt/poietra/render-entrypoint.py"] as const);
const FIXED_ENVIRONMENT = Object.freeze({
  HOME: "/run/poietra/home",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NB_UID: "1000",
  PATH: "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONHASHSEED: "0",
  PYTHONNOUSERSITE: "1",
  PYTHONPATH: "/opt/fast-manim",
  PYTHON_SHA256: "a97d5549e9ad81fe17159ed02c68774ad5d266c72f8d9a0b5a9c371fe85d902b",
  PYTHON_VERSION: "3.14.3",
  TMPDIR: "/run/poietra/tmp",
  TZ: "UTC",
  USER: "manimuser",
  VIRTUAL_ENV: "/opt/venv",
  XDG_CACHE_HOME: "/run/poietra/cache",
  XDG_CONFIG_HOME: "/run/poietra/config",
  XDG_DATA_HOME: "/run/poietra/data",
});
const FIXED_LABELS = Object.freeze({
  "io.poietra.fast-manim.archive-sha256": "46f66b6698650988c18327732d1d3c30cccd53b38de91e1059c61187d92c2b61",
  "io.poietra.fast-manim.commit": "ac143dc46ebe314095ae7864a32efa289a0afe96",
  "io.poietra.fast-manim.tree": "b86e2ec81f257cae20669e3c5c33080facfbd610",
  "io.poietra.render-job": "v1",
  "io.poietra.sandbox-slice": "manim-render-gated-v1",
});
const REQUIRED_MASKED_SYSTEM_PATHS = Object.freeze([
  "/proc/acpi",
  "/proc/asound",
  "/proc/interrupts",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/sched_debug",
  "/proc/scsi",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/sys/devices/virtual/powercap",
  "/sys/firmware",
] as const);
const REQUIRED_READ_ONLY_SYSTEM_PATHS = Object.freeze([
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger",
] as const);
const TMPFS_OPTIONS = Object.freeze([
  "rw",
  "noexec",
  "nosuid",
  "nodev",
  `size=${TMPFS_BYTES}`,
  "mode=0700",
  "uid=65532",
  "gid=65532",
] as const);

export const MANIM_RENDER_GATED_OCI_PROFILE_V1 = Object.freeze({
  autoRemove: false,
  artifactBytes: MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1,
  capabilitiesAdded: Object.freeze([]),
  capabilitiesDropped: Object.freeze(["ALL"]),
  cgroupNamespace: "private",
  cpuNanoSeconds: CPU_NANOSECONDS,
  entrypoint: FIXED_ENTRYPOINT,
  environment: FIXED_ENVIRONMENT,
  exportProtocol: Object.freeze({
    artifactPaths: FIXED_ARTIFACT_PATHS,
    command: FIXED_EXPORT_COMMAND,
    processName: BROKER_READABLE_PROCESS_NAME,
    terminalPath: FIXED_TERMINAL_PATH,
    user: "65532:65532",
  }),
  ipc: "none",
  logDriver: Object.freeze({ config: Object.freeze({}), type: "none" }),
  memoryBytes: MEMORY_BYTES,
  memorySwapBytes: MEMORY_BYTES,
  mediaValidation: Object.freeze({
    thumbnail: Object.freeze({ decode: "pillow", format: "PNG", height: 480, images: 1, width: 854 }),
    video: Object.freeze({
      codec: "h264",
      decode: "pyav",
      format: "mp4",
      frameRate: 15,
      height: 480,
      pixelFormat: "yuv420p",
      streams: 1,
      width: 854,
    }),
  }),
  network: "none",
  noNewPrivileges: true,
  openStdin: true,
  pidsLimit: PIDS_LIMIT,
  privileged: false,
  readOnlyRootfs: true,
  requestWire: Object.freeze({
    headerBytes: REQUEST_WIRE_BYTES,
    identity: "execution-sha256-without-fence",
    magic: "POIETR1\\0",
    version: 1,
  }),
  requiredMaskedSystemPaths: REQUIRED_MASKED_SYSTEM_PATHS,
  requiredReadOnlySystemPaths: REQUIRED_READ_ONLY_SYSTEM_PATHS,
  restartPolicy: "no",
  schema: "poietra.manim-render-gated-oci-profile",
  sceneFrame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  seccompDigest: FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
  shmBytes: SHM_BYTES,
  stdinOnce: true,
  stopTimeoutSeconds: 1,
  untrustedOutputTarget: "/run/poietra/output",
  tmpfs: Object.freeze({ options: TMPFS_OPTIONS, path: "/run/poietra" }),
  ulimits: Object.freeze([
    Object.freeze({ hard: 0, name: "core", soft: 0 }),
    Object.freeze({ hard: 256, name: "nofile", soft: 256 }),
  ]),
  user: "65532:65532",
  version: 1,
  workingDirectory: "/run/poietra",
});
export const MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1 = createHash("sha256")
  .update(canonicalJsonV1(MANIM_RENDER_GATED_OCI_PROFILE_V1), "utf8")
  .digest("hex");

export function digestManimRenderGatedOciRuntimeV1(image: string) {
  if (!IMAGE_ID.test(image)) throw new TypeError("The render OCI image must be an immutable SHA-256 image ID.");
  return createHash("sha256")
    .update(canonicalJsonV1({ image, profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1 }), "utf8")
    .digest("hex");
}

export type ManimRenderGatedOciBaseResultV1 =
  | Readonly<{
      artifactDigest: string;
      artifactSize: number;
      kind: "ready";
      mediaType: "image/png" | "video/mp4";
      stagingId: string;
    }>
  | Readonly<{
      code: Extract<ManimRenderSandboxTerminalV1, { kind: "failed" }>["code"];
      diagnostic?: "artifact-copy" | "internal" | "manim-exit" | "media-invalid" | "media-missing";
      kind: "failed";
    }>;

type ActiveJob = Readonly<{
  abort: AbortController;
  executionDigest: string;
  result: Promise<ManimRenderGatedOciBaseResultV1>;
}>;

const stagedManifestSchema = z
  .object({
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    artifactSize: z.number().int().positive().max(MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1),
    deadlineEpochMs: z.number().int().safe().positive(),
    executionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    jobId: z.string(),
    mediaType: z.enum(["image/png", "video/mp4"]),
    profileDigest: z.literal(MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1),
    runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    stagingId: z.string().regex(/^[a-f0-9]{32}$/u),
    version: z.literal(1),
  })
  .strict();

const containerTerminalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      executionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      kind: z.literal("ready"),
      mediaType: z.enum(["image/png", "video/mp4"]),
    })
    .strict(),
  z
    .object({
      code: z.literal("render-failed"),
      executionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      kind: z.literal("failed"),
      reason: z.enum(["artifact-copy", "internal", "manim-exit", "media-invalid", "media-missing"]),
    })
    .strict(),
]);

type CopiedArtifact = Readonly<{
  incoming: string;
  manifest: z.infer<typeof stagedManifestSchema>;
  result: Extract<ManimRenderGatedOciBaseResultV1, { kind: "ready" }>;
  temporaryArtifact: string;
}>;

type StagingUsageV1 = Readonly<{
  artifactBytes: number;
  artifactCount: number;
  earliestDeadlineEpochMs?: number;
}>;

type StagingRootIdentityV1 = Readonly<{ dev: bigint; ino: bigint }>;

function exactStringMap(entries: unknown) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry.includes("="))) {
    return null;
  }
  const result: Record<string, string> = {};
  for (const entry of entries as string[]) {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    if (Object.hasOwn(result, key)) return null;
    result[key] = entry.slice(separator + 1);
  }
  return result;
}

function exactMap(value: unknown, expected: Readonly<Record<string, string>>) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index] && candidate[key] === expected[key])
  );
}

function sameArray(value: unknown, expected: readonly unknown[]) {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

function emptySequence(value: unknown) {
  return value === null || (Array.isArray(value) && value.length === 0);
}

function emptyRecord(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

function containsRequiredStrings(value: unknown, expected: readonly string[]) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length &&
    expected.every((entry) => value.includes(entry))
  );
}

function sameSecurityOptions(value: unknown) {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== "no-new-privileges=true") return false;
  const seccomp = value[1];
  if (typeof seccomp !== "string" || !seccomp.startsWith("seccomp=")) return false;
  try {
    return (
      createHash("sha256")
        .update(canonicalJsonV1(JSON.parse(seccomp.slice("seccomp=".length))), "utf8")
        .digest("hex") === FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1
    );
  } catch {
    return false;
  }
}

function sameUlimits(value: unknown) {
  return (
    Array.isArray(value) &&
    value.length === MANIM_RENDER_GATED_OCI_PROFILE_V1.ulimits.length &&
    MANIM_RENDER_GATED_OCI_PROFILE_V1.ulimits.every(
      (expected, index) =>
        (value[index] as { Hard?: unknown } | undefined)?.Hard === expected.hard &&
        (value[index] as { Name?: unknown } | undefined)?.Name === expected.name &&
        (value[index] as { Soft?: unknown } | undefined)?.Soft === expected.soft,
    )
  );
}

function noNetworkEndpoint(value: unknown, running: boolean) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const network = (value as Record<string, unknown>).none;
  if (typeof network !== "object" || network === null || Array.isArray(network)) return false;
  const endpoint = network as Record<string, unknown>;
  const identityValid = running
    ? typeof endpoint.NetworkID === "string" &&
      /^[a-f0-9]{64}$/u.test(endpoint.NetworkID) &&
      typeof endpoint.EndpointID === "string" &&
      /^[a-f0-9]{64}$/u.test(endpoint.EndpointID)
    : endpoint.NetworkID === "" && endpoint.EndpointID === "";
  return (
    Object.keys(value).length === 1 &&
    identityValid &&
    endpoint.Gateway === "" &&
    endpoint.IPAddress === "" &&
    endpoint.IPv6Gateway === "" &&
    endpoint.GlobalIPv6Address === "" &&
    endpoint.MacAddress === ""
  );
}

function sameNetworkSandboxIdentity(
  value: Readonly<{ SandboxID?: unknown; SandboxKey?: unknown }> | undefined,
  running: boolean,
) {
  if (!running) return value?.SandboxID === "" && value.SandboxKey === "";
  if (
    typeof value?.SandboxID !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.SandboxID) ||
    typeof value.SandboxKey !== "string"
  ) {
    return false;
  }
  return (
    /^\/(?:var\/run|run(?:\/user\/[0-9]+)?)\/docker\/netns\/[a-f0-9]{12}$/u.test(value.SandboxKey) &&
    value.SandboxKey.endsWith(`/netns/${value.SandboxID.slice(0, 12)}`)
  );
}

function deadlineLabel(labels: Record<string, unknown> | undefined) {
  const value = labels?.["io.poietra.render-deadline-epoch-ms"];
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("The stable render deadline identity is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("The stable render deadline identity is invalid.");
  return parsed;
}

function remaining(deadlineEpochMs: number) {
  return Math.min(CONTROL_TIMEOUT_MS, Math.max(1, deadlineEpochMs - Date.now()));
}

function throwIfDeadlineElapsed(deadlineEpochMs: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (Date.now() >= deadlineEpochMs) throw new Error("The render OCI deadline elapsed.");
}

function abortError() {
  return new DOMException("The render sandbox operation was aborted.", "AbortError");
}

function delay(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    function finish() {
      cleanup();
      resolveDelay();
    }
    function abort() {
      cleanup();
      rejectDelay(abortError());
    }
  });
}

function observeJob<T>(result: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<T>((resolveObserve, rejectObserve) => {
    const abort = () => {
      cleanup();
      rejectObserve(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    result.then(
      (value) => {
        cleanup();
        resolveObserve(value);
      },
      (error: unknown) => {
        cleanup();
        rejectObserve(error);
      },
    );
  });
}

function requestWire(request: SealedManimRenderSandboxRequestV1, executionDigest: string) {
  if (!/^[a-f0-9]{64}$/u.test(executionDigest)) {
    throw new TypeError("The render execution digest is invalid.");
  }
  const bytes = request.copyBytes();
  const header = Buffer.alloc(REQUEST_WIRE_BYTES);
  Buffer.from("POIETR1\0", "ascii").copy(header, 0);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(bytes.byteLength, 12);
  Buffer.from(createHash("sha256").update(bytes).digest()).copy(header, 16);
  Buffer.from(executionDigest, "hex").copy(header, 48);
  return Buffer.concat([header, Buffer.from(bytes)]);
}

export async function deliverSealedManimRenderGateRequestV1(
  attached: ChildProcessWithoutNullStreams,
  request: SealedManimRenderSandboxRequestV1,
  executionDigest: string,
  deadlineEpochMs: number,
  signal: AbortSignal,
) {
  let stderr = Buffer.alloc(0);
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const gate = new Promise<void>((resolveGate, rejectGate) => {
    resolveReady = resolveGate;
    rejectReady = rejectGate;
  });
  const exit = new Promise<Readonly<{ code: number; signal: NodeJS.Signals | null }>>((resolveExit) => {
    attached.once("error", rejectReady);
    attached.once("close", (code, signalName) => resolveExit({ code: code ?? 1, signal: signalName }));
  });
  attached.stdout.on("data", (chunk: Buffer) => {
    if (chunk.byteLength > 0) attached.kill("SIGKILL");
  });
  attached.stderr.on("data", (chunk: Buffer) => {
    if (stderr.byteLength + chunk.byteLength > MAX_CONTROL_BYTES) return attached.kill("SIGKILL");
    stderr = Buffer.concat([stderr, chunk]);
    if (!ready && stderr.subarray(0, READY.byteLength).equals(READY)) {
      ready = true;
      resolveReady();
    }
  });
  const abort = () => attached.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([
      gate,
      exit.then(() => Promise.reject(new Error("Render OCI gate exited early."))),
      delay(remaining(deadlineEpochMs), signal).then(() => Promise.reject(new Error("Render OCI gate timed out."))),
    ]);
    await Promise.race([
      new Promise<void>((resolveWrite, rejectWrite) => {
        const onError = () => {
          cleanup();
          rejectWrite(new Error("The render OCI gate rejected its authenticated request stream."));
        };
        const cleanup = () => attached.stdin.removeListener("error", onError);
        attached.stdin.once("error", onError);
        attached.stdin.end(requestWire(request, executionDigest), () => {
          cleanup();
          resolveWrite();
        });
      }),
      exit.then(() => Promise.reject(new Error("Render OCI gate exited while receiving its request."))),
      delay(remaining(deadlineEpochMs), signal).then(() =>
        Promise.reject(new Error("Render OCI gate request delivery timed out.")),
      ),
    ]);
    return { attached, attachedExit: exit };
  } catch (error) {
    await reapFastManimGatedOciAttachedDockerClientV1(attached, exit);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function validateMedia(
  path: string,
  mediaType: "image/png" | "video/mp4",
  context?: Readonly<{ deadlineEpochMs: number; signal: AbortSignal }>,
) {
  if (context) throwIfDeadlineElapsed(context.deadlineEpochMs, context.signal);
  const pathMetadata = await lstat(path);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new TypeError("The staged render artifact is not a regular file.");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      metadata.size <= 0 ||
      metadata.size > MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1
    ) {
      throw new TypeError("The staged render artifact is not a bounded stable regular file.");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    let header = Buffer.alloc(0);
    while (offset < metadata.size) {
      if (context) throwIfDeadlineElapsed(context.deadlineEpochMs, context.signal);
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.byteLength, metadata.size - offset), offset);
      if (bytesRead <= 0) throw new TypeError("The staged render artifact changed while it was verified.");
      const bytes = chunk.subarray(0, bytesRead);
      if (header.byteLength < 12) header = Buffer.concat([header, bytes]).subarray(0, 12);
      hash.update(bytes);
      offset += bytesRead;
    }
    const signatureValid =
      mediaType === "image/png"
        ? header.byteLength >= 8 && header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        : header.byteLength >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp";
    if (!signatureValid) throw new TypeError("The staged render artifact has an invalid media signature.");
    if (context) throwIfDeadlineElapsed(context.deadlineEpochMs, context.signal);
    return { digest: hash.digest("hex"), size: metadata.size };
  } finally {
    await file.close();
  }
}

export async function writeBoundedManimRenderChildStdoutV1(
  child: ChildProcessWithoutNullStreams,
  destination: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
  deadlineEpochMs: number,
  signal: AbortSignal,
) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1
  ) {
    throw new TypeError("The render export byte budget is invalid.");
  }
  throwIfDeadlineElapsed(deadlineEpochMs, signal);
  child.stdin.destroy();
  let stderrBytes = 0;
  let outputBytes = 0;
  let overflow = false;
  const exit = new Promise<Readonly<{ code: number; signal: NodeJS.Signals | null }>>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signalName) => resolveExit({ code: code ?? 1, signal: signalName }));
  });
  const abort = () => child.kill("SIGKILL");
  const deadlineTimer = setTimeout(abort, Math.max(1, deadlineEpochMs - Date.now()));
  deadlineTimer.unref();
  signal.addEventListener("abort", abort, { once: true });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAX_CONTROL_BYTES) {
      overflow = true;
      child.kill("SIGKILL");
    }
  });
  try {
    for await (const value of child.stdout) {
      throwIfDeadlineElapsed(deadlineEpochMs, signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumBytes) {
        overflow = true;
        child.kill("SIGKILL");
        throw new Error("The streamed render artifact exceeded its byte budget.");
      }
      let written = 0;
      while (written < chunk.byteLength) {
        throwIfDeadlineElapsed(deadlineEpochMs, signal);
        const result = await destination.write(chunk, written, chunk.byteLength - written);
        if (result.bytesWritten <= 0 || result.bytesWritten > chunk.byteLength - written) {
          throw new Error("The broker staging file rejected the render artifact stream.");
        }
        written += result.bytesWritten;
      }
    }
    const result = await exit;
    throwIfDeadlineElapsed(deadlineEpochMs, signal);
    if (overflow || result.code !== 0 || result.signal !== null || stderrBytes !== 0 || outputBytes === 0) {
      throw new Error("Docker could not stream one bounded render artifact.");
    }
    await destination.sync();
    throwIfDeadlineElapsed(deadlineEpochMs, signal);
    return outputBytes;
  } finally {
    clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", abort);
    await reapFastManimGatedOciAttachedDockerClientV1(child, exit);
  }
}

async function streamDockerFileToHandle(
  docker: FastManimGatedOciDockerClientV1,
  containerId: string,
  containerPath: string,
  destination: Awaited<ReturnType<typeof open>>,
  deadlineEpochMs: number,
  signal: AbortSignal,
) {
  const child = docker.attach([
    "container",
    "exec",
    "--user=65532:65532",
    containerId,
    FIXED_EXPORT_COMMAND,
    containerPath,
  ]);
  return writeBoundedManimRenderChildStdoutV1(
    child,
    destination,
    MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1,
    deadlineEpochMs,
    signal,
  );
}

async function readStagedManifest(path: string) {
  const pathMetadata = await lstat(path);
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.size <= 0 ||
    pathMetadata.size > MAX_STAGED_MANIFEST_BYTES
  ) {
    throw new TypeError("The staged render manifest is not a bounded regular file.");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      metadata.size !== pathMetadata.size
    ) {
      throw new TypeError("The staged render manifest changed while it was verified.");
    }
    const text = await file.readFile("utf8");
    const manifest = stagedManifestSchema.parse(JSON.parse(text));
    if (canonicalJsonV1(manifest) !== text) throw new TypeError("The staged render manifest is not canonical.");
    return manifest;
  } finally {
    await file.close();
  }
}

function artifactExtension(mediaType: "image/png" | "video/mp4") {
  return mediaType === "image/png" ? "png" : "mp4";
}

/** Stable-job OCI owner. Raw media is copied only Docker→private broker staging, never through UDS. */
export class ManimRenderGatedOciJobRunnerV1 {
  readonly #active = new Map<string, ActiveJob>();
  readonly #docker: FastManimGatedOciDockerClientV1;
  readonly #cgroupKillPolicy: FastManimGatedOciCgroupKillPolicyV1;
  readonly #image: string;
  readonly #maxStagedArtifacts: number;
  readonly #maxStagedBytes: number;
  readonly #runtimeDigest: string;
  readonly #seccompPath: string;
  readonly #stagingGroupId: number | undefined;
  readonly #stagingRoot: string;
  #closed = false;
  #cleanupFailure: unknown = undefined;
  #stagingIdentity: StagingRootIdentityV1 | undefined;
  #stagingMaintenance = Promise.resolve();
  #stagingSweepTimer: NodeJS.Timeout | undefined;

  constructor(
    options: Readonly<{
      cgroupKillPolicy?: FastManimGatedOciCgroupKillPolicyV1;
      dockerClient: FastManimGatedOciDockerClientV1;
      image: string;
      maxStagedArtifacts?: number;
      maxStagedBytes?: number;
      seccompPath: string;
      stagingGroupId?: number;
      stagingRoot: string;
    }>,
  ) {
    if (
      !(options.dockerClient instanceof FastManimGatedOciDockerClientV1) ||
      !IMAGE_ID.test(options.image) ||
      (options.cgroupKillPolicy !== undefined &&
        options.cgroupKillPolicy !== "best-effort" &&
        options.cgroupKillPolicy !== "required")
    ) {
      throw new TypeError("The render OCI runner configuration is invalid.");
    }
    const maxStagedArtifacts = options.maxStagedArtifacts ?? MAX_STAGED_ARTIFACTS;
    const maxStagedBytes = options.maxStagedBytes ?? MAX_STAGED_BYTES;
    if (
      !Number.isSafeInteger(maxStagedArtifacts) ||
      maxStagedArtifacts < 1 ||
      maxStagedArtifacts > MAX_STAGED_ARTIFACTS ||
      !Number.isSafeInteger(maxStagedBytes) ||
      maxStagedBytes < STAGING_RESERVATION_BYTES ||
      maxStagedBytes > MAX_STAGED_BYTES
    ) {
      throw new TypeError("The render OCI staging limits are invalid.");
    }
    this.#cgroupKillPolicy = options.cgroupKillPolicy ?? "required";
    try {
      digestManimRenderStagingRootV1(options.stagingRoot);
    } catch {
      throw new TypeError("The broker staging root must be canonical and absolute.");
    }
    this.#docker = options.dockerClient;
    this.#image = options.image;
    this.#maxStagedArtifacts = maxStagedArtifacts;
    this.#maxStagedBytes = maxStagedBytes;
    this.#runtimeDigest = digestManimRenderGatedOciRuntimeV1(options.image);
    this.#seccompPath = options.seccompPath;
    if (
      options.stagingGroupId !== undefined &&
      (!Number.isSafeInteger(options.stagingGroupId) ||
        options.stagingGroupId < 0 ||
        options.stagingGroupId > 0xffff_ffff)
    ) {
      throw new TypeError("The render OCI staging group is invalid.");
    }
    this.#stagingGroupId = options.stagingGroupId;
    this.#stagingRoot = options.stagingRoot;
  }

  get profileDigest() {
    return MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1;
  }

  get runtimeDigest() {
    return this.#runtimeDigest;
  }

  get stagingRootDigest() {
    return digestManimRenderStagingRootV1(this.#stagingRoot);
  }

  async #assertStagingRootIdentity() {
    const userId = process.geteuid?.();
    if (userId === undefined) throw new Error("The render broker user identity is unavailable.");
    const [metadata, canonical] = await Promise.all([
      lstat(this.#stagingRoot, { bigint: true }),
      realpath(this.#stagingRoot),
    ]);
    if (
      canonical !== this.#stagingRoot ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== BigInt(userId) ||
      (this.#stagingGroupId === undefined
        ? (metadata.mode & 0o777n) !== 0o700n
        : metadata.gid !== BigInt(this.#stagingGroupId) || (metadata.mode & 0o777n) !== 0o750n)
    ) {
      throw new Error("The private render staging root identity is invalid.");
    }
    let ancestor = dirname(this.#stagingRoot);
    while (true) {
      const status = await lstat(ancestor, { bigint: true });
      const writableByUntrustedPrincipal = (status.mode & 0o022n) !== 0n;
      const rootOwnedStickyDirectory = status.uid === 0n && (status.mode & 0o1000n) !== 0n;
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        (status.uid !== 0n && status.uid !== BigInt(userId)) ||
        (writableByUntrustedPrincipal && !rootOwnedStickyDirectory)
      ) {
        throw new Error("A render staging ancestor is not a trusted non-replaceable directory.");
      }
      if (ancestor === "/") break;
      ancestor = dirname(ancestor);
    }
    const identity = { dev: metadata.dev, ino: metadata.ino };
    if (
      this.#stagingIdentity &&
      (this.#stagingIdentity.dev !== identity.dev || this.#stagingIdentity.ino !== identity.ino)
    ) {
      throw new Error("The private render staging root was replaced after verification.");
    }
    this.#stagingIdentity ??= identity;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#closed || this.#cleanupFailure !== undefined) return false;
    try {
      await this.#assertStagingRootIdentity();
    } catch {
      return false;
    }
    await assertFastManimGatedOciSeccompV1(this.#seccompPath);
    const inspected = await this.#docker.run(["image", "inspect", this.#image], CONTROL_TIMEOUT_MS, signal);
    if (inspected.code !== 0) return false;
    const image = parseFastManimGatedOciSingleInspectionV1(inspected.stdout);
    const environment = exactStringMap(image.Config?.Env);
    return (
      image.Id === this.#image &&
      sameArray(image.Config?.Entrypoint, FIXED_ENTRYPOINT) &&
      (image.Config?.Cmd === undefined || image.Config.Cmd === null || sameArray(image.Config.Cmd, [])) &&
      image.Config?.User === "65532:65532" &&
      image.Config?.WorkingDir === "/run/poietra" &&
      environment !== null &&
      exactMap(environment, FIXED_ENVIRONMENT) &&
      Object.entries(FIXED_LABELS).every(
        ([key, value]) => (image.Config?.Labels as Record<string, unknown> | undefined)?.[key] === value,
      )
    );
  }

  #withStagingMaintenance<T>(operation: () => Promise<T>) {
    const result = this.#stagingMaintenance.then(operation, operation);
    this.#stagingMaintenance = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #scheduleStagingSweep(deadlineEpochMs: number | undefined) {
    if (this.#stagingSweepTimer) clearTimeout(this.#stagingSweepTimer);
    this.#stagingSweepTimer = undefined;
    if (this.#closed || deadlineEpochMs === undefined) return;
    this.#stagingSweepTimer = setTimeout(
      () => {
        this.#stagingSweepTimer = undefined;
        void this.#withStagingMaintenance(async () => {
          const usage = await this.#sweepExpiredStaging(Date.now());
          this.#scheduleStagingSweep(usage.earliestDeadlineEpochMs);
        }).catch((error: unknown) => this.#latchCleanupFailure(error));
      },
      Math.min(0x7fffffff, Math.max(1, deadlineEpochMs - Date.now())),
    );
    this.#stagingSweepTimer.unref();
  }

  async #sweepExpiredStaging(now: number): Promise<StagingUsageV1> {
    await this.#assertStagingRootIdentity();
    const entries = await readdir(this.#stagingRoot, { withFileTypes: true });
    const activeIds = new Set(this.#active.keys());
    const handled = new Set<string>();
    let artifactBytes = 0;
    let artifactCount = 0;
    let earliestDeadlineEpochMs: number | undefined;

    for (const entry of entries) {
      const match = entry.name.match(/^([a-f0-9]{32})[.]json$/u);
      if (!match) continue;
      handled.add(entry.name);
      const stagingId = match[1]!;
      if (activeIds.has(stagingId)) continue;
      const manifestPath = join(this.#stagingRoot, entry.name);
      const manifest = await readStagedManifest(manifestPath);
      if (manifest.stagingId !== stagingId) {
        throw new Error("The staged render manifest filename does not match its identity.");
      }
      const artifactName = `${stagingId}.${artifactExtension(manifest.mediaType)}`;
      const artifactPath = join(this.#stagingRoot, artifactName);
      handled.add(artifactName);
      if (manifest.deadlineEpochMs <= now) {
        await Promise.all([rm(artifactPath, { force: true }), rm(manifestPath, { force: true })]);
        continue;
      }
      const [artifact, manifestMetadata] = await Promise.all([lstat(artifactPath), lstat(manifestPath)]);
      if (
        !artifact.isFile() ||
        artifact.isSymbolicLink() ||
        artifact.size !== manifest.artifactSize ||
        !manifestMetadata.isFile() ||
        manifestMetadata.isSymbolicLink()
      ) {
        throw new Error("The staged render pair is not a bounded regular artifact and manifest.");
      }
      artifactCount += 1;
      artifactBytes += artifact.size + manifestMetadata.size;
      earliestDeadlineEpochMs = Math.min(earliestDeadlineEpochMs ?? Number.POSITIVE_INFINITY, manifest.deadlineEpochMs);
    }

    for (const entry of entries) {
      const match = entry.name.match(/^([a-f0-9]{32})[.](?:mp4|png)$/u);
      if (!match || handled.has(entry.name)) continue;
      handled.add(entry.name);
      if (!activeIds.has(match[1]!)) await rm(join(this.#stagingRoot, entry.name), { force: true });
    }

    for (const entry of entries) {
      if (handled.has(entry.name)) continue;
      const temporaryManifest = entry.name.match(/^[.]([a-f0-9]{32})[.]json[.]tmp$/u);
      if (temporaryManifest && activeIds.has(temporaryManifest[1]!)) continue;
      if (
        (entry.name.startsWith(".artifact-") && activeIds.size > 0) ||
        (entry.name.startsWith(".terminal-") && activeIds.size > 0)
      ) {
        continue;
      }
      if (entry.name.startsWith(".artifact-") || entry.name.startsWith(".terminal-") || temporaryManifest) {
        await rm(join(this.#stagingRoot, entry.name), { force: true, recursive: true });
        continue;
      }
      throw new Error("The private render staging root contains an unknown entry.");
    }

    await this.#assertStagingRootIdentity();
    if (!Number.isSafeInteger(artifactBytes)) throw new Error("The render staging byte usage is not bounded.");
    return { artifactBytes, artifactCount, earliestDeadlineEpochMs };
  }

  /** Startup-only reconciliation. It never runs concurrently with accepted jobs. */
  async reconcileOrphans() {
    await this.#assertStagingRootIdentity();
    const entries = await readdir(this.#stagingRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name.startsWith(".artifact-") ||
        entry.name.startsWith(".terminal-") ||
        /^\.[a-f0-9]{32}[.]json[.]tmp$/u.test(entry.name)
      ) {
        await rm(join(this.#stagingRoot, entry.name), { force: true, recursive: true });
      }
    }
    for (const entry of entries) {
      const match = entry.name.match(/^([a-f0-9]{32})[.](?:mp4|png)$/u);
      if (match && !entries.some((candidate) => candidate.name === `${match[1]}.json`)) {
        await rm(join(this.#stagingRoot, entry.name), { force: true });
      }
    }
    for (const entry of entries) {
      const match = entry.name.match(/^([a-f0-9]{32})[.]json$/u);
      if (!match) continue;
      const manifestPath = join(this.#stagingRoot, entry.name);
      const manifest = await readStagedManifest(manifestPath);
      if (manifest.stagingId !== match[1]) {
        throw new Error("The staged render manifest filename does not match its identity.");
      }
      const artifactPath = join(this.#stagingRoot, `${manifest.stagingId}.${artifactExtension(manifest.mediaType)}`);
      const artifact = await validateMedia(artifactPath, manifest.mediaType);
      if (artifact.digest !== manifest.artifactDigest || artifact.size !== manifest.artifactSize) {
        throw new Error("The staged render artifact does not match its canonical manifest.");
      }
      if (manifest.deadlineEpochMs <= Date.now()) {
        await Promise.all([rm(artifactPath, { force: true }), rm(manifestPath, { force: true })]);
      }
    }

    const listed = await this.#docker.run([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      "label=io.poietra.render-job=v1",
    ]);
    const containerIds = listed.stdout.toString("ascii").trim().split("\n").filter(Boolean);
    if (listed.code !== 0 || containerIds.length > 128 || containerIds.some((id) => !CONTAINER_ID.test(id))) {
      throw new Error("Docker returned ambiguous render orphan ownership.");
    }
    for (const containerId of containerIds) {
      const inspected = await this.#docker.run(["container", "inspect", containerId]);
      if (inspected.code !== 0) {
        this.#latchCleanupFailure(new Error("Docker could not inspect a render orphan."));
        throw this.#cleanupFailure;
      }
      const container = parseFastManimGatedOciSingleInspectionV1(inspected.stdout);
      const labels = container.Config?.Labels as Record<string, unknown> | undefined;
      const name = typeof container.Name === "string" ? container.Name.replace(/^\//u, "") : "";
      const executionDigest = labels?.["io.poietra.render-execution-sha256"];
      let deadlineEpochMs: number;
      const running = container.State?.Running === true;
      let identity: FastManimGatedOciRunningIdentityV1 | undefined;
      try {
        if (
          !CONTAINER_NAME.test(name) ||
          typeof executionDigest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(executionDigest) ||
          labels?.["io.poietra.render-job"] !== "v1"
        ) {
          throw new Error("A label-owned render orphan has an invalid identity.");
        }
        deadlineEpochMs = deadlineLabel(labels);
        if (running) {
          const pid = container.State?.Pid;
          if (!Number.isSafeInteger(pid) || (pid as number) <= 1) throw new Error("A render orphan PID is invalid.");
          const startTime = await readFastManimGatedOciProcessStartTimeV1(pid as number);
          identity = await inspectFastManimGatedOciRunningCgroupV1(containerId, pid as number, startTime);
        }
        await this.#inspectContainer(containerId, name, executionDigest, deadlineEpochMs, running);
        if (identity) {
          await inspectFastManimGatedOciRunningResourcesV1(identity);
        }
        await cleanupFastManimGatedOciContainerV1(containerId, identity, this.#docker, this.#cgroupKillPolicy);
      } catch (error) {
        try {
          await cleanupFastManimGatedOciContainerV1(containerId, identity, this.#docker, this.#cgroupKillPolicy);
        } catch (cleanupError) {
          this.#latchCleanupFailure(cleanupError);
          throw cleanupError;
        }
        this.#latchCleanupFailure(error);
        throw error;
      }
    }
    const usage = await this.#withStagingMaintenance(() => this.#sweepExpiredStaging(Date.now()));
    if (usage.artifactCount > this.#maxStagedArtifacts || usage.artifactBytes > this.#maxStagedBytes) {
      throw new Error("Existing render staging exceeds the configured hard capacity.");
    }
    this.#scheduleStagingSweep(usage.earliestDeadlineEpochMs);
  }

  async submitOrReattach(request: SealedManimRenderSandboxRequestV1, deadlineEpochMs: number, signal: AbortSignal) {
    if (this.#closed) return Promise.reject(abortError());
    if (this.#cleanupFailure !== undefined) {
      return Promise.resolve({ code: "cleanup-failed", kind: "failed" } as const);
    }
    if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= Date.now()) {
      return Promise.resolve({ code: "deadline-exceeded", kind: "failed" } as const);
    }
    if (!verifySealedManimRenderSandboxRequestV1(request)) {
      return Promise.resolve({ code: "result-rejected", kind: "failed" } as const);
    }
    const descriptor = request.parseDescriptor();
    if (
      descriptor.deadlineEpochMs !== deadlineEpochMs ||
      descriptor.profileDigest !== this.profileDigest ||
      descriptor.runtimeDigest !== this.runtimeDigest
    ) {
      return Promise.resolve({ code: "request-mismatch", kind: "failed" } as const);
    }
    const stagingId = manimRenderStagingIdV1(descriptor.jobId, descriptor.output.kind);
    const executionDigest = digestManimRenderSandboxExecutionV1(descriptor);
    try {
      const admission = await this.#withStagingMaintenance(async () => {
        if (this.#closed) throw abortError();
        if (this.#cleanupFailure !== undefined) {
          return { result: Promise.resolve({ code: "cleanup-failed", kind: "failed" } as const) };
        }
        if (deadlineEpochMs <= Date.now()) {
          return { result: Promise.resolve({ code: "deadline-exceeded", kind: "failed" } as const) };
        }
        const active = this.#active.get(stagingId);
        if (active) {
          return {
            result:
              active.executionDigest === executionDigest
                ? observeJob(active.result, signal)
                : Promise.resolve({ code: "request-mismatch", kind: "failed" } as const),
          };
        }
        const usage = await this.#sweepExpiredStaging(Date.now());
        this.#scheduleStagingSweep(usage.earliestDeadlineEpochMs);
        try {
          const staged = await this.#readStaged(descriptor, executionDigest, stagingId, deadlineEpochMs, signal);
          if (staged) return { result: Promise.resolve(staged) };
        } catch {
          signal.throwIfAborted();
          await this.#assertStagingRootIdentity();
          return { result: Promise.resolve({ code: "request-mismatch", kind: "failed" } as const) };
        }
        if (
          this.#active.size >= MAX_ACTIVE_JOBS ||
          usage.artifactCount + this.#active.size + 1 > this.#maxStagedArtifacts ||
          usage.artifactBytes + (this.#active.size + 1) * STAGING_RESERVATION_BYTES > this.#maxStagedBytes
        ) {
          return { result: Promise.resolve({ code: "capacity", kind: "failed" } as const) };
        }
        const controller = new AbortController();
        const deadlineTimer = setTimeout(
          () => controller.abort(new Error("The render sandbox deadline elapsed.")),
          Math.max(1, deadlineEpochMs - Date.now()),
        );
        deadlineTimer.unref();
        let job!: ActiveJob;
        const result = this.#run(request, descriptor, executionDigest, stagingId, deadlineEpochMs, controller.signal)
          .catch((error: unknown) => {
            if (this.#cleanupFailure !== undefined) return { code: "cleanup-failed", kind: "failed" } as const;
            throw error;
          })
          .finally(async () => {
            clearTimeout(deadlineTimer);
            try {
              await this.#withStagingMaintenance(async () => {
                if (this.#active.get(stagingId) === job) this.#active.delete(stagingId);
                const finalUsage = await this.#sweepExpiredStaging(Date.now());
                this.#scheduleStagingSweep(finalUsage.earliestDeadlineEpochMs);
              });
            } catch (error) {
              this.#latchCleanupFailure(error);
              throw error;
            }
          });
        job = { abort: controller, executionDigest, result };
        this.#active.set(stagingId, job);
        return { result: observeJob(result, signal) };
      });
      return await admission.result;
    } catch (error) {
      if (this.#closed || signal.aborted) throw error;
      this.#latchCleanupFailure(error);
      return { code: "cleanup-failed", kind: "failed" } as const;
    }
  }

  async cancel(jobId: string, deadlineEpochMs: number, signal: AbortSignal) {
    if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= Date.now()) {
      throw new TypeError("The render cancellation deadline must be in the future.");
    }
    signal.throwIfAborted();
    for (const kind of ["video", "thumbnail"] as const) {
      const stagingId = manimRenderStagingIdV1(jobId, kind);
      const active = this.#active.get(stagingId);
      active?.abort.abort(new DOMException("Render cancelled.", "AbortError"));
      if (active) await active.result;
      try {
        await this.#cleanupByStableId(stagingId);
      } catch (error) {
        this.#latchCleanupFailure(error);
        throw error;
      }
      await this.#withStagingMaintenance(async () => {
        await this.#deleteStaged(stagingId);
        const usage = await this.#sweepExpiredStaging(Date.now());
        this.#scheduleStagingSweep(usage.earliestDeadlineEpochMs);
      });
    }
  }

  async close() {
    this.#closed = true;
    if (this.#stagingSweepTimer) clearTimeout(this.#stagingSweepTimer);
    this.#stagingSweepTimer = undefined;
    for (const job of this.#active.values()) job.abort.abort(abortError());
    await Promise.allSettled([...this.#active.values()].map((job) => job.result));
    await this.#stagingMaintenance;
    if (this.#cleanupFailure !== undefined) {
      throw new AggregateError([this.#cleanupFailure], "The render OCI runner observed uncertain cleanup.");
    }
  }

  async #run(
    request: SealedManimRenderSandboxRequestV1,
    descriptor: ManimRenderSandboxDescriptorV1,
    executionDigest: string,
    stagingId: string,
    deadlineEpochMs: number,
    signal: AbortSignal,
  ): Promise<ManimRenderGatedOciBaseResultV1> {
    let attached: ReturnType<FastManimGatedOciDockerClientV1["attach"]> | undefined;
    let attachedExit: Promise<Readonly<{ code: number; signal: NodeJS.Signals | null }>> | undefined;
    let containerId: string | undefined;
    let containerCreationAttempted = false;
    let immutableContainerIdObserved = false;
    let runningIdentity: FastManimGatedOciRunningIdentityV1 | undefined;
    let copied: CopiedArtifact | undefined;
    const containerName = `poietra-render-${stagingId}`;
    const execute = async (): Promise<ManimRenderGatedOciBaseResultV1> => {
      try {
        const staged = await this.#readStaged(descriptor, executionDigest, stagingId, deadlineEpochMs, signal);
        if (staged) {
          await this.#cleanupByStableId(stagingId);
          return staged;
        }
        const recovered = await this.#inspectNamedContainer(containerName, descriptor, executionDigest);
        if (recovered) {
          ({ containerId, runningIdentity } = recovered);
        } else {
          containerCreationAttempted = true;
          containerId = await this.#createContainer(containerName, executionDigest, deadlineEpochMs, signal);
          immutableContainerIdObserved = true;
          ({ attached, attachedExit } = await this.#startAndGate(
            containerId,
            request,
            executionDigest,
            deadlineEpochMs,
            signal,
          ));
          const inspection = await this.#inspectContainer(
            containerId,
            containerName,
            executionDigest,
            deadlineEpochMs,
            true,
          );
          const pid = inspection.State?.Pid;
          if (!Number.isSafeInteger(pid) || (pid as number) <= 1) throw new Error("Render OCI PID is invalid.");
          const startTime = await readFastManimGatedOciProcessStartTimeV1(pid as number);
          runningIdentity = await inspectFastManimGatedOciRunningCgroupV1(containerId, pid as number, startTime);
          await inspectFastManimGatedOciRunningResourcesV1(runningIdentity);
        }
        await this.#waitForBrokerReadable(runningIdentity!, deadlineEpochMs, signal);
        const terminal = await this.#readTerminal(
          containerId,
          runningIdentity!,
          executionDigest,
          descriptor.output.mediaType,
          deadlineEpochMs,
          signal,
        );
        if (terminal.kind === "failed") {
          try {
            await cleanupFastManimGatedOciContainerV1(
              containerId,
              runningIdentity,
              this.#docker,
              this.#cgroupKillPolicy,
            );
            containerId = undefined;
          } catch (cleanupError) {
            this.#latchCleanupFailure(cleanupError);
            await this.#deleteStaged(stagingId);
            return { code: "cleanup-failed", kind: "failed" };
          }
          return { code: "render-failed", diagnostic: terminal.reason, kind: "failed" };
        }
        copied = await this.#copyArtifact(
          containerId,
          runningIdentity!,
          descriptor,
          executionDigest,
          stagingId,
          deadlineEpochMs,
          signal,
        );
        throwIfDeadlineElapsed(deadlineEpochMs, signal);
        const pause = await this.#docker.run(["container", "pause", containerId], remaining(deadlineEpochMs), signal);
        if (pause.code !== 0) throw new Error("Render OCI cgroup could not be frozen before publication.");
        const paused = await this.#inspectContainer(containerId, containerName, executionDigest, deadlineEpochMs, true);
        if (paused.State?.Paused !== true) throw new Error("Render OCI cgroup did not freeze before publication.");
        try {
          await cleanupFastManimGatedOciContainerV1(containerId, runningIdentity, this.#docker, this.#cgroupKillPolicy);
          containerId = undefined;
        } catch (cleanupError) {
          this.#latchCleanupFailure(cleanupError);
          await Promise.all([rm(copied.incoming, { force: true, recursive: true }), this.#deleteStaged(stagingId)]);
          return { code: "cleanup-failed", kind: "failed" };
        }
        try {
          return await this.#publishCopiedArtifact(copied, stagingId, deadlineEpochMs, signal);
        } finally {
          await rm(copied.incoming, { force: true, recursive: true });
        }
      } catch (error) {
        if (fastManimSandboxBackendControlErrorCode(error) === "cleanup") {
          this.#latchCleanupFailure(error);
        }
        try {
          if (containerId) {
            await cleanupFastManimGatedOciContainerV1(
              containerId,
              runningIdentity,
              this.#docker,
              this.#cgroupKillPolicy,
            );
          } else {
            await this.#cleanupByStableId(stagingId);
          }
        } catch (cleanupError) {
          this.#latchCleanupFailure(cleanupError);
          await this.#deleteStaged(stagingId);
          return { code: "cleanup-failed", kind: "failed" };
        }
        if (containerCreationAttempted && !immutableContainerIdObserved) {
          const uncertainty = new Error("The render OCI create outcome cannot be proven absent by stable name.");
          this.#latchCleanupFailure(uncertainty);
          await this.#deleteStaged(stagingId);
          return { code: "cleanup-failed", kind: "failed" };
        }
        if (this.#cleanupFailure !== undefined) {
          await this.#deleteStaged(stagingId);
          return { code: "cleanup-failed", kind: "failed" };
        }
        if (Date.now() >= deadlineEpochMs) return { code: "deadline-exceeded", kind: "failed" };
        if (signal.aborted) return { code: "cancelled", kind: "failed" };
        return { code: "render-failed", kind: "failed" };
      }
    };
    let result: ManimRenderGatedOciBaseResultV1 | undefined;
    let executionError: unknown;
    try {
      result = await execute();
    } catch (error) {
      executionError = error;
    }
    if (attached && attachedExit) {
      try {
        await reapFastManimGatedOciAttachedDockerClientV1(attached, attachedExit);
      } catch (error) {
        this.#latchCleanupFailure(error);
        await this.#deleteStaged(stagingId);
        return { code: "cleanup-failed", kind: "failed" };
      }
    }
    if (executionError !== undefined) throw executionError;
    return result!;
  }

  #latchCleanupFailure(error: unknown) {
    this.#cleanupFailure ??= error;
    for (const job of this.#active.values()) job.abort.abort(error);
  }

  async #createContainer(containerName: string, executionDigest: string, deadlineEpochMs: number, signal: AbortSignal) {
    const result = await this.#docker.run(
      [
        "container",
        "create",
        `--name=${containerName}`,
        "--interactive",
        "--read-only",
        "--network=none",
        "--user=65532:65532",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges=true",
        `--security-opt=seccomp=${this.#seccompPath}`,
        "--log-driver=none",
        "--restart=no",
        `--pids-limit=${PIDS_LIMIT}`,
        `--memory=${MEMORY_BYTES}`,
        `--memory-swap=${MEMORY_BYTES}`,
        `--cpus=${CPU_NANOSECONDS / 1_000_000_000}`,
        "--ipc=none",
        `--shm-size=${SHM_BYTES}`,
        "--cgroupns=private",
        "--ulimit=core=0:0",
        "--ulimit=nofile=256:256",
        `--tmpfs=/run/poietra:${TMPFS_OPTIONS.join(",")}`,
        "--stop-timeout=1",
        "--label=io.poietra.render-job=v1",
        `--label=io.poietra.render-execution-sha256=${executionDigest}`,
        `--label=io.poietra.render-deadline-epoch-ms=${deadlineEpochMs}`,
        this.#image,
      ],
      CONTROL_TIMEOUT_MS,
      signal,
    );
    const containerId = result.stdout.toString("ascii").trim();
    if (result.code !== 0 || !CONTAINER_ID.test(containerId))
      throw new Error("Docker could not create render OCI job.");
    await this.#inspectContainer(containerId, containerName, executionDigest, deadlineEpochMs, false);
    return containerId;
  }

  async #startAndGate(
    containerId: string,
    request: SealedManimRenderSandboxRequestV1,
    executionDigest: string,
    deadlineEpochMs: number,
    signal: AbortSignal,
  ) {
    const attached = this.#docker.attach(["container", "start", "--attach", "--interactive", containerId]);
    return deliverSealedManimRenderGateRequestV1(attached, request, executionDigest, deadlineEpochMs, signal);
  }

  async #inspectNamedContainer(
    containerName: string,
    descriptor: ManimRenderSandboxDescriptorV1,
    executionDigest: string,
  ) {
    const listed = await this.#docker.run([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `name=^/${containerName}$`,
    ]);
    const ids = listed.stdout.toString("ascii").trim().split("\n").filter(Boolean);
    if (listed.code !== 0 || ids.length > 1 || ids.some((id) => !CONTAINER_ID.test(id))) {
      throw new Error("Docker returned ambiguous stable render jobs.");
    }
    const containerId = ids[0];
    if (!containerId) return null;
    let runningIdentity: FastManimGatedOciRunningIdentityV1 | undefined;
    try {
      const raw = await this.#docker.run(["container", "inspect", containerId]);
      if (raw.code !== 0) throw new Error("Docker could not inspect the stable render job.");
      const candidate = parseFastManimGatedOciSingleInspectionV1(raw.stdout);
      const running = candidate.State?.Running === true;
      const inspection = await this.#inspectContainer(
        containerId,
        containerName,
        executionDigest,
        descriptor.deadlineEpochMs,
        running,
      );
      if (running) {
        const pid = inspection.State?.Pid;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 1) {
          throw new Error("The stable render PID is unavailable.");
        }
        const startTime = await readFastManimGatedOciProcessStartTimeV1(pid as number);
        runningIdentity = await inspectFastManimGatedOciRunningCgroupV1(containerId, pid as number, startTime);
        await inspectFastManimGatedOciRunningResourcesV1(runningIdentity);
      }
      if (!running || inspection.State?.Paused === true) {
        await cleanupFastManimGatedOciContainerV1(containerId, runningIdentity, this.#docker, this.#cgroupKillPolicy);
        return null;
      }
      if (descriptor.runtimeDigest !== this.runtimeDigest) throw new Error("The reattached render runtime drifted.");
      return { containerId, runningIdentity: runningIdentity! };
    } catch (error) {
      try {
        await cleanupFastManimGatedOciContainerV1(containerId, runningIdentity, this.#docker, this.#cgroupKillPolicy);
      } catch (cleanupError) {
        this.#latchCleanupFailure(cleanupError);
        throw cleanupError;
      }
      this.#latchCleanupFailure(error);
      throw error;
    }
  }

  async #inspectContainer(
    containerId: string,
    containerName: string,
    executionDigest: string,
    deadlineEpochMs: number,
    running: boolean,
  ) {
    const result = await this.#docker.run(["container", "inspect", containerId]);
    if (result.code !== 0) throw new Error("Docker could not inspect the stable render job.");
    const inspected = parseFastManimGatedOciSingleInspectionV1(result.stdout);
    const host = inspected.HostConfig;
    const config = inspected.Config;
    const environment = exactStringMap(config?.Env);
    const mounts = inspected.Mounts;
    const noMounts = mounts === null || (Array.isArray(mounts) && mounts.length === 0);
    const labels = config?.Labels as Record<string, unknown> | undefined;
    const tmpfs = host?.Tmpfs as Record<string, unknown> | undefined;
    if (
      inspected.Id !== containerId ||
      inspected.Image !== this.#image ||
      inspected.Name !== `/${containerName}` ||
      config?.Image !== this.#image ||
      !sameArray(config?.Entrypoint, FIXED_ENTRYPOINT) ||
      !(config?.Cmd === null || sameArray(config?.Cmd, [])) ||
      config?.User !== "65532:65532" ||
      config?.WorkingDir !== "/run/poietra" ||
      config?.OpenStdin !== true ||
      config?.StdinOnce !== true ||
      config?.StopTimeout !== 1 ||
      config?.Tty !== false ||
      !emptyRecord(config?.ExposedPorts) ||
      environment === null ||
      !exactMap(environment, FIXED_ENVIRONMENT) ||
      labels?.["io.poietra.render-job"] !== "v1" ||
      labels?.["io.poietra.render-execution-sha256"] !== executionDigest ||
      labels?.["io.poietra.render-deadline-epoch-ms"] !== String(deadlineEpochMs) ||
      host?.ReadonlyRootfs !== true ||
      host?.Privileged !== false ||
      host?.AutoRemove !== false ||
      host?.NetworkMode !== "none" ||
      host?.PidMode !== "" ||
      host?.IpcMode !== "none" ||
      host?.CgroupnsMode !== "private" ||
      host?.PidsLimit !== PIDS_LIMIT ||
      host?.Memory !== MEMORY_BYTES ||
      host?.MemorySwap !== MEMORY_BYTES ||
      host?.NanoCpus !== CPU_NANOSECONDS ||
      host?.ShmSize !== SHM_BYTES ||
      !sameArray(host?.CapDrop, ["ALL"]) ||
      !emptySequence(host?.CapAdd) ||
      !sameSecurityOptions(host?.SecurityOpt) ||
      !sameUlimits(host?.Ulimits) ||
      typeof host?.LogConfig !== "object" ||
      host.LogConfig === null ||
      (host.LogConfig as { Type?: unknown }).Type !== "none" ||
      !emptyRecord((host.LogConfig as { Config?: unknown }).Config) ||
      !emptySequence(host?.Binds) ||
      !emptySequence(host?.Devices) ||
      !emptySequence(host?.DeviceRequests) ||
      !emptySequence(host?.Dns) ||
      !emptySequence(host?.DnsOptions) ||
      !emptySequence(host?.DnsSearch) ||
      !emptySequence(host?.ExtraHosts) ||
      !emptyRecord(host?.PortBindings) ||
      host?.PublishAllPorts !== false ||
      typeof host?.RestartPolicy !== "object" ||
      host.RestartPolicy === null ||
      (host.RestartPolicy as { Name?: unknown }).Name !== "no" ||
      (host.RestartPolicy as { MaximumRetryCount?: unknown }).MaximumRetryCount !== 0 ||
      !containsRequiredStrings(host?.MaskedPaths, REQUIRED_MASKED_SYSTEM_PATHS) ||
      !containsRequiredStrings(host?.ReadonlyPaths, REQUIRED_READ_ONLY_SYSTEM_PATHS) ||
      !tmpfs ||
      Object.keys(tmpfs).length !== 1 ||
      typeof tmpfs["/run/poietra"] !== "string" ||
      tmpfs["/run/poietra"].split(",").sort().join(",") !== TMPFS_OPTIONS.toSorted().join(",") ||
      !noMounts ||
      !emptyRecord(inspected.NetworkSettings?.Ports) ||
      !noNetworkEndpoint(inspected.NetworkSettings?.Networks, running) ||
      !sameNetworkSandboxIdentity(inspected.NetworkSettings, running) ||
      inspected.State?.Running !== running
    ) {
      throw new Error("The stable render OCI profile drifted.");
    }
    return inspected;
  }

  async #brokerReadableState(identity: FastManimGatedOciRunningIdentityV1) {
    const [processesText, processCountText, processName, startTime, cgroup] = await Promise.all([
      readFile(resolve(identity.cgroupPath, "cgroup.procs"), "ascii"),
      readFile(resolve(identity.cgroupPath, "pids.current"), "ascii"),
      readFile(`/proc/${identity.pid}/comm`, "utf8"),
      readFastManimGatedOciProcessStartTimeV1(identity.pid),
      readFile(`/proc/${identity.pid}/cgroup`, "utf8"),
    ]);
    const processLines = processesText.trimEnd().split("\n").filter(Boolean);
    const processes = processLines.map(Number);
    const processCount = Number(processCountText.trim());
    if (
      processLines.length === 0 ||
      processLines.length > PIDS_LIMIT ||
      processes.some(
        (value, index) => !Number.isSafeInteger(value) || value <= 1 || processes.indexOf(value) !== index,
      ) ||
      !processes.includes(identity.pid) ||
      !Number.isSafeInteger(processCount) ||
      processCount < processes.length ||
      processCount > PIDS_LIMIT ||
      startTime !== identity.startTime ||
      cgroup !== identity.cgroup
    ) {
      throw new Error("The render OCI process identity drifted before artifact export.");
    }
    const ready = processName === `${BROKER_READABLE_PROCESS_NAME}\n`;
    if (ready && (processes.length !== 1 || processes[0] !== identity.pid || processCount !== 1)) {
      throw new Error("The render OCI gate published while untrusted descendants remained.");
    }
    return ready;
  }

  async #waitForBrokerReadable(
    identity: FastManimGatedOciRunningIdentityV1,
    deadlineEpochMs: number,
    signal: AbortSignal,
  ) {
    while (true) {
      throwIfDeadlineElapsed(deadlineEpochMs, signal);
      if (await this.#brokerReadableState(identity)) return;
      await delay(POLL_INTERVAL_MS, signal);
    }
  }

  async #assertBrokerReadable(identity: FastManimGatedOciRunningIdentityV1) {
    if (!(await this.#brokerReadableState(identity))) {
      throw new Error("The render OCI gate left its broker-readable state.");
    }
  }

  async #readTerminal(
    containerId: string,
    identity: FastManimGatedOciRunningIdentityV1,
    executionDigest: string,
    mediaType: "image/png" | "video/mp4",
    deadlineEpochMs: number,
    signal: AbortSignal,
  ) {
    throwIfDeadlineElapsed(deadlineEpochMs, signal);
    await this.#assertBrokerReadable(identity);
    const result = await this.#docker.run(
      ["container", "exec", "--user=65532:65532", containerId, FIXED_EXPORT_COMMAND, FIXED_TERMINAL_PATH],
      remaining(deadlineEpochMs),
      signal,
    );
    throwIfDeadlineElapsed(deadlineEpochMs, signal);
    await this.#assertBrokerReadable(identity);
    if (result.code !== 0 || result.stderr.byteLength !== 0 || result.stdout.byteLength > 4 * 1024) {
      throw new Error("Docker could not read one bounded render terminal marker.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    const terminal = containerTerminalSchema.parse(JSON.parse(text));
    if (
      canonicalJsonV1(terminal) !== text ||
      terminal.executionDigest !== executionDigest ||
      (terminal.kind === "ready" && terminal.mediaType !== mediaType)
    ) {
      throw new Error("The render terminal marker is not canonically correlated.");
    }
    return terminal;
  }

  async #copyArtifact(
    containerId: string,
    identity: FastManimGatedOciRunningIdentityV1,
    descriptor: ManimRenderSandboxDescriptorV1,
    executionDigest: string,
    stagingId: string,
    deadlineEpochMs: number,
    signal: AbortSignal,
  ): Promise<CopiedArtifact> {
    const mediaType = descriptor.output.mediaType;
    const extension = artifactExtension(mediaType);
    await this.#assertStagingRootIdentity();
    const incoming = await mkdtemp(join(this.#stagingRoot, ".artifact-"));
    const temporaryArtifact = join(incoming, `artifact.${extension}`);
    try {
      throwIfDeadlineElapsed(deadlineEpochMs, signal);
      await this.#assertBrokerReadable(identity);
      const artifactHandle = await open(temporaryArtifact, "wx", 0o600);
      try {
        await streamDockerFileToHandle(
          this.#docker,
          containerId,
          FIXED_ARTIFACT_PATHS[mediaType],
          artifactHandle,
          deadlineEpochMs,
          signal,
        );
      } finally {
        await artifactHandle.close();
      }
      await this.#assertBrokerReadable(identity);
      const { digest, size } = await validateMedia(temporaryArtifact, mediaType, {
        deadlineEpochMs,
        signal,
      });
      const manifest = stagedManifestSchema.parse({
        artifactDigest: digest,
        artifactSize: size,
        deadlineEpochMs: descriptor.deadlineEpochMs,
        executionDigest,
        jobId: descriptor.jobId,
        mediaType,
        profileDigest: descriptor.profileDigest,
        runtimeDigest: descriptor.runtimeDigest,
        sourceDigest: descriptor.sourceDigest,
        stagingId,
        version: 1,
      });
      throwIfDeadlineElapsed(deadlineEpochMs, signal);
      await this.#assertStagingRootIdentity();
      return {
        incoming,
        manifest,
        result: { artifactDigest: digest, artifactSize: size, kind: "ready", mediaType, stagingId },
        temporaryArtifact,
      };
    } catch (error) {
      await rm(incoming, { force: true, recursive: true });
      throw error;
    }
  }

  async #publishCopiedArtifact(
    copied: CopiedArtifact,
    stagingId: string,
    deadlineEpochMs: number,
    signal: AbortSignal,
  ) {
    const extension = artifactExtension(copied.result.mediaType);
    const finalArtifact = join(this.#stagingRoot, `${stagingId}.${extension}`);
    const temporaryManifest = join(this.#stagingRoot, `.${stagingId}.json.tmp`);
    try {
      await this.#assertStagingRootIdentity();
      throwIfDeadlineElapsed(deadlineEpochMs, signal);
      await rename(copied.temporaryArtifact, finalArtifact);
      if (this.#stagingGroupId !== undefined) {
        const userId = process.geteuid?.();
        if (userId === undefined) throw new Error("The render broker user identity is unavailable.");
        await chown(finalArtifact, userId, this.#stagingGroupId);
        await chmod(finalArtifact, 0o640);
      }
      throwIfDeadlineElapsed(deadlineEpochMs, signal);
      await rm(temporaryManifest, { force: true });
      const manifestHandle = await open(temporaryManifest, "wx", 0o600);
      try {
        await manifestHandle.writeFile(canonicalJsonV1(copied.manifest), "utf8");
        await manifestHandle.sync();
      } finally {
        await manifestHandle.close();
      }
      throwIfDeadlineElapsed(deadlineEpochMs, signal);
      await rename(temporaryManifest, join(this.#stagingRoot, `${stagingId}.json`));
      const stagingDirectory = await open(this.#stagingRoot, "r");
      try {
        await stagingDirectory.sync();
      } finally {
        await stagingDirectory.close();
      }
      throwIfDeadlineElapsed(deadlineEpochMs, signal);
      await this.#assertStagingRootIdentity();
      return copied.result;
    } catch (error) {
      await Promise.all([
        rm(finalArtifact, { force: true }),
        rm(temporaryManifest, { force: true }),
        rm(join(this.#stagingRoot, `${stagingId}.json`), { force: true }),
      ]);
      throw error;
    }
  }

  async #readStaged(
    descriptor: ManimRenderSandboxDescriptorV1,
    executionDigest: string,
    stagingId: string,
    deadlineEpochMs: number,
    signal: AbortSignal,
  ): Promise<Extract<ManimRenderGatedOciBaseResultV1, { kind: "ready" }> | null> {
    await this.#assertStagingRootIdentity();
    try {
      const manifest = await readStagedManifest(join(this.#stagingRoot, `${stagingId}.json`));
      if (
        manifest.deadlineEpochMs !== descriptor.deadlineEpochMs ||
        manifest.executionDigest !== executionDigest ||
        manifest.jobId !== descriptor.jobId ||
        manifest.mediaType !== descriptor.output.mediaType ||
        manifest.profileDigest !== descriptor.profileDigest ||
        manifest.runtimeDigest !== descriptor.runtimeDigest ||
        manifest.sourceDigest !== descriptor.sourceDigest ||
        manifest.stagingId !== stagingId
      ) {
        throw new Error("The broker staging correlation does not match the render request.");
      }
      const artifact = join(this.#stagingRoot, `${stagingId}.${artifactExtension(manifest.mediaType)}`);
      const verified = await validateMedia(artifact, manifest.mediaType, { deadlineEpochMs, signal });
      if (verified.digest !== manifest.artifactDigest || verified.size !== manifest.artifactSize) {
        throw new Error("The broker staging artifact no longer matches its manifest.");
      }
      await this.#assertStagingRootIdentity();
      return {
        artifactDigest: manifest.artifactDigest,
        artifactSize: manifest.artifactSize,
        kind: "ready",
        mediaType: manifest.mediaType,
        stagingId,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.#assertStagingRootIdentity();
        return null;
      }
      throw error;
    }
  }

  async #cleanupByStableId(stagingId: string) {
    const containerName = `poietra-render-${stagingId}`;
    if (!CONTAINER_NAME.test(containerName)) throw new TypeError("The stable render container name is invalid.");
    const listed = await this.#docker.run([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `name=^/${containerName}$`,
    ]);
    const ids = listed.stdout.toString("ascii").trim().split("\n").filter(Boolean);
    if (listed.code !== 0 || ids.length > 1 || ids.some((id) => !CONTAINER_ID.test(id))) {
      throw new Error("Docker returned ambiguous render cleanup targets.");
    }
    const containerId = ids[0];
    if (!containerId) return;
    let identity: FastManimGatedOciRunningIdentityV1 | undefined;
    try {
      const inspected = await this.#docker.run(["container", "inspect", containerId]);
      if (inspected.code !== 0) throw new Error("Docker could not inspect the render cleanup target.");
      const container = parseFastManimGatedOciSingleInspectionV1(inspected.stdout);
      const executionDigest = (container.Config?.Labels as Record<string, unknown> | undefined)?.[
        "io.poietra.render-execution-sha256"
      ];
      const deadlineEpochMs = deadlineLabel(container.Config?.Labels as Record<string, unknown> | undefined);
      if (typeof executionDigest !== "string" || !/^[a-f0-9]{64}$/u.test(executionDigest)) {
        throw new Error("The render cleanup target has an invalid execution identity.");
      }
      const running = container.State?.Running === true;
      if (running) {
        const pid = container.State?.Pid;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 1) throw new Error("The render cleanup PID is invalid.");
        const startTime = await readFastManimGatedOciProcessStartTimeV1(pid as number);
        identity = await inspectFastManimGatedOciRunningCgroupV1(containerId, pid as number, startTime);
      }
      await this.#inspectContainer(containerId, containerName, executionDigest, deadlineEpochMs, running);
      await cleanupFastManimGatedOciContainerV1(containerId, identity, this.#docker, this.#cgroupKillPolicy);
    } catch (error) {
      try {
        await cleanupFastManimGatedOciContainerV1(containerId, identity, this.#docker, this.#cgroupKillPolicy);
      } catch (cleanupError) {
        this.#latchCleanupFailure(cleanupError);
        throw cleanupError;
      }
      this.#latchCleanupFailure(error);
      throw error;
    }
  }

  async #deleteStaged(stagingId: string) {
    await this.#assertStagingRootIdentity();
    await Promise.all(
      ["json", "mp4", "png"].map((extension) =>
        rm(join(this.#stagingRoot, `${stagingId}.${extension}`), { force: true }),
      ),
    );
    await this.#assertStagingRootIdentity();
  }
}
