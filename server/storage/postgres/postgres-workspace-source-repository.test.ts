import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { immutableSourceBlobObjectKeyV1 } from "../immutable-source-png-storage";
import type { SourceBlobReceiptV1 } from "../workspace-source-repository";
import { DURABLE_RETENTION_MIGRATION_V6_CHECKSUM } from "./durable-retention-schema";
import { IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM } from "./immutable-object-generation-schema";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";
import {
  PostgresWorkspaceSourceRepositoryV1,
  WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM,
} from "./postgres-workspace-source-repository";

const TENANT = "tenant-a";
const DIGEST = "a".repeat(64);
const DELETION_ID = "87654321-4321-4321-8321-cba987654321";
const ORPHANED_AT = new Date("2026-01-01T00:00:00.000Z");
const GRACE_MS = 60_000;
const OBJECT_GENERATION = "123e4567-e89b-42d3-a456-426614174000";
const FRESH_OBJECT_GENERATION = "223e4567-e89b-42d3-a456-426614174001";

function receipt(): SourceBlobReceiptV1 {
  return {
    byteSize: 128,
    digest: DIGEST,
    etag: '"etag-a"',
    objectKey: `tenants/${TENANT}/sources/${DIGEST}`,
    versionId: "version-a",
  };
}

function immutableReceipt(objectGeneration = OBJECT_GENERATION, etag = '"etag-immutable"'): SourceBlobReceiptV1 {
  return {
    byteSize: 128,
    digest: DIGEST,
    etag,
    objectGeneration,
    objectKey: immutableSourceBlobObjectKeyV1(TENANT, DIGEST, objectGeneration),
  };
}

function blobRow(overrides: Record<string, unknown> = {}, blob: SourceBlobReceiptV1 = receipt()) {
  return {
    byte_size: blob.byteSize,
    digest: blob.digest,
    etag: blob.etag,
    object_key: blob.objectKey,
    object_generation: "objectGeneration" in blob ? blob.objectGeneration : null,
    tenant_id: TENANT,
    version_id: "versionId" in blob ? blob.versionId : null,
    ...overrides,
  };
}

type QueryResult = Readonly<{ rowCount: number | null; rows: readonly unknown[] }>;

function fakePool(handle: (text: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT set_config(")) {
      return { rowCount: null, rows: [] };
    }
    if (text.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
    return handle(text, values);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
    options: {
      connectionTimeoutMillis: 5_000,
      options: POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    },
  } as unknown as Pool;
  return { pool, query };
}

describe("PostgresWorkspaceSourceRepositoryV1 source retention", () => {
  it("requires workspace, retention, and immutable-locator schema migrations", async () => {
    const fixture = fakePool((text) => {
      expect(text).toContain("version IN (1, 6, 20)");
      return {
        rowCount: 3,
        rows: [
          { checksum: WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM, version: 1 },
          { checksum: DURABLE_RETENTION_MIGRATION_V6_CHECKSUM, version: 6 },
          { checksum: IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM, version: 20 },
        ],
      };
    });
    const repository = new PostgresWorkspaceSourceRepositoryV1({ pool: fixture.pool });

    await expect(repository.ready()).resolves.toBe(true);
  });

  it("marks newly unreferenced registered blobs without queuing them in the same sweep", async () => {
    const actions: string[] = [];
    const fixture = fakePool((text, values) => {
      if (text.includes("ORDER BY b.created_at")) {
        actions.push("discover-unmarked");
        expect(text).toContain("FROM public.render_artifact_objects");
        return { rowCount: 1, rows: [{ digest: DIGEST }] };
      }
      if (text.includes("ORDER BY b.orphaned_at")) {
        actions.push("discover-mature");
        expect(text).toContain("clock_timestamp()");
        expect(values).toEqual([TENANT, GRACE_MS, 8]);
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("UPDATE public.source_blob_objects b")) {
        actions.push("mark");
        expect(text).toContain("clock_timestamp()");
        expect(values).toEqual([TENANT, DIGEST]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresWorkspaceSourceRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueOrphanedBlobDeletions(TENANT, GRACE_MS, 8)).resolves.toBe(0);
    expect(actions).toEqual(["discover-mature", "discover-unmarked", "mark"]);
    expect(fixture.query.mock.calls.some(([text]) => text.startsWith("DELETE FROM"))).toBe(false);
  });

  it("rechecks every reference and clears a stale mature orphan marker", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("ORDER BY b.created_at")) return { rowCount: 0, rows: [] };
      if (text.includes("ORDER BY b.orphaned_at")) return { rowCount: 1, rows: [{ digest: DIGEST }] };
      if (text.includes("AS referenced")) {
        for (const table of [
          "workspace_source_heads",
          "render_sessions",
          "snapshot_artifact_objects",
          "snapshot_publications",
          "render_artifact_objects",
        ]) {
          expect(text).toContain(`public.${table}`);
        }
        return { rowCount: 1, rows: [blobRow({ orphaned_at: ORPHANED_AT, referenced: true })] };
      }
      if (text.includes("SET orphaned_at = NULL")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresWorkspaceSourceRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueOrphanedBlobDeletions(TENANT, GRACE_MS, 8)).resolves.toBe(0);
    expect(fixture.query.mock.calls.some(([text]) => text.startsWith("DELETE FROM"))).toBe(false);
  });

  it("moves a DB-clock-mature unreferenced blob to the deletion queue with its exact receipt", async () => {
    const actions: string[] = [];
    const fixture = fakePool((text, values) => {
      if (text.includes("ORDER BY b.created_at")) return { rowCount: 0, rows: [] };
      if (text.includes("ORDER BY b.orphaned_at")) return { rowCount: 1, rows: [{ digest: DIGEST }] };
      if (text.includes("AS referenced")) {
        actions.push("recheck");
        return { rowCount: 1, rows: [blobRow({ orphaned_at: ORPHANED_AT, referenced: false })] };
      }
      if (text.startsWith("DELETE FROM public.source_blob_objects")) {
        actions.push("remove");
        expect(text).toContain("FROM public.render_artifact_objects");
        expect(values).toEqual([TENANT, DIGEST, GRACE_MS]);
        return { rowCount: 1, rows: [blobRow()] };
      }
      if (text.startsWith("INSERT INTO public.source_blob_deletions")) {
        actions.push("queue");
        const blob = receipt();
        expect(values.slice(1)).toEqual([
          TENANT,
          blob.digest,
          blob.objectKey,
          blob.versionId,
          null,
          blob.etag,
          blob.byteSize,
        ]);
        return {
          rowCount: 1,
          rows: [blobRow({ deleted_at: null, deletion_id: DELETION_ID })],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresWorkspaceSourceRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueOrphanedBlobDeletions(TENANT, GRACE_MS, 8)).resolves.toBe(1);
    expect(actions).toEqual(["recheck", "remove", "queue"]);
  });

  it("clears an orphan marker when an existing blob is registered again", async () => {
    const updates: string[] = [];
    const fixture = fakePool((text) => {
      if (text.startsWith("INSERT INTO public.workspace_tenants")) return { rowCount: 1, rows: [] };
      if (text.startsWith("SELECT tenant_id FROM public.workspace_tenants")) return { rowCount: 1, rows: [{}] };
      if (text.startsWith("SELECT count(*)")) return { rowCount: 1, rows: [{ count: "0" }] };
      if (text.startsWith("SELECT 1 FROM public.source_blob_deletions")) return { rowCount: 0, rows: [] };
      if (text.startsWith("INSERT INTO public.source_blob_objects")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.source_blob_objects") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [blobRow({ orphaned_at: ORPHANED_AT })] };
      }
      if (text.includes("SET orphaned_at = NULL")) {
        updates.push(text);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.workspace_projects")) {
        const now = new Date();
        return {
          rowCount: 1,
          rows: [
            { created_at: now, display_name: "Workspace", project_id: "project-a", tenant_id: TENANT, updated_at: now },
          ],
        };
      }
      if (text.startsWith("INSERT INTO public.workspace_source_heads")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresWorkspaceSourceRepositoryV1({ pool: fixture.pool });

    await repository.createManagedProject({
      name: "Workspace",
      projectId: "project-a",
      source: { blob: receipt(), path: "main.py" },
      tenantId: TENANT,
    });
    expect(updates).toHaveLength(1);
  });

  it("reuses and resurrects the canonical receipt when the same digest arrives under a fresh generation", async () => {
    const canonical = immutableReceipt(OBJECT_GENERATION, '"canonical"');
    const candidate = immutableReceipt(FRESH_OBJECT_GENERATION, '"fresh"');
    const updates: string[] = [];
    const fixture = fakePool((text, values) => {
      if (text.startsWith("INSERT INTO public.workspace_tenants")) return { rowCount: 1, rows: [] };
      if (text.startsWith("SELECT tenant_id FROM public.workspace_tenants")) return { rowCount: 1, rows: [{}] };
      if (text.startsWith("SELECT count(*)")) return { rowCount: 1, rows: [{ count: "0" }] };
      if (text.startsWith("SELECT 1 FROM public.source_blob_deletions")) return { rowCount: 0, rows: [] };
      if (text.startsWith("INSERT INTO public.source_blob_objects")) {
        expect(values).toEqual([
          TENANT,
          DIGEST,
          candidate.objectKey,
          null,
          FRESH_OBJECT_GENERATION,
          candidate.etag,
          candidate.byteSize,
        ]);
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.source_blob_objects") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [blobRow({ orphaned_at: ORPHANED_AT }, canonical)] };
      }
      if (text.includes("SET orphaned_at = NULL")) {
        updates.push(text);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.workspace_projects")) {
        const now = new Date();
        return {
          rowCount: 1,
          rows: [
            { created_at: now, display_name: "Workspace", project_id: "project-b", tenant_id: TENANT, updated_at: now },
          ],
        };
      }
      if (text.startsWith("INSERT INTO public.workspace_source_heads")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresWorkspaceSourceRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.createManagedProject({
        name: "Workspace",
        projectId: "project-b",
        source: { blob: candidate, path: "main.py" },
        tenantId: TENANT,
      }),
    ).resolves.toMatchObject({ projectId: "project-b" });
    expect(updates).toHaveLength(1);
  });

  it("rejects a canonical receipt whose byte size conflicts with the candidate digest", async () => {
    const candidate = immutableReceipt(FRESH_OBJECT_GENERATION, '"fresh"');
    const fixture = fakePool((text) => {
      if (text.startsWith("INSERT INTO public.workspace_tenants")) return { rowCount: 1, rows: [] };
      if (text.startsWith("SELECT tenant_id FROM public.workspace_tenants")) return { rowCount: 1, rows: [{}] };
      if (text.startsWith("SELECT count(*)")) return { rowCount: 1, rows: [{ count: "0" }] };
      if (text.startsWith("SELECT 1 FROM public.source_blob_deletions")) return { rowCount: 0, rows: [] };
      if (text.startsWith("INSERT INTO public.source_blob_objects")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.source_blob_objects") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [blobRow({ byte_size: candidate.byteSize + 1, orphaned_at: null })] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresWorkspaceSourceRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.createManagedProject({
        name: "Workspace",
        projectId: "project-b",
        source: { blob: candidate, path: "main.py" },
        tenantId: TENANT,
      }),
    ).rejects.toThrow("The stored source blob metadata conflicts with its digest.");
  });

  it("queues an immutable upload with its exact application generation", async () => {
    const blob = immutableReceipt();
    const fixture = fakePool((text, values) => {
      if (text.startsWith("SELECT 1 FROM public.source_blob_objects")) {
        expect(values).toEqual([TENANT, DIGEST, blob.objectKey, null, OBJECT_GENERATION]);
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.source_blob_deletions")) {
        expect(values.slice(1)).toEqual([
          TENANT,
          DIGEST,
          blob.objectKey,
          null,
          OBJECT_GENERATION,
          blob.etag,
          blob.byteSize,
        ]);
        return {
          rowCount: 1,
          rows: [blobRow({ deleted_at: null, deletion_id: DELETION_ID }, blob)],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresWorkspaceSourceRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueBlobDeletion(TENANT, blob)).resolves.toEqual({
      blob,
      deletionId: DELETION_ID,
      tenantId: TENANT,
    });
  });
});
