import { createHash } from "node:crypto";

import { applyEngineEasingV1 } from "../../src/engine/easing";
import { fastManimRuntimeTraceSceneIdV1 } from "../fast-manim-runtime-trace-contract";
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
} from "../fast-manim-runtime-trace-v2-contract";
import {
  canonicalFastManimRuntimeTraceCoordinateV2,
  digestFastManimRuntimeTraceAppearanceV2,
  digestFastManimRuntimeTracePathV2,
  digestFastManimRuntimeTraceVisualSemanticsV2,
  type ExpectedFastManimRuntimeTraceCorrelationV2,
  FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V2,
  FAST_MANIM_RUNTIME_TRACE_GEOMETRY_RESOURCE_HASH_V2,
  FAST_MANIM_RUNTIME_TRACE_SCHEMA_V2,
  FAST_MANIM_RUNTIME_TRACE_TEX_FONT_BUNDLE_HASH_V2,
  FAST_MANIM_RUNTIME_TRACE_TEX_TOOLCHAIN_HASH_V2,
  fastManimRuntimeTraceDrawIdentityV2,
  fastManimRuntimeTraceDrawIsPresentV2,
  fastManimRuntimeTraceV2Schema,
  type SelfSealedFastManimRuntimeTraceV2,
} from "../fast-manim-runtime-trace-v2-result-contract";
import { RUNTIME_TRACE_SOURCE_TEXT } from "./fast-manim-runtime-trace-fixture";

export const RUNTIME_TRACE_V2_SOURCE_PATH = "example_scenes/basic.py" as const;
export const RUNTIME_TRACE_V2_SCENE_NAME = "OpeningManim" as const;
export const RUNTIME_TRACE_V2_SOURCE_HASH = createHash("sha256")
  .update(RUNTIME_TRACE_SOURCE_TEXT, "utf8")
  .digest("hex");
export const RUNTIME_TRACE_V2_SCENE_OCCURRENCE = Object.freeze({
  constructStartLine: 19,
  definitionOrdinal: 1,
});

export function runtimeTraceV2ConfigFixture() {
  return fastManimRuntimeTraceConfigV2Schema.parse({
    camera: {
      background: { alpha: 1, blue: 0, green: 0, red: 0 },
      center: { x: 0, y: 0 },
      frameHeight: 8,
      frameWidth: 128 / 9,
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

export const RUNTIME_TRACE_V2_CONFIG_HASH = digestFastManimRuntimeTraceConfigV2(runtimeTraceV2ConfigFixture());

export function runtimeTraceV2RequestFixture(sourceText = RUNTIME_TRACE_SOURCE_TEXT) {
  const runtimeConfig = runtimeTraceV2ConfigFixture();
  const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
  return fastManimRuntimeTraceProducerRequestV2Schema.parse({
    profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
    projectId: "demo",
    requestId: "req-opening-runtime-trace-v2",
    runtimeConfig,
    runtimeConfigHash: digestFastManimRuntimeTraceConfigV2(runtimeConfig),
    sceneId: fastManimRuntimeTraceSceneIdV1(RUNTIME_TRACE_V2_SOURCE_PATH, RUNTIME_TRACE_V2_SCENE_NAME),
    sceneName: RUNTIME_TRACE_V2_SCENE_NAME,
    sceneOccurrence: RUNTIME_TRACE_V2_SCENE_OCCURRENCE,
    schema: FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V2,
    sourceHash,
    sourcePath: RUNTIME_TRACE_V2_SOURCE_PATH,
    sourceText,
    version: FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
  });
}

export const RUNTIME_TRACE_V2_SCENE_ID =
  "scene:8b27b13ce1d003ec4436921829dfc1393663b5503f7c7b1a686c271ea569efe6" as const;
export const RUNTIME_TRACE_V2_TITLE_ROOT = `${RUNTIME_TRACE_V2_SCENE_ID}/runtime-root:title` as const;
export const RUNTIME_TRACE_V2_BASEL_ROOT = `${RUNTIME_TRACE_V2_SCENE_ID}/runtime-root:basel` as const;
export const RUNTIME_TRACE_V2_GRID_ROOT = `${RUNTIME_TRACE_V2_SCENE_ID}/runtime-root:grid` as const;
export const RUNTIME_TRACE_V2_GRID_TITLE_ROOT = `${RUNTIME_TRACE_V2_SCENE_ID}/runtime-root:grid-title` as const;

const roots = [
  {
    binding: {
      id: "source-binding:a1b835eb80e612c3c14e229911579f5acd96e41cbde381feeafef51d191e2a76",
      name: "title",
      ordinal: 1,
      span: { endColumn: 13, endLine: 20, startColumn: 8, startLine: 20 },
    },
    id: RUNTIME_TRACE_V2_TITLE_ROOT,
    role: "title" as const,
  },
  {
    binding: {
      id: "source-binding:7bbcedf39b0c7451eb6632b82cd1058e6b9bfefc7971e36ad17208dd42610b95",
      name: "basel",
      ordinal: 2,
      span: { endColumn: 13, endLine: 21, startColumn: 8, startLine: 21 },
    },
    id: RUNTIME_TRACE_V2_BASEL_ROOT,
    role: "basel" as const,
  },
  {
    binding: {
      id: "source-binding:b48952e6a49aef4487533c6fe0ac9e5369d91e1ff667e7278d6ba13fe5f685d6",
      name: "grid",
      ordinal: 4,
      span: { endColumn: 12, endLine: 37, startColumn: 8, startLine: 37 },
    },
    id: RUNTIME_TRACE_V2_GRID_ROOT,
    role: "grid" as const,
  },
  {
    binding: {
      id: "source-binding:2302907e0a3c6f84f616012d0d3be6227b9f86336fc370aa6744948be96dd541",
      name: "grid_title",
      ordinal: 5,
      span: { endColumn: 18, endLine: 38, startColumn: 8, startLine: 38 },
    },
    id: RUNTIME_TRACE_V2_GRID_TITLE_ROOT,
    role: "grid-title" as const,
  },
] as const;

function path(index: number) {
  const offset = index / 10;
  const coordinate = canonicalFastManimRuntimeTraceCoordinateV2;
  return {
    subpaths: [
      {
        closed: false,
        segments: [
          {
            control1: { x: coordinate(offset + 0.025), y: 0.05 },
            control2: { x: coordinate(offset + 0.075), y: 0.05 },
            end: { x: coordinate(offset + 0.1), y: 0 },
          },
        ],
        start: { x: coordinate(offset), y: 0 },
      },
    ],
  };
}

const outlineAppearance = {
  fill: { color: { alpha: 0, blue: 1, green: 1, red: 1 }, rule: "nonzero" as const },
  stroke: {
    cap: "butt" as const,
    color: { alpha: 1, blue: 1, green: 1, red: 1 },
    join: "miter" as const,
    miterLimit: 10,
    widthWorld: 0.02,
  },
};

const filledAppearance = {
  fill: { color: { alpha: 1, blue: 1, green: 1, red: 1 }, rule: "nonzero" as const },
  stroke: null,
};

const invisibleFillAppearance = {
  fill: { color: { alpha: 0, blue: 1, green: 1, red: 1 }, rule: "nonzero" as const },
  stroke: null,
};

const gridStrokeAppearance = {
  fill: null,
  stroke: outlineAppearance.stroke,
};

function buildFastManimRuntimeTraceV2Fixture() {
  const runtimeConfig = runtimeTraceV2ConfigFixture();
  const paths = Array.from({ length: 24 }, (_, index) => {
    const value = path(index);
    return { id: `path:${digestFastManimRuntimeTracePathV2(value)}`, path: value };
  });
  const appearances = [outlineAppearance, filledAppearance, invisibleFillAppearance, gridStrokeAppearance].map(
    (value) => ({
      ...value,
      id: `appearance:${digestFastManimRuntimeTraceAppearanceV2(value)}`,
    }),
  );
  const trace = {
    authority: "preview-only" as const,
    camera: runtimeConfig.camera,
    compositing: runtimeConfig.compositing,
    coordinatePrecisionDigits: runtimeConfig.coordinatePrecisionDigits,
    durationSeconds: runtimeConfig.durationSeconds,
    frameCount: 900 as const,
    frameRate: runtimeConfig.frameRate,
    frames: Array.from({ length: 900 }, (_, frameIndex) => {
      const openingTransition = frameIndex < 60;
      const transformProgress =
        frameIndex >= 180 && frameIndex < 240
          ? applyEngineEasingV1({ kind: "manim-smooth" }, (frameIndex - 180) / 60)
          : frameIndex >= 240
            ? 1
            : 0;
      const thirdFadeProgress = Math.min(1, Math.max(0, (frameIndex - 300) / 60));
      const trimEnd = openingTransition ? frameIndex / 60 : 1;
      return {
        draws: Array.from({ length: FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V2 }, (_, paintOrder) => {
          const identity = fastManimRuntimeTraceDrawIdentityV2(RUNTIME_TRACE_V2_SCENE_ID, paintOrder);
          const present = fastManimRuntimeTraceDrawIsPresentV2(frameIndex, paintOrder);
          const title = identity.role === "title";
          const basel = identity.role === "basel";
          const grid = identity.role === "grid";
          const gridTitle = identity.role === "grid-title";
          const appearanceId = grid
            ? appearances[3]!.id
            : appearances[openingTransition && present ? (title ? 0 : 2) : 1]!.id;
          const gridTrim = grid
            ? Math.min(1, Math.max(0, (frameIndex - 300 - identity.order * 4) / (180 - 23 * 4)))
            : 1;
          const opacity = !present
            ? 0
            : basel
              ? canonicalFastManimRuntimeTraceCoordinateV2(1 - transformProgress)
              : title
                ? canonicalFastManimRuntimeTraceCoordinateV2(1 - thirdFadeProgress)
                : gridTitle
                  ? canonicalFastManimRuntimeTraceCoordinateV2(thirdFadeProgress)
                  : 1;
          return {
            appearanceId,
            drawId: identity.drawId,
            familyPath: [...identity.familyPath],
            opacity,
            paintOrder,
            pathId: paths[paintOrder % paths.length]!.id,
            pathTrim: {
              end: canonicalFastManimRuntimeTraceCoordinateV2(!present ? 1 : title ? trimEnd : gridTrim),
              start: 0 as const,
            },
            present,
            rootId: identity.rootId,
            sourceZIndex: 0 as const,
            translation: {
              x: title
                ? canonicalFastManimRuntimeTraceCoordinateV2(transformProgress)
                : grid || gridTitle
                  ? 0
                  : canonicalFastManimRuntimeTraceCoordinateV2(openingTransition ? frameIndex / 60 : 1),
              y: basel
                ? canonicalFastManimRuntimeTraceCoordinateV2(-transformProgress)
                : gridTitle
                  ? canonicalFastManimRuntimeTraceCoordinateV2(thirdFadeProgress)
                  : 0,
            },
          };
        }),
        frameIndex,
      };
    }),
    producer: {
      fastManimCommit: "0".repeat(40),
      fastManimTree: "1".repeat(40),
      geometryResourceSha256: FAST_MANIM_RUNTIME_TRACE_GEOMETRY_RESOURCE_HASH_V2,
      manimVersion: "0.17.3",
      semanticsSha256: "0".repeat(64),
      texFontBundleSha256: FAST_MANIM_RUNTIME_TRACE_TEX_FONT_BUNDLE_HASH_V2,
      texToolchainSha256: FAST_MANIM_RUNTIME_TRACE_TEX_TOOLCHAIN_HASH_V2,
    },
    profileVersion: 2 as const,
    projectId: "demo",
    requestId: "req-opening-runtime-trace-v2",
    resources: { appearances, paths },
    roots: roots.map((root) => ({
      ...root,
      binding: { ...root.binding, span: { ...root.binding.span } },
    })),
    runtimeConfigHash: RUNTIME_TRACE_V2_CONFIG_HASH,
    samplePhase: runtimeConfig.samplePhase,
    sceneId: RUNTIME_TRACE_V2_SCENE_ID,
    sceneName: RUNTIME_TRACE_V2_SCENE_NAME,
    sceneOccurrence: RUNTIME_TRACE_V2_SCENE_OCCURRENCE,
    schema: FAST_MANIM_RUNTIME_TRACE_SCHEMA_V2,
    sourceHash: RUNTIME_TRACE_V2_SOURCE_HASH,
    sourcePath: RUNTIME_TRACE_V2_SOURCE_PATH,
    version: 2 as const,
  };
  trace.producer.semanticsSha256 = digestFastManimRuntimeTraceVisualSemanticsV2(trace);
  return trace;
}

export type FastManimRuntimeTraceV2Fixture = ReturnType<typeof buildFastManimRuntimeTraceV2Fixture>;

// Building this 900-frame fixture also seals its complete visual semantics.
// Lazily keep one immutable-by-convention template per Vitest worker and clone
// it for each test so mutation-focused contract cases do not repeatedly
// regenerate and hash the same 87,300 draws. Laziness matters because smaller
// request-contract tests import this module without using the result fixture.
let fastManimRuntimeTraceV2FixtureTemplate: FastManimRuntimeTraceV2Fixture | undefined;

export function fastManimRuntimeTraceV2Fixture() {
  fastManimRuntimeTraceV2FixtureTemplate ??= buildFastManimRuntimeTraceV2Fixture();
  return structuredClone(fastManimRuntimeTraceV2FixtureTemplate);
}

export function sealFastManimRuntimeTraceV2Fixture(trace: FastManimRuntimeTraceV2Fixture) {
  trace.producer.semanticsSha256 = digestFastManimRuntimeTraceVisualSemanticsV2(trace);
  return trace;
}

/** Test-only counterpart of the bounded JSON parser for generated fixtures. */
export function parseSelfSealedFastManimRuntimeTraceV2Fixture(trace: unknown) {
  return fastManimRuntimeTraceV2Schema.parse(trace) as SelfSealedFastManimRuntimeTraceV2;
}

export function expectedRuntimeTraceV2Correlation(
  trace = fastManimRuntimeTraceV2Fixture(),
): ExpectedFastManimRuntimeTraceCorrelationV2 {
  return {
    camera: trace.camera,
    producer: trace.producer,
    projectId: trace.projectId,
    requestId: trace.requestId,
    roots: trace.roots,
    runtimeConfigHash: trace.runtimeConfigHash,
    sceneId: trace.sceneId,
    sceneName: trace.sceneName,
    sceneOccurrence: trace.sceneOccurrence,
    sourceHash: trace.sourceHash,
    sourcePath: trace.sourcePath,
  };
}
