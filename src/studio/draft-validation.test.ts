import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { projectedPositions, validateSuggestionDraft, validatedProgramRecord } from "./draft-validation";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import {
  createDirectManipulationPositionProgram,
  createDirectManipulationResizeProgram,
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

  it("keeps distinct sequential motions through the complete draft validation path", () => {
    const operation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          controlOffset: { x: 8, y: -12 },
          delta: { x: 40, y: 0 },
          easing: "smooth",
          end: 6,
          kind: "create-motion",
          start: 5,
          targetObjectIds: ["equation_1"],
        },
        {
          controlOffset: { x: -4, y: 16 },
          delta: { x: 0, y: 30 },
          easing: "smooth",
          end: 8,
          kind: "create-motion",
          start: 7,
          targetObjectIds: ["equation_1"],
        },
      ],
    } satisfies EditSuggestionOperation;

    const result = validateSuggestionDraft(operation, {
      capturedPlayhead: 5,
      hasNextScene: false,
      origin: "fixture",
      proposedState: evaluateWorkingState(createFixtureWorkingState()),
      selectedObjectIds: ["equation_1"],
      transactionId: "sequential-motion-draft",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid" || result.operation.kind !== "edit-program") return;
    expect(result.operation.operations).toEqual(operation.operations);
    expect(
      result.record.program.operations.flatMap((entry) =>
        entry.kind === "CreateMotion"
          ? [
              {
                controlOffset: entry.controlOffset,
                delta: entry.delta,
                interval: entry.interval,
              },
            ]
          : [],
      ),
    ).toEqual([
      {
        controlOffset: { x: 8, y: -12 },
        delta: { x: 40, y: 0 },
        interval: { end: 6, start: 5 },
      },
      {
        controlOffset: { x: -4, y: 16 },
        delta: { x: 0, y: 30 },
        interval: { end: 8, start: 7 },
      },
    ]);
  });

  it("does not invent an origin position for an entity missing from the projection", () => {
    expect(projectedPositions([], ["missing"])).toEqual({
      kind: "invalid",
      message: "The projected position for missing is unavailable.",
    });
  });

  it("rejects direct movement when the imported source position is only approximate", () => {
    const entity = projectProposedState(evaluateWorkingState(createFixtureWorkingState()), 5).canvas.entities[0];
    expect(entity).toBeDefined();
    if (!entity) return;
    const reason = "Position depends on a runtime move_to expression.";

    expect(
      projectedPositions(
        [
          {
            ...entity,
            geometry: { ...entity.geometry, position: { kind: "unknown", reason } },
          },
        ],
        [entity.id],
      ),
    ).toEqual({
      kind: "invalid",
      message: `Studio cannot move ${entity.id} safely: ${reason}`,
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
    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );
    expect(
      projectProposedState(proposed, 5).canvas.entities.find((entity) => entity.id === "equation_1")?.position,
    ).toEqual({ x: before.position.x + 100, y: before.position.y + 40 });
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
    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );
    expect(
      projectProposedState(proposed, 5).canvas.entities.find((entity) => entity.id === "equation_1")?.scale,
    ).toBeCloseTo(1.5);
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
    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );

    expect(
      projectProposedState(proposed, 5).canvas.entities.find((entity) => entity.id === "equation_1")?.scale,
    ).toBeCloseTo(1);
    expect(
      projectProposedState(proposed, 6).canvas.entities.find((entity) => entity.id === "equation_1")?.scale,
    ).toBeCloseTo(1.5);
    expect(
      projectProposedState(proposed, 7).canvas.entities.find((entity) => entity.id === "equation_1")?.scale,
    ).toBeCloseTo(2);
  });

  it("projects Rectangle dimensions and its anchored center from one resize operation", () => {
    const validation = createDirectManipulationResizeProgram({
      capturedPlayhead: 5,
      entityId: "proof_box",
      from: { dimensions: { height: 2, width: 4 }, position: { x: 320, y: 147 } },
      interval: { end: 5, start: 5 },
      scale: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shape: "rectangle",
      to: { dimensions: { height: 3, width: 6 }, position: { x: 340, y: 157 } },
      transactionId: "rectangle-geometry",
    });
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    const rectangle = projectProposedState(proposed, 5).canvas.entities.find((entity) => (
      entity.id === "proof_box"
    ));

    expect(rectangle?.geometry.dimensions).toEqual({
      kind: "known",
      value: { height: 3, width: 6 },
    });
    expect(rectangle?.position).toEqual({ x: 340, y: 157 });
  });

  it("interpolates shape dimensions during an animated resize", () => {
    const validation = createDirectManipulationResizeProgram({
      capturedPlayhead: 5,
      entityId: "proof_box",
      from: { dimensions: { height: 2, width: 4 }, position: { x: 320, y: 147 } },
      interval: { end: 7, start: 5 },
      scale: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shape: "rectangle",
      to: { dimensions: { height: 4, width: 8 }, position: { x: 340, y: 167 } },
      transactionId: "animated-rectangle-geometry",
    });
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    const rectangle = projectProposedState(proposed, 6).canvas.entities.find((entity) => (
      entity.id === "proof_box"
    ));

    expect(rectangle?.geometry.dimensions).toEqual({
      kind: "known",
      value: { height: 3, width: 6 },
    });
    expect(rectangle?.position).toEqual({ x: 330, y: 157 });
  });
});
