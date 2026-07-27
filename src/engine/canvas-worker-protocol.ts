import { z } from "zod";
import {
  engineSampleRequestV1Schema,
  MAX_PREVIEW_SAMPLE_JSON_BYTES,
  MAX_PREVIEW_SNAPSHOT_JSON_BYTES,
  previewUrlsShareOrigin,
} from "./preview-worker-protocol";
import { finiteNumberV1Schema, opaqueIdV1Schema, sha256V1Schema } from "./primitives";
import { renderViewportV1Schema } from "./render-packet";

export const POIETRA_CANVAS_WORKER_VERSION = 1 as const;
export const POIETRA_CANVAS_TELEMETRY_ABI_VERSION = 1 as const;
export const MAX_CANVAS_SNAPSHOT_JSON_BYTES = MAX_PREVIEW_SNAPSHOT_JSON_BYTES;
export const MAX_CANVAS_SAMPLE_JSON_BYTES = MAX_PREVIEW_SAMPLE_JSON_BYTES;
export const MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES = 16 * 1024;
export const MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES = 32 * 1024;
export const MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES = 8 * 1024;
export const MAX_CANVAS_WASM_MODULE_URL_LENGTH = 2_048;

export const canvasUrlsShareOrigin = previewUrlsShareOrigin;

function isOffscreenCanvas(value: unknown): value is OffscreenCanvas {
  return typeof OffscreenCanvas !== "undefined" && value instanceof OffscreenCanvas;
}

const requestIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revisionSchema = sha256V1Schema;
const snapshotJsonSchema = z
  .instanceof(ArrayBuffer)
  .refine((bytes) => bytes.byteLength <= MAX_CANVAS_SNAPSHOT_JSON_BYTES, {
    message: `Scene snapshot JSON accepts at most ${MAX_CANVAS_SNAPSHOT_JSON_BYTES} bytes.`,
  });
const offscreenCanvasSchema = z.custom<OffscreenCanvas>(isOffscreenCanvas, "Expected an OffscreenCanvas.");

export const canvasWorkerRequestEnvelopeV1 = {
  requestId: requestIdSchema,
  schema: z.literal("poietra.canvas-worker-request"),
  version: z.literal(POIETRA_CANVAS_WORKER_VERSION),
};
const requestEnvelope = canvasWorkerRequestEnvelopeV1;

const installCanvasRequestV1Schema = z
  .object({
    ...requestEnvelope,
    canvas: offscreenCanvasSchema,
    // Dev/test-only flag: asks a dev worker build to arm its frame-proof
    // channel. Production workers reject flagged installs as a bounded error.
    captureFrameEvidence: z.boolean().optional(),
    kind: z.literal("install-canvas"),
    revision: revisionSchema,
    snapshotJson: snapshotJsonSchema,
    wasmModuleUrl: z.string().url().max(MAX_CANVAS_WASM_MODULE_URL_LENGTH),
  })
  .strict();

const replaceSceneRequestV1Schema = z
  .object({
    ...requestEnvelope,
    baseRevision: revisionSchema,
    kind: z.literal("replace-scene"),
    revision: revisionSchema,
    snapshotJson: snapshotJsonSchema,
  })
  .strict();

const renderFrameRequestV1Schema = z
  .object({
    ...requestEnvelope,
    kind: z.literal("render-frame"),
    revision: revisionSchema,
    sampleTime: finiteNumberV1Schema.nonnegative(),
    viewport: renderViewportV1Schema,
  })
  .strict();

const renderFrameTelemetryRequestV1Schema = z
  .object({
    ...requestEnvelope,
    kind: z.literal("render-frame-telemetry"),
    revision: revisionSchema,
    sampleTime: finiteNumberV1Schema.nonnegative(),
    viewport: renderViewportV1Schema,
  })
  .strict();

const collectAdapterEvidenceRequestV1Schema = z
  .object({
    ...requestEnvelope,
    kind: z.literal("collect-adapter-evidence"),
    revision: revisionSchema,
  })
  .strict();

export const canvasWorkerRequestV1Schema = z.discriminatedUnion("kind", [
  installCanvasRequestV1Schema,
  replaceSceneRequestV1Schema,
  renderFrameRequestV1Schema,
  renderFrameTelemetryRequestV1Schema,
  collectAdapterEvidenceRequestV1Schema,
]);

export const canvasEngineSampleRequestV1Schema = engineSampleRequestV1Schema;

export const canvasRenderErrorCodeV1Schema = z.enum([
  "invalid-request",
  "evaluation-failed",
  "unsupported-frame",
  "surface-outdated",
  "surface-lost",
  "surface-timeout",
  "surface-occluded",
  "surface-validation",
  "device-lost",
  "gpu-out-of-memory",
  "gpu-validation",
  "gpu-internal",
  "response-too-large",
  "serialization-failed",
]);

const canvasRenderResultV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      code: canvasRenderErrorCodeV1Schema,
      kind: z.literal("error"),
      message: z.string().min(1).max(2_048),
      packetId: opaqueIdV1Schema.nullable(),
      sampleTime: finiteNumberV1Schema.nonnegative().nullable(),
      viewport: renderViewportV1Schema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("presented"),
      packetId: opaqueIdV1Schema,
      sampleTime: finiteNumberV1Schema.nonnegative(),
      suboptimal: z.boolean(),
      viewport: renderViewportV1Schema,
    })
    .strict(),
]);

export const canvasRenderResponseV1Schema = z
  .object({
    result: canvasRenderResultV1Schema,
    schema: z.literal("poietra.canvas-render-response"),
    version: z.literal(1),
  })
  .strict();

const canvasPhaseSampleV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("measured"), ms: finiteNumberV1Schema.nonnegative() }).strict(),
  z.object({ kind: z.literal("skipped") }).strict(),
  z.object({ kind: z.literal("unavailable"), reason: z.string().min(1).max(500) }).strict(),
]);

const canvasCacheOutcomeV1Schema = z.enum(["absent", "hit", "miss", "retained", "skipped"]);
const nullableTelemetryCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();

export const canvasFrameTelemetryV1Schema = z
  .object({
    caches: z
      .object({
        pipeline: canvasCacheOutcomeV1Schema,
        preparedGeometry: canvasCacheOutcomeV1Schema,
        surfaceConfiguration: canvasCacheOutcomeV1Schema,
      })
      .strict(),
    clock: z.enum(["unavailable", "worker-performance-now"]),
    counts: z
      .object({
        bufferCreations: nullableTelemetryCountSchema,
        drawCalls: nullableTelemetryCountSchema,
        evaluatedDraws: nullableTelemetryCountSchema,
        evaluatedEntities: nullableTelemetryCountSchema,
        surfaceConfigurations: nullableTelemetryCountSchema,
        tessellationCalls: nullableTelemetryCountSchema,
        tessellatedIndices: nullableTelemetryCountSchema,
        tessellatedVertices: nullableTelemetryCountSchema,
        uploadBytes: nullableTelemetryCountSchema,
      })
      .strict(),
    phases: z
      .object({
        browserComposite: canvasPhaseSampleV1Schema,
        bufferCreateAndStage: canvasPhaseSampleV1Schema,
        commandEncodeTotal: canvasPhaseSampleV1Schema,
        drawRecord: canvasPhaseSampleV1Schema,
        evaluate: canvasPhaseSampleV1Schema,
        gpuErrorScopeResolution: canvasPhaseSampleV1Schema,
        gpuExecution: canvasPhaseSampleV1Schema,
        gpuQueueSubmittedWorkDone: canvasPhaseSampleV1Schema,
        postPresentReconfigure: canvasPhaseSampleV1Schema,
        prepare: canvasPhaseSampleV1Schema,
        present: canvasPhaseSampleV1Schema,
        submit: canvasPhaseSampleV1Schema,
        surfaceAcquire: canvasPhaseSampleV1Schema,
        tessellate: canvasPhaseSampleV1Schema,
        vertexIndexEncode: canvasPhaseSampleV1Schema,
      })
      .strict(),
    totalMs: finiteNumberV1Schema.nonnegative().nullable(),
  })
  .strict();

export const canvasRenderTelemetryResponseV1Schema = z
  .object({
    result: canvasRenderResultV1Schema,
    schema: z.literal("poietra.canvas-render-telemetry-response"),
    telemetry: canvasFrameTelemetryV1Schema,
    version: z.literal(1),
  })
  .strict();

/**
 * Pairwise non-overlapping phases whose measured values may be summed and
 * compared against `totalMs`. `drawRecord` is excluded (nested inside
 * `commandEncodeTotal`); the always-unavailable phases contribute no time.
 */
export const CANVAS_TELEMETRY_ADDITIVE_PHASES = [
  "evaluate",
  "prepare",
  "tessellate",
  "vertexIndexEncode",
  "bufferCreateAndStage",
  "surfaceAcquire",
  "commandEncodeTotal",
  "submit",
  "present",
  "postPresentReconfigure",
  "gpuErrorScopeResolution",
  "gpuQueueSubmittedWorkDone",
] as const;

export type CanvasTelemetryAttributionViolationV1 = Readonly<{
  additiveSumMs: number | null;
  reason: string;
  residualMs: number | null;
  totalMs: number | null;
}>;

/**
 * Checks the internal attribution consistency of one presented frame's
 * telemetry: every additive phase must be measured (or genuinely skipped),
 * and the additive sum must not exceed `totalMs` beyond the clock-quantization
 * tolerance. An impossible combination (for example a phase sum larger than
 * the total) is a machine-readable violation, never silently clamped away.
 */
export function canvasTelemetryAttributionViolation(
  telemetry: CanvasFrameTelemetryV1,
  toleranceMs: number,
): CanvasTelemetryAttributionViolationV1 | null {
  if (telemetry.totalMs === null) {
    return { additiveSumMs: null, reason: "totalMs is unavailable", residualMs: null, totalMs: null };
  }
  let additiveSumMs = 0;
  for (const name of CANVAS_TELEMETRY_ADDITIVE_PHASES) {
    const sample = telemetry.phases[name];
    if (sample.kind === "measured") additiveSumMs += sample.ms;
    else if (sample.kind === "unavailable") {
      return {
        additiveSumMs: null,
        reason: `additive phase ${name} is unavailable, so totalMs cannot be attributed`,
        residualMs: null,
        totalMs: telemetry.totalMs,
      };
    }
    // A skipped additive phase genuinely did not execute and contributes 0.
  }
  const residualMs = telemetry.totalMs - additiveSumMs;
  if (!Number.isFinite(residualMs) || residualMs < -toleranceMs) {
    return {
      additiveSumMs,
      reason: `the additive phase sum exceeds totalMs beyond the ${toleranceMs}ms tolerance`,
      residualMs,
      totalMs: telemetry.totalMs,
    };
  }
  return null;
}

const boundedAdapterEvidenceStringSchema = z.string().max(256);
const boundedAdapterEvidenceDumpSchema = z.string().max(1_000);

export const canvasAdapterEvidenceV1Schema = z
  .object({
    adapter: z
      .object({
        backend: boundedAdapterEvidenceStringSchema,
        deviceId: z.number().int().nonnegative(),
        deviceType: boundedAdapterEvidenceStringSchema,
        driver: boundedAdapterEvidenceStringSchema,
        driverInfo: boundedAdapterEvidenceStringSchema,
        name: boundedAdapterEvidenceStringSchema,
        source: z.literal("worker-wgpu-adapter-info"),
        subgroupMaxSize: z.number().int().nonnegative(),
        subgroupMinSize: z.number().int().nonnegative(),
        vendorId: z.number().int().nonnegative(),
      })
      .strict(),
    device: z
      .object({
        label: boundedAdapterEvidenceStringSchema,
        requestedFeatures: boundedAdapterEvidenceDumpSchema,
        requestedLimits: boundedAdapterEvidenceDumpSchema,
      })
      .strict(),
    kind: z.literal("available"),
    schema: z.literal("poietra.canvas-adapter-evidence"),
    surface: z
      .object({
        alphaMode: boundedAdapterEvidenceStringSchema,
        presentMode: boundedAdapterEvidenceStringSchema,
        surfaceFormat: boundedAdapterEvidenceStringSchema,
        viewFormat: boundedAdapterEvidenceStringSchema,
      })
      .strict(),
    version: z.literal(1),
  })
  .strict();

export const canvasAdapterEvidenceResponseV1Schema = z.discriminatedUnion("kind", [
  canvasAdapterEvidenceV1Schema,
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.string().min(1).max(500),
      schema: z.literal("poietra.canvas-adapter-evidence"),
      version: z.literal(1),
    })
    .strict(),
]);

export const canvasWorkerErrorCodeV1Schema = z.union([
  z.enum([
    "internal-error",
    "invalid-message",
    "invalid-state",
    "protocol-violation",
    "renderer-unavailable",
    "snapshot-rejected",
    "stale-revision",
    "telemetry-unavailable",
    "wasm-load-failed",
  ]),
  canvasRenderErrorCodeV1Schema,
]);

export const canvasWorkerResponseEnvelopeV1 = {
  requestId: requestIdSchema,
  revision: revisionSchema,
  schema: z.literal("poietra.canvas-worker-response"),
  version: z.literal(POIETRA_CANVAS_WORKER_VERSION),
};

const canvasReadyResponseV1Schema = z
  .object({
    ...canvasWorkerResponseEnvelopeV1,
    kind: z.literal("canvas-ready"),
    operation: z.enum(["install", "replace"]),
  })
  .strict();

const framePresentedResponseV1Schema = z
  .object({
    ...canvasWorkerResponseEnvelopeV1,
    kind: z.literal("frame-presented"),
    packetId: opaqueIdV1Schema,
    sampleTime: finiteNumberV1Schema.nonnegative(),
    suboptimal: z.boolean(),
    viewport: renderViewportV1Schema,
  })
  .strict();

const errorResponseV1Schema = z
  .object({
    code: canvasWorkerErrorCodeV1Schema,
    fallback: z.literal("whole-scene"),
    kind: z.literal("error"),
    message: z.string().min(1).max(4_096),
    requestId: requestIdSchema.nullable(),
    revision: revisionSchema.nullable(),
    schema: z.literal("poietra.canvas-worker-response"),
    version: z.literal(POIETRA_CANVAS_WORKER_VERSION),
  })
  .strict();

const framePresentedTelemetryResponseV1Schema = z
  .object({
    ...canvasWorkerResponseEnvelopeV1,
    kind: z.literal("frame-presented-telemetry"),
    packetId: opaqueIdV1Schema,
    sampleTime: finiteNumberV1Schema.nonnegative(),
    suboptimal: z.boolean(),
    telemetry: canvasFrameTelemetryV1Schema,
    viewport: renderViewportV1Schema,
  })
  .strict();

const adapterEvidenceResponseV1Schema = z
  .object({
    ...canvasWorkerResponseEnvelopeV1,
    evidence: canvasAdapterEvidenceV1Schema,
    kind: z.literal("adapter-evidence"),
  })
  .strict();

/**
 * A telemetry render that failed inside the engine. Unlike the plain error
 * response, this dedicated envelope preserves the partial per-phase telemetry
 * and the engine's error correlation, so surface, error-scope, device-loss,
 * and rejected-fence failures keep their stage evidence all the way to the
 * client and harness. The normal render error response is never widened.
 */
const frameTelemetryFailedResponseV1Schema = z
  .object({
    ...canvasWorkerResponseEnvelopeV1,
    error: z
      .object({
        code: canvasRenderErrorCodeV1Schema,
        message: z.string().min(1).max(2_048),
        packetId: opaqueIdV1Schema.nullable(),
        sampleTime: finiteNumberV1Schema.nonnegative().nullable(),
        viewport: renderViewportV1Schema.nullable(),
      })
      .strict(),
    kind: z.literal("frame-telemetry-failed"),
    telemetry: canvasFrameTelemetryV1Schema,
  })
  .strict();

export const canvasWorkerResponseV1Schema = z.discriminatedUnion("kind", [
  adapterEvidenceResponseV1Schema,
  canvasReadyResponseV1Schema,
  errorResponseV1Schema,
  framePresentedResponseV1Schema,
  framePresentedTelemetryResponseV1Schema,
  frameTelemetryFailedResponseV1Schema,
]);

export type CanvasAdapterEvidenceV1 = z.infer<typeof canvasAdapterEvidenceV1Schema>;
export type CanvasEngineSampleRequestV1 = z.infer<typeof canvasEngineSampleRequestV1Schema>;
export type CanvasFrameTelemetryV1 = z.infer<typeof canvasFrameTelemetryV1Schema>;
export type CanvasRenderErrorCodeV1 = z.infer<typeof canvasRenderErrorCodeV1Schema>;
export type CanvasRenderResponseV1 = z.infer<typeof canvasRenderResponseV1Schema>;
export type CanvasRenderTelemetryResponseV1 = z.infer<typeof canvasRenderTelemetryResponseV1Schema>;
export type CanvasWorkerErrorCodeV1 = z.infer<typeof canvasWorkerErrorCodeV1Schema>;
export type CanvasWorkerRequestV1 = z.infer<typeof canvasWorkerRequestV1Schema>;
export type CanvasWorkerResponseV1 = z.infer<typeof canvasWorkerResponseV1Schema>;
