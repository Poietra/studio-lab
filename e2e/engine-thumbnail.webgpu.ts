import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const THUMBNAIL_WIDTH = 854;
const THUMBNAIL_HEIGHT = 480;
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

test("renders the representative Scene frame as the durable PNG thumbnail shape", { tag: "@ci-smoke" }, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as {
    assets: unknown;
    scene: unknown;
  };
  const snapshot = { assets: fixture.assets, scene: fixture.scene };

  await page.goto("/");
  const result = await page.evaluate(
    async ({ expectedHeight, expectedWidth, maximumBytes, snapshot }) => {
      const worker = new Worker("/e2e/engine-thumbnail.worker.ts", { type: "module" });
      const done = new Promise<{ bytes?: ArrayBuffer; kind: string; message?: string }>((resolve, reject) => {
        worker.addEventListener("error", (event) => reject(new Error(event.message)), { once: true });
        worker.addEventListener("message", (event) => resolve(event.data as never), { once: true });
      });
      const snapshotJson = new TextEncoder().encode(JSON.stringify(snapshot)).buffer;
      worker.postMessage(
        {
          kind: "generate-engine-thumbnail",
          snapshotJson,
          wasmModuleUrl: new URL("/engine-wasm/poietra_wasm.js", location.href).href,
        },
        [snapshotJson],
      );
      const response = await done;
      worker.terminate();
      if (response.kind !== "engine-thumbnail-generated" || !response.bytes) {
        throw new Error(response.message ?? "The engine thumbnail worker failed.");
      }
      const bytes = new Uint8Array(response.bytes);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(expectedWidth, expectedHeight);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("A 2D thumbnail verification context is unavailable.");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const finalCirclePixel = Array.from(context.getImageData(374, 240, 1, 1).data);
      return {
        byteLength: bytes.byteLength,
        finalCirclePixel,
        height: new DataView(response.bytes).getUint32(20),
        signature: Array.from(bytes.subarray(0, 8)),
        width: new DataView(response.bytes).getUint32(16),
        withinLimit: bytes.byteLength > 0 && bytes.byteLength <= maximumBytes,
      };
    },
    {
      expectedHeight: THUMBNAIL_HEIGHT,
      expectedWidth: THUMBNAIL_WIDTH,
      maximumBytes: MAX_THUMBNAIL_BYTES,
      snapshot,
    },
  );

  expect(result.signature).toEqual(PNG_SIGNATURE);
  expect(result.width).toBe(THUMBNAIL_WIDTH);
  expect(result.height).toBe(THUMBNAIL_HEIGHT);
  expect(result.withinLimit).toBe(true);
  expect(result.byteLength).toBeLessThanOrEqual(MAX_THUMBNAIL_BYTES);
  // The fixture starts transparent and finishes opaque red. A red center here
  // proves the replacement for Manim `-s` selected the final Scene state.
  expect(result.finalCirclePixel[0]).toBeGreaterThan(245);
  expect(result.finalCirclePixel.slice(1)).toEqual([0, 0, 255]);
});

test("renders an effect-only project PNG through the canonical thumbnail path", async ({ page }) => {
  test.setTimeout(120_000);
  const [sceneFixture, pngFixture] = await Promise.all([
    readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8"),
    readFile("fixtures/engine-v1/png-alpha-edge-camera.json", "utf8"),
  ]);
  const base = JSON.parse(sceneFixture) as SceneIrBundleV1;
  const png = JSON.parse(pngFixture) as Readonly<{
    assetPayloads: readonly Readonly<{ assetId: string; encodedBytes: readonly number[] }>[];
    assets: SceneIrBundleV1["assets"];
  }>;
  const asset = png.assets.assets[0];
  const payload = png.assetPayloads[0];
  if (!asset || !payload || asset.id !== payload.assetId) throw new Error("The PNG thumbnail fixture is incomplete.");
  const snapshot: SceneIrBundleV1 = {
    assets: png.assets,
    scene: {
      ...base.scene,
      animationChannels: [
        {
          id: "scene-effect-parameter:thumbnail",
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: 0.05 },
            { at: base.scene.duration, easingToNext: null, value: 1 },
          ],
          kind: "scene-post-effect-parameter",
          parameterIndex: 0,
          provenanceId: "fixture",
          revision: 1,
          shaderId: "project-scene-post-effect",
        },
      ],
      assetManifest: {
        manifestDigest: png.assets.manifestDigest,
        manifestId: png.assets.manifestId,
      },
      entities: [],
      postEffects: [
        {
          parameters: [0.05],
          revision: 1,
          shaderId: "project-scene-post-effect",
          texture: {
            asset: { assetId: asset.id, sha256: asset.sha256 },
            sampler: "nearest",
          },
        },
      ],
      requiredCapabilities: ["png-image", "scene-post-effect"],
      sceneId: "fixture:textured-effect-thumbnail",
      source: { ...base.scene.source, revisionHash: "b".repeat(64) },
    },
  };
  const scenePostEffectRegistry = {
    effects: [
      {
        revision: 1,
        shaderId: "project-scene-post-effect",
        source: `struct Host {
  viewport_and_time: vec4<f32>,
  parameters_0: vec4<f32>,
  parameters_1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> host: Host;
@group(0) @binding(1) var scene_texture: texture_2d<f32>;
@group(0) @binding(3) var auxiliary_texture: texture_2d<f32>;
@group(0) @binding(4) var auxiliary_sampler: sampler;
@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let sampled = textureSample(auxiliary_texture, auxiliary_sampler, vec2<f32>(0.25, 0.5));
  return vec4<f32>(sampled.rgb * host.parameters_0.x, sampled.a);
}`,
        textureSlot: "texture2d",
      },
    ],
    schema: "poietra.scene-post-effect-registry",
    version: 1,
  };

  await page.goto("/");
  const result = await page.evaluate(
    async ({ asset, encodedBytes, scenePostEffectRegistry, snapshot }) => {
      const worker = new Worker("/e2e/engine-thumbnail.worker.ts", { type: "module" });
      const done = new Promise<{ bytes?: ArrayBuffer; kind: string; message?: string }>((resolve, reject) => {
        worker.addEventListener("error", (event) => reject(new Error(event.message)), { once: true });
        worker.addEventListener("message", (event) => resolve(event.data as never), { once: true });
      });
      const snapshotJson = new TextEncoder().encode(JSON.stringify(snapshot)).buffer;
      const assetMetadataJson = new TextEncoder().encode(JSON.stringify([asset])).buffer;
      const assetBytes = Uint8Array.from(encodedBytes).buffer;
      const scenePostEffectRegistryJson = new TextEncoder().encode(JSON.stringify(scenePostEffectRegistry)).buffer;
      worker.postMessage(
        {
          assetBytes: [assetBytes],
          assetMetadataJson,
          kind: "generate-engine-thumbnail",
          scenePostEffectRegistryJson,
          snapshotJson,
          wasmModuleUrl: new URL("/engine-wasm/poietra_wasm.js", location.href).href,
        },
        [assetBytes, assetMetadataJson, scenePostEffectRegistryJson, snapshotJson],
      );
      const response = await done.finally(() => worker.terminate());
      if (response.kind !== "engine-thumbnail-generated" || !response.bytes) {
        throw new Error(response.message ?? "The textured thumbnail worker failed.");
      }
      const bitmap = await createImageBitmap(new Blob([response.bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("A textured thumbnail verification context is unavailable.");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let redDominantPixels = 0;
      for (let offset = 0; offset < rgba.length; offset += 4) {
        const red = rgba[offset] ?? 0;
        const green = rgba[offset + 1] ?? 0;
        const blue = rgba[offset + 2] ?? 0;
        if (red > 200 && red > green * 2 && red > blue * 2) redDominantPixels += 1;
      }
      return { redDominantPixels };
    },
    { asset, encodedBytes: payload.encodedBytes, scenePostEffectRegistry, snapshot },
  );

  // The static baseline is intentionally too dark for this threshold. Passing
  // proves thumbnail generation samples the parameter track at the same final
  // representative instant as the canonical evaluator.
  expect(result.redDominantPixels).toBeGreaterThan(100_000);
});
