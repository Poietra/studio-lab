import { z } from "zod";

import type {
  ConstraintGraph,
  IdentityLineage,
  PropertyChannel,
  PropertyChannels,
  PropertyChannelSample,
  ProvenanceRecord,
  RuntimeEntity,
  RuntimeSceneState,
  SceneConstraint,
  TimelineEvent,
} from "./model";
import type {
  CanonicalEditOperation,
  CanonicalEditProgram,
  ChannelAccess,
  ProgramValidationIssue,
} from "./operations";
import { isPointValue, samplePropertyValue } from "./property-sampling";

const pointSchema = z.object({ x: z.number(), y: z.number() });
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
    to: z.union([pointSchema, z.number()]),
  }),
  baseSchema.extend({
    controlOffset: pointSchema,
    delta: pointSchema,
    easing: z.literal("smooth"),
    kind: z.literal("CreateMotion"),
    targetEntityIds: z.array(z.string()).min(1),
  }),
  baseSchema.extend({
    controlOffset: pointSchema,
    kind: z.literal("ModifyMotion"),
    motionId: z.string(),
    preserve: z.array(z.enum(["duration", "end", "start"])),
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
  baseSchema.extend({ eventKind: z.enum(["play", "wait"]), kind: z.literal("InsertTimelineEvent"), label: z.string() }),
  baseSchema.extend({ at: z.number(), destination: z.literal("next-scene"), kind: z.literal("InsertSceneBoundary") }),
  baseSchema.extend({ action: z.enum(["remove", "replace"]), constraintId: z.string(), kind: z.literal("ChangeConstraint") }),
  baseSchema.extend({ kind: z.literal("ChangeCamera"), property: z.enum(["position", "rotation", "scale"]), value: z.union([z.number(), pointSchema]) }),
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
  preview: "supported" | "unsupported";
}>;

export type ProgramExecutionCapabilities = OperationExecutionCapabilities;

type Capability<TKind extends CanonicalEditOperation["kind"]> = Readonly<{
  access: (operation: Extract<CanonicalEditOperation, { kind: TKind }>) => Readonly<{
    reads: readonly ChannelAccess[];
    writes: readonly ChannelAccess[];
  }>;
  defaults: Readonly<Record<string, unknown>>;
  evaluate: (
    draft: EvaluationDraft,
    operation: Extract<CanonicalEditOperation, { kind: TKind }>,
    program: CanonicalEditProgram,
  ) => void;
  execution: (
    operation: Extract<CanonicalEditOperation, { kind: TKind }>,
  ) => OperationExecutionCapabilities;
  lifetimeRequirement: "existing-at-start" | "explicit" | "none";
  projection: readonly ("canvas" | "inspector" | "object-list" | "semantic-thumbnail" | "timeline" | "working-playback")[];
  targetRequirement: "camera" | "constraint" | "entity" | "none";
  validate: (
    operation: Extract<CanonicalEditOperation, { kind: TKind }>,
    scene: RuntimeSceneState,
  ) => readonly ProgramValidationIssue[];
}>;

const SUPPORTED_EXECUTION: OperationExecutionCapabilities = {
  apply: "supported",
  applyBlocker: null,
  lowering: "supported",
  preview: "supported",
};

function previewOnlyExecution(
  applyBlocker: string,
  lowering: OperationExecutionCapabilities["lowering"] = "illustrative",
): OperationExecutionCapabilities {
  return {
    apply: "blocked",
    applyBlocker,
    lowering,
    preview: "supported",
  };
}

function createEntityExecution(
  operation: Extract<CanonicalEditOperation, { kind: "CreateEntity" }>,
): OperationExecutionCapabilities {
  const { content, type } = operation.entity;
  const hasMathTexContent = type === "MathTex"
    && ((content?.texParts?.length ?? 0) > 0 || (content?.displayLines?.length ?? 0) > 0);
  const isBuiltIn = type === "Text"
    || ["Arrow", "Circle", "Line", "Rectangle", "Square"].includes(type);
  const isTransitionOverlay = /^TransitionOverlay:(circle|diamond|hexagon):(black|sky|white)$/.test(type);
  if (hasMathTexContent || isBuiltIn || isTransitionOverlay) return SUPPORTED_EXECUTION;
  return previewOnlyExecution(
    `CreateEntity type ${type} can be previewed, but it has no safe Manim source lowering.`,
  );
}

function setPropertyExecution(
  operation: Extract<CanonicalEditOperation, { kind: "SetProperty" }>,
): OperationExecutionCapabilities {
  if (operation.key === "position" && isPointValue(operation.value)) return SUPPORTED_EXECUTION;
  return previewOnlyExecution(
    `SetProperty ${operation.key} can be previewed, but it has no truthful Manim source lowering.`,
  );
}

function animatePropertyExecution(
  operation: Extract<CanonicalEditOperation, { kind: "AnimateProperty" }>,
): OperationExecutionCapabilities {
  if (
    operation.key === "scale"
    && typeof operation.from === "number"
    && typeof operation.to === "number"
    && Number.isFinite(operation.from)
    && Number.isFinite(operation.to)
    && operation.from > 0
    && operation.to > 0
  ) return SUPPORTED_EXECUTION;
  const reason = operation.key === "scale"
    ? "Scale animation requires finite positive absolute from and to values before it can be lowered to Manim source."
    : `AnimateProperty ${operation.key} can be previewed, but it has no truthful Manim source lowering.`;
  return previewOnlyExecution(reason);
}

function createMotionExecution(
  operation: Extract<CanonicalEditOperation, { kind: "CreateMotion" }>,
): OperationExecutionCapabilities {
  if (operation.delta.x !== 0 || operation.delta.y !== 0) return SUPPORTED_EXECUTION;
  return previewOnlyExecution(
    "CreateMotion can be previewed, but a zero-displacement motion cannot be lowered to Manim source.",
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
    !Number.isFinite(operation.interval.start)
    || !Number.isFinite(operation.interval.end)
    || operation.interval.start < 0
    || operation.interval.end > scene.duration
    || operation.interval.end < operation.interval.start
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
    const activeLifetime = entity?.lifetime.find((lifetime) => (
      operation.interval.start >= lifetime.start && operation.interval.start < lifetime.end
    ));
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

const allEntityProjections = ["canvas", "inspector", "object-list", "semantic-thumbnail", "timeline", "working-playback"] as const;

export const OPERATION_REGISTRY = {
  CreateEntity: {
    access: (operation) => ({ reads: [], writes: [{ channel: "identity", entityId: operation.entity.id }, { channel: "presence", entityId: operation.entity.id }] }),
    defaults: { provisional: true },
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      const end = operation.entity.lifetime.end ?? draft.duration;
      draft.entities[operation.entity.id] = {
        content: operation.entity.content,
        id: operation.entity.id,
        lifetime: [{ end, start: operation.entity.lifetime.start }],
        provisional: true,
        sourceIdentity: { evidence: [operation.id], kind: "unknown", reason: "Entity has not been lowered to source yet." },
        transactionId: program.transactionId,
        type: operation.entity.type,
      };
      draft.lineage.push({ at: operation.interval.start, from: operation.entity.id, operationId: operation.id, relation: "created", to: operation.entity.id });
      appendSample(draft, operation.entity.id, "presence", {
        interval: { end, start: operation.entity.lifetime.start },
        kind: "exact",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: true,
      });
    },
    execution: createEntityExecution,
    lifetimeRequirement: "explicit",
    projection: allEntityProjections,
    targetRequirement: "none",
    validate: (operation, scene) => baseIssues(operation, scene),
  } satisfies Capability<"CreateEntity">,
  SetProperty: {
    access: (operation) => ({ reads: [], writes: [{ channel: operation.key, entityId: operation.entityId }] }),
    defaults: {},
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
    lifetimeRequirement: "existing-at-start",
    projection: allEntityProjections,
    targetRequirement: "entity",
    validate: (operation, scene) => entityIssues([operation.entityId], operation, scene),
  } satisfies Capability<"SetProperty">,
  AnimateProperty: {
    access: (operation) => ({ reads: [{ channel: operation.key, entityId: operation.entityId }], writes: [{ channel: operation.key, entityId: operation.entityId }] }),
    defaults: { easing: "smooth" },
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      const sampledFrom = sampleChannel(draft, operation.entityId, operation.key, operation.interval.start);
      const from = operation.from
        ?? (isPointValue(sampledFrom) || typeof sampledFrom === "number" ? sampledFrom : undefined);
      appendSample(draft, operation.entityId, operation.key, {
        control: operation.control,
        easing: operation.easing,
        from,
        interval: operation.interval,
        kind: "animated",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: operation.to,
      });
    },
    execution: animatePropertyExecution,
    lifetimeRequirement: "existing-at-start",
    projection: allEntityProjections,
    targetRequirement: "entity",
    validate: (operation, scene) => entityIssues([operation.entityId], operation, scene),
  } satisfies Capability<"AnimateProperty">,
  CreateMotion: {
    access: (operation) => ({
      reads: operation.targetEntityIds.map((entityId) => ({ channel: "position" as const, entityId })),
      writes: operation.targetEntityIds.map((entityId) => ({ channel: "position" as const, entityId })),
    }),
    defaults: { easing: "smooth" },
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      for (const entityId of operation.targetEntityIds) {
        const current = sampleChannel(draft, entityId, "position", operation.interval.start);
        const from = isPointValue(current) ? current : { x: 0, y: 0 };
        const to = { x: from.x + operation.delta.x, y: from.y + operation.delta.y };
        appendSample(draft, entityId, "position", {
          control: {
            x: (from.x + to.x) / 2 + operation.controlOffset.x,
            y: (from.y + to.y) / 2 + operation.controlOffset.y,
          },
          easing: operation.easing,
          from,
          interval: operation.interval,
          kind: "animated",
          operationId: operation.id,
          provenanceId: `${operation.id}/provenance`,
          relative: true,
          value: to,
        });
      }
    },
    execution: createMotionExecution,
    lifetimeRequirement: "existing-at-start",
    projection: allEntityProjections,
    targetRequirement: "entity",
    validate: (operation, scene) => entityIssues(operation.targetEntityIds, operation, scene),
  } satisfies Capability<"CreateMotion">,
  ModifyMotion: {
    access: (operation) => ({
      reads: [{ channel: "position", entityId: `motion:${operation.motionId}` }],
      writes: [{ channel: "position", entityId: `motion:${operation.motionId}` }],
    }),
    defaults: { preserve: ["start", "end", "duration"] },
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      for (const [channelId, channel] of Object.entries(draft.propertyChannels)) {
        if (channel.key !== "position") continue;
        const samples = channel.samples.map((sample) => {
          const matchesMotion = sample.operationId === operation.motionId
            || sample.provenanceId === operation.motionId
            || sample.provenanceId === `source:${operation.motionId}`;
          if (!matchesMotion || sample.kind !== "animated" || !isPointValue(sample.from) || !isPointValue(sample.value)) {
            return sample;
          }
          const control = sample.control ?? {
            x: (sample.from.x + sample.value.x) / 2,
            y: (sample.from.y + sample.value.y) / 2,
          };
          return {
            ...sample,
            control: {
              x: control.x + operation.controlOffset.x,
              y: control.y + operation.controlOffset.y,
            },
            operationId: operation.id,
          };
        });
        draft.propertyChannels[channelId] = { ...channel, samples };
      }
    },
    execution: () => previewOnlyExecution(
      "ModifyMotion has no truthful source lowering yet. It can be previewed, but editing an existing motion path cannot be applied.",
    ),
    lifetimeRequirement: "none",
    projection: allEntityProjections,
    targetRequirement: "none",
    validate: (operation, scene) => {
      const issues = baseIssues(operation, scene);
      const matches = Object.values(scene.propertyChannels).flatMap((channel) => (
        channel.key === "position"
          ? channel.samples.filter((sample) => (
              sample.operationId === operation.motionId
              || sample.provenanceId === operation.motionId
              || sample.provenanceId === `source:${operation.motionId}`
            ))
          : []
      ));
      if (matches.length === 0) {
        issues.push({
          code: "target-missing",
          field: "motionId",
          message: `Motion ${operation.motionId} does not exist in RuntimeSceneState.`,
          operationId: operation.id,
          severity: "error",
        });
      } else if (matches.some((sample) => (
        Math.abs(sample.interval.start - operation.interval.start) >= 0.001
        || Math.abs(sample.interval.end - operation.interval.end) >= 0.001
      ))) {
        issues.push({
          code: "interval-invalid",
          field: "interval",
          message: `ModifyMotion must preserve the ${operation.motionId} start, end, and duration.`,
          operationId: operation.id,
          severity: "error",
        });
      }
      return issues;
    },
  } satisfies Capability<"ModifyMotion">,
  TransformContent: {
    access: (operation) => ({
      reads: [{ channel: "content", entityId: operation.sourceEntityId }, { channel: "position", entityId: operation.sourceEntityId }],
      writes: [{ channel: "content", entityId: operation.sourceEntityId }, { channel: "identity", entityId: operation.targetEntityId }],
    }),
    defaults: { strategy: "transform-matching-tex" },
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      const source = draft.entities[operation.sourceEntityId];
      if (!source) return;
      const sourceLifetime = source.lifetime.find((entry) => operation.interval.start >= entry.start && operation.interval.start < entry.end);
      const inheritedEnd = sourceLifetime?.end ?? draft.duration;
      draft.entities[operation.sourceEntityId] = {
        ...source,
        lifetime: source.lifetime.map((entry) => entry === sourceLifetime ? { ...entry, end: Math.min(entry.end, operation.interval.end) } : entry),
      };
      draft.entities[operation.targetEntityId] = {
        content: operation.replacement,
        id: operation.targetEntityId,
        lifetime: [{ end: inheritedEnd, start: operation.interval.start }],
        provisional: true,
        sourceIdentity: source.sourceIdentity,
        transactionId: program.transactionId,
        type: operation.targetType ?? source.type,
      };
      draft.lineage.push({
        at: operation.interval.end,
        from: operation.sourceEntityId,
        operationId: operation.id,
        relation: "replaces",
        to: operation.targetEntityId,
      });
      for (const channel of Object.values(draft.propertyChannels).filter((entry) => entry.entityId === operation.sourceEntityId && entry.key !== "content")) {
        draft.propertyChannels[propertyKey(operation.targetEntityId, channel.key)] = {
          ...channel,
          entityId: operation.targetEntityId,
        };
      }
      appendSample(draft, operation.targetEntityId, "content", {
        interval: { end: inheritedEnd, start: operation.interval.end },
        kind: "exact",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: operation.replacement,
      });
      appendSample(draft, operation.sourceEntityId, "appearance", {
        easing: "smooth",
        from: 1,
        interval: operation.interval,
        kind: "animated",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: 0,
      });
      appendSample(draft, operation.targetEntityId, "appearance", {
        easing: "smooth",
        from: 0,
        interval: operation.interval,
        kind: "animated",
        operationId: operation.id,
        provenanceId: `${operation.id}/provenance`,
        value: 1,
      });
    },
    execution: () => SUPPORTED_EXECUTION,
    lifetimeRequirement: "existing-at-start",
    projection: allEntityProjections,
    targetRequirement: "entity",
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
      reads: [{ channel: "identity", entityId: operation.targetEntityId }, { channel: "position", entityId: operation.targetEntityId }],
      writes: [{ channel: "position", entityId: operation.sourceEntityId }],
    }),
    defaults: { mode: "snapshot" },
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
    execution: (operation) => operation.mode === "snapshot"
      ? SUPPORTED_EXECUTION
      : previewOnlyExecution(
          "SetRelation live has no truthful source lowering; only snapshot relations can be applied.",
        ),
    lifetimeRequirement: "existing-at-start",
    projection: allEntityProjections,
    targetRequirement: "entity",
    validate: (operation, scene) => entityIssues([operation.sourceEntityId, operation.targetEntityId], operation, scene),
  } satisfies Capability<"SetRelation">,
  ChangePresence: {
    access: (operation) => ({ reads: [{ channel: "presence", entityId: operation.entityId }], writes: [{ channel: "appearance", entityId: operation.entityId }, { channel: "presence", entityId: operation.entityId }] }),
    defaults: { persistent: false },
    evaluate: (draft, operation, program) => {
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
      if (operation.effect === "remove" && operation.persistent) {
        const entity = draft.entities[operation.entityId];
        if (entity) {
          draft.entities[operation.entityId] = {
            ...entity,
            lifetime: entity.lifetime.map((interval) => (
              operation.interval.start >= interval.start && operation.interval.start < interval.end
                ? { ...interval, end: Math.min(interval.end, operation.interval.end) }
                : interval
            )),
          };
          draft.lineage.push({
            at: operation.interval.end,
            from: operation.entityId,
            operationId: operation.id,
            relation: "removed",
            to: operation.entityId,
          });
        }
        appendSample(draft, operation.entityId, "presence", {
          interval: { end: draft.duration, start: operation.interval.end },
          kind: "exact",
          operationId: operation.id,
          provenanceId: `${operation.id}/provenance`,
          value: false,
        });
      }
    },
    execution: changePresenceExecution,
    lifetimeRequirement: "existing-at-start",
    projection: allEntityProjections,
    targetRequirement: "entity",
    validate: (operation, scene) => entityIssues([operation.entityId], operation, scene),
  } satisfies Capability<"ChangePresence">,
  InsertTimelineEvent: {
    access: () => ({ reads: [], writes: [] }),
    defaults: {},
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      draft.events.push({ id: `${operation.id}/timeline`, interval: operation.interval, kind: operation.eventKind, label: operation.label, operationId: operation.id, transactionId: program.transactionId });
    },
    execution: (operation) => operation.eventKind === "wait"
      ? SUPPORTED_EXECUTION
      : previewOnlyExecution(
          "Only an explicit wait timeline event has truthful Manim source lowering.",
        ),
    lifetimeRequirement: "none",
    projection: ["timeline", "inspector"],
    targetRequirement: "none",
    validate: (operation, scene) => {
      const issues: ProgramValidationIssue[] = [];
      if (
        !Number.isFinite(operation.interval.start)
        || !Number.isFinite(operation.interval.end)
        || operation.interval.start < 0
        || operation.interval.start > scene.duration
        || operation.interval.end < operation.interval.start
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
      return issues;
    },
  } satisfies Capability<"InsertTimelineEvent">,
  InsertSceneBoundary: {
    access: () => ({ reads: [], writes: [] }),
    defaults: { destination: "next-scene" },
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      draft.events.push({ at: operation.at, id: `${operation.id}/boundary`, kind: "scene-boundary", label: "Full-cover Scene boundary", operationId: operation.id, transactionId: program.transactionId });
    },
    execution: () => SUPPORTED_EXECUTION,
    lifetimeRequirement: "none",
    projection: ["timeline", "inspector", "semantic-thumbnail", "working-playback"],
    targetRequirement: "none",
    validate: (operation, scene) => baseIssues(operation, scene),
  } satisfies Capability<"InsertSceneBoundary">,
  ChangeConstraint: {
    access: () => ({ reads: [], writes: [] }),
    defaults: {},
    evaluate: (draft, operation, program) => {
      recordOperation(draft, operation, program);
      draft.constraints = draft.constraints.filter((constraint) => constraint.id !== operation.constraintId);
    },
    execution: () => previewOnlyExecution(
      "ChangeConstraint is read-only until constraint edits have truthful Manim source lowering.",
      "unsupported",
    ),
    lifetimeRequirement: "none",
    projection: ["inspector"],
    targetRequirement: "constraint",
    validate: (operation, scene) => baseIssues(operation, scene),
  } satisfies Capability<"ChangeConstraint">,
  ChangeCamera: {
    access: () => ({ reads: [{ channel: "camera", entityId: "camera" }], writes: [{ channel: "camera", entityId: "camera" }] }),
    defaults: {},
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
    execution: () => previewOnlyExecution(
      "CameraFocus can be previewed, but ChangeCamera cannot yet be lowered back to Manim source.",
    ),
    lifetimeRequirement: "none",
    projection: ["canvas", "inspector", "semantic-thumbnail", "working-playback"],
    targetRequirement: "camera",
    validate: (operation, scene) => baseIssues(operation, scene),
  } satisfies Capability<"ChangeCamera">,
} as const;

export function operationCapability(operation: CanonicalEditOperation) {
  return OPERATION_REGISTRY[operation.kind] as Capability<CanonicalEditOperation["kind"]>;
}

export function operationExecutionCapabilities(
  operation: CanonicalEditOperation,
): OperationExecutionCapabilities {
  return operationCapability(operation).execution(operation as never);
}

const LOWERING_PRIORITY: Readonly<Record<OperationExecutionCapabilities["lowering"], number>> = {
  illustrative: 1,
  supported: 0,
  unsupported: 2,
};

export function programExecutionCapabilities(
  program: CanonicalEditProgram,
): ProgramExecutionCapabilities {
  const operationCapabilities = program.operations.map(operationExecutionCapabilities);
  const lowering = [
    program.loweringStatus,
    ...operationCapabilities.map((capability) => capability.lowering),
  ].reduce<OperationExecutionCapabilities["lowering"]>((current, candidate) => (
    LOWERING_PRIORITY[candidate] > LOWERING_PRIORITY[current] ? candidate : current
  ), "supported");
  const blockedOperation = operationCapabilities.find((capability) => capability.apply !== "supported");
  const unsupportedPreview = operationCapabilities.find((capability) => capability.preview !== "supported");
  const applyBlocker = blockedOperation?.applyBlocker
    ?? (program.loweringStatus !== "supported"
      ? `This Program is marked ${program.loweringStatus} and cannot be applied until it has truthful Manim source lowering.`
      : null);
  return {
    apply: applyBlocker === null && lowering === "supported" ? "supported" : "blocked",
    applyBlocker,
    lowering,
    preview: unsupportedPreview ? "unsupported" : "supported",
  };
}

export function operationAccess(operation: CanonicalEditOperation) {
  return operationCapability(operation).access(operation as never);
}

export function validateOperation(operation: CanonicalEditOperation, scene: RuntimeSceneState) {
  const parsed = canonicalOperationSchema.safeParse(operation);
  if (!parsed.success) {
    return [{
      code: "schema-invalid" as const,
      field: parsed.error.issues[0]?.path.join(".") || "operation",
      message: parsed.error.issues[0]?.message ?? "Operation does not match the closed schema.",
      operationId: operation.id,
      severity: "error" as const,
    }];
  }
  return operationCapability(operation).validate(operation as never, scene);
}

export function evaluateOperation(draft: EvaluationDraft, operation: CanonicalEditOperation, program: CanonicalEditProgram) {
  operationCapability(operation).evaluate(draft, operation as never, program);
}

export function constraintGraph(constraints: readonly SceneConstraint[]): ConstraintGraph {
  return { constraints };
}

export function propertyChannels(channels: Record<string, PropertyChannel>): PropertyChannels {
  return channels;
}
