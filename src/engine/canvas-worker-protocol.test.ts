import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canvasRenderResponseV1Schema,
  canvasUrlsShareOrigin,
  canvasWorkerRequestV1Schema,
  canvasWorkerResponseV1Schema,
  MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES,
  MAX_CANVAS_SAMPLE_JSON_BYTES,
  MAX_CANVAS_SNAPSHOT_JSON_BYTES,
  MAX_CANVAS_WASM_MODULE_URL_LENGTH,
} from "./canvas-worker-protocol";
import { MAX_PREVIEW_SAMPLE_JSON_BYTES, MAX_PREVIEW_SNAPSHOT_JSON_BYTES } from "./preview-worker-protocol";

const REVISION = "a".repeat(64);

class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
}

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canvas worker v1 protocol", () => {
  it("transfers a canvas and snapshot only during installation", () => {
    const install = {
      canvas: new FakeOffscreenCanvas(160, 90),
      kind: "install-canvas",
      requestId: 1,
      revision: REVISION,
      schema: "poietra.canvas-worker-request",
      snapshotJson: new ArrayBuffer(16),
      version: 1,
      wasmModuleUrl: "https://studio.test/engine-wasm/poietra_wasm.js",
    };
    expect(canvasWorkerRequestV1Schema.parse(install)).toEqual(install);
    expect(canvasWorkerRequestV1Schema.safeParse({ ...install, debug: true }).success).toBe(false);

    const render = {
      kind: "render-frame",
      requestId: 2,
      revision: REVISION,
      sampleTime: 1,
      schema: "poietra.canvas-worker-request",
      version: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    };
    expect(canvasWorkerRequestV1Schema.parse(render)).toEqual(render);
    expect(canvasWorkerRequestV1Schema.safeParse({ ...render, canvas: install.canvas }).success).toBe(false);
    expect(canvasWorkerRequestV1Schema.safeParse({ ...render, snapshotJson: install.snapshotJson }).success).toBe(
      false,
    );
    expect(canvasWorkerRequestV1Schema.safeParse({ ...render, evidence: ["caller-owned"] }).success).toBe(false);
  });

  it("reuses the established snapshot and sample byte envelopes", () => {
    expect(MAX_CANVAS_SNAPSHOT_JSON_BYTES).toBe(MAX_PREVIEW_SNAPSHOT_JSON_BYTES);
    expect(MAX_CANVAS_SAMPLE_JSON_BYTES).toBe(MAX_PREVIEW_SAMPLE_JSON_BYTES);
    expect(MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES).toBe(16 * 1024);
    expect(MAX_CANVAS_WASM_MODULE_URL_LENGTH).toBe(2_048);
  });

  it("matches the strict Rust canvas response without a RenderPacket", () => {
    const presented = {
      result: {
        kind: "presented",
        packetId: "canvas:2",
        sampleTime: 1,
        suboptimal: false,
        viewport: { heightPx: 90, widthPx: 160 },
      },
      schema: "poietra.canvas-render-response",
      version: 1,
    };
    expect(canvasRenderResponseV1Schema.parse(presented)).toEqual(presented);
    expect(
      canvasRenderResponseV1Schema.safeParse({
        ...presented,
        result: { ...presented.result, packet: { draws: [] } },
      }).success,
    ).toBe(false);

    const rejected = {
      result: {
        code: "unsupported-frame",
        kind: "error",
        message: "stroke rendering is not implemented",
        packetId: "canvas:2",
        sampleTime: 1,
        viewport: { heightPx: 90, widthPx: 160 },
      },
      schema: "poietra.canvas-render-response",
      version: 1,
    };
    expect(canvasRenderResponseV1Schema.parse(rejected)).toEqual(rejected);
  });

  it("keeps Worker responses small and signals whole-scene fallback", () => {
    const frame = {
      kind: "frame-presented",
      packetId: "canvas:2",
      requestId: 2,
      revision: REVISION,
      sampleTime: 1,
      schema: "poietra.canvas-worker-response",
      suboptimal: false,
      version: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    };
    expect(canvasWorkerResponseV1Schema.parse(frame)).toEqual(frame);
    expect(canvasWorkerResponseV1Schema.safeParse({ ...frame, responseJson: new ArrayBuffer(1) }).success).toBe(false);
    expect(canvasWorkerResponseV1Schema.safeParse({ ...frame, packet: { draws: [] } }).success).toBe(false);

    expect(
      canvasWorkerResponseV1Schema.safeParse({
        code: "surface-lost",
        fallback: "whole-scene",
        kind: "error",
        message: "surface lost",
        requestId: 2,
        revision: REVISION,
        schema: "poietra.canvas-worker-response",
        version: 1,
      }).success,
    ).toBe(true);
  });

  it("shares tuple origins without treating file URLs as same-origin", () => {
    expect(canvasUrlsShareOrigin(new URL("https://studio.test/a"), new URL("https://studio.test/b"))).toBe(true);
    expect(canvasUrlsShareOrigin(new URL("tauri://localhost/a"), new URL("tauri://localhost/b"))).toBe(true);
    expect(canvasUrlsShareOrigin(new URL("https://studio.test"), new URL("https://other.test"))).toBe(false);
    expect(canvasUrlsShareOrigin(new URL("file:///tmp/a"), new URL("file:///tmp/b"))).toBe(false);
  });
});
