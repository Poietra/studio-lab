import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  fastManimRuntimeTraceProducerEnvironment,
  TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY,
} from "./fast-manim-runtime-trace-producer-identity";
import {
  FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
  FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
  fastManimRuntimeTraceConfigV2Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2,
  parseFastManimRuntimeTraceProducerRequestJsonV2,
} from "./fast-manim-runtime-trace-v2-contract";
import { FastManimSandboxRequestBundleV1, verifyFastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import {
  RUNTIME_TRACE_V2_CONFIG_HASH,
  runtimeTraceV2ConfigFixture,
  runtimeTraceV2RequestFixture,
} from "./test-fixtures/fast-manim-runtime-trace-v2-fixture";

function producerRequest() {
  return runtimeTraceV2RequestFixture();
}

describe("fast-manim Runtime Trace V2 request contract", () => {
  it("round-trips a structurally valid legacy V2 producer request", () => {
    const value = producerRequest();
    const parsed = parseFastManimRuntimeTraceProducerRequestJsonV2(canonicalJsonV1(value));

    expect(RUNTIME_TRACE_V2_CONFIG_HASH).toBe("0b5d2eae4a3709627a7ccae44ce5a977171452ed73e90ab6bfcfdffda604b977");
    expect(parsed).toEqual(value);
    expect(parsed).toMatchObject({
      profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
      runtimeConfig: {
        durationSeconds: 15,
        frameRate: 60,
        profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
        version: FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
      },
      runtimeConfigHash: RUNTIME_TRACE_V2_CONFIG_HASH,
      sceneName: "OpeningManim",
      sceneOccurrence: { constructStartLine: 19, definitionOrdinal: 1 },
      sourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      sourcePath: "example_scenes/basic.py",
      version: FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
    });
    expect(createHash("sha256").update(parsed.sourceText, "utf8").digest("hex")).toBe(parsed.sourceHash);
  });

  it("publishes the shared producer identity as the process environment", () => {
    expect(fastManimRuntimeTraceProducerEnvironment()).toEqual({
      POIETRA_FAST_MANIM_COMMIT: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimCommit,
      POIETRA_FAST_MANIM_TREE: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimTree,
    });
  });

  it("rejects stale source, scene, config, and occurrence correlation", () => {
    const value = producerRequest();
    const staleValues = [
      { ...value, sourceHash: "f".repeat(64) },
      { ...value, sceneId: `scene:${"f".repeat(64)}` },
      { ...value, runtimeConfigHash: "f".repeat(64) },
      { ...value, sceneOccurrence: { ...value.sceneOccurrence, definitionOrdinal: 2 } },
    ];

    for (const stale of staleValues.slice(0, 3)) {
      expect(() => parseFastManimRuntimeTraceProducerRequestJsonV2(canonicalJsonV1(stale))).toThrowError(
        /closed contract/,
      );
    }
    // Occurrence is structurally valid on the generic wire. The exact profile
    // constructor, not a producer-controlled echo, supplies its trusted value.
    expect(parseFastManimRuntimeTraceProducerRequestJsonV2(canonicalJsonV1(staleValues[3]))).toMatchObject({
      sceneOccurrence: { definitionOrdinal: 2 },
    });
  });

  it("requires the canonical Cairo camera and exact V2 temporal profile", () => {
    const config = runtimeTraceV2ConfigFixture();
    for (const changed of [
      { ...config, durationSeconds: 5 },
      { ...config, frameRate: 30 },
      { ...config, profileVersion: 1 },
      { ...config, camera: { ...config.camera, frameWidth: 16 } },
    ]) {
      expect(fastManimRuntimeTraceConfigV2Schema.safeParse(changed).success).toBe(false);
    }
  });

  it("fails closed on malformed, non-UTF8, structurally excessive, and oversized request JSON", () => {
    expect(() => parseFastManimRuntimeTraceProducerRequestJsonV2("{")).toThrowError(/malformed JSON/);
    expect(() => parseFastManimRuntimeTraceProducerRequestJsonV2(new Uint8Array([0xff]))).toThrowError(
      /not UTF-8 JSON/,
    );
    let nested: unknown = null;
    for (let index = 0; index < 18; index += 1) nested = { nested };
    expect(() => parseFastManimRuntimeTraceProducerRequestJsonV2(JSON.stringify(nested))).toThrowError(
      /structural budget/,
    );
    const stackDepth = 20_000;
    const deeplyNested = `${'{"nested":'.repeat(stackDepth)}null${"}".repeat(stackDepth)}`;
    expect(() => parseFastManimRuntimeTraceProducerRequestJsonV2(deeplyNested)).toThrowError(/structural budget/);
    expect(() =>
      parseFastManimRuntimeTraceProducerRequestJsonV2(
        new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2 + 1),
      ),
    ).toThrowError(/at most/);
  });

  it("rejects duplicate keys and non-scalar source text instead of normalizing them", () => {
    const value = producerRequest();
    const canonical = canonicalJsonV1(value);
    const duplicate = canonical.replace('"projectId":"demo"', '"projectId":"other","projectId":"demo"');
    const loneSurrogate = "\ud800";
    const nonScalar = {
      ...value,
      sourceHash: createHash("sha256").update(loneSurrogate, "utf8").digest("hex"),
      sourceText: loneSurrogate,
    };

    expect(duplicate).not.toBe(canonical);
    expect(() => parseFastManimRuntimeTraceProducerRequestJsonV2(duplicate)).toThrowError(/canonical JSON/);
    expect(() => parseFastManimRuntimeTraceProducerRequestJsonV2(canonicalJsonV1(nonScalar))).toThrowError(
      /closed contract/,
    );
  });

  it("dispatches the V2 request through the existing immutable sandbox wire", () => {
    const value = producerRequest();
    const bundle = new FastManimSandboxRequestBundleV1(value);

    expect(bundle.producerKind).toBe("runtime-trace");
    expect(bundle.version).toBe(1);
    expect(verifyFastManimSandboxRequestBundleV1(bundle)).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(bundle.copyProducerRequestBytes()))).toEqual(value);
    expect(FastManimSandboxRequestBundleV1.fromBytes(bundle.copyBytes()).requestDigest).toBe(bundle.requestDigest);
  });
});
