import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import fastManimGatedOciSeccompV1 from "../sandbox/fast-manim-gated-oci/seccomp.v1.json";
import {
  FAST_MANIM_GATED_OCI_PROFILE_V1,
  FastManimGatedOciDockerClientV1,
  reconcileFastManimGatedOciDockerOrphansV1,
} from "./fast-manim-gated-oci-job-runner";
import {
  createConfiguredFastManimLocalGatedOciBackendV1,
  FastManimLocalGatedOciBackendV1,
  FastManimLocalGatedOciError,
  parseFastManimLocalGatedOciResultV1,
  runFastManimLocalGatedOciV1,
} from "./fast-manim-local-gated-oci-backend";
import { FastManimSandboxBackendControlError, FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import {
  fastManimSnapshotResultV1Schema,
  fastManimSnapshotSceneIdV1,
  MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS,
  MAX_FAST_MANIM_SNAPSHOT_OBJECT_FIELDS,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH,
} from "./fast-manim-snapshot-contract";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const realImage = process.env.POIETRA_FAST_MANIM_GATED_OCI_IMAGE;
const realLane = /^sha256:[a-f0-9]{64}$/.test(realImage ?? "");
const MAGIC = Buffer.from("POIETR1\0", "ascii");
const seccompPath = fileURLToPath(new URL("../sandbox/fast-manim-gated-oci/seccomp.v1.json", import.meta.url));

function context(signal = new AbortController().signal, deadlineMs = 30_000) {
  return {
    deadlineEpochMs: Date.now() + deadlineMs,
    identity: { projectId: "default", requestId: "gated-oci-test", tenantId: "test-tenant" },
    signal,
  };
}

function requestFor(sourceText: string, sceneName: string) {
  const request = sandboxProducerRequest();
  return new FastManimSandboxRequestBundleV1({
    ...request,
    requestId: `gated-${sceneName}`,
    sceneId: fastManimSnapshotSceneIdV1("scene.py", sceneName),
    sceneName,
    sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    sourceText,
  });
}

function wire(body: Uint8Array, overrides: Readonly<{ digest?: Buffer; length?: number; magic?: Buffer }> = {}) {
  const header = Buffer.alloc(48);
  (overrides.magic ?? MAGIC).copy(header, 0);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(overrides.length ?? body.byteLength, 12);
  (overrides.digest ?? createHash("sha256").update(body).digest()).copy(header, 16);
  return Buffer.concat([header, body]);
}

const staticScene = `from manim import Circle, Line, Rectangle, Scene

class GatedStaticScene(Scene):
    def construct(self):
        circle = Circle().set_fill("#ef4444", opacity=1.0).set_stroke(width=0)
        rectangle = Rectangle().set_fill("#22c55e", opacity=1.0).set_stroke(width=0)
        line = Line([-2.0, -1.0, 0.0], [2.0, 1.0, 0.0]).set_stroke("#3b82f6", width=4)
        self.add(circle, rectangle, line)
`;

class RecordingDockerClient extends FastManimGatedOciDockerClientV1 {
  readonly calls: string[][] = [];
  readonly responses: Array<Readonly<{ code: number; stderr: Buffer; stdout: Buffer }>> = [];

  override async run(arguments_: readonly string[]) {
    this.calls.push([...arguments_]);
    return this.responses.shift() ?? { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  }
}

function trustedImageInspection(image: string) {
  return Buffer.from(
    JSON.stringify([
      {
        Config: {
          Cmd: ["/opt/venv/bin/python", "-m", "manim.renderer.scene_snapshot"],
          Entrypoint: ["/opt/venv/bin/python", "/opt/poietra/gated-entrypoint.py"],
          Labels: {
            "io.poietra.fast-manim.archive-sha256": "46f66b6698650988c18327732d1d3c30cccd53b38de91e1059c61187d92c2b61",
            "io.poietra.fast-manim.commit": "ac143dc46ebe314095ae7864a32efa289a0afe96",
            "io.poietra.fast-manim.tree": "b86e2ec81f257cae20669e3c5c33080facfbd610",
            "io.poietra.sandbox-slice": "gated-oci-v1",
          },
        },
        Id: image,
      },
    ]),
  );
}

function stoppedFixedContainerInspection(image: string, containerId: string) {
  const profile = FAST_MANIM_GATED_OCI_PROFILE_V1;
  return Buffer.from(
    JSON.stringify([
      {
        Config: {
          Cmd: profile.target,
          Entrypoint: profile.entrypoint,
          Env: Object.entries(profile.environment).map(([key, value]) => `${key}=${value}`),
          Image: image,
          Labels: profile.requiredContainerLabels,
          OpenStdin: profile.openStdin,
          StdinOnce: profile.stdinOnce,
          StopTimeout: profile.stopTimeoutSeconds,
          Tty: profile.tty,
          User: profile.user,
          WorkingDir: profile.workingDirectory,
        },
        HostConfig: {
          AutoRemove: profile.autoRemove,
          Binds: null,
          CapAdd: null,
          CapDrop: profile.capabilitiesDropped,
          CgroupnsMode: profile.cgroupNamespace,
          Devices: profile.devices,
          IpcMode: profile.ipc,
          LogConfig: { Config: profile.logDriver.config, Type: profile.logDriver.type },
          MaskedPaths: profile.requiredMaskedSystemPaths,
          Memory: profile.memoryBytes,
          MemorySwap: profile.memorySwapBytes,
          NanoCpus: profile.cpuNanoSeconds,
          NetworkMode: profile.network,
          PidMode: "",
          PidsLimit: profile.pidsLimit,
          Privileged: profile.privileged,
          ReadonlyPaths: profile.requiredReadOnlySystemPaths,
          ReadonlyRootfs: profile.readOnlyRootfs,
          SecurityOpt: ["no-new-privileges=true", `seccomp=${JSON.stringify(fastManimGatedOciSeccompV1)}`],
          ShmSize: profile.shmBytes,
          Tmpfs: { [profile.tmpfs.path]: profile.tmpfs.options.join(",") },
          Ulimits: profile.ulimits.map((limit) => ({
            Hard: limit.hard,
            Name: limit.name,
            Soft: limit.soft,
          })),
        },
        Id: containerId,
        Image: image,
        Mounts: profile.mounts,
        Name: "/poietra-gated-00000000000000000000000000000000",
        State: { Pid: 0, Running: false },
      },
    ]),
  );
}

describe("gated OCI Docker ownership", () => {
  it("targets a canonical fixed socket and reconciles only broker-owned jobs", async () => {
    expect(() => new FastManimGatedOciDockerClientV1({ socketPath: "relative.sock" })).toThrow(/canonical/i);
    const image = `sha256:${"a".repeat(64)}`;
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push(
      { code: 0, stderr: Buffer.alloc(0), stdout: trustedImageInspection(image) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );

    await reconcileFastManimGatedOciDockerOrphansV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: client,
      image,
      seccompPath,
      signal: new AbortController().signal,
    });
    expect(client.calls).toEqual([
      ["image", "inspect", image],
      ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", "label=io.poietra.gated-job=v1"],
    ]);
  });

  it("removes owned orphans while keeping readiness failed after image drift", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const containerId = "b".repeat(64);
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push(
      { code: 1, stderr: Buffer.from("untrusted"), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${containerId}\n`) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify([{ Id: containerId }])) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );

    await expect(
      reconcileFastManimGatedOciDockerOrphansV1({
        cgroupKillPolicy: "best-effort",
        dockerClient: client,
        image,
        seccompPath,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    expect(client.calls).toContainEqual(["container", "kill", containerId]);
    expect(client.calls).toContainEqual(["container", "rm", "--force", containerId]);
  });

  it("removes a stopped orphan but requires a clean restart instead of treating leader exit as reap proof", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const containerId = "b".repeat(64);
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push(
      { code: 0, stderr: Buffer.alloc(0), stdout: trustedImageInspection(image) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${containerId}\n`) },
      { code: 0, stderr: Buffer.alloc(0), stdout: stoppedFixedContainerInspection(image, containerId) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );

    await expect(
      reconcileFastManimGatedOciDockerOrphansV1({
        cgroupKillPolicy: "best-effort",
        dockerClient: client,
        image,
        seccompPath,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    expect(client.calls).toContainEqual(["container", "rm", "--force", containerId]);

    const retry = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    retry.responses.push(
      { code: 0, stderr: Buffer.alloc(0), stdout: trustedImageInspection(image) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );
    await expect(
      reconcileFastManimGatedOciDockerOrphansV1({
        cgroupKillPolicy: "best-effort",
        dockerClient: retry,
        image,
        seccompPath,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("still removes owned orphans before failing closed on seccomp drift", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const containerId = "b".repeat(64);
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push(
      { code: 0, stderr: Buffer.alloc(0), stdout: trustedImageInspection(image) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${containerId}\n`) },
      {
        code: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          JSON.stringify([
            {
              Config: { Labels: { "io.poietra.gated-job": "v1" } },
              Id: containerId,
              Name: "/poietra-gated-00000000000000000000000000000000",
              State: { Pid: 0, Running: false },
            },
          ]),
        ),
      },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );

    await expect(
      reconcileFastManimGatedOciDockerOrphansV1({
        cgroupKillPolicy: "best-effort",
        dockerClient: client,
        image,
        seccompPath: "/definitely-missing/poietra-seccomp.json",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    expect(client.calls).toEqual(
      expect.arrayContaining([
        ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", "label=io.poietra.gated-job=v1"],
        ["container", "kill", containerId],
        ["container", "rm", "--force", containerId],
      ]),
    );
  });
});

describe("gated OCI fixed profile", () => {
  it("treats seccomp EPERM/EACCES at stream socket creation as proof that outbound networking is blocked", () => {
    const entrypointPath = fileURLToPath(
      new URL("../sandbox/fast-manim-gated-oci/gated-entrypoint.py", import.meta.url),
    );
    const probe = String.raw`
import errno
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("poietra_gate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DeniedSocket:
    def __init__(self, code):
        self.code = code
    def __call__(self, *_args, **_kwargs):
        raise OSError(self.code, "blocked by seccomp")

for code in (errno.EPERM, errno.EACCES):
    module.socket.socket = DeniedSocket(code)
    module._assert_outbound_network_blocked()

module.socket.socket = DeniedSocket(errno.EINVAL)
try:
    module._assert_outbound_network_blocked()
except RuntimeError:
    pass
else:
    raise AssertionError("unexpected socket errors must remain fail-closed")
`;
    const result = spawnSync("/usr/bin/python3", ["-c", probe, entrypointPath], { encoding: "utf8" });
    expect({ stderr: result.stderr, status: result.status }).toEqual({ stderr: "", status: 0 });
  });
});

describe("local gated OCI factory", () => {
  it("is unconditionally unavailable in production, even when the Docker opt-in and image are supplied", async () => {
    const backend = createConfiguredFastManimLocalGatedOciBackendV1({
      deployment: "production",
      image: `sha256:${"a".repeat(64)}`,
      localDockerDevOptIn: true,
    });
    await expect(backend.status(context())).resolves.toMatchObject({
      backendKind: "disabled",
      capabilities: [],
      health: "unavailable",
      reason: "not-configured",
    });
  });

  it("requires the explicit development opt-in and an immutable image ID", async () => {
    const disabled = createConfiguredFastManimLocalGatedOciBackendV1({
      deployment: "development",
      image: `sha256:${"a".repeat(64)}`,
      localDockerDevOptIn: false,
    });
    await expect(disabled.status(context())).resolves.toMatchObject({ health: "unavailable" });
    expect(() =>
      createConfiguredFastManimLocalGatedOciBackendV1({
        deployment: "development",
        image: "poietra-fast-manim-gated:latest",
        localDockerDevOptIn: true,
      }),
    ).toThrow(/immutable sha256/i);
  });

  it("latches cleanup failure, refuses new jobs, reports unavailable, and fails close", async () => {
    const cleanupError = new FastManimSandboxBackendControlError("cleanup");
    const backend = new FastManimLocalGatedOciBackendV1({
      executeJob: async () => {
        throw cleanupError;
      },
      image: `sha256:${"a".repeat(64)}`,
    });
    const request = requestFor(staticScene, "GatedStaticScene");
    const jobContext = { ...context(), attestationDigest: "b".repeat(64) };
    await expect(backend.start(request, jobContext).result).rejects.toBe(cleanupError);
    await expect(backend.status(context())).resolves.toMatchObject({
      capabilities: [],
      health: "unavailable",
      reason: "health-check-failed",
    });
    expect(() => backend.start(request, jobContext)).toThrow(FastManimSandboxBackendControlError);
    await expect(backend.close()).rejects.toMatchObject({ code: "cleanup" });
  });

  it("permanently taints after create dispatch is aborted before an immutable ID is observed", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const executionController = new AbortController();
    let createDispatched = false;
    let recoveryAttempted = false;
    const backend = new FastManimLocalGatedOciBackendV1({
      executeJob: (options) =>
        runFastManimLocalGatedOciV1({
          ...options,
          createUncertainTestSeam: {
            assertTrustedImage: async () => undefined,
            createContainer: (_arguments, _timeoutMs, signal) => {
              createDispatched = true;
              executionController.abort();
              return new Promise((_resolve, reject) => {
                const rejectAbort = () =>
                  reject(new DOMException("The create control process was aborted.", "AbortError"));
                if (signal?.aborted) rejectAbort();
                else signal?.addEventListener("abort", rejectAbort, { once: true });
              });
            },
            recoverContainerByName: async (containerName) => {
              recoveryAttempted = true;
              expect(containerName).toMatch(/^poietra-gated-[a-f0-9]{32}$/);
            },
          },
        }),
      image,
    });
    const request = requestFor(staticScene, "GatedStaticScene");
    const jobContext = { ...context(executionController.signal), attestationDigest: "b".repeat(64) };

    await expect(backend.start(request, jobContext).result).rejects.toMatchObject({ code: "cleanup" });
    expect({ createDispatched, recoveryAttempted }).toEqual({ createDispatched: true, recoveryAttempted: true });
    await expect(backend.status(context())).resolves.toMatchObject({
      capabilities: [],
      health: "unavailable",
      reason: "health-check-failed",
    });
    expect(() => backend.start(request, { ...context(), attestationDigest: "c".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "cleanup" }),
    );
    await expect(backend.close()).rejects.toMatchObject({ code: "cleanup" });
  });
});

describe("gated OCI result boundary", () => {
  it("accepts the locked Python producer's compact, sorted JSON spelling", () => {
    const result = Buffer.from(
      '{"a":-0.0,"b":[0.0001,1.0,1e-07,1e+20,1000000000000000.0,"λ\\n"],"c":{"α":true}}\n',
      "utf8",
    );
    expect(Buffer.from(parseFastManimLocalGatedOciResultV1(result))).toEqual(result.subarray(0, -1));
  });

  it("rejects invalid UTF-8 and output beyond the exact result-plus-LF budget", () => {
    const invalidUtf8 = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
    expect(() => parseFastManimLocalGatedOciResultV1(invalidUtf8)).toThrowError(
      expect.objectContaining({ code: "sandbox-result-rejected" }),
    );
    expect(() =>
      parseFastManimLocalGatedOciResultV1(Buffer.alloc(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES + 2, 0x78)),
    ).toThrowError(expect.objectContaining({ code: "producer-output-overflow" }));
  });

  it.each([
    '{"b":1,"a":2}\n',
    '{"a":1,"a":2}\n',
    '{"a":1.00}\n',
    '{"a":1e+01}\n',
    '{"a":1e-00}\n',
    '{"a":1E+20}\n',
    '{"a":0.00001}\n',
    '{"a":10000000000000000.0}\n',
    '{"a":"\\u03bb"}\n',
    '{ "a":1}\n',
    '{"a":1}\n\n',
  ])("rejects non-canonical result bytes: %s", (result) => {
    expect(() => parseFastManimLocalGatedOciResultV1(Buffer.from(result, "utf8"))).toThrowError(
      expect.objectContaining({ code: "sandbox-result-rejected" }),
    );
  });

  it("rejects JSON nesting beyond the shared snapshot depth budget", () => {
    const nesting = MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH + 1;
    const result = `{"a":${"[".repeat(nesting)}0${"]".repeat(nesting)}}\n`;
    expect(() => parseFastManimLocalGatedOciResultV1(Buffer.from(result, "utf8"))).toThrowError(
      expect.objectContaining({ code: "sandbox-result-rejected" }),
    );
  });

  it("rejects arrays, objects, and total entries beyond the shared structural budgets", () => {
    const oversizedArray = `{"a":[${Array.from({ length: MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS + 1 }, () => "0").join(",")}]}\n`;
    const oversizedObject = Object.fromEntries(
      Array.from({ length: MAX_FAST_MANIM_SNAPSHOT_OBJECT_FIELDS + 1 }, (_, index) => [
        `field-${index.toString().padStart(3, "0")}`,
        0,
      ]),
    );
    const tooManyEntries = { a: Array(9_000).fill(0), b: Array(9_000).fill(0), c: Array(9_000).fill(0) };
    for (const result of [
      oversizedArray,
      `${JSON.stringify(oversizedObject)}\n`,
      `${JSON.stringify(tooManyEntries)}\n`,
    ]) {
      expect(() => parseFastManimLocalGatedOciResultV1(Buffer.from(result, "utf8"))).toThrowError(
        expect.objectContaining({ code: "sandbox-result-rejected" }),
      );
    }
  });
});

describe.skipIf(!realLane)("real rootful gated OCI vertical slice", () => {
  const image = realImage!;

  it("reaches READY under the custom seccomp profile, then renders a real Circle, Rectangle, and Line", {
    timeout: 60_000,
  }, async () => {
    const request = requestFor(staticScene, "GatedStaticScene");
    const execution = await runFastManimLocalGatedOciV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    expect(execution.evidence).toMatchObject({
      resources: {
        memoryMax: String(512 * 1024 * 1024),
        memorySwapMax: "0",
        pidsMax: "64",
      },
    });
    const result = fastManimSnapshotResultV1Schema.parse(
      JSON.parse(Buffer.from(execution.resultBytes).toString("utf8")),
    );
    expect(result).toMatchObject({ kind: "compiled", requestId: "gated-GatedStaticScene" });
    if (result.kind !== "compiled") throw new Error("Expected a compiled static Scene.");
    expect((result.bundle as { scene: { entities: unknown[] } }).scene.entities).toHaveLength(3);
    expect(Buffer.from(execution.resultBytes).includes(Buffer.from("POIETRA_GATE_READY_V1"))).toBe(false);
  });

  it("does not quarantine an abort observed after known-ID cleanup was verified", { timeout: 60_000 }, async () => {
    const executionController = new AbortController();
    let verifiedCleanupReached = false;
    const backend = new FastManimLocalGatedOciBackendV1({
      executeJob: (options) =>
        runFastManimLocalGatedOciV1({
          ...options,
          afterVerifiedCleanupForTesting: () => {
            verifiedCleanupReached = true;
            executionController.abort();
          },
        }),
      image,
    });
    const request = requestFor(staticScene, "GatedStaticScene");

    await expect(
      backend.start(request, {
        ...context(executionController.signal),
        attestationDigest: "b".repeat(64),
      }).result,
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(verifiedCleanupReached).toBe(true);
    await expect(backend.status(context())).resolves.toMatchObject({ health: "ready" });
    await expect(backend.close()).resolves.toBeUndefined();
  });

  it("interrupts pre-launch image inspection and status reads on abort", { timeout: 30_000 }, async () => {
    const request = requestFor(staticScene, "GatedStaticScene");
    const executionController = new AbortController();
    const execution = runFastManimLocalGatedOciV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: executionController.signal,
    });
    executionController.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });

    const backend = new FastManimLocalGatedOciBackendV1({ image });
    const statusController = new AbortController();
    const status = backend.status(context(statusController.signal));
    statusController.abort();
    await expect(status).rejects.toMatchObject({ name: "AbortError" });
    await backend.close();
  });

  it("rejects wrong digest, wrong length, early EOF, and trailing bytes at the entrypoint", {
    timeout: 60_000,
  }, async () => {
    const body = requestFor(staticScene, "GatedStaticScene").copyBytes();
    const cases = [
      wire(body, { digest: Buffer.alloc(32, 0xa5) }),
      wire(body, { length: body.byteLength - 1 }),
      wire(body, { length: body.byteLength + 1 }),
      Buffer.concat([wire(body), Buffer.from("x")]),
    ];
    for (const bytes of cases) {
      const error = await runFastManimLocalGatedOciV1({
        conformanceWire: { bytes, close: true },
        deadlineEpochMs: Date.now() + 15_000,
        image,
        requestBytes: body,
        signal: new AbortController().signal,
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(FastManimLocalGatedOciError);
      expect(error).toMatchObject({ cleanupVerified: true, code: "producer-exit" });
    }
  });

  it("times out a body that never reaches EOF and still removes its PID and container", {
    timeout: 30_000,
  }, async () => {
    const body = requestFor(staticScene, "GatedStaticScene").copyBytes();
    const error = await runFastManimLocalGatedOciV1({
      conformanceWire: { bytes: wire(body), close: false },
      deadlineEpochMs: Date.now() + 1_200,
      image,
      requestBytes: body,
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(FastManimLocalGatedOciError);
    expect(error).toMatchObject({ cleanupVerified: true, code: "producer-timeout" });
  });

  it("aborts a gated body waiting for EOF and proves cleanup", { timeout: 30_000 }, async () => {
    const body = requestFor(staticScene, "GatedStaticScene").copyBytes();
    const controller = new AbortController();
    const running = runFastManimLocalGatedOciV1({
      conformanceWire: { bytes: wire(body), close: false },
      deadlineEpochMs: Date.now() + 20_000,
      image,
      requestBytes: body,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 750).unref();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses reflective saved-descriptor source before it can execute", { timeout: 60_000 }, async () => {
    const reflectiveScene = staticScene.replace(
      "def construct(self):",
      'def construct(self):\n        import os\n        os.write(3, b"\\xff")',
    );
    const request = requestFor(reflectiveScene, "GatedStaticScene");
    const execution = await runFastManimLocalGatedOciV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    const result = fastManimSnapshotResultV1Schema.parse(
      JSON.parse(Buffer.from(execution.resultBytes).toString("utf8")),
    );
    expect(result).toMatchObject({ kind: "unsupported", requestId: "gated-GatedStaticScene" });
    if (result.kind !== "unsupported") throw new Error("Expected the static execution profile to refuse reflection.");
    expect(result.issues.flatMap((issue) => issue.evidence ?? [])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/denied import 'os'/),
        expect.stringMatching(/unlisted attribute write/),
      ]),
    );
  });
});
