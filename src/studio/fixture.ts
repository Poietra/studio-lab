import type { StudioPersistentRemoveProjectionV1 } from "../engine/scene-authoring";
import {
  type ProposedState,
  type RuntimeSceneState,
  STUDIO_STATE_VERSION,
  type StaticSemanticState,
  type WorkingState,
} from "./model";
import type { SceneEdit } from "./scene-edit-contract";
import { canonicalizeSuggestionProgram } from "./suggestion-program";
import { projectStudioWorkspace } from "./workspace-projection";

const duration = 12;

export function persistentRemoveProjectionFixture(
  program: SceneEdit,
  timeOffset = 0,
): StudioPersistentRemoveProjectionV1 {
  return {
    removals: program.operations.flatMap((operation) =>
      operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent
        ? [
            {
              affectedSceneEntityIds: [operation.entityId],
              fadeInterval:
                operation.interval.start < operation.interval.end
                  ? {
                      end: operation.interval.end + timeOffset,
                      start: operation.interval.start + timeOffset,
                    }
                  : null,
              operationId: operation.id,
              removedAt: operation.interval.end + timeOffset,
              resultingLifetimeEnd: operation.interval.end + timeOffset,
              sceneEntityId: operation.entityId,
              studioEntityId: operation.entityId,
              transactionId: program.transactionId,
            },
          ]
        : [],
    ),
  };
}

export function projectPersistentRemoveFixture(program: SceneEdit, scene = STUDIO_FIXTURE_SCENE, draft = false) {
  const record = { program, validation: { issues: [], status: "valid" as const } };
  return projectStudioWorkspace({
    activeScene: {
      anchors: [0, 5, 7],
      name: "GroupedEquation",
      nextSceneId: null,
      runtimeSceneState: scene,
      sceneId: scene.sceneId,
      sourceHash: "fixture-grouped-equation-v1",
      sourcePath: "examples/relativity.py",
      sourceVariables: {},
      staticSemanticState: STUDIO_FIXTURE_STATIC_STATE,
    },
    appliedEdits: draft ? [] : [record],
    currentTime: 0,
    draftEdit: draft ? record : null,
    nextScene: null,
    persistentRemoveProjection: persistentRemoveProjectionFixture(program),
    editAuthority: "rust-authorized-batch",
    selectedObjectIds: [],
  }).proposedState;
}

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
  overrides: Partial<Pick<WorkingState, "appliedEdits" | "editorContext" | "stagedEdits">> = {},
): WorkingState {
  return {
    appliedEdits: overrides.appliedEdits ?? [],
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
    stagedEdits: overrides.stagedEdits ?? [],
    staticSemanticState: STUDIO_FIXTURE_STATIC_STATE,
    version: STUDIO_STATE_VERSION,
  };
}

/** Wraps an already-materialized fixture scene without evaluating its Programs. */
export function createFixtureProposedState(workingState = createFixtureWorkingState()): ProposedState {
  if (workingState.appliedEdits.length > 0 || workingState.stagedEdits.length > 0) {
    throw new TypeError("The base ProposedState fixture cannot evaluate Programs.");
  }
  return {
    base: workingState,
    evaluatedScene: workingState.runtimeSceneState,
    issues: [],
    programs: [],
    version: STUDIO_STATE_VERSION,
  };
}
