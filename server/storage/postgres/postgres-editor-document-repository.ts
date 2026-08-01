import { randomUUID } from "node:crypto";

import type { Pool, PoolConfig, QueryResultRow } from "pg";

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
  project_id: string;
  revision: string;
  subject_id: string;
  tenant_id: string;
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
  return Object.freeze({
    baseRevision: revisionFromPostgresV1(row.base_revision, "editor event base revision"),
    byteSize: canonical.byteSize,
    clientMutationId: row.client_mutation_id,
    committedAt: row.committed_at,
    digest,
    documentKey: digestFromPostgresV1(row.document_key, "editor event document key"),
    epoch: row.epoch,
    program: canonical.program,
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
  return (
    event.documentKey === input.documentKey &&
    event.epoch === input.epoch &&
    event.baseRevision === input.baseRevision &&
    event.digest === canonical.digest &&
    event.byteSize === canonical.byteSize
  );
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
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version = 17",
        [],
        signal,
      );
      signal?.throwIfAborted();
      return (
        result.rowCount === 1 &&
        result.rows[0]?.version === 17 &&
        result.rows[0]?.checksum === EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM
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
      return { created: true, document: documentFromRowV1(row), kind: "opened" } as const;
    }, signal);
  }

  async commitProgram(inputValue: Parameters<EditorDocumentRepositoryV1["commitProgram"]>[0], signal?: AbortSignal) {
    const input = parseEditorDocumentCommitInputV1(inputValue);
    const canonical = canonicalEditorProgramV1(input.program);
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

      const nextRevision = input.baseRevision + 1n;
      if (nextRevision > MAX_POSTGRES_REVISION_V1) throw new RangeError("The editor document revision is exhausted.");
      const inserted = await client.query<EventRow>(
        `INSERT INTO public.editor_edit_events AS event
           (tenant_id, project_id, document_key, epoch, base_revision, revision, subject_id,
            client_mutation_id, canonical_program, canonical_digest, canonical_byte_size)
         VALUES ($1, $2, $3, $4::uuid, $5::bigint, $6::bigint, $7::uuid, $8::uuid,
                 $9::jsonb, $10, $11)
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
          WHERE document.tenant_id = $1 AND document.project_id = $2
            AND document.document_key = $3 AND document.epoch = $4::uuid
          FOR SHARE OF document`,
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
