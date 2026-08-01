import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createDurableManimRuntimeV1, type DurableManimRuntimeV1 } from "../durable-manim-runtime";
import { HttpError } from "../http/json";
import { applyBundledDurableStorageMigrations, applyWorkspaceSourceMigrationV1 } from "./postgres/migrate";
import { PostgresWorkspaceSourceRepositoryV1 } from "./postgres/postgres-workspace-source-repository";
import { S3ContentBlobStoreV1 } from "./s3/s3-content-blob-store";
import { runSourceBlobGcV1 } from "./source-blob-gc";

const PROCESS_ROLE = process.env.POIETRA_STORAGE_E2E_PROCESS_ROLE;
const E2E_CONFIGURED = [
  "POIETRA_STORAGE_E2E_DATABASE_URL",
  "POIETRA_STORAGE_E2E_S3_ENDPOINT",
  "POIETRA_STORAGE_E2E_S3_BUCKET",
  "POIETRA_STORAGE_E2E_S3_ACCESS_KEY",
  "POIETRA_STORAGE_E2E_S3_SECRET_KEY",
].every((key) => Boolean(process.env[key]));
const PROCESS_MARKER = "POIETRA_STORAGE_E2E_RESULT=";

type StorageEnvironment = Readonly<{
  accessKeyId: string;
  bucket: string;
  databaseUrl: string;
  endpoint: string;
  secretAccessKey: string;
}>;

function storageEnvironment(): StorageEnvironment {
  if (!E2E_CONFIGURED) throw new Error("The durable storage E2E environment is incomplete.");
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

async function createRuntime(tenantId: string, projectIdFactory?: () => string): Promise<DurableManimRuntimeV1> {
  const environment = storageEnvironment();
  return createDurableManimRuntimeV1({
    blobs: new S3ContentBlobStoreV1({
      bucket: environment.bucket,
      clientConfig: s3Config(environment),
      deployment: "test",
    }),
    execution: { ready: async () => true },
    namespace: "storage-e2e",
    projectIdFactory,
    repository: new PostgresWorkspaceSourceRepositoryV1({
      poolConfig: { connectionString: environment.databaseUrl, max: 4 },
    }),
    tenantId,
  });
}

function emitProcessResult(result: Readonly<Record<string, unknown>>) {
  process.stdout.write(`${PROCESS_MARKER}${JSON.stringify(result)}\n`);
}

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE === undefined)("durable storage child process fixture", () => {
  it("performs one adapter operation for the parent SIGKILL/concurrency proof", async () => {
    const projectId = process.env.POIETRA_STORAGE_E2E_PROJECT_ID!;
    const runtime = await createRuntime("tenant-a", () => projectId);
    if (PROCESS_ROLE === "writer") {
      const created = await runtime.createManagedProject("Crash durable workspace");
      emitProcessResult({ event: "created", projectId: created.project?.id });
      await new Promise<never>(() => undefined);
    }
    if (PROCESS_ROLE !== "cas-a" && PROCESS_ROLE !== "cas-b") {
      throw new Error("Unknown durable storage E2E child role.");
    }
    try {
      const head = await runtime.compareAndSwapSource({
        expectedDigest: process.env.POIETRA_STORAGE_E2E_EXPECTED_DIGEST!,
        expectedGeneration: BigInt(process.env.POIETRA_STORAGE_E2E_EXPECTED_GENERATION!),
        projectId,
        source: process.env.POIETRA_STORAGE_E2E_CANDIDATE_SOURCE!,
        sourcePath: "main.py",
      });
      emitProcessResult({ digest: head.blob.digest, event: "winner", role: PROCESS_ROLE });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      emitProcessResult({ event: "loser", role: PROCESS_ROLE, status: error.status });
    } finally {
      await runtime.close();
    }
  }, 30_000);
});

type ChildResult = Readonly<{ digest?: string; event: string; projectId?: string; role?: string; status?: number }>;

async function runChild(
  role: "cas-a" | "cas-b" | "writer",
  environment: Readonly<Record<string, string>>,
  killAfterResult = false,
): Promise<ChildResult> {
  const vitestEntry = fileURLToPath(new URL("../vitest.mjs", import.meta.resolve("vitest")));
  const testPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      vitestEntry,
      "run",
      testPath,
      "-t",
      "performs one adapter operation",
      "--pool=threads",
      "--maxWorkers=1",
      "--reporter=dot",
    ],
    {
      env: { ...process.env, ...environment, POIETRA_STORAGE_E2E_PROCESS_ROLE: role },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  let result: ChildResult | null = null;
  const inspectOutput = () => {
    const markerIndex = output.indexOf(PROCESS_MARKER);
    const lineEnd = markerIndex < 0 ? -1 : output.indexOf("\n", markerIndex);
    if (markerIndex < 0 || lineEnd < 0 || result) return;
    result = JSON.parse(output.slice(markerIndex + PROCESS_MARKER.length, lineEnd)) as ChildResult;
    if (killAfterResult) child.kill("SIGKILL");
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
    if (!result)
      throw new Error(`Durable storage child produced no result (${status.code}/${status.signal}): ${errors}`);
    if (killAfterResult) {
      if (status.signal !== "SIGKILL")
        throw new Error(`Writer was not terminated by SIGKILL (${status.code}/${status.signal}).`);
    } else if (status.code !== 0) {
      throw new Error(`Durable storage child failed with ${status.code}/${status.signal}: ${errors}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE !== undefined)("PostgreSQL + MinIO durable workspace/source", () => {
  it("survives SIGKILL, resolves cross-process CAS exactly once, isolates tenants, and collects orphans", async () => {
    const environment = storageEnvironment();
    const setupPool = new Pool({ connectionString: environment.databaseUrl, max: 2 });
    const setupS3 = new S3Client(s3Config(environment));
    try {
      // PostgreSQL's common "$user", public search_path must not redirect any
      // migration or runtime table into a role-named schema.
      await setupPool.query("CREATE SCHEMA poietra");
      const migration = await readFile(
        new URL("./postgres/migrations/0001_workspace_source.sql", import.meta.url),
        "utf8",
      );
      expect(await applyWorkspaceSourceMigrationV1(setupPool, migration)).toEqual({ applied: true, version: 1 });
      expect(await applyWorkspaceSourceMigrationV1(setupPool, migration)).toEqual({ applied: false, version: 1 });
      expect(await applyBundledDurableStorageMigrations(setupPool)).toEqual({ applied: true, version: 19 });
      expect(await applyBundledDurableStorageMigrations(setupPool)).toEqual({ applied: false, version: 19 });
      const schemaPlacement = await setupPool.query<{ misplaced: string | null; installed: string | null }>(
        `SELECT to_regclass('poietra.workspace_projects')::text AS misplaced,
                to_regclass('public.workspace_projects')::text AS installed`,
      );
      expect(schemaPlacement.rows[0]).toEqual({ installed: "workspace_projects", misplaced: null });
      await setupS3.send(new CreateBucketCommand({ Bucket: environment.bucket }));
      await setupS3.send(
        new PutBucketVersioningCommand({
          Bucket: environment.bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
    } finally {
      setupS3.destroy();
      await setupPool.end();
    }

    const projectId = "project-kill-proof";
    const childEnvironment = {
      POIETRA_STORAGE_E2E_PROJECT_ID: projectId,
    };
    const writer = await runChild("writer", childEnvironment, true);
    expect(writer).toMatchObject({ event: "created", projectId });

    const processB = await createRuntime("tenant-a");
    expect(await processB.ready()).toBe(true);
    expect(await processB.projects()).toEqual({
      defaultProjectId: projectId,
      projects: [{ id: projectId, kind: "managed", name: "Crash durable workspace" }],
    });
    const workspace = await processB.workspace(projectId);
    expect(workspace.sources[0]?.scenes[0]?.name).toBe("MainScene");
    const exported = await processB.exportOriginalSource({
      projectId,
      sourceHash: workspace.sources[0]!.scenes[0]!.sourceHash,
      sourcePath: "main.py",
    });
    expect(exported.source).toContain("class MainScene(Scene)");
    const repositoryB = new PostgresWorkspaceSourceRepositoryV1({
      poolConfig: { connectionString: environment.databaseUrl, max: 2 },
    });
    const publishedHead = await repositoryB.readSourceHead("tenant-a", projectId, "main.py");
    await repositoryB.close();
    await processB.close();

    const candidateA = `from manim import *\n\nclass WinnerA(Scene):\n    def construct(self):\n        self.wait(2)\n`;
    const candidateB = `from manim import *\n\nclass WinnerB(Scene):\n    def construct(self):\n        self.wait(3)\n`;
    const commonCasEnvironment = {
      ...childEnvironment,
      POIETRA_STORAGE_E2E_EXPECTED_DIGEST: publishedHead.blob.digest,
      POIETRA_STORAGE_E2E_EXPECTED_GENERATION: publishedHead.generation.toString(),
    };
    const contenders = await Promise.all([
      runChild("cas-a", { ...commonCasEnvironment, POIETRA_STORAGE_E2E_CANDIDATE_SOURCE: candidateA }),
      runChild("cas-b", { ...commonCasEnvironment, POIETRA_STORAGE_E2E_CANDIDATE_SOURCE: candidateB }),
    ]);
    expect(contenders.map((result) => result.event).sort()).toEqual(["loser", "winner"]);
    expect(contenders.find((result) => result.event === "loser")?.status).toBe(409);
    const winner = contenders.find((result) => result.event === "winner")!;
    const winnerSource = winner.role === "cas-a" ? candidateA : candidateB;

    const processC = await createRuntime("tenant-a");
    const reopenedHeadRepository = new PostgresWorkspaceSourceRepositoryV1({
      poolConfig: { connectionString: environment.databaseUrl, max: 2 },
    });
    const reopenedHead = await reopenedHeadRepository.readSourceHead("tenant-a", projectId, "main.py");
    expect(reopenedHead.generation).toBe(publishedHead.generation + 1n);
    expect(reopenedHead.blob.digest).toBe(winner.digest);
    const reopenedExport = await processC.exportOriginalSource({
      projectId,
      sourceHash: reopenedHead.blob.digest,
      sourcePath: "main.py",
    });
    expect(reopenedExport.source).toBe(winnerSource);
    await reopenedHeadRepository.close();

    const tenantB = await createRuntime("tenant-b");
    expect(await tenantB.projects()).toEqual({ defaultProjectId: null, projects: [] });
    await expect(tenantB.workspace(projectId)).rejects.toMatchObject({ status: 404 });
    await expect(
      tenantB.exportOriginalSource({ projectId, sourceHash: reopenedHead.blob.digest, sourcePath: "main.py" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      tenantB.compareAndSwapSource({
        expectedDigest: reopenedHead.blob.digest,
        expectedGeneration: reopenedHead.generation,
        projectId,
        source: candidateA,
        sourcePath: "main.py",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await tenantB.close();

    const gcRepository = new PostgresWorkspaceSourceRepositoryV1({
      poolConfig: { connectionString: environment.databaseUrl, max: 2 },
    });
    const gcBlobs = new S3ContentBlobStoreV1({
      bucket: environment.bucket,
      clientConfig: s3Config(environment),
      deployment: "test",
    });
    const duplicateSource = "# content-addressed duplicate\n";
    const firstDuplicate = await gcBlobs.putSource("tenant-a", duplicateSource);
    const secondDuplicate = await gcBlobs.putSource("tenant-a", duplicateSource);
    expect(secondDuplicate).toEqual(firstDuplicate);
    const rawOrphan = await gcBlobs.putSource("tenant-a", "# uploaded but never published\n");
    const tenantBOrphan = await gcBlobs.putSource("tenant-b", "# tenant B queued orphan\n");
    expect(await gcRepository.queueBlobDeletion("tenant-b", tenantBOrphan)).not.toBeNull();
    const gc = await runSourceBlobGcV1({
      blobs: gcBlobs,
      cutoff: new Date(Date.now() + 1_000),
      graceMs: 60_000,
      maximum: 256,
      repository: gcRepository,
      tenantId: "tenant-a",
    });
    expect(gc.deleted).toBeGreaterThanOrEqual(1);
    await expect(gcBlobs.readSource("tenant-a", rawOrphan)).rejects.toBeDefined();
    expect(await gcBlobs.readSource("tenant-a", publishedHead.blob)).toContain("class MainScene(Scene)");
    expect(await gcBlobs.readSource("tenant-a", reopenedHead.blob)).toBe(winnerSource);
    await expect(
      gcRepository.compareAndSwapSource({
        candidate: rawOrphan,
        expectedDigest: reopenedHead.blob.digest,
        expectedGeneration: reopenedHead.generation,
        projectId,
        sourcePath: "main.py",
        tenantId: "tenant-a",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await gcBlobs.readSource("tenant-b", tenantBOrphan)).toContain("tenant B queued orphan");
    expect(await gcRepository.pendingBlobDeletions("tenant-b", 256)).toHaveLength(1);
    const tenantBGc = await runSourceBlobGcV1({
      blobs: gcBlobs,
      cutoff: new Date(Date.now() + 1_000),
      graceMs: 60_000,
      maximum: 256,
      repository: gcRepository,
      tenantId: "tenant-b",
    });
    expect(tenantBGc.deleted).toBeGreaterThanOrEqual(1);
    await expect(gcBlobs.readSource("tenant-b", tenantBOrphan)).rejects.toBeDefined();
    await gcBlobs.close();
    await gcRepository.close();
    await processC.close();
  }, 90_000);
});
