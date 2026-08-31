import { describe, expect, it, vi } from "vitest";

import {
  type BrowserMp4ExportWasmBindingsV1,
  BrowserMp4ExportWorkerRuntimeV1,
  initializeBrowserMp4ExportBindingsV1,
} from "./browser-mp4-export.worker";
import type { ExportWorkerRequestV1, ExportWorkerResponseV1 } from "./export-worker-protocol";

const SCOPE_URL = "https://studio.example/worker";

const encoder = new TextEncoder();

function progressEnvelope(framesEncoded: number, frameCount = 2) {
  return encoder.encode(
    JSON.stringify({
      result: { encodedMediaBytes: framesEncoded * 64, frameCount, framesEncoded, kind: "progress" },
      schema: "poietra.browser-export-progress",
      version: 1,
    }),
  );
}

function refusedRejection(reason: string, message: string) {
  const error = new Error(`${reason}: ${message}`);
  error.name = "PoietraBrowserMp4ExportRefused";
  return error;
}

function exportRequest(overrides: Partial<Extract<ExportWorkerRequestV1, { kind: "export-mp4" }>> = {}) {
  return {
    assetPayloads: [],
    kind: "export-mp4",
    profileJson: encoder.encode(JSON.stringify({ fixture: "profile" })).buffer,
    requestId: 7,
    schema: "poietra.export-worker-request",
    snapshotJson: encoder.encode(JSON.stringify({ fixture: "snapshot" })).buffer,
    version: 1,
    wasmModuleUrl: "https://studio.example/engine-wasm/poietra_wasm.js",
    ...overrides,
  } satisfies ExportWorkerRequestV1;
}

function cancelRequest(requestId = 7) {
  return {
    kind: "export-cancel",
    requestId,
    schema: "poietra.export-worker-request",
    version: 1,
  } satisfies ExportWorkerRequestV1;
}

function runtimeWith(
  exportSceneMp4V1: BrowserMp4ExportWasmBindingsV1["exportSceneMp4V1"],
  exportSceneMp4WithWavV1?: BrowserMp4ExportWasmBindingsV1["exportSceneMp4WithWavV1"],
) {
  const posted: { response: ExportWorkerResponseV1; transfer?: readonly ArrayBuffer[] }[] = [];
  const runtime = new BrowserMp4ExportWorkerRuntimeV1({
    loadWasm: async () => ({ exportSceneMp4V1, ...(exportSceneMp4WithWavV1 ? { exportSceneMp4WithWavV1 } : {}) }),
    postMessage: (response, transfer) => posted.push({ response, ...(transfer ? { transfer } : {}) }),
    scopeUrl: SCOPE_URL,
  });
  return { posted, runtime };
}

describe("BrowserMp4ExportWorkerRuntimeV1", () => {
  it("rejects protocol violations with a bounded error response", async () => {
    const { posted, runtime } = runtimeWith(async () => new Uint8Array([1]));
    await runtime.accept({ kind: "export-mp4" });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.response).toMatchObject({ kind: "export-error", requestId: null });
  });

  it("refuses cross-origin WASM module URLs by name without loading anything", async () => {
    const load = vi.fn(async () => new Uint8Array([1]));
    const { posted, runtime } = runtimeWith(load);
    await runtime.accept(exportRequest({ wasmModuleUrl: "https://evil.example/poietra_wasm.js" }));
    expect(posted[0]?.response).toMatchObject({ kind: "export-refused", reason: "invalid-request", requestId: 7 });
    expect(load).not.toHaveBeenCalled();
  });

  it("streams progress envelopes and transfers the finished MP4 exactly once", async () => {
    const output = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
    const { posted, runtime } = runtimeWith(
      async (
        _snapshot,
        _profile,
        _metadata,
        _assets,
        progress,
        _fragmentMaterialRegistryJson,
        scenePostEffectRegistryJson,
      ) => {
        expect(JSON.parse(new TextDecoder().decode(scenePostEffectRegistryJson))).toEqual({
          effects: [],
          schema: "poietra.scene-post-effect-registry",
          version: 1,
        });
        expect(progress?.(progressEnvelope(1))).toBeUndefined();
        expect(progress?.(progressEnvelope(2))).toBeUndefined();
        return output;
      },
    );
    await runtime.accept(exportRequest());
    expect(posted.map(({ response }) => response.kind)).toEqual([
      "export-progress",
      "export-progress",
      "export-finished",
    ]);
    const first = posted[0];
    if (first?.response.kind !== "export-progress") throw new Error("missing progress response");
    expect(first.response.progress).toEqual({
      encodedMediaBytes: 64,
      frameCount: 2,
      framesEncoded: 1,
      kind: "progress",
    });
    const finished = posted[2];
    if (finished?.response.kind !== "export-finished") throw new Error("missing finished response");
    expect(new Uint8Array(finished.response.bytes)).toEqual(output);
    expect(finished.transfer).toEqual([finished.response.bytes]);
  });

  it("passes project material and Scene post-effect registries unchanged into the video export entry", async () => {
    const fragmentRegistry = encoder.encode(
      JSON.stringify({
        materials: [{ revision: 1, shaderId: "project-wave", source: "@fragment fn fs_main() {}" }],
        schema: "poietra.fragment-material-registry",
        version: 1,
      }),
    );
    const scenePostEffectRegistry = encoder.encode(
      JSON.stringify({
        effects: [{ revision: 1, shaderId: "project-scene-post-effect", source: "@fragment fn fs_main() {}" }],
        schema: "poietra.scene-post-effect-registry",
        version: 1,
      }),
    );
    const videoOnly = vi.fn(
      async (
        _snapshot,
        _profile,
        _metadata,
        _assets,
        _progress,
        fragmentMaterialRegistryJson,
        scenePostEffectRegistryJson,
      ) => {
        expect(fragmentMaterialRegistryJson).toEqual(fragmentRegistry);
        expect(scenePostEffectRegistryJson).toEqual(scenePostEffectRegistry);
        return new Uint8Array([1]);
      },
    );
    const { runtime } = runtimeWith(videoOnly);

    await runtime.accept(
      exportRequest({
        fragmentMaterialRegistryJson: fragmentRegistry.buffer,
        scenePostEffectRegistryJson: scenePostEffectRegistry.buffer,
      }),
    );

    expect(videoOnly).toHaveBeenCalledOnce();
  });

  it("uses the audio export entry only when a WAV attachment is present", async () => {
    const videoOnly = vi.fn(async () => new Uint8Array([1]));
    const withWav = vi.fn(
      async (
        _snapshot,
        _profile,
        _metadata,
        _assets,
        wav: Uint8Array,
        _progress,
        _fragmentMaterials,
        _scenePostEffects,
        audioTiming: Uint8Array | undefined,
      ) => {
        expect(wav).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
        expect(JSON.parse(new TextDecoder().decode(audioTiming))).toEqual({
          timelineOffsetSampleFrames: 4_800,
          trimEndSampleFrames: null,
          trimStartSampleFrames: 2_400,
        });
        return new Uint8Array([1, 2, 3]);
      },
    );
    const { posted, runtime } = runtimeWith(videoOnly, withWav);
    await runtime.accept(
      exportRequest({
        audioTiming: {
          timelineOffsetSampleFrames: 4_800,
          trimEndSampleFrames: null,
          trimStartSampleFrames: 2_400,
        },
        audioWav: new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
      }),
    );
    expect(videoOnly).not.toHaveBeenCalled();
    expect(withWav).toHaveBeenCalledOnce();
    expect(posted.at(-1)?.response.kind).toBe("export-finished");
  });

  it("refuses audio explicitly when the loaded engine lacks the WAV entry", async () => {
    const videoOnly = vi.fn(async () => new Uint8Array([1]));
    const { posted, runtime } = runtimeWith(videoOnly);
    await runtime.accept(exportRequest({ audioWav: new Uint8Array([1]).buffer }));
    expect(videoOnly).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.response).toMatchObject({ kind: "export-refused", reason: "api-unavailable" });
  });

  it("refuses timeline timing without a WAV attachment", async () => {
    const videoOnly = vi.fn(async () => new Uint8Array([1]));
    const { posted, runtime } = runtimeWith(videoOnly);
    await runtime.accept(
      exportRequest({
        audioTiming: {
          timelineOffsetSampleFrames: 4_800,
          trimEndSampleFrames: null,
          trimStartSampleFrames: 0,
        },
      }),
    );
    expect(videoOnly).not.toHaveBeenCalled();
    expect(posted[0]?.response).toMatchObject({ kind: "export-refused", reason: "invalid-request" });
  });

  it("relays a malformed progress envelope as nothing, never as a crash", async () => {
    const output = new Uint8Array([1, 2, 3]);
    const { posted, runtime } = runtimeWith(async (_snapshot, _profile, _metadata, _assets, progress) => {
      progress?.(encoder.encode("{not json"));
      progress?.(new Uint8Array());
      return output;
    });
    await runtime.accept(exportRequest());
    expect(posted.map(({ response }) => response.kind)).toEqual(["export-finished"]);
  });

  it("maps a named Rust rejection onto the closed refusal vocabulary", async () => {
    const { posted, runtime } = runtimeWith(async () => {
      throw refusedRejection("non-monotonic-chunk-timestamps", "chunk 5 went backwards");
    });
    await runtime.accept(exportRequest());
    expect(posted).toHaveLength(1);
    expect(posted[0]?.response).toMatchObject({
      kind: "export-refused",
      reason: "non-monotonic-chunk-timestamps",
      requestId: 7,
    });
  });

  it("cancels mid-export through the progress callback with the named cancelled refusal", async () => {
    let cancelObserved = false;
    const { posted, runtime } = runtimeWith(async (_snapshot, _profile, _metadata, _assets, progress) => {
      // The cancel request arrives while the Rust export loop is running.
      await runtime.accept(cancelRequest());
      cancelObserved = progress?.(progressEnvelope(1)) === false;
      // The Rust loop observes the `false` return, discards everything, and
      // rejects with the named cancelled refusal.
      throw refusedRejection("cancelled", "the export was cancelled after frame 1 of 2");
    });
    await runtime.accept(exportRequest());
    expect(cancelObserved).toBe(true);
    const last = posted.at(-1);
    expect(last?.response).toMatchObject({
      kind: "export-refused",
      message: "cancelled: the export was cancelled after frame 1 of 2",
      reason: "cancelled",
      requestId: 7,
    });
    expect(posted.filter(({ response }) => response.kind === "export-finished")).toHaveLength(0);
  });

  it("honors a cancel that landed while the WASM module was loading", async () => {
    const posted: { response: ExportWorkerResponseV1 }[] = [];
    const exportSceneMp4V1 = vi.fn(async () => new Uint8Array([1]));
    const runtime = new BrowserMp4ExportWorkerRuntimeV1({
      loadWasm: async () => {
        await runtime.accept(cancelRequest());
        return { exportSceneMp4V1 };
      },
      postMessage: (response) => posted.push({ response }),
      scopeUrl: SCOPE_URL,
    });
    await runtime.accept(exportRequest());
    expect(posted).toHaveLength(1);
    expect(posted[0]?.response).toMatchObject({ kind: "export-refused", reason: "cancelled", requestId: 7 });
    expect(exportSceneMp4V1).not.toHaveBeenCalled();
  });

  it("ignores a cancel request for a foreign requestId", async () => {
    const output = new Uint8Array([1]);
    const { posted, runtime } = runtimeWith(async (_snapshot, _profile, _metadata, _assets, progress) => {
      await runtime.accept(cancelRequest(999));
      expect(progress?.(progressEnvelope(1))).toBeUndefined();
      return output;
    });
    await runtime.accept(exportRequest());
    expect(posted.at(-1)?.response.kind).toBe("export-finished");
  });

  it("discards finished bytes when a cancellation raced the final muxing", async () => {
    const { posted, runtime } = runtimeWith(async () => {
      // The run resolves with complete bytes, but the user cancelled while the
      // container was finalizing: nothing may leave the worker.
      await runtime.accept(cancelRequest());
      return new Uint8Array([1, 2, 3]);
    });
    await runtime.accept(exportRequest());
    expect(posted).toHaveLength(1);
    expect(posted[0]?.response).toMatchObject({ kind: "export-refused", reason: "cancelled", requestId: 7 });
  });

  it("processes a cancel task queued while synchronous final muxing blocked the worker", async () => {
    let finishMux: ((bytes: Uint8Array) => void) | undefined;
    let exportStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      exportStarted = resolve;
    });
    const muxed = new Promise<Uint8Array>((resolve) => {
      finishMux = resolve;
    });
    const { posted, runtime } = runtimeWith(async () => {
      exportStarted?.();
      return muxed;
    });
    const run = runtime.accept(exportRequest());
    await started;
    const cancelProcessed = new Promise<void>((resolve) => {
      setTimeout(() => void runtime.accept(cancelRequest()).then(resolve), 0);
    });
    finishMux?.(new Uint8Array([1, 2, 3]));
    await Promise.all([run, cancelProcessed]);

    expect(posted).toHaveLength(1);
    expect(posted[0]?.response).toMatchObject({ kind: "export-refused", reason: "cancelled", requestId: 7 });
    expect(posted.some(({ response }) => response.kind === "export-finished")).toBe(false);
  });

  it("fails closed on an empty finished output", async () => {
    const { posted, runtime } = runtimeWith(async () => new Uint8Array());
    await runtime.accept(exportRequest());
    expect(posted[0]?.response).toMatchObject({ kind: "export-error", requestId: 7 });
  });

  it("refuses a second concurrent export by name", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { posted, runtime } = runtimeWith(async () => {
      await gate;
      return new Uint8Array([1]);
    });
    const first = runtime.accept(exportRequest());
    await Promise.resolve();
    await runtime.accept(exportRequest({ requestId: 8 }));
    expect(posted[0]?.response).toMatchObject({ kind: "export-refused", reason: "session-closed", requestId: 8 });
    release?.();
    await first;
    expect(posted.at(-1)?.response.kind).toBe("export-finished");
  });
});

describe("initializeBrowserMp4ExportBindingsV1", () => {
  function wasmModule(overrides: Record<string, unknown> = {}) {
    return {
      default: async () => undefined,
      exportSceneMp4V1: async () => new Uint8Array([1]),
      poietraEngineAbiVersion: () => 42,
      ...overrides,
    };
  }

  it("admits a module implementing the export entry", async () => {
    const bindings = await initializeBrowserMp4ExportBindingsV1(wasmModule());
    expect(typeof bindings.exportSceneMp4V1).toBe("function");
  });

  it("exposes the optional WAV export entry when the module implements it", async () => {
    const bindings = await initializeBrowserMp4ExportBindingsV1(
      wasmModule({ exportSceneMp4WithWavV1: async () => new Uint8Array([2]) }),
    );
    expect(typeof bindings.exportSceneMp4WithWavV1).toBe("function");
  });

  it("rejects a module without the initializer", async () => {
    await expect(
      initializeBrowserMp4ExportBindingsV1({ exportSceneMp4V1: async () => new Uint8Array() }),
    ).rejects.toThrow(/initializer/);
  });

  it("rejects a module without the export entry", async () => {
    await expect(initializeBrowserMp4ExportBindingsV1(wasmModule({ exportSceneMp4V1: undefined }))).rejects.toThrow(
      /browser MP4 export/,
    );
  });

  it("rejects a stale engine ABI before calling an incompatible export signature", async () => {
    await expect(
      initializeBrowserMp4ExportBindingsV1(wasmModule({ poietraEngineAbiVersion: () => 31 })),
    ).rejects.toThrow(/engine ABI 42/);
  });
});
