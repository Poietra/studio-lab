import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import type { LinuxCgroupV2ResourceControllerV1, LinuxCgroupV2ResourceJobV1 } from "./fast-manim-linux-cgroup-v2";
import {
  digestFastManimOciProfileV1,
  FastManimOciBrokerDispatchV1,
  type FastManimOciJobBrokerV1,
  fastManimOciProfileV1Schema,
} from "./fast-manim-oci-sandbox-profile";
import { createFastManimRuncBoundedIoV1 } from "./fast-manim-runc-bounded-io";
import {
  type FastManimRuncJobBundlePlanV1,
  FastManimRuncJobBundleStoreV1,
  type FastManimRuncJobBundleV1,
  isProductionFastManimRuncJobBundleStoreV1,
} from "./fast-manim-runc-job-bundle";
import { FastManimRuncOciSpecGeneratorV1 } from "./fast-manim-runc-oci-spec";
import { FastManimRuncVerifiedReleaseV1 } from "./fast-manim-runc-release-trust";
import type {
  FastManimRuncCreatedProcessV1,
  FastManimRuncRuntimeV1,
  FastManimRuncStateV1,
} from "./fast-manim-runc-runtime";
import {
  FastManimSandboxBackendControlError,
  type FastManimSandboxBackendResultV1,
  type FastManimSandboxJobHandleV1,
} from "./fast-manim-sandbox-backend";
import {
  type FastManimSandboxResourceLimitsV1,
  type FastManimSandboxResourceTerminationReasonV1,
  fastManimSandboxResourceControlErrorCode,
  parseFastManimSandboxResourceLimitsV1,
} from "./fast-manim-sandbox-resources";

const DEFAULT_STATE_POLL_INTERVAL_MS = 25;
const MAX_STATE_POLL_INTERVAL_MS = 1_000;

type RuncResourceController = Readonly<Pick<LinuxCgroupV2ResourceControllerV1, "admit">>;
type BrokerActiveJob = Readonly<{ abort: () => void; result: Promise<unknown> }>;
const testBrokerCapabilityV1 = Object.freeze({ kind: "fast-manim-runc-test-broker" as const });

class FastManimRuncHaltV1 extends Error {
  readonly reason: FastManimSandboxResourceTerminationReasonV1;

  constructor(reason: FastManimSandboxResourceTerminationReasonV1) {
    super("The runc sandbox job was halted.");
    this.name = "FastManimRuncHaltV1";
    this.reason = reason;
  }
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function failureResult(
  dispatch: FastManimOciBrokerDispatchV1,
  code: Extract<FastManimSandboxBackendResultV1, { kind: "failed" }>["code"],
): FastManimSandboxBackendResultV1 {
  return Object.freeze({
    attestationDigest: dispatch.context.attestationDigest,
    code,
    kind: "failed" as const,
    requestDigest: dispatch.descriptor.request.sha256,
  });
}

function failureCode(reason: FastManimSandboxResourceTerminationReasonV1) {
  if (reason === "deadline") return "producer-timeout" as const;
  if (reason === "result-overflow" || reason === "stderr-overflow" || reason === "stdout-overflow") {
    return "producer-output-overflow" as const;
  }
  return "sandbox-execution-failed" as const;
}

function checkedPollInterval(value: number | undefined) {
  const interval = value ?? DEFAULT_STATE_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > MAX_STATE_POLL_INTERVAL_MS) {
    throw new TypeError("The runc state poll interval is outside its fixed budget.");
  }
  return interval;
}

function copyCanonicalJson(value: unknown) {
  return JSON.parse(canonicalJsonV1(value)) as unknown;
}

export type FastManimRuncJobBrokerOptionsV1 = Readonly<{
  bundleStore: FastManimRuncJobBundleStoreV1;
  limits: unknown;
  now?: () => number;
  pollIntervalMs?: number;
  profile: unknown;
  release: FastManimRuncVerifiedReleaseV1;
  resourceController: RuncResourceController;
  runtime: FastManimRuncRuntimeV1;
  seccomp: unknown;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

/**
 * Production OCI job owner. It applies the signed release, immutable bundle,
 * cgroup admission, direct-start proof, bounded stdio, and runc lifecycle as
 * one fail-closed transition. It exposes no Docker socket or generic argv,
 * environment, mount, host-path, or runtime command input.
 */
export class FastManimRuncJobBrokerV1 implements FastManimOciJobBrokerV1 {
  readonly #active = new Set<BrokerActiveJob>();
  readonly #bundleStore: FastManimRuncJobBundleStoreV1;
  readonly #limits: FastManimSandboxResourceLimitsV1;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #profile: unknown;
  readonly #profileDigest: string;
  readonly #release: FastManimRuncVerifiedReleaseV1;
  readonly #resourceController: RuncResourceController;
  readonly #runtime: FastManimRuncRuntimeV1;
  readonly #seccomp: unknown;
  readonly #seccompDigest: string;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #cleanupFailed = false;
  #closing = false;

  constructor(options: FastManimRuncJobBrokerOptionsV1, testCapability?: typeof testBrokerCapabilityV1) {
    if (
      !(options.bundleStore instanceof FastManimRuncJobBundleStoreV1) ||
      (!isProductionFastManimRuncJobBundleStoreV1(options.bundleStore) && testCapability !== testBrokerCapabilityV1)
    ) {
      throw new TypeError("The production runc broker requires its closed bundle store.");
    }
    if (!(options.release instanceof FastManimRuncVerifiedReleaseV1)) {
      throw new TypeError("The production runc broker requires one verified signed release.");
    }
    if (
      typeof options.resourceController?.admit !== "function" ||
      typeof options.runtime?.create !== "function" ||
      typeof options.runtime?.state !== "function" ||
      typeof options.runtime?.start !== "function" ||
      typeof options.runtime?.kill !== "function" ||
      typeof options.runtime?.delete !== "function"
    ) {
      throw new TypeError("The production runc broker runtime boundary is incomplete.");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("The production runc broker clock is malformed.");
    }
    if (options.sleep !== undefined && typeof options.sleep !== "function") {
      throw new TypeError("The production runc broker sleep boundary is malformed.");
    }
    const profile = fastManimOciProfileV1Schema.parse(copyCanonicalJson(options.profile));
    const seccomp = copyCanonicalJson(options.seccomp);
    this.#bundleStore = options.bundleStore;
    this.#limits = parseFastManimSandboxResourceLimitsV1(options.limits);
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = checkedPollInterval(options.pollIntervalMs);
    this.#profile = profile;
    this.#profileDigest = digestFastManimOciProfileV1(profile);
    this.#release = options.release;
    this.#resourceController = options.resourceController;
    this.#runtime = options.runtime;
    this.#seccomp = seccomp;
    this.#seccompDigest = createHash("sha256").update(canonicalJsonV1(seccomp), "utf8").digest("hex");
    this.#sleep =
      options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }).then(() => undefined));
  }

  dispatch(dispatch: FastManimOciBrokerDispatchV1): FastManimSandboxJobHandleV1 {
    if (!(dispatch instanceof FastManimOciBrokerDispatchV1)) {
      throw new TypeError("The production runc broker requires a verified dispatch.");
    }
    if (this.#cleanupFailed) throw new FastManimSandboxBackendControlError("cleanup");
    if (this.#closing) return { abort() {}, result: Promise.resolve(failureResult(dispatch, "sandbox-unavailable")) };
    dispatch.context.signal.throwIfAborted();
    const controller = new AbortController();
    const onContextAbort = () => controller.abort();
    dispatch.context.signal.addEventListener("abort", onContextAbort, { once: true });
    if (dispatch.context.signal.aborted) controller.abort();
    let active!: BrokerActiveJob;
    const result = this.#execute(dispatch, controller.signal).finally(() => {
      dispatch.context.signal.removeEventListener("abort", onContextAbort);
      this.#active.delete(active);
    });
    active = Object.freeze({ abort: () => controller.abort(), result });
    this.#active.add(active);
    return Object.freeze({ abort: active.abort, result });
  }

  async close() {
    this.#closing = true;
    const active = [...this.#active];
    for (const job of active) job.abort();
    await Promise.allSettled(active.map((job) => job.result));
    if (this.#cleanupFailed) throw new FastManimSandboxBackendControlError("cleanup");
  }

  async #execute(
    dispatch: FastManimOciBrokerDispatchV1,
    signal: AbortSignal,
  ): Promise<FastManimSandboxBackendResultV1> {
    let rootfsPath: string;
    try {
      rootfsPath = this.#release.resolveRootfsPath(dispatch);
      if (
        dispatch.descriptor.profileDigest !== this.#profileDigest ||
        dispatch.descriptor.seccompDigest !== this.#seccompDigest
      ) {
        return failureResult(dispatch, "sandbox-attestation-rejected");
      }
      const [canonicalRootfs, rootfsStatus] = await Promise.all([realpath(rootfsPath), lstat(rootfsPath)]);
      if (canonicalRootfs !== rootfsPath || !rootfsStatus.isDirectory() || rootfsStatus.isSymbolicLink()) {
        return failureResult(dispatch, "sandbox-attestation-rejected");
      }
    } catch {
      return failureResult(dispatch, "sandbox-attestation-rejected");
    }
    if (signal.aborted) throw abortError();

    const remainingMs = dispatch.context.deadlineEpochMs - this.#now();
    if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) return failureResult(dispatch, "producer-timeout");
    const limits = parseFastManimSandboxResourceLimitsV1({
      ...this.#limits,
      wallTimeMs: Math.min(this.#limits.wallTimeMs, remainingMs),
    });
    const io = createFastManimRuncBoundedIoV1({ limits, requestBytes: dispatch.copyRequestBytes() });
    const operationController = new AbortController();
    const inFlightControls = new Set<Promise<unknown>>();
    let bundle: FastManimRuncJobBundleV1 | null = null;
    let bundlePlan: FastManimRuncJobBundlePlanV1 | null = null;
    let cleanupFailure: unknown;
    let createProcess: FastManimRuncCreatedProcessV1 | null = null;
    let finalizing = false;
    let haltReason: FastManimSandboxResourceTerminationReasonV1 | null = null;
    let job: LinuxCgroupV2ResourceJobV1 | null = null;
    let runtimeCreationAttempted = false;
    let runtimeDeleted = false;
    let stopHalt!: (reason: FastManimRuncHaltV1) => void;
    const halted = new Promise<never>((_resolvePromise, rejectPromise) => {
      stopHalt = rejectPromise;
    });
    halted.catch(() => undefined);
    const halt = (reason: FastManimSandboxResourceTerminationReasonV1) => {
      if (haltReason !== null || finalizing) return;
      haltReason = reason;
      operationController.abort();
      createProcess?.terminateCreateClient();
      stopHalt(new FastManimRuncHaltV1(reason));
    };
    const onAbort = () => halt(this.#closing ? "shutdown" : "aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const deadlineTimer = setTimeout(() => halt("deadline"), Math.min(limits.wallTimeMs, remainingMs));
    deadlineTimer.unref();
    io.overflow.then(halt).catch(() => halt("cleanup-failed"));
    const gate = <T>(operation: Promise<T>) => Promise.race([operation, halted]);
    const control = async <T>(operation: Promise<T>) => {
      inFlightControls.add(operation);
      operation.then(
        () => inFlightControls.delete(operation),
        () => inFlightControls.delete(operation),
      );
      return gate(operation);
    };

    try {
      // Admission itself is not abortable. Always observe its settlement so a
      // late cgroup allocation can never escape cleanup after caller abort.
      job = await this.#resourceController.admit(limits, io.outputLifecycle);
      job.completion.then(
        (reason) => halt(reason),
        (error) => {
          cleanupFailure = error;
          halt("cleanup-failed");
        },
      );
      if (haltReason !== null) throw new FastManimRuncHaltV1(haltReason);
      bundlePlan = this.#bundleStore.plan(job.descriptor.cgroupName);
      const spec = new FastManimRuncOciSpecGeneratorV1({
        assetsSourcePath: bundlePlan.assetsPath,
        expectedSeccompDigest: dispatch.descriptor.seccompDigest,
        profile: this.#profile,
        rootfsPath,
        seccomp: this.#seccomp,
      }).generate(job.launch);
      bundle = await control(this.#bundleStore.stage({ dispatch, plan: bundlePlan, spec }));
      runtimeCreationAttempted = true;
      createProcess = this.#runtime.create({
        bundlePath: bundle.bundlePath,
        containerId: job.descriptor.cgroupName,
        deadlineEpochMs: dispatch.context.deadlineEpochMs,
      });
      io.bind({ stderr: createProcess.stderr, stdin: createProcess.stdin, stdout: createProcess.stdout });
      await gate(createProcess.created);
      const firstState = await control(
        this.#runtime.state(job.descriptor.cgroupName, dispatch.context.deadlineEpochMs, operationController.signal),
      );
      this.#assertCreatedState(firstState, bundle, job);
      await control(job.verifyDirectStart(firstState.pid));
      const secondState = await control(
        this.#runtime.state(job.descriptor.cgroupName, dispatch.context.deadlineEpochMs, operationController.signal),
      );
      this.#assertCreatedState(secondState, bundle, job, firstState.pid);
      const directStartProof = await control(job.verifyDirectStart(secondState.pid));
      await control(
        this.#runtime.start(job.descriptor.cgroupName, dispatch.context.deadlineEpochMs, operationController.signal),
      );
      await control(io.writeRequest());
      await gate(io.waitForOutput());
      await this.#waitForStopped(dispatch, bundle, job, secondState.pid, operationController.signal, control);
      const resultBytes = io.copyResultBytes();
      if (resultBytes.byteLength === 0) throw new Error("The runc producer returned no result bytes.");
      await this.#runtime.delete(job.descriptor.cgroupName, dispatch.context.deadlineEpochMs);
      runtimeDeleted = true;
      finalizing = true;
      await job.finish("completed", directStartProof);
      const completion = await job.completion;
      await this.#bundleStore.cleanup(bundle);
      bundle = null;
      bundlePlan = null;
      if (completion !== "completed") return failureResult(dispatch, failureCode(completion));
      return Object.freeze({
        attestationDigest: dispatch.context.attestationDigest,
        kind: "ok" as const,
        requestDigest: dispatch.descriptor.request.sha256,
        resultBytes,
      });
    } catch (error) {
      if (haltReason === null && error instanceof FastManimRuncHaltV1) haltReason = error.reason;
      const resourceError = fastManimSandboxResourceControlErrorCode(error);
      if (resourceError === "capacity") {
        cleanupFailure = cleanupFailure ?? (await this.#cleanupWithoutJob(io, bundlePlan));
        if (cleanupFailure) this.#latchCleanupFailure();
        if (cleanupFailure) throw new FastManimSandboxBackendControlError("cleanup");
        throw new FastManimSandboxBackendControlError("capacity");
      }
      operationController.abort();
      createProcess?.terminateCreateClient();
      const reason = haltReason ?? "launch-failed";
      finalizing = true;
      const resourceFinish = job
        ? job.finish(reason === "completed" ? "launch-failed" : reason)
        : io.outputLifecycle.close(reason);
      resourceFinish.catch(() => undefined);
      // cgroup.kill and pipe close begin above before waiting for any stuck
      // runc client. Never let a control-command timeout extend Python time.
      const ownedOperations = [...inFlightControls, ...(createProcess ? [createProcess.created] : [])];
      const ownershipJoined = await Promise.race([
        Promise.allSettled(ownedOperations).then(() => true),
        delay(30_000, false, { ref: false }),
      ]);
      if (!ownershipJoined) cleanupFailure ??= new Error("A terminated runc client could not be reaped.");
      if (ownershipJoined && runtimeCreationAttempted && !runtimeDeleted && job) {
        const cleanupDeadlineEpochMs = Date.now() + 30_000;
        await this.#runtime.kill(job.descriptor.cgroupName, cleanupDeadlineEpochMs).catch(() => undefined);
        try {
          await this.#runtime.delete(job.descriptor.cgroupName, cleanupDeadlineEpochMs);
          runtimeDeleted = true;
        } catch (cleanupError) {
          cleanupFailure ??= cleanupError;
        }
      }
      try {
        await resourceFinish;
      } catch (cleanupError) {
        cleanupFailure ??= cleanupError;
      }
      if (bundlePlan) {
        try {
          await this.#bundleStore.cleanup(bundle ?? bundlePlan);
        } catch (cleanupError) {
          cleanupFailure ??= cleanupError;
        }
      }
      if (cleanupFailure || resourceError === "cleanup") {
        this.#latchCleanupFailure();
        throw new FastManimSandboxBackendControlError("cleanup");
      }
      if (reason === "aborted" || reason === "shutdown") throw abortError();
      if (resultBytesFailure(error)) return failureResult(dispatch, "producer-exit");
      return failureResult(dispatch, failureCode(reason));
    } finally {
      finalizing = true;
      clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", onAbort);
      operationController.abort();
    }
  }

  async #waitForStopped(
    dispatch: FastManimOciBrokerDispatchV1,
    bundle: FastManimRuncJobBundleV1,
    job: LinuxCgroupV2ResourceJobV1,
    expectedPid: number,
    signal: AbortSignal,
    control: <T>(operation: Promise<T>) => Promise<T>,
  ) {
    while (true) {
      const state = await control(
        this.#runtime.state(job.descriptor.cgroupName, dispatch.context.deadlineEpochMs, signal),
      );
      if (state.bundle !== bundle.bundlePath || state.id !== job.descriptor.cgroupName) {
        throw new Error("The runc stopped state changed immutable job identity.");
      }
      if (state.status === "stopped") return;
      if (state.pid !== expectedPid) throw new Error("The running runc job changed its init process identity.");
      if (state.status !== "running") throw new Error("The runc job did not transition from created to running.");
      await control(this.#sleep(this.#pollIntervalMs, signal));
    }
  }

  #assertCreatedState(
    state: FastManimRuncStateV1,
    bundle: FastManimRuncJobBundleV1,
    job: LinuxCgroupV2ResourceJobV1,
    expectedPid?: number,
  ) {
    if (
      state.status !== "created" ||
      state.id !== job.descriptor.cgroupName ||
      state.bundle !== bundle.bundlePath ||
      (expectedPid !== undefined && state.pid !== expectedPid)
    ) {
      throw new Error("The runc created state did not match the admitted immutable job.");
    }
  }

  async #cleanupWithoutJob(
    io: ReturnType<typeof createFastManimRuncBoundedIoV1>,
    plan: FastManimRuncJobBundlePlanV1 | null,
  ) {
    let failure: unknown;
    try {
      await io.outputLifecycle.close("launch-failed");
    } catch (error) {
      failure = error;
    }
    if (plan) {
      try {
        await this.#bundleStore.cleanup(plan);
      } catch (error) {
        failure ??= error;
      }
    }
    return failure;
  }

  #latchCleanupFailure() {
    this.#cleanupFailed = true;
    for (const job of this.#active) job.abort();
  }
}

/** Unit-test seam only; production code cannot obtain the identity capability. */
export function createFastManimRuncJobBrokerForTestingV1(options: FastManimRuncJobBrokerOptionsV1) {
  if (process.env.NODE_ENV !== "test") {
    throw new TypeError("The runc test broker factory is unavailable outside the test runtime.");
  }
  return new FastManimRuncJobBrokerV1(options, testBrokerCapabilityV1);
}

function resultBytesFailure(error: unknown) {
  return error instanceof Error && error.message === "The runc producer returned no result bytes.";
}
