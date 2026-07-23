import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { openWorkspace } from "./workspace";

test("opens, creates an object, and exports at the minimum editor viewport", async ({ page }) => {
  await openWorkspace(page);

  const viewport = page.viewportSize();
  expect(viewport).toEqual({ height: 640, width: 960 });
  await expect(page.locator("[data-studio-canvas]")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { exact: true, name: "Magic Edit" }).click();
  await page.getByRole("button", { name: /Insert circle/ }).click();
  const canvas = page.locator("[data-studio-canvas]");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("The Studio canvas is not visible at the minimum viewport.");
  await canvas.click({
    position: {
      x: Math.max(1, bounds.width - 40),
      y: Math.max(1, bounds.height - 40),
    },
  });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("WebKit did not persist the exported source.");
  await expect(readFile(path, "utf8")).resolves.toContain("Circle(radius=1)");
});
