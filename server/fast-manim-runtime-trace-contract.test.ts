import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  canonicalFastManimRuntimeTraceCoordinateV1,
  digestFastManimRuntimeTraceConfigV1,
  digestFastManimRuntimeTraceV1,
  type ExpectedFastManimRuntimeTraceCorrelationV1,
  FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V1,
  FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
  FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1,
  fastManimRuntimeTraceFrameIndexAtTimeV1,
  fastManimRuntimeTraceSceneIdV1,
  fastManimRuntimeTraceV1Schema,
  fastManimRuntimeTraceWorldPositionV1,
  MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1,
  parseFastManimRuntimeTraceProducerJsonV1,
  parseFastManimRuntimeTraceProducerRequestJsonV1,
} from "./fast-manim-runtime-trace-contract";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SQUARE_ROOT = "scene:updaters/runtime-root:square";
const DECIMAL_ROOT = "scene:updaters/runtime-root:decimal";
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
    SHA_A,
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

function segment(offset = 0) {
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
        segments: [segment(offset)],
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
      binding: {
        id: bindingId("square", 2, squareSpan),
        name: "square",
        ordinal: 2,
        span: squareSpan,
      },
      id: SQUARE_ROOT,
      offset: { x: 0, y: 0 },
      role: "square" as const,
    },
    {
      anchor: "left-center" as const,
      binding: {
        id: bindingId("decimal", 1, decimalSpan),
        name: "decimal",
        ordinal: 1,
        span: decimalSpan,
      },
      id: DECIMAL_ROOT,
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
      x: rootId === DECIMAL_ROOT ? canonicalFastManimRuntimeTraceCoordinateV1((paintOrder - 1) * 0.4) : 0,
      y: 0,
    },
    opacity: 1,
    paintOrder,
    pathId: rootId === SQUARE_ROOT ? "path:square" : "path:glyph",
    rootId,
    sourceZIndex: 0,
  };
}

function fixture() {
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
    frames: Array.from({ length: FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1 }, (_, frameIndex) => {
      const translation = frameIndex < 300 ? frameIndex / 300 : 1;
      return {
        draws: [
          draw(SQUARE_ROOT, [], 0),
          ...DECIMAL_FAMILY_PATHS.map((familyPath, index) => draw(DECIMAL_ROOT, familyPath, index + 1)),
        ],
        frameIndex,
        motionY: canonicalFastManimRuntimeTraceCoordinateV1(translation),
      };
    }),
    producer: {
      fastManimCommit: "1".repeat(40),
      fastManimTree: "2".repeat(40),
      glyphProviderSha256: SHA_C,
      manimVersion: "0.17.3",
      semanticsSha256: SHA_B,
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
    runtimeConfigHash: SHA_B,
    sceneId: "scene:updaters",
    sceneName: "UpdatersExample",
    sceneOccurrence: { constructStartLine: 113, definitionOrdinal: 5 },
    schema: "poietra.fast-manim-runtime-trace" as const,
    samplePhase: FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V1,
    sourceHash: SHA_A,
    sourcePath: "example_scenes/basic.py",
    version: 1 as const,
  };
}

function expected(trace = fixture()): ExpectedFastManimRuntimeTraceCorrelationV1 {
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

function requestFixture(
  sourceText = "from manim import *\n\nclass UpdatersExample(Scene):\n    def construct(self):\n        pass\n",
) {
  const runtimeConfig = {
    camera: fixture().camera,
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("fast-manim Runtime Trace V1 contract", () => {
  it("derives and validates the producer request correlation", () => {
    const request = requestFixture();
    expect(request.runtimeConfigHash).toBe("9b69b6296dc706b1deebbc1d9f88b05ef2f97aa9acf1e87eae9a8efd13b33c97");
    expect(request.sceneId).toBe("scene:89e99799b8a4df781a0ee4dca3b92211b28cdfb690324a33df5917a457842128");
    expect(parseFastManimRuntimeTraceProducerRequestJsonV1(canonicalJsonV1(request))).toEqual(request);

    for (const changed of [
      { ...request, sourceHash: SHA_C },
      { ...request, sceneId: "scene:substituted" },
      { ...request, runtimeConfigHash: SHA_C },
    ]) {
      expect(() => parseFastManimRuntimeTraceProducerRequestJsonV1(canonicalJsonV1(changed))).toThrowError(
        /request is invalid/,
      );
    }
    expect(() =>
      parseFastManimRuntimeTraceProducerRequestJsonV1(
        " ".repeat(MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1 + 1),
      ),
    ).toThrowError(/requests accept at most/);

    const escapedSourceRequest = requestFixture(`#${"\\".repeat(1_100_000)}\n`);
    const escapedSourceJson = canonicalJsonV1(escapedSourceRequest);
    expect(Buffer.byteLength(escapedSourceJson, "utf8")).toBeGreaterThan(2 * 1024 * 1024 + 64 * 1024);
    expect(parseFastManimRuntimeTraceProducerRequestJsonV1(escapedSourceJson).sourceHash).toBe(
      escapedSourceRequest.sourceHash,
    );
  });

  it("accepts one complete preview-only 60 fps trace and produces a stable digest", () => {
    const trace = fixture();
    const parsed = parseFastManimRuntimeTraceProducerJsonV1(canonicalJsonV1(trace), expected(trace));

    expect(parsed.frames).toHaveLength(360);
    expect(parsed.frames[150]?.draws).toHaveLength(10);
    expect(parsed.roots.map(({ role }) => role)).toEqual(["square", "decimal"]);
    expect(digestFastManimRuntimeTraceV1(parsed)).toBe(
      digestFastManimRuntimeTraceV1(fastManimRuntimeTraceV1Schema.parse(trace)),
    );
  });

  it("defines floor-based frame selection and retains the duration endpoint", () => {
    for (let frameIndex = 0; frameIndex < FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1; frameIndex += 1) {
      expect(fastManimRuntimeTraceFrameIndexAtTimeV1(frameIndex / 60)).toBe(frameIndex);
      expect(fastManimRuntimeTraceFrameIndexAtTimeV1(frameIndex * (1 / 60))).toBe(frameIndex);
    }
    expect(fastManimRuntimeTraceFrameIndexAtTimeV1(0)).toBe(0);
    expect(fastManimRuntimeTraceFrameIndexAtTimeV1(1 / 60 - Number.EPSILON)).toBe(0);
    expect(fastManimRuntimeTraceFrameIndexAtTimeV1(1 / 60)).toBe(1);
    expect(fastManimRuntimeTraceFrameIndexAtTimeV1(5)).toBe(300);
    expect(fastManimRuntimeTraceFrameIndexAtTimeV1(6)).toBe(359);
    expect(() => fastManimRuntimeTraceFrameIndexAtTimeV1(-1)).toThrowError(/inside the six-second Scene/);
    expect(() => fastManimRuntimeTraceFrameIndexAtTimeV1(Number.NaN)).toThrowError(/inside the six-second Scene/);
    expect(() => fastManimRuntimeTraceFrameIndexAtTimeV1(6.001)).toThrowError(/inside the six-second Scene/);
  });

  it("rejects stale correlation and source-root identity substitution", () => {
    const trace = fixture();
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV1(canonicalJsonV1(trace), { ...expected(trace), sourceHash: SHA_C }),
    ).toThrowError(/stale sourceHash correlation/);

    const substituted = clone(trace);
    substituted.roots[1].binding.id = "source-binding:substituted";
    expect(() => parseFastManimRuntimeTraceProducerJsonV1(canonicalJsonV1(substituted), expected(trace))).toThrowError(
      /stale roots correlation/,
    );
  });

  it("rejects gaps, reordered paint, missing resources, wrong family identity, and a changed terminal hold", () => {
    const trace = fixture();
    const mutations = [
      (value: ReturnType<typeof fixture>) => {
        value.frames[10].frameIndex = 11;
      },
      (value: ReturnType<typeof fixture>) => {
        value.frames[10].draws[0].paintOrder = 1;
      },
      (value: ReturnType<typeof fixture>) => {
        value.frames[10].draws[0].pathId = "path:missing";
      },
      (value: ReturnType<typeof fixture>) => {
        value.frames[10].draws[1].familyPath = [1, 0, 0];
      },
      (value: ReturnType<typeof fixture>) => {
        value.frames[359].motionY = 2;
      },
      (value: ReturnType<typeof fixture>) => {
        value.frames[10].draws[0].localPosition.x = 1_000_000_000;
      },
      (value: ReturnType<typeof fixture>) => {
        value.frames[10].draws[0].sourceZIndex = 1;
      },
    ];

    for (const mutate of mutations) {
      const changed = clone(trace);
      mutate(changed);
      expect(() => parseFastManimRuntimeTraceProducerJsonV1(canonicalJsonV1(changed), expected(trace))).toThrowError(
        /violates its closed contract/,
      );
    }
  });

  it("bounds interned geometry and raw producer bytes", () => {
    const trace = fixture();
    trace.resources.paths[0].path.subpaths[0].segments = Array.from(
      { length: MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1 + 1 },
      (_, index) => segment(index),
    );
    expect(fastManimRuntimeTraceV1Schema.safeParse(trace).success).toBe(false);

    const nonCanonicalPath = fixture();
    nonCanonicalPath.resources.paths[0].path.subpaths[0].segments[0].control1.x = 1 / 3;
    expect(fastManimRuntimeTraceV1Schema.safeParse(nonCanonicalPath).success).toBe(false);

    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV1(" ".repeat(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 + 1), expected()),
    ).toThrowError(/results accept at most/);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV1(
        JSON.stringify({ frames: Array.from({ length: 4_097 }, () => null) }),
        expected(),
      ),
    ).toThrowError(/oversized array/);
    expect(() => parseFastManimRuntimeTraceProducerJsonV1(new Uint8Array([0xff]), expected())).toThrowError(
      /not UTF-8/,
    );
    expect(() => parseFastManimRuntimeTraceProducerJsonV1("{", expected())).toThrowError(/malformed JSON/);
  });

  it("defines root-local world positioning and ECMAScript half-away coordinate rounding", () => {
    expect(canonicalFastManimRuntimeTraceCoordinateV1(1 / 2 ** 14)).toBe(0.0000610351563);
    expect(canonicalFastManimRuntimeTraceCoordinateV1(-1 / 2 ** 14)).toBe(-0.0000610351563);
    expect(fastManimRuntimeTraceWorldPositionV1(2.5, { x: 1.25, y: 0 }, { x: 0.4, y: 0 })).toEqual({
      x: 1.65,
      y: 2.5,
    });
  });
});
