import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  digestFastManimOciProfileV1,
  type FastManimOciBrokerDispatchV1,
  type FastManimOciBuildAttestationV1,
} from "./fast-manim-oci-sandbox-profile";
import { FAST_MANIM_RUNC_RELEASE_SCHEMA_V1, FastManimRuncReleaseTrustV1 } from "./fast-manim-runc-release-trust";
import {
  createFastManimRuncSandboxBackendForTestingV1,
  type FastManimRuncProductionBrokerV1,
  FastManimRuncSandboxBackendV1,
} from "./fast-manim-runc-sandbox-backend";
import { FastManimSandboxRequestBundleV1, fastManimSandboxBackendStatusV1Schema } from "./fast-manim-sandbox-backend";
import {
  createFastManimRuncRootfsFixtureV1,
  FAST_MANIM_TEST_ROOTFS_DIGEST_V1,
} from "./test-fixtures/fast-manim-runc-rootfs-fixture";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const NOW = Date.now();
const profile = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/profile.v1.json", import.meta.url), "utf8"));
const seccomp = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/seccomp.v1.json", import.meta.url), "utf8"));
const seccompDigest = createHash("sha256").update(canonicalJsonV1(seccomp), "utf8").digest("hex");

function buildAttestation(): FastManimOciBuildAttestationV1 {
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
      toolchainDigest: "a".repeat(64),
    },
    schema: "poietra.fast-manim-oci-build-attestation",
    seccompDigest: material.seccompDigest,
    version: 1,
  };
}

function verifiedRelease(attestation: FastManimOciBuildAttestationV1) {
  const rootfsDigest = FAST_MANIM_TEST_ROOTFS_DIGEST_V1;
  const keyPair = generateKeyPairSync("ed25519");
  const payload = {
    expiresAt: NOW + 60_000,
    imageDigest: attestation.imageDigest,
    issuedAt: NOW - 60_000,
    keyId: "release-key-1",
    profileDigest: attestation.profileDigest,
    rootfsDigest,
    runtimeDigest: attestation.runtimeDigest,
    sbomDigest: attestation.sbom.digest,
    schema: FAST_MANIM_RUNC_RELEASE_SCHEMA_V1,
    seccompDigest: attestation.seccompDigest,
    version: 1,
  } as const;
  return new FastManimRuncReleaseTrustV1({
    now: () => NOW,
    publicKeys: [
      {
        keyId: payload.keyId,
        publicKeyPem: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
    ],
    rootfsRegistry: createFastManimRuncRootfsFixtureV1(`/var/lib/poietra/rootfs/${rootfsDigest}`),
  }).verify({
    payload,
    signature: sign(null, Buffer.from(canonicalJsonV1(payload), "utf8"), keyPair.privateKey).toString("base64url"),
  });
}

function context() {
  return {
    attestationDigest: "b".repeat(64),
    deadlineEpochMs: Date.now() + 30_000,
    identity: { projectId: "project-1", requestId: "request-1", tenantId: "tenant-1" },
    signal: new AbortController().signal,
  };
}

function fixture(ready = true) {
  const attestation = buildAttestation();
  const release = verifiedRelease(attestation);
  const dispatches: FastManimOciBrokerDispatchV1[] = [];
  const broker = {
    close: vi.fn(async () => {}),
    dispatch: vi.fn((dispatch: FastManimOciBrokerDispatchV1) => {
      dispatches.push(dispatch);
      return {
        abort() {},
        result: Promise.resolve({
          attestationDigest: dispatch.context.attestationDigest,
          kind: "ok" as const,
          requestDigest: dispatch.descriptor.request.sha256,
          resultBytes: new Uint8Array(),
        }),
      };
    }),
    ready: vi.fn(async () => ready),
    releaseAttestation: vi.fn(() => release.attestation()),
  } satisfies FastManimRuncProductionBrokerV1;
  const backend = createFastManimRuncSandboxBackendForTestingV1({
    attestation,
    broker,
    profile,
  });
  return { backend, broker, dispatches };
}

describe("FastManimRuncSandboxBackendV1", () => {
  it("does not let a structural broker double claim production readiness", () => {
    const test = fixture();
    expect(
      () =>
        new FastManimRuncSandboxBackendV1({
          attestation: buildAttestation(),
          broker: test.broker,
          profile,
        }),
    ).toThrow(/closed broker/u);
  });

  it("reports readiness only after the concrete broker probe and verifies its signed release", async () => {
    const { backend, broker } = fixture();
    const status = fastManimSandboxBackendStatusV1Schema.parse(await backend.status(context()));

    expect(broker.ready).toHaveBeenCalledOnce();
    expect(status).toMatchObject({ backendKind: "production", health: "ready" });
    if (status.health !== "ready") throw new Error("Expected a ready production status.");
    expect(status.attestation.trust).toBe("verified");
    expect(backend.attestationVerifier(status)).toBe(true);
    expect(backend.attestationVerifier({ ...status, backendId: "forged-runc" })).toBe(false);
  });

  it("fails readiness closed when the broker probe is unavailable", async () => {
    const { backend } = fixture(false);
    await expect(backend.status(context())).resolves.toMatchObject({
      backendKind: "production",
      health: "unavailable",
      reason: "health-check-failed",
    });
  });

  it("converts the sealed request into a closed broker dispatch and owns broker shutdown", async () => {
    const { backend, broker, dispatches } = fixture();
    const request = new FastManimSandboxRequestBundleV1(sandboxProducerRequest());
    await expect(backend.start(request, context()).result).resolves.toMatchObject({
      kind: "ok",
      requestDigest: request.requestDigest,
    });

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.copyRequestBytes()).toEqual(request.copyBytes());
    expect(dispatches[0]!.descriptor).not.toHaveProperty("argv");
    await Promise.all([backend.close(), backend.close()]);
    expect(broker.close).toHaveBeenCalledOnce();
  });
});
