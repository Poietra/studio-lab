import { describe, expect, it } from "vitest";
import { createStudioSceneBackgroundProgram } from "./authoring-commands";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import {
  buildStudioCreationEditCommand,
  buildStudioCreationProjectionCommand,
  isExactStudioMotionProgramBatch,
  studioMotionProjectionBatchKind,
} from "./scene-authoring-wire";
import { type SceneEdit, sceneEditOperationSchema } from "./scene-edit-contract";

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
          ...(type === "Triangle"
            ? { dimensions: { radius: 1, sides: 3 } }
            : type === "RegularPolygon"
              ? { dimensions: { radius: 1, sides: 6 } }
              : type === "Ellipse"
                ? { dimensions: { height: 2, width: 3 } }
                : type === "Arc" || type === "Sector"
                  ? { dimensions: { angles: { start: 0, sweep: Math.PI / 2 }, radius: 1 } }
                  : type === "CubicBezier"
                    ? { dimensions: { height: 2, width: 4 } }
                    : type === "NumberLine"
                      ? {
                          dimensions: {
                            coordinateSystem: { x: { maximum: 5, minimum: -5, step: 1 } },
                            width: 6,
                          },
                        }
                      : type === "Axes" || type === "DataPlot" || type === "NumberPlane"
                        ? {
                            dimensions: {
                              coordinateSystem: {
                                x: { maximum: 5, minimum: -5, step: 1 },
                                y: { maximum: 3, minimum: -3, step: 1 },
                              },
                              height: 4,
                              width: 6,
                            },
                          }
                        : {}),
          ...(type === "DataPlot"
            ? {
                dataSeries: {
                  interpolation: "smooth" as const,
                  points: [
                    { x: -2, y: -1 },
                    { x: 0, y: 2 },
                    { x: 2, y: 0 },
                  ],
                },
              }
            : {}),
          ...(type === "CubicBezier"
            ? {
                cubicBezier: {
                  arrowEnd: true,
                  control1: { x: -1, y: 1 },
                  control2: { x: 1, y: -1 },
                  end: { x: 2, y: 0 },
                  start: { x: -2, y: 0 },
                  strokeCap: "round" as const,
                  strokeWidth: 0.04,
                },
              }
            : {}),
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
          ...(type === "SvgPath"
            ? {
                dimensions: { height: 2, width: 3 },
                svg: {
                  source: '<svg viewBox="0 0 3 2"><path d="M0 0 L3 0 L3 2 Z" fill="#38bdf8"/></svg>',
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
  it("normalizes one opaque Scene background without an entity target", () => {
    const program = createStudioSceneBackgroundProgram({
      color: "#123456",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "scene-background",
    }).program;
    const command = buildStudioCreationProjectionCommand({ baseDuration: 2, programs: [program] });
    expect(command.programs[0]?.operations).toEqual([
      expect.objectContaining({ color: "#123456", kind: "scene-background" }),
    ]);
    expect(command.programs[0]?.operations[0]).not.toHaveProperty("entityId");
    expect(command.programs[0]?.loweringSupported).toBe(false);
  });

  it("normalizes Triangle and Regular Polygon to the one Rust regular-polygon kind", () => {
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 2,
      programs: [creationProgram("Triangle"), creationProgram("RegularPolygon")],
    });

    expect(command.programs.map((program) => program.operations[0])).toEqual([
      expect.objectContaining({
        entity: expect.objectContaining({ dimensions: { radius: 1, sides: 3 }, kind: "regular-polygon" }),
        kind: "create",
      }),
      expect.objectContaining({
        entity: expect.objectContaining({ dimensions: { radius: 1, sides: 6 }, kind: "regular-polygon" }),
        kind: "create",
      }),
    ]);
  });

  it("normalizes Triangle Shape Transform endpoints while preserving the other closed primitive kinds", () => {
    const transform = followupProgram("shape-transform:Triangle", {
      dependsOn: [],
      easing: "smooth",
      entityId: "entity:Triangle",
      from: { dimensions: { radius: 1, sides: 3 }, shape: "triangle" },
      id: "shape-transform:Triangle/operation",
      interval: { end: 2, start: 1 },
      kind: "TransformShape",
      provenance: { evidence: [], origin: "direct-manipulation" },
      to: { dimensions: { height: 2, width: 3 }, shape: "ellipse" },
    });
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 3,
      programs: [creationProgram("Triangle"), transform],
    });

    expect(command.programs[1]?.operations[0]).toMatchObject({
      fromDimensions: { radius: 1, sides: 3 },
      fromShape: "regular-polygon",
      kind: "shape-transform",
      toDimensions: { height: 2, width: 3 },
      toShape: "ellipse",
    });
  });

  it("normalizes one Pen Path Morph without moving path evaluation into TypeScript", () => {
    const fromPath = {
      closed: false,
      segments: [
        {
          control1: { x: -1, y: 1 },
          control2: { x: 1, y: -1 },
          end: { x: 2, y: 0 },
        },
      ],
      start: { x: -2, y: 0 },
    } as const;
    const transform = followupProgram("path-morph:CubicBezier", {
      dependsOn: [],
      easing: "smooth",
      entityId: "entity:CubicBezier",
      from: fromPath,
      id: "path-morph:CubicBezier/operation",
      interval: { end: 2, start: 1 },
      kind: "TransformPath",
      provenance: { evidence: [], origin: "direct-manipulation" },
      to: {
        ...fromPath,
        segments: [
          {
            control1: { x: -1, y: 2 },
            control2: { x: 1, y: -2 },
            end: { x: 2, y: 1 },
          },
        ],
      },
    });
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 3,
      programs: [creationProgram("CubicBezier"), transform],
    });

    expect(command.programs[1]?.operations[0]).toMatchObject({
      easing: "smooth",
      entityId: "entity:CubicBezier",
      fromPath,
      kind: "path-morph",
      toPath: transform.operations[0]?.kind === "TransformPath" ? transform.operations[0].to : undefined,
    });
  });

  it("maps native curve primitives to their Rust creation kinds", () => {
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 2,
      programs: [creationProgram("Ellipse"), creationProgram("Arc"), creationProgram("Sector")],
    });

    expect(
      command.programs.map((program) => {
        const operation = program.operations[0];
        if (operation?.kind !== "create") throw new Error("Curve wire fixture is incomplete.");
        return operation.entity.kind;
      }),
    ).toEqual(["ellipse", "arc", "sector"]);
  });

  it("passes a bounded cubic path to the Rust creation kind", () => {
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 2,
      programs: [creationProgram("CubicBezier")],
    });

    expect(command.programs[0]?.operations[0]).toEqual(
      expect.objectContaining({
        entity: expect.objectContaining({
          cubicBezier: expect.objectContaining({
            arrowEnd: true,
            control1: { x: -1, y: 1 },
            control2: { x: 1, y: -1 },
            end: { x: 2, y: 0 },
            start: { x: -2, y: 0 },
          }),
          dimensions: { height: 2, width: 4 },
          kind: "cubic-bezier",
        }),
        kind: "create",
      }),
    );
  });

  it("preserves ordered continuation segments and closed fill in the Rust creation command", () => {
    const program = creationProgram("CubicBezier");
    const operation = program.operations[0];
    if (operation?.kind !== "CreateEntity" || !operation.entity.cubicBezier) {
      throw new Error("Cubic Bézier wire fixture is incomplete.");
    }
    const continuationSegments = [
      {
        control1: { x: 2.5, y: 1 },
        control2: { x: 3.5, y: 1 },
        end: { x: 4, y: 0 },
      },
    ];
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 2,
      programs: [
        {
          ...program,
          operations: [
            {
              ...operation,
              entity: {
                ...operation.entity,
                cubicBezier: {
                  ...operation.entity.cubicBezier,
                  arrowEnd: false,
                  closed: true,
                  continuationSegments,
                  fillColor: "#38bdf8",
                },
              },
            },
          ],
        },
      ],
    });

    const projected = command.programs[0]?.operations[0];
    if (projected?.kind !== "create") throw new Error("Cubic Bézier wire projection is incomplete.");
    expect(projected.entity.cubicBezier).toMatchObject({
      arrowEnd: false,
      closed: true,
      continuationSegments,
      fillColor: "#38bdf8",
    });
  });

  it("maps coordinate objects to their Rust creation kinds", () => {
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 2,
      programs: [creationProgram("NumberLine"), creationProgram("Axes"), creationProgram("NumberPlane")],
    });

    expect(
      command.programs.map((program) => {
        const operation = program.operations[0];
        if (operation?.kind !== "create") throw new Error("Coordinate wire fixture is incomplete.");
        return operation.entity.kind;
      }),
    ).toEqual(["number-line", "axes", "number-plane"]);
  });

  it("passes bounded SVG source to the Rust svg-path creation kind without parsing geometry", () => {
    const command = buildStudioCreationProjectionCommand({ baseDuration: 2, programs: [creationProgram("SvgPath")] });

    expect(command.programs[0]?.operations[0]).toEqual(
      expect.objectContaining({
        entity: expect.objectContaining({
          dimensions: { height: 2, width: 3 },
          kind: "svg-path",
          svg: expect.objectContaining({ source: expect.stringContaining("<path") }),
        }),
        kind: "create",
      }),
    );
  });

  it("carries DataPlot samples into the canonical Rust creation command", () => {
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 2,
      programs: [creationProgram("DataPlot")],
    });
    const operation = command.programs[0]?.operations[0];

    expect(operation).toMatchObject({
      entity: {
        dataSeries: {
          interpolation: "smooth",
          points: [
            { x: -2, y: -1 },
            { x: 0, y: 2 },
            { x: 2, y: 0 },
          ],
        },
        kind: "data-plot",
      },
      kind: "create",
    });
  });

  it("normalizes DrawIn as the fixed zero-to-one path-trim operation", () => {
    const create = creationProgram("Line");
    const drawIn = {
      dependsOn: ["create:Line"],
      easing: "linear" as const,
      entityId: "entity:Line",
      id: "draw-in:Line",
      interval: { end: 1, start: 0 },
      kind: "DrawIn" as const,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
    };
    const program: SceneEdit = {
      ...create,
      intentCount: 2,
      loweringStatus: "unsupported",
      operations: [...create.operations, drawIn],
      requestedExecution: "sequence",
      schedule: {
        edges: [{ from: "create:Line", reason: "identity", to: "draw-in:Line" }],
        mode: "sequence",
        order: ["create:Line", "draw-in:Line"],
      },
    };

    const command = buildStudioCreationProjectionCommand({ baseDuration: 2, programs: [program] });

    expect(command.programs[0]?.operations[1]).toEqual({
      dependsOn: ["create:Line"],
      easing: "linear",
      entityId: "entity:Line",
      from: 0,
      id: "draw-in:Line",
      interval: { end: 1, start: 0 },
      kind: "draw-in",
      origin: "direct-manipulation",
      to: 1,
    });
  });

  it("normalizes WriteIn as one fixed Write progress operation", () => {
    const create = creationProgram("MathTex");
    const writeIn = {
      dependsOn: ["create:MathTex"],
      easing: "linear" as const,
      entityId: "entity:MathTex",
      id: "write-in:MathTex",
      interval: { end: 1, start: 0 },
      kind: "WriteIn" as const,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
    };
    const program: SceneEdit = {
      ...create,
      intentCount: 2,
      loweringStatus: "unsupported",
      operations: [...create.operations, writeIn],
      requestedExecution: "sequence",
      schedule: {
        edges: [{ from: "create:MathTex", reason: "identity", to: "write-in:MathTex" }],
        mode: "sequence",
        order: ["create:MathTex", "write-in:MathTex"],
      },
    };

    const command = buildStudioCreationProjectionCommand({ baseDuration: 2, programs: [program] });

    expect(command.programs[0]?.operations[1]).toEqual({
      dependsOn: ["create:MathTex"],
      easing: "linear",
      entityId: "entity:MathTex",
      id: "write-in:MathTex",
      interval: { end: 1, start: 0 },
      kind: "write-in",
      origin: "direct-manipulation",
    });
  });

  it("normalizes Studio-created A-to-B-to-A MathTex transforms with smooth as the compatible default", () => {
    const rootEntityId = "entity:MathTex";
    const first = followupProgram("transform:MathTex:b", {
      dependsOn: [],
      id: "transform:MathTex:b/operation",
      interval: { end: 2, start: 1 },
      kind: "TransformContent",
      provenance: { evidence: [], origin: "direct-manipulation" },
      replacement: { displayLines: ["B"], texParts: ["B"] },
      sourceEntityId: rootEntityId,
      strategy: "replacement-transform",
      targetEntityId: "transform:MathTex:b/target",
      targetType: "MathTex",
    });
    const second = followupProgram("transform:MathTex:a", {
      dependsOn: [],
      easing: "linear",
      id: "transform:MathTex:a/operation",
      interval: { end: 3, start: 2 },
      kind: "TransformContent",
      provenance: { evidence: [], origin: "direct-manipulation" },
      replacement: { displayLines: ["A"], texParts: ["A"] },
      sourceEntityId: "transform:MathTex:b/target",
      strategy: "replacement-transform",
      targetEntityId: "transform:MathTex:a/target",
      targetType: "MathTex",
    });

    const command = buildStudioCreationProjectionCommand({
      baseDuration: 4,
      programs: [creationProgram("MathTex"), first, second],
    });

    expect(command.programs.slice(1).map((program) => program.operations[0])).toEqual([
      {
        dependsOn: [],
        easing: "smooth",
        entityId: rootEntityId,
        id: "transform:MathTex:b/operation",
        interval: { end: 2, start: 1 },
        kind: "transform-content",
        origin: "direct-manipulation",
        replacement: { displayLines: ["B"], texParts: ["B"] },
        sourceEntityId: rootEntityId,
        strategy: "replacement-transform",
        targetEntityId: "transform:MathTex:b/target",
        targetType: "MathTex",
      },
      {
        dependsOn: [],
        easing: "linear",
        entityId: rootEntityId,
        id: "transform:MathTex:a/operation",
        interval: { end: 3, start: 2 },
        kind: "transform-content",
        origin: "direct-manipulation",
        replacement: { displayLines: ["A"], texParts: ["A"] },
        sourceEntityId: "transform:MathTex:b/target",
        strategy: "replacement-transform",
        targetEntityId: "transform:MathTex:a/target",
        targetType: "MathTex",
      },
    ]);
  });

  it("forwards motion spin only through the Studio creation authority", () => {
    const entityId = "entity:Rectangle";
    const motion = followupProgram("spin:Rectangle", {
      controlOffset: { x: 20, y: -10 },
      delta: { x: 80, y: 40 },
      dependsOn: [],
      easing: "smooth",
      id: "spin:Rectangle",
      interval: { end: 2, start: 0 },
      kind: "CreateMotion",
      provenance: { evidence: [], origin: "direct-manipulation" },
      rotationDeltaRadians: 2 * Math.PI,
      targetEntityIds: [entityId],
    });

    const command = buildStudioCreationProjectionCommand({
      baseDuration: 4,
      programs: [creationProgram("Rectangle"), motion],
    });
    expect(command.programs[1]?.operations[0]).toMatchObject({
      kind: "create-motion",
      rotationDeltaRadians: 2 * Math.PI,
      targetEntityIds: [entityId],
    });
    expect(isExactStudioMotionProgramBatch([motion])).toBe(false);
    expect(studioMotionProjectionBatchKind([motion])).toBeNull();
  });

  it("forwards path orientation only through the Studio creation authority", () => {
    const entityId = "entity:Arrow";
    const motion = followupProgram("orient:Arrow", {
      controlOffset: { x: 30, y: -20 },
      delta: { x: 100, y: 40 },
      dependsOn: [],
      easing: "smooth",
      id: "orient:Arrow",
      interval: { end: 2, start: 0 },
      kind: "CreateMotion",
      orientToPath: true,
      provenance: { evidence: [], origin: "direct-manipulation" },
      targetEntityIds: [entityId],
    });

    const command = buildStudioCreationProjectionCommand({
      baseDuration: 4,
      programs: [creationProgram("Arrow"), motion],
    });
    expect(command.programs[1]?.operations[0]).toMatchObject({
      kind: "create-motion",
      orientToPath: true,
      targetEntityIds: [entityId],
    });
    expect(isExactStudioMotionProgramBatch([motion])).toBe(false);
    expect(studioMotionProjectionBatchKind([motion])).toBeNull();
  });

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

  it("normalizes canonical solid paint color tracks without evaluating colors in TypeScript", () => {
    const operation = {
      dependsOn: [],
      easing: "smooth" as const,
      entityId: "entity:Circle",
      from: "#0ea5e9",
      id: "fill-color-track:Circle",
      interval: { end: 2, start: 1 },
      key: "fillColor" as const,
      kind: "AnimateProperty" as const,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
      timelineTrack: true as const,
      to: "#f97316",
    };

    expect(sceneEditOperationSchema.safeParse(operation).success).toBe(true);
    expect(sceneEditOperationSchema.safeParse({ ...operation, to: "#F97316" }).success).toBe(false);
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 3,
      programs: [creationProgram("Circle"), followupProgram("fill-color-track:Circle", operation)],
    });

    expect(command.programs[1]?.operations[0]).toMatchObject({
      easing: "smooth",
      entityId: "entity:Circle",
      from: "#0ea5e9",
      kind: "paint-color-keyframes",
      property: "fill-color",
      to: "#f97316",
    });
  });

  it("normalizes created-shape colors and Line stroke style without accepting non-canonical values", () => {
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
      creationProgram("Line"),
      followupProgram("width:Line", {
        ...common,
        entityId: "entity:Line",
        id: "width:Line",
        key: "strokeWidth",
        value: 0.08,
      }),
      followupProgram("cap:Line", {
        ...common,
        entityId: "entity:Line",
        id: "cap:Line",
        key: "strokeCap",
        value: "round",
      }),
      followupProgram("dash:Line", {
        ...common,
        entityId: "entity:Line",
        id: "dash:Line",
        key: "strokeDash",
        value: { dashLength: 0.25, gapLength: 0.15 },
      }),
      followupProgram("solid:Line", {
        ...common,
        entityId: "entity:Line",
        id: "solid:Line",
        key: "strokeDash",
        value: null,
      }),
    ];

    const command = buildStudioCreationProjectionCommand({ baseDuration: 1, programs });

    expect(command.programs[1]?.operations[0]).toMatchObject({
      color: "#12abef",
      entityId,
      kind: "fill-color",
    });
    expect(command.programs[2]?.operations[0]).toMatchObject({ color: null, entityId, kind: "stroke-color" });
    expect(command.programs[4]?.operations[0]).toMatchObject({
      entityId: "entity:Line",
      kind: "stroke-width",
      widthWorld: 0.08,
    });
    expect(command.programs[5]?.operations[0]).toMatchObject({
      cap: "round",
      entityId: "entity:Line",
      kind: "stroke-cap",
    });
    expect(command.programs[6]?.operations[0]).toMatchObject({
      dashLengthWorld: 0.25,
      entityId: "entity:Line",
      gapLengthWorld: 0.15,
      kind: "stroke-dash",
    });
    expect(command.programs[7]?.operations[0]).toMatchObject({
      dashLengthWorld: null,
      entityId: "entity:Line",
      gapLengthWorld: null,
      kind: "stroke-dash",
    });
  });

  it("normalizes one complete Camera view transition without a synthetic entity", () => {
    const program = followupProgram("camera:focus", {
      dependsOn: [],
      easing: "smooth",
      from: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
      id: "camera:focus/animate",
      interval: { end: 2, start: 1 },
      kind: "AnimateCamera",
      provenance: { evidence: ["exact prepared bounds"], origin: "direct-manipulation" },
      to: { center: { x: 3, y: 1 }, frameHeight: 4.5, frameWidth: 8 },
    });
    const command = buildStudioCreationProjectionCommand({
      baseDuration: 4,
      programs: [creationProgram("Circle"), program],
    });

    expect(command.programs[1]?.operations[0]).toEqual({
      dependsOn: [],
      easing: "smooth",
      fromView: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
      id: "camera:focus/animate",
      interval: { end: 2, start: 1 },
      kind: "animate-camera",
      origin: "direct-manipulation",
      toView: { center: { x: 3, y: 1 }, frameHeight: 4.5, frameWidth: 8 },
    });
    expect(command.programs[1]?.operations[0]).not.toHaveProperty("entityId");
  });
});
