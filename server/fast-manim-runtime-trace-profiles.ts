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
import {
  createFastManimRuntimeTraceConfigV3,
  digestFastManimRuntimeTraceConfigV3,
} from "./fast-manim-runtime-trace-v3-contract";
import {
  MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V3,
} from "./fast-manim-runtime-trace-v3-result-contract";

export type FastManimRuntimeTraceProfile =
  | Readonly<{
      duration: typeof FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1;
      maxNormalizedBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1;
      maxResultBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1;
      roots: readonly [
        Readonly<{ bindingName: "square"; role: "square" }>,
        Readonly<{ bindingName: "decimal"; role: "decimal" }>,
      ];
      runtimeConfigHash: typeof FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V1;
      version: 1;
    }>
  | Readonly<{
      duration: typeof FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2;
      maxNormalizedBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V2;
      maxResultBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2;
      roots: readonly [
        Readonly<{ bindingName: "title"; role: "title" }>,
        Readonly<{ bindingName: "basel"; role: "basel" }>,
        Readonly<{ bindingName: "grid"; role: "grid" }>,
        Readonly<{ bindingName: "grid_title"; role: "grid-title" }>,
      ];
      runtimeConfigHash: typeof FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V2;
      version: 2;
    }>;

export type FastManimGenericRuntimeTraceProfileV3 = Readonly<{
  maxNormalizedBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V3;
  maxResultBytes: typeof MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V3;
  roots: readonly [];
  runtimeConfigHash: string;
  version: 3;
}>;

export function createFastManimGenericRuntimeTraceProfileV3(
  frame: Readonly<{ height: number; width: number }>,
): FastManimGenericRuntimeTraceProfileV3 {
  return Object.freeze({
    maxNormalizedBytes: MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V3,
    maxResultBytes: MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V3,
    roots: Object.freeze([] as const),
    runtimeConfigHash: digestFastManimRuntimeTraceConfigV3(createFastManimRuntimeTraceConfigV3(frame)),
    version: 3,
  });
}

const runtimeTraceProfiles = Object.freeze([
  Object.freeze({
    duration: FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
    maxNormalizedBytes: MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1,
    maxResultBytes: MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1,
    roots: Object.freeze([
      Object.freeze({ bindingName: "square", role: "square" }),
      Object.freeze({ bindingName: "decimal", role: "decimal" }),
    ] as const),
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
    roots: Object.freeze([
      Object.freeze({ bindingName: "title", role: "title" }),
      Object.freeze({ bindingName: "basel", role: "basel" }),
      Object.freeze({ bindingName: "grid", role: "grid" }),
      Object.freeze({ bindingName: "grid_title", role: "grid-title" }),
    ] as const),
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

/** Selects only the reviewed Scene family. A verified response may use this
 * after the runner has independently proved an edited source generation; it
 * must never authorize producer execution by itself. */
export function selectFastManimRuntimeTraceSceneProfile(
  request: FastManimRuntimeTraceRunRequestV1,
): FastManimRuntimeTraceProfile | null {
  const profile = runtimeTraceProfiles.find(
    (candidate) => request.sourcePath === candidate.sourcePath && request.sceneName === candidate.sceneName,
  );
  if (!profile) return null;
  const { sceneName: _sceneName, sourceHash: _sourceHash, sourcePath: _sourcePath, ...selected } = profile;
  return selected;
}

/** Recomputes the selected profile's sealed config against the runner-owned frame. */
export function digestSelectedFastManimRuntimeTraceConfig(
  profile: FastManimRuntimeTraceProfile | FastManimGenericRuntimeTraceProfileV3,
  frame: Readonly<{ height: number; width: number }>,
) {
  if (profile.version === 1) return digestFastManimRuntimeTraceConfigV1(createFastManimRuntimeTraceConfigV1(frame));
  if (profile.version === 2) return digestFastManimRuntimeTraceConfigV2(createFastManimRuntimeTraceConfigV2(frame));
  return digestFastManimRuntimeTraceConfigV3(createFastManimRuntimeTraceConfigV3(frame));
}
