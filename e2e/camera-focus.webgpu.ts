import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { cleanupFixtureWorkspace } from "./workspace";

async function createBlankWorkspace(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Add workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Camera Focus fixture");
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
  return Number(((sceneDuration * (placement.left + placement.width * progress)) / 100).toFixed(3));
}

async function scrubClip(page: Page, clip: Locator, progress: number) {
  const canvas = page.locator("[data-studio-canvas]");
  const previousPacket = await canvas.getAttribute("data-preview-packet-id");
  const previousTime = Number(await canvas.getAttribute("data-preview-sample-time"));
  const time = await clipTime(page, clip, progress);
  await page.getByRole("slider", { name: "Scene playhead" }).fill(String(time));
  await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(time, 2);
  if (Math.abs(previousTime - time) > 0.001) {
    await expect.poll(async () => canvas.getAttribute("data-preview-packet-id")).not.toBe(previousPacket);
  }
  return time;
}

async function exportDecodedCameraMetrics(page: Page, sampleTimes: readonly number[]) {
  const control = page.locator("[data-studio-export-mp4-state]");
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 }).catch(() => null);
  await page.getByRole("button", { name: "Export MP4" }).click();
  await expect
    .poll(async () => control.getAttribute("data-studio-export-mp4-state"), { timeout: 90_000 })
    .toMatch(/^(done|refused)$/u);
  if ((await control.getAttribute("data-studio-export-mp4-state")) === "refused") {
    const reason = await control.getAttribute("data-studio-export-mp4-reason");
    test.skip(reason === "unsupported-codec", "This Chromium build has no supported H.264 WebCodecs encoder.");
    throw new Error(`The Camera Focus MP4 export was refused: ${reason ?? "unknown"}.`);
  }
  const download = await downloadPromise;
  if (!download) throw new Error("The Camera Focus MP4 was not downloaded.");
  const path = await download.path();
  if (!path) throw new Error("Playwright did not persist the Camera Focus MP4.");
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
          video.addEventListener("error", () => reject(new Error("Chromium rejected the Camera Focus MP4.")), {
            once: true,
          });
          video.load();
        });
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
        if (!context) throw new Error("The decoded Camera Focus frame canvas is unavailable.");

        const frames: Uint8ClampedArray[] = [];
        const brightPixelCounts: number[] = [];
        for (const sampleTime of sampleTimes) {
          await new Promise<void>((resolve) => {
            video.addEventListener("seeked", () => resolve(), { once: true });
            video.currentTime = Math.min(sampleTime, Math.max(0, video.duration - 0.001));
          });
          context.drawImage(video, 0, 0);
          const rgba = new Uint8ClampedArray(context.getImageData(0, 0, canvas.width, canvas.height).data);
          let bright = 0;
          for (let offset = 0; offset < rgba.length; offset += 4) {
            if ((rgba[offset] ?? 0) + (rgba[offset + 1] ?? 0) + (rgba[offset + 2] ?? 0) > 90) bright += 1;
          }
          frames.push(rgba);
          brightPixelCounts.push(bright);
        }

        const meanRgbDifference = (left: Uint8ClampedArray, right: Uint8ClampedArray) => {
          let total = 0;
          for (let offset = 0; offset < left.length; offset += 4) {
            total +=
              Math.abs((left[offset] ?? 0) - (right[offset] ?? 0)) +
              Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0)) +
              Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0));
          }
          return total / ((left.length / 4) * 3);
        };
        return {
          brightPixelCounts,
          focusDifference: meanRgbDifference(frames[0]!, frames[1]!),
          resetDifference: meanRgbDifference(frames[0]!, frames[2]!),
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { mp4Base64, sampleTimes },
  );
}

test("focuses and resets the Studio camera through canonical WebGPU and local MP4", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page);
    const canvas = page.locator("[data-studio-canvas]");
    const playhead = page.getByRole("slider", { name: "Scene playhead" });

    await expect(page.getByLabel("Current workspace")).toHaveText("Camera Focus fixture");
    await page.getByRole("button", { name: /Insert rectangle/ }).click();
    await canvas.click({ position: { x: 170, y: 180 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const rectangle = page.getByRole("button", { name: "Move Rectangle", exact: true });
    const rectangleId = await rectangle.getAttribute("data-studio-entity");
    if (!rectangleId) throw new Error("The Studio Rectangle did not expose its logical root id.");

    await page.getByRole("button", { name: /Insert circle/ }).click();
    await canvas.click({ position: { x: 470, y: 180 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const circle = page.getByRole("button", { name: "Move Circle", exact: true });
    const circleId = await circle.getAttribute("data-studio-entity");
    if (!circleId) throw new Error("The Studio Circle did not expose its logical root id.");
    expect(circleId).not.toBe(rectangleId);

    await playhead.fill("1");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(1, 2);
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await circle.click();
    const circleStartBounds = await circle.boundingBox();
    if (!circleStartBounds) throw new Error("The Circle hit target was unavailable before Camera Focus.");
    await page.getByRole("button", { name: "Focus selection", exact: true }).click();
    await page.getByRole("button", { name: "Apply program" }).click();

    const cameraTrack = page.locator("[data-camera-track]");
    let clips = page.locator("[data-camera-clip]");
    await expect(cameraTrack).toHaveCount(1);
    await expect(clips).toHaveCount(1);
    await scrubClip(page, clips.nth(0), 0);
    const startFrame = await canvas.screenshot();
    await scrubClip(page, clips.nth(0), 0.5);
    const focusMiddleFrame = await canvas.screenshot();
    await scrubClip(page, clips.nth(0), 1);
    const focusFrame = await canvas.screenshot();
    const circleFocusBounds = await circle.boundingBox();
    if (!circleFocusBounds) throw new Error("The Circle hit target was unavailable during Camera Focus.");
    expect(focusMiddleFrame.equals(startFrame)).toBe(false);
    expect(focusFrame.equals(startFrame)).toBe(false);
    expect(circleFocusBounds.width).toBeGreaterThan(circleStartBounds.width * 1.3);
    await page.mouse.click(
      circleFocusBounds.x + circleFocusBounds.width / 2,
      circleFocusBounds.y + circleFocusBounds.height / 2,
    );
    await expect(circle).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Reset view", exact: true }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    clips = page.locator("[data-camera-clip]");
    await expect(clips).toHaveCount(2);
    await expect(cameraTrack).toHaveCount(1);
    await scrubClip(page, clips.nth(1), 0.5);
    const resetMiddleFrame = await canvas.screenshot();
    await scrubClip(page, clips.nth(1), 1);
    const resetFrame = await canvas.screenshot();
    const circleResetBounds = await circle.boundingBox();
    if (!circleResetBounds) throw new Error("The Circle hit target was unavailable after Camera Reset.");
    expect(resetMiddleFrame.equals(focusFrame)).toBe(false);
    expect(resetFrame.equals(startFrame)).toBe(true);
    expect(circleResetBounds.width).toBeCloseTo(circleStartBounds.width, 1);
    expect(circleResetBounds.height).toBeCloseTo(circleStartBounds.height, 1);
    await expect(rectangle).toHaveAttribute("data-studio-entity", rectangleId);
    await expect(circle).toHaveAttribute("data-studio-entity", circleId);

    clips = page.locator("[data-camera-clip]");
    await clips.nth(1).click();
    await page.getByRole("button", { name: "Remove Camera clip", exact: true }).click();
    await expect(clips).toHaveCount(1);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(clips).toHaveCount(2);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(clips).toHaveCount(1);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(clips).toHaveCount(2);

    const originalFocusTitle = await clips.nth(0).getAttribute("title");
    if (!originalFocusTitle) throw new Error("The Focus clip did not expose its timing.");
    await clips.nth(0).click();
    await page.getByRole("spinbutton", { name: "Camera duration", exact: true }).fill("0.8");
    await page.getByRole("spinbutton", { name: "Camera duration", exact: true }).press("Enter");
    await page.getByRole("combobox", { name: "Camera easing", exact: true }).selectOption("linear");
    await page.getByRole("button", { name: "Replace program" }).click();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("[data-camera-clip]").nth(0)).toHaveAttribute("title", originalFocusTitle);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator("[data-camera-clip]").nth(0)).not.toHaveAttribute("title", originalFocusTitle);

    await page.reload();
    await page.getByRole("button", { name: "Open Camera Focus fixture workspace" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    clips = page.locator("[data-camera-clip]");
    await expect(clips).toHaveCount(2);
    await expect(page.locator("[data-camera-track]")).toHaveCount(1);
    await scrubClip(page, clips.nth(1), 1);
    await expect(page.getByRole("button", { name: "Move Rectangle", exact: true })).toHaveAttribute(
      "data-studio-entity",
      rectangleId,
    );
    await expect(page.getByRole("button", { name: "Move Circle", exact: true })).toHaveAttribute(
      "data-studio-entity",
      circleId,
    );

    const focusStart = await clipTime(page, clips.nth(0), 0);
    const focusEnd = await clipTime(page, clips.nth(0), 1);
    const resetEnd = await clipTime(page, clips.nth(1), 1);
    const metrics = await exportDecodedCameraMetrics(page, [focusStart + 0.02, focusEnd - 0.02, resetEnd - 0.02]);
    const [startBright = 0, focusBright = 0, resetBright = 0] = metrics.brightPixelCounts;
    const focusBrightDifference = Math.abs(focusBright - startBright);
    expect(focusBrightDifference).toBeGreaterThan(20);
    expect(metrics.focusDifference).toBeGreaterThan(0.25);
    expect(metrics.resetDifference).toBeLessThan(metrics.focusDifference * 0.4);
    expect(Math.abs(resetBright - startBright)).toBeLessThan(Math.max(100, focusBrightDifference * 0.4));
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});
