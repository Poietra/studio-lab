import { describe, expect, it, vi } from "vitest";

import type { ProgramRenderRequest, RenderCommitRequest } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { type DurableManimRenderServiceOptionsV1, DurableManimRenderServiceV1 } from "./durable-manim-render-service";
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
    artifactReader?: DurableManimRenderServiceOptionsV1["artifactReader"];
    runtimeTraceEditVerifier?: DurableManimRenderServiceOptionsV1["runtimeTraceEditVerifier"];
    createSession?: RenderSessionRepositoryV1["createSession"];
    originalHead?: WorkspaceSourceHeadV1;
    originalSource?: string;
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
    readSourceHead: vi.fn(async () => overrides.originalHead ?? originalHead),
  });
  const blobs = partial<SourceContentBlobStoreV1>({
    putSource,
    readSource: vi.fn(async () => overrides.originalSource ?? sceneSource),
  });
  const executionCancel = vi.fn(async () => undefined);
  const wake = vi.fn();
  const service = new DurableManimRenderServiceV1({
    ...(overrides.artifactReader ? { artifactReader: overrides.artifactReader } : {}),
    blobs,
    ...(overrides.runtimeTraceEditVerifier ? { runtimeTraceEditVerifier: overrides.runtimeTraceEditVerifier } : {}),
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
    readSource: blobs.readSource,
    readSession,
    repository,
    service,
    wake,
  };
}

const genericSource = `from manim import *

class StaticSquare(Scene):
    def construct(self):
        square = Square()
        self.add(square)
        self.wait(1 / 60)
`;

type RuntimeTraceEditVerify = NonNullable<DurableManimRenderServiceOptionsV1["runtimeTraceEditVerifier"]>["verify"];

function initialMoveRequest(): ProgramRenderRequest {
  const sourcePath = "scenes/static_square.py";
  const sceneName = "StaticSquare";
  const entityId = `source:${sourcePath}#${sceneName}:square`;
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    entityId,
    id: "generic-initial-position",
    interval: { end: 0, start: 0 },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["runtime trace"], origin: "direct-manipulation" },
    value: { x: 410, y: 135 },
  };
  const program: CanonicalEditProgram = {
    anchor: {
      capturedPlayhead: 0,
      evidence: ["source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["runtime trace"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "generic-initial-move",
    version: 1,
  };
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program,
    projectId: "default",
    sceneName,
    sourceBindings: [{ entityId, sourceVariable: "square" }],
    sourceHash: sourceHash(genericSource),
    sourcePath,
    viewport: { height: 360, width: 640 },
  };
}

function runtimeTraceEditFixture(
  options: Readonly<{
    runtimeTraceEditVerifier?: DurableManimRenderServiceOptionsV1["runtimeTraceEditVerifier"] | null;
    verify?: RuntimeTraceEditVerify;
  }> = {},
) {
  const input = initialMoveRequest();
  const head: WorkspaceSourceHeadV1 = {
    blob: receipt(input.sourceHash, "candidate-source-version"),
    generation: 4n,
    projectId: input.projectId,
    sourcePath: input.sourcePath,
    tenantId: "tenant-a",
  };
  const verify = vi.fn(options.verify ?? (async () => undefined));
  const runtimeTraceEditVerifier =
    options.runtimeTraceEditVerifier === null ? undefined : (options.runtimeTraceEditVerifier ?? { verify });
  return {
    ...fixture({
      ...(runtimeTraceEditVerifier ? { runtimeTraceEditVerifier } : {}),
      originalHead: head,
      originalSource: genericSource,
    }),
    head,
    input,
    verify,
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

  it("verifies a generic Runtime Trace edit before any durable render side effect", async () => {
    const { createSession, input, putSource, service, verify, wake } = runtimeTraceEditFixture();

    await expect(service.start(input)).resolves.toMatchObject({ status: "preparing" });

    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(putSource.mock.invocationCallOrder[0]!);
    expect(putSource.mock.invocationCallOrder[0]).toBeLessThan(createSession.mock.invocationCallOrder[0]!);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("leaves no durable residue when generic Runtime Trace edit verification rejects", async () => {
    const failure = new HttpError("candidate rejected", 409);
    const { createSession, input, putSource, queueBlobDeletion, service, verify, wake } = runtimeTraceEditFixture({
      verify: async () => {
        throw failure;
      },
    });

    await expect(service.start(input)).rejects.toBe(failure);

    expect(verify).toHaveBeenCalledOnce();
    expect(putSource).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(queueBlobDeletion).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("fails edited candidates closed when the durable verifier is not composed", async () => {
    const { createSession, input, putSource, queueBlobDeletion, service, verify, wake } = runtimeTraceEditFixture({
      runtimeTraceEditVerifier: null,
    });

    await expect(service.start(input)).rejects.toMatchObject({ status: 503 });

    expect(verify).not.toHaveBeenCalled();
    expect(putSource).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(queueBlobDeletion).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("leaves no durable residue when Runtime Trace edit verification is aborted", async () => {
    const controller = new AbortController();
    const { createSession, input, putSource, queueBlobDeletion, service, verify, wake } = runtimeTraceEditFixture({
      verify: async () => {
        controller.abort();
        controller.signal.throwIfAborted();
      },
    });

    await expect(service.start(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(verify).toHaveBeenCalledOnce();
    expect(putSource).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(queueBlobDeletion).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("leaves no durable residue when the edited source head is stale", async () => {
    const { createSession, input, putSource, queueBlobDeletion, service, verify, wake } = runtimeTraceEditFixture();

    await expect(service.start({ ...input, sourceHash: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });

    expect(verify).not.toHaveBeenCalled();
    expect(putSource).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(queueBlobDeletion).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
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
    await expect(service.deliveryReady()).resolves.toBe(false);
    await Promise.all([service.close(), service.close()]);

    expect(close).toHaveBeenCalledOnce();
  });

  it("reports end-to-end delivery readiness only with an available artifact reader", async () => {
    const { service } = fixture({
      artifactReader: {
        ready: async () => true,
        sessionVideo: vi.fn(),
      },
    });

    await expect(service.deliveryReady()).resolves.toBe(true);
    await service.close();
  });
});
