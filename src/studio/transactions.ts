import type { ProgramRecord, WorkingState } from "./model";
import { programExecutionCapabilities } from "./operation-registry";

export type AppliedProgramReplacementResult<TRecord extends ProgramRecord = ProgramRecord> = Readonly<{
  index: number;
  kind: "replaced";
  previous: TRecord;
  programs: readonly TRecord[];
}> | Readonly<{
  kind: "rejected";
  reason: string;
}>;

export function replaceAppliedProgram<TRecord extends ProgramRecord>(
  programs: readonly TRecord[],
  transactionId: string,
  replacement: TRecord,
): AppliedProgramReplacementResult<TRecord> {
  const matchingIndexes = programs.flatMap((record, index) => (
    record.program.transactionId === transactionId ? [index] : []
  ));
  if (matchingIndexes.length === 0) {
    return { kind: "rejected", reason: `Applied Program ${transactionId} was not found.` };
  }
  if (matchingIndexes.length > 1) {
    return { kind: "rejected", reason: `Applied Program ${transactionId} is ambiguous.` };
  }
  if (replacement.program.transactionId !== transactionId) {
    return { kind: "rejected", reason: "A replacement must preserve the original transaction identity." };
  }
  if (replacement.validation.status !== "valid") {
    return { kind: "rejected", reason: "Only a valid Program can replace an applied transaction." };
  }
  const index = matchingIndexes[0];
  return {
    index,
    kind: "replaced",
    previous: programs[index],
    programs: programs.map((record, candidateIndex) => (
      candidateIndex === index ? replacement : record
    )),
  };
}

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
