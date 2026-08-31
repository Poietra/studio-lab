import { describe, expect, it } from "vitest";

import {
  applyCanvasBatchSelection,
  canvasDragTargetEntityIds,
  canvasMarqueeIntersects,
  canvasMarqueeRect,
  toggleCanvasEntitySelection,
} from "./canvas-selection";

describe("canvas selection", () => {
  it("normalizes marquee direction and intersects renderer hit bounds", () => {
    const marquee = canvasMarqueeRect({ x: 500, y: 280 }, { x: 100, y: 80 });

    expect(marquee).toEqual({ bottom: 280, left: 100, right: 500, top: 80 });
    expect(canvasMarqueeIntersects(marquee, { bottom: 180, left: 200, right: 240, top: 140 })).toBe(true);
    expect(canvasMarqueeIntersects(marquee, { bottom: 40, left: 200, right: 240, top: 10 })).toBe(false);
  });

  it("replaces or adds one marquee batch without duplicating IDs", () => {
    expect(applyCanvasBatchSelection(["circle"], ["rectangle"], "replace")).toEqual(["rectangle"]);
    expect(applyCanvasBatchSelection(["circle"], ["circle", "rectangle"], "add")).toEqual(["circle", "rectangle"]);
  });

  it("adds and removes an entity without changing the other selected entities", () => {
    expect(toggleCanvasEntitySelection(["circle"], "rectangle")).toEqual(["circle", "rectangle"]);
    expect(toggleCanvasEntitySelection(["circle", "rectangle"], "circle")).toEqual(["rectangle"]);
    expect(toggleCanvasEntitySelection(["circle"], "circle")).toEqual([]);
  });

  it("drags every selected entity when the pressed entity belongs to the selection", () => {
    const selection = ["circle", "rectangle"];

    expect(canvasDragTargetEntityIds(selection, "rectangle")).toBe(selection);
    expect(canvasDragTargetEntityIds(selection, "label")).toEqual(["label"]);
    expect(canvasDragTargetEntityIds(selection, "rectangle", true)).toEqual(["rectangle"]);
  });
});
