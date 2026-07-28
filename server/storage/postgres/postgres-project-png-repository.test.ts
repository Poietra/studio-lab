import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ProjectPngBlobReceiptV1 } from "../project-png-storage";
import { PostgresProjectPngRepositoryV1 } from "./postgres-project-png-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

const TENANT = "tenant-a";
const PROJECT = "project-a";
const DIGEST = "a".repeat(64);
const DELETION = "87654321-4321-4321-8321-cba987654321";

function receipt(overrides: Partial<ProjectPngBlobReceiptV1> = {}): ProjectPngBlobReceiptV1 {
  return {
    byteSize: 128,
    digest: DIGEST,
    etag: '"etag-a"',
    objectKey: `tenants/${TENANT}/projects/${PROJECT}/assets/image.png/${DIGEST}`,
    versionId: "version-a",
    ...overrides,
  };
}

function headRow(generation = "1") {
  const value = receipt();
  return {
    byte_size: value.byteSize,
    digest: value.digest,
    etag: value.etag,
    generation,
    object_key: value.objectKey,
    project_id: PROJECT,
    tenant_id: TENANT,
    version_id: value.versionId,
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
        expect(values).toEqual([TENANT, PROJECT, "1", DIGEST, receipt().objectKey, "version-a", '"etag-a"', 128]);
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

  it("retains a version pinned by either the head or a render session", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("FROM public.render_sessions");
      expect(values).toEqual([TENANT, PROJECT, DIGEST, receipt().objectKey, "version-a", '"etag-a"', 128]);
      return { rowCount: 1, rows: [{}] };
    });
    const repository = new PostgresProjectPngRepositoryV1({ pool: fixture.pool });
    await expect(repository.isVersionRetained(TENANT, PROJECT, receipt())).resolves.toBe(true);
  });

  it("queues an unreferenced upload orphan while refusing cross-project receipts", async () => {
    const fixture = fakePool((text) => {
      if (text.startsWith("SELECT 1") && text.includes("FROM public.project_png_objects o")) {
        expect(text).toContain("FROM public.render_sessions");
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

    await expect(repository.queueDeletion(TENANT, PROJECT, receipt())).resolves.toEqual({
      deletionId: DELETION,
      projectId: PROJECT,
      receipt: receipt(),
      tenantId: TENANT,
    });
    await expect(repository.queueDeletion(TENANT, "project-b", receipt())).rejects.toThrow(/receipt/i);
  });
});
