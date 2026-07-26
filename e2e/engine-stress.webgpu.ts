import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import {
  type AnimationChannelV1,
  type CubicPathV1,
  type EngineAffineTransformV1,
  type SceneEntityV1,
  type SceneIrBundleV1,
  sceneIrBundleV1Schema,
} from "../src/engine/contracts";

const FRAME_BUDGET_MS = 1_000 / 60;
const LONG_FRAME_MS = 25;
const VIEWPORT = { heightPx: 1_080, widthPx: 1_920 } as const;
const WARMUP_FRAMES = 30;
const MEASURED_FRAMES = 300;
const PACED_FRAMES = 301;
const CONTINUOUS_SCRUB_FRAMES = 120;

type StressDefinition = Readonly<{
  entityCount: 100 | 1_000;
  id: string;
  profile: "animated-cubic-paths" | "shape-primitives";
  revision: string;
}>;

const STRESS_DEFINITIONS: readonly StressDefinition[] = [
  { entityCount: 100, id: "shape-primitives-100", profile: "shape-primitives", revision: "1".repeat(64) },
  { entityCount: 1_000, id: "shape-primitives-1000", profile: "shape-primitives", revision: "2".repeat(64) },
  { entityCount: 100, id: "animated-cubic-paths-100", profile: "animated-cubic-paths", revision: "3".repeat(64) },
  {
    entityCount: 1_000,
    id: "animated-cubic-paths-1000",
    profile: "animated-cubic-paths",
    revision: "4".repeat(64),
  },
];

type TimingSummary = Readonly<{
  maximumMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  samplesMs: readonly number[];
}>;

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
  pageAdapterHint: Readonly<{ architecture: string; description: string; device: string; vendor: string }> | null;
  pacedAckMs: readonly number[];
  pacedFrameIntervalMs: readonly number[];
  randomSeekAckMs: readonly number[];
}>;

const IDENTITY: EngineAffineTransformV1 = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 };

function gridPosition(index: number, count: number) {
  const columns = Math.ceil(Math.sqrt((count * 16) / 9));
  const rows = Math.ceil(count / columns);
  const cellWidth = 14.4 / columns;
  const cellHeight = 7.6 / rows;
  return {
    cellHeight,
    cellWidth,
    x: -7.2 + ((index % columns) + 0.5) * cellWidth,
    y: 3.8 - (Math.floor(index / columns) + 0.5) * cellHeight,
  };
}

function color(index: number) {
  return {
    alpha: 1,
    blue: 0.25 + ((index * 17) % 60) / 100,
    green: 0.25 + ((index * 29) % 60) / 100,
    red: 0.25 + ((index * 43) % 60) / 100,
  };
}

function ellipsePath(center: Readonly<{ x: number; y: number }>, radiusX: number, radiusY: number): CubicPathV1 {
  const kappa = 0.552_284_749_830_793_6;
  return {
    subpaths: [
      {
        closed: true,
        segments: [
          {
            control1: { x: center.x + radiusX, y: center.y + kappa * radiusY },
            control2: { x: center.x + kappa * radiusX, y: center.y + radiusY },
            end: { x: center.x, y: center.y + radiusY },
          },
          {
            control1: { x: center.x - kappa * radiusX, y: center.y + radiusY },
            control2: { x: center.x - radiusX, y: center.y + kappa * radiusY },
            end: { x: center.x - radiusX, y: center.y },
          },
          {
            control1: { x: center.x - radiusX, y: center.y - kappa * radiusY },
            control2: { x: center.x - kappa * radiusX, y: center.y - radiusY },
            end: { x: center.x, y: center.y - radiusY },
          },
          {
            control1: { x: center.x + kappa * radiusX, y: center.y - radiusY },
            control2: { x: center.x + radiusX, y: center.y - kappa * radiusY },
            end: { x: center.x + radiusX, y: center.y },
          },
        ],
        start: { x: center.x + radiusX, y: center.y },
      },
    ],
  };
}

function shapeEntity(index: number, count: number): SceneEntityV1 {
  const position = gridPosition(index, count);
  const size = Math.min(position.cellWidth, position.cellHeight);
  const id = `stress:shape:${index}`;
  const common = {
    id,
    lifetimes: [{ end: 4, start: 0 }],
    parentId: null,
    provenanceId: "stress-fixture",
    sceneOrder: index,
    sourceZIndex: index,
    transform: IDENTITY,
  } as const;
  if (index % 3 === 2) {
    return {
      ...common,
      appearance: {
        fill: null,
        kind: "vector",
        opacity: 0.9,
        stroke: {
          cap: "round",
          color: color(index),
          join: "miter",
          miterLimit: 4,
          widthWorld: Math.max(0.01, size * 0.12),
        },
      },
      geometry: {
        end: { x: position.x + position.cellWidth * 0.3, y: position.y + position.cellHeight * 0.2 },
        kind: "line",
        start: { x: position.x - position.cellWidth * 0.3, y: position.y - position.cellHeight * 0.2 },
      },
    };
  }
  return {
    ...common,
    appearance: { fill: { color: color(index), rule: "nonzero" }, kind: "vector", opacity: 0.9, stroke: null },
    geometry:
      index % 3 === 0
        ? { center: { x: position.x, y: position.y }, kind: "circle", radius: size * 0.28 }
        : {
            center: { x: position.x, y: position.y },
            cornerRadius: size * 0.08,
            height: position.cellHeight * 0.55,
            kind: "rectangle",
            width: position.cellWidth * 0.55,
          },
  };
}

function animatedCubicEntity(index: number, count: number): SceneEntityV1 {
  const position = gridPosition(index, count);
  const radiusX = position.cellWidth * 0.28;
  const radiusY = position.cellHeight * 0.28;
  return {
    appearance: { fill: { color: color(index), rule: "nonzero" }, kind: "vector", opacity: 0.9, stroke: null },
    geometry: { kind: "cubic-path", path: ellipsePath(position, radiusX, radiusY) },
    id: `stress:cubic:${index}`,
    lifetimes: [{ end: 4, start: 0 }],
    parentId: null,
    provenanceId: "stress-fixture",
    sceneOrder: index,
    sourceZIndex: index,
    transform: IDENTITY,
  };
}

function animatedChannel(index: number, count: number): AnimationChannelV1 {
  const entityId = `stress:cubic:${index}`;
  const position = gridPosition(index, count);
  if (index % 2 === 0) {
    return {
      entityId,
      id: `stress:affine:${index}`,
      keyframes: [
        {
          at: 0,
          easingToNext: { kind: "cubic-bezier", x1: 0.42, x2: 0.58, y1: 0, y2: 1 },
          value: IDENTITY,
        },
        {
          at: 4,
          easingToNext: null,
          value: { ...IDENTITY, tx: (index % 4 === 0 ? 1 : -1) * position.cellWidth * 0.3 },
        },
      ],
      kind: "affine-transform",
      provenanceId: "stress-fixture",
    };
  }
  const radiusX = position.cellWidth * 0.28;
  const radiusY = position.cellHeight * 0.28;
  return {
    entityId,
    id: `stress:morph:${index}`,
    keyframes: [
      {
        at: 0,
        easingToNext: { kind: "cubic-bezier", x1: 0.25, x2: 0.75, y1: 0.1, y2: 1 },
        value: ellipsePath(position, radiusX, radiusY),
      },
      {
        at: 4,
        easingToNext: null,
        value: ellipsePath(position, radiusX * 0.72, radiusY * 1.18),
      },
    ],
    kind: "path-morph",
    provenanceId: "stress-fixture",
  };
}

function stressBundle(base: SceneIrBundleV1, definition: StressDefinition) {
  const animated = definition.profile === "animated-cubic-paths";
  const entities = Array.from({ length: definition.entityCount }, (_, index) =>
    animated ? animatedCubicEntity(index, definition.entityCount) : shapeEntity(index, definition.entityCount),
  );
  const animationChannels: AnimationChannelV1[] = animated
    ? [
        ...Array.from({ length: definition.entityCount }, (_, index) => animatedChannel(index, definition.entityCount)),
        {
          id: "stress:camera",
          keyframes: [
            {
              at: 0,
              easingToNext: { kind: "smooth" },
              value: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
            },
            {
              at: 4,
              easingToNext: null,
              value: { center: { x: 0.3, y: -0.2 }, frameHeight: 8.1, frameWidth: 14.4 },
            },
          ],
          kind: "camera",
          provenanceId: "stress-fixture",
        },
      ]
    : [];
  return sceneIrBundleV1Schema.parse({
    assets: base.assets,
    scene: {
      ...base.scene,
      animationChannels,
      duration: 4,
      entities,
      provenance: [
        {
          evidence: [`Generated ${definition.id} WebGPU stress workload`],
          id: "stress-fixture",
          origin: "fixture",
        },
      ],
      requiredCapabilities: animated
        ? ["affine-transform-animation", "camera-animation", "cubic-path-geometry", "path-morph-animation"]
        : ["shape-primitives"],
      sceneId: `stress:${definition.id}`,
      source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: definition.revision },
    },
  });
}

function summarizeTiming(samples: readonly number[]): TimingSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    maximumMs: sorted.at(-1)!,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    samplesMs: [...samples],
  };
}

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

  const clientModuleUrl = "/src/engine/canvas-worker-client.ts";
  const { PoietraCanvasWorkerClient } = (await import(
    clientModuleUrl
  )) as typeof import("../src/engine/canvas-worker-client");
  const client = new PoietraCanvasWorkerClient({ requestTimeoutMs: 60_000 });
  const render = (sampleTime: number) =>
    client.render({ revision: input.revision, sampleTime, viewport: input.viewport });
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
      pageAdapterHint: adapterInfo,
      pacedAckMs,
      pacedFrameIntervalMs,
      randomSeekAckMs,
    };
  } finally {
    client.dispose();
    canvas.remove();
  }
}

test("records the 1080p WebGPU stress matrix", async ({ page }, testInfo) => {
  test.skip(process.env.POIETRA_ENGINE_BENCHMARK !== "1", "Run pnpm benchmark:engine:webgpu explicitly.");
  test.setTimeout(600_000);
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Readonly<{
    assets: unknown;
    scene: unknown;
  }>;
  const base = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
  const wasmBytes = await readFile("public/engine-wasm/poietra_wasm_bg.wasm");
  const wasm = {
    byteLength: wasmBytes.byteLength,
    sha256: createHash("sha256").update(wasmBytes).digest("hex"),
  };
  await page.goto("/");

  const workloads = [];
  let pageAdapterHint: BrowserStressResult["pageAdapterHint"] = null;
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
    pageAdapterHint ??= measured.pageAdapterHint;
    browser ??= measured.browser;
    expect(measured.pageAdapterHint).toEqual(pageAdapterHint);
    expect(measured.browser).toEqual(browser);
    expect(measured.randomSeekAckMs).toHaveLength(MEASURED_FRAMES);
    expect(measured.pacedAckMs).toHaveLength(PACED_FRAMES);
    expect(measured.pacedFrameIntervalMs).toHaveLength(PACED_FRAMES - 1);
    expect(measured.continuousScrub.otherErrors).toEqual([]);
    expect(measured.continuousScrub.fulfilledRequests + measured.continuousScrub.supersededRequests).toBe(
      CONTINUOUS_SCRUB_FRAMES,
    );
    expect(measured.continuousScrub.latestFulfilledSampleTime).toBe(measured.continuousScrub.finalSampleTime);
    const randomSeekAck = summarizeTiming(measured.randomSeekAckMs);
    const pacedAck = summarizeTiming(measured.pacedAckMs);
    const pacedFrameInterval = summarizeTiming(measured.pacedFrameIntervalMs);
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
    });
  }

  const report = {
    capturedAt: new Date().toISOString(),
    evidenceLevel: "exploratory",
    configuration: {
      frameBudgetMs: FRAME_BUDGET_MS,
      longFrameThresholdMs: LONG_FRAME_MS,
      measuredFrames: MEASURED_FRAMES,
      pacedFrames: PACED_FRAMES,
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
      nodePlatform: process.platform,
      pageAdapterHint,
      wasm,
    },
    notes: [
      "Presented acknowledgements cover Worker dispatch, retained WASM evaluation, CPU tessellation, GPU submission, and surface present.",
      "They do not wait for GPU completion or browser display compositing.",
      "Paced acknowledgement intervals provide a 60 Hz deadline-slot proxy, not compositor frame telemetry.",
      "Continuous scrub counts fulfilled and superseded client requests; it is not a count of compositor-presented frames.",
      "Stress workloads validate successful acknowledgements, not pixel correctness; the shared small fixture owns readback proof.",
      "This exploratory host report omits the fixed reference-host CPU, OS-kernel, driver, and power-mode evidence required for an adoption decision.",
      "Budget booleans describe this recorded host only and do not fail CI.",
    ],
    schema: "poietra.engine-webgpu-stress-benchmark",
    version: 1,
    workloads,
  } as const;
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = testInfo.outputPath("poietra-engine-webgpu-stress-benchmark.json");
  await writeFile(reportPath, encoded);
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
