import { z } from "zod";

import { easingV1Schema } from "../engine/scene-ir";

const finiteNumber = z.number().finite();
const pointSchema = z.object({ x: finiteNumber, y: finiteNumber }).strict();
const anglePairSchema = z.object({ start: finiteNumber, sweep: finiteNumber }).strict();
const coordinateAxisSchema = z
  .object({ maximum: finiteNumber, minimum: finiteNumber, step: finiteNumber.positive() })
  .strict();
const coordinateSystemSchema = z.object({ x: coordinateAxisSchema, y: coordinateAxisSchema.optional() }).strict();
const dimensionsSchema = z
  .object({
    angles: anglePairSchema.optional(),
    coordinateSystem: coordinateSystemSchema.optional(),
    height: finiteNumber.positive().optional(),
    radius: finiteNumber.positive().optional(),
    sides: finiteNumber.int().min(3).max(32).optional(),
    width: finiteNumber.positive().optional(),
  })
  .strict();
const intervalSchema = z
  .object({
    end: finiteNumber.nonnegative(),
    start: finiteNumber.nonnegative(),
  })
  .strict()
  .refine((interval) => interval.end >= interval.start, {
    message: "An interval must not end before it starts.",
    path: ["end"],
  });
const unknownSchema = z
  .object({
    evidence: z.array(z.string()).optional(),
    kind: z.literal("unknown"),
    reason: z.string(),
  })
  .strict();
const propertyKnowledgeSchema = z.union([
  z.object({ kind: z.literal("known"), value: z.union([dimensionsSchema, finiteNumber, pointSchema]) }).strict(),
  unknownSchema,
]);
const geometrySchema = z
  .object({
    dimensions: z.union([z.object({ kind: z.literal("known"), value: dimensionsSchema }).strict(), unknownSchema]),
    position: z.union([z.object({ kind: z.literal("known"), value: pointSchema }).strict(), unknownSchema]),
    scale: z.union([z.object({ kind: z.literal("known"), value: finiteNumber.positive() }).strict(), unknownSchema]),
    style: z.union([
      z
        .object({
          kind: z.literal("known"),
          value: z
            .object({
              color: z.string().optional(),
              fillColor: z.string().optional(),
              strokeCap: z.enum(["butt", "round", "square"]).optional(),
              strokeColor: z.string().optional(),
              strokeWidth: finiteNumber.positive().optional(),
            })
            .strict(),
        })
        .strict(),
      unknownSchema,
    ]),
  })
  .strict();
const contentSchema = z
  .object({
    displayLines: z.array(z.string()),
    label: z.string().optional(),
    texParts: z.array(z.string()).optional(),
    text: z.string().optional(),
  })
  .strict();
const propertyValueSchema = z.union([
  z.boolean(),
  finiteNumber,
  z.string(),
  pointSchema,
  dimensionsSchema,
  contentSchema,
  z.array(z.string()),
]);
const propertyChannelSampleSchema = z
  .object({
    control: pointSchema.optional(),
    easing: z.union([z.enum(["linear", "smooth", "manim-smooth"]), easingV1Schema]).optional(),
    from: propertyValueSchema.optional(),
    interval: intervalSchema,
    kind: z.enum(["animated", "exact"]),
    knowledge: propertyKnowledgeSchema.optional(),
    operationId: z.string().optional(),
    provenanceId: z.string(),
    relative: z.boolean().optional(),
    sameAnchorOrder: z.literal("before-studio-insertion").optional(),
    value: propertyValueSchema,
  })
  .strict();
const propertyChannelSchema = z
  .object({
    entityId: z.string(),
    key: z.enum([
      "appearance",
      "camera",
      "content",
      "dimensions",
      "fillColor",
      "sourceZIndex",
      "position",
      "presence",
      "rotation",
      "scale",
      "strokeCap",
      "strokeColor",
      "strokeWidth",
    ]),
    samples: z.array(propertyChannelSampleSchema),
  })
  .strict();
const runtimeEntitySchema = z
  .object({
    content: contentSchema.optional(),
    geometry: geometrySchema.optional(),
    id: z.string(),
    lifetime: z.array(intervalSchema),
    provisional: z.boolean(),
    sourceIdentity: z.union([z.object({ kind: z.literal("known"), value: z.string() }).strict(), unknownSchema]),
    transactionId: z.string().optional(),
    type: z.string(),
  })
  .strict();
const timelineEventSchema = z
  .object({
    at: finiteNumber.nonnegative().optional(),
    id: z.string(),
    interval: intervalSchema.optional(),
    kind: z.enum(["operation", "play", "scene-boundary", "wait"]),
    label: z.string(),
    operationId: z.string().optional(),
    transactionId: z.string().optional(),
  })
  .strict();
const constraintSchema = z
  .object({
    id: z.string(),
    mode: z.enum(["live", "snapshot"]),
    operationId: z.string(),
    relation: z.literal("next-to"),
    sourceEntityId: z.string(),
    targetEntityId: z.string(),
  })
  .strict();
const lineageSchema = z
  .object({
    at: finiteNumber.nonnegative(),
    from: z.string(),
    operationId: z.string(),
    relation: z.enum(["created", "replaces", "removed"]),
    to: z.string(),
  })
  .strict();
const provenanceRecordSchema = z
  .object({
    evidence: z.array(z.string()),
    id: z.string(),
    operationId: z.string().optional(),
    origin: z.enum(["direct-manipulation", "fixture", "import", "remote-model", "studio-default"]),
    transactionId: z.string().optional(),
  })
  .strict();

export const runtimeSceneStateSchema = z
  .object({
    constraintGraph: z.object({ constraints: z.array(constraintSchema) }).strict(),
    duration: finiteNumber.positive(),
    eventTrack: z.object({ events: z.array(timelineEventSchema) }).strict(),
    objectGraph: z
      .object({
        entities: z.record(z.string(), runtimeEntitySchema),
        lineage: z.array(lineageSchema),
      })
      .strict(),
    propertyChannels: z.record(z.string(), propertyChannelSchema),
    provenanceGraph: z.object({ records: z.array(provenanceRecordSchema) }).strict(),
    sceneId: z.string(),
    version: z.literal(1),
  })
  .strict();

const staticSemanticEntitySchema = z
  .object({
    runtimeIdentities: z.union([
      z.object({ kind: z.literal("known"), value: z.array(z.string()) }).strict(),
      unknownSchema,
    ]),
    sourceIdentity: z.string(),
    type: z.union([z.object({ kind: z.literal("known"), value: z.string() }).strict(), unknownSchema]),
  })
  .strict();

export const staticSemanticStateSchema = z
  .object({
    entities: z.array(staticSemanticEntitySchema),
    unknowns: z.array(unknownSchema),
    version: z.literal(1),
  })
  .strict();
