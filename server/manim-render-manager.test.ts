import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as createHttpRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type ProgramRenderRequest, renderProgramBatchId } from "../src/render-pipeline/contracts";
import { importManimScene } from "../src/render-pipeline/source-import";
import { createSceneDurationProgram } from "../src/studio/authoring-commands";
import type { CanonicalEditProgram } from "../src/studio/operations";
import {
  createDirectManipulationPositionProgram,
  createDirectManipulationScaleProgram,
} from "../src/studio/suggestion-program";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { createTrustedLocalManimRequestContext } from "./manim-local-request-context";
import { handleManimRequest } from "./manim-render-http";
import type { ManimRenderManager } from "./manim-render-pipeline";
import {
  batchRequest,
  cleanupManimRenderPipelineFixtures,
  commitRequest,
  createCircleProgram,
  deferred,
  fakeRenderer,
  fixture,
  installVerifiedSnapshot,
  motionProgram,
  request,
  sceneSource,
  temporalMetadataSource,
  temporaryRoots,
  waitForTerminal,
  waitUntil,
} from "./manim-render-pipeline-test-fixtures";

afterEach(cleanupManimRenderPipelineFixtures);

function scaleCreatedEntityProgram(entityId: string): CanonicalEditProgram {
  const operation = {
    control: undefined,
    dependsOn: [],
    easing: "smooth" as const,
    entityId,
    from: 1,
    id: "server-created-scale/operation:scale",
    interval: { end: 7, start: 7 },
    key: "scale" as const,
    kind: "AnimateProperty" as const,
    provenance: { evidence: [], origin: "direct-manipulation" as const },
    relativeFactor: 1.5,
    to: 1.5,
  };
  return {
    anchor: {
      capturedPlayhead: 7,
      evidence: [],
      resolvedSeconds: 7,
      source: { kind: "playhead", referenceSeconds: 7 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "server-created-scale",
    version: 1,
  };
}

function removeCreatedEntityProgram(entityId: string): CanonicalEditProgram {
  const operation = {
    dependsOn: [],
    effect: "remove" as const,
    entityId,
    id: "server-created-remove/operation:remove",
    interval: { end: 7.4, start: 7 },
    kind: "ChangePresence" as const,
    persistent: true,
    provenance: { evidence: [], origin: "studio-default" as const },
  };
  return {
    anchor: {
      capturedPlayhead: 7,
      evidence: [],
      resolvedSeconds: 7,
      source: { kind: "playhead", referenceSeconds: 7 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId: "server-created-remove",
    version: 1,
  };
}

function rustAuthorizableCircleCreationProgram(transactionId: string, entityName = "circle"): CanonicalEditProgram {
  const program = createCircleProgram(transactionId, entityName);
  const [create, position, presence] = program.operations;
  if (!create || !position || !presence || create.kind !== "CreateEntity") {
    throw new Error("The Circle creation fixture is malformed.");
  }
  return {
    ...program,
    operations: [{ ...create, entity: { ...create.entity, dimensions: { radius: 1 } } }, position, presence],
    schedule: {
      edges: [
        { from: create.id, reason: "explicit", to: position.id },
        { from: position.id, reason: "explicit", to: presence.id },
        { from: create.id, reason: "identity", to: position.id },
        { from: create.id, reason: "identity", to: presence.id },
      ],
      mode: "sequence",
      order: program.schedule.order,
    },
  };
}

describe("Manim render manager", () => {
  it("discovers Scenes and runs preview, commit, and exact Undo", async () => {
    const { manager, projectRoot } = await fixture();
    const workspace = await manager.workspace();
    expect(workspace.commandAvailable).toBe(true);
    expect(workspace.renderCapability).toEqual({
      available: true,
      kind: "local-command",
      unavailableReason: null,
    });
    expect(workspace.sources).toHaveLength(1);
    expect(workspace.sources[0]?.path).toBe("scene.py");
    expect(workspace.sources[0]?.scenes).toHaveLength(1);
    expect(workspace.sources[0]?.scenes[0]).toMatchObject({
      anchors: [5, 7],
      name: "GroupedEquation",
      nextSceneId: null,
      sceneId: "scene.py#GroupedEquation",
    });
    expect(workspace.sources[0]?.scenes[0]?.runtimeSceneState.objectGraph.entities).toHaveProperty(
      "source:scene.py#GroupedEquation:equation",
    );

    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);
    expect(rendered.status).toBe("ready");
    expect(rendered.programTransactionId).toBe("render-integration");
    expect(rendered.progress).toBe(1);
    expect(rendered.logTail).toContain("100%");
    expect(rendered.videoUrl).toContain(started.id);
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(sceneSource);

    const committed = await manager.commit(started.id, commitRequest(started));
    expect(committed.status).toBe("committed");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toContain('poietra:transaction "render-integration"');

    const undone = await manager.undo(started.id, "00000000-0000-4000-8000-000000000002");
    expect(undone.status).toBe("undone");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(sceneSource);
    await waitUntil(
      async () => (await manager.thumbnailStatus()).state === "current",
      "The thumbnail did not refresh after Commit followed by Undo.",
    );
    await expect(manager.thumbnailStatus()).resolves.toMatchObject({
      imageKind: "rendered",
      sourceHash: request().sourceHash,
      state: "current",
    });
  });

  it("returns final compacted transform evidence for the source it renders and commits", async () => {
    const priorTransformSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("x")
        self.add(equation)
        # poietra:cursor 0
        # poietra:position {"kind":"absolute","value":{"x":320,"y":180},"variable":"equation","version":1}
        equation.move_to((0, 0, 0))
        # poietra:scale {"kind":"exact","value":2,"variable":"equation","version":1}
        equation.scale(2)
        # poietra:transaction "prior-transform"
        # poietra:anchor 0
        self.wait(8)
`;
    const { manager, projectRoot } = await fixture();
    await writeFile(join(projectRoot, "scene.py"), priorTransformSource, "utf8");
    const imported = importManimScene(priorTransformSource, "scene.py", "GroupedEquation", {
      height: 8,
      width: 14.222,
    });
    const entityId = "source:scene.py#GroupedEquation:equation";
    const entity = imported?.runtimeSceneState.objectGraph.entities[entityId];
    if (!imported || entity?.geometry?.position.kind !== "known" || entity.geometry.scale.kind !== "known") {
      throw new Error("Prior transform source did not import with exact geometry");
    }
    const move = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 24, y: -12 },
      positions: { [entityId]: entity.geometry.position.value },
      scene: imported.runtimeSceneState,
      start: 0,
      targetEntityIds: [entityId],
      transactionId: "returned-position",
    });
    const scale = createDirectManipulationScaleProgram({
      capturedPlayhead: 0,
      interval: { end: 0, start: 0 },
      scales: { [entityId]: { from: entity.geometry.scale.value, to: 3 } },
      scene: imported.runtimeSceneState,
      targetEntityIds: [entityId],
      transactionId: "returned-scale",
    });
    if (move.kind !== "valid" || scale.kind !== "valid") {
      throw new Error(`Repeated transform fixture did not validate: ${JSON.stringify([move.issues, scale.issues])}`);
    }
    const renderRequest: ProgramRenderRequest = {
      ...request(),
      program: move.program,
      programs: [move.program, scale.program],
      sourceHash: createHash("sha256").update(priorTransformSource).digest("hex"),
    };
    await installVerifiedSnapshot(manager, renderRequest, "equation");

    const exported = await manager.exportSource(renderRequest);
    const started = await manager.start(renderRequest);
    const sourceLines = exported.source.split(/\r?\n/);
    const evidenceLines = started.patch.insertedCode.split(/\r?\n/);

    expect(sourceLines.slice(started.patch.anchorLine, started.patch.anchorLine + evidenceLines.length)).toEqual(
      evidenceLines,
    );
    expect(sourceLines[started.patch.anchorLine + evidenceLines.length]).toMatch(/^\s*# poietra:anchor 0$/);
    expect(started.patch.anchorLines).toEqual([started.patch.anchorLine]);
    expect(started.patch.insertedCode).toContain("equation.scale(3)");
    expect(started.patch.insertedCode).not.toContain("equation.scale(1.5)");
    expect(started.patch.insertedCode).not.toContain("prior-transform");
    expect(started.patch.insertedCode).toContain('poietra:transaction "returned-position"');
    expect(started.patch.insertedCode).toContain('poietra:transaction "returned-scale"');

    await expect(waitForTerminal(manager, started.id)).resolves.toMatchObject({ status: "ready" });
    await expect(manager.commit(started.id, commitRequest(started))).resolves.toMatchObject({ status: "committed" });
    await expect(readFile(join(projectRoot, "scene.py"), "utf8")).resolves.toBe(exported.source);
  });

  it("fails generic move-edit source export closed without Runtime Trace authority", async () => {
    const { manager, projectRoot } = await fixture();
    const staticSquareSource = `from manim import *

class StaticSquare(Scene):
    def construct(self):
        square = Square().set_fill(BLUE, opacity=0.6)
        square.set_stroke(WHITE, width=2)
        self.add(square)
        self.wait(1 / 60)
`;
    await writeFile(join(projectRoot, "scene.py"), staticSquareSource, "utf8");
    const entityId = "source:scene.py#StaticSquare:square";
    const program: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 0,
        evidence: ["source-time zero"],
        resolvedSeconds: 0,
        source: { kind: "absolute", seconds: 0 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          entityId,
          id: "generic-v3-export-position",
          interval: { end: 0, start: 0 },
          key: "position",
          kind: "SetProperty",
          provenance: { evidence: ["generic V3 initial root"], origin: "direct-manipulation" },
          value: { x: 410, y: 135 },
        },
      ],
      provenance: { evidence: ["generic V3 export"], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: ["generic-v3-export-position"] },
      transactionId: "generic-v3-export",
      version: 1,
    };

    await expect(
      manager.exportSource({
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program,
        projectId: "default",
        sceneName: "StaticSquare",
        sourceValidation: "runtime-trace",
        sourceBindings: [{ entityId, sourceVariable: "square" }],
        sourceHash: createHash("sha256").update(staticSquareSource).digest("hex"),
        sourcePath: "scene.py",
        viewport: { height: 360, width: 640 },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("converts a zero-animation Scene image to an MP4 before allowing Commit", async () => {
    const { manager, projectRoot } = await fixture({
      command: [process.execPath, fakeRenderer, "--static-render"],
      staticVideoCommand: [process.execPath, fakeRenderer, "--convert-static"],
    });

    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);

    expect(rendered).toMatchObject({ canCommit: true, progress: 1, status: "ready" });
    expect(rendered.logTail).toContain("Converted static preview");
    expect(await readFile(manager.videoPath(started.id), "utf8")).toBe("fake-static-mp4-preview");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(sceneSource);

    await expect(manager.commit(started.id, commitRequest(started))).resolves.toMatchObject({ status: "committed" });
  });

  it("does not invoke static conversion when Manim produced an MP4", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "poietra-static-converter-marker-"));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, "unexpected-static-converter");
    const { manager: guardedManager } = await fixture({
      staticVideoCommand: [process.execPath, fakeRenderer, "--convert-static", "--converter-marker", marker],
    });

    const started = await guardedManager.start(request());
    await expect(waitForTerminal(guardedManager, started.id)).resolves.toMatchObject({ status: "ready" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels a running static preview converter without a late ready transition", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "poietra-static-converter-marker-"));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, "static-converter-pid");
    const { manager: convertingManager } = await fixture({
      command: [process.execPath, fakeRenderer, "--static-render"],
      staticVideoCommand: [
        process.execPath,
        fakeRenderer,
        "--convert-static",
        "--slow-converter",
        "--converter-marker",
        marker,
      ],
    });
    const started = await convertingManager.start(request());
    await waitUntil(
      () =>
        access(marker).then(
          () => true,
          () => false,
        ),
      "The static preview converter did not start.",
    );
    const converterPid = Number(await readFile(marker, "utf8"));
    expect(Number.isSafeInteger(converterPid)).toBe(true);

    await expect(convertingManager.cancel(started.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await waitUntil(() => {
      try {
        process.kill(converterPid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        throw error;
      }
    }, "The cancelled static preview converter was not reaped.");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(convertingManager.view(started.id).status).toBe("cancelled");
  });

  it("fails closed when static conversion produces an empty MP4", async () => {
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--static-render"],
      staticVideoCommand: [process.execPath, fakeRenderer, "--convert-static", "--empty-converter-output"],
    });

    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);

    expect(rendered).toMatchObject({
      canCommit: false,
      error: "Static preview conversion completed without producing a valid MP4 preview.",
      status: "failed",
      videoUrl: null,
    });
  });

  it("rejects a Commit that is not correlated with the rendered candidate", async () => {
    const { manager, projectRoot } = await fixture();
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);

    await expect(
      manager.commit(started.id, {
        ...commitRequest(started),
        sourceHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(manager.view(started.id).status).toBe("ready");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(sceneSource);
  });

  it("coalesces concurrent workspace inspections", async () => {
    const { manager } = await fixture();

    const [first, second] = await Promise.all([manager.workspace(), manager.workspace()]);

    expect(first).toBe(second);
  });

  it("holds the shared render slot for the full thumbnail subprocess", async () => {
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--slow-thumbnail"],
      maxConcurrentRenders: 1,
    });

    await expect(manager.generateThumbnail()).resolves.toMatchObject({ state: "generating" });
    await expect(manager.start(request())).rejects.toMatchObject({ status: 429 });
    expect(manager.canUnregister()).toBe(false);
  });

  it("tracks automatic thumbnail refresh through shutdown and prevents a late subprocess", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "poietra-thumbnail-refresh-"));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, "started");
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--slow-thumbnail", "--thumbnail-start-marker", marker],
    });
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    await manager.commit(started.id, commitRequest(started));
    await waitUntil(
      async () =>
        access(marker).then(
          () => true,
          () => false,
        ),
      "Thumbnail refresh did not start.",
    );
    expect(manager.canUnregister()).toBe(false);

    const closingAt = Date.now();
    await manager.close();
    expect(Date.now() - closingAt).toBeLessThan(2_000);
  });

  it("checks the configured command adapter rather than only its executable", async () => {
    const { manager } = await fixture({ command: [process.execPath, fakeRenderer, "--fail-version"] });

    await expect(manager.workspace()).resolves.toMatchObject({
      commandAvailable: false,
      renderCapability: {
        available: false,
        kind: "local-command",
        unavailableReason: "local-command-unavailable",
      },
    });
  });

  it("refuses to overwrite source changed after preview", async () => {
    const { manager, projectRoot } = await fixture();
    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);
    expect(rendered.status).toBe("ready");
    await writeFile(join(projectRoot, "scene.py"), `${sceneSource}\n# external change\n`, "utf8");

    await expect(manager.commit(started.id, commitRequest(started))).rejects.toThrow(/source changed after preview/i);
  });

  it("refuses to render a draft created from a stale imported source snapshot", async () => {
    const { manager, projectRoot } = await fixture();
    await writeFile(join(projectRoot, "scene.py"), `${sceneSource}\n# changed before render\n`, "utf8");

    await expect(manager.start(request())).rejects.toThrow(/imported source changed before rendering/i);
  });

  it("reports duplicate Scene names and refuses export or preview before a commit can exist", async () => {
    const { manager, projectRoot } = await fixture();
    const duplicateSource = `${sceneSource}
class GroupedEquation(Scene):
    def construct(self):
        replacement = Text("Effective Python definition")
        self.add(replacement)
        # poietra:anchor 7.000
`;
    await writeFile(join(projectRoot, "scene.py"), duplicateSource, "utf8");
    const duplicateRequest = {
      ...request(),
      sourceHash: createHash("sha256").update(duplicateSource).digest("hex"),
    };
    const server = createServer((incoming, response) => {
      void handleManimRequest(createTrustedLocalManimRequestContext(manager, "test"), incoming, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/manim/workspace`);
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(409);
      expect(body.error).toMatch(/Scene "GroupedEquation".*scene\.py.*duplicate/i);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }

    await expect(manager.exportSource(duplicateRequest)).rejects.toThrow(
      /Scene "GroupedEquation".*scene\.py.*duplicate/i,
    );
    await expect(manager.start(duplicateRequest)).rejects.toThrow(/Scene "GroupedEquation".*scene\.py.*duplicate/i);
    expect(manager.canUnregister()).toBe(true);
  });

  it("exports Programs at distinct source anchors in source order", async () => {
    const { manager } = await fixture();
    const later = motionProgram(7, "batch-later");
    const earlier = motionProgram(5, "batch-earlier");

    const exported = await manager.exportSource(batchRequest([later, earlier]));

    expect(exported.source.indexOf('poietra:transaction "batch-earlier"')).toBeLessThan(
      exported.source.indexOf('poietra:transaction "batch-later"'),
    );
    expect(exported.source).toContain("# poietra:cursor 5");
    expect(exported.source).toContain("# poietra:cursor 8");
    expect(exported.source).toContain("# poietra:anchor 6");
    expect(exported.source).toContain("# poietra:anchor 9");
  });

  it("exports and commits shifted temporal metadata while Undo restores the exact source", async () => {
    const { manager, projectRoot } = await fixture();
    await writeFile(join(projectRoot, "scene.py"), temporalMetadataSource, "utf8");
    const program = motionProgram(5, "temporal-metadata");
    const renderRequest: ProgramRenderRequest = {
      ...request(),
      program,
      sourceHash: createHash("sha256").update(temporalMetadataSource).digest("hex"),
    };
    await installVerifiedSnapshot(manager, renderRequest, "equation");

    const exported = await manager.exportSource(renderRequest);
    const imported = importManimScene(exported.source, "scene.py", "GroupedEquation");
    expect(exported.source).toContain("# poietra:cursor 8");
    expect(exported.source).toContain("# poietra:anchor 9");
    expect(exported.source).toContain('# poietra:scene-boundary {"at":9,"destination":"scene.py#Next"}');
    expect(imported?.runtimeSceneState.eventTrack.events).toContainEqual(
      expect.objectContaining({
        at: 9,
        kind: "scene-boundary",
      }),
    );
    expect(
      imported?.runtimeSceneState.propertyChannels["source:scene.py#GroupedEquation:equation/position"]?.samples.find(
        (sample) => sample.kind === "animated",
      )?.interval,
    ).toEqual({ end: 6, start: 5 });

    const started = await manager.start(renderRequest);
    expect((await waitForTerminal(manager, started.id)).status).toBe("ready");
    expect((await manager.commit(started.id, commitRequest(started))).status).toBe("committed");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(exported.source);
    expect((await manager.undo(started.id, "00000000-0000-4000-8000-000000000002")).status).toBe("undone");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(temporalMetadataSource);
  });

  it("carries a generated entity binding into a later source-anchor Program", async () => {
    const { manager } = await fixture();
    const creation = createCircleProgram();
    const entityId = "tx:batch-create/entity:circle";
    const movement = motionProgram(7, "batch-move-created", entityId);

    const exported = await manager.exportSource(batchRequest([creation, movement]));
    const marker = exported.source.match(
      new RegExp(`# poietra:entity \\{\\"id\\":\\"${entityId}\\",\\"variable\\":\\"([^\\"]+)\\"\\}`),
    );

    expect(marker?.[1]).toBeTruthy();
    expect(exported.source).toContain(`${marker?.[1]}.animate.shift(`);
    expect(exported.source).toContain("# poietra:cursor 7.4");
  });

  it("routes a complete Studio-created Circle scale and delete batch through the Rust creation planner", async () => {
    const { manager } = await fixture();
    const creation = rustAuthorizableCircleCreationProgram("server-created-circle");
    const entityId = "tx:server-created-circle/entity:circle";
    const scale = scaleCreatedEntityProgram(entityId);
    const removal = removeCreatedEntityProgram(entityId);
    const renderRequest = batchRequest([creation, scale, removal]);
    await installVerifiedSnapshot(manager, renderRequest);

    const exported = await manager.exportSource(renderRequest);

    expect(exported.source).toContain("Circle(");
    expect(exported.source).toContain(".scale(1.5)");
    expect(exported.source).toContain("FadeOut(");
  });

  it("exports Studio-created MathTex delete through the server Rust creation planner", async () => {
    const { manager } = await fixture();
    const circleCreation = rustAuthorizableCircleCreationProgram("server-created-mathtex", "equation");
    const entityId = "tx:server-created-mathtex/entity:equation";
    const creation: CanonicalEditProgram = {
      ...circleCreation,
      operations: circleCreation.operations.map((operation) =>
        operation.kind === "CreateEntity"
          ? {
              ...operation,
              entity: {
                ...operation.entity,
                content: { displayLines: ["E = mc^2"], label: "E = mc^2", texParts: ["E = mc^2"] },
                type: "MathTex",
              },
            }
          : operation,
      ),
    };
    const renderRequest = batchRequest([creation, removeCreatedEntityProgram(entityId)]);
    await installVerifiedSnapshot(manager, renderRequest);

    const exported = await manager.exportSource(renderRequest);

    expect(exported.source).toContain('MathTex("E = mc^2")');
    expect(exported.source).toContain("FadeOut(");
  });

  it("allocates distinct Python variables when transaction IDs normalize to the same token", async () => {
    const { manager } = await fixture();
    const programs = [
      createCircleProgram("batch-collision", "first"),
      createCircleProgram("batch_collision", "second"),
    ];

    const exported = await manager.exportSource(batchRequest(programs));
    const variables = [
      ...exported.source.matchAll(
        /# poietra:entity \{"id":"tx:batch[_-]collision\/entity:[^"]+","variable":"([^"]+)"\}/g,
      ),
    ].map((match) => match[1]);

    expect(variables).toHaveLength(2);
    expect(new Set(variables).size).toBe(2);
    expect(variables).toEqual(["poietra_batch_collision_1", "poietra_batch_collision_1_2"]);
  });

  it("exports same-anchor Programs whose rebased intervals exceed the original Scene duration", async () => {
    const { manager } = await fixture();
    const first = motionProgram(7, "batch-near-end-first");
    const second = motionProgram(7, "batch-near-end-second");

    const exported = await manager.exportSource(batchRequest([first, second]));

    expect(exported.source.match(/self\.play\(/g)).toHaveLength(2);
    expect(exported.source.indexOf('poietra:transaction "batch-near-end-first"')).toBeLessThan(
      exported.source.indexOf('poietra:transaction "batch-near-end-second"'),
    );
    expect(exported.source).toContain("# poietra:anchor 9");
  });

  it("exports a shorter Scene by reducing a Studio duration wait without truncating source", async () => {
    const { manager } = await fixture();
    const imported = importManimScene(sceneSource, "scene.py", "GroupedEquation");
    expect(imported).not.toBeNull();
    if (!imported) return;
    const extension = createSceneDurationProgram({
      capturedPlayhead: 7,
      scene: imported.runtimeSceneState,
      sourceAnchor: 7,
      targetDuration: 11,
      transactionId: "integration-duration-extension",
    });
    const extensionOperation = extension.program.operations[0]!;
    const trim = createSceneDurationProgram({
      capturedPlayhead: 11,
      scene: { ...imported.runtimeSceneState, duration: 11 },
      sourceAnchor: 7,
      targetDuration: 10,
      transactionId: "integration-duration-trim",
      trimAvailability: {
        anchor: 7,
        blocker: null,
        minimumDuration: 8,
        removableDuration: 3,
        waitOperationIds: [extensionOperation.id],
      },
    });

    const exported = await manager.exportSource(batchRequest([extension.program, trim.program]));
    const reimported = importManimScene(exported.source, "scene.py", "GroupedEquation");

    expect(exported.source).toContain("self.wait(2)");
    expect(exported.source).not.toContain("self.wait(3)");
    expect(reimported?.runtimeSceneState.duration).toBe(10);
    expect(
      reimported?.runtimeSceneState.eventTrack.events.every((event) => (event.at ?? event.interval?.end ?? 0) <= 10),
    ).toBe(true);
  });

  it("identifies a render session by the deterministic Program batch", async () => {
    const { manager } = await fixture();
    const programs = [motionProgram(5, "batch-session-first"), motionProgram(7, "batch-session-second")];

    const started = await manager.start(batchRequest(programs));

    expect(started.programBatchId).toBe(renderProgramBatchId(programs));
    expect(started.programTransactionId).toBe(started.programBatchId);
    expect(started.patch.anchorLines).toHaveLength(2);
  });

  it("revalidates target identity and imported source bindings at the server boundary", async () => {
    const { manager } = await fixture();
    const invalid = request();
    const operation = invalid.program.operations[0];
    if (operation?.kind !== "CreateMotion") throw new Error("Expected CreateMotion fixture.");

    await expect(
      manager.start({
        ...invalid,
        program: {
          ...invalid.program,
          operations: [{ ...operation, targetEntityIds: ["invented-identity"] }],
        },
        sourceBindings: [{ entityId: "invented-identity", sourceVariable: "equation" }],
      }),
    ).rejects.toThrow(/does not exist|target/i);
  });

  it("does not invent a next-Scene edge between unrelated Python files", async () => {
    const { manager, projectRoot } = await fixture();
    await writeFile(
      join(projectRoot, "another.py"),
      `from manim import *

class Independent(Scene):
    def construct(self):
        title = Text("Independent")
        self.add(title)
`,
      "utf8",
    );

    const workspace = await manager.workspace();
    expect(workspace.sources).toHaveLength(2);
    expect(
      workspace.sources
        .flatMap((source) => source.scenes)
        .map((scene) => ({
          id: scene.sceneId,
          next: scene.nextSceneId,
        })),
    ).toEqual([
      { id: "another.py#Independent", next: null },
      { id: "scene.py#GroupedEquation", next: null },
    ]);
  });

  it("cancels an active render and permits discard", async () => {
    const { manager } = await fixture({ command: [process.execPath, fakeRenderer, "--slow-render"] });
    const started = await manager.start(request());
    const cancelled = await manager.cancel(started.id);
    expect(cancelled.status).toBe("cancelled");
    const discarded = await manager.discard(started.id);
    expect(discarded.status).toBe("discarded");
  });

  it("bounds concurrent renderer processes", async () => {
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--slow-render"],
      maxConcurrentRenders: 1,
    });
    const started = await manager.start(request());

    await expect(manager.start(request())).rejects.toThrow(/at most 1 concurrent/i);

    await manager.cancel(started.id);
    await manager.discard(started.id);
  });

  it("bounds retained source snapshots until a preview is discarded", async () => {
    const { manager } = await fixture({ maxRetainedSessions: 1 });
    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);
    expect(rendered.status).toBe("ready");

    await expect(manager.start(request())).rejects.toThrow(/retains at most 1 render session/i);

    await manager.discard(started.id);
    await expect(manager.start(request())).resolves.toMatchObject({ status: "rendering" });
  });

  it("keeps a committed source while releasing its Undo snapshot for the next preview", async () => {
    const { manager, projectRoot } = await fixture({ maxRetainedSessions: 1 });
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    const committed = await manager.commit(started.id, commitRequest(started));
    const committedSource = await readFile(join(projectRoot, "scene.py"), "utf8");

    expect(committed).toMatchObject({ canDiscard: true, canUndo: true, status: "committed" });

    const discarded = await manager.discard(started.id);

    expect(discarded).toMatchObject({ canDiscard: false, canUndo: false, status: "discarded" });
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(committedSource);
    expect(() => manager.view(started.id)).toThrow(/not found/i);

    const nextProgram = motionProgram(5, "render-after-commit");
    const nextRequest = {
      ...request(),
      program: nextProgram,
      programs: [nextProgram],
      sourceHash: committed.patch.patchedSourceHash,
    };
    await installVerifiedSnapshot(manager, nextRequest, "equation");
    await expect(manager.start(nextRequest)).resolves.toMatchObject({ status: "rendering" });
  });

  it("atomically reserves retained-session capacity across concurrent starts", async () => {
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--slow-render"],
      maxConcurrentRenders: 2,
      maxRetainedSessions: 1,
    });

    const starts = await Promise.allSettled([manager.start(request()), manager.start(request())]);

    expect(starts.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = starts.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(Error);
    expect(rejected.reason.message).toMatch(/retains at most 1 render session/i);
    const fulfilled = starts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<ManimRenderManager["start"]>>
    >;
    await manager.cancel(fulfilled.value.id);
    await manager.discard(fulfilled.value.id);
  });

  it("abandons a render start when the HTTP client disconnects", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "poietra-version-marker-"));
    temporaryRoots.push(markerRoot);
    const versionMarker = join(markerRoot, "started");
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--version-marker", versionMarker, "--slow-version", "--slow-render"],
      maxRetainedSessions: 1,
    });
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const server = createServer((incoming, response) => {
      void handleManimRequest(createTrustedLocalManimRequestContext(manager, "test"), incoming, response, logger);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const body = JSON.stringify(request());
      const client = createHttpRequest({
        headers: {
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
        },
        host: "127.0.0.1",
        method: "POST",
        path: "/api/manim/renders",
        port: address.port,
      });
      client.on("error", () => undefined);
      client.on("response", (response) => response.resume());
      client.end(body);
      await waitUntil(async () => {
        try {
          await readFile(versionMarker);
          return true;
        } catch {
          return false;
        }
      }, "The command availability check did not start.");
      client.destroy();
      await waitUntil(
        () => records.some((record) => record.event === "request.aborted"),
        "The disconnected render request was not aborted.",
      );

      const replacement = await manager.start(request());
      await manager.cancel(replacement.id);
      await manager.discard(replacement.id);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("abandons a started render when the client closes before the 202 response finishes", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "poietra-delivery-marker-"));
    temporaryRoots.push(markerRoot);
    const completionMarker = join(markerRoot, "render-completed");
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--completion-marker", completionMarker, "--slow-render"],
      maxRetainedSessions: 1,
    });
    await manager.workspace();
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    let client: ReturnType<typeof createHttpRequest> | null = null;
    let responseEndCalled = false;
    const server = createServer((incoming, response) => {
      response.end = ((..._arguments: unknown[]) => {
        // Hold the real response before its finish event, then close the real client socket.
        // This deterministically exercises the ownership window after sendJson calls end.
        responseEndCalled = true;
        client?.destroy();
        return response;
      }) as typeof response.end;
      void handleManimRequest(createTrustedLocalManimRequestContext(manager, "test"), incoming, response, logger);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const body = JSON.stringify(request());
      client = createHttpRequest({
        headers: {
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
        },
        host: "127.0.0.1",
        method: "POST",
        path: "/api/manim/renders",
        port: address.port,
      });
      client.on("error", () => undefined);
      client.on("response", (response) => response.resume());
      client.end(body);
      await waitUntil(
        () => records.some((record) => record.event === "request.aborted"),
        "The unfinished render response was not aborted.",
      );
      expect(responseEndCalled).toBe(true);

      await expect(readFile(completionMarker)).rejects.toThrow();
      const replacement = await manager.start(request());
      await manager.cancel(replacement.id);
      await manager.discard(replacement.id);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("stops and removes a newly started process when response delivery fails", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "poietra-completion-marker-"));
    temporaryRoots.push(markerRoot);
    const completionMarker = join(markerRoot, "completed");
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--completion-marker", completionMarker, "--slow-render"],
      maxRetainedSessions: 1,
    });
    const started = await manager.start(request());

    await manager.abandonStart(started.id);

    expect(() => manager.view(started.id)).toThrow(/session not found/i);
    await expect(readFile(completionMarker)).rejects.toThrow();
    const replacement = await manager.start(request());
    await manager.cancel(replacement.id);
    await manager.discard(replacement.id);
  });

  it("atomically abandons active and ready stale renders with request correlation", async () => {
    const { manager: activeManager } = await fixture({
      command: [process.execPath, fakeRenderer, "--slow-render"],
    });
    const active = await activeManager.start(request());

    await expect(activeManager.abandon(active.id, "wrong-render-request")).rejects.toThrow(/no longer matches/i);
    await expect(activeManager.abandon(active.id, active.renderRequestId)).resolves.toEqual({ abandoned: true });
    expect(() => activeManager.view(active.id)).toThrow(/session not found/i);

    const { manager } = await fixture();
    const ready = await manager.start(request());
    await waitForTerminal(manager, ready.id);
    await expect(manager.abandon(ready.id, ready.renderRequestId)).resolves.toEqual({ abandoned: true });
    expect(() => manager.view(ready.id)).toThrow(/session not found/i);
    await expect(manager.abandon(ready.id, ready.renderRequestId)).resolves.toEqual({ abandoned: true });
  });

  it("never abandons a source-changing render session", async () => {
    const { manager, projectRoot } = await fixture();
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    await manager.commit(started.id, commitRequest(started));

    await expect(manager.abandon(started.id, started.renderRequestId)).rejects.toThrow(/source-changing/i);
    expect(manager.view(started.id).status).toBe("committed");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toContain('poietra:transaction "render-integration"');
  });

  it("fails a renderer that exceeds its execution deadline", async () => {
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--slow-render"],
      renderTimeoutMs: 10,
    });
    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);

    expect(rendered.status).toBe("failed");
    expect(rendered.error).toMatch(/10ms timeout/i);
  });

  it("serializes destructive actions for one render session", async () => {
    const { manager } = await fixture();
    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);
    expect(rendered.status).toBe("ready");

    const commit = manager.commit(started.id, commitRequest(started));
    await manager.cleanupExpiredSessions(Date.now() + 60 * 60 * 1_000);
    expect(manager.view(started.id).status).toBe("ready");
    await expect(manager.discard(started.id)).rejects.toThrow(/another action is already running/i);
    expect((await commit).status).toBe("committed");
  });

  it("registers a cancellation tombstone before a delayed Commit can start", async () => {
    const { manager, projectRoot } = await fixture();
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    const actionId = "00000000-0000-4000-8000-000000000011";

    const cancelled = await manager.cancelSourceAction(started.id, { actionId, kind: "commit" });

    expect(cancelled.action).toEqual({ id: actionId, kind: "commit", outcome: null, state: "cancelled" });
    expect(cancelled.session).toMatchObject({ canCommit: true, status: "ready" });
    await expect(manager.commit(started.id, commitRequest(started, actionId))).rejects.toThrow(/cancelled/i);
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(sceneSource);
  });

  it("cancels Commit at the final CAS boundary without changing the source", async () => {
    const entered = deferred();
    const release = deferred();
    const { manager, projectRoot } = await fixture({
      sourceStoreHooks: {
        beforeWriteCommit: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    const actionId = "00000000-0000-4000-8000-000000000012";
    const commit = manager.commit(started.id, commitRequest(started, actionId));
    const commitRejected = expect(commit).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;

    await expect(
      manager.commit(started.id, commitRequest(started, "00000000-0000-4000-8000-000000000018")),
    ).rejects.toThrow(/another action is already running/i);

    const cancellation = manager.cancelSourceAction(started.id, { actionId, kind: "commit" });
    release.resolve();

    await commitRejected;
    await expect(cancellation).resolves.toMatchObject({
      action: { id: actionId, kind: "commit", outcome: null, state: "cancelled" },
      session: { status: "ready" },
    });
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(sceneSource);
  });

  it("reports Commit as succeeded when its atomic rename wins cancellation", async () => {
    const { manager, projectRoot } = await fixture();
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    const actionId = "00000000-0000-4000-8000-000000000013";
    const commit = manager.commit(started.id, commitRequest(started, actionId));
    await waitUntil(
      async () => (await readFile(join(projectRoot, "scene.py"), "utf8")) !== sceneSource,
      "Commit did not reach its atomic source update.",
    );

    const cancellation = await manager.cancelSourceAction(started.id, { actionId, kind: "commit" });

    await expect(commit).resolves.toMatchObject({ status: "committed" });
    expect(cancellation).toMatchObject({
      action: { id: actionId, kind: "commit", outcome: "committed", state: "succeeded" },
      session: { status: "committed" },
    });
  });

  it("makes a successful source action idempotent for the same action ID", async () => {
    const { manager, projectRoot } = await fixture();
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    const expected = commitRequest(started, "00000000-0000-4000-8000-000000000014");

    await manager.commit(started.id, expected);
    await expect(manager.commit(started.id, expected)).resolves.toMatchObject({ status: "committed" });

    const source = await readFile(join(projectRoot, "scene.py"), "utf8");
    expect(source.match(/poietra:transaction "render-integration"/g)).toHaveLength(1);
  });

  it("does not let a delayed cancellation rewind the latest source-action view", async () => {
    const { manager } = await fixture();
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    const commitActionId = "00000000-0000-4000-8000-000000000022";
    const undoActionId = "00000000-0000-4000-8000-000000000023";
    await manager.commit(started.id, commitRequest(started, commitActionId));
    await manager.undo(started.id, undoActionId);

    const delayedCancellation = await manager.cancelSourceAction(started.id, {
      actionId: commitActionId,
      kind: "commit",
    });

    expect(delayedCancellation.action).toEqual({
      id: commitActionId,
      kind: "commit",
      outcome: "committed",
      state: "succeeded",
    });
    expect(delayedCancellation.session).toMatchObject({
      sourceAction: { id: undoActionId, kind: "undo", outcome: "undone", state: "succeeded" },
      status: "undone",
    });
  });

  it("rejects replaying a completed action after the render session advances", async () => {
    const { manager } = await fixture();
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    const commitActionId = "00000000-0000-4000-8000-000000000024";
    const expectedCommit = commitRequest(started, commitActionId);
    await manager.commit(started.id, expectedCommit);
    await manager.undo(started.id, "00000000-0000-4000-8000-000000000025");

    await expect(manager.commit(started.id, expectedCommit)).rejects.toThrow(/session has since advanced/i);
    expect(manager.view(started.id)).toMatchObject({
      sourceAction: { kind: "undo", outcome: "undone", state: "succeeded" },
      status: "undone",
    });
  });

  it("cancels Undo at the CAS boundary and permits a new correlated Undo", async () => {
    let blockUndo = false;
    const entered = deferred();
    const release = deferred();
    const { manager, projectRoot } = await fixture({
      sourceStoreHooks: {
        beforeWriteCommit: async () => {
          if (!blockUndo) return;
          entered.resolve();
          await release.promise;
        },
      },
    });
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    await manager.commit(started.id, commitRequest(started));
    const committedSource = await readFile(join(projectRoot, "scene.py"), "utf8");
    blockUndo = true;
    const actionId = "00000000-0000-4000-8000-000000000015";
    const undo = manager.undo(started.id, actionId);
    const undoRejected = expect(undo).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;

    const cancellation = manager.cancelSourceAction(started.id, { actionId, kind: "undo" });
    release.resolve();

    await undoRejected;
    await expect(cancellation).resolves.toMatchObject({
      action: { id: actionId, kind: "undo", outcome: null, state: "cancelled" },
      session: { canUndo: true, status: "committed" },
    });
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(committedSource);
    blockUndo = false;
    await expect(manager.undo(started.id, "00000000-0000-4000-8000-000000000016")).resolves.toMatchObject({
      status: "undone",
    });
  });

  it("reports Undo as succeeded when its atomic rename wins cancellation", async () => {
    const { manager, projectRoot } = await fixture();
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    await manager.commit(started.id, commitRequest(started));
    const actionId = "00000000-0000-4000-8000-000000000019";
    const undo = manager.undo(started.id, actionId);
    await waitUntil(
      async () => (await readFile(join(projectRoot, "scene.py"), "utf8")) === sceneSource,
      "Undo did not reach its atomic source update.",
    );

    const cancellation = await manager.cancelSourceAction(started.id, { actionId, kind: "undo" });

    await expect(undo).resolves.toMatchObject({ status: "undone" });
    expect(cancellation).toMatchObject({
      action: { id: actionId, kind: "undo", outcome: "undone", state: "succeeded" },
      session: { status: "undone" },
    });
  });

  it("aborts and waits for a running source action before close completes", async () => {
    const entered = deferred();
    const release = deferred();
    const { manager, projectRoot } = await fixture({
      sourceStoreHooks: {
        beforeWriteCommit: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    const started = await manager.start(request());
    await waitForTerminal(manager, started.id);
    const commit = manager.commit(started.id, commitRequest(started, "00000000-0000-4000-8000-000000000017"));
    const commitRejected = expect(commit).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;

    const close = manager.close();
    release.resolve();

    await commitRejected;
    await close;
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(sceneSource);
  });

  it("prevents concurrent sessions from overwriting the same source snapshot", async () => {
    const { manager } = await fixture();
    const sessions = await Promise.all([manager.start(request()), manager.start(request())]);
    await Promise.all(sessions.map((session) => waitForTerminal(manager, session.id)));

    const commits = await Promise.allSettled(
      sessions.map((session) => manager.commit(session.id, commitRequest(session))),
    );

    expect(commits.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = commits.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(/source changed after preview/i);
  });

  it("expires terminal sessions so source snapshots and temporary media do not accumulate", async () => {
    const { manager } = await fixture();
    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);
    expect(rendered.status).toBe("ready");

    await manager.cleanupExpiredSessions(Date.parse(rendered.updatedAt) + 30 * 60 * 1_000);

    expect(() => manager.view(started.id)).toThrow(/session not found/i);
  });

  it("rejects source paths outside the configured root", async () => {
    const { manager, projectRoot } = await fixture();
    const outsideName = `${basename(projectRoot)}-outside.py`;
    const outsidePath = join(dirname(projectRoot), outsideName);
    await writeFile(outsidePath, sceneSource, "utf8");
    try {
      await expect(manager.start(request(`../${outsideName}`))).rejects.toThrow(
        /inside the configured Manim project root/i,
      );
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

  it("rejects absolute source paths even when they point inside the project", async () => {
    const { manager, projectRoot } = await fixture();

    await expect(manager.start(request(join(projectRoot, "scene.py")))).rejects.toThrow(/relative Python file path/i);
  });

  it("rejects new renders after shutdown", async () => {
    const { manager } = await fixture();
    await manager.close();

    await expect(manager.start(request())).rejects.toThrow(/shutting down/i);
  });

  it("stops an in-flight command probe before shutdown completes", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "poietra-probe-shutdown-"));
    temporaryRoots.push(markerRoot);
    const versionMarker = join(markerRoot, "probe-pid");
    const { manager } = await fixture({
      command: [process.execPath, fakeRenderer, "--version-marker", versionMarker, "--hang-version"],
    });

    const workspace = manager.workspace();
    await waitUntil(async () => {
      try {
        return Boolean((await readFile(versionMarker, "utf8")).trim());
      } catch {
        return false;
      }
    }, "The command availability probe did not start.");
    const probePid = Number(await readFile(versionMarker, "utf8"));

    await expect(manager.close()).resolves.toBeUndefined();
    await expect(workspace).resolves.toMatchObject({ commandAvailable: false });
    expect(() => process.kill(probePid, 0)).toThrow();
  });
});
