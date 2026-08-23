import { readFile } from "node:fs/promises";

import { type Download, expect, type Locator, type Page, test } from "@playwright/test";

import { verifyExportMp4V1 } from "../src/engine/export-mp4-verification";

const FIXTURE_QUERY = "?previewRenderer=fixture";
const EXPORT_FIXTURE_QUERY = "?previewRenderer=export-fixture";
const MATHTEX_FIXTURE_QUERY = "?previewRenderer=mathtex-fixture";
// The fixture Scene IR's source revision hash — the revision the retained
// worker echoes on every frame and every piece of evidence.
const FIXTURE_ENGINE_REVISION = "a".repeat(64);
const MATHTEX_FIXTURE_ENGINE_REVISION = "e".repeat(64);

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
  const scene = page.getByLabel("Active imported Scene");
  await scene.selectOption({ label: "shared_circle_opacity.py · SharedCircleOpacity" });
  await expect(scene.locator("option:checked")).toHaveText("shared_circle_opacity.py · SharedCircleOpacity");
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
}

async function expectPresented(page: Page) {
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-renderer", "presented", {
    timeout: 30_000,
  });
  await expect(page.locator("[data-studio-preview-canvas]")).toBeVisible();
  await expect(page.locator("[data-studio-preview-status]")).toBeVisible();
}

async function openExportSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Export settings" });
  if (!(await dialog.isVisible())) {
    await page.getByRole("button", { name: "Export settings" }).click();
  }
  return dialog;
}

async function expectPaintFreeInteractionOverlay(page: Page) {
  await expect(page.locator("[data-studio-semantic-paint]")).toHaveCount(0);
}

function topLevelMp4Atoms(bytes: Uint8Array) {
  const atoms: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) throw new Error("MP4 ends inside a top-level atom header.");
    const size = view.getUint32(offset);
    const kind = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > bytes.byteLength) {
      throw new Error(`MP4 atom ${kind} has invalid size ${size}.`);
    }
    atoms.push(kind);
    offset += size;
  }
  return atoms;
}

function monoPcmWav48k(durationSeconds: number) {
  const sampleCount = Math.round(48_000 * durationSeconds);
  const bytes = Buffer.alloc(44 + sampleCount * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48_000, 24);
  bytes.writeUInt32LE(96_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(sampleCount * 2, 40);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    bytes.writeInt16LE(Math.round(Math.sin((sample * Math.PI * 2 * 440) / 48_000) * 8_000), 44 + sample * 2);
  }
  return bytes;
}

async function retainedFrameIdentity(page: Page) {
  const canvasRoot = page.locator("[data-studio-canvas]");
  const [packet, revision] = await Promise.all([
    canvasRoot.getAttribute("data-preview-packet-id"),
    canvasRoot.getAttribute("data-preview-revision"),
  ]);
  if (!packet || !revision) throw new Error("The retained WebGPU frame has no exact identity.");
  return { packet, revision };
}

async function waitForNewPresentedFrame(page: Page, previous: Readonly<{ packet: string; revision: string }>) {
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect
    .poll(
      async () => {
        const [phase, packet, revision] = await Promise.all([
          canvasRoot.getAttribute("data-preview-renderer"),
          canvasRoot.getAttribute("data-preview-packet-id"),
          canvasRoot.getAttribute("data-preview-revision"),
        ]);
        return phase === "presented" &&
          packet &&
          packet !== previous.packet &&
          revision &&
          revision !== previous.revision
          ? "presented"
          : JSON.stringify({ packet, phase, revision });
      },
      { timeout: 30_000 },
    )
    .toBe("presented");
  await expectPaintFreeInteractionOverlay(page);
  return retainedFrameIdentity(page);
}

async function waitForNewPresentedRevision(page: Page, previousRevision: string) {
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect
    .poll(
      async () => {
        const [phase, revision] = await Promise.all([
          canvasRoot.getAttribute("data-preview-renderer"),
          canvasRoot.getAttribute("data-preview-revision"),
        ]);
        return phase === "presented" && revision && revision !== previousRevision
          ? "presented"
          : JSON.stringify({ phase, revision });
      },
      { timeout: 30_000 },
    )
    .toBe("presented");
  await expectPaintFreeInteractionOverlay(page);
  return retainedFrameIdentity(page);
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

async function captureRectanglePaintEvidence(
  page: Page,
  rectangle: Locator,
  expectedRevision: string,
  expectedSampleTime: number,
) {
  const canvasRoot = page.locator("[data-studio-canvas]");
  const [canvasBox, rectangleBox, packetId] = await Promise.all([
    canvasRoot.boundingBox(),
    rectangle.boundingBox(),
    canvasRoot.getAttribute("data-preview-packet-id"),
  ]);
  if (!canvasBox || !rectangleBox || !packetId) {
    throw new Error("The presented Rectangle or its correlated canvas evidence is unavailable.");
  }

  const centerX = rectangleBox.x + rectangleBox.width / 2;
  const centerY = rectangleBox.y + rectangleBox.height / 2;
  const fraction = (x: number, y: number) => ({
    fractionX: (x - canvasBox.x) / canvasBox.width,
    fractionY: (y - canvasBox.y) / canvasBox.height,
  });
  const edgeOffsets = [-3, -2, -1, 0, 1, 2, 3];
  const evidence = await captureHostEvidence(page, [
    fraction(centerX, centerY),
    ...edgeOffsets.map((offset) => fraction(centerX, rectangleBox.y + offset)),
    ...edgeOffsets.map((offset) => fraction(rectangleBox.x + offset, centerY)),
  ]);
  if (!evidence) throw new Error("The preview frame evidence channel is not exposed.");
  expect(evidence.packetId).toBe(packetId);
  expect(evidence.revision).toBe(expectedRevision);
  expect(evidence.sampleTime).toBe(expectedSampleTime);
  return {
    center: evidence.samples[0],
    edges: evidence.samples.slice(1),
  };
}

function isRedDominant([red, green, blue]: RgbaPixel) {
  return red > 48 && red > green * 1.8 && red > blue * 1.8;
}

async function expectOutlinedEntityCanvasInk(
  page: Page,
  revision: string,
  sampleTime: number,
  label: string,
  kind: "MathTex" | "Text" = "MathTex",
) {
  const canvasRoot = page.locator("[data-studio-canvas]");
  const outlinedEntity = page.getByRole("button", { name: `Move ${label}`, exact: true });
  await expect(outlinedEntity).toBeVisible();
  const [canvasBox, outlinedBox, packetId] = await Promise.all([
    canvasRoot.boundingBox(),
    outlinedEntity.boundingBox(),
    canvasRoot.getAttribute("data-preview-packet-id"),
  ]);
  if (!canvasBox || !outlinedBox || !packetId) {
    throw new Error(`The presented ${kind} or its correlated canvas evidence is unavailable.`);
  }

  const background = await captureHostEvidence(page, [{ fractionX: 0.03, fractionY: 0.05 }]);
  if (!background) throw new Error("The preview frame evidence channel is not exposed.");
  expect(background.packetId).toBe(packetId);
  expect(background.revision).toBe(revision);
  expect(background.sampleTime).toBe(sampleTime);
  expectPixelNear(background.samples[0], [0, 0, 0, 255]);

  const points = Array.from({ length: 12 }, (_, row) =>
    Array.from({ length: 24 }, (_, column) => ({
      fractionX: (outlinedBox.x + ((column + 0.5) / 24) * outlinedBox.width - canvasBox.x) / canvasBox.width,
      fractionY: (outlinedBox.y + ((row + 0.5) / 12) * outlinedBox.height - canvasBox.y) / canvasBox.height,
    })),
  ).flat();
  let foundInk = false;
  for (let offset = 0; offset < points.length; offset += 16) {
    const evidence = await captureHostEvidence(page, points.slice(offset, offset + 16));
    if (!evidence) throw new Error(`The preview frame evidence channel disappeared while sampling ${kind}.`);
    expect(evidence.packetId).toBe(packetId);
    expect(evidence.revision).toBe(revision);
    expect(evidence.sampleTime).toBe(sampleTime);
    foundInk ||= evidence.samples.some(([red, green, blue]) => Math.max(red, green, blue) > 24);
    if (foundInk) break;
  }
  expect(foundInk).toBe(true);
}

test("presents Studio-created MathTex across undo and LaTeX commands", async ({ page }) => {
  await page.goto(`/${MATHTEX_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Preview Harness");
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  const scene = page.getByLabel("Active imported Scene");
  await scene.selectOption({ label: "studio_mathtex.py · StudioMathTexPreview" });
  await expect(scene.locator("option:checked")).toHaveText("studio_mathtex.py · StudioMathTexPreview");
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);

  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-revision", MATHTEX_FIXTURE_ENGINE_REVISION);
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await playhead.fill("0");
  await page.getByRole("button", { name: /Insert equation/ }).click();
  await page.getByRole("textbox", { name: "MathTex" }).fill("E = mc^2");
  const canvasBounds = await canvasRoot.boundingBox();
  if (!canvasBounds) throw new Error("The Studio canvas is unavailable for MathTex placement.");
  await canvasRoot.click({ position: { x: canvasBounds.width / 2, y: canvasBounds.height / 2 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  await playhead.fill("0.5");
  await expectPresented(page);
  await expectPaintFreeInteractionOverlay(page);
  const firstRevision = await canvasRoot.getAttribute("data-preview-revision");
  expect(firstRevision).toMatch(/^[0-9a-f]{64}$/);
  expect(firstRevision).not.toBe(MATHTEX_FIXTURE_ENGINE_REVISION);
  await expectOutlinedEntityCanvasInk(page, firstRevision ?? "", 0.5, "E = mc^2");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Move E = mc^2", exact: true })).toHaveCount(0);
  await playhead.fill("0");
  await expectPresented(page);
  await expect(canvasRoot).toHaveAttribute("data-preview-revision", MATHTEX_FIXTURE_ENGINE_REVISION);
  await page.getByRole("button", { name: /Insert equation/ }).click();
  await page.getByRole("textbox", { name: "MathTex" }).fill(String.raw`\frac{1}{2}`);
  await canvasRoot.click({ position: { x: canvasBounds.width / 2, y: canvasBounds.height / 2 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await playhead.fill("0.5");
  await expectPresented(page);
  await expectPaintFreeInteractionOverlay(page);
  const fractionRevision = await canvasRoot.getAttribute("data-preview-revision");
  expect(fractionRevision).toMatch(/^[0-9a-f]{64}$/);
  expect(fractionRevision).not.toBe(MATHTEX_FIXTURE_ENGINE_REVISION);
  await expectOutlinedEntityCanvasInk(page, fractionRevision ?? "", 0.5, String.raw`\frac{1}{2}`);
});

test("creates, scrubs, and exports plain Text through the canonical WebGPU preview", async ({ page }) => {
  const text = "Hello WASM";
  const textConstructor = `Text(${JSON.stringify(text)}, font="DejaVu Sans", disable_ligatures=True).scale_to_fit_height(1.5)`;
  const exportedSource = [
    "from manim import *",
    "",
    "class StudioMathTexPreview(Scene):",
    "    def construct(self):",
    `        label = ${textConstructor}`,
    "        label.move_to(ORIGIN)",
    "        self.play(FadeIn(label))",
    "",
  ].join("\n");
  let exportRequests = 0;
  await page.route("**/api/manim/projects/preview-harness/export", async (route) => {
    exportRequests += 1;
    await route.fulfill({
      body: exportedSource,
      headers: {
        "content-disposition": 'attachment; filename="studio_mathtex.poietra.py"',
        "content-type": "text/x-python; charset=utf-8",
        "x-poietra-project-id": "preview-harness",
      },
      status: 200,
    });
  });
  await page.goto(`/${MATHTEX_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await page.getByLabel("Active imported Scene").selectOption({
    label: "studio_mathtex.py · StudioMathTexPreview",
  });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();

  const canvasRoot = page.locator("[data-studio-canvas]");
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await playhead.fill("0");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0");
  const pristineFrame = await retainedFrameIdentity(page);
  await page.getByRole("button", { name: /Insert text/ }).click();
  await page.getByRole("textbox", { name: "Text content" }).fill(text);
  const canvasBounds = await canvasRoot.boundingBox();
  if (!canvasBounds) throw new Error("The Studio canvas is unavailable for Text placement.");
  await canvasRoot.click({ position: { x: canvasBounds.width / 2, y: canvasBounds.height / 2 } });
  const draftFrame = await waitForNewPresentedFrame(page, pristineFrame);
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const appliedFrame = await waitForNewPresentedRevision(page, draftFrame.revision);

  await playhead.fill("0");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0");
  const fadeStart = await captureHostEvidence(page, [{ fractionX: 0.5, fractionY: 0.5 }]);
  if (!fadeStart) throw new Error("The preview frame evidence channel is not exposed.");
  expect(fadeStart.revision).toBe(appliedFrame.revision);
  expect(fadeStart.sampleTime).toBe(0);
  expectPixelNear(fadeStart.samples[0], [0, 0, 0, 255]);

  await playhead.fill("0.2");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.2");
  await expectOutlinedEntityCanvasInk(page, appliedFrame.revision, 0.2, text, "Text");

  await playhead.fill("0.9");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.9");
  await expectOutlinedEntityCanvasInk(page, appliedFrame.revision, 0.9, text, "Text");

  const textTarget = page.getByRole("button", { name: `Move ${text}`, exact: true });
  const initialBounds = await textTarget.boundingBox();
  if (!initialBounds) throw new Error("The initial Text bounds are unavailable.");
  const fontSize = page.getByRole("spinbutton", { name: `Text font size of ${text}` });
  await fontSize.fill("1.5");
  await page.getByRole("button", { name: "Create draft" }).click();
  const sizedDraftFrame = await waitForNewPresentedRevision(page, appliedFrame.revision);
  await playhead.fill("0.9");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.9");
  const sizedBounds = await textTarget.boundingBox();
  if (!sizedBounds) throw new Error("The sized Text bounds are unavailable.");
  expect(sizedBounds.height).toBeGreaterThan(initialBounds.height * 1.4);
  await page.getByRole("button", { name: "Replace program" }).click();
  const sizedAppliedFrame = await waitForNewPresentedRevision(page, sizedDraftFrame.revision);
  await page.getByRole("button", { name: "Undo" }).click();
  const undoneFrame = await waitForNewPresentedRevision(page, sizedAppliedFrame.revision);
  await expect(fontSize).toHaveValue("1.00");
  await page.getByRole("button", { name: "Redo" }).click();
  await waitForNewPresentedRevision(page, undoneFrame.revision);
  await expect(fontSize).toHaveValue("1.50");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("Chromium did not retain the exported Text source.");
  const source = await readFile(path, "utf8");
  expect(source).toContain(textConstructor);
  expect(source).toContain(".move_to(");
  expect(source).toContain("FadeIn(");
  expect(exportRequests).toBe(3);
});

test("creates an Arrow through the canonical WebGPU preview", async ({ page }) => {
  await page.goto(`/${MATHTEX_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await page.getByLabel("Active imported Scene").selectOption({
    label: "studio_mathtex.py · StudioMathTexPreview",
  });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  await page.getByRole("slider", { name: "Scene playhead" }).fill("0");
  await expectPresented(page);

  const canvasRoot = page.locator("[data-studio-canvas]");
  const pristineFrame = await retainedFrameIdentity(page);
  const insertArrow = page.getByRole("button", { name: /Insert arrow/ });
  await insertArrow.click();
  await expect(insertArrow).toHaveAttribute("aria-pressed", "true");
  await canvasRoot.click({ position: { x: 400, y: 250 } });
  const draftFrame = await waitForNewPresentedFrame(page, pristineFrame);
  await page.getByRole("slider", { name: "Scene playhead" }).fill("0.2");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.2");

  const arrow = page.getByRole("button", { name: "Move Arrow", exact: true });
  await expect(arrow).toHaveCount(1);
  const entityId = await arrow.getAttribute("data-studio-entity");
  expect(entityId).toBeTruthy();
  await expect(page.locator(`[data-studio-entity-wrapper="${entityId}"]`)).toHaveAttribute(
    "data-studio-runtime-entity",
    entityId ?? "",
  );

  await expect(page.getByRole("button", { name: "Apply program" })).toBeEnabled();
  expect(draftFrame.revision).not.toBe(pristineFrame.revision);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expectPresented(page);
  await expect(arrow).toHaveCount(0);
  await expect(canvasRoot).toHaveAttribute("data-preview-revision", pristineFrame.revision);
});

test("applies created Rectangle opacity and rotation through the canonical WebGPU preview", async ({ page }) => {
  let localExportPreflights = 0;
  await page.route("**/api/manim/projects/preview-harness/export", async (route) => {
    localExportPreflights += 1;
    await route.fulfill({
      body: "from manim import *\n",
      headers: {
        "content-disposition": 'attachment; filename="studio_mathtex.poietra.py"',
        "content-type": "text/x-python; charset=utf-8",
        "x-poietra-project-id": "preview-harness",
      },
      status: 200,
    });
  });
  await page.goto(`/${MATHTEX_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await page.getByLabel("Active imported Scene").selectOption({
    label: "studio_mathtex.py · StudioMathTexPreview",
  });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();

  const canvasRoot = page.locator("[data-studio-canvas]");
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await playhead.fill("0");
  const pristineFrame = await retainedFrameIdentity(page);
  await page.getByRole("button", { name: /Insert rectangle/ }).click();
  await canvasRoot.click({ position: { x: 400, y: 250 } });
  await waitForNewPresentedFrame(page, pristineFrame);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  await playhead.fill("0.4");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.4");
  const rectangle = page.getByRole("button", { name: "Move Rectangle", exact: true });
  await rectangle.click();
  await expect(rectangle).toHaveAttribute("aria-pressed", "true");
  const entityId = await rectangle.getAttribute("data-studio-entity");
  if (!entityId) throw new Error("The Studio-created Rectangle has no canonical entity identity.");
  const wrapper = page.locator(`[data-studio-entity-wrapper="${entityId}"]`);
  const initialWidth = Number(await wrapper.getAttribute("data-studio-entity-width"));
  const initialHeight = Number(await wrapper.getAttribute("data-studio-entity-height"));
  expect(initialWidth).toBeGreaterThan(0);
  expect(initialHeight).toBeGreaterThan(0);

  const opacity = page.getByLabel("Opacity Rectangle");
  await expect(opacity).toBeEnabled();
  await expect(opacity).toHaveValue("1");
  const beforeOpacity = await retainedFrameIdentity(page);
  await opacity.fill("0.25");
  await opacity.press("Enter");
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const opacityFrame = await waitForNewPresentedRevision(page, beforeOpacity.revision);
  expect(opacityFrame.revision).not.toBe(beforeOpacity.revision);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const opacityAppliedFrame = await waitForNewPresentedRevision(page, opacityFrame.revision);
  await expect(opacity).toHaveValue("0.25");

  const beforeRotation = opacityAppliedFrame;
  const rotate = page.getByRole("button", {
    name: "Rotate Rectangle counterclockwise by 15 degrees",
  });
  await expect(rotate).toBeEnabled();
  await rotate.click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const rotationFrame = await waitForNewPresentedRevision(page, beforeRotation.revision);
  expect(rotationFrame.revision).not.toBe(beforeRotation.revision);
  await expect
    .poll(async () => Number(await wrapper.getAttribute("data-studio-entity-width")))
    .toBeGreaterThan(initialWidth);
  await expect
    .poll(async () => Number(await wrapper.getAttribute("data-studio-entity-height")))
    .toBeGreaterThan(initialHeight);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const rotationAppliedFrame = await waitForNewPresentedRevision(page, rotationFrame.revision);
  await expect(opacity).toHaveValue("0.25");
  await playhead.fill("0.2");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.2");
  await expect
    .poll(async () => Number(await wrapper.getAttribute("data-studio-entity-width")))
    .toBeCloseTo(initialWidth);
  await expect
    .poll(async () => Number(await wrapper.getAttribute("data-studio-entity-height")))
    .toBeCloseTo(initialHeight);
  await playhead.fill("0.4");
  await expect
    .poll(async () => Number(await wrapper.getAttribute("data-studio-entity-width")))
    .toBeGreaterThan(initialWidth);
  await expect(canvasRoot).toHaveAttribute("data-preview-revision", rotationAppliedFrame.revision);
  expect(localExportPreflights).toBe(3);
});

test("applies created Rectangle fill and stroke colors through the canonical WebGPU preview", async ({ page }) => {
  let localExportPreflights = 0;
  await page.route("**/api/manim/projects/preview-harness/export", async (route) => {
    localExportPreflights += 1;
    await route.fulfill({
      body: "from manim import *\n",
      headers: {
        "content-disposition": 'attachment; filename="studio_mathtex.poietra.py"',
        "content-type": "text/x-python; charset=utf-8",
        "x-poietra-project-id": "preview-harness",
      },
      status: 200,
    });
  });
  await page.goto(`/${MATHTEX_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await page.getByLabel("Active imported Scene").selectOption({
    label: "studio_mathtex.py · StudioMathTexPreview",
  });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();

  const canvasRoot = page.locator("[data-studio-canvas]");
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await playhead.fill("0");
  const pristineFrame = await retainedFrameIdentity(page);
  await page.getByRole("button", { name: /Insert rectangle/ }).click();
  await canvasRoot.click({ position: { x: 400, y: 250 } });
  const creationDraftFrame = await waitForNewPresentedFrame(page, pristineFrame);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const creationAppliedFrame = await waitForNewPresentedRevision(page, creationDraftFrame.revision);

  await playhead.fill("0.4");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.4");
  const rectangle = page.getByRole("button", { name: "Move Rectangle", exact: true });
  await rectangle.click();
  await expect(rectangle).toHaveAttribute("aria-pressed", "true");
  const initialPaint = await captureRectanglePaintEvidence(page, rectangle, creationAppliedFrame.revision, 0.4);
  expectPixelNear(initialPaint.center, [0, 0, 0, 255]);
  expect(initialPaint.edges.some(isRedDominant)).toBe(false);

  const fillColor = page.getByLabel("Fill color Rectangle");
  await expect(fillColor).toBeEnabled();
  await fillColor.fill("#3b82f6");
  await fillColor.locator("xpath=..").getByRole("button", { name: "Set" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const fillDraftFrame = await waitForNewPresentedRevision(page, creationAppliedFrame.revision);
  const fillDraftPaint = await captureRectanglePaintEvidence(page, rectangle, fillDraftFrame.revision, 0.4);
  expectPixelNear(fillDraftPaint.center, [59, 130, 246, 255], 8);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const fillAppliedFrame = await waitForNewPresentedRevision(page, fillDraftFrame.revision);
  const fillAppliedPaint = await captureRectanglePaintEvidence(page, rectangle, fillAppliedFrame.revision, 0.4);
  expectPixelNear(fillAppliedPaint.center, [59, 130, 246, 255], 8);
  await expect(fillColor).toHaveValue("#3b82f6");

  const strokeColor = page.getByLabel("Stroke color Rectangle");
  await expect(strokeColor).toBeEnabled();
  await strokeColor.fill("#ef4444");
  await strokeColor.locator("xpath=..").getByRole("button", { name: "Set" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const strokeDraftFrame = await waitForNewPresentedRevision(page, fillAppliedFrame.revision);
  const strokeDraftPaint = await captureRectanglePaintEvidence(page, rectangle, strokeDraftFrame.revision, 0.4);
  expectPixelNear(strokeDraftPaint.center, [59, 130, 246, 255], 8);
  expect(strokeDraftPaint.edges.some(isRedDominant)).toBe(true);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const strokeAppliedFrame = await waitForNewPresentedRevision(page, strokeDraftFrame.revision);
  const strokeAppliedPaint = await captureRectanglePaintEvidence(page, rectangle, strokeAppliedFrame.revision, 0.4);
  expectPixelNear(strokeAppliedPaint.center, [59, 130, 246, 255], 8);
  expect(strokeAppliedPaint.edges.some(isRedDominant)).toBe(true);
  await expect(strokeColor).toHaveValue("#ef4444");

  await playhead.fill("0.2");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.2");
  const beforeEditPaint = await captureRectanglePaintEvidence(page, rectangle, strokeAppliedFrame.revision, 0.2);
  expectPixelNear(beforeEditPaint.center, [0, 0, 0, 255]);
  expect(beforeEditPaint.edges.some(isRedDominant)).toBe(false);

  await playhead.fill("0.4");
  await expect(canvasRoot).toHaveAttribute("data-preview-sample-time", "0.4");
  const afterEditPaint = await captureRectanglePaintEvidence(page, rectangle, strokeAppliedFrame.revision, 0.4);
  expectPixelNear(afterEditPaint.center, [59, 130, 246, 255], 8);
  expect(afterEditPaint.edges.some(isRedDominant)).toBe(true);
  expect(localExportPreflights).toBe(3);
});

test("presents exactly correlated WebGPU frames with a paint-free interaction overlay", async ({ page }) => {
  await openHarnessWorkspace(page);
  await expectPresented(page);
  await page.getByRole("slider", { name: "Scene playhead" }).fill("1");
  await expectPresented(page);
  await expectPaintFreeInteractionOverlay(page);

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
  // The source invokes shift dynamically through getattr, which the static
  // importer deliberately does not project. Only the verified identity map
  // can move this hit target onto the runtime pixels at world x=-1 (43.75%).
  expect(Math.abs(centerFraction - 0.4375)).toBeLessThan(0.01);
  const earlierStudioId = await earlier.getAttribute("data-studio-entity");
  expect(earlierStudioId).toBeTruthy();
  const earlierWrapper = page.locator(`[data-studio-entity-wrapper="${earlierStudioId}"]`);
  await expect(earlierWrapper).toHaveAttribute("data-studio-runtime-entity", "earlier");
  await expect(earlierWrapper).toHaveAttribute("data-studio-runtime-binding", `source-binding:${"b".repeat(64)}`);
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
  await expect(canvasRoot).toHaveAttribute("data-preview-interaction", "selection-only");
  await expect(page.locator("[data-studio-resize-handle]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Insert circle/ })).toBeDisabled();
  await expect(page.getByRole("slider", { name: "Timeline playhead" })).toBeVisible();
  await expectPresented(page);
  await expectPaintFreeInteractionOverlay(page);

  // This sealed snapshot predates generic Runtime Trace authoring. Its
  // imported entities are truthful selectors only; editable imported slices
  // are covered by the real Runtime Trace suites.
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
});

test("offers only the closed export settings and keeps a non-default selection", { tag: "@ci-smoke" }, async ({
  page,
}) => {
  await page.goto(`/${EXPORT_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();

  await expect(page.getByRole("button", { name: "Export MP4" })).toHaveCount(0);
  const exportSettings = await openExportSettings(page);
  await expect(exportSettings).toBeVisible();
  const resolution = exportSettings.getByRole("combobox", { name: "Resolution" });
  const frameRate = exportSettings.getByRole("combobox", { name: "Frame rate" });
  await expect(resolution.locator("option")).toHaveText(["480p", "720p", "1080p"]);
  await expect(frameRate.locator("option")).toHaveText(["30 fps", "60 fps"]);
  await resolution.selectOption("1280x720");
  await frameRate.selectOption("60");
  await expect(page.locator("[data-studio-export-profile]")).toHaveAttribute(
    "data-studio-export-profile",
    "1280x720@60",
  );
  await exportSettings.getByRole("button", { name: "Close" }).click();
  await expect(exportSettings).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Export MP4" })).toHaveCount(0);
});

test("downloads a playable 30 fps MP4 from the exact presented Rust Scene", {
  tag: "@ci-smoke",
}, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/${EXPORT_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await page
    .getByLabel("Active imported Scene")
    .selectOption({ label: "shared_circle_opacity.py · SharedCircleOpacity" });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);

  await openExportSettings(page);
  const exportButton = page.getByRole("button", { name: "Export MP4" });
  await expect(exportButton).toBeEnabled();
  const downloadPromise = new Promise<Download>((resolve) => page.once("download", resolve));
  await exportButton.click();
  const outcome = await Promise.race([
    downloadPromise.then((download) => ({ download, kind: "download" as const })),
    page
      .getByRole("alert")
      .last()
      .waitFor({ state: "visible", timeout: 110_000 })
      .then(async () => ({ detail: await page.getByRole("alert").last().innerText(), kind: "refused" as const })),
  ]);
  if (outcome.kind === "refused") {
    throw new Error(`Browser export refused:\n${outcome.detail}`);
  }
  const { download } = outcome;
  expect(download.suggestedFilename()).toBe("shared-circle-opacity.mp4");
  const path = await download.path();
  if (!path) throw new Error("Chromium did not retain the downloaded MP4.");
  const bytes = new Uint8Array(await readFile(path));
  expect(bytes.byteLength).toBeGreaterThan(256);
  const atoms = topLevelMp4Atoms(bytes);
  expect(atoms.slice(0, 3)).toEqual(["ftyp", "uuid", "mdat"]);
  expect(atoms.at(-1)).toBe("moov");
  expect(atoms.filter((atom) => atom === "mdat")).toHaveLength(6);

  const playback = await page.evaluate(async (base64) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("MP4 playback probe timed out.")), 15_000);
        video.addEventListener(
          "loadeddata",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        video.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(new Error(video.error?.message || "Chromium rejected the exported MP4."));
          },
          { once: true },
        );
        video.load();
      });
      return { duration: video.duration, height: video.videoHeight, width: video.videoWidth };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, Buffer.from(bytes).toString("base64"));
  expect(playback.width).toBe(854);
  expect(playback.height).toBe(480);
  expect(playback.duration).toBeCloseTo(0.2, 1);
});

test("exports an attached WAV as a verified Opus track", { tag: "@ci-smoke" }, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/${EXPORT_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await page
    .getByLabel("Active imported Scene")
    .selectOption({ label: "shared_circle_opacity.py · SharedCircleOpacity" });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);

  await openExportSettings(page);
  await page.getByLabel("WAV audio file").setInputFiles({
    buffer: monoPcmWav48k(0.2),
    mimeType: "audio/wav",
    name: "tone.wav",
  });
  await expect(page.getByText("tone.wav", { exact: true })).toBeVisible();

  const downloadPromise = new Promise<Download>((resolve) => page.once("download", resolve));
  await page.getByRole("button", { name: "Export MP4" }).click();
  const outcome = await Promise.race([
    downloadPromise.then((download) => ({ download, kind: "download" as const })),
    page
      .getByRole("alert")
      .last()
      .waitFor({ state: "visible", timeout: 110_000 })
      .then(async () => ({ detail: await page.getByRole("alert").last().innerText(), kind: "refused" as const })),
  ]);
  if (outcome.kind === "refused") throw new Error(`Browser audio export refused:\n${outcome.detail}`);

  const path = await outcome.download.path();
  if (!path) throw new Error("Chromium did not retain the downloaded audio MP4.");
  const bytes = new Uint8Array(await readFile(path));
  const verification = await verifyExportMp4V1(bytes);
  if (verification.kind !== "verified") {
    throw new Error(`The Rust verifier refused the audio MP4: ${verification.code}: ${verification.message}`);
  }
  expect(verification.structure.audio).toMatchObject({ channels: 1, sampleRate: 48_000 });
  expect(verification.structure.audio?.sampleCount).toBeGreaterThan(0);
  expect(verification.structure.audio?.encodedDurationSamples).toBeGreaterThanOrEqual(9_600);

  const decodedAudio = await page.evaluate(async (base64) => {
    const binary = atob(base64);
    const encoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(encoded.buffer);
      let peak = 0;
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        for (const sample of decoded.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
      }
      return { channels: decoded.numberOfChannels, duration: decoded.duration, peak };
    } finally {
      await context.close();
    }
  }, Buffer.from(bytes).toString("base64"));
  expect(decodedAudio.channels).toBe(1);
  expect(decodedAudio.duration).toBeCloseTo(0.2, 1);
  expect(decodedAudio.peak).toBeGreaterThan(0.01);
});

test("cancels a running MP4 export without delivering any file", { tag: "@ci-smoke" }, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/${EXPORT_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await page
    .getByLabel("Active imported Scene")
    .selectOption({ label: "shared_circle_opacity.py · SharedCircleOpacity" });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);

  await openExportSettings(page);
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  const exportControl = page.locator("[data-studio-export-mp4-state]");
  await expect(exportControl).toHaveAttribute("data-studio-export-mp4-state", "idle");
  await page.getByRole("button", { name: "Export MP4" }).click();
  // Cancel lands while the worker is still loading WASM / probing the GPU —
  // long before the 6-frame fixture export can finish.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(exportControl).toHaveAttribute("data-studio-export-mp4-state", "cancelled", { timeout: 110_000 });
  await expect(exportControl).toContainText("Export cancelled");
  // The fail-closed rule: a cancelled session delivers nothing, ever.
  expect(downloads).toHaveLength(0);
  // The affordance recovers: a fresh export can start again.
  await expect(page.getByRole("button", { name: "Export MP4" })).toBeEnabled();
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

test("a workspace switch requires fresh execution consent for each project", async ({ page }) => {
  await openHarnessWorkspace(page);
  await expectPresented(page);
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-packet-id", /^canvas:\d+$/);
  const harnessEvidence = (await captureHostEvidence(page, [{ fractionX: 5 / 160, fractionY: 5 / 90 }])) ?? null;
  if (!harnessEvidence) throw new Error("The harness workspace did not expose frame evidence.");
  expect(harnessEvidence.packetId).toBe(await canvasRoot.getAttribute("data-preview-packet-id"));
  await expect(page.locator('[data-studio-runtime-entity="later"]')).toHaveCount(1);
  await expect(page.locator('[data-studio-runtime-entity="stroke"]')).toHaveCount(1);
  await expect(page.locator("[data-studio-runtime-entity]")).toHaveCount(2);

  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Studio Lab workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Studio Lab");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "off");
  await expect(page.getByRole("button", { name: "Start preview…" })).toBeVisible();
  await expect(canvasRoot).not.toHaveAttribute("data-preview-packet-id", /.+/);
  await expectPaintFreeInteractionOverlay(page);
  await expect(page.locator("[data-studio-runtime-entity]")).toHaveCount(0);
  expect(await captureHostEvidence(page, [{ fractionX: 0.5, fractionY: 0.5 }])).toBeNull();

  await page.getByRole("button", { name: "Back to workspaces" }).click();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Preview Harness");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "off");
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);
  await expect(canvasRoot).toHaveAttribute("data-preview-packet-id", /^canvas:\d+$/);
  const returnedPacketId = await canvasRoot.getAttribute("data-preview-packet-id");
  const returnedEvidence = (await captureHostEvidence(page, [{ fractionX: 5 / 160, fractionY: 5 / 90 }])) ?? null;
  if (!returnedEvidence) throw new Error("The reopened harness workspace did not expose frame evidence.");
  expect(returnedEvidence.kind).toBe("frame-evidence");
  expect(returnedEvidence.revision).toBe(FIXTURE_ENGINE_REVISION);
  expect(returnedEvidence.packetId).toBe(returnedPacketId);
  expectPixelNear(returnedEvidence.samples[0], [0, 0, 0, 255]);
  await expect(page.locator('[data-studio-runtime-entity="later"]')).toHaveCount(1);
  await expect(page.locator('[data-studio-runtime-entity="stroke"]')).toHaveCount(1);
  await expect(page.locator("[data-studio-runtime-entity]")).toHaveCount(2);
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

test("retains the exact WebGPU frame during gestures and presents the compiled draft", async ({ page }) => {
  await page.goto(`/${MATHTEX_FIXTURE_QUERY}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Preview Harness workspace" }).click();
  const scene = page.getByLabel("Active imported Scene");
  await scene.selectOption({ label: "studio_mathtex.py · StudioMathTexPreview" });
  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expectPresented(page);
  await page.getByRole("button", { name: "Hide Magic Edit" }).click();
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  await playhead.fill("0");
  await expectPresented(page);

  const canvasRoot = page.locator("[data-studio-canvas]");
  const pristineFrame = await retainedFrameIdentity(page);
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvasRoot.click({ position: { x: 400, y: 250 } });
  await waitForNewPresentedFrame(page, pristineFrame);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await expectPresented(page);
  await page.getByRole("button", { name: "Set position" }).click();

  const circle = page.getByRole("button", { name: "Move Circle", exact: true });
  const studioEntityId = await circle.getAttribute("data-studio-entity");
  expect(studioEntityId).toBeTruthy();
  await circle.click();
  await expect(circle).toHaveAttribute("aria-pressed", "true");
  const wrapper = page.locator(`[data-studio-entity-wrapper="${studioEntityId}"]`);
  await expect(wrapper).toHaveAttribute("data-studio-runtime-entity", studioEntityId ?? "");
  await expectPresented(page);
  const dragBaseFrame = await retainedFrameIdentity(page);
  const box = await circle.boundingBox();
  if (!box) throw new Error("The Studio-created circle is not visible in the Studio canvas.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 4 });
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-renderer", "presented");
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-revision", dragBaseFrame.revision);
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-packet-id", dragBaseFrame.packet);
  await expectPaintFreeInteractionOverlay(page);
  await page.mouse.up();
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toBeChecked();
  const dragDraftFrame = await waitForNewPresentedFrame(page, dragBaseFrame);
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await expectPresented(page);
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-revision", dragBaseFrame.revision);

  const restoredCircle = page.locator(`[data-studio-entity="${studioEntityId}"]`);
  await expect(restoredCircle).toHaveAttribute("aria-pressed", "true");
  const resize = page.getByRole("button", { name: "Resize Circle from bottom-right corner" });
  await expect(resize).toHaveAttribute("data-studio-resize-handle", studioEntityId ?? "");
  const resizeBox = await resize.boundingBox();
  if (!resizeBox) throw new Error("The earlier Circle resize handle is not visible.");
  const resizeOrigin = { x: resizeBox.x + resizeBox.width / 2, y: resizeBox.y + resizeBox.height / 2 };
  const resizeBaseFrame = await retainedFrameIdentity(page);
  expect(resizeBaseFrame.revision).not.toBe(dragDraftFrame.revision);
  await page.mouse.move(resizeOrigin.x, resizeOrigin.y);
  await page.mouse.down();
  await page.mouse.move(resizeOrigin.x + 30, resizeOrigin.y + 20, { steps: 4 });
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-renderer", "presented");
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-revision", resizeBaseFrame.revision);
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-packet-id", resizeBaseFrame.packet);
  await expectPaintFreeInteractionOverlay(page);
  await page.mouse.up();
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toBeChecked();
  await waitForNewPresentedFrame(page, resizeBaseFrame);
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
});
