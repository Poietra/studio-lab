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
        entity: {
          ...(type === "Text"
            ? {
                content: {
                  displayLines: ["日本語で動画を作る", "こんにちは"],
                  text: "日本語で動画を作る\r\nこんにちは",
                },
              }
            : {}),
          id: `entity:${type}`,
          lifetime: { end: null, start: 0 },
          type,
        },
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

function followupProgram(transactionId: string, operation: SceneEdit["operations"][number]): SceneEdit {
  return {
    anchor: {
      capturedPlayhead: 0,
      evidence: [],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId,
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

  it("normalizes bounded Japanese multiline Text to LF as a first-class creation kind", () => {
    const command = buildStudioCreationProjectionCommand({ baseDuration: 1, programs: [creationProgram("Text")] });

    expect(command.programs[0]?.operations[0]).toMatchObject({
      entity: { kind: "text", text: "日本語で動画を作る\nこんにちは", texParts: null },
      kind: "create",
    });
  });

  it("normalizes created-object opacity and relative rotation without interpreting them in TypeScript", () => {
    const entityId = "entity:Arrow";
    const common = {
      dependsOn: [] as string[],
      interval: { end: 0, start: 0 },
      provenance: { evidence: [] as string[], origin: "direct-manipulation" as const },
    };
    const programs = [
      creationProgram("Arrow"),
      followupProgram("opacity:Arrow", {
        ...common,
        entityId,
        id: "opacity:Arrow",
        key: "appearance",
        kind: "SetProperty",
        value: 0.4,
      }),
      followupProgram("rotation:Arrow", {
        ...common,
        easing: "smooth",
        entityId,
        from: 0,
        id: "rotation:Arrow",
        key: "rotation",
        kind: "AnimateProperty",
        relativeDelta: Math.PI / 6,
        to: Math.PI / 6,
      }),
    ];

    const command = buildStudioCreationProjectionCommand({ baseDuration: 1, programs });

    expect(command.programs[1]?.operations[0]).toMatchObject({ alpha: 0.4, entityId, kind: "opacity" });
    expect(command.programs[2]?.operations[0]).toMatchObject({
      controlPresent: false,
      entityId,
      from: 0,
      kind: "rotation",
      relativeDelta: Math.PI / 6,
      to: Math.PI / 6,
    });
  });

  it("normalizes created-shape colors without accepting non-canonical values", () => {
    const entityId = "entity:Circle";
    const common = {
      dependsOn: [] as string[],
      entityId,
      interval: { end: 0, start: 0 },
      kind: "SetProperty" as const,
      provenance: { evidence: [] as string[], origin: "direct-manipulation" as const },
    };
    const programs = [
      creationProgram("Circle"),
      followupProgram("fill:Circle", {
        ...common,
        id: "fill:Circle",
        key: "fillColor",
        value: "#12abef",
      }),
      followupProgram("stroke:Circle", {
        ...common,
        id: "stroke:Circle",
        key: "strokeColor",
        value: "#FEDCBA",
      }),
    ];

    const command = buildStudioCreationProjectionCommand({ baseDuration: 1, programs });

    expect(command.programs[1]?.operations[0]).toMatchObject({
      color: "#12abef",
      entityId,
      kind: "fill-color",
    });
    expect(command.programs[2]?.operations[0]).toMatchObject({ color: null, entityId, kind: "stroke-color" });
  });
});
