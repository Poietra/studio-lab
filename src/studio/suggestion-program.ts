import type {
  CreateCameraFocusSuggestion,
  CreateEquationSuggestion,
  CreateExplainedEquationSuggestion,
  CreateExplanationSuggestion,
  CreateSceneTransitionSuggestion,
  CreateTextTransformSuggestion,
  CreateTransformSuggestion,
  DeleteObjectsSuggestion,
  EditProgramStep,
  EditSuggestionOperation,
  ScaleObjectsSuggestion,
  SuggestionTimeAnchor,
} from "../ai/edit-suggestions";
import {
  exactEntityScaleAt,
  hasSafeMagicEditIdentity,
  MAX_ENTITY_SCALE,
  MIN_ENTITY_SCALE,
} from "./magic-edit-capabilities";
import type { EntityDimensions, Point, RuntimeSceneState } from "./model";
import { EDIT_OPERATION_VERSION, type OperationOrigin, operationId, provisionalEntityId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import { isCanonicalRgbHex, type SceneEdit, type SceneEditOperation } from "./scene-edit-contract";
import { STUDIO_STYLE_PROFILE } from "./style-profile";
import { resolveTimeAnchorOnce } from "./time";

type CanonicalizationContext = Readonly<{
  capturedPlayhead: number;
  origin: OperationOrigin;
  scene: RuntimeSceneState;
  transactionId: string;
}>;

const placementOffsets = {
  above: { x: 0, y: -STUDIO_STYLE_PROFILE.spacingUnitPx * 3 },
  below: { x: 0, y: STUDIO_STYLE_PROFILE.spacingUnitPx * 3 },
  left: { x: -STUDIO_STYLE_PROFILE.spacingUnitPx * 6, y: 0 },
  right: { x: STUDIO_STYLE_PROFILE.spacingUnitPx * 6, y: 0 },
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
    } satisfies SceneEditOperation,
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
  } satisfies SceneEditOperation;
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
      value:
        operation.placement === "right"
          ? { x: 320 + STUDIO_STYLE_PROFILE.spacingUnitPx * 7, y: 180 }
          : { x: 320, y: 180 },
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
  ] satisfies readonly SceneEditOperation[];
}

function cameraFocusOperations(operation: CreateCameraFocusSuggestion, transactionId: string, origin: OperationOrigin) {
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
    ...operation.targetObjectIds.map(
      (entityId, index): SceneEditOperation => ({
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
      }),
    ),
  ] satisfies readonly SceneEditOperation[];
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
  ] satisfies readonly SceneEditOperation[];
}

function explainedEquationOperations(
  operation: Omit<CreateExplainedEquationSuggestion, "anchor">,
  transactionId: string,
  origin: OperationOrigin,
) {
  const equationEntityId = provisionalEntityId(transactionId, "new-equation");
  return [
    ...equationOperations(operation, transactionId, origin),
    ...explanationOperations(
      {
        animation: operation.animation,
        end: operation.end,
        kind: "create-explanation",
        objectKind: "text",
        placement: operation.explanation.placement,
        start: operation.start,
        targetObjectId: equationEntityId,
        text: operation.explanation.text,
      },
      transactionId,
      origin,
      0,
      new Map(),
    ),
  ] satisfies readonly SceneEditOperation[];
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
    dependsOn: [...new Set(replacements.flatMap((replacement) => (replacement ? [replacement.operationId] : [])))],
    easing: operation.easing,
    id: operationId(transactionId, `motion-${index}`),
    interval: { end: operation.end, start: operation.start },
    kind: "CreateMotion",
    provenance: provenance(origin, ["language/direct-manipulation constraint", "new motion"]),
    ...(operation.orientToPath === true ? { orientToPath: true } : {}),
    ...(operation.rotationDeltaRadians == null ? {} : { rotationDeltaRadians: operation.rotationDeltaRadians }),
    targetEntityIds: operation.targetObjectIds.map(
      (entityId, targetIndex) => replacements[targetIndex]?.targetEntityId ?? entityId,
    ),
  } satisfies SceneEditOperation;
}

type TargetReplacement = Readonly<{ operationId: string; targetEntityId: string }>;

type OperationBuildResult =
  | Readonly<{ kind: "invalid"; message: string }>
  | Readonly<{ kind: "valid"; operations: readonly SceneEditOperation[] }>;

const MIN_MAGIC_SCALE_FACTOR = 0.01;
const MAX_MAGIC_SCALE_FACTOR = 80;

function scaleOperations(
  operation: Omit<ScaleObjectsSuggestion, "anchor">,
  context: CanonicalizationContext,
  index: number,
  transformedTargets: ReadonlyMap<string, TargetReplacement>,
): OperationBuildResult {
  const operations: SceneEditOperation[] = [];
  for (const [targetIndex, logicalEntityId] of operation.targetObjectIds.entries()) {
    const entity = context.scene.objectGraph.entities[logicalEntityId];
    if (!entity) {
      return { kind: "invalid", message: `Scale target ${logicalEntityId} is no longer available.` };
    }
    if (!hasSafeMagicEditIdentity(entity)) {
      return {
        kind: "invalid",
        message: `Studio cannot scale ${logicalEntityId} safely: ${
          entity.sourceIdentity.kind === "unknown"
            ? entity.sourceIdentity.reason
            : "The source identity is not safe to mutate."
        }`,
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
      !Number.isFinite(scale.value) ||
      scale.value <= 0 ||
      !Number.isFinite(operation.factor) ||
      operation.factor < MIN_MAGIC_SCALE_FACTOR ||
      operation.factor > MAX_MAGIC_SCALE_FACTOR ||
      !Number.isFinite(targetScale) ||
      targetScale < MIN_ENTITY_SCALE ||
      targetScale > MAX_ENTITY_SCALE
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
      relativeFactor: operation.factor,
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
  const operations: SceneEditOperation[] = [];
  for (const [targetIndex, logicalEntityId] of operation.targetObjectIds.entries()) {
    const replacement = transformedTargets.get(logicalEntityId);
    const entity = context.scene.objectGraph.entities[logicalEntityId];
    if (!entity) {
      return { kind: "invalid", message: `Delete target ${logicalEntityId} is no longer available.` };
    }
    if (!hasSafeMagicEditIdentity(entity)) {
      return {
        kind: "invalid",
        message: `Studio cannot delete ${logicalEntityId} safely: ${
          entity.sourceIdentity.kind === "unknown"
            ? entity.sourceIdentity.reason
            : "The source identity is not safe to mutate."
        }`,
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
  ] satisfies readonly SceneEditOperation[];
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
  return operation.operations.reduce((count, step) => count + (step.kind === "create-explained-equation" ? 2 : 1), 0);
}

function requiresIllustrativeLowering(operation: EditSuggestionOperation) {
  const illustrativeKinds = new Set(["create-camera-focus"]);
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
    (operation.kind === "scale-objects" || operation.kind === "delete-objects") &&
    operation.targetObjectIds.length > 1
  )
    return "parallel" as const;
  return "sequence" as const;
}

export function canonicalizeSuggestionProgram(
  operation: EditSuggestionOperation,
  context: CanonicalizationContext,
): SceneEditValidationResult {
  const resolution = resolveTimeAnchorOnce(operationAnchor(operation), {
    capturedPlayhead: context.capturedPlayhead,
    sceneDuration: context.scene.duration,
  });
  if (resolution.kind === "invalid") {
    const fallback: SceneEdit = {
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

  const invalidCanonicalization = (message: string): SceneEditValidationResult => ({
    issues: [
      {
        code: "schema-invalid",
        field: "operation",
        message,
        severity: "error",
      },
    ],
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

  let operations: readonly SceneEditOperation[];
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
    const transformsByStep = new Map<
      number,
      ReadonlyMap<
        string,
        Readonly<{
          operationId: string;
          targetEntityId: string;
        }>
      >
    >();
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
    operations = steps.flatMap((step, index): readonly SceneEditOperation[] => {
      if (step.kind === "create-motion") {
        return [
          motionOperation(
            step,
            context.transactionId,
            context.origin,
            index,
            operation.kind === "edit-program" && operation.execution === "sequence"
              ? transformsByStep.get(index)
              : undefined,
          ),
        ];
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
        const result = scaleOperations(step, context, index, transformsByStep.get(index) ?? new Map());
        if (result.kind === "invalid") {
          buildFailure ??= result.message;
          return [];
        }
        return result.operations;
      }
      if (step.kind === "delete-objects") {
        const result = deleteOperations(step, context, index, transformsByStep.get(index) ?? new Map());
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

  const program: SceneEdit = {
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
): SceneEditValidationResult {
  const sourceAnchor =
    Math.abs(input.start - input.capturedPlayhead) < 0.001
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start };
  const resolution = resolveTimeAnchorOnce(sourceAnchor, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") {
    throw new Error(resolution.message);
  }
  const operations = input.targetEntityIds.map((entityId, index): SceneEditOperation => {
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
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "supported",
      operations,
      provenance: provenance("direct-manipulation", ["gesture constraint"]),
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
}

export function createDirectManipulationRotationProgram(
  input: Readonly<{
    angleRadians: number;
    capturedPlayhead: number;
    entityId: string;
    scene: RuntimeSceneState;
    start: number;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  if (!Number.isFinite(input.angleRadians)) throw new Error("Object rotation must be a finite angle.");
  const normalizedAngle = Math.atan2(Math.sin(input.angleRadians), Math.cos(input.angleRadians));
  if (Math.abs(normalizedAngle) <= 1e-12) throw new Error("Object rotation must change the current angle.");
  if (
    !Number.isFinite(input.start) ||
    !Number.isFinite(input.capturedPlayhead) ||
    input.start < 0 ||
    input.start > input.scene.duration
  ) {
    throw new Error("Object rotation requires a valid source time inside the Scene.");
  }
  const sourceAnchor =
    Math.abs(input.start - input.capturedPlayhead) < 0.001
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start };
  const resolution = resolveTimeAnchorOnce(sourceAnchor, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operation: SceneEditOperation = {
    dependsOn: [],
    easing: "smooth",
    entityId: input.entityId,
    from: 0,
    id: operationId(input.transactionId, "set-rotation"),
    interval: { end: input.start, start: input.start },
    key: "rotation",
    kind: "AnimateProperty",
    provenance: provenance("direct-manipulation", ["rotation control", "relative planar angle"]),
    relativeDelta: input.angleRadians,
    to: input.angleRadians,
  };
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: provenance("direct-manipulation", ["center-pivot rotation constraint"]),
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
}

/** Creates one atomic Program for a rigid multi-selection rotation. Gesture
 * geometry stays in the presentation layer; Rust admits the resulting shared
 * position/rotation transform as one canonical authoring mutation. */
export function createDirectManipulationGroupRotationProgram(
  input: Readonly<{
    angleRadians: number;
    capturedPlayhead: number;
    scene: RuntimeSceneState;
    start: number;
    targets: readonly Readonly<{
      entityId: string;
      toPosition: Readonly<{ x: number; y: number }>;
    }>[];
    transactionId: string;
  }>,
): SceneEditValidationResult {
  if (input.targets.length < 2) throw new Error("Group rotation requires at least two objects.");
  const angleRadians = Math.atan2(Math.sin(input.angleRadians), Math.cos(input.angleRadians));
  if (!Number.isFinite(input.angleRadians) || Math.abs(angleRadians) <= 1e-12) {
    throw new Error("Group rotation must use one finite non-identity angle.");
  }
  const entityIds = new Set<string>();
  const positions: Record<string, Readonly<{ x: number; y: number }>> = {};
  for (const target of input.targets) {
    if (
      entityIds.has(target.entityId) ||
      !Number.isFinite(target.toPosition.x) ||
      !Number.isFinite(target.toPosition.y)
    ) {
      throw new Error("Group rotation requires unique objects with finite positions.");
    }
    entityIds.add(target.entityId);
    positions[target.entityId] = target.toPosition;
  }
  const targetEntityIds = input.targets.map(({ entityId }) => entityId);
  const position = createDirectManipulationPositionProgram({
    capturedPlayhead: input.capturedPlayhead,
    delta: { x: 0, y: 0 },
    positions,
    scene: input.scene,
    start: input.start,
    targetEntityIds,
    transactionId: input.transactionId,
  });
  if (position.kind === "invalid") return position;
  const rotations = targetEntityIds.map(
    (entityId, index): SceneEditOperation => ({
      dependsOn: [],
      easing: "smooth",
      entityId,
      from: 0,
      id: operationId(input.transactionId, `set-rotation-${index}`),
      interval: { end: input.start, start: input.start },
      key: "rotation",
      kind: "AnimateProperty",
      provenance: provenance("direct-manipulation", ["selection rotation", "shared planar angle"]),
      relativeDelta: angleRadians,
      to: angleRadians,
    }),
  );
  const operations = [...position.program.operations, ...rotations];
  return validateAndScheduleProgram(
    {
      ...position.program,
      intentCount: 1,
      operations,
      provenance: provenance("direct-manipulation", ["rigid selection rotation"]),
      schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
    },
    input.scene,
  );
}

export function createDirectManipulationOpacityProgram(
  input: Readonly<{
    capturedPlayhead: number;
    entityId: string;
    opacity: number;
    scene: RuntimeSceneState;
    start: number;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  if (!Number.isFinite(input.opacity) || input.opacity < 0 || input.opacity > 1) {
    throw new Error("Object opacity must be a finite number from 0 to 1.");
  }
  if (
    !Number.isFinite(input.start) ||
    !Number.isFinite(input.capturedPlayhead) ||
    input.start < 0 ||
    input.start > input.scene.duration
  ) {
    throw new Error("Object opacity requires a valid source time inside the Scene.");
  }
  const sourceAnchor =
    Math.abs(input.start - input.capturedPlayhead) < 0.001
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start };
  const resolution = resolveTimeAnchorOnce(sourceAnchor, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operation: SceneEditOperation = {
    dependsOn: [],
    entityId: input.entityId,
    id: operationId(input.transactionId, "set-opacity"),
    interval: { end: input.start, start: input.start },
    key: "appearance",
    kind: "SetProperty",
    provenance: provenance("direct-manipulation", ["opacity control", "absolute object opacity"]),
    value: input.opacity,
  };
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: provenance("direct-manipulation", ["absolute static appearance constraint"]),
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
}

/** Creates one persistent Studio-owned paint-order edit. The absolute value is
 * selected from the canonical Scene IR by the Layers presentation. */
export function createDirectManipulationLayerOrderProgram(
  input: Readonly<{
    capturedPlayhead: number;
    entityId: string;
    scene: RuntimeSceneState;
    sourceZIndex: number;
    start: number;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  if (!Number.isFinite(input.sourceZIndex)) throw new Error("Layer order requires a finite canonical z-index.");
  if (
    !Number.isFinite(input.start) ||
    !Number.isFinite(input.capturedPlayhead) ||
    input.start < 0 ||
    input.start > input.scene.duration
  ) {
    throw new Error("Layer order requires a valid source time inside the Scene.");
  }
  const resolution = resolveTimeAnchorOnce(
    Math.abs(input.start - input.capturedPlayhead) < 0.001
      ? { kind: "playhead", referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute", seconds: input.start },
    { capturedPlayhead: input.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operation: SceneEditOperation = {
    dependsOn: [],
    entityId: input.entityId,
    id: operationId(input.transactionId, "set-layer-order"),
    interval: { end: input.start, start: input.start },
    key: "sourceZIndex",
    kind: "SetProperty",
    provenance: provenance("direct-manipulation", ["Layers panel", "absolute canonical z-index"]),
    value: input.sourceZIndex,
  };
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: provenance("direct-manipulation", ["persistent paint order"]),
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
}

/** Reorders every leaf in one logical group through one parallel Program. */
export function createDirectManipulationGroupLayerOrderProgram(
  input: Readonly<{
    capturedPlayhead: number;
    scene: RuntimeSceneState;
    start: number;
    targets: readonly Readonly<{ entityId: string; fromSourceZIndex: number; sourceZIndex: number }>[];
    transactionId: string;
  }>,
): SceneEditValidationResult {
  if (
    input.targets.length < 2 ||
    new Set(input.targets.map(({ entityId }) => entityId)).size !== input.targets.length ||
    input.targets.some(
      ({ fromSourceZIndex, sourceZIndex }) => !Number.isFinite(fromSourceZIndex) || !Number.isFinite(sourceZIndex),
    )
  ) {
    throw new Error("Group layer order requires at least two unique entities with finite canonical z-indices.");
  }
  if (
    !Number.isFinite(input.start) ||
    !Number.isFinite(input.capturedPlayhead) ||
    input.start < 0 ||
    input.start > input.scene.duration
  ) {
    throw new Error("Group layer order requires a valid source time inside the Scene.");
  }
  const resolution = resolveTimeAnchorOnce(
    Math.abs(input.start - input.capturedPlayhead) < 0.001
      ? { kind: "playhead", referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute", seconds: input.start },
    { capturedPlayhead: input.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operations: SceneEditOperation[] = input.targets.map(({ entityId, fromSourceZIndex, sourceZIndex }, index) => ({
    dependsOn: [],
    documentStatic: true,
    entityId,
    from: fromSourceZIndex,
    id: operationId(input.transactionId, `set-layer-order-${index}`),
    interval: { end: input.start, start: input.start },
    key: "sourceZIndex",
    kind: "SetProperty",
    provenance: provenance("direct-manipulation", ["Layers panel", "atomic logical group z-index"]),
    value: sourceZIndex,
  }));
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "unsupported",
      operations,
      provenance: provenance("direct-manipulation", ["document-static logical group paint order"]),
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: operations.map(({ id }) => id) },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
}

/** Creates one static Studio-owned visibility edit. Visibility is separate
 * from opacity and lifetime and is evaluated by the canonical Rust Scene. */
export function createDirectManipulationVisibilityProgram(
  input: Readonly<{
    capturedPlayhead: number;
    entityId: string;
    scene: RuntimeSceneState;
    start: number;
    transactionId: string;
    visible: boolean;
  }>,
): SceneEditValidationResult {
  return createDirectManipulationVisibilityProgramForEntities(input, [input.entityId]);
}

/** Creates one atomic static-visibility Program for the canonical children of
 * a Studio logical group. Group membership is projected from Scene IR by the
 * caller; Rust still admits and applies the complete multi-entity Program. */
export function createDirectManipulationGroupVisibilityProgram(
  input: Readonly<{
    capturedPlayhead: number;
    entityIds: readonly string[];
    scene: RuntimeSceneState;
    start: number;
    transactionId: string;
    visible: boolean;
  }>,
): SceneEditValidationResult {
  if (input.entityIds.length < 2) throw new Error("Group visibility requires at least two objects.");
  return createDirectManipulationVisibilityProgramForEntities(input, input.entityIds);
}

function createDirectManipulationVisibilityProgramForEntities(
  input: Readonly<{
    capturedPlayhead: number;
    scene: RuntimeSceneState;
    start: number;
    transactionId: string;
    visible: boolean;
  }>,
  entityIds: readonly string[],
): SceneEditValidationResult {
  if (
    !Number.isFinite(input.start) ||
    !Number.isFinite(input.capturedPlayhead) ||
    input.start < 0 ||
    input.start > input.scene.duration
  ) {
    throw new Error("Layer visibility requires a valid source time inside the Scene.");
  }
  const resolution = resolveTimeAnchorOnce(
    Math.abs(input.start - input.capturedPlayhead) < 0.001
      ? { kind: "playhead", referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute", seconds: input.start },
    { capturedPlayhead: input.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  if (new Set(entityIds).size !== entityIds.length) {
    throw new Error("Group visibility requires unique objects.");
  }
  const operations = entityIds.map(
    (entityId, index): SceneEditOperation => ({
      dependsOn: [],
      entityId,
      id: operationId(input.transactionId, entityIds.length === 1 ? "set-visibility" : `set-visibility-${index}`),
      interval: { end: input.start, start: input.start },
      key: "visibility",
      kind: "SetProperty",
      provenance: provenance("direct-manipulation", ["Layers panel", "static canonical visibility"]),
      value: input.visible,
    }),
  );
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "unsupported",
      operations,
      provenance: provenance("direct-manipulation", ["static document visibility"]),
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: operations.map(({ id }) => id) },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
}

export function createDirectManipulationColorProgram(
  input: Readonly<{
    capturedPlayhead: number;
    color: string;
    entityId: string;
    property: "fillColor" | "strokeColor";
    scene: RuntimeSceneState;
    start: number;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  if (!isCanonicalRgbHex(input.color)) {
    throw new Error("Object color must be a lowercase canonical #rrggbb value.");
  }
  if (
    !Number.isFinite(input.start) ||
    !Number.isFinite(input.capturedPlayhead) ||
    input.start < 0 ||
    input.start > input.scene.duration
  ) {
    throw new Error("Object color requires a valid source time inside the Scene.");
  }
  const sourceAnchor =
    Math.abs(input.start - input.capturedPlayhead) < 0.001
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start };
  const resolution = resolveTimeAnchorOnce(sourceAnchor, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operation: SceneEditOperation = {
    dependsOn: [],
    entityId: input.entityId,
    id: operationId(input.transactionId, `set-${input.property}`),
    interval: { end: input.start, start: input.start },
    key: input.property,
    kind: "SetProperty",
    provenance: provenance("direct-manipulation", [`${input.property} control`, "absolute shape color"]),
    value: input.color,
  };
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: provenance("direct-manipulation", ["absolute static shape color constraint"]),
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
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
): SceneEditValidationResult {
  const sourceAnchor =
    Math.abs(input.interval.start - input.capturedPlayhead) < 0.001
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.interval.start };
  const resolution = resolveTimeAnchorOnce(sourceAnchor, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operations = input.targetEntityIds.map((entityId, index): SceneEditOperation => {
    const scale = input.scales[entityId];
    if (!scale) throw new Error(`Direct manipulation requires a projected scale for ${entityId}.`);
    if (!Number.isFinite(scale.from) || !Number.isFinite(scale.to) || scale.from <= 0 || scale.to <= 0) {
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
      relativeFactor: scale.to / scale.from,
      to: scale.to,
    };
  });
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "supported",
      operations,
      provenance: provenance("direct-manipulation", ["uniform scale constraint"]),
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
}

/** Creates one atomic Program for a uniform resize around a shared selection
 * pivot. Pointer geometry stays in the presentation layer; this command owns
 * only the resulting canonical positions and scales. */
export function createDirectManipulationGroupResizeProgram(
  input: Readonly<{
    capturedPlayhead: number;
    scene: RuntimeSceneState;
    start: number;
    targets: readonly Readonly<{
      entityId: string;
      fromScale: number;
      toPosition: Readonly<{ x: number; y: number }>;
      toScale: number;
    }>[];
    transactionId: string;
  }>,
): SceneEditValidationResult {
  if (input.targets.length < 2) throw new Error("Group resize requires at least two objects.");
  const entityIds = new Set<string>();
  let uniformFactor: number | null = null;
  const positions: Record<string, Readonly<{ x: number; y: number }>> = {};
  const scales: Record<string, Readonly<{ from: number; to: number }>> = {};
  for (const target of input.targets) {
    if (
      !entityIds.add(target.entityId) ||
      !Number.isFinite(target.toPosition.x) ||
      !Number.isFinite(target.toPosition.y) ||
      !Number.isFinite(target.fromScale) ||
      !Number.isFinite(target.toScale) ||
      target.fromScale <= 0 ||
      target.toScale <= 0
    ) {
      throw new Error("Group resize requires unique objects with finite positions and positive scales.");
    }
    const factor = target.toScale / target.fromScale;
    if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) <= 1e-12) {
      throw new Error("Group resize must apply one finite non-identity scale factor.");
    }
    if (uniformFactor === null) uniformFactor = factor;
    else if (Math.abs(factor - uniformFactor) > 1e-9) {
      throw new Error("Every object in a group resize must use the same scale factor.");
    }
    positions[target.entityId] = target.toPosition;
    scales[target.entityId] = { from: target.fromScale, to: target.toScale };
  }
  const targetEntityIds = input.targets.map(({ entityId }) => entityId);
  const position = createDirectManipulationPositionProgram({
    capturedPlayhead: input.capturedPlayhead,
    delta: { x: 0, y: 0 },
    positions,
    scene: input.scene,
    start: input.start,
    targetEntityIds,
    transactionId: input.transactionId,
  });
  if (position.kind === "invalid") return position;
  const scale = createDirectManipulationScaleProgram({
    capturedPlayhead: input.capturedPlayhead,
    interval: { end: input.start, start: input.start },
    scales,
    scene: input.scene,
    targetEntityIds,
    transactionId: input.transactionId,
  });
  if (scale.kind === "invalid") return scale;
  const operations = [...position.program.operations, ...scale.program.operations];
  return validateAndScheduleProgram(
    {
      ...position.program,
      intentCount: 1,
      operations,
      provenance: provenance("direct-manipulation", ["uniform selection resize"]),
      schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
    },
    input.scene,
  );
}

export function createDirectManipulationResizeProgram(
  input: Readonly<{
    capturedPlayhead: number;
    entityId: string;
    from: Readonly<{ dimensions: EntityDimensions; position: Point }>;
    interval: Readonly<{ end: number; start: number }>;
    scale: number;
    scene: RuntimeSceneState;
    shape: "circle" | "rectangle";
    to: Readonly<{ dimensions: EntityDimensions; position: Point }>;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const sourceAnchor =
    Math.abs(input.interval.start - input.capturedPlayhead) < 0.001
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.interval.start };
  const resolution = resolveTimeAnchorOnce(sourceAnchor, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") throw new Error(resolution.message);
  const operation: SceneEditOperation = {
    dependsOn: [],
    entityId: input.entityId,
    from: input.from,
    id: operationId(input.transactionId, "resize-shape"),
    interval: input.interval,
    kind: "ResizeEntity",
    provenance: provenance("direct-manipulation", [`${input.shape} geometry resize`, "opposite edge anchored"]),
    scale: input.scale,
    shape: input.shape,
    to: input.to,
  };
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: provenance("direct-manipulation", ["shape-aware resize constraint"]),
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
}
