import { useEffect, useState } from "react";

import type { StudioPlaybackClock, StudioPlaybackClockSnapshot } from "./studio-playback-clock";

type ProjectAudioPlaybackTrack = Readonly<{
  wavBytes: ArrayBuffer;
}>;

type ProjectAudioElement = Pick<HTMLAudioElement, "currentTime" | "pause" | "paused" | "play">;

const MAX_AUDIO_CLOCK_DRIFT_SECONDS = 0.12;

export function alignProjectAudioElement(element: ProjectAudioElement, snapshot: StudioPlaybackClockSnapshot) {
  if (!snapshot.playing) {
    if (!element.paused) element.pause();
    if (Math.abs(element.currentTime - snapshot.currentTime) > 0.001) element.currentTime = snapshot.currentTime;
    return false;
  }
  if (Math.abs(element.currentTime - snapshot.currentTime) > MAX_AUDIO_CLOCK_DRIFT_SECONDS) {
    element.currentTime = snapshot.currentTime;
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
        shouldPlay = alignProjectAudioElement(audio, snapshot);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "The project audio could not seek.");
        return;
      }
      if (!snapshot.playing) {
        playAttempted = false;
        return;
      }
      if (!shouldPlay || playAttempted) return;
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
