import { expect, type Page, type Response, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";

const SERVER_QUERY = "?previewRenderer=server";
const SNAPSHOT_PATH = "/api/manim/projects/real-preview-harness/scene-snapshots";

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
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  const response = snapshotResponse(page);
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  return response;
}

async function selectScene(page: Page, name: string) {
  const response = snapshotResponse(page);
  await page.getByLabel("Active imported Scene").selectOption({ label: `scene.py · ${name}` });
  return response;
}

async function expectRunStatus(responsePromise: Promise<Response>, status: string) {
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    failure?: { code?: string };
    revision?: number;
    snapshot?: { bundle?: SceneIrBundleV1; snapshotHash?: string };
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

test("falls back the whole Scene for real producer unsupported and exit results", async ({ page }) => {
  await expectRunStatus(await openRealWorkspace(page), "verified");

  const unsupported = await expectRunStatus(await selectScene(page, "UnsupportedPreviewScene"), "unsupported");
  expect(unsupported.failure).toBeUndefined();
  await expectWholeSceneFallback(page, "unsupported");
  await expect(page.getByRole("button", { name: "Move circle", exact: true })).toBeVisible();

  const failed = await expectRunStatus(await selectScene(page, "FailedPreviewScene"), "failed");
  expect(failed.failure?.code).toBe("producer-exit");
  await expectWholeSceneFallback(page, "failed");
  await expect(page.getByRole("button", { name: "Move circle", exact: true })).toBeVisible();
});
