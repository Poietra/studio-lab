import { expect, type Page, test } from "@playwright/test";

const FIXTURE_QUERY = "?previewRenderer=fixture";
// The fixture Scene IR's source revision hash — the revision the retained
// worker echoes on every frame and every piece of evidence.
const FIXTURE_ENGINE_REVISION = "a".repeat(64);

type RgbaPixel = readonly [number, number, number, number];

type HostFrameEvidence = Readonly<{
  kind: "frame-evidence";
  packetId: string;
  revision: string;
  sampleTime: number;
  samples: readonly RgbaPixel[];
  surfaceFormat: string;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
}>;

function expectPixelNear(actual: RgbaPixel, expected: RgbaPixel, tolerance = 4) {
  for (const [index, component] of actual.entries()) {
    expect(Math.abs(component - expected[index])).toBeLessThanOrEqual(tolerance);
  }
}

async function openHarnessWorkspace(page: Page) {
  await page.goto(`/${FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Preview Harness");
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  await page.getByRole("button", { name: "Enable preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run Manim Scenes for GPU preview?" })).toBeVisible();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
}

async function expectPresented(page: Page) {
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-renderer", "presented", {
    timeout: 30_000,
  });
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toContainText("editing preview only");
}

async function expectSemanticPaintDeferred(page: Page) {
  const paint = page.locator("[data-studio-semantic-paint]").first();
  await expect(paint).toHaveAttribute("data-studio-semantic-paint", "deferred-to-canvas");
  await expect.poll(async () => paint.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
}

async function expectSemanticPaintRestored(page: Page) {
  const paint = page.locator("[data-studio-semantic-paint]").first();
  await expect(paint).toHaveAttribute("data-studio-semantic-paint", "painted");
  await expect.poll(async () => paint.evaluate((element) => getComputedStyle(element).opacity)).not.toBe("0");
}

async function captureHostEvidence(
  page: Page,
  points: readonly Readonly<{ fractionX: number; fractionY: number }>[],
): Promise<HostFrameEvidence | null> {
  return (await page.evaluate(async (samples) => {
    const capture = (
      globalThis as Record<string, unknown> & {
        __poietraPreviewFrameEvidence?: (
          input: readonly Readonly<{ fractionX: number; fractionY: number }>[],
        ) => Promise<unknown>;
      }
    ).__poietraPreviewFrameEvidence;
    if (!capture) return null;
    return capture(samples);
  }, points)) as HostFrameEvidence | null;
}

test("presents exactly correlated retained WebGPU frames while the semantic editor stays live", async ({ page }) => {
  await openHarnessWorkspace(page);
  await expectPresented(page);
  await page.getByRole("slider", { name: "Scene playhead" }).fill("1");
  await expectPresented(page);
  await expectSemanticPaintDeferred(page);

  for (const name of ["earlier", "later", "stroke"]) {
    await expect(page.getByRole("checkbox", { name: `Select ${name}` })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Inspector" })).toBeVisible();

  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "1");
  await expect(canvasRoot).toHaveAttribute("data-preview-packet-id", /^canvas:\d+$/);
  const presentedPacketId = await canvasRoot.getAttribute("data-preview-packet-id");
  const presentedViewport = await canvasRoot.getAttribute("data-preview-viewport");
  const [widthPx, heightPx] = (presentedViewport ?? "").split("x").map(Number);
  expect(widthPx).toBeGreaterThan(0);
  expect(heightPx).toBeGreaterThan(0);

  const evidence = await captureHostEvidence(page, [
    { fractionX: 5 / 160, fractionY: 5 / 90 },
    { fractionX: 0.5 - 1 / 16, fractionY: 0.5 },
    { fractionX: 0.5 + 1 / 16, fractionY: 0.5 },
  ]);
  if (!evidence) throw new Error("The preview frame evidence channel is not exposed.");
  expect(evidence.kind).toBe("frame-evidence");
  expect(evidence.revision).toBe(FIXTURE_ENGINE_REVISION);
  expect(evidence.sampleTime).toBe(1);
  expect(evidence.viewport).toEqual({ heightPx, widthPx });
  expect(evidence.packetId).toBe(presentedPacketId);
  expect(evidence.surfaceFormat).toMatch(/^(bgra|rgba)8unorm$/);
  const [background, redCenter, blueCenter] = evidence.samples;
  expectPixelNear(background, [0, 0, 0, 255]);
  expectPixelNear(redCenter, [188, 0, 0, 255]);
  expectPixelNear(blueCenter, [0, 0, 255, 255]);

  const canvasBox = await canvasRoot.boundingBox();
  const earlier = page.getByRole("button", { name: "Move earlier", exact: true });
  const earlierBox = await earlier.boundingBox();
  if (!canvasBox || !earlierBox) throw new Error("The Studio canvas or the earlier circle is not visible.");
  const centerFraction = (earlierBox.x + earlierBox.width / 2 - canvasBox.x) / canvasBox.width;
  expect(Math.abs(centerFraction - 0.4375)).toBeLessThan(0.01);
  const stroke = page.getByRole("button", { name: "Move stroke", exact: true });
  const strokeBox = await stroke.boundingBox();
  if (!strokeBox) throw new Error("The stroke line is not visible in the Studio canvas.");
  const strokeCenterX = (strokeBox.x + strokeBox.width / 2 - canvasBox.x) / canvasBox.width;
  const strokeCenterY = (strokeBox.y + strokeBox.height / 2 - canvasBox.y) / canvasBox.height;
  expect(Math.abs(strokeCenterX - (0.5 - 3 / 16))).toBeLessThan(0.01);
  expect(Math.abs(strokeCenterY - (0.5 - 2 / 9))).toBeLessThan(0.01);
  await stroke.click();
  await expect(stroke).toHaveAttribute("aria-pressed", "true");
  await expectPresented(page);

  await earlier.click();
  await expect(earlier).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-studio-resize-handle]").first()).toBeVisible();
  await expect(page.getByRole("slider", { name: "Timeline playhead" })).toBeVisible();
  await expectPresented(page);
  await expectSemanticPaintDeferred(page);

  await earlier.press("ArrowRight");
  await expect(canvasRoot).toHaveAttribute("data-preview-fallback-reason", "snapshot-uncorrelated");
  await expectSemanticPaintRestored(page);
  await page.getByRole("button", { name: "Discard" }).click();
  await expectPresented(page);
});

test("reinstalls a fresh worker and canvas across workspace close and reopen", async ({ page }) => {
  await openHarnessWorkspace(page);
  await expectPresented(page);

  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await expect(page.locator("[data-studio-preview-canvas]")).toHaveCount(0);

  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Preview Harness");
  await expectPresented(page);

  const canvasRoot = page.locator("[data-studio-canvas]");
  const viewportAttribute = await canvasRoot.getAttribute("data-preview-viewport");
  const sampleTimeAttribute = await canvasRoot.getAttribute("data-preview-sample-time");
  const packetIdAttribute = await canvasRoot.getAttribute("data-preview-packet-id");
  const evidence = await captureHostEvidence(page, [{ fractionX: 5 / 160, fractionY: 5 / 90 }]);
  if (!evidence) throw new Error("The preview frame evidence channel is not exposed.");
  expect(evidence.kind).toBe("frame-evidence");
  expect(evidence.revision).toBe(FIXTURE_ENGINE_REVISION);
  expect(`${evidence.viewport.widthPx}x${evidence.viewport.heightPx}`).toBe(viewportAttribute);
  expect(String(evidence.sampleTime)).toBe(sampleTimeAttribute);
  expect(evidence.packetId).toBe(packetIdAttribute);
});

test("a workspace switch away from the harness and back never carries preview authority across", async ({ page }) => {
  await openHarnessWorkspace(page);
  await expectPresented(page);
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-packet-id", /^canvas:\d+$/);
  const harnessEvidence = (await captureHostEvidence(page, [{ fractionX: 5 / 160, fractionY: 5 / 90 }])) ?? null;
  if (!harnessEvidence) throw new Error("The harness workspace did not expose frame evidence.");
  expect(harnessEvidence.packetId).toBe(await canvasRoot.getAttribute("data-preview-packet-id"));

  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Studio Lab workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Studio Lab");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(canvasRoot).toHaveAttribute(
    "data-preview-fallback-reason",
    /snapshot-unavailable|capability-unsupported/,
  );
  await expect(canvasRoot).not.toHaveAttribute("data-preview-packet-id", /.+/);
  await expect(page.locator("[data-studio-semantic-paint='deferred-to-canvas']")).toHaveCount(0);
  expect(await captureHostEvidence(page, [{ fractionX: 0.5, fractionY: 0.5 }])).toBeNull();

  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Preview Harness");
  await expectPresented(page);
  await expect(canvasRoot).toHaveAttribute("data-preview-packet-id", /^canvas:\d+$/);
  const returnedPacketId = await canvasRoot.getAttribute("data-preview-packet-id");
  const returnedEvidence = (await captureHostEvidence(page, [{ fractionX: 5 / 160, fractionY: 5 / 90 }])) ?? null;
  if (!returnedEvidence) throw new Error("The reopened harness workspace did not expose frame evidence.");
  expect(returnedEvidence.kind).toBe("frame-evidence");
  expect(returnedEvidence.revision).toBe(FIXTURE_ENGINE_REVISION);
  expect(returnedEvidence.packetId).toBe(returnedPacketId);
  expectPixelNear(returnedEvidence.samples[0], [0, 0, 0, 255]);
});

test("keeps presenting only matching frames across rapid scrubs", async ({ page }) => {
  await openHarnessWorkspace(page);
  await expectPresented(page);

  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await playhead.fill("1.5");
  await playhead.fill("0.5");
  await playhead.fill("1");
  await expectPresented(page);
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-sample-time", "1");
});

test("falls back to the whole Scene during a transient drag and after the resulting draft", async ({ page }) => {
  await openHarnessWorkspace(page);
  await expectPresented(page);
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await playhead.fill("1");
  await expect(playhead).toHaveValue("1");
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-sample-time", "1", {
    timeout: 30_000,
  });
  await expectPresented(page);

  const earlier = page.getByRole("button", { name: "Move earlier", exact: true });
  await earlier.click();
  await expect(earlier).toHaveAttribute("aria-pressed", "true");
  await expectPresented(page);
  const box = await earlier.boundingBox();
  if (!box) throw new Error("The earlier circle is not visible in the Studio canvas.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 4 });
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-fallback-reason", "transient-edit");
  await expectSemanticPaintRestored(page);
  await page.mouse.up();
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute(
    "data-preview-fallback-reason",
    "snapshot-uncorrelated",
  );
  await page.getByRole("button", { name: "Discard" }).click();
  await expectPresented(page);
});
