import type { ProgramRecord, WorkingState } from "./model";
import { programExecutionCapabilities } from "./operation-registry";

export function stageProgram(workingState: WorkingState, record: ProgramRecord): WorkingState {
  return {
    ...workingState,
    stagedPrograms: [...workingState.stagedPrograms, record],
  };
}

export function applyStagedPrograms(workingState: WorkingState): WorkingState {
  if (workingState.stagedPrograms.length === 0) return workingState;
  const applicable = workingState.stagedPrograms.filter((record) => (
    record.validation.status === "valid"
    && programExecutionCapabilities(record.program).apply === "supported"
  ));
  if (applicable.length === 0) return workingState;
  const appliedRecords = new Set(applicable);
  return {
    ...workingState,
    appliedPrograms: [...workingState.appliedPrograms, ...applicable],
    stagedPrograms: workingState.stagedPrograms.filter((record) => !appliedRecords.has(record)),
  };
}

export function undoLastAppliedProgram(workingState: WorkingState): WorkingState {
  if (workingState.appliedPrograms.length === 0) return workingState;
  return {
    ...workingState,
    appliedPrograms: workingState.appliedPrograms.slice(0, -1),
  };
}
