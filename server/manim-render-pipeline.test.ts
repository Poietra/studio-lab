import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ProgramRenderRequest, RenderSessionView } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { ManimRenderManager, parseManimCommand } from "./manim-render-pipeline";

const fakeRenderer = fileURLToPath(new URL("./test-fixtures/fake-manim.mjs", import.meta.url));
const temporaryRoots: string[] = [];
const managers: ManimRenderManager[] = [];

const sceneSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        # poietra:anchor 7.000
        self.wait(1)
`;

function request(sourcePath = "scene.py"): ProgramRenderRequest {
  const operation: CanonicalEditOperation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 64, y: 0 },
    dependsOn: [],
    easing: "smooth",
    id: "tx:render-integration/operation:motion",
    interval: { end: 8, start: 7 },
    kind: "CreateMotion",
    provenance: { evidence: [], origin: "direct-manipulation" },
    targetEntityIds: ["source:scene.py#GroupedEquation:equation"],
  };
  const program: CanonicalEditProgram = {
    anchor: {
      capturedPlayhead: 7,
      evidence: ["captured-playhead:7.000"],
      resolvedSeconds: 7,
      source: { kind: "playhead", referenceSeconds: 7 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId: "render-integration",
    version: 1,
  };
  return {
    destination: null,
    program,
    sceneName: "GroupedEquation",
    sourceBindings: [{ entityId: "source:scene.py#GroupedEquation:equation", sourceVariable: "equation" }],
    sourcePath,
    viewport: { height: 360, width: 640 },
  };
}

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "poietra-render-test-"));
  temporaryRoots.push(projectRoot);
  await writeFile(join(projectRoot, "scene.py"), sceneSource, "utf8");
  const manager = new ManimRenderManager({
    command: [process.execPath, fakeRenderer],
    frame: { height: 8, width: 14.222 },
    projectRoot,
  });
  managers.push(manager);
  return { manager, projectRoot };
}

async function waitForTerminal(manager: ManimRenderManager, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = manager.view(id);
    if (["cancelled", "failed", "ready"].includes(session.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Render session did not finish.");
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Manim render manager", () => {
  it("discovers Scenes and runs preview, commit, and exact Undo", async () => {
    const { manager, projectRoot } = await fixture();
    const workspace = await manager.workspace();
    expect(workspace.commandAvailable).toBe(true);
    expect(workspace.sources).toHaveLength(1);
    expect(workspace.sources[0]?.path).toBe("scene.py");
    expect(workspace.sources[0]?.scenes).toHaveLength(1);
    expect(workspace.sources[0]?.scenes[0]).toMatchObject({
      anchors: [7],
      name: "GroupedEquation",
      nextSceneId: null,
      sceneId: "scene.py#GroupedEquation",
    });
    expect(workspace.sources[0]?.scenes[0]?.runtimeSceneState.objectGraph.entities)
      .toHaveProperty("source:scene.py#GroupedEquation:equation");

    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);
    expect(rendered.status).toBe("ready");
    expect(rendered.progress).toBe(1);
    expect(rendered.logTail).toContain("100%");
    expect(rendered.videoUrl).toContain(started.id);
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(sceneSource);

    const committed = await manager.commit(started.id);
    expect(committed.status).toBe("committed");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toContain('poietra:transaction "render-integration"');

    const undone = await manager.undo(started.id);
    expect(undone.status).toBe("undone");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(sceneSource);
  });

  it("refuses to overwrite source changed after preview", async () => {
    const { manager, projectRoot } = await fixture();
    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);
    expect(rendered.status).toBe("ready");
    await writeFile(join(projectRoot, "scene.py"), `${sceneSource}\n# external change\n`, "utf8");

    await expect(manager.commit(started.id)).rejects.toThrow(/source changed after preview/i);
  });

  it("cancels an active render and permits discard", async () => {
    const { manager } = await fixture();
    const started = await manager.start(request());
    const cancelled = manager.cancel(started.id);
    expect(cancelled.status).toBe("cancelled");
    const discarded = await manager.discard(started.id);
    expect(discarded.status).toBe("discarded");
  });

  it("rejects source paths outside the configured root", async () => {
    const { manager, projectRoot } = await fixture();
    const outsideName = `${basename(projectRoot)}-outside.py`;
    const outsidePath = join(dirname(projectRoot), outsideName);
    await writeFile(outsidePath, sceneSource, "utf8");
    try {
      await expect(manager.start(request(`../${outsideName}`))).rejects.toThrow(/inside the configured Manim project root/i);
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  it("rejects source symlinks even when the link is inside the configured root", async () => {
    const { manager, projectRoot } = await fixture();
    const outsideName = `${basename(projectRoot)}-linked.py`;
    const outsidePath = join(dirname(projectRoot), outsideName);
    await writeFile(outsidePath, sceneSource, "utf8");
    await symlink(outsidePath, join(projectRoot, "linked.py"));
    try {
      await expect(manager.start(request("linked.py"))).rejects.toThrow(/symbolic link/i);
    } finally {
      await rm(outsidePath, { force: true });
    }
  });
});

describe("Manim command parsing", () => {
  it("accepts a JSON command without invoking a shell", () => {
    expect(parseManimCommand('["uv", "run", "manim"]')).toEqual(["uv", "run", "manim"]);
    expect(parseManimCommand(undefined)).toEqual(["manim"]);
  });
});
