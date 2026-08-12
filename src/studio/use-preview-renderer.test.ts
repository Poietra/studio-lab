import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { lowerFastManimRuntimeTraceProducerJsonV1 } from "../../server/fast-manim-runtime-trace-lowering";
import { lowerVerifiedFastManimRuntimeTraceV2 } from "../../server/fast-manim-runtime-trace-v2-lowering";
import {
  runtimeTraceFixture,
  runtimeTraceRequestFixture,
  trustedRuntimeTraceProducer,
} from "../../server/test-fixtures/fast-manim-runtime-trace-fixture";
import { fastManimRuntimeTraceV2Fixture } from "../../server/test-fixtures/fast-manim-runtime-trace-v2-fixture";
import { mixedDynamic2dSnapshotBundleFixtureV7 } from "../../server/test-fixtures/fast-manim-snapshot-bundle-fixture";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "../engine/contracts";
import { canonicalJsonV1, digestFastManimSnapshotBundleInBrowserV1 } from "../engine/fast-manim-snapshot-digest";
import { type MathTexOutlineResponseV1, mathTexOutlineResponseV1Schema } from "../engine/mathtex-outline";
import type { MoveSceneEntityCompiler, MoveSceneEntityWireCommandV1 } from "../engine/scene-authoring";
import { createSceneIrDeltaV1 } from "../engine/scene-delta";
import type { SceneEntityV1 } from "../engine/scene-ir";
import { importManimScene } from "../render-pipeline/source-import";
import { createInspectorEntityEditProgram, createStudioEntitiesProgram } from "./authoring-commands";
import { canonicalEditorWorkingRevision } from "./editor-revision-policy";
import { evaluateWorkingState, programRecord, sampleProposedState } from "./evaluator";
import {
  type ProgramRecord,
  type ProposedState,
  type RuntimeSceneState,
  STUDIO_STATE_VERSION,
  type WorkingState,
} from "./model";
import { EDIT_OPERATION_VERSION } from "./operations";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSnapshotProviderV1,
  type StudioPreviewSourceRuntimeIdentityV1,
  type StudioPreviewSourceRuntimeMappingV1,
  type StudioVerifiedPreviewSnapshotV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";
import { createMathTexFixturePreviewSnapshotProviderV1 } from "./preview-snapshot-provider.fixture";
import { projectRuntimeSceneToSourceTimeline } from "./source-timeline";
import {
  createDirectManipulationPositionProgram,
  createDirectManipulationResizeProgram,
  createDirectManipulationScaleProgram,
} from "./suggestion-program";
import {
  claimStudioPreviewCanvasV1,
  compileStudioPreviewSceneV1,
  digestStudioPreviewSceneRevisionV1,
  projectStudioPreviewRuntimeTraceOpaqueSelectionEntities,
  projectStudioPreviewRuntimeTraceTerminalEntity,
  projectStudioPreviewRuntimeTraceTerminalValidationScene,
  resolveStudioPreviewRuntimeTraceTerminalUiState,
  type StudioPreviewSnapshotMetadataStateV1,
  studioPreviewEditedV9SampleFallbackV1,
  studioPreviewHostReadyForSceneUpdateV1,
  studioPreviewInteractionAuthority,
  studioPreviewInteractionEntityIdsV1,
  studioPreviewRuntimeTraceOpeningSelectionProfileV2,
  studioPreviewRuntimeTraceTerminalAnchorIsExact,
  studioPreviewRuntimeTraceTerminalEditSeed,
  studioPreviewRuntimeTraceTerminalProgramIsAuthorized,
  studioPreviewRuntimeTraceTerminalProgramSet,
  studioPreviewRuntimeTraceUpdatersSelectionProfileV1,
  studioPreviewSnapshotMetadataForWorkspaceV1,
} from "./use-preview-renderer";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const MIXED_V7_FRAME = { height: 8, width: 14.222222222222221 } as const;

function compiledMathTexResponse(
  digests: Readonly<{ content?: string; font?: string; toolchain?: string }> = {},
): MathTexOutlineResponseV1 {
  const points = [
    { x: -1, y: -0.5 },
    { x: 1, y: -0.5 },
    { x: 1, y: 0.5 },
    { x: -1, y: 0.5 },
    { x: -1, y: -0.5 },
  ];
  return mathTexOutlineResponseV1Schema.parse({
    result: {
      bounds: { bottom: -0.5, left: -1, right: 1, top: 0.5 },
      contentDigest: digests.content ?? HASH_A,
      fillRule: "nonzero",
      fontDigest: digests.font ?? HASH_B,
      kind: "compiled",
      path: {
        subpaths: [
          {
            closed: true,
            segments: points.slice(1).map((end, index) => {
              const start = points[index];
              if (!start) throw new Error("MathTex test path is malformed.");
              return {
                control1: { x: start.x + (end.x - start.x) / 3, y: start.y + (end.y - start.y) / 3 },
                control2: { x: start.x + ((end.x - start.x) * 2) / 3, y: start.y + ((end.y - start.y) * 2) / 3 },
                end,
              };
            }),
            start: points[0],
          },
        ],
      },
      toolchainDigest: digests.toolchain ?? HASH_C,
    },
    schema: "poietra.mathtex-outline-response",
    version: 1,
  });
}

async function compilablePreviewInput() {
  const fixtureUrl = new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Readonly<{ assets: unknown; scene: unknown }>;
  const base = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
  const runtimeEntity = base.scene.entities.find(({ id }) => id === "earlier");
  if (!runtimeEntity) throw new Error("preview fixture entity is missing");
  const snapshotBundle = await parseVerifiedSceneIrBundleV1({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [],
      entities: [runtimeEntity],
      requiredCapabilities: ["shape-primitives"],
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: HASH_B,
        snapshotHash: HASH_C,
        snapshotVersion: 1,
        sourceHash: HASH_A,
      },
    },
  });
  const evaluatedScene: RuntimeSceneState = {
    constraintGraph: { constraints: [] },
    duration: 2,
    eventTrack: { events: [] },
    objectGraph: {
      entities: {
        "source:circle": {
          geometry: {
            dimensions: { kind: "known", value: { radius: 1 } },
            position: { kind: "known", value: { x: 320, y: 180 } },
            scale: { kind: "known", value: 1 },
            style: { kind: "known", value: {} },
          },
          id: "source:circle",
          lifetime: [{ end: 2, start: 0 }],
          provisional: false,
          sourceIdentity: { kind: "known", value: "circle" },
          type: "Circle",
        },
      },
      lineage: [],
    },
    propertyChannels: {},
    provenanceGraph: { records: [] },
    sceneId: "studio:circle-scene",
    version: 1,
  };
  const workingState: WorkingState = {
    appliedPrograms: [],
    editorContext: {
      activeSceneId: evaluatedScene.sceneId,
      playhead: 0.5,
      selection: ["source:circle"],
      version: STUDIO_STATE_VERSION,
      viewport: { height: 360, width: 640 },
    },
    runtimeSceneState: evaluatedScene,
    sourceSnapshot: {
      configId: "test",
      hash: `sha256:${HASH_A}`,
      sourceId: "scene.py",
      version: STUDIO_STATE_VERSION,
    },
    stagedPrograms: [],
    staticSemanticState: {
      entities: [
        {
          runtimeIdentities: { kind: "known", value: ["source:circle"] },
          sourceIdentity: "circle",
          type: { kind: "known", value: "Circle" },
        },
      ],
      unknowns: [],
      version: STUDIO_STATE_VERSION,
    },
    version: STUDIO_STATE_VERSION,
  };
  const proposedState = evaluateWorkingState(workingState);
  const context = {
    projectId: "project-a",
    sceneName: "CircleScene",
    sourceDuration: 2,
    sourceHash: HASH_A,
    sourcePath: "scene.py",
    workingRevision: "pristine",
  } as const;
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    assetPayloads: [],
    correlation: {
      assetsManifestDigest: snapshotBundle.assets.manifestDigest,
      context,
      engineRevisionHash: HASH_C,
      sceneDuration: 2,
      sceneId: snapshotBundle.scene.sceneId,
      serverPublicationRevision: 1,
    },
    duration: 2,
    sceneId: snapshotBundle.scene.sceneId,
    snapshot: snapshotBundle,
    sourceLabel: "verified test snapshot",
    sourceRuntimeIdentity: new Map([
      ["circle", { bindingId: "binding:circle", entityId: "earlier", sourceName: "circle" }],
    ]),
  };
  return { context, proposedState, snapshot };
}

function withAppliedRectangle(proposedState: ProposedState, x = 400): ProposedState {
  const entityId = "tx:create-rectangle/entity:rectangle";
  const operation = {
    dependsOn: [],
    entity: {
      dimensions: { height: 2, width: 3 },
      id: entityId,
      lifetime: { end: null, start: 0 },
      type: "Rectangle",
    },
    id: "tx:create-rectangle/operation:create",
    interval: { end: 0, start: 0 },
    kind: "CreateEntity",
    provenance: { evidence: ["test applied creation"], origin: "fixture" },
  } as const;
  const positionOperation = {
    dependsOn: [operation.id],
    entityId,
    id: "tx:create-rectangle/operation:position",
    interval: { end: 0, start: 0 },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["test applied placement"], origin: "fixture" },
    value: { x, y: 180 },
  } as const;
  const record: ProgramRecord = {
    program: {
      anchor: {
        capturedPlayhead: 0,
        evidence: ["captured-playhead:0.000"],
        resolvedSeconds: 0,
        source: { kind: "playhead", referenceSeconds: 0 },
      },
      intentCount: 1,
      loweringStatus: "illustrative",
      operations: [operation, positionOperation],
      provenance: { evidence: ["test applied creation"], origin: "fixture" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id, positionOperation.id] },
      transactionId: "create-rectangle",
      version: EDIT_OPERATION_VERSION,
    },
    validation: { issues: [], status: "valid" },
  };
  return {
    ...proposedState,
    evaluatedScene: {
      ...proposedState.evaluatedScene,
      objectGraph: {
        ...proposedState.evaluatedScene.objectGraph,
        entities: {
          ...proposedState.evaluatedScene.objectGraph.entities,
          [entityId]: {
            geometry: {
              dimensions: { kind: "known", value: { height: 2, width: 3 } },
              position: { kind: "known", value: { x, y: 180 } },
              scale: { kind: "known", value: 1 },
              style: { kind: "known", value: {} },
            },
            id: entityId,
            lifetime: [{ end: 2, start: 0 }],
            provisional: false,
            sourceIdentity: { evidence: [operation.id], kind: "unknown", reason: "Studio-created" },
            transactionId: "create-rectangle",
            type: "Rectangle",
          },
        },
      },
    },
    programs: [record],
  };
}

async function linePreviewInput() {
  const base = await compilablePreviewInput();
  const circle = base.snapshot.snapshot.scene.entities[0];
  if (!circle) throw new Error("preview fixture entity is missing");
  const unsigned = await parseVerifiedSceneIrBundleV1({
    assets: base.snapshot.snapshot.assets,
    scene: {
      ...base.snapshot.snapshot.scene,
      entities: [
        {
          ...circle,
          appearance: {
            fill: null,
            kind: "vector",
            opacity: 1,
            stroke: {
              cap: "butt",
              color: { alpha: 1, blue: 1, green: 1, red: 1 },
              join: "miter",
              miterLimit: 10,
              widthWorld: 0.04,
            },
          },
          geometry: { end: { x: 2, y: 0 }, kind: "line", start: { x: -2, y: 0 } },
          id: "runtime-line",
        },
      ],
      source: { ...base.snapshot.snapshot.scene.source, snapshotHash: "0".repeat(64) },
    },
  });
  const revision = await digestFastManimSnapshotBundleInBrowserV1(unsigned);
  const snapshotBundle = await parseVerifiedSceneIrBundleV1({
    ...unsigned,
    scene: { ...unsigned.scene, source: { ...unsigned.scene.source, snapshotHash: revision } },
  });
  const imported = base.proposedState.evaluatedScene.objectGraph.entities["source:circle"];
  if (!imported) throw new Error("Studio fixture entity is missing");
  return {
    ...base,
    proposedState: {
      ...base.proposedState,
      evaluatedScene: {
        ...base.proposedState.evaluatedScene,
        objectGraph: {
          ...base.proposedState.evaluatedScene.objectGraph,
          entities: {
            "source:line": {
              ...imported,
              id: "source:line",
              sourceIdentity: { kind: "known" as const, value: "line" },
              type: "Line",
            },
          },
        },
      },
    },
    snapshot: {
      ...base.snapshot,
      correlation: { ...base.snapshot.correlation, engineRevisionHash: revision },
      snapshot: snapshotBundle,
      sourceRuntimeIdentity: new Map([
        ["line", { bindingId: "binding:line", entityId: "runtime-line", sourceName: "line" }],
      ]),
    },
  };
}

async function editedStaticRootPreviewInput(
  input: Readonly<{
    capturedPlayhead?: number;
    origin?: "direct-manipulation" | "studio-default";
    target?: Readonly<{ x: number; y: number }>;
  }> = {},
) {
  const base = await compilablePreviewInput();
  const capturedPlayhead = input.capturedPlayhead ?? 0;
  const origin = input.origin ?? "direct-manipulation";
  const target = input.target ?? { x: 384, y: 144 };
  const context = base.snapshot.correlation.context;
  const sceneId = `${context.sourcePath}#${context.sceneName}`;
  const workingBase: WorkingState = {
    ...base.proposedState.base,
    editorContext: {
      ...base.proposedState.base.editorContext,
      activeSceneId: sceneId,
      playhead: capturedPlayhead,
    },
    runtimeSceneState: { ...base.proposedState.base.runtimeSceneState, sceneId },
  };
  const validation =
    origin === "studio-default"
      ? createInspectorEntityEditProgram({
          capturedPlayhead,
          edits: { position: target },
          entityId: "source:circle",
          from: { position: { x: 320, y: 180 }, scale: 1 },
          scene: workingBase.runtimeSceneState,
          transactionId: "inspector-move-imported-root",
        })
      : createDirectManipulationPositionProgram({
          capturedPlayhead,
          delta: { x: target.x - 320, y: target.y - 180 },
          positions: { "source:circle": { x: 320, y: 180 } },
          scene: workingBase.runtimeSceneState,
          start: capturedPlayhead,
          targetEntityIds: ["source:circle"],
          transactionId: "move-imported-root",
        });
  if (validation.kind !== "valid") {
    throw new Error(`Imported root move fixture is invalid: ${JSON.stringify(validation.issues)}`);
  }
  const record = programRecord(validation.program, validation);
  return {
    ...base,
    operationId: validation.program.operations[0]?.id,
    programRecord: record,
    proposedState: evaluateWorkingState({
      ...workingBase,
      appliedPrograms: [record],
    }),
    workingRevision: canonicalEditorWorkingRevision({
      appliedPrograms: [record],
      draftProgram: null,
      editingAppliedProgram: null,
      redoPrograms: [],
    }),
    workspaceKey: studioPreviewWorkspaceKeyV1(context),
  };
}

function recordingMoveCompiler(calls: MoveSceneEntityWireCommandV1[]): MoveSceneEntityCompiler {
  return async (bundle, command) => {
    calls.push(command);
    const unmappedEntity = bundle.scene.entities[0];
    return await parseVerifiedSceneIrBundleV1({
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: [
          ...bundle.scene.entities,
          ...(unmappedEntity
            ? [{ ...unmappedEntity, id: "runtime-unmapped", sceneOrder: unmappedEntity.sceneOrder + 1 }]
            : []),
        ],
      },
    });
  };
}

async function importedMathTexPreviewInput() {
  const base = await compilablePreviewInput();
  const runtimeEntity = base.snapshot.snapshot.scene.entities[0];
  const outline = compiledMathTexResponse().result;
  const imported = importManimScene(
    `from manim import *

class MathTexScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        # poietra:position {"kind":"absolute","value":{"x":400,"y":220},"variable":"equation","version":1}
        equation.move_to((2, -1, 0))
        # poietra:scale {"kind":"exact","value":1.5,"variable":"equation","version":1}
        equation.scale(1.5)
        # poietra:anchor 0.000
        self.wait(2)
`,
    "scene.py",
    "MathTexScene",
    { height: 9, width: 16 },
  );
  if (!runtimeEntity || outline.kind !== "compiled" || !imported) {
    throw new Error("Imported MathTex preview fixture is incomplete");
  }
  const entityId = "source:scene.py#MathTexScene:equation";
  const runtimeEntityId = "runtime:equation";
  const runtimeSceneState = imported.runtimeSceneState;
  const unsigned = await parseVerifiedSceneIrBundleV1({
    assets: base.snapshot.snapshot.assets,
    scene: {
      ...base.snapshot.snapshot.scene,
      entities: [
        {
          ...runtimeEntity,
          appearance: {
            fill: { color: { alpha: 1, blue: 1, green: 1, red: 1 }, rule: "nonzero" },
            kind: "vector",
            opacity: 1,
            stroke: null,
          },
          geometry: { kind: "cubic-path", path: outline.path },
          id: runtimeEntityId,
          transform: { m11: 1.5, m12: 0, m21: 0, m22: 1.5, tx: 2, ty: -1 },
        },
      ],
      requiredCapabilities: ["cubic-path-geometry"],
      source: {
        ...base.snapshot.snapshot.scene.source,
        snapshotHash: "0".repeat(64),
        snapshotVersion: 3,
        sourceHash: imported.sourceHash,
      },
    },
  });
  const revision = await digestFastManimSnapshotBundleInBrowserV1(unsigned);
  const snapshotBundle = await parseVerifiedSceneIrBundleV1({
    ...unsigned,
    scene: { ...unsigned.scene, source: { ...unsigned.scene.source, snapshotHash: revision } },
  });
  const workingState: WorkingState = {
    ...base.proposedState.base,
    appliedPrograms: [],
    editorContext: {
      ...base.proposedState.base.editorContext,
      activeSceneId: runtimeSceneState.sceneId,
    },
    runtimeSceneState,
    sourceSnapshot: {
      ...base.proposedState.base.sourceSnapshot,
      hash: `sha256:${imported.sourceHash}`,
      sourceId: "scene.py",
    },
    stagedPrograms: [],
    staticSemanticState: imported.staticSemanticState,
  };
  const position = createDirectManipulationPositionProgram({
    capturedPlayhead: 0,
    delta: { x: 80, y: -80 },
    positions: { [entityId]: { x: 400, y: 220 } },
    scene: runtimeSceneState,
    start: 0,
    targetEntityIds: [entityId],
    transactionId: "move-imported-mathtex",
  });
  const scale = createDirectManipulationScaleProgram({
    capturedPlayhead: 0,
    interval: { end: 0, start: 0 },
    scales: { [entityId]: { from: 1.5, to: 3 } },
    scene: runtimeSceneState,
    targetEntityIds: [entityId],
    transactionId: "scale-imported-mathtex",
  });
  if (position.kind !== "valid" || scale.kind !== "valid") {
    throw new Error(
      `Imported MathTex edit fixture programs did not validate: ${JSON.stringify([position.issues, scale.issues])}`,
    );
  }
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    ...base.snapshot,
    correlation: {
      ...base.snapshot.correlation,
      context: {
        ...base.snapshot.correlation.context,
        sceneName: "MathTexScene",
        sourceHash: imported.sourceHash,
        sourcePath: "scene.py",
      },
      engineRevisionHash: revision,
    },
    snapshot: snapshotBundle,
    sourceRuntimeIdentity: new Map([
      ["equation", { bindingId: "binding:equation", entityId: runtimeEntityId, sourceName: "equation" }],
    ]),
  };
  return {
    edited: evaluateWorkingState({
      ...workingState,
      appliedPrograms: [programRecord(position.program, position), programRecord(scale.program, scale)],
    }),
    entityId,
    runtimeEntityId,
    snapshot,
    workingState,
  };
}

async function mixedV7EditedMathTexPreviewInput(
  options: Readonly<{
    cameraCenter?: Readonly<{ x: number; y: number }>;
    includeRing?: boolean;
    mathTexTransform?: SceneEntityV1["transform"];
  }> = {},
) {
  const fixture = await importedMathTexPreviewInput();
  const baseStudioMathTex = fixture.workingState.runtimeSceneState.objectGraph.entities[fixture.entityId];
  const editedStudioMathTex = fixture.edited.evaluatedScene.objectGraph.entities[fixture.entityId];
  const importedSource = fixture.snapshot.snapshot.scene.source;
  if (importedSource.kind !== "imported-manim-server-snapshot" || !baseStudioMathTex || !editedStudioMathTex) {
    throw new Error("Mixed V7 MathTex fixture is incomplete.");
  }
  const ringStudioId = "source:scene.py#MathTexScene:ring";
  const particleStudioId = "source:scene.py#MathTexScene:particle";
  const importedCircle = (
    id: string,
    sourceIdentity: string,
  ): RuntimeSceneState["objectGraph"]["entities"][string] => ({
    geometry: {
      dimensions: { kind: "known", value: { radius: 1 } },
      position: { kind: "known", value: { x: 320, y: 180 } },
      scale: { kind: "known", value: 1 },
      style: { kind: "known", value: {} },
    },
    id,
    lifetime: [{ end: 4, start: 0 }],
    provisional: false,
    sourceIdentity: { kind: "known", value: sourceIdentity },
    type: "Circle",
  });
  const ringStudioEntity = importedCircle(ringStudioId, "ring");
  const particleStudioEntity = importedCircle(particleStudioId, "particle");
  const extendScene = (scene: RuntimeSceneState, mathTexEntity: typeof baseStudioMathTex): RuntimeSceneState => ({
    ...scene,
    duration: 4,
    objectGraph: {
      ...scene.objectGraph,
      entities: {
        [fixture.entityId]: { ...mathTexEntity, lifetime: [{ end: 4, start: 0 }] },
        ...(options.includeRing ? { [ringStudioId]: ringStudioEntity } : {}),
        [particleStudioId]: particleStudioEntity,
      },
    },
  });
  const fixtureBundle = await mixedDynamic2dSnapshotBundleFixtureV7({
    frame: MIXED_V7_FRAME,
    projectId: fixture.snapshot.correlation.context.projectId,
    requestId: "mixed-v7-preview-test",
    runtimeConfigHash: importedSource.runtimeConfigHash,
    sceneId: fixture.snapshot.sceneId,
    sceneName: fixture.snapshot.correlation.context.sceneName,
    snapshotVersion: 7,
    sourceHash: importedSource.sourceHash,
    sourcePath: fixture.snapshot.correlation.context.sourcePath,
  });
  const mathTexTransform = options.mathTexTransform;
  const unsigned = {
    ...fixtureBundle,
    scene: {
      ...fixtureBundle.scene,
      camera: options.cameraCenter
        ? {
            ...fixtureBundle.scene.camera,
            view: { ...fixtureBundle.scene.camera.view, center: options.cameraCenter },
          }
        : fixtureBundle.scene.camera,
      entities: mathTexTransform
        ? fixtureBundle.scene.entities.map((entity, index) =>
            index === 0 ? { ...entity, transform: mathTexTransform } : entity,
          )
        : fixtureBundle.scene.entities,
    },
  };
  const snapshotHash = await digestFastManimSnapshotBundleInBrowserV1(unsigned);
  const snapshotBundle = await parseVerifiedSceneIrBundleV1({
    ...unsigned,
    scene: { ...unsigned.scene, source: { ...unsigned.scene.source, snapshotHash } },
  });
  const [mathTexRuntime, ringRuntime, particleRuntime] = snapshotBundle.scene.entities;
  if (!mathTexRuntime || !ringRuntime || !particleRuntime) throw new Error("Mixed V7 runtime fixture is incomplete.");
  return {
    ...fixture,
    edited: {
      ...fixture.edited,
      base: {
        ...fixture.edited.base,
        runtimeSceneState: extendScene(fixture.workingState.runtimeSceneState, baseStudioMathTex),
      },
      evaluatedScene: extendScene(fixture.edited.evaluatedScene, editedStudioMathTex),
    },
    particleStudioId,
    ringStudioId,
    runtimeEntityId: mathTexRuntime.id,
    snapshot: {
      ...fixture.snapshot,
      correlation: {
        ...fixture.snapshot.correlation,
        assetsManifestDigest: snapshotBundle.assets.manifestDigest,
        context: { ...fixture.snapshot.correlation.context, sourceDuration: 4 },
        engineRevisionHash: snapshotHash,
        sceneDuration: 4,
      },
      duration: 4,
      snapshot: snapshotBundle,
      sourceRuntimeIdentity: new Map([
        ["equation", { bindingId: "binding:equation", entityId: mathTexRuntime.id, sourceName: "equation" }],
        ["ring", { bindingId: "binding:ring", entityId: ringRuntime.id, sourceName: "ring" }],
        ["particle", { bindingId: "binding:particle", entityId: particleRuntime.id, sourceName: "particle" }],
      ]),
    } satisfies StudioVerifiedPreviewSnapshotV1,
  };
}

async function warpSquareV9PreviewInput() {
  const [fixtureText, sourceText] = await Promise.all([
    readFile(new URL("../../fixtures/engine-v1/real-warp-square-v9.json", import.meta.url), "utf8"),
    readFile(new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
  ]);
  const fixture = JSON.parse(fixtureText) as Readonly<{ assets: unknown; scene: unknown }>;
  const snapshotBundle = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
  const imported = importManimScene(sourceText, "example_scenes/basic.py", "WarpSquare", MIXED_V7_FRAME);
  const runtimeEntity = snapshotBundle.scene.entities[0];
  const source = snapshotBundle.scene.source;
  if (!imported || !runtimeEntity || source.kind !== "imported-manim-server-snapshot") {
    throw new Error("WarpSquare V9 preview fixture is incomplete.");
  }
  const entityId = "source:example_scenes/basic.py#WarpSquare:square";
  const baseEntity = imported.runtimeSceneState.objectGraph.entities[entityId];
  if (!baseEntity) throw new Error("WarpSquare V9 static import lost its Square.");
  // V9 runtime evidence supplies the exact lifetime/duration that the
  // conservative source importer cannot infer from ApplyPointwiseFunction.
  const runtimeSceneState: RuntimeSceneState = {
    ...imported.runtimeSceneState,
    duration: 4,
    objectGraph: {
      ...imported.runtimeSceneState.objectGraph,
      entities: {
        ...imported.runtimeSceneState.objectGraph.entities,
        [entityId]: { ...baseEntity, lifetime: [{ end: 4, start: 0 }] },
      },
    },
  };
  const workingState: WorkingState = {
    appliedPrograms: [],
    editorContext: {
      activeSceneId: imported.runtimeSceneState.sceneId,
      playhead: 0,
      selection: [entityId],
      version: STUDIO_STATE_VERSION,
      viewport: { height: 360, width: 640 },
    },
    runtimeSceneState,
    sourceSnapshot: {
      configId: "sealed-warp-square-v9",
      hash: `sha256:${source.sourceHash}`,
      sourceId: "example_scenes/basic.py",
      version: STUDIO_STATE_VERSION,
    },
    stagedPrograms: [],
    staticSemanticState: imported.staticSemanticState,
    version: STUDIO_STATE_VERSION,
  };
  const position = createDirectManipulationPositionProgram({
    capturedPlayhead: 0,
    delta: { x: 64, y: -36 },
    positions: { [entityId]: { x: 320, y: 180 } },
    scene: workingState.runtimeSceneState,
    start: 0,
    targetEntityIds: [entityId],
    transactionId: "move-warp-square-at-zero",
  });
  const scale = createDirectManipulationScaleProgram({
    capturedPlayhead: 0,
    interval: { end: 0, start: 0 },
    scales: { [entityId]: { from: 1, to: 1.5 } },
    scene: workingState.runtimeSceneState,
    targetEntityIds: [entityId],
    transactionId: "scale-warp-square-at-zero",
  });
  if (position.kind !== "valid" || scale.kind !== "valid") {
    throw new Error(`WarpSquare V9 transform programs are invalid: ${JSON.stringify([position.issues, scale.issues])}`);
  }
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    assetPayloads: [],
    correlation: {
      assetsManifestDigest: snapshotBundle.assets.manifestDigest,
      context: {
        projectId: "project-a",
        sceneName: "WarpSquare",
        sourceDuration: 4,
        sourceHash: source.sourceHash,
        sourcePath: "example_scenes/basic.py",
        workingRevision: PRISTINE_WORKING_REVISION,
      },
      engineRevisionHash: source.snapshotHash,
      sceneDuration: 4,
      sceneId: snapshotBundle.scene.sceneId,
      serverPublicationRevision: 1,
    },
    duration: 4,
    sceneId: snapshotBundle.scene.sceneId,
    snapshot: snapshotBundle,
    sourceLabel: "example_scenes/basic.py · WarpSquare",
    sourceRuntimeIdentity: new Map([
      ["square", { bindingId: "binding:warp-square", entityId: runtimeEntity.id, sourceName: "square" }],
    ]),
  };
  return {
    edited: evaluateWorkingState({
      ...workingState,
      appliedPrograms: [programRecord(position.program, position), programRecord(scale.program, scale)],
    }),
    snapshot,
  };
}

describe("claimStudioPreviewCanvasV1", () => {
  it("claims a canvas exactly once so StrictMode remounts must mint a fresh element", () => {
    const canvas = {};
    expect(claimStudioPreviewCanvasV1(canvas)).toBe(true);
    // The StrictMode double-invoked effect (and any workspace switch that
    // re-runs the install effect on a kept-alive element) sees the claim fail
    // and requests a new canvas epoch instead of re-transferring the element.
    expect(claimStudioPreviewCanvasV1(canvas)).toBe(false);
    expect(claimStudioPreviewCanvasV1({})).toBe(true);
  });
});

describe("studioPreviewInteractionAuthority", () => {
  it("keeps Runtime Trace preview-only and selects only its two source roots", async () => {
    const { snapshot } = await linePreviewInput();
    const leaf = snapshot.snapshot.scene.entities[0];
    if (!leaf) throw new Error("Expected one imported line fixture entity.");
    const motionRootId = "runtime-trace-motion-root";
    const squareRootId = "runtime-trace-square-root";
    const decimalRootId = "runtime-trace-decimal-root";
    const unverifiedRootId = "runtime-trace-unverified-root";
    const glyphId = "runtime-trace-glyph";
    const group = {
      ...leaf,
      appearance: { kind: "group", opacity: 1 } as const,
      geometry: { kind: "group" } as const,
    };
    const entities: SceneIrBundleV1["scene"]["entities"] = [
      { ...group, id: motionRootId, parentId: null },
      { ...group, id: squareRootId, parentId: motionRootId },
      { ...group, id: decimalRootId, parentId: motionRootId },
      { ...group, id: unverifiedRootId, parentId: motionRootId },
      { ...leaf, id: glyphId, parentId: decimalRootId },
    ];
    const identity = new Map<string, StudioPreviewSourceRuntimeMappingV1>([
      ["square", { bindingId: "binding:square", entityId: squareRootId, sourceName: "square" }],
      ["decimal", { bindingId: "binding:decimal", entityId: decimalRootId, sourceName: "decimal" }],
      ["glyph", { bindingId: "binding:glyph", entityId: glyphId, sourceName: "glyph" }],
      ["spoofed-square", { bindingId: "binding:spoofed", entityId: glyphId, sourceName: "square" }],
    ]);
    const runtimeTrace = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          entities,
          source: {
            kind: "imported-manim-runtime-trace",
            runtimeConfigHash: HASH_A,
            sourceHash: HASH_B,
            traceDigest: HASH_C,
            traceVersion: 1,
          },
        },
      },
      sourceRuntimeIdentity: new Map([...identity].filter(([name]) => name === "square" || name === "decimal")),
    } as StudioVerifiedPreviewSnapshotV1;

    const authority = studioPreviewInteractionAuthority(runtimeTrace);
    expect(authority).toEqual({
      kind: "selection-only",
      reason: "runtime-trace-preview-only",
      verifiedRuntimeEntityIds: [squareRootId, decimalRootId],
    });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority, entities)).toEqual([squareRootId, decimalRootId]);
    expect(
      studioPreviewInteractionEntityIdsV1(
        new Map<string, StudioPreviewSourceRuntimeMappingV1>([
          ["title", { bindingId: "binding:title", entityId: squareRootId, sourceName: "title" }],
          ["basel", { bindingId: "binding:basel", entityId: decimalRootId, sourceName: "basel" }],
        ]),
        authority,
        entities,
      ),
    ).toEqual([squareRootId, decimalRootId]);
    expect(
      studioPreviewInteractionEntityIdsV1(
        new Map<string, StudioPreviewSourceRuntimeMappingV1>([
          ["unverified", { bindingId: "binding:unverified", entityId: unverifiedRootId, sourceName: "unverified" }],
        ]),
        authority,
        entities,
      ),
    ).toEqual([]);
    expect(studioPreviewInteractionEntityIdsV1(identity, authority)).toEqual([]);

    const genericV3Identity = new Map<string, StudioPreviewSourceRuntimeMappingV1>([
      [
        "square",
        {
          bindingId: "binding:generic-square",
          entityId: motionRootId,
          runtimeTraceEvidence: {
            endpoints: {
              initial: {
                center: { x: 0, y: 0 },
                dimensions: { height: 2, width: 2 },
                frameIndex: 0,
                sampleTime: 0,
              },
              terminal: {
                center: { x: 0, y: 0 },
                dimensions: { height: 2, width: 2 },
                frameIndex: 0,
                sampleTime: 0,
              },
            },
            updaterStatus: "none",
          },
          sourceName: "square",
        },
      ],
    ]);
    const genericV3 = {
      ...runtimeTrace,
      snapshot: {
        ...runtimeTrace.snapshot,
        scene: {
          ...runtimeTrace.snapshot.scene,
          source: { ...runtimeTrace.snapshot.scene.source, traceVersion: 3 },
        },
      },
      sourceRuntimeIdentity: genericV3Identity,
    } as StudioVerifiedPreviewSnapshotV1;
    const genericAuthority = studioPreviewInteractionAuthority(genericV3);
    expect(genericAuthority).toEqual({
      kind: "selection-only",
      reason: "runtime-trace-preview-only",
      verifiedRuntimeEntityIds: [motionRootId],
    });
    expect(studioPreviewInteractionEntityIdsV1(genericV3Identity, genericAuthority, entities)).toEqual([motionRootId]);
  });

  it("keeps aggregate MathTex morph identity display-only even if mappings are supplied", async () => {
    const { snapshot } = await linePreviewInput();
    const source = snapshot.snapshot.scene.source;
    if (source.kind !== "imported-manim-server-snapshot") throw new Error("Expected imported snapshot source.");
    const v5 = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: { ...snapshot.snapshot.scene, source: { ...source, snapshotVersion: 5 } },
      },
    } as StudioVerifiedPreviewSnapshotV1;
    const authority = studioPreviewInteractionAuthority(v5);
    expect(authority).toEqual({ kind: "display-only", reason: "aggregate-mathtex-morph-lineage" });
    expect(
      studioPreviewInteractionEntityIdsV1(
        new Map([["equation", { bindingId: "binding:equation", entityId: "runtime-line", sourceName: "equation" }]]),
        authority,
      ),
    ).toEqual([]);
  });

  it("keeps V9 pointwise-function morphs display-only even with complete identity", async () => {
    const { snapshot } = await linePreviewInput();
    const source = snapshot.snapshot.scene.source;
    if (source.kind !== "imported-manim-server-snapshot") throw new Error("Expected imported snapshot source.");
    const identity = new Map<string, StudioPreviewSourceRuntimeMappingV1>([
      ["square", { bindingId: "binding:square", entityId: "runtime-line", sourceName: "square" }],
    ]);
    const v9 = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: { ...snapshot.snapshot.scene, source: { ...source, snapshotVersion: 9 } },
      },
      sourceRuntimeIdentity: identity,
    } as StudioVerifiedPreviewSnapshotV1;
    const authority = studioPreviewInteractionAuthority(v9);
    expect(authority).toEqual({ kind: "display-only", reason: "temporal-rebase-unavailable" });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority)).toEqual([]);
  });

  it("makes only the exact correlated WarpSquare V9 identity interactive", async () => {
    const { snapshot } = await warpSquareV9PreviewInput();
    const runtimeEntityId = snapshot.snapshot.scene.entities[0]?.id;
    if (!runtimeEntityId) throw new Error("WarpSquare V9 has no runtime entity.");

    const authority = studioPreviewInteractionAuthority(snapshot);
    expect(authority).toEqual({ kind: "interactive" });
    expect(studioPreviewInteractionEntityIdsV1(snapshot.sourceRuntimeIdentity, authority)).toEqual([runtimeEntityId]);
    expect(studioPreviewInteractionAuthority({ ...snapshot, sourceRuntimeIdentity: null })).toEqual({
      kind: "display-only",
      reason: "temporal-rebase-unavailable",
    });
    expect(studioPreviewEditedV9SampleFallbackV1(snapshot, "studio-working-v1:warp-square-edit", 0)).toBeNull();
    expect(studioPreviewEditedV9SampleFallbackV1(snapshot, PRISTINE_WORKING_REVISION, 1.5)).toBeNull();
    expect(studioPreviewEditedV9SampleFallbackV1(snapshot, "studio-working-v1:warp-square-edit", 0.0001)).toEqual({
      detail: "A local WarpSquare edit is truthful only at t=0 until producer-backed reimport completes.",
      phase: "fallback",
      reason: "snapshot-uncorrelated",
    });
    expect(studioPreviewEditedV9SampleFallbackV1(snapshot, "studio-working-v1:warp-square-edit", 1.5)).toEqual({
      detail: "A local WarpSquare edit is truthful only at t=0 until producer-backed reimport completes.",
      phase: "fallback",
      reason: "snapshot-uncorrelated",
    });
  });

  it("admits only the three drawable V10 leaves for selection while requiring the complete group identity", async () => {
    const { proposedState, snapshot } = await linePreviewInput();
    const source = snapshot.snapshot.scene.source;
    const leaf = snapshot.snapshot.scene.entities[0];
    if (source.kind !== "imported-manim-server-snapshot" || !leaf) {
      throw new Error("Expected one imported line fixture entity.");
    }
    const groupId = "runtime-group";
    const leafIds = ["runtime-t1", "runtime-t2", "runtime-t3"] as const;
    const entities: SceneIrBundleV1["scene"]["entities"] = [
      {
        ...leaf,
        appearance: { kind: "group", opacity: 1 },
        geometry: { kind: "group" },
        id: groupId,
        parentId: null,
      },
      ...leafIds.map((id) => ({ ...leaf, id, parentId: groupId })),
    ];
    const identity = new Map<string, StudioPreviewSourceRuntimeMappingV1>([
      ["grp", { bindingId: "binding:grp", entityId: groupId, sourceName: "grp" }],
      ...leafIds.map(
        (entityId, index) =>
          [`t${index + 1}`, { bindingId: `binding:t${index + 1}`, entityId, sourceName: `t${index + 1}` }] as const,
      ),
    ]);
    const v10 = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          entities,
          source: { ...source, snapshotVersion: 10 },
        },
      },
      sourceRuntimeIdentity: identity,
    } as StudioVerifiedPreviewSnapshotV1;

    const authority = studioPreviewInteractionAuthority(v10);
    expect(authority).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority)).toEqual([]);
    expect(studioPreviewInteractionEntityIdsV1(identity, authority, entities)).toEqual(leafIds);
    expect(
      studioPreviewInteractionAuthority({
        ...v10,
        sourceRuntimeIdentity: new Map([...identity].filter(([sourceName]) => sourceName !== "grp")),
      }),
    ).toEqual({ kind: "display-only", reason: "source-runtime-identity-unverified" });

    const compiled = await compileStudioPreviewSceneV1({
      frame: { height: 8, width: 14.222222222222221 },
      proposedState,
      snapshot: v10,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: "project-a/example_scenes/basic.py/LineJoints",
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled") throw new Error(compiled.error);
    expect(compiled.scene.interactionEntityIds).toEqual(leafIds);
  });

  it("admits all five drawable V11 leaves for selection but never source mutation", async () => {
    const { proposedState, snapshot } = await linePreviewInput();
    const source = snapshot.snapshot.scene.source;
    const leaf = snapshot.snapshot.scene.entities[0];
    if (source.kind !== "imported-manim-server-snapshot" || !leaf) {
      throw new Error("Expected one imported line fixture entity.");
    }
    const groupId = "runtime-shapes";
    const leafIds = ["runtime-triangle", "runtime-square", "runtime-circle", "runtime-pentagon", "runtime-pi"] as const;
    const sourceNames = ["triangle", "square", "circle", "pentagon", "pi"] as const;
    const entities: SceneIrBundleV1["scene"]["entities"] = [
      {
        ...leaf,
        appearance: { kind: "group", opacity: 1 },
        geometry: { kind: "group" },
        id: groupId,
        parentId: null,
      },
      ...leafIds.map((id) => ({ ...leaf, id, parentId: groupId })),
    ];
    const identity = new Map<string, StudioPreviewSourceRuntimeMappingV1>([
      ["shapes", { bindingId: "binding:shapes", entityId: groupId, sourceName: "shapes" }],
      ...leafIds.map(
        (entityId, index) =>
          [
            sourceNames[index]!,
            { bindingId: `binding:${sourceNames[index]}`, entityId, sourceName: sourceNames[index]! },
          ] as const,
      ),
    ]);
    const v11 = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          entities,
          source: { ...source, snapshotVersion: 11 },
        },
      },
      sourceRuntimeIdentity: identity,
    } as StudioVerifiedPreviewSnapshotV1;

    const authority = studioPreviewInteractionAuthority(v11);
    expect(authority).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority, entities)).toEqual(leafIds);
    for (const missingName of ["shapes", ...sourceNames]) {
      expect(
        studioPreviewInteractionAuthority({
          ...v11,
          sourceRuntimeIdentity: new Map([...identity].filter(([sourceName]) => sourceName !== missingName)),
        }),
      ).toEqual({ kind: "display-only", reason: "source-runtime-identity-unverified" });
    }

    const compiled = await compileStudioPreviewSceneV1({
      frame: { height: 8, width: 14.222222222222221 },
      proposedState,
      snapshot: v11,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: "project-a/example_scenes/basic.py/SpiralInExample",
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled") throw new Error(compiled.error);
    expect(compiled.scene.interactionEntityIds).toEqual(leafIds);
  });

  it("selects only the two source-bound nested V12 Tex roots", async () => {
    const { proposedState, snapshot } = await linePreviewInput();
    const source = snapshot.snapshot.scene.source;
    const leaf = snapshot.snapshot.scene.entities[0];
    if (source.kind !== "imported-manim-server-snapshot" || !leaf) {
      throw new Error("Expected one imported line fixture entity.");
    }
    const groupId = "runtime-write-stuff";
    const textRootId = "runtime-example-text";
    const texRootId = "runtime-example-tex";
    const groupEntity = {
      ...leaf,
      appearance: { kind: "group", opacity: 1 } as const,
      geometry: { kind: "group" } as const,
      id: groupId,
      parentId: null,
      sceneOrder: 0,
    };
    const textRoot = { ...groupEntity, id: textRootId, parentId: groupId, sceneOrder: 1 };
    const textRoles = Array.from({ length: 30 }, (_, index) => ({
      ...leaf,
      id: `runtime-text-role-${index}`,
      parentId: textRootId,
      sceneOrder: index + 2,
    }));
    const texRoot = { ...groupEntity, id: texRootId, parentId: groupId, sceneOrder: 32 };
    const texRoles = Array.from({ length: 28 }, (_, index) => ({
      ...leaf,
      id: `runtime-tex-role-${index}`,
      parentId: texRootId,
      sceneOrder: index + 33,
    }));
    const entities: SceneIrBundleV1["scene"]["entities"] = [groupEntity, textRoot, ...textRoles, texRoot, ...texRoles];
    const identity = new Map<string, StudioPreviewSourceRuntimeMappingV1>([
      ["group", { bindingId: "binding:group", entityId: groupId, sourceName: "group" }],
      ["example_text", { bindingId: "binding:example-text", entityId: textRootId, sourceName: "example_text" }],
      ["example_tex", { bindingId: "binding:example-tex", entityId: texRootId, sourceName: "example_tex" }],
    ]);
    const v12 = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          entities,
          source: { ...source, snapshotVersion: 12 },
        },
      },
      sourceRuntimeIdentity: identity,
    } as StudioVerifiedPreviewSnapshotV1;

    const authority = studioPreviewInteractionAuthority(v12);
    expect(authority).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority, entities)).toEqual([textRootId, texRootId]);
    for (const missingName of ["group", "example_text", "example_tex"]) {
      expect(
        studioPreviewInteractionAuthority({
          ...v12,
          sourceRuntimeIdentity: new Map([...identity].filter(([sourceName]) => sourceName !== missingName)),
        }),
      ).toEqual({ kind: "display-only", reason: "source-runtime-identity-unverified" });
    }

    const compiled = await compileStudioPreviewSceneV1({
      frame: { height: 8, width: 14.222222222222221 },
      proposedState,
      snapshot: v12,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: "project-a/example_scenes/basic.py/WriteStuff",
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled") throw new Error(compiled.error);
    expect(compiled.scene.interactionEntityIds).toEqual([textRootId, texRootId]);
  });

  it("keeps V6 partially interactive but requires complete V7/V8 identity authority", async () => {
    const { snapshot } = await linePreviewInput();
    const source = snapshot.snapshot.scene.source;
    if (source.kind !== "imported-manim-server-snapshot") throw new Error("Expected imported snapshot source.");
    const partialIdentity = new Map<string, StudioPreviewSourceRuntimeMappingV1>([
      ["line", { bindingId: "binding:line", entityId: "runtime-line", sourceName: "line" }],
    ]);
    const fullIdentity = new Map<string, StudioPreviewSourceRuntimeMappingV1>([
      ...partialIdentity,
      ["polygon", { bindingId: "binding:polygon", entityId: "runtime-polygon", sourceName: "polygon" }],
    ]);
    const displayOnly = { kind: "display-only", reason: "source-runtime-identity-unverified" } as const;
    expect(studioPreviewInteractionAuthority({ ...snapshot, sourceRuntimeIdentity: null })).toEqual({
      kind: "interactive",
    });
    for (const { expectedAuthority, expectedEntityIds, identity } of [
      { expectedAuthority: displayOnly, expectedEntityIds: [], identity: null },
      { expectedAuthority: displayOnly, expectedEntityIds: [], identity: new Map() },
      {
        expectedAuthority: { kind: "interactive" } as const,
        expectedEntityIds: ["runtime-line"],
        identity: partialIdentity,
      },
      {
        expectedAuthority: { kind: "interactive" } as const,
        expectedEntityIds: ["runtime-line", "runtime-polygon"],
        identity: fullIdentity,
      },
    ]) {
      const v6 = {
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          scene: { ...snapshot.snapshot.scene, source: { ...source, snapshotVersion: 6 } },
        },
        sourceRuntimeIdentity: identity,
      } as StudioVerifiedPreviewSnapshotV1;
      const authority = studioPreviewInteractionAuthority(v6);
      expect(authority).toEqual(expectedAuthority);
      expect(studioPreviewInteractionEntityIdsV1(identity, authority)).toEqual(expectedEntityIds);
    }

    for (const snapshotVersion of [7, 8] as const) {
      const identityBoundSnapshot = (identity: StudioPreviewSourceRuntimeIdentityV1 | null) =>
        ({
          ...snapshot,
          snapshot: {
            ...snapshot.snapshot,
            scene: { ...snapshot.snapshot.scene, source: { ...source, snapshotVersion } },
          },
          sourceRuntimeIdentity: identity,
        }) as StudioVerifiedPreviewSnapshotV1;
      expect(studioPreviewInteractionAuthority(identityBoundSnapshot(null))).toEqual(displayOnly);
      expect(studioPreviewInteractionAuthority(identityBoundSnapshot(new Map()))).toEqual(displayOnly);
      expect(studioPreviewInteractionAuthority(identityBoundSnapshot(partialIdentity))).toEqual({
        kind: "interactive",
      });
      expect(studioPreviewInteractionAuthority(identityBoundSnapshot(fullIdentity))).toEqual(displayOnly);
    }
  });
});

describe("compileStudioPreviewSceneV1", () => {
  it("passes the exact Updaters trace through with one bounded terminal edit target", async () => {
    const base = await compilablePreviewInput();
    const trace = runtimeTraceFixture();
    const bundle = await lowerFastManimRuntimeTraceProducerJsonV1(
      canonicalJsonV1(trace),
      runtimeTraceRequestFixture(),
      trustedRuntimeTraceProducer(trace),
    );
    const runtimeSource = bundle.scene.source;
    if (runtimeSource.kind !== "imported-manim-runtime-trace") {
      throw new Error("Runtime Trace lowering lost its source evidence.");
    }
    const runtimeState = {
      ...base.proposedState.evaluatedScene,
      duration: bundle.scene.duration,
    };
    const proposedState: ProposedState = {
      ...base.proposedState,
      base: { ...base.proposedState.base, runtimeSceneState: runtimeState },
      evaluatedScene: runtimeState,
    };
    const context = {
      projectId: trace.projectId,
      sceneName: trace.sceneName,
      sourceDuration: bundle.scene.duration,
      sourceHash: trace.sourceHash,
      sourcePath: trace.sourcePath,
      workingRevision: PRISTINE_WORKING_REVISION,
    } as const;
    const snapshot: StudioVerifiedPreviewSnapshotV1 = {
      assetPayloads: [],
      correlation: {
        assetsManifestDigest: bundle.assets.manifestDigest,
        context,
        engineRevisionHash: runtimeSource.traceDigest,
        sceneDuration: bundle.scene.duration,
        sceneId: bundle.scene.sceneId,
        serverPublicationRevision: null,
      },
      duration: bundle.scene.duration,
      sceneId: bundle.scene.sceneId,
      snapshot: bundle,
      sourceLabel: "verified Runtime Trace",
      sourceRuntimeIdentity: new Map(
        trace.roots.map((root) => [
          root.binding.name,
          { bindingId: root.binding.id, entityId: root.id, sourceName: root.binding.name },
        ]),
      ),
    };

    const result = await compileStudioPreviewSceneV1({
      frame: { height: 8, width: 14.222222222222221 },
      proposedState,
      snapshot,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: "demo/example_scenes/basic.py/UpdatersExample",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle).toBe(bundle);
    expect(result.scene.interactionEntityIds).toEqual(trace.roots.map(({ id }) => id));
    expect(studioPreviewInteractionAuthority(snapshot)).toEqual({
      editableRuntimeEntityId: trace.roots[0]?.id,
      kind: "bounded-interactive",
      reason: "runtime-trace-terminal-edit",
      sourceAnchor: 5,
      verifiedRuntimeEntityIds: trace.roots.map(({ id }) => id),
    });
    const seed = studioPreviewRuntimeTraceTerminalEditSeed(snapshot);
    expect(seed).toMatchObject({
      capabilities: { uniformScale: true },
      controlLabel: "Square terminal edit at 5.00s",
      duration: 6,
      renderProof: { profile: "updaters-terminal-v1", sourceAnchor: 5 },
      runtimeEntityId: trace.roots[0]?.id,
      sourceAnchor: 5,
      studioEntityId: "source:example_scenes/basic.py#UpdatersExample:square",
      studioSceneId: "example_scenes/basic.py#UpdatersExample",
      uniformScaleBasis: { relativeScale: 1, sourceDimensions: { height: 2, width: 2 } },
    });
    expect(seed).not.toHaveProperty("profile");

    expect(
      studioPreviewRuntimeTraceTerminalEditSeed({
        ...snapshot,
        correlation: {
          ...snapshot.correlation,
          context: { ...snapshot.correlation.context, workingRevision: "stale-runtime-trace" },
        },
      }),
    ).toBeNull();
    expect(
      studioPreviewRuntimeTraceTerminalEditSeed({
        ...snapshot,
        sourceRuntimeIdentity: new Map(
          [...snapshot.sourceRuntimeIdentity!.entries()].filter(([sourceName]) => sourceName === "decimal"),
        ),
      }),
    ).toBeNull();

    const source = await readFile(
      new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
      "utf8",
    );
    const imported = importManimScene(source, "example_scenes/basic.py", "UpdatersExample", {
      height: 8,
      width: 14.222222222222221,
    });
    if (!seed || !seed.capabilities.uniformScale || !seed.uniformScaleBasis || !imported) {
      throw new Error("Expected exact UpdatersExample Studio authority.");
    }
    expect(Object.values(imported.sourceVariables)).toEqual(["square"]);
    const authority = { ...seed, baseCenter: { x: 320, y: 67.5 } } as const;
    expect(authority).toMatchObject({
      capabilities: { uniformScale: true },
      controlLabel: "Square terminal edit at 5.00s",
      renderProof: { profile: "updaters-terminal-v1", sourceAnchor: 5 },
    });
    const square = imported.runtimeSceneState.objectGraph.entities[authority.studioEntityId];
    if (!square?.geometry) throw new Error("Expected the source-bound Square.");
    const projected = projectStudioPreviewRuntimeTraceTerminalEntity(
      [
        {
          ...square,
          geometry: square.geometry,
          opacity: 1,
          position: { x: 320, y: 180 },
          present: true,
          scale: 1,
        },
      ],
      authority,
    );
    expect(projected[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ position: { kind: "known", value: authority.baseCenter } }),
        position: authority.baseCenter,
      }),
    );
    const draftPosition = { x: 356, y: 86 };
    const pendingProjection = projectStudioPreviewRuntimeTraceTerminalEntity(
      [
        {
          ...square,
          geometry: {
            ...square.geometry,
            position: { kind: "known", value: draftPosition },
          },
          opacity: 1,
          position: draftPosition,
          present: true,
          scale: 1,
        },
      ],
      authority,
      {
        baseFrameRetained: true,
        dimensions: authority.uniformScaleBasis.sourceDimensions,
        draftGhost: "position-and-dimensions",
        position: draftPosition,
        renderProof: authority.renderProof,
        sourceAnchor: 5,
        studioEntityId: authority.studioEntityId,
        target: authority.target,
        validationStatusLabel: "Draft ghost · dependent updater validation pending",
      },
    );
    expect(pendingProjection[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ position: { kind: "known", value: draftPosition } }),
        position: draftPosition,
      }),
    );
    const completedBatchProjection = projectStudioPreviewRuntimeTraceTerminalEntity(
      [
        {
          ...pendingProjection[0]!,
          geometry: {
            ...pendingProjection[0]!.geometry,
            dimensions: { kind: "known", value: { height: 3, width: 3 } },
            position: { kind: "known", value: authority.baseCenter },
          },
          position: authority.baseCenter,
        },
      ],
      null,
      {
        baseFrameRetained: true,
        dimensions: { height: 3, width: 3 },
        draftGhost: "position-and-dimensions",
        position: draftPosition,
        renderProof: authority.renderProof,
        sourceAnchor: 5,
        studioEntityId: authority.studioEntityId,
        target: authority.target,
        validationStatusLabel: "Draft ghost · dependent updater validation pending",
      },
    );
    expect(completedBatchProjection[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({
          dimensions: { kind: "known", value: { height: 3, width: 3 } },
          position: { kind: "known", value: draftPosition },
        }),
        position: draftPosition,
      }),
    );
    expect(
      projectStudioPreviewRuntimeTraceTerminalEntity(
        [
          {
            ...pendingProjection[0]!,
          },
        ],
        authority,
        {
          baseFrameRetained: true,
          dimensions: authority.uniformScaleBasis.sourceDimensions,
          draftGhost: "position-and-dimensions",
          position: draftPosition,
          renderProof: authority.renderProof,
          sourceAnchor: 5,
          studioEntityId: "another-entity",
          target: authority.target,
          validationStatusLabel: "Draft ghost · dependent updater validation pending",
        },
      )[0],
    ).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ position: { kind: "known", value: authority.baseCenter } }),
        position: authority.baseCenter,
      }),
    );
    const decimalRuntimeId = snapshot.sourceRuntimeIdentity?.get("decimal")?.entityId;
    if (!decimalRuntimeId) throw new Error("Expected the verified runtime Decimal root.");
    const selectionProfile = studioPreviewRuntimeTraceUpdatersSelectionProfileV1(snapshot);
    expect(selectionProfile).not.toBeNull();
    const opaqueSelection = projectStudioPreviewRuntimeTraceOpaqueSelectionEntities({
      authority: selectionProfile,
      interactionGeometry: new Map([
        [decimalRuntimeId, { dimensions: { height: 0.8, width: 2.1 }, position: { x: 440, y: 67.5 } }],
      ]),
      sourceRuntimeIdentity: snapshot.sourceRuntimeIdentity,
    });
    expect(opaqueSelection).toEqual([
      expect.objectContaining({
        id: "source:example_scenes/basic.py#UpdatersExample:decimal",
        position: { x: 440, y: 67.5 },
        sourceIdentity: { kind: "known", value: "decimal" },
        type: "DecimalNumber",
      }),
    ]);
    const importedTraceSource = snapshot.snapshot.scene.source;
    if (importedTraceSource.kind !== "imported-manim-runtime-trace") {
      throw new Error("Expected Runtime Trace source evidence.");
    }
    const candidateSourceHash = "c".repeat(64);
    const candidateSnapshot: StudioVerifiedPreviewSnapshotV1 = {
      ...snapshot,
      correlation: {
        ...snapshot.correlation,
        context: {
          ...snapshot.correlation.context,
          sourceHash: candidateSourceHash,
          workingRevision: "verified-candidate-revision",
        },
      },
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          source: { ...importedTraceSource, sourceHash: candidateSourceHash },
        },
      },
    };
    expect(studioPreviewRuntimeTraceTerminalEditSeed(candidateSnapshot)).toBeNull();
    expect(studioPreviewRuntimeTraceUpdatersSelectionProfileV1(candidateSnapshot)).toEqual(selectionProfile);
    const validationScene = projectStudioPreviewRuntimeTraceTerminalValidationScene(
      imported.runtimeSceneState,
      authority,
    );
    const resize = createDirectManipulationResizeProgram({
      capturedPlayhead: 5,
      entityId: authority.studioEntityId,
      from: { dimensions: authority.uniformScaleBasis.sourceDimensions, position: authority.baseCenter },
      interval: { end: 5, start: 5 },
      scale: 1,
      scene: validationScene,
      shape: "rectangle",
      to: { dimensions: { height: 3, width: 3 }, position: authority.baseCenter },
      transactionId: "runtime-trace-terminal-square-resize",
    });
    expect(resize.kind).toBe("valid");
    expect(resize.program.operations).toEqual([
      expect.objectContaining({
        entityId: authority.studioEntityId,
        interval: { end: 5, start: 5 },
        kind: "ResizeEntity",
        shape: "rectangle",
      }),
    ]);
    expect(studioPreviewRuntimeTraceTerminalProgramIsAuthorized(resize.program, authority)).toBe(true);
    const position = createDirectManipulationPositionProgram({
      capturedPlayhead: 5,
      delta: { x: 24, y: 12 },
      positions: { [authority.studioEntityId]: authority.baseCenter },
      scene: validationScene,
      start: 5,
      targetEntityIds: [authority.studioEntityId],
      transactionId: "runtime-trace-terminal-square-position",
    });
    expect(position.kind).toBe("valid");
    expect(studioPreviewRuntimeTraceTerminalProgramIsAuthorized(position.program, authority)).toBe(true);
    const resizeRecord = programRecord(resize.program, resize);
    const positionRecord = programRecord(position.program, position);
    const movedCenter = { x: authority.baseCenter.x + 24, y: authority.baseCenter.y + 12 };
    const movedState = evaluateWorkingState({
      ...base.proposedState.base,
      appliedPrograms: [positionRecord],
      runtimeSceneState: validationScene,
      stagedPrograms: [],
    });
    const movedResize = createDirectManipulationResizeProgram({
      capturedPlayhead: 5,
      entityId: authority.studioEntityId,
      from: { dimensions: authority.uniformScaleBasis.sourceDimensions, position: movedCenter },
      interval: { end: 5, start: 5 },
      scale: 1,
      scene: projectStudioPreviewRuntimeTraceTerminalValidationScene(
        projectRuntimeSceneToSourceTimeline(movedState.evaluatedScene, [position.program]),
        authority,
      ),
      shape: "rectangle",
      to: { dimensions: { height: 3, width: 3 }, position: movedCenter },
      transactionId: "runtime-trace-terminal-square-moved-resize",
    });
    expect(movedResize.kind, JSON.stringify(movedResize.issues)).toBe("valid");
    expect(studioPreviewRuntimeTraceTerminalProgramIsAuthorized(movedResize.program, authority)).toBe(false);
    const movedResizeRecord = programRecord(movedResize.program, movedResize);
    const movedAndResized = evaluateWorkingState({
      ...base.proposedState.base,
      appliedPrograms: [positionRecord, movedResizeRecord],
      runtimeSceneState: validationScene,
      stagedPrograms: [],
    });
    expect(movedAndResized.programs.map(({ validation }) => validation.status)).toEqual(["valid", "valid"]);
    expect(studioPreviewRuntimeTraceTerminalProgramSet([positionRecord, movedResizeRecord], authority)).toMatchObject({
      kind: "authorized",
      remainingOperations: [],
    });
    expect(studioPreviewRuntimeTraceTerminalProgramSet([movedResizeRecord], authority)).toEqual({
      kind: "unauthorized",
    });
    expect(sampleProposedState(movedAndResized, 5).find(({ id }) => id === authority.studioEntityId)).toMatchObject({
      geometry: {
        dimensions: { kind: "known", value: { height: 3, width: 3 } },
        position: { kind: "known", value: movedCenter },
      },
      position: movedCenter,
    });
    expect(studioPreviewRuntimeTraceTerminalProgramSet([positionRecord], authority)).toMatchObject({
      kind: "authorized",
      operationKinds: ["position"],
      remainingOperations: ["resize"],
    });
    expect(studioPreviewRuntimeTraceTerminalProgramSet([resizeRecord], authority)).toMatchObject({
      kind: "authorized",
      operationKinds: ["resize"],
      remainingOperations: ["position"],
    });
    for (const records of [
      [positionRecord, resizeRecord],
      [resizeRecord, positionRecord],
    ]) {
      expect(studioPreviewRuntimeTraceTerminalProgramSet(records, authority)).toMatchObject({
        kind: "authorized",
        remainingOperations: [],
      });
    }
    expect(studioPreviewRuntimeTraceTerminalProgramSet([positionRecord, positionRecord], authority)).toEqual({
      kind: "unauthorized",
    });
    const exactPending = resolveStudioPreviewRuntimeTraceTerminalUiState({
      atExactAnchor: true,
      contextMatches: true,
      presentedAuthority: null,
      programRecords: [positionRecord],
      retainedAuthority: authority,
      transientEdit: false,
      workingRevisionPristine: false,
    });
    expect(exactPending).toMatchObject({
      baseFrameRetained: true,
      editAuthority: authority,
      pendingPresentation: {
        baseFrameRetained: true,
        dimensions: authority.uniformScaleBasis.sourceDimensions,
        studioEntityId: authority.studioEntityId,
      },
      programSet: { kind: "authorized", remainingOperations: ["resize"] },
    });
    expect(exactPending.editAuthority?.capabilities.uniformScale).toBe(true);
    expect(exactPending.pendingPresentation && "capabilities" in exactPending.pendingPresentation).toBe(false);
    const mismatchedPendingProjection = projectStudioPreviewRuntimeTraceTerminalEntity(projected, authority, {
      baseFrameRetained: true,
      dimensions: null,
      draftGhost: "position-only",
      position: { x: 1, y: 2 },
      renderProof: { profile: "opening-grid-title-terminal-v2", sourceAnchor: 14 },
      sourceAnchor: 14,
      studioEntityId: authority.studioEntityId,
      target: { sourceName: "grid_title", type: "Tex" },
      validationStatusLabel: "Draft ghost · OpeningManim validation pending",
    });
    expect(mismatchedPendingProjection[0]?.position).toEqual(authority.baseCenter);
    const scrubbedPending = resolveStudioPreviewRuntimeTraceTerminalUiState({
      atExactAnchor: false,
      contextMatches: true,
      presentedAuthority: null,
      programRecords: [positionRecord],
      retainedAuthority: authority,
      transientEdit: false,
      workingRevisionPristine: false,
    });
    expect(scrubbedPending).toMatchObject({
      baseFrameRetained: false,
      editAuthority: null,
      pendingPresentation: {
        baseFrameRetained: false,
        dimensions: authority.uniformScaleBasis.sourceDimensions,
        studioEntityId: authority.studioEntityId,
      },
    });
    const completePending = resolveStudioPreviewRuntimeTraceTerminalUiState({
      atExactAnchor: true,
      contextMatches: true,
      presentedAuthority: null,
      programRecords: [positionRecord, resizeRecord],
      retainedAuthority: authority,
      transientEdit: false,
      workingRevisionPristine: false,
    });
    expect(completePending).toMatchObject({
      baseFrameRetained: true,
      editAuthority: null,
      pendingPresentation: {
        baseFrameRetained: true,
        dimensions: { height: 3, width: 3 },
        studioEntityId: authority.studioEntityId,
      },
      programSet: { kind: "authorized", remainingOperations: [] },
    });
    expect(
      resolveStudioPreviewRuntimeTraceTerminalUiState({
        atExactAnchor: true,
        contextMatches: true,
        presentedAuthority: null,
        programRecords: [positionRecord, positionRecord],
        retainedAuthority: authority,
        transientEdit: false,
        workingRevisionPristine: false,
      }),
    ).toMatchObject({ editAuthority: null, pendingPresentation: null, programSet: { kind: "unauthorized" } });
    expect(
      resolveStudioPreviewRuntimeTraceTerminalUiState({
        atExactAnchor: true,
        contextMatches: true,
        presentedAuthority: null,
        programRecords: [],
        retainedAuthority: authority,
        transientEdit: true,
        workingRevisionPristine: true,
      }),
    ).toMatchObject({ baseFrameRetained: true, editAuthority: authority, pendingPresentation: null });
    expect([4.9996, 5, 5.0004].map((sampleTime) => studioPreviewRuntimeTraceTerminalAnchorIsExact(sampleTime))).toEqual(
      [false, true, false],
    );
    const nonUniform = createDirectManipulationResizeProgram({
      capturedPlayhead: 5,
      entityId: authority.studioEntityId,
      from: { dimensions: authority.uniformScaleBasis.sourceDimensions, position: authority.baseCenter },
      interval: { end: 5, start: 5 },
      scale: 1,
      scene: validationScene,
      shape: "rectangle",
      to: { dimensions: { height: 3, width: 4 }, position: authority.baseCenter },
      transactionId: "runtime-trace-terminal-square-nonuniform-resize",
    });
    expect(nonUniform.kind).toBe("invalid");
    expect(nonUniform.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/positive uniform factor/i) }),
    );
    expect(studioPreviewRuntimeTraceTerminalProgramIsAuthorized(nonUniform.program, authority)).toBe(false);
    expect(
      studioPreviewRuntimeTraceTerminalProgramIsAuthorized(
        {
          ...position.program,
          anchor: { ...position.program.anchor, capturedPlayhead: 4.999 },
        },
        authority,
      ),
    ).toBe(false);
  });

  it("admits only one exact OpeningManim grid_title move at t=14", { timeout: 15_000 }, async () => {
    const trace = fastManimRuntimeTraceV2Fixture();
    const bundle = await lowerVerifiedFastManimRuntimeTraceV2(trace);
    const source = bundle.scene.source;
    if (source.kind !== "imported-manim-runtime-trace") throw new Error("Expected Runtime Trace V2 source evidence.");
    const context = {
      projectId: trace.projectId,
      sceneName: trace.sceneName,
      sourceDuration: bundle.scene.duration,
      sourceHash: trace.sourceHash,
      sourcePath: trace.sourcePath,
      workingRevision: PRISTINE_WORKING_REVISION,
    } as const;
    const snapshot: StudioVerifiedPreviewSnapshotV1 = {
      assetPayloads: [],
      correlation: {
        assetsManifestDigest: bundle.assets.manifestDigest,
        context,
        engineRevisionHash: source.traceDigest,
        sceneDuration: bundle.scene.duration,
        sceneId: bundle.scene.sceneId,
        serverPublicationRevision: null,
      },
      duration: bundle.scene.duration,
      sceneId: bundle.scene.sceneId,
      snapshot: bundle,
      sourceLabel: "verified Runtime Trace V2",
      sourceRuntimeIdentity: new Map(
        trace.roots.map((root) => [
          root.binding.name,
          { bindingId: root.binding.id, entityId: root.id, sourceName: root.binding.name },
        ]),
      ),
    };
    const selectionProfile = studioPreviewRuntimeTraceOpeningSelectionProfileV2(snapshot);
    expect(selectionProfile).toEqual({
      profile: "opening-grid-title-terminal-v2",
      runtimeEntityId: trace.roots[3]?.id,
      studioSceneId: "example_scenes/basic.py#OpeningManim",
    });
    const seed = studioPreviewRuntimeTraceTerminalEditSeed(snapshot);
    expect(seed).toMatchObject({
      capabilities: { uniformScale: false },
      duration: 15,
      renderProof: { profile: "opening-grid-title-terminal-v2", sourceAnchor: 14 },
      runtimeEntityId: trace.roots[3]?.id,
      sourceAnchor: 14,
      studioEntityId: "source:example_scenes/basic.py#OpeningManim:grid_title",
      studioSceneId: "example_scenes/basic.py#OpeningManim",
    });
    expect(studioPreviewRuntimeTraceTerminalEditSeed(snapshot)).toEqual(seed);
    expect(studioPreviewInteractionAuthority(snapshot)).toEqual({
      editableRuntimeEntityId: trace.roots[3]?.id,
      kind: "bounded-interactive",
      reason: "runtime-trace-terminal-edit",
      sourceAnchor: 14,
      verifiedRuntimeEntityIds: trace.roots.map(({ id }) => id),
    });
    const gridRuntimeId = trace.roots[2]?.id;
    if (!seed || !gridRuntimeId) throw new Error("Expected the verified OpeningManim grid root.");
    expect(
      projectStudioPreviewRuntimeTraceOpaqueSelectionEntities({
        authority: selectionProfile,
        interactionGeometry: new Map([
          [gridRuntimeId, { dimensions: { height: 310, width: 620 }, position: { x: 320, y: 180 } }],
        ]),
        sourceRuntimeIdentity: snapshot.sourceRuntimeIdentity,
      }),
    ).toEqual([
      expect.objectContaining({
        id: "source:example_scenes/basic.py#OpeningManim:grid",
        position: { x: 320, y: 180 },
        sourceIdentity: { kind: "known", value: "grid" },
        type: "NumberPlane",
      }),
    ]);
    expect(
      projectStudioPreviewRuntimeTraceOpaqueSelectionEntities({
        authority: selectionProfile,
        interactionGeometry: new Map(),
        sourceRuntimeIdentity: snapshot.sourceRuntimeIdentity,
      }),
    ).toEqual([]);
    const candidateSourceHash = HASH_C;
    const candidateSnapshot: StudioVerifiedPreviewSnapshotV1 = {
      ...snapshot,
      correlation: {
        ...snapshot.correlation,
        context: { ...snapshot.correlation.context, sourceHash: candidateSourceHash },
      },
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          source: { ...source, sourceHash: candidateSourceHash },
        },
      },
    };
    expect(studioPreviewRuntimeTraceOpeningSelectionProfileV2(candidateSnapshot)).toEqual(selectionProfile);
    expect(studioPreviewRuntimeTraceTerminalEditSeed(candidateSnapshot)).toBeNull();
    expect(
      studioPreviewRuntimeTraceOpeningSelectionProfileV2({
        ...snapshot,
        sourceRuntimeIdentity: new Map(
          [...snapshot.sourceRuntimeIdentity!.entries()].filter(([sourceName]) => sourceName !== "grid"),
        ),
      }),
    ).toBeNull();
    expect(
      studioPreviewRuntimeTraceTerminalEditSeed({
        ...snapshot,
        correlation: {
          ...snapshot.correlation,
          context: { ...snapshot.correlation.context, workingRevision: "stale-opening-trace" },
        },
      }),
    ).toBeNull();
    expect(
      studioPreviewRuntimeTraceTerminalEditSeed({
        ...snapshot,
        sourceRuntimeIdentity: new Map(
          [...snapshot.sourceRuntimeIdentity!.entries()].filter(([sourceName]) => sourceName !== "grid_title"),
        ),
      }),
    ).toBeNull();
    expect(
      studioPreviewRuntimeTraceTerminalEditSeed({
        ...snapshot,
        sourceRuntimeIdentity: new Map(
          [...snapshot.sourceRuntimeIdentity!.entries()].map(([sourceName, mapping]) => [
            sourceName,
            sourceName === "grid_title" ? { ...mapping, entityId: `${mapping.entityId}:stale` } : mapping,
          ]),
        ),
      }),
    ).toBeNull();

    const officialSource = await readFile(
      new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
      "utf8",
    );
    const imported = importManimScene(officialSource, trace.sourcePath, trace.sceneName, {
      height: 8,
      width: 128 / 9,
    });
    if (!seed || seed.capabilities.uniformScale || seed.uniformScaleBasis || !imported) {
      throw new Error("Expected exact OpeningManim Studio authority.");
    }
    const baseCenter = { x: 105, y: 52 };
    const authority = { ...seed, baseCenter } as const;
    expect(authority).toMatchObject({
      capabilities: { uniformScale: false },
      controlLabel: "Grid title terminal edit at 14.00s",
      renderProof: { profile: "opening-grid-title-terminal-v2", sourceAnchor: 14 },
    });
    const validationScene = projectStudioPreviewRuntimeTraceTerminalValidationScene(
      { ...imported.runtimeSceneState, duration: bundle.scene.duration },
      authority,
    );
    const position = createDirectManipulationPositionProgram({
      capturedPlayhead: 14,
      delta: { x: 24, y: -12 },
      positions: { [authority.studioEntityId]: baseCenter },
      scene: validationScene,
      start: 14,
      targetEntityIds: [authority.studioEntityId],
      transactionId: "runtime-trace-opening-grid-title-position",
    });
    expect(position.kind, JSON.stringify(position.issues)).toBe("valid");
    expect(studioPreviewRuntimeTraceTerminalProgramIsAuthorized(position.program, authority)).toBe(true);
    const record = programRecord(position.program, position);
    expect(studioPreviewRuntimeTraceTerminalProgramSet([record], authority)).toEqual({
      kind: "authorized",
      operationKinds: ["position"],
      remainingOperations: [],
    });
    expect(studioPreviewRuntimeTraceTerminalProgramSet([record, record], authority)).toEqual({
      kind: "unauthorized",
    });
    expect(
      studioPreviewRuntimeTraceTerminalProgramIsAuthorized(
        {
          ...position.program,
          anchor: {
            ...position.program.anchor,
            capturedPlayhead: 5,
            resolvedSeconds: 5,
            source: { kind: "playhead", referenceSeconds: 5 },
          },
        },
        authority,
      ),
    ).toBe(false);
    expect(
      [13.9999, 14, 14.0001].map((sampleTime) =>
        studioPreviewRuntimeTraceTerminalAnchorIsExact(sampleTime, authority.sourceAnchor),
      ),
    ).toEqual([false, true, false]);
    expect(
      resolveStudioPreviewRuntimeTraceTerminalUiState({
        atExactAnchor: true,
        contextMatches: true,
        presentedAuthority: authority,
        programRecords: [record],
        retainedAuthority: authority,
        transientEdit: false,
        workingRevisionPristine: true,
      }),
    ).toMatchObject({
      editAuthority: null,
      baseFrameRetained: true,
      pendingPresentation: {
        position: { x: 129, y: 40 },
        renderProof: { profile: "opening-grid-title-terminal-v2", sourceAnchor: 14 },
        sourceAnchor: 14,
        studioEntityId: authority.studioEntityId,
      },
    });
  });

  it("passes a pristine verified Line snapshot through without invoking the narrower Studio adapter", async () => {
    const { proposedState, snapshot } = await linePreviewInput();
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: "project-a/scene.py/LineScene",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle).toBe(snapshot.snapshot);
    expect(result.scene.engineRevisionHash).toBe(snapshot.correlation.engineRevisionHash);
    expect(result.scene.bundle.scene.entities[0]?.geometry.kind).toBe("line");
    expect(result.scene.interactionEntityIds).toEqual(["runtime-line"]);
  });

  it.each(["direct-manipulation", "studio-default"] as const)(
    "routes one imported static root move from %s through the canonical Rust command",
    async (origin) => {
      const frame = { height: 9, width: 16 } as const;
      const { operationId, proposedState, snapshot, workingRevision, workspaceKey } =
        await editedStaticRootPreviewInput({ origin });
      if (!operationId) throw new Error("Imported root move lost its operation identity.");
      const commands: MoveSceneEntityWireCommandV1[] = [];
      const result = await compileStudioPreviewSceneV1({
        frame,
        moveCompiler: recordingMoveCompiler(commands),
        proposedState,
        snapshot,
        workingRevision,
        workspaceKey,
      });

      if (result.kind !== "compiled") throw new Error(result.error);
      expect(commands).toHaveLength(1);
      const command = commands[0];
      if (!command) throw new Error("Imported root move did not reach the Rust compiler boundary.");
      expect(command).toMatchObject({
        entityId: "earlier",
        expectedBaseRevision: snapshot.correlation.engineRevisionHash,
        nextRevision: result.scene.engineRevisionHash,
        provenance: {
          evidence: [
            "Studio t=0 position request projected onto one verified static imported root",
            `authorized operation ${operationId}`,
          ],
          id: `studio-static-move:${result.scene.engineRevisionHash}`,
          origin: "studio-edit-program",
        },
        schema: "poietra.move-scene-entity",
        version: 1,
      });
      expect(command.delta.x).toBeCloseTo(1.6, 12);
      expect(command.delta.y).toBeCloseTo(0.9, 12);
      expect(result.scene.bundle.scene.entities.map(({ id }) => id)).toEqual(["earlier", "runtime-unmapped"]);
      expect(result.scene.interactionEntityIds).toEqual(["earlier"]);
    },
  );

  it("fails closed before Rust compilation when a static imported move loses exact authority", async () => {
    const direct = await editedStaticRootPreviewInput();
    const nonzeroTime = await editedStaticRootPreviewInput({ capturedPlayhead: 0.5 });
    const zeroMove = await editedStaticRootPreviewInput({ target: { x: 320, y: 180 } });
    const baseRuntimeState = direct.proposedState.base.runtimeSceneState;
    const baseCircle = baseRuntimeState.objectGraph.entities["source:circle"];
    if (!baseCircle?.geometry) throw new Error("Imported root base geometry is missing.");
    const cases: readonly Readonly<{
      name: string;
      proposedState: ProposedState;
      snapshot: StudioVerifiedPreviewSnapshotV1;
      workingRevision: string;
      workspaceKey: string;
    }>[] = [
      {
        name: "nonzero source time",
        proposedState: nonzeroTime.proposedState,
        snapshot: nonzeroTime.snapshot,
        workingRevision: nonzeroTime.workingRevision,
        workspaceKey: nonzeroTime.workspaceKey,
      },
      {
        name: "multiple Programs",
        proposedState: {
          ...direct.proposedState,
          programs: [...direct.proposedState.programs, direct.programRecord],
        },
        snapshot: direct.snapshot,
        workingRevision: canonicalEditorWorkingRevision({
          appliedPrograms: [direct.programRecord, direct.programRecord],
          draftProgram: null,
          editingAppliedProgram: null,
          redoPrograms: [],
        }),
        workspaceKey: direct.workspaceKey,
      },
      {
        name: "missing source/runtime identity",
        proposedState: direct.proposedState,
        snapshot: { ...direct.snapshot, sourceRuntimeIdentity: null },
        workingRevision: direct.workingRevision,
        workspaceKey: direct.workspaceKey,
      },
      {
        name: "child runtime entity",
        proposedState: direct.proposedState,
        snapshot: {
          ...direct.snapshot,
          snapshot: {
            ...direct.snapshot.snapshot,
            scene: {
              ...direct.snapshot.snapshot.scene,
              entities: direct.snapshot.snapshot.scene.entities.map((entity) =>
                entity.id === "earlier" ? { ...entity, parentId: "runtime-parent" } : entity,
              ),
            },
          },
        },
        workingRevision: direct.workingRevision,
        workspaceKey: direct.workspaceKey,
      },
      {
        name: "verified animation channel",
        proposedState: direct.proposedState,
        snapshot: {
          ...direct.snapshot,
          snapshot: {
            ...direct.snapshot.snapshot,
            scene: {
              ...direct.snapshot.snapshot.scene,
              animationChannels: [
                {
                  entityId: "earlier",
                  id: "opacity:earlier",
                  keyframes: [
                    { at: 0, easingToNext: { kind: "smooth" }, value: 0 },
                    { at: 2, easingToNext: null, value: 1 },
                  ],
                  kind: "opacity",
                  provenanceId: "verified-source-fade",
                },
              ],
            },
          },
        },
        workingRevision: direct.workingRevision,
        workspaceKey: direct.workspaceKey,
      },
      {
        name: "unknown base position",
        proposedState: {
          ...direct.proposedState,
          base: {
            ...direct.proposedState.base,
            runtimeSceneState: {
              ...baseRuntimeState,
              objectGraph: {
                ...baseRuntimeState.objectGraph,
                entities: {
                  ...baseRuntimeState.objectGraph.entities,
                  "source:circle": {
                    ...baseCircle,
                    geometry: {
                      ...baseCircle.geometry,
                      position: { kind: "unknown", reason: "Position depends on runtime Python." },
                    },
                  },
                },
              },
            },
          },
        },
        snapshot: direct.snapshot,
        workingRevision: direct.workingRevision,
        workspaceKey: direct.workspaceKey,
      },
      {
        name: "zero displacement",
        proposedState: zeroMove.proposedState,
        snapshot: zeroMove.snapshot,
        workingRevision: zeroMove.workingRevision,
        workspaceKey: zeroMove.workspaceKey,
      },
    ];

    for (const testCase of cases) {
      let compilerCalls = 0;
      const result = await compileStudioPreviewSceneV1({
        frame: { height: 9, width: 16 },
        moveCompiler: async () => {
          compilerCalls += 1;
          throw new Error(`Rust compiler must not run for ${testCase.name}.`);
        },
        proposedState: testCase.proposedState,
        snapshot: testCase.snapshot,
        workingRevision: testCase.workingRevision,
        workspaceKey: testCase.workspaceKey,
      });
      expect(result, testCase.name).toMatchObject({ kind: "unsupported" });
      expect(compilerCalls, testCase.name).toBe(0);
    }
  });

  it("restores the exact verified snapshot after undo returns to zero applied Programs", async () => {
    const { proposedState, snapshot } = await linePreviewInput();
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot,
      // The redo stack remains editor authority after Undo, so the revision is
      // intentionally not pristine even though no Program affects the Scene.
      workingRevision: "studio-working-v1:undo-with-redo-history",
      workspaceKey: "project-a/scene.py/LineScene",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle).toBe(snapshot.snapshot);
    expect(result.scene.workingRevision).toBe("studio-working-v1:undo-with-redo-history");
    expect(result.scene.bundle.scene.entities[0]?.geometry.kind).toBe("line");
    expect(result.scene.bundle.scene.animationChannels).toBe(snapshot.snapshot.scene.animationChannels);
  });

  it("replaces the pristine source on the first applied edit, then emits exact bounded deltas", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const pristine = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    const edited = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: withAppliedRectangle(proposedState),
      snapshot,
      workingRevision: "studio-working-v1:create-rectangle",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    if (pristine.kind !== "compiled") throw new Error(pristine.error);
    if (edited.kind !== "compiled") throw new Error(edited.error);
    expect(pristine.scene.bundle.scene.source.kind).toBe("imported-manim-server-snapshot");
    expect(edited.scene.bundle.scene.source.kind).toBe("studio-edit-program");
    // The first ownership handoff is deliberately a full replacement: the v1
    // delta contract accepts Studio-owned bases only. The retained host keeps
    // the same worker/canvas while performing that replacement.
    expect(await createSceneIrDeltaV1(pristine.scene.bundle, edited.scene.bundle)).toBeNull();
    const editedAgain = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: withAppliedRectangle(proposedState, 480),
      snapshot,
      workingRevision: "studio-working-v1:move-rectangle",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    if (editedAgain.kind !== "compiled") throw new Error(editedAgain.error);
    const delta = await createSceneIrDeltaV1(edited.scene.bundle, editedAgain.scene.bundle);
    expect(delta).not.toBeNull();
    if (!delta) throw new Error("second Studio revision did not fit the bounded delta contract");
    expect(delta.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: expect.objectContaining({ id: "tx:create-rectangle/entity:rectangle" }),
          expected: "present",
          kind: "put-entity",
        }),
      ]),
    );
  });

  it("compiles the real authoring create path after its fade extends the evaluated duration", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ dimensions: { height: 2, width: 4 }, position: { x: 400, y: 180 }, type: "Rectangle" }],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "real-create",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const edited = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });

    expect(edited.base.runtimeSceneState.duration).toBe(2);
    expect(edited.evaluatedScene.duration).toBeCloseTo(2.4, 9);
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:real-create",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle.scene.duration).toBeCloseTo(2.4, 9);
    expect(result.scene.bundle.scene.entities.map(({ id }) => id)).toContain(creation.entityIds[0]);
  });

  it("compiles a Studio-created MathTex outline and fails closed on an unsupported expression", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [
        {
          content: { displayLines: ["E = mc^2"], label: "E = mc^2", texParts: ["E = mc^2"] },
          position: { x: 400, y: 180 },
          type: "MathTex",
        },
      ],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "real-mathtex",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const edited = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });
    const inputs: string[][] = [];
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async (texParts) => {
        inputs.push([...texParts]);
        return compiledMathTexResponse();
      },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:real-mathtex",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(inputs).toEqual([["E = mc^2"]]);
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle.scene.entities.find(({ id }) => id === creation.entityIds[0])).toMatchObject({
      appearance: { fill: { color: { alpha: 1, blue: 1, green: 1, red: 1 }, rule: "nonzero" }, stroke: null },
      geometry: { kind: "cubic-path" },
      transform: { m11: 1, m22: 1, tx: 2, ty: 0 },
    });
    expect(result.scene.bundle.scene.requiredCapabilities).toEqual([
      "cubic-path-geometry",
      "opacity-animation",
      "shape-primitives",
    ]);

    const unsupported = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => ({
        result: { code: "frame-item-unsupported", kind: "unsupported", message: "Shape frame item is unsupported." },
        schema: "poietra.mathtex-outline-response",
        version: 1,
      }),
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:unsupported-mathtex",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(unsupported).toMatchObject({
      error: expect.stringContaining("frame-item-unsupported"),
      kind: "unsupported",
    });

    let discontinuousCompilerCalls = 0;
    const discontinuous = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => {
        discontinuousCompilerCalls += 1;
        return compiledMathTexResponse();
      },
      proposedState: {
        ...edited,
        evaluatedScene: {
          ...edited.evaluatedScene,
          propertyChannels: {
            ...edited.evaluatedScene.propertyChannels,
            [`${creation.entityIds[0]}/content`]: {
              entityId: creation.entityIds[0] ?? "missing-mathtex",
              key: "content",
              samples: [
                {
                  interval: { end: edited.evaluatedScene.duration, start: 1 },
                  kind: "exact",
                  provenanceId: "test-content-change",
                  value: { displayLines: ["E = mc^3"], texParts: ["E = mc^3"] },
                },
              ],
            },
          },
        },
      },
      snapshot,
      workingRevision: "studio-working-v1:dynamic-mathtex",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(discontinuousCompilerCalls).toBe(0);
    expect(discontinuous).toMatchObject({ error: expect.stringContaining("changes content"), kind: "unsupported" });
  });

  it("edits imported MathTex from verified snapshot geometry without invoking the browser outline compiler", async () => {
    const fixture = await importedMathTexPreviewInput();
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => {
        compilerCalls += 1;
        return compiledMathTexResponse();
      },
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:edit-imported-mathtex",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(compilerCalls).toBe(0);
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.kind).toBe("compiled");
    expect(result.scene.bundle.scene.entities).toEqual([
      expect.objectContaining({
        geometry: fixture.snapshot.snapshot.scene.entities[0]?.geometry,
        id: fixture.runtimeEntityId,
        transform: expect.objectContaining({ m11: 3, m12: 0, m21: 0, m22: 3, tx: 4 }),
      }),
    ]);
    expect(result.scene.bundle.scene.entities[0]?.transform.ty).toBeCloseTo(1, 12);
  });

  it("rebases an initial MathTex transform without reconstructing mixed V7 animation", async () => {
    const fixture = await mixedV7EditedMathTexPreviewInput();
    const baseScene = fixture.snapshot.snapshot.scene;
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      frame: MIXED_V7_FRAME,
      mathTexOutlineCompiler: async () => {
        compilerCalls += 1;
        return compiledMathTexResponse();
      },
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:mixed-v7-mathtex-transform",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(compilerCalls).toBe(0);
    if (result.kind !== "compiled") throw new Error(result.error);
    const scene = result.scene.bundle.scene;
    expect(scene.sceneId).toBe(baseScene.sceneId);
    expect(scene.camera).toBe(baseScene.camera);
    expect(scene.duration).toBe(baseScene.duration);
    expect(scene.animationChannels).toBe(baseScene.animationChannels);
    expect(canonicalJsonV1(scene.animationChannels)).toBe(canonicalJsonV1(baseScene.animationChannels));
    expect(scene.entities[1]).toBe(baseScene.entities[1]);
    expect(scene.entities[2]).toBe(baseScene.entities[2]);
    expect(scene.entities[0]).toMatchObject({
      geometry: baseScene.entities[0]?.geometry,
      id: fixture.runtimeEntityId,
      transform: { m11: 2, m12: 0, m21: 0, m22: 2 },
    });
    expect(scene.entities[0]?.transform.tx).toBeCloseTo(3.5555555555555554, 12);
    expect(scene.entities[0]?.transform.ty).toBeCloseTo(0.8888888888888888, 12);
    expect(scene.entities[0]?.provenanceId).not.toBe(baseScene.entities[0]?.provenanceId);
    expect(scene.source).toEqual({
      editProgramVersion: 1,
      kind: "studio-edit-program",
      revisionHash: result.scene.engineRevisionHash,
    });
  });

  it("compiles the WarpSquare V9 t=0 draft without reconstructing its path morph", async () => {
    const fixture = await warpSquareV9PreviewInput();
    const importedScene = fixture.snapshot.snapshot.scene;
    const result = await compileStudioPreviewSceneV1({
      frame: MIXED_V7_FRAME,
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:warp-square-v9-transform",
      workspaceKey: "project-a/example_scenes/basic.py/WarpSquare",
    });
    if (result.kind !== "compiled") throw new Error(result.error);
    const scene = result.scene.bundle.scene;

    expect(scene.animationChannels).toBe(importedScene.animationChannels);
    expect(canonicalJsonV1(scene.animationChannels)).toBe(canonicalJsonV1(importedScene.animationChannels));
    expect(scene.entities[0]?.geometry).toBe(importedScene.entities[0]?.geometry);
    expect(scene.entities[0]?.transform).toMatchObject({ m11: 1.5, m12: 0, m21: 0, m22: 1.5 });
    expect(scene.entities[0]?.transform.tx).toBeCloseTo(1.4222222222222223, 12);
    expect(scene.entities[0]?.transform.ty).toBeCloseTo(0.8, 12);
  });

  it("keeps V7 fail-closed when Studio contains an unmapped semantic entity", async () => {
    const fixture = await mixedV7EditedMathTexPreviewInput();
    const particle = fixture.edited.evaluatedScene.objectGraph.entities[fixture.particleStudioId];
    if (!particle) throw new Error("Mixed V7 fixture has no particle semantic entity.");
    const ghostId = "source:scene.py#MathTexScene:ghost";
    const ghost = {
      ...particle,
      id: ghostId,
      sourceIdentity: { kind: "known" as const, value: "ghost" },
    };
    const addGhost = (scene: RuntimeSceneState): RuntimeSceneState => ({
      ...scene,
      objectGraph: {
        ...scene.objectGraph,
        entities: { ...scene.objectGraph.entities, [ghostId]: ghost },
      },
    });
    const result = await compileStudioPreviewSceneV1({
      frame: MIXED_V7_FRAME,
      proposedState: {
        ...fixture.edited,
        base: { ...fixture.edited.base, runtimeSceneState: addGhost(fixture.edited.base.runtimeSceneState) },
        evaluatedScene: addGhost(fixture.edited.evaluatedScene),
      },
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:mixed-v7-unmapped-semantic",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("identity-unverified"),
      kind: "unsupported",
    });
  });

  it("composes a repeated MathTex edit against the transformed V7 source", async () => {
    const baseScale = 1.5;
    const fixture = await mixedV7EditedMathTexPreviewInput({
      mathTexTransform: { m11: baseScale, m12: 0, m21: 0, m22: baseScale, tx: 0.75, ty: -0.5 },
    });
    const result = await compileStudioPreviewSceneV1({
      frame: MIXED_V7_FRAME,
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:second-mixed-v7-transform",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    if (result.kind !== "compiled") throw new Error(result.error);
    const scene = result.scene.bundle.scene;
    const edited = scene.entities[0];
    if (!edited) throw new Error("Repeated MathTex edit lost its target.");
    expect(edited.transform.m11).toBeCloseTo(3, 12);
    expect(edited.transform.m22).toBeCloseTo(3, 12);
    expect(edited.transform.tx).toBeCloseTo(3.5555555555555554, 12);
    expect(edited.transform.ty).toBeCloseTo(0.8888888888888888, 12);
    expect(scene.animationChannels).toBe(fixture.snapshot.snapshot.scene.animationChannels);
    expect(scene.entities.slice(1)).toEqual(fixture.snapshot.snapshot.scene.entities.slice(1));
  });

  it("projects a mixed V7 GUI position through a non-origin camera center", async () => {
    const cameraCenter = { x: 2.5, y: -1.25 };
    const fixture = await mixedV7EditedMathTexPreviewInput({ cameraCenter });
    const result = await compileStudioPreviewSceneV1({
      frame: MIXED_V7_FRAME,
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:panned-camera-transform",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    if (result.kind !== "compiled") throw new Error(result.error);
    const edited = result.scene.bundle.scene.entities[0];
    if (!edited) throw new Error("Panned-camera edit lost its target.");

    expect(result.scene.bundle.scene.camera.view.center).toEqual(cameraCenter);
    expect(edited.transform.tx).toBeCloseTo(6.055555555555555, 12);
    expect(edited.transform.ty).toBeCloseTo(-0.36111111111111116, 12);
  });

  it.each([
    ["rotation", { m11: 1, m12: -0.25, m21: 0.25, m22: 1, tx: 0, ty: 0 }],
    ["shear", { m11: 1, m12: 0.25, m21: 0, m22: 1, tx: 0, ty: 0 }],
    ["non-uniform scale", { m11: 1, m12: 0, m21: 0, m22: 1.25, tx: 0, ty: 0 }],
    ["reflection", { m11: -1, m12: 0, m21: 0, m22: -1, tx: 0, ty: 0 }],
  ])("fails closed on a source transform with %s", async (_name, transform) => {
    const fixture = await mixedV7EditedMathTexPreviewInput({ mathTexTransform: transform });
    const result = await compileStudioPreviewSceneV1({
      frame: MIXED_V7_FRAME,
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:unsupported-source-transform",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("profile-unsupported"), kind: "unsupported" });
  });

  it("rebases an initial Create target transform while preserving the imported channels", async () => {
    const fixture = await mixedV7EditedMathTexPreviewInput({ includeRing: true });
    const baseScene = fixture.snapshot.snapshot.scene;
    const baseState = fixture.edited.base.runtimeSceneState;
    const position = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 64, y: -36 },
      positions: { [fixture.ringStudioId]: { x: 320, y: 180 } },
      scene: baseState,
      start: 0,
      targetEntityIds: [fixture.ringStudioId],
      transactionId: "move-imported-create-target",
    });
    const scale = createDirectManipulationScaleProgram({
      capturedPlayhead: 0,
      interval: { end: 0, start: 0 },
      scales: { [fixture.ringStudioId]: { from: 1, to: 1.25 } },
      scene: baseState,
      targetEntityIds: [fixture.ringStudioId],
      transactionId: "scale-imported-create-target",
    });
    if (position.kind !== "valid" || scale.kind !== "valid") throw new Error("Create target edits are invalid.");
    const result = await compileStudioPreviewSceneV1({
      frame: MIXED_V7_FRAME,
      proposedState: evaluateWorkingState({
        ...fixture.edited.base,
        appliedPrograms: [programRecord(position.program, position), programRecord(scale.program, scale)],
      }),
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:mixed-v7-create-transform",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    if (result.kind !== "compiled") throw new Error(result.error);
    const scene = result.scene.bundle.scene;
    expect(scene.animationChannels).toBe(baseScene.animationChannels);
    expect(canonicalJsonV1(scene.animationChannels)).toBe(canonicalJsonV1(baseScene.animationChannels));
    expect(scene.animationChannels[0]).toMatchObject({ entityId: baseScene.entities[1]?.id, kind: "path-trim" });
    expect(scene.entities[0]).toBe(baseScene.entities[0]);
    expect(scene.entities[2]).toBe(baseScene.entities[2]);
    expect(scene.entities[1]).toMatchObject({
      geometry: baseScene.entities[1]?.geometry,
      id: baseScene.entities[1]?.id,
      transform: { m11: 1.25, m12: 0, m21: 0, m22: 1.25 },
    });
    expect(scene.entities[1]?.transform.tx).toBeCloseTo(2.672222222222222, 12);
    expect(scene.entities[1]?.transform.ty).toBeCloseTo(0.8, 12);
  });

  it("fails closed when a mixed V7 edit targets MoveAlongPath", async () => {
    const fixture = await mixedV7EditedMathTexPreviewInput();
    const programs = fixture.edited.programs.map((record) => ({
      ...record,
      program: {
        ...record.program,
        operations: record.program.operations.map((operation) =>
          "entityId" in operation ? { ...operation, entityId: fixture.particleStudioId } : operation,
        ),
      },
    }));
    const result = await compileStudioPreviewSceneV1({
      frame: MIXED_V7_FRAME,
      proposedState: { ...fixture.edited, programs },
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:mixed-v7-motion-target",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("motion-path-edit-unsupported"),
      kind: "unsupported",
    });
  });

  it("fails closed instead of showing a stale imported MathTex outline after a content edit", async () => {
    const fixture = await importedMathTexPreviewInput();
    const contentEdit = createInspectorEntityEditProgram({
      capturedPlayhead: 0,
      edits: {
        content: { displayLines: ["F = ma"], label: "F = ma", texParts: ["F = ma"] },
      },
      entityId: fixture.entityId,
      from: { position: { x: 400, y: 220 }, scale: 1.5 },
      scene: fixture.workingState.runtimeSceneState,
      transactionId: "edit-imported-mathtex-content",
    });
    if (contentEdit.kind !== "valid") throw new Error("Imported MathTex content edit fixture did not validate");
    const proposedState = evaluateWorkingState({
      ...fixture.workingState,
      appliedPrograms: [programRecord(contentEdit.program, contentEdit)],
    });
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => {
        compilerCalls += 1;
        return compiledMathTexResponse();
      },
      proposedState,
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:edit-imported-mathtex-content",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(compilerCalls).toBe(0);
    expect(result).toMatchObject({
      error: expect.stringContaining("cannot compile content channels"),
      kind: "unsupported",
    });
  });

  it("canonically reconstructs the checked MathTex parity fixture through the Studio adapter", async () => {
    const [fixtureSource, harnessSource] = await Promise.all([
      readFile(new URL("../../fixtures/engine-v1/mathtex-nested-radical-fraction.json", import.meta.url), "utf8"),
      readFile(new URL("../../fixtures/engine-v1/studio-mathtex-preview.harness.json", import.meta.url), "utf8"),
    ]);
    const fixture = JSON.parse(fixtureSource) as Readonly<{
      assets: unknown;
      id: string;
      mathTexReference: Readonly<{
        compilerBounds: unknown;
        compilerContentDigest: string;
        compilerFillRule: unknown;
        compilerFontDigest: string;
        compilerToolchainDigest: string;
        texParts: string[];
      }>;
      scene: unknown;
    }>;
    const harness = JSON.parse(harnessSource) as Readonly<{
      expectedIdentity: Readonly<{ projectId: string; sceneName: string; sourceHash: string; sourcePath: string }>;
    }>;
    const expectedBundle = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
    if (expectedBundle.scene.source.kind !== "studio-edit-program") {
      throw new Error("The checked MathTex parity fixture must carry Studio revision evidence.");
    }
    const [expectedEntity] = expectedBundle.scene.entities;
    if (!expectedEntity || expectedEntity.geometry.kind !== "cubic-path") {
      throw new Error("The checked MathTex parity fixture must contain one cubic-path entity.");
    }
    const outlineResponse = mathTexOutlineResponseV1Schema.parse({
      result: {
        bounds: fixture.mathTexReference.compilerBounds,
        contentDigest: fixture.mathTexReference.compilerContentDigest,
        fillRule: fixture.mathTexReference.compilerFillRule,
        fontDigest: fixture.mathTexReference.compilerFontDigest,
        kind: "compiled",
        path: expectedEntity.geometry.path,
        toolchainDigest: fixture.mathTexReference.compilerToolchainDigest,
      },
      schema: "poietra.mathtex-outline-response",
      version: 1,
    });
    const snapshot = await createMathTexFixturePreviewSnapshotProviderV1().loadVerifiedSnapshot({
      identity: harness.expectedIdentity,
    });
    const baseScene: RuntimeSceneState = {
      constraintGraph: { constraints: [] },
      duration: snapshot.duration,
      eventTrack: { events: [] },
      objectGraph: { entities: {}, lineage: [] },
      propertyChannels: {},
      provenanceGraph: { records: [] },
      sceneId: snapshot.sceneId,
      version: STUDIO_STATE_VERSION,
    };
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0,
      entities: [
        {
          content: {
            displayLines: [...fixture.mathTexReference.texParts],
            label: fixture.mathTexReference.texParts.join(""),
            texParts: [...fixture.mathTexReference.texParts],
          },
          position: { x: 320, y: 180 },
          type: "MathTex",
        },
      ],
      scene: baseScene,
      transactionId: "visual-parity-mathtex-nested-radical-fraction",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const record = programRecord(creation.validation.program, creation.validation);
    const workingState: WorkingState = {
      appliedPrograms: [record],
      editorContext: {
        activeSceneId: baseScene.sceneId,
        playhead: 0.5,
        selection: [...creation.entityIds],
        version: STUDIO_STATE_VERSION,
        viewport: { height: 360, width: 640 },
      },
      runtimeSceneState: baseScene,
      sourceSnapshot: {
        configId: "visual-parity-v1",
        hash: `sha256:${snapshot.correlation.context.sourceHash}`,
        sourceId: snapshot.correlation.context.sourcePath,
        version: STUDIO_STATE_VERSION,
      },
      stagedPrograms: [],
      staticSemanticState: { entities: [], unknowns: [], version: STUDIO_STATE_VERSION },
      version: STUDIO_STATE_VERSION,
    };
    const proposedState = evaluateWorkingState(workingState);
    const workingRevision = canonicalEditorWorkingRevision({
      appliedPrograms: [record],
      draftProgram: null,
      editingAppliedProgram: null,
      redoPrograms: [],
    });
    const workspaceKey = studioPreviewWorkspaceKeyV1({ ...snapshot.correlation.context, workingRevision });
    const compilerInputs: string[][] = [];
    const result = await compileStudioPreviewSceneV1({
      frame: {
        height: snapshot.snapshot.scene.camera.view.frameHeight,
        width: snapshot.snapshot.scene.camera.view.frameWidth,
      },
      mathTexOutlineCompiler: async (texParts) => {
        compilerInputs.push([...texParts]);
        return outlineResponse;
      },
      proposedState,
      snapshot,
      workingRevision,
      workspaceKey,
    });
    expect(compilerInputs).toEqual([fixture.mathTexReference.texParts]);
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(canonicalJsonV1(result.scene.bundle)).toBe(canonicalJsonV1(expectedBundle));
    expect(result.scene.engineRevisionHash).toBe(expectedBundle.scene.source.revisionHash);
    expect(canonicalJsonV1(result.scene.bundle.scene.entities[0]?.geometry)).toBe(
      canonicalJsonV1(expectedEntity.geometry),
    );
    expect(outlineResponse.result).toMatchObject({
      contentDigest: fixture.mathTexReference.compilerContentDigest,
      kind: "compiled",
    });
  });

  it("fails closed instead of dropping verified base animation channels on edit", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const animatedSnapshot: StudioVerifiedPreviewSnapshotV1 = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          animationChannels: [
            {
              entityId: "earlier",
              id: "opacity:earlier",
              keyframes: [
                { at: 0, easingToNext: { kind: "smooth" }, value: 0 },
                { at: 2, easingToNext: null, value: 1 },
              ],
              kind: "opacity",
              provenanceId: "verified-source-fade",
            },
          ],
        },
      },
    };
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: withAppliedRectangle(proposedState),
      snapshot: animatedSnapshot,
      workingRevision: "studio-working-v1:edit-animated-source",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result).toEqual({
      error: "Editing a verified Scene with imported animation channels requires temporal rebasing support.",
      kind: "unsupported",
    });
  });

  it("correlates the canonical Studio state to verified imported runtime evidence", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const edited = withAppliedRectangle(proposedState);
    const first = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:circle",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(first.kind).toBe("compiled");
    if (first.kind !== "compiled") throw new Error(first.error);
    expect(first.scene.bundle.scene).toMatchObject({
      duration: 2,
      fidelity: { kind: "approximate" },
      sceneId: "studio:circle-scene",
      source: { kind: "studio-edit-program", revisionHash: first.scene.engineRevisionHash },
    });
    expect(first.scene.bundle.scene.entities.find(({ id }) => id === "earlier")?.appearance).toEqual(
      snapshot.snapshot.scene.entities[0]?.appearance,
    );
    expect(first.scene.interactionEntityIds).toEqual(["earlier", "tx:create-rectangle/entity:rectangle"]);
    const repeated = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:circle",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(repeated.kind === "compiled" ? repeated.scene.engineRevisionHash : null).toBe(
      first.scene.engineRevisionHash,
    );
  });

  it("changes the compiled revision across every snapshot, asset, and frame authority axis", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const basis = {
      frame: { height: 9, width: 16 },
      snapshot,
      studioScene: proposedState.evaluatedScene,
      workingRevision: "studio-working-v1:circle",
      workspaceKey: "project-a/scene.py/CircleScene",
    } as const;
    const outline = compiledMathTexResponse().result;
    if (outline.kind !== "compiled") throw new Error("MathTex test outline did not compile.");
    const outlineBasis = { ...basis, mathTexOutlines: { math: outline } };
    const digests = await Promise.all([
      digestStudioPreviewSceneRevisionV1(basis),
      digestStudioPreviewSceneRevisionV1({
        ...basis,
        snapshot: {
          ...snapshot,
          correlation: { ...snapshot.correlation, engineRevisionHash: HASH_B },
        },
      }),
      digestStudioPreviewSceneRevisionV1({
        ...basis,
        snapshot: {
          ...snapshot,
          correlation: { ...snapshot.correlation, assetsManifestDigest: HASH_B },
        },
      }),
      digestStudioPreviewSceneRevisionV1({ ...basis, frame: { height: 9, width: 15 } }),
      digestStudioPreviewSceneRevisionV1(outlineBasis),
      digestStudioPreviewSceneRevisionV1({
        ...outlineBasis,
        mathTexOutlines: { math: { ...outline, contentDigest: "d".repeat(64) } },
      }),
      digestStudioPreviewSceneRevisionV1({
        ...outlineBasis,
        mathTexOutlines: { math: { ...outline, toolchainDigest: "e".repeat(64) } },
      }),
      digestStudioPreviewSceneRevisionV1({
        ...outlineBasis,
        mathTexOutlines: { math: { ...outline, fontDigest: "f".repeat(64) } },
      }),
    ]);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("refuses a Studio base that has not adopted the verified source duration", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: {
        ...proposedState,
        base: {
          ...proposedState.base,
          runtimeSceneState: { ...proposedState.base.runtimeSceneState, duration: 3 },
        },
      },
      snapshot,
      workingRevision: "studio-working-v1:stale-time",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result).toMatchObject({ kind: "unsupported" });
  });
});

describe("studioPreviewHostReadyForSceneUpdateV1", () => {
  it("changes only for installation readiness, not volatile presented-frame state", () => {
    expect(studioPreviewHostReadyForSceneUpdateV1({ detail: null, phase: "fallback", reason: "installing" })).toBe(
      false,
    );
    expect(
      studioPreviewHostReadyForSceneUpdateV1({
        frame: { packetId: "frame-a", revision: HASH_A, sampleTime: 0, viewport: { heightPx: 360, widthPx: 640 } },
        phase: "presented",
      }),
    ).toBe(true);
    expect(
      studioPreviewHostReadyForSceneUpdateV1({
        frame: { packetId: "frame-b", revision: HASH_B, sampleTime: 1, viewport: { heightPx: 360, widthPx: 640 } },
        phase: "presented",
      }),
    ).toBe(true);
  });
});

describe("studioPreviewSnapshotMetadataForWorkspaceV1", () => {
  const provider: StudioPreviewSnapshotProviderV1 = {
    id: "delayed-provider",
    loadVerifiedSnapshot: async () => {
      throw new Error("not called by the pure lifecycle resolver");
    },
  };
  const snapshot = {} as StudioVerifiedPreviewSnapshotV1;

  it("reports loading synchronously instead of exposing a previous workspace result", () => {
    const previous: StudioPreviewSnapshotMetadataStateV1 = {
      phase: "ready",
      provider,
      snapshot,
      workspaceKey: "workspace-a",
    };
    expect(studioPreviewSnapshotMetadataForWorkspaceV1(previous, { provider, workspaceKey: "workspace-b" })).toEqual({
      phase: "loading",
      provider,
      snapshot: null,
      workspaceKey: "workspace-b",
    });
  });

  it.each([
    ["workspace/project", { projectId: "project-b" }],
    ["Scene", { sceneName: "OtherScene" }],
    ["source path", { sourcePath: "other.py" }],
    ["source revision", { sourceHash: "b".repeat(64) }],
  ])("drops a retained snapshot and identity map synchronously on a %s switch", (_axis, change) => {
    const context = {
      projectId: "project-a",
      sceneName: "ExampleScene",
      sourceDuration: 1,
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
      workingRevision: "pristine",
    };
    const previousSnapshot = {
      ...snapshot,
      sourceRuntimeIdentity: new Map([
        ["circle", { bindingId: "binding:old", entityId: "runtime:old", sourceName: "circle" }],
      ]),
    } as StudioVerifiedPreviewSnapshotV1;
    const nextContext = { ...context, ...change };
    const next = studioPreviewSnapshotMetadataForWorkspaceV1(
      {
        phase: "ready",
        provider,
        snapshot: previousSnapshot,
        workspaceKey: studioPreviewWorkspaceKeyV1(context),
      },
      { provider, workspaceKey: studioPreviewWorkspaceKeyV1(nextContext) },
    );
    expect(next.phase).toBe("loading");
    expect(next.snapshot).toBeNull();
  });

  it("retains only the exact provider/workspace lifecycle state while a delayed load settles", () => {
    const loading: StudioPreviewSnapshotMetadataStateV1 = {
      phase: "loading",
      provider,
      snapshot: null,
      workspaceKey: "workspace-a",
    };
    expect(studioPreviewSnapshotMetadataForWorkspaceV1(loading, { provider, workspaceKey: "workspace-a" })).toBe(
      loading,
    );
    expect(
      studioPreviewSnapshotMetadataForWorkspaceV1(
        { phase: "ready", provider, snapshot, workspaceKey: "workspace-a" },
        { provider, workspaceKey: "workspace-a" },
      ).phase,
    ).toBe("ready");
    expect(
      studioPreviewSnapshotMetadataForWorkspaceV1(loading, { provider: { ...provider }, workspaceKey: "workspace-a" })
        .phase,
    ).toBe("loading");
  });
});
