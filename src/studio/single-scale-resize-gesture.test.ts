import { describe, expect, it } from "vitest";

import type { PreparedMoveSnapBasis } from "./frame-alignment-snap";
import { createSingleScaleResizeGesture, resolveSingleScaleResize } from "./single-scale-resize-gesture";

const FRAME = { bottom: 360, left: 0, right: 640, top: 0 } as const;
const BASIS = {
  bounds: { bottom: 230, left: 270, right: 370, top: 130 },
  entityIds: ["entity:text"],
} as const;

function gesture(surfaceBounds = { height: 360, left: 0, top: 0, width: 640 }, basis: PreparedMoveSnapBasis = BASIS) {
  return createSingleScaleResizeGesture({
    basis,
    entityId: "entity:text",
    frame: FRAME,
    fromScale: 1,
    maximumScale: 10,
    minimumScale: 0.1,
    startClient: {
      x: surfaceBounds.left + (370 / 640) * surfaceBounds.width,
      y: surfaceBounds.top + (230 / 360) * surfaceBounds.height,
    },
    surfaceBounds,
  });
}

describe("single prepared-bounds scale resize", () => {
  it("uses the prepared AABB center and is stable across CSS canvas sizes", () => {
    const fullSize = gesture();
    const halfSize = gesture({ height: 180, left: 50, top: 20, width: 320 });
    expect(fullSize?.center).toEqual({ x: 320, y: 180 });
    expect(halfSize?.center).toEqual({ x: 320, y: 180 });
    if (!fullSize || !halfSize) throw new Error("Expected valid gestures.");

    expect(resolveSingleScaleResize(fullSize, { x: 420, y: 280 }, true).factor).toBeCloseTo(2);
    expect(resolveSingleScaleResize(halfSize, { x: 260, y: 160 }, true).factor).toBeCloseTo(2);
  });

  it("snaps the scaled prepared edge to the frame and uses the same factor for scale", () => {
    const resize = gesture();
    if (!resize) throw new Error("Expected a valid gesture.");

    const result = resolveSingleScaleResize(resize, { x: 635, y: 495 });
    expect(result).toEqual({ factor: 6.4, guides: ["frame-left", "frame-right"], scale: 6.4 });
  });

  it("snaps to another prepared object and lets Alt or Option bypass it", () => {
    const resize = gesture(undefined, {
      ...BASIS,
      objects: [{ bounds: { bottom: 250, left: 470, right: 520, top: 110 }, entityId: "entity:image" }],
    });
    if (!resize) throw new Error("Expected a valid gesture.");

    const snapped = resolveSingleScaleResize(resize, { x: 466, y: 326 });
    expect(snapped.factor).toBe(3);
    expect(snapped.guides).toEqual([{ axis: "x", entityId: "entity:image", kind: "object", position: 470 }]);
    const bypassed = resolveSingleScaleResize(resize, { x: 466, y: 326 }, true);
    expect(bypassed.factor).toBeCloseTo(2.92);
    expect(bypassed.guides).toEqual([]);
  });

  it("keeps a click-only gesture as a no-op even beside a guide", () => {
    const resize = gesture(undefined, {
      bounds: { bottom: 230, left: 535, right: 635, top: 130 },
      entityIds: ["entity:text"],
    });
    if (!resize) throw new Error("Expected a valid gesture.");

    expect(resolveSingleScaleResize(resize, { x: 370, y: 230 })).toEqual({ factor: 1, guides: [], scale: 1 });
  });

  it("returns the same snapped scale for pointer preview and pointer up", () => {
    const resize = gesture();
    if (!resize) throw new Error("Expected a valid gesture.");
    const pointer = { x: 635, y: 495 };

    expect(resolveSingleScaleResize(resize, pointer)).toEqual(resolveSingleScaleResize(resize, pointer));
  });

  it("rejects missing or mismatched prepared bounds", () => {
    expect(
      createSingleScaleResizeGesture({
        basis: { ...BASIS, entityIds: ["entity:other"] },
        entityId: "entity:text",
        frame: FRAME,
        fromScale: 1,
        maximumScale: 10,
        minimumScale: 0.1,
        startClient: { x: 370, y: 230 },
        surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      }),
    ).toBeNull();
  });
});
