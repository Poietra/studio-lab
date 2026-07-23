import type { ProgramRecord, WorkingState } from "./model";
import { programExecutionCapabilities } from "./operation-registry";

const SOURCE_ORDER_EPSILON = 0.0005;

export type AppliedProgramReplacementResult<TRecord extends ProgramRecord = ProgramRecord> = Readonly<{
  index: number;
  kind: "replaced";
  previous: TRecord;
  programs: readonly TRecord[];
}> | Readonly<{
  kind: "rejected";
  reason: string;
}>;

export type AppliedProgramAppendResult<TRecord extends ProgramRecord = ProgramRecord> = Readonly<{
  index: number;
  kind: "appended";
  programs: readonly TRecord[];
}> | Readonly<{
  kind: "rejected";
  reason: string;
}>;

export function appendAppliedProgram<TRecord extends ProgramRecord>(
  programs: readonly TRecord[],
  value: TRecord,
): AppliedProgramAppendResult<TRecord> {
  const previousAnchor = programs.at(-1)?.program.anchor.resolvedSeconds;
  const valueAnchor = value.program.anchor.resolvedSeconds;
  if (previousAnchor !== undefined && valueAnchor < previousAnchor - SOURCE_ORDER_EPSILON) {
    return {
      kind: "rejected",
      reason: `The new source anchor ${valueAnchor.toFixed(3)} is earlier than the latest applied Program at ${previousAnchor.toFixed(3)}. Apply Programs in source order or edit the existing transaction in place.`,
    };
  }
  return {
    index: programs.length,
    kind: "appended",
    programs: [...programs, value],
  };
}

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
  const replacementAnchor = replacement.program.anchor.resolvedSeconds;
  const previousAnchor = programs[index - 1]?.program.anchor.resolvedSeconds;
  if (previousAnchor !== undefined && replacementAnchor < previousAnchor - SOURCE_ORDER_EPSILON) {
    return {
      kind: "rejected",
      reason: `The replacement source anchor ${replacementAnchor.toFixed(3)} would cross the previous applied Program at ${previousAnchor.toFixed(3)}. Applied Program source order must remain stable.`,
    };
  }
  const nextAnchor = programs[index + 1]?.program.anchor.resolvedSeconds;
  if (nextAnchor !== undefined && replacementAnchor > nextAnchor + SOURCE_ORDER_EPSILON) {
    return {
      kind: "rejected",
      reason: `The replacement source anchor ${replacementAnchor.toFixed(3)} would cross the next applied Program at ${nextAnchor.toFixed(3)}. Applied Program source order must remain stable.`,
    };
  }
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
