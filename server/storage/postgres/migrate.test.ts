import type { Pool } from "pg";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  applyBundledDurableStorageMigrations,
  type applyBundledDurableStorageMigrationsV2,
  type applyBundledWorkspaceSourceMigrationV1,
  applyProjectPngMigrationV5,
  applyRenderArtifactMigrationV4,
  applyRenderSessionMigrationV2,
  applySnapshotPublicationMigrationV3,
  applyWorkspaceSourceMigrationV1,
  PROJECT_PNG_MIGRATION_V5_SOURCE,
  RENDER_ARTIFACT_MIGRATION_V4_SOURCE,
  RENDER_SESSION_MIGRATION_V2_SOURCE,
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
    await expect(applyBundledDurableStorageMigrations(db.pool)).resolves.toEqual({ applied: true, version: 5 });
    expect([...db.installed.keys()]).toEqual([1, 2, 3, 4, 5]);

    await expect(applyBundledDurableStorageMigrations(db.pool)).resolves.toEqual({ applied: false, version: 5 });
    expect(db.queries.filter(({ text }) => text === WORKSPACE_SOURCE_MIGRATION_V1_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_SESSION_MIGRATION_V2_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === RENDER_ARTIFACT_MIGRATION_V4_SOURCE)).toHaveLength(1);
    expect(db.queries.filter(({ text }) => text === PROJECT_PNG_MIGRATION_V5_SOURCE)).toHaveLength(1);
    expect(db.release).toHaveBeenCalledTimes(10);
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
});
