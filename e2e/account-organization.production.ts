import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";

import { ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1, ACCOUNT_E2E_STUDIO_ORGANIZATION_ID } from "./account-production-fixture";
import {
  cleanupAccountEditorDocumentFixtureV1,
  prepareAccountEditorDocumentFixtureV1,
} from "./editor-document-postgres-fixture";

const databaseUrl = process.env.POIETRA_ACCOUNT_E2E_DATABASE_URL;
if (!databaseUrl) throw new TypeError("The organization E2E requires its isolated PostgreSQL database.");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const memberId = "a2cc6c70-2dde-43f4-82ad-618c47a5b7f7";
let createdOrganizationId: string | null = null;

test.beforeEach(async () => {
  createdOrganizationId = null;
  await prepareAccountEditorDocumentFixtureV1(pool, ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1);
  await pool.query(
    `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
     VALUES ($1, $2, 'account-e2e-lifecycle-member', 'Katherine Johnson')`,
    [memberId, ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1.oidcIssuer],
  );
  await pool.query(
    `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [ACCOUNT_E2E_STUDIO_ORGANIZATION_ID, memberId],
  );
});

test.afterEach(async () => {
  if (createdOrganizationId) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("DELETE FROM public.account_sessions WHERE active_tenant_id = $1", [createdOrganizationId]);
      await client.query("DELETE FROM public.account_organization_bootstrap_mutations WHERE organization_id = $1", [
        createdOrganizationId,
      ]);
      await client.query("DELETE FROM public.organization_memberships WHERE tenant_id = $1", [createdOrganizationId]);
      await client.query("DELETE FROM public.organizations WHERE tenant_id = $1", [createdOrganizationId]);
      await client.query("DELETE FROM public.workspace_tenants WHERE tenant_id = $1", [createdOrganizationId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  await cleanupAccountEditorDocumentFixtureV1(pool, ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1);
  await pool.query("DELETE FROM public.users WHERE user_id = $1", [memberId]);
});

test.afterAll(async () => {
  await pool.end();
});

async function signInOwner(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Continue as Ada Lovelace" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
}

test("creates an organization and manages member roles from the browser", async ({ page }) => {
  await signInOwner(page);

  await page.getByRole("button", { name: "New organization" }).click();
  await page.getByLabel("Organization name").fill("Research Team");
  const createdResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/account/organizations" &&
      response.request().method() === "POST" &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  const created = (await (await createdResponse).json()) as { organization: { id: string } };
  createdOrganizationId = created.organization.id;
  await expect(page.getByLabel("Active organization")).toHaveValue(createdOrganizationId);

  await page.getByLabel("Active organization").selectOption(ACCOUNT_E2E_STUDIO_ORGANIZATION_ID);
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByText("Katherine Johnson", { exact: true })).toBeVisible();

  const role = page.getByRole("combobox", { name: "Role for Katherine Johnson" });
  const roleResponse = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.endsWith(`/${memberId}`),
  );
  await role.selectOption("admin");
  expect((await roleResponse).status()).toBe(200);
  await expect(role).toHaveValue("admin");

  await expect(page.getByRole("combobox", { name: "Role for Ada Lovelace" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove Ada Lovelace" })).toBeDisabled();

  const removeResponse = page.waitForResponse(
    (response) => response.request().method() === "DELETE" && new URL(response.url()).pathname.endsWith(`/${memberId}`),
  );
  await page.getByRole("button", { name: "Remove Katherine Johnson" }).click();
  expect((await removeResponse).status()).toBe(200);
  await expect(page.getByText("Katherine Johnson", { exact: true })).toHaveCount(0);

  const persisted = await pool.query<{ audit_count: string; owner_count: string; status: string }>(
    `SELECT membership.status,
            (SELECT count(*)::text FROM public.account_membership_mutations
              WHERE organization_id = $1) AS audit_count,
            (SELECT count(*)::text FROM public.organization_memberships
              WHERE tenant_id = $1 AND role = 'owner' AND status = 'active') AS owner_count
       FROM public.organization_memberships membership
      WHERE membership.tenant_id = $1 AND membership.user_id = $2`,
    [ACCOUNT_E2E_STUDIO_ORGANIZATION_ID, memberId],
  );
  expect(persisted.rows).toEqual([{ audit_count: "2", owner_count: "1", status: "suspended" }]);
});
