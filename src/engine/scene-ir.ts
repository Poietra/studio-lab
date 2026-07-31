import { z } from "zod";

import {
  assetManifestReferenceV1Schema,
  assetReferenceV1Schema,
  coordinateV1Schema,
  countCubicPathSegments,
  cubicPathV1Schema,
  engineAffineTransformV1Schema,
  enginePointV1Schema,
  evidenceV1Schema,
  fillStyleV1Schema,
  finiteNumberV1Schema,
  MAX_COORDINATE,
  MAX_TOTAL_PATH_SEGMENTS,
  normalizedNumberV1Schema,
  POIETRA_ENGINE_CONTRACT_VERSION,
  reportDuplicateIds,
  rgbaColorV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
  strokeStyleV1Schema,
} from "./primitives";

const MAX_ENTITIES = 10_000;
const MAX_CHANNELS = 10_000;
const MAX_KEYFRAMES = 100_000;

const intervalV1Schema = z
  .object({
    end: finiteNumberV1Schema.nonnegative(),
    start: finiteNumberV1Schema.nonnegative(),
  })
  .strict()
  .refine((interval) => interval.end > interval.start, {
    message: "A lifetime interval must have positive duration.",
    path: ["end"],
  });

const circleGeometryV1Schema = z
  .object({
    center: enginePointV1Schema,
    kind: z.literal("circle"),
    radius: finiteNumberV1Schema.positive().max(MAX_COORDINATE),
  })
  .strict();

const rectangleGeometryV1Schema = z
  .object({
    center: enginePointV1Schema,
    cornerRadius: finiteNumberV1Schema.nonnegative().max(MAX_COORDINATE),
    height: finiteNumberV1Schema.positive().max(MAX_COORDINATE),
    kind: z.literal("rectangle"),
    width: finiteNumberV1Schema.positive().max(MAX_COORDINATE),
  })
  .strict();

const lineGeometryV1Schema = z
  .object({
    end: enginePointV1Schema,
    kind: z.literal("line"),
    start: enginePointV1Schema,
  })
  .strict();

const cubicPathGeometryV1Schema = z
  .object({
    kind: z.literal("cubic-path"),
    path: cubicPathV1Schema,
  })
  .strict();

const imageLocalRectV1Schema = z
  .object({
    bottom: coordinateV1Schema,
    left: coordinateV1Schema,
    right: coordinateV1Schema,
    top: coordinateV1Schema,
  })
  .strict()
  .refine((rectangle) => rectangle.right > rectangle.left && rectangle.top > rectangle.bottom, {
    message: "Image localRect must have positive width and height.",
  });

const imageGeometryV1Schema = z
  .object({
    asset: assetReferenceV1Schema,
    kind: z.literal("image"),
    localRect: imageLocalRectV1Schema,
    sampler: z.enum(["linear", "nearest"]),
  })
  .strict();

const sceneGeometryV1Schema = z.discriminatedUnion("kind", [
  circleGeometryV1Schema,
  cubicPathGeometryV1Schema,
  imageGeometryV1Schema,
  lineGeometryV1Schema,
  rectangleGeometryV1Schema,
]);

export function countLoweredSceneGeometrySegmentsV1(geometry: z.infer<typeof sceneGeometryV1Schema>) {
  if (geometry.kind === "image") return 0;
  if (geometry.kind === "circle") return 4;
  if (geometry.kind === "line") return 1;
  if (geometry.kind === "rectangle") return geometry.cornerRadius === 0 ? 4 : 8;
  return countCubicPathSegments(geometry.path) + geometry.path.subpaths.filter((subpath) => subpath.closed).length;
}

const vectorAppearanceV1Schema = z
  .object({
    fill: fillStyleV1Schema.nullable(),
    kind: z.literal("vector"),
    opacity: normalizedNumberV1Schema,
    stroke: strokeStyleV1Schema.nullable(),
  })
  .strict();

const imageAppearanceV1Schema = z
  .object({
    kind: z.literal("image"),
    opacity: normalizedNumberV1Schema,
  })
  .strict();

export const sceneEntityV1Schema = z
  .object({
    appearance: z.discriminatedUnion("kind", [imageAppearanceV1Schema, vectorAppearanceV1Schema]),
    geometry: sceneGeometryV1Schema,
    id: sourceIdentityV1Schema,
    lifetimes: z.array(intervalV1Schema).min(1).max(64),
    parentId: sourceIdentityV1Schema.nullable(),
    provenanceId: sourceIdentityV1Schema,
    sceneOrder: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_ENTITIES - 1),
    sourceZIndex: finiteNumberV1Schema,
    transform: engineAffineTransformV1Schema,
  })
  .strict();

const easingV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linear") }).strict(),
  z.object({ kind: z.literal("smooth") }).strict(),
  z
    .object({
      kind: z.literal("cubic-bezier"),
      x1: normalizedNumberV1Schema,
      x2: normalizedNumberV1Schema,
      y1: normalizedNumberV1Schema,
      y2: normalizedNumberV1Schema,
    })
    .strict(),
]);

function keyframeV1Schema<T extends z.ZodType>(value: T) {
  return z
    .object({
      at: finiteNumberV1Schema.nonnegative(),
      easingToNext: easingV1Schema.nullable(),
      value,
    })
    .strict();
}

const entityChannelBase = {
  entityId: sourceIdentityV1Schema,
  id: sourceIdentityV1Schema,
  provenanceId: sourceIdentityV1Schema,
};

const affineTransformChannelV1Schema = z
  .object({
    ...entityChannelBase,
    keyframes: z.array(keyframeV1Schema(engineAffineTransformV1Schema)).min(2).max(MAX_KEYFRAMES),
    kind: z.literal("affine-transform"),
  })
  .strict();

const opacityChannelV1Schema = z
  .object({
    ...entityChannelBase,
    keyframes: z.array(keyframeV1Schema(normalizedNumberV1Schema)).min(2).max(MAX_KEYFRAMES),
    kind: z.literal("opacity"),
  })
  .strict();

const pathTrimChannelV1Schema = z
  .object({
    ...entityChannelBase,
    keyframes: z.array(keyframeV1Schema(normalizedNumberV1Schema)).min(2).max(MAX_KEYFRAMES),
    kind: z.literal("path-trim"),
    parameterization: z.enum(["arc-length-v1", "uniform-cubic-parameter-v1"]).optional(),
  })
  .strict();

const pathMorphChannelV1Schema = z
  .object({
    ...entityChannelBase,
    keyframes: z.array(keyframeV1Schema(cubicPathV1Schema)).min(2).max(256),
    kind: z.literal("path-morph"),
  })
  .strict();

const motionPathChannelV1Schema = z
  .object({
    ...entityChannelBase,
    keyframes: z.array(keyframeV1Schema(normalizedNumberV1Schema)).min(2).max(MAX_KEYFRAMES),
    kind: z.literal("motion-path"),
    orientToPath: z.boolean(),
    parameterization: z.enum(["arc-length-v1", "manim-point-from-proportion-v1"]).optional(),
    path: cubicPathV1Schema,
  })
  .strict();

export const sceneCameraViewV1Schema = z
  .object({
    center: enginePointV1Schema,
    frameHeight: finiteNumberV1Schema.positive().max(MAX_COORDINATE),
    frameWidth: finiteNumberV1Schema.positive().max(MAX_COORDINATE),
  })
  .strict();

export const sceneCameraV1Schema = z
  .object({
    background: rgbaColorV1Schema,
    view: sceneCameraViewV1Schema,
  })
  .strict();

const cameraChannelV1Schema = z
  .object({
    id: sourceIdentityV1Schema,
    keyframes: z.array(keyframeV1Schema(sceneCameraViewV1Schema)).min(2).max(MAX_KEYFRAMES),
    kind: z.literal("camera"),
    provenanceId: sourceIdentityV1Schema,
  })
  .strict();

export const animationChannelV1Schema = z.discriminatedUnion("kind", [
  affineTransformChannelV1Schema,
  cameraChannelV1Schema,
  motionPathChannelV1Schema,
  opacityChannelV1Schema,
  pathMorphChannelV1Schema,
  pathTrimChannelV1Schema,
]);

export const sceneSourceV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      editProgramVersion: z.literal(1),
      kind: z.literal("studio-edit-program"),
      revisionHash: sha256V1Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("imported-manim-server-snapshot"),
      runtimeConfigHash: sha256V1Schema,
      snapshotHash: sha256V1Schema,
      snapshotVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      sourceHash: sha256V1Schema,
    })
    .strict(),
]);

export const provenanceRecordV1Schema = z
  .object({
    evidence: z.array(evidenceV1Schema).max(64),
    id: sourceIdentityV1Schema,
    origin: z.enum(["fast-manim-server-snapshot", "fixture", "studio-edit-program"]),
  })
  .strict();

export const fidelityV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact") }).strict(),
  z
    .object({
      evidence: z.array(evidenceV1Schema).min(1).max(64),
      kind: z.literal("approximate"),
    })
    .strict(),
]);

export const sceneCapabilityV1Schema = z.enum([
  "affine-transform-animation",
  "camera-animation",
  "cubic-path-geometry",
  "motion-path-animation",
  "opacity-animation",
  "path-morph-animation",
  "path-trim-animation",
  "png-image",
  "shape-primitives",
]);

const sceneIrV1BaseSchema = z
  .object({
    animationChannels: z.array(animationChannelV1Schema).max(MAX_CHANNELS),
    assetManifest: assetManifestReferenceV1Schema,
    camera: sceneCameraV1Schema,
    coordinateSpace: z
      .object({
        cpuPrecision: z.literal("f64"),
        kind: z.literal("cartesian-2d"),
        origin: z.literal("center"),
        unit: z.literal("scene-unit"),
        xAxis: z.literal("right"),
        yAxis: z.literal("up"),
      })
      .strict(),
    duration: finiteNumberV1Schema.positive(),
    entities: z.array(sceneEntityV1Schema).max(MAX_ENTITIES),
    fidelity: fidelityV1Schema,
    provenance: z
      .array(provenanceRecordV1Schema)
      .min(1)
      .max(MAX_ENTITIES + MAX_CHANNELS),
    requiredCapabilities: z.array(sceneCapabilityV1Schema).max(sceneCapabilityV1Schema.options.length),
    sceneId: sourceIdentityV1Schema,
    schema: z.literal("poietra.scene-ir"),
    source: sceneSourceV1Schema,
    version: z.literal(POIETRA_ENGINE_CONTRACT_VERSION),
  })
  .strict();

type SceneIrV1Input = z.infer<typeof sceneIrV1BaseSchema>;
export type SceneEntityV1 = SceneIrV1Input["entities"][number];
export type AnimationChannelV1 = SceneIrV1Input["animationChannels"][number];

function validateHierarchy(scene: SceneIrV1Input, context: z.RefinementCtx) {
  const parentById = new Map(scene.entities.map((entity) => [entity.id, entity.parentId]));
  scene.entities.forEach((entity, index) => {
    if (entity.parentId !== null && !parentById.has(entity.parentId)) {
      context.addIssue({
        code: "custom",
        message: `Unknown parent entity ${entity.parentId}.`,
        path: ["entities", index, "parentId"],
      });
    }
  });

  const state = new Map<string, "active" | "done">();
  for (const entity of scene.entities) {
    if (state.get(entity.id) === "done") continue;
    const chain: string[] = [];
    let currentId: string | null = entity.id;
    while (currentId !== null && state.get(currentId) !== "done") {
      if (state.get(currentId) === "active") {
        context.addIssue({ code: "custom", message: "Entity hierarchy must not contain a cycle.", path: ["entities"] });
        break;
      }
      state.set(currentId, "active");
      chain.push(currentId);
      currentId = parentById.get(currentId) ?? null;
    }
    chain.forEach((id) => state.set(id, "done"));
  }
}

function lifetimeIsCovered(
  lifetime: Readonly<{ end: number; start: number }>,
  parentLifetimes: readonly Readonly<{ end: number; start: number }>[],
) {
  let coveredUntil = lifetime.start;
  for (const parentLifetime of parentLifetimes) {
    if (parentLifetime.end <= coveredUntil) continue;
    if (parentLifetime.start > coveredUntil) return false;
    coveredUntil = parentLifetime.end;
    if (coveredUntil >= lifetime.end) return true;
  }
  return false;
}

function validateEntities(scene: SceneIrV1Input, context: z.RefinementCtx) {
  const provenanceIds = new Set(scene.provenance.map((record) => record.id));
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const sceneOrders = new Set<number>();
  scene.entities.forEach((entity, index) => {
    if (sceneOrders.has(entity.sceneOrder)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate sceneOrder ${entity.sceneOrder}.`,
        path: ["entities", index, "sceneOrder"],
      });
    }
    if (!provenanceIds.has(entity.provenanceId)) {
      context.addIssue({
        code: "custom",
        message: `Unknown provenance record ${entity.provenanceId}.`,
        path: ["entities", index, "provenanceId"],
      });
    }
    const image = entity.geometry.kind === "image";
    if ((image && entity.appearance.kind !== "image") || (!image && entity.appearance.kind !== "vector")) {
      context.addIssue({
        code: "custom",
        message: "Entity appearance must match its geometry kind.",
        path: ["entities", index, "appearance"],
      });
    }
    if (entity.appearance.kind === "vector" && entity.appearance.fill === null && entity.appearance.stroke === null) {
      context.addIssue({
        code: "custom",
        message: "Vector entities require a fill or stroke.",
        path: ["entities", index, "appearance"],
      });
    }
    if (entity.geometry.kind === "line" && entity.appearance.kind === "vector" && entity.appearance.stroke === null) {
      context.addIssue({
        code: "custom",
        message: "Line entities require a stroke.",
        path: ["entities", index, "appearance", "stroke"],
      });
    }
    if (
      entity.geometry.kind === "rectangle" &&
      entity.geometry.cornerRadius > Math.min(entity.geometry.width, entity.geometry.height) / 2
    ) {
      context.addIssue({
        code: "custom",
        message: "cornerRadius must fit inside the rectangle.",
        path: ["entities", index, "geometry", "cornerRadius"],
      });
    }
    entity.lifetimes.forEach((lifetime, lifetimeIndex) => {
      if (lifetime.end > scene.duration) {
        context.addIssue({
          code: "custom",
          message: "Entity lifetime exceeds Scene duration.",
          path: ["entities", index, "lifetimes", lifetimeIndex, "end"],
        });
      }
      if (lifetimeIndex > 0 && entity.lifetimes[lifetimeIndex - 1].end > lifetime.start) {
        context.addIssue({
          code: "custom",
          message: "Entity lifetimes must be ordered and non-overlapping.",
          path: ["entities", index, "lifetimes", lifetimeIndex],
        });
      }
      const parent = entity.parentId === null ? undefined : entities.get(entity.parentId);
      if (parent && !lifetimeIsCovered(lifetime, parent.lifetimes)) {
        context.addIssue({
          code: "custom",
          message: "A child lifetime must be contained by a parent lifetime.",
          path: ["entities", index, "lifetimes", lifetimeIndex],
        });
      }
    });
    sceneOrders.add(entity.sceneOrder);
  });
}

function pathTopology(path: z.infer<typeof cubicPathV1Schema>) {
  return path.subpaths.map((subpath) => `${subpath.closed ? 1 : 0}:${subpath.segments.length}`).join("|");
}

function validateKeyframes(channel: AnimationChannelV1, duration: number, index: number, context: z.RefinementCtx) {
  channel.keyframes.forEach((keyframe, keyframeIndex) => {
    if (keyframe.at > duration) {
      context.addIssue({
        code: "custom",
        message: "Keyframe exceeds Scene duration.",
        path: ["animationChannels", index, "keyframes", keyframeIndex, "at"],
      });
    }
    if (keyframeIndex > 0 && channel.keyframes[keyframeIndex - 1].at >= keyframe.at) {
      context.addIssue({
        code: "custom",
        message: "Keyframe times must be strictly increasing.",
        path: ["animationChannels", index, "keyframes", keyframeIndex, "at"],
      });
    }
    if (keyframeIndex === channel.keyframes.length - 1 && keyframe.easingToNext !== null) {
      context.addIssue({
        code: "custom",
        message: "The final keyframe cannot define easingToNext.",
        path: ["animationChannels", index, "keyframes", keyframeIndex, "easingToNext"],
      });
    }
    if (keyframeIndex < channel.keyframes.length - 1 && keyframe.easingToNext === null) {
      context.addIssue({
        code: "custom",
        message: "Every non-final keyframe must define easingToNext.",
        path: ["animationChannels", index, "keyframes", keyframeIndex, "easingToNext"],
      });
    }
  });
}

function validateChannels(scene: SceneIrV1Input, context: z.RefinementCtx) {
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const provenanceIds = new Set(scene.provenance.map((record) => record.id));
  let keyframeCount = 0;
  let cameraChannels = 0;
  const channelTargets = new Set<string>();
  scene.animationChannels.forEach((channel, index) => {
    keyframeCount += channel.keyframes.length;
    if (!provenanceIds.has(channel.provenanceId)) {
      context.addIssue({
        code: "custom",
        message: `Unknown provenance record ${channel.provenanceId}.`,
        path: ["animationChannels", index, "provenanceId"],
      });
    }
    validateKeyframes(channel, scene.duration, index, context);
    const channelTarget = channel.kind === "camera" ? "camera" : `${channel.entityId}/${channel.kind}`;
    if (channelTargets.has(channelTarget)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate animation channel target ${channelTarget}.`,
        path: ["animationChannels", index],
      });
    }
    channelTargets.add(channelTarget);
    if (channel.kind === "camera") {
      cameraChannels += 1;
      return;
    }
    const entity = entities.get(channel.entityId);
    if (!entity) {
      context.addIssue({
        code: "custom",
        message: `Unknown animated entity ${channel.entityId}.`,
        path: ["animationChannels", index, "entityId"],
      });
      return;
    }
    if (channel.kind === "path-trim" && entity.geometry.kind === "image") {
      context.addIssue({
        code: "custom",
        message: `${channel.kind} requires vector geometry.`,
        path: ["animationChannels", index, "entityId"],
      });
    }
    if (channel.kind === "path-trim" && entity.appearance.kind === "vector" && entity.appearance.fill !== null) {
      context.addIssue({
        code: "custom",
        message: "path-trim v1 requires stroke-only vector appearance.",
        path: ["animationChannels", index, "entityId"],
      });
    }
    if (channel.kind === "path-morph") {
      if (entity.geometry.kind !== "cubic-path") {
        context.addIssue({
          code: "custom",
          message: "path-morph requires canonical cubic-path entity geometry.",
          path: ["animationChannels", index, "entityId"],
        });
        return;
      }
      const topology = pathTopology(entity.geometry.path);
      channel.keyframes.forEach((keyframe, keyframeIndex) => {
        if (pathTopology(keyframe.value) !== topology) {
          context.addIssue({
            code: "custom",
            message: "Path morph keyframes must have matching cubic topology.",
            path: ["animationChannels", index, "keyframes", keyframeIndex, "value"],
          });
        }
      });
    }
    if (channel.kind === "motion-path") {
      if (channel.path.subpaths.length !== 1) {
        context.addIssue({
          code: "custom",
          message: "motion-path v1 requires exactly one cubic subpath.",
          path: ["animationChannels", index, "path", "subpaths"],
        });
      }
      if (channel.parameterization === "manim-point-from-proportion-v1" && channel.orientToPath) {
        context.addIssue({
          code: "custom",
          message: "manim-point-from-proportion-v1 does not orient the moved entity.",
          path: ["animationChannels", index, "orientToPath"],
        });
      }
    }
  });
  if (keyframeCount > MAX_KEYFRAMES) {
    context.addIssue({ code: "custom", message: `Scene IR accepts at most ${MAX_KEYFRAMES} total keyframes.` });
  }
  if (cameraChannels > 1) {
    context.addIssue({ code: "custom", message: "Scene IR accepts at most one camera animation channel." });
  }
}

function requiredCapabilities(scene: SceneIrV1Input) {
  const capabilities = new Set<z.infer<typeof sceneCapabilityV1Schema>>();
  for (const entity of scene.entities) {
    if (entity.geometry.kind === "image") capabilities.add("png-image");
    else if (entity.geometry.kind === "cubic-path") capabilities.add("cubic-path-geometry");
    else capabilities.add("shape-primitives");
  }
  for (const channel of scene.animationChannels) {
    const capability =
      channel.kind === "affine-transform"
        ? "affine-transform-animation"
        : channel.kind === "camera"
          ? "camera-animation"
          : channel.kind === "motion-path"
            ? "motion-path-animation"
            : channel.kind === "opacity"
              ? "opacity-animation"
              : channel.kind === "path-morph"
                ? "path-morph-animation"
                : "path-trim-animation";
    capabilities.add(capability);
  }
  return [...capabilities].sort();
}

function validateCapabilities(scene: SceneIrV1Input, context: z.RefinementCtx) {
  const expected = requiredCapabilities(scene);
  if (
    expected.length !== scene.requiredCapabilities.length ||
    expected.some((capability, index) => capability !== scene.requiredCapabilities[index])
  ) {
    context.addIssue({
      code: "custom",
      message: `requiredCapabilities must exactly equal: ${expected.join(", ") || "(none)"}.`,
      path: ["requiredCapabilities"],
    });
  }
}

function totalPathSegments(scene: SceneIrV1Input) {
  let total = 0;
  for (const entity of scene.entities) {
    total += countLoweredSceneGeometrySegmentsV1(entity.geometry);
  }
  for (const channel of scene.animationChannels) {
    if (channel.kind === "motion-path") total += countCubicPathSegments(channel.path);
    if (channel.kind === "path-morph") {
      total += channel.keyframes.reduce((count, keyframe) => count + countCubicPathSegments(keyframe.value), 0);
    }
  }
  return total;
}

export const sceneIrV1Schema = sceneIrV1BaseSchema.superRefine((scene, context) => {
  reportDuplicateIds(scene.entities, "entities", context);
  reportDuplicateIds(scene.animationChannels, "animationChannels", context);
  reportDuplicateIds(scene.provenance, "provenance", context);
  validateHierarchy(scene, context);
  validateEntities(scene, context);
  validateChannels(scene, context);
  validateCapabilities(scene, context);
  if (totalPathSegments(scene) > MAX_TOTAL_PATH_SEGMENTS) {
    context.addIssue({
      code: "custom",
      message: `Scene IR accepts at most ${MAX_TOTAL_PATH_SEGMENTS} total cubic segments.`,
    });
  }
});

export type SceneIrV1 = z.infer<typeof sceneIrV1Schema>;
export type SceneEntityGeometryV1 = SceneEntityV1["geometry"];

export function sceneIrSourceRevisionHash(scene: SceneIrV1) {
  return scene.source.kind === "studio-edit-program" ? scene.source.revisionHash : scene.source.snapshotHash;
}
