import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { renderSessionTransitionSources } from "../../manim-render-session-policy";
import { BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM } from "./billing-entitlement-schema";
import { DURABLE_RETENTION_MIGRATION_V6_CHECKSUM } from "./durable-retention-schema";
import { PROJECT_PNG_MIGRATION_V5_CHECKSUM } from "./postgres-project-png-repository";
import {
  PostgresRenderSessionRepositoryV1,
  RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM,
  RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM,
  RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM,
  RENDER_SESSION_MIGRATION_V2_CHECKSUM,
} from "./postgres-render-session-repository";
import { WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1 } from "./postgres-workspace-source-repository";
import { RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM } from "./render-session-usage-schema";

describe("Postgres render-session transitions", () => {
  it("reports ready only when render and billing migrations match", async () => {
    const rows = [
      { checksum: RENDER_SESSION_MIGRATION_V2_CHECKSUM, version: 2 },
      { checksum: PROJECT_PNG_MIGRATION_V5_CHECKSUM, version: 5 },
      { checksum: DURABLE_RETENTION_MIGRATION_V6_CHECKSUM, version: 6 },
      { checksum: RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM, version: 7 },
      { checksum: RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM, version: 8 },
      { checksum: RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM, version: 9 },
      { checksum: BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM, version: 14 },
      { checksum: RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM, version: 15 },
    ];
    const query = vi.fn(async (text: string) => {
      expect(text).toContain("version IN (2, 5, 6, 7, 8, 9, 14, 15)");
      return { rowCount: rows.length, rows };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
      options: {
        connectionTimeoutMillis: 1_000,
        options: WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      },
    } as unknown as Pool;
    const repository = new PostgresRenderSessionRepositoryV1({ pool, statementTimeoutMs: 1_000 });

    await expect(repository.ready()).resolves.toBe(true);
    for (const [index, row] of rows.entries()) {
      rows[index] = { ...row, checksum: "0".repeat(64) };
      await expect(repository.ready()).resolves.toBe(false);
      rows[index] = row;
    }
  });

  it("rejects a zero-row transition, rolls back, and keeps SQL statuses closed", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes("SELECT broker_shard_id, project_id, render_request_id, status")) {
        return {
          rowCount: 1,
          rows: [
            { broker_shard_id: "shard-a", project_id: "project-a", render_request_id: "request-a", status: "ready" },
          ],
        };
      }
      if (text.includes("UPDATE public.render_sessions")) return { rowCount: 0, rows: [] };
      return { rowCount: null, rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
      options: {
        connectionTimeoutMillis: 1_000,
        options: WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      },
    } as unknown as Pool;
    const repository = new PostgresRenderSessionRepositoryV1({ pool, statementTimeoutMs: 1_000 });
    const exposedSources = renderSessionTransitionSources("abandon") as unknown as string[];
    exposedSources.splice(0, exposedSources.length, "ready'); DROP TABLE render_sessions; --");

    const abandoned = repository.abandonSession("tenant-a", "00000000-0000-4000-8000-000000000001", "request-a");
    await expect(abandoned).rejects.toMatchObject({
      message: "The render session transition was rejected.",
      status: 409,
    });

    const update = statements.find((statement) => statement.includes("UPDATE public.render_sessions"));
    expect(update).toContain("status IN ('cancelled', 'failed', 'preparing', 'ready', 'rendering')");
    expect(update).not.toContain("DROP TABLE");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.some((statement) => statement.includes("DELETE FROM"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("creates no durable render records when the organization has no entitlement", async () => {
    const statements: string[] = [];
    const originalDigest = "1".repeat(64);
    const patchedDigest = "2".repeat(64);
    const query = vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes("FROM public.workspace_source_heads")) {
        return {
          rowCount: 1,
          rows: [
            {
              byte_size: 128,
              digest: originalDigest,
              etag: '"original"',
              generation: "1",
              object_key: `tenants/tenant-a/sources/${originalDigest}`,
              version_id: "original-version",
            },
          ],
        };
      }
      if (text.includes("FROM public.project_png_heads")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.billing_accounts account")) return { rowCount: 0, rows: [] };
      return { rowCount: null, rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
      options: {
        connectionTimeoutMillis: 1_000,
        options: WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      },
    } as unknown as Pool;
    const repository = new PostgresRenderSessionRepositoryV1({ pool, statementTimeoutMs: 1_000 });

    await expect(
      repository.createSession({
        commitCorrelationKey: "correlation-a",
        executionTimeoutMs: 60_000,
        id: "00000000-0000-4000-8000-000000000001",
        originalHead: {
          blob: {
            byteSize: 128,
            digest: originalDigest,
            etag: '"original"',
            objectKey: `tenants/tenant-a/sources/${originalDigest}`,
            versionId: "original-version",
          },
          generation: 1n,
          projectId: "project-a",
          sourcePath: "main.py",
          tenantId: "tenant-a",
        },
        patch: { anchorLine: 1, anchorLines: [1], insertedCode: "self.wait(1)" },
        patchedBlob: {
          byteSize: 144,
          digest: patchedDigest,
          etag: '"patched"',
          objectKey: `tenants/tenant-a/sources/${patchedDigest}`,
          versionId: "patched-version",
        },
        programBatchId: "batch-a",
        programTransactionId: "transaction-a",
        renderRequestId: "request-a",
        sceneName: "MainScene",
        tenantId: "tenant-a",
      }),
    ).rejects.toMatchObject({ status: 402 });

    expect(statements.at(-1)).toBe("COMMIT");
    expect(
      statements.some((statement) =>
        [
          "INSERT INTO public.source_blob_objects",
          "INSERT INTO public.usage_reservations",
          "INSERT INTO public.render_sessions",
          "INSERT INTO public.workspace_project_references",
        ].some((write) => statement.includes(write)),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { global_count: 4_096, label: "global", tenant_count: 1 },
    { global_count: 256, label: "tenant", tenant_count: 256 },
  ])("rejects the exact $label cancellation capacity without evicting a live intent", async (counts) => {
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes("SELECT broker_shard_id, status")) {
        return {
          rowCount: 1,
          rows: [{ broker_shard_id: "shard-b", cancellation_current: true, status: "rendering" }],
        };
      }
      if (text.includes("FROM public.render_cancellation_intents cancellation")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("AS global_count")) return { rowCount: 1, rows: [counts] };
      return { rowCount: 0, rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
      options: {
        connectionTimeoutMillis: 1_000,
        options: WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      },
    } as unknown as Pool;
    const repository = new PostgresRenderSessionRepositoryV1({ pool, statementTimeoutMs: 1_000 });

    await expect(
      repository.registerCancellation("tenant-a", "00000000-0000-4000-8000-000000000001"),
    ).rejects.toMatchObject({ status: 429 });

    const capacityLock = statements.findIndex((statement) => statement.includes("pg_advisory_xact_lock"));
    const expiredCleanup = statements.findIndex(
      (statement, index) => index > capacityLock && statement.includes("WITH expired AS"),
    );
    const capacityCount = statements.findIndex((statement) => statement.includes("AS global_count"));
    expect(capacityLock).toBeGreaterThanOrEqual(0);
    expect(expiredCleanup).toBeGreaterThan(capacityLock);
    expect(statements[expiredCleanup]).toContain("FOR UPDATE SKIP LOCKED");
    expect(capacityCount).toBeGreaterThan(capacityLock);
    expect(capacityCount).toBeGreaterThan(expiredCleanup);
    expect(statements[capacityCount]).toContain("WHERE expires_at > clock_timestamp()");
    expect(
      statements.filter((statement) => statement.includes("DELETE FROM public.render_cancellation_intents")),
    ).toSatisfy(
      (deletions: string[]) =>
        deletions.length > 0 && deletions.every((statement) => statement.includes("expires_at <= clock_timestamp()")),
    );
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rechecks the DB-clock fence at INSERT and falls back to direct cancellation after grace", async () => {
    const statements: string[] = [];
    let stateReads = 0;
    const query = vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes("SELECT broker_shard_id, status")) {
        stateReads += 1;
        return {
          rowCount: 1,
          rows: [
            {
              broker_shard_id: "shard-b",
              cancellation_current: stateReads < 3,
              status: "rendering",
            },
          ],
        };
      }
      if (text.includes("FROM public.render_cancellation_intents cancellation")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("AS global_count")) {
        return { rowCount: 1, rows: [{ global_count: 1, tenant_count: 1 }] };
      }
      if (text.includes("INSERT INTO public.render_cancellation_intents")) return { rowCount: 0, rows: [] };
      if (text.includes("UPDATE public.render_sessions")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
      options: {
        connectionTimeoutMillis: 1_000,
        options: WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      },
    } as unknown as Pool;
    const repository = new PostgresRenderSessionRepositoryV1({ pool, statementTimeoutMs: 1_000 });

    await expect(
      repository.registerCancellation("tenant-a", "00000000-0000-4000-8000-000000000001"),
    ).rejects.toMatchObject({ status: 409 });

    const insertIndex = statements.findIndex((statement) =>
      statement.includes("INSERT INTO public.render_cancellation_intents"),
    );
    expect(statements[insertIndex]).toContain(
      "execution_deadline + ($3::integer * interval '1 millisecond') > clock_timestamp()",
    );
    expect(statements.findIndex((statement) => statement.includes("UPDATE public.render_sessions"))).toBeGreaterThan(
      insertIndex,
    );
    expect(stateReads).toBe(3);
    expect(statements.at(-1)).toBe("ROLLBACK");
  });
});
