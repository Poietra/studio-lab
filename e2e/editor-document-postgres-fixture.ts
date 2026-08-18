import type { Pool } from "pg";

import { createEditorDocumentKeyV1 } from "../server/storage/editor-document-repository";

export type AccountEditorDocumentFixtureV1 = Readonly<{
  additionalOidcSubjects: readonly string[];
  billingOrganizationId: string;
  billingOwnerOidcSubject: string;
  billingOwnerUserId: string;
  documentSceneId: string;
  oidcIssuer: string;
  organizationId: string;
  ownerOidcSubject: string;
  projectId: string;
  sceneId: string;
  sourceHash: string;
  sourcePath: string;
  userId: string;
}>;

function documentKey(fixture: AccountEditorDocumentFixtureV1) {
  return createEditorDocumentKeyV1(fixture.sourcePath, fixture.documentSceneId);
}

function fixtureOrganizationIds(fixture: AccountEditorDocumentFixtureV1) {
  return [fixture.organizationId, fixture.billingOrganizationId] as const;
}

function fixtureOidcSubjects(fixture: AccountEditorDocumentFixtureV1) {
  return [fixture.ownerOidcSubject, fixture.billingOwnerOidcSubject, ...fixture.additionalOidcSubjects] as const;
}

export async function cleanupAccountEditorDocumentFixtureV1(pool: Pool, fixture: AccountEditorDocumentFixtureV1) {
  const key = documentKey(fixture);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The production ledger is deliberately append-only. This dedicated E2E
    // database uses replica mode only while deleting the fixture's exact keys.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM public.account_membership_mutations WHERE organization_id = ANY($1::text[])", [
      fixtureOrganizationIds(fixture),
    ]);
    await client.query(
      "DELETE FROM public.account_organization_bootstrap_mutations WHERE organization_id = ANY($1::text[])",
      [fixtureOrganizationIds(fixture)],
    );
    await client.query(
      `DELETE FROM public.oidc_login_attempts attempt
        WHERE attempt.invitation_token_digest IN (
          SELECT invitation.token_digest
            FROM public.organization_invitations invitation
           WHERE invitation.tenant_id = ANY($1::text[])
        )`,
      [fixtureOrganizationIds(fixture)],
    );
    await client.query(
      `DELETE FROM public.account_sessions
        WHERE active_tenant_id = ANY($1::text[])
           OR user_id IN (
             SELECT user_id FROM public.users
              WHERE oidc_issuer = $2 AND oidc_subject = ANY($3::text[])
           )`,
      [fixtureOrganizationIds(fixture), fixture.oidcIssuer, fixtureOidcSubjects(fixture)],
    );
    await client.query("DELETE FROM public.organization_invitations WHERE tenant_id = ANY($1::text[])", [
      fixtureOrganizationIds(fixture),
    ]);
    const documentValues = [fixture.organizationId, fixture.projectId, key] as const;
    for (const table of [
      "editor_session_snapshots",
      "editor_document_projections",
      "editor_edit_events",
      "editor_documents",
    ]) {
      await client.query(
        `DELETE FROM public.${table}
          WHERE tenant_id = $1 AND project_id = $2 AND document_key = decode($3, 'hex')`,
        [...documentValues],
      );
    }
    await client.query(
      `DELETE FROM public.workspace_source_heads
        WHERE tenant_id = $1 AND project_id = $2 AND source_path = $3`,
      [fixture.organizationId, fixture.projectId, fixture.sourcePath],
    );
    await client.query("DELETE FROM public.source_blob_objects WHERE tenant_id = $1 AND digest = $2", [
      fixture.organizationId,
      fixture.sourceHash,
    ]);
    await client.query("DELETE FROM public.workspace_projects WHERE tenant_id = $1 AND project_id = $2", [
      fixture.organizationId,
      fixture.projectId,
    ]);
    await client.query("DELETE FROM public.organization_memberships WHERE tenant_id = ANY($1::text[])", [
      fixtureOrganizationIds(fixture),
    ]);
    await client.query("DELETE FROM public.organizations WHERE tenant_id = ANY($1::text[])", [
      fixtureOrganizationIds(fixture),
    ]);
    await client.query("DELETE FROM public.workspace_tenants WHERE tenant_id = ANY($1::text[])", [
      fixtureOrganizationIds(fixture),
    ]);
    await client.query(
      `DELETE FROM public.users
        WHERE oidc_issuer = $1 AND oidc_subject = ANY($2::text[])`,
      [fixture.oidcIssuer, fixtureOidcSubjects(fixture)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function prepareAccountEditorDocumentFixtureV1(pool: Pool, fixture: AccountEditorDocumentFixtureV1) {
  await cleanupAccountEditorDocumentFixtureV1(pool, fixture);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1), ($2)", [
      fixture.organizationId,
      fixture.billingOrganizationId,
    ]);
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, $2, $3, 'Ada Lovelace')`,
      [fixture.userId, fixture.oidcIssuer, fixture.ownerOidcSubject],
    );
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, $2, $3, 'Grace Hopper')`,
      [fixture.billingOwnerUserId, fixture.oidcIssuer, fixture.billingOwnerOidcSubject],
    );
    await client.query("INSERT INTO public.organizations (tenant_id, display_name) VALUES ($1, 'Studio Team')", [
      fixture.organizationId,
    ]);
    await client.query("INSERT INTO public.organizations (tenant_id, display_name) VALUES ($1, 'Billing Team')", [
      fixture.billingOrganizationId,
    ]);
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $2::uuid, 'owner')`,
      [fixture.organizationId, fixture.userId],
    );
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $2::uuid, 'owner'), ($1, $3::uuid, 'billing')`,
      [fixture.billingOrganizationId, fixture.billingOwnerUserId, fixture.userId],
    );
    await client.query(
      `INSERT INTO public.workspace_projects (tenant_id, project_id, display_name)
       VALUES ($1, $2, 'Production Demo')`,
      [fixture.organizationId, fixture.projectId],
    );
    await client.query(
      `INSERT INTO public.source_blob_objects
         (tenant_id, digest, object_key, version_id, etag, byte_size)
       VALUES ($1, $2, 'tenants/' || $1 || '/sources/' || $2, 'account-e2e-v1', 'account-e2e-etag', 1)`,
      [fixture.organizationId, fixture.sourceHash],
    );
    await client.query(
      `INSERT INTO public.workspace_source_heads (tenant_id, project_id, source_path, generation, digest)
       VALUES ($1, $2, $3, 1, $4)`,
      [fixture.organizationId, fixture.projectId, fixture.sourcePath, fixture.sourceHash],
    );
    await client.query("COMMIT");
    return fixture;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
