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
  normalizedNumberV1Schema,
  POIETRA_ENGINE_CONTRACT_VERSION,
  rgbaColorV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
  strokeStyleV1Schema,
} from "./primitives";

const MAX_ENTITIES = 10_000;
const MAX_CHANNELS = 10_000;
const MAX_KEYFRAMES = 100_000;
const MAX_RUNTIME_TRACE_PATH_MORPH_KEYFRAMES = 900;

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

const groupGeometryV1Schema = z.object({ kind: z.literal("group") }).strict();

const sceneGeometryV1Schema = z.discriminatedUnion("kind", [
  circleGeometryV1Schema,
  cubicPathGeometryV1Schema,
  groupGeometryV1Schema,
  imageGeometryV1Schema,
  lineGeometryV1Schema,
  rectangleGeometryV1Schema,
]);

export function countLoweredSceneGeometrySegmentsV1(geometry: z.infer<typeof sceneGeometryV1Schema>) {
  if (geometry.kind === "group" || geometry.kind === "image") return 0;
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

const groupAppearanceV1Schema = z
  .object({
    kind: z.literal("group"),
    opacity: normalizedNumberV1Schema,
  })
  .strict();

export const sceneEntityV1Schema = z
  .object({
    appearance: z.discriminatedUnion("kind", [
      groupAppearanceV1Schema,
      imageAppearanceV1Schema,
      vectorAppearanceV1Schema,
    ]),
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
  z.object({ kind: z.literal("manim-smooth") }).strict(),
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
    keyframes: z.array(keyframeV1Schema(cubicPathV1Schema)).min(2).max(MAX_RUNTIME_TRACE_PATH_MORPH_KEYFRAMES),
    kind: z.literal("path-morph"),
  })
  .strict();

const vectorAppearanceStrokeStyleV1Schema = strokeStyleV1Schema.extend({
  widthWorld: finiteNumberV1Schema.nonnegative().max(MAX_COORDINATE),
});

export const vectorAppearanceValueV1Schema = z
  .object({
    fill: fillStyleV1Schema.nullable(),
    stroke: vectorAppearanceStrokeStyleV1Schema.nullable(),
  })
  .strict()
  .refine((appearance) => appearance.fill !== null || appearance.stroke !== null, {
    message: "A vector appearance keyframe requires a fill or stroke.",
  });

const vectorAppearanceChannelV1Schema = z
  .object({
    ...entityChannelBase,
    keyframes: z.array(keyframeV1Schema(vectorAppearanceValueV1Schema)).min(2).max(MAX_KEYFRAMES),
    kind: z.literal("vector-appearance"),
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
  vectorAppearanceChannelV1Schema,
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
      snapshotVersion: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
        z.literal(7),
        z.literal(8),
        z.literal(9),
        z.literal(10),
        z.literal(11),
        z.literal(12),
      ]),
      sourceHash: sha256V1Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("imported-manim-runtime-trace"),
      runtimeConfigHash: sha256V1Schema,
      sourceHash: sha256V1Schema,
      traceDigest: sha256V1Schema,
      traceVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    })
    .strict(),
]);

export const provenanceRecordV1Schema = z
  .object({
    evidence: z.array(evidenceV1Schema).max(64),
    id: sourceIdentityV1Schema,
    origin: z.enum(["fast-manim-runtime-trace", "fast-manim-server-snapshot", "fixture", "studio-edit-program"]),
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
  "logical-group",
  "motion-path-animation",
  "opacity-animation",
  "path-morph-animation",
  "path-trim-animation",
  "png-image",
  "shape-primitives",
  "vector-appearance-animation",
]);

const sceneStateSamplingV1Schema = z
  .object({
    frameRate: finiteNumberV1Schema.positive().nullable(),
    retainsTerminalState: z.boolean(),
  })
  .strict();

/** Type and fixture decoder only; semantic admission belongs to the Rust core. */
export const sceneIrV1Schema = z
  .object({
    animationChannels: z.array(animationChannelV1Schema).max(MAX_CHANNELS),
    assetManifest: assetManifestReferenceV1Schema,
    camera: sceneCameraV1Schema,
    compositing: z.enum(["linear-light", "manim-cairo-srgb"]),
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
    stateSampling: sceneStateSamplingV1Schema,
    version: z.literal(POIETRA_ENGINE_CONTRACT_VERSION),
  })
  .strict();

type SceneIrV1Input = z.infer<typeof sceneIrV1Schema>;
export type SceneEntityV1 = SceneIrV1Input["entities"][number];
export type AnimationChannelV1 = SceneIrV1Input["animationChannels"][number];

export type SceneIrV1 = z.infer<typeof sceneIrV1Schema>;
export type SceneEntityGeometryV1 = SceneEntityV1["geometry"];
export type SceneSourceV1 = z.infer<typeof sceneSourceV1Schema>;

export function sceneIrSourceRevisionHash(scene: SceneIrV1) {
  return scene.source.kind === "studio-edit-program"
    ? scene.source.revisionHash
    : scene.source.kind === "imported-manim-runtime-trace"
      ? scene.source.traceDigest
      : scene.source.snapshotHash;
}
