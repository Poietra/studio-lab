import { describe, expect, it } from "vitest";

import { dataSeriesUnavailableReason, formatDataPlotCsv, parseDataPlotCsv } from "./data-plot";

const dimensions = {
  coordinateSystem: {
    x: { maximum: 2, minimum: -2, step: 1 },
    y: { maximum: 1, minimum: -1, step: 0.5 },
  },
  height: 4,
  width: 6,
} as const;

describe("data plot input", () => {
  it("parses and formats bounded x,y rows without deriving geometry", () => {
    const parsed = parseDataPlotCsv("-2,-1\n0,1\n2,0");

    expect(parsed).toEqual({
      kind: "valid",
      points: [
        { x: -2, y: -1 },
        { x: 0, y: 1 },
        { x: 2, y: 0 },
      ],
    });
    if (parsed.kind === "valid") expect(formatDataPlotCsv(parsed.points)).toBe("-2,-1\n0,1\n2,0");
  });

  it.each([
    ["requires two points", { interpolation: "linear" as const, points: [{ x: 0, y: 0 }] }, /2 to 256/u],
    [
      "requires strictly increasing x",
      {
        interpolation: "smooth" as const,
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
        ],
      },
      /strictly increasing/u,
    ],
    [
      "rejects points outside the Axes snapshot",
      {
        interpolation: "linear" as const,
        points: [
          { x: -2, y: 0 },
          { x: 3, y: 0 },
        ],
      },
      /inside the selected Axes range/u,
    ],
  ])("%s", (_label, dataSeries, message) => {
    expect(dataSeriesUnavailableReason(dataSeries, dimensions)).toMatch(message);
  });

  it("rejects malformed CSV rows clearly", () => {
    expect(parseDataPlotCsv("0,1\nnope")).toEqual({ kind: "invalid", message: "Row 2 must use the format x,y." });
  });
});
