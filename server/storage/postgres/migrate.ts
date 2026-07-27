import { createHash } from "node:crypto";

import type { Pool } from "pg";

import { WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM } from "./postgres-workspace-source-repository";

const WORKSPACE_SOURCE_MIGRATION_LOCK_V1 = "5784133447825795121";

export function workspaceSourceMigrationChecksumV1(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
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
        "SELECT checksum FROM poietra_schema_migrations WHERE version = 1",
      );
      if (applied.rowCount !== 1 || applied.rows[0]?.checksum !== WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM) {
        throw new Error("The installed workspace/source schema does not match migration v1.");
      }
      await client.query("COMMIT");
      began = false;
      return { applied: false, version: 1 } as const;
    }
    await client.query(source);
    await client.query("INSERT INTO poietra_schema_migrations (version, checksum) VALUES (1, $1)", [
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
