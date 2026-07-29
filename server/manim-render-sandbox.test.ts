import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  DurableManimRenderCancellationCoordinatorV1,
  DurableManimRenderCancellationRelayV1,
} from "./durable-manim-render-cancellation";
import { FastManimGatedOciDockerClientV1 } from "./fast-manim-gated-oci-job-runner";
import { acquireFastManimSandboxOwnerLeaseV1 } from "./fast-manim-sandbox-broker-lease";
import {
  classifyManimRenderCgroupFailureV1,
  deliverSealedManimRenderGateRequestV1,
  digestManimRenderGatedOciRuntimeV1,
  MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
  MANIM_RENDER_GATED_OCI_PROFILE_V1,
  ManimRenderGatedOciJobRunnerV1,
  writeBoundedManimRenderChildStdoutV1,
} from "./manim-render-gated-oci-job-runner";
import { parseManimRenderProductionSandboxBrokerConfigV1 } from "./manim-render-production-sandbox-broker-entry";
import { createManimRenderProductionSandboxClientV1 } from "./manim-render-production-sandbox-client";
import { ManimRenderGatedOciBackendV1, type ManimRenderSandboxBackendV1 } from "./manim-render-sandbox-backend";
import {
  encodeManimRenderSandboxBrokerClientFrameV1,
  encodeManimRenderSandboxBrokerServerFrameV1,
  ManimRenderSandboxBrokerClientFrameDecoderV1,
  ManimRenderSandboxBrokerProtocolErrorV1,
  ManimRenderSandboxBrokerServerFrameDecoderV1,
} from "./manim-render-sandbox-broker-protocol";
import { startManimRenderSandboxBrokerServerV1 } from "./manim-render-sandbox-broker-server";
import {
  decodeManimRenderStagingLocatorV1,
  digestManimRenderSandboxCancellationFenceV1,
  digestManimRenderSandboxExecutionV2,
  digestManimRenderStagingRootV1,
  encodeManimRenderStagingLocatorV1,
  MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
  MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
  MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1,
  manimRenderStagingIdV1,
  SealedManimRenderSandboxRequestV2,
  verifySealedManimRenderSandboxRequestV2,
} from "./manim-render-sandbox-contract";
import { ManimRenderUdsSandboxBackendV1 } from "./manim-render-uds-sandbox-backend";
import { ProductionDurableManimRenderExecutorV1 } from "./production-durable-manim-render-executor";
import { inspectProjectPngBytesV1, type ProjectPngBlobStoreV1 } from "./storage/project-png-storage";
import type {
  DurableRenderCancellationDeliveryV1,
  DurableRenderCancellationIntentV1,
  RenderCancellationRepositoryV1,
} from "./storage/render-cancellation-repository";
import type { DurableRenderSessionV1 } from "./storage/render-session-repository";
import type { SourceContentBlobStoreV1 } from "./storage/workspace-source-repository";

const image = `sha256:${"a".repeat(64)}`;
const brokerShardId = "render-shard-a";
const stagingRoot = "/var/lib/poietra/render-staging";
const source = `from manim import Scene\n\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(0.1)\n`;
const sourceDigest = createHash("sha256").update(source, "utf8").digest("hex");
const projectPngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const projectPng = inspectProjectPngBytesV1(projectPngBytes);

function descriptor(overrides: Partial<ConstructorParameters<typeof SealedManimRenderSandboxRequestV2>[0]> = {}) {
  return {
    assets: [],
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
    schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
    sessionId: "session-a",
    source,
    sourceDigest,
    sourcePath: "main.py",
    tenantId: "tenant-a",
    version: 2 as const,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function healthyStatus() {
  return {
    backendId: "test-render-backend",
    brokerShardId,
    health: "ready" as const,
    profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
    runtimeDigest: digestManimRenderGatedOciRuntimeV1(image),
    stagingRootDigest: digestManimRenderStagingRootV1(stagingRoot),
    schema: MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1,
    version: 1 as const,
  };
}

function cancellationAcknowledgement(
  fence: Parameters<ManimRenderSandboxBackendV1["cancel"]>[0],
  shardId = brokerShardId,
) {
  return {
    brokerShardId: shardId,
    fenceDigest: digestManimRenderSandboxCancellationFenceV1(fence),
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
      executionDigest: digestManimRenderSandboxExecutionV2(value),
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
  it("classifies only bounded kernel cgroup resource events", () => {
    const noMemoryPressure = "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n";
    const belowCpuBudget = "usage_usec 29999999\nuser_usec 20000000\nsystem_usec 9999999\n";
    const exhaustedCpuBudget = "usage_usec 30000000\nuser_usec 20000000\nsystem_usec 10000000\n";
    expect(classifyManimRenderCgroupFailureV1(noMemoryPressure, "max 0\n", belowCpuBudget)).toBeNull();
    expect(classifyManimRenderCgroupFailureV1(noMemoryPressure, "max 0\n", exhaustedCpuBudget)).toBe("cpu-limit");
    expect(classifyManimRenderCgroupFailureV1(noMemoryPressure, "max 1\n", exhaustedCpuBudget)).toBe("pids-limit");
    expect(classifyManimRenderCgroupFailureV1("oom 1\noom_kill 0\n", "max 0\n", exhaustedCpuBudget)).toBe(
      "memory-limit",
    );
    expect(() => classifyManimRenderCgroupFailureV1("oom 1\noom_kill 0\n", "max 1\n", exhaustedCpuBudget)).toThrow(
      /ambiguous/i,
    );
    expect(() => classifyManimRenderCgroupFailureV1("oom 0\n", "max 0\n", belowCpuBudget)).toThrow(/incomplete/i);
    expect(() => classifyManimRenderCgroupFailureV1("oom 0\noom_kill 0\noom 1\n", "max 0\n", belowCpuBudget)).toThrow(
      /invalid/i,
    );
    expect(() => classifyManimRenderCgroupFailureV1("oom 0\noom_kill 0 \n", "max 0\n", belowCpuBudget)).toThrow(
      /invalid/i,
    );
    expect(() => classifyManimRenderCgroupFailureV1(noMemoryPressure, "max 0\n", "user_usec 1\n")).toThrow(
      /incomplete/i,
    );
    expect(() =>
      classifyManimRenderCgroupFailureV1(noMemoryPressure, "max 0\n", "usage_usec 1\nusage_usec 2\n"),
    ).toThrow(/invalid/i);
    expect(() =>
      classifyManimRenderCgroupFailureV1(noMemoryPressure, "max 0\n", "usage_usec 1\nfuture_usec 0\n"),
    ).toThrow(/invalid/i);
  });

  it("pins cumulative CPU, file, and tmpfs inode limits in the digested OCI profile", () => {
    const profile = MANIM_RENDER_GATED_OCI_PROFILE_V1;
    expect(profile.cpuTimeMicroseconds).toBe(30_000_000);
    expect(profile.ulimits).toContainEqual({
      hard: profile.artifactBytes,
      name: "fsize",
      soft: profile.artifactBytes,
    });
    expect(profile.tmpfs).toEqual({
      inodeLimit: 4_096,
      options: [
        "rw",
        "noexec",
        "nosuid",
        "nodev",
        "size=268435456",
        "nr_inodes=4096",
        "mode=0700",
        "uid=65532",
        "gid=65532",
      ],
      path: "/run/poietra",
    });
  });

  it("rejects non-canonical or over-budget staging roots before identity correlation", () => {
    expect(() => digestManimRenderStagingRootV1("/tmp/staging\0suffix")).toThrow(/staging root/i);
    expect(() => digestManimRenderStagingRootV1(`/${"a".repeat(4_096)}`)).toThrow(/staging root/i);
    expect(() => digestManimRenderStagingRootV1("relative/staging")).toThrow(/staging root/i);
    expect(digestManimRenderStagingRootV1(stagingRoot)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("seals private bytes and keeps execution identity stable across fencing", () => {
    const mutable = descriptor();
    const sealed = new SealedManimRenderSandboxRequestV2(mutable);
    mutable.source = "tampered";
    const copied = sealed.copyBytes();
    copied[0] ^= 0xff;

    expect(verifySealedManimRenderSandboxRequestV2(sealed)).toBe(true);
    expect(sealed.parseDescriptor().source).toBe(source);
    const refenced = new SealedManimRenderSandboxRequestV2(
      descriptor({
        deadlineEpochMs: sealed.parseDescriptor().deadlineEpochMs,
        fenceToken: "2",
      }),
    );
    expect(refenced.requestDigest).not.toBe(sealed.requestDigest);
    expect(digestManimRenderSandboxExecutionV2(refenced.parseDescriptor())).toBe(
      digestManimRenderSandboxExecutionV2(sealed.parseDescriptor()),
    );
    expect(manimRenderStagingIdV1(mutable.jobId, "thumbnail")).not.toBe(manimRenderStagingIdV1(mutable.jobId, "video"));
    expect(
      () => new SealedManimRenderSandboxRequestV2(descriptor({ sceneFrame: { height: 8, width: 14.222 } })),
    ).toThrow();
    expect(
      () =>
        new SealedManimRenderSandboxRequestV2(
          descriptor({
            assets: [
              {
                byteLength: projectPng.byteSize,
                bytesBase64: projectPngBytes.toString("base64"),
                digest: "0".repeat(64),
                height: projectPng.height,
                logicalPath: "image.png",
                mediaType: "image/png",
                width: projectPng.width,
              },
            ],
          }),
        ),
    ).toThrow(/asset/i);
  });

  it("encodes only bounded correlation metadata in opaque staging locators", () => {
    const request = new SealedManimRenderSandboxRequestV2(descriptor());
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
    const request = new SealedManimRenderSandboxRequestV2(descriptor());
    const clientFrames = [
      encodeManimRenderSandboxBrokerClientFrameV1({
        deadlineEpochMs: Date.now() + 60_000,
        kind: "status",
      }),
      encodeManimRenderSandboxBrokerClientFrameV1({
        deadlineEpochMs: request.parseDescriptor().deadlineEpochMs,
        kind: "submit",
        requestBytesBase64: Buffer.from(request.copyBytes()).toString("base64"),
        requestDigest: request.requestDigest,
      }),
      encodeManimRenderSandboxBrokerClientFrameV1({
        deadlineEpochMs: Date.now() + 60_000,
        fence: {
          jobId: "tenant-a/session-a",
          rejectUntilEpochMs: request.parseDescriptor().deadlineEpochMs,
          sessionId: "session-a",
          tenantId: "tenant-a",
        },
        kind: "cancel",
      }),
      encodeManimRenderSandboxBrokerClientFrameV1({
        deadlineEpochMs: Date.now() + 60_000,
        jobId: "tenant-a/session-a",
        kind: "cleanup",
      }),
    ];
    for (const frame of clientFrames) {
      const decoder = new ManimRenderSandboxBrokerClientFrameDecoderV1();
      let decoded: unknown;
      for (const byte of frame) decoded ??= decoder.push(Buffer.from([byte]));
      decoder.finish();
      expect(decoded).toMatchObject({ kind: expect.any(String) });
    }

    for (const operation of ["status", "submit", "cancel", "cleanup"] as const) {
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

  it("rejects legacy status and cancellation responses without a broker shard attestation", () => {
    const legacyStatus = Object.fromEntries(Object.entries(healthyStatus()).filter(([key]) => key !== "brokerShardId"));
    const statusFrame = encodeManimRenderSandboxBrokerServerFrameV1("status", {
      kind: "status-result",
      status: healthyStatus(),
    });
    const legacyStatusFrame = Buffer.concat([
      statusFrame.subarray(0, 1),
      Buffer.from(canonicalJsonV1({ kind: "status-result", status: legacyStatus }), "utf8"),
      Buffer.from("\n"),
    ]);
    expect(() => new ManimRenderSandboxBrokerServerFrameDecoderV1("status").push(legacyStatusFrame)).toThrow(
      ManimRenderSandboxBrokerProtocolErrorV1,
    );

    const fence = {
      jobId: "tenant-a/session-a",
      rejectUntilEpochMs: Date.now() + 60_000,
      sessionId: "session-a",
      tenantId: "tenant-a",
    };
    const cancelFrame = encodeManimRenderSandboxBrokerServerFrameV1("cancel", {
      ...cancellationAcknowledgement(fence),
      cancelled: true,
      kind: "cancel-result",
    });
    const legacyCancelFrame = Buffer.concat([
      cancelFrame.subarray(0, 1),
      Buffer.from(
        canonicalJsonV1({
          cancelled: true,
          fenceDigest: digestManimRenderSandboxCancellationFenceV1(fence),
          kind: "cancel-result",
        }),
        "utf8",
      ),
      Buffer.from("\n"),
    ]);
    expect(() => new ManimRenderSandboxBrokerServerFrameDecoderV1("cancel").push(legacyCancelFrame)).toThrow(
      ManimRenderSandboxBrokerProtocolErrorV1,
    );
  });

  it("rejects root Studio clients and unknown broker config keys", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    await expect(
      createManimRenderProductionSandboxClientV1({
        brokerShardId,
        brokerUserId: 1001,
        imageDigest: image,
        socketGroupId: process.getegid!(),
        socketPath: "/missing/render.sock",
        stagingRoot,
      }),
    ).rejects.toThrow(/principal/i);
    expect(() =>
      parseManimRenderProductionSandboxBrokerConfigV1({
        brokerShardId,
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

  it("requires a portable opaque broker shard identity in immutable broker configuration", () => {
    const config = {
      brokerShardId,
      brokerUserId: 1001,
      dockerSocketPath: "/run/user/1001/docker.sock",
      imageDigest: image,
      seccompPath: "/etc/poietra/seccomp.json",
      socketGroupId: 1002,
      socketPath: "/run/poietra/render.sock",
      stagingRoot: "/var/lib/poietra/render-staging",
    };
    expect(parseManimRenderProductionSandboxBrokerConfigV1(config)).toEqual(config);
    const { brokerShardId: _brokerShardId, ...missingShard } = config;
    expect(() => parseManimRenderProductionSandboxBrokerConfigV1(missingShard)).toThrow();
    expect(() => parseManimRenderProductionSandboxBrokerConfigV1({ ...config, brokerShardId: " shard-a" })).toThrow();
    expect(() => new ManimRenderUdsSandboxBackendV1({ socketPath: "/run/poietra/render.sock" } as never)).toThrow();
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
    const privateDocker = new ScriptedDockerClient();
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: privateDocker,
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot,
    });
    try {
      await expect(runner.reconcileOrphans()).resolves.toBeUndefined();
      expect(privateDocker.calls[0]).toEqual([
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        "label=io.poietra.render-job=v1",
        "--filter",
        `label=io.poietra.render-owner-sha256=${digestManimRenderStagingRootV1(stagingRoot)}`,
      ]);
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
    {
      label: "readiness timeout",
      program: "setInterval(() => undefined, 1000);",
      timeoutMs: 25,
    },
  ])("reaps the attached Docker client after gate $label", async ({ program, timeoutMs }) => {
    const request = new SealedManimRenderSandboxRequestV2(descriptor());
    const child = spawn(process.execPath, ["--eval", program], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await expect(
      deliverSealedManimRenderGateRequestV1(
        child,
        request,
        digestManimRenderSandboxExecutionV2(request.parseDescriptor()),
        Date.now() + timeoutMs,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("accepts one exact readiness marker split across attach chunks", async () => {
    const request = new SealedManimRenderSandboxRequestV2(descriptor());
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `process.stderr.write("POIETRA_RENDER_");
setTimeout(() => process.stderr.write("GATE_READY_V1\\n"), 10);
process.stdin.resume();
process.stdin.once("end", () => setInterval(() => undefined, 1_000));`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const gated = await deliverSealedManimRenderGateRequestV1(
      child,
      request,
      digestManimRenderSandboxExecutionV2(request.parseDescriptor()),
      Date.now() + 2_000,
      new AbortController().signal,
    );
    await gated.closeControlStream();
    expect(gated.controlStreamViolated()).toBe(false);
  });

  it("rejects a control violation racing a backpressured request write", async () => {
    const largeSource = `${source}\n# ${"x".repeat(1024 * 1024)}`;
    const request = new SealedManimRenderSandboxRequestV2(
      descriptor({
        source: largeSource,
        sourceDigest: createHash("sha256").update(largeSource, "utf8").digest("hex"),
      }),
    );
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `process.stderr.write("POIETRA_RENDER_GATE_READY_V1\\n");
process.exit(0);`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await expect(
      deliverSealedManimRenderGateRequestV1(
        child,
        request,
        digestManimRenderSandboxExecutionV2(request.parseDescriptor()),
        Date.now() + 2_000,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/control stream/i);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it.each([
    { condition: "stdout output", statement: 'process.stdout.write("unexpected");' },
    { condition: "stderr output", statement: 'process.stderr.write("unexpected");' },
    { condition: "early close", statement: "process.exit(0);" },
  ])("keeps post-readiness gate $condition sticky", async ({ statement }) => {
    const request = new SealedManimRenderSandboxRequestV2(descriptor());
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `process.stderr.write("POIETRA_RENDER_GATE_READY_V1\\n");
process.stdin.resume();
process.stdin.once("end", () => {
  ${statement}
  setTimeout(() => process.exit(0), 500);
});`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const gated = await deliverSealedManimRenderGateRequestV1(
      child,
      request,
      digestManimRenderSandboxExecutionV2(request.parseDescriptor()),
      Date.now() + 2_000,
      new AbortController().signal,
    );
    await gated.attachedExit;
    expect(gated.controlStreamViolated()).toBe(true);
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
    const child = spawn(process.execPath, ["--eval", program], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
      const request = new SealedManimRenderSandboxRequestV2(descriptor());
      await expect(
        runner.submitOrReattach(request, request.parseDescriptor().deadlineEpochMs, new AbortController().signal),
      ).resolves.toEqual({ code: "cleanup-failed", kind: "failed" });
      await expect(runner.ready()).resolves.toBe(false);
      const current = request.parseDescriptor();
      await expect(
        runner.cancel(
          {
            jobId: current.jobId,
            rejectUntilEpochMs: current.deadlineEpochMs,
            sessionId: current.sessionId,
            tenantId: current.tenantId,
          },
          Date.now() + 5_000,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/create outcome/i);
      await expect(runner.close()).rejects.toThrow(/cleanup/i);
      expect(docker.calls.filter((call) => call[0] === "container" && call[1] === "ls")).toHaveLength(2);
      const create = docker.calls.find((call) => call[0] === "container" && call[1] === "create");
      expect(create).toContain(
        `--ulimit=fsize=${MANIM_RENDER_GATED_OCI_PROFILE_V1.artifactBytes}:${MANIM_RENDER_GATED_OCI_PROFILE_V1.artifactBytes}`,
      );
      expect(create).toContain(
        `--tmpfs=${MANIM_RENDER_GATED_OCI_PROFILE_V1.tmpfs.path}:${MANIM_RENDER_GATED_OCI_PROFILE_V1.tmpfs.options.join(",")}`,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists cancel-first admission across runner restart without fencing normal cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-cancel-fence-"));
    await chmod(root, 0o700);
    const docker = new ScriptedDockerClient();
    const first = new ManimRenderGatedOciJobRunnerV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: docker,
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    const current = descriptor();
    const request = new SealedManimRenderSandboxRequestV2(current);
    const fence = {
      jobId: current.jobId,
      rejectUntilEpochMs: current.deadlineEpochMs,
      sessionId: current.sessionId,
      tenantId: current.tenantId,
    };
    const alternateFence = {
      jobId: "tenant_a/session_a",
      rejectUntilEpochMs: current.deadlineEpochMs,
      sessionId: "session_a",
      tenantId: "tenant_a",
    };
    let restarted: ManimRenderGatedOciJobRunnerV1 | undefined;
    try {
      await first.reconcileOrphans();
      await first.cleanup("tenant-a/cleanup-only", Date.now() + 5_000, new AbortController().signal);
      expect(await readdir(root)).toEqual([]);
      await first.cancel(fence, Date.now() + 5_000, new AbortController().signal);
      await first.cancel(alternateFence, Date.now() + 5_000, new AbortController().signal);
      const state = JSON.parse(await readFile(join(root, "render-cancellations-v1.json"), "utf8"));
      expect(state.entries).toEqual([fence, alternateFence]);
      await expect(
        first.cancel(
          { ...fence, rejectUntilEpochMs: fence.rejectUntilEpochMs + 1 },
          Date.now() + 5_000,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/different cancellation fence/i);
      await first.close();

      restarted = new ManimRenderGatedOciJobRunnerV1({
        cgroupKillPolicy: "best-effort",
        dockerClient: docker,
        image,
        seccompPath: "/missing/seccomp.json",
        stagingRoot: root,
      });
      await restarted.reconcileOrphans();
      await expect(
        restarted.submitOrReattach(request, current.deadlineEpochMs, new AbortController().signal),
      ).resolves.toEqual({ code: "cancelled", kind: "failed" });
      expect(docker.calls.filter((call) => call[0] === "container" && call[1] === "create")).toEqual([]);
    } finally {
      await Promise.allSettled([first.close(), restarted?.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("isolates cancellation-fence capacity per tenant without latching the broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-cancel-capacity-"));
    await chmod(root, 0o700);
    const deadlineEpochMs = Date.now() + 60_000;
    const entries = Array.from(
      { length: MANIM_RENDER_GATED_OCI_PROFILE_V1.cancellationFences.maximumEntriesPerTenant },
      (_, index) => {
        const sessionId = `session-${index.toString().padStart(3, "0")}`;
        return { jobId: `tenant-a/${sessionId}`, rejectUntilEpochMs: deadlineEpochMs, sessionId, tenantId: "tenant-a" };
      },
    );
    await writeFile(
      join(root, "render-cancellations-v1.json"),
      canonicalJsonV1({
        entries,
        schema: "poietra.manim-render-cancellation-state",
        stagingRootDigest: digestManimRenderStagingRootV1(root),
        version: 1,
      }),
      { mode: 0o600 },
    );
    const runner = new ManimRenderGatedOciJobRunnerV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: new ScriptedDockerClient(),
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    try {
      await runner.reconcileOrphans();
      await expect(
        runner.cancel(
          {
            jobId: "tenant-a/session-overflow",
            rejectUntilEpochMs: deadlineEpochMs,
            sessionId: "session-overflow",
            tenantId: "tenant-a",
          },
          Date.now() + 5_000,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/capacity/i);
      const otherTenantFence = {
        jobId: "tenant-b/session-a",
        rejectUntilEpochMs: deadlineEpochMs,
        sessionId: "session-a",
        tenantId: "tenant-b",
      };
      await runner.cancel(otherTenantFence, Date.now() + 5_000, new AbortController().signal);
      const state = JSON.parse(await readFile(join(root, "render-cancellations-v1.json"), "utf8"));
      expect(state.entries).toContainEqual(otherTenantFence);
      await runner.close();
    } finally {
      await Promise.allSettled([runner.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails readiness closed on malformed durable cancellation state", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-cancel-corrupt-"));
    await chmod(root, 0o700);
    const statePath = join(root, "render-cancellations-v1.json");
    await writeFile(statePath, "not-json", { encoding: "utf8", mode: 0o600 });
    await chmod(statePath, 0o600);
    const runner = new ManimRenderGatedOciJobRunnerV1({
      dockerClient: new ScriptedDockerClient(),
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: root,
    });
    try {
      await expect(runner.ready()).resolves.toBe(false);
      await expect(runner.reconcileOrphans()).rejects.toThrow();
    } finally {
      await runner.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("removes expired canonical staging pairs and rejects malformed manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-expired-"));
    await chmod(root, 0o700);
    const docker = new ScriptedDockerClient();
    docker.steps.push({
      code: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });
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
        executionDigest: digestManimRenderSandboxExecutionV2(expired),
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
      await expect(readFile(artifactPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(manifestPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await writeFile(manifestPath, "{}", { mode: 0o600 });
      await expect(runner.reconcileOrphans()).rejects.toThrow();
      await runner.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      label: "artifact count",
      maxStagedArtifacts: 1,
      maxStagedBytes: undefined,
    },
    {
      label: "reserved bytes",
      maxStagedArtifacts: 2,
      maxStagedBytes: 128 * 1024 * 1024 + 8 * 1024,
    },
  ])("rejects a different job before staging exceeds its $label cap", async (limits) => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-capacity-"));
    await chmod(root, 0o700);
    const existing = descriptor({
      jobId: "tenant-a/session-existing",
      sessionId: "session-existing",
    });
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
      const next = new SealedManimRenderSandboxRequestV2(
        descriptor({
          jobId: "tenant-a/session-next",
          sessionId: "session-next",
        }),
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
    const first = new SealedManimRenderSandboxRequestV2(
      descriptor({
        jobId: "tenant-a/session-active",
        sessionId: "session-active",
      }),
    );
    const running = runner.submitOrReattach(
      first,
      first.parseDescriptor().deadlineEpochMs,
      new AbortController().signal,
    );
    try {
      await docker.entered;
      const second = new SealedManimRenderSandboxRequestV2(
        descriptor({
          jobId: "tenant-a/session-blocked",
          sessionId: "session-blocked",
        }),
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
      const request = new SealedManimRenderSandboxRequestV2(current);
      await expect(
        runner.submitOrReattach(request, current.deadlineEpochMs, new AbortController().signal),
      ).resolves.toMatchObject({ kind: "ready" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(readFile(paths.artifactPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(paths.manifestPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
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
    const current = descriptor({
      jobId: "tenant-a/session-current",
      sessionId: "session-current",
    });
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
      const request = new SealedManimRenderSandboxRequestV2(current);
      await expect(
        runner.submitOrReattach(request, current.deadlineEpochMs, new AbortController().signal),
      ).resolves.toMatchObject({
        kind: "ready",
        stagingId: currentPaths.stagingId,
      });
      await expect(readFile(expiredPaths.artifactPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(expiredPaths.manifestPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
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
      projectPng: null,
      sceneName: "MainScene",
      sourcePath: "main.py",
      tenantId: "tenant-a",
    });
    const blobs = partial<SourceContentBlobStoreV1>({
      readSource: vi.fn(async () => source),
    });
    const projectPngs = partial<ProjectPngBlobStoreV1>({
      close: vi.fn(async () => undefined),
      read: vi.fn(async () => {
        throw new Error("The source-only render must not read project image.png.");
      }),
      ready: vi.fn(async () => true),
    });
    const submitted: SealedManimRenderSandboxRequestV2[] = [];
    const sandboxResult = (
      request: SealedManimRenderSandboxRequestV2,
      code?:
        | "cancelled"
        | "cleanup-failed"
        | "cpu-limit"
        | "deadline-exceeded"
        | "memory-limit"
        | "pids-limit"
        | "render-failed",
    ) => {
      const value = request.parseDescriptor();
      const correlation = {
        deadlineEpochMs: value.deadlineEpochMs,
        fenceToken: value.fenceToken,
        jobId: value.jobId,
        logTail: "",
        profileDigest: value.profileDigest,
        requestDigest: request.requestDigest,
        runtimeDigest: value.runtimeDigest,
        schema: MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1,
        sessionId: value.sessionId,
        sourceDigest: value.sourceDigest,
        tenantId: value.tenantId,
        version: 1 as const,
      };
      return code
        ? { ...correlation, code, kind: "failed" as const }
        : {
            ...correlation,
            artifactDigest: "b".repeat(64),
            artifactSize: 12,
            kind: "ready" as const,
            mediaType: value.output.mediaType,
            stagingId: manimRenderStagingIdV1(value.jobId, value.output.kind),
          };
    };
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: vi.fn(async (fence) => cancellationAcknowledgement(fence)),
      close: vi.fn(async () => undefined),
      status: vi.fn(async () => healthyStatus()),
      submitOrReattach: vi.fn<ManimRenderSandboxBackendV1["submitOrReattach"]>(async (request) => {
        submitted.push(request);
        return sandboxResult(request);
      }),
    });
    expect(
      () =>
        new ProductionDurableManimRenderExecutorV1({
          backend,
          blobs,
          brokerShardId,
          frame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
          maxConcurrentJobs: 5,
          projectPngs,
          profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
          runtimeDigest: digestManimRenderGatedOciRuntimeV1(image),
          stagingRootDigest: digestManimRenderStagingRootV1(stagingRoot),
          tenantId: "tenant-a",
        }),
    ).toThrow(/configuration/i);
    const executor = new ProductionDurableManimRenderExecutorV1({
      backend,
      blobs,
      brokerShardId,
      frame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
      projectPngs,
      profileDigest: MANIM_RENDER_GATED_OCI_PROFILE_DIGEST_V1,
      runtimeDigest: digestManimRenderGatedOciRuntimeV1(image),
      stagingRootDigest: digestManimRenderStagingRootV1(stagingRoot),
      tenantId: "tenant-a",
    });
    try {
      await expect(executor.ready()).resolves.toBe(true);
      vi.mocked(backend.status).mockResolvedValueOnce({
        ...healthyStatus(),
        brokerShardId: "render-shard-b",
      });
      await expect(executor.ready()).resolves.toBe(false);
      vi.mocked(backend.status).mockResolvedValueOnce({
        ...healthyStatus(),
        stagingRootDigest: "f".repeat(64),
      });
      await expect(executor.ready()).resolves.toBe(false);
      const { descriptorVersion, ...legacyRequestWire } = MANIM_RENDER_GATED_OCI_PROFILE_V1.requestWire;
      expect(descriptorVersion).toBe(2);
      const legacyProfileDigest = createHash("sha256")
        .update(canonicalJsonV1({ ...MANIM_RENDER_GATED_OCI_PROFILE_V1, requestWire: legacyRequestWire }), "utf8")
        .digest("hex");
      const legacyRuntimeDigest = createHash("sha256")
        .update(canonicalJsonV1({ image, profileDigest: legacyProfileDigest }), "utf8")
        .digest("hex");
      vi.mocked(backend.status).mockResolvedValueOnce({
        ...healthyStatus(),
        profileDigest: legacyProfileDigest,
        runtimeDigest: legacyRuntimeDigest,
      });
      await expect(executor.ready()).resolves.toBe(false);

      const cancellationFence = {
        jobId: "tenant-a/session-a",
        rejectUntilEpochMs: Date.now() + 60_000,
        sessionId: "session-a",
        tenantId: "tenant-a",
      };
      vi.mocked(backend.cancel).mockResolvedValueOnce(cancellationAcknowledgement(cancellationFence, "render-shard-b"));
      await expect(executor.cancel(cancellationFence)).rejects.toThrow(/acknowledgement identity/i);
      vi.mocked(backend.cancel).mockResolvedValueOnce({ brokerShardId, fenceDigest: "f".repeat(64) });
      await expect(executor.cancel(cancellationFence)).rejects.toThrow(/acknowledgement identity/i);
      await expect(executor.cancel(cancellationFence)).resolves.toEqual({
        fenceDigest: digestManimRenderSandboxCancellationFenceV1(cancellationFence),
      });

      const submittedBeforeExpired = submitted.length;
      await expect(
        executor.submitOrReattach({
          jobId: "tenant-a/session-expired",
          session: { ...session, deadline: new Date(Date.now() - 1), id: "session-expired" },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ code: "deadline-exceeded", kind: "failed", logTail: "" });
      expect(submitted).toHaveLength(submittedBeforeExpired);

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

      const receipt = {
        byteSize: projectPng.byteSize,
        digest: projectPng.digest,
        etag: "png-etag-a",
        objectKey: `tenants/tenant-a/projects/project-a/assets/image.png/${projectPng.digest}`,
        versionId: "png-version-a",
      };
      vi.mocked(projectPngs.read).mockResolvedValueOnce(projectPngBytes);
      const assetSession = {
        ...session,
        id: "session-png",
        projectPng: {
          generation: 3n,
          projectId: "project-a",
          receipt,
          tenantId: "tenant-a",
        },
      };
      await expect(
        executor.submitOrReattach({
          jobId: "tenant-a/session-png",
          session: assetSession,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: "ready" });
      expect(projectPngs.read).toHaveBeenCalledWith("tenant-a", "project-a", receipt, expect.any(AbortSignal));
      for (const request of submitted.slice(-2)) {
        expect(request.parseDescriptor().assets).toEqual([
          {
            byteLength: projectPng.byteSize,
            bytesBase64: projectPngBytes.toString("base64"),
            digest: projectPng.digest,
            height: projectPng.height,
            logicalPath: "image.png",
            mediaType: "image/png",
            width: projectPng.width,
          },
        ]);
      }

      const submittedBeforeCancellation = submitted.length;
      const sourceReadEntered = deferred<void>();
      const releaseSourceRead = deferred<void>();
      vi.mocked(blobs.readSource).mockImplementationOnce(async () => {
        sourceReadEntered.resolve(undefined);
        await releaseSourceRead.promise;
        return source;
      });
      const sourceReadAbort = new AbortController();
      const sourceReadExecution = executor.submitOrReattach({
        jobId: "tenant-a/session-source-abort",
        session: { ...session, id: "session-source-abort" },
        signal: sourceReadAbort.signal,
      });
      await sourceReadEntered.promise;
      sourceReadAbort.abort(new DOMException("cancelled", "AbortError"));
      releaseSourceRead.resolve(undefined);
      await expect(sourceReadExecution).rejects.toMatchObject({ name: "AbortError" });

      const assetReadEntered = deferred<void>();
      const releaseAssetRead = deferred<void>();
      vi.mocked(projectPngs.read).mockImplementationOnce(async () => {
        assetReadEntered.resolve(undefined);
        await releaseAssetRead.promise;
        return projectPngBytes;
      });
      const assetReadAbort = new AbortController();
      const assetReadExecution = executor.submitOrReattach({
        jobId: "tenant-a/session-asset-abort",
        session: { ...assetSession, id: "session-asset-abort" },
        signal: assetReadAbort.signal,
      });
      await assetReadEntered.promise;
      assetReadAbort.abort(new DOMException("cancelled", "AbortError"));
      releaseAssetRead.resolve(undefined);
      await expect(assetReadExecution).rejects.toMatchObject({ name: "AbortError" });
      expect(submitted).toHaveLength(submittedBeforeCancellation);

      for (const code of ["cpu-limit", "deadline-exceeded", "memory-limit", "pids-limit"] as const) {
        vi.mocked(backend.submitOrReattach)
          .mockImplementationOnce(async (request) => sandboxResult(request, code))
          .mockImplementationOnce(async (request) => sandboxResult(request, code));
        await expect(
          executor.submitOrReattach({
            jobId: `tenant-a/session-${code}`,
            session: { ...session, id: `session-${code}` },
            signal: new AbortController().signal,
          }),
        ).resolves.toEqual({ code, kind: "failed", logTail: "" });
      }

      vi.mocked(backend.submitOrReattach)
        .mockImplementationOnce(async (request) => sandboxResult(request, "memory-limit"))
        .mockImplementationOnce(async (request) => sandboxResult(request, "pids-limit"));
      await expect(
        executor.submitOrReattach({
          jobId: "tenant-a/session-mixed-resource",
          session: { ...session, id: "session-mixed-resource" },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ code: "render-failed", kind: "failed", logTail: "" });

      vi.mocked(backend.submitOrReattach)
        .mockImplementationOnce(async (request) => sandboxResult(request, "render-failed"))
        .mockImplementationOnce(async (request) => sandboxResult(request, "cancelled"));
      await expect(
        executor.submitOrReattach({
          jobId: "tenant-a/session-mixed-cancel",
          session: { ...session, id: "session-mixed-cancel" },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ code: "render-failed", kind: "failed", logTail: "" });

      vi.mocked(backend.submitOrReattach)
        .mockImplementationOnce(async (request) => sandboxResult(request, "cleanup-failed"))
        .mockImplementationOnce(async (request) => sandboxResult(request, "cancelled"));
      await expect(
        executor.submitOrReattach({
          jobId: "tenant-a/session-mixed-cleanup",
          session: { ...session, id: "session-mixed-cleanup" },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ code: "render-failed", kind: "failed", logTail: "" });
    } finally {
      await executor.close();
    }
  });
});

describe("render broker bounded shutdown", () => {
  it("holds the staging-owner lease before reconciling through any broker socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-reconcile-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render-a.sock");
    const competingSocketPath = join(root, "render-b.sock");
    const ownerDigest = digestManimRenderStagingRootV1(join(root, "staging"));
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async (fence) => cancellationAcknowledgement(fence),
      close: async () => undefined,
      status: async () => healthyStatus(),
      submitOrReattach: () => never(),
    });
    const firstReconcile = vi.fn(async () => undefined);
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      ownerDigest,
      reconcileOrphans: firstReconcile,
      socketGroupId: process.getegid!(),
      socketPath,
    });
    const secondReconcile = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    try {
      expect(firstReconcile).toHaveBeenCalledOnce();
      await expect(
        startManimRenderSandboxBrokerServerV1({
          backend: { ...backend, close: secondClose },
          ownerDigest,
          reconcileOrphans: secondReconcile,
          socketGroupId: process.getegid!(),
          socketPath: competingSocketPath,
        }),
      ).rejects.toThrow(/lease/i);
      expect(secondReconcile).not.toHaveBeenCalled();
      expect(secondClose).toHaveBeenCalledOnce();
    } finally {
      await broker.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reserves UDS capacity for status and cancellation while eight media submits are active", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-control-capacity-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    const submitOrReattach = vi.fn<ManimRenderSandboxBackendV1["submitOrReattach"]>(
      async (_request, context) =>
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(context.signal.reason ?? new DOMException("Aborted", "AbortError"));
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        }),
    );
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: vi.fn(async (fence) => cancellationAcknowledgement(fence)),
      close: async () => undefined,
      status: vi.fn(async () => healthyStatus()),
      submitOrReattach,
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      maxConcurrentJobs: 8,
      socketGroupId: process.getegid!(),
      socketPath,
    });
    const client = new ManimRenderUdsSandboxBackendV1({ brokerShardId, socketPath });
    const requests = Array.from({ length: 9 }, (_, index) => {
      const deadlineEpochMs = Date.now() + 60_000;
      return new SealedManimRenderSandboxRequestV2(
        descriptor({
          deadlineEpochMs,
          jobId: `tenant-a/session-${index}`,
          sessionId: `session-${index}`,
        }),
      );
    });
    const submit = (request: SealedManimRenderSandboxRequestV2) =>
      client.submitOrReattach(request, {
        deadlineEpochMs: request.parseDescriptor().deadlineEpochMs,
        signal: new AbortController().signal,
      });
    const pending = requests.slice(0, 8).map((request) => submit(request).catch((error: unknown) => error));
    const controlFence = {
      jobId: "tenant-a/session-control",
      rejectUntilEpochMs: Date.now() + 60_000,
      sessionId: "session-control",
      tenantId: "tenant-a",
    };
    try {
      await vi.waitFor(() => expect(submitOrReattach).toHaveBeenCalledTimes(8), { timeout: 5_000 });
      await expect(submit(requests[8]!)).rejects.toThrow(/capacity/i);
      await expect(
        Promise.all([
          client.status({ deadlineEpochMs: Date.now() + 5_000, signal: new AbortController().signal }),
          client.cancel(controlFence, {
            deadlineEpochMs: Date.now() + 5_000,
            signal: new AbortController().signal,
          }),
        ]),
      ).resolves.toEqual([healthyStatus(), cancellationAcknowledgement(controlFence)]);
      expect(submitOrReattach).toHaveBeenCalledTimes(8);
      expect(backend.cancel).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await Promise.all(pending);
      await broker.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("retains the staging-owner lease until timed-out backend cleanup settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-owner-close-"));
    await chmod(root, 0o700);
    const ownerDigest = digestManimRenderStagingRootV1(join(root, "staging"));
    let releaseBackend!: () => void;
    const backendClosed = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async (fence) => cancellationAcknowledgement(fence),
      close: () => backendClosed,
      status: async () => healthyStatus(),
      submitOrReattach: () => never(),
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      closeTimeoutMs: 25,
      ownerDigest,
      reconcileOrphans: async () => undefined,
      socketGroupId: process.getegid!(),
      socketPath: join(root, "render.sock"),
    });
    try {
      await expect(broker.close()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.some(
            (failure) => failure instanceof Error && /backend cleanup timed out/iu.test(failure.message),
          ),
      );
      await expect(acquireFastManimSandboxOwnerLeaseV1(ownerDigest)).rejects.toMatchObject({ code: "busy" });
      releaseBackend();
      await vi.waitFor(
        async () => {
          const replacement = await acquireFastManimSandboxOwnerLeaseV1(ownerDigest);
          await replacement.close();
        },
        { timeout: 5_000 },
      );
    } finally {
      releaseBackend();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("round-trips status, cancellation, and cleanup over the real UDS protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-roundtrip-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    const cancelled: string[] = [];
    const cleaned: string[] = [];
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async (fence) => {
        cancelled.push(fence.jobId);
        return cancellationAcknowledgement(fence);
      },
      cleanup: async (jobId) => {
        cleaned.push(jobId);
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
    const client = new ManimRenderUdsSandboxBackendV1({ brokerShardId, socketPath });
    const fence = {
      jobId: "tenant-a/session-a",
      rejectUntilEpochMs: Date.now() + 60_000,
      sessionId: "session-a",
      tenantId: "tenant-a",
    };
    try {
      await expect(
        client.status({
          deadlineEpochMs: Date.now() + 5_000,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual(healthyStatus());
      await expect(
        client.cancel(fence, {
          deadlineEpochMs: Date.now() + 5_000,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual(cancellationAcknowledgement(fence));
      await expect(
        client.cleanup("tenant-a/session-a", {
          deadlineEpochMs: Date.now() + 5_000,
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
      expect(cancelled).toEqual(["tenant-a/session-a"]);
      expect(cleaned).toEqual(["tenant-a/session-a"]);
    } finally {
      await Promise.allSettled([client.close(), broker.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("routes an API-side cancellation through only the owner relay and its independent broker root", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-owner-relay-"));
    await chmod(root, 0o700);
    const shardA = "render-shard-api-a";
    const shardB = "render-shard-owner-b";
    const stagingA = join(root, "staging-a");
    const stagingB = join(root, "staging-b");
    const socketsA = join(root, "sockets-a");
    const socketsB = join(root, "sockets-b");
    await Promise.all([stagingA, stagingB, socketsA, socketsB].map((directory) => mkdir(directory, { mode: 0o700 })));
    const dockerA = new ScriptedDockerClient();
    const dockerB = new ScriptedDockerClient();
    const runnerA = new ManimRenderGatedOciJobRunnerV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: dockerA,
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: stagingA,
    });
    const runnerB = new ManimRenderGatedOciJobRunnerV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: dockerB,
      image,
      seccompPath: "/missing/seccomp.json",
      stagingRoot: stagingB,
    });
    const backendA = new ManimRenderGatedOciBackendV1(runnerA, shardA);
    const backendB = new ManimRenderGatedOciBackendV1(runnerB, shardB);
    const socketA = join(socketsA, "render.sock");
    const socketB = join(socketsB, "render.sock");
    let brokerA: Awaited<ReturnType<typeof startManimRenderSandboxBrokerServerV1>> | undefined;
    let brokerB: Awaited<ReturnType<typeof startManimRenderSandboxBrokerServerV1>> | undefined;
    let clientA: ManimRenderUdsSandboxBackendV1 | undefined;
    let clientB: ManimRenderUdsSandboxBackendV1 | undefined;
    let relayA: DurableManimRenderCancellationRelayV1 | undefined;
    let relayB: DurableManimRenderCancellationRelayV1 | undefined;
    try {
      brokerA = await startManimRenderSandboxBrokerServerV1({
        backend: backendA,
        ownerDigest: runnerA.stagingRootDigest,
        reconcileOrphans: () => runnerA.reconcileOrphans(),
        socketGroupId: process.getegid!(),
        socketPath: socketA,
      });
      brokerB = await startManimRenderSandboxBrokerServerV1({
        backend: backendB,
        ownerDigest: runnerB.stagingRootDigest,
        reconcileOrphans: () => runnerB.reconcileOrphans(),
        socketGroupId: process.getegid!(),
        socketPath: socketB,
      });
      clientA = new ManimRenderUdsSandboxBackendV1({ brokerShardId: shardA, socketPath: socketA });
      clientB = new ManimRenderUdsSandboxBackendV1({ brokerShardId: shardB, socketPath: socketB });

      const current = descriptor();
      const request = new SealedManimRenderSandboxRequestV2(current);
      const pending: DurableRenderCancellationIntentV1 = {
        acknowledgedAt: null,
        brokerShardId: shardB,
        delivery: null,
        expiresAt: new Date(current.deadlineEpochMs + 30_000),
        fenceDigest: null,
        jobId: current.jobId,
        rejectUntil: new Date(current.deadlineEpochMs),
        requestedAt: new Date(),
        sessionId: current.sessionId,
        tenantId: current.tenantId,
      };
      const delivery: DurableRenderCancellationDeliveryV1 = {
        ...pending,
        delivery: { expiresAt: new Date(Date.now() + 20_000), ownerId: "relay-owner-b", token: 1n },
      };
      let registered = false;
      let delivered = false;
      let acknowledgement: Readonly<{ acknowledgedAt: Date; fenceDigest: string }> | undefined;
      const acknowledgeCancellation = vi.fn<RenderCancellationRepositoryV1["acknowledgeCancellation"]>(
        async (receipt) => {
          acknowledgement = { acknowledgedAt: new Date(), fenceDigest: receipt.fenceDigest };
          return partial<DurableRenderSessionV1>({ status: "cancelled" });
        },
      );
      const claimCancellationDeliveries = vi.fn<RenderCancellationRepositoryV1["claimCancellationDeliveries"]>(
        async (claim) => {
          if (claim.brokerShardId !== shardB || !registered || delivered) return [];
          delivered = true;
          return [delivery];
        },
      );
      const repository = partial<RenderCancellationRepositoryV1>({
        acknowledgeCancellation,
        claimCancellationDeliveries,
        purgeExpiredCancellations: async () => 0,
        readCancellation: async () =>
          acknowledgement
            ? { ...pending, acknowledgedAt: acknowledgement.acknowledgedAt, fenceDigest: acknowledgement.fenceDigest }
            : pending,
        ready: async () => true,
        registerCancellation: async () => {
          registered = true;
          return { intent: pending, session: partial<DurableRenderSessionV1>({ status: "rendering" }) };
        },
      });
      const executor = (client: ManimRenderUdsSandboxBackendV1, expectedShard: string, expectedRoot: string) => ({
        cancel: vi.fn(async (fence) => {
          const receipt = await client.cancel(fence, {
            deadlineEpochMs: Date.now() + 5_000,
            signal: new AbortController().signal,
          });
          expect(receipt.brokerShardId).toBe(expectedShard);
          return { fenceDigest: receipt.fenceDigest };
        }),
        ready: async (signal?: AbortSignal) => {
          const status = await client.status({
            deadlineEpochMs: Date.now() + 5_000,
            signal: signal ?? new AbortController().signal,
          });
          return status.brokerShardId === expectedShard && status.stagingRootDigest === expectedRoot;
        },
      });
      const executorA = executor(clientA, shardA, runnerA.stagingRootDigest);
      const executorB = executor(clientB, shardB, runnerB.stagingRootDigest);
      const abortA = vi.fn();
      const abortB = vi.fn();
      relayA = new DurableManimRenderCancellationRelayV1({
        abortActive: abortA,
        batchSize: 4,
        brokerShardId: shardA,
        deliveryLeaseMs: 20_000,
        executor: executorA,
        intervalMs: 60_000,
        onFailure: () => undefined,
        relayId: "relay-api-a",
        repository,
        sweepTimeoutMs: 15_000,
        tenantId: current.tenantId,
      });
      relayB = new DurableManimRenderCancellationRelayV1({
        abortActive: abortB,
        batchSize: 4,
        brokerShardId: shardB,
        deliveryLeaseMs: 20_000,
        executor: executorB,
        intervalMs: 60_000,
        onFailure: () => undefined,
        relayId: "relay-owner-b",
        repository,
        sweepTimeoutMs: 15_000,
        tenantId: current.tenantId,
      });
      await Promise.all([relayA.start(), relayB.start()]);
      const coordinator = new DurableManimRenderCancellationCoordinatorV1({
        acknowledgementPollMs: 25,
        acknowledgementTimeoutMs: 1_000,
        repository,
        tenantId: current.tenantId,
        wake: () => {
          relayA?.wake();
          relayB?.wake();
        },
      });

      await coordinator.cancel(current.sessionId);

      expect(claimCancellationDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({ brokerShardId: shardA }),
        expect.any(AbortSignal),
      );
      expect(claimCancellationDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({ brokerShardId: shardB }),
        expect.any(AbortSignal),
      );
      expect(abortA).not.toHaveBeenCalled();
      expect(executorA.cancel).not.toHaveBeenCalled();
      expect(abortB).toHaveBeenCalledWith(current.sessionId);
      expect(executorB.cancel).toHaveBeenCalledOnce();
      expect(acknowledgeCancellation).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: "relay-owner-b", sessionId: current.sessionId }),
        expect.any(AbortSignal),
      );
      expect(await readdir(stagingA)).toEqual([]);
      expect(JSON.parse(await readFile(join(stagingB, "render-cancellations-v1.json"), "utf8"))).toMatchObject({
        entries: [
          {
            jobId: current.jobId,
            rejectUntilEpochMs: current.deadlineEpochMs,
            sessionId: current.sessionId,
            tenantId: current.tenantId,
          },
        ],
        stagingRootDigest: runnerB.stagingRootDigest,
      });
      await expect(
        clientB.submitOrReattach(request, {
          deadlineEpochMs: current.deadlineEpochMs,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ code: "cancelled", kind: "failed" });
      expect(dockerA.calls.filter((call) => call[0] === "container" && call[1] === "create")).toEqual([]);
      expect(dockerB.calls.filter((call) => call[0] === "container" && call[1] === "create")).toEqual([]);
    } finally {
      await Promise.allSettled([relayA?.close(), relayB?.close(), clientA?.close(), clientB?.close()]);
      await Promise.allSettled([brokerA?.close() ?? runnerA.close(), brokerB?.close() ?? runnerB.close()]);
      await rm(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("fails closed when status or cancellation is attested by an unexpected broker shard", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-shard-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    const alternateShardId = "render-shard-b";
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async (fence) => cancellationAcknowledgement(fence, alternateShardId),
      close: async () => undefined,
      status: async () => healthyStatus(),
      submitOrReattach: () => never(),
    });
    const broker = await startManimRenderSandboxBrokerServerV1({
      backend,
      socketGroupId: process.getegid!(),
      socketPath,
    });
    const statusClient = new ManimRenderUdsSandboxBackendV1({ brokerShardId: alternateShardId, socketPath });
    const cancellationClient = new ManimRenderUdsSandboxBackendV1({ brokerShardId, socketPath });
    try {
      await expect(
        statusClient.status({
          deadlineEpochMs: Date.now() + 5_000,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/transport/i);
      await expect(
        cancellationClient.cancel(
          {
            jobId: "tenant-a/session-a",
            rejectUntilEpochMs: Date.now() + 60_000,
            sessionId: "session-a",
            tenantId: "tenant-a",
          },
          {
            deadlineEpochMs: Date.now() + 5_000,
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow(/transport/i);
    } finally {
      await Promise.allSettled([statusClient.close(), cancellationClient.close(), broker.close()]);
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      mediaType: "image/png" as const,
      stagingId: manimRenderStagingIdV1("tenant-a/session-a", "video"),
    },
    {
      mediaType: "video/mp4" as const,
      stagingId: manimRenderStagingIdV1("tenant-a/session-a", "thumbnail"),
    },
  ])("rejects forged ready correlation from the broker (%o)", async (forged) => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-broker-forged-"));
    await chmod(root, 0o700);
    const socketPath = join(root, "render.sock");
    const backend = partial<ManimRenderSandboxBackendV1>({
      cancel: async (fence) => cancellationAcknowledgement(fence),
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
    const client = new ManimRenderUdsSandboxBackendV1({ brokerShardId, socketPath });
    try {
      const request = new SealedManimRenderSandboxRequestV2(descriptor());
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
      cancel: async (fence) => cancellationAcknowledgement(fence),
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

      const client = new ManimRenderUdsSandboxBackendV1({ brokerShardId, socketPath });
      try {
        await expect(
          client.status({
            deadlineEpochMs: Date.now() + 5_000,
            signal: new AbortController().signal,
          }),
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
      cancel: async (fence) => cancellationAcknowledgement(fence),
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
      cancel: async (fence) => cancellationAcknowledgement(fence),
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
    const client = new ManimRenderUdsSandboxBackendV1({ brokerShardId, socketPath });
    try {
      await expect(
        client.status({
          deadlineEpochMs: Date.now() + 50,
          signal: new AbortController().signal,
        }),
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
      cancel: async (fence) => cancellationAcknowledgement(fence),
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
      cancel: async (fence) => cancellationAcknowledgement(fence),
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
