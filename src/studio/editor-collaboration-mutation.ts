import type { EditorEditMutationV1 } from "../collaboration/editor-edit-mutation";
import type { AppliedProgramMutation } from "./editor-session-store";

function replaceMutation(
  mutation: Extract<AppliedProgramMutation, { kind: "replace" }>,
  direction: "apply" | "undo",
): EditorEditMutationV1 {
  return {
    kind: "replace",
    program: direction === "apply" ? mutation.value.program : mutation.previous.program,
    targetTransactionId: mutation.previous.program.transactionId,
  };
}

/** Projects a local applied change onto the immutable collaborative event log. */
export function collaborationMutationForApplyV1(mutation: AppliedProgramMutation): EditorEditMutationV1 {
  return mutation.kind === "append"
    ? { kind: "append", program: mutation.value.program }
    : replaceMutation(mutation, "apply");
}

/** Undo appends an inverse event; it never rewrites collaborative history. */
export function collaborationMutationForUndoV1(mutation: AppliedProgramMutation): EditorEditMutationV1 {
  return mutation.kind === "append"
    ? {
        kind: "remove",
        program: mutation.value.program,
        targetTransactionId: mutation.value.program.transactionId,
      }
    : replaceMutation(mutation, "undo");
}

export const collaborationMutationForRedoV1 = collaborationMutationForApplyV1;
