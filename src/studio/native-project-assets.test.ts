import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { digestAssetManifestV1, parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "../engine/contracts";
import {
  ingestNativeProjectPngV1,
  MAX_NATIVE_PROJECT_PNG_BYTES_V1,
  type NativeProjectAssetStateV1,
  nativeProjectPngAssetIdV1,
} from "./native-project-assets";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const DIGEST = createHash("sha256").update(PNG).digest("hex");

async function emptyNativeState(): Promise<NativeProjectAssetStateV1> {
  const draft = {
    assets: [],
    manifestDigest: "0".repeat(64),
    manifestId: "manifest:studio-native",
    schema: "poietra.asset-manifest" as const,
    version: 1 as const,
  };
  const assets = { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
  const bundle = await parseVerifiedSceneIrBundleV1({
    assets,
    scene: {
      animationChannels: [],
      assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
      camera: {
        background: { alpha: 1, blue: 0, green: 0, red: 0 },
        view: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
      },
      compositing: "linear-light",
      coordinateSpace: {
        cpuPrecision: "f64",
        kind: "cartesian-2d",
        origin: "center",
        unit: "scene-unit",
        xAxis: "right",
        yAxis: "up",
      },
      duration: 5,
      entities: [],
      fidelity: { kind: "exact" },
      provenance: [
        {
          evidence: ["Studio-native browser document"],
          id: "studio-native",
          origin: "studio-edit-program",
        },
      ],
      requiredCapabilities: [],
      sceneId: "studio-native:scene",
      schema: "poietra.scene-ir",
      source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: "a".repeat(64) },
      stateSampling: { frameRate: null, retainsTerminalState: false },
      version: 1,
    },
  });
  return { assetPayloads: [], bundle };
}

const dimensions = vi.fn(async () => ({ pixelHeight: 16, pixelWidth: 32 }));

describe("Studio-native project PNG ingress", () => {
  it("atomically adds copied PNG bytes to the canonical manifest and Scene reference", async () => {
    const state = await emptyNativeState();
    const inputBytes = PNG.slice().buffer;
    const result = await ingestNativeProjectPngV1({
      decodeDimensions: dimensions,
      source: { bytes: inputBytes, kind: "bytes", mediaType: "image/png" },
      state,
    });

    expect(result.added).toBe(true);
    expect(result.asset).toMatchObject({
      byteLength: PNG.byteLength,
      id: nativeProjectPngAssetIdV1(DIGEST),
      pixelHeight: 16,
      pixelWidth: 32,
      sha256: DIGEST,
    });
    expect(result.bundle.assets.assets).toEqual([result.asset]);
    expect(result.bundle.scene.assetManifest).toEqual({
      manifestDigest: result.bundle.assets.manifestDigest,
      manifestId: result.bundle.assets.manifestId,
    });
    await expect(parseVerifiedSceneIrBundleV1(result.bundle)).resolves.toEqual(result.bundle);
    expect(result.assetPayloads).toHaveLength(1);
    expect(result.assetPayloads[0]?.bytes).not.toBe(inputBytes);
    expect(new Uint8Array(result.assetPayloads[0]!.bytes)).toEqual(PNG);

    new Uint8Array(inputBytes).fill(0);
    expect(new Uint8Array(result.assetPayloads[0]!.bytes)).toEqual(PNG);
    expect(state.bundle.assets.assets).toEqual([]);
    expect(state.assetPayloads).toEqual([]);
  });

  it("accepts a browser File-shaped source and deduplicates the same immutable content", async () => {
    const initial = await emptyNativeState();
    const first = await ingestNativeProjectPngV1({
      decodeDimensions: dimensions,
      source: { bytes: PNG.slice().buffer, kind: "bytes", mediaType: "image/png" },
      state: initial,
    });
    const file = {
      arrayBuffer: async () => PNG.slice().buffer,
      size: PNG.byteLength,
    };
    const second = await ingestNativeProjectPngV1({
      decodeDimensions: dimensions,
      source: { file, kind: "file" },
      state: first,
    });

    expect(second.added).toBe(false);
    expect(second.asset).toEqual(first.asset);
    expect(second.bundle.assets.assets).toHaveLength(1);
    expect(second.assetPayloads).toHaveLength(1);
  });

  it("keeps the first native PNG boundary explicit instead of silently replacing it", async () => {
    const initial = await emptyNativeState();
    const first = await ingestNativeProjectPngV1({
      decodeDimensions: dimensions,
      source: { bytes: PNG.slice().buffer, kind: "bytes", mediaType: "image/png" },
      state: initial,
    });
    const differentPng = new Uint8Array([...PNG, 5]);

    await expect(
      ingestNativeProjectPngV1({
        decodeDimensions: dimensions,
        source: { bytes: differentPng.buffer, kind: "bytes", mediaType: "image/png" },
        state: first,
      }),
    ).rejects.toThrow(/replacing.*not supported/i);
    expect(first.bundle.assets.assets).toEqual([first.asset]);
  });

  it("rejects an invalid MIME, signature, bounded size, and decoded dimensions before committing", async () => {
    const state = await emptyNativeState();
    await expect(
      ingestNativeProjectPngV1({
        decodeDimensions: dimensions,
        source: { bytes: PNG.slice().buffer, kind: "bytes", mediaType: "image/jpeg" },
        state,
      }),
    ).rejects.toThrow(/image\/png/i);
    await expect(
      ingestNativeProjectPngV1({
        decodeDimensions: dimensions,
        source: { bytes: new Uint8Array(PNG.byteLength).buffer, kind: "bytes", mediaType: "image/png" },
        state,
      }),
    ).rejects.toThrow(/signature/i);
    await expect(
      ingestNativeProjectPngV1({
        decodeDimensions: dimensions,
        source: {
          file: {
            arrayBuffer: async () => {
              throw new Error("must reject before reading");
            },
            size: MAX_NATIVE_PROJECT_PNG_BYTES_V1 + 1,
          },
          kind: "file",
        },
        state,
      }),
    ).rejects.toThrow(/between 1/i);
    await expect(
      ingestNativeProjectPngV1({
        decodeDimensions: async () => ({ pixelHeight: 16_384, pixelWidth: 16_384 }),
        source: { bytes: PNG.slice().buffer, kind: "bytes", mediaType: "image/png" },
        state,
      }),
    ).rejects.toThrow(/16777216 pixels/i);
    expect(state).toEqual(await emptyNativeState());
  });

  it("rejects non-native Scenes and stale retained payloads", async () => {
    const state = await emptyNativeState();
    const imported: SceneIrBundleV1 = {
      ...state.bundle,
      scene: {
        ...state.bundle.scene,
        source: {
          kind: "imported-manim-server-snapshot",
          runtimeConfigHash: "b".repeat(64),
          snapshotHash: "c".repeat(64),
          snapshotVersion: 1,
          sourceHash: "d".repeat(64),
        },
      },
    };
    await expect(
      ingestNativeProjectPngV1({
        decodeDimensions: dimensions,
        source: { bytes: PNG.slice().buffer, kind: "bytes", mediaType: "image/png" },
        state: { assetPayloads: [], bundle: imported },
      }),
    ).rejects.toThrow(/not canonical/i);

    const valid = await ingestNativeProjectPngV1({
      decodeDimensions: dimensions,
      source: { bytes: PNG.slice().buffer, kind: "bytes", mediaType: "image/png" },
      state,
    });
    await expect(
      ingestNativeProjectPngV1({
        decodeDimensions: dimensions,
        source: { bytes: PNG.slice().buffer, kind: "bytes", mediaType: "image/png" },
        state: {
          ...valid,
          assetPayloads: valid.assetPayloads.map((payload) => ({ ...payload, sha256: "e".repeat(64) })),
        },
      }),
    ).rejects.toThrow(/not canonical/i);
  });
});
