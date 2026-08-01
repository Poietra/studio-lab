import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  type DurableManimRenderExecutorV1,
  DurableManimRenderWorkerV1,
  durableManimRenderJobIdV1,
} from "../durable-manim-render-worker";
import { HttpError } from "../http/json";
import {
  mutateRenderSessionWithUsageFixtureV1,
  seedActiveRenderEntitlementFixtureV1,
} from "./billing-entitlement-real-test-fixture";
import {
  applyBundledDurableStorageMigrations,
  RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE,
  RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE,
} from "./postgres/migrate";
import { PostgresRenderSessionRepositoryV1 } from "./postgres/postgres-render-session-repository";
import { PostgresWorkspaceSourceRepositoryV1 } from "./postgres/postgres-workspace-source-repository";
import type { RenderSessionRepositoryV1 } from "./render-session-repository";
import type { SourceBlobReceiptV1, WorkspaceSourceHeadV1 } from "./workspace-source-repository";

const PROCESS_ROLE = process.env.POIETRA_RENDER_SESSION_E2E_PROCESS_ROLE;
const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const E2E_CONFIGURED = Boolean(DATABASE_URL);
const PROCESS_RESULT_MARKER = "POIETRA_RENDER_SESSION_E2E_RESULT=";
const PROCESS_READY_MARKER = "POIETRA_RENDER_SESSION_E2E_READY=";

type ChildRole = "action" | "action-unknown" | "cas" | "creator" | "worker-after-job";
type ChildResult = Readonly<{
  actionId?: string;
  actionKind?: "commit" | "undo";
  digest?: string;
  event: "claimed" | "job-completed" | "loser" | "winner";
  fenceToken?: string;
  jobId?: string;
  kind?: "action" | "broker" | "cas";
  status?: number;
  version?: string;
}>;

type SerializedSourceHead = Omit<WorkspaceSourceHeadV1, "generation"> & Readonly<{ generation: string }>;

function configuredDatabaseUrl() {
  if (!DATABASE_URL) throw new Error("The durable render-session E2E database is not configured.");
  return DATABASE_URL;
}

function parseChildRole(value: string | undefined): ChildRole {
  if (
    value === "action" ||
    value === "action-unknown" ||
    value === "cas" ||
    value === "creator" ||
    value === "worker-after-job"
  ) {
    return value;
  }
  throw new Error("The durable render-session child role is invalid.");
}

function parseJsonEnvironment<T>(name: string): T {
  const value = process.env[name];
  if (!value) throw new Error(`The durable render-session child is missing ${name}.`);
  return JSON.parse(value) as T;
}

function sourceHeadFromEnvironment(): WorkspaceSourceHeadV1 {
  const value = parseJsonEnvironment<SerializedSourceHead>("POIETRA_RENDER_SESSION_E2E_ORIGINAL_HEAD");
  return { ...value, generation: BigInt(value.generation) };
}

function emitProcessResult(result: ChildResult) {
  process.stdout.write(`${PROCESS_RESULT_MARKER}${JSON.stringify(result)}\n`);
}

async function awaitProcessGate(role: ChildRole) {
  process.stdout.write(`${PROCESS_READY_MARKER}${JSON.stringify({ role })}\n`);
  const gateKey = process.env.POIETRA_RENDER_SESSION_E2E_GATE_KEY;
  if (!gateKey) throw new Error("The durable render-session process gate is not configured.");
  const pool = new Pool({ connectionString: configuredDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [gateKey]);
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]);
  } finally {
    client.release();
    await pool.end();
  }
}

function renderRepository() {
  return new PostgresRenderSessionRepositoryV1({
    poolConfig: { connectionString: configuredDatabaseUrl(), max: 2 },
  });
}

function sourceRepository() {
  return new PostgresWorkspaceSourceRepositoryV1({
    poolConfig: { connectionString: configuredDatabaseUrl(), max: 2 },
  });
}

function childSessionInput() {
  const originalHead = sourceHeadFromEnvironment();
  return {
    commitCorrelationKey: process.env.POIETRA_RENDER_SESSION_E2E_COMMIT_KEY!,
    executionTimeoutMs: 120_000,
    id: process.env.POIETRA_RENDER_SESSION_E2E_SESSION_ID!,
    originalHead,
    patch: {
      anchorLine: 4,
      anchorLines: [4],
      insertedCode: "        self.wait(2)\n",
    },
    patchedBlob: parseJsonEnvironment<SourceBlobReceiptV1>("POIETRA_RENDER_SESSION_E2E_PATCHED_BLOB"),
    programBatchId: "batch-render-session-e2e",
    programTransactionId: "transaction-render-session-e2e",
    renderRequestId: "request-render-session-e2e",
    sceneName: "MainScene",
    tenantId: originalHead.tenantId,
  } as const;
}

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE === undefined)("durable render-session child process fixture", () => {
  it("performs one durable render operation for the parent crash and concurrency proof", async () => {
    const role = parseChildRole(PROCESS_ROLE);
    const tenantId = process.env.POIETRA_RENDER_SESSION_E2E_TENANT_ID!;
    const sessionId = process.env.POIETRA_RENDER_SESSION_E2E_SESSION_ID!;

    if (role === "creator") {
      const repository = renderRepository();
      await repository.createSession(childSessionInput());
      const claimed = await repository.claimLease({
        brokerShardId: "render-session-e2e-shard",
        leaseDurationMs: 60_000,
        ownerId: "process-a-worker",
        sessionId,
        tenantId,
      });
      emitProcessResult({
        event: "claimed",
        fenceToken: claimed.fenceToken.toString(),
        version: claimed.version.toString(),
      });
      await new Promise<never>(() => undefined);
    }

    if (role === "worker-after-job") {
      const repository = renderRepository();
      const broker = new Pool({ connectionString: configuredDatabaseUrl(), max: 1 });
      const expectedSessionId = process.env.POIETRA_RENDER_SESSION_E2E_SESSION_ID!;
      let completedJobId = "";
      const blockingRepository = new Proxy(repository, {
        get(target, property) {
          if (property === "completeLease") {
            const blockCompletion: RenderSessionRepositoryV1["completeLease"] = async (input) => {
              if (input.sessionId !== expectedSessionId || completedJobId.length === 0) {
                throw new Error("The crash fixture observed an unexpected render completion.");
              }
              emitProcessResult({ event: "job-completed", jobId: completedJobId, kind: "broker" });
              return new Promise<never>(() => undefined);
            };
            return blockCompletion;
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as RenderSessionRepositoryV1;
      const executor: DurableManimRenderExecutorV1 = {
        async cancel() {
          return { fenceDigest: "0".repeat(64) };
        },
        async close() {
          await broker.end();
        },
        async cleanup() {},
        async ready() {
          return true;
        },
        async submitOrReattach(request) {
          if (request.session.id !== expectedSessionId) {
            throw new Error("The crash fixture claimed an unexpected render session.");
          }
          completedJobId = request.jobId;
          await broker.query(
            `INSERT INTO public.render_session_e2e_broker_jobs (job_id, artifact_locator, log_tail)
             VALUES ($1, $2, $3)
             ON CONFLICT (job_id) DO NOTHING`,
            [request.jobId, "artifact:reattached", "reattached broker result"],
          );
          return { artifactLocator: "artifact:reattached", kind: "ready", logTail: "reattached broker result" };
        },
      };
      const worker = new DurableManimRenderWorkerV1({
        brokerShardId: "render-session-e2e-shard",
        executor,
        leaseDurationMs: 60_000,
        maxConcurrentJobs: 1,
        onFailure: () => undefined,
        pollIntervalMs: 60_000,
        repository: blockingRepository,
        tenantId,
        workerId: "process-a-job-worker",
      });
      await worker.runOnce();
      throw new Error("The crash fixture unexpectedly published its completed broker job.");
    }

    await awaitProcessGate(role);
    if (role === "action" || role === "action-unknown") {
      const repository = renderRepository();
      try {
        const result = await repository.applySourceAction({
          actionId: process.env.POIETRA_RENDER_SESSION_E2E_ACTION_ID!,
          expectedKey: process.env.POIETRA_RENDER_SESSION_E2E_ACTION_KEY!,
          expectedSessionVersion: BigInt(process.env.POIETRA_RENDER_SESSION_E2E_SESSION_VERSION!),
          kind: process.env.POIETRA_RENDER_SESSION_E2E_ACTION_KIND as "commit" | "undo",
          sessionId,
          tenantId,
        });
        emitProcessResult({
          actionId: process.env.POIETRA_RENDER_SESSION_E2E_ACTION_ID!,
          actionKind: process.env.POIETRA_RENDER_SESSION_E2E_ACTION_KIND as "commit" | "undo",
          event: result.action.state === "succeeded" ? "winner" : "loser",
          kind: "action",
        });
        if (role === "action-unknown") await new Promise<never>(() => undefined);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 409) throw error;
        emitProcessResult({
          actionId: process.env.POIETRA_RENDER_SESSION_E2E_ACTION_ID!,
          actionKind: process.env.POIETRA_RENDER_SESSION_E2E_ACTION_KIND as "commit" | "undo",
          event: "loser",
          kind: "action",
          status: error.status,
        });
      } finally {
        await repository.close();
      }
      return;
    }

    const repository = sourceRepository();
    try {
      const expectedHead = sourceHeadFromEnvironment();
      const updated = await repository.compareAndSwapSource({
        candidate: parseJsonEnvironment<SourceBlobReceiptV1>("POIETRA_RENDER_SESSION_E2E_CAS_BLOB"),
        expectedDigest: expectedHead.blob.digest,
        expectedGeneration: expectedHead.generation,
        projectId: expectedHead.projectId,
        sourcePath: expectedHead.sourcePath,
        tenantId,
      });
      emitProcessResult({ digest: updated.blob.digest, event: "winner", kind: "cas" });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      emitProcessResult({ event: "loser", kind: "cas", status: error.status });
    } finally {
      await repository.close();
    }
  }, 30_000);
});

type ChildHandle = Readonly<{
  ready: Promise<void>;
  result: Promise<ChildResult>;
}>;

function markerPayload<T>(output: string, marker: string): T | null {
  const markerIndex = output.indexOf(marker);
  const lineEnd = markerIndex < 0 ? -1 : output.indexOf("\n", markerIndex);
  if (markerIndex < 0 || lineEnd < 0) return null;
  return JSON.parse(output.slice(markerIndex + marker.length, lineEnd)) as T;
}

function startChild(
  role: ChildRole,
  environment: Readonly<Record<string, string>>,
  options: Readonly<{ gated?: boolean; killAfterResult?: boolean }> = {},
): ChildHandle {
  const vitestEntry = fileURLToPath(new URL("../vitest.mjs", import.meta.resolve("vitest")));
  const testPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      vitestEntry,
      "run",
      testPath,
      "-t",
      "performs one durable render operation",
      "--pool=threads",
      "--maxWorkers=1",
      "--reporter=dot",
    ],
    {
      env: { ...process.env, ...environment, POIETRA_RENDER_SESSION_E2E_PROCESS_ROLE: role },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  let output = "";
  let parsedResult: ChildResult | null = null;
  let readySeen = !options.gated;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = options.gated
    ? new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      })
    : Promise.resolve();
  const inspectOutput = () => {
    if (!readySeen && markerPayload(output, PROCESS_READY_MARKER)) {
      readySeen = true;
      resolveReady();
    }
    parsedResult ??= markerPayload<ChildResult>(output, PROCESS_RESULT_MARKER);
    if (parsedResult && options.killAfterResult && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
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
  const result = (async () => {
    try {
      const status = await exit;
      inspectOutput();
      if (!readySeen) rejectReady(new Error(`Child ${role} exited before reaching the process gate.`));
      if (!parsedResult) {
        throw new Error(`Durable render-session child produced no result (${status.code}/${status.signal}): ${errors}`);
      }
      if (options.killAfterResult) {
        if (status.signal !== "SIGKILL") {
          throw new Error(`Creator was not terminated by SIGKILL (${status.code}/${status.signal}).`);
        }
      } else if (status.code !== 0) {
        throw new Error(`Durable render-session child failed with ${status.code}/${status.signal}: ${errors}`);
      }
      return parsedResult;
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  })();
  return {
    ready,
    result,
  };
}

async function runGatedChildren(pool: Pool, gateKey: string, start: () => readonly ChildHandle[]) {
  const gate = await pool.connect();
  let locked = false;
  try {
    await gate.query("SELECT pg_advisory_lock($1::bigint)", [gateKey]);
    locked = true;
    const children = start();
    const results = Promise.all(children.map((child) => child.result));
    try {
      await Promise.all(children.map((child) => child.ready));
      await gate.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]);
      locked = false;
      return await results;
    } catch (error) {
      await results.catch(() => undefined);
      throw error;
    }
  } finally {
    if (locked) await gate.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]).catch(() => undefined);
    gate.release();
  }
}

function digest(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function blobReceipt(tenantId: string, source: string): SourceBlobReceiptV1 {
  const sourceDigest = digest(source);
  return {
    byteSize: Buffer.byteLength(source, "utf8"),
    digest: sourceDigest,
    etag: sourceDigest,
    objectKey: `tenants/${tenantId}/sources/${sourceDigest}`,
    versionId: randomUUID(),
  };
}

function serializeHead(head: WorkspaceSourceHeadV1): SerializedSourceHead {
  return { ...head, generation: head.generation.toString() };
}

async function capturedError(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error("Expected the operation to fail.");
  } catch (error) {
    return error;
  }
}

async function renderUsageEvidence(pool: Pool, tenantId: string, sessionId: string) {
  const result = await pool.query<{ event_count: number; outcome: string | null; state: string }>(
    `SELECT reservation.state,
            count(event.operation_id)::integer AS event_count,
            min(event.outcome) AS outcome
       FROM public.usage_reservations reservation
       LEFT JOIN public.usage_events event
         ON event.tenant_id = reservation.tenant_id
        AND event.operation_kind = reservation.operation_kind
        AND event.operation_id = reservation.operation_id
      WHERE reservation.tenant_id = $1
        AND reservation.operation_kind = 'render'
        AND reservation.operation_id = $2::uuid
      GROUP BY reservation.state`,
    [tenantId, sessionId],
  );
  return result.rows[0] ?? null;
}

async function verifyRenderCpuFailureMigration(pool: Pool) {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("CREATE TABLE public.render_sessions (case_id text PRIMARY KEY, status text, error text)");
    await client.query(RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE);
    await client.query(
      `INSERT INTO public.render_sessions (case_id, status, error) VALUES
         ('cpu', 'failed', 'Render exceeded its CPU budget.'),
         ('memory', 'failed', 'Render exceeded its memory limit.')`,
    );
    const before = await client.query<{ case_id: string; failure_code: string }>(
      "SELECT case_id, failure_code FROM public.render_sessions ORDER BY case_id",
    );
    expect(before.rows).toEqual([
      { case_id: "cpu", failure_code: "render-failed" },
      { case_id: "memory", failure_code: "memory-limit" },
    ]);

    await client.query(RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE);
    const after = await client.query<{ case_id: string; failure_code: string }>(
      "SELECT case_id, failure_code FROM public.render_sessions ORDER BY case_id",
    );
    expect(after.rows).toEqual([
      { case_id: "cpu", failure_code: "cpu-limit" },
      { case_id: "memory", failure_code: "memory-limit" },
    ]);
    await client.query("ROLLBACK");
    began = false;
  } finally {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE !== undefined)("PostgreSQL durable render sessions", () => {
  it("survives SIGKILL and fences recovery, source actions, CAS, and tenant routing", async () => {
    const databaseUrl = configuredDatabaseUrl();
    const setupPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const sources = sourceRepository();
    const renders = renderRepository();
    const tenantId = `render-${randomUUID().replaceAll("-", "")}`;
    const otherTenantId = `other-${randomUUID().replaceAll("-", "")}`;
    const projectId = `project-${randomUUID().replaceAll("-", "")}`;
    const sessionId = randomUUID();
    const originalSource =
      "from manim import *\n\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(1)\n";
    const patchedSource = originalSource.replace("self.wait(1)", "self.wait(2)");
    const competingSource = originalSource.replace("self.wait(1)", "self.wait(3)");
    const originalBlob = blobReceipt(tenantId, originalSource);
    const patchedBlob = blobReceipt(tenantId, patchedSource);
    const competingBlob = blobReceipt(tenantId, competingSource);
    const commitCorrelationKey = "render-session-e2e-candidate";

    try {
      await verifyRenderCpuFailureMigration(setupPool);
      await applyBundledDurableStorageMigrations(setupPool);
      await setupPool.query(
        `CREATE TABLE public.render_session_e2e_broker_jobs (
           job_id text PRIMARY KEY,
           artifact_locator text NOT NULL,
           log_tail text NOT NULL
         )`,
      );
      await sources.ensureTenant(tenantId);
      await sources.ensureTenant(otherTenantId);
      await seedActiveRenderEntitlementFixtureV1(setupPool, tenantId);
      await sources.createManagedProject({
        name: "Durable render workspace",
        projectId,
        source: { blob: originalBlob, path: "main.py" },
        tenantId,
      });
      const originalHead = await sources.readSourceHead(tenantId, projectId, "main.py");
      const guardedSessionId = randomUUID();
      await renders.createSession({
        commitCorrelationKey: "usage-guard-candidate",
        executionTimeoutMs: 120_000,
        id: guardedSessionId,
        originalHead,
        patch: { anchorLine: 4, anchorLines: [4], insertedCode: "        self.wait(2)\n" },
        patchedBlob,
        programBatchId: "batch-usage-guard",
        programTransactionId: "transaction-usage-guard",
        renderRequestId: "request-usage-guard",
        sceneName: "MainScene",
        tenantId,
      });
      await expect(
        setupPool.query(
          `UPDATE public.render_sessions SET status = 'ready'
            WHERE tenant_id = $1 AND session_id = $2::uuid`,
          [tenantId, guardedSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(renders.readSession(tenantId, guardedSessionId)).resolves.toMatchObject({ status: "preparing" });
      await expect(renders.cancelSession(tenantId, guardedSessionId)).resolves.toMatchObject({ status: "cancelled" });
      const commonChildEnvironment = {
        POIETRA_RENDER_SESSION_E2E_COMMIT_KEY: commitCorrelationKey,
        POIETRA_RENDER_SESSION_E2E_ORIGINAL_HEAD: JSON.stringify(serializeHead(originalHead)),
        POIETRA_RENDER_SESSION_E2E_PATCHED_BLOB: JSON.stringify(patchedBlob),
        POIETRA_RENDER_SESSION_E2E_SESSION_ID: sessionId,
        POIETRA_RENDER_SESSION_E2E_TENANT_ID: tenantId,
      };

      const processA = startChild("creator", commonChildEnvironment, { killAfterResult: true });
      const firstClaim = await processA.result;
      expect(firstClaim).toMatchObject({ event: "claimed" });
      const reopened = await renders.readSession(tenantId, sessionId);
      expect(reopened).toMatchObject({
        fenceToken: BigInt(firstClaim.fenceToken!),
        status: "rendering",
        version: BigInt(firstClaim.version!),
      });

      await setupPool.query(
        `UPDATE public.render_sessions
            SET lease_expires_at = clock_timestamp() - interval '1 second'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenantId, sessionId],
      );
      expect(
        (await renders.findRecoverableSessions(tenantId, "render-session-e2e-shard", 16)).map((session) => session.id),
      ).toContain(sessionId);
      const secondClaim = await renders.claimLease({
        brokerShardId: "render-session-e2e-shard",
        leaseDurationMs: 60_000,
        ownerId: "process-b-worker",
        sessionId,
        tenantId,
      });
      expect(secondClaim.fenceToken).toBe(BigInt(firstClaim.fenceToken!) + 1n);
      expect(secondClaim.version).toBe(BigInt(firstClaim.version!) + 1n);
      const renewed = await renders.renewLease({
        expectedVersion: secondClaim.version,
        fenceToken: secondClaim.fenceToken,
        leaseDurationMs: 60_000,
        ownerId: "process-b-worker",
        sessionId,
        tenantId,
      });
      expect(renewed).toMatchObject({
        fenceToken: secondClaim.fenceToken,
        lease: { ownerId: "process-b-worker" },
        version: secondClaim.version,
      });

      await expect(
        renders.completeLease({
          artifactLocator: "artifact:stale",
          error: null,
          expectedVersion: BigInt(firstClaim.version!),
          failureCode: null,
          fenceToken: BigInt(firstClaim.fenceToken!),
          logTail: "stale worker",
          ownerId: "process-a-worker",
          progress: 1,
          sessionId,
          status: "ready",
          tenantId,
        }),
      ).rejects.toMatchObject({ status: 409 });
      const ready = await renders.completeLease({
        artifactLocator: "artifact:verified",
        error: null,
        expectedVersion: secondClaim.version,
        failureCode: null,
        fenceToken: secondClaim.fenceToken,
        logTail: "render complete",
        ownerId: "process-b-worker",
        progress: 1,
        sessionId,
        status: "ready",
        tenantId,
      });
      expect(ready).toMatchObject({ artifactLocator: "artifact:verified", status: "ready" });
      await expect(renderUsageEvidence(setupPool, tenantId, sessionId)).resolves.toEqual({
        event_count: 1,
        outcome: "committed",
        state: "committed",
      });

      const expiredSessionId = randomUUID();
      await renders.createSession({
        commitCorrelationKey: "expired-session-candidate",
        executionTimeoutMs: 1_000,
        id: expiredSessionId,
        originalHead,
        patch: { anchorLine: 4, anchorLines: [4], insertedCode: "        self.wait(2)\n" },
        patchedBlob,
        programBatchId: "batch-expired-session",
        programTransactionId: "transaction-expired-session",
        renderRequestId: "request-expired-session",
        sceneName: "MainScene",
        tenantId,
      });
      const expiredClaim = await renders.claimLease({
        brokerShardId: "render-session-e2e-shard",
        leaseDurationMs: 60_000,
        ownerId: "deadline-worker",
        sessionId: expiredSessionId,
        tenantId,
      });
      await setupPool.query(
        `UPDATE public.render_sessions
            SET execution_deadline = clock_timestamp() - interval '1 second'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenantId, expiredSessionId],
      );
      const expiredCompletion = {
        error: null,
        expectedVersion: expiredClaim.version,
        failureCode: null,
        fenceToken: expiredClaim.fenceToken,
        logTail: "deadline test",
        ownerId: "deadline-worker",
        progress: 1,
        sessionId: expiredSessionId,
        tenantId,
      } as const;
      await expect(
        renders.completeLease({ ...expiredCompletion, artifactLocator: "artifact:too-late", status: "ready" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        renders.completeLease({
          ...expiredCompletion,
          error: "Render exceeded its memory limit.",
          failureCode: "memory-limit",
          status: "failed",
        }),
      ).resolves.toMatchObject({
        error: "Render exceeded its memory limit.",
        failureCode: "memory-limit",
        lease: null,
        status: "failed",
      });
      await expect(renders.discardSession(tenantId, expiredSessionId)).resolves.toMatchObject({
        failureCode: "memory-limit",
        status: "discarded",
      });
      const failedUsage = await renderUsageEvidence(setupPool, tenantId, expiredSessionId);
      expect(failedUsage).toMatchObject({ event_count: 1, state: "released" });
      expect(["expired", "released"]).toContain(failedUsage?.outcome);

      const sweepSessionId = randomUUID();
      await renders.createSession({
        commitCorrelationKey: "timeout-sweep-candidate",
        executionTimeoutMs: 1_000,
        id: sweepSessionId,
        originalHead,
        patch: { anchorLine: 4, anchorLines: [4], insertedCode: "        self.wait(2)\n" },
        patchedBlob,
        programBatchId: "batch-timeout-sweep",
        programTransactionId: "transaction-timeout-sweep",
        renderRequestId: "request-timeout-sweep",
        sceneName: "MainScene",
        tenantId,
      });
      await setupPool.query(
        `UPDATE public.render_sessions
            SET execution_deadline = clock_timestamp() - interval '1 second'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenantId, sweepSessionId],
      );
      await expect(renders.expireTimedOutSessions(tenantId, 16)).resolves.toBe(1);
      await expect(renders.readSession(tenantId, sweepSessionId)).resolves.toMatchObject({
        error: "Render execution deadline exceeded.",
        failureCode: "deadline-exceeded",
        lease: null,
        status: "failed",
      });
      const expiredUsage = await renderUsageEvidence(setupPool, tenantId, sweepSessionId);
      expect(expiredUsage).toMatchObject({ event_count: 1, state: "released" });
      expect(["expired", "released"]).toContain(expiredUsage?.outcome);

      const createRollingSession = (id: string, label: string) =>
        renders.createSession({
          commitCorrelationKey: `${label}-candidate`,
          executionTimeoutMs: 120_000,
          id,
          originalHead,
          patch: { anchorLine: 4, anchorLines: [4], insertedCode: "        self.wait(2)\n" },
          patchedBlob,
          programBatchId: `batch-${label}`,
          programTransactionId: `transaction-${label}`,
          renderRequestId: `request-${label}`,
          sceneName: "MainScene",
          tenantId,
        });
      const rollingFailureSessionId = randomUUID();
      await createRollingSession(rollingFailureSessionId, "rolling-failure-code");
      await mutateRenderSessionWithUsageFixtureV1(setupPool, {
        mutate: (client) =>
          client.query(
            `UPDATE public.render_sessions
                SET status = 'failed',
                    error = 'Render exceeded its process limit.'
              WHERE tenant_id = $1 AND session_id = $2::uuid`,
            [tenantId, rollingFailureSessionId],
          ),
        sessionId: rollingFailureSessionId,
        target: "released",
        tenantId,
      });
      await expect(renders.readSession(tenantId, rollingFailureSessionId)).resolves.toMatchObject({
        failureCode: "pids-limit",
        status: "failed",
      });
      await setupPool.query(
        `UPDATE public.render_sessions
            SET status = 'discarded'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenantId, rollingFailureSessionId],
      );
      await expect(renders.readSession(tenantId, rollingFailureSessionId)).resolves.toMatchObject({
        failureCode: "pids-limit",
        status: "discarded",
      });

      const rollingUnknownDiscardSessionId = randomUUID();
      await createRollingSession(rollingUnknownDiscardSessionId, "rolling-unknown-discard");
      await mutateRenderSessionWithUsageFixtureV1(setupPool, {
        mutate: (client) =>
          client.query(
            `UPDATE public.render_sessions
                SET status = 'discarded'
              WHERE tenant_id = $1 AND session_id = $2::uuid`,
            [tenantId, rollingUnknownDiscardSessionId],
          ),
        sessionId: rollingUnknownDiscardSessionId,
        target: "released",
        tenantId,
      });
      await expect(renders.readSession(tenantId, rollingUnknownDiscardSessionId)).resolves.toMatchObject({
        failureCode: null,
        status: "discarded",
      });

      const brokerSessionId = randomUUID();
      await renders.createSession({
        commitCorrelationKey: "broker-crash-candidate",
        executionTimeoutMs: 120_000,
        id: brokerSessionId,
        originalHead,
        patch: { anchorLine: 4, anchorLines: [4], insertedCode: "        self.wait(2)\n" },
        patchedBlob,
        programBatchId: "batch-broker-crash",
        programTransactionId: "transaction-broker-crash",
        renderRequestId: "request-broker-crash",
        sceneName: "MainScene",
        tenantId,
      });
      // Process A persists the external job result and is killed after the
      // executor returns but before completeLease can publish it.
      const crashedWorker = startChild(
        "worker-after-job",
        {
          POIETRA_RENDER_SESSION_E2E_SESSION_ID: brokerSessionId,
          POIETRA_RENDER_SESSION_E2E_TENANT_ID: tenantId,
        },
        { killAfterResult: true },
      );
      const completedBrokerJob = await crashedWorker.result;
      const expectedJobId = durableManimRenderJobIdV1(tenantId, brokerSessionId);
      expect(completedBrokerJob).toMatchObject({
        event: "job-completed",
        jobId: expectedJobId,
        kind: "broker",
      });
      await expect(renders.readSession(tenantId, brokerSessionId)).resolves.toMatchObject({ status: "rendering" });
      await setupPool.query(
        `UPDATE public.render_sessions
            SET lease_expires_at = clock_timestamp() - interval '1 second'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenantId, brokerSessionId],
      );
      let reattachCount = 0;
      const recoveringExecutor: DurableManimRenderExecutorV1 = {
        async cancel() {
          return { fenceDigest: "0".repeat(64) };
        },
        async close() {},
        async cleanup() {},
        async ready() {
          return true;
        },
        async submitOrReattach(request) {
          reattachCount += 1;
          const stored = await setupPool.query<{ artifact_locator: string; log_tail: string }>(
            `SELECT artifact_locator, log_tail
               FROM public.render_session_e2e_broker_jobs
              WHERE job_id = $1`,
            [request.jobId],
          );
          const result = stored.rows[0];
          if (!result) return { code: "interrupted", kind: "failed", logTail: "" };
          return {
            artifactLocator: result.artifact_locator,
            kind: "ready",
            logTail: result.log_tail,
          };
        },
      };
      const recoveringWorker = new DurableManimRenderWorkerV1({
        brokerShardId: "render-session-e2e-shard",
        executor: recoveringExecutor,
        leaseDurationMs: 60_000,
        maxConcurrentJobs: 1,
        onFailure: (error) => {
          throw error;
        },
        pollIntervalMs: 60_000,
        repository: renders,
        tenantId,
        workerId: "process-b-job-worker",
      });
      try {
        await recoveringWorker.runOnce();
      } finally {
        await recoveringWorker.close();
      }
      expect(reattachCount).toBe(1);
      await expect(renders.readSession(tenantId, brokerSessionId)).resolves.toMatchObject({
        artifactLocator: "artifact:reattached",
        executionAttempts: 2,
        status: "ready",
      });
      await expect(renderUsageEvidence(setupPool, tenantId, brokerSessionId)).resolves.toEqual({
        event_count: 1,
        outcome: "committed",
        state: "committed",
      });

      const commitActionId = randomUUID();
      const commitUndoGate = "8135001";
      const sourceActionEnvironment = {
        ...commonChildEnvironment,
        POIETRA_RENDER_SESSION_E2E_GATE_KEY: commitUndoGate,
        POIETRA_RENDER_SESSION_E2E_SESSION_VERSION: ready.version.toString(),
      };
      const sourceActionContenders = await runGatedChildren(setupPool, commitUndoGate, () => [
        startChild(
          "action-unknown",
          {
            ...sourceActionEnvironment,
            POIETRA_RENDER_SESSION_E2E_ACTION_ID: commitActionId,
            POIETRA_RENDER_SESSION_E2E_ACTION_KEY: commitCorrelationKey,
            POIETRA_RENDER_SESSION_E2E_ACTION_KIND: "commit",
          },
          { gated: true, killAfterResult: true },
        ),
        startChild(
          "action",
          {
            ...sourceActionEnvironment,
            POIETRA_RENDER_SESSION_E2E_ACTION_ID: randomUUID(),
            POIETRA_RENDER_SESSION_E2E_ACTION_KEY: "undo",
            POIETRA_RENDER_SESSION_E2E_ACTION_KIND: "undo",
          },
          { gated: true },
        ),
      ]);
      expect(sourceActionContenders.map((result) => result.event).sort()).toEqual(["loser", "winner"]);
      expect(sourceActionContenders.find((result) => result.event === "winner")).toMatchObject({
        actionId: commitActionId,
        actionKind: "commit",
      });
      const committedSession = await renders.readSession(tenantId, sessionId);
      expect(committedSession).toMatchObject({
        latestAction: { id: commitActionId, outcome: "committed", state: "succeeded" },
        status: "committed",
      });
      const headAfterCommit = await sources.readSourceHead(tenantId, projectId, "main.py");
      const replayed = await renders.applySourceAction({
        actionId: commitActionId,
        expectedKey: commitCorrelationKey,
        expectedSessionVersion: ready.version,
        kind: "commit",
        sessionId,
        tenantId,
      });
      expect(replayed.action).toEqual(committedSession.latestAction);
      expect(replayed.executed).toBe(false);
      expect(await sources.readSourceHead(tenantId, projectId, "main.py")).toEqual(headAfterCommit);

      const raceEnvironment = {
        ...commonChildEnvironment,
        POIETRA_RENDER_SESSION_E2E_ACTION_ID: randomUUID(),
        POIETRA_RENDER_SESSION_E2E_ACTION_KEY: "undo",
        POIETRA_RENDER_SESSION_E2E_ACTION_KIND: "undo",
        POIETRA_RENDER_SESSION_E2E_CAS_BLOB: JSON.stringify(competingBlob),
        POIETRA_RENDER_SESSION_E2E_GATE_KEY: "8135002",
        POIETRA_RENDER_SESSION_E2E_ORIGINAL_HEAD: JSON.stringify(serializeHead(headAfterCommit)),
        POIETRA_RENDER_SESSION_E2E_SESSION_VERSION: committedSession.version.toString(),
      };
      const contenders = await runGatedChildren(setupPool, "8135002", () => [
        startChild("action", raceEnvironment, { gated: true }),
        startChild("cas", raceEnvironment, { gated: true }),
      ]);
      expect(contenders.map((result) => result.event).sort()).toEqual(["loser", "winner"]);
      const winner = contenders.find((result) => result.event === "winner")!;
      const finalHead = await sources.readSourceHead(tenantId, projectId, "main.py");
      const finalSession = await renders.readSession(tenantId, sessionId);
      if (winner.kind === "action") {
        expect(finalHead.blob.digest).toBe(originalBlob.digest);
        expect(finalSession.status).toBe("undone");
      } else {
        expect(finalHead.blob.digest).toBe(competingBlob.digest);
        expect(finalSession.status).toBe("committed");
      }
      await expect(renderUsageEvidence(setupPool, tenantId, sessionId)).resolves.toEqual({
        event_count: 1,
        outcome: "committed",
        state: "committed",
      });

      const crossTenantError = await capturedError(renders.readSession(otherTenantId, sessionId));
      const missingError = await capturedError(renders.readSession(tenantId, randomUUID()));
      expect(crossTenantError).toMatchObject({ message: (missingError as Error).message, status: 404 });
      expect(missingError).toMatchObject({ status: 404 });
    } finally {
      await Promise.allSettled([renders.close(), sources.close(), setupPool.end()]);
    }
  }, 90_000);

  it("binds one broker shard and cancels only after its durable ACK", async () => {
    const setupPool = new Pool({ connectionString: configuredDatabaseUrl(), max: 2 });
    const sources = sourceRepository();
    const workerRepository = renderRepository();
    const apiRepository = renderRepository();
    let reopenedRepository: PostgresRenderSessionRepositoryV1 | null = null;
    const tenantId = `cancel-${randomUUID().replaceAll("-", "")}`;
    const projectId = `project-${randomUUID().replaceAll("-", "")}`;
    const sessionId = randomUUID();
    const source = "from manim import *\n\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(1)\n";
    const sourceBlob = blobReceipt(tenantId, source);
    const shardA = "render-shard-a";
    const shardB = "render-shard-b";
    const relayId = "render-relay-b";
    const fenceDigest = "a".repeat(64);

    try {
      await applyBundledDurableStorageMigrations(setupPool);
      await sources.ensureTenant(tenantId);
      await seedActiveRenderEntitlementFixtureV1(setupPool, tenantId);
      await sources.createManagedProject({
        name: "Cancellation authority workspace",
        projectId,
        source: { blob: sourceBlob, path: "main.py" },
        tenantId,
      });
      const originalHead = await sources.readSourceHead(tenantId, projectId, "main.py");
      await workerRepository.createSession({
        commitCorrelationKey: "cancel-authority-candidate",
        executionTimeoutMs: 120_000,
        id: sessionId,
        originalHead,
        patch: { anchorLine: 4, anchorLines: [4], insertedCode: "        self.wait(2)\n" },
        patchedBlob: sourceBlob,
        programBatchId: "batch-cancel-authority",
        programTransactionId: "transaction-cancel-authority",
        renderRequestId: "request-cancel-authority",
        sceneName: "MainScene",
        tenantId,
      });
      const claimed = await workerRepository.claimLease({
        brokerShardId: shardB,
        leaseDurationMs: 60_000,
        ownerId: "render-worker-b",
        sessionId,
        tenantId,
      });
      await expect(
        setupPool.query(
          `UPDATE public.render_sessions
              SET broker_shard_id = $3
            WHERE tenant_id = $1 AND session_id = $2::uuid`,
          [tenantId, sessionId, shardA],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const registered = await apiRepository.registerCancellation(tenantId, sessionId);
      expect(registered).toMatchObject({
        intent: {
          acknowledgedAt: null,
          brokerShardId: shardB,
          delivery: null,
          jobId: `${tenantId}/${sessionId}`,
        },
        session: { status: "rendering" },
      });
      await expect(apiRepository.registerCancellation(tenantId, sessionId)).resolves.toMatchObject({
        intent: { acknowledgedAt: null, brokerShardId: shardB, jobId: `${tenantId}/${sessionId}` },
        session: { status: "rendering" },
      });
      await expect(
        setupPool.query(
          `UPDATE public.render_sessions SET status = 'ready'
            WHERE tenant_id = $1 AND session_id = $2::uuid`,
          [tenantId, sessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        setupPool.query(
          `UPDATE public.render_sessions SET status = 'cancelled'
            WHERE tenant_id = $1 AND session_id = $2::uuid`,
          [tenantId, sessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(apiRepository.cancelSession(tenantId, sessionId)).rejects.toMatchObject({ status: 409 });
      await expect(apiRepository.abandonSession(tenantId, sessionId, "request-cancel-authority")).rejects.toMatchObject(
        { status: 409 },
      );
      await expect(
        workerRepository.completeLease({
          artifactLocator: "artifact:must-not-publish",
          error: null,
          expectedVersion: claimed.version,
          failureCode: null,
          fenceToken: claimed.fenceToken,
          logTail: "late publication",
          ownerId: "render-worker-b",
          progress: 1,
          sessionId,
          status: "ready",
          tenantId,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        workerRepository.claimLease({
          brokerShardId: shardA,
          leaseDurationMs: 60_000,
          ownerId: "render-worker-a",
          sessionId,
          tenantId,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        apiRepository.claimCancellationDeliveries({
          brokerShardId: shardA,
          leaseDurationMs: 30_000,
          maximum: 4,
          ownerId: "render-relay-a",
          tenantId,
        }),
      ).resolves.toEqual([]);
      const deliveries = await workerRepository.claimCancellationDeliveries({
        brokerShardId: shardB,
        leaseDurationMs: 30_000,
        maximum: 4,
        ownerId: relayId,
        tenantId,
      });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        brokerShardId: shardB,
        delivery: { ownerId: relayId, token: 1n },
        sessionId,
        tenantId,
      });

      await setupPool.query(
        `UPDATE public.render_sessions
            SET execution_deadline = clock_timestamp() - interval '1 second'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenantId, sessionId],
      );
      await expect(apiRepository.expireTimedOutSessions(tenantId, 4)).resolves.toBe(0);

      const acknowledgement = {
        deliveryToken: deliveries[0]!.delivery.token,
        fenceDigest,
        ownerId: relayId,
        sessionId,
        tenantId,
      } as const;
      await expect(workerRepository.acknowledgeCancellation(acknowledgement)).resolves.toMatchObject({
        failureCode: "cancelled",
        lease: null,
        status: "cancelled",
      });
      await expect(apiRepository.acknowledgeCancellation(acknowledgement)).resolves.toMatchObject({
        status: "cancelled",
      });
      await setupPool.query(
        `UPDATE public.render_sessions
            SET updated_at = clock_timestamp() - interval '2 minutes'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenantId, sessionId],
      );
      await expect(
        apiRepository.releaseExpiredInputs({ maximum: 4, retentionMs: 60_000, tenantId }),
      ).resolves.toMatchObject({ releasedSessionIds: [] });
      await expect(apiRepository.acknowledgeCancellation(acknowledgement)).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(apiRepository.discardSession(tenantId, sessionId)).resolves.toMatchObject({
        failureCode: "cancelled",
        status: "discarded",
      });
      await expect(renderUsageEvidence(setupPool, tenantId, sessionId)).resolves.toEqual({
        event_count: 1,
        outcome: "released",
        state: "released",
      });
      await apiRepository.close();
      reopenedRepository = renderRepository();
      await expect(reopenedRepository.readCancellation(tenantId, sessionId)).resolves.toMatchObject({
        acknowledgedAt: expect.any(Date),
        delivery: null,
        fenceDigest,
      });
      await expect(reopenedRepository.acknowledgeCancellation(acknowledgement)).resolves.toMatchObject({
        status: "discarded",
      });
      await setupPool.query(
        `DELETE FROM public.render_cancellation_intents
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenantId, sessionId],
      );
      await expect(reopenedRepository.registerCancellation(tenantId, sessionId)).resolves.toMatchObject({
        intent: null,
        session: { status: "discarded" },
      });
      await expect(
        workerRepository.completeLease({
          artifactLocator: "artifact:late-after-ack",
          error: null,
          expectedVersion: claimed.version,
          failureCode: null,
          fenceToken: claimed.fenceToken,
          logTail: "late after ACK",
          ownerId: "render-worker-b",
          progress: 1,
          sessionId,
          status: "ready",
          tenantId,
        }),
      ).rejects.toMatchObject({ status: 409 });

      const boundarySessionId = randomUUID();
      await workerRepository.createSession({
        commitCorrelationKey: "cancel-boundary-candidate",
        executionTimeoutMs: 120_000,
        id: boundarySessionId,
        originalHead,
        patch: { anchorLine: 4, anchorLines: [4], insertedCode: "        self.wait(2)\n" },
        patchedBlob: sourceBlob,
        programBatchId: "batch-cancel-boundary",
        programTransactionId: "transaction-cancel-boundary",
        renderRequestId: "request-cancel-boundary",
        sceneName: "MainScene",
        tenantId,
      });
      await workerRepository.claimLease({
        brokerShardId: shardB,
        leaseDurationMs: 60_000,
        ownerId: "render-worker-boundary",
        sessionId: boundarySessionId,
        tenantId,
      });
      await setupPool.query(
        `UPDATE public.render_sessions
            SET execution_deadline = clock_timestamp() - interval '27 seconds'
          WHERE tenant_id = $1 AND session_id = $2::uuid`,
        [tenantId, boundarySessionId],
      );
      const capacityGate = await setupPool.connect();
      let gateOpen = false;
      try {
        await capacityGate.query("BEGIN");
        gateOpen = true;
        await capacityGate.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          "render-cancellation-capacity:v1",
        ]);
        const boundaryRegistration = workerRepository.registerCancellation(tenantId, boundarySessionId);
        let waitingOnCapacity = false;
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const waiting = await setupPool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_locks
                WHERE locktype = 'advisory' AND NOT granted
             ) AS waiting`,
          );
          waitingOnCapacity = waiting.rows[0]?.waiting === true;
          if (waitingOnCapacity) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waitingOnCapacity).toBe(true);
        let fenceExpired = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const expiry = await setupPool.query<{ expired: boolean }>(
            `SELECT execution_deadline + interval '30 seconds' <= clock_timestamp() AS expired
               FROM public.render_sessions
              WHERE tenant_id = $1 AND session_id = $2::uuid`,
            [tenantId, boundarySessionId],
          );
          fenceExpired = expiry.rows[0]?.expired === true;
          if (fenceExpired) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(fenceExpired).toBe(true);
        await capacityGate.query("COMMIT");
        gateOpen = false;
        await expect(boundaryRegistration).resolves.toMatchObject({ intent: null, session: { status: "cancelled" } });
        await expect(workerRepository.readCancellation(tenantId, boundarySessionId)).resolves.toBeNull();
      } finally {
        if (gateOpen) await capacityGate.query("ROLLBACK").catch(() => undefined);
        capacityGate.release();
      }
    } finally {
      await Promise.allSettled([
        reopenedRepository?.close(),
        apiRepository.close(),
        workerRepository.close(),
        sources.close(),
        setupPool.end(),
      ]);
    }
  }, 30_000);
});
