import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "./contracts";
import { PoietraPreviewWorkerClient, type PreviewWorkerClientError } from "./preview-worker-client";
import {
  type PreviewWorkerRequestV1,
  type PreviewWorkerResponseV1,
  previewWorkerRequestV1Schema,
} from "./preview-worker-protocol";
import { compileEngineFrameV1 } from "./reference-evaluator";

const REVISION = "a".repeat(64);

type PostedMessage = Readonly<{ message: unknown; transfer: readonly Transferable[] }>;

class FakeWorker {
  readonly posted: PostedMessage[] = [];
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

  postMessage(message: unknown, transfer: readonly Transferable[] = []) {
    this.posted.push({ message, transfer });
  }

  emitMessage(data: PreviewWorkerResponseV1) {
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
  return previewWorkerRequestV1Schema.parse(worker.posted[index]?.message);
}

function sceneReady(request: PreviewWorkerRequestV1): PreviewWorkerResponseV1 {
  if (request.kind === "sample") throw new Error("expected a Scene mutation request");
  return {
    kind: "scene-ready",
    operation: request.kind === "install-scene" ? "install" : "replace",
    requestId: request.requestId,
    revision: request.revision,
    schema: "poietra.preview-worker-response",
    version: 1,
  };
}

function jsonBuffer(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

async function fixtureBundle(): Promise<SceneIrBundleV1> {
  const url = new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
  const fixture = JSON.parse(await readFile(url, "utf8")) as Readonly<{ assets: unknown; scene: unknown }>;
  return sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
}

async function engineResponse(bundle: SceneIrBundleV1, request: Extract<PreviewWorkerRequestV1, { kind: "sample" }>) {
  const compiled = await compileEngineFrameV1({
    assets: bundle.assets,
    evidence: ["Poietra WASM preview worker v1"],
    packetId: `preview:${request.requestId}`,
    sampleTime: request.sampleTime,
    scene: bundle.scene,
    viewport: request.viewport,
  });
  if (compiled.kind !== "ready") throw new Error(compiled.message);
  return jsonBuffer({
    result: { kind: "ready", packet: compiled.frame.packet },
    schema: "poietra.engine-worker-response",
    version: 1,
  });
}

function createClient(worker: FakeWorker, requestTimeoutMs = 5_000) {
  return new PoietraPreviewWorkerClient({
    requestTimeoutMs,
    wasmModuleUrl: "./engine-wasm/poietra_wasm.js",
    workerFactory: () => worker as unknown as Worker,
  });
}

async function install(client: PoietraPreviewWorkerClient, worker: FakeWorker, bundle: SceneIrBundleV1) {
  const installed = client.installScene({ revision: REVISION, snapshot: bundle });
  const request = requestAt(worker, 0);
  expect(request.kind).toBe("install-scene");
  worker.emitMessage(sceneReady(request));
  await installed;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Poietra preview worker client", () => {
  it("installs the snapshot once and returns a correlated RenderPacket", async () => {
    vi.stubGlobal("location", { href: "https://studio.test/app/" });
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);

    await install(client, worker, bundle);
    const installRequest = requestAt(worker, 0);
    expect(installRequest.kind).toBe("install-scene");
    if (installRequest.kind !== "install-scene") throw new Error("missing install request");
    expect(installRequest.wasmModuleUrl).toBe("https://studio.test/app/engine-wasm/poietra_wasm.js");
    expect(worker.posted[0].transfer).toEqual([installRequest.snapshotJson]);

    const sampled = client.sample({
      revision: REVISION,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const sampleRequest = requestAt(worker, 1);
    expect(sampleRequest).toMatchObject({ kind: "sample", sampleTime: 1, viewport: { heightPx: 90, widthPx: 160 } });
    expect(sampleRequest).not.toHaveProperty("snapshotJson");
    expect(sampleRequest).not.toHaveProperty("evidence");
    if (sampleRequest.kind !== "sample") throw new Error("missing sample request");
    const responseJson = await engineResponse(bundle, sampleRequest);
    worker.emitMessage({
      kind: "sample-response",
      requestId: sampleRequest.requestId,
      responseJson,
      revision: REVISION,
      schema: "poietra.preview-worker-response",
      version: 1,
    });

    await expect(sampled).resolves.toMatchObject({ packetId: `preview:${sampleRequest.requestId}`, sampleTime: 1 });
    client.dispose();
  });

  it("keeps one sample in flight and coalesces queued playheads to the latest", async () => {
    vi.stubGlobal("location", { href: "https://studio.test/" });
    const bundle = await fixtureBundle();
    const worker = new FakeWorker();
    const client = createClient(worker);
    await install(client, worker, bundle);

    const first = client.sample({ revision: REVISION, sampleTime: 0.25, viewport: { heightPx: 90, widthPx: 160 } });
    const firstOutcome = first.catch((error: unknown) => error as PreviewWorkerClientError);
    const second = client.sample({ revision: REVISION, sampleTime: 0.5, viewport: { heightPx: 90, widthPx: 160 } });
    const secondOutcome = second.catch((error: unknown) => error as PreviewWorkerClientError);
    const latest = client.sample({ revision: REVISION, sampleTime: 1, viewport: { heightPx: 90, widthPx: 160 } });

    expect(worker.posted).toHaveLength(2);
    await expect(firstOutcome).resolves.toMatchObject({ code: "stale-response" });
    await expect(secondOutcome).resolves.toMatchObject({ code: "stale-response" });

    const firstRequest = requestAt(worker, 1);
    if (firstRequest.kind !== "sample") throw new Error("missing first sample");
    worker.emitMessage({
      kind: "sample-response",
      requestId: firstRequest.requestId,
      responseJson: new Uint8Array([0xff]).buffer,
      revision: REVISION,
      schema: "poietra.preview-worker-response",
      version: 1,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(3));

    const latestRequest = requestAt(worker, 2);
    if (latestRequest.kind !== "sample") throw new Error("missing latest sample");
    expect(latestRequest.sampleTime).toBe(1);
    const responseJson = await engineResponse(bundle, latestRequest);
    worker.emitMessage({
      kind: "sample-response",
      requestId: latestRequest.requestId,
      responseJson,
      revision: REVISION,
      schema: "poietra.preview-worker-response",
      version: 1,
    });
    await expect(latest).resolves.toMatchObject({ sampleTime: 1 });
    client.dispose();
  });

  it("fails closed on malformed engine bytes, worker crashes, timeouts, and disposal", async () => {
    vi.stubGlobal("location", { href: "https://studio.test/" });
    const bundle = await fixtureBundle();

    const malformedWorker = new FakeWorker();
    const malformedClient = createClient(malformedWorker);
    await install(malformedClient, malformedWorker, bundle);
    const malformed = malformedClient.sample({
      revision: REVISION,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    });
    const malformedRequest = requestAt(malformedWorker, 1);
    malformedWorker.emitMessage({
      kind: "sample-response",
      requestId: malformedRequest.requestId,
      responseJson: new Uint8Array([0xff]).buffer,
      revision: REVISION,
      schema: "poietra.preview-worker-response",
      version: 1,
    });
    await expect(malformed).rejects.toMatchObject({ code: "protocol-violation" });
    expect(malformedWorker.terminate).toHaveBeenCalledOnce();

    const crashedWorker = new FakeWorker();
    const crashedClient = createClient(crashedWorker);
    const crashed = crashedClient.installScene({ revision: REVISION, snapshot: bundle });
    crashedWorker.emitError("boom");
    await expect(crashed).rejects.toMatchObject({ code: "crashed" });
    expect(crashedWorker.terminate).toHaveBeenCalledOnce();

    const disposedWorker = new FakeWorker();
    const disposedClient = createClient(disposedWorker);
    const disposed = disposedClient.installScene({ revision: REVISION, snapshot: bundle });
    disposedClient.dispose();
    await expect(disposed).rejects.toMatchObject({ code: "disposed" });
    expect(disposedWorker.terminate).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    const timeoutWorker = new FakeWorker();
    const timeoutClient = createClient(timeoutWorker, 10);
    const timedOut = timeoutClient.installScene({ revision: REVISION, snapshot: bundle });
    const timeoutOutcome = timedOut.catch((error: unknown) => error as PreviewWorkerClientError);
    await vi.advanceTimersByTimeAsync(10);
    await expect(timeoutOutcome).resolves.toMatchObject({ code: "timeout" });
    expect(timeoutWorker.terminate).toHaveBeenCalledOnce();
  });
});
