import type { Pool, PoolConfig, QueryResultRow } from "pg";

import { manimProjectIdSchema } from "../../../src/render-pipeline/contracts";
import { manimTenantIdSchema } from "../../manim-request-principal";
import {
  type AcceptClientThumbnailPublicationInputV1,
  type AcceptClientThumbnailPublicationResultV1,
  CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
  CLIENT_THUMBNAIL_PRODUCER_KIND_V1,
  CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1,
  CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1,
  type ClientThumbnailPublicationV1,
  type ClientThumbnailRepositoryV1,
  clientThumbnailIdV1,
  parseClientThumbnailArtifactReceiptV1,
  parseClientThumbnailLineageV1,
  sameClientThumbnailPublicationPayloadV1,
} from "../client-thumbnail-contract";
import { ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM } from "./account-organization-schema";
import { CLIENT_THUMBNAIL_PUBLICATION_MIGRATION_V33_CHECKSUM } from "./client-thumbnail-publication-schema";
import { EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_CHECKSUM } from "./editor-document-origin-schema";
import { EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM } from "./editor-document-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";
import { WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM } from "./postgres-workspace-source-repository";

const READY_MIGRATIONS = [
  [1, WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM],
  [11, ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM],
  [17, EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM],
  [30, EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_CHECKSUM],
  [33, CLIENT_THUMBNAIL_PUBLICATION_MIGRATION_V33_CHECKSUM],
] as const;

type PublicationRow = QueryResultRow & {
  artifact_byte_size: number;
  artifact_content_digest: string;
  artifact_etag: string;
  artifact_id: string;
  artifact_object_generation: string;
  artifact_object_key: string;
  created_by_subject_id: string;
  document_epoch: string;
  document_key: Buffer;
  document_revision: string;
  project_id: string;
  publication_id: string;
  published_at: Date;
  scene_revision_hash: string;
  tenant_id: string;
};

const PUBLICATION_COLUMNS = `
  publication.tenant_id,
  publication.publication_id::text AS publication_id,
  publication.project_id,
  publication.document_key,
  publication.document_epoch::text AS document_epoch,
  publication.document_revision::text AS document_revision,
  publication.scene_revision_hash,
  publication.created_by_subject_id::text AS created_by_subject_id,
  publication.published_at,
  artifact.artifact_id::text AS artifact_id,
  artifact.content_digest AS artifact_content_digest,
  artifact.byte_size AS artifact_byte_size,
  artifact.object_key AS artifact_object_key,
  artifact.object_generation::text AS artifact_object_generation,
  artifact.etag AS artifact_etag
`;

function tenantIdV1(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Client thumbnail tenant ID is invalid.");
  return parsed.data;
}

function projectIdV1(value: string) {
  const parsed = manimProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Client thumbnail project ID is invalid.");
  return parsed.data;
}

function publicationFromRow(tenant: string, row: PublicationRow): ClientThumbnailPublicationV1 {
  const receipt = parseClientThumbnailArtifactReceiptV1(tenant, {
    byteSize: row.artifact_byte_size,
    contentDigest: row.artifact_content_digest,
    etag: row.artifact_etag,
    mediaType: CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
    objectKey: row.artifact_object_key,
    objectLocatorToken: row.artifact_object_generation,
  });
  if (!(row.published_at instanceof Date) || Number.isNaN(row.published_at.getTime())) {
    throw new TypeError("Client thumbnail publication time is invalid.");
  }
  return {
    artifact: {
      artifactId: clientThumbnailIdV1(row.artifact_id, "Client thumbnail artifact ID"),
      receipt,
    },
    createdBySubjectId: clientThumbnailIdV1(row.created_by_subject_id, "Client thumbnail subject ID"),
    lineage: parseClientThumbnailLineageV1({
      documentEpoch: row.document_epoch,
      documentKey: row.document_key.toString("hex"),
      documentRevision: BigInt(row.document_revision),
      producerKind: CLIENT_THUMBNAIL_PRODUCER_KIND_V1,
      representativeFrameRule: CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1,
      sceneContractVersion: CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1,
      sceneRevisionHash: row.scene_revision_hash,
    }),
    projectId: projectIdV1(row.project_id),
    publicationId: clientThumbnailIdV1(row.publication_id, "Client thumbnail publication ID"),
    publishedAt: new Date(row.published_at.getTime()),
    tenantId: tenantIdV1(row.tenant_id),
  };
}

export type PostgresClientThumbnailRepositoryOptionsV1 = Readonly<{
  pool?: Pool;
  poolConfig?: PoolConfig;
  statementTimeoutMs?: number;
}>;

/** PostgreSQL authority for browser thumbnail publication and current project heads. */
export class PostgresClientThumbnailRepositoryV1 implements ClientThumbnailRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: PostgresClientThumbnailRepositoryOptionsV1) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
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

  async acceptPublication(
    input: AcceptClientThumbnailPublicationInputV1,
    signal?: AbortSignal,
  ): Promise<AcceptClientThumbnailPublicationResultV1> {
    const tenant = tenantIdV1(input.tenantId);
    const project = projectIdV1(input.projectId);
    const publicationId = clientThumbnailIdV1(input.publicationId, "Client thumbnail publication ID");
    const artifactId = clientThumbnailIdV1(input.artifactId, "Client thumbnail artifact ID");
    const subjectId = clientThumbnailIdV1(input.createdBySubjectId, "Client thumbnail subject ID");
    const receipt = parseClientThumbnailArtifactReceiptV1(tenant, input.receipt);
    const lineage = parseClientThumbnailLineageV1(input.lineage);

    return this.#connection.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `client-thumbnail-publication:${tenant}:${publicationId}`,
      ]);
      const existing = await client.query<PublicationRow>(
        `SELECT ${PUBLICATION_COLUMNS}
           FROM public.client_thumbnail_publications publication
           JOIN public.client_thumbnail_artifacts artifact
             ON artifact.tenant_id = publication.tenant_id AND artifact.artifact_id = publication.artifact_id
          WHERE publication.tenant_id = $1 AND publication.publication_id = $2::uuid
          FOR UPDATE OF publication, artifact`,
        [tenant, publicationId],
      );
      if (existing.rows[0]) {
        const publication = publicationFromRow(tenant, existing.rows[0]);
        return sameClientThumbnailPublicationPayloadV1(publication, {
          createdBySubjectId: subjectId,
          lineage,
          projectId: project,
          receipt,
        })
          ? ({ kind: "accepted", publication, replayed: true } as const)
          : ({ kind: "conflict" } as const);
      }

      const selectedProject = await client.query(
        `SELECT 1 FROM public.workspace_projects
          WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [tenant, project],
      );
      if (selectedProject.rowCount !== 1) return { kind: "refused", reason: "document-not-found" } as const;
      const document = await client.query<{ revision: string }>(
        `SELECT revision::text AS revision
           FROM public.editor_documents
          WHERE tenant_id = $1 AND project_id = $2 AND document_key = $3 AND epoch = $4::uuid
          FOR UPDATE`,
        [tenant, project, Buffer.from(lineage.documentKey, "hex"), lineage.documentEpoch],
      );
      if (!document.rows[0]) return { kind: "refused", reason: "document-not-found" } as const;
      if (BigInt(document.rows[0].revision) !== lineage.documentRevision) {
        return { kind: "refused", reason: "document-revision-mismatch" } as const;
      }

      await client.query(
        `INSERT INTO public.client_thumbnail_artifacts
           (tenant_id, artifact_id, content_digest, byte_size, object_key, object_generation, etag)
         VALUES ($1, $2::uuid, $3, $4, $5, $6::uuid, $7)`,
        [
          tenant,
          artifactId,
          receipt.contentDigest,
          receipt.byteSize,
          receipt.objectKey,
          receipt.objectLocatorToken,
          receipt.etag,
        ],
      );
      const inserted = await client.query<PublicationRow>(
        `INSERT INTO public.client_thumbnail_publications
           (tenant_id, publication_id, artifact_id, project_id, document_key, document_epoch,
            document_revision, scene_contract_version, scene_revision_hash, producer_kind,
            representative_frame_rule, created_by_subject_id)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::bigint, $8, $9, $10, $11, $12::uuid)
         RETURNING tenant_id, publication_id::text AS publication_id, project_id, document_key,
                   document_epoch::text AS document_epoch, document_revision::text AS document_revision,
                   scene_revision_hash, created_by_subject_id::text AS created_by_subject_id, published_at`,
        [
          tenant,
          publicationId,
          artifactId,
          project,
          Buffer.from(lineage.documentKey, "hex"),
          lineage.documentEpoch,
          lineage.documentRevision.toString(),
          CLIENT_THUMBNAIL_SCENE_CONTRACT_VERSION_V1,
          lineage.sceneRevisionHash,
          CLIENT_THUMBNAIL_PRODUCER_KIND_V1,
          CLIENT_THUMBNAIL_REPRESENTATIVE_FRAME_RULE_V1,
          subjectId,
        ],
      );
      await client.query(
        `INSERT INTO public.workspace_project_client_thumbnail_heads (tenant_id, project_id, publication_id)
         VALUES ($1, $2, $3::uuid)
         ON CONFLICT (tenant_id, project_id) DO UPDATE
           SET publication_id = EXCLUDED.publication_id, updated_at = clock_timestamp()`,
        [tenant, project, publicationId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("PostgreSQL did not retain the client thumbnail publication.");
      const publication = publicationFromRow(tenant, {
        ...row,
        artifact_byte_size: receipt.byteSize,
        artifact_content_digest: receipt.contentDigest,
        artifact_etag: receipt.etag,
        artifact_id: artifactId,
        artifact_object_generation: receipt.objectLocatorToken,
        artifact_object_key: receipt.objectKey,
      });
      return { kind: "accepted", publication, replayed: false } as const;
    }, signal);
  }

  async readPublication(tenantValue: string, projectValue: string, publicationValue: string, signal?: AbortSignal) {
    const tenant = tenantIdV1(tenantValue);
    const project = projectIdV1(projectValue);
    const publicationId = clientThumbnailIdV1(publicationValue, "Client thumbnail publication ID");
    const result = await this.#connection.query<PublicationRow>(
      `SELECT ${PUBLICATION_COLUMNS}
         FROM public.client_thumbnail_publications publication
         JOIN public.client_thumbnail_artifacts artifact
           ON artifact.tenant_id = publication.tenant_id AND artifact.artifact_id = publication.artifact_id
        WHERE publication.tenant_id = $1 AND publication.project_id = $2
          AND publication.publication_id = $3::uuid`,
      [tenant, project, publicationId],
      signal,
    );
    return result.rows[0] ? publicationFromRow(tenant, result.rows[0]) : null;
  }

  async readCurrent(tenantValue: string, projectValue: string, signal?: AbortSignal) {
    const tenant = tenantIdV1(tenantValue);
    const project = projectIdV1(projectValue);
    const result = await this.#connection.query<PublicationRow>(
      `SELECT ${PUBLICATION_COLUMNS}
         FROM public.workspace_project_client_thumbnail_heads head
         JOIN public.workspace_projects project
           ON project.tenant_id = head.tenant_id AND project.project_id = head.project_id
          AND project.deleted_at IS NULL
         JOIN public.client_thumbnail_publications publication
           ON publication.tenant_id = head.tenant_id AND publication.project_id = head.project_id
          AND publication.publication_id = head.publication_id
         JOIN public.client_thumbnail_artifacts artifact
           ON artifact.tenant_id = publication.tenant_id AND artifact.artifact_id = publication.artifact_id
        WHERE head.tenant_id = $1 AND head.project_id = $2`,
      [tenant, project],
      signal,
    );
    return result.rows[0] ? publicationFromRow(tenant, result.rows[0]) : null;
  }

  close() {
    return this.#connection.close();
  }
}
