import { createPublicKey, type KeyObject, verify as verifySignature } from "node:crypto";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { FastManimOciBrokerDispatchV1, fastManimOciJobDescriptorV1Schema } from "./fast-manim-oci-sandbox-profile";
import {
  FastManimRuncMountedRootfsHandleV1,
  type FastManimRuncMountedRootfsLeaseV1,
  FastManimRuncMountedRootfsRegistryV1,
  isProductionFastManimRuncMountedRootfsRegistryV1,
} from "./fast-manim-runc-mounted-rootfs";

export const FAST_MANIM_RUNC_RELEASE_SCHEMA_V1 = "poietra.fast-manim-runc-release" as const;

const MAX_TRUSTED_KEYS_V1 = 32;
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
  rootfsRegistry: FastManimRuncMountedRootfsRegistryV1;
}>;

export class FastManimRuncReleaseTrustError extends Error {
  constructor() {
    super("Fast-manim runc release trust verification failed.");
    this.name = "FastManimRuncReleaseTrustError";
  }
}

const verifiedReleaseCapabilityV1 = Object.freeze({ kind: "fast-manim-runc-verified-release" as const });
const verifiedReleaseRegistriesV1 = new WeakMap<FastManimRuncVerifiedReleaseV1, FastManimRuncMountedRootfsRegistryV1>();
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
  readonly #rootfs: FastManimRuncMountedRootfsHandleV1;
  readonly #rootfsRegistry: FastManimRuncMountedRootfsRegistryV1;

  constructor(
    capability: typeof verifiedReleaseCapabilityV1,
    payload: FastManimRuncReleasePayloadV1,
    rootfs: FastManimRuncMountedRootfsHandleV1,
    rootfsRegistry: FastManimRuncMountedRootfsRegistryV1,
    now: () => number,
  ) {
    if (
      capability !== verifiedReleaseCapabilityV1 ||
      !(rootfs instanceof FastManimRuncMountedRootfsHandleV1) ||
      !(rootfsRegistry instanceof FastManimRuncMountedRootfsRegistryV1)
    ) {
      trustFailure();
    }
    this.#expiresAt = payload.expiresAt;
    this.#issuedAt = payload.issuedAt;
    this.#now = now;
    this.#payload = Object.freeze({ ...payload });
    this.#rootfs = rootfs;
    this.#rootfsRegistry = rootfsRegistry;
    verifiedReleaseRegistriesV1.set(this, rootfsRegistry);
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

  authorize(dispatch: FastManimOciBrokerDispatchV1) {
    try {
      if (!(dispatch instanceof FastManimOciBrokerDispatchV1)) trustFailure();
      this.#assertCurrent();
      const descriptor = fastManimOciJobDescriptorV1Schema.parse(dispatch.descriptor);
      if (RELEASE_DESCRIPTOR_DIGESTS.some((name) => descriptor[name] !== this.#payload[name])) trustFailure();
    } catch {
      return trustFailure();
    }
  }

  async assertReady(signal: AbortSignal) {
    try {
      this.#assertCurrent();
      await this.#rootfsRegistry.assertReady(signal);
      this.#assertCurrent();
    } catch {
      if (signal.aborted) signal.throwIfAborted();
      return trustFailure();
    }
  }

  async acquireRootfs(
    dispatch: FastManimOciBrokerDispatchV1,
    jobId: string,
    signal: AbortSignal,
  ): Promise<FastManimRuncMountedRootfsLeaseV1> {
    this.authorize(dispatch);
    const lease = await this.#rootfs.acquireForJob(jobId, signal);
    try {
      signal.throwIfAborted();
      this.#assertCurrent();
      return lease;
    } catch {
      await lease.close();
      if (signal.aborted) signal.throwIfAborted();
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
  readonly #rootfsRegistry: FastManimRuncMountedRootfsRegistryV1;

  constructor(options: FastManimRuncReleaseTrustOptionsV1) {
    try {
      if (
        !Array.isArray(options?.publicKeys) ||
        options.publicKeys.length === 0 ||
        options.publicKeys.length > MAX_TRUSTED_KEYS_V1 ||
        !(options.rootfsRegistry instanceof FastManimRuncMountedRootfsRegistryV1) ||
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
      this.#rootfsRegistry = options.rootfsRegistry;
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
      const rootfs = this.#rootfsRegistry.resolve(release.payload.rootfsDigest);
      return new FastManimRuncVerifiedReleaseV1(
        verifiedReleaseCapabilityV1,
        release.payload,
        rootfs,
        this.#rootfsRegistry,
        this.#now,
      );
    } catch {
      return trustFailure();
    }
  }
}

export function isProductionFastManimRuncVerifiedReleaseV1(value: unknown): value is FastManimRuncVerifiedReleaseV1 {
  if (!(value instanceof FastManimRuncVerifiedReleaseV1)) return false;
  const registry = verifiedReleaseRegistriesV1.get(value);
  return registry !== undefined && isProductionFastManimRuncMountedRootfsRegistryV1(registry);
}
