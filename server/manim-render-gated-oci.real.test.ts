import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import {
  type FastManimGatedOciCgroupKillPolicyV1,
  FastManimGatedOciDockerClientV1,
} from "./fast-manim-gated-oci-job-runner";
import { parseFastManimRootlessDockerInfoV1 } from "./fast-manim-production-gated-oci-backend";
import { MANIM_RENDER_GATED_OCI_PROFILE_V1, ManimRenderGatedOciJobRunnerV1 } from "./manim-render-gated-oci-job-runner";
import {
  MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
  MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
  SealedManimRenderSandboxRequestV2,
} from "./manim-render-sandbox-contract";
import { inspectProjectPngBytesV1 } from "./storage/project-png-storage";

const image = process.env.POIETRA_MANIM_RENDER_GATED_OCI_IMAGE;
const enabled = /^sha256:[a-f0-9]{64}$/u.test(image ?? "");
const required = process.env.POIETRA_MANIM_RENDER_GATED_OCI_REQUIRED === "1";
const productionDockerSocket = process.env.POIETRA_FAST_MANIM_PRODUCTION_DOCKER_SOCKET?.trim();
const productionDockerVersion = process.env.POIETRA_FAST_MANIM_PRODUCTION_DOCKER_VERSION?.trim();
const productionEvidence = productionDockerSocket !== undefined || productionDockerVersion !== undefined;
const cgroupKillPolicy: FastManimGatedOciCgroupKillPolicyV1 = productionEvidence ? "required" : "best-effort";
const seccompPath = fileURLToPath(new URL("../sandbox/fast-manim-gated-oci/seccomp.v1.json", import.meta.url));
const HOST_SECRET_ENVIRONMENT_KEY = "POIETRA_TEST_RENDER_HOST_SECRET";

function hardUlimit(name: "fsize" | "nofile") {
  const limit = MANIM_RENDER_GATED_OCI_PROFILE_V1.ulimits.find((candidate) => candidate.name === name)?.hard;
  if (limit === undefined) throw new TypeError(`The render profile is missing its ${name} hard limit.`);
  return limit;
}

const FILE_SIZE_LIMIT = hardUlimit("fsize");
const OPEN_FILE_LIMIT = hardUlimit("nofile");
const TMPFS_BYTE_LIMIT = Number(
  MANIM_RENDER_GATED_OCI_PROFILE_V1.tmpfs.options.find((option) => option.startsWith("size="))?.slice(5),
);
const TMPFS_INODE_LIMIT = MANIM_RENDER_GATED_OCI_PROFILE_V1.tmpfs.inodeLimit;
if (!Number.isSafeInteger(TMPFS_BYTE_LIMIT) || TMPFS_BYTE_LIMIT < 1) {
  throw new TypeError("The render profile is missing its bounded tmpfs byte size.");
}

function boundaryCheckedSource(hostSecretPath: string) {
  return `from pathlib import Path
import errno
import os
import socket
import time

from manim import Circle, Create, FadeOut, ImageMobject, LEFT, RIGHT, Scene, Square, Transform

HOST_SECRET_ENVIRONMENT_KEY = ${JSON.stringify(HOST_SECRET_ENVIRONMENT_KEY)}
HOST_SECRET_PATH = ${JSON.stringify(hostSecretPath)}

def assert_host_file_is_unreachable(path):
    try:
        Path(path).read_bytes()
    except OSError:
        return
    raise RuntimeError("untrusted Scene read a host-only file")

def assert_socket_family_is_blocked(family):
    # Denying socket creation covers loopback, cloud metadata, outbound TCP,
    # and Unix-domain endpoints before a connection can be attempted.
    try:
        descriptor = socket.socket(family, socket.SOCK_STREAM)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EPERM):
            return
        raise RuntimeError("sandbox socket denial was inconclusive") from error
    descriptor.close()
    raise RuntimeError("untrusted Scene opened a network or Unix socket")

def start_detached_pipe_holder():
    read_descriptor, write_descriptor = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(read_descriptor)
        os.closerange(3, write_descriptor)
        os.closerange(write_descriptor + 1, ${OPEN_FILE_LIMIT})
        os.setsid()
        os.write(write_descriptor, b"R")
        time.sleep(30)
        os.close(write_descriptor)
        os._exit(0)
    os.close(write_descriptor)
    try:
        if os.read(read_descriptor, 1) != b"R":
            raise RuntimeError("detached child did not enter its new session")
    finally:
        os.close(read_descriptor)

class MultiAnimationScene(Scene):
    def construct(self):
        os.write(1, b"discarded-stdout" * 8192)
        os.write(2, b"discarded-stderr" * 8192)
        if HOST_SECRET_ENVIRONMENT_KEY in os.environ:
            raise RuntimeError("untrusted Scene inherited a host secret")
        assert_host_file_is_unreachable(HOST_SECRET_PATH)
        assert_host_file_is_unreachable("/proc/1/root" + HOST_SECRET_PATH)
        if Path("/var/run/docker.sock").exists() or Path("/run/docker.sock").exists():
            raise RuntimeError("untrusted Scene reached a Docker socket")
        assert_socket_family_is_blocked(socket.AF_INET)
        assert_socket_family_is_blocked(socket.AF_INET6)
        assert_socket_family_is_blocked(socket.AF_UNIX)
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
        self.add(ImageMobject("image.png").scale(0.5).shift(2 * LEFT))
        shape = Circle().set_fill("#3b82f6", opacity=1.0)
        target = Square().set_fill("#ef4444", opacity=1.0)
        self.play(Create(shape), run_time=0.2)
        self.play(shape.animate.shift(RIGHT), run_time=0.2)
        self.play(Transform(shape, target), run_time=0.2)
        self.play(FadeOut(shape), run_time=0.2)

    def render(self, *args, **kwargs):
        super().render(*args, **kwargs)
        start_detached_pipe_holder()
`;
}
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
const outputFloodSource = `import os

from manim import Scene

class OutputFloodScene(Scene):
    def construct(self):
        chunk = b"x" * (64 * 1024)
        while True:
            os.write(1, chunk)
            os.write(2, chunk)
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
const descriptorPressureSource = `import errno
import os
import time

from manim import Scene

class DescriptorPressureScene(Scene):
    def construct(self):
        descriptors = []
        try:
            for _ in range(${OPEN_FILE_LIMIT + 64}):
                descriptors.append(os.open("/dev/null", os.O_RDONLY))
        except OSError as error:
            if error.errno == errno.EMFILE:
                raise RuntimeError("descriptor limit enforced") from error
            raise
        time.sleep(30)
`;
const fileSizePressureSource = `import errno
import os
import signal
import time

from manim import Scene

class FileSizePressureScene(Scene):
    def construct(self):
        signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
        descriptor = os.open("/run/poietra/tmp/file-size-pressure", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        limited = False
        try:
            os.lseek(descriptor, ${FILE_SIZE_LIMIT}, os.SEEK_SET)
            try:
                os.write(descriptor, b"x")
            except OSError as error:
                if error.errno != errno.EFBIG:
                    raise
                limited = True
        finally:
            os.close(descriptor)
        if limited:
            raise RuntimeError("file-size limit enforced")
        time.sleep(30)
`;
const tmpfsBytePressureSource = `import errno
import os
import time

from manim import Scene

class TmpfsBytePressureScene(Scene):
    def construct(self):
        chunk = b"x" * (1024 * 1024)
        file_size = min(${FILE_SIZE_LIMIT} // 2, 64 * 1024 * 1024)
        total_limit = ${TMPFS_BYTE_LIMIT} + 64 * 1024 * 1024
        written = 0
        file_index = 0
        try:
            while written < total_limit:
                descriptor = os.open(
                    f"/run/poietra/tmp/byte-pressure-{file_index}",
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                try:
                    in_file = 0
                    while in_file < file_size and written < total_limit:
                        count = os.write(descriptor, chunk)
                        if count < 1:
                            raise RuntimeError("tmpfs write made no progress")
                        in_file += count
                        written += count
                finally:
                    os.close(descriptor)
                file_index += 1
        except OSError as error:
            if error.errno == errno.ENOSPC:
                raise RuntimeError("tmpfs byte limit enforced") from error
            raise
        time.sleep(30)
`;
const tmpfsInodePressureSource = `import errno
import os
import time

from manim import Scene

class TmpfsInodePressureScene(Scene):
    def construct(self):
        try:
            for index in range(${TMPFS_INODE_LIMIT + 1_024}):
                descriptor = os.open(
                    f"/run/poietra/tmp/inode-pressure-{index}",
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                os.close(descriptor)
        except OSError as error:
            if error.errno == errno.ENOSPC:
                raise RuntimeError("tmpfs inode limit enforced") from error
            raise
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

describe.skipIf(!enabled && !productionEvidence && !required)("render gated OCI real media lane", () => {
  beforeAll(async () => {
    if (!enabled) throw new TypeError("The required render evidence lane needs an immutable render image.");
    if (!productionEvidence) return;
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

  it("denies host access and reaps a detached pipe holder while rendering pinned multi-animation media", async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), "poietra-real-render-staging-"));
    const hostSecretRoot = await mkdtemp(join(tmpdir(), "poietra-real-render-host-secret-"));
    const hostSecretPath = join(hostSecretRoot, "secret.txt");
    const hostSecret = `poietra-host-secret-${randomBytes(16).toString("hex")}`;
    const previousHostSecret = process.env[HOST_SECRET_ENVIRONMENT_KEY];
    await chmod(hostSecretRoot, 0o755);
    await writeFile(hostSecretPath, hostSecret, { encoding: "utf8", mode: 0o644 });
    const source = boundaryCheckedSource(hostSecretPath);
    await chmod(stagingRoot, 0o700);
    const docker = dockerClient();
    const runner = createRunner(stagingRoot, docker);
    const deadlineEpochMs = Date.now() + 120_000;
    const assetBytes = await readFile(fileURLToPath(new URL("../src-tauri/icons/32x32.png", import.meta.url)));
    const asset = inspectProjectPngBytesV1(assetBytes);
    const base = {
      assets: [
        {
          byteLength: asset.byteSize,
          bytesBase64: assetBytes.toString("base64"),
          digest: asset.digest,
          height: asset.height,
          logicalPath: "image.png" as const,
          mediaType: "image/png" as const,
          width: asset.width,
        },
      ],
      deadlineEpochMs,
      fenceToken: "1",
      jobId: "real-render/session-a",
      profileDigest: runner.profileDigest,
      projectId: "project-a",
      runtimeDigest: runner.runtimeDigest,
      sceneFrame: MANIM_RENDER_CANONICAL_SCENE_FRAME_V1,
      sceneName: "MultiAnimationScene",
      schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
      sessionId: "session-a",
      source,
      sourceDigest: createHash("sha256").update(source, "utf8").digest("hex"),
      sourcePath: "main.py",
      tenantId: "real-render",
      version: 2 as const,
    };
    const signal = new AbortController().signal;
    let operationError: unknown;
    process.env[HOST_SECRET_ENVIRONMENT_KEY] = hostSecret;
    try {
      await expect(runner.ready(signal)).resolves.toBe(true);
      await runner.reconcileOrphans();
      const video = await runner.submitOrReattach(
        new SealedManimRenderSandboxRequestV2({
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
        new SealedManimRenderSandboxRequestV2({
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
        new SealedManimRenderSandboxRequestV2({
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
        new SealedManimRenderSandboxRequestV2({
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
      for (const leaked of [hostSecret, hostSecretPath]) {
        expect(JSON.stringify({ forgedMedia, thumbnail, video })).not.toContain(leaked);
        expect(mp4.includes(Buffer.from(leaked, "utf8"))).toBe(false);
        expect(png.includes(Buffer.from(leaked, "utf8"))).toBe(false);
      }
      await runner.cleanup(base.jobId, Date.now() + 30_000, signal);
      expect(await readdir(stagingRoot)).toEqual([]);
      expect(await ownedContainerIds(docker, runner, true)).toEqual([]);
    } catch (error) {
      operationError = error;
    }
    if (previousHostSecret === undefined) delete process.env[HOST_SECRET_ENVIRONMENT_KEY];
    else process.env[HOST_SECRET_ENVIRONMENT_KEY] = previousHostSecret;
    const cleanup = await Promise.allSettled([runner.close()]);
    await Promise.all([
      rm(stagingRoot, { force: true, recursive: true }),
      rm(hostSecretRoot, { force: true, recursive: true }),
    ]);
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
    const request = new SealedManimRenderSandboxRequestV2({
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
      schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
      sessionId: "cancel-session",
      source: slowSource,
      sourceDigest: createHash("sha256").update(slowSource, "utf8").digest("hex"),
      sourcePath: "main.py",
      tenantId: "real-render",
      version: 2,
    });
    const signal = new AbortController().signal;
    let operationError: unknown;
    try {
      await runner.reconcileOrphans();
      const result = runner.submitOrReattach(request, deadlineEpochMs, signal);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const cancelled = request.parseDescriptor();
      await runner.cancel(
        {
          jobId: cancelled.jobId,
          rejectUntilEpochMs: cancelled.deadlineEpochMs,
          sessionId: cancelled.sessionId,
          tenantId: cancelled.tenantId,
        },
        Date.now() + 30_000,
        signal,
      );
      await expect(result).resolves.toEqual({ code: "cancelled", kind: "failed" });
      expect(await readdir(stagingRoot)).toEqual(["render-cancellations-v1.json"]);
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
    const request = new SealedManimRenderSandboxRequestV2({
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
      schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
      sessionId: "restart-session",
      source: slowSource,
      sourceDigest: createHash("sha256").update(slowSource, "utf8").digest("hex"),
      sourcePath: "main.py",
      tenantId: "real-render",
      version: 2,
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
      const cancelled = request.parseDescriptor();
      await unrelated.cancel(
        {
          jobId: cancelled.jobId,
          rejectUntilEpochMs: cancelled.deadlineEpochMs,
          sessionId: cancelled.sessionId,
          tenantId: cancelled.tenantId,
        },
        Date.now() + 30_000,
        signal,
      );
      await expect(unrelatedResult).resolves.toEqual({ code: "cancelled", kind: "failed" });
      expect(await ownedContainerIds(docker, unrelated, true)).toEqual([]);
      expect(await readdir(stagingRoot)).toEqual([]);
      expect(await readdir(unrelatedStagingRoot)).toEqual(["render-cancellations-v1.json"]);
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
        expected: { code: "deadline-exceeded", kind: "failed" },
        maximumElapsedMs: 20_000,
        name: "output-flood",
        sceneName: "OutputFloodScene",
        source: outputFloodSource,
        timeoutMs: 8_000,
      },
      {
        expected: { code: "memory-limit", kind: "failed" },
        maximumElapsedMs: 30_000,
        name: "memory",
        sceneName: "MemoryPressureScene",
        source: memoryPressureSource,
        timeoutMs: 25_000,
      },
      {
        expected: { code: "pids-limit", kind: "failed" },
        maximumElapsedMs: 20_000,
        name: "fork-pressure",
        sceneName: "ForkPressureScene",
        source: forkPressureSource,
        timeoutMs: 8_000,
      },
      {
        expected: { code: "render-failed", diagnostic: "manim-exit", kind: "failed" },
        maximumElapsedMs: 15_000,
        name: "descriptor-pressure",
        sceneName: "DescriptorPressureScene",
        source: descriptorPressureSource,
        timeoutMs: 10_000,
      },
      {
        expected: { code: "render-failed", diagnostic: "manim-exit", kind: "failed" },
        maximumElapsedMs: 15_000,
        name: "file-size-pressure",
        sceneName: "FileSizePressureScene",
        source: fileSizePressureSource,
        timeoutMs: 10_000,
      },
      {
        expected: { code: "result-rejected", kind: "failed" },
        maximumElapsedMs: 20_000,
        name: "tmpfs-byte-pressure",
        sceneName: "TmpfsBytePressureScene",
        source: tmpfsBytePressureSource,
        timeoutMs: 15_000,
      },
      {
        expected: { code: "result-rejected", kind: "failed" },
        maximumElapsedMs: 20_000,
        name: "tmpfs-inode-pressure",
        sceneName: "TmpfsInodePressureScene",
        source: tmpfsInodePressureSource,
        timeoutMs: 15_000,
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
        const request = new SealedManimRenderSandboxRequestV2({
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
          schema: MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2,
          sessionId: `adversarial-${attack.name}`,
          source: attack.source,
          sourceDigest: createHash("sha256").update(attack.source, "utf8").digest("hex"),
          sourcePath: "main.py",
          tenantId: "real-render",
          version: 2,
        });
        const startedAt = performance.now();
        const pending = runner.submitOrReattach(request, deadlineEpochMs, signal);
        if ("observeLiveDescendants" in attack || "minimumProcesses" in attack) {
          const containerId = await waitForOwnedContainer(docker, runner);
          if ("observeLiveDescendants" in attack) await waitForContainerProcessCount(docker, containerId, 2);
          if ("minimumProcesses" in attack) {
            await waitForContainerProcessCount(docker, containerId, attack.minimumProcesses);
          }
        }
        const result = await pending;
        expect(result, attack.name).toEqual(attack.expected);
        if (attack.expected.code === "memory-limit" || attack.expected.code === "pids-limit") {
          expect(Date.now(), attack.name).toBeLessThan(deadlineEpochMs);
        }
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
