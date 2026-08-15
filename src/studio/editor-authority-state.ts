import { parseAuthoritativeEditorProgramsV1 } from "../collaboration/editor-edit-mutation";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import {
  type ProjectStudioMathTexTransformCompiler,
  type ProjectStudioTimelineCompiler,
  projectStudioMathTexTransform,
} from "../engine/scene-authoring";
import type { EditorProgramRecord } from "./editor-session-store";
import { evaluateWorkingState } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene } from "./imported-workspace";
import { programExecutionCapabilities } from "./operation-registry";
import { type CanonicalEditProgram, isSceneDurationOperation } from "./operations";
import {
  buildStudioMathTexTransformProjectionCommand,
  isExactStudioMathTexTransformProgramBatch,
  studioMathTexTransformProjectionStudioEntities,
} from "./scene-authoring-wire";
import { isSceneDurationProgramBatch, projectTimelineProgramBatch } from "./timeline-projection";
import { selectMathTexTransformProjection } from "./workspace-projection";

export class EditorMathTexTransformAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorMathTexTransformAdmissionError";
  }
}

export class EditorTimelineAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorTimelineAdmissionError";
  }
}

export function editorProgramsMatchAuthorityV1(
  local: readonly EditorProgramRecord[],
  authoritative: readonly CanonicalEditProgram[],
) {
  return canonicalJsonV1(local.map((record) => record.program)) === canonicalJsonV1(authoritative);
}

/**
 * Revalidates a wire projection against the selected imported Scene. The
 * durable authority owns canonical Programs, while validation and optional
 * authoring metadata remain browser concerns.
 */
export async function materializeAuthoritativeEditorProgramsV1(
  scene: ManimWorkspaceScene,
  current: readonly EditorProgramRecord[],
  programValues: unknown,
  timelineCompiler?: ProjectStudioTimelineCompiler,
  mathTexTransformCompiler: ProjectStudioMathTexTransformCompiler = projectStudioMathTexTransform,
): Promise<readonly EditorProgramRecord[]> {
  const programs = parseAuthoritativeEditorProgramsV1(programValues);
  const seeds = programs.map((program) => ({
    program,
    validation: { issues: [], status: "valid" as const },
  }));
  const operations = programs.flatMap((program) => program.operations);
  const hasMathTexTransform = operations.some(({ kind }) => kind === "TransformContent");
  const isExactMathTexTransform = isExactStudioMathTexTransformProgramBatch(programs);
  if (hasMathTexTransform && !isExactMathTexTransform) {
    throw new TypeError(
      "The authoritative Editor projection may contain TransformContent only as an exact Rust MathTex transform batch.",
    );
  }
  const sceneDurationOperationCount = operations.filter(isSceneDurationOperation).length;
  if (sceneDurationOperationCount > 0 && sceneDurationOperationCount < operations.length) {
    throw new EditorTimelineAdmissionError(
      "The authoritative Editor projection must not mix Scene duration and other Programs.",
    );
  }
  if (sceneDurationOperationCount > 0 && !isSceneDurationProgramBatch(programs)) {
    throw new EditorTimelineAdmissionError(
      "The authoritative Editor projection requires one Scene duration operation per Program.",
    );
  }

  const timelineProjection = isSceneDurationProgramBatch(programs)
    ? await projectTimelineProgramBatch(scene.runtimeSceneState.duration, programs, timelineCompiler).catch((error) => {
        throw new EditorTimelineAdmissionError(
          `The Rust timeline admission rejected the authoritative Editor projection: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
    : null;
  const mathTexTransformProjection = isExactMathTexTransform
    ? await mathTexTransformCompiler(
        buildStudioMathTexTransformProjectionCommand({
          baseDuration: scene.runtimeSceneState.duration,
          programs,
          studioEntities: studioMathTexTransformProjectionStudioEntities(scene.runtimeSceneState),
        }),
      )
        .then((projection) => {
          const correlated = selectMathTexTransformProjection(scene.runtimeSceneState.duration, programs, projection);
          if (!correlated) throw new TypeError("The Rust MathTex transform projection is missing.");
          return correlated;
        })
        .catch((error) => {
          throw new EditorMathTexTransformAdmissionError(
            `The Rust MathTex transform admission rejected the authoritative Editor projection: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
    : null;
  const evaluatedPrograms =
    timelineProjection?.programs.map((program) => ({
      program,
      validation: { issues: [], status: "valid" as const },
    })) ??
    (mathTexTransformProjection
      ? seeds
      : evaluateWorkingState(
          importedWorkingState(scene, {
            appliedPrograms: seeds,
            playhead: 0,
            selection: [],
            stagedPrograms: [],
          }),
        ).programs);
  if (
    evaluatedPrograms.length !== programs.length ||
    evaluatedPrograms.some(
      (record) =>
        record.validation.status !== "valid" || programExecutionCapabilities(record.program).apply !== "supported",
    )
  ) {
    throw new TypeError("The authoritative Editor projection is invalid for the selected Scene source.");
  }
  const currentByTransaction = new Map(current.map((record) => [record.program.transactionId, record] as const));
  return Object.freeze(
    programs.map((authoritativeProgram, index) => {
      const local = currentByTransaction.get(authoritativeProgram.transactionId);
      const exactLocal =
        local && canonicalJsonV1(local.program) === canonicalJsonV1(authoritativeProgram) ? local : null;
      const evaluated = evaluatedPrograms[index]!;
      return Object.freeze({
        ...(exactLocal?.editorMetadata ? { editorMetadata: exactLocal.editorMetadata } : undefined),
        program: authoritativeProgram,
        validation: evaluated.validation,
      });
    }),
  );
}
