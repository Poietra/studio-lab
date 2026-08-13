import { type RuntimeSceneState, STUDIO_STATE_VERSION, type StaticSemanticState, type WorkingState } from "./model";
import { type CanonicalEditOperation, EDIT_OPERATION_VERSION, operationId } from "./operations";
import { validateAndScheduleProgram } from "./program-validation";
import { canonicalizeSuggestionProgram } from "./suggestion-program";
import { resolveTimeAnchorOnce } from "./time";

const duration = 12;

export const STUDIO_FIXTURE_SCENE: RuntimeSceneState = {
  constraintGraph: {
    constraints: [
      {
        id: "constraint:label-next-to-equation",
        mode: "snapshot",
        operationId: "source:label-placement",
        relation: "next-to",
        sourceEntityId: "label_1",
        targetEntityId: "equation_1",
      },
    ],
  },
  duration,
  eventTrack: {
    events: [
      { id: "play:introduce", interval: { end: 2, start: 0 }, kind: "play", label: "Introduce" },
      { id: "play:explain", interval: { end: 4, start: 2 }, kind: "play", label: "Explain" },
      { id: "play:move-equation", interval: { end: 7, start: 4 }, kind: "play", label: "Move equation" },
      { id: "play:outro", interval: { end: 12, start: 7 }, kind: "play", label: "Outro" },
    ],
  },
  objectGraph: {
    entities: {
      arrow_1: {
        id: "arrow_1",
        lifetime: [{ end: 9.5, start: 0 }],
        provisional: false,
        sourceIdentity: { kind: "known", value: "arrow" },
        type: "Arrow",
      },
      equation_1: {
        content: { displayLines: ["E = mc²"], label: "equation", texParts: ["E", "=", "m", "c^2"] },
        id: "equation_1",
        lifetime: [{ end: duration, start: 0 }],
        provisional: false,
        sourceIdentity: { kind: "known", value: "equation" },
        type: "MathTex",
      },
      label_1: {
        content: { displayLines: ["energy"], text: "energy" },
        id: "label_1",
        lifetime: [{ end: 9.5, start: 0 }],
        provisional: false,
        sourceIdentity: { kind: "known", value: "label" },
        type: "Text",
      },
      proof_box: {
        id: "proof_box",
        lifetime: [{ end: 10.5, start: 0 }],
        provisional: false,
        sourceIdentity: { kind: "known", value: "proof_box" },
        type: "Rectangle",
      },
    },
    lineage: [],
  },
  propertyChannels: {
    "arrow_1/position": {
      entityId: "arrow_1",
      key: "position",
      samples: [
        {
          interval: { end: duration, start: 0 },
          kind: "exact",
          provenanceId: "source:arrow-position",
          value: { x: 320, y: 194.5 },
        },
      ],
    },
    "equation_1/content": {
      entityId: "equation_1",
      key: "content",
      samples: [
        {
          interval: { end: duration, start: 0 },
          kind: "exact",
          provenanceId: "source:equation-content",
          value: { displayLines: ["E = mc²"], label: "equation", texParts: ["E", "=", "m", "c^2"] },
        },
      ],
    },
    "equation_1/position": {
      entityId: "equation_1",
      key: "position",
      samples: [
        {
          interval: { end: 4, start: 0 },
          kind: "exact",
          provenanceId: "source:equation-position",
          value: { x: 320, y: 146 },
        },
        {
          control: { x: 352, y: 126 },
          easing: "smooth",
          from: { x: 320, y: 146 },
          interval: { end: 7, start: 4 },
          kind: "animated",
          provenanceId: "source:move-equation",
          relative: true,
          value: { x: 384, y: 146 },
        },
      ],
    },
    "equation_1/scale": {
      entityId: "equation_1",
      key: "scale",
      samples: [
        { interval: { end: duration, start: 0 }, kind: "exact", provenanceId: "source:equation-scale", value: 1 },
      ],
    },
    "label_1/position": {
      entityId: "label_1",
      key: "position",
      samples: [
        {
          interval: { end: 9.5, start: 0 },
          kind: "exact",
          provenanceId: "source:label-position",
          value: { x: 320, y: 236 },
        },
      ],
    },
    "proof_box/position": {
      entityId: "proof_box",
      key: "position",
      samples: [
        {
          interval: { end: 10.5, start: 0 },
          kind: "exact",
          provenanceId: "source:proof-position",
          value: { x: 320, y: 147 },
        },
      ],
    },
  },
  provenanceGraph: {
    records: [{ evidence: ["examples/relativity.py"], id: "source:fixture", origin: "import" }],
  },
  sceneId: "GroupedEquation",
  version: STUDIO_STATE_VERSION,
};

export function validateMotionProgramFixture(
  input: Readonly<{
    capturedPlayhead: number;
    controlOffset: Readonly<{ x: number; y: number }>;
    delta: Readonly<{ x: number; y: number }>;
    interval: Readonly<{ end: number; start: number }>;
    scene: RuntimeSceneState;
    targetEntityIds: readonly string[];
    transactionId: string;
  }>,
) {
  return canonicalizeSuggestionProgram(
    {
      anchor: { kind: "playhead", referenceSeconds: input.capturedPlayhead },
      controlOffset: input.controlOffset,
      delta: input.delta,
      easing: "smooth",
      end: input.interval.end,
      kind: "create-motion",
      start: input.interval.start,
      targetObjectIds: input.targetEntityIds,
    },
    {
      capturedPlayhead: input.capturedPlayhead,
      origin: "direct-manipulation",
      scene: input.scene,
      transactionId: input.transactionId,
    },
  );
}

export function validateModifyMotionProgramFixture(transactionId: string) {
  const interval = { end: 7, start: 4 };
  const resolution = resolveTimeAnchorOnce(
    { kind: "absolute", seconds: interval.start },
    {
      capturedPlayhead: 5,
      sceneDuration: STUDIO_FIXTURE_SCENE.duration,
    },
  );
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operation: CanonicalEditOperation = {
    controlOffset: { x: 0, y: -32 },
    dependsOn: [],
    id: operationId(transactionId, "modify-motion"),
    interval,
    kind: "ModifyMotion",
    motionId: "move-equation",
    preserve: ["start", "end", "duration"],
    provenance: {
      evidence: ["path bend gesture", "endpoints preserved"],
      origin: "direct-manipulation",
    },
  };
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "illustrative",
      operations: [operation],
      provenance: { evidence: ["gesture constraint"], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    STUDIO_FIXTURE_SCENE,
  );
}

export const STUDIO_FIXTURE_STATIC_STATE: StaticSemanticState = {
  entities: Object.values(STUDIO_FIXTURE_SCENE.objectGraph.entities).map((entity) => ({
    sourceIdentity: entity.sourceIdentity.kind === "known" ? entity.sourceIdentity.value : entity.id,
    runtimeIdentities: { kind: "known", value: [entity.id] },
    type: { kind: "known", value: entity.type },
  })),
  unknowns: [],
  version: STUDIO_STATE_VERSION,
};

export function createFixtureWorkingState(
  overrides: Partial<Pick<WorkingState, "appliedPrograms" | "editorContext" | "stagedPrograms">> = {},
): WorkingState {
  return {
    appliedPrograms: overrides.appliedPrograms ?? [],
    editorContext: overrides.editorContext ?? {
      activeSceneId: STUDIO_FIXTURE_SCENE.sceneId,
      playhead: 5,
      selection: ["equation_1"],
      version: STUDIO_STATE_VERSION,
      viewport: { height: 360, width: 640 },
    },
    runtimeSceneState: STUDIO_FIXTURE_SCENE,
    sourceSnapshot: {
      configId: "studio-lab",
      hash: "sha256:fixture-grouped-equation-v1",
      sourceId: "examples/relativity.py",
      version: STUDIO_STATE_VERSION,
    },
    stagedPrograms: overrides.stagedPrograms ?? [],
    staticSemanticState: STUDIO_FIXTURE_STATIC_STATE,
    version: STUDIO_STATE_VERSION,
  };
}
