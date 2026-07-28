import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";

const harness = vi.hoisted(() => ({
  controller: undefined as
    | Readonly<{
        initialize: ReturnType<typeof vi.fn>;
        shutdown: ReturnType<typeof vi.fn>;
      }>
    | undefined,
  events: [] as string[],
  initializeError: undefined as unknown,
  productionRootfs: new WeakSet<object>(),
  shutdownError: undefined as unknown,
}));

vi.mock("./fast-manim-linux-cgroup-v2", async (importOriginal) => {
  const original = await importOriginal<typeof import("./fast-manim-linux-cgroup-v2")>();
  return {
    ...original,
    createProcessLinuxCgroupV2ResourceControllerV1: vi.fn(() => {
      harness.events.push("cgroup:create");
      const controller = {
        admit: vi.fn(() => Promise.reject(new Error("not exercised"))),
        assertReady: vi.fn(async () => {}),
        initialize: vi.fn(async () => {
          harness.events.push("cgroup:initialize");
          if (harness.initializeError) throw harness.initializeError;
        }),
        shutdown: vi.fn(async () => {
          harness.events.push("cgroup:shutdown");
          if (harness.shutdownError) throw harness.shutdownError;
        }),
        snapshot: vi.fn(() => ({ state: "ready" })),
      };
      harness.controller = controller;
      return controller;
    }),
    isProductionLinuxCgroupV2ResourceControllerV1: (value: unknown) => value === harness.controller,
  };
});

vi.mock("./fast-manim-runc-mounted-rootfs", () => {
  class MountedRootfsHandle {
    readonly registry: MountedRootfsRegistry;

    constructor(registry: MountedRootfsRegistry) {
      this.registry = registry;
    }

    assertReady(signal: AbortSignal) {
      return this.registry.assertReady(signal);
    }

    acquireForJob(_jobId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      return Promise.resolve(Object.freeze({ close: async () => {}, rootfsPath: this.registry.rootfsPath }));
    }
  }

  class MountedRootfsRegistry {
    readonly digest: string;
    readonly rootfsPath: string;

    constructor(options: Readonly<{ rootfsDigest: string; rootfsPath: string }>) {
      this.digest = options.rootfsDigest;
      this.rootfsPath = options.rootfsPath;
    }

    resolve(digest: string) {
      if (digest !== this.digest) throw new Error("digest mismatch");
      return new MountedRootfsHandle(this);
    }

    async assertReady(signal: AbortSignal) {
      signal.throwIfAborted();
      harness.events.push("rootfs:ready");
      harness.productionRootfs.add(this);
    }
  }

  return {
    FastManimRuncMountedRootfsHandleV1: MountedRootfsHandle,
    FastManimRuncMountedRootfsRegistryV1: MountedRootfsRegistry,
    isProductionFastManimRuncMountedRootfsRegistryV1: (value: unknown) =>
      typeof value === "object" && value !== null && harness.productionRootfs.has(value),
  };
});

import { digestFastManimOciProfileV1, type FastManimOciBuildAttestationV1 } from "./fast-manim-oci-sandbox-profile";
import { createFastManimRuncProductionCompositionV1 } from "./fast-manim-runc-production-composition";
import { FAST_MANIM_RUNC_RELEASE_SCHEMA_V1 } from "./fast-manim-runc-release-trust";
import { FastManimRuncSandboxBackendV1 } from "./fast-manim-runc-sandbox-backend";
import { DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1 } from "./fast-manim-sandbox-resources";

const NOW = Date.now();
const ROOTFS_DIGEST = "f".repeat(64);
const profile = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/profile.v1.json", import.meta.url), "utf8"));
const seccomp = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/seccomp.v1.json", import.meta.url), "utf8"));

function buildAttestation(profileDigest = digestFastManimOciProfileV1(profile)): FastManimOciBuildAttestationV1 {
  const material = {
    imageConfigDigest: `sha256:${"2".repeat(64)}`,
    imageDigest: `sha256:${"1".repeat(64)}`,
    inventoryDigest: "4".repeat(64),
    lockDigest: "5".repeat(64),
    profileDigest,
    seccompDigest: createHash("sha256").update(canonicalJsonV1(seccomp), "utf8").digest("hex"),
  };
  return {
    buildLockDigest: material.lockDigest,
    fastManim: { archiveSha256: "7".repeat(64), commit: "8".repeat(40), tree: "9".repeat(40) },
    imageConfigDigest: material.imageConfigDigest,
    imageDigest: material.imageDigest,
    platform: "linux/amd64",
    profileDigest,
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

function options() {
  const attestation = buildAttestation();
  const keys = generateKeyPairSync("ed25519");
  const uid = process.getuid!();
  const gid = process.getgid!();
  const payload = {
    expiresAt: NOW + 60_000,
    imageDigest: attestation.imageDigest,
    issuedAt: NOW - 60_000,
    keyId: "release-key-1",
    profileDigest: attestation.profileDigest,
    rootfsDigest: ROOTFS_DIGEST,
    runtimeDigest: attestation.runtimeDigest,
    sbomDigest: attestation.sbom.digest,
    schema: FAST_MANIM_RUNC_RELEASE_SCHEMA_V1,
    seccompDigest: attestation.seccompDigest,
    version: 1 as const,
  };
  return {
    attestation,
    bundleRoot: "/srv/poietra/runc-bundles",
    cgroup: { root: "/sys/fs/cgroup/poietra-sandbox-v1" },
    identityMap: {
      allowedGidRanges: [
        { size: 1, start: gid },
        { size: 65_532, start: 200_000 },
      ],
      allowedUidRanges: [
        { size: 1, start: uid },
        { size: 65_532, start: 100_000 },
      ],
      gidMappings: [
        { containerID: 0, hostID: gid, size: 1 },
        { containerID: 1, hostID: 200_000, size: 65_532 },
      ],
      uidMappings: [
        { containerID: 0, hostID: uid, size: 1 },
        { containerID: 1, hostID: 100_000, size: 65_532 },
      ],
    },
    limits: DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
    profile,
    releasePublicKeys: [
      { keyId: payload.keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() },
    ],
    rootfs: {
      format: "erofs" as const,
      imagePath: "/srv/poietra/images/rootfs.erofs",
      rootfsDigest: ROOTFS_DIGEST,
      rootfsPath: "/srv/poietra/rootfs/current",
    },
    runtimeStateRoot: "/run/user/1000/poietra-runc",
    seccomp,
    signedRelease: {
      payload,
      signature: sign(null, Buffer.from(canonicalJsonV1(payload), "utf8"), keys.privateKey).toString("base64url"),
    },
    startupSignal: new AbortController().signal,
  };
}

beforeEach(() => {
  harness.controller = undefined;
  harness.events.length = 0;
  harness.initializeError = undefined;
  harness.productionRootfs = new WeakSet<object>();
  harness.shutdownError = undefined;
});

describe("production runc composition", () => {
  it("builds the real branded backend and closes its process controller exactly once", async () => {
    const backend = await createFastManimRuncProductionCompositionV1(options());

    expect(backend).toBeInstanceOf(FastManimRuncSandboxBackendV1);
    expect(harness.events).toEqual(["rootfs:ready", "cgroup:create", "cgroup:initialize"]);
    const firstClose = backend.close();
    const secondClose = backend.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(harness.controller?.shutdown).toHaveBeenCalledOnce();
  });

  it("shuts down the acquired process controller when initialization fails", async () => {
    const failure = new Error("initialization failed");
    harness.initializeError = failure;

    await expect(createFastManimRuncProductionCompositionV1(options())).rejects.toBe(failure);
    expect(harness.events).toEqual(["rootfs:ready", "cgroup:create", "cgroup:initialize", "cgroup:shutdown"]);
    expect(harness.controller?.shutdown).toHaveBeenCalledOnce();
  });

  it("surfaces both construction and cleanup failures", async () => {
    harness.initializeError = new Error("initialization failed");
    harness.shutdownError = new Error("shutdown failed");

    const error = await createFastManimRuncProductionCompositionV1(options()).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([harness.initializeError, harness.shutdownError]);
  });
});
