import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  assertRealManimEditabilityCensusCaseFloor,
  REAL_MANIM_EDITABILITY_CAPABILITIES,
} from "../scripts/real-manim-editability-census-report";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import {
  deriveOpeningManimTerminalPositionSourceEditPlanV2,
  recoverOpeningManimOfficialSourceV2,
} from "../src/render-pipeline/source-lowering";
import { compareOpeningManimCairoWebGpuFramesV2, type OpeningManimWebGpuFrameV2 } from "./opening-manim-cairo-parity";
import {
  OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2,
  OPENING_MANIM_OFFICIAL_SOURCE_SHA256_V2,
} from "./opening-manim-cairo-reference";
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
const SOURCE_SHA256 = OPENING_MANIM_OFFICIAL_SOURCE_SHA256_V2;
const CAIRO_PARITY_REQUIRED = process.env.POIETRA_RUNTIME_TRACE_CAIRO_PARITY_REQUIRED === "1";
const VIEWPORT = RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1;

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

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
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

async function compareWithIndependentCairo(
  frames: readonly OpeningManimWebGpuFrameV2[],
  candidate?: Readonly<{ sourceHash: string; sourceText: string }>,
) {
  const outputRoot =
    process.env.POIETRA_RUNTIME_TRACE_CAIRO_PARITY_OUTPUT_DIR ?? "test-results/runtime-trace-opening-cairo-parity";
  return withGeneratedRuntimeTraceCairoReferenceV1({
    generatorPath: "scripts/generate-opening-manim-cairo-reference.py",
    read: (referenceRoot) =>
      compareOpeningManimCairoWebGpuFramesV2({
        cairoReferenceRoot: referenceRoot,
        expectedSourceSha256: candidate?.sourceHash ?? SOURCE_SHA256,
        frames,
        outputRoot: `${outputRoot}/${candidate ? "candidate" : "official"}`,
      }),
    ...(candidate ? { sourceText: candidate.sourceText } : {}),
    temporaryPrefix: "poietra-opening-manim-cairo-parity-",
  });
}

async function exportedOriginalSource(page: Page) {
  const exportButton = page.getByRole("button", { name: "Export .py" });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/manim/projects/real-preview-harness/export",
  );
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toEqual({
    projectId: "real-preview-harness",
    sourceHash: SOURCE_SHA256,
    sourcePath: SOURCE_PATH,
  });
  const path = await download.path();
  if (!path) throw new Error("The exported OpeningManim source was not persisted by Playwright.");
  return readFile(path);
}

async function exportedCandidateSource(page: Page) {
  const exportButton = page.getByRole("button", { name: "Export .py" });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/manim/projects/real-preview-harness/export",
  );
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.ok()).toBe(true);
  const path = await download.path();
  if (!path) throw new Error("The exported OpeningManim candidate source was not persisted by Playwright.");
  return {
    request: response.request().postDataJSON() as Record<string, unknown>,
    source: await readFile(path, "utf8"),
  };
}

async function dragBy(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The OpeningManim edit target is not visible.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: 4 });
  await page.mouse.up();
}

async function renderCommitAndFreshRuntimeTrace(page: Page) {
  const render = page.getByRole("button", { name: "Render program" });
  await expect(render).toBeEnabled();
  await render.click();
  const commit = page.getByRole("button", { name: "Commit to source" });
  await expect(commit).toBeVisible({ timeout: 300_000 });
  await expect(commit).toBeEnabled();
  await expect(page.getByLabel(`Rendered Manim preview of ${SCENE_NAME}`)).toBeVisible();
  await commit.click();
  const dialog = page.getByRole("alertdialog", { name: "Commit rendered program?" });
  await expect(dialog).toBeVisible();
  const mutationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/api/manim/renders/") &&
      new URL(response.url()).pathname.endsWith("/commit"),
  );
  const traceResponse = runtimeTraceResponse(page);
  await dialog.getByRole("button", { name: "Commit source" }).click();
  const mutation = await mutationResponse;
  expect(mutation.ok(), `Commit returned HTTP ${mutation.status()}.`).toBe(true);
  const response = await traceResponse;
  expect(response.ok()).toBe(true);
  const request = response.request().postDataJSON() as Record<string, unknown>;
  const body = (await response.json()) as RuntimeTraceRunBody;
  expect(body).toMatchObject({
    projectId: "real-preview-harness",
    requestId: request.requestId,
    sceneName: SCENE_NAME,
    schema: "poietra.fast-manim-runtime-trace-run",
    sourceHash: request.sourceHash,
    sourcePath: SOURCE_PATH,
    status: "verified",
    traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    version: 1,
  });
  if (!body.bundle || !body.roots || !body.sourceHash || !body.traceDigest) {
    throw new Error("The edited OpeningManim Runtime Trace response is incomplete.");
  }
  return {
    bundle: body.bundle,
    roots: body.roots,
    sourceHash: body.sourceHash,
    traceDigest: body.traceDigest,
  };
}

type RetainedRootBoundsSample = Readonly<{
  entries: readonly Readonly<
    | { bounds: readonly [number, number, number, number]; entityId: string; status: "present" }
    | { entityId: string; status: "empty" | "inactive" | "unavailable" }
  >[];
  id: string;
  sampleTime: number;
}>;

async function retainedRootBounds(
  page: Page,
  input: Readonly<{
    bundle: SceneIrBundleV1;
    entityIds: readonly string[];
    revision: string;
    samples: readonly Readonly<{ id: string; sampleTime: number }>[];
  }>,
): Promise<readonly RetainedRootBoundsSample[]> {
  return page.evaluate(
    async ({ bundle, entityIds, revision, samples, viewport }) => {
      const { PoietraCanvasWorkerClient } = (await import(
        "/src/engine/canvas-worker-client.ts"
      )) as typeof import("../src/engine/canvas-worker-client");

      class EvidenceCanvasWorker extends globalThis.Worker {
        constructor() {
          super(new URL("/src/engine/poietra-canvas.dev.worker.ts", location.href), { type: "module" });
        }
      }

      const client = new PoietraCanvasWorkerClient({
        requestTimeoutMs: 60_000,
        workerFactory: () => new EvidenceCanvasWorker(),
      });
      const canvas = Object.assign(document.createElement("canvas"), {
        height: viewport.heightPx,
        width: viewport.widthPx,
      });
      try {
        await client.installScene({ canvas, revision, snapshot: bundle });
        const results = [];
        for (const sample of samples) {
          const frame = await client.render({
            interactionEntityIds: entityIds,
            revision,
            sampleTime: sample.sampleTime,
            viewport,
          });
          if (frame.interaction.status !== "available") {
            throw new Error(`OpeningManim retained bounds are unavailable at ${sample.id}.`);
          }
          results.push({
            entries: frame.interaction.entries.map((entry, index) => ({
              ...entry,
              entityId: entityIds[index] ?? "",
            })),
            id: sample.id,
            sampleTime: frame.sampleTime,
          });
        }
        return results;
      } finally {
        client.dispose();
      }
    },
    { ...input, viewport: VIEWPORT },
  );
}

function presentBounds(sample: RetainedRootBoundsSample | undefined, entityId: string) {
  const entry = sample?.entries.find((candidate) => candidate.entityId === entityId);
  if (!entry || entry.status !== "present") {
    throw new Error(`OpeningManim retained root ${entityId} is absent from ${sample?.id ?? "an unknown sample"}.`);
  }
  return entry.bounds;
}

function boundsCenter(bounds: readonly [number, number, number, number]) {
  return { x: (bounds[0] + bounds[2]) / 2, y: (bounds[1] + bounds[3]) / 2 };
}

test("renders the official OpeningManim 0-15s Scene through Runtime Trace V2 and retained WebGPU", async ({ page }) => {
  test.setTimeout(600_000);
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
  await expect(page.getByRole("button", { name: "Render program" })).toBeDisabled();

  // Selection-only Runtime Trace evidence cannot manufacture an edited
  // candidate, while the independently authorized original-source download
  // remains available and must preserve every source byte.
  const [expectedOriginalSource, downloadedOriginalSource] = await Promise.all([
    readFile(new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url)),
    exportedOriginalSource(page),
  ]);
  expect(downloadedOriginalSource.equals(expectedOriginalSource)).toBe(true);
  expect(createHash("sha256").update(downloadedOriginalSource).digest("hex")).toBe(SOURCE_SHA256);

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

  // Source mutation authority exists only at the exact final Transform
  // boundary. The other source roots remain selectable runtime evidence.
  await playhead.fill("13.98");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await playhead.fill("14");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "bounded-interactive");
  await expect(page.locator("[data-studio-preview-status]")).toContainText("Grid title terminal edit at 14.00s");
  await playhead.fill("14.01");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await playhead.fill("14");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "bounded-interactive");

  const gridTarget = page.getByRole("button", { exact: true, name: "Move grid" });
  const gridTitleTarget = page.getByRole("button", { exact: true, name: "Move grid title" });
  await expect(gridTarget).toBeVisible();
  await expect(gridTarget).toHaveAttribute(
    "title",
    "This verified object can be selected, but source rewriting is unavailable.",
  );
  await gridTarget.click();
  await expect(gridTarget).toHaveAttribute("aria-pressed", "true");
  await expect(gridTitleTarget).toBeVisible();
  await expect(gridTitleTarget).not.toHaveAttribute(
    "title",
    "This verified object can be selected, but source rewriting is unavailable.",
  );
  const gridTitleStudioEntityId = await gridTitleTarget.getAttribute("data-studio-entity");
  if (!gridTitleStudioEntityId) throw new Error("The OpeningManim grid_title has no Studio identity.");
  await gridTitleTarget.click();
  await expect(gridTitleTarget).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Resize grid title/u })).toHaveCount(0);
  await page.getByRole("button", { name: "Set position" }).click();
  await expect(page.getByRole("button", { name: "Set position" })).toHaveAttribute("aria-pressed", "true");

  const gridTitleBefore = await gridTitleTarget.boundingBox();
  if (!gridTitleBefore) throw new Error("The OpeningManim grid_title has no interaction bounds at fourteen seconds.");
  await dragBy(page, gridTitleTarget, { x: 32, y: 18 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toContainText("Edit validation pending · OpeningManim");
  await expect(page.getByRole("button", { name: /Resize grid title/u })).toHaveCount(0);
  const gridTitleDraft = await gridTitleTarget.boundingBox();
  if (!gridTitleDraft) throw new Error("The OpeningManim grid_title edit outline disappeared.");
  expect(gridTitleDraft.x - gridTitleBefore.x).toBeCloseTo(32, 0);
  expect(gridTitleDraft.y - gridTitleBefore.y).toBeCloseTo(18, 0);

  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(page.locator("[data-studio-preview-status]")).toContainText("Edit validation pending · OpeningManim");
  const exportedCandidate = await exportedCandidateSource(page);
  const requestedPrograms = exportedCandidate.request.programs;
  expect(Array.isArray(requestedPrograms)).toBe(true);
  if (!Array.isArray(requestedPrograms) || requestedPrograms.length !== 1) {
    throw new Error("OpeningManim export did not carry exactly one Canonical Program.");
  }
  const requestedProgram = requestedPrograms[0] as Record<string, unknown>;
  expect(exportedCandidate.request).toMatchObject({
    destination: null,
    program: requestedProgram,
    projectId: "real-preview-harness",
    sceneName: SCENE_NAME,
    sourceHash: SOURCE_SHA256,
    sourcePath: SOURCE_PATH,
  });
  expect(exportedCandidate.request).not.toHaveProperty("verifiedRuntimeTraceTerminalEdit");
  expect(requestedProgram).toMatchObject({
    anchor: {
      capturedPlayhead: 14,
      resolvedSeconds: 14,
      source: { kind: "playhead", referenceSeconds: 14 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    provenance: { origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel" },
    version: 1,
  });
  const requestedOperations = requestedProgram.operations;
  expect(Array.isArray(requestedOperations)).toBe(true);
  if (!Array.isArray(requestedOperations) || requestedOperations.length !== 1) {
    throw new Error("OpeningManim export did not carry exactly one Canonical operation.");
  }
  expect(requestedOperations[0]).toMatchObject({
    dependsOn: [],
    entityId: gridTitleStudioEntityId,
    interval: { end: 14, start: 14 },
    key: "position",
    kind: "SetProperty",
    provenance: { origin: "direct-manipulation" },
  });

  const candidateSourceHash = createHash("sha256").update(exportedCandidate.source, "utf8").digest("hex");
  expect(candidateSourceHash).not.toBe(SOURCE_SHA256);
  const candidatePlan = deriveOpeningManimTerminalPositionSourceEditPlanV2(exportedCandidate.source, SCENE_NAME);
  expect(candidatePlan).toMatchObject({
    anchorLine: 68,
    binding: { name: "grid_title", sourceLine: 38 },
    sourceTime: 14,
  });
  if (!candidatePlan.translation) throw new Error("The OpeningManim candidate has no canonical terminal shift.");
  expect(Math.hypot(candidatePlan.translation.x, candidatePlan.translation.y)).toBeGreaterThan(0.01);
  expect(exportedCandidate.source.match(/^ {8}grid_title\.shift\(\([^\n]+, [^\n]+, 0\)\)$/gmu)).toHaveLength(1);
  expect(recoverOpeningManimOfficialSourceV2(exportedCandidate.source, SCENE_NAME)).toBe(
    expectedOriginalSource.toString("utf8"),
  );
  expect(exportedCandidate.source.indexOf("self.play(Transform(grid_title, grid_transform_title))")).toBeLessThan(
    exportedCandidate.source.indexOf("grid_title.shift"),
  );
  expect(exportedCandidate.source.indexOf("grid_title.shift")).toBeLessThan(
    exportedCandidate.source.lastIndexOf("self.wait()"),
  );

  const edited = await renderCommitAndFreshRuntimeTrace(page);
  expect(edited.sourceHash).toBe(candidateSourceHash);
  expect(edited.sourceHash).not.toBe(SOURCE_SHA256);
  expect(edited.traceDigest).not.toBe(run.traceDigest);
  expect(edited.bundle.scene.source).toMatchObject({
    kind: "imported-manim-runtime-trace",
    sourceHash: edited.sourceHash,
    traceDigest: edited.traceDigest,
    traceVersion: 2,
  });
  expect(edited.roots.map(({ binding }) => binding.name)).toEqual(["title", "basel", "grid", "grid_title"]);
  expect(edited.roots.map(({ entityId }) => entityId)).toEqual(rootEntityIds);
  await expect(canvas).toHaveAttribute("data-preview-revision", edited.traceDigest, { timeout: 60_000 });
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  await playhead.fill("14");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "14");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await expect(page.locator("[data-studio-preview-status]")).toContainText("selection only");

  const editedGrid = page.getByRole("button", { exact: true, name: "Move grid" });
  await expect(editedGrid).toBeVisible();
  await expect(editedGrid).toHaveAttribute(
    "title",
    "This verified object can be selected, but source rewriting is unavailable.",
  );
  const editedGridTitle = page.getByRole("button", { exact: true, name: "Move grid title" });
  await expect(editedGridTitle).toBeVisible();
  await dragBy(page, editedGridTitle, { x: 16, y: -8 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  const editedFullRgba = await captureRuntimeTraceWebGpuFramesV1(page, {
    bundle: edited.bundle,
    revision: edited.traceDigest,
    samples: OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V2,
    viewport: VIEWPORT,
  });
  expect(editedFullRgba.capture).toEqual({
    installCount: 1,
    policy: "one-retained-engine",
    renderSubmissionCounts: OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V2.map(() => 1),
  });
  const editedFrames = new Map(editedFullRgba.frames.map((frame) => [frame.id, frame]));
  for (const sample of OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V2.filter(({ frameIndex }) => frameIndex < 840)) {
    const official = frames.get(sample.id);
    const candidate = editedFrames.get(sample.id);
    if (!official || !candidate) throw new Error(`OpeningManim cross-run sample ${sample.id} is missing.`);
    expect(candidate.sha256, `frame ${sample.frameIndex} changed before the t=14 boundary`).toBe(official.sha256);
    expect(candidate.rgba.every((byte, index) => byte === official.rgba[index])).toBe(true);
  }
  for (const id of ["final-title-transform-play-end", "terminal-hold-end"] as const) {
    expect(editedFrames.get(id)?.sha256).not.toBe(frames.get(id)?.sha256);
  }
  expectSameFullRgba(editedFrames, "final-title-transform-play-end", "terminal-hold-end");
  expectSameFullRgba(editedFrames, "final-title-transform-midpoint", "final-title-transform-midpoint-repeat");

  const retainedSamples = [
    { id: "before-boundary", sampleTime: 839 / 60 },
    { id: "boundary", sampleTime: 14 },
    { id: "duration-end", sampleTime: 15 },
  ] as const;
  const retainedEntityIds = [rootEntityIds[2]!, rootEntityIds[3]!];
  const [officialBounds, editedBounds] = await Promise.all([
    retainedRootBounds(page, {
      bundle: run.bundle,
      entityIds: retainedEntityIds,
      revision: run.traceDigest,
      samples: retainedSamples,
    }),
    retainedRootBounds(page, {
      bundle: edited.bundle,
      entityIds: retainedEntityIds,
      revision: edited.traceDigest,
      samples: retainedSamples,
    }),
  ]);
  const officialBoundsById = new Map(officialBounds.map((sample) => [sample.id, sample]));
  const editedBoundsById = new Map(editedBounds.map((sample) => [sample.id, sample]));
  const gridEntityId = rootEntityIds[2]!;
  const gridTitleEntityId = rootEntityIds[3]!;
  expect(presentBounds(editedBoundsById.get("before-boundary"), gridEntityId)).toEqual(
    presentBounds(officialBoundsById.get("before-boundary"), gridEntityId),
  );
  expect(presentBounds(editedBoundsById.get("before-boundary"), gridTitleEntityId)).toEqual(
    presentBounds(officialBoundsById.get("before-boundary"), gridTitleEntityId),
  );
  for (const sampleId of ["boundary", "duration-end"] as const) {
    expect(presentBounds(editedBoundsById.get(sampleId), gridEntityId)).toEqual(
      presentBounds(officialBoundsById.get(sampleId), gridEntityId),
    );
    const before = presentBounds(officialBoundsById.get(sampleId), gridTitleEntityId);
    const after = presentBounds(editedBoundsById.get(sampleId), gridTitleEntityId);
    expect(after[2] - after[0]).toBeCloseTo(before[2] - before[0], 6);
    expect(after[3] - after[1]).toBeCloseTo(before[3] - before[1], 6);
    const beforeCenter = boundsCenter(before);
    const afterCenter = boundsCenter(after);
    expect(afterCenter.x - beforeCenter.x).toBeCloseTo((2 * candidatePlan.translation.x) / (128 / 9), 6);
    expect(afterCenter.y - beforeCenter.y).toBeCloseTo((2 * candidatePlan.translation.y) / 8, 6);
  }
  expect(presentBounds(editedBoundsById.get("duration-end"), gridTitleEntityId)).toEqual(
    presentBounds(editedBoundsById.get("boundary"), gridTitleEntityId),
  );

  if (CAIRO_PARITY_REQUIRED) {
    const parityFrames = OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2.map(([id, frameIndex, sampleTime]) => {
      const frame = editedFullRgba.frames.find(
        (candidate) => candidate.frameIndex === frameIndex && candidate.requestSampleTime === sampleTime,
      );
      if (!frame) throw new Error(`The edited WebGPU readback is missing the ${id} Cairo parity sample.`);
      return { frameIndex, id, rgba: frame.rgba, sampleTime } satisfies OpeningManimWebGpuFrameV2;
    });
    const comparisons = await compareWithIndependentCairo(parityFrames, {
      sourceHash: candidateSourceHash,
      sourceText: exportedCandidate.source,
    });
    expect(
      comparisons.filter(({ passed }) => !passed),
      JSON.stringify(comparisons, null, 2),
    ).toEqual([]);
  }

  const editabilityBaseline = JSON.parse(
    await readFile(new URL("../fixtures/real-manim-editability-census-v1/baseline.json", import.meta.url), "utf8"),
  ) as unknown;
  const caseId = "fast-manim-basic/OpeningManim/runtime-trace-v2" as const;
  assertRealManimEditabilityCensusCaseFloor(
    caseId,
    REAL_MANIM_EDITABILITY_CAPABILITIES.map((capability) => ({ capability, caseId, status: "proven" as const })),
    editabilityBaseline,
  );
});
