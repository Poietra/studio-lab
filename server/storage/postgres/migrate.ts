import { createHash } from "node:crypto";

import type { Pool } from "pg";
import workspaceSourceSqlV1 from "./migrations/0001_workspace_source.sql?raw";
import renderSessionSqlV2 from "./migrations/0002_render_sessions.sql?raw";
import snapshotPublicationSqlV3 from "./migrations/0003_snapshot_publications.sql?raw";
import { RENDER_SESSION_MIGRATION_V2_CHECKSUM } from "./postgres-render-session-repository";
import { SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM } from "./postgres-snapshot-publication-repository";
import { WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM } from "./postgres-workspace-source-repository";

export { SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM } from "./postgres-snapshot-publication-repository";

const DURABLE_STORAGE_MIGRATION_LOCK = "5784133447825795121";

type DurableStorageMigration<Version extends number = number> = Readonly<{
  checksum: string;
  checksumMismatch: string;
  installedMismatch: string;
  missingPrerequisite?: string;
  prerequisiteMismatch?: string;
  source: string;
  version: Version;
}>;

export function durableStorageMigrationChecksum(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function workspaceSourceMigrationChecksumV1(source: string) {
  return durableStorageMigrationChecksum(source);
}

export function renderSessionMigrationChecksumV2(source: string) {
  return durableStorageMigrationChecksum(source);
}
export const WORKSPACE_SOURCE_MIGRATION_V1_SOURCE = workspaceSourceSqlV1;
export const RENDER_SESSION_MIGRATION_V2_SOURCE = renderSessionSqlV2;
export const SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE = snapshotPublicationSqlV3;

const workspaceSourceMigrationV1: DurableStorageMigration<1> = Object.freeze({
  checksum: WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM,
  checksumMismatch: "The workspace/source migration checksum is invalid.",
  installedMismatch: "The installed workspace/source schema does not match migration v1.",
  source: WORKSPACE_SOURCE_MIGRATION_V1_SOURCE,
  version: 1,
});

const renderSessionMigrationV2: DurableStorageMigration<2> = Object.freeze({
  checksum: RENDER_SESSION_MIGRATION_V2_CHECKSUM,
  checksumMismatch: "The render-session migration checksum is invalid.",
  installedMismatch: "The installed render-session schema does not match migration v2.",
  missingPrerequisite: "Render-session migration v2 requires workspace/source migration v1.",
  prerequisiteMismatch: "Render-session migration v2 requires an exact workspace/source migration v1.",
  source: RENDER_SESSION_MIGRATION_V2_SOURCE,
  version: 2,
});

const snapshotPublicationMigrationV3: DurableStorageMigration<3> = Object.freeze({
  checksum: SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM,
  checksumMismatch: "The snapshot-publication migration checksum is invalid.",
  installedMismatch: "The installed snapshot-publication schema does not match migration v3.",
  missingPrerequisite: "Snapshot-publication migration v3 requires durable storage migrations v1 and v2.",
  prerequisiteMismatch: "Snapshot-publication migration v3 requires exact durable storage migrations v1 and v2.",
  source: SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE,
  version: 3,
});

const BUNDLED_DURABLE_STORAGE_MIGRATIONS = Object.freeze([
  workspaceSourceMigrationV1,
  renderSessionMigrationV2,
  snapshotPublicationMigrationV3,
]);

function validateSource(migration: DurableStorageMigration) {
  if (durableStorageMigrationChecksum(migration.source) !== migration.checksum) {
    throw new TypeError(migration.checksumMismatch);
  }
}

async function applyMigration<Version extends number>(
  pool: Pool,
  migration: DurableStorageMigration<Version>,
  prerequisites: readonly DurableStorageMigration[],
) {
  validateSource(migration);
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [DURABLE_STORAGE_MIGRATION_LOCK]);
    const table = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('public.poietra_schema_migrations')::text AS relation",
    );
    const relation = table.rows[0]?.relation;
    if (relation === undefined) throw new Error(migration.installedMismatch);
    if (relation === null && migration.version !== 1) {
      throw new Error(migration.missingPrerequisite);
    }

    if (relation !== null) {
      const installed = await client.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version <= $1 ORDER BY version",
        [migration.version],
      );
      for (const prerequisite of prerequisites) {
        const row = installed.rows.find(({ version }) => version === prerequisite.version);
        if (row?.checksum !== prerequisite.checksum) throw new Error(migration.prerequisiteMismatch);
      }
      const current = installed.rows.find(({ version }) => version === migration.version);
      if (current) {
        if (current.checksum !== migration.checksum) throw new Error(migration.installedMismatch);
        await client.query("COMMIT");
        began = false;
        return { applied: false, version: migration.version } as const;
      }
      if (migration.version === 1) throw new Error(migration.installedMismatch);
    }

    await client.query(migration.source);
    await client.query("INSERT INTO public.poietra_schema_migrations (version, checksum) VALUES ($1, $2)", [
      migration.version,
      migration.checksum,
    ]);
    await client.query("COMMIT");
    began = false;
    return { applied: true, version: migration.version } as const;
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function applyBundledWorkspaceSourceMigrationV1(pool: Pool) {
  return applyMigration(pool, workspaceSourceMigrationV1, []);
}

export function applyWorkspaceSourceMigrationV1(pool: Pool, source: string) {
  return applyMigration(pool, { ...workspaceSourceMigrationV1, source }, []);
}

export function applyRenderSessionMigrationV2(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderSessionMigrationV2, source }, [workspaceSourceMigrationV1]);
}

export function applySnapshotPublicationMigrationV3(pool: Pool, source: string) {
  return applyMigration(pool, { ...snapshotPublicationMigrationV3, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
  ]);
}

/** Apply every bundled migration in version order without encoding the count in the public API. */
export async function applyBundledDurableStorageMigrations(pool: Pool) {
  let result: Readonly<{ applied: boolean; version: number }> | undefined;
  for (const [index, migration] of BUNDLED_DURABLE_STORAGE_MIGRATIONS.entries()) {
    result = await applyMigration(pool, migration, BUNDLED_DURABLE_STORAGE_MIGRATIONS.slice(0, index));
  }
  if (!result) throw new Error("No durable storage migrations are bundled.");
  return result;
}

/** @deprecated Use applyBundledDurableStorageMigrations. */
export async function applyBundledDurableStorageMigrationsV2(pool: Pool) {
  await applyMigration(pool, workspaceSourceMigrationV1, []);
  return applyMigration(pool, renderSessionMigrationV2, [workspaceSourceMigrationV1]);
}
