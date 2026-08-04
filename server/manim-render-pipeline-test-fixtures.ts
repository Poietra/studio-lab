import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProgramRenderRequest, RenderCommitRequest, RenderSessionView } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { PersistentManimProjectCatalog } from "./manim-project-catalog";
import { ManimProjectRegistry, ManimRenderManager } from "./manim-render-pipeline";
import type { ManimSourceReadHooks } from "./manim-source-store";

export const fakeRenderer = fileURLToPath(new URL("./test-fixtures/fake-manim.mjs", import.meta.url));
export const temporaryRoots: string[] = [];
const managers: ManimRenderManager[] = [];
const registries: ManimProjectRegistry[] = [];

export const sceneSource = `from manim import *

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

export const temporalMetadataSource = `from manim import *

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

export function request(sourcePath = "scene.py"): ProgramRenderRequest {
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

export function motionProgram(
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

export function batchRequest(programs: readonly CanonicalEditProgram[]): ProgramRenderRequest {
  const base = request();
  return { ...base, program: programs[0]!, programs };
}

export function createCircleProgram(transactionId = "batch-create", entityName = "circle"): CanonicalEditProgram {
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

export async function fixture(
  options: Readonly<{
    command?: readonly string[];
    maxConcurrentRenders?: number;
    maxRetainedSessions?: number;
    renderTimeoutMs?: number;
    sourceStoreHooks?: ManimSourceReadHooks;
    staticVideoCommand?: readonly string[];
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
    tenantId: "test-tenant",
  });
  managers.push(manager);
  return { manager, projectRoot };
}

export async function waitForTerminal(manager: Pick<ManimRenderManager, "view">, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = manager.view(id);
    if (["cancelled", "failed", "ready"].includes(session.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Render session did not finish.");
}

export function commitRequest(
  session: RenderSessionView,
  actionId = "00000000-0000-4000-8000-000000000001",
): RenderCommitRequest {
  return {
    actionId,
    programBatchId: session.programBatchId,
    projectId: session.projectId,
    renderRequestId: session.renderRequestId,
    sceneName: session.sceneName,
    sourceHash: session.patch.sourceHash,
    sourcePath: session.sourcePath,
  };
}

export async function registryFixture(command: readonly string[] = [process.execPath, fakeRenderer], mutable = false) {
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
    ...(dataRoot ? { catalogStorageRoot: dataRoot } : {}),
    command,
    frame: { height: 8, width: 14.222 },
    projects: seedProjects,
    tenantId: "test-tenant",
  });
  registries.push(registry);
  return { dataRoot, firstRoot, registry, secondRoot };
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export async function cleanupManimRenderPipelineFixtures() {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
}
