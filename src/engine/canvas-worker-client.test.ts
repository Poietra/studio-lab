import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CanvasWorkerClientError,
  PoietraCanvasWorkerClient,
  type PresentedCanvasFrameV1,
} from "./canvas-worker-client";
import {
  type CanvasWorkerRequestV1,
  type CanvasWorkerResponseV1,
  canvasWorkerRequestV1Schema,
} from "./canvas-worker-protocol";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "./contracts";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);

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
  request: Exclude<CanvasWorkerRequestV1, Readonly<{ kind: "render-frame" }>>,
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
    expect(worker.posted[0]?.transfer).toEqual([installRequest.canvas, installRequest.snapshotJson]);

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
      snapshot: replacement,
    });
    await expect(renderOutcome).resolves.toMatchObject({ code: "stale-response" });

    const replaceRequest = requestAt(worker, 2);
    if (replaceRequest.kind !== "replace-scene") throw new Error("missing replacement request");
    expect(worker.posted[2]?.transfer).toEqual([replaceRequest.snapshotJson]);
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

    vi.useFakeTimers();
    const timeoutWorker = new FakeWorker();
    const timeoutClient = createClient(timeoutWorker, 10);
    const timedOut = timeoutClient.installScene({
      canvas: new FakeCanvas() as unknown as HTMLCanvasElement,
      revision: REVISION_A,
      snapshot: bundle,
    });
    const timeoutOutcome = timedOut.catch((error: unknown) => error as CanvasWorkerClientError);
    await vi.advanceTimersByTimeAsync(10);
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
    const replaceRequest = requestAt(replaceWorker, 1);
    if (replaceRequest.kind !== "replace-scene") throw new Error("missing raced replacement request");
    replaceWorker.addEventListener("message", () => replaceClient.dispose());
    replaceWorker.emitMessage(readyResponse(replaceRequest));
    await expect(replacing).rejects.toMatchObject({ code: "disposed" });
    expect(replaceClient.revision).toBeNull();
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
});
