import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const runnerPath = resolve("scripts/run-manim-smoke.mjs");

function captureProcess(executable: string, arguments_: readonly string[], timeoutMs = 10_000) {
  const child = spawn(executable, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
  }
  return new Promise<{ code: number; output: string }>((resolveClose) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      output = `${output}\n${error.message}`;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveClose({ code: code ?? 1, output });
    });
  });
}

async function dockerContainerIds(runId: string, runningOnly = false) {
  const result = await captureProcess("docker", [
    runningOnly ? "ps" : "ps",
    ...(runningOnly ? [] : ["--all"]),
    "--quiet",
    "--filter",
    `label=io.poietra.smoke-run=${runId}`,
  ]);
  if (result.code !== 0) throw new Error(`Could not list smoke containers: ${result.output}`);
  return result.output.trim().split(/\s+/).filter(Boolean);
}

async function waitForRenderMounts(runId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const id of await dockerContainerIds(runId, true)) {
      const inspected = await captureProcess("docker", ["container", "inspect", id]);
      if (inspected.code !== 0) continue;
      const container = (
        JSON.parse(inspected.output) as readonly {
          Mounts?: readonly { Destination?: string; Source?: string }[];
        }[]
      )[0];
      const mounts = container?.Mounts ?? [];
      const projectRoot = mounts.find((mount) => mount.Destination === "/workspace")?.Source;
      const renderRoot = mounts.find((mount) => mount.Destination === "/poietra-preview")?.Source;
      if (projectRoot && renderRoot) return { projectRoot, renderRoot };
    }
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 50));
  }
  throw new Error("The interrupt regression did not observe an active Manim render container.");
}

function waitForClose(child: ChildProcess, timeoutMs: number) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, rejectClose) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveClose({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectClose(new Error("The interrupted smoke runner did not stop within the timeout."));
    }, timeoutMs);
    timeout.unref();
    child.once("error", rejectClose);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveClose({ code, signal });
    });
  });
}

async function directorySnapshot(path: string) {
  const entries = await readdir(path);
  return Promise.all(
    entries.sort().map(async (name) => ({
      contents: await readFile(join(path, name), "base64"),
      name,
    })),
  );
}

async function expectMissing(path: string) {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe.skipIf(
  process.env.POIETRA_REAL_MANIM_SMOKE !== "1" ||
    process.env.POIETRA_SKIP_MANIM_INTERRUPT_REGRESSION === "1" ||
    Boolean(process.env.POIETRA_MANIM_COMMAND?.trim()),
)("real Manim smoke runner interruption", () => {
  it("owns and stops Vitest, Docker, temp roots, and artifact writes", { timeout: 60_000 }, async () => {
    const runId = `interrupt-${randomUUID()}`;
    const artifactRoot = await mkdtemp(join(tmpdir(), "poietra-manim-interrupt-artifacts-"));
    const staleArtifact = "stale artifact from an earlier run";
    await Promise.all([
      writeFile(join(artifactRoot, "preview.mp4"), staleArtifact),
      writeFile(join(artifactRoot, "summary.json"), staleArtifact),
    ]);
    let runner: ChildProcess | null = null;
    try {
      runner = spawn(process.execPath, [runnerPath], {
        env: {
          ...process.env,
          POIETRA_MANIM_SMOKE_ARTIFACTS: artifactRoot,
          POIETRA_MANIM_SMOKE_INTERRUPT_TARGET: "1",
          POIETRA_MANIM_SMOKE_RUN_ID: runId,
          POIETRA_SKIP_MANIM_INTERRUPT_REGRESSION: "1",
        },
        stdio: "ignore",
      });
      const mounts = await waitForRenderMounts(runId);
      runner.kill("SIGTERM");
      const stopped = await waitForClose(runner, 20_000);
      runner = null;
      expect(stopped).toEqual({ code: 143, signal: null });

      const metadata = JSON.parse(await readFile(join(artifactRoot, "runner.json"), "utf8")) as {
        cleanup?: { temporaryRoot?: string; temporaryRootRemoved?: boolean };
        dockerStopped?: boolean;
        requestedSignal?: string | null;
        treeStopped?: boolean;
      };
      expect(metadata).toMatchObject({
        cleanup: { temporaryRootRemoved: true },
        dockerStopped: true,
        requestedSignal: "SIGTERM",
        treeStopped: true,
      });
      expect(await dockerContainerIds(runId)).toEqual([]);
      await expectMissing(mounts.projectRoot);
      await expectMissing(mounts.renderRoot);
      await expectMissing(metadata.cleanup!.temporaryRoot!);
      for (const name of ["preview.mp4", "summary.json"]) {
        const contents = await readFile(join(artifactRoot, name), "utf8").catch(() => null);
        expect(contents).not.toBe(staleArtifact);
      }

      const atExit = await directorySnapshot(artifactRoot);
      await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 1_000));
      expect(await directorySnapshot(artifactRoot)).toEqual(atExit);
    } finally {
      if (runner) {
        runner.kill("SIGKILL");
        await waitForClose(runner, 5_000).catch(() => undefined);
      }
      for (const id of await dockerContainerIds(runId).catch(() => [])) {
        await captureProcess("docker", ["container", "rm", "--force", id]);
      }
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });
});
