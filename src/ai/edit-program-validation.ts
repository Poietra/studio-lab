import type {
  EditProgramStep,
  EditProgramSuggestion,
  MathTexSuggestionTarget,
  SuggestionInterval,
} from "./edit-suggestions";
import { editProgramSuggestionSchema } from "./edit-suggestion-schema";

type MotionStep = Extract<EditProgramStep, { kind: "create-motion" }>;
type TransformStep = Extract<EditProgramStep, { kind: "create-transform" }>;
type ExplanationStep = Extract<EditProgramStep, { kind: "create-explanation" }>;
type EquationStep = Extract<EditProgramStep, { kind: "create-equation" }>;
type ExplainedEquationStep = Extract<EditProgramStep, { kind: "create-explained-equation" }>;
type SceneTransitionStep = Extract<EditProgramStep, { kind: "create-scene-transition" }>;
type ScaleStep = Extract<EditProgramStep, { kind: "scale-objects" }>;
type DeleteStep = Extract<EditProgramStep, { kind: "delete-objects" }>;

type ProgramObject<TId extends string> = {
  id: TId;
  lifetimes: readonly SuggestionInterval[];
  type: string;
};

type EditProgramValidationContext<TId extends string> = {
  capturedPlayhead: number;
  objects: readonly ProgramObject<TId>[];
  sceneDuration: number;
  selectedObjectIds: readonly TId[];
};

export type NormalizedEditProgram<TId extends string> = {
  explanation: {
    index: number;
    step: ExplanationStep;
    targetObjectId: TId;
  } | null;
  motion: {
    index: number;
    step: MotionStep;
    targetObjectIds: readonly TId[];
  } | null;
  motions: readonly {
    index: number;
    step: MotionStep;
    targetObjectIds: readonly TId[];
  }[];
  operation: EditProgramSuggestion;
  start: number;
  touchedObjectIds: readonly TId[];
  transform: {
    index: number;
    sourceObjectId: TId;
    step: TransformStep;
  } | null;
  transforms: readonly {
    index: number;
    sourceObjectId: TId;
    step: TransformStep;
  }[];
};

export type EditProgramValidationResult<TId extends string> =
  | { kind: "valid"; program: NormalizedEditProgram<TId> }
  | { kind: "invalid"; message: string };

function resolveAnchor(anchor: EditProgramSuggestion["anchor"]) {
  if (anchor.kind === "absolute") return anchor.seconds;
  if (anchor.kind === "playhead-offset") return anchor.referenceSeconds + anchor.offsetSeconds;
  return anchor.referenceSeconds;
}

function normalizeMathTexTarget(target: MathTexSuggestionTarget): MathTexSuggestionTarget | null {
  const displayLines = target.displayLines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((line) => line.slice(0, 120));
  const texParts = target.texParts
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 16);
  if (
    displayLines.length === 0 ||
    texParts.length === 0 ||
    texParts.reduce((length, part) => length + part.length, 0) > 2_000
  )
    return null;
  return { ...target, displayLines, texParts };
}

function lifetimeAt<TId extends string>(object: ProgramObject<TId>, time: number) {
  return object.lifetimes.find((interval) => time >= interval.start && time < interval.end) ?? null;
}

function stepTargetIds(step: EditProgramStep): readonly string[] {
  if (step.kind === "create-motion" || step.kind === "scale-objects" || step.kind === "delete-objects") {
    return step.targetObjectIds;
  }
  if (step.kind === "create-transform") return [step.sourceObjectId];
  if (step.kind === "create-explanation") return [step.targetObjectId];
  return [];
}

export function validateEditProgram<TId extends string>(
  operation: EditProgramSuggestion,
  context: EditProgramValidationContext<TId>,
): EditProgramValidationResult<TId> {
  const parsedOperation = editProgramSuggestionSchema.safeParse(operation);
  if (!parsedOperation.success) {
    return { kind: "invalid", message: "The Edit Program does not match the supported operation contract." };
  }
  operation = parsedOperation.data;
  const firstStep = operation.operations[0];
  const start = resolveAnchor(operation.anchor);
  const referenceMatches =
    operation.anchor.kind === "absolute" ||
    Math.abs(operation.anchor.referenceSeconds - context.capturedPlayhead) < 0.001;
  const intervalsAreValid =
    firstStep !== undefined &&
    operation.operations.every((step) => step.start >= 0 && step.end <= context.sceneDuration);
  if (
    !firstStep ||
    !referenceMatches ||
    !Number.isFinite(start) ||
    start < 0 ||
    start > context.sceneDuration ||
    Math.abs(firstStep.start - start) >= 0.001 ||
    !intervalsAreValid
  ) {
    return { kind: "invalid", message: "The Edit Program has an invalid captured time, interval, or execution order." };
  }

  const objectsById = new Map<string, ProgramObject<TId>>(context.objects.map((object) => [object.id, object]));
  const selectedIds = new Set<string>(context.selectedObjectIds);
  const motionSteps = operation.operations.flatMap((step, index) =>
    step.kind === "create-motion" ? [{ index, step }] : [],
  );
  const transformSteps = operation.operations.flatMap((step, index) =>
    step.kind === "create-transform" ? [{ index, step }] : [],
  );
  const explanationStep =
    operation.operations.find((step): step is ExplanationStep => step.kind === "create-explanation") ?? null;
  const equationStep =
    operation.operations.find((step): step is EquationStep => step.kind === "create-equation") ?? null;
  const explainedEquationStep =
    operation.operations.find((step): step is ExplainedEquationStep => step.kind === "create-explained-equation") ??
    null;
  const sceneTransitionStep =
    operation.operations.find((step): step is SceneTransitionStep => step.kind === "create-scene-transition") ?? null;
  const scaleStep = operation.operations.find((step): step is ScaleStep => step.kind === "scale-objects") ?? null;
  const deleteStep = operation.operations.find((step): step is DeleteStep => step.kind === "delete-objects") ?? null;
  const motionCandidates = motionSteps.map(({ index, step }) => ({
    index,
    step,
    targets: [...new Set(step.targetObjectIds)]
      .map((id) => objectsById.get(id))
      .filter((object): object is ProgramObject<TId> => object !== undefined && selectedIds.has(object.id)),
  }));
  const transformCandidates = transformSteps.map(({ index, step }) => ({
    index,
    source: objectsById.get(step.sourceObjectId) ?? null,
    step,
    target: normalizeMathTexTarget(step.target),
  }));
  const explanationTarget = explanationStep ? (objectsById.get(explanationStep.targetObjectId) ?? null) : null;
  const scaleTargets = scaleStep
    ? scaleStep.targetObjectIds
        .map((id) => objectsById.get(id))
        .filter((object): object is ProgramObject<TId> => object !== undefined && selectedIds.has(object.id))
    : [];
  const deleteTargets = deleteStep
    ? deleteStep.targetObjectIds
        .map((id) => objectsById.get(id))
        .filter((object): object is ProgramObject<TId> => object !== undefined && selectedIds.has(object.id))
    : [];
  const explanationText = explanationStep?.text.trim().slice(0, 240) ?? "";
  const normalizedEquationTarget = equationStep ? normalizeMathTexTarget(equationStep.target) : null;
  const normalizedExplainedEquationTarget = explainedEquationStep
    ? normalizeMathTexTarget(explainedEquationStep.target)
    : null;
  const explainedEquationText = explainedEquationStep?.explanation.text.trim().slice(0, 240) ?? "";

  const motionsAreValid = motionCandidates.every(
    ({ step, targets }) =>
      targets.length > 0 &&
      targets.length === step.targetObjectIds.length &&
      targets.every((object) => (lifetimeAt(object, step.start)?.end ?? step.start) >= step.end),
  );
  const transformsAreValid = transformCandidates.every(
    ({ source, step, target }) =>
      source !== null &&
      selectedIds.has(source.id) &&
      source.type === "MathTex" &&
      (lifetimeAt(source, step.start)?.end ?? step.start) >= step.end &&
      target !== null,
  );
  const explanationIsValid =
    !explanationStep ||
    (explanationTarget !== null &&
      selectedIds.has(explanationTarget.id) &&
      (lifetimeAt(explanationTarget, explanationStep.start)?.end ?? explanationStep.start) >= explanationStep.end &&
      explanationText.length > 0);
  const equationIsValid = !equationStep || normalizedEquationTarget !== null;
  const explainedEquationIsValid =
    !explainedEquationStep || (normalizedExplainedEquationTarget !== null && explainedEquationText.length > 0);
  const sceneTransitionIsValid = !sceneTransitionStep || sceneTransitionStep.end - sceneTransitionStep.start >= 0.4;
  const scaleIsValid =
    !scaleStep ||
    (scaleTargets.length === scaleStep.targetObjectIds.length &&
      scaleTargets.every((object) => (lifetimeAt(object, scaleStep.start)?.end ?? scaleStep.start) >= scaleStep.end));
  const deleteIsValid =
    !deleteStep ||
    (deleteTargets.length === deleteStep.targetObjectIds.length &&
      deleteTargets.every((object) => (lifetimeAt(object, deleteStep.start)?.end ?? deleteStep.start) >= deleteStep.end));
  const equationCreationCount = Number(equationStep !== null) + Number(explainedEquationStep !== null);
  const motionTargetIds = [
    ...new Set<TId>(motionCandidates.flatMap(({ targets }) => targets.map((object) => object.id))),
  ];
  const transformSourceIds = transformCandidates.flatMap(({ source }) => (source ? [source.id] : []));
  const parallelWriteConflict =
    operation.execution === "parallel" &&
    motionSteps.length > 0 &&
    (transformSourceIds.some((sourceId) => motionTargetIds.includes(sourceId)) ||
      (explanationTarget !== null && motionTargetIds.includes(explanationTarget.id)));
  const parallelScaleOrDeleteConflict =
    operation.execution === "parallel" &&
    operation.operations.some((step, index) => {
      if (step.kind !== "scale-objects" && step.kind !== "delete-objects") return false;
      const targets = new Set(stepTargetIds(step));
      return operation.operations.some(
        (other, otherIndex) => otherIndex !== index && stepTargetIds(other).some((id) => targets.has(id)),
      );
    });
  const parallelSceneTransitionObjectEdit =
    operation.execution === "parallel" &&
    sceneTransitionStep !== null &&
    (scaleStep !== null || deleteStep !== null);
  const editAfterDelete =
    operation.execution === "sequence" &&
    operation.operations.some((step, index) => {
      if (step.kind !== "delete-objects") return false;
      const targets = new Set(step.targetObjectIds);
      return operation.operations
        .slice(index + 1)
        .some((later) => stepTargetIds(later).some((id) => targets.has(id)));
    });
  if (
    !motionsAreValid ||
    !transformsAreValid ||
    !explanationIsValid ||
    !equationIsValid ||
    !explainedEquationIsValid ||
    !sceneTransitionIsValid ||
    !scaleIsValid ||
    !deleteIsValid ||
    equationCreationCount > 1 ||
    parallelWriteConflict ||
    parallelScaleOrDeleteConflict ||
    parallelSceneTransitionObjectEdit ||
    editAfterDelete
  ) {
    return {
      kind: "invalid",
      message:
        equationCreationCount > 1
          ? "This Edit Program contains two equation-creation macros. Keep one equation identity and combine its explanation inside create-explained-equation."
          : parallelWriteConflict
            ? "This Edit Program moves and rewrites or observes the same object in parallel. Express those steps in sequence so Studio can preserve the dependency."
            : parallelScaleOrDeleteConflict
              ? "Scaling or deleting an object cannot run in parallel with another edit on that object. Express those steps in sequence."
              : parallelSceneTransitionObjectEdit
                ? "Scale or deletion must run in sequence with a Scene transition so Studio can lower one truthful source timeline."
                : editAfterDelete
                  ? "delete-objects must be the last step that targets an object. Move the later edit before deletion."
                  : "The Edit Program contains an invalid, unselected, or unavailable target.",
    };
  }

  const normalizedMotions = motionCandidates.map(({ index, step, targets }) => {
    const targetObjectIds = targets.map((object) => object.id);
    return {
      index,
      step: { ...step, targetObjectIds },
      targetObjectIds,
    };
  });
  const normalizedMotionByIndex = new Map(normalizedMotions.map((motion) => [motion.index, motion] as const));
  const normalizedTransforms = transformCandidates.flatMap(({ index, source, step, target }) =>
    source && target
      ? [
          {
            index,
            sourceObjectId: source.id,
            step: { ...step, sourceObjectId: source.id, target },
          },
        ]
      : [],
  );
  const normalizedTransformByIndex = new Map(
    normalizedTransforms.map((transform) => [transform.index, transform] as const),
  );
  const normalizedExplanation =
    explanationStep && explanationTarget
      ? {
          index: operation.operations.indexOf(explanationStep),
          step: { ...explanationStep, targetObjectId: explanationTarget.id, text: explanationText },
          targetObjectId: explanationTarget.id,
        }
      : null;
  const normalizedScale = scaleStep
    ? {
        ...scaleStep,
        targetObjectIds: scaleTargets.map((object) => object.id),
      }
    : null;
  const normalizedDelete = deleteStep
    ? {
        ...deleteStep,
        targetObjectIds: deleteTargets.map((object) => object.id),
      }
    : null;
  const normalizedEquation =
    equationStep && normalizedEquationTarget ? { ...equationStep, target: normalizedEquationTarget } : null;
  const normalizedExplainedEquation =
    explainedEquationStep && normalizedExplainedEquationTarget
      ? {
          ...explainedEquationStep,
          explanation: {
            ...explainedEquationStep.explanation,
            text: explainedEquationText,
          },
          target: normalizedExplainedEquationTarget,
        }
      : null;
  const normalizedSteps = operation.operations.map((step, index) => {
    if (step.kind === "create-motion") return normalizedMotionByIndex.get(index)?.step ?? step;
    if (step.kind === "create-transform") return normalizedTransformByIndex.get(index)?.step ?? step;
    if (step.kind === "create-explanation" && normalizedExplanation) return normalizedExplanation.step;
    if (step.kind === "create-equation" && normalizedEquation) return normalizedEquation;
    if (step.kind === "create-explained-equation" && normalizedExplainedEquation) {
      return normalizedExplainedEquation;
    }
    if (step.kind === "scale-objects" && normalizedScale) return normalizedScale;
    if (step.kind === "delete-objects" && normalizedDelete) return normalizedDelete;
    return step;
  });
  const touchedObjectIds = [
    ...new Set<TId>([
      ...motionTargetIds,
      ...normalizedTransforms.map((transform) => transform.sourceObjectId),
      ...(normalizedExplanation ? [normalizedExplanation.targetObjectId] : []),
      ...(normalizedScale?.targetObjectIds ?? []),
      ...(normalizedDelete?.targetObjectIds ?? []),
    ]),
  ];
  return {
    kind: "valid",
    program: {
      explanation: normalizedExplanation,
      motion: normalizedMotions[0] ?? null,
      motions: normalizedMotions,
      operation: { ...operation, operations: normalizedSteps },
      start,
      touchedObjectIds,
      transform: normalizedTransforms[0] ?? null,
      transforms: normalizedTransforms,
    },
  };
}
