import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import {
  createProcessLinuxCgroupV2ResourceControllerV1,
  deriveLinuxCgroupV2OrchestratorPathV1,
  FileSystemLinuxCgroupV2StoreV1,
  type LinuxCgroupV2ProcessMembershipReaderV1,
  LinuxCgroupV2ResourceControllerV1,
  type LinuxCgroupV2StoreV1,
} from "./fast-manim-linux-cgroup-v2";
import {
  DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
  FastManimSandboxResourceControlError,
  FastManimSandboxResourceRegistryV1,
} from "./fast-manim-sandbox-resources";

type FakeJob = { files: Map<string, string> };

class FakeCgroupV2Store implements LinuxCgroupV2StoreV1 {
  readonly jobs = new Map<string, FakeJob>();
  readonly writes: Array<readonly [string, string, string]> = [];
  controllers = "cpu io memory pids\n";
  subtreeControl = "";
  createGate: Promise<void> | null = null;
  createStarted: (() => void) | null = null;
  killLeavesPopulated = false;
  onKill: ((job: FakeJob) => void) | null = null;
  readGate: Readonly<{
    file: string;
    markStarted: () => void;
    wait: Promise<void>;
  }> | null = null;
  rejectKill = false;
  rejectRootProbe = false;
  rejectWriteFile: string | null = null;

  async assertExclusiveCgroupV2Root() {
    if (this.rejectRootProbe) throw new Error("delegated root drift");
  }

  async create(name: string) {
    this.createStarted?.();
    if (this.createGate) await this.createGate;
    if (this.jobs.has(name)) throw new Error("exists");
    this.jobs.set(name, this.newJob());
  }

  async listChildDirectories() {
    return [...this.jobs.keys()];
  }

  async read(name: string, file: string) {
    const gate = this.readGate;
    if (gate?.file === file) {
      this.readGate = null;
      gate.markStarted();
      await gate.wait;
    }
    const value = this.jobs.get(name)?.files.get(file);
    if (value === undefined) throw new Error("missing cgroup file");
    return value;
  }

  async readRoot(file: string) {
    if (file === "cgroup.controllers") return this.controllers;
    if (file === "cgroup.subtree_control") return this.subtreeControl;
    throw new Error("missing root file");
  }

  async remove(name: string) {
    const job = this.jobs.get(name);
    if (!job || !job.files.get("cgroup.events")?.includes("populated 0")) throw new Error("busy");
    this.jobs.delete(name);
  }

  async write(name: string, file: string, value: string) {
    this.writes.push([name, file, value]);
    if (file === this.rejectWriteFile) throw new Error("write denied");
    const job = this.jobs.get(name);
    if (!job) throw new Error("missing job");
    if (file === "cgroup.kill") {
      if (this.rejectKill) throw new Error("kill denied");
      if (this.killLeavesPopulated) return;
      this.onKill?.(job);
      job.files.set("cgroup.events", "populated 0\nfrozen 0\n");
      job.files.set("cgroup.procs", "");
      return;
    }
    if (file === "cgroup.procs") job.files.set("cgroup.events", "populated 1\nfrozen 0\n");
    job.files.set(file, value);
  }

  async writeRoot(file: string, value: string) {
    if (file !== "cgroup.subtree_control") throw new Error("missing root file");
    this.subtreeControl = value.replaceAll("+", "");
  }

  addOrphan(name: string, populated = true) {
    const job = this.newJob();
    if (populated) job.files.set("cgroup.events", "populated 1\nfrozen 0\n");
    this.jobs.set(name, job);
  }

  set(name: string, file: string, value: string) {
    const job = this.jobs.get(name);
    if (!job) throw new Error("missing job");
    job.files.set(file, value);
  }

  gateNextRead(file: string) {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      markStarted = resolvePromise;
    });
    const wait = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.readGate = { file, markStarted, wait };
    return { release, started };
  }

  private newJob(): FakeJob {
    return {
      files: new Map([
        ["cgroup.events", "populated 0\nfrozen 0\n"],
        ["cgroup.procs", ""],
        ["cpu.stat", "usage_usec 0\nuser_usec 0\nsystem_usec 0\n"],
        ["memory.events", "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n"],
        ["pids.events", "max 0\n"],
      ]),
    };
  }
}

function processStat(pid: number, startTime: string) {
  return `${pid} (poietra sandbox) ${["R", ...Array.from({ length: 18 }, () => "0"), startTime].join(" ")}\n`;
}

class FakeProcessMembershipReader implements LinuxCgroupV2ProcessMembershipReaderV1 {
  cgroup = "";
  stats: string[] = [];

  async readCgroup() {
    return this.cgroup;
  }

  async readStat(pid: number) {
    return this.stats.shift() ?? processStat(pid, "12345");
  }
}

function outputLifecycle(limits = DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1) {
  let closed = false;
  return {
    output: {
      async close() {
        closed = true;
      },
      closureEvidence: () =>
        closed
          ? {
              resultClosed: true,
              schema: "poietra.fast-manim-sandbox-output-closed" as const,
              stderrClosed: true,
              stdoutClosed: true,
              version: 1 as const,
            }
          : null,
      descriptor: {
        maxResultBytes: limits.maxResultBytes,
        maxStderrBytes: limits.maxStderrBytes,
        maxStdoutBytes: limits.maxStdoutBytes,
        schema: "poietra.fast-manim-sandbox-bounded-output" as const,
        version: 1 as const,
      },
    },
    isClosed: () => closed,
  };
}

function registry(maxActiveJobs = 4, now: () => number = () => 1_700_000_000_000) {
  return new FastManimSandboxResourceRegistryV1({
    maxActiveJobs,
    maxReservedMemoryBytes: 4 * 1024 * 1024 * 1024,
    maxReservedOutputBytes: 64 * 1024 * 1024,
    maxReservedTmpfsBytes: 1024 * 1024 * 1024,
    now,
    requireReconciliation: true,
  });
}

function controller(
  store: FakeCgroupV2Store,
  options: Partial<ConstructorParameters<typeof LinuxCgroupV2ResourceControllerV1>[0]> = {},
) {
  const monotonicNow = options.monotonicNow ?? (() => 1_000);
  return new LinuxCgroupV2ResourceControllerV1({
    ...options,
    cgroupsPath: options.cgroupsPath ?? "poietra-sandbox-v1",
    monotonicNow,
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
    registry: options.registry ?? registry(),
    store,
  });
}

describe("Linux cgroup v2 sandbox resource controller", () => {
  it("refuses broad or ambiguously named cgroup roots before filesystem mutation", () => {
    expect(() => new FileSystemLinuxCgroupV2StoreV1("/sys/fs/cgroup")).toThrow(/poietra-sandbox-v1/i);
    expect(() => new FileSystemLinuxCgroupV2StoreV1("relative/poietra-sandbox-v1")).toThrow(/absolute/i);
    expect(() => new FileSystemLinuxCgroupV2StoreV1("/tmp/poietra-sandbox-v1")).not.toThrow();
    expect(
      deriveLinuxCgroupV2OrchestratorPathV1("/sys/fs/cgroup/system.slice/poietra-studio.service/poietra-sandbox-v1"),
    ).toBe("system.slice/poietra-studio.service/poietra-sandbox-v1");
    expect(() => deriveLinuxCgroupV2OrchestratorPathV1("/tmp/poietra-sandbox-v1")).toThrow(/cgroup v2/i);
    for (const cgroupsPath of ["../poietra-sandbox-v1", "system.slice/../poietra-sandbox-v1", "./poietra-sandbox-v1"]) {
      expect(() => controller(new FakeCgroupV2Store(), { cgroupsPath })).toThrow(/relative/i);
    }
    expect(() =>
      deriveLinuxCgroupV2OrchestratorPathV1(
        "/sys/fs/cgroup/system.slice/../system.slice/poietra-studio.service/poietra-sandbox-v1",
      ),
    ).toThrow(/canonical/i);
    expect(() =>
      createProcessLinuxCgroupV2ResourceControllerV1({
        monotonicNow: () => 0,
        root: "/tmp/poietra-sandbox-v1",
        store: new FakeCgroupV2Store(),
      } as never),
    ).toThrow();
    const production = createProcessLinuxCgroupV2ResourceControllerV1({
      root: "/sys/fs/cgroup/system.slice/poietra-studio.service/poietra-sandbox-v1",
    });
    expect(production).not.toHaveProperty("admitForLocalConformance");
  });

  it("reconciles owned orphans before admission and writes every cgroup hard limit", async () => {
    const store = new FakeCgroupV2Store();
    store.addOrphan(`poietra-job-v1-${"a".repeat(32)}-1`);
    const resources = controller(store);
    await resources.initialize();
    expect(resources.snapshot()).toMatchObject({ reconciledOrphans: 1, state: "ready" });
    expect(store.jobs.size).toBe(0);

    const output = outputLifecycle();
    const job = await resources.admitForLocalConformance(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    const configured = store.jobs.get(job.descriptor.cgroupName)?.files;
    expect(configured?.get("memory.oom.group")).toBe("1\n");
    expect(configured?.get("memory.max")).toBe(`${job.descriptor.limits.maxMemoryBytes}\n`);
    expect(configured?.get("memory.swap.max")).toBe("0\n");
    expect(configured?.get("pids.max")).toBe(`${job.descriptor.limits.maxProcesses}\n`);
    expect(configured?.get("cpu.max")).toBe(
      `${job.descriptor.limits.cpuQuotaMicros} ${job.descriptor.limits.cpuPeriodMicros}\n`,
    );
    expect(job.launch).toMatchObject({
      cgroupsPath: `poietra-sandbox-v1/${job.descriptor.cgroupName}`,
      mustStartInCgroup: true,
      rlimits: {
        fileBytes: job.descriptor.limits.maxFileBytes,
        openFiles: job.descriptor.limits.maxOpenFiles,
      },
      tmpfs: {
        runtime: { maximumInodes: 4096, sizeBytes: 16 * 1024 * 1024 },
        sharedMemory: { maximumInodes: 1024, sizeBytes: 4 * 1024 * 1024 },
      },
    });
    await job.finish("completed");
    expect(output.isClosed()).toBe(true);
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, reapedJobs: 1 });
  });

  it("checks delegated-root and controller drift without mutating cgroup state", async () => {
    const store = new FakeCgroupV2Store();
    const resources = controller(store);
    const signal = new AbortController().signal;
    await expect(resources.assertReady(signal)).rejects.toThrow(/unavailable/i);

    await resources.initialize();
    const writesAfterInitialize = [...store.writes];
    await expect(resources.assertReady(signal)).resolves.toBeUndefined();
    expect(store.writes).toEqual(writesAfterInitialize);

    store.controllers = "cpu memory\n";
    await expect(resources.assertReady(signal)).rejects.toThrow(/unavailable/i);
    store.controllers = "cpu io memory pids\n";
    store.subtreeControl = "cpu memory\n";
    await expect(resources.assertReady(signal)).rejects.toThrow(/unavailable/i);
    store.subtreeControl = "cpu memory pids\n";
    store.rejectRootProbe = true;
    await expect(resources.assertReady(signal)).rejects.toThrow(/unavailable/i);

    const aborted = new AbortController();
    aborted.abort();
    await expect(resources.assertReady(aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps local stopped-PID attachment out of production and rejects unproved success", async () => {
    const store = new FakeCgroupV2Store();
    const resources = controller(store, { sleep: async () => new Promise<void>(() => undefined) });
    await resources.initialize();
    const output = outputLifecycle();
    const job = await resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    expect(job).not.toHaveProperty("attachStoppedPidForLocalConformance");
    expect(job.launch.productionMembership).toEqual({ state: "requires-direct-start-verification" });
    await (job.finish as (reason: string) => Promise<void>)("completed");
    await expect(job.completion).resolves.toBe("launch-failed");
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, state: "ready" });

    const localOutput = outputLifecycle();
    const local = await resources.admitForLocalConformance(
      DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
      localOutput.output,
    );
    await expect(local.attachStoppedPidForLocalConformance(process.pid)).rejects.toThrow(/unavailable/i);
    await expect(local.completion).resolves.toBe("launch-failed");
  });

  it("accepts completed only with exact stable direct-start membership and never moves the PID", async () => {
    const pid = 321;
    const store = new FakeCgroupV2Store();
    const membership = new FakeProcessMembershipReader();
    const resources = controller(store, {
      processMembershipReader: membership,
      sleep: async () => new Promise<void>(() => undefined),
    });
    await resources.initialize();
    const output = outputLifecycle();
    const job = await resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    membership.cgroup = `0::/${job.launch.cgroupsPath}\n`;
    membership.stats = [processStat(pid, "987654"), processStat(pid, "987654")];
    store.set(job.descriptor.cgroupName, "cgroup.procs", `${pid}\n`);

    const proof = await job.verifyDirectStart(pid);
    expect(store.writes.some(([, file]) => file === "cgroup.procs")).toBe(false);
    await job.finish("completed", proof);

    await expect(job.completion).resolves.toBe("completed");
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, reapedJobs: 1, state: "ready" });
  });

  it.each([
    {
      name: "a different unified cgroup path",
      prepare(store: FakeCgroupV2Store, membership: FakeProcessMembershipReader, pid: number, cgroupName: string) {
        membership.cgroup = "0::/poietra-sandbox-v1/different-job\n";
        store.set(cgroupName, "cgroup.procs", `${pid}\n`);
      },
    },
    {
      name: "another PID in the job cgroup",
      prepare(store: FakeCgroupV2Store, membership: FakeProcessMembershipReader, pid: number, cgroupName: string) {
        membership.cgroup = `0::/poietra-sandbox-v1/${cgroupName}\n`;
        store.set(cgroupName, "cgroup.procs", `${pid}\n999\n`);
      },
    },
    {
      name: "a reused PID with a changed start time",
      prepare(store: FakeCgroupV2Store, membership: FakeProcessMembershipReader, pid: number, cgroupName: string) {
        membership.cgroup = `0::/poietra-sandbox-v1/${cgroupName}\n`;
        membership.stats = [processStat(pid, "12345"), processStat(pid, "12346")];
        store.set(cgroupName, "cgroup.procs", `${pid}\n`);
      },
    },
  ])("fails the job when direct-start evidence reports $name", async ({ prepare }) => {
    const pid = 654;
    const store = new FakeCgroupV2Store();
    const membership = new FakeProcessMembershipReader();
    const resources = controller(store, {
      processMembershipReader: membership,
      sleep: async () => new Promise<void>(() => undefined),
    });
    await resources.initialize();
    const output = outputLifecycle();
    const job = await resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    prepare(store, membership, pid, job.descriptor.cgroupName);

    await expect(job.verifyDirectStart(pid)).rejects.toThrow(/unavailable/i);
    await expect(job.completion).resolves.toBe("launch-failed");
    expect(store.writes.some(([, file]) => file === "cgroup.procs")).toBe(false);
  });

  it("binds opaque direct-start proof to one job and rejects forged or cross-job proof", async () => {
    const store = new FakeCgroupV2Store();
    const membership = new FakeProcessMembershipReader();
    const resources = controller(store, {
      processMembershipReader: membership,
      sleep: async () => new Promise<void>(() => undefined),
    });
    await resources.initialize();
    const first = await resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, outputLifecycle().output);
    const second = await resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, outputLifecycle().output);
    membership.cgroup = `0::/${first.launch.cgroupsPath}\n`;
    store.set(first.descriptor.cgroupName, "cgroup.procs", "777\n");
    const firstProof = await first.verifyDirectStart(777);

    await (second.finish as (reason: string, proof: unknown) => Promise<void>)("completed", firstProof);
    await expect(second.completion).resolves.toBe("launch-failed");
    await (first.finish as (reason: string, proof: unknown) => Promise<void>)("completed", Object.freeze({}));
    await expect(first.completion).resolves.toBe("launch-failed");
  });

  it("uses baseline deltas for OOM, pids, and cumulative CPU-time reasons", async () => {
    const store = new FakeCgroupV2Store();
    const resources = controller(store);
    await resources.initialize();
    const output = outputLifecycle();
    const job = await resources.admit(
      { ...DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, maxCpuTimeMicros: 1_000 },
      output.output,
    );
    store.set(job.descriptor.cgroupName, "cpu.stat", "usage_usec 999\n");
    expect(await job.inspect()).toMatchObject({ cpuUsageMicros: 999, reason: null });
    store.set(job.descriptor.cgroupName, "cpu.stat", "usage_usec 1000\n");
    expect(await job.inspect()).toMatchObject({ reason: "cpu-limit" });
    store.set(job.descriptor.cgroupName, "pids.events", "max 1\n");
    expect(await job.inspect()).toMatchObject({ reason: "pids-limit" });
    store.set(job.descriptor.cgroupName, "memory.events", "max 1\noom 1\noom_kill 1\n");
    expect(await job.inspect()).toMatchObject({
      memoryMaxEvents: 1,
      memoryOomEvents: 1,
      memoryOomKillEvents: 1,
      reason: "memory-limit",
    });
    await job.finish("memory-limit");
  });

  it("does not accept leader completion while a descendant keeps the cgroup populated", async () => {
    const store = new FakeCgroupV2Store();
    const resources = controller(store);
    await resources.initialize();
    const output = outputLifecycle();
    const job = await resources.admitForLocalConformance(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    store.set(job.descriptor.cgroupName, "cgroup.events", "populated 1\nfrozen 0\n");
    expect(resources.snapshot().activeJobs).toBe(1);
    await job.finish("completed");
    expect(store.writes).toContainEqual([job.descriptor.cgroupName, "cgroup.kill", "1\n"]);
    expect(store.jobs.has(job.descriptor.cgroupName)).toBe(false);
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, reapedJobs: 1 });

    const writesAfterReap = store.writes.length;
    await job.finish("shutdown");
    expect(store.writes).toHaveLength(writesAfterReap);
  });

  it("keeps reservations and quarantines admission when kill/empty cleanup is uncertain", async () => {
    const store = new FakeCgroupV2Store();
    const resources = controller(store);
    await resources.initialize();
    const output = outputLifecycle();
    const job = await resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    store.set(job.descriptor.cgroupName, "cgroup.events", "populated 1\nfrozen 0\n");
    store.rejectKill = true;
    await expect(job.finish("aborted")).rejects.toThrowError(FastManimSandboxResourceControlError);
    expect(resources.snapshot()).toMatchObject({
      activeJobs: 1,
      reapedJobs: 0,
      state: "quarantined",
      terminated: [{ count: 1, reason: "cleanup-failed" }],
    });
    await expect(
      resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, outputLifecycle().output),
    ).rejects.toThrowError(FastManimSandboxResourceControlError);
  });

  it("fails closed when the delegated root contains a non-owned child", async () => {
    const store = new FakeCgroupV2Store();
    store.addOrphan("tenant-project-source-path");
    const resources = controller(store);
    await expect(resources.initialize()).rejects.toThrowError(FastManimSandboxResourceControlError);
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, state: "quarantined" });
    expect(store.writes.some(([, file]) => file === "cgroup.kill")).toBe(false);
  });

  it("kills, closes output, proves empty, and reaps every job on shutdown", async () => {
    const store = new FakeCgroupV2Store();
    const resources = controller(store);
    await resources.initialize();
    const firstOutput = outputLifecycle();
    const secondOutput = outputLifecycle();
    const first = await resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, firstOutput.output);
    const second = await resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, secondOutput.output);
    store.set(first.descriptor.cgroupName, "cgroup.events", "populated 1\nfrozen 0\n");
    store.set(second.descriptor.cgroupName, "cgroup.events", "populated 1\nfrozen 0\n");
    await resources.shutdown();
    expect(firstOutput.isClosed()).toBe(true);
    expect(secondOutput.isClosed()).toBe(true);
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, reapedJobs: 2, state: "closed" });
  });

  it("watchdog automatically stops memory events and wall deadlines without caller polling", async () => {
    const memoryStore = new FakeCgroupV2Store();
    const memoryResources = controller(memoryStore, { pollIntervalMs: 1 });
    await memoryResources.initialize();
    const memoryOutput = outputLifecycle();
    const memoryJob = await memoryResources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, memoryOutput.output);
    memoryStore.set(memoryJob.descriptor.cgroupName, "memory.events", "max 1\noom 0\noom_kill 0\n");
    await Promise.race([
      memoryJob.completion,
      delay(500).then(() => {
        throw new Error(`memory watchdog did not settle: ${JSON.stringify(memoryResources.snapshot())}`);
      }),
    ]);
    expect(memoryOutput.isClosed()).toBe(true);
    expect(memoryResources.snapshot()).toMatchObject({
      activeJobs: 0,
      terminated: [{ count: 1, reason: "memory-limit" }],
    });

    let now = 10_000;
    const deadlineStore = new FakeCgroupV2Store();
    const deadlineResources = controller(deadlineStore, {
      monotonicNow: () => now,
      pollIntervalMs: 1,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    await deadlineResources.initialize();
    const deadlineLimits = { ...DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, wallTimeMs: 1 };
    const deadlineOutput = outputLifecycle(deadlineLimits);
    const deadlineJob = await deadlineResources.admit(deadlineLimits, deadlineOutput.output);
    await Promise.race([
      deadlineJob.completion,
      delay(500).then(() => {
        throw new Error(`deadline watchdog did not settle: ${JSON.stringify(deadlineResources.snapshot())}`);
      }),
    ]);
    expect(deadlineResources.snapshot().terminated).toContainEqual({ count: 1, reason: "deadline" });
  });

  it("joins a public inspection before normal removal instead of quarantining its read failure", async () => {
    const store = new FakeCgroupV2Store();
    const resources = controller(store, { sleep: async () => new Promise<void>(() => undefined) });
    await resources.initialize();
    const output = outputLifecycle();
    const job = await resources.admitForLocalConformance(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    await delay(0);
    const gate = store.gateNextRead("cpu.stat");
    const inspection = job.inspect();
    await gate.started;
    const finishing = job.finish("completed");
    await delay(0);
    expect(store.jobs.has(job.descriptor.cgroupName)).toBe(true);
    gate.release();
    await expect(inspection).resolves.toMatchObject({ reason: null });
    await expect(finishing).resolves.toBeUndefined();
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, state: "ready" });
  });

  it("kills descendants and closes output before a stuck inspection join can time out", async () => {
    const store = new FakeCgroupV2Store();
    const resources = controller(store, {
      cleanupTimeoutMs: 5,
      controlOperationTimeoutMs: 1_000,
      sleep: async () => new Promise<void>(() => undefined),
    });
    await resources.initialize();
    const output = outputLifecycle();
    const job = await resources.admitForLocalConformance(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    await delay(0);
    const gate = store.gateNextRead("cpu.stat");
    const inspection = job.inspect();
    await gate.started;
    await expect(job.finish("aborted")).rejects.toThrowError(FastManimSandboxResourceControlError);
    expect(store.writes).toContainEqual([job.descriptor.cgroupName, "cgroup.kill", "1\n"]);
    expect(output.isClosed()).toBe(true);
    expect(resources.snapshot()).toMatchObject({
      activeJobs: 1,
      state: "quarantined",
      terminated: [{ count: 1, reason: "cleanup-failed" }],
    });
    gate.release();
    await expect(inspection).resolves.toMatchObject({ reason: null });
  });

  it("cancels and joins an in-flight watchdog inspection during shutdown", async () => {
    const store = new FakeCgroupV2Store();
    let releasePoll!: () => void;
    let markPollStarted!: () => void;
    const pollStarted = new Promise<void>((resolvePromise) => {
      markPollStarted = resolvePromise;
    });
    const pollGate = new Promise<void>((resolvePromise) => {
      releasePoll = resolvePromise;
    });
    const resources = controller(store, {
      sleep: async () => {
        markPollStarted();
        await pollGate;
      },
    });
    await resources.initialize();
    const output = outputLifecycle();
    const job = await resources.admitForLocalConformance(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    await pollStarted;
    const readGate = store.gateNextRead("cpu.stat");
    releasePoll();
    await readGate.started;
    const shuttingDown = resources.shutdown();
    await delay(0);
    expect(store.jobs.has(job.descriptor.cgroupName)).toBe(true);
    readGate.release();
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, state: "closed" });
  });

  it("finalizes completed from post-kill counters and the monotonic finish-receipt time", async () => {
    const counterStore = new FakeCgroupV2Store();
    counterStore.onKill = (job) => job.files.set("memory.events", "max 1\noom 0\noom_kill 0\n");
    const counterResources = controller(counterStore, { sleep: async () => new Promise<void>(() => undefined) });
    await counterResources.initialize();
    const counterOutput = outputLifecycle();
    const counterJob = await counterResources.admitForLocalConformance(
      DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
      counterOutput.output,
    );
    await counterJob.finish("completed");
    await expect(counterJob.completion).resolves.toBe("memory-limit");
    expect(counterResources.snapshot().terminated).toEqual([{ count: 1, reason: "memory-limit" }]);

    let now = 1_000;
    const deadlineStore = new FakeCgroupV2Store();
    const deadlineResources = controller(deadlineStore, {
      monotonicNow: () => now,
      sleep: async () => new Promise<void>(() => undefined),
    });
    await deadlineResources.initialize();
    const limits = { ...DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, wallTimeMs: 10 };
    const deadlineOutput = outputLifecycle(limits);
    const deadlineJob = await deadlineResources.admitForLocalConformance(limits, deadlineOutput.output);
    now = 1_010;
    await deadlineJob.finish("completed");
    await expect(deadlineJob.completion).resolves.toBe("deadline");
    expect(deadlineResources.snapshot().terminated).toEqual([{ count: 1, reason: "deadline" }]);
  });

  it("uses a monotonic deadline even when the epoch clock rolls backwards", async () => {
    let epochNow = 1_700_000_000_000;
    let monotonicNow = 500;
    const sharedRegistry = registry(4, () => epochNow);
    const store = new FakeCgroupV2Store();
    const resources = controller(store, {
      monotonicNow: () => monotonicNow,
      pollIntervalMs: 1,
      registry: sharedRegistry,
      sleep: async (milliseconds) => {
        monotonicNow += milliseconds;
        epochNow -= 60_000;
      },
    });
    await resources.initialize();
    const limits = { ...DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, wallTimeMs: 2 };
    const output = outputLifecycle(limits);
    const job = await resources.admit(limits, output.output);
    expect(job.descriptor.deadlineEpochMs).toBe(1_700_000_000_002);
    await job.completion;
    expect(monotonicNow).toBeGreaterThanOrEqual(502);
    expect(epochNow).toBeLessThan(1_700_000_000_000);
    expect(resources.snapshot().terminated).toContainEqual({ count: 1, reason: "deadline" });
  });

  it("bounds output close and populated waits under one cleanup deadline", async () => {
    const hangingOutputStore = new FakeCgroupV2Store();
    const hangingOutputResources = controller(hangingOutputStore, { cleanupTimeoutMs: 5 });
    await hangingOutputResources.initialize();
    const baseOutput = outputLifecycle().output;
    const hangingOutput = {
      ...baseOutput,
      close: () => new Promise<void>(() => undefined),
      closureEvidence: () => null,
    };
    const outputJob = await hangingOutputResources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, hangingOutput);
    const startedAt = Date.now();
    await expect(outputJob.finish("aborted")).rejects.toThrowError(FastManimSandboxResourceControlError);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(hangingOutputResources.snapshot()).toMatchObject({ activeJobs: 1, state: "quarantined" });

    let now = 20_000;
    const populatedStore = new FakeCgroupV2Store();
    const populatedResources = controller(populatedStore, {
      cleanupTimeoutMs: 3,
      monotonicNow: () => now,
      pollIntervalMs: 1,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    await populatedResources.initialize();
    const populatedOutput = outputLifecycle();
    const populatedJob = await populatedResources.admit(
      DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
      populatedOutput.output,
    );
    populatedStore.set(populatedJob.descriptor.cgroupName, "cgroup.events", "populated 1\nfrozen 0\n");
    populatedStore.killLeavesPopulated = true;
    await expect(populatedJob.finish("shutdown")).rejects.toThrowError(FastManimSandboxResourceControlError);
    expect(populatedResources.snapshot()).toMatchObject({ activeJobs: 1, state: "quarantined" });
  });

  it("tracks setup as an owned pending job so shutdown joins and reaps it", async () => {
    const store = new FakeCgroupV2Store();
    let releaseCreate!: () => void;
    let reportCreateStarted!: () => void;
    store.createGate = new Promise<void>((resolvePromise) => {
      releaseCreate = resolvePromise;
    });
    const createStarted = new Promise<void>((resolvePromise) => {
      reportCreateStarted = resolvePromise;
    });
    store.createStarted = reportCreateStarted;
    const resources = controller(store);
    await resources.initialize();
    const output = outputLifecycle();
    const admission = resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    admission.catch(() => undefined);
    await createStarted;
    const shutdown = resources.shutdown();
    releaseCreate();
    await expect(admission).rejects.toThrowError(FastManimSandboxResourceControlError);
    await expect(shutdown).resolves.toBeUndefined();
    expect(store.jobs.size).toBe(0);
    expect(output.isClosed()).toBe(true);
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, state: "closed" });
  });

  it("does not quarantine shutdown when a concurrent setup failure is cleaned and reaped", async () => {
    const store = new FakeCgroupV2Store();
    let releaseCreate!: () => void;
    let reportCreateStarted!: () => void;
    store.createGate = new Promise<void>((resolvePromise) => {
      releaseCreate = resolvePromise;
    });
    const createStarted = new Promise<void>((resolvePromise) => {
      reportCreateStarted = resolvePromise;
    });
    store.createStarted = reportCreateStarted;
    store.rejectWriteFile = "memory.max";
    const resources = controller(store);
    await resources.initialize();
    const output = outputLifecycle();
    const admission = resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, output.output);
    admission.catch(() => undefined);
    await createStarted;
    const shutdown = resources.shutdown();
    releaseCreate();
    await expect(admission).rejects.toThrow(/unavailable/i);
    await expect(shutdown).resolves.toBeUndefined();
    expect(store.jobs.size).toBe(0);
    expect(resources.snapshot()).toMatchObject({
      activeJobs: 0,
      state: "closed",
      terminated: [{ count: 1, reason: "launch-failed" }],
    });
  });

  it("shares one atomic budget across independently composed controllers", async () => {
    const sharedRegistry = registry(1);
    const firstResources = controller(new FakeCgroupV2Store(), { registry: sharedRegistry });
    const secondResources = controller(new FakeCgroupV2Store(), { registry: sharedRegistry });
    await firstResources.initialize();
    await secondResources.initialize();
    const firstOutput = outputLifecycle();
    const first = await firstResources.admitForLocalConformance(
      DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
      firstOutput.output,
    );
    await expect(
      secondResources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, outputLifecycle().output),
    ).rejects.toThrowError(FastManimSandboxResourceControlError);
    expect(sharedRegistry.snapshot()).toMatchObject({ activeJobs: 1, queuedJobs: 0 });
    await first.finish("completed");
    const secondOutput = outputLifecycle();
    const second = await secondResources.admitForLocalConformance(
      DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
      secondOutput.output,
    );
    await second.finish("completed");
    expect(sharedRegistry.snapshot()).toMatchObject({ activeJobs: 0, reapedJobs: 2 });
  });

  it("rejects output cap drift before reserving or creating a cgroup", async () => {
    const store = new FakeCgroupV2Store();
    const resources = controller(store);
    await resources.initialize();
    const output = outputLifecycle().output;
    await expect(
      resources.admit(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, {
        ...output,
        descriptor: { ...output.descriptor, maxStdoutBytes: output.descriptor.maxStdoutBytes + 1 },
      }),
    ).rejects.toThrowError(FastManimSandboxResourceControlError);
    expect(store.jobs.size).toBe(0);
    expect(resources.snapshot()).toMatchObject({ activeJobs: 0, state: "ready" });
  });
});
