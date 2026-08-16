import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const VIEWPORT = { heightPx: 90, widthPx: 160 } as const;
const FPS = 2;
/** `ceil(duration 2 s * 2 fps)` uniform-grid frames at 0, 0.5, 1.0, 1.5 s. */
const EXPECTED_FRAME_COUNT = 4;
const FRAME_BYTES = VIEWPORT.widthPx * VIEWPORT.heightPx * 4;

type ExportReadbackProof = Readonly<{
  frameCount: number;
  kind: string;
  rgba: readonly number[];
}>;

function pixelAt(rgba: readonly number[], frame: number, x: number, y: number) {
  const offset = frame * FRAME_BYTES + (y * VIEWPORT.widthPx + x) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]] as const;
}

function expectPixelClose(actual: readonly (number | undefined)[], expected: readonly number[], tolerance: number) {
  expected.forEach((component, index) => {
    expect(Math.abs((actual[index] ?? -1) - component)).toBeLessThanOrEqual(tolerance);
  });
}

test("proves the async offscreen export readback sequence in the browser WebGPU runtime", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Readonly<{
    assets: unknown;
    scene: unknown;
  }>;
  const bundle = { assets: fixture.assets, scene: fixture.scene } as const;

  await page.goto("/");
  const proof = (await page.evaluate(
    async ({ fps, snapshot, viewport }) => {
      const worker = new Worker("/e2e/export-readback.worker.ts", { type: "module" });
      const done = new Promise<{ frameCount?: number; kind: string; message?: string; rgba?: ArrayBuffer }>(
        (resolve, reject) => {
          worker.addEventListener(
            "error",
            (event) => reject(new Error(event.message || "The export readback worker crashed.")),
            { once: true },
          );
          worker.addEventListener("message", (event) => resolve(event.data as never), { once: true });
        },
      );
      const snapshotJson = new TextEncoder().encode(JSON.stringify(snapshot)).buffer;
      worker.postMessage(
        {
          fps,
          kind: "prove-export-readback",
          snapshotJson,
          viewport,
          wasmModuleUrl: new URL("/engine-wasm/poietra_wasm.js", location.href).href,
        },
        [snapshotJson],
      );
      const result = await done;
      worker.terminate();
      if (result.kind !== "export-readback-proof" || !result.rgba || result.frameCount === undefined) {
        throw new Error(`The export readback proof failed: ${result.message ?? JSON.stringify(result)}`);
      }
      return {
        frameCount: result.frameCount,
        kind: result.kind,
        rgba: Array.from(new Uint8Array(result.rgba)),
      };
    },
    { fps: FPS, snapshot: bundle, viewport: VIEWPORT },
  )) as ExportReadbackProof;

  expect(proof.kind).toBe("export-readback-proof");
  expect(proof.frameCount).toBe(EXPECTED_FRAME_COUNT);
  expect(proof.rgba).toHaveLength(EXPECTED_FRAME_COUNT * FRAME_BYTES);

  // The shared fixture animates the red circle (center pixel 70,45) from
  // opacity 0 to 1 with smoothstep easing across its 2-second duration while
  // the blue circle (center pixel 90,45) stays statically opaque. Smoothstep
  // progress 0.5 -> opacity 0.5 and 0.75 -> 0.84375; sRGB-encoding those
  // linear reds yields 188 and 237.
  for (let frame = 0; frame < EXPECTED_FRAME_COUNT; frame += 1) {
    expectPixelClose(pixelAt(proof.rgba, frame, 0, 0), [0, 0, 0, 255], 0);
    expectPixelClose(pixelAt(proof.rgba, frame, 90, 45), [0, 0, 255, 255], 3);
  }
  expectPixelClose(pixelAt(proof.rgba, 0, 70, 45), [0, 0, 0, 255], 0);
  expectPixelClose(pixelAt(proof.rgba, 2, 70, 45), [188, 0, 0, 255], 3);
  expectPixelClose(pixelAt(proof.rgba, 3, 70, 45), [237, 0, 0, 255], 3);
});
