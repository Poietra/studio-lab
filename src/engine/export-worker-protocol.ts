import { z } from "zod";

import { canvasPngAssetTransfersV1Schema } from "./canvas-png-assets";
import { exportProfileV1Schema } from "./export-profile";
import { sha256V1Schema } from "./primitives";

/**
 * Page <-> export-worker protocol for the composed browser MP4 export (#722).
 *
 * The worker owns one WASM `PoietraExportSessionV1` per request: the retained
 * validated Scene bundle, its PNG payloads, and one canonical
 * `ExportProfileV1` go in; bounded JSON progress envelopes come back; the
 * finalized MP4 returns as exactly one transferred `ArrayBuffer`. Every
 * failure is a named refusal from the closed reason set — never a partial
 * file, never bytes through JSON.
 */

export const POIETRA_EXPORT_WORKER_VERSION = 1 as const;

/** Mirror of the Rust export session ABI version (`poietraExportSessionAbiVersion`). */
export const POIETRA_EXPORT_SESSION_ABI_VERSION = 1;

/** Mirror of the Rust export encoder ABI version (`poietraExportEncoderAbiVersion`). */
export const POIETRA_EXPORT_ENCODER_ABI_VERSION = 1;

/** Mirror of Rust `MAX_EXPORT_SESSION_RESPONSE_JSON_BYTES_V1`. */
export const MAX_EXPORT_SESSION_RESPONSE_JSON_BYTES = 16 * 1024;

/** Mirror of Rust `MAX_EXPORT_ENCODER_RESPONSE_JSON_BYTES_V1`. */
export const MAX_EXPORT_ENCODER_RESPONSE_JSON_BYTES = 16 * 1024;

/**
 * Closed fail-closed refusal vocabulary of the Rust export session
 * (`ExportSessionRefusalReasonV1` wire names, which embed the encoder's
 * refusal vocabulary verbatim).
 */
export const EXPORT_SESSION_REFUSAL_REASONS = [
  "api-unavailable",
  "cancelled",
  "capacity-exceeded",
  "chunk-count-mismatch",
  "chunk-timestamp-mismatch",
  "color-unrepresentable",
  "duration-exceeded",
  "encoder-error",
  "gpu-unavailable",
  "invalid-frame",
  "invalid-profile",
  "invalid-request",
  "invalid-snapshot",
  "mux-failed",
  "no-chunk",
  "no-decoder-config",
  "no-key-frame",
  "non-monotonic-chunk-timestamps",
  "output-too-large",
  "render-failed",
  "response-too-large",
  "serialization-failed",
  "session-closed",
  "timeout",
  "unsupported-codec",
] as const;

export const exportSessionRefusalReasonV1Schema = z.enum(EXPORT_SESSION_REFUSAL_REASONS);

export type ExportSessionRefusalReasonV1 = z.infer<typeof exportSessionRefusalReasonV1Schema>;

const nonNegativeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Numeric `colr` (nclx) values recorded in the container, plus their authority. */
export const exportSessionColorEvidenceV1Schema = z
  .object({
    fullRange: z.boolean(),
    matrix: z.number().int().nonnegative().max(65_535),
    primaries: z.number().int().nonnegative().max(65_535),
    source: z.enum(["measured", "mixed", "requested"]),
    transfer: z.number().int().nonnegative().max(65_535),
  })
  .strict();

export type ExportSessionColorEvidenceV1 = z.infer<typeof exportSessionColorEvidenceV1Schema>;

export const exportSessionFinishedStatusV1Schema = z
  .object({
    chunkCount: nonNegativeCount,
    codec: z.string().min(1).max(64),
    color: exportSessionColorEvidenceV1Schema,
    exportProfileHash: sha256V1Schema,
    frameCount: nonNegativeCount,
    keyFrameCount: nonNegativeCount,
    kind: z.literal("finished"),
    outputByteLength: nonNegativeCount,
    sceneRevisionHash: sha256V1Schema,
  })
  .strict();

export type ExportSessionFinishedStatusV1 = z.infer<typeof exportSessionFinishedStatusV1Schema>;

export const exportSessionProgressV1Schema = z
  .object({
    chunksMuxed: nonNegativeCount,
    frameCount: nonNegativeCount,
    framesEncoded: nonNegativeCount,
    kind: z.literal("progress"),
    muxedMediaBytes: nonNegativeCount,
  })
  .strict();

export type ExportSessionProgressV1 = z.infer<typeof exportSessionProgressV1Schema>;

const exportSessionRefusedV1Schema = z
  .object({
    kind: z.literal("refused"),
    message: z.string().min(1),
    reason: exportSessionRefusalReasonV1Schema,
  })
  .strict();

/** Bounded JSON envelope emitted by the Rust `PoietraExportSessionV1`. */
export const exportSessionResponseV1Schema = z
  .object({
    result: z.discriminatedUnion("kind", [
      exportSessionFinishedStatusV1Schema,
      exportSessionProgressV1Schema,
      exportSessionRefusedV1Schema,
    ]),
    schema: z.literal("poietra.export-session-response"),
    version: z.literal(1),
  })
  .strict();

export type ExportSessionResponseV1 = z.infer<typeof exportSessionResponseV1Schema>;

/**
 * Bounded JSON envelope emitted by the Rust export-encoder probe
 * (`probeExportEncoderH264V1`). Only the closed shape this worker consumes is
 * modeled; unknown refusal reasons stay as their exact wire strings so the
 * probe's own vocabulary is reported truthfully.
 */
export const exportEncoderProbeResponseV1Schema = z
  .object({
    result: z.discriminatedUnion("kind", [
      z.object({ codec: z.string().min(1).max(64), kind: z.literal("supported") }).strict(),
      z.object({ kind: z.literal("refused"), message: z.string().min(1), reason: z.string().min(1).max(64) }).strict(),
    ]),
    schema: z.literal("poietra.export-encoder-response"),
    version: z.literal(1),
  })
  .strict();

export type ExportEncoderProbeResponseV1 = z.infer<typeof exportEncoderProbeResponseV1Schema>;

const requestEnvelope = {
  requestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  schema: z.literal("poietra.export-worker-request"),
  version: z.literal(POIETRA_EXPORT_WORKER_VERSION),
} as const;

const responseEnvelope = {
  requestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  schema: z.literal("poietra.export-worker-response"),
  version: z.literal(POIETRA_EXPORT_WORKER_VERSION),
} as const;

const exportMp4RequestV1Schema = z
  .object({
    ...requestEnvelope,
    assetPayloads: canvasPngAssetTransfersV1Schema,
    kind: z.literal("export-mp4"),
    profile: exportProfileV1Schema,
    revision: sha256V1Schema,
    snapshotJson: z.instanceof(ArrayBuffer),
    wasmModuleUrl: z.string().url().max(2_048),
  })
  .strict();

const exportCancelRequestV1Schema = z
  .object({
    ...requestEnvelope,
    kind: z.literal("export-cancel"),
  })
  .strict();

export const exportWorkerRequestV1Schema = z.discriminatedUnion("kind", [
  exportMp4RequestV1Schema,
  exportCancelRequestV1Schema,
]);

export type ExportWorkerRequestV1 = z.infer<typeof exportWorkerRequestV1Schema>;

export const exportWorkerResponseV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      ...responseEnvelope,
      kind: z.literal("export-progress"),
      progress: exportSessionProgressV1Schema,
    })
    .strict(),
  z
    .object({
      ...responseEnvelope,
      kind: z.literal("export-finished"),
      mp4: z.instanceof(ArrayBuffer),
      status: exportSessionFinishedStatusV1Schema,
    })
    .strict(),
  z
    .object({
      ...responseEnvelope,
      kind: z.literal("export-refused"),
      message: z.string().min(1),
      reason: exportSessionRefusalReasonV1Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("export-error"),
      message: z.string().min(1),
      requestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
      schema: z.literal("poietra.export-worker-response"),
      version: z.literal(POIETRA_EXPORT_WORKER_VERSION),
    })
    .strict(),
]);

export type ExportWorkerResponseV1 = z.infer<typeof exportWorkerResponseV1Schema>;

/**
 * Maps a named `PoietraExportSessionRefused` rejection (whose message starts
 * with the stable wire name) back onto the closed refusal vocabulary. An
 * unknown prefix is not guessed at: it reports `invalid-request` with the
 * complete original message preserved.
 */
export function exportSessionRefusalFromError(error: unknown): Readonly<{
  message: string;
  reason: ExportSessionRefusalReasonV1;
}> | null {
  if (!(error instanceof Error) || error.name !== "PoietraExportSessionRefused") return null;
  const separator = error.message.indexOf(": ");
  const prefix = separator > 0 ? error.message.slice(0, separator) : null;
  const parsed = exportSessionRefusalReasonV1Schema.safeParse(prefix);
  return {
    message: error.message,
    reason: parsed.success ? parsed.data : "invalid-request",
  };
}
