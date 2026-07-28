import { createHash } from "node:crypto";

import type { Pool } from "pg";
import workspaceSourceMigrationV1 from "./migrations/0001_workspace_source.sql?raw";
import renderSessionMigrationV2 from "./migrations/0002_render_sessions.sql?raw";
import { RENDER_SESSION_MIGRATION_V2_CHECKSUM } from "./postgres-render-session-repository";
import { WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM } from "./postgres-workspace-source-repository";

const WORKSPACE_SOURCE_MIGRATION_LOCK_V1 = "5784133447825795121";

export function workspaceSourceMigrationChecksumV1(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export const WORKSPACE_SOURCE_MIGRATION_V1_SOURCE = workspaceSourceMigrationV1;
export const RENDER_SESSION_MIGRATION_V2_SOURCE = renderSessionMigrationV2;

export function applyBundledWorkspaceSourceMigrationV1(pool: Pool) {
  return applyWorkspaceSourceMigrationV1(pool, WORKSPACE_SOURCE_MIGRATION_V1_SOURCE);
}

export function renderSessionMigrationChecksumV2(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export async function applyBundledDurableStorageMigrationsV2(pool: Pool) {
  await applyBundledWorkspaceSourceMigrationV1(pool);
  return applyRenderSessionMigrationV2(pool, RENDER_SESSION_MIGRATION_V2_SOURCE);
}

/** Apply v1 under one transaction-scoped advisory lock using a DDL credential. */
export async function applyWorkspaceSourceMigrationV1(pool: Pool, source: string) {
  if (workspaceSourceMigrationChecksumV1(source) !== WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM) {
    throw new TypeError("The workspace/source migration checksum is invalid.");
  }
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [WORKSPACE_SOURCE_MIGRATION_LOCK_V1]);
    const table = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('public.poietra_schema_migrations')::text AS relation",
    );
    if (table.rows[0]?.relation !== null) {
      const applied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM public.poietra_schema_migrations WHERE version = 1",
      );
      if (applied.rowCount !== 1 || applied.rows[0]?.checksum !== WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM) {
        throw new Error("The installed workspace/source schema does not match migration v1.");
      }
      await client.query("COMMIT");
      began = false;
      return { applied: false, version: 1 } as const;
    }
    await client.query(source);
    await client.query("INSERT INTO public.poietra_schema_migrations (version, checksum) VALUES (1, $1)", [
      WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM,
    ]);
    await client.query("COMMIT");
    began = false;
    return { applied: true, version: 1 } as const;
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Apply v2 only after an exact v1 installation has been verified. */
export async function applyRenderSessionMigrationV2(pool: Pool, source: string) {
  if (renderSessionMigrationChecksumV2(source) !== RENDER_SESSION_MIGRATION_V2_CHECKSUM) {
    throw new TypeError("The render-session migration checksum is invalid.");
  }
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [WORKSPACE_SOURCE_MIGRATION_LOCK_V1]);
    const table = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('public.poietra_schema_migrations')::text AS relation",
    );
    if (table.rows[0]?.relation === null) {
      throw new Error("Render-session migration v2 requires workspace/source migration v1.");
    }
    const installed = await client.query<{ checksum: string; version: number }>(
      "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (1, 2) ORDER BY version",
    );
    const v1 = installed.rows.find((row) => row.version === 1);
    if (v1?.checksum !== WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM) {
      throw new Error("Render-session migration v2 requires an exact workspace/source migration v1.");
    }
    const v2 = installed.rows.find((row) => row.version === 2);
    if (v2) {
      if (v2.checksum !== RENDER_SESSION_MIGRATION_V2_CHECKSUM) {
        throw new Error("The installed render-session schema does not match migration v2.");
      }
      await client.query("COMMIT");
      began = false;
      return { applied: false, version: 2 } as const;
    }
    await client.query(source);
    await client.query("INSERT INTO public.poietra_schema_migrations (version, checksum) VALUES (2, $1)", [
      RENDER_SESSION_MIGRATION_V2_CHECKSUM,
    ]);
    await client.query("COMMIT");
    began = false;
    return { applied: true, version: 2 } as const;
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
