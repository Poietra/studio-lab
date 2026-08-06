import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  assertRealManimEditabilityCensusCaseFloor,
  REAL_MANIM_EDITABILITY_CAPABILITIES,
} from "../scripts/real-manim-editability-census-report";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import { withGeneratedRuntimeTraceCairoReferenceV1 } from "./runtime-trace-cairo-reference-runner";
import {
  captureRuntimeTraceWebGpuFramesV1,
  RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  UPDATERS_RUNTIME_TRACE_WEBGPU_SAMPLES_V1,
} from "./runtime-trace-webgpu-readback";
import { compareUpdatersCairoWebGpuFramesV1, type UpdatersWebGpuFrameV1 } from "./updaters-cairo-parity";
import { UPDATERS_CAIRO_REFERENCE_SAMPLES_V1 } from "./updaters-cairo-reference";

const RUNTIME_TRACE_PATH = "/api/manim/projects/real-preview-harness/runtime-traces";
const SOURCE_PATH = "example_scenes/basic.py";
const SCENE_NAME = "UpdatersExample";
const SCENE_LABEL = `${SOURCE_PATH} · ${SCENE_NAME}`;
const SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const ROOT_EVIDENCE_POINT_COUNT = 5;
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;
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

async function openOfficialRuntimeTrace(page: Page) {
  await page.addInitScript(() => {
    const requestKinds: string[] = [];
    const runtimeTraceBodies = new Map<string, unknown>();
    const nativeFetch = globalThis.fetch.bind(globalThis);
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
    Object.defineProperty(globalThis, "__poietraStudioCanvasWorkerRequestKindsV1", {
      configurable: false,
      enumerable: false,
      value: requestKinds,
      writable: false,
    });
    Object.defineProperty(globalThis, "__poietraRuntimeTraceBodiesV1", {
      configurable: false,
      enumerable: false,
      value: runtimeTraceBodies,
      writable: false,
    });
    globalThis.fetch = async (...arguments_) => {
      const response = await nativeFetch(...arguments_);
      const input = arguments_[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = arguments_[1]?.method ?? (input instanceof Request ? input.method : "GET");
      if (method.toUpperCase() === "POST" && url.pathname.endsWith("/runtime-traces") && response.ok) {
        void response
          .clone()
          .json()
          .then((body: unknown) => {
            const requestId = (body as Readonly<{ requestId?: unknown }>).requestId;
            if (typeof requestId === "string") runtimeTraceBodies.set(requestId, body);
          });
      }
      return response;
    };
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
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.getByLabel("Active imported Scene").selectOption({ label: SCENE_LABEL });

  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  const response = runtimeTraceResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
}

async function capturedRuntimeTraceBody(page: Page, requestId: string) {
  await expect
    .poll(() =>
      page.evaluate((expectedRequestId) => {
        const bodies = (
          globalThis as typeof globalThis & {
            __poietraRuntimeTraceBodiesV1?: ReadonlyMap<string, RuntimeTraceRunBody>;
          }
        ).__poietraRuntimeTraceBodiesV1;
        return bodies?.has(expectedRequestId) ?? false;
      }, requestId),
    )
    .toBe(true);
  return page.evaluate((expectedRequestId) => {
    const bodies = (
      globalThis as typeof globalThis & {
        __poietraRuntimeTraceBodiesV1?: ReadonlyMap<string, RuntimeTraceRunBody>;
      }
    ).__poietraRuntimeTraceBodiesV1;
    const body = bodies?.get(expectedRequestId);
    if (!body) throw new Error("The browser did not retain the Runtime Trace response body.");
    return body;
  }, requestId);
}

async function verifiedRuntimeTrace(page: Page) {
  const response = await openOfficialRuntimeTrace(page);
  expect(response.ok()).toBe(true);
  const request = response.request().postDataJSON() as Record<string, unknown>;
  expect(request).toMatchObject({
    projectId: "real-preview-harness",
    sceneName: SCENE_NAME,
    sourceHash: SOURCE_SHA256,
    sourcePath: SOURCE_PATH,
  });

  if (typeof request.requestId !== "string") throw new Error("The Runtime Trace request has no identity.");
  const body = await capturedRuntimeTraceBody(page, request.requestId);
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
    throw new Error("The verified Runtime Trace response is incomplete.");
  }
  return {
    bundle: body.bundle,
    roots: body.roots,
    runtimeConfigHash: body.runtimeConfigHash,
    sceneId: body.sceneId,
    traceDigest: body.traceDigest,
  };
}

async function exportedSource(page: Page) {
  const exportButton = page.getByRole("button", { name: "Export .py" });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported UpdatersExample candidate source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

async function dragBy(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("The Runtime Trace edit target is not visible.");
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
  await expect(commit).toBeVisible({ timeout: 180_000 });
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
  if (typeof request.requestId !== "string") throw new Error("The edited Runtime Trace request has no identity.");
  const body = await capturedRuntimeTraceBody(page, request.requestId);
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
    throw new Error("The edited Runtime Trace response is incomplete.");
  }
  return {
    bundle: body.bundle,
    roots: body.roots,
    sourceHash: body.sourceHash,
    traceDigest: body.traceDigest,
  };
}

async function retainedWebGpuEvidence(
  page: Page,
  input: Readonly<{ bundle: SceneIrBundleV1; entityIds: readonly string[]; revision: string }>,
) {
  return page.evaluate(
    async ({ bundle, entityIds, revision, rootEvidencePointCount, viewport }) => {
      const { PoietraCanvasWorkerClient } = (await import(
        "/src/engine/canvas-worker-client.ts"
      )) as typeof import("../src/engine/canvas-worker-client");
      const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
        "/src/engine/canvas-worker-evidence.ts"
      )) as typeof import("../src/engine/canvas-worker-evidence");

      class EvidenceCanvasWorker extends globalThis.Worker {
        constructor() {
          super(new URL("/src/engine/poietra-canvas.dev.worker.ts", location.href), { type: "module" });
        }
      }

      const client = new PoietraCanvasWorkerClient({
        evidence: createCanvasWorkerClientEvidenceAdapterV1(),
        requestTimeoutMs: 60_000,
        workerFactory: () => new EvidenceCanvasWorker(),
      });
      const canvas = Object.assign(document.createElement("canvas"), {
        height: viewport.heightPx,
        width: viewport.widthPx,
      });
      const onePixelX = 2 / viewport.widthPx;
      const onePixelY = 2 / viewport.heightPx;
      const evidencePoints = (entries: readonly Record<string, unknown>[]) => {
        const points = [{ fractionX: 0.02, fractionY: 0.02 }];
        for (const entry of entries) {
          if (entry.status !== "present" || !Array.isArray(entry.bounds)) continue;
          const [minimumX, minimumY, maximumX, maximumY] = entry.bounds as [number, number, number, number];
          const centerX = (minimumX + maximumX) / 2;
          const centerY = (minimumY + maximumY) / 2;
          const clipPoints = [
            [minimumX + onePixelX, centerY],
            [maximumX - onePixelX, centerY],
            [centerX, minimumY + onePixelY],
            [centerX, maximumY - onePixelY],
            [centerX, centerY],
          ];
          if (clipPoints.length !== rootEvidencePointCount) throw new Error("Unexpected root evidence point count.");
          for (const [x, y] of clipPoints) {
            points.push({ fractionX: (x! + 1) / 2, fractionY: (1 - y!) / 2 });
          }
        }
        return points;
      };
      const samples = [
        { id: "zero", sampleTime: 0 },
        { id: "before-first-boundary", sampleTime: 1 / 60 - 1e-9 },
        { id: "first-boundary", sampleTime: 1 / 60 },
        { id: "after-first-boundary", sampleTime: 1 / 60 + 1e-9 },
        { id: "bottom", sampleTime: 2.5 },
        { id: "top-return", sampleTime: 5 },
        { id: "before-end", sampleTime: 6 - 1e-9 },
        { id: "end", sampleTime: 6 },
        { id: "bottom-repeat", sampleTime: 2.5 },
      ] as const;
      const results = [];
      try {
        await client.installScene({ canvas, revision, snapshot: bundle });
        for (const sample of samples) {
          const frame = await client.render({
            interactionEntityIds: entityIds,
            revision,
            sampleTime: sample.sampleTime,
            viewport,
          });
          const entries = frame.interaction.status === "available" ? frame.interaction.entries : [];
          const evidence = await client.captureFrameEvidence({ revision, samples: evidencePoints(entries) });
          results.push({ evidence, frame, id: sample.id, requestedInteractionEntityIds: [...entityIds] });
        }
        return results;
      } finally {
        client.dispose();
      }
    },
    { ...input, rootEvidencePointCount: ROOT_EVIDENCE_POINT_COUNT, viewport: VIEWPORT },
  );
}

function expectSamePreparedFrame(
  samples: Map<string, Awaited<ReturnType<typeof retainedWebGpuEvidence>>[number]>,
  leftId: string,
  rightId: string,
) {
  const left = samples.get(leftId);
  const right = samples.get(rightId);
  if (!left || !right) throw new Error(`Missing prepared-frame comparison ${leftId}/${rightId}.`);
  expect(right.frame.interaction).toEqual(left.frame.interaction);
  expect(right.evidence.samples).toEqual(left.evidence.samples);
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
  frames: readonly UpdatersWebGpuFrameV1[],
  candidate?: Readonly<{ sourceHash: string; sourceText: string }>,
) {
  const outputRoot =
    process.env.POIETRA_RUNTIME_TRACE_CAIRO_PARITY_OUTPUT_DIR ?? "test-results/runtime-trace-cairo-parity";
  return withGeneratedRuntimeTraceCairoReferenceV1({
    generatorPath: "scripts/generate-updaters-cairo-reference.py",
    read: (referenceRoot) =>
      compareUpdatersCairoWebGpuFramesV1({
        cairoReferenceRoot: referenceRoot,
        expectedSourceSha256: candidate?.sourceHash ?? SOURCE_SHA256,
        frames,
        outputRoot: candidate ? `${outputRoot}/candidate` : `${outputRoot}/official`,
      }),
    ...(candidate ? { sourceText: candidate.sourceText } : {}),
    temporaryPrefix: "poietra-updaters-cairo-parity-",
  });
}

test("renders official UpdatersExample through an unpublished Runtime Trace and one retained WebGPU Scene", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const run = await verifiedRuntimeTrace(page);
  expect(run.bundle.scene).toMatchObject({
    duration: 6,
    requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "logical-group"],
    sceneId: run.sceneId,
    source: {
      kind: "imported-manim-runtime-trace",
      runtimeConfigHash: run.runtimeConfigHash,
      sourceHash: SOURCE_SHA256,
      traceDigest: run.traceDigest,
      traceVersion: 1,
    },
  });
  expect(run.bundle.scene.entities).toHaveLength(570);
  expect(run.bundle.scene.animationChannels).toHaveLength(1);
  expect(run.roots.map(({ binding }) => binding.name)).toEqual(["square", "decimal"]);
  const rootEntityIds = run.roots.map(({ entityId }) => entityId);
  expect(rootEntityIds).toEqual([`${run.sceneId}/runtime-root:square`, `${run.sceneId}/runtime-root:decimal`]);

  const canvas = page.locator("[data-studio-canvas]");
  await expect
    .poll(
      async () => {
        const phase = await canvas.getAttribute("data-preview-renderer");
        if (phase !== "fallback") return phase;
        const reason = await canvas.getAttribute("data-preview-fallback-reason");
        if (reason !== "install-failed") return phase;
        return `install-failed: ${await page.locator("[data-studio-preview-status]").getAttribute("title")}`;
      },
      { timeout: 60_000 },
    )
    .toBe("presented");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await expect(canvas).toHaveAttribute("data-preview-revision", run.traceDigest);
  await expect(page.locator("[data-studio-preview-status]")).toContainText("verified Runtime Trace · selection only");
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();

  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(playhead).toHaveAttribute("max", "6");
  const packets = new Set<string>();
  for (const sampleTime of [0, 2.5, 5, 6]) {
    await playhead.fill(String(sampleTime));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(canvas).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    // Square is source-bound; DecimalNumber is an opaque, selection-only row
    // projected from the same verified Runtime Trace frame.
    await expect(page.locator("[data-studio-runtime-entity]")).toHaveCount(2);
    const packet = await canvas.getAttribute("data-preview-packet-id");
    if (!packet) throw new Error(`Runtime Trace sample ${sampleTime} has no retained packet identity.`);
    packets.add(packet);
  }
  expect(packets.size).toBe(4);

  const squareTarget = page.getByRole("button", { exact: true, name: "Move square" });
  await expect(squareTarget).toBeVisible();
  await expect(squareTarget).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`[data-studio-runtime-entity="${run.roots[0]?.entityId}"]`)).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  // Runtime Trace roots are selection evidence only. Keyboard commands share
  // the same draft boundary as pointer/Inspector/timeline authoring and must
  // never turn this verified mapping into source-rewrite authority.
  await page.keyboard.press("Delete");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await page.keyboard.press("Control+d");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(squareTarget).toHaveAttribute("aria-pressed", "true");

  const studioWorkerRequestKinds = await page.evaluate(() => {
    const observed = (
      globalThis as typeof globalThis & {
        __poietraStudioCanvasWorkerRequestKindsV1?: readonly string[];
      }
    ).__poietraStudioCanvasWorkerRequestKindsV1;
    return observed ? [...observed] : null;
  });
  expect(studioWorkerRequestKinds).not.toBeNull();
  expect(studioWorkerRequestKinds?.filter((kind) => kind === "install-canvas")).toHaveLength(1);
  expect(studioWorkerRequestKinds?.filter((kind) => kind === "replace-scene")).toHaveLength(0);

  const retained = await retainedWebGpuEvidence(page, {
    bundle: run.bundle,
    entityIds: rootEntityIds,
    revision: run.traceDigest,
  });
  const samples = new Map(retained.map((sample) => [sample.id, sample]));
  for (const sample of retained) {
    expect(sample.frame).toMatchObject({
      interaction: { entries: [expect.any(Object), expect.any(Object)], space: "clip-v1", status: "available" },
      kind: "frame-presented",
      revision: run.traceDigest,
      viewport: VIEWPORT,
    });
    if (sample.frame.interaction.status !== "available") {
      throw new Error(`Runtime Trace interaction evidence is unavailable at ${sample.id}.`);
    }
    expect(sample.requestedInteractionEntityIds).toEqual(rootEntityIds);
    expect(sample.frame.interaction.entries).toHaveLength(rootEntityIds.length);
    for (const [index, entry] of sample.frame.interaction.entries.entries()) {
      const rootEntityId = rootEntityIds[index];
      if (!rootEntityId) throw new Error(`Runtime Trace root identity is missing at positional entry ${index}.`);
      expect(entry.status).toBe("present");
      if (entry.status !== "present") throw new Error(`Runtime Trace root ${rootEntityId} is absent at ${sample.id}.`);
      expect(entry.bounds.every(Number.isFinite)).toBe(true);
      expect(entry.bounds[2]).toBeGreaterThan(entry.bounds[0]);
      expect(entry.bounds[3]).toBeGreaterThan(entry.bounds[1]);
      const rootPixels = sample.evidence.samples.slice(
        1 + index * ROOT_EVIDENCE_POINT_COUNT,
        1 + (index + 1) * ROOT_EVIDENCE_POINT_COUNT,
      );
      expect(rootPixels).toHaveLength(ROOT_EVIDENCE_POINT_COUNT);
      expect(rootPixels.some(([red, green, blue]) => Math.max(red, green, blue) > 8)).toBe(true);
    }
    expect(sample.evidence).toMatchObject({
      packetId: sample.frame.packetId,
      revision: run.traceDigest,
      sampleTime: sample.frame.sampleTime,
      viewport: VIEWPORT,
    });
    expect(sample.evidence.samples[0]).toEqual([0, 0, 0, 255]);
    expect(sample.evidence.samples).toHaveLength(1 + rootEntityIds.length * ROOT_EVIDENCE_POINT_COUNT);
  }
  expectSamePreparedFrame(samples, "zero", "before-first-boundary");
  expectSamePreparedFrame(samples, "first-boundary", "after-first-boundary");
  expectSamePreparedFrame(samples, "top-return", "before-end");
  expectSamePreparedFrame(samples, "before-end", "end");
  expectSamePreparedFrame(samples, "bottom", "bottom-repeat");
  const zero = samples.get("zero");
  const firstBoundary = samples.get("first-boundary");
  const bottom = samples.get("bottom");
  if (!zero || !firstBoundary || !bottom) throw new Error("Missing Runtime Trace difference sample.");
  expect(firstBoundary.frame.interaction).not.toEqual(zero.frame.interaction);
  expect(bottom.frame.interaction).not.toEqual(zero.frame.interaction);

  const fullRgba = await captureRuntimeTraceWebGpuFramesV1(page, {
    bundle: run.bundle,
    revision: run.traceDigest,
    samples: UPDATERS_RUNTIME_TRACE_WEBGPU_SAMPLES_V1,
    viewport: RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  });
  expect(fullRgba).toMatchObject({
    capture: {
      installCount: 1,
      policy: "one-retained-engine",
      renderSubmissionCounts: UPDATERS_RUNTIME_TRACE_WEBGPU_SAMPLES_V1.map(() => 1),
    },
    revision: run.traceDigest,
    viewport: RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  });
  expect(fullRgba.frames.map(({ frameIndex, id, requestSampleTime }) => [id, frameIndex, requestSampleTime])).toEqual(
    UPDATERS_RUNTIME_TRACE_WEBGPU_SAMPLES_V1.map(({ frameIndex, id, sampleTime }) => [id, frameIndex, sampleTime]),
  );
  for (const frame of fullRgba.frames) {
    expect(frame.presentedSampleTime).toBe(frame.requestSampleTime);
    expect(frame.rgba.byteLength).toBe(
      RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1.widthPx * RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1.heightPx * 4,
    );
    expect(frame.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect([...frame.rgba.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect(frame.pixels.nonBlackBounds).not.toBeNull();
    if (!frame.pixels.nonBlackBounds) throw new Error(`Full RGBA frame ${frame.id} has no visible bounds.`);
    expect(frame.pixels.nonBlackBounds.every(Number.isFinite)).toBe(true);
    expect(frame.pixels.nonBlackBounds[2]).toBeGreaterThan(frame.pixels.nonBlackBounds[0]);
    expect(frame.pixels.nonBlackBounds[3]).toBeGreaterThan(frame.pixels.nonBlackBounds[1]);
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
  const fullRgbaFrames = new Map(fullRgba.frames.map((frame) => [frame.id, frame]));
  expectSameFullRgba(fullRgbaFrames, "initial", "hold");
  expectSameFullRgba(fullRgbaFrames, "descent", "return");
  expectSameFullRgba(fullRgbaFrames, "hold", "duration-end");
  expectSameFullRgba(fullRgbaFrames, "bottom", "bottom-repeat");
  expect(fullRgbaFrames.get("initial")?.sha256).not.toBe(fullRgbaFrames.get("bottom")?.sha256);
  expect(fullRgbaFrames.get("play-end")?.sha256).not.toBe(fullRgbaFrames.get("hold")?.sha256);

  if (CAIRO_PARITY_REQUIRED) {
    const parityFrames = UPDATERS_CAIRO_REFERENCE_SAMPLES_V1.map(([id]) => {
      const frame = fullRgbaFrames.get(id);
      if (!frame) throw new Error(`The retained WebGPU readback is missing the ${id} Cairo parity sample.`);
      return {
        frameIndex: frame.frameIndex,
        id,
        rgba: frame.rgba,
        sampleTime: frame.requestSampleTime,
      } satisfies UpdatersWebGpuFrameV1;
    });
    const comparisons = await compareWithIndependentCairo(parityFrames);
    expect(
      comparisons.filter(({ passed }) => !passed),
      JSON.stringify(comparisons, null, 2),
    ).toEqual([]);
  }

  // Mutation authority exists at one exact source boundary only.
  await playhead.fill("4.99");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await playhead.fill("5");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "bounded-interactive");
  await expect(page.locator("[data-studio-preview-status]")).toContainText("Square terminal edit at 5.00s");
  await playhead.fill("5.01");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await playhead.fill("5");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "bounded-interactive");

  const decimalTarget = page.getByRole("button", { exact: true, name: "Move decimal · runtime" });
  await expect(decimalTarget).toBeVisible();
  await decimalTarget.click();
  await expect(decimalTarget).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await squareTarget.click();
  await expect(squareTarget).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Set position" }).click();
  await expect(page.getByRole("button", { name: "Set position" })).toHaveAttribute("aria-pressed", "true");

  const [squareBefore, decimalBefore] = await Promise.all([squareTarget.boundingBox(), decimalTarget.boundingBox()]);
  if (!squareBefore || !decimalBefore) {
    throw new Error("The updater-backed Square and DecimalNumber need interaction bounds at five seconds.");
  }
  const boxCenter = (box: Readonly<{ height: number; width: number; x: number; y: number }>) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  const squareBeforeCenter = boxCenter(squareBefore);
  const decimalBeforeCenter = boxCenter(decimalBefore);
  await dragBy(page, squareTarget, { x: 48, y: 24 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    "Draft ghost · dependent updater validation pending",
  );
  await expect(page.locator("[data-studio-preview-canvas]")).not.toHaveClass(/invisible/u);
  await expect(canvas).toHaveAttribute("data-preview-interaction", "bounded-interactive");
  const squareAfter = await squareTarget.boundingBox();
  if (!squareAfter) throw new Error("The updater-backed Square draft ghost disappeared.");
  const squareAfterCenter = boxCenter(squareAfter);
  const draftDomShift = {
    x: squareAfterCenter.x - squareBeforeCenter.x,
    y: squareAfterCenter.y - squareBeforeCenter.y,
  };
  expect(draftDomShift.x).toBeCloseTo(48, 0);
  expect(draftDomShift.y).toBeCloseTo(24, 0);

  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    "Draft ghost · dependent updater validation pending",
  );
  await expect(page.locator("[data-studio-preview-canvas]")).not.toHaveClass(/invisible/u);

  const squareAfterMove = await squareTarget.boundingBox();
  if (!squareAfterMove) throw new Error("The applied terminal Square move disappeared before resize.");
  const resizeHandle = page.getByRole("button", { name: /Resize square from/u });
  await expect(resizeHandle).toBeVisible();
  await dragBy(page, resizeHandle, { x: 36, y: 36 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toContainText(
    "Draft ghost · dependent updater validation pending",
  );
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  const squareAfterResize = await squareTarget.boundingBox();
  if (!squareAfterResize) throw new Error("The updater-backed Square resize ghost disappeared.");
  expect(squareAfterResize.width).toBeGreaterThan(squareAfterMove.width * 1.1);
  expect(squareAfterResize.height).toBeGreaterThan(squareAfterMove.height * 1.1);
  expect(boxCenter(squareAfterResize).x).toBeCloseTo(boxCenter(squareAfterMove).x, 0);
  expect(boxCenter(squareAfterResize).y).toBeCloseTo(boxCenter(squareAfterMove).y, 0);
  await expect(resizeHandle).toHaveCount(0);

  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const squareAfterResizeApply = await squareTarget.boundingBox();
  if (!squareAfterResizeApply) throw new Error("The applied terminal Square resize ghost disappeared.");
  expect(squareAfterResizeApply.width).toBeCloseTo(squareAfterResize.width, 0);
  expect(squareAfterResizeApply.height).toBeCloseTo(squareAfterResize.height, 0);
  expect(boxCenter(squareAfterResizeApply).x).toBeCloseTo(boxCenter(squareAfterMove).x, 0);
  expect(boxCenter(squareAfterResizeApply).y).toBeCloseTo(boxCenter(squareAfterMove).y, 0);

  const candidateSource = await exportedSource(page);
  const candidateSourceHash = createHash("sha256").update(candidateSource, "utf8").digest("hex");
  const animationEnd = candidateSource.indexOf("            run_time=5,\n        )");
  const terminalMove = candidateSource.indexOf("        square.move_to((", animationEnd);
  const terminalScale = candidateSource.indexOf("        square.scale(", terminalMove);
  const dependentUpdaterRefresh = candidateSource.indexOf("        decimal.update(0)", terminalScale);
  const terminalWait = candidateSource.indexOf("        self.wait()", dependentUpdaterRefresh);
  expect(animationEnd).toBeGreaterThanOrEqual(0);
  expect(terminalMove).toBeGreaterThan(animationEnd);
  expect(terminalScale).toBeGreaterThan(terminalMove);
  expect(dependentUpdaterRefresh).toBeGreaterThan(terminalScale);
  expect(terminalWait).toBeGreaterThan(dependentUpdaterRefresh);
  expect(candidateSource.match(/^\s*square\.move_to\(\(/gmu)).toHaveLength(1);
  expect(candidateSource.match(/^\s*square\.scale\(/gmu)).toHaveLength(1);
  expect(candidateSource.match(/^\s*decimal\.update\(0\)$/gmu)).toHaveLength(1);

  const edited = await renderCommitAndFreshRuntimeTrace(page);
  expect(edited.sourceHash).toBe(candidateSourceHash);
  expect(edited.sourceHash).not.toBe(SOURCE_SHA256);
  expect(edited.traceDigest).not.toBe(run.traceDigest);
  expect(edited.bundle.scene.source).toMatchObject({
    kind: "imported-manim-runtime-trace",
    sourceHash: edited.sourceHash,
    traceDigest: edited.traceDigest,
    traceVersion: 1,
  });
  expect(edited.roots.map(({ binding }) => binding.name)).toEqual(["square", "decimal"]);
  await expect(canvas).toHaveAttribute("data-preview-revision", edited.traceDigest, { timeout: 60_000 });
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
  await playhead.fill("5");
  await expect(canvas).toHaveAttribute("data-preview-sample-time", "5");
  await expect(canvas).toHaveAttribute("data-preview-interaction", "selection-only");
  await expect(page.locator("[data-studio-preview-status]")).toContainText("selection only");

  const editedSquare = page.getByRole("button", { exact: true, name: "Move square" });
  const editedDecimal = page.getByRole("button", { exact: true, name: "Move decimal · runtime" });
  const [editedSquareBox, editedDecimalBox] = await Promise.all([
    editedSquare.boundingBox(),
    editedDecimal.boundingBox(),
  ]);
  if (!editedSquareBox || !editedDecimalBox) {
    throw new Error("The edited Square and dependent DecimalNumber need interaction bounds at five seconds.");
  }
  const editedSquareCenter = boxCenter(editedSquareBox);
  const editedDecimalCenter = boxCenter(editedDecimalBox);
  const squareDomShift = {
    x: editedSquareCenter.x - squareBeforeCenter.x,
    y: editedSquareCenter.y - squareBeforeCenter.y,
  };
  const decimalDomShift = {
    x: editedDecimalCenter.x - decimalBeforeCenter.x,
    y: editedDecimalCenter.y - decimalBeforeCenter.y,
  };
  expect(squareDomShift.x).toBeCloseTo(draftDomShift.x, 0);
  expect(squareDomShift.y).toBeCloseTo(draftDomShift.y, 0);
  // The semantic draft box excludes paint, while fresh retained interaction
  // bounds include the Square stroke. Their centers and scale must agree, with
  // only that small paint expansion left after the candidate is re-executed.
  expect(Math.abs(editedSquareBox.width - squareAfterResizeApply.width)).toBeLessThan(3);
  expect(Math.abs(editedSquareBox.height - squareAfterResizeApply.height)).toBeLessThan(3);
  expect(decimalDomShift.x).toBeCloseTo(squareDomShift.x + (editedSquareBox.width - squareBefore.width) / 2, 0);
  expect(decimalDomShift.y).toBeCloseTo(squareDomShift.y, 0);

  for (const selector of [editedSquare, editedDecimal]) {
    await expect(selector).toBeVisible();
    await selector.click();
    await expect(selector).toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.getByRole("button", { name: /Resize square from/u })).toHaveCount(0);

  const editedRootEntityIds = edited.roots.map(({ entityId }) => entityId);
  const editedRetained = await retainedWebGpuEvidence(page, {
    bundle: edited.bundle,
    entityIds: editedRootEntityIds,
    revision: edited.traceDigest,
  });
  const editedSamples = new Map(editedRetained.map((sample) => [sample.id, sample]));
  expectSamePreparedFrame(editedSamples, "bottom", "bottom-repeat");
  const officialTerminal = samples.get("top-return");
  const editedTerminal = editedSamples.get("top-return");
  if (
    !officialTerminal ||
    !editedTerminal ||
    officialTerminal.frame.interaction.status !== "available" ||
    editedTerminal.frame.interaction.status !== "available"
  ) {
    throw new Error("The official and edited terminal frames need interaction evidence.");
  }
  const terminalShifts = officialTerminal.frame.interaction.entries.map((entry, index) => {
    const next = editedTerminal.frame.interaction.entries[index];
    if (entry.status !== "present" || next?.status !== "present") {
      throw new Error(`Runtime Trace root ${index} is absent from the terminal comparison.`);
    }
    const center = (bounds: readonly [number, number, number, number]) => ({
      x: (bounds[0] + bounds[2]) / 2,
      y: (bounds[1] + bounds[3]) / 2,
    });
    const before = center(entry.bounds);
    const after = center(next.bounds);
    const width = entry.bounds[2] - entry.bounds[0];
    const nextWidth = next.bounds[2] - next.bounds[0];
    const height = entry.bounds[3] - entry.bounds[1];
    const nextHeight = next.bounds[3] - next.bounds[1];
    if (index === 0) {
      expect(nextWidth).toBeGreaterThan(width * 1.1);
      expect(nextHeight).toBeGreaterThan(height * 1.1);
    } else {
      expect(Math.hypot(nextWidth - width, nextHeight - height)).toBeGreaterThan(0.0001);
    }
    return { x: after.x - before.x, y: after.y - before.y };
  });
  expect(terminalShifts).toHaveLength(2);
  expect(Math.hypot(terminalShifts[0]?.x ?? 0, terminalShifts[0]?.y ?? 0)).toBeGreaterThan(0.01);
  const officialSquareEntry = officialTerminal.frame.interaction.entries[0];
  const editedSquareEntry = editedTerminal.frame.interaction.entries[0];
  if (officialSquareEntry?.status !== "present" || editedSquareEntry?.status !== "present") {
    throw new Error("The Square needs retained terminal bounds for updater placement evidence.");
  }
  const squareHalfWidthGrowth =
    (editedSquareEntry.bounds[2] -
      editedSquareEntry.bounds[0] -
      (officialSquareEntry.bounds[2] - officialSquareEntry.bounds[0])) /
    2;
  expect(terminalShifts[1]?.x).toBeCloseTo((terminalShifts[0]?.x ?? Number.NaN) + squareHalfWidthGrowth, 2);
  expect(terminalShifts[1]?.y).toBeCloseTo(terminalShifts[0]?.y ?? Number.NaN, 2);

  const editedFullRgba = await captureRuntimeTraceWebGpuFramesV1(page, {
    bundle: edited.bundle,
    revision: edited.traceDigest,
    samples: UPDATERS_RUNTIME_TRACE_WEBGPU_SAMPLES_V1,
    viewport: RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  });
  expect(editedFullRgba.capture).toEqual({
    installCount: 1,
    policy: "one-retained-engine",
    renderSubmissionCounts: UPDATERS_RUNTIME_TRACE_WEBGPU_SAMPLES_V1.map(() => 1),
  });
  const editedFullRgbaFrames = new Map(editedFullRgba.frames.map((frame) => [frame.id, frame]));
  expectSameFullRgba(editedFullRgbaFrames, "bottom", "bottom-repeat");
  expectSameFullRgba(editedFullRgbaFrames, "hold", "duration-end");
  expect(editedFullRgbaFrames.get("initial")?.sha256).not.toBe(editedFullRgbaFrames.get("hold")?.sha256);

  if (CAIRO_PARITY_REQUIRED) {
    const parityFrames = UPDATERS_CAIRO_REFERENCE_SAMPLES_V1.map(([id]) => {
      const frame = editedFullRgbaFrames.get(id);
      if (!frame) throw new Error(`The edited WebGPU readback is missing the ${id} Cairo parity sample.`);
      return {
        frameIndex: frame.frameIndex,
        id,
        rgba: frame.rgba,
        sampleTime: frame.requestSampleTime,
      } satisfies UpdatersWebGpuFrameV1;
    });
    const comparisons = await compareWithIndependentCairo(parityFrames, {
      sourceHash: edited.sourceHash,
      sourceText: candidateSource,
    });
    expect(
      comparisons.filter(({ passed }) => !passed),
      JSON.stringify(comparisons, null, 2),
    ).toEqual([]);
  }

  await dragBy(page, editedSquare, { x: 24, y: -12 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  const editabilityBaseline = JSON.parse(
    await readFile(new URL("../fixtures/real-manim-editability-census-v1/baseline.json", import.meta.url), "utf8"),
  ) as unknown;
  const caseId = "fast-manim-basic/UpdatersExample/runtime-trace-v1" as const;
  assertRealManimEditabilityCensusCaseFloor(
    caseId,
    REAL_MANIM_EDITABILITY_CAPABILITIES.map((capability) => ({ capability, caseId, status: "proven" as const })),
    editabilityBaseline,
  );
});
