import { constants } from "node:fs";
import { mkdir, readdir, readFile, realpath, rmdir, statfs, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import {
  assertFastManimSandboxBoundedOutputMatchesLimitsV1,
  type FastManimSandboxBoundedOutputDescriptorV1,
  FastManimSandboxResourceControlError,
  type FastManimSandboxResourceJobDescriptorV1,
  type FastManimSandboxResourceLimitsV1,
  type FastManimSandboxResourceRegistrySnapshotV1,
  FastManimSandboxResourceRegistryV1,
  type FastManimSandboxResourceTerminationReasonV1,
  fastManimSandboxOutputClosedEvidenceV1Schema,
  fastManimSandboxResourceTerminationReasonV1Schema,
  isFastManimSandboxResourceCgroupNameV1,
  processFastManimSandboxResourceRegistryV1,
} from "./fast-manim-sandbox-resources";

const CGROUP2_SUPER_MAGIC = 0x63677270;
const CGROUP2_FILESYSTEM_ROOT = "/sys/fs/cgroup";
const DELEGATED_ROOT_NAME = "poietra-sandbox-v1";
const REQUIRED_CONTROLLERS = Object.freeze(["cpu", "memory", "pids"] as const);
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_CONTROL_OPERATION_TIMEOUT_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 10;
const MAX_CLEANUP_TIMEOUT_MS = 60_000;
const MAX_CONTROL_OPERATION_TIMEOUT_MS = 10_000;
const MAX_POLL_INTERVAL_MS = 1_000;

class CgroupOperationDeadlineError extends Error {}

function boundedTiming(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}ms.`);
  }
  return value;
}

function parseControllerSet(value: string) {
  return new Set(value.trim().split(/\s+/u).filter(Boolean));
}

function parseCounterFile(value: string, required: readonly string[]) {
  const counters = new Map<string, number>();
  for (const line of value.trim().split("\n")) {
    if (line.length === 0) continue;
    const match = /^([a-z][a-z0-9_]*) ([0-9]+)$/u.exec(line);
    if (!match || counters.has(match[1]!)) throw new FastManimSandboxResourceControlError("cleanup");
    const counter = Number(match[2]);
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new FastManimSandboxResourceControlError("cleanup");
    }
    counters.set(match[1]!, counter);
  }
  for (const name of required) {
    if (!counters.has(name)) throw new FastManimSandboxResourceControlError("cleanup");
  }
  return counters;
}

function counterDelta(current: Map<string, number>, baseline: Map<string, number>, name: string) {
  const currentValue = current.get(name)!;
  const baselineValue = baseline.get(name)!;
  if (currentValue < baselineValue) throw new FastManimSandboxResourceControlError("cleanup");
  return currentValue - baselineValue;
}

export interface LinuxCgroupV2StoreV1 {
  assertExclusiveCgroupV2Root(): Promise<void>;
  create(name: string): Promise<void>;
  listChildDirectories(): Promise<readonly string[]>;
  read(name: string, file: string): Promise<string>;
  readRoot(file: string): Promise<string>;
  remove(name: string): Promise<void>;
  write(name: string, file: string, value: string): Promise<void>;
  writeRoot(file: string, value: string): Promise<void>;
}

/** Filesystem adapter for one pre-created, exclusively delegated cgroup v2 subtree. */
export class FileSystemLinuxCgroupV2StoreV1 implements LinuxCgroupV2StoreV1 {
  readonly #root: string;

  constructor(root: string) {
    if (!isAbsolute(root) || basename(resolve(root)) !== DELEGATED_ROOT_NAME) {
      throw new TypeError(`The delegated cgroup root must be an absolute ${DELEGATED_ROOT_NAME} subtree.`);
    }
    this.#root = resolve(root);
  }

  async assertExclusiveCgroupV2Root() {
    const [canonical, filesystem, processes, type] = await Promise.all([
      realpath(this.#root),
      statfs(this.#root),
      readFile(this.#rootFile("cgroup.procs"), "utf8"),
      readFile(this.#rootFile("cgroup.type"), "utf8"),
    ]);
    if (
      canonical !== this.#root ||
      filesystem.type !== CGROUP2_SUPER_MAGIC ||
      processes.trim().length !== 0 ||
      type.trim() !== "domain"
    ) {
      throw new FastManimSandboxResourceControlError("configuration");
    }
  }

  async create(name: string) {
    await mkdir(this.#child(name), { mode: 0o700 });
  }

  async listChildDirectories() {
    const entries = await readdir(this.#root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  async read(name: string, file: string) {
    return readFile(this.#file(name, file), "utf8");
  }

  async readRoot(file: string) {
    return readFile(this.#rootFile(file), "utf8");
  }

  async remove(name: string) {
    await rmdir(this.#child(name));
  }

  async write(name: string, file: string, value: string) {
    await writeFile(this.#file(name, file), value, { encoding: "utf8", flag: constants.O_WRONLY });
  }

  async writeRoot(file: string, value: string) {
    await writeFile(this.#rootFile(file), value, { encoding: "utf8", flag: constants.O_WRONLY });
  }

  #child(name: string) {
    if (!isFastManimSandboxResourceCgroupNameV1(name)) {
      throw new FastManimSandboxResourceControlError("configuration");
    }
    return join(this.#root, name);
  }

  #file(name: string, file: string) {
    if (!CGROUP_JOB_FILES.has(file)) throw new FastManimSandboxResourceControlError("configuration");
    return join(this.#child(name), file);
  }

  #rootFile(file: string) {
    if (!CGROUP_ROOT_FILES.has(file)) throw new FastManimSandboxResourceControlError("configuration");
    return join(this.#root, file);
  }
}

const CGROUP_ROOT_FILES = new Set(["cgroup.controllers", "cgroup.procs", "cgroup.subtree_control", "cgroup.type"]);
const CGROUP_JOB_FILES = new Set([
  "cgroup.events",
  "cgroup.kill",
  "cgroup.procs",
  "cpu.max",
  "cpu.stat",
  "memory.events",
  "memory.max",
  "memory.oom.group",
  "memory.swap.max",
  "pids.events",
  "pids.max",
]);

export type FastManimSandboxBoundedOutputLifecycleV1 = Readonly<{
  /** Closes/destroys all producer pipes and bounded result storage. Must be idempotent. */
  close: (reason: FastManimSandboxResourceTerminationReasonV1) => Promise<void>;
  /** Closed cap contract installed before the job is admitted. */
  descriptor: FastManimSandboxBoundedOutputDescriptorV1;
  /** Server-owned proof that all three bounded writers can no longer produce bytes. */
  closureEvidence: () => unknown;
}>;

export type LinuxCgroupV2ResourceEvidenceV1 = Readonly<{
  cpuUsageMicros: number;
  memoryMaxEvents: number;
  memoryOomEvents: number;
  memoryOomKillEvents: number;
  pidsMaxEvents: number;
  reason: "cpu-limit" | "memory-limit" | "pids-limit" | null;
}>;

export type LinuxCgroupV2LaunchEnvelopeV1 = Readonly<{
  cgroupsPath: string;
  deadlineEpochMs: number;
  mustStartInCgroup: true;
  rlimits: Readonly<{
    cpuTimeSeconds: number;
    fileBytes: number;
    openFiles: number;
  }>;
  tmpfs: Readonly<{
    runtime: Readonly<{ maximumInodes: number; sizeBytes: number }>;
    sharedMemory: Readonly<{ maximumInodes: number; sizeBytes: number }>;
  }>;
}>;

export type LinuxCgroupV2ResourceJobV1 = Readonly<{
  /** Settles only after cgroup empty, bounded output close, and cgroup removal. */
  completion: Promise<FastManimSandboxResourceTerminationReasonV1>;
  /**
   * Local conformance only. The trusted harness must self-stop the wrapper
   * before calling this method. Production must use launch.cgroupsPath so the
   * orchestrator creates the process in the cgroup before untrusted code runs.
   */
  attachStoppedPidForLocalConformance: (
    pid: number,
    proof: Readonly<{ processState: "stopped"; trust: "local-conformance-only" }>,
  ) => Promise<void>;
  descriptor: FastManimSandboxResourceJobDescriptorV1;
  finish: (reason: FastManimSandboxResourceTerminationReasonV1) => Promise<void>;
  inspect: () => Promise<LinuxCgroupV2ResourceEvidenceV1>;
  launch: LinuxCgroupV2LaunchEnvelopeV1;
}>;

type ResourceBaseline = Readonly<{
  cpu: Map<string, number>;
  memory: Map<string, number>;
  pids: Map<string, number>;
}>;

type ActiveLinuxJob = {
  baseline: ResourceBaseline | null;
  completion: Promise<FastManimSandboxResourceTerminationReasonV1>;
  created: boolean;
  finishing: Promise<void> | null;
  lease: ReturnType<FastManimSandboxResourceRegistryV1["admit"]>;
  monotonicDeadline: number;
  output: FastManimSandboxBoundedOutputLifecycleV1;
  rejectCompletion: (reason: unknown) => void;
  resolveCompletion: (reason: FastManimSandboxResourceTerminationReasonV1) => void;
  setup: Promise<void>;
  watchdog: Promise<void> | null;
};

export type LinuxCgroupV2ResourceControllerOptionsV1 = Readonly<{
  cleanupTimeoutMs?: number;
  controlOperationTimeoutMs?: number;
  cgroupsPath: string;
  monotonicNow?: () => number;
  pollIntervalMs?: number;
  registry: FastManimSandboxResourceRegistryV1;
  root?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  store?: LinuxCgroupV2StoreV1;
}>;

const localAttachProofSchema = z
  .object({ processState: z.literal("stopped"), trust: z.literal("local-conformance-only") })
  .strict();

/**
 * cgroup v2 lifecycle owner for the outer #81 backend resource envelope.
 * One process-global registry must be injected. The root is a dedicated,
 * process-free delegated subtree; job labels never contain external identity.
 */
export class LinuxCgroupV2ResourceControllerV1 {
  readonly #cleanupTimeoutMs: number;
  readonly #controlOperationTimeoutMs: number;
  readonly #cgroupsPath: string;
  readonly #jobs = new Map<string, ActiveLinuxJob>();
  readonly #monotonicNow: () => number;
  readonly #pollIntervalMs: number;
  readonly #registry: FastManimSandboxResourceRegistryV1;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #store: LinuxCgroupV2StoreV1;
  #closing = false;
  #initializePromise: Promise<void> | null = null;
  #initialized = false;
  #reconciledOrphans = 0;

  constructor(options: LinuxCgroupV2ResourceControllerOptionsV1) {
    if ((options.store === undefined) === (options.root === undefined)) {
      throw new TypeError("Configure exactly one cgroup store or delegated cgroup root.");
    }
    if (!(options.registry instanceof FastManimSandboxResourceRegistryV1)) {
      throw new TypeError("A process-global sandbox resource registry is required.");
    }
    if (
      isAbsolute(options.cgroupsPath) ||
      options.cgroupsPath.split("/").at(-1) !== DELEGATED_ROOT_NAME ||
      !/^[A-Za-z0-9_.@:-]+(?:\/[A-Za-z0-9_.@:-]+)*$/u.test(options.cgroupsPath) ||
      Buffer.byteLength(options.cgroupsPath, "utf8") > 512
    ) {
      throw new TypeError(`The orchestrator cgroupsPath must identify a relative ${DELEGATED_ROOT_NAME} subtree.`);
    }
    this.#cleanupTimeoutMs = boundedTiming(
      options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      "Cgroup cleanup timeout",
      1,
      MAX_CLEANUP_TIMEOUT_MS,
    );
    this.#controlOperationTimeoutMs = boundedTiming(
      options.controlOperationTimeoutMs ?? DEFAULT_CONTROL_OPERATION_TIMEOUT_MS,
      "Cgroup control operation timeout",
      1,
      MAX_CONTROL_OPERATION_TIMEOUT_MS,
    );
    this.#pollIntervalMs = boundedTiming(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "Cgroup poll interval",
      1,
      MAX_POLL_INTERVAL_MS,
    );
    this.#cgroupsPath = options.cgroupsPath;
    this.#monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    this.#sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    this.#store = options.store ?? new FileSystemLinuxCgroupV2StoreV1(options.root!);
    this.#registry = options.registry;
  }

  initialize() {
    if (this.#initializePromise) return this.#initializePromise;
    this.#initializePromise = this.#initialize();
    return this.#initializePromise;
  }

  async #initialize() {
    const deadline = this.#cleanupDeadline();
    try {
      await this.#within(this.#store.assertExclusiveCgroupV2Root(), deadline);
      const available = parseControllerSet(await this.#within(this.#store.readRoot("cgroup.controllers"), deadline));
      if (REQUIRED_CONTROLLERS.some((controller) => !available.has(controller))) {
        throw new FastManimSandboxResourceControlError("configuration");
      }
      await this.#within(
        this.#store.writeRoot(
          "cgroup.subtree_control",
          `${REQUIRED_CONTROLLERS.map((controller) => `+${controller}`).join(" ")}\n`,
        ),
        deadline,
      );
      const enabled = parseControllerSet(await this.#within(this.#store.readRoot("cgroup.subtree_control"), deadline));
      if (REQUIRED_CONTROLLERS.some((controller) => !enabled.has(controller))) {
        throw new FastManimSandboxResourceControlError("configuration");
      }
      await this.#reconcileOrphans(deadline);
      this.#registry.markReconciled();
      this.#initialized = true;
    } catch {
      this.#registry.quarantine();
      throw new FastManimSandboxResourceControlError("cleanup");
    }
  }

  async #reconcileOrphans(deadline: number) {
    const children = [...(await this.#within(this.#store.listChildDirectories(), deadline))].sort();
    if (children.some((name) => !isFastManimSandboxResourceCgroupNameV1(name))) {
      throw new FastManimSandboxResourceControlError("cleanup");
    }
    for (const name of children) {
      await this.#within(this.#store.write(name, "cgroup.kill", "1\n"), deadline);
      await this.#waitUntilEmpty(name, deadline);
      await this.#within(this.#store.remove(name), deadline);
      this.#reconciledOrphans += 1;
    }
  }

  async admit(limits: unknown, output: FastManimSandboxBoundedOutputLifecycleV1): Promise<LinuxCgroupV2ResourceJobV1> {
    if (
      !this.#initialized ||
      this.#closing ||
      typeof output?.close !== "function" ||
      typeof output.closureEvidence !== "function"
    ) {
      throw new FastManimSandboxResourceControlError("unavailable");
    }
    assertFastManimSandboxBoundedOutputMatchesLimitsV1(output.descriptor, limits);
    const lease = this.#registry.admit(limits);
    const monotonicDeadline = this.#monotonicNow() + lease.descriptor.limits.wallTimeMs;
    if (!Number.isFinite(monotonicDeadline) || monotonicDeadline <= 0) {
      lease.failClosed();
      throw new FastManimSandboxResourceControlError("unavailable");
    }
    let resolveCompletion!: (reason: FastManimSandboxResourceTerminationReasonV1) => void;
    let rejectCompletion!: (reason: unknown) => void;
    const completion = new Promise<FastManimSandboxResourceTerminationReasonV1>((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });
    completion.catch(() => undefined);
    const active: ActiveLinuxJob = {
      baseline: null,
      completion,
      created: false,
      finishing: null,
      lease,
      monotonicDeadline,
      output,
      rejectCompletion,
      resolveCompletion,
      setup: Promise.resolve(),
      watchdog: null,
    };
    this.#jobs.set(lease.descriptor.jobId, active);
    active.setup = this.#prepare(active);
    try {
      await active.setup;
    } catch {
      throw new FastManimSandboxResourceControlError(
        this.#jobs.get(lease.descriptor.jobId) === active ? "cleanup" : "unavailable",
      );
    }
    if (this.#closing || active.finishing) {
      await this.#finish(active, "shutdown");
      throw new FastManimSandboxResourceControlError("unavailable");
    }
    active.watchdog = this.#watchdog(active);
    active.watchdog.catch(() => undefined);
    return Object.freeze({
      attachStoppedPidForLocalConformance: (pid, proof) => this.#attachStopped(active, pid, proof),
      completion,
      descriptor: lease.descriptor,
      finish: (reason) => this.#finish(active, reason),
      inspect: () => this.#inspect(active),
      launch: this.#launchEnvelope(lease.descriptor),
    });
  }

  async #prepare(active: ActiveLinuxJob) {
    const name = active.lease.descriptor.cgroupName;
    const deadline = this.#controlDeadline(active.monotonicDeadline);
    let timedOut = false;
    try {
      await this.#within(this.#store.create(name), deadline);
      active.created = true;
      await this.#configure(name, active.lease.descriptor.limits, deadline);
      active.baseline = Object.freeze({
        cpu: await this.#readCounters(name, "cpu.stat", ["usage_usec"], deadline),
        memory: await this.#readCounters(name, "memory.events", ["max", "oom", "oom_kill"], deadline),
        pids: await this.#readCounters(name, "pids.events", ["max"], deadline),
      });
    } catch (error) {
      timedOut = error instanceof CgroupOperationDeadlineError;
      active.lease.terminate("launch-failed");
      const cleaned = await this.#cleanup(active, "launch-failed", this.#cleanupDeadline());
      if (cleaned && !timedOut) this.#reap(active);
      else this.#failClosed(active);
      active.rejectCompletion(
        new FastManimSandboxResourceControlError(cleaned && !timedOut ? "unavailable" : "cleanup"),
      );
      throw new FastManimSandboxResourceControlError(cleaned && !timedOut ? "unavailable" : "cleanup");
    }
  }

  async #configure(name: string, limits: FastManimSandboxResourceLimitsV1, deadline: number) {
    await this.#within(this.#store.write(name, "memory.oom.group", "1\n"), deadline);
    await this.#within(this.#store.write(name, "memory.max", `${limits.maxMemoryBytes}\n`), deadline);
    await this.#within(this.#store.write(name, "memory.swap.max", `${limits.maxSwapBytes}\n`), deadline);
    await this.#within(this.#store.write(name, "pids.max", `${limits.maxProcesses}\n`), deadline);
    await this.#within(
      this.#store.write(name, "cpu.max", `${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}\n`),
      deadline,
    );
  }

  #launchEnvelope(descriptor: FastManimSandboxResourceJobDescriptorV1): LinuxCgroupV2LaunchEnvelopeV1 {
    const limits = descriptor.limits;
    return Object.freeze({
      cgroupsPath: `${this.#cgroupsPath}/${descriptor.cgroupName}`,
      deadlineEpochMs: descriptor.deadlineEpochMs,
      mustStartInCgroup: true,
      rlimits: Object.freeze({
        cpuTimeSeconds: Math.ceil(limits.maxCpuTimeMicros / 1_000_000),
        fileBytes: limits.maxFileBytes,
        openFiles: limits.maxOpenFiles,
      }),
      tmpfs: Object.freeze({
        runtime: Object.freeze({
          maximumInodes: limits.maxRuntimeTmpfsInodes,
          sizeBytes: limits.maxRuntimeTmpfsBytes,
        }),
        sharedMemory: Object.freeze({
          maximumInodes: limits.maxSharedMemoryInodes,
          sizeBytes: limits.maxSharedMemoryBytes,
        }),
      }),
    });
  }

  async #attachStopped(active: ActiveLinuxJob, pid: number, proof: unknown) {
    localAttachProofSchema.parse(proof);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("A cgroup PID must be a positive safe integer.");
    if (active.finishing || this.#jobs.get(active.lease.descriptor.jobId) !== active) {
      throw new FastManimSandboxResourceControlError("unavailable");
    }
    try {
      await this.#within(
        this.#store.write(active.lease.descriptor.cgroupName, "cgroup.procs", `${pid}\n`),
        this.#controlDeadline(active.monotonicDeadline),
      );
    } catch {
      await this.#finish(active, "cleanup-failed").catch(() => undefined);
      this.#registry.quarantine();
      throw new FastManimSandboxResourceControlError("cleanup");
    }
  }

  async #inspect(active: ActiveLinuxJob): Promise<LinuxCgroupV2ResourceEvidenceV1> {
    if (this.#jobs.get(active.lease.descriptor.jobId) !== active || !active.baseline) {
      throw new FastManimSandboxResourceControlError("unavailable");
    }
    try {
      return await this.#inspectWithin(active, this.#controlDeadline(active.monotonicDeadline));
    } catch {
      await this.#finish(active, "cleanup-failed").catch(() => undefined);
      this.#registry.quarantine();
      throw new FastManimSandboxResourceControlError("cleanup");
    }
  }

  async #inspectWithin(active: ActiveLinuxJob, deadline: number): Promise<LinuxCgroupV2ResourceEvidenceV1> {
    const baseline = active.baseline;
    if (!baseline) throw new FastManimSandboxResourceControlError("cleanup");
    const name = active.lease.descriptor.cgroupName;
    const [cpu, memory, pids] = await Promise.all([
      this.#readCounters(name, "cpu.stat", ["usage_usec"], deadline),
      this.#readCounters(name, "memory.events", ["max", "oom", "oom_kill"], deadline),
      this.#readCounters(name, "pids.events", ["max"], deadline),
    ]);
    const cpuUsageMicros = counterDelta(cpu, baseline.cpu, "usage_usec");
    const memoryMaxEvents = counterDelta(memory, baseline.memory, "max");
    const memoryOomEvents = counterDelta(memory, baseline.memory, "oom");
    const memoryOomKillEvents = counterDelta(memory, baseline.memory, "oom_kill");
    const pidsMaxEvents = counterDelta(pids, baseline.pids, "max");
    const reason =
      memoryMaxEvents > 0 || memoryOomEvents > 0 || memoryOomKillEvents > 0
        ? "memory-limit"
        : pidsMaxEvents > 0
          ? "pids-limit"
          : cpuUsageMicros >= active.lease.descriptor.limits.maxCpuTimeMicros
            ? "cpu-limit"
            : null;
    return Object.freeze({
      cpuUsageMicros,
      memoryMaxEvents,
      memoryOomEvents,
      memoryOomKillEvents,
      pidsMaxEvents,
      reason,
    });
  }

  async #watchdog(active: ActiveLinuxJob) {
    while (!active.finishing && this.#jobs.get(active.lease.descriptor.jobId) === active) {
      const remaining = active.monotonicDeadline - this.#monotonicNow();
      if (remaining <= 0) {
        await this.#finish(active, "deadline");
        return;
      }
      try {
        const evidence = await this.#inspectWithin(active, this.#controlDeadline(active.monotonicDeadline));
        if (evidence.reason) {
          await this.#finish(active, evidence.reason);
          return;
        }
      } catch {
        await this.#finish(active, "cleanup-failed").catch(() => undefined);
        this.#registry.quarantine();
        return;
      }
      await this.#sleep(Math.min(this.#pollIntervalMs, remaining));
    }
  }

  #finish(active: ActiveLinuxJob, reason: FastManimSandboxResourceTerminationReasonV1) {
    if (active.finishing) return active.finishing;
    const parsedReason = fastManimSandboxResourceTerminationReasonV1Schema.parse(reason);
    if (this.#jobs.get(active.lease.descriptor.jobId) !== active) return active.completion.then(() => undefined);
    active.lease.terminate(parsedReason);
    active.finishing = this.#finishOnce(active, parsedReason);
    active.finishing.then(() => active.resolveCompletion(parsedReason), active.rejectCompletion);
    return active.finishing;
  }

  async #finishOnce(active: ActiveLinuxJob, reason: FastManimSandboxResourceTerminationReasonV1) {
    const deadline = this.#cleanupDeadline();
    try {
      await this.#within(active.setup, deadline);
    } catch {
      if (this.#jobs.get(active.lease.descriptor.jobId) !== active) return;
      this.#failClosed(active);
      throw new FastManimSandboxResourceControlError("cleanup");
    }
    if (!(await this.#cleanup(active, reason, deadline))) {
      this.#failClosed(active);
      throw new FastManimSandboxResourceControlError("cleanup");
    }
    this.#reap(active);
  }

  async #cleanup(active: ActiveLinuxJob, reason: FastManimSandboxResourceTerminationReasonV1, deadline: number) {
    try {
      if (active.created) {
        // cgroup.kill is the first termination operation. It reaches forked,
        // setsid, daemonized, and inherited-pipe descendants recursively.
        await this.#within(this.#store.write(active.lease.descriptor.cgroupName, "cgroup.kill", "1\n"), deadline);
      }
      await this.#within(active.output.close(reason), deadline);
      if (active.created) {
        await this.#waitUntilEmpty(active.lease.descriptor.cgroupName, deadline);
        await this.#within(this.#store.remove(active.lease.descriptor.cgroupName), deadline);
        active.created = false;
      }
      fastManimSandboxOutputClosedEvidenceV1Schema.parse(active.output.closureEvidence());
      return true;
    } catch {
      return false;
    }
  }

  #reap(active: ActiveLinuxJob) {
    active.lease.reap({ cgroupEmpty: true, outputClosed: true });
    this.#jobs.delete(active.lease.descriptor.jobId);
  }

  #failClosed(active: ActiveLinuxJob) {
    active.lease.failClosed();
    this.#registry.quarantine();
  }

  async #readCounters(name: string, file: string, required: readonly string[], deadline: number) {
    return parseCounterFile(await this.#within(this.#store.read(name, file), deadline), required);
  }

  async #isEmpty(name: string, deadline: number) {
    const events = parseCounterFile(await this.#within(this.#store.read(name, "cgroup.events"), deadline), [
      "populated",
    ]);
    return events.get("populated") === 0;
  }

  async #waitUntilEmpty(name: string, deadline: number) {
    while (!(await this.#isEmpty(name, deadline))) {
      const remaining = deadline - this.#monotonicNow();
      if (remaining <= 0) throw new CgroupOperationDeadlineError();
      await this.#within(this.#sleep(Math.min(this.#pollIntervalMs, remaining)), deadline);
    }
  }

  #cleanupDeadline() {
    const deadline = this.#monotonicNow() + this.#cleanupTimeoutMs;
    if (!Number.isFinite(deadline) || deadline <= 0) {
      throw new FastManimSandboxResourceControlError("cleanup");
    }
    return deadline;
  }

  #controlDeadline(jobDeadline: number) {
    const operationDeadline = this.#monotonicNow() + this.#controlOperationTimeoutMs;
    if (!Number.isFinite(operationDeadline)) throw new FastManimSandboxResourceControlError("cleanup");
    return Math.min(jobDeadline, operationDeadline);
  }

  async #within<T>(operation: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - this.#monotonicNow();
    if (remaining <= 0) {
      operation.catch(() => undefined);
      throw new CgroupOperationDeadlineError();
    }
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CgroupOperationDeadlineError()), remaining);
    });
    operation.catch(() => undefined);
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async shutdown() {
    this.#closing = true;
    this.#registry.beginClose();
    const results = await Promise.allSettled(
      [...this.#jobs.values()].map((active) => this.#finish(active, "shutdown")),
    );
    if (results.some((result) => result.status === "rejected")) {
      this.#registry.quarantine();
      throw new FastManimSandboxResourceControlError("cleanup");
    }
    this.#registry.finishClose();
  }

  snapshot(): FastManimSandboxResourceRegistrySnapshotV1 & Readonly<{ reconciledOrphans: number }> {
    return Object.freeze({ ...this.#registry.snapshot(), reconciledOrphans: this.#reconciledOrphans });
  }
}

/** Production factory: every controller shares one process-global admission ledger. */
let processLinuxCgroupV2ResourceControllerV1: LinuxCgroupV2ResourceControllerV1 | null = null;

const processLinuxCgroupV2ResourceControllerOptionsV1Schema = z
  .object({
    cleanupTimeoutMs: z.number().optional(),
    controlOperationTimeoutMs: z.number().optional(),
    pollIntervalMs: z.number().optional(),
    root: z.string(),
  })
  .strict();

export type ProcessLinuxCgroupV2ResourceControllerOptionsV1 = Readonly<
  z.infer<typeof processLinuxCgroupV2ResourceControllerOptionsV1Schema>
>;

/** Derives the orchestrator-visible cgroup path without exposing a host filesystem path. */
export function deriveLinuxCgroupV2OrchestratorPathV1(root: string) {
  if (!isAbsolute(root)) throw new TypeError("The production cgroup root must be absolute.");
  const resolvedRoot = resolve(root);
  const prefix = `${CGROUP2_FILESYSTEM_ROOT}${sep}`;
  if (!resolvedRoot.startsWith(prefix) || basename(resolvedRoot) !== DELEGATED_ROOT_NAME) {
    throw new TypeError(`The production root must be a ${DELEGATED_ROOT_NAME} subtree under cgroup v2.`);
  }
  const cgroupsPath = relative(CGROUP2_FILESYSTEM_ROOT, resolvedRoot).split(sep).join("/");
  if (cgroupsPath.startsWith("../") || cgroupsPath.length === 0) {
    throw new TypeError("The production cgroup root is outside cgroup v2.");
  }
  return cgroupsPath;
}

export function createProcessLinuxCgroupV2ResourceControllerV1(
  options: ProcessLinuxCgroupV2ResourceControllerOptionsV1,
) {
  if (processLinuxCgroupV2ResourceControllerV1) {
    throw new FastManimSandboxResourceControlError("unavailable");
  }
  const parsed = processLinuxCgroupV2ResourceControllerOptionsV1Schema.parse(options);
  processLinuxCgroupV2ResourceControllerV1 = new LinuxCgroupV2ResourceControllerV1({
    cleanupTimeoutMs: parsed.cleanupTimeoutMs,
    controlOperationTimeoutMs: parsed.controlOperationTimeoutMs,
    cgroupsPath: deriveLinuxCgroupV2OrchestratorPathV1(parsed.root),
    pollIntervalMs: parsed.pollIntervalMs,
    registry: processFastManimSandboxResourceRegistryV1,
    root: parsed.root,
  });
  return processLinuxCgroupV2ResourceControllerV1;
}
