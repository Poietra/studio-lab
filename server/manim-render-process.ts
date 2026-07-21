import type { ChildProcess } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_LOG_BYTES = 40 * 1024;

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

export async function findRenderedVideo(root: string): Promise<string | null> {
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

export function stopRenderProcess(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const processId = child.pid;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
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
