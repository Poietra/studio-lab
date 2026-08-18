import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import { manimProjectIdSchema } from "../../../src/render-pipeline/contracts";
import { HttpError } from "../../http/json";
import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  type AcceptClientExportPublicationInputV1,
  type AcceptClientExportPublicationResultV1,
  CLIENT_EXPORT_ENCODER_EVIDENCE_VERSION_V1,
  CLIENT_EXPORT_MEDIA_TYPE_V1,
  CLIENT_EXPORT_PRODUCER_KIND_V1,
  CLIENT_EXPORT_SCENE_CONTRACT_VERSION_V1,
  type ClientExportArtifactReceiptV1,
  type ClientExportDeletionV1,
  type ClientExportPublicationV1,
  type ClientExportReadClaimV1,
  type ClientExportRepositoryV1,
  clientExportIdV1,
  parseClientExportArtifactReceiptV1,
  parseClientExportLineageV1,
  sameClientExportArtifactReceiptV1,
  samePublicationAcceptancePayloadV1,
} from "../client-export-contract";
import type { ClientExportPublicationMeteringV1 } from "../client-export-metering";
import { ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM } from "./account-organization-schema";
import { CLIENT_EXPORT_PUBLICATION_MIGRATION_V31_CHECKSUM } from "./client-export-publication-schema";
import { EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_CHECKSUM } from "./editor-document-origin-schema";
import { EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM } from "./editor-document-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";
import { WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM } from "./postgres-workspace-source-repository";

const MAX_CLAIM_DURATION_MS = 30 * 60_000;
const MAX_EXPIRATION_MS = 30 * 24 * 60 * 60_000;
const MAX_GC_GRACE_MS = 30 * 24 * 60 * 60_000;
const MAX_PAGE = 256;

const READY_MIGRATIONS = [
  [1, WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM],
  [11, ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM],
  [17, EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM],
  [30, EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_CHECKSUM],
  [31, CLIENT_EXPORT_PUBLICATION_MIGRATION_V31_CHECKSUM],
] as const;

type ArtifactRow = QueryResultRow & {
  artifact_byte_size: number;
  artifact_content_digest: string;
  artifact_etag: string;
  artifact_id: string;
  artifact_object_generation: string;
  artifact_object_key: string;
};

type PublicationRow = ArtifactRow & {
  created_by_subject_id: string;
  document_epoch: string;
  document_key: Buffer;
  document_revision: string;
  encoder_evidence_text: string;
  expires_at: Date;
  export_profile_hash: string;
  project_id: string;
  publication_id: string;
  published_at: Date;
  scene_revision_hash: string;
  tenant_id: string;
};

type DeletionRow = QueryResultRow & {
  artifact_byte_size: number;
  artifact_content_digest: string;
  artifact_etag: string;
  artifact_object_generation: string;
  artifact_object_key: string;
  deletion_id: string;
};

const ARTIFACT_COLUMNS = `
    artifact.artifact_id::text AS artifact_id,
    artifact.content_digest AS artifact_content_digest,
    artifact.byte_size AS artifact_byte_size,
    artifact.object_key AS artifact_object_key,
    artifact.object_generation::text AS artifact_object_generation,
    artifact.etag AS artifact_etag
`;

const PUBLICATION_COLUMNS = `
    publication.tenant_id,
    publication.publication_id::text AS publication_id,
    publication.project_id,
    publication.document_key,
    publication.document_epoch::text AS document_epoch,
    publication.document_revision::text AS document_revision,
    publication.scene_revision_hash,
    publication.export_profile_hash,
    publication.encoder_evidence::text AS encoder_evidence_text,
    publication.created_by_subject_id::text AS created_by_subject_id,
    publication.published_at,
    publication.expires_at,
    ${ARTIFACT_COLUMNS}
`;

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

function date(value: unknown, label: string) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${label} is invalid.`);
  return value;
}

function boundedIntegerV1(value: number, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function missingPublication(): never {
  throw new HttpError("Client export publication not found.", 404);
}

type ReceiptColumnsRow = Pick<
  ArtifactRow,
  | "artifact_byte_size"
  | "artifact_content_digest"
  | "artifact_etag"
  | "artifact_object_generation"
  | "artifact_object_key"
>;

function receiptFromRow(tenant: string, row: ReceiptColumnsRow): ClientExportArtifactReceiptV1 {
  return parseClientExportArtifactReceiptV1(tenant, {
    byteSize: row.artifact_byte_size,
    contentDigest: row.artifact_content_digest,
    etag: row.artifact_etag,
    mediaType: CLIENT_EXPORT_MEDIA_TYPE_V1,
    objectKey: row.artifact_object_key,
    objectLocatorToken: row.artifact_object_generation,
  });
}

function publicationFromRow(tenant: string, row: PublicationRow): ClientExportPublicationV1 {
  const encoderEvidence: unknown = JSON.parse(row.encoder_evidence_text);
  return {
    artifact: {
      artifactId: clientExportIdV1(row.artifact_id, "Client export artifact ID"),
      receipt: receiptFromRow(tenant, row),
    },
    createdBySubjectId: clientExportIdV1(row.created_by_subject_id, "Client export subject ID"),
    expiresAt: date(row.expires_at, "Client export publication expiry"),
    lineage: parseClientExportLineageV1({
      documentEpoch: row.document_epoch,
      documentKey: row.document_key.toString("hex"),
      documentRevision: BigInt(row.document_revision),
      encoderEvidence,
      encoderEvidenceVersion: CLIENT_EXPORT_ENCODER_EVIDENCE_VERSION_V1,
      exportProfileHash: row.export_profile_hash,
      producerKind: CLIENT_EXPORT_PRODUCER_KIND_V1,
      sceneContractVersion: CLIENT_EXPORT_SCENE_CONTRACT_VERSION_V1,
      sceneRevisionHash: row.scene_revision_hash,
    }),
    projectId: projectId(row.project_id),
    publicationId: clientExportIdV1(row.publication_id, "Client export publication ID"),
    publishedAt: date(row.published_at, "Client export publication time"),
    tenantId: tenantId(row.tenant_id),
  };
}

function deletionFromRow(row: DeletionRow, tenant: string): ClientExportDeletionV1 {
  return {
    deletionId: clientExportIdV1(row.deletion_id, "Client export deletion ID"),
    receipt: receiptFromRow(tenant, row),
    tenantId: tenant,
  };
}

export type PostgresClientExportRepositoryOptionsV1 = Readonly<{
  metering: ClientExportPublicationMeteringV1;
  pool?: Pool;
  poolConfig?: PoolConfig;
  statementTimeoutMs?: number;
}>;

/** PostgreSQL authority for client-export acceptance, read claims, and deletion tombstones (ADR 0005). */
export class PostgresClientExportRepositoryV1 implements ClientExportRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;
  readonly #metering: ClientExportPublicationMeteringV1;

  constructor(options: PostgresClientExportRepositoryOptionsV1) {
    const { metering, ...connection } = options;
    if (
      !metering ||
      typeof metering.releasePublicationStockWithClient !== "function" ||
      typeof metering.settlePublicationWithClient !== "function"
    ) {
      throw new TypeError("Client export publication metering is required.");
    }
    this.#metering = metering;
    this.#connection = new PostgresRepositoryConnectionV1(connection);
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const versions = READY_MIGRATIONS.map(([version]) => version);
    const result = await this.#connection.query<{ checksum: string; version: number }>(
      `SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (${versions.join(", ")}) ORDER BY version`,
      [],
      signal,
    );
    return (
      result.rows.length === READY_MIGRATIONS.length &&
      READY_MIGRATIONS.every(
        ([version, checksum], index) =>
          result.rows[index]?.version === version && result.rows[index]?.checksum === checksum,
      )
    );
  }

  async #lockArtifact(client: PoolClient, tenant: string, receipt: ClientExportArtifactReceiptV1) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `client-export:${tenant}:${receipt.objectKey}:generation:${receipt.objectLocatorToken}`,
    ]);
  }

  async acceptPublication(
    input: AcceptClientExportPublicationInputV1,
    signal?: AbortSignal,
  ): Promise<AcceptClientExportPublicationResultV1> {
    const tenant = tenantId(input.tenantId);
    const project = projectId(input.projectId);
    const publicationId = clientExportIdV1(input.publicationId, "Client export publication ID");
    const artifactId = clientExportIdV1(input.artifactId, "Client export artifact ID");
    const createdBySubjectId = clientExportIdV1(input.createdBySubjectId, "Client export subject ID");
    const receipt = parseClientExportArtifactReceiptV1(tenant, input.receipt);
    const lineage = parseClientExportLineageV1(input.lineage);
    const expirationMs = boundedIntegerV1(input.expirationMs, "publication expirationMs", MAX_EXPIRATION_MS);

    return this.#connection.transaction(async (client) => {
      // No row exists to lock for a first use of publicationId. Serialize that
      // absence with a deterministic transaction-scoped advisory lock so two
      // identical concurrent creates become accept + replay, while differing
      // payloads become accept + conflict instead of a duplicate-key 500.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `client-export-publication:${tenant}:${publicationId}`,
      ]);

      // Replay detection runs before any quota settlement (ADR 0005): the same
      // publicationId with the same complete immutable payload returns the
      // stored success, and any differing field is a conflict.
      const existing = await client.query<PublicationRow>(
        `SELECT ${PUBLICATION_COLUMNS}
           FROM public.client_export_publications publication
           JOIN public.client_export_artifacts artifact
             ON artifact.tenant_id = publication.tenant_id AND artifact.artifact_id = publication.artifact_id
          WHERE publication.tenant_id = $1 AND publication.publication_id = $2::uuid
          FOR UPDATE OF publication, artifact`,
        [tenant, publicationId],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        const stored = publicationFromRow(tenant, existingRow);
        if (!samePublicationAcceptancePayloadV1(stored, { createdBySubjectId, lineage, projectId: project, receipt })) {
          return { kind: "conflict", reason: "payload-mismatch" } as const;
        }
        return { kind: "accepted", publication: stored, replayed: true } as const;
      }

      // Lock the exact Editor Document row and validate the recorded revision
      // in its named epoch. Revision zero is a valid untouched document state,
      // so there is deliberately no editor_edit_events reference.
      const document = await client.query<{ revision: string }>(
        `SELECT revision::text AS revision
           FROM public.editor_documents
          WHERE tenant_id = $1 AND project_id = $2 AND document_key = $3 AND epoch = $4::uuid
          FOR UPDATE`,
        [tenant, project, Buffer.from(lineage.documentKey, "hex"), lineage.documentEpoch],
      );
      const documentRow = document.rows[0];
      if (!documentRow) return { kind: "refused", reason: "document-not-found" } as const;
      if (lineage.documentRevision > BigInt(documentRow.revision)) {
        return { kind: "refused", reason: "revision-ahead" } as const;
      }

      // Serialize publication against storage-first GC. A tombstone may have
      // been queued while this freshly staged object was not yet registered;
      // once that happens, accepting its receipt would create a publication
      // whose bytes are already being deleted.
      await this.#lockArtifact(client, tenant, receipt);
      const deleting = await client.query(
        `SELECT 1 FROM public.client_export_deletions
          WHERE tenant_id = $1 AND object_key = $2 AND object_generation = $3::uuid`,
        [tenant, receipt.objectKey, receipt.objectLocatorToken],
      );
      if (deleting.rows.length !== 0) {
        return { kind: "refused", reason: "artifact-deleting" } as const;
      }

      // Metering settlement joins this acceptance transaction. Production
      // commits the flow reservation and retained-byte allocation atomically
      // with the rows below; local export injects an explicit no-op port.
      const settlement = await this.#metering.settlePublicationWithClient(client, {
        byteSize: receipt.byteSize,
        operationId: publicationId,
        target: "committed",
        tenantId: tenant,
      });
      if (settlement.kind !== "settled") {
        return { kind: "refused", reason: "quota-exhausted" } as const;
      }

      await client.query(
        `INSERT INTO public.client_export_artifacts
           (tenant_id, artifact_id, artifact_kind, media_type, content_digest, byte_size,
            object_key, object_generation, etag)
         VALUES ($1, $2::uuid, 'video', $3, $4, $5, $6, $7::uuid, $8)`,
        [
          tenant,
          artifactId,
          CLIENT_EXPORT_MEDIA_TYPE_V1,
          receipt.contentDigest,
          receipt.byteSize,
          receipt.objectKey,
          receipt.objectLocatorToken,
          receipt.etag,
        ],
      );
      const inserted = await client.query<PublicationRow>(
        `INSERT INTO public.client_export_publications
           (tenant_id, publication_id, artifact_id, project_id, document_key, document_epoch,
            document_revision, scene_contract_version, scene_revision_hash, export_profile_hash,
            producer_kind, encoder_evidence_version, encoder_evidence, created_by_subject_id, expires_at)
         SELECT $1, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::bigint, $8, $9, $10, $11, $12, $13::json,
                $14::uuid, clock_timestamp() + ($15::double precision * interval '1 millisecond')
         RETURNING tenant_id, publication_id::text AS publication_id, project_id, document_key,
                   document_epoch::text AS document_epoch, document_revision::text AS document_revision,
                   scene_revision_hash, export_profile_hash, encoder_evidence::text AS encoder_evidence_text,
                   created_by_subject_id::text AS created_by_subject_id, published_at, expires_at`,
        [
          tenant,
          publicationId,
          artifactId,
          project,
          Buffer.from(lineage.documentKey, "hex"),
          lineage.documentEpoch,
          lineage.documentRevision.toString(),
          CLIENT_EXPORT_SCENE_CONTRACT_VERSION_V1,
          lineage.sceneRevisionHash,
          lineage.exportProfileHash,
          CLIENT_EXPORT_PRODUCER_KIND_V1,
          CLIENT_EXPORT_ENCODER_EVIDENCE_VERSION_V1,
          JSON.stringify(lineage.encoderEvidence),
          createdBySubjectId,
          expirationMs,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (!insertedRow) throw new Error("PostgreSQL did not retain the client export publication.");
      const publication = publicationFromRow(tenant, {
        ...insertedRow,
        artifact_byte_size: receipt.byteSize,
        artifact_content_digest: receipt.contentDigest,
        artifact_etag: receipt.etag,
        artifact_id: artifactId,
        artifact_object_generation: receipt.objectLocatorToken,
        artifact_object_key: receipt.objectKey,
      });
      if (!sameClientExportArtifactReceiptV1(publication.artifact.receipt, receipt)) {
        throw new Error("PostgreSQL retained a different client export receipt.");
      }
      return { kind: "accepted", publication, replayed: false } as const;
    }, signal);
  }

  async readPublication(tenantValue: string, projectValue: string, publicationValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    const publicationId = clientExportIdV1(publicationValue, "Client export publication ID");
    const result = await this.#connection.query<PublicationRow>(
      `SELECT ${PUBLICATION_COLUMNS}
         FROM public.client_export_publications publication
         JOIN public.client_export_artifacts artifact
           ON artifact.tenant_id = publication.tenant_id AND artifact.artifact_id = publication.artifact_id
        WHERE publication.tenant_id = $1 AND publication.project_id = $2
          AND publication.publication_id = $3::uuid`,
      [tenant, project, publicationId],
      signal,
    );
    const row = result.rows[0];
    return row ? publicationFromRow(tenant, row) : null;
  }

  async acquirePublicationVideo(
    tenantValue: string,
    projectValue: string,
    publicationValue: string,
    claimDurationValue: number,
    signal?: AbortSignal,
  ): Promise<ClientExportReadClaimV1> {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    const publicationId = clientExportIdV1(publicationValue, "Client export publication ID");
    const claimDurationMs = boundedIntegerV1(claimDurationValue, "read-claim claimDurationMs", MAX_CLAIM_DURATION_MS);
    return this.#connection.transaction(async (client) => {
      await client.query(
        `DELETE FROM public.client_export_read_claims
          WHERE (tenant_id, claim_id) IN (
            SELECT tenant_id, claim_id
              FROM public.client_export_read_claims
             WHERE tenant_id = $1 AND expires_at <= clock_timestamp()
             ORDER BY expires_at, claim_id
             LIMIT $2
          )`,
        [tenant, MAX_PAGE],
      );
      const selected = await client.query<ArtifactRow & { expires_at: Date }>(
        `SELECT ${ARTIFACT_COLUMNS}, publication.expires_at
           FROM public.client_export_publications publication
           JOIN public.client_export_artifacts artifact
             ON artifact.tenant_id = publication.tenant_id AND artifact.artifact_id = publication.artifact_id
          WHERE publication.tenant_id = $1 AND publication.project_id = $2
            AND publication.publication_id = $3::uuid
            AND publication.expires_at > clock_timestamp()
          FOR UPDATE OF artifact`,
        [tenant, project, publicationId],
      );
      const row = selected.rows[0];
      if (!row) missingPublication();
      const claimId = randomUUID();
      const inserted = await client.query<{ claim_expires_at: Date }>(
        `INSERT INTO public.client_export_read_claims (tenant_id, claim_id, artifact_id, expires_at)
         SELECT $1, $2::uuid, $3::uuid,
                clock_timestamp() + ($5::double precision * interval '1 millisecond')
          WHERE $4 > clock_timestamp()
         RETURNING expires_at AS claim_expires_at`,
        [tenant, claimId, row.artifact_id, row.expires_at, claimDurationMs],
      );
      const claimExpiresAt = inserted.rows[0]?.claim_expires_at;
      if (!claimExpiresAt) missingPublication();
      return {
        artifact: {
          artifactId: clientExportIdV1(row.artifact_id, "Client export artifact ID"),
          receipt: receiptFromRow(tenant, row),
        },
        claimExpiresAt: date(claimExpiresAt, "Client export read-claim expiry"),
        claimId,
      };
    }, signal);
  }

  async releaseReadClaim(tenantValue: string, claimValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const claim = clientExportIdV1(claimValue, "Client export read-claim ID");
    await this.#connection.query(
      "DELETE FROM public.client_export_read_claims WHERE tenant_id = $1 AND claim_id = $2::uuid",
      [tenant, claim],
      signal,
    );
  }

  async isArtifactRetained(tenantValue: string, receiptValue: ClientExportArtifactReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const receipt = parseClientExportArtifactReceiptV1(tenant, receiptValue);
    const result = await this.#connection.query<{ retained: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.client_export_artifacts artifact
          WHERE artifact.tenant_id = $1 AND artifact.object_key = $2
            AND artifact.object_generation = $3::uuid AND artifact.content_digest = $4
            AND (
              EXISTS (
                SELECT 1 FROM public.client_export_publications publication
                 WHERE publication.tenant_id = artifact.tenant_id
                   AND publication.artifact_id = artifact.artifact_id
                   AND publication.expires_at > clock_timestamp()
              )
              OR EXISTS (
                SELECT 1 FROM public.client_export_read_claims claim
                 WHERE claim.tenant_id = artifact.tenant_id AND claim.artifact_id = artifact.artifact_id
                   AND claim.expires_at > clock_timestamp()
              )
            )
       ) AS retained`,
      [tenant, receipt.objectKey, receipt.objectLocatorToken, receipt.contentDigest],
      signal,
    );
    return result.rows[0]?.retained === true;
  }

  async queueDeletion(
    tenantValue: string,
    receiptValue: ClientExportArtifactReceiptV1,
    graceValue: number,
    signal?: AbortSignal,
  ) {
    const tenant = tenantId(tenantValue);
    const receipt = parseClientExportArtifactReceiptV1(tenant, receiptValue);
    const graceMs = boundedIntegerV1(graceValue, "client export GC graceMs", MAX_GC_GRACE_MS);
    return this.#connection.transaction(async (client) => {
      await this.#lockArtifact(client, tenant, receipt);
      const existing = await client.query<DeletionRow & { deleted_at: Date | null }>(
        `SELECT deletion_id::text AS deletion_id, content_digest AS artifact_content_digest,
                byte_size AS artifact_byte_size, object_key AS artifact_object_key,
                object_generation::text AS artifact_object_generation, etag AS artifact_etag, deleted_at
           FROM public.client_export_deletions
          WHERE tenant_id = $1 AND object_key = $2 AND object_generation = $3::uuid
          FOR UPDATE`,
        [tenant, receipt.objectKey, receipt.objectLocatorToken],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        if (existingRow.deleted_at === null) return deletionFromRow(existingRow, tenant);
        date(existingRow.deleted_at, "Stored client export deletion acknowledgement");
        return null;
      }

      const stored = await client.query<
        ArtifactRow & { publication_expires_at: Date | null; publication_id: string | null }
      >(
        `SELECT ${ARTIFACT_COLUMNS}, publication.expires_at AS publication_expires_at,
                publication.publication_id::text AS publication_id
           FROM public.client_export_artifacts artifact
           LEFT JOIN public.client_export_publications publication
             ON publication.tenant_id = artifact.tenant_id AND publication.artifact_id = artifact.artifact_id
          WHERE artifact.tenant_id = $1 AND artifact.object_key = $2 AND artifact.object_generation = $3::uuid
          FOR UPDATE OF artifact`,
        [tenant, receipt.objectKey, receipt.objectLocatorToken],
      );
      const artifactRow = stored.rows[0];
      if (artifactRow) {
        if (!sameClientExportArtifactReceiptV1(receiptFromRow(tenant, artifactRow), receipt)) {
          throw new Error("The queued client export metadata does not match PostgreSQL.");
        }
        const eligible = await client.query<{ eligible: boolean }>(
          `SELECT ($2::timestamptz IS NULL OR $2::timestamptz <= clock_timestamp() - ($3::double precision * interval '1 millisecond'))
                  AND NOT EXISTS (
                    SELECT 1 FROM public.client_export_read_claims claim
                     WHERE claim.tenant_id = $1 AND claim.artifact_id = $4::uuid
                       AND claim.expires_at > clock_timestamp()
                  ) AS eligible`,
          [tenant, artifactRow.publication_expires_at, graceMs, artifactRow.artifact_id],
        );
        if (eligible.rows[0]?.eligible !== true) return null;
        if (artifactRow.publication_id !== null) {
          await this.#metering.releasePublicationStockWithClient(
            client,
            tenant,
            clientExportIdV1(artifactRow.publication_id, "Client export publication ID"),
          );
        }
        await client.query(
          "DELETE FROM public.client_export_publications WHERE tenant_id = $1 AND artifact_id = $2::uuid",
          [tenant, artifactRow.artifact_id],
        );
        await client.query(
          "DELETE FROM public.client_export_artifacts WHERE tenant_id = $1 AND artifact_id = $2::uuid",
          [tenant, artifactRow.artifact_id],
        );
      }

      const deletionId = randomUUID();
      const inserted = await client.query<DeletionRow>(
        `INSERT INTO public.client_export_deletions
           (tenant_id, deletion_id, content_digest, byte_size, object_key, object_generation, etag)
         VALUES ($1, $2::uuid, $3, $4, $5, $6::uuid, $7)
         RETURNING deletion_id::text AS deletion_id, content_digest AS artifact_content_digest,
                   byte_size AS artifact_byte_size, object_key AS artifact_object_key,
                   object_generation::text AS artifact_object_generation, etag AS artifact_etag`,
        [
          tenant,
          deletionId,
          receipt.contentDigest,
          receipt.byteSize,
          receipt.objectKey,
          receipt.objectLocatorToken,
          receipt.etag,
        ],
      );
      return deletionFromRow(inserted.rows[0]!, tenant);
    }, signal);
  }

  async pendingDeletions(tenantValue: string, maximumValue: number, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const maximum = boundedIntegerV1(maximumValue, "maximum", MAX_PAGE);
    const result = await this.#connection.query<DeletionRow>(
      `SELECT deletion_id::text AS deletion_id, content_digest AS artifact_content_digest,
              byte_size AS artifact_byte_size, object_key AS artifact_object_key,
              object_generation::text AS artifact_object_generation, etag AS artifact_etag
         FROM public.client_export_deletions
        WHERE tenant_id = $1 AND deleted_at IS NULL
        ORDER BY queued_at, deletion_id
        LIMIT $2`,
      [tenant, maximum],
      signal,
    );
    return result.rows.map((row) => deletionFromRow(row, tenant));
  }

  async acknowledgeDeletion(tenantValue: string, deletionValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const deletion = clientExportIdV1(deletionValue, "Client export deletion ID");
    await this.#connection.query(
      `UPDATE public.client_export_deletions
          SET deleted_at = COALESCE(deleted_at, clock_timestamp())
        WHERE tenant_id = $1 AND deletion_id = $2::uuid`,
      [tenant, deletion],
      signal,
    );
  }

  close() {
    return this.#connection.close();
  }
}
