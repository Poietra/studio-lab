import { describe, expect, it } from "vitest";

import { createTextWrapResizeGesture, resolveTextWrapWidth } from "./text-wrap-resize-gesture";

function gesture(direction: "e" | "w" = "e") {
  return createTextWrapResizeGesture({
    cameraScale: 1,
    direction,
    entityScale: 1,
    frame: { height: 8, width: 16 },
    preparedBounds: { bottom: 225, left: 240, right: 400, top: 135 },
    startClientX: direction === "e" ? 400 : 240,
    surfaceWidth: 640,
    viewport: { height: 360, width: 640 },
  });
}

describe("Text wrap resize gesture", () => {
  it("changes the centered width symmetrically from either horizontal handle", () => {
    const east = gesture("e");
    const west = gesture("w");
    expect(east).not.toBeNull();
    expect(west).not.toBeNull();
    if (!east || !west) return;

    expect(east).toMatchObject({ fromHeight: 2, fromWidth: 4 });
    expect(resolveTextWrapWidth(east, 440)).toBe(6);
    expect(resolveTextWrapWidth(west, 200)).toBe(6);
    expect(resolveTextWrapWidth(east, 360)).toBe(2);
    expect(resolveTextWrapWidth(west, 280)).toBe(2);
  });

  it("does not commit a click, invalid pointer, or non-positive width", () => {
    const east = gesture();
    expect(east).not.toBeNull();
    if (!east) return;

    expect(resolveTextWrapWidth(east, 400)).toBeNull();
    expect(resolveTextWrapWidth(east, Number.NaN)).toBeNull();
    expect(resolveTextWrapWidth(east, 300)).toBeNull();
  });

  it("keeps an existing canonical wrap width when the longest rendered line is shorter", () => {
    const resize = createTextWrapResizeGesture({
      cameraScale: 1,
      configuredWidth: 8,
      direction: "e",
      entityScale: 1,
      frame: { height: 8, width: 16 },
      preparedBounds: { bottom: 225, left: 240, right: 400, top: 135 },
      startClientX: 400,
      surfaceWidth: 640,
      viewport: { height: 360, width: 640 },
    });
    expect(resize?.fromWidth).toBe(8);
    expect(resize && resolveTextWrapWidth(resize, 440)).toBe(10);
  });

  it("rejects incomplete prepared geometry instead of inventing a width", () => {
    expect(
      createTextWrapResizeGesture({
        cameraScale: 1,
        direction: "e",
        entityScale: 1,
        frame: { height: 8, width: 16 },
        preparedBounds: { bottom: 180, left: 320, right: 320, top: 180 },
        startClientX: 320,
        surfaceWidth: 640,
        viewport: { height: 360, width: 640 },
      }),
    ).toBeNull();
  });
});
