import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import type { Plugin } from "vite";

import {
  type ProgramRenderRequest,
  type ManimWorkspaceSource,
  type ManimWorkspaceView,
  type RenderSessionStatus,
  type RenderSessionView,
} from "../src/render-pipeline/contracts";
import { findSceneBlocks, importManimScene } from "../src/render-pipeline/source-import";
import { lowerCanonicalProgramSource } from "../src/render-pipeline/source-lowering";
import { validateAndScheduleProgram } from "../src/studio/program-validation";
import { ManimPipelineError } from "./manim-pipeline-error";
import { handleManimRequest, sendJson } from "./manim-render-http";

type ManimRenderPipelineOptions = Readonly<{
  command?: string;
  frameHeight?: number;
  frameWidth?: number;
  projectRoot?: string;
}>;

type RenderSession = {
  child: ChildProcess | null;
  createdAt: string;
  error: string | null;
  id: string;
  logTail: string;
  originalHash: string;
  originalSource: string;
  patch: {
    anchorLine: number;
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

const MAX_LOG_BYTES = 40 * 1024;
const DEFAULT_SESSION_RETENTION_MS = 30 * 60 * 1_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".poietra",
  ".venv",
  "__pycache__",
  "dist",
  "media",
  "node_modules",
  "target",
]);

function sourceHash(source: string) {
  return createHash("sha256").update(source).digest("hex");
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
  const result = spawnSync(command[0], ["--version"], {
    stdio: "ignore",
    timeout: 3_000,
  });
  return result.error === undefined;
}

function scenesInSource(source: string) {
  return findSceneBlocks(source).map((block) => block.name);
}

async function discoverPythonSources(
  projectRoot: string,
  frame: Readonly<{ height: number; width: number }>,
) {
  const sources: Array<Readonly<{
    path: string;
    scenes: readonly NonNullable<ReturnType<typeof importManimScene>>[];
  }>> = [];
  async function visit(directory: string, relativeDirectory: string) {
    if (sources.length >= 200) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (sources.length >= 200) return;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        await visit(join(directory, entry.name), join(relativeDirectory, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".py")) continue;
      const absolutePath = join(directory, entry.name);
      const source = await readFile(absolutePath, "utf8");
      const relativePath = join(relativeDirectory, entry.name).split(sep).join("/");
      const scenes = scenesInSource(source).flatMap((name) => {
        const imported = importManimScene(source, relativePath, name, frame);
        return imported ? [imported] : [];
      });
      if (scenes.length === 0) continue;
      sources.push({
        path: relativePath,
        scenes,
      });
    }
  }
  await visit(projectRoot, "");
  const sorted = sources.sort((left, right) => left.path.localeCompare(right.path));
  return sorted.map((source): ManimWorkspaceSource => ({
    path: source.path,
    scenes: source.scenes.map((scene, index) => ({
      anchors: scene.anchors,
      name: scene.name,
      nextSceneId: source.scenes[index + 1]?.sceneId ?? null,
      runtimeSceneState: scene.runtimeSceneState,
      sceneId: scene.sceneId,
      sourceHash: scene.sourceHash,
      sourceVariables: scene.sourceVariables,
      staticSemanticState: scene.staticSemanticState,
    })),
  }));
}

async function findRenderedVideo(root: string): Promise<string | null> {
  const candidates: { modified: number; path: string }[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".mp4")) {
        const metadata = await stat(path);
        candidates.push({ modified: metadata.mtimeMs, path });
      }
    }
  }
  try {
    await visit(root);
  } catch {
    return null;
  }
  return candidates.sort((left, right) => right.modified - left.modified)[0]?.path ?? null;
}

async function writeAtomically(path: string, source: string) {
  const metadata = await stat(path);
  const temporaryPath = join(dirname(path), `.${basename(path)}.poietra-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, source, "utf8");
    await chmod(temporaryPath, metadata.mode);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function appendLog(session: RenderSession, chunk: Buffer | string) {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  session.logTail = `${session.logTail}${text}`.slice(-MAX_LOG_BYTES);
  session.updatedAt = new Date().toISOString();
  if (session.progress < 0.55 && text.trim().length > 0) session.progress = 0.55;
  const percentage = [...text.matchAll(/(\d{1,3})%/g)].at(-1)?.[1];
  if (percentage) session.progress = Math.max(session.progress, Math.min(0.95, Number(percentage) / 100));
}

function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const processId = child.pid;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Fall back to the direct child when the process group is already gone.
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  const forceStop = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32" && processId) {
      try {
        process.kill(-processId, "SIGKILL");
        return;
      } catch {
        // Fall back to the direct child when the process group is already gone.
      }
    }
    child.kill("SIGKILL");
  }, 2_000);
  forceStop.unref();
}

function sessionWasStopped(session: RenderSession) {
  return session.status === "cancelled" || session.status === "discarded";
}

export class ManimRenderManager {
  readonly command: readonly string[];
  readonly frame: Readonly<{ height: number; width: number }>;
  readonly projectRoot: string;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly sessionRetentionMs: number;
  private readonly sessions = new Map<string, RenderSession>();

  constructor(options: Readonly<{
    command: readonly string[];
    frame: Readonly<{ height: number; width: number }>;
    projectRoot: string;
    sessionRetentionMs?: number;
  }>) {
    this.command = options.command;
    this.frame = options.frame;
    this.projectRoot = resolve(options.projectRoot);
    this.sessionRetentionMs = options.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION_MS;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, Math.min(60_000, Math.max(100, this.sessionRetentionMs)));
    this.cleanupTimer.unref();
  }

  async cleanupExpiredSessions(now = Date.now()) {
    const expired = [...this.sessions.values()].filter((session) => (
      session.status !== "preparing"
      && session.status !== "rendering"
      && now - Date.parse(session.updatedAt) >= this.sessionRetentionMs
    ));
    await Promise.all(expired.map(async (session) => {
      this.sessions.delete(session.id);
      await rm(session.tempRoot, { force: true, recursive: true });
    }));
  }

  async workspace(): Promise<ManimWorkspaceView> {
    return {
      command: this.command,
      commandAvailable: commandIsAvailable(this.command),
      frame: this.frame,
      projectRoot: this.projectRoot,
      sources: await discoverPythonSources(this.projectRoot, this.frame),
    };
  }

  private async sourcePath(relativePath: string) {
    const absolutePath = resolve(this.projectRoot, relativePath);
    const relativePathFromRoot = relative(this.projectRoot, absolutePath);
    if (
      relativePathFromRoot === ".."
      || relativePathFromRoot.startsWith(`..${sep}`)
      || isAbsolute(relativePathFromRoot)
      || !absolutePath.endsWith(".py")
    ) {
      throw new ManimPipelineError(400, "The source file must be a Python file inside the configured Manim project root.");
    }
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch {
      throw new ManimPipelineError(404, "The selected Python source does not exist.");
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ManimPipelineError(400, "The selected Python source must be a regular file, not a symbolic link.");
    }
    const [canonicalRoot, canonicalSource] = await Promise.all([
      realpath(this.projectRoot),
      realpath(absolutePath),
    ]);
    const canonicalRelativePath = relative(canonicalRoot, canonicalSource);
    if (canonicalRelativePath === ".." || canonicalRelativePath.startsWith(`..${sep}`) || isAbsolute(canonicalRelativePath)) {
      throw new ManimPipelineError(400, "The selected Python source resolves outside the configured Manim project root.");
    }
    return absolutePath;
  }

  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new ManimPipelineError(404, "Render session not found.");
    return session;
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
        insertedCode: session.patch.insertedCode,
        sourceHash: session.originalHash,
      },
      programTransactionId: session.request.program.transactionId,
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

  async start(request: ProgramRenderRequest) {
    if (!commandIsAvailable(this.command)) {
      throw new ManimPipelineError(
        503,
        `Manim command ${JSON.stringify(this.command)} is not available. Configure POIETRA_MANIM_COMMAND and restart Studio.`,
      );
    }
    const sourcePath = await this.sourcePath(request.sourcePath);
    const originalSource = await readFile(sourcePath, "utf8");
    if (sourceHash(originalSource) !== request.sourceHash) {
      throw new ManimPipelineError(409, "The imported source changed before rendering. Reimport the workspace and create the draft again.");
    }
    if (!scenesInSource(originalSource).includes(request.sceneName)) {
      throw new ManimPipelineError(400, `${request.sceneName} is not declared in ${request.sourcePath}.`);
    }
    const workspace = await this.workspace();
    const activeScene = workspace.sources
      .find((source) => source.path === request.sourcePath)
      ?.scenes.find((scene) => scene.name === request.sceneName);
    if (!activeScene) {
      throw new ManimPipelineError(400, `${request.sceneName} is not an imported Scene in ${request.sourcePath}.`);
    }
    if (activeScene.sourceHash !== request.sourceHash) {
      throw new ManimPipelineError(409, "The source changed while Studio was preparing the render. Reimport and try again.");
    }
    const validation = validateAndScheduleProgram(request.program, activeScene.runtimeSceneState);
    if (validation.kind === "invalid") {
      throw new ManimPipelineError(
        400,
        validation.issues.find((issue) => issue.severity === "error")?.message
          ?? "The Canonical EditProgram is invalid for the imported Scene.",
      );
    }
    for (const binding of request.sourceBindings) {
      if (activeScene.sourceVariables[binding.entityId] !== binding.sourceVariable) {
        throw new ManimPipelineError(400, `Source binding ${binding.entityId} → ${binding.sourceVariable} does not match the imported Scene.`);
      }
    }
    const renderRequest: ProgramRenderRequest = { ...request, program: validation.program };
    const hasSceneBoundary = renderRequest.program.operations.some((operation) => operation.kind === "InsertSceneBoundary");
    let incoming: Readonly<{
      initialization: readonly string[];
      visibleSourceVariables: readonly string[];
    }> | null = null;
    if (hasSceneBoundary) {
      if (!activeScene.nextSceneId || !renderRequest.destination) {
        throw new ManimPipelineError(400, "This Scene transition requires the imported next Scene destination.");
      }
      const destinationSource = workspace.sources.find((source) => source.path === renderRequest.destination?.sourcePath);
      const destinationScene = destinationSource?.scenes.find((scene) => (
        scene.name === renderRequest.destination?.sceneName && scene.sceneId === activeScene.nextSceneId
      ));
      if (!destinationSource || !destinationScene) {
        throw new ManimPipelineError(400, "The requested transition destination is not the active Scene's next imported Scene.");
      }
      const destinationPath = await this.sourcePath(destinationSource.path);
      const destinationSourceText = await readFile(destinationPath, "utf8");
      const importedDestination = importManimScene(
        destinationSourceText,
        destinationSource.path,
        destinationScene.name,
        this.frame,
      );
      if (!importedDestination) {
        throw new ManimPipelineError(400, "The next Scene could not be imported for transition preview.");
      }
      incoming = {
        initialization: importedDestination.initialization,
        visibleSourceVariables: importedDestination.initialVisibleSourceVariables,
      };
    } else if (renderRequest.destination) {
      throw new ManimPipelineError(400, "A render without a Scene boundary must not include a destination Scene.");
    }
    const lowered = lowerCanonicalProgramSource(originalSource, renderRequest, this.frame, incoming);
    const tempRoot = await mkdtemp(join(tmpdir(), "poietra-manim-render-"));
    const previewSourcePath = join(tempRoot, basename(sourcePath));
    const mediaRoot = join(tempRoot, "media");
    try {
      await mkdir(mediaRoot, { recursive: true });
      await writeFile(previewSourcePath, lowered.source, "utf8");
    } catch (error) {
      await rm(tempRoot, { force: true, recursive: true });
      throw error;
    }

    const now = new Date().toISOString();
    const session: RenderSession = {
      child: null,
      createdAt: now,
      error: null,
      id: randomUUID(),
      logTail: "",
      originalHash: sourceHash(originalSource),
      originalSource,
      patch: {
        anchorLine: lowered.anchorLine,
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
    void this.run(session, previewSourcePath, mediaRoot);
    return this.toView(session);
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
      child.stdout?.on("data", (chunk: Buffer) => appendLog(session, chunk));
      child.stderr?.on("data", (chunk: Buffer) => appendLog(session, chunk));
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      });
      session.child = null;
      if (sessionWasStopped(session)) return;
      if (exit.code !== 0) {
        throw new Error(`Manim exited with ${exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`}.`);
      }
      const videoPath = await findRenderedVideo(mediaRoot);
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

  cancel(id: string) {
    const session = this.session(id);
    if (session.status !== "preparing" && session.status !== "rendering") {
      throw new ManimPipelineError(409, "Only an active render can be cancelled.");
    }
    stopChild(session.child);
    session.status = "cancelled";
    session.error = null;
    session.updatedAt = new Date().toISOString();
    return this.toView(session);
  }

  async commit(id: string) {
    const session = this.session(id);
    if (session.status !== "ready") throw new ManimPipelineError(409, "Only a successful preview can be committed.");
    const sourcePath = await this.sourcePath(session.request.sourcePath);
    const currentSource = await readFile(sourcePath, "utf8");
    if (sourceHash(currentSource) !== session.originalHash) {
      throw new ManimPipelineError(409, "The source changed after preview. Render again before committing.");
    }
    await writeAtomically(sourcePath, session.patchedSource);
    session.status = "committed";
    session.updatedAt = new Date().toISOString();
    return this.toView(session);
  }

  async undo(id: string) {
    const session = this.session(id);
    if (session.status !== "committed") throw new ManimPipelineError(409, "Only a committed source change can be undone.");
    const sourcePath = await this.sourcePath(session.request.sourcePath);
    const currentSource = await readFile(sourcePath, "utf8");
    if (sourceHash(currentSource) !== session.patchedHash) {
      throw new ManimPipelineError(409, "The committed source changed again, so Studio will not overwrite it during Undo.");
    }
    await writeAtomically(sourcePath, session.originalSource);
    session.status = "undone";
    session.updatedAt = new Date().toISOString();
    return this.toView(session);
  }

  async discard(id: string) {
    const session = this.session(id);
    if (!["cancelled", "failed", "ready", "undone"].includes(session.status)) {
      throw new ManimPipelineError(409, "Cancel an active render or Undo a committed change before discarding it.");
    }
    stopChild(session.child);
    await rm(session.tempRoot, { force: true, recursive: true });
    session.child = null;
    session.videoPath = null;
    session.status = "discarded";
    session.updatedAt = new Date().toISOString();
    return this.toView(session);
  }

  videoPath(id: string) {
    const session = this.session(id);
    if (!session.videoPath || session.status === "discarded") throw new ManimPipelineError(404, "Rendered video not found.");
    return session.videoPath;
  }

  async close() {
    clearInterval(this.cleanupTimer);
    await Promise.all([...this.sessions.values()].map(async (session) => {
      stopChild(session.child);
      await rm(session.tempRoot, { force: true, recursive: true });
    }));
    this.sessions.clear();
  }
}

export function manimRenderPipeline(options: ManimRenderPipelineOptions = {}): Plugin {
  let manager: ManimRenderManager | null = null;
  return {
    name: "poietra-manim-render-pipeline",
    configResolved(config) {
      manager = new ManimRenderManager({
        command: parseManimCommand(options.command),
        frame: {
          height: options.frameHeight ?? 8,
          width: options.frameWidth ?? 14.222,
        },
        projectRoot: options.projectRoot ? resolve(options.projectRoot) : config.root,
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
        await handleManimRequest(manager, request, response);
      });
      return () => {
        void manager?.close();
      };
    },
  };
}
