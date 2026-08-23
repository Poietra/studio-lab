import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { cleanupFixtureWorkspace } from "./workspace";

async function createBlankWorkspace(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Add workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Shape Transform fixture");
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects",
  );
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  return ((await (await responsePromise).json()) as { project: { id: string } }).project.id;
}

async function clipTime(page: Page, clip: Locator, progress: number) {
  const playhead = page.getByRole("slider", { name: "Scene playhead" });
  const sceneDuration = Number(await playhead.getAttribute("max"));
  const placement = await clip.evaluate((element) => ({
    left: Number.parseFloat((element as HTMLElement).style.left),
    width: Number.parseFloat((element as HTMLElement).style.width),
  }));
  return Number(((sceneDuration * (placement.left + placement.width * progress)) / 100).toFixed(2));
}

async function scrubClip(page: Page, clip: Locator, progress: number) {
  const canvas = page.locator("[data-studio-canvas]");
  const previousPacket = await canvas.getAttribute("data-preview-packet-id");
  const previousTime = Number(await canvas.getAttribute("data-preview-sample-time"));
  const time = await clipTime(page, clip, progress);
  await page.getByRole("slider", { name: "Scene playhead" }).fill(String(time));
  await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(time, 1);
  if (Math.abs(previousTime - time) > 0.001) {
    await expect.poll(async () => canvas.getAttribute("data-preview-packet-id")).not.toBe(previousPacket);
  }
  return time;
}

async function exportDecodedBrightPixelCounts(page: Page, sampleTimes: readonly number[]) {
  await page.getByRole("button", { name: "Export settings" }).click();
  const control = page.locator("[data-studio-export-mp4-state]");
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 }).catch(() => null);
  await page.getByRole("button", { name: "Export MP4" }).click();
  await expect
    .poll(async () => control.getAttribute("data-studio-export-mp4-state"), { timeout: 90_000 })
    .toMatch(/^(done|refused)$/u);
  if ((await control.getAttribute("data-studio-export-mp4-state")) === "refused") {
    const reason = await control.getAttribute("data-studio-export-mp4-reason");
    test.skip(reason === "unsupported-codec", "This Chromium build has no supported H.264 WebCodecs encoder.");
    throw new Error(`The shape Transform MP4 export was refused: ${reason ?? "unknown"}.`);
  }
  const download = await downloadPromise;
  if (!download) throw new Error("The shape Transform MP4 was not downloaded.");
  const path = await download.path();
  if (!path) throw new Error("Playwright did not persist the shape Transform MP4.");
  const mp4Base64 = (await readFile(path)).toString("base64");

  return page.evaluate(
    async ({ mp4Base64, sampleTimes }) => {
      const bytes = Uint8Array.from(atob(mp4Base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      const video = document.createElement("video");
      video.muted = true;
      video.src = url;
      try {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadeddata", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error("Chromium rejected the shape Transform MP4.")), {
            once: true,
          });
          video.load();
        });
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
        if (!context) throw new Error("The decoded shape Transform frame canvas is unavailable.");
        const counts: number[] = [];
        for (const sampleTime of sampleTimes) {
          await new Promise<void>((resolve) => {
            video.addEventListener("seeked", () => resolve(), { once: true });
            video.currentTime = sampleTime;
          });
          context.drawImage(video, 0, 0);
          const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let bright = 0;
          for (let offset = 0; offset < rgba.length; offset += 4) {
            if ((rgba[offset] ?? 0) + (rgba[offset + 1] ?? 0) + (rgba[offset + 2] ?? 0) > 90) bright += 1;
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

test("morphs one Rectangle to Circle and back through WebGPU, reload, and decoded MP4", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page);
    const canvas = page.locator("[data-studio-canvas]");
    const playhead = page.getByRole("slider", { name: "Scene playhead" });

    await expect(page.getByLabel("Current workspace")).toHaveText("Shape Transform fixture");
    const insertRectangle = page.getByRole("button", { name: /Insert rectangle/ });
    await expect(insertRectangle).toBeEnabled();
    await insertRectangle.click();
    await canvas.click({ position: { x: 400, y: 220 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const rootId = await page
      .getByRole("button", { name: "Move Rectangle", exact: true })
      .getAttribute("data-studio-entity");
    if (!rootId) throw new Error("The Studio Rectangle did not expose its logical root id.");
    const logicalRoot = page.locator(`[data-studio-entity="${rootId}"]`);
    await playhead.fill("1");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(1, 1);

    await page.getByRole("combobox", { name: "Shape transform target of Rectangle" }).selectOption("Circle");
    await page.getByRole("spinbutton", { name: "Shape transform duration of Rectangle" }).fill("1");
    await page.getByRole("button", { name: "Create Shape Transform clip" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    let clips = page.locator("[data-shape-transform-clip]");
    await expect(clips).toHaveCount(1);
    const firstClip = clips.nth(0);
    await scrubClip(page, firstClip, 0);
    const startFrame = await canvas.screenshot();
    await scrubClip(page, firstClip, 0.5);
    const middleFrame = await canvas.screenshot();
    await expect(logicalRoot).toHaveCount(1);
    await scrubClip(page, firstClip, 1);
    const circleFrame = await canvas.screenshot();
    expect(middleFrame.equals(startFrame)).toBe(false);
    expect(circleFrame.equals(middleFrame)).toBe(false);

    await page
      .getByRole("combobox", { name: /Shape transform target of (Circle|Rectangle)/ })
      .selectOption("Rectangle");
    await page.getByRole("combobox", { name: /Shape transform easing of (Circle|Rectangle)/ }).selectOption("linear");
    await page.getByRole("button", { name: "Create Shape Transform clip" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    clips = page.locator("[data-shape-transform-clip]");
    await expect(clips).toHaveCount(2);
    let secondClip = clips.nth(1);
    await scrubClip(page, secondClip, 0.5);
    await scrubClip(page, secondClip, 1);
    await expect(page.getByRole("button", { name: "Move Rectangle", exact: true })).toHaveAttribute(
      "data-studio-entity",
      rootId,
    );

    const originalSecondTitle = await secondClip.getAttribute("title");
    if (!originalSecondTitle) throw new Error("The second shape Transform clip did not expose its timing.");
    await secondClip.click();
    await page.getByRole("spinbutton", { name: /Shape Transform duration for/ }).fill("0.8");
    await page.getByRole("spinbutton", { name: /Shape Transform duration for/ }).press("Enter");
    await page.getByRole("combobox", { name: /Shape Transform easing for/ }).selectOption("smooth");
    await page.getByRole("button", { name: "Replace program" }).click();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(clips.nth(1)).toHaveAttribute("title", originalSecondTitle);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(clips.nth(1)).toHaveAttribute("title", /–2[.]80s · smooth$/u);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(clips.nth(1)).toHaveAttribute("title", originalSecondTitle);

    secondClip = clips.nth(1);
    await secondClip.click();
    await page.getByRole("button", { name: "Remove Shape Transform" }).click();
    await expect(clips).toHaveCount(1);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(clips).toHaveCount(2);

    await page.reload();
    await page.getByRole("button", { name: "Open Shape Transform fixture workspace" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    clips = page.locator("[data-shape-transform-clip]");
    await expect(clips).toHaveCount(2);
    await scrubClip(page, clips.nth(1), 1);
    await expect(page.getByRole("button", { name: "Move Rectangle", exact: true })).toHaveAttribute(
      "data-studio-entity",
      rootId,
    );

    const sampleTimes = await Promise.all([
      clipTime(page, clips.nth(0), 0),
      clipTime(page, clips.nth(0), 0.5),
      clipTime(page, clips.nth(0), 1),
      clipTime(page, clips.nth(1), 0.5),
      clipTime(page, clips.nth(1), 1),
    ]);
    const counts = await exportDecodedBrightPixelCounts(page, sampleTimes);
    expect(Math.max(...counts) - Math.min(...counts)).toBeGreaterThan(20);
    expect(Math.abs((counts[1] ?? 0) - (counts[0] ?? 0))).toBeGreaterThan(10);
    expect(Math.abs((counts[3] ?? 0) - (counts[4] ?? 0))).toBeGreaterThan(10);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});
