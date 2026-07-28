import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { CreateBucketCommand, HeadBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createDurableManimRuntimeV1 } from "../durable-manim-runtime";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresSnapshotPublicationRepositoryV1 } from "./postgres/postgres-snapshot-publication-repository";
import { PostgresWorkspaceSourceRepositoryV1 } from "./postgres/postgres-workspace-source-repository";
import { S3ContentBlobStoreV1 } from "./s3/s3-content-blob-store";
import { S3SnapshotArtifactStoreV1 } from "./s3/s3-snapshot-artifact-store";
import { SnapshotArtifactReadErrorV1, type SnapshotPublicationIdentityV1 } from "./snapshot-publication-repository";

const PROCESS_ROLE = process.env.POIETRA_SNAPSHOT_STORAGE_E2E_PROCESS_ROLE;
const PROCESS_MARKER = "POIETRA_SNAPSHOT_STORAGE_E2E_RESULT=";
const E2E_CONFIGURED = [
  "POIETRA_STORAGE_E2E_DATABASE_URL",
  "POIETRA_STORAGE_E2E_S3_ENDPOINT",
  "POIETRA_STORAGE_E2E_S3_BUCKET",
  "POIETRA_STORAGE_E2E_S3_ACCESS_KEY",
  "POIETRA_STORAGE_E2E_S3_SECRET_KEY",
].every((key) => Boolean(process.env[key]));
const PROFILE_DIGEST = "c".repeat(64);
const RUNTIME_CONFIG_HASH = "b".repeat(64);

type StorageEnvironment = Readonly<{
  accessKeyId: string;
  bucket: string;
  databaseUrl: string;
  endpoint: string;
  secretAccessKey: string;
}>;

type ChildResult = Readonly<{
  event: "published";
  generation: string;
  requestId: string;
  resultDigest: string;
  snapshotHash: string;
}>;

function storageEnvironment(): StorageEnvironment {
  if (!E2E_CONFIGURED) throw new Error("The snapshot storage E2E environment is incomplete.");
  return {
    accessKeyId: process.env.POIETRA_STORAGE_E2E_S3_ACCESS_KEY!,
    bucket: process.env.POIETRA_STORAGE_E2E_S3_BUCKET!,
    databaseUrl: process.env.POIETRA_STORAGE_E2E_DATABASE_URL!,
    endpoint: process.env.POIETRA_STORAGE_E2E_S3_ENDPOINT!,
    secretAccessKey: process.env.POIETRA_STORAGE_E2E_S3_SECRET_KEY!,
  };
}

function s3Config(environment: StorageEnvironment) {
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

function snapshotStorage() {
  const environment = storageEnvironment();
  const artifacts = new S3SnapshotArtifactStoreV1({
    bucket: environment.bucket,
    clientConfig: s3Config(environment),
    deployment: "test",
  });
  const publications = new PostgresSnapshotPublicationRepositoryV1({
    poolConfig: { connectionString: environment.databaseUrl, max: 2 },
  });
  return {
    artifacts,
    publications,
  };
}

async function closeSnapshotStorage(storage: ReturnType<typeof snapshotStorage>) {
  const results = await Promise.allSettled([storage.artifacts.close(), storage.publications.close()]);
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length > 0) throw new AggregateError(failures, "Could not close snapshot E2E storage.");
}

async function createRuntime(tenantId: string, projectId: string) {
  const environment = storageEnvironment();
  return createDurableManimRuntimeV1({
    blobs: new S3ContentBlobStoreV1({
      bucket: environment.bucket,
      clientConfig: s3Config(environment),
      deployment: "test",
    }),
    execution: { ready: async () => true },
    namespace: "snapshot-storage-e2e",
    projectIdFactory: () => projectId,
    repository: new PostgresWorkspaceSourceRepositoryV1({
      poolConfig: { connectionString: environment.databaseUrl, max: 2 },
    }),
    tenantId,
  });
}

function identityFromEnvironment(): SnapshotPublicationIdentityV1 {
  const serialized = process.env.POIETRA_SNAPSHOT_STORAGE_E2E_IDENTITY;
  if (!serialized) throw new Error("The snapshot reader child is missing its identity.");
  return JSON.parse(serialized) as SnapshotPublicationIdentityV1;
}

function emitProcessResult(result: ChildResult) {
  process.stdout.write(`${PROCESS_MARKER}${JSON.stringify(result)}\n`);
}

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE !== "reader")("durable snapshot storage child fixture", () => {
  it("reads one published snapshot through fresh process-local adapters", async () => {
    const storage = snapshotStorage();
    try {
      expect(await storage.publications.ready()).toBe(true);
      expect(await storage.artifacts.ready()).toBe(true);
      const result = await storage.publications.readCurrent(identityFromEnvironment());
      if (result.kind !== "published") throw new Error(`Expected a published snapshot, received ${result.kind}.`);
      const bytes = await storage.artifacts.read(result.publication.tenantId, result.publication.artifact);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.publication.artifact.resultDigest);
      emitProcessResult({
        event: "published",
        generation: result.publication.generation.toString(),
        requestId: result.publication.requestId,
        resultDigest: result.publication.artifact.resultDigest,
        snapshotHash: result.publication.snapshotHash,
      });
    } finally {
      await closeSnapshotStorage(storage);
    }
  }, 30_000);
});

async function runReaderChild(identity: SnapshotPublicationIdentityV1): Promise<ChildResult> {
  const vitestEntry = fileURLToPath(new URL("../vitest.mjs", import.meta.resolve("vitest")));
  const child = spawn(
    process.execPath,
    [
      vitestEntry,
      "run",
      fileURLToPath(import.meta.url),
      "-t",
      "reads one published snapshot through fresh process-local adapters",
      "--pool=threads",
      "--maxWorkers=1",
      "--reporter=dot",
    ],
    {
      env: {
        ...process.env,
        POIETRA_SNAPSHOT_STORAGE_E2E_IDENTITY: JSON.stringify(identity),
        POIETRA_SNAPSHOT_STORAGE_E2E_PROCESS_ROLE: "reader",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  let output = "";
  let result: ChildResult | null = null;
  const inspectOutput = () => {
    const markerIndex = output.indexOf(PROCESS_MARKER);
    const lineEnd = markerIndex < 0 ? -1 : output.indexOf("\n", markerIndex);
    if (markerIndex < 0 || lineEnd < 0 || result) return;
    result = JSON.parse(output.slice(markerIndex + PROCESS_MARKER.length, lineEnd)) as ChildResult;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    inspectOutput();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors = `${errors}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const exit = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
  try {
    const status = await exit;
    inspectOutput();
    if (!result) throw new Error(`Snapshot reader child produced no result: ${errors || output.slice(-4_000)}`);
    if (status.code !== 0) {
      throw new Error(`Snapshot reader child failed with ${status.code}/${status.signal}: ${errors}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function isMissingBucket(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "NotFound" ||
      error.name === "NoSuchBucket" ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 404))
  );
}

async function prepareStorage(environment: StorageEnvironment) {
  const pool = new Pool({ connectionString: environment.databaseUrl, max: 2 });
  const s3 = new S3Client(s3Config(environment));
  try {
    await applyBundledDurableStorageMigrations(pool);
    try {
      await s3.send(new HeadBucketCommand({ Bucket: environment.bucket }));
    } catch (error) {
      if (!isMissingBucket(error)) throw error;
      await s3.send(new CreateBucketCommand({ Bucket: environment.bucket }));
    }
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: environment.bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
  } finally {
    s3.destroy();
    await pool.end();
  }
}

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE !== undefined)("PostgreSQL + MinIO snapshot publication", () => {
  it("publishes across processes, isolates tenants, rejects stale source CAS, and deletes an upload orphan", async () => {
    const environment = storageEnvironment();
    await prepareStorage(environment);

    const suffix = randomUUID().replaceAll("-", "");
    const tenantA = `snapshot-a-${suffix}`;
    const tenantB = `snapshot-b-${suffix}`;
    const projectId = `project-${suffix}`;
    const identity = {
      projectId,
      sceneName: "MainScene",
      sourcePath: "main.py",
      tenantId: tenantA,
    } satisfies SnapshotPublicationIdentityV1;
    const runtimeA = await createRuntime(tenantA, projectId);
    const runtimeB = await createRuntime(tenantB, projectId);
    try {
      await runtimeA.createManagedProject("Snapshot tenant A");
      await runtimeB.createManagedProject("Snapshot tenant B");
      const sourceHeads = new PostgresWorkspaceSourceRepositoryV1({
        poolConfig: { connectionString: environment.databaseUrl, max: 2 },
      });
      const sourceHead = await sourceHeads
        .readSourceHead(tenantA, projectId, identity.sourcePath)
        .finally(() => sourceHeads.close());
      const requestId = `snapshot-request-${suffix}`;
      const snapshotHash = createHash("sha256").update(`snapshot-${suffix}`).digest("hex");

      const writer = snapshotStorage();
      let publication: Awaited<ReturnType<PostgresSnapshotPublicationRepositoryV1["publish"]>>;
      try {
        expect(await writer.publications.ready()).toBe(true);
        expect(await writer.artifacts.ready()).toBe(true);
        const artifact = await writer.artifacts.put(tenantA, {
          bytes: Buffer.from(`snapshot-artifact-${suffix}`, "utf8"),
          profileDigest: PROFILE_DIGEST,
          runtimeConfigHash: RUNTIME_CONFIG_HASH,
          sourceDigest: sourceHead.blob.digest,
        });
        publication = await writer.publications.publish({
          ...identity,
          artifact,
          expectedSourceDigest: sourceHead.blob.digest,
          expectedSourceGeneration: sourceHead.generation,
          publicationId: randomUUID(),
          requestId,
          snapshotHash,
        });
      } finally {
        await closeSnapshotStorage(writer);
      }
      expect(publication.kind).toBe("published");
      if (publication.kind !== "published") throw new Error("The source unexpectedly became stale.");

      const childRead = await runReaderChild(identity);
      expect(childRead).toEqual({
        event: "published",
        generation: publication.publication.generation.toString(),
        requestId,
        resultDigest: publication.publication.artifact.resultDigest,
        snapshotHash,
      });

      const tenantBReader = snapshotStorage();
      try {
        await expect(tenantBReader.publications.readCurrent({ ...identity, tenantId: tenantB })).resolves.toEqual({
          kind: "missing",
        });
        await expect(tenantBReader.artifacts.read(tenantB, publication.publication.artifact)).rejects.toThrow(
          "Snapshot artifact receipt is invalid",
        );
      } finally {
        await closeSnapshotStorage(tenantBReader);
      }

      const updatedHead = await runtimeA.compareAndSwapSource({
        expectedDigest: sourceHead.blob.digest,
        expectedGeneration: sourceHead.generation,
        projectId,
        source: `from manim import *\n\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(2)\n`,
        sourcePath: identity.sourcePath,
      });
      expect(updatedHead.generation).toBe(sourceHead.generation + 1n);
      const staleReader = snapshotStorage();
      try {
        await expect(staleReader.publications.readCurrent(identity)).resolves.toEqual({
          generation: publication.publication.generation,
          kind: "stale",
        });
      } finally {
        await closeSnapshotStorage(staleReader);
      }

      const orphanStorage = snapshotStorage();
      try {
        const orphan = await orphanStorage.artifacts.put(tenantA, {
          bytes: Buffer.from(`orphan-${suffix}`, "utf8"),
          profileDigest: PROFILE_DIGEST,
          runtimeConfigHash: RUNTIME_CONFIG_HASH,
          sourceDigest: updatedHead.blob.digest,
        });
        expect(await orphanStorage.publications.isArtifactPublished(tenantA, orphan)).toBe(false);
        const queued = await orphanStorage.publications.queueArtifactDeletion(tenantA, orphan);
        expect(queued).toMatchObject({ artifact: orphan, tenantId: tenantA });
        if (!queued) throw new Error("The upload orphan was not queued for deletion.");
        expect(await orphanStorage.publications.pendingArtifactDeletions(tenantA, 10)).toEqual([queued]);
        await orphanStorage.artifacts.deleteVersion(tenantA, orphan);
        await orphanStorage.publications.acknowledgeArtifactDeletion(tenantA, queued.deletionId);
        expect(await orphanStorage.publications.pendingArtifactDeletions(tenantA, 10)).toEqual([]);
        await expect(orphanStorage.artifacts.read(tenantA, orphan)).rejects.toMatchObject({
          code: "missing",
          name: SnapshotArtifactReadErrorV1.name,
        });
      } finally {
        await closeSnapshotStorage(orphanStorage);
      }
    } finally {
      await Promise.all([runtimeB.close(), runtimeA.close()]);
    }
  }, 90_000);
});
