import type { ChildProcess } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const MAX_LOG_BYTES = 40 * 1024;
const MAX_MEDIA_DIRECTORIES = 1_000;
const PARTIAL_MOVIE_DIRECTORY = "partial_movie_files";
const forceStopTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();

type RenderProcessProgress = {
  logTail: string;
  progress: number;
  updatedAt: string;
};

export function appendRenderLog(session: RenderProcessProgress, chunk: Buffer | string) {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  session.logTail = `${session.logTail}${text}`.slice(-MAX_LOG_BYTES);
  session.updatedAt = new Date().toISOString();
  if (session.progress < 0.55 && text.trim().length > 0) session.progress = 0.55;
  const percentage = [...text.matchAll(/(\d{1,3})%/g)].at(-1)?.[1];
  if (percentage) session.progress = Math.max(session.progress, Math.min(0.95, Number(percentage) / 100));
}

export async function findRenderedVideo(root: string, sceneName: string): Promise<string | null> {
  const candidates: { modified: number; path: string }[] = [];
  let visitedDirectories = 0;
  async function visit(directory: string) {
    visitedDirectories += 1;
    if (visitedDirectories > MAX_MEDIA_DIRECTORIES) {
      throw new Error("Manim produced an unexpectedly large media directory tree.");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== PARTIAL_MOVIE_DIRECTORY) await visit(path);
      else if (entry.isFile() && entry.name === `${sceneName}.mp4`) {
        const metadata = await lstat(path);
        if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0) {
          candidates.push({ modified: metadata.mtimeMs, path });
        }
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

export async function findRenderedImage(root: string, sceneName: string): Promise<string | null> {
  const candidates: { modified: number; path: string }[] = [];
  let visitedDirectories = 0;
  async function visit(directory: string) {
    visitedDirectories += 1;
    if (visitedDirectories > MAX_MEDIA_DIRECTORIES) {
      throw new Error("Manim produced an unexpectedly large media directory tree.");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== PARTIAL_MOVIE_DIRECTORY) await visit(path);
      else if (entry.isFile() && entry.name === `${sceneName}.png`) {
        const metadata = await lstat(path);
        if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0) {
          candidates.push({ modified: metadata.mtimeMs, path });
        }
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

function signalRenderProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may not own a detached group; fall through to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A concurrent exit means there is nothing left to stop.
  }
}

export function stopRenderProcess(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalRenderProcess(child, "SIGTERM");
  if (forceStopTimers.has(child)) return;
  const forceStop = setTimeout(() => {
    forceStopTimers.delete(child);
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalRenderProcess(child, "SIGKILL");
  }, 2_000);
  forceStop.unref();
  forceStopTimers.set(child, forceStop);
  child.once("exit", () => {
    const timer = forceStopTimers.get(child);
    if (timer) clearTimeout(timer);
    forceStopTimers.delete(child);
  });
}

export async function waitForRenderProcessStop(child: ChildProcess | null, timeoutMs = 2_500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveWait) => {
    const finish = () => {
      clearTimeout(timeout);
      child.removeListener("error", finish);
      child.removeListener("exit", finish);
      resolveWait();
    };
    const timeout = setTimeout(finish, timeoutMs);
    timeout.unref();
    child.once("error", finish);
    child.once("exit", finish);
  });
}

export function waitForRenderExit(child: ChildProcess, timeoutMs: number) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      rejectExit(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const timeout = setTimeout(() => {
      cleanup();
      stopRenderProcess(child);
      void waitForRenderProcessStop(child).then(() => {
        rejectExit(new Error(`Manim render exceeded the ${timeoutMs}ms timeout.`));
      });
    }, timeoutMs);
    timeout.unref();
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
