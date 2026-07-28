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
import {
  SnapshotArtifactReadErrorV1,
  type SnapshotArtifactReceiptV1,
  type SnapshotPublicationIdentityV1,
} from "./snapshot-publication-repository";

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

type ChildResult =
  | Readonly<{
      event: "orphan-uploaded";
      artifact: SnapshotArtifactReceiptV1;
    }>
  | Readonly<{
      artifact: SnapshotArtifactReceiptV1;
      event: "published";
      generation: string;
      requestId: string;
      snapshotHash: string;
    }>;

type ChildRole = "orphan-writer" | "publisher" | "reader";

type OrphanWriterInput = Readonly<{
  nonce: string;
  sourceDigest: string;
  tenantId: string;
}>;

type PublisherInput = Readonly<{
  artifactBytes: string;
  expectedSourceDigest: string;
  expectedSourceGeneration: string;
  identity: SnapshotPublicationIdentityV1;
  publicationId: string;
  requestId: string;
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

function snapshotArtifactStore() {
  const environment = storageEnvironment();
  return new S3SnapshotArtifactStoreV1({
    bucket: environment.bucket,
    clientConfig: s3Config(environment),
    deployment: "test",
  });
}

function snapshotStorage() {
  const environment = storageEnvironment();
  const artifacts = snapshotArtifactStore();
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

function orphanWriterInputFromEnvironment(): OrphanWriterInput {
  const serialized = process.env.POIETRA_SNAPSHOT_STORAGE_E2E_ORPHAN_INPUT;
  if (!serialized) throw new Error("The snapshot orphan writer is missing its input.");
  return JSON.parse(serialized) as OrphanWriterInput;
}

function publisherInputFromEnvironment(): PublisherInput {
  const serialized = process.env.POIETRA_SNAPSHOT_STORAGE_E2E_PUBLISHER_INPUT;
  if (!serialized) throw new Error("The snapshot publisher child is missing its input.");
  return JSON.parse(serialized) as PublisherInput;
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
        artifact: result.publication.artifact,
        event: "published",
        generation: result.publication.generation.toString(),
        requestId: result.publication.requestId,
        snapshotHash: result.publication.snapshotHash,
      });
    } finally {
      await closeSnapshotStorage(storage);
    }
  }, 30_000);
});

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE !== "orphan-writer")(
  "durable snapshot orphan writer child fixture",
  () => {
    it("uploads an artifact and waits without publishing metadata", async () => {
      const input = orphanWriterInputFromEnvironment();
      const artifacts = snapshotArtifactStore();
      try {
        expect(await artifacts.ready()).toBe(true);
        const artifact = await artifacts.put(input.tenantId, {
          bytes: Buffer.from(`orphan-${input.nonce}`, "utf8"),
          profileDigest: PROFILE_DIGEST,
          runtimeConfigHash: RUNTIME_CONFIG_HASH,
          sourceDigest: input.sourceDigest,
        });
        emitProcessResult({ artifact, event: "orphan-uploaded" });
        await new Promise<never>(() => undefined);
      } finally {
        await artifacts.close();
      }
    }, 30_000);
  },
);

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE !== "publisher")("durable snapshot publisher child fixture", () => {
  it("publishes one snapshot and waits for a process crash", async () => {
    const input = publisherInputFromEnvironment();
    const storage = snapshotStorage();
    try {
      expect(await storage.publications.ready()).toBe(true);
      expect(await storage.artifacts.ready()).toBe(true);
      const artifact = await storage.artifacts.put(input.identity.tenantId, {
        bytes: Buffer.from(input.artifactBytes, "utf8"),
        profileDigest: PROFILE_DIGEST,
        runtimeConfigHash: RUNTIME_CONFIG_HASH,
        sourceDigest: input.expectedSourceDigest,
      });
      const result = await storage.publications.publish({
        ...input.identity,
        artifact,
        expectedSourceDigest: input.expectedSourceDigest,
        expectedSourceGeneration: BigInt(input.expectedSourceGeneration),
        publicationId: input.publicationId,
        requestId: input.requestId,
        snapshotHash: input.snapshotHash,
      });
      if (result.kind !== "published") throw new Error("The publisher child observed stale source metadata.");
      emitProcessResult({
        artifact: result.publication.artifact,
        event: "published",
        generation: result.publication.generation.toString(),
        requestId: result.publication.requestId,
        snapshotHash: result.publication.snapshotHash,
      });
      await new Promise<never>(() => undefined);
    } finally {
      await closeSnapshotStorage(storage);
    }
  }, 30_000);
});

async function runChild(options: {
  environment: Readonly<Record<string, string>>;
  killAfterResult: boolean;
  role: ChildRole;
  title: string;
}): Promise<ChildResult> {
  const vitestEntry = fileURLToPath(new URL("../vitest.mjs", import.meta.resolve("vitest")));
  const child = spawn(
    process.execPath,
    [
      vitestEntry,
      "run",
      fileURLToPath(import.meta.url),
      "-t",
      options.title,
      "--pool=threads",
      "--maxWorkers=1",
      "--reporter=dot",
    ],
    {
      env: {
        ...process.env,
        ...options.environment,
        POIETRA_SNAPSHOT_STORAGE_E2E_PROCESS_ROLE: options.role,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  let output = "";
  let result: ChildResult | null = null;
  let parseError: unknown = null;
  let spawnError: unknown = null;
  let timedOut = false;
  let killAttempted = false;
  const boundOutput = (current: string, chunk: Buffer) => `${current}${chunk.toString("utf8")}`.slice(-4_000);
  const inspectOutput = () => {
    const markerIndex = output.indexOf(PROCESS_MARKER);
    const lineEnd = markerIndex < 0 ? -1 : output.indexOf("\n", markerIndex);
    if (markerIndex < 0 || lineEnd < 0 || result) return;
    try {
      result = JSON.parse(output.slice(markerIndex + PROCESS_MARKER.length, lineEnd)) as ChildResult;
      if (options.killAfterResult) {
        killAttempted = true;
        child.kill("SIGKILL");
      }
    } catch (error) {
      parseError = error;
      killAttempted = true;
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    output = boundOutput(output, chunk);
    inspectOutput();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors = boundOutput(errors, chunk);
  });
  const exit = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    killAttempted = true;
    child.kill("SIGKILL");
  }, 25_000);
  try {
    const status = await exit;
    inspectOutput();
    if (spawnError) throw new Error(`Snapshot ${options.role} child could not start.`, { cause: spawnError });
    if (timedOut) throw new Error(`Snapshot ${options.role} child timed out: ${errors || output}`);
    if (parseError)
      throw new Error(`Snapshot ${options.role} child returned an invalid marker.`, { cause: parseError });
    if (!result) throw new Error(`Snapshot ${options.role} child produced no result: ${errors || output}`);
    if (options.killAfterResult) {
      if (!killAttempted || status.signal !== "SIGKILL") {
        throw new Error(`Snapshot ${options.role} child was not terminated after its result marker.`);
      }
    } else if (status.code !== 0) {
      throw new Error(`Snapshot ${options.role} child failed with ${status.code}/${status.signal}: ${errors}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null && spawnError === null) {
      child.kill("SIGKILL");
      await exit;
    }
  }
}

async function runReaderChild(identity: SnapshotPublicationIdentityV1) {
  const result = await runChild({
    environment: { POIETRA_SNAPSHOT_STORAGE_E2E_IDENTITY: JSON.stringify(identity) },
    killAfterResult: false,
    role: "reader",
    title: "reads one published snapshot through fresh process-local adapters",
  });
  if (result.event !== "published") throw new Error("The snapshot reader child returned the wrong event.");
  return result;
}

async function runOrphanWriterChild(input: OrphanWriterInput) {
  const result = await runChild({
    environment: { POIETRA_SNAPSHOT_STORAGE_E2E_ORPHAN_INPUT: JSON.stringify(input) },
    killAfterResult: true,
    role: "orphan-writer",
    title: "uploads an artifact and waits without publishing metadata",
  });
  if (result.event !== "orphan-uploaded") throw new Error("The snapshot orphan writer returned the wrong event.");
  return result.artifact;
}

async function runPublisherChild(input: PublisherInput) {
  const result = await runChild({
    environment: { POIETRA_SNAPSHOT_STORAGE_E2E_PUBLISHER_INPUT: JSON.stringify(input) },
    killAfterResult: true,
    role: "publisher",
    title: "publishes one snapshot and waits for a process crash",
  });
  if (result.event !== "published") throw new Error("The snapshot publisher child returned the wrong event.");
  return result;
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

      const publication = await runPublisherChild({
        artifactBytes: `snapshot-artifact-${suffix}`,
        expectedSourceDigest: sourceHead.blob.digest,
        expectedSourceGeneration: sourceHead.generation.toString(),
        identity,
        publicationId: randomUUID(),
        requestId,
        snapshotHash,
      });

      const childRead = await runReaderChild(identity);
      expect(childRead).toEqual(publication);

      const tenantBReader = snapshotStorage();
      try {
        await expect(tenantBReader.publications.readCurrent({ ...identity, tenantId: tenantB })).resolves.toEqual({
          kind: "missing",
        });
        await expect(tenantBReader.artifacts.listVersions(tenantB, new Date(Date.now() + 60_000), 10)).resolves.toEqual(
          { nextCursor: null, versions: [] },
        );
        await expect(tenantBReader.artifacts.read(tenantB, publication.artifact)).rejects.toThrow(
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
          generation: BigInt(publication.generation),
          kind: "stale",
        });
      } finally {
        await closeSnapshotStorage(staleReader);
      }

      const replacement = await runPublisherChild({
        artifactBytes: `replacement-snapshot-artifact-${suffix}`,
        expectedSourceDigest: updatedHead.blob.digest,
        expectedSourceGeneration: updatedHead.generation.toString(),
        identity,
        publicationId: randomUUID(),
        requestId: `replacement-${requestId}`,
        snapshotHash: createHash("sha256").update(`replacement-snapshot-${suffix}`).digest("hex"),
      });
      const conditionalReader = snapshotStorage();
      try {
        await expect(
          conditionalReader.publications.clearHeadIfGeneration(identity, BigInt(publication.generation)),
        ).resolves.toBe(false);
        const current = await conditionalReader.publications.readCurrent(identity);
        expect(current).toMatchObject({
          kind: "published",
          publication: { generation: BigInt(replacement.generation) },
        });
      } finally {
        await closeSnapshotStorage(conditionalReader);
      }

      const orphan = await runOrphanWriterChild({
        nonce: suffix,
        sourceDigest: updatedHead.blob.digest,
        tenantId: tenantA,
      });
      const orphanStorage = snapshotStorage();
      const orphanInspection = new Pool({ connectionString: environment.databaseUrl, max: 1 });
      try {
        const registered = await orphanInspection.query<{ registered: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM public.snapshot_artifact_objects
              WHERE tenant_id = $1 AND result_digest = $2
                AND object_key = $3 AND version_id = $4
           ) AS registered`,
          [tenantA, orphan.resultDigest, orphan.objectKey, orphan.versionId],
        );
        expect(registered.rows[0]?.registered).toBe(false);
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
        await Promise.all([orphanInspection.end(), closeSnapshotStorage(orphanStorage)]);
      }
    } finally {
      await Promise.all([runtimeB.close(), runtimeA.close()]);
    }
  }, 90_000);
});
