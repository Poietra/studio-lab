import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import {
  type AssetManifestV1,
  canonicalAssetManifestV1,
  type SceneIrBundleV1,
  sceneIrBundleV1Schema,
} from "../src/engine/contracts";
import { encodeRgbaPngV1 } from "./png-rgba";

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function imageCacheFixture() {
  const base = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Readonly<{
    scene: SceneIrBundleV1["scene"];
  }>;
  const png = encodeRgbaPngV1(Uint8Array.from([255, 0, 0, 255]), 1, 1);
  const digest = sha256(png);
  const asset = {
    alphaMode: "straight",
    byteLength: png.byteLength,
    colorSpace: "srgb",
    id: "asset:image-cache",
    kind: "png-image",
    mediaType: "image/png",
    pixelHeight: 1,
    pixelWidth: 1,
    sha256: digest,
  } as const;
  const manifestDraft: AssetManifestV1 = {
    assets: [asset],
    manifestDigest: "0".repeat(64),
    manifestId: "manifest:image-cache",
    schema: "poietra.asset-manifest",
    version: 1,
  };
  const manifest = {
    ...manifestDraft,
    manifestDigest: sha256(canonicalAssetManifestV1(manifestDraft)),
  };
  const revision = "c".repeat(64);
  const common = {
    appearance: { kind: "image", opacity: 1 } as const,
    lifetimes: [{ end: 2, start: 0 }],
    parentId: null,
    provenanceId: "fixture",
    transform: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
  };
  const snapshot = sceneIrBundleV1Schema.parse({
    assets: manifest,
    scene: {
      ...base.scene,
      animationChannels: [],
      assetManifest: { manifestDigest: manifest.manifestDigest, manifestId: manifest.manifestId },
      entities: [
        {
          ...common,
          geometry: {
            asset: { assetId: asset.id, sha256: asset.sha256 },
            kind: "image",
            localRect: { bottom: -2, left: -4, right: 0, top: 2 },
            sampler: "nearest",
          },
          id: "image-nearest",
          sceneOrder: 0,
          sourceZIndex: 0,
        },
        {
          ...common,
          geometry: {
            asset: { assetId: asset.id, sha256: asset.sha256 },
            kind: "image",
            localRect: { bottom: -2, left: 0, right: 4, top: 2 },
            sampler: "linear",
          },
          id: "image-linear",
          sceneOrder: 1,
          sourceZIndex: 1,
        },
      ],
      requiredCapabilities: ["png-image"],
      source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: revision },
    },
  });
  return { asset, png: [...png], revision, snapshot };
}

test("uploads one verified texture and reuses both sampler bindings for 300 browser frames", async ({ page }) => {
  const fixture = await imageCacheFixture();
  await page.goto("/");
  const evidence = await page.evaluate(async ({ asset, png, revision, snapshot }) => {
    const canvas = document.createElement("canvas");
    canvas.height = 90;
    canvas.width = 160;
    document.body.replaceChildren(canvas);
    const { PoietraCanvasWorkerClient } = await import("../src/engine/canvas-worker-client");
    const client = new PoietraCanvasWorkerClient({ requestTimeoutMs: 60_000 });
    try {
      const bytes = Uint8Array.from(png).buffer;
      await client.installScene({
        assetPayloads: [
          {
            assetId: asset.id,
            byteLength: asset.byteLength,
            bytes,
            mediaType: asset.mediaType,
            pixelHeight: asset.pixelHeight,
            pixelWidth: asset.pixelWidth,
            sha256: asset.sha256,
          },
        ],
        canvas,
        revision,
        snapshot,
      });
      const render = () =>
        client.renderTelemetry({
          revision,
          sampleTime: 1,
          viewport: { heightPx: 90, widthPx: 160 },
        });
      const cold = await render();
      const warm = [];
      for (let frame = 0; frame < 300; frame += 1) warm.push((await render()).telemetry);
      return { cold: cold.telemetry, warm };
    } finally {
      client.dispose();
    }
  }, fixture);

  expect(evidence.cold.caches.imageTexture).toBe("miss");
  expect(evidence.cold.caches.imageSamplerBinding).toBe("miss");
  expect(evidence.cold.counts.imageTextureUploads).toBe(1);
  expect(evidence.cold.counts.imageSamplerBindingCreations).toBe(2);
  expect(evidence.warm).toHaveLength(300);
  for (const frame of evidence.warm) {
    expect(frame.caches.imageTexture).toBe("hit");
    expect(frame.caches.imageSamplerBinding).toBe("hit");
    expect(frame.counts.imageTextureUploads).toBe(0);
    expect(frame.counts.imageSamplerBindingCreations).toBe(0);
    expect(frame.counts.imageTextureEvictions).toBe(0);
  }
});

test("recovers a destroyed Canvas device from Worker-retained PNG pixels without retransferring assets", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await imageCacheFixture();
  await page.goto("/");
  const result = await page.evaluate(async ({ asset, png, revision, snapshot }) => {
    const { CanvasWorkerClientError, PoietraCanvasWorkerClient } = await import("../src/engine/canvas-worker-client");
    const { createCanvasWorkerClientEvidenceAdapterV1 } = await import("../src/engine/canvas-worker-evidence");

    type ObservedRequest = Readonly<{
      assetPayloads?: readonly Readonly<{ bytes: ArrayBuffer }>[];
      kind?: string;
    }>;
    const requests: Array<Readonly<{ assetCount: number; kind: string; transferCount: number }>> = [];
    const workerErrors: string[] = [];
    let workerCreations = 0;
    let workerTerminations = 0;
    const NativeWorker = globalThis.Worker;
    class ObservedCanvasWorker extends NativeWorker {
      constructor() {
        workerCreations += 1;
        super(new URL("/src/engine/poietra-canvas.dev.worker.ts", location.href), { type: "module" });
        this.addEventListener("error", (event) => workerErrors.push(event.message));
      }

      override postMessage(message: unknown, transferOrOptions?: StructuredSerializeOptions | Transferable[]) {
        const request = message as ObservedRequest;
        requests.push({
          assetCount: request.assetPayloads?.length ?? 0,
          kind: request.kind ?? "unknown",
          transferCount: Array.isArray(transferOrOptions) ? transferOrOptions.length : 0,
        });
        if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
        else super.postMessage(message, transferOrOptions);
      }

      override terminate() {
        workerTerminations += 1;
        super.terminate();
      }
    }

    const canvas = Object.assign(document.createElement("canvas"), { height: 90, width: 160 });
    document.body.replaceChildren(canvas);
    const client = new PoietraCanvasWorkerClient({
      evidence: createCanvasWorkerClientEvidenceAdapterV1(),
      requestTimeoutMs: 60_000,
      workerFactory: () => new ObservedCanvasWorker(),
    });
    const samples = [
      { fractionX: 0.375, fractionY: 0.5 },
      { fractionX: 0.625, fractionY: 0.5 },
    ];
    try {
      await client.installScene({
        assetPayloads: [
          {
            assetId: asset.id,
            byteLength: asset.byteLength,
            bytes: Uint8Array.from(png).buffer,
            mediaType: asset.mediaType,
            pixelHeight: asset.pixelHeight,
            pixelWidth: asset.pixelWidth,
            sha256: asset.sha256,
          },
        ],
        canvas,
        revision,
        snapshot,
      });
      const render = () => client.render({ revision, sampleTime: 1, viewport: { heightPx: 90, widthPx: 160 } });
      await render();
      const before = await client.captureFrameEvidence({ revision, samples });

      await client.injectDeviceLossForTest();
      const recovered = await render();
      const after = await client.captureFrameEvidence({ revision, samples });
      await render();
      const recoveredClientRevision = client.revision;

      await client.injectDeviceLossForTest({ failRecovery: true });
      let fatalCode = "resolved";
      let fatalMessage = "";
      let fatalWasTyped = false;
      try {
        await render();
      } catch (error) {
        if (error instanceof CanvasWorkerClientError) {
          fatalWasTyped = true;
          fatalCode = error.code;
          fatalMessage = error.message;
        } else {
          fatalCode = String(error);
          fatalMessage = String(error);
        }
      }

      return {
        after: after.samples,
        before: before.samples,
        fatalCode,
        fatalMessage,
        fatalWasTyped,
        postFatalRevision: client.revision,
        recoveredRevision: recovered.revision,
        requests,
        revision: recoveredClientRevision,
        workerCreations,
        workerErrors,
        workerTerminationsBeforeDispose: workerTerminations,
      };
    } finally {
      client.dispose();
    }
  }, fixture);

  for (const samples of [result.before, result.after]) {
    expect(samples).toHaveLength(2);
    for (const [red, green, blue, alpha] of samples) {
      expect(red).toBeGreaterThanOrEqual(252);
      expect(green).toBeLessThanOrEqual(3);
      expect(blue).toBeLessThanOrEqual(3);
      expect(alpha).toBeGreaterThanOrEqual(252);
    }
  }
  expect(result.after).toEqual(result.before);
  expect(result.recoveredRevision).toBe(fixture.revision);
  expect(result.revision).toBe(fixture.revision);
  expect(result.workerCreations).toBe(1);
  expect(result.fatalWasTyped).toBe(true);
  expect(result.fatalCode).toBe("device-lost");
  expect(result.fatalMessage).toContain("WebGPU device recovery failed");
  expect(result.postFatalRevision).toBeNull();
  expect(result.workerErrors).toEqual([]);
  expect(result.workerTerminationsBeforeDispose).toBe(1);
  expect(result.requests.filter(({ kind }) => kind === "install-canvas")).toEqual([
    { assetCount: 1, kind: "install-canvas", transferCount: 3 },
  ]);
  expect(result.requests.some(({ kind }) => kind === "replace-scene")).toBe(false);
  expect(result.requests.filter(({ assetCount }) => assetCount > 0)).toEqual([
    { assetCount: 1, kind: "install-canvas", transferCount: 3 },
  ]);
  expect(
    result.requests
      .filter(({ kind }) => kind === "render-frame")
      .every(({ assetCount, transferCount }) => assetCount === 0 && transferCount === 0),
  ).toBe(true);
});
