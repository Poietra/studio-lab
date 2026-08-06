import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { encodeRgbaPngV1 } from "./png-rgba";
import { readUpdatersCairoReferenceV1, UPDATERS_CAIRO_REFERENCE_SAMPLES_V1 } from "./updaters-cairo-reference";
import { visualParityCorpusV1Schema } from "./visual-parity-contract";
import { compareVisualParityFramesV1, makeOpaqueVisualParityDiffV1 } from "./visual-parity-metrics";

type UpdatersSampleIdV1 = (typeof UPDATERS_CAIRO_REFERENCE_SAMPLES_V1)[number][0];

export type UpdatersWebGpuFrameV1 = Readonly<{
  frameIndex: number;
  id: UpdatersSampleIdV1;
  rgba: Uint8Array;
  sampleTime: number;
}>;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function compareUpdatersCairoWebGpuFramesV1(
  input: Readonly<{
    cairoReferenceRoot: string;
    expectedSourceSha256: string;
    frames: readonly UpdatersWebGpuFrameV1[];
    outputRoot: string;
  }>,
) {
  const [cairo, corpus] = await Promise.all([
    readUpdatersCairoReferenceV1(input.cairoReferenceRoot, input.expectedSourceSha256),
    readFile("fixtures/visual-parity-v1/corpus.json", "utf8").then((text) =>
      visualParityCorpusV1Schema.parse(JSON.parse(text)),
    ),
  ]);
  const actualById = new Map(input.frames.map((frame) => [frame.id, frame]));
  if (actualById.size !== UPDATERS_CAIRO_REFERENCE_SAMPLES_V1.length || actualById.size !== input.frames.length) {
    throw new Error("UpdatersExample parity requires exactly one WebGPU capture for each of the seven Cairo samples.");
  }

  const comparisons = [];
  for (const [id, capturedFrameIndex, requestSampleTime] of UPDATERS_CAIRO_REFERENCE_SAMPLES_V1) {
    const expected = cairo.frames.get(id);
    const actual = actualById.get(id);
    if (!expected || !actual) throw new Error(`UpdatersExample parity is missing the ${id} sample.`);
    if (
      expected.capturedFrameIndex !== capturedFrameIndex ||
      expected.requestSampleTime !== requestSampleTime ||
      actual.frameIndex !== capturedFrameIndex ||
      actual.sampleTime !== requestSampleTime
    ) {
      throw new Error(`UpdatersExample parity sample ${id} does not match its sealed frame/time identity.`);
    }

    const metrics = compareVisualParityFramesV1(
      expected.rgba,
      actual.rgba,
      cairo.reference.frame.viewport,
      corpus.metricContract,
    );
    const passed =
      metrics.ssim >= corpus.defaultThresholds.minimumSsim &&
      metrics.pixelFractionAboveThreshold <= corpus.defaultThresholds.maximumPixelFractionAboveThreshold;
    const outputDirectory = join(input.outputRoot, id);
    await mkdir(outputDirectory, { recursive: true });
    const { heightPx, widthPx } = cairo.reference.frame.viewport;
    const report = {
      artifacts: { actualPng: "actual.png", diffPng: "diff.png", expectedPng: "expected.png" },
      frame: { capturedFrameIndex, id, requestSampleTime },
      gate: { ...corpus.defaultThresholds, passed },
      metricContract: corpus.metricContract,
      metrics,
      rgba: { actualSha256: sha256(actual.rgba), expectedSha256: sha256(expected.rgba) },
      schema: "poietra.updaters-cairo-parity-report",
      version: 1,
      viewport: cairo.reference.frame.viewport,
    } as const;
    await Promise.all([
      writeFile(join(outputDirectory, "expected.png"), encodeRgbaPngV1(expected.rgba, widthPx, heightPx)),
      writeFile(join(outputDirectory, "actual.png"), encodeRgbaPngV1(actual.rgba, widthPx, heightPx)),
      writeFile(
        join(outputDirectory, "diff.png"),
        encodeRgbaPngV1(makeOpaqueVisualParityDiffV1(expected.rgba, actual.rgba), widthPx, heightPx),
      ),
      writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    ]);
    comparisons.push({ id, metrics, passed });
  }
  return comparisons;
}
