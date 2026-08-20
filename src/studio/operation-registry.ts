import { canonicalEditableContent, STUDIO_CREATION_TEXT_CONTRACT, studioCreationText } from "./editable-content";
import { exactEntityScaleAt, MAX_ENTITY_SCALE, MIN_ENTITY_SCALE } from "./magic-edit-capabilities";
import type { EntityDimensions, PropertyChannel, RuntimeSceneState } from "./model";
import type { ChannelAccess, SceneEditValidationIssue } from "./operations";
import {
  isEntityDimensionsValue,
  isPointValue,
  samplePropertyKnowledge,
  samplePropertyValue,
} from "./property-sampling";
import {
  isCanonicalRgbHex,
  type SceneEdit,
  type SceneEditOperation,
  sceneEditOperationSchema,
} from "./scene-edit-contract";

export { sceneEditOperationSchema as canonicalOperationSchema } from "./scene-edit-contract";

export type OperationExecutionCapabilities = Readonly<{
  apply: "blocked" | "supported";
  applyBlocker: string | null;
  lowering: "illustrative" | "supported" | "unsupported";
}>;

export type ProgramExecutionCapabilities = OperationExecutionCapabilities;

type Capability<TKind extends SceneEditOperation["kind"]> = Readonly<{
  access: (operation: Extract<SceneEditOperation, { kind: TKind }>) => Readonly<{
    reads: readonly ChannelAccess[];
    writes: readonly ChannelAccess[];
  }>;
  execution: (operation: Extract<SceneEditOperation, { kind: TKind }>) => OperationExecutionCapabilities;
  validate: (
    operation: Extract<SceneEditOperation, { kind: TKind }>,
    scene: RuntimeSceneState,
  ) => readonly SceneEditValidationIssue[];
}>;

const SUPPORTED_EXECUTION: OperationExecutionCapabilities = {
  apply: "supported",
  applyBlocker: null,
  lowering: "supported",
};
const CLIENT_ONLY_EXECUTION: OperationExecutionCapabilities = {
  apply: "supported",
  applyBlocker: null,
  lowering: "unsupported",
};
const SOURCE_LOWERING_EPSILON = 0.0005;

function previewOnlyExecution(
  applyBlocker: string,
  lowering: OperationExecutionCapabilities["lowering"] = "illustrative",
): OperationExecutionCapabilities {
  return {
    apply: "blocked",
    applyBlocker,
    lowering,
  };
}

function finiteNonNoopRotationDelta(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(Math.atan2(Math.sin(value), Math.cos(value))) > 1e-12
  );
}

function createEntityExecution(
  operation: Extract<SceneEditOperation, { kind: "CreateEntity" }>,
): OperationExecutionCapabilities {
  const { content, type } = operation.entity;
  const hasMathTexContent =
    type === "MathTex" && ((content?.texParts?.length ?? 0) > 0 || (content?.displayLines?.length ?? 0) > 0);
  const hasTextContent = type === "Text" && studioCreationText(content) !== null;
  const isBuiltIn = ["Arrow", "Circle", "Line", "Rectangle", "Square"].includes(type);
  const isTransitionOverlay = /^TransitionOverlay:(circle|diamond|hexagon):(black|sky|white)$/.test(type);
  if (hasMathTexContent || hasTextContent || isBuiltIn || isTransitionOverlay) return SUPPORTED_EXECUTION;
  return previewOnlyExecution(`CreateEntity type ${type} can be previewed, but it has no safe Manim source lowering.`);
}

function setPropertyExecution(
  operation: Extract<SceneEditOperation, { kind: "SetProperty" }>,
): OperationExecutionCapabilities {
  if (operation.key === "position" && isPointValue(operation.value)) return SUPPORTED_EXECUTION;
  if (
    operation.key === "appearance" &&
    typeof operation.value === "number" &&
    Number.isFinite(operation.value) &&
    operation.value >= 0 &&
    operation.value <= 1
  )
    return SUPPORTED_EXECUTION;
  if ((operation.key === "fillColor" || operation.key === "strokeColor") && isCanonicalRgbHex(operation.value))
    return SUPPORTED_EXECUTION;
  if (operation.key === "sourceZIndex" && typeof operation.value === "number" && Number.isFinite(operation.value))
    return SUPPORTED_EXECUTION;
  if (operation.key === "visibility" && typeof operation.value === "boolean") return CLIENT_ONLY_EXECUTION;
  if (operation.key === "content") {
    if (canonicalEditableContent(operation.value, "Text") || canonicalEditableContent(operation.value, "MathTex"))
      return SUPPORTED_EXECUTION;
    return previewOnlyExecution("SetProperty content has no truthful source lowering.");
  }
  return previewOnlyExecution(
    `SetProperty ${operation.key} can be previewed, but it has no truthful Manim source lowering.`,
  );
}

function animatePropertyExecution(
  operation: Extract<SceneEditOperation, { kind: "AnimateProperty" }>,
): OperationExecutionCapabilities {
  if (
    operation.timelineTrack === true &&
    typeof operation.from === "number" &&
    typeof operation.to === "number" &&
    Number.isFinite(operation.from) &&
    Number.isFinite(operation.to) &&
    ((operation.key === "scale" && operation.from > 0 && operation.to > 0) || operation.key === "rotation") &&
    (operation.interval.end > operation.interval.start || operation.from === operation.to)
  ) {
    return CLIENT_ONLY_EXECUTION;
  }
  if (
    operation.key === "appearance" &&
    operation.materialParameter !== undefined &&
    typeof operation.from === "number" &&
    typeof operation.to === "number" &&
    Number.isFinite(operation.from) &&
    Number.isFinite(operation.to) &&
    (operation.interval.end > operation.interval.start || operation.from === operation.to)
  ) {
    return CLIENT_ONLY_EXECUTION;
  }
  if (
    operation.key === "appearance" &&
    operation.materialParameter === undefined &&
    typeof operation.from === "number" &&
    typeof operation.to === "number" &&
    Number.isFinite(operation.from) &&
    Number.isFinite(operation.to) &&
    operation.from >= 0 &&
    operation.from <= 1 &&
    operation.to >= 0 &&
    operation.to <= 1 &&
    (operation.interval.end > operation.interval.start || operation.from === operation.to)
  ) {
    return CLIENT_ONLY_EXECUTION;
  }
  if (
    operation.key === "rotation" &&
    operation.control === undefined &&
    operation.relativeFactor === undefined &&
    operation.interval.start === operation.interval.end &&
    Number.isFinite(operation.interval.start) &&
    operation.interval.start >= 0 &&
    operation.from === 0 &&
    finiteNonNoopRotationDelta(operation.relativeDelta) &&
    operation.to === operation.relativeDelta
  ) {
    return SUPPORTED_EXECUTION;
  }
  if (
    operation.key === "scale" &&
    typeof operation.from === "number" &&
    typeof operation.to === "number" &&
    Number.isFinite(operation.from) &&
    Number.isFinite(operation.to) &&
    operation.from > 0 &&
    operation.to > 0
  )
    return SUPPORTED_EXECUTION;
  const reason =
    operation.key === "scale"
      ? "Scale animation requires finite positive absolute from and to values before it can be lowered to Manim source."
      : `AnimateProperty ${operation.key} can be previewed, but it has no truthful Manim source lowering.`;
  return previewOnlyExecution(reason);
}

function createMotionExecution(
  operation: Extract<SceneEditOperation, { kind: "CreateMotion" }>,
): OperationExecutionCapabilities {
  if (operation.interval.end - operation.interval.start <= SOURCE_LOWERING_EPSILON) {
    return previewOnlyExecution(
      "A zero-duration CreateMotion can be previewed, but it cannot be lowered truthfully to Manim source.",
    );
  }
  const curved = Math.abs(operation.controlOffset.x) > 0.001 || Math.abs(operation.controlOffset.y) > 0.001;
  if (curved || operation.delta.x !== 0 || operation.delta.y !== 0) return SUPPORTED_EXECUTION;
  return previewOnlyExecution(
    "A straight CreateMotion with no displacement can be previewed, but it cannot be lowered to Manim source.",
  );
}

function changePresenceExecution(
  operation: Extract<SceneEditOperation, { kind: "ChangePresence" }>,
): OperationExecutionCapabilities {
  const hasDuration = operation.interval.end - operation.interval.start > 0.0005;
  if (hasDuration || operation.effect === "remove") return SUPPORTED_EXECUTION;
  return previewOnlyExecution(
    `Zero-duration ${operation.effect} can be previewed, but it has no truthful Manim source lowering.`,
  );
}

function operationSourceTime(operation: SceneEditOperation) {
  return operation.kind === "InsertSceneBoundary" ? operation.at : operation.interval.start;
}

function sourceAnimationEnd(operation: SceneEditOperation) {
  if (operation.interval.end - operation.interval.start <= SOURCE_LOWERING_EPSILON) return null;
  if (
    operation.kind === "ChangePresence" ||
    operation.kind === "CreateMotion" ||
    operation.kind === "ResizeEntity" ||
    operation.kind === "TransformContent" ||
    (operation.kind === "AnimateProperty" && operation.key === "scale" && operation.timelineTrack !== true)
  )
    return operation.interval.end;
  return null;
}

function programStructureBlocker(program: SceneEdit) {
  const scheduleIndex = new Map(program.schedule.order.map((id, index) => [id, index]));
  const operations = [...program.operations].sort(
    (left, right) =>
      operationSourceTime(left) - operationSourceTime(right) ||
      (scheduleIndex.get(left.id) ?? 0) - (scheduleIndex.get(right.id) ?? 0),
  );
  const buckets: Array<Readonly<{ operations: SceneEditOperation[]; time: number }>> = [];
  for (const operation of operations) {
    const time = operationSourceTime(operation);
    const current = buckets.at(-1);
    if (current && Math.abs(current.time - time) < SOURCE_LOWERING_EPSILON) current.operations.push(operation);
    else buckets.push({ operations: [operation], time });
  }
  let cursor = program.anchor.resolvedSeconds;
  for (const bucket of buckets) {
    if (bucket.time > cursor + SOURCE_LOWERING_EPSILON) cursor = bucket.time;
    if (bucket.time < cursor - SOURCE_LOWERING_EPSILON) {
      return `Operation at ${bucket.time.toFixed(3)}s overlaps source time already lowered through ${cursor.toFixed(3)}s.`;
    }
    const waits = bucket.operations.filter(
      (operation) => operation.kind === "InsertTimelineEvent" && operation.eventKind === "wait",
    );
    if (waits.length > 0) {
      if (waits.length !== 1 || bucket.operations.length !== 1) {
        return "An inserted wait must occupy its own source interval.";
      }
      cursor = waits[0].interval.end;
      continue;
    }
    const animationEnds = bucket.operations.flatMap((operation) => {
      const end = sourceAnimationEnd(operation);
      return end === null ? [] : [end];
    });
    if (animationEnds.length === 0) continue;
    if (animationEnds.some((end) => Math.abs(end - animationEnds[0]) >= SOURCE_LOWERING_EPSILON)) {
      return "Concurrent source animations must share one interval.";
    }
    cursor = animationEnds[0];
  }
  return null;
}

function propertyKey(entityId: string, key: PropertyChannel["key"]) {
  return `${entityId}/${key}`;
}

function baseIssues(operation: SceneEditOperation, scene: RuntimeSceneState): SceneEditValidationIssue[] {
  const issues: SceneEditValidationIssue[] = [];
  if (
    !Number.isFinite(operation.interval.start) ||
    !Number.isFinite(operation.interval.end) ||
    operation.interval.start < 0 ||
    operation.interval.end > scene.duration ||
    operation.interval.end < operation.interval.start
  ) {
    issues.push({
      code: "interval-invalid",
      field: "interval",
      message: "The operation interval must stay within the active Scene.",
      operationId: operation.id,
      severity: "error",
    });
  }
  return issues;
}

function entityIssues(entityIds: readonly string[], operation: SceneEditOperation, scene: RuntimeSceneState) {
  const issues = baseIssues(operation, scene);
  for (const entityId of entityIds) {
    const entity = scene.objectGraph.entities[entityId];
    if (!entity && !entityId.startsWith("tx:")) {
      issues.push({
        code: "target-missing" as const,
        field: "target",
        message: `Target ${entityId} does not exist in RuntimeSceneState.`,
        operationId: operation.id,
        severity: "error" as const,
      });
      continue;
    }
    const activeLifetime = entity?.lifetime.find(
      (lifetime) => operation.interval.start >= lifetime.start && operation.interval.start < lifetime.end,
    );
    if (entity && !activeLifetime) {
      issues.push({
        code: "lifetime-unknown" as const,
        field: "interval.start",
        message: `Target ${entityId} is not present at the operation start.`,
        operationId: operation.id,
        severity: "error" as const,
      });
    } else if (activeLifetime && operation.interval.end > activeLifetime.end) {
      issues.push({
        code: "lifetime-unknown" as const,
        field: "interval.end",
        message: `Target ${entityId} leaves the Scene before the operation ends.`,
        operationId: operation.id,
        severity: "error" as const,
      });
    }
  }
  return issues;
}

const TIME_EPSILON = 0.0005;

function validCreateDimensions(type: string, dimensions: EntityDimensions | undefined) {
  if (dimensions === undefined) return true;
  if (type === "Circle") return exactShapeDimensions("circle", dimensions);
  if (type === "Rectangle") return exactShapeDimensions("rectangle", dimensions);
  return false;
}

function exactShapeDimensions(shape: "circle" | "rectangle", dimensions: EntityDimensions) {
  return shape === "circle"
    ? dimensions.radius !== undefined && dimensions.height === undefined && dimensions.width === undefined
    : dimensions.height !== undefined && dimensions.width !== undefined && dimensions.radius === undefined;
}

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) < 0.001;
}

function matchingResizeStart(
  operation: Extract<SceneEditOperation, { kind: "ResizeEntity" }>,
  scene: RuntimeSceneState,
) {
  const dimensionsSamples = scene.propertyChannels[propertyKey(operation.entityId, "dimensions")]?.samples ?? [];
  const positionSamples = scene.propertyChannels[propertyKey(operation.entityId, "position")]?.samples ?? [];
  const scaleSamples = scene.propertyChannels[propertyKey(operation.entityId, "scale")]?.samples ?? [];
  const sampledDimensions = samplePropertyValue(dimensionsSamples, operation.interval.start);
  const position = samplePropertyValue(positionSamples, operation.interval.start);
  const sampledScale = samplePropertyValue(scaleSamples, operation.interval.start);
  const entity = scene.objectGraph.entities[operation.entityId];
  const dimensions = isEntityDimensionsValue(sampledDimensions)
    ? sampledDimensions
    : entity?.geometry?.dimensions.kind === "known"
      ? entity.geometry.dimensions.value
      : entity?.type === "Circle"
        ? { radius: 1 }
        : entity?.type === "Rectangle"
          ? { height: 2, width: 4 }
          : undefined;
  const scale =
    typeof sampledScale === "number"
      ? sampledScale
      : entity?.geometry?.scale.kind === "known"
        ? entity.geometry.scale.value
        : 1;
  const dimensionsKnowledge = dimensions
    ? samplePropertyKnowledge(dimensionsSamples, operation.interval.start, dimensions)
    : undefined;
  const positionKnowledge = isPointValue(position)
    ? samplePropertyKnowledge(positionSamples, operation.interval.start, position)
    : undefined;
  const scaleKnowledge =
    typeof sampledScale === "number"
      ? samplePropertyKnowledge(scaleSamples, operation.interval.start, scale)
      : undefined;
  const dimensionsMatch =
    operation.shape === "circle"
      ? dimensions !== undefined &&
        dimensions.radius !== undefined &&
        operation.from.dimensions.radius !== undefined &&
        closeEnough(dimensions.radius, operation.from.dimensions.radius)
      : dimensions !== undefined &&
        dimensions.width !== undefined &&
        dimensions.height !== undefined &&
        operation.from.dimensions.width !== undefined &&
        operation.from.dimensions.height !== undefined &&
        closeEnough(dimensions.width, operation.from.dimensions.width) &&
        closeEnough(dimensions.height, operation.from.dimensions.height);
  return (
    dimensionsMatch &&
    exactShapeDimensions(operation.shape, operation.from.dimensions) &&
    exactShapeDimensions(operation.shape, operation.to.dimensions) &&
    !(dimensionsSamples.length === 0 && entity?.geometry?.dimensions.kind === "unknown") &&
    dimensionsKnowledge?.kind !== "unknown" &&
    isPointValue(position) &&
    positionKnowledge?.kind !== "unknown" &&
    closeEnough(position.x, operation.from.position.x) &&
    closeEnough(position.y, operation.from.position.y) &&
    !(scaleSamples.length === 0 && entity?.geometry?.scale.kind === "unknown") &&
    scaleKnowledge?.kind !== "unknown" &&
    closeEnough(scale, operation.scale)
  );
}

function setPropertyIssues(operation: Extract<SceneEditOperation, { kind: "SetProperty" }>, scene: RuntimeSceneState) {
  const issues = entityIssues([operation.entityId], operation, scene);
  if (
    operation.key === "position" &&
    (!isPointValue(operation.value) || !Number.isFinite(operation.value.x) || !Number.isFinite(operation.value.y))
  ) {
    issues.push({
      code: "schema-invalid" as const,
      field: "value",
      message: "Position edits require finite x and y values.",
      operationId: operation.id,
      severity: "error" as const,
    });
  }
  if (
    operation.key === "appearance" &&
    (typeof operation.value !== "number" ||
      !Number.isFinite(operation.value) ||
      operation.value < 0 ||
      operation.value > 1)
  ) {
    issues.push({
      code: "schema-invalid" as const,
      field: "value",
      message: "Opacity edits require a finite value between zero and one.",
      operationId: operation.id,
      severity: "error" as const,
    });
  }
  if (operation.key === "rotation" && (typeof operation.value !== "number" || !Number.isFinite(operation.value))) {
    issues.push({
      code: "schema-invalid" as const,
      field: "value",
      message: "Rotation edits require a finite angle in radians.",
      operationId: operation.id,
      severity: "error" as const,
    });
  }
  if (operation.key === "sourceZIndex") {
    if (typeof operation.value !== "number" || !Number.isFinite(operation.value)) {
      issues.push({
        code: "schema-invalid" as const,
        field: "value",
        message: "Layer order edits require a finite canonical z-index.",
        operationId: operation.id,
        severity: "error" as const,
      });
    }
    if (!scene.objectGraph.entities[operation.entityId]?.transactionId) {
      issues.push({
        code: "lowering-unsupported" as const,
        field: "entityId",
        message: "Layer order edits currently support only Studio-created objects.",
        operationId: operation.id,
        severity: "error" as const,
      });
    }
  }
  if (operation.key === "visibility") {
    if (typeof operation.value !== "boolean") {
      issues.push({
        code: "schema-invalid" as const,
        field: "value",
        message: "Layer visibility requires a boolean value.",
        operationId: operation.id,
        severity: "error" as const,
      });
    }
    if (!scene.objectGraph.entities[operation.entityId]?.transactionId) {
      issues.push({
        code: "lowering-unsupported" as const,
        field: "entityId",
        message: "Layer visibility currently supports only Studio-created root objects.",
        operationId: operation.id,
        severity: "error" as const,
      });
    }
  }
  if (operation.key === "content") {
    const entity = scene.objectGraph.entities[operation.entityId];
    const type = entity?.type === "Text" || entity?.type === "MathTex" ? entity.type : null;
    if (!type || !canonicalEditableContent(operation.value, type)) {
      issues.push({
        code: "schema-invalid" as const,
        field: "value",
        message: "Content edits must match a Text or MathTex target with non-empty content.",
        operationId: operation.id,
        severity: "error" as const,
      });
    }
  }
  if (operation.key === "fillColor" || operation.key === "strokeColor") {
    const entity = scene.objectGraph.entities[operation.entityId];
    if (!isCanonicalRgbHex(operation.value)) {
      issues.push({
        code: "schema-invalid" as const,
        field: "value",
        message: "Shape colors require a lowercase canonical #rrggbb value.",
        operationId: operation.id,
        severity: "error" as const,
      });
    }
    if (!entity?.transactionId || (entity.type !== "Circle" && entity.type !== "Rectangle")) {
      issues.push({
        code: "schema-invalid" as const,
        field: "entityId",
        message: "Shape colors currently support only Studio-created Circle and Rectangle entities.",
        operationId: operation.id,
        severity: "error" as const,
      });
    }
  }
  return issues;
}

export const OPERATION_REGISTRY = {
  CreateEntity: {
    access: (operation) => ({
      reads: [],
      writes: [
        { channel: "identity", entityId: operation.entity.id },
        { channel: "presence", entityId: operation.entity.id },
      ],
    }),
    execution: createEntityExecution,
    validate: (operation, scene) => {
      const issues = baseIssues(operation, scene);
      if (!validCreateDimensions(operation.entity.type, operation.entity.dimensions)) {
        issues.push({
          code: "schema-invalid",
          field: "entity.dimensions",
          message: `CreateEntity dimensions do not match ${operation.entity.type}.`,
          operationId: operation.id,
          severity: "error",
        });
      }
      if (operation.entity.type === "Text" && !studioCreationText(operation.entity.content)) {
        issues.push({
          code: "schema-invalid",
          field: "entity.content",
          message: STUDIO_CREATION_TEXT_CONTRACT,
          operationId: operation.id,
          severity: "error",
        });
      }
      return issues;
    },
  } satisfies Capability<"CreateEntity">,
  SetProperty: {
    access: (operation) => ({ reads: [], writes: [{ channel: operation.key, entityId: operation.entityId }] }),
    execution: setPropertyExecution,
    validate: setPropertyIssues,
  } satisfies Capability<"SetProperty">,
  AnimateProperty: {
    access: (operation) => {
      const channel =
        operation.key === "appearance" && operation.materialParameter
          ? (`materialParameter:${operation.materialParameter.name}:${operation.materialParameter.parameterIndex}` as const)
          : operation.key;
      return {
        reads: [{ channel, entityId: operation.entityId }],
        writes: [{ channel, entityId: operation.entityId }],
      };
    },
    execution: animatePropertyExecution,
    validate: (operation, scene) => {
      const issues = entityIssues([operation.entityId], operation, scene);
      if (operation.timelineTrack === true) {
        const entity = scene.objectGraph.entities[operation.entityId];
        const valuesAreValid =
          typeof operation.from === "number" &&
          typeof operation.to === "number" &&
          Number.isFinite(operation.from) &&
          Number.isFinite(operation.to) &&
          (operation.key === "rotation" || (operation.key === "scale" && operation.from > 0 && operation.to > 0));
        if (
          (operation.key !== "scale" && operation.key !== "rotation") ||
          operation.control !== undefined ||
          operation.materialParameter !== undefined ||
          operation.relativeDelta !== undefined ||
          operation.relativeFactor !== undefined ||
          !valuesAreValid ||
          (operation.interval.start === operation.interval.end && operation.from !== operation.to)
        ) {
          issues.push({
            code: "schema-invalid",
            field: "timelineTrack",
            message:
              "A transform Timeline track requires finite absolute values and no relative transform fields; scale values must be positive.",
            operationId: operation.id,
            severity: "error",
          });
        }
        if (entity && !entity.transactionId) {
          issues.push({
            code: "lowering-unsupported",
            field: "entityId",
            message: "Transform Timeline keyframes currently support only Studio-created objects.",
            operationId: operation.id,
            severity: "error",
          });
        }
        return issues;
      }
      if (operation.materialParameter && operation.key !== "appearance") {
        issues.push({
          code: "schema-invalid",
          field: "materialParameter",
          message: "Material parameter metadata belongs only to an appearance animation.",
          operationId: operation.id,
          severity: "error",
        });
        return issues;
      }
      if (operation.key === "appearance") {
        const entity = scene.objectGraph.entities[operation.entityId];
        const materialParameter = operation.materialParameter;
        if (entity && !entity.transactionId) {
          issues.push({
            code: "lowering-unsupported",
            field: "entityId",
            message: `${materialParameter ? "Material parameter" : "Opacity"} keyframes currently support only Studio-created objects.`,
            operationId: operation.id,
            severity: "error",
          });
        }
        if (materialParameter) {
          const baseValue = materialParameter.material.parameters[materialParameter.parameterIndex];
          if (
            typeof operation.from !== "number" ||
            typeof operation.to !== "number" ||
            !Number.isFinite(operation.from) ||
            !Number.isFinite(operation.to) ||
            baseValue === undefined ||
            !Number.isFinite(baseValue) ||
            (operation.interval.start === operation.interval.end && operation.from !== operation.to)
          ) {
            issues.push({
              code: "schema-invalid",
              field: "appearance",
              message:
                "Material parameter keyframes require one existing finite f32 parameter and a point marker must keep one value.",
              operationId: operation.id,
              severity: "error",
            });
          }
          return issues;
        }
        if (
          typeof operation.from !== "number" ||
          typeof operation.to !== "number" ||
          !Number.isFinite(operation.from) ||
          !Number.isFinite(operation.to) ||
          operation.from < 0 ||
          operation.from > 1 ||
          operation.to < 0 ||
          operation.to > 1 ||
          (operation.interval.start === operation.interval.end && operation.from !== operation.to)
        ) {
          issues.push({
            code: "schema-invalid",
            field: "appearance",
            message: "Opacity keyframes require finite values from 0 to 1; a point keyframe must keep one value.",
            operationId: operation.id,
            severity: "error",
          });
        }
        return issues;
      }
      if (operation.relativeDelta !== undefined) {
        if (
          operation.key !== "rotation" ||
          operation.control !== undefined ||
          operation.relativeFactor !== undefined ||
          typeof operation.from !== "number" ||
          typeof operation.to !== "number" ||
          !finiteNonNoopRotationDelta(operation.relativeDelta) ||
          !Number.isFinite(operation.from) ||
          !Number.isFinite(operation.to) ||
          Math.abs(operation.to - operation.from - operation.relativeDelta) >= 0.000001
        ) {
          issues.push({
            code: "schema-invalid",
            field: "relativeDelta",
            message: "A relative rotation requires one finite non-zero delta matching its captured from/to pair.",
            operationId: operation.id,
            severity: "error",
          });
        }
        return issues;
      }
      if (operation.relativeFactor === undefined) return issues;
      if (
        operation.key !== "scale" ||
        typeof operation.from !== "number" ||
        typeof operation.to !== "number" ||
        !Number.isFinite(operation.relativeFactor) ||
        operation.relativeFactor <= 0 ||
        !Number.isFinite(operation.from) ||
        operation.from <= 0 ||
        !Number.isFinite(operation.to) ||
        operation.to <= 0 ||
        Math.abs(operation.to / operation.from - operation.relativeFactor) >= 0.000001
      ) {
        issues.push({
          code: "schema-invalid",
          field: "relativeFactor",
          message: "A relative scale requires a finite positive factor matching its captured from/to pair.",
          operationId: operation.id,
          severity: "error",
        });
        return issues;
      }
      const entity = scene.objectGraph.entities[operation.entityId];
      if (entity) {
        const scale = exactEntityScaleAt(scene, entity, operation.interval.start);
        const targetScale = scale.kind === "known" ? scale.value * operation.relativeFactor : Number.NaN;
        if (
          scale.kind !== "known" ||
          !Number.isFinite(targetScale) ||
          targetScale < MIN_ENTITY_SCALE ||
          targetScale > MAX_ENTITY_SCALE
        ) {
          issues.push({
            code: "lowering-unsupported",
            field: "relativeFactor",
            message:
              scale.kind === "unknown"
                ? `Relative scale cannot resolve an exact source value: ${scale.reason}`
                : `Relative scale must resolve between ${MIN_ENTITY_SCALE}x and ${MAX_ENTITY_SCALE}x; it resolves to ${targetScale}x.`,
            operationId: operation.id,
            severity: "error",
          });
        }
      }
      return issues;
    },
  } satisfies Capability<"AnimateProperty">,
  ResizeEntity: {
    access: (operation) => ({
      reads: [
        { channel: "dimensions", entityId: operation.entityId },
        { channel: "position", entityId: operation.entityId },
        { channel: "scale", entityId: operation.entityId },
      ],
      writes: [
        { channel: "dimensions", entityId: operation.entityId },
        { channel: "position", entityId: operation.entityId },
      ],
    }),
    execution: () => SUPPORTED_EXECUTION,
    validate: (operation, scene) => {
      const issues = entityIssues([operation.entityId], operation, scene);
      const entity = scene.objectGraph.entities[operation.entityId];
      const expectedShape =
        entity?.type === "Circle"
          ? "circle"
          : entity?.type === "Rectangle" || entity?.type === "Square"
            ? "rectangle"
            : null;
      if (entity && expectedShape !== operation.shape) {
        issues.push({
          code: "schema-invalid",
          field: "shape",
          message: `ResizeEntity shape ${operation.shape} does not match target type ${entity.type}.`,
          operationId: operation.id,
          severity: "error",
        });
      } else if (entity && !matchingResizeStart(operation, scene)) {
        issues.push({
          code: "schema-invalid",
          field: "from",
          message: "ResizeEntity must start from the target's known current geometry and scale.",
          operationId: operation.id,
          severity: "error",
        });
      }
      if (
        entity?.type === "Square" &&
        (operation.shape !== "rectangle" ||
          operation.from.dimensions.width === undefined ||
          operation.from.dimensions.height === undefined ||
          operation.to.dimensions.width === undefined ||
          operation.to.dimensions.height === undefined ||
          !closeEnough(operation.from.dimensions.width, operation.from.dimensions.height) ||
          !closeEnough(operation.to.dimensions.width, operation.to.dimensions.height) ||
          !closeEnough(
            operation.to.dimensions.width / operation.from.dimensions.width,
            operation.to.dimensions.height / operation.from.dimensions.height,
          ))
      ) {
        issues.push({
          code: "schema-invalid",
          field: "dimensions",
          message: "Square ResizeEntity operations must preserve equal sides with one positive uniform factor.",
          operationId: operation.id,
          severity: "error",
        });
      }
      const dimensions =
        operation.shape === "circle"
          ? [operation.from.dimensions.radius, operation.to.dimensions.radius]
          : [
              operation.from.dimensions.width,
              operation.from.dimensions.height,
              operation.to.dimensions.width,
              operation.to.dimensions.height,
            ];
      const lowerMultiplier = operation.shape === "circle" ? 2 : 1;
      const loweredDimensions = dimensions.map((value) =>
        typeof value === "number" ? value * operation.scale * lowerMultiplier : Number.NaN,
      );
      if (
        !exactShapeDimensions(operation.shape, operation.from.dimensions) ||
        !exactShapeDimensions(operation.shape, operation.to.dimensions) ||
        dimensions.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0) ||
        loweredDimensions.some((value) => !Number.isFinite(value) || value <= 0) ||
        !Number.isFinite(operation.scale) ||
        operation.scale <= 0
      ) {
        issues.push({
          code: "schema-invalid",
          field: "dimensions",
          message: "Shape resize dimensions, scale, and lowered size must be finite positive numbers.",
          operationId: operation.id,
          severity: "error",
        });
      }
      return issues;
    },
  } satisfies Capability<"ResizeEntity">,
  CreateMotion: {
    access: (operation) => ({
      reads: operation.targetEntityIds.map((entityId) => ({ channel: "position" as const, entityId })),
      writes: operation.targetEntityIds.map((entityId) => ({ channel: "position" as const, entityId })),
    }),
    execution: createMotionExecution,
    validate: (operation, scene) => entityIssues(operation.targetEntityIds, operation, scene),
  } satisfies Capability<"CreateMotion">,
  TransformContent: {
    access: (operation) => ({
      reads: [
        { channel: "content", entityId: operation.sourceEntityId },
        { channel: "position", entityId: operation.sourceEntityId },
      ],
      writes: [
        { channel: "content", entityId: operation.sourceEntityId },
        { channel: "identity", entityId: operation.targetEntityId },
      ],
    }),
    execution: (operation) =>
      operation.interval.end - operation.interval.start > SOURCE_LOWERING_EPSILON
        ? SUPPORTED_EXECUTION
        : previewOnlyExecution(
            "A zero-duration TransformContent can be previewed, but it cannot be lowered truthfully to Manim source.",
          ),
    validate: (operation, scene) => {
      const issues = entityIssues([operation.sourceEntityId], operation, scene);
      const source = scene.objectGraph.entities[operation.sourceEntityId];
      if (source && operation.strategy === "transform-matching-tex" && source.type !== "MathTex") {
        issues.push({
          code: "schema-invalid",
          field: "strategy",
          message: "transform-matching-tex requires a MathTex source entity.",
          operationId: operation.id,
          severity: "error",
        });
      }
      return issues;
    },
  } satisfies Capability<"TransformContent">,
  SetRelation: {
    access: (operation) => ({
      reads: [
        { channel: "identity", entityId: operation.targetEntityId },
        { channel: "position", entityId: operation.targetEntityId },
      ],
      writes: [{ channel: "position", entityId: operation.sourceEntityId }],
    }),
    execution: (operation) =>
      operation.mode === "snapshot"
        ? SUPPORTED_EXECUTION
        : previewOnlyExecution(
            "SetRelation live has no truthful source lowering; only snapshot relations can be applied.",
          ),
    validate: (operation, scene) =>
      entityIssues([operation.sourceEntityId, operation.targetEntityId], operation, scene),
  } satisfies Capability<"SetRelation">,
  ChangePresence: {
    access: (operation) => ({
      reads: [{ channel: "presence", entityId: operation.entityId }],
      writes: [
        { channel: "appearance", entityId: operation.entityId },
        { channel: "presence", entityId: operation.entityId },
      ],
    }),
    execution: changePresenceExecution,
    validate: (operation, scene) => entityIssues([operation.entityId], operation, scene),
  } satisfies Capability<"ChangePresence">,
  InsertTimelineEvent: {
    access: () => ({ reads: [], writes: [] }),
    execution: (operation) =>
      operation.eventKind === "wait"
        ? SUPPORTED_EXECUTION
        : previewOnlyExecution("Only an explicit wait timeline event has truthful Manim source lowering."),
    validate: (operation, scene) => {
      const issues: SceneEditValidationIssue[] = [];
      if (
        !Number.isFinite(operation.interval.start) ||
        !Number.isFinite(operation.interval.end) ||
        operation.interval.start < 0 ||
        operation.interval.start > scene.duration ||
        operation.interval.end < operation.interval.start
      ) {
        issues.push({
          code: "interval-invalid",
          field: "interval",
          message: "A timeline insertion must start within the active Scene and have a non-negative duration.",
          operationId: operation.id,
          severity: "error",
        });
      }
      if (operation.eventKind !== "wait") {
        issues.push({
          code: "lowering-unsupported",
          field: "eventKind",
          message: "Only an explicit wait can be inserted into Manim source.",
          operationId: operation.id,
          severity: "error",
        });
      }
      if (operation.purpose === "scene-duration" && operation.provenance.origin !== "studio-default") {
        issues.push({
          code: "schema-invalid",
          field: "purpose",
          message: "Only the Studio Scene duration control may create a removable duration wait.",
          operationId: operation.id,
          severity: "error",
        });
      }
      return issues;
    },
  } satisfies Capability<"InsertTimelineEvent">,
  TrimSceneDuration: {
    access: () => ({ reads: [], writes: [] }),
    execution: () => SUPPORTED_EXECUTION,
    validate: (operation) => {
      const issues: SceneEditValidationIssue[] = [];
      if (Math.abs(operation.interval.end - operation.interval.start) >= TIME_EPSILON) {
        issues.push({
          code: "interval-invalid",
          field: "interval",
          message: "A Scene duration trim must be an instantaneous adjustment at its source anchor.",
          operationId: operation.id,
          severity: "error",
        });
      }
      if (
        !Number.isFinite(operation.removedDuration) ||
        operation.removedDuration < 0.1 - TIME_EPSILON ||
        !Number.isFinite(operation.targetDuration) ||
        operation.targetDuration < 0.1
      ) {
        issues.push({
          code: "interval-invalid",
          field: "targetDuration",
          message: "A Scene duration trim must contain finite durations of at least 0.1 seconds.",
          operationId: operation.id,
          severity: "error",
        });
      }
      if (new Set(operation.waitOperationIds).size !== operation.waitOperationIds.length) {
        issues.push({
          code: "schema-invalid",
          field: "waitOperationIds",
          message: "A Scene duration trim must reference each Studio wait at most once.",
          operationId: operation.id,
          severity: "error",
        });
      }
      if (operation.provenance.origin !== "studio-default") {
        issues.push({
          code: "schema-invalid",
          field: "provenance.origin",
          message: "Only the Studio Scene duration control may shorten a duration wait.",
          operationId: operation.id,
          severity: "error",
        });
      }
      return issues;
    },
  } satisfies Capability<"TrimSceneDuration">,
  InsertSceneBoundary: {
    access: () => ({ reads: [], writes: [] }),
    execution: () => SUPPORTED_EXECUTION,
    validate: (operation, scene) => baseIssues(operation, scene),
  } satisfies Capability<"InsertSceneBoundary">,
  ChangeCamera: {
    access: () => ({
      reads: [{ channel: "camera", entityId: "camera" }],
      writes: [{ channel: "camera", entityId: "camera" }],
    }),
    execution: () =>
      previewOnlyExecution(
        "CameraFocus can be previewed, but ChangeCamera cannot yet be lowered back to Manim source.",
      ),
    validate: (operation, scene) => baseIssues(operation, scene),
  } satisfies Capability<"ChangeCamera">,
} as const;

export function operationCapability(operation: SceneEditOperation) {
  return OPERATION_REGISTRY[operation.kind] as Capability<SceneEditOperation["kind"]>;
}

export function operationExecutionCapabilities(operation: SceneEditOperation): OperationExecutionCapabilities {
  return operationCapability(operation).execution(operation as never);
}

const LOWERING_PRIORITY: Readonly<Record<OperationExecutionCapabilities["lowering"], number>> = {
  illustrative: 1,
  supported: 0,
  unsupported: 2,
};

export function programExecutionCapabilities(program: SceneEdit): ProgramExecutionCapabilities {
  const operationCapabilities = program.operations.map(operationExecutionCapabilities);
  const operationLowering = operationCapabilities
    .map((capability) => capability.lowering)
    .reduce<OperationExecutionCapabilities["lowering"]>(
      (current, candidate) => (LOWERING_PRIORITY[candidate] > LOWERING_PRIORITY[current] ? candidate : current),
      "supported",
    );
  const declaredLowering = [program.loweringStatus, operationLowering].reduce<
    OperationExecutionCapabilities["lowering"]
  >(
    (current, candidate) => (LOWERING_PRIORITY[candidate] > LOWERING_PRIORITY[current] ? candidate : current),
    "supported",
  );
  const blockedOperation = operationCapabilities.find((capability) => capability.apply !== "supported");
  const structureBlocker = programStructureBlocker(program);
  const lowering = structureBlocker && declaredLowering === "supported" ? "illustrative" : declaredLowering;
  const unexplainedLowering =
    program.loweringStatus !== "supported" && operationLowering === "supported"
      ? `This Program is marked ${program.loweringStatus} and cannot be applied because its operations do not explain that source-lowering restriction.`
      : null;
  const applyBlocker = blockedOperation?.applyBlocker ?? structureBlocker ?? unexplainedLowering;
  return {
    apply: applyBlocker === null ? "supported" : "blocked",
    applyBlocker,
    lowering,
  };
}

export function operationAccess(operation: SceneEditOperation) {
  return operationCapability(operation).access(operation as never);
}

export function validateOperation(operation: SceneEditOperation, scene: RuntimeSceneState) {
  const parsed = sceneEditOperationSchema.safeParse(operation);
  if (!parsed.success) {
    return [
      {
        code: "schema-invalid" as const,
        field: parsed.error.issues[0]?.path.join(".") || "operation",
        message: parsed.error.issues[0]?.message ?? "Operation does not match the closed schema.",
        operationId: operation.id,
        severity: "error" as const,
      },
    ];
  }
  return operationCapability(operation).validate(operation as never, scene);
}
