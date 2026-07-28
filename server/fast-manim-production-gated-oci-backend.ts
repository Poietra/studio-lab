import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  assertFastManimGatedOciImageV1,
  assertFastManimGatedOciSeccompV1,
  FastManimGatedOciDockerClientV1,
  FastManimGatedOciJobRunnerV1,
  reconcileFastManimGatedOciDockerOrphansV1,
} from "./fast-manim-gated-oci-job-runner";
import {
  FAST_MANIM_PRODUCTION_GATED_OCI_BACKEND_ID_V1,
  VerifiedFastManimGatedOciReleaseV1,
} from "./fast-manim-gated-oci-release";
import {
  FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1,
  FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
  FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
  FastManimSandboxBackendControlError,
  type FastManimSandboxBackendResultV1,
  type FastManimSandboxBackendStatusV1,
  type FastManimSandboxBackendV1,
  type FastManimSandboxJobContextV1,
  type FastManimSandboxRequestBundleV1,
  type FastManimSandboxStatusContextV1,
  parseFastManimSandboxJobIdentityV1,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";

const DOCKER_INFO_MAX_BYTES = 32 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

type RootlessDockerInfoV1 = Readonly<{
  CgroupDriver?: unknown;
  CgroupVersion?: unknown;
  OSType?: unknown;
  SecurityOptions?: unknown;
  ServerVersion?: unknown;
}>;

function abortError() {
  return new DOMException("The production sandbox operation was aborted.", "AbortError");
}

function validateDeadline(deadlineEpochMs: number) {
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= Date.now()) {
    throw new TypeError("The production sandbox deadline must be a future epoch millisecond integer.");
  }
}

function canonicalAbsolutePath(path: string, label: string) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    resolve(path) !== path ||
    path.includes("\0") ||
    Buffer.byteLength(path, "utf8") > 4_096
  ) {
    throw new TypeError(`${label} must be a canonical absolute path.`);
  }
}

async function assertAncestorChain(path: string, allowedOwnerIds: ReadonlySet<number>, privateLeaf: boolean) {
  let current = path;
  let leaf = true;
  while (true) {
    const [metadata, canonical] = await Promise.all([lstat(current), realpath(current)]);
    if (
      canonical !== current ||
      !metadata.isDirectory() ||
      !allowedOwnerIds.has(metadata.uid) ||
      (metadata.mode & (leaf && privateLeaf ? 0o077 : 0o022)) !== 0
    ) {
      throw new TypeError("A production host-material ancestor is mutable or ambiguously owned.");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
    leaf = false;
  }
}

/** Rechecked before readiness and dispatch, closing the seccomp pathname substitution gap. */
export async function assertFastManimProductionHostMaterialsV1(dockerSocketPath: string, seccompPath: string) {
  canonicalAbsolutePath(dockerSocketPath, "Docker socket path");
  canonicalAbsolutePath(seccompPath, "Seccomp profile path");
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === undefined || effectiveUserId === 0) {
    throw new TypeError("The production sandbox broker must run as a non-root user.");
  }
  const [socketMetadata, canonicalSocket, seccompMetadata, canonicalSeccomp] = await Promise.all([
    lstat(dockerSocketPath),
    realpath(dockerSocketPath),
    lstat(seccompPath),
    realpath(seccompPath),
  ]);
  if (
    canonicalSocket !== dockerSocketPath ||
    !socketMetadata.isSocket() ||
    socketMetadata.uid !== effectiveUserId ||
    (socketMetadata.mode & 0o777) !== 0o600 ||
    canonicalSeccomp !== seccompPath ||
    !seccompMetadata.isFile() ||
    seccompMetadata.uid !== 0 ||
    (seccompMetadata.mode & 0o222) !== 0
  ) {
    throw new TypeError("Production Docker or seccomp material is not privately immutable.");
  }
  await Promise.all([
    assertAncestorChain(dirname(dockerSocketPath), new Set([0, effectiveUserId]), true),
    assertAncestorChain(dirname(seccompPath), new Set([0]), false),
  ]);
}

/** Parses only the Docker facts that are part of the signed production contract. */
export function parseFastManimRootlessDockerInfoV1(bytes: Uint8Array, expectedServerVersion: string) {
  if (bytes.byteLength === 0 || bytes.byteLength > DOCKER_INFO_MAX_BYTES) {
    throw new TypeError("The Docker host report is outside its byte budget.");
  }
  let value: RootlessDockerInfoV1;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as RootlessDockerInfoV1;
  } catch {
    throw new TypeError("The Docker host report is malformed.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    value.OSType !== "linux" ||
    value.CgroupVersion !== "2" ||
    value.CgroupDriver !== "systemd" ||
    value.ServerVersion !== expectedServerVersion ||
    !Array.isArray(value.SecurityOptions) ||
    !value.SecurityOptions.every((option) => typeof option === "string") ||
    !value.SecurityOptions.includes("name=rootless")
  ) {
    throw new TypeError("Docker is not the signed rootless cgroup-v2 runtime.");
  }
  return Object.freeze({
    cgroupDriver: "systemd" as const,
    cgroupVersion: "2" as const,
    rootless: true as const,
    serverVersion: expectedServerVersion,
  });
}

export type FastManimProductionGatedOciBackendV1 = FastManimSandboxBackendV1 &
  Readonly<{ reconcileOrphans(signal: AbortSignal): Promise<void> }>;

type ProductionOptions = Readonly<{
  dockerSocketPath: string;
  seccompPath: string;
  verifiedRelease: VerifiedFastManimGatedOciReleaseV1;
}>;

class ProductionGatedOciBackendV1 implements FastManimProductionGatedOciBackendV1 {
  readonly #dockerClient: FastManimGatedOciDockerClientV1;
  readonly #jobs: FastManimGatedOciJobRunnerV1;
  readonly #operations = new Set<Promise<unknown>>();
  readonly #preflights = new Set<AbortController>();
  readonly #release: VerifiedFastManimGatedOciReleaseV1;
  readonly #seccompPath: string;
  #closing = false;

  constructor(options: ProductionOptions) {
    const descriptor = options.verifiedRelease.descriptor();
    this.#release = options.verifiedRelease;
    this.#seccompPath = options.seccompPath;
    this.#dockerClient = new FastManimGatedOciDockerClientV1({ socketPath: options.dockerSocketPath });
    if (!this.#dockerClient.socketPath) throw new TypeError("Production requires an explicit Docker socket.");
    this.#jobs = new FastManimGatedOciJobRunnerV1({
      dockerClient: this.#dockerClient,
      image: descriptor.imageDigest,
      seccompPath: options.seccompPath,
    });
  }

  async #assertRuntime(deadlineEpochMs: number, signal: AbortSignal) {
    validateDeadline(deadlineEpochMs);
    signal.throwIfAborted();
    if (this.#closing || this.#jobs.health() !== "open") throw new FastManimSandboxBackendControlError("cleanup");
    const release = this.#release.descriptor();
    await assertFastManimProductionHostMaterialsV1(this.#dockerClient.socketPath!, this.#seccompPath);
    signal.throwIfAborted();
    const timeoutMs = Math.min(PROBE_TIMEOUT_MS, Math.max(1, deadlineEpochMs - Date.now()));
    const info = await this.#dockerClient.run(["info", "--format", "{{json .}}"], timeoutMs, signal);
    if (info.code !== 0) throw new TypeError("The fixed Docker socket is unavailable.");
    parseFastManimRootlessDockerInfoV1(info.stdout, release.dockerServerVersion);
    await Promise.all([
      assertFastManimGatedOciImageV1(release.imageDigest, this.#dockerClient, deadlineEpochMs, signal),
      assertFastManimGatedOciSeccompV1(this.#seccompPath),
    ]);
    signal.throwIfAborted();
    if (Date.now() >= deadlineEpochMs || this.#closing || this.#jobs.health() !== "open") {
      throw new TypeError("The production runtime probe did not remain current.");
    }
  }

  status(context: FastManimSandboxStatusContextV1): Promise<FastManimSandboxBackendStatusV1> {
    parseFastManimSandboxJobIdentityV1(context.identity);
    validateDeadline(context.deadlineEpochMs);
    context.signal.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal.addEventListener("abort", onAbort, { once: true });
    this.#preflights.add(controller);
    let operation!: Promise<FastManimSandboxBackendStatusV1>;
    operation = this.#status(context, controller.signal).finally(() => {
      context.signal.removeEventListener("abort", onAbort);
      this.#preflights.delete(controller);
      this.#operations.delete(operation);
    });
    this.#operations.add(operation);
    return operation;
  }

  async #status(
    context: FastManimSandboxStatusContextV1,
    signal: AbortSignal,
  ): Promise<FastManimSandboxBackendStatusV1> {
    try {
      await this.#assertRuntime(context.deadlineEpochMs, signal);
      return {
        attestation: this.#release.statusAttestation(),
        backendId: FAST_MANIM_PRODUCTION_GATED_OCI_BACKEND_ID_V1,
        backendKind: "production",
        capabilities: [...FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1],
        health: "ready",
        schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
        version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
      };
    } catch {
      if (signal.aborted || context.signal.aborted || this.#closing) throw abortError();
      return {
        backendId: FAST_MANIM_PRODUCTION_GATED_OCI_BACKEND_ID_V1,
        backendKind: "disabled",
        capabilities: [],
        health: "unavailable",
        reason: "health-check-failed",
        schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
        version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
      };
    }
  }

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    parseFastManimSandboxJobIdentityV1(context.identity);
    validateDeadline(context.deadlineEpochMs);
    if (!verifyFastManimSandboxRequestBundleV1(request)) throw new TypeError("Sandbox request bytes are not sealed.");
    context.signal.throwIfAborted();
    const controller = new AbortController();
    let active: ReturnType<FastManimGatedOciJobRunnerV1["start"]> | undefined;
    const onAbort = () => {
      controller.abort();
      active?.abort();
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    this.#preflights.add(controller);
    let result!: Promise<FastManimSandboxBackendResultV1>;
    result = (async (): Promise<FastManimSandboxBackendResultV1> => {
      try {
        await this.#assertRuntime(context.deadlineEpochMs, controller.signal);
        active = this.#jobs.start(request, { ...context, signal: controller.signal });
        return await active.result;
      } catch (error) {
        if (controller.signal.aborted || context.signal.aborted || this.#closing) throw abortError();
        if (error instanceof FastManimSandboxBackendControlError) throw error;
        return {
          attestationDigest: context.attestationDigest,
          code: "sandbox-unavailable",
          kind: "failed",
          requestDigest: request.requestDigest,
        };
      } finally {
        context.signal.removeEventListener("abort", onAbort);
        this.#preflights.delete(controller);
        this.#operations.delete(result);
      }
    })();
    this.#operations.add(result);
    return { abort: onAbort, result };
  }

  reconcileOrphans(signal: AbortSignal) {
    const release = this.#release.descriptor();
    return reconcileFastManimGatedOciDockerOrphansV1({
      dockerClient: this.#dockerClient,
      image: release.imageDigest,
      seccompPath: this.#seccompPath,
      signal,
    });
  }

  async close() {
    if (!this.#closing) {
      this.#closing = true;
      for (const controller of this.#preflights) controller.abort();
    }
    await Promise.allSettled([...this.#operations]);
    await this.#jobs.close();
  }
}

/** Closed production factory: no executor, Docker-client, or development opt-in seam is accepted. */
export async function createFastManimProductionGatedOciBackendV1(options: ProductionOptions) {
  if (
    !options ||
    Object.keys(options).sort().join(",") !== "dockerSocketPath,seccompPath,verifiedRelease" ||
    typeof options.dockerSocketPath !== "string" ||
    typeof options.seccompPath !== "string" ||
    !(options.verifiedRelease instanceof VerifiedFastManimGatedOciReleaseV1)
  ) {
    throw new TypeError("The production gated OCI backend configuration is invalid.");
  }
  await assertFastManimProductionHostMaterialsV1(options.dockerSocketPath, options.seccompPath);
  const backend = new ProductionGatedOciBackendV1(options);
  const controller = new AbortController();
  const status = await backend.status({
    deadlineEpochMs: Date.now() + PROBE_TIMEOUT_MS,
    identity: { projectId: "production-probe", requestId: "production-probe", tenantId: "production-probe" },
    signal: controller.signal,
  });
  if (status.health !== "ready" || status.backendKind !== "production") {
    await backend.close();
    throw new TypeError("The signed production runtime is not ready.");
  }
  return backend;
}
