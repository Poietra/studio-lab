import { createHash } from "node:crypto";

import { z } from "zod";

import {
  countCubicPathSegments,
  cubicPathV1Schema,
  enginePointV1Schema,
  fillStyleV1Schema,
  MAX_COORDINATE,
  normalizedNumberV1Schema,
  opaqueIdV1Schema,
  rgbaColorV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
  strokeStyleV1Schema,
} from "../src/engine/contracts";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  RUNTIME_TRACE_DURATION_SECONDS_V1,
  RUNTIME_TRACE_FRAME_COUNT_V1,
  RUNTIME_TRACE_FRAME_RATE_V1,
  runtimeTraceFrameIndexAtTimeV1,
} from "../src/engine/runtime-trace-time";
import { sourceBindingV1Schema } from "../src/engine/source-runtime-identity";
import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../src/render-pipeline/manim-identity-contract";
import { sourceRuntimeSceneIdentifierV1 } from "../src/render-pipeline/source-runtime-identity-digest";
import { digestCanonicalJsonV1 } from "./canonical-json-digest";
import { canonicalF64HexV1 } from "./fast-manim-snapshot-contract";

export const FAST_MANIM_RUNTIME_TRACE_SCHEMA_V1 = "poietra.fast-manim-runtime-trace" as const;
export const FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V1 =
  "poietra.fast-manim-runtime-trace-producer-request" as const;
export const FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V1 = "poietra.fast-manim-runtime-trace-config" as const;
export const FAST_MANIM_RUNTIME_TRACE_VERSION_V1 = 1 as const;
export const FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V1 = 1 as const;
export const FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1 = RUNTIME_TRACE_FRAME_RATE_V1;
export const FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1 = RUNTIME_TRACE_DURATION_SECONDS_V1;
export const FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1 = 13 as const;
export const FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1 = "post-updater-pre-cairo-paint" as const;
export const FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1 = RUNTIME_TRACE_FRAME_COUNT_V1;
export const FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V1 = 10 as const;
export const MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 = 5 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V1 = 2 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1 =
  MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V1 * 6 + 64 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V1 = 64;
export const MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V1 = 16;
export const MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1 = 4_096;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V1 = 64;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V1 = 100_000;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V1 = 150_000;
export const MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V1 = 4_096;
export const MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V1 = 64;
// #465 lowers the measured 571-entity/1,887-run/7,244-segment result under
// these fail-closed ceilings. They budget normalized Scene IR, not producer JSON.
export const MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_ENTITIES_V1 = 640;
export const MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_LIFETIME_RUNS_V1 = 2_048;
export const MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_PATH_SEGMENTS_V1 = 8_192;
export const MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1 = 2 * 1024 * 1024;

const gitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}$/u, "Git object IDs must be lower-case SHA-1 hex.");
const runtimeTracePathIdV1Schema = z.string().regex(/^path:[0-9a-f]{64}$/u);
const runtimeTraceAppearanceIdV1Schema = z.string().regex(/^appearance:[0-9a-f]{64}$/u);

const correlationShape = {
  projectId: manimProjectIdSchema,
  requestId: opaqueIdV1Schema,
  runtimeConfigHash: sha256V1Schema,
  sceneId: sourceIdentityV1Schema,
  sceneName: manimSceneNameSchema,
  sourceHash: sha256V1Schema,
  sourcePath: manimSourcePathSchema,
};

const canonicalRuntimeTraceCameraV1 = {
  background: { alpha: 1, blue: 0, green: 0, red: 0 },
  center: { x: 0, y: 0 },
  frameHeight: 8,
  frameWidth: 128 / 9,
} as const;

function isCanonicalRuntimeTraceCameraV1(
  camera: Readonly<{
    background: Readonly<{ alpha: number; blue: number; green: number; red: number }>;
    center: Readonly<{ x: number; y: number }>;
    frameHeight: number;
    frameWidth: number;
  }>,
) {
  const sameNumber = (actual: number, expected: number) => canonicalF64HexV1(actual) === canonicalF64HexV1(expected);
  return (
    sameNumber(camera.background.alpha, canonicalRuntimeTraceCameraV1.background.alpha) &&
    sameNumber(camera.background.blue, canonicalRuntimeTraceCameraV1.background.blue) &&
    sameNumber(camera.background.green, canonicalRuntimeTraceCameraV1.background.green) &&
    sameNumber(camera.background.red, canonicalRuntimeTraceCameraV1.background.red) &&
    sameNumber(camera.center.x, canonicalRuntimeTraceCameraV1.center.x) &&
    sameNumber(camera.center.y, canonicalRuntimeTraceCameraV1.center.y) &&
    sameNumber(camera.frameHeight, canonicalRuntimeTraceCameraV1.frameHeight) &&
    sameNumber(camera.frameWidth, canonicalRuntimeTraceCameraV1.frameWidth)
  );
}

const runtimeTraceCameraV1Schema = z
  .object({
    background: rgbaColorV1Schema,
    center: enginePointV1Schema,
    frameHeight: z.number().finite().positive().max(MAX_COORDINATE),
    frameWidth: z.number().finite().positive().max(MAX_COORDINATE),
  })
  .strict()
  .refine(isCanonicalRuntimeTraceCameraV1, "Runtime Trace V1 requires the exact default Cairo camera.");

/**
 * Quantizes an IEEE-754 f64 using ECMAScript `toFixed(13)`: nearest decimal,
 * with an exact half tie rounded away from zero. Producers must implement this
 * rule rather than their language's default decimal rounding mode.
 */
export function canonicalFastManimRuntimeTraceCoordinateV1(value: number) {
  return Number(value.toFixed(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1));
}

function runtimeTraceDigestValueV1(value: unknown): unknown {
  if (typeof value === "number") return canonicalF64HexV1(value);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(runtimeTraceDigestValueV1);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, runtimeTraceDigestValueV1(entry)]),
    );
  }
  throw new TypeError("Runtime Trace digest input must be plain finite JSON.");
}

function digestRuntimeTraceDomainV1(domain: string, value: unknown) {
  return createHash("sha256")
    .update(canonicalJsonV1({ domain, value: runtimeTraceDigestValueV1(value) }))
    .digest("hex");
}

export function digestFastManimRuntimeTracePathV1(path: z.infer<typeof cubicPathV1Schema>) {
  return digestRuntimeTraceDomainV1("poietra.runtime-trace-path-v1", path);
}

export function digestFastManimRuntimeTraceAppearanceV1(
  appearance: Readonly<{
    fill: z.infer<typeof fillStyleV1Schema> | null;
    stroke: z.infer<typeof strokeStyleV1Schema> | null;
  }>,
) {
  return digestRuntimeTraceDomainV1("poietra.runtime-trace-appearance-v1", appearance);
}

const runtimeTraceCoordinateV1Schema = z
  .number()
  .finite()
  .min(-MAX_COORDINATE)
  .max(MAX_COORDINATE)
  .refine(
    (value) => value === canonicalFastManimRuntimeTraceCoordinateV1(value),
    `Runtime Trace coordinates must be canonicalized to ${FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1} decimal digits.`,
  );

const runtimeTracePointV1Schema = z
  .object({ x: runtimeTraceCoordinateV1Schema, y: runtimeTraceCoordinateV1Schema })
  .strict();

const runtimeTraceRootV1Schema = z
  .object({
    anchor: z.enum(["center", "left-center"]),
    binding: sourceBindingV1Schema,
    id: sourceIdentityV1Schema,
    offset: runtimeTracePointV1Schema,
    role: z.enum(["square", "decimal"]),
  })
  .strict();

const runtimeTracePathResourceV1Schema = z
  .object({
    id: runtimeTracePathIdV1Schema,
    path: cubicPathV1Schema,
  })
  .strict()
  .refine(({ id, path }) => id === `path:${digestFastManimRuntimeTracePathV1(path)}`, {
    message: "Runtime Trace path IDs must seal their canonical content.",
    path: ["id"],
  });

const runtimeTraceAppearanceResourceV1Schema = z
  .object({
    fill: fillStyleV1Schema.nullable(),
    id: runtimeTraceAppearanceIdV1Schema,
    stroke: strokeStyleV1Schema.nullable(),
  })
  .strict()
  .refine(({ fill, stroke }) => fill !== null || stroke !== null, {
    message: "A Runtime Trace appearance requires a fill or stroke.",
  })
  .refine(({ fill, id, stroke }) => id === `appearance:${digestFastManimRuntimeTraceAppearanceV1({ fill, stroke })}`, {
    message: "Runtime Trace appearance IDs must seal their canonical content.",
    path: ["id"],
  });

const runtimeTraceDrawV1Schema = z
  .object({
    appearanceId: runtimeTraceAppearanceIdV1Schema,
    familyPath: z.array(z.number().int().nonnegative().max(6)).max(3),
    localPosition: runtimeTracePointV1Schema,
    opacity: normalizedNumberV1Schema,
    paintOrder: z
      .number()
      .int()
      .nonnegative()
      .max(FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V1 - 1),
    pathId: runtimeTracePathIdV1Schema,
    rootId: sourceIdentityV1Schema,
    sourceZIndex: z.literal(0),
  })
  .strict();

const runtimeTraceFrameV1Schema = z
  .object({
    draws: z.array(runtimeTraceDrawV1Schema).length(FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V1),
    frameIndex: z
      .number()
      .int()
      .nonnegative()
      .max(FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1 - 1),
    motionY: runtimeTraceCoordinateV1Schema,
  })
  .strict();

/**
 * Toolchain hashes identify the producer for diagnostics and cache
 * partitioning. `semanticsSha256` seals the visual document and becomes
 * authority only when its value is supplied by independent trusted evidence.
 */
const runtimeTraceProducerV1Schema = z
  .object({
    fastManimCommit: gitObjectIdSchema,
    fastManimTree: gitObjectIdSchema,
    glyphProviderSha256: sha256V1Schema,
    manimVersion: z.string().min(1).max(64),
    semanticsSha256: sha256V1Schema,
  })
  .strict();

export const fastManimRuntimeTraceConfigV1Schema = z
  .object({
    camera: runtimeTraceCameraV1Schema,
    compositing: z.literal("manim-cairo-srgb"),
    coordinatePrecisionDigits: z.literal(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1),
    durationSeconds: z.literal(FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1),
    frameRate: z.literal(FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1),
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V1),
    randomSeed: z.literal(0),
    samplePhase: z.literal(FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1),
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V1),
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V1),
  })
  .strict();

export type FastManimRuntimeTraceConfigV1 = z.infer<typeof fastManimRuntimeTraceConfigV1Schema>;

export function digestFastManimRuntimeTraceConfigV1(value: FastManimRuntimeTraceConfigV1) {
  const config = fastManimRuntimeTraceConfigV1Schema.parse(value);
  const number = canonicalF64HexV1;
  return createHash("sha256")
    .update(
      canonicalJsonV1({
        camera: {
          background: {
            alpha: number(config.camera.background.alpha),
            blue: number(config.camera.background.blue),
            green: number(config.camera.background.green),
            red: number(config.camera.background.red),
          },
          center: { x: number(config.camera.center.x), y: number(config.camera.center.y) },
          frameHeight: number(config.camera.frameHeight),
          frameWidth: number(config.camera.frameWidth),
        },
        compositing: config.compositing,
        coordinatePrecisionDigits: config.coordinatePrecisionDigits,
        durationSeconds: config.durationSeconds,
        frameRate: config.frameRate,
        profileVersion: config.profileVersion,
        randomSeed: config.randomSeed,
        samplePhase: config.samplePhase,
        schema: config.schema,
        version: config.version,
      }),
    )
    .digest("hex");
}

export function fastManimRuntimeTraceSceneIdV1(sourcePath: string, sceneName: string) {
  return sourceRuntimeSceneIdentifierV1(sourcePath, sceneName);
}

export const fastManimRuntimeTraceProducerRequestV1Schema = z
  .object({
    ...correlationShape,
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V1),
    runtimeConfig: fastManimRuntimeTraceConfigV1Schema,
    sceneOccurrence: z
      .object({
        constructStartLine: z.number().int().positive().max(10_000),
        definitionOrdinal: z.number().int().positive().max(10_000),
      })
      .strict(),
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V1),
    sourceText: z.string(),
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V1),
  })
  .strict()
  .superRefine((request, context) => {
    if (Buffer.byteLength(request.sourceText, "utf8") > MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V1) {
      context.addIssue({
        code: "custom",
        message: `Runtime Trace source accepts at most ${MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V1} UTF-8 bytes.`,
        path: ["sourceText"],
      });
    }
    const sourceHash = createHash("sha256").update(request.sourceText, "utf8").digest("hex");
    if (request.sourceHash !== sourceHash) {
      context.addIssue({ code: "custom", message: "Runtime Trace sourceHash is stale.", path: ["sourceHash"] });
    }
    if (request.sceneId !== fastManimRuntimeTraceSceneIdV1(request.sourcePath, request.sceneName)) {
      context.addIssue({ code: "custom", message: "Runtime Trace sceneId is stale.", path: ["sceneId"] });
    }
    if (request.runtimeConfigHash !== digestFastManimRuntimeTraceConfigV1(request.runtimeConfig)) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace runtimeConfigHash is stale.",
        path: ["runtimeConfigHash"],
      });
    }
  });

export type FastManimRuntimeTraceProducerRequestV1 = z.infer<typeof fastManimRuntimeTraceProducerRequestV1Schema>;

const fastManimRuntimeTraceV1BaseSchema = z
  .object({
    ...correlationShape,
    authority: z.literal("preview-only"),
    camera: runtimeTraceCameraV1Schema,
    compositing: z.literal("manim-cairo-srgb"),
    coordinatePrecisionDigits: z.literal(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1),
    durationSeconds: z.literal(FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1),
    frameCount: z.literal(FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1),
    frameRate: z.literal(FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1),
    frames: z.array(runtimeTraceFrameV1Schema).length(FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1),
    producer: runtimeTraceProducerV1Schema,
    resources: z
      .object({
        appearances: z
          .array(runtimeTraceAppearanceResourceV1Schema)
          .min(1)
          .max(MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V1),
        paths: z.array(runtimeTracePathResourceV1Schema).min(1).max(MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V1),
      })
      .strict(),
    roots: z.array(runtimeTraceRootV1Schema).length(2),
    sceneOccurrence: z
      .object({
        constructStartLine: z.number().int().positive(),
        definitionOrdinal: z.number().int().positive().max(10_000),
      })
      .strict(),
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_SCHEMA_V1),
    samplePhase: z.literal(FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1),
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V1),
  })
  .strict();

type FastManimRuntimeTraceV1Base = z.infer<typeof fastManimRuntimeTraceV1BaseSchema>;

/**
 * Seals every visual value that lowering may publish while excluding request
 * correlation and producer metadata. The independently trusted expected
 * producer correlation pins this digest; a producer cannot substitute content
 * and merely recompute resource IDs.
 */
export function digestFastManimRuntimeTraceVisualSemanticsV1(trace: FastManimRuntimeTraceV1Base) {
  return digestRuntimeTraceDomainV1("poietra.runtime-trace-visual-semantics-v1", {
    camera: trace.camera,
    compositing: trace.compositing,
    coordinatePrecisionDigits: trace.coordinatePrecisionDigits,
    durationSeconds: trace.durationSeconds,
    frameCount: trace.frameCount,
    frameRate: trace.frameRate,
    frames: trace.frames,
    resources: trace.resources,
    roots: trace.roots,
    samplePhase: trace.samplePhase,
  });
}

function reportDuplicateId(
  values: readonly Readonly<{ id: string }>[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
) {
  const seen = new Set<string>();
  values.forEach(({ id }, index) => {
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate Runtime Trace resource or root ID ${id}.`,
        path: [...path, index, "id"],
      });
    }
    seen.add(id);
  });
}

function runtimeTracePathPoints(path: z.infer<typeof cubicPathV1Schema>) {
  return path.subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end]),
  ]);
}

type RuntimeTracePointV1 = z.infer<typeof runtimeTracePointV1Schema>;

/**
 * Runtime Trace V1 is viewport-neutral. It captures root-local Scene coordinates,
 * never pixel coordinates. The Studio verifier lowers this position into Scene IR;
 * the independent 864x486 Cairo/WebGPU evidence belongs to the integration layer.
 * That exact 16:9 raster preserves the declared 8 by 128/9 camera without
 * Manim applying a frame-shape aspect correction.
 */
export function fastManimRuntimeTraceWorldPositionV1(
  motionY: number,
  rootOffset: Readonly<RuntimeTracePointV1>,
  localPosition: Readonly<RuntimeTracePointV1>,
) {
  return {
    x: canonicalFastManimRuntimeTraceCoordinateV1(rootOffset.x + localPosition.x),
    y: canonicalFastManimRuntimeTraceCoordinateV1(motionY + rootOffset.y + localPosition.y),
  };
}

const EXPECTED_RUNTIME_TRACE_FAMILY_PATHS_V1 = [
  [] as const,
  [0, 0, 0] as const,
  [1, 0, 0] as const,
  [2, 0, 0] as const,
  [3, 0, 0] as const,
  [4, 0, 0] as const,
  [5, 0, 0] as const,
  [6, 0] as const,
  [6, 1] as const,
  [6, 2] as const,
] as const;

export const fastManimRuntimeTraceV1Schema = fastManimRuntimeTraceV1BaseSchema.superRefine((trace, context) => {
  reportDuplicateId(trace.resources.appearances, context, ["resources", "appearances"]);
  reportDuplicateId(trace.resources.paths, context, ["resources", "paths"]);
  reportDuplicateId(trace.roots, context, ["roots"]);
  if (trace.producer.semanticsSha256 !== digestFastManimRuntimeTraceVisualSemanticsV1(trace)) {
    context.addIssue({
      code: "custom",
      message: "Runtime Trace visual semantics do not match the trusted producer seal.",
      path: ["producer", "semanticsSha256"],
    });
  }

  const appearanceIds = new Set(trace.resources.appearances.map(({ id }) => id));
  const pathIds = new Set(trace.resources.paths.map(({ id }) => id));
  const pathBounds = new Map<string, Readonly<{ maxX: number; maxY: number; minX: number; minY: number }>>();
  const roots = new Map(trace.roots.map((root) => [root.id, root]));
  let pathSegments = 0;
  trace.resources.paths.forEach(({ id, path }, index) => {
    pathSegments += countCubicPathSegments(path);
    if (pathSegments > MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1) {
      context.addIssue({
        code: "custom",
        message: `Runtime Trace V1 accepts at most ${MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1} interned cubic segments.`,
        path: ["resources", "paths", index, "path"],
      });
    }
    const points = runtimeTracePathPoints(path);
    points.forEach((point, pointIndex) => {
      if (
        point.x !== canonicalFastManimRuntimeTraceCoordinateV1(point.x) ||
        point.y !== canonicalFastManimRuntimeTraceCoordinateV1(point.y)
      ) {
        context.addIssue({
          code: "custom",
          message: `Runtime Trace path coordinates must be canonicalized to ${FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1} decimal digits.`,
          path: ["resources", "paths", index, "path", "points", pointIndex],
        });
      }
    });
    pathBounds.set(id, {
      maxX: Math.max(...points.map(({ x }) => x)),
      maxY: Math.max(...points.map(({ y }) => y)),
      minX: Math.min(...points.map(({ x }) => x)),
      minY: Math.min(...points.map(({ y }) => y)),
    });
  });

  const expectedRoots = [
    { anchor: "center", offset: { x: 0, y: 0 }, role: "square" },
    { anchor: "left-center", offset: { x: 1.25, y: 0 }, role: "decimal" },
  ] as const;
  trace.roots.forEach((root, index) => {
    const expected = expectedRoots[index];
    if (
      !expected ||
      root.role !== expected.role ||
      root.binding.name !== root.role ||
      root.anchor !== expected.anchor ||
      root.offset.x !== expected.offset.x ||
      root.offset.y !== expected.offset.y
    ) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace V1 roots must be the source-bound Square center then DecimalNumber left-center roots.",
        path: ["roots", index],
      });
    }
  });

  trace.frames.forEach((frame, frameIndex) => {
    if (frame.frameIndex !== frameIndex) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace frameIndex must equal its canonical presentation index.",
        path: ["frames", frameIndex, "frameIndex"],
      });
    }
    frame.draws.forEach((draw, drawIndex) => {
      const root = roots.get(draw.rootId);
      const expectedFamilyPath = EXPECTED_RUNTIME_TRACE_FAMILY_PATHS_V1[drawIndex];
      const expectedRootId = trace.roots[drawIndex === 0 ? 0 : 1]?.id;
      if (draw.paintOrder !== drawIndex) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace paintOrder must equal the back-to-front draw index.",
          path: ["frames", frameIndex, "draws", drawIndex, "paintOrder"],
        });
      }
      if (!root) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace draw references an unknown source root.",
          path: ["frames", frameIndex, "draws", drawIndex, "rootId"],
        });
      }
      if (draw.rootId !== expectedRootId || canonicalJsonV1(draw.familyPath) !== canonicalJsonV1(expectedFamilyPath)) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace draws must follow the exact Square and DecimalNumber visible-family order.",
          path: ["frames", frameIndex, "draws", drawIndex, "familyPath"],
        });
      }
      if (!appearanceIds.has(draw.appearanceId)) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace draw references an unknown appearance resource.",
          path: ["frames", frameIndex, "draws", drawIndex, "appearanceId"],
        });
      }
      if (!pathIds.has(draw.pathId)) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace draw references an unknown path resource.",
          path: ["frames", frameIndex, "draws", drawIndex, "pathId"],
        });
      }
      const bounds = pathBounds.get(draw.pathId);
      if (root && bounds) {
        const world = fastManimRuntimeTraceWorldPositionV1(frame.motionY, root.offset, draw.localPosition);
        if (
          ![bounds.minX + world.x, bounds.maxX + world.x, bounds.minY + world.y, bounds.maxY + world.y].every(
            (coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= MAX_COORDINATE,
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Runtime Trace root-local geometry does not translate to renderable Scene coordinates.",
            path: ["frames", frameIndex, "draws", drawIndex, "localPosition"],
          });
        }
      }
    });
  });

  const terminal = canonicalJsonV1({
    draws: trace.frames[300]?.draws,
    motionY: trace.frames[300]?.motionY,
  });
  for (let index = 301; index < trace.frames.length; index += 1) {
    if (
      canonicalJsonV1({
        draws: trace.frames[index]?.draws,
        motionY: trace.frames[index]?.motionY,
      }) !== terminal
    ) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace V1 requires an exact one-second terminal hold.",
        path: ["frames", index, "draws"],
      });
      break;
    }
  }
});

export type FastManimRuntimeTraceV1 = z.infer<typeof fastManimRuntimeTraceV1Schema>;

export const expectedFastManimRuntimeTraceCorrelationV1Schema = z
  .object({
    ...correlationShape,
    camera: runtimeTraceCameraV1Schema,
    producer: runtimeTraceProducerV1Schema,
    roots: fastManimRuntimeTraceV1BaseSchema.shape.roots,
    sceneOccurrence: fastManimRuntimeTraceV1BaseSchema.shape.sceneOccurrence,
  })
  .strict();

export type ExpectedFastManimRuntimeTraceCorrelationV1 = z.infer<
  typeof expectedFastManimRuntimeTraceCorrelationV1Schema
>;

export type TrustedFastManimRuntimeTraceProducerV1 = Readonly<
  Pick<ExpectedFastManimRuntimeTraceCorrelationV1, "producer" | "roots">
>;

/** Derives response correlation only from the original request plus trusted producer/root evidence. */
export function expectedFastManimRuntimeTraceCorrelationFromRequestV1(
  requestValue: FastManimRuntimeTraceProducerRequestV1,
  trusted: TrustedFastManimRuntimeTraceProducerV1,
) {
  const request = fastManimRuntimeTraceProducerRequestV1Schema.parse(requestValue);
  return expectedFastManimRuntimeTraceCorrelationV1Schema.parse({
    camera: request.runtimeConfig.camera,
    producer: trusted.producer,
    projectId: request.projectId,
    requestId: request.requestId,
    roots: trusted.roots,
    runtimeConfigHash: request.runtimeConfigHash,
    sceneId: request.sceneId,
    sceneName: request.sceneName,
    sceneOccurrence: request.sceneOccurrence,
    sourceHash: request.sourceHash,
    sourcePath: request.sourcePath,
  });
}

export type FastManimRuntimeTraceContractErrorCodeV1 =
  | "correlation-mismatch"
  | "request-invalid"
  | "request-malformed"
  | "request-too-complex"
  | "request-too-large"
  | "result-invalid"
  | "result-malformed"
  | "result-too-complex"
  | "result-too-large";

export class FastManimRuntimeTraceContractError extends Error {
  readonly code: FastManimRuntimeTraceContractErrorCodeV1;

  constructor(code: FastManimRuntimeTraceContractErrorCodeV1, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FastManimRuntimeTraceContractError";
    this.code = code;
  }
}

function parseRuntimeTraceJson(value: string | Uint8Array, maximumBytes: number, kind: "request" | "result") {
  const byteLength = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (byteLength > maximumBytes) {
    throw new FastManimRuntimeTraceContractError(
      `${kind}-too-large`,
      `Runtime Trace V1 ${kind}s accept at most ${maximumBytes} encoded bytes.`,
    );
  }
  let json: string;
  try {
    json = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw new FastManimRuntimeTraceContractError(`${kind}-malformed`, `Runtime Trace V1 ${kind} is not UTF-8 JSON.`, {
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (cause) {
    throw new FastManimRuntimeTraceContractError(`${kind}-malformed`, `Runtime Trace V1 ${kind} is malformed JSON.`, {
      cause,
    });
  }
  // The decoded text is dead once the graph exists; a 900-frame trace makes
  // that tens of MiB worth releasing before the schema builds its own copy.
  json = "";
  assertBoundedRuntimeTraceJson(parsed, kind);
  return parsed;
}

function assertBoundedRuntimeTraceJson(value: unknown, kind: "request" | "result") {
  const stack: Array<Readonly<{ depth: number; value: unknown }>> = [{ depth: 0, value }];
  let entries = 0;
  let values = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    values += 1;
    if (
      values > MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V1 ||
      current.depth > MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V1
    ) {
      throw new FastManimRuntimeTraceContractError(
        `${kind}-too-complex`,
        `Runtime Trace V1 ${kind} exceeds its structural budget.`,
      );
    }
    const entry = current.value;
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      continue;
    }
    const children: unknown[] = [];
    if (Array.isArray(entry)) {
      if (entry.length > MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V1) {
        throw new FastManimRuntimeTraceContractError(
          `${kind}-too-complex`,
          `Runtime Trace V1 ${kind} contains an oversized array.`,
        );
      }
      children.push(...entry);
    } else if (typeof entry === "object") {
      const objectValues = Object.values(entry);
      if (objectValues.length > MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V1) {
        throw new FastManimRuntimeTraceContractError(
          `${kind}-too-complex`,
          `Runtime Trace V1 ${kind} contains an oversized object.`,
        );
      }
      children.push(...objectValues);
    } else {
      throw new FastManimRuntimeTraceContractError(
        `${kind}-too-complex`,
        `Runtime Trace V1 ${kind} is not plain JSON.`,
      );
    }
    entries += children.length;
    if (entries > MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V1) {
      throw new FastManimRuntimeTraceContractError(
        `${kind}-too-complex`,
        `Runtime Trace V1 ${kind} exceeds its container-entry budget.`,
      );
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ depth: current.depth + 1, value: children[index] });
    }
  }
}

export function parseFastManimRuntimeTraceProducerRequestJsonV1(value: string | Uint8Array) {
  const parsed = fastManimRuntimeTraceProducerRequestV1Schema.safeParse(
    parseRuntimeTraceJson(value, MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1, "request"),
  );
  if (!parsed.success) {
    throw new FastManimRuntimeTraceContractError("request-invalid", "Runtime Trace V1 request is invalid.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function assertRuntimeTraceCorrelation(
  trace: FastManimRuntimeTraceV1,
  expected: ExpectedFastManimRuntimeTraceCorrelationV1,
) {
  const keys = Object.keys(correlationShape) as Array<keyof typeof correlationShape>;
  for (const key of keys) {
    if (trace[key] !== expected[key]) {
      throw new FastManimRuntimeTraceContractError(
        "correlation-mismatch",
        `Runtime Trace V1 has stale ${key} correlation.`,
      );
    }
  }
  for (const key of ["camera", "producer", "roots", "sceneOccurrence"] as const) {
    if (canonicalJsonV1(trace[key]) !== canonicalJsonV1(expected[key])) {
      throw new FastManimRuntimeTraceContractError(
        "correlation-mismatch",
        `Runtime Trace V1 has stale ${key} correlation.`,
      );
    }
  }
}

export function parseFastManimRuntimeTraceProducerJsonV1(
  value: string | Uint8Array,
  expected: ExpectedFastManimRuntimeTraceCorrelationV1,
) {
  const parsed = parseFastManimRuntimeTraceSelfSealedJsonV1(value);
  assertRuntimeTraceCorrelation(parsed, expectedFastManimRuntimeTraceCorrelationV1Schema.parse(expected));
  return parsed;
}

/**
 * Crosses only the bounded wire and content-addressing contract. The returned
 * document is not publication authority until a caller independently verifies
 * its request correlation, producer identity, roots, and visual semantics.
 */
export function parseFastManimRuntimeTraceSelfSealedJsonV1(value: string | Uint8Array) {
  const parsed = fastManimRuntimeTraceV1Schema.safeParse(
    parseRuntimeTraceJson(value, MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1, "result"),
  );
  if (!parsed.success) {
    throw new FastManimRuntimeTraceContractError("result-invalid", "Runtime Trace V1 violates its closed contract.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function digestFastManimRuntimeTraceV1(trace: FastManimRuntimeTraceV1) {
  return digestCanonicalJsonV1(trace);
}

/**
 * Maps a Studio time to the captured presentation frame; duration retains the
 * final frame. Values within four scaled-f64 epsilons of an integer frame are
 * canonical grid times. This admits both `n / 60` and `n * (1 / 60)` while
 * retaining floor selection for ordinary between-frame seeks.
 */
export function fastManimRuntimeTraceFrameIndexAtTimeV1(time: number) {
  return runtimeTraceFrameIndexAtTimeV1(time);
}
