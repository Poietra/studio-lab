import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { MAX_EXPORT_OUTPUT_BYTES } from "../src/engine/export-profile";

/**
 * Pure validation for the `poietra:save-video-file` IPC channel (#723),
 * mirroring the `.py` save channel: plain-basename `.mp4` names only, a
 * bounded name length, and a byte cap equal to the canonical `ExportProfileV1`
 * output ceiling (`MAX_EXPORT_OUTPUT_BYTES`, 128 MiB). Anything ambiguous
 * throws; the handler never writes what it cannot fully validate.
 */

export const MAX_VIDEO_SAVE_FILE_NAME_LENGTH = 200;

/** Byte cap of one saved MP4: the closed `ExportProfileV1` output ceiling. */
export const MAX_VIDEO_SAVE_BYTES = MAX_EXPORT_OUTPUT_BYTES;

export type SaveVideoFileRequestV1 = Readonly<{ bytes: Uint8Array; fileName: string }>;

export function parseSaveVideoFileRequestV1(input: unknown): SaveVideoFileRequestV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Video export input is invalid.");
  }
  const { bytes, fileName } = input as Record<string, unknown>;
  if (
    typeof fileName !== "string" ||
    basename(fileName) !== fileName ||
    !fileName.toLowerCase().endsWith(".mp4") ||
    fileName.length > MAX_VIDEO_SAVE_FILE_NAME_LENGTH ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_VIDEO_SAVE_BYTES
  ) {
    throw new TypeError("Video export input is invalid.");
  }
  return { bytes, fileName };
}

/** Writes beside the destination and publishes only one complete MP4. */
export async function saveVideoFileAtomicallyV1(filePath: string, bytes: Uint8Array) {
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
