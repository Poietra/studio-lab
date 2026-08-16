import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import {
  applyEditorEditMutationV1,
  MAX_APPLIED_EDITOR_PROGRAMS_V1,
  parseAuthoritativeEditorProgramsV1,
} from "../../../src/collaboration/editor-edit-mutation";
import { HttpError } from "../../http/json";
import {
  canonicalEditorProgramV1,
  canonicalEditorSessionSnapshotV1,
  createEditorDocumentKeyV1,
  type EditorDocumentProjectionV1,
  type EditorDocumentRepositoryV1,
  type EditorDocumentV1,
  type EditorEditEventV1,
  type EditorSessionSnapshotPutInputV1,
  type EditorSessionSnapshotRecordV1,
  type EditorSessionUpdateV1,
  mintNativeEditorDocumentKeyV1,
  parseEditorDocumentCommitInputV1,
  parseEditorDocumentNativeCreateInputV1,
  parseEditorDocumentOpenInputV1,
  parseEditorDocumentTailInputV1,
  parseEditorSessionSnapshotPutInputV1,
  parseEditorSessionSnapshotReadInputV1,
} from "../editor-document-repository";
import { MAX_MANAGED_PROJECTS_PER_TENANT_V1 } from "../workspace-source-repository";
import { EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_CHECKSUM } from "./editor-document-origin-schema";
import { EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM } from "./editor-document-schema";
import { EDITOR_MUTATION_MIGRATION_V18_CHECKSUM } from "./editor-mutation-schema";
import { EDITOR_SESSION_SNAPSHOT_MIGRATION_V23_CHECKSUM } from "./editor-session-snapshot-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

const MAX_POSTGRES_REVISION_V1 = 9_223_372_036_854_775_807n;

type DocumentRow = QueryResultRow & {
  document_key: Buffer;
  epoch: string;
  opened_at: Date;
  origin: string;
  project_id: string;
  revision: string;
  sealed_at: Date | null;
  source_hash: Buffer | null;
  source_path: string | null;
  tenant_id: string;
  updated_at: Date;
};

type EventRow = QueryResultRow & {
  base_revision: string;
  canonical_byte_size: number;
  canonical_digest: Buffer;
  canonical_program: unknown;
  client_mutation_id: string;
  committed_at: Date;
  document_key: Buffer;
  epoch: string;
  mutation_kind: string;
  project_id: string;
  revision: string;
  session_base_generation: string | null;
  session_generation: string | null;
  session_snapshot_byte_size: number | null;
  session_snapshot_digest: Buffer | null;
  session_snapshot_version: number | null;
  subject_id: string;
  target_transaction_id: string | null;
  tenant_id: string;
};

type SessionSnapshotRow = QueryResultRow & {
  document_key: Buffer;
  document_revision: string;
  epoch: string;
  project_id: string;
  session_generation: string;
  snapshot: unknown;
  snapshot_byte_size: number;
  snapshot_digest: Buffer;
  snapshot_version: number;
  subject_id: string;
  tenant_id: string;
  updated_at: Date;
};

type SessionSnapshotReadRow = SessionSnapshotRow & {
  current_document_revision: string;
  projection_programs: unknown;
  projection_revision: string;
};

type ProjectionRow = QueryResultRow & {
  canonical_programs: unknown;
  revision: string;
};

const DOCUMENT_COLUMNS_V1 = `document.tenant_id,
       document.project_id,
       document.document_key,
       document.epoch::text AS epoch,
       document.origin,
       document.source_path,
       document.source_hash,
       document.revision::text AS revision,
       document.opened_at,
       document.updated_at,
       document.sealed_at`;

const EVENT_COLUMNS_V1 = `event.tenant_id,
       event.project_id,
       event.document_key,
       event.epoch::text AS epoch,
       event.base_revision::text AS base_revision,
       event.revision::text AS revision,
       event.subject_id::text AS subject_id,
       event.client_mutation_id::text AS client_mutation_id,
       event.mutation_kind,
       event.target_transaction_id,
       event.canonical_program,
       event.canonical_digest,
       event.canonical_byte_size,
       event.session_base_generation::text AS session_base_generation,
       event.session_generation::text AS session_generation,
       event.session_snapshot_version,
       event.session_snapshot_digest,
       event.session_snapshot_byte_size,
       event.committed_at`;

const SESSION_SNAPSHOT_COLUMNS_V1 = `snapshot.tenant_id,
       snapshot.project_id,
       snapshot.document_key,
       snapshot.subject_id::text AS subject_id,
       snapshot.epoch::text AS epoch,
       snapshot.document_revision::text AS document_revision,
       snapshot.session_generation::text AS session_generation,
       snapshot.snapshot_version,
       snapshot.snapshot,
       snapshot.snapshot_digest,
       snapshot.snapshot_byte_size,
       snapshot.updated_at`;

function revisionFromPostgresV1(value: string, label: string) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  const revision = BigInt(value);
  if (revision > MAX_POSTGRES_REVISION_V1) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  return revision;
}

function digestFromPostgresV1(value: Buffer, label: string) {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32)
    throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  return value.toString("hex");
}

function digestBytesV1(value: string) {
  return Buffer.from(value, "hex");
}

function documentFromRowV1(row: DocumentRow): EditorDocumentV1 {
  const base = {
    documentKey: digestFromPostgresV1(row.document_key, "editor document key"),
    epoch: row.epoch,
    openedAt: row.opened_at,
    projectId: row.project_id,
    revision: revisionFromPostgresV1(row.revision, "editor document revision"),
    sealedAt: row.sealed_at,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  } as const;
  if (row.origin === "studio-native") {
    if (row.source_path !== null || row.source_hash !== null) {
      throw new TypeError("PostgreSQL returned a native editor document with a source binding.");
    }
    return Object.freeze({ ...base, origin: "studio-native", sourceHash: null, sourcePath: null });
  }
  if (row.origin !== "imported-manim") {
    throw new TypeError("PostgreSQL returned an unknown editor document origin.");
  }
  if (row.source_path === null || row.source_hash === null) {
    throw new TypeError("PostgreSQL returned an imported editor document without its source binding.");
  }
  return Object.freeze({
    ...base,
    origin: "imported-manim",
    sourceHash: digestFromPostgresV1(row.source_hash, "editor document source hash"),
    sourcePath: row.source_path,
  });
}

function eventFromRowV1(row: EventRow): EditorEditEventV1 {
  const canonical = canonicalEditorProgramV1(row.canonical_program);
  const digest = digestFromPostgresV1(row.canonical_digest, "editor event digest");
  if (canonical.digest !== digest || canonical.byteSize !== row.canonical_byte_size) {
    throw new TypeError("PostgreSQL returned an inconsistent canonical editor event.");
  }
  const mutation = (() => {
    if (row.mutation_kind === "append") {
      if (row.target_transaction_id !== null) {
        throw new TypeError("PostgreSQL returned an append event with a target transaction.");
      }
      return { kind: "append", program: canonical.program } as const;
    }
    if (row.mutation_kind !== "replace" && row.mutation_kind !== "remove") {
      throw new TypeError("PostgreSQL returned an unknown editor mutation kind.");
    }
    if (
      typeof row.target_transaction_id !== "string" ||
      row.target_transaction_id.length < 1 ||
      row.target_transaction_id.length > 160
    ) {
      throw new TypeError("PostgreSQL returned an editor mutation without a valid target transaction.");
    }
    return {
      kind: row.mutation_kind,
      program: canonical.program,
      targetTransactionId: row.target_transaction_id,
    } as const;
  })();
  return Object.freeze({
    baseRevision: revisionFromPostgresV1(row.base_revision, "editor event base revision"),
    byteSize: canonical.byteSize,
    clientMutationId: row.client_mutation_id,
    committedAt: row.committed_at,
    digest,
    documentKey: digestFromPostgresV1(row.document_key, "editor event document key"),
    epoch: row.epoch,
    mutation,
    projectId: row.project_id,
    revision: revisionFromPostgresV1(row.revision, "editor event revision"),
    subjectId: row.subject_id,
    tenantId: row.tenant_id,
  });
}

function sessionSnapshotFromRowV1(row: SessionSnapshotRow): EditorSessionSnapshotRecordV1 {
  const canonical = canonicalEditorSessionSnapshotV1(row.snapshot);
  const digest = digestFromPostgresV1(row.snapshot_digest, "editor session snapshot digest");
  if (canonical.digest !== digest || canonical.byteSize !== row.snapshot_byte_size) {
    throw new TypeError("PostgreSQL returned an inconsistent editor session snapshot.");
  }
  if (row.snapshot_version !== 1) {
    throw new TypeError("PostgreSQL returned an unknown editor session snapshot version.");
  }
  return Object.freeze({
    documentKey: digestFromPostgresV1(row.document_key, "editor session document key"),
    documentRevision: revisionFromPostgresV1(row.document_revision, "editor session document revision"),
    epoch: row.epoch,
    projectId: row.project_id,
    sessionGeneration: revisionFromPostgresV1(row.session_generation, "editor session generation"),
    snapshot: canonical.snapshot,
    snapshotByteSize: canonical.byteSize,
    snapshotDigest: canonical.digest,
    snapshotVersion: 1,
    subjectId: row.subject_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  });
}

function eventSessionEvidenceMatchesV1(row: EventRow, update: EditorSessionUpdateV1 | undefined) {
  const hasNoEvidence =
    row.session_base_generation == null &&
    row.session_generation == null &&
    row.session_snapshot_version == null &&
    row.session_snapshot_digest == null &&
    row.session_snapshot_byte_size == null;
  if (!update) return hasNoEvidence;
  if (hasNoEvidence || row.session_snapshot_digest == null) return false;
  const canonical = canonicalEditorSessionSnapshotV1(update.snapshot);
  return (
    revisionFromPostgresV1(row.session_base_generation ?? "", "editor event session base generation") ===
      update.expectedSessionGeneration &&
    revisionFromPostgresV1(row.session_generation ?? "", "editor event session generation") ===
      update.expectedSessionGeneration + 1n &&
    row.session_snapshot_version === update.snapshotVersion &&
    digestFromPostgresV1(row.session_snapshot_digest, "editor event session snapshot digest") === canonical.digest &&
    row.session_snapshot_byte_size === canonical.byteSize &&
    revisionFromPostgresV1(row.revision, "editor event revision") === update.documentRevision
  );
}

function sameEventCandidateV1(
  row: EventRow,
  input: ReturnType<typeof parseEditorDocumentCommitInputV1>,
  canonical: ReturnType<typeof canonicalEditorProgramV1>,
) {
  const event = eventFromRowV1(row);
  const eventTarget = event.mutation.kind === "append" ? null : event.mutation.targetTransactionId;
  const inputTarget = input.mutation.kind === "append" ? null : input.mutation.targetTransactionId;
  return (
    event.documentKey === input.documentKey &&
    event.epoch === input.epoch &&
    event.baseRevision === input.baseRevision &&
    event.mutation.kind === input.mutation.kind &&
    eventTarget === inputTarget &&
    event.digest === canonical.digest &&
    event.byteSize === canonical.byteSize &&
    eventSessionEvidenceMatchesV1(row, input.sessionUpdate)
  );
}

function snapshotMatchesProjectionV1(
  snapshot: EditorSessionUpdateV1["snapshot"],
  programs: EditorDocumentProjectionV1["programs"],
) {
  try {
    return (
      snapshot.appliedPrograms.length === programs.length &&
      snapshot.appliedPrograms.every((record, index) => {
        const expected = programs[index];
        if (!expected) return false;
        const left = canonicalEditorProgramV1(record.program);
        const right = canonicalEditorProgramV1(expected);
        return left.digest === right.digest && left.byteSize === right.byteSize;
      })
    );
  } catch {
    return false;
  }
}

function foldAuthoritativeEventsV1(
  initialPrograms: readonly EditorEditEventV1["mutation"]["program"][],
  initialRevision: bigint,
  events: readonly EditorEditEventV1[],
  expectedRevision: bigint,
) {
  let programs = parseAuthoritativeEditorProgramsV1(initialPrograms);
  let revision = initialRevision;
  for (const event of events) {
    if (event.baseRevision !== revision || event.revision !== revision + 1n) {
      throw new TypeError("PostgreSQL returned a non-contiguous editor event history.");
    }
    const applied = applyEditorEditMutationV1(programs, event.mutation);
    if (applied.kind !== "applied") {
      throw new TypeError("PostgreSQL returned a semantically inconsistent editor event history.");
    }
    programs = applied.programs;
    revision = event.revision;
  }
  if (revision !== expectedRevision) {
    throw new TypeError("PostgreSQL returned an editor event history behind its document revision.");
  }
  return programs;
}

function authoritativeProjectionProgramsV1(value: unknown) {
  const programs = parseAuthoritativeEditorProgramsV1(value).map(
    (program) => canonicalEditorProgramV1(program).program,
  );
  return Object.freeze(parseAuthoritativeEditorProgramsV1(programs));
}

function projectionProgramsJsonV1(programs: readonly EditorEditEventV1["mutation"]["program"][]) {
  return JSON.stringify(authoritativeProjectionProgramsV1(programs));
}

function assertProjectionProgramCountV1(programs: EditorDocumentProjectionV1["programs"], revision: bigint) {
  if (BigInt(programs.length) > revision) {
    throw new TypeError("PostgreSQL editor projection contains more Programs than its revision.");
  }
}

async function alignedEditorProjectionV1(
  client: PoolClient,
  document: EditorDocumentV1,
): Promise<EditorDocumentProjectionV1> {
  const projectionResult = await client.query<ProjectionRow>(
    `SELECT projection.revision::text AS revision, projection.canonical_programs
       FROM public.editor_document_projections projection
      WHERE projection.tenant_id = $1 AND projection.project_id = $2
        AND projection.document_key = $3 AND projection.epoch = $4::uuid
      FOR UPDATE OF projection`,
    [document.tenantId, document.projectId, digestBytesV1(document.documentKey), document.epoch],
  );
  if (projectionResult.rows.length > 1) {
    throw new TypeError("PostgreSQL returned duplicate editor document projections.");
  }
  const projectionRow = projectionResult.rows[0];
  const storedRevision = projectionRow
    ? revisionFromPostgresV1(projectionRow.revision, "editor projection revision")
    : 0n;
  if (storedRevision > document.revision) {
    throw new TypeError("PostgreSQL returned an editor projection ahead of its document revision.");
  }
  let programs = projectionRow
    ? authoritativeProjectionProgramsV1(projectionRow.canonical_programs)
    : Object.freeze([]);
  assertProjectionProgramCountV1(programs, storedRevision);
  if (storedRevision < document.revision) {
    const history = await client.query<EventRow>(
      `SELECT ${EVENT_COLUMNS_V1}
         FROM public.editor_edit_events event
        WHERE event.tenant_id = $1 AND event.project_id = $2
          AND event.document_key = $3 AND event.epoch = $4::uuid
          AND event.revision > $5::bigint AND event.revision <= $6::bigint
        ORDER BY event.revision
        LIMIT ${MAX_APPLIED_EDITOR_PROGRAMS_V1 + 1}`,
      [
        document.tenantId,
        document.projectId,
        digestBytesV1(document.documentKey),
        document.epoch,
        storedRevision.toString(),
        document.revision.toString(),
      ],
    );
    if (history.rows.length > MAX_APPLIED_EDITOR_PROGRAMS_V1) {
      throw new TypeError("PostgreSQL editor projection recovery exceeds its bounded cutover window.");
    }
    programs = Object.freeze(
      foldAuthoritativeEventsV1(programs, storedRevision, history.rows.map(eventFromRowV1), document.revision),
    );
    assertProjectionProgramCountV1(programs, document.revision);
  }
  if (!projectionRow) {
    const insertedProjection = await client.query(
      `INSERT INTO public.editor_document_projections
         (tenant_id, project_id, document_key, epoch, revision, canonical_programs)
       VALUES ($1, $2, $3, $4::uuid, $5::bigint, $6::jsonb)`,
      [
        document.tenantId,
        document.projectId,
        digestBytesV1(document.documentKey),
        document.epoch,
        document.revision.toString(),
        projectionProgramsJsonV1(programs),
      ],
    );
    if (insertedProjection.rowCount !== 1) {
      throw new TypeError("PostgreSQL did not initialize the derived editor projection.");
    }
  } else if (storedRevision < document.revision) {
    const caughtUp = await client.query(
      `UPDATE public.editor_document_projections projection
          SET revision = $5::bigint, canonical_programs = $6::jsonb, updated_at = clock_timestamp()
        WHERE projection.tenant_id = $1 AND projection.project_id = $2
          AND projection.document_key = $3 AND projection.epoch = $4::uuid
          AND projection.revision = $7::bigint`,
      [
        document.tenantId,
        document.projectId,
        digestBytesV1(document.documentKey),
        document.epoch,
        document.revision.toString(),
        projectionProgramsJsonV1(programs),
        storedRevision.toString(),
      ],
    );
    if (caughtUp.rowCount !== 1) throw new TypeError("PostgreSQL did not catch up the editor projection.");
  }
  return Object.freeze({ programs, revision: document.revision });
}

async function actorCanEditV1(client: PoolClient, tenantId: string, subjectId: string) {
  const actor = await client.query<{ actor_can_edit: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM public.organization_memberships membership
         JOIN public.users account ON account.user_id = membership.user_id
         JOIN public.organizations organization ON organization.tenant_id = membership.tenant_id
        WHERE membership.tenant_id = $1 AND membership.user_id = $2::uuid
          AND membership.status = 'active' AND membership.role IN ('owner', 'admin', 'member')
          AND account.status = 'active' AND organization.status = 'active'
     ) AS actor_can_edit`,
    [tenantId, subjectId],
  );
  return actor.rowCount === 1 && actor.rows[0]?.actor_can_edit === true;
}

async function selectSessionSnapshotV1(
  client: PoolClient,
  input: Readonly<{ documentKey: string; projectId: string; subjectId: string; tenantId: string }>,
  lock: boolean,
) {
  const selected = await client.query<SessionSnapshotRow>(
    `SELECT ${SESSION_SNAPSHOT_COLUMNS_V1}
       FROM public.editor_session_snapshots snapshot
      WHERE snapshot.tenant_id = $1 AND snapshot.project_id = $2
        AND snapshot.document_key = $3 AND snapshot.subject_id = $4::uuid
      ${lock ? "FOR UPDATE OF snapshot" : ""}`,
    [input.tenantId, input.projectId, digestBytesV1(input.documentKey), input.subjectId],
  );
  if (selected.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate editor session snapshots.");
  return selected.rows[0] ? sessionSnapshotFromRowV1(selected.rows[0]) : null;
}

function sameSessionSnapshotCandidateV1(
  stored: EditorSessionSnapshotRecordV1,
  input: EditorSessionSnapshotPutInputV1,
  canonical: ReturnType<typeof canonicalEditorSessionSnapshotV1>,
) {
  return (
    stored.epoch === input.epoch &&
    stored.documentRevision === input.documentRevision &&
    stored.sessionGeneration === input.expectedSessionGeneration + 1n &&
    stored.snapshotVersion === input.snapshotVersion &&
    stored.snapshotDigest === canonical.digest &&
    stored.snapshotByteSize === canonical.byteSize &&
    canonicalEditorSessionSnapshotV1(stored.snapshot).json === canonical.json
  );
}

async function pruneOldEditorSessionsV1(
  client: PoolClient,
  input: Readonly<{ documentKey: string; projectId: string; subjectId: string; tenantId: string }>,
) {
  await client.query(
    `DELETE FROM public.editor_session_snapshots stale
      USING (
        SELECT snapshot.project_id, snapshot.document_key
          FROM public.editor_session_snapshots snapshot
         WHERE snapshot.tenant_id = $1 AND snapshot.subject_id = $2::uuid
           AND (snapshot.project_id <> $3 OR snapshot.document_key <> $4)
         ORDER BY snapshot.updated_at DESC, snapshot.project_id, snapshot.document_key
         OFFSET 19
      ) expired
      WHERE stale.tenant_id = $1 AND stale.subject_id = $2::uuid
        AND stale.project_id = expired.project_id AND stale.document_key = expired.document_key`,
    [input.tenantId, input.subjectId, input.projectId, digestBytesV1(input.documentKey)],
  );
}

async function storeSessionSnapshotV1(
  client: PoolClient,
  input: EditorSessionSnapshotPutInputV1,
): Promise<
  | Readonly<{ kind: "stored"; replayed: boolean; session: EditorSessionSnapshotRecordV1 }>
  | Readonly<{ currentSessionGeneration: bigint; kind: "conflict"; reason: "session-generation-mismatch" }>
> {
  const canonical = canonicalEditorSessionSnapshotV1(input.snapshot);
  const current = await selectSessionSnapshotV1(client, input, true);
  if (current && current.epoch === input.epoch && sameSessionSnapshotCandidateV1(current, input, canonical)) {
    return { kind: "stored", replayed: true, session: current };
  }

  if (!current) {
    if (input.expectedSessionGeneration !== 0n) {
      return { currentSessionGeneration: 0n, kind: "conflict", reason: "session-generation-mismatch" };
    }
    const inserted = await client.query<SessionSnapshotRow>(
      `INSERT INTO public.editor_session_snapshots AS snapshot
         (tenant_id, project_id, document_key, subject_id, epoch, document_revision,
          session_generation, snapshot_version, snapshot, snapshot_digest, snapshot_byte_size)
       VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6::bigint, 1, $7, $8::json, $9, $10)
       RETURNING ${SESSION_SNAPSHOT_COLUMNS_V1}`,
      [
        input.tenantId,
        input.projectId,
        digestBytesV1(input.documentKey),
        input.subjectId,
        input.epoch,
        input.documentRevision.toString(),
        input.snapshotVersion,
        canonical.json,
        digestBytesV1(canonical.digest),
        canonical.byteSize,
      ],
    );
    const row = inserted.rows[0];
    if (inserted.rowCount !== 1 || !row) throw new TypeError("PostgreSQL did not create the editor session snapshot.");
    await pruneOldEditorSessionsV1(client, input);
    return { kind: "stored", replayed: false, session: sessionSnapshotFromRowV1(row) };
  }

  const replacingEpoch = current.epoch !== input.epoch;
  if (
    (replacingEpoch && input.expectedSessionGeneration !== 0n) ||
    (!replacingEpoch && current.sessionGeneration !== input.expectedSessionGeneration)
  ) {
    return {
      currentSessionGeneration: replacingEpoch ? 0n : current.sessionGeneration,
      kind: "conflict",
      reason: "session-generation-mismatch",
    };
  }
  const nextGeneration = replacingEpoch ? 1n : input.expectedSessionGeneration + 1n;
  const updated = await client.query<SessionSnapshotRow>(
    `UPDATE public.editor_session_snapshots snapshot
        SET epoch = $5::uuid, document_revision = $6::bigint, session_generation = $7::bigint,
            snapshot_version = $8, snapshot = $9::json, snapshot_digest = $10,
            snapshot_byte_size = $11, updated_at = clock_timestamp()
      WHERE snapshot.tenant_id = $1 AND snapshot.project_id = $2
        AND snapshot.document_key = $3 AND snapshot.subject_id = $4::uuid
        AND snapshot.epoch = $12::uuid AND snapshot.session_generation = $13::bigint
      RETURNING ${SESSION_SNAPSHOT_COLUMNS_V1}`,
    [
      input.tenantId,
      input.projectId,
      digestBytesV1(input.documentKey),
      input.subjectId,
      input.epoch,
      input.documentRevision.toString(),
      nextGeneration.toString(),
      input.snapshotVersion,
      canonical.json,
      digestBytesV1(canonical.digest),
      canonical.byteSize,
      current.epoch,
      current.sessionGeneration.toString(),
    ],
  );
  const row = updated.rows[0];
  if (updated.rowCount !== 1 || !row) {
    throw new TypeError("PostgreSQL did not advance the locked editor session snapshot.");
  }
  await pruneOldEditorSessionsV1(client, input);
  return { kind: "stored", replayed: false, session: sessionSnapshotFromRowV1(row) };
}

function eventSessionUpdateEvidenceV1(row: EventRow) {
  if (row.session_base_generation == null) return undefined;
  if (
    row.session_generation == null ||
    row.session_snapshot_version !== 1 ||
    row.session_snapshot_digest == null ||
    row.session_snapshot_byte_size == null
  ) {
    throw new TypeError("PostgreSQL returned incomplete editor event session evidence.");
  }
  return Object.freeze({
    documentRevision: revisionFromPostgresV1(row.revision, "editor event revision"),
    sessionGeneration: revisionFromPostgresV1(row.session_generation, "editor event session generation"),
    snapshotByteSize: row.session_snapshot_byte_size,
    snapshotDigest: digestFromPostgresV1(row.session_snapshot_digest, "editor event session snapshot digest"),
    snapshotVersion: 1 as const,
  });
}

export type PostgresEditorDocumentRepositoryOptionsV1 = Readonly<{
  pool?: Pool;
  poolConfig?: PoolConfig;
  randomBytes?: (size: number) => Buffer;
  randomUuid?: () => string;
  statementTimeoutMs?: number;
}>;

function isPostgresErrorV1(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

/** PostgreSQL authority for committed collaborative editor Programs. */
export class PostgresEditorDocumentRepositoryV1 implements EditorDocumentRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;
  readonly #randomBytes: ((size: number) => Buffer) | undefined;
  readonly #randomUuid: () => string;

  constructor(options: PostgresEditorDocumentRepositoryOptionsV1) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
    this.#randomBytes = options.randomBytes;
    this.#randomUuid = options.randomUuid ?? randomUUID;
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (17, 18, 23, 30) ORDER BY version",
        [],
        signal,
      );
      signal?.throwIfAborted();
      return (
        result.rowCount === 4 &&
        result.rows[0]?.version === 17 &&
        result.rows[0]?.checksum === EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM &&
        result.rows[1]?.version === 18 &&
        result.rows[1]?.checksum === EDITOR_MUTATION_MIGRATION_V18_CHECKSUM &&
        result.rows[2]?.version === 23 &&
        result.rows[2]?.checksum === EDITOR_SESSION_SNAPSHOT_MIGRATION_V23_CHECKSUM &&
        result.rows[3]?.version === 30 &&
        result.rows[3]?.checksum === EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_CHECKSUM
      );
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  async openDocument(inputValue: Parameters<EditorDocumentRepositoryV1["openDocument"]>[0], signal?: AbortSignal) {
    const input = parseEditorDocumentOpenInputV1(inputValue);
    const documentKey = createEditorDocumentKeyV1(input.sourcePath, input.sceneId);
    return this.#connection.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `editor-document:${input.tenantId}:${input.projectId}:${documentKey}`,
      ]);
      const project = await client.query(
        `SELECT project.project_id
           FROM public.workspace_projects project
          WHERE project.tenant_id = $1 AND project.project_id = $2 AND project.deleted_at IS NULL
          FOR SHARE OF project`,
        [input.tenantId, input.projectId],
      );
      if (project.rowCount !== 1) return { kind: "not-found" } as const;
      const source = await client.query<{ source_hash: Buffer }>(
        `SELECT decode(source.digest, 'hex') AS source_hash
           FROM public.workspace_source_heads source
          WHERE source.tenant_id = $1 AND source.project_id = $2 AND source.source_path = $3
          FOR UPDATE OF source`,
        [input.tenantId, input.projectId, input.sourcePath],
      );
      if (source.rowCount !== 1 || !source.rows[0]) return { kind: "not-found" } as const;
      const currentSourceHash = digestFromPostgresV1(source.rows[0].source_hash, "workspace source hash");
      if (currentSourceHash !== input.sourceHash) {
        return { currentSourceHash, kind: "source-conflict" } as const;
      }

      await client.query(
        `UPDATE public.editor_documents
            SET sealed_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND project_id = $2 AND source_path = $3
            AND sealed_at IS NULL AND source_hash <> $4`,
        [input.tenantId, input.projectId, input.sourcePath, digestBytesV1(input.sourceHash)],
      );
      const current = await client.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS_V1}
           FROM public.editor_documents document
          WHERE document.tenant_id = $1 AND document.project_id = $2
            AND document.document_key = $3 AND document.sealed_at IS NULL
          FOR UPDATE OF document`,
        [input.tenantId, input.projectId, digestBytesV1(documentKey)],
      );
      if (current.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate open editor documents.");
      if (current.rows[0]) {
        const document = documentFromRowV1(current.rows[0]);
        const projection = await alignedEditorProjectionV1(client, document);
        return { created: false, document, kind: "opened", projection } as const;
      }

      const epoch = this.#randomUuid();
      const inserted = await client.query<DocumentRow>(
        `INSERT INTO public.editor_documents AS document
           (tenant_id, project_id, document_key, epoch, origin, source_path, source_hash, revision)
         VALUES ($1, $2, $3, $4::uuid, 'imported-manim', $5, $6, 0)
         RETURNING ${DOCUMENT_COLUMNS_V1}`,
        [
          input.tenantId,
          input.projectId,
          digestBytesV1(documentKey),
          epoch,
          input.sourcePath,
          digestBytesV1(input.sourceHash),
        ],
      );
      const row = inserted.rows[0];
      if (inserted.rowCount !== 1 || !row) throw new TypeError("PostgreSQL did not open the editor document.");
      const document = documentFromRowV1(row);
      if (document.revision !== 0n) throw new TypeError("PostgreSQL opened a non-zero editor document revision.");
      const projection = await client.query(
        `INSERT INTO public.editor_document_projections
           (tenant_id, project_id, document_key, epoch, revision, canonical_programs)
         VALUES ($1, $2, $3, $4::uuid, 0, '[]'::jsonb)`,
        [input.tenantId, input.projectId, digestBytesV1(documentKey), epoch],
      );
      if (projection.rowCount !== 1) throw new TypeError("PostgreSQL did not initialize the editor projection.");
      return {
        created: true,
        document,
        kind: "opened",
        projection: Object.freeze({ programs: Object.freeze([]), revision: 0n }),
      } as const;
    }, signal);
  }

  /**
   * Creates the Project catalog row, its Studio-native Editor Document at
   * revision zero, and the empty projection in one transaction. It never
   * writes a `workspace_source_heads` row or a starter `.py` blob: the native
   * document key is minted by a server-side CSPRNG, not derived from a source
   * shape, and the deterministic source-derived key path above stays exclusive
   * to the imported compatibility lane.
   */
  async createNativeDocument(
    inputValue: Parameters<EditorDocumentRepositoryV1["createNativeDocument"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseEditorDocumentNativeCreateInputV1(inputValue);
    const documentKey = mintNativeEditorDocumentKeyV1(this.#randomBytes);
    const epoch = this.#randomUuid();
    try {
      return await this.#connection.transaction(async (client) => {
        await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [
          input.tenantId,
        ]);
        await client.query("SELECT tenant_id FROM public.workspace_tenants WHERE tenant_id = $1 FOR UPDATE", [
          input.tenantId,
        ]);
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.workspace_projects WHERE tenant_id = $1 AND deleted_at IS NULL",
          [input.tenantId],
        );
        if (BigInt(count.rows[0]?.count ?? "0") >= BigInt(MAX_MANAGED_PROJECTS_PER_TENANT_V1)) {
          throw new HttpError("Studio supports at most 64 registered workspaces.", 409);
        }
        const project = await client.query<{ display_name: string; project_id: string; tenant_id: string }>(
          `INSERT INTO public.workspace_projects (tenant_id, project_id, display_name)
           VALUES ($1, $2, $3)
           RETURNING tenant_id, project_id, display_name`,
          [input.tenantId, input.projectId, input.name],
        );
        const projectRow = project.rows[0];
        if (project.rowCount !== 1 || !projectRow) {
          throw new TypeError("PostgreSQL did not create the native Studio project.");
        }
        const inserted = await client.query<DocumentRow>(
          `INSERT INTO public.editor_documents AS document
             (tenant_id, project_id, document_key, epoch, origin, source_path, source_hash, revision)
           VALUES ($1, $2, $3, $4::uuid, 'studio-native', NULL, NULL, 0)
           RETURNING ${DOCUMENT_COLUMNS_V1}`,
          [input.tenantId, input.projectId, digestBytesV1(documentKey), epoch],
        );
        const row = inserted.rows[0];
        if (inserted.rowCount !== 1 || !row) {
          throw new TypeError("PostgreSQL did not create the native editor document.");
        }
        const document = documentFromRowV1(row);
        if (document.origin !== "studio-native" || document.revision !== 0n || document.sealedAt !== null) {
          throw new TypeError("PostgreSQL created an invalid native editor document.");
        }
        const projection = await client.query(
          `INSERT INTO public.editor_document_projections
             (tenant_id, project_id, document_key, epoch, revision, canonical_programs)
           VALUES ($1, $2, $3, $4::uuid, 0, '[]'::jsonb)`,
          [input.tenantId, input.projectId, digestBytesV1(documentKey), epoch],
        );
        if (projection.rowCount !== 1) {
          throw new TypeError("PostgreSQL did not initialize the native editor projection.");
        }
        return {
          document,
          kind: "created",
          project: Object.freeze({
            name: projectRow.display_name,
            projectId: projectRow.project_id,
            tenantId: projectRow.tenant_id,
          }),
          projection: Object.freeze({ programs: Object.freeze([]), revision: 0n }),
        } as const;
      }, signal);
    } catch (error) {
      if (isPostgresErrorV1(error, "23505")) throw new HttpError("That workspace already exists.", 409);
      throw error;
    }
  }

  async commitMutation(inputValue: Parameters<EditorDocumentRepositoryV1["commitMutation"]>[0], signal?: AbortSignal) {
    const input = parseEditorDocumentCommitInputV1(inputValue);
    const canonical = canonicalEditorProgramV1(input.mutation.program);
    return this.#connection.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `editor-mutation:${input.tenantId}:${input.projectId}:${input.subjectId}:${input.clientMutationId}`,
      ]);
      if (input.sessionUpdate) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `editor-session-subject:${input.tenantId}:${input.subjectId}`,
        ]);
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `editor-document:${input.tenantId}:${input.projectId}:${input.documentKey}`,
      ]);

      if (!(await actorCanEditV1(client, input.tenantId, input.subjectId))) {
        return { kind: "conflict", reason: "forbidden" } as const;
      }

      const existing = await client.query<EventRow>(
        `SELECT ${EVENT_COLUMNS_V1}
           FROM public.editor_edit_events event
          WHERE event.tenant_id = $1 AND event.project_id = $2
            AND event.subject_id = $3::uuid AND event.client_mutation_id = $4::uuid`,
        [input.tenantId, input.projectId, input.subjectId, input.clientMutationId],
      );
      if (existing.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate editor mutations.");
      const existingRow = existing.rows[0];
      if (existingRow) {
        const event = eventFromRowV1(existingRow);
        if (!sameEventCandidateV1(existingRow, input, canonical)) {
          return { kind: "conflict", reason: "mutation-reused" } as const;
        }
        const replayDocument = await client.query<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS_V1}
             FROM public.editor_documents document
            WHERE document.tenant_id = $1 AND document.project_id = $2
              AND document.document_key = $3 AND document.epoch = $4::uuid`,
          [input.tenantId, input.projectId, digestBytesV1(input.documentKey), input.epoch],
        );
        const replayRow = replayDocument.rows[0];
        if (replayDocument.rowCount !== 1 || !replayRow) {
          throw new TypeError("PostgreSQL returned an editor event without its document.");
        }
        const sessionUpdate = eventSessionUpdateEvidenceV1(existingRow);
        return {
          document: documentFromRowV1(replayRow),
          event,
          kind: "committed",
          replayed: true,
          ...(sessionUpdate ? { sessionUpdate } : {}),
        } as const;
      }

      const candidate = await client.query<{ source_path: string | null }>(
        `SELECT document.source_path
           FROM public.editor_documents document
          WHERE document.tenant_id = $1 AND document.project_id = $2
            AND document.document_key = $3 AND document.epoch = $4::uuid`,
        [input.tenantId, input.projectId, digestBytesV1(input.documentKey), input.epoch],
      );
      if (candidate.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate editor document epochs.");
      const candidateRow = candidate.rows[0];
      if (!candidateRow) return { kind: "conflict", reason: "not-found" } as const;

      const project = await client.query(
        `SELECT project.project_id
           FROM public.workspace_projects project
          WHERE project.tenant_id = $1 AND project.project_id = $2 AND project.deleted_at IS NULL
          FOR SHARE OF project`,
        [input.tenantId, input.projectId],
      );
      if (project.rowCount !== 1) return { kind: "conflict", reason: "not-found" } as const;
      const source = await client.query<{ current_source_hash: Buffer }>(
        `SELECT decode(source.digest, 'hex') AS current_source_hash
           FROM public.workspace_source_heads source
          WHERE source.tenant_id = $1 AND source.project_id = $2 AND source.source_path = $3
          FOR SHARE OF source`,
        [input.tenantId, input.projectId, candidateRow.source_path],
      );
      if (source.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate workspace source heads.");

      const selected = await client.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS_V1}
           FROM public.editor_documents document
          WHERE document.tenant_id = $1 AND document.project_id = $2
            AND document.document_key = $3 AND document.epoch = $4::uuid
          FOR UPDATE OF document`,
        [input.tenantId, input.projectId, digestBytesV1(input.documentKey), input.epoch],
      );
      if (selected.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate editor document epochs.");
      const row = selected.rows[0];
      if (!row) return { kind: "conflict", reason: "not-found" } as const;
      const document = documentFromRowV1(row);
      if (document.sealedAt !== null) {
        return { currentRevision: document.revision, kind: "conflict", reason: "document-sealed" } as const;
      }
      const currentSourceHash = source.rows[0]?.current_source_hash
        ? digestFromPostgresV1(source.rows[0].current_source_hash, "workspace source hash")
        : null;
      if (currentSourceHash !== document.sourceHash) {
        await client.query(
          `UPDATE public.editor_documents
              SET sealed_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND project_id = $2 AND document_key = $3 AND epoch = $4::uuid
              AND sealed_at IS NULL`,
          [input.tenantId, input.projectId, digestBytesV1(input.documentKey), input.epoch],
        );
        return { currentRevision: document.revision, kind: "conflict", reason: "source-changed" } as const;
      }
      if (document.revision !== input.baseRevision) {
        return { currentRevision: document.revision, kind: "conflict", reason: "revision-mismatch" } as const;
      }

      const currentProjection = await alignedEditorProjectionV1(client, document);
      const applied = applyEditorEditMutationV1(currentProjection.programs, input.mutation);
      if (applied.kind !== "applied") {
        return { currentRevision: document.revision, kind: "conflict", reason: "invalid-mutation" } as const;
      }

      const nextRevision = input.baseRevision + 1n;
      if (nextRevision > MAX_POSTGRES_REVISION_V1) throw new RangeError("The editor document revision is exhausted.");
      if (input.sessionUpdate) {
        if (!snapshotMatchesProjectionV1(input.sessionUpdate.snapshot, applied.programs)) {
          return {
            currentRevision: document.revision,
            kind: "conflict",
            reason: "projection-mismatch",
          } as const;
        }
        const storedSession = await storeSessionSnapshotV1(client, {
          ...input.sessionUpdate,
          documentKey: input.documentKey,
          epoch: input.epoch,
          projectId: input.projectId,
          subjectId: input.subjectId,
          tenantId: input.tenantId,
        });
        if (storedSession.kind === "conflict") {
          return {
            currentRevision: document.revision,
            currentSessionGeneration: storedSession.currentSessionGeneration,
            kind: "conflict",
            reason: storedSession.reason,
          } as const;
        }
      }
      const sessionCanonical = input.sessionUpdate
        ? canonicalEditorSessionSnapshotV1(input.sessionUpdate.snapshot)
        : undefined;
      const inserted = await client.query<EventRow>(
        `INSERT INTO public.editor_edit_events AS event
           (tenant_id, project_id, document_key, epoch, base_revision, revision, subject_id,
            client_mutation_id, mutation_kind, target_transaction_id,
            canonical_program, canonical_digest, canonical_byte_size,
            session_base_generation, session_generation, session_snapshot_version,
            session_snapshot_digest, session_snapshot_byte_size)
         VALUES ($1, $2, $3, $4::uuid, $5::bigint, $6::bigint, $7::uuid, $8::uuid,
                 $9, $10, $11::jsonb, $12, $13, $14::bigint, $15::bigint, $16, $17, $18)
         RETURNING ${EVENT_COLUMNS_V1}`,
        [
          input.tenantId,
          input.projectId,
          digestBytesV1(input.documentKey),
          input.epoch,
          input.baseRevision.toString(),
          nextRevision.toString(),
          input.subjectId,
          input.clientMutationId,
          input.mutation.kind,
          input.mutation.kind === "append" ? null : input.mutation.targetTransactionId,
          canonical.json,
          digestBytesV1(canonical.digest),
          canonical.byteSize,
          input.sessionUpdate?.expectedSessionGeneration.toString() ?? null,
          input.sessionUpdate ? (input.sessionUpdate.expectedSessionGeneration + 1n).toString() : null,
          input.sessionUpdate?.snapshotVersion ?? null,
          sessionCanonical ? digestBytesV1(sessionCanonical.digest) : null,
          sessionCanonical?.byteSize ?? null,
        ],
      );
      const eventRow = inserted.rows[0];
      if (inserted.rowCount !== 1 || !eventRow) throw new TypeError("PostgreSQL did not append the editor event.");
      const advanced = await client.query<DocumentRow>(
        `UPDATE public.editor_documents document
            SET revision = $5::bigint, updated_at = clock_timestamp()
          WHERE document.tenant_id = $1 AND document.project_id = $2
            AND document.document_key = $3 AND document.epoch = $4::uuid
            AND document.revision = $6::bigint AND document.sealed_at IS NULL
          RETURNING ${DOCUMENT_COLUMNS_V1}`,
        [
          input.tenantId,
          input.projectId,
          digestBytesV1(input.documentKey),
          input.epoch,
          nextRevision.toString(),
          input.baseRevision.toString(),
        ],
      );
      const advancedRow = advanced.rows[0];
      if (advanced.rowCount !== 1 || !advancedRow)
        throw new TypeError("PostgreSQL did not advance the editor revision.");
      const projected = await client.query(
        `UPDATE public.editor_document_projections projection
            SET revision = $5::bigint, canonical_programs = $6::jsonb, updated_at = clock_timestamp()
          WHERE projection.tenant_id = $1 AND projection.project_id = $2
            AND projection.document_key = $3 AND projection.epoch = $4::uuid
            AND projection.revision = $7::bigint`,
        [
          input.tenantId,
          input.projectId,
          digestBytesV1(input.documentKey),
          input.epoch,
          nextRevision.toString(),
          projectionProgramsJsonV1(applied.programs),
          currentProjection.revision.toString(),
        ],
      );
      if (projected.rowCount !== 1) throw new TypeError("PostgreSQL did not advance the editor projection.");
      const sessionUpdate = eventSessionUpdateEvidenceV1(eventRow);
      return {
        document: documentFromRowV1(advancedRow),
        event: eventFromRowV1(eventRow),
        kind: "committed",
        replayed: false,
        ...(sessionUpdate ? { sessionUpdate } : {}),
      } as const;
    }, signal);
  }

  async readSessionSnapshot(
    inputValue: Parameters<EditorDocumentRepositoryV1["readSessionSnapshot"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseEditorSessionSnapshotReadInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      if (!(await actorCanEditV1(client, input.tenantId, input.subjectId))) {
        return { currentSessionGeneration: 0n, kind: "unavailable" } as const;
      }
      const selected = await client.query<SessionSnapshotReadRow>(
        `SELECT ${SESSION_SNAPSHOT_COLUMNS_V1},
                document.revision::text AS current_document_revision,
                projection.revision::text AS projection_revision,
                projection.canonical_programs AS projection_programs
           FROM public.editor_session_snapshots snapshot
           JOIN public.editor_documents document
             ON document.tenant_id = snapshot.tenant_id AND document.project_id = snapshot.project_id
            AND document.document_key = snapshot.document_key AND document.epoch = snapshot.epoch
           JOIN public.workspace_projects project
             ON project.tenant_id = snapshot.tenant_id AND project.project_id = snapshot.project_id
           JOIN public.editor_document_projections projection
             ON projection.tenant_id = document.tenant_id AND projection.project_id = document.project_id
            AND projection.document_key = document.document_key AND projection.epoch = document.epoch
           JOIN public.workspace_source_heads source
             ON source.tenant_id = document.tenant_id AND source.project_id = document.project_id
            AND source.source_path = document.source_path
          WHERE snapshot.tenant_id = $1 AND snapshot.project_id = $2
            AND snapshot.document_key = $3 AND snapshot.subject_id = $4::uuid
            AND snapshot.epoch = $5::uuid AND document.sealed_at IS NULL
            AND project.deleted_at IS NULL AND decode(source.digest, 'hex') = document.source_hash`,
        [input.tenantId, input.projectId, digestBytesV1(input.documentKey), input.subjectId, input.epoch],
      );
      if (selected.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate current editor sessions.");
      const row = selected.rows[0];
      if (!row) return { currentSessionGeneration: 0n, kind: "unavailable" } as const;
      const currentSessionGeneration = revisionFromPostgresV1(row.session_generation, "editor session generation");
      const currentDocumentRevision = revisionFromPostgresV1(
        row.current_document_revision,
        "current editor document revision",
      );
      const snapshotDocumentRevision = revisionFromPostgresV1(
        row.document_revision,
        "editor session document revision",
      );
      const projectionRevision = revisionFromPostgresV1(row.projection_revision, "editor projection revision");
      if (snapshotDocumentRevision !== currentDocumentRevision || projectionRevision !== currentDocumentRevision) {
        return { currentSessionGeneration, kind: "unavailable" } as const;
      }
      const session = sessionSnapshotFromRowV1(row);
      const projectionPrograms = authoritativeProjectionProgramsV1(row.projection_programs);
      if (
        projectionRevision !== session.documentRevision ||
        !snapshotMatchesProjectionV1(session.snapshot, projectionPrograms)
      ) {
        throw new TypeError("PostgreSQL returned an editor session outside its authoritative projection.");
      }
      return { kind: "available", session } as const;
    }, signal);
  }

  async putSessionSnapshot(
    inputValue: Parameters<EditorDocumentRepositoryV1["putSessionSnapshot"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseEditorSessionSnapshotPutInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `editor-session-subject:${input.tenantId}:${input.subjectId}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `editor-document:${input.tenantId}:${input.projectId}:${input.documentKey}`,
      ]);
      if (!(await actorCanEditV1(client, input.tenantId, input.subjectId))) {
        return { kind: "conflict", reason: "forbidden" } as const;
      }

      const selected = await client.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS_V1}
           FROM public.editor_documents document
           JOIN public.workspace_projects project
             ON project.tenant_id = document.tenant_id AND project.project_id = document.project_id
          WHERE document.tenant_id = $1 AND document.project_id = $2
            AND document.document_key = $3 AND document.epoch = $4::uuid
            AND project.deleted_at IS NULL
          FOR UPDATE OF document, project`,
        [input.tenantId, input.projectId, digestBytesV1(input.documentKey), input.epoch],
      );
      if (selected.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate editor document epochs.");
      const row = selected.rows[0];
      if (!row) {
        const currentEpoch = await client.query<{ epoch: string }>(
          `SELECT document.epoch::text AS epoch
             FROM public.editor_documents document
             JOIN public.workspace_projects project
               ON project.tenant_id = document.tenant_id AND project.project_id = document.project_id
            WHERE document.tenant_id = $1 AND document.project_id = $2
              AND document.document_key = $3 AND document.sealed_at IS NULL
              AND project.deleted_at IS NULL
            FOR SHARE OF document, project`,
          [input.tenantId, input.projectId, digestBytesV1(input.documentKey)],
        );
        if (currentEpoch.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate open editor epochs.");
        return {
          kind: "conflict",
          reason: currentEpoch.rowCount === 1 ? "epoch-mismatch" : "not-found",
        } as const;
      }

      const document = documentFromRowV1(row);
      if (document.sealedAt !== null) {
        return {
          currentDocumentRevision: document.revision,
          kind: "conflict",
          reason: "document-sealed",
        } as const;
      }
      const source = await client.query<{ current_source_hash: Buffer }>(
        `SELECT decode(source.digest, 'hex') AS current_source_hash
           FROM public.workspace_source_heads source
          WHERE source.tenant_id = $1 AND source.project_id = $2 AND source.source_path = $3
          FOR SHARE OF source`,
        [input.tenantId, input.projectId, document.sourcePath],
      );
      if (source.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate workspace source heads.");
      const currentSourceHash = source.rows[0]?.current_source_hash
        ? digestFromPostgresV1(source.rows[0].current_source_hash, "workspace source hash")
        : null;
      if (currentSourceHash !== document.sourceHash) {
        return {
          currentDocumentRevision: document.revision,
          kind: "conflict",
          reason: "source-changed",
        } as const;
      }
      if (document.revision !== input.documentRevision) {
        return {
          currentDocumentRevision: document.revision,
          kind: "conflict",
          reason: "revision-mismatch",
        } as const;
      }

      const projection = await alignedEditorProjectionV1(client, document);
      if (!snapshotMatchesProjectionV1(input.snapshot, projection.programs)) {
        return {
          currentDocumentRevision: document.revision,
          kind: "conflict",
          reason: "projection-mismatch",
        } as const;
      }
      return storeSessionSnapshotV1(client, input);
    }, signal);
  }

  async readEventTail(inputValue: Parameters<EditorDocumentRepositoryV1["readEventTail"]>[0], signal?: AbortSignal) {
    const input = parseEditorDocumentTailInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      const selected = await client.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS_V1}
           FROM public.editor_documents document
           JOIN public.workspace_projects project
             ON project.tenant_id = document.tenant_id AND project.project_id = document.project_id
          WHERE document.tenant_id = $1 AND document.project_id = $2
            AND document.document_key = $3 AND document.epoch = $4::uuid
            AND project.deleted_at IS NULL
          FOR SHARE OF document, project`,
        [input.tenantId, input.projectId, digestBytesV1(input.documentKey), input.epoch],
      );
      if (selected.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate editor document epochs.");
      const row = selected.rows[0];
      if (!row) return null;
      const document = documentFromRowV1(row);
      const events = await client.query<EventRow>(
        `SELECT ${EVENT_COLUMNS_V1}
           FROM public.editor_edit_events event
          WHERE event.tenant_id = $1 AND event.project_id = $2
            AND event.document_key = $3 AND event.epoch = $4::uuid
            AND event.revision > $5::bigint AND event.revision <= $6::bigint
          ORDER BY event.revision
          LIMIT $7`,
        [
          input.tenantId,
          input.projectId,
          digestBytesV1(input.documentKey),
          input.epoch,
          input.afterRevision.toString(),
          document.revision.toString(),
          input.limit,
        ],
      );
      return Object.freeze({ document, events: Object.freeze(events.rows.map(eventFromRowV1)) });
    }, signal);
  }

  close() {
    return this.#connection.close();
  }
}
