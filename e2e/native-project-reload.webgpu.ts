import { readFile } from "node:fs/promises";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { verifyExportMp4V1 } from "../src/engine/export-mp4-verification";
import { importManimScene } from "../src/render-pipeline/source-import";
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

async function motionClipTime(page: Page, clip: Locator, progress: number) {
  const slider = page.getByRole("slider", { name: "Scene playhead" });
  const duration = Number(await slider.getAttribute("max"));
  const operationId = await clip.getAttribute("data-applied-motion-clip");
  if (!operationId) throw new Error("The motion clip did not expose its operation id.");
  const placement = await page.locator(`[data-applied-motion-clip-wrapper="${operationId}"]`).evaluate((wrapper) => ({
    left: Number.parseFloat((wrapper as HTMLElement).style.left),
    width: Number.parseFloat((wrapper as HTMLElement).style.width),
  }));
  return Number(((duration * (placement.left + placement.width * progress)) / 100).toFixed(2));
}

async function scrubMotionClip(page: Page, clip: Locator, progress: number) {
  const slider = page.getByRole("slider", { name: "Scene playhead" });
  const time = await motionClipTime(page, clip, progress);
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

async function propertyKeyframeTime(marker: Locator) {
  const label = await marker.getAttribute("aria-label");
  const match = / at ([0-9]+(?:[.][0-9]+)?) seconds$/u.exec(label ?? "");
  if (!match?.[1]) throw new Error("The property keyframe did not expose its timeline time.");
  return Number(match[1]);
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
  await page.getByRole("button", { exact: true, name: "Close" }).click();
  return bytes.toString("base64");
}

type DecodedPixelMode = "blue-dominant" | "bright" | "green-dominant" | "red-dominant";

async function decodedPixelStats(
  page: Page,
  mp4Base64: string,
  sampleTimes: readonly number[],
  mode: DecodedPixelMode = "bright",
  normalizedRegion?: Readonly<{ bottom: number; left: number; right: number; top: number }>,
) {
  return page.evaluate(
    async ({ mode, mp4Base64, normalizedRegion, sampleTimes }) => {
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
        const matchesMode = (red: number, green: number, blue: number) =>
          mode === "green-dominant"
            ? green > 32 && green > red * 2 && green > blue * 1.5
            : mode === "blue-dominant"
              ? blue > 32 && blue > red * 1.5 && blue > green * 1.5
              : mode === "red-dominant"
                ? red > 32 && red > green * 1.5 && red > blue * 1.5
                : red + green + blue > 90;
        const stats: Readonly<{
          commonColorDifferenceFromPrevious: number;
          commonPixelCountFromPrevious: number;
          count: number;
          x: number;
          y: number;
        }>[] = [];
        let previousFrame: Uint8ClampedArray | null = null;
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
          let commonColorDifferenceFromPrevious = 0;
          let commonPixelCountFromPrevious = 0;
          let totalX = 0;
          let totalY = 0;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const pixel = offset / 4;
            const pixelX = pixel % canvas.width;
            const pixelY = Math.floor(pixel / canvas.width);
            if (
              normalizedRegion &&
              (pixelX < normalizedRegion.left * canvas.width ||
                pixelX > normalizedRegion.right * canvas.width ||
                pixelY < normalizedRegion.top * canvas.height ||
                pixelY > normalizedRegion.bottom * canvas.height)
            ) {
              continue;
            }
            const red = pixels[offset] ?? 0;
            const green = pixels[offset + 1] ?? 0;
            const blue = pixels[offset + 2] ?? 0;
            if (matchesMode(red, green, blue)) {
              bright += 1;
              totalX += pixelX;
              totalY += pixelY;
              if (previousFrame) {
                const previousRed = previousFrame[offset] ?? 0;
                const previousGreen = previousFrame[offset + 1] ?? 0;
                const previousBlue = previousFrame[offset + 2] ?? 0;
                if (matchesMode(previousRed, previousGreen, previousBlue)) {
                  commonPixelCountFromPrevious += 1;
                  commonColorDifferenceFromPrevious +=
                    Math.abs(red - previousRed) + Math.abs(green - previousGreen) + Math.abs(blue - previousBlue);
                }
              }
            }
          }
          previousFrame = new Uint8ClampedArray(pixels);
          stats.push({
            commonColorDifferenceFromPrevious,
            commonPixelCountFromPrevious,
            count: bright,
            x: bright === 0 ? Number.NaN : totalX / bright,
            y: bright === 0 ? Number.NaN : totalY / bright,
          });
        }
        return stats;
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { mode, mp4Base64, normalizedRegion, sampleTimes },
  );
}

async function decodedBrightPixelCounts(
  page: Page,
  mp4Base64: string,
  sampleTimes: readonly number[],
  mode: DecodedPixelMode = "bright",
) {
  return (await decodedPixelStats(page, mp4Base64, sampleTimes, mode)).map(({ count }) => count);
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

test("persists one project WAV through Timeline and Opus MP4 export", async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Project audio fixture");
    const canvas = page.locator("[data-studio-canvas]");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.getByLabel("Project WAV audio file").setInputFiles({
      buffer: monoPcmWav48k(0.4),
      mimeType: "audio/wav",
      name: "tone.wav",
    });
    const audioLane = page.locator("[data-project-audio-track]");
    await expect(audioLane).toContainText("tone.wav");
    await expect(audioLane.getByLabel("Audio track tone.wav, 0.00–5.00 seconds")).toBeVisible();

    const unsupportedWav = monoPcmWav48k(0.4);
    unsupportedWav.writeUInt32LE(44_100, 24);
    unsupportedWav.writeUInt32LE(88_200, 28);
    await page.getByLabel("Project WAV audio file").setInputFiles({
      buffer: unsupportedWav,
      mimeType: "audio/wav",
      name: "unsupported.wav",
    });
    await expect(page.getByRole("alert").filter({ hasText: "44100 Hz is not 48000 Hz" })).toBeVisible();
    await expect(audioLane).toContainText("tone.wav");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Project audio fixture workspace" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(audioLane).toContainText("tone.wav");

    const mp4Base64 = await exportLocalMp4(page);
    const mp4Bytes = Uint8Array.from(Buffer.from(mp4Base64, "base64"));
    const verification = await verifyExportMp4V1(mp4Bytes);
    if (verification.kind !== "verified") {
      throw new Error(`The Rust verifier refused the project-audio MP4: ${verification.code}: ${verification.message}`);
    }
    expect(verification.structure.audio).toMatchObject({ channels: 1, sampleRate: 48_000 });
    expect(verification.structure.audio?.sampleCount).toBeGreaterThan(0);

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
    }, mp4Base64);
    expect(decodedAudio.channels).toBe(1);
    expect(decodedAudio.duration).toBeCloseTo(5, 1);
    expect(decodedAudio.peak).toBeGreaterThan(0.01);

    await page.getByRole("button", { name: "Remove WAV tone.wav" }).click();
    await expect(audioLane).toHaveCount(0);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("applies one Scene-wide RGB split through scrub, history, reload, and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Scene post effect fixture");
    const canvas = page.locator("[data-studio-canvas]");
    const previewCanvas = canvas.locator("canvas[data-studio-preview-canvas]");
    const playhead = page.getByRole("slider", { name: "Scene playhead" });
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const waitForNewPresentedRevision = async (previous: string) => {
      await expect
        .poll(async () => {
          if ((await canvas.getAttribute("data-preview-renderer")) !== "presented") return null;
          const revision = await canvas.getAttribute("data-preview-revision");
          return revision && revision !== previous ? revision : null;
        })
        .not.toBeNull();
      const revision = await canvas.getAttribute("data-preview-revision");
      if (!revision) throw new Error("The Scene did not expose its presented revision.");
      return revision;
    };
    const blankRevision = await canvas.getAttribute("data-preview-revision");
    if (!blankRevision) throw new Error("The blank Scene did not expose its presented revision.");
    await playhead.fill("1");
    await page.getByRole("button", { exact: true, name: "Add Rectangle" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    const plainRevision = await waitForNewPresentedRevision(blankRevision);
    await playhead.fill("2");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2, 1);
    const plainFrame = await previewCanvas.screenshot();

    await page.getByRole("button", { name: "Add RGB split" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByText("RGB split parameters", { exact: true })).toBeVisible();
    const effectRevision = await waitForNewPresentedRevision(plainRevision);
    const effectFrame = await previewCanvas.screenshot();
    expect(effectFrame.equals(plainFrame)).toBe(false);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("button", { name: "Add RGB split" })).toBeVisible();
    const undoRevision = await waitForNewPresentedRevision(effectRevision);
    await playhead.fill("2");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2, 1);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.getByText("RGB split parameters", { exact: true })).toBeVisible();
    await waitForNewPresentedRevision(undoRevision);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Scene post effect fixture workspace" }).click();
    await expect(page.getByText("RGB split parameters", { exact: true })).toBeVisible();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const reloadedEffectRevision = await canvas.getAttribute("data-preview-revision");
    if (!reloadedEffectRevision) throw new Error("The reloaded RGB split Scene did not expose its revision.");

    await page.getByRole("slider", { name: "RGB split Base offset" }).fill("8");
    await page.getByRole("slider", { name: "RGB split Amplitude" }).fill("12");
    await page
      .getByRole("slider", { name: "RGB split Base offset" })
      .locator("xpath=ancestor::form")
      .getByRole("button", { name: "Update" })
      .click();
    await page.getByRole("button", { name: "Replace program" }).click();
    const updatedEffectRevision = await waitForNewPresentedRevision(reloadedEffectRevision);
    await playhead.fill("2.25");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2.25, 1);
    await playhead.fill("2.75");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2.75, 1);

    const mp4 = await exportLocalMp4(page);
    const stats = await decodedPixelStats(page, mp4, [2.25, 2.75]);
    expect(stats[1]?.commonPixelCountFromPrevious ?? 0).toBeGreaterThan(100);
    expect(stats[1]?.commonColorDifferenceFromPrevious ?? 0).toBeGreaterThan(100);

    await playhead.fill("2");
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByRole("button", { name: "Add RGB split" })).toBeVisible();
    await waitForNewPresentedRevision(updatedEffectRevision);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("authors one project-local WGSL Scene effect through Preview, reload, and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Custom WGSL effect fixture");
    const canvas = page.locator("[data-studio-canvas]");
    const playhead = page.getByRole("slider", { name: "Scene playhead" });
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const waitForNewPresentedRevision = async (previous: string) => {
      await expect
        .poll(async () => {
          if ((await canvas.getAttribute("data-preview-renderer")) !== "presented") return null;
          const revision = await canvas.getAttribute("data-preview-revision");
          return revision && revision !== previous ? revision : null;
        })
        .not.toBeNull();
      const revision = await canvas.getAttribute("data-preview-revision");
      if (!revision) throw new Error("The custom WGSL Scene did not expose its presented revision.");
      return revision;
    };
    const blankRevision = await canvas.getAttribute("data-preview-revision");
    if (!blankRevision) throw new Error("The blank Scene did not expose its presented revision.");

    await playhead.fill("1");
    await page.getByRole("button", { name: /Insert rectangle/ }).click();
    await canvas.click({ position: { x: 360, y: 220 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const plainRevision = await waitForNewPresentedRevision(blankRevision);

    await page.getByRole("button", { name: "Create starter" }).click();
    const source = page.getByRole("textbox", { name: "Scene post-effect WGSL source" });
    await expect(source).toHaveValue(/@binding\(2\)[\s\S]*scene_sampler/u);
    await expect(source).toHaveValue(/textureSample\(scene_texture, scene_sampler/u);
    await source.fill(
      (await source.inputValue()).replace(
        "return textureSample(scene_texture, scene_sampler, coordinate / viewport);",
        `let color = textureSample(scene_texture, scene_sampler, coordinate / viewport);
    let amplitude = clamp(host.parameters_0.x / 64.0, 0.0, 1.0);
    return vec4<f32>(color.rgb * amplitude, color.a);`,
      ),
    );
    await page.getByRole("button", { name: "Compile & accept WGSL" }).click();
    await expect(page.getByText("Ready · generation 1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add to stack" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByText("Custom Scene effect active", { exact: true })).toBeVisible();
    const effectRevision = await waitForNewPresentedRevision(plainRevision);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("button", { name: "Add to stack" })).toBeVisible();
    const undoRevision = await waitForNewPresentedRevision(effectRevision);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.getByText("Custom Scene effect active", { exact: true })).toBeVisible();
    const redoRevision = await waitForNewPresentedRevision(undoRevision);

    await page.getByRole("slider", { name: "Amplitude Scene post-effect parameter" }).fill("20");
    await page.getByRole("button", { name: "Update parameters" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    const parameterRevision = await waitForNewPresentedRevision(redoRevision);

    await page.getByRole("button", { name: /Animate from 0s to/u }).click();
    await page.getByRole("spinbutton", { name: "Amplitude keyframe 2 time" }).fill("2.75");
    await page.getByRole("spinbutton", { name: "Amplitude keyframe 2 value" }).fill("60");
    await page.getByRole("combobox", { name: "Amplitude keyframe 1 easing" }).selectOption("linear");
    await page.getByRole("button", { name: "Update animation" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await waitForNewPresentedRevision(parameterRevision);
    await playhead.fill("2");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2, 1);
    const startPacket = await canvas.getAttribute("data-preview-packet-id");
    await playhead.fill("2.25");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2.25, 1);
    await expect.poll(async () => canvas.getAttribute("data-preview-packet-id")).not.toBe(startPacket);
    const earlyPacket = await canvas.getAttribute("data-preview-packet-id");
    await playhead.fill("2.75");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2.75, 1);
    await expect.poll(async () => canvas.getAttribute("data-preview-packet-id")).not.toBe(earlyPacket);

    await source.fill("@fragment fn broken(");
    await page.getByRole("button", { name: "Compile & accept WGSL" }).click();
    await expect(page.getByText("WGSL was rejected", { exact: true })).toBeVisible();
    await expect(page.getByText("Last accepted generation 1 remains active.", { exact: true })).toBeVisible();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Custom WGSL effect fixture workspace" }).click();
    await expect(page.getByText("Custom Scene effect active", { exact: true })).toBeVisible();
    await expect(page.getByText("WGSL was rejected", { exact: true })).toBeVisible();
    await expect(page.getByText("Amplitude · 2 keyframes", { exact: true })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Amplitude keyframe 2 time" })).toHaveValue("2.75");
    await expect(page.getByRole("spinbutton", { name: "Amplitude keyframe 2 value" })).toHaveValue("60");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const mp4 = await exportLocalMp4(page);
    const stats = await decodedPixelStats(page, mp4, [2, 2.75]);
    expect(stats[0]?.count ?? 0).toBeGreaterThan(100);
    expect(stats[1]?.count ?? 0).toBeGreaterThan(100);
    expect(stats[1]?.commonPixelCountFromPrevious ?? 0).toBeGreaterThan(100);
    expect(
      (stats[1]?.commonColorDifferenceFromPrevious ?? 0) / (stats[1]?.commonPixelCountFromPrevious || 1),
    ).toBeGreaterThan(8);

    const activeRevision = await canvas.getAttribute("data-preview-revision");
    if (!activeRevision) throw new Error("The exported custom WGSL Scene did not expose its revision.");
    await page.getByRole("button", { name: "Remove animation" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    const staticRevision = await waitForNewPresentedRevision(activeRevision);
    await page.getByRole("button", { name: "Remove Wave Distortion effect from stack" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByRole("button", { name: "Add to stack" })).toBeVisible();
    await waitForNewPresentedRevision(staticRevision);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("stacks and reorders named WGSL and GLSL Scene effects through Preview, history, reload, and MP4", async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Custom GLSL effect fixture");
    const canvas = page.locator("[data-studio-canvas]");
    const playhead = page.getByRole("slider", { name: "Scene playhead" });
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const waitForNewPresentedRevision = async (previous: string) => {
      await expect
        .poll(async () => {
          if ((await canvas.getAttribute("data-preview-renderer")) !== "presented") return null;
          const revision = await canvas.getAttribute("data-preview-revision");
          return revision && revision !== previous ? revision : null;
        })
        .not.toBeNull();
      const revision = await canvas.getAttribute("data-preview-revision");
      if (!revision) throw new Error("The custom GLSL Scene did not expose its presented revision.");
      return revision;
    };
    const blankRevision = await canvas.getAttribute("data-preview-revision");
    if (!blankRevision) throw new Error("The blank Scene did not expose its presented revision.");

    await playhead.fill("1");
    await page.getByRole("button", { name: /Insert rectangle/ }).click();
    await canvas.click({ position: { x: 360, y: 220 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const plainRevision = await waitForNewPresentedRevision(blankRevision);

    await page.getByRole("textbox", { name: "New Scene effect name" }).fill("WGSL Wave");
    await page.getByRole("button", { name: "Create starter" }).click();
    await page.getByRole("button", { name: "Compile & accept WGSL" }).click();
    await expect(page.getByText("Ready · generation 1", { exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "New Scene effect name" }).fill("GLSL Pulse");
    await page.getByRole("button", { name: "Add effect" }).click();
    await expect(page.getByRole("button", { name: /Edit Scene effect WGSL Wave/u })).toBeVisible();
    await page.getByRole("button", { name: /Edit Scene effect GLSL Pulse/u }).click();
    await expect(page.getByRole("button", { name: /Edit Scene effect GLSL Pulse/u })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("combobox", { name: "Scene post-effect source language" }).selectOption("glsl");
    const source = page.getByRole("textbox", { name: "Scene post-effect GLSL source" });
    const glsl = `#version 450
layout(location = 0) out vec4 output_color;
layout(set = 0, binding = 0, std140) uniform PoietraHost {
    vec4 viewport_and_time;
    vec4 parameters_0;
    vec4 parameters_1;
} host;
layout(set = 0, binding = 1) uniform texture2D scene_texture;
layout(set = 0, binding = 2) uniform sampler scene_sampler;

void main() {
    vec2 coordinate = gl_FragCoord.xy / max(host.viewport_and_time.xy, vec2(1.0));
    vec4 color = texture(sampler2D(scene_texture, scene_sampler), coordinate);
    float pulse = 0.6 + 0.4 * sin(6.28318530718 * host.viewport_and_time.z * host.parameters_0.z);
    output_color = vec4(color.rgb * pulse, color.a);
}`;
    await source.fill(glsl);
    await page.getByRole("button", { name: "Compile & accept GLSL" }).click();
    await expect(page.getByText("Ready · generation 1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add to stack" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByText("Custom Scene effect active", { exact: true })).toBeVisible();
    const glslRevision = await waitForNewPresentedRevision(plainRevision);

    await page.getByRole("button", { name: /Edit Scene effect WGSL Wave/u }).click();
    await expect(page.getByRole("button", { name: "Add to stack" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Edit Scene effect GLSL Pulse/u })).toContainText("In stack");
    await page.getByRole("button", { name: "Add to stack" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    const wgslRevision = await waitForNewPresentedRevision(glslRevision);
    await expect(page.getByRole("button", { name: /Edit Scene effect WGSL Wave/u })).toContainText("In stack");
    const stack = page.getByRole("list", { name: "Scene effect stack" }).locator("li");
    await expect(stack).toHaveCount(2);
    await expect(stack.nth(0)).toContainText("GLSL Pulse");
    await expect(stack.nth(1)).toContainText("WGSL Wave");

    await page.getByRole("button", { name: "Move WGSL Wave effect up" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    const reorderedRevision = await waitForNewPresentedRevision(wgslRevision);
    await expect(stack.nth(0)).toContainText("WGSL Wave");
    await expect(stack.nth(1)).toContainText("GLSL Pulse");

    await page.getByRole("button", { name: "Undo" }).click();
    const undoRevision = await waitForNewPresentedRevision(reorderedRevision);
    await expect(stack.nth(0)).toContainText("GLSL Pulse");
    await expect(stack.nth(1)).toContainText("WGSL Wave");
    await page.getByRole("button", { name: "Redo" }).click();
    await waitForNewPresentedRevision(undoRevision);
    await expect(stack.nth(0)).toContainText("WGSL Wave");
    await expect(stack.nth(1)).toContainText("GLSL Pulse");

    await playhead.fill("2.25");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2.25, 1);
    const earlyPacket = await canvas.getAttribute("data-preview-packet-id");
    await playhead.fill("2.75");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2.75, 1);
    await expect.poll(async () => canvas.getAttribute("data-preview-packet-id")).not.toBe(earlyPacket);

    await page.getByRole("button", { name: /Edit Scene effect GLSL Pulse/u }).click();
    await source.fill(glsl.replace("void main()", "void main("));
    await page.getByRole("button", { name: "Compile & accept GLSL" }).click();
    await expect(page.getByText("GLSL was rejected", { exact: true })).toBeVisible();
    await expect(page.getByText("Last accepted generation 1 remains active.", { exact: true })).toBeVisible();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Custom GLSL effect fixture workspace" }).click();
    await expect(page.getByText("Custom Scene effect active", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Edit Scene effect WGSL Wave/u })).toBeVisible();
    await expect(page.getByRole("button", { name: /Edit Scene effect WGSL Wave/u })).toContainText("In stack");
    await expect(page.getByRole("button", { name: /Edit Scene effect GLSL Pulse/u })).toContainText("In stack");
    await page.getByRole("button", { name: /Edit Scene effect GLSL Pulse/u }).click();
    await expect(page.getByText("GLSL was rejected", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Scene post-effect source language" })).toHaveValue("glsl");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const mp4 = await exportLocalMp4(page);
    const stats = await decodedPixelStats(page, mp4, [2.25, 2.75]);
    expect(stats[0]?.count ?? 0).toBeGreaterThan(100);
    expect(stats[1]?.count ?? 0).toBeGreaterThan(100);
    expect(stats[1]?.commonPixelCountFromPrevious ?? 0).toBeGreaterThan(100);
    expect(stats[1]?.commonColorDifferenceFromPrevious ?? 0).toBeGreaterThan(100);

    const activeRevision = await canvas.getAttribute("data-preview-revision");
    if (!activeRevision) throw new Error("The exported custom GLSL Scene did not expose its revision.");
    await playhead.fill("2");
    await page.getByRole("button", { name: "Remove GLSL Pulse effect from stack" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    const oneEffectRevision = await waitForNewPresentedRevision(activeRevision);
    await page.getByRole("button", { name: "Remove WGSL Wave effect from stack" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByRole("button", { name: "Add to stack" })).toBeVisible();
    await waitForNewPresentedRevision(oneEffectRevision);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("samples a project PNG from a WGSL Scene effect through Preview, history, reload, and MP4", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Textured Scene effect fixture");
    const canvas = page.locator("[data-studio-canvas]");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const waitForNewPresentedRevision = async (previous: string) => {
      await expect
        .poll(async () => {
          if ((await canvas.getAttribute("data-preview-renderer")) !== "presented") return null;
          const revision = await canvas.getAttribute("data-preview-revision");
          return revision && revision !== previous ? revision : null;
        })
        .not.toBeNull();
      const revision = await canvas.getAttribute("data-preview-revision");
      if (!revision) throw new Error("The textured Scene did not expose its presented revision.");
      return revision;
    };
    const blankRevision = await canvas.getAttribute("data-preview-revision");
    if (!blankRevision) throw new Error("The blank Scene did not expose its presented revision.");
    const emptyCanvas = page.getByRole("region", { name: "Empty canvas" });
    await expect(emptyCanvas).toBeVisible();

    const assets = page.getByRole("region", { name: "Assets" });
    await assets.locator('input[accept="image/png,.png"]').setInputFiles({
      buffer: Buffer.from(PNG),
      mimeType: "image/png",
      name: "effect-texture.png",
    });
    await expect(page.getByRole("list", { name: "Project images" }).getByRole("listitem")).toHaveCount(1);
    // Manifest-only asset ingestion intentionally leaves the visible Scene revision unchanged.
    const assetRevision = blankRevision;
    await page.getByRole("textbox", { name: "New Scene effect name" }).fill("PNG Mix");
    await page.getByRole("button", { name: "Create starter" }).click();
    await page.getByRole("checkbox", { name: "Declare auxiliary Scene effect texture" }).check();
    await page.getByRole("textbox", { name: "Scene post-effect WGSL source" }).fill(`struct ScenePostEffectHost {
    viewport_and_time: vec4<f32>,
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> host: ScenePostEffectHost;
@group(0) @binding(1) var scene_texture: texture_2d<f32>;
@group(0) @binding(2) var scene_sampler: sampler;
@group(0) @binding(3) var project_texture: texture_2d<f32>;
@group(0) @binding(4) var project_sampler: sampler;

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let viewport = max(host.viewport_and_time.xy, vec2<f32>(1.0));
    return textureSample(project_texture, project_sampler, position.xy / viewport);
}`);
    await page.getByRole("button", { name: "Compile & accept WGSL" }).click();
    await expect(page.getByText("Ready · generation 1", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Auxiliary Scene effect image" }).selectOption({ index: 1 });
    await page.getByRole("combobox", { name: "Auxiliary Scene effect sampler" }).selectOption("nearest");
    await page.getByRole("button", { name: "Add to stack" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByText("Custom Scene effect active", { exact: true })).toBeVisible();
    const effectRevision = await waitForNewPresentedRevision(assetRevision);
    await expect(emptyCanvas).toHaveCount(0);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("button", { name: "Add to stack" })).toBeVisible();
    const undoRevision = await waitForNewPresentedRevision(effectRevision);
    await expect(emptyCanvas).toBeVisible();
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.getByText("Custom Scene effect active", { exact: true })).toBeVisible();
    await waitForNewPresentedRevision(undoRevision);
    await expect(emptyCanvas).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Textured Scene effect fixture workspace" }).click();
    await expect(page.getByText("Custom Scene effect active", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Auxiliary Scene effect sampler" })).toHaveValue("nearest");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(emptyCanvas).toHaveCount(0);

    const mp4 = await exportLocalMp4(page);
    const [redPixels] = await decodedBrightPixelCounts(page, mp4, [1], "red-dominant");
    expect(redPixels).toBeGreaterThan(100);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("downloads a bounded Manim Scene from Studio-native authoring", async ({ page }) => {
  page.setDefaultTimeout(15_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Native source export fixture");
    const canvas = page.locator("[data-studio-canvas]");
    await expect(page.getByRole("button", { exact: true, name: "Export .py" })).toHaveCount(0);

    await page.getByRole("button", { name: /Insert circle/ }).click();
    await canvas.click({ position: { x: 300, y: 260 } });
    await page.getByRole("button", { name: "Apply program" }).click();

    await page.getByRole("slider", { name: "Scene playhead" }).fill("1");
    await page.getByRole("button", { name: /Insert text/ }).click();
    await page.getByRole("textbox", { name: "Text content" }).fill("Poietra");
    await canvas.click({ position: { x: 520, y: 180 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const textFill = page.getByLabel("Fill color Poietra");
    await textFill.fill("#22c55e");
    await textFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(textFill).toHaveValue("#22c55e");

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
    const textConstructorIndex = source.indexOf('Text("Poietra"');
    const textFillIndex = source.indexOf('.set_fill("#22c55e", opacity=1)', textConstructorIndex);
    const textFadeIndex = source.indexOf("FadeIn(", textFillIndex);
    expect(textConstructorIndex).toBeGreaterThanOrEqual(0);
    expect(textFillIndex).toBeGreaterThan(textConstructorIndex);
    expect(textFadeIndex).toBeGreaterThan(textFillIndex);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("keeps Studio-native duration authoring through creation, reload, and Manim source export", async ({ page }) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(15_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Native duration authoring fixture");
    const canvas = page.locator("[data-studio-canvas]");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const playhead = page.getByRole("slider", { name: "Scene playhead" });
    const duration = page.getByRole("spinbutton", { name: "Scene duration in seconds" });
    await expect(duration).toHaveValue("5.00");

    await page.getByRole("button", { name: /Insert circle/ }).click();
    await canvas.click({ position: { x: 300, y: 220 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(duration).toHaveValue("5.40");

    await playhead.fill("4");
    await duration.fill("7.4");
    await page.getByRole("button", { name: "Update" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(duration).toHaveValue("7.40");

    await playhead.fill("4");
    await page.getByRole("button", { name: /Insert rectangle/ }).click();
    await canvas.click({ position: { x: 500, y: 280 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(duration).toHaveValue("7.80");
    await expect(
      page.getByText("Later authored content follows the Studio-added wait, so shortening it would cut content."),
    ).toBeVisible();
    await playhead.fill("6.4");
    const rectangle = page.getByRole("button", { name: "Move Rectangle", exact: true });
    await page.getByRole("button", { name: "Set position" }).click();
    await dragBy(page, rectangle, { x: 40, y: -20 });
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Native duration authoring fixture workspace" }).click();
    await expect(page.getByLabel("Current workspace")).toHaveText("Native duration authoring fixture");
    await expect(duration).toHaveValue("7.80");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await playhead.fill("6.4");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(6.4, 1);
    await expect(page.getByRole("button", { name: "Move Circle", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move Rectangle", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Export settings" }).click();
    const sourceExport = page.locator("[data-studio-manim-source-export-state]");
    await expect(sourceExport).toHaveAttribute("data-studio-manim-source-export-state", "ready");
    const downloadPromise = page.waitForEvent("download");
    await sourceExport.getByRole("button", { name: "Download .py" }).click();
    const download = await downloadPromise;
    const path = await download.path();
    if (!path) throw new Error("The Studio-native Python download was not persisted by Playwright.");
    const source = await readFile(path, "utf8");
    const imported = importManimScene(source, "PoietraScene.poietra.py", "PoietraScene", {
      height: 8,
      width: 14.222,
    });
    expect(imported?.runtimeSceneState.duration).toBeCloseTo(7.8, 6);
    expect(source).toContain("Circle(radius=1)");
    expect(source).toContain("Rectangle(width=4, height=2)");
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
    const textFill = page.getByLabel("Fill color Poietra");
    await textFill.fill("#ef4444");
    await textFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await textFill.fill("#22c55e");
    await textFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(textFill).toHaveValue("#22c55e");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select Poietra" }).check();
    await expect(textFill).toHaveValue("#ef4444");
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select Poietra" }).check();
    await expect(textFill).toHaveValue("#22c55e");

    await page.getByRole("slider", { name: "Scene playhead" }).fill("1.8");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(1.8, 1);
    await page.getByRole("button", { name: "Add fill color keyframe for Poietra" }).click();
    await expect(page.locator("[data-paint-color-keyframe]")).toHaveCount(2);
    await page.getByRole("button", { name: "Replace program" }).click();
    const textColorEnd = page.getByRole("button", { name: /Fill color keyframe 2 at/u });
    await textColorEnd.click();
    await page.getByLabel("Fill color keyframe value").fill("#3b82f6");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(textFill).toBeDisabled();
    await page.getByRole("slider", { name: "Scene playhead" }).fill("1");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(1, 1);

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
    await page.getByRole("slider", { name: "Scene playhead" }).fill("2");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(2, 1);

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
    await page.getByRole("button", { name: "Move Poietra", exact: true }).click();
    await expect(page.getByLabel("Fill color Poietra")).toHaveValue("#22c55e");
    await expect(page.getByLabel("Fill color Poietra")).toBeDisabled();
    const restoredTextColorStart = page.getByRole("button", { name: /Fill color keyframe 1 at/u });
    const restoredTextColorEnd = page.getByRole("button", { name: /Fill color keyframe 2 at/u });
    await expect(restoredTextColorEnd).toBeVisible();
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

    const textColorStartTime = await propertyKeyframeTime(restoredTextColorStart);
    const textColorEndTime = await propertyKeyframeTime(restoredTextColorEnd);
    const mp4 = await exportLocalMp4(page);
    const [greenPixels] = await decodedBrightPixelCounts(page, mp4, [textColorStartTime], "green-dominant");
    const [bluePixels] = await decodedBrightPixelCounts(page, mp4, [textColorEndTime + 0.05], "blue-dominant");
    expect(greenPixels).toBeGreaterThan(0);
    expect(bluePixels).toBeGreaterThan(0);

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

test("paints imported SVG and a closed Pen path with WGSL through reload and MP4 export", async ({ page }) => {
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

    await page.getByRole("button", { name: /Pen tool/ }).click();
    for (const position of [
      { x: 60, y: 300 },
      { x: 220, y: 300 },
      { x: 100, y: 200 },
      { x: 180, y: 200 },
    ]) {
      await canvas.click({ position });
    }
    await page.getByRole("button", { name: "Apply program" }).click();
    const pen = page.getByRole("button", { name: "Move CubicBezier", exact: true });
    await pen.click();
    const penId = await pen.getAttribute("data-studio-entity");
    if (!penId) throw new Error("The Pen path did not expose its Studio entity id.");
    await page.getByRole("button", { name: /Extend path/ }).click();
    await canvas.click({ position: { x: 140, y: 260 } });
    await page.getByRole("button", { name: "Replace program" }).click();
    const gradientPreset = page.getByText("Gradient preset").locator("xpath=../..");
    await gradientPreset.getByRole("button", { name: "Create & apply" }).click();
    await expect(page.getByRole("combobox", { name: "Assigned fragment material" })).not.toHaveValue("");
    await expect(page.locator('[data-cubic-bezier-control="segment-2-end"]')).toBeVisible();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(page.getByLabel("Fill color CubicBezier")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Assigned fragment material" })).not.toHaveValue("");

    const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
    const penMaterialParameter = page.getByRole("combobox", { name: "Material parameter for CubicBezier" });
    await penMaterialParameter.selectOption("Angle");
    await scenePlayhead.fill("1.5");
    await page.getByRole("button", { name: "Add Angle material keyframe for CubicBezier" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await scenePlayhead.fill("1.8");
    await page.getByRole("button", { name: "Add Angle material keyframe for CubicBezier" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    let penMaterialEnd = page.getByRole("button", { name: /Material parameter keyframe 2 at/u });
    await penMaterialEnd.click();
    await page.getByLabel("Material parameter keyframe value").fill("-3.1");
    await page.getByRole("button", { name: "Replace program" }).click();
    penMaterialEnd = page.getByRole("button", { name: /Material parameter keyframe 2 at/u });
    await penMaterialEnd.click();
    await page.getByLabel("Material parameter keyframe time").fill("1.9");
    await page.getByRole("button", { name: "Replace program" }).click();
    let penMaterialStart = page.getByRole("button", { name: /Material parameter keyframe 1 at/u });
    await penMaterialStart.click();
    await page.getByRole("combobox", { name: "Material parameter segment easing" }).selectOption("linear");
    await page.getByRole("button", { name: "Replace program" }).click();

    const materializedPenDraw = page.getByRole("button", { name: "Add Draw entrance for CubicBezier" });
    await expect(materializedPenDraw).toHaveAttribute("aria-disabled", "false");
    await materializedPenDraw.click();
    await page.getByRole("button", { name: "Replace program" }).click();
    let penDrawClip = page.getByRole("button", { name: "Edit CubicBezier Draw entrance" });
    await expect(penDrawClip).toBeVisible();
    const penDrawEditRevision = await canvas.getAttribute("data-preview-revision");
    await penDrawClip.click();
    await expect.poll(() => canvas.getAttribute("data-preview-revision")).not.toBe(penDrawEditRevision);
    const penDrawDuration = page.getByRole("spinbutton", { name: "Draw duration for CubicBezier" });
    const penDrawRevision = await canvas.getAttribute("data-preview-revision");
    await penDrawDuration.fill("1.7");
    await penDrawDuration.blur();
    await expect.poll(() => canvas.getAttribute("data-preview-revision")).not.toBe(penDrawRevision);
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    penDrawClip = page.getByRole("button", { name: "Edit CubicBezier Draw entrance" });
    await expect(penDrawClip).toHaveAttribute("title", "Draw 0.40–2.10s · smooth");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open SVG path fixture workspace" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(page.getByLabel("Fill color CubicBezier")).toHaveCount(0);
    const penMaterial = page.getByRole("combobox", { name: "Assigned fragment material" });
    await expect(penMaterial).not.toHaveValue("");
    penDrawClip = page.getByRole("button", { name: "Edit CubicBezier Draw entrance" });
    await expect(penDrawClip).toHaveAttribute("title", "Draw 0.40–2.10s · smooth");
    penMaterialStart = page.getByRole("button", { name: /Material parameter keyframe 1 at/u });
    penMaterialEnd = page.getByRole("button", { name: /Material parameter keyframe 2 at/u });
    await expect(penMaterialStart).toBeVisible();
    await expect(penMaterialEnd).toBeVisible();
    const penMaterialStartTime = await propertyKeyframeTime(penMaterialStart);
    const penMaterialEndTime = await propertyKeyframeTime(penMaterialEnd);
    const [canvasBounds, penBounds] = await Promise.all([
      canvas.boundingBox(),
      page.locator(`[data-studio-entity-wrapper="${penId}"]`).boundingBox(),
    ]);
    if (!canvasBounds || !penBounds) throw new Error("The Pen bounds were unavailable for MP4 color evidence.");
    const penRegion = {
      bottom: Math.min(1, (penBounds.y + penBounds.height - canvasBounds.y) / canvasBounds.height + 0.02),
      left: Math.max(0, (penBounds.x - canvasBounds.x) / canvasBounds.width - 0.02),
      right: Math.min(1, (penBounds.x + penBounds.width - canvasBounds.x) / canvasBounds.width + 0.02),
      top: Math.max(0, (penBounds.y - canvasBounds.y) / canvasBounds.height - 0.02),
    };
    const openPenMp4 = await exportLocalMp4(page);
    const openPenStats = await decodedPixelStats(
      page,
      openPenMp4,
      [0.35, penMaterialStartTime + 0.05, penMaterialEndTime - 0.05, 2.15],
      "bright",
      penRegion,
    );
    const openPenPixels = openPenStats.map(({ count }) => count);
    expect(openPenPixels[1] ?? 0).toBeGreaterThan((openPenPixels[0] ?? 0) + 20);
    expect(openPenPixels[2] ?? 0).toBeGreaterThan((openPenPixels[1] ?? 0) + 20);
    expect(openPenPixels[3] ?? 0).toBeGreaterThan((openPenPixels[2] ?? 0) + 20);
    const overlapEnd = openPenStats[2];
    expect(overlapEnd?.commonPixelCountFromPrevious ?? 0).toBeGreaterThan(20);
    expect(
      (overlapEnd?.commonColorDifferenceFromPrevious ?? 0) / (overlapEnd?.commonPixelCountFromPrevious || 1),
    ).toBeGreaterThan(8);

    await penMaterialEnd.click();
    await page.getByRole("button", { name: "Delete keyframe" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    penMaterialStart = page.getByRole("button", { name: /Material parameter keyframe 1 at/u });
    await penMaterialStart.click();
    await page.getByRole("button", { name: "Delete keyframe" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.locator('[data-property-keyframe="material"]')).toHaveCount(0);
    await penDrawClip.click();
    await page.getByRole("button", { name: "Remove Draw" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(penDrawClip).toHaveCount(0);
    await page.getByRole("button", { name: "Close path" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Replace program" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(page.getByLabel("Fill color CubicBezier")).toHaveValue("#ffffff");
    await page.getByRole("button", { name: "Reopen path" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Replace program" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(page.getByLabel("Fill color CubicBezier")).toHaveCount(0);

    await page.getByRole("button", { name: "Close path" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await page.getByRole("button", { name: "Reopen path" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Replace program" }).click();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open SVG path fixture workspace" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(page.getByLabel("Fill color CubicBezier")).toHaveCount(0);
    await page.getByRole("button", { name: "Close path" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    const restoredPenFill = page.getByLabel("Fill color CubicBezier");
    await expect(restoredPenFill).toHaveValue("#ffffff");
    await restoredPenFill.fill("#f97316");
    await restoredPenFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();

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
    await page.getByRole("button", { name: "Move CubicBezier", exact: true }).click();
    await expect(page.getByLabel("Fill color CubicBezier")).toHaveValue("#f97316");
    await expect(penMaterial).not.toHaveValue("");
    await expect(page.locator(`[data-studio-entity="${penId}"]`)).toBeVisible();
    await penMaterial.selectOption("");
    await expect(penMaterial).toHaveValue("");
    await page.getByRole("slider", { name: "Scene playhead" }).fill("1.8");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(1.8, 1);
    await page.getByRole("button", { name: "Add fill color keyframe for CubicBezier" }).click();
    await expect(page.locator("[data-paint-color-keyframe]")).toHaveCount(2);
    await page.getByRole("button", { name: "Replace program" }).click();
    const penFillEnd = page.getByRole("button", { name: /Fill color keyframe 2 at/u });
    await penFillEnd.click();
    await page.getByLabel("Fill color keyframe value").fill("#3b82f6");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByLabel("Fill color CubicBezier")).toBeDisabled();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open SVG path fixture workspace" }).click();
    await page.getByRole("button", { name: "Move CubicBezier", exact: true }).click();
    const restoredPenFillStart = page.getByRole("button", { name: /Fill color keyframe 1 at/u });
    const restoredPenFillEnd = page.getByRole("button", { name: /Fill color keyframe 2 at/u });
    await expect(restoredPenFillEnd).toBeVisible();
    await expect(page.getByLabel("Fill color CubicBezier")).toHaveValue("#f97316");
    await expect(page.getByLabel("Fill color CubicBezier")).toBeDisabled();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const penFillStartTime = await propertyKeyframeTime(restoredPenFillStart);
    const penFillEndTime = await propertyKeyframeTime(restoredPenFillEnd);
    const mp4 = await exportLocalMp4(page);
    const [paintedPixels = 0] = await decodedBrightPixelCounts(page, mp4, [penFillStartTime]);
    const [orangePixels = 0] = await decodedBrightPixelCounts(page, mp4, [penFillStartTime], "red-dominant");
    const [bluePixels = 0] = await decodedBrightPixelCounts(page, mp4, [penFillEndTime + 0.05], "blue-dominant");
    expect(paintedPixels).toBeGreaterThan(100);
    expect(orangePixels).toBeGreaterThan(0);
    expect(bluePixels).toBeGreaterThan(0);
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

    const lineStroke = page.getByLabel("Stroke color Line");
    await expect(page.getByLabel("Fill color Line")).toHaveCount(0);
    await lineStroke.fill("#22c55e");
    await lineStroke.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(lineStroke).toHaveValue("#22c55e");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(lineStroke).toHaveValue("#ffffff");
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(lineStroke).toHaveValue("#22c55e");

    const thinMp4 = await exportLocalMp4(page);
    const [thinStrokePixels = 0] = await decodedBrightPixelCounts(page, thinMp4, [1.6], "green-dominant");
    const lineStrokeWidth = page.getByRole("spinbutton", { name: "Stroke width Line" });
    await expect(lineStrokeWidth).toHaveValue("0.04");
    await lineStrokeWidth.fill("0.08");
    await lineStrokeWidth.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(lineStrokeWidth).toHaveValue("0.08");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(lineStrokeWidth).toHaveValue("0.04");
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(lineStrokeWidth).toHaveValue("0.08");

    const buttMp4 = await exportLocalMp4(page);
    const [buttStrokePixels = 0] = await decodedBrightPixelCounts(page, buttMp4, [1.6], "green-dominant");
    const lineStrokeCap = page.getByRole("combobox", { name: "Stroke cap Line" });
    await expect(lineStrokeCap).toHaveValue("butt");
    await lineStrokeCap.selectOption("round");
    await lineStrokeCap.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(lineStrokeCap).toHaveValue("round");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(lineStrokeCap).toHaveValue("butt");
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(lineStrokeCap).toHaveValue("round");

    const lineDashLength = page.getByRole("spinbutton", { name: "Dash length Line" });
    const lineGapLength = page.getByRole("spinbutton", { name: "Gap length Line" });
    await lineDashLength.fill("0.3");
    await lineGapLength.fill("0.2");
    await page.getByRole("button", { name: "Set dashed stroke" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("button", { name: "Use solid stroke" })).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(page.getByRole("button", { name: "Use solid stroke" })).toHaveCount(0);
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(lineDashLength).toHaveValue("0.3");
    await expect(lineGapLength).toHaveValue("0.2");
    await page.getByRole("button", { name: "Use solid stroke" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(page.getByRole("button", { name: "Use solid stroke" })).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(page.getByRole("button", { name: "Use solid stroke" })).toBeVisible();
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(page.getByRole("button", { name: "Use solid stroke" })).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select Line" }).check();
    await expect(page.getByRole("button", { name: "Use solid stroke" })).toBeVisible();

    await page.getByRole("button", { name: "Add Draw entrance for Line" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.getByRole("button", { name: "Export settings" }).click();
    const sourceExport = page.locator("[data-studio-manim-source-export-state]");
    await expect(sourceExport).toHaveAttribute("data-studio-manim-source-export-state", "ready");
    const sourceDownloadPromise = page.waitForEvent("download");
    await sourceExport.getByRole("button", { name: "Download .py" }).click();
    const sourceDownload = await sourceDownloadPromise;
    const sourcePath = await sourceDownload.path();
    if (!sourcePath) throw new Error("The Line Python download was not persisted by Playwright.");
    const exportedSource = await readFile(sourcePath, "utf8");
    expect(exportedSource).toContain("DashedLine(");
    const strokeStyle = '.set_stroke("#22c55e", width=8)';
    const strokeCapStyle = ".set_cap_style(CapStyleType.ROUND)";
    expect(exportedSource).toContain(strokeStyle);
    expect(exportedSource).toContain(strokeCapStyle);
    expect(exportedSource.indexOf(strokeStyle)).toBeLessThan(exportedSource.indexOf("Create("));
    expect(exportedSource.indexOf(strokeCapStyle)).toBeLessThan(exportedSource.indexOf("Create("));
    await page.getByRole("button", { name: "Close" }).click();

    const wavePreset = page.getByText("Wave preset").locator("xpath=../..");
    await wavePreset.getByRole("button", { name: "Create & apply" }).click();
    await expect(page.getByRole("combobox", { name: "Assigned fragment material" })).not.toHaveValue("");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const linePlayhead = page.getByRole("slider", { name: "Scene playhead" });
    await page.getByRole("combobox", { name: "Material parameter for Line" }).selectOption("Bands");
    await linePlayhead.fill("1.1");
    await page.getByRole("button", { name: "Add Bands material keyframe for Line" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await linePlayhead.fill("1.4");
    await page.getByRole("button", { name: "Add Bands material keyframe for Line" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    let lineMaterialEnd = page.getByRole("button", { name: /Material parameter keyframe 2 at/u });
    await lineMaterialEnd.click();
    await page.getByLabel("Material parameter keyframe value").fill("1");
    await page.getByRole("button", { name: "Replace program" }).click();
    const lineMaterialStart = page.getByRole("button", { name: /Material parameter keyframe 1 at/u });
    await lineMaterialStart.click();
    await page.getByRole("combobox", { name: "Material parameter segment easing" }).selectOption("linear");
    await page.getByRole("button", { name: "Replace program" }).click();

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
    await expect(page.getByLabel("Stroke color Line")).toHaveValue("#22c55e");
    await expect(page.getByRole("combobox", { name: "Stroke cap Line" })).toHaveValue("round");
    await expect(page.getByRole("spinbutton", { name: "Stroke width Line" })).toHaveValue("0.08");
    await expect(page.getByRole("spinbutton", { name: "Dash length Line" })).toHaveValue("0.3");
    await expect(page.getByRole("spinbutton", { name: "Gap length Line" })).toHaveValue("0.2");
    await expect(page.getByRole("button", { name: "Use solid stroke" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Assigned fragment material" })).not.toHaveValue("");
    await expect(page.getByRole("button", { name: /Material parameter keyframe 1 at/u })).toBeVisible();
    lineMaterialEnd = page.getByRole("button", { name: /Material parameter keyframe 2 at/u });
    await lineMaterialEnd.click();
    await expect(page.getByLabel("Material parameter keyframe value")).toHaveValue("1");

    const mp4 = await exportLocalMp4(page);
    const exportedStrokePixels = await decodedBrightPixelCounts(page, mp4, [0.02, 0.75, 1.6], "green-dominant");
    expect(exportedStrokePixels[1] ?? 0).toBeGreaterThan((exportedStrokePixels[0] ?? 0) + 20);
    expect(exportedStrokePixels[2] ?? 0).toBeGreaterThan((exportedStrokePixels[1] ?? 0) * 1.25);
    expect(exportedStrokePixels[2] ?? 0).toBeGreaterThan(thinStrokePixels * 0.75);
    expect(exportedStrokePixels[2] ?? 0).toBeLessThan(buttStrokePixels * 0.9);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("writes Japanese multiline Studio Text through reload and MP4 export", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Text Write fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert text/ }).click();
    await page.getByRole("textbox", { name: "Text content" }).fill("こんにちは\n世界を描こう");
    await canvas.click({ position: { x: 400, y: 220 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const text = page.getByRole("button", { name: /Move こんにちは/ });
    const textId = await text.getAttribute("data-studio-entity");
    if (!textId) throw new Error("The Studio Text did not expose its logical root id.");
    const wrapper = page.locator(`[data-studio-entity-wrapper="${textId}"]`);

    const addWrite = page.getByRole("button", { name: /Add Write entrance for こんにちは/ });
    await expect(addWrite).toHaveAttribute("aria-disabled", "false");
    await addWrite.click();
    await page.getByRole("button", { name: "Replace program" }).click();
    let writeClip = page.locator("[data-write-in-clip]");
    await expect(writeClip).toHaveCount(1);
    await scrubEntranceClip(page, writeClip, 0);
    await expect(wrapper).toHaveCount(0);
    await scrubEntranceClip(page, writeClip, 0.5);
    await expect(wrapper).toHaveCount(1);

    await writeClip.click();
    const duration = page.getByRole("spinbutton", { name: /Write duration for こんにちは/ });
    await expect(duration).toBeEnabled();
    const writeRevision = await canvas.getAttribute("data-preview-revision");
    await duration.press("Control+A");
    await duration.pressSequentially("1.2");
    await duration.press("Enter");
    await expect.poll(() => canvas.getAttribute("data-preview-revision")).not.toBe(writeRevision);
    await expect(duration).toHaveValue("1.2");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.20s · linear");

    await scrubEntranceClip(page, writeClip, 1);
    const transformTarget = page.getByRole("textbox", { name: /Content transform target of/ });
    await transformTarget.fill("大きな未来へ\n進んでいこう");
    await page.getByRole("spinbutton", { name: /Content transform duration of/ }).fill("1");
    await page.getByRole("button", { name: "Create Transform clip" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    let transformClips = page.locator("[data-content-transform-clip]");
    await expect(transformClips).toHaveCount(1);
    await scrubEntranceClip(page, transformClips.first(), 1);

    await transformTarget.fill("光\nひかり");
    await page.getByRole("combobox", { name: /Content transform easing of/ }).selectOption("linear");
    await page.getByRole("button", { name: "Create Transform clip" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    transformClips = page.locator("[data-content-transform-clip]");
    await expect(transformClips).toHaveCount(2);
    let secondTransform = transformClips.nth(1);
    await scrubEntranceClip(page, secondTransform, 1);
    await secondTransform.click();
    const transformDuration = page.getByRole("spinbutton", { name: /Transform duration for/ });
    await transformDuration.fill("0.8");
    await transformDuration.press("Enter");
    await page.getByRole("button", { name: "Replace program" }).click();
    secondTransform = page.locator("[data-content-transform-clip]").nth(1);
    expect(
      (await entranceClipTime(page, secondTransform, 1)) - (await entranceClipTime(page, secondTransform, 0)),
    ).toBeCloseTo(0.8, 1);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Text Write fixture workspace" }).click();
    writeClip = page.locator("[data-write-in-clip]");
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.20s · linear");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    transformClips = page.locator("[data-content-transform-clip]");
    await expect(transformClips).toHaveCount(2);
    const firstTransform = transformClips.nth(0);
    secondTransform = transformClips.nth(1);
    expect(
      (await entranceClipTime(page, secondTransform, 1)) - (await entranceClipTime(page, secondTransform, 0)),
    ).toBeCloseTo(0.8, 1);
    await scrubEntranceClip(page, secondTransform, 1);
    await expect(page.getByRole("button", { name: /Move 光/ })).toHaveAttribute("data-studio-entity", textId);

    const sampleTimes = await Promise.all([
      entranceClipTime(page, writeClip, 0),
      entranceClipTime(page, writeClip, 0.5),
      entranceClipTime(page, writeClip, 1),
      entranceClipTime(page, firstTransform, 0.5),
      entranceClipTime(page, firstTransform, 1),
      entranceClipTime(page, secondTransform, 0.5),
      entranceClipTime(page, secondTransform, 1),
    ]);
    const pixels = await decodedBrightPixelCounts(page, await exportLocalMp4(page), sampleTimes);
    expect((pixels[1] ?? 0) - (pixels[0] ?? 0)).toBeGreaterThan(10);
    expect((pixels[2] ?? 0) - (pixels[1] ?? 0)).toBeGreaterThan(10);
    expect(Math.abs((pixels[3] ?? 0) - (pixels[4] ?? 0))).toBeGreaterThan(10);
    expect(Math.abs((pixels[5] ?? 0) - (pixels[6] ?? 0))).toBeGreaterThan(10);

    await page.getByRole("button", { name: "Undo" }).click();
    secondTransform = page.locator("[data-content-transform-clip]").nth(1);
    await secondTransform.click();
    await page.getByRole("button", { name: "Remove Transform" }).click();
    await expect(page.locator("[data-content-transform-clip]")).toHaveCount(1);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator("[data-content-transform-clip]")).toHaveCount(2);
    await page.getByRole("button", { name: "Undo" }).click();
    const firstTransformAfterDelete = page.locator("[data-content-transform-clip]").first();
    await firstTransformAfterDelete.click();
    await page.getByRole("button", { name: "Remove Transform" }).click();
    await expect(page.locator("[data-content-transform-clip]")).toHaveCount(0);
    writeClip = page.locator("[data-write-in-clip]");
    await writeClip.click();
    await page.getByRole("button", { name: "Remove Write" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.locator("[data-write-in-clip]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Move こんにちは/ })).toBeVisible();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
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

    const equationFill = page.getByLabel("Fill color E = mc^2");
    await expect(page.getByLabel("Stroke color E = mc^2")).toHaveCount(0);
    await equationFill.fill("#22c55e");
    await equationFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(equationFill).toHaveValue("#22c55e");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select E = mc^2" }).check();
    await expect(equationFill).toHaveValue("#ffffff");
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select E = mc^2" }).check();
    await expect(equationFill).toHaveValue("#22c55e");

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

    await page.getByRole("button", { name: "Export settings" }).click();
    const sourceExport = page.locator("[data-studio-manim-source-export-state]");
    await expect(sourceExport).toHaveAttribute("data-studio-manim-source-export-state", "ready");
    const sourceDownloadPromise = page.waitForEvent("download");
    await sourceExport.getByRole("button", { name: "Download .py" }).click();
    const sourceDownload = await sourceDownloadPromise;
    const sourcePath = await sourceDownload.path();
    if (!sourcePath) throw new Error("The MathTex Python download was not persisted by Playwright.");
    const source = await readFile(sourcePath, "utf8");
    const constructorIndex = source.indexOf('MathTex("E = mc^2")');
    const fillIndex = source.indexOf('.set_fill("#22c55e", opacity=1)', constructorIndex);
    const writeIndex = source.indexOf("Write(", fillIndex);
    expect(constructorIndex).toBeGreaterThanOrEqual(0);
    expect(fillIndex).toBeGreaterThan(constructorIndex);
    expect(writeIndex).toBeGreaterThan(fillIndex);
    await page.getByRole("button", { name: "Close" }).click();

    await equationFill.fill("#ffffff");
    await equationFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await expect(page.getByRole("alert")).toContainText("Moved the playhead to the latest safe .py source anchor");
    await equationFill.fill("#ffffff");
    await equationFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    const gradientPreset = page.getByText("Gradient preset").locator("xpath=../..");
    await gradientPreset.getByRole("button", { name: "Create & apply" }).click();
    let equationMaterial = page.getByRole("combobox", { name: "Assigned fragment material" });
    await expect(equationMaterial).not.toHaveValue("");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
    await page.getByRole("combobox", { name: "Material parameter for E = mc^2" }).selectOption("Angle");
    await scenePlayhead.fill("1.6");
    await page.getByRole("button", { name: "Add Angle material keyframe for E = mc^2" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await scenePlayhead.fill("2.1");
    await page.getByRole("button", { name: "Add Angle material keyframe for E = mc^2" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    let equationMaterialEnd = page.getByRole("button", { name: /Material parameter keyframe 2 at/u });
    await equationMaterialEnd.click();
    await page.getByLabel("Material parameter keyframe value").fill("-3.1");
    await page.getByRole("button", { name: "Replace program" }).click();
    let equationMaterialStart = page.getByRole("button", { name: /Material parameter keyframe 1 at/u });
    await equationMaterialStart.click();
    await page.getByRole("combobox", { name: "Material parameter segment easing" }).selectOption("linear");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open MathTex Write fixture workspace" }).click();
    await page.getByRole("checkbox", { name: "Select E = mc^2" }).check();
    writeClip = page.getByRole("button", { name: "Edit E = mc^2 Write entrance" });
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.50s · linear");
    equationMaterial = page.getByRole("combobox", { name: "Assigned fragment material" });
    await expect(equationMaterial).not.toHaveValue("");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    equationMaterialStart = page.getByRole("button", { name: /Material parameter keyframe 1 at/u });
    equationMaterialEnd = page.getByRole("button", { name: /Material parameter keyframe 2 at/u });
    await expect(equationMaterialStart).toBeVisible();
    await expect(equationMaterialEnd).toBeVisible();
    const equationMaterialStartTime = await propertyKeyframeTime(equationMaterialStart);
    const equationMaterialEndTime = await propertyKeyframeTime(equationMaterialEnd);
    await scenePlayhead.fill((equationMaterialStartTime + 0.05).toFixed(2));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await scenePlayhead.fill((equationMaterialEndTime + 0.05).toFixed(2));
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const [canvasBounds, equationBounds] = await Promise.all([canvas.boundingBox(), equationWrapper.boundingBox()]);
    if (!canvasBounds || !equationBounds) throw new Error("The MathTex bounds were unavailable for MP4 evidence.");
    const equationRegion = {
      bottom: Math.min(1, (equationBounds.y + equationBounds.height - canvasBounds.y) / canvasBounds.height + 0.02),
      left: Math.max(0, (equationBounds.x - canvasBounds.x) / canvasBounds.width - 0.02),
      right: Math.min(1, (equationBounds.x + equationBounds.width - canvasBounds.x) / canvasBounds.width + 0.02),
      top: Math.max(0, (equationBounds.y - canvasBounds.y) / canvasBounds.height - 0.02),
    };
    const mp4 = await exportLocalMp4(page);
    const exportedMathTexStats = await decodedPixelStats(
      page,
      mp4,
      [0.02, 0.75, equationMaterialStartTime + 0.05, equationMaterialEndTime + 0.05],
      "bright",
      equationRegion,
    );
    expect(exportedMathTexStats[1]?.count ?? 0).toBeGreaterThan((exportedMathTexStats[0]?.count ?? 0) + 20);
    expect(exportedMathTexStats[2]?.count ?? 0).toBeGreaterThan(exportedMathTexStats[1]?.count ?? 0);
    const changedMaterial = exportedMathTexStats[3];
    expect(changedMaterial?.commonPixelCountFromPrevious ?? 0).toBeGreaterThan(20);
    expect(
      (changedMaterial?.commonColorDifferenceFromPrevious ?? 0) / (changedMaterial?.commonPixelCountFromPrevious || 1),
    ).toBeGreaterThan(8);

    await equationMaterialEnd.click();
    await page.getByRole("button", { name: "Delete keyframe" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    equationMaterialStart = page.getByRole("button", { name: /Material parameter keyframe 1 at/u });
    await equationMaterialStart.click();
    await page.getByRole("button", { name: "Delete keyframe" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.locator('[data-property-keyframe="material"]')).toHaveCount(0);
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.50s · linear");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await equationMaterial.selectOption("");
    await expect(equationMaterial).toHaveValue("");
    await expect(writeClip).toHaveAttribute("title", "Write 0.00–1.50s · linear");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await equationFill.fill("#22c55e");
    await equationFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();

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
    await expect(page.getByLabel("Fill color F = ma")).toHaveValue("#22c55e");
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

test("keeps a material through one Studio MathTex Write and Transform", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "MathTex Write Transform material fixture");
    const canvas = page.locator("[data-studio-canvas]");

    await page.getByRole("button", { name: /Insert equation/ }).click();
    await page.getByRole("textbox", { name: "MathTex" }).fill("E = mc^2");
    await canvas.click({ position: { x: 400, y: 220 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    await page.getByRole("button", { name: "Add Write entrance for E = mc^2" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();

    await page
      .getByText("Gradient preset")
      .locator("xpath=../..")
      .getByRole("button", { name: "Create & apply" })
      .click();
    await expect(page.getByRole("combobox", { name: "Assigned fragment material" })).not.toHaveValue("");
    await page.getByLabel("Cool material color").fill("#0000ff");
    await page.getByLabel("Warm material color").fill("#0000ff");

    await page
      .getByRole("textbox", { name: /Content transform target of/ })
      .fill(String.raw`\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}`);
    await page.getByRole("spinbutton", { name: /Content transform duration of/ }).fill("1");
    await page.getByRole("button", { name: "Create Transform clip" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open MathTex Write Transform material fixture workspace" }).click();
    const writeClip = page.getByRole("button", { name: "Edit E = mc^2 Write entrance" });
    const transformClip = page.locator("[data-content-transform-clip]");
    await expect(writeClip).toBeVisible();
    await expect(transformClip).toHaveCount(1);
    await scrubEntranceClip(page, transformClip, 1);
    await page.getByRole("checkbox", { name: /Select \\nabla/ }).check();
    const material = page.getByRole("combobox", { name: "Assigned fragment material" });
    await expect(material).not.toHaveValue("");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    const sampleTimes = await Promise.all([
      entranceClipTime(page, writeClip, 0),
      entranceClipTime(page, writeClip, 0.5),
      entranceClipTime(page, transformClip, 0.5),
      entranceClipTime(page, transformClip, 1),
    ]);
    const mp4 = await exportLocalMp4(page);
    const pixels = await decodedBrightPixelCounts(page, mp4, sampleTimes);
    const materialPixels = await decodedBrightPixelCounts(
      page,
      mp4,
      [sampleTimes[1]!, sampleTimes[3]!],
      "blue-dominant",
    );
    expect((pixels[1] ?? 0) - (pixels[0] ?? 0)).toBeGreaterThan(10);
    expect(Math.abs((pixels[2] ?? 0) - (pixels[3] ?? 0))).toBeGreaterThan(10);
    expect(materialPixels[0] ?? 0).toBeGreaterThan(0);
    expect(materialPixels[1] ?? 0).toBeGreaterThan(0);

    await material.selectOption("");
    await expect(material).toHaveValue("");
    await expect(writeClip).toBeVisible();
    await expect(transformClip).toHaveCount(1);
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
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

    const equationFill = page.getByLabel("Fill color E = mc^2");
    await equationFill.fill("#ef4444");
    await equationFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(equationFill).toHaveValue("#ef4444");

    const root = page.getByRole("button", { name: "Move E = mc^2", exact: true });
    const rootId = await root.getAttribute("data-studio-entity");
    if (!rootId) throw new Error("The Studio MathTex did not expose its logical root id.");
    const rootWrapper = page.locator(`[data-studio-entity-wrapper="${rootId}"]`);
    await playhead.fill("1");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(1, 1);

    await page.getByRole("button", { name: "Add fill color keyframe for E = mc^2" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    const mathTexColorEnd = page.getByRole("button", { name: "Fill color keyframe 2 at 1.00 seconds" });
    await mathTexColorEnd.click();
    await page.getByLabel("Fill color keyframe value").fill("#22c55e");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(equationFill).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add Write entrance for E = mc^2" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    const target = page.getByRole("textbox", { name: /Content transform target of/ });
    const transformDuration = page.getByRole("spinbutton", { name: /Content transform duration of/ });
    await target.fill(String.raw`\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}`);
    await transformDuration.fill("1");
    await page.getByRole("button", { name: "Create Transform clip" }).click();
    await expect(page.getByRole("button", { name: "Apply program" })).toBeEnabled();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    let transformClips = page.locator("[data-content-transform-clip]");
    await expect(transformClips).toHaveCount(1);
    let firstClip = transformClips.nth(0);
    await scrubEntranceClip(page, firstClip, 1);
    await expect(page.getByRole("checkbox", { name: /Select \\nabla/ })).toHaveCount(1);
    await expect(page.locator("[data-studio-entity-wrapper]")).toHaveCount(1);

    await page.getByRole("textbox", { name: /Content transform target of/ }).fill("E = mc^2");
    await page.getByRole("spinbutton", { name: /Content transform duration of/ }).fill("1");
    await page.getByRole("combobox", { name: /Content transform easing of/ }).selectOption("linear");
    await page.getByRole("button", { name: "Create Transform clip" }).click();
    await expect(page.getByRole("button", { name: "Apply program" })).toBeEnabled();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    transformClips = page.locator("[data-content-transform-clip]");
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
    secondClip = page.locator("[data-content-transform-clip]").nth(1);
    await expect(secondClip).toHaveAttribute("title", / · smooth$/u);
    expect((await entranceClipTime(page, secondClip, 1)) - (await entranceClipTime(page, secondClip, 0))).toBeCloseTo(
      0.8,
      1,
    );

    await page.getByRole("button", { name: "Undo" }).click();
    secondClip = page.locator("[data-content-transform-clip]").nth(1);
    await expect(secondClip).toHaveAttribute("title", / · linear$/u);
    expect((await entranceClipTime(page, secondClip, 1)) - (await entranceClipTime(page, secondClip, 0))).toBeCloseTo(
      1,
      1,
    );
    await page.getByRole("button", { name: "Redo" }).click();
    secondClip = page.locator("[data-content-transform-clip]").nth(1);
    await expect(secondClip).toHaveAttribute("title", / · smooth$/u);
    expect((await entranceClipTime(page, secondClip, 1)) - (await entranceClipTime(page, secondClip, 0))).toBeCloseTo(
      0.8,
      1,
    );
    await page.getByRole("button", { name: "Undo" }).click();

    secondClip = page.locator("[data-content-transform-clip]").nth(1);
    await secondClip.click();
    await page.getByRole("button", { name: "Remove Transform" }).click();
    await expect(page.locator("[data-content-transform-clip]")).toHaveCount(1);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator("[data-content-transform-clip]")).toHaveCount(2);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open MathTex Transform fixture workspace" }).click();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    transformClips = page.locator("[data-content-transform-clip]");
    await expect(transformClips).toHaveCount(2);
    firstClip = transformClips.nth(0);
    secondClip = transformClips.nth(1);
    await expect(page.locator("[data-studio-entity-wrapper]")).toHaveCount(1);
    await scrubEntranceClip(page, secondClip, 1);
    const restoredRoot = page.getByRole("button", { name: "Move E = mc^2", exact: true });
    await expect(restoredRoot).toHaveAttribute("data-studio-entity", rootId);
    await expect(page.getByLabel("Fill color E = mc^2")).toHaveValue("#ef4444");
    await expect(page.getByLabel("Fill color E = mc^2")).toBeDisabled();
    const restoredMathTexColorStart = page.getByRole("button", { name: /Fill color keyframe 1 at/u });
    const restoredMathTexColorEnd = page.getByRole("button", { name: /Fill color keyframe 2 at/u });
    await expect(restoredMathTexColorEnd).toBeVisible();

    const sampleTimes = await Promise.all([
      entranceClipTime(page, firstClip, 0),
      entranceClipTime(page, firstClip, 0.5),
      entranceClipTime(page, firstClip, 1),
      entranceClipTime(page, secondClip, 0.5),
      entranceClipTime(page, secondClip, 1),
    ]);
    const mathTexColorStartTime = await propertyKeyframeTime(restoredMathTexColorStart);
    const mathTexColorEndTime = await propertyKeyframeTime(restoredMathTexColorEnd);
    const mp4 = await exportLocalMp4(page);
    const pixels = await decodedBrightPixelCounts(page, mp4, sampleTimes);
    const [redPixels] = await decodedBrightPixelCounts(page, mp4, [mathTexColorStartTime], "red-dominant");
    const [greenPixels] = await decodedBrightPixelCounts(page, mp4, [mathTexColorEndTime + 0.05], "green-dominant");
    expect(redPixels).toBeGreaterThan(0);
    expect(greenPixels).toBeGreaterThan(0);
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

    const arrowStroke = page.getByLabel("Stroke color Arrow");
    await expect(page.getByLabel("Fill color Arrow")).toHaveCount(0);
    await arrowStroke.fill("#f97316");
    await arrowStroke.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(arrowStroke).toHaveValue("#f97316");

    await page.getByRole("button", { name: "Export settings" }).click();
    const sourceExport = page.locator("[data-studio-manim-source-export-state]");
    await expect(sourceExport).toHaveAttribute("data-studio-manim-source-export-state", "ready");
    const sourceDownloadPromise = page.waitForEvent("download");
    await sourceExport.getByRole("button", { name: "Download .py" }).click();
    const sourceDownload = await sourceDownloadPromise;
    const sourcePath = await sourceDownload.path();
    if (!sourcePath) throw new Error("The Arrow Python download was not persisted by Playwright.");
    expect(await readFile(sourcePath, "utf8")).toContain('.set_stroke("#f97316")');
    await page.getByRole("button", { name: "Close" }).click();

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
    await expect(page.getByLabel("Stroke color Arrow")).toHaveValue("#f97316");
    await scrubMotionClip(page, page.getByRole("button", { name: "Edit Arrow motion clip" }), 0);
    const restoredOrientedStart = await preparedDimensions(restoredArrowWrapper);
    expect(restoredOrientedStart.height).toBeGreaterThan(restoredOrientedStart.width);

    await exportLocalMp4(page);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});

test("uses a multi-segment Pen as an exact object motion path through reload and MP4", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    projectId = await createBlankWorkspace(page, "Pen motion fixture");
    const canvas = page.locator("[data-studio-canvas]");
    const waitForPresentedPreview = () => expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

    await page.getByRole("button", { name: /Insert circle/ }).click();
    await canvas.click({ position: { x: 220, y: 230 } });
    await page.getByRole("button", { name: "Apply program" }).click();
    const circle = page.getByRole("button", { exact: true, name: "Move Circle" });
    const circleFill = page.getByLabel("Fill color Circle");
    await circleFill.fill("#ef4444");
    await circleFill.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();

    await page.getByRole("button", { name: "Pen tool (K)" }).click();
    for (const position of [
      { x: 220, y: 230 },
      { x: 440, y: 150 },
      { x: 260, y: 80 },
      { x: 400, y: 300 },
    ]) {
      await canvas.click({ position });
    }
    await page.getByRole("button", { name: "Apply program" }).click();
    await page.getByRole("button", { exact: true, name: "Move CubicBezier" }).click();
    await page.getByRole("button", { name: /Extend path/ }).click();
    await canvas.click({ position: { x: 520, y: 210 } });
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.locator('[data-cubic-bezier-control="segment-2-end"]')).toBeVisible();

    await page.getByRole("checkbox", { name: "Select Circle" }).check();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await page.getByRole("button", { name: "Create animation" }).click();
    await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("1");
    await page.getByRole("combobox", { name: "Pen motion easing" }).selectOption("linear");
    const usePen = page.getByRole("button", { name: "Use Pen as motion path" });
    await expect(usePen).toBeEnabled();
    await usePen.click();
    const exactPath = page.locator('[data-motion-path-kind="cubic"]');
    await expect(exactPath).toHaveCount(1);
    expect((await exactPath.getAttribute("d"))?.match(/\bC\b/gu)).toHaveLength(2);
    await page.getByRole("button", { name: "Apply program" }).click();

    const motionClip = page.getByRole("button", { name: "Edit Circle motion clip" });
    await expect(motionClip).toBeVisible();
    await scrubMotionClip(page, motionClip, 0);
    const startBox = await circle.boundingBox();
    await scrubMotionClip(page, motionClip, 0.5);
    const middleBox = await circle.boundingBox();
    await scrubMotionClip(page, motionClip, 1);
    const endBox = await circle.boundingBox();
    if (!startBox || !middleBox || !endBox) throw new Error("The Pen-driven Circle was not measurable.");
    expect(Math.hypot(middleBox.x - startBox.x, middleBox.y - startBox.y)).toBeGreaterThan(40);
    expect(Math.hypot(endBox.x - middleBox.x, endBox.y - middleBox.y)).toBeGreaterThan(30);

    await motionClip.click();
    await waitForPresentedPreview();
    await page.getByRole("button", { name: "Delete Circle motion clip" }).click();
    await expect(motionClip).toHaveCount(0);
    await expect(exactPath).toHaveCount(0);
    await page.getByRole("button", { name: "Redo" }).click();
    await waitForPresentedPreview();
    await expect(motionClip).toBeVisible();
    await expect(exactPath).toHaveCount(1);

    await motionClip.click();
    await waitForPresentedPreview();
    await page.getByRole("button", { name: "Adjust Circle motion end" }).press("ArrowRight");
    await expect(page.getByRole("status").filter({ hasText: "Editing Circle motion" })).toContainText("Duration 1.10s");
    await page.getByRole("button", { name: "Replace program" }).click();
    await page.getByRole("button", { name: "Undo" }).click();
    await waitForPresentedPreview();
    await expect(motionClip).toHaveAttribute("title", /1\.00s/u);
    await page.getByRole("button", { name: "Redo" }).click();
    await waitForPresentedPreview();
    await expect(motionClip).toHaveAttribute("title", /1\.10s/u);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Pen motion fixture workspace" }).click();
    await page.getByRole("checkbox", { name: "Select Circle" }).check();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    const restoredClip = page.getByRole("button", { name: "Edit Circle motion clip" });
    await scrubMotionClip(page, restoredClip, 0.5);
    const restoredPath = page.locator('[data-motion-path-kind="cubic"]');
    await expect(restoredPath).toHaveCount(1);
    expect((await restoredPath.getAttribute("d"))?.match(/\bC\b/gu)).toHaveLength(2);

    const sampleTimes = await Promise.all(
      [0.02, 0.5, 0.98].map((progress) => motionClipTime(page, restoredClip, progress)),
    );
    await page.getByRole("button", { name: "Export settings" }).click();
    const sourceExport = page.locator("[data-studio-manim-source-export-state]");
    await expect(sourceExport).toHaveAttribute("data-studio-manim-source-export-state", "unavailable");
    await expect(sourceExport).toContainText(/Pen motion|motion path/u);
    await page.getByRole("button", { exact: true, name: "Close" }).click();

    const mp4 = await exportLocalMp4(page);
    const positions = await decodedPixelStats(page, mp4, sampleTimes, "red-dominant");
    expect(positions.every(({ count }) => count > 20)).toBe(true);
    const [start, middle, end] = positions;
    if (!start || !middle || !end) throw new Error("The Pen motion MP4 did not expose three decoded positions.");
    expect(Math.hypot(middle.x - start.x, middle.y - start.y)).toBeGreaterThan(30);
    expect(Math.hypot(end.x - middle.x, end.y - middle.y)).toBeGreaterThan(20);
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

    const arcStrokeWidth = page.getByRole("spinbutton", { name: "Stroke width Arc" });
    await expect(arcStrokeWidth).toHaveValue("0.04");
    await arcStrokeWidth.fill("0.08");
    await arcStrokeWidth.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(arcStrokeWidth).toHaveValue("0.08");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select Arc" }).check();
    await expect(arcStrokeWidth).toHaveValue("0.04");
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select Arc" }).check();
    await expect(arcStrokeWidth).toHaveValue("0.08");

    const arcStrokeCap = page.getByRole("combobox", { name: "Stroke cap Arc" });
    await expect(arcStrokeCap).toHaveValue("butt");
    await arcStrokeCap.selectOption("round");
    await arcStrokeCap.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
    await expect(arcStrokeCap).toHaveValue("round");
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");

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
    await page.getByRole("checkbox", { name: "Select Arc" }).check();
    await expect(page.getByRole("spinbutton", { name: "Stroke width Arc" })).toHaveValue("0.08");
    await expect(page.getByRole("combobox", { name: "Stroke cap Arc" })).toHaveValue("round");
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

test("authors a connected cubic Bezier path through direct controls, Draw, reload, and MP4 export", async ({
  page,
}) => {
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
    await page.getByRole("button", { name: /Extend path/ }).click();
    await canvas.click({ position: { x: 520, y: 210 } });
    await page.getByRole("button", { name: "Replace program" }).click();
    await waitForPresentedPreview();
    await expect(page.locator('[data-cubic-bezier-control="segment-2-end"]')).toBeVisible();
    for (const [name, delta] of [
      ["start", { x: -8, y: 5 }],
      ["end", { x: 10, y: -6 }],
      ["control1", { x: -6, y: -12 }],
      ["control2", { x: 7, y: 10 }],
      ["segment-2-control1", { x: 5, y: -14 }],
      ["segment-2-control2", { x: -4, y: 12 }],
      ["segment-2-end", { x: 8, y: -5 }],
    ] as const) {
      await dragBy(page, page.locator(`[data-cubic-bezier-control="${name}"]`), delta);
      await page.getByRole("button", { name: "Replace program" }).click();
      await waitForPresentedPreview();
    }

    await page.getByRole("button", { name: "Remove last" }).click();
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(page.locator('[data-cubic-bezier-control="segment-2-end"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(page.locator('[data-cubic-bezier-control="segment-2-end"]')).toBeVisible();
    await page.getByRole("button", { name: "Redo" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(page.locator('[data-cubic-bezier-control="segment-2-end"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(page.locator('[data-cubic-bezier-control="segment-2-end"]')).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Cubic Bezier fixture workspace" }).click();
    await expect(curve).toBeVisible();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    await expect(page.locator('[data-cubic-bezier-control="segment-2-end"]')).toBeVisible();
    await expect(page.getByText("2/8 segments", { exact: true })).toBeVisible();

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
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    const strokeColor = page.getByLabel("Stroke color CubicBezier");
    await strokeColor.fill("#ef4444");
    await strokeColor.locator("xpath=..").getByRole("button", { name: "Set" }).click();
    await page.getByRole("button", { name: "Apply program" }).click();
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

    await page.getByRole("slider", { name: "Scene playhead" }).fill("1.8");
    await expect.poll(async () => Number(await canvas.getAttribute("data-preview-sample-time"))).toBeCloseTo(1.8, 1);
    await page.getByRole("button", { name: "Add stroke color keyframe for CubicBezier" }).click();
    await expect(page.locator("[data-paint-color-keyframe]")).toHaveCount(2);
    await page.getByRole("button", { name: "Replace program" }).click();
    const strokeColorEnd = page.getByRole("button", { name: /Stroke color keyframe 2 at/u });
    await strokeColorEnd.click();
    await page.getByLabel("Stroke color keyframe value").fill("#3b82f6");
    await page.getByRole("button", { name: "Replace program" }).click();
    await expect(strokeColor).toBeDisabled();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Open Cubic Bezier fixture workspace" }).click();
    const restoredCurve = page.getByRole("button", { name: "Move CubicBezier", exact: true });
    await expect(restoredCurve).toBeVisible();
    await page.getByRole("checkbox", { name: "Select CubicBezier" }).check();
    drawClip = page.getByRole("button", { name: "Edit CubicBezier Draw entrance" });
    await expect(drawClip).toBeVisible();
    await expect(canvas).toHaveAttribute("data-preview-renderer", "presented");
    await expect(page.getByLabel("Stroke color CubicBezier")).toHaveValue("#ef4444");
    await expect(page.getByLabel("Stroke color CubicBezier")).toBeDisabled();
    const restoredStrokeColorStart = page.getByRole("button", { name: /Stroke color keyframe 1 at/u });
    const restoredStrokeColorEnd = page.getByRole("button", { name: /Stroke color keyframe 2 at/u });
    await expect(restoredStrokeColorEnd).toBeVisible();

    const mp4 = await exportLocalMp4(page);
    const [brightPixels = 0] = await decodedBrightPixelCounts(page, mp4, [1]);
    const strokeColorStartTime = await propertyKeyframeTime(restoredStrokeColorStart);
    const strokeColorEndTime = await propertyKeyframeTime(restoredStrokeColorEnd);
    const [redPixels = 0] = await decodedBrightPixelCounts(page, mp4, [strokeColorStartTime], "red-dominant");
    const [bluePixels = 0] = await decodedBrightPixelCounts(page, mp4, [strokeColorEndTime + 0.05], "blue-dominant");
    expect(brightPixels).toBeGreaterThan(50);
    expect(redPixels).toBeGreaterThan(0);
    expect(bluePixels).toBeGreaterThan(0);
  } finally {
    if (projectId) await cleanupFixtureWorkspace(page.request, { projectId });
  }
});
