import { z } from "zod";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import { APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1 } from "../studio/operations";
import { sceneEditSchema as canonicalEditProgramSchemaV1, type SceneEdit } from "../studio/scene-edit-contract";

export const MAX_APPLIED_EDITOR_PROGRAMS_V1 = 32;

const editorTransactionIdSchemaV1 = z.string().min(1).max(160);
const strictCanonicalEditProgramSchemaV1 = canonicalEditProgramSchemaV1.strict();

export const editorEditMutationV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("append"),
      program: strictCanonicalEditProgramSchemaV1,
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace"),
      program: strictCanonicalEditProgramSchemaV1,
      targetTransactionId: editorTransactionIdSchemaV1,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove"),
      program: strictCanonicalEditProgramSchemaV1,
      targetTransactionId: editorTransactionIdSchemaV1,
    })
    .strict(),
]);

export type EditorEditMutationV1 =
  | Readonly<{ kind: "append"; program: SceneEdit }>
  | Readonly<{
      kind: "replace";
      program: SceneEdit;
      targetTransactionId: string;
    }>
  | Readonly<{
      kind: "remove";
      program: SceneEdit;
      targetTransactionId: string;
    }>;

export type EditorEditMutationConflictReasonV1 =
  | "evidence-mismatch"
  | "program-limit"
  | "source-order-conflict"
  | "target-not-found"
  | "transaction-exists"
  | "transaction-id-mismatch";

export type EditorEditMutationApplyResultV1 =
  | Readonly<{
      kind: "applied";
      programs: readonly SceneEdit[];
    }>
  | Readonly<{
      kind: "conflict";
      reason: EditorEditMutationConflictReasonV1;
    }>;

export function parseEditorEditMutationV1(value: unknown): EditorEditMutationV1 {
  return editorEditMutationV1Schema.parse(value) as EditorEditMutationV1;
}

function canonicalProgramV1(value: unknown) {
  return strictCanonicalEditProgramSchemaV1.parse(value) as SceneEdit;
}

export function parseAuthoritativeEditorProgramsV1(value: unknown): readonly SceneEdit[] {
  if (!Array.isArray(value)) {
    throw new TypeError("The authoritative Editor Program projection must be an array.");
  }
  if (value.length > MAX_APPLIED_EDITOR_PROGRAMS_V1) {
    throw new TypeError("The authoritative Editor Program list exceeds its bounded capacity.");
  }
  const transactionIds = new Set<string>();
  let previousAnchor: number | null = null;
  return value.map((entry) => {
    const program = canonicalProgramV1(entry);
    if (transactionIds.has(program.transactionId)) {
      throw new TypeError("The authoritative Editor Program list contains a duplicate transaction identity.");
    }
    if (
      previousAnchor !== null &&
      program.anchor.resolvedSeconds < previousAnchor - APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1
    ) {
      throw new TypeError("The authoritative Editor Program list is outside canonical source order.");
    }
    transactionIds.add(program.transactionId);
    previousAnchor = program.anchor.resolvedSeconds;
    return program;
  });
}

function sourceOrderConflictV1(programs: readonly SceneEdit[], index: number, anchor: number) {
  const previousAnchor = programs[index - 1]?.anchor.resolvedSeconds;
  if (previousAnchor !== undefined && anchor < previousAnchor - APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1) {
    return true;
  }
  const nextAnchor = programs[index + 1]?.anchor.resolvedSeconds;
  return nextAnchor !== undefined && anchor > nextAnchor + APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1;
}

/**
 * Applies one committed mutation without guessing at semantic conflicts.
 * Invalid mutation payloads and impossible authoritative input are corruption
 * and throw; expected concurrent-edit conflicts are returned as values.
 */
export function applyEditorEditMutationV1(
  currentPrograms: readonly SceneEdit[],
  mutationValue: EditorEditMutationV1,
): EditorEditMutationApplyResultV1 {
  const programs = parseAuthoritativeEditorProgramsV1(currentPrograms);
  const mutation = parseEditorEditMutationV1(mutationValue);

  if (mutation.kind === "append") {
    if (programs.some((program) => program.transactionId === mutation.program.transactionId)) {
      return { kind: "conflict", reason: "transaction-exists" };
    }
    if (programs.length >= MAX_APPLIED_EDITOR_PROGRAMS_V1) {
      return { kind: "conflict", reason: "program-limit" };
    }
    const previousAnchor = programs.at(-1)?.anchor.resolvedSeconds;
    if (
      previousAnchor !== undefined &&
      mutation.program.anchor.resolvedSeconds < previousAnchor - APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1
    ) {
      return { kind: "conflict", reason: "source-order-conflict" };
    }
    return { kind: "applied", programs: [...programs, mutation.program] };
  }

  const targetIndex = programs.findIndex((program) => program.transactionId === mutation.targetTransactionId);
  if (targetIndex < 0) return { kind: "conflict", reason: "target-not-found" };
  const target = programs[targetIndex]!;

  if (mutation.kind === "remove") {
    // Exact canonical JSON equality is stronger than comparing its byte length
    // and SHA-256 digest, while remaining synchronous and browser-safe.
    if (canonicalJsonV1(target) !== canonicalJsonV1(mutation.program)) {
      return { kind: "conflict", reason: "evidence-mismatch" };
    }
    return {
      kind: "applied",
      programs: [...programs.slice(0, targetIndex), ...programs.slice(targetIndex + 1)],
    };
  }

  if (mutation.program.transactionId !== mutation.targetTransactionId) {
    return { kind: "conflict", reason: "transaction-id-mismatch" };
  }
  if (sourceOrderConflictV1(programs, targetIndex, mutation.program.anchor.resolvedSeconds)) {
    return { kind: "conflict", reason: "source-order-conflict" };
  }
  return {
    kind: "applied",
    programs: programs.map((program, index) => (index === targetIndex ? mutation.program : program)),
  };
}
