import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  digestFastManimRuntimeTraceV1,
  type ExpectedFastManimRuntimeTraceCorrelationV1,
  FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
  fastManimRuntimeTraceFrameIndexAtTimeV1,
  fastManimRuntimeTraceV1Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1,
  parseFastManimRuntimeTraceProducerJsonV1,
} from "./fast-manim-runtime-trace-contract";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SQUARE_ROOT = "scene:updaters/runtime-root:square";
const DECIMAL_ROOT = "scene:updaters/runtime-root:decimal";
const IDENTITY = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 } as const;

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
  return [
    {
      binding: {
        id: "source-binding:square",
        name: "square",
        ordinal: 2,
        span: { endColumn: 17, endLine: 120, startColumn: 8, startLine: 120 },
      },
      id: SQUARE_ROOT,
      role: "square" as const,
    },
    {
      binding: {
        id: "source-binding:decimal",
        name: "decimal",
        ordinal: 1,
        span: { endColumn: 9, endLine: 113, startColumn: 8, startLine: 113 },
      },
      id: DECIMAL_ROOT,
      role: "decimal" as const,
    },
  ];
}

function draw(rootId: string, slot: number, paintOrder: number) {
  return {
    appearanceId: "appearance:white",
    localTransform: { ...IDENTITY, tx: rootId === DECIMAL_ROOT ? slot * 0.4 : 0 },
    opacity: 1,
    paintOrder,
    pathId: rootId === SQUARE_ROOT ? "path:square" : "path:glyph",
    rootId,
    slot,
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
    durationSeconds: FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V1,
    frameCount: FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1,
    frameRate: FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
    frames: Array.from({ length: FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1 }, (_, frameIndex) => {
      const translation = frameIndex < 300 ? frameIndex / 300 : 1;
      return {
        draws: [draw(SQUARE_ROOT, 0, 0), ...Array.from({ length: 7 }, (_, slot) => draw(DECIMAL_ROOT, slot, slot + 1))],
        frameIndex,
        rootTransforms: [
          { rootId: SQUARE_ROOT, transform: { ...IDENTITY, ty: translation } },
          { rootId: DECIMAL_ROOT, transform: { ...IDENTITY, tx: 3, ty: translation } },
        ],
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("fast-manim Runtime Trace V1 contract", () => {
  it("accepts one complete preview-only 60 fps trace and produces a stable digest", () => {
    const trace = fixture();
    const parsed = parseFastManimRuntimeTraceProducerJsonV1(canonicalJsonV1(trace), expected(trace));

    expect(parsed.frames).toHaveLength(360);
    expect(parsed.frames[150]?.draws).toHaveLength(8);
    expect(parsed.roots.map(({ role }) => role)).toEqual(["square", "decimal"]);
    expect(digestFastManimRuntimeTraceV1(parsed)).toBe(
      digestFastManimRuntimeTraceV1(fastManimRuntimeTraceV1Schema.parse(trace)),
    );
  });

  it("defines floor-based frame selection and retains the duration endpoint", () => {
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

  it("rejects gaps, reordered paint, missing resources, duplicate slots, and a changed terminal hold", () => {
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
        value.frames[10].draws[1].slot = 1;
      },
      (value: ReturnType<typeof fixture>) => {
        value.frames[359].rootTransforms[0].transform.ty = 2;
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

    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV1(" ".repeat(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 + 1), expected()),
    ).toThrowError(/accepts at most/);
    expect(() => parseFastManimRuntimeTraceProducerJsonV1(new Uint8Array([0xff]), expected())).toThrowError(
      /not UTF-8/,
    );
    expect(() => parseFastManimRuntimeTraceProducerJsonV1("{", expected())).toThrowError(/malformed JSON/);
  });
});
