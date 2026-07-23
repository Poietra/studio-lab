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
