import type { StudioPropertyKeyframeEasing } from "../engine/scene-authoring";

const KEYFRAME_TIME_EPSILON = 0.0005;

type PropertyKeyframe = Readonly<{
  easing: StudioPropertyKeyframeEasing;
  time: number;
  value: unknown;
}>;

export function duplicatePropertyKeyframeAtTime<T extends PropertyKeyframe>(
  keyframes: readonly T[],
  selectedIndex: number,
  time: number,
): readonly T[] {
  const selected = keyframes[selectedIndex];
  if (!selected) throw new RangeError("The selected keyframe no longer exists.");
  if (!Number.isFinite(time)) throw new RangeError("The playhead time must be finite.");
  if (keyframes.some((keyframe) => Math.abs(keyframe.time - time) <= KEYFRAME_TIME_EPSILON)) {
    throw new RangeError("A keyframe already exists at the playhead.");
  }
  return [...keyframes, { ...selected, time }].sort((left, right) => left.time - right.time);
}
