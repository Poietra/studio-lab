import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import {
  type AssetManifestV1,
  canonicalAssetManifestV1,
  type SceneIrBundleV1,
  sceneIrBundleV1Schema,
} from "../src/engine/contracts";
import { encodeRgbaPngV1 } from "./png-rgba";

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function imageCacheFixture() {
  const base = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Readonly<{
    scene: SceneIrBundleV1["scene"];
  }>;
  const png = encodeRgbaPngV1(Uint8Array.from([255, 0, 0, 255]), 1, 1);
  const digest = sha256(png);
  const asset = {
    alphaMode: "straight",
    byteLength: png.byteLength,
    colorSpace: "srgb",
    id: "asset:image-cache",
    kind: "png-image",
    mediaType: "image/png",
    pixelHeight: 1,
    pixelWidth: 1,
    sha256: digest,
  } as const;
  const manifestDraft: AssetManifestV1 = {
    assets: [asset],
    manifestDigest: "0".repeat(64),
    manifestId: "manifest:image-cache",
    schema: "poietra.asset-manifest",
    version: 1,
  };
  const manifest = {
    ...manifestDraft,
    manifestDigest: sha256(canonicalAssetManifestV1(manifestDraft)),
  };
  const revision = "c".repeat(64);
  const common = {
    appearance: { kind: "image", opacity: 1 } as const,
    lifetimes: [{ end: 2, start: 0 }],
    parentId: null,
    provenanceId: "fixture",
    transform: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
  };
  const snapshot = sceneIrBundleV1Schema.parse({
    assets: manifest,
    scene: {
      ...base.scene,
      animationChannels: [],
      assetManifest: { manifestDigest: manifest.manifestDigest, manifestId: manifest.manifestId },
      entities: [
        {
          ...common,
          geometry: {
            asset: { assetId: asset.id, sha256: asset.sha256 },
            kind: "image",
            localRect: { bottom: -2, left: -4, right: 0, top: 2 },
            sampler: "nearest",
          },
          id: "image-nearest",
          sceneOrder: 0,
          sourceZIndex: 0,
        },
        {
          ...common,
          geometry: {
            asset: { assetId: asset.id, sha256: asset.sha256 },
            kind: "image",
            localRect: { bottom: -2, left: 0, right: 4, top: 2 },
            sampler: "linear",
          },
          id: "image-linear",
          sceneOrder: 1,
          sourceZIndex: 1,
        },
      ],
      requiredCapabilities: ["png-image"],
      source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: revision },
    },
  });
  return { asset, png: [...png], revision, snapshot };
}

test("uploads one verified texture and reuses both sampler bindings for 300 browser frames", async ({ page }) => {
  const fixture = await imageCacheFixture();
  await page.goto("/");
  const evidence = await page.evaluate(async ({ asset, png, revision, snapshot }) => {
    const canvas = document.createElement("canvas");
    canvas.height = 90;
    canvas.width = 160;
    document.body.replaceChildren(canvas);
    const { PoietraCanvasWorkerClient } = await import("../src/engine/canvas-worker-client");
    const client = new PoietraCanvasWorkerClient({ requestTimeoutMs: 60_000 });
    try {
      const bytes = Uint8Array.from(png).buffer;
      await client.installScene({
        assetPayloads: [
          {
            assetId: asset.id,
            byteLength: asset.byteLength,
            bytes,
            mediaType: asset.mediaType,
            pixelHeight: asset.pixelHeight,
            pixelWidth: asset.pixelWidth,
            sha256: asset.sha256,
          },
        ],
        canvas,
        revision,
        snapshot,
      });
      const render = () =>
        client.renderTelemetry({
          revision,
          sampleTime: 1,
          viewport: { heightPx: 90, widthPx: 160 },
        });
      const cold = await render();
      const warm = [];
      for (let frame = 0; frame < 300; frame += 1) warm.push((await render()).telemetry);
      return { cold: cold.telemetry, warm };
    } finally {
      client.dispose();
    }
  }, fixture);

  expect(evidence.cold.caches.imageTexture).toBe("miss");
  expect(evidence.cold.caches.imageSamplerBinding).toBe("miss");
  expect(evidence.cold.counts.imageTextureUploads).toBe(1);
  expect(evidence.cold.counts.imageSamplerBindingCreations).toBe(2);
  expect(evidence.warm).toHaveLength(300);
  for (const frame of evidence.warm) {
    expect(frame.caches.imageTexture).toBe("hit");
    expect(frame.caches.imageSamplerBinding).toBe("hit");
    expect(frame.counts.imageTextureUploads).toBe(0);
    expect(frame.counts.imageSamplerBindingCreations).toBe(0);
    expect(frame.counts.imageTextureEvictions).toBe(0);
  }
});
