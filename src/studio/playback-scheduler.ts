export const STUDIO_PLAYBACK_MAX_UPDATES_PER_SECOND = 60;

const PLAYBACK_UPDATE_INTERVAL_MS = 1_000 / STUDIO_PLAYBACK_MAX_UPDATES_PER_SECOND;

export type StudioPlaybackUpdatePlan = Readonly<{
  nextUpdateAtMs: number;
  publish: boolean;
}>;

/**
 * Limits playback observers to 60 updates per second while dropping
 * missed intermediate deadlines instead of queuing catch-up work.
 */
export function planStudioPlaybackUpdate(nextUpdateAtMs: number, nowMs: number): StudioPlaybackUpdatePlan {
  if (nowMs < nextUpdateAtMs) return { nextUpdateAtMs, publish: false };
  const elapsedIntervals = Math.floor((nowMs - nextUpdateAtMs) / PLAYBACK_UPDATE_INTERVAL_MS) + 1;
  return {
    nextUpdateAtMs: nextUpdateAtMs + elapsedIntervals * PLAYBACK_UPDATE_INTERVAL_MS,
    publish: true,
  };
}

/** Computes the playhead from elapsed wall time so dropped UI frames never slow playback. */
export function studioPlaybackSampleTime(startedAtMs: number, startedTime: number, nowMs: number, duration: number) {
  return Math.min(duration, startedTime + Math.max(0, nowMs - startedAtMs) / 1_000);
}
