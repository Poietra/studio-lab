import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as createRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { FastManimGatedOciDockerClientV1 } from "../fast-manim-gated-oci-job-runner";
import { HttpError } from "../http/json";
import type { ManimApi } from "../manim-api";
import { createTrustedLocalManimRequestContext } from "../manim-local-request-context";
import { ManimRenderGatedOciJobRunnerV1 } from "../manim-render-gated-oci-job-runner";
import { handleManimRequest } from "../manim-render-http";
import { ManimRenderGatedOciBackendV1 } from "../manim-render-sandbox-backend";
import {
  decodeManimRenderStagingLocatorV1,
  encodeManimRenderStagingLocatorV1,
  MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
  SealedManimRenderSandboxRequestV2,
} from "../manim-render-sandbox-contract";
import { AuthorizedArtifactReaderV1 } from "./authorized-artifact-reader";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresArtifactRepositoryV1 } from "./postgres/postgres-artifact-repository";
import { PostgresRenderSessionRepositoryV1 } from "./postgres/postgres-render-session-repository";
import { PostgresWorkspaceSourceRepositoryV1 } from "./postgres/postgres-workspace-source-repository";
import {
  type PublishRenderArtifactsInputV1,
  RenderArtifactReadErrorV1,
  type RenderArtifactReceiptV1,
  type RenderArtifactStoreV1,
} from "./render-artifact-repository";
import { runRenderArtifactGcV1 } from "./render-artifact-gc";
import type { DurableRenderSessionV1 } from "./render-session-repository";
import { S3ArtifactReaderV1 } from "./s3/s3-artifact-reader";
import { VerifiedArtifactPublisherV1 } from "./verified-artifact-publisher";
import type { SourceBlobReceiptV1, WorkspaceSourceHeadV1 } from "./workspace-source-repository";

const PROCESS_ROLE = process.env.POIETRA_RENDER_ARTIFACT_E2E_PROCESS_ROLE;
const PROCESS_MARKER = "POIETRA_RENDER_ARTIFACT_E2E_RESULT=";
const E2E_CONFIGURED = [
  "POIETRA_STORAGE_E2E_DATABASE_URL",
  "POIETRA_STORAGE_E2E_S3_ENDPOINT",
  "POIETRA_STORAGE_E2E_S3_BUCKET",
  "POIETRA_STORAGE_E2E_S3_ACCESS_KEY",
  "POIETRA_STORAGE_E2E_S3_SECRET_KEY",
].every((key) => Boolean(process.env[key]));
const PROFILE_DIGEST = "a".repeat(64);
const RUNTIME_DIGEST = "b".repeat(64);
const MAX_EXPIRATION_MS = 30 * 24 * 60 * 60_000;
const REAL_OCI_IMAGE = process.env.POIETRA_MANIM_RENDER_GATED_OCI_IMAGE;
const REAL_OCI_ENABLED = /^sha256:[a-f0-9]{64}$/u.test(REAL_OCI_IMAGE ?? "");
const RENDER_SECCOMP_PATH = fileURLToPath(
  new URL("../../sandbox/fast-manim-gated-oci/seccomp.v1.json", import.meta.url),
);

type StorageEnvironment = Readonly<{
  accessKeyId: string;
  bucket: string;
  databaseUrl: string;
  endpoint: string;
  secretAccessKey: string;
}>;

type SerializedPublicationInput = Readonly<{
  expectedVersion: string;
  fenceToken: string;
  ownerId: string;
  sessionId: string;
  sourceDigest: string;
  tenantId: string;
  thumbnailBase64: string;
  videoBase64: string;
}>;

type PublishedChildResult = Readonly<{
  thumbnail: RenderArtifactReceiptV1;
  video: RenderArtifactReceiptV1;
}>;

function storageEnvironment(): StorageEnvironment {
  if (!E2E_CONFIGURED) throw new Error("The render-artifact storage E2E environment is incomplete.");
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

function artifactStore() {
  const environment = storageEnvironment();
  return new S3ArtifactReaderV1({
    bucket: environment.bucket,
    clientConfig: s3Config(environment),
    deployment: "test",
  });
}

function artifactRepository() {
  return new PostgresArtifactRepositoryV1({
    poolConfig: { connectionString: storageEnvironment().databaseUrl, max: 6 },
  });
}

function renderRepository() {
  return new PostgresRenderSessionRepositoryV1({
    poolConfig: { connectionString: storageEnvironment().databaseUrl, max: 3 },
  });
}

function sourceRepository() {
  return new PostgresWorkspaceSourceRepositoryV1({
    poolConfig: { connectionString: storageEnvironment().databaseUrl, max: 3 },
  });
}

function digest(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceBlob(tenantId: string, source: string): SourceBlobReceiptV1 {
  const sourceDigest = digest(source);
  return {
    byteSize: Buffer.byteLength(source, "utf8"),
    digest: sourceDigest,
    etag: `"${sourceDigest}"`,
    objectKey: `tenants/${tenantId}/sources/${sourceDigest}`,
    versionId: randomUUID(),
  };
}

function mediaInput(kind: "thumbnail" | "video", bytes: Buffer, sourceDigest: string, requestNonce: string) {
  return {
    artifactDigest: digest(bytes),
    byteSize: bytes.byteLength,
    bytes,
    kind,
    mediaType: kind === "video" ? ("video/mp4" as const) : ("image/png" as const),
    profileDigest: PROFILE_DIGEST,
    requestDigest: digest(`${requestNonce}:${kind}`),
    runtimeDigest: RUNTIME_DIGEST,
    sourceDigest,
  };
}

function childInputFromEnvironment(): SerializedPublicationInput {
  const serialized = process.env.POIETRA_RENDER_ARTIFACT_E2E_INPUT;
  if (!serialized) throw new Error("The render-artifact publisher child is missing its input.");
  return JSON.parse(serialized) as SerializedPublicationInput;
}

async function publishFromChild(input: SerializedPublicationInput) {
  const store = artifactStore();
  const repository = artifactRepository();
  try {
    const videoBytes = Buffer.from(input.videoBase64, "base64");
    const thumbnailBytes = Buffer.from(input.thumbnailBase64, "base64");
    const video = await store.put(input.tenantId, mediaInput("video", videoBytes, input.sourceDigest, input.sessionId));
    const thumbnail = await store.put(
      input.tenantId,
      mediaInput("thumbnail", thumbnailBytes, input.sourceDigest, input.sessionId),
    );
    await repository.publishSessionArtifacts({
      artifacts: {
        thumbnail: { artifactId: randomUUID(), receipt: thumbnail },
        video: { artifactId: randomUUID(), receipt: video },
      },
      expectedVersion: BigInt(input.expectedVersion),
      expirationMs: MAX_EXPIRATION_MS,
      fenceToken: BigInt(input.fenceToken),
      logTail: "published by process A",
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      tenantId: input.tenantId,
    });
    process.stdout.write(`${PROCESS_MARKER}${JSON.stringify({ thumbnail, video })}\n`);
    await new Promise<never>(() => undefined);
  } finally {
    await Promise.allSettled([store.close(), repository.close()]);
  }
}

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE !== "publisher")("durable render artifact publisher child", () => {
  it("publishes an atomic render bundle and waits for SIGKILL", async () => {
    await publishFromChild(childInputFromEnvironment());
  }, 30_000);
});

function parseMarker(output: string): PublishedChildResult | null {
  const marker = output.indexOf(PROCESS_MARKER);
  const end = marker < 0 ? -1 : output.indexOf("\n", marker);
  if (marker < 0 || end < 0) return null;
  return JSON.parse(output.slice(marker + PROCESS_MARKER.length, end)) as PublishedChildResult;
}

async function runPublisherChild(input: SerializedPublicationInput) {
  const vitestEntry = fileURLToPath(new URL("../vitest.mjs", import.meta.resolve("vitest")));
  const testPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      vitestEntry,
      "run",
      testPath,
      "-t",
      "publishes an atomic render bundle and waits for SIGKILL",
      "--pool=threads",
      "--maxWorkers=1",
      "--reporter=dot",
    ],
    {
      env: {
        ...process.env,
        POIETRA_RENDER_ARTIFACT_E2E_INPUT: JSON.stringify(input),
        POIETRA_RENDER_ARTIFACT_E2E_PROCESS_ROLE: "publisher",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  let result: PublishedChildResult | null = null;
  let killAttempted = false;
  child.stdout.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
    result ??= parseMarker(output);
    if (result && child.exitCode === null && child.signalCode === null) {
      killAttempted = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors = `${errors}${chunk.toString("utf8")}`.slice(-8_192);
  });
  let spawnError: unknown;
  child.once("error", (error) => {
    spawnError = error;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
  try {
    const status = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    result ??= parseMarker(output);
    if (spawnError) throw new Error("The render-artifact publisher child could not start.", { cause: spawnError });
    if (!result) throw new Error(`The render-artifact publisher child produced no result: ${errors || output}`);
    if (!killAttempted || status.signal !== "SIGKILL") {
      throw new Error(
        `The render-artifact publisher child did not terminate by SIGKILL (${status.code}/${status.signal}).`,
      );
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

async function createProject(
  repository: PostgresWorkspaceSourceRepositoryV1,
  tenantId: string,
  projectId: string,
  source: string,
) {
  const blob = sourceBlob(tenantId, source);
  await repository.ensureTenant(tenantId);
  await repository.createManagedProject({
    name: `Artifact project ${projectId}`,
    projectId,
    source: { blob, path: "main.py" },
    tenantId,
  });
  return repository.readSourceHead(tenantId, projectId, "main.py");
}

async function createClaimedSession(
  repository: PostgresRenderSessionRepositoryV1,
  originalHead: WorkspaceSourceHeadV1,
  label: string,
) {
  const sessionId = randomUUID();
  await repository.createSession({
    commitCorrelationKey: `commit-${label}`,
    executionTimeoutMs: 120_000,
    id: sessionId,
    originalHead,
    patch: { anchorLine: 1, anchorLines: [1], insertedCode: "" },
    patchedBlob: originalHead.blob,
    programBatchId: `batch-${label}`,
    programTransactionId: `transaction-${label}`,
    renderRequestId: `request-${label}`,
    sceneName: "MainScene",
    tenantId: originalHead.tenantId,
  });
  return repository.claimLease({
    leaseDurationMs: 60_000,
    ownerId: `worker-${label}`,
    sessionId,
    tenantId: originalHead.tenantId,
  });
}

async function collect(iterable: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function listenForMedia(api: ManimApi) {
  const server = createServer((request, response) => {
    void handleManimRequest(createTrustedLocalManimRequestContext(api, "test"), request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function requestMedia(
  port: number,
  path: string,
  options: Readonly<{ headers?: Record<string, string>; method?: string }> = {},
) {
  return new Promise<Readonly<{ body: Buffer; headers: import("node:http").IncomingHttpHeaders; status: number }>>(
    (resolve, reject) => {
      const request = createRequest(
        { headers: options.headers, host: "127.0.0.1", method: options.method, path, port },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () =>
            resolve({
              body: Buffer.concat(chunks),
              headers: response.headers,
              status: response.statusCode ?? 0,
            }),
          );
        },
      );
      request.once("error", reject);
      request.end();
    },
  );
}

async function readSessionVideo(reader: AuthorizedArtifactReaderV1, sessionId: string, start?: number, end?: number) {
  const asset = await reader.sessionVideo(sessionId);
  try {
    const range = start === undefined || end === undefined ? null : { end, start };
    const body = await asset.open(range);
    return await collect(body);
  } finally {
    await asset.close();
  }
}

function publicationInput(
  session: DurableRenderSessionV1,
  receipts: Readonly<{ thumbnail: RenderArtifactReceiptV1; video: RenderArtifactReceiptV1 }>,
): PublishRenderArtifactsInputV1 {
  if (!session.lease) throw new Error("The E2E session is not leased.");
  return {
    artifacts: {
      thumbnail: { artifactId: randomUUID(), receipt: receipts.thumbnail },
      video: { artifactId: randomUUID(), receipt: receipts.video },
    },
    expectedVersion: session.version,
    expirationMs: 60_000,
    fenceToken: session.fenceToken,
    logTail: "real storage E2E",
    ownerId: session.lease.ownerId,
    sessionId: session.id,
    tenantId: session.tenantId,
  };
}

async function putBundle(
  store: RenderArtifactStoreV1,
  session: DurableRenderSessionV1,
  video: Buffer,
  thumbnail: Buffer,
) {
  return {
    thumbnail: await store.put(
      session.tenantId,
      mediaInput("thumbnail", thumbnail, session.patched.blob.digest, session.id),
    ),
    video: await store.put(session.tenantId, mediaInput("video", video, session.patched.blob.digest, session.id)),
  };
}

async function setVideoExpiry(pool: Pool, receipt: RenderArtifactReceiptV1, live: boolean) {
  if (live) {
    await pool.query(
      `UPDATE public.render_artifact_objects
          SET expires_at = clock_timestamp() + interval '1 hour'
        WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3`,
      [receipt.objectKey.split("/")[1], receipt.objectKey, receipt.versionId],
    );
    await pool.query(
      `UPDATE public.render_session_artifacts
          SET expires_at = clock_timestamp() + interval '1 hour'
        WHERE tenant_id = $1 AND artifact_id = (
          SELECT artifact_id FROM public.render_artifact_objects
           WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3
        )`,
      [receipt.objectKey.split("/")[1], receipt.objectKey, receipt.versionId],
    );
    return;
  }
  await pool.query(
    `UPDATE public.render_artifact_objects
        SET created_at = clock_timestamp() - interval '2 hours',
            expires_at = clock_timestamp() - interval '1 hour'
      WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3`,
    [receipt.objectKey.split("/")[1], receipt.objectKey, receipt.versionId],
  );
  await pool.query(
    `UPDATE public.render_session_artifacts
        SET created_at = clock_timestamp() - interval '2 hours',
            expires_at = clock_timestamp() - interval '1 hour'
      WHERE tenant_id = $1 AND artifact_id = (
        SELECT artifact_id FROM public.render_artifact_objects
         WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3
      )`,
    [receipt.objectKey.split("/")[1], receipt.objectKey, receipt.versionId],
  );
}

async function lockArtifactRow(client: PoolClient, tenantId: string, receipt: RenderArtifactReceiptV1) {
  await client.query("BEGIN");
  await client.query(
    `SELECT 1 FROM public.render_artifact_objects
      WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3
      FOR UPDATE`,
    [tenantId, receipt.objectKey, receipt.versionId],
  );
}

async function waitForAdvisoryLock(pool: Pool, key: string) {
  const probe = await pool.connect();
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await probe.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [key],
      );
      if (result.rows[0]?.acquired === false) return;
      await probe.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The render artifact operation did not acquire its advisory lock.");
  } finally {
    probe.release();
  }
}

function lockKey(tenantId: string, receipt: RenderArtifactReceiptV1) {
  return `render-artifact:${tenantId}:${receipt.objectKey}:${receipt.versionId}`;
}

async function publishThroughRealOci(
  session: DurableRenderSessionV1,
  source: string,
  artifacts: RenderArtifactStoreV1,
  publications: PostgresArtifactRepositoryV1,
  invalidateFence?: () => Promise<void>,
) {
  if (!REAL_OCI_ENABLED) return null;
  const brokerUserId = process.geteuid?.();
  const stagingGroupId = process.getegid?.();
  if (brokerUserId === undefined || brokerUserId <= 0 || stagingGroupId === undefined) {
    throw new Error("The real OCI publication lane requires a non-root POSIX broker identity.");
  }
  if (!session.lease) throw new Error("The real OCI publication session is not leased.");
  const stagingRoot = await mkdtemp(join(tmpdir(), "poietra-real-publication-"));
  await chown(stagingRoot, brokerUserId, stagingGroupId);
  await chmod(stagingRoot, 0o750);
  const runner = new ManimRenderGatedOciJobRunnerV1({
    cgroupKillPolicy: "best-effort",
    dockerClient: new FastManimGatedOciDockerClientV1(),
    image: REAL_OCI_IMAGE!,
    seccompPath: RENDER_SECCOMP_PATH,
    stagingGroupId,
    stagingRoot,
  });
  const backend = new ManimRenderGatedOciBackendV1(runner);
  const signal = new AbortController().signal;
  const context = { deadlineEpochMs: session.deadline.getTime(), signal };
  const base = {
    deadlineEpochMs: context.deadlineEpochMs,
    fenceToken: session.fenceToken.toString(),
    jobId: `${session.tenantId}/${session.id}`,
    profileDigest: runner.profileDigest,
    projectId: session.projectId,
    runtimeDigest: runner.runtimeDigest,
    sceneFrame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
    sceneName: session.sceneName,
    schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
    sessionId: session.id,
    source,
    sourceDigest: session.patched.blob.digest,
    sourcePath: session.sourcePath,
    tenantId: session.tenantId,
    version: 2 as const,
  };
  let operationError: unknown;
  let evidence: Readonly<{ published: boolean; requestDigests: readonly string[]; runtimeDigest: string }> | null =
    null;
  try {
    await runner.reconcileOrphans();
    const submit = async (kind: "thumbnail" | "video") => {
      const request = new SealedManimRenderSandboxRequestV2({
        ...base,
        output:
          kind === "video"
            ? { frameRate: 15, kind, mediaType: "video/mp4", pixelHeight: 480, pixelWidth: 854 }
            : { frameRate: 15, kind, mediaType: "image/png", pixelHeight: 480, pixelWidth: 854 },
      });
      const terminal = await backend.submitOrReattach(request, context);
      if (terminal.kind !== "ready") {
        throw new Error(`The real OCI ${kind} render failed closed with ${terminal.code}.`);
      }
      return encodeManimRenderStagingLocatorV1(terminal);
    };
    const locators = { thumbnail: await submit("thumbnail"), video: await submit("video") };
    const requestDigests = Object.values(locators).map(
      (locator) => decodeManimRenderStagingLocatorV1(locator).requestDigest,
    );
    const studioUserId = brokerUserId === 1 ? 2 : 1;
    const user = vi.spyOn(process, "geteuid").mockReturnValue(studioUserId);
    const group = vi.spyOn(process, "getegid").mockReturnValue(stagingGroupId);
    const groups = vi.spyOn(process, "getgroups").mockReturnValue([stagingGroupId]);
    try {
      const createPublisher = (profileDigest: string) =>
        new VerifiedArtifactPublisherV1({
          artifactExpirationMs: 60_000,
          artifacts,
          brokerUserId,
          profileDigest,
          publications,
          runtimeDigest: runner.runtimeDigest,
          stagingGroupId,
          stagingRoot,
          tenantId: session.tenantId,
        });
      const versionsBeforeMismatch = await artifacts.listVersions(session.tenantId, new Date(Date.now() + 60_000), 256);
      await expect(
        createPublisher("f".repeat(64)).publish({
          locators,
          logTail: "mismatched profile",
          ownerId: session.lease.ownerId,
          session,
        }),
      ).rejects.toThrow(/profile/i);
      const versionsAfterMismatch = await artifacts.listVersions(session.tenantId, new Date(Date.now() + 60_000), 256);
      const matchingVersions = (versions: typeof versionsBeforeMismatch.versions) =>
        versions.filter(({ receipt }) => requestDigests.includes(receipt.requestDigest));
      expect(matchingVersions(versionsBeforeMismatch.versions)).toEqual([]);
      expect(matchingVersions(versionsAfterMismatch.versions)).toEqual([]);

      const publisher = createPublisher(runner.profileDigest);
      if (!invalidateFence) {
        const videoLocator = decodeManimRenderStagingLocatorV1(locators.video);
        const videoPath = join(stagingRoot, `${videoLocator.stagingId}.mp4`);
        const originalVideo = await readFile(videoPath);
        const alteredVideo = Buffer.from(originalVideo);
        alteredVideo[alteredVideo.byteLength - 1] ^= 0xff;
        try {
          await writeFile(videoPath, alteredVideo);
          await expect(
            publisher.publish({
              locators,
              logTail: "mismatched staged digest",
              ownerId: session.lease.ownerId,
              session,
            }),
          ).rejects.toThrow(/verification/i);
          const versionsAfterDigestMismatch = await artifacts.listVersions(
            session.tenantId,
            new Date(Date.now() + 60_000),
            256,
          );
          expect(matchingVersions(versionsAfterDigestMismatch.versions)).toEqual([]);
          await expect(publications.acquireSessionVideo(session.tenantId, session.id, 1_000)).rejects.toMatchObject({
            status: 404,
          });
        } finally {
          await writeFile(videoPath, originalVideo);
        }
      }
      if (invalidateFence) await invalidateFence();
      const publication = publisher.publish({
        locators,
        logTail: invalidateFence ? "stale real OCI publication" : "real OCI publication",
        ownerId: session.lease.ownerId,
        session,
      });
      if (invalidateFence) {
        await expect(publication).rejects.toMatchObject({ status: 409 });
        const orphaned = await artifacts.listVersions(session.tenantId, new Date(Date.now() + 60_000), 256);
        expect(matchingVersions(orphaned.versions)).toHaveLength(2);
      } else {
        await publication;
      }
    } finally {
      groups.mockRestore();
      group.mockRestore();
      user.mockRestore();
    }
    await backend.cancel(base.jobId, { deadlineEpochMs: Date.now() + 30_000, signal });
    evidence = { published: invalidateFence === undefined, requestDigests, runtimeDigest: runner.runtimeDigest };
  } catch (error) {
    operationError = error;
  }
  const cleanup = await Promise.allSettled([backend.close(), rm(stagingRoot, { force: true, recursive: true })]);
  const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  const errors = [...(operationError === undefined ? [] : [operationError]), ...cleanupErrors];
  if (errors.length > 0) throw new AggregateError(errors, "The real OCI publication lane failed or did not clean up.");
  return evidence;
}

describe.skipIf(!E2E_CONFIGURED || PROCESS_ROLE !== undefined)("PostgreSQL + MinIO render artifacts", () => {
  it("survives SIGKILL, atomically publishes versioned media, fences races, expires reads, and collects orphans", async () => {
    const environment = storageEnvironment();
    await prepareStorage(environment);
    const suffix = randomUUID().replaceAll("-", "");
    const tenantA = `media-a-${suffix}`;
    const tenantB = `media-b-${suffix}`;
    const projectId = `project-${suffix}`;
    const source =
      "from manim import Scene\n\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(1)\n";
    const videoBytes = Buffer.from("000000186674797069736f6d00000000", "hex");
    const thumbnailBytes = Buffer.alloc(24);
    thumbnailBytes.set(Buffer.from("89504e470d0a1a0a", "hex"));
    thumbnailBytes.writeUInt32BE(854, 16);
    thumbnailBytes.writeUInt32BE(480, 20);

    const pool = new Pool({ connectionString: environment.databaseUrl, max: 8 });
    const sources = sourceRepository();
    const renders = renderRepository();
    const artifacts = artifactStore();
    const repository = artifactRepository();
    const rawS3 = new S3Client(s3Config(environment));
    try {
      const headA = await createProject(sources, tenantA, projectId, source);
      await createProject(sources, tenantB, projectId, source);
      const claimed = await createClaimedSession(renders, headA, `published-${suffix}`);
      if (!claimed.lease) throw new Error("The publication fixture did not acquire a lease.");

      const published = await runPublisherChild({
        expectedVersion: claimed.version.toString(),
        fenceToken: claimed.fenceToken.toString(),
        ownerId: claimed.lease.ownerId,
        sessionId: claimed.id,
        sourceDigest: claimed.patched.blob.digest,
        tenantId: tenantA,
        thumbnailBase64: thumbnailBytes.toString("base64"),
        videoBase64: videoBytes.toString("base64"),
      });

      const atomic = await pool.query<{
        artifact_count: number;
        expires_at: Date;
        status: string;
        thumbnail_heads: number;
      }>(
        `SELECT session.status,
                  min(link.expires_at) AS expires_at,
                  count(link.artifact_id)::integer AS artifact_count,
                  (SELECT count(*)::integer FROM public.workspace_project_thumbnail_heads head
                    WHERE head.tenant_id = session.tenant_id AND head.project_id = session.project_id)
                    AS thumbnail_heads
             FROM public.render_sessions session
             JOIN public.render_session_artifacts link
               ON link.tenant_id = session.tenant_id AND link.session_id = session.session_id
            WHERE session.tenant_id = $1 AND session.session_id = $2::uuid
            GROUP BY session.tenant_id, session.project_id, session.status`,
        [tenantA, claimed.id],
      );
      expect(atomic.rows[0]).toMatchObject({ artifact_count: 2, status: "ready", thumbnail_heads: 1 });
      const remainingLifetime = atomic.rows[0]!.expires_at.getTime() - Date.now();
      expect(remainingLifetime).toBeGreaterThan(29 * 24 * 60 * 60_000);
      expect(remainingLifetime).toBeLessThanOrEqual(MAX_EXPIRATION_MS);

      const newerBytes = Buffer.from(videoBytes);
      newerBytes[newerBytes.byteLength - 1] ^= 0xff;
      const newer = await rawS3.send(
        new PutObjectCommand({
          Body: newerBytes,
          Bucket: environment.bucket,
          ContentLength: newerBytes.byteLength,
          ContentType: published.video.mediaType,
          Key: published.video.objectKey,
          Metadata: {
            "artifact-digest": published.video.artifactDigest,
            "artifact-kind": published.video.kind,
            "profile-digest": published.video.profileDigest,
            "request-digest": published.video.requestDigest,
            "runtime-digest": published.video.runtimeDigest,
            "source-digest": published.video.sourceDigest,
          },
        }),
      );
      expect(newer.VersionId).toBeTruthy();
      expect(newer.VersionId).not.toBe(published.video.versionId);

      const readerA = new AuthorizedArtifactReaderV1({
        claimDurationMs: 2_000,
        repository: artifactRepository(),
        store: artifactStore(),
        tenantId: tenantA,
      });
      try {
        const api = {
          storageBoundary: { kind: "shared-durable", namespace: "render-artifact-e2e" },
          tenantId: tenantA,
          video: (id: string, signal?: AbortSignal) => readerA.sessionVideo(id, signal),
        } as unknown as ManimApi;
        const server = await listenForMedia(api);
        try {
          const port = (server.address() as AddressInfo).port;
          const path = `/api/manim/renders/${claimed.id}/video`;
          const head = await requestMedia(port, path, { method: "HEAD" });
          expect(head).toMatchObject({ body: Buffer.alloc(0), status: 200 });
          expect(head.headers["content-length"]).toBe(videoBytes.byteLength.toString());
          expect((await requestMedia(port, path)).body).toEqual(videoBytes);
          const range = await requestMedia(port, path, { headers: { range: "bytes=4-11" } });
          expect(range).toMatchObject({ body: videoBytes.subarray(4, 12), status: 206 });
          expect(range.headers["content-range"]).toBe(`bytes 4-11/${videoBytes.byteLength}`);
          const invalid = await requestMedia(port, path, { headers: { range: "bytes=999-" } });
          expect(invalid).toMatchObject({ body: Buffer.alloc(0), status: 416 });
          expect(invalid.headers["content-range"]).toBe(`bytes */${videoBytes.byteLength}`);
        } finally {
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
        expect(await readerA.projectThumbnailBytes(projectId)).toEqual(thumbnailBytes);
      } finally {
        await readerA.close();
      }

      const readerB = new AuthorizedArtifactReaderV1({
        repository: artifactRepository(),
        store: artifactStore(),
        tenantId: tenantB,
      });
      try {
        await expect(readerB.sessionVideo(claimed.id)).rejects.toMatchObject({ status: 404 });
        await expect(readerB.projectThumbnail(projectId)).rejects.toMatchObject({ status: 404 });
      } finally {
        await readerB.close();
      }

      const partial = await createClaimedSession(renders, headA, `partial-${suffix}`);
      const partialVideo = await artifacts.put(
        tenantA,
        mediaInput("video", Buffer.from(`${videoBytes.toString("hex")}01`, "hex"), headA.blob.digest, partial.id),
      );
      const partialReader = new AuthorizedArtifactReaderV1({
        repository: artifactRepository(),
        store: artifactStore(),
        tenantId: tenantA,
      });
      try {
        await expect(partialReader.sessionVideo(partial.id)).rejects.toMatchObject({ status: 404 });
      } finally {
        await partialReader.close();
      }

      const stale = await createClaimedSession(renders, headA, `stale-${suffix}`);
      const staleBundle = await putBundle(
        artifacts,
        stale,
        Buffer.from(`${videoBytes.toString("hex")}02`, "hex"),
        Buffer.concat([thumbnailBytes, Buffer.from([2])]),
      );
      const staleInput = publicationInput(stale, staleBundle);
      await expect(
        repository.publishSessionArtifacts({ ...staleInput, fenceToken: staleInput.fenceToken + 1n }),
      ).rejects.toMatchObject({ status: 409 });
      const invisible = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM public.render_session_artifacts WHERE tenant_id = $1 AND session_id IN ($2::uuid, $3::uuid)",
        [tenantA, partial.id, stale.id],
      );
      expect(invisible.rows[0]?.count).toBe(0);

      const claimOne = await repository.acquireSessionVideo(tenantA, claimed.id, 5_000);
      await setVideoExpiry(pool, published.video, false);
      const rowLockOne = await pool.connect();
      await lockArtifactRow(rowLockOne, tenantA, published.video);
      try {
        const renewed = repository.renewReadClaim(tenantA, claimOne.claimId, 5_000);
        await waitForAdvisoryLock(pool, lockKey(tenantA, published.video));
        const queued = repository.queueDeletion(tenantA, published.video, 1);
        await rowLockOne.query("COMMIT");
        await expect(renewed).resolves.toBeInstanceOf(Date);
        await expect(queued).resolves.toBeNull();
      } finally {
        await rowLockOne.query("ROLLBACK").catch(() => undefined);
        rowLockOne.release();
      }
      await repository.releaseReadClaim(tenantA, claimOne.claimId);

      await setVideoExpiry(pool, published.video, true);
      const claimTwo = await repository.acquireSessionVideo(tenantA, claimed.id, 1_200);
      await setVideoExpiry(pool, published.video, false);
      const rowLockTwo = await pool.connect();
      await lockArtifactRow(rowLockTwo, tenantA, published.video);
      let deletion;
      try {
        const queued = repository.queueDeletion(tenantA, published.video, 1);
        await waitForAdvisoryLock(pool, lockKey(tenantA, published.video));
        const renewed = repository.renewReadClaim(tenantA, claimTwo.claimId, 5_000);
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        await rowLockTwo.query("COMMIT");
        deletion = await queued;
        expect(deletion).not.toBeNull();
        await expect(renewed).rejects.toMatchObject({ status: 409 });
      } finally {
        await rowLockTwo.query("ROLLBACK").catch(() => undefined);
        rowLockTwo.release();
      }
      if (!deletion) throw new Error("The queue-first race did not produce a deletion tombstone.");
      await artifacts.deleteVersion(tenantA, deletion.receipt);
      await repository.acknowledgeDeletion(tenantA, deletion.deletionId);

      const gc = await runRenderArtifactGcV1({
        artifacts,
        cutoff: new Date(Date.now() + 60_000),
        graceMs: 1,
        maximum: 256,
        repository,
        tenantId: tenantA,
      });
      expect(gc.deleted).toBeGreaterThanOrEqual(4);
      await expect(artifacts.head(tenantA, partialVideo)).rejects.toMatchObject({
        code: "missing",
        name: RenderArtifactReadErrorV1.name,
      });
      for (const receipt of Object.values(staleBundle)) {
        await expect(artifacts.head(tenantA, receipt)).rejects.toMatchObject({ code: "missing" });
      }
      await expect(
        rawS3.send(
          new HeadObjectCommand({
            Bucket: environment.bucket,
            Key: published.video.objectKey,
            VersionId: newer.VersionId,
          }),
        ),
      ).rejects.toBeTruthy();
      await artifacts.head(tenantA, published.thumbnail);

      await pool.query(
        `UPDATE public.render_artifact_objects
              SET created_at = clock_timestamp() - interval '2 hours',
                  expires_at = clock_timestamp() - interval '1 hour'
            WHERE tenant_id = $1 AND object_key = $2 AND version_id = $3`,
        [tenantA, published.thumbnail.objectKey, published.thumbnail.versionId],
      );
      await pool.query(
        `UPDATE public.workspace_project_thumbnail_heads
              SET session_created_at = clock_timestamp() - interval '2 hours',
                  expires_at = clock_timestamp() - interval '1 hour'
            WHERE tenant_id = $1 AND project_id = $2`,
        [tenantA, projectId],
      );
      const expiredReader = new AuthorizedArtifactReaderV1({
        repository: artifactRepository(),
        store: artifactStore(),
        tenantId: tenantA,
      });
      try {
        await expect(expiredReader.projectThumbnail(projectId)).rejects.toSatisfy(
          (error: unknown) => error instanceof HttpError && error.status === 404,
        );
        await expect(expiredReader.sessionVideo(claimed.id)).rejects.toSatisfy(
          (error: unknown) => error instanceof HttpError && error.status === 404,
        );
      } finally {
        await expiredReader.close();
      }

      if (REAL_OCI_ENABLED) {
        const ociSession = await createClaimedSession(renders, headA, `oci-${suffix}`);
        const evidence = await publishThroughRealOci(ociSession, source, artifacts, repository);
        expect(evidence).toMatchObject({ published: true, runtimeDigest: expect.any(String) });
        expect(await renders.readSession(tenantA, ociSession.id)).toMatchObject({ status: "ready" });
        const ociReader = new AuthorizedArtifactReaderV1({
          repository: artifactRepository(),
          store: artifactStore(),
          tenantId: tenantA,
        });
        try {
          const video = await readSessionVideo(ociReader, ociSession.id);
          expect(video.subarray(4, 8).toString("ascii")).toBe("ftyp");
          const thumbnail = await ociReader.projectThumbnailBytes(projectId);
          expect(thumbnail.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        } finally {
          await ociReader.close();
        }

        const rejectedSession = await createClaimedSession(renders, headA, `oci-stale-${suffix}`);
        const rejected = await publishThroughRealOci(rejectedSession, source, artifacts, repository, async () => {
          await pool.query(
            `UPDATE public.render_sessions
                  SET fence_token = fence_token + 1
                WHERE tenant_id = $1 AND session_id = $2::uuid`,
            [tenantA, rejectedSession.id],
          );
        });
        expect(rejected).toMatchObject({ published: false, requestDigests: expect.any(Array) });
        const rejectedLinks = await pool.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM public.render_session_artifacts WHERE tenant_id = $1 AND session_id = $2::uuid",
          [tenantA, rejectedSession.id],
        );
        expect(rejectedLinks.rows[0]?.count).toBe(0);
        const rejectedReader = new AuthorizedArtifactReaderV1({
          repository: artifactRepository(),
          store: artifactStore(),
          tenantId: tenantA,
        });
        try {
          await expect(rejectedReader.sessionVideo(rejectedSession.id)).rejects.toMatchObject({ status: 404 });
        } finally {
          await rejectedReader.close();
        }
        const rejectedGc = await runRenderArtifactGcV1({
          artifacts,
          cutoff: new Date(Date.now() + 60_000),
          graceMs: 1,
          maximum: 256,
          repository,
          tenantId: tenantA,
        });
        expect(rejectedGc.deleted).toBeGreaterThanOrEqual(2);
        const versionsAfterRejectedGc = await artifacts.listVersions(tenantA, new Date(Date.now() + 60_000), 256);
        expect(
          versionsAfterRejectedGc.versions.filter(({ receipt }) =>
            rejected!.requestDigests.includes(receipt.requestDigest),
          ),
        ).toEqual([]);
      }
    } finally {
      rawS3.destroy();
      await Promise.allSettled([repository.close(), artifacts.close(), renders.close(), sources.close(), pool.end()]);
    }
  }, 120_000);
});
