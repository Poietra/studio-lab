import type {
  CreateExplanationSuggestion,
  CreateSceneTransitionSuggestion,
  CreateTransformSuggestion,
  EditProgramStep,
  EditSuggestionOperation,
  SuggestionTimeAnchor,
} from "../ai/edit-suggestions";
import type { RuntimeSceneState } from "./model";
import {
  EDIT_OPERATION_VERSION,
  operationId,
  provisionalEntityId,
  type CanonicalEditOperation,
  type CanonicalEditProgram,
  type OperationOrigin,
} from "./operations";
import { validateAndScheduleProgram, type ProgramValidationResult } from "./program-validation";
import { resolveTimeAnchorOnce } from "./time";

type CanonicalizationContext = Readonly<{
  capturedPlayhead: number;
  origin: OperationOrigin;
  scene: RuntimeSceneState;
  transactionId: string;
}>;

const placementOffsets = {
  above: { x: 0, y: -70 },
  below: { x: 0, y: 70 },
  left: { x: -145, y: 0 },
  right: { x: 145, y: 0 },
} as const;

function provenance(origin: OperationOrigin, evidence: readonly string[]) {
  return { evidence, origin } as const;
}

function transformOperation(
  operation: Omit<CreateTransformSuggestion, "anchor">,
  transactionId: string,
  origin: OperationOrigin,
  index: number,
) {
  const id = operationId(transactionId, `transform-${index}`);
  const targetEntityId = provisionalEntityId(transactionId, `transform-target-${index}`);
  return {
    canonical: {
      dependsOn: [],
      id,
      interval: { end: operation.end, start: operation.start },
      kind: "TransformContent",
      provenance: provenance(origin, [operation.strategy, operation.identityAfter]),
      replacement: {
        displayLines: operation.target.displayLines,
        label: operation.target.label,
        texParts: operation.target.texParts,
      },
      sourceEntityId: operation.sourceObjectId,
      strategy: operation.strategy,
      targetEntityId,
    } satisfies CanonicalEditOperation,
    sourceEntityId: operation.sourceObjectId,
    targetEntityId,
  };
}

function explanationOperations(
  operation: Omit<CreateExplanationSuggestion, "anchor">,
  transactionId: string,
  origin: OperationOrigin,
  index: number,
  transformedTargets: ReadonlyMap<string, Readonly<{ operationId: string; targetEntityId: string }>>,
) {
  const entityId = provisionalEntityId(transactionId, `explanation-${index}`);
  const createId = operationId(transactionId, `create-explanation-${index}`);
  const relationId = operationId(transactionId, `place-explanation-${index}`);
  const presenceId = operationId(transactionId, `show-explanation-${index}`);
  const replacement = transformedTargets.get(operation.targetObjectId);
  const targetEntityId = replacement?.targetEntityId ?? operation.targetObjectId;
  const relationDependencies = [createId, ...(replacement ? [replacement.operationId] : [])];
  return [
    {
      dependsOn: [],
      entity: {
        content: { displayLines: [operation.text], text: operation.text },
        id: entityId,
        lifetime: { end: null, start: operation.start },
        type: "Text",
      },
      id: createId,
      interval: { end: operation.start, start: operation.start },
      kind: "CreateEntity",
      provenance: provenance(origin, ["CreateExplanation macro", "persistent lifetime after FadeIn"]),
    },
    {
      dependsOn: relationDependencies,
      id: relationId,
      interval: { end: operation.start, start: operation.start },
      kind: "SetRelation",
      mode: "snapshot",
      offset: placementOffsets[operation.placement],
      placement: operation.placement,
      provenance: provenance(origin, ["next_to", "snapshot placement"]),
      relation: "next-to",
      sourceEntityId: entityId,
      targetEntityId,
    },
    {
      dependsOn: [relationId],
      effect: "fade-in",
      entityId,
      id: presenceId,
      interval: { end: operation.end, start: operation.start },
      kind: "ChangePresence",
      persistent: true,
      provenance: provenance(origin, [operation.animation, "persistent after interval"]),
    },
  ] satisfies readonly CanonicalEditOperation[];
}

function motionOperation(
  operation: Extract<EditProgramStep, { kind: "create-motion" }>,
  transactionId: string,
  origin: OperationOrigin,
  index: number,
) {
  return {
    controlOffset: operation.controlOffset,
    delta: operation.delta,
    dependsOn: [],
    easing: operation.easing,
    id: operationId(transactionId, `motion-${index}`),
    interval: { end: operation.end, start: operation.start },
    kind: "CreateMotion",
    provenance: provenance(origin, ["language/direct-manipulation constraint", "new motion"]),
    targetEntityIds: operation.targetObjectIds,
  } satisfies CanonicalEditOperation;
}

function transitionOperations(
  operation: CreateSceneTransitionSuggestion,
  transactionId: string,
  origin: OperationOrigin,
) {
  const entityId = provisionalEntityId(transactionId, "scene-transition-overlay");
  const createId = operationId(transactionId, "create-transition-overlay");
  const coverId = operationId(transactionId, "cover-frame");
  const boundaryId = operationId(transactionId, "scene-boundary");
  const revealId = operationId(transactionId, "reveal-next-scene");
  const midpoint = operation.start + (operation.end - operation.start) / 2;
  return [
    {
      dependsOn: [],
      entity: {
        content: { displayLines: [`${operation.color} ${operation.shape}`], label: `${operation.shape} transition` },
        id: entityId,
        lifetime: { end: operation.end, start: operation.start },
        type: `TransitionOverlay:${operation.shape}:${operation.color}`,
      },
      id: createId,
      interval: { end: operation.start, start: operation.start },
      kind: "CreateEntity",
      provenance: provenance(origin, ["CreateSceneTransition macro", `${operation.shape}+${operation.color}`]),
    },
    {
      dependsOn: [createId],
      effect: "cover",
      entityId,
      id: coverId,
      interval: { end: midpoint, start: operation.start },
      kind: "ChangePresence",
      persistent: false,
      provenance: provenance(origin, ["cover outgoing Scene"]),
    },
    {
      at: midpoint,
      dependsOn: [coverId],
      destination: operation.destination,
      id: boundaryId,
      interval: { end: midpoint, start: midpoint },
      kind: "InsertSceneBoundary",
      provenance: provenance(origin, ["full frame coverage"]),
    },
    {
      dependsOn: [boundaryId],
      effect: "reveal",
      entityId,
      id: revealId,
      interval: { end: operation.end, start: midpoint },
      kind: "ChangePresence",
      persistent: true,
      provenance: provenance(origin, ["reveal incoming Scene", "remove overlay"]),
    },
  ] satisfies readonly CanonicalEditOperation[];
}

function operationSteps(operation: EditSuggestionOperation) {
  if (operation.kind === "edit-program") return operation.operations;
  if (operation.kind === "create-scene-transition") return [];
  const { anchor: _anchor, ...step } = operation;
  return [step];
}

function operationAnchor(operation: EditSuggestionOperation): SuggestionTimeAnchor {
  return operation.anchor;
}

export function canonicalizeSuggestionProgram(
  operation: EditSuggestionOperation,
  context: CanonicalizationContext,
): ProgramValidationResult {
  const resolution = resolveTimeAnchorOnce(operationAnchor(operation), {
    capturedPlayhead: context.capturedPlayhead,
    sceneDuration: context.scene.duration,
  });
  if (resolution.kind === "invalid") {
    const fallback: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: context.capturedPlayhead,
        evidence: [],
        resolvedSeconds: Number.NaN,
        source: operationAnchor(operation),
      },
      intentCount: operation.kind === "edit-program" ? operation.operations.length : 1,
      loweringStatus: "unsupported",
      operations: [],
      provenance: provenance(context.origin, []),
      requestedExecution: operation.kind === "edit-program" ? operation.execution : "sequence",
      schedule: { edges: [], mode: "sequence", order: [] },
      transactionId: context.transactionId,
      version: EDIT_OPERATION_VERSION,
    };
    return {
      issues: [{ code: "anchor-invalid", field: resolution.field, message: resolution.message, severity: "error" }],
      kind: "invalid",
      program: fallback,
    };
  }

  let operations: readonly CanonicalEditOperation[];
  if (operation.kind === "create-scene-transition") {
    operations = transitionOperations(operation, context.transactionId, context.origin);
  } else {
    const steps = operationSteps(operation);
    const transforms = new Map<string, Readonly<{ operationId: string; targetEntityId: string }>>();
    const transformByIndex = new Map<number, ReturnType<typeof transformOperation>>();
    steps.forEach((step, index) => {
      if (step.kind !== "create-transform") return;
      const transformed = transformOperation(step, context.transactionId, context.origin, index);
      transformByIndex.set(index, transformed);
      transforms.set(step.sourceObjectId, { operationId: transformed.canonical.id, targetEntityId: transformed.targetEntityId });
    });
    operations = steps.flatMap((step, index): readonly CanonicalEditOperation[] => {
      if (step.kind === "create-motion") return [motionOperation(step, context.transactionId, context.origin, index)];
      if (step.kind === "create-transform") return [transformByIndex.get(index)!.canonical];
      return explanationOperations(step, context.transactionId, context.origin, index, transforms);
    });
  }

  const program: CanonicalEditProgram = {
    anchor: resolution.anchor,
    intentCount: operation.kind === "edit-program" ? operation.operations.length : 1,
    loweringStatus: operation.kind === "create-scene-transition" ? "illustrative" : "supported",
    operations,
    provenance: provenance(context.origin, [operation.kind]),
    requestedExecution: operation.kind === "edit-program" ? operation.execution : "sequence",
    schedule: { edges: [], mode: operation.kind === "edit-program" ? operation.execution : "sequence", order: operations.map((entry) => entry.id) },
    transactionId: context.transactionId,
    version: EDIT_OPERATION_VERSION,
  };
  return validateAndScheduleProgram(program, context.scene);
}

export function createDirectManipulationMotionProgram(
  input: Readonly<{
    capturedPlayhead: number;
    controlOffset: Readonly<{ x: number; y: number }>;
    delta: Readonly<{ x: number; y: number }>;
    interval: Readonly<{ end: number; start: number }>;
    scene: RuntimeSceneState;
    targetEntityIds: readonly string[];
    transactionId: string;
  }>,
) {
  return canonicalizeSuggestionProgram({
    anchor: { kind: "playhead", referenceSeconds: input.capturedPlayhead },
    controlOffset: input.controlOffset,
    delta: input.delta,
    easing: "smooth",
    end: input.interval.end,
    kind: "create-motion",
    start: input.interval.start,
    targetObjectIds: input.targetEntityIds,
  }, {
    capturedPlayhead: input.capturedPlayhead,
    origin: "direct-manipulation",
    scene: input.scene,
    transactionId: input.transactionId,
  });
}

export function createDirectManipulationPositionProgram(
  input: Readonly<{
    capturedPlayhead: number;
    delta: Readonly<{ x: number; y: number }>;
    positions: Readonly<Record<string, Readonly<{ x: number; y: number }>>>;
    scene: RuntimeSceneState;
    start: number;
    targetEntityIds: readonly string[];
    transactionId: string;
  }>,
): ProgramValidationResult {
  const sourceAnchor = Math.abs(input.start - input.capturedPlayhead) < 0.001
    ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
    : { kind: "absolute" as const, seconds: input.start };
  const resolution = resolveTimeAnchorOnce(sourceAnchor, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") {
    throw new Error(resolution.message);
  }
  const operations = input.targetEntityIds.map((entityId, index): CanonicalEditOperation => {
    const position = input.positions[entityId] ?? { x: 0, y: 0 };
    return {
      dependsOn: [],
      entityId,
      id: operationId(input.transactionId, `set-position-${index}`),
      interval: { end: input.start, start: input.start },
      key: "position",
      kind: "SetProperty",
      provenance: provenance("direct-manipulation", ["pointer displacement", "one-shot position"]),
      value: { x: position.x + input.delta.x, y: position.y + input.delta.y },
    };
  });
  return validateAndScheduleProgram({
    anchor: resolution.anchor,
    intentCount: 1,
    loweringStatus: "illustrative",
    operations,
    provenance: provenance("direct-manipulation", ["gesture constraint"]),
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
    transactionId: input.transactionId,
    version: EDIT_OPERATION_VERSION,
  }, input.scene);
}

export function createDirectManipulationModifyMotionProgram(
  input: Readonly<{
    capturedPlayhead: number;
    controlOffset: Readonly<{ x: number; y: number }>;
    interval: Readonly<{ end: number; start: number }>;
    motionId: string;
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
) {
  const resolution = resolveTimeAnchorOnce({ kind: "absolute", seconds: input.interval.start }, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operation: CanonicalEditOperation = {
    controlOffset: input.controlOffset,
    dependsOn: [],
    id: operationId(input.transactionId, "modify-motion"),
    interval: input.interval,
    kind: "ModifyMotion",
    motionId: input.motionId,
    preserve: ["start", "end", "duration"],
    provenance: provenance("direct-manipulation", ["path bend gesture", "endpoints preserved"]),
  };
  return validateAndScheduleProgram({
    anchor: resolution.anchor,
    intentCount: 1,
    loweringStatus: "illustrative",
    operations: [operation],
    provenance: provenance("direct-manipulation", ["gesture constraint"]),
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId: input.transactionId,
    version: EDIT_OPERATION_VERSION,
  }, input.scene);
}
