import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  mutateRenderSessionWithUsageFixtureV1,
  seedActiveRenderEntitlementFixtureV1,
} from "./billing-entitlement-real-test-fixture";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresProjectPngRepositoryV1 } from "./postgres/postgres-project-png-repository";
import { PostgresRenderSessionRepositoryV1 } from "./postgres/postgres-render-session-repository";
import { PostgresWorkspaceSourceRepositoryV1 } from "./postgres/postgres-workspace-source-repository";
import { runProjectPngGcV1 } from "./project-png-gc";
import { S3ContentBlobStoreV1 } from "./s3/s3-content-blob-store";
import { S3ProjectPngStoreV1 } from "./s3/s3-project-png-store";
import { runSourceBlobGcV1 } from "./source-blob-gc";

const E2E_CONFIGURED = [
  "POIETRA_STORAGE_E2E_DATABASE_URL",
  "POIETRA_STORAGE_E2E_S3_ENDPOINT",
  "POIETRA_STORAGE_E2E_S3_BUCKET",
  "POIETRA_STORAGE_E2E_S3_ACCESS_KEY",
  "POIETRA_STORAGE_E2E_S3_SECRET_KEY",
].every((key) => Boolean(process.env[key]));

function environment() {
  if (!E2E_CONFIGURED) throw new Error("The durable storage E2E environment is incomplete.");
  return {
    accessKeyId: process.env.POIETRA_STORAGE_E2E_S3_ACCESS_KEY!,
    bucket: process.env.POIETRA_STORAGE_E2E_S3_BUCKET!,
    databaseUrl: process.env.POIETRA_STORAGE_E2E_DATABASE_URL!,
    endpoint: process.env.POIETRA_STORAGE_E2E_S3_ENDPOINT!,
    secretAccessKey: process.env.POIETRA_STORAGE_E2E_S3_SECRET_KEY!,
  };
}

function s3Config(config: ReturnType<typeof environment>) {
  return {
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    endpoint: config.endpoint,
    forcePathStyle: true,
    region: "us-east-1",
  } as const;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data = new Uint8Array()) {
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  result.write(type, 4, 4, "ascii");
  result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return result;
}

function png(red: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, red, 0, 0, 255]))),
    chunk("IEND"),
  ]);
}

describe.skipIf(!E2E_CONFIGURED)("PostgreSQL + MinIO project image.png storage", () => {
  it("replaces atomically across ABA reuse, pins render generations, isolates tenants, and collects orphans", async () => {
    const config = environment();
    const setupPool = new Pool({ connectionString: config.databaseUrl, max: 2 });
    const setupS3 = new S3Client(s3Config(config));
    try {
      await applyBundledDurableStorageMigrations(setupPool);
      await setupS3.send(new CreateBucketCommand({ Bucket: config.bucket }));
      await setupS3.send(
        new PutBucketVersioningCommand({
          Bucket: config.bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
    } finally {
      setupS3.destroy();
      await setupPool.end();
    }

    const poolConfig = { connectionString: config.databaseUrl, max: 3 };
    const sourceRepository = new PostgresWorkspaceSourceRepositoryV1({ poolConfig });
    const renderRepository = new PostgresRenderSessionRepositoryV1({ poolConfig });
    const retentionPeer = new PostgresRenderSessionRepositoryV1({ poolConfig });
    const pngRepository = new PostgresProjectPngRepositoryV1({ poolConfig });
    const inspectionPool = new Pool(poolConfig);
    const sourceStore = new S3ContentBlobStoreV1({
      bucket: config.bucket,
      clientConfig: s3Config(config),
      deployment: "test",
    });
    const pngStore = new S3ProjectPngStoreV1({
      bucket: config.bucket,
      clientConfig: s3Config(config),
      deployment: "test",
    });
    const tenant = "tenant-a";
    const project = "project-a";
    let initialRepositoriesClosed = false;
    let reopenedSourceRepository: PostgresWorkspaceSourceRepositoryV1 | null = null;
    let reopenedRenderRepository: PostgresRenderSessionRepositoryV1 | null = null;
    let reopenedPngRepository: PostgresProjectPngRepositoryV1 | null = null;
    try {
      await sourceRepository.ensureTenant(tenant);
      await seedActiveRenderEntitlementFixtureV1(inspectionPool, tenant);
      const source = "from manim import *\n\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(1)\n";
      const sourceBlob = await sourceStore.putSource(tenant, source);
      const livePatchedBlob = await sourceStore.putSource(tenant, `${source}\n# retained by a live session\n`);
      const terminalPatchedBlob = await sourceStore.putSource(tenant, `${source}\n# terminal-only input\n`);
      const committedPatchedBlob = await sourceStore.putSource(
        tenant,
        `${source}\n# retained by a committed session\n`,
      );
      await sourceRepository.createManagedProject({
        name: "PNG pin proof",
        projectId: project,
        source: { blob: sourceBlob, path: "main.py" },
        tenantId: tenant,
      });
      const sourceHead = await sourceRepository.readSourceHead(tenant, project, "main.py");

      const firstReceipt = await pngStore.put(tenant, project, png(16));
      const firstHead = await pngRepository.compareAndSwapHead({
        candidate: firstReceipt,
        expected: null,
        projectId: project,
        tenantId: tenant,
      });
      expect(firstHead.generation).toBe(1n);

      const liveSession = await renderRepository.createSession({
        commitCorrelationKey: "png-live-pin-proof",
        executionTimeoutMs: 30_000,
        id: randomUUID(),
        originalHead: sourceHead,
        patch: { anchorLine: 1, anchorLines: [1], insertedCode: "" },
        patchedBlob: livePatchedBlob,
        programBatchId: "batch-live",
        programTransactionId: "transaction-live",
        renderRequestId: "request-live",
        sceneName: "MainScene",
        tenantId: tenant,
      });
      expect(liveSession.projectPng).toEqual(firstHead);

      const secondReceipt = await pngStore.put(tenant, project, png(32));
      const secondHead = await pngRepository.compareAndSwapHead({
        candidate: secondReceipt,
        expected: { digest: firstHead.receipt.digest, generation: firstHead.generation },
        projectId: project,
        tenantId: tenant,
      });
      expect(secondHead.generation).toBe(2n);
      expect((await renderRepository.readSession(tenant, liveSession.id)).projectPng).toEqual(firstHead);
      await expect(
        pngRepository.compareAndSwapHead({
          candidate: firstReceipt,
          expected: { digest: firstHead.receipt.digest, generation: firstHead.generation },
          projectId: project,
          tenantId: tenant,
        }),
      ).rejects.toMatchObject({ status: 409 });

      const orphan = await pngStore.put(tenant, project, png(48));
      await expect(
        pngRepository.compareAndSwapHead({
          candidate: orphan,
          expected: { digest: firstHead.receipt.digest, generation: firstHead.generation },
          projectId: project,
          tenantId: tenant,
        }),
      ).rejects.toMatchObject({ status: 409 });
      const gc = await runProjectPngGcV1({
        cutoff: new Date(Date.now() + 2_000),
        graceMs: 60_000,
        maximum: 32,
        repository: pngRepository,
        store: pngStore,
        tenantId: tenant,
      });
      expect(gc).toMatchObject({ deleted: 1, queued: 1 });
      await expect(pngStore.read(tenant, project, orphan)).rejects.toThrow();
      await expect(pngStore.read(tenant, project, firstReceipt)).resolves.toEqual(Uint8Array.from(png(16)));
      await expect(pngStore.read(tenant, project, secondReceipt)).resolves.toEqual(Uint8Array.from(png(32)));

      const terminalSession = await renderRepository.createSession({
        commitCorrelationKey: "png-terminal-pin-proof",
        executionTimeoutMs: 30_000,
        id: randomUUID(),
        originalHead: sourceHead,
        patch: { anchorLine: 1, anchorLines: [1], insertedCode: "" },
        patchedBlob: terminalPatchedBlob,
        programBatchId: "batch-terminal",
        programTransactionId: "transaction-terminal",
        renderRequestId: "request-terminal",
        sceneName: "MainScene",
        tenantId: tenant,
      });
      expect(terminalSession.projectPng).toEqual(secondHead);
      await renderRepository.cancelSession(tenant, terminalSession.id);

      const reusedFirstReceipt = await pngStore.put(tenant, project, png(16));
      expect(reusedFirstReceipt).toEqual(firstReceipt);
      const restoredHead = await pngRepository.compareAndSwapHead({
        candidate: reusedFirstReceipt,
        expected: { digest: secondHead.receipt.digest, generation: secondHead.generation },
        projectId: project,
        tenantId: tenant,
      });
      expect(restoredHead).toEqual({ ...firstHead, generation: 3n });
      expect((await renderRepository.readSession(tenant, liveSession.id)).projectPng).toEqual(firstHead);

      const committedSession = await renderRepository.createSession({
        commitCorrelationKey: "png-committed-pin-proof",
        executionTimeoutMs: 30_000,
        id: randomUUID(),
        originalHead: sourceHead,
        patch: { anchorLine: 1, anchorLines: [1], insertedCode: "" },
        patchedBlob: committedPatchedBlob,
        programBatchId: "batch-committed",
        programTransactionId: "transaction-committed",
        renderRequestId: "request-committed",
        sceneName: "MainScene",
        tenantId: tenant,
      });
      expect(committedSession.projectPng).toEqual(restoredHead);
      await inspectionPool.query(
        `UPDATE public.render_sessions
            SET execution_deadline = clock_timestamp() - interval '2 hours',
                updated_at = clock_timestamp() - interval '2 hours'
          WHERE tenant_id = $1 AND session_id = ANY($2::uuid[])`,
        [tenant, [liveSession.id, terminalSession.id, committedSession.id]],
      );
      await mutateRenderSessionWithUsageFixtureV1(inspectionPool, {
        mutate: (client) =>
          client.query(
            `UPDATE public.render_sessions
                SET status = 'committed'
              WHERE tenant_id = $1 AND session_id = $2::uuid`,
            [tenant, committedSession.id],
          ),
        sessionId: committedSession.id,
        target: "committed",
        tenantId: tenant,
      });
      await expect(
        inspectionPool.query<{ outcome: string; state: string }>(
          `SELECT reservation.state, event.outcome
             FROM public.usage_reservations reservation
             JOIN public.usage_events event
               ON event.tenant_id = reservation.tenant_id
              AND event.operation_kind = reservation.operation_kind
              AND event.operation_id = reservation.operation_id
            WHERE reservation.tenant_id = $1 AND reservation.operation_id = $2::uuid`,
          [tenant, committedSession.id],
        ),
      ).resolves.toMatchObject({ rows: [{ outcome: "committed", state: "committed" }] });

      const replacementGc = await runProjectPngGcV1({
        cutoff: new Date(Date.now() + 2_000),
        graceMs: 60_000,
        maximum: 32,
        repository: pngRepository,
        store: pngStore,
        tenantId: tenant,
      });
      expect(replacementGc).toMatchObject({ deleted: 0, queued: 0 });
      await expect(pngStore.read(tenant, project, firstReceipt)).resolves.toEqual(Uint8Array.from(png(16)));
      await expect(pngStore.read(tenant, project, secondReceipt)).resolves.toEqual(Uint8Array.from(png(32)));

      const releases = await Promise.all([
        renderRepository.releaseExpiredInputs({ maximum: 1, retentionMs: 60_000, tenantId: tenant }),
        retentionPeer.releaseExpiredInputs({ maximum: 1, retentionMs: 60_000, tenantId: tenant }),
      ]);
      expect(releases.flatMap(({ releasedSessionIds }) => releasedSessionIds)).toEqual([terminalSession.id]);
      expect(releases.reduce((total, result) => total + result.sourceBlobsOrphaned, 0)).toBe(1);
      expect(releases.reduce((total, result) => total + result.projectPngGenerationsOrphaned, 0)).toBe(1);
      await expect(renderRepository.readSession(tenant, terminalSession.id)).rejects.toMatchObject({ status: 404 });
      await expect(renderRepository.readSession(tenant, liveSession.id)).resolves.toMatchObject({
        status: "preparing",
      });
      await expect(renderRepository.readSession(tenant, committedSession.id)).resolves.toMatchObject({
        status: "committed",
      });

      const releasedRow = await inspectionPool.query<{
        original_digest: string | null;
        patched_digest: string | null;
        project_png_generation: string | null;
        references_released_at: Date;
      }>(
        `SELECT original_digest, patched_digest, project_png_generation::text,
                references_released_at
           FROM public.render_sessions
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenant, terminalSession.id],
      );
      expect(releasedRow.rows[0]).toMatchObject({
        original_digest: null,
        patched_digest: null,
        project_png_generation: null,
        references_released_at: expect.any(Date),
      });
      const releaseTimestamp = releasedRow.rows[0]?.references_released_at;
      if (!(releaseTimestamp instanceof Date)) throw new Error("The terminal session was not released.");
      const beforeGrace = new Date(releaseTimestamp.getTime() - 1);
      expect(
        await runSourceBlobGcV1({
          blobs: sourceStore,
          cutoff: beforeGrace,
          graceMs: 60_000,
          maximum: 32,
          repository: sourceRepository,
          tenantId: tenant,
        }),
      ).toMatchObject({ deleted: 0, queued: 0 });
      expect(
        await runProjectPngGcV1({
          cutoff: beforeGrace,
          graceMs: 60_000,
          maximum: 32,
          repository: pngRepository,
          store: pngStore,
          tenantId: tenant,
        }),
      ).toMatchObject({ deleted: 0, queued: 0 });
      await expect(sourceStore.readSource(tenant, terminalPatchedBlob)).resolves.toContain("terminal-only input");
      await expect(pngStore.read(tenant, project, secondReceipt)).resolves.toEqual(Uint8Array.from(png(32)));
      await expect(
        renderRepository.purgeReleasedSessions({ auditRetentionMs: 60_000, maximum: 32, tenantId: tenant }),
      ).resolves.toBe(0);

      await Promise.all([
        sourceRepository.close(),
        renderRepository.close(),
        retentionPeer.close(),
        pngRepository.close(),
      ]);
      initialRepositoriesClosed = true;
      reopenedSourceRepository = new PostgresWorkspaceSourceRepositoryV1({ poolConfig });
      reopenedRenderRepository = new PostgresRenderSessionRepositoryV1({ poolConfig });
      reopenedPngRepository = new PostgresProjectPngRepositoryV1({ poolConfig });

      await inspectionPool.query(
        `UPDATE public.source_blob_objects
            SET orphaned_at = clock_timestamp() - interval '2 hours'
          WHERE tenant_id = $1 AND digest = $2`,
        [tenant, terminalPatchedBlob.digest],
      );
      await inspectionPool.query(
        `UPDATE public.project_png_generations
            SET orphaned_at = clock_timestamp() - interval '2 hours'
          WHERE tenant_id = $1 AND project_id = $2 AND generation = $3::bigint`,
        [tenant, project, secondHead.generation.toString()],
      );

      const afterGrace = new Date(Date.now() + 60_000);
      const sourceMarkSweep = await runSourceBlobGcV1({
        blobs: sourceStore,
        cutoff: afterGrace,
        graceMs: 60_000,
        maximum: 32,
        repository: reopenedSourceRepository,
        tenantId: tenant,
      });
      expect(sourceMarkSweep).toMatchObject({ deleted: 0, queued: 1 });
      const sourceDeleteSweep = await runSourceBlobGcV1({
        blobs: sourceStore,
        cutoff: afterGrace,
        graceMs: 60_000,
        maximum: 32,
        repository: reopenedSourceRepository,
        tenantId: tenant,
      });
      expect(sourceDeleteSweep.deleted).toBe(1);
      const pngDeleteSweep = await runProjectPngGcV1({
        cutoff: afterGrace,
        graceMs: 60_000,
        maximum: 32,
        repository: reopenedPngRepository,
        store: pngStore,
        tenantId: tenant,
      });
      expect(pngDeleteSweep).toMatchObject({ deleted: 1, queued: 1 });

      await expect(sourceStore.readSource(tenant, terminalPatchedBlob)).rejects.toThrow();
      await expect(pngStore.read(tenant, project, secondReceipt)).rejects.toThrow();
      await expect(sourceStore.readSource(tenant, sourceBlob)).resolves.toBe(source);
      await expect(sourceStore.readSource(tenant, livePatchedBlob)).resolves.toContain("live session");
      await expect(sourceStore.readSource(tenant, committedPatchedBlob)).resolves.toContain("committed session");
      await expect(pngStore.read(tenant, project, firstReceipt)).resolves.toEqual(Uint8Array.from(png(16)));
      await expect(reopenedRenderRepository.readSession(tenant, liveSession.id)).resolves.toMatchObject({
        status: "preparing",
      });
      await expect(reopenedRenderRepository.readSession(tenant, committedSession.id)).resolves.toMatchObject({
        status: "committed",
      });

      await inspectionPool.query(
        `UPDATE public.render_sessions
            SET references_released_at = clock_timestamp() - interval '2 hours'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenant, terminalSession.id],
      );
      await expect(
        reopenedRenderRepository.purgeReleasedSessions({ auditRetentionMs: 60_000, maximum: 32, tenantId: tenant }),
      ).resolves.toBe(1);
      const purged = await inspectionPool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM public.render_sessions
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenant, terminalSession.id],
      );
      expect(purged.rows[0]?.count).toBe(0);

      const deletedProject = "project-delete-pin";
      const deletedProjectSource = `${source}\n# workspace deletion with a retained PNG pin\n`;
      const deletedProjectSourceBlob = await sourceStore.putSource(tenant, deletedProjectSource);
      const deletedProjectPatchedBlob = await sourceStore.putSource(
        tenant,
        `${deletedProjectSource}\n# abandoned render input\n`,
      );
      await reopenedSourceRepository.createManagedProject({
        name: "Deleted workspace PNG pin proof",
        projectId: deletedProject,
        source: { blob: deletedProjectSourceBlob, path: "main.py" },
        tenantId: tenant,
      });
      const deletedProjectSourceHead = await reopenedSourceRepository.readSourceHead(tenant, deletedProject, "main.py");
      const deletedProjectReceipt = await pngStore.put(tenant, deletedProject, png(64));
      const deletedProjectHead = await reopenedPngRepository.compareAndSwapHead({
        candidate: deletedProjectReceipt,
        expected: null,
        projectId: deletedProject,
        tenantId: tenant,
      });
      const deletedProjectSession = await reopenedRenderRepository.createSession({
        commitCorrelationKey: "png-deleted-workspace-pin-proof",
        executionTimeoutMs: 30_000,
        id: randomUUID(),
        originalHead: deletedProjectSourceHead,
        patch: { anchorLine: 1, anchorLines: [1], insertedCode: "" },
        patchedBlob: deletedProjectPatchedBlob,
        programBatchId: "batch-deleted-workspace",
        programTransactionId: "transaction-deleted-workspace",
        renderRequestId: "request-deleted-workspace",
        sceneName: "MainScene",
        tenantId: tenant,
      });
      expect(deletedProjectSession.projectPng).toEqual(deletedProjectHead);
      await expect(
        reopenedRenderRepository.abandonSession(tenant, deletedProjectSession.id, "request-deleted-workspace"),
      ).resolves.toBe(true);

      await reopenedSourceRepository.softDeleteProject(tenant, deletedProject);
      await expect(reopenedPngRepository.readHead(tenant, deletedProject)).resolves.toBeNull();
      const retainedAfterDelete = await inspectionPool.query<{
        head_count: number;
        orphaned_at: Date | null;
      }>(
        `SELECT
           (SELECT count(*)::integer
              FROM public.project_png_heads
             WHERE tenant_id = $1 AND project_id = $2) AS head_count,
           orphaned_at
          FROM public.project_png_generations
         WHERE tenant_id = $1 AND project_id = $2 AND generation = $3::bigint AND digest = $4`,
        [tenant, deletedProject, deletedProjectHead.generation.toString(), deletedProjectHead.receipt.digest],
      );
      expect(retainedAfterDelete.rows[0]).toEqual({ head_count: 0, orphaned_at: null });
      expect(
        await runProjectPngGcV1({
          cutoff: new Date(Date.now() + 2_000),
          graceMs: 0,
          maximum: 32,
          repository: reopenedPngRepository,
          store: pngStore,
          tenantId: tenant,
        }),
      ).toMatchObject({ deleted: 0, queued: 0 });
      await expect(pngStore.read(tenant, deletedProject, deletedProjectReceipt)).resolves.toEqual(
        Uint8Array.from(png(64)),
      );

      await inspectionPool.query(
        `UPDATE public.render_sessions
            SET updated_at = clock_timestamp() - interval '2 hours'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenant, deletedProjectSession.id],
      );
      await expect(
        reopenedRenderRepository.releaseExpiredInputs({ maximum: 1, retentionMs: 60_000, tenantId: tenant }),
      ).resolves.toEqual({
        projectPngGenerationsOrphaned: 1,
        releasedSessionIds: [deletedProjectSession.id],
        sourceBlobsOrphaned: 1,
      });
      await inspectionPool.query(
        `UPDATE public.project_png_generations
            SET orphaned_at = clock_timestamp() - interval '2 hours'
          WHERE tenant_id = $1 AND project_id = $2 AND generation = $3::bigint`,
        [tenant, deletedProject, deletedProjectHead.generation.toString()],
      );
      expect(
        await runProjectPngGcV1({
          cutoff: new Date(Date.now() + 60_000),
          graceMs: 60_000,
          maximum: 32,
          repository: reopenedPngRepository,
          store: pngStore,
          tenantId: tenant,
        }),
      ).toMatchObject({ deleted: 1, queued: 1 });
      await expect(pngStore.read(tenant, deletedProject, deletedProjectReceipt)).rejects.toThrow();

      await expect(reopenedPngRepository.readHead("tenant-b", project)).resolves.toBeNull();
      await expect(pngStore.read("tenant-b", project, firstReceipt)).rejects.toThrow(/receipt/i);
      await expect(pngStore.read(tenant, project, { ...firstReceipt, versionId: "wrong-version" })).rejects.toThrow();
      await expect(pngStore.read(tenant, project, { ...firstReceipt, digest: "f".repeat(64) })).rejects.toThrow(
        /receipt/i,
      );
    } finally {
      await Promise.all([
        ...(initialRepositoriesClosed
          ? []
          : [sourceRepository.close(), renderRepository.close(), retentionPeer.close(), pngRepository.close()]),
        ...(reopenedSourceRepository ? [reopenedSourceRepository.close()] : []),
        ...(reopenedRenderRepository ? [reopenedRenderRepository.close()] : []),
        ...(reopenedPngRepository ? [reopenedPngRepository.close()] : []),
        inspectionPool.end(),
        sourceStore.close(),
        pngStore.close(),
      ]);
    }
  }, 60_000);
});
