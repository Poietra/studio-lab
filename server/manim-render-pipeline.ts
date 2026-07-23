import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  basename,
  join,
  resolve,
} from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { Plugin } from "vite";

import {
  MANIM_PROJECT_ID_PATTERN,
  type ProgramRenderRequest,
  type ManimProjectListView,
  type ManimProjectMutationView,
  type ManimWorkspaceView,
  type RenderSessionStatus,
  type RenderSessionView,
  renderProgramBatchId,
  renderRequestPrograms,
} from "../src/render-pipeline/contracts";
import { lowerCanonicalProgramBatchSource } from "../src/render-pipeline/source-lowering";
import { evaluateWorkingState, programRecord } from "../src/studio/evaluator";
import { STUDIO_STATE_VERSION } from "../src/studio/model";
import { HttpError, sendJson } from "./http/json";
import {
  createConsoleJsonSink,
  createStructuredLogger,
  nullLogger,
  type StructuredLogger,
} from "./logging/structured-logger";
import { handleManimRequest } from "./manim-render-http";
import {
  type ManimProjectKind,
  type ManimProjectSeed,
  PersistentManimProjectCatalog,
  type ResolvedManimProject,
  resolveManimProjects,
} from "./manim-project-catalog";
import {
  appendRenderLog,
  findRenderedVideo,
  stopRenderProcess,
  waitForRenderExit,
  waitForRenderProcessStop,
} from "./manim-render-process";
import { ManimSourceStore, sourceHash } from "./manim-source-store";
import {
  discoverPythonSources,
  importedScene,
  importSourceSnapshot,
  sceneView,
} from "./manim-workspace";

export type ManimRenderPipelineOptions = Readonly<{
  command?: string;
  frameHeight?: number;
  frameWidth?: number;
  projects?: readonly ManimProjectConfig[];
  projectRoot?: string;
  workspaceDataRoot?: string;
}>;

export type ManimProjectConfig = ManimProjectSeed;

type RenderSession = {
  actionInProgress: boolean;
  batchId: string;
  child: ChildProcess | null;
  createdAt: string;
  error: string | null;
  id: string;
  logTail: string;
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

export function parseManimCommand(value: string | undefined): readonly string[] {
  const normalized = value?.trim();
  if (!normalized) return ["manim"];
  if (normalized.startsWith("[")) {
    const parsed = JSON.parse(normalized) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((entry) => typeof entry === "string" && entry.length > 0)) {
      throw new Error("POIETRA_MANIM_COMMAND must be a non-empty JSON array of command arguments.");
    }
    return parsed;
  }
  return normalized.split(/\s+/);
}

function commandIsAvailable(command: readonly string[]) {
  return new Promise<boolean>((resolveAvailability) => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveAvailability(available);
    };
    const child = spawn(command[0], [...command.slice(1), "--version"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      stopRenderProcess(child);
      finish(false);
    }, COMMAND_AVAILABILITY_TIMEOUT_MS);
    timeout.unref();
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

function sessionWasStopped(session: RenderSession) {
  return session.status === "cancelled" || session.status === "discarded";
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
  private commandAvailabilityRequest: Promise<boolean> | null = null;
  private activeStarts = 0;
  private closeRequest: Promise<void> | null = null;
  private closing = false;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly startDrainWaiters = new Set<() => void>();
  private readonly logger: StructuredLogger;
  private readonly maxConcurrentRenders: number;
  private readonly maxRetainedSessions: number;
  private readonly onSessionRemoved: (id: string) => void;
  private pendingStarts = 0;
  private pendingRetainedSessions = 0;
  private readonly renderTimeoutMs: number;
  private readonly sessionRetentionMs: number;
  private readonly sessions = new Map<string, RenderSession>();
  private readonly sourceStore: ManimSourceStore;
  private workspaceRequest: Promise<ManimWorkspaceView> | null = null;

  constructor(options: Readonly<{
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
  }>) {
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
    this.onSessionRemoved = options.onSessionRemoved ?? (() => undefined);
    this.sourceStore = new ManimSourceStore(options.projectRoot);
    this.projectId = options.projectId ?? "default";
    if (!MANIM_PROJECT_ID_PATTERN.test(this.projectId)) {
      throw new TypeError("Manim project ID must be an opaque lower-case identifier.");
    }
    this.defaultProjectId = this.projectId;
    this.projectKind = options.projectKind ?? "existing";
    this.projectName = options.projectName?.trim() || basename(this.sourceStore.projectRoot) || "Manim Project";
    if (this.projectName.length > 120) throw new TypeError("Manim project name must be at most 120 characters.");
    this.projectRoot = this.sourceStore.projectRoot;
    this.renderTimeoutMs = requireTimerDelay(
      options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
      "Render timeout",
    );
    this.sessionRetentionMs = requireTimerDelay(
      options.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS,
      "Session retention",
    );
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions().catch((error: unknown) => {
        this.logger.error("render.session_cleanup_failed", { error });
      });
    }, Math.min(60_000, Math.max(100, this.sessionRetentionMs)));
    this.cleanupTimer.unref();
  }

  canUnregister() {
    return this.activeStarts === 0
      && this.pendingStarts === 0
      && this.pendingRetainedSessions === 0
      && this.sessions.size === 0
      && this.workspaceRequest === null;
  }

  renameProject(name: string) {
    const normalized = name.trim();
    if (!normalized || normalized.length > 120) {
      throw new TypeError("Manim project name must contain 1 to 120 characters.");
    }
    this.projectName = normalized;
  }

  async cleanupExpiredSessions(now = Date.now()) {
    const expired = [...this.sessions.values()].filter((session) => (
      session.status !== "preparing"
      && session.status !== "rendering"
      && !session.actionInProgress
      && now - Date.parse(session.updatedAt) >= this.sessionRetentionMs
    ));
    await Promise.all(expired.map(async (session) => {
      if (session.actionInProgress) return;
      session.actionInProgress = true;
      try {
        await rm(session.tempRoot, { force: true, recursive: true });
        this.removeSession(session.id);
      } finally {
        session.actionInProgress = false;
      }
    }));
  }

  projects(): ManimProjectListView {
    return {
      defaultProjectId: this.projectId,
      projects: [{ id: this.projectId, kind: this.projectKind, name: this.projectName }],
    };
  }

  async workspace(projectId = this.projectId): Promise<ManimWorkspaceView> {
    if (projectId !== this.projectId) throw new HttpError("Configured Manim project not found.", 404);
    if (this.workspaceRequest) return this.workspaceRequest;
    this.workspaceRequest = (async () => {
      const [commandAvailable, sources] = await Promise.all([
        this.isCommandAvailable(),
        discoverPythonSources(this.projectRoot, this.frame),
      ]);
      return {
        command: this.command,
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
      this.commandAvailabilityRequest ??= commandIsAvailable(this.command);
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
    const activeRenders = [...this.sessions.values()].filter((session) => (
      session.status === "preparing" || session.status === "rendering"
    )).length;
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

  private beginSessionAction(session: RenderSession) {
    if (session.actionInProgress) throw new HttpError("Another action is already running for this render session.", 409);
    session.actionInProgress = true;
    return () => {
      session.actionInProgress = false;
    };
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
    const canDiscard = ["cancelled", "failed", "ready", "undone"].includes(session.status);
    return {
      canCancel: session.status === "preparing" || session.status === "rendering",
      canCommit: session.status === "ready",
      canDiscard,
      canUndo: session.status === "committed",
      createdAt: session.createdAt,
      error: session.error,
      id: session.id,
      logTail: session.logTail,
      patch: {
        anchorLine: session.patch.anchorLine,
        anchorLines: session.patch.anchorLines,
        insertedCode: session.patch.insertedCode,
        sourceHash: session.originalHash,
      },
      projectId: this.projectId,
      programBatchId: session.batchId,
      // Kept for single-Program clients. Batch sessions expose the same stable
      // identifier here so an older UI never mistakes them for another draft.
      programTransactionId: session.batchId,
      progress: session.progress,
      sceneName: session.request.sceneName,
      sourcePath: session.request.sourcePath,
      status: session.status,
      updatedAt: session.updatedAt,
      videoUrl: session.videoPath && session.status !== "discarded"
        ? `/api/manim/renders/${session.id}/video`
        : null,
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
          `Manim command ${JSON.stringify(this.command)} is not available. Configure POIETRA_MANIM_COMMAND and restart Studio.`,
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
      const stem = basename(request.sourcePath, ".py")
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

  private assertRequestProject(request: ProgramRenderRequest) {
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
      throw new HttpError("The imported source changed before rendering or export. Reimport the workspace and create the draft again.", 409);
    }
    const importedSnapshot = importSourceSnapshot(originalSource, request.sourcePath, this.frame);
    const activeScene = sceneView(importedSnapshot.view, request.sceneName);
    if (!activeScene) {
      throw new HttpError(`${request.sceneName} is not an imported Scene in ${request.sourcePath}.`, 400);
    }
    if (activeScene.sourceHash !== request.sourceHash) {
      throw new HttpError("The source changed while Studio was lowering the program. Reimport and try again.", 409);
    }
    for (const binding of request.sourceBindings) {
      if (activeScene.sourceVariables[binding.entityId] !== binding.sourceVariable) {
        throw new HttpError(`Source target binding ${binding.entityId} → ${binding.sourceVariable} does not match the imported Scene.`, 400);
      }
    }
    const orderedPrograms = renderRequestPrograms(request)
      .map((program, inputIndex) => ({ inputIndex, program, sourceAnchor: program.anchor.resolvedSeconds }))
      .sort((left, right) => left.sourceAnchor - right.sourceAnchor || left.inputIndex - right.inputIndex);
    if (orderedPrograms.some(({ program }) => program.loweringStatus !== "supported")) {
      throw new HttpError("Every Program in a render batch must have supported source lowering.", 400);
    }
    const evaluated = evaluateWorkingState({
      appliedPrograms: orderedPrograms.map(({ program }) => programRecord(program, { issues: [], kind: "valid" })),
      editorContext: {
        activeSceneId: activeScene.sceneId,
        playhead: 0,
        selection: [],
        version: STUDIO_STATE_VERSION,
        viewport: request.viewport,
      },
      runtimeSceneState: activeScene.runtimeSceneState,
      sourceSnapshot: {
        configId: this.projectId,
        hash: request.sourceHash,
        sourceId: request.sourcePath,
        version: STUDIO_STATE_VERSION,
      },
      stagedPrograms: [],
      staticSemanticState: {
        entities: [],
        unknowns: [],
        version: STUDIO_STATE_VERSION,
      },
      version: STUDIO_STATE_VERSION,
    });
    const invalidRecord = evaluated.programs.find((record) => record.validation.status === "invalid");
    if (invalidRecord) {
      throw new HttpError(
        invalidRecord.validation.issues.find((issue) => issue.severity === "error")?.message
          ?? "A Canonical EditProgram is invalid for the imported Scene after timeline insertion.",
        400,
      );
    }
    const validatedPrograms = evaluated.programs.map((record) => record.program);
    const renderRequest: ProgramRenderRequest = request.programs
      ? { ...request, program: validatedPrograms[0]!, programs: validatedPrograms }
      : { ...request, program: validatedPrograms[0]! };
    const boundaryProgramIndexes = validatedPrograms.flatMap((program, index) => (
      program.operations.some((operation) => operation.kind === "InsertSceneBoundary") ? [index] : []
    ));
    if (boundaryProgramIndexes.length > 1 || (
      boundaryProgramIndexes.length === 1 && boundaryProgramIndexes[0] !== validatedPrograms.length - 1
    )) {
      throw new HttpError("A Scene-boundary Program must be the final Program in a render batch.", 400);
    }
    const hasSceneBoundary = boundaryProgramIndexes.length === 1;
    let incoming: Readonly<{
      initialization: readonly string[];
      visibleSourceVariables: readonly string[];
    }> | null = null;
    if (hasSceneBoundary) {
      if (!activeScene.nextSceneId || !renderRequest.destination) {
        throw new HttpError("This Scene transition requires the imported next Scene destination.", 400);
      }
      const destinationScene = sceneView(importedSnapshot.view, renderRequest.destination.sceneName);
      if (
        renderRequest.destination.sourcePath !== request.sourcePath
        || !destinationScene
        || destinationScene.sceneId !== activeScene.nextSceneId
      ) {
        throw new HttpError("The requested transition destination is not the active Scene's next imported Scene.", 400);
      }
      const importedDestination = importedScene(importedSnapshot.importedScenes, destinationScene.name);
      if (!importedDestination) {
        throw new HttpError("The next Scene could not be imported for transition preview.", 400);
      }
      incoming = {
        initialization: importedDestination.initialization,
        visibleSourceVariables: importedDestination.initialVisibleSourceVariables,
      };
    } else if (renderRequest.destination) {
      throw new HttpError("A render without a Scene boundary must not include a destination Scene.", 400);
    }
    const lowered = lowerCanonicalProgramBatchSource(
      originalSource,
      renderRequest,
      validatedPrograms.map((program, index) => ({
        program,
        sourceAnchor: orderedPrograms[index].sourceAnchor,
      })),
      this.frame,
      incoming,
    );
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
        actionInProgress: false,
        batchId: renderProgramBatchId(renderRequestPrograms(request)),
        child: null,
        createdAt: now,
        error: null,
        id: randomUUID(),
        logTail: "",
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
    const finishAction = this.beginSessionAction(session);
    try {
      await this.removeAbandonedSession(session);
    } finally {
      finishAction();
    }
  }

  private async run(session: RenderSession, previewSourcePath: string, mediaRoot: string) {
    session.status = "rendering";
    session.progress = 0.2;
    session.updatedAt = new Date().toISOString();
    try {
      const [executable, ...prefix] = this.command;
      const child = spawn(executable, [
        ...prefix,
        "-ql",
        "--disable_caching",
        "--media_dir",
        mediaRoot,
        previewSourcePath,
        session.request.sceneName,
      ], {
        cwd: this.projectRoot,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          PYTHONPATH: [this.projectRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      session.child = child;
      child.stdout?.on("data", (chunk: Buffer) => appendRenderLog(session, chunk));
      child.stderr?.on("data", (chunk: Buffer) => appendRenderLog(session, chunk));
      const exit = await waitForRenderExit(child, this.renderTimeoutMs);
      session.child = null;
      if (sessionWasStopped(session)) return;
      if (exit.code !== 0) {
        throw new Error(`Manim exited with ${exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`}.`);
      }
      const videoPath = await findRenderedVideo(mediaRoot, session.request.sceneName);
      if (!videoPath) throw new Error("Manim completed without producing an MP4 preview.");
      session.videoPath = videoPath;
      session.progress = 1;
      session.status = "ready";
      session.updatedAt = new Date().toISOString();
    } catch (error) {
      session.child = null;
      if (sessionWasStopped(session)) return;
      session.error = error instanceof Error ? error.message : "Manim render failed.";
      session.status = "failed";
      session.updatedAt = new Date().toISOString();
    }
  }

  async cancel(id: string) {
    return this.withSessionAction(id, async (session) => {
      if (session.status !== "preparing" && session.status !== "rendering") {
        throw new HttpError("Only an active render can be cancelled.", 409);
      }
      session.status = "cancelled";
      session.error = null;
      session.updatedAt = new Date().toISOString();
      const child = session.child;
      stopRenderProcess(child);
      await waitForRenderProcessStop(child);
      session.child = null;
      return this.toView(session);
    });
  }

  async commit(id: string) {
    return this.withSessionAction(id, async (session) => {
      if (session.status !== "ready") throw new HttpError("Only a successful preview can be committed.", 409);
      await this.sourceStore.writeIfUnchanged(
        session.request.sourcePath,
        session.originalHash,
        session.patchedSource,
        "The source changed after preview. Render again before committing.",
      );
      session.status = "committed";
      session.updatedAt = new Date().toISOString();
      return this.toView(session);
    });
  }

  async undo(id: string) {
    return this.withSessionAction(id, async (session) => {
      if (session.status !== "committed") throw new HttpError("Only a committed source change can be undone.", 409);
      await this.sourceStore.writeIfUnchanged(
        session.request.sourcePath,
        session.patchedHash,
        session.originalSource,
        "The committed source changed again, so Studio will not overwrite it during Undo.",
      );
      session.status = "undone";
      session.updatedAt = new Date().toISOString();
      return this.toView(session);
    });
  }

  async discard(id: string) {
    return this.withSessionAction(id, async (session) => {
      if (!["cancelled", "failed", "ready", "undone"].includes(session.status)) {
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
      const view = this.toView(session);
      this.removeSession(session.id);
      return view;
    });
  }

  videoPath(id: string) {
    const session = this.session(id);
    if (!session.videoPath || session.status === "discarded") throw new HttpError("Rendered video not found.", 404);
    return session.videoPath;
  }

  private async closeResources() {
    await this.waitForStarts();
    clearInterval(this.cleanupTimer);
    const results = await Promise.allSettled([...this.sessions.values()].map(async (session) => {
      const child = session.child;
      stopRenderProcess(child);
      await waitForRenderProcessStop(child);
      await rm(session.tempRoot, { force: true, recursive: true });
    }));
    for (const id of this.sessions.keys()) this.removeSession(id);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
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
}

export function parseManimProjects(value: string | undefined): readonly ManimProjectConfig[] | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const parsed = JSON.parse(normalized) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) {
    throw new TypeError("POIETRA_MANIM_PROJECTS must be a JSON array containing 1 to 64 configured projects.");
  }
  return parsed.map((entry, index) => {
    if (typeof entry === "string" && entry.trim()) return { root: entry.trim() };
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}] must be a root string or project object.`);
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["id", "name", "root"].includes(key))) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}] contains an unsupported field.`);
    }
    if (typeof record.root !== "string" || !record.root.trim()) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}].root must be a non-empty path.`);
    }
    if (record.id !== undefined && (typeof record.id !== "string" || !MANIM_PROJECT_ID_PATTERN.test(record.id))) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}].id must be an opaque lower-case identifier.`);
    }
    if (record.name !== undefined && (typeof record.name !== "string" || !record.name.trim() || record.name.trim().length > 120)) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}].name must contain 1 to 120 characters.`);
    }
    return {
      ...(record.id === undefined ? {} : { id: record.id }),
      ...(record.name === undefined ? {} : { name: record.name.trim() }),
      root: record.root.trim(),
    };
  });
}

export class ManimProjectRegistry {
  private readonly catalog: PersistentManimProjectCatalog | null;
  private readonly command: readonly string[];
  private readonly frame: Readonly<{ height: number; width: number }>;
  private readonly logger: StructuredLogger;
  private readonly managers = new Map<string, ManimRenderManager>();
  private readonly maxConcurrentRenders: number | undefined;
  private readonly maxRetainedSessions: number | undefined;
  private readonly renderTimeoutMs: number | undefined;
  private readonly sessionProjects = new Map<string, string>();
  private readonly sessionRetentionMs: number | undefined;

  constructor(options: Readonly<{
    catalog?: PersistentManimProjectCatalog;
    command: readonly string[];
    frame: Readonly<{ height: number; width: number }>;
    logger?: StructuredLogger;
    maxConcurrentRenders?: number;
    maxRetainedSessions?: number;
    projects: readonly ManimProjectConfig[];
    renderTimeoutMs?: number;
    sessionRetentionMs?: number;
  }>) {
    if (options.projects.length > 64) throw new TypeError("The Manim project registry accepts at most 64 projects.");
    this.catalog = options.catalog ?? null;
    this.command = options.command;
    this.frame = options.frame;
    this.logger = options.logger ?? nullLogger;
    this.maxConcurrentRenders = options.maxConcurrentRenders;
    this.maxRetainedSessions = options.maxRetainedSessions;
    this.renderTimeoutMs = options.renderTimeoutMs;
    this.sessionRetentionMs = options.sessionRetentionMs;
    const configuredProjects = this.catalog?.projects() ?? resolveManimProjects(options.projects);
    for (const project of configuredProjects) this.addManager(project);
  }

  get defaultProjectId() {
    return this.managers.keys().next().value ?? null;
  }

  private addManager({ canonicalRoot, kind, projectId, projectName }: ResolvedManimProject) {
    if (this.managers.has(projectId)) throw new TypeError(`Duplicate Manim project ID ${projectId}.`);
    this.managers.set(projectId, new ManimRenderManager({
      command: this.command,
      frame: this.frame,
      logger: this.logger.child({ projectId }),
      maxConcurrentRenders: this.maxConcurrentRenders,
      maxRetainedSessions: this.maxRetainedSessions,
      onSessionRemoved: (id) => this.sessionProjects.delete(id),
      projectId,
      projectKind: kind,
      projectName,
      projectRoot: canonicalRoot,
      renderTimeoutMs: this.renderTimeoutMs,
      sessionRetentionMs: this.sessionRetentionMs,
    }));
  }

  private mutableCatalog() {
    if (!this.catalog) throw new HttpError("Workspace registry mutations are not configured.", 405);
    return this.catalog;
  }

  private mutationView(project: ManimProjectMutationView["project"]): ManimProjectMutationView {
    return { catalog: this.projects(), project };
  }

  projects(): ManimProjectListView {
    return {
      defaultProjectId: this.defaultProjectId,
      projects: [...this.managers.values()].map((manager) => ({
        id: manager.projectId,
        kind: manager.projectKind,
        name: manager.projectName,
      })),
    };
  }

  async cleanupExpiredSessions(now = Date.now()) {
    await Promise.all([...this.managers.values()].map((manager) => manager.cleanupExpiredSessions(now)));
  }

  private project(projectId: string) {
    const manager = this.managers.get(projectId);
    if (!manager) throw new HttpError("Configured Manim project not found.", 404);
    return manager;
  }

  private sessionProject(id: string) {
    const projectId = this.sessionProjects.get(id);
    if (!projectId) throw new HttpError("Render session not found.", 404);
    return this.project(projectId);
  }

  createProject(name: string, root: string) {
    const catalog = this.mutableCatalog();
    const created = catalog.create(name, root);
    try {
      this.addManager(created);
    } catch (error) {
      catalog.unregister(created.projectId);
      throw error;
    }
    return this.mutationView({ id: created.projectId, kind: created.kind, name: created.projectName });
  }

  createManagedProject(name: string) {
    const catalog = this.mutableCatalog();
    const created = catalog.createManaged(name);
    try {
      this.addManager(created);
    } catch (error) {
      try {
        catalog.rollbackManagedCreation(created.projectId);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Could not roll back the managed workspace creation.");
      }
      throw error;
    }
    return this.mutationView({ id: created.projectId, kind: created.kind, name: created.projectName });
  }

  renameProject(projectId: string, name: string) {
    const manager = this.project(projectId);
    const renamed = this.mutableCatalog().rename(projectId, name);
    manager.renameProject(renamed.projectName);
    return this.mutationView({ id: projectId, kind: renamed.kind, name: renamed.projectName });
  }

  async unregisterProject(projectId: string) {
    const manager = this.project(projectId);
    if (!manager.canUnregister()) {
      throw new HttpError("Wait for active workspace work and discard retained render sessions before removing it from Studio.", 409);
    }
    this.mutableCatalog().remove(projectId);
    this.managers.delete(projectId);
    for (const [sessionId, sessionProjectId] of this.sessionProjects) {
      if (sessionProjectId === projectId) this.sessionProjects.delete(sessionId);
    }
    await manager.close();
    return this.mutationView(null);
  }

  workspace(projectId: string | null = this.defaultProjectId) {
    if (!projectId) throw new HttpError("No Manim workspace is registered.", 404);
    return this.project(projectId).workspace(projectId);
  }

  async start(request: ProgramRenderRequest, signal?: AbortSignal) {
    const session = await this.project(request.projectId).start(request, signal);
    this.sessionProjects.set(session.id, request.projectId);
    return session;
  }

  exportSource(request: ProgramRenderRequest, signal?: AbortSignal) {
    return this.project(request.projectId).exportSource(request, signal);
  }

  view(id: string) {
    return this.sessionProject(id).view(id);
  }

  cancel(id: string) {
    return this.sessionProject(id).cancel(id);
  }

  commit(id: string) {
    return this.sessionProject(id).commit(id);
  }

  undo(id: string) {
    return this.sessionProject(id).undo(id);
  }

  async discard(id: string) {
    const result = await this.sessionProject(id).discard(id);
    this.sessionProjects.delete(id);
    return result;
  }

  async abandonStart(id: string) {
    const projectId = this.sessionProjects.get(id);
    if (!projectId) return;
    await this.project(projectId).abandonStart(id);
    this.sessionProjects.delete(id);
  }

  videoPath(id: string) {
    return this.sessionProject(id).videoPath(id);
  }

  async close() {
    const results = await Promise.allSettled([...this.managers.values()].map((manager) => manager.close()));
    this.sessionProjects.clear();
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "Could not fully close the Manim project registry.");
  }
}

export function manimRenderPipeline(options: ManimRenderPipelineOptions = {}): Plugin {
  let manager: ManimProjectRegistry | null = null;
  const logger = createStructuredLogger({
    context: { component: "manim-render-api" },
    sinks: [createConsoleJsonSink({ includeData: false, prefix: "poietra-manim" })],
  });
  return {
    apply: "serve",
    name: "poietra-manim-render-pipeline",
    configResolved(config) {
      const seedProjects = options.projects?.length
        ? options.projects
        : [{ root: options.projectRoot ? resolve(options.projectRoot) : config.root }];
      const catalog = new PersistentManimProjectCatalog({
        dataRoot: options.workspaceDataRoot ? resolve(options.workspaceDataRoot) : join(config.root, ".poietra"),
        seedProjects,
      });
      manager = new ManimProjectRegistry({
        catalog,
        command: parseManimCommand(options.command),
        frame: {
          height: options.frameHeight ?? 8,
          width: options.frameWidth ?? 14.222,
        },
        logger,
        projects: seedProjects,
      });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/api/manim/")) {
          next();
          return;
        }
        if (!manager) {
          sendJson(response, 503, { error: "Manim render pipeline is not configured." });
          return;
        }
        await handleManimRequest(manager, request, response, logger);
      });
    },
    async closeBundle() {
      await manager?.close();
    },
  };
}
