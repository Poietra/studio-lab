import type { VisualParityMetricContractV1 } from "./visual-parity-contract";

export type VisualParityMetricsV1 = Readonly<{
  pixelCount: number;
  pixelCountAboveThreshold: number;
  pixelFractionAboveThreshold: number;
  ssim: number;
}>;

function assertFrameLength(bytes: Uint8Array, widthPx: number, heightPx: number, label: string) {
  const expected = widthPx * heightPx * 4;
  if (!Number.isSafeInteger(expected) || bytes.byteLength !== expected) {
    throw new Error(`${label} RGBA has ${bytes.byteLength} bytes; expected ${expected} for ${widthPx}x${heightPx}.`);
  }
}

function windowChannelSsim(
  expected: Uint8Array,
  actual: Uint8Array,
  widthPx: number,
  channel: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  c1: number,
  c2: number,
) {
  const count = (right - left) * (bottom - top);
  let expectedSum = 0;
  let actualSum = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * widthPx + x) * 4 + channel;
      expectedSum += expected[offset] ?? 0;
      actualSum += actual[offset] ?? 0;
    }
  }
  const expectedMean = expectedSum / count;
  const actualMean = actualSum / count;
  let expectedVariance = 0;
  let actualVariance = 0;
  let covariance = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * widthPx + x) * 4 + channel;
      const expectedDelta = (expected[offset] ?? 0) - expectedMean;
      const actualDelta = (actual[offset] ?? 0) - actualMean;
      expectedVariance += expectedDelta * expectedDelta;
      actualVariance += actualDelta * actualDelta;
      covariance += expectedDelta * actualDelta;
    }
  }
  expectedVariance /= count;
  actualVariance /= count;
  covariance /= count;
  return (
    ((2 * expectedMean * actualMean + c1) * (2 * covariance + c2)) /
    ((expectedMean * expectedMean + actualMean * actualMean + c1) * (expectedVariance + actualVariance + c2))
  );
}

export function compareVisualParityFramesV1(
  expected: Uint8Array,
  actual: Uint8Array,
  viewport: Readonly<{ heightPx: number; widthPx: number }>,
  contract: VisualParityMetricContractV1,
): VisualParityMetricsV1 {
  assertFrameLength(expected, viewport.widthPx, viewport.heightPx, "Expected");
  assertFrameLength(actual, viewport.widthPx, viewport.heightPx, "Actual");
  const pixelCount = viewport.widthPx * viewport.heightPx;
  const differenceThreshold = contract.pixelDifference.thresholdU8;
  let pixelCountAboveThreshold = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    let above = false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs((expected[offset + channel] ?? 0) - (actual[offset + channel] ?? 0)) > differenceThreshold) {
        above = true;
      }
    }
    if (above) pixelCountAboveThreshold += 1;
  }

  const { dynamicRange, k1, k2 } = contract.ssim.constants;
  const c1 = (k1 * dynamicRange) ** 2;
  const c2 = (k2 * dynamicRange) ** 2;
  const { heightPx: windowHeight, stridePx, widthPx: windowWidth } = contract.ssim.window;
  let ssimSum = 0;
  let ssimSamples = 0;
  for (let top = 0; top < viewport.heightPx; top += stridePx) {
    for (let left = 0; left < viewport.widthPx; left += stridePx) {
      const bottom = Math.min(top + windowHeight, viewport.heightPx);
      const right = Math.min(left + windowWidth, viewport.widthPx);
      for (let channel = 0; channel < 4; channel += 1) {
        ssimSum += windowChannelSsim(expected, actual, viewport.widthPx, channel, left, top, right, bottom, c1, c2);
        ssimSamples += 1;
      }
    }
  }

  return {
    pixelCount,
    pixelCountAboveThreshold,
    pixelFractionAboveThreshold: pixelCountAboveThreshold / pixelCount,
    ssim: ssimSum / ssimSamples,
  };
}

export function makeOpaqueVisualParityDiffV1(expected: Uint8Array, actual: Uint8Array): Uint8Array {
  if (expected.byteLength !== actual.byteLength || expected.byteLength % 4 !== 0) {
    throw new Error("Expected and actual RGBA frames must have the same complete-pixel byte length.");
  }
  const diff = new Uint8Array(expected.byteLength);
  for (let offset = 0; offset < expected.byteLength; offset += 4) {
    let maximum = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      maximum = Math.max(maximum, Math.abs((expected[offset + channel] ?? 0) - (actual[offset + channel] ?? 0)));
    }
    diff[offset] = maximum;
    diff[offset + 1] = maximum;
    diff[offset + 2] = maximum;
    diff[offset + 3] = 255;
  }
  return diff;
}
