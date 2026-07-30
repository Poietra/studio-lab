import { performance } from "node:perf_hooks";

import {
  copyFastManimSandboxUint8ArrayV1,
  type FastManimSandboxAttestationVerifierV1,
  FastManimSandboxBackendControlError,
  type FastManimSandboxBackendResultV1,
  type FastManimSandboxBackendV1,
  type FastManimSandboxDeployment,
  FastManimSandboxRequestBundleV1,
  fastManimSandboxBackendControlErrorCode,
  fastManimSandboxBackendResultV1Schema,
  parseFastManimSandboxDeployment,
  parseFastManimSandboxJobIdentityV1,
  resolveFastManimSandboxReadiness,
  UnavailableFastManimSandboxBackendV1,
} from "./fast-manim-sandbox-backend";
import {
  assertFastManimSnapshotDiagnosticsSafeV1,
  deriveHermeticPngV4TransformPlan,
  digestFastManimSnapshotRuntimeConfigV1,
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_SNAPSHOT_FALLBACK_V1,
  FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1,
  FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
  FastManimSnapshotContractError,
  type FastManimSnapshotProducerRequestV1,
  type FastManimSnapshotProfileVersionV1,
  type FastManimSnapshotQueryV1,
  type FastManimSnapshotRunFailureCodeV1,
  type FastManimSnapshotRunRequestV1,
  type FastManimSnapshotRuntimeCapabilityV1,
  type FastManimSnapshotRuntimeConfigV1,
  type FastManimSnapshotRunViewV1,
  fastManimSnapshotProducerRequestV1Schema,
  fastManimSnapshotRunRequestV1Schema,
  fastManimSnapshotRunViewV1Schema,
  fastManimSnapshotSceneIdV1,
  MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES,
  parseAndSealFastManimSnapshotProducerJsonV1,
  parseVerifiedFastManimSnapshotResultV1,
  type VerifiedCompiledFastManimSnapshotResultV1,
  type VerifiedFastManimSnapshotResultV1,
  type VerifiedSourceRuntimeIdentityMapV1,
} from "./fast-manim-snapshot-contract";
import {
  type FastManimSnapshotPngProviderV1,
  type FastManimSnapshotPngReadV1,
  readFastManimSnapshotPngV1,
  sameFastManimSnapshotPngReadV1,
} from "./fast-manim-snapshot-png-provider";
import { abortError } from "./fast-manim-snapshot-producer-process";
import { type FastManimSnapshotPublicationStore, processPublicationStore } from "./fast-manim-snapshot-publication";
import {
  type FastManimSnapshotSourceProviderV1,
  type FastManimSnapshotSourceReadV1,
  FileSystemFastManimSnapshotSourceProviderV1,
} from "./fast-manim-snapshot-source-provider";
import { parseFastManimProducerDocumentV1 } from "./fast-manim-source-runtime-document";
import {
  parseServerOwnedSourceRuntimeIdentityMapV1,
  parseVerifiedSourceRuntimeIdentityMapV1,
  verifyFastManimSourceRuntimeIdentityV1,
} from "./fast-manim-source-runtime-identity";
import { HttpError } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import type { ManimSourceReadHooks } from "./manim-source-store";

// Publication accounting and admission control live in
// ./fast-manim-snapshot-publication; the subprocess supervision state machine
// lives in ./fast-manim-snapshot-producer-process. Both are re-exported below
// so the public surface of this module is unchanged.
export {
  FastManimSnapshotAdmissionController,
  FastManimSnapshotPublicationStore,
} from "./fast-manim-snapshot-publication";

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 20_000;
const MAX_SNAPSHOT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CONCURRENT_SNAPSHOT_RUNS = 2;
const DEFAULT_MAX_PUBLISHED_SNAPSHOTS = 16;
const DEFAULT_MAX_PUBLISHED_BYTES = 16 * 1024 * 1024;
const DEFAULT_PUBLISH_RETENTION_MS = 30 * 60_000;
const SANDBOX_STATUS_SETTLE_GRACE_MS = 100;
const MAX_SANDBOX_OPERATION_SETTLE_GRACE_MS = 10_000;
const MAX_SANDBOX_STATUS_TIMEOUT_MS = 2_000;
const DEFAULT_SANDBOX_CLOSE_GRACE_MS = 10_000;
const PRODUCTION_SANDBOX_CLOSE_GRACE_MS = 35_000;
const MAX_SANDBOX_CLOSE_GRACE_MS = 60_000;
const fastManimSandboxOperationDeadlineErrors = new WeakSet<object>();
const fastManimSandboxJobHandleRejectedErrors = new WeakSet<object>();
const nativePromiseThen = Promise.prototype.then;

function parseServerOwnedFastManimRunView(value: unknown): FastManimSnapshotRunViewV1 {
  const parsed = fastManimSnapshotRunViewV1Schema.parse(value);
  if (parsed.status !== "verified" || parsed.sourceRuntimeIdentity === undefined) return parsed;
  return {
    ...parsed,
    // Zod intentionally clones its output. Revalidate that clone and replace
    // it with a deep-frozen server-owned map before any API caller receives a
    // reference; the publication store retains a separate frozen copy.
    sourceRuntimeIdentity: parseServerOwnedSourceRuntimeIdentityMapV1(parsed.sourceRuntimeIdentity),
  };
}

export type FastManimUnpublishedSnapshotRunViewV1 =
  | Exclude<FastManimSnapshotRunViewV1, { status: "verified" }>
  | Omit<Extract<FastManimSnapshotRunViewV1, { status: "verified" }>, "publishedAt" | "revision">;

class FastManimSandboxOperationDeadlineError extends Error {
  constructor() {
    super("The sandbox backend operation exceeded its server-owned deadline.");
    this.name = "FastManimSandboxOperationDeadlineError";
    fastManimSandboxOperationDeadlineErrors.add(this);
  }
}

class FastManimSandboxJobHandleRejectedError extends Error {
  constructor() {
    super("The sandbox backend returned an invalid job handle.");
    this.name = "FastManimSandboxJobHandleRejectedError";
    fastManimSandboxJobHandleRejectedErrors.add(this);
  }
}

type FastManimSandboxDeadline = Readonly<{
  epochMs: number;
  monotonicMs: number;
}>;

type FastManimSandboxSettlement<T> =
  | Readonly<{ kind: "fulfilled"; value: T }>
  | Readonly<{ kind: "rejected"; reason: unknown }>;

type ObservedFastManimSandboxPromise<T> = Promise<FastManimSandboxSettlement<T>>;

function fulfilledFastManimSandboxSettlement<T>(value: T): FastManimSandboxSettlement<T> {
  return Object.freeze(
    Object.create(null, {
      kind: { enumerable: true, value: "fulfilled" },
      value: { enumerable: true, value },
    }) as FastManimSandboxSettlement<T>,
  );
}

function rejectedFastManimSandboxSettlement<T>(reason: unknown): FastManimSandboxSettlement<T> {
  return Object.freeze(
    Object.create(null, {
      kind: { enumerable: true, value: "rejected" },
      reason: { enumerable: true, value: reason },
    }) as FastManimSandboxSettlement<T>,
  );
}

function isServerOwnedErrorIdentity(registry: WeakSet<object>, value: unknown) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return registry.has(value);
}

function observeNativeFastManimSandboxPromise<T>(
  value: unknown,
  onInvalid: () => void,
  invalidReason: () => unknown,
): ObservedFastManimSandboxPromise<T> {
  return new Promise((resolve) => {
    try {
      Reflect.apply(nativePromiseThen, value, [
        (result: T) => resolve(fulfilledFastManimSandboxSettlement(result)),
        (reason: unknown) => resolve(rejectedFastManimSandboxSettlement(reason)),
      ]);
    } catch {
      onInvalid();
      resolve(rejectedFastManimSandboxSettlement(invalidReason()));
    }
  });
}

type TrackedFastManimSandboxJob = {
  abandoned: boolean;
  abort: () => void;
  result: ObservedFastManimSandboxPromise<unknown>;
  requestId: string;
};

type TrackedFastManimSandboxStatus = {
  abandoned: boolean;
  promise: ObservedFastManimSandboxPromise<unknown>;
};

const FAILURE_MESSAGES: Readonly<Record<FastManimSnapshotRunFailureCodeV1, string>> = {
  "asset-changed": "The project image.png generation changed while the snapshot producer was running.",
  "asset-unavailable": "The exact project image.png generation is unavailable for snapshot execution.",
  "capability-unsupported": "The compiled Scene requires capabilities outside the server runtime allowlist.",
  "producer-exit": "The fast-manim snapshot producer exited without a usable result.",
  "producer-output-overflow": "The fast-manim snapshot producer exceeded the raw stdout/stderr byte budget.",
  "producer-spawn-failed": "The fast-manim snapshot producer could not be started.",
  "producer-timeout": "The fast-manim snapshot producer did not complete within its execution deadline.",
  "producer-unconfigured":
    "No fast-manim snapshot producer is configured; use the server-authoritative render pipeline.",
  "result-rejected": "The fast-manim snapshot result failed server verification.",
  "runtime-config-changed": "The server runtime capability configuration changed during the snapshot run.",
  "sandbox-attestation-rejected": "The configured sandbox backend did not provide a current verified attestation.",
  "sandbox-execution-failed": "The sandbox backend could not complete the Scene snapshot job.",
  "sandbox-result-rejected": "The sandbox backend returned a result for a different request or runtime profile.",
  "sandbox-unavailable": "No verified sandbox backend is available for Scene snapshot execution.",
  "snapshot-too-large": "The verified snapshot exceeds the server publication byte budget.",
  "source-changed": "The Python source changed while the snapshot producer was running.",
  "source-correlation-stale": "The request source hash no longer matches the Python source on disk.",
};

function sceneKey(sourcePath: string, sceneName: string) {
  return `${sourcePath}\u0000${sceneName}`;
}

export class FastManimSnapshotRunner {
  private readonly activeJobs = new Set<TrackedFastManimSandboxJob>();
  private readonly activeKeys = new Set<string>();
  private readonly activeLookups = new Set<Promise<unknown>>();
  private readonly activeRuns = new Set<Promise<unknown>>();
  private readonly activeStatuses = new Set<TrackedFastManimSandboxStatus>();
  private readonly attestationVerifier: FastManimSandboxAttestationVerifierV1 | undefined;
  private readonly backend: FastManimSandboxBackendV1;
  private backendLifecycleRejected = false;
  private readonly capabilities: readonly FastManimSnapshotRuntimeCapabilityV1[];
  private closing = false;
  private closeRequest: Promise<void> | null = null;
  private readonly deployment: FastManimSandboxDeployment;
  private readonly frame: Readonly<{ height: number; width: number }>;
  private readonly logger: StructuredLogger;
  private readonly maxConcurrentRuns: number;
  private readonly maxPublishedBytes: number;
  private readonly maxPublishedSnapshots: number;
  private ownerId: number | null = null;
  private readonly projectId: string;
  private readonly pngProvider: FastManimSnapshotPngProviderV1 | undefined;
  private readonly publicationStore: FastManimSnapshotPublicationStore;
  private readonly publishRetentionMs: number;
  private readonly sandboxCloseGraceMs: number;
  private readonly snapshotVersion: FastManimSnapshotProfileVersionV1;
  private readonly sourceProvider: FastManimSnapshotSourceProviderV1;
  private readonly shutdownController = new AbortController();
  private readonly tenantId: string;
  private readonly timeoutMs: number;

  constructor(
    options: Readonly<{
      attestationVerifier?: FastManimSandboxAttestationVerifierV1;
      backend?: FastManimSandboxBackendV1;
      capabilities?: readonly FastManimSnapshotRuntimeCapabilityV1[];
      deployment: FastManimSandboxDeployment;
      frame: Readonly<{ height: number; width: number }>;
      logger?: StructuredLogger;
      maxConcurrentRuns?: number;
      maxPublishedBytes?: number;
      maxPublishedSnapshots?: number;
      projectId: string;
      projectRoot?: string;
      pngProvider?: FastManimSnapshotPngProviderV1;
      publicationStore?: FastManimSnapshotPublicationStore;
      publishRetentionMs?: number;
      sandboxCloseGraceMs?: number;
      snapshotVersion?: FastManimSnapshotProfileVersionV1;
      sourceReadHooks?: ManimSourceReadHooks;
      sourceProvider?: FastManimSnapshotSourceProviderV1;
      tenantId: string;
      timeoutMs?: number;
    }>,
  ) {
    const deployment = parseFastManimSandboxDeployment(options.deployment);
    const timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SNAPSHOT_TIMEOUT_MS) {
      throw new TypeError(`Snapshot timeout must be a positive integer of at most ${MAX_SNAPSHOT_TIMEOUT_MS}ms.`);
    }
    const maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_SNAPSHOT_RUNS;
    if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns <= 0) {
      throw new TypeError("Maximum concurrent snapshot runs must be a positive integer.");
    }
    const maxPublishedSnapshots = options.maxPublishedSnapshots ?? DEFAULT_MAX_PUBLISHED_SNAPSHOTS;
    if (!Number.isSafeInteger(maxPublishedSnapshots) || maxPublishedSnapshots <= 0) {
      throw new TypeError("Maximum published snapshots must be a positive integer.");
    }
    const maxPublishedBytes = options.maxPublishedBytes ?? DEFAULT_MAX_PUBLISHED_BYTES;
    if (!Number.isSafeInteger(maxPublishedBytes) || maxPublishedBytes <= 0) {
      throw new TypeError("Maximum published snapshot bytes must be a positive integer.");
    }
    const publishRetentionMs = options.publishRetentionMs ?? DEFAULT_PUBLISH_RETENTION_MS;
    if (!Number.isSafeInteger(publishRetentionMs) || publishRetentionMs <= 0) {
      throw new TypeError("Published snapshot retention must be a positive integer of milliseconds.");
    }
    if ((options.projectRoot === undefined) === (options.sourceProvider === undefined)) {
      throw new TypeError("Provide exactly one filesystem project root or durable snapshot source provider.");
    }
    if (options.sourceProvider && options.sourceReadHooks) {
      throw new TypeError("Durable snapshot source providers cannot use filesystem read hooks.");
    }
    const sandboxCloseGraceMs =
      options.sandboxCloseGraceMs ??
      (deployment === "production"
        ? PRODUCTION_SANDBOX_CLOSE_GRACE_MS
        : Math.min(timeoutMs, DEFAULT_SANDBOX_CLOSE_GRACE_MS));
    if (
      !Number.isSafeInteger(sandboxCloseGraceMs) ||
      sandboxCloseGraceMs <= 0 ||
      sandboxCloseGraceMs > MAX_SANDBOX_CLOSE_GRACE_MS
    ) {
      throw new TypeError(`Sandbox close grace must be at most ${MAX_SANDBOX_CLOSE_GRACE_MS}ms.`);
    }
    this.attestationVerifier = options.attestationVerifier;
    this.backend = options.backend ?? new UnavailableFastManimSandboxBackendV1();
    this.snapshotVersion = options.snapshotVersion ?? 1;
    this.capabilities = Object.freeze([
      ...(options.capabilities ??
        (this.snapshotVersion === 4 ? (["png-image"] as const) : FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1)),
    ]);
    this.deployment = deployment;
    this.frame = Object.freeze({ height: options.frame.height, width: options.frame.width });
    this.logger = options.logger ?? nullLogger;
    this.maxConcurrentRuns = maxConcurrentRuns;
    this.maxPublishedBytes = maxPublishedBytes;
    this.maxPublishedSnapshots = maxPublishedSnapshots;
    const configuredIdentity = parseFastManimSandboxJobIdentityV1({
      projectId: options.projectId,
      requestId: "runner-configuration",
      tenantId: options.tenantId,
    });
    this.projectId = configuredIdentity.projectId;
    this.pngProvider = options.pngProvider;
    this.publicationStore = options.publicationStore ?? processPublicationStore;
    this.publishRetentionMs = publishRetentionMs;
    this.sandboxCloseGraceMs = sandboxCloseGraceMs;
    this.sourceProvider =
      options.sourceProvider ??
      new FileSystemFastManimSnapshotSourceProviderV1(options.projectRoot!, options.sourceReadHooks);
    this.tenantId = configuredIdentity.tenantId;
    this.timeoutMs = timeoutMs;
    // Fail fast on an invalid capability allowlist or frame instead of at run time.
    digestFastManimSnapshotRuntimeConfigV1(this.runtimeConfig());
  }

  get busy() {
    // Publication lookups revalidate asynchronously, so they hold the runner
    // busy too: unregister/close must never race a held GET.
    return (
      this.activeJobs.size > 0 ||
      this.activeKeys.size > 0 ||
      this.activeLookups.size > 0 ||
      this.activeStatuses.size > 0
    );
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closing) return false;
    try {
      const readiness = await this.sandboxReadiness("runner-readiness", this.sandboxStatusDeadline(), signal);
      return readiness.kind === "ready";
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  private sandboxIdentity(requestId: string) {
    return parseFastManimSandboxJobIdentityV1({
      projectId: this.projectId,
      requestId,
      tenantId: this.tenantId,
    });
  }

  private backendIsQuarantined() {
    return (
      this.backendLifecycleRejected ||
      [...this.activeJobs].some((job) => job.abandoned) ||
      [...this.activeStatuses].some((status) => status.abandoned)
    );
  }

  private sandboxDeadline(durationMs: number): FastManimSandboxDeadline {
    return Object.freeze({
      epochMs: Date.now() + durationMs,
      monotonicMs: performance.now() + durationMs,
    });
  }

  private sandboxStatusDeadline() {
    return this.sandboxDeadline(Math.min(this.timeoutMs, MAX_SANDBOX_STATUS_TIMEOUT_MS));
  }

  /**
   * The adapter is not trusted to honor its advertised deadline/abort
   * capability. Every asynchronous adapter operation is therefore raced by a
   * runner-owned monotonic deadline plus caller and shutdown signals. Timers
   * cannot preempt a synchronous same-thread backend block; the settlement
   * path therefore rechecks the monotonic deadline before accepting either a
   * fulfillment or rejection. Enforced process isolation belongs to #82.
   */
  private awaitBackendOperation<T>(
    operation: (signal: AbortSignal) => ObservedFastManimSandboxPromise<T>,
    deadline: FastManimSandboxDeadline,
    callerSignal?: AbortSignal,
    onHalt?: (reason: "abort" | "deadline") => void,
    settleGraceMs = 0,
    onUnsettled?: (reason: "abort" | "deadline") => void,
    observeShutdown = true,
  ): Promise<FastManimSandboxSettlement<T>> {
    const abortWasRequested = () =>
      callerSignal?.aborted === true || (observeShutdown && this.shutdownController.signal.aborted);
    if (abortWasRequested()) return Promise.reject(abortError());
    if (
      !Number.isSafeInteger(deadline.epochMs) ||
      !Number.isFinite(deadline.monotonicMs) ||
      performance.now() >= deadline.monotonicMs
    ) {
      return Promise.reject(new FastManimSandboxOperationDeadlineError());
    }

    const controller = new AbortController();
    return new Promise<FastManimSandboxSettlement<T>>((resolve, reject) => {
      let backendSettled = false;
      let finished = false;
      let haltStarted = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      let settleTimer: NodeJS.Timeout | undefined;
      const currentHaltReason = (): "abort" | "deadline" | null => {
        if (abortWasRequested()) return "abort";
        if (performance.now() >= deadline.monotonicMs) return "deadline";
        return null;
      };
      const cleanup = () => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (settleTimer) clearTimeout(settleTimer);
        callerSignal?.removeEventListener("abort", onAbort);
        if (observeShutdown) this.shutdownController.signal.removeEventListener("abort", onAbort);
      };
      const finish = (complete: () => void) => {
        if (finished) return;
        finished = true;
        cleanup();
        complete();
      };
      const rejectHalted = () => {
        const reason = currentHaltReason() ?? "deadline";
        if (!backendSettled) {
          try {
            onUnsettled?.(reason);
          } catch {
            this.backendLifecycleRejected = true;
            this.logger.warn("snapshot.sandbox_unsettled_callback_failed", { failure: "callback-threw" });
          }
        }
        finish(() => reject(reason === "deadline" ? new FastManimSandboxOperationDeadlineError() : abortError()));
      };
      const halt = (requestedReason: "abort" | "deadline") => {
        if (finished) return;
        const reason = currentHaltReason() ?? requestedReason;
        if (reason === "deadline" && performance.now() < deadline.monotonicMs) {
          scheduleDeadline();
          return;
        }
        if (!haltStarted) {
          haltStarted = true;
          controller.abort();
          try {
            onHalt?.(reason);
          } catch {
            this.backendLifecycleRejected = true;
            this.logger.warn("snapshot.sandbox_abort_callback_failed", { failure: "callback-threw" });
          }
        }
        if (settleGraceMs <= 0) {
          rejectHalted();
          return;
        }
        if (!settleTimer) {
          settleTimer = setTimeout(rejectHalted, settleGraceMs);
          settleTimer.unref();
        }
      };
      const onAbort = () => halt("abort");
      const scheduleDeadline = () => {
        if (finished) return;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        const remainingMs = deadline.monotonicMs - performance.now();
        deadlineTimer = setTimeout(() => halt("deadline"), Math.max(0, Math.ceil(remainingMs)));
        deadlineTimer.unref();
      };
      const settleBackend = (settlement: FastManimSandboxSettlement<T>) => {
        backendSettled = true;
        const reason = currentHaltReason();
        if (reason !== null) {
          halt(reason);
          finish(() => reject(reason === "deadline" ? new FastManimSandboxOperationDeadlineError() : abortError()));
          return;
        }
        // The null-prototype frozen box is the only fulfillment value allowed
        // through Promise resolution. The foreign raw value stays nested until
        // its synchronous status/result consumer validates or discards it.
        finish(() => resolve(settlement));
      };

      callerSignal?.addEventListener("abort", onAbort, { once: true });
      if (observeShutdown) this.shutdownController.signal.addEventListener("abort", onAbort, { once: true });
      scheduleDeadline();

      let observed: ObservedFastManimSandboxPromise<T>;
      try {
        observed = operation(controller.signal);
      } catch (reason) {
        settleBackend(rejectedFastManimSandboxSettlement(reason));
        return;
      }
      const reasonAfterSynchronousOperation = currentHaltReason();
      if (reasonAfterSynchronousOperation !== null) halt(reasonAfterSynchronousOperation);
      try {
        Reflect.apply(nativePromiseThen, observed, [
          settleBackend,
          () => {
            this.backendLifecycleRejected = true;
            settleBackend(rejectedFastManimSandboxSettlement(new FastManimSandboxJobHandleRejectedError()));
          },
        ]);
      } catch {
        this.backendLifecycleRejected = true;
        settleBackend(rejectedFastManimSandboxSettlement(new FastManimSandboxJobHandleRejectedError()));
      }
    });
  }

  private trackStatus(promise: ObservedFastManimSandboxPromise<unknown>) {
    const tracked: TrackedFastManimSandboxStatus = { abandoned: false, promise };
    this.activeStatuses.add(tracked);
    Reflect.apply(nativePromiseThen, promise, [
      () => this.activeStatuses.delete(tracked),
      () => this.activeStatuses.delete(tracked),
    ]);
    return tracked;
  }

  private async sandboxReadiness(
    requestId: string,
    deadline: FastManimSandboxDeadline,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof resolveFastManimSandboxReadiness>> {
    if (this.backendIsQuarantined()) return { code: "sandbox-unavailable", kind: "failed" };
    let trackedStatus: TrackedFastManimSandboxStatus | undefined;
    const statusSettlement = await this.awaitBackendOperation(
      (operationSignal) => {
        const pending = this.backend.status({
          deadlineEpochMs: deadline.epochMs,
          identity: this.sandboxIdentity(requestId),
          signal: operationSignal,
        });
        const observed = observeNativeFastManimSandboxPromise<unknown>(
          pending,
          () => {
            this.backendLifecycleRejected = true;
          },
          () => new FastManimSandboxJobHandleRejectedError(),
        );
        trackedStatus = this.trackStatus(observed);
        return observed;
      },
      deadline,
      signal,
      () => {
        if (trackedStatus) trackedStatus.abandoned = true;
      },
      SANDBOX_STATUS_SETTLE_GRACE_MS,
      () => {
        this.backendLifecycleRejected = true;
      },
    );
    if (statusSettlement.kind === "rejected") throw statusSettlement.reason;
    return resolveFastManimSandboxReadiness(
      statusSettlement.value,
      this.deployment,
      Date.now(),
      this.attestationVerifier,
    );
  }

  private captureJobHandle(
    value: unknown,
    onAbortCaptured: (abort: () => void) => void,
  ): Readonly<{ abort: () => void; result: ObservedFastManimSandboxPromise<unknown> }> {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      this.backendLifecycleRejected = true;
      throw new FastManimSandboxJobHandleRejectedError();
    }
    let abortMember: unknown;
    try {
      abortMember = Reflect.get(value, "abort");
    } catch {
      this.backendLifecycleRejected = true;
      throw new FastManimSandboxJobHandleRejectedError();
    }
    if (typeof abortMember !== "function") {
      this.backendLifecycleRejected = true;
      throw new FastManimSandboxJobHandleRejectedError();
    }
    let abortRequested = false;
    const abort = () => {
      if (abortRequested) return;
      abortRequested = true;
      Reflect.apply(abortMember, value, []);
    };
    onAbortCaptured(abort);

    let resultMember: unknown;
    try {
      resultMember = Reflect.get(value, "result");
    } catch {
      this.backendLifecycleRejected = true;
      throw new FastManimSandboxJobHandleRejectedError();
    }
    const result = observeNativeFastManimSandboxPromise<unknown>(
      resultMember,
      () => {
        this.backendLifecycleRejected = true;
      },
      () => new FastManimSandboxJobHandleRejectedError(),
    );
    return { abort, result };
  }

  private trackJob(abort: () => void, result: ObservedFastManimSandboxPromise<unknown>, requestId: string) {
    const tracked: TrackedFastManimSandboxJob = { abandoned: false, abort, requestId, result };
    this.activeJobs.add(tracked);
    Reflect.apply(nativePromiseThen, result, [
      () => this.activeJobs.delete(tracked),
      () => this.activeJobs.delete(tracked),
    ]);
    return tracked;
  }

  private abortJob(job: TrackedFastManimSandboxJob) {
    job.abandoned = true;
    try {
      job.abort();
    } catch {
      this.backendLifecycleRejected = true;
      this.logger.warn("snapshot.sandbox_job_abort_failed", {
        failure: "abort-threw",
        requestId: job.requestId,
      });
    }
  }

  private runtimeConfig(): FastManimSnapshotRuntimeConfigV1 {
    return {
      capabilities: [...this.capabilities],
      frame: { height: this.frame.height, width: this.frame.width },
      randomSeed: 0,
      schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
      snapshotVersion: this.snapshotVersion,
      version: 1,
    };
  }

  async run(requestValue: FastManimSnapshotRunRequestV1, signal?: AbortSignal): Promise<FastManimSnapshotRunViewV1> {
    return parseServerOwnedFastManimRunView(await this.runRequest(requestValue, true, signal));
  }

  /** Verify one sandbox result without assigning process-local publication state. */
  async runUnpublished(
    requestValue: FastManimSnapshotRunRequestV1,
    signal?: AbortSignal,
  ): Promise<FastManimUnpublishedSnapshotRunViewV1> {
    return this.runRequest(requestValue, false, signal) as Promise<FastManimUnpublishedSnapshotRunViewV1>;
  }

  private async runRequest(
    requestValue: FastManimSnapshotRunRequestV1,
    publishLocally: boolean,
    signal?: AbortSignal,
  ): Promise<FastManimSnapshotRunViewV1 | FastManimUnpublishedSnapshotRunViewV1> {
    const request = fastManimSnapshotRunRequestV1Schema.parse(requestValue);
    signal?.throwIfAborted();
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    if (request.projectId !== this.projectId) throw new HttpError("Configured Manim project not found.", 404);
    const key = sceneKey(request.sourcePath, request.sceneName);
    if (this.activeKeys.has(key)) {
      throw new HttpError("A Scene snapshot run is already in progress for this source and Scene.", 409);
    }
    if (this.activeKeys.size >= this.maxConcurrentRuns) {
      throw new HttpError("Too many concurrent Scene snapshot runs.", 429);
    }
    this.activeKeys.add(key);
    const pending = this.runLocked(request, publishLocally, signal);
    this.activeRuns.add(pending);
    pending.catch(() => undefined);
    try {
      return await pending;
    } finally {
      this.activeKeys.delete(key);
      this.activeRuns.delete(pending);
    }
  }

  private async runLocked(
    request: FastManimSnapshotRunRequestV1,
    publishLocally: boolean,
    signal?: AbortSignal,
  ): Promise<FastManimSnapshotRunViewV1 | FastManimUnpublishedSnapshotRunViewV1> {
    const throwIfHalted = () => {
      if (signal?.aborted || this.closing) throw abortError();
    };
    const runtimeConfigHash = digestFastManimSnapshotRuntimeConfigV1(this.runtimeConfig());
    const base = {
      projectId: request.projectId,
      requestId: request.requestId,
      runtimeConfigHash,
      sceneName: request.sceneName,
      schema: FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1,
      sourcePath: request.sourcePath,
      version: 1,
    } as const;
    const failed = (
      code: FastManimSnapshotRunFailureCodeV1,
      contractCode?: FastManimSnapshotContractError["code"],
    ): FastManimSnapshotRunViewV1 => {
      this.logger.warn("snapshot.run_failed", { code, contractCode, requestId: request.requestId });
      return {
        ...base,
        failure: {
          code,
          ...(contractCode === undefined ? {} : { contractCode }),
          message: FAILURE_MESSAGES[code],
        },
        fallback: FAST_MANIM_SNAPSHOT_FALLBACK_V1,
        status: "failed",
      };
    };

    let readiness: ReturnType<typeof resolveFastManimSandboxReadiness>;
    try {
      readiness = await this.sandboxReadiness(request.requestId, this.sandboxStatusDeadline(), signal);
    } catch {
      throwIfHalted();
      this.logger.warn("snapshot.sandbox_health_check_failed", {
        failure: "backend-operation-rejected",
        requestId: request.requestId,
      });
      return failed("sandbox-unavailable");
    }
    throwIfHalted();
    if (readiness.kind !== "ready") {
      this.logger.warn("snapshot.sandbox_not_ready", {
        code: readiness.code,
        requestId: request.requestId,
      });
      return failed(readiness.code);
    }

    // Verified read: the bytes handed to the producer come from a single
    // opened descriptor whose inode is proven to live inside the project
    // root, immune to validate-then-open pathname swaps. Platforms that
    // cannot prove this fail closed (HTTP 501) before any Python runs.
    let before: FastManimSnapshotSourceReadV1;
    try {
      before = await this.sourceProvider.readVerified(request.sourcePath, signal);
    } catch (error) {
      throwIfHalted();
      throw error;
    }
    throwIfHalted();
    if (request.sourceHash !== undefined && request.sourceHash !== before.hash) {
      return failed("source-correlation-stale");
    }

    let beforePng: FastManimSnapshotPngReadV1 | null = null;
    if (this.snapshotVersion === 4) {
      if (!this.pngProvider) return failed("asset-unavailable");
      try {
        beforePng = await readFastManimSnapshotPngV1(this.pngProvider, signal);
      } catch {
        throwIfHalted();
        return failed("asset-unavailable");
      }
      throwIfHalted();
    }

    let hermeticPngV4Plan: ExpectedFastManimSnapshotCorrelationV1["hermeticPngV4Plan"];
    if (this.snapshotVersion === 4) {
      try {
        hermeticPngV4Plan = deriveHermeticPngV4TransformPlan(before.source, request.sceneName);
      } catch {
        // An unsupported source must still reach the producer and preserve its
        // structured unsupported result. A compiled result is rejected below
        // because sealing independently derives the same plan from source.
      }
    }
    const expected: ExpectedFastManimSnapshotCorrelationV1 = {
      frame: { height: this.frame.height, width: this.frame.width },
      ...(hermeticPngV4Plan ? { hermeticPngV4Plan } : {}),
      projectId: request.projectId,
      requestId: request.requestId,
      runtimeConfigHash,
      snapshotVersion: this.snapshotVersion,
      sceneId: fastManimSnapshotSceneIdV1(request.sourcePath, request.sceneName),
      sceneName: request.sceneName,
      sourceHash: before.hash,
      sourcePath: request.sourcePath,
    };
    // Scene existence is the producer's authority: a Python-side base-class
    // check here would false-negative legitimate transitive Scene subclasses.
    // The producer request carries the canonical runtime config object plus
    // the immutable source text, so the producer recomputes runtimeConfigHash
    // and sourceHash instead of echoing them and never re-opens sourcePath.
    // The expected frame is server-side verification state only; the wire
    // request carries the frame inside the canonical runtimeConfig object.
    const {
      frame: _serverFrame,
      hermeticPngV4Plan: _serverHermeticPngV4Plan,
      snapshotVersion,
      ...wireCorrelation
    } = expected;
    const producerRequest = fastManimSnapshotProducerRequestV1Schema.parse({
      ...wireCorrelation,
      runtimeConfig: this.runtimeConfig(),
      schema: FAST_MANIM_SNAPSHOT_PRODUCER_REQUEST_SCHEMA_V1,
      snapshotVersion,
      sourceText: before.source,
      version: 1,
    } satisfies FastManimSnapshotProducerRequestV1);

    const sandboxRequest = new FastManimSandboxRequestBundleV1(
      producerRequest,
      beforePng === null ? undefined : { pngBytes: beforePng.bytes },
    );
    const produced = await this.produce(sandboxRequest, readiness.attestationDigest, request, signal);
    throwIfHalted();
    if (produced.kind !== "ok") return failed(produced.code);

    let sealed: VerifiedFastManimSnapshotResultV1;
    let sourceRuntimeIdentity = null;
    try {
      // The combined envelope is only split here. Its embedded snapshot first
      // passes the unchanged strict Snapshot/Scene IR verifier and server seal;
      // only then may the paired identity evidence be interpreted.
      const producerDocument = parseFastManimProducerDocumentV1(produced.resultBytes);
      sealed = await parseAndSealFastManimSnapshotProducerJsonV1(
        producerDocument.snapshotJson,
        expected,
        before.source,
      );
      // Defense in depth behind the structural static-profile normalization.
      assertFastManimSnapshotDiagnosticsSafeV1(sealed, {
        ...(this.sourceProvider.diagnosticProjectRoot
          ? { projectRoot: this.sourceProvider.diagnosticProjectRoot }
          : {}),
        ...(before.absolutePath ? { sourceAbsolutePath: before.absolutePath } : {}),
        sourceText: before.source,
      });
      sourceRuntimeIdentity = producerDocument.combined
        ? verifyFastManimSourceRuntimeIdentityV1(producerDocument.combined, {
            expected,
            snapshot: sealed,
            sourceText: before.source,
          })
        : null;
    } catch (cause) {
      throwIfHalted();
      if (cause instanceof FastManimSnapshotContractError) return failed("result-rejected", cause.code);
      this.logger.warn("snapshot.result_rejected", { failure: "verification-rejected", requestId: request.requestId });
      return failed("result-rejected");
    }
    throwIfHalted();

    if (beforePng !== null && sealed.kind === "compiled") {
      const asset = sealed.bundle.assets.assets[0];
      if (
        !asset ||
        asset.kind !== "png-image" ||
        asset.sha256 !== beforePng.digest ||
        asset.byteLength !== beforePng.byteSize ||
        asset.pixelHeight !== beforePng.height ||
        asset.pixelWidth !== beforePng.width
      ) {
        return failed("result-rejected");
      }
    }

    // Correlate source and runtime capability again after execution: the file
    // may have been rewritten while the producer ran, and a snapshot must only
    // publish against the exact inputs it was correlated with beforehand. A
    // Filesystem providers retain hash-only change-and-restore semantics;
    // durable providers bind the source generation as well as its digest.
    let after: FastManimSnapshotSourceReadV1;
    try {
      after = await this.sourceProvider.readVerified(request.sourcePath, signal);
    } catch {
      throwIfHalted();
      return failed("source-changed");
    }
    throwIfHalted();
    if (after.hash !== expected.sourceHash || after.versionToken !== before.versionToken)
      return failed("source-changed");
    if (beforePng !== null) {
      let afterPng: FastManimSnapshotPngReadV1;
      try {
        afterPng = await readFastManimSnapshotPngV1(this.pngProvider!, signal);
      } catch {
        throwIfHalted();
        return failed("asset-changed");
      }
      throwIfHalted();
      if (!sameFastManimSnapshotPngReadV1(beforePng, afterPng)) return failed("asset-changed");
    }
    if (digestFastManimSnapshotRuntimeConfigV1(this.runtimeConfig()) !== runtimeConfigHash) {
      return failed("runtime-config-changed");
    }

    if (sealed.kind === "unsupported") {
      return { ...base, fallback: FAST_MANIM_SNAPSHOT_FALLBACK_V1, issues: sealed.issues, status: "unsupported" };
    }

    const unsupportedCapabilities = sealed.bundle.scene.requiredCapabilities.filter(
      (capability) => !this.capabilities.includes(capability),
    );
    if (unsupportedCapabilities.length > 0) {
      this.logger.warn("snapshot.capability_unsupported", {
        requestId: request.requestId,
        unsupportedCapabilities,
      });
      return failed("capability-unsupported");
    }

    const encodedBytes = Buffer.byteLength(JSON.stringify({ snapshot: sealed, sourceRuntimeIdentity }), "utf8");
    if (
      encodedBytes > this.maxPublishedBytes ||
      (publishLocally && !this.publicationStore.fitsSingleEntry(encodedBytes))
    ) {
      return failed("snapshot-too-large");
    }

    throwIfHalted();
    const verified = {
      ...base,
      snapshot: sealed,
      ...(sourceRuntimeIdentity === null ? {} : { sourceRuntimeIdentity }),
      status: "verified",
    } as const satisfies FastManimUnpublishedSnapshotRunViewV1;
    if (!publishLocally) {
      this.logger.info("snapshot.verified", { requestId: request.requestId });
      return verified;
    }
    const key = sceneKey(request.sourcePath, request.sceneName);
    const { publishedAt, revision } = this.publish(key, expected, sealed, sourceRuntimeIdentity, encodedBytes);
    this.logger.info("snapshot.published", { requestId: request.requestId, revision });
    return {
      ...verified,
      publishedAt,
      revision,
    };
  }

  private localOwnerId() {
    this.ownerId ??= this.publicationStore.registerOwner();
    return this.ownerId;
  }

  private evictExpired(ownerId: number, now: number) {
    for (const [key, entry] of this.publicationStore.entriesOf(ownerId)) {
      if (now - entry.publishedAtEpochMs > this.publishRetentionMs) this.publicationStore.delete(ownerId, key);
    }
  }

  private publish(
    key: string,
    expected: ExpectedFastManimSnapshotCorrelationV1,
    result: VerifiedCompiledFastManimSnapshotResultV1,
    sourceRuntimeIdentity: VerifiedSourceRuntimeIdentityMapV1 | null,
    encodedBytes: number,
  ) {
    const now = Date.now();
    const ownerId = this.localOwnerId();
    this.evictExpired(ownerId, now);
    // Revisions come from the shared store's single monotonic sequence, so
    // neither eviction, TTL expiry, nor another tenant's publications can
    // ever make a republished Scene appear older than a cached copy.
    const revision = this.publicationStore.nextRevision();
    const publishedAt = new Date(now).toISOString();
    const evicted = this.publicationStore.publish(
      ownerId,
      key,
      { encodedBytes, expected, publishedAt, publishedAtEpochMs: now, result, revision, sourceRuntimeIdentity },
      { maxBytes: this.maxPublishedBytes, maxEntries: this.maxPublishedSnapshots },
    );
    if (evicted > 0) this.logger.info("snapshot.evicted", { evicted });
    return { publishedAt, revision };
  }

  private async produce(
    request: FastManimSandboxRequestBundleV1,
    attestationDigest: string,
    runRequest: FastManimSnapshotRunRequestV1,
    signal?: AbortSignal,
  ): Promise<FastManimSandboxBackendResultV1> {
    if (signal?.aborted || this.closing) throw abortError();
    let startReadiness: ReturnType<typeof resolveFastManimSandboxReadiness>;
    try {
      startReadiness = await this.sandboxReadiness(runRequest.requestId, this.sandboxStatusDeadline(), signal);
    } catch {
      if (signal?.aborted || this.closing) throw abortError();
      this.logger.warn("snapshot.sandbox_start_health_check_failed", {
        failure: "backend-operation-rejected",
        requestId: runRequest.requestId,
      });
      startReadiness = { code: "sandbox-unavailable", kind: "failed" };
    }
    if (startReadiness.kind !== "ready") {
      this.logger.warn("snapshot.sandbox_start_attestation_rejected", { requestId: runRequest.requestId });
      return {
        attestationDigest,
        code: startReadiness.code,
        kind: "failed",
        requestDigest: request.requestDigest,
      };
    }
    if (startReadiness.attestationDigest !== attestationDigest) {
      this.logger.warn("snapshot.sandbox_start_attestation_rejected", { requestId: runRequest.requestId });
      return {
        attestationDigest,
        code: "sandbox-attestation-rejected",
        kind: "failed",
        requestDigest: request.requestDigest,
      };
    }
    const deadline = this.sandboxDeadline(this.timeoutMs);
    let capturedAbort: (() => void) | undefined;
    let trackedJob: TrackedFastManimSandboxJob | undefined;
    let result: FastManimSandboxBackendResultV1;
    try {
      const resultSettlement = await this.awaitBackendOperation(
        (operationSignal) => {
          // start() is a synchronous, non-blocking handle allocation seam;
          // all remote work belongs to result and must observe this signal.
          const candidate: unknown = this.backend.start(request, {
            attestationDigest,
            deadlineEpochMs: deadline.epochMs,
            identity: this.sandboxIdentity(runRequest.requestId),
            signal: operationSignal,
          });
          const captured = this.captureJobHandle(candidate, (abort) => {
            capturedAbort = abort;
          });
          trackedJob = this.trackJob(captured.abort, captured.result, runRequest.requestId);
          // A caller/shutdown abort may have fired while the synchronous
          // start() portion was blocking, before this handle was available.
          if (operationSignal.aborted) this.abortJob(trackedJob);
          return captured.result;
        },
        deadline,
        signal,
        () => {
          if (trackedJob) this.abortJob(trackedJob);
          else capturedAbort?.();
        },
        Math.min(MAX_SANDBOX_OPERATION_SETTLE_GRACE_MS, this.timeoutMs),
        () => {
          this.backendLifecycleRejected = true;
        },
      );
      if (resultSettlement.kind === "rejected") throw resultSettlement.reason;
      const rawResult = resultSettlement.value;
      const parsed = fastManimSandboxBackendResultV1Schema.safeParse(rawResult);
      if (!parsed.success) {
        this.logger.warn("snapshot.sandbox_result_shape_rejected", { requestId: runRequest.requestId });
        return {
          attestationDigest,
          code: "sandbox-result-rejected",
          kind: "failed",
          requestDigest: request.requestDigest,
        };
      }
      if (parsed.data.kind === "ok") {
        let resultBytes: Uint8Array;
        try {
          resultBytes = copyFastManimSandboxUint8ArrayV1(
            parsed.data.resultBytes,
            MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES,
          );
        } catch {
          this.backendLifecycleRejected = true;
          this.logger.warn("snapshot.sandbox_result_shape_rejected", { requestId: runRequest.requestId });
          return {
            attestationDigest,
            code: "sandbox-result-rejected",
            kind: "failed",
            requestDigest: request.requestDigest,
          };
        }
        result = { ...parsed.data, resultBytes };
      } else {
        result = parsed.data;
      }
    } catch (error) {
      if (signal?.aborted || this.closing) throw abortError();
      if (isServerOwnedErrorIdentity(fastManimSandboxOperationDeadlineErrors, error)) {
        return {
          attestationDigest,
          code: "producer-timeout",
          kind: "failed",
          requestDigest: request.requestDigest,
        };
      }
      if (isServerOwnedErrorIdentity(fastManimSandboxJobHandleRejectedErrors, error)) {
        if (capturedAbort) {
          try {
            capturedAbort();
          } catch {
            this.backendLifecycleRejected = true;
            this.logger.warn("snapshot.sandbox_job_abort_failed", {
              failure: "abort-threw",
              requestId: runRequest.requestId,
            });
          }
        }
        this.logger.warn("snapshot.sandbox_job_handle_rejected", { requestId: runRequest.requestId });
        return {
          attestationDigest,
          code: "sandbox-result-rejected",
          kind: "failed",
          requestDigest: request.requestDigest,
        };
      }
      const controlErrorCode = fastManimSandboxBackendControlErrorCode(error);
      if (controlErrorCode !== undefined) {
        if (controlErrorCode === "capacity") {
          throw new HttpError("Too many concurrent Scene snapshot runs on this server.", 429);
        }
        throw new HttpError("The Scene snapshot runtime directory could not be cleaned up.", 500);
      }
      this.logger.warn("snapshot.sandbox_execution_failed", {
        failure: "backend-operation-rejected",
        requestId: runRequest.requestId,
      });
      return {
        attestationDigest,
        code: "sandbox-execution-failed",
        kind: "failed",
        requestDigest: request.requestDigest,
      };
    }
    if (signal?.aborted || this.closing) throw abortError();
    if (result.requestDigest !== request.requestDigest || result.attestationDigest !== attestationDigest) {
      this.logger.warn("snapshot.sandbox_result_correlation_rejected", { requestId: runRequest.requestId });
      return {
        attestationDigest,
        code: "sandbox-result-rejected",
        kind: "failed",
        requestDigest: request.requestDigest,
      };
    }
    let completionReadiness: ReturnType<typeof resolveFastManimSandboxReadiness>;
    try {
      completionReadiness = await this.sandboxReadiness(runRequest.requestId, this.sandboxStatusDeadline(), signal);
    } catch {
      this.logger.warn("snapshot.sandbox_completion_health_check_failed", {
        failure: "backend-operation-rejected",
        requestId: runRequest.requestId,
      });
      completionReadiness = { code: "sandbox-unavailable", kind: "failed" };
    }
    if (completionReadiness.kind !== "ready") {
      this.logger.warn("snapshot.sandbox_completion_attestation_rejected", { requestId: runRequest.requestId });
      return {
        attestationDigest,
        code: completionReadiness.code,
        kind: "failed",
        requestDigest: request.requestDigest,
      };
    }
    if (completionReadiness.attestationDigest !== attestationDigest) {
      this.logger.warn("snapshot.sandbox_completion_attestation_rejected", { requestId: runRequest.requestId });
      return {
        attestationDigest,
        code: "sandbox-attestation-rejected",
        kind: "failed",
        requestDigest: request.requestDigest,
      };
    }
    // A completed result removes itself in trackJob(). A timed-out or aborted
    // promise remains tracked and quarantines the backend until it actually
    // settles or close() reaches its hard bound.
    return result;
  }

  async snapshot(query: FastManimSnapshotQueryV1): Promise<FastManimSnapshotRunViewV1> {
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    // Lookups are tracked like runs: close() awaits them, and busy reports
    // them, so owner release can never race a held revalidation into serving
    // a verified view after shutdown began.
    const pending = this.lookupLocked(query);
    this.activeLookups.add(pending);
    pending.catch(() => undefined);
    try {
      return await pending;
    } finally {
      this.activeLookups.delete(pending);
    }
  }

  private async lookupLocked(query: FastManimSnapshotQueryV1): Promise<FastManimSnapshotRunViewV1> {
    // A lookup holds its entry across async revalidation and a verified
    // freshness read, so a concurrent same-key republish can supersede it
    // mid-flight. Every terminal action below is entry-conditional
    // (compare-and-delete, compare-before-return); when the held entry is no
    // longer current the lookup retries against the fresh publication instead
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const view = await this.lookupCurrentEntry(query);
      if (view !== null) return view;
    }
    throw new HttpError("The published Scene snapshot kept changing during the lookup; retry the request.", 503);
  }

  private async lookupCurrentEntry(query: FastManimSnapshotQueryV1): Promise<FastManimSnapshotRunViewV1 | null> {
    const throwIfClosing = () => {
      if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    };
    const key = sceneKey(query.sourcePath, query.sceneName);
    const ownerId = this.ownerId;
    if (ownerId === null) throw new HttpError("No verified Scene snapshot has been published for this Scene.", 404);
    const entry = this.publicationStore.get(ownerId, key);
    if (!entry) throw new HttpError("No verified Scene snapshot has been published for this Scene.", 404);
    const entryIsCurrent = () => this.publicationStore.peek(ownerId, key) === entry;
    const deleteIfCurrent = () => {
      if (entryIsCurrent()) this.publicationStore.delete(ownerId, key);
    };
    if (Date.now() - entry.publishedAtEpochMs > this.publishRetentionMs) {
      if (!entryIsCurrent()) return null;
      deleteIfCurrent();
      throw new HttpError("No verified Scene snapshot has been published for this Scene.", 404);
    }
    let revalidated: VerifiedCompiledFastManimSnapshotResultV1;
    let sourceRuntimeIdentity = null;
    try {
      const parsed = await parseVerifiedFastManimSnapshotResultV1(entry.result, entry.expected);
      if (parsed.kind !== "compiled") {
        throw new FastManimSnapshotContractError(
          "profile-violation",
          "A published Scene snapshot must be a compiled result.",
        );
      }
      revalidated = parsed;
      sourceRuntimeIdentity =
        entry.sourceRuntimeIdentity === null
          ? null
          : parseVerifiedSourceRuntimeIdentityMapV1(entry.sourceRuntimeIdentity, revalidated);
    } catch {
      throwIfClosing();
      if (!entryIsCurrent()) return null;
      deleteIfCurrent();
      this.logger.error("snapshot.reverification_failed", { failure: "verification-rejected" });
      throw new HttpError("The published Scene snapshot failed re-verification.", 500);
    }
    throwIfClosing();
    const base = {
      projectId: this.projectId,
      requestId: entry.expected.requestId,
      runtimeConfigHash: entry.expected.runtimeConfigHash,
      sceneName: query.sceneName,
      schema: FAST_MANIM_SNAPSHOT_RUN_SCHEMA_V1,
      sourcePath: query.sourcePath,
      version: 1,
    } as const;
    const staleView = (): FastManimSnapshotRunViewV1 | null => {
      // Close beats stale: a lookup whose freshness read failed while (or
      // after) shutdown began must surface 503 rather than unpublish and
      // return a stale view once the GET-vs-close boundary has been crossed.
      throwIfClosing();
      // Stale only applies to the entry this lookup actually validated: if a
      // republish superseded it, the fresh entry must survive and the lookup
      // retries instead of reporting the dead revision.
      if (!entryIsCurrent()) return null;
      this.publicationStore.delete(ownerId, key);
      return fastManimSnapshotRunViewV1Schema.parse({
        ...base,
        fallback: FAST_MANIM_SNAPSHOT_FALLBACK_V1,
        revision: entry.revision,
        status: "stale",
      });
    };
    // Freshness uses the same hardened verified read as the run path: a
    // pathname swapped to a symlink, FIFO, outside file, or torn rewrite must
    // not vouch for the published snapshot. Any verified-read failure stales
    // and unpublishes rather than serving against unproven bytes.
    let current: FastManimSnapshotSourceReadV1;
    try {
      current = await this.sourceProvider.readVerified(query.sourcePath);
    } catch {
      return staleView();
    }
    if (
      current.hash !== entry.expected.sourceHash ||
      digestFastManimSnapshotRuntimeConfigV1(this.runtimeConfig()) !== entry.expected.runtimeConfigHash
    ) {
      return staleView();
    }
    throwIfClosing();
    // Never serve a revision that a concurrent republish already superseded.
    if (!entryIsCurrent()) return null;
    return parseServerOwnedFastManimRunView({
      ...base,
      publishedAt: entry.publishedAt,
      revision: entry.revision,
      snapshot: revalidated,
      ...(sourceRuntimeIdentity === null ? {} : { sourceRuntimeIdentity }),
      status: "verified",
    });
  }

  close() {
    this.closeRequest ??= this.closeLocked();
    return this.closeRequest;
  }

  private async closeBackendWithinDeadline() {
    const deadline = this.sandboxDeadline(this.sandboxCloseGraceMs);
    const closeSettlement = await this.awaitBackendOperation(
      () => {
        const pending = this.backend.close();
        return observeNativeFastManimSandboxPromise<void>(
          pending,
          () => {
            this.backendLifecycleRejected = true;
          },
          () => new FastManimSandboxJobHandleRejectedError(),
        );
      },
      deadline,
      undefined,
      undefined,
      0,
      () => {
        this.backendLifecycleRejected = true;
      },
      false,
    );
    if (closeSettlement.kind === "rejected") throw closeSettlement.reason;
  }

  private async closeLocked() {
    this.closing = true;
    for (const job of this.activeJobs) this.abortJob(job);
    this.shutdownController.abort();
    // Wait for every in-flight run and publication lookup to settle so
    // nothing publishes or serves after close, then return this runner's
    // publication accounting to the shared budget.
    await Promise.allSettled([...this.activeRuns, ...this.activeLookups]);
    try {
      try {
        await this.closeBackendWithinDeadline();
        // close() is part of the backend contract: success while a raw result
        // is still pending would lose the only server-side record of that job.
        await Promise.resolve();
        if (this.activeJobs.size > 0 || this.activeStatuses.size > 0) {
          this.backendLifecycleRejected = true;
          this.logger.error("snapshot.sandbox_close_left_active_operations", {
            jobs: this.activeJobs.size,
            statuses: this.activeStatuses.size,
          });
          throw new FastManimSandboxBackendControlError("cleanup");
        }
      } catch (error) {
        if (fastManimSandboxBackendControlErrorCode(error) === "cleanup") {
          throw new HttpError("The Scene snapshot runtime directory could not be cleaned up.", 500);
        }
        this.logger.error("snapshot.sandbox_close_failed", { failure: "backend-close-rejected" });
        throw new HttpError("The sandbox backend could not be closed safely.", 500);
      }
    } finally {
      // Once the runner is permanently closed and bounded backend cleanup has
      // completed or failed, retaining never-settling foreign promises would
      // itself become an unbounded memory leak.
      this.activeJobs.clear();
      this.activeStatuses.clear();
      if (this.ownerId !== null) this.publicationStore.releaseOwner(this.ownerId);
    }
  }
}
