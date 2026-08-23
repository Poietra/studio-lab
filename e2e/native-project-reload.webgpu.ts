import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { encodeRgbaPngV1 } from "./png-rgba";
import { cleanupFixtureWorkspace } from "./workspace";

const PNG = encodeRgbaPngV1(
  Uint8Array.from([255, 64, 64, 255, 64, 255, 64, 255, 64, 64, 255, 255, 255, 255, 255, 255]),
  2,
  2,
);
const PNG_2 = encodeRgbaPngV1(
  Uint8Array.from([255, 255, 64, 255, 64, 255, 255, 255, 255, 64, 255, 255, 32, 32, 32, 255]),
  2,
  2,
);

async function dragBy(
  page: Page,
  locator: Locator,
  delta: Readonly<{ x: number; y: number }>,
  expectMotionPreview = false,
) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The object is not visible in the Studio canvas.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: 4 });
  if (expectMotionPreview) await expect(page.locator("[data-motion-preview]")).toHaveCount(1);
  await page.mouse.up();
}

async function placeOnCanvas(page: Page, fractionX: number, fractionY: number) {
  const canvas = page.locator("[data-studio-canvas]");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("The Studio canvas is not visible.");
  await canvas.dispatchEvent("pointerdown", {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX: bounds.x + bounds.width * fractionX,
    clientY: bounds.y + bounds.height * fractionY,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  });
}

async function scrubMotionClip(page: Page, clip: Locator, progress: number) {
  const slider = page.getByRole("slider", { name: "Scene playhead" });
  const duration = Number(await slider.getAttribute("max"));
  const operationId = await clip.getAttribute("data-applied-motion-clip");
  if (!operationId) throw new Error("The motion clip did not expose its operation id.");
  const placement = await page.locator(`[data-applied-motion-clip-wrapper="${operationId}"]`).evaluate((wrapper) => ({
    left: Number.parseFloat((wrapper as HTMLElement).style.left),
    width: Number.parseFloat((wrapper as HTMLElement).style.width),
  }));
  const time = Number(((duration * (placement.left + placement.width * progress)) / 100).toFixed(2));
  await slider.fill(String(time));
  await expect
    .poll(async () => Number(await page.locator("[data-studio-canvas]").getAttribute("data-preview-sample-time")))
    .toBeCloseTo(time, 1);
}

async function entranceClipTime(page: Page, clip: Locator, progress: number) {
  const slider = page.getByRole("slider", { name: "Scene playhead" });
  const sceneDuration = Number(await slider.getAttribute("max"));
  const placement = await clip.evaluate((element) => ({
    left: Number.parseFloat((element as HTMLElement).style.left),
    width: Number.parseFloat((element as HTMLElement).style.width),
  }));
  return Number(((sceneDuration * (placement.left + placement.width * progress)) / 100).toFixed(2));
}

async function scrubEntranceClip(page: Page, clip: Locator, progress: number) {
  const slider = page.getByRole("slider", { name: "Scene playhead" });
  const time = await entranceClipTime(page, clip, progress);
  await slider.fill(String(time));
  await expect
    .poll(async () => Number(await page.locator("[data-studio-canvas]").getAttribute("data-preview-sample-time")))
    .toBeCloseTo(time, 1);
}

async function preparedDimensions(wrapper: Locator) {
  return wrapper.evaluate((element) => ({
    height: Number((element as HTMLElement).dataset.studioEntityHeight),
    width: Number((element as HTMLElement).dataset.studioEntityWidth),
  }));
}

async function exportLocalMp4(page: Page) {
  await page.getByRole("button", { name: "Export settings" }).click();
  const exportControl = page.locator("[data-studio-export-mp4-state]");
  const exportButton = page.getByRole("button", { name: "Export MP4" });
  await expect(exportButton).toBeEnabled();
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 }).catch(() => null);
  await exportButton.click();
  await expect
    .poll(async () => exportControl.getAttribute("data-studio-export-mp4-state"), { timeout: 90_000 })
    .toMatch(/^(done|refused)$/u);
  if ((await exportControl.getAttribute("data-studio-export-mp4-state")) === "refused") {
    const reason = await exportControl.getAttribute("data-studio-export-mp4-reason");
    test.skip(reason === "unsupported-codec", "This Chromium build has no supported H.264 WebCodecs encoder.");
    throw new Error(`The native MP4 export was refused: ${reason ?? "unknown"}.`);
  }
  const download = await downloadPromise;
  expect(download).not.toBeNull();
  expect(download!.suggestedFilename()).toMatch(/\.mp4$/u);
  const path = await download!.path();
  if (!path) throw new Error("The native MP4 download was not persisted by Playwright.");
  const bytes = await readFile(path);
  expect(bytes.byteLength).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close" }).click();
  return bytes.toString("base64");
}

async function decodedBrightPixelCounts(page: Page, mp4Base64: string, sampleTimes: readonly number[]) {
  return page.evaluate(
    async ({ mp4Base64, sampleTimes }) => {
      const encoded = atob(mp4Base64);
      const bytes = Uint8Array.from(encoded, (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = url;
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("The exported Draw MP4 did not become decodable.")),
            15_000,
          );
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
              reject(new Error(video.error?.message || "Chromium rejected the exported Draw MP4."));
            },
            { once: true },
          );
          video.load();
        });
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
        if (!context) throw new Error("The decoded Draw frame canvas is unavailable.");
        const counts: number[] = [];
        for (const sampleTime of sampleTimes) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`MP4 seek to ${sampleTime}s timed out.`)), 15_000);
            video.addEventListener(
              "seeked",
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
            video.currentTime = sampleTime;
          });
          context.drawImage(video, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let bright = 0;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            if ((pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0) > 90) bright += 1;
          }
          counts.push(bright);
        }
        return counts;
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { mp4Base64, sampleTimes },
  );
}

async function createBlankWorkspace(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Add workspace" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add workspace" });
  await expect(addDialog.getByRole("radio", { name: /Blank Scene/ })).toBeChecked();
  await addDialog.getByRole("textbox", { name: "Workspace name" }).fill(name);
  const createResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects",
  );
  await addDialog.getByRole("button", { name: "Create workspace" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.request().postDataJSON()).toEqual({ kind: "studio-native", name });
  return ((await createResponse.json()) as { project: { id: string } }).project.id;
}

test("downloads a bounded Manim Scene from Studio-native authoring", async ({ page }) => {
  page.setDefaultTimeout(15_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Native source export fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert circle/ }).click();
    await canvas.click({ position: { x: 300, y: 260 } });
    await page.getByRole("button", { name: "Apply program" }).click();

    await page.getByRole("slider", { name: "Scene playhead" }).fill("1");
    await page.getByRole("button", { name: /Insert text/ }).click();
    await page.getByRole("textbox", { name: "Text content" }).fill("Poietra");
    await canvas.click({ position: { x: 520, y: 180 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.getByRole("button", { name: "Export settings" }).click();
    const sourceExport = page.locator("[data-studio-manim-source-export-state]");
    await expect(sourceExport).toHaveAttribute("data-studio-manim-source-export-state", "ready");
    const downloadPromise = page.waitForEvent("download");
    await sourceExport.getByRole("button", { name: "Download .py" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("PoietraScene.poietra.py");
    const path = await download.path();
    if (!path) throw new Error("The Studio-native Python download was not persisted by Playwright.");
    const source = await readFile(path, "utf8");
    expect(source).toContain("class PoietraScene(Scene):");
    expect(source).toContain("Circle(");
    expect(source).toContain('Text("Poietra"');
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("authors Text, shape, spinning motion, and Images in a blank workspace and restores MP4 export", async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Native reload fixture");

    await expect(page.getByLabel("Current workspace")).toHaveText("Native reload fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert rectangle/ }).click();
    await canvas.click({ position: { x: 500, y: 280 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const rectangle = page.getByRole("button", { name: "Move Rectangle", exact: true });
    await expect(rectangle).toBeVisible();

    await page.getByRole("button", { name: /Insert text/ }).click();
    await page.getByRole("textbox", { name: "Text content" }).fill("Poietra");
    await canvas.click({ position: { x: 280, y: 160 } });
    await expect(page.getByRole("button", { name: "Move Poietra", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("button", { name: "Move Poietra", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Create animation" }).click();
    await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("1");
    await dragBy(page, rectangle, { x: 90, y: -35 }, true);
    await expect(page.locator("[data-motion-path]")).toHaveCount(1);
    const revisionBeforeCurve = await canvas.getAttribute("data-preview-revision");
    await page.getByLabel("Curve X").fill("20");
    await expect.poll(async () => canvas.getAttribute("data-preview-revision")).not.toBe(revisionBeforeCurve);
    const revisionBeforeSpin = await canvas.getAttribute("data-preview-revision");
    await page.getByRole("button", { name: "Add 360° spin" }).click();
    await expect(page.getByRole("spinbutton", { name: "Motion spin degrees" })).toHaveValue("360");
    await expect.poll(async () => canvas.getAttribute("data-preview-revision")).not.toBe(revisionBeforeSpin);
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-revision", /^[0-9a-f]{64}$/u);

    const spinClip = page.getByRole("button", { name: "Edit Rectangle motion clip" });
    const spinningRectangleId = await rectangle.getAttribute("data-studio-entity");
    if (!spinningRectangleId) throw new Error("The spinning Rectangle did not expose its Studio entity id.");
    const spinningRectangleWrapper = page.locator(`[data-studio-entity-wrapper="${spinningRectangleId}"]`);
    await scrubMotionClip(page, spinClip, 0);
    const startDimensions = await preparedDimensions(spinningRectangleWrapper);
    expect(startDimensions.width).toBeGreaterThan(startDimensions.height);
    await scrubMotionClip(page, spinClip, 0.4);
    const turningDimensions = await preparedDimensions(spinningRectangleWrapper);
    expect(turningDimensions.height).toBeGreaterThan(turningDimensions.width);
    await scrubMotionClip(page, spinClip, 1);
    const endDimensions = await preparedDimensions(spinningRectangleWrapper);
    expect(endDimensions.width).toBeGreaterThan(endDimensions.height);
    await page.getByRole("slider", { name: "Scene playhead" }).fill("0");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(0, 1);

    const assets = page.getByRole("region", { name: "Assets" });
    await expect(assets.getByRole("button", { name: "+ Import PNG" })).toBeEnabled();
    await assets.locator('input[accept="image/png,.png"]').setInputFiles([
      { buffer: Buffer.from(PNG), mimeType: "image/png", name: "first.png" },
      { buffer: Buffer.from(PNG_2), mimeType: "image/png", name: "second.png" },
    ]);
    const projectImages = page.getByRole("list", { name: "Project images" });
    await expect(projectImages.getByRole("listitem")).toHaveCount(2);
    await projectImages.getByRole("button", { name: "+ Add" }).nth(0).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("checkbox", { name: "Select insert-0" })).toBeVisible();
    await expect(page.getByText(/1[.] 1 intents · studio-insert-/u)).toBeVisible();
    await projectImages.getByRole("button", { name: "+ Add" }).nth(1).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("checkbox", { name: "Select insert-0" })).toHaveCount(2);

    const localStorageText = await page.evaluate(() =>
      Object.keys(localStorage)
        .map((key) => localStorage.getItem(key) ?? "")
        .join("\n"),
    );
    expect(localStorageText).not.toContain(Buffer.from(PNG).toString("base64"));

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Native reload fixture workspace" }).click();
    await expect(page.getByLabel("Current workspace")).toHaveText("Native reload fixture");
    await expect(page.getByRole("list", { name: "Project images" }).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("checkbox", { name: "Select insert-0" })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Move insert-0" })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Move Poietra", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move Rectangle", exact: true })).toBeVisible();
    const restoredSpinningRectangle = page.getByRole("button", { name: "Move Rectangle", exact: true });
    const restoredSpinClip = page.getByRole("button", { name: "Edit Rectangle motion clip" });
    const restoredSpinningRectangleId = await restoredSpinningRectangle.getAttribute("data-studio-entity");
    if (!restoredSpinningRectangleId) throw new Error("The restored Rectangle did not expose its Studio entity id.");
    const restoredSpinningRectangleWrapper = page.locator(
      `[data-studio-entity-wrapper="${restoredSpinningRectangleId}"]`,
    );
    await scrubMotionClip(page, restoredSpinClip, 0.4);
    const restoredTurningDimensions = await preparedDimensions(restoredSpinningRectangleWrapper);
    expect(restoredTurningDimensions.height).toBeGreaterThan(restoredTurningDimensions.width);
    await expect(page.getByText(/1[.] 1 intents · studio-insert-/u)).toBeVisible();

    await exportLocalMp4(page);

    const deletedProjectId = projectId;
    await page.getByRole("button", { name: "Back to workspaces" }).click();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Delete Native reload fixture workspace" }).click();
    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname === `/api/projects/${deletedProjectId}`,
    );
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete workspace" }).click();
    await deleteResponse;
    await expect(page.getByRole("button", { name: "Open Native reload fixture workspace" })).toHaveCount(0);
    const retainedLocalDocuments = await page.evaluate(
      ({ databaseName, projectId }) =>
        new Promise<number>((resolve, reject) => {
          const open = indexedDB.open(databaseName, 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const database = open.result;
            const request = database
              .transaction("documents")
              .objectStore("documents")
              .index("projectId")
              .count(projectId);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              database.close();
              resolve(request.result);
            };
          };
        }),
      { databaseName: "poietra-studio-native-projects", projectId: deletedProjectId },
    );
    expect(retainedLocalDocuments).toBe(0);
    expect(
      await page.evaluate(
        (deletedId) => Object.keys(localStorage).some((key) => (localStorage.getItem(key) ?? "").includes(deletedId)),
        deletedProjectId,
      ),
    ).toBe(false);
    projectId = null;
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("imports one canonical SVG path and preserves editing, WGSL material, reload, and MP4 export", async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "SVG path fixture");
    const canvas = page.locator("[data-studio-canvas]");
    const assets = page.getByRole("region", { name: "Assets" });
    const svgInput = assets.locator('input[accept="image/svg+xml,.svg"]');
    await expect(assets.getByRole("button", { name: "+ Import SVG" })).toBeEnabled();

    await svgInput.setInputFiles({
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><path d="M10 70 L60 10 Q90 5 110 30 C100 60 80 75 10 70 Z M45 45 L60 25 L75 45 Z" fill="#38bdf8" fill-rule="evenodd" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/></svg>',
      ),
      mimeType: "image/svg+xml",
      name: "diagram.svg",
    });
    const vectors = page.getByRole("list", { name: "Project vectors" });
    await expect(vectors.getByRole("listitem")).toHaveCount(1);
    await expect(vectors).toContainText("diagram.svg");
    await vectors.getByRole("button", { name: "+ Add" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const vector = page.getByRole("button", { name: "Move insert-0", exact: true });
    await expect(vector).toBeVisible();
    const vectorId = await vector.getAttribute("data-studio-entity");
    if (!vectorId) throw new Error("The SVG path did not expose its Studio entity id.");
    const wrapper = page.locator(`[data-studio-entity-wrapper="${vectorId}"]`);
    const initialDimensions = await preparedDimensions(wrapper);
    expect(initialDimensions.width).toBeGreaterThan(2);
    expect(initialDimensions.height).toBeGreaterThan(1);

    await page.getByRole("button", { name: "Set position" }).click();
    await dragBy(page, vector, { x: 40, y: -20 });
    await page.getByRole("button", { name: "Apply program" }).click();
    const scaleBefore = Number(await wrapper.getAttribute("data-studio-entity-scale"));
    await dragBy(page, page.getByRole("button", { name: "Resize insert-0 from bottom-right corner" }), {
      x: 28,
      y: 20,
    });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect
      .poll(async () => Number(await wrapper.getAttribute("data-studio-entity-scale")))
      .toBeGreaterThan(scaleBefore);
    await page.getByRole("button", { name: "Rotate insert-0 counterclockwise by 15 degrees" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();

    const opacity = page.getByRole("spinbutton", { name: "Opacity insert-0" });
    await opacity.fill("0.65");
    await opacity.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(opacity).toHaveValue("0.65");

    const wavePreset = page.getByText("Wave preset").locator("xpath=../..");
    await wavePreset.getByRole("button", { name: "Create & apply" }).click();
    await expect(page.getByRole("combobox", { name: "Assigned fragment material" })).not.toHaveValue("");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await svgInput.setInputFiles({
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><path d="M10 50 Q50 0 90 50" fill="none" stroke="#f59e0b" stroke-width="5" stroke-linecap="round"/></svg>',
      ),
      mimeType: "image/svg+xml",
      name: "stroke.svg",
    });
    await expect(vectors.getByRole("listitem")).toHaveCount(2);
    await vectors
      .getByRole("listitem")
      .filter({ hasText: "stroke.svg" })
      .getByRole("button", { name: "+ Add" })
      .click();
    await page.getByRole("button", { name: "Apply program" }).click();
    const draw = page.getByRole("button", { name: /^Add Draw entrance for / });
    await expect(draw).toHaveAttribute("aria-disabled", "false");
    await draw.click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.locator("[data-draw-in-clip]")).toHaveCount(1);

    await page
      .locator(`[data-timeline-track="${vectorId}"]`)
      .getByRole("button", { name: "insert-0", exact: true })
      .click();
    await expect(page.getByRole("combobox", { name: "Assigned fragment material" })).not.toHaveValue("");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open SVG path fixture workspace" }).click();
    await expect(page.getByRole("list", { name: "Project vectors" })).toContainText("diagram.svg");
    await expect(page.locator(`[data-studio-entity="${vectorId}"]`)).toBeVisible();
    await page
      .locator(`[data-timeline-track="${vectorId}"]`)
      .getByRole("button", { name: "insert-0", exact: true })
      .click();
    await expect(page.getByRole("combobox", { name: "Assigned fragment material" })).not.toHaveValue("");
    await exportLocalMp4(page);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("draws a Studio Line through scrub, retime, history, reload, and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Draw entrance fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert line/ }).click();
    await canvas.click({ position: { x: 360, y: 220 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const line = page.getByRole("button", { name: "Move Line", exact: true });
    await expect(line).toBeVisible();
    const lineId = await line.getAttribute("data-studio-entity");
    if (!lineId) throw new Error("The Studio Line did not expose its entity id.");
    const lineWrapper = page.locator(`[data-studio-entity-wrapper="${lineId}"]`);

    await page.getByRole("button", { name: "Add Draw entrance for Line" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.getByRole("button", { name: /Insert circle/ }).click();
    await canvas.click({ position: { x: 560, y: 300 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).click();
    const group = page.getByRole("button", { name: "Group", exact: true });
    await expect(group).toBeDisabled();
    await expect(group).toHaveAttribute("title", "Remove Draw from every selected object before grouping.");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("button", { name: "Move Circle", exact: true })).toHaveCount(0);

    let drawClip = page.getByRole("button", { name: "Edit Line Draw entrance" });
    await expect(drawClip).toBeVisible();
    await scrubEntranceClip(page, drawClip, 0);
    await expect(lineWrapper).toHaveCount(0);
    await scrubEntranceClip(page, drawClip, 0.5);
    await expect(lineWrapper).toHaveCount(1);
    const middleWidth = (await preparedDimensions(lineWrapper)).width;
    expect(middleWidth).toBeGreaterThan(0);
    await scrubEntranceClip(page, drawClip, 1);
    const endWidth = (await preparedDimensions(lineWrapper)).width;
    expect(endWidth).toBeGreaterThan(middleWidth * 1.5);

    const initialDrawTitle = await drawClip.getAttribute("title");
    if (!initialDrawTitle) throw new Error("The Draw clip did not expose its interval and easing.");
    await drawClip.click();
    const drawDuration = page.getByRole("spinbutton", { name: "Draw duration for Line" });
    const drawEasing = page.getByRole("combobox", { name: "Draw easing for Line" });
    await expect(drawDuration).toBeEnabled();
    await expect(drawDuration).toHaveAttribute("max", "5");
    let drawRevision = await canvas.getAttribute("data-preview-revision");
    await drawDuration.press("Control+A");
    await drawDuration.pressSequentially("1.5");
    await drawDuration.press("Enter");
    await expect.poll(() => canvas.getAttribute("data-preview-revision")).not.toBe(drawRevision);
    await expect(drawEasing).toBeEnabled();
    drawRevision = await canvas.getAttribute("data-preview-revision");
    await drawEasing.selectOption("linear");
    await expect.poll(() => canvas.getAttribute("data-preview-revision")).not.toBe(drawRevision);
    await expect(drawDuration).toBeEnabled();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    drawClip = page.getByRole("button", { name: "Edit Line Draw entrance" });
    await drawClip.click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(page.getByRole("spinbutton", { name: "Draw duration for Line" })).toHaveValue("1.5");
    await expect(page.getByRole("combobox", { name: "Draw easing for Line" })).toHaveValue("linear");
    await page.getByRole("button", { name: "Discard" }).click();

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(drawClip).toHaveAttribute("title", initialDrawTitle);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(drawClip).toHaveAttribute("title", "Draw 0.00–1.50s · linear");
    await drawClip.click();
    await expect(page.getByRole("spinbutton", { name: "Draw duration for Line" })).toHaveValue("1.5");
    await expect(page.getByRole("combobox", { name: "Draw easing for Line" })).toHaveValue("linear");
    await page.getByRole("button", { name: "Discard" }).click();

    await drawClip.click();
    await page.getByRole("button", { name: "Remove Draw" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(drawClip).toHaveCount(0);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(drawClip).toHaveCount(1);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(drawClip).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(drawClip).toHaveCount(1);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Draw entrance fixture workspace" }).click();
    drawClip = page.getByRole("button", { name: "Edit Line Draw entrance" });
    await expect(drawClip).toBeVisible();
    await drawClip.click();
    await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-renderer", "presented");
    await expect(page.getByRole("spinbutton", { name: "Draw duration for Line" })).toHaveValue("1.5");
    await expect(page.getByRole("combobox", { name: "Draw easing for Line" })).toHaveValue("linear");
    await page.getByRole("button", { name: "Discard" }).click();

    const mp4 = await exportLocalMp4(page);
    const exportedStrokePixels = await decodedBrightPixelCounts(page, mp4, [0.02, 0.75, 1.6]);
    expect(exportedStrokePixels[1] ?? 0).toBeGreaterThan((exportedStrokePixels[0] ?? 0) + 20);
    expect(exportedStrokePixels[2] ?? 0).toBeGreaterThan((exportedStrokePixels[1] ?? 0) * 1.25);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("writes a Studio MathTex through scrub, history, reload, and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "MathTex Write fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert equation/ }).click();
    await page.getByRole("textbox", { name: "MathTex" }).fill("E = mc^2");
    await canvas.click({ position: { x: 400, y: 220 } });
    await expect(page.getByRole("button", { name: "Move E = mc^2", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Apply program" }).click();
    const equation = page.getByRole("button", { name: "Move E = mc^2", exact: true });
    await expect(equation).toBeVisible();
    const equationId = await equation.getAttribute("data-studio-entity");
    if (!equationId) throw new Error("The Studio MathTex did not expose its entity id.");
    const equationWrapper = page.locator(`[data-studio-entity-wrapper="${equationId}"]`);
    await expect(page.getByRole("checkbox", { name: "Select E = mc^2" })).toHaveCount(1);

    await page.getByRole("button", { name: "Add Write entrance for E = mc^2" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    let writeClip = page.getByRole("button", { name: "Edit E = mc^2 Write entrance" });
    await scrubEntranceClip(page, writeClip, 0);
    await expect(equationWrapper).toHaveCount(0);
    await scrubEntranceClip(page, writeClip, 0.5);
    await expect(equationWrapper).toHaveCount(1);
    const middleWidth = (await preparedDimensions(equationWrapper)).width;
    expect(middleWidth).toBeGreaterThan(0);
    await scrubEntranceClip(page, writeClip, 1);
    const endWidth = (await preparedDimensions(equationWrapper)).width;
    expect(endWidth).toBeGreaterThan(0);
    await expect(page.getByRole("checkbox", { name: "Select E = mc^2" })).toHaveCount(1);

    const initialWriteTitle = await writeClip.getAttribute("title");
    if (!initialWriteTitle) throw new Error("The Write clip did not expose its interval and easing.");
    await writeClip.click();
    const writeDuration = page.getByRole("spinbutton", { name: "Write duration for E = mc^2" });
    await expect(writeDuration).toBeEnabled();
    await expect(page.locator('[data-write-in-easing="linear"]')).toContainText("Easing · Linear");
    const writeRevision = await canvas.getAttribute("data-preview-revision");
    await writeDuration.press("Control+A");
    await writeDuration.pressSequentially("1.5");
    await writeDuration.press("Enter");
    await expect.poll(() => canvas.getAttribute("data-preview-revision")).not.toBe(writeRevision);
    await expect(writeDuration).toHaveValue("1.5");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.50s · linear");

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(writeClip).toHaveAttribute("title", initialWriteTitle);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.50s · linear");

    await writeClip.click();
    await page.getByRole("button", { name: "Remove Write" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(writeClip).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.50s · linear");

    const mp4 = await exportLocalMp4(page);
    const exportedInkPixels = await decodedBrightPixelCounts(page, mp4, [0.02, 0.75, 1.6]);
    expect(exportedInkPixels[1] ?? 0).toBeGreaterThan((exportedInkPixels[0] ?? 0) + 20);
    expect(exportedInkPixels[2] ?? 0).toBeGreaterThan(exportedInkPixels[1] ?? 0);

    await scrubEntranceClip(page, writeClip, 1);
    const xPosition = page.getByRole("spinbutton", { name: "X position of E = mc^2" });
    await xPosition.fill("430");
    await page.getByRole("button", { name: "Create draft" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(xPosition).toHaveValue("430.0");

    await page.getByRole("button", { name: "Set position" }).click();
    const beforeResizeScale = Number(await equationWrapper.getAttribute("data-studio-entity-scale"));
    const resizeHandle = page.getByRole("button", { name: "Resize E = mc^2 from bottom-right corner" });
    await dragBy(page, resizeHandle, { x: 28, y: 20 });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect
      .poll(async () => Number(await equationWrapper.getAttribute("data-studio-entity-scale")))
      .toBeGreaterThan(beforeResizeScale);

    await page.getByRole("button", { name: "Rotate E = mc^2 counterclockwise by 15 degrees" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const content = page.getByRole("textbox", { name: "MathTex content of E = mc^2" });
    await content.fill("F = ma");
    await content.press("Control+Enter");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("poietra.studio.editor-sessions")?.includes("F = ma")))
      .toBe(true);
    await expect(page.getByRole("checkbox", { name: "Select F = ma" })).toHaveCount(1);
    writeClip = page.getByRole("button", { name: "Edit F = ma Write entrance" });
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.50s · linear");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open MathTex Write fixture workspace" }).click();
    writeClip = page.getByRole("button", { name: "Edit F = ma Write entrance" });
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.50s · linear");
    await expect(page.getByRole("checkbox", { name: "Select F = ma" })).toHaveCount(1);
    await expect(page.locator('[aria-label*="fragment-"]')).toHaveCount(0);

    await page.getByRole("button", { name: /Insert circle/ }).click();
    await placeOnCanvas(page, 0.85, 0.8);
    await page.getByRole("button", { name: "Apply program" }).click();
    const mathSelection = page.getByRole("checkbox", { name: "Select F = ma" });
    const circleSelection = page.getByRole("checkbox", { name: "Select Circle" });
    if (!(await mathSelection.isChecked())) await mathSelection.check();
    if (!(await circleSelection.isChecked())) await circleSelection.check();
    await page.getByRole("button", { name: "Group", exact: true }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("button", { name: "Hide group of 2 objects" })).toBeEnabled();
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("morphs one Studio MathTex A-to-B-to-A through reload and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "MathTex Transform fixture");
    const canvas = page.locator("[data-studio-canvas]");
    const playhead = page.getByRole("slider", { name: "Scene playhead" });

    await page.getByRole("button", { name: /Insert equation/ }).click();
    await page.getByRole("textbox", { name: "MathTex" }).fill("E = mc^2");
    await canvas.click({ position: { x: 400, y: 220 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const root = page.getByRole("button", { name: "Move E = mc^2", exact: true });
    const rootId = await root.getAttribute("data-studio-entity");
    if (!rootId) throw new Error("The Studio MathTex did not expose its logical root id.");
    const rootWrapper = page.locator(`[data-studio-entity-wrapper="${rootId}"]`);
    await playhead.fill("1");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(1, 1);

    const target = page.getByRole("textbox", { name: /MathTex transform target of/ });
    const transformDuration = page.getByRole("spinbutton", { name: /MathTex transform duration of/ });
    await target.fill(String.raw`\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}`);
    await transformDuration.fill("1");
    await page.getByRole("button", { name: "Create Transform clip" }).click();
    await expect(page.getByRole("button", { name: "Apply program" })).toBeEnabled();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    let transformClips = page.locator("[data-mathtex-transform-clip]");
    await expect(transformClips).toHaveCount(1);
    let firstClip = transformClips.nth(0);
    await scrubEntranceClip(page, firstClip, 1);
    await expect(page.getByRole("checkbox", { name: /Select \\nabla/ })).toHaveCount(1);
    await expect(page.locator("[data-studio-entity-wrapper]")).toHaveCount(1);

    await page.getByRole("textbox", { name: /MathTex transform target of/ }).fill("E = mc^2");
    await page.getByRole("spinbutton", { name: /MathTex transform duration of/ }).fill("1");
    await page.getByRole("combobox", { name: /MathTex transform easing of/ }).selectOption("linear");
    await page.getByRole("button", { name: "Create Transform clip" }).click();
    await expect(page.getByRole("button", { name: "Apply program" })).toBeEnabled();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    transformClips = page.locator("[data-mathtex-transform-clip]");
    await expect(transformClips).toHaveCount(2);
    firstClip = transformClips.nth(0);
    let secondClip = transformClips.nth(1);
    await scrubEntranceClip(page, secondClip, 1);
    await expect(page.getByRole("checkbox", { name: "Select E = mc^2" })).toHaveCount(1);
    await expect(rootWrapper).toHaveAttribute("data-studio-entity-wrapper", rootId);

    await secondClip.click();
    const durationEditor = page.getByRole("spinbutton", { name: /Transform duration for/ });
    await durationEditor.fill("0.8");
    await durationEditor.press("Enter");
    await page.getByRole("combobox", { name: /Transform easing for/ }).selectOption("smooth");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    secondClip = page.locator("[data-mathtex-transform-clip]").nth(1);
    await expect(secondClip).toHaveAttribute("title", /–2[.]80s · smooth$/u);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("[data-mathtex-transform-clip]").nth(1)).toHaveAttribute("title", /–3[.]00s · linear$/u);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator("[data-mathtex-transform-clip]").nth(1)).toHaveAttribute("title", /–2[.]80s · smooth$/u);
    await page.getByRole("button", { name: "Undo" }).click();

    secondClip = page.locator("[data-mathtex-transform-clip]").nth(1);
    await secondClip.click();
    await page.getByRole("button", { name: "Remove Transform" }).click();
    await expect(page.locator("[data-mathtex-transform-clip]")).toHaveCount(1);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator("[data-mathtex-transform-clip]")).toHaveCount(2);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open MathTex Transform fixture workspace" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    transformClips = page.locator("[data-mathtex-transform-clip]");
    await expect(transformClips).toHaveCount(2);
    firstClip = transformClips.nth(0);
    secondClip = transformClips.nth(1);
    await expect(page.locator("[data-studio-entity-wrapper]")).toHaveCount(1);
    await scrubEntranceClip(page, secondClip, 1);
    const restoredRoot = page.getByRole("button", { name: "Move E = mc^2", exact: true });
    await expect(restoredRoot).toHaveAttribute("data-studio-entity", rootId);

    const sampleTimes = await Promise.all([
      entranceClipTime(page, firstClip, 0),
      entranceClipTime(page, firstClip, 0.5),
      entranceClipTime(page, firstClip, 1),
      entranceClipTime(page, secondClip, 0.5),
      entranceClipTime(page, secondClip, 1),
    ]);
    const mp4 = await exportLocalMp4(page);
    const pixels = await decodedBrightPixelCounts(page, mp4, sampleTimes);
    expect(Math.max(...pixels) - Math.min(...pixels)).toBeGreaterThan(20);
    expect(Math.abs((pixels[1] ?? 0) - (pixels[0] ?? 0))).toBeGreaterThan(10);
    expect(Math.abs((pixels[3] ?? 0) - (pixels[4] ?? 0))).toBeGreaterThan(10);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("orients an Arrow along a curved motion path through reload and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Path direction fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert arrow/ }).click();
    await canvas.click({ position: { x: 360, y: 260 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const arrow = page.getByRole("button", { name: "Move Arrow", exact: true });
    await expect(arrow).toBeVisible();

    await page.getByRole("button", { name: "Create animation" }).click();
    await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("1");
    await dragBy(page, arrow, { x: 120, y: 0 }, true);
    const revisionBeforeCurve = await canvas.getAttribute("data-preview-revision");
    await page.getByLabel("Curve Y").fill("-80");
    await expect.poll(async () => canvas.getAttribute("data-preview-revision")).not.toBe(revisionBeforeCurve);
    await page.getByRole("button", { name: "Apply program" }).click();

    const motionClip = page.getByRole("button", { name: "Edit Arrow motion clip" });
    const arrowId = await arrow.getAttribute("data-studio-entity");
    if (!arrowId) throw new Error("The Arrow did not expose its Studio entity id.");
    const arrowWrapper = page.locator(`[data-studio-entity-wrapper="${arrowId}"]`);
    await scrubMotionClip(page, motionClip, 0);
    const fixedStart = await preparedDimensions(arrowWrapper);
    expect(fixedStart.width).toBeGreaterThan(fixedStart.height);

    await motionClip.click();
    const followPath = page.getByRole("checkbox", { name: "Follow path direction" });
    await expect(followPath).not.toBeChecked();
    let revisionBeforeToggle = await canvas.getAttribute("data-preview-revision");
    await followPath.check();
    await expect.poll(async () => canvas.getAttribute("data-preview-revision")).not.toBe(revisionBeforeToggle);
    await scrubMotionClip(page, motionClip, 0);
    const orientedDraftStart = await preparedDimensions(arrowWrapper);
    expect(orientedDraftStart.height).toBeGreaterThan(orientedDraftStart.width);

    revisionBeforeToggle = await canvas.getAttribute("data-preview-revision");
    await followPath.uncheck();
    await expect.poll(async () => canvas.getAttribute("data-preview-revision")).not.toBe(revisionBeforeToggle);
    await scrubMotionClip(page, motionClip, 0);
    const restoredFixedStart = await preparedDimensions(arrowWrapper);
    expect(restoredFixedStart.width).toBeGreaterThan(restoredFixedStart.height);

    revisionBeforeToggle = await canvas.getAttribute("data-preview-revision");
    await followPath.check();
    await expect.poll(async () => canvas.getAttribute("data-preview-revision")).not.toBe(revisionBeforeToggle);
    await page.getByRole("button", { name: "Replace program" }).click();

    await scrubMotionClip(page, motionClip, 0);
    const orientedStart = await preparedDimensions(arrowWrapper);
    expect(orientedStart.height).toBeGreaterThan(orientedStart.width);
    await scrubMotionClip(page, motionClip, 0.5);
    const orientedMiddle = await preparedDimensions(arrowWrapper);
    expect(orientedMiddle.width).toBeGreaterThan(orientedMiddle.height);
    await scrubMotionClip(page, motionClip, 1);
    const orientedEnd = await preparedDimensions(arrowWrapper);
    expect(orientedEnd.height).toBeGreaterThan(orientedEnd.width);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Path direction fixture workspace" }).click();
    const restoredArrow = page.getByRole("button", { name: "Move Arrow", exact: true });
    const restoredArrowId = await restoredArrow.getAttribute("data-studio-entity");
    if (!restoredArrowId) throw new Error("The restored Arrow did not expose its Studio entity id.");
    const restoredArrowWrapper = page.locator(`[data-studio-entity-wrapper="${restoredArrowId}"]`);
    await scrubMotionClip(page, page.getByRole("button", { name: "Edit Arrow motion clip" }), 0);
    const restoredOrientedStart = await preparedDimensions(restoredArrowWrapper);
    expect(restoredOrientedStart.height).toBeGreaterThan(restoredOrientedStart.width);

    await exportLocalMp4(page);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("authors Triangle and Regular Polygon through motion, Draw, reload, and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Polygon authoring fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert triangle/ }).click();
    await canvas.click({ position: { x: 260, y: 240 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const triangle = page.getByRole("button", { name: "Move Triangle", exact: true });
    await expect(triangle).toBeVisible();
    const triangleId = await triangle.getAttribute("data-studio-entity");
    if (!triangleId) throw new Error("The Triangle did not expose its Studio entity id.");
    const triangleWrapper = page.locator(`[data-studio-entity-wrapper="${triangleId}"]`);
    await expect(page.getByText("r 1 · 3 sides", { exact: true })).toBeVisible();
    const triangleDimensions = await preparedDimensions(triangleWrapper);
    expect(triangleDimensions.width).toBeGreaterThan(1.6);
    expect(triangleDimensions.height).toBeGreaterThan(1.4);

    const triangleFill = page.getByLabel("Fill color Triangle");
    await triangleFill.fill("#3b82f6");
    await triangleFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(triangleFill).toHaveValue("#3b82f6");

    await page.getByRole("button", { name: "Create animation" }).click();
    await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("1");
    await dragBy(page, triangle, { x: 80, y: -30 }, true);
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("button", { name: "Edit Triangle motion clip" })).toBeVisible();

    await page.getByRole("button", { name: /Insert regular polygon/ }).click();
    const polygonSides = page.getByRole("spinbutton", { name: "Polygon sides" });
    await polygonSides.press("ControlOrMeta+A");
    await polygonSides.pressSequentially("12");
    await canvas.click({ position: { x: 520, y: 260 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const polygon = page.getByRole("button", { name: "Move RegularPolygon", exact: true });
    await expect(polygon).toBeVisible();
    const polygonId = await polygon.getAttribute("data-studio-entity");
    if (!polygonId) throw new Error("The Regular Polygon did not expose its Studio entity id.");
    const polygonWrapper = page.locator(`[data-studio-entity-wrapper="${polygonId}"]`);
    await expect(page.getByText("r 1 · 12 sides", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add Draw entrance for RegularPolygon" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    let drawClip = page.getByRole("button", { name: "Edit RegularPolygon Draw entrance" });
    await expect(drawClip).toBeVisible();
    await scrubEntranceClip(page, drawClip, 0);
    await expect(polygonWrapper).toHaveCount(0);
    await scrubEntranceClip(page, drawClip, 0.5);
    await expect(polygonWrapper).toHaveCount(1);
    await scrubEntranceClip(page, drawClip, 1);
    const completePolygonDimensions = await preparedDimensions(polygonWrapper);
    expect(completePolygonDimensions.width).toBeGreaterThan(1.9);
    expect(completePolygonDimensions.height).toBeGreaterThan(1.9);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Polygon authoring fixture workspace" }).click();
    await expect(page.getByRole("button", { name: "Move Triangle", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move RegularPolygon", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit Triangle motion clip" })).toBeVisible();
    drawClip = page.getByRole("button", { name: "Edit RegularPolygon Draw entrance" });
    await expect(drawClip).toBeVisible();
    await drawClip.click();
    await expect(page.getByRole("spinbutton", { name: "Draw duration for RegularPolygon" })).toBeEnabled();
    await page.getByRole("button", { name: "Discard" }).click();

    const mp4 = await exportLocalMp4(page);
    const exportedPixels = await decodedBrightPixelCounts(page, mp4, [0.02, 0.75, 1.6]);
    expect(exportedPixels[1] ?? 0).toBeGreaterThan((exportedPixels[0] ?? 0) + 20);
    expect(exportedPixels[2] ?? 0).toBeGreaterThan(exportedPixels[1] ?? 0);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("authors Ellipse, Arc, and Sector through Draw, reload, and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Curve primitive fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert ellipse/ }).click();
    await page.getByRole("slider", { name: "Ellipse width" }).fill("4");
    await page.getByRole("slider", { name: "Ellipse height" }).fill("1.5");
    await canvas.click({ position: { x: 260, y: 210 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const ellipse = page.getByRole("button", { name: "Move Ellipse", exact: true });
    await expect(ellipse).toBeVisible();
    await expect(page.getByText("w 4 · h 1.5", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Insert arc/ }).click();
    await page.getByRole("slider", { name: "Arc radius" }).fill("1.5");
    await page.getByRole("slider", { name: "Arc start angle" }).fill("45");
    await page.getByRole("slider", { name: "Arc sweep angle" }).fill("180");
    await canvas.click({ position: { x: 470, y: 190 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const arc = page.getByRole("button", { name: "Move Arc", exact: true });
    await expect(arc).toBeVisible();
    await expect(page.getByText("r 1.5 · start 45° · sweep 180°", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add Draw entrance for Arc" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    let drawClip = page.getByRole("button", { name: "Edit Arc Draw entrance" });
    await expect(drawClip).toBeVisible();
    const arcId = await arc.getAttribute("data-studio-entity");
    if (!arcId) throw new Error("The Arc did not expose its Studio entity id.");
    const arcWrapper = page.locator(`[data-studio-entity-wrapper="${arcId}"]`);
    await scrubEntranceClip(page, drawClip, 0);
    await expect(arcWrapper).toHaveCount(0);
    await scrubEntranceClip(page, drawClip, 0.5);
    await expect(arcWrapper).toHaveCount(1);

    await page.getByRole("button", { name: /Insert sector/ }).click();
    await page.getByRole("slider", { name: "Sector radius" }).fill("1.25");
    await page.getByRole("slider", { name: "Sector start angle" }).fill("-45");
    await page.getByRole("slider", { name: "Sector sweep angle" }).fill("270");
    await canvas.click({ position: { x: 390, y: 310 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("button", { name: "Move Sector", exact: true })).toBeVisible();
    await expect(page.getByText("r 1.25 · start -45° · sweep 270°", { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Curve primitive fixture workspace" }).click();
    await expect(page.getByRole("button", { name: "Move Ellipse", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move Arc", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move Sector", exact: true })).toBeVisible();
    drawClip = page.getByRole("button", { name: "Edit Arc Draw entrance" });
    await expect(drawClip).toBeVisible();

    const mp4 = await exportLocalMp4(page);
    const [brightPixels = 0] = await decodedBrightPixelCounts(page, mp4, [1]);
    expect(brightPixels).toBeGreaterThan(100);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("authors coordinate systems as editable roots through reload and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Coordinate system fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert number line/ }).click();
    await page.getByRole("spinbutton", { name: "X minimum" }).fill("-4");
    await page.getByRole("spinbutton", { name: "X maximum" }).fill("4");
    await page.getByRole("spinbutton", { name: "X step" }).fill("2");
    await page.getByRole("spinbutton", { name: "Display width" }).fill("5");
    await canvas.click({ position: { x: 170, y: 110 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("button", { name: "Move NumberLine", exact: true })).toBeVisible();
    await expect(page.getByText("x -4…4 / 2 · w 5", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Insert axes/ }).click();
    await page.getByRole("spinbutton", { name: "Y minimum" }).fill("-2");
    await page.getByRole("spinbutton", { name: "Y maximum" }).fill("2");
    await page.getByRole("spinbutton", { name: "Y step" }).fill("1");
    await canvas.click({ position: { x: 330, y: 190 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("button", { name: "Move Axes", exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Insert number plane/ }).click();
    await page.getByRole("spinbutton", { name: "X minimum" }).fill("-3");
    await page.getByRole("spinbutton", { name: "X maximum" }).fill("3");
    await page.getByRole("spinbutton", { name: "X step" }).fill("1");
    await page.getByRole("spinbutton", { name: "Display width" }).fill("6");
    await page.getByRole("spinbutton", { name: "Display height" }).fill("4");
    await canvas.click({ position: { x: 485, y: 280 } });
    await page.getByRole("button", { name: "Apply program" }).click();

    const plane = page.getByRole("button", { name: "Move NumberPlane", exact: true });
    await expect(plane).toBeVisible();
    const planeId = await plane.getAttribute("data-studio-entity");
    if (!planeId) throw new Error("The NumberPlane did not expose its Studio entity id.");
    const planeWrapper = page.locator(`[data-studio-entity-wrapper="${planeId}"]`);
    const initialScale = Number(await planeWrapper.getAttribute("data-studio-entity-scale"));

    await page.getByRole("button", { name: "Set position" }).click();
    await dragBy(page, plane, { x: 20, y: -12 });
    await page.getByRole("button", { name: "Apply program" }).click();
    const resize = page.getByRole("button", { name: "Resize NumberPlane from bottom-right corner" });
    await resize.press("ArrowRight");
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect
      .poll(async () => Number(await planeWrapper.getAttribute("data-studio-entity-scale")))
      .toBeGreaterThan(initialScale);

    await page.getByRole("button", { name: "Rotate NumberPlane counterclockwise by 15 degrees" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await page.getByRole("button", { name: "Add Draw entrance for NumberPlane" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    let drawClip = page.getByRole("button", { name: "Edit NumberPlane Draw entrance" });
    await expect(drawClip).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Coordinate system fixture workspace" }).click();
    await expect(page.getByRole("button", { name: "Move NumberLine", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move Axes", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move NumberPlane", exact: true })).toBeVisible();
    drawClip = page.getByRole("button", { name: "Edit NumberPlane Draw entrance" });
    await expect(drawClip).toBeVisible();

    const mp4 = await exportLocalMp4(page);
    const [brightPixels = 0] = await decodedBrightPixelCounts(page, mp4, [1]);
    expect(brightPixels).toBeGreaterThan(100);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("authors and edits a smooth data plot through reload and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Data plot fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert axes/ }).click();
    await canvas.click({ position: { x: 360, y: 220 } });
    await page.getByRole("button", { name: "Apply program" }).click();

    const axes = page.getByRole("button", { name: "Move Axes", exact: true });
    await expect(axes).toBeVisible();
    await axes.click();
    const samples = page.getByRole("textbox", { name: "Data plot sample points" });
    await samples.fill("-4,-1\n-2,1\n0,0\n2,2\n4,-1");
    await page.getByRole("combobox", { name: "Data plot interpolation" }).selectOption("smooth");
    await page.getByRole("button", { name: "Add data plot" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();

    const plot = page.getByRole("button", { name: "Move insert-0", exact: true });
    await expect(plot).toBeVisible();
    await plot.click();
    const stroke = page.getByLabel("Stroke color insert-0");
    await expect(stroke).toBeEnabled();
    await stroke.fill("#f59e0b");
    await stroke.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();

    await page.getByRole("button", { name: "Add Draw entrance for insert-0" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    let drawClip = page.getByRole("button", { name: "Edit insert-0 Draw entrance" });
    await expect(drawClip).toBeVisible();

    await samples.fill("-4,-1\n-2,1\n0,1.5\n2,2\n4,-1");
    await page.getByRole("button", { name: "Update data plot" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(samples).toHaveValue("-4,-1\n-2,1\n0,1.5\n2,2\n4,-1");

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(samples).toHaveValue("-4,-1\n-2,1\n0,0\n2,2\n4,-1");
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(samples).toHaveValue("-4,-1\n-2,1\n0,1.5\n2,2\n4,-1");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Data plot fixture workspace" }).click();
    await expect(page.getByRole("button", { name: "Move Axes", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move insert-0", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Move insert-0", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Data plot sample points" })).toHaveValue(
      "-4,-1\n-2,1\n0,1.5\n2,2\n4,-1",
    );
    await expect(page.getByRole("combobox", { name: "Data plot interpolation" })).toHaveValue("smooth");
    drawClip = page.getByRole("button", { name: "Edit insert-0 Draw entrance" });
    await expect(drawClip).toBeVisible();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const mp4 = await exportLocalMp4(page);
    const [brightPixels = 0] = await decodedBrightPixelCounts(page, mp4, [1]);
    expect(brightPixels).toBeGreaterThan(100);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("authors one cubic Bezier through direct controls, Draw, reload, and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Cubic Bezier fixture");
    const canvas = page.locator("[data-studio-canvas]");
    const waitForPresentedPreview = () => expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.getByRole("button", { name: "Pen tool (K)" }).click();
    await canvas.click({ position: { x: 180, y: 180 } });
    await expect(canvas.locator("text").filter({ hasText: "start" })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(canvas.locator("text").filter({ hasText: "start" })).toHaveCount(0);
    for (const position of [
      { x: 220, y: 230 },
      { x: 440, y: 150 },
      { x: 260, y: 90 },
      { x: 400, y: 290 },
    ]) {
      await canvas.click({ position });
    }
    await page.getByRole("button", { name: "Apply program" }).click();
    await waitForPresentedPreview();

    const curve = page.getByRole("button", { name: "Move CubicBezier", exact: true });
    await expect(curve).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(curve).toHaveCount(0);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(curve).toBeVisible();
    await waitForPresentedPreview();
    await curve.click();
    for (const [name, delta] of [
      ["start", { x: -8, y: 5 }],
      ["end", { x: 10, y: -6 }],
      ["control1", { x: -6, y: -12 }],
      ["control2", { x: 7, y: 10 }],
    ] as const) {
      await dragBy(page, page.locator(`[data-cubic-bezier-control="${name}"]`), delta);
      await page.getByRole("button", { name: "Replace program" }).click();
      await waitForPresentedPreview();
    }

    await page.getByRole("combobox", { name: "Cubic Bézier stroke cap" }).selectOption("square");
    await page.getByRole("button", { name: "Replace program" }).click();
    await waitForPresentedPreview();
    const strokeWidth = page.getByRole("spinbutton", { name: "Cubic Bézier stroke width" });
    await strokeWidth.fill("0.08");
    await strokeWidth.press("Tab");
    await page.getByRole("button", { name: "Replace program" }).click();
    await waitForPresentedPreview();
    await page.getByRole("checkbox", { name: "Arrow end" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await waitForPresentedPreview();

    await page.getByRole("button", { name: "Set position" }).click();
    await dragBy(page, curve, { x: 25, y: -15 });
    await page.getByRole("button", { name: "Apply program" }).click();
    await waitForPresentedPreview();
    await page.getByRole("button", { name: "Resize CubicBezier from bottom-right corner" }).press("ArrowRight");
    await page.getByRole("button", { name: "Apply program" }).click();
    await waitForPresentedPreview();
    await page.getByRole("button", { name: "Rotate CubicBezier counterclockwise by 15 degrees" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await waitForPresentedPreview();

    await page.getByRole("button", { name: "Add Draw entrance for CubicBezier" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await waitForPresentedPreview();
    let drawClip = page.getByRole("button", { name: "Edit CubicBezier Draw entrance" });
    await expect(drawClip).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Cubic Bezier fixture workspace" }).click();
    await expect(page.getByRole("button", { name: "Move CubicBezier", exact: true })).toBeVisible();
    drawClip = page.getByRole("button", { name: "Edit CubicBezier Draw entrance" });
    await expect(drawClip).toBeVisible();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const mp4 = await exportLocalMp4(page);
    const [brightPixels = 0] = await decodedBrightPixelCounts(page, mp4, [1]);
    expect(brightPixels).toBeGreaterThan(50);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});
