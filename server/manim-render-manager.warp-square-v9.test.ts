import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import type { FastManimSnapshotRunRequestV1 } from "./fast-manim-snapshot-contract";
import type { FastManimSnapshotRunner, FastManimUnpublishedSnapshotRunViewV1 } from "./fast-manim-snapshot-runner";
import { ManimRenderManager } from "./manim-render-manager";

const sourcePath = "example_scenes/basic.py";
const sceneName = "WarpSquare";
const squareEntityId = `source:${sourcePath}#${sceneName}:square`;
const officialSource = await readFile(
  new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);
const engineFixture = JSON.parse(
  await readFile(new URL("../fixtures/engine-v1/real-warp-square-v9.json", import.meta.url), "utf8"),
) as { assets: unknown; scene: Record<string, unknown> };
const lineJointsSceneName = "LineJoints";
const lineJointsEngineFixture = JSON.parse(
  await readFile(new URL("../fixtures/engine-v1/real-line-joints-v10.json", import.meta.url), "utf8"),
) as { assets: unknown; scene: Record<string, unknown> };
const lineJointsSourceBindings = ["t1", "t2", "t3", "grp"].map((sourceVariable) => ({
  entityId: `source:${sourcePath}#${lineJointsSceneName}:${sourceVariable}`,
  sourceVariable,
}));
const lineJointsTargetId = lineJointsSourceBindings.find(({ sourceVariable }) => sourceVariable === "t2")!.entityId;

const managers: ManimRenderManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function sourceHash(source: string) {
  return createHash("sha256").update(source).digest("hex");
}

function request(): ProgramRenderRequest {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    entityId: squareEntityId,
    id: "warp-square-position",
    interval: { end: 0, start: 0 },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["verified WarpSquare V9 source-time zero"], origin: "direct-manipulation" },
    value: { x: 410, y: 135 },
  };
  const program: CanonicalEditProgram = {
    anchor: {
      capturedPlayhead: 0,
      evidence: ["verified WarpSquare V9 source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["WarpSquare V9 initial edit"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "warp-square-v9-initial-transform",
    version: 1,
  };
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program,
    projectId: "demo",
    sceneName,
    sourceBindings: [{ entityId: squareEntityId, sourceVariable: "square" }],
    sourceHash: sourceHash(officialSource),
    sourcePath,
    viewport: { height: 360, width: 640 },
  };
}

function lineJointsRequest(): ProgramRenderRequest {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    entityId: lineJointsTargetId,
    id: "line-joints-position",
    interval: { end: 0, start: 0 },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["verified LineJoints V10 source-time zero"], origin: "direct-manipulation" },
    value: { x: 410, y: 135 },
  };
  const program: CanonicalEditProgram = {
    anchor: {
      capturedPlayhead: 0,
      evidence: ["verified LineJoints V10 source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["LineJoints V10 central-leaf edit"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "line-joints-v10-initial-transform",
    version: 1,
  };
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program,
    projectId: "demo",
    sceneName: lineJointsSceneName,
    sourceBindings: lineJointsSourceBindings,
    sourceHash: sourceHash(officialSource),
    sourcePath,
    viewport: { height: 360, width: 640 },
  };
}

async function managerFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "poietra-warp-square-v9-manager-"));
  roots.push(projectRoot);
  await mkdir(join(projectRoot, "example_scenes"), { recursive: true });
  await writeFile(join(projectRoot, sourcePath), officialSource, "utf8");
  const manager = new ManimRenderManager({
    command: [process.execPath],
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    projectRoot,
    snapshotVersion: 9,
    tenantId: "test-tenant",
  });
  managers.push(manager);
  const runner = (manager as unknown as { snapshotRunner: FastManimSnapshotRunner }).snapshotRunner;
  return { manager, projectRoot, runner };
}

async function lineJointsManagerFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "poietra-line-joints-v10-manager-"));
  roots.push(projectRoot);
  await mkdir(join(projectRoot, "example_scenes"), { recursive: true });
  await writeFile(join(projectRoot, sourcePath), officialSource, "utf8");
  const manager = new ManimRenderManager({
    command: [process.execPath],
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    projectRoot,
    snapshotVersion: 10,
    tenantId: "test-tenant",
  });
  managers.push(manager);
  const runner = (manager as unknown as { snapshotRunner: FastManimSnapshotRunner }).snapshotRunner;
  return { manager, projectRoot, runner };
}

function verifiedCandidate(
  candidateSource: string,
  runRequest: Omit<FastManimSnapshotRunRequestV1, "sourceHash">,
  identityOverride: Readonly<{ familyPath?: readonly number[]; ordinal?: number }> = {},
): FastManimUnpublishedSnapshotRunViewV1 {
  const candidateHash = sourceHash(candidateSource);
  const scene = structuredClone(engineFixture.scene) as {
    entities: Array<{ id: string; provenanceId: string }>;
    sceneId: string;
    source: { runtimeConfigHash: string; snapshotHash: string; sourceHash: string };
  };
  scene.source.sourceHash = candidateHash;
  const entity = scene.entities[0]!;
  return {
    projectId: runRequest.projectId,
    requestId: runRequest.requestId,
    runtimeConfigHash: scene.source.runtimeConfigHash,
    sceneName: runRequest.sceneName,
    schema: "poietra.fast-manim-snapshot-run",
    snapshot: {
      bundle: { assets: structuredClone(engineFixture.assets), scene },
      kind: "compiled",
      projectId: runRequest.projectId,
      requestId: runRequest.requestId,
      runtimeConfigHash: scene.source.runtimeConfigHash,
      sceneId: scene.sceneId,
      sceneName: runRequest.sceneName,
      schema: "poietra.fast-manim-snapshot-result",
      snapshotHash: scene.source.snapshotHash,
      sourceHash: candidateHash,
      sourcePath: runRequest.sourcePath,
      version: 1,
    },
    sourcePath: runRequest.sourcePath,
    sourceRuntimeIdentity: {
      mappings: [
        {
          binding: {
            id: `source-binding:${"a".repeat(64)}`,
            name: "square",
            ordinal: identityOverride.ordinal ?? 1,
            span: { endColumn: 14, endLine: 87, startColumn: 8, startLine: 87 },
          },
          entityId: entity.id,
          familyPath: [...(identityOverride.familyPath ?? [])],
          provenanceId: entity.provenanceId,
        },
      ],
      runtimeConfigHash: scene.source.runtimeConfigHash,
      sceneId: scene.sceneId,
      schema: "poietra.studio-verified-source-runtime-identity-map",
      snapshotDigest: "b".repeat(64),
      snapshotHash: scene.source.snapshotHash,
      sourceHash: candidateHash,
      version: 1,
    },
    status: "verified",
    version: 1,
  };
}

function verifiedLineJointsCandidate(
  candidateSource: string,
  runRequest: Omit<FastManimSnapshotRunRequestV1, "sourceHash">,
  identityOverride: Readonly<{ omit?: "t3"; t2FamilyPath?: readonly number[] }> = {},
): FastManimUnpublishedSnapshotRunViewV1 {
  const candidateHash = sourceHash(candidateSource);
  const scene = structuredClone(lineJointsEngineFixture.scene) as {
    entities: Array<{ id: string; provenanceId: string }>;
    sceneId: string;
    source: { runtimeConfigHash: string; snapshotHash: string; sourceHash: string };
  };
  scene.source.sourceHash = candidateHash;
  const bindings = [
    { columnEnd: 11, familyPath: [] as const, line: 173, name: "grp", ordinal: 4, sceneOrder: 0 },
    { columnEnd: 10, familyPath: [0] as const, line: 169, name: "t1", ordinal: 1, sceneOrder: 1 },
    {
      columnEnd: 10,
      familyPath: identityOverride.t2FamilyPath ?? ([1] as const),
      line: 170,
      name: "t2",
      ordinal: 2,
      sceneOrder: 2,
    },
    { columnEnd: 10, familyPath: [2] as const, line: 171, name: "t3", ordinal: 3, sceneOrder: 3 },
  ] as const;
  const mappings = bindings
    .filter(({ name }) => name !== identityOverride.omit)
    .map(({ columnEnd, familyPath, line, name, ordinal, sceneOrder }) => {
      const entity = scene.entities[sceneOrder]!;
      return {
        binding: {
          id: `source-binding:${"abcd"[sceneOrder]!.repeat(64)}`,
          name,
          ordinal,
          span: { endColumn: columnEnd, endLine: line, startColumn: 8, startLine: line },
        },
        entityId: entity.id,
        familyPath: [...familyPath],
        provenanceId: entity.provenanceId,
      };
    });
  return {
    projectId: runRequest.projectId,
    requestId: runRequest.requestId,
    runtimeConfigHash: scene.source.runtimeConfigHash,
    sceneName: runRequest.sceneName,
    schema: "poietra.fast-manim-snapshot-run",
    snapshot: {
      bundle: { assets: structuredClone(lineJointsEngineFixture.assets), scene },
      kind: "compiled",
      projectId: runRequest.projectId,
      requestId: runRequest.requestId,
      runtimeConfigHash: scene.source.runtimeConfigHash,
      sceneId: scene.sceneId,
      sceneName: runRequest.sceneName,
      schema: "poietra.fast-manim-snapshot-result",
      snapshotHash: scene.source.snapshotHash,
      sourceHash: candidateHash,
      sourcePath: runRequest.sourcePath,
      version: 1,
    },
    sourcePath: runRequest.sourcePath,
    sourceRuntimeIdentity: {
      mappings,
      runtimeConfigHash: scene.source.runtimeConfigHash,
      sceneId: scene.sceneId,
      schema: "poietra.studio-verified-source-runtime-identity-map",
      snapshotDigest: "b".repeat(64),
      snapshotHash: scene.source.snapshotHash,
      sourceHash: candidateHash,
      version: 1,
    },
    status: "verified",
    version: 1,
  };
}

describe("ManimRenderManager WarpSquare V9 Apply preflight", () => {
  it("verifies candidate bytes before creating a render session without writing project source", async () => {
    const { manager, projectRoot, runner } = await managerFixture();
    const preflight = vi
      .spyOn(runner, "runCandidateUnpublished")
      .mockImplementation(async (candidateSource, runRequest) => verifiedCandidate(candidateSource, runRequest));

    const started = await manager.start(request());

    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight.mock.calls[0]?.[0]).toContain("        square.move_to((2, 1, 0))\n        self.play(");
    expect(await readFile(join(projectRoot, sourcePath), "utf8")).toBe(officialSource);
    await manager.abandonStart(started.id);
  });

  it.each([
    ["an unverified producer result", null],
    ["an incomplete family mapping", { familyPath: [0] }],
    ["a non-primary source binding", { ordinal: 2 }],
  ] as const)("fails closed before session creation for %s", async (_label, identityOverride) => {
    const { manager, projectRoot, runner } = await managerFixture();
    vi.spyOn(runner, "runCandidateUnpublished").mockImplementation(async (candidateSource, runRequest) => {
      if (identityOverride) return verifiedCandidate(candidateSource, runRequest, identityOverride);
      return {
        failure: { code: "result-rejected", message: "server-owned rejection" },
        fallback: { kind: "server-authoritative-render" },
        projectId: runRequest.projectId,
        requestId: runRequest.requestId,
        runtimeConfigHash: "a".repeat(64),
        sceneName: runRequest.sceneName,
        schema: "poietra.fast-manim-snapshot-run",
        sourcePath: runRequest.sourcePath,
        status: "failed",
        version: 1,
      };
    });

    await expect(manager.start(request())).rejects.toMatchObject({ status: 409 });
    expect(manager.canUnregister()).toBe(true);
    expect(await readFile(join(projectRoot, sourcePath), "utf8")).toBe(officialSource);
  });
});

describe("ManimRenderManager LineJoints V10 Apply preflight", () => {
  it("verifies the edited hierarchy before creating a render session", async () => {
    const { manager, projectRoot, runner } = await lineJointsManagerFixture();
    const preflight = vi
      .spyOn(runner, "runCandidateUnpublished")
      .mockImplementation(async (candidateSource, runRequest) =>
        verifiedLineJointsCandidate(candidateSource, runRequest),
      );

    const started = await manager.start(lineJointsRequest());

    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight.mock.calls[0]?.[0]).toContain(
      "        grp.set(width=config.frame_width - 1)\n        t2.move_to((2, 1, 0))\n\n        self.add(grp)",
    );
    expect(await readFile(join(projectRoot, sourcePath), "utf8")).toBe(officialSource);
    await manager.abandonStart(started.id);
  });

  it.each([
    ["an unverified producer result", null],
    ["an incomplete hierarchy", { omit: "t3" }],
    ["an incorrect central-leaf family path", { t2FamilyPath: [0] }],
  ] as const)("fails closed before session creation for %s", async (_label, identityOverride) => {
    const { manager, projectRoot, runner } = await lineJointsManagerFixture();
    vi.spyOn(runner, "runCandidateUnpublished").mockImplementation(async (candidateSource, runRequest) => {
      if (identityOverride) return verifiedLineJointsCandidate(candidateSource, runRequest, identityOverride);
      return {
        failure: { code: "result-rejected", message: "server-owned rejection" },
        fallback: { kind: "server-authoritative-render" },
        projectId: runRequest.projectId,
        requestId: runRequest.requestId,
        runtimeConfigHash: "a".repeat(64),
        sceneName: runRequest.sceneName,
        schema: "poietra.fast-manim-snapshot-run",
        sourcePath: runRequest.sourcePath,
        status: "failed",
        version: 1,
      };
    });

    await expect(manager.start(lineJointsRequest())).rejects.toMatchObject({ status: 409 });
    expect(manager.canUnregister()).toBe(true);
    expect(await readFile(join(projectRoot, sourcePath), "utf8")).toBe(officialSource);
  });
});
