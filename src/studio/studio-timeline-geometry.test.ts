import { describe, expect, it } from "vitest";

import {
  closestLifetimeAnchor,
  lifetimeTrimAnchors,
  timelineIntervalStyle,
  timelineTimeAtClientX,
} from "./studio-timeline-geometry";

const anchors = [
  { sourceTime: 1, workingTime: 1.05 },
  { sourceTime: 2, workingTime: 2 },
  { sourceTime: 3, workingTime: 3.98 },
  { sourceTime: 4, workingTime: 4 },
] as const;

describe("timeline anchor projection", () => {
  it("keeps only anchors that leave valid content on both sides of a lifetime trim", () => {
    expect(lifetimeTrimAnchors(anchors, { start: 1, end: 4 })).toEqual([
      anchors[1],
      anchors[2],
    ]);
  });

  it("chooses the closest safe working-time anchor", () => {
    expect(closestLifetimeAnchor(anchors, 2.7)).toBe(anchors[1]);
    expect(closestLifetimeAnchor([], 2.7)).toBeNull();
  });
});

describe("timeline coordinate projection", () => {
  it("maps and clamps client x coordinates to timeline time", () => {
    const bounds = { left: 100, width: 400 };

    expect(timelineTimeAtClientX(300, bounds, 8)).toBe(4);
    expect(timelineTimeAtClientX(0, bounds, 8)).toBe(0);
    expect(timelineTimeAtClientX(600, bounds, 8)).toBe(8);
  });

  it("keeps very short intervals hit-testable", () => {
    expect(timelineIntervalStyle({ start: 2, end: 2.001 }, 10)).toEqual({
      left: "20%",
      width: "0.25%",
    });
  });
});
