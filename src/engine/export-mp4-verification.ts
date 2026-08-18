import { z } from "zod";

import { loadPoietraWasmModule } from "./poietra-wasm-module";

/**
 * Rust-owned MP4 verification for client-export acceptance ("one core, two
 * hosts"): Node loads the same WASM artifact the browser exporter uses, so
 * the producer and the verifier share one container layout and provenance
 * contract. Bytes cross the boundary as byte transfers, never JSON, and the
 * 128 MiB cap is enforced before any parse on both sides of the boundary.
 */
export const MAX_VERIFIED_EXPORT_MP4_BYTES_V1 = 134_217_728;
export const MAX_EXPORT_MP4_VERIFICATION_RESPONSE_JSON_BYTES_V1 = 96 * 1024;
export const POIETRA_EXPORT_VERIFY_ABI_VERSION_V1 = 1;

const sha256SchemaV1 = z.string().regex(/^[0-9a-f]{64}$/u);

const exportMp4ColorSchemaV1 = z
  .object({
    fullRange: z.boolean(),
    matrix: z.number().int().min(0),
    primaries: z.number().int().min(0),
    transfer: z.number().int().min(0),
  })
  .strict();

const exportMp4AudioSchemaV1 = z
  .object({
    channels: z.union([z.literal(1), z.literal(2)]),
    encodedDurationSamples: z.number().int().nonnegative(),
    endTrimSamples: z.number().int().nonnegative(),
    outputGain: z.number().int().min(-32_768).max(32_767),
    preSkip: z.number().int().min(0).max(65_535),
    sampleCount: z.number().int().positive(),
    sampleRate: z.literal(48_000),
  })
  .strict();

const exportMp4StructureSchemaV1 = z
  .object({
    audio: exportMp4AudioSchemaV1.optional(),
    color: exportMp4ColorSchemaV1,
    durationTicks: z.number().int().min(0),
    frameRate: z.union([z.literal(30), z.literal(60)]),
    heightPx: z.number().int().min(1),
    sampleCount: z.number().int().min(1),
    syncSampleCount: z.number().int().min(1),
    timescale: z.number().int().min(1),
    widthPx: z.number().int().min(1),
  })
  .strict();

const exportProvenanceSchemaV1 = z
  .object({
    engineAbiVersion: z.number().int().min(1),
    exportProfileHash: sha256SchemaV1,
    sceneId: z
      .string()
      .min(1)
      .max(240)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/#-]*$/u),
    sceneRevisionHash: sha256SchemaV1,
  })
  .strict();

const exportMp4VerificationRefusalCodeSchemaV1 = z.enum([
  "color-parameters-missing",
  "duration-exceeded",
  "input-too-large",
  "internal-failure",
  "keyframe-first-missing",
  "layout-mismatch",
  "malformed-container",
  "provenance-invalid",
  "provenance-missing",
  "provenance-too-large",
  "resolution-unsupported",
  "sample-table-mismatch",
  "track-mismatch",
]);

const exportMp4VerificationResponseSchemaV1 = z
  .object({
    result: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("verified"),
          provenance: exportProvenanceSchemaV1,
          structure: exportMp4StructureSchemaV1,
        })
        .strict(),
      z
        .object({
          code: exportMp4VerificationRefusalCodeSchemaV1,
          kind: z.literal("refused"),
          message: z.string().max(4_096),
        })
        .strict(),
    ]),
    schema: z.literal("poietra.export-mp4-verification"),
    version: z.literal(1),
  })
  .strict();

export type ExportMp4VerificationResultV1 = z.infer<typeof exportMp4VerificationResponseSchemaV1>["result"];

type ExportMp4VerifyBindingsV1 = Readonly<{
  verifyExportMp4V1: (mp4Bytes: Uint8Array) => Uint8Array;
}>;

let bindingsPromise: Promise<ExportMp4VerifyBindingsV1> | null = null;

async function loadBindings(): Promise<ExportMp4VerifyBindingsV1> {
  if (bindingsPromise) return bindingsPromise;
  const pending: Promise<ExportMp4VerifyBindingsV1> = (async () => {
    const candidate = await loadPoietraWasmModule();
    if (
      typeof candidate.poietraExportVerifyAbiVersion !== "function" ||
      candidate.poietraExportVerifyAbiVersion() !== POIETRA_EXPORT_VERIFY_ABI_VERSION_V1 ||
      typeof candidate.verifyExportMp4V1 !== "function"
    ) {
      throw new Error("The Poietra WASM module does not export MP4 verification.");
    }
    return {
      verifyExportMp4V1: candidate.verifyExportMp4V1 as ExportMp4VerifyBindingsV1["verifyExportMp4V1"],
    };
  })();
  bindingsPromise = pending;
  return pending;
}

/** Test seam mirroring the other engine binding loaders; production code never calls this. */
export function resetExportMp4VerificationBindingsForTestV1() {
  bindingsPromise = null;
}

/** Fail-closed readiness probe for the packaged canonical WASM verifier. */
export async function exportMp4VerificationReadyV1(signal?: AbortSignal) {
  try {
    signal?.throwIfAborted();
    await loadBindings();
    signal?.throwIfAborted();
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/**
 * Structurally verifies one client-produced MP4 and extracts its provenance.
 * Refusals are data, not exceptions: only a missing/incompatible WASM module
 * or a response outside the versioned contract throws.
 */
export async function verifyExportMp4V1(bytes: Uint8Array): Promise<ExportMp4VerificationResultV1> {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("The export MP4 verification input must be bytes.");
  if (bytes.byteLength > MAX_VERIFIED_EXPORT_MP4_BYTES_V1) {
    return {
      code: "input-too-large",
      kind: "refused",
      message: "The export MP4 exceeds the 128 MiB verification bound.",
    };
  }
  const bindings = await loadBindings();
  const responseBytes = bindings.verifyExportMp4V1(bytes);
  if (
    !(responseBytes instanceof Uint8Array) ||
    responseBytes.byteLength < 2 ||
    responseBytes.byteLength > MAX_EXPORT_MP4_VERIFICATION_RESPONSE_JSON_BYTES_V1
  ) {
    throw new Error("The export MP4 verification response exceeds its transfer bound.");
  }
  let responseValue: unknown;
  try {
    responseValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
  } catch {
    throw new Error("The export MP4 verification response is not valid JSON.");
  }
  const parsed = exportMp4VerificationResponseSchemaV1.safeParse(responseValue);
  if (!parsed.success) {
    throw new Error("The export MP4 verification response does not match the versioned contract.");
  }
  return parsed.data.result;
}
