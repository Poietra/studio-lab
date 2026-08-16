import { describe, expect, it } from "vitest";

import {
  EXPORT_REFUSAL_REASONS,
  exportProgressEnvelopeV1Schema,
  exportRefusalFromError,
  exportWorkerRequestV1Schema,
  exportWorkerResponseV1Schema,
} from "./export-worker-protocol";

const PROGRESS_RESULT = {
  encodedMediaBytes: 4_096,
  frameCount: 60,
  framesEncoded: 30,
  kind: "progress",
} as const;

describe("export progress envelope", () => {
  it("admits the bounded Rust progress envelope", () => {
    const parsed = exportProgressEnvelopeV1Schema.parse({
      result: PROGRESS_RESULT,
      schema: "poietra.browser-export-progress",
      version: 1,
    });
    expect(parsed.result.framesEncoded).toBe(30);
    expect(parsed.result.frameCount).toBe(60);
    expect(parsed.result.encodedMediaBytes).toBe(4_096);
  });

  it("rejects foreign schemas, extra fields, and negative counters", () => {
    expect(
      exportProgressEnvelopeV1Schema.safeParse({
        result: PROGRESS_RESULT,
        schema: "poietra.export-encoder-response",
        version: 1,
      }).success,
    ).toBe(false);
    expect(
      exportProgressEnvelopeV1Schema.safeParse({
        result: { ...PROGRESS_RESULT, extra: true },
        schema: "poietra.browser-export-progress",
        version: 1,
      }).success,
    ).toBe(false);
    expect(
      exportProgressEnvelopeV1Schema.safeParse({
        result: { ...PROGRESS_RESULT, framesEncoded: -1 },
        schema: "poietra.browser-export-progress",
        version: 1,
      }).success,
    ).toBe(false);
  });
});

describe("export refusal vocabulary", () => {
  it("keeps the closed refusal vocabulary sorted, duplicate-free, and cancellable", () => {
    const sorted = [...EXPORT_REFUSAL_REASONS].sort();
    expect([...EXPORT_REFUSAL_REASONS]).toEqual(sorted);
    expect(new Set(EXPORT_REFUSAL_REASONS).size).toBe(EXPORT_REFUSAL_REASONS.length);
    expect(EXPORT_REFUSAL_REASONS).toContain("cancelled");
  });
});

describe("export worker messages", () => {
  it("admits the bounded export request and its cancel companion", () => {
    const request = exportWorkerRequestV1Schema.parse({
      assetPayloads: [],
      kind: "export-mp4",
      profileJson: new ArrayBuffer(8),
      requestId: 1,
      schema: "poietra.export-worker-request",
      snapshotJson: new ArrayBuffer(8),
      version: 1,
      wasmModuleUrl: "https://studio.example/engine-wasm/poietra_wasm.js",
    });
    expect(request.kind).toBe("export-mp4");
    expect(
      exportWorkerRequestV1Schema.parse({
        kind: "export-cancel",
        requestId: 1,
        schema: "poietra.export-worker-request",
        version: 1,
      }).kind,
    ).toBe("export-cancel");
  });

  it("rejects requests without a request identity", () => {
    expect(
      exportWorkerRequestV1Schema.safeParse({
        assetPayloads: [],
        kind: "export-mp4",
        profileJson: new ArrayBuffer(8),
        schema: "poietra.export-worker-request",
        snapshotJson: new ArrayBuffer(8),
        version: 1,
        wasmModuleUrl: "https://studio.example/engine-wasm/poietra_wasm.js",
      }).success,
    ).toBe(false);
  });

  it("admits every worker response kind with the finished transfer as an ArrayBuffer", () => {
    expect(
      exportWorkerResponseV1Schema.parse({
        kind: "export-progress",
        progress: PROGRESS_RESULT,
        requestId: 1,
        schema: "poietra.export-worker-response",
        version: 1,
      }).kind,
    ).toBe("export-progress");
    expect(
      exportWorkerResponseV1Schema.parse({
        bytes: new ArrayBuffer(16),
        kind: "export-finished",
        requestId: 1,
        schema: "poietra.export-worker-response",
        version: 1,
      }).kind,
    ).toBe("export-finished");
    expect(
      exportWorkerResponseV1Schema.parse({
        kind: "export-refused",
        message: "cancelled: the export was cancelled after frame 3 of 60",
        reason: "cancelled",
        requestId: 1,
        schema: "poietra.export-worker-response",
        version: 1,
      }).kind,
    ).toBe("export-refused");
    expect(
      exportWorkerResponseV1Schema.parse({
        kind: "export-error",
        message: "crashed",
        requestId: null,
        schema: "poietra.export-worker-response",
        version: 1,
      }).kind,
    ).toBe("export-error");
  });

  it("rejects refusal reasons outside the closed vocabulary", () => {
    expect(
      exportWorkerResponseV1Schema.safeParse({
        kind: "export-refused",
        message: "?",
        reason: "something-new",
        requestId: 1,
        schema: "poietra.export-worker-response",
        version: 1,
      }).success,
    ).toBe(false);
  });
});

describe("exportRefusalFromError", () => {
  it("maps a named rejection prefix onto the closed vocabulary", () => {
    const error = new Error("cancelled: the export was cancelled after frame 3 of 60");
    error.name = "PoietraBrowserMp4ExportRefused";
    expect(exportRefusalFromError(error)).toEqual({
      message: "cancelled: the export was cancelled after frame 3 of 60",
      reason: "cancelled",
    });
    const gpu = new Error("gpu-unavailable: no WebGPU adapter for offscreen export");
    gpu.name = "PoietraBrowserMp4ExportRefused";
    expect(exportRefusalFromError(gpu)?.reason).toBe("gpu-unavailable");
  });

  it("keeps an unknown prefix as invalid-request without inventing a reason", () => {
    const error = new Error("brand-new-reason: mystery");
    error.name = "PoietraBrowserMp4ExportRefused";
    expect(exportRefusalFromError(error)).toEqual({
      message: "brand-new-reason: mystery",
      reason: "invalid-request",
    });
  });

  it("returns null for foreign errors", () => {
    expect(exportRefusalFromError(new Error("cancelled: nope"))).toBeNull();
    expect(exportRefusalFromError("cancelled: nope")).toBeNull();
  });
});
