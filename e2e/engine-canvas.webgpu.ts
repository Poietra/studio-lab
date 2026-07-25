import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import type { SceneIrBundleV1 } from "../src/engine/contracts";

type SharedFixture = Readonly<{
  assets: SceneIrBundleV1["assets"];
  sample: Readonly<{ sampleTime: number; viewport: Readonly<{ heightPx: number; widthPx: number }> }>;
  scene: SceneIrBundleV1["scene"];
}>;

type RgbaPixel = readonly [number, number, number, number];

type ReadbackProofV1 = Readonly<{
  kind: "proof";
  pixels: Readonly<{
    background: RgbaPixel;
    blueCenter: RgbaPixel;
    nonBlackBounds: readonly [number, number, number, number] | null;
    redCenter: RgbaPixel;
    surfaceFormat: string;
  }>;
  response: unknown;
}>;

function expectPixelNear(actual: RgbaPixel, expected: RgbaPixel, tolerance = 3) {
  for (const [index, component] of actual.entries()) {
    expect(Math.abs(component - expected[index])).toBeLessThanOrEqual(tolerance);
  }
}

test("samples and presents the shared Scene entirely inside a real WASM WebGPU Worker", async ({ page }) => {
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as SharedFixture;
  await page.goto("/");

  const result = await page.evaluate(async ({ assets, sample, scene }) => {
    document.body.replaceChildren();
    document.body.style.background = "black";
    document.body.style.margin = "0";
    const canvas = document.createElement("canvas");
    canvas.dataset.testid = "poietra-webgpu-proof";
    canvas.height = sample.viewport.heightPx;
    canvas.width = sample.viewport.widthPx;
    canvas.style.display = "block";
    canvas.style.height = `${sample.viewport.heightPx}px`;
    canvas.style.width = `${sample.viewport.widthPx}px`;
    document.body.append(canvas);

    const clientModuleUrl = "/src/engine/canvas-worker-client.ts";
    const { PoietraCanvasWorkerClient } = (await import(
      clientModuleUrl
    )) as typeof import("../src/engine/canvas-worker-client");
    const client = new PoietraCanvasWorkerClient({ requestTimeoutMs: 20_000 });
    const holder = globalThis as unknown as {
      poietraCanvasProofClient?: InstanceType<typeof PoietraCanvasWorkerClient>;
    };
    holder.poietraCanvasProofClient = client;
    await client.installScene({
      canvas,
      revision: scene.source.kind === "studio-edit-program" ? scene.source.revisionHash : scene.source.snapshotHash,
      snapshot: { assets, scene },
    });
    const presented = await client.render({
      revision: scene.source.kind === "studio-edit-program" ? scene.source.revisionHash : scene.source.snapshotHash,
      sampleTime: sample.sampleTime,
      viewport: sample.viewport,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      keys: Object.keys(presented).sort(),
      serialized: JSON.stringify(presented),
      value: presented,
    };
  }, fixture);

  expect(result.value).toEqual({
    kind: "frame-presented",
    packetId: "canvas:2",
    requestId: 2,
    revision:
      fixture.scene.source.kind === "studio-edit-program"
        ? fixture.scene.source.revisionHash
        : fixture.scene.source.snapshotHash,
    sampleTime: fixture.sample.sampleTime,
    schema: "poietra.canvas-worker-response",
    suboptimal: false,
    version: 1,
    viewport: fixture.sample.viewport,
  });
  expect(result.keys).toEqual([
    "kind",
    "packetId",
    "requestId",
    "revision",
    "sampleTime",
    "schema",
    "suboptimal",
    "version",
    "viewport",
  ]);
  expect(result.serialized).not.toContain("draws");
  expect(result.serialized).not.toContain("responseJson");

  const proof = await page.evaluate(async ({ assets, sample, scene }) => {
    const worker = new Worker("/e2e/engine-canvas-readback.worker.ts", { type: "module" });
    const response = new Promise<ReadbackProofV1>((resolve, reject) => {
      worker.addEventListener("error", (event) => reject(new Error(event.message || "The readback worker crashed.")), {
        once: true,
      });
      worker.addEventListener(
        "message",
        (event: MessageEvent<ReadbackProofV1 | Readonly<{ kind: "error"; message: string }>>) => {
          if (event.data.kind === "error") {
            reject(new Error(event.data.message));
            return;
          }
          resolve(event.data);
        },
        { once: true },
      );
    });
    const snapshotJson = new TextEncoder().encode(JSON.stringify({ assets, scene })).buffer;
    const requestJson = new TextEncoder().encode(
      JSON.stringify({
        evidence: ["Chromium WebGPU readback proof v1"],
        packetId: "canvas:e2e-readback",
        sampleTime: sample.sampleTime,
        schema: "poietra.engine-sample-request",
        version: 1,
        viewport: sample.viewport,
      }),
    ).buffer;
    worker.postMessage(
      {
        kind: "prove-frame",
        requestJson,
        snapshotJson,
        viewport: sample.viewport,
        wasmModuleUrl: new URL("/engine-wasm/poietra_wasm.js", location.href).href,
      },
      [requestJson, snapshotJson],
    );
    try {
      return await response;
    } finally {
      worker.terminate();
    }
  }, fixture);

  expect(proof.response).toEqual({
    result: {
      kind: "presented",
      packetId: "canvas:e2e-readback",
      sampleTime: fixture.sample.sampleTime,
      suboptimal: false,
      viewport: fixture.sample.viewport,
    },
    schema: "poietra.canvas-render-response",
    version: 1,
  });
  expect(proof.pixels.surfaceFormat).toMatch(/^(bgra|rgba)8unorm$/);
  expect(proof.pixels.nonBlackBounds).not.toBeNull();
  expectPixelNear(proof.pixels.background, [0, 0, 0, 255]);
  expectPixelNear(proof.pixels.blueCenter, [0, 0, 255, 255]);
  expectPixelNear(proof.pixels.redCenter, [188, 0, 0, 255], 4);

  await page.evaluate(() => {
    const holder = globalThis as unknown as { poietraCanvasProofClient?: { dispose: () => void } };
    holder.poietraCanvasProofClient?.dispose();
    delete holder.poietraCanvasProofClient;
  });
});
