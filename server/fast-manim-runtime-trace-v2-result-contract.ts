import { createHash } from "node:crypto";

import { z } from "zod";

import {
  countCubicPathSegments,
  cubicPathV1Schema,
  fillStyleV1Schema,
  MAX_COORDINATE,
  normalizedNumberV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
  strokeStyleV1Schema,
} from "../src/engine/contracts";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { sourceBindingV1Schema } from "../src/engine/source-runtime-identity";
import {
  digestFastManimRuntimeTraceConfigV2,
  FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V2,
  FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2,
  FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V2,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2,
  FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
  FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V2,
  FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
  type FastManimRuntimeTraceProducerRequestV2,
  fastManimRuntimeTraceConfigV2Schema,
  fastManimRuntimeTraceProducerRequestV2Schema,
} from "./fast-manim-runtime-trace-v2-contract";
import { canonicalF64HexV1 } from "./fast-manim-snapshot-contract";

export const FAST_MANIM_RUNTIME_TRACE_SCHEMA_V2 = "poietra.fast-manim-runtime-trace" as const;
export const FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V2 = 66 as const;
export const MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V2 = 944;
export const FAST_MANIM_RUNTIME_TRACE_GEOMETRY_RESOURCE_HASH_V2 =
  "f1942bd6e7990e095a23f6ba4e3ad6d8b942648e0ce1d1e69441c114739109ac" as const;
export const FAST_MANIM_RUNTIME_TRACE_TEX_FONT_BUNDLE_HASH_V2 =
  "c08c8616a0b95c16cd0c1bfcae0f30361e8bb89868bfdb5135369d3b59b56b5e" as const;
export const FAST_MANIM_RUNTIME_TRACE_TEX_TOOLCHAIN_HASH_V2 =
  "160436934a3de173a1fd8a415d3da5bd63a95d8ff498371e708197a804f12e89" as const;
export const MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2 = 24 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V2 = 8 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V2 = 384;
export const MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V2 = 28_000;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V2 = 1_000_000;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V2 = 1_000_000;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V2 = 16;
export const MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V2 = 1_024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V2 = 32;

export const FAST_MANIM_RUNTIME_TRACE_TITLE_UNION_IDENTITY_ORDERS_V2 = [
  0, 15, 1, 2, 3, 4, 5, 6, 7, 16, 8, 9, 10, 11, 12, 13, 14,
] as const;
export const FAST_MANIM_RUNTIME_TRACE_TITLE_EXTENSION_SLOTS_V2 = [1, 9] as const;
export const FAST_MANIM_RUNTIME_TRACE_GRID_FAMILY_PATHS_V2 = Object.freeze([
  ...Array.from({ length: 22 }, (_, index) => [1, index] as const),
  [2] as const,
  [3] as const,
]);

const gitObjectIdV2Schema = z.string().regex(/^[0-9a-f]{40}$/u, "Git object IDs must be lower-case SHA-1 hex.");
const runtimeTracePathIdV2Schema = z.string().regex(/^path:[0-9a-f]{64}$/u);
const runtimeTraceAppearanceIdV2Schema = z.string().regex(/^appearance:[0-9a-f]{64}$/u);

export function canonicalFastManimRuntimeTraceCoordinateV2(value: number) {
  return Number(value.toFixed(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V2));
}

function runtimeTraceDigestValueV2(value: unknown): unknown {
  if (typeof value === "number") return canonicalF64HexV1(value);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(runtimeTraceDigestValueV2);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, runtimeTraceDigestValueV2(entry)]),
    );
  }
  throw new TypeError("Runtime Trace V2 digest input must be finite plain JSON.");
}

function digestRuntimeTraceDomainV2(domain: string, value: unknown) {
  return createHash("sha256")
    .update(canonicalJsonV1({ domain, value: runtimeTraceDigestValueV2(value) }))
    .digest("hex");
}

export function digestFastManimRuntimeTracePathV2(path: z.infer<typeof cubicPathV1Schema>) {
  return digestRuntimeTraceDomainV2("poietra.runtime-trace-path-v2", path);
}

export function digestFastManimRuntimeTraceAppearanceV2(
  appearance: Readonly<{
    fill: z.infer<typeof fillStyleV1Schema> | null;
    stroke: z.infer<typeof strokeStyleV1Schema> | null;
  }>,
) {
  return digestRuntimeTraceDomainV2("poietra.runtime-trace-appearance-v2", appearance);
}

const runtimeTraceCoordinateV2Schema = z
  .number()
  .finite()
  .min(-MAX_COORDINATE)
  .max(MAX_COORDINATE)
  .refine(
    (value) => value === canonicalFastManimRuntimeTraceCoordinateV2(value),
    `Runtime Trace V2 coordinates must be canonicalized to ${FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V2} decimal digits.`,
  );

const runtimeTracePointV2Schema = z
  .object({ x: runtimeTraceCoordinateV2Schema, y: runtimeTraceCoordinateV2Schema })
  .strict();

const runtimeTraceRootV2Schema = z
  .object({
    binding: sourceBindingV1Schema,
    id: sourceIdentityV1Schema,
    role: z.enum(["title", "basel", "grid", "grid-title"]),
  })
  .strict();

const runtimeTracePathResourceV2Schema = z
  .object({
    id: runtimeTracePathIdV2Schema,
    path: cubicPathV1Schema,
  })
  .strict()
  .refine(({ id, path }) => id === `path:${digestFastManimRuntimeTracePathV2(path)}`, {
    message: "Runtime Trace V2 path IDs must seal their canonical content.",
    path: ["id"],
  });

const runtimeTraceAppearanceResourceV2Schema = z
  .object({
    fill: fillStyleV1Schema.nullable(),
    id: runtimeTraceAppearanceIdV2Schema,
    stroke: strokeStyleV1Schema.nullable(),
  })
  .strict()
  .refine(({ fill, stroke }) => fill !== null || stroke !== null, {
    message: "A Runtime Trace V2 appearance requires a fill or stroke.",
  })
  .refine(({ fill, id, stroke }) => id === `appearance:${digestFastManimRuntimeTraceAppearanceV2({ fill, stroke })}`, {
    message: "Runtime Trace V2 appearance IDs must seal their canonical content.",
    path: ["id"],
  });

const runtimeTraceDrawV2Schema = z
  .object({
    appearanceId: runtimeTraceAppearanceIdV2Schema,
    drawId: sourceIdentityV1Schema,
    familyPath: z.array(z.number().int().nonnegative().max(21)).min(1).max(2),
    opacity: normalizedNumberV1Schema,
    paintOrder: z
      .number()
      .int()
      .nonnegative()
      .max(FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V2 - 1),
    pathId: runtimeTracePathIdV2Schema,
    pathTrim: z.object({ end: normalizedNumberV1Schema, start: z.literal(0) }).strict(),
    present: z.boolean(),
    rootId: sourceIdentityV1Schema,
    sourceZIndex: z.literal(0),
    translation: runtimeTracePointV2Schema,
  })
  .strict();

const runtimeTraceFrameV2Schema = z
  .object({
    draws: z.array(runtimeTraceDrawV2Schema).length(FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V2),
    frameIndex: z
      .number()
      .int()
      .nonnegative()
      .max(FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V2 - 1),
  })
  .strict();

const runtimeTraceProducerV2Schema = z
  .object({
    fastManimCommit: gitObjectIdV2Schema,
    fastManimTree: gitObjectIdV2Schema,
    geometryResourceSha256: z.literal(FAST_MANIM_RUNTIME_TRACE_GEOMETRY_RESOURCE_HASH_V2),
    manimVersion: z.string().min(1).max(64),
    semanticsSha256: sha256V1Schema,
    texFontBundleSha256: z.literal(FAST_MANIM_RUNTIME_TRACE_TEX_FONT_BUNDLE_HASH_V2),
    texToolchainSha256: z.literal(FAST_MANIM_RUNTIME_TRACE_TEX_TOOLCHAIN_HASH_V2),
  })
  .strict();

const fastManimRuntimeTraceV2BaseSchema = z
  .object({
    authority: z.literal("preview-only"),
    camera: fastManimRuntimeTraceConfigV2Schema.shape.camera,
    compositing: z.literal("manim-cairo-srgb"),
    coordinatePrecisionDigits: z.literal(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V2),
    durationSeconds: z.literal(FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2),
    frameCount: z.literal(FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V2),
    frameRate: z.literal(FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2),
    frames: z.array(runtimeTraceFrameV2Schema).length(FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V2),
    producer: runtimeTraceProducerV2Schema,
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2),
    projectId: fastManimRuntimeTraceProducerRequestV2Schema.shape.projectId,
    requestId: fastManimRuntimeTraceProducerRequestV2Schema.shape.requestId,
    resources: z
      .object({
        appearances: z
          .array(runtimeTraceAppearanceResourceV2Schema)
          .min(1)
          .max(MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V2),
        paths: z.array(runtimeTracePathResourceV2Schema).min(1).max(MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V2),
      })
      .strict(),
    roots: z.array(runtimeTraceRootV2Schema).length(4),
    runtimeConfigHash: sha256V1Schema,
    samplePhase: z.literal(FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V2),
    sceneId: sourceIdentityV1Schema,
    sceneName: fastManimRuntimeTraceProducerRequestV2Schema.shape.sceneName,
    sceneOccurrence: fastManimRuntimeTraceProducerRequestV2Schema.shape.sceneOccurrence,
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_SCHEMA_V2),
    sourceHash: sha256V1Schema,
    sourcePath: fastManimRuntimeTraceProducerRequestV2Schema.shape.sourcePath,
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V2),
  })
  .strict();

type FastManimRuntimeTraceV2Base = z.infer<typeof fastManimRuntimeTraceV2BaseSchema>;

export function digestFastManimRuntimeTraceVisualSemanticsV2(trace: FastManimRuntimeTraceV2Base) {
  return digestRuntimeTraceDomainV2("poietra.runtime-trace-visual-semantics-v2", {
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

function reportDuplicateRuntimeTraceV2Id(
  values: readonly Readonly<{ id: string }>[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
) {
  const seen = new Set<string>();
  values.forEach(({ id }, index) => {
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate Runtime Trace V2 identity ${id}.`,
        path: [...path, index, "id"],
      });
    }
    seen.add(id);
  });
}

function runtimeTraceV2PathPoints(path: z.infer<typeof cubicPathV1Schema>) {
  return path.subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end]),
  ]);
}

export function fastManimRuntimeTraceDrawIdentityV2(sceneId: string, paintOrder: number) {
  const titleCount = FAST_MANIM_RUNTIME_TRACE_TITLE_UNION_IDENTITY_ORDERS_V2.length;
  const baselCount = 14;
  const gridCount = FAST_MANIM_RUNTIME_TRACE_GRID_FAMILY_PATHS_V2.length;
  const role =
    paintOrder < titleCount
      ? "title"
      : paintOrder < titleCount + baselCount
        ? "basel"
        : paintOrder < titleCount + baselCount + gridCount
          ? "grid"
          : "grid-title";
  const familyOrder =
    role === "title"
      ? paintOrder
      : role === "basel"
        ? paintOrder - titleCount
        : role === "grid"
          ? paintOrder - titleCount - baselCount
          : paintOrder - titleCount - baselCount - gridCount;
  const order = role === "title" ? FAST_MANIM_RUNTIME_TRACE_TITLE_UNION_IDENTITY_ORDERS_V2[paintOrder] : familyOrder;
  const rootId = `${sceneId}/runtime-root:${role}`;
  return {
    drawId: `${rootId}/runtime-draw:${order}`,
    familyPath: role === "grid" ? FAST_MANIM_RUNTIME_TRACE_GRID_FAMILY_PATHS_V2[familyOrder] : [0, familyOrder],
    order,
    rootId,
    role,
  } as const;
}

export function fastManimRuntimeTraceDrawIsPresentV2(frameIndex: number, drawIndex: number) {
  if (drawIndex < FAST_MANIM_RUNTIME_TRACE_TITLE_UNION_IDENTITY_ORDERS_V2.length) {
    return (
      frameIndex < 480 &&
      (frameIndex >= 180 || !FAST_MANIM_RUNTIME_TRACE_TITLE_EXTENSION_SLOTS_V2.some((slot) => slot === drawIndex))
    );
  }
  if (drawIndex < FAST_MANIM_RUNTIME_TRACE_TITLE_UNION_IDENTITY_ORDERS_V2.length + 14) return frameIndex < 240;
  return frameIndex >= 300;
}

export const fastManimRuntimeTraceV2Schema = fastManimRuntimeTraceV2BaseSchema.superRefine((trace, context) => {
  reportDuplicateRuntimeTraceV2Id(trace.resources.appearances, context, ["resources", "appearances"]);
  reportDuplicateRuntimeTraceV2Id(trace.resources.paths, context, ["resources", "paths"]);
  reportDuplicateRuntimeTraceV2Id(trace.roots, context, ["roots"]);

  if (trace.producer.semanticsSha256 !== digestFastManimRuntimeTraceVisualSemanticsV2(trace)) {
    context.addIssue({
      code: "custom",
      message: "Runtime Trace V2 visual semantics do not match the producer seal.",
      path: ["producer", "semanticsSha256"],
    });
  }

  const expectedRoots = [
    { bindingName: "title", id: `${trace.sceneId}/runtime-root:title`, role: "title" },
    { bindingName: "basel", id: `${trace.sceneId}/runtime-root:basel`, role: "basel" },
    { bindingName: "grid", id: `${trace.sceneId}/runtime-root:grid`, role: "grid" },
    { bindingName: "grid_title", id: `${trace.sceneId}/runtime-root:grid-title`, role: "grid-title" },
  ] as const;
  trace.roots.forEach((root, index) => {
    const expected = expectedRoots[index];
    if (
      !expected ||
      root.id !== expected.id ||
      root.role !== expected.role ||
      root.binding.name !== expected.bindingName
    ) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace V2 roots must match the reviewed title, basel, grid, and grid-title bindings.",
        path: ["roots", index],
      });
    }
  });

  let totalSegments = 0;
  const pathBounds = new Map<string, Readonly<{ maxX: number; maxY: number; minX: number; minY: number }>>();
  trace.resources.paths.forEach(({ id, path }, index) => {
    totalSegments += countCubicPathSegments(path);
    if (totalSegments > MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V2) {
      context.addIssue({
        code: "custom",
        message: `Runtime Trace V2 accepts at most ${MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V2} interned cubic segments.`,
        path: ["resources", "paths", index, "path"],
      });
    }
    const points = runtimeTraceV2PathPoints(path);
    points.forEach((point, pointIndex) => {
      if (
        point.x !== canonicalFastManimRuntimeTraceCoordinateV2(point.x) ||
        point.y !== canonicalFastManimRuntimeTraceCoordinateV2(point.y)
      ) {
        context.addIssue({
          code: "custom",
          message: `Runtime Trace V2 path coordinates must be canonicalized to ${FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V2} decimal digits.`,
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

  const appearances = new Map(trace.resources.appearances.map((appearance) => [appearance.id, appearance]));
  const pathIds = new Set(trace.resources.paths.map(({ id }) => id));
  const referencedAppearanceIds = new Set<string>();
  const referencedPathIds = new Set<string>();
  trace.frames.forEach((frame, frameIndex) => {
    if (frame.frameIndex !== frameIndex) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace V2 frameIndex must equal its canonical presentation index.",
        path: ["frames", frameIndex, "frameIndex"],
      });
    }
    frame.draws.forEach((draw, drawIndex) => {
      const expected = fastManimRuntimeTraceDrawIdentityV2(trace.sceneId, drawIndex);
      if (
        draw.paintOrder !== drawIndex ||
        draw.drawId !== expected.drawId ||
        draw.rootId !== expected.rootId ||
        canonicalJsonV1(draw.familyPath) !== canonicalJsonV1(expected.familyPath)
      ) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace V2 draw identity, family path, root, or paint order changed.",
          path: ["frames", frameIndex, "draws", drawIndex],
        });
      }
      if (draw.present !== fastManimRuntimeTraceDrawIsPresentV2(frameIndex, drawIndex)) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace V2 draw presence changed outside the reviewed Transform and FadeOut phases.",
          path: ["frames", frameIndex, "draws", drawIndex, "present"],
        });
      }
      if (!draw.present && (draw.opacity !== 0 || draw.pathTrim.start !== 0 || draw.pathTrim.end !== 1)) {
        context.addIssue({
          code: "custom",
          message: "An absent Runtime Trace V2 draw must retain an inert canonical witness.",
          path: ["frames", frameIndex, "draws", drawIndex],
        });
      }
      const appearance = appearances.get(draw.appearanceId);
      referencedAppearanceIds.add(draw.appearanceId);
      if (!appearance) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace V2 draw references an unknown appearance resource.",
          path: ["frames", frameIndex, "draws", drawIndex, "appearanceId"],
        });
      }
      if (!pathIds.has(draw.pathId)) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace V2 draw references an unknown path resource.",
          path: ["frames", frameIndex, "draws", drawIndex, "pathId"],
        });
      }
      referencedPathIds.add(draw.pathId);
      if ((expected.role === "basel" || expected.role === "grid-title") && draw.pathTrim.end !== 1) {
        context.addIssue({
          code: "custom",
          message: "OpeningManim fades must retain complete glyph geometry.",
          path: ["frames", frameIndex, "draws", drawIndex, "pathTrim", "end"],
        });
      }
      if (
        draw.pathTrim.end < 1 &&
        draw.opacity > 0 &&
        (!appearance?.stroke || (appearance.fill !== null && appearance.fill.color.alpha > 0))
      ) {
        context.addIssue({
          code: "custom",
          message: "A partial Runtime Trace V2 trim requires stroke-only visible paint.",
          path: ["frames", frameIndex, "draws", drawIndex, "pathTrim"],
        });
      }
      const bounds = pathBounds.get(draw.pathId);
      if (
        bounds &&
        ![
          bounds.minX + draw.translation.x,
          bounds.maxX + draw.translation.x,
          bounds.minY + draw.translation.y,
          bounds.maxY + draw.translation.y,
        ].every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= MAX_COORDINATE)
      ) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace V2 translated geometry is outside renderable Scene coordinates.",
          path: ["frames", frameIndex, "draws", drawIndex, "translation"],
        });
      }
    });
  });

  if (
    referencedAppearanceIds.size !== appearances.size ||
    [...appearances.keys()].some((appearanceId) => !referencedAppearanceIds.has(appearanceId))
  ) {
    context.addIssue({
      code: "custom",
      message: "Runtime Trace V2 appearance resources must all be referenced by a draw.",
      path: ["resources", "appearances"],
    });
  }
  if (referencedPathIds.size !== pathIds.size || [...pathIds].some((pathId) => !referencedPathIds.has(pathId))) {
    context.addIssue({
      code: "custom",
      message: "Runtime Trace V2 path resources must all be referenced by a draw.",
      path: ["resources", "paths"],
    });
  }

  for (const [start, end] of [
    [120, 180],
    [240, 300],
    [480, 540],
  ] as const) {
    const hold = canonicalJsonV1(trace.frames[start]?.draws);
    for (let index = start + 1; index < end; index += 1) {
      if (canonicalJsonV1(trace.frames[index]?.draws) !== hold) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace V2 requires each exact one-second Wait hold.",
          path: ["frames", index, "draws"],
        });
        break;
      }
    }
  }
});

export type FastManimRuntimeTraceV2 = z.infer<typeof fastManimRuntimeTraceV2Schema>;

export const expectedFastManimRuntimeTraceCorrelationV2Schema = z
  .object({
    camera: fastManimRuntimeTraceConfigV2Schema.shape.camera,
    producer: runtimeTraceProducerV2Schema,
    projectId: fastManimRuntimeTraceProducerRequestV2Schema.shape.projectId,
    requestId: fastManimRuntimeTraceProducerRequestV2Schema.shape.requestId,
    roots: fastManimRuntimeTraceV2BaseSchema.shape.roots,
    runtimeConfigHash: sha256V1Schema,
    sceneId: sourceIdentityV1Schema,
    sceneName: fastManimRuntimeTraceProducerRequestV2Schema.shape.sceneName,
    sceneOccurrence: fastManimRuntimeTraceProducerRequestV2Schema.shape.sceneOccurrence,
    sourceHash: sha256V1Schema,
    sourcePath: fastManimRuntimeTraceProducerRequestV2Schema.shape.sourcePath,
  })
  .strict();

export type ExpectedFastManimRuntimeTraceCorrelationV2 = z.infer<
  typeof expectedFastManimRuntimeTraceCorrelationV2Schema
>;

export type TrustedFastManimRuntimeTraceProducerV2 = Readonly<
  Pick<ExpectedFastManimRuntimeTraceCorrelationV2, "producer" | "roots">
>;

export function expectedFastManimRuntimeTraceCorrelationFromRequestV2(
  requestValue: FastManimRuntimeTraceProducerRequestV2,
  trusted: TrustedFastManimRuntimeTraceProducerV2,
) {
  const request = fastManimRuntimeTraceProducerRequestV2Schema.parse(requestValue);
  return expectedFastManimRuntimeTraceCorrelationV2Schema.parse({
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

export type FastManimRuntimeTraceV2ContractErrorCode =
  | "correlation-mismatch"
  | "result-invalid"
  | "result-malformed"
  | "result-too-complex"
  | "result-too-large";

export class FastManimRuntimeTraceV2ContractError extends Error {
  readonly code: FastManimRuntimeTraceV2ContractErrorCode;

  constructor(code: FastManimRuntimeTraceV2ContractErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FastManimRuntimeTraceV2ContractError";
    this.code = code;
  }
}

function assertBoundedRuntimeTraceV2ResultJson(value: unknown) {
  const stack: Array<Readonly<{ depth: number; value: unknown }>> = [{ depth: 0, value }];
  let entries = 0;
  let values = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    values += 1;
    if (
      values > MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V2 ||
      current.depth > MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V2
    ) {
      throw new FastManimRuntimeTraceV2ContractError(
        "result-too-complex",
        "Runtime Trace V2 result exceeds its structural budget.",
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
    let children: unknown[];
    if (Array.isArray(entry)) {
      if (entry.length > MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V2) {
        throw new FastManimRuntimeTraceV2ContractError(
          "result-too-complex",
          "Runtime Trace V2 result contains an oversized array.",
        );
      }
      children = entry;
    } else if (typeof entry === "object") {
      children = Object.values(entry);
      if (children.length > MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V2) {
        throw new FastManimRuntimeTraceV2ContractError(
          "result-too-complex",
          "Runtime Trace V2 result contains an oversized object.",
        );
      }
    } else {
      throw new FastManimRuntimeTraceV2ContractError(
        "result-too-complex",
        "Runtime Trace V2 result is not finite plain JSON.",
      );
    }
    entries += children.length;
    if (entries > MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V2) {
      throw new FastManimRuntimeTraceV2ContractError(
        "result-too-complex",
        "Runtime Trace V2 result exceeds its container-entry budget.",
      );
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ depth: current.depth + 1, value: children[index] });
    }
  }
}

function assertFastManimRuntimeTraceV2Correlation(
  trace: FastManimRuntimeTraceV2,
  expected: ExpectedFastManimRuntimeTraceCorrelationV2,
) {
  for (const key of [
    "projectId",
    "requestId",
    "runtimeConfigHash",
    "sceneId",
    "sceneName",
    "sourceHash",
    "sourcePath",
  ] as const) {
    if (trace[key] !== expected[key]) {
      throw new FastManimRuntimeTraceV2ContractError(
        "correlation-mismatch",
        `Runtime Trace V2 has stale ${key} correlation.`,
      );
    }
  }
  for (const key of ["camera", "producer", "roots", "sceneOccurrence"] as const) {
    if (canonicalJsonV1(trace[key]) !== canonicalJsonV1(expected[key])) {
      throw new FastManimRuntimeTraceV2ContractError(
        "correlation-mismatch",
        `Runtime Trace V2 has stale ${key} correlation.`,
      );
    }
  }
}

export function parseFastManimRuntimeTraceProducerJsonV2(
  value: string | Uint8Array,
  expectedValue: ExpectedFastManimRuntimeTraceCorrelationV2,
) {
  const byteLength = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (byteLength > MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2) {
    throw new FastManimRuntimeTraceV2ContractError(
      "result-too-large",
      `Runtime Trace V2 results accept at most ${MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2} encoded bytes.`,
    );
  }
  let json: string;
  try {
    json = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw new FastManimRuntimeTraceV2ContractError("result-malformed", "Runtime Trace V2 result is not UTF-8 JSON.", {
      cause,
    });
  }
  let document: unknown;
  try {
    document = JSON.parse(json) as unknown;
  } catch (cause) {
    throw new FastManimRuntimeTraceV2ContractError("result-malformed", "Runtime Trace V2 result is malformed JSON.", {
      cause,
    });
  }
  assertBoundedRuntimeTraceV2ResultJson(document);
  const parsed = fastManimRuntimeTraceV2Schema.safeParse(document);
  if (!parsed.success) {
    throw new FastManimRuntimeTraceV2ContractError("result-invalid", "Runtime Trace V2 violates its closed contract.", {
      cause: parsed.error,
    });
  }
  const expected = expectedFastManimRuntimeTraceCorrelationV2Schema.parse(expectedValue);
  assertFastManimRuntimeTraceV2Correlation(parsed.data, expected);
  return parsed.data;
}

export function digestFastManimRuntimeTraceV2(trace: FastManimRuntimeTraceV2) {
  return createHash("sha256").update(canonicalJsonV1(trace)).digest("hex");
}

export function expectedFastManimRuntimeTraceCorrelationV2(
  request: FastManimRuntimeTraceProducerRequestV2,
  trusted: TrustedFastManimRuntimeTraceProducerV2,
) {
  if (digestFastManimRuntimeTraceConfigV2(request.runtimeConfig) !== request.runtimeConfigHash) {
    throw new TypeError("Runtime Trace V2 request has stale config correlation.");
  }
  return expectedFastManimRuntimeTraceCorrelationFromRequestV2(request, trusted);
}
