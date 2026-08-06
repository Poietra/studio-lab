import { createHash } from "node:crypto";

import type { FastManimRuntimeTraceRunRequestV1 } from "../src/render-pipeline/runtime-trace-preview-contract";
import {
  digestFastManimRuntimeTraceConfigV1,
  expectedFastManimRuntimeTraceCorrelationV1Schema,
  FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1,
  FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
  FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V1,
  FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V1,
  FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1,
  FAST_MANIM_RUNTIME_TRACE_VERSION_V1,
  fastManimRuntimeTraceConfigV1Schema,
  fastManimRuntimeTraceProducerRequestV1Schema,
  fastManimRuntimeTraceSceneIdV1,
  type TrustedFastManimRuntimeTraceProducerV1,
} from "./fast-manim-runtime-trace-contract";

export const FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V1 = "example_scenes/basic.py" as const;
export const FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V1 = "UpdatersExample" as const;
export const FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1 =
  "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f" as const;
export const FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V1 =
  "9b69b6296dc706b1deebbc1d9f88b05ef2f97aa9acf1e87eae9a8efd13b33c97" as const;
export const FAST_MANIM_RUNTIME_TRACE_SCENE_OCCURRENCE_V1 = Object.freeze({
  constructStartLine: 113,
  definitionOrdinal: 5,
});

const sceneId = fastManimRuntimeTraceSceneIdV1(
  FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V1,
  FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V1,
);

const trustedProfile = {
  producer: {
    fastManimCommit: "07ec3bb1f860e2e466801f8e71735310819d98c7",
    fastManimTree: "3e94ab796e733cbe057a146c0cce5089c0d5d2bc",
    glyphProviderSha256: "b95975405e4df8302088ac0b01afb55b42bd1892d8fa8161a1ca556e023e6322",
    manimVersion: "0.20.1",
    semanticsSha256: "abf581019158101abbe1597d265fcafa8da2fc9e40d986492e180a3f4ddc2172",
  },
  roots: [
    {
      anchor: "center",
      binding: {
        id: "source-binding:36e908da814370fcfda6ad921f130089e3c53808f12cb8e0b85b1725e2c4faf0",
        name: "square",
        ordinal: 2,
        span: { endColumn: 14, endLine: 120, startColumn: 8, startLine: 120 },
      },
      id: `${sceneId}/runtime-root:square`,
      offset: { x: 0, y: 0 },
      role: "square",
    },
    {
      anchor: "left-center",
      binding: {
        id: "source-binding:a72c9c180160cc53824643a94733ca5c8819439df2ff958350553bc7ba5643b8",
        name: "decimal",
        ordinal: 1,
        span: { endColumn: 15, endLine: 114, startColumn: 8, startLine: 114 },
      },
      id: `${sceneId}/runtime-root:decimal`,
      offset: { x: 1.25, y: 0 },
      role: "decimal",
    },
  ],
} as const satisfies TrustedFastManimRuntimeTraceProducerV1;

const trustedProfileSchema = expectedFastManimRuntimeTraceCorrelationV1Schema.pick({
  producer: true,
  roots: true,
});

/** Returns a fresh validated copy so no caller can mutate the trust anchor. */
export function trustedFastManimRuntimeTraceProducerV1(): TrustedFastManimRuntimeTraceProducerV1 {
  return trustedProfileSchema.parse(trustedProfile);
}

/** Non-secret producer identity injected into the isolated local CLI environment. */
export function fastManimRuntimeTraceProducerEnvironmentV1() {
  return Object.freeze({
    POIETRA_FAST_MANIM_COMMIT: trustedProfile.producer.fastManimCommit,
    POIETRA_FAST_MANIM_TREE: trustedProfile.producer.fastManimTree,
  });
}

export function createFastManimRuntimeTraceConfigV1(frame: Readonly<{ height: number; width: number }>) {
  return fastManimRuntimeTraceConfigV1Schema.parse({
    camera: {
      background: { alpha: 1, blue: 0, green: 0, red: 0 },
      center: { x: 0, y: 0 },
      frameHeight: frame.height,
      frameWidth: frame.width,
    },
    compositing: "manim-cairo-srgb",
    coordinatePrecisionDigits: FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1,
    durationSeconds: FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
    frameRate: FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
    profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V1,
    randomSeed: 0,
    samplePhase: FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1,
    schema: "poietra.fast-manim-runtime-trace-config",
    version: FAST_MANIM_RUNTIME_TRACE_VERSION_V1,
  });
}

export function createFastManimRuntimeTraceProducerRequestV1(
  run: FastManimRuntimeTraceRunRequestV1,
  sourceText: string,
  frame: Readonly<{ height: number; width: number }>,
) {
  const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
  const runtimeConfig = createFastManimRuntimeTraceConfigV1(frame);
  const runtimeConfigHash = digestFastManimRuntimeTraceConfigV1(runtimeConfig);
  if (
    run.sourcePath !== FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V1 ||
    run.sceneName !== FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V1 ||
    run.sourceHash !== FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1 ||
    sourceHash !== FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1 ||
    runtimeConfigHash !== FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V1
  ) {
    throw new TypeError("Runtime Trace V1 accepts only the exact reviewed UpdatersExample profile.");
  }
  return fastManimRuntimeTraceProducerRequestV1Schema.parse({
    profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V1,
    projectId: run.projectId,
    requestId: run.requestId,
    runtimeConfig,
    runtimeConfigHash,
    sceneId,
    sceneName: run.sceneName,
    sceneOccurrence: FAST_MANIM_RUNTIME_TRACE_SCENE_OCCURRENCE_V1,
    schema: FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V1,
    sourceHash,
    sourcePath: run.sourcePath,
    sourceText,
    version: FAST_MANIM_RUNTIME_TRACE_VERSION_V1,
  });
}
