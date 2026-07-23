import type { Interval } from "./model";

export type StudioTimelineAnchor = Readonly<{
  sourceTime: number;
  workingTime: number;
}>;

export type TimelineLaneBounds = Readonly<{
  left: number;
  width: number;
}>;

export function formatTimelineTime(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = (value % 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${seconds}`;
}

export function timelinePositionPercent(time: number, duration: number) {
  return (time / duration) * 100;
}

export function timelineIntervalStyle(interval: Interval, duration: number) {
  return {
    left: `${timelinePositionPercent(interval.start, duration)}%`,
    width: `${Math.max(0.25, timelinePositionPercent(interval.end - interval.start, duration))}%`,
  };
}

export function timelineTimeAtClientX(
  clientX: number,
  bounds: TimelineLaneBounds,
  duration: number,
) {
  if (!bounds.width) return 0;
  return Math.min(duration, Math.max(0, (
    (clientX - bounds.left) / bounds.width
  ) * duration));
}

export function lifetimeTrimAnchors(
  anchors: readonly StudioTimelineAnchor[],
  interval: Interval,
) {
  return anchors.filter((anchor) => (
    anchor.workingTime - interval.start >= 0.1
    && interval.end - anchor.workingTime >= 0.01
  ));
}

export function closestLifetimeAnchor(
  anchors: readonly StudioTimelineAnchor[],
  desiredEnd: number,
) {
  return anchors.reduce<StudioTimelineAnchor | null>((closest, anchor) => (
    !closest
    || Math.abs(anchor.workingTime - desiredEnd) < Math.abs(closest.workingTime - desiredEnd)
      ? anchor
      : closest
  ), null);
}
