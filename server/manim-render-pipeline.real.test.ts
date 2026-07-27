import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { ManimRenderManager, parseManimCommand } from "./manim-render-pipeline";
import { sourceHash } from "./manim-source-store";

const fixturePath = fileURLToPath(new URL("./test-fixtures/real-manim-smoke.py", import.meta.url));
const dockerRunnerPath = fileURLToPath(new URL("../scripts/manim-docker-runner.mjs", import.meta.url));
const artifactRoot = resolve(process.env.POIETRA_MANIM_SMOKE_ARTIFACTS ?? "test-results/manim-smoke");

type SmokeDiagnostic = {
  cleanup: {
    projectRootRemoved: boolean;
    renderRootRemoved: boolean | null;
  };
  command: readonly string[];
  dockerImage: string | null;
  error: string | null;
  hashes: {
    committed: string | null;
    original: string | null;
    undone: string | null;
  };
  outcome: "failed" | "passed" | "running";
  render: {
    error: string | null;
    logTail: string;
    probe: {
      decodedFrames: number | null;
      duration: number;
      formatName: string;
      videoStreams: number;
    } | null;
    status: string | null;
    videoBytes: number | null;
  };
};

function configuredCommand() {
  return process.env.POIETRA_MANIM_COMMAND?.trim()
    ? parseManimCommand(process.env.POIETRA_MANIM_COMMAND)
    : [process.execPath, dockerRunnerPath];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}`.trim() : String(error);
}

async function captureCommand(command: readonly string[], timeoutMs = 30_000) {
  const [executable, ...arguments_] = command;
  const child = spawn(executable, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-64 * 1024);
  });
  const result = await new Promise<{ code: number; error: Error | null }>((resolveExit) => {
    let spawnError: Error | null = null;
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveExit({ code: code ?? 1, error: spawnError });
    });
  });
  if (result.error || result.code !== 0) {
    throw new Error(`MP4 probe failed: ${result.error?.message ?? (stderr.trim() || `exit code ${result.code}`)}`);
  }
  return stdout;
}

async function probeMp4(videoPath: string) {
  const explicitProbe = process.env.POIETRA_MANIM_FFPROBE_COMMAND?.trim();
  const command = explicitProbe
    ? [
        ...parseManimCommand(explicitProbe),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "format=format_name,duration:stream=codec_type,width,height,duration",
        videoPath,
      ]
    : process.env.POIETRA_MANIM_COMMAND?.trim()
      ? [
          "ffprobe",
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_entries",
          "format=format_name,duration:stream=codec_type,width,height,duration",
          videoPath,
        ]
      : [process.execPath, dockerRunnerPath, "--poietra-probe-json", videoPath];
  const parsed = JSON.parse(await captureCommand(command)) as {
    decoded_frames?: number;
    format?: { duration?: string; format_name?: string };
    streams?: readonly { codec_type?: string; height?: number; width?: number }[];
  };
  const duration = Number(parsed.format?.duration);
  const decodedFrames = parsed.decoded_frames ?? null;
  const formatName = parsed.format?.format_name ?? "";
  const videoStreams = (parsed.streams ?? []).filter(
    (stream) =>
      stream.codec_type === "video" &&
      Number.isFinite(stream.width) &&
      Number.isFinite(stream.height) &&
      stream.width! > 0 &&
      stream.height! > 0,
  ).length;
  expect(formatName.split(",")).toContain("mp4");
  expect(duration).toBeGreaterThan(0);
  expect(videoStreams).toBeGreaterThan(0);
  if (!explicitProbe && !process.env.POIETRA_MANIM_COMMAND?.trim()) {
    expect(decodedFrames).toBeGreaterThan(0);
  }
  return { decodedFrames, duration, formatName, videoStreams };
}

async function pathIsMissing(path: string) {
  try {
    await access(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function renderTempRoot(videoPath: string) {
  let current = dirname(videoPath);
  while (dirname(current) !== current) {
    if (basename(current).startsWith("poietra-manim-render-")) return current;
    current = dirname(current);
  }
  throw new Error(`Rendered video is not inside a Poietra temporary render root: ${videoPath}`);
}

async function waitForTerminal(manager: ManimRenderManager, id: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const session = manager.view(id);
    if (["cancelled", "failed", "ready"].includes(session.status)) return session;
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 100));
  }
  throw new Error("The real Manim preview did not finish within 120 seconds.");
}

function renderRequest(originalHash: string, targetEntityId: string): ProgramRenderRequest {
  const operation: CanonicalEditOperation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 32, y: 0 },
    dependsOn: [],
    easing: "smooth",
    id: "tx:real-manim-smoke/operation:motion",
    interval: {
      end: process.env.POIETRA_MANIM_SMOKE_INTERRUPT_TARGET === "1" ? 8 : 0.4,
      start: 0.2,
    },
    kind: "CreateMotion",
    provenance: { evidence: ["real-manim-smoke"], origin: "direct-manipulation" },
    targetEntityIds: [targetEntityId],
  };
  const program: CanonicalEditProgram = {
    anchor: {
      capturedPlayhead: 0.2,
      evidence: ["captured-playhead:0.200"],
      resolvedSeconds: 0.2,
      source: { kind: "playhead", referenceSeconds: 0.2 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["real-manim-smoke"], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId: "real-manim-smoke",
    version: 1,
  };
  return {
    destination: null,
    program,
    projectId: "real-manim-smoke",
    sceneName: "SmokeScene",
    sourceBindings: [{ entityId: targetEntityId, sourceVariable: "circle" }],
    sourceHash: originalHash,
    sourcePath: "scene.py",
    viewport: { height: 360, width: 640 },
  };
}

describe.skipIf(process.env.POIETRA_REAL_MANIM_SMOKE !== "1")("real Manim render smoke", () => {
  it("renders an MP4 and preserves exact source through commit, Undo, and cleanup", { timeout: 180_000 }, async () => {
    await mkdir(artifactRoot, { recursive: true });
    const projectRoot = await mkdtemp(join(tmpdir(), "poietra-real-manim-smoke-"));
    const sourcePath = join(projectRoot, "scene.py");
    const fixtureSource = await readFile(fixturePath, "utf8");
    await writeFile(
      sourcePath,
      process.env.POIETRA_MANIM_SMOKE_INTERRUPT_TARGET === "1"
        ? fixtureSource.replace("self.wait(0.5)", "self.wait(10)")
        : fixtureSource,
      "utf8",
    );

    const command = configuredCommand();
    const manager = new ManimRenderManager({
      command,
      frame: { height: 8, width: 14.222 },
      projectId: "real-manim-smoke",
      projectRoot,
      renderTimeoutMs: 120_000,
      tenantId: "test-tenant",
    });
    const diagnostic: SmokeDiagnostic = {
      cleanup: { projectRootRemoved: false, renderRootRemoved: null },
      command,
      dockerImage: process.env.POIETRA_MANIM_DOCKER_IMAGE ?? null,
      error: null,
      hashes: { committed: null, original: null, undone: null },
      outcome: "running",
      render: { error: null, logTail: "", probe: null, status: null, videoBytes: null },
    };
    let failure: unknown = null;
    let renderRoot: string | null = null;
    let sessionId: string | null = null;

    try {
      const originalSource = await readFile(sourcePath, "utf8");
      const originalHash = sourceHash(originalSource);
      diagnostic.hashes.original = originalHash;

      const workspace = await manager.workspace();
      expect(workspace.commandAvailable).toBe(true);
      const scene = workspace.sources
        .find((source) => source.path === "scene.py")
        ?.scenes.find((candidate) => candidate.name === "SmokeScene");
      expect(scene).toBeDefined();
      const targetEntityId = Object.entries(scene?.sourceVariables ?? {}).find(
        ([, sourceVariable]) => sourceVariable === "circle",
      )?.[0];
      expect(targetEntityId).toBeTruthy();

      const started = await manager.start(renderRequest(originalHash, targetEntityId!));
      sessionId = started.id;
      const rendered = await waitForTerminal(manager, started.id);
      diagnostic.render = {
        error: rendered.error,
        logTail: rendered.logTail,
        probe: null,
        status: rendered.status,
        videoBytes: null,
      };
      if (rendered.status !== "ready") {
        throw new Error(`Real Manim render ended as ${rendered.status}: ${rendered.error ?? rendered.logTail}`);
      }

      const videoPath = manager.videoPath(started.id);
      renderRoot = renderTempRoot(videoPath);
      const video = await stat(videoPath);
      expect(video.size).toBeGreaterThan(0);
      diagnostic.render.probe = await probeMp4(videoPath);
      diagnostic.render.videoBytes = video.size;
      await copyFile(videoPath, join(artifactRoot, "preview.mp4"));

      const committed = await manager.commit(started.id, {
        actionId: "00000000-0000-4000-8000-000000000001",
        programBatchId: rendered.programBatchId,
        projectId: rendered.projectId,
        renderRequestId: rendered.renderRequestId,
        sceneName: rendered.sceneName,
        sourceHash: rendered.patch.sourceHash,
        sourcePath: rendered.sourcePath,
      });
      expect(committed.status).toBe("committed");
      const committedSource = await readFile(sourcePath, "utf8");
      diagnostic.hashes.committed = sourceHash(committedSource);
      expect(diagnostic.hashes.committed).not.toBe(originalHash);
      expect(committedSource).toContain('poietra:transaction "real-manim-smoke"');

      const undone = await manager.undo(started.id, "00000000-0000-4000-8000-000000000002");
      expect(undone.status).toBe("undone");
      const undoneSource = await readFile(sourcePath, "utf8");
      diagnostic.hashes.undone = sourceHash(undoneSource);
      expect(undoneSource).toBe(originalSource);
      expect(diagnostic.hashes.undone).toBe(originalHash);

      const discarded = await manager.discard(started.id);
      expect(discarded.status).toBe("discarded");
      diagnostic.cleanup.renderRootRemoved = await pathIsMissing(renderRoot);
      expect(diagnostic.cleanup.renderRootRemoved).toBe(true);
      diagnostic.outcome = "passed";
    } catch (error) {
      failure = error;
      diagnostic.error = errorMessage(error);
      diagnostic.outcome = "failed";
      if (sessionId) {
        try {
          const session = manager.view(sessionId);
          diagnostic.render = {
            error: session.error,
            logTail: session.logTail,
            probe: diagnostic.render.probe,
            status: session.status,
            videoBytes: diagnostic.render.videoBytes,
          };
        } catch {
          // The session may already have been discarded by the successful path.
        }
      }
    } finally {
      try {
        await manager.close();
      } catch (error) {
        failure ??= error;
        diagnostic.error ??= errorMessage(error);
        diagnostic.outcome = "failed";
      }
      await rm(projectRoot, { force: true, recursive: true });
      diagnostic.cleanup.projectRootRemoved = await pathIsMissing(projectRoot);
      if (renderRoot) diagnostic.cleanup.renderRootRemoved = await pathIsMissing(renderRoot);
      await writeFile(join(artifactRoot, "summary.json"), `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
    }

    if (failure) throw failure;
    expect(diagnostic.cleanup).toEqual({ projectRootRemoved: true, renderRootRemoved: true });
  });
});
