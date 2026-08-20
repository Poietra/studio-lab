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
          ...(type === "ImageMobject"
            ? {
                image: {
                  asset: { assetId: "image-scene/asset:image.png", sha256: "4".repeat(64) },
                  localRect: { bottom: -0.5, left: -1, right: 1, top: 0.5 },
                  sampler: "nearest" as const,
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
    const applyOperation = apply.programs[0]?.operations[0];
    const projectionOperation = projection.programs[0]?.operations[0];
    expect(applyOperation?.kind === "create" ? applyOperation.entity : null).not.toHaveProperty("image");
    expect(projectionOperation?.kind === "create" ? projectionOperation.entity : null).not.toHaveProperty("image");
  });

  it("normalizes GroupEntities for the Rust creation authority", () => {
    const operation = {
      childEntityIds: ["entity:Circle", "entity:Square"],
      dependsOn: [],
      groupId: "group:shapes",
      id: "group:shapes",
      interval: { end: 0, start: 0 },
      kind: "GroupEntities" as const,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
    };

    const command = buildStudioCreationProjectionCommand({
      baseDuration: 1,
      programs: [followupProgram("group:shapes", operation)],
    });

    expect(command.programs[0]?.operations[0]).toMatchObject({
      childEntityIds: ["entity:Circle", "entity:Square"],
      groupId: "group:shapes",
      kind: "group",
    });
  });

  it("normalizes UngroupEntity for the Rust creation authority", () => {
    const operation = {
      dependsOn: [],
      groupId: "group:shapes",
      id: "ungroup:shapes",
      interval: { end: 0, start: 0 },
      kind: "UngroupEntity" as const,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
    };

    const command = buildStudioCreationProjectionCommand({
      baseDuration: 1,
      programs: [followupProgram("ungroup:shapes", operation)],
    });

    expect(command.programs[0]?.operations[0]).toMatchObject({ groupId: "group:shapes", kind: "ungroup" });
  });

  it("preserves an Image asset reference and placement in apply and projection commands", () => {
    const programs = [creationProgram("ImageMobject")];
    const apply = buildStudioCreationEditCommand({
      expectedBaseRevision: "a".repeat(64),
      frame: { height: 9, width: 16 },
      mathTexOutlines: [],
      nextRevision: "b".repeat(64),
      programs,
      viewport: { height: 360, width: 640 },
    });
    const projection = buildStudioCreationProjectionCommand({ baseDuration: 1, programs });
    const expected = {
      asset: { assetId: "image-scene/asset:image.png", sha256: "4".repeat(64) },
      localRect: { bottom: -0.5, left: -1, right: 1, top: 0.5 },
      sampler: "nearest",
    };

    expect(apply.programs[0]?.operations[0]).toMatchObject({
      entity: { image: expected, kind: "image" },
      kind: "create",
    });
    expect(projection.programs[0]?.operations[0]).toMatchObject({
      entity: { image: expected, kind: "image" },
      kind: "create",
    });
    const applyOperation = apply.programs[0]?.operations[0];
    const projectionOperation = projection.programs[0]?.operations[0];
    expect(applyOperation?.kind === "create" ? applyOperation.entity : null).toHaveProperty("image", expected);
    expect(projectionOperation?.kind === "create" ? projectionOperation.entity : null).toHaveProperty(
      "image",
      expected,
    );
  });

  it("normalizes bounded Japanese multiline Text to LF as a first-class creation kind", () => {
    const command = buildStudioCreationProjectionCommand({ baseDuration: 1, programs: [creationProgram("Text")] });

    expect(command.programs[0]?.operations[0]).toMatchObject({
      entity: {
        kind: "text",
        layout: { alignment: "left", fontFamily: "sans", fontSize: 1, fontWeight: "regular", lineHeight: 1.2 },
        text: "日本語で動画を作る\nこんにちは",
        texParts: null,
      },
      kind: "create",
    });
  });

  it("does not lower a later Text content replacement as static Scene geometry", () => {
    const operation = {
      dependsOn: [],
      entityId: "entity:Text",
      id: "replace-text-later",
      interval: { end: 1, start: 1 },
      key: "content" as const,
      kind: "SetProperty" as const,
      provenance: { evidence: [], origin: "studio-default" as const },
      value: {
        displayLines: ["After"],
        text: "After",
        textLayout: {
          alignment: "right" as const,
          fontFamily: "mono" as const,
          fontSize: 1.5,
          fontWeight: "bold" as const,
          lineHeight: 1.8,
        },
      },
    };
    const followup = {
      ...followupProgram("replace-text-later", operation),
      anchor: {
        capturedPlayhead: 1,
        evidence: [],
        resolvedSeconds: 1,
        source: { kind: "absolute" as const, seconds: 1 },
      },
      provenance: { evidence: [], origin: "studio-default" as const },
    };

    const command = buildStudioCreationProjectionCommand({
      baseDuration: 2,
      programs: [creationProgram("Text"), followup],
    });

    expect(command.programs[1]?.operations[0]).toMatchObject({ kind: "unsupported" });
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
      followupProgram("ordering:Arrow", {
        ...common,
        entityId,
        id: "ordering:Arrow",
        key: "sourceZIndex",
        kind: "SetProperty",
        value: 4.5,
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
    expect(command.programs[2]?.operations[0]).toMatchObject({ entityId, kind: "source-z-index", sourceZIndex: 4.5 });
    expect(command.programs[3]?.operations[0]).toMatchObject({
      controlPresent: false,
      entityId,
      from: 0,
      kind: "rotation",
      relativeDelta: Math.PI / 6,
      to: Math.PI / 6,
    });
  });

  it("forwards named material f32 keyframes with their complete material identity", () => {
    const material = { parameters: [0.35, 8], revision: 3, shaderId: "project-wave" } as const;
    const operation = {
      dependsOn: [],
      easing: "ease-in" as const,
      entityId: "entity:Arrow",
      from: 0.35,
      id: "material:Arrow",
      interval: { end: 2, start: 1 },
      key: "appearance" as const,
      kind: "AnimateProperty" as const,
      materialParameter: { material, name: "Speed", parameterIndex: 0 },
      provenance: { evidence: [], origin: "direct-manipulation" as const },
      to: 0.8,
    };

    const command = buildStudioCreationProjectionCommand({
      baseDuration: 3,
      programs: [creationProgram("Arrow"), followupProgram("material:Arrow", operation)],
    });

    expect(command.programs[1]?.operations[0]).toMatchObject({
      easing: "ease-in",
      entityId: "entity:Arrow",
      from: 0.35,
      kind: "material-parameter-keyframes",
      material,
      name: "Speed",
      parameterIndex: 0,
      to: 0.8,
    });
  });

  it("distinguishes a Timeline scale track from an immediate relative scale", () => {
    const operation = {
      dependsOn: [],
      easing: "ease-in-out" as const,
      entityId: "entity:Arrow",
      from: 1,
      id: "scale-track:Arrow",
      interval: { end: 2, start: 1 },
      key: "scale" as const,
      kind: "AnimateProperty" as const,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
      timelineTrack: true as const,
      to: 1.5,
    };

    const command = buildStudioCreationProjectionCommand({
      baseDuration: 3,
      programs: [creationProgram("Arrow"), followupProgram("scale-track:Arrow", operation)],
    });

    expect(command.programs[1]?.operations[0]).toMatchObject({
      easing: "ease-in-out",
      entityId: "entity:Arrow",
      from: 1,
      kind: "uniform-scale-keyframes",
      to: 1.5,
    });
  });

  it("distinguishes a Timeline rotation track from an immediate relative rotation", () => {
    const operation = {
      dependsOn: [],
      easing: "ease-out" as const,
      entityId: "entity:Arrow",
      from: 0,
      id: "rotation-track:Arrow",
      interval: { end: 2, start: 1 },
      key: "rotation" as const,
      kind: "AnimateProperty" as const,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
      timelineTrack: true as const,
      to: Math.PI,
    };

    const command = buildStudioCreationProjectionCommand({
      baseDuration: 3,
      programs: [creationProgram("Arrow"), followupProgram("rotation-track:Arrow", operation)],
    });

    expect(command.programs[1]?.operations[0]).toMatchObject({
      easing: "ease-out",
      entityId: "entity:Arrow",
      from: 0,
      kind: "rotation-keyframes",
      to: Math.PI,
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
