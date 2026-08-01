import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import { manimProjectIdSchema } from "../../../src/render-pipeline/contracts";
import { HttpError } from "../../http/json";
import { manimTenantIdSchema } from "../../manim-request-principal";
import { MAX_DURABLE_GC_GRACE_MS_V1, MIN_DURABLE_GC_GRACE_MS_V1 } from "../durable-gc-core";
import {
  assertProjectPngReceiptV1,
  type ProjectPngBlobReceiptV1,
  type ProjectPngDeletionV1,
  type ProjectPngHeadV1,
  type ProjectPngRepositoryV1,
  projectPngLocatorIdentityV1,
  sameProjectPngReceiptV1,
} from "../project-png-storage";
import { DURABLE_RETENTION_MIGRATION_V6_CHECKSUM } from "./durable-retention-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";
import {
  type PostgresStorageObjectLocatorRowV1,
  storageObjectLocatorFromRowV1,
  storageObjectLocatorJoinSqlV1,
  storageObjectLocatorPredicateSqlV1,
  storageObjectLocatorSqlValuesV1,
} from "./postgres-storage-object-locator";

export const PROJECT_PNG_MIGRATION_V5_CHECKSUM = "5366292bd9f2ef2a575e2de9573c5d76b7e8e2f17510966265861ad673a608a0";

const MAX_GENERATION = 9_223_372_036_854_775_807n;

type ReceiptRow = QueryResultRow &
  PostgresStorageObjectLocatorRowV1 & {
    byte_size: number;
    digest: string;
    etag: string;
    object_key: string;
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

type GenerationRetentionRow = QueryResultRow & {
  generation: string;
  mature: boolean;
  orphaned_at: Date | null;
  retained: boolean;
};

const RECEIPT_COLUMNS = "digest, object_key, version_id, object_generation, etag, byte_size";

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

function deletionGraceMs(value: number) {
  if (!Number.isSafeInteger(value) || value < MIN_DURABLE_GC_GRACE_MS_V1 || value > MAX_DURABLE_GC_GRACE_MS_V1) {
    throw new RangeError("Project image.png deletion graceMs must be between one minute and 30 days.");
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
    ...storageObjectLocatorFromRowV1(row),
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
  return sameProjectPngReceiptV1(left, right);
}

/** PostgreSQL authority for project image.png replacement, render pinning, and deletion claims. */
export class PostgresProjectPngRepositoryV1 implements ProjectPngRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    const result = await this.#connection.query<{ checksum: string; version: number }>(
      "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (5, 6) ORDER BY version",
      [],
      signal,
    );
    return (
      result.rowCount === 2 &&
      result.rows[0]?.version === 5 &&
      result.rows[0]?.checksum === PROJECT_PNG_MIGRATION_V5_CHECKSUM &&
      result.rows[1]?.version === 6 &&
      result.rows[1]?.checksum === DURABLE_RETENTION_MIGRATION_V6_CHECKSUM
    );
  }

  async #readHead(client: PoolClient, tenant: string, project: string, lock = false) {
    const result = await client.query<HeadRow>(
      `SELECT h.tenant_id, h.project_id, h.generation::text AS generation,
              o.digest, o.object_key, o.version_id, o.object_generation, o.etag, o.byte_size
         FROM public.project_png_heads h
         JOIN public.project_png_generations g
           ON g.tenant_id = h.tenant_id AND g.project_id = h.project_id
          AND g.generation = h.generation AND g.digest = h.digest
         JOIN public.project_png_objects o
           ON o.tenant_id = g.tenant_id AND o.project_id = g.project_id
          AND o.digest = g.digest AND o.object_key = g.object_key
          AND ${storageObjectLocatorJoinSqlV1("o", "g")}
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
    const [candidateVersionId, candidateObjectGeneration] = storageObjectLocatorSqlValuesV1(candidate);
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
        `project-png-object:${tenant}:${candidate.objectKey}:${projectPngLocatorIdentityV1(candidate)}`,
      ]);
      const deleting = await client.query(
        `SELECT 1 FROM public.project_png_deletions deletion
          WHERE deletion.tenant_id = $1 AND deletion.object_key = $2
            AND ${storageObjectLocatorPredicateSqlV1("deletion", 3, 4)}`,
        [tenant, candidate.objectKey, candidateVersionId, candidateObjectGeneration],
      );
      if (deleting.rowCount !== 0) throw new HttpError("Project image.png candidate is queued for deletion.", 409);
      const nextGeneration = current ? current.generation + 1n : 1n;
      generation(nextGeneration);
      await client.query(
        `INSERT INTO public.project_png_objects
           (tenant_id, project_id, digest, object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          tenant,
          project,
          candidate.digest,
          candidate.objectKey,
          candidateVersionId,
          candidateObjectGeneration,
          candidate.etag,
          candidate.byteSize,
        ],
      );
      const storedObject = await client.query<ReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS}
           FROM public.project_png_objects stored
          WHERE stored.tenant_id = $1 AND stored.project_id = $2 AND stored.object_key = $3
            AND ${storageObjectLocatorPredicateSqlV1("stored", 4, 5)}
          FOR KEY SHARE`,
        [tenant, project, candidate.objectKey, candidateVersionId, candidateObjectGeneration],
      );
      const registered = storedObject.rows[0];
      if (!registered || !sameReceipt(receiptFromRow(tenant, project, registered), candidate)) {
        throw new Error("The immutable image.png object version is bound to different metadata.");
      }
      await client.query(
        `INSERT INTO public.project_png_generations
           (tenant_id, project_id, generation, digest, object_key, version_id, object_generation, orphaned_at)
         VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, NULL)`,
        [
          tenant,
          project,
          nextGeneration.toString(),
          candidate.digest,
          candidate.objectKey,
          candidateVersionId,
          candidateObjectGeneration,
        ],
      );
      await client.query(
        `INSERT INTO public.project_png_heads (tenant_id, project_id, generation, digest)
         VALUES ($1, $2, $3::bigint, $4)
         ON CONFLICT (tenant_id, project_id) DO UPDATE
           SET generation = EXCLUDED.generation, digest = EXCLUDED.digest, updated_at = clock_timestamp()`,
        [tenant, project, nextGeneration.toString(), candidate.digest],
      );
      if (current) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `project-png-object:${tenant}:${current.receipt.objectKey}:${projectPngLocatorIdentityV1(current.receipt)}`,
        ]);
        await client.query(
          `UPDATE public.project_png_generations g
              SET orphaned_at = COALESCE(g.orphaned_at, clock_timestamp())
            WHERE g.tenant_id = $1 AND g.project_id = $2
              AND g.generation = $3::bigint AND g.digest = $4
              AND NOT EXISTS (
                SELECT 1 FROM public.project_png_heads h
                 WHERE h.tenant_id = g.tenant_id AND h.project_id = g.project_id
                   AND h.generation = g.generation AND h.digest = g.digest
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.render_sessions s
                 WHERE s.tenant_id = g.tenant_id AND s.project_id = g.project_id
                   AND s.project_png_generation = g.generation AND s.project_png_digest = g.digest
              )`,
          [tenant, project, current.generation.toString(), current.receipt.digest],
        );
      }
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
    const [versionId, objectGeneration] = storageObjectLocatorSqlValuesV1(receipt);
    const result = await this.#connection.query(
      `SELECT 1
         FROM public.project_png_objects o
         JOIN public.project_png_generations g
           ON g.tenant_id = o.tenant_id AND g.project_id = o.project_id
          AND g.digest = o.digest AND g.object_key = o.object_key
          AND ${storageObjectLocatorJoinSqlV1("g", "o")}
        WHERE o.tenant_id = $1 AND o.project_id = $2
          AND o.digest = $3 AND o.object_key = $4
          AND ${storageObjectLocatorPredicateSqlV1("o", 5, 6)}
          AND o.etag = $7 AND o.byte_size = $8
          AND (
            EXISTS (
              SELECT 1 FROM public.project_png_heads h
               WHERE h.tenant_id = g.tenant_id AND h.project_id = g.project_id
                 AND h.generation = g.generation AND h.digest = g.digest
            ) OR EXISTS (
              SELECT 1 FROM public.render_sessions s
               WHERE s.tenant_id = g.tenant_id AND s.project_id = g.project_id
                 AND s.project_png_generation = g.generation AND s.project_png_digest = g.digest
            )
          )
        LIMIT 1`,
      [tenant, project, receipt.digest, receipt.objectKey, versionId, objectGeneration, receipt.etag, receipt.byteSize],
      signal,
    );
    return result.rowCount !== 0;
  }

  async queueDeletion(
    tenantValue: string,
    projectValue: string,
    receiptValue: ProjectPngBlobReceiptV1,
    graceValue: number,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    const receipt = assertProjectPngReceiptV1(tenant, project, receiptValue);
    const [versionId, objectGeneration] = storageObjectLocatorSqlValuesV1(receipt);
    const grace = deletionGraceMs(graceValue);
    return this.#connection.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `project-png-object:${tenant}:${receipt.objectKey}:${projectPngLocatorIdentityV1(receipt)}`,
      ]);
      const storedObject = await client.query<ReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS}
           FROM public.project_png_objects stored
          WHERE stored.tenant_id = $1 AND stored.project_id = $2 AND stored.object_key = $3
            AND ${storageObjectLocatorPredicateSqlV1("stored", 4, 5)}
          FOR UPDATE`,
        [tenant, project, receipt.objectKey, versionId, objectGeneration],
      );
      const registered = storedObject.rows[0];
      if (registered && !sameReceipt(receiptFromRow(tenant, project, registered), receipt)) {
        throw new Error("The registered image.png object version is bound to different metadata.");
      }
      if (registered) {
        const generations = await client.query<GenerationRetentionRow>(
          `SELECT g.generation::text AS generation, g.orphaned_at,
                  (
                    g.orphaned_at IS NOT NULL
                    AND g.orphaned_at <= clock_timestamp() - ($7::double precision * interval '1 millisecond')
                  ) AS mature,
                  (
                    EXISTS (
                      SELECT 1 FROM public.project_png_heads h
                       WHERE h.tenant_id = g.tenant_id AND h.project_id = g.project_id
                         AND h.generation = g.generation AND h.digest = g.digest
                    ) OR EXISTS (
                      SELECT 1 FROM public.render_sessions s
                       WHERE s.tenant_id = g.tenant_id AND s.project_id = g.project_id
                         AND s.project_png_generation = g.generation AND s.project_png_digest = g.digest
                    )
                  ) AS retained
             FROM public.project_png_generations g
            WHERE g.tenant_id = $1 AND g.project_id = $2
              AND g.digest = $3 AND g.object_key = $4
              AND ${storageObjectLocatorPredicateSqlV1("g", 5, 6)}
            ORDER BY g.generation
            FOR UPDATE OF g`,
          [tenant, project, receipt.digest, receipt.objectKey, versionId, objectGeneration, grace],
        );
        if (generations.rowCount === 0) {
          throw new Error("The registered image.png object version has no generation evidence.");
        }
        if (generations.rows.some((row) => row.retained)) return null;
        const unmarked = generations.rows.filter((row) => row.orphaned_at === null);
        if (unmarked.length > 0) {
          await client.query(
            `UPDATE public.project_png_generations g
                SET orphaned_at = COALESCE(g.orphaned_at, clock_timestamp())
              WHERE g.tenant_id = $1 AND g.project_id = $2
                AND g.digest = $3 AND g.object_key = $4
                AND ${storageObjectLocatorPredicateSqlV1("g", 5, 6)}
                AND g.orphaned_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM public.project_png_heads h
                   WHERE h.tenant_id = g.tenant_id AND h.project_id = g.project_id
                     AND h.generation = g.generation AND h.digest = g.digest
                )
                AND NOT EXISTS (
                  SELECT 1 FROM public.render_sessions s
                   WHERE s.tenant_id = g.tenant_id AND s.project_id = g.project_id
                     AND s.project_png_generation = g.generation AND s.project_png_digest = g.digest
                )`,
            [tenant, project, receipt.digest, receipt.objectKey, versionId, objectGeneration],
          );
          return null;
        }
        if (
          generations.rows.some(
            (row) => !(row.orphaned_at instanceof Date) || !Number.isFinite(row.orphaned_at.getTime()) || !row.mature,
          )
        ) {
          return null;
        }
        const removed = await client.query(
          `DELETE FROM public.project_png_generations
            WHERE tenant_id = $1 AND project_id = $2
              AND digest = $3 AND object_key = $4
              AND ${storageObjectLocatorPredicateSqlV1("project_png_generations", 5, 6)}
              AND orphaned_at IS NOT NULL
              AND orphaned_at <= clock_timestamp() - ($7::double precision * interval '1 millisecond')`,
          [tenant, project, receipt.digest, receipt.objectKey, versionId, objectGeneration, grace],
        );
        if (removed.rowCount !== generations.rowCount) {
          throw new Error("The image.png orphan generations changed before deletion was queued.");
        }
      }
      const removedObject = await client.query(
        `DELETE FROM public.project_png_objects
          WHERE tenant_id = $1 AND project_id = $2
            AND digest = $3 AND object_key = $4
            AND ${storageObjectLocatorPredicateSqlV1("project_png_objects", 5, 6)}
            AND etag = $7 AND byte_size = $8`,
        [
          tenant,
          project,
          receipt.digest,
          receipt.objectKey,
          versionId,
          objectGeneration,
          receipt.etag,
          receipt.byteSize,
        ],
      );
      if (registered && removedObject.rowCount !== 1) {
        throw new Error("The image.png object changed before deletion was queued.");
      }
      await client.query(
        `INSERT INTO public.project_png_deletions
           (tenant_id, deletion_id, project_id, digest, object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          tenant,
          project,
          receipt.digest,
          receipt.objectKey,
          versionId,
          objectGeneration,
          receipt.etag,
          receipt.byteSize,
        ],
      );
      const stored = await client.query<DeletionRow>(
        `SELECT tenant_id, deletion_id::text AS deletion_id, project_id, ${RECEIPT_COLUMNS}
           FROM public.project_png_deletions deletion
          WHERE deletion.tenant_id = $1 AND deletion.object_key = $2
            AND ${storageObjectLocatorPredicateSqlV1("deletion", 3, 4)}
          FOR UPDATE`,
        [tenant, receipt.objectKey, versionId, objectGeneration],
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
