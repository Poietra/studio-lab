import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", () => filesystem);

import {
  encodeManimRenderStagingLocatorV1,
  manimRenderStagingIdV1,
  MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
  type ManimRenderSandboxTerminalV1,
} from "../manim-render-sandbox-contract";
import {
  parseRenderArtifactReceiptV1,
  renderArtifactObjectKeyV1,
  type RenderArtifactRepositoryV1,
  type RenderArtifactStoreV1,
} from "./render-artifact-repository";
import type { DurableRenderSessionV1 } from "./render-session-repository";
import { VerifiedArtifactPublisherV1 } from "./verified-artifact-publisher";

const ROOT = "/tmp/poietra-render-staging";
const TENANT = "tenant-a";
const BROKER_UID = 2_000;
const STUDIO_GID = 1_000;
const SOURCE = "a".repeat(64);
const RUNTIME = "b".repeat(64);
const PROFILE = "c".repeat(64);
const VIDEO = Buffer.from("000000186674797069736f6d", "hex");
const THUMBNAIL = Buffer.alloc(24);
THUMBNAIL.set(Buffer.from("89504e470d0a1a0a", "hex"));
THUMBNAIL.writeUInt32BE(854, 16);
THUMBNAIL.writeUInt32BE(480, 20);

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function directory(uid: bigint, gid: bigint, mode: bigint, ino: bigint) {
  return {
    dev: 1n,
    gid,
    ino,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    mode,
    uid,
  };
}

function stagedFile(bytes: Uint8Array, ino: bigint) {
  return {
    dev: 1n,
    gid: BigInt(STUDIO_GID),
    ino,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100640n,
    nlink: 1n,
    size: BigInt(bytes.byteLength),
    uid: BigInt(BROKER_UID),
  };
}

function session(id: string): DurableRenderSessionV1 {
  const now = new Date();
  const blob = {
    byteSize: 1,
    digest: SOURCE,
    etag: '"source"',
    objectKey: `tenants/${TENANT}/sources/${SOURCE}`,
    versionId: "source-v1",
  };
  return {
    artifactLocator: null,
    commitCorrelationKey: `commit-${id}`,
    createdAt: now,
    deadline: new Date(now.getTime() + 60_000),
    error: null,
    executionAttempts: 1,
    fenceToken: 1n,
    id,
    latestAction: null,
    lease: { expiresAt: new Date(now.getTime() + 30_000), ownerId: "worker-a" },
    logTail: "",
    original: { blob, generation: 1n },
    patch: { anchorLine: 1, anchorLines: [1], insertedCode: "" },
    patched: { blob },
    programBatchId: "batch-a",
    programTransactionId: "transaction-a",
    progress: 0.5,
    projectId: "project-a",
    renderRequestId: `request-${id}`,
    sceneName: "MainScene",
    sourcePath: "main.py",
    status: "rendering",
    tenantId: TENANT,
    updatedAt: now,
    version: 2n,
  };
}

function locator(render: DurableRenderSessionV1, kind: "thumbnail" | "video") {
  const bytes = kind === "video" ? VIDEO : THUMBNAIL;
  const jobId = `${TENANT}/${render.id}`;
  const terminal: Extract<ManimRenderSandboxTerminalV1, { kind: "ready" }> = {
    artifactDigest: createHash("sha256").update(bytes).digest("hex"),
    artifactSize: bytes.byteLength,
    deadlineEpochMs: render.deadline.getTime(),
    fenceToken: render.fenceToken.toString(),
    jobId,
    kind: "ready",
    logTail: "",
    mediaType: kind === "video" ? "video/mp4" : "image/png",
    profileDigest: PROFILE,
    requestDigest: kind === "video" ? "d".repeat(64) : "e".repeat(64),
    runtimeDigest: RUNTIME,
    schema: MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
    sessionId: render.id,
    sourceDigest: SOURCE,
    stagingId: manimRenderStagingIdV1(jobId, kind),
    tenantId: TENANT,
    version: 1,
  };
  return encodeManimRenderStagingLocatorV1(terminal);
}

function configureFilesystem() {
  filesystem.realpath.mockImplementation(async (path: string) => path);
  filesystem.lstat.mockImplementation(async (path: string) => {
    if (path === ROOT) return directory(BigInt(BROKER_UID), BigInt(STUDIO_GID), 0o40750n, 2n);
    if (path === "/tmp") return directory(0n, 0n, 0o41777n, 3n);
    if (path === "/") return directory(0n, 0n, 0o40755n, 1n);
    return path.endsWith(".mp4") ? stagedFile(VIDEO, 4n) : stagedFile(THUMBNAIL, 5n);
  });
  filesystem.open.mockImplementation(async (path: string) => {
    const bytes = path.endsWith(".mp4") ? VIDEO : THUMBNAIL;
    const metadata = stagedFile(bytes, path.endsWith(".mp4") ? 4n : 5n);
    return {
      close: vi.fn(async () => undefined),
      read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
        const selected = bytes.subarray(position, position + length);
        target.set(selected, offset);
        return { buffer: target, bytesRead: selected.byteLength };
      }),
      stat: vi.fn(async () => metadata),
    };
  });
}

describe("VerifiedArtifactPublisherV1", () => {
  it("serializes concurrent 128 MiB-capable publications through one abort-aware memory permit", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(1_000);
    vi.spyOn(process, "getegid").mockReturnValue(STUDIO_GID);
    vi.spyOn(process, "getgroups").mockReturnValue([STUDIO_GID]);
    configureFilesystem();
    const firstPut = deferred();
    let activePuts = 0;
    let maximumActivePuts = 0;
    let putCount = 0;
    const artifacts = {
      close: vi.fn(async () => undefined),
      put: vi.fn<RenderArtifactStoreV1["put"]>(async (tenant, input) => {
        putCount += 1;
        activePuts += 1;
        maximumActivePuts = Math.max(maximumActivePuts, activePuts);
        if (putCount === 1) await firstPut.promise;
        activePuts -= 1;
        const { bytes: _bytes, ...identity } = input;
        return parseRenderArtifactReceiptV1(tenant, {
          ...identity,
          etag: `"etag-${putCount}"`,
          objectKey: renderArtifactObjectKeyV1(tenant, identity),
          versionId: `version-${putCount}`,
        });
      }),
      ready: vi.fn(async () => true),
    } as unknown as RenderArtifactStoreV1;
    const publishSessionArtifacts = vi.fn(async () => undefined);
    const publications = {
      publishSessionArtifacts,
      ready: vi.fn(async () => true),
    } as unknown as RenderArtifactRepositoryV1;
    const publisher = new VerifiedArtifactPublisherV1({
      artifactExpirationMs: 60_000,
      artifacts,
      brokerUserId: BROKER_UID,
      profileDigest: PROFILE,
      publications,
      runtimeDigest: RUNTIME,
      stagingGroupId: STUDIO_GID,
      stagingRoot: ROOT,
      tenantId: TENANT,
    });
    const firstSession = session("00000000-0000-4000-8000-000000000001");
    const secondSession = session("00000000-0000-4000-8000-000000000002");
    const publish = (render: DurableRenderSessionV1) =>
      publisher.publish({
        locators: { thumbnail: locator(render, "thumbnail"), video: locator(render, "video") },
        logTail: "ok",
        ownerId: "worker-a",
        session: render,
      });

    const first = publish(firstSession);
    await vi.waitFor(() => expect(artifacts.put).toHaveBeenCalledTimes(1));
    const second = publish(secondSession);
    await Promise.resolve();
    expect(artifacts.put).toHaveBeenCalledTimes(1);
    firstPut.resolve();
    await Promise.all([first, second]);

    expect(maximumActivePuts).toBe(1);
    expect(artifacts.put).toHaveBeenCalledTimes(4);
    expect(publishSessionArtifacts).toHaveBeenCalledTimes(2);
  });
});
