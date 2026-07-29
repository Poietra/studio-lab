import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import { manimProjectIdSchema } from "../../../src/render-pipeline/contracts";
import { HttpError } from "../../http/json";
import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  assertRenderArtifactPublishedV1,
  boundedRenderArtifactIntegerV1,
  boundedRenderArtifactTextV1,
  type PublishedRenderArtifactV1,
  type PublishRenderArtifactsInputV1,
  parseRenderArtifactReceiptV1,
  type RenderArtifactDeletionV1,
  type RenderArtifactReadClaimV1,
  type RenderArtifactReceiptV1,
  type RenderArtifactRepositoryV1,
  renderArtifactIdV1,
  sameRenderArtifactReceiptV1,
} from "../render-artifact-repository";
import { MAX_DURABLE_RENDER_LOG_BYTES_V1 } from "../render-session-repository";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";
import { RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM } from "./render-cancellation-schema";

export const RENDER_ARTIFACT_MIGRATION_V4_CHECKSUM = "ba334dd77d8b876fdb4cde9a21ed90264eb2f00e4bfbfe64b9951fbbbf9fffbd";

const MAX_CLAIM_DURATION_MS = 15 * 60_000;
const MAX_EXPIRATION_MS = 30 * 24 * 60 * 60_000;
const MAX_GC_GRACE_MS = 30 * 24 * 60 * 60_000;
const MAX_PAGE = 256;

type ArtifactRow = QueryResultRow & {
  artifact_byte_size: number;
  artifact_digest: string;
  artifact_etag: string;
  artifact_id: string;
  artifact_kind: string;
  artifact_media_type: string;
  artifact_object_key: string;
  artifact_profile_digest: string;
  artifact_request_digest: string;
  artifact_runtime_digest: string;
  artifact_source_digest: string;
  artifact_tenant_id: string;
  artifact_version_id: string;
  expires_at: Date;
};

type DeletionRow = QueryResultRow & {
  artifact_byte_size: number;
  artifact_digest: string;
  artifact_etag: string;
  artifact_kind: string;
  artifact_media_type: string;
  artifact_object_key: string;
  artifact_profile_digest: string;
  artifact_request_digest: string;
  artifact_runtime_digest: string;
  artifact_source_digest: string;
  artifact_tenant_id: string;
  artifact_version_id: string;
  deletion_id: string;
};

type SessionFenceRow = QueryResultRow & {
  deadline_current: boolean;
  fence_token: string;
  lease_current: boolean;
  lease_owner: string | null;
  patched_digest: string;
  project_id: string;
  session_created_at: Date;
  status: string;
  version: string;
};

function artifactColumns(alias: string) {
  return `
    ${alias}.tenant_id AS artifact_tenant_id,
    ${alias}.artifact_id::text AS artifact_id,
    ${alias}.artifact_kind,
    ${alias}.media_type AS artifact_media_type,
    ${alias}.artifact_digest,
    ${alias}.source_digest AS artifact_source_digest,
    ${alias}.runtime_digest AS artifact_runtime_digest,
    ${alias}.profile_digest AS artifact_profile_digest,
    ${alias}.request_digest AS artifact_request_digest,
    ${alias}.object_key AS artifact_object_key,
    ${alias}.version_id AS artifact_version_id,
    ${alias}.etag AS artifact_etag,
    ${alias}.byte_size AS artifact_byte_size
  `;
}

const ARTIFACT_COLUMNS = artifactColumns("artifact");

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

function uuid(value: string, label: string) {
  return renderArtifactIdV1(value, label);
}

function bigint(value: bigint, label: string) {
  if (typeof value !== "bigint" || value < 0n || value > 9_223_372_036_854_775_807n) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function date(value: unknown, label: string) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${label} is invalid.`);
  return value;
}

function receiptFromRow(row: ArtifactRow | DeletionRow): RenderArtifactReceiptV1 {
  return parseRenderArtifactReceiptV1(tenantId(row.artifact_tenant_id), {
    artifactDigest: row.artifact_digest,
    byteSize: row.artifact_byte_size,
    etag: row.artifact_etag,
    kind: row.artifact_kind,
    mediaType: row.artifact_media_type,
    objectKey: row.artifact_object_key,
    profileDigest: row.artifact_profile_digest,
    requestDigest: row.artifact_request_digest,
    runtimeDigest: row.artifact_runtime_digest,
    sourceDigest: row.artifact_source_digest,
    versionId: row.artifact_version_id,
  });
}

function artifactFromRow(row: ArtifactRow): PublishedRenderArtifactV1 {
  return assertRenderArtifactPublishedV1(
    {
      artifactId: uuid(row.artifact_id, "Stored render artifact ID"),
      expiresAt: date(row.expires_at, "Stored render artifact expiry"),
      receipt: receiptFromRow(row),
    },
    row.artifact_tenant_id,
  );
}

function deletionFromRow(row: DeletionRow, expectedTenant: string): RenderArtifactDeletionV1 {
  const tenant = tenantId(row.artifact_tenant_id);
  if (tenant !== expectedTenant) throw new TypeError("PostgreSQL returned an artifact deletion for another tenant.");
  return {
    deletionId: uuid(row.deletion_id, "Stored render artifact deletion ID"),
    receipt: receiptFromRow(row),
    tenantId: tenant,
  };
}

function receiptValues(receipt: RenderArtifactReceiptV1) {
  return [
    receipt.kind,
    receipt.mediaType,
    receipt.artifactDigest,
    receipt.sourceDigest,
    receipt.runtimeDigest,
    receipt.profileDigest,
    receipt.requestDigest,
    receipt.objectKey,
    receipt.versionId,
    receipt.etag,
    receipt.byteSize,
  ] as const;
}

function missingArtifact(): never {
  throw new HttpError("Rendered artifact not found.", 404);
}

/** PostgreSQL authority for fenced publication, authorized read claims and deletion claims. */
export class PostgresArtifactRepositoryV1 implements RenderArtifactRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(
    options: Readonly<{
      pool?: Pool;
      poolConfig?: PoolConfig;
      statementTimeoutMs?: number;
    }>,
  ) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const result = await this.#connection.query<{ checksum: string; version: number }>(
      "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (4, 7) ORDER BY version",
      [],
      signal,
    );
    return (
      result.rows.length === 2 &&
      result.rows[0]?.version === 4 &&
      result.rows[0]?.checksum === RENDER_ARTIFACT_MIGRATION_V4_CHECKSUM &&
      result.rows[1]?.version === 7 &&
      result.rows[1]?.checksum === RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM
    );
  }

  async #insertArtifact(
    client: PoolClient,
    tenant: string,
    requestedArtifactId: string,
    receipt: RenderArtifactReceiptV1,
    expiresAt: Date,
  ) {
    const deleting = await client.query(
      `SELECT 1
         FROM public.render_artifact_deletions
        WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3`,
      [tenant, receipt.objectKey, receipt.versionId],
    );
    if (deleting.rowCount !== 0) {
      throw new HttpError("The rendered artifact version is already queued for deletion.", 409);
    }
    await client.query(
      `INSERT INTO public.render_artifact_objects
         (tenant_id, artifact_id, artifact_kind, media_type, artifact_digest, source_digest,
          runtime_digest, profile_digest, request_digest, object_key, version_id, etag, byte_size, expires_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (tenant_id, object_key, version_id) DO UPDATE
          SET expires_at = GREATEST(public.render_artifact_objects.expires_at, EXCLUDED.expires_at)`,
      [tenant, requestedArtifactId, ...receiptValues(receipt), expiresAt],
    );
    const stored = await client.query<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS}, artifact.expires_at
         FROM public.render_artifact_objects artifact
        WHERE artifact.tenant_id = $1 AND artifact.object_key = $2 AND artifact.version_id = $3
        FOR UPDATE`,
      [tenant, receipt.objectKey, receipt.versionId],
    );
    if (stored.rows.length !== 1) throw new Error("PostgreSQL did not retain the uploaded render artifact.");
    const artifact = artifactFromRow(stored.rows[0]!);
    if (!sameRenderArtifactReceiptV1(artifact.receipt, receipt)) {
      throw new Error("An immutable render artifact key is already bound to different metadata.");
    }
    return artifact;
  }

  async #lockArtifact(
    client: PoolClient,
    tenant: string,
    receipt: Pick<RenderArtifactReceiptV1, "objectKey" | "versionId">,
  ) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `render-artifact:${tenant}:${receipt.objectKey}:${receipt.versionId}`,
    ]);
  }

  async publishSessionArtifacts(input: PublishRenderArtifactsInputV1, signal?: AbortSignal) {
    const tenant = tenantId(input.tenantId);
    const session = uuid(input.sessionId, "Render session ID");
    const owner = boundedRenderArtifactTextV1(input.ownerId, "Render lease owner", 240);
    const expectedVersion = bigint(input.expectedVersion, "Render session version");
    const fenceToken = bigint(input.fenceToken, "Render fence token");
    const expirationMs = boundedRenderArtifactIntegerV1(input.expirationMs, "artifact expirationMs", MAX_EXPIRATION_MS);
    boundedRenderArtifactTextV1(input.logTail, "Render log", MAX_DURABLE_RENDER_LOG_BYTES_V1, true);
    const requested = [input.artifacts.video, input.artifacts.thumbnail] as const;
    const receipts = requested.map(({ artifactId, receipt }) => ({
      artifactId: uuid(artifactId, "Render artifact ID"),
      receipt: parseRenderArtifactReceiptV1(tenant, receipt),
    }));
    if (
      receipts[0].receipt.kind !== "video" ||
      receipts[1].receipt.kind !== "thumbnail" ||
      receipts[0].receipt.sourceDigest !== receipts[1].receipt.sourceDigest ||
      receipts[0].receipt.runtimeDigest !== receipts[1].receipt.runtimeDigest ||
      receipts[0].receipt.profileDigest !== receipts[1].receipt.profileDigest
    ) {
      throw new TypeError("Render artifact publication correlation is invalid.");
    }

    await this.#connection.transaction(async (client) => {
      const current = await client.query<SessionFenceRow>(
        `SELECT project_id, patched_digest, status, version::text AS version, fence_token::text AS fence_token,
                lease_owner, lease_expires_at > clock_timestamp() AS lease_current,
                execution_deadline > clock_timestamp() AS deadline_current,
                created_at AS session_created_at
           FROM public.render_sessions
          WHERE tenant_id = $1 AND session_id = $2::uuid
          FOR UPDATE`,
        [tenant, session],
      );
      const row = current.rows[0];
      if (
        !row ||
        row.status !== "rendering" ||
        row.version !== expectedVersion.toString() ||
        row.fence_token !== fenceToken.toString() ||
        row.lease_owner !== owner ||
        row.lease_current !== true ||
        row.deadline_current !== true
      ) {
        throw new HttpError("The render publication fence is stale.", 409);
      }
      const pendingCancellation = await client.query(
        `SELECT 1 FROM public.render_cancellation_intents
          WHERE tenant_id = $1 AND session_id = $2::uuid
            AND acknowledged_at IS NULL AND expires_at > clock_timestamp()`,
        [tenant, session],
      );
      if (pendingCancellation.rowCount !== 0) {
        throw new HttpError("The render publication fence is stale.", 409);
      }
      if (row.patched_digest !== receipts[0].receipt.sourceDigest) {
        throw new TypeError("The staged media does not match the rendered source digest.");
      }
      for (const { receipt } of [...receipts].sort((left, right) => {
        const leftKey = `${left.receipt.objectKey}\0${left.receipt.versionId}`;
        const rightKey = `${right.receipt.objectKey}\0${right.receipt.versionId}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })) {
        await this.#lockArtifact(client, tenant, receipt);
      }
      const expires = await client.query<{ expires_at: Date }>(
        "SELECT clock_timestamp() + ($1::double precision * interval '1 millisecond') AS expires_at",
        [expirationMs],
      );
      const expiresAt = date(expires.rows[0]?.expires_at, "Render artifact expiry");
      // A pg client serializes queries itself; keep the ordering explicit so a
      // publication never appears to have independent transactional writers.
      const video = await this.#insertArtifact(client, tenant, receipts[0].artifactId, receipts[0].receipt, expiresAt);
      const thumbnail = await this.#insertArtifact(
        client,
        tenant,
        receipts[1].artifactId,
        receipts[1].receipt,
        expiresAt,
      );
      if (video.receipt.kind !== "video" || thumbnail.receipt.kind !== "thumbnail") {
        throw new Error("PostgreSQL returned render artifacts in an invalid order.");
      }
      await client.query(
        `INSERT INTO public.render_session_artifacts
           (tenant_id, session_id, artifact_kind, artifact_id, expires_at)
         VALUES ($1, $2::uuid, 'video', $3::uuid, $5),
                ($1, $2::uuid, 'thumbnail', $4::uuid, $5)`,
        [tenant, session, video.artifactId, thumbnail.artifactId, expiresAt],
      );
      await client.query(
        `INSERT INTO public.workspace_project_thumbnail_heads
           (tenant_id, project_id, session_id, artifact_id, session_created_at, expires_at)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6)
         ON CONFLICT (tenant_id, project_id) DO UPDATE
            SET session_id = EXCLUDED.session_id,
                artifact_id = EXCLUDED.artifact_id,
                session_created_at = EXCLUDED.session_created_at,
                expires_at = EXCLUDED.expires_at,
                updated_at = clock_timestamp()
          WHERE (public.workspace_project_thumbnail_heads.session_created_at,
                 public.workspace_project_thumbnail_heads.session_id::text)
             <= (EXCLUDED.session_created_at, EXCLUDED.session_id::text)`,
        [tenant, row.project_id, session, thumbnail.artifactId, row.session_created_at, expiresAt],
      );
      const completed = await client.query(
        `UPDATE public.render_sessions
            SET status = 'ready', progress = 1, log_tail = $6, error = NULL,
                artifact_locator = $7, version = version + 1,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND session_id = $2::uuid
            AND lease_owner = $3 AND version = $4::bigint AND fence_token = $5::bigint
            AND lease_expires_at > clock_timestamp() AND execution_deadline > clock_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM public.render_cancellation_intents cancellation
               WHERE cancellation.tenant_id = public.render_sessions.tenant_id
                 AND cancellation.session_id = public.render_sessions.session_id
                 AND cancellation.acknowledged_at IS NULL
                 AND cancellation.expires_at > clock_timestamp()
            )
            AND status = 'rendering'`,
        [tenant, session, owner, expectedVersion.toString(), fenceToken.toString(), input.logTail, video.artifactId],
      );
      if (completed.rowCount !== 1) throw new HttpError("The render publication fence is stale.", 409);
    }, signal);
  }

  async #acquire(
    tenantValue: string,
    claimDurationValue: number,
    select: (client: PoolClient, tenant: string) => Promise<{ rows: ArtifactRow[] }>,
    signal?: AbortSignal,
  ): Promise<RenderArtifactReadClaimV1> {
    const tenant = tenantId(tenantValue);
    const claimDurationMs = boundedRenderArtifactIntegerV1(
      claimDurationValue,
      "artifact claimDurationMs",
      MAX_CLAIM_DURATION_MS,
    );
    return this.#connection.transaction(async (client) => {
      await client.query(
        `DELETE FROM public.render_artifact_read_claims
          WHERE (tenant_id, claim_id) IN (
            SELECT tenant_id, claim_id
              FROM public.render_artifact_read_claims
             WHERE tenant_id = $1 AND expires_at <= clock_timestamp()
             ORDER BY expires_at, claim_id
             LIMIT $2
          )`,
        [tenant, MAX_PAGE],
      );
      const selected = await select(client, tenant);
      if (selected.rows.length !== 1) missingArtifact();
      const artifact = artifactFromRow(selected.rows[0]!);
      const claimId = randomUUID();
      const inserted = await client.query<{ claim_expires_at: Date }>(
        `INSERT INTO public.render_artifact_read_claims (tenant_id, claim_id, artifact_id, expires_at)
         SELECT $1, $2::uuid, $3::uuid,
                clock_timestamp() + ($5::double precision * interval '1 millisecond')
          WHERE $4 > clock_timestamp()
         RETURNING expires_at AS claim_expires_at`,
        [tenant, claimId, artifact.artifactId, artifact.expiresAt, claimDurationMs],
      );
      const claimExpiresAt = inserted.rows[0]?.claim_expires_at;
      if (!claimExpiresAt) missingArtifact();
      return {
        artifact,
        claimExpiresAt: date(claimExpiresAt, "Render artifact read-claim expiry"),
        claimId,
      };
    }, signal);
  }

  acquireSessionVideo(tenantValue: string, sessionValue: string, claimDurationMs: number, signal?: AbortSignal) {
    const session = uuid(sessionValue, "Render session ID");
    return this.#acquire(
      tenantValue,
      claimDurationMs,
      (client, tenant) =>
        client.query<ArtifactRow>(
          `SELECT ${ARTIFACT_COLUMNS}, link.expires_at
             FROM public.render_sessions session
             JOIN public.render_session_artifacts link
               ON link.tenant_id = session.tenant_id AND link.session_id = session.session_id
              AND link.artifact_kind = 'video'
             JOIN public.render_artifact_objects artifact
               ON artifact.tenant_id = link.tenant_id AND artifact.artifact_id = link.artifact_id
            WHERE session.tenant_id = $1 AND session.session_id = $2::uuid
              AND session.status IN ('ready', 'committed', 'undone')
              AND link.expires_at > clock_timestamp()
            FOR UPDATE OF artifact, link`,
          [tenant, session],
        ),
      signal,
    );
  }

  acquireProjectThumbnail(tenantValue: string, projectValue: string, claimDurationMs: number, signal?: AbortSignal) {
    const project = projectId(projectValue);
    return this.#acquire(
      tenantValue,
      claimDurationMs,
      (client, tenant) =>
        client.query<ArtifactRow>(
          `SELECT ${ARTIFACT_COLUMNS}, head.expires_at
             FROM public.workspace_project_thumbnail_heads head
             JOIN public.workspace_projects project
               ON project.tenant_id = head.tenant_id AND project.project_id = head.project_id
              AND project.deleted_at IS NULL
             JOIN public.render_artifact_objects artifact
               ON artifact.tenant_id = head.tenant_id AND artifact.artifact_id = head.artifact_id
            WHERE head.tenant_id = $1 AND head.project_id = $2
              AND head.expires_at > clock_timestamp()
            FOR UPDATE OF artifact, head`,
          [tenant, project],
        ),
      signal,
    );
  }

  async releaseReadClaim(tenantValue: string, claimValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const claim = uuid(claimValue, "Render artifact read-claim ID");
    await this.#connection.query(
      "DELETE FROM public.render_artifact_read_claims WHERE tenant_id = $1 AND claim_id = $2::uuid",
      [tenant, claim],
      signal,
    );
  }

  async renewReadClaim(tenantValue: string, claimValue: string, claimDurationValue: number, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const claim = uuid(claimValue, "Render artifact read-claim ID");
    const claimDurationMs = boundedRenderArtifactIntegerV1(
      claimDurationValue,
      "artifact claimDurationMs",
      MAX_CLAIM_DURATION_MS,
    );
    return this.#connection.transaction(async (client) => {
      const identity = await client.query<{ artifact_id: string; object_key: string; version_id: string }>(
        `SELECT claim.artifact_id::text AS artifact_id, artifact.object_key, artifact.version_id
           FROM public.render_artifact_read_claims claim
           JOIN public.render_artifact_objects artifact
             ON artifact.tenant_id = claim.tenant_id AND artifact.artifact_id = claim.artifact_id
          WHERE claim.tenant_id = $1 AND claim.claim_id = $2::uuid
            AND claim.expires_at > clock_timestamp()`,
        [tenant, claim],
      );
      const target = identity.rows[0];
      if (!target) throw new HttpError("The render artifact read claim expired.", 409);
      await this.#lockArtifact(client, tenant, { objectKey: target.object_key, versionId: target.version_id });
      const artifact = await client.query(
        `SELECT 1 FROM public.render_artifact_objects
          WHERE tenant_id = $1 AND artifact_id = $2::uuid
            AND object_key = $3 AND version_id = $4
          FOR UPDATE`,
        [tenant, target.artifact_id, target.object_key, target.version_id],
      );
      if (artifact.rowCount !== 1) throw new HttpError("The render artifact read claim expired.", 409);
      const result = await client.query<{ expires_at: Date }>(
        `UPDATE public.render_artifact_read_claims
            SET expires_at = clock_timestamp() + ($3::double precision * interval '1 millisecond')
          WHERE tenant_id = $1 AND claim_id = $2::uuid AND artifact_id = $4::uuid
            AND expires_at > clock_timestamp()
        RETURNING expires_at`,
        [tenant, claim, claimDurationMs, target.artifact_id],
      );
      const expiresAt = result.rows[0]?.expires_at;
      if (!expiresAt) throw new HttpError("The render artifact read claim expired.", 409);
      return date(expiresAt, "Render artifact read-claim expiry");
    }, signal);
  }

  async isArtifactRetained(tenantValue: string, receiptValue: RenderArtifactReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const receipt = parseRenderArtifactReceiptV1(tenant, receiptValue);
    const result = await this.#connection.query<{ retained: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.render_artifact_objects artifact
          WHERE artifact.tenant_id = $1 AND artifact.object_key = $2 AND artifact.version_id = $3
            AND artifact.artifact_digest = $4
            AND (
              artifact.expires_at > clock_timestamp()
              OR EXISTS (
                SELECT 1 FROM public.render_artifact_read_claims claim
                 WHERE claim.tenant_id = artifact.tenant_id AND claim.artifact_id = artifact.artifact_id
                   AND claim.expires_at > clock_timestamp()
              )
            )
       ) AS retained`,
      [tenant, receipt.objectKey, receipt.versionId, receipt.artifactDigest],
      signal,
    );
    return result.rows[0]?.retained === true;
  }

  async queueDeletion(
    tenantValue: string,
    receiptValue: RenderArtifactReceiptV1,
    graceValue: number,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    const receipt = parseRenderArtifactReceiptV1(tenant, receiptValue);
    const graceMs = boundedRenderArtifactIntegerV1(graceValue, "artifact GC graceMs", MAX_GC_GRACE_MS);
    return this.#connection.transaction(async (client) => {
      await this.#lockArtifact(client, tenant, receipt);
      const existing = await client.query<DeletionRow>(
        `SELECT tenant_id AS artifact_tenant_id, deletion_id::text AS deletion_id,
                artifact_kind, media_type AS artifact_media_type, artifact_digest,
                source_digest AS artifact_source_digest, runtime_digest AS artifact_runtime_digest,
                profile_digest AS artifact_profile_digest, request_digest AS artifact_request_digest,
                object_key AS artifact_object_key, version_id AS artifact_version_id,
                etag AS artifact_etag, byte_size AS artifact_byte_size
           FROM public.render_artifact_deletions
          WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3
          FOR UPDATE`,
        [tenant, receipt.objectKey, receipt.versionId],
      );
      if (existing.rows[0]) return deletionFromRow(existing.rows[0], tenant);

      const stored = await client.query<ArtifactRow>(
        `SELECT ${ARTIFACT_COLUMNS}, artifact.expires_at
           FROM public.render_artifact_objects artifact
          WHERE artifact.tenant_id = $1 AND artifact.object_key = $2 AND artifact.version_id = $3
          FOR UPDATE`,
        [tenant, receipt.objectKey, receipt.versionId],
      );
      const artifact = stored.rows[0] ? artifactFromRow(stored.rows[0]) : null;
      if (artifact) {
        if (!sameRenderArtifactReceiptV1(artifact.receipt, receipt)) {
          throw new Error("The queued render artifact metadata does not match PostgreSQL.");
        }
        const eligible = await client.query<{ eligible: boolean }>(
          `SELECT $2 <= clock_timestamp() - ($3::double precision * interval '1 millisecond')
                  AND NOT EXISTS (
                    SELECT 1 FROM public.render_artifact_read_claims claim
                     WHERE claim.tenant_id = $1 AND claim.artifact_id = $4::uuid
                       AND claim.expires_at > clock_timestamp()
                  ) AS eligible`,
          [tenant, artifact.expiresAt, graceMs, artifact.artifactId],
        );
        if (eligible.rows[0]?.eligible !== true) return null;
        await client.query(
          "DELETE FROM public.workspace_project_thumbnail_heads WHERE tenant_id = $1 AND artifact_id = $2::uuid",
          [tenant, artifact.artifactId],
        );
        await client.query(
          "DELETE FROM public.render_session_artifacts WHERE tenant_id = $1 AND artifact_id = $2::uuid",
          [tenant, artifact.artifactId],
        );
        await client.query(
          "UPDATE public.render_sessions SET artifact_locator = NULL WHERE tenant_id = $1 AND artifact_locator = $2",
          [tenant, artifact.artifactId],
        );
        await client.query(
          "DELETE FROM public.render_artifact_objects WHERE tenant_id = $1 AND artifact_id = $2::uuid",
          [tenant, artifact.artifactId],
        );
      }

      const deletionId = randomUUID();
      const inserted = await client.query<DeletionRow>(
        `INSERT INTO public.render_artifact_deletions
           (tenant_id, deletion_id, artifact_kind, media_type, artifact_digest, source_digest,
            runtime_digest, profile_digest, request_digest, object_key, version_id, etag, byte_size)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING tenant_id AS artifact_tenant_id, deletion_id::text AS deletion_id,
                   artifact_kind, media_type AS artifact_media_type, artifact_digest,
                   source_digest AS artifact_source_digest, runtime_digest AS artifact_runtime_digest,
                   profile_digest AS artifact_profile_digest, request_digest AS artifact_request_digest,
                   object_key AS artifact_object_key, version_id AS artifact_version_id,
                   etag AS artifact_etag, byte_size AS artifact_byte_size`,
        [tenant, deletionId, ...receiptValues(receipt)],
      );
      return deletionFromRow(inserted.rows[0]!, tenant);
    }, signal);
  }

  async pendingDeletions(tenantValue: string, maximumValue: number, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const maximum = boundedRenderArtifactIntegerV1(maximumValue, "maximum", MAX_PAGE);
    const result = await this.#connection.query<DeletionRow>(
      `SELECT tenant_id AS artifact_tenant_id, deletion_id::text AS deletion_id,
              artifact_kind, media_type AS artifact_media_type, artifact_digest,
              source_digest AS artifact_source_digest, runtime_digest AS artifact_runtime_digest,
              profile_digest AS artifact_profile_digest, request_digest AS artifact_request_digest,
              object_key AS artifact_object_key, version_id AS artifact_version_id,
              etag AS artifact_etag, byte_size AS artifact_byte_size
         FROM public.render_artifact_deletions
        WHERE tenant_id = $1
        ORDER BY queued_at, deletion_id
        LIMIT $2`,
      [tenant, maximum],
      signal,
    );
    return result.rows.map((row) => deletionFromRow(row, tenant));
  }

  async acknowledgeDeletion(tenantValue: string, deletionValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const deletion = uuid(deletionValue, "Render artifact deletion ID");
    await this.#connection.query(
      "DELETE FROM public.render_artifact_deletions WHERE tenant_id = $1 AND deletion_id = $2::uuid",
      [tenant, deletion],
      signal,
    );
  }

  close() {
    return this.#connection.close();
  }
}
