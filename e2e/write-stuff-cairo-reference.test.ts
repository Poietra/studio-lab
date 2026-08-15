import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { nativeVisualParityArtifactV1Schema, visualParityCorpusV1Schema } from "./visual-parity-contract";
import { compareVisualParityFramesV1 } from "./visual-parity-metrics";
import {
  readWriteStuffCairoReferenceForEntryV1,
  readWriteStuffCairoReferenceV1,
  WRITE_STUFF_CAIRO_PARITY_THRESHOLDS_V1,
  WRITE_STUFF_CAIRO_REFERENCE_ENTRY_IDS_V1,
  WRITE_STUFF_CAIRO_REFERENCE_ROOT_V1,
  WRITE_STUFF_CAIRO_REFERENCE_SAMPLES_V1,
  WRITE_STUFF_EDITED_CAIRO_REFERENCE_ENTRY_IDS_V1,
  WRITE_STUFF_EDITED_CAIRO_REFERENCE_ROOT_V1,
  writeStuffCairoReferenceSampleForEntryV1,
  writeStuffCairoReferenceV1Schema,
} from "./write-stuff-cairo-reference";

const EXPECTED_FRAMES = {
  end: {
    byteLength: 27_172,
    rgbaSha256: "a59062c94722a3628ded101c9f8d76fb0d7ec5cd51ea966042a870323b48cc32",
    sha256: "9f9a831733478f5b0bea11de883b4c1c7f9a8e4611c52eb45b8d4a1a314dffe8",
  },
  hold: {
    byteLength: 27_172,
    rgbaSha256: "a59062c94722a3628ded101c9f8d76fb0d7ec5cd51ea966042a870323b48cc32",
    sha256: "9f9a831733478f5b0bea11de883b4c1c7f9a8e4611c52eb45b8d4a1a314dffe8",
  },
  "math-end": {
    byteLength: 27_172,
    rgbaSha256: "a59062c94722a3628ded101c9f8d76fb0d7ec5cd51ea966042a870323b48cc32",
    sha256: "9f9a831733478f5b0bea11de883b4c1c7f9a8e4611c52eb45b8d4a1a314dffe8",
  },
  "math-midpoint": {
    byteLength: 23_987,
    rgbaSha256: "d74d177af8f819dcddbb7c9300fb16fb62722a9677eec57a02ab32b9dc03261f",
    sha256: "3a580cee3b899bce40e9ecb83c45f08ab801d4900a0f4566a1ef5b6d28abb8e6",
  },
  "math-start": {
    byteLength: 15_233,
    rgbaSha256: "119d2636515d854735801c1f4ffda74248512c484c5298465597dd9751ec37b5",
    sha256: "c091b206e9c862714b3d9a76e29e2ee3d99c9ecdf0fdf04a8b4d5e6fd485c510",
  },
  start: {
    byteLength: 1_751,
    rgbaSha256: "b2eab2e96e1c94751425a42d1e435e41f8c48a5f1cd41ff4defb3931323ddc07",
    sha256: "067aba9deef0fde3a8db2c6c4f559a1e947de08dd4d07b39a35708a776952d91",
  },
  "tex-early": {
    byteLength: 3_982,
    rgbaSha256: "8d0e4d84a9804e37d0404a423da3694a3b16ae9ef88ed525eea687e2fe1dea71",
    sha256: "eedf1a57c5e4763ec665431c40fed28f562fde87db041a98c6657161cc4070f4",
  },
  "tex-midpoint": {
    byteLength: 11_247,
    rgbaSha256: "33bbd61119f559d236ecb61a24df96e9d662cfbf10b13942f6bdbec054d42731",
    sha256: "c586befe504be8053f6469d5aeb855e5eeaf992771b4cc3413aecff48644c642",
  },
} as const;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("WriteStuff Cairo reference v1", () => {
  it("pins the official source, producer, renderer configuration, and eight full RGBA frames", async () => {
    const result = await readWriteStuffCairoReferenceV1();
    expect(result.reference).toMatchObject({
      frame: {
        background: "opaque-black",
        camera: { height: 8, width: 14.222222222222221 },
        colorDomain: "srgb-u8",
        frameRate: 60,
        viewport: { heightPx: 360, widthPx: 640 },
      },
      producer: {
        cairoLibrarySha256: "3144bd5935aee427d6c191b6b6d0ebf9010fb6320295a7f73edd276bc6993f2d",
        cairoVersion: "1.18.0",
        fastManimCommit: "044a61aa0d868fc9e799588f2eb88006594b6c44",
        fastManimTree: "996ad2b7375a6f911b1b00747eaad38834bde25c",
        identitySha256: "1bd11c4b82105e2e4013fcd90d7c4cb82a779f8d9df93e3390d4101a744bca0f",
        manimVersion: "0.20.1",
        numpyVersion: "2.4.1",
        pillowVersion: "12.2.0",
        pycairoVersion: "1.29.0",
        pythonImplementation: "CPython",
        pythonVersion: "3.13.11",
        texToolchain: {
          dvisvgm: { version: "dvisvgm 3.6" },
          latex: { version: "pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)" },
        },
        uvLockSha256: "3244a21383800a8a1049438f24c54121c483b1a4ab24ae8523d8c852b7431753",
      },
      rendererConfig: { identitySha256: "931ba54adc01f50656485cdc21aef32489e9b36caf3dd396115787115cb03d33" },
      reproducibility: {
        environment: { PYTHONHASHSEED: "0" },
        seeds: { numpy: 0, pythonRandom: 0 },
      },
      scene: {
        className: "WriteStuff",
        repository: "Poietra/fast-manim",
        sourcePath: "example_scenes/basic.py",
        sourceSha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      },
      schema: "poietra.write-stuff-cairo-reference",
      version: 1,
    });
    expect(result.reference.frames).toHaveLength(8);
    for (const frame of result.reference.frames) {
      expect(frame.png).toMatchObject({
        ...EXPECTED_FRAMES[frame.id],
        rgbaByteLength: 640 * 360 * 4,
        rowOrder: "top-to-bottom",
      });
      expect(result.frames.get(frame.id)?.png).toHaveLength(EXPECTED_FRAMES[frame.id].byteLength);
      expect(result.frames.get(frame.id)?.rgba).toHaveLength(640 * 360 * 4);
    }
  });

  it("pins the independently rendered Studio equation move and scale", async () => {
    const result = await readWriteStuffCairoReferenceV1(WRITE_STUFF_EDITED_CAIRO_REFERENCE_ROOT_V1);
    expect(writeStuffCairoReferenceSampleForEntryV1(WRITE_STUFF_EDITED_CAIRO_REFERENCE_ENTRY_IDS_V1[0]!)).toEqual({
      entryId: "real-write-stuff-v12-edited--hold",
      root: WRITE_STUFF_EDITED_CAIRO_REFERENCE_ROOT_V1,
      sampleId: "hold",
      sampleTime: 3.5,
    });
    expect(result.reference).toMatchObject({
      producer: {
        fastManimCommit: "8a1a4feb68c3ba47a2ff26c83b9bed4a6b095063",
        fastManimTree: "f1a5ef1b69711cf41c3424dd697ab75591942905",
        identitySha256: "4a43a3cf03fac90a44f4a465a137ac2afbb4b083fa7ea265ebad4f095a8eec7b",
        texCache: {
          files: [
            {
              path: "2001da0d734dc8fc.tex",
              sha256: "2001da0d734dc8fcaf7e6d3d0b5035e82d71733ab5feca774aa5740e8b099716",
            },
            {
              path: "2001da0d734dc8fc.svg",
              sha256: "8e6c76607b68689555296fc8039cf6c82ea29bf9ef0445a4dc6c030e9e13efa7",
            },
            {
              path: "5c2081ce9e37598c.tex",
              sha256: "5c2081ce9e37598c6bdd8ac3dd52ce6616d99b162c7c64071e9a6ef4ad20d8a8",
            },
            {
              path: "5c2081ce9e37598c.svg",
              sha256: "cb2e99f837c1316e47b67157bf787b1f096a14b01f4392482eba740dd3ac1dbc",
            },
            {
              path: "8f249e3b899ba7b1.tex",
              sha256: "8f249e3b899ba7b13ac37b744ca8509b929b2431baf1d2ff07d28892576ac419",
            },
            {
              path: "8f249e3b899ba7b1.svg",
              sha256: "1496ea173fbe28fab26772d9509d9b34dc58ce8bd6b01a8950899a9adcb4139d",
            },
          ],
          kind: "pinned-manim-dvisvgm-svg",
        },
      },
      scene: {
        sourceSha256: "37179e2a50fc22e784962d26a7778f5c273c296d5fcbccf04d89fb7e55885d98",
      },
    });
    if (!("texCache" in result.reference.producer))
      throw new Error("The edited Cairo producer must pin its Tex cache.");
    for (const file of result.reference.producer.texCache.files) {
      const bytes = await readFile(join("fixtures/write-stuff-tex-cache-v1", file.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    const hold = result.frames.get("hold");
    expect(hold).toMatchObject({ sampleTime: 3.5 });
    expect(result.reference.frames.find(({ id }) => id === "hold")?.png).toMatchObject({
      byteLength: 21_020,
      rgbaSha256: "00f17a9b15c69f2f1f8ba556dacf4061fd27c113e7063f008dcd7b5146cf9bfe",
      sha256: "90b62cc1ecf50fd2d7cc0a8ea203d4e375f6a5647a161323ddff86c9d3c4242c",
    });
    expect(hold?.rgba).toHaveLength(640 * 360 * 4);
  });

  it("proves both Writes advance and the completed glyphs remain through the duration endpoint", async () => {
    const { frames } = await readWriteStuffCairoReferenceV1();
    const rgbaSha256 = (id: (typeof WRITE_STUFF_CAIRO_REFERENCE_SAMPLES_V1)[number][1]) => {
      const frame = frames.get(id);
      if (!frame) throw new Error(`Missing Cairo frame ${id}.`);
      return sha256(frame.rgba);
    };
    expect(rgbaSha256("tex-early")).not.toBe(rgbaSha256("start"));
    expect(rgbaSha256("tex-midpoint")).not.toBe(rgbaSha256("tex-early"));
    expect(rgbaSha256("math-start")).not.toBe(rgbaSha256("tex-midpoint"));
    expect(rgbaSha256("math-midpoint")).not.toBe(rgbaSha256("math-start"));
    expect(rgbaSha256("math-end")).not.toBe(rgbaSha256("math-midpoint"));
    expect(rgbaSha256("hold")).toBe(rgbaSha256("math-end"));
    expect(rgbaSha256("end")).toBe(rgbaSha256("hold"));
  });

  it("binds every Cairo sample to the exact V12 visual-parity corpus entry", async () => {
    const [cairoReference, corpusText] = await Promise.all([
      readWriteStuffCairoReferenceV1(),
      readFile("fixtures/visual-parity-v1/corpus.json", "utf8"),
    ]);
    const corpus = visualParityCorpusV1Schema.parse(JSON.parse(corpusText));
    for (const [entryId, sampleId, sampleTime] of WRITE_STUFF_CAIRO_REFERENCE_SAMPLES_V1) {
      const entry = corpus.entries.find(({ id }) => id === entryId);
      if (!entry) throw new Error(`The WriteStuff V12 corpus entry ${entryId} is missing.`);
      const resolved = writeStuffCairoReferenceSampleForEntryV1(entryId);
      expect(resolved).toEqual({ entryId, root: WRITE_STUFF_CAIRO_REFERENCE_ROOT_V1, sampleId, sampleTime });
      const cairo = cairoReference.frames.get(resolved.sampleId);
      if (!cairo) throw new Error(`WriteStuff Cairo reference is missing ${sampleId}.`);
      expect(entry).toMatchObject({
        fixture: {
          id: "eng-v1-real-write-stuff-v12",
          path: "fixtures/engine-v1/real-write-stuff-v12.json",
          revision: {
            kind: "imported-manim-server-snapshot",
            sha256: "58ec83a4bf4e4e155a9d9bcee48cabbb230d38722518ff7f21245ac3c80c532f",
          },
        },
        sample: { id: sampleId, sampleTime, viewport: { heightPx: 360, widthPx: 640 } },
        thresholdException: null,
      });
      expect(cairo.sampleTime).toBe(sampleTime);
    }
    expect(WRITE_STUFF_CAIRO_REFERENCE_ENTRY_IDS_V1).toHaveLength(8);
    expect(() => writeStuffCairoReferenceSampleForEntryV1("unknown-entry")).toThrow(/no independent/u);
  });

  it("keeps the timeline envelope strict", () => {
    expect(
      writeStuffCairoReferenceV1Schema.safeParse({
        schema: "poietra.write-stuff-cairo-reference",
        version: 1,
        unverifiedFrame: true,
      }).success,
    ).toBe(false);
  });

  it.runIf(Boolean(process.env.POIETRA_WRITE_STUFF_NATIVE_ARTIFACT_DIR))(
    "matches native retained-WGPU full-frame artifacts against independent Manim/Cairo",
    async () => {
      const artifactRoot = process.env.POIETRA_WRITE_STUFF_NATIVE_ARTIFACT_DIR;
      if (!artifactRoot) throw new Error("The native WriteStuff artifact directory is required.");
      const corpus = visualParityCorpusV1Schema.parse(
        JSON.parse(await readFile("fixtures/visual-parity-v1/corpus.json", "utf8")),
      );
      const comparisons = [];
      for (const entryId of [
        ...WRITE_STUFF_CAIRO_REFERENCE_ENTRY_IDS_V1,
        ...WRITE_STUFF_EDITED_CAIRO_REFERENCE_ENTRY_IDS_V1,
      ]) {
        const [cairo, metadataText] = await Promise.all([
          readWriteStuffCairoReferenceForEntryV1(entryId),
          readFile(join(artifactRoot, entryId, "metadata.json"), "utf8"),
        ]);
        const entry = corpus.entries.find(({ id }) => id === entryId);
        if (!entry) throw new Error(`The WriteStuff V12 visual-parity entry ${entryId} is missing.`);
        const metadata = nativeVisualParityArtifactV1Schema.parse(JSON.parse(metadataText));
        expect(metadata).toMatchObject({
          corpusEntryId: entryId,
          fixture: { sampleTime: cairo.sampleTime, viewport: cairo.reference.frame.viewport },
        });
        const nativeRgba = new Uint8Array(await readFile(join(artifactRoot, entryId, metadata.rgba.path)));
        comparisons.push({
          entryId,
          ...compareVisualParityFramesV1(cairo.rgba, nativeRgba, entry.sample.viewport, corpus.metricContract),
        });
      }
      const failures = comparisons.filter(
        ({ pixelFractionAboveThreshold, ssim }) =>
          ssim < WRITE_STUFF_CAIRO_PARITY_THRESHOLDS_V1.minimumSsim ||
          pixelFractionAboveThreshold > WRITE_STUFF_CAIRO_PARITY_THRESHOLDS_V1.maximumPixelFractionAboveThreshold,
      );
      expect(failures, JSON.stringify(comparisons, null, 2)).toEqual([]);
    },
  );
});
