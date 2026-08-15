import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { ProgramRenderRequest, RenderCommitRequest, RenderSessionView } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import type { FastManimSnapshotRunViewV1 } from "./fast-manim-snapshot-contract";
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

export function mathTexTransformProgram(
  transactionId = "mathtex-transform-chain",
  sourceEntityId = "source:scene.py#GroupedEquation:equation",
): CanonicalEditProgram {
  const firstTargetEntityId = `tx:${transactionId}/entity:maxwell`;
  const secondTargetEntityId = `tx:${transactionId}/entity:restored`;
  const first: CanonicalEditOperation = {
    dependsOn: [],
    id: `tx:${transactionId}/operation:maxwell`,
    interval: { end: 6, start: 5 },
    kind: "TransformContent",
    provenance: { evidence: [], origin: "remote-model" },
    replacement: {
      displayLines: ["Maxwell equations"],
      texParts: [String.raw`\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}`],
    },
    sourceEntityId,
    strategy: "transform-matching-tex",
    targetEntityId: firstTargetEntityId,
    targetType: "MathTex",
  };
  const second: CanonicalEditOperation = {
    dependsOn: [first.id],
    id: `tx:${transactionId}/operation:restore`,
    interval: { end: 7, start: 6 },
    kind: "TransformContent",
    provenance: { evidence: [], origin: "remote-model" },
    replacement: { displayLines: ["E = mc^2"], texParts: ["E", "=", "m", "c^2"] },
    sourceEntityId: firstTargetEntityId,
    strategy: "transform-matching-tex",
    targetEntityId: secondTargetEntityId,
    targetType: "MathTex",
  };
  return {
    anchor: {
      capturedPlayhead: 5,
      evidence: ["captured-playhead:5.000"],
      resolvedSeconds: 5,
      source: { kind: "playhead", referenceSeconds: 5 },
    },
    intentCount: 2,
    loweringStatus: "supported",
    operations: [first, second],
    provenance: { evidence: [], origin: "remote-model" },
    requestedExecution: "sequence",
    schedule: {
      edges: [
        { from: first.id, reason: "explicit", to: second.id },
        { from: first.id, reason: "identity", to: second.id },
      ],
      mode: "sequence",
      order: [first.id, second.id],
    },
    transactionId,
    version: 1,
  };
}

export async function verifiedSnapshotView(
  renderRequest: ProgramRenderRequest,
  sourceBindingName?: string,
): Promise<FastManimSnapshotRunViewV1> {
  const fixtureDocument = JSON.parse(
    await readFile(
      new URL(
        sourceBindingName
          ? "../fixtures/engine-v1/real-mathtex-morph-v5.json"
          : "../fixtures/engine-v1/studio-mathtex-preview.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<Pick<SceneIrBundleV1, "assets" | "scene">>;
  const runtimeConfigHash = "b".repeat(64);
  const snapshotHash = "e".repeat(64);
  const bundle: SceneIrBundleV1 = {
    assets: fixtureDocument.assets,
    scene: {
      ...fixtureDocument.scene,
      camera: {
        ...fixtureDocument.scene.camera,
        view: { ...fixtureDocument.scene.camera.view, frameHeight: 8, frameWidth: 14.222 },
      },
      animationChannels: sourceBindingName ? [] : fixtureDocument.scene.animationChannels,
      duration: 8,
      entities: sourceBindingName
        ? fixtureDocument.scene.entities.map((entity) => ({
            ...entity,
            lifetimes: entity.lifetimes.map((lifetime) => ({ ...lifetime, end: 8 })),
          }))
        : fixtureDocument.scene.entities,
      requiredCapabilities: sourceBindingName ? ["cubic-path-geometry"] : fixtureDocument.scene.requiredCapabilities,
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash,
        snapshotHash,
        snapshotVersion: 1,
        sourceHash: renderRequest.sourceHash,
      },
    },
  };
  const runtimeEntityId = bundle.scene.entities[0]?.id;
  const runtimeProvenanceId = bundle.scene.entities[0]?.provenanceId;
  return {
    projectId: renderRequest.projectId,
    publishedAt: "2026-08-15T00:00:00.000Z",
    requestId: "server-motion-authority",
    revision: 1,
    runtimeConfigHash,
    sceneName: renderRequest.sceneName,
    schema: "poietra.fast-manim-snapshot-run" as const,
    snapshot: {
      bundle,
      kind: "compiled" as const,
      projectId: renderRequest.projectId,
      requestId: "server-motion-authority",
      runtimeConfigHash,
      sceneId: bundle.scene.sceneId,
      sceneName: renderRequest.sceneName,
      schema: "poietra.fast-manim-snapshot-result" as const,
      snapshotHash,
      sourceHash: renderRequest.sourceHash,
      sourcePath: renderRequest.sourcePath,
      version: 1 as const,
    },
    ...(sourceBindingName && runtimeEntityId && runtimeProvenanceId
      ? {
          sourceRuntimeIdentity: {
            mappings: [
              {
                binding: {
                  id: `source-binding:${sourceBindingName}`,
                  name: sourceBindingName,
                  ordinal: 1,
                  span: { endColumn: 16, endLine: 5, startColumn: 8, startLine: 5 },
                },
                entityId: runtimeEntityId,
                familyPath: [],
                provenanceId: runtimeProvenanceId,
              },
            ],
            runtimeConfigHash,
            sceneId: bundle.scene.sceneId,
            schema: "poietra.studio-verified-source-runtime-identity-map" as const,
            snapshotDigest: "d".repeat(64),
            snapshotHash,
            sourceHash: renderRequest.sourceHash,
            version: 1 as const,
          },
        }
      : {}),
    sourcePath: renderRequest.sourcePath,
    status: "verified" as const,
    version: 1 as const,
  };
}

export async function installVerifiedSnapshot(
  manager: ManimRenderManager,
  renderRequest: ProgramRenderRequest,
  sourceBindingName?: string,
) {
  const snapshotRunner = Reflect.get(manager, "snapshotRunner") as Readonly<{
    snapshot: (query: Readonly<{ sceneName: string; sourcePath: string }>) => Promise<unknown>;
  }>;
  Object.defineProperty(snapshotRunner, "snapshot", {
    configurable: true,
    value: async () => verifiedSnapshotView(renderRequest, sourceBindingName),
    writable: true,
  });
}

export async function installVerifiedRegistrySnapshots(
  registry: ManimProjectRegistry,
  renderRequest: ProgramRenderRequest,
  sourceBindingName?: string,
) {
  const registryManagers = Reflect.get(registry, "managers") as ReadonlyMap<string, ManimRenderManager>;
  await Promise.all(
    [...registryManagers.entries()].map(([projectId, manager]) =>
      installVerifiedSnapshot(manager, { ...renderRequest, projectId }, sourceBindingName),
    ),
  );
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
  await installVerifiedSnapshot(manager, request(), "equation");
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
  await installVerifiedRegistrySnapshots(registry, request(), "equation");
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
