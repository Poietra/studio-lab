import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { projectedPositions, validateSuggestionDraft, validatedProgramRecord } from "./draft-validation";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
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

  it("keeps an earlier direct position change while staging a change to another entity", () => {
    const initial = evaluateWorkingState(createFixtureWorkingState());
    const initialProjection = projectProposedState(initial, 5);
    const equation = initialProjection.canvas.entities.find((entity) => entity.id === "equation_1");
    const label = initialProjection.canvas.entities.find((entity) => entity.id === "label_1");
    expect(equation).toBeDefined();
    expect(label).toBeDefined();
    if (!equation || !label) return;

    const equationMove = createDirectManipulationPositionProgram({
      capturedPlayhead: 5,
      delta: { x: 80, y: 30 },
      positions: { equation_1: equation.position },
      scene: initial.evaluatedScene,
      start: 5,
      targetEntityIds: ["equation_1"],
      transactionId: "move-equation",
    });
    expect(equationMove.kind).toBe("valid");
    if (equationMove.kind !== "valid") return;
    const equationRecord = programRecord(equationMove.program, equationMove);
    const afterEquationMove = evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [equationRecord],
    }));
    const movedLabel = projectProposedState(afterEquationMove, 5).canvas.entities.find((entity) => entity.id === "label_1");
    expect(movedLabel).toBeDefined();
    if (!movedLabel) return;

    const labelMove = createDirectManipulationPositionProgram({
      capturedPlayhead: 5,
      delta: { x: -60, y: 20 },
      positions: { label_1: movedLabel.position },
      scene: afterEquationMove.evaluatedScene,
      start: 5,
      targetEntityIds: ["label_1"],
      transactionId: "move-label",
    });
    expect(labelMove.kind).toBe("valid");
    if (labelMove.kind !== "valid") return;

    const cumulative = evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [equationRecord],
      stagedPrograms: [programRecord(labelMove.program, labelMove)],
    }));
    const projection = projectProposedState(cumulative, 5);
    expect(projection.canvas.entities.find((entity) => entity.id === "equation_1")?.position)
      .toEqual({ x: equation.position.x + 80, y: equation.position.y + 30 });
    expect(projection.canvas.entities.find((entity) => entity.id === "label_1")?.position)
      .toEqual({ x: label.position.x - 60, y: label.position.y + 20 });
  });
});
