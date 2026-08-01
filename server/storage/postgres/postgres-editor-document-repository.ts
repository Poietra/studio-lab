import { randomUUID } from "node:crypto";

import type { Pool, PoolConfig, QueryResultRow } from "pg";

import {
  applyEditorEditMutationV1,
  MAX_APPLIED_EDITOR_PROGRAMS_V1,
  parseAuthoritativeEditorProgramsV1,
} from "../../../src/collaboration/editor-edit-mutation";
import {
  canonicalEditorProgramV1,
  createEditorDocumentKeyV1,
  type EditorDocumentRepositoryV1,
  type EditorDocumentV1,
  type EditorEditEventV1,
  parseEditorDocumentCommitInputV1,
  parseEditorDocumentOpenInputV1,
  parseEditorDocumentTailInputV1,
} from "../editor-document-repository";
import { EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM } from "./editor-document-schema";
import { EDITOR_MUTATION_MIGRATION_V18_CHECKSUM } from "./editor-mutation-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

const MAX_POSTGRES_REVISION_V1 = 9_223_372_036_854_775_807n;

type DocumentRow = QueryResultRow & {
  document_key: Buffer;
  epoch: string;
  opened_at: Date;
  project_id: string;
  revision: string;
  sealed_at: Date | null;
  source_hash: Buffer;
  source_path: string;
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
  subject_id: string;
  target_transaction_id: string | null;
  tenant_id: string;
};

type ProjectionRow = QueryResultRow & {
  canonical_programs: unknown;
  revision: string;
};

const DOCUMENT_COLUMNS_V1 = `document.tenant_id,
       document.project_id,
       document.document_key,
       document.epoch::text AS epoch,
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
       event.committed_at`;

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
  return Object.freeze({
    documentKey: digestFromPostgresV1(row.document_key, "editor document key"),
    epoch: row.epoch,
    openedAt: row.opened_at,
    projectId: row.project_id,
    revision: revisionFromPostgresV1(row.revision, "editor document revision"),
    sealedAt: row.sealed_at,
    sourceHash: digestFromPostgresV1(row.source_hash, "editor document source hash"),
    sourcePath: row.source_path,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
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

function sameEventCandidateV1(
  event: EditorEditEventV1,
  input: ReturnType<typeof parseEditorDocumentCommitInputV1>,
  canonical: ReturnType<typeof canonicalEditorProgramV1>,
) {
  const eventTarget = event.mutation.kind === "append" ? null : event.mutation.targetTransactionId;
  const inputTarget = input.mutation.kind === "append" ? null : input.mutation.targetTransactionId;
  return (
    event.documentKey === input.documentKey &&
    event.epoch === input.epoch &&
    event.baseRevision === input.baseRevision &&
    event.mutation.kind === input.mutation.kind &&
    eventTarget === inputTarget &&
    event.digest === canonical.digest &&
    event.byteSize === canonical.byteSize
  );
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

function projectionProgramsJsonV1(programs: readonly EditorEditEventV1["mutation"]["program"][]) {
  return JSON.stringify(parseAuthoritativeEditorProgramsV1(programs));
}

export type PostgresEditorDocumentRepositoryOptionsV1 = Readonly<{
  pool?: Pool;
  poolConfig?: PoolConfig;
  randomUuid?: () => string;
  statementTimeoutMs?: number;
}>;

/** PostgreSQL authority for committed collaborative editor Programs. */
export class PostgresEditorDocumentRepositoryV1 implements EditorDocumentRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;
  readonly #randomUuid: () => string;

  constructor(options: PostgresEditorDocumentRepositoryOptionsV1) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
    this.#randomUuid = options.randomUuid ?? randomUUID;
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (17, 18) ORDER BY version",
        [],
        signal,
      );
      signal?.throwIfAborted();
      return (
        result.rowCount === 2 &&
        result.rows[0]?.version === 17 &&
        result.rows[0]?.checksum === EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM &&
        result.rows[1]?.version === 18 &&
        result.rows[1]?.checksum === EDITOR_MUTATION_MIGRATION_V18_CHECKSUM
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
      if (current.rows[0])
        return { created: false, document: documentFromRowV1(current.rows[0]), kind: "opened" } as const;

      const epoch = this.#randomUuid();
      const inserted = await client.query<DocumentRow>(
        `INSERT INTO public.editor_documents AS document
           (tenant_id, project_id, document_key, epoch, source_path, source_hash, revision)
         VALUES ($1, $2, $3, $4::uuid, $5, $6, 0)
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
      const projection = await client.query(
        `INSERT INTO public.editor_document_projections
           (tenant_id, project_id, document_key, epoch, revision, canonical_programs)
         VALUES ($1, $2, $3, $4::uuid, 0, '[]'::jsonb)`,
        [input.tenantId, input.projectId, digestBytesV1(documentKey), epoch],
      );
      if (projection.rowCount !== 1) throw new TypeError("PostgreSQL did not initialize the editor projection.");
      return { created: true, document: documentFromRowV1(row), kind: "opened" } as const;
    }, signal);
  }

  async commitMutation(inputValue: Parameters<EditorDocumentRepositoryV1["commitMutation"]>[0], signal?: AbortSignal) {
    const input = parseEditorDocumentCommitInputV1(inputValue);
    const canonical = canonicalEditorProgramV1(input.mutation.program);
    return this.#connection.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `editor-mutation:${input.tenantId}:${input.projectId}:${input.subjectId}:${input.clientMutationId}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `editor-document:${input.tenantId}:${input.projectId}:${input.documentKey}`,
      ]);

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
        [input.tenantId, input.subjectId],
      );
      if (actor.rowCount !== 1 || actor.rows[0]?.actor_can_edit !== true) {
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
        if (!sameEventCandidateV1(event, input, canonical)) {
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
        return { document: documentFromRowV1(replayRow), event, kind: "committed", replayed: true } as const;
      }

      const candidate = await client.query<{ source_path: string }>(
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

      const projectionResult = await client.query<ProjectionRow>(
        `SELECT projection.revision::text AS revision, projection.canonical_programs
           FROM public.editor_document_projections projection
          WHERE projection.tenant_id = $1 AND projection.project_id = $2
            AND projection.document_key = $3 AND projection.epoch = $4::uuid
          FOR UPDATE OF projection`,
        [input.tenantId, input.projectId, digestBytesV1(input.documentKey), input.epoch],
      );
      if (projectionResult.rows.length > 1) {
        throw new TypeError("PostgreSQL returned duplicate editor document projections.");
      }
      const projectionRow = projectionResult.rows[0];
      let projectionRevision = projectionRow
        ? revisionFromPostgresV1(projectionRow.revision, "editor projection revision")
        : 0n;
      if (projectionRevision > document.revision) {
        throw new TypeError("PostgreSQL returned an editor projection ahead of its document revision.");
      }
      let currentPrograms = projectionRow
        ? parseAuthoritativeEditorProgramsV1(projectionRow.canonical_programs)
        : parseAuthoritativeEditorProgramsV1([]);
      if (projectionRevision < document.revision) {
        const history = await client.query<EventRow>(
          `SELECT ${EVENT_COLUMNS_V1}
             FROM public.editor_edit_events event
            WHERE event.tenant_id = $1 AND event.project_id = $2
              AND event.document_key = $3 AND event.epoch = $4::uuid
              AND event.revision > $5::bigint AND event.revision <= $6::bigint
            ORDER BY event.revision
            LIMIT ${MAX_APPLIED_EDITOR_PROGRAMS_V1 + 1}`,
          [
            input.tenantId,
            input.projectId,
            digestBytesV1(input.documentKey),
            input.epoch,
            projectionRevision.toString(),
            document.revision.toString(),
          ],
        );
        if (history.rows.length > MAX_APPLIED_EDITOR_PROGRAMS_V1) {
          throw new TypeError("PostgreSQL editor projection recovery exceeds its bounded cutover window.");
        }
        currentPrograms = foldAuthoritativeEventsV1(
          currentPrograms,
          projectionRevision,
          history.rows.map(eventFromRowV1),
          document.revision,
        );
      }
      if (!projectionRow) {
        const insertedProjection = await client.query(
          `INSERT INTO public.editor_document_projections
             (tenant_id, project_id, document_key, epoch, revision, canonical_programs)
           VALUES ($1, $2, $3, $4::uuid, $5::bigint, $6::jsonb)`,
          [
            input.tenantId,
            input.projectId,
            digestBytesV1(input.documentKey),
            input.epoch,
            document.revision.toString(),
            projectionProgramsJsonV1(currentPrograms),
          ],
        );
        if (insertedProjection.rowCount !== 1) {
          throw new TypeError("PostgreSQL did not initialize the derived editor projection.");
        }
      } else if (projectionRevision < document.revision) {
        const caughtUp = await client.query(
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
            document.revision.toString(),
            projectionProgramsJsonV1(currentPrograms),
            projectionRevision.toString(),
          ],
        );
        if (caughtUp.rowCount !== 1) throw new TypeError("PostgreSQL did not catch up the editor projection.");
      }
      projectionRevision = document.revision;
      const applied = applyEditorEditMutationV1(currentPrograms, input.mutation);
      if (applied.kind !== "applied") {
        return { currentRevision: document.revision, kind: "conflict", reason: "invalid-mutation" } as const;
      }

      const nextRevision = input.baseRevision + 1n;
      if (nextRevision > MAX_POSTGRES_REVISION_V1) throw new RangeError("The editor document revision is exhausted.");
      const inserted = await client.query<EventRow>(
        `INSERT INTO public.editor_edit_events AS event
           (tenant_id, project_id, document_key, epoch, base_revision, revision, subject_id,
            client_mutation_id, mutation_kind, target_transaction_id,
            canonical_program, canonical_digest, canonical_byte_size)
         VALUES ($1, $2, $3, $4::uuid, $5::bigint, $6::bigint, $7::uuid, $8::uuid,
                 $9, $10, $11::jsonb, $12, $13)
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
          projectionRevision.toString(),
        ],
      );
      if (projected.rowCount !== 1) throw new TypeError("PostgreSQL did not advance the editor projection.");
      return {
        document: documentFromRowV1(advancedRow),
        event: eventFromRowV1(eventRow),
        kind: "committed",
        replayed: false,
      } as const;
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
