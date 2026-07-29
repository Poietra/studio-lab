import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { FastManimGatedOciDockerClientV1 } from "./fast-manim-gated-oci-job-runner";
import { startManimRenderProductionSandboxBrokerServiceV1 } from "./manim-render-production-sandbox-broker-service";
import {
  digestManimRenderSandboxCancellationFenceV1,
  digestManimRenderStagingRootV1,
  MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
  type ManimRenderSandboxStatusV1,
  SealedManimRenderSandboxRequestV2,
} from "./manim-render-sandbox-contract";
import { ManimRenderUdsSandboxBackendV1 } from "./manim-render-uds-sandbox-backend";

const required = process.env.POIETRA_MANIM_RENDER_PRODUCTION_REQUIRED === "1";
const dockerSocketPath = process.env.POIETRA_MANIM_RENDER_PRODUCTION_DOCKER_SOCKET;
const imageDigest = process.env.POIETRA_MANIM_RENDER_PRODUCTION_IMAGE;
const seccompPath = process.env.POIETRA_MANIM_RENDER_PRODUCTION_SECCOMP;
const requested = required || [dockerSocketPath, imageDigest, seccompPath].some((value) => value !== undefined);
const brokerShardId = "render-production-real";
const cancellationStateFile = "render-cancellations-v1.json";

const normalSource = `import os

from manim import Circle, Create, Scene

class ProductionBrokerScene(Scene):
    def construct(self):
        os.write(1, b"discarded-scene-stdout")
        os.write(2, b"discarded-scene-stderr")
        shape = Circle().set_fill("#3b82f6", opacity=1.0)
        self.play(Create(shape), run_time=0.2)
`;

const outputFloodSource = `import os

from manim import Scene

class ProductionBrokerOutputFloodScene(Scene):
    def construct(self):
        chunk = b"untrusted-output" * 4096
        while True:
            os.write(1, chunk)
            os.write(2, chunk)
`;

const forkedCpuSource = `import os

from manim import Scene

def burn_cpu():
    value = 1
    while True:
        value = (value * 1103515245 + 12345) & 0x7fffffff

class ProductionBrokerCpuScene(Scene):
    def construct(self):
        for _ in range(3):
            child = os.fork()
            if child == 0:
                try:
                    os.setsid()
                except OSError:
                    pass
                burn_cpu()
                os._exit(0)
        burn_cpu()
`;

function sealedRequest(
  status: ManimRenderSandboxStatusV1,
  options: Readonly<{
    deadlineEpochMs: number;
    fenceToken?: string;
    jobId: string;
    kind: "thumbnail" | "video";
    sceneName: string;
    sessionId: string;
    source: string;
  }>,
) {
  return new SealedManimRenderSandboxRequestV2({
    deadlineEpochMs: options.deadlineEpochMs,
    fenceToken: options.fenceToken ?? "1",
    jobId: options.jobId,
    output:
      options.kind === "video"
        ? {
            frameRate: 15,
            kind: "video",
            mediaType: "video/mp4",
            pixelHeight: 480,
            pixelWidth: 854,
          }
        : {
            frameRate: 15,
            kind: "thumbnail",
            mediaType: "image/png",
            pixelHeight: 480,
            pixelWidth: 854,
          },
    profileDigest: status.profileDigest,
    projectId: "project-a",
    runtimeDigest: status.runtimeDigest,
    sceneFrame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
    sceneName: options.sceneName,
    schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
    sessionId: options.sessionId,
    source: options.source,
    sourceDigest: createHash("sha256").update(options.source, "utf8").digest("hex"),
    sourcePath: "main.py",
    tenantId: "real-production",
    version: 2,
  });
}

async function ownedContainerIds(docker: FastManimGatedOciDockerClientV1, ownerDigest: string, includeStopped = false) {
  const result = await docker.run([
    "container",
    "ls",
    ...(includeStopped ? ["--all"] : []),
    "--quiet",
    "--no-trunc",
    "--filter",
    "label=io.poietra.render-job=v1",
    "--filter",
    `label=io.poietra.render-owner-sha256=${ownerDigest}`,
  ]);
  if (result.code !== 0) throw new Error("Docker could not list production render containers.");
  return result.stdout.toString("ascii").trim().split("\n").filter(Boolean);
}

async function waitForOwnedContainer(docker: FastManimGatedOciDockerClientV1, ownerDigest: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const containers = await ownedContainerIds(docker, ownerDigest);
    if (containers.length === 1) return containers[0]!;
    if (containers.length > 1) throw new Error("The production broker owns multiple active test containers.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The production render container did not start before the test deadline.");
}

async function waitForContainerProcessCount(
  docker: FastManimGatedOciDockerClientV1,
  containerId: string,
  minimum: number,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await docker.run(["container", "top", containerId, "-eo", "pid,comm"]);
    if (result.code === 0 && result.stdout.toString("utf8").trim().split("\n").length - 1 >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The production render CPU fixture did not start all descendants before cleanup.");
}

function submit(client: ManimRenderUdsSandboxBackendV1, request: SealedManimRenderSandboxRequestV2) {
  return client.submitOrReattach(request, {
    deadlineEpochMs: request.parseDescriptor().deadlineEpochMs,
    signal: new AbortController().signal,
  });
}

describe.skipIf(!requested)("production render sandbox broker real rootless lane", () => {
  beforeAll(() => {
    if (
      !dockerSocketPath ||
      !/^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? "") ||
      !seccompPath ||
      process.geteuid?.() === undefined ||
      process.geteuid() === 0
    ) {
      throw new TypeError(
        "The required production render lane needs a non-root principal and explicit Docker socket, image, and seccomp inputs.",
      );
    }
  });

  it("renders verified media and bounds output cancellation plus forked CPU pressure through UDS", async () => {
    const root = await mkdtemp(join(tmpdir(), "poietra-render-production-"));
    const socketDirectory = join(root, "sockets");
    const stagingRoot = join(root, "staging");
    await Promise.all([mkdir(socketDirectory), mkdir(stagingRoot)]);
    await Promise.all([chmod(socketDirectory, 0o750), chmod(stagingRoot, 0o750)]);
    const socketPath = join(socketDirectory, "render.sock");
    const ownerDigest = digestManimRenderStagingRootV1(stagingRoot);
    const docker = new FastManimGatedOciDockerClientV1({ socketPath: dockerSocketPath! });
    let broker: Awaited<ReturnType<typeof startManimRenderProductionSandboxBrokerServiceV1>> | undefined;
    let client: ManimRenderUdsSandboxBackendV1 | undefined;
    let operationError: unknown;
    try {
      broker = await startManimRenderProductionSandboxBrokerServiceV1({
        brokerShardId,
        brokerUserId: process.geteuid!(),
        dockerSocketPath: dockerSocketPath!,
        imageDigest: imageDigest!,
        seccompPath: seccompPath!,
        socketGroupId: process.getegid!(),
        socketPath,
        stagingRoot,
      });
      client = new ManimRenderUdsSandboxBackendV1({ brokerShardId, socketPath });
      const status = await client.status({
        deadlineEpochMs: Date.now() + 30_000,
        signal: new AbortController().signal,
      });
      expect(status).toMatchObject({
        backendId: "manim-render-gated-oci-v1",
        brokerShardId,
        health: "ready",
        stagingRootDigest: ownerDigest,
      });

      const normalDeadline = Date.now() + 120_000;
      const normalBase = {
        deadlineEpochMs: normalDeadline,
        jobId: "real-production/normal-session",
        sceneName: "ProductionBrokerScene",
        sessionId: "normal-session",
        source: normalSource,
      } as const;
      const videoRequest = sealedRequest(status, { ...normalBase, kind: "video" });
      const thumbnailRequest = sealedRequest(status, { ...normalBase, kind: "thumbnail" });
      const video = await submit(client, videoRequest);
      const thumbnail = await submit(client, thumbnailRequest);
      expect(video).toMatchObject({
        kind: "ready",
        logTail: "",
        mediaType: "video/mp4",
        requestDigest: videoRequest.requestDigest,
      });
      expect(thumbnail).toMatchObject({
        kind: "ready",
        logTail: "",
        mediaType: "image/png",
        requestDigest: thumbnailRequest.requestDigest,
      });
      if (video.kind !== "ready" || thumbnail.kind !== "ready") throw new Error("Production media was not ready.");
      const mp4 = await readFile(join(stagingRoot, `${video.stagingId}.mp4`));
      const png = await readFile(join(stagingRoot, `${thumbnail.stagingId}.png`));
      expect(mp4.byteLength).toBe(video.artifactSize);
      expect(png.byteLength).toBe(thumbnail.artifactSize);
      expect(createHash("sha256").update(mp4).digest("hex")).toBe(video.artifactDigest);
      expect(createHash("sha256").update(png).digest("hex")).toBe(thumbnail.artifactDigest);
      expect(mp4.subarray(4, 8).toString("ascii")).toBe("ftyp");
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      await client.cleanup(normalBase.jobId, {
        deadlineEpochMs: Date.now() + 30_000,
        signal: new AbortController().signal,
      });
      expect(await readdir(stagingRoot)).toEqual([]);

      const cancelRequest = sealedRequest(status, {
        deadlineEpochMs: Date.now() + 90_000,
        jobId: "real-production/cancel-session",
        kind: "video",
        sceneName: "ProductionBrokerOutputFloodScene",
        sessionId: "cancel-session",
        source: outputFloodSource,
      });
      const cancelledDescriptor = cancelRequest.parseDescriptor();
      const pendingCancellation = submit(client, cancelRequest);
      await waitForOwnedContainer(docker, ownerDigest);
      const fence = {
        jobId: cancelledDescriptor.jobId,
        rejectUntilEpochMs: cancelledDescriptor.deadlineEpochMs,
        sessionId: cancelledDescriptor.sessionId,
        tenantId: cancelledDescriptor.tenantId,
      };
      await expect(
        client.cancel(fence, {
          deadlineEpochMs: Date.now() + 30_000,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({
        brokerShardId,
        fenceDigest: digestManimRenderSandboxCancellationFenceV1(fence),
      });
      await expect(pendingCancellation).resolves.toMatchObject({ code: "cancelled", kind: "failed", logTail: "" });
      expect(await ownedContainerIds(docker, ownerDigest, true)).toEqual([]);
      expect(await readdir(stagingRoot)).toEqual([cancellationStateFile]);

      const cpuRequest = sealedRequest(status, {
        deadlineEpochMs: Date.now() + 90_000,
        jobId: "real-production/cpu-session",
        kind: "video",
        sceneName: "ProductionBrokerCpuScene",
        sessionId: "cpu-session",
        source: forkedCpuSource,
      });
      const pendingCpu = submit(client, cpuRequest);
      const cpuContainer = await waitForOwnedContainer(docker, ownerDigest);
      await waitForContainerProcessCount(docker, cpuContainer, 4);
      await expect(pendingCpu).resolves.toMatchObject({ code: "cpu-limit", kind: "failed", logTail: "" });
      expect(await ownedContainerIds(docker, ownerDigest, true)).toEqual([]);
      expect(await readdir(stagingRoot)).toEqual([cancellationStateFile]);
    } catch (error) {
      operationError = error;
    }

    const clientCleanup = await Promise.allSettled([client?.close() ?? Promise.resolve()]);
    const brokerCleanup = await Promise.allSettled([broker?.close() ?? Promise.resolve()]);
    let residueError: unknown;
    try {
      expect(await ownedContainerIds(docker, ownerDigest, true)).toEqual([]);
      expect((await readdir(stagingRoot)).filter((entry) => entry !== cancellationStateFile)).toEqual([]);
    } catch (error) {
      residueError = error;
    }
    await rm(root, { force: true, recursive: true });
    const errors = [
      ...(operationError === undefined ? [] : [operationError]),
      ...(residueError === undefined ? [] : [residueError]),
      ...[...clientCleanup, ...brokerCleanup].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    ];
    if (errors.length > 0) {
      throw new AggregateError(errors, "The production render UDS lane failed or left job residue.");
    }
  }, 180_000);
});
