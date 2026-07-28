import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresProjectPngRepositoryV1 } from "./postgres/postgres-project-png-repository";
import { PostgresRenderSessionRepositoryV1 } from "./postgres/postgres-render-session-repository";
import { PostgresWorkspaceSourceRepositoryV1 } from "./postgres/postgres-workspace-source-repository";
import { runProjectPngGcV1 } from "./project-png-gc";
import { S3ContentBlobStoreV1 } from "./s3/s3-content-blob-store";
import { S3ProjectPngStoreV1 } from "./s3/s3-project-png-store";

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
  it("replaces atomically, pins render generations, isolates tenants, and collects an upload orphan", async () => {
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
    const pngRepository = new PostgresProjectPngRepositoryV1({ poolConfig });
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
    try {
      await sourceRepository.ensureTenant(tenant);
      const source = "from manim import *\n\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(1)\n";
      const sourceBlob = await sourceStore.putSource(tenant, source);
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

      const session = await renderRepository.createSession({
        commitCorrelationKey: "png-pin-proof",
        executionTimeoutMs: 30_000,
        id: randomUUID(),
        originalHead: sourceHead,
        patch: { anchorLine: 1, anchorLines: [1], insertedCode: "" },
        patchedBlob: sourceBlob,
        programBatchId: "batch-a",
        programTransactionId: "transaction-a",
        renderRequestId: "request-a",
        sceneName: "MainScene",
        tenantId: tenant,
      });
      expect(session.projectPng).toEqual(firstHead);

      const secondReceipt = await pngStore.put(tenant, project, png(32));
      const secondHead = await pngRepository.compareAndSwapHead({
        candidate: secondReceipt,
        expected: { digest: firstHead.receipt.digest, generation: firstHead.generation },
        projectId: project,
        tenantId: tenant,
      });
      expect(secondHead.generation).toBe(2n);
      expect((await renderRepository.readSession(tenant, session.id)).projectPng).toEqual(firstHead);
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
        maximum: 32,
        repository: pngRepository,
        store: pngStore,
        tenantId: tenant,
      });
      expect(gc).toMatchObject({ deleted: 1, queued: 1 });
      await expect(pngStore.read(tenant, project, orphan)).rejects.toThrow();
      await expect(pngStore.read(tenant, project, firstReceipt)).resolves.toEqual(Uint8Array.from(png(16)));
      await expect(pngStore.read(tenant, project, secondReceipt)).resolves.toEqual(Uint8Array.from(png(32)));

      await expect(pngRepository.readHead("tenant-b", project)).resolves.toBeNull();
      await expect(pngStore.read("tenant-b", project, firstReceipt)).rejects.toThrow(/receipt/i);
      await expect(pngStore.read(tenant, project, { ...firstReceipt, versionId: "wrong-version" })).rejects.toThrow();
      await expect(pngStore.read(tenant, project, { ...firstReceipt, digest: "f".repeat(64) })).rejects.toThrow(
        /receipt/i,
      );
    } finally {
      await Promise.all([
        sourceRepository.close(),
        renderRepository.close(),
        pngRepository.close(),
        sourceStore.close(),
        pngStore.close(),
      ]);
    }
  }, 60_000);
});
