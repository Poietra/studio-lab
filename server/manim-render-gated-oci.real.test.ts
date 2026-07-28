import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import {
  type FastManimGatedOciCgroupKillPolicyV1,
  FastManimGatedOciDockerClientV1,
  inspectFastManimGatedOciRunningCgroupV1,
  parseFastManimGatedOciSingleInspectionV1,
  readFastManimGatedOciProcessStartTimeV1,
} from "./fast-manim-gated-oci-job-runner";
import { parseFastManimRootlessDockerInfoV1 } from "./fast-manim-production-gated-oci-backend";
import { ManimRenderGatedOciJobRunnerV1 } from "./manim-render-gated-oci-job-runner";
import {
  MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1,
  SealedManimRenderSandboxRequestV1,
} from "./manim-render-sandbox-contract";

const image = process.env.POIETRA_MANIM_RENDER_GATED_OCI_IMAGE;
const enabled = /^sha256:[a-f0-9]{64}$/u.test(image ?? "");
const productionDockerSocket = process.env.POIETRA_FAST_MANIM_PRODUCTION_DOCKER_SOCKET?.trim();
const productionDockerVersion = process.env.POIETRA_FAST_MANIM_PRODUCTION_DOCKER_VERSION?.trim();
const productionEvidence = productionDockerSocket !== undefined || productionDockerVersion !== undefined;
const cgroupKillPolicy: FastManimGatedOciCgroupKillPolicyV1 = productionEvidence ? "required" : "best-effort";
const seccompPath = fileURLToPath(new URL("../sandbox/fast-manim-gated-oci/seccomp.v1.json", import.meta.url));
const source = `from pathlib import Path
import os

from manim import Circle, Create, FadeOut, RIGHT, Scene, Square, Transform

class MultiAnimationScene(Scene):
    def construct(self):
        try:
            descriptor = os.open("/proc/1/mem", os.O_RDWR)
        except PermissionError:
            pass
        else:
            os.close(descriptor)
            raise RuntimeError("untrusted Scene opened trusted PID 1 memory")
        output = Path("/run/poietra/output")
        (output / "terminal.json").write_text('{"kind":"ready","mediaType":"video/mp4","requestDigest":"' + ('0' * 64) + '"}', encoding="utf-8")
        (output / "artifact.mp4").symlink_to("/dev/zero")
        shape = Circle().set_fill("#3b82f6", opacity=1.0)
        target = Square().set_fill("#ef4444", opacity=1.0)
        self.play(Create(shape), run_time=0.2)
        self.play(shape.animate.shift(RIGHT), run_time=0.2)
        self.play(Transform(shape, target), run_time=0.2)
        self.play(FadeOut(shape), run_time=0.2)
`;
const forgedMediaSource = `from pathlib import Path

from manim import Scene

class ForgedMediaScene(Scene):
    def render(self, *args, **kwargs):
        target = Path("/run/poietra/tmp/media/forged/poietra-render.mp4")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(bytes.fromhex("000000186674797000000000"))
`;
const slowSource = `from manim import Scene
import time

class SlowScene(Scene):
    def construct(self):
        time.sleep(30)
`;
const memoryPressureSource = `import time

from manim import Scene

class MemoryPressureScene(Scene):
    def construct(self):
        blocks = []
        while True:
            blocks.append(bytearray(32 * 1024 * 1024))
            time.sleep(0.02)
`;
const forkPressureSource = `import os
import time

from manim import Scene

class ForkPressureScene(Scene):
    def construct(self):
        children = 0
        while True:
            try:
                child = os.fork()
            except OSError:
                break
            if child == 0:
                time.sleep(30)
                os._exit(0)
            children += 1
        if children < 16:
            raise RuntimeError("fork pressure did not reach the bounded process envelope")
        time.sleep(30)
`;
const detachedPipeHolderSource = `import os
import time

from manim import Scene

class DetachedPipeHolderScene(Scene):
    def construct(self):
        read_descriptor, write_descriptor = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(read_descriptor)
            try:
                os.setsid()
            except OSError:
                pass
            time.sleep(30)
            os.close(write_descriptor)
            os._exit(0)
        os.close(write_descriptor)
        while os.read(read_descriptor, 1):
            pass
`;

function dockerClient() {
  return new FastManimGatedOciDockerClientV1(
    productionDockerSocket === undefined ? {} : { socketPath: productionDockerSocket },
  );
}

function createRunner(stagingRoot: string, docker = dockerClient()) {
  return new ManimRenderGatedOciJobRunnerV1({
    cgroupKillPolicy,
    dockerClient: docker,
    image: image!,
    seccompPath,
    stagingRoot,
  });
}

async function ownedContainerIds(
  docker: FastManimGatedOciDockerClientV1,
  runner: ManimRenderGatedOciJobRunnerV1,
  includeStopped = false,
) {
  const result = await docker.run([
    "container",
    "ls",
    ...(includeStopped ? ["--all"] : []),
    "--quiet",
    "--no-trunc",
    "--filter",
    "label=io.poietra.render-job=v1",
    "--filter",
    `label=io.poietra.render-owner-sha256=${runner.stagingRootDigest}`,
  ]);
  if (result.code !== 0) throw new Error("Docker could not list owned render containers.");
  return result.stdout.toString("ascii").trim().split("\n").filter(Boolean);
}

async function waitForOwnedContainer(docker: FastManimGatedOciDockerClientV1, runner: ManimRenderGatedOciJobRunnerV1) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const containers = await ownedContainerIds(docker, runner);
    if (containers.length === 1) return containers[0]!;
    if (containers.length > 1) throw new Error("The render runner owns multiple active test containers.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The owned render container did not start before the test deadline.");
}

async function waitForContainerProcessCount(
  docker: FastManimGatedOciDockerClientV1,
  containerId: string,
  minimum: number,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await docker.run(["container", "top", containerId, "-eo", "pid,comm"]);
    if (result.code === 0) {
      const rows = result.stdout.toString("utf8").trim().split("\n");
      if (rows.length - 1 >= minimum) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The hostile render did not populate its cgroup before cleanup.");
}

async function waitForRunningCgroupPath(docker: FastManimGatedOciDockerClientV1, containerId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await docker.run(["container", "inspect", containerId]);
    if (result.code === 0) {
      const inspection = parseFastManimGatedOciSingleInspectionV1(result.stdout);
      const pid = inspection.State?.Pid;
      if (Number.isSafeInteger(pid) && (pid as number) > 1) {
        const startTime = await readFastManimGatedOciProcessStartTimeV1(pid as number);
        return (await inspectFastManimGatedOciRunningCgroupV1(containerId, pid as number, startTime)).cgroupPath;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The hostile render cgroup identity was not observable.");
}

async function waitForCgroupEvent(cgroupPath: string, event: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const counters = Object.fromEntries(
        (await readFile(join(cgroupPath, "memory.events"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => line.split(" ", 2)),
      );
      if (Number(counters[event] ?? 0) > 0) return;
    } catch {
      // Cleanup may race the final observation; the bounded deadline below
      // turns a missed kernel event into a failed evidence run.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`The hostile render did not produce the expected cgroup ${event} event.`);
}

describe.skipIf(!enabled && !productionEvidence)("render gated OCI real media lane", () => {
  beforeAll(async () => {
    if (!productionEvidence) return;
    if (!enabled) throw new TypeError("The rootless render evidence lane requires an immutable render image.");
    if (!productionDockerSocket || !productionDockerVersion) {
      throw new TypeError("The rootless render evidence lane requires both production Docker settings.");
    }
    if (process.geteuid?.() === undefined || process.geteuid() === 0) {
      throw new TypeError("The rootless render evidence lane must run as its non-root broker principal.");
    }
    const info = await dockerClient().run(["info", "--format", "{{json .}}"]);
    if (info.code !== 0) throw new TypeError("The rootless render evidence Docker runtime is unavailable.");
    parseFastManimRootlessDockerInfoV1(info.stdout, productionDockerVersion);
  });

  it("renders a multi-animation MP4 and PNG without a host project mount", async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), "poietra-real-render-staging-"));
    await chmod(stagingRoot, 0o700);
    const runner = createRunner(stagingRoot);
    const deadlineEpochMs = Date.now() + 120_000;
    const base = {
      deadlineEpochMs,
      fenceToken: "1",
      jobId: "real-render/session-a",
      profileDigest: runner.profileDigest,
      projectId: "project-a",
      runtimeDigest: runner.runtimeDigest,
      sceneFrame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
      sceneName: "MultiAnimationScene",
      schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1,
      sessionId: "session-a",
      source,
      sourceDigest: createHash("sha256").update(source, "utf8").digest("hex"),
      sourcePath: "main.py",
      tenantId: "real-render",
      version: 1 as const,
    };
    const signal = new AbortController().signal;
    let operationError: unknown;
    try {
      await expect(runner.ready(signal)).resolves.toBe(true);
      await runner.reconcileOrphans();
      const video = await runner.submitOrReattach(
        new SealedManimRenderSandboxRequestV1({
          ...base,
          output: {
            frameRate: 15,
            kind: "video",
            mediaType: "video/mp4",
            pixelHeight: 480,
            pixelWidth: 854,
          },
        }),
        deadlineEpochMs,
        signal,
      );
      const refencedVideo = await runner.submitOrReattach(
        new SealedManimRenderSandboxRequestV1({
          ...base,
          fenceToken: "2",
          output: {
            frameRate: 15,
            kind: "video",
            mediaType: "video/mp4",
            pixelHeight: 480,
            pixelWidth: 854,
          },
        }),
        deadlineEpochMs,
        signal,
      );
      const thumbnail = await runner.submitOrReattach(
        new SealedManimRenderSandboxRequestV1({
          ...base,
          output: {
            frameRate: 15,
            kind: "thumbnail",
            mediaType: "image/png",
            pixelHeight: 480,
            pixelWidth: 854,
          },
        }),
        deadlineEpochMs,
        signal,
      );
      const forgedMedia = await runner.submitOrReattach(
        new SealedManimRenderSandboxRequestV1({
          ...base,
          jobId: "real-render/session-forged",
          output: {
            frameRate: 15,
            kind: "video",
            mediaType: "video/mp4",
            pixelHeight: 480,
            pixelWidth: 854,
          },
          sceneName: "ForgedMediaScene",
          sessionId: "session-forged",
          source: forgedMediaSource,
          sourceDigest: createHash("sha256").update(forgedMediaSource, "utf8").digest("hex"),
        }),
        deadlineEpochMs,
        signal,
      );
      expect(video).toMatchObject({ kind: "ready", mediaType: "video/mp4" });
      expect(refencedVideo).toEqual(video);
      expect(thumbnail).toMatchObject({ kind: "ready", mediaType: "image/png" });
      expect(forgedMedia).toEqual({ code: "render-failed", diagnostic: "media-invalid", kind: "failed" });
      if (video.kind !== "ready" || thumbnail.kind !== "ready") throw new Error("The real render did not finish.");
      expect(video.stagingId).not.toBe(thumbnail.stagingId);
      const mp4 = await readFile(join(stagingRoot, `${video.stagingId}.mp4`));
      const png = await readFile(join(stagingRoot, `${thumbnail.stagingId}.png`));
      expect(mp4.subarray(4, 8).toString("ascii")).toBe("ftyp");
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      await runner.cancel(base.jobId, Date.now() + 30_000, signal);
      expect(await readdir(stagingRoot)).toEqual([]);
    } catch (error) {
      operationError = error;
    }
    const cleanup = await Promise.allSettled([runner.close()]);
    await rm(stagingRoot, { force: true, recursive: true });
    const errors = [
      ...(operationError === undefined ? [] : [operationError]),
      ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    if (errors.length > 0) throw new AggregateError(errors, "The real render OCI lane failed or did not clean up.");
  }, 180_000);

  it("cancels an active render and proves container and staging cleanup", async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), "poietra-real-render-cancel-"));
    await chmod(stagingRoot, 0o700);
    const docker = dockerClient();
    const runner = createRunner(stagingRoot, docker);
    const deadlineEpochMs = Date.now() + 60_000;
    const request = new SealedManimRenderSandboxRequestV1({
      deadlineEpochMs,
      fenceToken: "1",
      jobId: "real-render/cancel-session",
      output: {
        frameRate: 15,
        kind: "video",
        mediaType: "video/mp4",
        pixelHeight: 480,
        pixelWidth: 854,
      },
      profileDigest: runner.profileDigest,
      projectId: "project-a",
      runtimeDigest: runner.runtimeDigest,
      sceneFrame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
      sceneName: "SlowScene",
      schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1,
      sessionId: "cancel-session",
      source: slowSource,
      sourceDigest: createHash("sha256").update(slowSource, "utf8").digest("hex"),
      sourcePath: "main.py",
      tenantId: "real-render",
      version: 1,
    });
    const signal = new AbortController().signal;
    let operationError: unknown;
    try {
      await runner.reconcileOrphans();
      const result = runner.submitOrReattach(request, deadlineEpochMs, signal);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await runner.cancel(request.parseDescriptor().jobId, Date.now() + 30_000, signal);
      await expect(result).resolves.toEqual({ code: "cancelled", kind: "failed" });
      expect(await readdir(stagingRoot)).toEqual([]);
      expect(await ownedContainerIds(docker, runner, true)).toEqual([]);
    } catch (error) {
      operationError = error;
    }
    const cleanup = await Promise.allSettled([runner.close()]);
    await rm(stagingRoot, { force: true, recursive: true });
    const errors = [
      ...(operationError === undefined ? [] : [operationError]),
      ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    if (errors.length > 0) throw new AggregateError(errors, "The real render cancellation lane did not clean up.");
  }, 60_000);

  it("removes only its own future-deadline orphan when another broker shares the Docker daemon", async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), "poietra-real-render-restart-"));
    const unrelatedStagingRoot = await mkdtemp(join(tmpdir(), "poietra-real-render-unrelated-"));
    await chmod(stagingRoot, 0o700);
    await chmod(unrelatedStagingRoot, 0o700);
    const docker = dockerClient();
    const original = createRunner(stagingRoot, docker);
    const restarted = createRunner(stagingRoot, docker);
    const unrelated = createRunner(unrelatedStagingRoot, docker);
    const deadlineEpochMs = Date.now() + 60_000;
    const request = new SealedManimRenderSandboxRequestV1({
      deadlineEpochMs,
      fenceToken: "1",
      jobId: "real-render/restart-session",
      output: {
        frameRate: 15,
        kind: "video",
        mediaType: "video/mp4",
        pixelHeight: 480,
        pixelWidth: 854,
      },
      profileDigest: original.profileDigest,
      projectId: "project-a",
      runtimeDigest: original.runtimeDigest,
      sceneFrame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
      sceneName: "SlowScene",
      schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1,
      sessionId: "restart-session",
      source: slowSource,
      sourceDigest: createHash("sha256").update(slowSource, "utf8").digest("hex"),
      sourcePath: "main.py",
      tenantId: "real-render",
      version: 1,
    });
    const signal = new AbortController().signal;
    let operationError: unknown;
    try {
      await Promise.all([original.reconcileOrphans(), unrelated.reconcileOrphans()]);
      const result = original.submitOrReattach(request, deadlineEpochMs, signal);
      const unrelatedResult = unrelated.submitOrReattach(request, deadlineEpochMs, signal);
      const [runningContainer, unrelatedContainer] = await Promise.all([
        waitForOwnedContainer(docker, original),
        waitForOwnedContainer(docker, unrelated),
      ]);
      expect(runningContainer).toMatch(/^[a-f0-9]{64}$/u);
      expect(unrelatedContainer).toMatch(/^[a-f0-9]{64}$/u);
      expect(unrelatedContainer).not.toBe(runningContainer);
      await restarted.reconcileOrphans();
      await expect(result).resolves.toMatchObject({ kind: "failed" });
      expect(await ownedContainerIds(docker, restarted, true)).toEqual([]);
      expect(await ownedContainerIds(docker, unrelated)).toEqual([unrelatedContainer]);
      await unrelated.cancel(request.parseDescriptor().jobId, Date.now() + 30_000, signal);
      await expect(unrelatedResult).resolves.toEqual({ code: "cancelled", kind: "failed" });
      expect(await ownedContainerIds(docker, unrelated, true)).toEqual([]);
      expect(await readdir(stagingRoot)).toEqual([]);
      expect(await readdir(unrelatedStagingRoot)).toEqual([]);
    } catch (error) {
      operationError = error;
    }
    const [, restartedCleanup, unrelatedCleanup] = await Promise.allSettled([
      original.close(),
      restarted.close(),
      unrelated.close(),
    ]);
    await Promise.all([
      rm(stagingRoot, { force: true, recursive: true }),
      rm(unrelatedStagingRoot, { force: true, recursive: true }),
    ]);
    const errors = [
      ...(operationError === undefined ? [] : [operationError]),
      ...(restartedCleanup.status === "rejected" ? [restartedCleanup.reason] : []),
      ...(unrelatedCleanup.status === "rejected" ? [unrelatedCleanup.reason] : []),
    ];
    if (errors.length > 0) throw new AggregateError(errors, "The render restart lane did not remove its orphan.");
  }, 90_000);

  it("bounds hostile resource and descendant workloads without publishing partial media", async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), "poietra-real-render-adversarial-"));
    await chmod(stagingRoot, 0o700);
    const docker = dockerClient();
    const runner = createRunner(stagingRoot, docker);
    const signal = new AbortController().signal;
    const cases = [
      {
        expected: { code: "deadline-exceeded", kind: "failed" },
        maximumElapsedMs: 20_000,
        name: "deadline",
        observeLiveDescendants: true,
        sceneName: "SlowScene",
        source: slowSource,
        timeoutMs: 8_000,
      },
      {
        cgroupEvent: "oom_kill",
        expected: { code: "render-failed", diagnostic: "manim-exit", kind: "failed" },
        maximumElapsedMs: 30_000,
        name: "memory",
        sceneName: "MemoryPressureScene",
        source: memoryPressureSource,
        timeoutMs: 25_000,
      },
      {
        expected: { code: "deadline-exceeded", kind: "failed" },
        maximumElapsedMs: 20_000,
        minimumProcesses: 16,
        name: "fork-pressure",
        sceneName: "ForkPressureScene",
        source: forkPressureSource,
        timeoutMs: 8_000,
      },
      {
        expected: { code: "deadline-exceeded", kind: "failed" },
        maximumElapsedMs: 20_000,
        minimumProcesses: 3,
        name: "setsid-pipe-holder",
        sceneName: "DetachedPipeHolderScene",
        source: detachedPipeHolderSource,
        timeoutMs: 8_000,
      },
    ] as const;
    let operationError: unknown;
    try {
      await expect(runner.ready(signal)).resolves.toBe(true);
      await runner.reconcileOrphans();
      for (const attack of cases) {
        const deadlineEpochMs = Date.now() + attack.timeoutMs;
        const request = new SealedManimRenderSandboxRequestV1({
          deadlineEpochMs,
          fenceToken: "1",
          jobId: `real-render/adversarial-${attack.name}`,
          output: {
            frameRate: 15,
            kind: "video",
            mediaType: "video/mp4",
            pixelHeight: 480,
            pixelWidth: 854,
          },
          profileDigest: runner.profileDigest,
          projectId: "project-a",
          runtimeDigest: runner.runtimeDigest,
          sceneFrame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
          sceneName: attack.sceneName,
          schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1,
          sessionId: `adversarial-${attack.name}`,
          source: attack.source,
          sourceDigest: createHash("sha256").update(attack.source, "utf8").digest("hex"),
          sourcePath: "main.py",
          tenantId: "real-render",
          version: 1,
        });
        const startedAt = performance.now();
        const pending = runner.submitOrReattach(request, deadlineEpochMs, signal);
        if ("observeLiveDescendants" in attack || "minimumProcesses" in attack || "cgroupEvent" in attack) {
          const containerId = await waitForOwnedContainer(docker, runner);
          if ("observeLiveDescendants" in attack) await waitForContainerProcessCount(docker, containerId, 2);
          if ("minimumProcesses" in attack) {
            await waitForContainerProcessCount(docker, containerId, attack.minimumProcesses);
          }
          if ("cgroupEvent" in attack) {
            await waitForCgroupEvent(await waitForRunningCgroupPath(docker, containerId), attack.cgroupEvent);
          }
        }
        const result = await pending;
        expect(result, attack.name).toEqual(attack.expected);
        expect(performance.now() - startedAt, attack.name).toBeLessThan(attack.maximumElapsedMs);
        expect(await readdir(stagingRoot), attack.name).toEqual([]);
        expect(await ownedContainerIds(docker, runner, true), attack.name).toEqual([]);
      }
    } catch (error) {
      operationError = error;
    }
    const cleanup = await Promise.allSettled([runner.close()]);
    await rm(stagingRoot, { force: true, recursive: true });
    const errors = [
      ...(operationError === undefined ? [] : [operationError]),
      ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    if (errors.length > 0) {
      throw new AggregateError(errors, "The adversarial render OCI lane failed or did not clean up.");
    }
  }, 120_000);
});
