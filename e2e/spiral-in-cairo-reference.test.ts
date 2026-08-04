import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  SPIRAL_IN_CAIRO_PARITY_THRESHOLDS_V1,
  SPIRAL_IN_CAIRO_REFERENCE_ENTRY_IDS_V1,
  SPIRAL_IN_CAIRO_REFERENCE_SAMPLES_V1,
  readSpiralInCairoReferenceForEntryV1,
  readSpiralInCairoReferenceV1,
  spiralInCairoReferenceV1Schema,
} from "./spiral-in-cairo-reference";
import { nativeVisualParityArtifactV1Schema, visualParityCorpusV1Schema } from "./visual-parity-contract";
import { compareVisualParityFramesV1 } from "./visual-parity-metrics";

const EXPECTED_FRAMES = {
  "early-reveal": {
    byteLength: 1_767,
    rgbaSha256: "fccf48b46608e50e04c1858cdde5e40405de2ce55ea32332fe87225976884865",
    sha256: "f3b5235976d77952c1c01ae89cf2d52ae9b4065e5ced7c406606285a5f554343",
  },
  end: {
    byteLength: 1_751,
    rgbaSha256: "b2eab2e96e1c94751425a42d1e435e41f8c48a5f1cd41ff4defb3931323ddc07",
    sha256: "067aba9deef0fde3a8db2c6c4f559a1e947de08dd4d07b39a35708a776952d91",
  },
  "group-fade-midpoint": {
    byteLength: 6_832,
    rgbaSha256: "878c42bfc4af507ec94751e57992686ec103bf825b778083b27ddc3efefbbe7b",
    sha256: "e72c4f4f643b8d83b6e08cbf239baab832e2dac46204327036b4d11fa0dff4cc",
  },
  hold: {
    byteLength: 7_337,
    rgbaSha256: "d95091184410e266a6418ce4df3b8fef1f7c12b5b5a36caf15f336ad6bb87459",
    sha256: "67ae19e3c863f3f6d268c5067a761fc5766e39178534c81742c7f59067f75726",
  },
  "spiral-end": {
    byteLength: 7_337,
    rgbaSha256: "d95091184410e266a6418ce4df3b8fef1f7c12b5b5a36caf15f336ad6bb87459",
    sha256: "67ae19e3c863f3f6d268c5067a761fc5766e39178534c81742c7f59067f75726",
  },
  "spiral-midpoint": {
    byteLength: 4_343,
    rgbaSha256: "a5085ce9394ae03b5c0a68c314a29c1cf26ff10c85d1bb147031289ce29dd26b",
    sha256: "e799e7f44c599c039b1e3ba9fa4ec19558c541e1d467ff0d700e55d2c6cd85ba",
  },
  start: {
    byteLength: 1_751,
    rgbaSha256: "b2eab2e96e1c94751425a42d1e435e41f8c48a5f1cd41ff4defb3931323ddc07",
    sha256: "067aba9deef0fde3a8db2c6c4f559a1e947de08dd4d07b39a35708a776952d91",
  },
} as const;

describe("SpiralIn Cairo reference v1", () => {
  it("pins the official source, producer, renderer configuration, and seven full RGBA frames", async () => {
    const result = await readSpiralInCairoReferenceV1();
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
        fastManimCommit: "fdfa1a544fafe85fedc7e92b39f2ee16e827bb62",
        fastManimTree: "2d763ec42d7da5029d1a4375c507512a43e16473",
        identitySha256: "148f1e15a7e1aba990a26551d5d8ff9b8672825c0f4f53fe78a040d6149f3a81",
        manimVersion: "0.20.1",
        numpyVersion: "2.4.1",
        pillowImagingModuleSha256: "8a2c7efde4f6b0ef41e6a6197c00a2c19416c5939bf9bb43086f680cb54136a9",
        pillowVersion: "12.2.0",
        pycairoModuleSha256: "a378b352cf9af46ba04511a5910543e33917fc01881ec6908c12ebc9a9cba731",
        pycairoVersion: "1.29.0",
        pythonExecutableSha256: "700660abb666fb5db819af3f03a92bc7d53c15e40b235c17fca6023b5755d784",
        pythonImplementation: "CPython",
        pythonVersion: "3.13.11",
        texToolchain: {
          dvisvgm: {
            executableSha256: "22003976106543f0df9eecf95e486e65abec96bf983ac580f4c8dcbcaf2539ca",
            version: "dvisvgm 3.2.1",
          },
          latex: {
            executableSha256: "bdf084260e5e3ca3b1453a8ec1465efa5c0b23180d3bba7992fdd3ee1aeee45b",
            version: "pdfTeX 3.141592653-2.6-1.40.25 (TeX Live 2023/Debian)",
          },
        },
        uvLockSha256: "3244a21383800a8a1049438f24c54121c483b1a4ab24ae8523d8c852b7431753",
      },
      rendererConfig: {
        identitySha256: "931ba54adc01f50656485cdc21aef32489e9b36caf3dd396115787115cb03d33",
      },
      reproducibility: {
        environment: { PYTHONHASHSEED: "0" },
        seeds: { numpy: 0, pythonRandom: 0 },
      },
      scene: {
        className: "SpiralInExample",
        repository: "Poietra/fast-manim",
        sourcePath: "example_scenes/basic.py",
        sourceSha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      },
      schema: "poietra.spiral-in-cairo-reference",
      version: 1,
    });
    expect(result.reference.frames).toHaveLength(7);
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

  it("proves the empty endpoints, moving reveal, stable hold, and group fade are distinct", async () => {
    const { frames } = await readSpiralInCairoReferenceV1();
    const rgba = (id: (typeof SPIRAL_IN_CAIRO_REFERENCE_SAMPLES_V1)[number][1]) => {
      const frame = frames.get(id);
      if (!frame) throw new Error(`Missing Cairo frame ${id}.`);
      return frame.rgba;
    };
    expect(rgba("start")).toEqual(rgba("end"));
    expect(rgba("spiral-end")).toEqual(rgba("hold"));
    expect(rgba("early-reveal")).not.toEqual(rgba("start"));
    expect(rgba("spiral-midpoint")).not.toEqual(rgba("early-reveal"));
    expect(rgba("spiral-midpoint")).not.toEqual(rgba("spiral-end"));
    expect(rgba("group-fade-midpoint")).not.toEqual(rgba("hold"));
    expect(rgba("group-fade-midpoint")).not.toEqual(rgba("end"));
  });

  it("binds every Cairo sample to the exact V11 visual-parity corpus entry", async () => {
    const corpus = visualParityCorpusV1Schema.parse(
      JSON.parse(await readFile("fixtures/visual-parity-v1/corpus.json", "utf8")),
    );
    for (const [entryId, sampleId, sampleTime] of SPIRAL_IN_CAIRO_REFERENCE_SAMPLES_V1) {
      const entry = corpus.entries.find(({ id }) => id === entryId);
      if (!entry) throw new Error(`The SpiralIn V11 corpus entry ${entryId} is missing.`);
      const cairo = await readSpiralInCairoReferenceForEntryV1(entryId);
      expect(entry).toMatchObject({
        fixture: {
          id: "eng-v1-real-spiral-in-v11",
          path: "fixtures/engine-v1/real-spiral-in-v11.json",
          revision: {
            kind: "imported-manim-server-snapshot",
            sha256: "a5b0608d69a87c3fc5e66942584b14b94be8e9d7791dd3c6ec126047f3997ca7",
          },
        },
        sample: { id: sampleId, sampleTime, viewport: { heightPx: 360, widthPx: 640 } },
        thresholdException: null,
      });
      expect(cairo.sampleTime).toBe(sampleTime);
    }
    expect(SPIRAL_IN_CAIRO_REFERENCE_ENTRY_IDS_V1).toHaveLength(7);
  });

  it("keeps the timeline envelope strict", () => {
    expect(
      spiralInCairoReferenceV1Schema.safeParse({
        schema: "poietra.spiral-in-cairo-reference",
        version: 1,
        unverifiedFrame: true,
      }).success,
    ).toBe(false);
  });

  it.runIf(Boolean(process.env.POIETRA_SPIRAL_IN_NATIVE_ARTIFACT_DIR))(
    "matches native retained-WGPU full-frame artifacts against independent Manim/Cairo",
    async () => {
      const artifactRoot = process.env.POIETRA_SPIRAL_IN_NATIVE_ARTIFACT_DIR;
      if (!artifactRoot) throw new Error("The native SpiralIn artifact directory is required.");
      const corpus = visualParityCorpusV1Schema.parse(
        JSON.parse(await readFile("fixtures/visual-parity-v1/corpus.json", "utf8")),
      );
      const comparisons: Array<Readonly<{ entryId: string; pixelFractionAboveThreshold: number; ssim: number }>> = [];
      for (const entryId of SPIRAL_IN_CAIRO_REFERENCE_ENTRY_IDS_V1) {
        const [cairo, metadataText] = await Promise.all([
          readSpiralInCairoReferenceForEntryV1(entryId),
          readFile(join(artifactRoot, entryId, "metadata.json"), "utf8"),
        ]);
        const entry = corpus.entries.find(({ id }) => id === entryId);
        if (!entry) throw new Error(`The SpiralIn V11 visual-parity entry ${entryId} is missing.`);
        const metadata = nativeVisualParityArtifactV1Schema.parse(JSON.parse(metadataText));
        expect(metadata).toMatchObject({
          corpusEntryId: entryId,
          fixture: { sampleTime: cairo.sampleTime, viewport: cairo.reference.frame.viewport },
        });
        const nativeRgba = new Uint8Array(await readFile(join(artifactRoot, entryId, metadata.rgba.path)));
        const metrics = compareVisualParityFramesV1(
          cairo.rgba,
          nativeRgba,
          entry.sample.viewport,
          corpus.metricContract,
        );
        comparisons.push({
          entryId,
          pixelFractionAboveThreshold: metrics.pixelFractionAboveThreshold,
          ssim: metrics.ssim,
        });
      }
      const failures = comparisons.filter(
        ({ pixelFractionAboveThreshold, ssim }) =>
          ssim < SPIRAL_IN_CAIRO_PARITY_THRESHOLDS_V1.minimumSsim ||
          pixelFractionAboveThreshold > SPIRAL_IN_CAIRO_PARITY_THRESHOLDS_V1.maximumPixelFractionAboveThreshold,
      );
      expect(failures, JSON.stringify(comparisons, null, 2)).toEqual([]);
    },
  );
});
