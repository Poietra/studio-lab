import { randomBytes } from "node:crypto";

import { z } from "zod";

import { MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES } from "./fast-manim-snapshot-contract";

export const FAST_MANIM_SANDBOX_RESOURCE_JOB_SCHEMA_V1 = "poietra.fast-manim-sandbox-resource-job" as const;
export const FAST_MANIM_SANDBOX_RESOURCE_JOB_VERSION_V1 = 1 as const;
export const FAST_MANIM_SANDBOX_BOUNDED_OUTPUT_SCHEMA_V1 = "poietra.fast-manim-sandbox-bounded-output" as const;
export const FAST_MANIM_SANDBOX_OUTPUT_CLOSED_SCHEMA_V1 = "poietra.fast-manim-sandbox-output-closed" as const;

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const MAX_RESOURCE_BYTES = 64 * GIB;
const MAX_GLOBAL_RESOURCE_BYTES = 1024 * GIB;
const MAX_RESOURCE_WALL_TIME_MS = 10 * 60 * 1000;
const MAX_RESOURCE_CPU_TIME_MICROS = 64 * MAX_RESOURCE_WALL_TIME_MS * 1000;
const MAX_RESOURCE_CPU_PERIOD_MICROS = 1_000_000;
const MAX_RESOURCE_CPU_QUOTA_MICROS = 64 * MAX_RESOURCE_CPU_PERIOD_MICROS;
const MAX_RESOURCE_PROCESSES = 4096;
const MAX_RESOURCE_OPEN_FILES = 65_536;
const MAX_RESOURCE_TMPFS_INODES = 1_000_000;
const MAX_GLOBAL_ACTIVE_JOBS = 4096;
const MAX_JOB_FILE_DESCRIPTORS = MAX_RESOURCE_PROCESSES * MAX_RESOURCE_OPEN_FILES;
const MAX_GLOBAL_FILE_DESCRIPTORS = MAX_JOB_FILE_DESCRIPTORS * MAX_GLOBAL_ACTIVE_JOBS;
const DEFAULT_GLOBAL_FILE_DESCRIPTORS = 4 * 64 * 256;

function boundedSafeInteger(name: string, minimum: number, maximum: number) {
  return z
    .number()
    .refine(Number.isSafeInteger, `${name} must be a safe integer.`)
    .min(minimum, `${name} must be at least ${minimum}.`)
    .max(maximum, `${name} must be at most ${maximum}.`);
}

export const fastManimSandboxResourceLimitsV1Schema = z
  .object({
    cpuPeriodMicros: boundedSafeInteger("CPU period", 1_000, MAX_RESOURCE_CPU_PERIOD_MICROS),
    cpuQuotaMicros: boundedSafeInteger("CPU quota", 1_000, MAX_RESOURCE_CPU_QUOTA_MICROS),
    maxCpuTimeMicros: boundedSafeInteger("CPU time", 1_000, MAX_RESOURCE_CPU_TIME_MICROS),
    maxFileBytes: boundedSafeInteger("File bytes", 1, MAX_RESOURCE_BYTES),
    maxMemoryBytes: boundedSafeInteger("Memory bytes", MIB, MAX_RESOURCE_BYTES),
    maxOpenFiles: boundedSafeInteger("Open files", 3, MAX_RESOURCE_OPEN_FILES),
    maxProcesses: boundedSafeInteger("Processes", 1, MAX_RESOURCE_PROCESSES),
    maxResultBytes: boundedSafeInteger("Result bytes", 1, MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES),
    maxStderrBytes: boundedSafeInteger("Stderr bytes", 1, MAX_RESOURCE_BYTES),
    maxStdoutBytes: boundedSafeInteger("Stdout bytes", 1, MAX_RESOURCE_BYTES),
    maxSwapBytes: boundedSafeInteger("Swap bytes", 0, MAX_RESOURCE_BYTES),
    maxRuntimeTmpfsBytes: boundedSafeInteger("Runtime tmpfs bytes", MIB, MAX_RESOURCE_BYTES),
    maxRuntimeTmpfsInodes: boundedSafeInteger("Runtime tmpfs inodes", 1, MAX_RESOURCE_TMPFS_INODES),
    maxSharedMemoryBytes: boundedSafeInteger("Shared memory bytes", MIB, MAX_RESOURCE_BYTES),
    maxSharedMemoryInodes: boundedSafeInteger("Shared memory inodes", 1, MAX_RESOURCE_TMPFS_INODES),
    wallTimeMs: boundedSafeInteger("Wall time", 1, MAX_RESOURCE_WALL_TIME_MS),
  })
  .strict()
  .superRefine((limits, context) => {
    if (limits.cpuQuotaMicros > limits.cpuPeriodMicros * 64) {
      context.addIssue({ code: "custom", message: "CPU quota cannot reserve more than 64 CPUs per period." });
    }
    if (limits.maxResultBytes > limits.maxStdoutBytes) {
      context.addIssue({ code: "custom", message: "Result bytes cannot exceed the bounded stdout stream." });
    }
  });

export type FastManimSandboxResourceLimitsV1 = Readonly<z.infer<typeof fastManimSandboxResourceLimitsV1Schema>>;

export const DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1: FastManimSandboxResourceLimitsV1 = Object.freeze({
  cpuPeriodMicros: 100_000,
  cpuQuotaMicros: 100_000,
  maxCpuTimeMicros: 30_000_000,
  maxFileBytes: 64 * MIB,
  maxMemoryBytes: GIB,
  maxOpenFiles: 256,
  maxProcesses: 64,
  maxResultBytes: MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  maxStderrBytes: 256 * KIB,
  maxStdoutBytes: MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  maxSwapBytes: 0,
  maxRuntimeTmpfsBytes: 16 * MIB,
  maxRuntimeTmpfsInodes: 4096,
  maxSharedMemoryBytes: 4 * MIB,
  maxSharedMemoryInodes: 1024,
  wallTimeMs: 30_000,
});

export function parseFastManimSandboxResourceLimitsV1(value: unknown): FastManimSandboxResourceLimitsV1 {
  return Object.freeze(fastManimSandboxResourceLimitsV1Schema.parse(value));
}

export const fastManimSandboxBoundedOutputDescriptorV1Schema = z
  .object({
    maxResultBytes: boundedSafeInteger("Bounded result bytes", 1, MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES),
    maxStderrBytes: boundedSafeInteger("Bounded stderr bytes", 1, MAX_RESOURCE_BYTES),
    maxStdoutBytes: boundedSafeInteger("Bounded stdout bytes", 1, MAX_RESOURCE_BYTES),
    schema: z.literal(FAST_MANIM_SANDBOX_BOUNDED_OUTPUT_SCHEMA_V1),
    version: z.literal(1),
  })
  .strict();

export type FastManimSandboxBoundedOutputDescriptorV1 = Readonly<
  z.infer<typeof fastManimSandboxBoundedOutputDescriptorV1Schema>
>;

export const fastManimSandboxOutputClosedEvidenceV1Schema = z
  .object({
    resultClosed: z.literal(true),
    schema: z.literal(FAST_MANIM_SANDBOX_OUTPUT_CLOSED_SCHEMA_V1),
    stderrClosed: z.literal(true),
    stdoutClosed: z.literal(true),
    version: z.literal(1),
  })
  .strict();

export type FastManimSandboxOutputClosedEvidenceV1 = Readonly<
  z.infer<typeof fastManimSandboxOutputClosedEvidenceV1Schema>
>;

export function parseFastManimSandboxBoundedOutputDescriptorV1(
  value: unknown,
): FastManimSandboxBoundedOutputDescriptorV1 {
  return Object.freeze(fastManimSandboxBoundedOutputDescriptorV1Schema.parse(value));
}

export function assertFastManimSandboxBoundedOutputMatchesLimitsV1(descriptorValue: unknown, limitsValue: unknown) {
  const descriptor = parseFastManimSandboxBoundedOutputDescriptorV1(descriptorValue);
  const limits = parseFastManimSandboxResourceLimitsV1(limitsValue);
  if (
    descriptor.maxResultBytes !== limits.maxResultBytes ||
    descriptor.maxStderrBytes !== limits.maxStderrBytes ||
    descriptor.maxStdoutBytes !== limits.maxStdoutBytes
  ) {
    throw new FastManimSandboxResourceControlError("configuration");
  }
}

const fastManimSandboxTmpfsProfileCapsV1Schema = z
  .object({
    runtime: z
      .object({
        maximumInodes: boundedSafeInteger("Runtime profile inodes", 1, MAX_RESOURCE_TMPFS_INODES),
        sizeBytes: boundedSafeInteger("Runtime profile bytes", MIB, MAX_RESOURCE_BYTES),
      })
      .strict(),
    sharedMemory: z
      .object({
        maximumInodes: boundedSafeInteger("Shared-memory profile inodes", 1, MAX_RESOURCE_TMPFS_INODES),
        sizeBytes: boundedSafeInteger("Shared-memory profile bytes", MIB, MAX_RESOURCE_BYTES),
      })
      .strict(),
  })
  .strict();

export type FastManimSandboxTmpfsProfileCapsV1 = Readonly<z.infer<typeof fastManimSandboxTmpfsProfileCapsV1Schema>>;

/** Rejects a resource envelope that is looser than the immutable OCI mount profile. */
export function assertFastManimSandboxResourceLimitsFitTmpfsProfileV1(limitsValue: unknown, profileValue: unknown) {
  const limits = parseFastManimSandboxResourceLimitsV1(limitsValue);
  const profile = fastManimSandboxTmpfsProfileCapsV1Schema.parse(profileValue);
  if (
    limits.maxRuntimeTmpfsBytes > profile.runtime.sizeBytes ||
    limits.maxRuntimeTmpfsInodes > profile.runtime.maximumInodes ||
    limits.maxSharedMemoryBytes > profile.sharedMemory.sizeBytes ||
    limits.maxSharedMemoryInodes > profile.sharedMemory.maximumInodes
  ) {
    throw new FastManimSandboxResourceControlError("configuration");
  }
}

export const fastManimSandboxResourceFailureCodeV1Schema = z.enum([
  "aborted",
  "capacity",
  "cleanup-failed",
  "cpu-limit",
  "deadline",
  "fd-limit",
  "file-limit",
  "launch-failed",
  "memory-limit",
  "pids-limit",
  "result-overflow",
  "shutdown",
  "stderr-overflow",
  "stdout-overflow",
  "tmpfs-limit",
]);

export type FastManimSandboxResourceFailureCodeV1 = z.infer<typeof fastManimSandboxResourceFailureCodeV1Schema>;

export const fastManimSandboxResourceFailureEvidenceV1Schema = z
  .object({
    abortRequested: z.boolean(),
    cgroupReason: z.enum(["cpu-limit", "memory-limit", "pids-limit"]).nullable(),
    deadlineExceeded: z.boolean(),
    launchFailed: z.boolean(),
    outputOverflow: z.enum(["result-overflow", "stderr-overflow", "stdout-overflow"]).nullable(),
    rlimit: z.enum(["cpu", "file", "nofile"]).nullable(),
    shutdownRequested: z.boolean(),
    tmpfsLimitHit: z.boolean(),
  })
  .strict();

export type FastManimSandboxResourceFailureEvidenceV1 = Readonly<
  z.infer<typeof fastManimSandboxResourceFailureEvidenceV1Schema>
>;

/** Maps only bounded, server-owned evidence; raw stderr and backend strings are not accepted. */
export function classifyFastManimSandboxResourceFailureV1(
  value: unknown,
): FastManimSandboxResourceFailureCodeV1 | null {
  const evidence = fastManimSandboxResourceFailureEvidenceV1Schema.parse(value);
  if (evidence.shutdownRequested) return "shutdown";
  if (evidence.abortRequested) return "aborted";
  if (evidence.cgroupReason) return evidence.cgroupReason;
  if (evidence.rlimit === "cpu") return "cpu-limit";
  if (evidence.rlimit === "nofile") return "fd-limit";
  if (evidence.rlimit === "file") return "file-limit";
  if (evidence.tmpfsLimitHit) return "tmpfs-limit";
  if (evidence.outputOverflow) return evidence.outputOverflow;
  if (evidence.deadlineExceeded) return "deadline";
  if (evidence.launchFailed) return "launch-failed";
  return null;
}

export const fastManimSandboxResourceTerminationReasonV1Schema = z.enum([
  "aborted",
  "cleanup-failed",
  "completed",
  "cpu-limit",
  "deadline",
  "fd-limit",
  "file-limit",
  "launch-failed",
  "memory-limit",
  "pids-limit",
  "result-overflow",
  "shutdown",
  "stderr-overflow",
  "stdout-overflow",
  "tmpfs-limit",
]);

export type FastManimSandboxResourceTerminationReasonV1 = z.infer<
  typeof fastManimSandboxResourceTerminationReasonV1Schema
>;

export type FastManimSandboxResourceJobDescriptorV1 = Readonly<{
  cgroupName: string;
  deadlineEpochMs: number;
  jobId: string;
  limits: FastManimSandboxResourceLimitsV1;
  reservedFileDescriptors: number;
  reservedMemoryBytes: number;
  reservedOutputBytes: number;
  reservedTmpfsBytes: number;
  schema: typeof FAST_MANIM_SANDBOX_RESOURCE_JOB_SCHEMA_V1;
  version: typeof FAST_MANIM_SANDBOX_RESOURCE_JOB_VERSION_V1;
}>;

export type FastManimSandboxResourceRegistrySnapshotV1 = Readonly<{
  activeJobs: number;
  queuedJobs: 0;
  reapedJobs: number;
  reservedFileDescriptors: number;
  reservedMemoryBytes: number;
  reservedOutputBytes: number;
  reservedTmpfsBytes: number;
  state: "closed" | "closing" | "quarantined" | "ready" | "reconciling";
  terminated: ReadonlyArray<Readonly<{ count: number; reason: FastManimSandboxResourceTerminationReasonV1 }>>;
}>;

export type FastManimSandboxResourceAdmissionLeaseV1 = Readonly<{
  descriptor: FastManimSandboxResourceJobDescriptorV1;
  /** Records the final server-owned reason after cleanup is proven. */
  terminate: (reason: FastManimSandboxResourceTerminationReasonV1) => void;
  /** Returns reservations only after both the cgroup and every output pipe are closed. */
  reap: (evidence: Readonly<{ cgroupEmpty: true; outputClosed: true }>) => void;
  /** Permanently stops new admission and deliberately retains this reservation. */
  failClosed: () => void;
}>;

export type FastManimSandboxResourceRegistryOptionsV1 = Readonly<{
  maxActiveJobs?: number;
  maxReservedFileDescriptors?: number;
  maxReservedMemoryBytes?: number;
  maxReservedOutputBytes?: number;
  maxReservedTmpfsBytes?: number;
  now?: () => number;
  requireReconciliation?: boolean;
}>;

const registryOptionsSchema = z
  .object({
    maxActiveJobs: boundedSafeInteger("Global active jobs", 1, MAX_GLOBAL_ACTIVE_JOBS),
    maxReservedFileDescriptors: boundedSafeInteger("Global reserved file descriptors", 1, MAX_GLOBAL_FILE_DESCRIPTORS),
    maxReservedMemoryBytes: boundedSafeInteger("Global reserved memory", MIB, MAX_GLOBAL_RESOURCE_BYTES),
    maxReservedOutputBytes: boundedSafeInteger("Global reserved output", 1, MAX_GLOBAL_RESOURCE_BYTES),
    maxReservedTmpfsBytes: boundedSafeInteger("Global reserved tmpfs", MIB, MAX_GLOBAL_RESOURCE_BYTES),
  })
  .strict();

type ActiveReservation = {
  descriptor: FastManimSandboxResourceJobDescriptorV1;
  state: "active" | "terminated";
};

const resourceControlErrorCodes = new WeakMap<object, "capacity" | "cleanup" | "configuration" | "unavailable">();

export class FastManimSandboxResourceControlError extends Error {
  readonly code: "capacity" | "cleanup" | "configuration" | "unavailable";

  constructor(code: "capacity" | "cleanup" | "configuration" | "unavailable") {
    const messages = {
      capacity: "Sandbox resource capacity is exhausted.",
      cleanup: "Sandbox resource cleanup could not be proven complete.",
      configuration: "Sandbox resource configuration is invalid.",
      unavailable: "Sandbox resource control is unavailable.",
    } as const;
    super(messages[code]);
    this.name = "FastManimSandboxResourceControlError";
    this.code = code;
    resourceControlErrorCodes.set(this, code);
  }
}

export function fastManimSandboxResourceControlErrorCode(
  value: unknown,
): "capacity" | "cleanup" | "configuration" | "unavailable" | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return resourceControlErrorCodes.get(value);
}

function checkedOutputReservation(limits: FastManimSandboxResourceLimitsV1) {
  const stdoutAndStderr = limits.maxStdoutBytes + limits.maxStderrBytes;
  const total = stdoutAndStderr + limits.maxResultBytes;
  if (!Number.isSafeInteger(stdoutAndStderr) || !Number.isSafeInteger(total)) {
    throw new FastManimSandboxResourceControlError("configuration");
  }
  return total;
}

function checkedMemoryReservation(limits: FastManimSandboxResourceLimitsV1) {
  const total = limits.maxMemoryBytes + limits.maxSwapBytes;
  if (!Number.isSafeInteger(total)) throw new FastManimSandboxResourceControlError("configuration");
  return total;
}

function checkedFileDescriptorReservation(limits: FastManimSandboxResourceLimitsV1) {
  const total = limits.maxProcesses * limits.maxOpenFiles;
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_JOB_FILE_DESCRIPTORS) {
    throw new FastManimSandboxResourceControlError("configuration");
  }
  return total;
}

function checkedTmpfsReservation(limits: FastManimSandboxResourceLimitsV1) {
  const total = limits.maxRuntimeTmpfsBytes + limits.maxSharedMemoryBytes;
  if (!Number.isSafeInteger(total)) throw new FastManimSandboxResourceControlError("configuration");
  return total;
}

function exceedsReservation(current: number, requested: number, maximum: number) {
  return requested > maximum || current > maximum - requested;
}

const RESOURCE_CGROUP_NAME_PATTERN = /^poietra-job-v1-[0-9a-f]{32}-[1-9a-z][0-9a-z]*$/;
const RESOURCE_JOB_ID_PATTERN = /^[0-9a-f]{32}-[1-9a-z][0-9a-z]*$/;

export function isFastManimSandboxResourceCgroupNameV1(value: string) {
  return RESOURCE_CGROUP_NAME_PATTERN.test(value);
}

export const fastManimSandboxResourceJobDescriptorV1Schema = z
  .object({
    cgroupName: z.string().regex(RESOURCE_CGROUP_NAME_PATTERN),
    deadlineEpochMs: boundedSafeInteger("Resource job deadline", 1, Number.MAX_SAFE_INTEGER),
    jobId: z.string().regex(RESOURCE_JOB_ID_PATTERN),
    limits: fastManimSandboxResourceLimitsV1Schema,
    reservedFileDescriptors: boundedSafeInteger("Reserved file descriptors", 1, MAX_JOB_FILE_DESCRIPTORS),
    reservedMemoryBytes: boundedSafeInteger("Reserved memory", MIB, 2 * MAX_RESOURCE_BYTES),
    reservedOutputBytes: boundedSafeInteger("Reserved output", 1, 3 * MAX_RESOURCE_BYTES),
    reservedTmpfsBytes: boundedSafeInteger("Reserved tmpfs", 2 * MIB, 2 * MAX_RESOURCE_BYTES),
    schema: z.literal(FAST_MANIM_SANDBOX_RESOURCE_JOB_SCHEMA_V1),
    version: z.literal(FAST_MANIM_SANDBOX_RESOURCE_JOB_VERSION_V1),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.cgroupName !== `poietra-job-v1-${descriptor.jobId}`) {
      context.addIssue({ code: "custom", message: "Resource job and cgroup identities do not match." });
    }
    if (descriptor.reservedFileDescriptors !== checkedFileDescriptorReservation(descriptor.limits)) {
      context.addIssue({
        code: "custom",
        message: "Resource job file-descriptor reservation does not match its limits.",
      });
    }
    if (descriptor.reservedMemoryBytes !== checkedMemoryReservation(descriptor.limits)) {
      context.addIssue({ code: "custom", message: "Resource job memory reservation does not match its limits." });
    }
    if (descriptor.reservedOutputBytes !== checkedOutputReservation(descriptor.limits)) {
      context.addIssue({ code: "custom", message: "Resource job output reservation does not match its limits." });
    }
    if (descriptor.reservedTmpfsBytes !== checkedTmpfsReservation(descriptor.limits)) {
      context.addIssue({ code: "custom", message: "Resource job tmpfs reservation does not match its limits." });
    }
  });

export function parseFastManimSandboxResourceJobDescriptorV1(value: unknown): FastManimSandboxResourceJobDescriptorV1 {
  const parsed = fastManimSandboxResourceJobDescriptorV1Schema.parse(value);
  return Object.freeze({ ...parsed, limits: Object.freeze(parsed.limits) });
}

/**
 * Process-global, synchronous admission ledger. JavaScript execution makes the
 * check-and-reserve operation atomic with respect to other jobs in this
 * process. A reservation is intentionally not returned on cleanup failure:
 * the registry quarantines itself instead of assuming unknown OS state is
 * free. Descriptors contain only server-generated names and bounded numbers;
 * tenant, project, request, source, path, and backend text are never accepted.
 */
export class FastManimSandboxResourceRegistryV1 {
  readonly #active = new Map<string, ActiveReservation>();
  readonly #bootId = randomBytes(16).toString("hex");
  readonly #maxActiveJobs: number;
  readonly #maxReservedFileDescriptors: number;
  readonly #maxReservedMemoryBytes: number;
  readonly #maxReservedOutputBytes: number;
  readonly #maxReservedTmpfsBytes: number;
  readonly #now: () => number;
  readonly #terminated = new Map<FastManimSandboxResourceTerminationReasonV1, number>();
  #nextJobSequence = 1;
  #reapedJobs = 0;
  #reservedFileDescriptors = 0;
  #reservedMemoryBytes = 0;
  #reservedOutputBytes = 0;
  #reservedTmpfsBytes = 0;
  #state: FastManimSandboxResourceRegistrySnapshotV1["state"];

  constructor(options: FastManimSandboxResourceRegistryOptionsV1 = {}) {
    const parsed = registryOptionsSchema.parse({
      maxActiveJobs: options.maxActiveJobs ?? 4,
      maxReservedFileDescriptors: options.maxReservedFileDescriptors ?? DEFAULT_GLOBAL_FILE_DESCRIPTORS,
      maxReservedMemoryBytes: options.maxReservedMemoryBytes ?? 4 * GIB,
      maxReservedOutputBytes: options.maxReservedOutputBytes ?? 64 * MIB,
      maxReservedTmpfsBytes: options.maxReservedTmpfsBytes ?? GIB,
    });
    this.#maxActiveJobs = parsed.maxActiveJobs;
    this.#maxReservedFileDescriptors = parsed.maxReservedFileDescriptors;
    this.#maxReservedMemoryBytes = parsed.maxReservedMemoryBytes;
    this.#maxReservedOutputBytes = parsed.maxReservedOutputBytes;
    this.#maxReservedTmpfsBytes = parsed.maxReservedTmpfsBytes;
    this.#now = options.now ?? Date.now;
    this.#state = options.requireReconciliation === true ? "reconciling" : "ready";
  }

  markReconciled() {
    if (this.#state === "ready") return;
    if (this.#state !== "reconciling") throw new FastManimSandboxResourceControlError("unavailable");
    this.#state = "ready";
  }

  quarantine() {
    if (this.#state !== "closed") this.#state = "quarantined";
  }

  beginClose() {
    if (this.#state === "closed") return;
    if (this.#state === "reconciling") {
      this.#state = "quarantined";
      return;
    }
    if (this.#state !== "quarantined") this.#state = "closing";
  }

  finishClose() {
    if (this.#active.size !== 0 || this.#state === "quarantined") {
      this.#state = "quarantined";
      throw new FastManimSandboxResourceControlError("cleanup");
    }
    this.#state = "closed";
  }

  admit(value: unknown): FastManimSandboxResourceAdmissionLeaseV1 {
    if (this.#state !== "ready") throw new FastManimSandboxResourceControlError("unavailable");
    const limits = parseFastManimSandboxResourceLimitsV1(value);
    const fileDescriptors = checkedFileDescriptorReservation(limits);
    const memoryBytes = checkedMemoryReservation(limits);
    const outputBytes = checkedOutputReservation(limits);
    const tmpfsBytes = checkedTmpfsReservation(limits);
    if (
      this.#active.size >= this.#maxActiveJobs ||
      exceedsReservation(this.#reservedFileDescriptors, fileDescriptors, this.#maxReservedFileDescriptors) ||
      exceedsReservation(this.#reservedMemoryBytes, memoryBytes, this.#maxReservedMemoryBytes) ||
      exceedsReservation(this.#reservedOutputBytes, outputBytes, this.#maxReservedOutputBytes) ||
      exceedsReservation(this.#reservedTmpfsBytes, tmpfsBytes, this.#maxReservedTmpfsBytes)
    ) {
      throw new FastManimSandboxResourceControlError("capacity");
    }
    if (!Number.isSafeInteger(this.#nextJobSequence)) {
      this.quarantine();
      throw new FastManimSandboxResourceControlError("unavailable");
    }
    const jobId = `${this.#bootId}-${this.#nextJobSequence.toString(36)}`;
    this.#nextJobSequence += 1;
    const deadlineEpochMs = this.#now() + limits.wallTimeMs;
    if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= 0) {
      this.quarantine();
      throw new FastManimSandboxResourceControlError("unavailable");
    }
    const descriptor = parseFastManimSandboxResourceJobDescriptorV1({
      cgroupName: `poietra-job-v1-${jobId}`,
      deadlineEpochMs,
      jobId,
      limits,
      reservedFileDescriptors: fileDescriptors,
      reservedMemoryBytes: memoryBytes,
      reservedOutputBytes: outputBytes,
      reservedTmpfsBytes: tmpfsBytes,
      schema: FAST_MANIM_SANDBOX_RESOURCE_JOB_SCHEMA_V1,
      version: FAST_MANIM_SANDBOX_RESOURCE_JOB_VERSION_V1,
    });
    const reservation: ActiveReservation = { descriptor, state: "active" };
    this.#active.set(jobId, reservation);
    this.#reservedFileDescriptors += fileDescriptors;
    this.#reservedMemoryBytes += memoryBytes;
    this.#reservedOutputBytes += outputBytes;
    this.#reservedTmpfsBytes += tmpfsBytes;

    let settled = false;
    let terminationReason: FastManimSandboxResourceTerminationReasonV1 | null = null;
    const recordTermination = (reason: FastManimSandboxResourceTerminationReasonV1, replace = false) => {
      const parsedReason = fastManimSandboxResourceTerminationReasonV1Schema.parse(reason);
      if (settled || (reservation.state === "terminated" && !replace)) return;
      if (terminationReason) {
        const previousCount = this.#terminated.get(terminationReason)!;
        if (previousCount === 1) this.#terminated.delete(terminationReason);
        else this.#terminated.set(terminationReason, previousCount - 1);
      }
      reservation.state = "terminated";
      terminationReason = parsedReason;
      this.#terminated.set(parsedReason, (this.#terminated.get(parsedReason) ?? 0) + 1);
    };
    const terminate = (reason: FastManimSandboxResourceTerminationReasonV1) => recordTermination(reason);
    const reap = (evidence: Readonly<{ cgroupEmpty: true; outputClosed: true }>) => {
      if (settled) return;
      if (evidence?.cgroupEmpty !== true || evidence.outputClosed !== true) {
        recordTermination("cleanup-failed", true);
        settled = true;
        this.quarantine();
        throw new FastManimSandboxResourceControlError("cleanup");
      }
      terminate("completed");
      settled = true;
      this.#active.delete(jobId);
      this.#reservedFileDescriptors -= fileDescriptors;
      this.#reservedMemoryBytes -= memoryBytes;
      this.#reservedOutputBytes -= outputBytes;
      this.#reservedTmpfsBytes -= tmpfsBytes;
      this.#reapedJobs += 1;
    };
    const failClosed = () => {
      if (settled) return;
      recordTermination("cleanup-failed", true);
      settled = true;
      this.quarantine();
    };
    return Object.freeze({ descriptor, failClosed, reap, terminate });
  }

  snapshot(): FastManimSandboxResourceRegistrySnapshotV1 {
    return Object.freeze({
      activeJobs: this.#active.size,
      queuedJobs: 0,
      reapedJobs: this.#reapedJobs,
      reservedFileDescriptors: this.#reservedFileDescriptors,
      reservedMemoryBytes: this.#reservedMemoryBytes,
      reservedOutputBytes: this.#reservedOutputBytes,
      reservedTmpfsBytes: this.#reservedTmpfsBytes,
      state: this.#state,
      terminated: Object.freeze(
        [...this.#terminated.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([reason, count]) => Object.freeze({ count, reason })),
      ),
    });
  }
}

/** One process-global budget owner for the production resource controller. */
export const processFastManimSandboxResourceRegistryV1 = new FastManimSandboxResourceRegistryV1({
  requireReconciliation: true,
});
