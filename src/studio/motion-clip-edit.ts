import {
  editableSuggestionSteps,
  replaceSuggestionStep,
  type EditableSuggestionStep,
} from "../ai/draft-operation";
import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import type { CanonicalEditProgram } from "./operations";

const MINIMUM_MOTION_DURATION = 0.1;

type MotionStep = Extract<EditableSuggestionStep, { kind: "create-motion" }>;

export type MotionClipEditResult = Readonly<{
  kind: "invalid";
  message: string;
}> | Readonly<{
  kind: "valid";
  operation: EditSuggestionOperation;
  stepIndex: number;
}>;

function editableMotionStep(
  program: CanonicalEditProgram,
  operation: EditSuggestionOperation,
  operationId: string,
): Readonly<{ index: number; step: MotionStep }> | null {
  const motionOrdinal = program.operations
    .filter((candidate) => candidate.kind === "CreateMotion")
    .findIndex((candidate) => candidate.id === operationId);
  if (motionOrdinal < 0) return null;
  const motionSteps = editableSuggestionSteps(operation).flatMap((step, index) => (
    step.kind === "create-motion" ? [{ index, step }] : []
  ));
  return motionSteps[motionOrdinal] ?? null;
}

export function appliedMotionClipReadOnlyReason(
  program: CanonicalEditProgram,
  operation: EditSuggestionOperation | null | undefined,
  operationId: string,
) {
  if (!operation) return "Editable Studio motion metadata is unavailable for this clip.";
  if (!editableMotionStep(program, operation, operationId)) {
    return "This motion clip cannot be matched safely to its editable Program step.";
  }
  return null;
}

export function retimeAppliedMotionClip(input: Readonly<{
  duration: number;
  operation: EditSuggestionOperation;
  operationId: string;
  program: CanonicalEditProgram;
  start: number;
}>): MotionClipEditResult {
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
      message: appliedMotionClipReadOnlyReason(input.program, input.operation, input.operationId)
        ?? "The motion clip is read-only.",
    };
  }
  if (input.operation.kind === "edit-program" && input.operation.execution === "sequence") {
    const previous = input.operation.operations[editable.index - 1];
    if (previous && input.start < previous.end - 0.0005) {
      return {
        kind: "invalid",
        message: "The motion clip would overlap the previous sequential step. Move it after that step or switch the Program to parallel execution.",
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
