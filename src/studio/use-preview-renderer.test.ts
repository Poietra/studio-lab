import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { pngSnapshotBundleFixture } from "../../server/test-fixtures/fast-manim-snapshot-bundle-fixture";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "../engine/contracts";
import { digestFastManimSnapshotBundleInBrowserV1 } from "../engine/fast-manim-snapshot-digest";
import { type MathTexOutlineResponseV1, mathTexOutlineResponseV1Schema } from "../engine/mathtex-outline";
import type {
  ApplyStaticRootTransformEditCompiler,
  ApplyStaticRootTransformEditWireCommandV1,
  ApplyStudioCreationEditWireCommandV1,
  ApplyStudioMotionEditCompiler,
  ApplyStudioMotionEditWireCommandV1,
  ApplyStudioTimelineEditCompiler,
  ApplyStudioTimelineEditWireCommandV1,
} from "../engine/scene-authoring";
import { canonicalFastManimRuntimeTraceSampleTimeV3 } from "../render-pipeline/runtime-trace-v3-shared-contract";
import { importManimScene } from "../render-pipeline/source-import";
import {
  createInspectorEntityEditProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
} from "./authoring-commands";
import { canonicalEditorWorkingRevision } from "./editor-revision-policy";
import { evaluateWorkingState, programRecord } from "./evaluator";
import { validateMotionProgramFixture } from "./fixture";
import { type ProposedState, type RuntimeSceneState, STUDIO_STATE_VERSION, type WorkingState } from "./model";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSnapshotProviderV1,
  type StudioPreviewSourceRuntimeIdentityV1,
  type StudioPreviewSourceRuntimeMappingV1,
  type StudioVerifiedPreviewSnapshotV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";
import { validateAndScheduleProgram } from "./program-validation";
import {
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

function recordingStaticRootTransformEditCompiler(
  calls: ApplyStaticRootTransformEditWireCommandV1[],
  compile: ApplyStaticRootTransformEditCompiler = async (bundle) => bundle,
): ApplyStaticRootTransformEditCompiler {
  return async (bundle, command) => {
    calls.push(command);
    return compile(bundle, command);
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
      appliedPrograms: [programRecord(combined.program, combined)],
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

  it("keeps V6 static snapshots editable while legacy V7/V8 snapshots remain selectable but read-only", async () => {
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
    const v7Partial = identityBoundSnapshot(7, partialIdentity);
    const v7PartialAuthority = studioPreviewInteractionAuthority(v7Partial, 0, []);
    expect(v7PartialAuthority).toEqual({
      kind: "selection-only",
      reason: "source-edit-anchor-unavailable",
    });
    expect(
      studioPreviewInteractionEntityIdsV1(partialIdentity, v7PartialAuthority, v7Partial.snapshot.scene.entities),
    ).toEqual(["runtime-line"]);
    expect(studioPreviewInteractionAuthority(identityBoundSnapshot(7, fullIdentity), 0, [])).toEqual({
      kind: "selection-only",
      reason: "source-edit-anchor-unavailable",
    });
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
  it("rejects legacy animated Scene motion before invoking a core planner", async () => {
    const base = await compilablePreviewInput();
    const legacySource = base.snapshot.snapshot.scene.source;
    if (legacySource.kind !== "imported-manim-server-snapshot") throw new Error("Expected a legacy snapshot.");
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
          source: { ...legacySource, snapshotVersion: 7 as const },
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
      proposedState,
      snapshot,
      workingRevision: "studio-working-v1:create-static-motion",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result).toMatchObject({
      error: "Editing an imported animation requires generic Runtime Trace authoring support.",
      kind: "unsupported",
    });
    expect(commands).toHaveLength(0);
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
    const evaluated = evaluateWorkingState({
      ...workingBase,
      appliedPrograms: [programRecord(validation.program, validation)],
    });
    const motion = validation.program.operations[0];
    if (!motion || motion.kind !== "CreateMotion") throw new Error("Motion fixture is malformed.");
    const rawMotion = { ...motion, dependsOn: ["missing-operation"] } as const;
    const unsupported = {
      dependsOn: [],
      entityId: "source:circle",
      id: "unsupported-position",
      interval: { end: 0.5, start: 0.5 },
      key: "position",
      kind: "SetProperty",
      provenance: motion.provenance,
      value: { x: 320, y: 180 },
    } as const;
    const proposedState: ProposedState = {
      ...evaluated,
      base: {
        ...evaluated.base,
        appliedPrograms: [
          {
            program: {
              ...validation.program,
              operations: [rawMotion, unsupported],
              schedule: { ...validation.program.schedule, order: [motion.id, unsupported.id] },
            },
            validation: { issues: [], status: "valid" },
          },
        ],
      },
      programs: [
        {
          program: {
            ...validation.program,
            operations: [motion],
          },
          validation: { issues: [], status: "valid" },
        },
      ],
    };
    const commands: ApplyStudioMotionEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioMotionEditCompiler: recordingMotionCompiler(commands),
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot: base.snapshot,
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
          intentCount: 1,
          operations: [
            {
              controlOffset: { x: 32, y: 18 },
              delta: { x: 64, y: -36 },
              dependsOn: ["missing-operation"],
              kind: "create-motion",
              targetEntityIds: ["source:circle"],
            },
            { id: "unsupported-position", kind: "unsupported" },
          ],
          requestedExecution: validation.program.requestedExecution,
          scheduleEdgeCount: validation.program.schedule.edges.length,
          scheduleMode: validation.program.schedule.mode,
          scheduleOrder: [motion.id, "unsupported-position"],
          transactionId: "create-static-motion",
        },
      ],
      sourceRuntimeBindings: [{ runtimeEntityId: "earlier", sourceIdentityKey: "circle", sourceName: "circle" }],
      studioEntities: [{ objectGraphKey: "source:circle", provisional: false, sourceIdentity: "circle" }],
      viewport: { height: 360, width: 640 },
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
    const proposedState = evaluateWorkingState({ ...workingBase, appliedPrograms: [extensionRecord] });
    const commands: ApplyStudioTimelineEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioTimelineEditCompiler: recordingStudioTimelineCompiler(commands),
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot: base.snapshot,
      workingRevision: "studio-working-v1:extend-imported-scene",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
    expect(commands).toHaveLength(1);
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
      proposedState: {
        ...proposedState,
        base: {
          ...proposedState.base,
          sourceSnapshot: { ...proposedState.base.sourceSnapshot, hash: `sha256:${HASH_B}` },
        },
      },
      snapshot: base.snapshot,
      workingRevision: "studio-working-v1:inexact-imported-timeline-source",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });
    expect(rejected).toEqual({
      error: "The verified source snapshot is not one exact imported Scene.",
      kind: "unsupported",
    });
    expect(compilerCalls).toBe(0);

    const coreRejected = await compileStudioPreviewSceneV1({
      applyStudioTimelineEditCompiler: async () => {
        throw "closed timeline authority rejected the edit";
      },
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot: base.snapshot,
      workingRevision: "studio-working-v1:core-rejected-imported-timeline",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });
    expect(coreRejected).toEqual({
      error: "Rust core rejected the imported Scene timeline edit: closed timeline authority rejected the edit",
      kind: "unsupported",
    });
  });

  it("rejects a legacy animated Scene timeline edit before invoking the core use case", async () => {
    const base = await compilablePreviewInput();
    const legacySource = base.snapshot.snapshot.scene.source;
    if (legacySource.kind !== "imported-manim-server-snapshot") throw new Error("Expected a legacy snapshot.");
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
        source: { ...legacySource, snapshotVersion: 7 },
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
      proposedState: evaluateWorkingState({
        ...workingBase,
        appliedPrograms: [programRecord(extension.program, extension)],
      }),
      snapshot,
      workingRevision: "studio-working-v1:extend-animated-imported-scene",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    expect(result).toEqual({
      error: "Editing an imported animation requires generic Runtime Trace authoring support.",
      kind: "unsupported",
    });
    expect(compilerCalls).toBe(0);
  });

  it("forwards every Program and unsupported operation without pre-authorizing them", async () => {
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
    const proposedState = evaluateWorkingState({
      ...workingBase,
      appliedPrograms: [extensionRecord, unsupportedRecord],
    });
    const commands: ApplyStudioTimelineEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioTimelineEditCompiler: recordingStudioTimelineCompiler(commands),
      frame: { height: 9, width: 16 },
      proposedState,
      snapshot: base.snapshot,
      workingRevision: "studio-working-v1:timeline-with-appearance",
      workspaceKey: studioPreviewWorkspaceKeyV1(base.context),
    });

    if (result.kind !== "compiled") throw new Error(result.error);
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
        proposedState: fixture.proposedState,
        snapshot: fixture.snapshot,
        workingRevision: fixture.workingRevision,
        workspaceKey: fixture.workspaceKey,
      });

      if (result.kind !== "compiled") throw new Error(result.error);
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
    const record = programRecord(validation.program, validation);
    const commands: ApplyStaticRootTransformEditWireCommandV1[] = [];
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: recordingStaticRootTransformEditCompiler(commands),
      frame: { height: 9, width: 16 },
      proposedState: evaluateWorkingState({ ...fixture.workingBase, appliedPrograms: [record] }),
      snapshot: fixture.snapshot,
      workingRevision: canonicalEditorWorkingRevision({
        appliedPrograms: [record],
        draftProgram: null,
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
      proposedState: fixture.proposedState,
      snapshot: fixture.snapshot,
      workingRevision: fixture.workingRevision,
      workspaceKey: fixture.workspaceKey,
    });

    expect(result).toMatchObject({
      error: expect.stringContaining("the edit contains an unsupported operation"),
      kind: "unsupported",
    });
  });

  it("rejects mismatched source correlation before invoking the Rust static-root use case", async () => {
    const fixture = await editedStaticRootPreviewInput();
    let compilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: async (bundle) => {
        compilerCalls += 1;
        return bundle;
      },
      frame: { height: 9, width: 16 },
      proposedState: {
        ...fixture.proposedState,
        base: {
          ...fixture.proposedState.base,
          sourceSnapshot: { ...fixture.proposedState.base.sourceSnapshot, hash: `sha256:${HASH_B}` },
        },
      },
      snapshot: fixture.snapshot,
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

  it("passes raw Studio creation Programs without a TypeScript evaluated-state mirror", async () => {
    const { proposedState, snapshot } = await compilablePreviewInput();
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0.5,
      entities: [{ dimensions: { radius: 1 }, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: proposedState.base.runtimeSceneState,
      transactionId: "normalized-create",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const created = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });
    const scale = createDirectManipulationScaleProgram({
      capturedPlayhead: 0.5,
      interval: { end: 0.5, start: 0.5 },
      scales: { [creation.entityIds[0]!]: { from: 1, to: 1.5 } },
      scene: created.evaluatedScene,
      targetEntityIds: creation.entityIds,
      transactionId: "scale-created-circle",
    });
    expect(scale.kind, JSON.stringify(scale.issues)).toBe("valid");
    const edited = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [
        programRecord(creation.validation.program, creation.validation),
        programRecord(scale.program, scale),
      ],
    });
    const commands: ApplyStudioCreationEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioCreationEditCompiler: async (bundle, command) => {
        commands.push(command);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      proposedState: edited,
      snapshot,
      workingRevision: "studio-working-v1:normalized-create",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(result.kind).toBe("compiled");
    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command).toMatchObject({
      expectedBaseRevision: HASH_C,
      frame: { height: 9, width: 16 },
      mathTexOutlines: [],
      schema: "poietra.apply-studio-creation-edit",
      version: 1,
      viewport: { height: 360, width: 640 },
    });
    expect(command?.nextRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(command?.programs).toHaveLength(2);
    expect(command?.programs[0]).toMatchObject({
      anchorResolvedSeconds: 0.5,
      loweringSupported: true,
      scheduleOrder: creation.validation.program.schedule.order,
      transactionId: "normalized-create",
    });
    expect(command?.programs[0]?.operations.map(({ kind }) => kind)).toEqual(["create", "position", "fade-in"]);
    expect(command?.programs[0]?.operations[0]).toMatchObject({
      entity: {
        dimensions: { radius: 1 },
        id: creation.entityIds[0],
        kind: "circle",
        lifetimeEnd: null,
        lifetimeStart: 0.5,
        texParts: null,
      },
      interval: { end: 0.5, start: 0.5 },
      kind: "create",
    });
    expect(command?.programs[1]?.operations[0]).toMatchObject({
      controlPresent: false,
      entityId: creation.entityIds[0],
      from: 1,
      kind: "uniform-scale",
      relativeFactor: 1.5,
      to: 1.5,
    });
  });

  it("attaches compiled MathTex outlines to the normalized Rust command", async () => {
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
    const edited = evaluateWorkingState({
      ...proposedState.base,
      appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
    });
    const compilerInputs: string[][] = [];
    const commands: ApplyStudioCreationEditWireCommandV1[] = [];
    const outline = compiledMathTexResponse();

    const result = await compileStudioPreviewSceneV1({
      applyStudioCreationEditCompiler: async (bundle, command) => {
        commands.push(command);
        return bundle;
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async (input) => {
        compilerInputs.push([...input]);
        return outline;
      },
      proposedState: edited,
      snapshot,
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
  });

  it("surfaces a Rust rejection without recreating creation semantics in TypeScript", async () => {
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
    const commands: ApplyStudioCreationEditWireCommandV1[] = [];

    const result = await compileStudioPreviewSceneV1({
      applyStudioCreationEditCompiler: async (_bundle, command) => {
        commands.push(command);
        throw new Error("normalized Studio creation is unsupported");
      },
      frame: { height: 9, width: 16 },
      proposedState: evaluateWorkingState({
        ...proposedState.base,
        appliedPrograms: [programRecord(creation.validation.program, creation.validation)],
      }),
      snapshot,
      workingRevision: "studio-working-v1:unsupported-text",
      workspaceKey: "project-a/scene.py/CircleScene",
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.programs[0]?.operations[0]).toMatchObject({
      entity: { id: creation.entityIds[0], kind: "other" },
      kind: "create",
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("normalized Studio creation is unsupported"),
      kind: "unsupported",
    });
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
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
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
      proposedState: fixture.edited,
      snapshot: fixture.snapshot,
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
    let outlineCompilerCalls = 0;
    let staticEditCompilerCalls = 0;
    const result = await compileStudioPreviewSceneV1({
      applyStaticRootTransformEditCompiler: async () => {
        staticEditCompilerCalls += 1;
        throw new Error("unsupported static root operation: SetProperty(content)");
      },
      frame: { height: 9, width: 16 },
      mathTexOutlineCompiler: async () => {
        outlineCompilerCalls += 1;
        return compiledMathTexResponse();
      },
      proposedState,
      snapshot: fixture.snapshot,
      workingRevision: "studio-working-v1:edit-imported-mathtex-content",
      workspaceKey: "project-a/scene.py/MathTexScene",
    });
    expect(outlineCompilerCalls).toBe(0);
    expect(staticEditCompilerCalls).toBe(1);
    expect(result).toMatchObject({
      error: expect.stringContaining("unsupported static root operation"),
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
