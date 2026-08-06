import type { FastManimRuntimeTraceRunRequestV1 } from "../src/render-pipeline/runtime-trace-preview-contract";
import {
  digestFastManimRuntimeTraceConfigV1,
  FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1,
} from "./fast-manim-runtime-trace-contract";
import {
  createFastManimRuntimeTraceConfigV1,
  FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V1,
  FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V1,
  FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1,
  FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V1,
} from "./fast-manim-runtime-trace-profile";
import {
  digestFastManimRuntimeTraceConfigV2,
  FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2,
} from "./fast-manim-runtime-trace-v2-contract";
import {
  createFastManimRuntimeTraceConfigV2,
  FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V2,
  FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V2,
  FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
  FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V2,
} from "./fast-manim-runtime-trace-v2-profile";
import {
  MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V2,
} from "./fast-manim-runtime-trace-v2-result-contract";

export type FastManimRuntimeTraceProfile =
  | Readonly<{
      duration: typeof FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1;
      maxNormalizedBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1;
      maxResultBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1;
      rootNames: readonly ["square", "decimal"];
      runtimeConfigHash: typeof FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V1;
      version: 1;
    }>
  | Readonly<{
      duration: typeof FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2;
      maxNormalizedBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V2;
      maxResultBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2;
      rootNames: readonly ["title", "basel"];
      runtimeConfigHash: typeof FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V2;
      version: 2;
    }>;

const runtimeTraceProfiles = Object.freeze([
  Object.freeze({
    duration: FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
    maxNormalizedBytes: MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1,
    maxResultBytes: MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1,
    rootNames: Object.freeze(["square", "decimal"] as const),
    runtimeConfigHash: FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V1,
    sceneName: FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V1,
    sourceHash: FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1,
    sourcePath: FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V1,
    version: 1,
  }),
  Object.freeze({
    duration: FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2,
    maxNormalizedBytes: MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V2,
    maxResultBytes: MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2,
    rootNames: Object.freeze(["title", "basel"] as const),
    runtimeConfigHash: FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V2,
    sceneName: FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V2,
    sourceHash: FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
    sourcePath: FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V2,
    version: 2,
  }),
] as const);

/** Selects a reviewed profile only from the browser's exact source identity. */
export function selectFastManimRuntimeTraceProfile(
  request: FastManimRuntimeTraceRunRequestV1,
): FastManimRuntimeTraceProfile | null {
  const profile = runtimeTraceProfiles.find(
    (candidate) =>
      request.sourcePath === candidate.sourcePath &&
      request.sceneName === candidate.sceneName &&
      request.sourceHash === candidate.sourceHash,
  );
  if (!profile) return null;
  const { sceneName: _sceneName, sourceHash: _sourceHash, sourcePath: _sourcePath, ...selected } = profile;
  return selected;
}

/** Recomputes the selected profile's sealed config against the runner-owned frame. */
export function digestSelectedFastManimRuntimeTraceConfig(
  profile: FastManimRuntimeTraceProfile,
  frame: Readonly<{ height: number; width: number }>,
) {
  return profile.version === 1
    ? digestFastManimRuntimeTraceConfigV1(createFastManimRuntimeTraceConfigV1(frame))
    : digestFastManimRuntimeTraceConfigV2(createFastManimRuntimeTraceConfigV2(frame));
}
