// Shared unit-test fixtures for the opt-in canvas telemetry ABI. Test-only:
// production code never imports this module.

import type { CanvasAdapterEvidenceV1, CanvasFrameTelemetryV1 } from "./canvas-worker-protocol";

/// A fully measured presented frame whose additive phases sum to 5.32ms
/// against totalMs 5.5ms, so it passes attribution validation as-is.
export function measuredTelemetryFixtureV1(): CanvasFrameTelemetryV1 {
  return {
    caches: { pipeline: "retained", preparedGeometry: "miss", surfaceConfiguration: "hit" },
    clock: "worker-performance-now",
    counts: {
      bufferCreations: 2,
      drawCalls: 3,
      evaluatedDraws: 3,
      evaluatedEntities: 3,
      surfaceConfigurations: 0,
      tessellationCalls: 3,
      tessellatedIndices: 96,
      tessellatedVertices: 34,
      uploadBytes: 1_200,
    },
    phases: {
      browserComposite: { kind: "unavailable", reason: "the worker cannot observe browser compositing" },
      bufferCreateAndStage: { kind: "measured", ms: 0.05 },
      commandEncodeTotal: { kind: "measured", ms: 0.08 },
      drawRecord: { kind: "measured", ms: 0.02 },
      evaluate: { kind: "measured", ms: 0.6 },
      gpuErrorScopeResolution: { kind: "measured", ms: 1.1 },
      gpuExecution: { kind: "unavailable", reason: "timestamp queries are not requested" },
      gpuQueueSubmittedWorkDone: { kind: "measured", ms: 2.4 },
      postPresentReconfigure: { kind: "skipped" },
      prepare: { kind: "measured", ms: 0.03 },
      present: { kind: "measured", ms: 0.02 },
      submit: { kind: "measured", ms: 0.1 },
      surfaceAcquire: { kind: "measured", ms: 0.04 },
      tessellate: { kind: "measured", ms: 0.7 },
      vertexIndexEncode: { kind: "measured", ms: 0.2 },
    },
    totalMs: 5.5,
  };
}

/// The all-null counts of a frame whose counters were never finalized.
export function nullTelemetryCountsV1(): CanvasFrameTelemetryV1["counts"] {
  return {
    bufferCreations: null,
    drawCalls: null,
    evaluatedDraws: null,
    evaluatedEntities: null,
    surfaceConfigurations: null,
    tessellationCalls: null,
    tessellatedIndices: null,
    tessellatedVertices: null,
    uploadBytes: null,
  };
}

/// A frame observed without a usable worker clock: every stage phase is
/// unavailable with `reason`, the two architecturally unobservable phases keep
/// their own reasons, and counts/totalMs are null.
export function unavailableTelemetryFixtureV1(reason = "no clock"): CanvasFrameTelemetryV1 {
  const unavailable = { kind: "unavailable", reason } as const;
  return {
    caches: { pipeline: "retained", preparedGeometry: "skipped", surfaceConfiguration: "miss" },
    clock: "unavailable",
    counts: nullTelemetryCountsV1(),
    phases: {
      browserComposite: { kind: "unavailable", reason: "the worker cannot observe browser compositing" },
      bufferCreateAndStage: unavailable,
      commandEncodeTotal: unavailable,
      drawRecord: unavailable,
      evaluate: unavailable,
      gpuErrorScopeResolution: unavailable,
      gpuExecution: { kind: "unavailable", reason: "timestamp queries are not requested" },
      gpuQueueSubmittedWorkDone: unavailable,
      postPresentReconfigure: unavailable,
      prepare: unavailable,
      present: unavailable,
      submit: unavailable,
      surfaceAcquire: unavailable,
      tessellate: unavailable,
      vertexIndexEncode: unavailable,
    },
    totalMs: null,
  };
}

export function adapterEvidenceFixtureV1(): CanvasAdapterEvidenceV1 {
  return {
    adapter: {
      backend: "BrowserWebGpu",
      deviceId: 0,
      deviceType: "Other",
      driver: "",
      driverInfo: "",
      name: "Fake Adapter",
      source: "worker-wgpu-adapter-info",
      subgroupMaxSize: 128,
      subgroupMinSize: 4,
      vendorId: 0,
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
}
