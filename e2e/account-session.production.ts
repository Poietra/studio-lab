import { expect, test } from "@playwright/test";

test("signs in, selects a Studio organization, loads cookie-native media, then logs out", async ({ page }) => {
  const redirectStatuses = new Map<string, number>();
  const browserManimRequests: string[] = [];
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname === "/auth/oidc/start" || pathname === "/auth/oidc/callback") {
      redirectStatuses.set(pathname, response.status());
    }
  });
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/manim/")) browserManimRequests.push(pathname);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Poietra" })).toBeVisible();
  expect(browserManimRequests).toEqual([]);

  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Billing account" })).toBeVisible();
  await expect(page.getByLabel("Active organization")).toHaveValue("billing-team");
  expect(redirectStatuses.get("/auth/oidc/start")).toBe(302);
  expect(redirectStatuses.get("/auth/oidc/callback")).toBe(303);
  expect(browserManimRequests).toEqual([]);

  await page.getByLabel("Active organization").selectOption("editor-team");
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Production Demo workspace" })).toBeVisible();
  await expect(page.locator("[data-workspace-card='production-demo'] [data-thumbnail-status]")).toHaveAttribute(
    "data-thumbnail-status",
    "current",
  );
  await expect(page.locator("[data-workspace-actual-thumbnail='production-demo']")).toHaveAttribute(
    "data-state",
    "loaded",
  );

  const evidence = await page.evaluate(async () => {
    const response = await fetch("/__e2e/account/metrics", { cache: "no-store" });
    return (await response.json()) as {
      manimRequests: readonly { method: string; organizationHeader: string | null; pathname: string }[];
    };
  });
  expect(evidence.manimRequests).toContainEqual({
    method: "GET",
    organizationHeader: "editor-team",
    pathname: "/api/manim/projects",
  });
  expect(evidence.manimRequests).toContainEqual({
    method: "GET",
    organizationHeader: "editor-team",
    pathname: "/api/manim/projects/production-demo/thumbnail/status",
  });
  expect(evidence.manimRequests).toContainEqual({
    method: "GET",
    organizationHeader: null,
    pathname: "/api/manim/projects/production-demo/thumbnail",
  });
  expect(evidence.manimRequests.some(({ organizationHeader }) => organizationHeader === "billing-team")).toBe(false);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Poietra" })).toBeVisible();
  await expect
    .poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === "__Host-poietra_session"))
    .toBe(false);
  const activeSessionCount = await page.evaluate(async () => {
    const response = await fetch("/__e2e/account/metrics", { cache: "no-store" });
    return ((await response.json()) as { activeSessionCount: number }).activeSessionCount;
  });
  expect(activeSessionCount).toBe(0);

  const unauthorizedBootstrap = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/account/session" && response.status() === 401,
  );
  await page.reload();
  await unauthorizedBootstrap;
  await expect(page.getByRole("heading", { name: "Sign in to Poietra" })).toBeVisible();
});
