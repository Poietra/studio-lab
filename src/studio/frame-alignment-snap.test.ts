import { describe, expect, it } from "vitest";

import { type FrameSnapBasis, snapViewportDragToFrame } from "./frame-alignment-snap";

const BASIS: FrameSnapBasis = {
  frame: { bottom: 360, left: 0, right: 640, top: 0 },
  selection: { bottom: 200, left: 100, right: 200, top: 100 },
};

describe("frame alignment snapping", () => {
  it("snaps the prepared selection center and returns the matching guide", () => {
    const result = snapViewportDragToFrame({
      basis: BASIS,
      cameraScale: 1,
      disabled: false,
      viewportDelta: { x: 165, y: 0 },
      viewportUnitsPerCssPixel: { x: 1, y: 1 },
    });

    expect(result).toEqual({ delta: { x: 170, y: 0 }, guides: ["frame-center-x"] });
    expect((BASIS.selection.left + BASIS.selection.right) / 2 + result.delta.x).toBe(320);
  });

  it("snaps independent selection edges on both axes", () => {
    const result = snapViewportDragToFrame({
      basis: BASIS,
      cameraScale: 1,
      disabled: false,
      viewportDelta: { x: -95, y: 155 },
      viewportUnitsPerCssPixel: { x: 1, y: 1 },
    });

    expect(result).toEqual({ delta: { x: -100, y: 160 }, guides: ["frame-left", "frame-bottom"] });
    expect(BASIS.selection.left + result.delta.x).toBe(BASIS.frame.left);
    expect(BASIS.selection.bottom + result.delta.y).toBe(BASIS.frame.bottom);
  });

  it("keeps the tolerance in CSS pixels while converting through camera zoom", () => {
    const result = snapViewportDragToFrame({
      basis: BASIS,
      cameraScale: 2,
      disabled: false,
      viewportDelta: { x: 83, y: 0 },
      viewportUnitsPerCssPixel: { x: 0.5, y: 0.5 },
    });

    // The prepared AABB moves 166 viewport units. Its remaining 4 viewport
    // units are exactly 8 CSS px on this large canvas, regardless of DPR.
    expect(result).toEqual({ delta: { x: 85, y: 0 }, guides: ["frame-center-x"] });
    expect(result.delta.x * 2 + 150).toBe(320);
  });

  it("lets Alt or Option bypass snapping without changing the move delta", () => {
    expect(
      snapViewportDragToFrame({
        basis: BASIS,
        cameraScale: 1,
        disabled: true,
        viewportDelta: { x: 165, y: 155 },
        viewportUnitsPerCssPixel: { x: 1, y: 1 },
      }),
    ).toEqual({ delta: { x: 165, y: 155 }, guides: [] });
  });

  it("does not pull a selection toward the frame outside the tolerance", () => {
    expect(
      snapViewportDragToFrame({
        basis: BASIS,
        cameraScale: 1,
        disabled: false,
        viewportDelta: { x: 160, y: 150 },
        viewportUnitsPerCssPixel: { x: 1, y: 1 },
      }),
    ).toEqual({ delta: { x: 160, y: 150 }, guides: [] });
  });

  it("snaps selection bounds to another object's edge and center lines", () => {
    const result = snapViewportDragToFrame({
      basis: {
        ...BASIS,
        objects: [{ bounds: { bottom: 300, left: 300, right: 400, top: 200 }, entityId: "rectangle" }],
      },
      cameraScale: 1,
      disabled: false,
      viewportDelta: { x: 95, y: 95 },
      viewportUnitsPerCssPixel: { x: 1, y: 1 },
    });

    expect(result).toEqual({
      delta: { x: 100, y: 100 },
      guides: [
        { axis: "x", entityId: "rectangle", kind: "object", position: 300 },
        { axis: "y", entityId: "rectangle", kind: "object", position: 200 },
      ],
    });
  });

  it("uses entity ID as a stable tie-break between equally close objects", () => {
    const result = snapViewportDragToFrame({
      basis: {
        ...BASIS,
        objects: [
          { bounds: { bottom: 300, left: 300, right: 300, top: 300 }, entityId: "z-target" },
          { bounds: { bottom: 300, left: 310, right: 310, top: 300 }, entityId: "a-target" },
        ],
      },
      cameraScale: 1,
      disabled: false,
      viewportDelta: { x: 105, y: 0 },
      viewportUnitsPerCssPixel: { x: 1, y: 1 },
    });

    expect(result.delta.x).toBe(110);
    expect(result.guides).toEqual([{ axis: "x", entityId: "a-target", kind: "object", position: 310 }]);
  });

  it("keeps frame snapping ahead of an object on an exact tie", () => {
    const result = snapViewportDragToFrame({
      basis: {
        ...BASIS,
        objects: [{ bounds: { bottom: 280, left: 320, right: 320, top: 80 }, entityId: "centered-object" }],
      },
      cameraScale: 1,
      disabled: false,
      viewportDelta: { x: 165, y: 0 },
      viewportUnitsPerCssPixel: { x: 1, y: 1 },
    });

    expect(result).toEqual({ delta: { x: 170, y: 0 }, guides: ["frame-center-x"] });
  });

  it("falls back to frame-only snapping when any object bounds are incomplete", () => {
    const result = snapViewportDragToFrame({
      basis: {
        ...BASIS,
        objects: [
          { bounds: { bottom: 300, left: 300, right: 400, top: 200 }, entityId: "valid" },
          { bounds: { bottom: 300, left: Number.NaN, right: 500, top: 200 }, entityId: "incomplete" },
        ],
      },
      cameraScale: 1,
      disabled: false,
      viewportDelta: { x: 95, y: 95 },
      viewportUnitsPerCssPixel: { x: 1, y: 1 },
    });

    expect(result).toEqual({ delta: { x: 95, y: 95 }, guides: [] });
  });

  it("keeps object snapping tolerance in CSS pixels through camera zoom", () => {
    const result = snapViewportDragToFrame({
      basis: {
        ...BASIS,
        objects: [{ bounds: { bottom: 340, left: 350, right: 450, top: 300 }, entityId: "zoom-target" }],
        selection: { ...BASIS.selection, right: 180 },
      },
      cameraScale: 2,
      disabled: false,
      viewportDelta: { x: 83, y: 0 },
      viewportUnitsPerCssPixel: { x: 0.5, y: 0.5 },
    });

    expect(result).toEqual({
      delta: { x: 85, y: 0 },
      guides: [{ axis: "x", entityId: "zoom-target", kind: "object", position: 350 }],
    });
  });
});
