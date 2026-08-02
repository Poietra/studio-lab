import type { Pool } from "pg";

import { createEditorDocumentKeyV1 } from "../server/storage/editor-document-repository";

export type AccountEditorDocumentFixtureV1 = Readonly<{
  documentSceneId: string;
  organizationId: string;
  projectId: string;
  sceneId: string;
  sourceHash: string;
  sourcePath: string;
  userId: string;
}>;

function documentKey(fixture: AccountEditorDocumentFixtureV1) {
  return createEditorDocumentKeyV1(fixture.sourcePath, fixture.documentSceneId);
}

export async function cleanupAccountEditorDocumentFixtureV1(pool: Pool, fixture: AccountEditorDocumentFixtureV1) {
  const key = documentKey(fixture);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The production ledger is deliberately append-only. This dedicated E2E
    // database uses replica mode only while deleting the fixture's exact keys.
    await client.query("SET LOCAL session_replication_role = replica");
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
    await client.query("DELETE FROM public.organization_memberships WHERE tenant_id = $1 AND user_id = $2::uuid", [
      fixture.organizationId,
      fixture.userId,
    ]);
    await client.query("DELETE FROM public.organizations WHERE tenant_id = $1", [fixture.organizationId]);
    await client.query("DELETE FROM public.workspace_tenants WHERE tenant_id = $1", [fixture.organizationId]);
    await client.query("DELETE FROM public.users WHERE user_id = $1::uuid", [fixture.userId]);
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
    await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1)", [fixture.organizationId]);
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, 'https://identity.e2e.invalid', 'account-e2e-user', 'Ada Lovelace')`,
      [fixture.userId],
    );
    await client.query("INSERT INTO public.organizations (tenant_id, display_name) VALUES ($1, 'Studio Team')", [
      fixture.organizationId,
    ]);
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $2::uuid, 'owner')`,
      [fixture.organizationId, fixture.userId],
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
