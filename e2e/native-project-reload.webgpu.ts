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

async function preparedDimensions(wrapper: Locator) {
  return wrapper.evaluate((element) => ({
    height: Number((element as HTMLElement).dataset.studioEntityHeight),
    width: Number((element as HTMLElement).dataset.studioEntityWidth),
  }));
}

test("authors Text, shape, spinning motion, and Images in a blank workspace and restores MP4 export", async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  let projectId: string | null = null;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Add workspace" }).click();
    const addDialog = page.getByRole("dialog", { name: "Add workspace" });
    await expect(addDialog.getByRole("radio", { name: /Blank Scene/ })).toBeChecked();
    await addDialog.getByRole("textbox", { name: "Workspace name" }).fill("Native reload fixture");
    const createResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects",
    );
    await addDialog.getByRole("button", { name: "Create workspace" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.request().postDataJSON()).toEqual({ kind: "studio-native", name: "Native reload fixture" });
    projectId = ((await createResponse.json()) as { project: { id: string } }).project.id;

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
    await assets.locator("input[type=file]").setInputFiles([
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
      throw new Error(`The restored native MP4 export was refused: ${reason ?? "unknown"}.`);
    }
    const download = await downloadPromise;
    expect(download).not.toBeNull();
    expect(download!.suggestedFilename()).toMatch(/\.mp4$/u);
    const path = await download!.path();
    if (!path) throw new Error("The restored native MP4 download was not persisted by Playwright.");
    expect((await readFile(path)).byteLength).toBeGreaterThan(0);

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
