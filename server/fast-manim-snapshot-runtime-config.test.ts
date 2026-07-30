import { describe, expect, it } from "vitest";

import { sceneCapabilityV1Schema } from "../src/engine/contracts";
import {
  canonicalF64HexV1,
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  type FastManimSnapshotRuntimeConfigV1,
  fastManimSnapshotProducerRequestV1Schema,
  fastManimSnapshotSceneIdV1,
} from "./fast-manim-snapshot-contract";
import { sourceHash } from "./manim-source-store";
import { runtimeConfig, sceneSource } from "./test-fixtures/fast-manim-snapshot-runner-fixture";

describe("fast-manim snapshot runtime config", () => {
  it("keeps the runtime allowlist conservative instead of mirroring the schema universe", () => {
    expect([...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1]).toEqual([
      "affine-transform-animation",
      "cubic-path-geometry",
      "motion-path-animation",
      "opacity-animation",
      "path-morph-animation",
      "path-trim-animation",
      "shape-primitives",
    ]);
    const universe = sceneCapabilityV1Schema.options;
    for (const capability of FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1) {
      expect(universe).toContain(capability);
    }
    expect(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1.length).toBeLessThan(universe.length);
    expect(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1).not.toContain("png-image");
  });

  it("encodes doubles as cross-runtime IEEE-754 bit patterns with pinned golden values", () => {
    expect(canonicalF64HexV1(1)).toBe("f64:3ff0000000000000");
    expect(canonicalF64HexV1(-0)).toBe("f64:8000000000000000");
    expect(canonicalF64HexV1(0)).toBe("f64:0000000000000000");
    expect(canonicalF64HexV1(5e-324)).toBe("f64:0000000000000001");
    expect(canonicalF64HexV1(1e-7)).toBe("f64:3e7ad7f29abcaf48");
    expect(canonicalF64HexV1(8)).toBe("f64:4020000000000000");
    expect(canonicalF64HexV1(14.222)).toBe("f64:402c71a9fbe76c8b");
    // The canonical snapshot frame width (128/9) producers normalize against.
    expect(canonicalF64HexV1(14.222222222222221)).toBe("f64:402c71c71c71c71c");
    expect(canonicalF64HexV1(1.7976931348623157e308)).toBe("f64:7fefffffffffffff");
    expect(() => canonicalF64HexV1(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
    expect(() => canonicalF64HexV1(Number.NaN)).toThrow(/finite/i);
  });

  it("digests the runtime capability surface deterministically", () => {
    const config = runtimeConfig();
    const digest = digestFastManimSnapshotRuntimeConfigV1(config);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digestFastManimSnapshotRuntimeConfigV1(config)).toBe(digest);
    expect(
      digestFastManimSnapshotRuntimeConfigV1({
        ...config,
        capabilities: config.capabilities.filter((capability) => capability !== "opacity-animation"),
      }),
    ).not.toBe(digest);
    expect(
      digestFastManimSnapshotRuntimeConfigV1({ ...config, frame: { ...config.frame, width: 14.2220000001 } }),
    ).not.toBe(digest);
    expect(digestFastManimSnapshotRuntimeConfigV1({ ...config, snapshotVersion: 2 })).not.toBe(digest);
    expect(() =>
      digestFastManimSnapshotRuntimeConfigV1({
        ...config,
        capabilities: [...config.capabilities].reverse(),
      }),
    ).toThrow(/sorted/i);
  });

  it("pins the canonical randomSeed to exactly 0 in the runtime config contract", () => {
    const config = runtimeConfig();
    expect(config.randomSeed).toBe(0);
    expect(digestFastManimSnapshotRuntimeConfigV1(config)).toMatch(/^[0-9a-f]{64}$/);
    // Any other seed — or omitting the field — is a schema violation, so the
    // digest can never silently cover a differently seeded run.
    const { randomSeed: _omitted, ...withoutSeed } = config;
    for (const drifted of [{ ...config, randomSeed: 1 }, { ...config, randomSeed: null }, withoutSeed]) {
      expect(() => digestFastManimSnapshotRuntimeConfigV1(drifted as FastManimSnapshotRuntimeConfigV1)).toThrow();
    }
  });

  it("binds the producer request to the runtime config, source text, and Scene identity it claims", () => {
    const config = runtimeConfig();
    const producerRequest = {
      projectId: "default",
      requestId: "snapshot-request-1",
      runtimeConfig: config,
      runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(config),
      sceneId: fastManimSnapshotSceneIdV1("scene.py", "ExampleScene"),
      sceneName: "ExampleScene",
      schema: "poietra.fast-manim-snapshot-producer-request",
      snapshotVersion: 1,
      sourceHash: sourceHash(sceneSource),
      sourcePath: "scene.py",
      sourceText: sceneSource,
      version: 1,
    };
    expect(producerRequest.sceneId).toMatch(/^scene:[0-9a-f]{64}$/);
    expect(fastManimSnapshotSceneIdV1("scene.py", "OtherScene")).not.toBe(producerRequest.sceneId);
    expect(fastManimSnapshotProducerRequestV1Schema.parse(producerRequest)).toEqual(producerRequest);
    const v2Config = { ...config, snapshotVersion: 2 } as const;
    const v2Request = {
      ...producerRequest,
      runtimeConfig: v2Config,
      runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(v2Config),
      snapshotVersion: 2,
    } as const;
    expect(fastManimSnapshotProducerRequestV1Schema.parse(v2Request)).toEqual(v2Request);
    expect(() => fastManimSnapshotProducerRequestV1Schema.parse({ ...v2Request, snapshotVersion: 1 })).toThrow(
      /different snapshot version/i,
    );
    const v4Config = {
      ...config,
      capabilities: ["png-image"],
      snapshotVersion: 4,
    } satisfies FastManimSnapshotRuntimeConfigV1;
    const v4Request = {
      ...producerRequest,
      runtimeConfig: v4Config,
      runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(v4Config),
      snapshotVersion: 4 as const,
    };
    expect(fastManimSnapshotProducerRequestV1Schema.parse(v4Request)).toEqual(v4Request);
    expect(() => digestFastManimSnapshotRuntimeConfigV1({ ...config, snapshotVersion: 4 })).toThrow(
      /exactly png-image/i,
    );
    expect(() => digestFastManimSnapshotRuntimeConfigV1({ ...config, capabilities: ["png-image"] })).toThrow(
      /only hermetic PNG profile V4/i,
    );
    expect(() =>
      fastManimSnapshotProducerRequestV1Schema.parse({ ...producerRequest, runtimeConfigHash: "b".repeat(64) }),
    ).toThrow(/canonical digest/i);
    expect(() =>
      fastManimSnapshotProducerRequestV1Schema.parse({
        ...producerRequest,
        runtimeConfig: { ...config, capabilities: config.capabilities.slice(1) },
      }),
    ).toThrow(/canonical digest/i);
    expect(() =>
      fastManimSnapshotProducerRequestV1Schema.parse({
        ...producerRequest,
        sourceText: `${sceneSource}\n# tampered\n`,
      }),
    ).toThrow(/source hash/i);
    expect(() =>
      fastManimSnapshotProducerRequestV1Schema.parse({
        ...producerRequest,
        sceneId: fastManimSnapshotSceneIdV1("scene.py", "OtherScene"),
      }),
    ).toThrow(/canonical derivation/i);
  });
});
