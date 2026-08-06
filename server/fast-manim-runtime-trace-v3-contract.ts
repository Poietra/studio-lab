import { createHash } from "node:crypto";

import { z } from "zod";

import {
  enginePointV1Schema,
  MAX_COORDINATE,
  opaqueIdV1Schema,
  rgbaColorV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
} from "../src/engine/contracts";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../src/render-pipeline/manim-identity-contract";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";
import { canonicalF64HexV1 } from "./fast-manim-snapshot-contract";

export const FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V3 =
  "poietra.fast-manim-runtime-trace-producer-request" as const;
export const FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V3 = "poietra.fast-manim-runtime-trace-config" as const;
export const FAST_MANIM_RUNTIME_TRACE_VERSION_V3 = 3 as const;
export const FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3 = 3 as const;
export const FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3 = 60 as const;
export const FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3 = 900 as const;
export const FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3 = 13 as const;
export const FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V3 = "post-updater-pre-cairo-paint" as const;
export const MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V3 = 2 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V3 =
  MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V3 * 6 + 64 * 1024;

const canonicalCameraV3 = {
  background: { alpha: 1, blue: 0, green: 0, red: 0 },
  center: { x: 0, y: 0 },
  frameHeight: 8,
  frameWidth: 128 / 9,
} as const;

function sameNumber(actual: number, expected: number) {
  return canonicalF64HexV1(actual) === canonicalF64HexV1(expected);
}

const runtimeTraceCameraV3Schema = z
  .object({
    background: rgbaColorV1Schema,
    center: enginePointV1Schema,
    frameHeight: z.number().finite().positive().max(MAX_COORDINATE),
    frameWidth: z.number().finite().positive().max(MAX_COORDINATE),
  })
  .strict()
  .refine(
    (camera) =>
      sameNumber(camera.background.alpha, canonicalCameraV3.background.alpha) &&
      sameNumber(camera.background.blue, canonicalCameraV3.background.blue) &&
      sameNumber(camera.background.green, canonicalCameraV3.background.green) &&
      sameNumber(camera.background.red, canonicalCameraV3.background.red) &&
      sameNumber(camera.center.x, canonicalCameraV3.center.x) &&
      sameNumber(camera.center.y, canonicalCameraV3.center.y) &&
      sameNumber(camera.frameHeight, canonicalCameraV3.frameHeight) &&
      sameNumber(camera.frameWidth, canonicalCameraV3.frameWidth),
    "Runtime Trace V3 requires the exact default Cairo camera.",
  );

export const fastManimRuntimeTraceConfigV3Schema = z
  .object({
    camera: runtimeTraceCameraV3Schema,
    compositing: z.literal("manim-cairo-srgb"),
    coordinatePrecisionDigits: z.literal(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3),
    frameRate: z.literal(FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3),
    maxFrameCount: z.literal(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3),
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3),
    randomSeed: z.literal(0),
    samplePhase: z.literal(FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V3),
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V3),
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V3),
  })
  .strict();

export type FastManimRuntimeTraceConfigV3 = z.infer<typeof fastManimRuntimeTraceConfigV3Schema>;

function digestValueV3(value: unknown): unknown {
  if (typeof value === "number") return canonicalF64HexV1(value);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(digestValueV3);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, digestValueV3(entry)]),
    );
  }
  throw new TypeError("Runtime Trace V3 digest input must be finite plain JSON.");
}

export function digestFastManimRuntimeTraceDomainV3(domain: string, value: unknown) {
  return createHash("sha256")
    .update(canonicalJsonV1({ domain, value: digestValueV3(value) }))
    .digest("hex");
}

export function digestFastManimRuntimeTraceConfigV3(value: FastManimRuntimeTraceConfigV3) {
  return digestFastManimRuntimeTraceDomainV3(
    "poietra.fast-manim-runtime-trace-config.v3",
    fastManimRuntimeTraceConfigV3Schema.parse(value),
  );
}

function isUnicodeScalarSequence(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const fastManimRuntimeTraceProducerRequestV3Schema = z
  .object({
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3),
    projectId: manimProjectIdSchema,
    requestId: opaqueIdV1Schema,
    runtimeConfig: fastManimRuntimeTraceConfigV3Schema,
    runtimeConfigHash: sha256V1Schema,
    sceneId: sourceIdentityV1Schema,
    sceneName: manimSceneNameSchema,
    sceneOccurrence: z
      .object({
        constructStartLine: z.number().int().positive().max(10_000),
        definitionOrdinal: z.number().int().positive().max(10_000),
      })
      .strict(),
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V3),
    sourceHash: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
    sourceText: z.string().refine(isUnicodeScalarSequence, "Runtime Trace V3 sourceText must contain Unicode scalars."),
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V3),
  })
  .strict()
  .superRefine((request, context) => {
    if (Buffer.byteLength(request.sourceText, "utf8") > MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V3) {
      context.addIssue({
        code: "custom",
        message: `Runtime Trace V3 source accepts at most ${MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V3} UTF-8 bytes.`,
        path: ["sourceText"],
      });
    }
    if (request.sourceHash !== createHash("sha256").update(request.sourceText, "utf8").digest("hex")) {
      context.addIssue({ code: "custom", message: "Runtime Trace V3 sourceHash is stale.", path: ["sourceHash"] });
    }
    if (request.sceneId !== fastManimRuntimeTraceSceneIdV1(request.sourcePath, request.sceneName)) {
      context.addIssue({ code: "custom", message: "Runtime Trace V3 sceneId is stale.", path: ["sceneId"] });
    }
    if (request.runtimeConfigHash !== digestFastManimRuntimeTraceConfigV3(request.runtimeConfig)) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace V3 runtimeConfigHash is stale.",
        path: ["runtimeConfigHash"],
      });
    }
  });

export type FastManimRuntimeTraceProducerRequestV3 = z.infer<typeof fastManimRuntimeTraceProducerRequestV3Schema>;

export function createFastManimRuntimeTraceConfigV3(frame: Readonly<{ height: number; width: number }>) {
  return fastManimRuntimeTraceConfigV3Schema.parse({
    camera: {
      background: canonicalCameraV3.background,
      center: canonicalCameraV3.center,
      frameHeight: frame.height,
      frameWidth: frame.width,
    },
    compositing: "manim-cairo-srgb",
    coordinatePrecisionDigits: FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3,
    frameRate: FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
    maxFrameCount: FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3,
    profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3,
    randomSeed: 0,
    samplePhase: FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V3,
    schema: FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V3,
    version: FAST_MANIM_RUNTIME_TRACE_VERSION_V3,
  });
}

export function createFastManimRuntimeTraceProducerRequestV3(
  run: Readonly<{
    projectId: string;
    requestId: string;
    sceneName: string;
    sourceHash: string;
    sourcePath: string;
  }>,
  sourceText: string,
  sceneOccurrence: Readonly<{ constructStartLine: number; definitionOrdinal: number }>,
  frame: Readonly<{ height: number; width: number }>,
) {
  const runtimeConfig = createFastManimRuntimeTraceConfigV3(frame);
  return fastManimRuntimeTraceProducerRequestV3Schema.parse({
    profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3,
    projectId: run.projectId,
    requestId: run.requestId,
    runtimeConfig,
    runtimeConfigHash: digestFastManimRuntimeTraceConfigV3(runtimeConfig),
    sceneId: fastManimRuntimeTraceSceneIdV1(run.sourcePath, run.sceneName),
    sceneName: run.sceneName,
    sceneOccurrence,
    schema: FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V3,
    sourceHash: run.sourceHash,
    sourcePath: run.sourcePath,
    sourceText,
    version: FAST_MANIM_RUNTIME_TRACE_VERSION_V3,
  });
}
