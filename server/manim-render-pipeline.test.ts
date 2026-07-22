import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, request as createHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConfig, ViteDevServer } from "vite";

import { renderProgramBatchId, type ProgramRenderRequest } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { handleManimRequest } from "./manim-render-http";
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

function createCircleProgram(
  transactionId = "batch-create",
  entityName = "circle",
): CanonicalEditProgram {
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

async function fixture(options: Readonly<{
  command?: readonly string[];
  maxConcurrentRenders?: number;
  maxRetainedSessions?: number;
  renderTimeoutMs?: number;
}> = {}) {
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

async function registryFixture(command: readonly string[] = [process.execPath, fakeRenderer]) {
  const firstRoot = await mkdtemp(join(tmpdir(), "poietra-project-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "poietra-project-b-"));
  temporaryRoots.push(firstRoot, secondRoot);
  await Promise.all([
    writeFile(join(firstRoot, "scene.py"), sceneSource, "utf8"),
    writeFile(join(secondRoot, "scene.py"), sceneSource, "utf8"),
  ]);
  const registry = new ManimProjectRegistry({
    command,
    frame: { height: 8, width: 14.222 },
    projects: [
      { id: "project-a", name: "Project A", root: firstRoot },
      { id: "project-b", name: "Project B", root: secondRoot },
    ],
  });
  registries.push(registry);
  return { firstRoot, registry, secondRoot };
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
    expect(workspace.sources[0]?.scenes[0]?.runtimeSceneState.objectGraph.entities)
      .toHaveProperty("source:scene.py#GroupedEquation:equation");

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
  });

  it("coalesces concurrent workspace inspections", async () => {
    const { manager } = await fixture();

    const [first, second] = await Promise.all([manager.workspace(), manager.workspace()]);

    expect(first).toBe(second);
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

  it("exports Programs at distinct source anchors in source order", async () => {
    const { manager } = await fixture();
    const later = motionProgram(7, "batch-later");
    const earlier = motionProgram(5, "batch-earlier");

    const exported = await manager.exportSource(batchRequest([later, earlier]));

    expect(exported.source.indexOf('poietra:transaction "batch-earlier"'))
      .toBeLessThan(exported.source.indexOf('poietra:transaction "batch-later"'));
    expect(exported.source).toContain("# poietra:cursor 5");
    expect(exported.source).toContain("# poietra:cursor 8");
    expect(exported.source).toContain("# poietra:anchor 6");
    expect(exported.source).toContain("# poietra:anchor 9");
  });

  it("carries a generated entity binding into a later source-anchor Program", async () => {
    const { manager } = await fixture();
    const creation = createCircleProgram();
    const entityId = "tx:batch-create/entity:circle";
    const movement = motionProgram(7, "batch-move-created", entityId);

    const exported = await manager.exportSource(batchRequest([creation, movement]));
    const marker = exported.source.match(new RegExp(
      `# poietra:entity \\{\\"id\\":\\"${entityId}\\",\\"variable\\":\\"([^\\"]+)\\"\\}`,
    ));

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
    const variables = [...exported.source.matchAll(
      /# poietra:entity \{"id":"tx:batch[_-]collision\/entity:[^"]+","variable":"([^"]+)"\}/g,
    )].map((match) => match[1]);

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
    expect(exported.source.indexOf('poietra:transaction "batch-near-end-first"'))
      .toBeLessThan(exported.source.indexOf('poietra:transaction "batch-near-end-second"'));
    expect(exported.source).toContain("# poietra:anchor 9");
  });

  it("identifies a render session by the deterministic Program batch", async () => {
    const { manager } = await fixture();
    const programs = [
      motionProgram(5, "batch-session-first"),
      motionProgram(7, "batch-session-second"),
    ];

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

    await expect(manager.start({
      ...invalid,
      program: {
        ...invalid.program,
        operations: [{ ...operation, targetEntityIds: ["invented-identity"] }],
      },
      sourceBindings: [{ entityId: "invented-identity", sourceVariable: "equation" }],
    })).rejects.toThrow(/does not exist|target/i);
  });

  it("does not invent a next-Scene edge between unrelated Python files", async () => {
    const { manager, projectRoot } = await fixture();
    await writeFile(join(projectRoot, "another.py"), `from manim import *

class Independent(Scene):
    def construct(self):
        title = Text("Independent")
        self.add(title)
`, "utf8");

    const workspace = await manager.workspace();
    expect(workspace.sources).toHaveLength(2);
    expect(workspace.sources.flatMap((source) => source.scenes).map((scene) => ({
      id: scene.sceneId,
      next: scene.nextSceneId,
    }))).toEqual([
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
    const fulfilled = starts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<ManimRenderManager["start"]>>>;
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
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("abandons a started render when the client closes before the 202 response finishes", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "poietra-delivery-marker-"));
    temporaryRoots.push(markerRoot);
    const completionMarker = join(markerRoot, "render-completed");
    const { manager } = await fixture({
      command: [
        process.execPath,
        fakeRenderer,
        "--completion-marker",
        completionMarker,
      ],
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
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

  it("rejects absolute source paths even when they point inside the project", async () => {
    const { manager, projectRoot } = await fixture();

    await expect(manager.start(request(join(projectRoot, "scene.py"))))
      .rejects.toThrow(/relative Python file path/i);
  });

  it("rejects new renders after shutdown", async () => {
    const { manager } = await fixture();
    await manager.close();

    await expect(manager.start(request())).rejects.toThrow(/shutting down/i);
  });
});

describe("Manim project registry", () => {
  it("lists configured projects without exposing their filesystem roots", async () => {
    const { firstRoot, registry, secondRoot } = await registryFixture();

    const projects = registry.projects();
    expect(projects).toEqual({
      defaultProjectId: "project-a",
      projects: [
        { id: "project-a", name: "Project A" },
        { id: "project-b", name: "Project B" },
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

  it("lowers an exact Python export without requiring a working Manim command", async () => {
    const { firstRoot, registry } = await registryFixture(["poietra-command-that-does-not-exist"]);

    const exported = await registry.exportSource({ ...request(), projectId: "project-a" });

    expect(exported).toMatchObject({
      fileName: "scene.poietra.py",
      projectId: "project-a",
    });
    expect(exported.source).toContain('poietra:transaction "render-integration"');
    expect(await readFile(join(firstRoot, "scene.py"), "utf8")).toBe(sceneSource);
    await expect(registry.start({ ...request(), projectId: "project-a" })).rejects.toThrow(/not available/i);
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
    const { registry } = await registryFixture(["poietra-command-that-does-not-exist"]);
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

      const mismatchedResponse = await fetch(`${origin}/api/manim/projects/project-b/export`, {
        body: JSON.stringify({ ...request(), projectId: "project-a" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(mismatchedResponse.status).toBe(409);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
    expect(() => new ManimRenderManager({
      command: [process.execPath],
      frame,
      projectRoot: process.cwd(),
    })).toThrow(message);
  });

  it("is serve-only and does not return a Vite post hook that closes the manager", async () => {
    const plugin = manimRenderPipeline();
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
