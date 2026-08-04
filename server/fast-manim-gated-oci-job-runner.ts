import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastManimGatedOciSeccompV1 from "../sandbox/fast-manim-gated-oci/seccomp.v1.json";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FastManimSandboxBackendControlError,
  type FastManimSandboxBackendFailureCodeV1,
  type FastManimSandboxBackendResultV1,
  type FastManimSandboxJobContextV1,
  type FastManimSandboxRequestBundleV1,
  fastManimSandboxBackendControlErrorCode,
  MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES,
  parseFastManimSandboxJobIdentityV1,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";
import {
  MAX_FAST_MANIM_PROFILE_SELECTION_RESULT_JSON_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS,
  MAX_FAST_MANIM_SNAPSHOT_OBJECT_FIELDS,
  MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH,
  MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_ENTRIES,
  MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_VALUES,
} from "./fast-manim-snapshot-contract";
import { abortError } from "./fast-manim-snapshot-producer-process";

const DOCKER = "/usr/bin/docker";
const DOCKER_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin" });
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const CONTAINER_NAME = /^poietra-gated-[a-f0-9]{32}$/;
const JOB_LABEL_KEY = "io.poietra.gated-job";
const JOB_LABEL_VALUE = "v1";
const JOB_LABEL = `${JOB_LABEL_KEY}=${JOB_LABEL_VALUE}`;
const GATE_READY = Buffer.from("POIETRA_GATE_READY_V1\n", "ascii");
const GATE_MAGIC = Buffer.from("POIETR1\0", "ascii");
const GATE_HEADER_BYTES = 48;
const MAX_STDERR_BYTES = 256 * 1024;
const MEMORY_BYTES = 512 * 1024 * 1024;
const PIDS_LIMIT = 64;
const CPU_NANOSECONDS = 1_000_000_000;
const TMPFS_BYTES = 16 * 1024 * 1024;
const SHM_BYTES = 64 * 1024;
const DOCKER_CONTROL_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const CLEANUP_POLL_MS = 25;
const DEFAULT_SECCOMP_PATH = fileURLToPath(new URL("../sandbox/fast-manim-gated-oci/seccomp.v1.json", import.meta.url));
const FIXED_ENTRYPOINT = Object.freeze(["/opt/venv/bin/python", "/opt/poietra/gated-entrypoint.py"] as const);
const FIXED_TARGET = Object.freeze(["/opt/venv/bin/python", "-m", "manim.renderer.source_runtime_identity"] as const);
const FIXED_TMPFS_PATH = "/run/poietra";
const FIXED_TMPFS_OPTIONS = Object.freeze([
  "rw",
  "noexec",
  "nosuid",
  "nodev",
  `size=${TMPFS_BYTES}`,
  "mode=0700",
  "uid=65532",
  "gid=65532",
] as const);
const FIXED_ULIMITS = Object.freeze([
  Object.freeze({ hard: 0, name: "core", soft: 0 }),
  Object.freeze({ hard: 256, name: "nofile", soft: 256 }),
] as const);
// Docker 28 adds host-dependent thermal_throttle entries to this list. The
// fixed profile therefore binds the mandatory floor and accepts extra masks.
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
const FAST_MANIM_GATED_OCI_ARCHIVE_SHA256_V1 = "2efa05e411df6a13b7c1bfab93bc99f8b58aeb8f3daf5f17db894b3c0ed54823";
const FAST_MANIM_GATED_OCI_COMMIT_V1 = "d2480e8096a5cac64f7f86ed1d0d01f5c87839e3";
const FAST_MANIM_GATED_OCI_TREE_V1 = "0ca5f7fc0c77a87fec7df605c8ce1190edf16f0a";

/**
 * Versioned dependency on fast-manim's complete V4 Python-AST admission
 * contract. Studio derives only the ordered post-add transform plan; changing
 * the producer grammar requires advancing this identity and the OCI profile
 * digest together.
 */
export const FAST_MANIM_HERMETIC_PNG_V4_PRODUCER_CONTRACT_V1 = Object.freeze({
  archiveSha256: FAST_MANIM_GATED_OCI_ARCHIVE_SHA256_V1,
  authority: "manim.renderer._scene_snapshot.profile.hermetic_png_plan_v4",
  commit: FAST_MANIM_GATED_OCI_COMMIT_V1,
  snapshotVersion: 4,
  studioResponsibility: "post-add-static-transform-plan",
  tree: FAST_MANIM_GATED_OCI_TREE_V1,
  version: 1,
} as const);

const LOCKED_LABELS = Object.freeze({
  "io.poietra.fast-manim.archive-sha256": FAST_MANIM_GATED_OCI_ARCHIVE_SHA256_V1,
  "io.poietra.fast-manim.commit": FAST_MANIM_GATED_OCI_COMMIT_V1,
  "io.poietra.fast-manim.tree": FAST_MANIM_GATED_OCI_TREE_V1,
  "io.poietra.mathtex-outline.abi-version": "1",
  "io.poietra.mathtex-outline.artifact-sha256": "0".repeat(64),
  "io.poietra.mathtex-outline.engine-archive-sha256":
    "2aa42246977322bae54862f49ce28b3e61bf8b472a93800b2fdda8e344173d32",
  "io.poietra.mathtex-outline.engine-commit": "be671c1ddcfc8466548c8822956e19579256e581",
  "io.poietra.mathtex-outline.engine-tree": "d0f6d72213c65527ae9b7a4717390b48db1e9256",
  "io.poietra.mathtex-outline.font-sha256": "e52df76208d1e41c8222496e9fb30cc2a1fe8a275b14995f3f6c3a9205db21fa",
  "io.poietra.mathtex-outline.notice-sha256": "44eebb7f078626c705cf0d952509075410f86bb91af6e4102d38565c53ddb856",
  "io.poietra.mathtex-outline.target": "linux-amd64",
  "io.poietra.mathtex-outline.toolchain-sha256": "40a85bd625fe868b295906a6a002a1cfae677be241f835898f467a113b626430",
  "io.poietra.snapshot-sandbox-envelope-version": "2",
  "io.poietra.sandbox-slice": "gated-oci-v1",
});
/** False until #280 records the double-clean amd64 native artifact digest. */
export const FAST_MANIM_GATED_OCI_SNAPSHOT_RELEASE_READY_V1 =
  LOCKED_LABELS["io.poietra.mathtex-outline.artifact-sha256"] !== "0".repeat(64);
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
export const FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1 = createHash("sha256")
  .update(canonicalJsonV1(fastManimGatedOciSeccompV1), "utf8")
  .digest("hex");
export const FAST_MANIM_GATED_OCI_PROFILE_V1 = Object.freeze({
  autoRemove: false,
  binds: Object.freeze([]),
  capabilitiesAdded: Object.freeze([]),
  capabilitiesDropped: Object.freeze(["ALL"]),
  cgroupNamespace: "private",
  cpuNanoSeconds: CPU_NANOSECONDS,
  devices: Object.freeze([]),
  entrypoint: FIXED_ENTRYPOINT,
  environment: FIXED_ENVIRONMENT,
  ipc: "none",
  logDriver: Object.freeze({ config: Object.freeze({}), type: "none" }),
  memoryBytes: MEMORY_BYTES,
  memorySwapBytes: MEMORY_BYTES,
  mounts: Object.freeze([]),
  network: "none",
  noNewPrivileges: true,
  openStdin: true,
  pidNamespace: "private",
  pidsLimit: PIDS_LIMIT,
  privileged: false,
  producerContracts: Object.freeze({
    hermeticPngV4: FAST_MANIM_HERMETIC_PNG_V4_PRODUCER_CONTRACT_V1,
  }),
  readOnlyRootfs: true,
  requestEnvelopeVersions: Object.freeze([1, 2]),
  requiredContainerLabels: Object.freeze({ ...LOCKED_LABELS, [JOB_LABEL_KEY]: JOB_LABEL_VALUE }),
  requiredMaskedSystemPaths: REQUIRED_MASKED_SYSTEM_PATHS,
  requiredReadOnlySystemPaths: REQUIRED_READ_ONLY_SYSTEM_PATHS,
  schema: "poietra.fast-manim-gated-oci-profile",
  seccompDigest: FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
  shmBytes: SHM_BYTES,
  stdinOnce: true,
  stopTimeoutSeconds: 1,
  target: FIXED_TARGET,
  tty: false,
  fixedAssets: Object.freeze(["image.png"]),
  tmpfs: Object.freeze({ options: FIXED_TMPFS_OPTIONS, path: FIXED_TMPFS_PATH }),
  ulimits: FIXED_ULIMITS,
  user: "65532:65532",
  version: 1,
  workingDirectory: "/run/poietra",
});
export const FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1 = createHash("sha256")
  .update(canonicalJsonV1(FAST_MANIM_GATED_OCI_PROFILE_V1), "utf8")
  .digest("hex");

export type FastManimGatedOciDockerResultV1 = Readonly<{ code: number; stderr: Buffer; stdout: Buffer }>;

/** Docker CLI transport. Production callers must always provide a fixed Unix socket. */
export class FastManimGatedOciDockerClientV1 {
  readonly #argumentsPrefix: readonly string[];
  readonly socketPath: string | undefined;

  constructor(options: Readonly<{ socketPath?: string }> = {}) {
    const socketPath = options.socketPath;
    if (
      socketPath !== undefined &&
      (!socketPath.startsWith("/") ||
        resolve(socketPath) !== socketPath ||
        socketPath.includes("\0") ||
        Buffer.byteLength(socketPath, "utf8") > 4_096)
    ) {
      throw new TypeError("The Docker socket must be a canonical absolute path.");
    }
    this.socketPath = socketPath;
    this.#argumentsPrefix = Object.freeze(socketPath ? ["--host", `unix://${socketPath}`] : []);
  }

  run(arguments_: readonly string[], timeoutMs = DOCKER_CONTROL_TIMEOUT_MS, signal?: AbortSignal) {
    return docker([...this.#argumentsPrefix, ...arguments_], timeoutMs, signal);
  }

  attach(arguments_: readonly string[]) {
    return spawn(DOCKER, [...this.#argumentsPrefix, ...arguments_], {
      env: DOCKER_ENVIRONMENT,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}

const defaultDockerClient = new FastManimGatedOciDockerClientV1();

export async function assertFastManimGatedOciSeccompV1(path = DEFAULT_SECCOMP_PATH) {
  if (
    !path.startsWith("/") ||
    resolve(path) !== path ||
    path.includes("\0") ||
    Buffer.byteLength(path, "utf8") > 4_096
  ) {
    throw new TypeError("The gated OCI seccomp path must be canonical and absolute.");
  }
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 256 * 1024) {
      throw new TypeError("The gated OCI seccomp profile is not a bounded regular file.");
    }
    const parsed = JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown;
    const digest = createHash("sha256").update(canonicalJsonV1(parsed), "utf8").digest("hex");
    if (digest !== FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1) {
      throw new TypeError("The gated OCI seccomp profile digest does not match the fixed profile.");
    }
    return path;
  } finally {
    await file.close();
  }
}
export type FastManimGatedOciContainerInspectionV1 = Readonly<{
  Config?: {
    Cmd?: unknown;
    Entrypoint?: unknown;
    Env?: unknown;
    ExposedPorts?: unknown;
    Image?: unknown;
    Labels?: unknown;
    OpenStdin?: unknown;
    StdinOnce?: unknown;
    StopTimeout?: unknown;
    Tty?: unknown;
    User?: unknown;
    WorkingDir?: unknown;
  };
  HostConfig?: {
    AutoRemove?: unknown;
    Binds?: unknown;
    CapAdd?: unknown;
    CapDrop?: unknown;
    CgroupnsMode?: unknown;
    Devices?: unknown;
    DeviceRequests?: unknown;
    Dns?: unknown;
    DnsOptions?: unknown;
    DnsSearch?: unknown;
    ExtraHosts?: unknown;
    IpcMode?: unknown;
    LogConfig?: unknown;
    MaskedPaths?: unknown;
    Memory?: unknown;
    MemorySwap?: unknown;
    NanoCpus?: unknown;
    NetworkMode?: unknown;
    PortBindings?: unknown;
    PidMode?: unknown;
    PidsLimit?: unknown;
    PublishAllPorts?: unknown;
    Privileged?: unknown;
    ReadonlyRootfs?: unknown;
    ReadonlyPaths?: unknown;
    RestartPolicy?: unknown;
    SecurityOpt?: unknown;
    ShmSize?: unknown;
    Tmpfs?: unknown;
    Ulimits?: unknown;
  };
  Id?: unknown;
  Image?: unknown;
  Mounts?: unknown;
  Name?: unknown;
  NetworkSettings?: { Networks?: unknown; Ports?: unknown; SandboxID?: unknown; SandboxKey?: unknown };
  State?: { Paused?: unknown; Pid?: unknown; Running?: unknown };
}>;

export type FastManimGatedOciEvidenceV1 = Readonly<{
  cgroup: string;
  containerId: string;
  pid: number;
  resources: Readonly<{ cpuMax: string; memoryMax: string; memorySwapMax: string; pidsMax: string }>;
}>;

export type FastManimGatedOciExecutionV1 = Readonly<{
  cleanupVerified: true;
  evidence: FastManimGatedOciEvidenceV1;
  resultBytes: Uint8Array;
}>;

export class FastManimGatedOciError extends Error {
  readonly code: FastManimSandboxBackendFailureCodeV1;
  cleanupVerified = false;
  containerId: string | undefined;
  pid: number | undefined;

  constructor(code: FastManimSandboxBackendFailureCodeV1, message: string) {
    super(message);
    this.name = "FastManimGatedOciError";
    this.code = code;
  }
}

function sameArray(value: unknown, expected: readonly string[]) {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

function containsRequiredStrings(value: unknown, required: readonly string[]) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length &&
    required.every((entry) => value.includes(entry))
  );
}

function sameUlimits(value: unknown) {
  return (
    Array.isArray(value) &&
    value.length === FIXED_ULIMITS.length &&
    FIXED_ULIMITS.every(
      (expected, index) =>
        (value[index] as { Hard?: unknown } | undefined)?.Hard === expected.hard &&
        (value[index] as { Name?: unknown } | undefined)?.Name === expected.name &&
        (value[index] as { Soft?: unknown } | undefined)?.Soft === expected.soft,
    )
  );
}

function sameSecurityOptions(value: unknown) {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== "no-new-privileges=true") return false;
  const seccomp = value[1];
  if (typeof seccomp !== "string" || !seccomp.startsWith("seccomp=")) return false;
  try {
    const parsed = JSON.parse(seccomp.slice("seccomp=".length)) as unknown;
    return (
      createHash("sha256").update(canonicalJsonV1(parsed), "utf8").digest("hex") ===
      FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1
    );
  } catch {
    return false;
  }
}

function exactStringMap(entries: unknown) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry.includes("=")))
    return null;
  const result: Record<string, string> = {};
  for (const entry of entries as string[]) {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    if (Object.hasOwn(result, key)) return null;
    result[key] = entry.slice(separator + 1);
  }
  return result;
}

function exactObject(value: unknown, expected: Readonly<Record<string, string>>) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = Object.keys(expected).sort();
  return sameArray(keys, expectedKeys) && keys.every((key) => candidate[key] === expected[key]);
}

function hasJsonWhitespaceOutsideStrings(bytes: Uint8Array) {
  let escaped = false;
  let inString = false;
  for (const byte of bytes) {
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
    } else if (byte === 0x22) inString = true;
    else if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) return true;
  }
  return false;
}

function rejectResult(message: string): never {
  throw new FastManimGatedOciError("sandbox-result-rejected", message);
}

function compareUnicodeCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index]! !== rightPoints[index]!) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function pythonCanonicalJsonString(value: string) {
  let result = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === '"' || character === "\\") result += `\\${character}`;
    else if (character === "\b") result += "\\b";
    else if (character === "\f") result += "\\f";
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (codePoint < 0x20) result += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    else result += character;
  }
  return `${result}"`;
}

class PythonCanonicalJsonReader {
  readonly #text: string;
  #entries = 0;
  #offset = 0;
  #values = 0;

  constructor(text: string) {
    this.#text = text;
  }

  readObjectDocument() {
    if (this.#text[0] !== "{") rejectResult("The gated OCI result is not a JSON object.");
    this.#readObject(0);
    if (this.#offset !== this.#text.length) rejectResult("The gated OCI result has trailing JSON bytes.");
  }

  #readValue(depth: number) {
    if (depth > MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH) {
      rejectResult("The gated OCI result exceeds its JSON nesting budget.");
    }
    this.#values += 1;
    if (this.#values > MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_VALUES) {
      rejectResult("The gated OCI result exceeds its JSON value budget.");
    }
    const character = this.#text[this.#offset];
    if (character === "{") this.#readObject(depth);
    else if (character === "[") this.#readArray(depth);
    else if (character === '"') this.#readString();
    else if (character === "t") this.#readLiteral("true");
    else if (character === "f") this.#readLiteral("false");
    else if (character === "n") this.#readLiteral("null");
    else this.#readNumber();
  }

  #readObject(depth: number) {
    this.#expect("{");
    if (this.#text[this.#offset] === "}") {
      this.#offset += 1;
      return;
    }
    let previousKey: string | undefined;
    let fields = 0;
    while (true) {
      const key = this.#readString();
      fields += 1;
      if (fields > MAX_FAST_MANIM_SNAPSHOT_OBJECT_FIELDS) {
        rejectResult("The gated OCI result object exceeds its field budget.");
      }
      this.#addEntry();
      if (previousKey !== undefined && compareUnicodeCodePoints(previousKey, key) >= 0) {
        rejectResult("The gated OCI result object keys are not unique and sorted.");
      }
      previousKey = key;
      this.#expect(":");
      this.#readValue(depth + 1);
      if (this.#text[this.#offset] === "}") {
        this.#offset += 1;
        return;
      }
      this.#expect(",");
    }
  }

  #readArray(depth: number) {
    this.#expect("[");
    if (this.#text[this.#offset] === "]") {
      this.#offset += 1;
      return;
    }
    let items = 0;
    while (true) {
      items += 1;
      if (items > MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS) {
        rejectResult("The gated OCI result array exceeds its item budget.");
      }
      this.#addEntry();
      this.#readValue(depth + 1);
      if (this.#text[this.#offset] === "]") {
        this.#offset += 1;
        return;
      }
      this.#expect(",");
    }
  }

  #readString() {
    const start = this.#offset;
    this.#expect('"');
    let escaped = false;
    while (this.#offset < this.#text.length) {
      const character = this.#text[this.#offset]!;
      this.#offset += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        const raw = this.#text.slice(start, this.#offset);
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          rejectResult("The gated OCI result contains a malformed JSON string.");
        }
        if (typeof value !== "string" || pythonCanonicalJsonString(value) !== raw) {
          rejectResult("The gated OCI result contains a non-canonical JSON string.");
        }
        return value;
      }
      if (character.charCodeAt(0) < 0x20) rejectResult("The gated OCI result contains a raw control character.");
    }
    rejectResult("The gated OCI result contains an unterminated JSON string.");
  }

  #readLiteral(expected: "true" | "false" | "null") {
    if (!this.#text.startsWith(expected, this.#offset)) rejectResult("The gated OCI result contains invalid JSON.");
    this.#offset += expected.length;
  }

  #readNumber() {
    const start = this.#offset;
    while (/[+\-.0-9Ee]/.test(this.#text[this.#offset] ?? "")) this.#offset += 1;
    const raw = this.#text.slice(start, this.#offset);
    const jsonNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]\d+)?$/;
    let expected: string | undefined;
    if (jsonNumber.test(raw) && !raw.includes(".") && !raw.includes("e")) {
      try {
        expected = BigInt(raw).toString(10);
      } catch {
        expected = undefined;
      }
    } else if (jsonNumber.test(raw)) {
      const value = Number(raw);
      const magnitude = Math.abs(value);
      const scientific = magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16);
      if (Number.isFinite(value) && scientific && raw.includes("e")) {
        const [mantissa, exponent = ""] = value.toExponential().split("e");
        const sign = exponent[0];
        const digits = exponent.slice(1);
        if ((sign === "+" || sign === "-") && /^\d+$/.test(digits)) {
          expected = `${mantissa}e${sign}${digits.padStart(2, "0")}`;
        }
      } else if (Number.isFinite(value) && !scientific && !raw.includes("e")) {
        if (Object.is(value, -0)) expected = "-0.0";
        else {
          const shortest = value.toString();
          if (!shortest.includes("e")) expected = shortest.includes(".") ? shortest : `${shortest}.0`;
        }
      }
    }
    if (raw !== expected) {
      rejectResult("The gated OCI result contains a non-canonical JSON number.");
    }
  }

  #addEntry() {
    this.#entries += 1;
    if (this.#entries > MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_ENTRIES) {
      rejectResult("The gated OCI result exceeds its JSON container-entry budget.");
    }
  }

  #expect(expected: string) {
    if (this.#text[this.#offset] !== expected) rejectResult("The gated OCI result contains invalid JSON framing.");
    this.#offset += 1;
  }
}

export function parseFastManimGatedOciResultV1(bytes: Uint8Array) {
  const stdout = Buffer.from(bytes);
  if (stdout.byteLength > MAX_FAST_MANIM_PROFILE_SELECTION_RESULT_JSON_BYTES) {
    throw new FastManimGatedOciError("producer-output-overflow", "The gated OCI result exceeded its byte budget.");
  }
  if (stdout.byteLength === 0 || stdout.at(-1) !== 0x0a) {
    rejectResult("The gated OCI result is not LF-terminated.");
  }
  const body = stdout.subarray(0, -1);
  if (
    body.byteLength > MAX_FAST_MANIM_PROFILE_SELECTION_RESULT_JSON_BYTES - 1 ||
    body.at(0) !== 0x7b ||
    body.at(-1) !== 0x7d ||
    hasJsonWhitespaceOutsideStrings(body)
  ) {
    rejectResult("The gated OCI result is not one bounded JSON line.");
  }
  let bodyText: string;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    rejectResult("The gated OCI result is not UTF-8.");
  }
  if (!Buffer.from(bodyText, "utf8").equals(body)) rejectResult("The gated OCI result is not canonical UTF-8.");
  new PythonCanonicalJsonReader(bodyText).readObjectDocument();
  return Uint8Array.from(body);
}

function docker(
  arguments_: readonly string[],
  timeoutMs = DOCKER_CONTROL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<FastManimGatedOciDockerResultV1> {
  signal?.throwIfAborted();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(DOCKER, arguments_, { env: DOCKER_ENVIRONMENT, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(1, timeoutMs));
    timer.unref();
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= 256 * 1024) target.push(chunk);
      else child.kill("SIGKILL");
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectRun(signal?.aborted ? abortError() : error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) rejectRun(abortError());
      else resolveRun({ code: code ?? 1, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) });
    });
  });
}

export function parseFastManimGatedOciSingleInspectionV1(raw: Buffer): FastManimGatedOciContainerInspectionV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new FastManimGatedOciError("sandbox-execution-failed", "Docker returned malformed inspection JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new FastManimGatedOciError("sandbox-execution-failed", "Docker returned an unexpected inspection shape.");
  }
  return parsed[0] as FastManimGatedOciContainerInspectionV1;
}

function assertFixedContainer(
  inspection: FastManimGatedOciContainerInspectionV1,
  image: string,
  containerId: string,
  containerName: string,
  running: boolean,
) {
  const config = inspection.Config;
  const host = inspection.HostConfig;
  const environment = exactStringMap(config?.Env);
  const tmpfs = host?.Tmpfs as Record<string, unknown> | undefined;
  const ulimits = host?.Ulimits;
  const labels = config?.Labels;
  const valid =
    inspection.Id === containerId &&
    inspection.Image === image &&
    inspection.Name === `/${containerName}` &&
    config?.Image === image &&
    sameArray(config?.Entrypoint, FIXED_ENTRYPOINT) &&
    sameArray(config?.Cmd, FIXED_TARGET) &&
    config?.User === FAST_MANIM_GATED_OCI_PROFILE_V1.user &&
    config?.WorkingDir === FAST_MANIM_GATED_OCI_PROFILE_V1.workingDirectory &&
    config?.OpenStdin === true &&
    config?.StdinOnce === true &&
    config?.StopTimeout === FAST_MANIM_GATED_OCI_PROFILE_V1.stopTimeoutSeconds &&
    config?.Tty === false &&
    environment !== null &&
    exactObject(environment, FIXED_ENVIRONMENT) &&
    typeof labels === "object" &&
    labels !== null &&
    Object.entries(FAST_MANIM_GATED_OCI_PROFILE_V1.requiredContainerLabels).every(
      ([key, value]) => (labels as Record<string, unknown>)[key] === value,
    ) &&
    host?.ReadonlyRootfs === FAST_MANIM_GATED_OCI_PROFILE_V1.readOnlyRootfs &&
    host?.Privileged === FAST_MANIM_GATED_OCI_PROFILE_V1.privileged &&
    host?.AutoRemove === FAST_MANIM_GATED_OCI_PROFILE_V1.autoRemove &&
    host?.NetworkMode === FAST_MANIM_GATED_OCI_PROFILE_V1.network &&
    // Docker only accepts host/container PID modes explicitly. Its empty
    // inspected mode is the fixed private PID namespace default.
    host?.PidMode === "" &&
    host?.IpcMode === FAST_MANIM_GATED_OCI_PROFILE_V1.ipc &&
    host?.CgroupnsMode === FAST_MANIM_GATED_OCI_PROFILE_V1.cgroupNamespace &&
    sameArray(host?.CapDrop, FAST_MANIM_GATED_OCI_PROFILE_V1.capabilitiesDropped) &&
    (host?.CapAdd === null || sameArray(host?.CapAdd, FAST_MANIM_GATED_OCI_PROFILE_V1.capabilitiesAdded)) &&
    sameSecurityOptions(host?.SecurityOpt) &&
    host?.ShmSize === FAST_MANIM_GATED_OCI_PROFILE_V1.shmBytes &&
    host?.PidsLimit === FAST_MANIM_GATED_OCI_PROFILE_V1.pidsLimit &&
    host?.Memory === FAST_MANIM_GATED_OCI_PROFILE_V1.memoryBytes &&
    host?.MemorySwap === FAST_MANIM_GATED_OCI_PROFILE_V1.memorySwapBytes &&
    host?.NanoCpus === FAST_MANIM_GATED_OCI_PROFILE_V1.cpuNanoSeconds &&
    typeof host?.LogConfig === "object" &&
    host.LogConfig !== null &&
    (host.LogConfig as { Type?: unknown }).Type === "none" &&
    exactObject((host.LogConfig as { Config?: unknown }).Config, {}) &&
    (host?.Binds === null || sameArray(host?.Binds, FAST_MANIM_GATED_OCI_PROFILE_V1.binds)) &&
    sameArray(host?.Devices, FAST_MANIM_GATED_OCI_PROFILE_V1.devices) &&
    sameArray(inspection.Mounts, FAST_MANIM_GATED_OCI_PROFILE_V1.mounts) &&
    containsRequiredStrings(host?.MaskedPaths, FAST_MANIM_GATED_OCI_PROFILE_V1.requiredMaskedSystemPaths) &&
    containsRequiredStrings(host?.ReadonlyPaths, FAST_MANIM_GATED_OCI_PROFILE_V1.requiredReadOnlySystemPaths) &&
    typeof tmpfs === "object" &&
    tmpfs !== null &&
    Object.keys(tmpfs).length === 1 &&
    typeof tmpfs[FIXED_TMPFS_PATH] === "string" &&
    tmpfs[FIXED_TMPFS_PATH].split(",").sort().join(",") === FIXED_TMPFS_OPTIONS.toSorted().join(",") &&
    sameUlimits(ulimits) &&
    inspection.State?.Running === running;
  if (!valid) throw new FastManimGatedOciError("sandbox-execution-failed", "The OCI job configuration drifted.");
}

async function inspectContainer(
  containerId: string,
  timeoutMs = DOCKER_CONTROL_TIMEOUT_MS,
  signal?: AbortSignal,
  dockerClient = defaultDockerClient,
) {
  const inspected = await dockerClient.run(["container", "inspect", containerId], timeoutMs, signal);
  if (inspected.code !== 0) {
    throw new FastManimGatedOciError("sandbox-execution-failed", "Docker could not inspect the OCI job.");
  }
  return parseFastManimGatedOciSingleInspectionV1(inspected.stdout);
}

async function assertTrustedImage(
  image: string,
  timeoutMs = DOCKER_CONTROL_TIMEOUT_MS,
  signal?: AbortSignal,
  dockerClient = defaultDockerClient,
) {
  const inspected = await dockerClient.run(["image", "inspect", image], timeoutMs, signal);
  if (inspected.code !== 0) throw new Error("The immutable local OCI image is unavailable.");
  const imageInspection = parseFastManimGatedOciSingleInspectionV1(inspected.stdout);
  const labels = imageInspection.Config?.Labels;
  if (
    imageInspection.Id !== image ||
    !sameArray(imageInspection.Config?.Entrypoint, FIXED_ENTRYPOINT) ||
    !sameArray(imageInspection.Config?.Cmd, FIXED_TARGET) ||
    typeof labels !== "object" ||
    labels === null ||
    !Object.entries(LOCKED_LABELS).every(([key, value]) => (labels as Record<string, unknown>)[key] === value)
  ) {
    throw new Error("The immutable local OCI image does not match the gated slice.");
  }
}

export async function assertFastManimGatedOciImageV1(
  image: string,
  dockerClient: FastManimGatedOciDockerClientV1,
  deadlineEpochMs: number,
  signal: AbortSignal,
) {
  if (!IMAGE_ID.test(image)) throw new TypeError("The gated OCI image must be an immutable sha256 image ID.");
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= Date.now()) {
    throw new TypeError("The gated OCI image probe deadline must be in the future.");
  }
  await assertTrustedImage(
    image,
    Math.min(DOCKER_CONTROL_TIMEOUT_MS, Math.max(1, deadlineEpochMs - Date.now())),
    signal,
    dockerClient,
  );
}

function encodeRequestWire(requestBytes: Uint8Array) {
  if (requestBytes.byteLength > MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES)
    throw new TypeError("Request bytes exceed the gate budget.");
  const header = Buffer.alloc(GATE_HEADER_BYTES);
  GATE_MAGIC.copy(header, 0);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(requestBytes.byteLength, 12);
  Buffer.from(createHash("sha256").update(requestBytes).digest()).copy(header, 16);
  return Buffer.concat([header, Buffer.from(requestBytes)]);
}

export type FastManimGatedOciCgroupKillPolicyV1 = "best-effort" | "required";
export type FastManimGatedOciRunningIdentityV1 = Readonly<{
  cgroup: string;
  cgroupPath: string;
  containerId: string;
  pid: number;
  startTime: string;
}>;

async function inspectRunningProcess(
  containerId: string,
  containerName: string,
  image: string,
  timeoutMs: number,
  signal: AbortSignal,
  dockerClient: FastManimGatedOciDockerClientV1,
): Promise<number> {
  const inspection = await inspectContainer(containerId, timeoutMs, signal, dockerClient);
  assertFixedContainer(inspection, image, containerId, containerName, true);
  const pid = inspection.State?.Pid;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 1) {
    throw new FastManimGatedOciError("sandbox-execution-failed", "Docker did not expose a running container PID.");
  }
  return pid as number;
}

export async function readFastManimGatedOciProcessStartTimeV1(pid: number) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  const fieldsAfterCommand =
    commandEnd < 0
      ? []
      : stat
          .slice(commandEnd + 1)
          .trim()
          .split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new FastManimGatedOciError("sandbox-execution-failed", "The OCI PID start time is unavailable.");
  }
  return startTime;
}

export async function inspectFastManimGatedOciRunningCgroupV1(
  containerId: string,
  pid: number,
  startTime: string,
): Promise<FastManimGatedOciRunningIdentityV1> {
  const cgroup = await readFile(`/proc/${pid}/cgroup`, "utf8");
  if ((await readFastManimGatedOciProcessStartTimeV1(pid)) !== startTime) {
    throw new FastManimGatedOciError("sandbox-execution-failed", "The OCI PID changed during inspection.");
  }
  const lines = cgroup.trimEnd().split("\n");
  if (lines.length !== 1 || !lines[0]?.startsWith("0::/") || !lines[0].includes(containerId)) {
    throw new FastManimGatedOciError("sandbox-execution-failed", "The OCI PID is outside its expected cgroup v2.");
  }
  const cgroupPath = resolve("/sys/fs/cgroup", `.${lines[0].slice(3)}`);
  if (!cgroupPath.startsWith("/sys/fs/cgroup/")) {
    throw new FastManimGatedOciError("sandbox-execution-failed", "The OCI cgroup path is not canonical.");
  }
  return { cgroup, cgroupPath, containerId, pid, startTime };
}

export async function inspectFastManimGatedOciRunningResourcesV1(identity: FastManimGatedOciRunningIdentityV1) {
  const { cgroup, cgroupPath, containerId, pid } = identity;
  const [cpuMax, memoryMax, memorySwapMax, pidsMax, limits, currentStartTime] = await Promise.all([
    ...["cpu.max", "memory.max", "memory.swap.max", "pids.max"].map((name) =>
      readFile(resolve(cgroupPath, name), "utf8"),
    ),
    readFile(`/proc/${pid}/limits`, "utf8"),
    readFastManimGatedOciProcessStartTimeV1(pid),
  ]);
  const resources = {
    cpuMax: cpuMax.trim(),
    memoryMax: memoryMax.trim(),
    memorySwapMax: memorySwapMax.trim(),
    pidsMax: pidsMax.trim(),
  };
  const [quota, period] = resources.cpuMax.split(" ").map(Number);
  if (
    resources.memoryMax !== String(MEMORY_BYTES) ||
    resources.memorySwapMax !== "0" ||
    resources.pidsMax !== String(PIDS_LIMIT) ||
    !Number.isSafeInteger(quota) ||
    !Number.isSafeInteger(period) ||
    quota !== period ||
    currentStartTime !== identity.startTime ||
    !/^Max open files\s+256\s+256\s+files\s*$/m.test(limits) ||
    !/^Max core file size\s+0\s+0\s+bytes\s*$/m.test(limits)
  ) {
    throw new FastManimGatedOciError("sandbox-execution-failed", "The OCI cgroup resources drifted.");
  }
  return { cgroup, containerId, pid, resources } satisfies FastManimGatedOciEvidenceV1;
}

function cleanupFailure(): never {
  throw new FastManimSandboxBackendControlError("cleanup");
}

function isMissingPath(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function cgroupIsPopulated(value: string) {
  const entries = value
    .trimEnd()
    .split("\n")
    .map((line) => line.split(" "));
  if (entries.some((entry) => entry.length !== 2) || new Set(entries.map(([key]) => key)).size !== entries.length) {
    return cleanupFailure();
  }
  const populated = entries.find(([key]) => key === "populated")?.[1];
  if (populated !== "0" && populated !== "1") return cleanupFailure();
  return populated === "1";
}

async function readCgroupPopulated(cgroupPath: string) {
  try {
    return cgroupIsPopulated(await readFile(resolve(cgroupPath, "cgroup.events"), "ascii"));
  } catch (error) {
    if (isMissingPath(error)) return false;
    return cleanupFailure();
  }
}

async function requestCgroupKill(
  evidence: FastManimGatedOciRunningIdentityV1,
  policy: FastManimGatedOciCgroupKillPolicyV1,
) {
  if (!(await readCgroupPopulated(evidence.cgroupPath))) return;
  try {
    await writeFile(resolve(evidence.cgroupPath, "cgroup.kill"), "1", "ascii");
    return;
  } catch {
    // A cgroup which disappeared or was already empty needs no signal. Local
    // rootful conformance may lack write access; it still has to prove empty
    // after Docker cleanup, while production requires this write to succeed.
    if (!(await readCgroupPopulated(evidence.cgroupPath))) return;
    if (policy === "best-effort") return;
    return cleanupFailure();
  }
}

async function waitForCgroupCleanup(evidence: FastManimGatedOciRunningIdentityV1) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await readCgroupPopulated(evidence.cgroupPath))) return;
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, CLEANUP_POLL_MS));
  }
  return cleanupFailure();
}

async function assertContainerAbsent(containerId: string, dockerClient = defaultDockerClient) {
  const listed = await dockerClient.run(
    ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `id=${containerId}`],
    CLEANUP_TIMEOUT_MS,
  );
  if (listed.code !== 0 || listed.stdout.toString("ascii").trim() !== "") {
    throw new FastManimSandboxBackendControlError("cleanup");
  }
}

export async function cleanupFastManimGatedOciContainerV1(
  containerId: string,
  evidence: FastManimGatedOciRunningIdentityV1 | undefined,
  dockerClient = defaultDockerClient,
  cgroupKillPolicy: FastManimGatedOciCgroupKillPolicyV1 = "best-effort",
) {
  let failed = false;
  if (evidence) {
    try {
      await requestCgroupKill(evidence, cgroupKillPolicy);
    } catch {
      failed = true;
    }
  }
  await dockerClient.run(["container", "kill", containerId], CLEANUP_TIMEOUT_MS).catch(() => undefined);
  await dockerClient.run(["container", "rm", "--force", containerId], CLEANUP_TIMEOUT_MS).catch(() => undefined);
  try {
    await Promise.all([
      assertContainerAbsent(containerId, dockerClient),
      evidence ? waitForCgroupCleanup(evidence) : Promise.resolve(),
    ]);
  } catch {
    failed = true;
  }
  if (failed) return cleanupFailure();
}

async function cleanupContainerByName(containerName: string, dockerClient = defaultDockerClient) {
  if (!CONTAINER_NAME.test(containerName)) throw new FastManimSandboxBackendControlError("cleanup");
  const listed = await dockerClient.run(
    ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${containerName}$`],
    CLEANUP_TIMEOUT_MS,
  );
  const matches = listed.stdout.toString("ascii").trim().split("\n").filter(Boolean);
  if (listed.code !== 0 || matches.some((value) => !CONTAINER_ID.test(value)) || matches.length > 1) {
    throw new FastManimSandboxBackendControlError("cleanup");
  }
  if (matches[0]) await cleanupFastManimGatedOciContainerV1(matches[0], undefined, dockerClient);
}

/** Removes every job owned by this broker profile before the UDS listener becomes ready. */
export async function reconcileFastManimGatedOciDockerOrphansV1(
  options: Readonly<{
    cgroupKillPolicy: FastManimGatedOciCgroupKillPolicyV1;
    dockerClient: FastManimGatedOciDockerClientV1;
    image: string;
    seccompPath: string;
    signal: AbortSignal;
  }>,
) {
  if (!IMAGE_ID.test(options.image)) throw new TypeError("Orphan reconciliation requires an immutable image ID.");
  options.signal.throwIfAborted();
  let cleanupFailed = false;
  let seccompPath: string | undefined;
  try {
    seccompPath = await assertFastManimGatedOciSeccompV1(options.seccompPath);
  } catch {
    // Trust drift must never prevent best-effort reap of label-owned jobs.
    cleanupFailed = true;
  }
  try {
    await assertTrustedImage(options.image, DOCKER_CONTROL_TIMEOUT_MS, options.signal, options.dockerClient);
  } catch {
    cleanupFailed = true;
  }
  const listed = await options.dockerClient.run(
    ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `label=${JOB_LABEL}`],
    DOCKER_CONTROL_TIMEOUT_MS,
    options.signal,
  );
  const containerIds = listed.stdout.toString("ascii").trim().split("\n").filter(Boolean);
  if (
    listed.code !== 0 ||
    containerIds.length > 128 ||
    new Set(containerIds).size !== containerIds.length ||
    containerIds.some((containerId) => !CONTAINER_ID.test(containerId))
  ) {
    throw new FastManimSandboxBackendControlError("cleanup");
  }
  for (const containerId of containerIds) {
    let cleanupEvidence: FastManimGatedOciRunningIdentityV1 | undefined;
    let inspectionValid = false;
    let running = false;
    try {
      const inspection = await inspectContainer(
        containerId,
        DOCKER_CONTROL_TIMEOUT_MS,
        options.signal,
        options.dockerClient,
      );
      const containerName = typeof inspection.Name === "string" ? inspection.Name.replace(/^\//, "") : "";
      const labels = inspection.Config?.Labels as Record<string, unknown> | undefined;
      if (
        inspection.Id !== containerId ||
        !CONTAINER_NAME.test(containerName) ||
        labels?.[JOB_LABEL_KEY] !== JOB_LABEL_VALUE ||
        typeof inspection.State?.Running !== "boolean"
      ) {
        throw new Error();
      }
      running = inspection.State.Running;
      if (running) {
        const pid = inspection.State.Pid;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 1) throw new Error();
        const startTime = await readFastManimGatedOciProcessStartTimeV1(pid as number);
        cleanupEvidence = await inspectFastManimGatedOciRunningCgroupV1(containerId, pid as number, startTime);
      }
      if (!seccompPath) throw new Error();
      assertFixedContainer(inspection, options.image, containerId, containerName, running);
      inspectionValid = true;
    } catch {
      // Still remove label-owned drifted jobs, while keeping readiness failed.
    }
    if (!inspectionValid) cleanupFailed = true;
    // A stopped orphan has no trustworthy PID/cgroup identity. Remove it, but
    // require one clean restart before readiness rather than equating leader
    // exit with proof that every descendant is gone.
    if (!cleanupEvidence) cleanupFailed = true;
    try {
      await cleanupFastManimGatedOciContainerV1(
        containerId,
        cleanupEvidence,
        options.dockerClient,
        options.cgroupKillPolicy,
      );
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) throw new FastManimSandboxBackendControlError("cleanup");
}

export type FastManimGatedOciAttachExitV1 = Readonly<{ code: number; signal: NodeJS.Signals | null }>;

export async function reapFastManimGatedOciAttachedDockerClientV1(
  child: ChildProcessWithoutNullStreams,
  close: Promise<FastManimGatedOciAttachExitV1>,
) {
  child.stdin.destroy();
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The bounded close observation below is authoritative.
    }
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new FastManimSandboxBackendControlError("cleanup")), CLEANUP_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
  } catch {
    return cleanupFailure();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type FastManimGatedOciConformanceWireV1 = Readonly<{ bytes: Uint8Array; close: boolean }>;
type FastManimGatedOciCreateUncertainTestSeamV1 = Readonly<{
  assertTrustedImage: typeof assertTrustedImage;
  createContainer: typeof docker;
  recoverContainerByName: typeof cleanupContainerByName;
}>;

/** Fixed-profile OCI job driver shared by the local conformance and production broker adapters. */
export async function runFastManimGatedOciJobV1(
  options: Readonly<{
    /** Deterministic late-halt seam for real OCI conformance tests; the configured backend never supplies it. */
    afterVerifiedCleanupForTesting?: () => void;
    conformanceWire?: FastManimGatedOciConformanceWireV1;
    /** Deterministic unresolved-create seam for unit tests; the configured backend never supplies it. */
    createUncertainTestSeam?: FastManimGatedOciCreateUncertainTestSeamV1;
    cgroupKillPolicy?: FastManimGatedOciCgroupKillPolicyV1;
    deadlineEpochMs: number;
    dockerClient?: FastManimGatedOciDockerClientV1;
    image: string;
    requestBytes: Uint8Array;
    seccompPath?: string;
    signal: AbortSignal;
  }>,
): Promise<FastManimGatedOciExecutionV1> {
  if (!IMAGE_ID.test(options.image)) throw new TypeError("The local OCI image must be an immutable sha256 image ID.");
  if (!Number.isSafeInteger(options.deadlineEpochMs) || options.deadlineEpochMs <= Date.now()) {
    throw new TypeError("The local OCI deadline must be a future epoch millisecond integer.");
  }
  options.signal.throwIfAborted();
  const cgroupKillPolicy = options.cgroupKillPolicy ?? "best-effort";
  if (cgroupKillPolicy !== "best-effort" && cgroupKillPolicy !== "required") {
    throw new TypeError("The gated OCI cgroup.kill policy is invalid.");
  }
  const seccompPath = await assertFastManimGatedOciSeccompV1(options.seccompPath);
  const requestBytes = Uint8Array.from(options.requestBytes);
  const dockerClient = options.dockerClient ?? defaultDockerClient;
  const wire = options.conformanceWire
    ? { bytes: Uint8Array.from(options.conformanceWire.bytes), close: options.conformanceWire.close }
    : { bytes: encodeRequestWire(requestBytes), close: true };
  if (wire.bytes.byteLength > MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES + GATE_HEADER_BYTES + 1) {
    throw new TypeError("The local conformance wire exceeds its bounded request size.");
  }

  const containerName = `poietra-gated-${randomBytes(16).toString("hex")}`;
  const trustedImageCheck =
    options.createUncertainTestSeam?.assertTrustedImage ??
    ((image: string, timeoutMs: number, signal?: AbortSignal) =>
      assertTrustedImage(image, timeoutMs, signal, dockerClient));
  const createContainer =
    options.createUncertainTestSeam?.createContainer ??
    ((arguments_: readonly string[], timeoutMs: number, signal?: AbortSignal) =>
      dockerClient.run(arguments_, timeoutMs, signal));
  const recoverContainerByName =
    options.createUncertainTestSeam?.recoverContainerByName ??
    ((containerName: string) => cleanupContainerByName(containerName, dockerClient));
  const operationController = new AbortController();
  let cleanupEvidence: FastManimGatedOciRunningIdentityV1 | undefined;
  let containerCreationAttempted = false;
  let containerStartAttempted = false;
  let immutableContainerIdObserved = false;
  let containerId: string | undefined;
  let evidence: FastManimGatedOciEvidenceV1 | undefined;
  let attached: ChildProcessWithoutNullStreams | undefined;
  let attachedExit: Promise<FastManimGatedOciAttachExitV1> | undefined;
  let halted: FastManimGatedOciError | undefined;
  let rejectHalt!: (error: FastManimGatedOciError) => void;
  const haltPromise = new Promise<never>((_resolve, reject) => {
    rejectHalt = reject;
  });
  haltPromise.catch(() => undefined);
  const halt = (code: FastManimSandboxBackendFailureCodeV1, message: string) => {
    if (halted) return;
    halted = new FastManimGatedOciError(code, message);
    operationController.abort();
    rejectHalt(halted);
  };
  const throwIfHalted = () => {
    const current = halted as FastManimGatedOciError | undefined;
    if (current) throw current;
  };
  const controlTimeoutMs = () => Math.min(DOCKER_CONTROL_TIMEOUT_MS, Math.max(1, options.deadlineEpochMs - Date.now()));
  const onAbort = () => halt("sandbox-execution-failed", "The local OCI job was aborted.");
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  const timer = setTimeout(
    () => halt("producer-timeout", "The local OCI job exceeded its deadline."),
    options.deadlineEpochMs - Date.now(),
  );
  timer.unref();

  try {
    await trustedImageCheck(options.image, controlTimeoutMs(), operationController.signal);
    throwIfHalted();
    containerCreationAttempted = true;
    const created = await createContainer(
      [
        "container",
        "create",
        `--name=${containerName}`,
        "--interactive",
        ...(FAST_MANIM_GATED_OCI_PROFILE_V1.readOnlyRootfs ? ["--read-only"] : []),
        `--network=${FAST_MANIM_GATED_OCI_PROFILE_V1.network}`,
        `--user=${FAST_MANIM_GATED_OCI_PROFILE_V1.user}`,
        ...FAST_MANIM_GATED_OCI_PROFILE_V1.capabilitiesDropped.map((value) => `--cap-drop=${value}`),
        `--security-opt=no-new-privileges=${String(FAST_MANIM_GATED_OCI_PROFILE_V1.noNewPrivileges)}`,
        `--security-opt=seccomp=${seccompPath}`,
        `--log-driver=${FAST_MANIM_GATED_OCI_PROFILE_V1.logDriver.type}`,
        `--pids-limit=${FAST_MANIM_GATED_OCI_PROFILE_V1.pidsLimit}`,
        `--memory=${FAST_MANIM_GATED_OCI_PROFILE_V1.memoryBytes}`,
        `--memory-swap=${FAST_MANIM_GATED_OCI_PROFILE_V1.memorySwapBytes}`,
        `--cpus=${FAST_MANIM_GATED_OCI_PROFILE_V1.cpuNanoSeconds / 1_000_000_000}`,
        `--ipc=${FAST_MANIM_GATED_OCI_PROFILE_V1.ipc}`,
        `--shm-size=${FAST_MANIM_GATED_OCI_PROFILE_V1.shmBytes}`,
        `--cgroupns=${FAST_MANIM_GATED_OCI_PROFILE_V1.cgroupNamespace}`,
        ...FAST_MANIM_GATED_OCI_PROFILE_V1.ulimits.map((limit) => `--ulimit=${limit.name}=${limit.soft}:${limit.hard}`),
        `--tmpfs=${FAST_MANIM_GATED_OCI_PROFILE_V1.tmpfs.path}:${FAST_MANIM_GATED_OCI_PROFILE_V1.tmpfs.options.join(",")}`,
        `--stop-timeout=${FAST_MANIM_GATED_OCI_PROFILE_V1.stopTimeoutSeconds}`,
        `--label=${JOB_LABEL}`,
        options.image,
      ],
      controlTimeoutMs(),
      operationController.signal,
    );
    const createdId = created.stdout.toString("utf8").trim();
    if (CONTAINER_ID.test(createdId)) {
      containerId = createdId;
      immutableContainerIdObserved = true;
    }
    throwIfHalted();
    if (created.code !== 0 || !containerId) {
      throw new FastManimGatedOciError("producer-spawn-failed", "Docker could not create the gated OCI job.");
    }
    const preStart = await inspectContainer(containerId, controlTimeoutMs(), operationController.signal, dockerClient);
    throwIfHalted();
    assertFixedContainer(preStart, options.image, containerId, containerName, false);

    containerStartAttempted = true;
    attached = dockerClient.attach(["container", "start", "--attach", "--interactive", containerId]);
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let gateResolved = false;
    let resolveGate!: () => void;
    const gatePromise = new Promise<void>((resolveGatePromise) => {
      resolveGate = resolveGatePromise;
    });
    attachedExit = new Promise<FastManimGatedOciAttachExitV1>((resolveExit) => {
      attached!.once("error", () => halt("producer-spawn-failed", "Docker could not attach to the gated OCI job."));
      attached!.once("close", (code, signal) => resolveExit({ code: code ?? 1, signal }));
    });
    attached.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_FAST_MANIM_PROFILE_SELECTION_RESULT_JSON_BYTES) {
        halt("producer-output-overflow", "The gated OCI result exceeded its byte budget.");
        return;
      }
      stdoutChunks.push(chunk);
    });
    attached.stderr.on("data", (chunk: Buffer) => {
      if (stderr.byteLength > MAX_STDERR_BYTES) return;
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.byteLength > MAX_STDERR_BYTES) {
        halt("producer-output-overflow", "The gated OCI diagnostic stream exceeded its byte budget.");
        return;
      }
      if (!gateResolved && stderr.subarray(0, GATE_READY.byteLength).equals(GATE_READY)) {
        gateResolved = true;
        resolveGate();
      }
    });

    await Promise.race([
      gatePromise,
      attachedExit.then(() => {
        throw new FastManimGatedOciError(
          "sandbox-execution-failed",
          "The trusted OCI entrypoint exited before its gate opened.",
        );
      }),
      haltPromise,
    ]);
    const pid = await Promise.race([
      inspectRunningProcess(
        containerId,
        containerName,
        options.image,
        controlTimeoutMs(),
        operationController.signal,
        dockerClient,
      ),
      haltPromise,
    ]);
    const startTime = await Promise.race([readFastManimGatedOciProcessStartTimeV1(pid), haltPromise]);
    const runningIdentity = await Promise.race([
      inspectFastManimGatedOciRunningCgroupV1(containerId, pid, startTime),
      haltPromise,
    ]);
    cleanupEvidence = runningIdentity;
    evidence = await Promise.race([inspectFastManimGatedOciRunningResourcesV1(runningIdentity), haltPromise]);
    attached.stdin.once("error", () => undefined);
    attached.stdin.write(wire.bytes);
    if (wire.close) attached.stdin.end();
    const exit = await Promise.race([attachedExit, haltPromise]);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new FastManimGatedOciError("producer-exit", "The gated OCI producer did not exit cleanly.");
    }
    const body = parseFastManimGatedOciResultV1(Buffer.concat(stdoutChunks, stdoutBytes));
    await cleanupFastManimGatedOciContainerV1(containerId, cleanupEvidence, dockerClient, cgroupKillPolicy);
    options.afterVerifiedCleanupForTesting?.();
    containerId = undefined;
    const lateHalt = halted as FastManimGatedOciError | undefined;
    if (lateHalt) {
      lateHalt.cleanupVerified = true;
      throw lateHalt;
    }
    return { cleanupVerified: true, evidence, resultBytes: Uint8Array.from(body) };
  } catch (error) {
    if (error instanceof FastManimGatedOciError) {
      error.containerId = containerId;
      error.pid = cleanupEvidence?.pid;
    }
    if (containerId) {
      const cleanupUncertain = containerStartAttempted && !cleanupEvidence;
      try {
        await cleanupFastManimGatedOciContainerV1(containerId, cleanupEvidence, dockerClient, cgroupKillPolicy);
        if (cleanupUncertain) cleanupFailure();
        if (error instanceof FastManimGatedOciError) error.cleanupVerified = true;
        containerId = undefined;
      } catch (cleanupError) {
        throw cleanupError instanceof FastManimSandboxBackendControlError
          ? cleanupError
          : new FastManimSandboxBackendControlError("cleanup");
      }
    } else if (containerCreationAttempted && !immutableContainerIdObserved) {
      try {
        await recoverContainerByName(containerName);
      } catch {
        throw new FastManimSandboxBackendControlError("cleanup");
      }
      // The daemon may finish the create RPC after an interrupted client-side
      // name lookup. Without an immutable ID, absence cannot be proven.
      throw new FastManimSandboxBackendControlError("cleanup");
    }
    if (fastManimSandboxBackendControlErrorCode(error) === "cleanup") throw error;
    if (options.signal.aborted) throw abortError();
    const currentHalt = halted as FastManimGatedOciError | undefined;
    if (currentHalt) {
      currentHalt.cleanupVerified = true;
      throw currentHalt;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
    operationController.abort();
    if (attached && attachedExit) await reapFastManimGatedOciAttachedDockerClientV1(attached, attachedExit);
  }
}

export type FastManimGatedOciJobExecutorV1 = typeof runFastManimGatedOciJobV1;

export type FastManimGatedOciJobRunnerOptionsV1 = Readonly<{
  cgroupKillPolicy: FastManimGatedOciCgroupKillPolicyV1;
  dockerClient: FastManimGatedOciDockerClientV1;
  /** Local unit-test seam. Production composition never accepts or forwards it. */
  executeJob?: FastManimGatedOciJobExecutorV1;
  image: string;
  seccompPath?: string;
}>;

/** Shared lifecycle owner for fixed-profile OCI jobs. It makes no trust/readiness claim. */
export class FastManimGatedOciJobRunnerV1 {
  readonly #active = new Set<Readonly<{ abort: () => void; result: Promise<unknown> }>>();
  readonly #dockerClient: FastManimGatedOciDockerClientV1;
  readonly #executeJob: FastManimGatedOciJobExecutorV1;
  readonly #image: string;
  readonly #cgroupKillPolicy: FastManimGatedOciCgroupKillPolicyV1;
  readonly #seccompPath: string | undefined;
  #closeRequest: Promise<void> | undefined;
  #cleanupFailed = false;
  #closing = false;

  constructor(options: FastManimGatedOciJobRunnerOptionsV1) {
    if (!IMAGE_ID.test(options.image))
      throw new TypeError("The gated OCI job runner requires an immutable sha256 image ID.");
    if (!(options.dockerClient instanceof FastManimGatedOciDockerClientV1)) {
      throw new TypeError("The gated OCI job runner requires its concrete Docker client.");
    }
    if (options.cgroupKillPolicy !== "best-effort" && options.cgroupKillPolicy !== "required") {
      throw new TypeError("The gated OCI job runner requires an explicit cgroup.kill policy.");
    }
    this.#cgroupKillPolicy = options.cgroupKillPolicy;
    this.#dockerClient = options.dockerClient;
    this.#executeJob = options.executeJob ?? runFastManimGatedOciJobV1;
    this.#image = options.image;
    this.#seccompPath = options.seccompPath;
  }

  health(): "cleanup-failed" | "closing" | "open" {
    if (this.#cleanupFailed) return "cleanup-failed";
    return this.#closing ? "closing" : "open";
  }

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    parseFastManimSandboxJobIdentityV1(context.identity);
    if (!verifyFastManimSandboxRequestBundleV1(request)) throw new TypeError("Sandbox request bytes are not sealed.");
    context.signal.throwIfAborted();
    if (this.#cleanupFailed) throw new FastManimSandboxBackendControlError("cleanup");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) controller.abort();
    let job!: Readonly<{ abort: () => void; result: Promise<FastManimSandboxBackendResultV1> }>;
    const result = this.#execute(request, context, controller.signal).finally(() => {
      context.signal.removeEventListener("abort", onAbort);
      this.#active.delete(job);
    });
    job = { abort: () => controller.abort(), result };
    this.#active.add(job);
    return job;
  }

  async #execute(
    request: FastManimSandboxRequestBundleV1,
    context: FastManimSandboxJobContextV1,
    signal: AbortSignal,
  ): Promise<FastManimSandboxBackendResultV1> {
    if (this.#closing) throw abortError();
    if (this.#cleanupFailed) throw new FastManimSandboxBackendControlError("cleanup");
    try {
      const execution = await this.#executeJob({
        cgroupKillPolicy: this.#cgroupKillPolicy,
        deadlineEpochMs: context.deadlineEpochMs,
        dockerClient: this.#dockerClient,
        image: this.#image,
        requestBytes: request.copyBytes(),
        ...(this.#seccompPath ? { seccompPath: this.#seccompPath } : {}),
        signal,
      });
      return {
        attestationDigest: context.attestationDigest,
        kind: "ok",
        requestDigest: request.requestDigest,
        resultBytes: execution.resultBytes,
      };
    } catch (error) {
      if (fastManimSandboxBackendControlErrorCode(error) === "cleanup") {
        this.#latchCleanupFailure();
        throw error;
      }
      if (signal.aborted || this.#closing) throw abortError();
      const code = error instanceof FastManimGatedOciError ? error.code : "sandbox-execution-failed";
      return {
        attestationDigest: context.attestationDigest,
        code,
        kind: "failed",
        requestDigest: request.requestDigest,
      };
    }
  }

  #latchCleanupFailure() {
    this.#cleanupFailed = true;
    for (const job of this.#active) job.abort();
  }

  close() {
    this.#closeRequest ??= this.#close();
    return this.#closeRequest;
  }

  async #close() {
    this.#closing = true;
    const active = [...this.#active];
    for (const job of active) job.abort();
    await Promise.allSettled(active.map((job) => job.result));
    if (this.#cleanupFailed) throw new FastManimSandboxBackendControlError("cleanup");
  }
}
