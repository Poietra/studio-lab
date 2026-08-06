import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { canonicalEngineBenchmarkJsonV1 } from "../engine/benchmark";
import { parseVerifiedSceneIrBundleV1 } from "../engine/contracts";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import { compileEngineFrameV1 } from "../engine/reference-evaluator";
import { type SceneIrV1, sceneIrSourceRevisionHash } from "../engine/scene-ir";
import { importManimScene } from "../render-pipeline/source-import";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import {
  type ProgramRecord,
  type ProposedState,
  type RuntimeEntity,
  type RuntimeSceneState,
  STUDIO_STATE_VERSION,
  type WorkingState,
} from "./model";
import type { CanonicalEditOperation } from "./operations";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSourceRuntimeMappingV1,
  type StudioVerifiedPreviewSnapshotV1,
} from "./preview-snapshot-provider";
import {
  compileStudioPreviewTemporalRebaseV1,
  projectStudioPreviewInitialEntityPresenceV1,
  projectStudioPreviewInitialValidationSceneV1,
  studioPreviewInitialEditRuntimeAuthorityV1,
  studioPreviewInitialEditTargetIsPresentV1,
  studioPreviewSyntheticInitialEditAnchorV1,
} from "./preview-temporal-rebase";
import { createDirectManipulationPositionProgram, createDirectManipulationScaleProgram } from "./suggestion-program";
import {
  compileStudioPreviewSceneV1,
  studioPreviewInteractionAuthorityV1,
  studioPreviewInteractionEntityIdsV1,
} from "./use-preview-renderer";

const FRAME = { height: 8, width: 14.222222222222221 } as const;
const VIEWPORT = { height: 360, width: 640 } as const;
const STUDIO_ENTITY_ID = "source:fixtures/real-preview-harness/scene_square_to_circle.py#SquareToCircle:square";
const STUDIO_CIRCLE_ID = "source:fixtures/real-preview-harness/scene_square_to_circle.py#SquareToCircle:circle";
const SOURCE_PATH = "fixtures/real-preview-harness/scene_square_to_circle.py";
const STUDIO_SCENE_ID = `${SOURCE_PATH}#SquareToCircle`;
const SOURCE_HASH = "ef874f1ab5899aadf870956ec71ce71653d373366b23e40c2ee8b070ad193c40";
const OFFICIAL_BASIC_SOURCE_HASH = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const SNAPSHOT_HASH = "de7db7be8e1c633bd5668ed13b4daf3c3e945026db107bddc70e5366b0af80f1";
const SOURCE_BINDING_ID = "source-binding:555240577158406fa67c9ef3fd4eced1471249d8e97362c3939e8a8a6f1e9b0f";
const WORKING_REVISION = "4".repeat(64);
const WINDING_ROOT = 1.5119159473817447;
const WARP_SQUARE_SOURCE_PATH = "example_scenes/basic.py";
const WARP_SQUARE_SCENE_ID = `${WARP_SQUARE_SOURCE_PATH}#WarpSquare`;
const WARP_SQUARE_ENTITY_ID = `source:${WARP_SQUARE_SCENE_ID}:square`;
const WARP_SQUARE_SOURCE_HASH = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const WARP_SQUARE_SNAPSHOT_HASH = "b8854f07baa588b01a2a5694d8ade2800601f1e26b6e12d626cc170ffa1be9ed";
const LINE_JOINTS_SCENE_ID = `${WARP_SQUARE_SOURCE_PATH}#LineJoints`;
const WRITE_STUFF_SCENE_ID = `${WARP_SQUARE_SOURCE_PATH}#WriteStuff`;

type SquareToCircleFixtureFile = Readonly<{
  assets: unknown;
  producerReference: Readonly<{
    snapshotHash: string;
    sourcePath: string;
    sourceSha256: string;
  }>;
  scene: unknown;
}>;

type EditKind = "combined" | "position" | "scale";

async function sealedSquareToCircleV8() {
  const fixtureUrl = new URL("../../fixtures/engine-v1/real-square-to-circle-v8.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as SquareToCircleFixtureFile;
  expect(fixture.producerReference).toMatchObject({
    snapshotHash: SNAPSHOT_HASH,
    sourcePath: SOURCE_PATH,
    sourceSha256: SOURCE_HASH,
  });
  const bundle = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
  const source = bundle.scene.source;
  if (source.kind !== "imported-manim-server-snapshot" || bundle.scene.entities.length !== 1) {
    throw new Error("The sealed SquareToCircle V8 fixture is incomplete.");
  }
  expect(source).toMatchObject({ snapshotHash: SNAPSHOT_HASH, snapshotVersion: 8, sourceHash: SOURCE_HASH });
  expect(bundle.scene.animationChannels.map(({ kind }) => kind)).toEqual([
    "opacity",
    "path-morph",
    "vector-appearance",
    "path-trim",
  ]);
  return bundle;
}

async function sealedWarpSquareV9() {
  const fixtureUrl = new URL("../../fixtures/engine-v1/real-warp-square-v9.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as SquareToCircleFixtureFile;
  expect(fixture.producerReference).toMatchObject({
    snapshotHash: WARP_SQUARE_SNAPSHOT_HASH,
    sourcePath: WARP_SQUARE_SOURCE_PATH,
    sourceSha256: WARP_SQUARE_SOURCE_HASH,
  });
  const bundle = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
  const source = bundle.scene.source;
  if (source.kind !== "imported-manim-server-snapshot" || bundle.scene.entities.length !== 1) {
    throw new Error("The sealed WarpSquare V9 fixture is incomplete.");
  }
  expect(source).toMatchObject({
    snapshotHash: WARP_SQUARE_SNAPSHOT_HASH,
    snapshotVersion: 9,
    sourceHash: WARP_SQUARE_SOURCE_HASH,
  });
  expect(bundle.scene.animationChannels.map(({ kind }) => kind)).toEqual(["path-morph"]);
  return bundle;
}

function importedSquareEntity(): RuntimeEntity {
  return {
    geometry: {
      dimensions: { kind: "known", value: { height: 2, width: 2 } },
      position: { kind: "known", value: { x: 320, y: 180 } },
      scale: { kind: "known", value: 1 },
      style: { kind: "known", value: {} },
    },
    id: STUDIO_ENTITY_ID,
    lifetime: [{ end: 3, start: 0 }],
    provisional: false,
    sourceIdentity: { kind: "known", value: "square" },
    type: "Square",
  };
}

function importedCircleEntity(): RuntimeEntity {
  return {
    ...importedSquareEntity(),
    id: STUDIO_CIRCLE_ID,
    lifetime: [{ end: 2, start: 1 }],
    sourceIdentity: { kind: "known", value: "circle" },
    type: "Circle",
  };
}

function baseRuntimeScene(sceneId: string): RuntimeSceneState {
  return {
    constraintGraph: { constraints: [] },
    duration: 3,
    eventTrack: { events: [] },
    objectGraph: {
      entities: { [STUDIO_CIRCLE_ID]: importedCircleEntity(), [STUDIO_ENTITY_ID]: importedSquareEntity() },
      lineage: [],
    },
    propertyChannels: {},
    provenanceGraph: { records: [] },
    sceneId,
    version: STUDIO_STATE_VERSION,
  };
}

function workingState(runtimeSceneState: RuntimeSceneState): WorkingState {
  return {
    appliedPrograms: [],
    editorContext: {
      activeSceneId: runtimeSceneState.sceneId,
      playhead: 0,
      selection: [STUDIO_ENTITY_ID],
      version: STUDIO_STATE_VERSION,
      viewport: VIEWPORT,
    },
    runtimeSceneState,
    sourceSnapshot: {
      configId: "sealed-square-to-circle-v8",
      hash: `sha256:${SOURCE_HASH}`,
      sourceId: SOURCE_PATH,
      version: STUDIO_STATE_VERSION,
    },
    stagedPrograms: [],
    staticSemanticState: {
      entities: [
        {
          runtimeIdentities: { kind: "known", value: [STUDIO_ENTITY_ID] },
          sourceIdentity: "square",
          type: { kind: "known", value: "Square" },
        },
      ],
      unknowns: [],
      version: STUDIO_STATE_VERSION,
    },
    version: STUDIO_STATE_VERSION,
  };
}

function validRecord(validation: ReturnType<typeof createDirectManipulationPositionProgram>): ProgramRecord {
  if (validation.kind !== "valid") {
    throw new Error(`SquareToCircle edit fixture is invalid: ${JSON.stringify(validation.issues)}`);
  }
  return programRecord(validation.program, validation);
}

async function warpSquareInput(kind: EditKind = "combined") {
  const bundle = await sealedWarpSquareV9();
  const runtimeEntity = bundle.scene.entities[0];
  const source = bundle.scene.source;
  if (!runtimeEntity || source.kind !== "imported-manim-server-snapshot") {
    throw new Error("The sealed WarpSquare V9 fixture lost its source authority.");
  }
  const studioEntity = {
    ...importedSquareEntity(),
    id: WARP_SQUARE_ENTITY_ID,
    lifetime: [{ end: 4, start: 0 }],
  };
  const runtimeSceneState: RuntimeSceneState = {
    ...baseRuntimeScene(WARP_SQUARE_SCENE_ID),
    duration: 4,
    objectGraph: { entities: { [studioEntity.id]: studioEntity }, lineage: [] },
  };
  const inherited = workingState(runtimeSceneState);
  const base: WorkingState = {
    ...inherited,
    editorContext: { ...inherited.editorContext, selection: [studioEntity.id] },
    sourceSnapshot: {
      ...inherited.sourceSnapshot,
      configId: "sealed-warp-square-v9",
      hash: `sha256:${WARP_SQUARE_SOURCE_HASH}`,
      sourceId: WARP_SQUARE_SOURCE_PATH,
    },
    staticSemanticState: {
      ...inherited.staticSemanticState,
      entities: [
        {
          runtimeIdentities: { kind: "known", value: [studioEntity.id] },
          sourceIdentity: "square",
          type: { kind: "known", value: "Square" },
        },
      ],
    },
  };
  const mapping: StudioPreviewSourceRuntimeMappingV1 = {
    bindingId: "binding:warp-square",
    entityId: runtimeEntity.id,
    sourceName: "square",
  };
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    assetPayloads: [],
    correlation: {
      assetsManifestDigest: bundle.assets.manifestDigest,
      context: {
        projectId: "demo",
        sceneName: "WarpSquare",
        sourceDuration: 4,
        sourceHash: source.sourceHash,
        sourcePath: WARP_SQUARE_SOURCE_PATH,
        workingRevision: PRISTINE_WORKING_REVISION,
      },
      engineRevisionHash: source.snapshotHash,
      sceneDuration: 4,
      sceneId: bundle.scene.sceneId,
      serverPublicationRevision: 1,
    },
    duration: 4,
    sceneId: bundle.scene.sceneId,
    snapshot: bundle,
    sourceLabel: `${WARP_SQUARE_SOURCE_PATH} · WarpSquare`,
    sourceRuntimeIdentity: new Map([["square", mapping]]),
  };
  return {
    mapping,
    proposedState: editedState(base, kind, WARP_SQUARE_ENTITY_ID),
    snapshot,
  };
}

function editedState(base: WorkingState, kind: EditKind, entityId = STUDIO_ENTITY_ID): ProposedState {
  const records: ProgramRecord[] = [];
  if (kind === "position" || kind === "combined") {
    records.push(
      validRecord(
        createDirectManipulationPositionProgram({
          capturedPlayhead: 0,
          delta: { x: 64, y: -36 },
          positions: { [entityId]: { x: 320, y: 180 } },
          scene: base.runtimeSceneState,
          start: 0,
          targetEntityIds: [entityId],
          transactionId: "move-square-at-zero",
        }),
      ),
    );
  }
  if (kind === "scale" || kind === "combined") {
    records.push(
      validRecord(
        createDirectManipulationScaleProgram({
          capturedPlayhead: 0,
          interval: { end: 0, start: 0 },
          scales: { [entityId]: { from: 1, to: 1.5 } },
          scene: base.runtimeSceneState,
          targetEntityIds: [entityId],
          transactionId: "scale-square-at-zero",
        }),
      ),
    );
  }
  return evaluateWorkingState({ ...base, appliedPrograms: records });
}

async function lineJointsInput(kind: EditKind = "combined", targetSourceName: "t1" | "t2" | "t3" = "t2") {
  const [fixtureText, sourceText] = await Promise.all([
    readFile(new URL("../../fixtures/engine-v1/real-line-joints-v10.json", import.meta.url), "utf8"),
    readFile(new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
  ]);
  const fixture = JSON.parse(fixtureText) as SquareToCircleFixtureFile;
  const bundle = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
  const source = bundle.scene.source;
  const imported = importManimScene(sourceText, WARP_SQUARE_SOURCE_PATH, "LineJoints", FRAME);
  if (!imported || source.kind !== "imported-manim-server-snapshot") {
    throw new Error("The LineJoints V10 source fixture is incomplete.");
  }
  const sourceNames = ["grp", "t1", "t2", "t3"] as const;
  const sourceRuntimeIdentity = new Map<string, StudioPreviewSourceRuntimeMappingV1>();
  sourceNames.forEach((sourceName, index) => {
    const runtimeEntity = bundle.scene.entities[index];
    if (!runtimeEntity) throw new Error(`LineJoints V10 lost runtime entity ${index}.`);
    sourceRuntimeIdentity.set(sourceName, {
      bindingId: `binding:line-joints:${sourceName}`,
      entityId: runtimeEntity.id,
      sourceName,
    });
  });
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    assetPayloads: [],
    correlation: {
      assetsManifestDigest: bundle.assets.manifestDigest,
      context: {
        projectId: "demo",
        sceneName: "LineJoints",
        sourceDuration: 1,
        sourceHash: source.sourceHash,
        sourcePath: WARP_SQUARE_SOURCE_PATH,
        workingRevision: PRISTINE_WORKING_REVISION,
      },
      engineRevisionHash: source.snapshotHash,
      sceneDuration: 1,
      sceneId: bundle.scene.sceneId,
      serverPublicationRevision: 1,
    },
    duration: 1,
    sceneId: bundle.scene.sceneId,
    snapshot: bundle,
    sourceLabel: `${WARP_SQUARE_SOURCE_PATH} · LineJoints`,
    sourceRuntimeIdentity,
  };
  const authority = studioPreviewInitialEditRuntimeAuthorityV1(snapshot);
  if (authority?.profile !== "line-joints-v10") {
    throw new Error("The sealed LineJoints V10 fixture did not grant its bounded edit authority.");
  }
  const targetEntityId = `source:${LINE_JOINTS_SCENE_ID}:${targetSourceName}`;
  const runtimeSceneState: RuntimeSceneState = {
    ...imported.runtimeSceneState,
    duration: 1,
  };
  const validationScene = projectStudioPreviewInitialValidationSceneV1(runtimeSceneState, authority);
  const inherited = workingState(runtimeSceneState);
  const base: WorkingState = {
    ...inherited,
    editorContext: { ...inherited.editorContext, activeSceneId: LINE_JOINTS_SCENE_ID, selection: [targetEntityId] },
    sourceSnapshot: {
      configId: "sealed-line-joints-v10",
      hash: `sha256:${WARP_SQUARE_SOURCE_HASH}`,
      sourceId: WARP_SQUARE_SOURCE_PATH,
      version: STUDIO_STATE_VERSION,
    },
    staticSemanticState: imported.staticSemanticState,
  };
  const records: ProgramRecord[] = [];
  if (kind === "position" || kind === "combined") {
    records.push(
      validRecord(
        createDirectManipulationPositionProgram({
          capturedPlayhead: 0,
          delta: { x: 64, y: -36 },
          positions: { [targetEntityId]: authority.baseCenter },
          scene: validationScene,
          start: 0,
          targetEntityIds: [targetEntityId],
          transactionId: `move-line-joints-${targetSourceName}-at-zero`,
        }),
      ),
    );
  }
  if (kind === "scale" || kind === "combined") {
    records.push(
      validRecord(
        createDirectManipulationScaleProgram({
          capturedPlayhead: 0,
          interval: { end: 0, start: 0 },
          scales: { [targetEntityId]: { from: 1, to: 1.5 } },
          scene: validationScene,
          targetEntityIds: [targetEntityId],
          transactionId: `scale-line-joints-${targetSourceName}-at-zero`,
        }),
      ),
    );
  }
  return {
    authority,
    proposedState: evaluateWorkingState({ ...base, appliedPrograms: records }),
    snapshot,
    targetEntityId,
  };
}

async function writeStuffInput(
  kind: EditKind = "combined",
  targetSourceName: "example_tex" | "example_text" = "example_tex",
) {
  const [fixtureText, sourceText] = await Promise.all([
    readFile(new URL("../../fixtures/engine-v1/real-write-stuff-v12.json", import.meta.url), "utf8"),
    readFile(new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
  ]);
  const fixture = JSON.parse(fixtureText) as SquareToCircleFixtureFile;
  const bundle = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
  const source = bundle.scene.source;
  const imported = importManimScene(sourceText, WARP_SQUARE_SOURCE_PATH, "WriteStuff", FRAME);
  if (!imported || source.kind !== "imported-manim-server-snapshot") {
    throw new Error("The WriteStuff V12 source fixture is incomplete.");
  }
  const sourceRuntimeIdentity = new Map<string, StudioPreviewSourceRuntimeMappingV1>();
  for (const [sourceName, sceneOrder] of [
    ["group", 0],
    ["example_text", 1],
    ["example_tex", 32],
  ] as const) {
    const runtimeEntity = bundle.scene.entities[sceneOrder];
    if (!runtimeEntity) throw new Error(`WriteStuff V12 lost runtime entity ${sceneOrder}.`);
    sourceRuntimeIdentity.set(sourceName, {
      bindingId: `binding:write-stuff:${sourceName}`,
      entityId: runtimeEntity.id,
      sourceName,
    });
  }
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    assetPayloads: [],
    correlation: {
      assetsManifestDigest: bundle.assets.manifestDigest,
      context: {
        projectId: "demo",
        sceneName: "WriteStuff",
        sourceDuration: 4,
        sourceHash: source.sourceHash,
        sourcePath: WARP_SQUARE_SOURCE_PATH,
        workingRevision: PRISTINE_WORKING_REVISION,
      },
      engineRevisionHash: source.snapshotHash,
      sceneDuration: 4,
      sceneId: bundle.scene.sceneId,
      serverPublicationRevision: 1,
    },
    duration: 4,
    sceneId: bundle.scene.sceneId,
    snapshot: bundle,
    sourceLabel: `${WARP_SQUARE_SOURCE_PATH} · WriteStuff`,
    sourceRuntimeIdentity,
  };
  const authority = studioPreviewInitialEditRuntimeAuthorityV1(snapshot);
  if (authority?.profile !== "write-stuff-v12") {
    throw new Error("The sealed WriteStuff V12 fixture did not grant its bounded edit authority.");
  }
  const targetEntityId = `source:${WRITE_STUFF_SCENE_ID}:${targetSourceName}`;
  const runtimeSceneState: RuntimeSceneState = { ...imported.runtimeSceneState, duration: 4 };
  const validationScene = projectStudioPreviewInitialValidationSceneV1(runtimeSceneState, authority);
  const inherited = workingState(runtimeSceneState);
  const base: WorkingState = {
    ...inherited,
    editorContext: { ...inherited.editorContext, activeSceneId: WRITE_STUFF_SCENE_ID, selection: [targetEntityId] },
    sourceSnapshot: {
      configId: "sealed-write-stuff-v12",
      hash: `sha256:${WARP_SQUARE_SOURCE_HASH}`,
      sourceId: WARP_SQUARE_SOURCE_PATH,
      version: STUDIO_STATE_VERSION,
    },
    staticSemanticState: imported.staticSemanticState,
  };
  const records: ProgramRecord[] = [];
  if (kind === "position" || kind === "combined") {
    const targetPosition = {
      x: (0.5 + 1.25 / FRAME.width) * VIEWPORT.width,
      y: (0.5 + 0.5 / FRAME.height) * VIEWPORT.height,
    };
    records.push(
      validRecord(
        createDirectManipulationPositionProgram({
          capturedPlayhead: 0,
          delta: {
            x: targetPosition.x - authority.baseCenter.x,
            y: targetPosition.y - authority.baseCenter.y,
          },
          positions: { [targetEntityId]: authority.baseCenter },
          scene: validationScene,
          start: 0,
          targetEntityIds: [targetEntityId],
          transactionId: `move-write-stuff-${targetSourceName}-at-zero`,
        }),
      ),
    );
  }
  if (kind === "scale" || kind === "combined") {
    records.push(
      validRecord(
        createDirectManipulationScaleProgram({
          capturedPlayhead: 0,
          interval: { end: 0, start: 0 },
          scales: { [targetEntityId]: { from: 1, to: 0.5 } },
          scene: validationScene,
          targetEntityIds: [targetEntityId],
          transactionId: `scale-write-stuff-${targetSourceName}-at-zero`,
        }),
      ),
    );
  }
  return {
    authority,
    proposedState: evaluateWorkingState({ ...base, appliedPrograms: records }),
    snapshot,
    targetEntityId,
  };
}

async function squareToCircleInput(kind: EditKind = "combined") {
  const bundle = await sealedSquareToCircleV8();
  const runtimeEntity = bundle.scene.entities[0];
  const source = bundle.scene.source;
  if (!runtimeEntity || source.kind !== "imported-manim-server-snapshot") {
    throw new Error("The sealed SquareToCircle V8 fixture lost its source authority.");
  }
  const mapping: StudioPreviewSourceRuntimeMappingV1 = {
    bindingId: SOURCE_BINDING_ID,
    entityId: runtimeEntity.id,
    sourceName: "square",
  };
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    assetPayloads: [],
    correlation: {
      assetsManifestDigest: bundle.assets.manifestDigest,
      context: {
        projectId: "demo",
        sceneName: "SquareToCircle",
        sourceDuration: bundle.scene.duration,
        sourceHash: source.sourceHash,
        sourcePath: SOURCE_PATH,
        workingRevision: PRISTINE_WORKING_REVISION,
      },
      engineRevisionHash: source.snapshotHash,
      sceneDuration: bundle.scene.duration,
      sceneId: bundle.scene.sceneId,
      serverPublicationRevision: 1,
    },
    duration: bundle.scene.duration,
    sceneId: bundle.scene.sceneId,
    snapshot: bundle,
    sourceLabel: `${SOURCE_PATH} · SquareToCircle`,
    sourceRuntimeIdentity: new Map([["square", mapping]]),
  };
  const base = workingState(baseRuntimeScene(STUDIO_SCENE_ID));
  return { mapping, proposedState: editedState(base, kind), snapshot };
}

function officialSquareToCircleSnapshot(
  input: Awaited<ReturnType<typeof squareToCircleInput>>,
): StudioVerifiedPreviewSnapshotV1 {
  const source = input.snapshot.snapshot.scene.source;
  if (source.kind !== "imported-manim-server-snapshot") {
    throw new Error("The SquareToCircle fixture lost its server source seal.");
  }
  const scene = {
    ...input.snapshot.snapshot.scene,
    source: { ...source, sourceHash: OFFICIAL_BASIC_SOURCE_HASH },
  };
  return {
    ...input.snapshot,
    correlation: {
      ...input.snapshot.correlation,
      context: {
        ...input.snapshot.correlation.context,
        sourceHash: OFFICIAL_BASIC_SOURCE_HASH,
        sourcePath: "example_scenes/basic.py",
      },
      engineRevisionHash: sceneIrSourceRevisionHash(scene),
    },
    snapshot: { ...input.snapshot.snapshot, scene },
    sourceLabel: "example_scenes/basic.py · SquareToCircle",
  };
}

function compile(input: Awaited<ReturnType<typeof squareToCircleInput>>) {
  return compileStudioPreviewTemporalRebaseV1({
    frame: FRAME,
    proposedState: input.proposedState,
    snapshot: input.snapshot,
    sourceRevisionHash: WORKING_REVISION,
  });
}

function replaceFirstOperation(
  proposedState: ProposedState,
  replace: (operation: CanonicalEditOperation) => readonly CanonicalEditOperation[],
): ProposedState {
  const firstRecord = proposedState.programs[0];
  const firstOperation = firstRecord?.program.operations[0];
  if (!firstRecord || !firstOperation) throw new Error("The edit fixture has no operation to replace.");
  const operations = replace(firstOperation);
  return {
    ...proposedState,
    programs: [
      {
        ...firstRecord,
        program: {
          ...firstRecord.program,
          operations,
          schedule: { ...firstRecord.program.schedule, order: operations.map(({ id }) => id) },
        },
      },
      ...proposedState.programs.slice(1),
    ],
  };
}

async function sampledSemantics(scene: SceneIrV1, sampleTime: number) {
  const result = await compileEngineFrameV1({
    assets: (await sealedSquareToCircleV8()).assets,
    evidence: ["Studio #414 temporal rebase", `sample ${sampleTime}`],
    packetId: `studio-414:${sampleTime}`,
    sampleTime,
    scene,
    viewport: { heightPx: 360, widthPx: 640 },
  });
  if (result.kind !== "ready") throw new Error(result.message);
  return canonicalEngineBenchmarkJsonV1({ camera: result.frame.packet.camera, draws: result.frame.packet.draws });
}

describe("compileStudioPreviewTemporalRebaseV1 SquareToCircle V8", () => {
  it("exposes a preview-only zero anchor only for the exact correlated V8 identity", async () => {
    const input = await squareToCircleInput("position");
    expect(studioPreviewSyntheticInitialEditAnchorV1(input.snapshot)).toBe(0);
    expect(studioPreviewSyntheticInitialEditAnchorV1({ ...input.snapshot, sourceRuntimeIdentity: null })).toBeNull();
    expect(
      studioPreviewSyntheticInitialEditAnchorV1({
        ...input.snapshot,
        correlation: { ...input.snapshot.correlation, sceneDuration: 4 },
      }),
    ).toBeNull();
  });

  it("promotes only the exact official V8 source seal to producer-backed position authority", async () => {
    const input = await squareToCircleInput("position");
    const snapshot = officialSquareToCircleSnapshot(input);
    expect(studioPreviewInitialEditRuntimeAuthorityV1(snapshot)).toMatchObject({
      baseCenter: { x: 320, y: 180 },
      duration: 3,
      lifetime: { end: 3, start: 0 },
      profile: "square-to-circle-v8",
      relativeScale: 1,
      runtimeEntityId: input.mapping.entityId,
      studioEntityId: "source:example_scenes/basic.py#SquareToCircle:square",
      studioSceneId: "example_scenes/basic.py#SquareToCircle",
    });
    expect(studioPreviewSyntheticInitialEditAnchorV1(snapshot)).toBe(0);
    expect(
      studioPreviewInitialEditRuntimeAuthorityV1({
        ...snapshot,
        correlation: {
          ...snapshot.correlation,
          context: { ...snapshot.correlation.context, sceneName: "CopiedSquareToCircle" },
        },
      }),
    ).toBeNull();
    expect(
      studioPreviewInitialEditRuntimeAuthorityV1({
        ...snapshot,
        sourceRuntimeIdentity: new Map([["circle", { ...input.mapping, sourceName: "circle" }]]),
      }),
    ).toBeNull();
  });

  it.each([
    ["position", 1, 1, 1.4222222222222223, 0.7999999999999998],
    ["scale", 1.5, 1.5, 0, 0],
    ["combined", 1.5, 1.5, 1.4222222222222223, 0.7999999999999998],
  ] as const)("rebases a t=0 %s edit onto the base transform", async (kind, m11, m22, tx, ty) => {
    const input = await squareToCircleInput(kind);
    const result = compile(input);
    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") throw new Error(result.issue.message);
    expect(result.scene.entities[0]?.transform.m11).toBeCloseTo(m11, 12);
    expect(result.scene.entities[0]?.transform.m22).toBeCloseTo(m22, 12);
    expect(result.scene.entities[0]?.transform.m12).toBe(0);
    expect(result.scene.entities[0]?.transform.m21).toBe(0);
    expect(result.scene.entities[0]?.transform.tx).toBeCloseTo(tx, 12);
    expect(result.scene.entities[0]?.transform.ty).toBeCloseTo(ty, 12);
  });

  it("preserves every imported channel byte and deterministic forward/A-B-A samples after the combined edit", async () => {
    const input = await squareToCircleInput();
    const importedScene = input.snapshot.snapshot.scene;
    const importedChannelBytes = canonicalJsonV1(importedScene.animationChannels);
    const result = compile(input);
    if (result.kind !== "rebased") throw new Error(result.issue.message);

    expect(result.scene.animationChannels).toBe(importedScene.animationChannels);
    expect(canonicalJsonV1(result.scene.animationChannels)).toBe(importedChannelBytes);
    expect(result.scene.animationChannels.map(({ kind }) => kind)).toEqual([
      "opacity",
      "path-morph",
      "vector-appearance",
      "path-trim",
    ]);
    expect(result.scene.entities[0]?.geometry).toBe(importedScene.entities[0]?.geometry);

    const forwardTimes = [0, 0.5, 1, WINDING_ROOT, 2, 2.5, 3] as const;
    const forward: string[] = [];
    for (const time of forwardTimes) forward.push(await sampledSemantics(result.scene, time));
    const aFirst = await sampledSemantics(result.scene, WINDING_ROOT);
    const b = await sampledSemantics(result.scene, 0.5);
    const aAgain = await sampledSemantics(result.scene, WINDING_ROOT);
    expect(aFirst).toBe(forward[3]);
    expect(aAgain).toBe(aFirst);
    expect(b).toBe(forward[1]);
    expect(b).not.toBe(aFirst);
  });

  it.each([
    [
      "ambiguous operations",
      "conflicting-edit-unsupported",
      async () => {
        const input = await squareToCircleInput("position");
        return {
          ...input,
          proposedState: replaceFirstOperation(input.proposedState, (operation) => [
            operation,
            { ...operation, id: `${operation.id}:ambiguous` },
          ]),
        };
      },
    ],
    [
      "a mid-animation anchor",
      "mid-animation-edit-unsupported",
      async () => {
        const input = await squareToCircleInput("position");
        const first = input.proposedState.programs[0];
        if (!first) throw new Error("The edit fixture has no Program.");
        return {
          ...input,
          proposedState: {
            ...input.proposedState,
            programs: [
              {
                ...first,
                program: {
                  ...first.program,
                  anchor: { ...first.program.anchor, capturedPlayhead: 1, resolvedSeconds: 1 },
                },
              },
            ],
          },
        };
      },
    ],
    [
      "changed timing",
      "channel-timing-edit-unsupported",
      async () => {
        const input = await squareToCircleInput("position");
        return {
          ...input,
          proposedState: {
            ...input.proposedState,
            evaluatedScene: { ...input.proposedState.evaluatedScene, duration: 4 },
          },
        };
      },
    ],
    [
      "a different Studio Scene",
      "source-correlation-invalid",
      async () => {
        const input = await squareToCircleInput("position");
        const sceneId = "scene:different-source";
        return {
          ...input,
          proposedState: {
            ...input.proposedState,
            base: {
              ...input.proposedState.base,
              editorContext: { ...input.proposedState.base.editorContext, activeSceneId: sceneId },
              runtimeSceneState: { ...input.proposedState.base.runtimeSceneState, sceneId },
            },
            evaluatedScene: { ...input.proposedState.evaluatedScene, sceneId },
          },
        };
      },
    ],
    [
      "a different Studio source snapshot",
      "source-correlation-invalid",
      async () => {
        const input = await squareToCircleInput("position");
        return {
          ...input,
          proposedState: {
            ...input.proposedState,
            base: {
              ...input.proposedState.base,
              sourceSnapshot: { ...input.proposedState.base.sourceSnapshot, sourceId: "other.py" },
            },
          },
        };
      },
    ],
    [
      "a non-Square Studio target",
      "target-edit-unsupported",
      async () => {
        const input = await squareToCircleInput("position");
        const replaceType = (scene: RuntimeSceneState): RuntimeSceneState => ({
          ...scene,
          objectGraph: {
            ...scene.objectGraph,
            entities: {
              ...scene.objectGraph.entities,
              [STUDIO_ENTITY_ID]: { ...scene.objectGraph.entities[STUDIO_ENTITY_ID]!, type: "Rectangle" },
            },
          },
        });
        return {
          ...input,
          proposedState: {
            ...input.proposedState,
            base: {
              ...input.proposedState.base,
              runtimeSceneState: replaceType(input.proposedState.base.runtimeSceneState),
            },
            evaluatedScene: replaceType(input.proposedState.evaluatedScene),
          },
        };
      },
    ],
    [
      "a geometry edit",
      "geometry-edit-unsupported",
      async () => {
        const input = await squareToCircleInput("position");
        return {
          ...input,
          proposedState: replaceFirstOperation(input.proposedState, (operation) => [
            {
              dependsOn: operation.dependsOn,
              entityId: STUDIO_ENTITY_ID,
              from: { dimensions: { height: 2, width: 2 }, position: { x: 320, y: 180 } },
              id: operation.id,
              interval: operation.interval,
              kind: "ResizeEntity",
              provenance: operation.provenance,
              scale: 1.5,
              shape: "rectangle",
              to: { dimensions: { height: 3, width: 3 }, position: { x: 320, y: 180 } },
            },
          ]),
        };
      },
    ],
    [
      "a content edit",
      "target-edit-unsupported",
      async () => {
        const input = await squareToCircleInput("position");
        return {
          ...input,
          proposedState: replaceFirstOperation(input.proposedState, (operation) => [
            {
              dependsOn: operation.dependsOn,
              entityId: STUDIO_ENTITY_ID,
              id: operation.id,
              interval: operation.interval,
              key: "content",
              kind: "SetProperty",
              provenance: operation.provenance,
              value: { displayLines: ["changed"] },
            },
          ]),
        };
      },
    ],
    [
      "target creation",
      "target-edit-unsupported",
      async () => {
        const input = await squareToCircleInput("position");
        const extra = { ...importedSquareEntity(), id: `${STUDIO_ENTITY_ID}:extra` };
        return {
          ...input,
          proposedState: {
            ...input.proposedState,
            evaluatedScene: {
              ...input.proposedState.evaluatedScene,
              objectGraph: {
                ...input.proposedState.evaluatedScene.objectGraph,
                entities: { ...input.proposedState.evaluatedScene.objectGraph.entities, [extra.id]: extra },
              },
            },
          },
        };
      },
    ],
    [
      "missing identity",
      "identity-unverified",
      async () => {
        const input = await squareToCircleInput("position");
        return { ...input, snapshot: { ...input.snapshot, sourceRuntimeIdentity: null } };
      },
    ],
    [
      "ambiguous identity",
      "identity-unverified",
      async () => {
        const input = await squareToCircleInput("position");
        return {
          ...input,
          snapshot: {
            ...input.snapshot,
            sourceRuntimeIdentity: new Map([["circle", input.mapping]]),
          },
        };
      },
    ],
  ] as const)("fails closed on %s", async (_name, code, makeInput) => {
    const result = compile(await makeInput());
    expect(result).toMatchObject({ issue: { code }, kind: "unsupported" });
  });
});

describe("compileStudioPreviewTemporalRebaseV1 WarpSquare V9", () => {
  function compileWarpSquare(input: Awaited<ReturnType<typeof warpSquareInput>>) {
    return compileStudioPreviewTemporalRebaseV1({
      frame: FRAME,
      proposedState: input.proposedState,
      snapshot: input.snapshot,
      sourceRevisionHash: WORKING_REVISION,
    });
  }

  it("exposes synthetic t=0 authority only for the exact correlated Square identity", async () => {
    const input = await warpSquareInput("position");
    const source = input.snapshot.snapshot.scene.source;
    if (source.kind !== "imported-manim-server-snapshot") throw new Error("WarpSquare V9 lost its source.");
    expect(studioPreviewSyntheticInitialEditAnchorV1(input.snapshot)).toBe(0);
    expect(studioPreviewSyntheticInitialEditAnchorV1({ ...input.snapshot, sourceRuntimeIdentity: null })).toBeNull();
    expect(
      studioPreviewSyntheticInitialEditAnchorV1({
        ...input.snapshot,
        sourceRuntimeIdentity: new Map([["other", { ...input.mapping, sourceName: "other" }]]),
      }),
    ).toBeNull();
    expect(
      studioPreviewSyntheticInitialEditAnchorV1({
        ...input.snapshot,
        snapshot: {
          ...input.snapshot.snapshot,
          scene: {
            ...input.snapshot.snapshot.scene,
            source: { ...source, snapshotVersion: 8 },
          },
        },
      }),
    ).toBeNull();
    const editedSourceHash = "e".repeat(64);
    const editedSnapshot: StudioVerifiedPreviewSnapshotV1 = {
      ...input.snapshot,
      correlation: {
        ...input.snapshot.correlation,
        context: { ...input.snapshot.correlation.context, sourceHash: editedSourceHash },
      },
      snapshot: {
        ...input.snapshot.snapshot,
        scene: {
          ...input.snapshot.snapshot.scene,
          source: { ...source, sourceHash: editedSourceHash },
        },
      },
    };
    expect(studioPreviewInitialEditRuntimeAuthorityV1(editedSnapshot)).toBeNull();
    expect(studioPreviewSyntheticInitialEditAnchorV1(editedSnapshot)).toBeNull();
    expect(
      compileWarpSquare({
        ...input,
        proposedState: {
          ...input.proposedState,
          base: {
            ...input.proposedState.base,
            sourceSnapshot: { ...input.proposedState.base.sourceSnapshot, hash: `sha256:${editedSourceHash}` },
          },
        },
        snapshot: editedSnapshot,
      }),
    ).toMatchObject({ issue: { code: "target-edit-unsupported" }, kind: "unsupported" });
  });

  it("bridges only the exact runtime-backed Square into UI presence and validation", async () => {
    const input = await warpSquareInput("position");
    const authority = studioPreviewInitialEditRuntimeAuthorityV1(input.snapshot);
    if (!authority) throw new Error("WarpSquare V9 lost its initial edit authority.");
    const base = input.proposedState.base;
    const entity = base.runtimeSceneState.objectGraph.entities[WARP_SQUARE_ENTITY_ID];
    if (!entity) throw new Error("WarpSquare V9 lost its Studio Square.");
    const absentRuntimeScene: RuntimeSceneState = {
      ...base.runtimeSceneState,
      objectGraph: {
        ...base.runtimeSceneState.objectGraph,
        entities: { ...base.runtimeSceneState.objectGraph.entities, [entity.id]: { ...entity, lifetime: [] } },
      },
    };
    const absentProjection = projectProposedState(
      evaluateWorkingState({ ...base, appliedPrograms: [], runtimeSceneState: absentRuntimeScene, stagedPrograms: [] }),
      0,
    ).canvas.entities;
    expect(absentProjection).toMatchObject([{ id: authority.studioEntityId, present: false }]);

    const geometry = new Map([[authority.runtimeEntityId, {}]]);
    const presented = projectStudioPreviewInitialEntityPresenceV1(absentProjection, authority, geometry);
    expect(presented).toMatchObject([{ id: authority.studioEntityId, present: true }]);
    expect(projectStudioPreviewInitialEntityPresenceV1(absentProjection, authority, null)).toBe(absentProjection);
    expect(projectStudioPreviewInitialEntityPresenceV1(absentProjection, null, geometry)).toBe(absentProjection);

    const validationScene = projectStudioPreviewInitialValidationSceneV1(absentRuntimeScene, authority);
    expect(validationScene).not.toBe(absentRuntimeScene);
    expect(validationScene.objectGraph.entities[entity.id]?.lifetime).toEqual([{ end: 4, start: 0 }]);
    expect(absentRuntimeScene.objectGraph.entities[entity.id]?.lifetime).toEqual([]);
    expect(studioPreviewInitialEditTargetIsPresentV1(absentRuntimeScene, entity.id, 0, authority)).toBe(true);
    expect(studioPreviewInitialEditTargetIsPresentV1(absentRuntimeScene, entity.id, 0, null)).toBe(false);
    expect(studioPreviewInitialEditTargetIsPresentV1(absentRuntimeScene, entity.id, 1, authority)).toBe(false);
    expect(
      createDirectManipulationPositionProgram({
        capturedPlayhead: 0,
        delta: { x: 16, y: 8 },
        positions: { [entity.id]: { x: 320, y: 180 } },
        scene: validationScene,
        start: 0,
        targetEntityIds: [entity.id],
        transactionId: "runtime-authorized-warp-square-position",
      }).kind,
    ).toBe("valid");
    expect(
      createDirectManipulationScaleProgram({
        capturedPlayhead: 0,
        interval: { end: 0, start: 0 },
        scales: { [entity.id]: { from: 1, to: 1.25 } },
        scene: validationScene,
        targetEntityIds: [entity.id],
        transactionId: "runtime-authorized-warp-square-scale",
      }).kind,
    ).toBe("valid");
    expect(projectStudioPreviewInitialValidationSceneV1(absentRuntimeScene, null)).toBe(absentRuntimeScene);
    const ambiguousScene: RuntimeSceneState = {
      ...absentRuntimeScene,
      objectGraph: {
        ...absentRuntimeScene.objectGraph,
        entities: {
          ...absentRuntimeScene.objectGraph.entities,
          [`${entity.id}:ambiguous`]: { ...entity, id: `${entity.id}:ambiguous` },
        },
      },
    };
    expect(projectStudioPreviewInitialValidationSceneV1(ambiguousScene, authority)).toBe(ambiguousScene);
  });

  it("revalidates the real import's empty lifetime only under exact V9 producer authority", async () => {
    const input = await warpSquareInput("position");
    const base = input.proposedState.base;
    const entity = base.runtimeSceneState.objectGraph.entities[WARP_SQUARE_ENTITY_ID];
    if (!entity) throw new Error("WarpSquare V9 lost its Studio Square.");
    const runtimeSceneState: RuntimeSceneState = {
      ...base.runtimeSceneState,
      objectGraph: {
        ...base.runtimeSceneState.objectGraph,
        entities: { ...base.runtimeSceneState.objectGraph.entities, [entity.id]: { ...entity, lifetime: [] } },
      },
    };
    const proposedState = evaluateWorkingState({ ...base, runtimeSceneState });
    expect(proposedState.programs).toMatchObject([{ validation: { status: "invalid" } }]);

    expect(compileWarpSquare({ ...input, proposedState }).kind).toBe("rebased");
    expect(
      compileWarpSquare({
        ...input,
        proposedState,
        snapshot: { ...input.snapshot, sourceRuntimeIdentity: null },
      }),
    ).toMatchObject({ issue: { code: "identity-unverified" }, kind: "unsupported" });
  });

  it.each([
    ["position", 1, 1, 1.4222222222222223, 0.7999999999999998],
    ["scale", 1.5, 1.5, 0, 0],
    ["combined", 1.5, 1.5, 1.4222222222222223, 0.7999999999999998],
  ] as const)("rebases a t=0 %s draft without changing the path morph", async (kind, m11, m22, tx, ty) => {
    const input = await warpSquareInput(kind);
    const importedScene = input.snapshot.snapshot.scene;
    const importedChannelBytes = canonicalJsonV1(importedScene.animationChannels);
    const result = compileWarpSquare(input);
    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") throw new Error(result.issue.message);

    expect(result.scene.animationChannels).toBe(importedScene.animationChannels);
    expect(canonicalJsonV1(result.scene.animationChannels)).toBe(importedChannelBytes);
    expect(result.scene.animationChannels.map(({ kind: channelKind }) => channelKind)).toEqual(["path-morph"]);
    expect(result.scene.entities[0]?.geometry).toBe(importedScene.entities[0]?.geometry);
    expect(result.scene.entities[0]?.transform).toMatchObject({ m11, m12: 0, m21: 0, m22 });
    expect(result.scene.entities[0]?.transform.tx).toBeCloseTo(tx, 12);
    expect(result.scene.entities[0]?.transform.ty).toBeCloseTo(ty, 12);
  });

  it("fails closed when the imported path-morph interval is not the exact V9 slice", async () => {
    const input = await warpSquareInput("position");
    const [channel] = input.snapshot.snapshot.scene.animationChannels;
    if (!channel || channel.kind !== "path-morph") throw new Error("WarpSquare V9 lost its path morph.");
    const result = compileWarpSquare({
      ...input,
      snapshot: {
        ...input.snapshot,
        snapshot: {
          ...input.snapshot.snapshot,
          scene: {
            ...input.snapshot.snapshot.scene,
            animationChannels: [
              {
                ...channel,
                keyframes: [channel.keyframes[0]!, { ...channel.keyframes[1]!, at: 3.5 }],
              },
            ],
          },
        },
      },
    });
    expect(result).toMatchObject({ issue: { code: "target-edit-unsupported" }, kind: "unsupported" });
  });
});

describe("compileStudioPreviewTemporalRebaseV1 LineJoints V10", () => {
  function compileLineJoints(input: Awaited<ReturnType<typeof lineJointsInput>>) {
    return compileStudioPreviewTemporalRebaseV1({
      frame: FRAME,
      proposedState: input.proposedState,
      snapshot: input.snapshot,
      sourceRevisionHash: WORKING_REVISION,
    });
  }

  it("grants runtime geometry and lifetime evidence only to the exact center t2 identity", async () => {
    const input = await lineJointsInput("position");
    expect(input.authority).toEqual({
      baseCenter: { x: 320, y: 180 },
      duration: 1,
      lifetime: { end: 1, start: 0 },
      profile: "line-joints-v10",
      relativeScale: 1,
      runtimeEntityId: input.snapshot.snapshot.scene.entities[2]?.id,
      studioEntityId: input.targetEntityId,
      studioSceneId: LINE_JOINTS_SCENE_ID,
    });
    expect(studioPreviewSyntheticInitialEditAnchorV1(input.snapshot)).toBe(0);
    const interactionAuthority = studioPreviewInteractionAuthorityV1(input.snapshot);
    expect(interactionAuthority).toEqual({ kind: "interactive" });
    expect(
      studioPreviewInteractionEntityIdsV1(
        input.snapshot.sourceRuntimeIdentity,
        interactionAuthority,
        input.snapshot.snapshot.scene.entities,
      ),
    ).toEqual(input.snapshot.snapshot.scene.entities.slice(1).map(({ id }) => id));

    const runtimeT2 = input.proposedState.base.runtimeSceneState.objectGraph.entities[input.targetEntityId];
    if (!runtimeT2?.geometry) throw new Error("LineJoints Studio t2 lost its imported geometry evidence.");
    const projectedT2 = {
      ...runtimeT2,
      geometry: runtimeT2.geometry,
      opacity: 1,
      position: { x: 0, y: 0 },
      present: true,
      scale: 1,
    };
    const projected = projectStudioPreviewInitialEntityPresenceV1(
      [projectedT2],
      input.authority,
      new Map([[input.authority.runtimeEntityId, {}]]),
    );
    expect(projected[0]).toMatchObject({
      geometry: { position: { kind: "known" }, scale: { kind: "known" } },
      position: { x: 320, y: 180 },
      scale: 1,
    });
  });

  it("rebases a combined t=0 draft while preserving the group, sibling leaves, and joins", async () => {
    const input = await lineJointsInput();
    const importedScene = input.snapshot.snapshot.scene;
    const result = await compileStudioPreviewSceneV1({
      frame: FRAME,
      proposedState: input.proposedState,
      snapshot: input.snapshot,
      workingRevision: WORKING_REVISION,
      workspaceKey: "demo/example_scenes/basic.py/LineJoints",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    const scene = result.scene.bundle.scene;

    expect(scene.animationChannels).toBe(importedScene.animationChannels);
    expect(scene.entities[0]).toBe(importedScene.entities[0]);
    expect(scene.entities[1]).toBe(importedScene.entities[1]);
    expect(scene.entities[3]).toBe(importedScene.entities[3]);
    expect(scene.entities[2]?.geometry).toBe(importedScene.entities[2]?.geometry);
    expect(scene.entities[2]?.appearance).toBe(importedScene.entities[2]?.appearance);
    expect(scene.entities[2]?.transform).toMatchObject({ m11: 1.5, m12: 0, m21: 0, m22: 1.5 });
    expect(scene.entities[2]?.transform.tx).toBeCloseTo(1.4222222222222223, 12);
    expect(scene.entities[2]?.transform.ty).toBeCloseTo(0.7999999999999998, 12);
    expect(
      scene.entities
        .slice(1)
        .map((entity) => (entity.appearance.kind === "vector" ? entity.appearance.stroke?.join : null)),
    ).toEqual(["miter", "round", "bevel"]);
    expect(result.scene.interactionEntityIds).toEqual(
      input.snapshot.snapshot.scene.entities.slice(1).map(({ id }) => id),
    );
  });

  it("fails closed for sibling mutation or any identity drift", async () => {
    const siblingEdit = await lineJointsInput("position", "t1");
    expect(compileLineJoints(siblingEdit)).toMatchObject({
      issue: { code: "target-edit-unsupported" },
      kind: "unsupported",
    });

    const input = await lineJointsInput("position");
    const identity = new Map(input.snapshot.sourceRuntimeIdentity);
    const t2 = identity.get("t2");
    const t3 = identity.get("t3");
    if (!t2 || !t3) throw new Error("LineJoints V10 identity fixture is incomplete.");
    identity.set("t2", { ...t2, entityId: t3.entityId });
    identity.set("t3", { ...t3, entityId: t2.entityId });
    const drifted = { ...input.snapshot, sourceRuntimeIdentity: identity };
    expect(studioPreviewInitialEditRuntimeAuthorityV1(drifted)).toBeNull();
    expect(compileLineJoints({ ...input, snapshot: drifted })).toMatchObject({
      issue: { code: "target-edit-unsupported" },
      kind: "unsupported",
    });
  });
});

describe("compileStudioPreviewTemporalRebaseV1 WriteStuff V12", () => {
  function compileWriteStuff(input: Awaited<ReturnType<typeof writeStuffInput>>) {
    return compileStudioPreviewTemporalRebaseV1({
      frame: FRAME,
      proposedState: input.proposedState,
      snapshot: input.snapshot,
      sourceRevisionHash: WORKING_REVISION,
    });
  }

  it("grants one synthetic source anchor only to the exact example_tex root", async () => {
    const input = await writeStuffInput("position");
    expect(input.authority.profile).toBe("write-stuff-v12");
    expect(input.authority.baseCenter.x).toBeCloseTo(320, 10);
    expect(input.authority.baseCenter.y).toBeCloseTo(220.05966224170555, 10);
    expect(input.authority).toMatchObject({
      duration: 4,
      lifetime: { end: 4, start: 0 },
      relativeScale: 1,
      runtimeEntityId: input.snapshot.snapshot.scene.entities[32]?.id,
      studioEntityId: input.targetEntityId,
      studioSceneId: WRITE_STUFF_SCENE_ID,
    });
    expect(studioPreviewSyntheticInitialEditAnchorV1(input.snapshot)).toBe(0);
    const interactionAuthority = studioPreviewInteractionAuthorityV1(input.snapshot);
    expect(interactionAuthority).toEqual({
      kind: "interactive",
      nestedGroupEntityIds: [
        input.snapshot.snapshot.scene.entities[1]?.id,
        input.snapshot.snapshot.scene.entities[32]?.id,
      ],
    });
    expect(
      studioPreviewInteractionEntityIdsV1(
        input.snapshot.sourceRuntimeIdentity,
        interactionAuthority,
        input.snapshot.snapshot.scene.entities,
      ),
    ).toEqual([input.snapshot.snapshot.scene.entities[1]?.id, input.snapshot.snapshot.scene.entities[32]?.id]);
  });

  it("rebases move_to(1.25, -0.5) and scale(0.5) onto the logical MathTex root only", async () => {
    const input = await writeStuffInput();
    const importedScene = input.snapshot.snapshot.scene;
    const result = await compileStudioPreviewSceneV1({
      frame: FRAME,
      proposedState: input.proposedState,
      snapshot: input.snapshot,
      workingRevision: WORKING_REVISION,
      workspaceKey: "demo/example_scenes/basic.py/WriteStuff",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    const scene = result.scene.bundle.scene;
    expect(scene.animationChannels).toBe(importedScene.animationChannels);
    expect(scene.entities[0]).toBe(importedScene.entities[0]);
    expect(scene.entities[1]).toBe(importedScene.entities[1]);
    expect(scene.entities[31]).toBe(importedScene.entities[31]);
    expect(scene.entities[33]).toBe(importedScene.entities[33]);
    expect(scene.entities[32]?.geometry).toBe(importedScene.entities[32]?.geometry);
    expect(scene.entities[32]?.transform).toMatchObject({ m11: 0.5, m12: 0, m21: 0, m22: 0.5, tx: 1.25 });
    expect(scene.entities[32]?.transform.ty).toBeCloseTo(-0.0548926417588273, 12);
    expect(result.scene.interactionEntityIds).toEqual([importedScene.entities[1]?.id, importedScene.entities[32]?.id]);
  });

  it("keeps example_text and any identity/source drift fail closed", async () => {
    const siblingEdit = await writeStuffInput("position", "example_text");
    expect(compileWriteStuff(siblingEdit)).toMatchObject({
      issue: { code: "target-edit-unsupported" },
      kind: "unsupported",
    });

    const input = await writeStuffInput("position");
    const identity = new Map(input.snapshot.sourceRuntimeIdentity);
    const exampleText = identity.get("example_text");
    const exampleTex = identity.get("example_tex");
    if (!exampleText || !exampleTex) throw new Error("WriteStuff V12 identity fixture is incomplete.");
    identity.set("example_tex", { ...exampleTex, entityId: exampleText.entityId });
    const drifted = { ...input.snapshot, sourceRuntimeIdentity: identity };
    expect(studioPreviewInitialEditRuntimeAuthorityV1(drifted)).toBeNull();
    expect(compileWriteStuff({ ...input, snapshot: drifted })).toMatchObject({
      issue: { code: "identity-unverified" },
      kind: "unsupported",
    });
  });
});
