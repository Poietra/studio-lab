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
    "validates the fourteen independent Cairo frames and their temporal relations",
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
      expect(rgba("initial")).not.toEqual(rgba("opening-animation-midpoint"));
      expect(rgba("opening-animation-midpoint")).not.toEqual(rgba("opening-play-end"));
      expect(rgba("opening-play-end")).toEqual(rgba("opening-hold-last"));
      expect(rgba("opening-hold-last")).not.toEqual(rgba("transform-start"));
      expect(rgba("transform-start")).not.toEqual(rgba("transform-midpoint"));
      expect(rgba("transform-midpoint")).not.toEqual(rgba("transform-play-end"));
      expect(rgba("transform-play-end")).toEqual(rgba("wait-end"));
      expect(rgba("wait-end")).toEqual(rgba("grid-create-start"));
      expect(rgba("grid-create-start")).not.toEqual(rgba("grid-create-early"));
      expect(rgba("grid-create-early")).not.toEqual(rgba("grid-create-midpoint"));
      expect(rgba("grid-create-midpoint")).not.toEqual(rgba("grid-create-last"));
      expect(rgba("grid-create-last")).not.toEqual(rgba("grid-play-end"));
      expect(rgba("grid-play-end")).toEqual(rgba("grid-wait-end"));
    },
  );
});
