import { expect, type Page, test } from "@playwright/test";

import { openWorkspace } from "./workspace";

async function applyCurrentDraft(page: Page) {
  await page.getByRole("button", { name: /^(Apply|Replace) program$/ }).click();
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

test("hides and restores a logical group from before its authoring playhead", { tag: "@manual-authority" }, async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  const canvas = page.locator("[data-studio-canvas]");
  const insertCircle = page.getByRole("button", { name: /Insert circle/ });

  await page.getByRole("button", { name: "Start preview…" }).click();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expect(canvas).toHaveAttribute("data-preview-renderer", "presented", { timeout: 30_000 });
  await expect(insertCircle).toBeEnabled();

  await insertCircle.click();
  await placeOnCanvas(page, 0.2, 0.25);
  await insertCircle.click();
  await placeOnCanvas(page, 0.8, 0.75);
  await applyCurrentDraft(page);

  const circleSelections = page.getByRole("checkbox", { name: "Select Circle", exact: true });
  await expect(circleSelections).toHaveCount(2);
  for (const selection of await circleSelections.all()) {
    if (await selection.isChecked()) await selection.uncheck();
  }
  await circleSelections.nth(0).check();
  await expect(circleSelections.nth(0)).toBeChecked();
  await circleSelections.nth(1).check();
  await expect
    .poll(() => circleSelections.evaluateAll((inputs) => inputs.filter((input) => input.checked).length))
    .toBe(2);
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await applyCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Hide group of 2 objects" })).toBeEnabled();

  await page.getByRole("slider", { name: "Scene playhead" }).fill("0");
  await page.getByRole("button", { name: "Hide group of 2 objects" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await applyCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Move Circle", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show group of 2 objects" })).toBeEnabled();

  await page.keyboard.press("Control+z");
  await expect(page.getByRole("button", { name: "Move Circle", exact: true })).toHaveCount(2);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByRole("button", { name: "Move Circle", exact: true })).toHaveCount(0);
});
