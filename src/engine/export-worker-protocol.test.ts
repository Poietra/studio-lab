import { describe, expect, it } from "vitest";

import {
  EXPORT_SESSION_REFUSAL_REASONS,
  exportEncoderProbeResponseV1Schema,
  exportSessionRefusalFromError,
  exportSessionResponseV1Schema,
  exportWorkerRequestV1Schema,
  exportWorkerResponseV1Schema,
} from "./export-worker-protocol";

const REVISION = "a".repeat(64);
const HASH = "b".repeat(64);

const finishedResult = {
  chunkCount: 60,
  codec: "avc1.640028",
  color: { fullRange: false, matrix: 1, primaries: 1, source: "measured", transfer: 13 },
  exportProfileHash: HASH,
  frameCount: 60,
  keyFrameCount: 1,
  kind: "finished",
  outputByteLength: 1_048_576,
  sceneRevisionHash: REVISION,
} as const;

describe("export session response envelope", () => {
  it("admits finished, progress, and refused results", () => {
    for (const result of [
      finishedResult,
      { chunksMuxed: 3, frameCount: 60, framesEncoded: 4, kind: "progress", muxedMediaBytes: 4_096 },
      { kind: "refused", message: "chunk 5 went backwards", reason: "non-monotonic-chunk-timestamps" },
    ]) {
      expect(
        exportSessionResponseV1Schema.parse({
          result,
          schema: "poietra.export-session-response",
          version: 1,
        }).result.kind,
      ).toBe(result.kind);
    }
  });

  it("rejects refusal reasons outside the closed vocabulary and foreign envelopes", () => {
    expect(
      exportSessionResponseV1Schema.safeParse({
        result: { kind: "refused", message: "?", reason: "something-new" },
        schema: "poietra.export-session-response",
        version: 1,
      }).success,
    ).toBe(false);
    expect(
      exportSessionResponseV1Schema.safeParse({
        result: finishedResult,
        schema: "poietra.export-encoder-response",
        version: 1,
      }).success,
    ).toBe(false);
    expect(
      exportSessionResponseV1Schema.safeParse({
        result: { ...finishedResult, extra: true },
        schema: "poietra.export-session-response",
        version: 1,
      }).success,
    ).toBe(false);
  });

  it("keeps the closed refusal vocabulary sorted and duplicate-free", () => {
    const sorted = [...EXPORT_SESSION_REFUSAL_REASONS].sort();
    expect([...EXPORT_SESSION_REFUSAL_REASONS]).toEqual(sorted);
    expect(new Set(EXPORT_SESSION_REFUSAL_REASONS).size).toBe(EXPORT_SESSION_REFUSAL_REASONS.length);
  });
});

describe("export encoder probe envelope", () => {
  it("admits supported and refused probe verdicts", () => {
    expect(
      exportEncoderProbeResponseV1Schema.parse({
        result: { codec: "avc1.640028", kind: "supported" },
        schema: "poietra.export-encoder-response",
        version: 1,
      }).result.kind,
    ).toBe("supported");
    expect(
      exportEncoderProbeResponseV1Schema.parse({
        result: { kind: "refused", message: "no encoder", reason: "unsupported-codec" },
        schema: "poietra.export-encoder-response",
        version: 1,
      }).result.kind,
    ).toBe("refused");
  });
});

describe("export worker messages", () => {
  it("admits the bounded export request and its cancel companion", () => {
    const request = exportWorkerRequestV1Schema.parse({
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
      requestId: 1,
      revision: REVISION,
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

  it("admits every worker response kind with the finished transfer as an ArrayBuffer", () => {
    const finished = exportWorkerResponseV1Schema.parse({
      kind: "export-finished",
      mp4: new ArrayBuffer(16),
      requestId: 1,
      schema: "poietra.export-worker-response",
      status: finishedResult,
      version: 1,
    });
    expect(finished.kind).toBe("export-finished");
    expect(
      exportWorkerResponseV1Schema.parse({
        kind: "export-refused",
        message: "no H.264 encoder",
        reason: "unsupported-codec",
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
});

describe("exportSessionRefusalFromError", () => {
  it("maps a named rejection prefix onto the closed vocabulary", () => {
    const error = new Error("gpu-unavailable: no WebGPU adapter for offscreen export");
    error.name = "PoietraExportSessionRefused";
    expect(exportSessionRefusalFromError(error)).toEqual({
      message: "gpu-unavailable: no WebGPU adapter for offscreen export",
      reason: "gpu-unavailable",
    });
  });

  it("keeps an unknown prefix as invalid-request without inventing a reason", () => {
    const error = new Error("brand-new-reason: mystery");
    error.name = "PoietraExportSessionRefused";
    expect(exportSessionRefusalFromError(error)).toEqual({
      message: "brand-new-reason: mystery",
      reason: "invalid-request",
    });
  });

  it("returns null for foreign errors", () => {
    expect(exportSessionRefusalFromError(new Error("cancelled: nope"))).toBeNull();
    expect(exportSessionRefusalFromError("cancelled: nope")).toBeNull();
  });
});
