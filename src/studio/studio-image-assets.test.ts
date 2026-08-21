import { describe, expect, it } from "vitest";

import { pngSnapshotBundleFixture } from "../../server/test-fixtures/fast-manim-snapshot-bundle-fixture";
import type { CanvasPngAssetTransferV1 } from "../engine/canvas-png-assets";
import {
  resolveStudioImageAssetDrag,
  studioImageAssetDragPayload,
  studioImageAssetsMatchingQuery,
  studioNativeImageAssetsV1,
} from "./studio-image-assets";

async function imageFixture() {
  const bundle = await pngSnapshotBundleFixture({
    frame: { height: 9, width: 16 },
    projectId: "project-a",
    requestId: "studio-native-image-assets",
    runtimeConfigHash: "a".repeat(64),
    sceneId: "image-scene",
    sceneName: "ImageScene",
    snapshotVersion: 4,
    sourceHash: "b".repeat(64),
    sourcePath: "scene.py",
  });
  const asset = bundle.assets.assets[0];
  if (!asset) throw new Error("Expected a PNG fixture asset.");
  const payload: CanvasPngAssetTransferV1 = {
    assetId: asset.id,
    byteLength: asset.byteLength,
    bytes: new ArrayBuffer(asset.byteLength),
    mediaType: "image/png",
    pixelHeight: asset.pixelHeight,
    pixelWidth: asset.pixelWidth,
    sha256: asset.sha256,
  };
  return { asset, bundle, payload };
}

describe("Studio native image assets", () => {
  it("projects the verified canonical image.png and retains its Scene placement contract", async () => {
    const { asset, bundle, payload } = await imageFixture();
    const image = bundle.scene.entities[0]?.geometry;
    if (image?.kind !== "image") throw new Error("Expected image geometry.");

    expect(studioNativeImageAssetsV1({ assetPayloads: [payload], bundle })).toEqual([
      {
        byteLength: asset.byteLength,
        bytes: payload.bytes,
        image: { asset: image.asset, localRect: image.localRect, sampler: image.sampler },
        label: `image-${asset.sha256.slice(0, 8)}.png`,
        pixelHeight: asset.pixelHeight,
        pixelWidth: asset.pixelWidth,
      },
    ]);
  });

  it("projects every matching canonical image as a distinct addable asset", async () => {
    const { asset, bundle, payload } = await imageFixture();
    const secondAsset = {
      ...asset,
      id: `${asset.id}-second`,
      sha256: "f".repeat(64),
    };
    const secondPayload = {
      ...payload,
      assetId: secondAsset.id,
      bytes: payload.bytes.slice(0),
      sha256: secondAsset.sha256,
    };
    const assets = [asset, secondAsset].sort((left, right) => (left.id < right.id ? -1 : 1));

    expect(
      studioNativeImageAssetsV1({
        assetPayloads: [payload, secondPayload],
        bundle: { ...bundle, assets: { ...bundle.assets, assets } },
      }).map((image) => ({ assetId: image.image.asset.assetId, label: image.label })),
    ).toEqual(
      assets.map((candidate) => ({
        assetId: candidate.id,
        label: `image-${candidate.sha256.slice(0, 8)}.png`,
      })),
    );
  });

  it("keeps an explicit empty state without a fully matching canonical payload", async () => {
    const { bundle, payload } = await imageFixture();

    expect(studioNativeImageAssetsV1(null)).toEqual([]);
    expect(studioNativeImageAssetsV1({ assetPayloads: [], bundle })).toEqual([]);
    expect(
      studioNativeImageAssetsV1({
        assetPayloads: [{ ...payload, pixelWidth: payload.pixelWidth + 1 }],
        bundle,
      }),
    ).toEqual([]);
  });

  it("resolves a dragged image only against the current canonical asset list", async () => {
    const { bundle, payload } = await imageFixture();
    const assets = studioNativeImageAssetsV1({ assetPayloads: [payload], bundle });
    const asset = assets[0];
    if (!asset) throw new Error("Expected one projected image asset.");

    expect(resolveStudioImageAssetDrag(assets, studioImageAssetDragPayload(asset))).toBe(asset);
    expect(
      resolveStudioImageAssetDrag(assets, JSON.stringify({ ...asset.image.asset, sha256: "f".repeat(64) })),
    ).toBeNull();
    expect(resolveStudioImageAssetDrag(assets, "not-json")).toBeNull();
  });

  it("filters the canonical projection by visible name or dimensions without changing asset identity", async () => {
    const { bundle, payload } = await imageFixture();
    const first = studioNativeImageAssetsV1({ assetPayloads: [payload], bundle })[0];
    if (!first) throw new Error("Expected one projected image asset.");
    const second = { ...first, label: "Cover Art.PNG", pixelHeight: 1080, pixelWidth: 1920 };
    const assets = [first, second];
    const nameMatches = studioImageAssetsMatchingQuery(assets, "  COVER ");

    expect(nameMatches).toEqual([second]);
    expect(nameMatches[0]).toBe(second);
    expect(studioImageAssetsMatchingQuery(assets, "1920x1080")).toEqual([second]);
    expect(studioImageAssetsMatchingQuery(assets, "missing")).toEqual([]);
    expect(studioImageAssetsMatchingQuery(assets, " ")).toBe(assets);
  });
});
