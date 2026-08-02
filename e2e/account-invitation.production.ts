import { type Browser, expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";

import {
  ACCOUNT_E2E_INVITED_IDENTITY,
  ACCOUNT_E2E_INVITED_USER_ID,
  ACCOUNT_E2E_MISMATCH_IDENTITY,
  ACCOUNT_E2E_STUDIO_ORGANIZATION_ID,
  ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1,
} from "./account-production-fixture";
import {
  cleanupAccountEditorDocumentFixtureV1,
  prepareAccountEditorDocumentFixtureV1,
} from "./editor-document-postgres-fixture";

const databaseUrl = process.env.POIETRA_ACCOUNT_E2E_DATABASE_URL;
if (!databaseUrl) throw new TypeError("The invitation E2E requires its isolated PostgreSQL database.");
const fixturePool = new Pool({ connectionString: databaseUrl, max: 2 });

test.use({ trace: "off" });

test.beforeEach(async () => {
  await prepareAccountEditorDocumentFixtureV1(fixturePool, ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1);
});

test.afterEach(async () => {
  await cleanupAccountEditorDocumentFixtureV1(fixturePool, ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1);
});

test.afterAll(async () => {
  await fixturePool.end();
});

async function signInOwner(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Poietra" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Continue as Ada Lovelace" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
}

async function createInvitation(page: Page, email = ACCOUNT_E2E_INVITED_IDENTITY.verifiedEmail) {
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Role").selectOption("member");
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/account/invitations" &&
      response.request().method() === "POST" &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Create invitation" }).click();
  const response = await responsePromise;
  const token = (await page.getByLabel("Invitation code").textContent())?.trim() ?? "";
  return { cacheControl: response.headers()["cache-control"], token } as const;
}

async function signedOutPage(browser: Browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { height: 900, width: 1_440 } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Poietra" })).toBeVisible();
  return { context, page } as const;
}

test("owner issues once and a separate verified identity joins through native POST and real PostgreSQL", async ({
  browser,
  page,
}) => {
  const observedUrls: string[] = [];
  const consoleMessages: string[] = [];
  page.on("request", (request) => observedUrls.push(request.url()));
  page.on("console", (message) => consoleMessages.push(message.text()));
  await signInOwner(page);
  const created = await createInvitation(page);
  const { token } = created;
  const absentFromUrl = !page.url().includes(token) && observedUrls.every((url) => !url.includes(token));
  const absentFromConsole = consoleMessages.every((message) => !message.includes(token));
  const absentFromStorage = await page.evaluate(
    (secret) =>
      [
        ...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)),
        ...Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)),
      ]
        .filter((key): key is string => key !== null)
        .every(
          (key) =>
            !key.includes(secret) && !(localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? "").includes(secret),
        ),
    token,
  );

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await page.getByRole("button", { name: "Copy invitation code" }).click();
  const copyStatusVisible = await page
    .getByText("Invitation code copied.", { exact: true })
    .waitFor()
    .then(
      () => true,
      () => false,
    );
  const clipboardMatches = await page
    .waitForFunction((secret) => navigator.clipboard.readText().then((value) => value === secret), token)
    .then(
      () => true,
      () => false,
    );
  await page.getByRole("button", { name: "Close invitation form" }).click();
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  expect(created.cacheControl).toBe("private, no-store");
  expect(/^[A-Za-z0-9_-]{43}$/u.test(token)).toBe(true);
  expect(absentFromUrl).toBe(true);
  expect(absentFromConsole).toBe(true);
  expect(absentFromStorage).toBe(true);
  expect(copyStatusVisible).toBe(true);
  expect(clipboardMatches).toBe(true);

  const invited = await signedOutPage(browser);
  try {
    await invited.page.getByLabel("Invitation code").fill(token);
    const startResponsePromise = invited.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/auth/oidc/start" && response.request().method() === "POST",
    );
    await invited.page.getByRole("button", { name: "Accept invitation" }).click();
    const startResponse = await startResponsePromise;
    expect(startResponse.status()).toBe(303);
    expect(startResponse.request().headers()["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(startResponse.request().postData() === `invitationToken=${token}`).toBe(true);
    expect(startResponse.request().url().includes(token)).toBe(false);
    expect(startResponse.headers().location.includes(token)).toBe(false);
    const startCookie = (await startResponse.headerValue("set-cookie")) ?? "";
    expect(startCookie.includes("__Host-poietra_oidc_login=")).toBe(true);
    expect(startCookie.includes("HttpOnly")).toBe(true);
    expect(startCookie.includes("Secure")).toBe(true);
    expect(startCookie.includes("SameSite=Lax")).toBe(true);
    expect(startCookie.includes("Path=/")).toBe(true);
    expect(startCookie.includes("Domain=")).toBe(false);
    const bindingMaxAge = Number(startCookie.match(/Max-Age=(\d+)/u)?.[1] ?? "0");
    expect(bindingMaxAge > 0 && bindingMaxAge <= 600).toBe(true);
    expect(startCookie.includes(token)).toBe(false);
    const binding = (await invited.context.cookies()).find((cookie) => cookie.name === "__Host-poietra_oidc_login");
    expect(binding).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: true });
    expect(binding?.value === token).toBe(false);
    expect(await invited.page.evaluate((secret) => !document.referrer.includes(secret), token)).toBe(true);

    await invited.page.goBack();
    await expect(invited.page.getByRole("heading", { name: "Sign in to Poietra" })).toBeVisible();
    await expect(invited.page.getByLabel("Invitation code")).toHaveValue("");
    await invited.page.getByLabel("Invitation code").fill(token);
    await invited.page.getByRole("button", { name: "Accept invitation" }).click();
    const callbackResponsePromise = invited.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/auth/oidc/callback",
    );
    await invited.page.getByRole("link", { name: "Continue as invited member" }).click();
    const callbackResponse = await callbackResponsePromise;
    expect(callbackResponse.status()).toBe(303);
    const callbackCookies = (await callbackResponse.headerValue("set-cookie")) ?? "";
    expect(callbackCookies.includes("__Host-poietra_session=")).toBe(true);
    expect(callbackCookies.includes("HttpOnly")).toBe(true);
    expect(callbackCookies.includes("Domain=")).toBe(false);
    expect(callbackCookies.includes(token)).toBe(false);

    await expect(invited.page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    await expect(invited.page.getByLabel("Active organization")).toHaveValue(ACCOUNT_E2E_STUDIO_ORGANIZATION_ID);
    await expect(invited.page.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);
    await expect(invited.page.getByRole("button", { name: "Open Production Demo workspace" })).toBeVisible();
    const sessionCookie = (await invited.context.cookies()).find((cookie) => cookie.name === "__Host-poietra_session");
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: true });
    expect((await invited.context.cookies()).some((cookie) => cookie.name === "__Host-poietra_oidc_login")).toBe(false);

    const persisted = await fixturePool.query<{
      invitation_status: string;
      role: string;
      session_count: string;
      user_id: string;
    }>(
      `SELECT account.user_id::text,
              invitation.status AS invitation_status,
              membership.role,
              (SELECT count(*)::text FROM public.account_sessions session
                WHERE session.user_id = account.user_id
                  AND session.revoked_at IS NULL
                  AND session.expires_at > clock_timestamp()) AS session_count
         FROM public.users account
         JOIN public.organization_memberships membership ON membership.user_id = account.user_id
         JOIN public.organization_invitations invitation ON invitation.consumed_by = account.user_id
        WHERE account.oidc_issuer = $1 AND account.oidc_subject = $2 AND membership.tenant_id = $3`,
      [ACCOUNT_E2E_INVITED_IDENTITY.issuer, ACCOUNT_E2E_INVITED_IDENTITY.subject, ACCOUNT_E2E_STUDIO_ORGANIZATION_ID],
    );
    expect(persisted.rows).toEqual([
      {
        invitation_status: "consumed",
        role: "member",
        session_count: "1",
        user_id: ACCOUNT_E2E_INVITED_USER_ID,
      },
    ]);

    const metricsExcludeToken = await invited.page.evaluate(async (secret) => {
      const response = await fetch("/__e2e/account/metrics", { cache: "no-store" });
      return !(await response.text()).includes(secret);
    }, token);
    expect(metricsExcludeToken).toBe(true);

    const forbidden = await invited.page.evaluate(async () => {
      const response = await fetch("/api/account/invitations", {
        body: JSON.stringify({ email: "blocked@example.com", role: "member" }),
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.text(), status: response.status };
    });
    expect(forbidden).toEqual({ body: '{"error":"Account invitation action is not available."}', status: 403 });
    expect(forbidden.body).not.toContain("blocked@example.com");
  } finally {
    await invited.context.close();
  }

  const replay = await signedOutPage(browser);
  try {
    await replay.page.getByLabel("Invitation code").fill(token);
    const responsePromise = replay.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/auth/oidc/start" && response.request().method() === "POST",
    );
    await replay.page.getByRole("button", { name: "Accept invitation" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(403);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers().location).toBeUndefined();
    expect(response.headers()["set-cookie"]).toBeUndefined();
    const body = await response.text();
    expect(body).toBe('{"error":"Account access is not available."}');
    expect(body.includes(token)).toBe(false);
  } finally {
    await replay.context.close();
  }

  const exactRows = await fixturePool.query<{
    invitation_count: string;
    membership_count: string;
    session_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM public.organization_invitations WHERE tenant_id = $1) AS invitation_count,
       (SELECT count(*)::text
          FROM public.organization_memberships membership
          JOIN public.users account ON account.user_id = membership.user_id
         WHERE membership.tenant_id = $1 AND account.oidc_issuer = $2 AND account.oidc_subject = $3) AS membership_count,
       (SELECT count(*)::text
          FROM public.account_sessions session
          JOIN public.users account ON account.user_id = session.user_id
         WHERE account.oidc_issuer = $2 AND account.oidc_subject = $3) AS session_count`,
    [ACCOUNT_E2E_STUDIO_ORGANIZATION_ID, ACCOUNT_E2E_INVITED_IDENTITY.issuer, ACCOUNT_E2E_INVITED_IDENTITY.subject],
  );
  expect(exactRows.rows).toEqual([{ invitation_count: "1", membership_count: "1", session_count: "1" }]);
});

test("a mismatched verified email cannot consume the invitation or receive a session", async ({ browser, page }) => {
  await signInOwner(page);
  const { token } = await createInvitation(page);
  await page.goto("/__e2e/account/metrics");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  const mismatched = await signedOutPage(browser);
  try {
    await mismatched.page.getByLabel("Invitation code").fill(token);
    await mismatched.page.getByRole("button", { name: "Accept invitation" }).click();
    const callbackPromise = mismatched.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/auth/oidc/callback",
    );
    await mismatched.page.getByRole("link", { name: "Continue with mismatched email" }).click();
    const callback = await callbackPromise;
    expect(callback.status()).toBe(403);
    expect(callback.headers()["cache-control"]).toBe("no-store");
    const clearedBinding = (await callback.headerValue("set-cookie")) ?? "";
    expect(clearedBinding.includes("__Host-poietra_oidc_login=;")).toBe(true);
    expect(clearedBinding.includes("Max-Age=0")).toBe(true);
    const body = await callback.text();
    expect(body).toBe('{"error":"Account access is not available."}');
    expect(body.includes(token)).toBe(false);
    expect(body.includes(ACCOUNT_E2E_INVITED_IDENTITY.verifiedEmail)).toBe(false);
    expect((await mismatched.context.cookies()).some((cookie) => cookie.name === "__Host-poietra_session")).toBe(false);

    const evidence = await fixturePool.query<{ invited_user_count: string; status: string }>(
      `SELECT invitation.status,
              (SELECT count(*)::text FROM public.users account
                WHERE account.oidc_issuer = $2 AND account.oidc_subject = $3) AS invited_user_count
         FROM public.organization_invitations invitation
        WHERE invitation.tenant_id = $1`,
      [ACCOUNT_E2E_STUDIO_ORGANIZATION_ID, ACCOUNT_E2E_MISMATCH_IDENTITY.issuer, ACCOUNT_E2E_MISMATCH_IDENTITY.subject],
    );
    expect(evidence.rows).toEqual([{ invited_user_count: "0", status: "pending" }]);
  } finally {
    await mismatched.context.close();
  }
});
