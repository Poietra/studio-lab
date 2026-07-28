import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import {
  manimProjectIdSchema,
  manimSourcePathSchema,
  renderSessionStatusSchema,
  renderSourceActionIdSchema,
} from "../../../src/render-pipeline/contracts";
import { HttpError } from "../../http/json";
import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  type CreateDurableRenderSessionInputV1,
  type DurableRenderLeaseClaimV1,
  type DurableRenderLeaseCompletionV1,
  type DurableRenderLeaseRenewalV1,
  type DurableRenderSessionV1,
  type DurableRenderSourceActionInputV1,
  type DurableRenderSourceActionResultV1,
  type DurableRenderSourceActionV1,
  MAX_DURABLE_RENDER_ARTIFACT_LOCATOR_BYTES_V1,
  MAX_DURABLE_RENDER_ERROR_BYTES_V1,
  MAX_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
  MAX_DURABLE_RENDER_LEASE_MS_V1,
  MAX_DURABLE_RENDER_LOG_BYTES_V1,
  MIN_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
  type RenderSessionRepositoryV1,
} from "../render-session-repository";
import { MAX_MANIM_SOURCE_BYTES_V1, type SourceBlobReceiptV1 } from "../workspace-source-repository";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

export const RENDER_SESSION_MIGRATION_V2_CHECKSUM = "f67255ae5d05b2951975a700974a9748c848c6a39b9bb51b3189c3e8ed2664e9";

const MAX_INCREMENTABLE_BIGINT_V1 = 9_223_372_036_854_775_806n;
const MAX_SOURCE_ACTION_RECORDS_V1 = 64;
const MAX_RECOVERABLE_SESSION_PAGE_V1 = 256;
const MAX_CORRELATION_KEY_BYTES_V1 = 2_048;
const MAX_RENDER_IDENTIFIER_BYTES_V1 = 240;

type SessionRow = QueryResultRow & {
  action_created_at: Date | null;
  action_expected_key: string | null;
  action_id: string | null;
  action_kind: "commit" | "undo" | null;
  action_outcome: "committed" | "undone" | null;
  action_state: "cancelled" | "failed" | "running" | "succeeded" | null;
  action_updated_at: Date | null;
  artifact_locator: string | null;
  commit_correlation_key: string;
  created_at: Date;
  error: string | null;
  execution_attempts: number;
  execution_deadline: Date;
  fence_token: string;
  lease_expires_at: Date | null;
  lease_owner: string | null;
  log_tail: string;
  original_byte_size: number;
  original_digest: string;
  original_etag: string;
  original_generation: string;
  original_object_key: string;
  original_version_id: string;
  patch_anchor_line: number;
  patch_anchor_lines: number[];
  patch_inserted_code: string;
  patched_byte_size: number;
  patched_digest: string;
  patched_etag: string;
  patched_object_key: string;
  patched_version_id: string;
  program_batch_id: string;
  program_transaction_id: string;
  progress: number;
  project_id: string;
  render_request_id: string;
  scene_name: string;
  session_id: string;
  source_path: string;
  status: string;
  tenant_id: string;
  updated_at: Date;
  version: string;
};

type BlobRow = QueryResultRow & {
  byte_size: number;
  digest: string;
  etag: string;
  object_key: string;
  version_id: string;
};

type ActionRow = QueryResultRow & {
  action_id: string;
  created_at: Date;
  expected_key: string | null;
  kind: "commit" | "undo";
  outcome: "committed" | "undone" | null;
  session_id: string;
  state: "cancelled" | "failed" | "running" | "succeeded";
  tenant_id: string;
  updated_at: Date;
};

const SESSION_COLUMNS = `
  s.tenant_id,
  s.session_id::text AS session_id,
  s.project_id,
  s.source_path,
  s.scene_name,
  s.program_batch_id,
  s.program_transaction_id,
  s.render_request_id,
  s.commit_correlation_key,
  s.original_generation::text AS original_generation,
  s.patch_anchor_line,
  s.patch_anchor_lines,
  s.patch_inserted_code,
  s.status,
  s.execution_attempts,
  s.execution_deadline,
  s.version::text AS version,
  s.fence_token::text AS fence_token,
  s.lease_owner,
  s.lease_expires_at,
  s.progress,
  s.log_tail,
  s.error,
  s.artifact_locator,
  s.created_at,
  s.updated_at,
  original.digest AS original_digest,
  original.object_key AS original_object_key,
  original.version_id AS original_version_id,
  original.etag AS original_etag,
  original.byte_size AS original_byte_size,
  patched.digest AS patched_digest,
  patched.object_key AS patched_object_key,
  patched.version_id AS patched_version_id,
  patched.etag AS patched_etag,
  patched.byte_size AS patched_byte_size,
  action.action_id::text AS action_id,
  action.kind AS action_kind,
  action.expected_key AS action_expected_key,
  action.state AS action_state,
  action.outcome AS action_outcome,
  action.created_at AS action_created_at,
  action.updated_at AS action_updated_at
`;

const SESSION_JOINS = `
  JOIN public.source_blob_objects original
    ON original.tenant_id = s.tenant_id AND original.digest = s.original_digest
  JOIN public.source_blob_objects patched
    ON patched.tenant_id = s.tenant_id AND patched.digest = s.patched_digest
  LEFT JOIN public.render_source_actions action
    ON action.tenant_id = s.tenant_id
   AND action.session_id = s.session_id
   AND action.action_id = s.latest_action_id
`;

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function boundedPositiveInteger(value: number, name: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function boundedText(value: string, name: string, maximum: number, allowEmpty = false) {
  const bytes = Buffer.byteLength(value, "utf8");
  if ((!allowEmpty && bytes === 0) || bytes > maximum) throw new TypeError(`${name} is invalid.`);
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

function sourcePath(value: string) {
  const parsed = manimSourcePathSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Source path is invalid.");
  return parsed.data;
}

function uuidV4(value: string, name: string) {
  const parsed = renderSourceActionIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${name} is invalid.`);
  return parsed.data;
}

function existingSessionId(value: string) {
  const parsed = renderSourceActionIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpError("Manim render session not found.", 404);
  return parsed.data;
}

function sceneName(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || value.length > 128) {
    throw new TypeError("Scene name is invalid.");
  }
  return value;
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

function receiptFromBlobRow(row: BlobRow): SourceBlobReceiptV1 {
  return {
    byteSize: row.byte_size,
    digest: row.digest,
    etag: row.etag,
    objectKey: row.object_key,
    versionId: row.version_id,
  };
}

function blobFromRow(row: SessionRow, prefix: "original" | "patched"): SourceBlobReceiptV1 {
  return {
    byteSize: row[`${prefix}_byte_size`],
    digest: row[`${prefix}_digest`],
    etag: row[`${prefix}_etag`],
    objectKey: row[`${prefix}_object_key`],
    versionId: row[`${prefix}_version_id`],
  };
}

function actionFromRow(row: ActionRow): DurableRenderSourceActionV1 {
  return {
    createdAt: row.created_at,
    expectedKey: row.expected_key,
    id: row.action_id,
    kind: row.kind,
    outcome: row.outcome,
    sessionId: row.session_id,
    state: row.state,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function sessionFromRow(row: SessionRow): DurableRenderSessionV1 {
  const parsedStatus = renderSessionStatusSchema.safeParse(row.status);
  if (
    !parsedStatus.success ||
    !(row.created_at instanceof Date) ||
    !(row.execution_deadline instanceof Date) ||
    !Number.isSafeInteger(row.execution_attempts) ||
    row.execution_attempts < 0 ||
    !(row.updated_at instanceof Date)
  ) {
    throw new TypeError("PostgreSQL returned an invalid durable render session.");
  }
  const latestAction = row.action_id
    ? actionFromRow({
        action_id: row.action_id,
        created_at: row.action_created_at!,
        expected_key: row.action_expected_key,
        kind: row.action_kind!,
        outcome: row.action_outcome,
        session_id: row.session_id,
        state: row.action_state!,
        tenant_id: row.tenant_id,
        updated_at: row.action_updated_at!,
      })
    : null;
  return {
    artifactLocator: row.artifact_locator,
    commitCorrelationKey: row.commit_correlation_key,
    createdAt: row.created_at,
    deadline: row.execution_deadline,
    error: row.error,
    executionAttempts: row.execution_attempts,
    fenceToken: BigInt(row.fence_token),
    id: row.session_id,
    latestAction,
    lease:
      row.lease_owner && row.lease_expires_at ? { expiresAt: row.lease_expires_at, ownerId: row.lease_owner } : null,
    logTail: row.log_tail,
    original: { blob: blobFromRow(row, "original"), generation: BigInt(row.original_generation) },
    patch: {
      anchorLine: row.patch_anchor_line,
      anchorLines: row.patch_anchor_lines,
      insertedCode: row.patch_inserted_code,
    },
    patched: { blob: blobFromRow(row, "patched") },
    programBatchId: row.program_batch_id,
    programTransactionId: row.program_transaction_id,
    progress: row.progress,
    projectId: row.project_id,
    renderRequestId: row.render_request_id,
    sceneName: row.scene_name,
    sourcePath: row.source_path,
    status: parsedStatus.data,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
    version: BigInt(row.version),
  };
}

function actionLabel(kind: "commit" | "undo") {
  return kind === "commit" ? "Commit" : "Undo";
}

export class PostgresRenderSessionRepositoryV1 implements RenderSessionRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async #registerBlob(client: PoolClient, tenant: string, candidateValue: SourceBlobReceiptV1) {
    const candidate = blobReceipt(tenant, candidateValue);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenant}:${candidate.digest}`]);
    const deleting = await client.query(
      `SELECT 1 FROM public.source_blob_deletions
        WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3`,
      [tenant, candidate.objectKey, candidate.versionId],
    );
    if (deleting.rowCount !== 0) throw new HttpError("The source candidate is no longer available.", 409);
    const inserted = await client.query<BlobRow>(
      `INSERT INTO public.source_blob_objects
         (tenant_id, digest, object_key, version_id, etag, byte_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, digest) DO NOTHING
       RETURNING digest, object_key, version_id, etag, byte_size`,
      [tenant, candidate.digest, candidate.objectKey, candidate.versionId, candidate.etag, candidate.byteSize],
    );
    if (inserted.rowCount === 1) return candidate;
    const existing = await client.query<BlobRow>(
      `SELECT digest, object_key, version_id, etag, byte_size
         FROM public.source_blob_objects
        WHERE tenant_id = $1 AND digest = $2
        FOR KEY SHARE`,
      [tenant, candidate.digest],
    );
    const row = existing.rows[0];
    if (!row || row.object_key !== candidate.objectKey || row.byte_size !== candidate.byteSize) {
      throw new TypeError("The stored source blob metadata conflicts with its digest.");
    }
    return receiptFromBlobRow(row);
  }

  async #selectSession(client: PoolClient, tenant: string, session: string, lock = false) {
    const result = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM public.render_sessions s
         ${SESSION_JOINS}
        WHERE s.tenant_id = $1 AND s.session_id = $2::uuid
        ${lock ? "FOR UPDATE OF s" : ""}`,
      [tenant, session],
    );
    if (result.rowCount !== 1) throw new HttpError("Manim render session not found.", 404);
    return sessionFromRow(result.rows[0]!);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string }>(
        "SELECT checksum FROM public.poietra_schema_migrations WHERE version = 2",
        [],
        signal,
      );
      return result.rowCount === 1 && result.rows[0]?.checksum === RENDER_SESSION_MIGRATION_V2_CHECKSUM;
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async createSession(input: CreateDurableRenderSessionInputV1, signal?: AbortSignal) {
    const tenant = tenantId(input.tenantId);
    const session = uuidV4(input.id, "Render session ID");
    if (input.originalHead.tenantId !== tenant) throw new TypeError("The source head belongs to another tenant.");
    const project = projectId(input.originalHead.projectId);
    const path = sourcePath(input.originalHead.sourcePath);
    const original = blobReceipt(tenant, input.originalHead.blob);
    const patched = blobReceipt(tenant, input.patchedBlob);
    const generation = input.originalHead.generation;
    if (generation <= 0n || generation > MAX_INCREMENTABLE_BIGINT_V1 - 1n) {
      throw new TypeError("The original source generation is outside the supported PostgreSQL range.");
    }
    const scene = sceneName(input.sceneName);
    const batch = boundedText(input.programBatchId, "Program batch ID", MAX_RENDER_IDENTIFIER_BYTES_V1);
    const transaction = boundedText(
      input.programTransactionId,
      "Program transaction ID",
      MAX_RENDER_IDENTIFIER_BYTES_V1,
    );
    const request = boundedText(input.renderRequestId, "Render request ID", MAX_RENDER_IDENTIFIER_BYTES_V1);
    const correlation = boundedText(input.commitCorrelationKey, "Commit correlation key", MAX_CORRELATION_KEY_BYTES_V1);
    const executionTimeout = boundedPositiveInteger(
      input.executionTimeoutMs,
      "executionTimeoutMs",
      MAX_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
    );
    if (executionTimeout < MIN_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1) {
      throw new RangeError(`executionTimeoutMs must be at least ${MIN_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1}.`);
    }
    if (
      !Number.isSafeInteger(input.patch.anchorLine) ||
      input.patch.anchorLine <= 0 ||
      input.patch.anchorLines.length < 1 ||
      input.patch.anchorLines.length > 128 ||
      input.patch.anchorLines.some((line) => !Number.isSafeInteger(line) || line <= 0)
    ) {
      throw new TypeError("Render patch anchors are invalid.");
    }
    boundedText(input.patch.insertedCode, "Inserted render source", MAX_MANIM_SOURCE_BYTES_V1, true);

    try {
      return await this.#connection.transaction(async (client) => {
        const head = await client.query<BlobRow & { generation: string }>(
          `SELECT h.generation::text AS generation, b.digest, b.object_key, b.version_id, b.etag, b.byte_size
             FROM public.workspace_source_heads h
             JOIN public.workspace_projects p
               ON p.tenant_id = h.tenant_id AND p.project_id = h.project_id AND p.deleted_at IS NULL
             JOIN public.source_blob_objects b ON b.tenant_id = h.tenant_id AND b.digest = h.digest
            WHERE h.tenant_id = $1 AND h.project_id = $2 AND h.source_path = $3
            FOR UPDATE OF h, p`,
          [tenant, project, path],
        );
        const current = head.rows[0];
        if (
          !current ||
          BigInt(current.generation) !== generation ||
          current.digest !== original.digest ||
          current.object_key !== original.objectKey ||
          current.version_id !== original.versionId ||
          current.etag !== original.etag ||
          current.byte_size !== original.byteSize
        ) {
          throw new HttpError("The source changed before this render session could be created.", 409);
        }
        await this.#registerBlob(client, tenant, patched);
        await client.query(
          `INSERT INTO public.render_sessions
             (tenant_id, session_id, project_id, source_path, scene_name,
              program_batch_id, program_transaction_id, render_request_id, commit_correlation_key,
              original_generation, original_digest, patched_digest,
              patch_anchor_line, patch_anchor_lines, patch_inserted_code, status, execution_deadline)
           VALUES (
             $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11, $12, $13, $14, $15,
             'preparing', clock_timestamp() + ($16::integer * interval '1 millisecond')
           )`,
          [
            tenant,
            session,
            project,
            path,
            scene,
            batch,
            transaction,
            request,
            correlation,
            generation.toString(),
            original.digest,
            patched.digest,
            input.patch.anchorLine,
            [...input.patch.anchorLines],
            input.patch.insertedCode,
            executionTimeout,
          ],
        );
        await client.query(
          `INSERT INTO public.workspace_project_references
             (tenant_id, project_id, reference_kind, reference_id)
           VALUES ($1, $2, 'render-session', $3)`,
          [tenant, project, session],
        );
        return this.#selectSession(client, tenant, session);
      }, signal);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "23505") {
        throw new HttpError("That render session already exists.", 409);
      }
      throw error;
    }
  }

  async readSession(tenantValue: string, sessionValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const session = existingSessionId(sessionValue);
    return this.#connection.withClient((client) => this.#selectSession(client, tenant, session), signal);
  }

  async findRecoverableSessions(tenantValue: string, limitValue: number, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const limit = boundedPositiveInteger(limitValue, "limit", MAX_RECOVERABLE_SESSION_PAGE_V1);
    const result = await this.#connection.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM public.render_sessions s
         ${SESSION_JOINS}
        WHERE s.tenant_id = $1
          AND (
            s.status = 'preparing'
            OR (s.status = 'rendering' AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= clock_timestamp()))
          )
        ORDER BY s.updated_at, s.session_id
        LIMIT $2`,
      [tenant, limit],
      signal,
    );
    return result.rows.map(sessionFromRow);
  }

  async expireTimedOutSessions(tenantValue: string, limitValue: number, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const limit = boundedPositiveInteger(limitValue, "limit", MAX_RECOVERABLE_SESSION_PAGE_V1);
    const result = await this.#connection.query(
      `WITH expired AS (
         SELECT tenant_id, session_id
           FROM public.render_sessions
          WHERE tenant_id = $1
            AND status IN ('preparing', 'rendering')
            AND execution_deadline <= clock_timestamp()
          ORDER BY execution_deadline, session_id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE public.render_sessions s
          SET status = 'failed',
              version = version + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              error = 'Render execution was interrupted.',
              artifact_locator = NULL,
              updated_at = clock_timestamp()
         FROM expired
        WHERE s.tenant_id = expired.tenant_id
          AND s.session_id = expired.session_id`,
      [tenant, limit],
      signal,
    );
    return result.rowCount ?? 0;
  }

  async claimLease(input: DurableRenderLeaseClaimV1, signal?: AbortSignal) {
    const tenant = tenantId(input.tenantId);
    const session = existingSessionId(input.sessionId);
    const owner = boundedText(input.ownerId, "Lease owner", MAX_RENDER_IDENTIFIER_BYTES_V1);
    const duration = boundedPositiveInteger(input.leaseDurationMs, "leaseDurationMs", MAX_DURABLE_RENDER_LEASE_MS_V1);
    return this.#connection.transaction(async (client) => {
      const current = await this.#selectSession(client, tenant, session, true);
      if (!(current.status === "preparing" || current.status === "rendering")) {
        throw new HttpError("Only an active render session can be leased.", 409);
      }
      if (current.version > MAX_INCREMENTABLE_BIGINT_V1 || current.fenceToken > MAX_INCREMENTABLE_BIGINT_V1) {
        throw new HttpError("The render session lease counter is exhausted.", 409);
      }
      const claimed = await client.query(
        `UPDATE public.render_sessions
            SET status = 'rendering',
                progress = GREATEST(progress, 0.2),
                version = version + 1,
                fence_token = fence_token + 1,
                execution_attempts = execution_attempts + 1,
                lease_owner = $3,
                lease_expires_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND session_id = $2::uuid
            AND (
              lease_owner IS NULL
              OR lease_owner = $3
              OR lease_expires_at <= clock_timestamp()
            )`,
        [tenant, session, owner, duration],
      );
      if (claimed.rowCount !== 1) throw new HttpError("The render session is leased by another worker.", 409);
      return this.#selectSession(client, tenant, session);
    }, signal);
  }

  async renewLease(input: DurableRenderLeaseRenewalV1, signal?: AbortSignal) {
    const tenant = tenantId(input.tenantId);
    const session = existingSessionId(input.sessionId);
    const owner = boundedText(input.ownerId, "Lease owner", MAX_RENDER_IDENTIFIER_BYTES_V1);
    const duration = boundedPositiveInteger(input.leaseDurationMs, "leaseDurationMs", MAX_DURABLE_RENDER_LEASE_MS_V1);
    const updated = await this.#connection.query(
      `UPDATE public.render_sessions
          SET lease_expires_at = clock_timestamp() + ($6::integer * interval '1 millisecond'),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1
          AND session_id = $2::uuid
          AND lease_owner = $3
          AND version = $4::bigint
          AND fence_token = $5::bigint
          AND lease_expires_at > clock_timestamp()
          AND status IN ('preparing', 'rendering')`,
      [tenant, session, owner, input.expectedVersion.toString(), input.fenceToken.toString(), duration],
      signal,
    );
    if (updated.rowCount !== 1) throw new HttpError("The render lease is stale.", 409);
    return this.readSession(tenant, session, signal);
  }

  async completeLease(input: DurableRenderLeaseCompletionV1, signal?: AbortSignal) {
    const tenant = tenantId(input.tenantId);
    const session = existingSessionId(input.sessionId);
    const owner = boundedText(input.ownerId, "Lease owner", MAX_RENDER_IDENTIFIER_BYTES_V1);
    if (!(input.status === "cancelled" || input.status === "failed" || input.status === "ready")) {
      throw new TypeError("Render completion status is invalid.");
    }
    if (!Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1) {
      throw new TypeError("Render progress is invalid.");
    }
    boundedText(input.logTail, "Render log", MAX_DURABLE_RENDER_LOG_BYTES_V1, true);
    if (input.error !== null) boundedText(input.error, "Render error", MAX_DURABLE_RENDER_ERROR_BYTES_V1);
    const artifact = input.artifactLocator ?? null;
    if (artifact !== null) {
      boundedText(artifact, "Render artifact locator", MAX_DURABLE_RENDER_ARTIFACT_LOCATOR_BYTES_V1);
    }
    const result = await this.#connection.query(
      `UPDATE public.render_sessions
          SET status = $6,
              progress = $7,
              log_tail = $8,
              error = $9,
              artifact_locator = $10,
              version = version + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = clock_timestamp()
        WHERE tenant_id = $1
          AND session_id = $2::uuid
          AND lease_owner = $3
          AND version = $4::bigint
          AND fence_token = $5::bigint
          AND lease_expires_at > clock_timestamp()
          AND ($6 <> 'ready' OR execution_deadline > clock_timestamp())
          AND status IN ('preparing', 'rendering')`,
      [
        tenant,
        session,
        owner,
        input.expectedVersion.toString(),
        input.fenceToken.toString(),
        input.status,
        input.progress,
        input.logTail,
        input.error,
        artifact,
      ],
      signal,
    );
    if (result.rowCount !== 1) throw new HttpError("The render completion fence is stale.", 409);
    return this.readSession(tenant, session, signal);
  }

  async applySourceAction(input: DurableRenderSourceActionInputV1, signal?: AbortSignal) {
    const tenant = tenantId(input.tenantId);
    const session = existingSessionId(input.sessionId);
    const actionId = uuidV4(input.actionId, "Source action ID");
    const expectedKey = boundedText(input.expectedKey, "Source action key", MAX_CORRELATION_KEY_BYTES_V1);
    const transaction = await this.#connection.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenant}:render-source-action:${actionId}`,
      ]);
      const current = await this.#selectSession(client, tenant, session, true);
      const prior = await client.query<ActionRow>(
        `SELECT tenant_id, action_id::text AS action_id, session_id::text AS session_id,
                kind, expected_key, state, outcome, created_at, updated_at
           FROM public.render_source_actions
          WHERE tenant_id = $1 AND action_id = $2::uuid
          FOR UPDATE`,
        [tenant, actionId],
      );
      if (prior.rowCount === 1) {
        const action = actionFromRow(prior.rows[0]!);
        if (action.sessionId !== session || action.kind !== input.kind || action.expectedKey !== expectedKey) {
          throw new HttpError("The source action ID is already bound to a different mutation.", 409);
        }
        if (action.state !== "succeeded") {
          throw new HttpError(`The previous ${actionLabel(input.kind)} action did not succeed.`, 409);
        }
        return {
          failure: null,
          result: { action, executed: false, session: current } satisfies DurableRenderSourceActionResultV1,
        };
      }

      if (current.version !== input.expectedSessionVersion) {
        throw new HttpError("The render session changed before this source action could be applied.", 409);
      }

      if (input.kind === "commit") {
        if (current.status !== "ready") throw new HttpError("Only a successful preview can be committed.", 409);
        if (expectedKey !== current.commitCorrelationKey) {
          throw new HttpError("The rendered preview no longer matches the active Studio candidate.", 409);
        }
      } else {
        if (current.status !== "committed") {
          throw new HttpError("Only a committed source change can be undone.", 409);
        }
        if (expectedKey !== "undo") throw new HttpError("The Undo action key is invalid.", 409);
      }
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.render_source_actions WHERE tenant_id = $1 AND session_id = $2::uuid",
        [tenant, session],
      );
      if (BigInt(count.rows[0]?.count ?? "0") >= BigInt(MAX_SOURCE_ACTION_RECORDS_V1)) {
        throw new HttpError("This render session has too many retained source-action outcomes.", 429);
      }

      const expectedGeneration =
        input.kind === "commit" ? current.original.generation : current.original.generation + 1n;
      const expectedDigest = input.kind === "commit" ? current.original.blob.digest : current.patched.blob.digest;
      const candidateDigest = input.kind === "commit" ? current.patched.blob.digest : current.original.blob.digest;
      const head = await client.query<{ digest: string; generation: string }>(
        `UPDATE public.workspace_source_heads h
            SET generation = h.generation + 1,
                digest = $6,
                updated_at = clock_timestamp()
           FROM public.workspace_projects p
          WHERE h.tenant_id = $1
            AND h.project_id = $2
            AND h.source_path = $3
            AND h.generation = $4::bigint
            AND h.digest = $5
            AND p.tenant_id = h.tenant_id
            AND p.project_id = h.project_id
            AND p.deleted_at IS NULL
        RETURNING h.generation::text AS generation, h.digest`,
        [tenant, current.projectId, current.sourcePath, expectedGeneration.toString(), expectedDigest, candidateDigest],
      );
      if (head.rowCount !== 1) {
        const failure = new HttpError(
          input.kind === "commit"
            ? "The source changed after preview. Render again before committing."
            : "The committed source changed again, so Studio will not overwrite it during Undo.",
          409,
        );
        const failed = await client.query<ActionRow>(
          `INSERT INTO public.render_source_actions
             (tenant_id, action_id, session_id, kind, expected_key, state, outcome)
           VALUES ($1, $2::uuid, $3::uuid, $4, $5, 'failed', NULL)
           RETURNING tenant_id, action_id::text AS action_id, session_id::text AS session_id,
                     kind, expected_key, state, outcome, created_at, updated_at`,
          [tenant, actionId, session, input.kind, expectedKey],
        );
        await client.query(
          `UPDATE public.render_sessions
              SET version = version + 1,
                  latest_action_id = $3::uuid,
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND session_id = $2::uuid`,
          [tenant, session, actionId],
        );
        return {
          failure,
          result: {
            action: actionFromRow(failed.rows[0]!),
            executed: true,
            session: await this.#selectSession(client, tenant, session),
          } satisfies DurableRenderSourceActionResultV1,
        };
      }
      const status = input.kind === "commit" ? "committed" : "undone";
      const outcome = status;
      const inserted = await client.query<ActionRow>(
        `INSERT INTO public.render_source_actions
           (tenant_id, action_id, session_id, kind, expected_key, state, outcome)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, 'succeeded', $6)
         RETURNING tenant_id, action_id::text AS action_id, session_id::text AS session_id,
                   kind, expected_key, state, outcome, created_at, updated_at`,
        [tenant, actionId, session, input.kind, expectedKey, outcome],
      );
      await client.query(
        `UPDATE public.render_sessions
            SET status = $3,
                version = version + 1,
                latest_action_id = $4::uuid,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenant, session, status, actionId],
      );
      return {
        failure: null,
        result: {
          action: actionFromRow(inserted.rows[0]!),
          executed: true,
          session: await this.#selectSession(client, tenant, session),
        } satisfies DurableRenderSourceActionResultV1,
      };
    }, signal);
    if (transaction.failure) throw transaction.failure;
    return transaction.result;
  }

  async cancelSourceAction(
    input: Omit<DurableRenderSourceActionInputV1, "expectedKey" | "expectedSessionVersion">,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(input.tenantId);
    const session = existingSessionId(input.sessionId);
    const actionId = uuidV4(input.actionId, "Source action ID");
    return this.#connection.transaction(async (client): Promise<DurableRenderSourceActionResultV1> => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenant}:render-source-action:${actionId}`,
      ]);
      const current = await this.#selectSession(client, tenant, session, true);
      const prior = await client.query<ActionRow>(
        `SELECT tenant_id, action_id::text AS action_id, session_id::text AS session_id,
                kind, expected_key, state, outcome, created_at, updated_at
           FROM public.render_source_actions
          WHERE tenant_id = $1 AND action_id = $2::uuid
          FOR UPDATE`,
        [tenant, actionId],
      );
      if (prior.rowCount === 1) {
        const action = actionFromRow(prior.rows[0]!);
        if (action.sessionId !== session || action.kind !== input.kind) {
          throw new HttpError("The source-action cancellation does not match its registered action.", 409);
        }
        return { action, executed: false, session: current };
      }
      const allowed = input.kind === "commit" ? current.status === "ready" : current.status === "committed";
      if (!allowed) {
        throw new HttpError(
          `Only a ${input.kind === "commit" ? "ready" : "committed"} render session can register this cancellation.`,
          409,
        );
      }
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.render_source_actions WHERE tenant_id = $1 AND session_id = $2::uuid",
        [tenant, session],
      );
      if (BigInt(count.rows[0]?.count ?? "0") >= BigInt(MAX_SOURCE_ACTION_RECORDS_V1)) {
        throw new HttpError("This render session has too many retained source-action outcomes.", 429);
      }
      const inserted = await client.query<ActionRow>(
        `INSERT INTO public.render_source_actions
           (tenant_id, action_id, session_id, kind, expected_key, state, outcome)
         VALUES ($1, $2::uuid, $3::uuid, $4, NULL, 'cancelled', NULL)
         RETURNING tenant_id, action_id::text AS action_id, session_id::text AS session_id,
                   kind, expected_key, state, outcome, created_at, updated_at`,
        [tenant, actionId, session, input.kind],
      );
      await client.query(
        `UPDATE public.render_sessions
            SET version = version + 1,
                latest_action_id = $3::uuid,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenant, session, actionId],
      );
      return {
        action: actionFromRow(inserted.rows[0]!),
        executed: true,
        session: await this.#selectSession(client, tenant, session),
      };
    }, signal);
  }

  async cancelSession(tenantValue: string, sessionValue: string, signal?: AbortSignal) {
    return this.#simpleTransition(tenantValue, sessionValue, "cancel", signal);
  }

  async discardSession(tenantValue: string, sessionValue: string, signal?: AbortSignal) {
    return this.#simpleTransition(tenantValue, sessionValue, "discard", signal);
  }

  async #simpleTransition(
    tenantValue: string,
    sessionValue: string,
    operation: "cancel" | "discard",
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    const session = existingSessionId(sessionValue);
    return this.#connection.transaction(async (client) => {
      const current = await this.#selectSession(client, tenant, session, true);
      const allowed =
        operation === "cancel"
          ? current.status === "preparing" || current.status === "rendering"
          : current.status === "cancelled" ||
            current.status === "failed" ||
            current.status === "ready" ||
            current.status === "undone";
      if (!allowed) {
        throw new HttpError(
          operation === "cancel"
            ? "Only an active render can be cancelled."
            : "Cancel an active render or Undo a committed change before discarding it.",
          409,
        );
      }
      await client.query(
        `UPDATE public.render_sessions
            SET status = $3,
                version = version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                error = CASE WHEN $3 = 'cancelled' THEN NULL ELSE error END,
                artifact_locator = CASE WHEN $3 = 'discarded' THEN NULL ELSE artifact_locator END,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenant, session, operation === "cancel" ? "cancelled" : "discarded"],
      );
      if (operation === "discard") {
        await client.query(
          `DELETE FROM public.workspace_project_references
            WHERE tenant_id = $1 AND project_id = $2
              AND reference_kind = 'render-session' AND reference_id = $3`,
          [tenant, current.projectId, session],
        );
      }
      return this.#selectSession(client, tenant, session);
    }, signal);
  }

  async abandonSession(
    tenantValue: string,
    sessionValue: string,
    expectedRenderRequestIdValue: string,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    const session = existingSessionId(sessionValue);
    const expectedRenderRequestId = boundedText(
      expectedRenderRequestIdValue,
      "Render request ID",
      MAX_RENDER_IDENTIFIER_BYTES_V1,
    );
    return this.#connection.transaction(async (client) => {
      const found = await client.query<{ project_id: string; render_request_id: string; status: string }>(
        `SELECT project_id, render_request_id, status
           FROM public.render_sessions
          WHERE tenant_id = $1 AND session_id = $2::uuid
          FOR UPDATE`,
        [tenant, session],
      );
      const current = found.rows[0];
      if (!current) return true;
      if (current.render_request_id !== expectedRenderRequestId) {
        throw new HttpError("The abandoned render no longer matches the Studio request.", 409);
      }
      if (current.status === "discarded") return true;
      if (
        !(
          current.status === "cancelled" ||
          current.status === "failed" ||
          current.status === "preparing" ||
          current.status === "ready" ||
          current.status === "rendering"
        )
      ) {
        throw new HttpError("A source-changing render session cannot be abandoned.", 409);
      }
      await client.query(
        `UPDATE public.render_sessions
            SET status = 'discarded',
                version = version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                artifact_locator = NULL,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenant, session],
      );
      await client.query(
        `DELETE FROM public.workspace_project_references
          WHERE tenant_id = $1 AND project_id = $2
            AND reference_kind = 'render-session' AND reference_id = $3`,
        [tenant, current.project_id, session],
      );
      return true;
    }, signal);
  }

  async close() {
    await this.#connection.close();
  }
}
