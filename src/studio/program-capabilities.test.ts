import { describe, expect, it } from "vitest";

import type { CreateCameraFocusSuggestion } from "../ai/edit-suggestions";
import { STUDIO_FIXTURE_SCENE, validateMotionProgramFixture } from "./fixture";
import { operationAccess, operationExecutionCapabilities, programExecutionCapabilities } from "./operation-registry";
import type { CanonicalEditOperation } from "./operations";
import { validateAndScheduleProgram } from "./program-validation";
import {
  canonicalizeSuggestionProgram,
  createDirectManipulationPositionProgram,
  createDirectManipulationResizeProgram,
  createDirectManipulationScaleProgram,
} from "./suggestion-program";

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

function resizeWithConcurrentMotion(
  testId: string,
  input: Readonly<{ motionEasing: "linear" | "smooth"; motionEnd: number; resizeEnd: number }>,
) {
  const resize = createDirectManipulationResizeProgram({
    capturedPlayhead: 5,
    entityId: "proof_box",
    from: { dimensions: { height: 2, width: 4 }, position: { x: 320, y: 147 } },
    interval: { end: input.resizeEnd, start: 5 },
    scale: 1,
    scene: STUDIO_FIXTURE_SCENE,
    shape: "rectangle",
    to: { dimensions: { height: 3, width: 6 }, position: { x: 320, y: 147 } },
    transactionId: `${testId}-resize`,
  });
  const motion = validateMotionProgramFixture({
    capturedPlayhead: 5,
    controlOffset: { x: 0, y: 0 },
    delta: { x: 40, y: 0 },
    interval: { end: input.motionEnd, start: 5 },
    scene: STUDIO_FIXTURE_SCENE,
    targetEntityIds: ["arrow_1"],
    transactionId: `${testId}-motion`,
  });
  const operations: CanonicalEditOperation[] = [
    ...resize.program.operations,
    ...motion.program.operations.map((operation) =>
      operation.kind === "CreateMotion" ? { ...operation, easing: input.motionEasing } : operation,
    ),
  ];
  return validateAndScheduleProgram(
    {
      ...resize.program,
      intentCount: 2,
      operations,
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
    },
    STUDIO_FIXTURE_SCENE,
  );
}

describe("EditProgram execution capabilities", () => {
  it("keeps DrawIn on the client-side path-trim authority", () => {
    const operation: CanonicalEditOperation = {
      dependsOn: ["tx:draw/operation:create"],
      easing: "smooth",
      entityId: "tx:draw/entity:line",
      id: "tx:draw/operation:draw-in",
      interval: { end: 1, start: 0 },
      kind: "DrawIn",
      provenance: { evidence: [], origin: "direct-manipulation" },
    };

    expect(operationAccess(operation)).toEqual({
      reads: [{ channel: "pathTrim", entityId: operation.entityId }],
      writes: [{ channel: "pathTrim", entityId: operation.entityId }],
    });
    expect(operationExecutionCapabilities(operation)).toEqual({
      apply: "supported",
      applyBlocker: null,
      lowering: "unsupported",
    });
  });

  it("supports only finite numeric opacity values between zero and one", () => {
    const validateOpacity = (value: number | string) => {
      const operation: CanonicalEditOperation = {
        dependsOn: [],
        entityId: "equation_1",
        id: `opacity-${String(value)}`,
        interval: { end: 0, start: 0 },
        key: "appearance",
        kind: "SetProperty",
        provenance: { evidence: ["opacity control"], origin: "direct-manipulation" },
        value,
      };
      return validateAndScheduleProgram(
        {
          anchor: {
            capturedPlayhead: 0,
            evidence: ["source time zero"],
            resolvedSeconds: 0,
            source: { kind: "absolute", seconds: 0 },
          },
          intentCount: 1,
          loweringStatus: "supported",
          operations: [operation],
          provenance: { evidence: ["opacity control"], origin: "direct-manipulation" },
          requestedExecution: "parallel",
          schedule: { edges: [], mode: "parallel", order: [operation.id] },
          transactionId: `opacity-${String(value)}`,
          version: 1,
        },
        STUDIO_FIXTURE_SCENE,
      );
    };

    for (const value of [0, 0.25, 1]) {
      const validation = validateOpacity(value);
      expect(validation.kind).toBe("valid");
      expect(validation.program.loweringStatus).toBe("supported");
      expect(programExecutionCapabilities(validation.program).apply).toBe("supported");
    }
    for (const value of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "0.5"]) {
      const validation = validateOpacity(value);
      expect(validation.kind).toBe("invalid");
      expect(validation.issues).toContainEqual(expect.objectContaining({ field: "value" }));
      if (typeof value !== "number" || Number.isFinite(value)) {
        expect(validation.issues).toContainEqual(
          expect.objectContaining({ field: "value", message: expect.stringMatching(/between zero and one/i) }),
        );
      }
    }
  });

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
    });
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: "lowering-unsupported",
        operationId: expect.stringContaining("camera-zoom"),
        severity: "warning",
      }),
    );
  });

  it("preserves supported motion, position, and scale authoring paths", () => {
    const validations = [
      validateMotionProgramFixture({
        capturedPlayhead: 8,
        controlOffset: { x: 0, y: -24 },
        delta: { x: 0, y: 0 },
        interval: { end: 9, start: 8 },
        scene: STUDIO_FIXTURE_SCENE,
        targetEntityIds: ["equation_1"],
        transactionId: "supported-curved-loop",
      }),
      validateMotionProgramFixture({
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
      "supported",
    ]);
  });

  it("blocks a shape resize whose concurrent source animation has a different end", () => {
    const validation = resizeWithConcurrentMotion("mismatched-end", {
      motionEasing: "smooth",
      motionEnd: 7,
      resizeEnd: 6,
    });

    expect(validation.kind).toBe("valid");
    expect(validation.program.loweringStatus).toBe("illustrative");
    expect(programExecutionCapabilities(validation.program)).toMatchObject({
      apply: "blocked",
      applyBlocker: "Concurrent source animations must share one interval.",
    });
  });

  it("rejects a shape resize whose concurrent source animation has different easing", () => {
    const validation = resizeWithConcurrentMotion("mismatched-easing", {
      motionEasing: "linear",
      motionEnd: 6,
      resizeEnd: 6,
    });

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: "lowering-unsupported",
        field: "easing",
        message: expect.stringMatching(/must share one easing function/i),
        severity: "error",
      }),
    );
  });

  it("treats concurrent scale and shape resize on one entity as a dependency conflict", () => {
    const resize = createDirectManipulationResizeProgram({
      capturedPlayhead: 5,
      entityId: "proof_box",
      from: { dimensions: { height: 2, width: 4 }, position: { x: 320, y: 147 } },
      interval: { end: 6, start: 5 },
      scale: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shape: "rectangle",
      to: { dimensions: { height: 3, width: 6 }, position: { x: 320, y: 147 } },
      transactionId: "resize-scale-conflict-resize",
    });
    const scale = createDirectManipulationScaleProgram({
      capturedPlayhead: 5,
      interval: { end: 6, start: 5 },
      scales: { proof_box: { from: 1, to: 2 } },
      scene: STUDIO_FIXTURE_SCENE,
      targetEntityIds: ["proof_box"],
      transactionId: "resize-scale-conflict-scale",
    });
    const operations = [...resize.program.operations, ...scale.program.operations];
    const validation = validateAndScheduleProgram(
      {
        ...resize.program,
        intentCount: 2,
        operations,
        requestedExecution: "parallel",
        schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
      },
      STUDIO_FIXTURE_SCENE,
    );
    const resizeOperation = operations.find((operation) => operation.kind === "ResizeEntity");
    const scaleOperation = operations.find(
      (operation) => operation.kind === "AnimateProperty" && operation.key === "scale",
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: "parallel-conflict", field: "execution", severity: "error" }),
    );
    expect(validation.program.schedule.edges).toContainEqual({
      from: scaleOperation?.id,
      reason: "read-after-write",
      to: resizeOperation?.id,
    });
  });

  it("blocks Program schedules that the source lowerer cannot emit", () => {
    const position = createDirectManipulationPositionProgram({
      capturedPlayhead: 8,
      delta: { x: 8, y: 4 },
      positions: { equation_1: { x: 384, y: 146 } },
      scene: STUDIO_FIXTURE_SCENE,
      start: 8,
      targetEntityIds: ["equation_1"],
      transactionId: "position-with-wait",
    });
    const wait: CanonicalEditOperation = {
      dependsOn: [],
      eventKind: "wait",
      id: "tx:position-with-wait/operation:wait",
      interval: { end: 9, start: 8 },
      kind: "InsertTimelineEvent",
      label: "wait",
      provenance: { evidence: [], origin: "fixture" },
    };
    const operations = [...position.program.operations, wait];
    const validation = validateAndScheduleProgram(
      {
        ...position.program,
        intentCount: 2,
        operations,
        requestedExecution: "parallel",
        schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
      },
      STUDIO_FIXTURE_SCENE,
    );

    expect(validation.kind).toBe("valid");
    expect(validation.program.loweringStatus).toBe("illustrative");
    expect(programExecutionCapabilities(validation.program).applyBlocker).toBe(
      "An inserted wait must occupy its own source interval.",
    );
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: "lowering-unsupported",
        message: "An inserted wait must occupy its own source interval.",
        severity: "warning",
      }),
    );
  });

  it("blocks a later operation that overlaps source time consumed by an animation", () => {
    const first = validateMotionProgramFixture({
      capturedPlayhead: 8,
      controlOffset: { x: 0, y: 0 },
      delta: { x: 40, y: 0 },
      interval: { end: 10, start: 8 },
      scene: STUDIO_FIXTURE_SCENE,
      targetEntityIds: ["equation_1"],
      transactionId: "overlap-first",
    });
    const second = validateMotionProgramFixture({
      capturedPlayhead: 9,
      controlOffset: { x: 0, y: 0 },
      delta: { x: 20, y: 0 },
      interval: { end: 10, start: 9 },
      scene: STUDIO_FIXTURE_SCENE,
      targetEntityIds: ["equation_1"],
      transactionId: "overlap-second",
    });
    const operations = [...first.program.operations, ...second.program.operations];
    const validation = validateAndScheduleProgram(
      {
        ...first.program,
        intentCount: 2,
        operations,
        requestedExecution: "sequence",
        schedule: { edges: [], mode: "sequence", order: operations.map((operation) => operation.id) },
      },
      STUDIO_FIXTURE_SCENE,
    );

    expect(validation.kind).toBe("valid");
    expect(programExecutionCapabilities(validation.program)).toMatchObject({
      apply: "blocked",
      applyBlocker: "Operation at 9.000s overlaps source time already lowered through 10.000s.",
      lowering: "illustrative",
    });
  });
});
