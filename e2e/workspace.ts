import { expect, type Page } from "@playwright/test";

export async function openWorkspace(page: Page, name = "Studio Lab") {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: `Open ${name} workspace` }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText(name);
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
}
