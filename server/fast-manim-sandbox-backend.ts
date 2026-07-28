import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { opaqueIdV1Schema, sha256V1Schema } from "../src/engine/primitives";
import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import {
  type FastManimSnapshotProducerRequestV1,
  fastManimSnapshotProducerRequestV1Schema,
  MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES,
  MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES,
} from "./fast-manim-snapshot-contract";

export const FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1 = "poietra.fast-manim-sandbox-status" as const;
export const FAST_MANIM_SANDBOX_STATUS_VERSION_V1 = 1 as const;
export const MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES = MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES + 32 * 1024;
export const MAX_FAST_MANIM_SANDBOX_STATUS_CANONICAL_JSON_BYTES = 4 * 1024;
export const MAX_FAST_MANIM_SANDBOX_STATUS_FIELD_UTF8_BYTES = 512;
/** Production adapters must enforce this limit before parsing a raw status response as JSON. */
export const MAX_FAST_MANIM_SANDBOX_STATUS_RAW_JSON_BYTES = 8 * 1024;

export const FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1 = Object.freeze([
  "abort",
  "bounded-result",
  "deadline",
  "immutable-request",
] as const);

const fastManimSandboxCapabilityV1Schema = z.enum(FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1);
const fastManimSandboxBackendKindV1Schema = z.enum(["disabled", "local-process", "production"]);
const boundedStatusOpaqueIdV1Schema = opaqueIdV1Schema.refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_FAST_MANIM_SANDBOX_STATUS_FIELD_UTF8_BYTES,
  "Sandbox status fields exceed the UTF-8 byte budget.",
);
const boundedStatusSha256V1Schema = sha256V1Schema.refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_FAST_MANIM_SANDBOX_STATUS_FIELD_UTF8_BYTES,
  "Sandbox status fields exceed the UTF-8 byte budget.",
);
const boundedStatusUtf8StringV1Schema = z
  .string()
  .max(MAX_FAST_MANIM_SANDBOX_STATUS_FIELD_UTF8_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_FAST_MANIM_SANDBOX_STATUS_FIELD_UTF8_BYTES,
    "Sandbox status fields exceed the UTF-8 byte budget.",
  );
const canonicalMillisecondUtcTimestampV1Schema = boundedStatusUtf8StringV1Schema.pipe(
  z
    .string()
    .length(24)
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    .refine((value) => {
      const epochMs = Date.parse(value);
      return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
    }, "Sandbox attestation timestamps must be canonical millisecond UTC timestamps."),
);

const statusBase = {
  backendId: boundedStatusOpaqueIdV1Schema,
  backendKind: fastManimSandboxBackendKindV1Schema,
  schema: z.literal(FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1),
  version: z.literal(FAST_MANIM_SANDBOX_STATUS_VERSION_V1),
};

const capabilitiesSchema = z
  .array(fastManimSandboxCapabilityV1Schema)
  .max(FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1.length)
  .refine((entries) => entries.every((entry, index) => index === 0 || entries[index - 1]! < entry), {
    message: "Sandbox backend capabilities must be sorted and unique.",
  });

export const fastManimSandboxBackendStatusV1Schema = z
  .discriminatedUnion("health", [
    z
      .object({
        ...statusBase,
        capabilities: z.array(fastManimSandboxCapabilityV1Schema).max(0),
        health: z.literal("unavailable"),
        reason: z.enum(["disabled", "health-check-failed", "not-configured"]),
      })
      .strict(),
    z
      .object({
        ...statusBase,
        attestation: z.discriminatedUnion("trust", [
          z
            .object({
              profileDigest: boundedStatusSha256V1Schema,
              runtimeDigest: boundedStatusSha256V1Schema,
              trust: z.literal("development-only"),
            })
            .strict(),
          z
            .object({
              expiresAt: canonicalMillisecondUtcTimestampV1Schema,
              issuedAt: canonicalMillisecondUtcTimestampV1Schema,
              profileDigest: boundedStatusSha256V1Schema,
              runtimeDigest: boundedStatusSha256V1Schema,
              trust: z.literal("verified"),
            })
            .strict(),
        ]),
        capabilities: capabilitiesSchema,
        health: z.literal("ready"),
      })
      .strict(),
  ])
  .superRefine((status, context) => {
    if (Buffer.byteLength(canonicalJsonV1(status), "utf8") > MAX_FAST_MANIM_SANDBOX_STATUS_CANONICAL_JSON_BYTES) {
      context.addIssue({ code: "custom", message: "Sandbox status exceeds the canonical JSON byte budget." });
    }
  });

export type FastManimSandboxBackendStatusV1 = z.infer<typeof fastManimSandboxBackendStatusV1Schema>;
const fastManimSandboxDeploymentSchema = z.enum(["development", "production", "test"]);
export type FastManimSandboxDeployment = z.infer<typeof fastManimSandboxDeploymentSchema>;

export function parseFastManimSandboxDeployment(value: unknown) {
  return fastManimSandboxDeploymentSchema.parse(value);
}

export type FastManimSandboxReadiness =
  | Readonly<{
      attestationDigest: string;
      kind: "ready";
      status: Extract<FastManimSandboxBackendStatusV1, { health: "ready" }>;
    }>
  | Readonly<{ code: "sandbox-attestation-rejected" | "sandbox-unavailable"; kind: "failed" }>;

export type FastManimSandboxAttestationVerifierV1 = (
  status: Extract<FastManimSandboxBackendStatusV1, { health: "ready" }>,
) => boolean;

/**
 * Treats every backend status as untrusted wire data. Production accepts only
 * a ready production adapter with a current verified attestation and the full
 * lifecycle capability set. Local-process status can only pass in dev/test.
 */
export function resolveFastManimSandboxReadiness(
  value: unknown,
  deployment: FastManimSandboxDeployment,
  now = Date.now(),
  productionAttestationVerifier?: FastManimSandboxAttestationVerifierV1,
): FastManimSandboxReadiness {
  const parsedDeployment = fastManimSandboxDeploymentSchema.safeParse(deployment);
  if (!parsedDeployment.success) return { code: "sandbox-attestation-rejected", kind: "failed" };
  let parsed: ReturnType<typeof fastManimSandboxBackendStatusV1Schema.safeParse>;
  try {
    parsed = fastManimSandboxBackendStatusV1Schema.safeParse(value);
  } catch {
    return { code: "sandbox-attestation-rejected", kind: "failed" };
  }
  if (!parsed.success) return { code: "sandbox-attestation-rejected", kind: "failed" };
  const status = parsed.data;
  if (status.health !== "ready") return { code: "sandbox-unavailable", kind: "failed" };
  if (FAST_MANIM_SANDBOX_REQUIRED_CAPABILITIES_V1.some((capability) => !status.capabilities.includes(capability))) {
    return { code: "sandbox-attestation-rejected", kind: "failed" };
  }
  if (parsedDeployment.data === "production") {
    if (status.backendKind !== "production" || status.attestation.trust !== "verified") {
      return { code: "sandbox-attestation-rejected", kind: "failed" };
    }
    const issuedAt = Date.parse(status.attestation.issuedAt);
    const expiresAt = Date.parse(status.attestation.expiresAt);
    if (issuedAt > now || expiresAt <= now || issuedAt >= expiresAt) {
      return { code: "sandbox-attestation-rejected", kind: "failed" };
    }
    try {
      if (productionAttestationVerifier?.(status) !== true) {
        return { code: "sandbox-attestation-rejected", kind: "failed" };
      }
    } catch {
      return { code: "sandbox-attestation-rejected", kind: "failed" };
    }
  } else if (status.backendKind === "disabled") {
    return { code: "sandbox-unavailable", kind: "failed" };
  }
  const attestationDigest = createHash("sha256").update(canonicalJsonV1(status), "utf8").digest("hex");
  return { attestationDigest, kind: "ready", status };
}

/**
 * Opaque immutable request bundle. Consumers receive a fresh byte copy on each
 * access, so neither a backend nor the caller can mutate the bytes later seen
 * by another lifecycle stage. The bytes are canonical JSON for the existing
 * producer request schema; logical relative sourcePath is correlation data,
 * never a host workspace path.
 */
export class FastManimSandboxRequestBundleV1 {
  readonly byteLength: number;
  readonly requestDigest: string;
  readonly version = 1 as const;
  readonly #bytes: Uint8Array;

  constructor(value: FastManimSnapshotProducerRequestV1) {
    const request = fastManimSnapshotProducerRequestV1Schema.parse(value);
    const bytes = Buffer.from(canonicalJsonV1(request), "utf8");
    const owned = copyFastManimSandboxUint8ArrayV1(bytes, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
    const ownedByteLength = inspectedFastManimSandboxUint8ArrayByteLengthV1(owned);
    if (ownedByteLength === null) throw new Error("The server-owned sandbox request copy is not a Uint8Array.");
    this.#bytes = owned;
    this.byteLength = ownedByteLength;
    this.requestDigest = createHash("sha256").update(owned).digest("hex");
    Object.freeze(this);
  }

  copyBytes() {
    return copyFastManimSandboxUint8ArrayV1(this.#bytes, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
  }
}

export function verifyFastManimSandboxRequestBundleV1(bundle: FastManimSandboxRequestBundleV1) {
  const bytes = bundle.copyBytes();
  if (bytes.byteLength !== bundle.byteLength || bytes.byteLength > MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES) return false;
  return createHash("sha256").update(bytes).digest("hex") === bundle.requestDigest;
}

export type FastManimSandboxJobIdentityV1 = Readonly<{
  projectId: string;
  requestId: string;
  tenantId: string;
}>;

export function parseFastManimSandboxJobIdentityV1(value: FastManimSandboxJobIdentityV1) {
  return Object.freeze(
    z
      .object({
        projectId: manimProjectIdSchema,
        requestId: opaqueIdV1Schema,
        tenantId: opaqueIdV1Schema,
      })
      .strict()
      .parse(value),
  );
}

export const fastManimSandboxBackendFailureCodeV1Schema = z.enum([
  "producer-exit",
  "producer-output-overflow",
  "producer-spawn-failed",
  "producer-timeout",
  "sandbox-attestation-rejected",
  "sandbox-execution-failed",
  "sandbox-result-rejected",
  "sandbox-unavailable",
]);

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const uint8ArraySet = Uint8Array.prototype.set;

if (!typedArrayBufferGetter || !typedArrayByteLengthGetter || !typedArrayTagGetter || !arrayBufferByteLengthGetter) {
  throw new Error("The JavaScript runtime does not expose the required TypedArray intrinsics.");
}

function inspectedFastManimSandboxUint8ArrayByteLengthV1(value: unknown): number | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return null;
  try {
    if (Reflect.apply(typedArrayTagGetter!, value, []) !== "Uint8Array") return null;
    const byteLength: unknown = Reflect.apply(typedArrayByteLengthGetter!, value, []);
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) return null;
    const buffer: unknown = Reflect.apply(typedArrayBufferGetter!, value, []);
    // Shared memory permits a concurrent writer to change bytes while the
    // server copies them, so it is never accepted as immutable wire output.
    Reflect.apply(arrayBufferByteLengthGetter!, buffer, []);
    if (arrayBufferResizableGetter && Reflect.apply(arrayBufferResizableGetter, buffer, []) === true) return null;
    return byteLength as number;
  } catch {
    return null;
  }
}

/**
 * Copies an actual, fixed-buffer Uint8Array through captured intrinsics. The
 * byte budget is checked from the TypedArray internal slot before allocation;
 * own byteLength/iterator/species properties are never consulted.
 */
export function copyFastManimSandboxUint8ArrayV1(value: unknown, maximumByteLength: number): Uint8Array {
  if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength < 0) {
    throw new RangeError("The sandbox byte-copy limit must be a non-negative safe integer.");
  }
  const byteLength = inspectedFastManimSandboxUint8ArrayByteLengthV1(value);
  if (byteLength === null || byteLength > maximumByteLength) {
    throw new RangeError("Sandbox bytes are not an accepted fixed Uint8Array within the configured byte budget.");
  }
  const owned = new Uint8Array(byteLength);
  try {
    Reflect.apply(uint8ArraySet, owned, [value]);
  } catch {
    throw new TypeError("Sandbox bytes could not be copied into server-owned memory.");
  }
  return owned;
}

const fastManimSandboxResultBytesV1Schema = z.custom<Uint8Array>((value) => {
  const byteLength = inspectedFastManimSandboxUint8ArrayByteLengthV1(value);
  return byteLength !== null && byteLength <= MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES;
}, "Sandbox results must be fixed Uint8Array bytes within the raw result byte budget.");

export const fastManimSandboxBackendResultV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      attestationDigest: sha256V1Schema,
      kind: z.literal("ok"),
      requestDigest: sha256V1Schema,
      resultBytes: fastManimSandboxResultBytesV1Schema,
    })
    .strict(),
  z
    .object({
      attestationDigest: sha256V1Schema,
      code: fastManimSandboxBackendFailureCodeV1Schema,
      kind: z.literal("failed"),
      requestDigest: sha256V1Schema,
    })
    .strict(),
]);
export type FastManimSandboxBackendFailureCodeV1 = z.infer<typeof fastManimSandboxBackendFailureCodeV1Schema>;
export type FastManimSandboxBackendResultV1 = Readonly<z.infer<typeof fastManimSandboxBackendResultV1Schema>>;

export type FastManimSandboxJobContextV1 = Readonly<{
  attestationDigest: string;
  deadlineEpochMs: number;
  identity: FastManimSandboxJobIdentityV1;
  signal: AbortSignal;
}>;

/**
 * Health and attestation reads are remote-backend operations too. They carry
 * the same opaque correlation and hard deadline as the job they authorize,
 * and must stop when the server aborts the supplied signal.
 */
export type FastManimSandboxStatusContextV1 = Readonly<{
  deadlineEpochMs: number;
  identity: FastManimSandboxJobIdentityV1;
  signal: AbortSignal;
}>;

export type FastManimSandboxJobHandleV1 = Readonly<{
  /** Must only allocate/dispatch abort work synchronously; it must never block. */
  abort: () => void;
  result: Promise<FastManimSandboxBackendResultV1>;
}>;

const fastManimSandboxBackendControlErrorCodes = new WeakMap<object, "capacity" | "cleanup">();

export class FastManimSandboxBackendControlError extends Error {
  readonly code: "capacity" | "cleanup";

  constructor(code: "capacity" | "cleanup") {
    super(code === "capacity" ? "Sandbox backend capacity is exhausted." : "Sandbox backend cleanup failed.");
    this.name = "FastManimSandboxBackendControlError";
    this.code = code;
    fastManimSandboxBackendControlErrorCodes.set(this, code);
  }
}

/** Classifies only server-registered control-error identities without inspecting foreign properties or prototypes. */
export function fastManimSandboxBackendControlErrorCode(value: unknown): "capacity" | "cleanup" | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return fastManimSandboxBackendControlErrorCodes.get(value);
}

/**
 * The sole Studio-side production execution boundary introduced by #81.
 * Every synchronous portion of status/start/abort/close MUST be non-blocking;
 * JavaScript timers cannot preempt a backend that blocks this event-loop
 * thread. Production isolation enforcing that property belongs to #82.
 */
export interface FastManimSandboxBackendV1 {
  /** Return a native Promise immediately. Remote cleanup must be asynchronous. */
  close(): Promise<void>;
  /** Allocate a handle immediately. Remote execution belongs to result. */
  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1): FastManimSandboxJobHandleV1;
  /**
   * Return a native Promise immediately. Production adapters MUST cap the raw
   * response at MAX_FAST_MANIM_SANDBOX_STATUS_RAW_JSON_BYTES before JSON.parse.
   */
  status(context: FastManimSandboxStatusContextV1): Promise<unknown>;
}

export class UnavailableFastManimSandboxBackendV1 implements FastManimSandboxBackendV1 {
  async close() {}

  start(request: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    return {
      abort() {},
      result: Promise.resolve({
        attestationDigest: context.attestationDigest,
        code: "sandbox-unavailable" as const,
        kind: "failed" as const,
        requestDigest: request.requestDigest,
      }),
    };
  }

  async status(context: FastManimSandboxStatusContextV1): Promise<FastManimSandboxBackendStatusV1> {
    context.signal.throwIfAborted();
    return {
      backendId: "sandbox-disabled",
      backendKind: "disabled",
      capabilities: [],
      health: "unavailable",
      reason: "not-configured",
      schema: FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1,
      version: FAST_MANIM_SANDBOX_STATUS_VERSION_V1,
    };
  }
}
