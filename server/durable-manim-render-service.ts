import { randomUUID } from "node:crypto";

import {
  type ProgramRenderRequest,
  type RenderCommitRequest,
  type RenderSessionView,
  type RenderSourceActionCancellationRequest,
  type RenderSourceActionView,
  renderProgramBatchId,
  renderRequestId,
  renderRequestPrograms,
} from "../src/render-pipeline/contracts";
import type { DurableManimRenderWorkerV1 } from "./durable-manim-render-worker";
import { HttpError } from "./http/json";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
import {
  renderCommitCorrelationKey,
  renderCommitMatchesPreview,
  renderSessionCapabilities,
} from "./manim-render-session-policy";
import { manimTenantIdSchema } from "./manim-request-principal";
import {
  type CreateDurableRenderSessionInputV1,
  type DurableRenderSessionV1,
  MAX_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
  MIN_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
  type RenderSessionRepositoryV1,
} from "./storage/render-session-repository";
import type { SourceContentBlobStoreV1, WorkspaceSourceRepositoryV1 } from "./storage/workspace-source-repository";

export type DurableManimRenderServiceOptionsV1 = Readonly<{
  blobs: SourceContentBlobStoreV1;
  execution?: Pick<DurableManimRenderWorkerV1, "cancel" | "wake">;
  executionTimeoutMs?: number;
  frame?: Readonly<{ height: number; width: number }>;
  repository: RenderSessionRepositoryV1;
  sessionIdFactory?: () => string;
  sourceRepository: WorkspaceSourceRepositoryV1;
  tenantId: string;
}>;

function sourceActionView(action: DurableRenderSessionV1["latestAction"]): RenderSourceActionView | null {
  if (!action) return null;
  return { id: action.id, kind: action.kind, outcome: action.outcome, state: action.state };
}

function sessionView(
  session: DurableRenderSessionV1,
  sourceAction: DurableRenderSessionV1["latestAction"] = session.latestAction,
): RenderSessionView {
  const actionInProgress = sourceAction?.state === "running";
  return {
    actionInProgress,
    ...renderSessionCapabilities(session.status, actionInProgress),
    createdAt: session.createdAt.toISOString(),
    error: session.error,
    id: session.id,
    logTail: session.logTail,
    patch: {
      anchorLine: session.patch.anchorLine,
      anchorLines: session.patch.anchorLines,
      insertedCode: session.patch.insertedCode,
      patchedSourceHash: session.patched.blob.digest,
      sourceHash: session.original.blob.digest,
    },
    projectId: session.projectId,
    programBatchId: session.programBatchId,
    programTransactionId: session.programTransactionId,
    renderRequestId: session.renderRequestId,
    progress: session.progress,
    sceneName: session.sceneName,
    sourceAction: sourceActionView(sourceAction),
    sourcePath: session.sourcePath,
    status: session.status,
    updatedAt: session.updatedAt.toISOString(),
    // Durable video publication is owned by #136. An S3 locator is never
    // exposed directly to the browser from this session service.
    videoUrl: null,
  };
}

/**
 * Tenant-fixed render API backed by the durable source and session stores.
 * `start` only enqueues a preparing session; an external worker will claim it.
 */
export class DurableManimRenderServiceV1 {
  readonly #blobs: SourceContentBlobStoreV1;
  readonly #execution: Pick<DurableManimRenderWorkerV1, "cancel" | "wake"> | undefined;
  readonly #executionTimeoutMs: number;
  readonly #frame: Readonly<{ height: number; width: number }>;
  readonly #repository: RenderSessionRepositoryV1;
  readonly #sessionIdFactory: () => string;
  readonly #sourceRepository: WorkspaceSourceRepositoryV1;
  readonly #tenantId: string;
  #closeRequest: Promise<void> | null = null;

  constructor(options: DurableManimRenderServiceOptionsV1) {
    const tenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!tenant.success) throw new TypeError("The durable render tenant ID is invalid.");
    const frame = options.frame ?? { height: 8, width: 14.222 };
    if (!Number.isFinite(frame.height) || frame.height <= 0 || !Number.isFinite(frame.width) || frame.width <= 0) {
      throw new TypeError("The durable render frame must have finite positive dimensions.");
    }
    this.#tenantId = tenant.data;
    const executionTimeoutMs = options.executionTimeoutMs ?? 2 * 60 * 1_000;
    if (
      !Number.isSafeInteger(executionTimeoutMs) ||
      executionTimeoutMs < MIN_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1 ||
      executionTimeoutMs > MAX_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1
    ) {
      throw new RangeError("The durable render execution timeout is invalid.");
    }
    this.#executionTimeoutMs = executionTimeoutMs;
    this.#execution = options.execution;
    this.#frame = Object.freeze({ height: frame.height, width: frame.width });
    this.#repository = options.repository;
    this.#sourceRepository = options.sourceRepository;
    this.#blobs = options.blobs;
    this.#sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  }

  ready(signal?: AbortSignal) {
    return this.#repository.ready(signal);
  }

  async start(request: ProgramRenderRequest, signal?: AbortSignal): Promise<RenderSessionView> {
    signal?.throwIfAborted();
    const originalHead = await this.#sourceRepository.readSourceHead(
      this.#tenantId,
      request.projectId,
      request.sourcePath,
      signal,
    );
    signal?.throwIfAborted();
    if (originalHead.blob.digest !== request.sourceHash) {
      throw new HttpError(
        "The imported source changed before rendering. Reimport the workspace and create the draft again.",
        409,
      );
    }
    const originalSource = await this.#blobs.readSource(this.#tenantId, originalHead.blob, signal);
    signal?.throwIfAborted();
    const { lowered } = lowerManimRenderRequest({
      frame: this.#frame,
      originalSource,
      projectId: request.projectId,
      request,
    });
    signal?.throwIfAborted();
    const patchedBlob = await this.#blobs.putSource(this.#tenantId, lowered.source, signal);

    let created: DurableRenderSessionV1;
    try {
      signal?.throwIfAborted();
      // These identifiers are client correlation keys. Keep parity with the
      // local manager by hashing the submitted request, not the validated copy
      // returned by lowering.
      const programs = renderRequestPrograms(request);
      const programBatchId = renderProgramBatchId(programs);
      const renderRequestIdentifier = renderRequestId(request);
      const createInput: CreateDurableRenderSessionInputV1 = {
        commitCorrelationKey: renderCommitCorrelationKey({
          programBatchId,
          projectId: request.projectId,
          renderRequestId: renderRequestIdentifier,
          sceneName: request.sceneName,
          sourceHash: originalHead.blob.digest,
          sourcePath: request.sourcePath,
        }),
        id: this.#sessionIdFactory(),
        executionTimeoutMs: this.#executionTimeoutMs,
        originalHead,
        patch: {
          anchorLine: lowered.anchorLine,
          anchorLines: lowered.anchorLines,
          insertedCode: lowered.insertedCode,
        },
        patchedBlob,
        programBatchId,
        programTransactionId: programs.length === 1 ? programs[0]!.transactionId : programBatchId,
        renderRequestId: renderRequestIdentifier,
        sceneName: request.sceneName,
        tenantId: this.#tenantId,
      };
      created = await this.#repository.createSession(createInput, signal);
    } catch (error) {
      try {
        await this.#sourceRepository.queueBlobDeletion(this.#tenantId, patchedBlob);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Render session creation and orphan cleanup both failed.");
      }
      throw error;
    }
    this.#execution?.wake();
    return sessionView(created);
  }

  async view(id: string): Promise<RenderSessionView> {
    return sessionView(await this.#repository.readSession(this.#tenantId, id));
  }

  async cancel(id: string): Promise<RenderSessionView> {
    const cancelled = await this.#repository.cancelSession(this.#tenantId, id);
    await this.#execution?.cancel(id);
    return sessionView(cancelled);
  }

  async commit(id: string, expected: RenderCommitRequest, signal?: AbortSignal): Promise<RenderSessionView> {
    signal?.throwIfAborted();
    const session = await this.#repository.readSession(this.#tenantId, id, signal);
    if (
      !renderCommitMatchesPreview(expected, {
        programBatchId: session.programBatchId,
        projectId: session.projectId,
        renderRequestId: session.renderRequestId,
        sceneName: session.sceneName,
        sourceHash: session.original.blob.digest,
        sourcePath: session.sourcePath,
      })
    ) {
      throw new HttpError("The rendered preview no longer matches the active Studio candidate.", 409);
    }
    const result = await this.#repository.applySourceAction(
      {
        actionId: expected.actionId,
        expectedKey: renderCommitCorrelationKey(expected),
        expectedSessionVersion: session.version,
        kind: "commit",
        sessionId: id,
        tenantId: this.#tenantId,
      },
      signal,
    );
    // An idempotent retry can replay an older terminal action after a newer
    // action changed `session.latestAction`. Return the replayed action so the
    // HTTP result remains stable for the caller's action ID.
    return sessionView(result.session, result.action);
  }

  async undo(id: string, actionId: string, signal?: AbortSignal): Promise<RenderSessionView> {
    signal?.throwIfAborted();
    const session = await this.#repository.readSession(this.#tenantId, id, signal);
    const result = await this.#repository.applySourceAction(
      {
        actionId,
        expectedKey: "undo",
        expectedSessionVersion: session.version,
        kind: "undo",
        sessionId: id,
        tenantId: this.#tenantId,
      },
      signal,
    );
    return sessionView(result.session, result.action);
  }

  async cancelSourceAction(id: string, request: RenderSourceActionCancellationRequest) {
    const result = await this.#repository.cancelSourceAction({
      actionId: request.actionId,
      kind: request.kind,
      sessionId: id,
      tenantId: this.#tenantId,
    });
    return { action: sourceActionView(result.action)!, session: sessionView(result.session, result.action) };
  }

  async discard(id: string): Promise<RenderSessionView> {
    return sessionView(await this.#repository.discardSession(this.#tenantId, id));
  }

  async abandonStart(id: string): Promise<void> {
    try {
      const session = await this.#repository.readSession(this.#tenantId, id);
      await this.#repository.abandonSession(this.#tenantId, id, session.renderRequestId);
      await this.#execution?.cancel(id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return;
      throw error;
    }
  }

  async abandon(id: string, expectedRenderRequestId: string) {
    try {
      await this.#repository.readSession(this.#tenantId, id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return { abandoned: true } as const;
      throw error;
    }
    await this.#repository.abandonSession(this.#tenantId, id, expectedRenderRequestId);
    await this.#execution?.cancel(id);
    return { abandoned: true } as const;
  }

  async videoPath(_id: string): Promise<never> {
    throw new HttpError("Rendered video publication is not available yet.", 404);
  }

  close() {
    this.#closeRequest ??= this.#repository.close();
    return this.#closeRequest;
  }
}
