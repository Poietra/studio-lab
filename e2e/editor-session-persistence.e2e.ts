import { expect, test, type Page } from "@playwright/test";

import { openWorkspace } from "./workspace";

const SESSION_STORAGE_KEY = "poietra.studio.editor-sessions";

async function waitForPersistedSession(page: Page) {
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const serialized = localStorage.getItem(key);
        if (!serialized) return 0;
        const value = JSON.parse(serialized) as { entries?: readonly unknown[] };
        return value.entries?.length ?? 0;
      }, SESSION_STORAGE_KEY),
    )
    .toBeGreaterThan(0);
}

async function reopenStudioLabAfterReload(page: Page) {
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Open Studio Lab workspace" }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText("Studio Lab");
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
}

test("restores applied work, a draft, playhead, selection, and preferences after reload", async ({ page }) => {
  await openWorkspace(page);
  const canvas = page.locator("[data-studio-canvas]");

  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvas.click({ position: { x: 180, y: 120 } });
  await page.getByRole("button", { name: "Apply program" }).click();

  await page.getByRole("button", { name: /Insert rectangle/ }).click();
  await canvas.click({ position: { x: 420, y: 220 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();

  await page.getByRole("button", { name: "Create animation" }).click();
  await page.getByRole("spinbutton", { name: "New motion duration in seconds" }).fill("2.4");
  await page.getByRole("button", { name: "Set position" }).click();
  await page.getByRole("slider", { name: "Scene playhead" }).fill("6.2");
  await waitForPersistedSession(page);

  await reopenStudioLabAfterReload(page);

  await expect(page.getByRole("button", { name: "Move Circle" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Rectangle" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Rectangle" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Set position" })).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => Number(await page.getByRole("slider", { name: "Scene playhead" }).inputValue()))
    .toBeCloseTo(6.2, 2);

  await page.getByRole("button", { name: "Create animation" }).click();
  await expect(page.getByRole("spinbutton", { name: "New motion duration in seconds" })).toHaveValue("2.4");
});

test("fails closed with a visible reason when the persisted source hash is stale", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await page.locator("[data-studio-canvas]").click({ position: { x: 180, y: 120 } });
  await page.getByRole("button", { name: "Apply program" }).click();
  await waitForPersistedSession(page);

  await page.route("**/api/manim/projects/studio-lab/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = (await response.json()) as {
      sources: Array<{ scenes: Array<{ sourceHash: string }> }>;
    };
    for (const source of workspace.sources) {
      for (const scene of source.scenes) scene.sourceHash = "b".repeat(64);
    }
    await route.fulfill({ json: workspace, response });
  });

  await reopenStudioLabAfterReload(page);

  await expect(page.getByRole("alert")).toContainText(
    "previous editor session was not restored because this Scene's Python source changed",
  );
  await expect(page.getByRole("button", { name: "Move Circle" })).toHaveCount(0);
});
