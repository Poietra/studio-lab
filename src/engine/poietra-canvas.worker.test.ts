import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CanvasRenderResponseV1,
  type CanvasWorkerResponseV1,
  canvasEngineSampleRequestV1Schema,
} from "./canvas-worker-protocol";
import {
  initializePoietraCanvasBindingsV1,
  PoietraCanvasWorkerRuntimeV1,
  type PoietraWasmCanvasEngineV1,
} from "./poietra-canvas.worker";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);

class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
}

function encodeResponse(response: CanvasRenderResponseV1) {
  return new TextEncoder().encode(JSON.stringify(response));
}

function presentedResponse(packetId: string, sampleTime = 1): CanvasRenderResponseV1 {
  return {
    result: {
      kind: "presented",
      packetId,
      sampleTime,
      suboptimal: false,
      viewport: { heightPx: 90, widthPx: 160 },
    },
    schema: "poietra.canvas-render-response",
    version: 1,
  };
}

function installRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    canvas: new FakeOffscreenCanvas(160, 90),
    kind: "install-canvas",
    requestId: 1,
    revision: REVISION_A,
    schema: "poietra.canvas-worker-request",
    snapshotJson: new TextEncoder().encode("snapshot-a").buffer,
    version: 1,
    wasmModuleUrl: "https://studio.test/engine-wasm/poietra_wasm.js",
    ...overrides,
  };
}

function renderRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "render-frame",
    requestId: 2,
    revision: REVISION_A,
    sampleTime: 1,
    schema: "poietra.canvas-worker-request",
    version: 1,
    viewport: { heightPx: 90, widthPx: 160 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Poietra canvas worker runtime", () => {
  it("retains the snapshot and returns only correlated presentation metadata", async () => {
    const snapshots: string[] = [];
    const samples: unknown[] = [];
    const canvases: unknown[] = [];
    class Engine implements PoietraWasmCanvasEngineV1 {
      static async create(snapshotJson: Uint8Array, canvas: OffscreenCanvas) {
        snapshots.push(new TextDecoder().decode(snapshotJson));
        canvases.push(canvas);
        return new Engine();
      }

      replaceSnapshot(snapshotJson: Uint8Array) {
        snapshots.push(new TextDecoder().decode(snapshotJson));
      }

      async render(requestJson: Uint8Array) {
        const request = canvasEngineSampleRequestV1Schema.parse(JSON.parse(new TextDecoder().decode(requestJson)));
        samples.push(request);
        return encodeResponse(presentedResponse(request.packetId, request.sampleTime));
      }
    }
    const posted: CanvasWorkerResponseV1[] = [];
    const runtime = new PoietraCanvasWorkerRuntimeV1({
      loadWasm: async () => Engine,
      postMessage: (response) => posted.push(response),
      scopeUrl: "https://studio.test/assets/canvas-worker.js",
    });

    await Promise.all([runtime.accept(installRequest()), runtime.accept(renderRequest())]);

    expect(snapshots).toEqual(["snapshot-a"]);
    expect(canvases).toHaveLength(1);
    expect(samples).toEqual([
      {
        evidence: ["Poietra WASM canvas worker v1"],
        packetId: "canvas:2",
        sampleTime: 1,
        schema: "poietra.engine-sample-request",
        version: 1,
        viewport: { heightPx: 90, widthPx: 160 },
      },
    ]);
    expect(posted).toEqual([
      expect.objectContaining({ kind: "canvas-ready", operation: "install", requestId: 1 }),
      {
        kind: "frame-presented",
        packetId: "canvas:2",
        requestId: 2,
        revision: REVISION_A,
        sampleTime: 1,
        schema: "poietra.canvas-worker-response",
        suboptimal: false,
        version: 1,
        viewport: { heightPx: 90, widthPx: 160 },
      },
    ]);
    expect(posted[1]).not.toHaveProperty("packet");
    expect(posted[1]).not.toHaveProperty("responseJson");
  });

  it("checks same-origin loading and atomically replaces a matching revision", async () => {
    const replaceSnapshot = vi.fn();
    class Engine implements PoietraWasmCanvasEngineV1 {
      static async create() {
        return new Engine();
      }

      replaceSnapshot = replaceSnapshot;
      async render() {
        return encodeResponse(presentedResponse("canvas:2"));
      }
    }
    const loadWasm = vi.fn(async () => Engine);
    const posted: CanvasWorkerResponseV1[] = [];
    const runtime = new PoietraCanvasWorkerRuntimeV1({
      loadWasm,
      postMessage: (response) => posted.push(response),
      scopeUrl: "https://studio.test/assets/canvas-worker.js",
    });

    await runtime.accept(installRequest({ wasmModuleUrl: "https://attacker.test/poietra_wasm.js" }));
    expect(loadWasm).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ code: "wasm-load-failed", fallback: "whole-scene", kind: "error" });

    await runtime.accept(installRequest({ requestId: 2 }));
    await runtime.accept({
      baseRevision: REVISION_A,
      kind: "replace-scene",
      requestId: 3,
      revision: REVISION_B,
      schema: "poietra.canvas-worker-request",
      snapshotJson: new TextEncoder().encode("snapshot-b").buffer,
      version: 1,
    });
    expect(replaceSnapshot).toHaveBeenCalledOnce();
    expect(posted.at(-1)).toMatchObject({ kind: "canvas-ready", operation: "replace", revision: REVISION_B });

    await runtime.accept({
      baseRevision: REVISION_A,
      kind: "replace-scene",
      requestId: 4,
      revision: REVISION_A,
      schema: "poietra.canvas-worker-request",
      snapshotJson: new ArrayBuffer(1),
      version: 1,
    });
    expect(replaceSnapshot).toHaveBeenCalledOnce();
    expect(posted.at(-1)).toMatchObject({ code: "stale-revision", kind: "error", requestId: 4 });
  });

  it("maps correlated engine failures without widening their payload", async () => {
    class Engine implements PoietraWasmCanvasEngineV1 {
      static async create() {
        return new Engine();
      }

      replaceSnapshot() {}
      async render(requestJson: Uint8Array) {
        const request = canvasEngineSampleRequestV1Schema.parse(JSON.parse(new TextDecoder().decode(requestJson)));
        return encodeResponse({
          result: {
            code: "unsupported-frame",
            kind: "error",
            message: "stroke rendering is not implemented",
            packetId: request.packetId,
            sampleTime: request.sampleTime,
            viewport: request.viewport,
          },
          schema: "poietra.canvas-render-response",
          version: 1,
        });
      }
    }
    const posted: CanvasWorkerResponseV1[] = [];
    const runtime = new PoietraCanvasWorkerRuntimeV1({
      loadWasm: async () => Engine,
      postMessage: (response) => posted.push(response),
      scopeUrl: "https://studio.test/worker.js",
    });

    await runtime.accept(installRequest());
    await runtime.accept(renderRequest());
    expect(posted.at(-1)).toEqual({
      code: "unsupported-frame",
      fallback: "whole-scene",
      kind: "error",
      message: "stroke rendering is not implemented",
      requestId: 2,
      revision: REVISION_A,
      schema: "poietra.canvas-worker-response",
      version: 1,
    });
  });

  it("fails closed on malformed bytes and uncorrelated engine responses", async () => {
    let response = new Uint8Array([0xff]);
    class Engine implements PoietraWasmCanvasEngineV1 {
      static async create() {
        return new Engine();
      }

      replaceSnapshot() {}
      async render() {
        return response;
      }
    }
    const posted: CanvasWorkerResponseV1[] = [];
    const runtime = new PoietraCanvasWorkerRuntimeV1({
      loadWasm: async () => Engine,
      postMessage: (message) => posted.push(message),
      scopeUrl: "https://studio.test/worker.js",
    });

    await runtime.accept(installRequest());
    await runtime.accept(renderRequest());
    expect(posted.at(-1)).toMatchObject({ code: "protocol-violation", kind: "error", requestId: 2 });

    response = encodeResponse(presentedResponse("wrong-packet"));
    await runtime.accept(renderRequest({ requestId: 3 }));
    expect(posted.at(-1)).toMatchObject({ code: "protocol-violation", kind: "error", requestId: 3 });

    response = encodeResponse({
      result: {
        code: "invalid-request",
        kind: "error",
        message: "request could not be decoded",
        packetId: null,
        sampleTime: null,
        viewport: null,
      },
      schema: "poietra.canvas-render-response",
      version: 1,
    });
    await expect(runtime.accept(renderRequest({ requestId: 4 }))).resolves.toBeUndefined();
    expect(posted.at(-1)).toMatchObject({ code: "protocol-violation", kind: "error", requestId: 4 });
  });

  it("classifies stable Rust create rejection names", async () => {
    const posted: CanvasWorkerResponseV1[] = [];
    const runtimeFor = (name: string) =>
      new PoietraCanvasWorkerRuntimeV1({
        loadWasm: async () =>
          class Engine {
            static async create(): Promise<PoietraWasmCanvasEngineV1> {
              const error = new Error("rejected");
              error.name = name;
              throw error;
            }

            replaceSnapshot() {}
            async render() {
              return new Uint8Array();
            }
          },
        postMessage: (response) => posted.push(response),
        scopeUrl: "https://studio.test/worker.js",
      });

    await runtimeFor("PoietraCanvasSnapshotRejected").accept(installRequest());
    expect(posted.at(-1)).toMatchObject({ code: "snapshot-rejected" });
    await runtimeFor("PoietraCanvasRendererUnavailable").accept(installRequest({ requestId: 2 }));
    expect(posted.at(-1)).toMatchObject({ code: "renderer-unavailable" });
    await runtimeFor("UnknownError").accept(installRequest({ requestId: 3 }));
    expect(posted.at(-1)).toMatchObject({ code: "renderer-unavailable" });
  });

  it("preserves correlation while rejecting a widened request", async () => {
    const posted: CanvasWorkerResponseV1[] = [];
    const runtime = new PoietraCanvasWorkerRuntimeV1({
      loadWasm: vi.fn(),
      postMessage: (response) => posted.push(response),
      scopeUrl: "https://studio.test/worker.js",
    });
    await runtime.accept({ ...installRequest(), debug: true });
    expect(posted).toEqual([
      expect.objectContaining({ code: "invalid-message", kind: "error", requestId: 1, revision: REVISION_A }),
    ]);
  });
});

describe("Poietra canvas WASM binding handshake", () => {
  class Engine implements PoietraWasmCanvasEngineV1 {
    static async create() {
      return new Engine();
    }

    replaceSnapshot() {}
    async render() {
      return encodeResponse(presentedResponse("canvas:1"));
    }
  }

  it("accepts only canvas ABI v1 with the complete class shape", async () => {
    const initialize = vi.fn(async () => undefined);
    await expect(
      initializePoietraCanvasBindingsV1({
        default: initialize,
        poietraCanvasAbiVersion: () => 1,
        PoietraCanvasEngineV1: Engine,
      }),
    ).resolves.toBe(Engine);
    expect(initialize).toHaveBeenCalledOnce();
  });

  it("rejects incompatible ABI versions and incomplete classes", async () => {
    await expect(
      initializePoietraCanvasBindingsV1({
        default: async () => undefined,
        poietraCanvasAbiVersion: () => 2,
        PoietraCanvasEngineV1: Engine,
      }),
    ).rejects.toThrow(/ABI version 1/i);
    await expect(
      initializePoietraCanvasBindingsV1({
        default: async () => undefined,
        poietraCanvasAbiVersion: () => 1,
        PoietraCanvasEngineV1: class Incomplete {},
      }),
    ).rejects.toThrow(/PoietraCanvasEngineV1/i);
  });
});
