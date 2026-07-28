import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveLinuxCgroupV2OrchestratorPathV1, LinuxCgroupV2ResourceControllerV1 } from "./fast-manim-linux-cgroup-v2";
import {
  LocalLinuxCgroupV2ConformanceHarnessV1,
  probeLinuxCgroupV2LocalConformanceV1,
} from "./fast-manim-local-cgroup-conformance";
import {
  DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
  type FastManimSandboxResourceFailureCodeV1,
  type FastManimSandboxResourceLimitsV1,
  FastManimSandboxResourceRegistryV1,
} from "./fast-manim-sandbox-resources";

const KIB = 1024;
const MIB = 1024 * KIB;
const configuredRoot = process.env.POIETRA_CGROUP_V2_CONFORMANCE_ROOT;
const availability = probeLinuxCgroupV2LocalConformanceV1(configuredRoot);
const availabilityLabel = availability.kind === "skip" ? availability.code : "ready";

function limits(overrides: Partial<FastManimSandboxResourceLimitsV1> = {}): FastManimSandboxResourceLimitsV1 {
  return {
    ...DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
    maxCpuTimeMicros: 5_000_000,
    maxFileBytes: 4 * MIB,
    maxMemoryBytes: 128 * MIB,
    maxOpenFiles: 64,
    maxProcesses: 32,
    maxResultBytes: 4 * KIB,
    maxRuntimeTmpfsBytes: 4 * MIB,
    maxRuntimeTmpfsInodes: 128,
    maxSharedMemoryBytes: MIB,
    maxSharedMemoryInodes: 32,
    maxStderrBytes: 64 * KIB,
    maxStdoutBytes: 64 * KIB,
    wallTimeMs: 8_000,
    ...overrides,
  };
}

function nodeCommand(source: string) {
  return [process.execPath, "-e", source] as const;
}

const RESOURCE_FLOOD_CASES: readonly Readonly<{
  expected: FastManimSandboxResourceFailureCodeV1;
  limits: Partial<FastManimSandboxResourceLimitsV1>;
  name: string;
  source: string;
}>[] = [
  {
    expected: "memory-limit",
    limits: { maxMemoryBytes: 96 * MIB },
    name: "memory cgroup flood",
    source: "const held=[]; for (;;) held.push(Buffer.alloc(1024 * 1024, 1));",
  },
  {
    expected: "cpu-limit",
    limits: { maxCpuTimeMicros: 100_000 },
    name: "cumulative CPU-time flood",
    source: "for (;;) {}",
  },
  {
    expected: "pids-limit",
    limits: { maxProcesses: 8 },
    name: "pids cgroup fork flood",
    source:
      'const {spawn}=require("node:child_process"); const held=[]; setInterval(() => { const child=spawn("/bin/sleep", ["60"], {stdio:"ignore"}); child.on("error", () => {}); held.push(child); }, 1);',
  },
  {
    expected: "fd-limit",
    limits: { maxOpenFiles: 32 },
    name: "open-file descriptor flood",
    source:
      'const fs=require("node:fs"); const held=[]; try { for (;;) held.push(fs.openSync("/dev/null", "r")); } catch (error) { process.exit(error.code === "EMFILE" ? 73 : 70); }',
  },
  {
    expected: "fd-limit",
    limits: { maxOpenFiles: 32, maxProcesses: 16 },
    name: "multi-process open-file descriptor flood",
    source:
      'const {spawn}=require("node:child_process"); const worker=\'const fs=require("node:fs"); const held=[]; try { for (;;) held.push(fs.openSync("/dev/null", "r")); } catch (error) { process.exit(error.code === "EMFILE" ? 73 : 70); }\'; for (let index=0; index<3; index+=1) spawn(process.execPath, ["-e", worker], {stdio:"ignore"}).once("exit", (code) => { if (code === 73) process.exit(73); }); setTimeout(() => process.exit(70), 2000);',
  },
  {
    expected: "file-limit",
    limits: { maxFileBytes: 64 * KIB },
    name: "single-file size flood",
    source:
      'const fs=require("node:fs"); try { const fd=fs.openSync("artifact.bin", "w"); const chunk=Buffer.alloc(16384, 1); for (;;) fs.writeSync(fd, chunk); } catch { process.exit(74); }',
  },
  {
    expected: "tmpfs-limit",
    limits: { maxRuntimeTmpfsBytes: MIB, maxRuntimeTmpfsInodes: 128 },
    name: "runtime tmpfs byte flood",
    source:
      'const fs=require("node:fs"); try { fs.writeFileSync("tmpfs.bin", Buffer.alloc(2 * 1024 * 1024, 1)); } catch (error) { process.exit(error.code === "ENOSPC" ? 75 : 70); }',
  },
  {
    expected: "tmpfs-limit",
    limits: { maxRuntimeTmpfsBytes: 4 * MIB, maxRuntimeTmpfsInodes: 16 },
    name: "runtime tmpfs inode flood",
    source:
      'const fs=require("node:fs"); try { for (let index=0; index<128; index += 1) fs.writeFileSync("inode-" + index, ""); } catch (error) { process.exit(error.code === "ENOSPC" ? 75 : 70); }',
  },
  {
    expected: "stdout-overflow",
    limits: { maxResultBytes: KIB, maxStdoutBytes: KIB },
    name: "bounded stdout flood",
    source: 'process.stdout.write("x".repeat(8 * 1024));',
  },
  {
    expected: "stderr-overflow",
    limits: { maxStderrBytes: KIB },
    name: "bounded stderr flood",
    source: 'process.stderr.write("x".repeat(8 * 1024));',
  },
  {
    expected: "result-overflow",
    limits: { maxResultBytes: KIB, maxStdoutBytes: 8 * KIB },
    name: "bounded result flood",
    source: 'process.stdout.write("x".repeat(4 * 1024));',
  },
];

function createRealHarness() {
  if (availability.kind === "skip" || !configuredRoot) {
    throw new Error(`Real cgroup conformance is unavailable: ${availabilityLabel}.`);
  }
  const registry = new FastManimSandboxResourceRegistryV1({
    maxActiveJobs: 4,
    maxReservedMemoryBytes: 512 * MIB,
    maxReservedOutputBytes: 16 * MIB,
    maxReservedTmpfsBytes: 64 * MIB,
    requireReconciliation: true,
  });
  const controller = new LinuxCgroupV2ResourceControllerV1({
    cgroupsPath: deriveLinuxCgroupV2OrchestratorPathV1(configuredRoot),
    pollIntervalMs: 5,
    registry,
    root: configuredRoot,
  });
  return {
    controller,
    harness: new LocalLinuxCgroupV2ConformanceHarnessV1({ controller }),
  };
}

describe("local cgroup v2 conformance gate", () => {
  it("uses bounded skip codes and never returns the configured host path", () => {
    const serialized = JSON.stringify(availability);
    if (configuredRoot) expect(serialized).not.toContain(configuredRoot);
    expect(availability).toEqual(
      availability.kind === "ready" ? { kind: "ready" } : { code: availabilityLabel, kind: "skip" },
    );

    const invalid = probeLinuxCgroupV2LocalConformanceV1("/tmp/private-tenant/poietra-sandbox-v1");
    expect(invalid).toEqual({ code: "cgroup-root-invalid", kind: "skip" });
    expect(JSON.stringify(invalid)).not.toContain("private-tenant");
  });

  it("keeps every adversarial kernel fixture defined when the host lane is skipped", () => {
    expect(RESOURCE_FLOOD_CASES.map(({ expected, name }) => ({ expected, name }))).toEqual([
      { expected: "memory-limit", name: "memory cgroup flood" },
      { expected: "cpu-limit", name: "cumulative CPU-time flood" },
      { expected: "pids-limit", name: "pids cgroup fork flood" },
      { expected: "fd-limit", name: "open-file descriptor flood" },
      { expected: "fd-limit", name: "multi-process open-file descriptor flood" },
      { expected: "file-limit", name: "single-file size flood" },
      { expected: "tmpfs-limit", name: "runtime tmpfs byte flood" },
      { expected: "tmpfs-limit", name: "runtime tmpfs inode flood" },
      { expected: "stdout-overflow", name: "bounded stdout flood" },
      { expected: "stderr-overflow", name: "bounded stderr flood" },
      { expected: "result-overflow", name: "bounded result flood" },
    ]);
  });
});

describe.skipIf(availability.kind === "skip")(
  `real Linux cgroup v2 adversarial conformance (${availabilityLabel})`,
  () => {
    let controller: LinuxCgroupV2ResourceControllerV1;
    let harness: LocalLinuxCgroupV2ConformanceHarnessV1;

    beforeAll(async () => {
      ({ controller, harness } = createRealHarness());
      await controller.initialize();
    });

    afterAll(async () => {
      await harness.shutdown();
    });

    it.each(RESOURCE_FLOOD_CASES)("$name", { timeout: 20_000 }, async ({ expected, limits: overrides, source }) => {
      const result = await harness.run({ command: nodeCommand(source), limits: limits(overrides) });
      expect(result).toMatchObject({ kind: "failed", reason: expected });
      expect(controller.snapshot()).toMatchObject({ activeJobs: 0, state: "ready" });
    });

    it("does not treat leader exit as success until a setsid daemon and inherited pipe holder are killed and reaped", {
      timeout: 20_000,
    }, async () => {
      const result = await harness.run({
        command: nodeCommand(
          'const {spawn}=require("node:child_process"); const child=spawn("/bin/sleep", ["60"], {detached:true, stdio:["ignore", process.stdout, process.stderr]}); process.stdout.write(String(child.pid)); child.unref();',
        ),
        limits: limits(),
      });
      expect(result.kind).toBe("ok");
      expect(controller.snapshot()).toMatchObject({ activeJobs: 0, state: "ready" });
    });

    it("kills and reaps the full cgroup on caller abort", { timeout: 20_000 }, async () => {
      const abort = new AbortController();
      const resultPromise = harness.run({
        command: nodeCommand("for (;;) {}"),
        limits: limits(),
        signal: abort.signal,
      });
      await delay(50);
      abort.abort();
      await expect(resultPromise).resolves.toMatchObject({ kind: "failed", reason: "aborted" });
      expect(controller.snapshot()).toMatchObject({ activeJobs: 0, state: "ready" });
    });

    it("kills and reaps pending work on controller shutdown", { timeout: 20_000 }, async () => {
      const shutdownLane = createRealHarness();
      await shutdownLane.controller.initialize();
      const resultPromise = shutdownLane.harness.run({ command: nodeCommand("for (;;) {}"), limits: limits() });
      await delay(50);
      await shutdownLane.harness.shutdown();
      await expect(resultPromise).resolves.toMatchObject({ kind: "failed", reason: "shutdown" });
      expect(shutdownLane.controller.snapshot()).toMatchObject({ activeJobs: 0, state: "closed" });
    });
  },
);
