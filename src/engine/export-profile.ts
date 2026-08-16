import { z } from "zod";

import { POIETRA_ENGINE_CONTRACT_VERSION } from "./primitives";

/**
 * Ceiling for an export profile's declared duration bound, in seconds.
 *
 * Matches the 900-second (15-minute) ceiling of the historically accepted
 * server render profile (`MAX_VIDEO_DURATION_SECONDS = 15 * 60` in
 * `sandbox/manim-render-gated-oci/render-entrypoint.py`).
 */
export const MAX_EXPORT_DURATION_SECONDS = 900;

/**
 * Ceiling for an export profile's declared output-size bound, in bytes (128 MiB).
 *
 * Matches `MAX_ARTIFACT_BYTES = 128 * 1024 * 1024` in
 * `sandbox/manim-render-gated-oci/render-entrypoint.py`.
 */
export const MAX_EXPORT_OUTPUT_BYTES = 134_217_728;

/**
 * Closed 16:9 output ladder aligned to the 8 x (128/9) scene-unit frame.
 *
 * 854x480 preserves the legacy accepted server render profile (854 px is the
 * even-width rounding of 480 x 16/9); 1280x720 and 1920x1080 are the exact
 * 16:9 rungs above it. Arbitrary integer dimensions are rejected by
 * construction.
 */
export const exportResolutionV1Schema = z.enum(["854x480", "1280x720", "1920x1080"]);

export type ExportResolutionV1 = z.infer<typeof exportResolutionV1Schema>;

export const EXPORT_RESOLUTION_PIXELS_V1 = {
  "854x480": { heightPx: 480, widthPx: 854 },
  "1280x720": { heightPx: 720, widthPx: 1280 },
  "1920x1080": { heightPx: 1080, widthPx: 1920 },
} as const satisfies Record<ExportResolutionV1, Readonly<{ heightPx: number; widthPx: number }>>;

/** Closed v1 sampling/output frame rate: the integer 30 or 60. */
export const exportFrameRateV1Schema = z.union([z.literal(30), z.literal(60)]);

/**
 * Closed v1 description of one client-side video export.
 *
 * Sampling frame-rate precedence (#693 Question 6 decision): the export
 * profile supplies the sampling fps. Export stepping walks output frame
 * indices `i` and samples the Scene at `state_sample_time(i / frameRate)`
 * using this profile's `frameRate`. `SceneIrV1.stateSampling.frameRate`
 * remains the Scene's own declaration of its retained-state sampling grid and
 * is NOT overwritten by the profile: the profile decides which instants are
 * requested, and the Scene's `stateSampling` decides how each requested
 * instant resolves to retained state. A Scene declaring `frameRate: null`
 * samples continuously at exactly the profile's requested instants.
 */
export const exportProfileV1Schema = z
  .object({
    codec: z.literal("h264-mp4"),
    colorContractVersion: z.literal(1),
    frameRate: exportFrameRateV1Schema,
    maxDurationSeconds: z.number().int().positive().max(MAX_EXPORT_DURATION_SECONDS),
    maxOutputBytes: z.number().int().positive().max(MAX_EXPORT_OUTPUT_BYTES),
    resolution: exportResolutionV1Schema,
    schema: z.literal("poietra.export-profile"),
    version: z.literal(POIETRA_ENGINE_CONTRACT_VERSION),
  })
  .strict();

export type ExportProfileV1 = z.infer<typeof exportProfileV1Schema>;

/**
 * Every profile field is a closed literal or an in-schema bound, so this Zod
 * parse is the complete v1 admission and mirrors the Rust
 * `parse_export_profile_json_v1`.
 */
export function parseExportProfileV1(value: unknown): ExportProfileV1 {
  return exportProfileV1Schema.parse(value);
}

function canonicalProfileMetadata(profile: ExportProfileV1) {
  return {
    codec: profile.codec,
    colorContractVersion: profile.colorContractVersion,
    frameRate: profile.frameRate,
    maxDurationSeconds: profile.maxDurationSeconds,
    maxOutputBytes: profile.maxOutputBytes,
    resolution: profile.resolution,
    schema: profile.schema,
    version: profile.version,
  };
}

/** Returns the byte-for-byte canonical profile JSON shared with the Rust v1 contract. */
export function canonicalExportProfileV1(profile: ExportProfileV1) {
  return JSON.stringify(canonicalProfileMetadata(profile));
}

/**
 * Computes the lower-case SHA-256 digest over the canonical export profile.
 *
 * The profile does not embed its own digest; this value names a profile in
 * publication lineage.
 */
export async function digestExportProfileV1(profile: ExportProfileV1) {
  const bytes = new TextEncoder().encode(canonicalExportProfileV1(profile));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
