import type { Pool } from "pg";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  applyBundledDurableStorageMigrations,
  type applyBundledDurableStorageMigrationsV2,
  type applyBundledWorkspaceSourceMigrationV1,
  applyProjectPngMigrationV5,
  applyRenderArtifactMigrationV4,
  applyRenderCancellationMigrationV7,
  applyRenderSessionCpuFailureMigrationV9,
  applyRenderSessionFailureMigrationV8,
  applyRenderSessionMigrationV2,
  applyRenderSessionRetentionMigrationV6,
  applySnapshotPublicationMigrationV3,
  applyWorkspaceSourceMigrationV1,
  PROJECT_PNG_MIGRATION_V5_SOURCE,
  RENDER_ARTIFACT_MIGRATION_V4_SOURCE,
  RENDER_CANCELLATION_MIGRATION_V7_SOURCE,
  RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE,
  RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE,
  RENDER_SESSION_MIGRATION_V2_SOURCE,
  RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE,
  SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE,
  WORKSPACE_SOURCE_MIGRATION_V1_SOURCE,
} from "./migrate";

function database(initial: ReadonlyMap<number, string> = new Map()) {
  const installed = new Map(initial);
  let migrationTableExists = installed.size > 0;
  const queries: Array<Readonly<{ parameters?: readonly unknown[]; text: string }>> = [];
  const query = vi.fn(async (text: string, parameters?: readonly unknown[]) => {
    queries.push({ ...(parameters ? { parameters } : {}), text });
    if (text.includes("to_regclass")) {
      return { rowCount: 1, rows: [{ relation: migrationTableExists ? "poietra_schema_migrations" : null }] };
    }
    if (text.startsWith("SELECT version, checksum")) {
      const maximum = parameters?.[0] as number;
      return {
        rowCount: installed.size,
        rows: [...installed]
          .filter(([version]) => version <= maximum)
          .map(([version, checksum]) => ({ checksum, version })),
      };
    }
    if (text === WORKSPACE_SOURCE_MIGRATION_V1_SOURCE) migrationTableExists = true;
    if (text.startsWith("INSERT INTO public.poietra_schema_migrations")) {
      installed.set(parameters?.[0] as number, parameters?.[1] as string);
    }
    return { rowCount: 0, rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { connect, installed, pool: { connect } as unknown as Pool, queries, release };
}

describe("durable storage migrations", () => {
  it("preserves the public literal versions of compatibility helpers", () => {
    expectTypeOf<Awaited<ReturnType<typeof applyBundledWorkspaceSourceMigrationV1>>>().toEqualTypeOf<
      Readonly<{ applied: false; version: 1 }> | Readonly<{ applied: true; version: 1 }>
    >();
    expectTypeOf<Awaited<ReturnType<typeof applyBundledDurableStorageMigrationsV2>>>().toEqualTypeOf<
      Readonly<{ applied: false; version: 2 }> | Readonly<{ applied: true; version: 2 }>
    >();
  });

  it("applies the ordered catalog and then verifies it idempotently", async () => {
    const db = database();
    await expect(applyBundledDurableStorageMigrations(db.pool)).resolves.toEqual({ applied: true, version: 9 });
    expect([...db.installed.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    await expect(applyBundledDurableStorageMigrations(db.pool)).resolves.toEqual({ applied: false, version: 9 });
    expect(db.queries.filter(({ text }) => text === WORKSPACE_SOURCE_MIGRATION_V1_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_MIGRATION_V2_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_ARTIFACT_MIGRATION_V4_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === PROJECT_PNG_MIGRATION_V5_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_CANCELLATION_MIGRATION_V7_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE)).toHaveLength(1);
    expect(db.release).toHaveBeenCalledTimes(18);
  });

  it("rejects a missing prerequisite under the same advisory lock", async () => {
    const db = database();
    await expect(applyRenderSessionMigrationV2(db.pool, RENDER_SESSION_MIGRATION_V2_SOURCE)).rejects.toThrow(
      /requires workspace\/source migration v1/i,
    );
    expect(db.queries.some(({ text }) => text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects modified migration source before acquiring a connection", async () => {
    const db = database();
    await expect(applyWorkspaceSourceMigrationV1(db.pool, `${WORKSPACE_SOURCE_MIGRATION_V1_SOURCE}\n`)).rejects.toThrow(
      /checksum is invalid/i,
    );
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("requires both durable-storage prerequisites before applying snapshot publication v3", async () => {
    const db = database();
    await expect(
      applySnapshotPublicationMigrationV3(db.pool, SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 and v2/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all three durable-storage prerequisites before applying render artifacts v4", async () => {
    const db = database();
    await expect(applyRenderArtifactMigrationV4(db.pool, RENDER_ARTIFACT_MIGRATION_V4_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v3/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all four durable-storage prerequisites before applying project image.png v5", async () => {
    const db = database();
    await expect(applyProjectPngMigrationV5(db.pool, PROJECT_PNG_MIGRATION_V5_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v4/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all five durable-storage prerequisites before applying render-session retention v6", async () => {
    const db = database();
    await expect(
      applyRenderSessionRetentionMigrationV6(db.pool, RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 through v5/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all six durable-storage prerequisites before applying render cancellation v7", async () => {
    const db = database();
    await expect(applyRenderCancellationMigrationV7(db.pool, RENDER_CANCELLATION_MIGRATION_V7_SOURCE)).rejects.toThrow(
      /requires durable storage migrations v1 through v6/i,
    );
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all seven durable-storage prerequisites before applying render-session failures v8", async () => {
    const db = database();
    await expect(
      applyRenderSessionFailureMigrationV8(db.pool, RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 through v7/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires all eight durable-storage prerequisites before applying render-session CPU failures v9", async () => {
    const db = database();
    await expect(
      applyRenderSessionCpuFailureMigrationV9(db.pool, RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE),
    ).rejects.toThrow(/requires durable storage migrations v1 through v8/i);
    expect(db.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("backfills CPU failures and extends the closed catalog without a second normalization trigger in v9", () => {
    expect(RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE).toContain("SET failure_code = 'cpu-limit'");
    expect(RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE).toContain(
      "ADD CONSTRAINT render_sessions_failure_code_closed",
    );
    expect(RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE).not.toContain("CREATE FUNCTION");
    expect(RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE).not.toContain("CREATE TRIGGER");
  });

  it("adds a rolling-compatible closed render-session failure code in migration v8", () => {
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("ADD COLUMN failure_code text");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("failure_code IS NULL");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).not.toContain("failure_code text NOT NULL");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("status IN ('failed', 'discarded')");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("status = 'discarded' AND error IS NOT NULL");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(
      "CREATE FUNCTION public.normalize_render_session_failure_code_v8()",
    );
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(
      "CREATE TRIGGER render_sessions_failure_code_normalization",
    );
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(
      "BEFORE INSERT OR UPDATE OF status, error, failure_code",
    );
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(
      "failure_code IS NULL AND status NOT IN ('cancelled', 'failed')",
    );
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain("status = 'failed' AND failure_code IS NOT NULL");
    expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).not.toContain("'cleanup-failed'");
    for (const code of [
      "cancelled",
      "deadline-exceeded",
      "interrupted",
      "memory-limit",
      "pids-limit",
      "render-failed",
    ]) {
      expect(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE).toContain(`'${code}'`);
    }
  });

  it("pins shard ownership and bounded durable cancellation state in migration v7", () => {
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_sessions_rendering_broker_shard");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_sessions_broker_shard_immutable");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_sessions_cancellation_authority");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_cancellation_intents");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("expires_at = reject_until + interval '30 seconds'");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("ON DELETE CASCADE");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_cancellation_delivery_queue");
    expect(RENDER_CANCELLATION_MIGRATION_V7_SOURCE).toContain("render_cancellation_expiry_queue");
  });

  it("keeps reference release separate from terminal-session purge", () => {
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("ALTER COLUMN original_digest DROP NOT NULL");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("ALTER COLUMN patched_digest DROP NOT NULL");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("references_released_at timestamptz");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("source_blob_objects_orphan_queue");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain("project_png_generations_orphan_queue");
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).toContain(
      "status IN ('cancelled', 'discarded', 'failed', 'ready', 'undone')",
    );
    expect(RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE).not.toContain("delete_after");
  });
});
