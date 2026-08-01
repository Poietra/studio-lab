import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { CreateBucketCommand, HeadBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createDurableManimRuntimeV1 } from "../durable-manim-runtime";
import {
  applyBundledDurableStorageMigrations,
  applySnapshotRuntimeDigestMigrationV10,
  durableStorageMigrationChecksum,
  PROJECT_PNG_MIGRATION_V5_SOURCE,
  RENDER_ARTIFACT_MIGRATION_V4_SOURCE,
  RENDER_CANCELLATION_MIGRATION_V7_SOURCE,
  RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE,
  RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE,
  RENDER_SESSION_MIGRATION_V2_SOURCE,
  RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE,
  SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE,
  SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE,
  WORKSPACE_SOURCE_MIGRATION_V1_SOURCE,
} from "./postgres/migrate";
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
const RUNTIME_DIGEST = "d".repeat(64);
const OTHER_RUNTIME_DIGEST = "e".repeat(64);

const PRE_RUNTIME_DIGEST_MIGRATIONS = [
  WORKSPACE_SOURCE_MIGRATION_V1_SOURCE,
  RENDER_SESSION_MIGRATION_V2_SOURCE,
  SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE,
  RENDER_ARTIFACT_MIGRATION_V4_SOURCE,
  PROJECT_PNG_MIGRATION_V5_SOURCE,
  RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE,
  RENDER_CANCELLATION_MIGRATION_V7_SOURCE,
  RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE,
  RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE,
] as const;

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
  runtimeDigest: string;
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
          runtimeDigest: input.runtimeDigest,
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
        runtimeDigest: input.identity.runtimeDigest,
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

async function seedLegacySnapshotPublication(pool: Pool) {
  const tenantId = "snapshot-legacy";
  const projectId = "legacy-project";
  const sourceDigest = "1".repeat(64);
  const resultDigest = "2".repeat(64);
  const runtimeConfigHash = "3".repeat(64);
  const profileDigest = "4".repeat(64);
  const snapshotHash = "5".repeat(64);
  const publicationId = "018f57e2-4c8b-7d31-a91e-4ae5e5c6c8b1";
  const objectKey = `tenants/${tenantId}/snapshots/${sourceDigest}/${runtimeConfigHash}/${profileDigest}/${resultDigest}`;

  await pool.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1)", [tenantId]);
  await pool.query("INSERT INTO public.workspace_projects (tenant_id, project_id, display_name) VALUES ($1, $2, $3)", [
    tenantId,
    projectId,
    "Legacy snapshot project",
  ]);
  await pool.query(
    `INSERT INTO public.source_blob_objects
       (tenant_id, digest, object_key, version_id, etag, byte_size)
     VALUES ($1, $2, $3, 'legacy-source-version', 'legacy-source-etag', 64)`,
    [tenantId, sourceDigest, `tenants/${tenantId}/sources/${sourceDigest}`],
  );
  await pool.query(
    `INSERT INTO public.workspace_source_heads
       (tenant_id, project_id, source_path, generation, digest)
     VALUES ($1, $2, 'main.py', 1, $3)`,
    [tenantId, projectId, sourceDigest],
  );
  await pool.query(
    `INSERT INTO public.snapshot_artifact_objects
       (tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest,
        object_key, version_id, etag, byte_size)
     VALUES ($1, $2, $3, $4, $5, $6, 'legacy-artifact-version', 'legacy-artifact-etag', 128)`,
    [tenantId, resultDigest, sourceDigest, runtimeConfigHash, profileDigest, objectKey],
  );
  await pool.query(
    `INSERT INTO public.snapshot_publications
       (tenant_id, publication_id, project_id, source_path, scene_name, generation,
        source_generation, source_digest, runtime_config_hash, profile_digest, result_digest,
        snapshot_hash, request_id)
     VALUES ($1, $2::uuid, $3, 'main.py', 'MainScene', 1, 1, $4, $5, $6, $7, $8, 'legacy-request')`,
    [tenantId, publicationId, projectId, sourceDigest, runtimeConfigHash, profileDigest, resultDigest, snapshotHash],
  );
  await pool.query(
    `INSERT INTO public.snapshot_scene_heads
       (tenant_id, project_id, source_path, scene_name, generation, publication_id)
     VALUES ($1, $2, 'main.py', 'MainScene', 1, $3::uuid)`,
    [tenantId, projectId, publicationId],
  );
  await pool.query(
    `INSERT INTO public.workspace_project_references
       (tenant_id, project_id, reference_kind, reference_id)
     VALUES ($1, $2, 'snapshot-publication', $3)`,
    [tenantId, projectId, publicationId],
  );
  await pool.query(
    `INSERT INTO public.snapshot_artifact_deletions
       (deletion_id, tenant_id, result_digest, source_digest, runtime_config_hash,
        profile_digest, object_key, version_id, etag, byte_size)
     VALUES ('018f57e2-4c8b-7d31-a91e-4ae5e5c6c8b2'::uuid, $1, $2, $3, $4, $5, $6,
             'legacy-deletion-version', 'legacy-deletion-etag', 128)`,
    [tenantId, resultDigest, sourceDigest, runtimeConfigHash, profileDigest, objectKey],
  );

  return { objectKey, tenantId };
}

async function prepareStorage(environment: StorageEnvironment) {
  const pool = new Pool({ connectionString: environment.databaseUrl, max: 2 });
  const s3 = new S3Client(s3Config(environment));
  try {
    for (const [index, source] of PRE_RUNTIME_DIGEST_MIGRATIONS.entries()) {
      await pool.query(source);
      await pool.query("INSERT INTO public.poietra_schema_migrations (version, checksum) VALUES ($1, $2)", [
        index + 1,
        durableStorageMigrationChecksum(source),
      ]);
    }
    const legacy = await seedLegacySnapshotPublication(pool);
    expect(await applySnapshotRuntimeDigestMigrationV10(pool, SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE)).toEqual({
      applied: true,
      version: 10,
    });
    expect(await applyBundledDurableStorageMigrations(pool)).toEqual({ applied: true, version: 16 });
    expect(await applyBundledDurableStorageMigrations(pool)).toEqual({ applied: false, version: 16 });
    const migratedLegacy = await pool.query<{
      artifact_runtime_digest: string;
      artifact_object_key: string;
      deletion_runtime_digest: string;
      deletion_object_key: string;
      heads: number;
      publications: number;
      references: number;
    }>(
      `SELECT artifact.runtime_digest AS artifact_runtime_digest,
              artifact.object_key AS artifact_object_key,
              deletion.runtime_digest AS deletion_runtime_digest,
              deletion.object_key AS deletion_object_key,
              (SELECT count(*)::integer FROM public.snapshot_scene_heads
                WHERE tenant_id = $1) AS heads,
              (SELECT count(*)::integer FROM public.snapshot_publications
                WHERE tenant_id = $1) AS publications,
              (SELECT count(*)::integer FROM public.workspace_project_references
                WHERE tenant_id = $1 AND reference_kind = 'snapshot-publication') AS references
         FROM public.snapshot_artifact_objects artifact
         JOIN public.snapshot_artifact_deletions deletion
           ON deletion.tenant_id = artifact.tenant_id
        WHERE artifact.tenant_id = $1`,
      [legacy.tenantId],
    );
    expect(migratedLegacy.rows).toEqual([
      {
        artifact_object_key: legacy.objectKey,
        artifact_runtime_digest: "0".repeat(64),
        deletion_object_key: legacy.objectKey,
        deletion_runtime_digest: "0".repeat(64),
        heads: 0,
        publications: 0,
        references: 0,
      },
    ]);
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
      runtimeDigest: RUNTIME_DIGEST,
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
      const artifactBytes = `snapshot-artifact-${suffix}`;

      const publication = await runPublisherChild({
        artifactBytes,
        expectedSourceDigest: sourceHead.blob.digest,
        expectedSourceGeneration: sourceHead.generation.toString(),
        identity,
        publicationId: randomUUID(),
        requestId,
        snapshotHash,
      });

      const childRead = await runReaderChild(identity);
      expect(childRead).toEqual(publication);

      const otherRuntimeIdentity = { ...identity, runtimeDigest: OTHER_RUNTIME_DIGEST };
      const otherRuntimeReader = snapshotStorage();
      try {
        await expect(otherRuntimeReader.publications.readCurrent(otherRuntimeIdentity)).resolves.toEqual({
          kind: "missing",
        });
      } finally {
        await closeSnapshotStorage(otherRuntimeReader);
      }
      const otherRuntimePublication = await runPublisherChild({
        artifactBytes,
        expectedSourceDigest: sourceHead.blob.digest,
        expectedSourceGeneration: sourceHead.generation.toString(),
        identity: otherRuntimeIdentity,
        publicationId: randomUUID(),
        requestId: `other-runtime-${requestId}`,
        snapshotHash: createHash("sha256").update(`other-runtime-snapshot-${suffix}`).digest("hex"),
      });
      expect(otherRuntimePublication.artifact.resultDigest).toBe(publication.artifact.resultDigest);
      expect(otherRuntimePublication.artifact.objectKey).not.toBe(publication.artifact.objectKey);
      expect(await runReaderChild(otherRuntimeIdentity)).toEqual(otherRuntimePublication);
      expect(await runReaderChild(identity)).toEqual(publication);

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
        await expect(staleReader.publications.readCurrent(otherRuntimeIdentity)).resolves.toEqual({
          generation: BigInt(otherRuntimePublication.generation),
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

      const retainedReference = `render-session-${suffix}`;
      const deletionInspection = new Pool({ connectionString: environment.databaseUrl, max: 1 });
      const deletionStorage = snapshotStorage();
      try {
        await deletionInspection.query(
          `INSERT INTO public.workspace_project_references
             (tenant_id, project_id, reference_kind, reference_id)
           VALUES ($1, $2, 'render-session', $3)`,
          [tenantA, projectId, retainedReference],
        );
        await expect(deletionStorage.publications.softDeleteProject(tenantA, projectId)).rejects.toMatchObject({
          status: 409,
        });
        await expect(runtimeA.workspace(projectId)).resolves.toMatchObject({ projectId });
        const rejectedState = await deletionInspection.query<{
          current_heads: number;
          deleted_at: Date | null;
          render_references: number;
          snapshot_references: number;
        }>(
          `SELECT project.deleted_at,
                  (SELECT count(*)::integer FROM public.workspace_project_references reference
                    WHERE reference.tenant_id = project.tenant_id
                      AND reference.project_id = project.project_id
                      AND reference.reference_kind = 'render-session') AS render_references,
                  (SELECT count(*)::integer FROM public.workspace_project_references reference
                    WHERE reference.tenant_id = project.tenant_id
                      AND reference.project_id = project.project_id
                      AND reference.reference_kind = 'snapshot-publication') AS snapshot_references,
                  (SELECT count(*)::integer FROM public.snapshot_scene_heads head
                    WHERE head.tenant_id = project.tenant_id
                      AND head.project_id = project.project_id
                      AND head.publication_id IS NOT NULL) AS current_heads
             FROM public.workspace_projects project
            WHERE project.tenant_id = $1 AND project.project_id = $2`,
          [tenantA, projectId],
        );
        expect(rejectedState.rows[0]).toMatchObject({
          current_heads: 1,
          deleted_at: null,
          render_references: 1,
          snapshot_references: 1,
        });

        await deletionInspection.query(
          `DELETE FROM public.workspace_project_references
            WHERE tenant_id = $1 AND project_id = $2
              AND reference_kind = 'render-session' AND reference_id = $3`,
          [tenantA, projectId, retainedReference],
        );
        await expect(deletionStorage.publications.softDeleteProject(tenantA, projectId)).resolves.toBeUndefined();
        await expect(runtimeA.projects()).resolves.toEqual({ defaultProjectId: null, projects: [] });
        await expect(runtimeB.workspace(projectId)).resolves.toMatchObject({ projectId });
        const deletedState = await deletionInspection.query<{
          current_heads: number;
          deleted_at: Date | null;
          snapshot_references: number;
        }>(
          `SELECT project.deleted_at,
                  (SELECT count(*)::integer FROM public.workspace_project_references reference
                    WHERE reference.tenant_id = project.tenant_id
                      AND reference.project_id = project.project_id
                      AND reference.reference_kind = 'snapshot-publication') AS snapshot_references,
                  (SELECT count(*)::integer FROM public.snapshot_scene_heads head
                    WHERE head.tenant_id = project.tenant_id
                      AND head.project_id = project.project_id
                      AND head.publication_id IS NOT NULL) AS current_heads
             FROM public.workspace_projects project
            WHERE project.tenant_id = $1 AND project.project_id = $2`,
          [tenantA, projectId],
        );
        expect(deletedState.rows[0]?.deleted_at).toBeInstanceOf(Date);
        expect(deletedState.rows[0]).toMatchObject({ current_heads: 0, snapshot_references: 0 });

        await expect(
          deletionStorage.publications.publish({
            ...identity,
            artifact: replacement.artifact,
            expectedSourceDigest: updatedHead.blob.digest,
            expectedSourceGeneration: updatedHead.generation,
            publicationId: randomUUID(),
            requestId: `late-${requestId}`,
            snapshotHash: createHash("sha256").update(`late-snapshot-${suffix}`).digest("hex"),
          }),
        ).resolves.toEqual({ kind: "source-stale" });
        await expect(deletionStorage.publications.readCurrent(identity)).resolves.toEqual({
          generation: BigInt(replacement.generation),
          kind: "stale",
        });
      } finally {
        await Promise.all([deletionInspection.end(), closeSnapshotStorage(deletionStorage)]);
      }

      const orphan = await runOrphanWriterChild({
        nonce: suffix,
        runtimeDigest: identity.runtimeDigest,
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
