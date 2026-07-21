import type { EditProgramStep } from "./edit-suggestions";

type Interval = { start: number; end: number };

type SourceObject<TId extends string> = {
  id: TId;
  source: string;
  variableName: string;
};

type ProgramSourceInput<TId extends string> = {
  existingMotionConflict?: string;
  explanation: {
    interval: Interval;
    placement: "above" | "below" | "left" | "right";
    runtimeId: string;
    stepIndex: number;
    targetObjectId: TId;
    text: string;
  } | null;
  motion: {
    affected: readonly TId[];
    delta: { x: number; y: number };
    interval: Interval;
    stepIndex: number;
  } | null;
  objects: readonly SourceObject<TId>[];
  pixelsToWorldUnits: (pixels: number) => number;
  program: {
    execution: "parallel" | "sequence";
    groupId: string;
    operationKinds: readonly EditProgramStep["kind"][];
  };
  transform: {
    interval: Interval;
    sourceObjectId: TId;
    stepIndex: number;
    texParts: readonly string[];
  } | null;
};

export type EditProgramSourcePreview = {
  after: string;
  before: string;
  context: string;
};

const DIRECTIONS = {
  above: "UP",
  below: "DOWN",
  left: "LEFT",
  right: "RIGHT",
} as const;

export function buildEditProgramSourcePreview<TId extends string>(
  input: ProgramSourceInput<TId>,
): EditProgramSourcePreview | null {
  const objectsById = new Map<string, SourceObject<TId>>(
    input.objects.map((object) => [object.id, object]),
  );
  const transformSource = input.transform
    ? objectsById.get(input.transform.sourceObjectId) ?? null
    : null;
  const explanationTarget = input.explanation
    ? objectsById.get(input.explanation.targetObjectId) ?? null
    : null;
  if ((input.transform && !transformSource) || (input.explanation && !explanationTarget)) return null;

  const targetVariable = transformSource ? `${transformSource.variableName}_target` : null;
  const targetArguments = input.transform?.texParts.map((part) => JSON.stringify(part)).join(", ") ?? "";
  const horizontal = input.motion ? input.pixelsToWorldUnits(input.motion.delta.x) : 0;
  const vertical = input.motion ? input.pixelsToWorldUnits(-input.motion.delta.y) : 0;
  const shiftTerms = [
    Math.abs(horizontal) > 0.005 ? `${horizontal.toFixed(2)} * RIGHT` : null,
    Math.abs(vertical) > 0.005 ? `${vertical.toFixed(2)} * UP` : null,
  ].filter((term): term is string => term !== null);
  const shiftVector = shiftTerms.length > 0 ? shiftTerms.join(" + ") : "ORIGIN";
  const motionAnimations = input.motion?.affected.map((objectId) => (
    `${objectsById.get(objectId)!.variableName}.animate.shift(${shiftVector})`
  )) ?? [];
  const transformAnimation = input.transform && transformSource && targetVariable
    ? `TransformMatchingTex(${transformSource.variableName}, ${targetVariable}, transform_mismatches=True)`
    : null;
  const explanationAnimation = input.explanation ? `FadeIn(${input.explanation.runtimeId})` : null;
  const animationsByIndex = new Map<number, readonly string[]>();
  if (input.motion) animationsByIndex.set(input.motion.stepIndex, motionAnimations);
  if (input.transform && transformAnimation) animationsByIndex.set(input.transform.stepIndex, [transformAnimation]);
  if (input.explanation && explanationAnimation) animationsByIndex.set(input.explanation.stepIndex, [explanationAnimation]);

  let after: string;
  if (input.program.execution === "parallel") {
    const declarations: string[] = [];
    if (input.transform && targetVariable) declarations.push(`${targetVariable} = MathTex(${targetArguments})`);
    if (input.explanation && explanationTarget) {
      const relativeTarget = input.transform?.sourceObjectId === input.explanation.targetObjectId && targetVariable
        ? targetVariable
        : explanationTarget.variableName;
      declarations.push(
        `${input.explanation.runtimeId} = Text(${JSON.stringify(input.explanation.text)})`,
        `${input.explanation.runtimeId}.next_to(${relativeTarget}, ${DIRECTIONS[input.explanation.placement]})`,
      );
    }
    const animations = input.program.operationKinds.flatMap((_, index) => animationsByIndex.get(index) ?? []);
    const interval = input.motion?.interval ?? input.transform?.interval ?? input.explanation?.interval;
    if (!interval) return null;
    after = `${declarations.join("\n")}\nself.play(\n${animations.map((animation) => `    ${animation},`).join("\n")}\n    run_time=${(interval.end - interval.start).toFixed(2)},\n    rate_func=smooth,\n)`;
    if (transformSource && targetVariable) after += `\n${transformSource.variableName} = ${targetVariable}`;
  } else {
    const blocks: string[] = [];
    for (const [index, kind] of input.program.operationKinds.entries()) {
      if (kind === "create-transform" && input.transform && targetVariable) {
        blocks.push(`${targetVariable} = MathTex(${targetArguments})`);
      }
      if (kind === "create-explanation" && input.explanation && explanationTarget) {
        blocks.push(
          `${input.explanation.runtimeId} = Text(${JSON.stringify(input.explanation.text)})`,
          `${input.explanation.runtimeId}.next_to(${explanationTarget.variableName}, ${DIRECTIONS[input.explanation.placement]})`,
        );
      }
      const interval = kind === "create-motion"
        ? input.motion?.interval
        : kind === "create-transform"
          ? input.transform?.interval
          : input.explanation?.interval;
      if (!interval) return null;
      const animations = animationsByIndex.get(index) ?? [];
      blocks.push(`self.play(\n${animations.map((animation) => `    ${animation},`).join("\n")}\n    run_time=${(interval.end - interval.start).toFixed(2)},\n    rate_func=smooth,\n)`);
      if (kind === "create-transform" && transformSource && targetVariable) {
        blocks.push(`${transformSource.variableName} = ${targetVariable}`);
      }
    }
    after = blocks.join("\n");
  }

  const touchedObjectIds = [...new Set<TId>([
    ...(input.motion?.affected ?? []),
    ...(input.transform ? [input.transform.sourceObjectId] : []),
    ...(input.explanation ? [input.explanation.targetObjectId] : []),
  ])];
  return {
    after,
    before: touchedObjectIds.map((objectId) => objectsById.get(objectId)?.source).filter(Boolean).join("\n"),
    context: `${input.program.groupId} lowers ${input.program.operationKinds.length} requested effects as one atomic ${input.program.execution} Edit Program. Apply and Undo preserve the group.${input.existingMotionConflict ? ` ${input.existingMotionConflict}` : ""}`,
  };
}
