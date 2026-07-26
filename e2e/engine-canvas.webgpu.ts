import { readFile, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import type { SceneIrBundleV1 } from "../src/engine/contracts";
import {
  assessDecisionEligibility,
  canonicalSceneBundleSha256,
  collectHostEnvironment,
  readServedWasmEvidence,
  reportContracts,
  requireStableCommitIdentity,
  resolveBenchmarkProvenance,
} from "./benchmark-environment";
import { makeServedBuildVerifier } from "./benchmark-manifest";
import { engineWebgpuBenchmarkReportSchema } from "./benchmark-report-schemas";
import { summarizeTiming } from "./engine-stress-workloads";
import { WEBGPU_CHROMIUM_CHANNEL, WEBGPU_CHROMIUM_LAUNCH_ARGS } from "./webgpu-launch";

const COLD_PROCESS_RUNS = 20;

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

test("records retained Worker latency without making CI hardware an adoption oracle", async ({
  page,
  playwright,
  request,
}, testInfo) => {
  test.skip(process.env.POIETRA_ENGINE_BENCHMARK !== "1", "Run pnpm benchmark:engine:webgpu explicitly.");
  test.setTimeout(600_000);
  expect(testInfo.retry).toBe(0);
  expect(testInfo.project.retries).toBe(0);
  const provenance = resolveBenchmarkProvenance();
  const wasm = await readServedWasmEvidence();
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as SharedFixture;
  const baseUrl = testInfo.project.use.baseURL;
  if (!baseUrl) throw new Error("The benchmark lane requires an explicit baseURL from its own config.");
  const benchmarkPageUrl = `${baseUrl}/benchmark.html`;
  const verifyServedBuild = makeServedBuildVerifier(request, provenance.commitIdentity);
  await verifyServedBuild();

  const coldBrowserLaunchMs: number[] = [];
  const coldPageLoadMs: number[] = [];
  const coldClientImportToSceneReadyMs: number[] = [];
  const coldRuns: { run: number; sceneReadyMs: number; workerDeviceAdapter: unknown }[] = [];
  for (let run = 0; run < COLD_PROCESS_RUNS; run += 1) {
    const launchStarted = performance.now();
    const coldBrowser = await playwright.chromium.launch({
      args: [...WEBGPU_CHROMIUM_LAUNCH_ARGS],
      channel: WEBGPU_CHROMIUM_CHANNEL,
    });
    coldBrowserLaunchMs.push(performance.now() - launchStarted);
    try {
      const coldPage = await coldBrowser.newPage();
      const loadStarted = performance.now();
      await coldPage.goto(benchmarkPageUrl);
      coldPageLoadMs.push(performance.now() - loadStarted);
      const coldResult = await coldPage.evaluate(async ({ assets, sample, scene }) => {
        const started = performance.now();
        const host = (
          globalThis as {
            __poietraCanvasBenchmarkHostV1?: import("../src/engine/benchmark-host").PoietraCanvasBenchmarkHostV1;
          }
        ).__poietraCanvasBenchmarkHostV1;
        if (!host) throw new Error("The benchmark host page did not expose the canvas benchmark handle.");
        const { PoietraCanvasWorkerClient } = await host.loadCanvasWorkerClient();
        const revision =
          scene.source.kind === "studio-edit-program" ? scene.source.revisionHash : scene.source.snapshotHash;
        const canvas = document.createElement("canvas");
        canvas.height = sample.viewport.heightPx;
        canvas.width = sample.viewport.widthPx;
        document.body.append(canvas);
        const client = new PoietraCanvasWorkerClient({ requestTimeoutMs: 20_000 });
        try {
          await client.installScene({ canvas, revision, snapshot: { assets, scene } });
          const sceneReadyMs = performance.now() - started;
          const workerDeviceAdapter = (await client.collectAdapterEvidence()).evidence;
          return { sceneReadyMs, workerDeviceAdapter };
        } finally {
          client.dispose();
          canvas.remove();
        }
      }, fixture);
      coldClientImportToSceneReadyMs.push(coldResult.sceneReadyMs);
      coldRuns.push({
        run,
        sceneReadyMs: coldResult.sceneReadyMs,
        workerDeviceAdapter: coldResult.workerDeviceAdapter,
      });
    } finally {
      await coldBrowser.close();
    }
  }

  await page.goto("/benchmark.html");
  const devClientPresent = await page.evaluate(() => Boolean(document.querySelector('script[src*="@vite/client"]')));
  expect(devClientPresent, "the benchmark lane must not run against the HMR dev server").toBe(false);

  const samples = await page.evaluate(async ({ assets, sample, scene }) => {
    const host = (
      globalThis as {
        __poietraCanvasBenchmarkHostV1?: import("../src/engine/benchmark-host").PoietraCanvasBenchmarkHostV1;
      }
    ).__poietraCanvasBenchmarkHostV1;
    if (!host) throw new Error("The benchmark host page did not expose the canvas benchmark handle.");
    const { PoietraCanvasWorkerClient } = await host.loadCanvasWorkerClient();
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

    const canvas = makeCanvas();
    const client = new PoietraCanvasWorkerClient({ requestTimeoutMs: 20_000 });
    const render = (sampleTime: number) => client.render({ revision, sampleTime, viewport: sample.viewport });
    const warmFrameMs: number[] = [];
    const scrubAckMs: number[] = [];
    let workerDeviceAdapter: { evidence: unknown; kind: "available" } | { kind: "unavailable"; reason: string };
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
      try {
        workerDeviceAdapter = { evidence: (await client.collectAdapterEvidence()).evidence, kind: "available" };
      } catch (error) {
        workerDeviceAdapter = { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      client.dispose();
      canvas.remove();
    }

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

    return {
      adapterInfo,
      environment: {
        hardwareConcurrency: navigator.hardwareConcurrency,
        platform: navigator.platform,
        userAgent: navigator.userAgent,
      },
      scrubAckMs,
      warmFrameMs,
      workerDeviceAdapter,
    };
  }, fixture);

  expect(samples.workerDeviceAdapter.kind, "the benchmark lane requires Worker device adapter evidence").toBe(
    "available",
  );

  await verifyServedBuild();
  requireStableCommitIdentity(provenance.commitIdentity);
  const workerAdapters = [
    ...coldRuns.map(
      (entry) =>
        (entry.workerDeviceAdapter as { adapter: { backend: string; deviceType: string; name: string } }).adapter,
    ),
    (samples.workerDeviceAdapter as { evidence: { adapter: { backend: string; deviceType: string; name: string } } })
      .evidence.adapter,
  ];
  const decisionEligibility = assessDecisionEligibility({
    grade: provenance.grade,
    host: collectHostEnvironment(),
    pageAdapterHintArchitecture: samples.adapterInfo?.architecture ?? null,
    workerAdapters,
  });

  const coldBrowserLaunch = summarizeTiming(coldBrowserLaunchMs, COLD_PROCESS_RUNS);
  const coldPageLoad = summarizeTiming(coldPageLoadMs, COLD_PROCESS_RUNS);
  const coldClientImportToSceneReady = summarizeTiming(coldClientImportToSceneReadyMs, COLD_PROCESS_RUNS);
  const warmFrame = summarizeTiming(samples.warmFrameMs, 300);
  const scrubAck = summarizeTiming(samples.scrubAckMs, 300);
  const report = {
    budgets: {
      coldClientImportToSceneReady: { limitMs: 1_000, met: coldClientImportToSceneReady.p95Ms <= 1_000 },
      scrubAck: { limitMs: 50, met: scrubAck.p95Ms <= 50 },
      warmFrame: { limitMs: 16.7, met: warmFrame.p95Ms <= 16.7 },
    },
    capturedAt: new Date().toISOString(),
    decisionEligibility,
    evidenceLevel: decisionEligibility.eligible ? "decision-candidate" : "exploratory",
    provenance,
    provenanceStableThroughRun: true,
    contracts: reportContracts("poietra.engine-webgpu-benchmark", 2),
    configuration: {
      coldProcessRuns: COLD_PROCESS_RUNS,
      lane: "production-build-static-server",
      measuredFrames: 300,
      retries: { projectRetries: testInfo.project.retries, testRetry: testInfo.retry },
      viewport: fixture.sample.viewport,
      warmupFrames: 30,
    },
    snapshotSha256: canonicalSceneBundleSha256({ assets: fixture.assets, scene: fixture.scene }),
    coldRuns,
    environment: {
      ...samples.environment,
      browserLaunch: { args: [...WEBGPU_CHROMIUM_LAUNCH_ARGS], channel: WEBGPU_CHROMIUM_CHANNEL },
      host: collectHostEnvironment(),
      pageAdapterHint: samples.adapterInfo,
      wasm,
      workerDeviceAdapter: samples.workerDeviceAdapter,
    },
    baseFixtureId: "eng-v1-shared-circle-opacity",
    metrics: { coldBrowserLaunch, coldClientImportToSceneReady, coldPageLoad, scrubAck, warmFrame },
    notes: [
      "This lane serves the production build from an owned static server on its own port; the HMR dev server is never part of benchmark evidence.",
      "Each cold sample launches an independent Chromium process with a fresh profile. coldClientImportToSceneReady starts at the dynamic client-chunk import AFTER the page has loaded — it excludes HTML/entry load (coldPageLoad) and covers chunk fetch, Worker spawn, WASM instantiation, device, surface, and retained Scene install. Each cold run records its own Worker adapter evidence in coldRuns.",
      "OS filesystem and GPU driver caches are outside this harness's control and may remain warm across cold processes.",
      "Scrub measures request dispatch through the correlated presented acknowledgement, not display compositing or input handling.",
      "workerDeviceAdapter is the Worker's own device adapter evidence and pageAdapterHint is the page-scope navigator.gpu hint; both are collected only after every measured span, page hint last.",
      "Percentiles are nearest-rank values recomputed from the attached raw samples.",
      "Budget booleans describe this recorded host only and are not CI pass/fail assertions; decisionEligibility states whether this run may count as decision evidence.",
    ],
    schema: "poietra.engine-webgpu-benchmark",
    version: 2,
  } as const;
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = testInfo.outputPath("poietra-engine-webgpu-benchmark.json");
  await writeFile(reportPath, encoded);
  engineWebgpuBenchmarkReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
  await testInfo.attach("poietra-engine-webgpu-benchmark", { contentType: "application/json", path: reportPath });
  process.stdout.write(
    `\npoietra-engine-webgpu-benchmark=${JSON.stringify({
      budgets: report.budgets,
      coldBrowserLaunchP95Ms: report.metrics.coldBrowserLaunch.p95Ms,
      coldClientImportToSceneReadyP95Ms: report.metrics.coldClientImportToSceneReady.p95Ms,
      coldPageLoadP95Ms: report.metrics.coldPageLoad.p95Ms,
      decisionEligible: report.decisionEligibility.eligible,
      pageAdapterHint: report.environment.pageAdapterHint,
      scrubAckP95Ms: report.metrics.scrubAck.p95Ms,
      warmFrameP95Ms: report.metrics.warmFrame.p95Ms,
    })}\n`,
  );
});
