import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { opaqueIdV1Schema, sha256V1Schema } from "../src/engine/primitives";
import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import {
  type FastManimRuntimeTraceProducerRequestV1,
  fastManimRuntimeTraceProducerRequestV1Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1,
} from "./fast-manim-runtime-trace-contract";
import {
  type FastManimRuntimeTraceProducerRequestV2,
  fastManimRuntimeTraceProducerRequestV2Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2,
} from "./fast-manim-runtime-trace-v2-contract";
import {
  type FastManimSnapshotProducerRequestV1,
  fastManimSnapshotProducerRequestV1Schema,
  MAX_FAST_MANIM_PROFILE_SELECTION_RESULT_JSON_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES,
} from "./fast-manim-snapshot-contract";
import {
  type FastManimSnapshotProfileSelectionRequestV1,
  fastManimSnapshotProfileSelectionRequestV1Schema,
} from "./fast-manim-snapshot-profile-selection";
import {
  inspectProjectPngBytesV1,
  MAX_PROJECT_PNG_BYTES_V1,
  MAX_PROJECT_PNG_DIMENSION_V1,
  PROJECT_PNG_LOGICAL_PATH_V1,
} from "./storage/project-png-storage";

export const FAST_MANIM_SANDBOX_STATUS_SCHEMA_V1 = "poietra.fast-manim-sandbox-status" as const;
export const FAST_MANIM_SANDBOX_STATUS_VERSION_V1 = 1 as const;
export const FAST_MANIM_SANDBOX_REQUEST_SCHEMA_V2 = "poietra.fast-manim-sandbox-request" as const;
export const FAST_MANIM_SANDBOX_REQUEST_SCHEMA_V3 = "poietra.fast-manim-sandbox-request" as const;
export const MAX_FAST_MANIM_SANDBOX_LEGACY_REQUEST_BYTES = MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES + 64 * 1024;
export const MAX_FAST_MANIM_SANDBOX_PLAIN_REQUEST_BYTES = Math.max(
  MAX_FAST_MANIM_SANDBOX_LEGACY_REQUEST_BYTES,
  MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2,
);
const MAX_FAST_MANIM_SANDBOX_PNG_BASE64_BYTES = 4 * Math.ceil(MAX_PROJECT_PNG_BYTES_V1 / 3);
export const MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES =
  MAX_FAST_MANIM_SANDBOX_PLAIN_REQUEST_BYTES + MAX_FAST_MANIM_SANDBOX_PNG_BASE64_BYTES + 64 * 1024;
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

const fastManimSandboxPngAssetV2Schema = z
  .object({
    byteLength: z.number().int().positive().max(MAX_PROJECT_PNG_BYTES_V1),
    bytesBase64: z.string().max(MAX_FAST_MANIM_SANDBOX_PNG_BASE64_BYTES),
    digest: sha256V1Schema,
    height: z.number().int().positive().max(MAX_PROJECT_PNG_DIMENSION_V1),
    logicalPath: z.literal(PROJECT_PNG_LOGICAL_PATH_V1),
    mediaType: z.literal("image/png"),
    width: z.number().int().positive().max(MAX_PROJECT_PNG_DIMENSION_V1),
  })
  .strict()
  .superRefine((asset, context) => {
    const bytes = Buffer.from(asset.bytesBase64, "base64");
    if (bytes.toString("base64") !== asset.bytesBase64) {
      context.addIssue({ code: "custom", message: "Snapshot PNG bytes must use canonical base64." });
      return;
    }
    try {
      const inspected = inspectProjectPngBytesV1(bytes);
      if (
        inspected.byteSize !== asset.byteLength ||
        inspected.digest !== asset.digest ||
        inspected.height !== asset.height ||
        inspected.width !== asset.width
      ) {
        context.addIssue({ code: "custom", message: "Snapshot PNG metadata does not match its verified bytes." });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Snapshot PNG bytes are not a bounded static PNG." });
    }
  });

const fastManimSandboxRequestEnvelopeV2Schema = z
  .object({
    assets: z.array(fastManimSandboxPngAssetV2Schema).length(1),
    producerRequest: fastManimSnapshotProducerRequestV1Schema,
    schema: z.literal(FAST_MANIM_SANDBOX_REQUEST_SCHEMA_V2),
    version: z.literal(2),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (Number(envelope.producerRequest.snapshotVersion) !== 4) {
      context.addIssue({
        code: "custom",
        message: "Snapshot PNG assets are accepted only by producer profile 4.",
        path: ["producerRequest", "snapshotVersion"],
      });
    }
  });

type FastManimSandboxRequestEnvelopeV2 = z.infer<typeof fastManimSandboxRequestEnvelopeV2Schema>;

const fastManimSandboxRequestEnvelopeV3Schema = z
  .object({
    assets: z.array(fastManimSandboxPngAssetV2Schema).length(1),
    producerRequest: fastManimSnapshotProfileSelectionRequestV1Schema,
    schema: z.literal(FAST_MANIM_SANDBOX_REQUEST_SCHEMA_V3),
    version: z.literal(3),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (!envelope.producerRequest.policy.candidates.some(({ snapshotVersion }) => snapshotVersion === 4)) {
      context.addIssue({
        code: "custom",
        message: "A profile-selection PNG attachment requires an offered profile 4 candidate.",
        path: ["producerRequest", "policy", "candidates"],
      });
    }
  });

type FastManimSandboxRequestEnvelopeV3 = z.infer<typeof fastManimSandboxRequestEnvelopeV3Schema>;
export type FastManimSnapshotProducerOrSelectionRequestV1 =
  | FastManimSnapshotProducerRequestV1
  | FastManimSnapshotProfileSelectionRequestV1;

export const fastManimSnapshotProducerOrSelectionRequestV1Schema = z.union([
  fastManimSnapshotProducerRequestV1Schema,
  fastManimSnapshotProfileSelectionRequestV1Schema,
]);

export type FastManimSandboxProducerRequestV1 =
  | FastManimSnapshotProducerOrSelectionRequestV1
  | FastManimRuntimeTraceProducerRequestV1
  | FastManimRuntimeTraceProducerRequestV2;

export const fastManimSandboxProducerRequestV1Schema = z.union([
  fastManimSnapshotProducerRequestV1Schema,
  fastManimSnapshotProfileSelectionRequestV1Schema,
  fastManimRuntimeTraceProducerRequestV1Schema,
  fastManimRuntimeTraceProducerRequestV2Schema,
]);

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
 * by another lifecycle stage. Profiles 1-3, 5, and 6 retain their exact legacy
 * producer JSON bytes. Profile 4 uses the Studio-owned V2 envelope to bind one
 * verified PNG while copyProducerRequestBytes() still returns the unchanged
 * strict producer JSON. No host workspace or object-store locator enters either
 * form. Producer-owned profile selection remains raw without assets and uses
 * the V3 attachment envelope when its offer includes the PNG profile. Runtime
 * Trace requests are a separate plain V1 schema with their own byte ceiling.
 */
export class FastManimSandboxRequestBundleV1 {
  readonly byteLength: number;
  readonly producerKind: "runtime-trace" | "snapshot";
  readonly requestDigest: string;
  readonly version: 1 | 2 | 3;
  readonly #bytes: Uint8Array;
  readonly #pngBytes: Uint8Array | undefined;
  readonly #producerRequestBytes: Uint8Array;

  constructor(value: FastManimSandboxProducerRequestV1, options?: Readonly<{ pngBytes: Uint8Array }>) {
    const request = fastManimSandboxProducerRequestV1Schema.parse(value);
    const runtimeTraceRequest = request.schema === "poietra.fast-manim-runtime-trace-producer-request";
    const plainRequestMaximumBytes = runtimeTraceRequest
      ? Math.max(MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1, MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2)
      : MAX_FAST_MANIM_SANDBOX_LEGACY_REQUEST_BYTES;
    const producerRequestBytes = copyFastManimSandboxUint8ArrayV1(
      Buffer.from(canonicalJsonV1(request), "utf8"),
      plainRequestMaximumBytes,
    );
    const selectionRequest = request.schema === "poietra.fast-manim-snapshot-profile-selection-request";
    const offersPng = runtimeTraceRequest
      ? false
      : selectionRequest
        ? request.policy.candidates.some(({ snapshotVersion }) => snapshotVersion === 4)
        : request.snapshotVersion === 4;
    if (offersPng && options === undefined) {
      throw new TypeError("Snapshot producer profile 4 requires one verified image.png asset.");
    }
    if (!offersPng && options !== undefined) {
      throw new TypeError("Snapshot PNG assets are accepted only by producer profile 4.");
    }

    let encoded: Buffer;
    let pngBytes: Uint8Array | undefined;
    if (options === undefined) {
      encoded = Buffer.from(producerRequestBytes);
      this.version = 1;
    } else {
      const inputPngBytes = copyFastManimSandboxUint8ArrayV1(options.pngBytes, MAX_PROJECT_PNG_BYTES_V1);
      const inspected = inspectProjectPngBytesV1(inputPngBytes);
      pngBytes = copyFastManimSandboxUint8ArrayV1(inspected.bytes, MAX_PROJECT_PNG_BYTES_V1);
      const asset = {
        byteLength: inspected.byteSize,
        bytesBase64: Buffer.from(pngBytes).toString("base64"),
        digest: inspected.digest,
        height: inspected.height,
        logicalPath: PROJECT_PNG_LOGICAL_PATH_V1,
        mediaType: "image/png" as const,
        width: inspected.width,
      } as const;
      const envelope: FastManimSandboxRequestEnvelopeV2 | FastManimSandboxRequestEnvelopeV3 = selectionRequest
        ? {
            assets: [asset],
            producerRequest: fastManimSnapshotProfileSelectionRequestV1Schema.parse(request),
            schema: FAST_MANIM_SANDBOX_REQUEST_SCHEMA_V3,
            version: 3,
          }
        : {
            assets: [asset],
            producerRequest: fastManimSnapshotProducerRequestV1Schema.parse(request),
            schema: FAST_MANIM_SANDBOX_REQUEST_SCHEMA_V2,
            version: 2,
          };
      encoded = Buffer.from(canonicalJsonV1(envelope), "utf8");
      this.version = selectionRequest ? 3 : 2;
    }
    const owned = copyFastManimSandboxUint8ArrayV1(
      encoded,
      this.version === 1 ? plainRequestMaximumBytes : MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES,
    );
    const ownedByteLength = inspectedFastManimSandboxUint8ArrayByteLengthV1(owned);
    if (ownedByteLength === null) throw new Error("The server-owned sandbox request copy is not a Uint8Array.");
    this.#bytes = owned;
    this.#pngBytes = pngBytes;
    this.#producerRequestBytes = producerRequestBytes;
    this.byteLength = ownedByteLength;
    this.producerKind = runtimeTraceRequest ? "runtime-trace" : "snapshot";
    this.requestDigest = createHash("sha256").update(owned).digest("hex");
    Object.freeze(this);
  }

  static fromBytes(value: Uint8Array) {
    const bytes = copyFastManimSandboxUint8ArrayV1(value, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (cause) {
      throw new TypeError("Sandbox request bytes are not valid UTF-8 JSON.", { cause });
    }
    const envelopeV2 = fastManimSandboxRequestEnvelopeV2Schema.safeParse(parsed);
    const envelopeV3 = fastManimSandboxRequestEnvelopeV3Schema.safeParse(parsed);
    const envelope = envelopeV2.success ? envelopeV2.data : envelopeV3.success ? envelopeV3.data : null;
    const bundle = envelope
      ? new FastManimSandboxRequestBundleV1(envelope.producerRequest, {
          pngBytes: Uint8Array.from(Buffer.from(envelope.assets[0].bytesBase64, "base64")),
        })
      : new FastManimSandboxRequestBundleV1(fastManimSandboxProducerRequestV1Schema.parse(parsed));
    if (!Buffer.from(bundle.copyBytes()).equals(Buffer.from(bytes))) {
      throw new TypeError("Sandbox request bytes are not in canonical sealed form.");
    }
    return bundle;
  }

  copyBytes() {
    return copyFastManimSandboxUint8ArrayV1(this.#bytes, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
  }

  copyPngBytes() {
    return this.#pngBytes === undefined
      ? undefined
      : copyFastManimSandboxUint8ArrayV1(this.#pngBytes, MAX_PROJECT_PNG_BYTES_V1);
  }

  copyProducerRequestBytes() {
    return copyFastManimSandboxUint8ArrayV1(
      this.#producerRequestBytes,
      this.producerKind === "runtime-trace"
        ? Math.max(
            MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1,
            MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2,
          )
        : MAX_FAST_MANIM_SANDBOX_LEGACY_REQUEST_BYTES,
    );
  }
}

export function verifyFastManimSandboxRequestBundleV1(bundle: FastManimSandboxRequestBundleV1) {
  const bytes = bundle.copyBytes();
  const maximumBytes =
    bundle.version === 1
      ? bundle.producerKind === "runtime-trace"
        ? Math.max(
            MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V1,
            MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2,
          )
        : MAX_FAST_MANIM_SANDBOX_LEGACY_REQUEST_BYTES
      : MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES;
  if (bytes.byteLength !== bundle.byteLength || bytes.byteLength > maximumBytes) return false;
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
  return byteLength !== null && byteLength <= MAX_FAST_MANIM_PROFILE_SELECTION_RESULT_JSON_BYTES;
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
