import { z } from "zod";

import { canvasPngAssetTransfersV1Schema } from "./canvas-png-assets";

/**
 * Page <-> export-worker protocol for the composed browser MP4 export
 * session (#722, #723).
 *
 * The worker owns one WASM `exportSceneMp4V1` run per request: the retained
 * validated Scene bundle, its PNG payloads, and one canonical
 * `ExportProfileV1` go in; bounded JSON progress envelopes come back; the
 * finalized MP4 returns as exactly one transferred `ArrayBuffer`. Every
 * failure is a named refusal from the closed reason set — never a partial
 * file, never bytes through JSON. A cancel request flips the active run's
 * flag; the Rust export loop observes it at its next progress report and
 * refuses with the named `cancelled` reason, discarding everything.
 */

export const POIETRA_EXPORT_WORKER_VERSION = 1 as const;

/** Mirror of Rust `MAX_BROWSER_EXPORT_PROGRESS_JSON_BYTES_V1`. */
export const MAX_EXPORT_PROGRESS_JSON_BYTES = 16 * 1024;

/** Largest local WAV attachment accepted by the browser export worker. */
export const MAX_EXPORT_WAV_BYTES = 64 * 1024 * 1024;

/** Mirror of the Rust rejection error name (`PoietraBrowserMp4ExportRefused`). */
export const BROWSER_EXPORT_REFUSED_ERROR_NAME = "PoietraBrowserMp4ExportRefused";

/**
 * Closed fail-closed refusal vocabulary of the Rust browser export
 * composition: its own stage reasons, the embedded `WebCodecs` encoder
 * refusal vocabulary, the chunk-timestamp verification violations, and the
 * user-intent `cancelled` reason (#723).
 */
export const EXPORT_REFUSAL_REASONS = [
  "api-unavailable",
  "asset-rejected",
  "cancelled",
  "capacity-exceeded",
  "chunk-timestamp-mismatch",
  "color-evidence-rejected",
  "encoder-error",
  "gpu-unavailable",
  "invalid-frame",
  "invalid-profile",
  "invalid-request",
  "invalid-scene",
  "invalid-timestamp",
  "invalid-wav",
  "mux-failed",
  "no-chunk",
  "no-decoder-config",
  "no-key-frame",
  "non-monotonic-chunk-timestamps",
  "output-limit-exceeded",
  "render-failed",
  "response-too-large",
  "scene-too-long",
  "serialization-failed",
  "session-closed",
  "timeout",
  "unsupported-codec",
  "unsupported-wav-bit-depth",
  "unsupported-wav-channels",
  "unsupported-wav-container",
  "unsupported-wav-format",
  "unsupported-wav-sample-rate",
  "wav-too-large",
] as const;

export const exportRefusalReasonV1Schema = z.enum(EXPORT_REFUSAL_REASONS);

export type ExportRefusalReasonV1 = z.infer<typeof exportRefusalReasonV1Schema>;

const nonNegativeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const exportProgressV1Schema = z
  .object({
    encodedMediaBytes: nonNegativeCount,
    frameCount: nonNegativeCount,
    framesEncoded: nonNegativeCount,
    kind: z.literal("progress"),
  })
  .strict();

export type ExportProgressV1 = z.infer<typeof exportProgressV1Schema>;

/** Bounded JSON envelope emitted by the Rust export loop per encoded frame. */
export const exportProgressEnvelopeV1Schema = z
  .object({
    result: exportProgressV1Schema,
    schema: z.literal("poietra.browser-export-progress"),
    version: z.literal(1),
  })
  .strict();

export type ExportProgressEnvelopeV1 = z.infer<typeof exportProgressEnvelopeV1Schema>;

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
    audioWav: z
      .instanceof(ArrayBuffer)
      .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_EXPORT_WAV_BYTES)
      .optional(),
    assetPayloads: canvasPngAssetTransfersV1Schema,
    kind: z.literal("export-mp4"),
    profileJson: z.instanceof(ArrayBuffer),
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
      progress: exportProgressV1Schema,
    })
    .strict(),
  z
    .object({
      ...responseEnvelope,
      bytes: z.instanceof(ArrayBuffer),
      kind: z.literal("export-finished"),
    })
    .strict(),
  z
    .object({
      ...responseEnvelope,
      kind: z.literal("export-refused"),
      message: z.string().min(1),
      reason: exportRefusalReasonV1Schema,
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
 * Maps a named `PoietraBrowserMp4ExportRefused` rejection (whose message
 * starts with the stable wire name) back onto the closed refusal vocabulary.
 * An unknown prefix is not guessed at: it reports `invalid-request` with the
 * complete original message preserved.
 */
export function exportRefusalFromError(error: unknown): Readonly<{
  message: string;
  reason: ExportRefusalReasonV1;
}> | null {
  if (!(error instanceof Error) || error.name !== BROWSER_EXPORT_REFUSED_ERROR_NAME) return null;
  const separator = error.message.indexOf(": ");
  const prefix = separator > 0 ? error.message.slice(0, separator) : null;
  const parsed = exportRefusalReasonV1Schema.safeParse(prefix);
  return {
    message: error.message,
    reason: parsed.success ? parsed.data : "invalid-request",
  };
}
