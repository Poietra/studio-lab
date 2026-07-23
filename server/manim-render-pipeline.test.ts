import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, request as createHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConfig, ViteDevServer } from "vite";

import { renderProgramBatchId, type ProgramRenderRequest } from "../src/render-pipeline/contracts";
import { importManimScene } from "../src/render-pipeline/source-import";
import { createSceneDurationProgram } from "../src/studio/authoring-commands";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { handleManimRequest } from "./manim-render-http";
import { PersistentManimProjectCatalog } from "./manim-project-catalog";
import {
  ManimProjectRegistry,
  ManimRenderManager,
  manimRenderPipeline,
  parseManimCommand,
  parseManimProjects,
} from "./manim-render-pipeline";

const fakeRenderer = fileURLToPath(new URL("./test-fixtures/fake-manim.mjs", import.meta.url));
const temporaryRoots: string[] = [];
const managers: ManimRenderManager[] = [];
const registries: ManimProjectRegistry[] = [];

const sceneSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(5)
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:anchor 7.000
        self.wait(1)
`;

const temporalMetadataSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(5)
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:cursor 7.000
        self.wait(1)
        # poietra:anchor 8.000
        # poietra:scene-boundary {"at":8,"destination":"scene.py#Next"}
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
    projectId: "default",
    sceneName: "GroupedEquation",
    sourceBindings: [{ entityId: "source:scene.py#GroupedEquation:equation", sourceVariable: "equation" }],
    sourceHash: createHash("sha256").update(sceneSource).digest("hex"),
    sourcePath,
    viewport: { height: 360, width: 640 },
  };
}

function motionProgram(
  anchor: number,
  transactionId: string,
  targetEntityId = "source:scene.py#GroupedEquation:equation",
): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 40, y: 0 },
    dependsOn: [],
    easing: "smooth",
    id: `tx:${transactionId}/operation:motion`,
    interval: { end: anchor + 1, start: anchor },
    kind: "CreateMotion",
    provenance: { evidence: [], origin: "direct-manipulation" },
    targetEntityIds: [targetEntityId],
  };
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead", referenceSeconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

function batchRequest(programs: readonly CanonicalEditProgram[]): ProgramRenderRequest {
  const base = request();
  return { ...base, program: programs[0]!, programs };
}

function createCircleProgram(transactionId = "batch-create", entityName = "circle"): CanonicalEditProgram {
  const entityId = `tx:${transactionId}/entity:${entityName}`;
  const createId = `tx:${transactionId}/operation:create`;
  const positionId = `tx:${transactionId}/operation:position`;
  const presenceId = `tx:${transactionId}/operation:presence`;
  const operations: CanonicalEditOperation[] = [
    {
      dependsOn: [],
      entity: { id: entityId, lifetime: { end: null, start: 5 }, type: "Circle" },
      id: createId,
      interval: { end: 5, start: 5 },
      kind: "CreateEntity",
      provenance: { evidence: [], origin: "studio-default" },
    },
    {
      dependsOn: [createId],
      entityId,
      id: positionId,
      interval: { end: 5, start: 5 },
      key: "position",
      kind: "SetProperty",
      provenance: { evidence: [], origin: "studio-default" },
      value: { x: 240, y: 180 },
    },
    {
      dependsOn: [positionId],
      effect: "fade-in",
      entityId,
      id: presenceId,
      interval: { end: 5.4, start: 5 },
      kind: "ChangePresence",
      persistent: true,
      provenance: { evidence: [], origin: "studio-default" },
    },
  ];
  return {
    anchor: {
      capturedPlayhead: 5,
      evidence: [],
      resolvedSeconds: 5,
      source: { kind: "playhead", referenceSeconds: 5 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations,
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: operations.map((operation) => operation.id) },
    transactionId,
    version: 1,
  };
}

async function fixture(
  options: Readonly<{
    command?: readonly string[];
    maxConcurrentRenders?: number;
    maxRetainedSessions?: number;
    renderTimeoutMs?: number;
  }> = {},
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "poietra-render-test-"));
  temporaryRoots.push(projectRoot);
  await writeFile(join(projectRoot, "scene.py"), sceneSource, "utf8");
  const manager = new ManimRenderManager({
    command: [process.execPath, fakeRenderer],
    frame: { height: 8, width: 14.222 },
    ...options,
    projectRoot,
  });
  managers.push(manager);
  return { manager, projectRoot };
}

async function waitForTerminal(manager: Pick<ManimRenderManager, "view">, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = manager.view(id);
    if (["cancelled", "failed", "ready"].includes(session.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Render session did not finish.");
}

async function registryFixture(command: readonly string[] = [process.execPath, fakeRenderer], mutable = false) {
  const firstRoot = await mkdtemp(join(tmpdir(), "poietra-project-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "poietra-project-b-"));
  temporaryRoots.push(firstRoot, secondRoot);
  await Promise.all([
    writeFile(join(firstRoot, "scene.py"), sceneSource, "utf8"),
    writeFile(join(secondRoot, "scene.py"), sceneSource, "utf8"),
  ]);
  const seedProjects = [
    { id: "project-a", name: "Project A", root: firstRoot },
    { id: "project-b", name: "Project B", root: secondRoot },
  ];
  const dataRoot = mutable ? await mkdtemp(join(tmpdir(), "poietra-project-catalog-")) : null;
  if (dataRoot) temporaryRoots.push(dataRoot);
  const catalog = dataRoot ? new PersistentManimProjectCatalog({ dataRoot, seedProjects }) : null;
  const registry = new ManimProjectRegistry({
    ...(catalog ? { catalog } : {}),
    command,
    frame: { height: 8, width: 14.222 },
    projects: seedProjects,
  });
  registries.push(registry);
  return { dataRoot, firstRoot, registry, secondRoot };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
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

    const committed = await manager.commit(started.id);
    expect(committed.status).toBe("committed");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toContain('poietra:transaction "render-integration"');

    const undone = await manager.undo(started.id);
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
    await manager.commit(started.id);
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

    await expect(manager.workspace()).resolves.toMatchObject({ commandAvailable: false });
  });

  it("refuses to overwrite source changed after preview", async () => {
    const { manager, projectRoot } = await fixture();
    const started = await manager.start(request());
    const rendered = await waitForTerminal(manager, started.id);
    expect(rendered.status).toBe("ready");
    await writeFile(join(projectRoot, "scene.py"), `${sceneSource}\n# external change\n`, "utf8");

    await expect(manager.commit(started.id)).rejects.toThrow(/source changed after preview/i);
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
      void handleManimRequest(manager, incoming, response);
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
    expect((await manager.commit(started.id)).status).toBe("committed");
    expect(await readFile(join(projectRoot, "scene.py"), "utf8")).toBe(exported.source);
    expect((await manager.undo(started.id)).status).toBe("undone");
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
    const extensionRecord = {
      program: extension.program,
      validation: { issues: extension.issues, status: extension.kind },
    } as const;
    const trim = createSceneDurationProgram({
      appliedPrograms: [extensionRecord],
      capturedPlayhead: 11,
      scene: { ...imported.runtimeSceneState, duration: 11 },
      sourceAnchor: 7,
      targetDuration: 10,
      transactionId: "integration-duration-trim",
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
    const { manager } = await fixture();
    const started = await manager.start(request());
    const cancelled = await manager.cancel(started.id);
    expect(cancelled.status).toBe("cancelled");
    const discarded = await manager.discard(started.id);
    expect(discarded.status).toBe("discarded");
  });

  it("bounds concurrent renderer processes", async () => {
    const { manager } = await fixture({ maxConcurrentRenders: 1 });
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

  it("atomically reserves retained-session capacity across concurrent starts", async () => {
    const { manager } = await fixture({ maxConcurrentRenders: 2, maxRetainedSessions: 1 });

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
      command: [process.execPath, fakeRenderer, "--version-marker", versionMarker, "--slow-version"],
      maxRetainedSessions: 1,
    });
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const server = createServer((incoming, response) => {
      void handleManimRequest(manager, incoming, response, logger);
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
      command: [process.execPath, fakeRenderer, "--completion-marker", completionMarker],
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
      void handleManimRequest(manager, incoming, response, logger);
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

      await new Promise((resolve) => setTimeout(resolve, 120));
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
      command: [process.execPath, fakeRenderer, "--completion-marker", completionMarker],
      maxRetainedSessions: 1,
    });
    const started = await manager.start(request());

    await manager.abandonStart(started.id);

    expect(() => manager.view(started.id)).toThrow(/session not found/i);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(readFile(completionMarker)).rejects.toThrow();
    const replacement = await manager.start(request());
    await manager.cancel(replacement.id);
    await manager.discard(replacement.id);
  });

  it("fails a renderer that exceeds its execution deadline", async () => {
    const { manager } = await fixture({ renderTimeoutMs: 10 });
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

    const commit = manager.commit(started.id);
    await manager.cleanupExpiredSessions(Date.now() + 60 * 60 * 1_000);
    expect(manager.view(started.id).status).toBe("ready");
    await expect(manager.discard(started.id)).rejects.toThrow(/another action is already running/i);
    expect((await commit).status).toBe("committed");
  });

  it("prevents concurrent sessions from overwriting the same source snapshot", async () => {
    const { manager } = await fixture();
    const sessions = await Promise.all([manager.start(request()), manager.start(request())]);
    await Promise.all(sessions.map((session) => waitForTerminal(manager, session.id)));

    const commits = await Promise.allSettled(sessions.map((session) => manager.commit(session.id)));

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

describe("Manim project registry", () => {
  it("lists configured projects without exposing their filesystem roots", async () => {
    const { firstRoot, registry, secondRoot } = await registryFixture();

    const projects = registry.projects();
    expect(projects).toEqual({
      defaultProjectId: "project-a",
      projects: [
        { id: "project-a", kind: "existing", name: "Project A" },
        { id: "project-b", kind: "existing", name: "Project B" },
      ],
    });
    expect(JSON.stringify(projects)).not.toContain(firstRoot);
    expect(JSON.stringify(projects)).not.toContain(secondRoot);
    await expect(registry.workspace("project-b")).resolves.toMatchObject({
      projectId: "project-b",
      projectName: "Project B",
    });
    expect(() => registry.workspace("missing-project")).toThrow(/project not found/i);
  });

  it("persists create, rename, and unregister without deleting source folders", async () => {
    const { dataRoot, firstRoot, registry, secondRoot } = await registryFixture(
      ["poietra-command-that-does-not-exist"],
      true,
    );
    const thirdRoot = await mkdtemp(join(tmpdir(), "poietra-project-c-"));
    temporaryRoots.push(thirdRoot);
    await writeFile(join(thirdRoot, "scene.py"), sceneSource, "utf8");

    const created = registry.createProject("Project C", thirdRoot);
    const projectId = created.project?.id;
    expect(projectId).toMatch(/^project-[0-9a-f]{16}$/);
    expect(created.catalog.projects).toContainEqual({ id: projectId, kind: "existing", name: "Project C" });
    if (!projectId) throw new Error("The created project ID is missing.");

    expect(registry.renameProject(projectId, "Renamed C").project).toEqual({
      id: projectId,
      kind: "existing",
      name: "Renamed C",
    });
    await registry.unregisterProject("project-a");
    await registry.unregisterProject("project-b");
    const emptied = await registry.unregisterProject(projectId);

    expect(emptied).toEqual({ catalog: { defaultProjectId: null, projects: [] }, project: null });
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
    expect(await readFile(join(secondRoot, "scene.py"), "utf8")).toBe(sceneSource);
    expect(await readFile(join(thirdRoot, "scene.py"), "utf8")).toBe(sceneSource);
    const reopened = new PersistentManimProjectCatalog({
      dataRoot: dataRoot!,
      seedProjects: [{ id: "ignored-seed", name: "Ignored", root: firstRoot }],
    });
    expect(reopened.projects()).toEqual([]);
    expect(() => registry.workspace()).toThrow(/no Manim workspace/i);
  });

  it("creates a browser-managed workspace with an importable starter Scene", async () => {
    const { dataRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"], true);

    const created = registry.createManagedProject("Browser workspace");
    const projectId = created.project?.id;
    expect(projectId).toMatch(/^project-[0-9a-f]{32}$/);
    if (!projectId) throw new Error("The managed project ID is missing.");
    const managedRoot = join(dataRoot!, ".workspaces", projectId);
    expect(await readFile(join(managedRoot, "main.py"), "utf8")).toContain("class MainScene(Scene)");
    await expect(registry.workspace(projectId)).resolves.toMatchObject({
      projectId,
      projectName: "Browser workspace",
      sources: [{ path: "main.py", scenes: [{ anchors: [0], name: "MainScene" }] }],
    });
    const persisted = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(persisted.projects()).toContainEqual(
      expect.objectContaining({
        canonicalRoot: managedRoot,
        kind: "managed",
        projectId,
      }),
    );

    await registry.unregisterProject(projectId);
    await expect(readFile(join(managedRoot, "main.py"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const trashEntries = await readdir(join(dataRoot!, ".trash"));
    expect(trashEntries).toHaveLength(1);
    expect(trashEntries[0]).toMatch(new RegExp(`^${projectId}-[0-9a-f-]{36}$`));
    expect(await readFile(join(dataRoot!, ".trash", trashEntries[0]!, "main.py"), "utf8")).toContain(
      "poietra:anchor 0.000",
    );
    const reopened = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(reopened.projects().some((project) => project.projectId === projectId)).toBe(false);
  });

  it("does not delete an existing managed directory when ID allocation collides", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "poietra-managed-collision-"));
    temporaryRoots.push(dataRoot);
    const catalog = new PersistentManimProjectCatalog({
      dataRoot,
      projectIdFactory: () => "project-fixed",
      seedProjects: [],
    });
    const existingRoot = join(dataRoot, ".workspaces", "project-fixed");
    await mkdir(existingRoot);
    const existingSource = "# pre-existing source\n";
    await writeFile(join(existingRoot, "main.py"), existingSource, "utf8");

    expect(() => catalog.createManaged("Collision")).toThrow();
    expect(await readFile(join(existingRoot, "main.py"), "utf8")).toBe(existingSource);
    expect(catalog.projects()).toEqual([]);
  });

  it("migrates the existing version-one catalog as non-managed workspaces", async () => {
    const { dataRoot, firstRoot, secondRoot } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    await writeFile(
      join(dataRoot!, "workspace-catalog.json"),
      JSON.stringify({
        projects: [
          { id: "project-a", name: "Project A", root: firstRoot },
          { id: "project-b", name: "Project B", root: secondRoot },
        ],
        version: 1,
      }),
      "utf8",
    );

    const migrated = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(migrated.projects().map((project) => project.kind)).toEqual(["existing", "existing"]);
    migrated.rename("project-a", "Migrated A");
    const stored = JSON.parse(await readFile(join(dataRoot!, "workspace-catalog.json"), "utf8")) as {
      projects: { kind: string }[];
      version: number;
    };
    expect(stored.version).toBe(2);
    expect(stored.projects.map((project) => project.kind)).toEqual(["existing", "existing"]);
  });

  it("quarantines version-two managed entries outside the managed root or whose directory does not match the ID", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "poietra-invalid-managed-catalog-"));
    const validExistingRoot = await mkdtemp(join(tmpdir(), "poietra-valid-existing-"));
    temporaryRoots.push(dataRoot, validExistingRoot);
    new PersistentManimProjectCatalog({ dataRoot, seedProjects: [] });
    const outsideManagedRoot = join(dataRoot, "outside-managed");
    const mismatchedManagedRoot = join(dataRoot, ".workspaces", "project-other-directory");
    await Promise.all([
      mkdir(outsideManagedRoot),
      mkdir(mismatchedManagedRoot),
      writeFile(join(validExistingRoot, "scene.py"), sceneSource, "utf8"),
    ]);
    await Promise.all([
      writeFile(join(outsideManagedRoot, "main.py"), sceneSource, "utf8"),
      writeFile(join(mismatchedManagedRoot, "main.py"), sceneSource, "utf8"),
    ]);
    await writeFile(
      join(dataRoot, "workspace-catalog.json"),
      JSON.stringify({
        projects: [
          {
            id: "project-outside",
            kind: "managed",
            name: "Outside managed root",
            root: outsideManagedRoot,
          },
          {
            id: "project-mismatch",
            kind: "managed",
            name: "Mismatched managed root",
            root: mismatchedManagedRoot,
          },
        ],
        version: 2,
      }),
      "utf8",
    );

    const catalog = new PersistentManimProjectCatalog({ dataRoot, seedProjects: [] });
    expect(catalog.projects()).toEqual([]);
    expect(() => catalog.create("Outside as existing", outsideManagedRoot)).toThrow(/already registered/i);
    catalog.create("Valid existing", validExistingRoot);
    const persisted = JSON.parse(await readFile(join(dataRoot, "workspace-catalog.json"), "utf8")) as {
      projects: { id: string }[];
      version: number;
    };
    expect(persisted.version).toBe(2);
    expect(persisted.projects.map((project) => project.id)).toEqual(
      expect.arrayContaining(["project-outside", "project-mismatch"]),
    );
  });

  it("refuses to unregister a workspace with a retained render session", async () => {
    const { registry } = await registryFixture([process.execPath, fakeRenderer], true);
    const started = await registry.start({ ...request(), projectId: "project-a" });
    expect((await waitForTerminal(registry, started.id)).status).toBe("ready");

    await expect(registry.unregisterProject("project-a")).rejects.toThrow(/retained render sessions/i);

    await registry.discard(started.id);
    await expect(registry.unregisterProject("project-a")).resolves.toMatchObject({ project: null });
  });

  it("quarantines a persisted workspace while its folder is unavailable", async () => {
    const { dataRoot, firstRoot, secondRoot } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    const movedRoot = `${secondRoot}-moved`;
    temporaryRoots.push(movedRoot);
    await rename(secondRoot, movedRoot);
    let restoredRoot = false;
    let quarantined: PersistentManimProjectCatalog | null = null;
    try {
      quarantined = new PersistentManimProjectCatalog({
        dataRoot: dataRoot!,
        seedProjects: [],
      });
      expect(quarantined.projects().map((project) => project.canonicalRoot)).toEqual([firstRoot]);
      quarantined.rename("project-a", "Renamed while B is unavailable");
      await rename(movedRoot, secondRoot);
      restoredRoot = true;
      expect(() => quarantined!.create("Duplicate B", secondRoot)).toThrow(/already registered/i);
    } finally {
      if (!restoredRoot) await rename(movedRoot, secondRoot);
    }
    const restored = new PersistentManimProjectCatalog({
      dataRoot: dataRoot!,
      seedProjects: [],
    });
    expect(restored.projects().map((project) => project.canonicalRoot)).toEqual([firstRoot, secondRoot]);
    expect(restored.projects().map((project) => project.projectName)).toEqual([
      "Renamed while B is unavailable",
      "Project B",
    ]);
  });

  it("quarantines a persisted workspace whose root resolves to another registration", async () => {
    const { dataRoot, firstRoot, secondRoot } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    await rm(secondRoot, { recursive: true });
    await symlink(firstRoot, secondRoot, "dir");

    const conflicted = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(conflicted.projects().map((project) => project.projectId)).toEqual(["project-a"]);
    conflicted.rename("project-a", "Renamed while B conflicts");

    await rm(secondRoot);
    await mkdir(secondRoot);
    await writeFile(join(secondRoot, "scene.py"), sceneSource, "utf8");
    const restored = new PersistentManimProjectCatalog({ dataRoot: dataRoot!, seedProjects: [] });
    expect(restored.projects().map((project) => project.projectId)).toEqual(["project-a", "project-b"]);
    expect(restored.projects()[0]?.projectName).toBe("Renamed while B conflicts");
  });

  it("counts quarantined workspaces toward the catalog limit", async () => {
    const roots = await Promise.all(
      Array.from({ length: 65 }, () => mkdtemp(join(tmpdir(), "poietra-project-limit-"))),
    );
    const dataRoot = await mkdtemp(join(tmpdir(), "poietra-project-limit-catalog-"));
    temporaryRoots.push(...roots, dataRoot);
    new PersistentManimProjectCatalog({
      dataRoot,
      seedProjects: roots.slice(0, 64).map((root, index) => ({
        id: `project-limit-${index}`,
        name: `Project ${index}`,
        root,
      })),
    });
    const unavailableRoot = roots[63]!;
    const movedRoot = `${unavailableRoot}-moved`;
    await rename(unavailableRoot, movedRoot);
    try {
      const catalog = new PersistentManimProjectCatalog({ dataRoot, seedProjects: [] });
      expect(catalog.projects()).toHaveLength(63);
      expect(() => catalog.create("One too many", roots[64]!)).toThrow(/at most 64/i);
    } finally {
      await rename(movedRoot, unavailableRoot);
    }

    expect(new PersistentManimProjectCatalog({ dataRoot, seedProjects: [] }).projects()).toHaveLength(64);
  });

  it("lowers an exact Python export without requiring a working Manim command", async () => {
    const { firstRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"]);

    const exported = await registry.exportSource({ ...request(), projectId: "project-a" });

    expect(exported).toMatchObject({
      fileName: "scene.poietra.py",
      projectId: "project-a",
    });
    expect(exported.source).toContain('poietra:transaction "render-integration"');
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
    await expect(registry.start({ ...request(), projectId: "project-a" })).rejects.toThrow(/unavailable/i);
  });

  it("exports the unchanged selected Python file without an EditProgram", async () => {
    const { firstRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"]);
    const sourceHash = createHash("sha256").update(sceneSource).digest("hex");

    const exported = await registry.exportOriginalSource({
      projectId: "project-a",
      sourceHash,
      sourcePath: "scene.py",
    });

    expect(exported).toEqual({
      fileName: "scene.py",
      projectId: "project-a",
      source: sceneSource,
    });
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
    await expect(
      registry.exportOriginalSource({
        projectId: "project-a",
        sourceHash: "0".repeat(64),
        sourcePath: "scene.py",
      }),
    ).rejects.toThrow(/source changed before export/i);
  });

  it("routes Commit and Undo to the session's original project after another workspace is opened", async () => {
    const { firstRoot, registry, secondRoot } = await registryFixture();
    const started = await registry.start({ ...request(), projectId: "project-a" });
    await registry.workspace("project-b");
    expect((await waitForTerminal(registry, started.id)).status).toBe("ready");

    const committed = await registry.commit(started.id);
    expect(committed).toMatchObject({ projectId: "project-a", status: "committed" });
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toContain('poietra:transaction "render-integration"');
    expect(await readFile(join(secondRoot, "scene.py"), "utf8")).toBe(sceneSource);

    await registry.undo(started.id);
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
  });

  it("prunes the registry session index when a project manager expires a session", async () => {
    const { registry } = await registryFixture();
    const started = await registry.start({ ...request(), projectId: "project-a" });
    const rendered = await waitForTerminal(registry, started.id);
    const internals = registry as unknown as { sessionProjects: Map<string, string> };
    expect(internals.sessionProjects.get(started.id)).toBe("project-a");

    await registry.cleanupExpiredSessions(Date.parse(rendered.updatedAt) + 30 * 60 * 1_000);

    expect(internals.sessionProjects.has(started.id)).toBe(false);
    expect(() => registry.view(started.id)).toThrow(/session not found/i);
  });

  it("serves project discovery and a safe Python attachment over HTTP", async () => {
    const privateCommandRoot = await mkdtemp(join(tmpdir(), "poietra-private-command-"));
    temporaryRoots.push(privateCommandRoot);
    const privateCommandPath = join(privateCommandRoot, "bin", "manim");
    const privateCommandArgument = "--private-adapter-path";
    const { registry } = await registryFixture([privateCommandPath, privateCommandArgument]);
    const server = createServer((incoming, response) => {
      void handleManimRequest(registry, incoming, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const projectsResponse = await fetch(`${origin}/api/manim/projects`);
      expect(await projectsResponse.json()).toEqual(registry.projects());

      const exportResponse = await fetch(`${origin}/api/manim/projects/project-a/export`, {
        body: JSON.stringify({ ...request(), projectId: "project-a" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(exportResponse.status).toBe(200);
      expect(exportResponse.headers.get("content-type")).toBe("text/x-python; charset=utf-8");
      expect(exportResponse.headers.get("content-disposition")).toBe('attachment; filename="scene.poietra.py"');
      expect(await exportResponse.text()).toContain('poietra:transaction "render-integration"');

      const originalExportResponse = await fetch(`${origin}/api/manim/projects/project-a/export`, {
        body: JSON.stringify({
          projectId: "project-a",
          sourceHash: createHash("sha256").update(sceneSource).digest("hex"),
          sourcePath: "scene.py",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(originalExportResponse.status).toBe(200);
      expect(originalExportResponse.headers.get("content-disposition")).toBe('attachment; filename="scene.py"');
      expect(await originalExportResponse.text()).toBe(sceneSource);

      const mismatchedResponse = await fetch(`${origin}/api/manim/projects/project-b/export`, {
        body: JSON.stringify({ ...request(), projectId: "project-a" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(mismatchedResponse.status).toBe(409);

      const unavailableRenderResponse = await fetch(`${origin}/api/manim/projects/project-a/renders`, {
        body: JSON.stringify({ ...request(), projectId: "project-a" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(unavailableRenderResponse.status).toBe(503);
      const unavailableRenderBody = await unavailableRenderResponse.text();
      expect(unavailableRenderBody).toContain("The configured Manim command is unavailable.");
      expect(unavailableRenderBody).not.toContain(privateCommandPath);
      expect(unavailableRenderBody).not.toContain(privateCommandArgument);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("serves persistent workspace CRUD without exposing or deleting project roots", async () => {
    const { dataRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"], true);
    const addedRoot = await mkdtemp(join(tmpdir(), "poietra-http-project-"));
    temporaryRoots.push(addedRoot);
    await writeFile(join(addedRoot, "scene.py"), sceneSource, "utf8");
    const server = createServer((incoming, response) => {
      void handleManimRequest(registry, incoming, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const managedResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "managed", name: "Managed workspace" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(managedResponse.status).toBe(201);
      const managed = (await managedResponse.json()) as { project: { id: string; name: string } };
      expect(JSON.stringify(managed)).not.toContain(dataRoot);
      const managedWorkspaceResponse = await fetch(`${origin}/api/manim/projects/${managed.project.id}/workspace`);
      await expect(managedWorkspaceResponse.json()).resolves.toMatchObject({
        projectId: managed.project.id,
        sources: [{ path: "main.py", scenes: [{ name: "MainScene" }] }],
      });
      const managedWithRootResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "managed", name: "Invalid managed", root: addedRoot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(managedWithRootResponse.status).toBe(400);

      const createResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "existing", name: "Added workspace", root: addedRoot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        catalog: { projects: { id: string; name: string }[] };
        project: { id: string; name: string };
      };
      expect(JSON.stringify(created)).not.toContain(addedRoot);
      expect(created.project.name).toBe("Added workspace");

      const duplicateResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "existing", name: "Duplicate", root: addedRoot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(duplicateResponse.status).toBe(409);
      expect(JSON.stringify(await duplicateResponse.json())).not.toContain(addedRoot);

      const renameResponse = await fetch(`${origin}/api/manim/projects/${created.project.id}`, {
        body: JSON.stringify({ name: "Renamed workspace" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      expect(renameResponse.status).toBe(200);
      await expect(renameResponse.json()).resolves.toMatchObject({
        project: { id: created.project.id, name: "Renamed workspace" },
      });

      const deleteResponse = await fetch(`${origin}/api/manim/projects/${created.project.id}`, {
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toMatchObject({ project: null });
      expect(await readFile(join(addedRoot, "scene.py"), "utf8")).toBe(sceneSource);

      const missingRoot = join(addedRoot, "private-missing-root");
      const invalidResponse = await fetch(`${origin}/api/manim/projects`, {
        body: JSON.stringify({ kind: "existing", name: "Missing", root: missingRoot }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(invalidResponse.status).toBe(400);
      expect(JSON.stringify(await invalidResponse.json())).not.toContain(missingRoot);
      const deleteManagedResponse = await fetch(`${origin}/api/manim/projects/${managed.project.id}`, {
        method: "DELETE",
      });
      expect(deleteManagedResponse.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("Manim command parsing", () => {
  it("accepts a JSON command without invoking a shell", () => {
    expect(parseManimCommand('["uv", "run", "manim"]')).toEqual(["uv", "run", "manim"]);
    expect(parseManimCommand(undefined)).toEqual(["manim"]);
  });

  it("parses a future multi-project environment registry", () => {
    expect(parseManimProjects('[{"id":"project-a","name":"A","root":"/tmp/a"},"/tmp/b"]')).toEqual([
      { id: "project-a", name: "A", root: "/tmp/a" },
      { root: "/tmp/b" },
    ]);
    expect(() => parseManimProjects('[{"root":"/tmp/a","path":"/private"}]')).toThrow(/unsupported field/i);
  });
});

describe("Manim render plugin configuration", () => {
  it.each([
    { frame: { height: 0, width: 14.222 }, message: /frame height/i },
    { frame: { height: 8, width: Number.NaN }, message: /frame width/i },
  ])("rejects invalid frame dimensions", ({ frame, message }) => {
    expect(
      () =>
        new ManimRenderManager({
          command: [process.execPath],
          frame,
          projectRoot: process.cwd(),
        }),
    ).toThrow(message);
  });

  it("is serve-only and does not return a Vite post hook that closes the manager", async () => {
    const workspaceDataRoot = await mkdtemp(join(tmpdir(), "poietra-plugin-catalog-"));
    temporaryRoots.push(workspaceDataRoot);
    const plugin = manimRenderPipeline({ workspaceDataRoot });
    expect(plugin.apply).toBe("serve");
    const configureResolved = plugin.configResolved as (config: ResolvedConfig) => void;
    configureResolved({ root: process.cwd() } as ResolvedConfig);
    const configureServer = plugin.configureServer as (server: ViteDevServer) => void;
    const postHook = configureServer({
      middlewares: { use: () => undefined },
    } as unknown as ViteDevServer);

    expect(postHook).toBeUndefined();
    const closeBundle = plugin.closeBundle as () => Promise<void>;
    await closeBundle();
  });
});
