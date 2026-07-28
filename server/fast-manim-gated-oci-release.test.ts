import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
  FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
} from "./fast-manim-gated-oci-job-runner";
import {
  digestFastManimGatedOciRuntimeV1,
  FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
  FAST_MANIM_PRODUCTION_GATED_OCI_BACKEND_ID_V1,
  type FastManimGatedOciReleasePayloadV1,
  type FastManimGatedOciSignedReleaseV1,
  verifyFastManimGatedOciReleaseV1,
} from "./fast-manim-gated-oci-release";
import {
  FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1,
  FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
  FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
  type FastManimSandboxBackendStatusV1,
  resolveFastManimSandboxReadiness,
} from "./fast-manim-sandbox-backend";

const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
type ReadyStatus = Extract<FastManimSandboxBackendStatusV1, { health: "ready" }>;
type VerifiedAttestation = Extract<ReadyStatus["attestation"], { trust: "verified" }>;

function releasePayload(overrides: Partial<FastManimGatedOciReleasePayloadV1> = {}): FastManimGatedOciReleasePayloadV1 {
  const now = Date.now();
  const material = {
    dockerServerVersion: overrides.dockerServerVersion ?? "28.3.3",
    imageDigest: overrides.imageDigest ?? (`sha256:${"a".repeat(64)}` as const),
    profileDigest: overrides.profileDigest ?? FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
    seccompDigest: overrides.seccompDigest ?? FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
  };
  return {
    ...material,
    expiresAt: overrides.expiresAt ?? now + 60_000,
    issuedAt: overrides.issuedAt ?? now - 60_000,
    keyId: overrides.keyId ?? "release-key-1",
    runtimeDigest: overrides.runtimeDigest ?? digestFastManimGatedOciRuntimeV1(material),
    schema: FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1,
    version: 1,
  };
}

function signedRelease(payload: FastManimGatedOciReleasePayloadV1, privateKey: KeyObject) {
  return {
    payload,
    signature: sign(null, Buffer.from(canonicalJsonV1(payload), "utf8"), privateKey).toString("base64url"),
  } satisfies FastManimGatedOciSignedReleaseV1;
}

function publicKeyConfiguration(keyId: string, publicKey: KeyObject) {
  return [{ keyId, publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() }];
}

function readyStatus(attestation: VerifiedAttestation): ReadyStatus {
  return {
    attestation,
    backendId: FAST_MANIM_PRODUCTION_GATED_OCI_BACKEND_ID_V1,
    backendKind: "production",
    capabilities: [...FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1],
    health: "ready",
    schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
    version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
  };
}

describe("signed gated OCI release", () => {
  it("verifies an actual Ed25519 signature over the canonical release payload", () => {
    const keys = generateKeyPairSync("ed25519");
    const payload = releasePayload();
    const verified = verifyFastManimGatedOciReleaseV1(
      signedRelease(payload, keys.privateKey),
      publicKeyConfiguration(payload.keyId, keys.publicKey),
    );

    expect(verified.descriptor()).toEqual(payload);
    expect(Object.isFrozen(verified.descriptor())).toBe(true);
    expect(verified.statusAttestation()).toEqual({
      expiresAt: new Date(payload.expiresAt).toISOString(),
      issuedAt: new Date(payload.issuedAt).toISOString(),
      profileDigest: payload.profileDigest,
      runtimeDigest: payload.runtimeDigest,
      trust: "verified",
    });
  });

  it("rejects a modified signature and a release whose signing key is not trusted", () => {
    const keys = generateKeyPairSync("ed25519");
    const payload = releasePayload();
    const signed = signedRelease(payload, keys.privateKey);
    const configuredKeys = publicKeyConfiguration(payload.keyId, keys.publicKey);
    const changedFirstCharacter = signed.signature[0] === "A" ? "B" : "A";

    expect(() =>
      verifyFastManimGatedOciReleaseV1(
        { ...signed, signature: `${changedFirstCharacter}${signed.signature.slice(1)}` },
        configuredKeys,
      ),
    ).toThrow(/not trusted/i);
    expect(() =>
      verifyFastManimGatedOciReleaseV1(
        signedRelease({ ...payload, keyId: "unknown-release-key" }, keys.privateKey),
        configuredKeys,
      ),
    ).toThrow(/not trusted/i);
  });

  it("rejects expired and not-yet-valid signed releases", () => {
    const keys = generateKeyPairSync("ed25519");
    const now = Date.now();
    const configuredKeys = publicKeyConfiguration("release-key-1", keys.publicKey);
    const expired = releasePayload({ expiresAt: now - 1, issuedAt: now - 60_000 });
    const future = releasePayload({ expiresAt: now + 120_000, issuedAt: now + 60_000 });

    for (const payload of [expired, future]) {
      expect(() => verifyFastManimGatedOciReleaseV1(signedRelease(payload, keys.privateKey), configuredKeys)).toThrow(
        /not trusted/i,
      );
    }
  });

  it.each([
    {
      field: "imageDigest",
      mutate: (payload: FastManimGatedOciReleasePayloadV1) => ({
        ...payload,
        imageDigest: `sha256:${SHA_B}`,
      }),
    },
    {
      field: "profileDigest",
      mutate: (payload: FastManimGatedOciReleasePayloadV1) => {
        const changed = { ...payload, profileDigest: SHA_B };
        return { ...changed, runtimeDigest: digestFastManimGatedOciRuntimeV1(changed) };
      },
    },
    {
      field: "seccompDigest",
      mutate: (payload: FastManimGatedOciReleasePayloadV1) => {
        const changed = { ...payload, seccompDigest: SHA_B };
        return { ...changed, runtimeDigest: digestFastManimGatedOciRuntimeV1(changed) };
      },
    },
    {
      field: "runtimeDigest",
      mutate: (payload: FastManimGatedOciReleasePayloadV1) => ({ ...payload, runtimeDigest: SHA_B }),
    },
  ])("rejects a correctly signed release with a mismatched $field", ({ mutate }) => {
    const keys = generateKeyPairSync("ed25519");
    const payload = releasePayload();
    const changed = mutate(payload) as FastManimGatedOciReleasePayloadV1;

    expect(() =>
      verifyFastManimGatedOciReleaseV1(
        signedRelease(changed, keys.privateKey),
        publicKeyConfiguration(payload.keyId, keys.publicKey),
      ),
    ).toThrow(/not trusted/i);
  });

  it("accepts only the exact release-backed production readiness status", () => {
    const keys = generateKeyPairSync("ed25519");
    const payload = releasePayload();
    const verified = verifyFastManimGatedOciReleaseV1(
      signedRelease(payload, keys.privateKey),
      publicKeyConfiguration(payload.keyId, keys.publicKey),
    );
    const attestation = verified.statusAttestation();
    if (attestation.trust !== "verified") throw new Error("The release did not produce a verified attestation.");
    const status = readyStatus(attestation);

    expect(resolveFastManimSandboxReadiness(status, "production", Date.now(), verified.attestationVerifier).kind).toBe(
      "ready",
    );

    const driftedStatuses: FastManimSandboxBackendStatusV1[] = [
      { ...status, backendId: "another-production-backend" },
      { ...status, backendKind: "local-process" },
      { ...status, attestation: { ...attestation, issuedAt: new Date(payload.issuedAt - 1).toISOString() } },
      { ...status, attestation: { ...attestation, expiresAt: new Date(payload.expiresAt + 1).toISOString() } },
      { ...status, attestation: { ...attestation, profileDigest: SHA_C } },
      { ...status, attestation: { ...attestation, runtimeDigest: SHA_C } },
    ];
    for (const drifted of driftedStatuses) {
      expect(resolveFastManimSandboxReadiness(drifted, "production", Date.now(), verified.attestationVerifier)).toEqual(
        { code: "sandbox-attestation-rejected", kind: "failed" },
      );
    }
  });
});
