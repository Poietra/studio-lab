import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import { programRenderRequestSchema } from "./contracts";
import { importManimScene } from "./source-import";
import {
  findSceneMotionAnchors,
  lowerCanonicalProgramBatchSource,
  lowerCanonicalProgramSource,
} from "./source-lowering";
import {
  canonicalProgram,
  durationTrimProgram,
  durationWaitProgram,
  latestPosition,
  motionOperation,
  operationBase,
  request,
  roundTripSource,
  source,
  transformOperation,
} from "./source-lowering.test-fixtures";

describe("Canonical EditProgram source lowering", () => {
  it("lowers and reimports manually inserted geometry with safe default constructors", () => {
    const shapes: readonly Readonly<{
      constructor: string;
      dimensions?: Readonly<{ radius: number; sides: number }>;
      type: string;
    }>[] = [
      { constructor: "Circle(radius=1)", type: "Circle" },
      { constructor: "Rectangle(width=4, height=2)", type: "Rectangle" },
      { constructor: "Square(side_length=2)", type: "Square" },
      { constructor: "Line(LEFT, RIGHT)", type: "Line" },
      { constructor: "Arrow(LEFT, RIGHT, buff=0)", type: "Arrow" },
      { constructor: "Triangle(radius=1.25)", dimensions: { radius: 1.25, sides: 3 }, type: "Triangle" },
      {
        constructor: "RegularPolygon(7, radius=1.5)",
        dimensions: { radius: 1.5, sides: 7 },
        type: "RegularPolygon",
      },
    ];
    const operations = shapes.flatMap((shape, index): CanonicalEditOperation[] => {
      const entityId = `tx:manual-shapes/entity:shape-${index}`;
      const createId = `tx:manual-shapes/operation:create-${index}`;
      const positionId = `tx:manual-shapes/operation:position-${index}`;
      return [
        {
          ...operationBase(createId, 7),
          entity: {
            content: { displayLines: [shape.type], label: shape.type },
            ...(shape.dimensions ? { dimensions: shape.dimensions } : {}),
            id: entityId,
            lifetime: { end: null, start: 7 },
            type: shape.type,
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase(positionId, 7),
          dependsOn: [createId],
          entityId,
          key: "position",
          kind: "SetProperty",
          value: { x: 120 + index * 80, y: 180 },
        },
        {
          ...operationBase(`tx:manual-shapes/operation:show-${index}`, 7, 7.4),
          dependsOn: [positionId],
          effect: "fade-in",
          entityId,
          kind: "ChangePresence",
          persistent: true,
        },
      ];
    });
    const program = canonicalProgram(operations, "manual-shapes");
    const lowered = lowerCanonicalProgramSource(source, request(program, []), { height: 8, width: 14.222 }, null);

    for (const shape of shapes) expect(lowered.insertedCode).toContain(shape.constructor);
    expect(lowered.insertedCode.match(/FadeIn\(/g)).toHaveLength(shapes.length);
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    for (const [index, shape] of shapes.entries()) {
      const entityId = `tx:manual-shapes/entity:shape-${index}`;
      const sourceVariable = imported?.sourceVariables[entityId];
      expect(sourceVariable).toMatch(/^poietra_manual_shapes_/u);
      expect(imported?.runtimeSceneState.objectGraph.entities[entityId]).toMatchObject({
        sourceIdentity: { kind: "known", value: sourceVariable },
        type: shape.type,
        ...(shape.dimensions ? { geometry: { dimensions: { kind: "known", value: shape.dimensions } } } : {}),
      });
    }
  });

  it("lowers static opacity and rotation follow-ups onto one Studio-created variable", () => {
    const entityId = "tx:created-appearance/entity:circle";
    const create = canonicalProgram(
      [
        {
          ...operationBase("create-circle", 7),
          entity: {
            dimensions: { radius: 1 },
            id: entityId,
            lifetime: { end: null, start: 7 },
            type: "Circle",
          },
          kind: "CreateEntity",
        },
      ],
      "created-appearance",
    );
    const opacity = canonicalProgram(
      [
        {
          ...operationBase("set-created-opacity", 7),
          entityId,
          key: "appearance",
          kind: "SetProperty",
          value: 0.4,
        },
      ],
      "created-opacity",
    );
    const rotation = canonicalProgram(
      [
        {
          ...operationBase("rotate-created", 7),
          easing: "smooth",
          entityId,
          from: 0,
          key: "rotation",
          kind: "AnimateProperty",
          relativeDelta: Math.PI / 6,
          to: Math.PI / 6,
        },
      ],
      "created-rotation",
    );

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(create, []),
      [create, opacity, rotation].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.insertedCode).toContain("poietra_created_appearance_1 = Circle(radius=1)");
    expect(lowered.insertedCode).toContain("poietra_created_appearance_1.set_opacity(0.4)");
    expect(lowered.insertedCode).toContain("poietra_created_appearance_1.rotate(0.5236)");
  });

  it("lowers persistent paint order only for a Studio-created variable", () => {
    const entityId = "tx:created-order/entity:circle";
    const create = canonicalProgram(
      [
        {
          ...operationBase("create-ordered-circle", 7),
          entity: {
            dimensions: { radius: 1 },
            id: entityId,
            lifetime: { end: null, start: 7 },
            type: "Circle",
          },
          kind: "CreateEntity",
        },
      ],
      "created-order",
    );
    const ordering = canonicalProgram(
      [
        {
          ...operationBase("set-created-order", 7),
          entityId,
          key: "sourceZIndex",
          kind: "SetProperty",
          value: -2.5,
        },
      ],
      "created-order-followup",
    );

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(create, []),
      [create, ordering].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );
    expect(lowered.insertedCode).toContain("poietra_created_order_1.set_z_index(-2.5)");

    const importedOrdering = canonicalProgram([
      {
        ...operationBase("imported-order", 7),
        entityId: "equation_1",
        key: "sourceZIndex",
        kind: "SetProperty",
        value: 2,
      },
    ]);
    expect(() =>
      lowerCanonicalProgramSource(source, request(importedOrdering), { height: 8, width: 14.222 }, null),
    ).toThrow(/only Studio-created objects/i);
  });

  it("rejects canonical layer visibility instead of lowering it as opacity or removal", () => {
    const visibility = canonicalProgram([
      {
        ...operationBase("hide-created-layer", 7),
        entityId: "tx:hidden/entity:circle",
        key: "visibility",
        kind: "SetProperty",
        value: false,
      },
    ]);

    expect(() => lowerCanonicalProgramSource(source, request(visibility), { height: 8, width: 14.222 }, null)).toThrow(
      /canonical preview and MP4 export, but not Manim source export/i,
    );
  });

  it("keeps client opacity keyframes out of Manim source export", () => {
    const entityId = "tx:client-opacity/entity:circle";
    const program = canonicalProgram(
      [
        {
          ...operationBase("create-client-opacity", 7),
          entity: {
            dimensions: { radius: 1 },
            id: entityId,
            lifetime: { end: null, start: 7 },
            type: "Circle",
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase("client-opacity-segment", 7.5, 8),
          easing: "linear",
          entityId,
          from: 1,
          key: "appearance",
          kind: "AnimateProperty",
          to: 0,
        },
      ],
      "client-opacity",
    );

    expect(() => lowerCanonicalProgramSource(source, request(program, []), { height: 8, width: 14.222 }, null)).toThrow(
      /canonical client preview and video export, but not Manim source export/i,
    );
  });

  it("keeps client scale keyframes out of Manim source export", () => {
    const entityId = "tx:client-scale/entity:circle";
    const program = canonicalProgram(
      [
        {
          ...operationBase("create-client-scale", 7),
          entity: {
            dimensions: { radius: 1 },
            id: entityId,
            lifetime: { end: null, start: 7 },
            type: "Circle",
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase("client-scale-segment", 7.5, 8),
          easing: "smooth",
          entityId,
          from: 1,
          key: "scale",
          kind: "AnimateProperty",
          timelineTrack: true,
          to: 2,
        },
      ],
      "client-scale",
    );

    expect(() => lowerCanonicalProgramSource(source, request(program, []), { height: 8, width: 14.222 }, null)).toThrow(
      /scale keyframes are available in the canonical client preview and video export, but not Manim source export/i,
    );
  });

  it("keeps client rotation keyframes out of Manim source export", () => {
    const entityId = "tx:client-rotation/entity:circle";
    const program = canonicalProgram(
      [
        {
          ...operationBase("create-client-rotation", 7),
          entity: {
            dimensions: { radius: 1 },
            id: entityId,
            lifetime: { end: null, start: 7 },
            type: "Circle",
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase("client-rotation-segment", 7.5, 8),
          easing: "smooth",
          entityId,
          from: 0,
          key: "rotation",
          kind: "AnimateProperty",
          timelineTrack: true,
          to: Math.PI,
        },
      ],
      "client-rotation",
    );

    expect(() => lowerCanonicalProgramSource(source, request(program, []), { height: 8, width: 14.222 }, null)).toThrow(
      /rotation keyframes are available in the canonical client preview and video export, but not Manim source export/i,
    );
  });

  it("does not silently lower a motion spin as translation only", () => {
    const program = canonicalProgram([motionOperation({ rotationDeltaRadians: 2 * Math.PI })], "client-motion-spin");

    expect(() => lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null)).toThrow(
      /motion with spin is available in the canonical client preview and video export, but not Manim source export/i,
    );
  });

  it("does not silently lower path orientation as translation only", () => {
    const program = canonicalProgram([motionOperation({ orientToPath: true })], "client-motion-orientation");

    expect(() => lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null)).toThrow(
      /path orientation is available in the canonical client preview and video export, but not Manim source export/i,
    );
  });

  it("lowers Studio-created Text with the preview font and canonical size", () => {
    const entityId = "tx:created-text/entity:label";
    const createOperationId = "create-text";
    const create = canonicalProgram(
      [
        {
          ...operationBase(createOperationId, 7),
          entity: {
            content: {
              displayLines: ["Hello, Poietra!"],
              text: "Hello, Poietra!",
              textLayout: {
                alignment: "left",
                fontFamily: "mono",
                fontSize: 1.5,
                fontWeight: "bold",
                lineHeight: 1.2,
              },
            },
            id: entityId,
            lifetime: { end: null, start: 7 },
            type: "Text",
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase("fade-text", 7, 7.4),
          dependsOn: [createOperationId],
          effect: "fade-in",
          entityId,
          kind: "ChangePresence",
          persistent: true,
        },
      ],
      "created-text",
    );
    const fill = (transactionId: string, value: string) =>
      canonicalProgram(
        [
          {
            ...operationBase(`${transactionId}/operation`, 7),
            entityId,
            key: "fillColor",
            kind: "SetProperty",
            value,
          },
        ],
        transactionId,
      );
    const red = fill("created-text-red", "#ef4444");
    const green = fill("created-text-green", "#22c55e");

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(create, []),
      [create, red, green].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.insertedCode).toContain(
      'Text("Hello, Poietra!", font="DejaVu Sans Mono", weight=BOLD, disable_ligatures=True).scale_to_fit_height(1.5)',
    );
    expect(lowered.insertedCode).toContain('.set_fill("#22c55e", opacity=1)');
    expect(lowered.insertedCode).not.toContain("#ef4444");
    expect(lowered.insertedCode.indexOf('.set_fill("#22c55e", opacity=1)')).toBeLessThan(
      lowered.insertedCode.indexOf("FadeIn("),
    );
    const transactionMarkers = ["created-text", "created-text-red", "created-text-green"].map(
      (transactionId) => `# poietra:transaction ${JSON.stringify(transactionId)}`,
    );
    expect(lowered.insertedCode.indexOf(transactionMarkers[0]!)).toBeLessThan(
      lowered.insertedCode.indexOf(transactionMarkers[1]!),
    );
    expect(lowered.insertedCode.indexOf(transactionMarkers[1]!)).toBeLessThan(
      lowered.insertedCode.indexOf(transactionMarkers[2]!),
    );
    for (const marker of transactionMarkers) expect(lowered.insertedCode.split(marker)).toHaveLength(2);
    expect(lowered.insertedCode.match(/\.set_fill\(/gu)).toHaveLength(1);
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    expect(imported?.runtimeSceneState.objectGraph.entities[entityId]).toMatchObject({
      content: {
        text: "Hello, Poietra!",
        textLayout: { fontFamily: "mono", fontSize: 1.5, fontWeight: "bold" },
      },
      geometry: { style: { kind: "known", value: { fillColor: "#22c55e" } } },
      type: "Text",
    });
    const withoutFill = lowerCanonicalProgramBatchSource(
      source,
      request(create, []),
      [{ program: create, sourceAnchor: 7 }],
      { height: 8, width: 14.222 },
      null,
    );
    expect(withoutFill.insertedCode).not.toContain(".set_fill(");

    const mathTexEntityId = "tx:created-mathtex/entity:equation";
    const mathTexCreateId = "create-mathtex";
    const mathTexCreate = canonicalProgram(
      [
        {
          ...operationBase(mathTexCreateId, 7),
          entity: {
            content: { displayLines: ["E = mc^2"], texParts: ["E", "=", "m", "c^2"] },
            id: mathTexEntityId,
            lifetime: { end: null, start: 7 },
            type: "MathTex",
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase("write-mathtex", 7, 8),
          dependsOn: [mathTexCreateId],
          easing: "linear",
          entityId: mathTexEntityId,
          kind: "WriteIn",
        },
      ],
      "created-mathtex",
    );
    const mathTexFill = canonicalProgram(
      [
        {
          ...operationBase("created-mathtex-fill/operation", 7),
          entityId: mathTexEntityId,
          key: "fillColor",
          kind: "SetProperty",
          value: "#22c55e",
        },
      ],
      "created-mathtex-fill",
    );
    const firstTargetId = "tx:created-mathtex-transform-a/entity:target";
    const secondTargetId = "tx:created-mathtex-transform-b/entity:target";
    const firstTransform = canonicalProgram(
      [
        transformOperation("created-mathtex-transform-a/operation", 8, mathTexEntityId, firstTargetId, [
          "F",
          "=",
          "m",
          "a",
        ]),
      ],
      "created-mathtex-transform-a",
    );
    const secondTransform = canonicalProgram(
      [
        transformOperation("created-mathtex-transform-b/operation", 9, firstTargetId, secondTargetId, [
          "E",
          "=",
          "m",
          "c^2",
        ]),
      ],
      "created-mathtex-transform-b",
    );
    const mathTexLowered = lowerCanonicalProgramBatchSource(
      source,
      request(mathTexCreate, []),
      [mathTexCreate, mathTexFill, firstTransform, secondTransform].map((program) => ({
        program,
        sourceAnchor: 7,
      })),
      { height: 8, width: 14.222 },
      null,
    );

    const fillSource = '.set_fill("#22c55e", opacity=1)';
    expect(mathTexLowered.insertedCode.match(/\.set_fill\("#22c55e", opacity=1\)/gu)).toHaveLength(3);
    expect(mathTexLowered.insertedCode.indexOf(fillSource)).toBeLessThan(mathTexLowered.insertedCode.indexOf("Write("));
    for (const transactionId of ["created-mathtex-transform-a", "created-mathtex-transform-b"]) {
      const variable = `poietra_${transactionId.replaceAll("-", "_")}_1`;
      expect(mathTexLowered.insertedCode.indexOf(`${variable} = MathTex(`)).toBeLessThan(
        mathTexLowered.insertedCode.indexOf(`${variable}${fillSource}`),
      );
      expect(mathTexLowered.insertedCode.indexOf(`${variable}${fillSource}`)).toBeLessThan(
        mathTexLowered.insertedCode.indexOf("TransformMatchingTex(", mathTexLowered.insertedCode.indexOf(variable)),
      );
    }
  });

  it.each(["こんにちは", "two\nlines"])(
    "rejects Text Python export that would diverge from the preview: %s",
    (text) => {
      const create = canonicalProgram(
        [
          {
            ...operationBase("create-unicode-text", 7),
            entity: {
              content: {
                displayLines: text.split("\n"),
                text,
                ...(text === "こんにちは"
                  ? {
                      textLayout: {
                        alignment: "left" as const,
                        fontFamily: "sans" as const,
                        fontSize: 1,
                        fontWeight: "bold" as const,
                        lineHeight: 1.2,
                      },
                    }
                  : {}),
              },
              id: "tx:unicode-text/entity:label",
              lifetime: { end: null, start: 7 },
              type: "Text",
            },
            kind: "CreateEntity",
          },
        ],
        "unicode-text",
      );

      expect(() =>
        lowerCanonicalProgramSource(source, request(create, []), { height: 8, width: 14.222 }, null),
      ).toThrow(/Python export would not preserve it faithfully/i);
    },
  );

  it("rejects non-default Text layout instead of dropping it from Python export", () => {
    const create = canonicalProgram(
      [
        {
          ...operationBase("create-layout-text", 7),
          entity: {
            content: {
              displayLines: ["Wide"],
              text: "Wide",
              textLayout: {
                alignment: "right",
                fontFamily: "sans",
                fontSize: 1,
                fontWeight: "regular",
                lineHeight: 1.8,
              },
            },
            id: "tx:layout-text/entity:label",
            lifetime: { end: null, start: 7 },
            type: "Text",
          },
          kind: "CreateEntity",
        },
      ],
      "layout-text",
    );

    expect(() => lowerCanonicalProgramSource(source, request(create, []), { height: 8, width: 14.222 }, null)).toThrow(
      /Python export would not preserve it faithfully/i,
    );
  });

  it("rejects Text wrap width instead of exporting an unwrapped Python object", () => {
    const create = canonicalProgram(
      [
        {
          ...operationBase("create-wrapped-text", 7),
          entity: {
            content: {
              displayLines: ["A long line"],
              text: "A long line",
              textLayout: {
                alignment: "left",
                fontFamily: "sans",
                fontSize: 1,
                fontWeight: "regular",
                lineHeight: 1.2,
                wrapWidth: 4,
              },
            },
            id: "tx:wrapped-text/entity:label",
            lifetime: { end: null, start: 7 },
            type: "Text",
          },
          kind: "CreateEntity",
        },
      ],
      "wrapped-text",
    );

    expect(() => lowerCanonicalProgramSource(source, request(create, []), { height: 8, width: 14.222 }, null)).toThrow(
      /wrap width faithfully/i,
    );
  });

  it("lowers Studio-created shape colors in operation order with the current opacity", () => {
    const entityId = "tx:created-colors/entity:circle";
    const create = canonicalProgram(
      [
        {
          ...operationBase("create-color-circle", 7),
          entity: {
            dimensions: { radius: 1 },
            id: entityId,
            lifetime: { end: null, start: 7 },
            type: "Circle",
          },
          kind: "CreateEntity",
        },
      ],
      "created-colors",
    );
    const propertyProgram = (
      transactionId: string,
      key: "appearance" | "fillColor" | "strokeCap" | "strokeColor" | "strokeWidth",
      value: number | string,
      targetEntityId = entityId,
    ) =>
      canonicalProgram(
        [
          {
            ...operationBase(`${transactionId}/operation`, 7),
            entityId: targetEntityId,
            key,
            kind: "SetProperty",
            value,
          },
        ],
        transactionId,
      );
    const opacity = propertyProgram("created-opacity", "appearance", 0.4);
    const fill = propertyProgram("created-fill", "fillColor", "#12abef");
    const stroke = propertyProgram("created-stroke", "strokeColor", "#fedcba");
    const shapeWidth = propertyProgram("created-shape-width", "strokeWidth", 0.08);

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(create, []),
      [create, opacity, fill, stroke].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );
    expect(lowered.insertedCode).toContain('poietra_created_colors_1.set_fill("#12abef", opacity=0.4)');
    expect(lowered.insertedCode).toContain('poietra_created_colors_1.set_stroke("#fedcba")');
    expect(lowered.insertedCode.indexOf(".set_opacity(0.4)")).toBeLessThan(lowered.insertedCode.indexOf(".set_fill("));

    const loweredShapeWidth = lowerCanonicalProgramBatchSource(
      source,
      request(create, []),
      [create, shapeWidth].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );
    expect(loweredShapeWidth.insertedCode).toContain("poietra_created_colors_1.set_stroke(width=8)");

    const fillFirst = lowerCanonicalProgramBatchSource(
      source,
      request(create, []),
      [create, fill, opacity].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );
    expect(fillFirst.insertedCode).toContain('poietra_created_colors_1.set_fill("#12abef", opacity=1)');
    expect(fillFirst.insertedCode.indexOf(".set_fill(")).toBeLessThan(
      fillFirst.insertedCode.indexOf(".set_opacity(0.4)"),
    );

    const lineEntityId = "tx:created-line-style/entity:line";
    const createLineId = "tx:created-line-style/operation:create";
    const createLine = canonicalProgram(
      [
        {
          ...operationBase(createLineId, 7),
          entity: {
            id: lineEntityId,
            lifetime: { end: null, start: 7 },
            type: "Line",
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase("tx:created-line-style/operation:draw", 7, 7.5),
          dependsOn: [createLineId],
          easing: "linear",
          entityId: lineEntityId,
          kind: "DrawIn",
        },
      ],
      "created-line-style",
    );
    const lineStroke = propertyProgram("created-line-stroke", "strokeColor", "#fedcba", lineEntityId);
    const lineWidth = propertyProgram("created-line-width", "strokeWidth", 0.08, lineEntityId);
    const lineCap = propertyProgram("created-line-cap", "strokeCap", "round", lineEntityId);
    const loweredLine = lowerCanonicalProgramBatchSource(
      source,
      request(createLine, []),
      [createLine, lineStroke, lineWidth, lineCap].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );
    const initialStroke = 'poietra_created_line_style_1.set_stroke("#fedcba", width=8)';
    const initialCap = "poietra_created_line_style_1.set_cap_style(CapStyleType.ROUND)";
    expect(loweredLine.insertedCode).toContain(initialStroke);
    expect(loweredLine.insertedCode).toContain(initialCap);
    expect(loweredLine.insertedCode.indexOf(initialStroke)).toBeLessThan(loweredLine.insertedCode.indexOf("Create("));
    expect(loweredLine.insertedCode.indexOf(initialCap)).toBeLessThan(loweredLine.insertedCode.indexOf("Create("));
    expect(loweredLine.insertedCode.match(/\.set_stroke\(/gu)).toHaveLength(1);
    expect(loweredLine.insertedCode.match(/\.set_cap_style\(/gu)).toHaveLength(1);

    const createLineWithoutDraw = canonicalProgram(
      [
        createLine.operations[0]!,
        {
          ...operationBase("tx:created-line-without-draw/operation:fade", 7, 7.5),
          dependsOn: [createLineId],
          effect: "fade-in",
          entityId: lineEntityId,
          kind: "ChangePresence",
          persistent: true,
        },
      ],
      "created-line-without-draw",
    );
    const capWithoutDraw = propertyProgram("created-line-cap-without-draw", "strokeCap", "square", lineEntityId);
    const loweredLineWithoutDraw = lowerCanonicalProgramBatchSource(
      source,
      request(createLineWithoutDraw, []),
      [createLineWithoutDraw, capWithoutDraw].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );
    expect(loweredLineWithoutDraw.insertedCode).toContain(".set_cap_style(CapStyleType.SQUARE)");
    expect(loweredLineWithoutDraw.insertedCode.indexOf(".set_cap_style(")).toBeLessThan(
      loweredLineWithoutDraw.insertedCode.indexOf("FadeIn("),
    );

    const invalidLineWidth = propertyProgram("invalid-line-width", "strokeWidth", 0.501, lineEntityId);
    expect(() =>
      lowerCanonicalProgramBatchSource(
        source,
        request(createLine, []),
        [createLine, invalidLineWidth].map((program) => ({ program, sourceAnchor: 7 })),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/between 0\.005 and 0\.5 world units/i);

    const invalidLineCap = propertyProgram("invalid-line-cap", "strokeCap", "projecting", lineEntityId);
    expect(() =>
      lowerCanonicalProgramBatchSource(
        source,
        request(createLine, []),
        [createLine, invalidLineCap].map((program) => ({ program, sourceAnchor: 7 })),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/stroke cap must be butt, round, or square/i);

    const lateLineCap = canonicalProgram(
      [
        {
          ...operationBase("late-line-cap/operation", 8),
          entityId: lineEntityId,
          key: "strokeCap",
          kind: "SetProperty",
          value: "square",
        },
      ],
      "late-line-cap",
    );
    expect(() =>
      lowerCanonicalProgramBatchSource(
        source,
        request(createLine, []),
        [createLine, lateLineCap].map((program) => ({ program, sourceAnchor: 7 })),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/creation anchor/i);
  });

  it("rejects shape colors for imported entities", () => {
    const importedFill = canonicalProgram([
      {
        ...operationBase("imported-fill", 7),
        entityId: "equation_1",
        key: "fillColor",
        kind: "SetProperty",
        value: "#12abef",
      },
    ]);

    expect(() =>
      lowerCanonicalProgramSource(source, request(importedFill), { height: 8, width: 14.222 }, null),
    ).toThrow(/only authorized Studio-created entities/i);

    const importedStrokeWidth = canonicalProgram([
      {
        ...operationBase("imported-stroke-width", 7),
        entityId: "equation_1",
        key: "strokeWidth",
        kind: "SetProperty",
        value: 0.08,
      },
    ]);
    expect(() =>
      lowerCanonicalProgramSource(source, request(importedStrokeWidth), { height: 8, width: 14.222 }, null),
    ).toThrow(/only authorized Studio-created Line or closed primitive entities/i);

    const importedStrokeCap = canonicalProgram([
      {
        ...operationBase("imported-stroke-cap", 7),
        entityId: "equation_1",
        key: "strokeCap",
        kind: "SetProperty",
        value: "round",
      },
    ]);
    expect(() =>
      lowerCanonicalProgramSource(source, request(importedStrokeCap), { height: 8, width: 14.222 }, null),
    ).toThrow(/only authorized Studio-created Line entities/i);
  });

  it("lowers a Scene duration extension to an explicit wait", () => {
    const wait: CanonicalEditOperation = {
      ...operationBase("extend-duration", 7, 10),
      eventKind: "wait",
      kind: "InsertTimelineEvent",
      label: "Extend Scene to 11s",
    };
    const lowered = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([wait], "extend-duration"), []),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("self.wait(3)");
    expect(imported?.runtimeSceneState.duration).toBe(11);
  });

  it("rejects an inserted wait that shares its source bucket", () => {
    const position: CanonicalEditOperation = {
      ...operationBase("position-with-wait", 7),
      entityId: "equation_1",
      key: "position",
      kind: "SetProperty",
      value: { x: 320, y: 180 },
    };
    const wait: CanonicalEditOperation = {
      ...operationBase("shared-wait", 7, 8),
      eventKind: "wait",
      kind: "InsertTimelineEvent",
      label: "wait",
    };

    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([position, wait])),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow("An inserted wait must occupy its own source interval.");
  });

  it("lowers a Scene duration trim by reducing only its referenced Studio wait", () => {
    const extension = durationWaitProgram(3, "duration-extension");
    const wait = extension.operations[0];
    expect(wait?.kind).toBe("InsertTimelineEvent");
    if (wait?.kind !== "InsertTimelineEvent") return;
    const trim = durationTrimProgram(1, 10, [wait.id], "duration-trim");

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(extension),
      [extension, trim].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
      [
        { interval: { end: 10, start: 7 }, kind: "insert", operationId: wait.id },
        {
          interval: { end: 10, start: 9 },
          kind: "remove",
          operationId: trim.operations[0]!.id,
          waitReductions: [{ operationId: wait.id, removedDuration: 1 }],
        },
      ],
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("self.wait(2)");
    expect(lowered.insertedCode).not.toContain("self.wait(3)");
    expect(lowered.source).not.toContain('poietra:transaction "duration-trim"');
    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([9]);
    expect(imported?.runtimeSceneState.duration).toBe(10);
  });

  it("restores the original source exactly when a Scene duration wait is fully removed", () => {
    const extension = durationWaitProgram(3, "duration-to-remove");
    const wait = extension.operations[0];
    expect(wait?.kind).toBe("InsertTimelineEvent");
    if (wait?.kind !== "InsertTimelineEvent") return;
    const trim = durationTrimProgram(3, 8, [wait.id], "remove-duration-wait");

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(extension),
      [extension, trim].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
      [
        { interval: { end: 10, start: 7 }, kind: "insert", operationId: wait.id },
        {
          interval: { end: 10, start: 7 },
          kind: "remove",
          operationId: trim.operations[0]!.id,
          waitReductions: [{ operationId: wait.id, removedDuration: 3 }],
        },
      ],
    );

    expect(lowered.source).toBe(source);
    expect(lowered.insertedCode).toBe("");
    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([7]);
    expect(
      importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation")?.runtimeSceneState.duration,
    ).toBe(8);
  });

  it("refuses a Scene duration trim that cannot be proven against a Studio wait", () => {
    const trim = durationTrimProgram(1, 7, ["missing-wait"], "unproven-duration-trim");

    expect(() =>
      lowerCanonicalProgramBatchSource(
        source,
        request(trim),
        [{ program: trim, sourceAnchor: 7 }],
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/requires the canonical Rust timeline projection/i);
  });

  it("lowers a quadratic screen-space motion to an exact Manim cubic path", () => {
    const operation = motionOperation({ controlOffset: { x: 32, y: 45 } });
    const lowered = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([operation])),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const sample =
      imported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.at(-1);

    expect(lowered.insertedCode).toContain(
      '# poietra:motion {"motions":[{"controlOffset":{"x":32,"y":45},"delta":{"x":64,"y":-45},"variables":["equation"]}],"version":1}',
    );
    expect(lowered.insertedCode).toContain(
      "MoveAlongPath(equation, CubicBezier(equation.get_center(), equation.get_center() + 0.9481 * RIGHT + 0.3333 * DOWN, equation.get_center() + 1.4222 * RIGHT, equation.get_center() + 1.4222 * RIGHT + 1 * UP))",
    );
    expect(lowered.insertedCode).not.toContain("equation.animate.shift(");
    expect(sample).toMatchObject({
      control: { x: 384, y: 202.5 },
      from: { x: 320, y: 180 },
      interval: { end: 8.5, start: 7 },
      value: { x: 384, y: 135 },
    });
  });

  it("preserves curved zero-displacement paths and tiny straight displacements", () => {
    const curved = lowerCanonicalProgramSource(
      source,
      request(
        canonicalProgram([
          motionOperation({
            controlOffset: { x: 0, y: 30 },
            delta: { x: 0, y: 0 },
          }),
        ]),
      ),
      { height: 8, width: 14.222 },
      null,
    );
    const tiny = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([motionOperation({ delta: { x: 0.001, y: 0 } })])),
      { height: 8, width: 14.222 },
      null,
    );

    expect(curved.insertedCode).toContain("MoveAlongPath(equation, CubicBezier(");
    expect(tiny.insertedCode).toContain("equation.animate.shift(0.00002222 * RIGHT)");
  });

  it("rejects CameraFocus camera changes through the shared capability contract", () => {
    const cameraFocus: CanonicalEditOperation = {
      ...operationBase("camera-focus", 7, 8),
      easing: "smooth",
      from: { center: { x: 0, y: 0 }, frameHeight: 8, frameWidth: 14.222 },
      kind: "AnimateCamera",
      to: { center: { x: 2, y: 0 }, frameHeight: 4, frameWidth: 7.111 },
    };
    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([cameraFocus]), []),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/AnimateCamera has no truthful source lowering/);
  });

  it("rejects live relations because a one-shot move cannot preserve that constraint", () => {
    const liveRelation: CanonicalEditOperation = {
      ...operationBase("live-relation", 7),
      kind: "SetRelation",
      mode: "live",
      offset: { x: 145, y: 0 },
      placement: "right",
      relation: "next-to",
      sourceEntityId: "label_1",
      targetEntityId: "equation_1",
    };
    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([liveRelation]), [
          { entityId: "equation_1", sourceVariable: "equation" },
          { entityId: "label_1", sourceVariable: "label" },
        ]),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/SetRelation live has no truthful source lowering/);
  });

  it("requires imported source identity and an exact source anchor", () => {
    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([motionOperation()]), []),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/no imported Python source identity/i);
    const program = {
      ...canonicalProgram([motionOperation()]),
      anchor: {
        capturedPlayhead: 5,
        evidence: [],
        resolvedSeconds: 5,
        source: { kind: "playhead" as const, referenceSeconds: 5 },
      },
    };
    expect(() => lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null)).toThrow(
      /No # poietra:anchor 5.000/,
    );
  });

  it("keeps transaction text data-only while generating safe Python variables", () => {
    const unsafeId = "unsafe\nself.remove(equation)";
    const program = canonicalProgram([motionOperation()], unsafeId);
    expect(programRenderRequestSchema.safeParse(request(program)).success).toBe(true);
    const lowered = lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null);
    expect(lowered.insertedCode).toContain("unsafe\\nself.remove(equation)");
    expect(lowered.insertedCode).not.toContain("\nself.remove(equation)\n");
  });

  it("does not overwrite an existing Python identifier when allocating transaction variables", () => {
    const collisionSource = source.replace(
      "        equation = MathTex",
      '        poietra_collision_1 = Text("Existing")\n        equation = MathTex',
    );
    const create: CanonicalEditOperation = {
      ...operationBase("create", 7),
      entity: {
        content: { displayLines: ["x"], texParts: ["x"] },
        id: "tx:collision/entity:new",
        lifetime: { end: null, start: 7 },
        type: "MathTex",
      },
      kind: "CreateEntity",
    };
    const code = lowerCanonicalProgramSource(
      collisionSource,
      request(canonicalProgram([create], "collision"), []),
      { height: 8, width: 14.222 },
      null,
    ).insertedCode;

    expect(code).toContain('poietra_collision_1_2 = MathTex("x")');
    expect(code).not.toContain('poietra_collision_1 = MathTex("x")');
  });

  it("orders same-bucket dependencies and carries chained transform identities", () => {
    const firstTarget = "tx:chain/entity:first";
    const secondTarget = "tx:chain/entity:second";
    const explanationId = "tx:chain/entity:explanation";
    const relation: CanonicalEditOperation = {
      ...operationBase("place-explanation", 7),
      kind: "SetRelation",
      mode: "snapshot",
      offset: { x: 145, y: 0 },
      placement: "right",
      relation: "next-to",
      sourceEntityId: explanationId,
      targetEntityId: firstTarget,
    };
    const explanation: CanonicalEditOperation = {
      ...operationBase("create-explanation", 7),
      entity: {
        content: { displayLines: ["Explanation"], text: "Explanation" },
        id: explanationId,
        lifetime: { end: null, start: 7 },
        type: "Text",
      },
      kind: "CreateEntity",
    };
    const operations: CanonicalEditOperation[] = [
      explanation,
      transformOperation("first-transform", 7, "equation_1", firstTarget, ["F", "=", "m", "a"]),
      relation,
      transformOperation("second-transform", 8, firstTarget, secondTarget, ["p", "=", "m", "v"]),
    ];
    const lowered = lowerCanonicalProgramSource(
      roundTripSource,
      request(canonicalProgram(operations, "chain")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const targetVariable = imported?.sourceVariables[firstTarget];
    const explanationVariable = imported?.sourceVariables[explanationId];

    expect(lowered.insertedCode.match(/# poietra:position/g)).toHaveLength(3);
    expect(lowered.insertedCode).toContain("equation = poietra_chain_3");
    expect(lowered.insertedCode.indexOf(`${targetVariable} = MathTex(`)).toBeLessThan(
      lowered.insertedCode.indexOf(`${explanationVariable}.move_to(${targetVariable}.get_center()`),
    );
    expect(imported?.sourceVariables).toMatchObject({
      [explanationId]: "poietra_chain_1",
      [firstTarget]: "poietra_chain_2",
      [secondTarget]: "poietra_chain_3",
    });
    expect(
      [firstTarget, secondTarget].map((id) => imported?.runtimeSceneState.objectGraph.entities[id]?.lifetime),
    ).toEqual([[{ end: 9, start: 7 }], [{ end: 10, start: 8 }]]);
    expect(imported).not.toBeNull();
    if (!imported) return;
    const sourcePosition = latestPosition(imported, "source:examples/relativity.py#GroupedEquation:equation");
    expect(sourcePosition).toMatchObject({ x: expect.closeTo(410, 2), y: 135 });
    expect(latestPosition(imported, firstTarget)).toEqual(sourcePosition);
    expect(latestPosition(imported, secondTarget)).toEqual(sourcePosition);
    const explanationPosition = latestPosition(imported, explanationId);
    expect(explanationPosition).toMatchObject({
      x: expect.closeTo(sourcePosition.x + 145, 1),
      y: expect.closeTo(sourcePosition.y, 2),
    });
  });

  it("preserves an explicit linear MathTex Transform easing in Python source", () => {
    const target = "tx:linear-transform/entity:target";
    const operation = {
      ...transformOperation("linear-transform", 7, "equation_1", target, ["F", "=", "m", "a"]),
      easing: "linear" as const,
      strategy: "replacement-transform" as const,
    };
    const lowered = lowerCanonicalProgramSource(
      roundTripSource,
      request(canonicalProgram([operation], "linear-transform")),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.insertedCode).toContain("ReplacementTransform(");
    expect(lowered.insertedCode).toContain("rate_func=linear");
  });

  it("carries transform alias lineage across Programs in one batch", () => {
    const firstTarget = "tx:alias-a/entity:first";
    const secondTarget = "tx:alias-b/entity:second";
    const first = canonicalProgram(
      [transformOperation("tx:alias-a/operation:transform", 7, "equation_1", firstTarget, ["F", "=", "m", "a"])],
      "alias-a",
    );
    const secondBase = canonicalProgram(
      [transformOperation("tx:alias-b/operation:transform", 8, firstTarget, secondTarget, ["p", "=", "m", "v"])],
      "alias-b",
    );
    const second: CanonicalEditProgram = {
      ...secondBase,
      anchor: {
        capturedPlayhead: 8,
        evidence: [],
        resolvedSeconds: 8,
        source: { kind: "playhead", referenceSeconds: 8 },
      },
    };
    const laterMotion = motionOperation({
      id: "tx:alias-motion/operation:motion",
      interval: { end: 10, start: 9 },
      targetEntityIds: ["equation_1"],
    });
    const motionBase = canonicalProgram([laterMotion], "alias-motion");
    const motion: CanonicalEditProgram = {
      ...motionBase,
      anchor: {
        capturedPlayhead: 9,
        evidence: [],
        resolvedSeconds: 9,
        source: { kind: "playhead", referenceSeconds: 9 },
      },
    };

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(first),
      [first, second, motion].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.insertedCode).toContain("poietra_alias_a_1 = poietra_alias_b_1");
    expect(lowered.insertedCode).toContain("equation = poietra_alias_b_1");
    expect(lowered.insertedCode.lastIndexOf("equation = poietra_alias_b_1")).toBeLessThan(
      lowered.insertedCode.indexOf("equation.animate.shift("),
    );
  });

  it("lowers a finite Studio-created lifetime at separate safe anchors", () => {
    const finiteSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const entityId = "tx:finite-owned/entity:circle";
    const createId = "tx:finite-owned/operation:create";
    const appearId = "tx:finite-owned/operation:appear";
    const program: CanonicalEditProgram = {
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
          ...operationBase(createId, 5),
          entity: {
            content: { displayLines: ["Circle"], label: "Circle" },
            id: entityId,
            lifetime: { end: 7, start: 5 },
            type: "Circle",
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase(appearId, 5, 5.4),
          dependsOn: [createId],
          effect: "fade-in",
          entityId,
          kind: "ChangePresence",
          persistent: true,
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: {
        edges: [{ from: createId, reason: "explicit", to: appearId }],
        mode: "sequence",
        order: [createId, appearId],
      },
      transactionId: "finite-owned",
      version: 1,
    };

    expect(() =>
      lowerCanonicalProgramSource(finiteSource, request(program, []), { height: 8, width: 14.222 }, null),
    ).toThrow(/batch source pipeline/i);

    const lowered = lowerCanonicalProgramBatchSource(
      finiteSource,
      request(program, []),
      [{ program, sourceAnchor: 5 }],
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.anchorLines).toHaveLength(2);
    expect(lowered.source.indexOf("Circle(radius=1)")).toBeLessThan(lowered.source.indexOf("self.remove("));
    expect(lowered.source).toContain("# poietra:anchor 5.4");
    expect(lowered.source).toContain("# poietra:anchor 7.4");
    const imported = importManimScene(lowered.source, "finite.py", "GroupedEquation", { height: 8, width: 14.222 });
    expect(imported?.runtimeSceneState.objectGraph.entities[entityId]?.lifetime).toEqual([{ end: 7.4, start: 5 }]);

    const endWait = canonicalProgram(
      [
        {
          ...operationBase("end-anchor-wait/operation/wait", 7, 8),
          eventKind: "wait",
          kind: "InsertTimelineEvent",
          label: "Wait at lifetime end",
        },
      ],
      "end-anchor-wait",
    );
    const sameAnchor = lowerCanonicalProgramBatchSource(
      finiteSource,
      request(program, []),
      [
        { program, sourceAnchor: 5 },
        { program: endWait, sourceAnchor: 7 },
      ],
      { height: 8, width: 14.222 },
      null,
    );
    expect(sameAnchor.insertedCode.indexOf("self.remove(")).toBeLessThan(
      sameAnchor.insertedCode.indexOf('# poietra:transaction "end-anchor-wait"'),
    );
    expect(
      importManimScene(sameAnchor.source, "finite.py", "GroupedEquation", { height: 8, width: 14.222 })
        ?.runtimeSceneState.objectGraph.entities[entityId]?.lifetime,
    ).toEqual([{ end: 7.4, start: 5 }]);
  });
});
