import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  MANIM_PROJECT_ID_PATTERN,
  type ManimProjectListView,
  type ManimThumbnailStatus,
  type ManimWorkspaceView,
  type OriginalManimSourceExportRequest,
  type ProgramRenderRequest,
  type RenderCommitRequest,
  type RenderSessionStatus,
  type RenderSessionView,
  type RenderSourceActionCancellationRequest,
  renderProgramBatchId,
  renderRequestId,
  renderRequestPrograms,
} from "../src/render-pipeline/contracts";
import type { FastManimSnapshotQueryV1, FastManimSnapshotRunRequestV1 } from "./fast-manim-snapshot-contract";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { HttpError } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import type { ManimProjectKind } from "./manim-project-catalog";
import {
  appendRenderLog,
  findRenderedVideo,
  stopRenderProcess,
  waitForRenderExit,
  waitForRenderProcessStop,
} from "./manim-render-process";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
import {
  beginRenderSessionAction,
  createRenderMutationTransactionState,
  type RenderMutationTransactionState,
  RenderMutationTransactionCoordinator,
  renderSourceActionView,
  runningRenderSourceActions,
} from "./manim-render-mutation-transaction";
import {
  renderCommitCorrelationKey,
  renderCommitMatchesPreview,
  renderSessionCapabilities,
  renderSessionStatusPolicy,
} from "./manim-render-session-policy";
import { type ManimSourceReadHooks, ManimSourceStore, sourceHash } from "./manim-source-store";
import { ManimThumbnailCache } from "./manim-thumbnail-cache";
import { discoverPythonSources } from "./manim-workspace";

type RenderSession = {
  batchId: string;
  child: ChildProcess | null;
  createdAt: string;
  error: string | null;
  id: string;
  logTail: string;
  mutation: RenderMutationTransactionState;
  originalHash: string;
  originalSource: string;
  patch: {
    anchorLine: number;
    anchorLines: readonly number[];
    insertedCode: string;
  };
  patchedHash: string;
  patchedSource: string;
  progress: number;
  request: ProgramRenderRequest;
  requestId: string;
  status: RenderSessionStatus;
  tempRoot: string;
  updatedAt: string;
  videoPath: string | null;
};

type RenderStartReservation = Readonly<{
  release: () => void;
  transferRetention: () => void;
}>;

const DEFAULT_MAX_CONCURRENT_RENDERS = 2;
const DEFAULT_MAX_RETAINED_SESSIONS = 32;
const DEFAULT_RENDER_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_SESSION_RETENTION_MS = 30 * 60 * 1_000;
const COMMAND_AVAILABILITY_TTL_MS = 30_000;
const COMMAND_AVAILABILITY_TIMEOUT_MS = 15_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function requirePositiveFinite(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

function requirePositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

function requireTimerDelay(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${name} must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`);
  }
  return value;
}

function commandIsAvailable(command: readonly string[], signal?: AbortSignal) {
  return new Promise<boolean>((resolveAvailability) => {
    let settled = false;
    let stopping = false;
    let timeout: NodeJS.Timeout | null = null;
    const child = spawn(command[0], [...command.slice(1), "--version"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
    };
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveAvailability(available);
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      stopRenderProcess(child);
      void waitForRenderProcessStop(child).then(() => finish(false));
    };
    timeout = setTimeout(stop, COMMAND_AVAILABILITY_TIMEOUT_MS);
    timeout.unref();
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(!stopping && code === 0));
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined) {
  signal?.throwIfAborted();
}

export class ManimRenderManager {
  readonly command: readonly string[];
  readonly defaultProjectId: string;
  readonly frame: Readonly<{ height: number; width: number }>;
  readonly projectId: string;
  readonly projectKind: ManimProjectKind;
  projectName: string;
  readonly projectRoot: string;
  private commandAvailability: Readonly<{ checkedAt: number; value: boolean }> | null = null;
  private readonly commandAvailabilityAbort = new AbortController();
  private commandAvailabilityRequest: Promise<boolean> | null = null;
  private activeStarts = 0;
  private closeRequest: Promise<void> | null = null;
  private closing = false;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly startDrainWaiters = new Set<() => void>();
  private readonly logger: StructuredLogger;
  private readonly maxConcurrentRenders: number;
  private readonly maxRetainedSessions: number;
  private readonly mutationTransactions: RenderMutationTransactionCoordinator;
  private readonly onSessionRemoved: (id: string) => void;
  private pendingStarts = 0;
  private pendingRetainedSessions = 0;
  private readonly renderTimeoutMs: number;
  private readonly sessionRetentionMs: number;
  private readonly sessions = new Map<string, RenderSession>();
  private readonly snapshotRunner: FastManimSnapshotRunner;
  private readonly sourceStore: ManimSourceStore;
  private readonly thumbnailCache: ManimThumbnailCache;
  private thumbnailRefreshRequest: Promise<void> | null = null;
  private thumbnailSlotRequest: Promise<void> | null = null;
  private thumbnailStartRequest: Promise<ManimThumbnailStatus> | null = null;
  private workspaceRequest: Promise<ManimWorkspaceView> | null = null;

  constructor(
    options: Readonly<{
      command: readonly string[];
      frame: Readonly<{ height: number; width: number }>;
      logger?: StructuredLogger;
      maxConcurrentRenders?: number;
      maxRetainedSessions?: number;
      onSessionRemoved?: (id: string) => void;
      projectId?: string;
      projectKind?: ManimProjectKind;
      projectName?: string;
      projectRoot: string;
      renderTimeoutMs?: number;
      sessionRetentionMs?: number;
      snapshotProducerCommand?: readonly string[];
      snapshotProducerEnabled?: boolean;
      snapshotTimeoutMs?: number;
      sourceStoreHooks?: ManimSourceReadHooks;
      thumbnailCacheRoot?: string;
    }>,
  ) {
    if (options.command.length === 0 || options.command.some((entry) => entry.length === 0)) {
      throw new TypeError("The Manim command must contain a non-empty executable and arguments.");
    }
    this.command = Object.freeze([...options.command]);
    this.frame = Object.freeze({
      height: requirePositiveFinite(options.frame.height, "Manim frame height"),
      width: requirePositiveFinite(options.frame.width, "Manim frame width"),
    });
    this.logger = options.logger ?? nullLogger;
    this.maxConcurrentRenders = requirePositiveInteger(
      options.maxConcurrentRenders ?? DEFAULT_MAX_CONCURRENT_RENDERS,
      "Maximum concurrent renders",
    );
    this.maxRetainedSessions = requirePositiveInteger(
      options.maxRetainedSessions ?? DEFAULT_MAX_RETAINED_SESSIONS,
      "Maximum retained sessions",
    );
    this.mutationTransactions = new RenderMutationTransactionCoordinator({ isClosing: () => this.closing });
    this.onSessionRemoved = options.onSessionRemoved ?? (() => undefined);
    this.sourceStore = new ManimSourceStore(options.projectRoot, options.sourceStoreHooks);
    this.projectId = options.projectId ?? "default";
    if (!MANIM_PROJECT_ID_PATTERN.test(this.projectId)) {
      throw new TypeError("Manim project ID must be an opaque lower-case identifier.");
    }
    this.defaultProjectId = this.projectId;
    this.projectKind = options.projectKind ?? "existing";
    this.projectName = options.projectName?.trim() || basename(this.sourceStore.projectRoot) || "Manim Project";
    if (this.projectName.length > 120) throw new TypeError("Manim project name must be at most 120 characters.");
    this.projectRoot = this.sourceStore.projectRoot;
    this.renderTimeoutMs = requireTimerDelay(options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS, "Render timeout");
    this.sessionRetentionMs = requireTimerDelay(
      options.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS,
      "Session retention",
    );
    this.snapshotRunner = new FastManimSnapshotRunner({
      command: options.snapshotProducerCommand ?? null,
      enabled: options.snapshotProducerEnabled ?? false,
      frame: this.frame,
      logger: this.logger,
      projectId: this.projectId,
      projectRoot: this.projectRoot,
      timeoutMs: options.snapshotTimeoutMs,
    });
    this.thumbnailCache = new ManimThumbnailCache({
      cacheRoot: options.thumbnailCacheRoot ?? join(this.projectRoot, ".poietra", "thumbnails"),
      command: this.command,
      frame: this.frame,
      logger: this.logger,
      projectId: this.projectId,
      projectRoot: this.projectRoot,
      renderTimeoutMs: this.renderTimeoutMs,
    });
    this.cleanupTimer = setInterval(
      () => {
        void this.cleanupExpiredSessions().catch((error: unknown) => {
          this.logger.error("render.session_cleanup_failed", { error });
        });
      },
      Math.min(60_000, Math.max(100, this.sessionRetentionMs)),
    );
    this.cleanupTimer.unref();
  }

  canUnregister() {
    return (
      this.activeStarts === 0 &&
      this.pendingStarts === 0 &&
      this.pendingRetainedSessions === 0 &&
      this.sessions.size === 0 &&
      !this.thumbnailCache.isBusy() &&
      !this.snapshotRunner.busy &&
      this.thumbnailRefreshRequest === null &&
      this.thumbnailSlotRequest === null &&
      this.thumbnailStartRequest === null &&
      this.workspaceRequest === null
    );
  }

  renameProject(name: string) {
    const normalized = name.trim();
    if (!normalized || normalized.length > 120) {
      throw new TypeError("Manim project name must contain 1 to 120 characters.");
    }
    this.projectName = normalized;
  }

  async cleanupExpiredSessions(now = Date.now()) {
    const expired = [...this.sessions.values()].filter(
      (session) =>
        !renderSessionStatusPolicy(session.status).active &&
        !session.mutation.actionInProgress &&
        now - Date.parse(session.updatedAt) >= this.sessionRetentionMs,
    );
    await Promise.all(
      expired.map(async (session) => {
        if (session.mutation.actionInProgress) return;
        session.mutation.actionInProgress = true;
        try {
          await rm(session.tempRoot, { force: true, recursive: true });
          this.removeSession(session.id);
        } finally {
          session.mutation.actionInProgress = false;
        }
      }),
    );
  }

  projects(): ManimProjectListView {
    return {
      defaultProjectId: this.projectId,
      projects: [{ id: this.projectId, kind: this.projectKind, name: this.projectName }],
    };
  }

  async workspace(projectId = this.projectId): Promise<ManimWorkspaceView> {
    if (projectId !== this.projectId) throw new HttpError("Configured Manim project not found.", 404);
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    if (this.workspaceRequest) return this.workspaceRequest;
    this.workspaceRequest = (async () => {
      const [commandAvailable, sources] = await Promise.all([
        this.isCommandAvailable(),
        discoverPythonSources(this.projectRoot, this.frame),
      ]);
      return {
        commandAvailable,
        frame: this.frame,
        projectId: this.projectId,
        projectName: this.projectName,
        sources,
      };
    })();
    try {
      return await this.workspaceRequest;
    } finally {
      this.workspaceRequest = null;
    }
  }

  thumbnail(projectId = this.projectId) {
    if (projectId !== this.projectId) throw new HttpError("Configured Manim project not found.", 404);
    return this.thumbnailCache.asset();
  }

  thumbnailStatus(projectId = this.projectId) {
    if (projectId !== this.projectId) throw new HttpError("Configured Manim project not found.", 404);
    return this.thumbnailCache.status();
  }

  generateThumbnail(projectId = this.projectId) {
    if (projectId !== this.projectId) throw new HttpError("Configured Manim project not found.", 404);
    return this.startThumbnailGeneration();
  }

  private startThumbnailGeneration() {
    if (this.thumbnailStartRequest) return this.thumbnailStartRequest;
    const request = Promise.resolve().then(() => this.runThumbnailGenerationStart());
    this.thumbnailStartRequest = request;
    void request
      .finally(() => {
        if (this.thumbnailStartRequest === request) this.thumbnailStartRequest = null;
      })
      .catch(() => undefined);
    return request;
  }

  private async runThumbnailGenerationStart() {
    const finishStart = this.beginStart();
    try {
      if (this.thumbnailCache.isGenerating()) return this.thumbnailCache.status();
      const releaseSlot = this.reserveThumbnailSlot();
      let slotHeldForRender = false;
      try {
        const status = await this.thumbnailCache.generate(() => this.isCommandAvailable());
        if (status.state === "generating") {
          slotHeldForRender = true;
          const slotRequest = this.thumbnailCache.waitForIdle().finally(releaseSlot);
          this.thumbnailSlotRequest = slotRequest;
          void slotRequest
            .finally(() => {
              if (this.thumbnailSlotRequest === slotRequest) this.thumbnailSlotRequest = null;
            })
            .catch(() => undefined);
        }
        return status;
      } finally {
        if (!slotHeldForRender) releaseSlot();
      }
    } finally {
      finishStart();
    }
  }

  private refreshThumbnail() {
    this.thumbnailCache.invalidateTarget();
    if (this.thumbnailRefreshRequest) return;
    const request = Promise.resolve()
      .then(async () => {
        await this.thumbnailCache.waitForIdle();
        this.thumbnailCache.invalidateTarget();
        if ((await this.thumbnailCache.status()).state === "current") return;
        await this.startThumbnailGeneration();
      })
      .catch((error: unknown) => {
        this.logger.warn("thumbnail.refresh_failed", { error });
      });
    this.thumbnailRefreshRequest = request;
    void request
      .finally(() => {
        if (this.thumbnailRefreshRequest === request) this.thumbnailRefreshRequest = null;
      })
      .catch(() => undefined);
  }

  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError("Render session not found.", 404);
    return session;
  }

  private removeSession(id: string) {
    if (!this.sessions.delete(id)) return;
    this.onSessionRemoved(id);
  }

  private async isCommandAvailable(now = Date.now()) {
    if (!this.commandAvailability || now - this.commandAvailability.checkedAt >= COMMAND_AVAILABILITY_TTL_MS) {
      this.commandAvailabilityRequest ??= commandIsAvailable(this.command, this.commandAvailabilityAbort.signal);
      try {
        const value = await this.commandAvailabilityRequest;
        this.commandAvailability = { checkedAt: Date.now(), value };
      } finally {
        this.commandAvailabilityRequest = null;
      }
    }
    return this.commandAvailability?.value ?? false;
  }

  private reserveRenderSlot() {
    if (this.sessions.size + this.pendingRetainedSessions >= this.maxRetainedSessions) {
      throw new HttpError(
        `Studio retains at most ${this.maxRetainedSessions} render sessions. Resolve or discard an existing preview first.`,
        429,
      );
    }
    const activeRenders = [...this.sessions.values()].filter(
      (session) => renderSessionStatusPolicy(session.status).active,
    ).length;
    if (activeRenders + this.pendingStarts >= this.maxConcurrentRenders) {
      throw new HttpError(`Studio permits at most ${this.maxConcurrentRenders} concurrent Manim renders.`, 429);
    }
    this.pendingStarts += 1;
    this.pendingRetainedSessions += 1;
    let released = false;
    let retentionTransferred = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.pendingStarts -= 1;
        if (!retentionTransferred) this.pendingRetainedSessions -= 1;
      },
      transferRetention: () => {
        if (retentionTransferred || released) return;
        retentionTransferred = true;
        this.pendingRetainedSessions -= 1;
      },
    };
  }

  private reserveThumbnailSlot() {
    const activeRenders = [...this.sessions.values()].filter(
      (session) => renderSessionStatusPolicy(session.status).active,
    ).length;
    if (activeRenders + this.pendingStarts >= this.maxConcurrentRenders) {
      throw new HttpError(`Studio permits at most ${this.maxConcurrentRenders} concurrent Manim renders.`, 429);
    }
    this.pendingStarts += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingStarts -= 1;
    };
  }

  private beginSessionAction(session: RenderSession, allowWhileClosing = false) {
    return beginRenderSessionAction(session.mutation, { allowWhileClosing, closing: this.closing });
  }

  private async withSessionAction<T>(id: string, action: (session: RenderSession) => Promise<T> | T) {
    const session = this.session(id);
    const finishAction = this.beginSessionAction(session);
    try {
      return await action(session);
    } finally {
      finishAction();
    }
  }

  private beginStart() {
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    this.activeStarts += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeStarts -= 1;
      if (this.activeStarts === 0) {
        for (const resolveWaiter of this.startDrainWaiters) resolveWaiter();
        this.startDrainWaiters.clear();
      }
    };
  }

  private async waitForStarts() {
    if (this.activeStarts === 0) return;
    await new Promise<void>((resolveWaiter) => {
      this.startDrainWaiters.add(resolveWaiter);
    });
  }

  view(id: string) {
    return this.toView(this.session(id));
  }

  private toView(session: RenderSession): RenderSessionView {
    const capabilities = renderSessionCapabilities(session.status, session.mutation.actionInProgress);
    return {
      actionInProgress: session.mutation.actionInProgress,
      ...capabilities,
      createdAt: session.createdAt,
      error: session.error,
      id: session.id,
      logTail: session.logTail,
      patch: {
        anchorLine: session.patch.anchorLine,
        anchorLines: session.patch.anchorLines,
        insertedCode: session.patch.insertedCode,
        patchedSourceHash: session.patchedHash,
        sourceHash: session.originalHash,
      },
      projectId: this.projectId,
      programBatchId: session.batchId,
      // Keep the original transaction ID for single-Program clients while the
      // content-sensitive batch ID remains the correlation authority.
      programTransactionId:
        renderRequestPrograms(session.request).length === 1 ? session.request.program.transactionId : session.batchId,
      renderRequestId: session.requestId,
      progress: session.progress,
      sceneName: session.request.sceneName,
      sourceAction: session.mutation.latestActionId
        ? renderSourceActionView(session.mutation.actions.get(session.mutation.latestActionId)!)
        : null,
      sourcePath: session.request.sourcePath,
      status: session.status,
      updatedAt: session.updatedAt,
      videoUrl: session.videoPath && session.status !== "discarded" ? `/api/manim/renders/${session.id}/video` : null,
    };
  }

  async start(request: ProgramRenderRequest, signal?: AbortSignal) {
    const finishStart = this.beginStart();
    try {
      this.assertRequestProject(request);
      throwIfAborted(signal);
      const commandAvailable = await this.isCommandAvailable();
      throwIfAborted(signal);
      if (!commandAvailable) {
        throw new HttpError(
          "The configured Manim command is unavailable. Configure POIETRA_MANIM_COMMAND and restart Studio.",
          503,
        );
      }
      const reservation = this.reserveRenderSlot();
      try {
        return await this.prepareRender(request, reservation, signal);
      } finally {
        reservation.release();
      }
    } finally {
      finishStart();
    }
  }

  async exportSource(request: ProgramRenderRequest, signal?: AbortSignal) {
    const finishExport = this.beginStart();
    try {
      this.assertRequestProject(request);
      const prepared = await this.lowerRequest(request, signal);
      const stem =
        basename(request.sourcePath, ".py")
          .replace(/[^A-Za-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "manim-scene";
      return {
        fileName: `${stem}.poietra.py`,
        projectId: this.projectId,
        source: prepared.lowered.source,
      };
    } finally {
      finishExport();
    }
  }

  async exportOriginalSource(request: OriginalManimSourceExportRequest, signal?: AbortSignal) {
    const finishExport = this.beginStart();
    try {
      this.assertRequestProject(request);
      throwIfAborted(signal);
      const snapshot = await this.sourceStore.read(request.sourcePath);
      throwIfAborted(signal);
      if (snapshot.hash !== request.sourceHash) {
        throw new HttpError("The imported source changed before export. Reimport the workspace and try again.", 409);
      }
      const fileName =
        basename(request.sourcePath)
          .replace(/[^A-Za-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "manim-scene.py";
      return {
        fileName: fileName.endsWith(".py") ? fileName : `${fileName}.py`,
        projectId: this.projectId,
        source: snapshot.source,
      };
    } finally {
      finishExport();
    }
  }

  private assertRequestProject(request: Readonly<{ projectId: string }>) {
    if (request.projectId !== this.projectId) {
      throw new HttpError("The render request belongs to a different configured project.", 409);
    }
  }

  private async lowerRequest(request: ProgramRenderRequest, signal?: AbortSignal) {
    throwIfAborted(signal);
    const sourceSnapshot = await this.sourceStore.read(request.sourcePath);
    throwIfAborted(signal);
    const originalSource = sourceSnapshot.source;
    if (sourceSnapshot.hash !== request.sourceHash) {
      throw new HttpError(
        "The imported source changed before rendering or export. Reimport the workspace and create the draft again.",
        409,
      );
    }
    const { lowered, renderRequest } = lowerManimRenderRequest({
      frame: this.frame,
      originalSource,
      projectId: this.projectId,
      request,
    });
    throwIfAborted(signal);
    return { lowered, renderRequest, sourceSnapshot };
  }

  private async prepareRender(
    request: ProgramRenderRequest,
    reservation: RenderStartReservation,
    signal?: AbortSignal,
  ) {
    let session: RenderSession | null = null;
    let tempRoot: string | null = null;
    try {
      const { lowered, renderRequest, sourceSnapshot } = await this.lowerRequest(request, signal);
      const sourcePath = sourceSnapshot.absolutePath;
      const originalSource = sourceSnapshot.source;
      throwIfAborted(signal);
      tempRoot = await mkdtemp(join(tmpdir(), "poietra-manim-render-"));
      throwIfAborted(signal);
      const previewSourcePath = join(tempRoot, basename(sourcePath));
      const mediaRoot = join(tempRoot, "media");
      await mkdir(mediaRoot, { recursive: true });
      throwIfAborted(signal);
      await writeFile(previewSourcePath, lowered.source, "utf8");
      throwIfAborted(signal);

      const now = new Date().toISOString();
      session = {
        batchId: renderProgramBatchId(renderRequestPrograms(request)),
        child: null,
        createdAt: now,
        error: null,
        id: randomUUID(),
        logTail: "",
        mutation: createRenderMutationTransactionState(),
        originalHash: sourceSnapshot.hash,
        originalSource,
        patch: {
          anchorLine: lowered.anchorLine,
          anchorLines: lowered.anchorLines,
          insertedCode: lowered.insertedCode,
        },
        patchedHash: sourceHash(lowered.source),
        patchedSource: lowered.source,
        progress: 0.1,
        request: renderRequest,
        requestId: renderRequestId(request),
        status: "preparing",
        tempRoot,
        updatedAt: now,
        videoPath: null,
      };
      this.sessions.set(session.id, session);
      reservation.transferRetention();
      void this.run(session, previewSourcePath, mediaRoot);
      throwIfAborted(signal);
      return this.toView(session);
    } catch (error) {
      if (session) await this.removeAbandonedSession(session);
      else if (tempRoot) await rm(tempRoot, { force: true, recursive: true });
      throw error;
    }
  }

  private async removeAbandonedSession(session: RenderSession) {
    session.status = "discarded";
    session.error = null;
    session.updatedAt = new Date().toISOString();
    const child = session.child;
    stopRenderProcess(child);
    try {
      await waitForRenderProcessStop(child);
      await rm(session.tempRoot, { force: true, recursive: true });
    } finally {
      session.child = null;
      session.videoPath = null;
      this.removeSession(session.id);
    }
  }

  async abandonStart(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    const finishAction = this.beginSessionAction(session, true);
    try {
      await this.removeAbandonedSession(session);
    } finally {
      finishAction();
    }
  }

  async abandon(id: string, expectedRenderRequestId: string) {
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    const session = this.sessions.get(id);
    if (!session) return { abandoned: true } as const;
    if (session.requestId !== expectedRenderRequestId) {
      throw new HttpError("The abandoned render no longer matches the Studio request.", 409);
    }
    if (!renderSessionStatusPolicy(session.status).abandonable) {
      throw new HttpError("A source-changing render session cannot be abandoned.", 409);
    }
    await this.abandonStart(id);
    return { abandoned: true } as const;
  }

  private async run(session: RenderSession, previewSourcePath: string, mediaRoot: string) {
    session.status = "rendering";
    session.progress = 0.2;
    session.updatedAt = new Date().toISOString();
    try {
      const [executable, ...prefix] = this.command;
      const child = spawn(
        executable,
        [...prefix, "-ql", "--disable_caching", "--media_dir", mediaRoot, previewSourcePath, session.request.sceneName],
        {
          cwd: this.projectRoot,
          detached: process.platform !== "win32",
          env: {
            ...process.env,
            PYTHONPATH: [this.projectRoot, process.env.PYTHONPATH]
              .filter(Boolean)
              .join(process.platform === "win32" ? ";" : ":"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      session.child = child;
      child.stdout?.on("data", (chunk: Buffer) => appendRenderLog(session, chunk));
      child.stderr?.on("data", (chunk: Buffer) => appendRenderLog(session, chunk));
      const exit = await waitForRenderExit(child, this.renderTimeoutMs);
      session.child = null;
      if (renderSessionStatusPolicy(session.status).stopped) return;
      if (exit.code !== 0) {
        throw new Error(
          `Manim exited with ${exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`}.`,
        );
      }
      const videoPath = await findRenderedVideo(mediaRoot, session.request.sceneName);
      if (!videoPath) throw new Error("Manim completed without producing an MP4 preview.");
      session.videoPath = videoPath;
      session.progress = 1;
      session.status = "ready";
      session.updatedAt = new Date().toISOString();
    } catch (error) {
      session.child = null;
      if (renderSessionStatusPolicy(session.status).stopped) return;
      session.error = error instanceof Error ? error.message : "Manim render failed.";
      session.status = "failed";
      session.updatedAt = new Date().toISOString();
    }
  }

  async cancel(id: string) {
    let targetSession: RenderSession | null = null;
    await this.withSessionAction(id, async (session) => {
      targetSession = session;
      if (!renderSessionStatusPolicy(session.status).cancelable) {
        throw new HttpError("Only an active render can be cancelled.", 409);
      }
      session.status = "cancelled";
      session.error = null;
      session.updatedAt = new Date().toISOString();
      const child = session.child;
      stopRenderProcess(child);
      await waitForRenderProcessStop(child);
      session.child = null;
    });
    return this.toView(targetSession!);
  }

  private async runSourceAction(
    id: string,
    input: Readonly<{
      actionId: string;
      expectedKey: string;
      kind: "commit" | "undo";
      preflight?: (session: RenderSession) => void;
      publishSource: (session: RenderSession, signal: AbortSignal) => Promise<void>;
      signal?: AbortSignal;
    }>,
  ) {
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    const session = this.session(id);
    await this.mutationTransactions.run(session, { ...input, afterTransition: () => this.refreshThumbnail() });
    return this.toView(session);
  }

  commit(id: string, expected: RenderCommitRequest, signal?: AbortSignal) {
    return this.runSourceAction(id, {
      actionId: expected.actionId,
      expectedKey: renderCommitCorrelationKey(expected),
      kind: "commit",
      publishSource: async (session, actionSignal) => {
        await this.sourceStore.writeIfUnchanged(
          session.request.sourcePath,
          session.originalHash,
          session.patchedSource,
          "The source changed after preview. Render again before committing.",
          actionSignal,
        );
      },
      preflight: (session) => {
        if (
          !renderCommitMatchesPreview(expected, {
            programBatchId: session.batchId,
            projectId: this.projectId,
            renderRequestId: session.requestId,
            sceneName: session.request.sceneName,
            sourceHash: session.originalHash,
            sourcePath: session.request.sourcePath,
          })
        ) {
          throw new HttpError("The rendered preview no longer matches the active Studio candidate.", 409);
        }
      },
      signal,
    });
  }

  undo(id: string, actionId: string, signal?: AbortSignal) {
    return this.runSourceAction(id, {
      actionId,
      expectedKey: "undo",
      kind: "undo",
      publishSource: async (session, actionSignal) => {
        await this.sourceStore.writeIfUnchanged(
          session.request.sourcePath,
          session.patchedHash,
          session.originalSource,
          "The committed source changed again, so Studio will not overwrite it during Undo.",
          actionSignal,
        );
      },
      signal,
    });
  }

  async cancelSourceAction(id: string, request: RenderSourceActionCancellationRequest) {
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    const session = this.session(id);
    const action = await this.mutationTransactions.cancel(session, request);
    return {
      action,
      session: this.toView(session),
    };
  }

  async discard(id: string) {
    let targetSession: RenderSession | null = null;
    await this.withSessionAction(id, async (session) => {
      targetSession = session;
      if (!renderSessionStatusPolicy(session.status).discardable) {
        throw new HttpError("Cancel an active render or Undo a committed change before discarding it.", 409);
      }
      const child = session.child;
      stopRenderProcess(child);
      await waitForRenderProcessStop(child);
      await rm(session.tempRoot, { force: true, recursive: true });
      session.child = null;
      session.videoPath = null;
      session.status = "discarded";
      session.updatedAt = new Date().toISOString();
      this.removeSession(session.id);
    });
    return this.toView(targetSession!);
  }

  videoPath(id: string) {
    const session = this.session(id);
    if (!session.videoPath || session.status === "discarded") throw new HttpError("Rendered video not found.", 404);
    return session.videoPath;
  }

  runSceneSnapshot(request: FastManimSnapshotRunRequestV1, signal?: AbortSignal) {
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    if (request.projectId !== this.projectId) throw new HttpError("Configured Manim project not found.", 404);
    return this.snapshotRunner.run(request, signal);
  }

  sceneSnapshot(projectId: string, query: FastManimSnapshotQueryV1) {
    if (this.closing) throw new HttpError("The Manim render pipeline is shutting down.", 503);
    if (projectId !== this.projectId) throw new HttpError("Configured Manim project not found.", 404);
    return this.snapshotRunner.snapshot(query);
  }

  private async closeResources() {
    this.commandAvailabilityAbort.abort();
    const pendingWorkspace = this.workspaceRequest;
    const thumbnailClose = this.thumbnailCache.close();
    const runningSourceActions = [...this.sessions.values()].flatMap((session) =>
      runningRenderSourceActions(session.mutation),
    );
    for (const action of runningSourceActions) action.abortController.abort();
    await Promise.all(runningSourceActions.map((action) => action.completion));
    await this.waitForStarts();
    clearInterval(this.cleanupTimer);
    const results = await Promise.allSettled([
      ...[...this.sessions.values()].map(async (session) => {
        const child = session.child;
        stopRenderProcess(child);
        await waitForRenderProcessStop(child);
        await rm(session.tempRoot, { force: true, recursive: true });
      }),
      thumbnailClose,
      this.snapshotRunner.close(),
      ...(pendingWorkspace ? [pendingWorkspace] : []),
      ...(this.thumbnailRefreshRequest ? [this.thumbnailRefreshRequest] : []),
      ...(this.thumbnailSlotRequest ? [this.thumbnailSlotRequest] : []),
    ]);
    for (const id of this.sessions.keys()) this.removeSession(id);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "Could not fully close the Manim render pipeline.");
  }

  close() {
    if (!this.closeRequest) {
      this.closing = true;
      clearInterval(this.cleanupTimer);
      this.closeRequest = this.closeResources();
    }
    return this.closeRequest;
  }

  removeThumbnailCache() {
    return this.thumbnailCache.remove();
  }
}
