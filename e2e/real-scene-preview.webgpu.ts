import { expect, type Page, type Response, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { VerifiedSourceRuntimeIdentityMapV1 } from "../src/engine/source-runtime-identity";

const SERVER_QUERY = "?previewRenderer=server";
const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";
const DYNAMIC_BINDING_ID = "source-binding:03b26136c2567ae10a842328e2aa564bf41847aadcb07fdc5d2942b3ac441398";
const DYNAMIC_CLIP_BOUNDS = [-0.17578125, -0.3125, 0.17578125, 0.3125] as const;
const DYNAMIC_SCENE_ID = "scene:6b288d59a3a8c97d32ce60dd8518133ad740f2bc5172eb71d571309156713094";
const DYNAMIC_RUNTIME_ENTITY_ID = `${DYNAMIC_SCENE_ID}/entity:0`;
const DYNAMIC_SOURCE_HASH = "4cb935a058980b3131ab26b756c71cb08ce6a72524c51bbc05b282343bd93702";
const DYNAMIC_VIEWPORT = "832x468";

type RgbaPixel = readonly [number, number, number, number];

function expectPixelNear(actual: RgbaPixel, expected: RgbaPixel, tolerance = 4) {
  for (const [index, component] of actual.entries()) {
    expect(Math.abs(component - expected[index])).toBeLessThanOrEqual(tolerance);
  }
}

function snapshotResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === SNAPSHOT_PATH &&
      response.status() === 200,
  );
}

async function openRealWorkspace(page: Page) {
  await page.goto(`/${SERVER_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Real Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Real Preview Harness");
  await page.getByLabel("Active imported Scene").selectOption({ label: "scene.py · RealPreviewScene" });
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  const response = snapshotResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
}

async function selectScene(page: Page, name: string, sourcePath = "scene.py") {
  // Keep producer outcomes in separate fixture files so a failed or
  // unsupported request has one unambiguous source-level cause.
  const response = snapshotResponse(page);
  await page.getByLabel("Active imported Scene").selectOption({ label: `${sourcePath} · ${name}` });
  return response;
}

async function expectRunStatus(responsePromise: Promise<Response>, status: string) {
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    failure?: { code?: string };
    revision?: number;
    snapshot?: { bundle?: SceneIrBundleV1; snapshotHash?: string };
    sourceRuntimeIdentity?: VerifiedSourceRuntimeIdentityMapV1;
    status?: string;
  };
  expect(body.status).toBe(status);
  return body;
}

async function expectVerifiedRun(responsePromise: Promise<Response>) {
  const body = await expectRunStatus(responsePromise, "verified");
  expect(typeof body.revision).toBe("number");
  if (typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1) {
    throw new Error("The Scene snapshot response did not expose a positive integer publication revision.");
  }
  return { ...body, revision: body.revision };
}

async function expectPresented(page: Page, revision: number) {
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toContainText(`verified server snapshot r${revision}`);
  await expect(page.locator("[data-studio-preview-status]")).toContainText("editing preview only");
}

/**
 * Complementary renderer proof: render the server-sealed bundle in an
 * independent worker and read exact GPU texture pixels. The locator screenshot
 * remains an issue #78 real-GPU gate because this headless environment does
 * not compositor-capture even a fenced main-thread WebGPU clear.
 */
async function readBackIndependentRendererPixels(
  page: Page,
  input: Readonly<{ revision: string; sampleTime: number; snapshot: SceneIrBundleV1; viewport: string }>,
) {
  return page.evaluate(async ({ revision, sampleTime, snapshot, viewport }) => {
    const [widthPx, heightPx] = viewport.split("x").map(Number);
    const canvas = Object.assign(document.createElement("canvas"), { height: heightPx, width: widthPx });
    const clientModuleUrl = "/src/engine/canvas-worker-client.ts";
    const evidenceModuleUrl = "/src/engine/canvas-worker-evidence.ts";
    const { PoietraCanvasWorkerClient } = (await import(
      clientModuleUrl
    )) as typeof import("../src/engine/canvas-worker-client");
    const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
      evidenceModuleUrl
    )) as typeof import("../src/engine/canvas-worker-evidence");
    const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
    try {
      await client.installScene({ canvas, revision, snapshot });
      const frame = await client.render({ revision, sampleTime, viewport: { heightPx, widthPx } });
      const evidence = await client.captureFrameEvidence({
        revision,
        samples: [
          { fractionX: 0.03, fractionY: 0.05 },
          { fractionX: 0.5 - 27 / 128, fractionY: 0.5 },
          { fractionX: 0.5 + 18 / 128, fractionY: 0.5 },
          { fractionX: 0.5, fractionY: 0.25 },
        ],
      });
      return { evidence, frame };
    } finally {
      client.dispose();
    }
  }, input);
}

async function readBackDynamicRendererSamples(
  page: Page,
  input: Readonly<{
    entityId: string;
    revision: string;
    samples: readonly Readonly<{ id: string; sampleTime: number }>[];
    snapshot: SceneIrBundleV1;
    viewport: string;
  }>,
) {
  return page.evaluate(async ({ entityId, revision, samples, snapshot, viewport }) => {
    const [widthPx, heightPx] = viewport.split("x").map(Number);
    const canvas = Object.assign(document.createElement("canvas"), { height: heightPx, width: widthPx });
    const clientModuleUrl = "/src/engine/canvas-worker-client.ts";
    const evidenceModuleUrl = "/src/engine/canvas-worker-evidence.ts";
    const { PoietraCanvasWorkerClient } = (await import(
      clientModuleUrl
    )) as typeof import("../src/engine/canvas-worker-client");
    const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
      evidenceModuleUrl
    )) as typeof import("../src/engine/canvas-worker-evidence");
    const client = new PoietraCanvasWorkerClient({ evidence: createCanvasWorkerClientEvidenceAdapterV1() });
    try {
      await client.installScene({ canvas, revision, snapshot });
      const results = [];
      for (const sample of samples) {
        const frame = await client.render({
          interactionEntityIds: [entityId],
          revision,
          sampleTime: sample.sampleTime,
          viewport: { heightPx, widthPx },
        });
        const evidence = await client.captureFrameEvidence({
          revision,
          samples: [
            { fractionX: 0.5, fractionY: 0.5 },
            { fractionX: 0.03, fractionY: 0.05 },
          ],
        });
        results.push({ evidence, frame, id: sample.id });
      }
      return results;
    } finally {
      client.dispose();
    }
  }, input);
}

async function expectWholeSceneFallback(page: Page, status: "failed" | "unsupported") {
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(canvasRoot).toHaveAttribute("data-preview-fallback-reason", "snapshot-unavailable");
  await expect(canvasRoot).not.toHaveAttribute("data-preview-packet-id", /.+/);
  await expect(page.locator("[data-studio-preview-status]")).toHaveAttribute("title", new RegExp(`\\(${status}\\)`));
  const semanticPaint = page.locator("[data-studio-semantic-paint]");
  await expect(semanticPaint).toHaveCount(1);
  await expect(semanticPaint).toHaveAttribute("data-studio-semantic-paint", "painted");
  await expect(semanticPaint).toBeVisible();
}

test("correlates a real fast-manim Scene with the retained host and verifies GPU texture output", async ({ page }) => {
  test.info().annotations.push({
    description: "Issue #78: visible WebGPU compositor golden requires a real-GPU browser lane.",
    type: "evidence-gap",
  });
  const run = await expectVerifiedRun(await openRealWorkspace(page));
  expect(run.snapshot?.bundle?.scene?.entities).toHaveLength(3);
  expect(run.snapshot?.bundle?.scene.duration).toBe(1);
  await expectPresented(page, run.revision);

  for (const name of ["circle", "rectangle", "line"]) {
    await expect(page.getByRole("button", { name: `Move ${name}`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Inspector" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Timeline playhead" })).toBeVisible();
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Move circle", exact: true })).toHaveAttribute("aria-pressed", "false");

  const canvas = page.locator("[data-studio-preview-canvas]");
  await canvas.evaluate((element) => {
    element.dataset.realProducerCanvas = "retained";
  });
  const canvasRoot = page.locator("[data-studio-canvas]");
  if (!run.snapshot?.snapshotHash) {
    throw new Error("The verified server snapshot did not expose a snapshot hash.");
  }
  await expect(canvasRoot).toHaveAttribute("data-preview-revision", run.snapshot.snapshotHash);

  await page.getByRole("button", { name: "Set position" }).click();
  const circleButton = page.getByRole("button", { name: "Move circle", exact: true });
  await page.getByRole("checkbox", { name: "Select circle" }).check();
  await expect(circleButton).toHaveAttribute("aria-pressed", "true");
  const resizeHandle = page.getByRole("button", { name: "Resize circle from bottom-right corner" });
  await expect(resizeHandle).toBeVisible();
  await resizeHandle.press("ArrowRight");
  await expect(canvasRoot).toHaveAttribute("data-preview-fallback-reason", "snapshot-uncorrelated");
  await expect(page.locator("[data-studio-semantic-paint]").first()).toHaveAttribute(
    "data-studio-semantic-paint",
    "painted",
  );
  await page.getByRole("button", { name: "Discard" }).click();
  await expectPresented(page, run.revision);
  await expect(canvasRoot).toHaveAttribute("data-preview-revision", run.snapshot.snapshotHash);

  const firstPacket = await canvasRoot.getAttribute("data-preview-packet-id");
  const viewport = await canvasRoot.getAttribute("data-preview-viewport");
  if (!run.snapshot.bundle || !viewport) {
    throw new Error("The verified server snapshot did not expose complete WebGPU proof inputs.");
  }
  const proof = await readBackIndependentRendererPixels(page, {
    revision: run.snapshot.snapshotHash,
    sampleTime: 0,
    snapshot: run.snapshot.bundle,
    viewport,
  });
  expect(proof.frame).toMatchObject({ kind: "frame-presented", revision: run.snapshot.snapshotHash, sampleTime: 0 });
  expect(proof.evidence).toMatchObject({
    packetId: proof.frame.packetId,
    revision: run.snapshot.snapshotHash,
    sampleTime: 0,
  });
  expect(`${proof.evidence.viewport.widthPx}x${proof.evidence.viewport.heightPx}`).toBe(viewport);
  const [background, circlePixel, rectangle, line] = proof.evidence.samples;
  expectPixelNear(background, [0, 0, 0, 255]);
  expectPixelNear(circlePixel, [252, 98, 85, 255]);
  expectPixelNear(rectangle, [88, 196, 221, 255]);
  expectPixelNear(line, [131, 193, 103, 255]);

  const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(scenePlayhead).toHaveAttribute("max", "1");
  await scenePlayhead.fill("0.6");
  await expectPresented(page, run.revision);
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.6");
  await expect(canvas).toHaveAttribute("data-real-producer-canvas", "retained");
  const seekPacket = await canvasRoot.getAttribute("data-preview-packet-id");
  expect(seekPacket).not.toBe(firstPacket);

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect.poll(async () => Number(await scenePlayhead.inputValue())).toBeGreaterThan(0.6);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expectPresented(page, run.revision);
  await expect(canvas).toHaveAttribute("data-real-producer-canvas", "retained");
  expect(await canvasRoot.getAttribute("data-preview-packet-id")).not.toBe(seekPacket);
  const sliderStep = Number(await scenePlayhead.getAttribute("step"));
  expect(
    Math.abs(
      Number(await canvasRoot.getAttribute("data-preview-sample-time")) - Number(await scenePlayhead.inputValue()),
    ),
  ).toBeLessThanOrEqual(sliderStep / 2);
});

test("preserves real V2 opacity and lifetime boundaries across non-monotonic WebGPU seeks", async ({ page }) => {
  await expectVerifiedRun(await openRealWorkspace(page));
  const run = await expectVerifiedRun(await selectScene(page, "DynamicOpacityLifetimeScene", "scene_dynamic.py"));
  const bundle = run.snapshot?.bundle;
  const revision = run.snapshot?.snapshotHash;
  if (!bundle || !revision) throw new Error("The dynamic Scene did not publish a complete verified snapshot.");
  expect(bundle.scene).toMatchObject({
    duration: 7,
    requiredCapabilities: ["cubic-path-geometry", "opacity-animation"],
    source: { kind: "imported-manim-server-snapshot", snapshotVersion: 2 },
  });
  expect(bundle.scene.entities).toHaveLength(1);
  expect(bundle.scene.entities[0]?.lifetimes).toEqual([{ end: 6, start: 1 }]);
  expect(bundle.scene.animationChannels).toMatchObject([
    {
      entityId: bundle.scene.entities[0]?.id,
      keyframes: [
        { at: 1, value: 0 },
        { at: 3, value: 1 },
        { at: 4, value: 1 },
        { at: 6, value: 0 },
      ],
      kind: "opacity",
    },
  ]);
  expect(run.sourceRuntimeIdentity).toMatchObject({
    mappings: [
      {
        binding: {
          id: DYNAMIC_BINDING_ID,
          name: "circle",
          ordinal: 1,
          span: { endColumn: 14, endLine: 6, startColumn: 8, startLine: 6 },
        },
        entityId: DYNAMIC_RUNTIME_ENTITY_ID,
        familyPath: [],
        provenanceId: `${DYNAMIC_SCENE_ID}/provenance:entity:0`,
      },
    ],
    sceneId: DYNAMIC_SCENE_ID,
    snapshotHash: revision,
    sourceHash: DYNAMIC_SOURCE_HASH,
  });
  await expectPresented(page, run.revision);

  const canvasRoot = page.locator("[data-studio-canvas]");
  const viewport = await canvasRoot.getAttribute("data-preview-viewport");
  const entityId = bundle.scene.entities[0]?.id;
  if (!viewport || !entityId) throw new Error("The dynamic WebGPU proof inputs were incomplete.");
  expect(entityId).toBe(DYNAMIC_RUNTIME_ENTITY_ID);
  expect(viewport).toBe(DYNAMIC_VIEWPORT);
  const samplePlan = [
    { id: "before-start", sampleTime: 59 / 60 },
    { id: "at-start", sampleTime: 1 },
    { id: "after-start", sampleTime: 61 / 60 },
    { id: "a-first", sampleTime: 2 },
    { id: "b", sampleTime: 3 },
    { id: "a-repeat", sampleTime: 2 },
    { id: "before-end", sampleTime: 359 / 60 },
    { id: "at-end", sampleTime: 6 },
    { id: "after-end", sampleTime: 361 / 60 },
    { id: "a-final-rewind", sampleTime: 2 },
  ] as const;
  const samples = await readBackDynamicRendererSamples(page, {
    entityId,
    revision,
    samples: samplePlan,
    snapshot: bundle,
    viewport,
  });
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const inactiveSamples = new Set(["before-start", "at-end", "after-end"]);

  for (const planned of samplePlan) {
    const sample = byId.get(planned.id);
    expect(sample?.frame).toMatchObject({
      kind: "frame-presented",
      revision,
      sampleTime: planned.sampleTime,
    });
    expect(sample?.evidence).toMatchObject({
      packetId: sample?.frame.packetId,
      revision,
      sampleTime: planned.sampleTime,
      viewport: sample?.frame.viewport,
    });
    expect(sample?.frame.interaction).toEqual({
      entries: inactiveSamples.has(planned.id)
        ? [{ status: "inactive" }]
        : [{ bounds: DYNAMIC_CLIP_BOUNDS, status: "present" }],
      space: "clip-v1",
      status: "available",
    });
  }

  const center = (id: string) => byId.get(id)?.evidence.samples[0] as RgbaPixel;
  const background = (id: string) => byId.get(id)?.evidence.samples[1] as RgbaPixel;
  for (const id of ["before-start", "at-start", "at-end", "after-end"]) {
    expect(center(id)).toEqual(background(id));
  }
  expect(center("after-start")).not.toEqual(background("after-start"));
  expect(center("before-end")).toEqual(center("after-start"));
  expectPixelNear(center("a-first"), [185, 70, 60, 255]);
  expectPixelNear(center("b"), [252, 98, 85, 255]);
  expect(center("a-repeat")).toEqual(center("a-first"));
  expect(center("a-final-rewind")).toEqual(center("a-first"));

  const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(scenePlayhead).toHaveAttribute("max", "7");
  const circle = page.getByRole("button", { name: "Move circle", exact: true });
  const studioId = await circle.getAttribute("data-studio-entity");
  if (!studioId) throw new Error("The dynamic Scene did not expose its source-owned Studio circle.");
  const wrapper = page.locator(`[data-studio-entity-wrapper="${studioId}"]`);
  const hostPackets = new Set<string>();
  for (const sampleTime of [2, 3, 2]) {
    await scenePlayhead.fill(String(sampleTime));
    await expectPresented(page, run.revision);
    await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", String(sampleTime));
    await expect(wrapper).toHaveAttribute("data-studio-runtime-binding", DYNAMIC_BINDING_ID);
    await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", DYNAMIC_RUNTIME_ENTITY_ID);
    await expect(wrapper).toHaveAttribute("data-studio-entity-height", "2.5000");
    await expect(wrapper).toHaveAttribute("data-studio-entity-width", "2.5000");
    const circleBox = await circle.boundingBox();
    const canvasBox = await canvasRoot.boundingBox();
    if (!circleBox || !canvasBox) throw new Error("The dynamic runtime hit target was not visible.");
    const centerX = (circleBox.x + circleBox.width / 2 - canvasBox.x) / canvasBox.width;
    const centerY = (circleBox.y + circleBox.height / 2 - canvasBox.y) / canvasBox.height;
    expect(Math.abs(centerX - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(centerY - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(circleBox.width / canvasBox.width - 0.17578125)).toBeLessThan(0.01);
    expect(Math.abs(circleBox.height / canvasBox.height - 0.3125)).toBeLessThan(0.01);
    hostPackets.add((await canvasRoot.getAttribute("data-preview-packet-id")) ?? "");
  }
  expect(hostPackets.size).toBe(3);
});

test("falls back the whole Scene for real producer unsupported and exit results", async ({ page }) => {
  await expectRunStatus(await openRealWorkspace(page), "verified");

  const unsupported = await expectRunStatus(
    await selectScene(page, "UnsupportedPreviewScene", "scene_unsupported.py"),
    "unsupported",
  );
  expect(unsupported.failure).toBeUndefined();
  await expectWholeSceneFallback(page, "unsupported");
  await expect(page.getByRole("button", { name: "Move circle", exact: true })).toBeVisible();

  const failed = await expectRunStatus(await selectScene(page, "FailedPreviewScene", "scene_failed.py"), "failed");
  expect(failed.failure?.code).toBe("producer-exit");
  await expectWholeSceneFallback(page, "failed");
  await expect(page.getByRole("button", { name: "Move circle", exact: true })).toBeVisible();
});
