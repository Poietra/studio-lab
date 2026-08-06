import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";

const RUNTIME_TRACE_PATH = "/api/manim/projects/real-preview-harness/runtime-traces";
const SOURCE_PATH = "example_scenes/basic.py";
const SCENE_NAME = "UpdatersExample";
const SCENE_LABEL = `${SOURCE_PATH} · ${SCENE_NAME}`;
const SOURCE_SHA256 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;

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
    async ({ bundle, entityIds, revision, viewport }) => {
      const { PoietraCanvasWorkerClient } = (await import(
        "/src/engine/canvas-worker-client.ts"
      )) as typeof import("../src/engine/canvas-worker-client");
      const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
        "/src/engine/canvas-worker-evidence.ts"
      )) as typeof import("../src/engine/canvas-worker-evidence");

      type ObservedRequest = Readonly<{ kind?: string }>;
      const lifecycle: string[] = [];
      const NativeWorker = globalThis.Worker;
      class ObservedCanvasWorker extends NativeWorker {
        constructor() {
          super(new URL("/src/engine/poietra-canvas.dev.worker.ts", location.href), { type: "module" });
        }

        override postMessage(message: unknown, transferOrOptions?: StructuredSerializeOptions | Transferable[]) {
          lifecycle.push((message as ObservedRequest).kind ?? "unknown");
          if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
          else super.postMessage(message, transferOrOptions);
        }
      }

      const client = new PoietraCanvasWorkerClient({
        evidence: createCanvasWorkerClientEvidenceAdapterV1(),
        requestTimeoutMs: 60_000,
        workerFactory: () => new ObservedCanvasWorker(),
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
          results.push({ evidence, frame, id: sample.id });
        }
        return { lifecycle, results };
      } finally {
        client.dispose();
      }
    },
    { ...input, viewport: VIEWPORT },
  );
}

function expectSamePreparedFrame(
  samples: Map<string, Awaited<ReturnType<typeof retainedWebGpuEvidence>>["results"][number]>,
  leftId: string,
  rightId: string,
) {
  const left = samples.get(leftId);
  const right = samples.get(rightId);
  if (!left || !right) throw new Error(`Missing prepared-frame comparison ${leftId}/${rightId}.`);
  expect(right.frame.interaction).toEqual(left.frame.interaction);
  expect(right.evidence.samples).toEqual(left.evidence.samples);
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
  expect(run.roots.map(({ entityId }) => entityId)).toEqual([
    `${run.sceneId}/runtime-root:square`,
    `${run.sceneId}/runtime-root:decimal`,
  ]);

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

  const retained = await retainedWebGpuEvidence(page, {
    bundle: run.bundle,
    entityIds: run.roots.map(({ entityId }) => entityId),
    revision: run.traceDigest,
  });
  expect(retained.lifecycle.filter((kind) => kind === "install-canvas" || kind === "replace-scene")).toEqual([
    "install-canvas",
  ]);
  const samples = new Map(retained.results.map((sample) => [sample.id, sample]));
  for (const sample of retained.results) {
    expect(sample.frame).toMatchObject({
      interaction: { entries: [expect.any(Object), expect.any(Object)], space: "clip-v1", status: "available" },
      kind: "frame-presented",
      revision: run.traceDigest,
      viewport: VIEWPORT,
    });
    expect(sample.frame.interaction.entries.every(({ status }) => status === "present")).toBe(true);
    expect(sample.evidence).toMatchObject({
      packetId: sample.frame.packetId,
      revision: run.traceDigest,
      sampleTime: sample.frame.sampleTime,
      viewport: VIEWPORT,
    });
    expect(sample.evidence.samples[0]).toEqual([0, 0, 0, 255]);
    expect(sample.evidence.samples.slice(1).some(([red, green, blue]) => Math.max(red, green, blue) > 8)).toBe(true);
  }
  expectSamePreparedFrame(samples, "zero", "before-first-boundary");
  expectSamePreparedFrame(samples, "first-boundary", "after-first-boundary");
  expectSamePreparedFrame(samples, "before-end", "end");
  expectSamePreparedFrame(samples, "bottom", "bottom-repeat");
  expect(samples.get("zero")?.frame.interaction).not.toEqual(samples.get("bottom")?.frame.interaction);
});
