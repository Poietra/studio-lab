import { readFile, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import type { SceneIrBundleV1 } from "../src/engine/contracts";

type SharedFixture = Readonly<{
  assets: SceneIrBundleV1["assets"];
  sample: Readonly<{ sampleTime: number; viewport: Readonly<{ heightPx: number; widthPx: number }> }>;
  scene: SceneIrBundleV1["scene"];
}>;

type RgbaPixel = readonly [number, number, number, number];

type TimingSummary = Readonly<{
  maximumMs: number;
  p50Ms: number;
  p95Ms: number;
  samplesMs: readonly number[];
}>;

type ReadbackProofV1 = Readonly<{
  kind: "proof";
  pixels: Readonly<{
    background: RgbaPixel;
    blueCenter: RgbaPixel;
    greenCapExterior: RgbaPixel;
    greenRoundCap: RgbaPixel;
    greenStrokeCenter: RgbaPixel;
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

function summarizeTiming(samples: readonly number[]): TimingSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    maximumMs: sorted.at(-1)!,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    samplesMs: [...samples],
  };
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
  expectPixelNear(proof.pixels.greenCapExterior, [0, 0, 0, 255]);
  expectPixelNear(proof.pixels.greenRoundCap, [0, 188, 0, 255], 4);
  expectPixelNear(proof.pixels.greenStrokeCenter, [0, 188, 0, 255], 4);
  expectPixelNear(proof.pixels.redCenter, [188, 0, 0, 255], 4);

  await page.evaluate(() => {
    const holder = globalThis as unknown as { poietraCanvasProofClient?: { dispose: () => void } };
    holder.poietraCanvasProofClient?.dispose();
    delete holder.poietraCanvasProofClient;
  });
});

test("records retained Worker latency without making CI hardware an adoption oracle", async ({ page }, testInfo) => {
  test.skip(process.env.POIETRA_ENGINE_BENCHMARK !== "1", "Run pnpm benchmark:engine:webgpu explicitly.");
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as SharedFixture;
  await page.goto("/");

  const samples = await page.evaluate(async ({ assets, sample, scene }) => {
    const clientModuleUrl = "/src/engine/canvas-worker-client.ts";
    const { PoietraCanvasWorkerClient } = (await import(
      clientModuleUrl
    )) as typeof import("../src/engine/canvas-worker-client");
    const revision =
      scene.source.kind === "studio-edit-program" ? scene.source.revisionHash : scene.source.snapshotHash;
    const snapshot = { assets, scene };
    const makeCanvas = () => {
      const canvas = document.createElement("canvas");
      canvas.height = sample.viewport.heightPx;
      canvas.width = sample.viewport.widthPx;
      document.body.append(canvas);
      return canvas;
    };

    const gpu = (
      navigator as unknown as {
        gpu?: {
          requestAdapter: () => Promise<Readonly<{
            info: Readonly<{ architecture?: string; description?: string; device?: string; vendor?: string }>;
          }> | null>;
        };
      }
    ).gpu;
    const adapter = await gpu?.requestAdapter();
    const adapterInfo = adapter
      ? {
          architecture: adapter.info.architecture ?? "unreported",
          description: adapter.info.description ?? "unreported",
          device: adapter.info.device ?? "unreported",
          vendor: adapter.info.vendor ?? "unreported",
        }
      : null;

    const coldReadyMs: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const canvas = makeCanvas();
      const client = new PoietraCanvasWorkerClient({ requestTimeoutMs: 20_000 });
      const started = performance.now();
      try {
        await client.installScene({ canvas, revision, snapshot });
        coldReadyMs.push(performance.now() - started);
      } finally {
        client.dispose();
        canvas.remove();
      }
    }

    const canvas = makeCanvas();
    const client = new PoietraCanvasWorkerClient({ requestTimeoutMs: 20_000 });
    const render = (sampleTime: number) => client.render({ revision, sampleTime, viewport: sample.viewport });
    const warmFrameMs: number[] = [];
    const scrubAckMs: number[] = [];
    try {
      await client.installScene({ canvas, revision, snapshot });
      for (let frame = 0; frame < 30; frame += 1) await render(sample.sampleTime);
      for (let frame = 0; frame < 300; frame += 1) {
        const started = performance.now();
        await render(sample.sampleTime);
        warmFrameMs.push(performance.now() - started);
      }
      const scrubTimes = [0, sample.sampleTime, Math.max(0, scene.duration - 0.001)];
      for (let frame = 0; frame < 30; frame += 1) await render(scrubTimes[frame % scrubTimes.length]!);
      for (let frame = 0; frame < 300; frame += 1) {
        const started = performance.now();
        await render(scrubTimes[frame % scrubTimes.length]!);
        scrubAckMs.push(performance.now() - started);
      }
    } finally {
      client.dispose();
      canvas.remove();
    }

    return {
      adapterInfo,
      coldReadyMs,
      environment: {
        hardwareConcurrency: navigator.hardwareConcurrency,
        platform: navigator.platform,
        userAgent: navigator.userAgent,
      },
      scrubAckMs,
      warmFrameMs,
    };
  }, fixture);

  expect(samples.coldReadyMs).toHaveLength(20);
  expect(samples.warmFrameMs).toHaveLength(300);
  expect(samples.scrubAckMs).toHaveLength(300);
  expect(
    [...samples.coldReadyMs, ...samples.warmFrameMs, ...samples.scrubAckMs].every(
      (value) => Number.isFinite(value) && value >= 0,
    ),
  ).toBe(true);

  const coldReady = summarizeTiming(samples.coldReadyMs);
  const warmFrame = summarizeTiming(samples.warmFrameMs);
  const scrubAck = summarizeTiming(samples.scrubAckMs);
  const report = {
    budgets: {
      coldReady: { limitMs: 1_000, met: coldReady.p95Ms <= 1_000 },
      scrubAck: { limitMs: 50, met: scrubAck.p95Ms <= 50 },
      warmFrame: { limitMs: 16.7, met: warmFrame.p95Ms <= 16.7 },
    },
    capturedAt: new Date().toISOString(),
    configuration: {
      coldRuns: 20,
      measuredFrames: 300,
      viewport: fixture.sample.viewport,
      warmupFrames: 30,
    },
    environment: { ...samples.environment, adapter: samples.adapterInfo },
    fixtureId: "eng-v1-shared-circle-opacity",
    metrics: { coldReady, scrubAck, warmFrame },
    notes: [
      "Cold runs create a fresh Worker, WASM instance, device, surface, and retained Scene; browser caches remain warm.",
      "Scrub measures request dispatch through the correlated presented acknowledgement, not display compositing or input handling.",
      "Budget booleans describe this recorded host only and are not CI pass/fail assertions.",
    ],
    schema: "poietra.engine-webgpu-benchmark",
    version: 1,
  } as const;
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = testInfo.outputPath("poietra-engine-webgpu-benchmark.json");
  await writeFile(reportPath, encoded);
  await testInfo.attach("poietra-engine-webgpu-benchmark", { contentType: "application/json", path: reportPath });
  process.stdout.write(
    `\npoietra-engine-webgpu-benchmark=${JSON.stringify({
      adapter: report.environment.adapter,
      budgets: report.budgets,
      coldReadyP95Ms: report.metrics.coldReady.p95Ms,
      scrubAckP95Ms: report.metrics.scrubAck.p95Ms,
      warmFrameP95Ms: report.metrics.warmFrame.p95Ms,
    })}\n`,
  );
});
