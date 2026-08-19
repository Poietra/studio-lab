import { describe, expect, it } from "vitest";

import {
  createSelectionResizeGesture,
  resizeSelectionAtPoint,
  selectionResizeCommandTargets,
} from "./selection-resize-gesture";

describe("selection resize gesture", () => {
  it("keeps prepared centers, preview deltas, and command positions in Studio viewport units", () => {
    const gesture = createSelectionResizeGesture({
      basis: {
        bounds: { bottom: 260, left: 120, right: 520, top: 100 },
        entities: [
          { center: { x: 200, y: 180 }, entityId: "left" },
          { center: { x: 440, y: 180 }, entityId: "right" },
        ],
      },
      cameraScale: 2,
      direction: "se",
      maximumScale: 10,
      minimumScale: 0.1,
      pointerId: 4,
      sourceAnchor: 1,
      start: { x: 520, y: 260 },
      surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      targets: [
        { entityId: "left", fromPosition: { x: 190, y: 170 }, fromScale: 1 },
        { entityId: "right", fromPosition: { x: 430, y: 170 }, fromScale: 2 },
      ],
    });
    expect(gesture).not.toBeNull();
    if (!gesture) return;

    const { factor, preview } = resizeSelectionAtPoint(gesture, { x: 920, y: 420 });

    expect(factor).toBe(2);
    expect(preview.entities).toEqual([
      { delta: { x: 40, y: 40 }, entityId: "left", scale: 2 },
      { delta: { x: 160, y: 40 }, entityId: "right", scale: 4 },
    ]);
    expect(selectionResizeCommandTargets(gesture, preview)).toEqual([
      { entityId: "left", fromScale: 1, toPosition: { x: 230, y: 210 }, toScale: 2 },
      { entityId: "right", fromScale: 2, toPosition: { x: 590, y: 210 }, toScale: 4 },
    ]);
  });

  it("does not create a gesture when a selected entity lacks prepared Rust geometry", () => {
    expect(
      createSelectionResizeGesture({
        basis: {
          bounds: { bottom: 260, left: 120, right: 520, top: 100 },
          entities: [{ center: { x: 200, y: 180 }, entityId: "left" }],
        },
        cameraScale: 1,
        direction: "se",
        maximumScale: 10,
        minimumScale: 0.1,
        pointerId: 4,
        sourceAnchor: 1,
        start: { x: 520, y: 260 },
        surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
        targets: [
          { entityId: "left", fromPosition: { x: 200, y: 180 }, fromScale: 1 },
          { entityId: "missing", fromPosition: { x: 440, y: 180 }, fromScale: 1 },
        ],
      }),
    ).toBeNull();
  });

  it("refuses to commit a partial preview for a multi-object gesture", () => {
    const gesture = createSelectionResizeGesture({
      basis: {
        bounds: { bottom: 260, left: 120, right: 520, top: 100 },
        entities: [
          { center: { x: 200, y: 180 }, entityId: "left" },
          { center: { x: 440, y: 180 }, entityId: "right" },
        ],
      },
      cameraScale: 1,
      direction: "se",
      maximumScale: 10,
      minimumScale: 0.1,
      pointerId: 4,
      sourceAnchor: 1,
      start: { x: 520, y: 260 },
      surfaceBounds: { height: 360, left: 0, top: 0, width: 640 },
      targets: [
        { entityId: "left", fromPosition: { x: 200, y: 180 }, fromScale: 1 },
        { entityId: "right", fromPosition: { x: 440, y: 180 }, fromScale: 1 },
      ],
    });
    expect(gesture).not.toBeNull();
    if (!gesture) return;

    expect(() =>
      selectionResizeCommandTargets(gesture, {
        entities: [{ delta: { x: -40, y: 0 }, entityId: "left", scale: 2 }],
      }),
    ).toThrow("must cover every selected object exactly once");
  });
});
