import { readFile, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import {
  CANVAS_TELEMETRY_ADDITIVE_PHASES,
  type CanvasFrameTelemetryV1,
  canvasTelemetryAttributionViolation,
} from "../src/engine/canvas-worker-protocol";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "../src/engine/contracts";
import {
  assessDecisionEligibility,
  canonicalSceneBundleSha256,
  collectHostEnvironment,
  readPinnedReferenceHostProfile,
  readServedWasmEvidence,
  reportContracts,
  requireReferenceHostPreflight,
  requireStableCommitIdentity,
  requireStableReferenceHostEnvironment,
  resolveBenchmarkProvenance,
  type WorkerAdapterIdentity,
} from "./benchmark-environment";
import { makeServedBuildVerifier } from "./benchmark-manifest";
import {
  ENGINE_MEMORY_BUDGET_BYTES,
  ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT,
  ENGINE_STAGE_TELEMETRY_WARMUP_COUNT,
  ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_SCHEMA,
  ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION,
  engineWebgpuStageTelemetryReportSchema,
} from "./benchmark-report-schemas";
import {
  collectPageAdapterHintOnce,
  IMAGE_GEOMETRY_UPLOAD_BYTES_PER_DRAW,
  STAGE_TELEMETRY_COUNT_NAMES,
  STAGE_TELEMETRY_PHASE_NAMES,
  STRESS_DEFINITIONS,
  STRESS_VIEWPORT,
  stressBundle,
  summarizeSignedTiming,
  summarizeTiming,
} from "./engine-stress-workloads";
import { WEBGPU_CHROMIUM_CHANNEL, WEBGPU_CHROMIUM_LAUNCH_ARGS } from "./webgpu-launch";

const VIEWPORT = STRESS_VIEWPORT;
const WARMUP_FRAMES = ENGINE_STAGE_TELEMETRY_WARMUP_COUNT;
const TELEMETRY_FRAMES = ENGINE_STAGE_TELEMETRY_SAMPLE_COUNT;

/** Semantic per-frame work that remains mandatory across cache/buffer strategies. */
const REQUIRED_MEASURED_PHASES = [
  "evaluate",
  "prepare",
  "surfaceAcquire",
  "commandEncodeTotal",
  "drawRecord",
  "submit",
  "present",
  "gpuErrorScopeResolution",
  "gpuQueueSubmittedWorkDone",
] as const;

/**
 * Clock-quantization tolerance for the attribution invariant: Chromium
 * quantizes performance.now() to 0.1ms, so summing 12 phase intervals can
 * legitimately land slightly above the single total interval.
 */
const ATTRIBUTION_TOLERANCE_MS = 2;

/** Phases nothing in this architecture observes; they must stay unavailable. */
const REQUIRED_UNAVAILABLE_PHASES = ["gpuExecution", "browserComposite"] as const;

type WorkerDeviceAdapter =
  | Readonly<{ evidence: unknown; kind: "available" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

type TelemetryFrameRecord = Readonly<{
  ackMs: number;
  frameIndex: number;
  packetId: string;
  requestId: number;
  requestedSampleTime: number;
  sampleTime: number;
  suboptimal: boolean;
  telemetry: CanvasFrameTelemetryV1;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
}>;

type BrowserTelemetryResult = Readonly<{
  browser: Readonly<{ hardwareConcurrency: number; platform: string; userAgent: string }>;
  frames: readonly TelemetryFrameRecord[];
  installMs: number;
  workerDeviceAdapter: WorkerDeviceAdapter;
}>;

type SerializedPngAssetPayload = Readonly<{
  assetId: string;
  encodedBytes: readonly number[];
}>;

async function runBrowserStageTelemetry(input: {
  assetPayloads: readonly SerializedPngAssetPayload[];
  bundle: SceneIrBundleV1;
  revision: string;
  telemetryFrames: number;
  viewport: typeof VIEWPORT;
  warmupFrames: number;
}): Promise<BrowserTelemetryResult> {
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

  try {
    const assetById = new Map(input.bundle.assets.assets.map((asset) => [asset.id, asset]));
    const assetPayloads = input.assetPayloads.map(({ assetId, encodedBytes }) => {
      const asset = assetById.get(assetId);
      if (!asset || asset.kind !== "png-image") {
        throw new Error(`The benchmark payload references unknown PNG asset ${assetId}.`);
      }
      return {
        assetId,
        byteLength: asset.byteLength,
        bytes: Uint8Array.from(encodedBytes).buffer,
        mediaType: asset.mediaType,
        pixelHeight: asset.pixelHeight,
        pixelWidth: asset.pixelWidth,
        sha256: asset.sha256,
      } as const;
    });
    const installStarted = performance.now();
    await client.installScene({ assetPayloads, canvas, revision: input.revision, snapshot: input.bundle });
    const installMs = performance.now() - installStarted;

    const duration = input.bundle.scene.duration;
    const sampleTimeFor = (frame: number, count: number) => (((frame * 197) % count) / count) * (duration - 0.001);
    const yieldFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    for (let frame = 0; frame < input.warmupFrames; frame += 1) {
      await yieldFrame();
      await client.renderTelemetry({
        revision: input.revision,
        sampleTime: sampleTimeFor(frame, input.warmupFrames),
        viewport: input.viewport,
      });
    }

    const frames: TelemetryFrameRecord[] = [];
    for (let frame = 0; frame < input.telemetryFrames; frame += 1) {
      await yieldFrame();
      const requestedSampleTime = sampleTimeFor(frame, input.telemetryFrames);
      const started = performance.now();
      const presented = await client.renderTelemetry({
        revision: input.revision,
        sampleTime: requestedSampleTime,
        viewport: input.viewport,
      });
      frames.push({
        ackMs: performance.now() - started,
        frameIndex: frame,
        packetId: presented.packetId,
        requestId: presented.requestId,
        requestedSampleTime,
        sampleTime: presented.sampleTime,
        suboptimal: presented.suboptimal,
        telemetry: presented.telemetry,
        viewport: presented.viewport,
      });
    }

    let workerDeviceAdapter: { evidence: unknown; kind: "available" } | { kind: "unavailable"; reason: string };
    try {
      workerDeviceAdapter = { evidence: (await client.collectAdapterEvidence()).evidence, kind: "available" };
    } catch (error) {
      workerDeviceAdapter = {
        kind: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      browser: {
        hardwareConcurrency: navigator.hardwareConcurrency,
        platform: navigator.platform,
        userAgent: navigator.userAgent,
      },
      frames,
      installMs,
      workerDeviceAdapter,
    };
  } finally {
    client.dispose();
    canvas.remove();
  }
}

function aggregatePhases(frames: readonly TelemetryFrameRecord[]) {
  const phases: Record<
    string,
    {
      availability: { measured: number; skipped: number; unavailable: number };
      samplesMs: number[];
      summary: ReturnType<typeof summarizeTiming> | null;
      unavailableReasons: string[];
    }
  > = {};
  for (const name of STAGE_TELEMETRY_PHASE_NAMES) {
    const availability = { measured: 0, skipped: 0, unavailable: 0 };
    const samplesMs: number[] = [];
    const reasons = new Set<string>();
    for (const frame of frames) {
      const sample = frame.telemetry.phases[name];
      availability[sample.kind] += 1;
      if (sample.kind === "measured") samplesMs.push(sample.ms);
      if (sample.kind === "unavailable") reasons.add(sample.reason);
    }
    phases[name] = {
      availability,
      samplesMs,
      summary: samplesMs.length === frames.length ? summarizeTiming(samplesMs, frames.length) : null,
      unavailableReasons: [...reasons].sort(),
    };
  }
  return phases;
}

function aggregateCounts(frames: readonly TelemetryFrameRecord[]) {
  const counts: Record<string, { maximum: number; minimum: number; perFrame: number[] }> = {};
  for (const name of STAGE_TELEMETRY_COUNT_NAMES) {
    const perFrame = frames.map((frame) => {
      const value = frame.telemetry.counts[name];
      expect(value, `count ${name} must be recorded on every presented frame`).not.toBeNull();
      return value!;
    });
    counts[name] = { maximum: Math.max(...perFrame), minimum: Math.min(...perFrame), perFrame };
  }
  return counts;
}

function aggregateCaches(frames: readonly TelemetryFrameRecord[]) {
  const summary: Record<string, Record<string, number>> = {};
  for (const cache of [
    "imageSamplerBinding",
    "imageTexture",
    "pipeline",
    "preparedGeometry",
    "surfaceConfiguration",
  ] as const) {
    const outcomes: Record<string, number> = {};
    for (const frame of frames) {
      const outcome = frame.telemetry.caches[cache];
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    summary[cache] = outcomes;
  }
  const perFrame = frames.map((frame) => ({
    frameIndex: frame.frameIndex,
    imageSamplerBinding: frame.telemetry.caches.imageSamplerBinding,
    imageTexture: frame.telemetry.caches.imageTexture,
    pipeline: frame.telemetry.caches.pipeline,
    preparedGeometry: frame.telemetry.caches.preparedGeometry,
    surfaceConfiguration: frame.telemetry.caches.surfaceConfiguration,
    surfaceConfigurations: frame.telemetry.counts.surfaceConfigurations,
  }));
  return { perFrame, summary };
}

function aggregateMemory(frames: readonly TelemetryFrameRecord[]) {
  const samples = frames.map((frame) => {
    if (frame.telemetry.memory.kind !== "measured") {
      throw new Error(`engine memory must be measured on frame ${frame.frameIndex}: ${frame.telemetry.memory.reason}`);
    }
    return { frameIndex: frame.frameIndex, memory: frame.telemetry.memory };
  });
  const peakRetainedBoundaryBytes = Math.max(...samples.map(({ memory }) => memory.retainedBoundaryTotal.peakBytes));
  return {
    budget: {
      limitBytes: ENGINE_MEMORY_BUDGET_BYTES,
      met: peakRetainedBoundaryBytes <= ENGINE_MEMORY_BUDGET_BYTES,
    },
    peakRetainedBoundaryBytes,
    samples,
  };
}

/**
 * Per-frame signed attribution residual: raw totalMs minus the additive
 * (pairwise non-overlapping) measured phase sum. Never clamped — a residual
 * below the negative tolerance is an invariant violation surfaced through
 * `canvasTelemetryAttributionViolation` and fails the run.
 */
function residualMsFor(frame: TelemetryFrameRecord): number {
  let additive = 0;
  for (const name of CANVAS_TELEMETRY_ADDITIVE_PHASES) {
    const sample = frame.telemetry.phases[name];
    if (sample.kind === "measured") additive += sample.ms;
  }
  return frame.telemetry.totalMs! - additive;
}

test("records the 1080p WebGPU stage telemetry matrix", async ({ page, request }, testInfo) => {
  test.skip(process.env.POIETRA_ENGINE_BENCHMARK !== "1", "Run pnpm benchmark:engine:webgpu explicitly.");
  test.setTimeout(600_000);
  expect(testInfo.retry).toBe(0);
  expect(testInfo.project.retries).toBe(0);
  const provenance = resolveBenchmarkProvenance();
  const wasm = await readServedWasmEvidence();
  const vectorFixture = JSON.parse(
    await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8"),
  ) as Readonly<{ assetPayloads?: readonly SerializedPngAssetPayload[]; assets: unknown; id: string; scene: unknown }>;
  const imageFixture = JSON.parse(await readFile("fixtures/engine-v1/png-alpha-edge-camera.json", "utf8")) as Readonly<{
    assetPayloads: readonly SerializedPngAssetPayload[];
    assets: unknown;
    id: string;
    scene: unknown;
  }>;
  const host = collectHostEnvironment();
  const referenceHost = readPinnedReferenceHostProfile();
  const browserLaunch = { args: [...WEBGPU_CHROMIUM_LAUNCH_ARGS], channel: WEBGPU_CHROMIUM_CHANNEL };
  requireReferenceHostPreflight({ browserLaunch, host, referenceHost });
  const verifyServedBuild = makeServedBuildVerifier(request, provenance.commitIdentity);
  await verifyServedBuild();
  await page.goto("/benchmark.html");
  const browserVersion = page.context().browser()?.version();
  if (!browserVersion) throw new Error("The benchmark lane could not read the launched browser version.");
  const devClientPresent = await page.evaluate(() => Boolean(document.querySelector('script[src*="@vite/client"]')));
  expect(devClientPresent, "the benchmark lane must not run against the HMR dev server").toBe(false);

  const workloads = [];
  expect(new Set(CANVAS_TELEMETRY_ADDITIVE_PHASES).size).toBe(CANVAS_TELEMETRY_ADDITIVE_PHASES.length);
  expect(CANVAS_TELEMETRY_ADDITIVE_PHASES).not.toContain("drawRecord");

  let browser: BrowserTelemetryResult["browser"] | null = null;
  for (const definition of STRESS_DEFINITIONS) {
    const fixture = definition.profile === "png-images" ? imageFixture : vectorFixture;
    const base = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    const bundle = stressBundle(base, definition);
    const snapshotBytes = new TextEncoder().encode(JSON.stringify(bundle)).byteLength;
    const snapshotSha256 = canonicalSceneBundleSha256(bundle);
    const measured = await page.evaluate(runBrowserStageTelemetry, {
      assetPayloads: fixture.assetPayloads ?? [],
      bundle,
      revision: definition.revision,
      telemetryFrames: TELEMETRY_FRAMES,
      viewport: VIEWPORT,
      warmupFrames: WARMUP_FRAMES,
    });
    browser ??= measured.browser;

    expect(measured.workerDeviceAdapter.kind, "the benchmark lane requires actual Worker device adapter evidence").toBe(
      "available",
    );

    expect(measured.frames).toHaveLength(TELEMETRY_FRAMES);
    for (const frame of measured.frames) {
      expect(frame.packetId).toBe(`canvas:${frame.requestId}`);
      expect(frame.sampleTime).toBe(frame.requestedSampleTime);
      expect(frame.viewport).toEqual(VIEWPORT);
      expect(frame.telemetry.clock).toBe("worker-performance-now");
      expect(frame.telemetry.totalMs).not.toBeNull();
    }
    expect(new Set(measured.frames.map((frame) => frame.requestId)).size).toBe(TELEMETRY_FRAMES);

    const phases = aggregatePhases(measured.frames);
    for (const name of REQUIRED_MEASURED_PHASES) {
      expect(phases[name]!.availability, `phase ${name} must be measured on every frame`).toEqual({
        measured: TELEMETRY_FRAMES,
        skipped: 0,
        unavailable: 0,
      });
      expect(phases[name]!.summary).not.toBeNull();
    }
    for (const name of REQUIRED_UNAVAILABLE_PHASES) {
      expect(phases[name]!.availability, `phase ${name} must stay explicitly unavailable`).toEqual({
        measured: 0,
        skipped: 0,
        unavailable: TELEMETRY_FRAMES,
      });
      expect(phases[name]!.unavailableReasons.length).toBeGreaterThan(0);
    }

    const counts = aggregateCounts(measured.frames);
    for (const frame of measured.frames) {
      const frameCounts = frame.telemetry.counts;
      expect(frameCounts.evaluatedEntities).toBe(definition.entityCount);
      expect(frameCounts.evaluatedDraws).toBe(definition.entityCount);
      if (definition.profile === "png-images") expect(frameCounts.drawCalls).toBe(definition.entityCount);
    }

    const caches = aggregateCaches(measured.frames);
    for (const outcomes of Object.values(caches.summary)) {
      expect(Object.values(outcomes).reduce((total, count) => total + count, 0)).toBe(TELEMETRY_FRAMES);
    }
    if (definition.profile === "shape-primitives") {
      expect(caches.summary.preparedGeometry).toEqual({ hit: TELEMETRY_FRAMES });
      expect(counts.tessellationCalls).toMatchObject({ maximum: 0, minimum: 0 });
    }
    const memory = aggregateMemory(measured.frames);
    if (definition.profile === "png-images") {
      expect(caches.summary.imageTexture).toEqual({ hit: TELEMETRY_FRAMES });
      expect(caches.summary.imageSamplerBinding).toEqual({ hit: TELEMETRY_FRAMES });
      expect(counts.bufferCreations).toMatchObject({ maximum: 2, minimum: 2 });
      expect(counts.imageSamplerBindingCreations).toMatchObject({ maximum: 0, minimum: 0 });
      expect(counts.imageTextureEvictions).toMatchObject({ maximum: 0, minimum: 0 });
      expect(counts.imageTextureUploads).toMatchObject({ maximum: 0, minimum: 0 });
      expect(counts.tessellationCalls).toMatchObject({ maximum: 0, minimum: 0 });
      expect(counts.uploadBytes).toMatchObject({
        maximum: definition.entityCount * IMAGE_GEOMETRY_UPLOAD_BYTES_PER_DRAW,
        minimum: definition.entityCount * IMAGE_GEOMETRY_UPLOAD_BYTES_PER_DRAW,
      });
      for (const sample of memory.samples) {
        expect(sample.memory.logicalGpuBreakdown.retainedImageTextures.currentBytes).toBeGreaterThan(0);
        expect(sample.memory.wasmLinearBreakdown.decodedImageAssets.currentBytes).toBeGreaterThan(0);
      }
    }

    const attributionViolations: {
      frameIndex: number;
      violation: NonNullable<ReturnType<typeof canvasTelemetryAttributionViolation>>;
    }[] = [];
    const residualPerFrame = measured.frames.map((frame) => {
      const drawRecord = frame.telemetry.phases.drawRecord;
      const encodeTotal = frame.telemetry.phases.commandEncodeTotal;
      if (drawRecord.kind === "measured" && encodeTotal.kind === "measured") {
        expect(drawRecord.ms).toBeLessThanOrEqual(encodeTotal.ms);
      }
      const violation = canvasTelemetryAttributionViolation(frame.telemetry, ATTRIBUTION_TOLERANCE_MS);
      if (violation) attributionViolations.push({ frameIndex: frame.frameIndex, violation });
      return residualMsFor(frame);
    });
    expect(attributionViolations, "attribution invariant violations disqualify the evidence").toEqual([]);

    workloads.push({
      attributionViolations,
      caches,
      correlation: measured.frames.map((frame, index) => ({
        ackMs: frame.ackMs,
        frameIndex: frame.frameIndex,
        packetId: frame.packetId,
        requestId: frame.requestId,
        requestedSampleTime: frame.requestedSampleTime,
        residualMs: residualPerFrame[index],
        sampleTime: frame.sampleTime,
        suboptimal: frame.suboptimal,
        totalMs: frame.telemetry.totalMs,
      })),
      counts,
      definition,
      installMs: measured.installMs,
      memory,
      phases,
      residual: summarizeSignedTiming(residualPerFrame, TELEMETRY_FRAMES),
      snapshotBytes,
      snapshotSha256,
      telemetryAck: summarizeTiming(
        measured.frames.map((frame) => frame.ackMs),
        TELEMETRY_FRAMES,
      ),
      totalMsSummary: summarizeTiming(
        measured.frames.map((frame) => frame.telemetry.totalMs!),
        TELEMETRY_FRAMES,
      ),
      workerDeviceAdapter: measured.workerDeviceAdapter,
    });
  }

  const pageAdapterHint = await page.evaluate(collectPageAdapterHintOnce);
  await verifyServedBuild();
  requireStableCommitIdentity(provenance.commitIdentity);
  requireStableReferenceHostEnvironment(host, collectHostEnvironment());
  const decisionEligibility = assessDecisionEligibility({
    browserChannel: WEBGPU_CHROMIUM_CHANNEL,
    browserVersions: [browserVersion],
    grade: provenance.grade,
    host,
    pageAdapterHintArchitecture: pageAdapterHint.kind === "available" ? pageAdapterHint.architecture : null,
    referenceHost,
    requiredWorkerAdapterSamples: STRESS_DEFINITIONS.length,
    workerAdapters: workloads.map((workload) => {
      const adapter = workload.workerDeviceAdapter;
      if (adapter.kind !== "available") throw new Error("worker adapter evidence was asserted available");
      const evidence = adapter.evidence as { adapter: WorkerAdapterIdentity };
      return evidence.adapter;
    }),
  });

  const report = {
    capturedAt: new Date().toISOString(),
    decisionEligibility,
    evidenceLevel: decisionEligibility.eligible ? "decision-candidate" : "exploratory",
    provenance,
    provenanceStableThroughRun: true,
    baseFixtureIds: ["eng-v1-shared-circle-opacity", "eng-v1-png-alpha-edge-camera"],
    contracts: reportContracts(
      ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_SCHEMA,
      ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION,
    ),
    configuration: {
      additivePhases: CANVAS_TELEMETRY_ADDITIVE_PHASES,
      attributionToleranceMs: ATTRIBUTION_TOLERANCE_MS,
      interFrameYield:
        "one requestAnimationFrame before every warmup and telemetry frame, outside all measured intervals",
      lane: "production-build-static-server",
      retries: { projectRetries: testInfo.project.retries, testRetry: testInfo.retry },
      telemetryFrames: TELEMETRY_FRAMES,
      viewport: VIEWPORT,
      warmupFrames: WARMUP_FRAMES,
      warmupPath: "renderTelemetry with awaited GPU queue fence per warmup frame",
      workloadCount: STRESS_DEFINITIONS.length,
    },
    environment: {
      browser,
      browserLaunch,
      browserVersion,
      host,
      nodePlatform: process.platform,
      pageAdapterHint,
      referenceHostProfile: referenceHost.evidence,
      wasm,
    },
    memoryAccounting: {
      exclusions: [
        "browser-js-dom",
        "transient-per-frame-image-vertex-index-buffers-up-to-64-mib",
        "surface-pipeline-bind-group-sampler-and-driver-allocations-not-byte-accounted",
      ],
      observation: "post-gpu-fence-pre-response-serialization-boundary",
      peak: "maximum-raw-retained-boundary-total-peak-never-component-peak-sum",
      scope: "retained-response-boundary-logical-bytes-not-intra-frame-peak-or-process-rss",
      total: "wasm-linear-plus-logical-gpu-resident",
      wasmBreakdown: "informational-subsets-already-contained-in-wasm-linear",
    },
    measurementBoundaries: {
      browserCompositing: {
        reason:
          "The dedicated worker cannot observe browser compositor presentation; nothing in this report claims compositor FPS.",
        status: "unavailable",
      },
      gpuExecution: {
        reason: "GPU-side stage timing requires timestamp queries, which this pipeline does not request.",
        status: "unavailable",
      },
      gpuQueueCompletion: {
        meaning:
          "The gpuQueueSubmittedWorkDone phase awaits the real GPUQueue.onSubmittedWorkDone fence after submit and present on every telemetry frame.",
        status: "measured",
      },
      rafPresentationCadence: {
        meaning:
          "rAF-paced acknowledgement intervals live in the stress benchmark and are a cadence proxy, not compositor frame telemetry.",
        status: "measured-proxy-in-stress-benchmark",
      },
      requestAcknowledgement: {
        meaning:
          "telemetryAck spans client dispatch through the correlated frame-presented-telemetry response; on this opt-in path it includes the awaited GPU queue fence, so it is not comparable to production scrub acknowledgement.",
        status: "measured",
      },
    },
    notes: [
      "Stage telemetry is opt-in: the production render path returns the unchanged compact frame-presented acknowledgement with no telemetry field.",
      "This lane serves the production build from an owned static server; warmup runs through renderTelemetry so the first measured fence starts against a drained queue, and adapter evidence (Worker first, page hint last) is collected only after all measured spans.",
      "tessellationCalls is counted at actual renderer call sites, never inferred from vertex or index totals; its raw per-frame values are topology evidence, not a fixed pass/fail baseline.",
      "Telemetry frames serialize the pipeline by awaiting GPU queue completion, so they measure isolated per-frame stage cost, not pipelined throughput.",
      "vertexIndexEncode and bufferCreateAndStage are CPU-side costs; actual GPU transfer timing is not observable through this ABI.",
      "commandEncodeTotal is a labeled nested total that includes the drawRecord interval; drawRecord is therefore excluded from the additive set used for residualMs.",
      "gpuErrorScopeResolution is the awaited resolution of the three popped WebGPU error scopes and can block on GPU progress; surfaceAcquire covers surface configuration, current-texture acquisition, and view creation; postPresentReconfigure executes only on suboptimal frames.",
      "residualMs = totalMs - sum(additivePhases) per frame, signed and never clamped; totalMs starts at renderWithTelemetry entry and ends before response serialization, so the residual covers request JSON parsing/validation, correlation bookkeeping, and inter-phase control flow inside the engine — NOT response serialization or the JS/WASM call boundary, which lie outside totalMs. Residuals below the negative tolerance are machine-readable attribution violations and fail the run.",
      "Raw cache outcomes, bufferCreations, drawCalls, tessellationCalls, and uploadBytes record the implementation topology without freezing it; semantic entity/draw counts, correlation, and timing attribution remain fail-closed invariants.",
      "pageAdapterHint is the page-scope navigator.gpu hint; workerDeviceAdapter is the wgpu AdapterInfo of the adapter the Worker actually created its device with. They are reported separately and never asserted equal.",
      "All percentiles are nearest-rank values recomputed from the attached raw samples.",
      "Retained-boundary memory is the WebAssembly linear-memory allocation plus renderer-owned logical GPU cache bytes, sampled after the GPU queue fence and before response serialization. The CPU cache breakdown is already inside linear memory and is never added again; independently observed component peaks are never summed.",
      "This is not an intra-frame engine peak or browser process RSS. Browser JS/DOM; transient per-frame image vertex/index buffers (bounded separately at 64 MiB); and surface, pipeline, bind-group, sampler, and driver allocations not byte-accounted by retained caches are explicitly excluded.",
      "environment.host.commitIdentity records the HEAD commit together with the working-tree state; a dirty-tree run is not attributable to that commit alone.",
      "decisionEligibility compares OS-derived host evidence, the launched browser version, and every Worker adapter sample against the hash-verified checked-in reference profile.",
    ],
    schema: ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_SCHEMA,
    version: ENGINE_WEBGPU_STAGE_TELEMETRY_REPORT_VERSION,
    workloads,
  } as const;
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = testInfo.outputPath("poietra-engine-webgpu-stage-telemetry.json");
  await writeFile(reportPath, encoded);
  // Re-read the exact bytes published as evidence and validate every raw body.
  engineWebgpuStageTelemetryReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
  await testInfo.attach("poietra-engine-webgpu-stage-telemetry", {
    contentType: "application/json",
    path: reportPath,
  });
  process.stdout.write(
    `\npoietra-engine-webgpu-stage-telemetry=${JSON.stringify({
      workloads: report.workloads.map((workload) => ({
        evaluateP95Ms: workload.phases.evaluate!.summary?.p95Ms,
        gpuErrorScopeResolutionP95Ms: workload.phases.gpuErrorScopeResolution!.summary?.p95Ms,
        gpuQueueSubmittedWorkDoneP95Ms: workload.phases.gpuQueueSubmittedWorkDone!.summary?.p95Ms,
        id: workload.definition.id,
        memoryBudgetMet: workload.memory.budget.met,
        peakRetainedBoundaryBytes: workload.memory.peakRetainedBoundaryBytes,
        submitP95Ms: workload.phases.submit!.summary?.p95Ms,
        surfaceAcquireP95Ms: workload.phases.surfaceAcquire!.summary?.p95Ms,
        residualP95Ms: workload.residual.p95Ms,
        telemetryAckP95Ms: workload.telemetryAck.p95Ms,
        tessellateP95Ms: workload.phases.tessellate!.summary?.p95Ms,
        totalP95Ms: workload.totalMsSummary.p95Ms,
      })),
    })}\n`,
  );
});
