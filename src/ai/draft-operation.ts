import type {
  EditProgramStep,
  EditSuggestionLeafOperation,
  EditSuggestionOperation,
  SuggestionTimeAnchor,
} from "./edit-suggestions";

type WithoutAnchor<T> = T extends unknown ? Omit<T, "anchor"> : never;

export type EditableSuggestionStep = WithoutAnchor<EditSuggestionLeafOperation>;

function withoutAnchor(operation: EditSuggestionLeafOperation): EditableSuggestionStep {
  const { anchor: _anchor, ...step } = operation;
  return step;
}

export function editableSuggestionSteps(operation: EditSuggestionOperation): readonly EditableSuggestionStep[] {
  return operation.kind === "edit-program" ? operation.operations : [withoutAnchor(operation)];
}

function anchorAt(seconds: number): SuggestionTimeAnchor {
  return { kind: "absolute", seconds };
}

function cascadeSequence(steps: readonly EditProgramStep[], changedIndex: number) {
  const next = steps.map((step) => ({ ...step })) as EditProgramStep[];
  for (let index = changedIndex + 1; index < next.length; index += 1) {
    const previous = next[index - 1];
    const current = next[index];
    const duration = current.end - current.start;
    next[index] = { ...current, end: previous.end + duration, start: previous.end } as EditProgramStep;
  }
  return next;
}

export function replaceSuggestionStep(
  operation: EditSuggestionOperation,
  index: number,
  step: EditableSuggestionStep,
): EditSuggestionOperation {
  if (operation.kind !== "edit-program") {
    const timingChanged = operation.start !== step.start || operation.end !== step.end;
    return {
      ...step,
      anchor: timingChanged ? anchorAt(step.start) : operation.anchor,
    } as EditSuggestionLeafOperation;
  }
  const current = operation.operations[index];
  const timingChanged = !current || current.start !== step.start || current.end !== step.end;
  const operations = operation.operations.map((candidate, candidateIndex) => (
    candidateIndex === index ? step as EditProgramStep : candidate
  ));
  if (!timingChanged) return { ...operation, operations };
  const scheduled = operation.execution === "sequence"
    ? cascadeSequence(operations, index)
    : operations.map((candidate) => ({
        ...candidate,
        end: step.end,
        start: step.start,
      })) as EditProgramStep[];
  return {
    ...operation,
    anchor: anchorAt(scheduled[0].start),
    operations: scheduled,
  };
}

export function changeSuggestionExecution(
  operation: EditSuggestionOperation,
  execution: "parallel" | "sequence",
): EditSuggestionOperation {
  if (operation.kind !== "edit-program" || operation.execution === execution) return operation;
  if (execution === "parallel") {
    const start = operation.operations[0].start;
    const end = Math.max(...operation.operations.map((step) => step.end));
    return {
      ...operation,
      execution,
      operations: operation.operations.map((step) => ({ ...step, end, start })) as EditProgramStep[],
    };
  }
  let cursor = operation.operations[0].start;
  return {
    ...operation,
    execution,
    operations: operation.operations.map((step) => {
      const duration = step.end - step.start;
      const scheduled = { ...step, end: cursor + duration, start: cursor } as EditProgramStep;
      cursor = scheduled.end;
      return scheduled;
    }),
  };
}
