import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { expect, test } from "@playwright/test";
import { sceneIrBundleV1Schema } from "../src/engine/contracts";
import {
  FOURIER_V3_CAIRO_FRAME_INDICES_V1,
  FOURIER_V3_CAIRO_PARITY_THRESHOLDS_V1,
  readFourierV3CairoReferenceV1,
} from "./fourier-v3-cairo-reference";
import {
  captureRuntimeTraceWebGpuFramesV1,
  RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  type RuntimeTraceWebGpuReadbackSampleV1,
} from "./runtime-trace-webgpu-readback";
import { visualParityCorpusV1Schema } from "./visual-parity-contract";
import { compareVisualParityFramesV1 } from "./visual-parity-metrics";

const BUNDLE_PATH = "fixtures/fourier-v3-runtime-trace-bundle-v1.json.gz";
const bundle = sceneIrBundleV1Schema.parse(JSON.parse(gunzipSync(readFileSync(BUNDLE_PATH)).toString("utf8")));
const corpus = visualParityCorpusV1Schema.parse(
  JSON.parse(readFileSync("fixtures/visual-parity-v1/corpus.json", "utf8")),
);

function sample(frameIndex: number, id: string): RuntimeTraceWebGpuReadbackSampleV1 {
  return {
    frameIndex,
    id,
    packetId: `fourier-v3-cairo-parity:${id}`,
    sampleTime: frameIndex / 60,
  };
}

const SAMPLES = [
  ...FOURIER_V3_CAIRO_FRAME_INDICES_V1.map((frameIndex) => sample(frameIndex, `frame-${frameIndex}`)),
  sample(300, "frame-300-repeat"),
] as const;

test("keeps FourierSeriesSquareWave V3 within the independent Cairo gate", async ({ page }) => {
  test.setTimeout(120_000);
  expect(bundle.scene).toMatchObject({
    duration: 14.5,
    source: {
      kind: "imported-manim-runtime-trace",
      sourceHash: "3071f55153631e1b74df945fb0ebf57a56372bc0cb58498c58a01fcdf31fbd72",
      traceVersion: 3,
    },
  });
  if (bundle.scene.source.kind !== "imported-manim-runtime-trace") {
    throw new Error("The Fourier parity fixture is not a Runtime Trace bundle.");
  }

  await page.goto("/");
  const [capture, cairo] = await Promise.all([
    captureRuntimeTraceWebGpuFramesV1(page, {
      bundle,
      revision: bundle.scene.source.traceDigest,
      samples: SAMPLES,
      viewport: RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
    }),
    readFourierV3CairoReferenceV1(),
  ]);
  expect(capture.capture).toEqual({
    installCount: 1,
    policy: "one-retained-engine",
    renderSubmissionCounts: SAMPLES.map(() => 1),
  });

  const comparisons = capture.frames.slice(0, FOURIER_V3_CAIRO_FRAME_INDICES_V1.length).map((frame) => {
    const expected = cairo.frames.get(frame.frameIndex);
    if (!expected) throw new Error(`Missing independent Cairo frame ${frame.frameIndex}.`);
    expect(frame.frameSampleTime).toBe(expected.sampleTime);
    return {
      frameIndex: frame.frameIndex,
      ...compareVisualParityFramesV1(
        expected.rgba,
        frame.rgba,
        RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
        corpus.metricContract,
      ),
    };
  });
  const failures = comparisons.filter(
    ({ pixelFractionAboveThreshold, ssim }) =>
      ssim < FOURIER_V3_CAIRO_PARITY_THRESHOLDS_V1.minimumSsim ||
      pixelFractionAboveThreshold > FOURIER_V3_CAIRO_PARITY_THRESHOLDS_V1.maximumPixelFractionAboveThreshold,
  );
  expect(failures, JSON.stringify(comparisons, null, 2)).toEqual([]);

  const firstFrame300 = capture.frames.find(({ id }) => id === "frame-300");
  const repeatedFrame300 = capture.frames.find(({ id }) => id === "frame-300-repeat");
  expect(repeatedFrame300?.sha256).toBe(firstFrame300?.sha256);
  expect(repeatedFrame300?.rgba).toEqual(firstFrame300?.rgba);
});
