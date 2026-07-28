import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { FastManimGatedOciDockerClientV1 } from "./fast-manim-gated-oci-job-runner";
import {
  digestManimRenderGatedOciRuntimeV1,
  deliverSealedManimRenderGateRequestV1,
  MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
  ManimRenderGatedOciJobRunnerV1,
  writeBoundedManimRenderChildStdoutV1,
} from "./manim-render-gated-oci-job-runner";
import { parseManimRenderProductionSandboxBrokerConfigV1 } from "./manim-render-production-sandbox-broker-entry";
import { createManimRenderProductionSandboxClientV1 } from "./manim-render-production-sandbox-client";
import type { ManimRenderSandboxBackendV1 } from "./manim-render-sandbox-backend";
import { startManimRenderSandboxBrokerServerV1 } from "./manim-render-sandbox-broker-server";
import {
  encodeManimRenderSandboxBrokerClientFrameV1,
  encodeManimRenderSandboxBrokerServerFrameV1,
  ManimRenderSandboxBrokerClientFrameDecoderV1,
  ManimRenderSandboxBrokerProtocolErrorV1,
  ManimRenderSandboxBrokerServerFrameDecoderV1,
} from "./manim-render-sandbox-broker-protocol";
import {
  decodeManimRenderStagingLocatorV1,
  digestManimRenderSandboxExecutionV1,
  encodeManimRenderStagingLocatorV1,
  MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1,
  MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
  MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1,
  manimRenderStagingIdV1,
  SealedManimRenderSandboxRequestV1,
  verifySealedManimRenderSandboxRequestV1,
} from "./manim-render-sandbox-contract";
import { ManimRenderUdsSandboxBackendV1 } from "./manim-render-uds-sandbox-backend";
import { ProductionDurableManimRenderExecutorV1 } from "./production-durable-manim-render-executor";
import type { DurableRenderSessionV1 } from "./storage/render-session-repository";
import type { SourceContentBlobStoreV1 } from "./storage/workspace-source-repository";

const image = `sha256:${"a".repeat(64)}`;
const source = `from manim import Scene\n\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(0.1)\n`;
const sourceDigest = createHash("sha256").update(source, "utf8").digest("hex");

function descriptor(overrides: Partial<ConstructorParameters<typeof SealedManimRenderSandboxRequestV1>[0]> = {}) {
  return {
    deadlineEpochMs: Date.now() + 60_000,
    fenceToken: "1",
    jobId: "tenant-a/session-a",
    output: {
      frameRate: 15 as const,
      kind: "video" as const,
      mediaType: "video/mp4" as const,
      pixelHeight: 480 as const,
      pixelWidth: 854 as const,
    },
    profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
    projectId: "project-a",
    runtimeDigest: digestManimRenderGatedOciRuntimeV1(image),
    sceneFrame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
    sceneName: "MainScene",
    schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1,
    sessionId: "session-a",
    source,
    sourceDigest,
    sourcePath: "main.py",
    tenantId: "tenant-a",
    version: 1 as const,
    ...overrides,
  };
}

class ScriptedDockerClient extends FastManimGatedOciDockerClientV1 {
  readonly calls: string[][] = [];
  readonly steps: Array<Error | Readonly<{ code: number; stderr: Buffer; stdout: Buffer }>> = [];

  override async run(arguments_: readonly string[]) {
    this.calls.push([...arguments_]);
    const step = this.steps.shift();
    if (step instanceof Error) throw step;
    return step ?? { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  }
}

class BlockingDockerClient extends FastManimGatedOciDockerClientV1 {
  readonly entered: Promise<void>;
  readonly #release: Promise<void>;
  #markEntered!: () => void;
  #releaseFirst!: () => void;
  #runs = 0;

  constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
    this.#release = new Promise((resolve) => {
      this.#releaseFirst = resolve;
    });
  }

  release() {
    this.#releaseFirst();
  }

  override async run() {
    this.#runs += 1;
    if (this.#runs === 1) {
      this.#markEntered();
      await this.#release;
    }
    return { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  }
}

function partial<T>(value: Partial<T>): T {
  return value as T;
}

function never(): Promise<never> {
  return new Promise(() => undefined);
}

function healthyStatus() {
  return {
    backendId: "test-render-backend",
    health: "ready" as const,
    profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
    runtimeDigest: digestManimRenderGatedOciRuntimeV1(image),
    schema: MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1,
    version: 1 as const,
  };
}

async function writeStagedVideo(
  root: string,
  value: ReturnType<typeof descriptor>,
  artifact = Buffer.from("000000186674797000000000", "hex"),
) {
  const stagingId = manimRenderStagingIdV1(value.jobId, "video");
  const artifactDigest = createHash("sha256").update(artifact).digest("hex");
  const artifactPath = join(root, `${stagingId}.mp4`);
  const manifestPath = join(root, `${stagingId}.json`);
  await writeFile(artifactPath, artifact, { mode: 0o600 });
  await writeFile(
    manifestPath,
    canonicalJsonV1({
      artifactDigest,
      artifactSize: artifact.byteLength,
      deadlineEpochMs: value.deadlineEpochMs,
      executionDigest: digestManimRenderSandboxExecutionV1(value),
      jobId: value.jobId,
      mediaType: "video/mp4",
      profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
      runtimeDigest: value.runtimeDigest,
      sourceDigest: value.sourceDigest,
      stagingId,
      version: 1,
    }),
    { mode: 0o600 },
  );
  return { artifactPath, manifestPath, stagingId };
}

afterEach(() => vi.restoreAllMocks());

describe("render sandbox contracts", () => {
  it("seals private bytes and keeps execution identity stable across fencing", () => {
    const mutable = descriptor();
    const sealed = new SealedManimRenderSandboxRequestV1(mutable);
    mutable.source = "tampered";
    const copied = sealed.copyBytes();
    copied[0] ^= 0xff;

    expect(verifySealedManimRenderSandboxRequestV1(sealed)).toBe(true);
    expect(sealed.parseDescriptor().source).toBe(source);
    const refenced = new SealedManimRenderSandboxRequestV1(
      descriptor({ deadlineEpochMs: sealed.parseDescriptor().deadlineEpochMs, fenceToken: "2" }),
    );
    expect(refenced.requestDigest).not.toBe(sealed.requestDigest);
    expect(digestManimRenderSandboxExecutionV1(refenced.parseDescriptor())).toBe(
      digestManimRenderSandboxExecutionV1(sealed.parseDescriptor()),
    );
    expect(manimRenderStagingIdV1(mutable.jobId, "thumbnail")).not.toBe(manimRenderStagingIdV1(mutable.jobId, "video"));
    expect(
      () => new SealedManimRenderSandboxRequestV1(descriptor({ sceneFrame: { height: 8, width: 14.222 } })),
    ).toThrow();
  });

  it("encodes only bounded correlation metadata in opaque staging locators", () => {
    const request = new SealedManimRenderSandboxRequestV1(descriptor());
    const value = {
      artifactDigest: "b".repeat(64),
      artifactSize: 12,
      deadlineEpochMs: request.parseDescriptor().deadlineEpochMs,
      fenceToken: "1",
      jobId: "tenant-a/session-a",
      kind: "ready" as const,
      logTail: "",
      mediaType: "video/mp4" as const,
      profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
      requestDigest: request.requestDigest,
      runtimeDigest: digestManimRenderGatedOciRuntimeV1(image),
      schema: MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
      sessionId: "session-a",
      sourceDigest,
      stagingId: manimRenderStagingIdV1("tenant-a/session-a", "video"),
      tenantId: "tenant-a",
      version: 1 as const,
    };
    const locator = encodeManimRenderStagingLocatorV1(value);
    expect(decodeManimRenderStagingLocatorV1(locator)).toMatchObject({
      artifactDigest: value.artifactDigest,
      fenceToken: value.fenceToken,
      requestDigest: value.requestDigest,
      stagingId: value.stagingId,
    });
    expect(locator).not.toContain("/tmp");
    expect(() => decodeManimRenderStagingLocatorV1(`${locator}x`)).toThrow();
  });

  it("rejects protocol trailing bytes after one canonical frame", () => {
    const frame = encodeManimRenderSandboxBrokerClientFrameV1({
      deadlineEpochMs: Date.now() + 60_000,
      kind: "status",
    });
    const decoder = new ManimRenderSandboxBrokerClientFrameDecoderV1();
    expect(decoder.push(frame)).toMatchObject({ kind: "status" });
    expect(() => decoder.push(Buffer.from("trailing"))).toThrow(ManimRenderSandboxBrokerProtocolErrorV1);
  });

  it("decodes every operation across one-byte fragments and checks the response operation prefix", () => {
    const request = new SealedManimRenderSandboxRequestV1(descriptor());
    const clientFrames = [
      encodeManimRenderSandboxBrokerClientFrameV1({ deadlineEpochMs: Date.now() + 60_000, kind: "status" }),
      encodeManimRenderSandboxBrokerClientFrameV1({
        deadlineEpochMs: request.parseDescriptor().deadlineEpochMs,
        kind: "submit",
        requestBytesBase64: Buffer.from(request.copyBytes()).toString("base64"),
        requestDigest: request.requestDigest,
      }),
      encodeManimRenderSandboxBrokerClientFrameV1({
        deadlineEpochMs: Date.now() + 60_000,
        jobId: "tenant-a/session-a",
        kind: "cancel",
      }),
    ];
    for (const frame of clientFrames) {
      const decoder = new ManimRenderSandboxBrokerClientFrameDecoderV1();
      let decoded: unknown;
      for (const byte of frame) decoded ??= decoder.push(Buffer.from([byte]));
      decoder.finish();
      expect(decoded).toMatchObject({ kind: expect.any(String) });
    }

    for (const operation of ["status", "submit", "cancel"] as const) {
      const frame = encodeManimRenderSandboxBrokerServerFrameV1(operation, {
        code: "unavailable",
        kind: "error",
      });
      const decoder = new ManimRenderSandboxBrokerServerFrameDecoderV1(operation);
      let decoded: unknown;
      for (const byte of frame) decoded ??= decoder.push(Buffer.from([byte]));
      decoder.finish();
      expect(decoded).toEqual({ code: "unavailable", kind: "error" });
      const wrong = new ManimRenderSandboxBrokerServerFrameDecoderV1(operation === "status" ? "submit" : "status");
      expect(() => wrong.push(frame)).toThrow(ManimRenderSandboxBrokerProtocolErrorV1);
    }
  });

  it("rejects root Studio clients and unknown broker config keys", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    await expect(
      createManimRenderProductionSandboxClientV1({
        brokerUserId: 1001,
        imageDigest: image,
        socketGroupId: process.getegid!(),
        socketPath: "/missing/render.sock",
      }),
    ).rejects.toThrow(/principal/i);
    expect(() =>
      parseManimRenderProductionSandboxBrokerConfigV1({
        brokerUserId: 1001,
        dockerSocketPath: "/run/user/1001/docker.sock",
        extra: true,
        imageDigest: image,
        seccompPath: "/etc/poietra/seccomp.json",
        socketGroupId: 1002,
        socketPath: "/run/poietra/render.sock",
        stagingRoot: "/var/lib/poietra/render-staging",
      }),
    ).toThrow();
  });
});

describe("render OCI lifecycle", () => {
  it("rejects writable staging ancestors and a replacement root inode", async () => {
    const writableParent = await mkdtemp(join(tmpdir(), "poietra-render-writable-parent-"));
    const writableRoot = join(writableParent, "staging");
    await mkdir(writableRoot, { mode: 0o700 });
    await chmod(writableParent, 0o777);
    const writableDocker = new ScriptedDockerClient();
    const writableRunner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: writableDocker,
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: writableRoot,
    });
    try {
      await expect(writableRunner.reconcileOrphans()).rejects.toThrow(/ancestor/i);
      expect(writableDocker.calls).toEqual([]);
    } finally {
      await writableRunner.close();
      await rm(writableParent, { force: true, recursive: true });
    }

    const privateParent = await mkdtemp(join(tmpdir(), "poietra-render-root-swap-"));
    const stagingRoot = join(privateParent, "staging");
    await mkdir(stagingRoot, { mode: 0o700 });
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: new ScriptedDockerClient(),
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot,
    });
    try {
      await expect(runner.reconcileOrphans()).resolves.toBeUndefined();
      await rename(stagingRoot, join(privateParent, "original"));
      await mkdir(stagingRoot, { mode: 0o700 });
      await expect(runner.reconcileOrphans()).rejects.toThrow(/replaced/i);
    } finally {
      await runner.close();
      await rm(privateParent, { force: true, recursive: true });
    }
  });

  it.each([
    { label: "early exit", program: "process.exit(17);", timeoutMs: 2_000 },
    { label: "readiness timeout", program: "setInterval(() => undefined, 1000);", timeoutMs: 25 },
  ])("reaps the attached Docker client after gate $label", async ({ program, timeoutMs }) => {
    const request = new SealedManimRenderSandboxRequestV1(descriptor());
    const child = spawn(process.execPath, ["--eval", program], { stdio: ["pipe", "pipe", "pipe"] });
    await expect(
      deliverSealedManimRenderGateRequestV1(
        child,
        request,
        digestManimRenderSandboxExecutionV1(request.parseDescriptor()),
        Date.now() + timeoutMs,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("writes every byte when broker staging performs short writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-stream-short-write-"));
    const path = join(root, "artifact.bin");
    const destination = await open(path, "wx", 0o600);
    const shortWritingDestination = {
      sync: () => destination.sync(),
      write: (buffer: Uint8Array, offset: number, length: number) =>
        destination.write(buffer, offset, Math.min(2, length)),
    } as unknown as typeof destination;
    const child = spawn(process.execPath, ["--eval", 'process.stdout.write("abcdefgh");'], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await expect(
        writeBoundedManimRenderChildStdoutV1(
          child,
          shortWritingDestination,
          64,
          Date.now() + 2_000,
          new AbortController().signal,
        ),
      ).resolves.toBe(8);
      expect(await readFile(path, "utf8")).toBe("abcdefgh");
    } finally {
      await destination.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      label: "oversized stdout",
      maximumBytes: 64,
      program: "process.stdout.write(Buffer.alloc(65));",
      timeoutMs: 2_000,
    },
    {
      label: "a FIFO-equivalent infinite stdout wait",
      maximumBytes: 64,
      program: "setInterval(() => undefined, 1000);",
      timeoutMs: 25,
    },
    {
      label: "oversized stderr",
      maximumBytes: 64,
      program: "process.stderr.write(Buffer.alloc(65537)); setInterval(() => undefined, 1000);",
      timeoutMs: 2_000,
    },
  ])("kills and reaps a bounded export child on $label", async ({ maximumBytes, program, timeoutMs }) => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-stream-adversary-"));
    const destination = await open(join(root, "artifact.bin"), "wx", 0o600);
    const child = spawn(process.execPath, ["--eval", program], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await expect(
        writeBoundedManimRenderChildStdoutV1(
          child,
          destination,
          maximumBytes,
          Date.now() + timeoutMs,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await destination.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("latches an uncertain create even when an immediate stable-name lookup is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-create-uncertain-"));
    await chmod(root, 0o700);
    const docker = new ScriptedDockerClient();
    docker.steps.push(
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      new Error("create transport timed out"),
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: docker,
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    try {
      const request = new SealedManimRenderSandboxRequestV1(descriptor());
      await expect(
        runner.submitOrReattach(request, request.parseDescriptor().deadlineEpochMs, new AbortController().signal),
      ).resolves.toEqual({ code: "cleanup-failed", kind: "failed" });
      await expect(runner.ready()).resolves.toBe(false);
      await expect(runner.close()).rejects.toThrow(/cleanup/i);
      expect(docker.calls.filter((call) => call[0] === "container" && call[1] === "ls")).toHaveLength(2);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("removes expired canonical staging pairs and rejects malformed manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-expired-"));
    await chmod(root, 0o700);
    const docker = new ScriptedDockerClient();
    docker.steps.push({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) });
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: docker,
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    const expired = descriptor({ deadlineEpochMs: Date.now() - 1_000 });
    const stagingId = manimRenderStagingIdV1(expired.jobId, "video");
    const artifact = Buffer.from("000000186674797000000000", "hex");
    const artifactDigest = createHash("sha256").update(artifact).digest("hex");
    const artifactPath = join(root, `${stagingId}.mp4`);
    const manifestPath = join(root, `${stagingId}.json`);
    await writeFile(artifactPath, artifact, { mode: 0o600 });
    await writeFile(
      manifestPath,
      canonicalJsonV1({
        artifactDigest,
        artifactSize: artifact.byteLength,
        deadlineEpochMs: expired.deadlineEpochMs,
        executionDigest: digestManimRenderSandboxExecutionV1(expired),
        jobId: expired.jobId,
        mediaType: "video/mp4",
        profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
        runtimeDigest: expired.runtimeDigest,
        sourceDigest,
        stagingId,
        version: 1,
      }),
      { mode: 0o600 },
    );
    try {
      await runner.reconcileOrphans();
      await expect(readFile(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(manifestPath, "{}", { mode: 0o600 });
      await expect(runner.reconcileOrphans()).rejects.toThrow();
      await runner.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    { label: "artifact count", maxStagedArtifacts: 1, maxStagedBytes: undefined },
    { label: "reserved bytes", maxStagedArtifacts: 2, maxStagedBytes: 128 * 1024 * 1024 + 8 * 1024 },
  ])("rejects a different job before staging exceeds its $label cap", async (limits) => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-capacity-"));
    await chmod(root, 0o700);
    const existing = descriptor({ jobId: "tenant-a/session-existing", sessionId: "session-existing" });
    await writeStagedVideo(root, existing);
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: new ScriptedDockerClient(),
      image,
      maxStagedArtifacts: limits.maxStagedArtifacts,
      ...(limits.maxStagedBytes === undefined ? {} : { maxStagedBytes: limits.maxStagedBytes }),
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    try {
      const next = new SealedManimRenderSandboxRequestV1(
        descriptor({ jobId: "tenant-a/session-next", sessionId: "session-next" }),
      );
      await expect(
        runner.submitOrReattach(next, next.parseDescriptor().deadlineEpochMs, new AbortController().signal),
      ).resolves.toEqual({ code: "capacity", kind: "failed" });
    } finally {
      await runner.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("counts active maximum-size reservations against staging capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-active-reservation-"));
    await chmod(root, 0o700);
    const docker = new BlockingDockerClient();
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: docker,
      image,
      maxStagedArtifacts: 1,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    const first = new SealedManimRenderSandboxRequestV1(
      descriptor({ jobId: "tenant-a/session-active", sessionId: "session-active" }),
    );
    const running = runner.submitOrReattach(
      first,
      first.parseDescriptor().deadlineEpochMs,
      new AbortController().signal,
    );
    try {
      await docker.entered;
      const second = new SealedManimRenderSandboxRequestV1(
        descriptor({ jobId: "tenant-a/session-blocked", sessionId: "session-blocked" }),
      );
      await expect(
        runner.submitOrReattach(second, second.parseDescriptor().deadlineEpochMs, new AbortController().signal),
      ).resolves.toEqual({ code: "capacity", kind: "failed" });
    } finally {
      docker.release();
      await running;
      await Promise.allSettled([runner.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails startup closed when unexpired staging already exceeds its hard cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-startup-capacity-"));
    await chmod(root, 0o700);
    await writeStagedVideo(root, descriptor({ jobId: "tenant-a/session-one", sessionId: "session-one" }));
    await writeStagedVideo(root, descriptor({ jobId: "tenant-a/session-two", sessionId: "session-two" }));
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: new ScriptedDockerClient(),
      image,
      maxStagedArtifacts: 1,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    try {
      await expect(runner.reconcileOrphans()).rejects.toThrow(/hard capacity/i);
    } finally {
      await runner.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("sweeps a successful staging pair when its runtime deadline expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-runtime-sweep-"));
    await chmod(root, 0o700);
    const current = descriptor({
      deadlineEpochMs: Date.now() + 100,
      jobId: "tenant-a/session-timer",
      sessionId: "session-timer",
    });
    const paths = await writeStagedVideo(root, current);
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: new ScriptedDockerClient(),
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    try {
      const request = new SealedManimRenderSandboxRequestV1(current);
      await expect(
        runner.submitOrReattach(request, current.deadlineEpochMs, new AbortController().signal),
      ).resolves.toMatchObject({ kind: "ready" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(readFile(paths.artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(paths.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runner.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reclaims an expired different job before admitting a staged reattach", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-reclaim-"));
    await chmod(root, 0o700);
    const expired = descriptor({
      deadlineEpochMs: Date.now() - 1_000,
      jobId: "tenant-a/session-expired",
      sessionId: "session-expired",
    });
    const current = descriptor({ jobId: "tenant-a/session-current", sessionId: "session-current" });
    const expiredPaths = await writeStagedVideo(root, expired);
    const currentPaths = await writeStagedVideo(root, current);
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: new ScriptedDockerClient(),
      image,
      maxStagedArtifacts: 1,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    try {
      const request = new SealedManimRenderSandboxRequestV1(current);
      await expect(
        runner.submitOrReattach(request, current.deadlineEpochMs, new AbortController().signal),
      ).resolves.toMatchObject({ kind: "ready", stagingId: currentPaths.stagingId });
      await expect(readFile(expiredPaths.artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(expiredPaths.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runner.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("production durable render execution", () => {
  it("loads sealed source, submits fixed video and thumbnail outputs, and returns only opaque locators", async () => {
    const deadline = new Date(Date.now() + 60_000);
    const patchedDigest = createHash("sha256").update(source, "utf8").digest("hex");
    const session = partial<DurableRenderSessionV1>({
      deadline,
      fenceToken: 7n,
      id: "session-a",
      patched: {
        blob: {
          byteSize: Buffer.byteLength(source),
          digest: patchedDigest,
          etag: "etag-a",
          objectKey: `tenants/tenant-a/sources/${patchedDigest}`,
          versionId: "version-a",
        },
      },
      projectId: "project-a",
      sceneName: "MainScene",
      sourcePath: "main.py",
      tenantId: "tenant-a",
    });
    const blobs = partial<SourceContentBlobStoreV1>({ readSource: vi.fn(async () => source) });
    const submitted: SealedManimRenderSandboxRequestV1[] = [];
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      status: vi.fn(async () => healthyStatus()),
      submitOrReattach: vi.fn<ManimRenderSandboxBackendV1["submitOrReattach"]>(async (request) => {
        submitted.push(request);
        const value = request.parseDescriptor();
        return {
          artifactDigest: "b".repeat(64),
          artifactSize: 12,
          deadlineEpochMs: value.deadlineEpochMs,
          fenceToken: value.fenceToken,
          jobId: value.jobId,
          kind: "ready",
          logTail: "",
          mediaType: value.output.mediaType,
          profileDigest: value.profileDigest,
          requestDigest: request.requestDigest,
          runtimeDigest: value.runtimeDigest,
          schema: MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
          sessionId: value.sessionId,
          sourceDigest: value.sourceDigest,
          stagingId: manimRenderStagingIdV1(value.jobId, value.output.kind),
          tenantId: value.tenantId,
          version: 1 as const,
        };
      }),
    });
    const executor = new ProductionDurableManimRenderExecutorV1({
      backend,
      blobs,
      frame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
      profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
      runtimeDigest: digestManimRenderGatedOciRuntimeV1(image),
      tenantId: "tenant-a",
    });
    try {
      await expect(executor.ready()).resolves.toBe(true);
      const result = await executor.submitOrReattach({
        jobId: "tenant-a/session-a",
        session,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ kind: "ready", logTail: "" });
      if (result.kind !== "ready" || !result.artifactLocator) throw new Error("The executor did not return a locator.");
      expect(result.artifactLocator).not.toContain("/tmp");
      expect(result.stagingLocators).toBeDefined();
      expect(decodeManimRenderStagingLocatorV1(result.artifactLocator)).toMatchObject({
        fenceToken: "7",
        jobId: "tenant-a/session-a",
        sourceDigest: patchedDigest,
      });
      expect(submitted.map((request) => request.parseDescriptor())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            output: expect.objectContaining({
              kind: "video",
              mediaType: "video/mp4",
              pixelHeight: 480,
              pixelWidth: 854,
            }),
            source,
          }),
          expect.objectContaining({
            output: expect.objectContaining({
              kind: "thumbnail",
              mediaType: "image/png",
              pixelHeight: 480,
              pixelWidth: 854,
            }),
            source,
          }),
        ]),
      );
    } finally {
      await executor.close();
    }
  });
});

describe("render broker bounded shutdown", () => {
  it("round-trips status and successful void cancellation over the real UDS protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-roundtrip-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    const cancelled: string[] = [];
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async (jobId) => {
        cancelled.push(jobId);
      },
      close: async () => undefined,
      status: async () => healthyStatus(),
      submitOrReattach: () => never(),
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      socketGroupId: process.getegid!(),
      socketPath,
    });
    const client = new ManimRenderUdsSandboxBackendV1({ socketPath });
    try {
      await expect(
        client.status({ deadlineEpochMs: Date.now() + 5_000, signal: new AbortController().signal }),
      ).resolves.toEqual(healthyStatus());
      await expect(
        client.cancel("tenant-a/session-a", {
          deadlineEpochMs: Date.now() + 5_000,
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
      expect(cancelled).toEqual(["tenant-a/session-a"]);
    } finally {
      await Promise.allSettled([client.close(), broker.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    { mediaType: "image/png" as const, stagingId: manimRenderStagingIdV1("tenant-a/session-a", "video") },
    { mediaType: "video/mp4" as const, stagingId: manimRenderStagingIdV1("tenant-a/session-a", "thumbnail") },
  ])("rejects forged ready correlation from the broker (%o)", async (forged) => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-forged-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async () => undefined,
      close: async () => undefined,
      status: async () => healthyStatus(),
      submitOrReattach: async (request) => {
        const value = request.parseDescriptor();
        return {
          artifactDigest: "b".repeat(64),
          artifactSize: 12,
          deadlineEpochMs: value.deadlineEpochMs,
          fenceToken: value.fenceToken,
          jobId: value.jobId,
          kind: "ready",
          logTail: "",
          mediaType: forged.mediaType,
          profileDigest: value.profileDigest,
          requestDigest: request.requestDigest,
          runtimeDigest: value.runtimeDigest,
          schema: MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
          sessionId: value.sessionId,
          sourceDigest: value.sourceDigest,
          stagingId: forged.stagingId,
          tenantId: value.tenantId,
          version: 1,
        };
      },
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      socketGroupId: process.getegid!(),
      socketPath,
    });
    const client = new ManimRenderUdsSandboxBackendV1({ socketPath });
    try {
      const request = new SealedManimRenderSandboxRequestV1(descriptor());
      await expect(
        client.submitOrReattach(request, {
          deadlineEpochMs: request.parseDescriptor().deadlineEpochMs,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/transport/i);
    } finally {
      await Promise.allSettled([client.close(), broker.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not dispatch or retain clients that withhold their write EOF", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-half-open-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    let statusCalls = 0;
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async () => undefined,
      close: async () => undefined,
      status: async () => {
        statusCalls += 1;
        return healthyStatus();
      },
      submitOrReattach: () => never(),
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      maxConnections: 4,
      socketGroupId: process.getegid!(),
      socketPath,
    });
    const peers = Array.from({ length: 4 }, () => new Socket());
    try {
      await Promise.all(
        peers.map(
          (peer) =>
            new Promise<void>((resolve, reject) => {
              peer.once("error", reject);
              peer.connect(socketPath, resolve);
            }),
        ),
      );
      const closed = peers.map((peer) => new Promise<void>((resolve) => peer.once("close", () => resolve())));
      const frame = encodeManimRenderSandboxBrokerClientFrameV1({
        deadlineEpochMs: Date.now() + 5_000,
        kind: "status",
      });
      for (const peer of peers) peer.write(frame);
      await Promise.all(closed);
      expect(statusCalls).toBe(0);

      const client = new ManimRenderUdsSandboxBackendV1({ socketPath });
      try {
        await expect(
          client.status({ deadlineEpochMs: Date.now() + 5_000, signal: new AbortController().signal }),
        ).resolves.toEqual(healthyStatus());
        expect(statusCalls).toBe(1);
      } finally {
        await client.close();
      }
    } finally {
      for (const peer of peers) peer.destroy();
      await Promise.allSettled([broker.close()]);
      await rm(root, { force: true, recursive: true });
    }
  }, 10_000);

  it("never emits a success frame after the operation deadline aborts", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-late-success-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    let backendEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      backendEntered = resolve;
    });
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async () => undefined,
      close: async () => undefined,
      status: async ({ signal }) => {
        backendEntered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return healthyStatus();
      },
      submitOrReattach: () => never(),
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      closeTimeoutMs: 100,
      socketGroupId: process.getegid!(),
      socketPath,
    });
    const peer = new Socket();
    const received: Buffer[] = [];
    try {
      vi.useFakeTimers();
      await new Promise<void>((resolve, reject) => {
        peer.once("error", reject);
        peer.connect(socketPath, resolve);
      });
      const closed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
      peer.on("data", (chunk) => received.push(Buffer.from(chunk)));
      peer.end(
        encodeManimRenderSandboxBrokerClientFrameV1({
          deadlineEpochMs: Date.now() + 50,
          kind: "status",
        }),
      );
      await entered;
      await vi.advanceTimersByTimeAsync(51);
      await closed;
      expect(Buffer.concat(received)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      peer.destroy();
      await Promise.allSettled([broker.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("goes fatal when a backend ignores the operation deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-deadline-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async () => undefined,
      close: async () => undefined,
      status: () => never(),
      submitOrReattach: () => never(),
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      closeTimeoutMs: 25,
      socketGroupId: process.getegid!(),
      socketPath,
    });
    const client = new ManimRenderUdsSandboxBackendV1({ socketPath });
    try {
      await expect(
        client.status({ deadlineEpochMs: Date.now() + 50, signal: new AbortController().signal }),
      ).rejects.toThrow();
      await expect(broker.fatal).resolves.toBeUndefined();
    } finally {
      await Promise.allSettled([client.close(), broker.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("goes fatal when a disconnected peer leaves an unresolved backend operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-peer-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    let entered!: () => void;
    const backendEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async () => undefined,
      close: async () => undefined,
      status: () => {
        entered();
        return never();
      },
      submitOrReattach: () => never(),
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      closeTimeoutMs: 25,
      socketGroupId: process.getegid!(),
      socketPath,
    });
    const peer = new Socket();
    try {
      await new Promise<void>((resolve, reject) => {
        peer.once("error", reject);
        peer.connect(socketPath, resolve);
      });
      peer.end(
        encodeManimRenderSandboxBrokerClientFrameV1({
          deadlineEpochMs: Date.now() + 1_000,
          kind: "status",
        }),
      );
      await backendEntered;
      peer.destroy();
      await expect(broker.fatal).resolves.toBeUndefined();
    } finally {
      peer.destroy();
      await Promise.allSettled([broker.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("bounds a hanging backend close and reports the broker fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-close-"));
    await chmod(root, 0o700);
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async () => undefined,
      close: () => never(),
      status: () => never(),
      submitOrReattach: () => never(),
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      closeTimeoutMs: 25,
      socketGroupId: process.getegid!(),
      socketPath: join(root, "render.sock"),
    });
    try {
      await expect(broker.close()).rejects.toThrow(/close safely/i);
      await expect(broker.fatal).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
