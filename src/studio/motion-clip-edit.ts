import { type EditableSuggestionStep, editableSuggestionSteps, replaceSuggestionStep } from "../ai/draft-operation";
import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import type { Point } from "./model";
import type { SceneEdit } from "./scene-edit-contract";

const MINIMUM_MOTION_DURATION = 0.1;

type MotionStep = Extract<EditableSuggestionStep, { kind: "create-motion" }>;

export type MotionClipEditResult =
  | Readonly<{
      kind: "invalid";
      message: string;
    }>
  | Readonly<{
      kind: "valid";
      operation: EditSuggestionOperation;
      stepIndex: number;
    }>;

function editableMotionStep(
  program: SceneEdit,
  operation: EditSuggestionOperation,
  operationId: string,
): Readonly<{ index: number; step: MotionStep }> | null {
  const canonicalMotions = program.operations.filter((candidate) => candidate.kind === "CreateMotion");
  const matchingCanonicalMotions = canonicalMotions.flatMap((candidate, index) =>
    candidate.id === operationId ? [index] : [],
  );
  if (matchingCanonicalMotions.length !== 1) return null;
  const motionSteps = editableSuggestionSteps(operation).flatMap((step, index) =>
    step.kind === "create-motion" ? [{ index, step }] : [],
  );
  if (motionSteps.length !== canonicalMotions.length) return null;
  return motionSteps[matchingCanonicalMotions[0]] ?? null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function replaceMotionControlOffset(
  operation: EditSuggestionOperation,
  index: number,
  controlOffset: Point,
): EditSuggestionOperation {
  if (operation.kind === "create-motion") {
    return { ...operation, controlOffset };
  }
  if (operation.kind !== "edit-program") return operation;
  return {
    ...operation,
    operations: operation.operations.map((step, candidateIndex) =>
      candidateIndex === index && step.kind === "create-motion" ? { ...step, controlOffset } : step,
    ),
  };
}

export function appliedMotionClipReadOnlyReason(
  program: SceneEdit,
  operation: EditSuggestionOperation | null | undefined,
  operationId: string,
) {
  if (!operation) return "Editable Studio motion metadata is unavailable for this clip.";
  if (!editableMotionStep(program, operation, operationId)) {
    return "This motion clip cannot be matched safely to its editable Program step.";
  }
  return null;
}

export function retimeAppliedMotionClip(
  input: Readonly<{
    duration: number;
    operation: EditSuggestionOperation;
    operationId: string;
    program: SceneEdit;
    start: number;
  }>,
): MotionClipEditResult {
  if (!Number.isFinite(input.start) || !Number.isFinite(input.duration)) {
    return { kind: "invalid", message: "Motion clip timing must use finite values." };
  }
  if (input.start < 0 || input.duration < MINIMUM_MOTION_DURATION - 0.0005) {
    return {
      kind: "invalid",
      message: `Motion clips must start within the Scene and last at least ${MINIMUM_MOTION_DURATION} seconds.`,
    };
  }
  const editable = editableMotionStep(input.program, input.operation, input.operationId);
  if (!editable) {
    return {
      kind: "invalid",
      message:
        appliedMotionClipReadOnlyReason(input.program, input.operation, input.operationId) ??
        "The motion clip is read-only.",
    };
  }
  if (input.operation.kind === "edit-program" && input.operation.execution === "sequence") {
    const previous = input.operation.operations[editable.index - 1];
    if (previous && input.start < previous.end - 0.0005) {
      return {
        kind: "invalid",
        message:
          "The motion clip would overlap the previous sequential step. Move it after that step or switch the Program to parallel execution.",
      };
    }
  }
  const step = {
    ...editable.step,
    end: input.start + input.duration,
    start: input.start,
  } satisfies MotionStep;
  return {
    kind: "valid",
    operation: replaceSuggestionStep(input.operation, editable.index, step),
    stepIndex: editable.index,
  };
}

export function adjustAppliedMotionClipControl(
  input: Readonly<{
    delta: Point;
    operation: EditSuggestionOperation;
    operationId: string;
    program: SceneEdit;
  }>,
): MotionClipEditResult {
  if (!Number.isFinite(input.delta.x) || !Number.isFinite(input.delta.y)) {
    return { kind: "invalid", message: "Motion control changes must use finite values." };
  }
  const editable = editableMotionStep(input.program, input.operation, input.operationId);
  if (!editable) {
    return {
      kind: "invalid",
      message:
        appliedMotionClipReadOnlyReason(input.program, input.operation, input.operationId) ??
        "The motion clip is read-only.",
    };
  }
  const step = {
    ...editable.step,
    controlOffset: {
      x: clamp(editable.step.controlOffset.x + input.delta.x, -160, 160),
      y: clamp(editable.step.controlOffset.y + input.delta.y, -100, 100),
    },
  } satisfies MotionStep;
  return {
    kind: "valid",
    operation: replaceMotionControlOffset(input.operation, editable.index, step.controlOffset),
    stepIndex: editable.index,
  };
}
