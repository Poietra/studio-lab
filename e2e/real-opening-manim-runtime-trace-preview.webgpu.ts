import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import {
  captureRuntimeTraceWebGpuFramesV1,
  OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V1,
  RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
} from "./runtime-trace-webgpu-readback";

const RUNTIME_TRACE_PATH = "/api/manim/projects/real-preview-harness/runtime-traces";
const SOURCE_PATH = "example_scenes/basic.py";
const SCENE_NAME = "OpeningManim";
const SCENE_LABEL = `${SOURCE_PATH} · ${SCENE_NAME}`;
const SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";

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
  const responseFailure = await response.finished();
  if (responseFailure) {
    throw new Error("The verified OpeningManim Runtime Trace response body did not finish downloading.", {
      cause: responseFailure,
    });
  }
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

test("renders the official OpeningManim 0-3s slice through Runtime Trace V2 and retained WebGPU", async ({ page }) => {
  test.setTimeout(300_000);
  const run = await verifiedOpeningRuntimeTrace(page);
  expect(run.bundle.scene).toMatchObject({
    duration: 3,
    requiredCapabilities: [
      "affine-transform-animation",
      "cubic-path-geometry",
      "logical-group",
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
  expect(run.bundle.scene.entities).toHaveLength(47);
  expect(run.bundle.scene.animationChannels).toHaveLength(73);
  const channelKinds = run.bundle.scene.animationChannels.map(({ kind }) => kind);
  expect(channelKinds.filter((kind) => kind === "vector-appearance")).toHaveLength(44);
  expect(channelKinds.filter((kind) => kind === "path-trim")).toHaveLength(15);
  expect(channelKinds.filter((kind) => kind === "affine-transform")).toHaveLength(14);
  expect(run.roots.map(({ binding }) => binding.name)).toEqual(["title", "basel"]);
  const rootEntityIds = run.roots.map(({ entityId }) => entityId);
  expect(rootEntityIds).toEqual([`${run.sceneId}/runtime-root:title`, `${run.sceneId}/runtime-root:basel`]);

  const canvas = page.locator("[data-studio-canvas]");
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 60_000 });
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await expect(canvas).toHaveAttribute("data-preview-revision", run.traceDigest);
  await expect(page.locator("[data-studio-preview-status]")).toContainText("verified Runtime Trace · selection only");
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();

  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(playhead).toHaveAttribute("max", "3");
  const packetIds = new Set<string>();
  for (const sampleTime of [0, 0.5, 1, 2, 3]) {
    await playhead.fill(String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    const packetId = await canvas.getAttribute("data-preview-packet-id");
    if (!packetId) throw new Error(`OpeningManim sample ${sampleTime} has no retained packet identity.`);
    packetIds.add(packetId);
  }
  expect(packetIds.size).toBe(5);

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
    samples: OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V1,
    viewport: RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  });
  expect(fullRgba).toMatchObject({
    capture: {
      installCount: 1,
      policy: "one-retained-engine",
      renderSubmissionCounts: OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V1.map(() => 1),
    },
    revision: run.traceDigest,
    viewport: RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  });
  expect(fullRgba.frames.map(({ frameIndex, id, requestSampleTime }) => [id, frameIndex, requestSampleTime])).toEqual(
    OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V1.map(({ frameIndex, id, sampleTime }) => [id, frameIndex, sampleTime]),
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
  for (const id of ["write-progress", "animation-progress", "hold", "duration-end"] as const) {
    const bounds = frames.get(id)?.pixels.nonBlackBounds;
    expect(bounds, `OpeningManim frame ${id} must contain visible geometry`).not.toBeNull();
    if (!bounds) throw new Error(`OpeningManim frame ${id} has no visible bounds.`);
    expect(bounds.every(Number.isFinite)).toBe(true);
    expect(bounds[2]).toBeGreaterThan(bounds[0]);
    expect(bounds[3]).toBeGreaterThan(bounds[1]);
  }
  expectSameFullRgba(frames, "animation-progress", "animation-progress-repeat");
  expectSameFullRgba(frames, "hold", "hold-repeat");
  expectSameFullRgba(frames, "hold", "duration-end");
  expect(frames.get("initial")?.sha256).not.toBe(frames.get("write-progress")?.sha256);
  expect(frames.get("write-progress")?.sha256).not.toBe(frames.get("animation-progress")?.sha256);
});
