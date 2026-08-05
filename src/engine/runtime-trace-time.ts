export const RUNTIME_TRACE_FRAME_RATE_V1 = 60 as const;
export const RUNTIME_TRACE_DURATION_SECONDS_V1 = 6 as const;
export const RUNTIME_TRACE_FRAME_COUNT_V1 = RUNTIME_TRACE_FRAME_RATE_V1 * RUNTIME_TRACE_DURATION_SECONDS_V1;

/**
 * Selects the captured presentation frame. Values within four scaled-f64
 * epsilons of an integer admit both `n / 60` and `n * (1 / 60)` as the same
 * canonical grid time; ordinary between-frame seeks retain floor semantics.
 */
export function runtimeTraceFrameIndexAtTimeV1(time: number) {
  if (!Number.isFinite(time) || time < 0 || time > RUNTIME_TRACE_DURATION_SECONDS_V1) {
    throw new RangeError("Runtime Trace sample time must be finite and inside the six-second Scene.");
  }
  const scaled = time * RUNTIME_TRACE_FRAME_RATE_V1;
  const nearestFrame = Math.round(scaled);
  const gridTolerance = 4 * Number.EPSILON * Math.max(1, Math.abs(scaled));
  const frame = Math.abs(scaled - nearestFrame) <= gridTolerance ? nearestFrame : Math.floor(scaled);
  return Math.min(RUNTIME_TRACE_FRAME_COUNT_V1 - 1, frame);
}

export function runtimeTraceFrameSampleTimeV1(time: number) {
  return runtimeTraceFrameIndexAtTimeV1(time) / RUNTIME_TRACE_FRAME_RATE_V1;
}
