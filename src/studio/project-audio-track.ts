import { validateExportAudioWav } from "../engine/export-audio-wav";
import { MAX_EXPORT_WAV_BYTES } from "../engine/export-worker-protocol";

export type ProjectAudioTrack = Readonly<{
  fileName: string;
  sourceSampleFrames: number | null;
  timelineOffsetSampleFrames: number;
  trimEndSampleFrames: number | null;
  trimStartSampleFrames: number;
  volumePercent: number;
  wavBytes: ArrayBuffer;
}>;

export const PROJECT_AUDIO_SAMPLE_RATE_HZ = 48_000;
export const DEFAULT_PROJECT_AUDIO_VOLUME_PERCENT = 100;

export type ProjectAudioTimingSeconds = Readonly<{
  offset: number;
  trimEnd: number | null;
  trimStart: number;
}>;

export type ProjectAudioTimelineGesture = "body" | "left" | "right";

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

export function updateProjectAudioVolume(track: ProjectAudioTrack, volumePercent: number): ProjectAudioTrack {
  if (!Number.isSafeInteger(volumePercent) || volumePercent < 0 || volumePercent > 100) {
    throw new TypeError("Audio volume must be an integer from 0 to 100 percent.");
  }
  return { ...track, volumePercent };
}

function framesToSeconds(value: number) {
  return value / PROJECT_AUDIO_SAMPLE_RATE_HZ;
}

export function projectAudioTimelineTimingAtDelta(
  track: Readonly<
    Pick<
      ProjectAudioTrack,
      "sourceSampleFrames" | "timelineOffsetSampleFrames" | "trimEndSampleFrames" | "trimStartSampleFrames"
    >
  >,
  sceneDuration: number,
  deltaSeconds: number,
  gesture: ProjectAudioTimelineGesture,
): ProjectAudioTimingSeconds | null {
  const sourceEnd = track.trimEndSampleFrames ?? track.sourceSampleFrames;
  const sceneFrames = Math.round(sceneDuration * PROJECT_AUDIO_SAMPLE_RATE_HZ);
  const deltaFrames = Math.round(deltaSeconds * PROJECT_AUDIO_SAMPLE_RATE_HZ);
  if (
    sourceEnd === null ||
    !Number.isSafeInteger(sourceEnd) ||
    !Number.isSafeInteger(sceneFrames) ||
    sceneFrames < 1 ||
    !Number.isSafeInteger(deltaFrames) ||
    !Number.isSafeInteger(track.timelineOffsetSampleFrames) ||
    !Number.isSafeInteger(track.trimStartSampleFrames) ||
    track.timelineOffsetSampleFrames < 0 ||
    track.trimStartSampleFrames < 0 ||
    sourceEnd <= track.trimStartSampleFrames ||
    (track.sourceSampleFrames !== null && sourceEnd > track.sourceSampleFrames)
  )
    return null;

  const originalTiming: ProjectAudioTimingSeconds = {
    offset: framesToSeconds(track.timelineOffsetSampleFrames),
    trimEnd: track.trimEndSampleFrames === null ? null : framesToSeconds(track.trimEndSampleFrames),
    trimStart: framesToSeconds(track.trimStartSampleFrames),
  };
  if (deltaFrames === 0) return originalTiming;

  let offset = track.timelineOffsetSampleFrames;
  let trimStart = track.trimStartSampleFrames;
  let trimEnd = sourceEnd;
  if (gesture === "body") {
    offset = Math.min(sceneFrames - 1, Math.max(0, offset + deltaFrames));
  } else if (gesture === "left") {
    const minimumDelta = Math.max(-offset, -trimStart);
    const maximumDelta = Math.min(sourceEnd - trimStart - 1, sceneFrames - offset - 1);
    if (maximumDelta < minimumDelta) return originalTiming;
    const appliedDelta = Math.min(maximumDelta, Math.max(minimumDelta, deltaFrames));
    offset += appliedDelta;
    trimStart += appliedDelta;
  } else {
    if (offset >= sceneFrames) return originalTiming;
    const visibleTimelineEnd = Math.min(sceneFrames, offset + sourceEnd - trimStart);
    const maximumTimelineEnd = Math.min(sceneFrames, offset + (track.sourceSampleFrames ?? sourceEnd) - trimStart);
    if (maximumTimelineEnd <= offset) return originalTiming;
    const timelineEnd = Math.min(maximumTimelineEnd, Math.max(offset + 1, visibleTimelineEnd + deltaFrames));
    if (timelineEnd === visibleTimelineEnd) return originalTiming;
    trimEnd = trimStart + timelineEnd - offset;
  }

  return {
    offset: framesToSeconds(offset),
    trimEnd: track.trimEndSampleFrames === null && trimEnd === sourceEnd ? null : framesToSeconds(trimEnd),
    trimStart: framesToSeconds(trimStart),
  };
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
    volumePercent: DEFAULT_PROJECT_AUDIO_VOLUME_PERCENT,
    wavBytes,
  };
}

export function cloneProjectAudioTrack(track: ProjectAudioTrack): ProjectAudioTrack {
  return { ...track, wavBytes: track.wavBytes.slice(0) };
}
