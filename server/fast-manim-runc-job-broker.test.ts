import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import type {
  FastManimSandboxBoundedOutputLifecycleV1,
  LinuxCgroupV2DirectStartProofV1,
  LinuxCgroupV2LaunchEnvelopeV1,
  LinuxCgroupV2ResourceJobV1,
} from "./fast-manim-linux-cgroup-v2";
import {
  createFastManimOciBrokerDispatchV1,
  digestFastManimOciProfileV1,
  type FastManimOciBrokerDispatchV1,
  type FastManimOciBuildAttestationV1,
} from "./fast-manim-oci-sandbox-profile";
import { createFastManimRuncJobBrokerForTestingV1 } from "./fast-manim-runc-job-broker";
import {
  type FastManimRuncJobBundleMetadataPolicyV1,
  FastManimRuncJobBundleStoreV1,
} from "./fast-manim-runc-job-bundle";
import { FAST_MANIM_RUNC_RELEASE_SCHEMA_V1, FastManimRuncReleaseTrustV1 } from "./fast-manim-runc-release-trust";
import { FastManimRuncRootlessIdentityMapV1 } from "./fast-manim-runc-rootless-identity";
import type {
  FastManimRuncCreatedProcessV1,
  FastManimRuncRuntimeV1,
  FastManimRuncStateV1,
} from "./fast-manim-runc-runtime";
import { FastManimSandboxRequestBundleV1, fastManimSandboxBackendControlErrorCode } from "./fast-manim-sandbox-backend";
import {
  DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
  type FastManimSandboxResourceLimitsV1,
  type FastManimSandboxResourceTerminationReasonV1,
} from "./fast-manim-sandbox-resources";
import {
  createFastManimRuncRootfsFixtureV1,
  FAST_MANIM_TEST_ROOTFS_DIGEST_V1,
} from "./test-fixtures/fast-manim-runc-rootfs-fixture";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const NOW = 2_000_000_000_000;
const PID = 4242;
const ROOTFS_DIGEST = FAST_MANIM_TEST_ROOTFS_DIGEST_V1;
const profile = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/profile.v1.json", import.meta.url), "utf8"));
const seccomp = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/seccomp.v1.json", import.meta.url), "utf8"));
const seccompDigest = createHash("sha256").update(canonicalJsonV1(seccomp), "utf8").digest("hex");
const keyPair = generateKeyPairSync("ed25519");
const identityMap = new FastManimRuncRootlessIdentityMapV1({
  allowedGidRanges: [{ size: 65_533, start: 200_000 }],
  allowedUidRanges: [{ size: 65_533, start: 100_000 }],
  gidMappings: [{ containerID: 0, hostID: 200_000, size: 65_533 }],
  uidMappings: [{ containerID: 0, hostID: 100_000, size: 65_533 }],
});

type Deferred<T> = Readonly<{ promise: Promise<T>; reject: (reason: unknown) => void; resolve: (value: T) => void }>;

function deferred<T>(): Deferred<T> {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function limits(overrides: Partial<FastManimSandboxResourceLimitsV1> = {}) {
  return { ...DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, ...overrides };
}

function attestation(overrides: Readonly<Record<string, unknown>> = {}): FastManimOciBuildAttestationV1 {
  const material = {
    imageConfigDigest: `sha256:${"2".repeat(64)}`,
    imageDigest: `sha256:${"1".repeat(64)}`,
    inventoryDigest: "4".repeat(64),
    lockDigest: "5".repeat(64),
    profileDigest: digestFastManimOciProfileV1(profile),
    seccompDigest,
    ...overrides,
  };
  return {
    buildLockDigest: material.lockDigest,
    fastManim: { archiveSha256: "7".repeat(64), commit: "8".repeat(40), tree: "9".repeat(40) },
    imageConfigDigest: material.imageConfigDigest,
    imageDigest: material.imageDigest,
    platform: "linux/amd64",
    profileDigest: material.profileDigest,
    runtimeDigest: createHash("sha256").update(canonicalJsonV1(material), "utf8").digest("hex"),
    sbom: {
      digest: material.inventoryDigest,
      schema: "poietra.fast-manim-oci-sbom",
      signed: false,
      toolchainDigest: "a".repeat(64),
    },
    schema: "poietra.fast-manim-oci-build-attestation",
    seccompDigest: material.seccompDigest,
    version: 1,
  };
}

function dispatch(options: Readonly<{ build?: FastManimOciBuildAttestationV1; signal?: AbortSignal }> = {}) {
  return createFastManimOciBrokerDispatchV1({
    attestation: options.build ?? attestation(),
    context: {
      attestationDigest: "b".repeat(64),
      deadlineEpochMs: NOW + 60_000,
      identity: { projectId: "default", requestId: "request-1", tenantId: "tenant-1" },
      signal: options.signal ?? new AbortController().signal,
    },
    profile,
    request: new FastManimSandboxRequestBundleV1(sandboxProducerRequest()),
  });
}

function verifiedRelease(job: FastManimOciBrokerDispatchV1, rootfsPath: string, events: string[]) {
  const payload = {
    expiresAt: NOW + 60_000,
    imageDigest: job.descriptor.imageDigest,
    issuedAt: NOW - 60_000,
    keyId: "release-key-1",
    profileDigest: job.descriptor.profileDigest,
    rootfsDigest: ROOTFS_DIGEST,
    runtimeDigest: job.descriptor.runtimeDigest,
    sbomDigest: job.descriptor.sbomDigest,
    schema: FAST_MANIM_RUNC_RELEASE_SCHEMA_V1,
    seccompDigest: job.descriptor.seccompDigest,
    version: 1,
  } as const;
  const signature = sign(null, Buffer.from(canonicalJsonV1(payload), "utf8"), keyPair.privateKey).toString("base64url");
  return new FastManimRuncReleaseTrustV1({
    now: () => NOW,
    publicKeys: [
      {
        keyId: "release-key-1",
        publicKeyPem: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
    ],
    rootfsRegistry: createFastManimRuncRootfsFixtureV1(rootfsPath, { onEvent: (event) => events.push(event) }),
  }).verify({ payload, signature });
}

const testMetadataPolicy = Object.freeze<FastManimRuncJobBundleMetadataPolicyV1>({
  async prepare(handle, expectation) {
    await handle.chmod(expectation.mode);
  },
  async verifyRoot(handle) {
    if (!(await handle.stat()).isDirectory()) throw new Error("The test bundle root disappeared.");
  },
});

class FakeResourceController {
  readonly events: string[];
  readonly proof = Object.freeze({}) as LinuxCgroupV2DirectStartProofV1;
  activeJobs = 0;
  admitCalls = 0;
  admissionGate: Deferred<void> | null = null;
  readonly admissionStarted = deferred<void>();
  shutdownCalls = 0;

  constructor(events: string[]) {
    this.events = events;
  }

  async assertReady() {}

  async shutdown() {
    this.shutdownCalls += 1;
  }

  async admit(limitsValue: unknown, output: FastManimSandboxBoundedOutputLifecycleV1) {
    this.admitCalls += 1;
    this.events.push("admit-start");
    this.admissionStarted.resolve();
    await this.admissionGate?.promise;
    const admittedLimits = limitsValue as FastManimSandboxResourceLimitsV1;
    this.activeJobs += 1;
    this.events.push("admit-complete");
    const jobId = `${"c".repeat(32)}-1`;
    const cgroupName = `poietra-job-v1-${jobId}`;
    const completion = deferred<FastManimSandboxResourceTerminationReasonV1>();
    completion.promise.catch(() => undefined);
    let finished = false;
    const finish = async (reason: FastManimSandboxResourceTerminationReasonV1, proof?: unknown) => {
      if (finished) return;
      if (reason === "completed" && proof !== this.proof) throw new Error("The direct-start proof changed.");
      finished = true;
      this.events.push(`finish:${reason}`);
      await output.close(reason);
      this.activeJobs -= 1;
      completion.resolve(reason);
    };
    const launch: LinuxCgroupV2LaunchEnvelopeV1 = {
      cgroupsPath: `poietra-sandbox-v1/${cgroupName}`,
      deadlineEpochMs: NOW + admittedLimits.wallTimeMs,
      mustStartInCgroup: true,
      productionMembership: { state: "requires-direct-start-verification" },
      rlimits: {
        cpuTimeSeconds: Math.ceil(admittedLimits.maxCpuTimeMicros / 1_000_000),
        fileBytes: admittedLimits.maxFileBytes,
        openFiles: admittedLimits.maxOpenFiles,
      },
      tmpfs: {
        runtime: {
          maximumInodes: admittedLimits.maxRuntimeTmpfsInodes,
          sizeBytes: admittedLimits.maxRuntimeTmpfsBytes,
        },
        sharedMemory: {
          maximumInodes: admittedLimits.maxSharedMemoryInodes,
          sizeBytes: admittedLimits.maxSharedMemoryBytes,
        },
      },
    };
    return {
      completion: completion.promise,
      descriptor: {
        cgroupName,
        deadlineEpochMs: launch.deadlineEpochMs,
        jobId,
        limits: admittedLimits,
        reservedFileDescriptors: admittedLimits.maxProcesses * admittedLimits.maxOpenFiles,
        reservedMemoryBytes: admittedLimits.maxMemoryBytes + admittedLimits.maxSwapBytes,
        reservedOutputBytes:
          admittedLimits.maxResultBytes + admittedLimits.maxStderrBytes + admittedLimits.maxStdoutBytes,
        reservedTmpfsBytes: admittedLimits.maxRuntimeTmpfsBytes + admittedLimits.maxSharedMemoryBytes,
        schema: "poietra.fast-manim-sandbox-resource-job",
        version: 1,
      },
      finish,
      inspect: async () => ({
        cpuUsageMicros: 0,
        memoryMaxEvents: 0,
        memoryOomEvents: 0,
        memoryOomKillEvents: 0,
        pidsMaxEvents: 0,
        reason: null,
      }),
      launch,
      verifyDirectStart: async (pid: number) => {
        if (pid !== PID) throw new Error("The fake runc PID changed.");
        this.events.push(`proof:${pid}`);
        return this.proof;
      },
    } as unknown as LinuxCgroupV2ResourceJobV1;
  }
}

class FakeRuncRuntime implements FastManimRuncRuntimeV1 {
  readonly events: string[];
  readonly output: "bounded" | "overflow";
  bundlePath = "";
  config: Record<string, unknown> | null = null;
  createCalls = 0;
  createOptions: Readonly<Record<string, unknown>> | null = null;
  deleteCalls = 0;
  deleteFails = false;
  deleted = false;
  requestBytes = Buffer.alloc(0);
  stateGate: Deferred<void> | null = null;
  readonly stateStarted = deferred<void>();
  started = false;
  stopped = false;
  #stderr: PassThrough | null = null;
  #stdout: PassThrough | null = null;

  constructor(events: string[], output: "bounded" | "overflow" = "bounded") {
    this.events = events;
    this.output = output;
  }

  async assertReady() {}

  create(options: Readonly<{ bundlePath: string; containerId: string; deadlineEpochMs: number }>) {
    this.events.push("create");
    this.createCalls += 1;
    this.bundlePath = options.bundlePath;
    this.createOptions = Object.freeze({ ...options });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.#stdout = stdout;
    this.#stderr = stderr;
    const request: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => request.push(Buffer.from(chunk)));
    stdin.once("finish", () => {
      if (!this.started) throw new Error("stdin opened before runc start.");
      this.events.push("stdin-eof");
      this.requestBytes = Buffer.concat(request);
      stdout.end(this.output === "overflow" ? Buffer.from("12345", "ascii") : Buffer.from('{"ok":true}', "utf8"));
      stderr.end();
      this.stopped = true;
    });
    this.config = JSON.parse(readFileSync(join(options.bundlePath, "config.json"), "utf8")) as Record<string, unknown>;
    return Object.freeze({
      created: Promise.resolve(),
      stderr,
      stdin,
      stdout,
      terminateCreateClient() {},
    }) satisfies FastManimRuncCreatedProcessV1;
  }

  async state(containerId: string): Promise<FastManimRuncStateV1> {
    this.stateStarted.resolve();
    await this.stateGate?.promise;
    const status = this.stopped ? "stopped" : this.started ? "running" : "created";
    this.events.push(`state:${status}`);
    if (status === "stopped") return { bundle: this.bundlePath, id: containerId, pid: 0, status };
    if (status === "running") return { bundle: this.bundlePath, id: containerId, pid: PID, status };
    return { bundle: this.bundlePath, id: containerId, pid: PID, status };
  }

  async start() {
    this.events.push("start");
    this.started = true;
  }

  async kill() {
    this.events.push("kill");
    this.stopped = true;
    this.#stdout?.end();
    this.#stderr?.end();
  }

  async delete() {
    this.events.push("delete");
    this.deleteCalls += 1;
    if (this.deleteFails) throw new Error("The fake runc delete failed.");
    this.deleted = true;
  }
}

const disposals: Array<() => Promise<void>> = [];

async function fixture(
  options: Readonly<{
    admissionGate?: Deferred<void>;
    limits?: FastManimSandboxResourceLimitsV1;
    output?: "bounded" | "overflow";
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "poietra-runc-broker-test-"));
  const bundleRoot = join(root, "bundles");
  const rootfsPath = join(root, "rootfs");
  await Promise.all([mkdir(bundleRoot), mkdir(rootfsPath)]);
  const events: string[] = [];
  const controller = new FakeResourceController(events);
  controller.admissionGate = options.admissionGate ?? null;
  const runtime = new FakeRuncRuntime(events, options.output);
  const job = dispatch();
  const broker = createFastManimRuncJobBrokerForTestingV1({
    bundleStore: new FastManimRuncJobBundleStoreV1({
      identityMap,
      metadataPolicy: testMetadataPolicy,
      root: bundleRoot,
    }),
    identityMap,
    limits: options.limits ?? limits(),
    now: () => NOW,
    pollIntervalMs: 1,
    profile,
    release: verifiedRelease(job, rootfsPath, events),
    resourceController: controller,
    runtime,
    seccomp,
    sleep: async () => {},
  });
  disposals.push(async () => {
    await broker.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  });
  return { broker, bundleRoot, controller, dispatch: job, events, rootfsPath, runtime };
}

afterEach(async () => {
  await Promise.allSettled(disposals.splice(0).map((dispose) => dispose()));
});

describe("production runc job broker", () => {
  it("reports ready only while every concrete dependency remains healthy", async () => {
    const test = await fixture();
    const statusContext = {
      deadlineEpochMs: NOW + 30_000,
      identity: test.dispatch.context.identity,
      signal: new AbortController().signal,
    };

    await expect(test.broker.ready(statusContext)).resolves.toBe(true);
    await Promise.all([test.broker.close(), test.broker.close()]);
    expect(test.controller.shutdownCalls).toBe(1);
    await expect(test.broker.ready(statusContext)).resolves.toBe(false);
  });

  it("orders create, two state/proof gates, start, stdin EOF, stopped, delete, and completed cleanup", async () => {
    const test = await fixture();

    const result = await test.broker.dispatch(test.dispatch).result;

    expect(result).toMatchObject({ kind: "ok", requestDigest: test.dispatch.descriptor.request.sha256 });
    if (result.kind !== "ok") throw new Error("Expected an accepted runc result.");
    expect(Buffer.from(result.resultBytes).toString("utf8")).toBe('{"ok":true}');
    expect(test.events.filter((event) => !event.startsWith("admit"))).toEqual([
      "rootfs:image-open",
      "rootfs:mount-open",
      "create",
      `state:created`,
      `proof:${PID}`,
      `state:created`,
      `proof:${PID}`,
      "start",
      "stdin-eof",
      "state:stopped",
      "delete",
      "rootfs:image-close",
      "rootfs:mount-close",
      "finish:completed",
    ]);
    expect(test.runtime.requestBytes).toEqual(Buffer.from(test.dispatch.copyRequestBytes()));
    expect(test.runtime.deleted).toBe(true);
    expect(test.controller.activeJobs).toBe(0);
    expect(await readdir(test.bundleRoot)).toEqual([]);
  });

  it("waits for non-abortable admission to settle after abort, then cleans the late lease without a runtime leak", async () => {
    const admissionGate = deferred<void>();
    const test = await fixture({ admissionGate });
    const handle = test.broker.dispatch(test.dispatch);
    let settled = false;
    handle.result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await test.controller.admissionStarted.promise;

    handle.abort();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(settled).toBe(false);
    admissionGate.resolve();

    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
    expect(test.runtime.createCalls).toBe(0);
    expect(test.controller.activeJobs).toBe(0);
    expect(test.events).toContain("finish:aborted");
    expect(await readdir(test.bundleRoot)).toEqual([]);
  });

  it("starts cgroup termination before joining an aborting runc control command", async () => {
    const stateGate = deferred<void>();
    const test = await fixture();
    test.runtime.stateGate = stateGate;
    const handle = test.broker.dispatch(test.dispatch);
    await test.runtime.stateStarted.promise;

    handle.abort();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(test.events).toContain("finish:aborted");
    expect(test.events).not.toContain("delete");
    stateGate.resolve();
    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
    expect(test.runtime.deleted).toBe(true);
    expect(test.controller.activeJobs).toBe(0);
    expect(await readdir(test.bundleRoot)).toEqual([]);
  });

  it("maps a bounded stdout/result overflow to producer-output-overflow and reaps the runtime", async () => {
    const test = await fixture({
      limits: limits({ maxResultBytes: 4, maxStdoutBytes: 4 }),
      output: "overflow",
    });

    await expect(test.broker.dispatch(test.dispatch).result).resolves.toMatchObject({
      code: "producer-output-overflow",
      kind: "failed",
    });
    expect(test.events).toContain("finish:stdout-overflow");
    expect(test.runtime.deleted).toBe(true);
    expect(test.controller.activeJobs).toBe(0);
  });

  it("rejects forged and signed-release-drift dispatches before cgroup admission", async () => {
    const test = await fixture();
    expect(() =>
      test.broker.dispatch({ ...test.dispatch, argv: ["/bin/sh"], hostPath: "/request-controlled" } as never),
    ).toThrow(/verified dispatch/i);
    const drifted = dispatch({ build: attestation({ imageDigest: `sha256:${"e".repeat(64)}` }) });

    await expect(test.broker.dispatch(drifted).result).resolves.toMatchObject({
      code: "sandbox-attestation-rejected",
      kind: "failed",
    });
    expect(test.controller.admitCalls).toBe(0);
    expect(test.runtime.createCalls).toBe(0);
  });

  it("latches delete cleanup failure across subsequent dispatch and broker close", async () => {
    const test = await fixture();
    test.runtime.deleteFails = true;

    let failure: unknown;
    try {
      await test.broker.dispatch(test.dispatch).result;
    } catch (error) {
      failure = error;
    }

    expect(fastManimSandboxBackendControlErrorCode(failure)).toBe("cleanup");
    expect(test.runtime.deleteCalls).toBe(2);
    expect(test.controller.activeJobs).toBe(0);
    expect(test.events).not.toContain("rootfs:image-close");
    expect(test.events).not.toContain("rootfs:mount-close");
    expect(await readdir(test.bundleRoot)).toHaveLength(1);
    expect(() => test.broker.dispatch(test.dispatch)).toThrow();
    await expect(test.broker.close()).rejects.toSatisfy(
      (error: unknown) => fastManimSandboxBackendControlErrorCode(error) === "cleanup",
    );
  });

  it("keeps request-controlled argv and host paths out of the staged OCI launch", async () => {
    const test = await fixture();
    const invalidRequest = { ...sandboxProducerRequest(), argv: ["/bin/sh"], hostPath: "/request-controlled" };
    expect(() => new FastManimSandboxRequestBundleV1(invalidRequest as never)).toThrow();

    await test.broker.dispatch(test.dispatch).result;

    expect(Object.keys(test.runtime.createOptions ?? {}).sort()).toEqual([
      "bundlePath",
      "containerId",
      "deadlineEpochMs",
    ]);
    expect(test.runtime.config).not.toBeNull();
    const config = test.runtime.config as {
      process: { args: string[] };
      root: { path: string };
    };
    expect(config.process.args).toEqual([
      "/opt/venv/bin/python",
      "/opt/poietra/entrypoint.py",
      "/opt/venv/bin/python",
      "-m",
      "manim.renderer.source_runtime_identity",
    ]);
    expect(config.root.path).toBe(test.rootfsPath);
    expect(canonicalJsonV1(config)).not.toContain("request-controlled");
    expect(test.dispatch.descriptor).not.toHaveProperty("argv");
    expect(test.dispatch.descriptor).not.toHaveProperty("hostPath");
  });
});
