import { createPublicKey, type KeyObject, verify as verifySignature } from "node:crypto";
import { isAbsolute, parse as parsePath, resolve } from "node:path";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { FastManimOciBrokerDispatchV1, fastManimOciJobDescriptorV1Schema } from "./fast-manim-oci-sandbox-profile";

export const FAST_MANIM_RUNC_RELEASE_SCHEMA_V1 = "poietra.fast-manim-runc-release" as const;

const MAX_TRUSTED_KEYS_V1 = 32;
const MAX_ROOT_FILESYSTEMS_V1 = 64;
const keyIdV1Schema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
const sha256V1Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const imageDigestV1Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const fastManimRuncReleasePayloadV1Schema = z
  .object({
    expiresAt: z.number().int().safe().positive(),
    imageDigest: imageDigestV1Schema,
    issuedAt: z.number().int().safe().positive(),
    keyId: keyIdV1Schema,
    profileDigest: sha256V1Schema,
    rootfsDigest: sha256V1Schema,
    runtimeDigest: sha256V1Schema,
    sbomDigest: sha256V1Schema,
    schema: z.literal(FAST_MANIM_RUNC_RELEASE_SCHEMA_V1),
    seccompDigest: sha256V1Schema,
    version: z.literal(1),
  })
  .strict()
  .refine((payload) => payload.expiresAt > payload.issuedAt, "Release expiry must follow issuance.");

export type FastManimRuncReleasePayloadV1 = Readonly<z.infer<typeof fastManimRuncReleasePayloadV1Schema>>;

export const fastManimRuncSignedReleaseV1Schema = z
  .object({
    payload: fastManimRuncReleasePayloadV1Schema,
    signature: z
      .string()
      .length(86)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();

export type FastManimRuncSignedReleaseV1 = Readonly<z.infer<typeof fastManimRuncSignedReleaseV1Schema>>;

export type FastManimRuncReleaseAttestationV1 = Readonly<{
  expiresAt: number;
  issuedAt: number;
  profileDigest: string;
  runtimeDigest: string;
}>;

export type FastManimRuncReleaseTrustOptionsV1 = Readonly<{
  now?: () => number;
  publicKeys: readonly Readonly<{ keyId: string; publicKeyPem: string }>[];
  rootFilesystems: readonly Readonly<{ rootfsDigest: string; rootfsPath: string }>[];
}>;

export class FastManimRuncReleaseTrustError extends Error {
  constructor() {
    super("Fast-manim runc release trust verification failed.");
    this.name = "FastManimRuncReleaseTrustError";
  }
}

const verifiedReleaseCapabilityV1 = Object.freeze({ kind: "fast-manim-runc-verified-release" as const });
const RELEASE_DESCRIPTOR_DIGESTS = Object.freeze([
  "imageDigest",
  "profileDigest",
  "runtimeDigest",
  "sbomDigest",
  "seccompDigest",
] as const);

function trustFailure(): never {
  throw new FastManimRuncReleaseTrustError();
}

function canonicalRootfsPath(value: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    trustFailure();
  }
  const canonical = resolve(value);
  if (canonical !== value || canonical === parsePath(canonical).root) trustFailure();
  return canonical;
}

function currentEpochMs(now: () => number) {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) trustFailure();
  return value;
}

function decodeEd25519Signature(value: string) {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 64 || bytes.toString("base64url") !== value) trustFailure();
  return bytes;
}

/**
 * Opaque authorization for one signed release. It never exposes signed
 * material or a host path until a server-owned dispatch matches every digest.
 */
export class FastManimRuncVerifiedReleaseV1 {
  readonly #expiresAt: number;
  readonly #issuedAt: number;
  readonly #now: () => number;
  readonly #payload: FastManimRuncReleasePayloadV1;
  readonly #rootfsPath: string;

  constructor(
    capability: typeof verifiedReleaseCapabilityV1,
    payload: FastManimRuncReleasePayloadV1,
    rootfsPath: string,
    now: () => number,
  ) {
    if (capability !== verifiedReleaseCapabilityV1) trustFailure();
    this.#expiresAt = payload.expiresAt;
    this.#issuedAt = payload.issuedAt;
    this.#now = now;
    this.#payload = Object.freeze({ ...payload });
    this.#rootfsPath = rootfsPath;
    Object.freeze(this);
  }

  attestation(): FastManimRuncReleaseAttestationV1 {
    try {
      this.#assertCurrent();
      return Object.freeze({
        expiresAt: this.#expiresAt,
        issuedAt: this.#issuedAt,
        profileDigest: this.#payload.profileDigest,
        runtimeDigest: this.#payload.runtimeDigest,
      });
    } catch {
      return trustFailure();
    }
  }

  resolveRootfsPath(dispatch: FastManimOciBrokerDispatchV1) {
    try {
      if (!(dispatch instanceof FastManimOciBrokerDispatchV1)) trustFailure();
      this.#assertCurrent();
      const descriptor = fastManimOciJobDescriptorV1Schema.parse(dispatch.descriptor);
      if (RELEASE_DESCRIPTOR_DIGESTS.some((name) => descriptor[name] !== this.#payload[name])) trustFailure();
      return this.#rootfsPath;
    } catch {
      return trustFailure();
    }
  }

  #assertCurrent() {
    const now = currentEpochMs(this.#now);
    if (now < this.#issuedAt || now >= this.#expiresAt) trustFailure();
  }
}

/** Server-configured Ed25519 keyring and digest-addressed rootfs registry. */
export class FastManimRuncReleaseTrustV1 {
  readonly #now: () => number;
  readonly #publicKeys = new Map<string, KeyObject>();
  readonly #rootFilesystems = new Map<string, string>();

  constructor(options: FastManimRuncReleaseTrustOptionsV1) {
    try {
      if (
        !Array.isArray(options?.publicKeys) ||
        options.publicKeys.length === 0 ||
        options.publicKeys.length > MAX_TRUSTED_KEYS_V1 ||
        !Array.isArray(options.rootFilesystems) ||
        options.rootFilesystems.length === 0 ||
        options.rootFilesystems.length > MAX_ROOT_FILESYSTEMS_V1 ||
        (options.now !== undefined && typeof options.now !== "function")
      ) {
        trustFailure();
      }
      this.#now = options.now ?? Date.now;
      for (const configured of options.publicKeys) {
        const parsed = z
          .object({ keyId: keyIdV1Schema, publicKeyPem: z.string().min(1).max(16_384) })
          .strict()
          .parse(configured);
        if (this.#publicKeys.has(parsed.keyId)) trustFailure();
        const publicKey = createPublicKey(parsed.publicKeyPem);
        if (publicKey.asymmetricKeyType !== "ed25519") trustFailure();
        this.#publicKeys.set(parsed.keyId, publicKey);
      }
      for (const configured of options.rootFilesystems) {
        const parsed = z.object({ rootfsDigest: sha256V1Schema, rootfsPath: z.string() }).strict().parse(configured);
        if (this.#rootFilesystems.has(parsed.rootfsDigest)) trustFailure();
        this.#rootFilesystems.set(parsed.rootfsDigest, canonicalRootfsPath(parsed.rootfsPath));
      }
    } catch {
      trustFailure();
    }
  }

  verify(value: unknown): FastManimRuncVerifiedReleaseV1 {
    try {
      const release = fastManimRuncSignedReleaseV1Schema.parse(value);
      const now = currentEpochMs(this.#now);
      if (release.payload.issuedAt > now || release.payload.expiresAt <= now) trustFailure();
      const publicKey = this.#publicKeys.get(release.payload.keyId);
      if (!publicKey) trustFailure();
      const signature = decodeEd25519Signature(release.signature);
      const signedBytes = Buffer.from(canonicalJsonV1(release.payload), "utf8");
      if (!verifySignature(null, signedBytes, publicKey, signature)) trustFailure();
      const rootfsPath = this.#rootFilesystems.get(release.payload.rootfsDigest);
      if (!rootfsPath) trustFailure();
      return new FastManimRuncVerifiedReleaseV1(verifiedReleaseCapabilityV1, release.payload, rootfsPath, this.#now);
    } catch {
      return trustFailure();
    }
  }
}
