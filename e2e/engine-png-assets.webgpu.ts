import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import {
  type AssetManifestV1,
  assetManifestV1Schema,
  digestAssetManifestV1,
  type PngAssetV1,
} from "../src/engine/asset-manifest";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "../src/engine/contracts";
import { encodeRgbaPngV1 } from "./png-rgba";

const BASE_REVISION = "a".repeat(64);
const REUSED_REVISION = "b".repeat(64);
const REPLACEMENT_REVISION = "c".repeat(64);
const STALE_REVISION = "d".repeat(64);
const HASH_MISMATCH_REVISION = "e".repeat(64);
const DIMENSION_MISMATCH_REVISION = "f".repeat(64);
const VIEWPORT = { heightPx: 90, widthPx: 160 } as const;

type EncodedPngScene = Readonly<{
  bundle: SceneIrBundleV1;
  bytes: readonly number[];
}>;

type PngMetadataOverrides = Readonly<{
  pixelHeight?: number;
  pixelWidth?: number;
  sha256?: string;
}>;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pngScene(
  base: SceneIrBundleV1,
  bytes: Uint8Array,
  revision: string,
  overrides: PngMetadataOverrides = {},
): Promise<EncodedPngScene> {
  const asset: PngAssetV1 = {
    alphaMode: "straight",
    byteLength: bytes.byteLength,
    colorSpace: "srgb",
    id: "asset:image",
    kind: "png-image",
    mediaType: "image/png",
    pixelHeight: overrides.pixelHeight ?? 2,
    pixelWidth: overrides.pixelWidth ?? 2,
    sha256: overrides.sha256 ?? sha256(bytes),
  };
  const draft = assetManifestV1Schema.parse({
    assets: [asset],
    manifestDigest: "0".repeat(64),
    manifestId: "manifest:image",
    schema: "poietra.asset-manifest",
    version: 1,
  } satisfies AssetManifestV1);
  const assets = assetManifestV1Schema.parse({
    ...draft,
    manifestDigest: await digestAssetManifestV1(draft),
  });
  const bundle = sceneIrBundleV1Schema.parse({
    assets,
    scene: {
      ...base.scene,
      animationChannels: [],
      assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
      entities: [
        {
          appearance: { kind: "image", opacity: 1 },
          geometry: {
            asset: { assetId: asset.id, sha256: asset.sha256 },
            kind: "image",
            localRect: { bottom: -4.5, left: -8, right: 8, top: 4.5 },
            sampler: "nearest",
          },
          id: "image",
          lifetimes: [{ end: base.scene.duration, start: 0 }],
          parentId: null,
          provenanceId: base.scene.provenance[0]?.id ?? "fixture",
          sceneOrder: 0,
          sourceZIndex: 0,
          transform: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
        },
      ],
      requiredCapabilities: ["png-image"],
      source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: revision },
    },
  });
  return { bundle, bytes: [...bytes] };
}

function translatedRevisionBundle(input: EncodedPngScene, revision: string): EncodedPngScene {
  if (input.bundle.scene.source.kind !== "studio-edit-program") {
    throw new Error("The image fixture must remain Studio-owned.");
  }
  return {
    bundle: sceneIrBundleV1Schema.parse({
      assets: input.bundle.assets,
      scene: {
        ...input.bundle.scene,
        entities: input.bundle.scene.entities.map((entity) => ({
          ...entity,
          transform: { ...entity.transform, tx: 4 },
        })),
        source: { ...input.bundle.scene.source, revisionHash: revision },
      },
    }),
    bytes: input.bytes,
  };
}

function rgbaPng(pixels: readonly number[]) {
  return encodeRgbaPngV1(Uint8Array.from(pixels), 2, 2);
}

function expectPixels(actual: readonly (readonly number[])[], expected: readonly (readonly number[])[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((pixel, pixelIndex) => {
    pixel.forEach((component, componentIndex) => {
      expect(Math.abs(component - (expected[pixelIndex]?.[componentIndex] ?? -1))).toBeLessThanOrEqual(3);
    });
  });
}

test("installs, retries, and reuses verified PNGs through the real Worker/WASM image path", {
  tag: "@ci-main",
}, async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Readonly<{
    assets: unknown;
    scene: unknown;
  }>;
  const base = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
  const initial = await pngScene(
    base,
    rgbaPng([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    BASE_REVISION,
  );
  const reused = translatedRevisionBundle(initial, REUSED_REVISION);
  const replacement = await pngScene(
    base,
    rgbaPng([0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 0, 255, 0, 0, 0, 255]),
    REPLACEMENT_REVISION,
  );
  const stale = await pngScene(
    base,
    rgbaPng([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]),
    STALE_REVISION,
  );
  const hashMismatch = await pngScene(
    base,
    rgbaPng([20, 30, 40, 255, 50, 60, 70, 255, 80, 90, 100, 255, 110, 120, 130, 255]),
    HASH_MISMATCH_REVISION,
    { sha256: "9".repeat(64) },
  );
  const dimensionMismatch = await pngScene(
    base,
    rgbaPng([30, 40, 50, 255, 60, 70, 80, 255, 90, 100, 110, 255, 120, 130, 140, 255]),
    DIMENSION_MISMATCH_REVISION,
    { pixelWidth: 3 },
  );

  await page.goto("/");
  const result = await page.evaluate(
    async ({ dimensionMismatch, hashMismatch, initial, replacement, reused, revisions, stale, viewport }) => {
      const clientModuleUrl = "/src/engine/canvas-worker-client.ts";
      const evidenceModuleUrl = "/src/engine/canvas-worker-evidence.ts";
      const { CanvasWorkerClientError, PoietraCanvasWorkerClient } = (await import(
        clientModuleUrl
      )) as typeof import("../src/engine/canvas-worker-client");
      const { createCanvasWorkerClientEvidenceAdapterV1 } = (await import(
        evidenceModuleUrl
      )) as typeof import("../src/engine/canvas-worker-evidence");

      type BrowserScene = typeof initial;
      type AssetPayload = Readonly<{
        assetId: string;
        byteLength: number;
        bytes: ArrayBuffer;
        mediaType: "image/png";
        pixelHeight: number;
        pixelWidth: number;
        sha256: string;
      }>;
      type TransferRequest = Readonly<{
        assetPayloads?: readonly AssetPayload[];
        kind?: string;
        snapshotJson?: ArrayBuffer;
      }>;
      const payload = (input: BrowserScene, assetId?: string): AssetPayload => {
        const asset = input.bundle.assets.assets[0];
        if (!asset) throw new Error("The browser PNG fixture is missing its manifest asset.");
        return {
          assetId: assetId ?? asset.id,
          byteLength: asset.byteLength,
          bytes: Uint8Array.from(input.bytes).buffer,
          mediaType: asset.mediaType,
          pixelHeight: asset.pixelHeight,
          pixelWidth: asset.pixelWidth,
          sha256: asset.sha256,
        };
      };

      const observed: Array<
        Readonly<{ assetByteLengths: readonly number[]; assetCount: number; kind: string; transferCount: number }>
      > = [];
      let injectedSnapshotRejection = false;
      const NativeWorker = globalThis.Worker;
      class ObservedCanvasWorker extends NativeWorker {
        constructor() {
          super(new URL("/src/engine/poietra-canvas.dev.worker.ts", location.href), { type: "module" });
        }

        override postMessage(message: unknown, transferOrOptions?: StructuredSerializeOptions | Transferable[]) {
          const request = message as TransferRequest;
          const assets = request.assetPayloads ?? [];
          observed.push({
            assetByteLengths: assets.map((asset) => asset.bytes.byteLength),
            assetCount: assets.length,
            kind: request.kind ?? "unknown",
            transferCount: Array.isArray(transferOrOptions) ? transferOrOptions.length : 0,
          });
          if (request.kind === "replace-scene" && assets.length === 1 && !injectedSnapshotRejection) {
            injectedSnapshotRejection = true;
            const malformedSnapshot = new TextEncoder().encode("{").buffer;
            super.postMessage({ ...request, snapshotJson: malformedSnapshot }, [
              malformedSnapshot,
              ...assets.map((asset) => asset.bytes),
            ]);
            return;
          }
          if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
          else super.postMessage(message, transferOrOptions);
        }
      }

      const canvas = Object.assign(document.createElement("canvas"), {
        height: viewport.heightPx,
        width: viewport.widthPx,
      });
      document.body.replaceChildren(canvas);
      const client = new PoietraCanvasWorkerClient({
        evidence: createCanvasWorkerClientEvidenceAdapterV1(),
        requestTimeoutMs: 60_000,
        workerFactory: () => new ObservedCanvasWorker(),
      });
      const samples = [
        { fractionX: 0.125, fractionY: 0.125 },
        { fractionX: 0.875, fractionY: 0.125 },
        { fractionX: 0.125, fractionY: 0.875 },
        { fractionX: 0.875, fractionY: 0.875 },
      ];
      const renderAndCapture = async (revision: string) => {
        const frame = await client.render({ revision, sampleTime: 1, viewport });
        const evidence = await client.captureFrameEvidence({ revision, samples });
        return { evidence, frame };
      };
      const rejectCode = async (operation: Promise<unknown>) => {
        try {
          await operation;
          return "resolved";
        } catch (error) {
          return error instanceof CanvasWorkerClientError ? error.code : `foreign:${String(error)}`;
        }
      };

      const initialPayload = payload(initial);
      const replacementPayload = payload(replacement);
      try {
        await client.installScene({
          assetPayloads: [initialPayload],
          canvas,
          revision: revisions.base,
          snapshot: initial.bundle,
        });
        const initialFrame = await renderAndCapture(revisions.base);

        await client.replaceScene({
          baseRevision: revisions.base,
          revision: revisions.reused,
          snapshot: reused.bundle,
        });
        const reusedFrame = await renderAndCapture(revisions.reused);

        const rejected = await rejectCode(
          client.replaceScene({
            assetPayloads: [replacementPayload],
            baseRevision: revisions.reused,
            revision: revisions.replacement,
            snapshot: replacement.bundle,
          }),
        );
        const revisionAfterRejected = client.revision;
        const callerBytesAfterRejected = replacementPayload.bytes.byteLength;
        const preservedFrame = await renderAndCapture(revisions.reused);

        await client.replaceScene({
          assetPayloads: [replacementPayload],
          baseRevision: revisions.reused,
          revision: revisions.replacement,
          snapshot: replacement.bundle,
        });
        const callerBytesAfterRetry = replacementPayload.bytes.byteLength;
        const replacementFrame = await renderAndCapture(revisions.replacement);

        const invalidOutcomes: Array<Readonly<{ code: string; revision: string | null }>> = [];
        const invalidInputs = [
          {
            assetPayloads: [payload(stale, "asset:stale")],
            baseRevision: revisions.replacement,
            revision: revisions.stale,
            snapshot: stale.bundle,
          },
          {
            assetPayloads: [payload(hashMismatch)],
            baseRevision: revisions.replacement,
            revision: revisions.hashMismatch,
            snapshot: hashMismatch.bundle,
          },
          {
            assetPayloads: [payload(dimensionMismatch)],
            baseRevision: revisions.replacement,
            revision: revisions.dimensionMismatch,
            snapshot: dimensionMismatch.bundle,
          },
        ];
        for (const input of invalidInputs) {
          invalidOutcomes.push({ code: await rejectCode(client.replaceScene(input)), revision: client.revision });
        }
        const finalFrame = await renderAndCapture(revisions.replacement);

        return {
          callerBytesAfterRejected,
          callerBytesAfterRetry,
          frames: {
            final: finalFrame,
            initial: initialFrame,
            preserved: preservedFrame,
            replacement: replacementFrame,
            reused: reusedFrame,
          },
          invalidOutcomes,
          lifecycleRequests: observed.filter(({ kind }) => kind === "install-canvas" || kind === "replace-scene"),
          rejected,
          revisionAfterRejected,
        };
      } finally {
        client.dispose();
      }
    },
    {
      dimensionMismatch,
      hashMismatch,
      initial,
      replacement,
      reused,
      revisions: {
        base: BASE_REVISION,
        dimensionMismatch: DIMENSION_MISMATCH_REVISION,
        hashMismatch: HASH_MISMATCH_REVISION,
        replacement: REPLACEMENT_REVISION,
        reused: REUSED_REVISION,
        stale: STALE_REVISION,
      },
      stale,
      viewport: VIEWPORT,
    },
  );

  expect(result.lifecycleRequests.map(({ transferCount: _transferCount, ...request }) => request)).toEqual([
    { assetByteLengths: [initial.bytes.length], assetCount: 1, kind: "install-canvas" },
    { assetByteLengths: [], assetCount: 0, kind: "replace-scene" },
    { assetByteLengths: [replacement.bytes.length], assetCount: 1, kind: "replace-scene" },
    { assetByteLengths: [replacement.bytes.length], assetCount: 1, kind: "replace-scene" },
  ]);
  expect(result.lifecycleRequests.every(({ transferCount }) => transferCount > 0)).toBe(true);
  expect(result.rejected).toBe("snapshot-rejected");
  expect(result.revisionAfterRejected).toBe(REUSED_REVISION);
  expect(result.callerBytesAfterRejected).toBe(replacement.bytes.length);
  expect(result.callerBytesAfterRetry).toBe(replacement.bytes.length);

  expect(result.invalidOutcomes).toEqual([
    { code: "invalid-input", revision: REPLACEMENT_REVISION },
    { code: "invalid-input", revision: REPLACEMENT_REVISION },
    { code: "invalid-input", revision: REPLACEMENT_REVISION },
  ]);

  const initialPixels = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 255, 255],
  ];
  const replacementPixels = [
    [0, 255, 255, 255],
    [255, 0, 255, 255],
    [255, 255, 0, 255],
    [0, 0, 0, 255],
  ];
  const reusedPixels = [
    [0, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ];
  expectPixels(result.frames.initial.evidence.samples, initialPixels);
  expectPixels(result.frames.reused.evidence.samples, reusedPixels);
  expectPixels(result.frames.preserved.evidence.samples, reusedPixels);
  expectPixels(result.frames.replacement.evidence.samples, replacementPixels);
  expectPixels(result.frames.final.evidence.samples, replacementPixels);
  expect(result.frames.final.evidence.revision).toBe(REPLACEMENT_REVISION);
  expect(result.frames.final.evidence.packetId).toBe(result.frames.final.frame.packetId);
  expect(Object.keys(result.frames.final.evidence).sort()).toEqual([
    "kind",
    "packetId",
    "requestId",
    "revision",
    "sampleTime",
    "samples",
    "schema",
    "surfaceFormat",
    "version",
    "viewport",
  ]);

  const productionResponses = Object.values(result.frames).map(({ frame }) => frame);
  const serializedProductionResponses = JSON.stringify(productionResponses);
  expect(serializedProductionResponses).not.toContain("assetPayloads");
  expect(serializedProductionResponses).not.toContain("bytes");
  expect(serializedProductionResponses).not.toContain("rgba");
  productionResponses.forEach((response) => {
    expect(Object.keys(response).sort()).toEqual([
      "kind",
      "packetId",
      "requestId",
      "revision",
      "sampleTime",
      "schema",
      "suboptimal",
      "version",
      "viewport",
    ]);
  });
});
