import { describe, expect, it, vi } from "vitest";

import type { ExportWorkerRequestV1, ExportWorkerResponseV1 } from "./export-worker-protocol";
import {
  initializePoietraExportBindingsV1,
  PoietraExportWorkerRuntimeV1,
  type PoietraWasmExportBindingsV1,
  type PoietraWasmExportSessionV1,
} from "./poietra-export.worker";

const REVISION_A = "a".repeat(64);
const PROFILE_HASH = "b".repeat(64);
const SCOPE_URL = "https://studio.example/worker";

const encoder = new TextEncoder();

function encodeJson(value: unknown) {
  return encoder.encode(JSON.stringify(value));
}

function probeSupported() {
  return encodeJson({
    result: { codec: "avc1.640028", kind: "supported" },
    schema: "poietra.export-encoder-response",
    version: 1,
  });
}

function probeRefused(reason: string, message: string) {
  return encodeJson({
    result: { kind: "refused", message, reason },
    schema: "poietra.export-encoder-response",
    version: 1,
  });
}

function finishedEnvelope(outputByteLength: number) {
  return encodeJson({
    result: {
      chunkCount: 2,
      codec: "avc1.640028",
      color: { fullRange: false, matrix: 1, primaries: 1, source: "measured", transfer: 13 },
      exportProfileHash: PROFILE_HASH,
      frameCount: 2,
      keyFrameCount: 1,
      kind: "finished",
      outputByteLength,
      sceneRevisionHash: REVISION_A,
    },
    schema: "poietra.export-session-response",
    version: 1,
  });
}

function progressEnvelope(framesEncoded: number) {
  return encodeJson({
    result: { chunksMuxed: framesEncoded, frameCount: 2, framesEncoded, kind: "progress", muxedMediaBytes: 64 },
    schema: "poietra.export-session-response",
    version: 1,
  });
}

function refusedEnvelope(reason: string, message: string) {
  return encodeJson({
    result: { kind: "refused", message, reason },
    schema: "poietra.export-session-response",
    version: 1,
  });
}

function exportRequest(overrides: Partial<Extract<ExportWorkerRequestV1, { kind: "export-mp4" }>> = {}) {
  return {
    assetPayloads: [],
    kind: "export-mp4",
    profile: {
      codec: "h264-mp4",
      colorContractVersion: 1,
      frameRate: 30,
      maxDurationSeconds: 900,
      maxOutputBytes: 134_217_728,
      resolution: "854x480",
      schema: "poietra.export-profile",
      version: 1,
    },
    requestId: 7,
    revision: REVISION_A,
    schema: "poietra.export-worker-request",
    snapshotJson: encodeJson({ fixture: true }).buffer,
    version: 1,
    wasmModuleUrl: "https://studio.example/engine-wasm/poietra_wasm.js",
    ...overrides,
  } satisfies ExportWorkerRequestV1;
}

type FakeSessionPlan = Readonly<{
  output?: Uint8Array;
  run: (progress?: (envelopeJson: Uint8Array) => boolean | undefined) => Promise<Uint8Array>;
}>;

function runtimeWith(plan: FakeSessionPlan, probe: Uint8Array = probeSupported()) {
  const posted: { response: ExportWorkerResponseV1; transfer?: readonly ArrayBuffer[] }[] = [];
  const free = vi.fn();
  const create = vi.fn(async () => {
    const session: PoietraWasmExportSessionV1 = {
      free,
      outputBytes: () => plan.output ?? new Uint8Array(),
      run: plan.run,
    };
    return session;
  });
  const bindings: PoietraWasmExportBindingsV1 = {
    probeExportEncoderH264V1: async () => probe,
    Session: { create, prototype: {} as PoietraWasmExportSessionV1 },
  };
  const runtime = new PoietraExportWorkerRuntimeV1({
    loadWasm: async () => bindings,
    postMessage: (response, transfer) => posted.push({ response, ...(transfer ? { transfer } : {}) }),
    scopeUrl: SCOPE_URL,
  });
  return { create, free, posted, runtime };
}

describe("PoietraExportWorkerRuntimeV1", () => {
  it("rejects protocol violations with a bounded error response", async () => {
    const { posted, runtime } = runtimeWith({ run: async () => finishedEnvelope(0) });
    await runtime.accept({ kind: "export-mp4" });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.response).toMatchObject({ kind: "export-error", requestId: null });
  });

  it("refuses cross-origin WASM module URLs by name without loading anything", async () => {
    const { create, posted, runtime } = runtimeWith({ run: async () => finishedEnvelope(0) });
    await runtime.accept(exportRequest({ wasmModuleUrl: "https://evil.example/poietra_wasm.js" }));
    expect(posted[0]?.response).toMatchObject({ kind: "export-refused", reason: "invalid-request", requestId: 7 });
    expect(create).not.toHaveBeenCalled();
  });

  it("surfaces the fail-closed probe refusal before any session exists", async () => {
    const { create, posted, runtime } = runtimeWith(
      { run: async () => finishedEnvelope(0) },
      probeRefused("unsupported-codec", "no ladder entry passed"),
    );
    await runtime.accept(exportRequest());
    expect(posted).toHaveLength(1);
    expect(posted[0]?.response).toMatchObject({
      kind: "export-refused",
      message: "unsupported-codec: no ladder entry passed",
      reason: "unsupported-codec",
      requestId: 7,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("maps a named create rejection onto the closed refusal vocabulary", async () => {
    const posted: { response: ExportWorkerResponseV1 }[] = [];
    const rejection = new Error("duration-exceeded: the validated Scene runs 1200 seconds");
    rejection.name = "PoietraExportSessionRefused";
    const bindings: PoietraWasmExportBindingsV1 = {
      probeExportEncoderH264V1: async () => probeSupported(),
      Session: {
        create: vi.fn(async () => {
          throw rejection;
        }),
        prototype: {} as PoietraWasmExportSessionV1,
      },
    };
    const runtime = new PoietraExportWorkerRuntimeV1({
      loadWasm: async () => bindings,
      postMessage: (response) => posted.push({ response }),
      scopeUrl: SCOPE_URL,
    });
    await runtime.accept(exportRequest());
    expect(posted[0]?.response).toMatchObject({
      kind: "export-refused",
      reason: "duration-exceeded",
      requestId: 7,
    });
  });

  it("streams progress envelopes and transfers the finished MP4 exactly once", async () => {
    const output = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
    const { free, posted, runtime } = runtimeWith({
      output,
      run: async (progress) => {
        progress?.(progressEnvelope(1));
        progress?.(progressEnvelope(2));
        return finishedEnvelope(output.byteLength);
      },
    });
    await runtime.accept(exportRequest());
    expect(posted.map(({ response }) => response.kind)).toEqual([
      "export-progress",
      "export-progress",
      "export-finished",
    ]);
    const finished = posted[2];
    if (finished?.response.kind !== "export-finished") throw new Error("missing finished response");
    expect(new Uint8Array(finished.response.mp4)).toEqual(output);
    expect(finished.transfer).toEqual([finished.response.mp4]);
    expect(finished.response.status.outputByteLength).toBe(output.byteLength);
    expect(free).toHaveBeenCalledTimes(1);
  });

  it("relays the session's named run refusal and frees the session", async () => {
    const { free, posted, runtime } = runtimeWith({
      run: async () => refusedEnvelope("non-monotonic-chunk-timestamps", "chunk 5 went backwards"),
    });
    await runtime.accept(exportRequest());
    expect(posted).toHaveLength(1);
    expect(posted[0]?.response).toMatchObject({
      kind: "export-refused",
      reason: "non-monotonic-chunk-timestamps",
      requestId: 7,
    });
    expect(free).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the output bytes contradict the finished evidence", async () => {
    const { posted, runtime } = runtimeWith({
      output: new Uint8Array([1, 2, 3]),
      run: async () => finishedEnvelope(999),
    });
    await runtime.accept(exportRequest());
    expect(posted[0]?.response).toMatchObject({ kind: "export-error", requestId: 7 });
  });

  it("cancels through the progress callback when a cancel request arrives mid-run", async () => {
    let cancelObserved = false;
    const { posted, runtime } = runtimeWith({
      run: async (progress) => {
        await runtime.accept({
          kind: "export-cancel",
          requestId: 7,
          schema: "poietra.export-worker-request",
          version: 1,
        });
        cancelObserved = progress?.(progressEnvelope(1)) === false;
        return refusedEnvelope("cancelled", "the progress callback cancelled after frame 1");
      },
    });
    await runtime.accept(exportRequest());
    expect(cancelObserved).toBe(true);
    const last = posted.at(-1);
    expect(last?.response).toMatchObject({ kind: "export-refused", reason: "cancelled" });
  });

  it("refuses a second concurrent export by name", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { posted, runtime } = runtimeWith({
      output: new Uint8Array([1]),
      run: async () => {
        await gate;
        return finishedEnvelope(1);
      },
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

describe("initializePoietraExportBindingsV1", () => {
  function wasmModule(overrides: Record<string, unknown> = {}) {
    class Session {}
    Object.assign(Session.prototype, { outputBytes: () => new Uint8Array(), run: async () => new Uint8Array() });
    return {
      default: async () => undefined,
      poietraExportEncoderAbiVersion: () => 1,
      poietraExportSessionAbiVersion: () => 1,
      PoietraExportSessionV1: Object.assign(Session, { create: async () => new Session() }),
      probeExportEncoderH264V1: async () => probeSupported(),
      ...overrides,
    };
  }

  it("admits a module implementing the complete export surface", async () => {
    const bindings = await initializePoietraExportBindingsV1(wasmModule());
    expect(typeof bindings.Session.create).toBe("function");
  });

  it("rejects a foreign export session ABI version", async () => {
    await expect(
      initializePoietraExportBindingsV1(wasmModule({ poietraExportSessionAbiVersion: () => 2 })),
    ).rejects.toThrow(/export session ABI version 1/);
  });

  it("rejects a module without the encoder probe", async () => {
    await expect(
      initializePoietraExportBindingsV1(wasmModule({ probeExportEncoderH264V1: undefined })),
    ).rejects.toThrow(/probeExportEncoderH264V1/);
  });

  it("rejects a module without the session class surface", async () => {
    await expect(initializePoietraExportBindingsV1(wasmModule({ PoietraExportSessionV1: undefined }))).rejects.toThrow(
      /PoietraExportSessionV1/,
    );
  });
});
