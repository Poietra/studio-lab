import { describe, expect, it } from "vitest";

import { shapeInsertionPlacement } from "./shape-insertion-gesture";

describe("shape insertion gesture", () => {
  const frame = { height: 8, width: 16 } as const;

  it("normalizes a reverse Rectangle drag through CSS-scaled client bounds", () => {
    expect(
      shapeInsertionPlacement({
        bounds: { height: 450, left: 100, top: 50, width: 800 },
        currentClientPoint: { x: 300, y: 125 },
        frame,
        startClientPoint: { x: 700, y: 350 },
        tool: "Rectangle",
      }),
    ).toEqual({
      dimensions: { height: 4, width: 8 },
      point: { x: 320, y: 150 },
    });
  });

  it("derives a Circle radius from the dominant dragged scene dimension", () => {
    expect(
      shapeInsertionPlacement({
        bounds: { height: 720, left: -200, top: -100, width: 1280 },
        currentClientPoint: { x: 440, y: 260 },
        frame,
        startClientPoint: { x: 120, y: 620 },
        tool: "Circle",
      }),
    ).toEqual({
      dimensions: { radius: 2 },
      point: { x: 240, y: 270 },
    });
  });

  it("keeps a near-click at its original point for default-size placement", () => {
    expect(
      shapeInsertionPlacement({
        bounds: { height: 360, left: 40, top: 20, width: 640 },
        currentClientPoint: { x: 202, y: 123 },
        frame,
        startClientPoint: { x: 200, y: 120 },
        tool: "Rectangle",
      }),
    ).toEqual({ point: { x: 160, y: 100 } });
  });
});
