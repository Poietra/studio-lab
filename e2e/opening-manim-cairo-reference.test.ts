import { describe, expect, it } from "vitest";
import {
  OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2,
  openingManimCairoReferenceV2Schema,
  readOpeningManimCairoReferenceV2,
} from "./opening-manim-cairo-reference";

describe("OpeningManim Cairo reference v2", () => {
  it("keeps the generated evidence envelope strict", () => {
    expect(
      openingManimCairoReferenceV2Schema.safeParse({
        schema: "poietra.opening-manim-cairo-reference",
        unverifiedFrame: true,
        version: 2,
      }).success,
    ).toBe(false);
  });

  it.runIf(Boolean(process.env.POIETRA_OPENING_MANIM_CAIRO_REFERENCE_ROOT))(
    "validates the twenty-six independent Cairo frames and their temporal relations",
    async () => {
      const root = process.env.POIETRA_OPENING_MANIM_CAIRO_REFERENCE_ROOT;
      if (!root) throw new Error("POIETRA_OPENING_MANIM_CAIRO_REFERENCE_ROOT is required.");
      const { frames, reference } = await readOpeningManimCairoReferenceV2(root);
      expect(
        reference.frames.map(({ id, capturedFrameIndex, requestSampleTime }) => [
          id,
          capturedFrameIndex,
          requestSampleTime,
        ]),
      ).toEqual(OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2);

      const rgba = (id: (typeof OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2)[number][0]) => {
        const frame = frames.get(id);
        if (!frame) throw new Error(`Missing Cairo frame ${id}.`);
        return frame.rgba;
      };
      const framesAreEqual = (
        left: (typeof OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2)[number][0],
        right: (typeof OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2)[number][0],
      ) => {
        const leftRgba = rgba(left);
        const rightRgba = rgba(right);
        if (leftRgba.byteLength !== rightRgba.byteLength) return false;
        return leftRgba.every((value, index) => value === rightRgba[index]);
      };
      expect(framesAreEqual("initial", "opening-animation-midpoint")).toBe(false);
      expect(framesAreEqual("opening-animation-midpoint", "opening-play-end")).toBe(false);
      expect(framesAreEqual("opening-play-end", "opening-hold-last")).toBe(true);
      expect(framesAreEqual("opening-hold-last", "transform-start")).toBe(false);
      expect(framesAreEqual("transform-start", "transform-midpoint")).toBe(false);
      expect(framesAreEqual("transform-midpoint", "transform-play-end")).toBe(false);
      expect(framesAreEqual("transform-play-end", "wait-end")).toBe(true);
      expect(framesAreEqual("wait-end", "grid-create-start")).toBe(true);
      expect(framesAreEqual("grid-create-start", "grid-create-early")).toBe(false);
      expect(framesAreEqual("grid-create-early", "grid-create-midpoint")).toBe(false);
      expect(framesAreEqual("grid-create-midpoint", "grid-create-last")).toBe(false);
      expect(framesAreEqual("grid-create-last", "grid-play-end")).toBe(false);
      expect(framesAreEqual("grid-play-end", "grid-wait-end")).toBe(true);
      expect(framesAreEqual("grid-wait-end", "warp-start")).toBe(true);
      expect(framesAreEqual("warp-start", "warp-early")).toBe(false);
      expect(framesAreEqual("warp-early", "warp-midpoint")).toBe(false);
      expect(framesAreEqual("warp-midpoint", "warp-late")).toBe(false);
      expect(framesAreEqual("warp-late", "warp-last")).toBe(false);
      expect(framesAreEqual("warp-last", "warp-play-end")).toBe(false);
      expect(framesAreEqual("warp-play-end", "warp-hold-last")).toBe(true);
      expect(framesAreEqual("warp-hold-last", "final-title-transform-start")).toBe(false);
      expect(framesAreEqual("final-title-transform-start", "final-title-transform-midpoint")).toBe(false);
      expect(framesAreEqual("final-title-transform-midpoint", "final-title-transform-last")).toBe(false);
      expect(framesAreEqual("final-title-transform-last", "final-title-transform-play-end")).toBe(false);
      expect(framesAreEqual("final-title-transform-play-end", "terminal-hold-end")).toBe(true);
    },
  );
});
