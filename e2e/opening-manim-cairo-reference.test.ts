import { describe, expect, it } from "vitest";
import {
  OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V1,
  openingManimCairoReferenceV1Schema,
  readOpeningManimCairoReferenceV1,
} from "./opening-manim-cairo-reference";

describe("OpeningManim Cairo reference v1", () => {
  it("keeps the generated evidence envelope strict", () => {
    expect(
      openingManimCairoReferenceV1Schema.safeParse({
        schema: "poietra.opening-manim-cairo-reference",
        unverifiedFrame: true,
        version: 1,
      }).success,
    ).toBe(false);
  });

  it.runIf(Boolean(process.env.POIETRA_OPENING_MANIM_CAIRO_REFERENCE_ROOT))(
    "validates the four independent Cairo frames and their temporal relations",
    async () => {
      const root = process.env.POIETRA_OPENING_MANIM_CAIRO_REFERENCE_ROOT;
      if (!root) throw new Error("POIETRA_OPENING_MANIM_CAIRO_REFERENCE_ROOT is required.");
      const { frames, reference } = await readOpeningManimCairoReferenceV1(root);
      expect(
        reference.frames.map(({ id, capturedFrameIndex, requestSampleTime }) => [
          id,
          capturedFrameIndex,
          requestSampleTime,
        ]),
      ).toEqual(OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V1);

      const rgba = (id: (typeof OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V1)[number][0]) => {
        const frame = frames.get(id);
        if (!frame) throw new Error(`Missing Cairo frame ${id}.`);
        return frame.rgba;
      };
      expect(rgba("initial")).not.toEqual(rgba("animation-midpoint"));
      expect(rgba("animation-midpoint")).not.toEqual(rgba("play-end"));
      expect(rgba("play-end")).toEqual(rgba("wait-end"));
    },
  );
});
