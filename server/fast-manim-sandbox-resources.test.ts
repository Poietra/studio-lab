import { describe, expect, it } from "vitest";

import {
  assertFastManimSandboxBoundedOutputMatchesLimitsV1,
  assertFastManimSandboxResourceLimitsFitTmpfsProfileV1,
  classifyFastManimSandboxResourceFailureV1,
  DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
  FastManimSandboxResourceControlError,
  FastManimSandboxResourceRegistryV1,
  fastManimSandboxResourceControlErrorCode,
  isFastManimSandboxResourceCgroupNameV1,
  parseFastManimSandboxResourceJobDescriptorV1,
  parseFastManimSandboxResourceLimitsV1,
} from "./fast-manim-sandbox-resources";

const MIB = 1024 * 1024;

function limits(overrides: Partial<typeof DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1> = {}) {
  return { ...DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1, ...overrides };
}

describe("fast-manim sandbox resource contract", () => {
  it("accepts only a closed, bounded, safe-integer limit object", () => {
    expect(parseFastManimSandboxResourceLimitsV1(limits())).toEqual(DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1);
    for (const candidate of [
      limits({ maxMemoryBytes: Number.MAX_SAFE_INTEGER }),
      limits({ maxOpenFiles: 2.5 }),
      limits({ wallTimeMs: Number.NaN }),
      limits({ cpuQuotaMicros: 6_400_001, cpuPeriodMicros: 100_000 }),
      limits({ maxResultBytes: 2, maxStdoutBytes: 1 }),
      limits({ maxResultBytes: 64 * MIB }),
      { ...limits(), tenantId: "tenant-secret" },
      { ...limits(), sourcePath: "/host/private/scene.py" },
    ]) {
      expect(() => parseFastManimSandboxResourceLimitsV1(candidate)).toThrow();
    }
  });

  it("registers control error identity without reading hostile properties", () => {
    const capacity = new FastManimSandboxResourceControlError("capacity");
    expect(fastManimSandboxResourceControlErrorCode(capacity)).toBe("capacity");
    let reads = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          reads += 1;
          throw new Error("must not inspect");
        },
        getPrototypeOf() {
          reads += 1;
          throw new Error("must not inspect");
        },
      },
    );
    expect(fastManimSandboxResourceControlErrorCode(hostile)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("rejects envelopes looser than the immutable OCI tmpfs profile", () => {
    const profile = {
      runtime: { maximumInodes: 4096, sizeBytes: 16 * MIB },
      sharedMemory: { maximumInodes: 1024, sizeBytes: 4 * MIB },
    };
    expect(() => assertFastManimSandboxResourceLimitsFitTmpfsProfileV1(limits(), profile)).not.toThrow();
    expect(() =>
      assertFastManimSandboxResourceLimitsFitTmpfsProfileV1(limits({ maxRuntimeTmpfsBytes: 16 * MIB + 1 }), profile),
    ).toThrowError(FastManimSandboxResourceControlError);
    expect(() =>
      assertFastManimSandboxResourceLimitsFitTmpfsProfileV1(limits({ maxSharedMemoryInodes: 1025 }), profile),
    ).toThrowError(FastManimSandboxResourceControlError);
  });

  it("requires bounded stdout, stderr, and result caps to match the resource envelope exactly", () => {
    const descriptor = {
      maxResultBytes: limits().maxResultBytes,
      maxStderrBytes: limits().maxStderrBytes,
      maxStdoutBytes: limits().maxStdoutBytes,
      schema: "poietra.fast-manim-sandbox-bounded-output",
      version: 1,
    };
    expect(() => assertFastManimSandboxBoundedOutputMatchesLimitsV1(descriptor, limits())).not.toThrow();
    expect(() =>
      assertFastManimSandboxBoundedOutputMatchesLimitsV1(
        { ...descriptor, maxStdoutBytes: descriptor.maxStdoutBytes + 1 },
        limits(),
      ),
    ).toThrowError(FastManimSandboxResourceControlError);
    expect(() =>
      assertFastManimSandboxBoundedOutputMatchesLimitsV1({ ...descriptor, sourceText: "secret" }, limits()),
    ).toThrow();
  });

  it.each([
    [{ shutdownRequested: true }, "shutdown"],
    [{ abortRequested: true }, "aborted"],
    [{ cgroupReason: "memory-limit" }, "memory-limit"],
    [{ cgroupReason: "pids-limit" }, "pids-limit"],
    [{ rlimit: "cpu" }, "cpu-limit"],
    [{ rlimit: "nofile" }, "fd-limit"],
    [{ rlimit: "file" }, "file-limit"],
    [{ tmpfsLimitHit: true }, "tmpfs-limit"],
    [{ outputOverflow: "stdout-overflow" }, "stdout-overflow"],
    [{ outputOverflow: "stderr-overflow" }, "stderr-overflow"],
    [{ outputOverflow: "result-overflow" }, "result-overflow"],
    [{ deadlineExceeded: true }, "deadline"],
    [{ launchFailed: true }, "launch-failed"],
  ] as const)("maps bounded resource evidence %j to %s", (override, expected) => {
    expect(
      classifyFastManimSandboxResourceFailureV1({
        abortRequested: false,
        cgroupReason: null,
        deadlineExceeded: false,
        launchFailed: false,
        outputOverflow: null,
        rlimit: null,
        shutdownRequested: false,
        tmpfsLimitHit: false,
        ...override,
      }),
    ).toBe(expected);
  });
});

describe("fast-manim sandbox resource registry", () => {
  it("atomically reserves active, process-wide fd, memory, output, and tmpfs budgets", () => {
    const registry = new FastManimSandboxResourceRegistryV1({
      maxActiveJobs: 2,
      maxReservedMemoryBytes: 3 * MIB,
      maxReservedOutputBytes: 300,
      maxReservedTmpfsBytes: 3 * MIB,
      now: () => 1_000,
    });
    const first = registry.admit(
      limits({
        maxMemoryBytes: 2 * MIB,
        maxResultBytes: 50,
        maxStderrBytes: 50,
        maxStdoutBytes: 100,
        maxRuntimeTmpfsBytes: MIB,
        maxSharedMemoryBytes: MIB,
        wallTimeMs: 500,
      }),
    );
    expect(first.descriptor.deadlineEpochMs).toBe(1_500);
    expect(first.descriptor.reservedOutputBytes).toBe(200);
    expect(first.descriptor.reservedFileDescriptors).toBe(64 * 256);
    expect(first.descriptor.reservedMemoryBytes).toBe(2 * MIB);
    expect(first.descriptor.reservedTmpfsBytes).toBe(2 * MIB);
    expect(isFastManimSandboxResourceCgroupNameV1(first.descriptor.cgroupName)).toBe(true);
    expect(first.descriptor).not.toHaveProperty("tenantId");
    expect(first.descriptor).not.toHaveProperty("projectId");
    expect(first.descriptor).not.toHaveProperty("requestId");
    expect(first.descriptor).not.toHaveProperty("sourceText");
    expect(first.descriptor).not.toHaveProperty("sourcePath");
    expect(parseFastManimSandboxResourceJobDescriptorV1(first.descriptor)).toEqual(first.descriptor);
    expect(() =>
      parseFastManimSandboxResourceJobDescriptorV1({
        ...first.descriptor,
        cgroupName: `poietra-job-v1-${"f".repeat(32)}-1`,
      }),
    ).toThrow();
    expect(() =>
      parseFastManimSandboxResourceJobDescriptorV1({
        ...first.descriptor,
        reservedOutputBytes: first.descriptor.reservedOutputBytes + 1,
      }),
    ).toThrow();
    const before = registry.snapshot();
    expect(() =>
      registry.admit(
        limits({
          maxMemoryBytes: 2 * MIB,
          maxResultBytes: 50,
          maxStderrBytes: 50,
          maxStdoutBytes: 100,
          maxRuntimeTmpfsBytes: MIB,
          maxSharedMemoryBytes: MIB,
        }),
      ),
    ).toThrowError(FastManimSandboxResourceControlError);
    expect(registry.snapshot()).toEqual(before);

    first.terminate("completed");
    first.reap({ cgroupEmpty: true, outputClosed: true });
    expect(registry.snapshot()).toMatchObject({
      activeJobs: 0,
      queuedJobs: 0,
      reapedJobs: 1,
      reservedMemoryBytes: 0,
      reservedOutputBytes: 0,
      reservedTmpfsBytes: 0,
      reservedFileDescriptors: 0,
      state: "ready",
    });
  });

  it("never reuses a job id and makes delayed lease calls harmless", () => {
    const registry = new FastManimSandboxResourceRegistryV1();
    const first = registry.admit(limits());
    first.terminate("completed");
    first.reap({ cgroupEmpty: true, outputClosed: true });
    const second = registry.admit(limits());
    expect(second.descriptor.jobId).not.toBe(first.descriptor.jobId);
    first.terminate("shutdown");
    first.failClosed();
    expect(registry.snapshot()).toMatchObject({ activeJobs: 1, state: "ready" });
    second.terminate("completed");
    second.reap({ cgroupEmpty: true, outputClosed: true });
  });

  it("requires reconciliation and retains reservations on uncertain cleanup", () => {
    const registry = new FastManimSandboxResourceRegistryV1({ requireReconciliation: true });
    expect(() => registry.admit(limits())).toThrowError(FastManimSandboxResourceControlError);
    registry.markReconciled();
    const lease = registry.admit(limits());
    expect(() => lease.reap({ cgroupEmpty: false, outputClosed: true } as never)).toThrowError(
      FastManimSandboxResourceControlError,
    );
    expect(registry.snapshot()).toMatchObject({ activeJobs: 1, state: "quarantined" });
    expect(registry.snapshot().terminated).toEqual([{ count: 1, reason: "cleanup-failed" }]);
    expect(() => registry.admit(limits())).toThrowError(FastManimSandboxResourceControlError);
  });

  it("reserves swap against the global memory budget", () => {
    const registry = new FastManimSandboxResourceRegistryV1({ maxReservedMemoryBytes: 3 * MIB });
    const lease = registry.admit(limits({ maxMemoryBytes: 2 * MIB, maxSwapBytes: MIB }));
    expect(lease.descriptor.reservedMemoryBytes).toBe(3 * MIB);
    expect(registry.snapshot().reservedMemoryBytes).toBe(3 * MIB);
    expect(() => registry.admit(limits({ maxMemoryBytes: MIB, maxSwapBytes: 0 }))).toThrowError(
      FastManimSandboxResourceControlError,
    );
    lease.terminate("completed");
    lease.reap({ cgroupEmpty: true, outputClosed: true });
  });

  it("reserves maxProcesses times maxOpenFiles against one global fd budget", () => {
    const registry = new FastManimSandboxResourceRegistryV1({
      maxActiveJobs: 2,
      maxReservedFileDescriptors: 100,
    });
    const first = registry.admit(limits({ maxOpenFiles: 20, maxProcesses: 4 }));
    expect(first.descriptor.reservedFileDescriptors).toBe(80);
    expect(registry.snapshot().reservedFileDescriptors).toBe(80);
    expect(() => registry.admit(limits({ maxOpenFiles: 10, maxProcesses: 3 }))).toThrowError(
      FastManimSandboxResourceControlError,
    );
    first.terminate("completed");
    first.reap({ cgroupEmpty: true, outputClosed: true });
    const second = registry.admit(limits({ maxOpenFiles: 10, maxProcesses: 3 }));
    second.terminate("completed");
    second.reap({ cgroupEmpty: true, outputClosed: true });
  });

  it("records cleanup-failed when fail-closed supersedes an earlier provisional reason", () => {
    const registry = new FastManimSandboxResourceRegistryV1();
    const lease = registry.admit(limits());
    lease.terminate("aborted");
    lease.failClosed();
    expect(registry.snapshot().terminated).toEqual([{ count: 1, reason: "cleanup-failed" }]);
  });

  it("cannot close cleanly before startup reconciliation is proven", () => {
    const registry = new FastManimSandboxResourceRegistryV1({ requireReconciliation: true });
    registry.beginClose();
    expect(() => registry.finishClose()).toThrowError(FastManimSandboxResourceControlError);
    expect(registry.snapshot().state).toBe("quarantined");
  });

  it("does not report clean close until every reservation is reaped", () => {
    const registry = new FastManimSandboxResourceRegistryV1();
    const lease = registry.admit(limits());
    registry.beginClose();
    expect(() => registry.finishClose()).toThrowError(FastManimSandboxResourceControlError);
    expect(registry.snapshot().state).toBe("quarantined");
    lease.failClosed();
  });
});
