import { STUDIO_STATE_VERSION, type RuntimeSceneState, type StaticSemanticState, type WorkingState } from "./model";

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
      samples: [{ interval: { end: duration, start: 0 }, kind: "exact", provenanceId: "source:arrow-position", value: { x: 320, y: 194.5 } }],
    },
    "equation_1/content": {
      entityId: "equation_1",
      key: "content",
      samples: [{ interval: { end: duration, start: 0 }, kind: "exact", provenanceId: "source:equation-content", value: { displayLines: ["E = mc²"], label: "equation", texParts: ["E", "=", "m", "c^2"] } }],
    },
    "equation_1/position": {
      entityId: "equation_1",
      key: "position",
      samples: [
        { interval: { end: 4, start: 0 }, kind: "exact", provenanceId: "source:equation-position", value: { x: 320, y: 146 } },
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
    "label_1/position": {
      entityId: "label_1",
      key: "position",
      samples: [{ interval: { end: 9.5, start: 0 }, kind: "exact", provenanceId: "source:label-position", value: { x: 320, y: 236 } }],
    },
    "proof_box/position": {
      entityId: "proof_box",
      key: "position",
      samples: [{ interval: { end: 10.5, start: 0 }, kind: "exact", provenanceId: "source:proof-position", value: { x: 320, y: 147 } }],
    },
  },
  provenanceGraph: {
    records: [
      { evidence: ["examples/relativity.py"], id: "source:fixture", origin: "import" },
    ],
  },
  sceneId: "GroupedEquation",
  version: STUDIO_STATE_VERSION,
};

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
