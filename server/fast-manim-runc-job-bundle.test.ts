import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { createFastManimOciBrokerDispatchV1, digestFastManimOciProfileV1 } from "./fast-manim-oci-sandbox-profile";
import {
  type FastManimRuncJobBundleMetadataPolicyV1,
  FastManimRuncJobBundleStoreV1,
  isProductionFastManimRuncJobBundleStoreV1,
} from "./fast-manim-runc-job-bundle";
import { FastManimRuncOciSpecGeneratorV1, type FastManimRuncOciSpecV1 } from "./fast-manim-runc-oci-spec";
import { FastManimRuncRootlessIdentityMapV1 } from "./fast-manim-runc-rootless-identity";
import { FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const profile = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/profile.v1.json", import.meta.url), "utf8"));
const seccomp = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/seccomp.v1.json", import.meta.url), "utf8"));
const seccompDigest = createHash("sha256").update(canonicalJsonV1(seccomp), "utf8").digest("hex");
const containerId = `poietra-job-v1-${"a".repeat(32)}-1`;
const { gid, uid } = (() => {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("The runc bundle tests require POSIX process identity APIs.");
  }
  return { gid: process.getgid(), uid: process.getuid() };
})();
let root = "";

function expectedAttestation() {
  const material = {
    imageConfigDigest: `sha256:${"2".repeat(64)}`,
    imageDigest: `sha256:${"1".repeat(64)}`,
    inventoryDigest: "4".repeat(64),
    lockDigest: "5".repeat(64),
    profileDigest: digestFastManimOciProfileV1(profile),
    seccompDigest,
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
      toolchainDigest: "b".repeat(64),
    },
    schema: "poietra.fast-manim-oci-build-attestation",
    seccompDigest,
    version: 1,
  };
}

function dispatch() {
  const first = Uint8Array.of(1, 2, 3);
  const second = Uint8Array.of(4, 5);
  return createFastManimOciBrokerDispatchV1({
    assets: [
      { bytes: second, sha256: createHash("sha256").update(second).digest("hex") },
      { bytes: first, sha256: createHash("sha256").update(first).digest("hex") },
    ],
    attestation: expectedAttestation(),
    context: {
      attestationDigest: "c".repeat(64),
      deadlineEpochMs: Date.now() + 60_000,
      identity: { projectId: "default", requestId: "request-1", tenantId: "tenant-1" },
      signal: new AbortController().signal,
    },
    profile,
    request: new FastManimSandboxRequestBundleV1(sandboxProducerRequest()),
  });
}

async function assertMetadata(handle: FileHandle, kind: "directory" | "file", mode: number) {
  await handle.chmod(mode);
  const metadata = await handle.stat();
  expect(kind === "file" ? metadata.isFile() : metadata.isDirectory()).toBe(true);
  expect(metadata.uid).toBe(uid);
  expect(metadata.gid).toBe(gid);
  expect(metadata.mode & 0o7777).toBe(mode);
  if (kind === "file") expect(metadata.nlink).toBe(1);
}

function localMetadataPolicy(failMode?: number): FastManimRuncJobBundleMetadataPolicyV1 {
  return {
    async prepare(handle, expectation) {
      if (expectation.mode === failMode) throw new Error("injected metadata failure");
      await assertMetadata(handle, expectation.kind, expectation.mode);
    },
    async verifyRoot(handle) {
      const metadata = await handle.stat();
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.uid).toBe(uid);
      expect(metadata.gid).toBe(gid);
      expect(metadata.mode & 0o022).toBe(0);
    },
  };
}

function rootlessIdentity(hostUid = uid, hostGid = gid) {
  const subordinateUid = Math.max(100_000, hostUid + 1000);
  const subordinateGid = Math.max(200_000, hostGid + 1000);
  return new FastManimRuncRootlessIdentityMapV1({
    allowedGidRanges: [
      { size: 1, start: hostGid },
      { size: 65_532, start: subordinateGid },
    ],
    allowedUidRanges: [
      { size: 1, start: hostUid },
      { size: 65_532, start: subordinateUid },
    ],
    gidMappings: [
      { containerID: 0, hostID: hostGid, size: 1 },
      { containerID: 1, hostID: subordinateGid, size: 65_532 },
    ],
    uidMappings: [
      { containerID: 0, hostID: hostUid, size: 1 },
      { containerID: 1, hostID: subordinateUid, size: 65_532 },
    ],
  });
}

const identityMap = rootlessIdentity();

function store(metadataPolicy = localMetadataPolicy()) {
  return new FastManimRuncJobBundleStoreV1({ identityMap, metadataPolicy, root });
}

function spec(assetsPath: string, id = containerId, mapping = identityMap) {
  return new FastManimRuncOciSpecGeneratorV1({
    assetsSourcePath: assetsPath,
    expectedSeccompDigest: seccompDigest,
    identityMap: mapping,
    profile,
    rootfsPath: `/srv/poietra/rootfs/${"f".repeat(64)}`,
    seccomp,
  }).generate({
    cgroupsPath: `poietra-sandbox-v1/${id}`,
    deadlineEpochMs: Date.now() + 60_000,
    mustStartInCgroup: true,
    productionMembership: { state: "requires-direct-start-verification" },
    rlimits: { cpuTimeSeconds: 30, fileBytes: 67_108_864, openFiles: 256 },
    tmpfs: {
      runtime: { maximumInodes: 4096, sizeBytes: 16_777_216 },
      sharedMemory: { maximumInodes: 1024, sizeBytes: 4_194_304 },
    },
  });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "poietra-runc-bundles-")));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("FastManimRuncJobBundleStoreV1", () => {
  it("brands only stores using the strict mapped-root production policy", () => {
    expect(isProductionFastManimRuncJobBundleStoreV1(new FastManimRuncJobBundleStoreV1({ identityMap, root }))).toBe(
      true,
    );
    expect(isProductionFastManimRuncJobBundleStoreV1(store())).toBe(false);
    expect(isProductionFastManimRuncJobBundleStoreV1({ root })).toBe(false);
    class OverriddenStore extends FastManimRuncJobBundleStoreV1 {}
    expect(isProductionFastManimRuncJobBundleStoreV1(new OverriddenStore({ identityMap, root }))).toBe(false);
  });

  it("checks the real bundle root through its no-follow metadata handle", async () => {
    const bundles = new FastManimRuncJobBundleStoreV1({ identityMap, root });
    await expect(bundles.assertReady()).resolves.toBeUndefined();

    await chmod(root, 0o770);
    await expect(bundles.assertReady()).rejects.toThrow(/writable by another identity/u);
  });

  it("locks production bundle entries to mapped container root", async () => {
    const bundles = new FastManimRuncJobBundleStoreV1({ identityMap, root });
    const plan = bundles.plan(containerId);
    await bundles.stage({ dispatch: dispatch(), plan, spec: spec(plan.assetsPath) });
    for (const path of [plan.bundlePath, plan.assetsPath, join(plan.bundlePath, "config.json")]) {
      const metadata = await lstat(path);
      expect(metadata.uid).toBe(identityMap.hostRootIdentity().uid);
      expect(metadata.gid).toBe(identityMap.hostRootIdentity().gid);
    }
    await bundles.cleanup(plan);
  });

  it("stages an exclusive canonical config and immutable digest-addressed assets", async () => {
    const bundles = store();
    const plan = bundles.plan(containerId);
    const job = dispatch();
    const config = spec(plan.assetsPath);

    await expect(bundles.stage({ dispatch: job, plan, spec: config })).resolves.toBe(plan);
    expect(await readFile(join(plan.bundlePath, "config.json"), "utf8")).toBe(`${canonicalJsonV1(config)}\n`);
    const manifestBytes = await readFile(join(plan.assetsPath, ".poietra-assets.v1.json"), "utf8");
    expect(manifestBytes.endsWith("\n")).toBe(false);
    expect(JSON.parse(manifestBytes)).toEqual({
      assets: job.descriptor.assets.map(({ byteLength, fileName, sha256 }) => ({ byteLength, fileName, sha256 })),
      count: 2,
      schema: "poietra.fast-manim-oci-asset-manifest",
      version: 1,
    });
    for (const asset of job.copyAssets()) {
      const assetPath = join(plan.assetsPath, asset.descriptor.sha256);
      expect(await readFile(assetPath)).toEqual(Buffer.from(asset.bytes));
      await expectMetadata(assetPath, "file", 0o444);
    }
    await expectMetadata(plan.bundlePath, "directory", 0o700);
    await expectMetadata(join(plan.bundlePath, "config.json"), "file", 0o400);
    await expectMetadata(join(plan.assetsPath, ".poietra-assets.v1.json"), "file", 0o444);
    await expectMetadata(plan.assetsPath, "directory", 0o555);

    await expect(bundles.cleanup(plan)).resolves.toBeUndefined();
    await expect(bundles.cleanup(plan)).resolves.toBeUndefined();
    await expect(lstat(plan.bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only opaque plans and server cgroup identities", async () => {
    const bundles = store();
    expect(() => bundles.plan("../request-path")).toThrow(/identity/i);
    const plan = bundles.plan(containerId);
    expect(() => bundles.plan(containerId)).toThrow(/already planned/i);
    await mkdir(join(root, "sentinel"));
    const forged = Object.freeze({ assetsPath: join(root, "sentinel", "assets"), bundlePath: join(root, "sentinel") });
    await expect(bundles.cleanup(forged)).rejects.toThrow(/not issued/i);
    await expect(lstat(join(root, "sentinel"))).resolves.toBeTruthy();
    await bundles.cleanup(plan);
    expect(() => bundles.plan(containerId)).not.toThrow();
  });

  it("rejects spec path/cgroup drift before filesystem mutation", async () => {
    const bundles = store();
    const plan = bundles.plan(containerId);
    const config = structuredClone(spec(plan.assetsPath)) as FastManimRuncOciSpecV1;
    (config.mounts.find((mount) => mount.destination === "/opt/poietra/assets") as { source: string }).source =
      "/request/path";
    await expect(bundles.stage({ dispatch: dispatch(), plan, spec: config })).rejects.toThrow(/asset mount/i);
    await expect(lstat(plan.bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
    await bundles.cleanup(plan);

    const secondPlan = bundles.plan(containerId);
    await expect(
      bundles.stage({
        dispatch: dispatch(),
        plan: secondPlan,
        spec: spec(secondPlan.assetsPath, containerId, rootlessIdentity(uid + 1, gid + 1)),
      }),
    ).rejects.toThrow(/user namespace/i);
    await bundles.cleanup(secondPlan);

    const thirdPlan = bundles.plan(containerId);
    const inherited = Object.create(spec(thirdPlan.assetsPath)) as FastManimRuncOciSpecV1;
    await expect(bundles.stage({ dispatch: dispatch(), plan: thirdPlan, spec: inherited })).rejects.toThrow(
      /plain JSON/i,
    );
    await bundles.cleanup(thirdPlan);
  });

  it("cleans a partially staged store but never removes a pre-existing bundle", async () => {
    const failingStore = store(localMetadataPolicy(0o555));
    const partial = failingStore.plan(containerId);
    await expect(
      failingStore.stage({ dispatch: dispatch(), plan: partial, spec: spec(partial.assetsPath) }),
    ).rejects.toThrow(/injected metadata/i);
    await expect(lstat(partial.bundlePath)).resolves.toBeTruthy();
    await failingStore.cleanup(partial);
    await expect(lstat(partial.bundlePath)).rejects.toMatchObject({ code: "ENOENT" });

    const collisionStore = store();
    const collision = collisionStore.plan(containerId);
    await mkdir(collision.bundlePath);
    await writeFile(join(collision.bundlePath, "sentinel"), "preserve");
    await expect(
      collisionStore.stage({ dispatch: dispatch(), plan: collision, spec: spec(collision.assetsPath) }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await collisionStore.cleanup(collision);
    await expect(readFile(join(collision.bundlePath, "sentinel"), "utf8")).resolves.toBe("preserve");
  });

  it("rejects a production mapping whose container root is not the server identity", () => {
    const foreignIdentity = rootlessIdentity(uid + 1, gid + 1);
    expect(() => new FastManimRuncJobBundleStoreV1({ identityMap: foreignIdentity, root })).toThrow(/server identity/u);
  });
});

async function expectMetadata(path: string, kind: "directory" | "file", mode: number) {
  const metadata = await lstat(path);
  expect(kind === "file" ? metadata.isFile() : metadata.isDirectory()).toBe(true);
  expect(metadata.uid).toBe(uid);
  expect(metadata.gid).toBe(gid);
  expect(metadata.mode & 0o7777).toBe(mode);
  if (kind === "file") expect(metadata.nlink).toBe(1);
}
