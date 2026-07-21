import type { CSSProperties } from "react";

import type { SuggestionTimeAnchor } from "../ai/edit-suggestions";
import {
  type EasingName,
  type EditPlan,
  type Interval,
  type MotionRecord,
  type ObjectId,
  type Point,
  FRAME,
  PLAY_SEGMENTS,
  SCENE_DURATION,
  SCENE_OBJECTS,
} from "./prototype-fixture";

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function formatTime(seconds: number) {
  return `00:${seconds.toFixed(2).padStart(5, "0")}`;
}

export function playAt(time: number) {
  return PLAY_SEGMENTS.find((segment) => time >= segment.start && time < segment.end) ?? PLAY_SEGMENTS.at(-1)!;
}

export function worldUnits(renderPixels: number) {
  return (renderPixels * (128 / 9)) / FRAME.width;
}

export function positionStyle(point: Point): CSSProperties {
  return {
    left: `${(point.x / FRAME.width) * 100}%`,
    top: `${(point.y / FRAME.height) * 100}%`,
  };
}

export function intervalStyle(interval: Interval): CSSProperties {
  return {
    left: `${(interval.start / SCENE_DURATION) * 100}%`,
    width: `${((interval.end - interval.start) / SCENE_DURATION) * 100}%`,
  };
}

export function addPoints(left: Point, right: Point): Point {
  return { x: left.x + right.x, y: left.y + right.y };
}

export function averagePoints(points: readonly Point[]): Point {
  if (points.length === 0) return { x: FRAME.width / 2, y: FRAME.height / 2 };
  const total = points.reduce(addPoints, { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

export function easingValue(easing: EasingName, progress: number) {
  if (easing === "smooth") {
    const inflection = 10;
    const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
    const error = sigmoid(-inflection / 2);
    return clamp(
      (sigmoid(inflection * (progress - 0.5)) - error) / (1 - 2 * error),
      0,
      1,
    );
  }
  return progress;
}

export function quadraticPoint(start: Point, control: Point, end: Point, progress: number): Point {
  const inverse = 1 - progress;
  return {
    x: inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x,
    y: inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y,
  };
}

export function sampleMotion(motion: MotionRecord, time: number, bend: Point): Point {
  const duration = motion.interval.end - motion.interval.start;
  const progress = clamp((time - motion.interval.start) / duration, 0, 1);
  return quadraticPoint(
    motion.start,
    addPoints(motion.control, bend),
    motion.end,
    easingValue(motion.easing, progress),
  );
}

export function intervalsOverlap(left: Interval, right: Interval) {
  return left.start < right.end && right.start < left.end;
}

export function resolveTimeAnchor(anchor: SuggestionTimeAnchor) {
  if (anchor.kind === "absolute") return anchor.seconds;
  if (anchor.kind === "playhead-offset") return anchor.referenceSeconds + anchor.offsetSeconds;
  return anchor.referenceSeconds;
}

export function timeAnchorLabel(anchor: SuggestionTimeAnchor) {
  if (anchor.kind === "absolute") return `absolute ${anchor.seconds.toFixed(2)}s`;
  if (anchor.kind === "playhead-offset") {
    return `${Math.abs(anchor.offsetSeconds).toFixed(2)}s before ${anchor.referenceSeconds.toFixed(2)}s playhead`;
  }
  return `captured playhead ${anchor.referenceSeconds.toFixed(2)}s`;
}

export function groupedOperationCount(records: readonly { groupId?: string }[]) {
  const groups = new Set<string>();
  let ungrouped = 0;
  for (const record of records) {
    if (record.groupId) groups.add(record.groupId);
    else ungrouped += 1;
  }
  return groups.size + ungrouped;
}

export function patchFor(plan: EditPlan, delta: Point, objectIds: readonly ObjectId[], motion?: Interval) {
  const object = objectIds.length === 1
    ? SCENE_OBJECTS.find((candidate) => candidate.id === objectIds[0])!
    : null;
  const horizontal = worldUnits(delta.x);
  const vertical = worldUnits(-delta.y);
  const terms = [
    Math.abs(horizontal) > 0.005 ? `${horizontal.toFixed(2)} * RIGHT` : null,
    Math.abs(vertical) > 0.005 ? `${vertical.toFixed(2)} * UP` : null,
  ].filter(Boolean);
  const vector = terms.length > 0 ? terms.join(" + ") : "ORIGIN";

  if (plan.id === "whole-followers" && object) {
    return {
      before: object.source,
      after: `${object.source}.shift(${vector})`,
      context: plan.followers
        ? "Later construction expressions are recomputed from the new position."
        : "The object is created at the new position.",
    };
  }
  const variables = plan.affected
    .map((id) => SCENE_OBJECTS.find((candidate) => candidate.id === id)!.variableName)
    .join(", ");
  if (plan.id === "play-followers") {
    return {
      before: "# exact playhead boundary",
      after: plan.followers
        ? `VGroup(${variables}).shift(${vector})`
        : object
          ? `${object.variableName}.shift(${vector})`
          : `VGroup(${variables}).shift(${vector})`,
      context: "The shift is inserted at the dragged frame and ends when each object leaves the scene.",
    };
  }
  if (plan.id === "new-move") {
    const target = plan.followers || !object ? `VGroup(${variables})` : object.variableName;
    const duration = motion ? motion.end - motion.start : 1;
    return {
      before: `# playhead ${motion?.start.toFixed(2) ?? "—"}s`,
      after: `self.play(${target}.animate.shift(${vector}), run_time=${duration.toFixed(2)}, rate_func=smooth)`,
      context: "This creates a timed Manim animation. The object is interpolated along the blue path instead of jumping to a new position.",
    };
  }
  if (!object) {
    return {
      before: plan.temporalScope === "whole" ? "# scene object construction" : "# exact playhead boundary",
      after: `VGroup(${variables}).shift(${vector})`,
      context: plan.temporalScope === "whole"
        ? "The selected objects are shifted together after construction."
        : "Only the selected objects move from this frame.",
    };
  }
  return {
    before: "# exact playhead boundary",
    after: `${object.variableName}.shift(${vector})`,
    context: "The connection geometry is intentionally left unchanged.",
  };
}
