import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BROWSER_MP4_EXPORT_PROFILE, runBrowserMp4ExportV1 } from "./browser-mp4-export";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "./contracts";
import {
  type ExportProgressV1,
  type ExportWorkerResponseV1,
  exportWorkerRequestV1Schema,
} from "./export-worker-protocol";

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

async function fixtureBundle(): Promise<SceneIrBundleV1> {
  const url = new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
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
      audioWav,
      profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      snapshot: bundle,
      workerFactory: () => worker as unknown as Worker,
    });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const request = exportWorkerRequestV1Schema.parse(worker.posted[0]);
    if (request.kind !== "export-mp4") throw new Error("missing export request");
    expect(new Uint8Array(request.audioWav ?? new ArrayBuffer(0))).toEqual(new Uint8Array(audioWav));
    expect(worker.transfers[0]).toEqual([audioWav]);
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
