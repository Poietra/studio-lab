import { describe, expect, it } from "vitest";

import {
  hasShapeDimensions,
  inverseResizeHandleScale,
  resizeHandleUsesDelta,
  resizeShapeByViewportDelta,
  sameShapeGeometry,
} from "./shape-resize";

const frame = { height: 8, width: 16 };
const viewport = { height: 400, width: 800 };

describe("shape-aware resize geometry", () => {
  it("keeps resize handles screen-sized across entity and camera zoom", () => {
    expect(inverseResizeHandleScale(2, 0.5)).toBe(1);
    expect(inverseResizeHandleScale(2, 2)).toBe(0.25);
  });

  it("ignores perpendicular edge-key movement and detects no-op geometry", () => {
    expect(resizeHandleUsesDelta("e", { x: 0, y: -2 })).toBe(false);
    expect(resizeHandleUsesDelta("e", { x: 2, y: 0 })).toBe(true);
    expect(sameShapeGeometry(
      { dimensions: { height: 2, width: 4 }, position: { x: 400, y: 200 } },
      { dimensions: { height: 2, width: 4 }, position: { x: 400, y: 200 } },
    )).toBe(true);
  });

  it("rejects incomplete and non-finite shape dimensions", () => {
    expect(hasShapeDimensions("circle", { radius: Number.POSITIVE_INFINITY })).toBe(false);
    expect(hasShapeDimensions("circle", { radius: Number.NaN })).toBe(false);
    expect(hasShapeDimensions("rectangle", { height: 2 })).toBe(false);
    expect(hasShapeDimensions("rectangle", { height: 2, width: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("moves only Rectangle's right edge while anchoring its left edge", () => {
    expect(resizeShapeByViewportDelta({
      cameraScale: 1,
      direction: "e",
      frame,
      from: { dimensions: { height: 2, width: 4 }, position: { x: 400, y: 200 } },
      scale: 1,
      shape: "rectangle",
      viewport,
      viewportDelta: { x: 100, y: 50 },
    })).toEqual({
      dimensions: { height: 2, width: 6 },
      position: { x: 450, y: 200 },
    });
  });

  it("changes Rectangle width and height independently from a corner", () => {
    expect(resizeShapeByViewportDelta({
      cameraScale: 1,
      direction: "nw",
      frame,
      from: { dimensions: { height: 2, width: 4 }, position: { x: 400, y: 200 } },
      scale: 2,
      shape: "rectangle",
      viewport,
      viewportDelta: { x: -100, y: -50 },
    })).toEqual({
      dimensions: { height: 2.5, width: 5 },
      position: { x: 350, y: 175 },
    });
  });

  it("keeps Circle aspect and its opposite corner anchored", () => {
    expect(resizeShapeByViewportDelta({
      cameraScale: 1,
      direction: "se",
      frame,
      from: { dimensions: { radius: 1 }, position: { x: 400, y: 200 } },
      scale: 1,
      shape: "circle",
      viewport,
      viewportDelta: { x: 100, y: 50 },
    })).toEqual({
      dimensions: { radius: 2 },
      position: { x: 450, y: 250 },
    });
  });

  it("clamps a crossed edge without moving the opposite edge", () => {
    expect(resizeShapeByViewportDelta({
      cameraScale: 1,
      direction: "w",
      frame,
      from: { dimensions: { height: 2, width: 1 }, position: { x: 400, y: 200 } },
      scale: 1,
      shape: "rectangle",
      viewport,
      viewportDelta: { x: 100, y: 0 },
    })).toEqual({
      dimensions: { height: 2, width: 0.1 },
      position: { x: 422.5, y: 200 },
    });
  });

  it("converts pointer movement through the active camera zoom", () => {
    expect(resizeShapeByViewportDelta({
      cameraScale: 2,
      direction: "e",
      frame,
      from: { dimensions: { height: 2, width: 4 }, position: { x: 400, y: 200 } },
      scale: 1,
      shape: "rectangle",
      viewport,
      viewportDelta: { x: 100, y: 0 },
    })).toEqual({
      dimensions: { height: 2, width: 5 },
      position: { x: 425, y: 200 },
    });
  });
});
