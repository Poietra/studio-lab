import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import {
  mixedDynamic2dSnapshotBundleFixtureV7,
  pngSnapshotBundleFixture,
} from "../../server/test-fixtures/fast-manim-snapshot-bundle-fixture";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "../engine/contracts";
import { canonicalJsonV1, digestFastManimSnapshotBundleInBrowserV1 } from "../engine/fast-manim-snapshot-digest";
import { type MathTexOutlineResponseV1, mathTexOutlineResponseV1Schema } from "../engine/mathtex-outline";
import type {
  CreateSceneEntitiesWireCommandV1,
  CreateSceneMotionCompiler,
  CreateSceneMotionWireCommandV1,
  EditSceneTimelineCompiler,
  EditSceneTimelineWireCommandV1,
  TransformSceneEntityCompiler,
  TransformSceneEntityWireCommandV1,
} from "../engine/scene-authoring";
import type { SceneEntityV1 } from "../engine/scene-ir";
import { canonicalFastManimRuntimeTraceSampleTimeV3 } from "../render-pipeline/runtime-trace-v3-shared-contract";
import { importManimScene } from "../render-pipeline/source-import";
import {
  createInspectorEntityEditProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
} from "./authoring-commands";
import { canonicalEditorWorkingRevision } from "./editor-revision-policy";
import { evaluateWorkingState, programRecord } from "./evaluator";
import { type ProposedState, type RuntimeSceneState, STUDIO_STATE_VERSION, type WorkingState } from "./model";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSnapshotProviderV1,
  type StudioPreviewSourceRuntimeIdentityV1,
  type StudioPreviewSourceRuntimeMappingV1,
  type StudioVerifiedPreviewSnapshotV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";
import { createMathTexFixturePreviewSnapshotProviderV1 } from "./preview-snapshot-provider.fixture";
import { validateAndScheduleProgram } from "./program-validation";
import { projectRuntimeSceneToSourceTimeline } from "./source-timeline";
import {
  createDirectManipulationMotionProgram,
  createDirectManipulationPositionProgram,
  createDirectManipulationResizeProgram,
  createDirectManipulationScaleProgram,
} from "./suggestion-program";
import {
  claimStudioPreviewCanvasV1,
  compileStudioPreviewSceneV1,
  digestStudioPreviewSceneRevisionV1,
  type StudioPreviewSnapshotMetadataStateV1,
  studioPreviewHostReadyForSceneUpdateV1,
  studioPreviewInteractionAuthority,
  studioPreviewInteractionEntityIdsV1,
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

function exactImportedTimelineWorkingBase(base: Awaited<ReturnType<typeof compilablePreviewInput>>): WorkingState {
  const context = base.snapshot.correlation.context;
  const sceneId = `${context.sourcePath}#${context.sceneName}`;
  return {
    ...base.proposedState.base,
    editorContext: { ...base.proposedState.base.editorContext, activeSceneId: sceneId },
    runtimeSceneState: { ...base.proposedState.base.runtimeSceneState, sceneId },
  };
}

function recordingTimelineCompiler(calls: EditSceneTimelineWireCommandV1[]): EditSceneTimelineCompiler {
  return async (bundle, command) => {
    calls.push(command);
    return bundle;
  };
}

function recordingMotionCompiler(calls: CreateSceneMotionWireCommandV1[]): CreateSceneMotionCompiler {
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
    scene: unknown;
  }>;
  const producerBundle = await parseVerifiedSceneIrBundleV1(producerFixture);
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

function recordingTransformCompiler(calls: TransformSceneEntityWireCommandV1[]): TransformSceneEntityCompiler {
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

const testTransformCompiler: TransformSceneEntityCompiler = async (bundle, command) => {
  const intent = command.intent;
  const delta =
    intent.kind === "relative"
      ? intent.delta
      : {
          x: (intent.targetCenter?.x ?? intent.baseline.worldCenter.x) - intent.baseline.worldCenter.x,
          y: (intent.targetCenter?.y ?? intent.baseline.worldCenter.y) - intent.baseline.worldCenter.y,
        };
  const scale =
    intent.kind === "relative" ? intent.scale : intent.scale && { pivot: intent.baseline.worldCenter, ...intent.scale };
  return await parseVerifiedSceneIrBundleV1({
    ...bundle,
    scene: {
      ...bundle.scene,
      entities: bundle.scene.entities.map((entity) => {
        if (entity.id !== command.entityId) return entity;
        const transform = { ...entity.transform };
        if (scale) {
          transform.m11 *= scale.xFactor;
          transform.m12 *= scale.xFactor;
          transform.m21 *= scale.yFactor;
          transform.m22 *= scale.yFactor;
          transform.tx = scale.pivot.x + scale.xFactor * (transform.tx - scale.pivot.x);
          transform.ty = scale.pivot.y + scale.yFactor * (transform.ty - scale.pivot.y);
        }
        transform.tx += delta.x;
        transform.ty += delta.y;
        return { ...entity, provenanceId: command.provenance.id, transform };
      }),
      provenance: [...bundle.scene.provenance, command.provenance],
      source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: command.nextRevision },
    },
  });
};

async function importedMathTexPreviewInput(
  options: Readonly<{ includeMove?: boolean; includeScale?: boolean; rotated?: boolean }> = {},
) {
  const includeMove = options.includeMove ?? true;
  const includeScale = options.includeScale ?? true;
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
  const pathPoints = outline.path.subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end]),
  ]);
  const localCenter = {
    x: (Math.min(...pathPoints.map(({ x }) => x)) + Math.max(...pathPoints.map(({ x }) => x))) / 2,
    y: (Math.min(...pathPoints.map(({ y }) => y)) + Math.max(...pathPoints.map(({ y }) => y))) / 2,
  };
  const linearTransform = options.rotated
    ? { m11: 1.25, m12: -0.75, m21: 0.75, m22: 1.25 }
    : { m11: 1.5, m12: 0, m21: 0, m22: 1.5 };
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
    edited: evaluateWorkingState({
      ...workingState,
      appliedPrograms:
        includeMove && includeScale
          ? [programRecord(combined.program, combined)]
          : [
              ...(includeMove ? [programRecord(position.program, position)] : []),
              ...(includeScale ? [programRecord(scale.program, scale)] : []),
            ],
    }),
    entityId,
    runtimeEntityId,
    snapshot,
    workingState,
  };
}

async function importedImagePreviewInput() {
  const fixture = await importedMathTexPreviewInput();
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
  const studioEntity = fixture.edited.base.runtimeSceneState.objectGraph.entities[fixture.entityId];
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
  const proposedState: ProposedState = {
    ...fixture.edited,
    base: { ...fixture.edited.base, runtimeSceneState: withImage(fixture.edited.base.runtimeSceneState) },
    evaluatedScene: withImage(fixture.edited.evaluatedScene),
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
    edited: proposedState,
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
  it("keeps V1 selection-only and bounds generic V3 edits to construction and settled endpoints", async () => {
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
    const authority = studioPreviewInteractionAuthority(v5, 0, []);
    expect(authority).toEqual({ kind: "display-only", reason: "aggregate-mathtex-morph-lineage" });
    expect(
      studioPreviewInteractionEntityIdsV1(
        new Map([["equation", { bindingId: "binding:equation", entityId: "runtime-line", sourceName: "equation" }]]),
        authority,
      ),
    ).toEqual([]);
  });

  it("does not advertise mutations for an animated server snapshot the canonical compiler cannot edit", async () => {
    const { snapshot } = await compilablePreviewInput();
    const animated = {
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
              provenanceId: "test",
            },
          ],
        },
      },
    } as StudioVerifiedPreviewSnapshotV1;

    expect(studioPreviewInteractionAuthority(animated, 0, [])).toEqual({
      kind: "selection-only",
      reason: "source-edit-unsupported",
    });
    expect(studioPreviewInteractionAuthority({ ...animated, sourceRuntimeIdentity: null }, 0, [])).toEqual({
      kind: "display-only",
      reason: "source-runtime-identity-unverified",
    });
  });

  it("keeps legacy runtime snapshots selection-only with verified identity", async () => {
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
    const authority = studioPreviewInteractionAuthority(v9, 0, []);
    expect(authority).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority, v9.snapshot.scene.entities)).toEqual([
      "runtime-line",
    ]);
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

    const authority = studioPreviewInteractionAuthority(v10, 0, []);
    expect(authority).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority)).toEqual([]);
    expect(studioPreviewInteractionEntityIdsV1(identity, authority, entities)).toEqual(leafIds);
    expect(
      studioPreviewInteractionAuthority(
        {
          ...v10,
          sourceRuntimeIdentity: new Map([...identity].filter(([sourceName]) => sourceName !== "grp")),
        },
        0,
        [],
      ),
    ).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });

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

    const authority = studioPreviewInteractionAuthority(v11, 0, []);
    expect(authority).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority, entities)).toEqual(leafIds);
    for (const missingName of ["shapes", ...sourceNames]) {
      expect(
        studioPreviewInteractionAuthority(
          {
            ...v11,
            sourceRuntimeIdentity: new Map([...identity].filter(([sourceName]) => sourceName !== missingName)),
          },
          0,
          [],
        ),
      ).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
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

    const authority = studioPreviewInteractionAuthority(v12, 0, []);
    expect(authority).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
    expect(studioPreviewInteractionEntityIdsV1(identity, authority, entities)).toEqual([textRootId, texRootId]);
    for (const missingName of ["group", "example_text", "example_tex"]) {
      expect(
        studioPreviewInteractionAuthority(
          {
            ...v12,
            sourceRuntimeIdentity: new Map([...identity].filter(([sourceName]) => sourceName !== missingName)),
          },
          0,
          [],
        ),
      ).toEqual({ kind: "selection-only", reason: "source-edit-anchor-unavailable" });
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

  it("preserves V6/V7 editing while legacy V8 snapshots remain selection-only", async () => {
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
    expect(studioPreviewInteractionAuthority({ ...snapshot, sourceRuntimeIdentity: null }, 0, [])).toEqual({
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
      const authority = studioPreviewInteractionAuthority(v6, 0, []);
      expect(authority).toEqual(expectedAuthority);
      expect(studioPreviewInteractionEntityIdsV1(identity, authority)).toEqual(expectedEntityIds);
    }

    const identityBoundSnapshot = (snapshotVersion: 7 | 8, identity: StudioPreviewSourceRuntimeIdentityV1 | null) =>
      ({
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          scene: { ...snapshot.snapshot.scene, source: { ...source, snapshotVersion } },
        },
        sourceRuntimeIdentity: identity,
      }) as StudioVerifiedPreviewSnapshotV1;
    expect(studioPreviewInteractionAuthority(identityBoundSnapshot(7, null), 0, [])).toEqual(displayOnly);
    expect(studioPreviewInteractionAuthority(identityBoundSnapshot(7, partialIdentity), 0, [])).toEqual({
      kind: "interactive",
    });
    expect(studioPreviewInteractionAuthority(identityBoundSnapshot(7, fullIdentity), 0, [])).toEqual(displayOnly);
    expect(studioPreviewInteractionAuthority(identityBoundSnapshot(8, null), 0, [])).toEqual(displayOnly);
    expect(studioPreviewInteractionAuthority(identityBoundSnapshot(8, partialIdentity), 0, [])).toEqual({
      kind: "selection-only",
      reason: "source-edit-anchor-unavailable",
    });
    expect(studioPreviewInteractionAuthority(identityBoundSnapshot(8, fullIdentity), 0, [])).toEqual({
      kind: "selection-only",
      reason: "source-edit-anchor-unavailable",
    });
  });
});

describe("compileStudioPreviewSceneV1", () => {
  it("routes CreateMotion on an opacity-animated Scene through Rust and rejects moving coordinates", async () => {
    const base = await compilablePreviewInput();
    const workingBase = exactImportedTimelineWorkingBase(base);
    const validation = createDirectManipulationMotionProgram({
      capturedPlayhead: 0.5,
      controlOffset: { x: 32, y: 18 },
      delta: { x: 64, y: -36 },
      interval: { end: 1.5, start: 0.5 },
      scene: workingBase.runtimeSceneState,
      targetEntityIds: ["source:circle"],
      transactionId: "create-static-motion",
    });
    if (validation.kind !== "valid") throw new Error("Static motion fixture did not validate.");
    const proposedState = evaluateWorkingState({
      ...workingBase,
      appliedPrograms: [programRecord(validation.program, validation)],
    });
    const snapshot = {
      ...base.snapshot,
      snapshot: {
        ...base.snapshot.snapshot,
        scene: {
          ...base.snapshot.snapshot.scene,
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
    const commands: CreateSceneMotionWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      createSceneMotionCompiler: recordingMotionCompiler(commands),
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot,
      workingRevision: "studio-working-v1:create-static-motion",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result.kind).toBe("compiled");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      controlOffset: { x: 0.8, y: -0.45 },
      delta: { x: 1.6, y: 0.9 },
      easing: "smooth",
      expectedBaseRevision: HASH_C,
      interval: { end: 1.5, start: 0.5 },
      schema: "poietra.create-scene-motion",
      targetEntityIds: ["earlier"],
      version: 1,
    });
    expect(commands[0]?.provenance.evidence).toEqual([`authorized operation ${validation.program.operations[0]?.id}`]);

    const mismatchedAnchorResult = await compileStudioPreviewSceneV1({
      createSceneMotionCompiler: recordingMotionCompiler(commands),
      frame: { height: 9, width: 16 },
      proposedState: {
        ...proposedState,
        programs: proposedState.programs.map((record) => ({
          ...record,
          program: {
            ...record.program,
            anchor: { ...record.program.anchor, resolvedSeconds: record.program.anchor.resolvedSeconds + 0.0005 },
          },
        })),
      },
      snapshot,
      workingRevision: "studio-working-v1:create-static-motion",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(mismatchedAnchorResult).toMatchObject({
      error: expect.stringContaining("authoring authority"),
      kind: "unsupported",
    });
    expect(commands).toHaveLength(1);

    const cameraResult = await compileStudioPreviewSceneV1({
      createSceneMotionCompiler: recordingMotionCompiler(commands),
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot: {
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          scene: {
            ...snapshot.snapshot.scene,
            animationChannels: [
              {
                id: "camera:move",
                keyframes: [
                  {
                    at: 0,
                    easingToNext: { kind: "linear" },
                    value: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
                  },
                  { at: 2, easingToNext: null, value: { center: { x: 1, y: 0 }, frameHeight: 9, frameWidth: 16 } },
                ],
                kind: "camera",
                provenanceId: "fixture",
              },
            ],
          },
        },
      },
      workingRevision: "studio-working-v1:create-static-motion",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(cameraResult).toMatchObject({
      error: expect.stringContaining("static camera and geometry"),
      kind: "unsupported",
    });
    expect(commands).toHaveLength(1);
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

  it("routes one static imported Scene duration extension through the canonical Rust timeline command", async () => {
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
    const proposedState = evaluateWorkingState({ ...workingBase, appliedPrograms: [extensionRecord] });
    const commands: EditSceneTimelineWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      editSceneTimelineCompiler: recordingTimelineCompiler(commands),
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot: base.snapshot,
      workingRevision: "studio-working-v1:extend-imported-scene",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      edits: [{ at: 1, duration: 1, kind: "insert-wait" }],
      expectedBaseRevision: base.snapshot.correlation.engineRevisionHash,
      nextRevision: result.scene.engineRevisionHash,
      provenance: {
        evidence: [`authorized operation ${extension.program.operations[0]?.id}`],
        id: `studio-imported-timeline:${result.scene.engineRevisionHash}`,
        origin: "studio-edit-program",
      },
      schema: "poietra.edit-scene-timeline",
      version: 1,
    });
  });

  it("preserves an imported animation channel at the Rust timeline compiler boundary", async () => {
    const base = await compilablePreviewInput();
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
      editSceneTimelineCompiler: async (bundle) => {
        compilerCalls += 1;
        expect(bundle.scene.animationChannels).toEqual(animationChannels);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      proposedState: evaluateWorkingState({
        ...workingBase,
        appliedPrograms: [programRecord(extension.program, extension)],
      }),
      snapshot,
      workingRevision: "studio-working-v1:extend-animated-imported-scene",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    expect(result.kind).toBe("compiled");
    expect(compilerCalls).toBe(1);
    if (result.kind === "compiled") {
      expect(result.scene.bundle.scene.animationChannels).toEqual(animationChannels);
    }
  });

  it("preserves source order for extension, trim, and a later same-anchor extension", async () => {
    const base = await compilablePreviewInput();
    const workingBase = exactImportedTimelineWorkingBase(base);
    const extension = createSceneDurationProgram({
      capturedPlayhead: 1,
      scene: workingBase.runtimeSceneState,
      sourceAnchor: 1,
      targetDuration: 3,
      transactionId: "extend-before-imported-trim",
    });
    if (extension.kind !== "valid") throw new Error(JSON.stringify(extension.issues));
    const extensionRecord = programRecord(extension.program, extension);
    const extended = evaluateWorkingState({ ...workingBase, appliedPrograms: [extensionRecord] });
    const trim = createSceneDurationProgram({
      appliedPrograms: [extensionRecord],
      capturedPlayhead: 3,
      scene: extended.evaluatedScene,
      sourceAnchor: 1,
      targetDuration: 2.5,
      transactionId: "trim-imported-scene",
    });
    if (trim.kind !== "valid") throw new Error(JSON.stringify(trim.issues));
    const trimRecord = programRecord(trim.program, trim);
    const trimmed = evaluateWorkingState({
      ...workingBase,
      appliedPrograms: [extensionRecord, trimRecord],
    });
    const laterExtension = createSceneDurationProgram({
      capturedPlayhead: 2.5,
      scene: trimmed.evaluatedScene,
      sourceAnchor: 1,
      targetDuration: 3.5,
      transactionId: "extend-after-imported-trim",
    });
    if (laterExtension.kind !== "valid") throw new Error(JSON.stringify(laterExtension.issues));
    const laterExtensionRecord = programRecord(laterExtension.program, laterExtension);
    const proposedState = evaluateWorkingState({
      ...workingBase,
      appliedPrograms: [extensionRecord, trimRecord, laterExtensionRecord],
    });
    const commands: EditSceneTimelineWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      editSceneTimelineCompiler: recordingTimelineCompiler(commands),
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot: base.snapshot,
      workingRevision: "studio-working-v1:extend-and-trim-imported-scene",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.edits).toEqual([
      { at: 1, duration: 1, kind: "insert-wait" },
      { kind: "trim-scene-duration", removedDuration: 0.5, targetDuration: 2.5 },
      { at: 1.5, duration: 1, kind: "insert-wait" },
    ]);
    expect(commands[0]?.provenance.evidence).toEqual([
      `authorized operation ${extension.program.operations[0]?.id}`,
      `authorized operation ${trim.program.operations[0]?.id}`,
      `authorized operation ${laterExtension.program.operations[0]?.id}`,
    ]);
  });

  it("rejects an appearance operation combined with a Scene timeline edit before Rust compilation", async () => {
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
    const appearanceOperation = {
      dependsOn: [],
      entityId: "source:circle",
      id: "tx:appearance/operation:set-opacity",
      interval: { end: 0, start: 0 },
      key: "appearance",
      kind: "SetProperty",
      provenance: { evidence: ["unsupported appearance regression"], origin: "studio-default" },
      value: 0.5,
    } as const;
    const appearanceProgram = {
      ...extension.program,
      anchor: { ...extension.program.anchor, resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } as const },
      operations: [appearanceOperation],
      schedule: { edges: [], mode: "sequence", order: [appearanceOperation.id] } as const,
      transactionId: "appearance-only",
    };
    const appearance = validateAndScheduleProgram(appearanceProgram, workingBase.runtimeSceneState);
    if (appearance.kind !== "valid") throw new Error(JSON.stringify(appearance.issues));
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      editSceneTimelineCompiler: async () => {
        compilerCalls += 1;
        throw new Error("The Rust timeline compiler must not run for a mixed appearance edit.");
      },
      frame: { height: 9, width: 16 },
      proposedState: evaluateWorkingState({
        ...workingBase,
        appliedPrograms: [programRecord(extension.program, extension), programRecord(appearance.program, appearance)],
      }),
      snapshot: base.snapshot,
      workingRevision: "studio-working-v1:timeline-with-appearance",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    expect(result).toMatchObject({ error: expect.stringContaining("cannot be combined"), kind: "unsupported" });
    expect(compilerCalls).toBe(0);
  });

  it.each(["direct-manipulation", "studio-default"] as const)(
    "routes one imported static root move from %s through the canonical Rust command",
    async (origin) => {
      const frame = { height: 9, width: 16 } as const;
      const { operationId, proposedState, snapshot, workingRevision, workspaceKey } =
        await editedStaticRootPreviewInput({ origin });
      if (!operationId) throw new Error("Imported root move lost its operation identity.");
      const commands: TransformSceneEntityWireCommandV1[] = [];
      const result = await compileStudioPreviewSceneV1({
        frame,
        proposedState,
        snapshot,
        transformCompiler: recordingTransformCompiler(commands),
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
        intent: { kind: "relative" },
        nextRevision: result.scene.engineRevisionHash,
        provenance: {
          evidence: [
            "Studio t=0 position request projected onto one verified static imported root",
            `authorized operation ${operationId}`,
          ],
          id: `studio-static-move:${result.scene.engineRevisionHash}`,
          origin: "studio-edit-program",
        },
        schema: "poietra.transform-scene-entity",
        version: 1,
      });
      if (command.intent.kind !== "relative") throw new Error("Imported move used the wrong transform intent.");
      expect(command.intent.delta.x).toBeCloseTo(1.6, 12);
      expect(command.intent.delta.y).toBeCloseTo(0.9, 12);
      expect(result.scene.bundle.scene.entities.map(({ id }) => id)).toEqual(["earlier", "runtime-unmapped"]);
      expect(result.scene.interactionEntityIds).toEqual(["earlier"]);
    },
  );

  it.each([
    {
      expectedScale: { xFactor: 1.5, yFactor: 1.5 },
      shape: "circle",
      toDimensions: { radius: 1.5 },
      type: "Circle",
    },
    {
      expectedScale: { xFactor: 2, yFactor: 1.5 },
      shape: "rectangle",
      toDimensions: { height: 1.5, width: 4 },
      type: "Rectangle",
    },
  ] as const)("routes an imported static $type ResizeEntity through the canonical Rust command", async (input) => {
    const fixture = await verifiedStaticPrimitivePreviewInput(input.type);
    const validation = createDirectManipulationResizeProgram({
      capturedPlayhead: 0,
      entityId: fixture.entityId,
      from: { dimensions: fixture.dimensions, position: fixture.position },
      interval: { end: 0, start: 0 },
      scale: 1,
      scene: fixture.workingBase.runtimeSceneState,
      shape: input.shape,
      to: {
        dimensions: input.toDimensions,
        position: { x: fixture.position.x + 20, y: fixture.position.y + 10 },
      },
      transactionId: `resize-imported-${input.shape}`,
    });
    if (validation.kind !== "valid") {
      throw new Error(`Imported ${input.type} resize fixture is invalid: ${JSON.stringify(validation.issues)}`);
    }
    const record = programRecord(validation.program, validation);
    const commands: TransformSceneEntityWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: evaluateWorkingState({ ...fixture.workingBase, appliedPrograms: [record] }),
      snapshot: fixture.snapshot,
      transformCompiler: async (bundle, command) => {
        commands.push(command);
        return testTransformCompiler(bundle, command);
      },
      workingRevision: canonicalEditorWorkingRevision({
        appliedPrograms: [record],
        draftProgram: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    const command = commands[0];
    if (!command) throw new Error(`Imported ${input.type} resize did not reach the Rust compiler boundary.`);
    expect(command).toMatchObject({
      intent: {
        baseline: {
          height: input.type === "Circle" ? 2 : 1,
          kind: "world-size",
          width: 2,
          worldCenter: { x: input.type === "Circle" ? -1 : 2, y: 0 },
        },
        kind: "from-baseline",
        scale: input.expectedScale,
      },
      entityId: "earlier",
      expectedBaseRevision: fixture.snapshot.correlation.engineRevisionHash,
      schema: "poietra.transform-scene-entity",
      version: 1,
    });
    if (command.intent.kind !== "from-baseline" || !command.intent.targetCenter) {
      throw new Error("Resize did not retain its target center.");
    }
    expect(command.intent.targetCenter.x).toBeCloseTo(input.type === "Circle" ? -0.5 : 2.5, 12);
    expect(command.intent.targetCenter.y).toBeCloseTo(-0.25, 12);
    expect(command.provenance.evidence).toContain(`authorized operation ${validation.program.operations[0]?.id}`);
    expect(result.scene.bundle.scene.entities[0]?.geometry).toEqual(
      fixture.snapshot.snapshot.scene.entities[0]?.geometry,
    );
  });

  it("routes an imported static Circle AnimateProperty(scale) through the canonical Rust command", async () => {
    const fixture = await verifiedStaticPrimitivePreviewInput("Circle");
    const validation = createDirectManipulationScaleProgram({
      capturedPlayhead: 0,
      interval: { end: 0, start: 0 },
      scales: { [fixture.entityId]: { from: 1, to: 1.25 } },
      scene: fixture.workingBase.runtimeSceneState,
      targetEntityIds: [fixture.entityId],
      transactionId: "scale-imported-circle",
    });
    if (validation.kind !== "valid") {
      throw new Error(`Imported Circle scale fixture is invalid: ${JSON.stringify(validation.issues)}`);
    }
    const record = programRecord(validation.program, validation);
    const commands: TransformSceneEntityWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState: evaluateWorkingState({ ...fixture.workingBase, appliedPrograms: [record] }),
      snapshot: fixture.snapshot,
      transformCompiler: async (bundle, command) => {
        commands.push(command);
        return testTransformCompiler(bundle, command);
      },
      workingRevision: canonicalEditorWorkingRevision({
        appliedPrograms: [record],
        draftProgram: null,
        editingAppliedProgram: null,
        redoPrograms: [],
      }),
      workspaceKey: fixture.workspaceKey,
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      entityId: "earlier",
      expectedBaseRevision: fixture.snapshot.correlation.engineRevisionHash,
      intent: {
        baseline: { height: 2, kind: "world-size", width: 2, worldCenter: { x: -1, y: 0 } },
        kind: "from-baseline",
        scale: { xFactor: 1.25, yFactor: 1.25 },
      },
      schema: "poietra.transform-scene-entity",
      version: 1,
    });
    expect(commands[0]?.intent).not.toHaveProperty("targetCenter");
    expect(commands[0]?.provenance.evidence).toContain(`authorized operation ${validation.program.operations[0]?.id}`);
    expect(result.scene.bundle.scene.entities[0]?.geometry).toEqual(
      fixture.snapshot.snapshot.scene.entities[0]?.geometry,
    );
  });

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
        transformCompiler: async () => {
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

  it("routes Circle and Rectangle creation through one atomic core command and adopts its bundle", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [
        { dimensions: { radius: 1 }, position: { x: 320, y: 180 }, type: "Circle" },
        { dimensions: { height: 2, width: 4 }, position: { x: 400, y: 180 }, type: "Rectangle" },
      ],
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
    const commands: CreateSceneEntitiesWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle, command) => {
        commands.push(command);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:real-create",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(result.scene.bundle).toBe(snapshot.snapshot);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      entities: [
        {
          fadeIn: { end: 0.9 },
          geometry: { kind: "circle", radius: 1 },
          id: creation.entityIds[0],
          lifetime: { end: 2.4, start: 0.5 },
          position: { x: 0, y: 0 },
          scale: 1,
        },
        {
          fadeIn: { end: 0.9 },
          geometry: { height: 2, kind: "rectangle", width: 4 },
          id: creation.entityIds[1],
          lifetime: { end: 2.4, start: 0.5 },
          position: { x: 2, y: 0 },
          scale: 1,
        },
      ],
      schema: "poietra.create-scene-entities",
      timelineInsertions: [{ at: 0.5, duration: 0.4 }],
      version: 1,
    });
  });

  it("batches successive Studio creation Programs with their rebased timeline insertions", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const first = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ dimensions: { radius: 1 }, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "create-first",
    });
    const second = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ dimensions: { height: 2, width: 4 }, position: { x: 400, y: 180 }, type: "Rectangle" }],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "create-second",
    });
    expect(first.validation.kind).toBe("valid");
    expect(second.validation.kind).toBe("valid");
    const edited = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [
        programRecord(first.validation.program, first.validation),
        programRecord(second.validation.program, second.validation),
      ],
    });
    const commands: CreateSceneEntitiesWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle, command) => {
        commands.push(command);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:two-creates",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result.kind).toBe("compiled");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      entities: [
        {
          fadeIn: { end: 0.9 },
          id: first.entityIds[0],
          lifetime: { end: 2.8, start: 0.5 },
        },
        {
          fadeIn: { end: 1.3 },
          id: second.entityIds[0],
          lifetime: { end: 2.8, start: 0.9 },
        },
      ],
      timelineInsertions: [
        { at: 0.5, duration: 0.4 },
        { at: 0.9, duration: 0.4 },
      ],
    });
  });

  it("keeps a created-entity move aligned after a later timeline insertion", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ dimensions: { radius: 1 }, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "create-before-move",
    });
    const created = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });
    const entityId = creation.entityIds[0]!;
    const sourceScene = projectRuntimeSceneToSourceTimeline(created.evaluatedScene, [creation.validation.program]);
    const move = createDirectManipulationPositionProgram({
      capturedPlayhead: 0.5,
      delta: { x: 40, y: 0 },
      positions: { [entityId]: { x: 320, y: 180 } },
      scene: sourceScene,
      start: 0.5,
      targetEntityIds: [entityId],
      transactionId: "move-after-create",
    });
    expect(move.kind).toBe("valid");
    const laterCreation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ dimensions: { radius: 0.5 }, position: { x: 400, y: 180 }, type: "Circle" }],
      scene: sourceScene,
      transactionId: "create-after-move",
    });
    const edited = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [
        programRecord(creation.validation.program, creation.validation),
        programRecord(move.program, move),
        programRecord(laterCreation.validation.program, laterCreation.validation),
      ],
    });
    const commands: CreateSceneEntitiesWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle, command) => {
        commands.push(command);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:create-then-move",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result.kind).toBe("compiled");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.entities[0]?.instantTransform).toEqual({
      at: 1.3,
      position: { x: 1, y: 0 },
      scaleX: 1,
      scaleY: 1,
    });

    const sourceAfterEdits = projectRuntimeSceneToSourceTimeline(edited.evaluatedScene, [
      creation.validation.program,
      move.program,
      laterCreation.validation.program,
    ]);
    const secondMove = createDirectManipulationPositionProgram({
      capturedPlayhead: 1,
      delta: { x: 20, y: 0 },
      positions: { [entityId]: { x: 360, y: 180 } },
      scene: sourceAfterEdits,
      start: 1,
      targetEntityIds: [entityId],
      transactionId: "second-move-after-create",
    });
    expect(secondMove.kind).toBe("valid");
    let rejectedCompilerCalls = 0;
    const rejected = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle) => {
        rejectedCompilerCalls += 1;
        return bundle;
      },
      frame: { height: 9, width: 16 },
      proposedState: evaluateWorkingState({
        ...proposedState.base,
        appliedPrograms: [
          programRecord(creation.validation.program, creation.validation),
          programRecord(move.program, move),
          programRecord(laterCreation.validation.program, laterCreation.validation),
          programRecord(secondMove.program, secondMove),
        ],
      }),
      snapshot,
      workingRevision: "studio-working-v1:create-then-two-moves",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(rejected).toMatchObject({
      error: expect.stringContaining("more than one instant anchor"),
      kind: "unsupported",
    });
    expect(rejectedCompilerCalls).toBe(0);
  });

  it.each([
    {
      dimensions: { radius: 1 },
      expectedScale: { x: 1.5, y: 1.5 },
      label: "Circle",
      shape: "circle",
      toDimensions: { radius: 1.5 },
      type: "Circle",
    },
    {
      dimensions: { height: 2, width: 4 },
      expectedScale: { x: 2, y: 1.5 },
      label: "Rectangle",
      shape: "rectangle",
      toDimensions: { height: 3, width: 8 },
      type: "Rectangle",
    },
  ] as const)("lowers a follow-up $label resize without replacing its canonical geometry", async (fixture) => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ dimensions: fixture.dimensions, position: { x: 320, y: 180 }, type: fixture.type }],
      scene: proposedState.base.runtimeSceneState,
      transactionId: `create-before-${fixture.shape}-resize`,
    });
    const created = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });
    const entityId = creation.entityIds[0]!;
    const resize = createDirectManipulationResizeProgram({
      capturedPlayhead: 0.5,
      entityId,
      from: { dimensions: fixture.dimensions, position: { x: 320, y: 180 } },
      interval: { end: 0.5, start: 0.5 },
      scale: 1,
      scene: projectRuntimeSceneToSourceTimeline(created.evaluatedScene, [creation.validation.program]),
      shape: fixture.shape,
      to: { dimensions: fixture.toDimensions, position: { x: 340, y: 190 } },
      transactionId: `resize-created-${fixture.shape}`,
    });
    expect(resize.kind).toBe("valid");
    const commands: CreateSceneEntitiesWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle, command) => {
        commands.push(command);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      proposedState: evaluateWorkingState({
        ...proposedState.base,
        appliedPrograms: [
          programRecord(creation.validation.program, creation.validation),
          programRecord(resize.program, resize),
        ],
      }),
      snapshot,
      workingRevision: `studio-working-v1:create-then-${fixture.shape}-resize`,
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result.kind).toBe("compiled");
    const entity = commands[0]?.entities[0];
    expect(entity).toMatchObject({
      geometry: fixture.shape === "circle" ? { kind: "circle", radius: 1 } : { height: 2, kind: "rectangle", width: 4 },
      instantTransform: {
        at: 0.9,
        scaleX: fixture.expectedScale.x,
        scaleY: fixture.expectedScale.y,
      },
    });
    expect(entity?.instantTransform?.position.x).toBeCloseTo(0.5, 12);
    expect(entity?.instantTransform?.position.y).toBeCloseTo(-0.25, 12);
  });

  it("lowers a follow-up instant MathTex scale into the atomic creation command", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [
        {
          content: { displayLines: ["E = mc^2"], label: "E = mc^2", texParts: ["E = mc^2"] },
          position: { x: 320, y: 180 },
          type: "MathTex",
        },
      ],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "create-before-mathtex-scale",
    });
    const created = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });
    const entityId = creation.entityIds[0]!;
    const scale = createDirectManipulationScaleProgram({
      capturedPlayhead: 0.5,
      interval: { end: 0.5, start: 0.5 },
      scales: { [entityId]: { from: 1, to: 1.5 } },
      scene: projectRuntimeSceneToSourceTimeline(created.evaluatedScene, [creation.validation.program]),
      targetEntityIds: [entityId],
      transactionId: "scale-created-mathtex",
    });
    expect(scale.kind).toBe("valid");
    const commands: CreateSceneEntitiesWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle, command) => {
        commands.push(command);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => compiledMathTexResponse(),
      proposedState: evaluateWorkingState({
        ...proposedState.base,
        appliedPrograms: [
          programRecord(creation.validation.program, creation.validation),
          programRecord(scale.program, scale),
        ],
      }),
      snapshot,
      workingRevision: "studio-working-v1:create-then-mathtex-scale",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result.kind).toBe("compiled");
    expect(commands[0]?.entities[0]?.instantTransform).toEqual({
      at: 0.9,
      position: { x: 0, y: 0 },
      scaleX: 1.5,
      scaleY: 1.5,
    });

    const animatedScale = createDirectManipulationScaleProgram({
      capturedPlayhead: 0.5,
      interval: { end: 0.75, start: 0.5 },
      scales: { [entityId]: { from: 1, to: 1.5 } },
      scene: projectRuntimeSceneToSourceTimeline(created.evaluatedScene, [creation.validation.program]),
      targetEntityIds: [entityId],
      transactionId: "animate-created-mathtex-scale",
    });
    expect(animatedScale.kind).toBe("valid");
    let rejectedCompilerCalls = 0;
    const rejected = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle) => {
        rejectedCompilerCalls += 1;
        return bundle;
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => compiledMathTexResponse(),
      proposedState: evaluateWorkingState({
        ...proposedState.base,
        appliedPrograms: [
          programRecord(creation.validation.program, creation.validation),
          programRecord(animatedScale.program, animatedScale),
        ],
      }),
      snapshot,
      workingRevision: "studio-working-v1:create-then-animated-mathtex-scale",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(rejected).toMatchObject({ error: expect.stringContaining("one instant move"), kind: "unsupported" });
    expect(rejectedCompilerCalls).toBe(0);
  });

  it("rejects unsupported Studio-created types before invoking the core compiler", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [
        {
          content: { displayLines: ["hello"], text: "hello" },
          position: { x: 320, y: 180 },
          type: "Text",
        },
      ],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "unsupported-text",
    });
    expect(creation.validation.kind).toBe("valid");
    const edited = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle) => {
        compilerCalls += 1;
        return bundle;
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => {
        throw new Error("outline compiler must not run for Text");
      },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:unsupported-text",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("Text is not supported"), kind: "unsupported" });
    expect(compilerCalls).toBe(0);
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
    const commands: CreateSceneEntitiesWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle, command) => {
        commands.push(command);
        return bundle;
      },
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
    expect(result.scene.bundle).toBe(snapshot.snapshot);
    expect(commands).toHaveLength(1);
    const compiledOutline = compiledMathTexResponse().result;
    if (compiledOutline.kind !== "compiled") throw new Error("MathTex test outline must compile.");
    expect(commands[0]?.entities[0]).toMatchObject({
      geometry: { kind: "mathtex", path: compiledOutline.path },
      id: creation.entityIds[0],
      position: { x: 2, y: 0 },
    });

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
    expect(commands).toHaveLength(1);

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

  it.each([
    ["move with an existing affine", true, false, true, { x: 2, y: 2 }, undefined],
    ["scale", false, true, false, { x: 0, y: 0 }, { factor: 2, pivot: { x: 2, y: -1 } }],
    ["move and scale in one Program", true, true, false, { x: 2, y: 2 }, { factor: 2, pivot: { x: 2, y: -1 } }],
  ] as const)(
    "routes imported MathTex %s through the transform compiler boundary",
    async (_label, includeMove, includeScale, rotated, delta, uniformScale) => {
      const fixture = await importedMathTexPreviewInput({ includeMove, includeScale, rotated });
      const commands: TransformSceneEntityWireCommandV1[] = [];
      let outlineCompilerCalls = 0;
      const result = await compileStudioPreviewSceneV1({
        frame: { height: 9, width: 16 },
        mathTexOutlineCompiler: async () => {
          outlineCompilerCalls += 1;
          return compiledMathTexResponse();
        },
        proposedState: fixture.edited,
        snapshot: fixture.snapshot,
        transformCompiler: async (bundle, command) => {
          commands.push(command);
          return testTransformCompiler(bundle, command);
        },
        workingRevision: `studio-working-v1:edit-imported-mathtex-${_label.replaceAll(" ", "-")}`,
        workspaceKey: "project-a/scene.py/MathTexScene",
      });
      expect(outlineCompilerCalls).toBe(0);
      if (result.kind !== "compiled") throw new Error(result.error);
      expect(commands).toHaveLength(1);
      const command = commands[0]!;
      expect(command).toMatchObject({
        entityId: fixture.runtimeEntityId,
        expectedBaseRevision: fixture.snapshot.correlation.engineRevisionHash,
        intent: {
          baseline: includeScale ? { kind: "uniform-affine", uniformScale: 1.5 } : { kind: "center" },
          kind: "from-baseline",
        },
        nextRevision: result.scene.engineRevisionHash,
        schema: "poietra.transform-scene-entity",
        version: 1,
      });
      if (command.intent.kind !== "from-baseline") throw new Error("MathTex used the wrong transform intent.");
      expect(command.intent.baseline.worldCenter.x).toBeCloseTo(2, 12);
      expect(command.intent.baseline.worldCenter.y).toBeCloseTo(-1, 12);
      if (includeMove) {
        expect(command.intent.targetCenter?.x).toBeCloseTo(2 + delta.x, 12);
        expect(command.intent.targetCenter?.y).toBeCloseTo(-1 + delta.y, 12);
      } else {
        expect(command.intent).not.toHaveProperty("targetCenter");
      }
      expect(command.intent.scale).toEqual(
        uniformScale ? { xFactor: uniformScale.factor, yFactor: uniformScale.factor } : undefined,
      );
      for (const operation of fixture.edited.programs.flatMap(({ program }) => program.operations)) {
        expect(command.provenance.evidence).toContain(`authorized operation ${operation.id}`);
      }
      expect(result.scene.bundle.assets).toEqual(fixture.snapshot.snapshot.assets);
      const compiledEntity = result.scene.bundle.scene.entities[0];
      expect(compiledEntity).toMatchObject({
        geometry: fixture.snapshot.snapshot.scene.entities[0]?.geometry,
        id: fixture.runtimeEntityId,
        provenanceId: command.provenance.id,
      });
    },
  );

  it("routes an imported Image move and scale through the transform compiler boundary", async () => {
    const fixture = await importedImagePreviewInput();
    const commands: TransformSceneEntityWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      frame: fixture.frame,
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
      transformCompiler: async (bundle, command) => {
        commands.push(command);
        return testTransformCompiler(bundle, command);
      },
      workingRevision: "studio-working-v1:edit-imported-image",
      workspaceKey: "project-a/image_scene.py/ImageScene",
    });
    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command).toMatchObject({
      entityId: fixture.runtimeEntityId,
      expectedBaseRevision: fixture.snapshot.correlation.engineRevisionHash,
      intent: { baseline: { kind: "center" }, kind: "from-baseline", scale: { xFactor: 2, yFactor: 2 } },
      nextRevision: result.scene.engineRevisionHash,
      schema: "poietra.transform-scene-entity",
      version: 1,
    });
    if (command.intent.kind !== "from-baseline" || !command.intent.targetCenter) {
      throw new Error("Image move did not retain its target center.");
    }
    expect(command.intent.baseline.worldCenter.x).toBeCloseTo(2, 12);
    expect(command.intent.baseline.worldCenter.y).toBeCloseTo(-1, 12);
    expect(command.intent.targetCenter.x).toBeCloseTo(4, 12);
    expect(command.intent.targetCenter.y).toBeCloseTo(1, 12);
    expect(command.provenance.evidence.filter((entry) => entry.startsWith("authorized operation "))).toHaveLength(2);
    expect(result.scene.bundle.assets).toEqual(fixture.snapshot.snapshot.assets);
    expect(result.scene.bundle.scene.entities[0]).toMatchObject({
      geometry: fixture.snapshot.snapshot.scene.entities[0]?.geometry,
      id: fixture.runtimeEntityId,
      provenanceId: command.provenance.id,
    });
  });

  it.each([
    ["move", false],
    ["move and scale", true],
  ])("delegates imported MathTex %s baseline validation to Rust", async (_label, includeScale) => {
    const fixture = await importedMathTexPreviewInput({ includeScale });
    const baseEntity = fixture.edited.base.runtimeSceneState.objectGraph.entities[fixture.entityId];
    if (!baseEntity?.geometry) throw new Error("Imported MathTex baseline fixture is incomplete.");
    const proposedState: ProposedState = {
      ...fixture.edited,
      base: {
        ...fixture.edited.base,
        runtimeSceneState: {
          ...fixture.edited.base.runtimeSceneState,
          objectGraph: {
            ...fixture.edited.base.runtimeSceneState.objectGraph,
            entities: {
              ...fixture.edited.base.runtimeSceneState.objectGraph.entities,
              [fixture.entityId]: {
                ...baseEntity,
                geometry: { ...baseEntity.geometry, position: { kind: "known", value: { x: 401, y: 220 } } },
              },
            },
          },
        },
      },
    };
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot: fixture.snapshot,
      transformCompiler: async () => {
        compilerCalls += 1;
        throw new Error("the semantic transform baseline does not match verified geometry");
      },
      workingRevision: "studio-working-v1:drifted-imported-affine",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("semantic transform baseline"),
      kind: "unsupported",
    });
    expect(compilerCalls).toBe(1);
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
      transformCompiler: testTransformCompiler,
      workingRevision: "studio-working-v1:mixed-v7-mathtex-transform",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(compilerCalls).toBe(0);
    if (result.kind !== "compiled") throw new Error(result.error);
    const scene = result.scene.bundle.scene;
    expect(scene.sceneId).toBe(baseScene.sceneId);
    expect(scene.camera).toEqual(baseScene.camera);
    expect(scene.duration).toBe(baseScene.duration);
    expect(scene.animationChannels).toEqual(baseScene.animationChannels);
    expect(canonicalJsonV1(scene.animationChannels)).toBe(canonicalJsonV1(baseScene.animationChannels));
    expect(scene.entities[1]).toEqual(baseScene.entities[1]);
    expect(scene.entities[2]).toEqual(baseScene.entities[2]);
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
      transformCompiler: testTransformCompiler,
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
    expect(scene.animationChannels).toEqual(fixture.snapshot.snapshot.scene.animationChannels);
    expect(scene.entities.slice(1)).toEqual(fixture.snapshot.snapshot.scene.entities.slice(1));
  });

  it("projects a mixed V7 GUI position through a non-origin camera center", async () => {
    const cameraCenter = { x: 2.5, y: -1.25 };
    const fixture = await mixedV7EditedMathTexPreviewInput({ cameraCenter });
    const result = await compileStudioPreviewSceneV1({
      frame: MIXED_V7_FRAME,
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
      transformCompiler: testTransformCompiler,
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
      transformCompiler: testTransformCompiler,
      workingRevision: "studio-working-v1:mixed-v7-create-transform",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    if (result.kind !== "compiled") throw new Error(result.error);
    const scene = result.scene.bundle.scene;
    expect(scene.animationChannels).toEqual(baseScene.animationChannels);
    expect(canonicalJsonV1(scene.animationChannels)).toBe(canonicalJsonV1(baseScene.animationChannels));
    expect(scene.animationChannels[0]).toMatchObject({ entityId: baseScene.entities[1]?.id, kind: "path-trim" });
    expect(scene.entities[0]).toEqual(baseScene.entities[0]);
    expect(scene.entities[2]).toEqual(baseScene.entities[2]);
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
      error: expect.stringContaining("No canonical Rust preview command"),
      kind: "unsupported",
    });
  });

  it("routes the checked MathTex parity fixture through the core creation boundary", async () => {
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
    const createCommands: CreateSceneEntitiesWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (_bundle, command) => {
        createCommands.push(command);
        return expectedBundle;
      },
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
    expect(createCommands).toHaveLength(1);
    expect(createCommands[0]?.entities[0]?.geometry).toEqual({ kind: "mathtex", path: expectedEntity.geometry.path });
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

  it("routes creation on an animated base through the core timeline insertion", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ dimensions: { radius: 1 }, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "create-on-animated-base",
    });
    const edited = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });
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
    const commands: CreateSceneEntitiesWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      createSceneEntitiesCompiler: async (bundle, command) => {
        commands.push(command);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot: animatedSnapshot,
      workingRevision: "studio-working-v1:edit-animated-source",
      workspaceKey: "project-a/scene.py/CircleScene",
    });
    expect(result.kind).toBe("compiled");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      schema: "poietra.create-scene-entities",
      timelineInsertions: [{ at: 0.5, duration: 0.4 }],
    });
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
