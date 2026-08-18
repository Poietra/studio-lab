import { describe, expect, it } from "vitest";

import { sceneCapabilityV1Schema } from "../src/engine/contracts";
import {
  canonicalF64HexV1,
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_DYNAMIC_RUNTIME_CAPABILITIES,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V8,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V9,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V10,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V11,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V12,
  type FastManimSnapshotRuntimeConfigV1,
  fastManimSnapshotProducerRequestV1Schema,
  fastManimSnapshotProfileVersionV1Schema,
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
    expect([...FAST_MANIM_DYNAMIC_RUNTIME_CAPABILITIES]).toEqual([
      ...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
      "vector-appearance-animation",
    ]);
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

  it("keeps V1-V12 canonical runtime digests frozen", () => {
    const config = runtimeConfig();
    const expected = [
      [1, "5eb22569bc257af3a71b87e62fdb23c070c8204ac4aa27ad684d8bff9b7b5a7a"],
      [2, "64a012df329bfd29c2d45cc19d977b53eb17fdab3599f5b70cd03e149f37d458"],
      [3, "813b7d95223f9a40606f7c45c2450cbde46f05e52a117023bc0602f8d90615d7"],
      [4, "d150787a372811fecebd321dcceb6911e968328c23a64ec4503c972b37a0d8ab"],
      [5, "103552e4ddfc17c7a5782ac9379f52f6694426dd71f777c619eeac8affb74aaa"],
      [6, "6b7325c8cfb6a114196125d10a76f05a1fde626c5af4c8b1b10f11b67c427b61"],
      [7, "e3d72030110f0426a977dac93b7f3a8f632b3b9874069533363ad3b434c213c1"],
    ] as const;
    for (const [snapshotVersion, digest] of expected) {
      expect(
        digestFastManimSnapshotRuntimeConfigV1({
          ...config,
          capabilities: snapshotVersion === 4 ? ["png-image"] : [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1],
          snapshotVersion,
        }),
      ).toBe(digest);
    }
    const v8: FastManimSnapshotRuntimeConfigV1 = {
      ...config,
      capabilities: [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V8],
      snapshotVersion: 8,
    };
    expect(digestFastManimSnapshotRuntimeConfigV1(v8)).toBe(
      "9650b633875a68d2e6c000e89cb21bdffabe2b6fbf08f2262b54842344e000a2",
    );
    expect(() => digestFastManimSnapshotRuntimeConfigV1({ ...v8, capabilities: [...config.capabilities] })).toThrow(
      /exact frozen capability set/i,
    );
    expect(() =>
      digestFastManimSnapshotRuntimeConfigV1({
        ...v8,
        frame: { ...v8.frame, width: 14.22222222222222 },
      }),
    ).toThrow(/exact canonical demo frame/i);

    const v9 = runtimeConfig(9);
    expect(v9.capabilities).toEqual(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V9);
    expect(digestFastManimSnapshotRuntimeConfigV1(v9)).toBe(
      "a2a789613c64b68c4b9b0c3542975b334b3b03388b7c8b0b903f690cca69c38a",
    );
    expect(() => digestFastManimSnapshotRuntimeConfigV1({ ...v9, capabilities: [...config.capabilities] })).toThrow(
      /exact frozen capability set/i,
    );
    expect(() =>
      digestFastManimSnapshotRuntimeConfigV1({
        ...v9,
        frame: { ...v9.frame, width: 14.22222222222222 },
      }),
    ).toThrow(/exact canonical demo frame/i);
    const v10 = runtimeConfig(10);
    expect(v10.capabilities).toEqual(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V10);
    expect(digestFastManimSnapshotRuntimeConfigV1(v10)).toBe(
      "b99127c213f9e049ffd247c8287bfba4f8d12d77e89bee5b1308bafc2527e9ec",
    );
    expect(() => digestFastManimSnapshotRuntimeConfigV1({ ...v10, capabilities: [...config.capabilities] })).toThrow(
      /exact frozen capability set/i,
    );
    expect(() =>
      digestFastManimSnapshotRuntimeConfigV1({
        ...v10,
        frame: { ...v10.frame, width: 14.22222222222222 },
      }),
    ).toThrow(/exact canonical demo frame/i);
    const v11 = runtimeConfig(11);
    expect(v11.capabilities).toEqual(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V11);
    expect(digestFastManimSnapshotRuntimeConfigV1(v11)).toBe(
      "5e5999869eec1e504524113678df6b55f38cc850efa4fbda569e2f2601beb520",
    );
    const v12 = runtimeConfig(12);
    expect(v12.capabilities).toEqual(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V12);
    expect(digestFastManimSnapshotRuntimeConfigV1(v12)).toBe(
      "2022ea1ccebb06668fc92386455c4d4928305e72a5a5459d103e3d86261a4593",
    );
    expect(() => digestFastManimSnapshotRuntimeConfigV1({ ...v12, capabilities: [...config.capabilities] })).toThrow(
      /exact frozen capability set/i,
    );
    expect(() =>
      digestFastManimSnapshotRuntimeConfigV1({
        ...v12,
        frame: { ...v12.frame, width: 14.22222222222222 },
      }),
    ).toThrow(/exact canonical demo frame/i);
    expect(fastManimSnapshotProfileVersionV1Schema.safeParse(10).success).toBe(true);
    expect(fastManimSnapshotProfileVersionV1Schema.safeParse(11).success).toBe(true);
    expect(fastManimSnapshotProfileVersionV1Schema.safeParse(12).success).toBe(true);
    expect(fastManimSnapshotProfileVersionV1Schema.safeParse(13).success).toBe(false);
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
    const v6Config = { ...config, snapshotVersion: 6 } as const;
    const v6Request = {
      ...producerRequest,
      runtimeConfig: v6Config,
      runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(v6Config),
      snapshotVersion: 6,
    } as const;
    expect(fastManimSnapshotProducerRequestV1Schema.parse(v6Request)).toEqual(v6Request);
    expect(v6Request.runtimeConfigHash).not.toBe(producerRequest.runtimeConfigHash);
    const v7Config = { ...config, snapshotVersion: 7 } as const;
    const v7Request = {
      ...producerRequest,
      runtimeConfig: v7Config,
      runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(v7Config),
      snapshotVersion: 7,
    } as const;
    expect(fastManimSnapshotProducerRequestV1Schema.parse(v7Request)).toEqual(v7Request);
    expect(v7Request.runtimeConfigHash).not.toBe(v6Request.runtimeConfigHash);
    const v9Config = runtimeConfig(9);
    const v9Request = {
      ...producerRequest,
      runtimeConfig: v9Config,
      runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(v9Config),
      snapshotVersion: 9 as const,
    };
    expect(fastManimSnapshotProducerRequestV1Schema.parse(v9Request)).toEqual(v9Request);
    const v11Config = runtimeConfig(11);
    expect(v11Config.capabilities).toEqual(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V11);
    expect(digestFastManimSnapshotRuntimeConfigV1(v11Config)).toBe(
      "5e5999869eec1e504524113678df6b55f38cc850efa4fbda569e2f2601beb520",
    );
    const v12Config = runtimeConfig(12);
    expect(v12Config.capabilities).toEqual(FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V12);
    expect(digestFastManimSnapshotRuntimeConfigV1(v12Config)).toBe(
      "2022ea1ccebb06668fc92386455c4d4928305e72a5a5459d103e3d86261a4593",
    );
    expect(() =>
      fastManimSnapshotProducerRequestV1Schema.parse({
        ...v9Request,
        runtimeConfig: { ...v9Config, snapshotVersion: 10 },
        snapshotVersion: 10,
      }),
    ).toThrow();
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
