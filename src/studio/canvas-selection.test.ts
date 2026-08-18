import { describe, expect, it } from "vitest";

import { canvasDragTargetEntityIds, toggleCanvasEntitySelection } from "./canvas-selection";

describe("canvas selection", () => {
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
