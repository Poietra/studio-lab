import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "./edit-suggestions";
import {
  changeSuggestionExecution,
  editableSuggestionSteps,
  replaceSuggestionStep,
} from "./draft-operation";

const program: EditSuggestionOperation = {
  anchor: { kind: "absolute", seconds: 5 },
  execution: "sequence",
  kind: "edit-program",
  operations: [
    {
      animation: "fade-in",
      end: 6.5,
      kind: "create-explanation",
      objectKind: "text",
      placement: "right",
      start: 5,
      targetObjectId: "explanation-1",
      text: "Initial explanation",
    },
    {
      color: "sky",
      destination: "next-scene",
      easing: "smooth",
      end: 8,
      kind: "create-scene-transition",
      shape: "circle",
      start: 6.5,
      style: "cover-reveal",
    },
  ],
};

describe("editable suggestion programs", () => {
  it("cascades a retimed sequence and moves its canonical anchor", () => {
    const first = editableSuggestionSteps(program)[0];
    expect(first.kind).toBe("create-explanation");
    if (first.kind !== "create-explanation") return;
    const updated = replaceSuggestionStep(program, 0, {
      ...first,
      end: 7,
      start: 5.5,
      text: "Edited explanation",
    });

    expect(updated.anchor).toEqual({ kind: "absolute", seconds: 5.5 });
    expect(updated.kind).toBe("edit-program");
    if (updated.kind !== "edit-program") return;
    expect(updated.operations[0]).toMatchObject({
      end: 7,
      start: 5.5,
      text: "Edited explanation",
    });
    expect(updated.operations[1]).toMatchObject({ end: 8.5, start: 7 });
  });

  it("applies timing edited on any parallel step to the whole interval", () => {
    const parallel = changeSuggestionExecution(program, "parallel");
    expect(parallel.kind).toBe("edit-program");
    if (parallel.kind !== "edit-program") return;
    const transition = editableSuggestionSteps(parallel)[1];
    expect(transition.kind).toBe("create-scene-transition");
    if (transition.kind !== "create-scene-transition") return;
    const updated = replaceSuggestionStep(parallel, 1, {
      ...transition,
      end: 7.25,
      shape: "hexagon",
      start: 5.25,
    });

    expect(updated.anchor).toEqual({ kind: "absolute", seconds: 5.25 });
    expect(updated.kind).toBe("edit-program");
    if (updated.kind !== "edit-program") return;
    expect(updated.operations).toHaveLength(2);
    expect(updated.operations.every((step) => step.start === 5.25 && step.end === 7.25)).toBe(true);
    expect(updated.operations[1]).toMatchObject({ shape: "hexagon" });
  });

  it("turns a parallel interval into a contiguous sequence", () => {
    const parallel = changeSuggestionExecution(program, "parallel");
    const sequence = changeSuggestionExecution(parallel, "sequence");

    expect(sequence.kind).toBe("edit-program");
    if (sequence.kind !== "edit-program") return;
    expect(sequence.execution).toBe("sequence");
    expect(sequence.operations[1].start).toBe(sequence.operations[0].end);
  });
});
