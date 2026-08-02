import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import {
  ACCOUNT_E2E_BILLING_ORGANIZATION_ID,
  ACCOUNT_E2E_STUDIO_ORGANIZATION_ID,
  ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1,
} from "./account-production-fixture";
import {
  cleanupAccountEditorDocumentFixtureV1,
  prepareAccountEditorDocumentFixtureV1,
} from "./editor-document-postgres-fixture";

const databaseUrl = process.env.POIETRA_ACCOUNT_E2E_DATABASE_URL;
if (!databaseUrl) throw new TypeError("The account session E2E requires its isolated PostgreSQL database.");
const fixturePool = new Pool({ connectionString: databaseUrl, max: 1 });

test.beforeEach(async () => {
  await prepareAccountEditorDocumentFixtureV1(fixturePool, ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1);
});

test.afterEach(async () => {
  await cleanupAccountEditorDocumentFixtureV1(fixturePool, ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1);
});

test.afterAll(async () => {
  await fixturePool.end();
});

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
  await page.getByRole("link", { name: "Continue as Ada Lovelace" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await expect(page.getByLabel("Active organization")).toHaveValue(ACCOUNT_E2E_STUDIO_ORGANIZATION_ID);
  await expect(page.getByRole("button", { name: "Invite" })).toBeVisible();
  expect(redirectStatuses.get("/auth/oidc/start")).toBe(302);
  expect(redirectStatuses.get("/auth/oidc/callback")).toBe(303);
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
  await page.getByLabel("Active organization").selectOption(ACCOUNT_E2E_BILLING_ORGANIZATION_ID);
  await expect(page.getByRole("heading", { name: "Billing account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);
  const billingInvitationAttempt = await page.evaluate(async () => {
    const response = await fetch("/api/account/invitations", {
      body: JSON.stringify({ email: "blocked@example.com", role: "member" }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { body: await response.text(), status: response.status };
  });
  expect(billingInvitationAttempt).toEqual({
    body: '{"error":"Account invitation action is not available."}',
    status: 403,
  });
  expect(billingInvitationAttempt.body).not.toContain("blocked@example.com");
  await page.getByLabel("Active organization").selectOption(ACCOUNT_E2E_STUDIO_ORGANIZATION_ID);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite", exact: true })).toBeVisible();
  const postSwitchEvidence = await page.evaluate(async () => {
    const response = await fetch("/__e2e/account/metrics", { cache: "no-store" });
    return (await response.json()) as {
      manimRequests: readonly { organizationHeader: string | null }[];
    };
  });
  expect(
    postSwitchEvidence.manimRequests.some(
      ({ organizationHeader }) => organizationHeader === ACCOUNT_E2E_BILLING_ORGANIZATION_ID,
    ),
  ).toBe(false);

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
