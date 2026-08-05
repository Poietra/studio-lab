import { createHash } from "node:crypto";

import { z } from "zod";

import {
  countCubicPathSegments,
  cubicPathV1Schema,
  engineAffineTransformV1Schema,
  enginePointV1Schema,
  fillStyleV1Schema,
  isSingularAffineTransform,
  MAX_COORDINATE,
  normalizedNumberV1Schema,
  opaqueIdV1Schema,
  rgbaColorV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
  strokeStyleV1Schema,
} from "../src/engine/contracts";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { sourceBindingV1Schema } from "../src/engine/source-runtime-identity";
import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../src/render-pipeline/manim-identity-contract";

export const FAST_MANIM_RUNTIME_TRACE_SCHEMA_V1 = "poietra.fast-manim-runtime-trace" as const;
export const FAST_MANIM_RUNTIME_TRACE_VERSION_V1 = 1 as const;
export const FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1 = 60 as const;
export const FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1 = 6 as const;
export const FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1 =
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1 * FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1;
export const FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V1 = 8 as const;
export const MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 = 5 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V1 = 64;
export const MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V1 = 16;
export const MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1 = 4_096;

const gitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}$/u, "Git object IDs must be lower-case SHA-1 hex.");

const correlationShape = {
  projectId: manimProjectIdSchema,
  requestId: opaqueIdV1Schema,
  runtimeConfigHash: sha256V1Schema,
  sceneId: sourceIdentityV1Schema,
  sceneName: manimSceneNameSchema,
  sourceHash: sha256V1Schema,
  sourcePath: manimSourcePathSchema,
};

const runtimeTraceCameraV1Schema = z
  .object({
    background: rgbaColorV1Schema,
    center: enginePointV1Schema,
    frameHeight: z.number().finite().positive().max(MAX_COORDINATE),
    frameWidth: z.number().finite().positive().max(MAX_COORDINATE),
  })
  .strict();

const runtimeTraceAffineV1Schema = engineAffineTransformV1Schema.refine(
  (transform) =>
    [transform.m11, transform.m12, transform.m21, transform.m22].every(
      (component) => Math.abs(component) <= MAX_COORDINATE,
    ) && !isSingularAffineTransform(transform),
  "Runtime Trace transforms must remain finite, bounded, and non-singular in the renderer domain.",
);

const runtimeTraceRootV1Schema = z
  .object({
    binding: sourceBindingV1Schema,
    id: sourceIdentityV1Schema,
    role: z.enum(["square", "decimal"]),
  })
  .strict();

const runtimeTracePathResourceV1Schema = z
  .object({
    id: opaqueIdV1Schema,
    path: cubicPathV1Schema,
  })
  .strict();

const runtimeTraceAppearanceResourceV1Schema = z
  .object({
    fill: fillStyleV1Schema.nullable(),
    id: opaqueIdV1Schema,
    stroke: strokeStyleV1Schema.nullable(),
  })
  .strict()
  .refine(({ fill, stroke }) => fill !== null || stroke !== null, {
    message: "A Runtime Trace appearance requires a fill or stroke.",
  });

const runtimeTraceDrawV1Schema = z
  .object({
    appearanceId: opaqueIdV1Schema,
    localTransform: runtimeTraceAffineV1Schema,
    opacity: normalizedNumberV1Schema,
    paintOrder: z
      .number()
      .int()
      .nonnegative()
      .max(FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V1 - 1),
    pathId: opaqueIdV1Schema,
    rootId: sourceIdentityV1Schema,
    slot: z.number().int().nonnegative().max(6),
    sourceZIndex: z.number().finite(),
  })
  .strict();

const runtimeTraceRootTransformV1Schema = z
  .object({
    rootId: sourceIdentityV1Schema,
    transform: runtimeTraceAffineV1Schema,
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
    rootTransforms: z.array(runtimeTraceRootTransformV1Schema).length(2),
  })
  .strict();

const runtimeTraceProducerV1Schema = z
  .object({
    fastManimCommit: gitObjectIdSchema,
    fastManimTree: gitObjectIdSchema,
    glyphProviderSha256: sha256V1Schema,
    manimVersion: z.string().min(1).max(64),
    semanticsSha256: sha256V1Schema,
  })
  .strict();

const fastManimRuntimeTraceV1BaseSchema = z
  .object({
    ...correlationShape,
    authority: z.literal("preview-only"),
    camera: runtimeTraceCameraV1Schema,
    compositing: z.literal("manim-cairo-srgb"),
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
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V1),
  })
  .strict();

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

function rootSlotKey(rootId: string, slot: number) {
  return JSON.stringify([rootId, slot]);
}

export const fastManimRuntimeTraceV1Schema = fastManimRuntimeTraceV1BaseSchema.superRefine((trace, context) => {
  reportDuplicateId(trace.resources.appearances, context, ["resources", "appearances"]);
  reportDuplicateId(trace.resources.paths, context, ["resources", "paths"]);
  reportDuplicateId(trace.roots, context, ["roots"]);

  const appearanceIds = new Set(trace.resources.appearances.map(({ id }) => id));
  const pathIds = new Set(trace.resources.paths.map(({ id }) => id));
  const roots = new Map(trace.roots.map((root) => [root.id, root]));
  let pathSegments = 0;
  trace.resources.paths.forEach(({ path }, index) => {
    pathSegments += countCubicPathSegments(path);
    if (pathSegments > MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1) {
      context.addIssue({
        code: "custom",
        message: `Runtime Trace V1 accepts at most ${MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1} interned cubic segments.`,
        path: ["resources", "paths", index, "path"],
      });
    }
  });

  const expectedRoles = ["square", "decimal"] as const;
  trace.roots.forEach((root, index) => {
    if (root.role !== expectedRoles[index] || root.binding.name !== root.role) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace V1 roots must be the source-bound square then decimal roots.",
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
    const occupiedSlots = new Set<string>();
    frame.rootTransforms.forEach((rootTransform, rootIndex) => {
      if (rootTransform.rootId !== trace.roots[rootIndex]?.id) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace root transforms must follow the canonical square then decimal root order.",
          path: ["frames", frameIndex, "rootTransforms", rootIndex, "rootId"],
        });
      }
    });
    frame.draws.forEach((draw, drawIndex) => {
      const root = roots.get(draw.rootId);
      const slotKey = rootSlotKey(draw.rootId, draw.slot);
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
      } else if ((root.role === "square" && draw.slot !== 0) || (root.role === "decimal" && draw.slot > 6)) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace draw slot is invalid for its source root.",
          path: ["frames", frameIndex, "draws", drawIndex, "slot"],
        });
      }
      if (occupiedSlots.has(slotKey)) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace frame contains more than one draw for a root slot.",
          path: ["frames", frameIndex, "draws", drawIndex, "slot"],
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
      occupiedSlots.add(slotKey);
    });

    const squareId = trace.roots[0]?.id;
    const decimalId = trace.roots[1]?.id;
    const expectedSlots = [
      rootSlotKey(squareId ?? "", 0),
      ...Array.from({ length: 7 }, (_, slot) => rootSlotKey(decimalId ?? "", slot)),
    ];
    if (expectedSlots.some((slot) => !occupiedSlots.has(slot))) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace frame must contain one Square draw and all seven DecimalNumber slots.",
        path: ["frames", frameIndex, "draws"],
      });
    }
  });

  const terminal = canonicalJsonV1({
    draws: trace.frames[300]?.draws,
    rootTransforms: trace.frames[300]?.rootTransforms,
  });
  for (let index = 301; index < trace.frames.length; index += 1) {
    if (
      canonicalJsonV1({
        draws: trace.frames[index]?.draws,
        rootTransforms: trace.frames[index]?.rootTransforms,
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

export type FastManimRuntimeTraceContractErrorCodeV1 =
  | "correlation-mismatch"
  | "result-invalid"
  | "result-malformed"
  | "result-too-large";

export class FastManimRuntimeTraceContractError extends Error {
  readonly code: FastManimRuntimeTraceContractErrorCodeV1;

  constructor(code: FastManimRuntimeTraceContractErrorCodeV1, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FastManimRuntimeTraceContractError";
    this.code = code;
  }
}

function parseRuntimeTraceJson(value: string | Uint8Array) {
  const byteLength = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (byteLength > MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1) {
    throw new FastManimRuntimeTraceContractError(
      "result-too-large",
      `Runtime Trace V1 accepts at most ${MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1} encoded bytes.`,
    );
  }
  let json: string;
  try {
    json = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw new FastManimRuntimeTraceContractError("result-malformed", "Runtime Trace V1 is not UTF-8 JSON.", {
      cause,
    });
  }
  try {
    return JSON.parse(json) as unknown;
  } catch (cause) {
    throw new FastManimRuntimeTraceContractError("result-malformed", "Runtime Trace V1 is malformed JSON.", {
      cause,
    });
  }
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
  const parsed = fastManimRuntimeTraceV1Schema.safeParse(parseRuntimeTraceJson(value));
  if (!parsed.success) {
    throw new FastManimRuntimeTraceContractError("result-invalid", "Runtime Trace V1 violates its closed contract.", {
      cause: parsed.error,
    });
  }
  assertRuntimeTraceCorrelation(parsed.data, expectedFastManimRuntimeTraceCorrelationV1Schema.parse(expected));
  return parsed.data;
}

export function digestFastManimRuntimeTraceV1(trace: FastManimRuntimeTraceV1) {
  return createHash("sha256").update(canonicalJsonV1(trace)).digest("hex");
}

/** Maps a Studio time to the captured presentation frame; duration retains the final frame. */
export function fastManimRuntimeTraceFrameIndexAtTimeV1(time: number) {
  if (!Number.isFinite(time) || time < 0 || time > FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1) {
    throw new RangeError("Runtime Trace sample time must be finite and inside the six-second Scene.");
  }
  return Math.min(
    FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1 - 1,
    Math.floor(time * FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1),
  );
}
