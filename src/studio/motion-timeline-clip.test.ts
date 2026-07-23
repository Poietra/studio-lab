import { describe, expect, it } from "vitest";

import {
  adjacentAppliedMotionClipAnchor,
  type AppliedMotionClip,
} from "./motion-timeline-clip";

const anchors = [3, 5, 7].map((sourceTime) => ({
  maximumDuration: 10 - sourceTime,
  sourceTime,
  workingTime: sourceTime,
}));

function clip(sourceStart: number): AppliedMotionClip {
  return {
    anchors,
    easing: "smooth",
    entityId: "equation",
    interval: { end: sourceStart + 1, start: sourceStart },
    label: "equation",
    maximumDuration: 10 - sourceStart,
    operationId: "motion",
    programIndex: 0,
    readOnlyReason: null,
    sourceStart,
    transactionId: "motion-program",
  };
}

describe("applied motion timeline anchor navigation", () => {
  it("chooses the immediate directional anchor when a clip starts between anchors", () => {
    const between = clip(6);

    expect(adjacentAppliedMotionClipAnchor(between, -1, 1, false)?.sourceTime).toBe(5);
    expect(adjacentAppliedMotionClipAnchor(between, 1, 1, false)?.sourceTime).toBe(7);
  });

  it("chooses neighbors around an exact anchor", () => {
    const exact = clip(5);

    expect(adjacentAppliedMotionClipAnchor(exact, -1, 1, false)?.sourceTime).toBe(3);
    expect(adjacentAppliedMotionClipAnchor(exact, 1, 1, false)?.sourceTime).toBe(7);
  });

  it("uses the same directional rule when moving the start handle", () => {
    const between = {
      ...clip(6),
      interval: { end: 8, start: 6 },
    };

    expect(adjacentAppliedMotionClipAnchor(between, -1, 2, true)?.sourceTime).toBe(5);
    expect(adjacentAppliedMotionClipAnchor(between, 1, 2, true)?.sourceTime).toBe(7);
  });
});
