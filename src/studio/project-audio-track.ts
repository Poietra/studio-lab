import { validateExportAudioWav } from "../engine/export-audio-wav";
import { MAX_EXPORT_WAV_BYTES } from "../engine/export-worker-protocol";

export type ProjectAudioTrack = Readonly<{
  fileName: string;
  sourceSampleFrames: number | null;
  timelineOffsetSampleFrames: number;
  trimEndSampleFrames: number | null;
  trimStartSampleFrames: number;
  wavBytes: ArrayBuffer;
}>;

export const PROJECT_AUDIO_SAMPLE_RATE_HZ = 48_000;

export type ProjectAudioTimingSeconds = Readonly<{
  offset: number;
  trimEnd: number | null;
  trimStart: number;
}>;

type ProjectAudioWavValidator = (wavBytes: ArrayBuffer) => Promise<number>;

function secondsToSampleFrames(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative number.`);
  const sampleFrames = Math.round(value * PROJECT_AUDIO_SAMPLE_RATE_HZ);
  if (!Number.isSafeInteger(sampleFrames)) throw new TypeError(`${label} is too large.`);
  return sampleFrames;
}

export function projectAudioTimingSeconds(track: ProjectAudioTrack): ProjectAudioTimingSeconds {
  return {
    offset: track.timelineOffsetSampleFrames / PROJECT_AUDIO_SAMPLE_RATE_HZ,
    trimEnd: track.trimEndSampleFrames === null ? null : track.trimEndSampleFrames / PROJECT_AUDIO_SAMPLE_RATE_HZ,
    trimStart: track.trimStartSampleFrames / PROJECT_AUDIO_SAMPLE_RATE_HZ,
  };
}

export function updateProjectAudioTiming(
  track: ProjectAudioTrack,
  timing: ProjectAudioTimingSeconds,
): ProjectAudioTrack {
  const timelineOffsetSampleFrames = secondsToSampleFrames(timing.offset, "Audio offset");
  const trimStartSampleFrames = secondsToSampleFrames(timing.trimStart, "Audio trim in");
  const trimEndSampleFrames = timing.trimEnd === null ? null : secondsToSampleFrames(timing.trimEnd, "Audio trim out");
  if (trimEndSampleFrames !== null && trimEndSampleFrames <= trimStartSampleFrames) {
    throw new TypeError("Audio trim out must be later than trim in.");
  }
  if (track.sourceSampleFrames !== null) {
    if (trimStartSampleFrames >= track.sourceSampleFrames) {
      throw new TypeError("Audio trim in must be earlier than the end of the WAV.");
    }
    if (trimEndSampleFrames !== null && trimEndSampleFrames > track.sourceSampleFrames) {
      throw new TypeError("Audio trim out cannot exceed the WAV duration.");
    }
  }
  return { ...track, timelineOffsetSampleFrames, trimEndSampleFrames, trimStartSampleFrames };
}

export async function ingestProjectAudioWav(
  file: File,
  validateWav: ProjectAudioWavValidator = validateExportAudioWav,
): Promise<ProjectAudioTrack> {
  if (file.size < 1 || file.size > MAX_EXPORT_WAV_BYTES) {
    throw new TypeError(`Choose a non-empty WAV file no larger than ${MAX_EXPORT_WAV_BYTES / (1024 * 1024)} MiB.`);
  }
  const wavBytes = await file.arrayBuffer();
  const sourceSampleFrames = await validateWav(wavBytes);
  if (!Number.isSafeInteger(sourceSampleFrames) || sourceSampleFrames < 1) {
    throw new TypeError("The WAV validator returned an invalid sample-frame count.");
  }
  return {
    fileName: file.name || "project-audio.wav",
    sourceSampleFrames,
    timelineOffsetSampleFrames: 0,
    trimEndSampleFrames: sourceSampleFrames,
    trimStartSampleFrames: 0,
    wavBytes,
  };
}

export function cloneProjectAudioTrack(track: ProjectAudioTrack): ProjectAudioTrack {
  return { ...track, wavBytes: track.wavBytes.slice(0) };
}
