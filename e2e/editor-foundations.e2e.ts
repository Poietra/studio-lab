import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

async function dragBy(page: Page, locator: Locator, delta: Readonly<{ x: number; y: number }>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The object is not visible in the Studio canvas.");
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: 4 });
  await expect(page.locator("[data-motion-preview]")).toHaveCount(1);
  await page.mouse.up();
}

async function exportedSource(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.py$/);
  const path = await download.path();
  if (!path) throw new Error("The exported source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

test("inserts geometry without Magic Edit and exports exact Manim source", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Active project" })).toBeVisible();

  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();
  await expect(exportedSource(page)).resolves.toContain("Circle(radius=1)");

  await page.getByRole("button", { name: "Apply program" }).click();
  await page.keyboard.press("Control+d");
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Move Circle" })).toHaveCount(2);
  const composedSource = await exportedSource(page);
  expect(composedSource.match(/Circle\(radius=1\)/g)).toHaveLength(2);

  await page.getByRole("button", { name: "Apply program" }).click();
  await dragBy(page, page.getByRole("button", { name: "Move Circle" }).nth(1), { x: 30, y: 0 });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByText(/not present at the operation start/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Apply program" }).click();
  const duration = page.getByRole("spinbutton", { name: "Scene duration in seconds" });
  await expect(duration).toHaveValue("14.30");
  await duration.fill("15");
  await page.getByRole("button", { name: "Extend" }).click();
  const extendedComposition = await exportedSource(page);
  expect(extendedComposition.match(/Circle\(radius=1\)/g)).toHaveLength(2);
  expect(extendedComposition).toContain("self.wait(0.7)");
});

test("retains editor sessions while switching Scenes and registered projects", async ({ page }) => {
  await page.goto("/");
  const project = page.getByRole("combobox", { name: "Active project" });
  await expect(project.locator("option")).toHaveCount(2);

  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });
  await page.getByRole("button", { name: "Apply program" }).click();

  const scene = page.getByRole("combobox", { name: "Active imported Scene" });
  await scene.selectOption({ label: "examples/relativity.py · FieldSummary" });
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toHaveCount(0);
  await scene.selectOption({ label: "examples/relativity.py · GroupedEquation" });
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toHaveCount(1);

  const workspaceResponse = page.waitForResponse(/\/api\/manim\/projects\/examples\/workspace$/);
  await project.selectOption("examples");
  await workspaceResponse;

  await expect(project).toHaveValue("examples");
  await expect(page.getByRole("combobox", { name: "Active imported Scene" })).toContainText("relativity.py");

  const returnResponse = page.waitForResponse(/\/api\/manim\/projects\/studio-lab\/workspace$/);
  await project.selectOption("studio-lab");
  await returnResponse;
  await expect(scene).toHaveValue(/GroupedEquation/);
  await expect(page.getByRole("checkbox", { name: "Select Circle" })).toHaveCount(1);
});

test("undo and redo restore an uncommitted draft", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();

  await page.keyboard.press("Control+z");
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();
});

test("previews a motion path, bends it, and exports a Bézier move", async ({ page }) => {
  await page.goto("/");
  const equation = page.getByRole("button", { name: "Move equation" });
  await expect(equation).toBeVisible();
  await page.getByRole("button", { name: "Create animation" }).click();
  await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("6");

  await dragBy(page, equation, { x: 80, y: -30 });
  await expect(page.locator("[data-motion-path]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Adjust motion path/ })).toBeVisible();

  await page.getByRole("spinbutton", { name: "Curve Y" }).fill("-30");
  await expect(page.locator("[data-motion-path]")).toHaveAttribute("d", /Q [^ ]+ [^ ]+ /);
  await expect(exportedSource(page)).resolves.toEqual(expect.stringMatching(/MoveAlongPath\([\s\S]*run_time=6/));
});

test("exports one continuous batch across distinct source anchors", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });
  await page.getByRole("button", { name: "Apply program" }).click();

  await page.getByRole("button", { name: "Move playhead to source anchor 7.000 seconds" }).click();
  await dragBy(page, page.getByRole("button", { name: "Move Circle" }), { x: 45, y: -15 });

  const source = await exportedSource(page);
  expect(source).toContain("Circle(radius=1)");
  expect(source).toMatch(/poietra_studio_insert_[A-Za-z0-9_]+\.animate\.shift\(/);
  expect(source).toContain("# poietra:anchor 5.4");
  expect(source).toContain("# poietra:cursor 7.4");
  expect(source).toContain("# poietra:anchor 8.9");
});

test("extends the Scene duration through an exportable wait", async ({ page }) => {
  await page.goto("/");
  const duration = page.getByRole("spinbutton", { name: "Scene duration in seconds" });
  await expect(duration).toHaveValue("12.00");
  await duration.fill("15");
  await page.getByRole("button", { name: "Extend" }).click();

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Scene duration in seconds" })).toHaveValue("15.00");
  await expect(exportedSource(page)).resolves.toContain("self.wait(3)");
});
