import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1,
  FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
  FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
  FastManimSandboxBackendControlError,
  type FastManimSandboxBackendFailureCodeV1,
  type FastManimSandboxBackendResultV1,
  type FastManimSandboxBackendStatusV1,
  type FastManimSandboxBackendV1,
  type FastManimSandboxDeployment,
  type FastManimSandboxJobContextV1,
  type FastManimSandboxRequestBundleV1,
  type FastManimSandboxStatusContextV1,
  MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES,
  parseFastManimSandboxDeployment,
  parseFastManimSandboxJobIdentityV1,
  UnavailableFastManimSandboxBackendV1,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";
import {
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH,
} from "./fast-manim-snapshot-contract";
import { abortError } from "./fast-manim-snapshot-producer-process";

const DOCKER = "/usr/bin/docker";
const DOCKER_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin" });
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const GATE_READY = Buffer.from("POIETRA_GATE_READY_V1\n", "ascii");
const GATE_MAGIC = Buffer.from("POIETR1\0", "ascii");
const GATE_HEADER_BYTES = 48;
const MAX_STDERR_BYTES = 256 * 1024;
const MEMORY_BYTES = 512 * 1024 * 1024;
const PIDS_LIMIT = 64;
const CPU_NANOSECONDS = 1_000_000_000;
const TMPFS_BYTES = 16 * 1024 * 1024;
const DOCKER_CONTROL_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const FIXED_ENTRYPOINT = ["/opt/venv/bin/python", "/opt/poietra/gated-entrypoint.py"] as const;
const FIXED_TARGET = ["/opt/venv/bin/python", "-m", "manim.renderer.scene_snapshot"] as const;
const LOCKED_LABELS = Object.freeze({
  "io.poietra.fast-manim.archive-sha256": "46f66b6698650988c18327732d1d3c30cccd53b38de91e1059c61187d92c2b61",
  "io.poietra.fast-manim.commit": "ac143dc46ebe314095ae7864a32efa289a0afe96",
  "io.poietra.fast-manim.tree": "b86e2ec81f257cae20669e3c5c33080facfbd610",
  "io.poietra.sandbox-slice": "gated-rootful-development-v1",
});
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
const PROFILE_DIGEST = createHash("sha256")
  .update(
    canonicalJsonV1({
      assets: [],
      cpuNanoSeconds: CPU_NANOSECONDS,
      entrypoint: FIXED_ENTRYPOINT,
      memoryBytes: MEMORY_BYTES,
      pidsLimit: PIDS_LIMIT,
      target: FIXED_TARGET,
      tmpfsBytes: TMPFS_BYTES,
      trust: "rootful-development-only",
    }),
    "utf8",
  )
  .digest("hex");

type DockerResult = Readonly<{ code: number; stderr: Buffer; stdout: Buffer }>;
type ContainerInspection = Readonly<{
  Config?: {
    Cmd?: unknown;
    Entrypoint?: unknown;
    Env?: unknown;
    Image?: unknown;
    Labels?: unknown;
    OpenStdin?: unknown;
    StdinOnce?: unknown;
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
    IpcMode?: unknown;
    LogConfig?: unknown;
    Memory?: unknown;
    MemorySwap?: unknown;
    NanoCpus?: unknown;
    NetworkMode?: unknown;
    PidMode?: unknown;
    PidsLimit?: unknown;
    Privileged?: unknown;
    ReadonlyRootfs?: unknown;
    SecurityOpt?: unknown;
    Tmpfs?: unknown;
    Ulimits?: unknown;
  };
  Id?: unknown;
  Image?: unknown;
  Mounts?: unknown;
  State?: { Pid?: unknown; Running?: unknown };
}>;

export type FastManimLocalGatedOciEvidenceV1 = Readonly<{
  cgroup: string;
  containerId: string;
  pid: number;
  resources: Readonly<{ cpuMax: string; memoryMax: string; memorySwapMax: string; pidsMax: string }>;
}>;

export type FastManimLocalGatedOciExecutionV1 = Readonly<{
  cleanupVerified: true;
  evidence: FastManimLocalGatedOciEvidenceV1;
  resultBytes: Uint8Array;
}>;

export class FastManimLocalGatedOciError extends Error {
  readonly code: FastManimSandboxBackendFailureCodeV1;
  cleanupVerified = false;
  containerId: string | undefined;
  pid: number | undefined;

  constructor(code: FastManimSandboxBackendFailureCodeV1, message: string) {
    super(message);
    this.name = "FastManimLocalGatedOciError";
    this.code = code;
  }
}

function sameArray(value: unknown, expected: readonly string[]) {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
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
  throw new FastManimLocalGatedOciError("sandbox-result-rejected", message);
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
  #offset = 0;

  constructor(text: string) {
    this.#text = text;
  }

  readObjectDocument() {
    if (this.#text[0] !== "{") rejectResult("The gated OCI result is not a JSON object.");
    this.#readObject(1);
    if (this.#offset !== this.#text.length) rejectResult("The gated OCI result has trailing JSON bytes.");
  }

  #readValue(depth: number) {
    if (depth > MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH) {
      rejectResult("The gated OCI result exceeds its JSON nesting budget.");
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
    while (true) {
      const key = this.#readString();
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
    while (true) {
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
    const canonicalNumber = /^-?(?:0|[1-9]\d*)(?:\.(?:0|\d*[1-9]))?(?:e[+-](?:0\d|[1-9]\d+))?$/;
    if (!canonicalNumber.test(raw) || raw === "-0") {
      rejectResult("The gated OCI result contains a non-canonical JSON number.");
    }
  }

  #expect(expected: string) {
    if (this.#text[this.#offset] !== expected) rejectResult("The gated OCI result contains invalid JSON framing.");
    this.#offset += 1;
  }
}

export function parseFastManimLocalGatedOciResultV1(bytes: Uint8Array) {
  const stdout = Buffer.from(bytes);
  if (stdout.byteLength > MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES + 1) {
    throw new FastManimLocalGatedOciError("producer-output-overflow", "The gated OCI result exceeded its byte budget.");
  }
  if (stdout.byteLength === 0 || stdout.at(-1) !== 0x0a) {
    rejectResult("The gated OCI result is not LF-terminated.");
  }
  const body = stdout.subarray(0, -1);
  if (
    body.byteLength > MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES ||
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

function docker(arguments_: readonly string[], timeoutMs = DOCKER_CONTROL_TIMEOUT_MS): Promise<DockerResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(DOCKER, arguments_, { env: DOCKER_ENVIRONMENT, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
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
      rejectRun(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) });
    });
  });
}

function parseSingleInspection(raw: Buffer): ContainerInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new FastManimLocalGatedOciError("sandbox-execution-failed", "Docker returned malformed inspection JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new FastManimLocalGatedOciError(
      "sandbox-execution-failed",
      "Docker returned an unexpected inspection shape.",
    );
  }
  return parsed[0] as ContainerInspection;
}

function assertFixedContainer(inspection: ContainerInspection, image: string, containerId: string, running: boolean) {
  const config = inspection.Config;
  const host = inspection.HostConfig;
  const environment = exactStringMap(config?.Env);
  const tmpfs = host?.Tmpfs as Record<string, unknown> | undefined;
  const ulimits = host?.Ulimits;
  const labels = config?.Labels;
  const valid =
    inspection.Id === containerId &&
    inspection.Image === image &&
    config?.Image === image &&
    sameArray(config?.Entrypoint, FIXED_ENTRYPOINT) &&
    sameArray(config?.Cmd, FIXED_TARGET) &&
    config?.User === "65532:65532" &&
    config?.WorkingDir === "/run/poietra" &&
    config?.OpenStdin === true &&
    config?.StdinOnce === true &&
    config?.Tty === false &&
    environment !== null &&
    exactObject(environment, FIXED_ENVIRONMENT) &&
    typeof labels === "object" &&
    labels !== null &&
    Object.entries(LOCKED_LABELS).every(([key, value]) => (labels as Record<string, unknown>)[key] === value) &&
    host?.ReadonlyRootfs === true &&
    host?.Privileged === false &&
    host?.AutoRemove === false &&
    host?.NetworkMode === "none" &&
    // Docker only accepts host/container PID modes explicitly. Its empty
    // inspected mode is the fixed private PID namespace default.
    host?.PidMode === "" &&
    host?.IpcMode === "none" &&
    host?.CgroupnsMode === "private" &&
    sameArray(host?.CapDrop, ["ALL"]) &&
    (host?.CapAdd === null || (Array.isArray(host?.CapAdd) && host.CapAdd.length === 0)) &&
    sameArray(host?.SecurityOpt, ["no-new-privileges=true"]) &&
    host?.PidsLimit === PIDS_LIMIT &&
    host?.Memory === MEMORY_BYTES &&
    host?.MemorySwap === MEMORY_BYTES &&
    host?.NanoCpus === CPU_NANOSECONDS &&
    typeof host?.LogConfig === "object" &&
    host.LogConfig !== null &&
    (host.LogConfig as { Type?: unknown }).Type === "none" &&
    exactObject((host.LogConfig as { Config?: unknown }).Config, {}) &&
    (host?.Binds === null || (Array.isArray(host?.Binds) && host.Binds.length === 0)) &&
    Array.isArray(host?.Devices) &&
    host.Devices.length === 0 &&
    Array.isArray(inspection.Mounts) &&
    inspection.Mounts.length === 0 &&
    typeof tmpfs === "object" &&
    tmpfs !== null &&
    Object.keys(tmpfs).length === 1 &&
    typeof tmpfs["/run/poietra"] === "string" &&
    tmpfs["/run/poietra"].split(",").sort().join(",") ===
      "gid=65532,mode=0700,nodev,noexec,nosuid,rw,size=16777216,uid=65532".split(",").sort().join(",") &&
    Array.isArray(ulimits) &&
    ulimits.length === 2 &&
    (ulimits[0] as { Hard?: unknown }).Hard === 0 &&
    (ulimits[0] as { Name?: unknown }).Name === "core" &&
    (ulimits[0] as { Soft?: unknown }).Soft === 0 &&
    (ulimits[1] as { Hard?: unknown }).Hard === 256 &&
    (ulimits[1] as { Name?: unknown }).Name === "nofile" &&
    (ulimits[1] as { Soft?: unknown }).Soft === 256 &&
    inspection.State?.Running === running;
  if (!valid) throw new FastManimLocalGatedOciError("sandbox-execution-failed", "The OCI job configuration drifted.");
}

async function inspectContainer(containerId: string) {
  const inspected = await docker(["container", "inspect", containerId]);
  if (inspected.code !== 0) {
    throw new FastManimLocalGatedOciError("sandbox-execution-failed", "Docker could not inspect the OCI job.");
  }
  return parseSingleInspection(inspected.stdout);
}

async function assertTrustedImage(image: string) {
  const inspected = await docker(["image", "inspect", image]);
  if (inspected.code !== 0) throw new Error("The immutable local OCI image is unavailable.");
  const imageInspection = parseSingleInspection(inspected.stdout);
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

async function inspectRunningEvidence(containerId: string, image: string) {
  const inspection = await inspectContainer(containerId);
  assertFixedContainer(inspection, image, containerId, true);
  const pid = inspection.State?.Pid;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 1) {
    throw new FastManimLocalGatedOciError("sandbox-execution-failed", "Docker did not expose a running container PID.");
  }
  const cgroup = await readFile(`/proc/${pid}/cgroup`, "utf8");
  const lines = cgroup.trimEnd().split("\n");
  if (lines.length !== 1 || !lines[0]?.startsWith("0::/") || !lines[0].includes(containerId)) {
    throw new FastManimLocalGatedOciError("sandbox-execution-failed", "The OCI PID is outside its expected cgroup v2.");
  }
  const cgroupPath = resolve("/sys/fs/cgroup", `.${lines[0].slice(3)}`);
  if (!cgroupPath.startsWith("/sys/fs/cgroup/")) {
    throw new FastManimLocalGatedOciError("sandbox-execution-failed", "The OCI cgroup path is not canonical.");
  }
  const [cpuMax, memoryMax, memorySwapMax, pidsMax, limits] = await Promise.all([
    ...["cpu.max", "memory.max", "memory.swap.max", "pids.max"].map((name) =>
      readFile(resolve(cgroupPath, name), "utf8"),
    ),
    readFile(`/proc/${pid}/limits`, "utf8"),
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
    !/^Max open files\s+256\s+256\s+files\s*$/m.test(limits) ||
    !/^Max core file size\s+0\s+0\s+bytes\s*$/m.test(limits)
  ) {
    throw new FastManimLocalGatedOciError("sandbox-execution-failed", "The OCI cgroup resources drifted.");
  }
  return { cgroup, containerId, pid: pid as number, resources } satisfies FastManimLocalGatedOciEvidenceV1;
}

async function waitForPidCleanup(pid: number, cgroup: string) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => null);
    if (current === null || current !== cgroup) return;
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 25));
  }
  throw new Error("The original OCI PID remained alive after container removal.");
}

async function cleanupContainer(containerId: string, evidence?: FastManimLocalGatedOciEvidenceV1) {
  await docker(["container", "kill", containerId], CLEANUP_TIMEOUT_MS).catch(() => undefined);
  const removed = await docker(["container", "rm", "--force", containerId], CLEANUP_TIMEOUT_MS);
  if (removed.code !== 0) throw new FastManimSandboxBackendControlError("cleanup");
  const [inspection] = await Promise.all([
    docker(["container", "inspect", containerId], CLEANUP_TIMEOUT_MS),
    evidence ? waitForPidCleanup(evidence.pid, evidence.cgroup) : Promise.resolve(),
  ]);
  if (inspection.code === 0) throw new FastManimSandboxBackendControlError("cleanup");
}

type LocalConformanceWireV1 = Readonly<{ bytes: Uint8Array; close: boolean }>;

/** Rootful, local-Docker-only driver. `conformanceWire` is deliberately unavailable through the backend class. */
export async function runFastManimLocalGatedOciV1(
  options: Readonly<{
    conformanceWire?: LocalConformanceWireV1;
    deadlineEpochMs: number;
    image: string;
    requestBytes: Uint8Array;
    signal: AbortSignal;
  }>,
): Promise<FastManimLocalGatedOciExecutionV1> {
  if (!IMAGE_ID.test(options.image)) throw new TypeError("The local OCI image must be an immutable sha256 image ID.");
  if (!Number.isSafeInteger(options.deadlineEpochMs) || options.deadlineEpochMs <= Date.now()) {
    throw new TypeError("The local OCI deadline must be a future epoch millisecond integer.");
  }
  options.signal.throwIfAborted();
  const requestBytes = Uint8Array.from(options.requestBytes);
  const wire = options.conformanceWire
    ? { bytes: Uint8Array.from(options.conformanceWire.bytes), close: options.conformanceWire.close }
    : { bytes: encodeRequestWire(requestBytes), close: true };
  if (wire.bytes.byteLength > MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES + GATE_HEADER_BYTES + 1) {
    throw new TypeError("The local conformance wire exceeds its bounded request size.");
  }

  let containerId: string | undefined;
  let evidence: FastManimLocalGatedOciEvidenceV1 | undefined;
  let attached: ChildProcessWithoutNullStreams | undefined;
  let halted: FastManimLocalGatedOciError | undefined;
  let rejectHalt!: (error: FastManimLocalGatedOciError) => void;
  const haltPromise = new Promise<never>((_resolve, reject) => {
    rejectHalt = reject;
  });
  haltPromise.catch(() => undefined);
  const halt = (code: FastManimSandboxBackendFailureCodeV1, message: string) => {
    if (halted) return;
    halted = new FastManimLocalGatedOciError(code, message);
    rejectHalt(halted);
  };
  const onAbort = () => halt("sandbox-execution-failed", "The local OCI job was aborted.");
  options.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => halt("producer-timeout", "The local OCI job exceeded its deadline."),
    options.deadlineEpochMs - Date.now(),
  );
  timer.unref();

  try {
    await assertTrustedImage(options.image);
    const created = await docker([
      "container",
      "create",
      "--interactive",
      "--read-only",
      "--network=none",
      "--user=65532:65532",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges=true",
      "--log-driver=none",
      `--pids-limit=${PIDS_LIMIT}`,
      `--memory=${MEMORY_BYTES}`,
      `--memory-swap=${MEMORY_BYTES}`,
      "--cpus=1",
      "--ipc=none",
      "--cgroupns=private",
      "--ulimit=core=0:0",
      "--ulimit=nofile=256:256",
      `--tmpfs=/run/poietra:rw,noexec,nosuid,nodev,size=${TMPFS_BYTES},mode=0700,uid=65532,gid=65532`,
      "--stop-timeout=1",
      "--label=io.poietra.local-gated-job=v1",
      options.image,
    ]);
    containerId = created.stdout.toString("utf8").trim();
    if (created.code !== 0 || !CONTAINER_ID.test(containerId)) {
      throw new FastManimLocalGatedOciError("producer-spawn-failed", "Docker could not create the gated OCI job.");
    }
    const preStart = await inspectContainer(containerId);
    assertFixedContainer(preStart, options.image, containerId, false);

    attached = spawn(DOCKER, ["container", "start", "--attach", "--interactive", containerId], {
      env: DOCKER_ENVIRONMENT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let gateResolved = false;
    let resolveGate!: () => void;
    const gatePromise = new Promise<void>((resolveGatePromise) => {
      resolveGate = resolveGatePromise;
    });
    const exitPromise = new Promise<Readonly<{ code: number; signal: NodeJS.Signals | null }>>((resolveExit) => {
      attached!.once("error", () => halt("producer-spawn-failed", "Docker could not attach to the gated OCI job."));
      attached!.once("close", (code, signal) => resolveExit({ code: code ?? 1, signal }));
    });
    attached.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES + 1) {
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
      exitPromise.then(() => {
        throw new FastManimLocalGatedOciError(
          "sandbox-execution-failed",
          "The trusted OCI entrypoint exited before its gate opened.",
        );
      }),
      haltPromise,
    ]);
    evidence = await Promise.race([inspectRunningEvidence(containerId, options.image), haltPromise]);
    attached.stdin.once("error", () => undefined);
    attached.stdin.write(wire.bytes);
    if (wire.close) attached.stdin.end();
    const exit = await Promise.race([exitPromise, haltPromise]);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new FastManimLocalGatedOciError("producer-exit", "The gated OCI producer did not exit cleanly.");
    }
    const body = parseFastManimLocalGatedOciResultV1(Buffer.concat(stdoutChunks, stdoutBytes));
    await cleanupContainer(containerId, evidence);
    containerId = undefined;
    return { cleanupVerified: true, evidence, resultBytes: Uint8Array.from(body) };
  } catch (error) {
    if (error instanceof FastManimLocalGatedOciError) {
      error.containerId = containerId;
      error.pid = evidence?.pid;
    }
    if (containerId) {
      try {
        await cleanupContainer(containerId, evidence);
        if (error instanceof FastManimLocalGatedOciError) error.cleanupVerified = true;
        containerId = undefined;
      } catch (cleanupError) {
        throw cleanupError instanceof FastManimSandboxBackendControlError
          ? cleanupError
          : new FastManimSandboxBackendControlError("cleanup");
      }
    }
    if (options.signal.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
    attached?.stdin.destroy();
    if (attached && attached.exitCode === null && attached.signalCode === null) attached.kill("SIGKILL");
  }
}

export type FastManimLocalGatedOciBackendOptionsV1 = Readonly<{ image: string }>;

/** This local Docker backend is conformance/development evidence, never production readiness. */
export class FastManimLocalGatedOciBackendV1 implements FastManimSandboxBackendV1 {
  readonly #active = new Set<Readonly<{ abort: () => void; result: Promise<unknown> }>>();
  readonly #image: string;
  #closing = false;

  constructor(options: FastManimLocalGatedOciBackendOptionsV1) {
    if (!IMAGE_ID.test(options.image))
      throw new TypeError("The local OCI backend requires an immutable sha256 image ID.");
    this.#image = options.image;
  }

  async status(context: FastManimSandboxStatusContextV1): Promise<FastManimSandboxBackendStatusV1> {
    parseFastManimSandboxJobIdentityV1(context.identity);
    if (!Number.isSafeInteger(context.deadlineEpochMs) || context.deadlineEpochMs <= Date.now()) {
      throw new TypeError("Sandbox status deadline must be a future epoch millisecond integer.");
    }
    context.signal.throwIfAborted();
    if (this.#closing) return this.#unavailable("disabled");
    try {
      await assertTrustedImage(this.#image);
      context.signal.throwIfAborted();
    } catch {
      return this.#unavailable("health-check-failed");
    }
    return {
      attestation: { profileDigest: PROFILE_DIGEST, runtimeDigest: this.#image.slice(7), trust: "development-only" },
      backendId: "local-docker-gated-rootful",
      backendKind: "local-process",
      capabilities: [...FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1],
      health: "ready",
      schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
      version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
    };
  }

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    parseFastManimSandboxJobIdentityV1(context.identity);
    if (!verifyFastManimSandboxRequestBundleV1(request)) throw new TypeError("Sandbox request bytes are not sealed.");
    context.signal.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal.addEventListener("abort", onAbort, { once: true });
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
    try {
      const execution = await runFastManimLocalGatedOciV1({
        deadlineEpochMs: context.deadlineEpochMs,
        image: this.#image,
        requestBytes: request.copyBytes(),
        signal,
      });
      return {
        attestationDigest: context.attestationDigest,
        kind: "ok",
        requestDigest: request.requestDigest,
        resultBytes: execution.resultBytes,
      };
    } catch (error) {
      if (signal.aborted || this.#closing) throw abortError();
      const code = error instanceof FastManimLocalGatedOciError ? error.code : "sandbox-execution-failed";
      return {
        attestationDigest: context.attestationDigest,
        code,
        kind: "failed",
        requestDigest: request.requestDigest,
      };
    }
  }

  #unavailable(reason: "disabled" | "health-check-failed"): FastManimSandboxBackendStatusV1 {
    return {
      backendId: "local-docker-gated-rootful",
      backendKind: "local-process",
      capabilities: [],
      health: "unavailable",
      reason,
      schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
      version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
    };
  }

  async close() {
    this.#closing = true;
    const active = [...this.#active];
    for (const job of active) job.abort();
    await Promise.allSettled(active.map((job) => job.result));
  }
}

export function createConfiguredFastManimLocalGatedOciBackendV1(
  options: Readonly<{
    deployment: FastManimSandboxDeployment;
    image: string | undefined;
    localDockerDevOptIn: boolean;
  }>,
): FastManimSandboxBackendV1 {
  const deployment = parseFastManimSandboxDeployment(options.deployment);
  if (deployment === "production" || !options.localDockerDevOptIn || !options.image) {
    return new UnavailableFastManimSandboxBackendV1();
  }
  return new FastManimLocalGatedOciBackendV1({ image: options.image });
}
