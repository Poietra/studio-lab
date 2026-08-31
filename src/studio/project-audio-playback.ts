import { useEffect, useState } from "react";

import { PROJECT_AUDIO_SAMPLE_RATE_HZ } from "./project-audio-track";
import type { StudioPlaybackClock, StudioPlaybackClockSnapshot } from "./studio-playback-clock";

type ProjectAudioPlaybackTrack = Readonly<{
  fadeInSampleFrames: number;
  fadeOutSampleFrames: number;
  sourceSampleFrames: number | null;
  timelineOffsetSampleFrames: number;
  trimEndSampleFrames: number | null;
  trimStartSampleFrames: number;
  volumePercent: number;
  wavBytes: ArrayBuffer;
}>;

type ProjectAudioElement = Pick<HTMLAudioElement, "currentTime" | "pause" | "paused" | "play" | "volume">;

const MAX_AUDIO_CLOCK_DRIFT_SECONDS = 0.12;

export function projectAudioSourceTime(track: ProjectAudioPlaybackTrack, sceneTime: number): number | null {
  const timelineOffset = track.timelineOffsetSampleFrames / PROJECT_AUDIO_SAMPLE_RATE_HZ;
  const elapsed = sceneTime - timelineOffset;
  if (elapsed < 0) return null;
  const sourceTime = track.trimStartSampleFrames / PROJECT_AUDIO_SAMPLE_RATE_HZ + elapsed;
  const endSampleFrames = track.trimEndSampleFrames ?? track.sourceSampleFrames;
  if (endSampleFrames !== null && sourceTime >= endSampleFrames / PROJECT_AUDIO_SAMPLE_RATE_HZ) return null;
  return sourceTime;
}

export function projectAudioGain(track: ProjectAudioPlaybackTrack, snapshot: StudioPlaybackClockSnapshot): number {
  const timelineSampleFrame = Math.floor(snapshot.currentTime * PROJECT_AUDIO_SAMPLE_RATE_HZ);
  const clipSampleFrame = timelineSampleFrame - track.timelineOffsetSampleFrames;
  const sceneSampleFrames = Math.round(snapshot.duration * PROJECT_AUDIO_SAMPLE_RATE_HZ);
  const sceneAvailableSampleFrames = Math.max(0, sceneSampleFrames - track.timelineOffsetSampleFrames);
  const sourceEndSampleFrames = track.trimEndSampleFrames ?? track.sourceSampleFrames;
  const sourceAvailableSampleFrames =
    sourceEndSampleFrames === null
      ? sceneAvailableSampleFrames
      : Math.max(0, sourceEndSampleFrames - track.trimStartSampleFrames);
  const contentSampleFrames = Math.min(sourceAvailableSampleFrames, sceneAvailableSampleFrames);
  if (clipSampleFrame < 0 || clipSampleFrame >= contentSampleFrames) return 0;

  const fadeInGain = track.fadeInSampleFrames === 0 ? 1 : Math.min(1, clipSampleFrame / track.fadeInSampleFrames);
  const fadeOutGain =
    track.fadeOutSampleFrames === 0
      ? 1
      : Math.min(1, (contentSampleFrames - 1 - clipSampleFrame) / track.fadeOutSampleFrames);
  return (track.volumePercent / 100) * Math.min(fadeInGain, fadeOutGain);
}

export function alignProjectAudioElement(
  element: ProjectAudioElement,
  snapshot: StudioPlaybackClockSnapshot,
  track: ProjectAudioPlaybackTrack,
) {
  const volume = projectAudioGain(track, snapshot);
  if (element.volume !== volume) element.volume = volume;
  const sourceTime = projectAudioSourceTime(track, snapshot.currentTime);
  if (sourceTime === null) {
    if (!element.paused) element.pause();
    return false;
  }
  if (!snapshot.playing) {
    if (!element.paused) element.pause();
    if (Math.abs(element.currentTime - sourceTime) > 0.001) element.currentTime = sourceTime;
    return false;
  }
  const allowedDrift = element.paused ? 0.001 : MAX_AUDIO_CLOCK_DRIFT_SECONDS;
  if (Math.abs(element.currentTime - sourceTime) > allowedDrift) {
    element.currentTime = sourceTime;
  }
  return element.paused;
}

/** Keeps project audio beside the external playback clock without involving React in the frame loop. */
export function useProjectAudioPlayback(track: ProjectAudioPlaybackTrack | null, clock: StudioPlaybackClock) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!track) return;

    const source = URL.createObjectURL(new Blob([track.wavBytes], { type: "audio/wav" }));
    const audio = new Audio(source);
    audio.preload = "auto";
    let disposed = false;
    let playAttempted = false;

    const synchronize = () => {
      const snapshot = clock.getSnapshot();
      let shouldPlay = false;
      try {
        shouldPlay = alignProjectAudioElement(audio, snapshot, track);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "The project audio could not seek.");
        return;
      }
      if (!shouldPlay) {
        playAttempted = false;
        return;
      }
      if (playAttempted) return;
      playAttempted = true;
      void audio.play().catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : "The project audio could not play.");
      });
    };

    const unsubscribe = clock.subscribe(synchronize);
    audio.addEventListener("loadedmetadata", synchronize);
    synchronize();
    return () => {
      disposed = true;
      unsubscribe();
      audio.removeEventListener("loadedmetadata", synchronize);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(source);
    };
  }, [clock, track]);

  return error;
}
