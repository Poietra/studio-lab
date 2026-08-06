import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import { compareOpeningManimCairoWebGpuFramesV2, type OpeningManimWebGpuFrameV2 } from "./opening-manim-cairo-parity";
import { OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2 } from "./opening-manim-cairo-reference";
import { withGeneratedRuntimeTraceCairoReferenceV1 } from "./runtime-trace-cairo-reference-runner";
import {
  captureRuntimeTraceWebGpuFramesV1,
  OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V2,
  RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
} from "./runtime-trace-webgpu-readback";

const RUNTIME_TRACE_PATH = "/api/manim/projects/real-preview-harness/runtime-traces";
const SOURCE_PATH = "example_scenes/basic.py";
const SCENE_NAME = "OpeningManim";
const SCENE_LABEL = `${SOURCE_PATH} · ${SCENE_NAME}`;
const SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const CAIRO_PARITY_REQUIRED = process.env.POIETRA_RUNTIME_TRACE_CAIRO_PARITY_REQUIRED === "1";

type RuntimeTraceRunBody = Readonly<{
  absolutePath?: unknown;
  bundle?: SceneIrBundleV1;
  projectId?: string;
  publication?: unknown;
  requestId?: string;
  revision?: unknown;
  roots?: readonly Readonly<{
    binding: Readonly<{ id: string; name: string; ordinal: number }>;
    entityId: string;
  }>[];
  runtimeConfigHash?: string;
  sceneId?: string;
  sceneName?: string;
  schema?: string;
  sourceHash?: string;
  sourceAbsolutePath?: unknown;
  sourcePath?: string;
  sourceText?: unknown;
  status?: string;
  traceDigest?: string;
  version?: number;
}>;

function runtimeTraceResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === RUNTIME_TRACE_PATH &&
      response.status() === 200,
  );
}

async function verifiedOpeningRuntimeTrace(page: Page) {
  await page.addInitScript(() => {
    const requestKinds: string[] = [];
    const NativeWorker = globalThis.Worker;
    const studioCanvasWorkers = new WeakSet<Worker>();
    class ObservedWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        if (new URL(String(scriptURL), location.href).pathname.includes("poietra-canvas")) {
          studioCanvasWorkers.add(this);
        }
      }

      override postMessage(message: unknown, transferOrOptions?: StructuredSerializeOptions | Transferable[]) {
        if (studioCanvasWorkers.has(this)) {
          const kind = (message as Readonly<{ kind?: unknown }>).kind;
          if (typeof kind === "string") requestKinds.push(kind);
        }
        if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
        else super.postMessage(message, transferOrOptions);
      }
    }
    Object.defineProperty(globalThis, "__poietraOpeningCanvasWorkerRequestKindsV1", {
      configurable: false,
      enumerable: false,
      value: requestKinds,
      writable: false,
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: ObservedWorker,
      writable: true,
    });
  });

  await page.goto("/?previewRenderer=server");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  const responsePromise = runtimeTraceResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const request = response.request().postDataJSON() as Record<string, unknown>;
  expect(request).toMatchObject({
    projectId: "real-preview-harness",
    sceneName: SCENE_NAME,
    sourceHash: SOURCE_SHA256,
    sourcePath: SOURCE_PATH,
  });

  const body = (await response.json()) as RuntimeTraceRunBody;
  expect(body).toMatchObject({
    projectId: "real-preview-harness",
    requestId: request.requestId,
    sceneName: SCENE_NAME,
    schema: "poietra.fast-manim-runtime-trace-run",
    sourceHash: SOURCE_SHA256,
    sourcePath: SOURCE_PATH,
    status: "verified",
    traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    version: 1,
  });
  expect(body).not.toHaveProperty("publication");
  expect(body).not.toHaveProperty("revision");
  expect(body).not.toHaveProperty("sourceText");
  expect(body).not.toHaveProperty("absolutePath");
  expect(body).not.toHaveProperty("sourceAbsolutePath");
  expect(body.sourcePath).not.toMatch(/^(?:[A-Za-z]:[\\/]|\/)/u);
  if (!body.bundle || !body.roots || !body.sceneId || !body.runtimeConfigHash || !body.traceDigest) {
    throw new Error("The verified OpeningManim Runtime Trace response is incomplete.");
  }
  return {
    bundle: body.bundle,
    roots: body.roots,
    runtimeConfigHash: body.runtimeConfigHash,
    sceneId: body.sceneId,
    traceDigest: body.traceDigest,
  };
}

function expectSameFullRgba(
  frames: Map<string, Awaited<ReturnType<typeof captureRuntimeTraceWebGpuFramesV1>>["frames"][number]>,
  leftId: string,
  rightId: string,
) {
  const left = frames.get(leftId);
  const right = frames.get(rightId);
  if (!left || !right) throw new Error(`Missing full RGBA comparison ${leftId}/${rightId}.`);
  expect(right.sha256).toBe(left.sha256);
  expect(right.rgba.byteLength).toBe(left.rgba.byteLength);
  expect(right.rgba.every((byte, index) => byte === left.rgba[index])).toBe(true);
}

async function compareWithIndependentCairo(frames: readonly OpeningManimWebGpuFrameV2[]) {
  return withGeneratedRuntimeTraceCairoReferenceV1({
    generatorPath: "scripts/generate-opening-manim-cairo-reference.py",
    read: (referenceRoot) =>
      compareOpeningManimCairoWebGpuFramesV2({
        cairoReferenceRoot: referenceRoot,
        frames,
        outputRoot:
          process.env.POIETRA_RUNTIME_TRACE_CAIRO_PARITY_OUTPUT_DIR ??
          "test-results/runtime-trace-opening-cairo-parity",
      }),
    temporaryPrefix: "poietra-opening-manim-cairo-parity-",
  });
}

test("renders the official OpeningManim 0-15s Scene through Runtime Trace V2 and retained WebGPU", async ({ page }) => {
  test.setTimeout(300_000);
  const run = await verifiedOpeningRuntimeTrace(page);
  expect(run.bundle.scene).toMatchObject({
    duration: 15,
    requiredCapabilities: [
      "affine-transform-animation",
      "cubic-path-geometry",
      "logical-group",
      "path-morph-animation",
      "path-trim-animation",
      "vector-appearance-animation",
    ],
    sceneId: run.sceneId,
    source: {
      kind: "imported-manim-runtime-trace",
      runtimeConfigHash: run.runtimeConfigHash,
      sourceHash: SOURCE_SHA256,
      traceDigest: run.traceDigest,
      traceVersion: 2,
    },
  });
  expect(run.bundle.scene.entities).toHaveLength(194);
  expect(run.bundle.scene.animationChannels).toHaveLength(269);
  expect(run.bundle.scene.animationChannels.reduce((total, channel) => total + channel.keyframes.length, 0)).toBe(
    12_551,
  );
  const channelKinds = run.bundle.scene.animationChannels.map(({ kind }) => kind);
  expect(channelKinds.filter((kind) => kind === "vector-appearance")).toHaveLength(122);
  expect(channelKinds.filter((kind) => kind === "path-trim")).toHaveLength(39);
  const pathMorphChannels = run.bundle.scene.animationChannels.filter((channel) => channel.kind === "path-morph");
  expect(pathMorphChannels).toHaveLength(87);
  expect(pathMorphChannels.reduce((total, channel) => total + channel.keyframes.length, 0)).toBe(509);
  expect(channelKinds.filter((kind) => kind === "affine-transform")).toHaveLength(21);
  expect(channelKinds.filter((kind) => kind === "opacity")).toHaveLength(0);
  expect(run.roots.map(({ binding }) => binding.name)).toEqual(["title", "basel", "grid", "grid_title"]);
  const rootEntityIds = run.roots.map(({ entityId }) => entityId);
  expect(rootEntityIds).toEqual([
    `${run.sceneId}/runtime-root:title`,
    `${run.sceneId}/runtime-root:basel`,
    `${run.sceneId}/runtime-root:grid`,
    `${run.sceneId}/runtime-root:grid-title`,
  ]);

  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 60_000 });
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await expect(canvas).toHaveAttribute("data-preview-revision", run.traceDigest);
  await expect(page.locator("[data-studio-preview-status]")).toContainText("verified Runtime Trace · selection only");
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();

  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(playhead).toHaveAttribute("max", "15");
  const packetIds = new Set<string>();
  // The editor playhead is a 0.01-step range input, so use its representable
  // pre-boundary values here. Exact pre-boundary frames are exercised below
  // by readback, which is not quantized by the UI control.
  const playheadSampleTimes = [
    0, 0.5, 1, 2, 2.98, 3, 3.5, 4, 4.98, 5, 5.5, 6.5, 7.98, 8, 8.98, 9, 9.5, 10.5, 11.5, 11.98, 12, 12.98, 13, 13.5,
    13.98, 14, 15,
  ];
  for (const sampleTime of playheadSampleTimes) {
    await playhead.fill(String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    const packetId = await canvas.getAttribute("data-preview-packet-id");
    if (!packetId) throw new Error(`OpeningManim sample ${sampleTime} has no retained packet identity.`);
    packetIds.add(packetId);
  }
  expect(packetIds.size).toBe(playheadSampleTimes.length);

  // Return to a frame where the first two source roots are alive before
  // asserting their Studio selection proxies.
  await playhead.fill("0");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "0");

  for (const [sourceName, runtimeEntityId] of [
    ["title", rootEntityIds[0]],
    ["basel", rootEntityIds[1]],
  ] as const) {
    const target = page.getByRole("button", { exact: true, name: `Move ${sourceName}` });
    await expect(target).toBeVisible();
    await expect(target).toHaveAttribute(
      "title",
      "This verified object can be selected, but source rewriting is unavailable.",
    );
    const studioEntityId = await target.getAttribute("data-studio-entity");
    if (!studioEntityId || !runtimeEntityId) throw new Error(`OpeningManim ${sourceName} identity is incomplete.`);
    await expect(page.locator(`[data-studio-entity-wrapper="${studioEntityId}"]`)).toHaveAttribute(
      "data-studio-runtime-entity",
      runtimeEntityId,
    );
  }
  const title = page.getByRole("button", { exact: true, name: "Move title" });
  await title.click();
  await expect(title).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Resize title/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  const studioWorkerRequestKinds = await page.evaluate(() => {
    const observed = (
      globalThis as typeof globalThis & {
        __poietraOpeningCanvasWorkerRequestKindsV1?: readonly string[];
      }
    ).__poietraOpeningCanvasWorkerRequestKindsV1;
    return observed ? [...observed] : null;
  });
  expect(studioWorkerRequestKinds).not.toBeNull();
  expect(studioWorkerRequestKinds?.filter((kind) => kind === "install-canvas")).toHaveLength(1);
  expect(studioWorkerRequestKinds?.filter((kind) => kind === "replace-scene")).toHaveLength(0);

  const fullRgba = await captureRuntimeTraceWebGpuFramesV1(page, {
    bundle: run.bundle,
    revision: run.traceDigest,
    samples: OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V2,
    viewport: RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  });
  expect(fullRgba).toMatchObject({
    capture: {
      installCount: 1,
      policy: "one-retained-engine",
      renderSubmissionCounts: OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V2.map(() => 1),
    },
    revision: run.traceDigest,
    viewport: RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  });
  expect(fullRgba.frames.map(({ frameIndex, id, requestSampleTime }) => [id, frameIndex, requestSampleTime])).toEqual(
    OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V2.map(({ frameIndex, id, sampleTime }) => [id, frameIndex, sampleTime]),
  );
  for (const frame of fullRgba.frames) {
    expect(frame.presentedSampleTime).toBe(frame.requestSampleTime);
    expect(frame.rgba.byteLength).toBe(
      RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1.widthPx * RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1.heightPx * 4,
    );
    expect(frame.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect([...frame.rgba.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect(frame.pixels.surfaceFormat).toMatch(/^(?:bgra|rgba)8unorm$/u);
    expect(frame.pixels.viewFormat).toBe(frame.pixels.surfaceFormat === "bgra8unorm" ? "Bgra8Unorm" : "Rgba8Unorm");
    let opaque = true;
    for (let index = 3; index < frame.rgba.length; index += 4) {
      if (frame.rgba[index] === 255) continue;
      opaque = false;
      break;
    }
    expect(opaque, `full RGBA frame ${frame.id} must retain the opaque-black contract`).toBe(true);
  }
  const frames = new Map(fullRgba.frames.map((frame) => [frame.id, frame]));
  expect(frames.get("initial")?.pixels.nonBlackBounds).toBeNull();
  for (const [id] of OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2.slice(1)) {
    const bounds = frames.get(id)?.pixels.nonBlackBounds;
    expect(bounds, `OpeningManim frame ${id} must contain visible geometry`).not.toBeNull();
    if (!bounds) throw new Error(`OpeningManim frame ${id} has no visible bounds.`);
    expect(bounds.every(Number.isFinite)).toBe(true);
    expect(bounds[2]).toBeGreaterThan(bounds[0]);
    expect(bounds[3]).toBeGreaterThan(bounds[1]);
  }
  expectSameFullRgba(frames, "final-title-transform-midpoint", "final-title-transform-midpoint-repeat");
  expectSameFullRgba(frames, "transform-midpoint", "transform-midpoint-repeat");
  expectSameFullRgba(frames, "warp-midpoint", "warp-midpoint-repeat");
  expectSameFullRgba(frames, "grid-create-midpoint", "grid-create-midpoint-repeat");
  expectSameFullRgba(frames, "transform-play-end", "wait-end");
  expectSameFullRgba(frames, "opening-play-end", "opening-hold-last");
  expectSameFullRgba(frames, "wait-end", "grid-create-start");
  expectSameFullRgba(frames, "grid-play-end", "grid-wait-end");
  expectSameFullRgba(frames, "grid-wait-end", "warp-start");
  expectSameFullRgba(frames, "warp-play-end", "warp-hold-last");
  expectSameFullRgba(frames, "final-title-transform-play-end", "terminal-hold-end");
  expect(frames.get("initial")?.sha256).not.toBe(frames.get("opening-animation-midpoint")?.sha256);
  expect(frames.get("opening-animation-midpoint")?.sha256).not.toBe(frames.get("opening-play-end")?.sha256);
  expect(frames.get("opening-hold-last")?.sha256).not.toBe(frames.get("transform-start")?.sha256);
  expect(frames.get("transform-start")?.sha256).not.toBe(frames.get("transform-midpoint")?.sha256);
  expect(frames.get("transform-midpoint")?.sha256).not.toBe(frames.get("transform-play-end")?.sha256);
  expect(frames.get("grid-create-start")?.sha256).not.toBe(frames.get("grid-create-early")?.sha256);
  expect(frames.get("grid-create-early")?.sha256).not.toBe(frames.get("grid-create-midpoint")?.sha256);
  expect(frames.get("grid-create-midpoint")?.sha256).not.toBe(frames.get("grid-create-last")?.sha256);
  expect(frames.get("grid-create-last")?.sha256).not.toBe(frames.get("grid-play-end")?.sha256);
  expect(frames.get("warp-start")?.sha256).not.toBe(frames.get("warp-early")?.sha256);
  expect(frames.get("warp-early")?.sha256).not.toBe(frames.get("warp-midpoint")?.sha256);
  expect(frames.get("warp-midpoint")?.sha256).not.toBe(frames.get("warp-late")?.sha256);
  expect(frames.get("warp-late")?.sha256).not.toBe(frames.get("warp-last")?.sha256);
  expect(frames.get("warp-last")?.sha256).not.toBe(frames.get("warp-play-end")?.sha256);
  expect(frames.get("warp-hold-last")?.sha256).not.toBe(frames.get("final-title-transform-start")?.sha256);
  expect(frames.get("final-title-transform-start")?.sha256).not.toBe(
    frames.get("final-title-transform-midpoint")?.sha256,
  );
  expect(frames.get("final-title-transform-midpoint")?.sha256).not.toBe(
    frames.get("final-title-transform-last")?.sha256,
  );
  expect(frames.get("final-title-transform-last")?.sha256).not.toBe(
    frames.get("final-title-transform-play-end")?.sha256,
  );

  if (CAIRO_PARITY_REQUIRED) {
    const parityFrames = OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2.map(([id, frameIndex, sampleTime]) => {
      const frame = fullRgba.frames.find(
        (candidate) => candidate.frameIndex === frameIndex && candidate.requestSampleTime === sampleTime,
      );
      if (!frame) throw new Error(`The retained WebGPU readback is missing the ${id} Cairo parity sample.`);
      return { frameIndex, id, rgba: frame.rgba, sampleTime } satisfies OpeningManimWebGpuFrameV2;
    });
    const comparisons = await compareWithIndependentCairo(parityFrames);
    expect(
      comparisons.filter(({ passed }) => !passed),
      JSON.stringify(comparisons, null, 2),
    ).toEqual([]);
  }
});
