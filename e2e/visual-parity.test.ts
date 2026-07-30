import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";
import { encodeRgbaPngV1 } from "./png-rgba";
import { thresholdsForEntryV1, visualParityCorpusV1Schema, visualParityReportV1Schema } from "./visual-parity-contract";
import { compareVisualParityFramesV1, makeOpaqueVisualParityDiffV1 } from "./visual-parity-metrics";

async function corpusFixture() {
  return visualParityCorpusV1Schema.parse(JSON.parse(await readFile("fixtures/visual-parity-v1/corpus.json", "utf8")));
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("visual parity v1 contracts", () => {
  it("pins the first corpus item to the existing dynamic semantic digest and default gate", async () => {
    const corpus = await corpusFixture();
    expect(corpus.entries).toHaveLength(2);
    const entry = corpus.entries.find(({ id }) => id === "dynamic-affine-camera--a-first");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("The dynamic visual parity entry is missing.");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-dynamic-affine-camera",
        revision: { sha256: "1641641641641641641641641641641641641641641641641641641641641641" },
      },
      id: "dynamic-affine-camera--a-first",
      sample: {
        id: "a-first",
        semanticDigest: "c29280443cc17ea9fed6882527d3a624865296a864e4f14a0aa791d656ba4a19",
        viewport: { heightPx: 90, widthPx: 160 },
      },
      thresholdException: null,
    });
    expect(thresholdsForEntryV1(corpus, entry)).toEqual({
      maximumPixelFractionAboveThreshold: 0.005,
      minimumSsim: 0.995,
    });
  });

  it("requires both a non-empty reason and explicit thresholds for every exception", async () => {
    const corpus = await corpusFixture();
    const entry = corpus.entries[0]!;
    const invalid = {
      ...corpus,
      entries: [{ ...entry, thresholdException: { reason: "", thresholdOverride: corpus.defaultThresholds } }],
    };
    expect(visualParityCorpusV1Schema.safeParse(invalid).success).toBe(false);
    expect(
      visualParityCorpusV1Schema.safeParse({
        ...corpus,
        entries: [{ ...entry, thresholdException: { reason: "temporary adapter variance" } }],
      }).success,
    ).toBe(false);
  });

  it("pins PNG alpha-edge bytes and its independent full-frame reference", async () => {
    const corpus = await corpusFixture();
    const entry = corpus.entries.find(({ id }) => id === "png-alpha-edge-camera--midpoint");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-png-alpha-edge-camera",
        revision: { sha256: "e7f8dcbd4eabd88861b101575fdb6b420ec4447173622bf6f9c7bbf6381160fc" },
      },
      sample: {
        id: "midpoint",
        sampleTime: 0.5,
        semanticDigest: "d9b5ec588d4366327c73fde436597f008b615450aa0a35824618e81573ebcec6",
        viewport: { heightPx: 4, widthPx: 8 },
      },
      thresholdException: null,
    });

    const fixture = JSON.parse(await readFile("fixtures/engine-v1/png-alpha-edge-camera.json", "utf8"));
    const payload = fixture.assetPayloads[0];
    const asset = fixture.assets.assets[0];
    const reference = fixture.analyticReferences.midpoint;
    expect(payload.assetId).toBe(asset.id);
    expect(payload.encodedBytes).toHaveLength(asset.byteLength);
    expect(sha256(Uint8Array.from(payload.encodedBytes))).toBe(asset.sha256);
    expect(reference.viewport).toEqual({ heightPx: 4, widthPx: 8 });
    expect(reference.rgba).toHaveLength(4 * 8 * 4);
    expect(sha256(Uint8Array.from(reference.rgba))).toBe(
      "bd57ff57b18706b3d25886038a568d3a2904ec3987b365860aa0471bc7119b8b",
    );
    expect(reference.sha256).toBe("bd57ff57b18706b3d25886038a568d3a2904ec3987b365860aa0471bc7119b8b");
    expect(reference.derivation).toContain("Pixel centers");
  });

  it("compares all four sRGB byte channels and uses a strict >8 pixel classification", async () => {
    const corpus = await corpusFixture();
    const expected = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const within = Uint8Array.from([18, 12, 38, 32, 58, 52, 78, 72]);
    const metricsWithin = compareVisualParityFramesV1(
      expected,
      within,
      { heightPx: 1, widthPx: 2 },
      corpus.metricContract,
    );
    expect(metricsWithin.pixelCountAboveThreshold).toBe(0);

    const alphaOutside = Uint8Array.from(within);
    alphaOutside[7] = 71;
    const metricsOutside = compareVisualParityFramesV1(
      expected,
      alphaOutside,
      { heightPx: 1, widthPx: 2 },
      corpus.metricContract,
    );
    expect(metricsOutside.pixelCountAboveThreshold).toBe(1);
    expect(metricsOutside.pixelFractionAboveThreshold).toBe(0.5);
    expect(
      compareVisualParityFramesV1(expected, expected, { heightPx: 1, widthPx: 2 }, corpus.metricContract).ssim,
    ).toBe(1);
  });

  it("encodes stable RGBA PNG bytes and an opaque max-channel diff", () => {
    const expected = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const actual = Uint8Array.from([9, 1, 1, 12, 2, 8, 6, 7]);
    const diff = makeOpaqueVisualParityDiffV1(expected, actual);
    expect([...diff]).toEqual([9, 9, 9, 255, 3, 3, 3, 255]);

    const pngA = encodeRgbaPngV1(expected, 2, 1);
    const pngB = encodeRgbaPngV1(expected, 2, 1);
    expect(pngA).toEqual(pngB);
    expect([...pngA.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const idatLength = Buffer.from(pngA).readUInt32BE(33);
    const scanlines = inflateSync(pngA.subarray(41, 41 + idatLength));
    expect([...scanlines]).toEqual([0, ...expected]);
  });

  it("keeps the report schema strict", () => {
    expect(
      visualParityReportV1Schema.safeParse({
        schema: "poietra.visual-parity-report",
        version: 1,
        silentlyBypass: true,
      }).success,
    ).toBe(false);
  });

  it("rejects internally inconsistent report gates, fractions, and RGBA lengths", async () => {
    const corpus = await corpusFixture();
    const digest = "a".repeat(64);
    const valid = {
      artifacts: { actualPng: "actual.png", diffPng: "diff.png", expectedPng: "expected.png" },
      browser: {
        capturePolicy: "exactly-one-render-submit",
        renderSubmissionCount: 1,
        rgbaByteLength: 8,
        rgbaSha256: digest,
        surfaceFormat: "rgba8unorm",
        viewFormat: "Rgba8UnormSrgb",
      },
      corpus: {
        entryId: "fixture--sample",
        metricSchema: "poietra.visual-parity-metric",
        metricVersion: 1,
        schema: "poietra.visual-parity-corpus",
        version: 1,
      },
      fixture: {
        fixtureId: "fixture",
        fixturePath: "fixtures/example.json",
        fixtureRevision: digest,
        sampleId: "sample",
        sampleTime: 0,
        semanticDigest: digest,
        viewport: { heightPx: 1, widthPx: 2 },
      },
      gate: {
        maximumPixelFractionAboveThreshold: 0.005,
        minimumSsim: 0.995,
        passed: true,
        thresholdException: null,
      },
      metricContract: corpus.metricContract,
      metrics: { pixelCount: 2, pixelCountAboveThreshold: 0, pixelFractionAboveThreshold: 0, ssim: 1 },
      native: {
        adapter: {
          backend: "Vulkan",
          device: 0,
          deviceType: "Cpu",
          driver: "fixture",
          driverInfo: "fixture",
          fallbackRequested: true,
          name: "fixture adapter",
          vendor: 0,
        },
        format: "Rgba8UnormSrgb",
        metadataSha256: digest,
        rgbaByteLength: 8,
        rgbaSha256: digest,
      },
      schema: "poietra.visual-parity-report",
      version: 1,
    };
    expect(visualParityReportV1Schema.safeParse(valid).success).toBe(true);
    expect(visualParityReportV1Schema.safeParse({ ...valid, gate: { ...valid.gate, passed: false } }).success).toBe(
      false,
    );
    expect(
      visualParityReportV1Schema.safeParse({
        ...valid,
        metrics: { ...valid.metrics, pixelFractionAboveThreshold: 0.25 },
      }).success,
    ).toBe(false);
    expect(
      visualParityReportV1Schema.safeParse({
        ...valid,
        browser: { ...valid.browser, rgbaByteLength: 4 },
      }).success,
    ).toBe(false);
  });
});
