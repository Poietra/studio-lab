import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import {
  OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V2,
  OPENING_MANIM_OFFICIAL_SOURCE_SHA256_V2,
  openingManimCairoReferenceV2Schema,
  readOpeningManimCairoReferenceV2,
} from "./opening-manim-cairo-reference";
import { withGeneratedRuntimeTraceCairoReferenceV1 } from "./runtime-trace-cairo-reference-runner";

const REAL_GENERATOR_AVAILABLE = Boolean(
  process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND?.trim() &&
    process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_REPOSITORY?.trim(),
);

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function terminalPositionCandidateSource() {
  const official = await readFile(
    new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
    "utf8",
  );
  const boundary = "        self.play(Transform(grid_title, grid_transform_title))\n        self.wait()\n";
  const replacement =
    "        self.play(Transform(grid_title, grid_transform_title))\n" +
    "        grid_title.shift((1.25, -0.5, 0))\n" +
    "        self.wait()\n";
  const candidate = official.replace(boundary, replacement);
  if (candidate === official || candidate.includes(boundary)) {
    throw new Error("The OpeningManim terminal-position candidate source anchor is not unique.");
  }
  return candidate;
}

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
      const { frames, reference } = await readOpeningManimCairoReferenceV2(
        root,
        OPENING_MANIM_OFFICIAL_SOURCE_SHA256_V2,
      );
      await expect(readOpeningManimCairoReferenceV2(root, "0".repeat(64))).rejects.toThrow(/Cairo source hashes/u);
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

  it.runIf(REAL_GENERATOR_AVAILABLE)(
    "renders a terminal-position candidate while retaining the logical source identity",
    async () => {
      const sourceText = await terminalPositionCandidateSource();
      const expectedSourceSha256 = sha256(sourceText);
      const { frames, reference } = await withGeneratedRuntimeTraceCairoReferenceV1({
        generatorPath: "scripts/generate-opening-manim-cairo-reference.py",
        read: async (root) => {
          await expect(readOpeningManimCairoReferenceV2(root, OPENING_MANIM_OFFICIAL_SOURCE_SHA256_V2)).rejects.toThrow(
            /Cairo source hashes/u,
          );
          return readOpeningManimCairoReferenceV2(root, expectedSourceSha256);
        },
        sourceText,
        temporaryPrefix: "poietra-opening-manim-cairo-candidate-",
      });
      expect(reference.scene).toMatchObject({
        className: "OpeningManim",
        repository: "Poietra/fast-manim",
        sourcePath: "example_scenes/basic.py",
        sourceSha256: expectedSourceSha256,
      });
      const beforeBoundary = frames.get("final-title-transform-last")?.rgba;
      const terminal = frames.get("final-title-transform-play-end")?.rgba;
      const durationEnd = frames.get("terminal-hold-end")?.rgba;
      if (!beforeBoundary || !terminal || !durationEnd) {
        throw new Error("The generated OpeningManim candidate is missing a Cairo boundary frame.");
      }
      expect(sha256(terminal)).not.toBe(sha256(beforeBoundary));
      expect(sha256(durationEnd)).toBe(sha256(terminal));
    },
    180_000,
  );
});
