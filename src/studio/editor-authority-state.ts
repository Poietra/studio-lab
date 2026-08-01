import { parseAuthoritativeEditorProgramsV1 } from "../collaboration/editor-edit-mutation";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import type { EditorProgramRecord } from "./editor-session-store";
import { evaluateWorkingState } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene } from "./imported-workspace";

/**
 * Revalidates a wire projection against the selected imported Scene. The
 * durable authority owns canonical Programs, while validation and optional
 * authoring metadata remain browser concerns.
 */
export function materializeAuthoritativeEditorProgramsV1(
  scene: ManimWorkspaceScene,
  current: readonly EditorProgramRecord[],
  programValues: unknown,
): readonly EditorProgramRecord[] {
  const programs = parseAuthoritativeEditorProgramsV1(programValues);
  const seeds = programs.map((program) => ({
    program,
    validation: { issues: [], status: "valid" as const },
  }));
  const evaluated = evaluateWorkingState(
    importedWorkingState(scene, {
      appliedPrograms: seeds,
      playhead: 0,
      selection: [],
      stagedPrograms: [],
    }),
  );
  if (
    evaluated.programs.length !== programs.length ||
    evaluated.programs.some((record) => record.validation.status !== "valid")
  ) {
    throw new TypeError("The authoritative Editor projection is invalid for the selected Scene source.");
  }
  const currentByTransaction = new Map(current.map((record) => [record.program.transactionId, record] as const));
  return Object.freeze(
    programs.map((program, index) => {
      const local = currentByTransaction.get(program.transactionId);
      const exactLocal = local && canonicalJsonV1(local.program) === canonicalJsonV1(program) ? local : null;
      const validation = evaluated.programs[index]!.validation;
      return Object.freeze({
        ...(exactLocal?.editorMetadata ? { editorMetadata: exactLocal.editorMetadata } : undefined),
        program,
        validation,
      });
    }),
  );
}
