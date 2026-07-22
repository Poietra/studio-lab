import { describe, expect, it } from "vitest";

import { entityDragDelta, type EntityDragPreview } from "./studio-viewport";

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
