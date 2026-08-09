import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { seedActiveRenderEntitlementFixtureV1 } from "./billing-entitlement-real-test-fixture";
import { immutableProjectPngObjectKeyV1, immutableSourceBlobObjectKeyV1 } from "./immutable-source-png-storage";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresProjectPngRepositoryV1 } from "./postgres/postgres-project-png-repository";
import { PostgresRenderSessionRepositoryV1 } from "./postgres/postgres-render-session-repository";
import { PostgresWorkspaceSourceRepositoryV1 } from "./postgres/postgres-workspace-source-repository";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const TENANT = "tenant-immutable-locator-e2e";
const PROJECT = "project-immutable-locator-e2e";
const REUSE_PROJECT = "project-immutable-locator-reuse-e2e";
const SOURCE_PATH = "main.py";
const GENERATION_A = "123e4567-e89b-42d3-a456-426614174000";
const GENERATION_B = "223e4567-e89b-42d3-a456-426614174001";
const GENERATION_C = "323e4567-e89b-42d3-a456-426614174002";
const GENERATION_D = "423e4567-e89b-42d3-a456-426614174003";
const GENERATION_E = "523e4567-e89b-42d3-a456-426614174004";
const GENERATION_F = "623e4567-e89b-42d3-a456-426614174005";

function sourceReceipt(digest: string, objectGeneration: string, etag = `"source-${digest[0]}"`) {
  return {
    byteSize: 128,
    digest,
    etag,
    objectGeneration,
    objectKey: immutableSourceBlobObjectKeyV1(TENANT, digest, objectGeneration),
  } as const;
}

function pngReceipt(digest: string, objectGeneration: string) {
  return {
    byteSize: 128,
    digest,
    etag: `"png-${digest[0]}"`,
    objectGeneration,
    objectKey: immutableProjectPngObjectKeyV1(TENANT, PROJECT, digest, objectGeneration),
  } as const;
}

describe.skipIf(!DATABASE_URL)("PostgreSQL immutable source and project PNG locators", () => {
  it("persists exact generations through source heads, PNG heads, render pins, and deletion claims", async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const sourceRepository = new PostgresWorkspaceSourceRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    const pngRepository = new PostgresProjectPngRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    const renderRepository = new PostgresRenderSessionRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    const original = sourceReceipt("1".repeat(64), GENERATION_A);
    const originalProjectReuse = sourceReceipt("1".repeat(64), GENERATION_D, '"source-1-project-reuse"');
    const originalCasReuse = sourceReceipt("1".repeat(64), GENERATION_E, '"source-1-cas-reuse"');
    const patched = sourceReceipt("2".repeat(64), GENERATION_B);
    const patchedRenderReuse = sourceReceipt("2".repeat(64), GENERATION_F, '"source-2-render-reuse"');
    const orphanSource = sourceReceipt("3".repeat(64), GENERATION_C);
    const png = pngReceipt("4".repeat(64), GENERATION_A);
    const orphanPng = pngReceipt("5".repeat(64), GENERATION_B);
    try {
      expect(await applyBundledDurableStorageMigrations(pool)).toEqual({ applied: true, version: 29 });
      await sourceRepository.ensureTenant(TENANT);
      await seedActiveRenderEntitlementFixtureV1(pool, TENANT);
      await sourceRepository.createManagedProject({
        name: "Immutable locator proof",
        projectId: PROJECT,
        source: { blob: original, path: SOURCE_PATH },
        tenantId: TENANT,
      });
      const sourceHead = await sourceRepository.readSourceHead(TENANT, PROJECT, SOURCE_PATH);
      expect(sourceHead.blob).toEqual(original);

      await sourceRepository.createManagedProject({
        name: "Canonical locator reuse proof",
        projectId: REUSE_PROJECT,
        source: { blob: originalProjectReuse, path: SOURCE_PATH },
        tenantId: TENANT,
      });
      const reusedProjectHead = await sourceRepository.readSourceHead(TENANT, REUSE_PROJECT, SOURCE_PATH);
      expect(reusedProjectHead).toMatchObject({ blob: original, generation: 1n });
      const reusedCasHead = await sourceRepository.compareAndSwapSource({
        candidate: originalCasReuse,
        expectedDigest: reusedProjectHead.blob.digest,
        expectedGeneration: reusedProjectHead.generation,
        projectId: REUSE_PROJECT,
        sourcePath: SOURCE_PATH,
        tenantId: TENANT,
      });
      expect(reusedCasHead).toMatchObject({ blob: original, generation: 2n });

      const pngHead = await pngRepository.compareAndSwapHead({
        candidate: png,
        expected: null,
        projectId: PROJECT,
        tenantId: TENANT,
      });
      expect(pngHead.receipt).toEqual(png);

      const session = await renderRepository.createSession({
        commitCorrelationKey: "immutable-locator-e2e",
        executionTimeoutMs: 30_000,
        id: randomUUID(),
        originalHead: sourceHead,
        patch: { anchorLine: 1, anchorLines: [1], insertedCode: "self.wait(2)" },
        patchedBlob: patched,
        programBatchId: "batch-immutable-locator-e2e",
        programTransactionId: "transaction-immutable-locator-e2e",
        renderRequestId: "request-immutable-locator-e2e",
        sceneName: "MainScene",
        tenantId: TENANT,
      });
      expect(session.original.blob).toEqual(original);
      expect(session.patched.blob).toEqual(patched);
      expect(session.projectPng).toEqual(pngHead);
      await expect(renderRepository.readSession(TENANT, session.id)).resolves.toMatchObject({
        original: { blob: original },
        patched: { blob: patched },
        projectPng: pngHead,
      });

      const reusedSession = await renderRepository.createSession({
        commitCorrelationKey: "immutable-locator-reuse-e2e",
        executionTimeoutMs: 30_000,
        id: randomUUID(),
        originalHead: sourceHead,
        patch: { anchorLine: 1, anchorLines: [1], insertedCode: "self.wait(3)" },
        patchedBlob: patchedRenderReuse,
        programBatchId: "batch-immutable-locator-reuse-e2e",
        programTransactionId: "transaction-immutable-locator-reuse-e2e",
        renderRequestId: "request-immutable-locator-reuse-e2e",
        sceneName: "MainScene",
        tenantId: TENANT,
      });
      expect(reusedSession.original.blob).toEqual(original);
      expect(reusedSession.patched.blob).toEqual(patched);
      await expect(renderRepository.readSession(TENANT, reusedSession.id)).resolves.toMatchObject({
        original: { blob: original },
        patched: { blob: patched },
      });

      const canonicalObjects = await pool.query<{
        digest: string;
        etag: string;
        object_generation: string;
        object_key: string;
      }>(
        `SELECT digest, object_key, object_generation::text AS object_generation, etag
           FROM public.source_blob_objects
          WHERE tenant_id = $1 AND digest = ANY($2::text[])
          ORDER BY digest`,
        [TENANT, [original.digest, patched.digest]],
      );
      expect(canonicalObjects.rows).toEqual([
        {
          digest: original.digest,
          etag: original.etag,
          object_generation: original.objectGeneration,
          object_key: original.objectKey,
        },
        {
          digest: patched.digest,
          etag: patched.etag,
          object_generation: patched.objectGeneration,
          object_key: patched.objectKey,
        },
      ]);

      await expect(sourceRepository.queueBlobDeletion(TENANT, orphanSource)).resolves.toMatchObject({
        blob: orphanSource,
      });
      await expect(pngRepository.queueDeletion(TENANT, PROJECT, orphanPng, 60_000)).resolves.toMatchObject({
        projectId: PROJECT,
        receipt: orphanPng,
      });

      await expect(
        pool.query(
          `INSERT INTO public.source_blob_objects
             (tenant_id, digest, object_key, version_id, object_generation, etag, byte_size)
           VALUES ($1, $2, $3, $4, $5::uuid, $6, $7)`,
          [
            TENANT,
            "6".repeat(64),
            immutableSourceBlobObjectKeyV1(TENANT, "6".repeat(64), GENERATION_A),
            "ambiguous-version",
            GENERATION_A,
            '"invalid"',
            1,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await Promise.allSettled([sourceRepository.close(), pngRepository.close(), renderRepository.close()]);
      await pool.end();
    }
  }, 30_000);
});
