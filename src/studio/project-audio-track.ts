import { validateExportAudioWav } from "../engine/export-audio-wav";
import { MAX_EXPORT_WAV_BYTES } from "../engine/export-worker-protocol";

export type ProjectAudioTrack = Readonly<{
  fileName: string;
  wavBytes: ArrayBuffer;
}>;

type ProjectAudioWavValidator = (wavBytes: ArrayBuffer) => Promise<void>;

export async function ingestProjectAudioWav(
  file: File,
  validateWav: ProjectAudioWavValidator = validateExportAudioWav,
): Promise<ProjectAudioTrack> {
  if (file.size < 1 || file.size > MAX_EXPORT_WAV_BYTES) {
    throw new TypeError(`Choose a non-empty WAV file no larger than ${MAX_EXPORT_WAV_BYTES / (1024 * 1024)} MiB.`);
  }
  const wavBytes = await file.arrayBuffer();
  await validateWav(wavBytes);
  return { fileName: file.name || "project-audio.wav", wavBytes };
}

export function cloneProjectAudioTrack(track: ProjectAudioTrack): ProjectAudioTrack {
  return { fileName: track.fileName, wavBytes: track.wavBytes.slice(0) };
}
