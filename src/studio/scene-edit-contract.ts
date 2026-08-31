import { z } from "zod";
import { studioCubicBezierPathSchema, studioCubicBezierSpecSchema } from "../engine/cubic-bezier-authoring";
import {
  assetReferenceV1Schema,
  fragmentMaterialV1Schema,
  MAX_FINITE_F32,
  MAX_FRAGMENT_MATERIAL_PARAMETERS_V1,
  scenePostEffectV1Schema,
} from "../engine/primitives";
import { studioPropertyKeyframeEasingSchema } from "../engine/scene-authoring";
import { MAX_SCENE_POST_EFFECTS_V1 } from "../engine/scene-post-effect-registry";
import { styleProfileRefSchema } from "./style-profile";

export const SCENE_EDIT_VERSION = 1 as const;
export const MAX_SCENE_EDIT_OPERATIONS = 64;
export const canonicalRgbHexSchema = z.string().regex(/^#[0-9a-f]{6}$/u);
export const studioScenePostEffectV1Schema = scenePostEffectV1Schema;
export type StudioScenePostEffectV1 = DeepReadonly<z.infer<typeof studioScenePostEffectV1Schema>>;
export const scenePostEffectStackV1Schema = z
  .array(studioScenePostEffectV1Schema)
  .max(MAX_SCENE_POST_EFFECTS_V1)
  .superRefine((effects, context) => {
    const identities = new Set<string>();
    effects.forEach((effect, index) => {
      const identity = `${effect.shaderId}\u0000${effect.revision}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A Scene post-effect stack cannot contain the same shader revision more than once.",
          path: [index],
        });
      }
      identities.add(identity);
    });
  });
export type StudioScenePostEffectStackV1 = DeepReadonly<z.infer<typeof scenePostEffectStackV1Schema>>;

export const MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES = 32;
export const MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_TRACKS = 32;
const scenePostEffectParameterKeyframeSchema = z
  .object({
    easing: studioPropertyKeyframeEasingSchema,
    time: z.number().finite().nonnegative(),
    value: z.number().finite().min(-MAX_FINITE_F32).max(MAX_FINITE_F32),
  })
  .strict();
export const scenePostEffectParameterTrackSchema = z
  .object({
    keyframes: z
      .array(scenePostEffectParameterKeyframeSchema)
      .min(2)
      .max(MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES),
    name: z.string().trim().min(1).max(40),
    parameterIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FRAGMENT_MATERIAL_PARAMETERS_V1 - 1),
    revision: z.number().int().positive().max(0xffff_ffff),
    shaderId: z.string().min(1),
  })
  .strict();
export type ScenePostEffectParameterTrack = DeepReadonly<z.infer<typeof scenePostEffectParameterTrackSchema>>;
export const scenePostEffectParameterTracksSchema = z
  .array(scenePostEffectParameterTrackSchema)
  .max(MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_TRACKS)
  .superRefine((tracks, context) => {
    const targets = new Set<string>();
    tracks.forEach((track, index) => {
      const target = `${track.shaderId}\u0000${track.revision}\u0000${track.parameterIndex}`;
      if (targets.has(target)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A Scene post-effect parameter can have at most one track.",
          path: [index],
        });
      }
      targets.add(target);
    });
  });

export function isCanonicalRgbHex(value: unknown): value is string {
  return canonicalRgbHexSchema.safeParse(value).success;
}

const pointSchema = z.object({ x: z.number(), y: z.number() });
export const strokeDashSchema = z
  .object({
    dashLength: z.number().finite().min(0.02).max(2),
    gapLength: z.number().finite().min(0.02).max(2),
  })
  .strict();
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
      wrapWidth: z.number().finite().positive().optional(),
    })
    .strict()
    .optional(),
});

/** Structural grammar shared by every accepted Scene Edit boundary. */
const sceneEditOperationStructureSchema = z.discriminatedUnion("kind", [
  operationBaseSchema.extend({
    entity: z.object({
      content: contentSchema.optional(),
      cubicBezier: studioCubicBezierSpecSchema.optional(),
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
    from: z
      .union([z.boolean(), z.number(), z.string(), pointSchema, contentSchema, strokeDashSchema, z.null()])
      .optional(),
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
      "strokeCap",
      "strokeColor",
      "strokeDash",
      "strokeJoin",
      "strokeWidth",
      "visibility",
    ]),
    kind: z.literal("SetProperty"),
    value: z.union([z.boolean(), z.number(), z.string(), pointSchema, contentSchema, strokeDashSchema, z.null()]),
  }),
  operationBaseSchema.extend({
    control: pointSchema.optional(),
    easing: studioPropertyKeyframeEasingSchema,
    entityId: z.string(),
    from: z.union([pointSchema, z.number(), z.string()]).optional(),
    key: z.enum(["appearance", "fillColor", "position", "rotation", "scale", "strokeColor"]),
    kind: z.literal("AnimateProperty"),
    materialParameter: z
      .object({
        material: fragmentMaterialV1Schema,
        name: z.string().min(1).max(40),
        parameterIndex: z.number().int().nonnegative().max(7),
        rgbComponent: z.enum(["r", "g", "b"]).optional(),
      })
      .strict()
      .optional(),
    relativeDelta: z.number().optional(),
    relativeFactor: z.number().positive().optional(),
    timelineTrack: z.literal(true).optional(),
    to: z.union([pointSchema, z.number(), z.string()]),
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
    kind: z.literal("CreatePathMotion"),
    pathEntityId: z.string().min(1),
    targetEntityId: z.string().min(1),
  }),
  operationBaseSchema.extend({
    easing: z.enum(["linear", "smooth"]),
    entityId: z.string(),
    from: z
      .object({
        dimensions: dimensionsSchema,
        shape: z.enum(["circle", "ellipse", "rectangle", "regular-polygon", "triangle"]),
      })
      .strict(),
    kind: z.literal("TransformShape"),
    to: z
      .object({
        dimensions: dimensionsSchema,
        shape: z.enum(["circle", "ellipse", "rectangle", "regular-polygon", "triangle"]),
      })
      .strict(),
  }),
  operationBaseSchema.extend({
    easing: z.enum(["linear", "smooth"]),
    entityId: z.string(),
    from: studioCubicBezierPathSchema,
    kind: z.literal("TransformPath"),
    to: studioCubicBezierPathSchema,
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
    color: canonicalRgbHexSchema,
    kind: z.literal("SetSceneBackground"),
  }),
  operationBaseSchema.extend({
    effects: scenePostEffectStackV1Schema,
    kind: z.literal("SetScenePostEffect"),
    parameterTracks: scenePostEffectParameterTracksSchema.default([]),
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

const canonicalSceneEditOperationSchema = sceneEditOperationStructureSchema.superRefine((operation, context) => {
  if (operation.kind === "SetScenePostEffect") {
    operation.parameterTracks.forEach((track, trackIndex) => {
      const effect = operation.effects.find(
        (candidate) => candidate.shaderId === track.shaderId && candidate.revision === track.revision,
      );
      const baseValue = effect?.parameters[track.parameterIndex];
      if (baseValue === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The Scene post-effect parameter track must target an existing effect parameter.",
          path: ["parameterTracks", trackIndex],
        });
      } else if (Math.abs(track.keyframes[0]!.value - baseValue) > 0.0005) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The first Scene post-effect keyframe must preserve the effect's static parameter value.",
          path: ["parameterTracks", trackIndex, "keyframes", 0, "value"],
        });
      }
      if (track.keyframes.slice(1).some((keyframe, index) => keyframe.time <= track.keyframes[index]!.time + 0.0005)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Scene post-effect parameter keyframes must be ordered and distinct.",
          path: ["parameterTracks", trackIndex, "keyframes"],
        });
      }
    });
  }
  if (operation.kind === "SetProperty" && operation.value === null && operation.key !== "strokeDash") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only strokeDash accepts null to restore a solid stroke.",
      path: ["value"],
    });
  }
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
  if (
    operation.kind === "SetProperty" &&
    operation.key === "strokeDash" &&
    operation.value !== null &&
    !strokeDashSchema.safeParse(operation.value).success
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "strokeDash lengths must each be finite values from 0.02 to 2 scene units, or null for solid.",
      path: ["value"],
    });
  }
  if (operation.kind === "AnimateProperty" && (operation.key === "fillColor" || operation.key === "strokeColor")) {
    if (!isCanonicalRgbHex(operation.from)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${operation.key} from must be a lowercase canonical #rrggbb color.`,
        path: ["from"],
      });
    }
    if (!isCanonicalRgbHex(operation.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${operation.key} to must be a lowercase canonical #rrggbb color.`,
        path: ["to"],
      });
    }
    if (operation.timelineTrack !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${operation.key} animation must be an explicit Timeline track.`,
        path: ["timelineTrack"],
      });
    }
    if (operation.easing !== "linear" && operation.easing !== "smooth") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${operation.key} animation supports only linear or smooth easing.`,
        path: ["easing"],
      });
    }
  }
  if (operation.kind === "AnimateProperty" && operation.materialParameter?.rgbComponent) {
    const componentOffset = { b: 2, g: 1, r: 0 }[operation.materialParameter.rgbComponent];
    const rootParameterIndex = operation.materialParameter.parameterIndex - componentOffset;
    if (rootParameterIndex < 0 || rootParameterIndex + 2 >= MAX_FRAGMENT_MATERIAL_PARAMETERS_V1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An RGB material component must belong to three consecutive host slots.",
        path: ["materialParameter", "parameterIndex"],
      });
    }
  }
  if (
    operation.kind === "SetProperty" &&
    operation.key === "strokeCap" &&
    operation.value !== "butt" &&
    operation.value !== "round" &&
    operation.value !== "square"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "strokeCap must be butt, round, or square.",
      path: ["value"],
    });
  }
  if (
    operation.kind === "SetProperty" &&
    operation.key === "strokeJoin" &&
    operation.value !== "bevel" &&
    operation.value !== "miter" &&
    operation.value !== "round"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "strokeJoin must be bevel, miter, or round.",
      path: ["value"],
    });
  }
  if (
    operation.kind === "SetProperty" &&
    operation.key === "strokeWidth" &&
    (typeof operation.value !== "number" ||
      !Number.isFinite(operation.value) ||
      operation.value < 0.005 ||
      operation.value > 0.5)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "strokeWidth must be a finite world-space width from 0.005 to 0.5.",
      path: ["value"],
    });
  }
});

function normalizeLegacyScenePostEffectOperation(input: unknown): unknown {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (input as Readonly<Record<string, unknown>>).kind !== "SetScenePostEffect"
  ) {
    return input;
  }
  const record = input as Readonly<Record<string, unknown>>;
  let operation = record;
  if (!("effects" in operation) && "effect" in operation) {
    const { effect, ...rest } = operation;
    operation = { ...rest, effects: effect === null || effect === undefined ? [] : [effect] };
  }
  if (!("parameterTracks" in operation) && "parameterTrack" in operation) {
    const { parameterTrack, ...rest } = operation;
    operation = {
      ...rest,
      parameterTracks: parameterTrack === null || parameterTrack === undefined ? [] : [parameterTrack],
    };
  }
  return operation;
}

/**
 * Canonicalizes only former Scene-effect aliases before a deep-strict
 * persisted-wire check. Every other key remains available to reject.
 */
export function normalizeLegacySceneEditWireAliases(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(normalizeLegacySceneEditWireAliases);
  if (typeof input !== "object" || input === null) return input;
  const normalized = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, normalizeLegacySceneEditWireAliases(value)]),
  );
  return normalizeLegacyScenePostEffectOperation(normalized);
}

/** Reads former singleton Scene effect shapes and returns only the canonical stack and track arrays. */
export const sceneEditOperationSchema = z.preprocess(
  normalizeLegacyScenePostEffectOperation,
  canonicalSceneEditOperationSchema,
);

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
  operations: z.array(sceneEditOperationSchema).min(1).max(MAX_SCENE_EDIT_OPERATIONS),
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
    order: z.array(z.string()).min(1).max(MAX_SCENE_EDIT_OPERATIONS),
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
    operations: z.array(sceneEditOperationSchema).max(MAX_SCENE_EDIT_OPERATIONS),
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
        order: z.array(draftBoundedIdSchema).max(MAX_SCENE_EDIT_OPERATIONS),
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

type ShapeTransformEndpoint = Extract<SceneEditOperation, { kind: "TransformShape" }>["from"];

export function shapeTransformChangesShape(from: ShapeTransformEndpoint, to: ShapeTransformEndpoint) {
  if (from.shape !== to.shape) return true;
  return (
    from.shape === "regular-polygon" && to.shape === "regular-polygon" && from.dimensions.sides !== to.dimensions.sides
  );
}

export function studioEntityTypeSupportsStrokeWidth(type: string) {
  return (
    type === "Line" ||
    type === "Arc" ||
    type === "Axes" ||
    type === "DataPlot" ||
    type === "NumberLine" ||
    type === "NumberPlane" ||
    type === "Circle" ||
    type === "Rectangle" ||
    type === "Ellipse" ||
    type === "Triangle" ||
    type === "RegularPolygon"
  );
}

export function studioEntityTypeSupportsStrokeCap(type: string) {
  return ["Arc", "Axes", "DataPlot", "Line", "NumberLine", "NumberPlane"].includes(type);
}

export function studioEntityTypeMayExposeStrokeDash(type: string) {
  return type === "Line" || type === "CubicBezier" || type === "Arrow" || studioEntityTypeSupportsStrokeWidth(type);
}

export function studioPaintColorTrackProperty(
  type: string,
  cubicBezier?: Readonly<{ closed?: boolean; fillColor?: string }>,
): "fillColor" | "strokeColor" | null {
  if (type === "CubicBezier") {
    if (cubicBezier?.closed === true) {
      return isCanonicalRgbHex(cubicBezier.fillColor) ? "fillColor" : null;
    }
    return "strokeColor";
  }
  if (["Circle", "Ellipse", "MathTex", "Rectangle", "RegularPolygon", "Text", "Triangle"].includes(type)) {
    return "fillColor";
  }
  if (["Arc", "Axes", "DataPlot", "Line", "NumberLine", "NumberPlane"].includes(type)) {
    return "strokeColor";
  }
  return null;
}
