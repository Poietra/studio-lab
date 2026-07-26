import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGpuDevice } from "./canvas-frame-evidence.test-fixtures";
import { createCanvasWorkerEvidenceSupportV1 } from "./canvas-worker-evidence";
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

  it("rejects an adjacent binary64 playhead at a semantic boundary", async () => {
    class Engine implements PoietraWasmCanvasEngineV1 {
      static async create() {
        return new Engine();
      }

      replaceSnapshot() {}
      async render(requestJson: Uint8Array) {
        const request = canvasEngineSampleRequestV1Schema.parse(JSON.parse(new TextDecoder().decode(requestJson)));
        return encodeResponse(presentedResponse(request.packetId, 1.999_999_999_999_999_8));
      }
    }
    const posted: CanvasWorkerResponseV1[] = [];
    const runtime = new PoietraCanvasWorkerRuntimeV1({
      loadWasm: async () => Engine,
      postMessage: (response) => posted.push(response),
      scopeUrl: "https://studio.test/worker.js",
    });

    await runtime.accept(installRequest());
    await runtime.accept(renderRequest({ sampleTime: 2 }));
    expect(posted.at(-1)).toMatchObject({ code: "protocol-violation", kind: "error", requestId: 2 });
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

function createEvidenceHarness() {
  const { buffers, device } = createFakeGpuDevice();
  let currentTexture: { fill: number } | null = null;
  const adapter = { requestDevice: () => Promise.resolve(device) };
  const gpu = { requestAdapter: () => Promise.resolve(adapter) };
  const context = {
    configure: () => undefined,
    getCurrentTexture: () => currentTexture,
  };
  class EvidenceCanvas extends FakeOffscreenCanvas {
    getContext(contextId: string) {
      return contextId === "webgpu" ? context : null;
    }
  }
  return {
    acquireTexture: (fill: number) => {
      currentTexture = { fill };
      context.getCurrentTexture();
    },
    buffers,
    canvas: new EvidenceCanvas(160, 90),
    gpu,
  };
}

type EvidenceRenderPlan = Readonly<{
  fill?: number;
  respond: (request: Readonly<{ packetId: string; sampleTime: number }>) => Uint8Array;
  submissions?: number;
}>;

function createEvidenceEngineClass(
  harness: ReturnType<typeof createEvidenceHarness>,
  plans: EvidenceRenderPlan[],
  options: Readonly<{ failingCreates?: number; rejectReplaces?: boolean }> = {},
) {
  let remainingCreateFailures = options.failingCreates ?? 0;
  class Engine implements PoietraWasmCanvasEngineV1 {
    private device: ReturnType<typeof createFakeGpuDevice>["device"] | null = null;

    static async create(_snapshotJson: Uint8Array, canvas: OffscreenCanvas) {
      if (remainingCreateFailures > 0) {
        remainingCreateFailures -= 1;
        throw new Error("The WebGPU adapter rejected this configuration.");
      }
      const engine = new Engine();
      const context = (canvas as unknown as { getContext: (contextId: string) => unknown }).getContext("webgpu") as {
        configure: (configuration: unknown) => void;
      };
      const navigatorGpu = (globalThis.navigator as unknown as { gpu: typeof harness.gpu }).gpu;
      const adapter = await navigatorGpu.requestAdapter();
      engine.device = await adapter.requestDevice();
      context.configure({ device: engine.device, format: "rgba8unorm" });
      return engine;
    }

    replaceSnapshot() {
      if (options.rejectReplaces) {
        const error = new Error("The replacement snapshot was rejected.");
        error.name = "PoietraCanvasSnapshotRejected";
        throw error;
      }
    }

    async render(requestJson: Uint8Array) {
      const request = canvasEngineSampleRequestV1Schema.parse(JSON.parse(new TextDecoder().decode(requestJson)));
      const plan = plans.shift();
      if (!plan || !this.device) throw new Error("No render plan is queued for this fake engine.");
      if (plan.fill !== undefined) {
        harness.acquireTexture(plan.fill);
        for (let index = 0; index < (plan.submissions ?? 1); index += 1) {
          this.device.queue.submit([]);
        }
      }
      return plan.respond(request);
    }
  }
  return Engine;
}

function captureEvidenceRequest(requestId: number, revision = REVISION_A) {
  return {
    kind: "capture-frame-evidence",
    requestId,
    revision,
    samples: [{ fractionX: 0, fractionY: 0 }],
    schema: "poietra.canvas-worker-request",
    version: 1,
  };
}

function replaceSceneRequest(requestId: number) {
  return {
    baseRevision: REVISION_A,
    kind: "replace-scene",
    requestId,
    revision: REVISION_B,
    schema: "poietra.canvas-worker-request",
    snapshotJson: new TextEncoder().encode("snapshot-b").buffer,
    version: 1,
  };
}

const presentPlan: EvidenceRenderPlan["respond"] = (request) =>
  encodeResponse(presentedResponse(request.packetId, request.sampleTime));

describe("Poietra canvas worker frame evidence lifecycle", () => {
  async function setupEvidenceWorker(
    plans: EvidenceRenderPlan[],
    options: Readonly<{ failingCreates?: number; rejectReplaces?: boolean }> = {},
  ) {
    const harness = createEvidenceHarness();
    vi.stubGlobal("navigator", { gpu: harness.gpu });
    const Engine = createEvidenceEngineClass(harness, plans, options);
    const posted: CanvasWorkerResponseV1[] = [];
    const runtime = new PoietraCanvasWorkerRuntimeV1({
      evidence: createCanvasWorkerEvidenceSupportV1(),
      loadWasm: async () => Engine,
      postMessage: (response) => posted.push(response),
      scopeUrl: "https://studio.test/assets/canvas-worker.js",
    });
    await runtime.accept(installRequest({ canvas: harness.canvas, captureFrameEvidence: true }));
    return { harness, posted, runtime };
  }

  it("keeps the production runtime evidence-free: extended requests are bounded protocol errors", async () => {
    const harness = createEvidenceHarness();
    vi.stubGlobal("navigator", { gpu: harness.gpu });
    const Engine = createEvidenceEngineClass(harness, []);
    const posted: CanvasWorkerResponseV1[] = [];
    const runtime = new PoietraCanvasWorkerRuntimeV1({
      loadWasm: async () => Engine,
      postMessage: (response) => posted.push(response),
      scopeUrl: "https://studio.test/assets/canvas-worker.js",
    });
    await runtime.accept(installRequest({ canvas: harness.canvas, captureFrameEvidence: true }));
    expect(posted.at(-1)).toMatchObject({ code: "invalid-state", kind: "error", requestId: 1 });
    await runtime.accept(installRequest({ canvas: harness.canvas, requestId: 2 }));
    expect(posted.at(-1)).toMatchObject({ kind: "canvas-ready", operation: "install", requestId: 2 });
    await runtime.accept(captureEvidenceRequest(3));
    expect(posted.at(-1)).toMatchObject({ code: "invalid-message", kind: "error", requestId: 3 });
    expect(harness.buffers).toHaveLength(0);
  });

  it("discards staged evidence on a decode/protocol failure and keeps the last committed frame", async () => {
    const { harness, posted, runtime } = await setupEvidenceWorker([
      { fill: 10, respond: presentPlan },
      { fill: 20, respond: () => new Uint8Array([0xff]) },
    ]);
    await runtime.accept(renderRequest({ requestId: 2 }));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-presented", packetId: "canvas:2" });
    await runtime.accept(captureEvidenceRequest(3));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-evidence", packetId: "canvas:2", samples: [[10, 10, 10, 10]] });
    await runtime.accept(renderRequest({ requestId: 4 }));
    expect(posted.at(-1)).toMatchObject({ code: "protocol-violation", kind: "error", requestId: 4 });
    expect(harness.buffers.map((buffer) => buffer.destroyCalls)).toEqual([0, 1]);
    await runtime.accept(captureEvidenceRequest(5));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-evidence", packetId: "canvas:2", samples: [[10, 10, 10, 10]] });
  });

  it("resets the evidence capture when Engine.create fails so a plain retry is evidence-free", async () => {
    const { harness, posted, runtime } = await setupEvidenceWorker([{ fill: 30, respond: presentPlan }], {
      failingCreates: 1,
    });
    expect(posted.at(-1)).toMatchObject({ code: "renderer-unavailable", kind: "error", requestId: 1 });

    await runtime.accept(installRequest({ canvas: harness.canvas, requestId: 2 }));
    expect(posted.at(-1)).toMatchObject({ kind: "canvas-ready", operation: "install", requestId: 2 });
    await runtime.accept(renderRequest({ requestId: 3 }));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-presented", packetId: "canvas:3" });
    expect(harness.buffers).toHaveLength(0);
    await runtime.accept(captureEvidenceRequest(4));
    expect(posted.at(-1)).toMatchObject({
      code: "invalid-state",
      kind: "error",
      message: "Frame evidence capture is not enabled on this worker.",
    });
  });

  it("supports an evidence-enabled retry after a failed create without double-wrapping the hooks", async () => {
    const { harness, posted, runtime } = await setupEvidenceWorker([{ fill: 40, respond: presentPlan }], {
      failingCreates: 1,
    });
    expect(posted.at(-1)).toMatchObject({ code: "renderer-unavailable", kind: "error", requestId: 1 });
    await runtime.accept(installRequest({ canvas: harness.canvas, captureFrameEvidence: true, requestId: 2 }));
    expect(posted.at(-1)).toMatchObject({ kind: "canvas-ready", operation: "install", requestId: 2 });
    await runtime.accept(renderRequest({ requestId: 3 }));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-presented", packetId: "canvas:3" });
    expect(harness.buffers).toHaveLength(1);
    await runtime.accept(captureEvidenceRequest(4));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-evidence", packetId: "canvas:3", samples: [[40, 40, 40, 40]] });
  });

  it("invalidates committed evidence on a successful Scene replace until a new frame commits", async () => {
    const { harness, posted, runtime } = await setupEvidenceWorker([
      { fill: 10, respond: presentPlan },
      { fill: 20, respond: presentPlan },
    ]);
    await runtime.accept(renderRequest({ requestId: 2 }));
    await runtime.accept(captureEvidenceRequest(3));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-evidence", revision: REVISION_A, samples: [[10, 10, 10, 10]] });

    // The successful replace installs a new Scene: the old frame no longer
    // describes it, so its evidence is destroyed and capture refuses.
    await runtime.accept(replaceSceneRequest(4));
    expect(posted.at(-1)).toMatchObject({ kind: "canvas-ready", operation: "replace", revision: REVISION_B });
    expect(harness.buffers.map((buffer) => buffer.destroyCalls)).toEqual([1]);
    await runtime.accept(captureEvidenceRequest(5, REVISION_B));
    expect(posted.at(-1)).toMatchObject({
      code: "invalid-state",
      kind: "error",
      message: "No presented frame has been captured yet.",
    });

    // A frame of the new revision re-arms the evidence with the revision the
    // frame was actually drawn for.
    await runtime.accept(renderRequest({ requestId: 6, revision: REVISION_B }));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-presented", packetId: "canvas:6" });
    await runtime.accept(captureEvidenceRequest(7, REVISION_B));
    expect(posted.at(-1)).toMatchObject({
      kind: "frame-evidence",
      packetId: "canvas:6",
      revision: REVISION_B,
      samples: [[20, 20, 20, 20]],
    });
  });

  it("preserves committed evidence when a Scene replace is atomically rejected", async () => {
    const { harness, posted, runtime } = await setupEvidenceWorker([{ fill: 10, respond: presentPlan }], {
      rejectReplaces: true,
    });
    await runtime.accept(renderRequest({ requestId: 2 }));
    await runtime.accept(replaceSceneRequest(3));
    expect(posted.at(-1)).toMatchObject({ code: "snapshot-rejected", kind: "error", requestId: 3 });

    // The Scene and the presented surface are unchanged, so the previously
    // committed frame is still valid evidence for the base revision.
    await runtime.accept(captureEvidenceRequest(4));
    expect(posted.at(-1)).toMatchObject({
      kind: "frame-evidence",
      packetId: "canvas:2",
      revision: REVISION_A,
      samples: [[10, 10, 10, 10]],
    });
    expect(harness.buffers.map((buffer) => buffer.destroyCalls)).toEqual([0]);
  });

  it("refuses evidence after a presented response with no staged submission instead of exposing a stale frame", async () => {
    const { harness, posted, runtime } = await setupEvidenceWorker([
      { fill: 10, respond: presentPlan },
      // The second render responds "presented" without acquiring a texture or
      // submitting anything.
      { respond: presentPlan },
    ]);
    await runtime.accept(renderRequest({ requestId: 2 }));
    await runtime.accept(captureEvidenceRequest(3));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-evidence", packetId: "canvas:2" });

    // Production presentation is unaffected by the missing submission...
    await runtime.accept(renderRequest({ requestId: 4 }));
    expect(posted.at(-1)).toMatchObject({ kind: "frame-presented", packetId: "canvas:4", requestId: 4 });
    // ...but the stale committed frame was cleared, so the evidence channel
    // fails closed instead of exposing the old frame as this response's proof.
    expect(harness.buffers.map((buffer) => buffer.destroyCalls)).toEqual([1]);
    await runtime.accept(captureEvidenceRequest(5));
    expect(posted.at(-1)).toMatchObject({
      code: "invalid-state",
      kind: "error",
      message: "No presented frame has been captured yet.",
    });
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
