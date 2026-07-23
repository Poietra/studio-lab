import { describe, expect, it } from "vitest";

import type { CreateCameraFocusSuggestion } from "../ai/edit-suggestions";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import { programExecutionCapabilities } from "./operation-registry";
import {
  canonicalizeSuggestionProgram,
  createDirectManipulationModifyMotionProgram,
  createDirectManipulationMotionProgram,
  createDirectManipulationPositionProgram,
  createDirectManipulationScaleProgram,
} from "./suggestion-program";
import { applyStagedPrograms, stageProgram } from "./transactions";

function cameraFocusSuggestion(): CreateCameraFocusSuggestion {
  return {
    anchor: { kind: "playhead", referenceSeconds: 4.42 },
    easing: "smooth",
    emphasisScale: 1.12,
    end: 5.92,
    kind: "create-camera-focus",
    start: 4.42,
    targetObjectIds: ["equation_1"],
    zoomScale: 1.35,
  };
}

describe("EditProgram execution capabilities", () => {
  it("keeps CameraFocus previewable but blocks Apply before source lowering", () => {
    const validation = canonicalizeSuggestionProgram(cameraFocusSuggestion(), {
      capturedPlayhead: 4.42,
      origin: "remote-model",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "camera-focus-contract",
    });

    expect(validation.kind).toBe("valid");
    expect(programExecutionCapabilities(validation.program)).toEqual({
      apply: "blocked",
      applyBlocker: "CameraFocus can be previewed, but ChangeCamera cannot yet be lowered back to Manim source.",
      lowering: "illustrative",
      preview: "supported",
    });
    expect(validation.issues).toContainEqual(expect.objectContaining({
      code: "lowering-unsupported",
      operationId: expect.stringContaining("camera-zoom"),
      severity: "warning",
    }));

    const record = programRecord(validation.program, validation);
    const preview = evaluateWorkingState(createFixtureWorkingState({ stagedPrograms: [record] }));
    expect(projectProposedState(preview, 5.92).camera.scale).toBeCloseTo(1.35);
    const applied = applyStagedPrograms(stageProgram(createFixtureWorkingState(), record));
    expect(applied.appliedPrograms).toHaveLength(0);
    expect(applied.stagedPrograms).toEqual([record]);
  });

  it("keeps ModifyMotion previewable but blocks Apply before source lowering", () => {
    const validation = createDirectManipulationModifyMotionProgram({
      capturedPlayhead: 5,
      controlOffset: { x: 0, y: -32 },
      interval: { end: 7, start: 4 },
      motionId: "move-equation",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "modify-motion-contract",
    });

    expect(validation.kind).toBe("valid");
    expect(programExecutionCapabilities(validation.program)).toEqual({
      apply: "blocked",
      applyBlocker: "ModifyMotion has no truthful source lowering yet. It can be previewed, but editing an existing motion path cannot be applied.",
      lowering: "illustrative",
      preview: "supported",
    });
    const record = programRecord(validation.program, validation);
    const preview = evaluateWorkingState(createFixtureWorkingState({ stagedPrograms: [record] }));
    const equation = projectProposedState(preview, 5.5).canvas.entities.find((entity) => entity.id === "equation_1");
    expect(equation?.position).toEqual({ x: 352, y: 120 });
    const applied = applyStagedPrograms(stageProgram(createFixtureWorkingState(), record));
    expect(applied.appliedPrograms).toHaveLength(0);
    expect(applied.stagedPrograms).toEqual([record]);
  });

  it("preserves supported motion, position, and scale authoring paths", () => {
    const validations = [
      createDirectManipulationMotionProgram({
        capturedPlayhead: 8,
        controlOffset: { x: 0, y: -24 },
        delta: { x: 96, y: 0 },
        interval: { end: 9, start: 8 },
        scene: STUDIO_FIXTURE_SCENE,
        targetEntityIds: ["equation_1"],
        transactionId: "supported-motion",
      }),
      createDirectManipulationPositionProgram({
        capturedPlayhead: 8,
        delta: { x: 8, y: 4 },
        positions: { equation_1: { x: 384, y: 146 } },
        scene: STUDIO_FIXTURE_SCENE,
        start: 8,
        targetEntityIds: ["equation_1"],
        transactionId: "supported-position",
      }),
      createDirectManipulationScaleProgram({
        capturedPlayhead: 8,
        interval: { end: 9, start: 8 },
        scales: { equation_1: { from: 1, to: 1.25 } },
        scene: STUDIO_FIXTURE_SCENE,
        targetEntityIds: ["equation_1"],
        transactionId: "supported-scale",
      }),
    ];

    expect(validations.every((validation) => validation.kind === "valid")).toBe(true);
    expect(validations.map((validation) => programExecutionCapabilities(validation.program).apply)).toEqual([
      "supported",
      "supported",
      "supported",
    ]);
  });
});
