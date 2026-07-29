import { randomUUID } from "node:crypto";

import { HttpError } from "./http/json";
import { manimTenantIdSchema } from "./manim-request-principal";
import {
  type DurableRenderSessionV1,
  MAX_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
  MAX_DURABLE_RENDER_LEASE_MS_V1,
  type RenderSessionRepositoryV1,
} from "./storage/render-session-repository";
import type { RenderStagingLocatorsV1, VerifiedArtifactPublisherV1 } from "./storage/verified-artifact-publisher";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_MAX_CONCURRENT_JOBS = 2;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_LEASE_DURATION_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 25;
const MAX_POLL_INTERVAL_MS = 60_000;

export type DurableManimRenderExecutionResultV1 =
  | Readonly<{
      artifactLocator?: string | null;
      stagingLocators?: RenderStagingLocatorsV1;
      kind: "ready";
      logTail: string;
    }>
  | Readonly<{
      code: "cancelled" | "interrupted" | "render-failed";
      kind: "failed";
      logTail: string;
    }>;

export type DurableManimRenderExecutionRequestV1 = Readonly<{
  /** Stable idempotency key. A broker must submit-or-reattach, never duplicate it. */
  jobId: string;
  session: DurableRenderSessionV1;
  signal: AbortSignal;
}>;

export type DurableManimRenderCancellationRequestV1 = Readonly<{
  jobId: string;
  rejectUntilEpochMs: number;
  sessionId: string;
  tenantId: string;
}>;

export type DurableManimRenderCleanupRequestV1 = Readonly<{
  jobId: string;
  sessionId: string;
  tenantId: string;
}>;

type CancellationState = {
  deadlineEpochMs: number;
  durable: boolean;
  pending: number;
};

export interface DurableManimRenderExecutorV1 {
  cancel(request: DurableManimRenderCancellationRequestV1): Promise<void>;
  close(): Promise<void>;
  cleanup(request: DurableManimRenderCleanupRequestV1): Promise<void>;
  ready(signal?: AbortSignal): Promise<boolean>;
  submitOrReattach(request: DurableManimRenderExecutionRequestV1): Promise<DurableManimRenderExecutionResultV1>;
}

export type DurableManimRenderWorkerOptionsV1 = Readonly<{
  executor: DurableManimRenderExecutorV1;
  leaseDurationMs?: number;
  maxConcurrentJobs?: number;
  onFailure: (error: unknown) => void;
  pollIntervalMs?: number;
  publisher?: Pick<VerifiedArtifactPublisherV1, "publish" | "ready">;
  repository: RenderSessionRepositoryV1;
  tenantId: string;
  workerId?: string;
}>;

function boundedInteger(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function workerId(value: string) {
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 240) {
    throw new TypeError("The durable render worker ID is invalid.");
  }
  return value;
}

function interruptedError(signal: AbortSignal) {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(interruptedError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    function finish() {
      cleanup();
      resolve();
    }
    function abort() {
      cleanup();
      reject(interruptedError(signal));
    }
  });
}

function expectedConflict(error: unknown) {
  return error instanceof HttpError && error.status === 409;
}

function executionFailureMessage(code: "cancelled" | "interrupted" | "render-failed") {
  if (code === "cancelled") return null;
  return code === "interrupted" ? "Render execution was interrupted." : "The sandbox render failed.";
}

/** Tenant ownership is part of the stable broker idempotency key. */
export function durableManimRenderJobIdV1(tenantId: string, sessionId: string) {
  return `${tenantId}/${sessionId}`;
}

/**
 * Concrete PostgreSQL queue consumer. The executor port is implemented by #117;
 * this worker owns leasing, heartbeats, crash reattachment and fenced completion.
 */
export class DurableManimRenderWorkerV1 {
  readonly #closeAbort = new AbortController();
  readonly #executor: DurableManimRenderExecutorV1;
  readonly #heartbeatIntervalMs: number;
  readonly #leaseDurationMs: number;
  readonly #maxConcurrentJobs: number;
  readonly #onFailure: (error: unknown) => void;
  readonly #pollIntervalMs: number;
  readonly #publisher: Pick<VerifiedArtifactPublisherV1, "publish" | "ready"> | undefined;
  readonly #repository: RenderSessionRepositoryV1;
  readonly #tenantId: string;
  readonly #workerId: string;
  readonly #activeJobAborts = new Map<string, AbortController>();
  readonly #cancellations = new Map<string, CancellationState>();
  #closeRequest: Promise<void> | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #runRequest: Promise<void> | null = null;
  #started = false;
  #wakeAfterRun = false;

  constructor(options: DurableManimRenderWorkerOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!tenant.success) throw new TypeError("The durable render worker tenant ID is invalid.");
    this.#tenantId = tenant.data;
    this.#workerId = workerId(options.workerId ?? `worker-${randomUUID()}`);
    this.#leaseDurationMs = boundedInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
      MIN_LEASE_DURATION_MS,
      MAX_DURABLE_RENDER_LEASE_MS_V1,
    );
    this.#heartbeatIntervalMs = Math.max(1, Math.floor(this.#leaseDurationMs / 3));
    this.#pollIntervalMs = boundedInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    );
    this.#maxConcurrentJobs = boundedInteger(
      options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
      "maxConcurrentJobs",
      1,
      16,
    );
    this.#repository = options.repository;
    this.#publisher = options.publisher;
    this.#executor = options.executor;
    this.#onFailure = options.onFailure;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const [repositoryReady, executorReady, publisherReady] = await Promise.all([
      this.#repository.ready(signal),
      this.#executor.ready(signal),
      this.#publisher?.ready(signal) ?? true,
    ]);
    signal?.throwIfAborted();
    return repositoryReady && executorReady && publisherReady;
  }

  start() {
    if (this.#closeRequest) throw new Error("The durable render worker is closed.");
    if (!this.#started) {
      this.#started = true;
      this.#schedule(0);
    }
    return this;
  }

  wake() {
    if (!this.#started || this.#closeRequest) return;
    if (this.#runRequest) {
      this.#wakeAfterRun = true;
      return;
    }
    this.#schedule(0);
  }

  async cancel(sessionId: string) {
    const cancellation = this.#cancellations.get(sessionId) ?? {
      deadlineEpochMs: Date.now() + MAX_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
      durable: false,
      pending: 0,
    };
    cancellation.deadlineEpochMs = Math.max(
      cancellation.deadlineEpochMs,
      Date.now() + MAX_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
    );
    cancellation.pending += 1;
    this.#cancellations.set(sessionId, cancellation);
    this.#activeJobAborts
      .get(sessionId)
      ?.abort(new DOMException("The durable render session was cancelled.", "AbortError"));
    try {
      const session = await this.#repository.readSession(this.#tenantId, sessionId);
      cancellation.deadlineEpochMs = session.deadline.getTime();
      await this.#executor.cancel({
        jobId: durableManimRenderJobIdV1(this.#tenantId, sessionId),
        rejectUntilEpochMs: cancellation.deadlineEpochMs,
        sessionId,
        tenantId: this.#tenantId,
      });
      cancellation.durable = true;
    } finally {
      cancellation.pending -= 1;
      if (!cancellation.durable && cancellation.pending === 0 && this.#cancellations.get(sessionId) === cancellation) {
        this.#cancellations.delete(sessionId);
      }
    }
  }

  runOnce(signal: AbortSignal = this.#closeAbort.signal) {
    if (this.#runRequest) return this.#runRequest;
    const request = this.#run(signal).finally(() => {
      if (this.#runRequest === request) this.#runRequest = null;
    });
    this.#runRequest = request;
    return request;
  }

  async #run(signal: AbortSignal) {
    signal.throwIfAborted();
    const now = Date.now();
    for (const [sessionId, cancellation] of this.#cancellations) {
      if (cancellation.pending === 0 && cancellation.deadlineEpochMs <= now) this.#cancellations.delete(sessionId);
    }
    if (!(await this.#repository.ready(signal))) return;
    await this.#repository.expireTimedOutSessions(this.#tenantId, this.#maxConcurrentJobs, signal);
    if (!(await this.#executor.ready(signal))) return;
    if (this.#publisher && !(await this.#publisher.ready(signal))) return;
    const recoverable = await this.#repository.findRecoverableSessions(this.#tenantId, this.#maxConcurrentJobs, signal);
    const settlements = await Promise.allSettled(recoverable.map((session) => this.#claimAndExecute(session, signal)));
    const failures = settlements.flatMap((settlement) => (settlement.status === "rejected" ? [settlement.reason] : []));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Multiple durable render jobs failed unexpectedly.");
  }

  async #claimAndExecute(session: DurableRenderSessionV1, signal: AbortSignal) {
    const jobAbort = new AbortController();
    const abortFromParent = () => jobAbort.abort(interruptedError(signal));
    if (signal.aborted) abortFromParent();
    else signal.addEventListener("abort", abortFromParent, { once: true });
    if (this.#activeJobAborts.has(session.id)) {
      signal.removeEventListener("abort", abortFromParent);
      throw new Error("The durable render session is already active in this worker.");
    }
    this.#activeJobAborts.set(session.id, jobAbort);
    const cancellation = this.#cancellations.get(session.id);
    if (cancellation && (cancellation.pending > 0 || cancellation.deadlineEpochMs > Date.now())) {
      jobAbort.abort(new DOMException("The durable render session was cancelled.", "AbortError"));
    }
    try {
      let claimed: DurableRenderSessionV1;
      try {
        claimed = await this.#repository.claimLease(
          {
            leaseDurationMs: this.#leaseDurationMs,
            ownerId: this.#workerId,
            sessionId: session.id,
            tenantId: this.#tenantId,
          },
          jobAbort.signal,
        );
      } catch (error) {
        if (jobAbort.signal.aborted) return;
        if (expectedConflict(error)) return;
        throw error;
      }
      if (jobAbort.signal.aborted) return;
      await this.#executeClaimed(claimed, jobAbort.signal);
    } finally {
      signal.removeEventListener("abort", abortFromParent);
      if (this.#activeJobAborts.get(session.id) === jobAbort) this.#activeJobAborts.delete(session.id);
    }
  }

  async #executeClaimed(claimed: DurableRenderSessionV1, parentSignal: AbortSignal) {
    const jobAbort = new AbortController();
    let deadlineReached = claimed.deadline.getTime() <= Date.now();
    let leaseLost = false;
    const abortFromParent = () => jobAbort.abort(interruptedError(parentSignal));
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
    let deadlineTimer: NodeJS.Timeout | null = null;
    if (deadlineReached) jobAbort.abort(new Error("The durable render execution deadline elapsed."));
    else {
      deadlineTimer = setTimeout(() => {
        deadlineReached = true;
        jobAbort.abort(new Error("The durable render execution deadline elapsed."));
      }, claimed.deadline.getTime() - Date.now());
      deadlineTimer.unref();
    }

    const heartbeat = (async () => {
      while (!jobAbort.signal.aborted) {
        try {
          await abortableDelay(this.#heartbeatIntervalMs, jobAbort.signal);
          if (jobAbort.signal.aborted) return;
          await this.#repository.renewLease(
            {
              expectedVersion: claimed.version,
              fenceToken: claimed.fenceToken,
              leaseDurationMs: this.#leaseDurationMs,
              ownerId: this.#workerId,
              sessionId: claimed.id,
              tenantId: this.#tenantId,
            },
            jobAbort.signal,
          );
        } catch (error) {
          if (jobAbort.signal.aborted) return;
          leaseLost = true;
          jobAbort.abort(error);
          return;
        }
      }
    })();

    const execution = deadlineReached
      ? null
      : Promise.resolve().then(() =>
          this.#executor.submitOrReattach({
            jobId: durableManimRenderJobIdV1(this.#tenantId, claimed.id),
            session: claimed,
            signal: jobAbort.signal,
          }),
        );
    const outcome = execution
      ? await Promise.race([
          execution.then(
            (result) => ({ kind: "result", result }) as const,
            (error: unknown) => ({ error, kind: "error" }) as const,
          ),
          waitForAbort(jobAbort.signal).then(() => ({ kind: "aborted" }) as const),
        ])
      : ({ kind: "aborted" } as const);

    let published = false;
    let publicationError: unknown;
    if (outcome.kind === "result" && outcome.result.kind === "ready" && this.#publisher && !jobAbort.signal.aborted) {
      try {
        if (!outcome.result.stagingLocators) {
          throw new Error("The production render executor returned no staged media bundle.");
        }
        await this.#publisher.publish(
          {
            locators: outcome.result.stagingLocators,
            logTail: outcome.result.logTail,
            ownerId: this.#workerId,
            session: claimed,
          },
          jobAbort.signal,
        );
        published = true;
      } catch (error) {
        publicationError = error;
      }
    }
    if (!jobAbort.signal.aborted) jobAbort.abort();
    if (deadlineTimer) clearTimeout(deadlineTimer);
    parentSignal.removeEventListener("abort", abortFromParent);
    await heartbeat;
    if (published) {
      await this.#cleanupStaging(claimed.id);
      return;
    }
    if (parentSignal.aborted || this.#closeAbort.signal.aborted || leaseLost) return;
    if (publicationError !== undefined) {
      if (expectedConflict(publicationError)) return;
      throw publicationError;
    }
    const failed = outcome.kind !== "result" || outcome.result.kind === "failed" || publicationError !== undefined;
    const failureCode =
      publicationError !== undefined
        ? "render-failed"
        : outcome.kind === "result" && outcome.result.kind === "failed"
          ? outcome.result.code
          : "interrupted";
    const cancelled = failureCode === "cancelled";
    try {
      await this.#repository.completeLease({
        ...(outcome.kind === "result" && outcome.result.kind === "ready"
          ? { artifactLocator: outcome.result.artifactLocator ?? null }
          : {}),
        error: failed ? executionFailureMessage(failureCode) : null,
        expectedVersion: claimed.version,
        fenceToken: claimed.fenceToken,
        logTail: outcome.kind === "result" ? outcome.result.logTail : "",
        ownerId: this.#workerId,
        progress: failed ? claimed.progress : 1,
        sessionId: claimed.id,
        status: cancelled ? "cancelled" : failed ? "failed" : "ready",
        tenantId: this.#tenantId,
      });
      if (failed) await this.#cleanupStaging(claimed.id);
    } catch (error) {
      if (!expectedConflict(error)) throw error;
    }
  }

  async #cleanupStaging(sessionId: string) {
    try {
      await this.#executor.cleanup({
        jobId: durableManimRenderJobIdV1(this.#tenantId, sessionId),
        sessionId,
        tenantId: this.#tenantId,
      });
    } catch (error) {
      this.#reportFailure(error);
    }
  }

  #schedule(delayMs: number) {
    if (this.#closeRequest) return;
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.runOnce()
        .catch((error: unknown) => {
          if (!this.#closeAbort.signal.aborted) this.#reportFailure(error);
        })
        .finally(() => {
          if (this.#closeRequest) return;
          const delay = this.#wakeAfterRun ? 0 : this.#pollIntervalMs;
          this.#wakeAfterRun = false;
          this.#schedule(delay);
        });
    }, delayMs);
    this.#pollTimer.unref();
  }

  #reportFailure(error: unknown) {
    try {
      this.#onFailure(error);
    } catch {
      // A monitoring hook must not terminate the durable queue consumer.
    }
  }

  close() {
    this.#closeRequest ??= (async () => {
      if (this.#pollTimer) clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
      this.#closeAbort.abort(new DOMException("The durable render worker is closing.", "AbortError"));
      await this.#runRequest?.catch(() => undefined);
      await this.#executor.close();
    })();
    return this.#closeRequest;
  }
}
