import { describe, expect, it } from "vitest";
import { studioCubicBezierSpecSchema } from "./cubic-bezier-authoring";

const singleSegment = {
  arrowEnd: false,
  control1: { x: -1, y: 1 },
  control2: { x: 1, y: -1 },
  end: { x: 2, y: 0 },
  start: { x: -2, y: 0 },
  strokeCap: "round" as const,
  strokeWidth: 0.04,
};

describe("Studio cubic Bézier authoring contract", () => {
  it("keeps legacy single-segment specs valid", () => {
    expect(studioCubicBezierSpecSchema.parse(singleSegment)).toEqual(singleSegment);
  });

  it("accepts at most seven ordered continuation segments", () => {
    const segment = {
      control1: { x: 2.5, y: 1 },
      control2: { x: 3.5, y: 1 },
      end: { x: 4, y: 0 },
    };

    expect(
      studioCubicBezierSpecSchema.safeParse({
        ...singleSegment,
        continuationSegments: Array.from({ length: 7 }, () => segment),
      }).success,
    ).toBe(true);
    expect(
      studioCubicBezierSpecSchema.safeParse({
        ...singleSegment,
        continuationSegments: Array.from({ length: 8 }, () => segment),
      }).success,
    ).toBe(false);
  });

  it("accepts canonical fill only for a closed path without an arrow end", () => {
    expect(
      studioCubicBezierSpecSchema.safeParse({
        ...singleSegment,
        closed: true,
        fillColor: "#38bdf8",
      }).success,
    ).toBe(true);
    expect(studioCubicBezierSpecSchema.safeParse({ ...singleSegment, fillColor: "#38bdf8" }).success).toBe(false);
    expect(
      studioCubicBezierSpecSchema.safeParse({
        ...singleSegment,
        closed: true,
        fillColor: "#38BDF8",
      }).success,
    ).toBe(false);
    expect(
      studioCubicBezierSpecSchema.safeParse({
        ...singleSegment,
        arrowEnd: true,
        closed: true,
      }).success,
    ).toBe(false);
  });
});
