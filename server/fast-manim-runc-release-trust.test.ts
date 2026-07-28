import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { createFastManimOciBrokerDispatchV1, digestFastManimOciProfileV1 } from "./fast-manim-oci-sandbox-profile";
import {
  FAST_MANIM_RUNC_RELEASE_SCHEMA_V1,
  FastManimRuncReleaseTrustError,
  FastManimRuncReleaseTrustV1,
  FastManimRuncVerifiedReleaseV1,
} from "./fast-manim-runc-release-trust";
import { FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const profile = JSON.parse(readFileSync(resolve("sandbox/fast-manim-oci/profile.v1.json"), "utf8"));
const NOW = 1_800_000_000_000;
const ROOTFS_DIGEST = "f".repeat(64);
const ROOTFS_PATH = "/srv/poietra/rootfs/by-digest/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

function buildAttestation() {
  const material = {
    imageConfigDigest: `sha256:${"2".repeat(64)}`,
    imageDigest: `sha256:${"1".repeat(64)}`,
    inventoryDigest: "4".repeat(64),
    lockDigest: "5".repeat(64),
    profileDigest: digestFastManimOciProfileV1(profile),
    seccompDigest: "6".repeat(64),
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
      toolchainDigest: "a".repeat(64),
    },
    schema: "poietra.fast-manim-oci-build-attestation",
    seccompDigest: material.seccompDigest,
    version: 1,
  };
}

function dispatch() {
  return createFastManimOciBrokerDispatchV1({
    attestation: buildAttestation(),
    context: {
      attestationDigest: "b".repeat(64),
      deadlineEpochMs: NOW + 60_000,
      identity: { projectId: "default", requestId: "request-1", tenantId: "tenant-1" },
      signal: new AbortController().signal,
    },
    profile,
    request: new FastManimSandboxRequestBundleV1(sandboxProducerRequest()),
  });
}

function payload(job = dispatch(), overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    expiresAt: NOW + 60_000,
    imageDigest: job.descriptor.imageDigest,
    issuedAt: NOW - 60_000,
    keyId: "release-key-1",
    profileDigest: job.descriptor.profileDigest,
    rootfsDigest: ROOTFS_DIGEST,
    runtimeDigest: job.descriptor.runtimeDigest,
    sbomDigest: job.descriptor.sbomDigest,
    schema: FAST_MANIM_RUNC_RELEASE_SCHEMA_V1,
    seccompDigest: job.descriptor.seccompDigest,
    version: 1,
    ...overrides,
  };
}

function signedRelease(releasePayload: ReturnType<typeof payload>, privateKey: ReturnType<typeof keys>["privateKey"]) {
  return {
    payload: releasePayload,
    signature: sign(null, Buffer.from(canonicalJsonV1(releasePayload), "utf8"), privateKey).toString("base64url"),
  };
}

function keys() {
  return generateKeyPairSync("ed25519");
}

function trust(publicKey: ReturnType<typeof keys>["publicKey"], now: () => number = () => NOW) {
  return new FastManimRuncReleaseTrustV1({
    now,
    publicKeys: [
      {
        keyId: "release-key-1",
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
    ],
    rootFilesystems: [{ rootfsDigest: ROOTFS_DIGEST, rootfsPath: ROOTFS_PATH }],
  });
}

describe("fast-manim runc signed release trust", () => {
  it("verifies canonical Ed25519 bytes and resolves only the constructor-owned rootfs path", () => {
    const job = dispatch();
    const keyPair = keys();
    const verifier = trust(keyPair.publicKey);
    const releasePayload = payload(job);
    expect(releasePayload).not.toHaveProperty("rootfsPath");

    const verified = verifier.verify(signedRelease(releasePayload, keyPair.privateKey));

    expect(verified).toBeInstanceOf(FastManimRuncVerifiedReleaseV1);
    expect(Object.keys(verified)).toEqual([]);
    expect(verified).not.toHaveProperty("rootfsPath");
    expect(verified.attestation()).toEqual({
      expiresAt: releasePayload.expiresAt,
      issuedAt: releasePayload.issuedAt,
      profileDigest: job.descriptor.profileDigest,
      runtimeDigest: job.descriptor.runtimeDigest,
    });
    expect(Object.isFrozen(verified.attestation())).toBe(true);
    expect(verified.attestation()).not.toHaveProperty("rootfsPath");
    expect(verified.resolveRootfsPath(job)).toBe(ROOTFS_PATH);
  });

  it("rejects stale, future, unknown-key, malformed, and non-canonical signatures", () => {
    const keyPair = keys();
    const verifier = trust(keyPair.publicKey);
    const stale = payload(dispatch(), { expiresAt: NOW, issuedAt: NOW - 1_000 });
    const future = payload(dispatch(), { expiresAt: NOW + 2_000, issuedAt: NOW + 1_000 });
    const unknown = payload(dispatch(), { keyId: "unknown-key" });
    for (const candidate of [stale, future, unknown]) {
      expect(() => verifier.verify(signedRelease(candidate, keyPair.privateKey))).toThrow(
        FastManimRuncReleaseTrustError,
      );
    }
    expect(() => verifier.verify({ payload: payload(), signature: "not-a-signature" })).toThrow(
      FastManimRuncReleaseTrustError,
    );

    const releasePayload = payload();
    const reversedPayload = Object.fromEntries(Object.entries(releasePayload).reverse());
    const nonCanonicalSignature = sign(
      null,
      Buffer.from(JSON.stringify(reversedPayload), "utf8"),
      keyPair.privateKey,
    ).toString("base64url");
    expect(() => verifier.verify({ payload: releasePayload, signature: nonCanonicalSignature })).toThrow(
      FastManimRuncReleaseTrustError,
    );
  });

  it.each(["imageDigest", "profileDigest", "runtimeDigest", "sbomDigest", "seccompDigest"] as const)(
    "rejects a dispatch whose %s is outside the signed release",
    (field) => {
      const job = dispatch();
      const keyPair = keys();
      const mismatchedValue = field === "imageDigest" ? `sha256:${"e".repeat(64)}` : "e".repeat(64);
      const verified = trust(keyPair.publicKey).verify(
        signedRelease(payload(job, { [field]: mismatchedValue }), keyPair.privateKey),
      );
      expect(() => verified.resolveRootfsPath(job)).toThrow(FastManimRuncReleaseTrustError);
    },
  );

  it("rechecks expiry, rejects forged handles/dispatches, and keeps host paths out of signed input", () => {
    let now = NOW;
    const keyPair = keys();
    const verifier = trust(keyPair.publicKey, () => now);
    const job = dispatch();
    const releasePayload = payload(job);
    const verified = verifier.verify(signedRelease(releasePayload, keyPair.privateKey));
    now = releasePayload.issuedAt - 1;
    expect(() => verified.resolveRootfsPath(job)).toThrow(FastManimRuncReleaseTrustError);
    expect(() => verified.attestation()).toThrow(FastManimRuncReleaseTrustError);
    now = releasePayload.expiresAt;
    expect(() => verified.resolveRootfsPath(job)).toThrow(FastManimRuncReleaseTrustError);
    expect(() => verified.resolveRootfsPath({ descriptor: job.descriptor } as never)).toThrow(
      FastManimRuncReleaseTrustError,
    );
    expect(() =>
      verifier.verify(
        signedRelease(
          { ...payload(job), rootfsPath: "/request-controlled" } as ReturnType<typeof payload>,
          keyPair.privateKey,
        ),
      ),
    ).toThrow(FastManimRuncReleaseTrustError);
    expect(
      () =>
        new (FastManimRuncVerifiedReleaseV1 as unknown as new (...values: unknown[]) => FastManimRuncVerifiedReleaseV1)(
          {},
          releasePayload,
          "/request-controlled",
          () => NOW,
        ),
    ).toThrow(FastManimRuncReleaseTrustError);
  });

  it("rejects non-canonical rootfs paths, unknown rootfs digests, duplicate config, and non-Ed25519 keys", () => {
    const keyPair = keys();
    const publicKeyPem = keyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(
      () =>
        new FastManimRuncReleaseTrustV1({
          publicKeys: [{ keyId: "release-key-1", publicKeyPem }],
          rootFilesystems: [{ rootfsDigest: ROOTFS_DIGEST, rootfsPath: "/srv/poietra/../escaped" }],
        }),
    ).toThrow(FastManimRuncReleaseTrustError);
    expect(
      () =>
        new FastManimRuncReleaseTrustV1({
          publicKeys: [
            { keyId: "release-key-1", publicKeyPem },
            { keyId: "release-key-1", publicKeyPem },
          ],
          rootFilesystems: [{ rootfsDigest: ROOTFS_DIGEST, rootfsPath: ROOTFS_PATH }],
        }),
    ).toThrow(FastManimRuncReleaseTrustError);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => trust(rsa.publicKey)).toThrow(FastManimRuncReleaseTrustError);

    const verifier = trust(keyPair.publicKey);
    const unknownRootfs = payload(dispatch(), { rootfsDigest: "d".repeat(64) });
    expect(() => verifier.verify(signedRelease(unknownRootfs, keyPair.privateKey))).toThrow(
      FastManimRuncReleaseTrustError,
    );
  });
});
