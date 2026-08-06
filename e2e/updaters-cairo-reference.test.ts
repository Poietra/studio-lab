import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { withGeneratedRuntimeTraceCairoReferenceV1 } from "./runtime-trace-cairo-reference-runner";
import {
  readUpdatersCairoReferenceV1,
  UPDATERS_CAIRO_REFERENCE_SAMPLES_V1,
  UPDATERS_OFFICIAL_SOURCE_SHA256_V1,
  updatersCairoReferenceV1Schema,
} from "./updaters-cairo-reference";

const REAL_GENERATOR_AVAILABLE = Boolean(
  process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND?.trim() &&
    process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_REPOSITORY?.trim(),
);
const GENERATOR_PATH = "scripts/generate-updaters-cairo-reference.py";

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function moveAndScaleCandidateSource() {
  const official = await readFile(
    new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
    "utf8",
  );
  const anchor = "            run_time=5,\n        )\n        self.wait()\n\n\nclass SpiralInExample";
  const replacement =
    "            run_time=5,\n        )\n        square.move_to((2, 1, 0))\n        square.scale(1.5)\n        self.wait()\n\n\nclass SpiralInExample";
  const candidate = official.replace(anchor, replacement);
  if (candidate === official || candidate.includes(anchor)) {
    throw new Error("The UpdatersExample move-and-scale candidate source anchor is not unique.");
  }
  return candidate;
}

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
      const { frames, reference } = await readUpdatersCairoReferenceV1(root, UPDATERS_OFFICIAL_SOURCE_SHA256_V1);
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

  it.runIf(REAL_GENERATOR_AVAILABLE)(
    "keeps an omitted source bound to the pinned official UpdatersExample",
    async () => {
      const { frames, reference } = await withGeneratedRuntimeTraceCairoReferenceV1({
        generatorPath: GENERATOR_PATH,
        read: (root) => readUpdatersCairoReferenceV1(root, UPDATERS_OFFICIAL_SOURCE_SHA256_V1),
        temporaryPrefix: "poietra-updaters-cairo-official-",
      });
      expect(reference.scene).toEqual({
        className: "UpdatersExample",
        decimalImplementation: "hermetic-runtime-trace-v1",
        repository: "Poietra/fast-manim",
        sourcePath: "example_scenes/basic.py",
        sourceSha256: UPDATERS_OFFICIAL_SOURCE_SHA256_V1,
      });
      expect(frames.get("initial")?.rgba).toEqual(frames.get("hold")?.rgba);
    },
  );

  it.runIf(REAL_GENERATOR_AVAILABLE)(
    "renders a move-and-scale candidate while retaining the logical source identity",
    async () => {
      const sourceText = await moveAndScaleCandidateSource();
      const expectedSourceSha256 = sha256(sourceText);
      const { frames, reference } = await withGeneratedRuntimeTraceCairoReferenceV1({
        generatorPath: GENERATOR_PATH,
        read: async (root) => {
          await expect(readUpdatersCairoReferenceV1(root, UPDATERS_OFFICIAL_SOURCE_SHA256_V1)).rejects.toThrow(
            /Cairo source hashes/u,
          );
          return readUpdatersCairoReferenceV1(root, expectedSourceSha256);
        },
        sourceText,
        temporaryPrefix: "poietra-updaters-cairo-candidate-",
      });
      expect(reference.scene).toEqual({
        className: "UpdatersExample",
        decimalImplementation: "hermetic-runtime-trace-v1",
        repository: "Poietra/fast-manim",
        sourcePath: "example_scenes/basic.py",
        sourceSha256: expectedSourceSha256,
      });
      const initial = frames.get("initial")?.rgba;
      const hold = frames.get("hold")?.rgba;
      const durationEnd = frames.get("duration-end")?.rgba;
      if (!initial || !hold || !durationEnd) throw new Error("The generated candidate is missing a Cairo frame.");
      expect(sha256(hold)).not.toBe(sha256(initial));
      expect(sha256(durationEnd)).toBe(sha256(hold));
    },
  );
});
