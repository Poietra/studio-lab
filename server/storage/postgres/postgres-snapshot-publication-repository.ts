import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../../../src/render-pipeline/manim-identity-contract";
import { HttpError } from "../../http/json";
import { manimTenantIdSchema } from "../../manim-request-principal";
import { IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1 } from "../immutable-snapshot-artifact-store";
import {
  snapshotArtifactIdentityV1 as artifactIdentity,
  snapshotArtifactLocatorV1 as artifactLocator,
  parseSnapshotArtifactReceiptV1 as artifactReceipt,
  sameSnapshotArtifactReceiptV1 as exactArtifact,
  LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
  type SnapshotArtifactDeletionV1,
  type SnapshotArtifactReceiptV1,
  type SnapshotPublicationIdentityV1,
  type SnapshotPublicationRepositoryV1,
  type SnapshotPublicationV1,
  sameSnapshotArtifactContentV1 as sameArtifactContent,
} from "../snapshot-publication-repository";
import { DURABLE_RETENTION_MIGRATION_V6_CHECKSUM } from "./durable-retention-schema";
import { IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM } from "./immutable-object-generation-schema";
import {
  detachProjectPngHeadInTransactionV1,
  PROJECT_PNG_MIGRATION_V5_CHECKSUM,
} from "./postgres-project-png-repository";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";
import { SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM } from "./snapshot-runtime-digest-schema";

export const SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM =
  "5280f234896253f37a913da5197cc2547b6cb6313a746bea07153cbc5d62db27";

const MAX_SCENE_GENERATION_V1 = 9_007_199_254_740_991n;
const MAX_POSTGRES_GENERATION_V1 = 9_223_372_036_854_775_807n;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ArtifactRow = QueryResultRow & {
  artifact_byte_size: number;
  artifact_etag: string;
  artifact_object_key: string;
  artifact_object_generation: string | null;
  artifact_profile_digest: string;
  artifact_result_digest: string;
  artifact_runtime_config_hash: string;
  artifact_runtime_digest: string;
  artifact_source_digest: string;
  artifact_tenant_id: string;
  artifact_version_id: string | null;
};

type PublicationRow = ArtifactRow & {
  project_id: string;
  publication_id: string;
  publication_profile_digest: string;
  publication_result_digest: string;
  publication_runtime_config_hash: string;
  publication_runtime_digest: string;
  publication_source_digest: string;
  published_at: Date;
  request_id: string;
  scene_name: string;
  snapshot_hash: string;
  source_generation: string;
  source_path: string;
  tenant_id: string;
  publication_generation: string;
};

type DeletionRow = ArtifactRow & {
  deleted_at: Date | null;
  deletion_id: string;
};

type SceneHeadRow = Partial<PublicationRow> &
  QueryResultRow & {
    head_generation: string;
    head_project_id: string;
    head_publication_id: string | null;
    head_runtime_digest: string;
    head_scene_name: string;
    head_source_path: string;
    head_tenant_id: string;
  };

type SourceHeadRow = QueryResultRow & {
  digest: string;
  generation: string;
  project_id: string;
  source_path: string;
  tenant_id: string;
};

function artifactColumns(alias: string) {
  return `
    ${alias}.tenant_id AS artifact_tenant_id,
    ${alias}.result_digest AS artifact_result_digest,
    ${alias}.source_digest AS artifact_source_digest,
    ${alias}.runtime_config_hash AS artifact_runtime_config_hash,
    ${alias}.profile_digest AS artifact_profile_digest,
    ${alias}.runtime_digest AS artifact_runtime_digest,
    ${alias}.object_key AS artifact_object_key,
    ${alias}.object_generation::text AS artifact_object_generation,
    ${alias}.version_id AS artifact_version_id,
    ${alias}.etag AS artifact_etag,
    ${alias}.byte_size AS artifact_byte_size
  `;
}

const ARTIFACT_COLUMNS = artifactColumns("a");

const PUBLICATION_COLUMNS = `
  p.tenant_id,
  p.publication_id::text AS publication_id,
  p.project_id,
  p.source_path,
  p.scene_name,
  p.generation::text AS publication_generation,
  p.source_generation::text AS source_generation,
  p.source_digest AS publication_source_digest,
  p.runtime_config_hash AS publication_runtime_config_hash,
  p.profile_digest AS publication_profile_digest,
  p.runtime_digest AS publication_runtime_digest,
  p.result_digest AS publication_result_digest,
  p.snapshot_hash,
  p.request_id,
  p.published_at,
  ${ARTIFACT_COLUMNS}
`;

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
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

function sceneName(value: string) {
  const parsed = manimSceneNameSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Scene name is invalid.");
  return parsed.data;
}

function sha256(value: string, name: string) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

function uuid(value: string, name: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

function boundedText(value: string, name: string, maximumBytes: number) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function generation(value: bigint, name: string, maximum: bigint) {
  if (typeof value !== "bigint" || value <= 0n || value > maximum) throw new TypeError(`${name} is invalid.`);
  return value;
}

function boundedPositiveInteger(value: number, name: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function artifactValues(tenant: string, artifact: SnapshotArtifactReceiptV1) {
  const identity = artifactIdentity(artifact);
  const locator = artifactLocator(artifact);
  return [
    tenant,
    identity.resultDigest,
    identity.sourceDigest,
    identity.runtimeConfigHash,
    identity.profileDigest,
    identity.runtimeDigest,
    locator.objectKey,
    locator.kind === "versioned" ? locator.versionId : null,
    locator.kind === "immutable" ? locator.objectGeneration : null,
    artifact.etag,
    artifact.byteSize,
  ];
}

function generationFromRow(value: unknown, name: string, maximum: bigint) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  }
  const parsed = BigInt(value);
  if (parsed > maximum) throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  return parsed;
}

function publicationIdentity(value: SnapshotPublicationIdentityV1): SnapshotPublicationIdentityV1 {
  if (!value || typeof value !== "object") throw new TypeError("Snapshot publication identity is invalid.");
  const runtimeDigest = sha256(value.runtimeDigest, "Snapshot runtime digest");
  if (runtimeDigest === LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1) {
    throw new TypeError("Snapshot runtime digest is reserved for legacy artifacts.");
  }
  return {
    projectId: projectId(value.projectId),
    runtimeDigest,
    sceneName: sceneName(value.sceneName),
    sourcePath: sourcePath(value.sourcePath),
    tenantId: tenantId(value.tenantId),
  };
}

function artifactFromRow(row: ArtifactRow): SnapshotArtifactReceiptV1 {
  const tenant = tenantId(row.artifact_tenant_id);
  const identity = {
    profileDigest: row.artifact_profile_digest,
    resultDigest: row.artifact_result_digest,
    runtimeConfigHash: row.artifact_runtime_config_hash,
    runtimeDigest: row.artifact_runtime_digest,
    sourceDigest: row.artifact_source_digest,
  };
  if ((row.artifact_version_id === null) === (row.artifact_object_generation === null)) {
    throw new TypeError("PostgreSQL returned an ambiguous snapshot artifact locator.");
  }
  const shared = {
    byteSize: row.artifact_byte_size,
    etag: row.artifact_etag,
    objectKey: row.artifact_object_key,
  };
  if (row.artifact_version_id !== null) {
    return artifactReceipt(tenant, { ...shared, ...identity, versionId: row.artifact_version_id });
  }
  const { runtimeDigest, ...digests } = identity;
  return artifactReceipt(tenant, {
    ...shared,
    identity:
      runtimeDigest === LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1
        ? { ...digests, kind: "legacy" }
        : { ...digests, kind: "runtime-digest", runtimeDigest },
    objectGeneration: row.artifact_object_generation,
    schema: IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
    version: 1,
  });
}

function deletionFromRow(row: DeletionRow, expectedTenant?: string): SnapshotArtifactDeletionV1 {
  const tenant = tenantId(row.artifact_tenant_id);
  if (expectedTenant !== undefined && tenant !== expectedTenant) {
    throw new TypeError("PostgreSQL returned a snapshot artifact deletion for another tenant.");
  }
  if (row.deleted_at !== null && (!(row.deleted_at instanceof Date) || Number.isNaN(row.deleted_at.getTime()))) {
    throw new TypeError("PostgreSQL returned an invalid snapshot artifact deletion timestamp.");
  }
  return {
    artifact: artifactFromRow(row),
    deletionId: uuid(row.deletion_id, "Stored snapshot artifact deletion ID"),
    tenantId: tenant,
  };
}

function publicationFromRow(row: PublicationRow): SnapshotPublicationV1 {
  const identity = publicationIdentity({
    projectId: row.project_id,
    runtimeDigest: row.publication_runtime_digest,
    sceneName: row.scene_name,
    sourcePath: row.source_path,
    tenantId: row.tenant_id,
  });
  const artifact = artifactFromRow(row);
  const storedIdentity = artifactIdentity(artifact);
  if (
    row.artifact_tenant_id !== identity.tenantId ||
    sha256(row.publication_source_digest, "Stored publication source digest") !== storedIdentity.sourceDigest ||
    sha256(row.publication_runtime_config_hash, "Stored publication runtime-config hash") !==
      storedIdentity.runtimeConfigHash ||
    sha256(row.publication_profile_digest, "Stored publication profile digest") !== storedIdentity.profileDigest ||
    identity.runtimeDigest !== storedIdentity.runtimeDigest ||
    sha256(row.publication_result_digest, "Stored publication result digest") !== storedIdentity.resultDigest ||
    !(row.published_at instanceof Date) ||
    Number.isNaN(row.published_at.getTime())
  ) {
    throw new TypeError("PostgreSQL returned an invalid snapshot publication.");
  }
  return {
    ...identity,
    artifact,
    generation: generationFromRow(row.publication_generation, "snapshot generation", MAX_SCENE_GENERATION_V1),
    publicationId: uuid(row.publication_id, "Stored publication ID"),
    publishedAt: row.published_at,
    requestId: boundedText(row.request_id, "Stored snapshot request ID", 2_048),
    snapshotHash: sha256(row.snapshot_hash, "Stored snapshot hash"),
    sourceGeneration: generationFromRow(row.source_generation, "source generation", MAX_POSTGRES_GENERATION_V1),
  };
}

function checkedPublication(value: SnapshotPublicationV1): SnapshotPublicationV1 {
  const identity = publicationIdentity(value);
  const artifact = artifactReceipt(identity.tenantId, value.artifact);
  if (artifactIdentity(artifact).runtimeDigest !== identity.runtimeDigest) {
    throw new TypeError("The snapshot artifact does not belong to the publication runtime.");
  }
  if (!(value.publishedAt instanceof Date) || Number.isNaN(value.publishedAt.getTime())) {
    throw new TypeError("Snapshot publication timestamp is invalid.");
  }
  return {
    ...identity,
    artifact,
    generation: generation(value.generation, "Snapshot generation", MAX_SCENE_GENERATION_V1),
    publicationId: uuid(value.publicationId, "Snapshot publication ID"),
    publishedAt: value.publishedAt,
    requestId: boundedText(value.requestId, "Snapshot request ID", 2_048),
    snapshotHash: sha256(value.snapshotHash, "Snapshot hash"),
    sourceGeneration: generation(value.sourceGeneration, "Source generation", MAX_POSTGRES_GENERATION_V1),
  };
}

function exactPublication(left: SnapshotPublicationV1, right: SnapshotPublicationV1) {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.sourcePath === right.sourcePath &&
    left.sceneName === right.sceneName &&
    left.runtimeDigest === right.runtimeDigest &&
    left.generation === right.generation &&
    left.sourceGeneration === right.sourceGeneration &&
    left.publicationId === right.publicationId &&
    left.requestId === right.requestId &&
    left.snapshotHash === right.snapshotHash &&
    left.publishedAt.getTime() === right.publishedAt.getTime() &&
    exactArtifact(left.artifact, right.artifact)
  );
}

function sourceFromRow(row: SourceHeadRow) {
  const identity = {
    projectId: projectId(row.project_id),
    sourcePath: sourcePath(row.source_path),
    tenantId: tenantId(row.tenant_id),
  };
  return {
    ...identity,
    digest: sha256(row.digest, "Stored source digest"),
    generation: generationFromRow(row.generation, "source generation", MAX_POSTGRES_GENERATION_V1),
  };
}

function headFromRow(row: SceneHeadRow, expected: SnapshotPublicationIdentityV1) {
  const identity = publicationIdentity({
    projectId: row.head_project_id,
    runtimeDigest: row.head_runtime_digest,
    sceneName: row.head_scene_name,
    sourcePath: row.head_source_path,
    tenantId: row.head_tenant_id,
  });
  if (
    identity.tenantId !== expected.tenantId ||
    identity.projectId !== expected.projectId ||
    identity.sourcePath !== expected.sourcePath ||
    identity.sceneName !== expected.sceneName ||
    identity.runtimeDigest !== expected.runtimeDigest
  ) {
    throw new TypeError("PostgreSQL returned a snapshot head for another Scene.");
  }
  const headGeneration = generationFromRow(row.head_generation, "snapshot head generation", MAX_SCENE_GENERATION_V1);
  if (row.head_publication_id === null) return { generation: headGeneration, publication: null };
  const publication = publicationFromRow(row as PublicationRow);
  if (
    publication.tenantId !== identity.tenantId ||
    publication.projectId !== identity.projectId ||
    publication.sourcePath !== identity.sourcePath ||
    publication.sceneName !== identity.sceneName ||
    publication.runtimeDigest !== identity.runtimeDigest ||
    publication.generation !== headGeneration ||
    publication.publicationId !== uuid(row.head_publication_id, "Stored snapshot head publication ID")
  ) {
    throw new TypeError("PostgreSQL returned an invalid snapshot Scene head publication.");
  }
  return { generation: headGeneration, publication };
}

export class PostgresSnapshotPublicationRepositoryV1 implements SnapshotPublicationRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async #currentSource(client: PoolClient, identity: SnapshotPublicationIdentityV1) {
    const result = await client.query<SourceHeadRow>(
      `SELECT h.tenant_id, h.project_id, h.source_path, h.generation::text AS generation, h.digest
         FROM public.workspace_source_heads h
         JOIN public.workspace_projects project
           ON project.tenant_id = h.tenant_id
          AND project.project_id = h.project_id
          AND project.deleted_at IS NULL
        WHERE h.tenant_id = $1 AND h.project_id = $2 AND h.source_path = $3
        FOR UPDATE OF h, project`,
      [identity.tenantId, identity.projectId, identity.sourcePath],
    );
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate workspace source heads.");
    if (!result.rows[0]) return null;
    const source = sourceFromRow(result.rows[0]);
    if (
      source.tenantId !== identity.tenantId ||
      source.projectId !== identity.projectId ||
      source.sourcePath !== identity.sourcePath
    ) {
      throw new TypeError("PostgreSQL returned a workspace source head for another project.");
    }
    return source;
  }

  async #sceneHead(client: PoolClient, identity: SnapshotPublicationIdentityV1) {
    const result = await client.query<SceneHeadRow>(
      `SELECT
         h.tenant_id AS head_tenant_id,
         h.project_id AS head_project_id,
         h.source_path AS head_source_path,
         h.scene_name AS head_scene_name,
         h.runtime_digest AS head_runtime_digest,
         h.generation::text AS head_generation,
         h.publication_id::text AS head_publication_id,
         ${PUBLICATION_COLUMNS}
         FROM public.snapshot_scene_heads h
         LEFT JOIN public.snapshot_publications p
           ON p.tenant_id = h.tenant_id
          AND p.publication_id = h.publication_id
          AND p.runtime_digest = h.runtime_digest
         LEFT JOIN public.snapshot_artifact_objects a
           ON a.tenant_id = p.tenant_id
          AND a.result_digest = p.result_digest
          AND a.runtime_digest = p.runtime_digest
        WHERE h.tenant_id = $1 AND h.project_id = $2 AND h.source_path = $3 AND h.scene_name = $4
          AND h.runtime_digest = $5
        FOR UPDATE OF h`,
      [identity.tenantId, identity.projectId, identity.sourcePath, identity.sceneName, identity.runtimeDigest],
    );
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate snapshot Scene heads.");
    return result.rows[0] ? headFromRow(result.rows[0], identity) : null;
  }

  async #lockArtifact(client: PoolClient, tenant: string, artifact: SnapshotArtifactReceiptV1) {
    const identity = artifactIdentity(artifact);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `snapshot-artifact:${tenant}:${identity.runtimeDigest}:${identity.resultDigest}`,
    ]);
  }

  async #storedArtifact(client: PoolClient, tenant: string, candidate: SnapshotArtifactReceiptV1) {
    const identity = artifactIdentity(candidate);
    const locator = artifactLocator(candidate);
    const existing = await client.query<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS}
         FROM public.snapshot_artifact_objects a
        WHERE a.tenant_id = $1
          AND (
            (a.result_digest = $2 AND a.runtime_digest = $3)
            OR (
              a.object_key = $4
              AND a.version_id IS NOT DISTINCT FROM $5
              AND a.object_generation IS NOT DISTINCT FROM $6::uuid
            )
          )
        FOR UPDATE`,
      [
        tenant,
        identity.resultDigest,
        identity.runtimeDigest,
        locator.objectKey,
        locator.kind === "versioned" ? locator.versionId : null,
        locator.kind === "immutable" ? locator.objectGeneration : null,
      ],
    );
    if (existing.rows.length > 1) {
      throw new TypeError("The stored snapshot artifact metadata conflicts with its immutable identity.");
    }
    if (!existing.rows[0]) return null;
    const stored = artifactFromRow(existing.rows[0]);
    const storedLocator = artifactLocator(stored);
    const candidateLocator = artifactLocator(candidate);
    const sameLocator =
      storedLocator.kind === candidateLocator.kind &&
      storedLocator.objectKey === candidateLocator.objectKey &&
      (storedLocator.kind === "versioned"
        ? candidateLocator.kind === "versioned" && storedLocator.versionId === candidateLocator.versionId
        : candidateLocator.kind === "immutable" &&
          storedLocator.objectGeneration === candidateLocator.objectGeneration);
    if (
      existing.rows[0].artifact_tenant_id !== tenant ||
      (sameLocator ? !exactArtifact(stored, candidate) : !sameArtifactContent(stored, candidate))
    ) {
      throw new TypeError("The stored snapshot artifact metadata conflicts with its immutable identity.");
    }
    return stored;
  }

  async #isCurrentArtifact(client: PoolClient, tenant: string, artifact: SnapshotArtifactReceiptV1) {
    const values = artifactValues(tenant, artifact);
    const result = await client.query<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS}
         FROM public.snapshot_artifact_objects a
         JOIN public.snapshot_publications p
           ON p.tenant_id = a.tenant_id
          AND p.result_digest = a.result_digest
          AND p.source_digest = a.source_digest
          AND p.runtime_config_hash = a.runtime_config_hash
          AND p.profile_digest = a.profile_digest
          AND p.runtime_digest = a.runtime_digest
         JOIN public.snapshot_scene_heads h
           ON h.tenant_id = p.tenant_id
          AND h.project_id = p.project_id
          AND h.source_path = p.source_path
          AND h.scene_name = p.scene_name
          AND h.generation = p.generation
          AND h.publication_id = p.publication_id
          AND h.runtime_digest = p.runtime_digest
         JOIN public.workspace_projects project
           ON project.tenant_id = p.tenant_id AND project.project_id = p.project_id AND project.deleted_at IS NULL
         JOIN public.workspace_source_heads source
           ON source.tenant_id = p.tenant_id
          AND source.project_id = p.project_id
          AND source.source_path = p.source_path
          AND source.generation = p.source_generation
          AND source.digest = p.source_digest
        WHERE a.tenant_id = $1
          AND a.result_digest = $2
          AND a.source_digest = $3
          AND a.runtime_config_hash = $4
          AND a.profile_digest = $5
          AND a.runtime_digest = $6
          AND a.object_key = $7
          AND a.version_id IS NOT DISTINCT FROM $8
          AND a.object_generation IS NOT DISTINCT FROM $9::uuid
          AND a.etag = $10
          AND a.byte_size = $11
        LIMIT 1`,
      values,
    );
    for (const row of result.rows) {
      if (row.artifact_tenant_id !== tenant || !exactArtifact(artifactFromRow(row), artifact)) {
        throw new TypeError("PostgreSQL returned invalid current snapshot artifact metadata.");
      }
    }
    return result.rows.length !== 0;
  }

  async #registerArtifact(
    client: PoolClient,
    tenant: string,
    candidateValue: SnapshotArtifactReceiptV1,
    lockHeld = false,
  ) {
    const candidate = artifactReceipt(tenant, candidateValue);
    if (!lockHeld) await this.#lockArtifact(client, tenant, candidate);
    const values = artifactValues(tenant, candidate);
    const deleting = await client.query(
      `SELECT 1 FROM public.snapshot_artifact_deletions
        WHERE tenant_id = $1 AND object_key = $2
          AND version_id IS NOT DISTINCT FROM $3
          AND object_generation IS NOT DISTINCT FROM $4::uuid`,
      [tenant, values[6], values[7], values[8]],
    );
    if (deleting.rows.length !== 0) {
      throw new TypeError("The snapshot artifact candidate is no longer available.");
    }
    const inserted = await client.query<ArtifactRow>(
      `INSERT INTO public.snapshot_artifact_objects
         (tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest,
          runtime_digest, object_key, version_id, object_generation, etag, byte_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11)
       ON CONFLICT DO NOTHING
       RETURNING
         tenant_id AS artifact_tenant_id,
         result_digest AS artifact_result_digest,
         source_digest AS artifact_source_digest,
         runtime_config_hash AS artifact_runtime_config_hash,
         profile_digest AS artifact_profile_digest,
         runtime_digest AS artifact_runtime_digest,
         object_key AS artifact_object_key,
         object_generation::text AS artifact_object_generation,
         version_id AS artifact_version_id,
         etag AS artifact_etag,
         byte_size AS artifact_byte_size`,
      values,
    );
    let stored: SnapshotArtifactReceiptV1;
    if (inserted.rows.length === 1) {
      stored = artifactFromRow(inserted.rows[0]!);
    } else {
      if (inserted.rows.length !== 0) throw new TypeError("PostgreSQL returned duplicate inserted snapshot artifacts.");
      const existing = await this.#storedArtifact(client, tenant, candidate);
      if (!existing) {
        throw new TypeError("The stored snapshot artifact metadata conflicts with its immutable identity.");
      }
      stored = existing;
    }
    if (!sameArtifactContent(stored, candidate)) {
      throw new TypeError("The stored snapshot artifact metadata conflicts with its immutable identity.");
    }
    return stored;
  }

  async #tombstone(
    client: PoolClient,
    identity: SnapshotPublicationIdentityV1,
    expectedGeneration: bigint,
    publicationId: string,
  ) {
    const updated = await client.query(
      `UPDATE public.snapshot_scene_heads
          SET publication_id = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND project_id = $2 AND source_path = $3 AND scene_name = $4
          AND runtime_digest = $5
          AND generation = $6::bigint AND publication_id = $7::uuid`,
      [
        identity.tenantId,
        identity.projectId,
        identity.sourcePath,
        identity.sceneName,
        identity.runtimeDigest,
        expectedGeneration.toString(),
        publicationId,
      ],
    );
    if (updated.rowCount !== 1) return false;
    await client.query(
      `DELETE FROM public.workspace_project_references
        WHERE tenant_id = $1 AND project_id = $2
          AND reference_kind = 'snapshot-publication' AND reference_id = $3`,
      [identity.tenantId, identity.projectId, publicationId],
    );
    return true;
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (3, 5, 6, 10, 20) ORDER BY version",
        [],
        signal,
      );
      return (
        result.rows.length === 5 &&
        result.rows[0]?.version === 3 &&
        result.rows[0]?.checksum === SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM &&
        result.rows[1]?.version === 5 &&
        result.rows[1]?.checksum === PROJECT_PNG_MIGRATION_V5_CHECKSUM &&
        result.rows[2]?.version === 6 &&
        result.rows[2]?.checksum === DURABLE_RETENTION_MIGRATION_V6_CHECKSUM &&
        result.rows[3]?.version === 10 &&
        result.rows[3]?.checksum === SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM &&
        result.rows[4]?.version === 20 &&
        result.rows[4]?.checksum === IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM
      );
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async publish(input: Parameters<SnapshotPublicationRepositoryV1["publish"]>[0], signal?: AbortSignal) {
    const identity = publicationIdentity(input);
    const artifact = artifactReceipt(identity.tenantId, input.artifact);
    const candidateIdentity = artifactIdentity(artifact);
    const expectedSourceDigest = sha256(input.expectedSourceDigest, "Expected source digest");
    const expectedSourceGeneration = generation(
      input.expectedSourceGeneration,
      "Expected source generation",
      MAX_POSTGRES_GENERATION_V1,
    );
    if (candidateIdentity.sourceDigest !== expectedSourceDigest) {
      throw new TypeError("The snapshot artifact does not belong to the expected source.");
    }
    if (candidateIdentity.runtimeDigest !== identity.runtimeDigest) {
      throw new TypeError("The snapshot artifact does not belong to the active runtime.");
    }
    const publicationId = uuid(input.publicationId, "Snapshot publication ID");
    const requestId = boundedText(input.requestId, "Snapshot request ID", 2_048);
    const snapshotHash = sha256(input.snapshotHash, "Snapshot hash");

    return this.#connection.transaction(async (client) => {
      await this.#lockArtifact(client, identity.tenantId, artifact);
      const source = await this.#currentSource(client, identity);
      if (
        !source ||
        source.tenantId !== identity.tenantId ||
        source.projectId !== identity.projectId ||
        source.sourcePath !== identity.sourcePath ||
        source.generation !== expectedSourceGeneration ||
        source.digest !== expectedSourceDigest
      ) {
        return { kind: "source-stale" as const };
      }

      const storedArtifact = await this.#registerArtifact(client, identity.tenantId, artifact, true);
      const currentHead = await this.#sceneHead(client, identity);
      if (
        currentHead?.publication &&
        currentHead.publication.sourceGeneration === expectedSourceGeneration &&
        currentHead.publication.requestId === requestId &&
        currentHead.publication.snapshotHash === snapshotHash &&
        exactArtifact(currentHead.publication.artifact, storedArtifact)
      ) {
        return { kind: "published" as const, publication: currentHead.publication };
      }
      if (currentHead?.generation === MAX_SCENE_GENERATION_V1) {
        throw new RangeError("The snapshot Scene generation cannot be incremented.");
      }
      const nextGeneration = currentHead ? currentHead.generation + 1n : 1n;
      const inserted = await client.query<PublicationRow>(
        `WITH inserted AS (
           INSERT INTO public.snapshot_publications
             (tenant_id, publication_id, project_id, source_path, scene_name, generation,
              source_generation, source_digest, runtime_config_hash, profile_digest, result_digest,
              runtime_digest, snapshot_hash, request_id)
           VALUES ($1, $6::uuid, $2, $3, $4, $7::bigint, $8::bigint, $9, $10, $11, $12, $5, $13, $14)
           RETURNING *
         )
         SELECT
           p.tenant_id,
           p.publication_id::text AS publication_id,
           p.project_id,
           p.source_path,
           p.scene_name,
           p.generation::text AS publication_generation,
           p.source_generation::text AS source_generation,
           p.source_digest AS publication_source_digest,
           p.runtime_config_hash AS publication_runtime_config_hash,
           p.profile_digest AS publication_profile_digest,
           p.runtime_digest AS publication_runtime_digest,
           p.result_digest AS publication_result_digest,
           p.snapshot_hash,
           p.request_id,
           p.published_at,
           ${ARTIFACT_COLUMNS}
           FROM inserted p
           JOIN public.snapshot_artifact_objects a
             ON a.tenant_id = p.tenant_id
            AND a.result_digest = p.result_digest
            AND a.runtime_digest = p.runtime_digest`,
        [
          identity.tenantId,
          identity.projectId,
          identity.sourcePath,
          identity.sceneName,
          identity.runtimeDigest,
          publicationId,
          nextGeneration.toString(),
          expectedSourceGeneration.toString(),
          expectedSourceDigest,
          artifactIdentity(storedArtifact).runtimeConfigHash,
          artifactIdentity(storedArtifact).profileDigest,
          artifactIdentity(storedArtifact).resultDigest,
          snapshotHash,
          requestId,
        ],
      );
      if (inserted.rows.length !== 1)
        throw new TypeError("PostgreSQL did not return the inserted snapshot publication.");
      const publication = publicationFromRow(inserted.rows[0]!);

      if (currentHead) {
        const updated = await client.query(
          `UPDATE public.snapshot_scene_heads
              SET generation = $5::bigint, publication_id = $6::uuid, updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND project_id = $2 AND source_path = $3 AND scene_name = $4
              AND runtime_digest = $7
              AND generation = $8::bigint
              AND publication_id IS NOT DISTINCT FROM $9::uuid`,
          [
            identity.tenantId,
            identity.projectId,
            identity.sourcePath,
            identity.sceneName,
            nextGeneration.toString(),
            publicationId,
            identity.runtimeDigest,
            currentHead.generation.toString(),
            currentHead.publication?.publicationId ?? null,
          ],
        );
        if (updated.rowCount !== 1) throw new Error("The locked snapshot Scene head changed unexpectedly.");
      } else {
        await client.query(
          `INSERT INTO public.snapshot_scene_heads
             (tenant_id, project_id, source_path, scene_name, runtime_digest, generation, publication_id)
           VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::uuid)`,
          [
            identity.tenantId,
            identity.projectId,
            identity.sourcePath,
            identity.sceneName,
            identity.runtimeDigest,
            nextGeneration.toString(),
            publicationId,
          ],
        );
      }
      if (currentHead?.publication) {
        await client.query(
          `DELETE FROM public.workspace_project_references
            WHERE tenant_id = $1 AND project_id = $2
              AND reference_kind = 'snapshot-publication' AND reference_id = $3`,
          [identity.tenantId, identity.projectId, currentHead.publication.publicationId],
        );
      }
      await client.query(
        `INSERT INTO public.workspace_project_references
           (tenant_id, project_id, reference_kind, reference_id)
         VALUES ($1, $2, 'snapshot-publication', $3)`,
        [identity.tenantId, identity.projectId, publicationId],
      );
      return { kind: "published" as const, publication };
    }, signal);
  }

  async readCurrent(identityValue: SnapshotPublicationIdentityV1, signal?: AbortSignal) {
    const identity = publicationIdentity(identityValue);
    return this.#connection.transaction(async (client) => {
      const source = await this.#currentSource(client, identity);
      const head = await this.#sceneHead(client, identity);
      if (!head) return { kind: "missing" as const };
      const publication = head.publication;
      if (!publication) return { generation: head.generation, kind: "stale" as const };
      if (
        !source ||
        source.generation !== publication.sourceGeneration ||
        source.digest !== artifactIdentity(publication.artifact).sourceDigest
      ) {
        await this.#tombstone(client, identity, head.generation, publication.publicationId);
        return { generation: head.generation, kind: "stale" as const };
      }
      return { kind: "published" as const, publication };
    }, signal);
  }

  async confirmCurrent(publicationValue: SnapshotPublicationV1, signal?: AbortSignal) {
    const expected = checkedPublication(publicationValue);
    return this.#connection.transaction(async (client) => {
      const source = await this.#currentSource(client, expected);
      const head = await this.#sceneHead(client, expected);
      if (!source || !head?.publication) return false;
      return (
        source.generation === expected.sourceGeneration &&
        source.digest === artifactIdentity(expected.artifact).sourceDigest &&
        head.generation === expected.generation &&
        exactPublication(head.publication, expected)
      );
    }, signal);
  }

  async clearHeadIfGeneration(
    identityValue: SnapshotPublicationIdentityV1,
    generationValue: bigint,
    signal?: AbortSignal,
  ) {
    const identity = publicationIdentity(identityValue);
    const expectedGeneration = generation(generationValue, "Snapshot generation", MAX_SCENE_GENERATION_V1);
    return this.#connection.transaction(async (client) => {
      const head = await this.#sceneHead(client, identity);
      if (!head?.publication || head.generation !== expectedGeneration) return false;
      return this.#tombstone(client, identity, expectedGeneration, head.publication.publicationId);
    }, signal);
  }

  async softDeleteProject(tenantValue: string, projectValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const project = projectId(projectValue);
    await this.#connection.transaction(async (client) => {
      const locked = await client.query<{ project_id: string }>(
        `SELECT project_id
           FROM public.workspace_projects
          WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [tenant, project],
      );
      if (locked.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate workspace projects.");
      if (locked.rows.length === 0) throw new HttpError("Configured Manim project not found.", 404);
      if (locked.rows[0]?.project_id !== project) {
        throw new TypeError("PostgreSQL returned a workspace project with another identity.");
      }
      const retained = await client.query(
        `SELECT 1
           FROM public.workspace_project_references
          WHERE tenant_id = $1 AND project_id = $2
            AND reference_kind <> 'snapshot-publication'
          LIMIT 1`,
        [tenant, project],
      );
      if (retained.rows.length !== 0) {
        throw new HttpError("Wait for active workspace work before removing it from Studio.", 409);
      }
      await client.query(
        `UPDATE public.snapshot_scene_heads
            SET publication_id = NULL, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND project_id = $2 AND publication_id IS NOT NULL`,
        [tenant, project],
      );
      await client.query(
        `DELETE FROM public.workspace_project_references
          WHERE tenant_id = $1 AND project_id = $2
            AND reference_kind = 'snapshot-publication'`,
        [tenant, project],
      );
      await detachProjectPngHeadInTransactionV1(client, {
        projectId: project,
        tenantId: tenant,
      });
      const deleted = await client.query(
        `UPDATE public.workspace_projects
            SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [tenant, project],
      );
      if (deleted.rowCount !== 1) throw new Error("The locked workspace project changed unexpectedly.");
    }, signal);
  }

  async isArtifactPublished(tenantValue: string, artifactValue: SnapshotArtifactReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const artifact = artifactReceipt(tenant, artifactValue);
    return this.#connection.withClient(async (client) => {
      throwIfAborted(signal);
      const current = await this.#isCurrentArtifact(client, tenant, artifact);
      throwIfAborted(signal);
      return current;
    }, signal);
  }

  async queueArtifactDeletion(tenantValue: string, artifactValue: SnapshotArtifactReceiptV1, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const artifact = artifactReceipt(tenant, artifactValue);
    const values = artifactValues(tenant, artifact);
    return this.#connection.transaction(async (client) => {
      await this.#lockArtifact(client, tenant, artifact);
      const stored = await this.#storedArtifact(client, tenant, artifact);
      const queued = await client.query<DeletionRow>(
        `SELECT d.deletion_id::text AS deletion_id, d.deleted_at, ${artifactColumns("d")}
           FROM public.snapshot_artifact_deletions d
          WHERE d.tenant_id = $1
            AND d.object_key = $2
            AND d.version_id IS NOT DISTINCT FROM $3
            AND d.object_generation IS NOT DISTINCT FROM $4::uuid
          FOR UPDATE`,
        [tenant, values[6], values[7], values[8]],
      );
      if (queued.rows.length > 1) {
        throw new TypeError("The queued snapshot artifact deletion conflicts with its immutable identity.");
      }
      const existing = queued.rows[0] ? deletionFromRow(queued.rows[0], tenant) : null;
      if (existing && !exactArtifact(existing.artifact, artifact)) {
        throw new TypeError("The queued snapshot artifact deletion conflicts with its immutable identity.");
      }
      if (await this.#isCurrentArtifact(client, tenant, artifact)) return null;
      if (queued.rows[0]) return queued.rows[0].deleted_at === null ? existing : null;

      if (stored && exactArtifact(stored, artifact)) {
        await client.query(
          `UPDATE public.snapshot_scene_heads h
            SET publication_id = NULL, updated_at = clock_timestamp()
           FROM public.snapshot_publications p
          WHERE h.tenant_id = p.tenant_id
            AND h.project_id = p.project_id
            AND h.source_path = p.source_path
            AND h.scene_name = p.scene_name
            AND h.generation = p.generation
            AND h.publication_id = p.publication_id
            AND h.runtime_digest = p.runtime_digest
            AND p.tenant_id = $1
            AND p.result_digest = $2
            AND p.source_digest = $3
            AND p.runtime_config_hash = $4
            AND p.profile_digest = $5
            AND p.runtime_digest = $6`,
          values.slice(0, 6),
        );
        await client.query(
          `DELETE FROM public.workspace_project_references reference
          USING public.snapshot_publications p
          WHERE reference.tenant_id = p.tenant_id
            AND reference.project_id = p.project_id
            AND reference.reference_kind = 'snapshot-publication'
            AND reference.reference_id = p.publication_id::text
            AND p.tenant_id = $1
            AND p.result_digest = $2
            AND p.source_digest = $3
            AND p.runtime_config_hash = $4
            AND p.profile_digest = $5
            AND p.runtime_digest = $6`,
          values.slice(0, 6),
        );
        await client.query(
          `DELETE FROM public.snapshot_publications
          WHERE tenant_id = $1
            AND result_digest = $2
            AND source_digest = $3
            AND runtime_config_hash = $4
            AND profile_digest = $5
            AND runtime_digest = $6`,
          values.slice(0, 6),
        );
        const removed = await client.query(
          `DELETE FROM public.snapshot_artifact_objects
          WHERE tenant_id = $1
            AND result_digest = $2
            AND source_digest = $3
            AND runtime_config_hash = $4
            AND profile_digest = $5
            AND runtime_digest = $6
            AND object_key = $7
            AND version_id IS NOT DISTINCT FROM $8
            AND object_generation IS NOT DISTINCT FROM $9::uuid
            AND etag = $10
            AND byte_size = $11`,
          values,
        );
        if (removed.rowCount !== 1) {
          throw new Error("The locked snapshot artifact metadata changed unexpectedly.");
        }
      }

      const deletionId = randomUUID();
      const inserted = await client.query<DeletionRow>(
        `INSERT INTO public.snapshot_artifact_deletions
           (deletion_id, tenant_id, result_digest, source_digest, runtime_config_hash,
            profile_digest, runtime_digest, object_key, version_id, object_generation, etag, byte_size)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12)
         ON CONFLICT DO NOTHING
         RETURNING deletion_id::text AS deletion_id, deleted_at, ${artifactColumns("snapshot_artifact_deletions")}`,
        [deletionId, ...values],
      );
      if (inserted.rows.length !== 1) {
        throw new TypeError("PostgreSQL did not return the queued snapshot artifact deletion.");
      }
      const deletion = deletionFromRow(inserted.rows[0]!, tenant);
      if (!exactArtifact(deletion.artifact, artifact)) {
        throw new TypeError("The queued snapshot artifact deletion conflicts with its immutable identity.");
      }
      return inserted.rows[0]!.deleted_at === null ? deletion : null;
    }, signal);
  }

  async pendingArtifactDeletions(tenantValue: string, maximumValue: number, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const maximum = boundedPositiveInteger(maximumValue, "maximum", 256);
    const result = await this.#connection.query<DeletionRow>(
      `SELECT d.deletion_id::text AS deletion_id, d.deleted_at, ${artifactColumns("d")}
         FROM public.snapshot_artifact_deletions d
        WHERE d.tenant_id = $1 AND d.deleted_at IS NULL
        ORDER BY d.queued_at, d.deletion_id
        LIMIT $2`,
      [tenant, maximum],
      signal,
    );
    return result.rows.map((row) => {
      if (row.deleted_at !== null) throw new TypeError("PostgreSQL returned an acknowledged artifact deletion.");
      return deletionFromRow(row, tenant);
    });
  }

  async acknowledgeArtifactDeletion(tenantValue: string, deletionIdValue: string, signal?: AbortSignal) {
    const tenant = tenantId(tenantValue);
    const deletionId = uuid(deletionIdValue, "Snapshot artifact deletion ID");
    await this.#connection.query(
      `UPDATE public.snapshot_artifact_deletions
          SET deleted_at = COALESCE(deleted_at, clock_timestamp())
        WHERE tenant_id = $1 AND deletion_id = $2::uuid`,
      [tenant, deletionId],
      signal,
    );
  }

  async close() {
    await this.#connection.close();
  }
}
