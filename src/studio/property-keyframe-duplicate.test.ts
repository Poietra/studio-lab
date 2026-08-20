import { describe, expect, it } from "vitest";

import { duplicatePropertyKeyframeAtTime } from "./property-keyframe-duplicate";

describe("property keyframe duplication", () => {
  it("copies the selected marker value and easing at the playhead", () => {
    const result = duplicatePropertyKeyframeAtTime(
      [
        { easing: "linear" as const, time: 1, value: 1 },
        { easing: "smooth" as const, time: 4, value: 2.5 },
      ],
      1,
      2.5,
    );

    expect(result).toEqual([
      { easing: "linear", time: 1, value: 1 },
      { easing: "smooth", time: 2.5, value: 2.5 },
      { easing: "smooth", time: 4, value: 2.5 },
    ]);
  });

  it("rejects the same playhead time and non-finite time", () => {
    const keyframes = [{ easing: "smooth" as const, time: 2, value: 1 }];

    expect(() => duplicatePropertyKeyframeAtTime(keyframes, 0, 2.0004)).toThrow(
      "A keyframe already exists at the playhead.",
    );
    expect(() => duplicatePropertyKeyframeAtTime([{ easing: "smooth", time: 0, value: 1 }], 0, 0.0005)).toThrow(
      "A keyframe already exists at the playhead.",
    );
    expect(() => duplicatePropertyKeyframeAtTime(keyframes, 0, Number.NaN)).toThrow(
      "The playhead time must be finite.",
    );
  });

  it("rejects a stale marker selection", () => {
    expect(() => duplicatePropertyKeyframeAtTime([{ easing: "smooth", time: 2, value: 1 }], 1, 3)).toThrow(
      "The selected keyframe no longer exists.",
    );
  });
});
