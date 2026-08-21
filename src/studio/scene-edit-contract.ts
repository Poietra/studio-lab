import { z } from "zod";

import { assetReferenceV1Schema, fragmentMaterialV1Schema } from "../engine/primitives";
import { studioPropertyKeyframeEasingSchema } from "../engine/scene-authoring";
import { styleProfileRefSchema } from "./style-profile";

export const SCENE_EDIT_VERSION = 1 as const;
export const canonicalRgbHexSchema = z.string().regex(/^#[0-9a-f]{6}$/u);

export function isCanonicalRgbHex(value: unknown): value is string {
  return canonicalRgbHexSchema.safeParse(value).success;
}

const pointSchema = z.object({ x: z.number(), y: z.number() });
const dataSeriesSchema = z
  .object({
    interpolation: z.enum(["linear", "smooth"]),
    points: z
      .array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict())
      .min(2)
      .max(256),
  })
  .strict();
const anglePairSchema = z
  .object({
    start: z.number().finite(),
    sweep: z.number().finite(),
  })
  .strict();
const coordinateAxisSchema = z
  .object({
    maximum: z.number().finite(),
    minimum: z.number().finite(),
    step: z.number().finite().positive(),
  })
  .strict();
const coordinateSystemSchema = z
  .object({
    x: coordinateAxisSchema,
    y: coordinateAxisSchema.optional(),
  })
  .strict();
const dimensionsSchema = z
  .object({
    angles: anglePairSchema.optional(),
    coordinateSystem: coordinateSystemSchema.optional(),
    height: z.number().positive().optional(),
    radius: z.number().positive().optional(),
    sides: z.number().int().min(3).max(32).optional(),
    width: z.number().positive().optional(),
  })
  .strict();
const studioImagePlacementSchema = z
  .object({
    asset: assetReferenceV1Schema,
    localRect: z
      .object({
        bottom: z.number().finite(),
        left: z.number().finite(),
        right: z.number().finite(),
        top: z.number().finite(),
      })
      .strict()
      .refine((rectangle) => rectangle.right > rectangle.left && rectangle.top > rectangle.bottom, {
        message: "Studio Image localRect must have positive width and height.",
      }),
    sampler: z.enum(["linear", "nearest"]),
  })
  .strict();
const studioSvgPathPlacementSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(256 * 1024),
  })
  .strict();
const intervalSchema = z.object({ end: z.number(), start: z.number() });
const provenanceSchema = z.object({
  evidence: z.array(z.string()),
  origin: z.enum(["direct-manipulation", "fixture", "remote-model", "studio-default"]),
});
const operationBaseSchema = z.object({
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
  textLayout: z
    .object({
      alignment: z.enum(["center", "left", "right"]),
      fontFamily: z.enum(["mono", "sans"]).default("sans"),
      fontSize: z.number().finite().positive().default(1),
      fontWeight: z.enum(["bold", "regular"]).default("regular"),
      lineHeight: z.number().finite().positive(),
    })
    .strict()
    .optional(),
});

/** Structural grammar shared by every accepted Scene Edit boundary. */
const sceneEditOperationStructureSchema = z.discriminatedUnion("kind", [
  operationBaseSchema.extend({
    entity: z.object({
      content: contentSchema.optional(),
      dataSeries: dataSeriesSchema.optional(),
      dimensions: dimensionsSchema.optional(),
      id: z.string(),
      image: studioImagePlacementSchema.optional(),
      svg: studioSvgPathPlacementSchema.optional(),
      lifetime: z.object({ end: z.number().nullable(), start: z.number() }),
      type: z.string(),
    }),
    kind: z.literal("CreateEntity"),
  }),
  operationBaseSchema.extend({
    easing: z.enum(["linear", "smooth"]),
    entityId: z.string(),
    kind: z.literal("DrawIn"),
  }),
  operationBaseSchema.extend({
    easing: z.literal("linear"),
    entityId: z.string(),
    kind: z.literal("WriteIn"),
  }),
  operationBaseSchema.extend({
    documentStatic: z.boolean().optional(),
    entityId: z.string(),
    from: z.union([z.boolean(), z.number(), z.string(), pointSchema, contentSchema]).optional(),
    key: z.enum([
      "appearance",
      "camera",
      "content",
      "fillColor",
      "sourceZIndex",
      "position",
      "presence",
      "rotation",
      "scale",
      "strokeColor",
      "visibility",
    ]),
    kind: z.literal("SetProperty"),
    value: z.union([z.boolean(), z.number(), z.string(), pointSchema, contentSchema]),
  }),
  operationBaseSchema.extend({
    control: pointSchema.optional(),
    easing: studioPropertyKeyframeEasingSchema,
    entityId: z.string(),
    from: z.union([pointSchema, z.number()]).optional(),
    key: z.enum(["appearance", "position", "rotation", "scale"]),
    kind: z.literal("AnimateProperty"),
    materialParameter: z
      .object({
        material: fragmentMaterialV1Schema,
        name: z.string().min(1).max(40),
        parameterIndex: z.number().int().nonnegative().max(7),
      })
      .strict()
      .optional(),
    relativeDelta: z.number().optional(),
    relativeFactor: z.number().positive().optional(),
    timelineTrack: z.literal(true).optional(),
    to: z.union([pointSchema, z.number()]),
  }),
  operationBaseSchema.extend({
    entityId: z.string(),
    from: z.object({ dimensions: dimensionsSchema, position: pointSchema }).strict(),
    kind: z.literal("ResizeEntity"),
    scale: z.number().positive(),
    shape: z.enum(["circle", "rectangle"]),
    to: z.object({ dimensions: dimensionsSchema, position: pointSchema }).strict(),
  }),
  operationBaseSchema.extend({
    controlOffset: pointSchema,
    delta: pointSchema,
    easing: z.enum(["linear", "smooth"]),
    kind: z.literal("CreateMotion"),
    orientToPath: z.boolean().optional(),
    rotationDeltaRadians: z
      .number()
      .finite()
      .refine((value) => value !== 0)
      .optional(),
    targetEntityIds: z.array(z.string()).min(1),
  }),
  operationBaseSchema.extend({
    easing: z.enum(["linear", "smooth"]),
    entityId: z.string(),
    from: z
      .object({
        dimensions: dimensionsSchema,
        shape: z.enum(["circle", "rectangle"]),
      })
      .strict(),
    kind: z.literal("TransformShape"),
    to: z
      .object({
        dimensions: dimensionsSchema,
        shape: z.enum(["circle", "rectangle"]),
      })
      .strict(),
  }),
  operationBaseSchema.extend({
    easing: z.enum(["linear", "smooth"]).optional(),
    kind: z.literal("TransformContent"),
    replacement: contentSchema,
    sourceEntityId: z.string(),
    strategy: z.enum(["replacement-transform", "transform-matching-tex"]),
    targetEntityId: z.string(),
    targetType: z.string().optional(),
  }),
  operationBaseSchema.extend({
    kind: z.literal("SetRelation"),
    mode: z.enum(["live", "snapshot"]),
    offset: pointSchema,
    placement: z.enum(["above", "below", "left", "right"]),
    relation: z.literal("next-to"),
    sourceEntityId: z.string(),
    targetEntityId: z.string(),
  }),
  operationBaseSchema.extend({
    childEntityIds: z.array(z.string().min(1)).min(2).max(64),
    groupId: z.string().min(1),
    kind: z.literal("GroupEntities"),
  }),
  operationBaseSchema.extend({
    groupId: z.string().min(1),
    kind: z.literal("UngroupEntity"),
  }),
  operationBaseSchema.extend({
    effect: z.enum(["cover", "fade-in", "remove", "reveal"]),
    entityId: z.string(),
    kind: z.literal("ChangePresence"),
    persistent: z.boolean(),
  }),
  operationBaseSchema.extend({
    eventKind: z.enum(["play", "wait"]),
    kind: z.literal("InsertTimelineEvent"),
    label: z.string(),
    purpose: z.literal("scene-duration").optional(),
  }),
  operationBaseSchema.extend({
    kind: z.literal("TrimSceneDuration"),
    removedDuration: z.number().finite().positive(),
    targetDuration: z.number().finite().positive(),
    waitOperationIds: z.array(z.string().min(1)).min(1).max(32),
  }),
  operationBaseSchema.extend({
    at: z.number(),
    destination: z.literal("next-scene"),
    kind: z.literal("InsertSceneBoundary"),
  }),
  operationBaseSchema.extend({
    easing: z.enum(["linear", "smooth"]),
    from: z
      .object({
        center: pointSchema,
        frameHeight: z.number().finite().positive(),
        frameWidth: z.number().finite().positive(),
      })
      .strict(),
    kind: z.literal("AnimateCamera"),
    to: z
      .object({
        center: pointSchema,
        frameHeight: z.number().finite().positive(),
        frameWidth: z.number().finite().positive(),
      })
      .strict(),
  }),
]);

export const sceneEditOperationSchema = sceneEditOperationStructureSchema.superRefine((operation, context) => {
  if (operation.kind === "SetProperty" && operation.documentStatic && operation.key !== "sourceZIndex") {
    context.addIssue({
      code: "custom",
      message: "Only canonical paint order can be declared document-static.",
      path: ["documentStatic"],
    });
  }
  if (
    operation.kind === "SetProperty" &&
    (operation.documentStatic || operation.from !== undefined) &&
    (operation.key !== "sourceZIndex" ||
      operation.documentStatic !== true ||
      typeof operation.from !== "number" ||
      !Number.isFinite(operation.from))
  ) {
    context.addIssue({
      code: "custom",
      message: "A document-static paint-order edit requires one finite previous z-index.",
      path: ["from"],
    });
  }
  if (
    operation.kind === "SetProperty" &&
    (operation.key === "fillColor" || operation.key === "strokeColor") &&
    !isCanonicalRgbHex(operation.value)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${operation.key} must be a lowercase canonical #rrggbb color.`,
      path: ["value"],
    });
  }
});

const finiteNumber = z.number().finite();
const resolvedAnchorSchema = z.object({
  capturedPlayhead: finiteNumber,
  evidence: z.array(z.string().max(500)).max(32),
  resolvedSeconds: finiteNumber.nonnegative(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("absolute"), seconds: finiteNumber }),
    z.object({ kind: z.literal("playhead"), referenceSeconds: finiteNumber }),
    z.object({
      kind: z.literal("playhead-offset"),
      offsetSeconds: finiteNumber,
      referenceSeconds: finiteNumber,
    }),
    z.object({
      boundary: z.enum(["play-end", "play-start", "scene-end", "scene-start"]),
      eventId: z.string(),
      kind: z.literal("structural"),
      offsetSeconds: finiteNumber.optional(),
    }),
  ]),
});

/** Non-empty structurally accepted edit. Semantic applicability remains a Rust decision. */
export const sceneEditSchema = z.object({
  anchor: resolvedAnchorSchema,
  intentCount: z.number().int().min(1).max(16),
  loweringStatus: z.enum(["illustrative", "supported", "unsupported"]),
  operations: z.array(sceneEditOperationSchema).min(1).max(64),
  provenance: z.object({
    evidence: z.array(z.string().max(500)).max(64),
    origin: z.enum(["direct-manipulation", "fixture", "remote-model", "studio-default"]),
    styleProfileRef: styleProfileRefSchema.optional(),
  }),
  requestedExecution: z.enum(["parallel", "sequence"]),
  schedule: z.object({
    edges: z
      .array(
        z.object({
          from: z.string(),
          reason: z.enum(["explicit", "identity", "lifetime", "read-after-write", "write-conflict"]),
          to: z.string(),
        }),
      )
      .max(256),
    mode: z.enum(["dependency-dag", "parallel", "sequence"]),
    order: z.array(z.string()).min(1).max(64),
  }),
  transactionId: z.string().min(1).max(160),
  version: z.literal(SCENE_EDIT_VERSION),
});

const draftBoundedIdSchema = z.string().min(1).max(512);
const draftEvidenceSchema = z.array(z.string().max(500)).max(64);
const draftTimeAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absolute"), seconds: finiteNumber }).strict(),
  z.object({ kind: z.literal("playhead"), referenceSeconds: finiteNumber }).strict(),
  z
    .object({
      kind: z.literal("playhead-offset"),
      offsetSeconds: finiteNumber,
      referenceSeconds: finiteNumber,
    })
    .strict(),
  z
    .object({
      boundary: z.enum(["play-end", "play-start", "scene-end", "scene-start"]),
      eventId: draftBoundedIdSchema,
      kind: z.literal("structural"),
      offsetSeconds: finiteNumber.optional(),
    })
    .strict(),
]);

/** Private, unaccepted envelope used while an edit may still be empty or invalid. */
export const sceneEditDraftSchema = z
  .object({
    anchor: z
      .object({
        capturedPlayhead: finiteNumber,
        evidence: draftEvidenceSchema,
        resolvedSeconds: finiteNumber.nonnegative(),
        source: draftTimeAnchorSchema,
      })
      .strict(),
    intentCount: z.number().int().min(0).max(16),
    loweringStatus: z.enum(["illustrative", "supported", "unsupported"]),
    operations: z.array(sceneEditOperationSchema).max(64),
    provenance: z
      .object({
        evidence: draftEvidenceSchema,
        origin: z.enum(["direct-manipulation", "fixture", "remote-model", "studio-default"]),
        styleProfileRef: styleProfileRefSchema.optional(),
      })
      .strict(),
    requestedExecution: z.enum(["parallel", "sequence"]),
    schedule: z
      .object({
        edges: z
          .array(
            z
              .object({
                from: draftBoundedIdSchema,
                reason: z.enum(["explicit", "identity", "lifetime", "read-after-write", "write-conflict"]),
                to: draftBoundedIdSchema,
              })
              .strict(),
          )
          .max(256),
        mode: z.enum(["dependency-dag", "parallel", "sequence"]),
        order: z.array(draftBoundedIdSchema).max(64),
      })
      .strict(),
    transactionId: z.string().min(1).max(160),
    version: z.literal(SCENE_EDIT_VERSION),
  })
  .strict();

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type SceneEditOperation = DeepReadonly<z.infer<typeof sceneEditOperationSchema>>;
export type SceneEdit = DeepReadonly<z.infer<typeof sceneEditSchema>>;
export type SceneEditDraft = DeepReadonly<z.infer<typeof sceneEditDraftSchema>>;
export type SceneEditOrigin = SceneEdit["provenance"]["origin"];
