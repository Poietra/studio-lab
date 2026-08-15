import { z } from "zod";
import type { StudioPersistentRemoveProjectionEntryV1 } from "../engine/scene-authoring";
import { canonicalEditableContent } from "./editable-content";
import { exactEntityScaleAt, MAX_ENTITY_SCALE, MIN_ENTITY_SCALE } from "./magic-edit-capabilities";
import type {
  EntityDimensions,
  IdentityLineage,
  PropertyChannel,
  PropertyChannelSample,
  ProvenanceRecord,
  RuntimeEntity,
  RuntimeSceneState,
  SceneConstraint,
  TimelineEvent,
} from "./model";
import {
  type CanonicalEditOperation,
  type CanonicalEditProgram,
  type ChannelAccess,
  isSceneDurationOperation,
  type ProgramValidationIssue,
} from "./operations";
import {
  isEntityDimensionsValue,
  isPointValue,
  samplePropertyKnowledge,
  samplePropertyValue,
} from "./property-sampling";

const pointSchema = z.object({ x: z.number(), y: z.number() });
const dimensionsSchema = z
  .object({
    height: z.number().positive().optional(),
    radius: z.number().positive().optional(),
    width: z.number().positive().optional(),
  })
  .strict();
const intervalSchema = z.object({ end: z.number(), start: z.number() });
const provenanceSchema = z.object({
  evidence: z.array(z.string()),
  origin: z.enum(["direct-manipulation", "fixture", "remote-model", "studio-default"]),
});
const baseSchema = z.object({
  dependsOn: z.array(z.string()),
  id: z.string().min(1),
  interval: intervalSchema,
  provenance: provenanceSchema,
});
const contentSchema = z.object({
  displayLines: z.array(z.string()),
  label: z.string().optional(),
  texParts: z.array(z.string()).optional(),
  text: z.string().optional(),
});

export const canonicalOperationSchema = z.discriminatedUnion("kind", [
  baseSchema.extend({
    entity: z.object({
      content: contentSchema.optional(),
      dimensions: dimensionsSchema.optional(),
      id: z.string(),
      lifetime: z.object({ end: z.number().nullable(), start: z.number() }),
      type: z.string(),
    }),
    kind: z.literal("CreateEntity"),
  }),
  baseSchema.extend({
    entityId: z.string(),
    key: z.enum(["appearance", "camera", "content", "ordering", "position", "presence", "rotation", "scale"]),
    kind: z.literal("SetProperty"),
    value: z.union([z.boolean(), z.number(), z.string(), pointSchema, contentSchema]),
  }),
  baseSchema.extend({
    control: pointSchema.optional(),
    easing: z.literal("smooth"),
    entityId: z.string(),
    from: z.union([pointSchema, z.number()]).optional(),
    key: z.enum(["appearance", "position", "rotation", "scale"]),
    kind: z.literal("AnimateProperty"),
    relativeDelta: z.number().optional(),
    relativeFactor: z.number().positive().optional(),
    to: z.union([pointSchema, z.number()]),
  }),
  baseSchema.extend({
    entityId: z.string(),
    from: z.object({ dimensions: dimensionsSchema, position: pointSchema }).strict(),
    kind: z.literal("ResizeEntity"),
    scale: z.number().positive(),
    shape: z.enum(["circle", "rectangle"]),
    to: z.object({ dimensions: dimensionsSchema, position: pointSchema }).strict(),
  }),
  baseSchema.extend({
    controlOffset: pointSchema,
    delta: pointSchema,
    easing: z.enum(["linear", "smooth"]),
    kind: z.literal("CreateMotion"),
    targetEntityIds: z.array(z.string()).min(1),
  }),
  baseSchema.extend({
    kind: z.literal("TransformContent"),
    replacement: contentSchema,
    sourceEntityId: z.string(),
    strategy: z.enum(["replacement-transform", "transform-matching-tex"]),
    targetEntityId: z.string(),
    targetType: z.string().optional(),
  }),
  baseSchema.extend({
    kind: z.literal("SetRelation"),
    mode: z.enum(["live", "snapshot"]),
    offset: pointSchema,
    placement: z.enum(["above", "below", "left", "right"]),
    relation: z.literal("next-to"),
    sourceEntityId: z.string(),
    targetEntityId: z.string(),
  }),
  baseSchema.extend({
    effect: z.enum(["cover", "fade-in", "remove", "reveal"]),
    entityId: z.string(),
    kind: z.literal("ChangePresence"),
    persistent: z.boolean(),
  }),
  baseSchema.extend({
    eventKind: z.enum(["play", "wait"]),
    kind: z.literal("InsertTimelineEvent"),
    label: z.string(),
    purpose: z.literal("scene-duration").optional(),
  }),
  baseSchema.extend({
    kind: z.literal("TrimSceneDuration"),
    removedDuration: z.number().finite().positive(),
    targetDuration: z.number().finite().positive(),
    waitOperationIds: z.array(z.string().min(1)).min(1).max(32),
  }),
  baseSchema.extend({ at: z.number(), destination: z.literal("next-scene"), kind: z.literal("InsertSceneBoundary") }),
  baseSchema.extend({
    kind: z.literal("ChangeCamera"),
    property: z.enum(["position", "rotation", "scale"]),
    value: z.union([z.number(), pointSchema]),
  }),
]);

export type EvaluationDraft = {
  constraints: SceneConstraint[];
  duration: number;
  entities: Record<string, RuntimeEntity>;
  events: TimelineEvent[];
  lineage: IdentityLineage[];
  propertyChannels: Record<string, PropertyChannel>;
  provenance: ProvenanceRecord[];
};

export type OperationExecutionCapabilities = Readonly<{
  apply: "blocked" | "supported";
  applyBlocker: string | null;
  lowering: "illustrative" | "supported" | "unsupported";
}>;

export type ProgramExecutionCapabilities = OperationExecutionCapabilities;

type Capability<TKind extends CanonicalEditOperation["kind"]> = Readonly<{
  access: (operation: Extract<CanonicalEditOperation, { kind: TKind }>) => Readonly<{
    reads: readonly ChannelAccess[];
    writes: readonly ChannelAccess[];
  }>;
  evaluate?: (
    draft: EvaluationDraft,
    operation: Extract<CanonicalEditOperation, { kind: TKind }>,
    program: CanonicalEditProgram,
  ) => void;
  execution: (operation: Extract<CanonicalEditOperation, { kind: TKind }>) => OperationExecutionCapabilities;
  validate: (
    operation: Extract<CanonicalEditOperation, { kind: TKind }>,
    scene: RuntimeSceneState,
  ) => readonly ProgramValidationIssue[];
}>;

const SUPPORTED_EXECUTION: OperationExecutionCapabilities = {
  apply: "supported",
  applyBlocker: null,
  lowering: "supported",
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
  operation: Extract<CanonicalEditOperation, { kind: "CreateEntity" }>,
): OperationExecutionCapabilities {
  const { content, type } = operation.entity;
  const hasMathTexContent =
    type === "MathTex" && ((content?.texParts?.length ?? 0) > 0 || (content?.displayLines?.length ?? 0) > 0);
  const isBuiltIn = type === "Text" || ["Arrow", "Circle", "Line", "Rectangle", "Square"].includes(type);
  const isTransitionOverlay = /^TransitionOverlay:(circle|diamond|hexagon):(black|sky|white)$/.test(type);
  if (hasMathTexContent || isBuiltIn || isTransitionOverlay) return SUPPORTED_EXECUTION;
  return previewOnlyExecution(`CreateEntity type ${type} can be previewed, but it has no safe Manim source lowering.`);
}

function setPropertyExecution(
  operation: Extract<CanonicalEditOperation, { kind: "SetProperty" }>,
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
  operation: Extract<CanonicalEditOperation, { kind: "AnimateProperty" }>,
): OperationExecutionCapabilities {
  if (
    operation.key === "rotation" &&
    operation.control === undefined &&
    operation.relativeFactor === undefined &&
    operation.interval.start === 0 &&
    operation.interval.end === 0 &&
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
  operation: Extract<CanonicalEditOperation, { kind: "CreateMotion" }>,
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
  operation: Extract<CanonicalEditOperation, { kind: "ChangePresence" }>,
): OperationExecutionCapabilities {
  const hasDuration = operation.interval.end - operation.interval.start > 0.0005;
  if (hasDuration || operation.effect === "remove") return SUPPORTED_EXECUTION;
  return previewOnlyExecution(
    `Zero-duration ${operation.effect} can be previewed, but it has no truthful Manim source lowering.`,
  );
}

function operationSourceTime(operation: CanonicalEditOperation) {
  return operation.kind === "InsertSceneBoundary" ? operation.at : operation.interval.start;
}

function sourceAnimationEnd(operation: CanonicalEditOperation) {
  if (operation.interval.end - operation.interval.start <= SOURCE_LOWERING_EPSILON) return null;
  if (
    operation.kind === "ChangePresence" ||
    operation.kind === "CreateMotion" ||
    operation.kind === "ResizeEntity" ||
    operation.kind === "TransformContent" ||
    (operation.kind === "AnimateProperty" && operation.key === "scale")
  )
    return operation.interval.end;
  return null;
}

function programStructureBlocker(program: CanonicalEditProgram) {
  const scheduleIndex = new Map(program.schedule.order.map((id, index) => [id, index]));
  const operations = [...program.operations].sort(
    (left, right) =>
      operationSourceTime(left) - operationSourceTime(right) ||
      (scheduleIndex.get(left.id) ?? 0) - (scheduleIndex.get(right.id) ?? 0),
  );
  const buckets: Array<Readonly<{ operations: CanonicalEditOperation[]; time: number }>> = [];
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

function appendSample(
  draft: EvaluationDraft,
  entityId: string,
  key: PropertyChannel["key"],
  sample: PropertyChannelSample,
) {
  const id = propertyKey(entityId, key);
  const channel = draft.propertyChannels[id];
  draft.propertyChannels[id] = {
    entityId,
    key,
    samples: [...(channel?.samples ?? []), sample],
  };
}

function sampleChannel(draft: EvaluationDraft, entityId: string, key: PropertyChannel["key"], time: number) {
  const samples = draft.propertyChannels[propertyKey(entityId, key)]?.samples ?? [];
  return samplePropertyValue(samples, time);
}

function baseIssues(operation: CanonicalEditOperation, scene: RuntimeSceneState): ProgramValidationIssue[] {
  const issues: ProgramValidationIssue[] = [];
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

function entityIssues(entityIds: readonly string[], operation: CanonicalEditOperation, scene: RuntimeSceneState) {
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

function recordOperation(draft: EvaluationDraft, operation: CanonicalEditOperation, program: CanonicalEditProgram) {
  const provenanceId = `${operation.id}/provenance`;
  draft.provenance.push({
    evidence: [...program.anchor.evidence, ...operation.provenance.evidence],
    id: provenanceId,
    operationId: operation.id,
    origin: operation.provenance.origin,
    transactionId: program.transactionId,
  });
  draft.events.push({
    id: `${operation.id}/event`,
    interval: operation.interval,
    kind: "operation",
    label: operation.kind,
    operationId: operation.id,
    transactionId: program.transactionId,
  });
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
  operation: Extract<CanonicalEditOperation, { kind: "ResizeEntity" }>,
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

function setPropertyIssues(
  operation: Extract<CanonicalEditOperation, { kind: "SetProperty" }>,
  scene: RuntimeSceneState,
) {
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
      return issues;
    },
  } satisfies Capability<"CreateEntity">,
  SetProperty: {
    access: (operation) => ({ reads: [], writes: [{ channel: operation.key, entityId: operation.entityId }] }),
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      appendSample(draft, operation.entityId, operation.key, {
        interval: { end: draft.duration, start: operation.interval.start },
        kind: "exact",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: operation.value,
      });
    },
    execution: setPropertyExecution,
    validate: setPropertyIssues,
  } satisfies Capability<"SetProperty">,
  AnimateProperty: {
    access: (operation) => ({
      reads: [{ channel: operation.key, entityId: operation.entityId }],
      writes: [{ channel: operation.key, entityId: operation.entityId }],
    }),
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      const sampledFrom = sampleChannel(draft, operation.entityId, operation.key, operation.interval.start);
      const relativeScale =
        operation.key === "scale" &&
        operation.relativeFactor !== undefined &&
        typeof sampledFrom === "number" &&
        Number.isFinite(sampledFrom) &&
        sampledFrom > 0;
      const relativeRotation =
        operation.key === "rotation" &&
        operation.relativeDelta !== undefined &&
        (typeof sampledFrom === "number" || sampledFrom === undefined);
      const relativeFrom = typeof sampledFrom === "number" ? sampledFrom : 0;
      const from = relativeScale
        ? sampledFrom
        : relativeRotation
          ? relativeFrom
          : (operation.from ??
            (isPointValue(sampledFrom) || typeof sampledFrom === "number" ? sampledFrom : undefined));
      const value = relativeScale
        ? sampledFrom * operation.relativeFactor!
        : relativeRotation
          ? relativeFrom + operation.relativeDelta!
          : operation.to;
      appendSample(draft, operation.entityId, operation.key, {
        control: operation.control,
        easing: operation.easing,
        from,
        interval: operation.interval,
        kind: "animated",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        ...(relativeScale || relativeRotation ? { relative: true } : {}),
        value,
      });
    },
    execution: animatePropertyExecution,
    validate: (operation, scene) => {
      const issues = entityIssues([operation.entityId], operation, scene);
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
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      const kind = operation.interval.end > operation.interval.start ? "animated" : "exact";
      appendSample(draft, operation.entityId, "dimensions", {
        from: operation.from.dimensions,
        interval: operation.interval,
        kind,
        operationId: operation.id,
        provenanceId: `${operation.id}/dimensions-provenance`,
        value: operation.to.dimensions,
      });
      appendSample(draft, operation.entityId, "position", {
        from: operation.from.position,
        interval: operation.interval,
        kind,
        operationId: operation.id,
        provenanceId: `${operation.id}/position-provenance`,
        value: operation.to.position,
      });
    },
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
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      const targetPosition = sampleChannel(draft, operation.targetEntityId, "position", operation.interval.start);
      const position = isPointValue(targetPosition)
        ? { x: targetPosition.x + operation.offset.x, y: targetPosition.y + operation.offset.y }
        : operation.offset;
      draft.constraints.push({
        id: `${operation.id}/constraint`,
        mode: operation.mode,
        operationId: operation.id,
        relation: operation.relation,
        sourceEntityId: operation.sourceEntityId,
        targetEntityId: operation.targetEntityId,
      });
      appendSample(draft, operation.sourceEntityId, "position", {
        interval: { end: draft.duration, start: operation.interval.start },
        kind: "exact",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: position,
      });
    },
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
    evaluate: (draft, operation, program) => {
      if (operation.effect === "remove" && operation.persistent) {
        throw new TypeError("Persistent remove requires the Rust authoring projection.");
      }
      recordOperation(draft, operation, program);
      const isFade = operation.effect === "fade-in";
      const from = operation.effect === "remove" || operation.effect === "reveal" ? 1 : 0;
      const to = operation.effect === "remove" || operation.effect === "reveal" ? 0 : 1;
      appendSample(draft, operation.entityId, "appearance", {
        easing: "smooth",
        from,
        interval: operation.interval,
        kind: "animated",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: to,
      });
      if (operation.persistent || isFade) {
        appendSample(draft, operation.entityId, "appearance", {
          interval: { end: draft.duration, start: operation.interval.end },
          kind: "exact",
          operationId: operation.id,
          provenanceId: `${operation.id}/provenance`,
          value: to,
        });
      }
    },
    execution: changePresenceExecution,
    validate: (operation, scene) => entityIssues([operation.entityId], operation, scene),
  } satisfies Capability<"ChangePresence">,
  InsertTimelineEvent: {
    access: () => ({ reads: [], writes: [] }),
    evaluate: (draft, operation, program) => {
      if (isSceneDurationOperation(operation)) {
        throw new TypeError("InsertTimelineEvent scene-duration waits require the Rust timeline projection.");
      }
      recordOperation(draft, operation, program);
      draft.events.push({
        id: `${operation.id}/timeline`,
        interval: operation.interval,
        kind: operation.eventKind,
        label: operation.label,
        operationId: operation.id,
        transactionId: program.transactionId,
      });
    },
    execution: (operation) =>
      operation.eventKind === "wait"
        ? SUPPORTED_EXECUTION
        : previewOnlyExecution("Only an explicit wait timeline event has truthful Manim source lowering."),
    validate: (operation, scene) => {
      const issues: ProgramValidationIssue[] = [];
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
      const issues: ProgramValidationIssue[] = [];
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
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      draft.events.push({
        at: operation.at,
        id: `${operation.id}/boundary`,
        kind: "scene-boundary",
        label: "Full-cover Scene boundary",
        operationId: operation.id,
        transactionId: program.transactionId,
      });
    },
    execution: () => SUPPORTED_EXECUTION,
    validate: (operation, scene) => baseIssues(operation, scene),
  } satisfies Capability<"InsertSceneBoundary">,
  ChangeCamera: {
    access: () => ({
      reads: [{ channel: "camera", entityId: "camera" }],
      writes: [{ channel: "camera", entityId: "camera" }],
    }),
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      const fallback = operation.property === "position" ? { x: 0, y: 0 } : 1;
      const current = sampleChannel(draft, "camera", "camera", operation.interval.start) ?? fallback;
      appendSample(draft, "camera", "camera", {
        easing: "smooth",
        from: current,
        interval: operation.interval,
        kind: "animated",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: operation.value,
      });
    },
    execution: () =>
      previewOnlyExecution(
        "CameraFocus can be previewed, but ChangeCamera cannot yet be lowered back to Manim source.",
      ),
    validate: (operation, scene) => baseIssues(operation, scene),
  } satisfies Capability<"ChangeCamera">,
} as const;

export function operationCapability(operation: CanonicalEditOperation) {
  return OPERATION_REGISTRY[operation.kind] as Capability<CanonicalEditOperation["kind"]>;
}

export function operationExecutionCapabilities(operation: CanonicalEditOperation): OperationExecutionCapabilities {
  return operationCapability(operation).execution(operation as never);
}

const LOWERING_PRIORITY: Readonly<Record<OperationExecutionCapabilities["lowering"], number>> = {
  illustrative: 1,
  supported: 0,
  unsupported: 2,
};

export function programExecutionCapabilities(program: CanonicalEditProgram): ProgramExecutionCapabilities {
  const operationCapabilities = program.operations.map(operationExecutionCapabilities);
  const operationLowering = [
    program.loweringStatus,
    ...operationCapabilities.map((capability) => capability.lowering),
  ].reduce<OperationExecutionCapabilities["lowering"]>(
    (current, candidate) => (LOWERING_PRIORITY[candidate] > LOWERING_PRIORITY[current] ? candidate : current),
    "supported",
  );
  const blockedOperation = operationCapabilities.find((capability) => capability.apply !== "supported");
  const structureBlocker = programStructureBlocker(program);
  const lowering = structureBlocker && operationLowering === "supported" ? "illustrative" : operationLowering;
  const applyBlocker =
    blockedOperation?.applyBlocker ??
    structureBlocker ??
    (program.loweringStatus !== "supported"
      ? `This Program is marked ${program.loweringStatus} and cannot be applied until it has truthful Manim source lowering.`
      : null);
  return {
    apply: applyBlocker === null && lowering === "supported" ? "supported" : "blocked",
    applyBlocker,
    lowering,
  };
}

export function operationAccess(operation: CanonicalEditOperation) {
  return operationCapability(operation).access(operation as never);
}

export function validateOperation(operation: CanonicalEditOperation, scene: RuntimeSceneState) {
  const parsed = canonicalOperationSchema.safeParse(operation);
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

export function evaluateOperation(
  draft: EvaluationDraft,
  operation: CanonicalEditOperation,
  program: CanonicalEditProgram,
  persistentRemoveProjection?: StudioPersistentRemoveProjectionEntryV1,
) {
  if (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent) {
    if (
      !persistentRemoveProjection ||
      persistentRemoveProjection.operationId !== operation.id ||
      persistentRemoveProjection.transactionId !== program.transactionId ||
      persistentRemoveProjection.studioEntityId !== operation.entityId
    ) {
      throw new TypeError(`Persistent remove ${operation.id} is not correlated with the Rust authoring projection.`);
    }
    const entity = draft.entities[operation.entityId];
    if (!entity) {
      throw new TypeError(`Persistent remove target ${operation.entityId} is missing from the Studio projection.`);
    }
    recordOperation(draft, operation, program);
    // `affectedSceneEntityIds` belongs to the Scene IR identity space. Rust has
    // already truncated that root and every render descendant in `bundle`;
    // Studio's object graph owns one logical entity under `studioEntityId`.
    draft.entities[operation.entityId] = {
      ...entity,
      lifetime: entity.lifetime.flatMap((interval) => {
        if (interval.start >= persistentRemoveProjection.removedAt) return [];
        return interval.end > persistentRemoveProjection.removedAt
          ? [{ ...interval, end: persistentRemoveProjection.resultingLifetimeEnd }]
          : [interval];
      }),
    };
    if (persistentRemoveProjection.fadeInterval) {
      appendSample(draft, operation.entityId, "appearance", {
        easing: "smooth",
        from: 1,
        interval: persistentRemoveProjection.fadeInterval,
        kind: "animated",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: 0,
      });
    }
    appendSample(draft, operation.entityId, "appearance", {
      interval: { end: draft.duration, start: persistentRemoveProjection.removedAt },
      kind: "exact",
      operationId: operation.id,
      provenanceId: `${operation.id}/provenance`,
      value: 0,
    });
    appendSample(draft, operation.entityId, "presence", {
      interval: { end: draft.duration, start: persistentRemoveProjection.removedAt },
      kind: "exact",
      operationId: operation.id,
      provenanceId: `${operation.id}/provenance`,
      value: false,
    });
    draft.lineage.push({
      at: persistentRemoveProjection.removedAt,
      from: operation.entityId,
      operationId: operation.id,
      relation: "removed",
      to: operation.entityId,
    });
    return;
  }
  const evaluate = operationCapability(operation).evaluate;
  if (!evaluate) {
    throw new TypeError(`${operation.kind} requires the Rust authoring projection.`);
  }
  evaluate(draft, operation as never, program);
}
