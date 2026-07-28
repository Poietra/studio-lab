import { createHash, createPublicKey, type KeyObject, verify as verifySignature } from "node:crypto";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1,
  FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1,
} from "./fast-manim-gated-oci-job-runner";
import type {
  FastManimSandboxAttestationVerifierV1,
  FastManimSandboxBackendStatusV1,
} from "./fast-manim-sandbox-backend";

export const FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1 = "poietra.fast-manim-gated-oci-release" as const;
export const FAST_MANIM_PRODUCTION_GATED_OCI_BACKEND_ID_V1 = "rootless-docker-gated-v1" as const;
const MAX_RELEASE_LIFETIME_MS = 31 * 24 * 60 * 60 * 1_000;
const keyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const fastManimGatedOciReleasePayloadV1Schema = z
  .object({
    dockerServerVersion: z.string().regex(/^[0-9]+[.][0-9]+[.][0-9]+(?:[-+][A-Za-z0-9._-]+)?$/u),
    expiresAt: z.number().int().safe().positive(),
    imageDigest: imageDigestSchema,
    issuedAt: z.number().int().safe().positive(),
    keyId: keyIdSchema,
    profileDigest: sha256Schema,
    runtimeDigest: sha256Schema,
    schema: z.literal(FAST_MANIM_GATED_OCI_RELEASE_SCHEMA_V1),
    seccompDigest: sha256Schema,
    version: z.literal(1),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > MAX_RELEASE_LIFETIME_MS) {
      context.addIssue({ code: "custom", message: "The gated OCI release lifetime is invalid." });
    }
    if (
      payload.profileDigest !== FAST_MANIM_GATED_OCI_PROFILE_DIGEST_V1 ||
      payload.seccompDigest !== FAST_MANIM_GATED_OCI_SECCOMP_DIGEST_V1 ||
      payload.runtimeDigest !== digestFastManimGatedOciRuntimeV1(payload)
    ) {
      context.addIssue({ code: "custom", message: "The gated OCI release does not match the fixed runtime profile." });
    }
  });

export const fastManimGatedOciSignedReleaseV1Schema = z
  .object({
    payload: fastManimGatedOciReleasePayloadV1Schema,
    signature: z
      .string()
      .length(86)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();

export type FastManimGatedOciReleasePayloadV1 = Readonly<z.infer<typeof fastManimGatedOciReleasePayloadV1Schema>>;
export type FastManimGatedOciSignedReleaseV1 = Readonly<z.infer<typeof fastManimGatedOciSignedReleaseV1Schema>>;
export type FastManimGatedOciReleasePublicKeyV1 = Readonly<{ keyId: string; publicKeyPem: string }>;

export function digestFastManimGatedOciRuntimeV1(
  value: Pick<
    FastManimGatedOciReleasePayloadV1,
    "dockerServerVersion" | "imageDigest" | "profileDigest" | "seccompDigest"
  >,
) {
  return createHash("sha256")
    .update(
      canonicalJsonV1({
        dockerServerVersion: value.dockerServerVersion,
        imageDigest: value.imageDigest,
        profileDigest: value.profileDigest,
        seccompDigest: value.seccompDigest,
      }),
      "utf8",
    )
    .digest("hex");
}

function releaseFailure(): never {
  throw new TypeError("The signed gated OCI release is not trusted.");
}

function currentRelease(payload: FastManimGatedOciReleasePayloadV1, now = Date.now()) {
  return Number.isSafeInteger(now) && payload.issuedAt <= now && now < payload.expiresAt;
}

const verifiedReleases = new WeakSet<VerifiedFastManimGatedOciReleaseV1>();
const verifiedReleaseCapability = Object.freeze({ kind: "verified-gated-oci-release" as const });

export class VerifiedFastManimGatedOciReleaseV1 {
  readonly #payload: FastManimGatedOciReleasePayloadV1;

  constructor(capability: typeof verifiedReleaseCapability, payload: FastManimGatedOciReleasePayloadV1) {
    if (capability !== verifiedReleaseCapability) releaseFailure();
    this.#payload = Object.freeze({ ...payload });
    verifiedReleases.add(this);
    Object.freeze(this);
  }

  descriptor() {
    if (!verifiedReleases.has(this) || !currentRelease(this.#payload)) return releaseFailure();
    return this.#payload;
  }

  readonly attestationVerifier: FastManimSandboxAttestationVerifierV1 = (status) => {
    try {
      const payload = this.descriptor();
      return (
        status.backendId === FAST_MANIM_PRODUCTION_GATED_OCI_BACKEND_ID_V1 &&
        status.backendKind === "production" &&
        status.health === "ready" &&
        status.attestation.trust === "verified" &&
        status.attestation.issuedAt === new Date(payload.issuedAt).toISOString() &&
        status.attestation.expiresAt === new Date(payload.expiresAt).toISOString() &&
        status.attestation.profileDigest === payload.profileDigest &&
        status.attestation.runtimeDigest === payload.runtimeDigest
      );
    } catch {
      return false;
    }
  };

  statusAttestation(): Extract<FastManimSandboxBackendStatusV1, { health: "ready" }>["attestation"] {
    const payload = this.descriptor();
    return {
      expiresAt: new Date(payload.expiresAt).toISOString(),
      issuedAt: new Date(payload.issuedAt).toISOString(),
      profileDigest: payload.profileDigest,
      runtimeDigest: payload.runtimeDigest,
      trust: "verified",
    };
  }
}

export function verifyFastManimGatedOciReleaseV1(
  signedValue: unknown,
  publicKeysValue: readonly FastManimGatedOciReleasePublicKeyV1[],
) {
  try {
    const signed = fastManimGatedOciSignedReleaseV1Schema.parse(signedValue);
    if (!currentRelease(signed.payload) || publicKeysValue.length === 0 || publicKeysValue.length > 32)
      releaseFailure();
    const keys = new Map<string, KeyObject>();
    for (const configured of publicKeysValue) {
      const parsed = z
        .object({ keyId: keyIdSchema, publicKeyPem: z.string().min(1).max(16_384) })
        .strict()
        .parse(configured);
      if (keys.has(parsed.keyId)) releaseFailure();
      const key = createPublicKey(parsed.publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") releaseFailure();
      keys.set(parsed.keyId, key);
    }
    const key = keys.get(signed.payload.keyId);
    const signature = Buffer.from(signed.signature, "base64url");
    if (
      !key ||
      signature.byteLength !== 64 ||
      signature.toString("base64url") !== signed.signature ||
      !verifySignature(null, Buffer.from(canonicalJsonV1(signed.payload), "utf8"), key, signature)
    ) {
      releaseFailure();
    }
    return new VerifiedFastManimGatedOciReleaseV1(verifiedReleaseCapability, signed.payload);
  } catch {
    return releaseFailure();
  }
}
