import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1,
  FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
  FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
  FastManimSandboxBackendControlError,
  type FastManimSandboxBackendResultV1,
  type FastManimSandboxBackendStatusV1,
  type FastManimSandboxBackendV1,
  type FastManimSandboxDeployment,
  type FastManimSandboxJobContextV1,
  type FastManimSandboxRequestBundleV1,
  type FastManimSandboxStatusContextV1,
  parseFastManimSandboxDeployment,
  parseFastManimSandboxJobIdentityV1,
  UnavailableFastManimSandboxBackendV1,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";
import {
  abortError,
  defaultKillProcessGroup,
  type ProducerGroupKill,
  type ProducerProcessTimings,
  resolveProducerProcessTimings,
  superviseProducerProcess,
} from "./fast-manim-snapshot-producer-process";
import {
  type FastManimSnapshotAdmissionController,
  processAdmissionController,
} from "./fast-manim-snapshot-publication";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import { inspectProjectPngBytesV1, PROJECT_PNG_LOGICAL_PATH_V1 } from "./storage/project-png-storage";

/** Environment variables the explicitly local-only backend may inherit. */
const LOCAL_PROCESS_ENV_ALLOWLIST = ["LANG", "LC_ALL", "LC_CTYPE", "PATH", "TZ", "VIRTUAL_ENV"] as const;
const LOCAL_PROCESS_PRIVATE_DIRECTORY_KEYS = new Set(["HOME", "TEMP", "TMP", "TMPDIR"]);

/** Writes the verified V2 attachment to the one private logical path visible to fast-manim. */
export async function materializeFastManimSandboxPngV2(runtimeDir: string, request: FastManimSandboxRequestBundleV1) {
  const bytes = request.copyPngBytes();
  if (bytes === undefined) return;
  const canonicalRuntimeDir = resolve(runtimeDir);
  if (!isAbsolute(runtimeDir) || canonicalRuntimeDir !== runtimeDir || runtimeDir.includes("\0")) {
    throw new TypeError("The local sandbox runtime directory must be canonical and absolute.");
  }
  const inspected = inspectProjectPngBytesV1(bytes);
  const path = join(canonicalRuntimeDir, PROJECT_PNG_LOGICAL_PATH_V1);
  const descriptor = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await descriptor.writeFile(inspected.bytes);
    await descriptor.sync();
    const metadata = await descriptor.stat();
    if (!metadata.isFile() || metadata.size !== inspected.byteSize) {
      throw new TypeError("The local sandbox image.png materialization is not a bounded regular file.");
    }
  } finally {
    await descriptor.close();
  }
}

export type LocalProcessFastManimSandboxBackendOptions = Readonly<{
  admissionController?: FastManimSnapshotAdmissionController;
  command: readonly string[];
  killProcessGroup?: ProducerGroupKill;
  logger?: StructuredLogger;
  producerEnv?: Readonly<Record<string, string>>;
  producerProcessTimings?: Partial<ProducerProcessTimings>;
  projectRoot: string;
  /** Test seam for proving cleanup-failure behavior without leaking a real directory. */
  runtimeDirectoryRemover?: (runtimeDir: string) => Promise<void>;
}>;

export function createConfiguredFastManimSandboxBackendV1(
  options: Omit<LocalProcessFastManimSandboxBackendOptions, "command"> &
    Readonly<{
      command: readonly string[] | undefined;
      deployment: FastManimSandboxDeployment;
      localProcessDevOptIn: boolean;
    }>,
): FastManimSandboxBackendV1 {
  const deployment = parseFastManimSandboxDeployment(options.deployment);
  if (deployment === "production" && options.localProcessDevOptIn) {
    throw new TypeError("The local-process fast-manim backend is forbidden in production mode.");
  }
  if (!options.localProcessDevOptIn) return new UnavailableFastManimSandboxBackendV1();
  if (!options.command) {
    throw new TypeError("The local-process fast-manim backend opt-in requires an explicit command.");
  }
  return new LocalProcessFastManimSandboxBackendV1({
    admissionController: options.admissionController,
    command: options.command,
    killProcessGroup: options.killProcessGroup,
    logger: options.logger,
    producerEnv: options.producerEnv,
    producerProcessTimings: options.producerProcessTimings,
    projectRoot: options.projectRoot,
    runtimeDirectoryRemover: options.runtimeDirectoryRemover,
  });
}

/**
 * Explicit dev/test-only adapter for the pre-#82 child-process seam. Merely
 * constructing this class does not make it production-capable: status always
 * carries development-only trust and the runner rejects it in production.
 */
export class LocalProcessFastManimSandboxBackendV1 implements FastManimSandboxBackendV1 {
  readonly #activeJobs = new Set<Readonly<{ abort: () => void; result: Promise<unknown> }>>();
  readonly #admissionController: FastManimSnapshotAdmissionController;
  readonly #command: readonly string[];
  readonly #killProcessGroup: ProducerGroupKill;
  readonly #logger: StructuredLogger;
  readonly #producerEnv: Readonly<Record<string, string>>;
  readonly #producerProcessTimings: ProducerProcessTimings;
  readonly #profileDigest: string;
  readonly #runtimeDigest: string;
  readonly #runtimeDirectoryRemover: (runtimeDir: string) => Promise<void>;
  #cleanupFailed = false;
  #closing = false;

  constructor(options: LocalProcessFastManimSandboxBackendOptions) {
    if (options.command.length === 0 || options.command.some((entry) => entry.length === 0)) {
      throw new TypeError("The local fast-manim command must contain a non-empty executable and arguments.");
    }
    const canonicalProjectRoot = resolve(options.projectRoot);
    for (const [key, value] of Object.entries(options.producerEnv ?? {})) {
      const normalizedKey = key.toUpperCase();
      if (LOCAL_PROCESS_PRIVATE_DIRECTORY_KEYS.has(normalizedKey)) {
        throw new TypeError(`The producerEnv ${key} value is reserved for the private runtime directory.`);
      }
      if (normalizedKey === "PYTHONHASHSEED" && value !== "0") {
        throw new TypeError('The producerEnv PYTHONHASHSEED value is pinned to "0" and cannot be overridden.');
      }
      for (const segment of value.split(delimiter)) {
        if (!isAbsolute(segment)) continue;
        const resolved = resolve(segment);
        if (resolved === canonicalProjectRoot || resolved.startsWith(`${canonicalProjectRoot}${sep}`)) {
          throw new TypeError(`The producerEnv value for ${key} must not point into the Manim project root.`);
        }
      }
    }
    this.#admissionController = options.admissionController ?? processAdmissionController;
    this.#command = Object.freeze([...options.command]);
    this.#killProcessGroup = options.killProcessGroup ?? defaultKillProcessGroup;
    this.#logger = options.logger ?? nullLogger;
    this.#producerEnv = Object.freeze({ ...options.producerEnv });
    this.#producerProcessTimings = resolveProducerProcessTimings(options.producerProcessTimings);
    this.#runtimeDirectoryRemover =
      options.runtimeDirectoryRemover ??
      ((runtimeDir) => rm(runtimeDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 }));
    this.#runtimeDigest = createHash("sha256")
      .update(canonicalJsonV1({ command: this.#command, producerEnv: this.#producerEnv }), "utf8")
      .digest("hex");
    this.#profileDigest = createHash("sha256")
      .update(
        canonicalJsonV1({
          capabilities: FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1,
          fixedAssets: [PROJECT_PNG_LOGICAL_PATH_V1],
          processBoundary: "node-child-process-development-only-v1",
          requestEnvelopeVersions: [1, 2, 3],
          timings: this.#producerProcessTimings,
        }),
        "utf8",
      )
      .digest("hex");
  }

  async status(context: FastManimSandboxStatusContextV1): Promise<FastManimSandboxBackendStatusV1> {
    parseFastManimSandboxJobIdentityV1(context.identity);
    if (!Number.isSafeInteger(context.deadlineEpochMs) || context.deadlineEpochMs <= Date.now()) {
      throw new TypeError("Sandbox status deadline must be a future epoch millisecond integer.");
    }
    context.signal.throwIfAborted();
    if (this.#closing || this.#cleanupFailed) {
      return {
        backendId: "local-process-dev",
        backendKind: "local-process",
        capabilities: [],
        health: "unavailable",
        reason: this.#cleanupFailed ? "health-check-failed" : "disabled",
        schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
        version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
      };
    }
    return {
      attestation: {
        profileDigest: this.#profileDigest,
        runtimeDigest: this.#runtimeDigest,
        trust: "development-only",
      },
      backendId: "local-process-dev",
      backendKind: "local-process",
      capabilities: [...FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1],
      health: "ready",
      schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
      version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
    };
  }

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    const identity = parseFastManimSandboxJobIdentityV1(context.identity);
    if (!Number.isSafeInteger(context.deadlineEpochMs) || context.deadlineEpochMs <= 0) {
      throw new TypeError("Sandbox job deadline must be a positive epoch millisecond integer.");
    }
    if (!verifyFastManimSandboxRequestBundleV1(request)) {
      throw new TypeError("Sandbox request bytes do not match their canonical digest.");
    }
    context.signal.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal.addEventListener("abort", onAbort, { once: true });
    let job!: Readonly<{ abort: () => void; result: Promise<FastManimSandboxBackendResultV1> }>;
    const result = this.#execute(request, {
      ...context,
      identity,
      signal: controller.signal,
    }).finally(() => {
      context.signal.removeEventListener("abort", onAbort);
      this.#activeJobs.delete(job);
    });
    job = { abort: () => controller.abort(), result };
    this.#activeJobs.add(job);
    return job;
  }

  async #execute(
    request: FastManimSandboxRequestBundleV1,
    context: FastManimSandboxJobContextV1,
  ): Promise<FastManimSandboxBackendResultV1> {
    if (this.#closing) throw abortError();
    const timeoutMs = context.deadlineEpochMs - Date.now();
    if (timeoutMs <= 0) {
      return this.#failed(request, context, "producer-timeout");
    }
    const releaseAdmission = this.#admissionController.tryAcquire();
    if (!releaseAdmission) {
      throw new FastManimSandboxBackendControlError("capacity");
    }
    let runtimeDir: string;
    try {
      runtimeDir = await mkdtemp(join(tmpdir(), "poietra-producer-"));
      if (context.signal?.aborted || this.#closing) {
        await this.#removeRuntimeDir(runtimeDir);
        throw abortError();
      }
    } catch (error) {
      releaseAdmission();
      throw error;
    }
    try {
      await materializeFastManimSandboxPngV2(runtimeDir, request);
      context.signal.throwIfAborted();
      const produced = await superviseProducerProcess({
        command: this.#command,
        cwd: runtimeDir,
        env: this.#environment(runtimeDir),
        isHalted: () => context.signal.aborted || this.#closing,
        killProcessGroup: this.#killProcessGroup,
        logger: this.#logger,
        onSettled: () => undefined,
        onSpawned: () => undefined,
        requestId: context.identity.requestId,
        requestJson: Buffer.from(request.copyProducerRequestBytes()).toString("utf8"),
        signal: context.signal,
        stdoutByteLimit: request.maximumResultBytes,
        timings: this.#producerProcessTimings,
        timeoutMs,
      });
      if (produced.kind !== "ok") return this.#failed(request, context, produced.code);
      return {
        attestationDigest: context.attestationDigest,
        kind: "ok",
        requestDigest: request.requestDigest,
        resultBytes: Uint8Array.from(produced.stdout),
      };
    } finally {
      releaseAdmission();
      await this.#removeRuntimeDir(runtimeDir);
    }
  }

  #failed(
    request: FastManimSandboxRequestBundleV1,
    context: FastManimSandboxJobContextV1,
    code: Extract<FastManimSandboxBackendResultV1, { kind: "failed" }>["code"],
  ): FastManimSandboxBackendResultV1 {
    return {
      attestationDigest: context.attestationDigest,
      code,
      kind: "failed",
      requestDigest: request.requestDigest,
    };
  }

  #environment(runtimeDir: string): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of LOCAL_PROCESS_ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    return {
      ...environment,
      ...this.#producerEnv,
      HOME: runtimeDir,
      PYTHONHASHSEED: "0",
      TEMP: runtimeDir,
      TMP: runtimeDir,
      TMPDIR: runtimeDir,
    };
  }

  async #removeRuntimeDir(runtimeDir: string) {
    try {
      await this.#runtimeDirectoryRemover(runtimeDir);
    } catch {
      this.#cleanupFailed = true;
      this.#logger.error("snapshot.sandbox_runtime_cleanup_failed", {
        failure: "runtime-directory-removal-rejected",
      });
      throw new FastManimSandboxBackendControlError("cleanup");
    }
  }

  async close() {
    this.#closing = true;
    for (const job of this.#activeJobs) job.abort();
    await Promise.allSettled([...this.#activeJobs].map((job) => job.result));
    if (this.#cleanupFailed) throw new FastManimSandboxBackendControlError("cleanup");
  }
}
