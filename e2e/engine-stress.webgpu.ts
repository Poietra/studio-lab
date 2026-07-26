import { readFile, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "../src/engine/contracts";
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
import { engineWebgpuStressReportSchema } from "./benchmark-report-schemas";
import {
  collectPageAdapterHintOnce,
  STRESS_DEFINITIONS,
  STRESS_VIEWPORT,
  stressBundle,
  summarizeTiming,
} from "./engine-stress-workloads";
import { WEBGPU_CHROMIUM_CHANNEL, WEBGPU_CHROMIUM_LAUNCH_ARGS } from "./webgpu-launch";

const FRAME_BUDGET_MS = 1_000 / 60;
const LONG_FRAME_MS = 25;
const VIEWPORT = STRESS_VIEWPORT;
const WARMUP_FRAMES = 30;
const MEASURED_FRAMES = 300;
const PACED_FRAMES = 301;
const CONTINUOUS_SCRUB_FRAMES = 120;

type BrowserStressResult = Readonly<{
  browser: Readonly<{ hardwareConcurrency: number; platform: string; userAgent: string }>;
  continuousScrub: Readonly<{
    burstDurationMs: number;
    finalSampleTime: number;
    fulfilledRequests: number;
    latestFulfilledSampleTime: number | null;
    otherErrors: readonly string[];
    requestedRequests: number;
    settleDurationMs: number;
    supersededRequests: number;
  }>;
  installMs: number;
  pacedAckMs: readonly number[];
  pacedFrameIntervalMs: readonly number[];
  randomSeekAckMs: readonly number[];
  workerDeviceAdapter:
    | Readonly<{ evidence: unknown; kind: "available" }>
    | Readonly<{ kind: "unavailable"; reason: string }>;
}>;

async function runBrowserStress(input: {
  bundle: SceneIrBundleV1;
  measuredFrames: number;
  pacedFrames: number;
  revision: string;
  scrubFrames: number;
  viewport: typeof VIEWPORT;
  warmupFrames: number;
}): Promise<BrowserStressResult> {
  document.body.replaceChildren();
  document.body.style.background = "black";
  document.body.style.margin = "0";
  const canvas = document.createElement("canvas");
  canvas.height = input.viewport.heightPx;
  canvas.width = input.viewport.widthPx;
  canvas.style.height = "540px";
  canvas.style.width = "960px";
  document.body.append(canvas);

  const host = (
    globalThis as {
      __poietraCanvasBenchmarkHostV1?: import("../src/engine/benchmark-host").PoietraCanvasBenchmarkHostV1;
    }
  ).__poietraCanvasBenchmarkHostV1;
  if (!host) throw new Error("The benchmark host page did not expose the canvas benchmark handle.");
  const { PoietraCanvasWorkerClient } = await host.loadCanvasWorkerClient();
  const client = new PoietraCanvasWorkerClient({ requestTimeoutMs: 60_000 });
  const render = (sampleTime: number) =>
    client.render({ revision: input.revision, sampleTime, viewport: input.viewport });

  const installStarted = performance.now();
  await client.installScene({ canvas, revision: input.revision, snapshot: input.bundle });
  const installMs = performance.now() - installStarted;
  const duration = input.bundle.scene.duration;
  const sampleTime = (frame: number, count: number) => (((frame * 197) % count) / count) * (duration - 0.001);
  const renderFrame = async (phase: string, frame: number, count: number) => {
    const requestedSampleTime = sampleTime(frame, count);
    try {
      await render(requestedSampleTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${phase} frame ${frame} at ${requestedSampleTime}: ${message}`);
    }
  };
  const randomSeekAckMs: number[] = [];
  const pacedAckMs: number[] = [];
  const pacedFrameIntervalMs: number[] = [];
  try {
    for (let frame = 0; frame < input.warmupFrames; frame += 1) {
      await renderFrame("warmup", frame, input.warmupFrames);
    }
    for (let frame = 0; frame < input.measuredFrames; frame += 1) {
      const started = performance.now();
      await renderFrame("scrub", frame, input.measuredFrames);
      randomSeekAckMs.push(performance.now() - started);
    }
    let previousPresentedAt: number | null = null;
    for (let frame = 0; frame < input.pacedFrames; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const started = performance.now();
      await renderFrame("paced", frame, input.pacedFrames);
      const presentedAt = performance.now();
      pacedAckMs.push(presentedAt - started);
      if (previousPresentedAt !== null) pacedFrameIntervalMs.push(presentedAt - previousPresentedAt);
      previousPresentedAt = presentedAt;
    }

    const outcomes: Promise<void>[] = [];
    let fulfilledRequests = 0;
    let latestFulfilledSampleTime: number | null = null;
    let supersededRequests = 0;
    const otherErrors: string[] = [];
    const burstStarted = performance.now();
    let finalSampleTime = 0;
    for (let frame = 0; frame < input.scrubFrames; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      finalSampleTime = sampleTime(frame, input.scrubFrames);
      outcomes.push(
        render(finalSampleTime)
          .then((response) => {
            fulfilledRequests += 1;
            latestFulfilledSampleTime = response.sampleTime;
          })
          .catch((error: unknown) => {
            const candidate = error as { code?: unknown; message?: unknown };
            if (candidate.code === "stale-response") {
              supersededRequests += 1;
              return;
            }
            otherErrors.push(typeof candidate.message === "string" ? candidate.message : String(error));
          }),
      );
    }
    const burstDurationMs = performance.now() - burstStarted;
    const settleStarted = performance.now();
    await Promise.all(outcomes);
    const settleDurationMs = performance.now() - settleStarted;

    let workerDeviceAdapter: { evidence: unknown; kind: "available" } | { kind: "unavailable"; reason: string };
    try {
      workerDeviceAdapter = { evidence: (await client.collectAdapterEvidence()).evidence, kind: "available" };
    } catch (error) {
      workerDeviceAdapter = { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
    return {
      browser: {
        hardwareConcurrency: navigator.hardwareConcurrency,
        platform: navigator.platform,
        userAgent: navigator.userAgent,
      },
      continuousScrub: {
        burstDurationMs,
        finalSampleTime,
        fulfilledRequests,
        latestFulfilledSampleTime,
        otherErrors,
        requestedRequests: input.scrubFrames,
        settleDurationMs,
        supersededRequests,
      },
      installMs,
      pacedAckMs,
      pacedFrameIntervalMs,
      randomSeekAckMs,
      workerDeviceAdapter,
    };
  } finally {
    client.dispose();
    canvas.remove();
  }
}

test("records the 1080p WebGPU stress matrix", async ({ page, request }, testInfo) => {
  test.skip(process.env.POIETRA_ENGINE_BENCHMARK !== "1", "Run pnpm benchmark:engine:webgpu explicitly.");
  test.setTimeout(600_000);
  expect(testInfo.retry).toBe(0);
  expect(testInfo.project.retries).toBe(0);
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Readonly<{
    assets: unknown;
    scene: unknown;
  }>;
  const base = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
  const provenance = resolveBenchmarkProvenance();
  const wasm = await readServedWasmEvidence();
  const verifyServedBuild = makeServedBuildVerifier(request, provenance.commitIdentity);
  await verifyServedBuild();
  await page.goto("/benchmark.html");
  const devClientPresent = await page.evaluate(() => Boolean(document.querySelector('script[src*="@vite/client"]')));
  expect(devClientPresent, "the benchmark lane must not run against the HMR dev server").toBe(false);

  const workloads = [];
  let browser: BrowserStressResult["browser"] | null = null;
  for (const definition of STRESS_DEFINITIONS) {
    const bundle = stressBundle(base, definition);
    const snapshotBytes = new TextEncoder().encode(JSON.stringify(bundle)).byteLength;
    const measured = await page.evaluate(runBrowserStress, {
      bundle,
      measuredFrames: MEASURED_FRAMES,
      pacedFrames: PACED_FRAMES,
      revision: definition.revision,
      scrubFrames: CONTINUOUS_SCRUB_FRAMES,
      viewport: VIEWPORT,
      warmupFrames: WARMUP_FRAMES,
    });
    browser ??= measured.browser;
    expect(measured.browser).toEqual(browser);
    expect(measured.workerDeviceAdapter.kind, "the benchmark lane requires Worker device adapter evidence").toBe(
      "available",
    );
    expect(measured.randomSeekAckMs).toHaveLength(MEASURED_FRAMES);
    expect(measured.pacedAckMs).toHaveLength(PACED_FRAMES);
    expect(measured.pacedFrameIntervalMs).toHaveLength(PACED_FRAMES - 1);
    expect(measured.continuousScrub.otherErrors).toEqual([]);
    expect(measured.continuousScrub.fulfilledRequests + measured.continuousScrub.supersededRequests).toBe(
      CONTINUOUS_SCRUB_FRAMES,
    );
    expect(measured.continuousScrub.latestFulfilledSampleTime).toBe(measured.continuousScrub.finalSampleTime);
    const randomSeekAck = summarizeTiming(measured.randomSeekAckMs, MEASURED_FRAMES);
    const pacedAck = summarizeTiming(measured.pacedAckMs, PACED_FRAMES);
    const pacedFrameInterval = summarizeTiming(measured.pacedFrameIntervalMs, PACED_FRAMES - 1);
    const longFrameIntervals = measured.pacedFrameIntervalMs.filter((value) => value > LONG_FRAME_MS).length;
    const estimatedMissed60HzSlots = measured.pacedFrameIntervalMs.reduce(
      (total, value) => total + Math.max(0, Math.round(value / FRAME_BUDGET_MS) - 1),
      0,
    );
    workloads.push({
      budgets: {
        randomSeekAcknowledgement: { limitMs: 50, met: randomSeekAck.p95Ms <= 50 },
        stressRenderAcknowledgement: { limitMs: 33.3, met: randomSeekAck.p95Ms <= 33.3 },
      },
      continuousScrub: measured.continuousScrub,
      definition,
      installMs: measured.installMs,
      pacedPresentation: {
        acknowledgement: pacedAck,
        effectivePresentationAckFps:
          1_000 /
          (pacedFrameInterval.samplesMs.reduce((sum, value) => sum + value, 0) / pacedFrameInterval.samplesMs.length),
        estimatedMissed60HzSlotsProxy: estimatedMissed60HzSlots,
        longPresentationAckIntervalsOver25Ms: longFrameIntervals,
        presentationAckInterval: pacedFrameInterval,
      },
      randomSeekAck,
      snapshotBytes,
      snapshotSha256: canonicalSceneBundleSha256(bundle),
      workerDeviceAdapter: measured.workerDeviceAdapter,
    });
  }

  const pageAdapterHint = await page.evaluate(collectPageAdapterHintOnce);
  await verifyServedBuild();
  requireStableCommitIdentity(provenance.commitIdentity);
  const decisionEligibility = assessDecisionEligibility({
    grade: provenance.grade,
    host: collectHostEnvironment(),
    pageAdapterHintArchitecture: pageAdapterHint.kind === "available" ? pageAdapterHint.architecture : null,
    workerAdapters: workloads.map((workload) => {
      const adapter = workload.workerDeviceAdapter;
      if (adapter.kind !== "available") throw new Error("worker adapter evidence was asserted available");
      return (adapter.evidence as { adapter: { backend: string; deviceType: string; name: string } }).adapter;
    }),
  });

  const report = {
    capturedAt: new Date().toISOString(),
    decisionEligibility,
    evidenceLevel: decisionEligibility.eligible ? "decision-candidate" : "exploratory",
    provenance,
    provenanceStableThroughRun: true,
    baseFixtureId: "eng-v1-shared-circle-opacity",
    contracts: reportContracts("poietra.engine-webgpu-stress-benchmark", 2),
    configuration: {
      lane: "production-build-static-server",
      frameBudgetMs: FRAME_BUDGET_MS,
      longFrameThresholdMs: LONG_FRAME_MS,
      measuredFrames: MEASURED_FRAMES,
      pacedFrames: PACED_FRAMES,
      retries: { projectRetries: testInfo.project.retries, testRetry: testInfo.retry },
      scrubFrames: CONTINUOUS_SCRUB_FRAMES,
      viewport: VIEWPORT,
      warmupFrames: WARMUP_FRAMES,
    },
    coverage: {
      measured: [
        "shape primitives",
        "single-subpath convex filled cubic paths",
        "translation through affine-transform animation",
        "single-subpath convex filled path morph animation",
        "camera pan and zoom",
        "random-seek request-to-present acknowledgement",
        "rAF-paced changing playhead",
        "continuous scrub request coalescing",
      ],
      notMeasured: [
        "opacity animation under stress",
        "motion-path animation",
        "path-trim animation",
        "lifetime churn",
        "entity hierarchy",
        "affine rotation, scale, shear, and reflection",
        "surface suboptimal acknowledgement counts",
      ],
      rendererUnsupported: [
        {
          feature: "MathTex",
          reason:
            "Scene IR v1 has no text or glyph contract, and the current WebGPU renderer cannot render the multi-subpath/non-convex outlines MathTex requires.",
        },
        {
          feature: "PNG/image draws",
          reason: "Scene IR v1 defines images, but the current WebGPU renderer rejects them.",
        },
        {
          feature: "general vector paint",
          reason:
            "The current renderer rejects curved or multi-segment strokes, fill+stroke, multiple subpaths, and concave fills.",
        },
      ],
    },
    environment: {
      browser,
      browserLaunch: { args: [...WEBGPU_CHROMIUM_LAUNCH_ARGS], channel: WEBGPU_CHROMIUM_CHANNEL },
      host: collectHostEnvironment(),
      nodePlatform: process.platform,
      pageAdapterHint,
      wasm,
    },
    notes: [
      "This lane serves the production build from an owned static server; Worker device adapter evidence is collected after each workload's measured spans, and the page-scope hint exactly once after all workloads.",
      "Presented acknowledgements cover Worker dispatch, retained WASM evaluation, CPU tessellation, GPU submission, and surface present.",
      "They do not wait for GPU completion or browser display compositing.",
      "Paced acknowledgement intervals provide a 60 Hz deadline-slot proxy, not compositor frame telemetry.",
      "Continuous scrub counts fulfilled and superseded client requests; it is not a count of compositor-presented frames.",
      "Stress workloads validate successful acknowledgements, not pixel correctness; the shared small fixture owns readback proof.",
      "This exploratory host report omits the fixed reference-host CPU, OS-kernel, driver, and power-mode evidence required for an adoption decision.",
      "Budget booleans describe this recorded host only and do not fail CI.",
    ],
    schema: "poietra.engine-webgpu-stress-benchmark",
    version: 2,
    workloads,
  } as const;
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = testInfo.outputPath("poietra-engine-webgpu-stress-benchmark.json");
  await writeFile(reportPath, encoded);
  engineWebgpuStressReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
  await testInfo.attach("poietra-engine-webgpu-stress-benchmark", {
    contentType: "application/json",
    path: reportPath,
  });
  process.stdout.write(
    `\npoietra-engine-webgpu-stress=${JSON.stringify({
      pageAdapterHint: report.environment.pageAdapterHint,
      workloads: report.workloads.map((workload) => ({
        effectivePresentationAckFps: workload.pacedPresentation.effectivePresentationAckFps,
        entityCount: workload.definition.entityCount,
        fulfilledRequests: workload.continuousScrub.fulfilledRequests,
        id: workload.definition.id,
        longPresentationAckIntervals: workload.pacedPresentation.longPresentationAckIntervalsOver25Ms,
        presentationAckIntervalP99Ms: workload.pacedPresentation.presentationAckInterval.p99Ms,
        randomSeekP95Ms: workload.randomSeekAck.p95Ms,
        randomSeekP99Ms: workload.randomSeekAck.p99Ms,
        supersededRequests: workload.continuousScrub.supersededRequests,
      })),
    })}\n`,
  );
});
