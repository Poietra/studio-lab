import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { projectedPositions, validateSuggestionDraft, validatedProgramRecord } from "./draft-validation";
import { evaluateWorkingState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import { createDirectManipulationPositionProgram } from "./suggestion-program";

const transition: EditSuggestionOperation = {
  anchor: { kind: "playhead", referenceSeconds: 5 },
  color: "sky",
  destination: "next-scene",
  easing: "smooth",
  end: 6.5,
  kind: "create-scene-transition",
  shape: "diamond",
  start: 5,
  style: "cover-reveal",
};

describe("Studio draft validation boundary", () => {
  it("rejects a Scene transition before canonicalization when no next Scene exists", () => {
    const result = validateSuggestionDraft(transition, {
      capturedPlayhead: 5,
      hasNextScene: false,
      origin: "remote-model",
      proposedState: evaluateWorkingState(createFixtureWorkingState()),
      selectedObjectIds: [],
      transactionId: "no-destination",
    });

    expect(result).toEqual(expect.objectContaining({ kind: "invalid" }));
    if (result.kind === "invalid") expect(result.message).toMatch(/no next Scene/i);
  });

  it("returns one normalized record for a valid suggestion", () => {
    const result = validateSuggestionDraft(transition, {
      capturedPlayhead: 5,
      hasNextScene: true,
      origin: "remote-model",
      proposedState: evaluateWorkingState(createFixtureWorkingState()),
      selectedObjectIds: [],
      transactionId: "with-destination",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.record.validation.status).toBe("valid");
    expect(result.record.program.operations.some((operation) => operation.kind === "InsertSceneBoundary")).toBe(true);
  });

  it("does not turn an invalid direct manipulation into a draft record", () => {
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: 5,
      delta: { x: 2, y: 0 },
      positions: { missing: { x: 0, y: 0 } },
      scene: STUDIO_FIXTURE_SCENE,
      start: 5,
      targetEntityIds: ["missing"],
      transactionId: "invalid-position",
    });

    expect(validatedProgramRecord(validation)).toEqual(expect.objectContaining({ kind: "invalid" }));
  });

  it("does not invent an origin position for an entity missing from the projection", () => {
    expect(projectedPositions([], ["missing"])).toEqual({
      kind: "invalid",
      message: "The projected position for missing is unavailable.",
    });
  });
});
