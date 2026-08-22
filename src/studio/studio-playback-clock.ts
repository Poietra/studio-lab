import { planStudioPlaybackUpdate, studioPlaybackSampleTime } from "./playback-scheduler";

export type StudioPlaybackClockSnapshot = Readonly<{
  currentTime: number;
  duration: number;
  playing: boolean;
  sceneKey: string;
}>;

export type StudioPlaybackClockPlayInput = Readonly<{
  currentTime: number;
  duration: number;
  onEnded: () => void;
  sceneKey: string;
}>;

export type StudioPlaybackClockResetInput = Readonly<{
  currentTime: number;
  duration: number;
  sceneKey: string;
}>;

export type StudioPlaybackClockPauseResult = Readonly<{
  snapshot: StudioPlaybackClockSnapshot;
  wasPlaying: boolean;
}>;

export type StudioPlaybackClockOptions = Readonly<{
  cancelFrame?: (handle: number) => void;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
}>;

export type StudioPlaybackClock = Readonly<{
  dispose: () => void;
  getSnapshot: () => StudioPlaybackClockSnapshot;
  pause: () => StudioPlaybackClockPauseResult;
  play: (input: StudioPlaybackClockPlayInput) => StudioPlaybackClockSnapshot;
  reset: (input: StudioPlaybackClockResetInput) => StudioPlaybackClockSnapshot;
  subscribe: (listener: () => void) => () => void;
}>;

const INITIAL_SNAPSHOT: StudioPlaybackClockSnapshot = {
  currentTime: 0,
  duration: 0,
  playing: false,
  sceneKey: "",
};

function normalizedDuration(duration: number) {
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

function normalizedTime(currentTime: number, duration: number) {
  if (!Number.isFinite(currentTime)) return 0;
  return Math.min(duration, Math.max(0, currentTime));
}

function sameSnapshot(left: StudioPlaybackClockSnapshot, right: StudioPlaybackClockSnapshot) {
  return (
    left.currentTime === right.currentTime &&
    left.duration === right.duration &&
    left.playing === right.playing &&
    left.sceneKey === right.sceneKey
  );
}

/**
 * A small wall-clock-based playback source for the presentation layer.
 *
 * The clock owns the high-frequency rAF loop; React only observes the capped
 * snapshots through useSyncExternalStore. A scene change or reset invalidates
 * every pending callback, including callbacks an environment invokes after
 * cancellation.
 */
export function createStudioPlaybackClock({
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  now = () => globalThis.performance.now(),
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
}: StudioPlaybackClockOptions = {}): StudioPlaybackClock {
  let snapshot = INITIAL_SNAPSHOT;
  let startedAtMs = 0;
  let startedTime = 0;
  let nextUpdateAtMs = 0;
  let onEnded: (() => void) | null = null;
  let frameHandle: number | null = null;
  let generation = 0;
  let frameGeneration = 0;
  let disposed = false;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) listener();
  }

  function install(next: StudioPlaybackClockSnapshot) {
    if (sameSnapshot(snapshot, next)) return false;
    snapshot = next;
    notify();
    return true;
  }

  function cancelScheduledFrame() {
    frameGeneration += 1;
    if (frameHandle !== null) cancelFrame(frameHandle);
    frameHandle = null;
  }

  function finish(runGeneration: number) {
    if (runGeneration !== generation || !snapshot.playing) return;
    cancelScheduledFrame();
    install({ ...snapshot, currentTime: snapshot.duration, playing: false });
    const handler = onEnded;
    onEnded = null;
    handler?.();
  }

  function scheduleFrame(runGeneration: number) {
    const scheduledGeneration = ++frameGeneration;
    const handle = requestFrame(() => {
      if (disposed || runGeneration !== generation || scheduledGeneration !== frameGeneration) return;
      frameHandle = null;
      tick(runGeneration);
    });
    if (!disposed && runGeneration === generation && scheduledGeneration === frameGeneration) frameHandle = handle;
  }

  function tick(runGeneration: number) {
    if (disposed || runGeneration !== generation || !snapshot.playing) return;

    const nowMs = now();
    const currentTime = studioPlaybackSampleTime(startedAtMs, startedTime, nowMs, snapshot.duration);
    if (currentTime >= snapshot.duration) {
      install({ ...snapshot, currentTime: snapshot.duration });
      finish(runGeneration);
      return;
    }

    const plan = planStudioPlaybackUpdate(nextUpdateAtMs, nowMs);
    nextUpdateAtMs = plan.nextUpdateAtMs;
    if (plan.publish) install({ ...snapshot, currentTime });
    scheduleFrame(runGeneration);
  }

  function stopAndInvalidate() {
    generation += 1;
    cancelScheduledFrame();
    onEnded = null;
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stopAndInvalidate();
      listeners.clear();
    },
    getSnapshot() {
      return snapshot;
    },
    pause() {
      const wasPlaying = snapshot.playing;
      if (!wasPlaying) return { snapshot, wasPlaying };

      const currentTime = studioPlaybackSampleTime(startedAtMs, startedTime, now(), snapshot.duration);
      if (currentTime >= snapshot.duration) {
        install({ ...snapshot, currentTime: snapshot.duration });
        finish(generation);
        return { snapshot, wasPlaying };
      }

      stopAndInvalidate();
      install({ ...snapshot, currentTime, playing: false });
      return { snapshot, wasPlaying };
    },
    play({ currentTime, duration: requestedDuration, onEnded: nextOnEnded, sceneKey }) {
      if (disposed) return snapshot;

      const duration = normalizedDuration(requestedDuration);
      if (snapshot.playing && snapshot.sceneKey === sceneKey && snapshot.duration === duration) {
        onEnded = nextOnEnded;
        return snapshot;
      }

      stopAndInvalidate();
      const time = normalizedTime(currentTime, duration);
      startedAtMs = now();
      startedTime = time;
      nextUpdateAtMs = startedAtMs + 1_000 / 60;
      onEnded = nextOnEnded;
      const runGeneration = generation;
      install({ currentTime: time, duration, playing: true, sceneKey });
      scheduleFrame(runGeneration);
      return snapshot;
    },
    reset({ currentTime, duration: requestedDuration, sceneKey }) {
      if (disposed) return snapshot;
      stopAndInvalidate();
      const duration = normalizedDuration(requestedDuration);
      install({
        currentTime: normalizedTime(currentTime, duration),
        duration,
        playing: false,
        sceneKey,
      });
      return snapshot;
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
