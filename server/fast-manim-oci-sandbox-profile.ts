import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  copyFastManimSandboxUint8ArrayV1,
  type FastManimSandboxJobContextV1,
  type FastManimSandboxJobHandleV1,
  type FastManimSandboxRequestBundleV1,
  MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES,
  parseFastManimSandboxJobIdentityV1,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";

export const FAST_MANIM_OCI_PROFILE_SCHEMA_V1 = "poietra.fast-manim-oci-profile" as const;
export const FAST_MANIM_OCI_BUILD_ATTESTATION_SCHEMA_V1 = "poietra.fast-manim-oci-build-attestation" as const;
export const FAST_MANIM_OCI_JOB_DESCRIPTOR_SCHEMA_V1 = "poietra.fast-manim-oci-job" as const;
export const FAST_MANIM_OCI_ASSET_MANIFEST_SCHEMA_V1 = "poietra.fast-manim-oci-asset-manifest" as const;
export const FAST_MANIM_OCI_ASSET_CONTROL_FILE_V1 = ".poietra-assets.v1.json" as const;
export const FAST_MANIM_OCI_MAX_ASSETS_V1 = 64;
export const FAST_MANIM_OCI_MAX_ASSET_BYTES_V1 = 16 * 1024 * 1024;
export const FAST_MANIM_OCI_MAX_TOTAL_ASSET_BYTES_V1 = 16 * 1024 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const emptyStringsSchema = z.array(z.string()).max(0);
const fixedEnvironment = {
  HOME: z.literal("/run/poietra/home"),
  LANG: z.literal("C.UTF-8"),
  LC_ALL: z.literal("C.UTF-8"),
  MKL_NUM_THREADS: z.literal("1"),
  NUMEXPR_NUM_THREADS: z.literal("1"),
  OMP_NUM_THREADS: z.literal("1"),
  OPENBLAS_NUM_THREADS: z.literal("1"),
  PATH: z.literal("/opt/venv/bin:/usr/local/bin:/usr/bin:/bin"),
  PYTHONDONTWRITEBYTECODE: z.literal("1"),
  PYTHONHASHSEED: z.literal("0"),
  PYTHONNOUSERSITE: z.literal("1"),
  TMPDIR: z.literal("/run/poietra/tmp"),
  TZ: z.literal("UTC"),
  VECLIB_MAXIMUM_THREADS: z.literal("1"),
  XDG_CACHE_HOME: z.literal("/run/poietra/cache"),
  XDG_CONFIG_HOME: z.literal("/run/poietra/config"),
  XDG_DATA_HOME: z.literal("/run/poietra/data"),
};

const tmpfsSchema = z
  .object({
    destination: z.enum(["/dev/shm", "/run/poietra"]),
    maximumInodes: z.union([z.literal(1024), z.literal(4096)]),
    mode: z.literal(0o1777),
    options: z.tuple([z.literal("nodev"), z.literal("noexec"), z.literal("nosuid")]),
    sizeBytes: z.union([z.literal(4 * 1024 * 1024), z.literal(16 * 1024 * 1024)]),
    type: z.literal("tmpfs"),
  })
  .strict();

export const fastManimOciProfileV1Schema = z
  .object({
    assets: z
      .object({
        controlFile: z.literal(FAST_MANIM_OCI_ASSET_CONTROL_FILE_V1),
        destinationRoot: z.literal("/opt/poietra/assets"),
        injection: z.literal("digest-verified-read-only-request-volume"),
        manifestSchema: z.literal(FAST_MANIM_OCI_ASSET_MANIFEST_SCHEMA_V1),
        maximumAssetBytes: z.literal(FAST_MANIM_OCI_MAX_ASSET_BYTES_V1),
        maximumAssets: z.literal(FAST_MANIM_OCI_MAX_ASSETS_V1),
        maximumTotalAssetBytes: z.literal(FAST_MANIM_OCI_MAX_TOTAL_ASSET_BYTES_V1),
        readOnlyAtExecution: z.literal(true),
      })
      .strict(),
    capabilities: z
      .object({
        ambient: emptyStringsSchema,
        bounding: emptyStringsSchema,
        effective: emptyStringsSchema,
        inheritable: emptyStringsSchema,
        permitted: emptyStringsSchema,
      })
      .strict(),
    environment: z.object(fixedEnvironment).strict(),
    hostExposure: z
      .object({
        credentialForwarding: z.literal(false),
        environmentInheritance: z.literal(false),
        genericMounts: z.literal(false),
        projectRootMount: z.literal(false),
        runtimeSocketMount: z.literal(false),
      })
      .strict(),
    identity: z
      .object({
        gid: z.literal(65532),
        groups: emptyStringsSchema,
        uid: z.literal(65532),
        username: z.literal("poietra-sandbox"),
      })
      .strict(),
    namespaces: z
      .object({
        cgroup: z.literal("private"),
        ipc: z.literal("private"),
        network: z.literal("isolated-none"),
        pid: z.literal("private"),
        uts: z.literal("private"),
      })
      .strict(),
    network: z
      .object({
        dns: z.literal(false),
        loopback: z.literal(false),
        metadata: z.literal(false),
        mode: z.literal("none"),
        socketSyscalls: z.literal(false),
        unixSockets: z.literal(false),
      })
      .strict(),
    noNewPrivileges: z.literal(true),
    platform: z.literal("linux/amd64"),
    proc: z
      .object({
        maskedPaths: z.tuple([
          z.literal("/proc/acpi"),
          z.literal("/proc/asound"),
          z.literal("/proc/interrupts"),
          z.literal("/proc/kcore"),
          z.literal("/proc/keys"),
          z.literal("/proc/latency_stats"),
          z.literal("/proc/sched_debug"),
          z.literal("/proc/scsi"),
          z.literal("/proc/timer_list"),
          z.literal("/proc/timer_stats"),
          z.literal("/sys/devices/virtual/powercap"),
          z.literal("/sys/firmware"),
        ]),
        readOnlyPaths: z.tuple([
          z.literal("/proc/bus"),
          z.literal("/proc/fs"),
          z.literal("/proc/irq"),
          z.literal("/proc/sys"),
          z.literal("/proc/sysrq-trigger"),
        ]),
      })
      .strict(),
    process: z
      .object({
        launcher: z.tuple([z.literal("/opt/venv/bin/python"), z.literal("/opt/poietra/entrypoint.py")]),
        requestTransport: z.literal("stdin"),
        target: z.tuple([
          z.literal("/opt/venv/bin/python"),
          z.literal("-m"),
          z.literal("manim.renderer.source_runtime_identity"),
        ]),
        workingDirectory: z.literal("/run/poietra"),
      })
      .strict(),
    rootFilesystem: z.object({ readOnly: z.literal(true) }).strict(),
    schema: z.literal(FAST_MANIM_OCI_PROFILE_SCHEMA_V1),
    seccomp: z.object({ profile: z.literal("seccomp.v1.json"), required: z.literal(true) }).strict(),
    version: z.literal(1),
    writableFilesystems: z.tuple([tmpfsSchema, tmpfsSchema]).superRefine((filesystems, context) => {
      const expected = new Map([
        ["/run/poietra", { maximumInodes: 4096, sizeBytes: 16 * 1024 * 1024 }],
        ["/dev/shm", { maximumInodes: 1024, sizeBytes: 4 * 1024 * 1024 }],
      ]);
      for (const filesystem of filesystems) {
        const contract = expected.get(filesystem.destination);
        if (contract?.sizeBytes !== filesystem.sizeBytes || contract?.maximumInodes !== filesystem.maximumInodes) {
          context.addIssue({ code: "custom", message: "OCI tmpfs destination/size pair is not locked." });
        }
        expected.delete(filesystem.destination);
      }
      if (expected.size !== 0) context.addIssue({ code: "custom", message: "A locked OCI tmpfs is missing." });
    }),
  })
  .strict();

export type FastManimOciProfileV1 = z.infer<typeof fastManimOciProfileV1Schema>;

export const fastManimOciBuildAttestationV1Schema = z
  .object({
    buildLockDigest: sha256Schema,
    fastManim: z
      .object({
        archiveSha256: sha256Schema,
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        tree: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .strict(),
    imageConfigDigest: imageDigestSchema,
    imageDigest: imageDigestSchema,
    platform: z.literal("linux/amd64"),
    profileDigest: sha256Schema,
    runtimeDigest: sha256Schema,
    sbom: z
      .object({
        digest: sha256Schema,
        schema: z.literal("poietra.fast-manim-oci-sbom"),
        signed: z.literal(false),
        toolchainDigest: sha256Schema,
      })
      .strict(),
    schema: z.literal(FAST_MANIM_OCI_BUILD_ATTESTATION_SCHEMA_V1),
    seccompDigest: sha256Schema,
    version: z.literal(1),
  })
  .strict()
  .superRefine((attestation, context) => {
    const runtimeDigest = createHash("sha256")
      .update(
        canonicalJsonV1({
          imageConfigDigest: attestation.imageConfigDigest,
          imageDigest: attestation.imageDigest,
          inventoryDigest: attestation.sbom.digest,
          lockDigest: attestation.buildLockDigest,
          profileDigest: attestation.profileDigest,
          seccompDigest: attestation.seccompDigest,
        }),
        "utf8",
      )
      .digest("hex");
    if (runtimeDigest !== attestation.runtimeDigest) {
      context.addIssue({ code: "custom", message: "OCI runtime digest is not derived from its locked materials." });
    }
  });

export type FastManimOciBuildAttestationV1 = z.infer<typeof fastManimOciBuildAttestationV1Schema>;

const assetDescriptorSchema = z
  .object({
    byteLength: z.number().int().nonnegative().max(FAST_MANIM_OCI_MAX_ASSET_BYTES_V1),
    fileName: sha256Schema,
    gid: z.literal(0),
    mode: z.literal(0o444),
    sha256: sha256Schema,
    uid: z.literal(0),
  })
  .strict()
  .refine((asset) => asset.fileName === asset.sha256, "OCI asset filenames must be their digest only.");

export const fastManimOciJobDescriptorV1Schema = z
  .object({
    assets: z.array(assetDescriptorSchema).max(FAST_MANIM_OCI_MAX_ASSETS_V1),
    imageDigest: imageDigestSchema,
    profileDigest: sha256Schema,
    request: z
      .object({
        byteLength: z.number().int().nonnegative().max(MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES),
        sha256: sha256Schema,
        transport: z.literal("stdin"),
      })
      .strict(),
    runtimeDigest: sha256Schema,
    sbomDigest: sha256Schema,
    schema: z.literal(FAST_MANIM_OCI_JOB_DESCRIPTOR_SCHEMA_V1),
    seccompDigest: sha256Schema,
    version: z.literal(1),
  })
  .strict()
  .superRefine((descriptor, context) => {
    let totalBytes = 0;
    for (const [index, asset] of descriptor.assets.entries()) {
      if (index > 0 && descriptor.assets[index - 1]!.sha256 >= asset.sha256) {
        context.addIssue({ code: "custom", message: "OCI assets must be digest-sorted and unique." });
      }
      totalBytes += asset.byteLength;
    }
    if (totalBytes > FAST_MANIM_OCI_MAX_TOTAL_ASSET_BYTES_V1) {
      context.addIssue({ code: "custom", message: "OCI assets exceed the cumulative byte budget." });
    }
  });

type ParsedFastManimOciJobDescriptorV1 = z.infer<typeof fastManimOciJobDescriptorV1Schema>;
export type FastManimOciJobDescriptorV1 = Readonly<
  Omit<ParsedFastManimOciJobDescriptorV1, "assets" | "request"> & {
    assets: readonly Readonly<ParsedFastManimOciJobDescriptorV1["assets"][number]>[];
    request: Readonly<ParsedFastManimOciJobDescriptorV1["request"]>;
  }
>;
export type FastManimOciAssetInputV1 = Readonly<{ bytes: Uint8Array; sha256: string }>;
export type FastManimOciBrokerAssetCopyV1 = Readonly<{
  bytes: Uint8Array;
  descriptor: z.infer<typeof assetDescriptorSchema>;
}>;

function digestBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestFastManimOciProfileV1(value: unknown) {
  const profile = fastManimOciProfileV1Schema.parse(value);
  return createHash("sha256").update(canonicalJsonV1(profile), "utf8").digest("hex");
}

export class FastManimOciAssetBundleV1 {
  readonly descriptors: readonly z.infer<typeof assetDescriptorSchema>[];
  readonly #assets: readonly FastManimOciBrokerAssetCopyV1[];

  constructor(profileValue: unknown, inputs: readonly FastManimOciAssetInputV1[]) {
    const profile = fastManimOciProfileV1Schema.parse(profileValue);
    if (inputs.length > profile.assets.maximumAssets)
      throw new RangeError("OCI asset count exceeds the locked budget.");
    const assets: FastManimOciBrokerAssetCopyV1[] = [];
    let totalBytes = 0;
    for (const input of inputs) {
      const claimedDigest = sha256Schema.parse(input.sha256);
      const bytes = copyFastManimSandboxUint8ArrayV1(input.bytes, profile.assets.maximumAssetBytes);
      const verificationCopy = copyFastManimSandboxUint8ArrayV1(bytes, profile.assets.maximumAssetBytes);
      if (digestBytes(bytes) !== claimedDigest || digestBytes(verificationCopy) !== claimedDigest) {
        throw new TypeError("OCI owned asset bytes do not match their digest across verification copies.");
      }
      totalBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > profile.assets.maximumTotalAssetBytes) {
        throw new RangeError("OCI assets exceed the locked cumulative byte budget.");
      }
      assets.push({
        bytes,
        descriptor: {
          byteLength: bytes.byteLength,
          fileName: claimedDigest,
          gid: 0,
          mode: 0o444,
          sha256: claimedDigest,
          uid: 0,
        },
      });
    }
    assets.sort((left, right) => {
      if (left.descriptor.sha256 < right.descriptor.sha256) return -1;
      if (left.descriptor.sha256 > right.descriptor.sha256) return 1;
      return 0;
    });
    for (let index = 1; index < assets.length; index += 1) {
      if (assets[index - 1]!.descriptor.sha256 === assets[index]!.descriptor.sha256) {
        throw new TypeError("OCI asset digests must be unique.");
      }
    }
    this.#assets = assets;
    this.descriptors = Object.freeze(assets.map((asset) => Object.freeze(asset.descriptor)));
    Object.freeze(this);
  }

  copyAssets(): readonly FastManimOciBrokerAssetCopyV1[] {
    return Object.freeze(
      this.#assets.map((asset) => {
        const bytes = copyFastManimSandboxUint8ArrayV1(asset.bytes, FAST_MANIM_OCI_MAX_ASSET_BYTES_V1);
        if (digestBytes(bytes) !== asset.descriptor.sha256)
          throw new TypeError("OCI asset changed before broker dispatch.");
        return Object.freeze({ bytes, descriptor: asset.descriptor });
      }),
    );
  }
}

export function prepareFastManimOciAssetsV1(profileValue: unknown, inputs: readonly FastManimOciAssetInputV1[]) {
  return new FastManimOciAssetBundleV1(profileValue, inputs);
}

export class FastManimOciBrokerDispatchV1 {
  readonly context: FastManimSandboxJobContextV1;
  readonly descriptor: FastManimOciJobDescriptorV1;
  readonly #assets: FastManimOciAssetBundleV1;
  readonly #requestBytes: Uint8Array;

  constructor(
    context: FastManimSandboxJobContextV1,
    descriptorValue: unknown,
    requestBytes: Uint8Array,
    assets: FastManimOciAssetBundleV1,
  ) {
    const descriptor = fastManimOciJobDescriptorV1Schema.parse(descriptorValue);
    if (
      !sha256Schema.safeParse(context.attestationDigest).success ||
      !Number.isSafeInteger(context.deadlineEpochMs) ||
      context.deadlineEpochMs <= 0 ||
      typeof context.signal?.aborted !== "boolean" ||
      typeof context.signal?.addEventListener !== "function"
    ) {
      throw new TypeError("OCI broker dispatch context is malformed.");
    }
    if (!(assets instanceof FastManimOciAssetBundleV1)) {
      throw new TypeError("OCI broker dispatch assets must be an owned asset bundle.");
    }
    const ownedRequestBytes = copyFastManimSandboxUint8ArrayV1(requestBytes, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
    if (
      digestBytes(ownedRequestBytes) !== descriptor.request.sha256 ||
      ownedRequestBytes.byteLength !== descriptor.request.byteLength ||
      canonicalJsonV1(descriptor.assets) !== canonicalJsonV1(assets.descriptors)
    ) {
      throw new TypeError("OCI broker dispatch bytes/assets do not match the closed descriptor.");
    }
    this.context = Object.freeze({
      attestationDigest: context.attestationDigest,
      deadlineEpochMs: context.deadlineEpochMs,
      identity: parseFastManimSandboxJobIdentityV1(context.identity),
      signal: context.signal,
    });
    this.descriptor = Object.freeze({
      ...descriptor,
      assets: Object.freeze(descriptor.assets.map((asset) => Object.freeze({ ...asset }))),
      request: Object.freeze({ ...descriptor.request }),
    });
    this.#requestBytes = ownedRequestBytes;
    this.#assets = assets;
    Object.freeze(this);
  }

  copyAssets() {
    return this.#assets.copyAssets();
  }

  copyRequestBytes() {
    const bytes = copyFastManimSandboxUint8ArrayV1(this.#requestBytes, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
    if (
      digestBytes(bytes) !== this.descriptor.request.sha256 ||
      bytes.byteLength !== this.descriptor.request.byteLength
    ) {
      throw new TypeError("OCI request changed before broker dispatch.");
    }
    return bytes;
  }
}

/**
 * Production-facing broker boundary. It intentionally has no argv, env,
 * mount, host path, socket, tag, or generic runtime-options field. A local
 * Docker implementation belongs only to the conformance harness. Parsing the
 * unsigned build attestation establishes shape/correlation only; a production
 * broker must apply the signed trust and allowlist gate tracked by issue #85.
 */
export interface FastManimOciJobBrokerV1 {
  close(): Promise<void>;
  dispatch(job: FastManimOciBrokerDispatchV1): FastManimSandboxJobHandleV1;
}

export function createFastManimOciBrokerDispatchV1(
  options: Readonly<{
    assets?: readonly FastManimOciAssetInputV1[];
    attestation: unknown;
    context: FastManimSandboxJobContextV1;
    profile: unknown;
    request: FastManimSandboxRequestBundleV1;
  }>,
): FastManimOciBrokerDispatchV1 {
  const profile = fastManimOciProfileV1Schema.parse(options.profile);
  const attestation = fastManimOciBuildAttestationV1Schema.parse(options.attestation);
  const profileDigest = digestFastManimOciProfileV1(profile);
  if (attestation.profileDigest !== profileDigest) {
    throw new TypeError("OCI profile bytes do not match the build attestation.");
  }
  if (!verifyFastManimSandboxRequestBundleV1(options.request)) {
    throw new TypeError("OCI request bytes do not match their immutable request digest.");
  }
  const requestBytes = options.request.copyBytes();
  if (digestBytes(requestBytes) !== options.request.requestDigest) {
    throw new TypeError("OCI request bytes changed while creating the broker dispatch.");
  }
  const assets = prepareFastManimOciAssetsV1(profile, options.assets ?? []);
  const descriptor = fastManimOciJobDescriptorV1Schema.parse({
    assets: assets.descriptors,
    imageDigest: attestation.imageDigest,
    profileDigest: attestation.profileDigest,
    request: {
      byteLength: requestBytes.byteLength,
      sha256: options.request.requestDigest,
      transport: "stdin",
    },
    runtimeDigest: attestation.runtimeDigest,
    sbomDigest: attestation.sbom.digest,
    schema: FAST_MANIM_OCI_JOB_DESCRIPTOR_SCHEMA_V1,
    seccompDigest: attestation.seccompDigest,
    version: 1,
  });
  return new FastManimOciBrokerDispatchV1(options.context, descriptor, requestBytes, assets);
}
