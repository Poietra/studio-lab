import type {
  CreateCameraFocusSuggestion,
  DeleteObjectsSuggestion,
  CreateEquationSuggestion,
  CreateExplainedEquationSuggestion,
  CreateExplanationSuggestion,
  CreateSceneTransitionSuggestion,
  CreateTextTransformSuggestion,
  CreateTransformSuggestion,
  EditProgramStep,
  EditSuggestionOperation,
  ScaleObjectsSuggestion,
  SuggestionTimeAnchor,
} from "../ai/edit-suggestions";
import type { RuntimeSceneState } from "./model";
import {
  exactEntityScaleAt,
  hasSafeMagicEditIdentity,
  MAX_ENTITY_SCALE,
  MIN_ENTITY_SCALE,
} from "./magic-edit-capabilities";
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
  sourceEntityId = operation.sourceObjectId,
  dependsOn: readonly string[] = [],
) {
  const id = operationId(transactionId, `transform-${index}`);
  const targetEntityId = provisionalEntityId(transactionId, `transform-target-${index}`);
  return {
    canonical: {
      dependsOn,
      id,
      interval: { end: operation.end, start: operation.start },
      kind: "TransformContent",
      provenance: provenance(origin, [operation.strategy, operation.identityAfter]),
      replacement: {
        displayLines: operation.target.displayLines,
        label: operation.target.label,
        texParts: operation.target.texParts,
      },
      sourceEntityId,
      strategy: operation.strategy,
      targetEntityId,
    } satisfies CanonicalEditOperation,
    sourceEntityId,
    targetEntityId,
  };
}

function textTransformOperation(
  operation: CreateTextTransformSuggestion,
  transactionId: string,
  origin: OperationOrigin,
) {
  return {
    dependsOn: [],
    id: operationId(transactionId, "transform-to-text"),
    interval: { end: operation.end, start: operation.start },
    kind: "TransformContent",
    provenance: provenance(origin, [operation.strategy, "MathTex to explanatory Text"]),
    replacement: {
      displayLines: [operation.text],
      label: "explanatory text",
      text: operation.text,
    },
    sourceEntityId: operation.sourceObjectId,
    strategy: operation.strategy,
    targetEntityId: provisionalEntityId(transactionId, "text-transform-target"),
    targetType: "Text",
  } satisfies CanonicalEditOperation;
}

function equationOperations(
  operation: Pick<CreateEquationSuggestion, "animation" | "end" | "placement" | "start" | "target">,
  transactionId: string,
  origin: OperationOrigin,
) {
  const entityId = provisionalEntityId(transactionId, "new-equation");
  const createId = operationId(transactionId, "create-equation");
  const positionId = operationId(transactionId, "position-equation");
  const presenceId = operationId(transactionId, "show-equation");
  return [
    {
      dependsOn: [],
      entity: {
        content: {
          displayLines: operation.target.displayLines,
          label: operation.target.label,
          texParts: operation.target.texParts,
        },
        id: entityId,
        lifetime: { end: null, start: operation.start },
        type: "MathTex",
      },
      id: createId,
      interval: { end: operation.start, start: operation.start },
      kind: "CreateEntity",
      provenance: provenance(origin, ["CreateEquation macro", operation.target.label]),
    },
    {
      dependsOn: [createId],
      entityId,
      id: positionId,
      interval: { end: operation.start, start: operation.start },
      key: "position",
      kind: "SetProperty",
      provenance: provenance(origin, [`${operation.placement} placement`, "visible preview default"]),
      value: operation.placement === "right" ? { x: 480, y: 180 } : { x: 320, y: 180 },
    },
    {
      dependsOn: [positionId],
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

function cameraFocusOperations(
  operation: CreateCameraFocusSuggestion,
  transactionId: string,
  origin: OperationOrigin,
) {
  const cameraId = operationId(transactionId, "camera-zoom");
  return [
    {
      dependsOn: [],
      id: cameraId,
      interval: { end: operation.end, start: operation.start },
      kind: "ChangeCamera",
      property: "scale",
      provenance: provenance(origin, ["bounded camera focus", `${operation.zoomScale}x zoom`]),
      value: operation.zoomScale,
    },
    ...operation.targetObjectIds.map((entityId, index): CanonicalEditOperation => ({
      dependsOn: [],
      easing: operation.easing,
      entityId,
      from: 1,
      id: operationId(transactionId, `emphasize-${index}`),
      interval: { end: operation.end, start: operation.start },
      key: "scale",
      kind: "AnimateProperty",
      provenance: provenance(origin, ["important region", `${operation.emphasisScale}x emphasis`]),
      to: operation.emphasisScale,
    })),
  ] satisfies readonly CanonicalEditOperation[];
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

function explainedEquationOperations(
  operation: Omit<CreateExplainedEquationSuggestion, "anchor">,
  transactionId: string,
  origin: OperationOrigin,
) {
  const equationEntityId = provisionalEntityId(transactionId, "new-equation");
  return [
    ...equationOperations(operation, transactionId, origin),
    ...explanationOperations({
      animation: operation.animation,
      end: operation.end,
      kind: "create-explanation",
      objectKind: "text",
      placement: operation.explanation.placement,
      start: operation.start,
      targetObjectId: equationEntityId,
      text: operation.explanation.text,
    }, transactionId, origin, 0, new Map()),
  ] satisfies readonly CanonicalEditOperation[];
}

function motionOperation(
  operation: Extract<EditProgramStep, { kind: "create-motion" }>,
  transactionId: string,
  origin: OperationOrigin,
  index: number,
  transformedTargets: ReadonlyMap<string, Readonly<{ operationId: string; targetEntityId: string }>> = new Map(),
) {
  const replacements = operation.targetObjectIds.map((entityId) => transformedTargets.get(entityId));
  return {
    controlOffset: operation.controlOffset,
    delta: operation.delta,
    dependsOn: [...new Set(replacements.flatMap((replacement) => (
      replacement ? [replacement.operationId] : []
    )))],
    easing: operation.easing,
    id: operationId(transactionId, `motion-${index}`),
    interval: { end: operation.end, start: operation.start },
    kind: "CreateMotion",
    provenance: provenance(origin, ["language/direct-manipulation constraint", "new motion"]),
    targetEntityIds: operation.targetObjectIds.map((entityId, targetIndex) => (
      replacements[targetIndex]?.targetEntityId ?? entityId
    )),
  } satisfies CanonicalEditOperation;
}

type TargetReplacement = Readonly<{ operationId: string; targetEntityId: string }>;

type OperationBuildResult =
  | Readonly<{ kind: "invalid"; message: string }>
  | Readonly<{ kind: "valid"; operations: readonly CanonicalEditOperation[] }>;

const MIN_MAGIC_SCALE_FACTOR = 0.01;
const MAX_MAGIC_SCALE_FACTOR = 80;

function scaleOperations(
  operation: Omit<ScaleObjectsSuggestion, "anchor">,
  context: CanonicalizationContext,
  index: number,
  transformedTargets: ReadonlyMap<string, TargetReplacement>,
): OperationBuildResult {
  const operations: CanonicalEditOperation[] = [];
  for (const [targetIndex, logicalEntityId] of operation.targetObjectIds.entries()) {
    const entity = context.scene.objectGraph.entities[logicalEntityId];
    if (!entity) {
      return { kind: "invalid", message: `Scale target ${logicalEntityId} is no longer available.` };
    }
    if (!hasSafeMagicEditIdentity(entity)) {
      return {
        kind: "invalid",
        message: `Studio cannot scale ${logicalEntityId} safely: ${entity.sourceIdentity.kind === "unknown"
          ? entity.sourceIdentity.reason
          : "The source identity is not safe to mutate."}`,
      };
    }
    const scale = exactEntityScaleAt(context.scene, entity, operation.start);
    if (scale.kind === "unknown") {
      return {
        kind: "invalid",
        message: `Studio cannot scale ${logicalEntityId} safely: ${scale.reason}`,
      };
    }
    const targetScale = scale.value * operation.factor;
    if (
      !Number.isFinite(scale.value)
      || scale.value <= 0
      || !Number.isFinite(operation.factor)
      || operation.factor < MIN_MAGIC_SCALE_FACTOR
      || operation.factor > MAX_MAGIC_SCALE_FACTOR
      || !Number.isFinite(targetScale)
      || targetScale < MIN_ENTITY_SCALE
      || targetScale > MAX_ENTITY_SCALE
    ) {
      return {
        kind: "invalid",
        message: `Scale must produce an absolute value between ${MIN_ENTITY_SCALE}x and ${MAX_ENTITY_SCALE}x.`,
      };
    }
    const replacement = transformedTargets.get(logicalEntityId);
    operations.push({
      dependsOn: replacement ? [replacement.operationId] : [],
      easing: operation.easing,
      entityId: replacement?.targetEntityId ?? logicalEntityId,
      from: scale.value,
      id: operationId(context.transactionId, `scale-${index}-${targetIndex}`),
      interval: { end: operation.end, start: operation.start },
      key: "scale",
      kind: "AnimateProperty",
      provenance: provenance(context.origin, [
        "Magic Edit uniform scale",
        `${scale.value.toFixed(4)}x * ${operation.factor.toFixed(4)}`,
      ]),
      to: targetScale,
    });
  }
  return { kind: "valid", operations };
}

function deleteOperations(
  operation: Omit<DeleteObjectsSuggestion, "anchor">,
  context: CanonicalizationContext,
  index: number,
  transformedTargets: ReadonlyMap<string, TargetReplacement>,
): OperationBuildResult {
  const operations: CanonicalEditOperation[] = [];
  for (const [targetIndex, logicalEntityId] of operation.targetObjectIds.entries()) {
    const replacement = transformedTargets.get(logicalEntityId);
    const entity = context.scene.objectGraph.entities[logicalEntityId];
    if (!entity) {
      return { kind: "invalid", message: `Delete target ${logicalEntityId} is no longer available.` };
    }
    if (!hasSafeMagicEditIdentity(entity)) {
      return {
        kind: "invalid",
        message: `Studio cannot delete ${logicalEntityId} safely: ${entity.sourceIdentity.kind === "unknown"
          ? entity.sourceIdentity.reason
          : "The source identity is not safe to mutate."}`,
      };
    }
    operations.push({
      dependsOn: replacement ? [replacement.operationId] : [],
      effect: "remove",
      entityId: replacement?.targetEntityId ?? logicalEntityId,
      id: operationId(context.transactionId, `delete-${index}-${targetIndex}`),
      interval: { end: operation.end, start: operation.start },
      kind: "ChangePresence",
      persistent: true,
      provenance: provenance(context.origin, [operation.animation, "explicit Magic Edit deletion"]),
    });
  }
  return { kind: "valid", operations };
}

function transitionOperations(
  operation: Omit<CreateSceneTransitionSuggestion, "anchor">,
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

function intentCount(operation: EditSuggestionOperation) {
  if (operation.kind === "create-explained-equation") return 2;
  if (operation.kind !== "edit-program") return 1;
  return operation.operations.reduce((count, step) => (
    count + (step.kind === "create-explained-equation" ? 2 : 1)
  ), 0);
}

function requiresIllustrativeLowering(operation: EditSuggestionOperation) {
  const illustrativeKinds = new Set([
    "create-camera-focus",
  ]);
  return operation.kind === "edit-program"
    ? operation.operations.some((step) => illustrativeKinds.has(step.kind))
    : illustrativeKinds.has(operation.kind);
}

function requestedExecution(operation: EditSuggestionOperation) {
  if (operation.kind === "edit-program") return operation.execution;
  if (operation.kind === "create-camera-focus" || operation.kind === "create-explained-equation") {
    return "parallel" as const;
  }
  if (
    (operation.kind === "scale-objects" || operation.kind === "delete-objects")
    && operation.targetObjectIds.length > 1
  ) return "parallel" as const;
  return "sequence" as const;
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
      intentCount: intentCount(operation),
      loweringStatus: "unsupported",
      operations: [],
      provenance: provenance(context.origin, []),
      requestedExecution: requestedExecution(operation),
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

  const invalidCanonicalization = (message: string): ProgramValidationResult => ({
    issues: [{
      code: "schema-invalid",
      field: "operation",
      message,
      severity: "error",
    }],
    kind: "invalid",
    program: {
      anchor: resolution.anchor,
      intentCount: intentCount(operation),
      loweringStatus: "unsupported",
      operations: [],
      provenance: provenance(context.origin, [operation.kind]),
      requestedExecution: requestedExecution(operation),
      schedule: { edges: [], mode: "sequence", order: [] },
      transactionId: context.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
  });

  let operations: readonly CanonicalEditOperation[];
  if (operation.kind === "create-scene-transition") {
    operations = transitionOperations(operation, context.transactionId, context.origin);
  } else if (operation.kind === "create-camera-focus") {
    operations = cameraFocusOperations(operation, context.transactionId, context.origin);
  } else if (operation.kind === "create-equation") {
    operations = equationOperations(operation, context.transactionId, context.origin);
  } else if (operation.kind === "create-explained-equation") {
    operations = explainedEquationOperations(operation, context.transactionId, context.origin);
  } else if (operation.kind === "create-text-transform") {
    operations = [textTransformOperation(operation, context.transactionId, context.origin)];
  } else {
    const steps = operationSteps(operation);
    let buildFailure: string | null = null;
    const transformByIndex = new Map<number, ReturnType<typeof transformOperation>>();
    const transformsByStep = new Map<number, ReadonlyMap<string, Readonly<{
      operationId: string;
      targetEntityId: string;
    }>>>();
    if (operation.kind === "edit-program" && operation.execution === "parallel") {
      const parallelTransforms = new Map<string, Readonly<{ operationId: string; targetEntityId: string }>>();
      steps.forEach((step, index) => {
        if (step.kind !== "create-transform") return;
        const transformed = transformOperation(step, context.transactionId, context.origin, index);
        transformByIndex.set(index, transformed);
        parallelTransforms.set(step.sourceObjectId, {
          operationId: transformed.canonical.id,
          targetEntityId: transformed.targetEntityId,
        });
      });
      steps.forEach((_, index) => transformsByStep.set(index, parallelTransforms));
    } else {
      const latestTransforms = new Map<string, Readonly<{ operationId: string; targetEntityId: string }>>();
      steps.forEach((step, index) => {
        transformsByStep.set(index, new Map(latestTransforms));
        if (step.kind !== "create-transform") return;
        const previous = latestTransforms.get(step.sourceObjectId);
        const transformed = transformOperation(
          step,
          context.transactionId,
          context.origin,
          index,
          previous?.targetEntityId ?? step.sourceObjectId,
          previous ? [previous.operationId] : [],
        );
        transformByIndex.set(index, transformed);
        latestTransforms.set(step.sourceObjectId, {
          operationId: transformed.canonical.id,
          targetEntityId: transformed.targetEntityId,
        });
      });
    }
    operations = steps.flatMap((step, index): readonly CanonicalEditOperation[] => {
      if (step.kind === "create-motion") {
        return [motionOperation(
          step,
          context.transactionId,
          context.origin,
          index,
          operation.kind === "edit-program" && operation.execution === "sequence"
            ? transformsByStep.get(index)
            : undefined,
        )];
      }
      if (step.kind === "create-transform") return [transformByIndex.get(index)!.canonical];
      if (step.kind === "create-explanation") {
        return explanationOperations(
          step,
          context.transactionId,
          context.origin,
          index,
          transformsByStep.get(index) ?? new Map(),
        );
      }
      if (step.kind === "create-equation") {
        return equationOperations(step, context.transactionId, context.origin);
      }
      if (step.kind === "create-explained-equation") {
        return explainedEquationOperations(step, context.transactionId, context.origin);
      }
      if (step.kind === "create-scene-transition") {
        return transitionOperations(step, context.transactionId, context.origin);
      }
      if (step.kind === "scale-objects") {
        const result = scaleOperations(
          step,
          context,
          index,
          transformsByStep.get(index) ?? new Map(),
        );
        if (result.kind === "invalid") {
          buildFailure ??= result.message;
          return [];
        }
        return result.operations;
      }
      if (step.kind === "delete-objects") {
        const result = deleteOperations(
          step,
          context,
          index,
          transformsByStep.get(index) ?? new Map(),
        );
        if (result.kind === "invalid") {
          buildFailure ??= result.message;
          return [];
        }
        return result.operations;
      }
      return [];
    });
    if (buildFailure) return invalidCanonicalization(buildFailure);
  }

  const program: CanonicalEditProgram = {
    anchor: resolution.anchor,
    intentCount: intentCount(operation),
    loweringStatus: requiresIllustrativeLowering(operation) ? "illustrative" : "supported",
    operations,
    provenance: provenance(context.origin, [operation.kind]),
    requestedExecution: requestedExecution(operation),
    schedule: {
      edges: [],
      mode: requestedExecution(operation),
      order: operations.map((entry) => entry.id),
    },
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
    const position = input.positions[entityId];
    if (!position) throw new Error(`Direct manipulation requires a projected position for ${entityId}.`);
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
    loweringStatus: "supported",
    operations,
    provenance: provenance("direct-manipulation", ["gesture constraint"]),
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
    transactionId: input.transactionId,
    version: EDIT_OPERATION_VERSION,
  }, input.scene);
}

export function createDirectManipulationScaleProgram(
  input: Readonly<{
    capturedPlayhead: number;
    interval: Readonly<{ end: number; start: number }>;
    scales: Readonly<Record<string, Readonly<{ from: number; to: number }>>>;
    scene: RuntimeSceneState;
    targetEntityIds: readonly string[];
    transactionId: string;
  }>,
): ProgramValidationResult {
  const sourceAnchor = Math.abs(input.interval.start - input.capturedPlayhead) < 0.001
    ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
    : { kind: "absolute" as const, seconds: input.interval.start };
  const resolution = resolveTimeAnchorOnce(sourceAnchor, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operations = input.targetEntityIds.map((entityId, index): CanonicalEditOperation => {
    const scale = input.scales[entityId];
    if (!scale) throw new Error(`Direct manipulation requires a projected scale for ${entityId}.`);
    if (
      !Number.isFinite(scale.from)
      || !Number.isFinite(scale.to)
      || scale.from <= 0
      || scale.to <= 0
    ) {
      throw new Error("Object scale must be a finite positive number.");
    }
    return {
      dependsOn: [],
      easing: "smooth",
      entityId,
      from: scale.from,
      id: operationId(input.transactionId, `scale-${index}`),
      interval: input.interval,
      key: "scale",
      kind: "AnimateProperty",
      provenance: provenance("direct-manipulation", [
        "uniform resize gesture",
        `${scale.from.toFixed(4)}x to ${scale.to.toFixed(4)}x`,
      ]),
      to: scale.to,
    };
  });
  return validateAndScheduleProgram({
    anchor: resolution.anchor,
    intentCount: 1,
    loweringStatus: "supported",
    operations,
    provenance: provenance("direct-manipulation", ["uniform scale constraint"]),
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
