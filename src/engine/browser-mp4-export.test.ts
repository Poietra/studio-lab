import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserMp4ExportProfileV1,
  DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
  runBrowserMp4ExportV1,
} from "./browser-mp4-export";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "./contracts";
import {
  type ExportProgressV1,
  type ExportWorkerResponseV1,
  exportWorkerRequestV1Schema,
} from "./export-worker-protocol";
import { fragmentMaterialRegistryV1Schema, STUDIO_GRADIENT_FRAGMENT_SOURCE_V1 } from "./fragment-material-registry";
import {
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
  scenePostEffectRegistryV1Schema,
} from "./scene-post-effect-registry";

class FakeWorker {
  readonly posted: unknown[] = [];
  readonly transfers: Transferable[][] = [];
  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown, transfer: Transferable[] = []) {
    this.posted.push(message);
    this.transfers.push(transfer);
  }

  emitMessage(data: ExportWorkerResponseV1 | unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }

  emitError(message: string) {
    for (const listener of this.listeners.get("error") ?? []) listener({ message });
  }
}

async function fixtureBundle(fileName = "shared-circle-opacity.json"): Promise<SceneIrBundleV1> {
  const url = new URL(`../../fixtures/engine-v1/${fileName}`, import.meta.url);
  const fixture = JSON.parse(await readFile(url, "utf8")) as Readonly<{ assets: unknown; scene: unknown }>;
  return sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
}

function progressResponse(requestId: number, framesEncoded: number): ExportWorkerResponseV1 {
  return {
    kind: "export-progress",
    progress: { encodedMediaBytes: framesEncoded * 64, frameCount: 6, framesEncoded, kind: "progress" },
    requestId,
    schema: "poietra.export-worker-response",
    version: 1,
  };
}

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://studio.example/" });
});

afterEach(() => vi.unstubAllGlobals());

describe("runBrowserMp4ExportV1", () => {
  it("forwards a selected non-default resolution and frame rate to the worker", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const profile = browserMp4ExportProfileV1({ frameRate: 60, resolution: "1280x720" });
    const outcomePromise = runBrowserMp4ExportV1({
      profile,
      snapshot: bundle,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    if (request.kind !== "export-mp4") throw new Error("missing export request");
    expect(JSON.parse(new TextDecoder().decode(request.profileJson))).toEqual(profile);
    worker.emitMessage({
      bytes: new Uint8Array([0, 0, 0, 8]).buffer,
      kind: "export-finished",
      requestId: request.requestId,
      schema: "poietra.export-worker-response",
      version: 1,
    } satisfies ExportWorkerResponseV1);
    await expect(outcomePromise).resolves.toMatchObject({ kind: "exported" });
  });

  it("forwards a canonical Studio-created Image and its verified PNG payload to the WebCodecs worker", async () => {
    const base = await fixtureBundle("png-alpha-edge-camera.json");
    const image = base.scene.entities.find((entity) => entity.geometry.kind === "image");
    const asset = base.assets.assets[0];
    if (!image || !asset) throw new Error("Expected a canonical PNG fixture.");
    const snapshot = sceneIrBundleV1Schema.parse({
      ...base,
      scene: {
        ...base.scene,
        entities: [
          ...base.scene.entities,
          { ...image, id: "studio:image:copy", sceneOrder: base.scene.entities.length },
        ],
      },
    });
    const payload = {
      assetId: asset.id,
      byteLength: asset.byteLength,
      bytes: new ArrayBuffer(asset.byteLength),
      mediaType: "image/png" as const,
      pixelHeight: asset.pixelHeight,
      pixelWidth: asset.pixelWidth,
      sha256: asset.sha256,
    };
    const worker = new FakeWorker();
    const outcomePromise = runBrowserMp4ExportV1({
      assetPayloads: [payload],
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      snapshot,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    if (request.kind !== "export-mp4") throw new Error("missing export request");

    expect(request.assetPayloads).toEqual([payload]);
    expect(JSON.parse(new TextDecoder().decode(request.snapshotJson))).toEqual(snapshot);
    worker.emitMessage({
      bytes: new Uint8Array([0, 0, 0, 8]).buffer,
      kind: "export-finished",
      requestId: request.requestId,
      schema: "poietra.export-worker-response",
      version: 1,
    } satisfies ExportWorkerResponseV1);
    await expect(outcomePromise).resolves.toMatchObject({ kind: "exported" });
  });

  it("hands object materials and the project Scene post-effect registry to the WebCodecs worker", async () => {
    const base = await fixtureBundle();
    const first = base.scene.entities[0];
    if (!first || first.appearance.kind !== "vector" || !first.appearance.fill) {
      throw new Error("Expected a filled vector fixture.");
    }
    const bundle = sceneIrBundleV1Schema.parse({
      ...base,
      scene: {
        ...base.scene,
        entities: [
          {
            ...first,
            appearance: {
              ...first.appearance,
              fill: {
                ...first.appearance.fill,
                fragmentMaterial: {
                  parameters: [0.75, 2.25, 0.1, 0.2, 0.3, 0.9, 0.4, 0.1],
                  revision: 1,
                  shaderId: "project-material-1",
                },
              },
            },
          },
          ...base.scene.entities.slice(1),
        ],
        requiredCapabilities: [...base.scene.requiredCapabilities, "fragment-material"],
      },
    });
    const registry = fragmentMaterialRegistryV1Schema.parse({
      materials: [{ revision: 1, shaderId: "project-material-1", source: STUDIO_GRADIENT_FRAGMENT_SOURCE_V1 }],
      schema: "poietra.fragment-material-registry",
      version: 1,
    });
    const scenePostEffectRegistry = scenePostEffectRegistryV1Schema.parse({
      effects: [
        {
          revision: 1,
          shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          source: STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
        },
      ],
      schema: "poietra.scene-post-effect-registry",
      version: 1,
    });
    const worker = new FakeWorker();
    const outcomePromise = runBrowserMp4ExportV1({
      fragmentMaterialRegistry: registry,
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      scenePostEffectRegistry,
      snapshot: bundle,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    if (request.kind !== "export-mp4") throw new Error("missing export request");
    const exportedBundle = sceneIrBundleV1Schema.parse(JSON.parse(new TextDecoder().decode(request.snapshotJson)));
    const exported = exportedBundle.scene.entities[0];
    expect(exported?.appearance.kind === "vector" ? exported.appearance.fill?.fragmentMaterial : null).toMatchObject({
      parameters: [0.75, 2.25, 0.1, 0.2, 0.3, 0.9, 0.4, 0.1],
      shaderId: "project-material-1",
    });
    expect(JSON.parse(new TextDecoder().decode(request.fragmentMaterialRegistryJson))).toEqual(registry);
    expect(JSON.parse(new TextDecoder().decode(request.scenePostEffectRegistryJson))).toEqual(scenePostEffectRegistry);
    expect(worker.transfers[0]).toEqual([request.fragmentMaterialRegistryJson, request.scenePostEffectRegistryJson]);
    worker.emitMessage({
      bytes: new Uint8Array([0, 0, 0, 8]).buffer,
      kind: "export-finished",
      requestId: request.requestId,
      schema: "poietra.export-worker-response",
      version: 1,
    } satisfies ExportWorkerResponseV1);
    await expect(outcomePromise).resolves.toMatchObject({ kind: "exported" });
  });

  it("hands the exact official SquareToCircle Scene IR to the WebCodecs worker", async () => {
    const bundle = await fixtureBundle("real-square-to-circle-v8.json");
    const worker = new FakeWorker();
    const outcomePromise = runBrowserMp4ExportV1({
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      snapshot: bundle,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    if (request.kind !== "export-mp4") throw new Error("missing export request");
    expect(JSON.parse(new TextDecoder().decode(request.snapshotJson))).toEqual(bundle);
    worker.emitMessage({
      bytes: new Uint8Array([0, 0, 0, 8]).buffer,
      kind: "export-finished",
      requestId: request.requestId,
      schema: "poietra.export-worker-response",
      version: 1,
    } satisfies ExportWorkerResponseV1);
    await expect(outcomePromise).resolves.toMatchObject({ kind: "exported" });
  });

  it.each([
    ["Text", "studio:text:japanese-multiline"],
    ["MathTex", "studio:mathtex:equation"],
  ] as const)("forwards canonical rotated %s geometry to the WebCodecs worker unchanged", async (_type, entityId) => {
    const base = await fixtureBundle();
    const source = base.scene.entities[0];
    if (!source) throw new Error("missing export fixture entity");
    const outline = {
      subpaths: [
        {
          closed: true,
          segments: [
            {
              control1: { x: -0.5, y: -0.5 },
              control2: { x: 0.5, y: -0.5 },
              end: { x: 0.5, y: 0 },
            },
            {
              control1: { x: 0.5, y: 0.5 },
              control2: { x: -0.5, y: 0.5 },
              end: { x: -0.5, y: 0 },
            },
          ],
          start: { x: -0.5, y: 0 },
        },
      ],
    } as const;
    const snapshot = sceneIrBundleV1Schema.parse({
      ...base,
      scene: {
        ...base.scene,
        entities: [
          ...base.scene.entities,
          {
            ...source,
            geometry: { kind: "cubic-path", path: outline },
            id: entityId,
            sceneOrder: base.scene.entities.length,
          },
        ],
        animationChannels: [
          ...base.scene.animationChannels,
          {
            entityId,
            id: `studio-transform:${entityId}`,
            keyframes: [
              {
                at: 0,
                easingToNext: { kind: "linear" },
                value: { m11: 0, m12: -1.5, m21: 1.5, m22: 0, tx: 1, ty: 2 },
              },
              {
                at: base.scene.duration,
                easingToNext: null,
                value: { m11: 0, m12: -1.5, m21: 1.5, m22: 0, tx: 1, ty: 2 },
              },
            ],
            kind: "affine-transform",
            provenanceId: "studio-group-transform",
          },
        ],
        requiredCapabilities: [
          ...new Set([...base.scene.requiredCapabilities, "affine-transform-animation", "cubic-path-geometry"]),
        ],
      },
    });
    const worker = new FakeWorker();
    const outcomePromise = runBrowserMp4ExportV1({
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      snapshot,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    if (request.kind !== "export-mp4") throw new Error("missing export request");
    const forwarded = sceneIrBundleV1Schema.parse(
      JSON.parse(new TextDecoder().decode(new Uint8Array(request.snapshotJson))),
    );
    expect(forwarded.scene.entities.find(({ id }) => id === entityId)?.geometry).toEqual({
      kind: "cubic-path",
      path: outline,
    });
    expect(
      forwarded.scene.animationChannels.find((channel) => "entityId" in channel && channel.entityId === entityId),
    ).toEqual(
      snapshot.scene.animationChannels.find((channel) => "entityId" in channel && channel.entityId === entityId),
    );
    worker.emitMessage({
      bytes: new Uint8Array([0, 0, 0, 8]).buffer,
      kind: "export-finished",
      requestId: request.requestId,
      schema: "poietra.export-worker-response",
      version: 1,
    } satisfies ExportWorkerResponseV1);
    await expect(outcomePromise).resolves.toMatchObject({ kind: "exported" });
  });

  it("relays bounded progress and resolves the finished Blob", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const progressReports: ExportProgressV1[] = [];
    const outcomePromise = runBrowserMp4ExportV1({
      onProgress: (progress) => progressReports.push(progress),
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      snapshot: bundle,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    if (request.kind !== "export-mp4") throw new Error("missing export request");
    worker.emitMessage(progressResponse(request.requestId, 3));
    worker.emitMessage({
      bytes: new Uint8Array([0, 0, 0, 8]).buffer,
      kind: "export-finished",
      requestId: request.requestId,
      schema: "poietra.export-worker-response",
      version: 1,
    } satisfies ExportWorkerResponseV1);
    const outcome = await outcomePromise;
    if (outcome.kind !== "exported") throw new Error("expected an exported outcome");
    expect(outcome.mp4.type).toBe("video/mp4");
    expect(outcome.mp4.size).toBe(4);
    expect(progressReports).toEqual([{ encodedMediaBytes: 192, frameCount: 6, framesEncoded: 3, kind: "progress" }]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("transfers an optional WAV attachment to the export worker", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const audioWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;
    const outcomePromise = runBrowserMp4ExportV1({
      audioTiming: {
        timelineOffsetSampleFrames: 4_800,
        trimEndSampleFrames: 14_400,
        trimStartSampleFrames: 2_400,
        volumePercent: 50,
      },
      audioWav,
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      snapshot: bundle,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    if (request.kind !== "export-mp4") throw new Error("missing export request");
    expect(request.audioTiming).toEqual({
      timelineOffsetSampleFrames: 4_800,
      trimEndSampleFrames: 14_400,
      trimStartSampleFrames: 2_400,
      volumePercent: 50,
    });
    expect(new Uint8Array(request.audioWav ?? new ArrayBuffer(0))).toEqual(new Uint8Array(audioWav));
    expect(worker.transfers[0]).toEqual([
      audioWav,
      request.fragmentMaterialRegistryJson,
      request.scenePostEffectRegistryJson,
    ]);
    worker.emitMessage({
      bytes: new Uint8Array([0, 0, 0, 8]).buffer,
      kind: "export-finished",
      requestId: request.requestId,
      schema: "poietra.export-worker-response",
      version: 1,
    } satisfies ExportWorkerResponseV1);
    await expect(outcomePromise).resolves.toMatchObject({ kind: "exported" });
  });

  it("posts the cancel companion on abort and resolves the named cancelled refusal", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const controller = new AbortController();
    const outcomePromise = runBrowserMp4ExportV1({
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      signal: controller.signal,
      snapshot: bundle,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    worker.emitMessage(progressResponse(request.requestId, 1));
    controller.abort();
    const cancel = exportWorkerRequestV1Schema.parse(worker.posted[1]);
    expect(cancel).toMatchObject({ kind: "export-cancel", requestId: request.requestId });
    worker.emitMessage({
      kind: "export-refused",
      message: "cancelled: the export was cancelled after frame 1 of 6",
      reason: "cancelled",
      requestId: request.requestId,
      schema: "poietra.export-worker-response",
      version: 1,
    } satisfies ExportWorkerResponseV1);
    await expect(outcomePromise).resolves.toEqual({
      kind: "refused",
      message: "cancelled: the export was cancelled after frame 1 of 6",
      reason: "cancelled",
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized finished bytes and protocol violations fail-closed", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const outcomePromise = runBrowserMp4ExportV1({
      profile: { ...DEFAULT_BROWSER_MP4_EXPORT_PROFILE, maxOutputBytes: 2 },
      snapshot: bundle,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    worker.emitMessage({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      kind: "export-finished",
      requestId: request.requestId,
      schema: "poietra.export-worker-response",
      version: 1,
    } satisfies ExportWorkerResponseV1);
    await expect(outcomePromise).rejects.toThrow(/maxOutputBytes/);

    const violating = new FakeWorker();
    const violatingPromise = runBrowserMp4ExportV1({
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      snapshot: bundle,
      workerFactory: () => violating as unknown as Worker,
    });
    await vi.waitFor(() => expect(violating.posted).toHaveLength(1));
    violating.emitMessage({ kind: "not-a-response" });
    await expect(violatingPromise).rejects.toThrow(/violated the v1 protocol/);
  });

  it("rejects when the worker crashes", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const outcomePromise = runBrowserMp4ExportV1({
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      snapshot: bundle,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    worker.emitError("worker exploded");
    await expect(outcomePromise).rejects.toThrow(/worker exploded/);
  });
});
