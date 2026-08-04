import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";
import { sceneIrBundleV1Schema } from "../src/engine/contracts";
import { sceneIrSourceRevisionHash } from "../src/engine/scene-ir";
import { LINE_JOINTS_CAIRO_PARITY_THRESHOLDS_V1, readLineJointsCairoReferenceV1 } from "./line-joints-cairo-reference";
import { encodeRgbaPngV1 } from "./png-rgba";
import {
  nativeVisualParityArtifactV1Schema,
  thresholdsForEntryV1,
  visualParityCorpusV1Schema,
  visualParityReportV1Schema,
} from "./visual-parity-contract";
import { compareVisualParityFramesV1, makeOpaqueVisualParityDiffV1 } from "./visual-parity-metrics";

type VisualParityFixtureSample = Readonly<{
  expected: Readonly<{ analyticReferenceId?: string; semanticDigest: string }>;
  id: string;
  packetId: string;
  sampleTime: number;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
}>;

type DynamicFixture = Readonly<{
  assetPayloads?: readonly Readonly<{
    assetId: string;
    encodedBytes: readonly number[];
  }>[];
  analyticReferences?: Readonly<
    Record<
      string,
      Readonly<{
        derivation: string;
        rgba: readonly number[];
        sha256: string;
        viewport: Readonly<{ heightPx: number; widthPx: number }>;
      }>
    >
  >;
  assets: Readonly<{
    assets: readonly Readonly<{
      id: string;
      sha256: string;
      [key: string]: unknown;
    }>[];
    [key: string]: unknown;
  }>;
  id: string;
  sample?: VisualParityFixtureSample;
  samples?: readonly VisualParityFixtureSample[];
  scene: Readonly<{
    source: Readonly<{ kind: string; revisionHash?: string; snapshotHash?: string }>;
  }>;
}>;

const REAL_MATHTEX_MORPH_V5_ENTRY_IDS = [
  "real-mathtex-morph-v5--a-initial",
  "real-mathtex-morph-v5--outbound-midpoint",
  "real-mathtex-morph-v5--maxwell-hold",
  "real-mathtex-morph-v5--return-midpoint",
  "real-mathtex-morph-v5--a-restored",
] as const;
const REAL_MATHTEX_MORPH_V5_ENTRY_ID_SET = new Set<string>(REAL_MATHTEX_MORPH_V5_ENTRY_IDS);
const REAL_WARP_SQUARE_V9_ENTRY_IDS = [
  "real-warp-square-v9--source",
  "real-warp-square-v9--quarter",
  "real-warp-square-v9--midpoint",
  "real-warp-square-v9--target",
  "real-warp-square-v9--hold",
] as const;
const REAL_WARP_SQUARE_V9_ENTRY_ID_SET = new Set<string>(REAL_WARP_SQUARE_V9_ENTRY_IDS);
const REAL_LINE_JOINTS_V10_ENTRY_ID = "real-line-joints-v10--static";

const VISUAL_PARITY_CORPUS = visualParityCorpusV1Schema.parse(
  JSON.parse(readFileSync("fixtures/visual-parity-v1/corpus.json", "utf8")),
);

type FullRgbaProofV1 = Readonly<{
  capture: Readonly<{ policy: "exactly-one-render-submit"; renderSubmissionCount: 1 }>;
  kind: "proof";
  pixels: Readonly<{
    surfaceFormat: "bgra8unorm" | "rgba8unorm";
    viewFormat: "Bgra8UnormSrgb" | "Rgba8UnormSrgb";
  }>;
  response: Readonly<{
    result?: Readonly<{
      kind?: string;
      packetId?: string;
      sampleTime?: number;
      viewport?: Readonly<{ heightPx: number; widthPx: number }>;
    }>;
  }>;
  rgba: ArrayBuffer;
}>;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireArtifactRoot() {
  const root = process.env.POIETRA_VISUAL_PARITY_NATIVE_ARTIFACT_DIR;
  if (!root) {
    throw new Error(
      "POIETRA_VISUAL_PARITY_NATIVE_ARTIFACT_DIR is required; generate the native Lavapipe artifact before running this lane.",
    );
  }
  return root;
}

test.beforeAll(async () => {
  const expectedEntryIds = VISUAL_PARITY_CORPUS.entries.map(({ id }) => id).sort();
  const artifactEntryIds = (await readdir(requireArtifactRoot(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(artifactEntryIds, "native artifact directories must exactly match the visual parity corpus").toEqual(
    expectedEntryIds,
  );
});

async function proveVisualParityEntry(page: Page, entryId: string) {
  const corpus = VISUAL_PARITY_CORPUS;
  const entry = corpus.entries.find(({ id }) => id === entryId);
  expect(entry, `the ${entryId} visual parity corpus entry must exist`).toBeDefined();
  if (!entry) throw new Error(`The ${entryId} visual parity corpus entry is missing.`);

  const nativeDirectory = join(requireArtifactRoot(), entry.id);
  const nativeMetadataBytes = new Uint8Array(await readFile(join(nativeDirectory, "metadata.json")));
  const nativeMetadata = nativeVisualParityArtifactV1Schema.parse(
    JSON.parse(new TextDecoder().decode(nativeMetadataBytes)),
  );
  const expectedRgba = new Uint8Array(await readFile(join(nativeDirectory, nativeMetadata.rgba.path)));
  expect(nativeMetadata).toMatchObject({
    corpusEntryId: entry.id,
    fixture: {
      fixtureId: entry.fixture.id,
      fixturePath: entry.fixture.path,
      fixtureRevision: entry.fixture.revision.sha256,
      sampleId: entry.sample.id,
      sampleTime: entry.sample.sampleTime,
      semanticDigest: entry.sample.semanticDigest,
      viewport: entry.sample.viewport,
    },
  });
  expect(expectedRgba.byteLength).toBe(nativeMetadata.rgba.byteLength);
  expect(sha256(expectedRgba)).toBe(nativeMetadata.rgba.sha256);

  const fixture = JSON.parse(await readFile(entry.fixture.path, "utf8")) as DynamicFixture;
  expect(fixture.id).toBe(entry.fixture.id);
  const fixtureBundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
  expect(fixtureBundle.scene.source.kind).toBe(entry.fixture.revision.kind);
  expect(sceneIrSourceRevisionHash(fixtureBundle.scene)).toBe(entry.fixture.revision.sha256);
  if ((fixture.sample === undefined) === (fixture.samples === undefined)) {
    throw new Error(`The ${entry.id} fixture must define exactly one of sample or samples.`);
  }
  const samples = fixture.samples ?? [fixture.sample!];
  const sample = samples.find(({ id }) => id === entry.sample.id);
  expect(sample, "the corpus sample must exist in the shared fixture").toBeDefined();
  if (!sample) throw new Error("The corpus sample is missing from the shared fixture.");
  expect(sample).toMatchObject({
    expected: { semanticDigest: entry.sample.semanticDigest },
    sampleTime: entry.sample.sampleTime,
    viewport: entry.sample.viewport,
  });
  const analyticReference = sample.expected.analyticReferenceId
    ? fixture.analyticReferences?.[sample.expected.analyticReferenceId]
    : undefined;
  if (sample.expected.analyticReferenceId && !analyticReference) {
    throw new Error(`The analytic reference ${sample.expected.analyticReferenceId} is missing.`);
  }

  await page.goto("/");
  const browserProof = await page.evaluate(
    async ({ assetPayloads, assets, fixtureId, sample, scene }) => {
      const worker = new Worker("/e2e/engine-canvas-readback.worker.ts", { type: "module" });
      const proof = new Promise<FullRgbaProofV1>((resolve, reject) => {
        worker.addEventListener(
          "error",
          (event) => reject(new Error(event.message || "The visual parity readback worker crashed.")),
          { once: true },
        );
        worker.addEventListener(
          "message",
          (event: MessageEvent<FullRgbaProofV1 | Readonly<{ kind: "error"; message: string }>>) => {
            if (event.data.kind === "error") reject(new Error(event.data.message));
            else resolve(event.data);
          },
          { once: true },
        );
      });
      const snapshotJson = new TextEncoder().encode(JSON.stringify({ assets, scene })).buffer;
      const metadataById = new Map(assets.assets.map((asset) => [asset.id, asset]));
      const assetMetadata = (assetPayloads ?? []).map(({ assetId }) => {
        const metadata = metadataById.get(assetId);
        if (!metadata) throw new Error(`The parity payload references unknown asset ${assetId}.`);
        return metadata;
      });
      const assetMetadataJson = new TextEncoder().encode(JSON.stringify(assetMetadata)).buffer;
      const assetBytes = (assetPayloads ?? []).map(({ encodedBytes }) => Uint8Array.from(encodedBytes).buffer);
      const requestJson = new TextEncoder().encode(
        JSON.stringify({
          evidence: [fixtureId, sample.id],
          packetId: sample.packetId,
          sampleTime: sample.sampleTime,
          schema: "poietra.engine-sample-request",
          version: 1,
          viewport: sample.viewport,
        }),
      ).buffer;
      worker.postMessage(
        {
          fullRgba: true,
          kind: "prove-frame",
          assetBytes,
          assetMetadataJson,
          requestJson,
          snapshotJson,
          viewport: sample.viewport,
          wasmModuleUrl: new URL("/engine-wasm/poietra_wasm.js", location.href).href,
        },
        [requestJson, snapshotJson, assetMetadataJson, ...assetBytes],
      );
      try {
        const result = await proof;
        return {
          ...result,
          rgba: [...new Uint8Array(result.rgba)],
        };
      } finally {
        worker.terminate();
      }
    },
    {
      assetPayloads: fixture.assetPayloads,
      assets: fixture.assets,
      fixtureId: fixture.id,
      sample,
      scene: fixture.scene,
    },
  );

  expect(browserProof.capture).toEqual({ policy: "exactly-one-render-submit", renderSubmissionCount: 1 });
  expect(browserProof.response.result).toMatchObject({
    kind: "presented",
    packetId: sample.packetId,
    sampleTime: entry.sample.sampleTime,
    viewport: entry.sample.viewport,
  });
  const actualRgba = Uint8Array.from(browserProof.rgba);
  expect(actualRgba.byteLength).toBe(expectedRgba.byteLength);

  const metrics = compareVisualParityFramesV1(expectedRgba, actualRgba, entry.sample.viewport, corpus.metricContract);
  const thresholds = thresholdsForEntryV1(corpus, entry);
  const passed =
    metrics.ssim >= thresholds.minimumSsim &&
    metrics.pixelFractionAboveThreshold <= thresholds.maximumPixelFractionAboveThreshold;
  const outputDirectory = join(
    process.env.POIETRA_VISUAL_PARITY_OUTPUT_DIR ?? "test-results/visual-parity/output",
    entry.id,
  );
  await mkdir(outputDirectory, { recursive: true });
  const { heightPx, widthPx } = entry.sample.viewport;
  const artifactWrites: Promise<void>[] = [
    writeFile(join(outputDirectory, "expected.png"), encodeRgbaPngV1(expectedRgba, widthPx, heightPx)),
    writeFile(join(outputDirectory, "actual.png"), encodeRgbaPngV1(actualRgba, widthPx, heightPx)),
    writeFile(
      join(outputDirectory, "diff.png"),
      encodeRgbaPngV1(makeOpaqueVisualParityDiffV1(expectedRgba, actualRgba), widthPx, heightPx),
    ),
  ];
  if (analyticReference) {
    expect(analyticReference.viewport).toEqual(entry.sample.viewport);
    const referenceRgba = Uint8Array.from(analyticReference.rgba);
    expect(referenceRgba.byteLength).toBe(expectedRgba.byteLength);
    expect(sha256(referenceRgba)).toBe(analyticReference.sha256);
    const nativeReferenceMetrics = compareVisualParityFramesV1(
      referenceRgba,
      expectedRgba,
      entry.sample.viewport,
      corpus.metricContract,
    );
    const browserReferenceMetrics = compareVisualParityFramesV1(
      referenceRgba,
      actualRgba,
      entry.sample.viewport,
      corpus.metricContract,
    );
    for (const [comparison, comparisonMetrics] of [
      ["native/reference", nativeReferenceMetrics],
      ["browser/reference", browserReferenceMetrics],
    ] as const) {
      expect(comparisonMetrics.ssim, `${comparison}: ${analyticReference.derivation}`).toBeGreaterThanOrEqual(
        thresholds.minimumSsim,
      );
      expect(
        comparisonMetrics.pixelFractionAboveThreshold,
        `${comparison}: ${analyticReference.derivation}`,
      ).toBeLessThanOrEqual(thresholds.maximumPixelFractionAboveThreshold);
    }
    artifactWrites.push(
      writeFile(join(outputDirectory, "reference.png"), encodeRgbaPngV1(referenceRgba, widthPx, heightPx)),
      writeFile(
        join(outputDirectory, "native-reference-diff.png"),
        encodeRgbaPngV1(makeOpaqueVisualParityDiffV1(referenceRgba, expectedRgba), widthPx, heightPx),
      ),
      writeFile(
        join(outputDirectory, "browser-reference-diff.png"),
        encodeRgbaPngV1(makeOpaqueVisualParityDiffV1(referenceRgba, actualRgba), widthPx, heightPx),
      ),
    );
  }
  if (entry.id === REAL_LINE_JOINTS_V10_ENTRY_ID) {
    const cairo = await readLineJointsCairoReferenceV1();
    if (fixtureBundle.scene.source.kind !== "imported-manim-server-snapshot") {
      throw new Error("The LineJoints V10 Cairo comparison requires an imported Manim snapshot.");
    }
    expect(cairo.reference.frame.viewport).toEqual(entry.sample.viewport);
    expect(cairo.reference.frame.sampleTime).toBe(0);
    expect(cairo.reference.scene.sourceSha256).toBe(fixtureBundle.scene.source.sourceHash);
    const referenceRgba = cairo.rgba;
    for (const [comparison, comparisonMetrics] of [
      [
        "native/Cairo",
        compareVisualParityFramesV1(referenceRgba, expectedRgba, entry.sample.viewport, corpus.metricContract),
      ],
      [
        "browser/Cairo",
        compareVisualParityFramesV1(referenceRgba, actualRgba, entry.sample.viewport, corpus.metricContract),
      ],
    ] as const) {
      expect(
        comparisonMetrics.ssim,
        `${comparison}: ${LINE_JOINTS_CAIRO_PARITY_THRESHOLDS_V1.reason}`,
      ).toBeGreaterThanOrEqual(LINE_JOINTS_CAIRO_PARITY_THRESHOLDS_V1.minimumSsim);
      expect(
        comparisonMetrics.pixelFractionAboveThreshold,
        `${comparison}: ${LINE_JOINTS_CAIRO_PARITY_THRESHOLDS_V1.reason}`,
      ).toBeLessThanOrEqual(LINE_JOINTS_CAIRO_PARITY_THRESHOLDS_V1.maximumPixelFractionAboveThreshold);
    }
    artifactWrites.push(
      writeFile(join(outputDirectory, "cairo-reference.png"), cairo.png),
      writeFile(
        join(outputDirectory, "native-cairo-diff.png"),
        encodeRgbaPngV1(makeOpaqueVisualParityDiffV1(referenceRgba, expectedRgba), widthPx, heightPx),
      ),
      writeFile(
        join(outputDirectory, "browser-cairo-diff.png"),
        encodeRgbaPngV1(makeOpaqueVisualParityDiffV1(referenceRgba, actualRgba), widthPx, heightPx),
      ),
    );
  }
  await Promise.all(artifactWrites);
  const report = visualParityReportV1Schema.parse({
    artifacts: { actualPng: "actual.png", diffPng: "diff.png", expectedPng: "expected.png" },
    browser: {
      capturePolicy: browserProof.capture.policy,
      renderSubmissionCount: browserProof.capture.renderSubmissionCount,
      rgbaByteLength: actualRgba.byteLength,
      rgbaSha256: sha256(actualRgba),
      surfaceFormat: browserProof.pixels.surfaceFormat,
      viewFormat: browserProof.pixels.viewFormat,
    },
    corpus: {
      entryId: entry.id,
      metricSchema: corpus.metricContract.schema,
      metricVersion: corpus.metricContract.version,
      schema: corpus.schema,
      version: corpus.version,
    },
    fixture: nativeMetadata.fixture,
    gate: {
      ...thresholds,
      passed,
      thresholdException: entry.thresholdException,
    },
    metricContract: corpus.metricContract,
    metrics,
    native: {
      adapter: nativeMetadata.adapter,
      format: nativeMetadata.target.format,
      metadataSha256: sha256(nativeMetadataBytes),
      rgbaByteLength: expectedRgba.byteLength,
      rgbaSha256: nativeMetadata.rgba.sha256,
    },
    schema: "poietra.visual-parity-report",
    version: 1,
  });
  await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  expect(metrics.ssim, `visual parity report: ${join(outputDirectory, "report.json")}`).toBeGreaterThanOrEqual(
    thresholds.minimumSsim,
  );
  expect(
    metrics.pixelFractionAboveThreshold,
    `visual parity report: ${join(outputDirectory, "report.json")}`,
  ).toBeLessThanOrEqual(thresholds.maximumPixelFractionAboveThreshold);

  return { actualRgba, expectedRgba };
}

function rgbaBytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function expectRealMathTexMorphRelations(
  frames: ReadonlyMap<string, Awaited<ReturnType<typeof proveVisualParityEntry>>>,
) {
  function requireFrame(entryId: (typeof REAL_MATHTEX_MORPH_V5_ENTRY_IDS)[number]) {
    const frame = frames.get(entryId);
    if (!frame) throw new Error(`The real MathTex morph proof is missing ${entryId}.`);
    return frame;
  }

  const initial = requireFrame("real-mathtex-morph-v5--a-initial");
  const outbound = requireFrame("real-mathtex-morph-v5--outbound-midpoint");
  const maxwell = requireFrame("real-mathtex-morph-v5--maxwell-hold");
  const returning = requireFrame("real-mathtex-morph-v5--return-midpoint");
  const restored = requireFrame("real-mathtex-morph-v5--a-restored");
  for (const rgbaKind of ["expectedRgba", "actualRgba"] as const) {
    const label = rgbaKind === "expectedRgba" ? "native" : "browser";
    expect(rgbaBytesEqual(initial[rgbaKind], restored[rgbaKind]), `${label}: restored A must equal initial A`).toBe(
      true,
    );
    expect(rgbaBytesEqual(initial[rgbaKind], maxwell[rgbaKind]), `${label}: Maxwell B must differ from A`).toBe(false);
    expect(
      rgbaBytesEqual(outbound[rgbaKind], initial[rgbaKind]),
      `${label}: outbound midpoint must differ from initial A`,
    ).toBe(false);
    expect(
      rgbaBytesEqual(outbound[rgbaKind], maxwell[rgbaKind]),
      `${label}: outbound midpoint must differ from Maxwell B`,
    ).toBe(false);
    expect(
      rgbaBytesEqual(returning[rgbaKind], maxwell[rgbaKind]),
      `${label}: return midpoint must differ from Maxwell B`,
    ).toBe(false);
    expect(
      rgbaBytesEqual(returning[rgbaKind], restored[rgbaKind]),
      `${label}: return midpoint must differ from restored A`,
    ).toBe(false);
  }
}

function expectRealWarpSquareRelations(
  frames: ReadonlyMap<string, Awaited<ReturnType<typeof proveVisualParityEntry>>>,
) {
  function requireFrame(entryId: (typeof REAL_WARP_SQUARE_V9_ENTRY_IDS)[number]) {
    const frame = frames.get(entryId);
    if (!frame) throw new Error(`The real WarpSquare proof is missing ${entryId}.`);
    return frame;
  }

  const source = requireFrame("real-warp-square-v9--source");
  const quarter = requireFrame("real-warp-square-v9--quarter");
  const midpoint = requireFrame("real-warp-square-v9--midpoint");
  const target = requireFrame("real-warp-square-v9--target");
  const hold = requireFrame("real-warp-square-v9--hold");
  for (const rgbaKind of ["expectedRgba", "actualRgba"] as const) {
    const label = rgbaKind === "expectedRgba" ? "native" : "browser";
    expect(rgbaBytesEqual(source[rgbaKind], quarter[rgbaKind]), `${label}: quarter must differ from source`).toBe(
      false,
    );
    expect(rgbaBytesEqual(quarter[rgbaKind], midpoint[rgbaKind]), `${label}: midpoint must differ from quarter`).toBe(
      false,
    );
    expect(rgbaBytesEqual(midpoint[rgbaKind], target[rgbaKind]), `${label}: target must differ from midpoint`).toBe(
      false,
    );
    expect(rgbaBytesEqual(target[rgbaKind], hold[rgbaKind]), `${label}: hold must equal target`).toBe(true);
  }
}

for (const entry of VISUAL_PARITY_CORPUS.entries.filter(
  ({ id }) => !REAL_MATHTEX_MORPH_V5_ENTRY_ID_SET.has(id) && !REAL_WARP_SQUARE_V9_ENTRY_ID_SET.has(id),
)) {
  test(`matches native full-RGBA for ${entry.id}`, async ({ page }) => {
    await proveVisualParityEntry(page, entry.id);
  });
}

test("matches native full-RGBA across the real MathTex morph V5 timeline", async ({ page }, testInfo) => {
  testInfo.setTimeout(120_000);
  const frames = new Map<string, Awaited<ReturnType<typeof proveVisualParityEntry>>>();
  for (const entryId of REAL_MATHTEX_MORPH_V5_ENTRY_IDS) {
    frames.set(entryId, await proveVisualParityEntry(page, entryId));
  }
  expectRealMathTexMorphRelations(frames);
});

test("matches native full-RGBA across the real WarpSquare V9 timeline", async ({ page }, testInfo) => {
  testInfo.setTimeout(120_000);
  const frames = new Map<string, Awaited<ReturnType<typeof proveVisualParityEntry>>>();
  for (const entryId of REAL_WARP_SQUARE_V9_ENTRY_IDS) {
    frames.set(entryId, await proveVisualParityEntry(page, entryId));
  }
  expectRealWarpSquareRelations(frames);
});
