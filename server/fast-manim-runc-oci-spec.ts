import { createHash } from "node:crypto";
import { posix } from "node:path";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import type { LinuxCgroupV2LaunchEnvelopeV1 } from "./fast-manim-linux-cgroup-v2";
import { type FastManimOciProfileV1, fastManimOciProfileV1Schema } from "./fast-manim-oci-sandbox-profile";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CGROUPS_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_@:-][A-Za-z0-9_.@:-]*$/u;
const MAX_HOST_PATH_BYTES = 4096;

const seccompArgumentSchema = z
  .object({
    index: z.number().int().nonnegative(),
    op: z.enum([
      "SCMP_CMP_NE",
      "SCMP_CMP_LT",
      "SCMP_CMP_LE",
      "SCMP_CMP_EQ",
      "SCMP_CMP_GE",
      "SCMP_CMP_GT",
      "SCMP_CMP_MASKED_EQ",
    ]),
    value: z.number().int().nonnegative(),
    valueTwo: z.number().int().nonnegative().optional(),
  })
  .strict();

const seccompSyscallSchema = z
  .object({
    action: z.enum(["SCMP_ACT_ALLOW", "SCMP_ACT_ERRNO"]),
    args: z.array(seccompArgumentSchema).optional(),
    errnoRet: z.number().int().nonnegative().optional(),
    names: z.array(z.string().min(1)).min(1),
  })
  .strict();

const dockerSeccompV1Schema = z
  .object({
    archMap: z.tuple([
      z
        .object({
          architecture: z.literal("SCMP_ARCH_X86_64"),
          subArchitectures: z.tuple([z.literal("SCMP_ARCH_X86"), z.literal("SCMP_ARCH_X32")]),
        })
        .strict(),
      z
        .object({
          architecture: z.literal("SCMP_ARCH_AARCH64"),
          subArchitectures: z.tuple([z.literal("SCMP_ARCH_ARM")]),
        })
        .strict(),
    ]),
    defaultAction: z.literal("SCMP_ACT_ERRNO"),
    defaultErrnoRet: z.literal(1),
    listenerMetadata: z.literal(""),
    listenerPath: z.literal(""),
    syscalls: z.tuple([seccompSyscallSchema, seccompSyscallSchema, seccompSyscallSchema]),
  })
  .strict()
  .superRefine((seccomp, context) => {
    const [allow, clone, clone3] = seccomp.syscalls;
    if (allow.action !== "SCMP_ACT_ALLOW" || allow.args !== undefined || allow.errnoRet !== undefined) {
      context.addIssue({ code: "custom", message: "The broad seccomp allow rule is not locked." });
    }
    if (
      clone.action !== "SCMP_ACT_ALLOW" ||
      clone.errnoRet !== undefined ||
      canonicalJsonV1(clone.names) !== canonicalJsonV1(["clone"]) ||
      canonicalJsonV1(clone.args) !==
        canonicalJsonV1([{ index: 0, op: "SCMP_CMP_MASKED_EQ", value: 2_114_060_416, valueTwo: 0 }])
    ) {
      context.addIssue({ code: "custom", message: "The restricted clone seccomp rule is not locked." });
    }
    if (
      clone3.action !== "SCMP_ACT_ERRNO" ||
      clone3.errnoRet !== 38 ||
      clone3.args !== undefined ||
      canonicalJsonV1(clone3.names) !== canonicalJsonV1(["clone3"])
    ) {
      context.addIssue({ code: "custom", message: "The clone3 seccomp fallback rule is not locked." });
    }
    const names = seccomp.syscalls.flatMap((rule) => rule.names);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "The seccomp syscall rules contain duplicate names." });
    }
  });

type DockerSeccompV1 = z.infer<typeof dockerSeccompV1Schema>;

export type FastManimRuncOciSpecGeneratorOptionsV1 = Readonly<{
  assetsSourcePath: string;
  expectedSeccompDigest: string;
  profile: unknown;
  rootfsPath: string;
  seccomp: unknown;
}>;

function canonicalAbsoluteHostPath(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_HOST_PATH_BYTES ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.endsWith("/") ||
    value === "/"
  ) {
    throw new TypeError(`${label} must be a canonical absolute non-root POSIX path.`);
  }
  return value;
}

function verifiedSeccomp(seccompValue: unknown, expectedDigestValue: unknown) {
  if (typeof expectedDigestValue !== "string" || !SHA256_PATTERN.test(expectedDigestValue)) {
    throw new TypeError("The expected seccomp digest must be a lowercase SHA-256 digest.");
  }
  const actualDigest = createHash("sha256").update(canonicalJsonV1(seccompValue), "utf8").digest("hex");
  if (actualDigest !== expectedDigestValue) {
    throw new TypeError("The Docker seccomp profile does not match its expected digest.");
  }
  return dockerSeccompV1Schema.parse(seccompValue);
}

function canonicalCgroupsPath(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) {
    throw new TypeError("The runc cgroupsPath must be a bounded canonical relative path.");
  }
  const segments = value.split("/");
  if (
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    !segments.every((segment) => CGROUPS_PATH_SEGMENT_PATTERN.test(segment))
  ) {
    throw new TypeError("The runc cgroupsPath must be a bounded canonical relative path.");
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string, minimum = 1) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function assertLaunchEnvelope(
  launch: LinuxCgroupV2LaunchEnvelopeV1,
  profile: FastManimOciProfileV1,
): Readonly<{
  cgroupsPath: string;
  rlimits: LinuxCgroupV2LaunchEnvelopeV1["rlimits"];
  tmpfs: LinuxCgroupV2LaunchEnvelopeV1["tmpfs"];
}> {
  if (
    typeof launch !== "object" ||
    launch === null ||
    launch.mustStartInCgroup !== true ||
    launch.productionMembership?.state !== "requires-direct-start-verification" ||
    !Number.isSafeInteger(launch.deadlineEpochMs) ||
    launch.deadlineEpochMs <= Date.now()
  ) {
    throw new TypeError("The runc launch envelope is malformed.");
  }
  const cgroupsPath = canonicalCgroupsPath(launch.cgroupsPath);
  const rlimits = Object.freeze({
    cpuTimeSeconds: positiveSafeInteger(launch.rlimits?.cpuTimeSeconds, "CPU rlimit"),
    fileBytes: positiveSafeInteger(launch.rlimits?.fileBytes, "File-size rlimit"),
    openFiles: positiveSafeInteger(launch.rlimits?.openFiles, "Open-file rlimit", 3),
  });
  const tmpfs = Object.freeze({
    runtime: Object.freeze({
      maximumInodes: positiveSafeInteger(launch.tmpfs?.runtime?.maximumInodes, "Runtime tmpfs inode limit"),
      sizeBytes: positiveSafeInteger(launch.tmpfs?.runtime?.sizeBytes, "Runtime tmpfs byte limit"),
    }),
    sharedMemory: Object.freeze({
      maximumInodes: positiveSafeInteger(launch.tmpfs?.sharedMemory?.maximumInodes, "Shared-memory tmpfs inode limit"),
      sizeBytes: positiveSafeInteger(launch.tmpfs?.sharedMemory?.sizeBytes, "Shared-memory tmpfs byte limit"),
    }),
  });
  const profileFilesystems = new Map(
    profile.writableFilesystems.map((filesystem) => [filesystem.destination, filesystem]),
  );
  const runtimeCap = profileFilesystems.get("/run/poietra")!;
  const sharedMemoryCap = profileFilesystems.get("/dev/shm")!;
  if (
    tmpfs.runtime.maximumInodes > runtimeCap.maximumInodes ||
    tmpfs.runtime.sizeBytes > runtimeCap.sizeBytes ||
    tmpfs.sharedMemory.maximumInodes > sharedMemoryCap.maximumInodes ||
    tmpfs.sharedMemory.sizeBytes > sharedMemoryCap.sizeBytes
  ) {
    throw new TypeError("The runc tmpfs envelope exceeds the immutable OCI profile.");
  }
  return Object.freeze({ cgroupsPath, rlimits, tmpfs });
}

function frozenSeccompRule(rule: DockerSeccompV1["syscalls"][number]) {
  return Object.freeze({
    action: rule.action,
    ...(rule.args === undefined
      ? {}
      : {
          args: Object.freeze(
            rule.args.map((argument) =>
              Object.freeze({
                index: argument.index,
                op: argument.op,
                value: argument.value,
                ...(argument.valueTwo === undefined ? {} : { valueTwo: argument.valueTwo }),
              }),
            ),
          ),
        }),
    ...(rule.errnoRet === undefined ? {} : { errnoRet: rule.errnoRet }),
    names: Object.freeze([...rule.names]),
  });
}

const STANDARD_DEVICE_IDENTITIES = [
  ["/dev/null", 1, 3],
  ["/dev/zero", 1, 5],
  ["/dev/full", 1, 7],
  ["/dev/random", 1, 8],
  ["/dev/urandom", 1, 9],
  ["/dev/tty", 5, 0],
] as const;

const STANDARD_DEVICES = Object.freeze(
  STANDARD_DEVICE_IDENTITIES.map(([path, major, minor]) =>
    Object.freeze({
      fileMode: 0o666,
      gid: 0,
      major,
      minor,
      path,
      type: "c" as const,
      uid: 0,
    }),
  ),
);

const STANDARD_DEVICE_RULES = Object.freeze([
  Object.freeze({ access: "rwm" as const, allow: false }),
  ...STANDARD_DEVICES.map((device) =>
    Object.freeze({
      access: "rwm" as const,
      allow: true,
      major: device.major,
      minor: device.minor,
      type: device.type,
    }),
  ),
]);

/**
 * Owns every host path and executable contract used to construct runc config.json.
 * A job can supply only the server-created resource launch envelope.
 */
export class FastManimRuncOciSpecGeneratorV1 {
  readonly #assetsSourcePath: string;
  readonly #profile: FastManimOciProfileV1;
  readonly #rootfsPath: string;
  readonly #seccomp: DockerSeccompV1;

  constructor(options: FastManimRuncOciSpecGeneratorOptionsV1) {
    this.#rootfsPath = canonicalAbsoluteHostPath(options.rootfsPath, "The runc rootfs path");
    this.#assetsSourcePath = canonicalAbsoluteHostPath(options.assetsSourcePath, "The runc asset source path");
    if (this.#rootfsPath === this.#assetsSourcePath) {
      throw new TypeError("The runc rootfs and asset source paths must be distinct.");
    }
    this.#profile = fastManimOciProfileV1Schema.parse(options.profile);
    this.#seccomp = verifiedSeccomp(options.seccomp, options.expectedSeccompDigest);
    Object.freeze(this);
  }

  generate(launchValue: LinuxCgroupV2LaunchEnvelopeV1) {
    const launch = assertLaunchEnvelope(launchValue, this.#profile);
    const profile = this.#profile;
    const environment = Object.freeze(
      Object.entries(profile.environment)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, value]) => `${name}=${value}`),
    );
    const capabilities = Object.freeze({
      ambient: Object.freeze([...profile.capabilities.ambient]),
      bounding: Object.freeze([...profile.capabilities.bounding]),
      effective: Object.freeze([...profile.capabilities.effective]),
      inheritable: Object.freeze([...profile.capabilities.inheritable]),
      permitted: Object.freeze([...profile.capabilities.permitted]),
    });
    const mounts = Object.freeze([
      Object.freeze({
        destination: "/proc",
        options: Object.freeze(["nosuid", "noexec", "nodev"]),
        source: "proc",
        type: "proc" as const,
      }),
      Object.freeze({
        destination: "/dev",
        options: Object.freeze(["nosuid", "noexec", "strictatime", "mode=755", "size=65536"]),
        source: "tmpfs",
        type: "tmpfs" as const,
      }),
      Object.freeze({
        destination: "/dev/pts",
        options: Object.freeze(["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"]),
        source: "devpts",
        type: "devpts" as const,
      }),
      Object.freeze({
        destination: "/run/poietra",
        options: Object.freeze([
          "nodev",
          "noexec",
          "nosuid",
          `mode=${profile.writableFilesystems.find((filesystem) => filesystem.destination === "/run/poietra")!.mode.toString(8)}`,
          `size=${launch.tmpfs.runtime.sizeBytes}`,
          `nr_inodes=${launch.tmpfs.runtime.maximumInodes}`,
        ]),
        source: "tmpfs",
        type: "tmpfs" as const,
      }),
      Object.freeze({
        destination: "/dev/shm",
        options: Object.freeze([
          "nodev",
          "noexec",
          "nosuid",
          `mode=${profile.writableFilesystems.find((filesystem) => filesystem.destination === "/dev/shm")!.mode.toString(8)}`,
          `size=${launch.tmpfs.sharedMemory.sizeBytes}`,
          `nr_inodes=${launch.tmpfs.sharedMemory.maximumInodes}`,
        ]),
        source: "tmpfs",
        type: "tmpfs" as const,
      }),
      Object.freeze({
        destination: profile.assets.destinationRoot,
        options: Object.freeze(["rbind", "ro", "nosuid", "nodev", "noexec"]),
        source: this.#assetsSourcePath,
        type: "bind" as const,
      }),
    ]);
    return Object.freeze({
      hostname: "poietra-sandbox",
      linux: Object.freeze({
        cgroupsPath: launch.cgroupsPath,
        devices: STANDARD_DEVICES,
        maskedPaths: Object.freeze([...profile.proc.maskedPaths]),
        namespaces: Object.freeze(
          (["pid", "network", "mount", "ipc", "uts", "cgroup"] as const).map((type) => Object.freeze({ type })),
        ),
        readonlyPaths: Object.freeze([...profile.proc.readOnlyPaths]),
        resources: Object.freeze({ devices: STANDARD_DEVICE_RULES }),
        seccomp: Object.freeze({
          architectures: Object.freeze([
            this.#seccomp.archMap[0].architecture,
            ...this.#seccomp.archMap[0].subArchitectures,
          ]),
          defaultAction: this.#seccomp.defaultAction,
          defaultErrnoRet: this.#seccomp.defaultErrnoRet,
          syscalls: Object.freeze(this.#seccomp.syscalls.map(frozenSeccompRule)),
        }),
      }),
      mounts,
      ociVersion: "1.2.0",
      process: Object.freeze({
        args: Object.freeze([...profile.process.launcher, ...profile.process.target]),
        capabilities,
        cwd: profile.process.workingDirectory,
        env: environment,
        noNewPrivileges: profile.noNewPrivileges,
        rlimits: Object.freeze([
          Object.freeze({ hard: 0, soft: 0, type: "RLIMIT_CORE" as const }),
          Object.freeze({
            hard: launch.rlimits.cpuTimeSeconds,
            soft: launch.rlimits.cpuTimeSeconds,
            type: "RLIMIT_CPU" as const,
          }),
          Object.freeze({
            hard: launch.rlimits.fileBytes,
            soft: launch.rlimits.fileBytes,
            type: "RLIMIT_FSIZE" as const,
          }),
          Object.freeze({
            hard: launch.rlimits.openFiles,
            soft: launch.rlimits.openFiles,
            type: "RLIMIT_NOFILE" as const,
          }),
        ]),
        terminal: false,
        user: Object.freeze({
          additionalGids: Object.freeze([]),
          gid: profile.identity.gid,
          uid: profile.identity.uid,
        }),
      }),
      root: Object.freeze({ path: this.#rootfsPath, readonly: profile.rootFilesystem.readOnly }),
    });
  }
}

export type FastManimRuncOciSpecV1 = ReturnType<FastManimRuncOciSpecGeneratorV1["generate"]>;
