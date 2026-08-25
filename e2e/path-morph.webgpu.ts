import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { cleanupFixtureWorkspace } from "./workspace";

const WORKSPACE_NAME = "Path Morph fixture";

async function createBlankWorkspace(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Add workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByRole("textbox", { name: "Workspace name" }).fill(WORKSPACE_NAME);
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects",
  );
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  return ((await (await responsePromise).json()) as { project: { id: string } }).project.id;
}

async function dragBy(page: Page, target: Locator, delta: Readonly<{ x: number; y: number }>) {
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error("The Path Morph target handle is not visible.");
  const origin = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: 6 });
  await page.mouse.up();
}

async function clipTime(page: Page, clip: Locator, progress: number) {
  const sceneDuration = Number(await page.getByRole("slider", { name: "Scene playhead" }).getAttribute("max"));
  const placement = await clip.evaluate((element) => ({
    left: Number.parseFloat((element as HTMLElement).style.left),
    width: Number.parseFloat((element as HTMLElement).style.width),
  }));
  return Number(((sceneDuration * (placement.left + placement.width * progress)) / 100).toFixed(2));
}

async function scrubTime(page: Page, time: number) {
  const canvas = page.locator("[data-studio-canvas]");
  const previousPacket = await canvas.getAttribute("data-preview-packet-id");
  const previousTime = Number(await canvas.getAttribute("data-preview-sample-time"));
  await page.getByRole("slider", { name: "Scene playhead" }).fill(String(time));
  await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(time, 1);
  if (Math.abs(previousTime - time) > 0.001) {
    await expect.poll(async () => canvas.getAttribute("data-preview-packet-id")).not.toBe(previousPacket);
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  return time;
}

async function scrubClip(page: Page, clip: Locator, progress: number) {
  return scrubTime(page, await clipTime(page, clip, progress));
}

async function exportDecodedBounds(page: Page, sampleTimes: readonly number[]) {
  await page.getByRole("button", { name: "Export settings" }).click();
  const exportState = page.locator("[data-studio-export-mp4-state]");
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 }).catch(() => null);
  await page.getByRole("button", { name: "Export MP4" }).click();
  await expect
    .poll(async () => exportState.getAttribute("data-studio-export-mp4-state"), { timeout: 90_000 })
    .toMatch(/^(done|refused)$/u);
  if ((await exportState.getAttribute("data-studio-export-mp4-state")) === "refused") {
    const reason = await exportState.getAttribute("data-studio-export-mp4-reason");
    test.skip(reason === "unsupported-codec", "This Chromium build has no supported H.264 WebCodecs encoder.");
    throw new Error(`The Path Morph MP4 export was refused: ${reason ?? "unknown"}.`);
  }
  const download = await downloadPromise;
  if (!download) throw new Error("The Path Morph MP4 was not downloaded.");
  const path = await download.path();
  if (!path) throw new Error("Playwright did not persist the Path Morph MP4.");
  const mp4Base64 = (await readFile(path)).toString("base64");
  await page.getByRole("button", { exact: true, name: "Close" }).click();

  return page.evaluate(
    async ({ mp4Base64, sampleTimes }) => {
      const bytes = Uint8Array.from(atob(mp4Base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = url;
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("The Path Morph MP4 was not decodable.")), 15_000);
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
              reject(new Error(video.error?.message || "Chromium rejected the Path Morph MP4."));
            },
            { once: true },
          );
          video.load();
        });
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
        if (!context) throw new Error("The Path Morph frame decoder canvas is unavailable.");

        const evidence: Array<
          Readonly<{
            bright: number;
            height: number;
            maxX: number;
            maxY: number;
            minX: number;
            minY: number;
            width: number;
          }>
        > = [];
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
          const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let bright = 0;
          let minX = canvas.width;
          let minY = canvas.height;
          let maxX = -1;
          let maxY = -1;
          for (let offset = 0; offset < rgba.length; offset += 4) {
            const red = rgba[offset] ?? 0;
            const green = rgba[offset + 1] ?? 0;
            const blue = rgba[offset + 2] ?? 0;
            if (red + green + blue <= 180) continue;
            const pixel = offset / 4;
            const x = pixel % canvas.width;
            const y = Math.floor(pixel / canvas.width);
            bright += 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
          if (bright === 0) throw new Error(`The decoded Path Morph frame at ${sampleTime}s is empty.`);
          evidence.push({
            bright,
            height: maxY - minY + 1,
            maxX,
            maxY,
            minX,
            minY,
            width: maxX - minX + 1,
          });
        }
        return evidence;
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { mp4Base64, sampleTimes },
  );
}

test("morphs one material Pen path through target handles, reload, decoded MP4, and timeline history", async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page);
    const canvas = page.locator("[data-studio-canvas]");
    const previewCanvas = page.locator("[data-studio-preview-canvas]");
    const waitForPresentedPreview = () => expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.getByRole("button", { name: "Pen tool (K)" }).click();
    for (const position of [
      { x: 180, y: 260 },
      { x: 360, y: 260 },
      { x: 220, y: 260 },
      { x: 320, y: 260 },
    ]) {
      await canvas.click({ position });
    }
    await page.getByRole("button", { name: "Apply program" }).click();
    await waitForPresentedPreview();

    const curve = page.getByRole("button", { exact: true, name: "Move CubicBezier" });
    await curve.click();
    await page.getByRole("button", { name: /Extend path/ }).click();
    await canvas.click({ position: { x: 520, y: 140 } });
    await page.getByRole("button", { name: "Replace program" }).click();
    await waitForPresentedPreview();
    await expect(page.locator('[data-cubic-bezier-control="segment-2-end"]')).toBeVisible();

    const gradientPreset = page.getByText("Gradient preset").locator("xpath=../..");
    await gradientPreset.getByRole("button", { name: "Create & apply" }).click();
    const material = page.getByRole("combobox", { name: "Assigned fragment material" });
    await expect(material).not.toHaveValue("");
    await waitForPresentedPreview();

    const strokeWidth = page.getByRole("spinbutton", { name: "Cubic Bézier stroke width" });
    await strokeWidth.fill("0.12");
    await strokeWidth.press("Tab");
    await page.getByRole("button", { name: "Replace program" }).click();
    await waitForPresentedPreview();
    await expect(material).not.toHaveValue("");

    const roundFrame = await previewCanvas.screenshot();
    const strokeJoin = page.getByRole("combobox", { name: "Stroke join Pen" });
    await expect(strokeJoin).toHaveValue("round");
    await strokeJoin.selectOption("bevel");
    const packetBeforeJoin = await canvas.getAttribute("data-preview-packet-id");
    await strokeJoin.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect.poll(async () => canvas.getAttribute("data-preview-packet-id")).not.toBe(packetBeforeJoin);
    await waitForPresentedPreview();
    const bevelFrame = await previewCanvas.screenshot();
    expect(bevelFrame.equals(roundFrame)).toBe(false);
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(strokeJoin).toHaveValue("round");
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(strokeJoin).toHaveValue("bevel");

    const dashLength = page.getByRole("spinbutton", { name: "Dash length CubicBezier" });
    const gapLength = page.getByRole("spinbutton", { name: "Gap length CubicBezier" });
    await dashLength.fill("0.24");
    await gapLength.fill("0.16");
    await page.getByRole("button", { name: "Set dashed stroke" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await waitForPresentedPreview();
    await expect(material).not.toHaveValue("");

    const packetBeforeMorphDraft = await canvas.getAttribute("data-preview-packet-id");
    await page.getByRole("button", { exact: true, name: "+ Path Morph" }).click();
    await expect.poll(async () => canvas.getAttribute("data-preview-packet-id")).not.toBe(packetBeforeMorphDraft);
    await waitForPresentedPreview();
    const targetEnd = page.locator('[data-cubic-bezier-control="segment-2-end"]');
    await expect(targetEnd).toBeVisible();
    const targetBefore = await targetEnd.boundingBox();
    await dragBy(page, targetEnd, { x: 160, y: -120 });
    const targetAfter = await targetEnd.boundingBox();
    expect(targetAfter?.x).toBeGreaterThan((targetBefore?.x ?? 0) + 100);
    expect(targetAfter?.y).toBeLessThan((targetBefore?.y ?? 0) - 70);
    await page.getByRole("button", { name: "Apply program" }).click();
    await waitForPresentedPreview();

    let clip = page.locator("[data-path-morph-clip]");
    await expect(clip).toHaveCount(1);
    const startFrame = await scrubClip(page, clip, 0).then(() => previewCanvas.screenshot());
    const middleFrame = await scrubClip(page, clip, 0.5).then(() => previewCanvas.screenshot());
    const endFrame = await scrubClip(page, clip, 1).then(() => previewCanvas.screenshot());
    expect(middleFrame.equals(startFrame)).toBe(false);
    expect(endFrame.equals(middleFrame)).toBe(false);
    expect(endFrame.equals(startFrame)).toBe(false);

    await clip.click();
    const durationInput = page.getByRole("spinbutton", { name: "Path Morph duration for CubicBezier" });
    const maximumDuration = Number(await durationInput.getAttribute("max"));
    const editedDuration = Math.min(1.4, maximumDuration);
    expect(editedDuration).toBeGreaterThan(1);
    await durationInput.fill(String(editedDuration));
    await durationInput.press("Enter");
    await page.getByRole("combobox", { name: "Path Morph easing for CubicBezier" }).selectOption("linear");
    await page.getByRole("button", { name: "Replace program" }).click();
    await waitForPresentedPreview();
    clip = page.locator("[data-path-morph-clip]");
    await expect(clip).toHaveAttribute("title", /linear$/u);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: `Open ${WORKSPACE_NAME} workspace` }).click();
    await waitForPresentedPreview();
    clip = page.locator("[data-path-morph-clip]");
    await expect(clip).toHaveCount(1);
    await expect(clip).toHaveAttribute("title", /linear$/u);
    expect((await clipTime(page, clip, 1)) - (await clipTime(page, clip, 0))).toBeCloseTo(editedDuration, 1);
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(page.getByRole("combobox", { name: "Assigned fragment material" })).not.toHaveValue("");
    await expect(page.getByRole("spinbutton", { name: "Dash length CubicBezier" })).toHaveValue("0.24");
    await expect(page.getByRole("spinbutton", { name: "Gap length CubicBezier" })).toHaveValue("0.16");
    await expect(page.getByRole("button", { name: "Use solid stroke" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Stroke join Pen" })).toHaveValue("bevel");

    const sceneDuration = Number(await page.getByRole("slider", { name: "Scene playhead" }).getAttribute("max"));
    const clipStart = await clipTime(page, clip, 0);
    const clipMiddle = await clipTime(page, clip, 0.5);
    const clipEnd = await clipTime(page, clip, 1);
    const sampleTimes = [
      Math.min(sceneDuration - 0.02, clipStart + 0.02),
      clipMiddle,
      Math.min(sceneDuration - 0.02, clipEnd + 0.05),
    ];
    const [startBounds, middleBounds, endBounds] = await exportDecodedBounds(page, sampleTimes);
    if (!startBounds || !middleBounds || !endBounds) throw new Error("The decoded Path Morph bounds are incomplete.");
    expect(startBounds.bright).toBeGreaterThan(20);
    expect(middleBounds.bright).toBeGreaterThan(20);
    expect(endBounds.bright).toBeGreaterThan(20);
    expect(
      Math.abs(middleBounds.width - startBounds.width) + Math.abs(middleBounds.height - startBounds.height),
    ).toBeGreaterThan(20);
    expect(
      Math.abs(endBounds.width - middleBounds.width) + Math.abs(endBounds.height - middleBounds.height),
    ).toBeGreaterThan(20);

    // Replacement edits are separate undo entries. Return to the appended
    // morph before deleting the clip so redo preserves both operations.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("[data-path-morph-clip]")).toHaveCount(1);
    clip = page.locator("[data-path-morph-clip]");
    await clip.click();
    await page.getByRole("button", { name: "Remove Path Morph" }).click();
    await expect(page.locator("[data-path-morph-clip]")).toHaveCount(0);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator("[data-path-morph-clip]")).toHaveCount(1);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("[data-path-morph-clip]")).toHaveCount(0);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator("[data-path-morph-clip]")).toHaveCount(1);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});
