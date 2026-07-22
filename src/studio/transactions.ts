import type { ProgramRecord, WorkingState } from "./model";

export function stageProgram(workingState: WorkingState, record: ProgramRecord): WorkingState {
  return {
    ...workingState,
    stagedPrograms: [...workingState.stagedPrograms, record],
  };
}

export function applyStagedPrograms(workingState: WorkingState): WorkingState {
  if (workingState.stagedPrograms.length === 0) return workingState;
  return {
    ...workingState,
    appliedPrograms: [...workingState.appliedPrograms, ...workingState.stagedPrograms],
    stagedPrograms: [],
  };
}

export function undoLastAppliedProgram(workingState: WorkingState): WorkingState {
  if (workingState.appliedPrograms.length === 0) return workingState;
  return {
    ...workingState,
    appliedPrograms: workingState.appliedPrograms.slice(0, -1),
  };
}
