import { describe, expect, it } from "vitest";

import {
  changeStudioEditorZoom,
  type EntityDragPreview,
  entityDragDelta,
  entityPreviewScale,
  fitStudioCanvasSize,
} from "./studio-viewport";

describe("fitStudioCanvasSize", () => {
  it("fits a 16:9 Canvas within both viewport axes and the desktop maximum", () => {
    expect(fitStudioCanvasSize(1200, 800)).toEqual({ height: 576, width: 1024 });
    expect(fitStudioCanvasSize(800, 400)).toEqual({ height: 368, width: 654.2222222222222 });
    expect(fitStudioCanvasSize(20, 20)).toBeNull();
  });
});

describe("changeStudioEditorZoom", () => {
  it("steps between the editor-only 50% and 200% limits", () => {
    expect(changeStudioEditorZoom(1, 1)).toBe(1.25);
    expect(changeStudioEditorZoom(0.5, -1)).toBe(0.5);
    expect(changeStudioEditorZoom(2, 1)).toBe(2);
  });
});

describe("entityDragDelta", () => {
  it("previews the same delta for every entity in a multi-selection drag", () => {
    const preview: EntityDragPreview = {
      delta: { x: 12, y: -4 },
      entityIds: ["equation", "label"],
      guides: [],
    };

    expect(entityDragDelta(preview, "equation")).toEqual({ x: 12, y: -4 });
    expect(entityDragDelta(preview, "label")).toEqual({ x: 12, y: -4 });
    expect(entityDragDelta(preview, "other")).toEqual({ x: 0, y: 0 });
  });
});

describe("entityPreviewScale", () => {
  it("overrides only the entity being resized", () => {
    const preview = { entityId: "circle", guides: [], scale: 1.75 };

    expect(entityPreviewScale(preview, { id: "circle", scale: 1 })).toBe(1.75);
    expect(entityPreviewScale(preview, { id: "other", scale: 0.8 })).toBe(0.8);
    expect(entityPreviewScale(null, { id: "circle", scale: 1 })).toBe(1);
  });
});
