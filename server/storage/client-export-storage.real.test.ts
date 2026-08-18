import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { HttpError } from "../http/json";
import { type ClientExportLineageV1, ClientExportReadErrorV1 } from "./client-export-contract";
import { runClientExportGcV1 } from "./client-export-gc";
import type { ClientExportPublicationMeteringV1, SettleClientExportPublicationInputV1 } from "./client-export-metering";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresClientExportRepositoryV1 } from "./postgres/postgres-client-export-repository";
import { S3ClientExportArtifactStoreV1 } from "./s3/s3-client-export-artifact-store";

const E2E_CONFIGURED = [
  "POIETRA_STORAGE_E2E_DATABASE_URL",
  "POIETRA_STORAGE_E2E_S3_ENDPOINT",
  "POIETRA_STORAGE_E2E_S3_BUCKET",
  "POIETRA_STORAGE_E2E_S3_ACCESS_KEY",
  "POIETRA_STORAGE_E2E_S3_SECRET_KEY",
].every((key) => Boolean(process.env[key]));

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "10000000-0000-4000-8000-000000000002";
const PROJECT = "project-exports";
const DOCUMENT_KEY_A = "a1".repeat(32);
const DOCUMENT_KEY_FRESH = "b2".repeat(32);
const DOCUMENT_KEY_B = "c3".repeat(32);
const EPOCH_A = "20000000-0000-4000-8000-000000000001";
const EPOCH_FRESH = "20000000-0000-4000-8000-000000000002";
const EPOCH_B = "20000000-0000-4000-8000-000000000003";

function storageEnvironment() {
  if (!E2E_CONFIGURED) throw new Error("The client export storage E2E environment is incomplete.");
  return {
    accessKeyId: process.env.POIETRA_STORAGE_E2E_S3_ACCESS_KEY!,
    bucket: process.env.POIETRA_STORAGE_E2E_S3_BUCKET!,
    databaseUrl: process.env.POIETRA_STORAGE_E2E_DATABASE_URL!,
    endpoint: process.env.POIETRA_STORAGE_E2E_S3_ENDPOINT!,
    secretAccessKey: process.env.POIETRA_STORAGE_E2E_S3_SECRET_KEY!,
  } as const;
}

function s3Config(environment: ReturnType<typeof storageEnvironment>) {
  return {
    credentials: {
      accessKeyId: environment.accessKeyId,
      secretAccessKey: environment.secretAccessKey,
    },
    endpoint: environment.endpoint,
    forcePathStyle: true,
    region: "us-east-1",
  } as const;
}

async function ensureBucket(environment: ReturnType<typeof storageEnvironment>) {
  const s3 = new S3Client(s3Config(environment));
  try {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: environment.bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: environment.bucket }));
    }
  } finally {
    s3.destroy();
  }
}

async function prepareStorage(pool: Pool) {
  await applyBundledDurableStorageMigrations(pool);
  const client = await pool.connect();
  try {
    await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1), ($2) ON CONFLICT DO NOTHING", [
      TENANT_A,
      TENANT_B,
    ]);
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, 'https://identity.example/', 'export-a', 'Export A'),
              ($2::uuid, 'https://identity.example/', 'export-b', 'Export B')
       ON CONFLICT DO NOTHING`,
      [USER_A, USER_B],
    );
    await client.query(
      `INSERT INTO public.organizations (tenant_id, display_name)
       VALUES ($1, 'Export tenant A'), ($2, 'Export tenant B')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TENANT_B],
    );
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $2::uuid, 'owner'), ($3, $4::uuid, 'owner')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, USER_A, TENANT_B, USER_B],
    );
    await client.query(
      `INSERT INTO public.workspace_projects (tenant_id, project_id, display_name)
       VALUES ($1, $3, 'Export project A'), ($2, $3, 'Export project B')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TENANT_B, PROJECT],
    );
    await client.query(
      `INSERT INTO public.editor_documents
         (tenant_id, project_id, document_key, epoch, origin, source_path, source_hash, revision)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, 'studio-native', NULL, NULL, 0),
              ($1, $2, decode($5, 'hex'), $6::uuid, 'studio-native', NULL, NULL, 0)
       ON CONFLICT DO NOTHING`,
      [TENANT_A, PROJECT, DOCUMENT_KEY_A, EPOCH_A, DOCUMENT_KEY_FRESH, EPOCH_FRESH],
    );
    await client.query(
      `INSERT INTO public.editor_documents
         (tenant_id, project_id, document_key, epoch, origin, source_path, source_hash, revision)
       VALUES ($1, $2, decode($3, 'hex'), $4::uuid, 'studio-native', NULL, NULL, 0)
       ON CONFLICT DO NOTHING`,
      [TENANT_B, PROJECT, DOCUMENT_KEY_B, EPOCH_B],
    );
  } finally {
    client.release();
  }
}

function countingMetering() {
  const settlements: SettleClientExportPublicationInputV1[] = [];
  const metering: ClientExportPublicationMeteringV1 = {
    releasePublication: async () => undefined,
    reservePublication: async () => ({ kind: "reserved", replayed: false }) as const,
    settlePublicationWithClient: async (_client, input) => {
      settlements.push(input);
      return { kind: "settled", replayed: false } as const;
    },
  };
  return { metering, settlements };
}

function video(seed: number) {
  const bytes = new Uint8Array(64);
  bytes.set([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
  bytes[63] = seed;
  return { bytes, contentDigest: createHash("sha256").update(bytes).digest("hex") };
}

function lineage(overrides: Partial<ClientExportLineageV1> = {}): ClientExportLineageV1 {
  return {
    documentEpoch: EPOCH_A,
    documentKey: DOCUMENT_KEY_A,
    documentRevision: 0n,
    encoderEvidence: { codec: "h264-mp4", version: 1 },
    encoderEvidenceVersion: 1,
    exportProfileHash: "d".repeat(64),
    producerKind: "browser-webcodecs",
    sceneContractVersion: 1,
    sceneRevisionHash: "e".repeat(64),
    ...overrides,
  };
}

describe.skipIf(!E2E_CONFIGURED)("durable client export publication storage", () => {
  it("accepts, replays, refuses, and isolates client export publications atomically", async () => {
    const environment = storageEnvironment();
    await ensureBucket(environment);
    const pool = new Pool({ connectionString: environment.databaseUrl, max: 4 });
    const { metering, settlements } = countingMetering();
    const repository = new PostgresClientExportRepositoryV1({
      metering,
      poolConfig: { connectionString: environment.databaseUrl, max: 2 },
    });
    const store = new S3ClientExportArtifactStoreV1({
      bucket: environment.bucket,
      clientConfig: s3Config(environment),
      deployment: "test",
    });
    try {
      await prepareStorage(pool);
      expect(await repository.ready()).toBe(true);
      expect(await store.ready()).toBe(true);

      // Fresh acceptance: verify, stage, lock the document row, and insert
      // artifact + publication + settlement atomically.
      const uploaded = video(1);
      const receipt = await store.put(TENANT_A, {
        byteSize: uploaded.bytes.byteLength,
        bytes: uploaded.bytes,
        contentDigest: uploaded.contentDigest,
      });
      const publicationId = randomUUID();
      const accepted = await repository.acceptPublication({
        artifactId: randomUUID(),
        createdBySubjectId: USER_A,
        expirationMs: 60_000,
        lineage: lineage(),
        projectId: PROJECT,
        publicationId,
        receipt,
        tenantId: TENANT_A,
      });
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") return;
      expect(accepted.replayed).toBe(false);
      expect(accepted.publication.lineage.documentRevision).toBe(0n);
      expect(settlements).toEqual([
        { byteSize: uploaded.bytes.byteLength, operationId: publicationId, target: "committed", tenantId: TENANT_A },
      ]);

      // A byte-identical retry re-uploads under a fresh locator and replays:
      // the stored publication returns unchanged and the metering port is
      // never settled a second time.
      const retryReceipt = await store.put(TENANT_A, {
        byteSize: uploaded.bytes.byteLength,
        bytes: uploaded.bytes,
        contentDigest: uploaded.contentDigest,
      });
      expect(retryReceipt.objectLocatorToken).not.toBe(receipt.objectLocatorToken);
      const replayed = await repository.acceptPublication({
        artifactId: randomUUID(),
        createdBySubjectId: USER_A,
        expirationMs: 60_000,
        lineage: lineage(),
        projectId: PROJECT,
        publicationId,
        receipt: retryReceipt,
        tenantId: TENANT_A,
      });
      expect(replayed.kind).toBe("accepted");
      if (replayed.kind !== "accepted") return;
      expect(replayed.replayed).toBe(true);
      expect(replayed.publication.artifact.receipt.objectLocatorToken).toBe(receipt.objectLocatorToken);
      expect(settlements).toHaveLength(1);

      // The same publicationId with any differing immutable field is a
      // conflict, decided before any settlement.
      const conflicting = await repository.acceptPublication({
        artifactId: randomUUID(),
        createdBySubjectId: USER_A,
        expirationMs: 60_000,
        lineage: lineage({ sceneRevisionHash: "f".repeat(64) }),
        projectId: PROJECT,
        publicationId,
        receipt: retryReceipt,
        tenantId: TENANT_A,
      });
      expect(conflicting).toEqual({ kind: "conflict", reason: "payload-mismatch" });
      expect(settlements).toHaveLength(1);

      // Revision zero is a valid untouched document state with no event row.
      const freshUpload = video(2);
      const freshReceipt = await store.put(TENANT_A, {
        byteSize: freshUpload.bytes.byteLength,
        bytes: freshUpload.bytes,
        contentDigest: freshUpload.contentDigest,
      });
      const revisionZero = await repository.acceptPublication({
        artifactId: randomUUID(),
        createdBySubjectId: USER_A,
        expirationMs: 60_000,
        lineage: lineage({ documentEpoch: EPOCH_FRESH, documentKey: DOCUMENT_KEY_FRESH, documentRevision: 0n }),
        projectId: PROJECT,
        publicationId: randomUUID(),
        receipt: freshReceipt,
        tenantId: TENANT_A,
      });
      expect(revisionZero.kind).toBe("accepted");

      // A recorded revision ahead of the locked document row is refused
      // before any settlement, as is an unknown document identity.
      const ahead = await repository.acceptPublication({
        artifactId: randomUUID(),
        createdBySubjectId: USER_A,
        expirationMs: 60_000,
        lineage: lineage({ documentRevision: 99n }),
        projectId: PROJECT,
        publicationId: randomUUID(),
        receipt: retryReceipt,
        tenantId: TENANT_A,
      });
      expect(ahead).toEqual({ kind: "refused", reason: "revision-ahead" });
      const unknownDocument = await repository.acceptPublication({
        artifactId: randomUUID(),
        createdBySubjectId: USER_A,
        expirationMs: 60_000,
        lineage: lineage({ documentEpoch: "20000000-0000-4000-8000-0000000000ff" }),
        projectId: PROJECT,
        publicationId: randomUUID(),
        receipt: retryReceipt,
        tenantId: TENANT_A,
      });
      expect(unknownDocument).toEqual({ kind: "refused", reason: "document-not-found" });
      expect(settlements).toHaveLength(2);

      // A denied settlement refuses admission inside the same transaction and
      // retains no rows.
      const denyingRepository = new PostgresClientExportRepositoryV1({
        metering: {
          releasePublication: async () => undefined,
          reservePublication: async () => ({ kind: "reserved", replayed: false }) as const,
          settlePublicationWithClient: async () => ({ kind: "denied", reason: "stock-exhausted" }) as const,
        },
        poolConfig: { connectionString: environment.databaseUrl, max: 2 },
      });
      try {
        const denied = await denyingRepository.acceptPublication({
          artifactId: randomUUID(),
          createdBySubjectId: USER_A,
          expirationMs: 60_000,
          lineage: lineage(),
          projectId: PROJECT,
          publicationId: randomUUID(),
          receipt: retryReceipt,
          tenantId: TENANT_A,
        });
        expect(denied).toEqual({ kind: "refused", reason: "quota-exhausted" });
      } finally {
        await denyingRepository.close();
      }

      // Cross-tenant isolation: tenant B can neither anchor lineage to tenant
      // A's document nor read tenant A's publication or claim its video.
      const foreign = await repository.acceptPublication({
        artifactId: randomUUID(),
        createdBySubjectId: USER_B,
        expirationMs: 60_000,
        lineage: lineage(),
        projectId: PROJECT,
        publicationId: randomUUID(),
        receipt: await store.put(TENANT_B, {
          byteSize: uploaded.bytes.byteLength,
          bytes: uploaded.bytes,
          contentDigest: uploaded.contentDigest,
        }),
        tenantId: TENANT_B,
      });
      expect(foreign).toEqual({ kind: "refused", reason: "document-not-found" });
      expect(await repository.readPublication(TENANT_B, PROJECT, publicationId)).toBeNull();
      await expect(repository.acquirePublicationVideo(TENANT_B, PROJECT, publicationId, 5_000)).rejects.toMatchObject({
        status: 404,
      });

      // The stored publication remains addressable and streams through a
      // read claim in its own tenant.
      const stored = await repository.readPublication(TENANT_A, PROJECT, publicationId);
      expect(stored?.artifact.receipt.contentDigest).toBe(uploaded.contentDigest);
      const claim = await repository.acquirePublicationVideo(TENANT_A, PROJECT, publicationId, 5_000);
      const chunks: Uint8Array[] = [];
      for await (const chunk of await store.open(TENANT_A, claim.artifact.receipt, null)) chunks.push(chunk);
      expect(Buffer.concat(chunks).equals(Buffer.from(uploaded.bytes))).toBe(true);
      await repository.releaseReadClaim(TENANT_A, claim.claimId);

      // The v31 schema enforces the ADR constraint table directly.
      const oversizedEvidence = JSON.stringify({ pad: "x".repeat(17_000) });
      await expect(
        pool.query(
          `INSERT INTO public.client_export_publications
             (tenant_id, publication_id, artifact_id, project_id, document_key, document_epoch,
              document_revision, scene_contract_version, scene_revision_hash, export_profile_hash,
              producer_kind, encoder_evidence_version, encoder_evidence, created_by_subject_id, expires_at)
           SELECT $1, $2::uuid, artifact_id, $3, decode($4, 'hex'), $5::uuid, 0, 1, $6, $6,
                  'browser-webcodecs', 1, $7::json, $8::uuid, clock_timestamp() + interval '1 hour'
             FROM public.client_export_artifacts WHERE tenant_id = $1 LIMIT 1`,
          [TENANT_A, randomUUID(), PROJECT, DOCUMENT_KEY_A, EPOCH_A, "f".repeat(64), oversizedEvidence, USER_A],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("UPDATE public.client_export_publications SET expires_at = expires_at WHERE tenant_id = $1", [
          TENANT_A,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      const artifactIds = await pool.query<{ artifact_id: string }>(
        "SELECT artifact_id::text AS artifact_id FROM public.client_export_publications WHERE tenant_id = $1 AND publication_id = $2::uuid",
        [TENANT_A, publicationId],
      );
      await expect(
        pool.query(
          `INSERT INTO public.client_export_publications
             (tenant_id, publication_id, artifact_id, project_id, document_key, document_epoch,
              document_revision, scene_contract_version, scene_revision_hash, export_profile_hash,
              producer_kind, encoder_evidence_version, encoder_evidence, created_by_subject_id, expires_at)
           VALUES ($1, $2::uuid, $3::uuid, $4, decode($5, 'hex'), $6::uuid, 0, 1, $7, $7,
                   'browser-webcodecs', 1, '{}'::json, $8::uuid, clock_timestamp() + interval '1 hour')`,
          [
            TENANT_A,
            randomUUID(),
            artifactIds.rows[0]!.artifact_id,
            PROJECT,
            DOCUMENT_KEY_A,
            EPOCH_A,
            "f".repeat(64),
            USER_A,
          ],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await Promise.allSettled([repository.close(), store.close(), pool.end()]);
    }
  }, 120_000);

  it("serializes concurrent first-use publication IDs into replay or conflict", async () => {
    const environment = storageEnvironment();
    await ensureBucket(environment);
    const pool = new Pool({ connectionString: environment.databaseUrl, max: 4 });
    const { metering, settlements } = countingMetering();
    const repository = new PostgresClientExportRepositoryV1({
      metering,
      poolConfig: { connectionString: environment.databaseUrl, max: 4 },
    });
    const store = new S3ClientExportArtifactStoreV1({
      bucket: environment.bucket,
      clientConfig: s3Config(environment),
      deployment: "test",
    });
    try {
      await prepareStorage(pool);

      const sameVideo = video(6);
      const sameReceipts = await Promise.all([
        store.put(TENANT_A, {
          byteSize: sameVideo.bytes.byteLength,
          bytes: sameVideo.bytes,
          contentDigest: sameVideo.contentDigest,
        }),
        store.put(TENANT_A, {
          byteSize: sameVideo.bytes.byteLength,
          bytes: sameVideo.bytes,
          contentDigest: sameVideo.contentDigest,
        }),
      ]);
      const replayId = randomUUID();
      const identical = await Promise.all(
        sameReceipts.map((receipt) =>
          repository.acceptPublication({
            artifactId: randomUUID(),
            createdBySubjectId: USER_A,
            expirationMs: 60_000,
            lineage: lineage(),
            projectId: PROJECT,
            publicationId: replayId,
            receipt,
            tenantId: TENANT_A,
          }),
        ),
      );
      const accepted = identical.filter((result) => result.kind === "accepted");
      expect(accepted).toHaveLength(2);
      expect(accepted.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
      expect(settlements).toHaveLength(1);

      const [leftVideo, rightVideo] = [video(7), video(8)];
      const [leftReceipt, rightReceipt] = await Promise.all([
        store.put(TENANT_A, {
          byteSize: leftVideo.bytes.byteLength,
          bytes: leftVideo.bytes,
          contentDigest: leftVideo.contentDigest,
        }),
        store.put(TENANT_A, {
          byteSize: rightVideo.bytes.byteLength,
          bytes: rightVideo.bytes,
          contentDigest: rightVideo.contentDigest,
        }),
      ]);
      const conflictId = randomUUID();
      const differing = await Promise.all([
        repository.acceptPublication({
          artifactId: randomUUID(),
          createdBySubjectId: USER_A,
          expirationMs: 60_000,
          lineage: lineage(),
          projectId: PROJECT,
          publicationId: conflictId,
          receipt: leftReceipt,
          tenantId: TENANT_A,
        }),
        repository.acceptPublication({
          artifactId: randomUUID(),
          createdBySubjectId: USER_A,
          expirationMs: 60_000,
          lineage: lineage(),
          projectId: PROJECT,
          publicationId: conflictId,
          receipt: rightReceipt,
          tenantId: TENANT_A,
        }),
      ]);
      expect(differing.map(({ kind }) => kind).sort()).toEqual(["accepted", "conflict"]);
      expect(settlements).toHaveLength(2);
    } finally {
      await Promise.allSettled([repository.close(), store.close(), pool.end()]);
    }
  }, 120_000);

  it("expires read claims, queues deletion only when unpinned, and drains tombstones", async () => {
    const environment = storageEnvironment();
    await ensureBucket(environment);
    const pool = new Pool({ connectionString: environment.databaseUrl, max: 4 });
    const { metering } = countingMetering();
    const repository = new PostgresClientExportRepositoryV1({
      metering,
      poolConfig: { connectionString: environment.databaseUrl, max: 2 },
    });
    const store = new S3ClientExportArtifactStoreV1({
      bucket: environment.bucket,
      clientConfig: s3Config(environment),
      deployment: "test",
    });
    try {
      await prepareStorage(pool);
      const deletingVideo = video(10);
      const deletingReceipt = await store.put(TENANT_A, {
        byteSize: deletingVideo.bytes.byteLength,
        bytes: deletingVideo.bytes,
        contentDigest: deletingVideo.contentDigest,
      });
      expect(await repository.queueDeletion(TENANT_A, deletingReceipt, 1)).not.toBeNull();
      await expect(
        repository.acceptPublication({
          artifactId: randomUUID(),
          createdBySubjectId: USER_A,
          expirationMs: 60_000,
          lineage: lineage(),
          projectId: PROJECT,
          publicationId: randomUUID(),
          receipt: deletingReceipt,
          tenantId: TENANT_A,
        }),
      ).resolves.toEqual({ kind: "refused", reason: "artifact-deleting" });

      const uploaded = video(9);
      const receipt = await store.put(TENANT_A, {
        byteSize: uploaded.bytes.byteLength,
        bytes: uploaded.bytes,
        contentDigest: uploaded.contentDigest,
      });
      const publicationId = randomUUID();
      const accepted = await repository.acceptPublication({
        artifactId: randomUUID(),
        createdBySubjectId: USER_A,
        expirationMs: 1_200,
        lineage: lineage(),
        projectId: PROJECT,
        publicationId,
        receipt,
        tenantId: TENANT_A,
      });
      expect(accepted.kind).toBe("accepted");

      // A live publication (and later a live claim) pins the exact receipt.
      expect(await repository.isArtifactRetained(TENANT_A, receipt)).toBe(true);
      const claim = await repository.acquirePublicationVideo(TENANT_A, PROJECT, publicationId, 1_500);
      expect(await repository.queueDeletion(TENANT_A, receipt, 1)).toBeNull();

      // After the publication and the claim both expire, the read claim is
      // refused and retention lapses.
      await delay(2_000);
      await expect(repository.acquirePublicationVideo(TENANT_A, PROJECT, publicationId, 1_500)).rejects.toMatchObject({
        status: 404,
      });
      expect(await repository.isArtifactRetained(TENANT_A, receipt)).toBe(false);
      expect(claim.claimExpiresAt.getTime()).toBeLessThan(Date.now());

      // The storage-first sweep queues one tombstone copying the exact
      // receipt, deletes only that object, and records the acknowledgement.
      const sweep = await runClientExportGcV1({
        artifacts: store,
        cutoff: new Date(Date.now() + 60_000),
        graceMs: 1,
        maximum: 16,
        repository,
        tenantId: TENANT_A,
      });
      expect(sweep.queued).toBeGreaterThanOrEqual(1);
      expect(sweep.deleted).toBeGreaterThanOrEqual(1);
      await expect(store.head(TENANT_A, receipt)).rejects.toBeInstanceOf(ClientExportReadErrorV1);
      const rows = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM public.client_export_artifacts WHERE tenant_id = $1 AND object_generation = $2::uuid) AS artifacts,
           (SELECT count(*)::int FROM public.client_export_publications WHERE tenant_id = $1 AND publication_id = $3::uuid) AS publications,
           (SELECT count(*)::int FROM public.client_export_deletions
             WHERE tenant_id = $1 AND object_generation = $2::uuid AND deleted_at IS NOT NULL) AS acknowledged`,
        [TENANT_A, receipt.objectLocatorToken, publicationId],
      );
      expect(rows.rows[0]).toEqual({ acknowledged: 1, artifacts: 0, publications: 0 });

      // Replaying the queue for an acknowledged tombstone stays terminal.
      expect(await repository.queueDeletion(TENANT_A, receipt, 1)).toBeNull();
      expect(await repository.readPublication(TENANT_A, PROJECT, publicationId)).toBeNull();
      await expect(repository.acquirePublicationVideo(TENANT_A, PROJECT, publicationId, 1_500)).rejects.toBeInstanceOf(
        HttpError,
      );
    } finally {
      await Promise.allSettled([repository.close(), store.close(), pool.end()]);
    }
  }, 120_000);
});
