import { describe, expect, it } from "vitest";
import {
  readUpdatersCairoReferenceV1,
  UPDATERS_CAIRO_REFERENCE_SAMPLES_V1,
  updatersCairoReferenceV1Schema,
} from "./updaters-cairo-reference";

describe("UpdatersExample Cairo reference v1", () => {
  it("keeps the generated evidence envelope strict", () => {
    expect(
      updatersCairoReferenceV1Schema.safeParse({
        schema: "poietra.updaters-cairo-reference",
        unverifiedFrame: true,
        version: 1,
      }).success,
    ).toBe(false);
  });

  it.runIf(Boolean(process.env.POIETRA_UPDATERS_CAIRO_REFERENCE_ROOT))(
    "validates all seven live Cairo frames and their temporal relations",
    async () => {
      const root = process.env.POIETRA_UPDATERS_CAIRO_REFERENCE_ROOT;
      if (!root) throw new Error("POIETRA_UPDATERS_CAIRO_REFERENCE_ROOT is required.");
      const { frames, reference } = await readUpdatersCairoReferenceV1(root);
      expect(reference.frames).toHaveLength(7);
      expect(
        reference.frames.map(({ id, capturedFrameIndex, requestSampleTime }) => [
          id,
          capturedFrameIndex,
          requestSampleTime,
        ]),
      ).toEqual(UPDATERS_CAIRO_REFERENCE_SAMPLES_V1);

      const rgba = (id: (typeof UPDATERS_CAIRO_REFERENCE_SAMPLES_V1)[number][0]) => {
        const frame = frames.get(id);
        if (!frame) throw new Error(`Missing Cairo frame ${id}.`);
        return frame.rgba;
      };
      expect(rgba("initial")).not.toEqual(rgba("bottom"));
      expect(rgba("initial")).toEqual(rgba("hold"));
      expect(rgba("descent")).toEqual(rgba("return"));
      expect(rgba("play-end")).not.toEqual(rgba("hold"));
      expect(rgba("hold")).toEqual(rgba("duration-end"));
    },
  );
});
