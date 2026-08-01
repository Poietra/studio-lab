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
const SOURCE_PATH = "main.py";
const GENERATION_A = "123e4567-e89b-42d3-a456-426614174000";
const GENERATION_B = "223e4567-e89b-42d3-a456-426614174001";
const GENERATION_C = "323e4567-e89b-42d3-a456-426614174002";

function sourceReceipt(digest: string, objectGeneration: string) {
  return {
    byteSize: 128,
    digest,
    etag: `"source-${digest[0]}"`,
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
    const patched = sourceReceipt("2".repeat(64), GENERATION_B);
    const orphanSource = sourceReceipt("3".repeat(64), GENERATION_C);
    const png = pngReceipt("4".repeat(64), GENERATION_A);
    const orphanPng = pngReceipt("5".repeat(64), GENERATION_B);
    try {
      expect(await applyBundledDurableStorageMigrations(pool)).toEqual({ applied: true, version: 20 });
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
