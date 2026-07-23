import { describe, expect, it } from "vitest";

import { validateEditProgram } from "./edit-program-validation";
import type { EditProgramSuggestion } from "./edit-suggestions";

const explanation = {
  animation: "fade-in",
  end: 2,
  kind: "create-explanation",
  objectKind: "text",
  placement: "above",
  start: 1,
  targetObjectId: "selected",
  text: "First",
} as const;

const context = {
  capturedPlayhead: 1,
  objects: [{ id: "selected", lifetimes: [{ end: 10, start: 0 }], type: "Text" }],
  sceneDuration: 10,
  selectedObjectIds: ["selected"],
} as const;

const mathTexContext = {
  capturedPlayhead: 1,
  objects: [{ id: "equation", lifetimes: [{ end: 10, start: 0 }], type: "MathTex" }],
  sceneDuration: 10,
  selectedObjectIds: ["equation"],
} as const;

function transform(start: number, end: number, display: string) {
  return {
    easing: "smooth",
    end,
    identityAfter: "target-replaces-source",
    kind: "create-transform",
    mismatchMode: "transform",
    sourceObjectId: "equation",
    start,
    strategy: "transform-matching-tex",
    target: {
      displayLines: [`  ${display}  `],
      kind: "mathtex",
      label: `  ${display}  `,
      texParts: [`  ${display}  `],
    },
  } as const;
}

function motion(
  start: number,
  end: number,
  delta: Readonly<{ x: number; y: number }>,
  controlOffset: Readonly<{ x: number; y: number }>,
) {
  return {
    controlOffset,
    delta,
    easing: "smooth",
    end,
    kind: "create-motion",
    start,
    targetObjectIds: ["selected"],
  } as const;
}

describe("Edit Program validation boundary", () => {
  it("reuses the shared operation schema instead of accepting duplicate leaf kinds", () => {
    const operation: EditProgramSuggestion = {
      anchor: { kind: "absolute", seconds: 1 },
      execution: "sequence",
      kind: "edit-program",
      operations: [explanation, { ...explanation, end: 3, start: 2, text: "Second" }],
    };

    expect(validateEditProgram(operation, context)).toEqual({
      kind: "invalid",
      message: "The Edit Program does not match the supported operation contract.",
    });
  });

  it("rejects a structurally typed program with an unsupported positive playhead offset", () => {
    const operation = {
      anchor: { kind: "playhead-offset", offsetSeconds: 1, referenceSeconds: 1 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        explanation,
        {
          color: "black",
          destination: "next-scene",
          easing: "smooth",
          end: 3,
          kind: "create-scene-transition",
          shape: "circle",
          start: 2,
          style: "cover-reveal",
        },
      ],
    } as EditProgramSuggestion;

    expect(validateEditProgram(operation, context).kind).toBe("invalid");
  });

  it("accepts and normalizes every transform in a sequence", () => {
    const operation: EditProgramSuggestion = {
      anchor: { kind: "absolute", seconds: 1 },
      execution: "sequence",
      kind: "edit-program",
      operations: [transform(1, 2, "Maxwell"), transform(2, 3, "E = mc^2")],
    };

    const validation = validateEditProgram(operation, mathTexContext);
    expect(validation.kind).toBe("valid");
    if (validation.kind !== "valid") return;
    expect(validation.program.transforms).toHaveLength(2);
    expect(
      validation.program.operation.operations.map((step) =>
        step.kind === "create-transform" ? step.target.texParts : [],
      ),
    ).toEqual([["Maxwell"], ["E = mc^2"]]);
  });

  it("normalizes every motion in a sequence without replacing later steps", () => {
    const operation: EditProgramSuggestion = {
      anchor: { kind: "absolute", seconds: 1 },
      execution: "sequence",
      kind: "edit-program",
      operations: [motion(1, 2, { x: 20, y: 0 }, { x: 4, y: -8 }), motion(3, 4, { x: 0, y: 30 }, { x: -6, y: 10 })],
    };

    const validation = validateEditProgram(operation, context);
    expect(validation.kind).toBe("valid");
    if (validation.kind !== "valid") return;
    expect(validation.program.motions).toHaveLength(2);
    expect(validation.program.operation.operations).toEqual(operation.operations);
    expect(
      validation.program.motions.map(({ index, step }) => ({
        controlOffset: step.controlOffset,
        delta: step.delta,
        index,
        interval: { end: step.end, start: step.start },
      })),
    ).toEqual([
      {
        controlOffset: { x: 4, y: -8 },
        delta: { x: 20, y: 0 },
        index: 0,
        interval: { end: 2, start: 1 },
      },
      {
        controlOffset: { x: -6, y: 10 },
        delta: { x: 0, y: 30 },
        index: 1,
        interval: { end: 4, start: 3 },
      },
    ]);
  });

  it("rejects repeated transforms in a parallel program", () => {
    const operation: EditProgramSuggestion = {
      anchor: { kind: "absolute", seconds: 1 },
      execution: "parallel",
      kind: "edit-program",
      operations: [transform(1, 2, "Maxwell"), transform(1, 2, "E = mc^2")],
    };

    expect(validateEditProgram(operation, mathTexContext)).toEqual({
      kind: "invalid",
      message: "The Edit Program does not match the supported operation contract.",
    });
  });

  it("validates the source of every repeated transform", () => {
    const operation: EditProgramSuggestion = {
      anchor: { kind: "absolute", seconds: 1 },
      execution: "sequence",
      kind: "edit-program",
      operations: [transform(1, 2, "Maxwell"), { ...transform(2, 3, "E = mc^2"), sourceObjectId: "missing" }],
    };

    expect(validateEditProgram(operation, mathTexContext)).toEqual({
      kind: "invalid",
      message: "The Edit Program contains an invalid, unselected, or unavailable target.",
    });
  });
});
