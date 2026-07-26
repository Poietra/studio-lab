import { expect, test, type Page } from "@playwright/test";

import { openWorkspace } from "./workspace";

const FIXTURE_QUERY = "?previewRenderer=fixture";

async function openWorkspaceWithQuery(page: Page, query: string, name: string) {
  await page.goto(`/${query}`);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: `Open ${name} workspace` }).click();
  await expect(page.getByLabel("Current workspace")).toHaveText(name);
  await expect(page.locator("[data-studio-canvas]")).toBeVisible();
}

test("the retained canvas preview stays off unless explicitly requested", async ({ page }) => {
  await openWorkspace(page);
  await expect(page.locator("[data-studio-canvas]")).toHaveAttribute("data-preview-renderer", "off");
  await expect(page.locator("[data-studio-preview-canvas]")).toHaveCount(0);
  await expect(page.locator("[data-studio-preview-status]")).toHaveCount(0);
});

test("the fixture never correlates with a workspace outside its checked-in harness Scene", async ({ page }) => {
  await openWorkspaceWithQuery(page, FIXTURE_QUERY, "Studio Lab");
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(canvasRoot).toHaveAttribute(
    "data-preview-fallback-reason",
    /snapshot-unavailable|capability-unsupported/,
  );
  await expect(page.locator("[data-studio-preview-status]")).toContainText("Canvas preview fallback");
  await expect(page.locator("[data-studio-semantic-paint='deferred-to-canvas']")).toHaveCount(0);
});

test("the harness opt-in reports a truthful phase and preserves the semantic editor", async ({ page }) => {
  await openWorkspaceWithQuery(page, FIXTURE_QUERY, "Preview Harness");
  const canvasRoot = page.locator("[data-studio-canvas]");
  await expect(page.locator("[data-studio-preview-canvas]")).toHaveCount(1);

  // The host must settle on a truthful phase: a presented, exactly
  // correlated frame, or a whole-Scene fallback that names its reason.
  await expect
    .poll(async () => {
      const phase = await canvasRoot.getAttribute("data-preview-renderer");
      return phase === "presented" || phase === "fallback" ? phase : null;
    })
    .not.toBeNull();
  const status = page.locator("[data-studio-preview-status]");
  await expect(status).toBeVisible();
  await expect(status).toContainText("Canvas preview");
  if ((await canvasRoot.getAttribute("data-preview-renderer")) === "fallback") {
    const reason = await canvasRoot.getAttribute("data-preview-fallback-reason");
    expect(reason).toBeTruthy();
    await expect(status).toContainText("fallback");
  }

  // Semantic DOM and editing operations remain intact under the opt-in, and
  // any Studio edit makes the fixture snapshot uncorrelated by definition.
  await page.getByRole("button", { name: /Insert circle/ }).click();
  await canvasRoot.click({ position: { x: 180, y: 120 } });
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(canvasRoot).toHaveAttribute("data-preview-renderer", "fallback");
  await expect(page.locator("[data-studio-semantic-paint='painted']").first()).toBeVisible();
  await page.getByRole("button", { name: "Apply program" }).click();
  const inserted = page.getByRole("button", { name: "Move Circle", exact: true });
  await inserted.click();
  await expect(inserted).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Timeline playhead" })).toBeVisible();
});
