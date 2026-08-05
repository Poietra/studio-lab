import { createHash } from "node:crypto";

import { applyEngineEasingV1 } from "../../src/engine/easing";
import {
  canonicalFastManimRuntimeTraceCoordinateV1,
  digestFastManimRuntimeTraceConfigV1,
  type ExpectedFastManimRuntimeTraceCorrelationV1,
  FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1,
  FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
  FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1,
  fastManimRuntimeTraceSceneIdV1,
} from "../fast-manim-runtime-trace-contract";

export const RUNTIME_TRACE_SOURCE_HASH = "a".repeat(64);
export const RUNTIME_TRACE_CONFIG_HASH = "b".repeat(64);
export const RUNTIME_TRACE_GLYPH_HASH = "c".repeat(64);
export const RUNTIME_TRACE_SQUARE_ROOT = "scene:updaters/runtime-root:square";
export const RUNTIME_TRACE_DECIMAL_ROOT = "scene:updaters/runtime-root:decimal";

const DECIMAL_FAMILY_PATHS = [
  [0, 0, 0],
  [1, 0, 0],
  [2, 0, 0],
  [3, 0, 0],
  [4, 0, 0],
  [5, 0, 0],
  [6, 0],
  [6, 1],
  [6, 2],
] as const;

function bindingId(name: string, ordinal: number, span: Readonly<Record<string, number>>) {
  const payload = [
    "poietra.fast-manim-source-runtime-identity",
    "1",
    RUNTIME_TRACE_SOURCE_HASH,
    "scene:updaters",
    name,
    String(ordinal),
    String(span.startLine),
    String(span.startColumn),
    String(span.endLine),
    String(span.endColumn),
  ].join("\0");
  return `source-binding:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

export function runtimeTraceSegment(offset = 0) {
  return {
    control1: { x: offset, y: 0 },
    control2: { x: offset + 0.5, y: 1 },
    end: { x: offset + 1, y: 0 },
  };
}

function path(offset = 0) {
  return {
    subpaths: [
      {
        closed: false,
        segments: [runtimeTraceSegment(offset)],
        start: { x: offset, y: 0 },
      },
    ],
  };
}

function roots() {
  const squareSpan = { endColumn: 14, endLine: 120, startColumn: 8, startLine: 120 };
  const decimalSpan = { endColumn: 15, endLine: 114, startColumn: 8, startLine: 114 };
  return [
    {
      anchor: "center" as const,
      binding: { id: bindingId("square", 2, squareSpan), name: "square", ordinal: 2, span: squareSpan },
      id: RUNTIME_TRACE_SQUARE_ROOT,
      offset: { x: 0, y: 0 },
      role: "square" as const,
    },
    {
      anchor: "left-center" as const,
      binding: { id: bindingId("decimal", 1, decimalSpan), name: "decimal", ordinal: 1, span: decimalSpan },
      id: RUNTIME_TRACE_DECIMAL_ROOT,
      offset: { x: 1.25, y: 0 },
      role: "decimal" as const,
    },
  ];
}

function draw(rootId: string, familyPath: readonly number[], paintOrder: number) {
  return {
    appearanceId: "appearance:white",
    familyPath: [...familyPath],
    localPosition: {
      x: rootId === RUNTIME_TRACE_DECIMAL_ROOT ? canonicalFastManimRuntimeTraceCoordinateV1((paintOrder - 1) * 0.4) : 0,
      y: 0,
    },
    opacity: 1,
    paintOrder,
    pathId: rootId === RUNTIME_TRACE_SQUARE_ROOT ? "path:square" : "path:glyph",
    rootId,
    sourceZIndex: 0,
  };
}

function officialMotionY(frameIndex: number) {
  if (frameIndex > 300) return 2.5;
  const firstHalf = frameIndex <= 150;
  const progress = firstHalf ? frameIndex / 150 : (frameIndex - 150) / 150;
  const eased = applyEngineEasingV1({ kind: "manim-smooth" }, progress);
  return canonicalFastManimRuntimeTraceCoordinateV1(firstHalf ? 2.5 - 5 * eased : -2.5 + 5 * eased);
}

export function runtimeTraceFixture() {
  const traceRoots = roots();
  return {
    authority: "preview-only" as const,
    camera: {
      background: { alpha: 1, blue: 0, green: 0, red: 0 },
      center: { x: 0, y: 0 },
      frameHeight: 8,
      frameWidth: 14.222222222222221,
    },
    compositing: "manim-cairo-srgb" as const,
    coordinatePrecisionDigits: FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1,
    durationSeconds: FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
    frameCount: FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1,
    frameRate: FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
    frames: Array.from({ length: FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1 }, (_, frameIndex) => ({
      draws: [
        draw(RUNTIME_TRACE_SQUARE_ROOT, [], 0),
        ...DECIMAL_FAMILY_PATHS.map((familyPath, index) => draw(RUNTIME_TRACE_DECIMAL_ROOT, familyPath, index + 1)),
      ],
      frameIndex,
      motionY: officialMotionY(frameIndex),
    })),
    producer: {
      fastManimCommit: "1".repeat(40),
      fastManimTree: "2".repeat(40),
      glyphProviderSha256: RUNTIME_TRACE_GLYPH_HASH,
      manimVersion: "0.17.3",
      semanticsSha256: RUNTIME_TRACE_CONFIG_HASH,
    },
    projectId: "demo",
    requestId: "req-runtime-trace-1",
    resources: {
      appearances: [
        {
          fill: { color: { alpha: 1, blue: 1, green: 1, red: 1 }, rule: "nonzero" as const },
          id: "appearance:white",
          stroke: null,
        },
      ],
      paths: [
        { id: "path:square", path: path() },
        { id: "path:glyph", path: path(2) },
      ],
    },
    roots: traceRoots,
    runtimeConfigHash: RUNTIME_TRACE_CONFIG_HASH,
    sceneId: "scene:updaters",
    sceneName: "UpdatersExample",
    sceneOccurrence: { constructStartLine: 113, definitionOrdinal: 5 },
    schema: "poietra.fast-manim-runtime-trace" as const,
    samplePhase: FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1,
    sourceHash: RUNTIME_TRACE_SOURCE_HASH,
    sourcePath: "example_scenes/basic.py",
    version: 1 as const,
  };
}

export function expectedRuntimeTraceCorrelation(
  trace = runtimeTraceFixture(),
): ExpectedFastManimRuntimeTraceCorrelationV1 {
  return {
    camera: trace.camera,
    producer: trace.producer,
    projectId: trace.projectId,
    requestId: trace.requestId,
    roots: [...trace.roots],
    runtimeConfigHash: trace.runtimeConfigHash,
    sceneId: trace.sceneId,
    sceneName: trace.sceneName,
    sceneOccurrence: trace.sceneOccurrence,
    sourceHash: trace.sourceHash,
    sourcePath: trace.sourcePath,
  };
}

export function runtimeTraceRequestFixture(
  sourceText = "from manim import *\n\nclass UpdatersExample(Scene):\n    def construct(self):\n        pass\n",
) {
  const runtimeConfig = {
    camera: runtimeTraceFixture().camera,
    compositing: "manim-cairo-srgb" as const,
    coordinatePrecisionDigits: FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1,
    durationSeconds: 6 as const,
    frameRate: 60 as const,
    profileVersion: 1 as const,
    randomSeed: 0 as const,
    samplePhase: FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1,
    schema: "poietra.fast-manim-runtime-trace-config" as const,
    version: 1 as const,
  };
  const sourcePath = "example_scenes/basic.py";
  const sceneName = "UpdatersExample";
  return {
    profileVersion: 1 as const,
    projectId: "demo",
    requestId: "req-runtime-trace-1",
    runtimeConfig,
    runtimeConfigHash: digestFastManimRuntimeTraceConfigV1(runtimeConfig),
    sceneId: fastManimRuntimeTraceSceneIdV1(sourcePath, sceneName),
    sceneName,
    sceneOccurrence: { constructStartLine: 4, definitionOrdinal: 1 },
    schema: "poietra.fast-manim-runtime-trace-producer-request" as const,
    sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    sourcePath,
    sourceText,
    version: 1 as const,
  };
}
