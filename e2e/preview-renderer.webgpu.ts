import { readFile } from "node:fs/promises";

import { type Download, expect, type Page, test } from "@playwright/test";

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

async function expectMathTexCanvasInk(page: Page, revision: string, sampleTime: number, label: string) {
  const canvasRoot = page.locator("[data-studio-canvas]");
  const mathTexEntity = page.getByRole("button", { name: `Move ${label}`, exact: true });
  await expect(mathTexEntity).toBeVisible();
  const [canvasBox, mathTexBox, packetId] = await Promise.all([
    canvasRoot.boundingBox(),
    mathTexEntity.boundingBox(),
    canvasRoot.getAttribute("data-preview-packet-id"),
  ]);
  if (!canvasBox || !mathTexBox || !packetId) {
    throw new Error("The presented MathTex or its correlated canvas evidence is unavailable.");
  }

  const background = await captureHostEvidence(page, [{ fractionX: 0.03, fractionY: 0.05 }]);
  if (!background) throw new Error("The preview frame evidence channel is not exposed.");
  expect(background.packetId).toBe(packetId);
  expect(background.revision).toBe(revision);
  expect(background.sampleTime).toBe(sampleTime);
  expectPixelNear(background.samples[0], [0, 0, 0, 255]);

  const points = Array.from({ length: 12 }, (_, row) =>
    Array.from({ length: 24 }, (_, column) => ({
      fractionX: (mathTexBox.x + ((column + 0.5) / 24) * mathTexBox.width - canvasBox.x) / canvasBox.width,
      fractionY: (mathTexBox.y + ((row + 0.5) / 12) * mathTexBox.height - canvasBox.y) / canvasBox.height,
    })),
  ).flat();
  let foundInk = false;
  for (let offset = 0; offset < points.length; offset += 16) {
    const evidence = await captureHostEvidence(page, points.slice(offset, offset + 16));
    if (!evidence) throw new Error("The preview frame evidence channel disappeared while sampling MathTex.");
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
  await expectMathTexCanvasInk(page, firstRevision ?? "", 0.5, "E = mc^2");

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
  await expectMathTexCanvasInk(page, fractionRevision ?? "", 0.5, String.raw`\frac{1}{2}`);
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

test("downloads a playable 30 fps MP4 from the exact presented Rust Scene", { tag: "@ci-smoke" }, async ({ page }) => {
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
