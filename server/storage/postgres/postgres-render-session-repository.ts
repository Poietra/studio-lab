import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import { opaqueIdV1Schema, sha256V1Schema } from "../../../src/engine/primitives";
import {
  manimProjectIdSchema,
  manimSourcePathSchema,
  type RenderSessionStatus,
  renderSessionFailureCodeSchema,
  renderSessionStatusSchema,
  renderSourceActionIdSchema,
} from "../../../src/render-pipeline/contracts";
import { HttpError } from "../../http/json";
import { manimRenderBrokerShardIdV1Schema } from "../../manim-render-sandbox-contract";
import {
  type RenderSessionTransitionOperation,
  renderSessionTransitionAllowed,
  renderSessionTransitionSources,
  renderSessionTransitionTarget,
  renderSessionTransitionTargets,
} from "../../manim-render-session-policy";
import { manimTenantIdSchema } from "../../manim-request-principal";
import { assertProjectPngReceiptV1, type ProjectPngHeadV1 } from "../project-png-storage";
import {
  DURABLE_RENDER_CANCELLATION_GRACE_MS_V1,
  type DurableRenderCancellationAcknowledgementV1,
  type DurableRenderCancellationDeliveryClaimV1,
  type DurableRenderCancellationDeliveryV1,
  type DurableRenderCancellationIntentV1,
  type DurableRenderCancellationRegistrationV1,
  MAX_DURABLE_RENDER_CANCELLATION_DELIVERY_LEASE_MS_V1,
  MAX_DURABLE_RENDER_CANCELLATION_INTENTS_PER_TENANT_V1,
  MAX_DURABLE_RENDER_CANCELLATION_INTENTS_V1,
  type RenderCancellationRepositoryV1,
} from "../render-cancellation-repository";
import {
  type CreateDurableRenderSessionInputV1,
  type DurableRenderLeaseClaimV1,
  type DurableRenderLeaseCompletionV1,
  type DurableRenderLeaseRenewalV1,
  type DurableRenderSessionPurgeInputV1,
  type DurableRenderSessionRetentionInputV1,
  type DurableRenderSessionRetentionResultV1,
  type DurableRenderSessionV1,
  type DurableRenderSourceActionInputV1,
  type DurableRenderSourceActionResultV1,
  type DurableRenderSourceActionV1,
  MAX_DURABLE_RENDER_ARTIFACT_LOCATOR_BYTES_V1,
  MAX_DURABLE_RENDER_ERROR_BYTES_V1,
  MAX_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
  MAX_DURABLE_RENDER_LEASE_MS_V1,
  MAX_DURABLE_RENDER_LOG_BYTES_V1,
  MAX_DURABLE_RENDER_RETENTION_MS_V1,
  MIN_DURABLE_RENDER_EXECUTION_TIMEOUT_MS_V1,
  MIN_DURABLE_RENDER_RETENTION_MS_V1,
  type RenderSessionRepositoryV1,
  type RenderSessionRetentionRepositoryV1,
} from "../render-session-repository";
import { MAX_MANIM_SOURCE_BYTES_V1, type SourceBlobReceiptV1 } from "../workspace-source-repository";
import { DURABLE_RETENTION_MIGRATION_V6_CHECKSUM } from "./durable-retention-schema";
import { PROJECT_PNG_MIGRATION_V5_CHECKSUM } from "./postgres-project-png-repository";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";
import { RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM } from "./render-cancellation-schema";
import { RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM } from "./render-session-cpu-failure-schema";
import { RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM } from "./render-session-failure-schema";

export { RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM } from "./render-cancellation-schema";
export { RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM } from "./render-session-cpu-failure-schema";
export { RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM } from "./render-session-failure-schema";

export const RENDER_SESSION_MIGRATION_V2_CHECKSUM = "f67255ae5d05b2951975a700974a9748c848c6a39b9bb51b3189c3e8ed2664e9";

const MAX_INCREMENTABLE_BIGINT_V1 = 9_223_372_036_854_775_806n;
const MAX_SOURCE_ACTION_RECORDS_V1 = 64;
const MAX_RECOVERABLE_SESSION_PAGE_V1 = 256;
const MAX_CORRELATION_KEY_BYTES_V1 = 2_048;
const MAX_RENDER_IDENTIFIER_BYTES_V1 = 240;
const RENDER_CANCELLATION_CAPACITY_LOCK_V1 = "render-cancellation-capacity:v1";

const SQL_STATUS_LITERALS = {
  cancelled: "'cancelled'",
  committed: "'committed'",
  discarded: "'discarded'",
  failed: "'failed'",
  preparing: "'preparing'",
  ready: "'ready'",
  rendering: "'rendering'",
  undone: "'undone'",
} as const satisfies Record<RenderSessionStatus, string>;

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
  failure_code: string | null;
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
  project_png_byte_size: number | null;
  project_png_digest: string | null;
  project_png_etag: string | null;
  project_png_generation: string | null;
  project_png_object_key: string | null;
  project_png_version_id: string | null;
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

type ProjectPngRow = BlobRow & {
  generation: string;
  project_id: string;
  tenant_id: string;
};

type RetentionCandidateRow = QueryResultRow & {
  original_digest: string;
  patched_digest: string;
  project_id: string;
  project_png_digest: string | null;
  project_png_generation: string | null;
  session_id: string;
};

type RetentionProjectPngRow = QueryResultRow & {
  digest: string;
  generation: string;
  project_id: string;
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

type CancellationRow = QueryResultRow & {
  acknowledged_at: Date | null;
  broker_shard_id: string;
  delivery_expires_at: Date | null;
  delivery_owner: string | null;
  delivery_token: string;
  expires_at: Date;
  fence_digest: string | null;
  job_id: string;
  reject_until: Date;
  requested_at: Date;
  session_id: string;
  tenant_id: string;
};

type CancellationSessionRow = QueryResultRow & {
  broker_shard_id: string | null;
  cancellation_current: boolean;
  status: string;
};

const CANCELLATION_COLUMNS = `
  cancellation.tenant_id,
  cancellation.session_id::text AS session_id,
  cancellation.broker_shard_id,
  cancellation.job_id,
  cancellation.reject_until,
  cancellation.requested_at,
  cancellation.delivery_owner,
  cancellation.delivery_token::text AS delivery_token,
  cancellation.delivery_expires_at,
  cancellation.acknowledged_at,
  cancellation.fence_digest,
  cancellation.expires_at
`;

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
  s.project_png_generation::text AS project_png_generation,
  s.project_png_digest,
  s.log_tail,
  s.error,
  s.failure_code,
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
  project_png.object_key AS project_png_object_key,
  project_png.version_id AS project_png_version_id,
  project_png.etag AS project_png_etag,
  project_png.byte_size AS project_png_byte_size,
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
  LEFT JOIN public.project_png_generations project_png_generation
    ON project_png_generation.tenant_id = s.tenant_id
   AND project_png_generation.project_id = s.project_id
   AND project_png_generation.generation = s.project_png_generation
   AND project_png_generation.digest = s.project_png_digest
  LEFT JOIN public.project_png_objects project_png
    ON project_png.tenant_id = project_png_generation.tenant_id
   AND project_png.project_id = project_png_generation.project_id
   AND project_png.digest = project_png_generation.digest
   AND project_png.object_key = project_png_generation.object_key
   AND project_png.version_id = project_png_generation.version_id
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

function retentionMs(value: number, name: string) {
  const bounded = boundedPositiveInteger(value, name, MAX_DURABLE_RENDER_RETENTION_MS_V1);
  if (bounded < MIN_DURABLE_RENDER_RETENTION_MS_V1) {
    throw new RangeError(`${name} must be at least ${MIN_DURABLE_RENDER_RETENTION_MS_V1}.`);
  }
  return bounded;
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

function brokerShardId(value: string) {
  const parsed = manimRenderBrokerShardIdV1Schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Render broker shard ID is invalid.");
  return parsed.data;
}

function cancellationOwnerId(value: string) {
  const parsed = opaqueIdV1Schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Cancellation delivery owner ID is invalid.");
  return parsed.data;
}

function cancellationFenceDigest(value: string) {
  const parsed = sha256V1Schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Cancellation fence digest is invalid.");
  return parsed.data;
}

function cancellationDeliveryToken(value: bigint) {
  if (typeof value !== "bigint" || value < 1n || value > 9_223_372_036_854_775_807n) {
    throw new TypeError("Cancellation delivery token is invalid.");
  }
  return value;
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

function projectPngGeneration(value: bigint) {
  if (value < 1n || value > 9_223_372_036_854_775_807n) {
    throw new TypeError("Project image.png generation is invalid.");
  }
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

function projectPngFromRow(row: SessionRow): ProjectPngHeadV1 | null {
  const values = [
    row.project_png_generation,
    row.project_png_digest,
    row.project_png_object_key,
    row.project_png_version_id,
    row.project_png_etag,
    row.project_png_byte_size,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null || value === undefined)) {
    throw new TypeError("PostgreSQL returned an incomplete project image.png render pin.");
  }
  const generation = BigInt(row.project_png_generation!);
  if (generation < 1n || generation > 9_223_372_036_854_775_807n) {
    throw new TypeError("PostgreSQL returned an invalid project image.png generation.");
  }
  return {
    generation,
    projectId: row.project_id,
    receipt: assertProjectPngReceiptV1(row.tenant_id, row.project_id, {
      byteSize: row.project_png_byte_size!,
      digest: row.project_png_digest!,
      etag: row.project_png_etag!,
      objectKey: row.project_png_object_key!,
      versionId: row.project_png_version_id!,
    }),
    tenantId: row.tenant_id,
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

function cancellationFromRow(row: CancellationRow): DurableRenderCancellationIntentV1 {
  const tenant = tenantId(row.tenant_id);
  const session = existingSessionId(row.session_id);
  const shard = brokerShardId(row.broker_shard_id);
  const token = BigInt(row.delivery_token);
  const deliveryFields = [row.delivery_owner, row.delivery_expires_at] as const;
  if (
    row.job_id !== `${tenant}/${session}` ||
    !(row.reject_until instanceof Date) ||
    !(row.requested_at instanceof Date) ||
    !(row.expires_at instanceof Date) ||
    Number.isNaN(row.reject_until.getTime()) ||
    Number.isNaN(row.requested_at.getTime()) ||
    Number.isNaN(row.expires_at.getTime()) ||
    token < 0n ||
    token > 9_223_372_036_854_775_807n ||
    (deliveryFields.every((value) => value === null)
      ? token !== 0n
      : deliveryFields.some((value) => value === null) ||
        token < 1n ||
        !(row.delivery_expires_at instanceof Date) ||
        Number.isNaN(row.delivery_expires_at.getTime())) ||
    (row.acknowledged_at !== null &&
      (!(row.acknowledged_at instanceof Date) || Number.isNaN(row.acknowledged_at.getTime()))) ||
    (row.acknowledged_at === null) !== (row.fence_digest === null)
  ) {
    throw new TypeError("PostgreSQL returned an invalid durable render cancellation intent.");
  }
  if (row.fence_digest !== null) cancellationFenceDigest(row.fence_digest);
  const delivery =
    row.acknowledged_at === null && row.delivery_owner !== null && row.delivery_expires_at !== null
      ? {
          expiresAt: row.delivery_expires_at,
          ownerId: cancellationOwnerId(row.delivery_owner),
          token,
        }
      : null;
  return {
    acknowledgedAt: row.acknowledged_at,
    brokerShardId: shard,
    delivery,
    expiresAt: row.expires_at,
    fenceDigest: row.fence_digest,
    jobId: row.job_id,
    rejectUntil: row.reject_until,
    requestedAt: row.requested_at,
    sessionId: session,
    tenantId: tenant,
  };
}

function sessionFromRow(row: SessionRow): DurableRenderSessionV1 {
  const parsedStatus = renderSessionStatusSchema.safeParse(row.status);
  const parsedFailureCode = renderSessionFailureCodeSchema.nullable().safeParse(row.failure_code);
  if (
    !parsedStatus.success ||
    !parsedFailureCode.success ||
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
    failureCode: parsedFailureCode.data,
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
    projectPng: projectPngFromRow(row),
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

async function updateTransition(client: PoolClient, text: string, values: unknown[]) {
  const result = await client.query(text, values);
  if (result.rowCount !== 1) throw new HttpError("The render session transition was rejected.", 409);
}

function transitionSourceSql(operation: RenderSessionTransitionOperation) {
  // Closed policy literals stay visible to PostgreSQL's partial-index planner.
  return renderSessionTransitionSources(operation)
    .map((value) => {
      const status = renderSessionStatusSchema.safeParse(value);
      if (!status.success) throw new TypeError("The render session transition contains an invalid status.");
      return SQL_STATUS_LITERALS[status.data];
    })
    .join(", ");
}

export class PostgresRenderSessionRepositoryV1
  implements RenderCancellationRepositoryV1, RenderSessionRepositoryV1, RenderSessionRetentionRepositoryV1
{
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
        FOR UPDATE`,
      [tenant, candidate.digest],
    );
    const row = existing.rows[0];
    if (!row || row.object_key !== candidate.objectKey || row.byte_size !== candidate.byteSize) {
      throw new TypeError("The stored source blob metadata conflicts with its digest.");
    }
    await client.query(
      `UPDATE public.source_blob_objects
          SET orphaned_at = NULL
        WHERE tenant_id = $1 AND digest = $2 AND orphaned_at IS NOT NULL`,
      [tenant, candidate.digest],
    );
    return receiptFromBlobRow(row);
  }

  async #selectSession(client: PoolClient, tenant: string, session: string, lock = false) {
    const result = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM public.render_sessions s
         ${SESSION_JOINS}
        WHERE s.tenant_id = $1 AND s.session_id = $2::uuid
          AND s.references_released_at IS NULL
        ${lock ? "FOR UPDATE OF s" : ""}`,
      [tenant, session],
    );
    if (result.rowCount !== 1) throw new HttpError("Manim render session not found.", 404);
    return sessionFromRow(result.rows[0]!);
  }

  async #selectCancellationRow(client: PoolClient, tenant: string, session: string, lock = false) {
    const result = await client.query<CancellationRow>(
      `SELECT ${CANCELLATION_COLUMNS}
         FROM public.render_cancellation_intents cancellation
        WHERE cancellation.tenant_id = $1 AND cancellation.session_id = $2::uuid
        ${lock ? "FOR UPDATE OF cancellation" : ""}`,
      [tenant, session],
    );
    return result.rows[0] ?? null;
  }

  async #selectCancellationSession(client: PoolClient, tenant: string, session: string, lock = false) {
    const result = await client.query<CancellationSessionRow>(
      `SELECT broker_shard_id, status,
              execution_deadline + ($3::integer * interval '1 millisecond') > clock_timestamp()
                AS cancellation_current
         FROM public.render_sessions
        WHERE tenant_id = $1 AND session_id = $2::uuid
          AND references_released_at IS NULL
        ${lock ? "FOR UPDATE" : ""}`,
      [tenant, session, DURABLE_RENDER_CANCELLATION_GRACE_MS_V1],
    );
    return result.rows[0] ?? null;
  }

  async #cancelLockedSession(client: PoolClient, tenant: string, session: string) {
    await updateTransition(
      client,
      `UPDATE public.render_sessions
          SET status = 'cancelled',
              version = version + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              error = NULL,
              failure_code = 'cancelled',
              updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND session_id = $2::uuid
          AND status IN (${transitionSourceSql("cancel")})`,
      [tenant, session],
    );
    return this.#selectSession(client, tenant, session);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (2, 5, 6, 7, 8, 9) ORDER BY version",
        [],
        signal,
      );
      return (
        result.rowCount === 6 &&
        result.rows[0]?.version === 2 &&
        result.rows[0]?.checksum === RENDER_SESSION_MIGRATION_V2_CHECKSUM &&
        result.rows[1]?.version === 5 &&
        result.rows[1]?.checksum === PROJECT_PNG_MIGRATION_V5_CHECKSUM &&
        result.rows[2]?.version === 6 &&
        result.rows[2]?.checksum === DURABLE_RETENTION_MIGRATION_V6_CHECKSUM &&
        result.rows[3]?.version === 7 &&
        result.rows[3]?.checksum === RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM &&
        result.rows[4]?.version === 8 &&
        result.rows[4]?.checksum === RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM &&
        result.rows[5]?.version === 9 &&
        result.rows[5]?.checksum === RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM
      );
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
        const projectPngResult = await client.query<ProjectPngRow>(
          `SELECT h.tenant_id, h.project_id, h.generation::text AS generation,
                  o.digest, o.object_key, o.version_id, o.etag, o.byte_size
             FROM public.project_png_heads h
             JOIN public.project_png_generations g
               ON g.tenant_id = h.tenant_id AND g.project_id = h.project_id
              AND g.generation = h.generation AND g.digest = h.digest
             JOIN public.project_png_objects o
               ON o.tenant_id = g.tenant_id AND o.project_id = g.project_id
              AND o.digest = g.digest AND o.object_key = g.object_key AND o.version_id = g.version_id
            WHERE h.tenant_id = $1 AND h.project_id = $2
            FOR KEY SHARE OF h, g, o`,
          [tenant, project],
        );
        const pinnedPngRow = projectPngResult.rows[0];
        const projectPng = pinnedPngRow
          ? {
              generation: projectPngGeneration(BigInt(pinnedPngRow.generation)),
              receipt: assertProjectPngReceiptV1(tenant, project, receiptFromBlobRow(pinnedPngRow)),
            }
          : null;
        await this.#registerBlob(client, tenant, patched);
        await client.query(
          `INSERT INTO public.render_sessions
             (tenant_id, session_id, project_id, source_path, scene_name,
              program_batch_id, program_transaction_id, render_request_id, commit_correlation_key,
              original_generation, original_digest, patched_digest,
              project_png_generation, project_png_digest,
              patch_anchor_line, patch_anchor_lines, patch_inserted_code, status, execution_deadline)
           VALUES (
             $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11, $12,
             $13::bigint, $14, $15, $16, $17,
             'preparing', clock_timestamp() + ($18::integer * interval '1 millisecond')
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
            projectPng?.generation ?? null,
            projectPng?.receipt.digest ?? null,
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

  async registerCancellation(
    tenantValue: string,
    sessionValue: string,
    signal?: AbortSignal,
  ): Promise<DurableRenderCancellationRegistrationV1> {
    const tenant = tenantId(tenantValue);
    const session = existingSessionId(sessionValue);
    return this.#connection.transaction(async (client) => {
      const state = await this.#selectCancellationSession(client, tenant, session, true);
      if (!state) throw new HttpError("Manim render session not found.", 404);
      const parsedStatus = renderSessionStatusSchema.safeParse(state.status);
      if (!parsedStatus.success) throw new TypeError("PostgreSQL returned an invalid durable render session.");

      await client.query(
        `DELETE FROM public.render_cancellation_intents
          WHERE tenant_id = $1 AND session_id = $2::uuid
            AND expires_at <= clock_timestamp()`,
        [tenant, session],
      );
      const existingRow = await this.#selectCancellationRow(client, tenant, session, true);
      if (existingRow) {
        return {
          intent: cancellationFromRow(existingRow),
          session: await this.#selectSession(client, tenant, session),
        };
      }
      if (parsedStatus.data === "cancelled" || parsedStatus.data === "discarded") {
        return { intent: null, session: await this.#selectSession(client, tenant, session) };
      }
      if (!renderSessionTransitionAllowed("cancel", parsedStatus.data)) {
        throw new HttpError("Only an active render can be cancelled.", 409);
      }

      if (state.broker_shard_id === null || !state.cancellation_current) {
        return { intent: null, session: await this.#cancelLockedSession(client, tenant, session) };
      }

      const shard = brokerShardId(state.broker_shard_id);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        RENDER_CANCELLATION_CAPACITY_LOCK_V1,
      ]);
      const afterCapacityLock = await this.#selectCancellationSession(client, tenant, session);
      if (!afterCapacityLock) throw new HttpError("Manim render session not found.", 404);
      if (afterCapacityLock.status !== parsedStatus.data || afterCapacityLock.broker_shard_id !== shard) {
        throw new HttpError("The render cancellation fence changed before registration.", 409);
      }
      if (!afterCapacityLock.cancellation_current) {
        return { intent: null, session: await this.#cancelLockedSession(client, tenant, session) };
      }
      await client.query(
        `WITH expired AS (
           SELECT tenant_id, session_id
             FROM public.render_cancellation_intents
            WHERE expires_at <= clock_timestamp()
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM public.render_cancellation_intents cancellation
          USING expired
          WHERE cancellation.tenant_id = expired.tenant_id
            AND cancellation.session_id = expired.session_id`,
      );
      const capacity = await client.query<{ global_count: number; tenant_count: number }>(
        `SELECT count(*)::integer AS global_count,
                (count(*) FILTER (WHERE tenant_id = $1))::integer AS tenant_count
           FROM public.render_cancellation_intents
          WHERE expires_at > clock_timestamp()`,
        [tenant],
      );
      const counts = capacity.rows[0];
      if (!counts || !Number.isSafeInteger(counts.global_count) || !Number.isSafeInteger(counts.tenant_count)) {
        throw new TypeError("PostgreSQL returned an invalid render cancellation capacity count.");
      }
      if (
        counts.global_count >= MAX_DURABLE_RENDER_CANCELLATION_INTENTS_V1 ||
        counts.tenant_count >= MAX_DURABLE_RENDER_CANCELLATION_INTENTS_PER_TENANT_V1
      ) {
        throw new HttpError("Durable render cancellation capacity is exhausted.", 429);
      }
      const inserted = await client.query<CancellationRow>(
        `INSERT INTO public.render_cancellation_intents AS cancellation
           (tenant_id, session_id, broker_shard_id, job_id, reject_until, expires_at)
         SELECT tenant_id, session_id, broker_shard_id,
                tenant_id || '/' || session_id::text,
                execution_deadline,
                execution_deadline + ($3::integer * interval '1 millisecond')
           FROM public.render_sessions
          WHERE tenant_id = $1 AND session_id = $2::uuid
            AND broker_shard_id = $4
            AND execution_deadline + ($3::integer * interval '1 millisecond') > clock_timestamp()
            AND status IN (${transitionSourceSql("cancel")})
        RETURNING ${CANCELLATION_COLUMNS}`,
        [tenant, session, DURABLE_RENDER_CANCELLATION_GRACE_MS_V1, shard],
      );
      const intent = inserted.rows[0];
      if (!intent) {
        const afterInsert = await this.#selectCancellationSession(client, tenant, session);
        if (
          afterInsert?.status === parsedStatus.data &&
          afterInsert.broker_shard_id === shard &&
          !afterInsert.cancellation_current
        ) {
          return { intent: null, session: await this.#cancelLockedSession(client, tenant, session) };
        }
        throw new HttpError("The render cancellation fence changed before registration.", 409);
      }
      return { intent: cancellationFromRow(intent), session: await this.#selectSession(client, tenant, session) };
    }, signal);
  }

  async readCancellation(tenantValue: string, sessionValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const session = existingSessionId(sessionValue);
    const row = await this.#connection.withClient(
      (client) => this.#selectCancellationRow(client, tenant, session),
      signal,
    );
    return row ? cancellationFromRow(row) : null;
  }

  async claimCancellationDeliveries(
    input: DurableRenderCancellationDeliveryClaimV1,
    signal?: AbortSignal,
  ): Promise<readonly DurableRenderCancellationDeliveryV1[]> {
    const tenant = tenantId(input.tenantId);
    const shard = brokerShardId(input.brokerShardId);
    const owner = cancellationOwnerId(input.ownerId);
    const duration = boundedPositiveInteger(
      input.leaseDurationMs,
      "leaseDurationMs",
      MAX_DURABLE_RENDER_CANCELLATION_DELIVERY_LEASE_MS_V1,
    );
    const maximum = boundedPositiveInteger(
      input.maximum,
      "maximum",
      MAX_DURABLE_RENDER_CANCELLATION_INTENTS_PER_TENANT_V1,
    );
    const result = await this.#connection.query<CancellationRow>(
      `WITH candidates AS (
         SELECT tenant_id, session_id
           FROM public.render_cancellation_intents
          WHERE tenant_id = $1
            AND broker_shard_id = $2
            AND acknowledged_at IS NULL
            AND expires_at > clock_timestamp()
            AND (
              delivery_owner IS NULL
              OR delivery_expires_at <= clock_timestamp()
              OR delivery_owner = $3
            )
            AND (
              (delivery_owner = $3 AND delivery_expires_at > clock_timestamp())
              OR delivery_token < 9223372036854775807
            )
          ORDER BY requested_at, session_id
          LIMIT $4
          FOR UPDATE SKIP LOCKED
       )
       UPDATE public.render_cancellation_intents AS cancellation
          SET delivery_owner = $3,
              delivery_token = CASE
                WHEN cancellation.delivery_owner = $3
                 AND cancellation.delivery_expires_at > clock_timestamp()
                  THEN cancellation.delivery_token
                ELSE cancellation.delivery_token + 1
              END,
              delivery_expires_at = LEAST(
                cancellation.expires_at,
                clock_timestamp() + ($5::integer * interval '1 millisecond')
              )
         FROM candidates
        WHERE cancellation.tenant_id = candidates.tenant_id
          AND cancellation.session_id = candidates.session_id
      RETURNING ${CANCELLATION_COLUMNS}`,
      [tenant, shard, owner, maximum, duration],
      signal,
    );
    return result.rows.map((row) => {
      const intent = cancellationFromRow(row);
      if (!intent.delivery) throw new TypeError("PostgreSQL returned an unleased render cancellation delivery.");
      return { ...intent, delivery: intent.delivery };
    });
  }

  async acknowledgeCancellation(input: DurableRenderCancellationAcknowledgementV1, signal?: AbortSignal) {
    const tenant = tenantId(input.tenantId);
    const session = existingSessionId(input.sessionId);
    const owner = cancellationOwnerId(input.ownerId);
    const token = cancellationDeliveryToken(input.deliveryToken);
    const digest = cancellationFenceDigest(input.fenceDigest);
    return this.#connection.transaction(async (client) => {
      const current = await this.#selectSession(client, tenant, session, true);
      const row = await this.#selectCancellationRow(client, tenant, session, true);
      if (!row) throw new HttpError("Render cancellation intent not found.", 404);
      const intent = cancellationFromRow(row);
      if (row.delivery_owner !== owner || BigInt(row.delivery_token) !== token) {
        throw new HttpError("The render cancellation delivery lease is stale.", 409);
      }
      if (intent.acknowledgedAt !== null) {
        if (intent.fenceDigest !== digest) {
          throw new HttpError("The render cancellation acknowledgement conflicts with its receipt.", 409);
        }
        return current;
      }
      if (!renderSessionTransitionAllowed("cancel", current.status)) {
        throw new HttpError("Only an active render can be cancelled.", 409);
      }
      const acknowledged = await client.query(
        `UPDATE public.render_cancellation_intents
            SET acknowledged_at = clock_timestamp(), fence_digest = $5
          WHERE tenant_id = $1 AND session_id = $2::uuid
            AND delivery_owner = $3 AND delivery_token = $4::bigint
            AND delivery_expires_at > clock_timestamp()
            AND expires_at > clock_timestamp()
            AND acknowledged_at IS NULL`,
        [tenant, session, owner, token.toString(), digest],
      );
      if (acknowledged.rowCount !== 1) {
        throw new HttpError("The render cancellation delivery lease is stale.", 409);
      }
      await updateTransition(
        client,
        `UPDATE public.render_sessions
            SET status = 'cancelled',
                version = version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                error = NULL,
                failure_code = 'cancelled',
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND session_id = $2::uuid
            AND status IN (${transitionSourceSql("cancel")})`,
        [tenant, session],
      );
      return this.#selectSession(client, tenant, session);
    }, signal);
  }

  async purgeExpiredCancellations(tenantValue: string, maximumValue: number, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const maximum = boundedPositiveInteger(
      maximumValue,
      "maximum",
      MAX_DURABLE_RENDER_CANCELLATION_INTENTS_PER_TENANT_V1,
    );
    const purged = await this.#connection.query(
      `WITH expired AS (
         SELECT tenant_id, session_id
           FROM public.render_cancellation_intents
          WHERE tenant_id = $1 AND expires_at <= clock_timestamp()
          ORDER BY expires_at, session_id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM public.render_cancellation_intents cancellation
        USING expired
        WHERE cancellation.tenant_id = expired.tenant_id
          AND cancellation.session_id = expired.session_id`,
      [tenant, maximum],
      signal,
    );
    return purged.rowCount ?? 0;
  }

  async findRecoverableSessions(
    tenantValue: string,
    brokerShardValue: string,
    limitValue: number,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    const shard = brokerShardId(brokerShardValue);
    const limit = boundedPositiveInteger(limitValue, "limit", MAX_RECOVERABLE_SESSION_PAGE_V1);
    const result = await this.#connection.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM public.render_sessions s
         ${SESSION_JOINS}
        WHERE s.tenant_id = $1
          AND (s.broker_shard_id IS NULL OR s.broker_shard_id = $2)
          AND s.references_released_at IS NULL
          AND s.status IN (${transitionSourceSql("claim-lease")})
          AND (s.status <> 'rendering' OR s.lease_expires_at IS NULL OR s.lease_expires_at <= clock_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM public.render_cancellation_intents cancellation
             WHERE cancellation.tenant_id = s.tenant_id
               AND cancellation.session_id = s.session_id
               AND cancellation.acknowledged_at IS NULL
               AND cancellation.expires_at > clock_timestamp()
          )
        ORDER BY s.updated_at, s.session_id
        LIMIT $3`,
      [tenant, shard, limit],
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
            AND status IN (${transitionSourceSql("expire")})
            AND execution_deadline <= clock_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM public.render_cancellation_intents cancellation
               WHERE cancellation.tenant_id = public.render_sessions.tenant_id
                 AND cancellation.session_id = public.render_sessions.session_id
                 AND cancellation.acknowledged_at IS NULL
                 AND cancellation.expires_at > clock_timestamp()
            )
          ORDER BY execution_deadline, session_id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE public.render_sessions s
          SET status = 'failed',
              version = version + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              error = 'Render execution deadline exceeded.',
              failure_code = 'deadline-exceeded',
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
    const shard = brokerShardId(input.brokerShardId);
    const owner = boundedText(input.ownerId, "Lease owner", MAX_RENDER_IDENTIFIER_BYTES_V1);
    const duration = boundedPositiveInteger(input.leaseDurationMs, "leaseDurationMs", MAX_DURABLE_RENDER_LEASE_MS_V1);
    return this.#connection.transaction(async (client) => {
      const current = await this.#selectSession(client, tenant, session, true);
      if (!renderSessionTransitionAllowed("claim-lease", current.status)) {
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
                broker_shard_id = COALESCE(broker_shard_id, $5),
                lease_owner = $3,
                lease_expires_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND session_id = $2::uuid
            AND (
              lease_owner IS NULL
              OR lease_owner = $3
              OR lease_expires_at <= clock_timestamp()
            )
            AND (broker_shard_id IS NULL OR broker_shard_id = $5)
            AND NOT EXISTS (
              SELECT 1 FROM public.render_cancellation_intents cancellation
               WHERE cancellation.tenant_id = public.render_sessions.tenant_id
                 AND cancellation.session_id = public.render_sessions.session_id
                 AND cancellation.acknowledged_at IS NULL
                 AND cancellation.expires_at > clock_timestamp()
            )
            AND status IN (${transitionSourceSql("claim-lease")})`,
        [tenant, session, owner, duration, shard],
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
          AND status IN (${transitionSourceSql("renew-lease")})`,
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
    if (!renderSessionTransitionTargets("complete-lease").includes(input.status)) {
      throw new TypeError("Render completion status is invalid.");
    }
    if (!Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1) {
      throw new TypeError("Render progress is invalid.");
    }
    boundedText(input.logTail, "Render log", MAX_DURABLE_RENDER_LOG_BYTES_V1, true);
    if (input.error !== null) boundedText(input.error, "Render error", MAX_DURABLE_RENDER_ERROR_BYTES_V1);
    const failureCode = renderSessionFailureCodeSchema.nullable().safeParse(input.failureCode);
    if (
      !failureCode.success ||
      (input.status === "ready" && failureCode.data !== null) ||
      (input.status === "cancelled" && failureCode.data !== "cancelled") ||
      (input.status === "failed" && (failureCode.data === null || failureCode.data === "cancelled"))
    ) {
      throw new TypeError("Render failure code is invalid for its completion status.");
    }
    const artifact = input.artifactLocator ?? null;
    if (artifact !== null) {
      boundedText(artifact, "Render artifact locator", MAX_DURABLE_RENDER_ARTIFACT_LOCATOR_BYTES_V1);
    }
    return this.#connection.transaction(async (client) => {
      await this.#selectSession(client, tenant, session, true);
      const pending = await client.query(
        `SELECT 1 FROM public.render_cancellation_intents
          WHERE tenant_id = $1 AND session_id = $2::uuid
            AND acknowledged_at IS NULL AND expires_at > clock_timestamp()`,
        [tenant, session],
      );
      if (pending.rowCount !== 0) throw new HttpError("The render completion fence is stale.", 409);
      const result = await client.query(
        `UPDATE public.render_sessions
            SET status = $6,
                progress = $7,
                log_tail = $8,
                error = $9,
                failure_code = $10,
                artifact_locator = $11,
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
            AND status IN (${transitionSourceSql("complete-lease")})`,
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
          failureCode.data,
          artifact,
        ],
      );
      if (result.rowCount !== 1) throw new HttpError("The render completion fence is stale.", 409);
      return this.#selectSession(client, tenant, session);
    }, signal);
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

      const transition = input.kind;
      if (!renderSessionTransitionAllowed(transition, current.status)) {
        throw new HttpError(
          input.kind === "commit"
            ? "Only a successful preview can be committed."
            : "Only a committed source change can be undone.",
          409,
        );
      }
      if (input.kind === "commit") {
        if (expectedKey !== current.commitCorrelationKey) {
          throw new HttpError("The rendered preview no longer matches the active Studio candidate.", 409);
        }
      } else {
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
      const status = renderSessionTransitionTarget(transition, current.status);
      const outcome = status;
      const inserted = await client.query<ActionRow>(
        `INSERT INTO public.render_source_actions
           (tenant_id, action_id, session_id, kind, expected_key, state, outcome)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, 'succeeded', $6)
         RETURNING tenant_id, action_id::text AS action_id, session_id::text AS session_id,
                   kind, expected_key, state, outcome, created_at, updated_at`,
        [tenant, actionId, session, input.kind, expectedKey, outcome],
      );
      await updateTransition(
        client,
        `UPDATE public.render_sessions
            SET status = $3,
                version = version + 1,
                latest_action_id = $4::uuid,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND session_id = $2::uuid AND status IN (${transitionSourceSql(transition)})`,
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
      if (!renderSessionTransitionAllowed(input.kind, current.status)) {
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
      if (!renderSessionTransitionAllowed(operation, current.status)) {
        throw new HttpError(
          operation === "cancel"
            ? "Only an active render can be cancelled."
            : "Cancel an active render or Undo a committed change before discarding it.",
          409,
        );
      }
      const nextStatus = renderSessionTransitionTarget(operation, current.status);
      await updateTransition(
        client,
        `UPDATE public.render_sessions
            SET status = $3,
                version = version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                error = CASE WHEN $3 = 'cancelled' THEN NULL ELSE error END,
                failure_code = CASE WHEN $3 = 'cancelled' THEN 'cancelled' ELSE failure_code END,
                artifact_locator = CASE WHEN $3 = 'discarded' THEN NULL ELSE artifact_locator END,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND session_id = $2::uuid
            ${operation === "cancel" ? "AND broker_shard_id IS NULL" : ""}
            AND status IN (${transitionSourceSql(operation)})`,
        [tenant, session, nextStatus],
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
      const found = await client.query<{
        broker_shard_id: string | null;
        project_id: string;
        render_request_id: string;
        status: string;
      }>(
        `SELECT broker_shard_id, project_id, render_request_id, status
           FROM public.render_sessions
          WHERE tenant_id = $1 AND session_id = $2::uuid
            AND references_released_at IS NULL
          FOR UPDATE`,
        [tenant, session],
      );
      const current = found.rows[0];
      if (!current) return true;
      if (current.render_request_id !== expectedRenderRequestId) {
        throw new HttpError("The abandoned render no longer matches the Studio request.", 409);
      }
      const parsedStatus = renderSessionStatusSchema.safeParse(current.status);
      if (!parsedStatus.success) throw new TypeError("PostgreSQL returned an invalid durable render session.");
      const status = parsedStatus.data;
      if (status === "discarded") return true;
      if (current.broker_shard_id !== null && renderSessionTransitionAllowed("cancel", status)) {
        throw new HttpError("A broker-bound render must be cancelled through its durable owner shard.", 409);
      }
      if (!renderSessionTransitionAllowed("abandon", status)) {
        throw new HttpError("A source-changing render session cannot be abandoned.", 409);
      }
      const nextStatus = renderSessionTransitionTarget("abandon", status);
      await updateTransition(
        client,
        `UPDATE public.render_sessions
            SET status = $3,
                version = version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                artifact_locator = NULL,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND session_id = $2::uuid AND status IN (${transitionSourceSql("abandon")})`,
        [tenant, session, nextStatus],
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

  async releaseExpiredInputs(
    input: DurableRenderSessionRetentionInputV1,
    signal?: AbortSignal,
  ): Promise<DurableRenderSessionRetentionResultV1> {
    const tenant = tenantId(input.tenantId);
    const maximum = boundedPositiveInteger(input.maximum, "maximum", MAX_RECOVERABLE_SESSION_PAGE_V1);
    const retention = retentionMs(input.retentionMs, "retentionMs");
    return this.#connection.transaction(async (client) => {
      const selected = await client.query<RetentionCandidateRow>(
        `SELECT s.session_id::text AS session_id, s.project_id,
                s.original_digest, s.patched_digest,
                s.project_png_generation::text AS project_png_generation,
                s.project_png_digest
           FROM public.render_sessions s
          WHERE s.tenant_id = $1
            AND s.references_released_at IS NULL
            AND s.status IN ('cancelled', 'discarded', 'failed', 'ready', 'undone')
            AND s.lease_owner IS NULL AND s.lease_expires_at IS NULL
            AND s.updated_at <= clock_timestamp() - ($2::double precision * interval '1 millisecond')
            AND NOT EXISTS (
              SELECT 1 FROM public.render_source_actions action
               WHERE action.tenant_id = s.tenant_id AND action.session_id = s.session_id
                 AND action.state = 'running'
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.render_cancellation_intents cancellation
               WHERE cancellation.tenant_id = s.tenant_id
                 AND cancellation.session_id = s.session_id
                 AND cancellation.expires_at > clock_timestamp()
            )
            AND (
              s.status <> 'ready'
              OR (
                NOT EXISTS (
                  SELECT 1 FROM public.render_session_artifacts artifact
                   WHERE artifact.tenant_id = s.tenant_id AND artifact.session_id = s.session_id
                     AND artifact.expires_at > clock_timestamp()
                )
                AND NOT EXISTS (
                  SELECT 1 FROM public.workspace_project_thumbnail_heads thumbnail
                   WHERE thumbnail.tenant_id = s.tenant_id AND thumbnail.session_id = s.session_id
                     AND thumbnail.expires_at > clock_timestamp()
                )
              )
            )
          ORDER BY s.updated_at, s.session_id
          LIMIT $3
          FOR UPDATE OF s SKIP LOCKED`,
        [tenant, retention, maximum],
      );
      if (selected.rows.length === 0) {
        return { projectPngGenerationsOrphaned: 0, releasedSessionIds: [], sourceBlobsOrphaned: 0 };
      }

      const sessionIds = selected.rows.map((row) => row.session_id);
      const pinnedPngs = await client.query<RetentionProjectPngRow>(
        `SELECT generation.project_id, generation.generation::text AS generation, generation.digest
           FROM public.project_png_generations generation
          WHERE generation.tenant_id = $1
            AND EXISTS (
              SELECT 1 FROM public.render_sessions session
               WHERE session.tenant_id = generation.tenant_id
                 AND session.session_id = ANY($2::uuid[])
                 AND session.project_id = generation.project_id
                 AND session.project_png_generation = generation.generation
                 AND session.project_png_digest = generation.digest
            )
          ORDER BY generation.project_id, generation.generation
          FOR UPDATE OF generation`,
        [tenant, sessionIds],
      );
      const sourceDigests = [
        ...new Set(selected.rows.flatMap((row) => [row.original_digest, row.patched_digest])),
      ].sort();
      for (const digest of sourceDigests) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenant}:${digest}`]);
        await client.query("SELECT 1 FROM public.source_blob_objects WHERE tenant_id = $1 AND digest = $2 FOR UPDATE", [
          tenant,
          digest,
        ]);
      }

      const released = await client.query<{ session_id: string }>(
        `UPDATE public.render_sessions
            SET original_digest = NULL,
                patched_digest = NULL,
                project_png_generation = NULL,
                project_png_digest = NULL,
                patch_inserted_code = '',
                log_tail = '',
                error = NULL,
                artifact_locator = NULL,
                references_released_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1
            AND session_id = ANY($2::uuid[])
            AND references_released_at IS NULL
        RETURNING session_id::text AS session_id`,
        [tenant, sessionIds],
      );
      if (released.rowCount !== selected.rowCount) {
        throw new Error("The render-session retention batch changed while locked.");
      }
      await client.query(
        `DELETE FROM public.workspace_project_references
          WHERE tenant_id = $1 AND reference_kind = 'render-session'
            AND reference_id = ANY($2::text[])`,
        [tenant, sessionIds],
      );

      let projectPngGenerationsOrphaned = 0;
      if (pinnedPngs.rows.length > 0) {
        const pins = JSON.stringify(
          pinnedPngs.rows.map((row) => ({
            digest: row.digest,
            generation: row.generation,
            project_id: row.project_id,
          })),
        );
        const marked = await client.query(
          `WITH pins AS (
             SELECT pin.project_id, pin.generation, pin.digest
               FROM jsonb_to_recordset($2::jsonb)
                    AS pin(project_id text, generation bigint, digest text)
           )
           UPDATE public.project_png_generations generation
              SET orphaned_at = clock_timestamp()
             FROM pins
            WHERE generation.tenant_id = $1
              AND generation.project_id = pins.project_id
              AND generation.generation = pins.generation
              AND generation.digest = pins.digest
              AND generation.orphaned_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.project_png_heads head
                 WHERE head.tenant_id = generation.tenant_id
                   AND head.project_id = generation.project_id
                   AND head.generation = generation.generation
                   AND head.digest = generation.digest
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.render_sessions session
                 WHERE session.tenant_id = generation.tenant_id
                   AND session.project_id = generation.project_id
                   AND session.project_png_generation = generation.generation
                   AND session.project_png_digest = generation.digest
              )`,
          [tenant, pins],
        );
        projectPngGenerationsOrphaned = marked.rowCount ?? 0;
      }

      const sourceMarked = await client.query(
        `UPDATE public.source_blob_objects source
            SET orphaned_at = clock_timestamp()
          WHERE source.tenant_id = $1
            AND source.digest = ANY($2::text[])
            AND source.orphaned_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM public.workspace_source_heads head
               WHERE head.tenant_id = source.tenant_id AND head.digest = source.digest
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.render_sessions session
               WHERE session.tenant_id = source.tenant_id
                 AND (session.original_digest = source.digest OR session.patched_digest = source.digest)
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.snapshot_artifact_objects artifact
               WHERE artifact.tenant_id = source.tenant_id AND artifact.source_digest = source.digest
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.snapshot_publications publication
               WHERE publication.tenant_id = source.tenant_id AND publication.source_digest = source.digest
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.render_artifact_objects artifact
               WHERE artifact.tenant_id = source.tenant_id AND artifact.source_digest = source.digest
            )`,
        [tenant, sourceDigests],
      );
      const releasedSet = new Set(released.rows.map((row) => row.session_id));
      return {
        projectPngGenerationsOrphaned,
        releasedSessionIds: sessionIds.filter((sessionId) => releasedSet.has(sessionId)),
        sourceBlobsOrphaned: sourceMarked.rowCount ?? 0,
      };
    }, signal);
  }

  async purgeReleasedSessions(input: DurableRenderSessionPurgeInputV1, signal?: AbortSignal) {
    const tenant = tenantId(input.tenantId);
    const maximum = boundedPositiveInteger(input.maximum, "maximum", MAX_RECOVERABLE_SESSION_PAGE_V1);
    const auditRetention = retentionMs(input.auditRetentionMs, "auditRetentionMs");
    const purged = await this.#connection.query(
      `WITH candidates AS (
         SELECT session.tenant_id, session.session_id
           FROM public.render_sessions session
          WHERE session.tenant_id = $1
            AND session.references_released_at IS NOT NULL
            AND session.references_released_at
                  <= clock_timestamp() - ($2::double precision * interval '1 millisecond')
            AND NOT EXISTS (
              SELECT 1 FROM public.render_source_actions action
               WHERE action.tenant_id = session.tenant_id AND action.session_id = session.session_id
                 AND action.state = 'running'
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.render_session_artifacts artifact
               WHERE artifact.tenant_id = session.tenant_id AND artifact.session_id = session.session_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.workspace_project_thumbnail_heads thumbnail
               WHERE thumbnail.tenant_id = session.tenant_id AND thumbnail.session_id = session.session_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.render_cancellation_intents cancellation
               WHERE cancellation.tenant_id = session.tenant_id
                 AND cancellation.session_id = session.session_id
                 AND cancellation.expires_at > clock_timestamp()
            )
          ORDER BY session.references_released_at, session.session_id
          LIMIT $3
          FOR UPDATE OF session SKIP LOCKED
       )
       DELETE FROM public.render_sessions session
        USING candidates
        WHERE session.tenant_id = candidates.tenant_id
          AND session.session_id = candidates.session_id`,
      [tenant, auditRetention, maximum],
      signal,
    );
    return purged.rowCount ?? 0;
  }

  async close() {
    await this.#connection.close();
  }
}
