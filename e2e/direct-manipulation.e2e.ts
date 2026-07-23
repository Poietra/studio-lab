import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { openWorkspace } from "./workspace";

async function position(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The object is not visible in the Studio canvas.");
  return { x: box.x, y: box.y };
}

async function dragBy(page: Page, locator: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The object is not visible in the Studio canvas.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y);
  await page.mouse.up();
}

async function exportedSource(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

test("keeps the first object position while moving and applying a second object", async ({ page }) => {
  await openWorkspace(page);
  const equation = page.getByRole("button", { name: "Move equation" });
  const label = page.getByRole("button", { name: "Move label" });
  await expect(equation).toBeVisible();
  await page.getByRole("button", { name: "Set position" }).click();

  const initialEquation = await position(equation);
  const initialLabel = await position(label);
  await dragBy(page, equation, { x: 80, y: 30 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const movedEquation = await position(equation);
  expect(movedEquation.x - initialEquation.x).toBeCloseTo(80, 0);
  expect(movedEquation.y - initialEquation.y).toBeCloseTo(30, 0);

  await dragBy(page, label, { x: -60, y: 20 });
  const appliedPrograms = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Applied programs" }),
  });
  await expect(appliedPrograms.getByRole("listitem")).toHaveCount(1);
  const equationAfterSecondMove = await position(equation);
  const movedLabel = await position(label);
  expect(equationAfterSecondMove.x).toBeCloseTo(movedEquation.x, 1);
  expect(equationAfterSecondMove.y).toBeCloseTo(movedEquation.y, 1);
  expect(movedLabel.x - initialLabel.x).toBeCloseTo(-60, 0);
  expect(movedLabel.y - initialLabel.y).toBeCloseTo(20, 0);

  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(appliedPrograms.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const equationAfterApply = await position(equation);
  const labelAfterApply = await position(label);
  expect(equationAfterApply.x).toBeCloseTo(movedEquation.x, 1);
  expect(equationAfterApply.y).toBeCloseTo(movedEquation.y, 1);
  expect(labelAfterApply.x).toBeCloseTo(movedLabel.x, 1);
  expect(labelAfterApply.y).toBeCloseTo(movedLabel.y, 1);
});

test("snaps direct manipulation to the latest safe source anchor before creating a draft", async ({ page }) => {
  await openWorkspace(page);
  const equation = page.getByRole("button", { name: "Move equation" });
  const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
  await expect(equation).toBeVisible();
  await scenePlayhead.fill("5.6");
  await page.getByRole("button", { name: "Set position" }).click();

  await dragBy(page, equation, { x: 40, y: 20 });
  await expect(scenePlayhead).toHaveValue("5");
  await expect(page.getByRole("alert")).toContainText(
    "Moved the playhead to the latest safe .py source anchor",
  );
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  const anchored = await position(equation);

  await dragBy(page, equation, { x: 40, y: 20 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const afterSafeDrag = await position(equation);
  expect(afterSafeDrag.x - anchored.x).toBeCloseTo(40, 0);
  expect(afterSafeDrag.y - anchored.y).toBeCloseTo(20, 0);
});

test("previews, applies, and undoes a uniform canvas resize", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: /Insert circle/ }).click();
  const canvas = page.locator("[data-studio-canvas]");
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("The Studio canvas is not visible.");
  await canvas.click({ position: { x: 40, y: 60 } });
  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();
  await page.getByRole("button", { name: "Apply program" }).click();
  const scenePlayhead = page.getByRole("slider", { name: "Scene playhead" });
  await scenePlayhead.fill("5.6");
  await page.getByRole("button", { name: "Set position" }).click();

  const circle = page.getByRole("button", { name: "Move Circle" });
  const wrapper = page.locator("[data-studio-entity-wrapper]").filter({ has: circle });
  const handle = page.getByRole("button", { name: "Resize Circle" });
  await expect(handle).toBeVisible();
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.0000");

  const unsafeHandleBox = await handle.boundingBox();
  if (!unsafeHandleBox) throw new Error("The Circle resize handle is not visible.");
  await page.mouse.click(
    unsafeHandleBox.x + unsafeHandleBox.width / 2,
    unsafeHandleBox.y + unsafeHandleBox.height / 2,
  );
  await expect(scenePlayhead).toHaveValue("5.4");
  await expect(page.getByRole("alert")).toContainText(
    "Moved the playhead to the latest safe .py source anchor",
  );
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  const initialBox = await circle.boundingBox();
  const handleBox = await handle.boundingBox();
  if (!initialBox || !handleBox) throw new Error("The Circle resize controls are not visible.");

  const origin = {
    x: handleBox.x + handleBox.width / 2,
    y: handleBox.y + handleBox.height / 2,
  };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 45, origin.y + 35, { steps: 4 });
  await expect.poll(async () => Number(await wrapper.getAttribute("data-studio-entity-scale")))
    .toBeGreaterThan(1.25);
  const previewBox = await circle.boundingBox();
  expect(previewBox?.width ?? 0).toBeGreaterThan(initialBox.width);
  const previewHandleBox = await handle.boundingBox();
  expect(previewHandleBox?.width ?? 0).toBeCloseTo(handleBox.width, 1);
  expect(previewHandleBox?.height ?? 0).toBeCloseTo(handleBox.height, 1);
  await page.mouse.up();

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const committedScale = Number(await wrapper.getAttribute("data-studio-entity-scale"));
  expect(committedScale).toBeGreaterThan(1.25);
  const source = await exportedSource(page);
  expect(source).toContain("# poietra:scale");
  expect(source).toMatch(/\.scale\([0-9.]+\)/);
  expect(source).not.toContain(".animate.scale(");
  expect(source).not.toMatch(/run_time=0(?:\.0+)?[,)]/);
  await page.getByRole("button", { name: "Apply program" }).click();
  await page.keyboard.press("Control+z");
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.0000");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => Number(await wrapper.getAttribute("data-studio-entity-scale")))
    .toBeCloseTo(committedScale, 2);
});
