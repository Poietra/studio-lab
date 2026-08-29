import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { pngSnapshotBundleFixture } from "../../server/test-fixtures/fast-manim-snapshot-bundle-fixture";
import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1, sceneIrBundleV1Schema } from "../engine/contracts";
import { digestFastManimSnapshotBundleInBrowserV1 } from "../engine/fast-manim-snapshot-digest";
import {
  type MathTexOutlineResponseV1,
  mathTexOutlineResponseV1Schema,
  type TextOutlineInputV1,
  type TextOutlineResponseV1,
  textOutlineResponseV1Schema,
} from "../engine/mathtex-outline";
import type {
  ApplyStaticRootTransformEditCompiler,
  ApplyStaticRootTransformEditWireCommandV1,
  ApplyStudioCreationEditWireCommandV1,
  ApplyStudioFragmentMaterialsWireCommandV1,
  ApplyStudioMathTexTransformEditWireCommandV1,
  ApplyStudioMotionEditCompiler,
  ApplyStudioMotionEditWireCommandV1,
  ApplyStudioScenePostEffectWireCommandV1,
  ApplyStudioTimelineEditCompiler,
  ApplyStudioTimelineEditWireCommandV1,
  StudioCreationProjectionV1,
  StudioMathTexTransformProjectionV1,
  StudioStaticRootMutationV1,
  StudioStaticRootProjectionV1,
} from "../engine/scene-authoring";
import { compileApplyStaticRootTransformEdit, compileApplyStudioFragmentMaterials } from "../engine/scene-authoring";
import {
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
  scenePostEffectRegistryV1Schema,
} from "../engine/scene-post-effect-registry";
import { canonicalFastManimRuntimeTraceSampleTimeV3 } from "../render-pipeline/runtime-trace-v3-shared-contract";
import { importManimScene } from "../render-pipeline/source-import";
import {
  createInspectorEntityEditProgram,
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
  createStudioScenePostEffectProgram,
} from "./authoring-commands";
import { canonicalEditorWorkingRevision } from "./editor-revision-policy";
import { programRecord } from "./evaluator";
import { createFixtureProposedState, validateMotionProgramFixture } from "./fixture";
import {
  assignStudioFragmentMaterialV1,
  createStudioFragmentMaterialV1,
  createStudioGradientFragmentMaterialPresetV1,
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
  EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1,
  projectFragmentMaterialsForSceneV1,
  updateStudioFragmentMaterialParameterV1,
} from "./fragment-material-authoring";
import { type RuntimeSceneState, STUDIO_STATE_VERSION, type WorkingState } from "./model";
import { ingestNativeProjectPngV1 } from "./native-project-assets";
import type { CanonicalEditProgram } from "./operations";
import {
  isStudioNativePreviewSceneIdentityV1,
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSnapshotProviderV1,
  type StudioPreviewSourceRuntimeMappingV1,
  type StudioVerifiedPreviewSnapshotV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";
import { createStudioNativePreviewSnapshotProviderV1 } from "./preview-snapshot-provider.native";
import { validateAndScheduleProgram } from "./program-validation";
import { isPointValue } from "./property-sampling";
import { studioNativeImageAssetsV1 } from "./studio-image-assets";
import {
  createStudioNativeBlankScene,
  createStudioNativeBlankSceneIrBundle,
  studioNativeWorkingState,
} from "./studio-native-workspace";
import {
  canonicalizeSuggestionProgram,
  createDirectManipulationGroupResizeProgram,
  createDirectManipulationGroupRotationProgram,
  createDirectManipulationPositionProgram,
  createDirectManipulationResizeProgram,
  createDirectManipulationScaleProgram,
} from "./suggestion-program";
import {
  claimStudioPreviewCanvasV1,
  compileStudioPreviewSceneV1,
  connectStudioPreviewPlaybackClock,
  correlateStudioPreviewFragmentMaterialInputV1,
  digestStudioPreviewSceneRevisionV1,
  projectStudioPreviewRuntimeTraceOpaqueSelectionEntities,
  type StudioPreviewSnapshotMetadataStateV1,
  studioPreviewHostReadyForSceneUpdateV1,
  studioPreviewInteractionAuthority,
  studioPreviewInteractionEntityIdsV1,
  studioPreviewSnapshotMetadataForWorkspaceV1,
  suppressStudioPreviewHostStateDuringPlayback,
} from "./use-preview-renderer";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

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

function compiledTextResponse(text = "Hello Text"): TextOutlineResponseV1 {
  const mathTex = compiledMathTexResponse().result;
  if (mathTex.kind !== "compiled") throw new Error("The shared outline fixture must compile.");
  const fragments = [...text.normalize("NFC")]
    .filter((character) => !/\s/u.test(character))
    .map((character, order) => ({
      order,
      path: mathTex.path,
      sourceCorrelation: { key: character, kind: "nfc-scalar" as const },
    }));
  return textOutlineResponseV1Schema.parse({
    result: {
      bounds: mathTex.bounds,
      fillRule: "nonzero",
      fragments,
      kind: "compiled",
      path: { subpaths: fragments.flatMap((fragment) => fragment.path.subpaths) },
    },
    schema: "poietra.text-outline-response",
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
    appliedEdits: [],
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
    stagedEdits: [],
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
  const proposedState = createFixtureProposedState(workingState);
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

function exactImportedTimelineWorkingBase(base: Awaited<ReturnType<typeof compilablePreviewInput>>): WorkingState {
  const context = base.snapshot.correlation.context;
  const sceneId = `${context.sourcePath}#${context.sceneName}`;
  return {
    ...base.proposedState.base,
    editorContext: { ...base.proposedState.base.editorContext, activeSceneId: sceneId },
    runtimeSceneState: { ...base.proposedState.base.runtimeSceneState, sceneId },
  };
}

async function nativePreviewInput(documentKey: string, projectId: string) {
  const nativeScene = createStudioNativeBlankScene(documentKey);
  const frame = { height: 9, width: 16 } as const;
  const bundle = await createStudioNativeBlankSceneIrBundle(nativeScene, frame);
  const identity = {
    documentKey,
    origin: "studio-native" as const,
    projectId,
    sceneId: nativeScene.sceneId,
  };
  const snapshot = await createStudioNativePreviewSnapshotProviderV1({
    assetPayloads: [],
    bundle,
    identity,
  }).loadVerifiedSnapshot({ identity });
  return { frame, identity, nativeScene, snapshot };
}

function recordingStudioTimelineCompiler(
  calls: ApplyStudioTimelineEditWireCommandV1[],
): ApplyStudioTimelineEditCompiler {
  return async (bundle, command) => {
    calls.push(command);
    return bundle;
  };
}

function recordingMotionCompiler(calls: ApplyStudioMotionEditWireCommandV1[]): ApplyStudioMotionEditCompiler {
  return async (bundle, command) => {
    calls.push(command);
    return bundle;
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
  const record = {
    ...programRecord(validation.program, validation),
    validation: { issues: validation.issues, status: "valid" as const },
  };
  return {
    ...base,
    operationId: validation.program.operations[0]?.id,
    programRecord: record,
    workingState: {
      ...workingBase,
      appliedEdits: [record],
    },
    workingRevision: canonicalEditorWorkingRevision({
      appliedEdits: [record],
      draftEdit: null,
      editingAppliedProgram: null,
      redoPrograms: [],
    }),
    workspaceKey: studioPreviewWorkspaceKeyV1(context),
  };
}

async function verifiedStaticPrimitivePreviewInput(type: "Circle" | "Rectangle") {
  const base = await compilablePreviewInput();
  const runtimeEntity = base.snapshot.snapshot.scene.entities[0];
  const studioEntity = base.proposedState.base.runtimeSceneState.objectGraph.entities["source:circle"];
  if (!runtimeEntity || !studioEntity?.geometry) {
    throw new Error("Static primitive preview fixture is incomplete.");
  }
  const producerFixtureUrl = new URL("../../server/test-fixtures/fast-manim-static-bundle.json", import.meta.url);
  const producerFixture = JSON.parse(await readFile(producerFixtureUrl, "utf8")) as Readonly<{
    assets: unknown;
    scene: Readonly<Record<string, unknown>>;
  }>;
  const producerBundle = await parseVerifiedSceneIrBundleV1({
    ...producerFixture,
    scene: {
      ...producerFixture.scene,
      compositing: "linear-light",
      stateSampling: { frameRate: null, retainsTerminalState: false },
    },
  });
  const producerEntity = producerBundle.scene.entities[type === "Circle" ? 0 : 1];
  if (producerEntity?.geometry.kind !== "cubic-path") {
    throw new Error("FastManim static primitive fixture lost its producer-shaped cubic path.");
  }
  const dimensions = type === "Circle" ? ({ radius: 1 } as const) : ({ height: 1, width: 2 } as const);
  const position = type === "Circle" ? ({ x: 280, y: 180 } as const) : ({ x: 400, y: 180 } as const);
  const snapshotBundle = await parseVerifiedSceneIrBundleV1({
    ...base.snapshot.snapshot,
    scene: {
      ...base.snapshot.snapshot.scene,
      entities: [{ ...runtimeEntity, geometry: producerEntity.geometry }],
      requiredCapabilities: ["cubic-path-geometry"],
    },
  });
  const context = base.snapshot.correlation.context;
  const sceneId = `${context.sourcePath}#${context.sceneName}`;
  const workingBase: WorkingState = {
    ...base.proposedState.base,
    editorContext: {
      ...base.proposedState.base.editorContext,
      activeSceneId: sceneId,
      playhead: 0,
    },
    runtimeSceneState: {
      ...base.proposedState.base.runtimeSceneState,
      objectGraph: {
        ...base.proposedState.base.runtimeSceneState.objectGraph,
        entities: {
          "source:circle": {
            ...studioEntity,
            geometry: {
              ...studioEntity.geometry,
              dimensions: { kind: "known", value: dimensions },
              position: { kind: "known", value: position },
              scale: { kind: "known", value: 1 },
            },
            type,
          },
        },
      },
      propertyChannels: {
        "source:circle/dimensions": {
          entityId: "source:circle",
          key: "dimensions",
          samples: [
            {
              interval: { end: 2, start: 0 },
              kind: "exact",
              knowledge: { kind: "known", value: dimensions },
              provenanceId: "verified-static-primitive:dimensions",
              value: dimensions,
            },
          ],
        },
        "source:circle/position": {
          entityId: "source:circle",
          key: "position",
          samples: [
            {
              interval: { end: 2, start: 0 },
              kind: "exact",
              knowledge: { kind: "known", value: position },
              provenanceId: "verified-static-primitive:position",
              value: position,
            },
          ],
        },
        "source:circle/scale": {
          entityId: "source:circle",
          key: "scale",
          samples: [
            {
              interval: { end: 2, start: 0 },
              kind: "exact",
              knowledge: { kind: "known", value: 1 },
              provenanceId: "verified-static-primitive:scale",
              value: 1,
            },
          ],
        },
      },
      sceneId,
    },
    staticSemanticState: {
      ...base.proposedState.base.staticSemanticState,
      entities: base.proposedState.base.staticSemanticState.entities.map((entity) => ({
        ...entity,
        type: { kind: "known", value: type },
      })),
    },
  };
  return {
    dimensions,
    entityId: "source:circle",
    position,
    snapshot: { ...base.snapshot, snapshot: snapshotBundle },
    workingBase,
    workspaceKey: studioPreviewWorkspaceKeyV1(context),
  };
}

function recordingStaticRootTransformEditCompiler(
  calls: ApplyStaticRootTransformEditWireCommandV1[],
  compile?: ApplyStaticRootTransformEditCompiler,
): ApplyStaticRootTransformEditCompiler {
  return async (bundle, command) => {
    calls.push(command);
    if (compile) return compile(bundle, command);
    const operations = command.programs.flatMap((program) =>
      program.operations.map((operation) => ({ operation, transactionId: program.transactionId })),
    );
    let staticRootProjection: StudioStaticRootProjectionV1 | undefined;
    if (
      operations.every(({ operation }) =>
        ["math-tex-content", "position", "resize", "uniform-scale"].includes(operation.kind),
      )
    ) {
      const mutations: StudioStaticRootMutationV1[] = [];
      for (const { operation, transactionId } of operations) {
        const common = { operationId: operation.id, transactionId };
        if (operation.kind === "math-tex-content") {
          mutations.push({
            ...common,
            content: operation.content,
            entityId: operation.entityId,
            interval: operation.interval,
            kind: operation.kind,
          });
        } else if (operation.kind === "position" && operation.position) {
          mutations.push({
            ...common,
            entityId: operation.entityId,
            interval: operation.interval,
            kind: operation.kind,
            value: operation.position,
          });
        } else if (operation.kind === "uniform-scale" && operation.from !== null && operation.to !== null) {
          mutations.push({
            ...common,
            entityId: operation.entityId,
            from: operation.from,
            interval: operation.interval,
            kind: operation.kind,
            to: operation.to,
          });
        } else if (operation.kind === "resize") {
          mutations.push({
            ...common,
            entityId: operation.entityId,
            fromDimensions: operation.fromDimensions,
            fromPosition: operation.fromPosition,
            interval: operation.interval,
            kind: operation.kind,
            toDimensions: operation.toDimensions,
            toPosition: operation.toPosition,
          });
        }
      }
      staticRootProjection = { insertions: [], mutations, projectedDuration: bundle.scene.duration };
    }
    return { ...unchangedAuthoringResult(bundle), ...(staticRootProjection ? { staticRootProjection } : {}) };
  };
}

function unchangedAuthoringResult(bundle: SceneIrBundleV1) {
  return { bundle, persistentRemoveProjection: { removals: [] } } as const;
}

async function importedMathTexPreviewInput() {
  const base = await compilablePreviewInput();
  if (isStudioNativePreviewSceneIdentityV1(base.snapshot.correlation.context)) {
    throw new Error("Imported MathTex fixtures require source identity.");
  }
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
  const pathPoints = outline.path.subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end]),
  ]);
  const localCenter = {
    x: (Math.min(...pathPoints.map(({ x }) => x)) + Math.max(...pathPoints.map(({ x }) => x))) / 2,
    y: (Math.min(...pathPoints.map(({ y }) => y)) + Math.max(...pathPoints.map(({ y }) => y))) / 2,
  };
  const linearTransform = { m11: 1.5, m12: 0, m21: 0, m22: 1.5 };
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
          transform: {
            ...linearTransform,
            tx: 2 - linearTransform.m11 * localCenter.x - linearTransform.m12 * localCenter.y,
            ty: -1 - linearTransform.m21 * localCenter.x - linearTransform.m22 * localCenter.y,
          },
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
    appliedEdits: [],
    documentSnapshot: undefined,
    editorContext: {
      ...base.proposedState.base.editorContext,
      activeSceneId: runtimeSceneState.sceneId,
    },
    runtimeSceneState,
    sourceSnapshot: {
      ...base.proposedState.base.sourceSnapshot!,
      hash: `sha256:${imported.sourceHash}`,
      sourceId: "scene.py",
    },
    stagedEdits: [],
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
  const combined = validateAndScheduleProgram(
    {
      ...position.program,
      intentCount: 2,
      operations: [...position.program.operations, ...scale.program.operations],
      requestedExecution: "sequence",
      transactionId: "transform-imported-mathtex",
    },
    runtimeSceneState,
  );
  if (combined.kind !== "valid") {
    throw new Error(`Combined imported MathTex transform did not validate: ${JSON.stringify(combined.issues)}`);
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
    edited: {
      ...workingState,
      appliedEdits: [programRecord(combined.program, combined)],
    },
    entityId,
    runtimeEntityId,
    snapshot,
    workingState,
  };
}

async function importedImagePreviewInput() {
  const fixture = await importedMathTexPreviewInput();
  if (isStudioNativePreviewSceneIdentityV1(fixture.snapshot.correlation.context)) {
    throw new Error("Imported Image fixtures require source identity.");
  }
  const runtimeEntityId = "runtime:image";
  const png = await pngSnapshotBundleFixture({
    frame: { height: 9, width: 16 },
    projectId: "project-a",
    requestId: "image-preview-test",
    runtimeConfigHash: HASH_B,
    sceneId: "image-scene",
    sceneName: "ImageScene",
    snapshotVersion: 4,
    sourceHash: fixture.snapshot.correlation.context.sourceHash,
    sourcePath: "scene.py",
  });
  const image = png.scene.entities[0];
  const studioEntity = fixture.edited.runtimeSceneState.objectGraph.entities[fixture.entityId];
  if (!image || !studioEntity) throw new Error("Imported Image preview fixture is incomplete.");
  const imageEntity = {
    ...studioEntity,
    content: { displayLines: ["image.png"], label: "image.png" },
    sourceIdentity: { kind: "known" as const, value: "image" },
    type: "ImageMobject",
  };
  const withImage = (scene: RuntimeSceneState): RuntimeSceneState => ({
    ...scene,
    objectGraph: { ...scene.objectGraph, entities: { [fixture.entityId]: imageEntity } },
  });
  const edited: WorkingState = {
    ...fixture.edited,
    runtimeSceneState: withImage(fixture.edited.runtimeSceneState),
  };
  const unsigned = await parseVerifiedSceneIrBundleV1({
    assets: png.assets,
    scene: {
      ...fixture.snapshot.snapshot.scene,
      assetManifest: png.scene.assetManifest,
      entities: [
        {
          ...image,
          geometry: {
            ...image.geometry,
            localRect: { bottom: -2, left: 1, right: 3, top: 0 },
          },
          id: runtimeEntityId,
          provenanceId: fixture.snapshot.snapshot.scene.entities[0]?.provenanceId,
          transform: { m11: 1, m12: 0.25, m21: -0.125, m22: 1.25, tx: 0.25, ty: 0.5 },
        },
      ],
      requiredCapabilities: ["png-image"],
      source: { ...fixture.snapshot.snapshot.scene.source, snapshotHash: "0".repeat(64), snapshotVersion: 4 },
    },
  });
  const revision = await digestFastManimSnapshotBundleInBrowserV1(unsigned);
  const snapshotBundle = await parseVerifiedSceneIrBundleV1({
    ...unsigned,
    scene: { ...unsigned.scene, source: { ...unsigned.scene.source, snapshotHash: revision } },
  });
  return {
    edited,
    frame: { height: 9, width: 16 } as const,
    runtimeEntityId,
    snapshot: {
      ...fixture.snapshot,
      correlation: {
        ...fixture.snapshot.correlation,
        assetsManifestDigest: png.assets.manifestDigest,
        engineRevisionHash: revision,
      },
      snapshot: snapshotBundle,
      sourceRuntimeIdentity: new Map([
        ["image", { bindingId: "binding:image", entityId: runtimeEntityId, sourceName: "image" }],
      ]),
    },
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
  it("keeps traces without endpoint evidence selection-only and bounds verified endpoint edits", async () => {
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

    const authority = studioPreviewInteractionAuthority(runtimeTrace, 0, []);
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

    const terminalFrame = Math.round((entities[0]?.lifetimes[0]?.end ?? 0) * 60) - 1;
    const terminalSourceAnchor = canonicalFastManimRuntimeTraceSampleTimeV3(terminalFrame);
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
                frameIndex: terminalFrame,
                sampleTime: terminalSourceAnchor,
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
          source: {
            ...runtimeTrace.snapshot.scene.source,
            sourceHash: runtimeTrace.correlation.context.sourceHash,
            traceDigest: runtimeTrace.correlation.engineRevisionHash,
            traceVersion: 3,
          },
        },
      },
      sourceRuntimeIdentity: genericV3Identity,
    } as StudioVerifiedPreviewSnapshotV1;
    const constructionAuthority = studioPreviewInteractionAuthority(genericV3, 0, []);
    expect(constructionAuthority).toEqual({
      editableRuntimeEntityIds: [motionRootId],
      kind: "bounded-interactive",
      reason: "runtime-trace-edit",
      sourceAnchor: 0,
      verifiedRuntimeEntityIds: [motionRootId],
    });
    const settledWait = {
      id: "import:generic:wait:1",
      interval: { end: genericV3.duration, start: terminalSourceAnchor - 0.01 },
      kind: "wait" as const,
      label: "wait",
    };
    expect(studioPreviewInteractionAuthority(genericV3, terminalSourceAnchor - 0.005, [settledWait])).toEqual({
      ...constructionAuthority,
      sourceAnchor: settledWait.interval.start,
    });
    expect(studioPreviewInteractionEntityIdsV1(genericV3Identity, constructionAuthority, entities)).toEqual([
      motionRootId,
    ]);
  });

  it("derives static interaction from verified root facts rather than the snapshot wire version", async () => {
    const { snapshot } = await linePreviewInput();
    const source = snapshot.snapshot.scene.source;
    if (source.kind !== "imported-manim-server-snapshot") throw new Error("Expected imported snapshot source.");
    const changedWireVersion = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: { ...snapshot.snapshot.scene, source: { ...source, snapshotVersion: 12 } },
      },
    } as StudioVerifiedPreviewSnapshotV1;

    expect(studioPreviewInteractionAuthority(snapshot, 0, [])).toEqual({ kind: "interactive" });
    expect(studioPreviewInteractionAuthority(changedWireVersion, 0, [])).toEqual({ kind: "interactive" });
    expect(studioPreviewInteractionAuthority({ ...snapshot, sourceRuntimeIdentity: null }, 0, [])).toEqual({
      kind: "display-only",
      reason: "source-runtime-identity-unverified",
    });
  });

  it("allows the first Studio object in a verified empty server snapshot", async () => {
    const { snapshot } = await linePreviewInput();
    const empty = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: { ...snapshot.snapshot.scene, animationChannels: [], entities: [] },
      },
      sourceRuntimeIdentity: new Map(),
    } as StudioVerifiedPreviewSnapshotV1;

    expect(studioPreviewInteractionAuthority(empty, 0, [])).toEqual({ kind: "interactive" });
    expect(studioPreviewInteractionAuthority({ ...empty, sourceRuntimeIdentity: null }, 0, [])).toEqual({
      kind: "display-only",
      reason: "source-runtime-identity-unverified",
    });
  });

  it("keeps the two visible WriteStuff groups selectable without advertising mutations", async () => {
    const [engineFixtureText, identityFixtureText] = await Promise.all([
      readFile(new URL("../../fixtures/engine-v1/real-write-stuff-v12.json", import.meta.url), "utf8"),
      readFile(new URL("../../server/test-fixtures/fast-manim-write-stuff-v12-combined.json", import.meta.url), "utf8"),
    ]);
    const fixture = JSON.parse(engineFixtureText) as Readonly<{ assets: unknown; scene: unknown }>;
    const bundle = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
    const source = bundle.scene.source;
    if (source.kind !== "imported-manim-server-snapshot") throw new Error("Expected the V12 server snapshot.");
    const identityFixture = JSON.parse(identityFixtureText) as Readonly<{
      evidence: Readonly<{
        records: readonly Readonly<{
          bindings: readonly Readonly<{ binding: Readonly<{ id: string; name: string }> }>[];
          entityId: string;
          lifecycle: readonly unknown[];
          status: string;
        }>[];
      }>;
    }>;
    const mappedRecords = identityFixture.evidence.records.filter(
      ({ bindings, status }) => status === "mapped" && bindings.length === 1,
    );
    const identity = new Map<string, StudioPreviewSourceRuntimeMappingV1>(
      mappedRecords.map(({ bindings, entityId }) => {
        const binding = bindings[0]!.binding;
        return [binding.name, { bindingId: binding.id, entityId, sourceName: binding.name }];
      }),
    );
    const visibleRecords = mappedRecords.filter(({ lifecycle }) => lifecycle.length > 0);
    expect(visibleRecords.map(({ bindings }) => bindings[0]!.binding.name)).toEqual(["example_text", "example_tex"]);
    expect(bundle.scene.animationChannels.length).toBeGreaterThan(0);

    const snapshot: StudioVerifiedPreviewSnapshotV1 = {
      assetPayloads: [],
      correlation: {
        assetsManifestDigest: bundle.assets.manifestDigest,
        context: {
          projectId: "write-stuff-generic-preview",
          sceneName: "WriteStuff",
          sourceDuration: bundle.scene.duration,
          sourceHash: source.sourceHash,
          sourcePath: "example_scenes/basic.py",
          workingRevision: PRISTINE_WORKING_REVISION,
        },
        engineRevisionHash: source.snapshotHash,
        sceneDuration: bundle.scene.duration,
        sceneId: bundle.scene.sceneId,
        serverPublicationRevision: null,
      },
      duration: bundle.scene.duration,
      sceneId: bundle.scene.sceneId,
      snapshot: bundle,
      sourceLabel: "verified WriteStuff V12 fixture",
      sourceRuntimeIdentity: identity,
    };
    const visibleIds = visibleRecords.map(({ entityId }) => entityId);
    const authority = studioPreviewInteractionAuthority(snapshot, 0, []);
    expect(authority).toEqual({
      kind: "selection-only",
      reason: "source-edit-unsupported",
      verifiedRuntimeEntityIds: visibleIds,
    });
    const interactionEntityIds = studioPreviewInteractionEntityIdsV1(identity, authority, bundle.scene.entities);
    expect(interactionEntityIds).toEqual(visibleIds);

    // Real bounds remain covered by the checked V12 WGPU parity; this seam
    // receives only the prepared-frame interaction map.
    const interactionGeometry = new Map(
      interactionEntityIds.map((entityId, index) => [
        entityId,
        {
          dimensions: { height: 40, width: 100 },
          position: { x: 200 + index * 240, y: 180 },
        },
      ]),
    );
    expect(
      projectStudioPreviewRuntimeTraceOpaqueSelectionEntities({
        interactionGeometry,
        sourceRuntimeIdentity: identity,
        studioSceneId: "example_scenes/basic.py#WriteStuff",
      }).map(({ id }) => id),
    ).toEqual([
      "source:example_scenes/basic.py#WriteStuff:example_text",
      "source:example_scenes/basic.py#WriteStuff:example_tex",
    ]);
    expect(studioPreviewInteractionAuthority({ ...snapshot, sourceRuntimeIdentity: null }, 0, [])).toEqual({
      kind: "display-only",
      reason: "source-runtime-identity-unverified",
    });
  });

  it("keeps mixed root and nested mappings selection-only from generic Scene facts", async () => {
    const { snapshot } = await linePreviewInput();
    const leaf = snapshot.snapshot.scene.entities[0];
    if (!leaf) throw new Error("Expected one imported line fixture entity.");
    const groupId = "runtime-group";
    const nestedId = "runtime-nested";
    const entities: SceneIrBundleV1["scene"]["entities"] = [
      leaf,
      {
        ...leaf,
        appearance: { kind: "group", opacity: 1 },
        geometry: { kind: "group" },
        id: groupId,
        parentId: null,
        sceneOrder: 1,
      },
      { ...leaf, id: nestedId, parentId: groupId, sceneOrder: 2 },
    ];
    const identity = new Map<string, StudioPreviewSourceRuntimeMappingV1>([
      ["line", { bindingId: "binding:line", entityId: leaf.id, sourceName: "line" }],
      ["group", { bindingId: "binding:group", entityId: groupId, sourceName: "group" }],
      ["nested", { bindingId: "binding:nested", entityId: nestedId, sourceName: "nested" }],
    ]);
    const mixed = {
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        scene: { ...snapshot.snapshot.scene, entities },
      },
      sourceRuntimeIdentity: identity,
    } as StudioVerifiedPreviewSnapshotV1;

    const authority = studioPreviewInteractionAuthority(mixed, 0, []);
    expect(authority).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority, entities)).toEqual([leaf.id, nestedId]);
  });
});

describe("compileStudioPreviewSceneV1", () => {
  it("applies an ordered stack with exactly its referenced project-local sources", async () => {
    const base = await compilablePreviewInput();
    const effects = [
      { parameters: [4, 2, 1, 0], revision: 1, shaderId: "rgb-split" },
      { parameters: [8, 48, 0.25, 0], revision: 7, shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 },
    ];
    const validation = createStudioScenePostEffectProgram({
      capturedPlayhead: 0.5,
      effects,
      scene: base.proposedState.base.runtimeSceneState,
      transactionId: "scene-effect-stack",
    });
    if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));
    const record = programRecord(validation.program, validation);
    const workingRevision = "studio-working-v1:scene-effect-stack";
    const registry = scenePostEffectRegistryV1Schema.parse({
      effects: [
        {
          revision: 7,
          shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          source: STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
        },
      ],
      schema: "poietra.scene-post-effect-registry",
      version: 1,
    });
    const commands: ApplyStudioScenePostEffectWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioScenePostEffectCompiler: async (bundle, command) => {
        commands.push(command);
        return sceneIrBundleV1Schema.parse({
          ...bundle,
          scene: {
            ...bundle.scene,
            postEffects: command.effects,
            requiredCapabilities: [...new Set([...bundle.scene.requiredCapabilities, "scene-post-effect"])],
            source: {
              editProgramVersion: 1,
              kind: "studio-edit-program",
              revisionHash: command.nextRevision,
            },
          },
        });
      },
      frame: { height: 9, width: 16 },
      scenePostEffectRegistry: registry,
      snapshot: base.snapshot,
      workingState: { ...base.proposedState.base, appliedEdits: [record] },
      workingRevision,
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.effects).toEqual(effects);
    expect(result.scene.bundle.scene.postEffects).toEqual(effects);
    expect(result.scene.scenePostEffectRegistry).toBe(registry);
  });

  it("rejects a missing project-local source before calling the Rust core", async () => {
    const base = await compilablePreviewInput();
    const validation = createStudioScenePostEffectProgram({
      capturedPlayhead: 0.5,
      effects: [{ parameters: [8, 48, 0.25, 0], revision: 7, shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 }],
      scene: base.proposedState.base.runtimeSceneState,
      transactionId: "missing-scene-effect-source",
    });
    if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      applyStudioScenePostEffectCompiler: async (bundle) => {
        compilerCalls += 1;
        return bundle;
      },
      frame: { height: 9, width: 16 },
      snapshot: base.snapshot,
      workingState: {
        ...base.proposedState.base,
        appliedEdits: [programRecord(validation.program, validation)],
      },
      workingRevision: "studio-working-v1:missing-scene-effect-source",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    expect(result).toMatchObject({ kind: "unsupported" });
    expect(compilerCalls).toBe(0);
  });

  it("rejects a custom source/reference texture-slot mismatch before calling the Rust core", async () => {
    const base = await compilablePreviewInput();
    const validation = createStudioScenePostEffectProgram({
      capturedPlayhead: 0.5,
      effects: [{ parameters: [0.5], revision: 7, shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 }],
      scene: base.proposedState.base.runtimeSceneState,
      transactionId: "missing-scene-effect-texture",
    });
    if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      applyStudioScenePostEffectCompiler: async (bundle) => {
        compilerCalls += 1;
        return bundle;
      },
      frame: { height: 9, width: 16 },
      scenePostEffectRegistry: scenePostEffectRegistryV1Schema.parse({
        effects: [
          {
            revision: 7,
            shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
            source: STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
            textureSlot: "texture2d",
          },
        ],
        schema: "poietra.scene-post-effect-registry",
        version: 1,
      }),
      snapshot: base.snapshot,
      workingState: {
        ...base.proposedState.base,
        appliedEdits: [programRecord(validation.program, validation)],
      },
      workingRevision: "studio-working-v1:missing-scene-effect-texture",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    expect(result).toMatchObject({ error: expect.stringContaining("texture slots"), kind: "unsupported" });
    expect(compilerCalls).toBe(0);
  });

  it("compiles a locally ingested PNG into ImageMobject on one exact native base", async () => {
    const documentKey = "d".repeat(64);
    const projectId = "native-project";
    const nativeScene = createStudioNativeBlankScene(documentKey);
    const frame = { height: 9, width: 16 } as const;
    const blankBundle = await createStudioNativeBlankSceneIrBundle(nativeScene, frame);
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const nativeAssets = await ingestNativeProjectPngV1({
      decodeDimensions: async () => ({ pixelHeight: 16, pixelWidth: 32 }),
      source: { bytes: pngBytes.buffer, kind: "bytes", mediaType: "image/png" },
      state: { assetPayloads: [], bundle: blankBundle },
    });
    const identity = {
      documentKey,
      origin: "studio-native" as const,
      projectId,
      sceneId: nativeScene.sceneId,
    };
    const snapshot = await createStudioNativePreviewSnapshotProviderV1({
      assetPayloads: nativeAssets.assetPayloads,
      bundle: nativeAssets.bundle,
      identity,
    }).loadVerifiedSnapshot({ identity });
    const imageAsset = studioNativeImageAssetsV1(nativeAssets)[0];
    if (!imageAsset) throw new Error("Native PNG ingress must expose one canonical Image asset.");
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0,
      entities: [{ image: imageAsset.image, position: { x: 320, y: 180 }, type: "ImageMobject" }],
      scene: nativeScene.runtimeSceneState,
      transactionId: "native-image",
    });
    if (creation.validation.kind !== "valid") throw new Error("Native Image creation fixture must be valid.");
    const record = {
      ...programRecord(creation.validation.program, creation.validation),
      validation: { issues: creation.validation.issues, status: "valid" as const },
    };
    const workingState = studioNativeWorkingState(nativeScene, {
      appliedEdits: [record],
      playhead: 0,
      selection: creation.entityIds,
    });
    const workingRevision = canonicalEditorWorkingRevision({
      appliedEdits: [record],
      draftEdit: null,
      editingAppliedProgram: null,
      redoPrograms: [],
    });
    const context = { ...identity, sourceDuration: snapshot.duration, workingRevision };

    const result = await compileStudioPreviewSceneV1({
      frame,
      snapshot,
      workingState,
      workingRevision,
      workspaceKey: studioPreviewWorkspaceKeyV1(context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle.scene.source.kind).toBe("studio-edit-program");
    expect(result.scene.bundle.scene.entities.find(({ id }) => id === creation.entityIds[0])?.geometry).toEqual({
      asset: imageAsset.image.asset,
      kind: "image",
      localRect: imageAsset.image.localRect,
      sampler: imageAsset.image.sampler,
    });
    expect(result.scene.creationProjection?.entities[0]?.entityId).toBe(creation.entityIds[0]);
  });

  it("compiles a duration-only draft on one exact Studio-native base", async () => {
    const { frame, identity, nativeScene, snapshot } = await nativePreviewInput(
      "e".repeat(64),
      "native-duration-project",
    );
    const extension = createSceneDurationProgram({
      capturedPlayhead: nativeScene.runtimeSceneState.duration,
      scene: nativeScene.runtimeSceneState,
      sourceAnchor: nativeScene.runtimeSceneState.duration,
      targetDuration: nativeScene.runtimeSceneState.duration + 2,
      transactionId: "native-duration-draft",
    });
    if (extension.kind !== "valid") throw new Error("Native duration fixture must be valid.");
    const record = programRecord(extension.program, extension);
    const workingState = studioNativeWorkingState(nativeScene, {
      playhead: nativeScene.runtimeSceneState.duration,
      selection: [],
      stagedEdits: [record],
    });
    const workingRevision = canonicalEditorWorkingRevision({
      appliedEdits: [],
      draftEdit: record,
      editingAppliedProgram: null,
      redoPrograms: [],
    });

    const result = await compileStudioPreviewSceneV1({
      frame,
      snapshot,
      workingState,
      workingRevision,
      workspaceKey: studioPreviewWorkspaceKeyV1({
        ...identity,
        sourceDuration: snapshot.duration,
        workingRevision,
      }),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle.scene.duration).toBeCloseTo(nativeScene.runtimeSceneState.duration + 2);
    expect(result.scene.timelineProjection?.projectedDuration).toBeCloseTo(nativeScene.runtimeSceneState.duration + 2);
    expect(result.scene.appliedTimelineProjection).toBeUndefined();
  });

  it("keeps an earlier staged creation separate from its exact applied duration prefix", async () => {
    const { frame, identity, nativeScene, snapshot } = await nativePreviewInput(
      "f".repeat(64),
      "native-duration-creation-project",
    );
    const extension = createSceneDurationProgram({
      capturedPlayhead: nativeScene.runtimeSceneState.duration,
      scene: nativeScene.runtimeSceneState,
      sourceAnchor: nativeScene.runtimeSceneState.duration,
      targetDuration: nativeScene.runtimeSceneState.duration + 2,
      transactionId: "native-duration-applied",
    });
    if (extension.kind !== "valid") throw new Error("Native duration fixture must be valid.");
    const extensionRecord = {
      ...programRecord(extension.program, extension),
      validation: { issues: extension.issues, status: "valid" as const },
    };
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ dimensions: { radius: 1 }, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: nativeScene.runtimeSceneState,
      transactionId: "native-earlier-circle-draft",
    });
    if (creation.validation.kind !== "valid") throw new Error("Native Circle fixture must be valid.");
    const creationRecord = programRecord(creation.validation.program, creation.validation);
    const workingState = studioNativeWorkingState(nativeScene, {
      appliedEdits: [extensionRecord],
      playhead: 1,
      selection: creation.entityIds,
      stagedEdits: [creationRecord],
    });
    const workingRevision = canonicalEditorWorkingRevision({
      appliedEdits: [extensionRecord],
      draftEdit: creationRecord,
      editingAppliedProgram: null,
      redoPrograms: [],
    });

    const result = await compileStudioPreviewSceneV1({
      frame,
      snapshot,
      workingState,
      workingRevision,
      workspaceKey: studioPreviewWorkspaceKeyV1({
        ...identity,
        sourceDuration: snapshot.duration,
        workingRevision,
      }),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.creationProjection?.projectedDuration).toBeCloseTo(
      nativeScene.runtimeSceneState.duration + 2.4,
    );
    expect(result.scene.creationProjection?.durationTrimBarrierOperationIds).toEqual([]);
    const [creationInsertion, durationInsertion] = result.scene.creationProjection?.insertions ?? [];
    expect(creationInsertion).toMatchObject({ at: 1, transactionId: creation.validation.program.transactionId });
    expect(creationInsertion?.duration).toBeCloseTo(0.4);
    expect(durationInsertion).toMatchObject({ duration: 2, transactionId: extension.program.transactionId });
    expect(durationInsertion?.at).toBeCloseTo(nativeScene.runtimeSceneState.duration + 0.4);
    expect(result.scene.appliedCreationProjection).toBeUndefined();
    expect(result.scene.appliedTimelineProjection?.projectedDuration).toBeCloseTo(
      nativeScene.runtimeSceneState.duration + 2,
    );
    expect(result.scene.appliedTimelineProjection?.transforms).toEqual([
      {
        interval: {
          end: nativeScene.runtimeSceneState.duration + 2,
          start: nativeScene.runtimeSceneState.duration,
        },
        kind: "insert",
        operationId: extension.program.operations[0]?.id,
      },
    ]);
  });

  it("drops stale presentation authority synchronously while a new material input compiles", () => {
    const previous = { fragmentMaterialInput: EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1 };
    const material = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "Wave" });
    const next = projectFragmentMaterialsForSceneV1(
      assignStudioFragmentMaterialV1(material.state, {
        entityId: "source:circle",
        sceneId: "studio:circle-scene",
        shaderId: material.shaderId,
      }),
      "studio:circle-scene",
    );

    expect(correlateStudioPreviewFragmentMaterialInputV1(previous, next)).toBeNull();
    const presented = { fragmentMaterialInput: next };
    expect(correlateStudioPreviewFragmentMaterialInputV1(presented, next)).toBe(presented);
  });

  it("resolves a source-bound fragment material through verified runtime identity before a colliding Scene ID", async () => {
    const base = await compilablePreviewInput();
    const runtimeEntity = base.snapshot.snapshot.scene.entities[0];
    if (!runtimeEntity) throw new Error("Expected the Circle preview entity.");
    const collisionBundle = await parseVerifiedSceneIrBundleV1({
      ...base.snapshot.snapshot,
      scene: {
        ...base.snapshot.snapshot.scene,
        entities: [runtimeEntity, { ...runtimeEntity, id: "source:circle", sceneOrder: runtimeEntity.sceneOrder + 1 }],
      },
    });
    const material = createStudioGradientFragmentMaterialPresetV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1);
    const assignedMaterial = assignStudioFragmentMaterialV1(material.state, {
      entityId: "source:circle",
      sceneId: "studio:circle-scene",
      shaderId: material.shaderId,
    });
    const sceneFragmentMaterials = projectFragmentMaterialsForSceneV1(
      updateStudioFragmentMaterialParameterV1(
        updateStudioFragmentMaterialParameterV1(assignedMaterial, {
          entityId: "source:circle",
          name: "Spread",
          sceneId: "studio:circle-scene",
          value: 2.25,
        }),
        {
          entityId: "source:circle",
          name: "Cool",
          sceneId: "studio:circle-scene",
          value: [0.1, 0.2, 0.3],
        },
      ),
      "studio:circle-scene",
    );
    const commands: ApplyStudioFragmentMaterialsWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioFragmentMaterialsCompiler: async (bundle, command) => {
        commands.push(command);
        return compileApplyStudioFragmentMaterials(bundle, command);
      },
      frame: { height: 9, width: 16 },
      sceneFragmentMaterials,
      snapshot: { ...base.snapshot, snapshot: collisionBundle },
      workingState: base.proposedState.base,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.assignments).toEqual([
      expect.objectContaining({
        entityId: "earlier",
        material: expect.objectContaining({ parameters: [0.75, 2.25, 0.1, 0.2, 0.3, 1, 0.3, 0.65], revision: 1 }),
      }),
    ]);
    expect(result.scene.fragmentMaterialInput).toBe(sceneFragmentMaterials);
    expect(result.scene.fragmentMaterialRegistry).toBe(sceneFragmentMaterials.registry);
    expect(result.scene.engineRevisionHash).not.toBe(base.snapshot.correlation.engineRevisionHash);
    const assigned = result.scene.bundle.scene.entities.find(({ id }) => id === "earlier");
    const collided = result.scene.bundle.scene.entities.find(({ id }) => id === "source:circle");
    expect(assigned?.appearance.kind === "vector" ? assigned.appearance.fill?.fragmentMaterial : null).toMatchObject({
      parameters: [0.75, 2.25, 0.1, 0.2, 0.3, 1, 0.3, 0.65],
      revision: 1,
      shaderId: material.shaderId,
    });
    expect(
      collided?.appearance.kind === "vector" ? collided.appearance.fill?.fragmentMaterial : undefined,
    ).toBeUndefined();
  });

  it("sends two selected material references and their exact registry through one core compile", async () => {
    const base = await compilablePreviewInput();
    const runtimeEntity = base.snapshot.snapshot.scene.entities[0];
    if (!runtimeEntity) throw new Error("Expected the Circle preview entity.");
    const bundle = await parseVerifiedSceneIrBundleV1({
      ...base.snapshot.snapshot,
      scene: {
        ...base.snapshot.snapshot.scene,
        entities: [runtimeEntity, { ...runtimeEntity, id: "later", sceneOrder: runtimeEntity.sceneOrder + 1 }],
      },
    });
    const first = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "First" });
    const second = createStudioFragmentMaterialV1(first.state, { name: "Second" });
    const firstAssigned = assignStudioFragmentMaterialV1(second.state, {
      entityId: "source:circle",
      sceneId: "studio:circle-scene",
      shaderId: first.shaderId,
    });
    const bothAssigned = assignStudioFragmentMaterialV1(firstAssigned, {
      entityId: "later",
      sceneId: "studio:circle-scene",
      shaderId: second.shaderId,
    });
    const sceneFragmentMaterials = projectFragmentMaterialsForSceneV1(bothAssigned, "studio:circle-scene");
    const commands: ApplyStudioFragmentMaterialsWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioFragmentMaterialsCompiler: async (candidate, command) => {
        commands.push(command);
        return compileApplyStudioFragmentMaterials(candidate, command);
      },
      frame: { height: 9, width: 16 },
      sceneFragmentMaterials,
      snapshot: { ...base.snapshot, snapshot: bundle },
      workingState: base.proposedState.base,
      workingRevision: PRISTINE_WORKING_REVISION,
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands[0]?.assignments).toEqual([
      expect.objectContaining({ entityId: "earlier", material: expect.objectContaining({ shaderId: first.shaderId }) }),
      expect.objectContaining({ entityId: "later", material: expect.objectContaining({ shaderId: second.shaderId }) }),
    ]);
    expect(result.scene.fragmentMaterialRegistry).toEqual(sceneFragmentMaterials.registry);
    expect(result.scene.fragmentMaterialRegistry?.materials.map(({ shaderId }) => shaderId)).toEqual([
      first.shaderId,
      second.shaderId,
    ]);
  });

  it("rejects animated server-snapshot motion before invoking a core planner", async () => {
    const base = await compilablePreviewInput();
    const importedSource = base.snapshot.snapshot.scene.source;
    if (importedSource.kind !== "imported-manim-server-snapshot") throw new Error("Expected an imported snapshot.");
    const workingBase = exactImportedTimelineWorkingBase(base);
    const validation = validateMotionProgramFixture({
      capturedPlayhead: 0.5,
      controlOffset: { x: 32, y: 18 },
      delta: { x: 64, y: -36 },
      interval: { end: 1.5, start: 0.5 },
      scene: workingBase.runtimeSceneState,
      targetEntityIds: ["source:circle"],
      transactionId: "create-static-motion",
    });
    if (validation.kind !== "valid") throw new Error("Static motion fixture did not validate.");
    const proposedState: WorkingState = {
      ...workingBase,
      appliedEdits: [programRecord(validation.program, validation)],
    };
    const snapshot = {
      ...base.snapshot,
      snapshot: {
        ...base.snapshot.snapshot,
        scene: {
          ...base.snapshot.snapshot.scene,
          source: importedSource,
          animationChannels: [
            {
              entityId: "earlier",
              id: "opacity:earlier",
              keyframes: [
                { at: 0, easingToNext: { kind: "linear" as const }, value: 0.5 },
                { at: 2, easingToNext: null, value: 1 },
              ],
              kind: "opacity" as const,
              provenanceId: "fixture",
            },
          ],
        },
      },
    };
    const commands: ApplyStudioMotionEditWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      applyStudioMotionEditCompiler: recordingMotionCompiler(commands),
      frame: { height: 9, width: 16 },
      snapshot,
      workingState: proposedState,
      workingRevision: "studio-working-v1:create-static-motion",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result).toMatchObject({
      error: "Editing an imported animation requires generic Runtime Trace authoring support.",
      kind: "unsupported",
    });
    expect(commands).toHaveLength(0);
  });

  it("composes a Studio-created entity over an exact animated imported snapshot", async () => {
    const base = await compilablePreviewInput();
    const sourceEntity = base.snapshot.snapshot.scene.entities[0];
    if (!sourceEntity) throw new Error("Expected an imported Scene entity.");
    const animatedBundle = await parseVerifiedSceneIrBundleV1({
      ...base.snapshot.snapshot,
      scene: {
        ...base.snapshot.snapshot.scene,
        animationChannels: [
          {
            entityId: sourceEntity.id,
            id: "opacity:imported",
            keyframes: [
              { at: 0, easingToNext: { kind: "linear" }, value: 0 },
              { at: 2, easingToNext: null, value: 1 },
            ],
            kind: "opacity",
            provenanceId: "fixture",
          },
        ],
        requiredCapabilities: ["opacity-animation", "shape-primitives"],
      },
    });
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ position: { x: 320, y: 180 }, type: "Circle" }],
      scene: base.proposedState.base.runtimeSceneState,
      transactionId: "create-over-animated-import",
    });
    if (creation.validation.kind !== "valid") throw new Error(JSON.stringify(creation.validation.issues));

    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      snapshot: { ...base.snapshot, snapshot: animatedBundle },
      workingState: {
        ...base.proposedState.base,
        appliedEdits: [programRecord(creation.validation.program, creation.validation)],
      },
      workingRevision: "studio-working-v1:create-over-animated-import",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.editAuthority).toBe("rust-authorized-batch");
    expect(result.scene.creationProjection?.entities.map(({ entityId }) => entityId)).toEqual(creation.entityIds);
    expect(result.scene.bundle.scene.entities.some(({ id }) => id === creation.entityIds[0])).toBe(true);
  });

  it("passes raw Studio motion facts and every operation to Rust", async () => {
    const base = await compilablePreviewInput();
    const workingBase = exactImportedTimelineWorkingBase(base);
    const validation = validateMotionProgramFixture({
      capturedPlayhead: 0.5,
      controlOffset: { x: 32, y: 18 },
      delta: { x: 64, y: -36 },
      interval: { end: 1.5, start: 0.5 },
      scene: workingBase.runtimeSceneState,
      targetEntityIds: ["source:circle"],
      transactionId: "create-static-motion",
    });
    if (validation.kind !== "valid") throw new Error("Static motion fixture did not validate.");
    const motion = validation.program.operations[0];
    if (!motion || motion.kind !== "CreateMotion") throw new Error("Motion fixture is malformed.");
    const rawMotion = { ...motion, dependsOn: ["missing-operation"] } as const;
    const followingMotion = {
      ...motion,
      controlOffset: { x: -8, y: 4 },
      delta: { x: -16, y: 8 },
      dependsOn: [motion.id],
      id: "following-motion",
      interval: { end: 2, start: 1.5 },
      provenance: motion.provenance,
    } as const;
    const workingState: WorkingState = {
      ...workingBase,
      appliedEdits: [
        {
          program: {
            ...validation.program,
            intentCount: 2,
            operations: [rawMotion, followingMotion],
            schedule: {
              edges: [{ from: motion.id, reason: "explicit", to: followingMotion.id }],
              mode: "sequence",
              order: [motion.id, followingMotion.id],
            },
          },
          validation: { issues: [], status: "valid" },
        },
      ],
    };
    const commands: ApplyStudioMotionEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioMotionEditCompiler: recordingMotionCompiler(commands),
      frame: { height: 9, width: 16 },
      projectStudioMotionCompiler: async () => ({
        insertions: [{ at: 0.5, duration: 1.5, transactionId: "create-static-motion" }],
        motions: [
          {
            control: { x: 384, y: 180 },
            controlOffset: rawMotion.controlOffset,
            delta: rawMotion.delta,
            easing: rawMotion.easing === "smooth" ? "manim-smooth" : "linear",
            from: { x: 320, y: 180 },
            interval: rawMotion.interval,
            operationId: rawMotion.id,
            orientToPath: false,
            sourceInterval: rawMotion.interval,
            targetEntityId: "source:circle",
            to: { x: 384, y: 144 },
            transactionId: "create-static-motion",
          },
          {
            control: { x: 368, y: 152 },
            controlOffset: followingMotion.controlOffset,
            delta: followingMotion.delta,
            easing: followingMotion.easing === "smooth" ? "manim-smooth" : "linear",
            from: { x: 384, y: 144 },
            interval: followingMotion.interval,
            operationId: followingMotion.id,
            orientToPath: false,
            sourceInterval: followingMotion.interval,
            targetEntityId: "source:circle",
            to: { x: 368, y: 152 },
            transactionId: "create-static-motion",
          },
        ],
        projectedDuration: base.snapshot.snapshot.scene.duration + 1.5,
      }),
      snapshot: base.snapshot,
      workingState,
      workingRevision: "studio-working-v1:create-static-motion",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      frame: { height: 9, width: 16 },
      programs: [
        {
          anchorCapturedPlayhead: 0.5,
          anchorResolvedSeconds: 0.5,
          anchorSource: { kind: "playhead", referenceSeconds: 0.5 },
          intentCount: 2,
          operations: [
            {
              controlOffset: { x: 32, y: 18 },
              delta: { x: 64, y: -36 },
              dependsOn: ["missing-operation"],
              kind: "create-motion",
              targetEntityIds: ["source:circle"],
            },
            {
              controlOffset: { x: -8, y: 4 },
              delta: { x: -16, y: 8 },
              dependsOn: [motion.id],
              kind: "create-motion",
              targetEntityIds: ["source:circle"],
            },
          ],
          requestedExecution: validation.program.requestedExecution,
          scheduleEdgeCount: 1,
          scheduleMode: "sequence",
          scheduleOrder: [motion.id, followingMotion.id],
          transactionId: "create-static-motion",
        },
      ],
      sourceRuntimeBindings: [{ runtimeEntityId: "earlier", sourceIdentityKey: "circle", sourceName: "circle" }],
      studioEntities: [{ objectGraphKey: "source:circle", provisional: false, sourceIdentity: "circle" }],
      viewport: { height: 360, width: 640 },
    });
  });

  it("passes every motion Program in the working history to Rust", async () => {
    const base = await compilablePreviewInput();
    const workingBase = exactImportedTimelineWorkingBase(base);
    const first = validateMotionProgramFixture({
      capturedPlayhead: 0.25,
      controlOffset: { x: 16, y: 9 },
      delta: { x: 32, y: -18 },
      interval: { end: 0.75, start: 0.25 },
      scene: workingBase.runtimeSceneState,
      targetEntityIds: ["source:circle"],
      transactionId: "first-motion",
    });
    const second = validateMotionProgramFixture({
      capturedPlayhead: 1,
      controlOffset: { x: -8, y: 4 },
      delta: { x: -16, y: 8 },
      interval: { end: 1.5, start: 1 },
      scene: workingBase.runtimeSceneState,
      targetEntityIds: ["source:circle"],
      transactionId: "second-motion",
    });
    if (first.kind !== "valid" || second.kind !== "valid") {
      throw new Error("Motion history fixture did not validate.");
    }
    const commands: ApplyStudioMotionEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioMotionEditCompiler: recordingMotionCompiler(commands),
      frame: { height: 9, width: 16 },
      projectStudioMotionCompiler: async () => ({
        insertions: [
          { at: 0.25, duration: 0.5, transactionId: "first-motion" },
          { at: 1.5, duration: 0.5, transactionId: "second-motion" },
        ],
        motions: [
          {
            control: { x: 352, y: 180 },
            controlOffset: { x: 16, y: 9 },
            delta: { x: 32, y: -18 },
            easing: "manim-smooth",
            from: { x: 320, y: 180 },
            interval: { end: 0.75, start: 0.25 },
            operationId: first.program.operations[0]!.id,
            orientToPath: false,
            sourceInterval: first.program.operations[0]!.interval,
            targetEntityId: "source:circle",
            to: { x: 352, y: 162 },
            transactionId: "first-motion",
          },
          {
            control: { x: 336, y: 170 },
            controlOffset: { x: -8, y: 4 },
            delta: { x: -16, y: 8 },
            easing: "manim-smooth",
            from: { x: 352, y: 162 },
            interval: { end: 2, start: 1.5 },
            operationId: second.program.operations[0]!.id,
            orientToPath: false,
            sourceInterval: second.program.operations[0]!.interval,
            targetEntityId: "source:circle",
            to: { x: 336, y: 170 },
            transactionId: "second-motion",
          },
        ],
        projectedDuration: base.snapshot.snapshot.scene.duration + 1,
      }),
      snapshot: base.snapshot,
      workingState: {
        ...workingBase,
        appliedEdits: [programRecord(first.program, first), programRecord(second.program, second)],
      },
      workingRevision: "studio-working-v1:two-motions",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    expect(result.scene.editAuthority).toBe("rust-authorized-batch");
    expect(commands[0]?.programs.map((program) => program.transactionId)).toEqual(["first-motion", "second-motion"]);
  });

  it("passes a pristine verified Line snapshot through without invoking the narrower Studio adapter", async () => {
    const { proposedState, snapshot } = await linePreviewInput();
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      snapshot,
      workingState: proposedState.base,
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

  it("passes one complete normalized Studio timeline edit to Rust", async () => {
    const base = await compilablePreviewInput();
    const workingBase = exactImportedTimelineWorkingBase(base);
    const extension = createSceneDurationProgram({
      capturedPlayhead: 1,
      scene: workingBase.runtimeSceneState,
      sourceAnchor: 1,
      targetDuration: 3,
      transactionId: "extend-imported-scene",
    });
    if (extension.kind !== "valid") throw new Error(JSON.stringify(extension.issues));
    const extensionRecord = programRecord(extension.program, extension);
    const timelineWorkingState = { ...workingBase, appliedEdits: [extensionRecord] };
    const commands: ApplyStudioTimelineEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioTimelineEditCompiler: recordingStudioTimelineCompiler(commands),
      frame: { height: 9, width: 16 },
      projectStudioTimelineCompiler: async () => ({
        programProjections: [
          {
            operationId: extension.program.operations[0]!.id,
            transactionId: extension.program.transactionId,
            workingAnchor: 1,
            workingInterval: { end: 2, start: 1 },
          },
        ],
        projectedDuration: 3,
        transforms: [
          {
            interval: { end: 2, start: 1 },
            kind: "insert",
            operationId: extension.program.operations[0]!.id,
          },
        ],
      }),
      snapshot: base.snapshot,
      workingState: timelineWorkingState,
      workingRevision: "studio-working-v1:extend-imported-scene",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    expect(result.scene.editAuthority).toBe("rust-authorized-batch");
    expect(result.scene.timelineProjection?.projectedDuration).toBe(3);
    expect(commands[0]).toMatchObject({
      expectedBaseRevision: base.snapshot.correlation.engineRevisionHash,
      nextRevision: result.scene.engineRevisionHash,
      programs: [
        {
          anchorCapturedPlayhead: 1,
          anchorResolvedSeconds: 1,
          anchorSource: { kind: "absolute", seconds: 1 },
          intentCount: 1,
          loweringSupported: true,
          operations: [
            {
              dependsOn: [],
              eventKind: "wait",
              id: extension.program.operations[0]?.id,
              interval: { end: 2, start: 1 },
              kind: "insert-wait",
              origin: "studio-default",
              purpose: "scene-duration",
            },
          ],
          origin: "studio-default",
          requestedExecution: "sequence",
          scheduleEdgeCount: 0,
          scheduleMode: "sequence",
          scheduleOrder: extension.program.schedule.order,
          transactionId: "extend-imported-scene",
        },
      ],
      schema: "poietra.apply-studio-timeline-edit",
      version: 1,
    });

    let compilerCalls = 0;
    const rejected = await compileStudioPreviewSceneV1({
      applyStudioTimelineEditCompiler: async (bundle) => {
        compilerCalls += 1;
        return bundle;
      },
      frame: { height: 9, width: 16 },
      snapshot: base.snapshot,
      workingState: {
        ...timelineWorkingState,
        documentSnapshot: undefined,
        sourceSnapshot: { ...timelineWorkingState.sourceSnapshot!, hash: `sha256:${HASH_B}` },
      },
      workingRevision: "studio-working-v1:inexact-imported-timeline-source",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });
    expect(rejected).toEqual({
      error: "The verified source snapshot is not one exact authorable Scene.",
      kind: "unsupported",
    });
    expect(compilerCalls).toBe(0);

    const coreRejected = await compileStudioPreviewSceneV1({
      applyStudioTimelineEditCompiler: async () => {
        throw "closed timeline authority rejected the edit";
      },
      frame: { height: 9, width: 16 },
      snapshot: base.snapshot,
      workingState: timelineWorkingState,
      workingRevision: "studio-working-v1:core-rejected-imported-timeline",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });
    expect(coreRejected).toEqual({
      error: "Rust core rejected the imported Scene timeline edit: closed timeline authority rejected the edit",
      kind: "unsupported",
    });
  });

  it("rejects an animated server-snapshot timeline edit before invoking the core use case", async () => {
    const base = await compilablePreviewInput();
    const importedSource = base.snapshot.snapshot.scene.source;
    if (importedSource.kind !== "imported-manim-server-snapshot") throw new Error("Expected an imported snapshot.");
    const animationChannels: SceneIrBundleV1["scene"]["animationChannels"] = [
      {
        entityId: "earlier",
        id: "opacity:earlier",
        keyframes: [
          { at: 0, easingToNext: { kind: "smooth" }, value: 0 },
          { at: 2, easingToNext: null, value: 1 },
        ],
        kind: "opacity",
        provenanceId: "fixture",
      },
    ];
    const animatedBundle = await parseVerifiedSceneIrBundleV1({
      ...base.snapshot.snapshot,
      scene: {
        ...base.snapshot.snapshot.scene,
        animationChannels,
        requiredCapabilities: ["opacity-animation", "shape-primitives"],
        source: importedSource,
      },
    });
    const snapshot = { ...base.snapshot, snapshot: animatedBundle };
    const workingBase = exactImportedTimelineWorkingBase({ ...base, snapshot });
    const extension = createSceneDurationProgram({
      capturedPlayhead: 1,
      scene: workingBase.runtimeSceneState,
      sourceAnchor: 1,
      targetDuration: 3,
      transactionId: "extend-animated-imported-scene",
    });
    if (extension.kind !== "valid") throw new Error(JSON.stringify(extension.issues));
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      applyStudioTimelineEditCompiler: async (bundle) => {
        compilerCalls += 1;
        expect(bundle.scene.animationChannels).toEqual(animationChannels);
        return { ...bundle, scene: { ...bundle.scene, duration: 3 } };
      },
      frame: { height: 9, width: 16 },
      snapshot,
      workingState: {
        ...workingBase,
        appliedEdits: [programRecord(extension.program, extension)],
      },
      workingRevision: "studio-working-v1:extend-animated-imported-scene",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    expect(result).toEqual({
      error: "Editing an imported animation requires generic Runtime Trace authoring support.",
      kind: "unsupported",
    });
    expect(compilerCalls).toBe(0);
  });

  it("forwards every Program and reports a mixed-family core rejection", async () => {
    const base = await compilablePreviewInput();
    const workingBase = exactImportedTimelineWorkingBase(base);
    const extension = createSceneDurationProgram({
      capturedPlayhead: 1,
      scene: workingBase.runtimeSceneState,
      sourceAnchor: 1,
      targetDuration: 3,
      transactionId: "timeline-with-appearance",
    });
    if (extension.kind !== "valid") throw new Error(JSON.stringify(extension.issues));
    const extensionRecord = programRecord(extension.program, extension);
    const unsupportedOperation = {
      dependsOn: [],
      entityId: "source:circle",
      id: "tx:appearance/operation:set-opacity",
      interval: { end: 0, start: 0 },
      key: "appearance",
      kind: "SetProperty",
      provenance: { evidence: ["unsupported appearance regression"], origin: "studio-default" },
      value: 0.5,
    } as const;
    const unsupportedRecord = {
      program: {
        ...extension.program,
        anchor: { ...extension.program.anchor, resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } as const },
        operations: [unsupportedOperation],
        schedule: { edges: [], mode: "sequence", order: [unsupportedOperation.id] } as const,
        transactionId: "appearance-only",
      },
      validation: { issues: [], status: "valid" },
    } as const;
    const commands: ApplyStudioTimelineEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioTimelineEditCompiler: recordingStudioTimelineCompiler(commands),
      frame: { height: 9, width: 16 },
      projectStudioTimelineCompiler: async () => {
        throw new Error("mixed timeline and appearance Programs are unsupported");
      },
      snapshot: base.snapshot,
      workingState: { ...workingBase, appliedEdits: [extensionRecord, unsupportedRecord] },
      workingRevision: "studio-working-v1:timeline-with-appearance",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    expect(result).toEqual({
      error:
        "Rust core rejected the imported Scene timeline edit: mixed timeline and appearance Programs are unsupported",
      kind: "unsupported",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.programs).toHaveLength(2);
    expect(commands[0]?.programs[0]?.operations[0]?.kind).toBe("insert-wait");
    expect(commands[0]?.programs[1]).toMatchObject({
      anchorCapturedPlayhead: 1,
      anchorResolvedSeconds: 0,
      anchorSource: { kind: "absolute", seconds: 0 },
      operations: [
        {
          dependsOn: [],
          id: unsupportedOperation.id,
          interval: unsupportedOperation.interval,
          kind: "unsupported",
          origin: "studio-default",
        },
      ],
      origin: "studio-default",
      scheduleOrder: [unsupportedOperation.id],
      transactionId: "appearance-only",
    });
  });

  it.each(["direct-manipulation", "studio-default"] as const)(
    "passes one %s static root move and its verified identity binding to Rust",
    async (origin) => {
      const fixture = await editedStaticRootPreviewInput({ origin });
      if (!fixture.operationId) throw new Error("Static root move fixture lost its operation ID.");
      const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];
      const result = await compileStudioPreviewSceneV1({
        applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(commands),
        frame: { height: 9, width: 16 },
        snapshot: fixture.snapshot,
        workingState: fixture.workingState,
        workingRevision: fixture.workingRevision,
        workspaceKey: fixture.workspaceKey,
      });

      if (result.kind !== "compiled") throw new Error(result.error);
      expect(result.scene.editAuthority).toBe("static-imported-root");
      expect(result.scene.staticRootProjection?.mutations).toEqual([
        expect.objectContaining({ kind: "position", operationId: fixture.operationId }),
      ]);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        expectedBaseRevision: fixture.snapshot.correlation.engineRevisionHash,
        frame: { height: 9, width: 16 },
        nextRevision: result.scene.engineRevisionHash,
        programs: [
          {
            anchorCapturedPlayhead: 0,
            anchorResolvedSeconds: 0,
            anchorSource: { kind: "playhead", referenceSeconds: 0 },
            intentCount: 1,
            loweringSupported: true,
            operations: [
              {
                dependsOn: [],
                entityId: "source:circle",
                id: fixture.operationId,
                interval: { end: 0, start: 0 },
                kind: "position",
                origin,
                position: { x: 384, y: 144 },
              },
            ],
            origin,
            requestedExecution: fixture.programRecord.program.requestedExecution,
            scheduleEdgeCount: fixture.programRecord.program.schedule.edges.length,
            scheduleMode: fixture.programRecord.program.schedule.mode,
            scheduleOrder: fixture.programRecord.program.schedule.order,
            transactionId: fixture.programRecord.program.transactionId,
          },
        ],
        schema: "poietra.apply-static-root-transform-edit",
        sourceRuntimeBindings: [{ runtimeEntityId: "earlier", sourceIdentityKey: "circle", sourceName: "circle" }],
        studioEntities: [
          {
            id: "source:circle",
            kind: "circle",
            objectGraphKey: "source:circle",
            provisional: false,
            sourceIdentity: "circle",
          },
        ],
        version: 1,
        viewport: { height: 360, width: 640 },
      });
      expect(result.scene.interactionEntityIds).toEqual(["earlier"]);
    },
  );

  it("replays imported multi-root transform histories for preview, undo, and redo", async () => {
    const fixture = await editedStaticRootPreviewInput();
    const firstRuntime = fixture.snapshot.snapshot.scene.entities[0];
    const firstStudio = fixture.workingState.runtimeSceneState.objectGraph.entities["source:circle"];
    if (!firstRuntime || !firstStudio?.geometry) throw new Error("Static root move fixture is incomplete.");
    const snapshotBundle = await parseVerifiedSceneIrBundleV1({
      ...fixture.snapshot.snapshot,
      scene: {
        ...fixture.snapshot.snapshot.scene,
        entities: [
          ...fixture.snapshot.snapshot.scene.entities,
          { ...firstRuntime, id: "second-root", sceneOrder: firstRuntime.sceneOrder + 1 },
        ],
      },
    });
    const secondStudio = {
      ...firstStudio,
      geometry: {
        ...firstStudio.geometry,
        position: { kind: "known" as const, value: { x: 400, y: 180 } },
      },
      id: "source:second",
      sourceIdentity: { kind: "known" as const, value: "second" },
    };
    const workingBase: WorkingState = {
      ...fixture.workingState,
      appliedEdits: [],
      editorContext: {
        ...fixture.workingState.editorContext,
        selection: ["source:circle", "source:second"],
      },
      runtimeSceneState: {
        ...fixture.workingState.runtimeSceneState,
        objectGraph: {
          ...fixture.workingState.runtimeSceneState.objectGraph,
          entities: {
            ...fixture.workingState.runtimeSceneState.objectGraph.entities,
            "source:second": secondStudio,
          },
        },
      },
      staticSemanticState: {
        ...fixture.workingState.staticSemanticState,
        entities: [
          ...fixture.workingState.staticSemanticState.entities,
          {
            runtimeIdentities: { kind: "known", value: ["source:second"] },
            sourceIdentity: "second",
            type: { kind: "known", value: "Circle" },
          },
        ],
      },
    };
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 20, y: -10 },
      positions: {
        "source:circle": { x: 320, y: 180 },
        "source:second": { x: 400, y: 180 },
      },
      scene: workingBase.runtimeSceneState,
      start: 0,
      targetEntityIds: ["source:circle", "source:second"],
      transactionId: "move-imported-selection",
    });
    if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));
    const record = {
      ...programRecord(validation.program, validation),
      validation: { issues: validation.issues, status: "valid" as const },
    };
    const secondValidation = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 30, y: 20 },
      positions: {
        "source:circle": { x: 340, y: 170 },
        "source:second": { x: 420, y: 170 },
      },
      scene: workingBase.runtimeSceneState,
      start: 0,
      targetEntityIds: ["source:circle", "source:second"],
      transactionId: "move-imported-selection-again",
    });
    if (secondValidation.kind !== "valid") throw new Error(JSON.stringify(secondValidation.issues));
    const secondRecord = {
      ...programRecord(secondValidation.program, secondValidation),
      validation: { issues: secondValidation.issues, status: "valid" as const },
    };
    const appliedEdits = [record, secondRecord];
    const correlatedSnapshot = {
      ...fixture.snapshot,
      snapshot: snapshotBundle,
      sourceRuntimeIdentity: new Map([
        ["circle", { bindingId: "binding:circle", entityId: "earlier", sourceName: "circle" }],
        ["second", { bindingId: "binding:second", entityId: "second-root", sourceName: "second" }],
      ]),
    } satisfies StudioVerifiedPreviewSnapshotV1;
    const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(
        commands,
        compileApplyStaticRootTransformEdit,
      ),
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.editAuthority).toBe("static-imported-root");
    expect(result.scene.staticRootProjection?.mutations).toEqual([
      expect.objectContaining({ entityId: "source:circle", kind: "position" }),
      expect.objectContaining({ entityId: "source:second", kind: "position" }),
      expect.objectContaining({ entityId: "source:circle", kind: "position", value: { x: 370, y: 190 } }),
      expect.objectContaining({ entityId: "source:second", kind: "position", value: { x: 450, y: 190 } }),
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.programs).toHaveLength(2);
    expect(commands[0]?.programs[0]?.operations).toMatchObject([
      { entityId: "source:circle", kind: "position", position: { x: 340, y: 170 } },
      { entityId: "source:second", kind: "position", position: { x: 420, y: 170 } },
    ]);
    expect(commands[0]?.programs[1]?.operations).toMatchObject([
      { entityId: "source:circle", kind: "position", position: { x: 370, y: 190 } },
      { entityId: "source:second", kind: "position", position: { x: 450, y: 190 } },
    ]);
    for (const entityId of ["earlier", "second-root"]) {
      const entity = result.scene.bundle.scene.entities.find(({ id }) => id === entityId);
      expect(entity?.transform.tx).toBeCloseTo(1.25);
      expect(entity?.transform.ty).toBeCloseTo(-0.25);
    }
    expect(result.scene.interactionEntityIds).toEqual(["earlier", "second-root"]);

    const undo = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: compileApplyStaticRootTransformEdit,
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits: [record] },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits: [record],
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [{ kind: "mutation", mutation: { index: 1, kind: "append", value: secondRecord } }],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (undo.kind !== "compiled") throw new Error(undo.error);
    for (const entityId of ["earlier", "second-root"]) {
      const entity = undo.scene.bundle.scene.entities.find(({ id }) => id === entityId);
      expect(entity?.transform.tx).toBeCloseTo(0.5);
      expect(entity?.transform.ty).toBeCloseTo(0.25);
    }

    const redo = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: compileApplyStaticRootTransformEdit,
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (redo.kind !== "compiled") throw new Error(redo.error);
    expect(redo.scene.bundle).toEqual(result.scene.bundle);

    const resizeValidation = createDirectManipulationGroupResizeProgram({
      capturedPlayhead: 0,
      scene: workingBase.runtimeSceneState,
      start: 0,
      targets: [
        { entityId: "source:circle", fromScale: 1, toPosition: { x: 350, y: 190 }, toScale: 1.5 },
        { entityId: "source:second", fromScale: 1, toPosition: { x: 470, y: 190 }, toScale: 1.5 },
      ],
      transactionId: "resize-imported-selection",
    });
    if (resizeValidation.kind !== "valid") throw new Error(JSON.stringify(resizeValidation.issues));
    const resizeRecord = {
      ...programRecord(resizeValidation.program, resizeValidation),
      validation: { issues: resizeValidation.issues, status: "valid" as const },
    };
    const resizedAppliedEdits = [...appliedEdits, resizeRecord];
    const resizedCommands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    const resized = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(
        resizedCommands,
        compileApplyStaticRootTransformEdit,
      ),
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits: resizedAppliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits: resizedAppliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (resized.kind !== "compiled") throw new Error(resized.error);
    expect(resizedCommands[0]?.programs.at(-1)?.operations).toMatchObject([
      { entityId: "source:circle", kind: "position", position: { x: 350, y: 190 } },
      { entityId: "source:second", kind: "position", position: { x: 470, y: 190 } },
      { entityId: "source:circle", from: 1, kind: "uniform-scale", to: 1.5 },
      { entityId: "source:second", from: 1, kind: "uniform-scale", to: 1.5 },
    ]);
    expect(resized.scene.staticRootProjection?.mutations.slice(-4)).toEqual([
      expect.objectContaining({ entityId: "source:circle", kind: "position", value: { x: 350, y: 190 } }),
      expect.objectContaining({ entityId: "source:second", kind: "position", value: { x: 470, y: 190 } }),
      expect.objectContaining({ entityId: "source:circle", from: 1, kind: "uniform-scale", to: 1.5 }),
      expect.objectContaining({ entityId: "source:second", from: 1, kind: "uniform-scale", to: 1.5 }),
    ]);
    for (const entityId of ["earlier", "second-root"]) {
      const entity = resized.scene.bundle.scene.entities.find(({ id }) => id === entityId);
      expect(entity?.transform.m11).toBeCloseTo(1.5);
      expect(entity?.transform.m22).toBeCloseTo(1.5);
    }

    const secondResizeValidation = createDirectManipulationGroupResizeProgram({
      capturedPlayhead: 0,
      scene: workingBase.runtimeSceneState,
      start: 0,
      targets: [
        { entityId: "source:circle", fromScale: 1.5, toPosition: { x: 330, y: 190 }, toScale: 2 },
        { entityId: "source:second", fromScale: 1.5, toPosition: { x: 490, y: 190 }, toScale: 2 },
      ],
      transactionId: "resize-imported-selection-again",
    });
    if (secondResizeValidation.kind !== "valid") {
      throw new Error(JSON.stringify(secondResizeValidation.issues));
    }
    const secondResizeRecord = {
      ...programRecord(secondResizeValidation.program, secondResizeValidation),
      validation: { issues: secondResizeValidation.issues, status: "valid" as const },
    };
    const resizedTwiceAppliedEdits = [...resizedAppliedEdits, secondResizeRecord];
    const resizedTwice = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: compileApplyStaticRootTransformEdit,
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits: resizedTwiceAppliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits: resizedTwiceAppliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (resizedTwice.kind !== "compiled") throw new Error(resizedTwice.error);
    expect(resizedTwice.scene.staticRootProjection?.mutations.slice(-4)).toEqual([
      expect.objectContaining({ entityId: "source:circle", kind: "position", value: { x: 330, y: 190 } }),
      expect.objectContaining({ entityId: "source:second", kind: "position", value: { x: 490, y: 190 } }),
      expect.objectContaining({ entityId: "source:circle", from: 1.5, kind: "uniform-scale", to: 2 }),
      expect.objectContaining({ entityId: "source:second", from: 1.5, kind: "uniform-scale", to: 2 }),
    ]);
    for (const entityId of ["earlier", "second-root"]) {
      const entity = resizedTwice.scene.bundle.scene.entities.find(({ id }) => id === entityId);
      expect(entity?.transform.m11).toBeCloseTo(2);
      expect(entity?.transform.m22).toBeCloseTo(2);
    }

    const rotationValidation = createDirectManipulationGroupRotationProgram({
      angleRadians: Math.PI / 2,
      capturedPlayhead: 0,
      scene: workingBase.runtimeSceneState,
      start: 0,
      targets: [
        { entityId: "source:circle", toPosition: { x: 410, y: 230 } },
        { entityId: "source:second", toPosition: { x: 410, y: 150 } },
      ],
      transactionId: "rotate-imported-selection",
    });
    if (rotationValidation.kind !== "valid") throw new Error(JSON.stringify(rotationValidation.issues));
    const rotationRecord = {
      ...programRecord(rotationValidation.program, rotationValidation),
      validation: { issues: rotationValidation.issues, status: "valid" as const },
    };
    const rotatedAppliedEdits = [...appliedEdits, rotationRecord];
    const rotatedCommands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    const rotated = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(
        rotatedCommands,
        compileApplyStaticRootTransformEdit,
      ),
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits: rotatedAppliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits: rotatedAppliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (rotated.kind !== "compiled") throw new Error(rotated.error);
    expect(rotatedCommands[0]?.programs.at(-1)?.operations).toMatchObject([
      { entityId: "source:circle", kind: "position", position: { x: 410, y: 230 } },
      { entityId: "source:second", kind: "position", position: { x: 410, y: 150 } },
      { entityId: "source:circle", kind: "rotation", relativeDelta: Math.PI / 2 },
      { entityId: "source:second", kind: "rotation", relativeDelta: Math.PI / 2 },
    ]);
    expect(rotated.scene.staticRootProjection?.mutations.slice(-4)).toEqual([
      expect.objectContaining({ entityId: "source:circle", kind: "position", value: { x: 410, y: 230 } }),
      expect.objectContaining({ entityId: "source:second", kind: "position", value: { x: 410, y: 150 } }),
      expect.objectContaining({ entityId: "source:circle", kind: "rotation", to: Math.PI / 2 }),
      expect.objectContaining({ entityId: "source:second", kind: "rotation", to: Math.PI / 2 }),
    ]);
    for (const entityId of ["earlier", "second-root"]) {
      const entity = rotated.scene.bundle.scene.entities.find(({ id }) => id === entityId);
      expect(entity?.transform.m11).toBeCloseTo(0);
      expect(Math.abs(entity?.transform.m12 ?? 0)).toBeCloseTo(1);
    }

    const secondRotationValidation = createDirectManipulationGroupRotationProgram({
      angleRadians: Math.PI / 2,
      capturedPlayhead: 0,
      scene: workingBase.runtimeSceneState,
      start: 0,
      targets: [
        { entityId: "source:circle", toPosition: { x: 450, y: 190 } },
        { entityId: "source:second", toPosition: { x: 370, y: 190 } },
      ],
      transactionId: "rotate-imported-selection-again",
    });
    if (secondRotationValidation.kind !== "valid") {
      throw new Error(JSON.stringify(secondRotationValidation.issues));
    }
    const secondRotationRecord = {
      ...programRecord(secondRotationValidation.program, secondRotationValidation),
      validation: { issues: secondRotationValidation.issues, status: "valid" as const },
    };
    const rotatedTwiceAppliedEdits = [...rotatedAppliedEdits, secondRotationRecord];
    const rotatedTwice = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: compileApplyStaticRootTransformEdit,
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits: rotatedTwiceAppliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits: rotatedTwiceAppliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (rotatedTwice.kind !== "compiled") throw new Error(rotatedTwice.error);
    expect(rotatedTwice.scene.staticRootProjection?.mutations.slice(-4)).toEqual([
      expect.objectContaining({ entityId: "source:circle", kind: "position", value: { x: 450, y: 190 } }),
      expect.objectContaining({ entityId: "source:second", kind: "position", value: { x: 370, y: 190 } }),
      expect.objectContaining({ entityId: "source:circle", kind: "rotation", to: Math.PI / 2 }),
      expect.objectContaining({ entityId: "source:second", kind: "rotation", to: Math.PI / 2 }),
    ]);
    for (const entityId of ["earlier", "second-root"]) {
      const entity = rotatedTwice.scene.bundle.scene.entities.find(({ id }) => id === entityId);
      expect(entity?.transform.m11).toBeCloseTo(-1);
      expect(entity?.transform.m22).toBeCloseTo(-1);
      expect(entity?.transform.m12).toBeCloseTo(0);
      expect(entity?.transform.m21).toBeCloseTo(0);
    }

    const rotationAfterResizeValidation = createDirectManipulationGroupRotationProgram({
      angleRadians: Math.PI / 2,
      capturedPlayhead: 0,
      scene: workingBase.runtimeSceneState,
      start: 0,
      targets: [
        { entityId: "source:circle", toPosition: { x: 410, y: 250 } },
        { entityId: "source:second", toPosition: { x: 410, y: 130 } },
      ],
      transactionId: "rotate-imported-selection-after-resize",
    });
    if (rotationAfterResizeValidation.kind !== "valid") {
      throw new Error(JSON.stringify(rotationAfterResizeValidation.issues));
    }
    const rotationAfterResizeRecord = {
      ...programRecord(rotationAfterResizeValidation.program, rotationAfterResizeValidation),
      validation: { issues: rotationAfterResizeValidation.issues, status: "valid" as const },
    };
    const resizedThenRotatedAppliedEdits = [...resizedAppliedEdits, rotationAfterResizeRecord];
    const resizedThenRotated = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: compileApplyStaticRootTransformEdit,
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits: resizedThenRotatedAppliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits: resizedThenRotatedAppliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (resizedThenRotated.kind !== "compiled") throw new Error(resizedThenRotated.error);

    const resizeAfterRotationValidation = createDirectManipulationGroupResizeProgram({
      capturedPlayhead: 0,
      scene: workingBase.runtimeSceneState,
      start: 0,
      targets: [
        {
          entityId: "source:circle",
          fromScale: 1,
          toPosition: { x: 410, y: 250 },
          toScale: 1.5,
        },
        {
          entityId: "source:second",
          fromScale: 1,
          toPosition: { x: 410, y: 130 },
          toScale: 1.5,
        },
      ],
      transactionId: "resize-imported-selection-after-rotation",
    });
    if (resizeAfterRotationValidation.kind !== "valid") {
      throw new Error(JSON.stringify(resizeAfterRotationValidation.issues));
    }
    const resizeAfterRotationRecord = {
      ...programRecord(resizeAfterRotationValidation.program, resizeAfterRotationValidation),
      validation: { issues: resizeAfterRotationValidation.issues, status: "valid" as const },
    };
    const rotatedThenResizedAppliedEdits = [...rotatedAppliedEdits, resizeAfterRotationRecord];
    const rotatedThenResized = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: compileApplyStaticRootTransformEdit,
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits: rotatedThenResizedAppliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits: rotatedThenResizedAppliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (rotatedThenResized.kind !== "compiled") throw new Error(rotatedThenResized.error);

    expect(
      resizedThenRotated.scene.staticRootProjection?.mutations.slice(-8).map(({ transactionId }) => transactionId),
    ).toEqual([
      "resize-imported-selection",
      "resize-imported-selection",
      "resize-imported-selection",
      "resize-imported-selection",
      "rotate-imported-selection-after-resize",
      "rotate-imported-selection-after-resize",
      "rotate-imported-selection-after-resize",
      "rotate-imported-selection-after-resize",
    ]);
    expect(
      rotatedThenResized.scene.staticRootProjection?.mutations.slice(-8).map(({ transactionId }) => transactionId),
    ).toEqual([
      "rotate-imported-selection",
      "rotate-imported-selection",
      "rotate-imported-selection",
      "rotate-imported-selection",
      "resize-imported-selection-after-rotation",
      "resize-imported-selection-after-rotation",
      "resize-imported-selection-after-rotation",
      "resize-imported-selection-after-rotation",
    ]);
    for (const entityId of ["earlier", "second-root"]) {
      for (const composition of [resizedThenRotated, rotatedThenResized]) {
        const entity = composition.scene.bundle.scene.entities.find(({ id }) => id === entityId);
        expect(entity?.transform.m11).toBeCloseTo(0);
        expect(entity?.transform.m22).toBeCloseTo(0);
        expect(Math.abs(entity?.transform.m12 ?? 0)).toBeCloseTo(1.5);
        expect(Math.abs(entity?.transform.m21 ?? 0)).toBeCloseTo(1.5);
      }
    }

    const secondRotationUndo = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: compileApplyStaticRootTransformEdit,
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits: rotatedAppliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits: rotatedAppliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [{ kind: "mutation", mutation: { index: 3, kind: "append", value: secondRotationRecord } }],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (secondRotationUndo.kind !== "compiled") throw new Error(secondRotationUndo.error);
    expect(secondRotationUndo.scene.staticRootProjection).toEqual(rotated.scene.staticRootProjection);
    for (const entityId of ["earlier", "second-root"]) {
      expect(secondRotationUndo.scene.bundle.scene.entities.find(({ id }) => id === entityId)?.transform).toEqual(
        rotated.scene.bundle.scene.entities.find(({ id }) => id === entityId)?.transform,
      );
    }

    const rotationUndo = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: compileApplyStaticRootTransformEdit,
      frame: { height: 9, width: 16 },
      snapshot: correlatedSnapshot,
      workingState: { ...workingBase, appliedEdits },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits,
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [{ kind: "mutation", mutation: { index: 2, kind: "append", value: rotationRecord } }],
      }),
      workspaceKey: fixture.workspaceKey,
    });
    if (rotationUndo.kind !== "compiled") throw new Error(rotationUndo.error);
    expect(rotationUndo.scene.staticRootProjection?.mutations).toHaveLength(4);
    for (const entityId of ["earlier", "second-root"]) {
      expect(rotationUndo.scene.bundle.scene.entities.find(({ id }) => id === entityId)?.transform).toEqual(
        result.scene.bundle.scene.entities.find(({ id }) => id === entityId)?.transform,
      );
    }
  });

  it("routes an imported static move followed by motion through one static-root Rust command", async () => {
    const fixture = await editedStaticRootPreviewInput();
    const motion = validateMotionProgramFixture({
      capturedPlayhead: 0,
      controlOffset: { x: 32, y: 18 },
      delta: { x: 64, y: -36 },
      interval: { end: 1, start: 0 },
      scene: fixture.workingState.runtimeSceneState,
      targetEntityIds: ["source:circle"],
      transactionId: "move-transformed-imported-root",
    });
    if (motion.kind !== "valid") throw new Error(JSON.stringify(motion.issues));
    const motionOperation = motion.program.operations[0];
    if (motionOperation?.kind !== "CreateMotion") throw new Error("Imported motion fixture is malformed.");
    const staticCommands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    const motionCommands: ApplyStudioMotionEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(
        staticCommands,
        async (bundle) => ({
          ...unchangedAuthoringResult(bundle),
          motionProjection: {
            insertions: [{ at: 0, duration: 1, transactionId: motion.program.transactionId }],
            motions: [
              {
                control: { x: 448, y: 144 },
                controlOffset: motionOperation.controlOffset,
                delta: motionOperation.delta,
                easing: motionOperation.easing === "smooth" ? "manim-smooth" : "linear",
                from: { x: 384, y: 144 },
                interval: motionOperation.interval,
                operationId: motionOperation.id,
                orientToPath: false,
                sourceInterval: motionOperation.interval,
                targetEntityId: "source:circle",
                to: { x: 448, y: 108 },
                transactionId: motion.program.transactionId,
              },
            ],
            projectedDuration: bundle.scene.duration + 1,
          },
          staticRootProjection: {
            insertions: [{ at: 0, duration: 1, transactionId: motion.program.transactionId }],
            mutations: [
              {
                entityId: "source:circle",
                interval: { end: 0, start: 0 },
                kind: "position",
                operationId: fixture.operationId!,
                transactionId: fixture.programRecord.program.transactionId,
                value: { x: 384, y: 144 },
              },
            ],
            projectedDuration: bundle.scene.duration + 1,
          },
        }),
      ),
      applyStudioMotionEditCompiler: recordingMotionCompiler(motionCommands),
      frame: { height: 9, width: 16 },
      snapshot: fixture.snapshot,
      workingState: {
        ...fixture.workingState,
        appliedEdits: [fixture.programRecord, programRecord(motion.program, motion)],
      },
      workingRevision: "studio-working-v1:static-then-motion",
      workspaceKey: fixture.workspaceKey,
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(staticCommands).toHaveLength(1);
    expect(motionCommands).toHaveLength(0);
    expect(staticCommands[0]?.programs.map(({ transactionId }) => transactionId)).toEqual([
      fixture.programRecord.program.transactionId,
      motion.program.transactionId,
    ]);
    expect(staticCommands[0]?.programs[1]?.operations).toEqual([
      {
        controlOffset: motionOperation.controlOffset,
        delta: motionOperation.delta,
        dependsOn: motionOperation.dependsOn,
        easing: motionOperation.easing,
        id: motionOperation.id,
        interval: motionOperation.interval,
        kind: "create-motion",
        origin: motionOperation.provenance.origin,
        targetEntityIds: motionOperation.targetEntityIds,
      },
    ]);
  });

  it("passes motion-before-static order to Rust and surfaces its closed-contract rejection", async () => {
    const fixture = await editedStaticRootPreviewInput();
    const motion = validateMotionProgramFixture({
      capturedPlayhead: 0,
      controlOffset: { x: 0, y: 0 },
      delta: { x: 64, y: 0 },
      interval: { end: 1, start: 0 },
      scene: fixture.workingState.runtimeSceneState,
      targetEntityIds: ["source:circle"],
      transactionId: "motion-before-static",
    });
    if (motion.kind !== "valid") throw new Error(JSON.stringify(motion.issues));
    const staticCommands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    const motionCommands: ApplyStudioMotionEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(staticCommands, async () => {
        throw new Error("motion-before-static is unsupported");
      }),
      applyStudioMotionEditCompiler: recordingMotionCompiler(motionCommands),
      frame: { height: 9, width: 16 },
      snapshot: fixture.snapshot,
      workingState: {
        ...fixture.workingState,
        appliedEdits: [programRecord(motion.program, motion), fixture.programRecord],
      },
      workingRevision: "studio-working-v1:motion-before-static",
      workspaceKey: fixture.workspaceKey,
    });

    expect(result).toEqual({
      error: "Rust core rejected the static imported root edit: motion-before-static is unsupported",
      kind: "unsupported",
    });
    expect(staticCommands).toHaveLength(1);
    expect(staticCommands[0]?.programs.map(({ transactionId }) => transactionId)).toEqual([
      motion.program.transactionId,
      fixture.programRecord.program.transactionId,
    ]);
    expect(motionCommands).toHaveLength(0);
  });

  it("routes an imported persistent remove through the static-root Rust use case", async () => {
    const fixture = await compilablePreviewInput();
    const workingBase = exactImportedTimelineWorkingBase(fixture);
    const removal = createRemoveEntitiesProgram({
      capturedPlayhead: 0.5,
      entityIds: ["source:circle"],
      scene: workingBase.runtimeSceneState,
      transactionId: "remove-imported-circle",
    });
    expect(removal.kind, JSON.stringify(removal.issues)).toBe("valid");
    const operation = removal.program.operations[0];
    if (operation?.kind !== "ChangePresence") throw new Error("Expected a persistent remove operation.");
    const projection = {
      removals: [
        {
          affectedSceneEntityIds: [fixture.snapshot.snapshot.scene.entities[0]!.id],
          fadeInterval: operation.interval,
          operationId: operation.id,
          removedAt: operation.interval.end,
          resultingLifetimeEnd: operation.interval.end,
          sceneEntityId: fixture.snapshot.snapshot.scene.entities[0]!.id,
          studioEntityId: operation.entityId,
          transactionId: removal.program.transactionId,
        },
      ],
    } as const;
    const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: async (bundle, command) => {
        commands.push(command);
        return { bundle, persistentRemoveProjection: projection };
      },
      frame: { height: 9, width: 16 },
      snapshot: fixture.snapshot,
      workingState: {
        ...workingBase,
        appliedEdits: [programRecord(removal.program, removal)],
      },
      workingRevision: "studio-working-v1:remove-imported-circle",
      workspaceKey: studioPreviewWorkspaceKeyV1(fixture.context),
    });

    expect(commands[0]?.programs[0]?.operations).toEqual([
      expect.objectContaining({ entityId: "source:circle", kind: "persistent-remove", persistent: true }),
    ]);
    expect(result).toMatchObject({ kind: "compiled", scene: { persistentRemoveProjection: projection } });
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.editAuthority).toBe("rust-authorized-batch");
  });

  it("keeps Rust static-root and persistent-remove projections for one combined batch", async () => {
    const fixture = await editedStaticRootPreviewInput();
    const removal = createRemoveEntitiesProgram({
      capturedPlayhead: 0.5,
      entityIds: ["source:circle"],
      scene: fixture.workingState.runtimeSceneState,
      transactionId: "remove-moved-imported-circle",
    });
    if (removal.kind !== "valid") throw new Error(JSON.stringify(removal.issues));
    const removeOperation = removal.program.operations[0];
    if (removeOperation?.kind !== "ChangePresence") throw new Error("Expected a persistent remove operation.");
    const staticRootProjection = {
      insertions: [],
      mutations: [
        {
          entityId: "source:circle",
          interval: { end: 0, start: 0 },
          kind: "position" as const,
          operationId: fixture.operationId!,
          transactionId: fixture.programRecord.program.transactionId,
          value: { x: 384, y: 144 },
        },
      ],
      projectedDuration: fixture.snapshot.snapshot.scene.duration,
    };
    const persistentRemoveProjection = {
      removals: [
        {
          affectedSceneEntityIds: [fixture.snapshot.snapshot.scene.entities[0]!.id],
          fadeInterval: removeOperation.interval,
          operationId: removeOperation.id,
          removedAt: removeOperation.interval.end,
          resultingLifetimeEnd: removeOperation.interval.end,
          sceneEntityId: fixture.snapshot.snapshot.scene.entities[0]!.id,
          studioEntityId: removeOperation.entityId,
          transactionId: removal.program.transactionId,
        },
      ],
    } as const;
    const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(commands, async (bundle) => ({
        ...unchangedAuthoringResult(bundle),
        persistentRemoveProjection,
        staticRootProjection,
      })),
      frame: { height: 9, width: 16 },
      snapshot: fixture.snapshot,
      workingState: {
        ...fixture.workingState,
        appliedEdits: [fixture.programRecord, programRecord(removal.program, removal)],
      },
      workingRevision: "studio-working-v1:move-then-remove-imported-circle",
      workspaceKey: fixture.workspaceKey,
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands[0]?.programs.map(({ transactionId }) => transactionId)).toEqual([
      fixture.programRecord.program.transactionId,
      removal.program.transactionId,
    ]);
    expect(result.scene).toMatchObject({
      persistentRemoveProjection,
      editAuthority: "static-imported-root",
      staticRootProjection,
    });
  });

  it("keeps one Magic Edit scale-then-remove Program atomic through the Rust compiler route", async () => {
    const fixture = await compilablePreviewInput();
    const base = exactImportedTimelineWorkingBase(fixture);
    const entity = base.runtimeSceneState.objectGraph.entities["source:circle"]!;
    const workingBase: WorkingState = {
      ...base,
      runtimeSceneState: {
        ...base.runtimeSceneState,
        objectGraph: {
          ...base.runtimeSceneState.objectGraph,
          entities: {
            ...base.runtimeSceneState.objectGraph.entities,
            "source:circle": {
              ...entity,
              geometry: entity.geometry
                ? {
                    ...entity.geometry,
                    position: { kind: "known", value: { x: 280, y: 180 } },
                  }
                : undefined,
            },
          },
        },
      },
    };
    const operation: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 0.5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          easing: "smooth",
          end: 1,
          factor: 1.5,
          kind: "scale-objects",
          start: 0.5,
          targetObjectIds: ["source:circle"],
        },
        {
          animation: "fade-out",
          end: 1.4,
          kind: "delete-objects",
          start: 1,
          targetObjectIds: ["source:circle"],
        },
      ],
    };
    const validation = canonicalizeSuggestionProgram(operation, {
      capturedPlayhead: 0.5,
      origin: "remote-model",
      scene: workingBase.runtimeSceneState,
      transactionId: "magic-scale-remove",
    });
    if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));
    const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(
        commands,
        compileApplyStaticRootTransformEdit,
      ),
      frame: { height: 9, width: 16 },
      snapshot: fixture.snapshot,
      workingState: {
        ...workingBase,
        appliedEdits: [programRecord(validation.program, validation)],
      },
      workingRevision: "studio-working-v1:magic-scale-remove",
      workspaceKey: studioPreviewWorkspaceKeyV1(fixture.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.programs).toHaveLength(1);
    expect(commands[0]?.programs[0]?.operations.map(({ kind }) => kind)).toEqual([
      "uniform-scale",
      "persistent-remove",
    ]);
    expect(result.scene.editAuthority).toBe("static-imported-root");
    expect(result.scene.bundle.scene.duration).toBeCloseTo(2.9);
    expect(result.scene.staticRootProjection).toMatchObject({
      insertions: [{ at: 0.5, transactionId: "magic-scale-remove" }],
      mutations: [{ easing: "manim-smooth", kind: "uniform-scale" }],
      projectedDuration: 2.9,
    });
    expect(result.scene.persistentRemoveProjection?.removals[0]).toMatchObject({
      fadeInterval: { end: 1.4, start: 1 },
      resultingLifetimeEnd: 1.4,
      studioEntityId: "source:circle",
    });
  });

  it("rejects Runtime Trace persistent remove before invoking the static-root Rust use case", async () => {
    const fixture = await compilablePreviewInput();
    const workingBase = exactImportedTimelineWorkingBase(fixture);
    const removal = createRemoveEntitiesProgram({
      capturedPlayhead: 0.5,
      entityIds: ["source:circle"],
      scene: workingBase.runtimeSceneState,
      transactionId: "remove-runtime-trace-circle",
    });
    expect(removal.kind, JSON.stringify(removal.issues)).toBe("valid");
    let compilerCalls = 0;

    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: async (bundle) => {
        compilerCalls += 1;
        return unchangedAuthoringResult(bundle);
      },
      frame: { height: 9, width: 16 },
      snapshot: {
        ...fixture.snapshot,
        snapshot: {
          ...fixture.snapshot.snapshot,
          scene: {
            ...fixture.snapshot.snapshot.scene,
            source: {
              kind: "imported-manim-runtime-trace",
              runtimeConfigHash: HASH_B,
              sourceHash: fixture.context.sourceHash,
              traceDigest: HASH_C,
              traceVersion: 3,
            },
          },
        },
      },
      workingState: {
        ...workingBase,
        appliedEdits: [programRecord(removal.program, removal)],
      },
      workingRevision: "studio-working-v1:remove-runtime-trace-circle",
      workspaceKey: studioPreviewWorkspaceKeyV1(fixture.context),
    });

    expect(result).toMatchObject({
      error: "Persistent remove requires one exactly correlated static Scene snapshot.",
      kind: "unsupported",
    });
    expect(compilerCalls).toBe(0);
  });

  it("passes ResizeEntity to Rust without reconstructing a transform intent in TypeScript", async () => {
    const fixture = await verifiedStaticPrimitivePreviewInput("Rectangle");
    const validation = createDirectManipulationResizeProgram({
      capturedPlayhead: 0,
      entityId: fixture.entityId,
      from: { dimensions: fixture.dimensions, position: fixture.position },
      interval: { end: 0, start: 0 },
      scale: 1,
      scene: fixture.workingBase.runtimeSceneState,
      shape: "rectangle",
      to: { dimensions: { height: 1.5, width: 4 }, position: { x: 420, y: 190 } },
      transactionId: "resize-imported-rectangle",
    });
    if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));
    const record = {
      ...programRecord(validation.program, validation),
      validation: { issues: validation.issues, status: "valid" as const },
    };
    const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(commands),
      frame: { height: 9, width: 16 },
      snapshot: fixture.snapshot,
      workingState: { ...fixture.workingBase, appliedEdits: [record] },
      workingRevision: canonicalEditorWorkingRevision({
        appliedEdits: [record],
        draftEdit: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });

    expect(result.kind).toBe("compiled");
    expect(commands[0]?.programs).toHaveLength(1);
    expect(commands[0]?.programs[0]?.operations[0]).toMatchObject({
      kind: "resize",
      shape: "rectangle",
    });
  });

  it("surfaces a Rust static-root rejection as an unsupported preview", async () => {
    const fixture = await editedStaticRootPreviewInput();
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: async () => {
        throw new Error("the edit contains an unsupported operation");
      },
      frame: { height: 9, width: 16 },
      snapshot: fixture.snapshot,
      workingState: fixture.workingState,
      workingRevision: fixture.workingRevision,
      workspaceKey: fixture.workspaceKey,
    });

    expect(result).toMatchObject({
      error: expect.stringContaining("the edit contains an unsupported operation"),
      kind: "unsupported",
    });
  });

  it("withholds an exact static-root preview when Rust omits its workspace projection", async () => {
    const fixture = await editedStaticRootPreviewInput();
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: async (bundle) => unchangedAuthoringResult(bundle),
      frame: { height: 9, width: 16 },
      snapshot: fixture.snapshot,
      workingState: fixture.workingState,
      workingRevision: fixture.workingRevision,
      workspaceKey: fixture.workspaceKey,
    });

    expect(result).toEqual({
      error: "Rust core did not return the static-root projection for the exact current Program batch.",
      kind: "unsupported",
    });
  });

  it("rejects mismatched source correlation before invoking the Rust static-root use case", async () => {
    const fixture = await editedStaticRootPreviewInput();
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: async (bundle) => {
        compilerCalls += 1;
        return unchangedAuthoringResult(bundle);
      },
      frame: { height: 9, width: 16 },
      snapshot: fixture.snapshot,
      workingState: {
        ...fixture.workingState,
        documentSnapshot: undefined,
        sourceSnapshot: { ...fixture.workingState.sourceSnapshot!, hash: `sha256:${HASH_B}` },
      },
      workingRevision: fixture.workingRevision,
      workspaceKey: fixture.workspaceKey,
    });

    expect(result).toMatchObject({ error: expect.stringContaining("not correlated"), kind: "unsupported" });
    expect(compilerCalls).toBe(0);
  });

  it("restores the exact verified snapshot after undo returns to zero applied Programs", async () => {
    const { proposedState, snapshot } = await linePreviewInput();
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      snapshot,
      workingState: proposedState.base,
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

  it("attaches compiled MathTex outlines and sends only the logical root for fragment material assignment", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const texParts = ["\\frac{a}{b}"];
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [
        {
          content: { displayLines: texParts, label: texParts.join(""), texParts },
          position: { x: 400, y: 180 },
          type: "MathTex",
        },
      ],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "normalized-mathtex",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const createOperation = creation.validation.program.operations.find(({ kind }) => kind === "CreateEntity");
    const positionOperation = creation.validation.program.operations.find(
      (operation) => operation.kind === "SetProperty" && operation.key === "position",
    );
    const fadeOperation = creation.validation.program.operations.find(
      (operation) => operation.kind === "ChangePresence" && operation.effect === "fade-in",
    );
    if (
      createOperation?.kind !== "CreateEntity" ||
      positionOperation?.kind !== "SetProperty" ||
      !isPointValue(positionOperation.value) ||
      fadeOperation?.kind !== "ChangePresence"
    ) {
      throw new Error("MathTex creation fixture is malformed.");
    }
    const creationProjection: StudioCreationProjectionV1 = {
      durationTrimBarrierOperationIds: [],
      entities: [
        {
          createdLifetime: {
            end: proposedState.base.runtimeSceneState.duration + 0.4,
            start: createOperation.entity.lifetime.start,
          },
          entityId: creation.entityIds[0]!,
          initialDimensions: {},
          initialRotation: 0,
          initialScale: 1,
          kind: "math-tex",
          operationId: createOperation.id,
          texParts,
          transactionId: creation.validation.program.transactionId,
        },
      ],
      insertions: [{ at: 0.5, duration: 0.4, transactionId: creation.validation.program.transactionId }],
      motions: [],
      mutations: [
        {
          entityId: creation.entityIds[0]!,
          interval: positionOperation.interval,
          kind: "position",
          operationId: positionOperation.id,
          transactionId: creation.validation.program.transactionId,
          value: positionOperation.value,
        },
        {
          entityId: creation.entityIds[0]!,
          from: 0,
          interval: fadeOperation.interval,
          kind: "fade-in",
          operationId: fadeOperation.id,
          to: 1,
          transactionId: creation.validation.program.transactionId,
        },
      ],
      projectedDuration: proposedState.base.runtimeSceneState.duration + 0.4,
      removals: [],
      timelineProjection: {
        programProjections: [],
        projectedDuration: proposedState.base.runtimeSceneState.duration + 0.4,
        transforms: [],
      },
    };
    const compilerInputs: string[][] = [];
    const commands: ApplyStudioCreationEditWireCommandV1[] = [];
    const materialCommands: ApplyStudioFragmentMaterialsWireCommandV1[] = [];
    const outline = compiledMathTexResponse();
    const material = createStudioGradientFragmentMaterialPresetV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1);
    const sceneFragmentMaterials = projectFragmentMaterialsForSceneV1(
      assignStudioFragmentMaterialV1(material.state, {
        entityId: creation.entityIds[0]!,
        sceneId: "studio:circle-scene",
        shaderId: material.shaderId,
      }),
      "studio:circle-scene",
    );

    const result = await compileStudioPreviewSceneV1({
      applyStudioCreationEditCompiler: async (bundle, command) => {
        commands.push(command);
        const sourceEntity = bundle.scene.entities[0];
        const compiled = outline.result;
        if (!sourceEntity || compiled.kind !== "compiled") throw new Error("Text preview fixture is malformed.");
        const textEntity = {
          ...sourceEntity,
          appearance: {
            fill: { color: { alpha: 1, blue: 1, green: 1, red: 1 }, rule: "nonzero" as const },
            kind: "vector" as const,
            opacity: 1,
            stroke: null,
          },
          geometry: { kind: "cubic-path" as const, path: compiled.path },
          id: creation.entityIds[0]!,
          lifetimes: [creationProjection.entities[0]!.createdLifetime],
          sceneOrder: bundle.scene.entities.length,
        };
        const outlineEntity = {
          ...textEntity,
          id: `${textEntity.id}/write/fragment-0000/outline`,
          parentId: textEntity.id,
          sceneOrder: textEntity.sceneOrder + 1,
        };
        const fillEntity = {
          ...textEntity,
          id: `${textEntity.id}/write/fragment-0000/fill`,
          parentId: textEntity.id,
          sceneOrder: textEntity.sceneOrder + 2,
        };
        return {
          ...unchangedAuthoringResult({
            ...bundle,
            scene: {
              ...bundle.scene,
              duration: creationProjection.projectedDuration,
              entities: [...bundle.scene.entities, textEntity, outlineEntity, fillEntity],
              requiredCapabilities: [
                ...new Set([...bundle.scene.requiredCapabilities, "cubic-path-geometry" as const]),
              ],
            },
          }),
          creationProjection,
        };
      },
      applyStudioFragmentMaterialsCompiler: async (bundle, command) => {
        materialCommands.push(command);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async (input) => {
        compilerInputs.push([...input]);
        return outline;
      },
      snapshot,
      workingState: {
        ...proposedState.base,
        appliedEdits: [programRecord(creation.validation.program, creation.validation)],
      },
      sceneFragmentMaterials,
      workingRevision: "studio-working-v1:normalized-mathtex",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result.kind).toBe("compiled");
    expect(compilerInputs).toEqual([texParts]);
    const compiled = outline.result;
    if (compiled.kind !== "compiled") throw new Error("MathTex test outline must compile.");
    expect(commands[0]?.mathTexOutlines).toEqual([{ entityId: creation.entityIds[0], path: compiled.path, texParts }]);
    expect(commands[0]?.programs[0]?.operations[0]).toMatchObject({
      entity: { id: creation.entityIds[0], kind: "math-tex", lifetimeEnd: null, texParts },
      kind: "create",
    });
    expect(materialCommands[0]?.assignments.map(({ entityId }) => entityId)).toEqual([creation.entityIds[0]]);
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.creationProjection).toEqual(creationProjection);
    expect(result.scene.bundle.scene.entities.find(({ id }) => id === creation.entityIds[0])?.geometry).toEqual({
      kind: "cubic-path",
      path: compiled.path,
    });
    expect(
      result.scene.interactionEntityIds.filter(
        (entityId) => entityId === creation.entityIds[0] || entityId.startsWith(`${creation.entityIds[0]}/write/`),
      ),
    ).toEqual([creation.entityIds[0]]);
  });

  it("compiles Studio-created MathTex transform targets in the creation batch", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [
        {
          content: { displayLines: ["A"], label: "A", texParts: ["A"] },
          position: { x: 400, y: 180 },
          type: "MathTex",
        },
      ],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "studio-mathtex-root",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const rootEntityId = creation.entityIds[0]!;
    const transform: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          easing: "smooth",
          id: "studio-mathtex-transform/operation:replace",
          interval: { end: 2, start: 1 },
          kind: "TransformContent",
          provenance: { evidence: [], origin: "direct-manipulation" },
          replacement: { displayLines: ["B"], label: "B", texParts: ["B"] },
          sourceEntityId: rootEntityId,
          strategy: "replacement-transform",
          targetEntityId: "tx:studio-mathtex-transform/entity:math-tex-transform-target",
          targetType: "MathTex",
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: ["studio-mathtex-transform/operation:replace"] },
      transactionId: "studio-mathtex-transform",
      version: 1,
    };
    const compilerInputs: string[][] = [];
    const commands: ApplyStudioCreationEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioCreationEditCompiler: async (_bundle, command) => {
        commands.push(command);
        throw new Error("captured Studio MathTex transform command");
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async (input) => {
        compilerInputs.push([...input]);
        return compiledMathTexResponse();
      },
      snapshot,
      workingState: {
        ...proposedState.base,
        appliedEdits: [
          programRecord(creation.validation.program, creation.validation),
          programRecord(transform, { issues: [], kind: "valid" }),
        ],
      },
      workingRevision: "studio-working-v1:mathtex-transform",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(compilerInputs).toEqual([["A"], ["B"]]);
    expect(commands[0]?.programs.at(-1)?.operations).toEqual([
      expect.objectContaining({
        easing: "smooth",
        entityId: rootEntityId,
        kind: "transform-content",
        sourceEntityId: rootEntityId,
        targetEntityId: "tx:studio-mathtex-transform/entity:math-tex-transform-target",
      }),
    ]);
    expect(result).toEqual({
      error: "Rust core rejected Studio entity creation: captured Studio MathTex transform command",
      kind: "unsupported",
    });
  });

  it("attaches a compiled Text outline to the normalized Rust command", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const sourceText = "Mono text\r\n012345";
    const text = "Mono text\n012345";
    const textContent = {
      layout: {
        alignment: "right" as const,
        fontFamily: "mono" as const,
        fontSize: 1.5,
        fontWeight: "bold" as const,
        lineHeight: 1.8,
      },
      text,
    };
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [
        {
          content: {
            displayLines: [sourceText],
            text: sourceText,
            textLayout: {
              alignment: "right",
              fontFamily: "mono",
              fontSize: 1.5,
              fontWeight: "bold",
              lineHeight: 1.8,
            },
          },
          position: { x: 320, y: 180 },
          type: "Text",
        },
      ],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "normalized-text",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const createOperation = creation.validation.program.operations.find(({ kind }) => kind === "CreateEntity");
    const positionOperation = creation.validation.program.operations.find(
      (operation) => operation.kind === "SetProperty" && operation.key === "position",
    );
    const fadeOperation = creation.validation.program.operations.find(
      (operation) => operation.kind === "ChangePresence" && operation.effect === "fade-in",
    );
    if (
      createOperation?.kind !== "CreateEntity" ||
      positionOperation?.kind !== "SetProperty" ||
      !isPointValue(positionOperation.value) ||
      fadeOperation?.kind !== "ChangePresence"
    ) {
      throw new Error("Text creation fixture is malformed.");
    }
    const creationProjection: StudioCreationProjectionV1 = {
      durationTrimBarrierOperationIds: [],
      entities: [
        {
          createdLifetime: {
            end: proposedState.base.runtimeSceneState.duration + 0.4,
            start: createOperation.entity.lifetime.start,
          },
          entityId: creation.entityIds[0]!,
          initialDimensions: {},
          initialRotation: 0,
          initialScale: 1,
          kind: "text",
          operationId: createOperation.id,
          layout: textContent.layout,
          text: textContent.text,
          transactionId: creation.validation.program.transactionId,
        },
      ],
      insertions: [{ at: 0.5, duration: 0.4, transactionId: creation.validation.program.transactionId }],
      motions: [],
      mutations: [
        {
          entityId: creation.entityIds[0]!,
          interval: positionOperation.interval,
          kind: "position",
          operationId: positionOperation.id,
          transactionId: creation.validation.program.transactionId,
          value: positionOperation.value,
        },
        {
          entityId: creation.entityIds[0]!,
          from: 0,
          interval: fadeOperation.interval,
          kind: "fade-in",
          operationId: fadeOperation.id,
          to: 1,
          transactionId: creation.validation.program.transactionId,
        },
      ],
      projectedDuration: proposedState.base.runtimeSceneState.duration + 0.4,
      removals: [],
      timelineProjection: {
        programProjections: [],
        projectedDuration: proposedState.base.runtimeSceneState.duration + 0.4,
        transforms: [],
      },
    };
    const commands: ApplyStudioCreationEditWireCommandV1[] = [];
    const compilerInputs: TextOutlineInputV1[] = [];
    const outline = compiledTextResponse(text);

    const result = await compileStudioPreviewSceneV1({
      applyStudioCreationEditCompiler: async (bundle, command) => {
        commands.push(command);
        const sourceEntity = bundle.scene.entities[0];
        const compiled = outline.result;
        if (!sourceEntity || compiled.kind !== "compiled") throw new Error("Text preview fixture is malformed.");
        const textEntity = {
          ...sourceEntity,
          appearance: {
            fill: { color: { alpha: 1, blue: 1, green: 1, red: 1 }, rule: "nonzero" as const },
            kind: "vector" as const,
            opacity: 1,
            stroke: null,
          },
          geometry: { kind: "cubic-path" as const, path: compiled.path },
          id: creation.entityIds[0]!,
          lifetimes: [creationProjection.entities[0]!.createdLifetime],
          sceneOrder: bundle.scene.entities.length,
        };
        return {
          ...unchangedAuthoringResult({
            ...bundle,
            scene: {
              ...bundle.scene,
              duration: creationProjection.projectedDuration,
              entities: [...bundle.scene.entities, textEntity],
              requiredCapabilities: [
                ...new Set([...bundle.scene.requiredCapabilities, "cubic-path-geometry" as const]),
              ],
            },
          }),
          creationProjection,
        };
      },
      frame: { height: 9, width: 16 },
      snapshot,
      textOutlineCompiler: async (input) => {
        compilerInputs.push(input);
        return outline;
      },
      workingState: {
        ...proposedState.base,
        appliedEdits: [programRecord(creation.validation.program, creation.validation)],
      },
      workingRevision: "studio-working-v1:normalized-text",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result.kind).toBe("compiled");
    expect(compilerInputs).toEqual([
      {
        layout: { alignment: "right", fontFamily: "mono", fontWeight: "bold", lineHeight: 1.8 },
        text: textContent.text,
      },
    ]);
    expect(commands).toHaveLength(1);
    const compiled = outline.result;
    if (compiled.kind !== "compiled") throw new Error("Text test outline must compile.");
    expect(commands[0]?.textOutlines).toEqual([
      {
        entityId: creation.entityIds[0],
        fragments: compiled.fragments,
        layout: textContent.layout,
        path: compiled.path,
        text: textContent.text,
      },
    ]);
    expect(commands[0]?.programs[0]?.operations[0]).toMatchObject({
      entity: {
        id: creation.entityIds[0],
        kind: "text",
        layout: textContent.layout,
        text: textContent.text,
        texParts: null,
      },
      kind: "create",
    });
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.creationProjection).toEqual(creationProjection);
    expect(result.scene.bundle.scene.entities.find(({ id }) => id === creation.entityIds[0])?.geometry).toEqual({
      kind: "cubic-path",
      path: compiled.path,
    });
  });

  it("fails closed when Rust omits the complete Studio Text creation projection", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const text = "Hello Text";
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [
        {
          content: { displayLines: [text], text },
          position: { x: 320, y: 180 },
          type: "Text",
        },
      ],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "missing-text-projection",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");

    const result = await compileStudioPreviewSceneV1({
      applyStudioCreationEditCompiler: async (bundle) => unchangedAuthoringResult(bundle),
      frame: { height: 9, width: 16 },
      snapshot,
      textOutlineCompiler: async (input) => compiledTextResponse(input.text),
      workingState: {
        ...proposedState.base,
        appliedEdits: [programRecord(creation.validation.program, creation.validation)],
      },
      workingRevision: "studio-working-v1:missing-text-projection",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result).toEqual({
      error: "Rust core returned an uncorrelated Studio creation projection.",
      kind: "unsupported",
    });
  });

  it("passes one complete imported MathTex A-to-B-to-A Program with both outlines to Rust", async () => {
    const fixture = await importedMathTexPreviewInput();
    const firstTargetEntityId = "tx:mathtex-chain/entity:maxwell";
    const finalTargetEntityId = "tx:mathtex-chain/entity:restored";
    const maxwellTex = String.raw`\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}`;
    const firstOperation = {
      dependsOn: [],
      id: "tx:mathtex-chain/operation:maxwell",
      interval: { end: 1, start: 0 },
      kind: "TransformContent" as const,
      provenance: { evidence: [], origin: "remote-model" as const },
      replacement: { displayLines: ["Maxwell equations"], label: "Maxwell", texParts: [maxwellTex] },
      sourceEntityId: fixture.entityId,
      strategy: "transform-matching-tex" as const,
      targetEntityId: firstTargetEntityId,
      targetType: "MathTex",
    };
    const secondOperation = {
      dependsOn: [firstOperation.id],
      id: "tx:mathtex-chain/operation:restore",
      interval: { end: 2, start: 1 },
      kind: "TransformContent" as const,
      provenance: { evidence: [], origin: "remote-model" as const },
      replacement: { displayLines: ["E = mc^2"], texParts: ["E = mc^2"] },
      sourceEntityId: firstTargetEntityId,
      strategy: "transform-matching-tex" as const,
      targetEntityId: finalTargetEntityId,
      targetType: "MathTex",
    };
    const program: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 0,
        evidence: ["captured-playhead:0.000"],
        resolvedSeconds: 0,
        source: { kind: "playhead", referenceSeconds: 0 },
      },
      intentCount: 2,
      loweringStatus: "supported",
      operations: [firstOperation, secondOperation],
      provenance: { evidence: [], origin: "remote-model" },
      requestedExecution: "sequence",
      schedule: {
        edges: [
          { from: firstOperation.id, reason: "explicit", to: secondOperation.id },
          { from: firstOperation.id, reason: "identity", to: secondOperation.id },
        ],
        mode: "sequence",
        order: [firstOperation.id, secondOperation.id],
      },
      transactionId: "mathtex-chain",
      version: 1,
    };
    const commands: ApplyStudioMathTexTransformEditWireCommandV1[] = [];
    const compilerInputs: string[][] = [];
    const baseEntity = fixture.snapshot.snapshot.scene.entities[0];
    if (!baseEntity) throw new Error("Imported MathTex Scene IR fixture is empty.");
    const mathTexTransformProjection = {
      insertions: [{ at: 0, duration: 2, transactionId: "mathtex-chain" }],
      motions: [],
      projectedDuration: fixture.snapshot.snapshot.scene.duration + 2,
      replacements: [
        {
          content: firstOperation.replacement,
          interval: firstOperation.interval,
          operationId: firstOperation.id,
          sourceEntityId: firstOperation.sourceEntityId,
          targetEntityId: firstOperation.targetEntityId,
          targetLifetime: { end: 2, start: 0 },
          targetType: "math-tex" as const,
          transactionId: "mathtex-chain",
        },
        {
          content: secondOperation.replacement,
          interval: secondOperation.interval,
          operationId: secondOperation.id,
          sourceEntityId: secondOperation.sourceEntityId,
          targetEntityId: secondOperation.targetEntityId,
          targetLifetime: { end: fixture.snapshot.snapshot.scene.duration + 2, start: 1 },
          targetType: "math-tex" as const,
          transactionId: "mathtex-chain",
        },
      ],
    };

    const result = await compileStudioPreviewSceneV1({
      applyStudioMathTexTransformEditCompiler: async (bundle, command) => {
        commands.push(command);
        return {
          bundle: {
            ...bundle,
            scene: {
              ...bundle.scene,
              entities: [
                ...bundle.scene.entities,
                { ...baseEntity, id: firstTargetEntityId },
                { ...baseEntity, id: finalTargetEntityId },
              ],
            },
          },
          mathTexTransformProjection,
          persistentRemoveProjection: { removals: [] },
        };
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async (texParts) => {
        compilerInputs.push([...texParts]);
        return compiledMathTexResponse({ content: `${compilerInputs.length}`.repeat(64) });
      },
      snapshot: fixture.snapshot,
      workingState: {
        ...fixture.workingState,
        appliedEdits: [programRecord(program, { issues: [], kind: "valid" })],
      },
      workingRevision: "studio-working-v1:mathtex-chain",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });

    expect(compilerInputs).toEqual([[maxwellTex], ["E = mc^2"]]);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.programs[0]).toMatchObject({
      intentCount: 2,
      requestedExecution: "sequence",
      scheduleEdgeCount: 2,
      scheduleOrder: [firstOperation.id, secondOperation.id],
      transactionId: "mathtex-chain",
    });
    expect(commands[0]?.programs[0]?.operations).toEqual([
      expect.objectContaining({
        dependsOn: [],
        kind: "transform-content",
        replacement: firstOperation.replacement,
        sourceEntityId: fixture.entityId,
        strategy: "transform-matching-tex",
        targetEntityId: firstTargetEntityId,
      }),
      expect.objectContaining({
        dependsOn: [firstOperation.id],
        kind: "transform-content",
        replacement: secondOperation.replacement,
        sourceEntityId: firstTargetEntityId,
        strategy: "transform-matching-tex",
        targetEntityId: finalTargetEntityId,
      }),
    ]);
    expect(commands[0]?.mathTexOutlines.map(({ entityId, texParts }) => ({ entityId, texParts }))).toEqual([
      { entityId: firstTargetEntityId, texParts: [maxwellTex] },
      { entityId: finalTargetEntityId, texParts: ["E = mc^2"] },
    ]);
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.interactionEntityIds).toContain(finalTargetEntityId);
    expect(result.scene.mathTexTransformProjection).toEqual(mathTexTransformProjection);
    expect(result.scene.editAuthority).toBe("rust-authorized-batch");

    const missingProjection = await compileStudioPreviewSceneV1({
      applyStudioMathTexTransformEditCompiler: async (bundle) => unchangedAuthoringResult(bundle),
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => compiledMathTexResponse(),
      snapshot: fixture.snapshot,
      workingState: {
        ...fixture.workingState,
        appliedEdits: [programRecord(program, { issues: [], kind: "valid" })],
      },
      workingRevision: "studio-working-v1:missing-mathtex-transform-projection",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(missingProjection).toEqual({
      error: "Rust core did not return the complete MathTex transform projection.",
      kind: "unsupported",
    });
  });

  it("passes a same-Program MathTex transform and final-target motion through one Rust command", async () => {
    const fixture = await importedMathTexPreviewInput();
    const targetEntityId = "tx:mathtex-motion/entity:target";
    const transform = {
      dependsOn: [],
      id: "tx:mathtex-motion/operation:transform",
      interval: { end: 1, start: 0 },
      kind: "TransformContent" as const,
      provenance: { evidence: [], origin: "remote-model" as const },
      replacement: { displayLines: ["B"], texParts: ["B"] },
      sourceEntityId: fixture.entityId,
      strategy: "transform-matching-tex" as const,
      targetEntityId,
      targetType: "MathTex",
    };
    const motion = {
      controlOffset: { x: 10, y: 5 },
      delta: { x: 40, y: -20 },
      dependsOn: [transform.id],
      easing: "smooth" as const,
      id: "tx:mathtex-motion/operation:motion",
      interval: { end: 2, start: 1 },
      kind: "CreateMotion" as const,
      provenance: { evidence: [], origin: "remote-model" as const },
      targetEntityIds: [targetEntityId],
    };
    const program: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 0,
        evidence: [],
        resolvedSeconds: 0,
        source: { kind: "playhead", referenceSeconds: 0 },
      },
      intentCount: 2,
      loweringStatus: "supported",
      operations: [transform, motion],
      provenance: { evidence: [], origin: "remote-model" },
      requestedExecution: "sequence",
      schedule: {
        edges: [
          { from: transform.id, reason: "explicit", to: motion.id },
          { from: transform.id, reason: "identity", to: motion.id },
        ],
        mode: "sequence",
        order: [transform.id, motion.id],
      },
      transactionId: "mathtex-motion",
      version: 1,
    };
    const commands: ApplyStudioMathTexTransformEditWireCommandV1[] = [];
    const baseEntity = fixture.snapshot.snapshot.scene.entities[0];
    if (!baseEntity) throw new Error("Imported MathTex Scene IR fixture is empty.");
    const projection: StudioMathTexTransformProjectionV1 = {
      insertions: [{ at: 0, duration: 2, transactionId: program.transactionId }],
      motions: [
        {
          control: { x: 430, y: 215 },
          controlOffset: motion.controlOffset,
          delta: motion.delta,
          easing: "manim-smooth",
          from: { x: 400, y: 220 },
          interval: motion.interval,
          operationId: motion.id,
          orientToPath: false,
          sourceInterval: motion.interval,
          targetEntityId,
          to: { x: 440, y: 200 },
          transactionId: program.transactionId,
        },
      ],
      projectedDuration: fixture.snapshot.snapshot.scene.duration + 2,
      replacements: [
        {
          content: transform.replacement,
          interval: transform.interval,
          operationId: transform.id,
          sourceEntityId: transform.sourceEntityId,
          targetEntityId,
          targetLifetime: { end: fixture.snapshot.snapshot.scene.duration + 2, start: 0 },
          targetType: "math-tex",
          transactionId: program.transactionId,
        },
      ],
    };

    const result = await compileStudioPreviewSceneV1({
      applyStudioMathTexTransformEditCompiler: async (bundle, command) => {
        commands.push(command);
        return {
          bundle: {
            ...bundle,
            scene: { ...bundle.scene, entities: [...bundle.scene.entities, { ...baseEntity, id: targetEntityId }] },
          },
          mathTexTransformProjection: projection,
          persistentRemoveProjection: { removals: [] },
        };
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => compiledMathTexResponse(),
      snapshot: fixture.snapshot,
      workingState: {
        ...fixture.workingState,
        appliedEdits: [programRecord(program, { issues: [], kind: "valid" })],
      },
      workingRevision: "studio-working-v1:mathtex-motion",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      frame: { height: 9, width: 16 },
      viewport: { height: 360, width: 640 },
    });
    expect(commands[0]?.programs[0]?.operations).toEqual([
      expect.objectContaining({ kind: "transform-content", targetEntityId }),
      expect.objectContaining({
        controlOffset: motion.controlOffset,
        delta: motion.delta,
        easing: motion.easing,
        kind: "create-motion",
        targetEntityIds: [targetEntityId],
      }),
    ]);
    expect(
      commands[0]?.studioEntities.find(({ objectGraphKey }) => objectGraphKey === fixture.entityId)?.position,
    ).toEqual({ x: 400, y: 220 });
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.mathTexTransformProjection).toEqual(projection);
  });

  it("passes imported MathTex move and scale Programs to Rust without rebuilding geometry in TypeScript", async () => {
    const fixture = await importedMathTexPreviewInput();
    const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    let outlineCompilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(commands),
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => {
        outlineCompilerCalls += 1;
        return compiledMathTexResponse();
      },
      snapshot: fixture.snapshot,
      workingState: fixture.edited,
      workingRevision: "studio-working-v1:edit-imported-mathtex",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });

    expect(outlineCompilerCalls).toBe(0);
    expect(result.kind).toBe("compiled");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.programs.flatMap(({ operations }) => operations.map(({ kind }) => kind))).toEqual([
      "position",
      "uniform-scale",
    ]);
    expect(commands[0]?.sourceRuntimeBindings).toEqual([
      { runtimeEntityId: fixture.runtimeEntityId, sourceIdentityKey: "equation", sourceName: "equation" },
    ]);
    expect(commands[0]?.studioEntities).toContainEqual(
      expect.objectContaining({ id: fixture.entityId, kind: "math-tex", sourceIdentity: "equation" }),
    );
  });

  it("passes an imported Image move and scale to the same Rust use case", async () => {
    const fixture = await importedImagePreviewInput();
    const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(commands),
      frame: fixture.frame,
      snapshot: fixture.snapshot,
      workingState: fixture.edited,
      workingRevision: "studio-working-v1:edit-imported-image",
      workspaceKey: "project-a/image_scene.py/ImageScene",
    });

    expect(result.kind).toBe("compiled");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.sourceRuntimeBindings).toEqual([
      { runtimeEntityId: fixture.runtimeEntityId, sourceIdentityKey: "image", sourceName: "image" },
    ]);
    expect(commands[0]?.studioEntities).toContainEqual(
      expect.objectContaining({ kind: "image", sourceIdentity: "image" }),
    );
  });

  it("compiles one imported static MathTex content edit through the static-root Rust use case", async () => {
    const fixture = await importedMathTexPreviewInput();
    const content = { displayLines: ["F = ma"], label: "Force", texParts: ["F", "=", "ma"] } as const;
    const contentEdit = createInspectorEntityEditProgram({
      capturedPlayhead: 0,
      edits: { content },
      entityId: fixture.entityId,
      from: { position: { x: 400, y: 220 }, scale: 1.5 },
      scene: fixture.workingState.runtimeSceneState,
      transactionId: "edit-imported-mathtex-content",
    });
    if (contentEdit.kind !== "valid") throw new Error("Imported MathTex content edit fixture did not validate");
    const workingState: WorkingState = {
      ...fixture.workingState,
      appliedEdits: [programRecord(contentEdit.program, contentEdit)],
    };
    const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    let outlineCompilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(commands),
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async (texParts) => {
        outlineCompilerCalls += 1;
        expect(texParts).toEqual(content.texParts);
        return compiledMathTexResponse();
      },
      snapshot: fixture.snapshot,
      workingState,
      workingRevision: "studio-working-v1:edit-imported-mathtex-content",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(outlineCompilerCalls).toBe(1);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      mathTexOutlines: [{ entityId: fixture.entityId, texParts: content.texParts }],
      programs: [
        {
          anchorCapturedPlayhead: 0,
          anchorResolvedSeconds: 0,
          operations: [
            {
              content,
              entityId: fixture.entityId,
              interval: { end: 0, start: 0 },
              kind: "math-tex-content",
            },
          ],
        },
      ],
      schema: "poietra.apply-static-root-transform-edit",
    });
    expect(result).toMatchObject({
      kind: "compiled",
      scene: {
        editAuthority: "static-imported-root",
        staticRootProjection: { mutations: [{ content, kind: "math-tex-content" }] },
      },
    });
  });

  it("does not invoke Rust or show stale geometry when the MathTex content outline is unsupported", async () => {
    const fixture = await importedMathTexPreviewInput();
    const contentEdit = createInspectorEntityEditProgram({
      capturedPlayhead: 0,
      edits: { content: { displayLines: ["unsupported"], texParts: ["\\unsupported"] } },
      entityId: fixture.entityId,
      from: { position: { x: 400, y: 220 }, scale: 1.5 },
      scene: fixture.workingState.runtimeSceneState,
      transactionId: "unsupported-imported-mathtex-content-outline",
    });
    if (contentEdit.kind !== "valid") throw new Error("Imported MathTex content edit fixture did not validate");
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: async (bundle) => {
        compilerCalls += 1;
        return unchangedAuthoringResult(bundle);
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () =>
        mathTexOutlineResponseV1Schema.parse({
          result: {
            code: "syntax-unsupported",
            kind: "unsupported",
            message: "The expression is not supported by the outline compiler.",
          },
          schema: "poietra.mathtex-outline-response",
          version: 1,
        }),
      snapshot: fixture.snapshot,
      workingState: {
        ...fixture.workingState,
        appliedEdits: [programRecord(contentEdit.program, contentEdit)],
      },
      workingRevision: "studio-working-v1:unsupported-imported-mathtex-content-outline",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });

    expect(compilerCalls).toBe(0);
    expect(result).toEqual({
      error:
        "MathTex content is unsupported (syntax-unsupported): The expression is not supported by the outline compiler.",
      kind: "unsupported",
    });
  });

  it("fails closed when Rust omits the imported MathTex content projection", async () => {
    const fixture = await importedMathTexPreviewInput();
    const contentEdit = createInspectorEntityEditProgram({
      capturedPlayhead: 0,
      edits: { content: { displayLines: ["F = ma"], texParts: ["F = ma"] } },
      entityId: fixture.entityId,
      from: { position: { x: 400, y: 220 }, scale: 1.5 },
      scene: fixture.workingState.runtimeSceneState,
      transactionId: "missing-imported-mathtex-content-projection",
    });
    if (contentEdit.kind !== "valid") throw new Error("Imported MathTex content edit fixture did not validate");
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: async (bundle) => unchangedAuthoringResult(bundle),
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => compiledMathTexResponse(),
      snapshot: fixture.snapshot,
      workingState: {
        ...fixture.workingState,
        appliedEdits: [programRecord(contentEdit.program, contentEdit)],
      },
      workingRevision: "studio-working-v1:missing-imported-mathtex-content-projection",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });

    expect(result).toEqual({
      error: "Rust core returned an uncorrelated MathTex content projection.",
      kind: "unsupported",
    });
  });

  it("changes the compiled revision across every snapshot, asset, and frame authority axis", async () => {
    const { snapshot } = await compilablePreviewInput();
    const basis = {
      frame: { height: 9, width: 16 },
      snapshot,
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
      snapshot,
      workingState: {
        ...proposedState.base,
        runtimeSceneState: { ...proposedState.base.runtimeSceneState, duration: 3 },
      },
      workingRevision: "studio-working-v1:stale-time",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result).toMatchObject({ kind: "unsupported" });
  });
});

describe("preview playback clock bridge", () => {
  const viewport = { heightPx: 360, widthPx: 640 } as const;

  it("requests live clock samples without subscribing React to playback ticks", () => {
    let snapshot = { currentTime: 1, duration: 5, playing: false, sceneKey: "scene-a" };
    const listeners = new Set<() => void>();
    const requests: Array<
      Readonly<{ sampleTime: number; viewport: Readonly<{ heightPx: number; widthPx: number }> | null }>
    > = [];
    const disconnect = connectStudioPreviewPlaybackClock(
      {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      { requestFrame: (request) => requests.push(request) },
      0.75,
      viewport,
    );

    expect(requests).toEqual([{ sampleTime: 0.75, viewport }]);
    snapshot = { ...snapshot, currentTime: 1.5, playing: true };
    for (const listener of listeners) listener();
    snapshot = { ...snapshot, currentTime: 2, playing: false };
    for (const listener of listeners) listener();
    expect(requests).toEqual([
      { sampleTime: 0.75, viewport },
      { sampleTime: 1.5, viewport },
      { sampleTime: 2, viewport },
    ]);

    disconnect();
    snapshot = { ...snapshot, currentTime: 2.5 };
    for (const listener of listeners) listener();
    expect(requests).toHaveLength(3);
  });

  it.each([
    { frame: { packetId: "frame", revision: HASH_A, sampleTime: 1, viewport }, phase: "presented" } as const,
    { detail: null, phase: "fallback", reason: "frame-pending" } as const,
    { detail: null, phase: "fallback", reason: "frame-stale" } as const,
  ])("suppresses only an initialized host's routine playback state $phase", (state) => {
    expect(
      suppressStudioPreviewHostStateDuringPlayback(state, {
        hostPresentedOnce: true,
        playing: true,
        sceneUpdateInFlight: false,
      }),
    ).toBe(true);
    expect(
      suppressStudioPreviewHostStateDuringPlayback(state, {
        hostPresentedOnce: false,
        playing: true,
        sceneUpdateInFlight: false,
      }),
    ).toBe(false);
    expect(
      suppressStudioPreviewHostStateDuringPlayback(state, {
        hostPresentedOnce: true,
        playing: false,
        sceneUpdateInFlight: false,
      }),
    ).toBe(false);
    expect(
      suppressStudioPreviewHostStateDuringPlayback(state, {
        hostPresentedOnce: true,
        playing: true,
        sceneUpdateInFlight: true,
      }),
    ).toBe(false);
  });

  it.each([
    "capability-unsupported",
    "install-failed",
    "installing",
    "render-error",
    "renderer-failed",
    "sample-out-of-range",
    "viewport-unavailable",
  ] as const)("always publishes %s while playback is active", (reason) => {
    expect(
      suppressStudioPreviewHostStateDuringPlayback(
        { detail: "diagnostic", phase: "fallback", reason },
        { hostPresentedOnce: true, playing: true, sceneUpdateInFlight: false },
      ),
    ).toBe(false);
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
