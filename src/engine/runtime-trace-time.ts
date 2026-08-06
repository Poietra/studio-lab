export const RUNTIME_TRACE_FRAME_RATE_V1 = 60 as const;
export const RUNTIME_TRACE_DURATION_SECONDS_V1 = 6 as const;
export const RUNTIME_TRACE_FRAME_COUNT_V1 = RUNTIME_TRACE_FRAME_RATE_V1 * RUNTIME_TRACE_DURATION_SECONDS_V1;

function runtimeTraceFrameCountAtDurationV2(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const scaled = duration * RUNTIME_TRACE_FRAME_RATE_V1;
  const nearestFrame = Math.round(scaled);
  const gridTolerance = 4 * Number.EPSILON * Math.max(1, Math.abs(scaled));
  return Number.isSafeInteger(nearestFrame) && nearestFrame >= 1 && Math.abs(scaled - nearestFrame) <= gridTolerance
    ? nearestFrame
    : null;
}

export function runtimeTraceDurationIsOnFrameGridV2(duration: number) {
  return runtimeTraceFrameCountAtDurationV2(duration) !== null;
}

function runtimeTraceFrameIndexAtTime(time: number, duration: number, frameCount: number) {
  if (!Number.isFinite(time) || time < 0 || time > duration) {
    throw new RangeError("Runtime Trace sample time must be finite and inside the Scene duration.");
  }
  const scaled = time * RUNTIME_TRACE_FRAME_RATE_V1;
  const nearestFrame = Math.round(scaled);
  const gridTolerance = 4 * Number.EPSILON * Math.max(1, Math.abs(scaled));
  const frame = Math.abs(scaled - nearestFrame) <= gridTolerance ? nearestFrame : Math.floor(scaled);
  return Math.min(frameCount - 1, frame);
}

/**
 * Selects the captured presentation frame. Values within four scaled-f64
 * epsilons of an integer admit both `n / 60` and `n * (1 / 60)` as the same
 * canonical grid time; ordinary between-frame seeks retain floor semantics.
 */
export function runtimeTraceFrameIndexAtTimeV1(time: number) {
  if (!Number.isFinite(time) || time < 0 || time > RUNTIME_TRACE_DURATION_SECONDS_V1) {
    throw new RangeError("Runtime Trace sample time must be finite and inside the six-second Scene.");
  }
  return runtimeTraceFrameIndexAtTime(time, RUNTIME_TRACE_DURATION_SECONDS_V1, RUNTIME_TRACE_FRAME_COUNT_V1);
}

export function runtimeTraceFrameSampleTimeV1(time: number) {
  return runtimeTraceFrameIndexAtTimeV1(time) / RUNTIME_TRACE_FRAME_RATE_V1;
}

/** Selects a frame from a Runtime Trace V2 clip whose duration is sealed on the 60 fps grid. */
export function runtimeTraceFrameIndexAtTimeV2(time: number, duration: number) {
  const frameCount = runtimeTraceFrameCountAtDurationV2(duration);
  if (frameCount === null) {
    throw new RangeError("Runtime Trace V2 duration must contain a positive, JavaScript-safe whole number of frames.");
  }
  return runtimeTraceFrameIndexAtTime(time, duration, frameCount);
}

export function runtimeTraceFrameSampleTimeV2(time: number, duration: number) {
  return runtimeTraceFrameIndexAtTimeV2(time, duration) / RUNTIME_TRACE_FRAME_RATE_V1;
}
