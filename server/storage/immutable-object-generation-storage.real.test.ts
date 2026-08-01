import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { applyBundledDurableStorageMigrations, applyBundledDurableStorageMigrationsThrough } from "./postgres/migrate";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const TENANT = "tenant-a";
const PROJECT = "project-a";
const digest = (character: string) => character.repeat(64);

describe.skipIf(!DATABASE_URL)("PostgreSQL immutable object-generation schema", () => {
  it("keeps legacy locators explicit and constrains every new generation key", async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    const legacySource = digest("a");
    const immutableSource = digest("b");
    const sourceGeneration = randomUUID();
    const invalidMixedGeneration = randomUUID();
    const legacyPngDigest = digest("7");
    const legacyPngKey = `tenants/${TENANT}/projects/${PROJECT}/assets/image.png/${legacyPngDigest}`;
    const pngDigest = digest("c");
    const pngGeneration = randomUUID();
    const snapshotResult = digest("d");
    const snapshotRuntimeConfig = digest("e");
    const snapshotProfile = digest("f");
    const snapshotRuntime = digest("1");
    const snapshotGeneration = randomUUID();
    const artifactDigest = digest("2");
    const artifactRuntime = digest("3");
    const artifactProfile = digest("4");
    const artifactRequest = digest("5");
    const artifactGeneration = randomUUID();
    try {
      await expect(applyBundledDurableStorageMigrationsThrough(pool, 19)).resolves.toEqual({
        applied: true,
        version: 19,
      });
      await pool.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1)", [TENANT]);
      await pool.query(
        "INSERT INTO public.workspace_projects (tenant_id, project_id, display_name) VALUES ($1, $2, 'Project')",
        [TENANT, PROJECT],
      );

      await pool.query(
        `INSERT INTO public.source_blob_objects
           (tenant_id, digest, object_key, version_id, etag, byte_size)
         VALUES ($1, $2, $3, 'provider-version', 'legacy-etag', 0)`,
        [TENANT, legacySource, `tenants/${TENANT}/sources/${legacySource}`],
      );
      await pool.query(
        `INSERT INTO public.workspace_source_heads
           (tenant_id, project_id, source_path, generation, digest)
         VALUES ($1, $2, 'scene.py', 1, $3)`,
        [TENANT, PROJECT, legacySource],
      );
      await pool.query(
        `INSERT INTO public.project_png_objects
           (tenant_id, project_id, digest, object_key, version_id, etag, byte_size)
         VALUES ($1, $2, $3, $4, 'legacy-png-version', 'legacy-png-etag', 1)`,
        [TENANT, PROJECT, legacyPngDigest, legacyPngKey],
      );
      await pool.query(
        `INSERT INTO public.project_png_generations
           (tenant_id, project_id, generation, digest, object_key, version_id)
         VALUES ($1, $2, 1, $3, $4, 'legacy-png-version')`,
        [TENANT, PROJECT, legacyPngDigest, legacyPngKey],
      );
      await pool.query(
        `INSERT INTO public.project_png_heads (tenant_id, project_id, generation, digest)
         VALUES ($1, $2, 1, $3)`,
        [TENANT, PROJECT, legacyPngDigest],
      );

      await expect(applyBundledDurableStorageMigrations(pool)).resolves.toEqual({ applied: true, version: 20 });
      const legacyPng = await pool.query<{
        digest: string;
        object_generation: string | null;
        object_locator_id: string;
        version_id: string | null;
      }>(
        `SELECT object.digest, object.object_locator_id::text, object.object_generation::text, object.version_id
           FROM public.project_png_heads AS head
           JOIN public.project_png_generations AS generation
             ON generation.tenant_id = head.tenant_id
            AND generation.project_id = head.project_id
            AND generation.generation = head.generation
            AND generation.digest = head.digest
           JOIN public.project_png_objects AS object
             ON object.tenant_id = generation.tenant_id
            AND object.project_id = generation.project_id
            AND object.digest = generation.digest
            AND object.object_key = generation.object_key
            AND object.version_id = generation.version_id
          WHERE head.tenant_id = $1 AND head.project_id = $2`,
        [TENANT, PROJECT],
      );
      expect(legacyPng.rows).toEqual([
        {
          digest: legacyPngDigest,
          object_generation: null,
          object_locator_id: expect.stringMatching(/^[1-9][0-9]*$/),
          version_id: "legacy-png-version",
        },
      ]);
      await expect(
        pool.query(
          `INSERT INTO public.project_png_objects
             (tenant_id, project_id, digest, object_key, version_id, etag, byte_size)
           VALUES ($1, $2, $3, $4, 'legacy-png-version', 'legacy-png-etag', 1)
           ON CONFLICT (tenant_id, object_key, version_id) DO NOTHING`,
          [TENANT, PROJECT, legacyPngDigest, legacyPngKey],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });

      await pool.query(
        `INSERT INTO public.source_blob_objects
           (tenant_id, digest, object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1, $2, $3, NULL, $4, 'source-etag', 0)`,
        [
          TENANT,
          immutableSource,
          `tenants/${TENANT}/sources/${immutableSource}/g/${sourceGeneration}`,
          sourceGeneration,
        ],
      );
      await expect(
        pool.query(
          `INSERT INTO public.source_blob_objects
             (tenant_id, digest, object_key, version_id, object_generation, etag, byte_size)
           VALUES ($1, $2, $3, 'provider-version', $4, 'bad-etag', 0)`,
          [
            TENANT,
            digest("6"),
            `tenants/${TENANT}/sources/${digest("6")}/g/${invalidMixedGeneration}`,
            invalidMixedGeneration,
          ],
        ),
      ).rejects.toMatchObject({ constraint: "source_blob_objects_locator_mode_v20" });
      await expect(
        pool.query(
          `INSERT INTO public.source_blob_objects
             (tenant_id, digest, object_key, version_id, object_generation, etag, byte_size)
           VALUES ($1, $2, $3, NULL, '00000000-0000-0000-0000-000000000000', 'bad-etag', 0)`,
          [TENANT, digest("8"), `tenants/${TENANT}/sources/${digest("8")}/g/00000000-0000-0000-0000-000000000000`],
        ),
      ).rejects.toMatchObject({ constraint: "immutable_object_generation_v1_format" });

      const sourceRows = await pool.query<{
        digest: string;
        object_generation: string | null;
        version_id: string | null;
      }>(
        `SELECT digest, object_generation::text, version_id
           FROM public.source_blob_objects
          WHERE tenant_id = $1
          ORDER BY digest`,
        [TENANT],
      );
      expect(sourceRows.rows).toEqual([
        { digest: legacySource, object_generation: null, version_id: "provider-version" },
        { digest: immutableSource, object_generation: sourceGeneration, version_id: null },
      ]);

      const pngKey = `tenants/${TENANT}/projects/${PROJECT}/assets/image.png/${pngDigest}/g/${pngGeneration}`;
      await pool.query(
        `INSERT INTO public.project_png_objects
           (tenant_id, project_id, digest, object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1, $2, $3, $4, NULL, $5, 'png-etag', 1)`,
        [TENANT, PROJECT, pngDigest, pngKey, pngGeneration],
      );
      await pool.query(
        `INSERT INTO public.project_png_generations
           (tenant_id, project_id, generation, digest, object_key, version_id, object_generation)
         VALUES ($1, $2, 2, $3, $4, NULL, $5)`,
        [TENANT, PROJECT, pngDigest, pngKey, pngGeneration],
      );
      await expect(
        pool.query(
          `INSERT INTO public.project_png_generations
             (tenant_id, project_id, generation, digest, object_key, version_id, object_generation)
           VALUES ($1, $2, 3, $3, $4, NULL, $5)`,
          [TENANT, PROJECT, pngDigest, pngKey, randomUUID()],
        ),
      ).rejects.toMatchObject({ constraint: "project_png_generations_immutable_object_fk_v20" });

      const snapshotKey =
        `tenants/${TENANT}/snapshots/${immutableSource}/${snapshotRuntimeConfig}/${snapshotProfile}/` +
        `${snapshotRuntime}/${snapshotResult}/g/${snapshotGeneration}`;
      await pool.query(
        `INSERT INTO public.snapshot_artifact_objects
           (tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest, runtime_digest,
            object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, 'snapshot-etag', 1)`,
        [
          TENANT,
          snapshotResult,
          immutableSource,
          snapshotRuntimeConfig,
          snapshotProfile,
          snapshotRuntime,
          snapshotKey,
          snapshotGeneration,
        ],
      );

      const artifactKey =
        `tenants/${TENANT}/media/video/${immutableSource}/${artifactRuntime}/${artifactProfile}/` +
        `${artifactRequest}/${artifactDigest}/g/${artifactGeneration}`;
      await pool.query(
        `INSERT INTO public.render_artifact_objects
           (tenant_id, artifact_id, artifact_kind, media_type, artifact_digest, source_digest, runtime_digest,
            profile_digest, request_digest, object_key, version_id, object_generation, etag, byte_size, expires_at)
         VALUES ($1, $2, 'video', 'video/mp4', $3, $4, $5, $6, $7, $8, NULL, $9, 'media-etag', 1,
                 clock_timestamp() + interval '1 hour')`,
        [
          TENANT,
          randomUUID(),
          artifactDigest,
          immutableSource,
          artifactRuntime,
          artifactProfile,
          artifactRequest,
          artifactKey,
          artifactGeneration,
        ],
      );

      await pool.query(
        `INSERT INTO public.source_blob_deletions
           (deletion_id, tenant_id, digest, object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1, $2, $3, $4, NULL, $5, 'source-etag', 0)`,
        [
          randomUUID(),
          TENANT,
          immutableSource,
          `tenants/${TENANT}/sources/${immutableSource}/g/${sourceGeneration}`,
          sourceGeneration,
        ],
      );
      await pool.query(
        `INSERT INTO public.project_png_deletions
           (tenant_id, deletion_id, project_id, digest, object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, 'png-etag', 1)`,
        [TENANT, randomUUID(), PROJECT, pngDigest, pngKey, pngGeneration],
      );
      await pool.query(
        `INSERT INTO public.snapshot_artifact_deletions
           (deletion_id, tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest,
            runtime_digest, object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, 'snapshot-etag', 1)`,
        [
          randomUUID(),
          TENANT,
          snapshotResult,
          immutableSource,
          snapshotRuntimeConfig,
          snapshotProfile,
          snapshotRuntime,
          snapshotKey,
          snapshotGeneration,
        ],
      );
      await pool.query(
        `INSERT INTO public.render_artifact_deletions
           (tenant_id, deletion_id, artifact_kind, media_type, artifact_digest, source_digest, runtime_digest,
            profile_digest, request_digest, object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1, $2, 'video', 'video/mp4', $3, $4, $5, $6, $7, $8, NULL, $9, 'media-etag', 1)`,
        [
          TENANT,
          randomUUID(),
          artifactDigest,
          immutableSource,
          artifactRuntime,
          artifactProfile,
          artifactRequest,
          artifactKey,
          artifactGeneration,
        ],
      );

      const immutableRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM (
             SELECT object_generation FROM public.source_blob_deletions
             UNION ALL SELECT object_generation FROM public.project_png_deletions
             UNION ALL SELECT object_generation FROM public.snapshot_artifact_deletions
             UNION ALL SELECT object_generation FROM public.render_artifact_deletions
           ) AS deletion
          WHERE object_generation IS NOT NULL`,
      );
      expect(immutableRows.rows[0]?.count).toBe("4");
    } finally {
      await pool.end();
    }
  });
});
