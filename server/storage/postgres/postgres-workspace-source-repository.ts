import { randomUUID } from "node:crypto";

import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

import {
  type ManimProjectListView,
  manimProjectIdSchema,
  manimProjectNameSchema,
  manimSourcePathSchema,
} from "../../../src/render-pipeline/contracts";
import { HttpError } from "../../http/json";
import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  type BlobDeletionV1,
  MAX_MANAGED_PROJECTS_PER_TENANT_V1,
  MAX_MANIM_SOURCE_BYTES_V1,
  type SourceBlobReceiptV1,
  type WorkspaceSourceHeadV1,
  type WorkspaceSourceProjectV1,
  type WorkspaceSourceRepositoryV1,
} from "../workspace-source-repository";

export const WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM =
  "37de2a61d4de468f5d090d5c3adcb17f7366cba70ea1ebb2fb9c680ee4e6aa94";

type ProjectRow = QueryResultRow & {
  created_at: Date;
  display_name: string;
  project_id: string;
  tenant_id: string;
  updated_at: Date;
};

type SourceHeadRow = QueryResultRow & {
  byte_size: number;
  digest: string;
  etag: string;
  generation: string;
  object_key: string;
  project_id: string;
  source_path: string;
  tenant_id: string;
  version_id: string;
};

type BlobRow = QueryResultRow & {
  byte_size: number;
  digest: string;
  etag: string;
  object_key: string;
  tenant_id: string;
  version_id: string;
};

type DeletionRow = BlobRow & { deletion_id: string };

const SOURCE_HEAD_COLUMNS = `
  h.tenant_id,
  h.project_id,
  h.source_path,
  h.generation::text AS generation,
  b.digest,
  b.object_key,
  b.version_id,
  b.etag,
  b.byte_size
`;
const MAX_INCREMENTABLE_SOURCE_GENERATION_V1 = 9_223_372_036_854_775_806n;

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function boundedPositiveInteger(value: number, name: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function tenantId(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Tenant ID is invalid.");
  return parsed.data;
}

function projectId(value: string) {
  const parsed = manimProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Project ID is invalid.");
  return parsed.data;
}

function projectName(value: string) {
  const parsed = manimProjectNameSchema.safeParse(value);
  if (!parsed.success) throw new HttpError("Workspace name must contain 1 to 120 characters.", 400);
  return parsed.data;
}

function sourcePath(value: string) {
  const parsed = manimSourcePathSchema.safeParse(value);
  if (!parsed.success) throw new HttpError("The source path is invalid.", 400);
  return parsed.data;
}

function sourceDigest(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError("Source digest is invalid.");
  return value;
}

function blobReceipt(tenant: string, value: SourceBlobReceiptV1): SourceBlobReceiptV1 {
  const digest = sourceDigest(value.digest);
  const expectedKey = `tenants/${tenant}/sources/${digest}`;
  if (
    value.objectKey !== expectedKey ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 0 ||
    value.byteSize > MAX_MANIM_SOURCE_BYTES_V1 ||
    value.versionId.length < 1 ||
    value.versionId.length > 1_024 ||
    value.etag.length < 1 ||
    value.etag.length > 512
  ) {
    throw new TypeError("Source blob receipt is invalid.");
  }
  return { ...value, digest, objectKey: expectedKey };
}

function projectFromRow(row: ProjectRow): WorkspaceSourceProjectV1 {
  if (!(row.created_at instanceof Date) || !(row.updated_at instanceof Date)) {
    throw new TypeError("PostgreSQL returned invalid workspace timestamps.");
  }
  return {
    createdAt: row.created_at,
    name: row.display_name,
    projectId: row.project_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function blobFromRow(row: BlobRow): SourceBlobReceiptV1 {
  return {
    byteSize: row.byte_size,
    digest: row.digest,
    etag: row.etag,
    objectKey: row.object_key,
    versionId: row.version_id,
  };
}

function headFromRow(row: SourceHeadRow): WorkspaceSourceHeadV1 {
  const generation = BigInt(row.generation);
  if (generation <= 0n) throw new TypeError("PostgreSQL returned an invalid source generation.");
  return {
    blob: blobFromRow(row),
    generation,
    projectId: row.project_id,
    sourcePath: row.source_path,
    tenantId: row.tenant_id,
  };
}

function deletionFromRow(row: DeletionRow): BlobDeletionV1 {
  return { blob: blobFromRow(row), deletionId: row.deletion_id, tenantId: row.tenant_id };
}

function isPostgresError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

export class PostgresWorkspaceSourceRepositoryV1 implements WorkspaceSourceRepositoryV1 {
  readonly #ownsPool: boolean;
  readonly #pool: Pool;
  readonly #statementTimeoutMs: number;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    if ((options.pool === undefined) === (options.poolConfig === undefined)) {
      throw new TypeError("Provide exactly one PostgreSQL pool or pool configuration.");
    }
    this.#pool = options.pool ?? new Pool(options.poolConfig);
    this.#ownsPool = options.pool === undefined;
    this.#statementTimeoutMs = boundedPositiveInteger(
      options.statementTimeoutMs ?? 5_000,
      "statementTimeoutMs",
      30_000,
    );
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>, signal?: AbortSignal) {
    throwIfAborted(signal);
    const client = await this.#pool.connect();
    let began = false;
    try {
      throwIfAborted(signal);
      await client.query("BEGIN");
      began = true;
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(this.#statementTimeoutMs)]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [String(this.#statementTimeoutMs)]);
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
        String(this.#statementTimeoutMs),
      ]);
      const result = await operation(client);
      throwIfAborted(signal);
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #registerBlob(client: PoolClient, tenant: string, candidateValue: SourceBlobReceiptV1) {
    const candidate = blobReceipt(tenant, candidateValue);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenant}:${candidate.digest}`]);
    const deleting = await client.query(
      `SELECT 1 FROM source_blob_deletions
        WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3`,
      [tenant, candidate.objectKey, candidate.versionId],
    );
    if (deleting.rowCount !== 0) throw new HttpError("The source candidate is no longer available.", 409);
    const inserted = await client.query<BlobRow>(
      `INSERT INTO source_blob_objects
         (tenant_id, digest, object_key, version_id, etag, byte_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, digest) DO NOTHING
       RETURNING tenant_id, digest, object_key, version_id, etag, byte_size`,
      [tenant, candidate.digest, candidate.objectKey, candidate.versionId, candidate.etag, candidate.byteSize],
    );
    if (inserted.rowCount === 1) return candidate;
    const existing = await client.query<BlobRow>(
      `SELECT tenant_id, digest, object_key, version_id, etag, byte_size
         FROM source_blob_objects
        WHERE tenant_id = $1 AND digest = $2
        FOR KEY SHARE`,
      [tenant, candidate.digest],
    );
    const row = existing.rows[0];
    if (!row || row.object_key !== candidate.objectKey || row.byte_size !== candidate.byteSize) {
      throw new TypeError("The stored source blob metadata conflicts with its digest.");
    }
    return blobFromRow(row);
  }

  async ready(signal?: AbortSignal) {
    try {
      throwIfAborted(signal);
      const result = await this.#pool.query<{ checksum: string }>(
        "SELECT checksum FROM poietra_schema_migrations WHERE version = 1",
      );
      throwIfAborted(signal);
      return result.rowCount === 1 && result.rows[0]?.checksum === WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM;
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async ensureTenant(tenantValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    throwIfAborted(signal);
    await this.#pool.query("INSERT INTO workspace_tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [tenant]);
    throwIfAborted(signal);
  }

  async isBlobVersionPublished(tenantValue: string, blobValue: SourceBlobReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const blob = blobReceipt(tenant, blobValue);
    throwIfAborted(signal);
    const result = await this.#pool.query(
      `SELECT 1 FROM source_blob_objects
        WHERE tenant_id = $1 AND digest = $2 AND object_key = $3 AND version_id = $4`,
      [tenant, blob.digest, blob.objectKey, blob.versionId],
    );
    throwIfAborted(signal);
    return result.rowCount === 1;
  }

  async queueBlobDeletion(tenantValue: string, blobValue: SourceBlobReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const blob = blobReceipt(tenant, blobValue);
    return this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenant}:${blob.digest}`]);
      const published = await client.query(
        `SELECT 1 FROM source_blob_objects
          WHERE tenant_id = $1 AND digest = $2 AND object_key = $3 AND version_id = $4`,
        [tenant, blob.digest, blob.objectKey, blob.versionId],
      );
      if (published.rowCount !== 0) return null;
      const deletionId = randomUUID();
      const queued = await client.query<DeletionRow>(
        `INSERT INTO source_blob_deletions
           (deletion_id, tenant_id, digest, object_key, version_id, etag, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, object_key, version_id) DO UPDATE
           SET object_key = EXCLUDED.object_key
         RETURNING deletion_id, tenant_id, digest, object_key, version_id, etag, byte_size`,
        [deletionId, tenant, blob.digest, blob.objectKey, blob.versionId, blob.etag, blob.byteSize],
      );
      const deletion = deletionFromRow(queued.rows[0]!);
      if (
        deletion.blob.digest !== blob.digest ||
        deletion.blob.etag !== blob.etag ||
        deletion.blob.byteSize !== blob.byteSize
      ) {
        throw new TypeError("The queued source deletion metadata conflicts with its object version.");
      }
      return deletion;
    }, signal);
  }

  async listProjects(tenantValue: string, signal?: AbortSignal): Promise<ManimProjectListView> {
    const tenant = tenantId(tenantValue);
    throwIfAborted(signal);
    const result = await this.#pool.query<ProjectRow>(
      `SELECT tenant_id, project_id, display_name, created_at, updated_at
         FROM workspace_projects
        WHERE tenant_id = $1 AND deleted_at IS NULL
        ORDER BY created_at, project_id
        LIMIT $2`,
      [tenant, MAX_MANAGED_PROJECTS_PER_TENANT_V1],
    );
    throwIfAborted(signal);
    const projects = result.rows.map((row) => ({
      id: row.project_id,
      kind: "managed" as const,
      name: row.display_name,
    }));
    return { defaultProjectId: projects[0]?.id ?? null, projects };
  }

  async createManagedProject(
    input: Parameters<WorkspaceSourceRepositoryV1["createManagedProject"]>[0],
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(input.tenantId);
    const id = projectId(input.projectId);
    const name = projectName(input.name);
    const path = sourcePath(input.source.path);
    const candidate = blobReceipt(tenant, input.source.blob);
    try {
      return await this.#transaction(async (client) => {
        await client.query("INSERT INTO workspace_tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [tenant]);
        await client.query("SELECT tenant_id FROM workspace_tenants WHERE tenant_id = $1 FOR UPDATE", [tenant]);
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM workspace_projects WHERE tenant_id = $1 AND deleted_at IS NULL",
          [tenant],
        );
        if (BigInt(count.rows[0]?.count ?? "0") >= BigInt(MAX_MANAGED_PROJECTS_PER_TENANT_V1)) {
          throw new HttpError("Studio supports at most 64 registered workspaces.", 409);
        }
        await this.#registerBlob(client, tenant, candidate);
        const created = await client.query<ProjectRow>(
          `INSERT INTO workspace_projects (tenant_id, project_id, display_name)
           VALUES ($1, $2, $3)
           RETURNING tenant_id, project_id, display_name, created_at, updated_at`,
          [tenant, id, name],
        );
        await client.query(
          `INSERT INTO workspace_source_heads
             (tenant_id, project_id, source_path, generation, digest)
           VALUES ($1, $2, $3, 1, $4)`,
          [tenant, id, path, candidate.digest],
        );
        return projectFromRow(created.rows[0]!);
      }, signal);
    } catch (error) {
      if (isPostgresError(error, "23505")) throw new HttpError("That workspace already exists.", 409);
      throw error;
    }
  }

  async readProject(tenantValue: string, projectValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const id = projectId(projectValue);
    throwIfAborted(signal);
    const result = await this.#pool.query<ProjectRow>(
      `SELECT tenant_id, project_id, display_name, created_at, updated_at
         FROM workspace_projects
        WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [tenant, id],
    );
    throwIfAborted(signal);
    if (result.rowCount !== 1) throw new HttpError("Configured Manim project not found.", 404);
    return projectFromRow(result.rows[0]!);
  }

  async renameProject(tenantValue: string, projectValue: string, nameValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const id = projectId(projectValue);
    const name = projectName(nameValue);
    throwIfAborted(signal);
    const result = await this.#pool.query<ProjectRow>(
      `UPDATE workspace_projects
          SET display_name = $3, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL
        RETURNING tenant_id, project_id, display_name, created_at, updated_at`,
      [tenant, id, name],
    );
    throwIfAborted(signal);
    if (result.rowCount !== 1) throw new HttpError("Configured Manim project not found.", 404);
    return projectFromRow(result.rows[0]!);
  }

  async softDeleteProject(tenantValue: string, projectValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const id = projectId(projectValue);
    await this.#transaction(async (client) => {
      const project = await client.query(
        `SELECT project_id FROM workspace_projects
          WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [tenant, id],
      );
      if (project.rowCount !== 1) throw new HttpError("Configured Manim project not found.", 404);
      const references = await client.query(
        `SELECT 1 FROM workspace_project_references
          WHERE tenant_id = $1 AND project_id = $2
          LIMIT 1`,
        [tenant, id],
      );
      if (references.rowCount !== 0) {
        throw new HttpError("Wait for active workspace work before removing it from Studio.", 409);
      }
      await client.query(
        `UPDATE workspace_projects
            SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND project_id = $2`,
        [tenant, id],
      );
    }, signal);
  }

  async readSourceHead(tenantValue: string, projectValue: string, pathValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const id = projectId(projectValue);
    const path = sourcePath(pathValue);
    throwIfAborted(signal);
    const result = await this.#pool.query<SourceHeadRow>(
      `SELECT ${SOURCE_HEAD_COLUMNS}
         FROM workspace_source_heads h
         JOIN workspace_projects p
           ON p.tenant_id = h.tenant_id AND p.project_id = h.project_id AND p.deleted_at IS NULL
         JOIN source_blob_objects b ON b.tenant_id = h.tenant_id AND b.digest = h.digest
        WHERE h.tenant_id = $1 AND h.project_id = $2 AND h.source_path = $3`,
      [tenant, id, path],
    );
    throwIfAborted(signal);
    if (result.rowCount !== 1) throw new HttpError("Configured Manim source not found.", 404);
    return headFromRow(result.rows[0]!);
  }

  async listSourceHeads(tenantValue: string, projectValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const id = projectId(projectValue);
    throwIfAborted(signal);
    const result = await this.#pool.query<SourceHeadRow>(
      `SELECT ${SOURCE_HEAD_COLUMNS}
         FROM workspace_source_heads h
         JOIN workspace_projects p
           ON p.tenant_id = h.tenant_id AND p.project_id = h.project_id AND p.deleted_at IS NULL
         JOIN source_blob_objects b ON b.tenant_id = h.tenant_id AND b.digest = h.digest
        WHERE h.tenant_id = $1 AND h.project_id = $2
        ORDER BY h.source_path
        LIMIT 512`,
      [tenant, id],
    );
    throwIfAborted(signal);
    if (result.rows.length === 0) await this.readProject(tenant, id, signal);
    return result.rows.map(headFromRow);
  }

  async compareAndSwapSource(
    input: Parameters<WorkspaceSourceRepositoryV1["compareAndSwapSource"]>[0],
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(input.tenantId);
    const id = projectId(input.projectId);
    const path = sourcePath(input.sourcePath);
    const expectedDigest = sourceDigest(input.expectedDigest);
    if (input.expectedGeneration <= 0n || input.expectedGeneration > MAX_INCREMENTABLE_SOURCE_GENERATION_V1) {
      throw new TypeError("Expected source generation is outside the supported PostgreSQL range.");
    }
    const candidate = blobReceipt(tenant, input.candidate);
    return this.#transaction(async (client) => {
      await this.#registerBlob(client, tenant, candidate);
      const updated = await client.query<{ generation: string }>(
        `UPDATE workspace_source_heads h
            SET generation = h.generation + 1,
                digest = $6,
                updated_at = clock_timestamp()
           FROM workspace_projects p
          WHERE h.tenant_id = $1
            AND h.project_id = $2
            AND h.source_path = $3
            AND h.generation = $4::bigint
            AND h.digest = $5
            AND p.tenant_id = h.tenant_id
            AND p.project_id = h.project_id
            AND p.deleted_at IS NULL
        RETURNING h.generation::text AS generation`,
        [tenant, id, path, input.expectedGeneration.toString(), expectedDigest, candidate.digest],
      );
      if (updated.rowCount !== 1) {
        throw new HttpError("The source changed before this update could be published.", 409);
      }
      const stored = await client.query<SourceHeadRow>(
        `SELECT ${SOURCE_HEAD_COLUMNS}
           FROM workspace_source_heads h
           JOIN source_blob_objects b ON b.tenant_id = h.tenant_id AND b.digest = h.digest
          WHERE h.tenant_id = $1 AND h.project_id = $2 AND h.source_path = $3`,
        [tenant, id, path],
      );
      return headFromRow(stored.rows[0]!);
    }, signal);
  }

  async enqueueOrphanBlobDeletions(cutoff: Date, maximumValue: number, signal?: AbortSignal) {
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) throw new TypeError("GC cutoff is invalid.");
    const maximum = boundedPositiveInteger(maximumValue, "maximum", 256);
    return this.#transaction(async (client) => {
      const candidates = await client.query<BlobRow>(
        `SELECT b.tenant_id, b.digest, b.object_key, b.version_id, b.etag, b.byte_size
           FROM source_blob_objects b
          WHERE b.created_at < $1
            AND NOT EXISTS (
              SELECT 1 FROM workspace_source_heads h
               WHERE h.tenant_id = b.tenant_id AND h.digest = b.digest
            )
          ORDER BY b.created_at, b.tenant_id, b.digest
          FOR UPDATE SKIP LOCKED
          LIMIT $2`,
        [cutoff, maximum],
      );
      const queued: BlobDeletionV1[] = [];
      for (const row of candidates.rows) {
        const removed = await client.query(
          `DELETE FROM source_blob_objects b
            WHERE b.tenant_id = $1 AND b.digest = $2
              AND NOT EXISTS (
                SELECT 1 FROM workspace_source_heads h
                 WHERE h.tenant_id = b.tenant_id AND h.digest = b.digest
              )`,
          [row.tenant_id, row.digest],
        );
        if (removed.rowCount !== 1) continue;
        const deletionId = randomUUID();
        const inserted = await client.query<DeletionRow>(
          `INSERT INTO source_blob_deletions
             (deletion_id, tenant_id, digest, object_key, version_id, etag, byte_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING deletion_id, tenant_id, digest, object_key, version_id, etag, byte_size`,
          [deletionId, row.tenant_id, row.digest, row.object_key, row.version_id, row.etag, row.byte_size],
        );
        queued.push(deletionFromRow(inserted.rows[0]!));
      }
      return queued;
    }, signal);
  }

  async pendingBlobDeletions(maximumValue: number, signal?: AbortSignal) {
    const maximum = boundedPositiveInteger(maximumValue, "maximum", 256);
    throwIfAborted(signal);
    const result = await this.#pool.query<DeletionRow>(
      `SELECT deletion_id, tenant_id, digest, object_key, version_id, etag, byte_size
         FROM source_blob_deletions
        ORDER BY queued_at, deletion_id
        LIMIT $1`,
      [maximum],
    );
    throwIfAborted(signal);
    return result.rows.map(deletionFromRow);
  }

  async acknowledgeBlobDeletion(tenantValue: string, deletionId: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    if (!/^[0-9a-f-]{36}$/.test(deletionId)) throw new TypeError("Blob deletion ID is invalid.");
    throwIfAborted(signal);
    await this.#pool.query("DELETE FROM source_blob_deletions WHERE tenant_id = $1 AND deletion_id = $2", [
      tenant,
      deletionId,
    ]);
    throwIfAborted(signal);
  }

  async close() {
    if (this.#ownsPool) await this.#pool.end();
  }
}
