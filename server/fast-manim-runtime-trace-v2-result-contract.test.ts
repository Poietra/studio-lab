import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  digestFastManimRuntimeTraceAppearanceV2,
  digestFastManimRuntimeTracePathV2,
  digestFastManimRuntimeTraceV2,
  FAST_MANIM_RUNTIME_TRACE_GRID_TITLE_EXTENSION_SLOTS_V2,
  FAST_MANIM_RUNTIME_TRACE_GRID_TITLE_UNION_IDENTITY_ORDERS_V2,
  FastManimRuntimeTraceV2ContractError,
  fastManimRuntimeTraceDrawIsPresentV2,
  fastManimRuntimeTraceV2Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V2,
  parseFastManimRuntimeTraceProducerJsonV2,
} from "./fast-manim-runtime-trace-v2-result-contract";
import {
  expectedRuntimeTraceV2Correlation,
  fastManimRuntimeTraceV2Fixture,
  sealFastManimRuntimeTraceV2Fixture,
} from "./test-fixtures/fast-manim-runtime-trace-v2-fixture";

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("fast-manim Runtime Trace V2 result contract", () => {
  it("accepts a compact sealed fixture and produces a stable trace digest", { timeout: 30_000 }, () => {
    const trace = fastManimRuntimeTraceV2Fixture();
    const parsed = parseFastManimRuntimeTraceProducerJsonV2(
      canonicalJsonV1(trace),
      expectedRuntimeTraceV2Correlation(trace),
    );

    expect(parsed.resources.paths).toHaveLength(24);
    expect(parsed.frames[0]?.draws).toHaveLength(97);
    expect(digestFastManimRuntimeTraceV2(parsed)).toBe(digestFastManimRuntimeTraceV2(trace));
  });

  it("preserves the original grid-title identities while admitting final Transform extensions", () => {
    const trace = fastManimRuntimeTraceV2Fixture();
    const gridTitleOffset = 55;
    const originalSlots = [0, 4, 8, 12, 16, 20, 23, 27, 31, 35, 39];
    expect(
      trace.frames[0]?.draws.slice(gridTitleOffset).map((draw) => ({
        familyPath: draw.familyPath,
        identityOrder: Number(draw.drawId.split(":").at(-1)),
      })),
    ).toEqual(
      FAST_MANIM_RUNTIME_TRACE_GRID_TITLE_UNION_IDENTITY_ORDERS_V2.map((identityOrder, slot) => ({
        familyPath: [0, slot],
        identityOrder,
      })),
    );
    expect(
      FAST_MANIM_RUNTIME_TRACE_GRID_TITLE_UNION_IDENTITY_ORDERS_V2.flatMap((identityOrder, slot) =>
        identityOrder < 11 ? [slot] : [],
      ),
    ).toEqual(originalSlots);
    expect(FAST_MANIM_RUNTIME_TRACE_GRID_TITLE_EXTENSION_SLOTS_V2).toEqual(
      FAST_MANIM_RUNTIME_TRACE_GRID_TITLE_UNION_IDENTITY_ORDERS_V2.flatMap((identityOrder, slot) =>
        identityOrder >= 11 ? [slot] : [],
      ),
    );
    expect(
      [779, 780].map(
        (frameIndex) => trace.frames[frameIndex]!.draws.slice(gridTitleOffset).filter(({ present }) => present).length,
      ),
    ).toEqual([11, 42]);
    expect(
      [779, 780].map((frameIndex) =>
        trace.frames[frameIndex]!.draws.every(
          (draw, drawIndex) => draw.present === fastManimRuntimeTraceDrawIsPresentV2(frameIndex, drawIndex),
        ),
      ),
    ).toEqual([true, true]);
    expect(trace.frames[720]!.draws).toEqual(trace.frames[779]!.draws);
    expect(trace.frames[840]!.draws).toEqual(trace.frames[899]!.draws);
  });

  it("rejects stale trusted correlation and a tampered duplicate final value", { timeout: 20_000 }, () => {
    const trace = fastManimRuntimeTraceV2Fixture();
    const expected = expectedRuntimeTraceV2Correlation(trace);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV2(canonicalJsonV1(trace), {
        ...expected,
        sourceHash: "f".repeat(64),
      }),
    ).toThrowError(/stale sourceHash correlation/);

    const needle = `"sourceHash":"${trace.sourceHash}"`;
    const duplicateFinalValue = canonicalJsonV1(trace).replace(needle, `${needle},"sourceHash":"${"f".repeat(64)}"`);
    expect(duplicateFinalValue).not.toBe(canonicalJsonV1(trace));
    expect(() => parseFastManimRuntimeTraceProducerJsonV2(duplicateFinalValue, expected)).toThrowError(
      /stale sourceHash correlation/,
    );
  });

  it("requires every sealed resource to be used while allowing content-addressed geometry changes", {
    timeout: 30_000,
  }, () => {
    const unusedAppearance = fastManimRuntimeTraceV2Fixture();
    const appearance = {
      fill: { color: { alpha: 1, blue: 0.25, green: 0.5, red: 0.75 }, rule: "nonzero" as const },
      stroke: null,
    };
    unusedAppearance.resources.appearances.push({
      ...appearance,
      id: `appearance:${digestFastManimRuntimeTraceAppearanceV2(appearance)}`,
    });
    sealFastManimRuntimeTraceV2Fixture(unusedAppearance);
    expect(fastManimRuntimeTraceV2Schema.safeParse(unusedAppearance).success).toBe(false);

    const unusedPath = fastManimRuntimeTraceV2Fixture();
    const removedPathId = unusedPath.resources.paths[23]!.id;
    const replacementPathId = unusedPath.resources.paths[0]!.id;
    unusedPath.frames.forEach((frame) => {
      frame.draws.forEach((draw) => {
        if (draw.pathId === removedPathId) draw.pathId = replacementPathId;
      });
    });
    sealFastManimRuntimeTraceV2Fixture(unusedPath);
    expect(fastManimRuntimeTraceV2Schema.safeParse(unusedPath).success).toBe(false);

    const unstablePath = fastManimRuntimeTraceV2Fixture();
    unstablePath.frames[1]!.draws[0]!.pathId = unstablePath.resources.paths[1]!.id;
    sealFastManimRuntimeTraceV2Fixture(unstablePath);
    expect(fastManimRuntimeTraceV2Schema.safeParse(unstablePath).success).toBe(true);
  });

  it("allows invisible partial fills but rejects visible partial fills", { timeout: 20_000 }, () => {
    const invisible = fastManimRuntimeTraceV2Fixture();
    const filledAppearanceId = invisible.resources.appearances[1]!.id;
    invisible.frames[1]!.draws[0]!.appearanceId = filledAppearanceId;
    invisible.frames[1]!.draws[0]!.opacity = 0;
    sealFastManimRuntimeTraceV2Fixture(invisible);
    expect(fastManimRuntimeTraceV2Schema.safeParse(invisible).success).toBe(true);

    const visible = clone(invisible);
    visible.frames[1]!.draws[0]!.opacity = 1;
    sealFastManimRuntimeTraceV2Fixture(visible);
    expect(fastManimRuntimeTraceV2Schema.safeParse(visible).success).toBe(false);
  });

  it("rejects reordered frames, changed terminal holds, stale content IDs, and noncanonical coordinates", {
    timeout: 60_000,
  }, () => {
    const mutations = [
      (trace: ReturnType<typeof fastManimRuntimeTraceV2Fixture>) => {
        trace.frames[1]!.frameIndex = 2;
      },
      (trace: ReturnType<typeof fastManimRuntimeTraceV2Fixture>) => {
        trace.frames[179]!.draws[15]!.translation.x = 2;
      },
      (trace: ReturnType<typeof fastManimRuntimeTraceV2Fixture>) => {
        trace.frames[899]!.draws[55]!.translation.x = 2;
      },
      (trace: ReturnType<typeof fastManimRuntimeTraceV2Fixture>) => {
        trace.resources.paths[0]!.id = `path:${"f".repeat(64)}`;
      },
      (trace: ReturnType<typeof fastManimRuntimeTraceV2Fixture>) => {
        trace.frames[1]!.draws[15]!.translation.x = 1 / 3;
      },
    ];

    for (const mutate of mutations) {
      const trace = fastManimRuntimeTraceV2Fixture();
      mutate(trace);
      sealFastManimRuntimeTraceV2Fixture(trace);
      expect(fastManimRuntimeTraceV2Schema.safeParse(trace).success).toBe(false);
    }
  });

  it("fails closed before schema validation on malformed, oversized, and excessive result JSON", () => {
    const expected = expectedRuntimeTraceV2Correlation();
    expect(() => parseFastManimRuntimeTraceProducerJsonV2("{", expected)).toThrowError(/malformed JSON/);
    expect(() => parseFastManimRuntimeTraceProducerJsonV2(new Uint8Array([0xff]), expected)).toThrowError(
      /not UTF-8 JSON/,
    );
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV2(
        new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2 + 1),
        expected,
      ),
    ).toThrowError(/at most/);
    expect(() =>
      parseFastManimRuntimeTraceProducerJsonV2(
        JSON.stringify({ frames: Array.from({ length: MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V2 + 1 }, () => null) }),
        expected,
      ),
    ).toThrowError(/oversized array/);
    let nested: unknown = null;
    for (let index = 0; index <= MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V2; index += 1) nested = { nested };
    expect(() => parseFastManimRuntimeTraceProducerJsonV2(JSON.stringify(nested), expected)).toThrowError(
      /structural budget/,
    );
  });

  it("reports a contract error for a structurally bounded path with more points than an argument spread can hold", {
    timeout: 30_000,
  }, () => {
    const trace = fastManimRuntimeTraceV2Fixture();
    const expected = clone(expectedRuntimeTraceV2Correlation(trace));
    const replacedPathId = trace.resources.paths[0]!.id;
    const segment = {
      control1: { x: 0, y: 0 },
      control2: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
    };
    const path = {
      subpaths: Array.from({ length: 10 }, () => ({
        closed: false,
        segments: Array.from({ length: 5_000 }, () => segment),
        start: { x: 0, y: 0 },
      })),
    };
    const pathId = `path:${digestFastManimRuntimeTracePathV2(path)}`;
    trace.resources.paths[0] = { id: pathId, path };
    trace.frames.forEach((frame) => {
      frame.draws.forEach((draw) => {
        if (draw.pathId === replacedPathId) draw.pathId = pathId;
      });
    });
    sealFastManimRuntimeTraceV2Fixture(trace);

    let error: unknown;
    try {
      parseFastManimRuntimeTraceProducerJsonV2(canonicalJsonV1(trace), expected);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FastManimRuntimeTraceV2ContractError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({ code: "correlation-mismatch" });
  });

  it("pins the producer-matched result budgets", () => {
    expect({
      appearances: MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V2,
      arrayItems: MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V2,
      bytes: MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2,
      depth: MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V2,
      entries: MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V2,
      objectFields: MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V2,
      normalizedBytes: MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V2,
      pathResources: MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V2,
      pathSegments: MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V2,
      values: MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V2,
    }).toEqual({
      appearances: 384,
      arrayItems: 7_000,
      bytes: 92_274_688,
      depth: 16,
      entries: 4_300_000,
      objectFields: 32,
      normalizedBytes: 8_388_608,
      pathResources: 6_566,
      pathSegments: 260_000,
      values: 4_300_000,
    });
  });
});
