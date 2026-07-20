import type {
  EditProgramStep,
  EditProgramSuggestion,
  MathTexSuggestionTarget,
  SuggestionInterval,
} from "./edit-suggestions";

type MotionStep = Extract<EditProgramStep, { kind: "create-motion" }>;
type TransformStep = Extract<EditProgramStep, { kind: "create-transform" }>;
type ExplanationStep = Extract<EditProgramStep, { kind: "create-explanation" }>;

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
  operation: EditProgramSuggestion;
  start: number;
  touchedObjectIds: readonly TId[];
  transform: {
    index: number;
    sourceObjectId: TId;
    step: TransformStep;
  } | null;
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
    displayLines.length === 0
    || texParts.length === 0
    || texParts.reduce((length, part) => length + part.length, 0) > 2_000
  ) return null;
  return { ...target, displayLines, texParts };
}

function lifetimeAt<TId extends string>(object: ProgramObject<TId>, time: number) {
  return object.lifetimes.find((interval) => time >= interval.start && time < interval.end) ?? null;
}

export function validateEditProgram<TId extends string>(
  operation: EditProgramSuggestion,
  context: EditProgramValidationContext<TId>,
): EditProgramValidationResult<TId> {
  const firstStep = operation.operations[0];
  const start = resolveAnchor(operation.anchor);
  const referenceMatches = operation.anchor.kind === "absolute"
    || Math.abs(operation.anchor.referenceSeconds - context.capturedPlayhead) < 0.001;
  const intervalsAreValid = firstStep !== undefined && operation.operations.every((step, index) => (
    Number.isFinite(step.start)
    && Number.isFinite(step.end)
    && step.start >= 0
    && step.end <= context.sceneDuration
    && step.end - step.start >= 0.1
    && step.end - step.start <= 5
    && (index === 0 || (
      operation.execution === "parallel"
        ? Math.abs(step.start - firstStep.start) < 0.001 && Math.abs(step.end - firstStep.end) < 0.001
        : step.start >= operation.operations[index - 1].end - 0.001
    ))
  ));
  if (
    !firstStep
    || !referenceMatches
    || !Number.isFinite(start)
    || start < 0
    || start > context.sceneDuration
    || Math.abs(firstStep.start - start) >= 0.001
    || !intervalsAreValid
  ) {
    return { kind: "invalid", message: "The Edit Program has an invalid captured time, interval, or execution order." };
  }

  const objectsById = new Map<string, ProgramObject<TId>>(
    context.objects.map((object) => [object.id, object]),
  );
  const selectedIds = new Set<string>(context.selectedObjectIds);
  const motionStep = operation.operations.find((step): step is MotionStep => step.kind === "create-motion") ?? null;
  const transformStep = operation.operations.find((step): step is TransformStep => step.kind === "create-transform") ?? null;
  const explanationStep = operation.operations.find((step): step is ExplanationStep => step.kind === "create-explanation") ?? null;
  const motionTargets = motionStep
    ? [...new Set(motionStep.targetObjectIds)]
      .map((id) => objectsById.get(id))
      .filter((object): object is ProgramObject<TId> => object !== undefined && selectedIds.has(object.id))
    : [];
  const transformSource = transformStep ? objectsById.get(transformStep.sourceObjectId) ?? null : null;
  const explanationTarget = explanationStep ? objectsById.get(explanationStep.targetObjectId) ?? null : null;
  const normalizedTarget = transformStep ? normalizeMathTexTarget(transformStep.target) : null;
  const explanationText = explanationStep?.text.trim().slice(0, 240) ?? "";

  const motionIsValid = !motionStep || (
    motionTargets.length > 0
    && motionTargets.length === motionStep.targetObjectIds.length
    && motionTargets.every((object) => (lifetimeAt(object, motionStep.start)?.end ?? motionStep.start) >= motionStep.end)
  );
  const transformIsValid = !transformStep || (
    transformSource !== null
    && selectedIds.has(transformSource.id)
    && transformSource.type === "MathTex"
    && (lifetimeAt(transformSource, transformStep.start)?.end ?? transformStep.start) >= transformStep.end
    && normalizedTarget !== null
  );
  const explanationIsValid = !explanationStep || (
    explanationTarget !== null
    && selectedIds.has(explanationTarget.id)
    && (lifetimeAt(explanationTarget, explanationStep.start)?.end ?? explanationStep.start) >= explanationStep.end
    && explanationText.length > 0
  );
  const motionTargetIds = motionTargets.map((object) => object.id);
  const parallelWriteConflict = operation.execution === "parallel" && motionStep !== null && (
    (transformSource !== null && motionTargetIds.includes(transformSource.id))
    || (explanationTarget !== null && motionTargetIds.includes(explanationTarget.id))
  );
  if (!motionIsValid || !transformIsValid || !explanationIsValid || parallelWriteConflict) {
    return {
      kind: "invalid",
      message: parallelWriteConflict
        ? "This Edit Program moves and rewrites or observes the same object in parallel. Express those steps in sequence so Studio can preserve the dependency."
        : "The Edit Program contains an invalid, unselected, or unavailable target.",
    };
  }

  const normalizedMotion = motionStep ? {
    index: operation.operations.indexOf(motionStep),
    step: { ...motionStep, targetObjectIds: motionTargetIds },
    targetObjectIds: motionTargetIds,
  } : null;
  const normalizedTransform = transformStep && transformSource && normalizedTarget ? {
    index: operation.operations.indexOf(transformStep),
    sourceObjectId: transformSource.id,
    step: { ...transformStep, sourceObjectId: transformSource.id, target: normalizedTarget },
  } : null;
  const normalizedExplanation = explanationStep && explanationTarget ? {
    index: operation.operations.indexOf(explanationStep),
    step: { ...explanationStep, targetObjectId: explanationTarget.id, text: explanationText },
    targetObjectId: explanationTarget.id,
  } : null;
  const normalizedSteps = operation.operations.map((step) => {
    if (step.kind === "create-motion" && normalizedMotion) return normalizedMotion.step;
    if (step.kind === "create-transform" && normalizedTransform) return normalizedTransform.step;
    if (step.kind === "create-explanation" && normalizedExplanation) return normalizedExplanation.step;
    return step;
  });
  const touchedObjectIds = [...new Set<TId>([
    ...motionTargetIds,
    ...(normalizedTransform ? [normalizedTransform.sourceObjectId] : []),
    ...(normalizedExplanation ? [normalizedExplanation.targetObjectId] : []),
  ])];
  return {
    kind: "valid",
    program: {
      explanation: normalizedExplanation,
      motion: normalizedMotion,
      operation: { ...operation, operations: normalizedSteps },
      start,
      touchedObjectIds,
      transform: normalizedTransform,
    },
  };
}
