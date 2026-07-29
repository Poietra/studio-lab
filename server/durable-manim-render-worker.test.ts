import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type DurableManimRenderExecutorV1,
  DurableManimRenderWorkerV1,
  durableManimRenderJobIdV1,
} from "./durable-manim-render-worker";
import { HttpError } from "./http/json";
import type { DurableRenderSessionV1, RenderSessionRepositoryV1 } from "./storage/render-session-repository";
import type { VerifiedArtifactPublisherV1 } from "./storage/verified-artifact-publisher";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function partial<T>(value: Partial<T>): T {
  return value as T;
}

function session(overrides: Partial<DurableRenderSessionV1> = {}): DurableRenderSessionV1 {
  const now = new Date("2026-07-28T00:00:00.000Z");
  const digest = "1".repeat(64);
  const patchedDigest = "2".repeat(64);
  return {
    artifactLocator: null,
    commitCorrelationKey: "commit-key",
    createdAt: now,
    deadline: new Date(Date.now() + 60_000),
    error: null,
    executionAttempts: 1,
    failureCode: null,
    fenceToken: 1n,
    id: "00000000-0000-4000-8000-000000000001",
    latestAction: null,
    lease: { expiresAt: new Date(now.getTime() + 30_000), ownerId: "worker-a" },
    logTail: "",
    original: {
      blob: {
        byteSize: 100,
        digest,
        etag: "original-etag",
        objectKey: `tenants/tenant-a/sources/${digest}`,
        versionId: "original-version",
      },
      generation: 1n,
    },
    patch: { anchorLine: 4, anchorLines: [4], insertedCode: "self.wait(2)" },
    patched: {
      blob: {
        byteSize: 110,
        digest: patchedDigest,
        etag: "patched-etag",
        objectKey: `tenants/tenant-a/sources/${patchedDigest}`,
        versionId: "patched-version",
      },
    },
    programBatchId: "batch-1",
    programTransactionId: "transaction-1",
    progress: 0.2,
    projectId: "project-a",
    projectPng: null,
    renderRequestId: "render-1",
    sceneName: "MainScene",
    sourcePath: "main.py",
    status: "rendering",
    tenantId: "tenant-a",
    updatedAt: now,
    version: 2n,
    ...overrides,
  };
}

function fixture(
  options: Readonly<{
    claimed?: DurableRenderSessionV1;
    publisher?: Pick<VerifiedArtifactPublisherV1, "publish" | "ready">;
  }> = {},
) {
  const queued = session({ executionAttempts: 0, fenceToken: 0n, lease: null, status: "preparing", version: 1n });
  const claimed = options.claimed ?? session();
  const completeLease = vi.fn<RenderSessionRepositoryV1["completeLease"]>(async () =>
    session({ lease: null, progress: 1, status: "ready", version: 3n }),
  );
  const renewLease = vi.fn<RenderSessionRepositoryV1["renewLease"]>(async () => claimed);
  const repository = partial<RenderSessionRepositoryV1>({
    claimLease: vi.fn(async () => claimed),
    completeLease,
    expireTimedOutSessions: vi.fn(async () => 0),
    findRecoverableSessions: vi.fn(async () => [queued]),
    readSession: vi.fn(async () => claimed),
    ready: vi.fn(async () => true),
    renewLease,
  });
  const close = vi.fn(async () => undefined);
  const cancel = vi.fn<DurableManimRenderExecutorV1["cancel"]>(async () => ({ fenceDigest: "a".repeat(64) }));
  const cleanup = vi.fn<DurableManimRenderExecutorV1["cleanup"]>(async () => undefined);
  const submitOrReattach = vi.fn<DurableManimRenderExecutorV1["submitOrReattach"]>(async () => ({
    artifactLocator: "artifact:verified",
    kind: "ready",
    logTail: "ok",
  }));
  const executor = {
    cancel,
    cleanup,
    close,
    ready: vi.fn(async () => true),
    submitOrReattach,
  };
  const failures: unknown[] = [];
  const worker = new DurableManimRenderWorkerV1({
    brokerShardId: "broker-a",
    executor,
    leaseDurationMs: 1_000,
    maxConcurrentJobs: 1,
    onFailure: (error) => failures.push(error),
    pollIntervalMs: 1_000,
    ...(options.publisher ? { publisher: options.publisher } : {}),
    repository,
    tenantId: "tenant-a",
    workerId: "worker-a",
  });
  return {
    cancel,
    claimed,
    cleanup,
    close,
    completeLease,
    executor,
    failures,
    renewLease,
    repository,
    submitOrReattach,
    worker,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DurableManimRenderWorkerV1", () => {
  it("claims queued work and publishes only the fenced executor result", async () => {
    const { claimed, close, completeLease, repository, submitOrReattach, worker } = fixture();

    await worker.runOnce();

    expect(submitOrReattach).toHaveBeenCalledWith({
      jobId: durableManimRenderJobIdV1("tenant-a", claimed.id),
      session: claimed,
      signal: expect.any(AbortSignal),
    });
    expect(repository.claimLease).toHaveBeenCalledWith(
      {
        brokerShardId: "broker-a",
        leaseDurationMs: 1_000,
        ownerId: "worker-a",
        sessionId: claimed.id,
        tenantId: "tenant-a",
      },
      expect.any(AbortSignal),
    );
    expect(completeLease).toHaveBeenCalledWith({
      artifactLocator: "artifact:verified",
      error: null,
      expectedVersion: claimed.version,
      failureCode: null,
      fenceToken: claimed.fenceToken,
      logTail: "ok",
      ownerId: "worker-a",
      progress: 1,
      sessionId: claimed.id,
      status: "ready",
      tenantId: "tenant-a",
    });
    await worker.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts a session while its lease claim is still pending without contacting the broker", async () => {
    const claim = deferred<DurableRenderSessionV1>();
    const { cancel, claimed, repository, submitOrReattach, worker } = fixture();
    vi.mocked(repository.claimLease).mockImplementationOnce(async () => claim.promise);

    const run = worker.runOnce();
    await vi.waitFor(() => expect(repository.claimLease).toHaveBeenCalledOnce());
    worker.abortActive(claimed.id);
    claim.resolve(claimed);
    await run;

    expect(vi.mocked(repository.claimLease).mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(submitOrReattach).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await worker.close();
  });

  it("aborts an active executor read for the relay without directly cancelling the broker", async () => {
    const entered = deferred<void>();
    const { cancel, claimed, completeLease, submitOrReattach, worker } = fixture();
    let executionSignal: AbortSignal | undefined;
    submitOrReattach.mockImplementationOnce(async (request) => {
      executionSignal = request.signal;
      entered.resolve();
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { code: "interrupted", kind: "failed", logTail: "" };
    });
    const run = worker.runOnce();
    await entered.promise;
    worker.abortActive(claimed.id);
    await run;

    expect(executionSignal?.aborted).toBe(true);
    expect(completeLease).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await worker.close();
  });

  it("turns a broker reattach failure into a bounded interrupted terminal state", async () => {
    const { claimed, completeLease, submitOrReattach, worker } = fixture();
    submitOrReattach.mockRejectedValueOnce(new Error("broker leaked a sensitive traceback"));

    await worker.runOnce();

    expect(completeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Render execution was interrupted.",
        expectedVersion: claimed.version,
        failureCode: "interrupted",
        logTail: "",
        status: "failed",
      }),
    );
    expect(completeLease.mock.calls[0]?.[0].error).not.toContain("sensitive traceback");
    await worker.close();
  });

  it("lets a lease owner complete a broker-fenced job as cancelled", async () => {
    const { claimed, cleanup, completeLease, submitOrReattach, worker } = fixture();
    submitOrReattach.mockResolvedValueOnce({ code: "cancelled", kind: "failed", logTail: "" });

    await worker.runOnce();

    expect(completeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        error: null,
        expectedVersion: claimed.version,
        failureCode: "cancelled",
        fenceToken: claimed.fenceToken,
        status: "cancelled",
      }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
    await worker.close();
  });

  it("does not submit an expired job and durably records its deadline", async () => {
    const expired = session({ deadline: new Date("2026-07-27T23:59:59.000Z") });
    const { completeLease, submitOrReattach, worker } = fixture({ claimed: expired });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));

    await worker.runOnce();

    expect(submitOrReattach).not.toHaveBeenCalled();
    expect(completeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Render execution deadline exceeded.",
        failureCode: "deadline-exceeded",
        status: "failed",
      }),
    );
    await worker.close();
  });

  it("keeps an in-flight deadline authoritative over an abort-aware executor result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const claimed = session({ deadline: new Date(Date.now() + 1_000) });
    const entered = deferred<void>();
    const { completeLease, submitOrReattach, worker } = fixture({ claimed });
    submitOrReattach.mockImplementationOnce(async ({ signal }) => {
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { code: "interrupted", kind: "failed", logTail: "" };
    });

    const running = worker.runOnce();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    await running;

    expect(completeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Render execution deadline exceeded.",
        failureCode: "deadline-exceeded",
        status: "failed",
      }),
    );
    await worker.close();
  });

  it("renews the lease while a broker job remains attached", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const execution = deferred<Readonly<{ artifactLocator: null; kind: "ready"; logTail: string }>>();
    const { claimed, renewLease, submitOrReattach, worker } = fixture();
    submitOrReattach.mockImplementationOnce(async () => execution.promise);

    const run = worker.runOnce();
    await vi.waitFor(() => expect(submitOrReattach).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(334);
    expect(renewLease).toHaveBeenCalledWith(
      {
        expectedVersion: claimed.version,
        fenceToken: claimed.fenceToken,
        leaseDurationMs: 1_000,
        ownerId: "worker-a",
        sessionId: claimed.id,
        tenantId: "tenant-a",
      },
      expect.any(AbortSignal),
    );
    execution.resolve({ artifactLocator: null, kind: "ready", logTail: "done" });
    await run;
    await worker.close();
  });

  it("aborts broker work on close and leaves completion to the next lease owner", async () => {
    const attached = deferred<void>();
    const { completeLease, submitOrReattach, worker } = fixture();
    submitOrReattach.mockImplementationOnce(
      ({ signal }) =>
        new Promise((resolve) => {
          attached.resolve();
          signal.addEventListener("abort", () => resolve({ code: "interrupted", kind: "failed", logTail: "" }), {
            once: true,
          });
        }),
    );

    const run = worker.runOnce();
    await attached.promise;
    await worker.close();
    await run;

    expect(completeLease).not.toHaveBeenCalled();
  });

  it("keeps the batch owned until every concurrent job settles after one unexpected failure", async () => {
    const first = session({ id: "00000000-0000-4000-8000-000000000001" });
    const second = session({ id: "00000000-0000-4000-8000-000000000002" });
    const secondExecution = deferred<Readonly<{ artifactLocator: null; kind: "ready"; logTail: string }>>();
    const { completeLease, repository, submitOrReattach, worker } = fixture();
    repository.findRecoverableSessions = vi.fn(async () => [first, second]);
    repository.claimLease = vi.fn(async ({ sessionId }) => (sessionId === first.id ? first : second));
    completeLease.mockImplementation(async ({ sessionId }) => {
      if (sessionId === first.id) throw new Error("unexpected repository failure");
      return session({ id: sessionId, lease: null, progress: 1, status: "ready", version: 3n });
    });
    submitOrReattach.mockImplementation(({ session: claimed }) => {
      if (claimed.id === first.id) {
        return Promise.resolve({ artifactLocator: null, kind: "ready", logTail: "first done" });
      }
      return secondExecution.promise;
    });

    const run = worker.runOnce();
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(submitOrReattach).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(worker.runOnce()).toBe(run);

    secondExecution.resolve({ artifactLocator: null, kind: "ready", logTail: "done" });
    await expect(run).rejects.toThrow("unexpected repository failure");
    await worker.close();
  });

  it("sweeps DB-expired sessions before executor readiness and retries future work later", async () => {
    const { executor, repository, submitOrReattach, worker } = fixture();
    const expireTimedOutSessions = vi.mocked(repository.expireTimedOutSessions);
    const findRecoverableSessions = vi.mocked(repository.findRecoverableSessions);
    executor.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await worker.runOnce();

    expect(expireTimedOutSessions).toHaveBeenCalledWith("tenant-a", 1, expect.any(AbortSignal));
    expect(findRecoverableSessions).not.toHaveBeenCalled();
    expect(submitOrReattach).not.toHaveBeenCalled();

    await worker.runOnce();

    expect(expireTimedOutSessions).toHaveBeenCalledTimes(2);
    expect(findRecoverableSessions).toHaveBeenCalledWith("tenant-a", "broker-a", 1, expect.any(AbortSignal));
    expect(submitOrReattach).toHaveBeenCalledOnce();
    await worker.close();
  });

  it("publishes a staged bundle atomically and cleans it after the DB terminal commit", async () => {
    const publisher = {
      publish: vi.fn(async () => undefined),
      ready: vi.fn(async () => true),
    };
    const { claimed, cleanup, completeLease, submitOrReattach, worker } = fixture({ publisher });
    submitOrReattach.mockResolvedValueOnce({
      artifactLocator: "legacy-video",
      kind: "ready",
      logTail: "published",
      stagingLocators: { thumbnail: "thumbnail-locator", video: "video-locator" },
    });

    await worker.runOnce();

    expect(publisher.publish).toHaveBeenCalledWith(
      {
        locators: { thumbnail: "thumbnail-locator", video: "video-locator" },
        logTail: "published",
        ownerId: "worker-a",
        session: claimed,
      },
      expect.any(AbortSignal),
    );
    expect(completeLease).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith({
      jobId: durableManimRenderJobIdV1("tenant-a", claimed.id),
      sessionId: claimed.id,
      tenantId: "tenant-a",
    });
    await worker.close();
  });

  it("leaves a transient publication failure recoverable without clearing staging", async () => {
    const unavailable = new Error("S3 temporarily unavailable");
    const publisher = {
      publish: vi.fn(async () => Promise.reject(unavailable)),
      ready: vi.fn(async () => true),
    };
    const { cleanup, completeLease, submitOrReattach, worker } = fixture({ publisher });
    submitOrReattach.mockResolvedValueOnce({
      kind: "ready",
      logTail: "rendered",
      stagingLocators: { thumbnail: "thumbnail-locator", video: "video-locator" },
    });

    await expect(worker.runOnce()).rejects.toBe(unavailable);
    expect(completeLease).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    await worker.close();
  });

  it.each([
    { code: "memory-limit" as const, error: "Render exceeded its memory limit." },
    { code: "cpu-limit" as const, error: "Render exceeded its CPU budget." },
  ])("persists $code before cleaning partial staging", async ({ code, error }) => {
    const { claimed, cleanup, completeLease, submitOrReattach, worker } = fixture();
    submitOrReattach.mockResolvedValueOnce({ code, kind: "failed", logTail: "bounded" });

    await worker.runOnce();

    expect(completeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        error,
        expectedVersion: claimed.version,
        failureCode: code,
        status: "failed",
      }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
    await worker.close();
  });

  it("does not clear a new owner's staging after terminal completion loses its fence", async () => {
    const { cleanup, completeLease, submitOrReattach, worker } = fixture();
    submitOrReattach.mockResolvedValueOnce({ code: "render-failed", kind: "failed", logTail: "bounded" });
    completeLease.mockRejectedValueOnce(new HttpError("stale", 409));

    await worker.runOnce();

    expect(cleanup).not.toHaveBeenCalled();
    await worker.close();
  });

  it("cleans published staging even when the atomic DB commit makes the heartbeat stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const publication = deferred<void>();
    const publisher = {
      publish: vi.fn(async () => publication.promise),
      ready: vi.fn(async () => true),
    };
    const { cleanup, renewLease, submitOrReattach, worker } = fixture({ publisher });
    submitOrReattach.mockResolvedValueOnce({
      kind: "ready",
      logTail: "published",
      stagingLocators: { thumbnail: "thumbnail-locator", video: "video-locator" },
    });
    renewLease.mockRejectedValueOnce(new HttpError("already terminal", 409));

    const run = worker.runOnce();
    await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(334);
    publication.resolve();
    await run;

    expect(cleanup).toHaveBeenCalledOnce();
    await worker.close();
  });
});
