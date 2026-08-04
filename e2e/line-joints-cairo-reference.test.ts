import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  LINE_JOINTS_CAIRO_PARITY_THRESHOLDS_V1,
  lineJointsCairoReferenceV1Schema,
  readLineJointsCairoReferenceV1,
} from "./line-joints-cairo-reference";
import { decodeRgbaPngV1, encodeRgbaPngV1 } from "./png-rgba";
import { nativeVisualParityArtifactV1Schema, visualParityCorpusV1Schema } from "./visual-parity-contract";
import { compareVisualParityFramesV1 } from "./visual-parity-metrics";

const ENTRY_ID = "real-line-joints-v10--static";

describe("LineJoints Cairo reference v1", () => {
  it("pins the exact source, producer binaries, renderer configuration, PNG, and top-to-bottom RGBA", async () => {
    const result = await readLineJointsCairoReferenceV1();
    expect(result.reference).toMatchObject({
      frame: {
        camera: { height: 8, width: 14.222222222222221 },
        sampleTime: 0,
        viewport: { heightPx: 360, widthPx: 640 },
      },
      png: {
        byteLength: 14_836,
        rgbaByteLength: 921_600,
        rgbaSha256: "46324c3b6d50025a26363d009eb437e2c1a39c5c6973dbc274f4b16d6ab1b50b",
        rowOrder: "top-to-bottom",
        sha256: "96eae71099c7b51e1294a8862b8c5722a07b7c4fea34a71b9726f8f95610e4fe",
      },
      producer: {
        cairoLibrarySha256: "3144bd5935aee427d6c191b6b6d0ebf9010fb6320295a7f73edd276bc6993f2d",
        cairoVersion: "1.18.0",
        fastManimCommit: "29d21a2bd213df8ffeed0454278aa86289d190b8",
        fastManimTree: "d486d57ba637da1e915a5b29d6bda2d967570a54",
        identitySha256: "e08b66d6be58849c375cdfca633c2591d6c709275b8448794e6da3cb986ca505",
        manimVersion: "0.20.1",
        numpyVersion: "2.4.1",
        pillowImagingModuleSha256: "8a2c7efde4f6b0ef41e6a6197c00a2c19416c5939bf9bb43086f680cb54136a9",
        pillowVersion: "12.2.0",
        pycairoModuleSha256: "a378b352cf9af46ba04511a5910543e33917fc01881ec6908c12ebc9a9cba731",
        pycairoVersion: "1.29.0",
        pythonExecutableSha256: "700660abb666fb5db819af3f03a92bc7d53c15e40b235c17fca6023b5755d784",
        pythonImplementation: "CPython",
        pythonVersion: "3.13.11",
        uvLockSha256: "3244a21383800a8a1049438f24c54121c483b1a4ab24ae8523d8c852b7431753",
      },
      rendererConfig: {
        identitySha256: "0666028c4abb9524b569d45103d786c17b8f70f2cd9b0ea80b080c4341ebde33",
      },
      reproducibility: {
        environment: { PYTHONHASHSEED: "0" },
        seeds: { numpy: 0, pythonRandom: 0 },
      },
      scene: {
        className: "LineJoints",
        repository: "Poietra/fast-manim",
        sourcePath: "example_scenes/basic.py",
        sourceSha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      },
      schema: "poietra.line-joints-cairo-reference",
      version: 1,
    });
    expect(result.png).toHaveLength(14_836);
    expect(result.rgba).toHaveLength(640 * 360 * 4);
  });

  it("keeps its reusable RGBA decoder dimension-bound and the metadata contract strict", () => {
    const rgba = Uint8Array.from([0, 1, 2, 255, 3, 4, 5, 255]);
    const png = encodeRgbaPngV1(rgba, 2, 1);
    expect(decodeRgbaPngV1(png, 2, 1)).toEqual(rgba);
    expect(() => decodeRgbaPngV1(png, 1, 2)).toThrow(/dimensions/i);
    expect(
      lineJointsCairoReferenceV1Schema.safeParse({
        schema: "poietra.line-joints-cairo-reference",
        version: 1,
        silentlyClaimedParity: true,
      }).success,
    ).toBe(false);
  });

  it.runIf(Boolean(process.env.POIETRA_LINE_JOINTS_NATIVE_ARTIFACT_DIR))(
    "matches a native retained-WGPU full-frame artifact against independent Manim/Cairo",
    async () => {
      const artifactRoot = process.env.POIETRA_LINE_JOINTS_NATIVE_ARTIFACT_DIR;
      if (!artifactRoot) throw new Error("The native LineJoints artifact directory is required.");
      const [cairo, corpusText, metadataText] = await Promise.all([
        readLineJointsCairoReferenceV1(),
        readFile("fixtures/visual-parity-v1/corpus.json", "utf8"),
        readFile(join(artifactRoot, ENTRY_ID, "metadata.json"), "utf8"),
      ]);
      const corpus = visualParityCorpusV1Schema.parse(JSON.parse(corpusText));
      const entry = corpus.entries.find(({ id }) => id === ENTRY_ID);
      if (!entry) throw new Error("The LineJoints V10 visual-parity corpus entry is missing.");
      const metadata = nativeVisualParityArtifactV1Schema.parse(JSON.parse(metadataText));
      expect(metadata).toMatchObject({
        corpusEntryId: ENTRY_ID,
        fixture: { viewport: cairo.reference.frame.viewport },
      });
      const nativeRgba = new Uint8Array(await readFile(join(artifactRoot, ENTRY_ID, metadata.rgba.path)));
      const metrics = compareVisualParityFramesV1(cairo.rgba, nativeRgba, entry.sample.viewport, corpus.metricContract);
      const evidence = JSON.stringify(metrics);
      expect(metrics.ssim, evidence).toBeGreaterThanOrEqual(LINE_JOINTS_CAIRO_PARITY_THRESHOLDS_V1.minimumSsim);
      expect(metrics.pixelFractionAboveThreshold, evidence).toBeLessThanOrEqual(
        LINE_JOINTS_CAIRO_PARITY_THRESHOLDS_V1.maximumPixelFractionAboveThreshold,
      );
    },
  );
});
