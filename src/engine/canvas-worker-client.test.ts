import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AssetManifestV1, digestAssetManifestV1, type PngAssetV1 } from "./asset-manifest";
import type { CanvasPngAssetTransferV1 } from "./canvas-png-assets";
import { adapterEvidenceFixtureV1, measuredTelemetryFixtureV1 } from "./canvas-telemetry-test-fixtures";
import {
  CanvasTelemetryRenderError,
  type CanvasWorkerClientError,
  PoietraCanvasWorkerClient,
  type PresentedCanvasFrameV1,
} from "./canvas-worker-client";
import {
  captureFrameEvidenceRequestV1Schema,
  createCanvasWorkerClientEvidenceAdapterV1,
  injectCanvasDeviceLossRequestV1Schema,
} from "./canvas-worker-evidence";
import {
  type CanvasWorkerRequestV1,
  type CanvasWorkerResponseV1,
  canvasWorkerRequestV1Schema,
} from "./canvas-worker-protocol";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "./contracts";
import {
  EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
  scenePostEffectRegistryV1Schema,
} from "./scene-post-effect-registry";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);
const REVISION_C = "c".repeat(64);

class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
}

class FakeCanvas {
  readonly offscreen = new FakeOffscreenCanvas(160, 90);
  readonly transferControlToOffscreen = vi.fn(() => this.offscreen);
}

type PostedMessage = Readonly<{ message: unknown; transfer: readonly Transferable[] }>;

class FakeWorker {
  readonly posted: PostedMessage[] = [];
  readonly terminate = vi.fn();
  detachArrayBufferTransfers = false;
  throwOnPost = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []) {
    if (this.throwOnPost) throw new DOMException("clone failed", "DataCloneError");
    if (this.detachArrayBufferTransfers) {
      const buffers = transfer.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer);
      const clone = structuredClone(message, { transfer: buffers });
      this.posted.push({ message: clone, transfer });
      return;
    }
    this.posted.push({ message, transfer });
  }

  emitMessage(data: CanvasWorkerResponseV1 | unknown) {
    this.emit("message", { data });
  }

  emitError(message: string) {
    this.emit("error", { message, preventDefault: vi.fn() });
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function requestAt(worker: FakeWorker, index: number) {
  return canvasWorkerRequestV1Schema.parse(worker.posted[index]?.message);
}

function readyResponse(
  request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "install-canvas" | "replace-scene" }>>,
): CanvasWorkerResponseV1 {
  return {
    kind: "canvas-ready",
    operation: request.kind === "install-canvas" ? "install" : "replace",
    requestId: request.requestId,
    revision: request.revision,
    schema: "poietra.canvas-worker-response",
    version: 1,
  };
}

function presentedResponse(
  request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "render-frame" }>>,
  overrides: Partial<PresentedCanvasFrameV1> = {},
): CanvasWorkerResponseV1 {
  return {
    kind: "frame-presented",
    packetId: `canvas:${request.requestId}`,
    requestId: request.requestId,
    revision: request.revision,
    sampleTime: request.sampleTime,
    schema: "poietra.canvas-worker-response",
    suboptimal: false,
    version: 1,
    viewport: request.viewport,
    ...overrides,
  };
}

function presentedTelemetryResponse(
  request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "render-frame-telemetry" }>>,
  overrides: Readonly<Record<string, unknown>> = {},
): CanvasWorkerResponseV1 {
  return {
    kind: "frame-presented-telemetry",
    packetId: `canvas:${request.requestId}`,
    requestId: request.requestId,
    revision: request.revision,
    sampleTime: request.sampleTime,
    schema: "poietra.canvas-worker-response",
    suboptimal: false,
    telemetry: measuredTelemetryFixtureV1(),
    version: 1,
    viewport: request.viewport,
    ...overrides,
  } as CanvasWorkerResponseV1;
}

function errorResponse(
  request: CanvasWorkerRequestV1,
  code: Extract<CanvasWorkerResponseV1, Readonly<{ kind: "error" }>>["code"],
): CanvasWorkerResponseV1 {
  return {
    code,
    fallback: "whole-scene",
    kind: "error",
    message: code,
    requestId: request.requestId,
    revision: request.revision,
    schema: "poietra.canvas-worker-response",
    version: 1,
  };
}

async function fixtureBundle(): Promise<SceneIrBundleV1> {
  const url = new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
  const fixture = JSON.parse(await readFile(url, "utf8")) as Readonly<{ assets: unknown; scene: unknown }>;
  return sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
}

function revisionBundle(bundle: SceneIrBundleV1, revision: string): SceneIrBundleV1 {
  if (bundle.scene.source.kind !== "studio-edit-program") throw new Error("fixture source must be an Edit Program");
  return {
    assets: bundle.assets,
    scene: {
      ...bundle.scene,
      source: { ...bundle.scene.source, revisionHash: revision },
    },
  };
}

async function bundleWithPng(
  bundle: SceneIrBundleV1,
  bytes: ArrayBuffer,
  id = "asset:image",
): Promise<Readonly<{ bundle: SceneIrBundleV1; payload: CanvasPngAssetTransferV1 }>> {
  const digestBytes = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digestBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const asset: PngAssetV1 = {
    alphaMode: "straight",
    byteLength: bytes.byteLength,
    colorSpace: "srgb",
    id,
    kind: "png-image",
    mediaType: "image/png",
    pixelHeight: 2,
    pixelWidth: 3,
    sha256,
  };
  const draft: AssetManifestV1 = {
    assets: [asset],
    manifestDigest: "0".repeat(64),
    manifestId: "manifest:image",
    schema: "poietra.asset-manifest",
    version: 1,
  };
  const assets = { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
  return {
    bundle: {
      assets,
      scene: {
        ...bundle.scene,
        assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
      },
    },
    payload: {
      assetId: id,
      byteLength: bytes.byteLength,
      bytes,
      mediaType: "image/png",
      pixelHeight: 2,
      pixelWidth: 3,
      sha256,
    },
  };
}

const decodePngDimensions = async () => ({ pixelHeight: 2, pixelWidth: 3 });

function createClient(worker: FakeWorker, requestTimeoutMs = 5_000, wasmModuleUrl = "./engine-wasm/poietra_wasm.js") {
  return new PoietraCanvasWorkerClient({
    requestTimeoutMs,
    wasmModuleUrl,
    workerFactory: () => worker as unknown as Worker,
  });
}

async function install(
  client: PoietraCanvasWorkerClient,
  worker: FakeWorker,
  bundle: SceneIrBundleV1,
  canvas = new FakeCanvas(),
) {
  const installed = client.installScene({
    canvas: canvas as unknown as HTMLCanvasElement,
    revision: REVISION_A,
    snapshot: bundle,
  });
  await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
  const request = requestAt(worker, 0);
  if (request.kind !== "install-canvas") throw new Error("missing install request");
  worker.emitMessage(readyResponse(request));
  await installed;
  return { canvas, request };
}

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("location", { href: "https://studio.test/app/" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Poietra canvas worker client", () => {
  it("transfers one canvas and snapshot, then returns presentation metadata only", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    const { canvas, request: installRequest } = await install(client, worker, bundle);

    expect(installRequest.wasmModuleUrl).toBe("https://studio.test/app/engine-wasm/poietra_wasm.js");
    expect(canvas.transferControlToOffscreen).toHaveBeenCalledOnce();
    expect(worker.posted[0]?.transfer).toEqual([
      installRequest.canvas,
      installRequest.fragmentMaterialRegistryJson,
      installRequest.scenePostEffectRegistryJson,
      installRequest.snapshotJson,
    ]);
    expect(JSON.parse(new TextDecoder().decode(installRequest.scenePostEffectRegistryJson))).toEqual(
      EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
    );

    const rendered = client.render({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const renderRequest = requestAt(worker, 1);
    expect(renderRequest).toEqual({
      kind: "render-frame",
      requestId: 2,
      revision: REVISION_A,
      sampleTime: 1,
      schema: "poietra.canvas-worker-request",
      version: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    expect(renderRequest).not.toHaveProperty("canvas");
    expect(renderRequest).not.toHaveProperty("snapshotJson");
    if (renderRequest.kind !== "render-frame") throw new Error("missing render request");
    worker.emitMessage(presentedResponse(renderRequest));

    await expect(rendered).resolves.toEqual({
      kind: "frame-presented",
      packetId: "canvas:2",
      requestId: 2,
      revision: REVISION_A,
      sampleTime: 1,
      schema: "poietra.canvas-worker-response",
      suboptimal: false,
      version: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    client.dispose();
  });

  it("returns the thumbnail generated by the exact installed revision", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);

    const generated = client.generateThumbnail(REVISION_A);
    const request = requestAt(worker, 1);
    expect(request).toMatchObject({ kind: "generate-thumbnail", revision: REVISION_A });
    worker.emitMessage({
      kind: "thumbnail-generated",
      png: new Uint8Array([137, 80, 78, 71]).buffer,
      requestId: request.requestId,
      revision: request.revision,
      schema: "poietra.canvas-worker-response",
      version: 1,
    });

    await expect(generated).resolves.toEqual(new Uint8Array([137, 80, 78, 71]));
    await expect(client.generateThumbnail(REVISION_B)).rejects.toMatchObject({ code: "invalid-state" });
    client.dispose();
  });

  it("requests verified runtime bounds and preserves their correlated response", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);
    const interactionEntityIds = ["scene:runtime/entity#0", "scene:runtime/entity#1"];

    const rendered = client.render({
      interactionEntityIds,
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const request = requestAt(worker, 1);
    expect(request).toMatchObject({ interactionEntityIds, kind: "render-frame" });
    if (request.kind !== "render-frame") throw new Error("missing render request");
    worker.emitMessage(
      presentedResponse(request, {
        interaction: {
          entries: [{ bounds: [-0.5, -0.25, 0.5, 0.25], status: "present" }, { status: "inactive" }],
          space: "clip-v1",
          status: "available",
        },
      }),
    );
    await expect(rendered).resolves.toMatchObject({
      interaction: { entries: [{ status: "present" }, { status: "inactive" }], status: "available" },
      kind: "frame-presented",
    });

    const renderedWithDuplicateMetadata = client.render({
      interactionEntityIds: ["duplicate", "duplicate"],
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const duplicateRequest = requestAt(worker, 2);
    expect(duplicateRequest).toMatchObject({ interactionEntityIds: ["duplicate", "duplicate"] });
    if (duplicateRequest.kind !== "render-frame") throw new Error("missing duplicate render request");
    worker.emitMessage(presentedResponse(duplicateRequest, { interaction: { status: "unavailable" } }));
    await expect(renderedWithDuplicateMetadata).resolves.toMatchObject({
      interaction: { status: "unavailable" },
      kind: "frame-presented",
    });
    expect(worker.posted).toHaveLength(3);
    client.dispose();
  });

  it("keeps one render in flight and coalesces queued playheads to the latest", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);

    const first = client.render({ revision: REVISION_A, sampleTime: 0.25, viewport: { heightPx: 90, widthPx: 160 } });
    const firstOutcome = first.catch((error: unknown) => error as CanvasWorkerClientError);
    const second = client.render({ revision: REVISION_A, sampleTime: 0.5, viewport: { heightPx: 90, widthPx: 160 } });
    const secondOutcome = second.catch((error: unknown) => error as CanvasWorkerClientError);
    const latest = client.render({ revision: REVISION_A, sampleTime: 1, viewport: { heightPx: 90, widthPx: 160 } });

    expect(worker.posted).toHaveLength(2);
    await expect(firstOutcome).resolves.toMatchObject({ code: "stale-response", fallback: "whole-scene" });
    await expect(secondOutcome).resolves.toMatchObject({ code: "stale-response", fallback: "whole-scene" });

    const firstRequest = requestAt(worker, 1);
    if (firstRequest.kind !== "render-frame") throw new Error("missing first render");
    worker.emitMessage(presentedResponse(firstRequest));
    await vi.waitFor(() => expect(worker.posted).toHaveLength(3));

    const latestRequest = requestAt(worker, 2);
    if (latestRequest.kind !== "render-frame") throw new Error("missing latest render");
    expect(latestRequest.sampleTime).toBe(1);
    worker.emitMessage(presentedResponse(latestRequest));
    await expect(latest).resolves.toMatchObject({ packetId: `canvas:${latestRequest.requestId}`, sampleTime: 1 });
    client.dispose();
  });

  it("validates correlation even after an in-flight render was superseded", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);

    const first = client.render({
      revision: REVISION_A,
      sampleTime: 0.25,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const firstOutcome = first.catch((error: unknown) => error as CanvasWorkerClientError);
    const queued = client.render({
      revision: REVISION_A,
      sampleTime: 0.5,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const firstRequest = requestAt(worker, 1);
    if (firstRequest.kind !== "render-frame") throw new Error("missing superseded render");
    worker.emitMessage(presentedResponse(firstRequest, { sampleTime: 99 }));

    await expect(firstOutcome).resolves.toMatchObject({ code: "stale-response" });
    await expect(queued).rejects.toMatchObject({ code: "protocol-violation" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.posted).toHaveLength(2);
  });

  it("replaces snapshots without transferring the canvas again and cancels stale renders", async () => {
    const bundle = await fixtureBundle();
    const replacement = revisionBundle(bundle, REVISION_B);
    const worker = new FakeWorker();
    const client = createClient(worker);
    const { canvas } = await install(client, worker, bundle);

    const rendering = client.render({
      revision: REVISION_A,
      sampleTime: 0.5,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const renderOutcome = rendering.catch((error: unknown) => error as CanvasWorkerClientError);
    const replacing = client.replaceScene({
      baseRevision: REVISION_A,
      revision: REVISION_B,
      scenePostEffectRegistry: scenePostEffectRegistryV1Schema.parse({
        effect: {
          revision: 1,
          shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          source: STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
        },
        schema: "poietra.scene-post-effect-registry",
        version: 1,
      }),
      snapshot: replacement,
    });
    await expect(renderOutcome).resolves.toMatchObject({ code: "stale-response" });

    const replaceRequest = requestAt(worker, 2);
    if (replaceRequest.kind !== "replace-scene") throw new Error("missing replacement request");
    expect(worker.posted[2]?.transfer).toEqual([
      replaceRequest.fragmentMaterialRegistryJson,
      replaceRequest.scenePostEffectRegistryJson,
      replaceRequest.snapshotJson,
    ]);
    expect(JSON.parse(new TextDecoder().decode(replaceRequest.scenePostEffectRegistryJson))).toMatchObject({
      effect: { revision: 1, shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 },
    });
    expect(canvas.transferControlToOffscreen).toHaveBeenCalledOnce();
    const renderRequest = requestAt(worker, 1);
    if (renderRequest.kind !== "render-frame") throw new Error("missing stale render request");
    worker.emitMessage(presentedResponse(renderRequest));
    worker.emitMessage(readyResponse(replaceRequest));
    await expect(replacing).resolves.toBeUndefined();
    expect(client.revision).toBe(REVISION_B);

    const next = client.render({
      revision: REVISION_B,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(4));
    const nextRequest = requestAt(worker, 3);
    if (nextRequest.kind !== "render-frame") throw new Error("missing render after replacement");
    worker.emitMessage(presentedResponse(nextRequest));
    await expect(next).resolves.toMatchObject({ revision: REVISION_B, sampleTime: 1 });
    client.dispose();
  });

  it("transfers each new PNG digest once and reuses it after the correlated acknowledgement", async () => {
    const base = await fixtureBundle();
    const firstBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const first = await bundleWithPng(base, firstBytes);
    const worker = new FakeWorker();
    const client = new PoietraCanvasWorkerClient({
      decodePngDimensions,
      wasmModuleUrl: "./engine-wasm/poietra_wasm.js",
      workerFactory: () => worker as unknown as Worker,
    });

    const installing = client.installScene({
      assetPayloads: [first.payload],
      canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      revision: REVISION_A,
      snapshot: first.bundle,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const installRequest = requestAt(worker, 0);
    if (installRequest.kind !== "install-canvas") throw new Error("missing PNG install request");
    expect(installRequest.assetPayloads).toHaveLength(1);
    expect(installRequest.assetPayloads[0]?.bytes.byteLength).toBe(4);
    const installTransfer = worker.posted[0]?.transfer;
    expect(installTransfer).toHaveLength(5);
    const transferredPng = installTransfer?.[4];
    expect(transferredPng).not.toBe(firstBytes);
    if (!(transferredPng instanceof ArrayBuffer)) throw new Error("missing transferred PNG buffer");
    expect(transferredPng.byteLength).toBe(4);
    expect(firstBytes.byteLength).toBe(4);
    worker.emitMessage(readyResponse(installRequest));
    await installing;

    const reusing = client.replaceScene({
      baseRevision: REVISION_A,
      revision: REVISION_B,
      snapshot: revisionBundle(first.bundle, REVISION_B),
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
    const reuseRequest = requestAt(worker, 1);
    if (reuseRequest.kind !== "replace-scene") throw new Error("missing PNG reuse request");
    expect(reuseRequest.assetPayloads).toEqual([]);
    expect(worker.posted[1]?.transfer).toHaveLength(3);
    worker.emitMessage(readyResponse(reuseRequest));
    await reusing;

    const secondBytes = new Uint8Array([5, 6, 7, 8]).buffer;
    const second = await bundleWithPng(revisionBundle(base, REVISION_C), secondBytes, first.payload.assetId);
    const advancing = client.replaceScene({
      assetPayloads: [second.payload],
      baseRevision: REVISION_B,
      revision: REVISION_C,
      snapshot: second.bundle,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(3));
    const advanceRequest = requestAt(worker, 2);
    if (advanceRequest.kind !== "replace-scene") throw new Error("missing PNG advance request");
    expect(advanceRequest.assetPayloads).toHaveLength(1);
    expect(worker.posted[2]?.transfer).toHaveLength(4);
    expect(secondBytes.byteLength).toBe(4);
    worker.emitMessage(readyResponse(advanceRequest));
    await advancing;
    expect(client.revision).toBe(REVISION_C);
    client.dispose();
  });

  it("does not cache a PNG digest when atomic replacement is rejected", async () => {
    const base = await fixtureBundle();
    const first = await bundleWithPng(base, new Uint8Array([1, 2, 3, 4]).buffer);
    const worker = new FakeWorker();
    const client = new PoietraCanvasWorkerClient({
      decodePngDimensions,
      wasmModuleUrl: "./engine-wasm/poietra_wasm.js",
      workerFactory: () => worker as unknown as Worker,
    });
    const installing = client.installScene({
      assetPayloads: [first.payload],
      canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      revision: REVISION_A,
      snapshot: first.bundle,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const installRequest = requestAt(worker, 0);
    if (installRequest.kind !== "install-canvas") throw new Error("missing PNG install request");
    worker.emitMessage(readyResponse(installRequest));
    await installing;

    const second = await bundleWithPng(
      revisionBundle(base, REVISION_B),
      new Uint8Array([9, 10, 11, 12]).buffer,
      first.payload.assetId,
    );
    const rejected = client.replaceScene({
      assetPayloads: [second.payload],
      baseRevision: REVISION_A,
      revision: REVISION_B,
      snapshot: second.bundle,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
    const rejectedRequest = requestAt(worker, 1);
    worker.emitMessage(errorResponse(rejectedRequest, "snapshot-rejected"));
    await expect(rejected).rejects.toMatchObject({ code: "snapshot-rejected" });

    const retry = client.replaceScene({
      assetPayloads: [second.payload],
      baseRevision: REVISION_A,
      revision: REVISION_B,
      snapshot: second.bundle,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(3));
    const retryRequest = requestAt(worker, 2);
    if (retryRequest.kind !== "replace-scene") throw new Error("missing PNG retry request");
    expect(retryRequest.assetPayloads).toHaveLength(1);
    worker.emitMessage(readyResponse(retryRequest));
    await retry;
    client.dispose();
  });

  it("keeps the previous Scene only after an atomic snapshot rejection", async () => {
    const bundle = await fixtureBundle();
    const replacement = revisionBundle(bundle, REVISION_B);
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);

    const replacing = client.replaceScene({
      baseRevision: REVISION_A,
      revision: REVISION_B,
      snapshot: replacement,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
    const replaceRequest = requestAt(worker, 1);
    worker.emitMessage(errorResponse(replaceRequest, "snapshot-rejected"));
    await expect(replacing).rejects.toMatchObject({ code: "snapshot-rejected" });
    expect(client.revision).toBe(REVISION_A);
    expect(worker.terminate).not.toHaveBeenCalled();

    const rendered = client.render({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const renderRequest = requestAt(worker, 2);
    if (renderRequest.kind !== "render-frame") throw new Error("missing render of preserved Scene");
    worker.emitMessage(presentedResponse(renderRequest));
    await expect(rendered).resolves.toMatchObject({ revision: REVISION_A });
    client.dispose();
  });

  it.each(["internal-error", "invalid-message", "invalid-state", "protocol-violation", "stale-revision"] as const)(
    "fails closed after a %s replacement response",
    async (code) => {
      const bundle = await fixtureBundle();
      const replacement = revisionBundle(bundle, REVISION_B);
      const worker = new FakeWorker();
      const client = createClient(worker);
      await install(client, worker, bundle);

      const replacing = client.replaceScene({
        baseRevision: REVISION_A,
        revision: REVISION_B,
        snapshot: replacement,
      });
      await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
      const replaceRequest = requestAt(worker, 1);
      worker.emitMessage(errorResponse(replaceRequest, code));
      await expect(replacing).rejects.toMatchObject({ code });
      expect(client.revision).toBeNull();
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it("keeps per-frame unsupported errors nonfatal and exposes whole-scene fallback", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);

    const unsupported = client.render({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const unsupportedRequest = requestAt(worker, 1);
    worker.emitMessage(errorResponse(unsupportedRequest, "unsupported-frame"));
    await expect(unsupported).rejects.toMatchObject({
      code: "unsupported-frame",
      fallback: "whole-scene",
      requiresWholeSceneFallback: true,
    });
    expect(worker.terminate).not.toHaveBeenCalled();

    const next = client.render({
      revision: REVISION_A,
      sampleTime: 0.5,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(3));
    const nextRequest = requestAt(worker, 2);
    if (nextRequest.kind !== "render-frame") throw new Error("missing next render");
    worker.emitMessage(presentedResponse(nextRequest));
    await expect(next).resolves.toMatchObject({ sampleTime: 0.5 });
    client.dispose();
  });

  it.each([
    "device-lost",
    "surface-lost",
    "surface-validation",
    "gpu-out-of-memory",
    "gpu-validation",
    "gpu-internal",
    "invalid-message",
    "invalid-state",
    "stale-revision",
    "response-too-large",
    "serialization-failed",
  ] as const)("terminates after an unrecoverable %s render error", async (code) => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);

    const rendered = client.render({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const request = requestAt(worker, 1);
    worker.emitMessage(errorResponse(request, code));
    await expect(rendered).rejects.toMatchObject({ code });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed responses, crashes, timeouts, disposal, and transport errors", async () => {
    const bundle = await fixtureBundle();

    const malformedWorker = new FakeWorker();
    const malformedClient = createClient(malformedWorker);
    await install(malformedClient, malformedWorker, bundle);
    const malformed = malformedClient.render({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    malformedWorker.emitMessage({ kind: "frame-presented", responseJson: new ArrayBuffer(1) });
    await expect(malformed).rejects.toMatchObject({ code: "protocol-violation" });
    expect(malformedWorker.terminate).toHaveBeenCalledOnce();

    const crashedWorker = new FakeWorker();
    const crashedClient = createClient(crashedWorker);
    const crashed = crashedClient.installScene({
      canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      revision: REVISION_A,
      snapshot: bundle,
    });
    crashedWorker.emitError("boom");
    await expect(crashed).rejects.toMatchObject({ code: "crashed" });
    expect(crashedWorker.terminate).toHaveBeenCalledOnce();

    const disposedWorker = new FakeWorker();
    const disposedClient = createClient(disposedWorker);
    const disposed = disposedClient.installScene({
      canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      revision: REVISION_A,
      snapshot: bundle,
    });
    disposedClient.dispose();
    await expect(disposed).rejects.toMatchObject({ code: "disposed" });
    expect(disposedWorker.terminate).toHaveBeenCalledOnce();

    const transportWorker = new FakeWorker();
    transportWorker.throwOnPost = true;
    const transportClient = createClient(transportWorker);
    await expect(
      transportClient.installScene({
        canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
        revision: REVISION_A,
        snapshot: bundle,
      }),
    ).rejects.toMatchObject({ code: "transport-failed" });
    expect(transportWorker.terminate).toHaveBeenCalledOnce();

    const renderTransportWorker = new FakeWorker();
    const renderTransportClient = createClient(renderTransportWorker);
    await install(renderTransportClient, renderTransportWorker, bundle);
    renderTransportWorker.throwOnPost = true;
    await expect(
      renderTransportClient.render({
        revision: REVISION_A,
        sampleTime: 1,
        viewport: { heightPx: 90, widthPx: 160 },
      }),
    ).rejects.toMatchObject({ code: "transport-failed" });
    expect(renderTransportWorker.terminate).toHaveBeenCalledOnce();

    const timeoutWorker = new FakeWorker();
    const timeoutClient = createClient(timeoutWorker, 10);
    const timedOut = timeoutClient.installScene({
      canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      revision: REVISION_A,
      snapshot: bundle,
    });
    const timeoutOutcome = timedOut.catch((error: unknown) => error as CanvasWorkerClientError);
    await expect(timeoutOutcome).resolves.toMatchObject({ code: "timeout" });
    expect(timeoutWorker.terminate).toHaveBeenCalledOnce();
  });

  it("fails closed on unknown and duplicate response IDs", async () => {
    const bundle = await fixtureBundle();

    const unknownWorker = new FakeWorker();
    const unknownClient = createClient(unknownWorker);
    await install(unknownClient, unknownWorker, bundle);
    const pending = unknownClient.render({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const pendingRequest = requestAt(unknownWorker, 1);
    if (pendingRequest.kind !== "render-frame") throw new Error("missing pending render");
    unknownWorker.emitMessage(presentedResponse({ ...pendingRequest, requestId: 99 }));
    await expect(pending).rejects.toMatchObject({ code: "protocol-violation" });
    expect(unknownWorker.terminate).toHaveBeenCalledOnce();

    const duplicateWorker = new FakeWorker();
    const duplicateClient = createClient(duplicateWorker);
    await install(duplicateClient, duplicateWorker, bundle);
    const rendered = duplicateClient.render({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const renderedRequest = requestAt(duplicateWorker, 1);
    if (renderedRequest.kind !== "render-frame") throw new Error("missing rendered frame");
    const response = presentedResponse(renderedRequest);
    duplicateWorker.emitMessage(response);
    await expect(rendered).resolves.toMatchObject({ requestId: renderedRequest.requestId });
    duplicateWorker.emitMessage(response);
    expect(duplicateWorker.terminate).toHaveBeenCalledOnce();
    expect(duplicateClient.revision).toBeNull();
  });

  it("does not restore ready after disposal races an install or replacement acknowledgement", async () => {
    const bundle = await fixtureBundle();

    const installWorker = new FakeWorker();
    const installClient = createClient(installWorker);
    const installing = installClient.installScene({
      canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      revision: REVISION_A,
      snapshot: bundle,
    });
    await vi.waitFor(() => expect(installWorker.posted).toHaveLength(1));
    const installRequest = requestAt(installWorker, 0);
    if (installRequest.kind !== "install-canvas") throw new Error("missing raced install request");
    installWorker.addEventListener("message", () => installClient.dispose());
    installWorker.emitMessage(readyResponse(installRequest));
    await expect(installing).rejects.toMatchObject({ code: "disposed" });
    expect(installClient.revision).toBeNull();

    const replaceWorker = new FakeWorker();
    const replaceClient = createClient(replaceWorker);
    await install(replaceClient, replaceWorker, bundle);
    const replacing = replaceClient.replaceScene({
      baseRevision: REVISION_A,
      revision: REVISION_B,
      snapshot: revisionBundle(bundle, REVISION_B),
    });
    await vi.waitFor(() => expect(replaceWorker.posted).toHaveLength(2));
    const replaceRequest = requestAt(replaceWorker, 1);
    if (replaceRequest.kind !== "replace-scene") throw new Error("missing raced replacement request");
    replaceWorker.addEventListener("message", () => replaceClient.dispose());
    replaceWorker.emitMessage(readyResponse(replaceRequest));
    await expect(replacing).rejects.toMatchObject({ code: "disposed" });
    expect(replaceClient.revision).toBeNull();
  });

  it("returns correlated stage telemetry without interleaving normal renders", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);

    const inFlight = client.render({ revision: REVISION_A, sampleTime: 0.5, viewport: { heightPx: 90, widthPx: 160 } });
    await expect(
      client.renderTelemetry({ revision: REVISION_A, sampleTime: 1, viewport: { heightPx: 90, widthPx: 160 } }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    const inFlightRequest = requestAt(worker, 1);
    if (inFlightRequest.kind !== "render-frame") throw new Error("missing in-flight render");
    worker.emitMessage(presentedResponse(inFlightRequest));
    await expect(inFlight).resolves.toMatchObject({ kind: "frame-presented" });

    const measured = client.renderTelemetry({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const telemetryRequest = requestAt(worker, 2);
    if (telemetryRequest.kind !== "render-frame-telemetry") throw new Error("missing telemetry render request");
    worker.emitMessage(presentedTelemetryResponse(telemetryRequest));
    await expect(measured).resolves.toMatchObject({
      kind: "frame-presented-telemetry",
      packetId: `canvas:${telemetryRequest.requestId}`,
      telemetry: measuredTelemetryFixtureV1(),
    });
    expect(worker.terminate).not.toHaveBeenCalled();
    client.dispose();
  });

  it("fails closed on uncorrelated telemetry and survives a missing telemetry ABI", async () => {
    const bundle = await fixtureBundle();

    const uncorrelatedWorker = new FakeWorker();
    const uncorrelatedClient = createClient(uncorrelatedWorker);
    await install(uncorrelatedClient, uncorrelatedWorker, bundle);
    const uncorrelated = uncorrelatedClient.renderTelemetry({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const uncorrelatedRequest = requestAt(uncorrelatedWorker, 1);
    if (uncorrelatedRequest.kind !== "render-frame-telemetry") throw new Error("missing telemetry request");
    uncorrelatedWorker.emitMessage(presentedTelemetryResponse(uncorrelatedRequest, { sampleTime: 99 }));
    await expect(uncorrelated).rejects.toMatchObject({ code: "protocol-violation" });
    expect(uncorrelatedWorker.terminate).toHaveBeenCalledOnce();

    const legacyWorker = new FakeWorker();
    const legacyClient = createClient(legacyWorker);
    await install(legacyClient, legacyWorker, bundle);
    const unavailable = legacyClient.renderTelemetry({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const unavailableRequest = requestAt(legacyWorker, 1);
    legacyWorker.emitMessage(errorResponse(unavailableRequest, "telemetry-unavailable"));
    await expect(unavailable).rejects.toMatchObject({ code: "telemetry-unavailable", fallback: "whole-scene" });
    expect(legacyWorker.terminate).not.toHaveBeenCalled();

    const next = legacyClient.render({
      revision: REVISION_A,
      sampleTime: 0.5,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    await vi.waitFor(() => expect(legacyWorker.posted).toHaveLength(3));
    const nextRequest = requestAt(legacyWorker, 2);
    if (nextRequest.kind !== "render-frame") throw new Error("missing render after telemetry rejection");
    legacyWorker.emitMessage(presentedResponse(nextRequest));
    await expect(next).resolves.toMatchObject({ sampleTime: 0.5 });
    legacyClient.dispose();
  });

  it.each(["surface-lost", "gpu-validation", "device-lost", "gpu-internal"] as const)(
    "surfaces a failed %s telemetry frame as a typed error that keeps partial telemetry",
    async (code) => {
      const bundle = await fixtureBundle();
      const worker = new FakeWorker();
      const client = createClient(worker);
      await install(client, worker, bundle);

      const failing = client.renderTelemetry({
        revision: REVISION_A,
        sampleTime: 1,
        viewport: { heightPx: 90, widthPx: 160 },
      });
      const outcome = failing.catch((error: unknown) => error);
      const request = requestAt(worker, 1);
      if (request.kind !== "render-frame-telemetry") throw new Error("missing telemetry request");
      worker.emitMessage({
        error: {
          code,
          message: `${code} while rendering telemetry`,
          packetId: `canvas:${request.requestId}`,
          sampleTime: request.sampleTime,
          viewport: request.viewport,
        },
        kind: "frame-telemetry-failed",
        requestId: request.requestId,
        revision: request.revision,
        schema: "poietra.canvas-worker-response",
        telemetry: measuredTelemetryFixtureV1(),
        version: 1,
      });
      const error = await outcome;
      expect(error).toBeInstanceOf(CanvasTelemetryRenderError);
      const typed = error as CanvasTelemetryRenderError;
      expect(typed.code).toBe(code);
      expect(typed.telemetry).toEqual(measuredTelemetryFixtureV1());
      expect(typed.errorCorrelation.packetId).toBe(`canvas:${request.requestId}`);
      client.dispose();
    },
  );

  it("keeps telemetry and adapter evidence mutually exclusive with every other operation", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createEvidenceClient(worker);
    await install(client, worker, bundle);

    const inFlight = client.renderTelemetry({
      revision: REVISION_A,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const telemetryRequest = requestAt(worker, 1);
    if (telemetryRequest.kind !== "render-frame-telemetry") throw new Error("missing telemetry request");

    // Every concurrent operation rejects synchronously with invalid-state.
    await expect(
      client.renderTelemetry({ revision: REVISION_A, sampleTime: 0.5, viewport: { heightPx: 90, widthPx: 160 } }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.render({ revision: REVISION_A, sampleTime: 0.5, viewport: { heightPx: 90, widthPx: 160 } }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.replaceScene({
        baseRevision: REVISION_A,
        revision: REVISION_B,
        snapshot: revisionBundle(bundle, REVISION_B),
      }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(client.collectAdapterEvidence()).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.captureFrameEvidence({ revision: REVISION_A, samples: [{ fractionX: 0, fractionY: 0 }] }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    // Nothing beyond the telemetry request reached the worker.
    expect(worker.posted).toHaveLength(2);

    worker.emitMessage(presentedTelemetryResponse(telemetryRequest));
    await expect(inFlight).resolves.toMatchObject({ kind: "frame-presented-telemetry" });

    // After settling, every operation recovers.
    const evidenceRequest = client.collectAdapterEvidence();
    const collect = requestAt(worker, 2);
    if (collect.kind !== "collect-adapter-evidence") throw new Error("missing evidence request");

    // Adapter collection owns the same exclusive-operation slot as telemetry.
    await expect(client.collectAdapterEvidence()).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.renderTelemetry({ revision: REVISION_A, sampleTime: 0.5, viewport: { heightPx: 90, widthPx: 160 } }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.render({ revision: REVISION_A, sampleTime: 0.5, viewport: { heightPx: 90, widthPx: 160 } }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.replaceScene({
        baseRevision: REVISION_A,
        revision: REVISION_B,
        snapshot: revisionBundle(bundle, REVISION_B),
      }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.captureFrameEvidence({ revision: REVISION_A, samples: [{ fractionX: 0, fractionY: 0 }] }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    expect(worker.posted).toHaveLength(3);

    worker.emitMessage({
      evidence: adapterEvidenceFixtureV1(),
      kind: "adapter-evidence",
      requestId: collect.requestId,
      revision: collect.revision,
      schema: "poietra.canvas-worker-response",
      version: 1,
    });
    await expect(evidenceRequest).resolves.toMatchObject({ kind: "adapter-evidence" });

    const frameEvidence = client.captureFrameEvidence({
      revision: REVISION_A,
      samples: [{ fractionX: 0, fractionY: 0 }],
    });
    const capture = captureRequestAt(worker, 3);
    await expect(
      client.renderTelemetry({ revision: REVISION_A, sampleTime: 0.5, viewport: { heightPx: 90, widthPx: 160 } }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(client.collectAdapterEvidence()).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.render({ revision: REVISION_A, sampleTime: 0.5, viewport: { heightPx: 90, widthPx: 160 } }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.replaceScene({
        baseRevision: REVISION_A,
        revision: REVISION_B,
        snapshot: revisionBundle(bundle, REVISION_B),
      }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    worker.emitMessage(evidenceResponse(capture));
    await expect(frameEvidence).resolves.toMatchObject({ kind: "frame-evidence" });

    const next = client.render({ revision: REVISION_A, sampleTime: 0.25, viewport: { heightPx: 90, widthPx: 160 } });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(5));
    const nextRequest = requestAt(worker, 4);
    if (nextRequest.kind !== "render-frame") throw new Error("missing recovered render");
    await expect(client.collectAdapterEvidence()).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      client.captureFrameEvidence({ revision: REVISION_A, samples: [{ fractionX: 0, fractionY: 0 }] }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    expect(worker.posted).toHaveLength(5);
    worker.emitMessage(presentedResponse(nextRequest));
    await expect(next).resolves.toMatchObject({ kind: "frame-presented" });
    client.dispose();
  });

  it("collects Worker adapter evidence for the installed revision", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);

    const collecting = client.collectAdapterEvidence();
    const request = requestAt(worker, 1);
    if (request.kind !== "collect-adapter-evidence") throw new Error("missing adapter evidence request");
    expect(request.revision).toBe(REVISION_A);
    worker.emitMessage({
      evidence: adapterEvidenceFixtureV1(),
      kind: "adapter-evidence",
      requestId: request.requestId,
      revision: request.revision,
      schema: "poietra.canvas-worker-response",
      version: 1,
    });
    await expect(collecting).resolves.toMatchObject({
      evidence: adapterEvidenceFixtureV1(),
      kind: "adapter-evidence",
    });
    client.dispose();

    await expect(client.collectAdapterEvidence()).rejects.toMatchObject({ code: "invalid-state" });
  });

  it("rejects invalid state through the Promise API and validates origin before transferring", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await expect(
      client.render({
        revision: REVISION_A,
        sampleTime: 1,
        viewport: { heightPx: 90, widthPx: 160 },
      }),
    ).rejects.toMatchObject({ code: "invalid-state" });

    const crossOriginWorker = new FakeWorker();
    const crossOriginClient = createClient(crossOriginWorker, 5_000, "https://attacker.test/poietra_wasm.js");
    const canvas = new FakeCanvas();
    await expect(
      crossOriginClient.installScene({
        canvas: canvas as unknown as HTMLCanvasElement,
        revision: REVISION_A,
        snapshot: bundle,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(canvas.transferControlToOffscreen).not.toHaveBeenCalled();
    expect(crossOriginWorker.posted).toHaveLength(0);

    const oversizedUrlWorker = new FakeWorker();
    const oversizedUrlClient = createClient(oversizedUrlWorker, 5_000, `/${"a".repeat(2_048)}.js`);
    const oversizedUrlCanvas = new FakeCanvas();
    await expect(
      oversizedUrlClient.installScene({
        canvas: oversizedUrlCanvas as unknown as HTMLCanvasElement,
        revision: REVISION_A,
        snapshot: bundle,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(oversizedUrlCanvas.transferControlToOffscreen).not.toHaveBeenCalled();
    expect(oversizedUrlWorker.posted).toHaveLength(0);
    oversizedUrlClient.dispose();
    crossOriginClient.dispose();
    client.dispose();
  });

  function createEvidenceClient(worker: FakeWorker) {
    return new PoietraCanvasWorkerClient({
      evidence: createCanvasWorkerClientEvidenceAdapterV1(),
      requestTimeoutMs: 5_000,
      wasmModuleUrl: "./engine-wasm/poietra_wasm.js",
      workerFactory: () => worker as unknown as Worker,
    });
  }

  function captureRequestAt(worker: FakeWorker, index: number) {
    return captureFrameEvidenceRequestV1Schema.parse(worker.posted[index]?.message);
  }

  function evidenceResponse(
    request: ReturnType<typeof captureRequestAt>,
    overrides: Readonly<Record<string, unknown>> = {},
  ): CanvasWorkerResponseV1 {
    return {
      kind: "frame-evidence",
      packetId: "canvas:2",
      requestId: request.requestId,
      revision: request.revision,
      sampleTime: 1,
      samples: [[1, 2, 3, 255]],
      schema: "poietra.canvas-worker-response",
      surfaceFormat: "rgba8unorm",
      version: 1,
      viewport: { heightPx: 90, widthPx: 160 },
      ...overrides,
    } as unknown as CanvasWorkerResponseV1;
  }

  it("refuses frame evidence relabeled for a different Scene revision", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createEvidenceClient(worker);
    await install(client, worker, bundle);
    const capturing = client.captureFrameEvidence({ revision: REVISION_A, samples: [{ fractionX: 0, fractionY: 0 }] });
    worker.emitMessage(evidenceResponse(captureRequestAt(worker, 1), { revision: REVISION_B }));
    await expect(capturing).rejects.toMatchObject({ code: "protocol-violation" });
    client.dispose();
  });

  it("injects device loss through one correlated dev-only request without transferring Scene data", async () => {
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createEvidenceClient(worker);
    await install(client, worker, bundle);

    const injecting = client.injectDeviceLossForTest({ failRecovery: true });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
    const posted = worker.posted[1];
    const request = injectCanvasDeviceLossRequestV1Schema.parse(posted?.message);
    expect(request.failRecovery).toBe(true);
    expect(posted?.transfer).toEqual([]);
    worker.emitMessage({
      kind: "canvas-device-loss-injected",
      reason: "destroyed",
      requestId: request.requestId,
      revision: request.revision,
      schema: "poietra.canvas-worker-response",
      version: 1,
    });
    await expect(injecting).resolves.toBeUndefined();
    expect(client.revision).toBe(REVISION_A);

    const rendered = client.render({ revision: REVISION_A, sampleTime: 1, viewport: { heightPx: 90, widthPx: 160 } });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(3));
    const renderRequest = requestAt(worker, 2);
    if (renderRequest.kind !== "render-frame") throw new Error("missing render after device-loss injection");
    worker.emitMessage(presentedResponse(renderRequest));
    await expect(rendered).resolves.toMatchObject({ revision: REVISION_A });
    client.dispose();
  });

  it("binds evidence to the replace lifecycle: a successful replace invalidates the old revision's evidence", async () => {
    const bundle = await fixtureBundle();
    const replacement = revisionBundle(bundle, REVISION_B);
    const worker = new FakeWorker();
    const client = createEvidenceClient(worker);
    await install(client, worker, bundle);

    const replacing = client.replaceScene({ baseRevision: REVISION_A, revision: REVISION_B, snapshot: replacement });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
    const replaceRequest = requestAt(worker, 1);
    if (replaceRequest.kind !== "replace-scene") throw new Error("missing replacement request");
    worker.emitMessage(readyResponse(replaceRequest));
    await replacing;

    // Evidence for the replaced revision is refused client-side without ever
    // reaching the worker.
    await expect(
      client.captureFrameEvidence({ revision: REVISION_A, samples: [{ fractionX: 0, fractionY: 0 }] }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    expect(worker.posted).toHaveLength(2);

    // Evidence for the new revision reaches the worker, which refuses until a
    // frame of the new Scene has committed.
    const capturing = client.captureFrameEvidence({ revision: REVISION_B, samples: [{ fractionX: 0, fractionY: 0 }] });
    const request = captureRequestAt(worker, 2);
    expect(request.revision).toBe(REVISION_B);
    worker.emitMessage(errorResponse(request as unknown as CanvasWorkerRequestV1, "invalid-state"));
    await expect(capturing).rejects.toMatchObject({ code: "invalid-state" });
    client.dispose();
  });

  it("keeps serving the base revision's evidence after an atomically rejected replace", async () => {
    const bundle = await fixtureBundle();
    const replacement = revisionBundle(bundle, REVISION_B);
    const worker = new FakeWorker();
    const client = createEvidenceClient(worker);
    await install(client, worker, bundle);

    const replacing = client.replaceScene({ baseRevision: REVISION_A, revision: REVISION_B, snapshot: replacement });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
    const replaceRequest = requestAt(worker, 1);
    worker.emitMessage(errorResponse(replaceRequest, "snapshot-rejected"));
    await expect(replacing).rejects.toMatchObject({ code: "snapshot-rejected" });

    // The Scene and surface are unchanged, so the old evidence stays valid.
    const capturing = client.captureFrameEvidence({ revision: REVISION_A, samples: [{ fractionX: 0, fractionY: 0 }] });
    worker.emitMessage(evidenceResponse(captureRequestAt(worker, 2)));
    await expect(capturing).resolves.toMatchObject({ kind: "frame-evidence", revision: REVISION_A });
    client.dispose();
  });
});
