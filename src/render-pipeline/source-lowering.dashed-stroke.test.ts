import { describe, expect, it } from "vitest";

import type { StudioCubicBezierSpec } from "../engine/cubic-bezier-authoring";
import type { StrokeDash } from "../studio/model";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import { importManimScene } from "./source-import";
import { lowerCanonicalProgramBatchSource } from "./source-lowering";
import { canonicalProgram, operationBase, request, source } from "./source-lowering.test-fixtures";

const FRAME = { height: 8, width: 14.222 } as const;

function createPathProgram(type: "CubicBezier" | "Line", transactionId: string, cubicBezier?: StudioCubicBezierSpec) {
  const entityId = `tx:${transactionId}/entity:path`;
  const operation: CanonicalEditOperation = {
    ...operationBase(`tx:${transactionId}/operation:create`, 7),
    entity: {
      ...(cubicBezier ? { cubicBezier, dimensions: { height: 2, width: 4 } } : {}),
      id: entityId,
      lifetime: { end: null, start: 7 },
      type,
    },
    kind: "CreateEntity",
  };
  return { entityId, program: canonicalProgram([operation], transactionId) };
}

function strokePropertyProgram(
  entityId: string,
  key: "strokeCap" | "strokeColor" | "strokeDash" | "strokeJoin" | "strokeWidth",
  value: "butt" | "round" | "square" | StrokeDash | number | string | null,
  transactionId: string,
  at = 7,
) {
  const operation: CanonicalEditOperation = {
    ...operationBase(`tx:${transactionId}/operation:set`, at),
    entityId,
    key,
    kind: "SetProperty",
    value,
  };
  return canonicalProgram([operation], transactionId);
}

function lower(programs: readonly CanonicalEditProgram[]) {
  const first = programs[0];
  if (!first) throw new Error("A dashed-stroke fixture requires one creation Program.");
  return lowerCanonicalProgramBatchSource(
    source,
    request(first, []),
    programs.map((program) => ({ program, sourceAnchor: 7 })),
    FRAME,
    null,
  );
}

describe("Studio path stroke Manim source lowering", () => {
  it("constructs a bounded DashedLine while preserving its initial stroke style", () => {
    const created = createPathProgram("Line", "dashed-line");
    const dashed = strokePropertyProgram(
      created.entityId,
      "strokeDash",
      { dashLength: 0.2, gapLength: 0.1 },
      "dashed-line-pattern",
    );
    const cap = strokePropertyProgram(created.entityId, "strokeCap", "round", "dashed-line-cap");
    const color = strokePropertyProgram(created.entityId, "strokeColor", "#12abef", "dashed-line-color");
    const width = strokePropertyProgram(created.entityId, "strokeWidth", 0.08, "dashed-line-width");

    const lowered = lower([created.program, dashed, cap, color, width]);

    expect(lowered.insertedCode).toContain("poietra_dashed_line_1 = Line(LEFT, RIGHT)");
    expect(lowered.insertedCode).toContain(
      "poietra_dashed_line_1.become(DashedLine(LEFT, RIGHT, dash_length=0.2, dashed_ratio=0.6667, cap_style=CapStyleType.ROUND))",
    );
    expect(lowered.insertedCode).toContain('.set_stroke("#12abef", width=8)');
    expect(
      importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation", FRAME)?.runtimeSceneState
        .objectGraph.entities[created.entityId]?.type,
    ).toBe("Line");
  });

  it("restores the existing solid Line constructor when the final static value is null", () => {
    const created = createPathProgram("Line", "solid-line");
    const dashed = strokePropertyProgram(
      created.entityId,
      "strokeDash",
      { dashLength: 0.15, gapLength: 0.1 },
      "solid-line-pattern",
    );
    const solid = strokePropertyProgram(created.entityId, "strokeDash", null, "solid-line-reset");

    const lowered = lower([created.program, dashed, solid]);

    expect(lowered.insertedCode).toContain("poietra_solid_line_1 = Line(LEFT, RIGHT)");
    expect(lowered.insertedCode).not.toContain("DashedLine(");
    expect(lowered.insertedCode).not.toContain("DashedVMobject(");
  });

  it("exports a solid open Pen in canonical world coordinates without a dashed wrapper", () => {
    const created = createPathProgram("CubicBezier", "solid-pen", {
      arrowEnd: false,
      control1: { x: -0.75, y: 1.25 },
      control2: { x: 0.5, y: -1.5 },
      end: { x: 1.75, y: 0.25 },
      start: { x: -1.25, y: -0.5 },
      strokeCap: "square",
      strokeWidth: 0.06,
    });

    const lowered = lower([created.program]);

    expect(lowered.insertedCode).toContain(
      "poietra_solid_pen_1 = CubicBezier((-1.25, -0.5, 0), (-0.75, 1.25, 0), (0.5, -1.5, 0), (1.75, 0.25, 0), cap_style=CapStyleType.SQUARE, stroke_width=6)",
    );
    expect(lowered.insertedCode).not.toContain("DashedVMobject(");
    expect(lowered.insertedCode).not.toContain("joint_type=");
  });

  it.each([
    ["miter", "MITER"],
    ["round", "ROUND"],
    ["bevel", "BEVEL"],
  ] as const)("hoists a static %s join into the open Pen constructor", (strokeJoin, manimJoin) => {
    const created = createPathProgram("CubicBezier", `joined-pen-${strokeJoin}`, {
      arrowEnd: false,
      control1: { x: -1, y: 1 },
      control2: { x: 1, y: -1 },
      continuationSegments: [
        {
          control1: { x: 2.5, y: 1.5 },
          control2: { x: 3.5, y: 1 },
          end: { x: 4, y: 0 },
        },
      ],
      end: { x: 2, y: 0 },
      start: { x: -2, y: 0 },
      strokeCap: "round",
      strokeWidth: 0.04,
    });
    const joined = strokePropertyProgram(created.entityId, "strokeJoin", strokeJoin, `joined-pen-${strokeJoin}-style`);

    const lowered = lower([created.program, joined]);

    expect(lowered.insertedCode).toContain(`joint_type=LineJointType.${manimJoin}`);
    expect(lowered.insertedCode).toContain(".add_cubic_bezier_curve_to(");
    expect(
      importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation", FRAME)?.runtimeSceneState
        .objectGraph.entities[created.entityId]?.type,
    ).toBe("CubicBezier");
  });

  it("rejects a Pen join outside the creation anchor", () => {
    const created = createPathProgram("CubicBezier", "late-joined-pen", {
      arrowEnd: false,
      control1: { x: -1, y: 1 },
      control2: { x: 1, y: -1 },
      continuationSegments: [
        {
          control1: { x: 2.5, y: 1.5 },
          control2: { x: 3.5, y: 1 },
          end: { x: 4, y: 0 },
        },
      ],
      end: { x: 2, y: 0 },
      start: { x: -2, y: 0 },
      strokeCap: "round",
      strokeWidth: 0.04,
    });
    const joined = strokePropertyProgram(created.entityId, "strokeJoin", "round", "late-join", 7.5);

    expect(() => lower([created.program, joined])).toThrow(/creation anchor/i);
  });

  it("builds the exact open Pen cubics before wrapping them in DashedVMobject", () => {
    const created = createPathProgram("CubicBezier", "dashed-pen", {
      arrowEnd: false,
      control1: { x: -1, y: 1 },
      control2: { x: 1, y: -1 },
      continuationSegments: [
        {
          control1: { x: 2.5, y: 1.5 },
          control2: { x: 3.5, y: 1 },
          end: { x: 4, y: 0 },
        },
      ],
      end: { x: 2, y: 0 },
      start: { x: -2, y: 0 },
      strokeCap: "round",
      strokeWidth: 0.04,
    });
    const dashed = strokePropertyProgram(
      created.entityId,
      "strokeDash",
      { dashLength: 0.2, gapLength: 0.3 },
      "dashed-pen-pattern",
    );

    const lowered = lower([created.program, dashed]);
    const variable = "poietra_dashed_pen_1";

    expect(lowered.insertedCode).toContain(
      `${variable} = CubicBezier((-2, 0, 0), (-1, 1, 0), (1, -1, 0), (2, 0, 0), cap_style=CapStyleType.ROUND, stroke_width=4)` +
        ".add_cubic_bezier_curve_to((2.5, 1.5, 0), (3.5, 1, 0), (4, 0, 0))",
    );
    expect(lowered.insertedCode).toContain(
      `${variable}.become(DashedVMobject(${variable}, num_dashes=max(2, int(-(-${variable}.get_arc_length() // 0.5))), dashed_ratio=0.4))`,
    );
    expect(lowered.insertedCode).toContain(`${variable}.set_stroke(width=4)`);
    expect(lowered.insertedCode).not.toContain("DashedLine(");
    expect(
      importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation", FRAME)?.runtimeSceneState
        .objectGraph.entities[created.entityId]?.type,
    ).toBe("CubicBezier");
  });
});
