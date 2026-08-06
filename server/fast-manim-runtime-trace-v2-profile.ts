import { createHash } from "node:crypto";

import type { FastManimRuntimeTraceRunRequestV1 } from "../src/render-pipeline/runtime-trace-preview-contract";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";
import {
  digestFastManimRuntimeTraceConfigV2,
  FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V2,
  FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V2,
  FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2,
  FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V2,
  FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
  FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V2,
  FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
  fastManimRuntimeTraceConfigV2Schema,
  fastManimRuntimeTraceProducerRequestV2Schema,
} from "./fast-manim-runtime-trace-v2-contract";
import {
  expectedFastManimRuntimeTraceCorrelationV2Schema,
  FAST_MANIM_RUNTIME_TRACE_GEOMETRY_RESOURCE_HASH_V2,
  FAST_MANIM_RUNTIME_TRACE_TEX_FONT_BUNDLE_HASH_V2,
  FAST_MANIM_RUNTIME_TRACE_TEX_TOOLCHAIN_HASH_V2,
  type TrustedFastManimRuntimeTraceProducerV2,
} from "./fast-manim-runtime-trace-v2-result-contract";

export const FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V2 = "example_scenes/basic.py" as const;
export const FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V2 = "OpeningManim" as const;
export const FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2 =
  "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f" as const;
export const FAST_MANIM_RUNTIME_TRACE_SCENE_OCCURRENCE_V2 = Object.freeze({
  constructStartLine: 19,
  definitionOrdinal: 1,
});

const sceneId = fastManimRuntimeTraceSceneIdV1(
  FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V2,
  FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V2,
);

const trustedProfile = {
  producer: {
    fastManimCommit: "1227d2c03f16a6d504e90ffc23ba574ee0a88b37",
    fastManimTree: "63e0e988235fb103aa01288593c5d7dbe7421564",
    geometryResourceSha256: FAST_MANIM_RUNTIME_TRACE_GEOMETRY_RESOURCE_HASH_V2,
    manimVersion: "0.20.1",
    semanticsSha256: "60023712a80e500a9a0ebf98b69b8734532dafd1fb6d02b1c00fda592fe65239",
    texFontBundleSha256: FAST_MANIM_RUNTIME_TRACE_TEX_FONT_BUNDLE_HASH_V2,
    texToolchainSha256: FAST_MANIM_RUNTIME_TRACE_TEX_TOOLCHAIN_HASH_V2,
  },
  roots: [
    {
      binding: {
        id: "source-binding:a1b835eb80e612c3c14e229911579f5acd96e41cbde381feeafef51d191e2a76",
        name: "title",
        ordinal: 1,
        span: { endColumn: 13, endLine: 20, startColumn: 8, startLine: 20 },
      },
      id: `${sceneId}/runtime-root:title`,
      role: "title",
    },
    {
      binding: {
        id: "source-binding:7bbcedf39b0c7451eb6632b82cd1058e6b9bfefc7971e36ad17208dd42610b95",
        name: "basel",
        ordinal: 2,
        span: { endColumn: 13, endLine: 21, startColumn: 8, startLine: 21 },
      },
      id: `${sceneId}/runtime-root:basel`,
      role: "basel",
    },
  ],
} as const satisfies TrustedFastManimRuntimeTraceProducerV2;

const trustedProfileSchema = expectedFastManimRuntimeTraceCorrelationV2Schema.pick({
  producer: true,
  roots: true,
});

/** Returns a fresh validated copy so callers cannot mutate the V2 trust anchor. */
export function trustedFastManimRuntimeTraceProducerV2(): TrustedFastManimRuntimeTraceProducerV2 {
  return trustedProfileSchema.parse(trustedProfile);
}

export function createFastManimRuntimeTraceConfigV2(frame: Readonly<{ height: number; width: number }>) {
  return fastManimRuntimeTraceConfigV2Schema.parse({
    camera: {
      background: { alpha: 1, blue: 0, green: 0, red: 0 },
      center: { x: 0, y: 0 },
      frameHeight: frame.height,
      frameWidth: frame.width,
    },
    compositing: "manim-cairo-srgb",
    coordinatePrecisionDigits: FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V2,
    durationSeconds: FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2,
    frameRate: FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2,
    profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
    randomSeed: 0,
    samplePhase: FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V2,
    schema: FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V2,
    version: FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
  });
}

export const FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V2 =
  "9fd2f025662f618dfae3f5e9c570e060b465b8c825b586161a0675274c4d27d1" as const;

export function createFastManimRuntimeTraceProducerRequestV2(
  run: FastManimRuntimeTraceRunRequestV1,
  sourceText: string,
  frame: Readonly<{ height: number; width: number }>,
) {
  const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
  const runtimeConfig = createFastManimRuntimeTraceConfigV2(frame);
  const runtimeConfigHash = digestFastManimRuntimeTraceConfigV2(runtimeConfig);
  if (
    run.sourcePath !== FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V2 ||
    run.sceneName !== FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V2 ||
    run.sourceHash !== FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2 ||
    sourceHash !== FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2 ||
    runtimeConfigHash !== FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V2
  ) {
    throw new TypeError("Runtime Trace V2 accepts only the exact reviewed OpeningManim 0–3 second profile.");
  }
  return fastManimRuntimeTraceProducerRequestV2Schema.parse({
    profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
    projectId: run.projectId,
    requestId: run.requestId,
    runtimeConfig,
    runtimeConfigHash,
    sceneId: fastManimRuntimeTraceSceneIdV1(run.sourcePath, run.sceneName),
    sceneName: run.sceneName,
    sceneOccurrence: FAST_MANIM_RUNTIME_TRACE_SCENE_OCCURRENCE_V2,
    schema: FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V2,
    sourceHash,
    sourcePath: run.sourcePath,
    sourceText,
    version: FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
  });
}
