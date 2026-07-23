import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { projectedPositions, validateSuggestionDraft, validatedProgramRecord } from "./draft-validation";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import {
  createDirectManipulationPositionProgram,
  createDirectManipulationScaleProgram,
} from "./suggestion-program";

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

  it("projects a direct position change at the captured playhead", () => {
    const base = evaluateWorkingState(createFixtureWorkingState());
    const before = projectProposedState(base, 5).canvas.entities.find((entity) => entity.id === "equation_1");
    expect(before).toBeDefined();
    if (!before) return;
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: 5,
      delta: { x: 100, y: 40 },
      positions: { equation_1: before.position },
      scene: base.evaluatedScene,
      start: 5,
      targetEntityIds: ["equation_1"],
      transactionId: "position-projection",
    });
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    expect(projectProposedState(proposed, 5).canvas.entities.find((entity) => entity.id === "equation_1")?.position)
      .toEqual({ x: before.position.x + 100, y: before.position.y + 40 });
  });

  it("projects an immediate resize from an explicit absolute scale pair", () => {
    const validation = createDirectManipulationScaleProgram({
      capturedPlayhead: 5,
      interval: { end: 5, start: 5 },
      scales: { equation_1: { from: 1, to: 1.5 } },
      scene: STUDIO_FIXTURE_SCENE,
      targetEntityIds: ["equation_1"],
      transactionId: "scale-projection",
    });

    expect(validation.kind).toBe("valid");
    expect(validation.program.operations).toEqual([
      expect.objectContaining({
        entityId: "equation_1",
        from: 1,
        interval: { end: 5, start: 5 },
        key: "scale",
        kind: "AnimateProperty",
        to: 1.5,
      }),
    ]);
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    expect(projectProposedState(proposed, 5).canvas.entities.find((entity) => (
      entity.id === "equation_1"
    ))?.scale).toBeCloseTo(1.5);
  });

  it("previews an animated resize throughout its requested interval", () => {
    const validation = createDirectManipulationScaleProgram({
      capturedPlayhead: 5,
      interval: { end: 7, start: 5 },
      scales: { equation_1: { from: 1, to: 2 } },
      scene: STUDIO_FIXTURE_SCENE,
      targetEntityIds: ["equation_1"],
      transactionId: "animated-scale-projection",
    });
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));

    expect(projectProposedState(proposed, 5).canvas.entities.find((entity) => (
      entity.id === "equation_1"
    ))?.scale).toBeCloseTo(1);
    expect(projectProposedState(proposed, 6).canvas.entities.find((entity) => (
      entity.id === "equation_1"
    ))?.scale).toBeCloseTo(1.5);
    expect(projectProposedState(proposed, 7).canvas.entities.find((entity) => (
      entity.id === "equation_1"
    ))?.scale).toBeCloseTo(2);
  });

});
