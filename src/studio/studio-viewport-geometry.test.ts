import { describe, expect, it, vi } from "vitest";

import {
  clientDeltaToViewport,
  clientPointToViewport,
  isCanvasInteractionTarget,
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
});

describe("canvas hit testing", () => {
  it("recognizes entity and handle descendants without depending on React", () => {
    const closest = vi.fn().mockReturnValue({});

    expect(isCanvasInteractionTarget({ closest })).toBe(true);
    expect(closest).toHaveBeenCalledWith(
      "[data-studio-entity], [data-motion-control], [data-studio-resize-handle]",
    );
    expect(isCanvasInteractionTarget(null)).toBe(false);
    expect(isCanvasInteractionTarget({ closest: () => null })).toBe(false);
  });
});
