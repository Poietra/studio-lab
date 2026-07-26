import { describe, expect, it, vi } from "vitest";

import {
  initializePoietraWasmBindingsV1,
  PoietraPreviewWorkerRuntimeV1,
  type PoietraWasmSessionV1,
} from "./poietra-engine.worker";
import { engineSampleRequestV1Schema, type PreviewWorkerResponseV1 } from "./preview-worker-protocol";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);
const ENGINE_ERROR_JSON = new TextEncoder().encode(
  JSON.stringify({
    result: { code: "evaluation-failed", kind: "error", message: "outside duration" },
    schema: "poietra.engine-worker-response",
    version: 1,
  }),
);

function installRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "install-scene",
    requestId: 1,
    revision: REVISION_A,
    schema: "poietra.preview-worker-request",
    snapshotJson: new TextEncoder().encode("snapshot-a").buffer,
    version: 1,
    wasmModuleUrl: "https://studio.test/engine-wasm/poietra_wasm.js",
    ...overrides,
  };
}

describe("Poietra preview worker runtime", () => {
  it("retains one snapshot and transfers only a bounded versioned engine response per sample", async () => {
    const snapshots: string[] = [];
    const samples: unknown[] = [];
    class Session implements PoietraWasmSessionV1 {
      constructor(snapshotJson: Uint8Array) {
        snapshots.push(new TextDecoder().decode(snapshotJson));
      }

      replaceSnapshot(snapshotJson: Uint8Array) {
        snapshots.push(new TextDecoder().decode(snapshotJson));
      }

      sample(requestJson: Uint8Array) {
        samples.push(engineSampleRequestV1Schema.parse(JSON.parse(new TextDecoder().decode(requestJson))));
        return ENGINE_ERROR_JSON.slice();
      }
    }
    const posted: Array<{ response: PreviewWorkerResponseV1; transfer: readonly Transferable[] }> = [];
    const runtime = new PoietraPreviewWorkerRuntimeV1({
      loadWasm: async () => Session,
      postMessage: (response, transfer = []) => posted.push({ response, transfer }),
      scopeUrl: "https://studio.test/assets/worker.js",
    });

    const installing = runtime.accept(installRequest());
    const sampling = runtime.accept({
      kind: "sample",
      requestId: 2,
      revision: REVISION_A,
      sampleTime: 1.25,
      schema: "poietra.preview-worker-request",
      version: 1,
      viewport: { heightPx: 720, widthPx: 1_280 },
    });
    await Promise.all([installing, sampling]);

    expect(snapshots).toEqual(["snapshot-a"]);
    expect(samples).toEqual([
      {
        evidence: ["Poietra WASM preview worker v1"],
        packetId: "preview:2",
        sampleTime: 1.25,
        schema: "poietra.engine-sample-request",
        version: 1,
        viewport: { heightPx: 720, widthPx: 1_280 },
      },
    ]);
    expect(posted.map(({ response }) => response.kind)).toEqual(["scene-ready", "sample-response"]);
    const sampled = posted[1];
    expect(sampled.response.kind).toBe("sample-response");
    if (sampled.response.kind !== "sample-response") throw new Error("missing sample response");
    expect(new Uint8Array(sampled.response.responseJson)).toEqual(ENGINE_ERROR_JSON);
    expect(sampled.transfer).toEqual([sampled.response.responseJson]);
  });

  it("checks same-origin module loading and replacement base revisions", async () => {
    const replaceSnapshot = vi.fn();
    class Session implements PoietraWasmSessionV1 {
      replaceSnapshot = replaceSnapshot;
      sample = () => ENGINE_ERROR_JSON.slice();
    }
    const loadWasm = vi.fn(async () => Session);
    const responses: PreviewWorkerResponseV1[] = [];
    const runtime = new PoietraPreviewWorkerRuntimeV1({
      loadWasm,
      postMessage: (response) => responses.push(response),
      scopeUrl: "https://studio.test/assets/worker.js",
    });

    await runtime.accept(installRequest({ wasmModuleUrl: "https://attacker.test/poietra_wasm.js" }));
    expect(loadWasm).not.toHaveBeenCalled();
    expect(responses.at(-1)).toMatchObject({ code: "wasm-load-failed", kind: "error" });

    await runtime.accept(installRequest({ requestId: 2 }));
    await runtime.accept({
      baseRevision: REVISION_B,
      kind: "replace-scene",
      requestId: 3,
      revision: REVISION_B,
      schema: "poietra.preview-worker-request",
      snapshotJson: new ArrayBuffer(1),
      version: 1,
    });
    expect(replaceSnapshot).not.toHaveBeenCalled();
    expect(responses.at(-1)).toMatchObject({ code: "stale-revision", kind: "error", requestId: 3 });
  });

  it("preserves request correlation when rejecting a widened message", async () => {
    const responses: PreviewWorkerResponseV1[] = [];
    const runtime = new PoietraPreviewWorkerRuntimeV1({
      loadWasm: vi.fn(),
      postMessage: (response) => responses.push(response),
      scopeUrl: "https://studio.test/assets/worker.js",
    });

    await runtime.accept({ ...installRequest(), debug: true });
    expect(responses).toEqual([
      expect.objectContaining({
        code: "invalid-message",
        kind: "error",
        requestId: 1,
        revision: REVISION_A,
      }),
    ]);
  });
});

describe("Poietra WASM binding handshake", () => {
  class Session implements PoietraWasmSessionV1 {
    replaceSnapshot() {}
    sample() {
      return ENGINE_ERROR_JSON.slice();
    }
  }

  it("initializes and accepts only ABI v1 with the retained session API", async () => {
    const initialize = vi.fn(async () => undefined);
    await expect(
      initializePoietraWasmBindingsV1({
        default: initialize,
        poietraEngineAbiVersion: () => 1,
        PoietraEngineSessionV1: Session,
      }),
    ).resolves.toBe(Session);
    expect(initialize).toHaveBeenCalledOnce();
  });

  it("rejects an incompatible ABI before constructing a session", async () => {
    await expect(
      initializePoietraWasmBindingsV1({
        default: async () => undefined,
        poietraEngineAbiVersion: () => 2,
        PoietraEngineSessionV1: Session,
      }),
    ).rejects.toThrow(/ABI version 1/i);
  });
});
