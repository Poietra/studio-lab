import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { immutableProjectPngObjectKeyV1 } from "../immutable-source-png-storage";
import type { ProjectPngBlobReceiptV1, VersionedProjectPngBlobReceiptV1 } from "../project-png-storage";
import { storageObjectLocatorColumnsV1 } from "../storage-object-locator";
import { DURABLE_RETENTION_MIGRATION_V6_CHECKSUM } from "./durable-retention-schema";
import { PostgresProjectPngRepositoryV1, PROJECT_PNG_MIGRATION_V5_CHECKSUM } from "./postgres-project-png-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

const TENANT = "tenant-a";
const PROJECT = "project-a";
const DIGEST = "a".repeat(64);
const DELETION = "87654321-4321-4321-8321-cba987654321";
const GRACE_MS = 60_000;
const OBJECT_GENERATION = "123e4567-e89b-42d3-a456-426614174000";

function receipt(overrides: Partial<VersionedProjectPngBlobReceiptV1> = {}): VersionedProjectPngBlobReceiptV1 {
  return {
    byteSize: 128,
    digest: DIGEST,
    etag: '"etag-a"',
    objectKey: `tenants/${TENANT}/projects/${PROJECT}/assets/image.png/${DIGEST}`,
    versionId: "version-a",
    ...overrides,
  };
}

function immutableReceipt(): ProjectPngBlobReceiptV1 {
  return {
    byteSize: 128,
    digest: DIGEST,
    etag: '"etag-immutable"',
    objectGeneration: OBJECT_GENERATION,
    objectKey: immutableProjectPngObjectKeyV1(TENANT, PROJECT, DIGEST, OBJECT_GENERATION),
  };
}

function headRow(generation = "1", value: ProjectPngBlobReceiptV1 = receipt()) {
  const locator = storageObjectLocatorColumnsV1(value);
  return {
    byte_size: value.byteSize,
    digest: value.digest,
    etag: value.etag,
    generation,
    object_key: value.objectKey,
    object_generation: locator.objectGeneration,
    project_id: PROJECT,
    tenant_id: TENANT,
    version_id: locator.versionId,
  };
}

function deletionRow() {
  return { ...headRow(), deletion_id: DELETION };
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

describe("PostgresProjectPngRepositoryV1", () => {
  it("reports ready only when the project PNG and retention migrations are installed", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("version IN (5, 6)");
      expect(values).toEqual([]);
      return {
        rowCount: 2,
        rows: [
          { checksum: PROJECT_PNG_MIGRATION_V5_CHECKSUM, version: 5 },
          { checksum: DURABLE_RETENTION_MIGRATION_V6_CHECKSUM, version: 6 },
        ],
      };
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });

    await expect(repository.ready()).resolves.toBe(true);
  });

  it("publishes an initial candidate with generation one under a project CAS", async () => {
    let headReads = 0;
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_projects")) return { rowCount: 1, rows: [{}] };
      if (text.includes("FROM public.project_png_heads h")) {
        headReads += 1;
        return headReads === 1 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [headRow()] };
      }
      if (text.includes("FROM public.project_png_deletions") && text.startsWith("SELECT 1")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.project_png_objects")) {
        expect(values).toEqual([TENANT, PROJECT, DIGEST, receipt().objectKey, "version-a", null, '"etag-a"', 128]);
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("FROM public.project_png_objects") && text.includes("FOR KEY SHARE")) {
        return { rowCount: 1, rows: [headRow()] };
      }
      if (text.startsWith("INSERT INTO public.project_png_generations")) {
        expect(values).toEqual([TENANT, PROJECT, "1", DIGEST, receipt().objectKey, "version-a", null]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.project_png_heads")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.compareAndSwapHead({ candidate: receipt(), expected: null, projectId: PROJECT, tenantId: TENANT }),
    ).resolves.toEqual({ generation: 1n, projectId: PROJECT, receipt: receipt(), tenantId: TENANT });
    expect(fixture.query.mock.calls.at(-1)).toEqual(["COMMIT"]);
  });

  it("rejects stale replacement before registering its object version", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.workspace_projects")) return { rowCount: 1, rows: [{}] };
      if (text.includes("FROM public.project_png_heads h")) return { rowCount: 1, rows: [headRow("2")] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.compareAndSwapHead({
        candidate: receipt(),
        expected: { digest: DIGEST, generation: 1n },
        projectId: PROJECT,
        tenantId: TENANT,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fixture.query.mock.calls.some(([text]) => text.startsWith("INSERT INTO public.project_png_objects"))).toBe(
      false,
    );
    expect(fixture.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
  });

  it("publishes an immutable candidate without synthesizing a provider version", async () => {
    const candidate = immutableReceipt();
    let headReads = 0;
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_projects")) return { rowCount: 1, rows: [{}] };
      if (text.includes("FROM public.project_png_heads h")) {
        headReads += 1;
        return headReads === 1 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [headRow("1", candidate)] };
      }
      if (text.includes("FROM public.project_png_deletions") && text.startsWith("SELECT 1")) {
        expect(values).toEqual([TENANT, candidate.objectKey, null, OBJECT_GENERATION]);
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.project_png_objects")) {
        expect(values).toEqual([
          TENANT,
          PROJECT,
          DIGEST,
          candidate.objectKey,
          null,
          OBJECT_GENERATION,
          candidate.etag,
          candidate.byteSize,
        ]);
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("FROM public.project_png_objects") && text.includes("FOR KEY SHARE")) {
        return { rowCount: 1, rows: [headRow("1", candidate)] };
      }
      if (text.startsWith("INSERT INTO public.project_png_generations")) {
        expect(values).toEqual([TENANT, PROJECT, "1", DIGEST, candidate.objectKey, null, OBJECT_GENERATION]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.project_png_heads")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.compareAndSwapHead({ candidate, expected: null, projectId: PROJECT, tenantId: TENANT }),
    ).resolves.toEqual({ generation: 1n, projectId: PROJECT, receipt: candidate, tenantId: TENANT });
  });

  it("publishes a replacement as non-orphaned and marks the detached generation with the database clock", async () => {
    const replacement = receipt({
      digest: "b".repeat(64),
      etag: '"etag-b"',
      objectKey: `tenants/${TENANT}/projects/${PROJECT}/assets/image.png/${"b".repeat(64)}`,
      versionId: "version-b",
    });
    let headReads = 0;
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.workspace_projects")) return { rowCount: 1, rows: [{}] };
      if (text.startsWith("SELECT h.tenant_id")) {
        headReads += 1;
        return {
          rowCount: 1,
          rows: [headReads === 1 ? headRow("1") : headRow("2", replacement)],
        };
      }
      if (text.includes("FROM public.project_png_deletions") && text.startsWith("SELECT 1")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.project_png_objects")) return { rowCount: 1, rows: [] };
      if (text.includes("FROM public.project_png_objects") && text.includes("FOR KEY SHARE")) {
        return { rowCount: 1, rows: [headRow("2", replacement)] };
      }
      if (text.startsWith("INSERT INTO public.project_png_generations")) {
        expect(text).toContain("orphaned_at");
        expect(text).toContain("NULL");
        expect(values).toEqual([TENANT, PROJECT, "2", replacement.digest, replacement.objectKey, "version-b", null]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.project_png_heads")) return { rowCount: 1, rows: [] };
      if (text.startsWith("UPDATE public.project_png_generations g")) {
        expect(text).toContain("clock_timestamp()");
        expect(text).toContain("FROM public.render_sessions");
        expect(values).toEqual([TENANT, PROJECT, "1", DIGEST]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.compareAndSwapHead({
        candidate: replacement,
        expected: { digest: DIGEST, generation: 1n },
        projectId: PROJECT,
        tenantId: TENANT,
      }),
    ).resolves.toEqual({ generation: 2n, projectId: PROJECT, receipt: replacement, tenantId: TENANT });
    const headWrite = fixture.query.mock.calls.findIndex(([text]) =>
      text.startsWith("INSERT INTO public.project_png_heads"),
    );
    const orphanMark = fixture.query.mock.calls.findIndex(([text]) =>
      text.startsWith("UPDATE public.project_png_generations g"),
    );
    expect(orphanMark).toBeGreaterThan(headWrite);
  });

  it("retains a version pinned by either the head or a render session", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("FROM public.render_sessions");
      expect(values).toEqual([TENANT, PROJECT, DIGEST, receipt().objectKey, "version-a", null, '"etag-a"', 128]);
      return { rowCount: 1, rows: [{}] };
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });
    await expect(repository.isVersionRetained(TENANT, PROJECT, receipt())).resolves.toBe(true);
  });

  it("queues an unreferenced upload orphan while refusing cross-project receipts", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.project_png_objects") && text.includes("FOR UPDATE")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("DELETE FROM public.project_png_objects")) return { rowCount: 0, rows: [] };
      if (text.startsWith("INSERT INTO public.project_png_deletions")) return { rowCount: 1, rows: [] };
      if (text.includes("FROM public.project_png_deletions") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [deletionRow()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueDeletion(TENANT, PROJECT, receipt(), GRACE_MS)).resolves.toEqual({
      deletionId: DELETION,
      projectId: PROJECT,
      receipt: receipt(),
      tenantId: TENANT,
    });
    await expect(repository.queueDeletion(TENANT, "project-b", receipt(), GRACE_MS)).rejects.toThrow(/receipt/i);
  });

  it("marks an unreferenced registered generation with the database clock and defers deletion", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.project_png_objects") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [headRow()] };
      }
      if (text.startsWith("SELECT g.generation::text")) {
        return { rowCount: 1, rows: [{ generation: "1", mature: false, orphaned_at: null, retained: false }] };
      }
      if (text.startsWith("UPDATE public.project_png_generations g")) {
        expect(text).toContain("clock_timestamp()");
        expect(text).toContain("g.orphaned_at IS NULL");
        expect(values).toEqual([TENANT, PROJECT, DIGEST, receipt().objectKey, "version-a", null]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueDeletion(TENANT, PROJECT, receipt(), GRACE_MS)).resolves.toBeNull();
    expect(fixture.query.mock.calls.some(([text]) => text.startsWith("DELETE FROM public.project_png_objects"))).toBe(
      false,
    );
    expect(fixture.query.mock.calls.some(([text]) => text.startsWith("INSERT INTO public.project_png_deletions"))).toBe(
      false,
    );
  });

  it("queues a registered object only after every generation matures on the database clock", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.project_png_objects") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [headRow()] };
      }
      if (text.startsWith("SELECT g.generation::text")) {
        expect(text).toContain("FROM public.render_sessions");
        expect(text).toContain("clock_timestamp()");
        expect(text).toContain("FOR UPDATE OF g");
        return {
          rowCount: 2,
          rows: [
            { generation: "1", mature: true, orphaned_at: new Date("2026-07-26T00:00:00.000Z"), retained: false },
            { generation: "3", mature: true, orphaned_at: new Date("2026-07-27T00:00:00.000Z"), retained: false },
          ],
        };
      }
      if (text.startsWith("DELETE FROM public.project_png_generations")) {
        expect(values).toEqual([TENANT, PROJECT, DIGEST, receipt().objectKey, "version-a", null, GRACE_MS]);
        return { rowCount: 2, rows: [] };
      }
      if (text.startsWith("DELETE FROM public.project_png_objects")) return { rowCount: 1, rows: [] };
      if (text.startsWith("INSERT INTO public.project_png_deletions")) return { rowCount: 1, rows: [] };
      if (text.includes("FROM public.project_png_deletions") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [deletionRow()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueDeletion(TENANT, PROJECT, receipt(), GRACE_MS)).resolves.toEqual({
      deletionId: DELETION,
      projectId: PROJECT,
      receipt: receipt(),
      tenantId: TENANT,
    });
  });

  it.each([
    ["retained", { generation: "1", mature: true, orphaned_at: new Date("2026-07-26T00:00:00.000Z"), retained: true }],
    [
      "too young",
      { generation: "1", mature: false, orphaned_at: new Date("2026-07-29T00:00:00.000Z"), retained: false },
    ],
  ])("keeps a registered object when one generation is %s", async (_label, generationRow) => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.project_png_objects") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [headRow()] };
      }
      if (text.startsWith("SELECT g.generation::text")) return { rowCount: 1, rows: [generationRow] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });

    await expect(repository.queueDeletion(TENANT, PROJECT, receipt(), GRACE_MS)).resolves.toBeNull();
    expect(fixture.query.mock.calls.some(([text]) => text.startsWith("DELETE "))).toBe(false);
  });
});
