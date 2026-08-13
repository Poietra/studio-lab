import { describe, expect, it } from "vitest";
import { lowerVerifiedFastManimRuntimeTraceV3 } from "../../server/fast-manim-runtime-trace-v3-lowering";
import { fastManimRuntimeTraceV3Schema } from "../../server/fast-manim-runtime-trace-v3-result-contract";
import genericRuntimeTraceFixture from "../../server/test-fixtures/fast-manim-runtime-trace-v3-generic.json";
import { parseVerifiedSceneIrBundleV1 } from "../engine/contracts";
import type {
  RotateSceneEntityCompiler,
  SetSubtreeVectorPaintAlphaCompiler,
  TransformSceneEntityCompiler,
  TransformSceneEntityWireCommandV1,
} from "../engine/scene-authoring";
import { type SceneIrV1, sceneIrSourceRevisionHash } from "../engine/scene-ir";
import { canonicalFastManimRuntimeTraceSampleTimeV3 } from "../render-pipeline/runtime-trace-v3-shared-contract";
import { evaluateWorkingState, programRecord } from "./evaluator";
import {
  type ProgramRecord,
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
  compileStudioPreviewRuntimeTraceEdit,
  projectStudioPreviewRuntimeTraceEntityPresence,
  projectStudioPreviewRuntimeTraceValidationScene,
  type StudioPreviewRuntimeTraceEditCandidate,
  studioPreviewRuntimeTraceEditAnchor,
  studioPreviewRuntimeTraceEditCandidates,
  studioPreviewRuntimeTraceEditProgramSet,
  studioPreviewRuntimeTraceEditTargetIsPresent,
  studioPreviewRuntimeTraceProgramValidation,
} from "./preview-temporal-rebase";
import {
  createDirectManipulationPositionProgram,
  createDirectManipulationRotationProgram,
  createDirectManipulationScaleProgram,
} from "./suggestion-program";
import {
  compileStudioPreviewSceneV1,
  studioPreviewInteractionAuthority,
  studioPreviewInteractionEntityIdsV1,
  studioPreviewPresentedRuntimeTraceEditAnchor,
} from "./use-preview-renderer";

const FRAME = { height: 8, width: 14.222222222222221 } as const;
const VIEWPORT = { height: 360, width: 640 } as const;
const WORKING_REVISION = "4".repeat(64);
const TEST_ENTITY_ID = "source:test.py#TestScene:square";

function importedSquareEntity(): RuntimeEntity {
  return {
    geometry: {
      dimensions: { kind: "known", value: { height: 2, width: 2 } },
      position: { kind: "known", value: { x: 320, y: 180 } },
      scale: { kind: "known", value: 1 },
      style: { kind: "known", value: {} },
    },
    id: TEST_ENTITY_ID,
    lifetime: [{ end: 3, start: 0 }],
    provisional: false,
    sourceIdentity: { kind: "known", value: "square" },
    type: "Square",
  };
}

function baseRuntimeScene(sceneId: string): RuntimeSceneState {
  return {
    constraintGraph: { constraints: [] },
    duration: 3,
    eventTrack: { events: [] },
    objectGraph: { entities: { [TEST_ENTITY_ID]: importedSquareEntity() }, lineage: [] },
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
      selection: [TEST_ENTITY_ID],
      version: STUDIO_STATE_VERSION,
      viewport: VIEWPORT,
    },
    runtimeSceneState,
    sourceSnapshot: {
      configId: "generic-runtime-trace",
      hash: `sha256:${"0".repeat(64)}`,
      sourceId: "test.py",
      version: STUDIO_STATE_VERSION,
    },
    stagedPrograms: [],
    staticSemanticState: {
      entities: [
        {
          runtimeIdentities: { kind: "known", value: [TEST_ENTITY_ID] },
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

async function genericRuntimeTraceV3Snapshot(traceOverride?: ReturnType<typeof fastManimRuntimeTraceV3Schema.parse>) {
  const trace = traceOverride ?? fastManimRuntimeTraceV3Schema.parse(genericRuntimeTraceFixture);
  const bundle = await lowerVerifiedFastManimRuntimeTraceV3(trace);
  const source = bundle.scene.source;
  const mapping = trace.sourceBindings[0];
  if (source.kind !== "imported-manim-runtime-trace" || !mapping) {
    throw new Error("The generic Runtime Trace fixture lost its source-bound root.");
  }
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    assetPayloads: [],
    correlation: {
      assetsManifestDigest: bundle.assets.manifestDigest,
      context: {
        projectId: trace.projectId,
        sceneName: trace.sceneName,
        sourceDuration: bundle.scene.duration,
        sourceHash: trace.sourceHash,
        sourcePath: trace.sourcePath,
        workingRevision: PRISTINE_WORKING_REVISION,
      },
      engineRevisionHash: source.traceDigest,
      sceneDuration: bundle.scene.duration,
      sceneId: bundle.scene.sceneId,
      serverPublicationRevision: null,
    },
    duration: bundle.scene.duration,
    sceneId: bundle.scene.sceneId,
    snapshot: bundle,
    sourceLabel: "verified Runtime Trace (preview-only)",
    sourceRuntimeIdentity: new Map(
      trace.sourceBindings.map((entry) => [
        entry.binding.name,
        {
          bindingId: entry.binding.id,
          entityId: entry.rootId,
          runtimeTraceEvidence: {
            endpoints: entry.endpoints,
            updaterStatus: entry.updaterStatus,
          },
          sourceName: entry.binding.name,
        },
      ]),
    ),
  };
  return { mapping, snapshot };
}

async function genericRuntimeTraceV3MoveInput() {
  const { snapshot } = await genericRuntimeTraceV3Snapshot();
  const candidate = studioPreviewRuntimeTraceEditCandidates(snapshot, 0, [])[0] ?? null;
  if (!candidate) throw new Error("The generic V3 fixture lost its construction edit candidate.");
  const entity: RuntimeEntity = {
    ...importedSquareEntity(),
    id: candidate.studioEntityId,
    lifetime: [candidate.entityProjection.lifetime],
  };
  const runtimeSceneState: RuntimeSceneState = {
    ...baseRuntimeScene(candidate.studioSceneId),
    duration: candidate.duration,
    objectGraph: { entities: { [entity.id]: entity }, lineage: [] },
    propertyChannels: {},
  };
  const base: WorkingState = {
    ...workingState(runtimeSceneState),
    editorContext: {
      ...workingState(runtimeSceneState).editorContext,
      activeSceneId: candidate.studioSceneId,
      selection: [candidate.studioEntityId],
    },
    sourceSnapshot: {
      configId: snapshot.correlation.context.projectId,
      hash: `sha256:${snapshot.correlation.context.sourceHash}`,
      sourceId: snapshot.correlation.context.sourcePath,
      version: STUDIO_STATE_VERSION,
    },
  };
  const validationScene = projectStudioPreviewRuntimeTraceValidationScene(runtimeSceneState, candidate);
  const validation = createDirectManipulationPositionProgram({
    capturedPlayhead: 0,
    delta: { x: 64, y: -36 },
    positions: { [candidate.studioEntityId]: candidate.baseCenter },
    scene: validationScene,
    start: 0,
    targetEntityIds: [candidate.studioEntityId],
    transactionId: "generic-v3-initial-move",
  });
  if (validation.kind !== "valid") {
    throw new Error(`The generic V3 move fixture is invalid: ${JSON.stringify(validation.issues)}`);
  }
  const record = programRecord(validation.program, validation);
  return {
    base,
    candidate,
    proposedState: evaluateWorkingState({ ...base, appliedPrograms: [record] }),
    record,
    snapshot,
    validationScene,
  };
}

async function genericRuntimeTraceV3ResizeInput(scaleFactor: number) {
  const { base, candidate, snapshot, validationScene } = await genericRuntimeTraceV3MoveInput();
  const validation = createDirectManipulationScaleProgram({
    capturedPlayhead: 0,
    interval: { end: 0, start: 0 },
    scales: { [candidate.studioEntityId]: { from: 1, to: scaleFactor } },
    scene: validationScene,
    targetEntityIds: [candidate.studioEntityId],
    transactionId: "generic-v3-initial-resize",
  });
  if (validation.kind !== "valid") {
    throw new Error(`The generic V3 resize fixture is invalid: ${JSON.stringify(validation.issues)}`);
  }
  const record = programRecord(validation.program, validation);
  return {
    candidate,
    proposedState: evaluateWorkingState({ ...base, appliedPrograms: [record] }),
    record,
    snapshot,
  };
}

async function genericRuntimeTraceV3RotationInput(angleRadians: number) {
  const { base, candidate, snapshot, validationScene } = await genericRuntimeTraceV3MoveInput();
  const validation = createDirectManipulationRotationProgram({
    angleRadians,
    capturedPlayhead: 0,
    entityId: candidate.studioEntityId,
    scene: validationScene,
    start: 0,
    transactionId: "generic-v3-initial-rotation",
  });
  if (validation.kind !== "valid") {
    throw new Error(`The generic V3 rotation fixture is invalid: ${JSON.stringify(validation.issues)}`);
  }
  const record = programRecord(validation.program, validation);
  return {
    base,
    candidate,
    proposedState: evaluateWorkingState({ ...base, appliedPrograms: [record] }),
    record,
    snapshot,
  };
}

async function genericRuntimeTraceV3OpacityInput(opacity: number) {
  const { base, candidate, record: moveRecord, snapshot } = await genericRuntimeTraceV3MoveInput();
  const move = moveRecord.program.operations[0];
  if (!move || move.kind !== "SetProperty") throw new Error("The generic V3 move fixture lost its SetProperty.");
  const operation: CanonicalEditOperation = {
    ...move,
    id: "generic-v3-initial-opacity/operation:set-appearance",
    key: "appearance",
    value: opacity,
  };
  const program = {
    ...moveRecord.program,
    operations: [operation],
    schedule: { ...moveRecord.program.schedule, order: [operation.id] },
    transactionId: "generic-v3-initial-opacity",
  };
  const record: ProgramRecord = { program, validation: { issues: [], status: "valid" } };
  return {
    base,
    candidate,
    proposedState: evaluateWorkingState({ ...base, appliedPrograms: [record] }),
    record,
    snapshot,
  };
}

function candidateOf(
  snapshot: StudioVerifiedPreviewSnapshotV1,
  sourceAnchor = 0,
  sourceEvents: RuntimeSceneState["eventTrack"]["events"] = [],
) {
  return studioPreviewRuntimeTraceEditCandidates(snapshot, sourceAnchor, sourceEvents)[0] ?? null;
}

type RuntimeTraceEditCapability = keyof StudioPreviewRuntimeTraceEditCandidate["capabilities"];

function capabilities(...enabled: readonly RuntimeTraceEditCapability[]) {
  return {
    paintOpacity: enabled.includes("paintOpacity"),
    rotation: enabled.includes("rotation"),
    uniformScale: enabled.includes("uniformScale"),
  };
}

describe("studioPreviewRuntimeTraceEditCandidates", () => {
  it("keeps Runtime Trace validation bound to a staged Program after the playhead leaves its endpoint", async () => {
    const { record, snapshot } = await genericRuntimeTraceV3MoveInput();

    expect(studioPreviewRuntimeTraceEditCandidates(snapshot, snapshot.duration / 2, [])).toEqual([]);
    expect(studioPreviewRuntimeTraceProgramValidation(snapshot, [record], [])).toBe("authorized");
    expect(
      studioPreviewRuntimeTraceProgramValidation(
        snapshot,
        [
          {
            ...record,
            program: {
              ...record.program,
              anchor: {
                ...record.program.anchor,
                capturedPlayhead: snapshot.duration / 2,
                resolvedSeconds: snapshot.duration / 2,
                source: { kind: "absolute", seconds: snapshot.duration / 2 },
              },
            },
          },
        ],
        [],
      ),
    ).toBe("rejected");
  });

  it("projects one pristine source-bound V3 root without inventing a unit scale", async () => {
    const { mapping, snapshot } = await genericRuntimeTraceV3Snapshot();
    const candidate = studioPreviewRuntimeTraceEditCandidates(snapshot, 0, [])[0] ?? null;

    expect(candidate).toEqual({
      baseCenter: { x: 320, y: 180 },
      baseDimensions: mapping.endpoints.terminal.dimensions,
      baseOpacity: null,
      bindingId: mapping.binding.id,
      capabilities: capabilities("uniformScale", "rotation", "paintOpacity"),
      duration: 1 / 60,
      entityProjection: {
        baseCenter: { x: 320, y: 180 },
        kind: "source-position-and-lifetime",
        lifetime: { end: 1 / 60, start: 0 },
      },
      phase: "construction",
      restrictionMessage:
        "Use the dedicated Rotate and Opacity controls for those edits; these Inspector fields support position and uniform scale only.",
      runtimeEntityId: mapping.rootId,
      sourceAnchor: 0,
      studioEntityId: `source:${snapshot.correlation.context.sourcePath}#${snapshot.correlation.context.sceneName}:square`,
      studioSceneId: `${snapshot.correlation.context.sourcePath}#${snapshot.correlation.context.sceneName}`,
      targetSourceName: "square",
      targetType: null,
    });
    expect(candidate).not.toHaveProperty("relativeScale");
    expect(studioPreviewRuntimeTraceEditAnchor(snapshot, 0, [])).toBe(0);
    const interactionAuthority = studioPreviewInteractionAuthority(snapshot, 0, []);
    expect(interactionAuthority).toEqual({
      editableRuntimeEntityIds: [mapping.rootId],
      kind: "bounded-interactive",
      reason: "runtime-trace-edit",
      sourceAnchor: 0,
      verifiedRuntimeEntityIds: [mapping.rootId],
    });
    expect(
      studioPreviewInteractionEntityIdsV1(
        snapshot.sourceRuntimeIdentity,
        interactionAuthority,
        snapshot.snapshot.scene.entities,
      ),
    ).toEqual([mapping.rootId]);
    expect(
      studioPreviewPresentedRuntimeTraceEditAnchor(
        snapshot,
        {
          frame: {
            packetId: "generic-v3-initial",
            revision: "a".repeat(64),
            sampleTime: 0,
            viewport: { heightPx: 360, widthPx: 640 },
          },
          phase: "presented",
        },
        interactionAuthority,
        [],
      ),
    ).toBe(0);
    expect(
      studioPreviewPresentedRuntimeTraceEditAnchor(
        snapshot,
        { detail: null, phase: "fallback", reason: "frame-pending" },
        interactionAuthority,
        [],
      ),
    ).toBeNull();
  });

  it("separates static-paint opacity editability from a uniform current alpha", async () => {
    const { mapping, snapshot } = await genericRuntimeTraceV3Snapshot();
    const mixed = candidateOf(snapshot);
    expect(mixed).toMatchObject({ baseOpacity: null, capabilities: { paintOpacity: true } });

    const uniformScene: SceneIrV1 = {
      ...snapshot.snapshot.scene,
      entities: snapshot.snapshot.scene.entities.map((entity) =>
        entity.appearance.kind !== "vector"
          ? entity
          : {
              ...entity,
              appearance: {
                ...entity.appearance,
                fill: entity.appearance.fill
                  ? {
                      ...entity.appearance.fill,
                      color: { ...entity.appearance.fill.color, alpha: 0.4 },
                    }
                  : null,
                stroke: entity.appearance.stroke
                  ? {
                      ...entity.appearance.stroke,
                      color: { ...entity.appearance.stroke.color, alpha: 0.4 },
                    }
                  : null,
              },
            },
      ),
    };
    expect(candidateOf({ ...snapshot, snapshot: { ...snapshot.snapshot, scene: uniformScene } })).toMatchObject({
      baseOpacity: 0.4,
      capabilities: { paintOpacity: true },
    });

    const child = snapshot.snapshot.scene.entities.find(({ parentId }) => parentId === mapping.rootId);
    if (!child) throw new Error("The generic V3 fixture lost its vector child.");
    const opacityChannel: SceneIrV1["animationChannels"][number] = {
      entityId: child.id,
      id: `${child.id}/test-opacity`,
      keyframes: [
        { at: 0, easingToNext: { kind: "linear" }, value: 1 },
        { at: snapshot.duration, easingToNext: null, value: 0.5 },
      ],
      kind: "opacity",
      provenanceId: child.provenanceId,
    };
    const dynamicScene: SceneIrV1 = {
      ...snapshot.snapshot.scene,
      animationChannels: [...snapshot.snapshot.scene.animationChannels, opacityChannel],
    };
    expect(candidateOf({ ...snapshot, snapshot: { ...snapshot.snapshot, scene: dynamicScene } })).toMatchObject({
      baseOpacity: null,
      capabilities: { paintOpacity: false },
    });

    if (child.appearance.kind !== "vector") throw new Error("The generic V3 paint child changed appearance kind.");
    const appearanceValue = { fill: child.appearance.fill, stroke: child.appearance.stroke };
    const appearanceChannel: SceneIrV1["animationChannels"][number] = {
      entityId: child.id,
      id: `${child.id}/test-vector-appearance`,
      keyframes: [
        { at: 0, easingToNext: { kind: "linear" }, value: appearanceValue },
        { at: snapshot.duration, easingToNext: null, value: appearanceValue },
      ],
      kind: "vector-appearance",
      provenanceId: child.provenanceId,
    };
    const dynamicPaintScene: SceneIrV1 = {
      ...snapshot.snapshot.scene,
      animationChannels: [...snapshot.snapshot.scene.animationChannels, appearanceChannel],
    };
    expect(candidateOf({ ...snapshot, snapshot: { ...snapshot.snapshot, scene: dynamicPaintScene } })).toMatchObject({
      baseOpacity: null,
      capabilities: { paintOpacity: false },
    });

    const paintlessScene: SceneIrV1 = {
      ...snapshot.snapshot.scene,
      entities: snapshot.snapshot.scene.entities.filter(({ id }) => id === mapping.rootId),
    };
    expect(candidateOf({ ...snapshot, snapshot: { ...snapshot.snapshot, scene: paintlessScene } })).toMatchObject({
      baseOpacity: null,
      capabilities: { paintOpacity: false },
    });
  });

  it("rejects updater, degenerate, ambiguous, stale, non-pristine, and non-root evidence", async () => {
    const { snapshot } = await genericRuntimeTraceV3Snapshot();
    const mapping = snapshot.sourceRuntimeIdentity?.get("square");
    if (!mapping?.runtimeTraceEvidence) throw new Error("Generic V3 test mapping lost endpoint evidence.");
    const replaceMapping = (replacement: StudioPreviewSourceRuntimeMappingV1): StudioVerifiedPreviewSnapshotV1 => ({
      ...snapshot,
      sourceRuntimeIdentity: new Map([[replacement.sourceName, replacement]]),
    });
    const evidence = mapping.runtimeTraceEvidence;
    const withEvidence = (
      runtimeTraceEvidence: NonNullable<StudioPreviewSourceRuntimeMappingV1["runtimeTraceEvidence"]>,
    ) => replaceMapping({ ...mapping, runtimeTraceEvidence });

    expect(candidateOf(withEvidence({ ...evidence, updaterStatus: "conflict" }))).toBeNull();
    expect(
      candidateOf(
        withEvidence({
          ...evidence,
          endpoints: {
            ...evidence.endpoints,
            initial: {
              ...evidence.endpoints.initial,
              dimensions: { ...evidence.endpoints.initial.dimensions, width: 0 },
            },
          },
        }),
      ),
    ).toBeNull();
    expect(
      candidateOf({
        ...snapshot,
        sourceRuntimeIdentity: new Map([
          ...snapshot.sourceRuntimeIdentity!,
          ["alias", { ...mapping, bindingId: "binding:alias", sourceName: "alias" }],
        ]),
      }),
    ).toBeNull();
    expect(
      candidateOf({
        ...snapshot,
        correlation: { ...snapshot.correlation, engineRevisionHash: "f".repeat(64) },
      }),
    ).toBeNull();
    expect(
      candidateOf({
        ...snapshot,
        correlation: {
          ...snapshot.correlation,
          context: { ...snapshot.correlation.context, workingRevision: WORKING_REVISION },
        },
      }),
    ).toBeNull();
    expect(
      candidateOf({
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          scene: {
            ...snapshot.snapshot.scene,
            entities: snapshot.snapshot.scene.entities.map((entity) =>
              entity.id === mapping.entityId ? { ...entity, parentId: "runtime:invented-parent" } : entity,
            ),
          },
        },
      }),
    ).toBeNull();
  });

  it("keeps the mapped binding editable when the scene holds additional unmapped runtime roots", async () => {
    const { snapshot } = await genericRuntimeTraceV3Snapshot();
    const mapping = snapshot.sourceRuntimeIdentity?.get("square");
    if (!mapping) throw new Error("Generic V3 test mapping lost endpoint evidence.");
    const extraRoot = snapshot.snapshot.scene.entities.find(({ parentId }) => parentId !== null);
    if (!extraRoot) throw new Error("Generic V3 fixture needs one drawable child.");
    const candidates = studioPreviewRuntimeTraceEditCandidates(
      {
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          scene: {
            ...snapshot.snapshot.scene,
            entities: snapshot.snapshot.scene.entities.map((entity) =>
              entity.id === extraRoot.id ? { ...entity, parentId: null } : entity,
            ),
          },
        },
      },
      0,
      [],
    );
    expect(candidates.map(({ runtimeEntityId }) => runtimeEntityId)).toEqual([mapping.entityId]);
  });

  it("mints construction and settled authority from the same verified terminal geometry", async () => {
    const { snapshot } = await genericRuntimeTraceV3Snapshot();
    const pristine = candidateOf(snapshot);
    const mapping = snapshot.sourceRuntimeIdentity?.get("square");
    if (!pristine || !mapping?.runtimeTraceEvidence) throw new Error("Generic V3 test mapping lost endpoint evidence.");
    const evidence = mapping.runtimeTraceEvidence;
    const terminal = evidence.endpoints.terminal;
    const settledSourceAnchor = canonicalFastManimRuntimeTraceSampleTimeV3(1);
    const settledDuration = 2 / 60;
    const modifiedSnapshot: StudioVerifiedPreviewSnapshotV1 = {
      ...snapshot,
      correlation: {
        ...snapshot.correlation,
        context: { ...snapshot.correlation.context, sourceDuration: settledDuration },
        sceneDuration: settledDuration,
      },
      duration: settledDuration,
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          duration: settledDuration,
          entities: snapshot.snapshot.scene.entities.map((entity) =>
            entity.id === mapping.entityId ? { ...entity, lifetimes: [{ end: settledDuration, start: 0 }] } : entity,
          ),
        },
      },
      sourceRuntimeIdentity: new Map([
        [
          "square",
          {
            ...mapping,
            runtimeTraceEvidence: {
              ...evidence,
              endpoints: {
                ...evidence.endpoints,
                terminal: {
                  ...terminal,
                  center: { x: terminal.center.x + 0.5, y: terminal.center.y + 0.25 },
                  dimensions: { height: terminal.dimensions.height * 1.5, width: terminal.dimensions.width * 1.5 },
                  frameIndex: 1,
                  sampleTime: settledSourceAnchor,
                },
              },
            },
          },
        ],
      ]),
    };
    const sourceEvents: RuntimeSceneState["eventTrack"]["events"] = [
      {
        id: "import:generic:wait:1",
        interval: { end: settledDuration, start: settledSourceAnchor },
        kind: "wait",
        label: "wait",
      },
    ];
    const construction = candidateOf(modifiedSnapshot, 0);
    const settled = candidateOf(modifiedSnapshot, settledSourceAnchor + 0.01, sourceEvents);
    if (!construction || !settled) throw new Error("Both verified endpoint candidates must mint.");
    expect(construction).toMatchObject({ phase: "construction", sourceAnchor: 0 });
    expect(settled).toMatchObject({
      capabilities: capabilities("uniformScale"),
      phase: "settled",
      sourceAnchor: settledSourceAnchor,
    });
    expect(construction.baseDimensions).toEqual({
      height: terminal.dimensions.height * 1.5,
      width: terminal.dimensions.width * 1.5,
    });
    // 45 studio px per world unit at frame width 128/9 on the 640x360 studio
    // stage; studio y grows downward.
    expect(pristine.baseCenter).toEqual({ x: 320, y: 180 });
    expect(construction.baseCenter).toEqual({ x: 320 + 0.5 * 45, y: 180 - 0.25 * 45 });
    expect(settled.baseCenter).toEqual(construction.baseCenter);
    expect(studioPreviewRuntimeTraceEditAnchor(modifiedSnapshot, settledSourceAnchor + 0.01, sourceEvents)).toBe(
      settledSourceAnchor,
    );
    expect(candidateOf(modifiedSnapshot, settledSourceAnchor, sourceEvents)).toMatchObject({
      phase: "settled",
      sourceAnchor: settledSourceAnchor,
    });
    expect(candidateOf(modifiedSnapshot, settledSourceAnchor + 0.01, [])).toBeNull();
    expect(
      candidateOf(modifiedSnapshot, settledSourceAnchor + 0.01, [
        sourceEvents[0]!,
        { ...sourceEvents[0]!, id: "import:generic:wait:2" },
      ]),
    ).toBeNull();
    expect(
      candidateOf(modifiedSnapshot, settledSourceAnchor + 0.01, [
        { ...sourceEvents[0]!, operationId: "studio-authored-wait" },
      ]),
    ).toBeNull();
    expect(
      candidateOf(modifiedSnapshot, settledSourceAnchor + 0.01, [
        { ...sourceEvents[0]!, interval: { end: settledDuration - 0.001, start: settledSourceAnchor } },
      ]),
    ).toBeNull();
    expect(
      candidateOf(modifiedSnapshot, settledSourceAnchor + 0.005, [
        { ...sourceEvents[0]!, interval: { end: settledDuration, start: settledSourceAnchor + 0.001 } },
      ]),
    ).toBeNull();
  });

  it("allows settled authority for a later root without construction evidence", async () => {
    const { snapshot } = await genericRuntimeTraceV3Snapshot();
    const mapping = snapshot.sourceRuntimeIdentity?.get("square");
    if (!mapping?.runtimeTraceEvidence) throw new Error("Generic V3 test mapping lost endpoint evidence.");
    const duration = 2 / 60;
    const lifetime = { end: duration, start: 0.005 };
    const laterRootSnapshot: StudioVerifiedPreviewSnapshotV1 = {
      ...snapshot,
      correlation: {
        ...snapshot.correlation,
        context: { ...snapshot.correlation.context, sourceDuration: duration },
        sceneDuration: duration,
      },
      duration,
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          duration,
          entities: snapshot.snapshot.scene.entities.map((entity) =>
            entity.id === mapping.entityId ? { ...entity, lifetimes: [lifetime] } : entity,
          ),
        },
      },
      sourceRuntimeIdentity: new Map([
        [
          "square",
          {
            ...mapping,
            runtimeTraceEvidence: {
              ...mapping.runtimeTraceEvidence,
              endpoints: {
                ...mapping.runtimeTraceEvidence.endpoints,
                initial: {
                  ...mapping.runtimeTraceEvidence.endpoints.initial,
                  frameIndex: 1,
                  sampleTime: canonicalFastManimRuntimeTraceSampleTimeV3(1),
                },
                terminal: {
                  ...mapping.runtimeTraceEvidence.endpoints.terminal,
                  frameIndex: 1,
                  sampleTime: canonicalFastManimRuntimeTraceSampleTimeV3(1),
                },
              },
            },
          },
        ],
      ]),
    };
    const waitStart = 0.006;
    const events: RuntimeSceneState["eventTrack"]["events"] = [
      {
        id: "import:later-root:wait:1",
        interval: { end: duration, start: waitStart },
        kind: "wait",
        label: "wait",
      },
    ];

    expect(candidateOf(laterRootSnapshot, 0, events)).toBeNull();
    expect(candidateOf(laterRootSnapshot, 0.01, events)).toMatchObject({
      phase: "settled",
      sourceAnchor: waitStart,
    });
  });

  it("mints one candidate per positively-dimensioned mapping from a Feynman-shaped multi-root trace", async () => {
    const trace = fastManimRuntimeTraceV3Schema.parse(structuredClone(genericRuntimeTraceFixture));
    const selected = trace.sourceBindings[0]!;
    const baseRoot = trace.roots[0]!;
    // Mirror the FeynmanDiagram baseline: sibling roots exist from frame zero
    // but their initial endpoints report degenerate 0x0 dimensions, so only
    // the labels-shaped binding may mint a candidate.
    const positiveSiblings = new Set(["photon"]);
    ["electron1", "electron2", "photon"].forEach((name, index) => {
      const rootId = `${baseRoot.id.slice(0, -1)}${index + 1}`;
      trace.roots.push({ id: rootId, lifetimes: structuredClone(baseRoot.lifetimes), sceneOrder: index + 1 });
      trace.draws.push({
        familyPath: [],
        id: `${rootId}/draw:0`,
        lifetimes: structuredClone(baseRoot.lifetimes),
        rootId,
      });
      for (const frame of trace.frames) {
        frame.states.push({
          ...structuredClone(frame.states[0]!),
          drawId: `${rootId}/draw:0`,
          paintOrder: frame.states.length,
        });
      }
      const endpoints = structuredClone(selected.endpoints);
      if (!positiveSiblings.has(name)) endpoints.initial.dimensions = { height: 0, width: 0 };
      trace.sourceBindings.push({
        binding: {
          ...structuredClone(selected.binding),
          id: `source-binding:${String(index + 1).repeat(64)}`,
          name,
          ordinal: index + 2,
        },
        endpoints,
        rootId,
        updaterStatus: "none",
      });
    });
    const { snapshot } = await genericRuntimeTraceV3Snapshot(trace);
    expect(snapshot.sourceRuntimeIdentity?.size).toBe(4);

    const candidates = studioPreviewRuntimeTraceEditCandidates(snapshot, 0, []);
    expect(candidates.map(({ targetSourceName }) => targetSourceName)).toEqual(["square", "photon"]);
    expect(candidates[0]!.runtimeEntityId).toBe(selected.rootId);
    expect(candidates[1]!.runtimeEntityId).toBe(`${selected.rootId.slice(0, -1)}3`);
    expect(new Set(candidates.map(({ studioEntityId }) => studioEntityId)).size).toBe(2);
  });
});

describe("generic Runtime Trace V3 construction edit", () => {
  it("projects only producer-backed position and lifetime evidence into Studio validation", async () => {
    const { candidate, validationScene } = await genericRuntimeTraceV3MoveInput();
    const target = validationScene.objectGraph.entities[candidate.studioEntityId];
    expect(target).toMatchObject({
      geometry: {
        dimensions: { kind: "known", value: { height: 2, width: 2 } },
        position: { kind: "known", value: candidate.baseCenter },
        scale: { kind: "known", value: 1 },
      },
      lifetime: [candidate.entityProjection.lifetime],
    });
    const projected = projectStudioPreviewRuntimeTraceEntityPresence(
      [
        {
          ...target!,
          geometry: target!.geometry!,
          opacity: 1,
          position: { x: 0, y: 0 },
          present: false,
          scale: 1,
        },
      ],
      candidate,
      new Map([[candidate.runtimeEntityId, {}]]),
      0,
    );
    expect(projected[0]).toMatchObject({
      geometry: { position: { kind: "known", value: candidate.baseCenter } },
      position: candidate.baseCenter,
      present: true,
    });
    expect(studioPreviewRuntimeTraceEditTargetIsPresent(validationScene, candidate.studioEntityId, 0, candidate)).toBe(
      true,
    );
  });

  it("normalizes an unknown source scale only for the verified candidate's relative resize", async () => {
    const { base, candidate } = await genericRuntimeTraceV3MoveInput();
    const sourceEntity = base.runtimeSceneState.objectGraph.entities[candidate.studioEntityId];
    if (!sourceEntity?.geometry) throw new Error("The Runtime Trace fixture lost its source-projected geometry.");
    const unknownScale = { kind: "unknown" as const, reason: "Scale is computed by Python at runtime." };
    const unknownScaleScene: RuntimeSceneState = {
      ...base.runtimeSceneState,
      objectGraph: {
        ...base.runtimeSceneState.objectGraph,
        entities: {
          ...base.runtimeSceneState.objectGraph.entities,
          [candidate.studioEntityId]: {
            ...sourceEntity,
            geometry: { ...sourceEntity.geometry, scale: unknownScale },
          },
        },
      },
    };
    const resize = (scene: RuntimeSceneState) =>
      createDirectManipulationScaleProgram({
        capturedPlayhead: candidate.sourceAnchor,
        interval: { end: candidate.sourceAnchor, start: candidate.sourceAnchor },
        scales: { [candidate.studioEntityId]: { from: 1, to: 1.5 } },
        scene,
        targetEntityIds: [candidate.studioEntityId],
        transactionId: "generic-runtime-trace-unknown-scale-resize",
      });

    expect(resize(unknownScaleScene).kind).toBe("invalid");
    expect(projectStudioPreviewRuntimeTraceValidationScene(unknownScaleScene, null)).toBe(unknownScaleScene);
    const positionOnlyCandidate: StudioPreviewRuntimeTraceEditCandidate = {
      ...candidate,
      capabilities: { ...candidate.capabilities, uniformScale: false },
    };
    const positionOnlyScene = projectStudioPreviewRuntimeTraceValidationScene(unknownScaleScene, positionOnlyCandidate);
    expect(positionOnlyScene.objectGraph.entities[candidate.studioEntityId]?.geometry?.scale).toEqual(unknownScale);
    expect(resize(positionOnlyScene).kind).toBe("invalid");

    const candidateValidationScene = projectStudioPreviewRuntimeTraceValidationScene(unknownScaleScene, candidate);
    expect(candidateValidationScene.objectGraph.entities[candidate.studioEntityId]?.geometry?.scale).toEqual({
      kind: "known",
      value: 1,
    });
    expect(resize(candidateValidationScene).kind).toBe("valid");

    const sourceProjection = projectStudioPreviewRuntimeTraceEntityPresence(
      [
        {
          ...(sourceEntity.content ? { content: sourceEntity.content } : {}),
          geometry: { ...sourceEntity.geometry, scale: unknownScale },
          id: sourceEntity.id,
          opacity: 1,
          position: candidate.baseCenter,
          present: true,
          provisional: sourceEntity.provisional,
          scale: 2,
          sourceIdentity: sourceEntity.sourceIdentity,
          ...(sourceEntity.transactionId ? { transactionId: sourceEntity.transactionId } : {}),
          type: sourceEntity.type,
        },
      ],
      candidate,
      new Map([[candidate.runtimeEntityId, {}]]),
      candidate.sourceAnchor,
    );
    expect(sourceProjection[0]).toMatchObject({
      geometry: { scale: { kind: "known", value: 1 } },
      scale: 1,
    });
  });

  it("authorizes the one candidate the staged Program targets and rejects absent or ambiguous targets", async () => {
    const { candidate, record } = await genericRuntimeTraceV3MoveInput();
    const sibling = {
      ...candidate,
      bindingId: `source-binding:${"a".repeat(64)}`,
      runtimeEntityId: `${candidate.runtimeEntityId.slice(0, -1)}1`,
      sourceName: "circle",
      studioEntityId: candidate.studioEntityId.replace(/:square$/, ":circle"),
    };
    expect(studioPreviewRuntimeTraceEditProgramSet([record], [sibling, candidate])).toEqual({
      candidate,
      edit: { kind: "move", position: { x: 384, y: 144 } },
      kind: "authorized",
    });
    expect(studioPreviewRuntimeTraceEditProgramSet([record], [sibling])).toEqual({ kind: "unauthorized" });
    expect(studioPreviewRuntimeTraceEditProgramSet([record], [candidate, candidate])).toEqual({
      kind: "unauthorized",
    });
  });

  it("authorizes one direct t=0 position or uniform-resize Program and rejects every wider Program set", async () => {
    const { candidate, record, validationScene } = await genericRuntimeTraceV3MoveInput();
    expect(studioPreviewRuntimeTraceEditProgramSet([], [candidate])).toEqual({ kind: "none" });
    expect(studioPreviewRuntimeTraceEditProgramSet([record], [candidate])).toEqual({
      candidate,
      edit: { kind: "move", position: { x: 384, y: 144 } },
      kind: "authorized",
    });
    expect(studioPreviewRuntimeTraceEditProgramSet([record, record], [candidate])).toEqual({
      kind: "unauthorized",
    });

    const resize = createDirectManipulationScaleProgram({
      capturedPlayhead: 0,
      interval: { end: 0, start: 0 },
      scales: { [candidate.studioEntityId]: { from: 1, to: 1.5 } },
      scene: validationScene,
      targetEntityIds: [candidate.studioEntityId],
      transactionId: "generic-v3-resize",
    });
    if (resize.kind !== "valid") throw new Error("Generic resize fixture did not validate.");
    const resizeRecord = programRecord(resize.program, resize);
    expect(studioPreviewRuntimeTraceEditProgramSet([resizeRecord], [candidate])).toEqual({
      candidate,
      edit: { kind: "resize", scaleFactor: 1.5 },
      kind: "authorized",
    });
    expect(studioPreviewRuntimeTraceEditProgramSet([record, resizeRecord], [candidate])).toEqual({
      kind: "unauthorized",
    });

    const rebasedResize = createDirectManipulationScaleProgram({
      capturedPlayhead: 0,
      interval: { end: 0, start: 0 },
      scales: { [candidate.studioEntityId]: { from: 2, to: 3 } },
      scene: validationScene,
      targetEntityIds: [candidate.studioEntityId],
      transactionId: "generic-v3-resize-rebased",
    });
    if (rebasedResize.kind !== "valid") throw new Error("Generic rebased resize fixture did not validate.");
    expect(
      studioPreviewRuntimeTraceEditProgramSet([programRecord(rebasedResize.program, rebasedResize)], [candidate]),
    ).toEqual({
      candidate,
      edit: { kind: "resize", scaleFactor: 1.5 },
      kind: "authorized",
    });

    const identityResize = createDirectManipulationScaleProgram({
      capturedPlayhead: 0,
      interval: { end: 0, start: 0 },
      scales: { [candidate.studioEntityId]: { from: 1, to: 1 } },
      scene: validationScene,
      targetEntityIds: [candidate.studioEntityId],
      transactionId: "generic-v3-resize-identity",
    });
    if (identityResize.kind !== "valid") throw new Error("Generic identity resize fixture did not validate.");
    expect(
      studioPreviewRuntimeTraceEditProgramSet([programRecord(identityResize.program, identityResize)], [candidate]),
    ).toEqual({ kind: "unauthorized" });
    expect(
      studioPreviewRuntimeTraceEditProgramSet(
        [
          {
            ...record,
            program: {
              ...record.program,
              provenance: { ...record.program.provenance, origin: "remote-model" },
            },
          },
        ],
        [candidate],
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  it("authorizes one bounded absolute opacity on static paint and rejects unsafe or no-op values", async () => {
    const { candidate, record } = await genericRuntimeTraceV3OpacityInput(0.25);
    expect(studioPreviewRuntimeTraceEditProgramSet([record], [candidate])).toEqual({
      candidate,
      edit: { kind: "opacity", opacity: 0.25 },
      kind: "authorized",
    });

    const operation = record.program.operations[0];
    if (!operation || operation.kind !== "SetProperty") throw new Error("Opacity fixture lost its SetProperty.");
    const withValue = (value: number): ProgramRecord => ({
      ...record,
      program: { ...record.program, operations: [{ ...operation, value }] },
    });
    expect(studioPreviewRuntimeTraceEditProgramSet([withValue(Number.NaN)], [candidate])).toEqual({
      kind: "unauthorized",
    });
    expect(studioPreviewRuntimeTraceEditProgramSet([withValue(1.01)], [candidate])).toEqual({
      kind: "unauthorized",
    });
    expect(studioPreviewRuntimeTraceEditProgramSet([record], [{ ...candidate, baseOpacity: 0.25 }])).toEqual({
      kind: "unauthorized",
    });
    expect(
      studioPreviewRuntimeTraceEditProgramSet(
        [record],
        [{ ...candidate, baseOpacity: null, capabilities: { ...candidate.capabilities, paintOpacity: false } }],
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  it("routes authorized static-paint opacity through the Rust core and adopts its bundle", async () => {
    const { candidate, proposedState, snapshot } = await genericRuntimeTraceV3OpacityInput(0.25);
    const root = snapshot.snapshot.scene.entities.find(({ id }) => id === candidate.runtimeEntityId);
    const child = snapshot.snapshot.scene.entities.find(({ parentId }) => parentId === candidate.runtimeEntityId);
    if (!root || child?.appearance.kind !== "vector") throw new Error("Generic V3 fixture lost its paint subtree.");
    const operationId = proposedState.programs[0]?.program.operations[0]?.id;
    if (!operationId) throw new Error("Generic V3 opacity fixture lost its authorized operation.");
    const coreAlpha = 0.375;
    const commands: Parameters<SetSubtreeVectorPaintAlphaCompiler>[1][] = [];
    const subtreePaintAlphaCompiler: SetSubtreeVectorPaintAlphaCompiler = async (bundle, command) => {
      commands.push(command);
      return await parseVerifiedSceneIrBundleV1({
        ...bundle,
        scene: {
          ...bundle.scene,
          entities: bundle.scene.entities.map((entity) => {
            if (entity.id !== child.id || entity.appearance.kind !== "vector") return entity;
            return {
              ...entity,
              appearance: {
                ...entity.appearance,
                fill: entity.appearance.fill
                  ? { ...entity.appearance.fill, color: { ...entity.appearance.fill.color, alpha: coreAlpha } }
                  : null,
                stroke: entity.appearance.stroke
                  ? { ...entity.appearance.stroke, color: { ...entity.appearance.stroke.color, alpha: coreAlpha } }
                  : null,
              },
              provenanceId: command.provenance.id,
            };
          }),
          provenance: [...bundle.scene.provenance, command.provenance],
          source: {
            editProgramVersion: 1,
            kind: "studio-edit-program",
            revisionHash: command.nextRevision,
          },
        },
      });
    };

    const result = await compileStudioPreviewRuntimeTraceEdit({
      frame: FRAME,
      proposedState,
      snapshot,
      sourceRevisionHash: "b".repeat(64),
      subtreePaintAlphaCompiler,
    });
    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") throw new Error(result.issue.message);
    const editedRoot = result.scene.entities.find(({ id }) => id === root.id);
    const editedChild = result.scene.entities.find(({ id }) => id === child.id);
    if (editedChild?.appearance.kind !== "vector") throw new Error("Rebased V3 paint child is missing.");
    expect(editedRoot).toEqual(root);
    expect(editedChild.appearance).toEqual({
      ...child.appearance,
      fill: child.appearance.fill
        ? { ...child.appearance.fill, color: { ...child.appearance.fill.color, alpha: coreAlpha } }
        : null,
      stroke: child.appearance.stroke
        ? { ...child.appearance.stroke, color: { ...child.appearance.stroke.color, alpha: coreAlpha } }
        : null,
    });
    expect(editedChild.appearance.opacity).toBe(child.appearance.opacity);
    expect(result.scene.animationChannels).toEqual(snapshot.snapshot.scene.animationChannels);
    expect(result.scene.provenance.at(-1)?.id).toBe(`studio-runtime-trace-construction-opacity:${"b".repeat(64)}`);
    expect(commands).toEqual([
      {
        alpha: 0.25,
        expectedBaseRevision: sceneIrSourceRevisionHash(snapshot.snapshot.scene),
        nextRevision: "b".repeat(64),
        provenance: {
          evidence: [
            "Studio construction-time absolute opacity request projected onto static vector paints in one verified Runtime Trace root",
            `source binding ${candidate.bindingId}`,
            `authorized operation ${operationId}`,
          ],
          id: `studio-runtime-trace-construction-opacity:${"b".repeat(64)}`,
          origin: "studio-edit-program",
        },
        rootEntityId: root.id,
        schema: "poietra.set-subtree-vector-paint-alpha",
        version: 1,
      },
    ]);

    const compiled = await compileStudioPreviewSceneV1({
      frame: FRAME,
      proposedState,
      snapshot,
      subtreePaintAlphaCompiler,
      workingRevision: "generic-v3-initial-opacity-revision",
      workspaceKey: "generic-preview/scenes/staticsquare.py/StaticSquare",
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled") throw new Error(compiled.error);
    const compiledChild = compiled.scene.bundle.scene.entities.find(({ id }) => id === child.id);
    if (compiledChild?.appearance.kind !== "vector") throw new Error("Compiled V3 paint child is missing.");
    expect(compiledChild.appearance.fill?.color.alpha ?? compiledChild.appearance.stroke?.color.alpha).toBe(coreAlpha);
  });

  it("authorizes one finite t=0 rotation and rejects non-finite or mismatched authority", async () => {
    const { base, candidate, proposedState, record, snapshot } = await genericRuntimeTraceV3RotationInput(Math.PI / 4);
    expect(studioPreviewRuntimeTraceEditProgramSet([record], [candidate])).toEqual({
      candidate,
      edit: { angleRadians: Math.PI / 4, kind: "rotation" },
      kind: "authorized",
    });
    expect(studioPreviewRuntimeTraceEditProgramSet([record], [])).toEqual({ kind: "unauthorized" });

    const operation = record.program.operations[0];
    if (!operation || operation.kind !== "AnimateProperty") {
      throw new Error("Rotation fixture lost its relative AnimateProperty.");
    }
    const forgedRecord: ProgramRecord = {
      ...record,
      program: { ...record.program, operations: [{ ...operation, relativeDelta: Number.NaN, to: Number.NaN }] },
    };
    expect(studioPreviewRuntimeTraceEditProgramSet([forgedRecord], [candidate])).toEqual({
      kind: "unauthorized",
    });
    expect(
      await compileStudioPreviewRuntimeTraceEdit({
        frame: FRAME,
        proposedState: { ...proposedState, base, programs: [forgedRecord] },
        snapshot,
        sourceRevisionHash: "9".repeat(64),
      }),
    ).toMatchObject({ issue: { code: "target-edit-unsupported" }, kind: "unsupported" });
  });

  it("translates the verified root group without flattening its children", async () => {
    const { candidate, proposedState, snapshot } = await genericRuntimeTraceV3MoveInput();
    const root = snapshot.snapshot.scene.entities.find(({ id }) => id === candidate.runtimeEntityId);
    const child = snapshot.snapshot.scene.entities.find(({ parentId }) => parentId === candidate.runtimeEntityId);
    if (!root || !child) throw new Error("Generic V3 fixture lost its root hierarchy.");
    const operationId = proposedState.programs[0]?.program.operations[0]?.id;
    if (!operationId) throw new Error("Generic V3 move fixture lost its authorized operation.");
    const coreTransform = { ...root.transform, tx: root.transform.tx + 9, ty: root.transform.ty - 4 };
    const commands: TransformSceneEntityWireCommandV1[] = [];
    const transformCompiler: TransformSceneEntityCompiler = async (bundle, command) => {
      commands.push(command);
      return await parseVerifiedSceneIrBundleV1({
        ...bundle,
        scene: {
          ...bundle.scene,
          entities: bundle.scene.entities.map((entity) =>
            entity.id === command.entityId
              ? { ...entity, provenanceId: command.provenance.id, transform: coreTransform }
              : entity,
          ),
          provenance: [...bundle.scene.provenance, command.provenance],
          source: {
            editProgramVersion: 1,
            kind: "studio-edit-program",
            revisionHash: command.nextRevision,
          },
        },
      });
    };
    const result = await compileStudioPreviewRuntimeTraceEdit({
      frame: FRAME,
      proposedState,
      snapshot,
      sourceRevisionHash: "7".repeat(64),
      transformCompiler,
    });
    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") throw new Error(result.issue.message);
    const movedRoot = result.scene.entities.find(({ id }) => id === root.id);
    const retainedChild = result.scene.entities.find(({ id }) => id === child.id);
    expect(movedRoot?.transform).toEqual(coreTransform);
    expect(retainedChild).toEqual(child);
    expect(result.scene.source).toEqual({
      editProgramVersion: 1,
      kind: "studio-edit-program",
      revisionHash: "7".repeat(64),
    });
    const directCommand = commands[0];
    if (!directCommand) throw new Error("Generic V3 move did not reach the Rust compiler boundary.");
    expect(directCommand).toMatchObject({
      entityId: root.id,
      expectedBaseRevision: sceneIrSourceRevisionHash(snapshot.snapshot.scene),
      nextRevision: "7".repeat(64),
      provenance: {
        evidence: [
          "Studio construction position request projected onto one verified Runtime Trace root",
          `source binding ${candidate.bindingId}`,
          `authorized operation ${operationId}`,
        ],
        id: `studio-runtime-trace-construction-move:${"7".repeat(64)}`,
        origin: "studio-edit-program",
      },
      schema: "poietra.transform-scene-entity",
      version: 1,
    });
    expect(directCommand.delta.x).toBeCloseTo(64 / 45, 12);
    expect(directCommand.delta.y).toBeCloseTo(0.8, 12);

    const compiled = await compileStudioPreviewSceneV1({
      frame: FRAME,
      proposedState,
      snapshot,
      transformCompiler,
      workingRevision: "generic-v3-initial-move-revision",
      workspaceKey: "generic-preview/scenes/staticsquare.py/StaticSquare",
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled") throw new Error(compiled.error);
    expect(compiled.scene.interactionEntityIds).toEqual([candidate.runtimeEntityId]);
    expect(compiled.scene.bundle.scene.entities.find(({ id }) => id === root.id)?.transform).toEqual(
      movedRoot?.transform,
    );
  });

  it("scales the verified root group about its construction center without flattening its children", async () => {
    const { candidate, proposedState, snapshot } = await genericRuntimeTraceV3ResizeInput(1.5);
    expect(candidate.baseCenter).toEqual({ x: 320, y: 180 });
    const root = snapshot.snapshot.scene.entities.find(({ id }) => id === candidate.runtimeEntityId);
    const child = snapshot.snapshot.scene.entities.find(({ parentId }) => parentId === candidate.runtimeEntityId);
    if (!root || !child) throw new Error("Generic V3 fixture lost its root hierarchy.");
    const operationId = proposedState.programs[0]?.program.operations[0]?.id;
    if (!operationId) throw new Error("Generic V3 resize fixture lost its authorized operation.");
    const coreTransform = { ...root.transform, m22: root.transform.m22 + 0.25 };
    const commands: TransformSceneEntityWireCommandV1[] = [];
    const transformCompiler: TransformSceneEntityCompiler = async (bundle, command) => {
      commands.push(command);
      return await parseVerifiedSceneIrBundleV1({
        ...bundle,
        scene: {
          ...bundle.scene,
          entities: bundle.scene.entities.map((entity) =>
            entity.id === command.entityId
              ? { ...entity, provenanceId: command.provenance.id, transform: coreTransform }
              : entity,
          ),
          provenance: [...bundle.scene.provenance, command.provenance],
          source: {
            editProgramVersion: 1,
            kind: "studio-edit-program",
            revisionHash: command.nextRevision,
          },
        },
      });
    };
    const result = await compileStudioPreviewRuntimeTraceEdit({
      frame: FRAME,
      proposedState,
      snapshot,
      sourceRevisionHash: "8".repeat(64),
      transformCompiler,
    });
    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") throw new Error(result.issue.message);
    const scaledRoot = result.scene.entities.find(({ id }) => id === root.id);
    const retainedChild = result.scene.entities.find(({ id }) => id === child.id);
    expect(scaledRoot?.transform).toEqual(coreTransform);
    expect(retainedChild).toEqual(child);
    expect(result.scene.provenance.at(-1)?.id).toBe(`studio-runtime-trace-construction-resize:${"8".repeat(64)}`);
    expect(commands).toEqual([
      {
        delta: { x: 0, y: 0 },
        entityId: root.id,
        expectedBaseRevision: sceneIrSourceRevisionHash(snapshot.snapshot.scene),
        nextRevision: "8".repeat(64),
        provenance: {
          evidence: [
            "Studio construction uniform resize request projected onto one verified Runtime Trace root",
            `source binding ${candidate.bindingId}`,
            `authorized operation ${operationId}`,
          ],
          id: `studio-runtime-trace-construction-resize:${"8".repeat(64)}`,
          origin: "studio-edit-program",
        },
        schema: "poietra.transform-scene-entity",
        scale: { pivot: { x: 0, y: 0 }, xFactor: 1.5, yFactor: 1.5 },
        version: 1,
      },
    ]);

    const compiled = await compileStudioPreviewSceneV1({
      frame: FRAME,
      proposedState,
      snapshot,
      transformCompiler,
      workingRevision: "generic-v3-initial-resize-revision",
      workspaceKey: "generic-preview/scenes/staticsquare.py/StaticSquare",
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind !== "compiled") throw new Error(compiled.error);
    expect(compiled.scene.bundle.scene.entities.find(({ id }) => id === root.id)?.transform).toEqual(
      scaledRoot?.transform,
    );
  });

  it("rotates the verified root group about its settled center without flattening its children", async () => {
    const angleRadians = Math.PI / 2;
    const { candidate, proposedState, snapshot } = await genericRuntimeTraceV3RotationInput(angleRadians);
    expect(candidate.baseCenter).toEqual({ x: 320, y: 180 });
    const root = snapshot.snapshot.scene.entities.find(({ id }) => id === candidate.runtimeEntityId);
    const child = snapshot.snapshot.scene.entities.find(({ parentId }) => parentId === candidate.runtimeEntityId);
    if (!root || !child) throw new Error("Generic V3 fixture lost its root hierarchy.");
    const operationId = proposedState.programs[0]?.program.operations[0]?.id;
    if (!operationId) throw new Error("Generic V3 rotation fixture lost its authorized operation.");
    const coreTransform = { ...root.transform, m11: root.transform.m11 + 0.125 };
    const commands: Parameters<RotateSceneEntityCompiler>[1][] = [];
    const rotationCompiler: RotateSceneEntityCompiler = async (bundle, command) => {
      commands.push(command);
      return await parseVerifiedSceneIrBundleV1({
        ...bundle,
        scene: {
          ...bundle.scene,
          entities: bundle.scene.entities.map((entity) =>
            entity.id === command.entityId
              ? { ...entity, provenanceId: command.provenance.id, transform: coreTransform }
              : entity,
          ),
          provenance: [...bundle.scene.provenance, command.provenance],
          source: {
            editProgramVersion: 1,
            kind: "studio-edit-program",
            revisionHash: command.nextRevision,
          },
        },
      });
    };

    const result = await compileStudioPreviewRuntimeTraceEdit({
      frame: FRAME,
      proposedState,
      rotationCompiler,
      snapshot,
      sourceRevisionHash: "a".repeat(64),
    });
    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") throw new Error(result.issue.message);
    const rotatedRoot = result.scene.entities.find(({ id }) => id === root.id);
    const retainedChild = result.scene.entities.find(({ id }) => id === child.id);
    expect(rotatedRoot?.transform).toEqual(coreTransform);
    expect(retainedChild).toEqual(child);
    expect(result.scene.provenance.at(-1)?.id).toBe(`studio-runtime-trace-construction-rotation:${"a".repeat(64)}`);
    expect(commands).toEqual([
      {
        angleRadians,
        entityId: root.id,
        expectedBaseRevision: sceneIrSourceRevisionHash(snapshot.snapshot.scene),
        nextRevision: "a".repeat(64),
        pivot: { x: 0, y: 0 },
        provenance: {
          evidence: [
            "Studio construction-time planar rotation request projected onto one verified Runtime Trace root",
            `source binding ${candidate.bindingId}`,
            `authorized operation ${operationId}`,
          ],
          id: `studio-runtime-trace-construction-rotation:${"a".repeat(64)}`,
          origin: "studio-edit-program",
        },
        schema: "poietra.rotate-scene-entity",
        version: 1,
      },
    ]);
  });
});
