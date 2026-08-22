import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { openWorkspace } from "./workspace";

test("opens and exports at the minimum editor viewport", { tag: "@ci-main" }, async ({ page }) => {
  await openWorkspace(page);

  const viewport = page.viewportSize();
  expect(viewport).toEqual({ height: 640, width: 960 });
  await expect(page.locator("[data-studio-canvas]")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("WebKit did not persist the exported source.");
  await expect(readFile(path, "utf8")).resolves.toContain("class GroupedEquation(Scene)");
});
