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

describe("Edit Program validation boundary", () => {
  it("reuses the shared operation schema instead of accepting duplicate leaf kinds", () => {
    const operation: EditProgramSuggestion = {
      anchor: { kind: "absolute", seconds: 1 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        explanation,
        { ...explanation, end: 3, start: 2, text: "Second" },
      ],
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
});
