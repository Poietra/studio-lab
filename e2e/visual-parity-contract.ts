import { z } from "zod";

const strictObject = z.strictObject;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const positiveDimension = z.number().int().positive().max(16_384);

export const visualParityViewportV1Schema = strictObject({
  heightPx: positiveDimension,
  widthPx: positiveDimension,
});

const thresholdsSchema = strictObject({
  maximumPixelFractionAboveThreshold: z.number().min(0).max(1),
  minimumSsim: z.number().min(-1).max(1),
});

export const visualParityMetricContractV1Schema = strictObject({
  alpha: z.literal("stored-premultiplied-rgba-four-channels-equal-weight"),
  colorDomain: z.literal("srgb-u8"),
  diffImage: z.literal("max-absolute-rgba-grayscale-opaque"),
  pixelDifference: strictObject({
    classification: z.literal("any-rgba-channel-strictly-greater"),
    thresholdU8: z.literal(8),
  }),
  schema: z.literal("poietra.visual-parity-metric"),
  ssim: strictObject({
    aggregation: z.literal("unweighted-arithmetic-mean-of-window-channel-scores"),
    channels: z.tuple([z.literal("red"), z.literal("green"), z.literal("blue"), z.literal("alpha")]),
    constants: strictObject({
      dynamicRange: z.literal(255),
      k1: z.literal(0.01),
      k2: z.literal(0.03),
    }),
    variance: z.literal("population"),
    window: strictObject({
      edge: z.literal("clip"),
      edgeWindowWeight: z.literal("equal"),
      heightPx: z.literal(8),
      kind: z.literal("uniform"),
      stridePx: z.literal(8),
      widthPx: z.literal(8),
    }),
  }),
  version: z.literal(1),
});

const corpusEntrySchema = strictObject({
  fixture: strictObject({
    id: z.string().min(1).max(200),
    path: z.string().regex(/^fixtures\/[a-zA-Z0-9._/-]+\.json$/),
    revision: strictObject({
      kind: z.enum(["imported-manim-server-snapshot", "studio-edit-program"]),
      sha256,
    }),
  }),
  id: z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?--[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/),
  sample: strictObject({
    id: z.string().min(1).max(200),
    sampleTime: z.number().finite().nonnegative(),
    semanticDigest: sha256,
    viewport: visualParityViewportV1Schema,
  }),
  thresholdException: z.union([
    z.null(),
    strictObject({
      reason: z.string().trim().min(1).max(1_000),
      thresholdOverride: thresholdsSchema,
    }),
  ]),
});

export const visualParityCorpusV1Schema = strictObject({
  defaultThresholds: strictObject({
    maximumPixelFractionAboveThreshold: z.literal(0.005),
    minimumSsim: z.literal(0.995),
  }),
  entries: z
    .array(corpusEntrySchema)
    .min(1)
    .superRefine((entries, context) => {
      const ids = new Set<string>();
      for (const [index, entry] of entries.entries()) {
        if (ids.has(entry.id)) {
          context.addIssue({ code: "custom", message: `duplicate corpus entry id ${entry.id}`, path: [index, "id"] });
        }
        ids.add(entry.id);
      }
    }),
  metricContract: visualParityMetricContractV1Schema,
  schema: z.literal("poietra.visual-parity-corpus"),
  version: z.literal(1),
});

const fixtureIdentitySchema = strictObject({
  fixtureId: z.string().min(1),
  fixturePath: z.string().min(1),
  fixtureRevision: sha256,
  sampleId: z.string().min(1),
  sampleTime: z.number().finite().nonnegative(),
  semanticDigest: sha256,
  viewport: visualParityViewportV1Schema,
});

export const nativeVisualParityArtifactV1Schema = strictObject({
  adapter: strictObject({
    backend: z.string().min(1),
    device: z.number().int().nonnegative(),
    deviceType: z.string().min(1),
    driver: z.string(),
    driverInfo: z.string(),
    fallbackRequested: z.literal(true),
    name: z.string().min(1),
    vendor: z.number().int().nonnegative(),
  }),
  capture: strictObject({
    policy: z.literal("final-readback-submit-after-render-return"),
  }),
  corpusEntryId: z.string().min(1),
  fixture: fixtureIdentitySchema,
  rgba: strictObject({
    byteLength: z.number().int().positive(),
    channelOrder: z.literal("rgba"),
    path: z.literal("expected.rgba"),
    rowOrder: z.literal("top-to-bottom"),
    rowStrideBytes: z.number().int().positive(),
    sha256,
  }),
  schema: z.literal("poietra.visual-parity-native-artifact"),
  target: strictObject({
    colorDomain: z.literal("srgb-u8"),
    format: z.enum(["Rgba8Unorm", "Rgba8UnormSrgb"]),
  }),
  version: z.literal(1),
});

export const visualParityReportV1Schema = strictObject({
  artifacts: strictObject({
    actualPng: z.literal("actual.png"),
    diffPng: z.literal("diff.png"),
    expectedPng: z.literal("expected.png"),
  }),
  browser: strictObject({
    capturePolicy: z.literal("exactly-one-render-submit"),
    renderSubmissionCount: z.literal(1),
    rgbaByteLength: z.number().int().positive(),
    rgbaSha256: sha256,
    surfaceFormat: z.enum(["bgra8unorm", "rgba8unorm"]),
    viewFormat: z.enum(["Bgra8Unorm", "Bgra8UnormSrgb", "Rgba8Unorm", "Rgba8UnormSrgb"]),
  }),
  corpus: strictObject({
    entryId: z.string().min(1),
    metricSchema: z.literal("poietra.visual-parity-metric"),
    metricVersion: z.literal(1),
    schema: z.literal("poietra.visual-parity-corpus"),
    version: z.literal(1),
  }),
  fixture: fixtureIdentitySchema,
  gate: strictObject({
    maximumPixelFractionAboveThreshold: z.number().min(0).max(1),
    minimumSsim: z.number().min(-1).max(1),
    passed: z.boolean(),
    thresholdException: z.union([
      z.null(),
      strictObject({
        reason: z.string().trim().min(1),
        thresholdOverride: thresholdsSchema,
      }),
    ]),
  }),
  metricContract: visualParityMetricContractV1Schema,
  metrics: strictObject({
    pixelCount: z.number().int().positive(),
    pixelCountAboveThreshold: z.number().int().nonnegative(),
    pixelFractionAboveThreshold: z.number().min(0).max(1),
    ssim: z.number().min(-1).max(1),
  }),
  native: strictObject({
    adapter: nativeVisualParityArtifactV1Schema.shape.adapter,
    format: z.enum(["Rgba8Unorm", "Rgba8UnormSrgb"]),
    metadataSha256: sha256,
    rgbaByteLength: z.number().int().positive(),
    rgbaSha256: sha256,
  }),
  schema: z.literal("poietra.visual-parity-report"),
  version: z.literal(1),
}).superRefine((report, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", message, path });
  const expectedPixelCount = report.fixture.viewport.widthPx * report.fixture.viewport.heightPx;
  const expectedByteLength = expectedPixelCount * 4;
  if (report.metrics.pixelCount !== expectedPixelCount) {
    issue(["metrics", "pixelCount"], "pixelCount must equal the fixture viewport area");
  }
  if (report.metrics.pixelCountAboveThreshold > report.metrics.pixelCount) {
    issue(["metrics", "pixelCountAboveThreshold"], "pixelCountAboveThreshold cannot exceed pixelCount");
  }
  const nativeUsesSrgbView = report.native.format.endsWith("Srgb");
  const browserUsesSrgbView = report.browser.viewFormat.endsWith("Srgb");
  if (nativeUsesSrgbView !== browserUsesSrgbView) {
    issue(["browser", "viewFormat"], "browser and native artifacts must use the same compositing view class");
  }
  const expectedFraction = report.metrics.pixelCountAboveThreshold / report.metrics.pixelCount;
  if (Math.abs(report.metrics.pixelFractionAboveThreshold - expectedFraction) > Number.EPSILON) {
    issue(
      ["metrics", "pixelFractionAboveThreshold"],
      "pixelFractionAboveThreshold must equal pixelCountAboveThreshold / pixelCount",
    );
  }
  if (report.native.rgbaByteLength !== expectedByteLength) {
    issue(["native", "rgbaByteLength"], "native RGBA byte length must equal viewport pixels times four");
  }
  if (report.browser.rgbaByteLength !== expectedByteLength) {
    issue(["browser", "rgbaByteLength"], "browser RGBA byte length must equal viewport pixels times four");
  }
  const resolvedThresholds = report.gate.thresholdException?.thresholdOverride ?? {
    maximumPixelFractionAboveThreshold: 0.005,
    minimumSsim: 0.995,
  };
  if (report.gate.maximumPixelFractionAboveThreshold !== resolvedThresholds.maximumPixelFractionAboveThreshold) {
    issue(["gate", "maximumPixelFractionAboveThreshold"], "gate must use the default or explicit exception threshold");
  }
  if (report.gate.minimumSsim !== resolvedThresholds.minimumSsim) {
    issue(["gate", "minimumSsim"], "gate must use the default or explicit exception threshold");
  }
  const expectedPass =
    report.metrics.ssim >= resolvedThresholds.minimumSsim &&
    report.metrics.pixelFractionAboveThreshold <= resolvedThresholds.maximumPixelFractionAboveThreshold;
  if (report.gate.passed !== expectedPass) {
    issue(["gate", "passed"], "passed must be derived from the reported metrics and resolved thresholds");
  }
});

export type NativeVisualParityArtifactV1 = z.infer<typeof nativeVisualParityArtifactV1Schema>;
export type VisualParityCorpusV1 = z.infer<typeof visualParityCorpusV1Schema>;
export type VisualParityMetricContractV1 = z.infer<typeof visualParityMetricContractV1Schema>;
export type VisualParityReportV1 = z.infer<typeof visualParityReportV1Schema>;

export function thresholdsForEntryV1(corpus: VisualParityCorpusV1, entry: VisualParityCorpusV1["entries"][number]) {
  return entry.thresholdException?.thresholdOverride ?? corpus.defaultThresholds;
}
