import { describe, expect, it } from "vitest";
import { openingManimCairoParityThresholdsV2 } from "./opening-manim-cairo-parity";
import {
  OPENING_MANIM_CAIRO_DENSE_GRID_PARITY_THRESHOLDS_V2,
  OPENING_MANIM_CAIRO_PARITY_THRESHOLDS_V2,
  OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2,
  OPENING_MANIM_CAIRO_WARPED_GRID_PARITY_THRESHOLDS_V2,
} from "./opening-manim-cairo-reference";

describe("OpeningManim Cairo parity gates", () => {
  it("keeps normal, dense-flat, and warped-grid samples in separate threshold classes", () => {
    expect(openingManimCairoParityThresholdsV2("grid-create-early")).toBe(OPENING_MANIM_CAIRO_PARITY_THRESHOLDS_V2);
    expect(openingManimCairoParityThresholdsV2("grid-create-midpoint")).toBe(
      OPENING_MANIM_CAIRO_DENSE_GRID_PARITY_THRESHOLDS_V2,
    );
    expect(openingManimCairoParityThresholdsV2("warp-start")).toBe(OPENING_MANIM_CAIRO_DENSE_GRID_PARITY_THRESHOLDS_V2);

    const ids = OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2.map(([id]) => id);
    const warpedGridIds = ids.slice(ids.indexOf("warp-early"));
    expect(warpedGridIds).toHaveLength(11);
    expect(
      warpedGridIds.every(
        (id) => openingManimCairoParityThresholdsV2(id) === OPENING_MANIM_CAIRO_WARPED_GRID_PARITY_THRESHOLDS_V2,
      ),
    ).toBe(true);
  });
});
