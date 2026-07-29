import { describe, expect, it, vi } from "vitest";

import type { RenderCommitRequest } from "../src/render-pipeline/contracts";
import { DurableManimRenderServiceV1 } from "./durable-manim-render-service";
import { HttpError } from "./http/json";
import { request, sceneSource } from "./manim-render-pipeline-test-fixtures";
import { renderCommitCorrelationKey } from "./manim-render-session-policy";
import { sourceHash } from "./manim-source-store";
import type {
  CreateDurableRenderSessionInputV1,
  DurableRenderSessionV1,
  RenderSessionRepositoryV1,
} from "./storage/render-session-repository";
import type {
  SourceBlobReceiptV1,
  SourceContentBlobStoreV1,
  WorkspaceSourceHeadV1,
  WorkspaceSourceRepositoryV1,
} from "./storage/workspace-source-repository";

function partial<T>(value: Partial<T>): T {
  return value as T;
}

function receipt(digest: string, version = "version-1"): SourceBlobReceiptV1 {
  return {
    byteSize: 100,
    digest,
    etag: `etag-${version}`,
    objectKey: `tenants/tenant-a/sources/${digest}`,
    versionId: version,
  };
}

const originalHead: WorkspaceSourceHeadV1 = {
  blob: receipt(sourceHash(sceneSource)),
  generation: 3n,
  projectId: "default",
  sourcePath: "scene.py",
  tenantId: "tenant-a",
};

function sessionFromCreate(input: CreateDurableRenderSessionInputV1): DurableRenderSessionV1 {
  const now = new Date("2026-07-28T00:00:00.000Z");
  return {
    artifactLocator: null,
    commitCorrelationKey: input.commitCorrelationKey,
    createdAt: now,
    deadline: new Date(now.getTime() + input.executionTimeoutMs),
    error: null,
    executionAttempts: 0,
    failureCode: null,
    fenceToken: 0n,
    id: input.id,
    latestAction: null,
    lease: null,
    logTail: "",
    original: { blob: input.originalHead.blob, generation: input.originalHead.generation },
    patch: input.patch,
    patched: { blob: input.patchedBlob },
    programBatchId: input.programBatchId,
    programTransactionId: input.programTransactionId,
    progress: 0,
    projectId: input.originalHead.projectId,
    projectPng: null,
    renderRequestId: input.renderRequestId,
    sceneName: input.sceneName,
    sourcePath: input.originalHead.sourcePath,
    status: "preparing",
    tenantId: input.tenantId,
    updatedAt: now,
    version: 1n,
  };
}

function fixture(
  overrides: Readonly<{
    createSession?: RenderSessionRepositoryV1["createSession"];
    putSource?: SourceContentBlobStoreV1["putSource"];
    readSession?: RenderSessionRepositoryV1["readSession"];
  }> = {},
) {
  const putSource = vi.fn<SourceContentBlobStoreV1["putSource"]>(async (_tenantId, source, signal) =>
    overrides.putSource
      ? overrides.putSource(_tenantId, source, signal)
      : receipt(sourceHash(source), "patched-version"),
  );
  const queueBlobDeletion = vi.fn<WorkspaceSourceRepositoryV1["queueBlobDeletion"]>(async () => null);
  const createSession = vi.fn<RenderSessionRepositoryV1["createSession"]>(
    overrides.createSession ?? (async (input) => sessionFromCreate(input)),
  );
  const readSession = vi.fn<RenderSessionRepositoryV1["readSession"]>(
    overrides.readSession ??
      (async () => {
        const input = createSession.mock.calls[0]?.[0];
        if (!input) throw new HttpError("Render session not found.", 404);
        return sessionFromCreate(input);
      }),
  );
  const close = vi.fn(async () => undefined);
  const abandonSession = vi.fn<RenderSessionRepositoryV1["abandonSession"]>(async () => true);
  const repository = partial<RenderSessionRepositoryV1>({
    abandonSession,
    applySourceAction: vi.fn(),
    close,
    createSession,
    readSession,
    ready: vi.fn(async () => true),
  });
  const sourceRepository = partial<WorkspaceSourceRepositoryV1>({
    queueBlobDeletion,
    readSourceHead: vi.fn(async () => originalHead),
  });
  const blobs = partial<SourceContentBlobStoreV1>({
    putSource,
    readSource: vi.fn(async () => sceneSource),
  });
  const executionCancel = vi.fn(async () => undefined);
  const wake = vi.fn();
  const service = new DurableManimRenderServiceV1({
    blobs,
    execution: { cancel: executionCancel, wake },
    frame: { height: 8, width: 14.222 },
    repository,
    sessionIdFactory: () => "00000000-0000-4000-8000-000000000010",
    sourceRepository,
    tenantId: "tenant-a",
  });
  return {
    abandonSession,
    blobs,
    close,
    createSession,
    executionCancel,
    putSource,
    queueBlobDeletion,
    readSession,
    repository,
    service,
    wake,
  };
}

describe("DurableManimRenderServiceV1", () => {
  it("lowers source and creates a durable preparing session without launching a host process", async () => {
    const { createSession, putSource, service, wake } = fixture();

    const view = await service.start(request());

    expect(view).toMatchObject({
      canCancel: true,
      failureCode: null,
      id: "00000000-0000-4000-8000-000000000010",
      progress: 0,
      projectId: "default",
      sourcePath: "scene.py",
      status: "preparing",
      videoUrl: null,
    });
    expect(view.patch.sourceHash).toBe(sourceHash(sceneSource));
    expect(view.patch.patchedSourceHash).not.toBe(view.patch.sourceHash);
    expect(putSource).toHaveBeenCalledOnce();
    expect(putSource.mock.calls[0]![1]).toContain("equation.animate");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        originalHead,
        tenantId: "tenant-a",
      }),
      undefined,
    );
    expect(wake).toHaveBeenCalledOnce();
  });

  it("returns the coordinator-owned terminal state without a second PostgreSQL transition", async () => {
    const { createSession, executionCancel, readSession, service } = fixture();
    const started = await service.start(request());
    const created = createSession.mock.calls[0]?.[0];
    if (!created) throw new Error("The render session was not created.");
    readSession.mockResolvedValueOnce({ ...sessionFromCreate(created), failureCode: "cancelled", status: "cancelled" });

    const cancelled = await service.cancel(started.id);

    expect(executionCancel).toHaveBeenCalledWith(started.id);
    expect(readSession).toHaveBeenCalledWith("tenant-a", started.id);
    expect(executionCancel.mock.invocationCallOrder[0]).toBeLessThan(readSession.mock.invocationCallOrder[0]!);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.failureCode).toBe("cancelled");
  });

  it("leaves the PostgreSQL row active when the broker fence fails", async () => {
    const failure = new Error("broker unavailable");
    const { executionCancel, readSession, service } = fixture();
    const started = await service.start(request());
    executionCancel.mockRejectedValueOnce(failure);

    await expect(service.cancel(started.id)).rejects.toBe(failure);

    expect(readSession).not.toHaveBeenCalled();
  });

  it("fails closed when the acknowledged session still reads as active", async () => {
    const { executionCancel, service } = fixture();
    const started = await service.start(request());

    await expect(service.cancel(started.id)).rejects.toMatchObject({ status: 503 });

    expect(executionCancel).toHaveBeenCalledWith(started.id);
  });

  it("accepts an idempotent cancellation retry after the session was discarded", async () => {
    const { createSession, readSession, service } = fixture();
    const started = await service.start(request());
    const created = createSession.mock.calls[0]?.[0];
    if (!created) throw new Error("The render session was not created.");
    readSession.mockResolvedValueOnce({ ...sessionFromCreate(created), status: "discarded" });

    await expect(service.cancel(started.id)).resolves.toMatchObject({ status: "discarded" });
  });

  it("cancels active work before an explicitly correlated abandon", async () => {
    const { abandonSession, executionCancel, service } = fixture();
    const started = await service.start(request());

    await expect(service.abandon(started.id, started.renderRequestId)).resolves.toEqual({ abandoned: true });

    expect(executionCancel).toHaveBeenCalledOnce();
    expect(abandonSession).toHaveBeenCalledWith("tenant-a", started.id, started.renderRequestId);
    expect(executionCancel.mock.invocationCallOrder[0]).toBeLessThan(abandonSession.mock.invocationCallOrder[0]!);
  });

  it.each(["ready", "failed"] as const)(
    "abandons a %s render without registering a new cancellation",
    async (status) => {
      const { abandonSession, createSession, executionCancel, readSession, service } = fixture();
      const started = await service.start(request());
      const created = createSession.mock.calls[0]?.[0];
      if (!created) throw new Error("The render session was not created.");
      readSession.mockResolvedValueOnce({ ...sessionFromCreate(created), status });

      await expect(service.abandon(started.id, started.renderRequestId)).resolves.toEqual({ abandoned: true });

      expect(executionCancel).not.toHaveBeenCalled();
      expect(abandonSession).toHaveBeenCalledWith("tenant-a", started.id, started.renderRequestId);
    },
  );

  it("lets the repository resolve a completion race during active abandon", async () => {
    const { abandonSession, executionCancel, service } = fixture();
    const started = await service.start(request());
    executionCancel.mockRejectedValueOnce(new HttpError("The render completed before cancellation registration.", 409));

    await expect(service.abandon(started.id, started.renderRequestId)).resolves.toEqual({ abandoned: true });

    expect(abandonSession).toHaveBeenCalledOnce();
  });

  it("queues the uploaded candidate as an orphan when the session transaction fails", async () => {
    const failure = new Error("database unavailable");
    const { putSource, queueBlobDeletion, service } = fixture({
      createSession: async () => {
        throw failure;
      },
    });

    await expect(service.start(request())).rejects.toBe(failure);

    expect(queueBlobDeletion).toHaveBeenCalledWith("tenant-a", await putSource.mock.results[0]!.value);
  });

  it("queues the uploaded candidate when the request aborts immediately after upload", async () => {
    const controller = new AbortController();
    const patched = receipt("2".repeat(64), "aborted-version");
    const { createSession, queueBlobDeletion, service } = fixture({
      putSource: async () => {
        controller.abort();
        return patched;
      },
    });

    await expect(service.start(request(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(createSession).not.toHaveBeenCalled();
    expect(queueBlobDeletion).toHaveBeenCalledWith("tenant-a", patched);
  });

  it("passes tenant-scoped repository failures through unchanged", async () => {
    const failure = new HttpError("Render session not found.", 404);
    const { readSession, service } = fixture({
      readSession: async () => {
        throw failure;
      },
    });

    await expect(service.view("session-from-another-tenant")).rejects.toBe(failure);
    expect(readSession).toHaveBeenCalledWith("tenant-a", "session-from-another-tenant");
  });

  it("preflights commit correlation and passes its exact key to the atomic repository action", async () => {
    const input = request();
    const started = sessionFromCreate({
      commitCorrelationKey: "stored-key",
      executionTimeoutMs: 120_000,
      id: "session-1",
      originalHead,
      patch: { anchorLine: 1, anchorLines: [1], insertedCode: "# inserted" },
      patchedBlob: receipt("1".repeat(64), "patched"),
      programBatchId: "batch-1",
      programTransactionId: input.program.transactionId,
      renderRequestId: "render-1",
      sceneName: input.sceneName,
      tenantId: "tenant-a",
    });
    const ready = { ...started, progress: 1, status: "ready" as const };
    const actionId = "00000000-0000-4000-8000-000000000011";
    const action = {
      createdAt: new Date(),
      expectedKey: "unused",
      id: actionId,
      kind: "commit" as const,
      outcome: "committed" as const,
      sessionId: ready.id,
      state: "succeeded" as const,
      tenantId: "tenant-a",
      updatedAt: new Date(),
    };
    const committed = { ...ready, latestAction: action, status: "committed" as const };
    const { repository, service } = fixture({ readSession: async () => ready });
    repository.applySourceAction = vi.fn(async () => ({ action, executed: true, session: committed }));
    const expected: RenderCommitRequest = {
      actionId,
      programBatchId: ready.programBatchId,
      projectId: ready.projectId,
      renderRequestId: ready.renderRequestId,
      sceneName: ready.sceneName,
      sourceHash: ready.original.blob.digest,
      sourcePath: ready.sourcePath,
    };

    await expect(service.commit(ready.id, { ...expected, renderRequestId: "different" })).rejects.toMatchObject({
      status: 409,
    });
    expect(repository.applySourceAction).not.toHaveBeenCalled();

    const view = await service.commit(ready.id, expected);
    expect(view).toMatchObject({ canUndo: true, sourceAction: { id: actionId, outcome: "committed" } });
    expect(repository.applySourceAction).toHaveBeenCalledWith(
      {
        actionId,
        expectedKey: renderCommitCorrelationKey(expected),
        expectedSessionVersion: ready.version,
        kind: "commit",
        sessionId: ready.id,
        tenantId: "tenant-a",
      },
      undefined,
    );
  });

  it("returns the requested persisted action when an idempotent retry replays older history", async () => {
    const input = request();
    const started = sessionFromCreate({
      commitCorrelationKey: "stored-key",
      executionTimeoutMs: 120_000,
      id: "session-1",
      originalHead,
      patch: { anchorLine: 1, anchorLines: [1], insertedCode: "# inserted" },
      patchedBlob: receipt("1".repeat(64), "patched"),
      programBatchId: "batch-1",
      programTransactionId: input.program.transactionId,
      renderRequestId: "render-1",
      sceneName: input.sceneName,
      tenantId: "tenant-a",
    });
    const ready = { ...started, progress: 1, status: "ready" as const };
    const actionId = "00000000-0000-4000-8000-000000000011";
    const replayedAction = {
      createdAt: new Date(),
      expectedKey: "unused",
      id: actionId,
      kind: "commit" as const,
      outcome: "committed" as const,
      sessionId: ready.id,
      state: "succeeded" as const,
      tenantId: "tenant-a",
      updatedAt: new Date(),
    };
    const newerAction = {
      ...replayedAction,
      id: "00000000-0000-4000-8000-000000000012",
      kind: "undo" as const,
      outcome: "undone" as const,
    };
    const current = { ...ready, latestAction: newerAction, status: "undone" as const };
    const { repository, service } = fixture({ readSession: async () => current });
    repository.applySourceAction = vi.fn(async () => ({
      action: replayedAction,
      executed: false,
      session: current,
    }));
    const expected: RenderCommitRequest = {
      actionId,
      programBatchId: ready.programBatchId,
      projectId: ready.projectId,
      renderRequestId: ready.renderRequestId,
      sceneName: ready.sceneName,
      sourceHash: ready.original.blob.digest,
      sourcePath: ready.sourcePath,
    };

    await expect(service.commit(ready.id, expected)).resolves.toMatchObject({
      canUndo: false,
      sourceAction: { id: actionId, kind: "commit", outcome: "committed" },
      status: "undone",
    });
  });

  it("owns only the render-session repository lifecycle", async () => {
    const { close, service } = fixture();

    await expect(service.ready()).resolves.toBe(true);
    await Promise.all([service.close(), service.close()]);

    expect(close).toHaveBeenCalledOnce();
  });
});
