import { describe, expect, it } from "vitest";

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
    operations: [{
      dependsOn: [],
      effect: "fade-in",
      entityId: "source",
      id: "op",
      interval: { end: 5.4, start: 5 },
      kind: "ChangePresence",
      persistent: true,
      provenance: { evidence: [], origin: "studio-default" },
    }],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: ["op"] },
    transactionId: "insert",
    version: 1,
  };
}

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
    const projected = projectRuntimeSceneToSourceTimeline(
      scene(),
      [insertionProgram(), insertionProgram()],
    );

    expect(projected.duration).toBeCloseTo(12);
    expect(projected.objectGraph.entities.createdLater?.lifetime).toEqual([
      { end: 12, start: 5 },
    ]);
  });
});
