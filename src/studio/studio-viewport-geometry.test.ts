import { describe, expect, it, vi } from "vitest";

import {
  clientDeltaToViewport,
  clientPointToViewport,
  isCanvasInteractionTarget,
  rotationDeltaFromClientPoints,
  viewportPositionStyle,
  viewportScaleForBounds,
} from "./studio-viewport-geometry";

describe("viewport coordinate projection", () => {
  it("maps client points and deltas into the 640 by 360 studio coordinate space", () => {
    const bounds = { height: 180, left: 10, top: 20, width: 320 };
    const scale = viewportScaleForBounds(bounds);

    expect(clientPointToViewport(bounds, { x: 170, y: 110 })).toEqual({ x: 320, y: 180 });
    expect(scale).toEqual({ x: 2, y: 2 });
    expect(clientDeltaToViewport({ x: 15, y: -6 }, scale)).toEqual({ x: 30, y: -12 });
  });

  it("expresses studio positions as percentage styles", () => {
    expect(viewportPositionStyle({ x: 160, y: 270 })).toEqual({
      left: "25%",
      top: "75%",
    });
  });

  it("converts clockwise client-space pointer motion into a negative Manim angle and supports snapping", () => {
    const center = { x: 100, y: 100 };
    const top = { x: 100, y: 50 };
    const right = { x: 150, y: 100 };

    expect(rotationDeltaFromClientPoints(center, top, right)).toBeCloseTo(-Math.PI / 2);
    expect(rotationDeltaFromClientPoints(center, top, { x: 125, y: 50 }, Math.PI / 12)).toBeCloseTo(-Math.PI / 6);
  });
});

describe("canvas hit testing", () => {
  it("recognizes entity and handle descendants without depending on React", () => {
    const closest = vi.fn().mockReturnValue({});

    expect(isCanvasInteractionTarget({ closest })).toBe(true);
    expect(closest).toHaveBeenCalledWith(
      "[data-studio-entity], [data-motion-control], [data-studio-resize-handle], [data-studio-selection-resize-handle], [data-studio-rotation-handle], [data-studio-inline-text-editor]",
    );
    expect(isCanvasInteractionTarget(null)).toBe(false);
    expect(isCanvasInteractionTarget({ closest: () => null })).toBe(false);
  });
});
