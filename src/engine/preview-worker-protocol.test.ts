import { describe, expect, it } from "vitest";

import {
  MAX_PREVIEW_ENGINE_RESPONSE_JSON_BYTES,
  MAX_PREVIEW_SAMPLE_JSON_BYTES,
  previewUrlsShareOrigin,
  previewWorkerRequestV1Schema,
  previewWorkerResponseV1Schema,
} from "./preview-worker-protocol";

const REVISION = "a".repeat(64);

describe("preview worker v1 protocol", () => {
  it("keeps each playhead request independent from the retained Scene snapshot", () => {
    const request = {
      kind: "sample",
      requestId: 3,
      revision: REVISION,
      sampleTime: 1.25,
      schema: "poietra.preview-worker-request",
      version: 1,
      viewport: { heightPx: 720, widthPx: 1_280 },
    };

    expect(previewWorkerRequestV1Schema.parse(request)).toEqual(request);
    expect(previewWorkerRequestV1Schema.safeParse({ ...request, snapshotJson: new ArrayBuffer(1) }).success).toBe(
      false,
    );
    expect(previewWorkerRequestV1Schema.safeParse({ ...request, evidence: ["caller-owned"] }).success).toBe(false);
  });

  it("pins the byte envelopes shared with the Rust worker ABI", () => {
    expect(MAX_PREVIEW_SAMPLE_JSON_BYTES).toBe(256 * 1024);
    expect(MAX_PREVIEW_ENGINE_RESPONSE_JSON_BYTES).toBe(8 * 1024 * 1024);

    const response = {
      kind: "sample-response",
      requestId: 3,
      responseJson: new ArrayBuffer(16),
      revision: REVISION,
      schema: "poietra.preview-worker-response",
      version: 1,
    };
    expect(previewWorkerResponseV1Schema.safeParse(response).success).toBe(true);
    expect(
      previewWorkerResponseV1Schema.safeParse({
        ...response,
        responseJson: new ArrayBuffer(MAX_PREVIEW_ENGINE_RESPONSE_JSON_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects unversioned, uncorrelated, or widened messages", () => {
    const install = {
      kind: "install-scene",
      requestId: 1,
      revision: REVISION,
      schema: "poietra.preview-worker-request",
      snapshotJson: new ArrayBuffer(2),
      version: 1,
      wasmModuleUrl: "https://studio.test/engine-wasm/poietra_wasm.js",
    };

    expect(previewWorkerRequestV1Schema.safeParse({ ...install, debug: true }).success).toBe(false);
    expect(previewWorkerRequestV1Schema.safeParse({ ...install, requestId: 0 }).success).toBe(false);
    expect(previewWorkerRequestV1Schema.safeParse({ ...install, version: 2 }).success).toBe(false);
    expect(
      previewWorkerResponseV1Schema.safeParse({
        code: "invalid-message",
        kind: "error",
        message: "invalid",
        requestId: null,
        revision: null,
        schema: "poietra.preview-worker-response",
        version: 1,
      }).success,
    ).toBe(true);
  });

  it("compares tuple and app-protocol origins without treating file URLs as shared", () => {
    expect(previewUrlsShareOrigin(new URL("https://studio.test/a"), new URL("https://studio.test/b"))).toBe(true);
    expect(previewUrlsShareOrigin(new URL("tauri://localhost/a"), new URL("tauri://localhost/b"))).toBe(true);
    expect(previewUrlsShareOrigin(new URL("https://studio.test"), new URL("https://other.test"))).toBe(false);
    expect(previewUrlsShareOrigin(new URL("file:///tmp/a"), new URL("file:///tmp/b"))).toBe(false);
  });
});
