import { createHash } from "node:crypto";

import type { Pool } from "pg";
import { DURABLE_RETENTION_MIGRATION_V6_CHECKSUM } from "./durable-retention-schema";
import workspaceSourceSqlV1 from "./migrations/0001_workspace_source.sql?raw";
import renderSessionSqlV2 from "./migrations/0002_render_sessions.sql?raw";
import snapshotPublicationSqlV3 from "./migrations/0003_snapshot_publications.sql?raw";
import renderArtifactSqlV4 from "./migrations/0004_render_artifacts.sql?raw";
import projectPngSqlV5 from "./migrations/0005_project_png.sql?raw";
import renderSessionRetentionSqlV6 from "./migrations/0006_render_session_retention.sql?raw";
import renderCancellationSqlV7 from "./migrations/0007_render_cancellations.sql?raw";
import renderSessionFailureSqlV8 from "./migrations/0008_render_failure_codes.sql?raw";
import renderSessionCpuFailureSqlV9 from "./migrations/0009_render_cpu_limit.sql?raw";
import snapshotRuntimeDigestSqlV10 from "./migrations/0010_snapshot_runtime_digest.sql?raw";
import { RENDER_ARTIFACT_MIGRATION_V4_CHECKSUM } from "./postgres-artifact-repository";
import { PROJECT_PNG_MIGRATION_V5_CHECKSUM } from "./postgres-project-png-repository";
import { RENDER_SESSION_MIGRATION_V2_CHECKSUM } from "./postgres-render-session-repository";
import { SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM } from "./postgres-snapshot-publication-repository";
import { WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM } from "./postgres-workspace-source-repository";
import { RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM } from "./render-cancellation-schema";
import { RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM } from "./render-session-cpu-failure-schema";
import { RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM } from "./render-session-failure-schema";
import { SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM } from "./snapshot-runtime-digest-schema";

export { SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM } from "./postgres-snapshot-publication-repository";
export { RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM } from "./render-cancellation-schema";
export { RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM } from "./render-session-cpu-failure-schema";
export { RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM } from "./render-session-failure-schema";
export { SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM } from "./snapshot-runtime-digest-schema";

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
export const RENDER_ARTIFACT_MIGRATION_V4_SOURCE = renderArtifactSqlV4;
export const PROJECT_PNG_MIGRATION_V5_SOURCE = projectPngSqlV5;
export const RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE = renderSessionRetentionSqlV6;
export const RENDER_CANCELLATION_MIGRATION_V7_SOURCE = renderCancellationSqlV7;
export const RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE = renderSessionFailureSqlV8;
export const RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE = renderSessionCpuFailureSqlV9;
export const SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE = snapshotRuntimeDigestSqlV10;

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

const renderArtifactMigrationV4: DurableStorageMigration<4> = Object.freeze({
  checksum: RENDER_ARTIFACT_MIGRATION_V4_CHECKSUM,
  checksumMismatch: "The render-artifact migration checksum is invalid.",
  installedMismatch: "The installed render-artifact schema does not match migration v4.",
  missingPrerequisite: "Render-artifact migration v4 requires durable storage migrations v1 through v3.",
  prerequisiteMismatch: "Render-artifact migration v4 requires exact durable storage migrations v1 through v3.",
  source: RENDER_ARTIFACT_MIGRATION_V4_SOURCE,
  version: 4,
});

const projectPngMigrationV5: DurableStorageMigration<5> = Object.freeze({
  checksum: PROJECT_PNG_MIGRATION_V5_CHECKSUM,
  checksumMismatch: "The project image.png migration checksum is invalid.",
  installedMismatch: "The installed project image.png schema does not match migration v5.",
  missingPrerequisite: "Project image.png migration v5 requires durable storage migrations v1 through v4.",
  prerequisiteMismatch: "Project image.png migration v5 requires exact durable storage migrations v1 through v4.",
  source: PROJECT_PNG_MIGRATION_V5_SOURCE,
  version: 5,
});

const renderSessionRetentionMigrationV6: DurableStorageMigration<6> = Object.freeze({
  checksum: DURABLE_RETENTION_MIGRATION_V6_CHECKSUM,
  checksumMismatch: "The render-session retention migration checksum is invalid.",
  installedMismatch: "The installed render-session retention schema does not match migration v6.",
  missingPrerequisite: "Render-session retention migration v6 requires durable storage migrations v1 through v5.",
  prerequisiteMismatch:
    "Render-session retention migration v6 requires exact durable storage migrations v1 through v5.",
  source: RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE,
  version: 6,
});

const renderCancellationMigrationV7: DurableStorageMigration<7> = Object.freeze({
  checksum: RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM,
  checksumMismatch: "The render-cancellation migration checksum is invalid.",
  installedMismatch: "The installed render-cancellation schema does not match migration v7.",
  missingPrerequisite: "Render-cancellation migration v7 requires durable storage migrations v1 through v6.",
  prerequisiteMismatch: "Render-cancellation migration v7 requires exact durable storage migrations v1 through v6.",
  source: RENDER_CANCELLATION_MIGRATION_V7_SOURCE,
  version: 7,
});

const renderSessionFailureMigrationV8: DurableStorageMigration<8> = Object.freeze({
  checksum: RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM,
  checksumMismatch: "The render-session failure migration checksum is invalid.",
  installedMismatch: "The installed render-session failure schema does not match migration v8.",
  missingPrerequisite: "Render-session failure migration v8 requires durable storage migrations v1 through v7.",
  prerequisiteMismatch: "Render-session failure migration v8 requires exact durable storage migrations v1 through v7.",
  source: RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE,
  version: 8,
});

const renderSessionCpuFailureMigrationV9: DurableStorageMigration<9> = Object.freeze({
  checksum: RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM,
  checksumMismatch: "The render-session CPU failure migration checksum is invalid.",
  installedMismatch: "The installed render-session CPU failure schema does not match migration v9.",
  missingPrerequisite: "Render-session CPU failure migration v9 requires durable storage migrations v1 through v8.",
  prerequisiteMismatch:
    "Render-session CPU failure migration v9 requires exact durable storage migrations v1 through v8.",
  source: RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE,
  version: 9,
});

const snapshotRuntimeDigestMigrationV10: DurableStorageMigration<10> = Object.freeze({
  checksum: SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM,
  checksumMismatch: "The snapshot runtime-digest migration checksum is invalid.",
  installedMismatch: "The installed snapshot runtime-digest schema does not match migration v10.",
  missingPrerequisite: "Snapshot runtime-digest migration v10 requires durable storage migrations v1 through v9.",
  prerequisiteMismatch:
    "Snapshot runtime-digest migration v10 requires exact durable storage migrations v1 through v9.",
  source: SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE,
  version: 10,
});

const BUNDLED_DURABLE_STORAGE_MIGRATIONS = Object.freeze([
  workspaceSourceMigrationV1,
  renderSessionMigrationV2,
  snapshotPublicationMigrationV3,
  renderArtifactMigrationV4,
  projectPngMigrationV5,
  renderSessionRetentionMigrationV6,
  renderCancellationMigrationV7,
  renderSessionFailureMigrationV8,
  renderSessionCpuFailureMigrationV9,
  snapshotRuntimeDigestMigrationV10,
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

export function applyRenderArtifactMigrationV4(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderArtifactMigrationV4, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
  ]);
}

export function applyProjectPngMigrationV5(pool: Pool, source: string) {
  return applyMigration(pool, { ...projectPngMigrationV5, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
  ]);
}

export function applyRenderSessionRetentionMigrationV6(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderSessionRetentionMigrationV6, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
  ]);
}

export function applyRenderCancellationMigrationV7(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderCancellationMigrationV7, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
  ]);
}

export function applyRenderSessionFailureMigrationV8(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderSessionFailureMigrationV8, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
    renderCancellationMigrationV7,
  ]);
}

export function applyRenderSessionCpuFailureMigrationV9(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderSessionCpuFailureMigrationV9, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
    renderCancellationMigrationV7,
    renderSessionFailureMigrationV8,
  ]);
}

export function applySnapshotRuntimeDigestMigrationV10(pool: Pool, source: string) {
  return applyMigration(pool, { ...snapshotRuntimeDigestMigrationV10, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
    renderCancellationMigrationV7,
    renderSessionFailureMigrationV8,
    renderSessionCpuFailureMigrationV9,
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
