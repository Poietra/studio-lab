import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  type AcceptClientThumbnailPublicationInputV1,
  CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
  CLIENT_THUMBNAIL_PRODUCER_KIND_V1,
  CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1,
  CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1,
  createClientThumbnailArtifactLocatorV1,
} from "./client-thumbnail-contract";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresClientThumbnailRepositoryV1 } from "./postgres/postgres-client-thumbnail-repository";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const TENANT_A = "thumbnail-tenant-a";
const TENANT_B = "thumbnail-tenant-b";
const PROJECT = "thumbnail-project";
const USER_A = "71000000-0000-4000-8000-000000000001";
const USER_B = "71000000-0000-4000-8000-000000000002";
const DOCUMENT_KEY = "a7".repeat(32);
const DOCUMENT_EPOCH = "72000000-0000-4000-8000-000000000001";

async function prepareFixture(pool: Pool) {
  await applyBundledDurableStorageMigrations(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM public.workspace_project_client_thumbnail_heads WHERE tenant_id IN ($1, $2)", [
      TENANT_A,
      TENANT_B,
    ]);
    await client.query("DELETE FROM public.client_thumbnail_publications WHERE tenant_id IN ($1, $2)", [
      TENANT_A,
      TENANT_B,
    ]);
    await client.query("DELETE FROM public.client_thumbnail_artifacts WHERE tenant_id IN ($1, $2)", [
      TENANT_A,
      TENANT_B,
    ]);
    await client.query("DELETE FROM public.editor_documents WHERE tenant_id IN ($1, $2) AND project_id = $3", [
      TENANT_A,
      TENANT_B,
      PROJECT,
    ]);
    await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1), ($2) ON CONFLICT DO NOTHING", [
      TENANT_A,
      TENANT_B,
    ]);
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, 'https://identity.example/', 'thumbnail-a', 'Thumbnail A'),
              ($2::uuid, 'https://identity.example/', 'thumbnail-b', 'Thumbnail B')
       ON CONFLICT DO NOTHING`,
      [USER_A, USER_B],
    );
    await client.query(
      `INSERT INTO public.organizations (tenant_id, display_name)
       VALUES ($1, 'Thumbnail tenant A'), ($2, 'Thumbnail tenant B')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TENANT_B],
    );
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $2::uuid, 'owner'), ($3, $4::uuid, 'owner')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, USER_A, TENANT_B, USER_B],
    );
    await client.query(
      `INSERT INTO public.workspace_projects (tenant_id, project_id, display_name)
       VALUES ($1, $3, 'Thumbnail project A'), ($2, $3, 'Thumbnail project B')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TENANT_B, PROJECT],
    );
    await client.query(
      `INSERT INTO public.editor_documents
         (tenant_id, project_id, document_key, epoch, origin, source_path, source_hash, revision)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, 'studio-native', NULL, NULL, 0)`,
      [TENANT_A, PROJECT, DOCUMENT_KEY, DOCUMENT_EPOCH],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function publicationInput(tenantId = TENANT_A): AcceptClientThumbnailPublicationInputV1 {
  const contentDigest = tenantId === TENANT_A ? "b8".repeat(32) : "c9".repeat(32);
  return {
    artifactId: randomUUID(),
    createdBySubjectId: tenantId === TENANT_A ? USER_A : USER_B,
    lineage: {
      documentEpoch: DOCUMENT_EPOCH,
      documentKey: DOCUMENT_KEY,
      documentRevision: 0n,
      producerKind: CLIENT_THUMBNAIL_PRODUCER_KIND_V1,
      representativeFrameRule: CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1,
      sceneContractVersion: CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1,
      sceneRevisionHash: "da".repeat(32),
    },
    projectId: PROJECT,
    publicationId: randomUUID(),
    receipt: {
      byteSize: 24,
      contentDigest,
      etag: '"thumbnail-test"',
      mediaType: CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
      ...createClientThumbnailArtifactLocatorV1(tenantId, contentDigest),
    },
    tenantId,
  };
}

describe.skipIf(!DATABASE_URL)("PostgreSQL client thumbnail publication authority", () => {
  it("restores the current head while refusing stale revisions and cross-tenant lineage", async () => {
    const setup = new Pool({ connectionString: DATABASE_URL, max: 2 });
    let repository: PostgresClientThumbnailRepositoryV1 | undefined = new PostgresClientThumbnailRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    let restarted: PostgresClientThumbnailRepositoryV1 | undefined;
    try {
      await prepareFixture(setup);
      await expect(repository.ready()).resolves.toBe(true);
      const input = publicationInput();
      await expect(repository.acceptPublication(input)).resolves.toMatchObject({
        kind: "accepted",
        publication: { publicationId: input.publicationId, tenantId: TENANT_A },
        replayed: false,
      });
      await expect(repository.readHead(TENANT_A, PROJECT)).resolves.toMatchObject({
        current: true,
        publication: { publicationId: input.publicationId, tenantId: TENANT_A },
      });

      await repository.close();
      repository = undefined;
      restarted = new PostgresClientThumbnailRepositoryV1({
        poolConfig: { connectionString: DATABASE_URL, max: 2 },
      });
      await expect(restarted.readHead(TENANT_A, PROJECT)).resolves.toMatchObject({
        current: true,
        publication: { publicationId: input.publicationId, tenantId: TENANT_A },
      });
      await expect(restarted.acceptPublication(input)).resolves.toMatchObject({ kind: "accepted", replayed: true });

      const stale = publicationInput();
      await expect(
        restarted.acceptPublication({ ...stale, lineage: { ...stale.lineage, documentRevision: 1n } }),
      ).resolves.toEqual({ kind: "refused", reason: "document-revision-mismatch" });
      await expect(restarted.acceptPublication(publicationInput(TENANT_B))).resolves.toEqual({
        kind: "refused",
        reason: "document-not-found",
      });
      await expect(restarted.readHead(TENANT_B, PROJECT)).resolves.toBeNull();

      await setup.query(
        `UPDATE public.editor_documents SET sealed_at = clock_timestamp()
          WHERE tenant_id = $1 AND project_id = $2 AND document_key = decode($3, 'hex') AND epoch = $4::uuid`,
        [TENANT_A, PROJECT, DOCUMENT_KEY, DOCUMENT_EPOCH],
      );
      await expect(restarted.readHead(TENANT_A, PROJECT)).resolves.toMatchObject({ current: false });
      await expect(restarted.acceptPublication(publicationInput())).resolves.toEqual({
        kind: "refused",
        reason: "document-not-found",
      });
    } finally {
      await Promise.allSettled([repository?.close(), restarted?.close(), setup.end()]);
    }
  });
});
