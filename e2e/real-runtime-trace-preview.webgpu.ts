import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
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
const execFile = promisify(execFileCallback);

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
  const response = runtimeTraceResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
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

async function compareWithIndependentCairo(frames: readonly UpdatersWebGpuFrameV1[]) {
  const commandText = process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND?.trim();
  const repositoryText = process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_REPOSITORY?.trim();
  if (!commandText || !repositoryText) {
    throw new Error(
      "Runtime Trace Cairo parity requires POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND and POIETRA_FAST_MANIM_RUNTIME_TRACE_REPOSITORY.",
    );
  }
  let command: unknown;
  try {
    command = JSON.parse(commandText);
  } catch (error) {
    throw new Error("Runtime Trace Cairo parity requires the producer command as a JSON argv array.", { cause: error });
  }
  if (
    !Array.isArray(command) ||
    command.length !== 3 ||
    !command.every((argument) => typeof argument === "string" && argument.length > 0) ||
    command[1] !== "-m" ||
    command[2] !== "manim.renderer.runtime_trace"
  ) {
    throw new Error('Runtime Trace Cairo parity requires [python, "-m", "manim.renderer.runtime_trace"].');
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "poietra-updaters-cairo-parity-"));
  const referenceRoot = join(temporaryRoot, "reference");
  try {
    await execFile(
      command[0],
      [
        resolve("scripts/generate-updaters-cairo-reference.py"),
        "--fast-manim",
        resolve(repositoryText),
        "--output",
        referenceRoot,
      ],
      { env: { ...process.env, PYTHONHASHSEED: "0" }, maxBuffer: 2 * 1024 * 1024 },
    );
    return await compareUpdatersCairoWebGpuFramesV1({
      cairoReferenceRoot: referenceRoot,
      frames,
      outputRoot:
        process.env.POIETRA_RUNTIME_TRACE_CAIRO_PARITY_OUTPUT_DIR ?? "test-results/runtime-trace-cairo-parity",
    });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
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
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 60_000 });
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
    // Static Studio projection currently exposes the source-bound Square row;
    // both verified Runtime Trace roots are exercised directly below.
    await expect(page.locator("[data-studio-runtime-entity]")).toHaveCount(1);
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
});
