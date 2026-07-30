import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  measuredTelemetryFixtureV1,
  nullTelemetryCountsV1,
  unavailableTelemetryFixtureV1,
} from "./canvas-telemetry-test-fixtures";
import {
  canvasAdapterEvidenceResponseV1Schema,
  canvasAdapterEvidenceV1Schema,
  canvasFrameTelemetryV1Schema,
  canvasRenderResponseV1Schema,
  canvasRenderTelemetryResponseV1Schema,
  canvasTelemetryAttributionViolation,
  canvasUrlsShareOrigin,
  canvasWorkerRequestV1Schema,
  canvasWorkerResponseV1Schema,
  MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES,
  MAX_CANVAS_INTERACTION_ENTITY_IDS,
  MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES,
  MAX_CANVAS_SCENE_DELTA_ACK_JSON_BYTES,
  MAX_CANVAS_SAMPLE_JSON_BYTES,
  MAX_CANVAS_SNAPSHOT_JSON_BYTES,
  MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES,
  MAX_CANVAS_WASM_MODULE_URL_LENGTH,
  normalizeCanvasInteractionEntityIdsV1,
} from "./canvas-worker-protocol";

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
      assetPayloads: [],
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

  it("bounds snapshot and sample byte envelopes", () => {
    expect(MAX_CANVAS_SNAPSHOT_JSON_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_CANVAS_SAMPLE_JSON_BYTES).toBe(256 * 1024);
    expect(MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES).toBe(16 * 1024);
    expect(MAX_CANVAS_SCENE_DELTA_ACK_JSON_BYTES).toBe(128 * 1024);
    expect(MAX_CANVAS_INTERACTION_ENTITY_IDS).toBe(128);
    expect(MAX_CANVAS_WASM_MODULE_URL_LENGTH).toBe(2_048);
  });

  it("bounds the transferred Scene delta and its dirty-set acknowledgement", () => {
    const request = {
      baseRevision: REVISION,
      deltaJson: new ArrayBuffer(256 * 1024),
      kind: "apply-scene-delta",
      requestId: 3,
      revision: "b".repeat(64),
      schema: "poietra.canvas-worker-request",
      version: 1,
    };
    expect(canvasWorkerRequestV1Schema.parse(request)).toEqual(request);
    expect(
      canvasWorkerRequestV1Schema.safeParse({ ...request, deltaJson: new ArrayBuffer(256 * 1024 + 1) }).success,
    ).toBe(false);
    expect(
      canvasWorkerResponseV1Schema.parse({
        dirty: { assets: false, camera: false, channelIds: [], entityIds: ["entity#1"], sceneMetadata: false },
        kind: "scene-delta-applied",
        requestId: 3,
        revision: "b".repeat(64),
        schema: "poietra.canvas-worker-response",
        version: 1,
      }),
    ).toMatchObject({ dirty: { entityIds: ["entity#1"] }, kind: "scene-delta-applied" });
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

  it("bounds Scene entity IDs without allowing advisory metadata to reject the pixel request", () => {
    const render = {
      interactionEntityIds: ["scene:runtime/entity#0", "scene:runtime/entity#1"],
      kind: "render-frame",
      requestId: 2,
      revision: REVISION,
      sampleTime: 1,
      schema: "poietra.canvas-worker-request",
      version: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    };
    expect(canvasWorkerRequestV1Schema.parse(render)).toEqual(render);
    expect(
      canvasWorkerRequestV1Schema.safeParse({ ...render, interactionEntityIds: ["duplicate", "duplicate"] }).success,
    ).toBe(true);
    expect(normalizeCanvasInteractionEntityIdsV1(["duplicate", "duplicate"])).toEqual(["duplicate", "duplicate"]);
    expect(normalizeCanvasInteractionEntityIdsV1(["valid#id", "bad id", 7])).toEqual(["valid#id", null, null]);
    expect(
      normalizeCanvasInteractionEntityIdsV1(
        Array.from({ length: MAX_CANVAS_INTERACTION_ENTITY_IDS + 1 }, (_, index) => `e:${index}`),
      ),
    ).toBeNull();
    expect(normalizeCanvasInteractionEntityIdsV1({ entityId: "not-an-array" })).toBeNull();

    const presented = {
      result: {
        interaction: {
          entries: [{ bounds: [-0.5, -0.25, 0.5, 0.25], status: "present" }, { status: "inactive" }],
          space: "clip-v1",
          status: "available",
        },
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
      canvasRenderResponseV1Schema.parse({
        ...presented,
        result: {
          ...presented.result,
          interaction: {
            entries: [{ bounds: [0.5, 0, -0.5, 1], status: "present" }],
            space: "clip-v1",
            status: "available",
          },
        },
      }).result,
    ).toMatchObject({
      interaction: { entries: [{ status: "unavailable" }], space: "clip-v1", status: "available" },
      kind: "presented",
    });
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

  it("keeps opt-in telemetry kinds additive and strictly bounded", () => {
    expect(MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES).toBe(32 * 1024);
    expect(MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES).toBe(8 * 1024);

    const telemetryRender = {
      kind: "render-frame-telemetry",
      requestId: 7,
      revision: REVISION,
      sampleTime: 1,
      schema: "poietra.canvas-worker-request",
      version: 1,
      viewport: { heightPx: 1_080, widthPx: 1_920 },
    };
    expect(canvasWorkerRequestV1Schema.parse(telemetryRender)).toEqual(telemetryRender);
    expect(canvasWorkerRequestV1Schema.safeParse({ ...telemetryRender, phases: [] }).success).toBe(false);

    const collectEvidence = {
      kind: "collect-adapter-evidence",
      requestId: 8,
      revision: REVISION,
      schema: "poietra.canvas-worker-request",
      version: 1,
    };
    expect(canvasWorkerRequestV1Schema.parse(collectEvidence)).toEqual(collectEvidence);
  });

  it("requires every phase to be measured, skipped, or explicitly unavailable", () => {
    const telemetry = measuredTelemetryFixtureV1();
    expect(canvasFrameTelemetryV1Schema.parse(telemetry)).toEqual(telemetry);
    expect(
      canvasFrameTelemetryV1Schema.safeParse({
        ...telemetry,
        phases: { ...telemetry.phases, evaluate: { kind: "measured" } },
      }).success,
    ).toBe(false);
    expect(
      canvasFrameTelemetryV1Schema.safeParse({
        ...telemetry,
        phases: { ...telemetry.phases, gpuQueueSubmittedWorkDone: undefined },
      }).success,
    ).toBe(false);
    expect(
      canvasFrameTelemetryV1Schema.safeParse({
        ...telemetry,
        phases: { ...telemetry.phases, evaluate: { kind: "measured", ms: -0.5 } },
      }).success,
    ).toBe(false);

    const failedFrame = {
      ...telemetry,
      counts: nullTelemetryCountsV1(),
      phases: {
        ...telemetry.phases,
        gpuQueueSubmittedWorkDone: { kind: "skipped" },
        submit: { kind: "skipped" },
      },
      totalMs: null,
    };
    expect(canvasFrameTelemetryV1Schema.parse(failedFrame)).toEqual(failedFrame);

    const response = {
      result: {
        kind: "presented",
        packetId: "canvas:7",
        sampleTime: 1,
        suboptimal: false,
        viewport: { heightPx: 1_080, widthPx: 1_920 },
      },
      schema: "poietra.canvas-render-telemetry-response",
      telemetry,
      version: 1,
    };
    expect(canvasRenderTelemetryResponseV1Schema.parse(response)).toEqual(response);
    expect(canvasRenderResponseV1Schema.safeParse(response).success).toBe(false);
  });

  it("keeps the compact render response free of telemetry payloads", () => {
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
    expect(canvasWorkerResponseV1Schema.safeParse({ ...frame, telemetry: {} }).success).toBe(false);

    const telemetryFrame = {
      ...frame,
      kind: "frame-presented-telemetry",
      telemetry: unavailableTelemetryFixtureV1(),
    };
    expect(canvasWorkerResponseV1Schema.parse(telemetryFrame)).toEqual(telemetryFrame);

    expect(
      canvasWorkerResponseV1Schema.safeParse({
        code: "telemetry-unavailable",
        fallback: "whole-scene",
        kind: "error",
        message: "the module has no telemetry ABI",
        requestId: 9,
        revision: REVISION,
        schema: "poietra.canvas-worker-response",
        version: 1,
      }).success,
    ).toBe(true);
  });

  it("bounds worker adapter evidence and names its non-page source", () => {
    const evidence = {
      adapter: {
        backend: "BrowserWebGpu",
        deviceId: 0,
        deviceType: "Other",
        driver: "",
        driverInfo: "",
        name: "Example Adapter",
        source: "worker-wgpu-adapter-info",
        subgroupMaxSize: 128,
        subgroupMinSize: 4,
        vendorId: 4_318,
      },
      device: {
        label: "poietra canvas device v1",
        requestedFeatures: "Features(0x0)",
        requestedLimits: "Limits { max_texture_dimension_1d: 8192 }",
      },
      kind: "available",
      schema: "poietra.canvas-adapter-evidence",
      surface: {
        alphaMode: "Opaque",
        presentMode: "Fifo",
        surfaceFormat: "Bgra8Unorm",
        viewFormat: "Bgra8UnormSrgb",
      },
      version: 1,
    };
    expect(canvasAdapterEvidenceV1Schema.parse(evidence)).toEqual(evidence);
    expect(
      canvasAdapterEvidenceResponseV1Schema.parse({
        kind: "unavailable",
        reason: "Canvas adapter evidence serialization failed",
        schema: "poietra.canvas-adapter-evidence",
        version: 1,
      }),
    ).toMatchObject({ kind: "unavailable" });
    expect(
      canvasAdapterEvidenceV1Schema.safeParse({
        ...evidence,
        adapter: { ...evidence.adapter, source: "page-navigator-gpu" },
      }).success,
    ).toBe(false);
    expect(
      canvasAdapterEvidenceV1Schema.safeParse({
        ...evidence,
        adapter: { ...evidence.adapter, name: "n".repeat(257) },
      }).success,
    ).toBe(false);

    const response = {
      evidence,
      kind: "adapter-evidence",
      requestId: 8,
      revision: REVISION,
      schema: "poietra.canvas-worker-response",
      version: 1,
    };
    expect(canvasWorkerResponseV1Schema.parse(response)).toEqual(response);
  });

  it("preserves failed telemetry through a dedicated envelope and accepts the Rust fallback", () => {
    const failed = {
      error: {
        code: "surface-lost",
        message: "surface was lost and must be recreated",
        packetId: "canvas:9",
        sampleTime: 1,
        viewport: { heightPx: 1_080, widthPx: 1_920 },
      },
      kind: "frame-telemetry-failed",
      requestId: 9,
      revision: REVISION,
      schema: "poietra.canvas-worker-response",
      // A frame that failed at surface acquisition: the pre-surface phases
      // stay measured, everything after the failure is skipped, and the
      // never-finalized counts/total are null.
      telemetry: {
        ...measuredTelemetryFixtureV1(),
        caches: { pipeline: "retained", preparedGeometry: "miss", surfaceConfiguration: "skipped" },
        counts: {
          ...nullTelemetryCountsV1(),
          evaluatedDraws: 100,
          evaluatedEntities: 100,
          tessellationCalls: 100,
          tessellatedIndices: 300,
          tessellatedVertices: 120,
        },
        phases: {
          ...measuredTelemetryFixtureV1().phases,
          bufferCreateAndStage: { kind: "skipped" },
          commandEncodeTotal: { kind: "skipped" },
          drawRecord: { kind: "skipped" },
          gpuErrorScopeResolution: { kind: "skipped" },
          gpuQueueSubmittedWorkDone: { kind: "skipped" },
          present: { kind: "skipped" },
          submit: { kind: "skipped" },
          vertexIndexEncode: { kind: "skipped" },
        },
        totalMs: null,
      },
      version: 1,
    };
    expect(canvasWorkerResponseV1Schema.parse(failed)).toEqual(failed);
    // The normal error response never gains a telemetry field.
    expect(
      canvasWorkerResponseV1Schema.safeParse({
        code: "surface-lost",
        fallback: "whole-scene",
        kind: "error",
        message: "surface lost",
        requestId: 9,
        revision: REVISION,
        schema: "poietra.canvas-worker-response",
        telemetry: failed.telemetry,
        version: 1,
      }).success,
    ).toBe(false);

    // Mirrors TELEMETRY_SERIALIZATION_FALLBACK_V1 in canvas_telemetry.rs
    // byte-for-byte: the static Rust fallback must satisfy this exact
    // consumer schema, with the architecturally unobservable phases
    // (browserComposite, gpuExecution) reported as unavailable with their
    // bounded reasons — matching FrameTelemetryV1::new, never skipped.
    const rustFallback = `{"result":{"kind":"error","code":"serialization-failed","message":"Canvas telemetry response serialization failed","packetId":null,"sampleTime":null,"viewport":null},"schema":"poietra.canvas-render-telemetry-response","telemetry":{"caches":{"pipeline":"retained","preparedGeometry":"skipped","surfaceConfiguration":"skipped"},"clock":"unavailable","counts":{"bufferCreations":null,"drawCalls":null,"evaluatedDraws":null,"evaluatedEntities":null,"surfaceConfigurations":null,"tessellationCalls":null,"tessellatedIndices":null,"tessellatedVertices":null,"uploadBytes":null},"phases":{"browserComposite":{"kind":"unavailable","reason":"The dedicated worker cannot observe browser compositor presentation; only the embedding page could approximate it."},"bufferCreateAndStage":{"kind":"skipped"},"commandEncodeTotal":{"kind":"skipped"},"drawRecord":{"kind":"skipped"},"evaluate":{"kind":"skipped"},"gpuErrorScopeResolution":{"kind":"skipped"},"gpuExecution":{"kind":"unavailable","reason":"GPU-side execution timing requires timestamp queries, which this pipeline does not request; only the awaited queue onSubmittedWorkDone fence is observed."},"gpuQueueSubmittedWorkDone":{"kind":"skipped"},"postPresentReconfigure":{"kind":"skipped"},"prepare":{"kind":"skipped"},"present":{"kind":"skipped"},"submit":{"kind":"skipped"},"surfaceAcquire":{"kind":"skipped"},"tessellate":{"kind":"skipped"},"vertexIndexEncode":{"kind":"skipped"}},"totalMs":null},"version":1}`;
    const parsedFallback = canvasRenderTelemetryResponseV1Schema.parse(JSON.parse(rustFallback));
    const fallbackPhases = parsedFallback.telemetry.phases;
    expect(fallbackPhases.browserComposite.kind).toBe("unavailable");
    expect(fallbackPhases.gpuExecution.kind).toBe("unavailable");
    if (fallbackPhases.browserComposite.kind === "unavailable") {
      expect(fallbackPhases.browserComposite.reason.length).toBeGreaterThan(0);
    }
    if (fallbackPhases.gpuExecution.kind === "unavailable") {
      expect(fallbackPhases.gpuExecution.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects telemetry whose additive phase sum contradicts totalMs", () => {
    // The shared fixture's additive phases sum to 5.32ms against totalMs 5.5.
    const consistent = measuredTelemetryFixtureV1();
    const parsed = canvasFrameTelemetryV1Schema.parse(consistent);
    expect(canvasTelemetryAttributionViolation(parsed, 0.5)).toBeNull();

    // An impossible combination — additive sum far above totalMs — must be a
    // machine-readable violation, never silently clamped.
    const impossible = canvasFrameTelemetryV1Schema.parse({ ...consistent, totalMs: 2 });
    const violation = canvasTelemetryAttributionViolation(impossible, 0.5);
    expect(violation).not.toBeNull();
    expect(violation!.residualMs).toBeLessThan(0);
    expect(violation!.additiveSumMs).toBeCloseTo(5.32, 5);

    // An unavailable additive phase makes attribution impossible.
    const unattributable = canvasFrameTelemetryV1Schema.parse({
      ...consistent,
      phases: { ...consistent.phases, submit: { kind: "unavailable", reason: "no clock" } },
    });
    expect(canvasTelemetryAttributionViolation(unattributable, 0.5)?.reason).toMatch(/submit/);
  });

  it("shares tuple origins without treating file URLs as same-origin", () => {
    expect(canvasUrlsShareOrigin(new URL("https://studio.test/a"), new URL("https://studio.test/b"))).toBe(true);
    expect(canvasUrlsShareOrigin(new URL("tauri://localhost/a"), new URL("tauri://localhost/b"))).toBe(true);
    expect(canvasUrlsShareOrigin(new URL("https://studio.test"), new URL("https://other.test"))).toBe(false);
    expect(canvasUrlsShareOrigin(new URL("file:///tmp/a"), new URL("file:///tmp/b"))).toBe(false);
  });
});
