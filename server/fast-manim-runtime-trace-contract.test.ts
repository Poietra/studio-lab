import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  canonicalFastManimRuntimeTraceCoordinateV1,
  digestFastManimRuntimeTraceAppearanceV1,
  digestFastManimRuntimeTracePathV1,
  digestFastManimRuntimeTraceV1,
  digestFastManimRuntimeTraceVisualSemanticsV1,
  expectedFastManimRuntimeTraceCorrelationFromRequestV1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V1,
  fastManimRuntimeTraceConfigV1Schema,
  fastManimRuntimeTraceFrameIndexAtTimeV1,
  fastManimRuntimeTraceV1Schema,
  fastManimRuntimeTraceWorldPositionV1,
  MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1,
  parseFastManimRuntimeTraceProducerJsonV1,
  parseFastManimRuntimeTraceProducerRequestJsonV1,
} from "./fast-manim-runtime-trace-contract";
import {
  expectedRuntimeTraceCorrelation,
  RUNTIME_TRACE_GLYPH_HASH,
  runtimeTraceFixture,
  runtimeTraceRequestFixture,
  runtimeTraceSegment,
  sealRuntimeTraceFixture,
  trustedRuntimeTraceProducer,
} from "./test-fixtures/fast-manim-runtime-trace-fixture";

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("fast-manim Runtime Trace V1 contract", () => {
  it("derives and validates the producer request correlation", () => {
    const request = runtimeTraceRequestFixture();
    expect(request.runtimeConfigHash).toBe("9b69b6296dc706b1deebbc1d9f88b05ef2f97aa9acf1e87eae9a8efd13b33c97");
    expect(request.sceneId).toBe("scene:89e99799b8a4df781a0ee4dca3b92211b28cdfb690324a33df5917a457842128");
    expect(parseFastManimRuntimeTraceProducerRequestJsonV1(canonicalJsonV1(request))).toEqual(request);
    expect(expectedFastManimRuntimeTraceCorrelationFromRequestV1(request, trustedRuntimeTraceProducer())).toEqual(
      expectedRuntimeTraceCorrelation(),
    );

    for (const changed of [
      { ...request, sourceHash: RUNTIME_TRACE_GLYPH_HASH },
      { ...request, sceneId: "scene:substituted" },
      { ...request, runtimeConfigHash: RUNTIME_TRACE_GLYPH_HASH },
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

    const escapedSourceRequest = runtimeTraceRequestFixture(`#${"\\".repeat(1_100_000)}\n`);
    const escapedSourceJson = canonicalJsonV1(escapedSourceRequest);
    expect(Buffer.byteLength(escapedSourceJson, "utf8")).toBeGreaterThan(2 * 1024 * 1024 + 64 * 1024);
    expect(parseFastManimRuntimeTraceProducerRequestJsonV1(escapedSourceJson).sourceHash).toBe(
      escapedSourceRequest.sourceHash,
    );
  });

  it("matches the producer's exact camera and source-occurrence bounds", () => {
    const request = runtimeTraceRequestFixture();
    for (const camera of [
      { ...request.runtimeConfig.camera, frameHeight: 9 },
      { ...request.runtimeConfig.camera, frameWidth: 16 },
      { ...request.runtimeConfig.camera, center: { x: 0.25, y: 0 } },
      { ...request.runtimeConfig.camera, background: { ...request.runtimeConfig.camera.background, red: 0.25 } },
    ]) {
      expect(fastManimRuntimeTraceConfigV1Schema.safeParse({ ...request.runtimeConfig, camera }).success).toBe(false);
    }

    expect(() =>
      parseFastManimRuntimeTraceProducerRequestJsonV1(
        canonicalJsonV1({ ...request, sceneOccurrence: { ...request.sceneOccurrence, constructStartLine: 10_001 } }),
      ),
    ).toThrowError(/request is invalid/);
  });

  it("accepts one complete preview-only 60 fps trace and produces a stable digest", () => {
    const trace = runtimeTraceFixture();
    const parsed = parseFastManimRuntimeTraceProducerJsonV1(
      canonicalJsonV1(trace),
      expectedRuntimeTraceCorrelation(trace),
    );

    expect(parsed.frames).toHaveLength(360);
    expect(parsed.frames[150]?.draws).toHaveLength(10);
    expect(parsed.roots.map(({ role }) => role)).toEqual(["square", "decimal"]);
    expect(digestFastManimRuntimeTraceV1(parsed)).toBe(
      digestFastManimRuntimeTraceV1(fastManimRuntimeTraceV1Schema.parse(trace)),
    );
  });

  it("matches Python resource and visual-semantics digest goldens", () => {
    const trace = runtimeTraceFixture();
    expect(digestFastManimRuntimeTracePathV1(trace.resources.paths[0].path)).toBe(
      "0831c3ce008105c35bd2177d825e833e652c7f39b4cdcec7cc5f8335aea220b0",
    );
    expect(
      digestFastManimRuntimeTraceAppearanceV1({
        fill: trace.resources.appearances[0].fill,
        stroke: trace.resources.appearances[0].stroke,
      }),
    ).toBe("142dd022a18fb23248b2a4cccdff797ef4e9f77fa0a9d7a7deffe9b107b82ff7");

    trace.frames.forEach((frame, frameIndex) => {
      frame.motionY = canonicalFastManimRuntimeTraceCoordinateV1(frameIndex < 300 ? frameIndex / 300 : 1);
    });
    expect(digestFastManimRuntimeTraceVisualSemanticsV1(trace)).toBe(
      "0fc7b20c2f452aca2c9a1ca70a698612b1c4d01a544ee6809a418996561e4de7",
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
    const trace = runtimeTraceFixture();
    const expected = expectedRuntimeTraceCorrelation(trace);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV1(canonicalJsonV1(trace), {
        ...expected,
        sourceHash: RUNTIME_TRACE_GLYPH_HASH,
      }),
    ).toThrowError(/stale sourceHash correlation/);

    const substituted = clone(trace);
    substituted.roots[1].binding.id = "source-binding:substituted";
    sealRuntimeTraceFixture(substituted);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV1(canonicalJsonV1(substituted), {
        ...expected,
        producer: substituted.producer,
      }),
    ).toThrowError(/stale roots correlation/);
  });

  it("rejects gaps, reordered paint, missing resources, wrong family identity, and a changed terminal hold", () => {
    const trace = runtimeTraceFixture();
    const mutations = [
      (value: ReturnType<typeof runtimeTraceFixture>) => {
        value.frames[10].frameIndex = 11;
      },
      (value: ReturnType<typeof runtimeTraceFixture>) => {
        value.frames[10].draws[0].paintOrder = 1;
      },
      (value: ReturnType<typeof runtimeTraceFixture>) => {
        value.frames[10].draws[0].pathId = "path:missing";
      },
      (value: ReturnType<typeof runtimeTraceFixture>) => {
        value.frames[10].draws[1].familyPath = [1, 0, 0];
      },
      (value: ReturnType<typeof runtimeTraceFixture>) => {
        value.frames[359].motionY = 2;
      },
      (value: ReturnType<typeof runtimeTraceFixture>) => {
        value.frames[10].draws[0].localPosition.x = 1_000_000_000;
      },
      (value: ReturnType<typeof runtimeTraceFixture>) => {
        (value.frames[10].draws[0] as { sourceZIndex: number }).sourceZIndex = 1;
      },
    ];

    for (const mutate of mutations) {
      const changed = clone(trace);
      mutate(changed);
      sealRuntimeTraceFixture(changed);
      expect(() =>
        parseFastManimRuntimeTraceProducerJsonV1(canonicalJsonV1(changed), expectedRuntimeTraceCorrelation(trace)),
      ).toThrowError(/violates its closed contract/);
    }
  });

  it("bounds interned geometry and raw producer bytes", () => {
    const trace = runtimeTraceFixture();
    trace.resources.paths[0].path.subpaths[0].segments = Array.from(
      { length: MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V1 + 1 },
      (_, index) => runtimeTraceSegment(index),
    );
    expect(fastManimRuntimeTraceV1Schema.safeParse(trace).success).toBe(false);

    const nonCanonicalPath = runtimeTraceFixture();
    nonCanonicalPath.resources.paths[0].path.subpaths[0].segments[0].control1.x = 1 / 3;
    expect(fastManimRuntimeTraceV1Schema.safeParse(nonCanonicalPath).success).toBe(false);

    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV1(
        " ".repeat(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 + 1),
        expectedRuntimeTraceCorrelation(),
      ),
    ).toThrowError(/results accept at most/);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV1(
        JSON.stringify({ frames: Array.from({ length: 4_097 }, () => null) }),
        expectedRuntimeTraceCorrelation(),
      ),
    ).toThrowError(/oversized array/);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV1(new Uint8Array([0xff]), expectedRuntimeTraceCorrelation()),
    ).toThrowError(/not UTF-8/);
    expect(() => parseFastManimRuntimeTraceProducerJsonV1("{", expectedRuntimeTraceCorrelation())).toThrowError(
      /malformed JSON/,
    );
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
