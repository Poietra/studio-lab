import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import { manimProjectIdSchema } from "../../../src/render-pipeline/contracts";
import { HttpError } from "../../http/json";
import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  assertProjectPngReceiptV1,
  type ProjectPngBlobReceiptV1,
  type ProjectPngDeletionV1,
  type ProjectPngHeadV1,
  type ProjectPngRepositoryV1,
} from "../project-png-storage";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

export const PROJECT_PNG_MIGRATION_V5_CHECKSUM = "8e0c02f355a0a88a50e89e2075e5d1fdade76c83eeb494aee41f32facb04beb2";

const MAX_GENERATION = 9_223_372_036_854_775_807n;

type ReceiptRow = QueryResultRow & {
  byte_size: number;
  digest: string;
  etag: string;
  object_key: string;
  version_id: string;
};

type HeadRow = ReceiptRow & {
  generation: string;
  project_id: string;
  tenant_id: string;
};

type DeletionRow = ReceiptRow & {
  deletion_id: string;
  project_id: string;
  tenant_id: string;
};

const RECEIPT_COLUMNS = "digest, object_key, version_id, etag, byte_size";

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

function boundedMaximum(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) {
    throw new RangeError("maximum must be an integer between 1 and 256.");
  }
  return value;
}

function generation(value: bigint) {
  if (typeof value !== "bigint" || value < 1n || value > MAX_GENERATION) {
    throw new TypeError("Project image.png generation is invalid.");
  }
  return value;
}

function receiptFromRow(tenant: string, project: string, row: ReceiptRow) {
  return assertProjectPngReceiptV1(tenant, project, {
    byteSize: row.byte_size,
    digest: row.digest,
    etag: row.etag,
    objectKey: row.object_key,
    versionId: row.version_id,
  });
}

function headFromRow(row: HeadRow): ProjectPngHeadV1 {
  const tenant = tenantId(row.tenant_id);
  const project = projectId(row.project_id);
  return {
    generation: generation(BigInt(row.generation)),
    projectId: project,
    receipt: receiptFromRow(tenant, project, row),
    tenantId: tenant,
  };
}

function deletionFromRow(row: DeletionRow, expectedTenant: string): ProjectPngDeletionV1 {
  const tenant = tenantId(row.tenant_id);
  if (tenant !== expectedTenant) throw new TypeError("PostgreSQL returned an image.png deletion for another tenant.");
  const project = projectId(row.project_id);
  if (!/^[0-9a-f-]{36}$/.test(row.deletion_id)) {
    throw new TypeError("PostgreSQL returned an invalid image.png deletion ID.");
  }
  return {
    deletionId: row.deletion_id,
    projectId: project,
    receipt: receiptFromRow(tenant, project, row),
    tenantId: tenant,
  };
}

function sameReceipt(left: ProjectPngBlobReceiptV1, right: ProjectPngBlobReceiptV1) {
  return (
    left.byteSize === right.byteSize &&
    left.digest === right.digest &&
    left.etag === right.etag &&
    left.objectKey === right.objectKey &&
    left.versionId === right.versionId
  );
}

/** PostgreSQL authority for project image.png replacement, render pinning, and deletion claims. */
export class PostgresProjectPngRepositoryV1 implements ProjectPngRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    const result = await this.#connection.query<{ checksum: string }>(
      "SELECT checksum FROM public.poietra_schema_migrations WHERE version = 5",
      [],
      signal,
    );
    return result.rowCount === 1 && result.rows[0]?.checksum === PROJECT_PNG_MIGRATION_V5_CHECKSUM;
  }

  async #readHead(client: PoolClient, tenant: string, project: string, lock = false) {
    const result = await client.query<HeadRow>(
      `SELECT h.tenant_id, h.project_id, h.generation::text AS generation,
              o.digest, o.object_key, o.version_id, o.etag, o.byte_size
         FROM public.project_png_heads h
         JOIN public.project_png_objects o
           ON o.tenant_id = h.tenant_id AND o.project_id = h.project_id
          AND o.generation = h.generation AND o.digest = h.digest
        WHERE h.tenant_id = $1 AND h.project_id = $2
        ${lock ? "FOR UPDATE OF h" : ""}`,
      [tenant, project],
    );
    return result.rows[0] ? headFromRow(result.rows[0]) : null;
  }

  async compareAndSwapHead(
    input: Readonly<{
      candidate: ProjectPngBlobReceiptV1;
      expected: Readonly<{ digest: string; generation: bigint }> | null;
      projectId: string;
      tenantId: string;
    }>,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(input.tenantId);
    const project = projectId(input.projectId);
    const candidate = assertProjectPngReceiptV1(tenant, project, input.candidate);
    const expected = input.expected
      ? { digest: input.expected.digest, generation: generation(input.expected.generation) }
      : null;
    if (expected && !/^[0-9a-f]{64}$/.test(expected.digest)) {
      throw new TypeError("Expected project image.png digest is invalid.");
    }
    return this.#connection.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`project-png:${tenant}:${project}`]);
      const active = await client.query(
        `SELECT 1 FROM public.workspace_projects
          WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [tenant, project],
      );
      if (active.rowCount !== 1) throw new HttpError("Managed project not found.", 404);
      const current = await this.#readHead(client, tenant, project, true);
      if (
        (expected === null && current !== null) ||
        (expected !== null &&
          (current === null ||
            current.generation !== expected.generation ||
            current.receipt.digest !== expected.digest))
      ) {
        throw new HttpError("Project image.png changed before replacement.", 409);
      }
      if (current && sameReceipt(current.receipt, candidate)) return current;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `project-png-object:${tenant}:${candidate.objectKey}:${candidate.versionId}`,
      ]);
      const deleting = await client.query(
        `SELECT 1 FROM public.project_png_deletions
          WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3`,
        [tenant, candidate.objectKey, candidate.versionId],
      );
      if (deleting.rowCount !== 0) throw new HttpError("Project image.png candidate is queued for deletion.", 409);
      const nextGeneration = current ? current.generation + 1n : 1n;
      generation(nextGeneration);
      await client.query(
        `INSERT INTO public.project_png_objects
           (tenant_id, project_id, generation, digest, object_key, version_id, etag, byte_size)
         VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, $8)`,
        [
          tenant,
          project,
          nextGeneration.toString(),
          candidate.digest,
          candidate.objectKey,
          candidate.versionId,
          candidate.etag,
          candidate.byteSize,
        ],
      );
      await client.query(
        `INSERT INTO public.project_png_heads (tenant_id, project_id, generation, digest)
         VALUES ($1, $2, $3::bigint, $4)
         ON CONFLICT (tenant_id, project_id) DO UPDATE
           SET generation = EXCLUDED.generation, digest = EXCLUDED.digest, updated_at = clock_timestamp()`,
        [tenant, project, nextGeneration.toString(), candidate.digest],
      );
      const created = await this.#readHead(client, tenant, project);
      if (!created || !sameReceipt(created.receipt, candidate)) {
        throw new Error("PostgreSQL did not retain the project image.png replacement.");
      }
      return created;
    }, signal);
  }

  async readHead(tenantValue: string, projectValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    return this.#connection.withClient((client) => this.#readHead(client, tenant, project), signal);
  }

  async isVersionRetained(
    tenantValue: string,
    projectValue: string,
    receiptValue: ProjectPngBlobReceiptV1,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    const receipt = assertProjectPngReceiptV1(tenant, project, receiptValue);
    const result = await this.#connection.query(
      `SELECT 1
         FROM public.project_png_objects o
        WHERE o.tenant_id = $1 AND o.project_id = $2
          AND o.digest = $3 AND o.object_key = $4 AND o.version_id = $5
          AND o.etag = $6 AND o.byte_size = $7
          AND (
            EXISTS (
              SELECT 1 FROM public.project_png_heads h
               WHERE h.tenant_id = o.tenant_id AND h.project_id = o.project_id
                 AND h.generation = o.generation AND h.digest = o.digest
            ) OR EXISTS (
              SELECT 1 FROM public.render_sessions s
               WHERE s.tenant_id = o.tenant_id AND s.project_id = o.project_id
                 AND s.project_png_generation = o.generation AND s.project_png_digest = o.digest
            )
          )`,
      [tenant, project, receipt.digest, receipt.objectKey, receipt.versionId, receipt.etag, receipt.byteSize],
      signal,
    );
    return result.rowCount === 1;
  }

  async queueDeletion(
    tenantValue: string,
    projectValue: string,
    receiptValue: ProjectPngBlobReceiptV1,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    const receipt = assertProjectPngReceiptV1(tenant, project, receiptValue);
    return this.#connection.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `project-png-object:${tenant}:${receipt.objectKey}:${receipt.versionId}`,
      ]);
      const storedObject = await client.query<ReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS}
           FROM public.project_png_objects
          WHERE tenant_id = $1 AND project_id = $2 AND object_key = $3 AND version_id = $4
          FOR UPDATE`,
        [tenant, project, receipt.objectKey, receipt.versionId],
      );
      const registered = storedObject.rows[0];
      if (registered && !sameReceipt(receiptFromRow(tenant, project, registered), receipt)) {
        throw new Error("The registered image.png object version is bound to different metadata.");
      }
      const retained = await client.query(
        `SELECT 1
           FROM public.project_png_objects o
          WHERE o.tenant_id = $1 AND o.project_id = $2
            AND o.object_key = $3 AND o.version_id = $4
            AND (
              EXISTS (
                SELECT 1 FROM public.project_png_heads h
                 WHERE h.tenant_id = o.tenant_id AND h.project_id = o.project_id
                   AND h.generation = o.generation AND h.digest = o.digest
              ) OR EXISTS (
                SELECT 1 FROM public.render_sessions s
                 WHERE s.tenant_id = o.tenant_id AND s.project_id = o.project_id
                   AND s.project_png_generation = o.generation AND s.project_png_digest = o.digest
              )
            )
          FOR KEY SHARE OF o`,
        [tenant, project, receipt.objectKey, receipt.versionId],
      );
      if (retained.rowCount !== 0) return null;
      await client.query(
        `DELETE FROM public.project_png_objects
          WHERE tenant_id = $1 AND project_id = $2
            AND digest = $3 AND object_key = $4 AND version_id = $5 AND etag = $6 AND byte_size = $7`,
        [tenant, project, receipt.digest, receipt.objectKey, receipt.versionId, receipt.etag, receipt.byteSize],
      );
      await client.query(
        `INSERT INTO public.project_png_deletions
           (tenant_id, deletion_id, project_id, digest, object_key, version_id, etag, byte_size)
         VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, object_key, version_id) DO NOTHING`,
        [tenant, project, receipt.digest, receipt.objectKey, receipt.versionId, receipt.etag, receipt.byteSize],
      );
      const stored = await client.query<DeletionRow>(
        `SELECT tenant_id, deletion_id::text AS deletion_id, project_id, ${RECEIPT_COLUMNS}
           FROM public.project_png_deletions
          WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3
          FOR UPDATE`,
        [tenant, receipt.objectKey, receipt.versionId],
      );
      const deletion = stored.rows[0] ? deletionFromRow(stored.rows[0], tenant) : null;
      if (!deletion || !sameReceipt(deletion.receipt, receipt) || deletion.projectId !== project) {
        throw new Error("An image.png deletion claim is bound to different metadata.");
      }
      return deletion;
    }, signal);
  }

  async pendingDeletions(tenantValue: string, maximumValue: number, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const maximum = boundedMaximum(maximumValue);
    const result = await this.#connection.query<DeletionRow>(
      `SELECT tenant_id, deletion_id::text AS deletion_id, project_id, ${RECEIPT_COLUMNS}
         FROM public.project_png_deletions
        WHERE tenant_id = $1 AND deleted_at IS NULL
        ORDER BY queued_at, deletion_id
        LIMIT $2`,
      [tenant, maximum],
      signal,
    );
    return result.rows.map((row) => deletionFromRow(row, tenant));
  }

  async acknowledgeDeletion(tenantValue: string, deletionId: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    if (!/^[0-9a-f-]{36}$/.test(deletionId)) throw new TypeError("Image.png deletion ID is invalid.");
    await this.#connection.query(
      `UPDATE public.project_png_deletions
          SET deleted_at = COALESCE(deleted_at, clock_timestamp())
        WHERE tenant_id = $1 AND deletion_id = $2::uuid`,
      [tenant, deletionId],
      signal,
    );
  }

  close() {
    return this.#connection.close();
  }
}
