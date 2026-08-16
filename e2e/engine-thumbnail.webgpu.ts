import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const THUMBNAIL_WIDTH = 854;
const THUMBNAIL_HEIGHT = 480;
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

test("renders the representative Scene frame as the durable PNG thumbnail shape", async ({ page }) => {
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
