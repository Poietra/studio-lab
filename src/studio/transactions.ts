import type { ProgramRecord } from "./model";
import { APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1 } from "./operations";

export type AppliedProgramReplacementResult<TRecord extends ProgramRecord = ProgramRecord> =
  | Readonly<{
      index: number;
      kind: "replaced";
      previous: TRecord;
      programs: readonly TRecord[];
    }>
  | Readonly<{
      kind: "rejected";
      reason: string;
    }>;

export type AppliedProgramAppendResult<TRecord extends ProgramRecord = ProgramRecord> =
  | Readonly<{
      index: number;
      kind: "appended";
      programs: readonly TRecord[];
    }>
  | Readonly<{
      kind: "rejected";
      reason: string;
    }>;

export function appendAppliedProgram<TRecord extends ProgramRecord>(
  programs: readonly TRecord[],
  value: TRecord,
): AppliedProgramAppendResult<TRecord> {
  const previousAnchor = programs.at(-1)?.program.anchor.resolvedSeconds;
  const valueAnchor = value.program.anchor.resolvedSeconds;
  if (previousAnchor !== undefined && valueAnchor < previousAnchor - APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1) {
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
  const matchingIndexes = programs.flatMap((record, index) =>
    record.program.transactionId === transactionId ? [index] : [],
  );
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
  if (previousAnchor !== undefined && replacementAnchor < previousAnchor - APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1) {
    return {
      kind: "rejected",
      reason: `The replacement source anchor ${replacementAnchor.toFixed(3)} would cross the previous applied Program at ${previousAnchor.toFixed(3)}. Applied Program source order must remain stable.`,
    };
  }
  const nextAnchor = programs[index + 1]?.program.anchor.resolvedSeconds;
  if (nextAnchor !== undefined && replacementAnchor > nextAnchor + APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1) {
    return {
      kind: "rejected",
      reason: `The replacement source anchor ${replacementAnchor.toFixed(3)} would cross the next applied Program at ${nextAnchor.toFixed(3)}. Applied Program source order must remain stable.`,
    };
  }
  return {
    index,
    kind: "replaced",
    previous: programs[index],
    programs: programs.map((record, candidateIndex) => (candidateIndex === index ? replacement : record)),
  };
}
