import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import type { FastManimRuntimeTraceRunRequestV1 } from "../src/render-pipeline/runtime-trace-preview-contract";
import {
  createFastManimRuntimeTraceProducerRequestV1,
  fastManimRuntimeTraceProducerEnvironmentV1,
  trustedFastManimRuntimeTraceProducerV1,
} from "./fast-manim-runtime-trace-profile";
import {
  FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
  FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
  fastManimRuntimeTraceConfigV2Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2,
  parseFastManimRuntimeTraceProducerRequestJsonV2,
} from "./fast-manim-runtime-trace-v2-contract";
import {
  createFastManimRuntimeTraceConfigV2,
  createFastManimRuntimeTraceProducerRequestV2,
  FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V2,
  FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V2,
  FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
  FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V2,
  trustedFastManimRuntimeTraceProducerV2,
} from "./fast-manim-runtime-trace-v2-profile";
import { FastManimSandboxRequestBundleV1, verifyFastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import { RUNTIME_TRACE_SOURCE_TEXT } from "./test-fixtures/fast-manim-runtime-trace-fixture";

const frame = { height: 8, width: 128 / 9 } as const;
const request = {
  projectId: "demo",
  requestId: "req-opening-runtime-trace-v2",
  sceneName: FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V2,
  sourceHash: FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
  sourcePath: FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V2,
} as const satisfies FastManimRuntimeTraceRunRequestV1;

function producerRequest() {
  return createFastManimRuntimeTraceProducerRequestV2(request, RUNTIME_TRACE_SOURCE_TEXT, frame);
}

describe("fast-manim Runtime Trace V2 request contract", () => {
  it("seals the exact OpeningManim 0–15 second producer request", () => {
    const value = producerRequest();
    const parsed = parseFastManimRuntimeTraceProducerRequestJsonV2(canonicalJsonV1(value));

    expect(FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V2).toBe(
      "0b5d2eae4a3709627a7ccae44ce5a977171452ed73e90ab6bfcfdffda604b977",
    );
    expect(parsed).toEqual(value);
    expect(parsed).toMatchObject({
      profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
      runtimeConfig: {
        durationSeconds: 15,
        frameRate: 60,
        profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2,
        version: FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
      },
      runtimeConfigHash: FAST_MANIM_RUNTIME_TRACE_CONFIG_HASH_V2,
      sceneName: "OpeningManim",
      sceneOccurrence: { constructStartLine: 19, definitionOrdinal: 1 },
      sourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      sourcePath: "example_scenes/basic.py",
      version: FAST_MANIM_RUNTIME_TRACE_VERSION_V2,
    });
    expect(createHash("sha256").update(parsed.sourceText, "utf8").digest("hex")).toBe(parsed.sourceHash);
  });

  it("keeps V1 and V2 admission disjoint", () => {
    expect(() => createFastManimRuntimeTraceProducerRequestV1(request, RUNTIME_TRACE_SOURCE_TEXT, frame)).toThrowError(
      /UpdatersExample profile/,
    );
    expect(() =>
      createFastManimRuntimeTraceProducerRequestV2(
        { ...request, sceneName: "UpdatersExample" },
        RUNTIME_TRACE_SOURCE_TEXT,
        frame,
      ),
    ).toThrowError(/OpeningManim/);
  });

  it("pins both profiles to the shared merged producer command", () => {
    const v1 = trustedFastManimRuntimeTraceProducerV1();
    const v2 = trustedFastManimRuntimeTraceProducerV2();
    const producerIdentity = {
      fastManimCommit: "ae04f3610d1aa5ddce259d5ba507da2ec581c7d3",
      fastManimTree: "41516d8b866a891adb22f47064b9bba5545fae15",
    };

    expect(v1.producer).toMatchObject(producerIdentity);
    expect(v2.producer).toMatchObject(producerIdentity);
    expect(fastManimRuntimeTraceProducerEnvironmentV1()).toEqual({
      POIETRA_FAST_MANIM_COMMIT: producerIdentity.fastManimCommit,
      POIETRA_FAST_MANIM_TREE: producerIdentity.fastManimTree,
    });
    expect(v2.roots.map(({ binding }) => binding.name)).toEqual(["title", "basel", "grid", "grid_title"]);
  });

  it("rejects stale source, scene, config, and occurrence correlation", () => {
    const value = producerRequest();
    const staleValues = [
      { ...value, sourceHash: "f".repeat(64) },
      { ...value, sceneId: `scene:${"f".repeat(64)}` },
      { ...value, runtimeConfigHash: "f".repeat(64) },
      { ...value, sceneOccurrence: { ...value.sceneOccurrence, definitionOrdinal: 2 } },
    ];

    expect(() =>
      createFastManimRuntimeTraceProducerRequestV2(request, `${RUNTIME_TRACE_SOURCE_TEXT}\n`, frame),
    ).toThrowError(/OpeningManim/);
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
    const config = createFastManimRuntimeTraceConfigV2(frame);
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
