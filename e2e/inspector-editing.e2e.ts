import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { openWorkspace } from "./workspace";

async function exportedSource(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

test("validates, previews, exports, applies, and undoes an Inspector MathTex and position edit", async ({ page }) => {
  await openWorkspace(page);
  const content = page.getByRole("textbox", { name: "MathTex content of equation" });
  const x = page.getByRole("spinbutton", { name: "X position of equation" });
  const y = page.getByRole("spinbutton", { name: "Y position of equation" });
  await expect(content).toHaveValue("E\n=\nm\nc^2");

  await content.fill(String.raw`\notARealCommand{`);
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("alert")).toContainText("Studio preview cannot parse");
  await expect(content).toBeFocused();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  await content.fill("F\n=\nm\na");
  await x.fill("420");
  await y.fill("160");
  await content.focus();
  await content.press("Control+Enter");

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move equation" })).toContainText("F=ma");
  await expect(page.locator("[data-timeline-animation][title^='content animation']")).toHaveCount(1);
  await expect
    .poll(() => page.locator("[data-timeline-animation][title^='position animation']").count())
    .toBeGreaterThanOrEqual(2);
  const source = await exportedSource(page);
  expect(source).toContain("# poietra:content");
  expect(source).toContain("# poietra:position");
  expect(source).toContain('equation.become(MathTex("F", "=", "m", "a")');
  expect(source).toContain("equation.move_to(");

  await page.getByRole("button", { name: "Discard" }).click();
  await expect(content).toBeFocused();
  await expect(content).toHaveValue("E\n=\nm\nc^2");
  await content.fill("F\n=\nm\na");
  await x.fill("420");
  await y.fill("160");
  await content.focus();
  await content.press("Control+Enter");
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(content).toBeFocused();
  await expect(content).toHaveValue("F\n=\nm\na");
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("checkbox", { name: "Select equation" }).check();
  await expect(page.getByRole("textbox", { name: "MathTex content of equation" })).toHaveValue("E\n=\nm\nc^2");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByRole("textbox", { name: "MathTex content of equation" })).toHaveValue("F\n=\nm\na");
});

test("stages Rectangle position and geometry fields as one ResizeEntity", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: /Insert rectangle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });
  await page.getByRole("button", { name: "Apply program" }).click();
  await page.getByRole("button", { name: "Move playhead to source anchor 7.000 seconds" }).click();

  const x = page.getByRole("spinbutton", { name: "X position of Rectangle" });
  const y = page.getByRole("spinbutton", { name: "Y position of Rectangle" });
  const width = page.getByRole("spinbutton", { name: "Width of Rectangle" });
  const height = page.getByRole("spinbutton", { name: "Height of Rectangle" });
  await x.fill("300");
  await y.fill("200");
  await width.fill("6");
  await height.fill("3");
  await height.press("Enter");

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  const wrapper = page.locator("[data-studio-entity-wrapper]").filter({
    has: page.getByRole("button", { name: "Move Rectangle" }),
  });
  await expect(wrapper).toHaveAttribute("data-studio-entity-width", "6.0000");
  await expect(wrapper).toHaveAttribute("data-studio-entity-height", "3.0000");
  const source = await exportedSource(page);
  expect(source.match(/# poietra:dimensions/g)).toHaveLength(1);
  expect(source).toContain(".stretch_to_fit_width(6)");
  expect(source).toContain(".stretch_to_fit_height(3)");

  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(height).toBeFocused();
  await expect(x).toHaveValue("300.0");
  await expect(y).toHaveValue("200.0");
  await expect(width).toHaveValue("6.00");
  await expect(height).toHaveValue("3.00");
});
