import { describe, expect, it } from "vitest";
import { buildStudioCreationEditCommand, buildStudioCreationProjectionCommand } from "./scene-authoring-wire";
import type { SceneEdit } from "./scene-edit-contract";

function creationProgram(type: string): SceneEdit {
  return {
    anchor: {
      capturedPlayhead: 0,
      evidence: [],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        entity: { id: `entity:${type}`, lifetime: { end: null, start: 0 }, type },
        id: `create:${type}`,
        interval: { end: 0, start: 0 },
        kind: "CreateEntity",
        provenance: { evidence: [], origin: "studio-default" },
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [`create:${type}`] },
    transactionId: `create:${type}`,
    version: 1,
  };
}

describe("Studio creation wire", () => {
  it("normalizes Arrow as a first-class creation kind in apply and projection commands", () => {
    const programs = [creationProgram("Arrow")];
    const apply = buildStudioCreationEditCommand({
      expectedBaseRevision: "a".repeat(64),
      frame: { height: 9, width: 16 },
      mathTexOutlines: [],
      nextRevision: "b".repeat(64),
      programs,
      viewport: { height: 360, width: 640 },
    });
    const projection = buildStudioCreationProjectionCommand({ baseDuration: 1, programs });

    expect(apply.programs[0]?.operations[0]).toMatchObject({ entity: { kind: "arrow" }, kind: "create" });
    expect(projection.programs[0]?.operations[0]).toMatchObject({ entity: { kind: "arrow" }, kind: "create" });
  });

  it("keeps unsupported Text creation on the explicit other fallback", () => {
    const command = buildStudioCreationProjectionCommand({ baseDuration: 1, programs: [creationProgram("Text")] });

    expect(command.programs[0]?.operations[0]).toMatchObject({ entity: { kind: "other" }, kind: "create" });
  });
});
