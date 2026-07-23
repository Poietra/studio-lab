import { describe, expect, it } from "vitest";

import {
  entityDragDelta,
  entityPreviewScale,
  type EntityDragPreview,
} from "./studio-viewport";

describe("entityDragDelta", () => {
  it("previews the same delta for every entity in a multi-selection drag", () => {
    const preview: EntityDragPreview = {
      delta: { x: 12, y: -4 },
      entityIds: ["equation", "label"],
    };

    expect(entityDragDelta(preview, "equation")).toEqual({ x: 12, y: -4 });
    expect(entityDragDelta(preview, "label")).toEqual({ x: 12, y: -4 });
    expect(entityDragDelta(preview, "other")).toEqual({ x: 0, y: 0 });
  });
});

describe("entityPreviewScale", () => {
  it("overrides only the entity being resized", () => {
    const preview = { entityId: "circle", scale: 1.75 };

    expect(entityPreviewScale(preview, { id: "circle", scale: 1 })).toBe(1.75);
    expect(entityPreviewScale(preview, { id: "other", scale: 0.8 })).toBe(0.8);
    expect(entityPreviewScale(null, { id: "circle", scale: 1 })).toBe(1);
  });
});
