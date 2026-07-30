import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";
import { encodeRgbaPngV1 } from "./png-rgba";
import {
  nativeVisualParityArtifactV1Schema,
  thresholdsForEntryV1,
  visualParityCorpusV1Schema,
  visualParityReportV1Schema,
} from "./visual-parity-contract";
import { compareVisualParityFramesV1, makeOpaqueVisualParityDiffV1 } from "./visual-parity-metrics";

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
  samples: readonly Readonly<{
    expected: Readonly<{ analyticReferenceId?: string; semanticDigest: string }>;
    id: string;
    packetId: string;
    sampleTime: number;
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>[];
  scene: Readonly<{
    source: Readonly<{ kind: string; revisionHash?: string }>;
  }>;
}>;

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

async function proveVisualParityEntry(page: Page, entryId: string) {
  const corpus = visualParityCorpusV1Schema.parse(
    JSON.parse(await readFile("fixtures/visual-parity-v1/corpus.json", "utf8")),
  );
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
  expect(fixture.scene.source).toEqual(
    expect.objectContaining({ kind: entry.fixture.revision.kind, revisionHash: entry.fixture.revision.sha256 }),
  );
  const sample = fixture.samples.find(({ id }) => id === entry.sample.id);
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
}

test("matches native Lavapipe for dynamic-affine-camera/a-first", async ({ page }) => {
  await proveVisualParityEntry(page, "dynamic-affine-camera--a-first");
});

test("matches native and analytic reference for PNG alpha-edge/camera midpoint", async ({ page }) => {
  await proveVisualParityEntry(page, "png-alpha-edge-camera--midpoint");
});
