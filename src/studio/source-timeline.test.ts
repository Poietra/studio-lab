import { describe, expect, it } from "vitest";

import type { StudioTimelineProjectionV1 } from "../engine/scene-authoring";
import type { RuntimeSceneState } from "./model";
import type { CanonicalEditProgram } from "./operations";
import { projectRuntimeSceneToSourceTimeline } from "./source-timeline";

function insertionProgram(): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: 5,
      evidence: [],
      resolvedSeconds: 5,
      source: { kind: "absolute", seconds: 5 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        effect: "fade-in",
        entityId: "source",
        id: "op",
        interval: { end: 5.4, start: 5 },
        kind: "ChangePresence",
        persistent: true,
        provenance: { evidence: [], origin: "studio-default" },
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: ["op"] },
    transactionId: "insert",
    version: 1,
  };
}

function timelineProgram(): CanonicalEditProgram {
  const base = insertionProgram();
  return {
    ...base,
    operations: [
      {
        dependsOn: [],
        eventKind: "wait",
        id: "wait",
        interval: { end: 6, start: 5 },
        kind: "InsertTimelineEvent",
        label: "Wait",
        provenance: { evidence: [], origin: "studio-default" },
        purpose: "scene-duration",
      },
    ],
    schedule: { edges: [], mode: "sequence", order: ["wait"] },
    transactionId: "wait",
  };
}

const timelineProjection: StudioTimelineProjectionV1 = {
  programProjections: [
    {
      operationId: "wait",
      transactionId: "wait",
      workingAnchor: 5,
      workingInterval: { end: 6, start: 5 },
    },
  ],
  projectedDuration: 13,
  transforms: [{ interval: { end: 6, start: 5 }, kind: "insert", operationId: "wait" }],
};

function scene(): RuntimeSceneState {
  return {
    constraintGraph: { constraints: [] },
    duration: 12.8,
    eventTrack: { events: [] },
    objectGraph: {
      entities: {
        createdLater: {
          id: "createdLater",
          lifetime: [{ end: 12.8, start: 5.4 }],
          provisional: false,
          sourceIdentity: { kind: "unknown", reason: "created in Studio" },
          type: "Circle",
        },
      },
      lineage: [],
    },
    propertyChannels: {},
    provenanceGraph: { records: [] },
    sceneId: "scene",
    version: 1,
  };
}

describe("projectRuntimeSceneToSourceTimeline", () => {
  it("makes entities created inside an inserted block addressable at its source anchor", () => {
    const projected = projectRuntimeSceneToSourceTimeline(scene(), [insertionProgram(), insertionProgram()]);

    expect(projected.duration).toBeCloseTo(12);
    expect(projected.objectGraph.entities.createdLater?.lifetime).toEqual([{ end: 12, start: 5 }]);
  });

  it("requires a Rust projection for Scene duration Programs", () => {
    expect(() => projectRuntimeSceneToSourceTimeline(scene(), [timelineProgram()])).toThrow(
      /Rust timeline projection/i,
    );
  });

  it("maps a mixed authoring batch back to source time only from complete Rust transforms", () => {
    const mixedProjection: StudioTimelineProjectionV1 = {
      programProjections: [
        {
          operationId: "op",
          transactionId: "insert",
          workingAnchor: 5,
          workingInterval: { end: 5.4, start: 5 },
        },
        {
          operationId: "wait",
          transactionId: "wait",
          workingAnchor: 5.4,
          workingInterval: { end: 6.4, start: 5.4 },
        },
      ],
      projectedDuration: 13.4,
      transforms: [
        { interval: { end: 5.4, start: 5 }, kind: "insert", operationId: "op" },
        { interval: { end: 6.4, start: 5.4 }, kind: "insert", operationId: "wait" },
      ],
    };
    const workingScene = {
      ...scene(),
      duration: 13.4,
      objectGraph: {
        entities: {
          createdLater: {
            ...scene().objectGraph.entities.createdLater!,
            lifetime: [{ end: 13.4, start: 6.4 }],
          },
        },
        lineage: [],
      },
    };

    const projected = projectRuntimeSceneToSourceTimeline(
      workingScene,
      [insertionProgram(), timelineProgram()],
      mixedProjection,
    );

    expect(projected.duration).toBe(12);
    expect(projected.objectGraph.entities.createdLater?.lifetime).toEqual([{ end: 12, start: 5 }]);
  });

  it("maps timeline Scenes only from Rust-authorized transforms", () => {
    const workingScene = {
      ...scene(),
      duration: 13,
      objectGraph: {
        entities: {
          createdLater: {
            ...scene().objectGraph.entities.createdLater!,
            lifetime: [{ end: 13, start: 6 }],
          },
        },
        lineage: [],
      },
    };

    const projected = projectRuntimeSceneToSourceTimeline(workingScene, [timelineProgram()], timelineProjection);

    expect(projected.duration).toBe(12);
    expect(projected.objectGraph.entities.createdLater?.lifetime).toEqual([{ end: 12, start: 5 }]);
  });
});
