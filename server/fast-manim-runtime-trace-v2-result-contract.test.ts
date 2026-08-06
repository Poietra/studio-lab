import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
import { lowerVerifiedFastManimRuntimeTraceV2 } from "./fast-manim-runtime-trace-v2-lowering";
import { createFastManimRuntimeTraceProducerRequestV2 } from "./fast-manim-runtime-trace-v2-profile";
import {
  digestFastManimRuntimeTraceAppearanceV2,
  digestFastManimRuntimeTraceV2,
  expectedFastManimRuntimeTraceCorrelationFromRequestV2,
  fastManimRuntimeTraceV2Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V2,
  parseFastManimRuntimeTraceProducerJsonV2,
} from "./fast-manim-runtime-trace-v2-result-contract";
import { RUNTIME_TRACE_SOURCE_TEXT } from "./test-fixtures/fast-manim-runtime-trace-fixture";
import {
  expectedRuntimeTraceV2Correlation,
  fastManimRuntimeTraceV2Fixture,
  sealFastManimRuntimeTraceV2Fixture,
} from "./test-fixtures/fast-manim-runtime-trace-v2-fixture";

const artifactBytes = gunzipSync(
  readFileSync(new URL("./test-fixtures/fast-manim-runtime-trace-opening-v2.json.gz", import.meta.url)),
);
const artifactJson = artifactBytes.toString("utf8");

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function frameAt(bundle: Awaited<ReturnType<typeof lowerVerifiedFastManimRuntimeTraceV2>>, sampleTime: number) {
  const result = await compileEngineFrameV1({
    assets: bundle.assets,
    packetId: `opening-runtime-trace-v2:${sampleTime}`,
    sampleTime,
    scene: bundle.scene,
    viewport: { heightPx: 720, widthPx: 1_280 },
  });
  if (result.kind !== "ready") throw new Error(result.message);
  return result.frame;
}

describe("fast-manim Runtime Trace V2 result contract", () => {
  it("accepts and lowers the real OpeningManim producer artifact", async () => {
    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "bb22e6dbc31cbecf5d15104aba703a14332f43ff056848c04350287aff1a3725",
    );
    const untrusted = JSON.parse(artifactJson) as ReturnType<typeof fastManimRuntimeTraceV2Fixture>;
    expect(untrusted.producer).toMatchObject({
      fastManimCommit: "0".repeat(40),
      fastManimTree: "1".repeat(40),
      semanticsSha256: "60023712a80e500a9a0ebf98b69b8734532dafd1fb6d02b1c00fda592fe65239",
    });
    const request = createFastManimRuntimeTraceProducerRequestV2(
      {
        projectId: untrusted.projectId,
        requestId: untrusted.requestId,
        sceneName: untrusted.sceneName,
        sourceHash: untrusted.sourceHash,
        sourcePath: untrusted.sourcePath,
      },
      RUNTIME_TRACE_SOURCE_TEXT,
      { height: 8, width: 128 / 9 },
    );
    const expected = expectedFastManimRuntimeTraceCorrelationFromRequestV2(request, {
      producer: untrusted.producer,
      roots: untrusted.roots,
    });
    const trace = parseFastManimRuntimeTraceProducerJsonV2(artifactBytes, expected);

    expect(trace.frames).toHaveLength(180);
    expect(trace.frames.every((frame) => frame.draws.length === 29)).toBe(true);
    expect(trace.resources.paths).toHaveLength(24);
    expect(trace.resources.appearances).toHaveLength(298);

    const bundle = await lowerVerifiedFastManimRuntimeTraceV2(trace);
    expect(bundle.scene.entities).toHaveLength(47);
    expect(bundle.scene.animationChannels).toHaveLength(73);
    expect(bundle.scene.animationChannels.reduce((total, channel) => total + channel.keyframes.length, 0)).toBe(13_140);
    expect(bundle.scene.entities.slice(3, 5).map(({ id }) => id)).toEqual([
      expect.stringMatching(/runtime-draw:0\/paint:fill$/),
      expect.stringMatching(/runtime-draw:0\/paint:stroke$/),
    ]);
    expect(
      bundle.scene.animationChannels
        .filter((channel) => channel.kind === "path-trim")
        .every((channel) => channel.parameterization === "uniform-cubic-parameter-v1"),
    ).toBe(true);
    for (const sampleTime of [0, 0.5, 1, 2, 3]) {
      expect((await frameAt(bundle, sampleTime)).packet.draws).toHaveLength(44);
    }
  });

  it("accepts a compact sealed fixture and produces a stable trace digest", () => {
    const trace = fastManimRuntimeTraceV2Fixture();
    const parsed = parseFastManimRuntimeTraceProducerJsonV2(
      canonicalJsonV1(trace),
      expectedRuntimeTraceV2Correlation(trace),
    );

    expect(parsed.resources.paths).toHaveLength(24);
    expect(parsed.frames[0]?.draws).toHaveLength(29);
    expect(digestFastManimRuntimeTraceV2(parsed)).toBe(digestFastManimRuntimeTraceV2(trace));
  });

  it("rejects stale trusted correlation and a tampered duplicate final value", () => {
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

  it("requires every sealed resource to be used while allowing content-addressed geometry changes", () => {
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

  it("allows invisible partial fills but rejects visible partial fills", () => {
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

  it("rejects reordered frames, changed terminal holds, stale content IDs, and noncanonical coordinates", () => {
    const mutations = [
      (trace: ReturnType<typeof fastManimRuntimeTraceV2Fixture>) => {
        trace.frames[1]!.frameIndex = 2;
      },
      (trace: ReturnType<typeof fastManimRuntimeTraceV2Fixture>) => {
        trace.frames[179]!.draws[15]!.translation.x = 2;
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

  it("pins the producer-matched result budgets", () => {
    expect({
      appearances: MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V2,
      arrayItems: MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V2,
      bytes: MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2,
      depth: MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V2,
      entries: MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V2,
      objectFields: MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V2,
      pathSegments: MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V2,
      values: MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V2,
    }).toEqual({
      appearances: 320,
      arrayItems: 320,
      bytes: 4_194_304,
      depth: 16,
      entries: 120_000,
      objectFields: 32,
      pathSegments: 512,
      values: 120_000,
    });
  });
});
