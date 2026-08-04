import { readFile } from "node:fs/promises";

import type { ProgramRenderRequest } from "../../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../../src/studio/operations";
import type { FastManimSnapshotRunRequestV1 } from "../fast-manim-snapshot-contract";
import type { FastManimUnpublishedSnapshotRunViewV1 } from "../fast-manim-snapshot-runner";
import { sourceHash } from "../manim-source-store";

export const CANDIDATE_PREFLIGHT_SOURCE_PATH_V1 = "example_scenes/basic.py";
export const CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1 = await readFile(
  new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);

const warpSquareEngineFixture = JSON.parse(
  await readFile(new URL("../../fixtures/engine-v1/real-warp-square-v9.json", import.meta.url), "utf8"),
) as { assets: unknown; scene: Record<string, unknown> };
const lineJointsEngineFixture = JSON.parse(
  await readFile(new URL("../../fixtures/engine-v1/real-line-joints-v10.json", import.meta.url), "utf8"),
) as { assets: unknown; scene: Record<string, unknown> };

type VerifiedCandidateBuilderV1 = (
  candidateSource: string,
  request: Omit<FastManimSnapshotRunRequestV1, "sourceHash">,
) => FastManimUnpublishedSnapshotRunViewV1;

export type CandidatePreflightProfileFixtureV1 = Readonly<{
  candidateSnippet: string;
  label: "LineJoints V10" | "WarpSquare V9";
  request: () => ProgramRenderRequest;
  snapshotVersion: 9 | 10;
  verifiedCandidate: VerifiedCandidateBuilderV1;
}>;

function renderRequest(
  sceneName: string,
  sourceVariables: readonly string[],
  targetSourceVariable: string,
  transactionId: string,
): ProgramRenderRequest {
  const entityId = (sourceVariable: string) =>
    `source:${CANDIDATE_PREFLIGHT_SOURCE_PATH_V1}#${sceneName}:${sourceVariable}`;
  const targetId = entityId(targetSourceVariable);
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    entityId: targetId,
    id: `${transactionId}-position`,
    interval: { end: 0, start: 0 },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: [`verified ${sceneName} source-time zero`], origin: "direct-manipulation" },
    value: { x: 410, y: 135 },
  };
  const program: CanonicalEditProgram = {
    anchor: {
      capturedPlayhead: 0,
      evidence: [`verified ${sceneName} source-time zero`],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [`${sceneName} initial edit`], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId,
    version: 1,
  };
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program,
    projectId: "demo",
    sceneName,
    sourceBindings: sourceVariables.map((sourceVariable) => ({ entityId: entityId(sourceVariable), sourceVariable })),
    sourceHash: sourceHash(CANDIDATE_PREFLIGHT_OFFICIAL_SOURCE_V1),
    sourcePath: CANDIDATE_PREFLIGHT_SOURCE_PATH_V1,
    viewport: { height: 360, width: 640 },
  };
}

function verifiedCandidate(
  fixture: { assets: unknown; scene: Record<string, unknown> },
  candidateSource: string,
  runRequest: Omit<FastManimSnapshotRunRequestV1, "sourceHash">,
  bindings: readonly Readonly<{
    columnEnd: number;
    familyPath: readonly number[];
    line: number;
    name: string;
    ordinal: number;
    sceneOrder: number;
  }>[],
): FastManimUnpublishedSnapshotRunViewV1 {
  const candidateHash = sourceHash(candidateSource);
  const scene = structuredClone(fixture.scene) as {
    entities: Array<{ id: string; provenanceId: string }>;
    sceneId: string;
    source: { runtimeConfigHash: string; snapshotHash: string; sourceHash: string };
  };
  scene.source.sourceHash = candidateHash;
  const mappings = bindings.map(({ columnEnd, familyPath, line, name, ordinal, sceneOrder }) => {
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
      bundle: { assets: structuredClone(fixture.assets), scene },
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

export const CANDIDATE_PREFLIGHT_PROFILES_V1: readonly CandidatePreflightProfileFixtureV1[] = [
  {
    candidateSnippet: "        square.move_to(",
    label: "WarpSquare V9",
    request: () => renderRequest("WarpSquare", ["square"], "square", "warp-square-v9-initial-transform"),
    snapshotVersion: 9,
    verifiedCandidate: (candidateSource, request) =>
      verifiedCandidate(warpSquareEngineFixture, candidateSource, request, [
        { columnEnd: 14, familyPath: [], line: 87, name: "square", ordinal: 1, sceneOrder: 0 },
      ]),
  },
  {
    candidateSnippet: "        t2.move_to(",
    label: "LineJoints V10",
    request: () => renderRequest("LineJoints", ["t1", "t2", "t3", "grp"], "t2", "line-joints-v10-initial-transform"),
    snapshotVersion: 10,
    verifiedCandidate: (candidateSource, request) =>
      verifiedCandidate(lineJointsEngineFixture, candidateSource, request, [
        { columnEnd: 11, familyPath: [], line: 173, name: "grp", ordinal: 4, sceneOrder: 0 },
        { columnEnd: 10, familyPath: [0], line: 169, name: "t1", ordinal: 1, sceneOrder: 1 },
        { columnEnd: 10, familyPath: [1], line: 170, name: "t2", ordinal: 2, sceneOrder: 2 },
        { columnEnd: 10, familyPath: [2], line: 171, name: "t3", ordinal: 3, sceneOrder: 3 },
      ]),
  },
] as const;

type CandidateResultMutationV1 = (
  result: FastManimUnpublishedSnapshotRunViewV1,
) => FastManimUnpublishedSnapshotRunViewV1;

function mutateVerified(
  result: FastManimUnpublishedSnapshotRunViewV1,
  mutate: (candidate: Record<string, unknown>) => void,
) {
  const candidate = structuredClone(result) as unknown as Record<string, unknown>;
  mutate(candidate);
  return candidate as unknown as FastManimUnpublishedSnapshotRunViewV1;
}

export const CANDIDATE_PREFLIGHT_REJECTION_CASES_V1: readonly Readonly<{
  label: string;
  mutate: CandidateResultMutationV1;
}>[] = [
  {
    label: "an unverified producer result",
    mutate: (result) => ({
      failure: { code: "result-rejected", message: "server-owned rejection" },
      fallback: { kind: "server-authoritative-render" },
      projectId: result.projectId,
      requestId: result.requestId,
      runtimeConfigHash: result.runtimeConfigHash,
      sceneName: result.sceneName,
      schema: "poietra.fast-manim-snapshot-run",
      sourcePath: result.sourcePath,
      status: "failed",
      version: 1,
    }),
  },
  {
    label: "an incomplete runtime mapping",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const identity = candidate.sourceRuntimeIdentity as { mappings: unknown[] };
        identity.mappings = identity.mappings.slice(0, -1);
      }),
  },
  {
    label: "an incorrect family path",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const identity = candidate.sourceRuntimeIdentity as { mappings: Array<{ familyPath: number[] }> };
        identity.mappings[0]!.familyPath = [9];
      }),
  },
  {
    label: "a non-primary source binding",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const identity = candidate.sourceRuntimeIdentity as { mappings: Array<{ binding: { ordinal: number } }> };
        identity.mappings[0]!.binding.ordinal += 1;
      }),
  },
  {
    label: "a stale identity source hash",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const identity = candidate.sourceRuntimeIdentity as { sourceHash: string };
        identity.sourceHash = "f".repeat(64);
      }),
  },
  {
    label: "a different selected runtime configuration",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const runtimeConfigHash = "e".repeat(64);
        candidate.runtimeConfigHash = runtimeConfigHash;
        const snapshot = candidate.snapshot as {
          bundle: { scene: { source: { runtimeConfigHash: string } } };
          runtimeConfigHash: string;
        };
        snapshot.runtimeConfigHash = runtimeConfigHash;
        snapshot.bundle.scene.source.runtimeConfigHash = runtimeConfigHash;
        const identity = candidate.sourceRuntimeIdentity as { runtimeConfigHash: string };
        identity.runtimeConfigHash = runtimeConfigHash;
      }),
  },
  {
    label: "a different snapshot profile",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const snapshot = candidate.snapshot as { bundle: { scene: { source: { snapshotVersion: number } } } };
        snapshot.bundle.scene.source.snapshotVersion = 1;
      }),
  },
  {
    label: "an incorrect source span",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const identity = candidate.sourceRuntimeIdentity as {
          mappings: Array<{ binding: { span: { endLine: number; startLine: number } } }>;
        };
        identity.mappings[0]!.binding.span.startLine += 1;
        identity.mappings[0]!.binding.span.endLine += 1;
      }),
  },
  {
    label: "an incorrect entity link",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const identity = candidate.sourceRuntimeIdentity as { mappings: Array<{ entityId: string }> };
        identity.mappings[0]!.entityId = `source:${"9".repeat(64)}`;
      }),
  },
  {
    label: "an incorrect provenance link",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const identity = candidate.sourceRuntimeIdentity as { mappings: Array<{ provenanceId: string }> };
        identity.mappings[0]!.provenanceId = `source:${"8".repeat(64)}`;
      }),
  },
  {
    label: "an incorrect parent link",
    mutate: (result) =>
      mutateVerified(result, (candidate) => {
        const snapshot = candidate.snapshot as {
          bundle: { scene: { entities: Array<{ id: string; parentId: string | null }> } };
        };
        const entities = snapshot.bundle.scene.entities;
        entities[entities.length - 1]!.parentId = `source:${"7".repeat(64)}`;
      }),
  },
] as const;
