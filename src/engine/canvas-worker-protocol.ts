import { z } from "zod";
import { canvasPngAssetTransfersV1Schema } from "./canvas-png-assets";
import {
  evidenceV1Schema,
  finiteNumberV1Schema,
  opaqueIdV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
} from "./primitives";
import { renderViewportV1Schema } from "./render-packet";
import { MAX_SCENE_DELTA_JSON_BYTES } from "./scene-delta";

export const POIETRA_CANVAS_WORKER_VERSION = 1 as const;
export const POIETRA_CANVAS_TELEMETRY_ABI_VERSION = 3 as const;
export const MAX_CANVAS_SNAPSHOT_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_CANVAS_SAMPLE_JSON_BYTES = 256 * 1024;
export const MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES = 16 * 1024;
export const MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES = 32 * 1024;
export const MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES = 8 * 1024;
export const MAX_CANVAS_SCENE_DELTA_ACK_JSON_BYTES = 128 * 1024;
export const MAX_CANVAS_WASM_MODULE_URL_LENGTH = 2_048;
export const MAX_CANVAS_INTERACTION_ENTITY_IDS = 128;

export function canvasUrlsShareOrigin(left: URL, right: URL) {
  if (left.origin !== "null" || right.origin !== "null") return left.origin === right.origin;
  return left.protocol !== "file:" && left.protocol === right.protocol && left.host === right.host;
}

function isOffscreenCanvas(value: unknown): value is OffscreenCanvas {
  return typeof OffscreenCanvas !== "undefined" && value instanceof OffscreenCanvas;
}

const requestIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revisionSchema = sha256V1Schema;

/**
 * Makes advisory interaction metadata bounded and JSON/clone safe without
 * rejecting the pixel render. Valid duplicates remain visible to Rust's
 * request-order validator; invalid entries keep their position as null.
 */
export function normalizeCanvasInteractionEntityIdsV1(value: unknown): readonly (string | null)[] | null | undefined {
  if (value === undefined) return undefined;
  try {
    if (!Array.isArray(value) || value.length > MAX_CANVAS_INTERACTION_ENTITY_IDS) return null;
    const normalized: (string | null)[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const parsed = sourceIdentityV1Schema.safeParse(value[index]);
      normalized.push(parsed.success ? parsed.data : null);
    }
    return normalized;
  } catch {
    return null;
  }
}
const snapshotJsonSchema = z
  .instanceof(ArrayBuffer)
  .refine((bytes) => bytes.byteLength <= MAX_CANVAS_SNAPSHOT_JSON_BYTES, {
    message: `Scene snapshot JSON accepts at most ${MAX_CANVAS_SNAPSHOT_JSON_BYTES} bytes.`,
  });
const sceneDeltaJsonSchema = z
  .instanceof(ArrayBuffer)
  .refine((bytes) => bytes.byteLength <= MAX_SCENE_DELTA_JSON_BYTES, {
    message: `Scene delta JSON accepts at most ${MAX_SCENE_DELTA_JSON_BYTES} bytes.`,
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
    assetPayloads: canvasPngAssetTransfersV1Schema,
    revision: revisionSchema,
    snapshotJson: snapshotJsonSchema,
    wasmModuleUrl: z.string().url().max(MAX_CANVAS_WASM_MODULE_URL_LENGTH),
  })
  .strict();

const replaceSceneRequestV1Schema = z
  .object({
    ...requestEnvelope,
    baseRevision: revisionSchema,
    assetPayloads: canvasPngAssetTransfersV1Schema,
    kind: z.literal("replace-scene"),
    revision: revisionSchema,
    snapshotJson: snapshotJsonSchema,
  })
  .strict();

const applySceneDeltaRequestV1Schema = z
  .object({
    ...requestEnvelope,
    baseRevision: revisionSchema,
    deltaJson: sceneDeltaJsonSchema,
    kind: z.literal("apply-scene-delta"),
    revision: revisionSchema,
  })
  .strict();

const renderFrameRequestV1Schema = z
  .object({
    ...requestEnvelope,
    interactionEntityIds: z.unknown().optional(),
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
  applySceneDeltaRequestV1Schema,
  renderFrameRequestV1Schema,
  renderFrameTelemetryRequestV1Schema,
  collectAdapterEvidenceRequestV1Schema,
]);

export const canvasEngineSampleRequestV1Schema = z
  .object({
    evidence: z.array(evidenceV1Schema).max(64),
    interactionEntityIds: z.unknown().optional(),
    packetId: opaqueIdV1Schema,
    sampleTime: finiteNumberV1Schema.nonnegative(),
    schema: z.literal("poietra.engine-sample-request"),
    version: z.literal(POIETRA_CANVAS_WORKER_VERSION),
    viewport: renderViewportV1Schema,
  })
  .strict();

const canvasInteractionBoundsV1Schema = z
  .tuple([finiteNumberV1Schema, finiteNumberV1Schema, finiteNumberV1Schema, finiteNumberV1Schema])
  .refine(([minimumX, minimumY, maximumX, maximumY]) => minimumX <= maximumX && minimumY <= maximumY, {
    message: "Interaction bounds must be ordered as minimumX, minimumY, maximumX, maximumY.",
  });

const canvasInteractionEntryV1Schema = z.discriminatedUnion("status", [
  z.object({ bounds: canvasInteractionBoundsV1Schema, status: z.literal("present") }).strict(),
  z.object({ status: z.literal("inactive") }).strict(),
  z.object({ status: z.literal("empty") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);
const tolerantCanvasInteractionEntryV1Schema = canvasInteractionEntryV1Schema.catch({ status: "unavailable" });

const canvasInteractionResultV1Schema = z.discriminatedUnion("status", [
  z
    .object({
      entries: z.array(tolerantCanvasInteractionEntryV1Schema).max(MAX_CANVAS_INTERACTION_ENTITY_IDS),
      space: z.literal("clip-v1"),
      status: z.literal("available"),
    })
    .strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);
const tolerantCanvasInteractionResultV1Schema = canvasInteractionResultV1Schema.catch({ status: "unavailable" });

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
      // Interaction metadata is deliberately non-authoritative for pixel
      // presentation. A malformed optional payload degrades to unavailable;
      // the already-presented correlated frame remains usable.
      interaction: tolerantCanvasInteractionResultV1Schema.optional(),
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
const telemetryByteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const canvasMemoryHighWaterV1Schema = z
  .object({
    currentBytes: telemetryByteCountSchema,
    peakBytes: telemetryByteCountSchema,
  })
  .strict()
  .superRefine(({ currentBytes, peakBytes }, context) => {
    if (currentBytes > peakBytes) {
      context.addIssue({ code: "custom", message: "currentBytes cannot exceed peakBytes", path: ["currentBytes"] });
    }
  });

function addExactMemorySumIssue(
  context: z.core.$RefinementCtx<unknown>,
  left: number,
  right: number,
  reported: number,
  path: string[],
  label: string,
) {
  const expected = left + right;
  if (!Number.isSafeInteger(expected) || reported !== expected) {
    context.addIssue({ code: "custom", message: `${label} must equal its current-byte components`, path });
  }
}

function addMemoryRangeIssue(
  context: z.core.$RefinementCtx<unknown>,
  value: number,
  minimum: number,
  maximum: number,
  path: string[],
  label: string,
) {
  if (value < minimum || value > maximum) {
    context.addIssue({ code: "custom", message: `${label} is outside its component bounds`, path });
  }
}

export const canvasMeasuredMemoryTelemetryV1Schema = z
  .object({
    retainedBoundaryTotal: canvasMemoryHighWaterV1Schema,
    kind: z.literal("measured"),
    logicalGpuBreakdown: z
      .object({
        geometryBufferArena: canvasMemoryHighWaterV1Schema,
        retainedImageTextures: canvasMemoryHighWaterV1Schema,
      })
      .strict(),
    logicalGpuResident: canvasMemoryHighWaterV1Schema,
    wasmLinear: canvasMemoryHighWaterV1Schema,
    wasmLinearBreakdown: z
      .object({
        decodedImageAssets: canvasMemoryHighWaterV1Schema,
        preparedGeometryCache: canvasMemoryHighWaterV1Schema,
        retainedSceneIndex: canvasMemoryHighWaterV1Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((memory, context) => {
    addExactMemorySumIssue(
      context,
      memory.logicalGpuBreakdown.geometryBufferArena.currentBytes,
      memory.logicalGpuBreakdown.retainedImageTextures.currentBytes,
      memory.logicalGpuResident.currentBytes,
      ["logicalGpuResident", "currentBytes"],
      "logicalGpuResident.currentBytes",
    );
    addExactMemorySumIssue(
      context,
      memory.wasmLinear.currentBytes,
      memory.logicalGpuResident.currentBytes,
      memory.retainedBoundaryTotal.currentBytes,
      ["retainedBoundaryTotal", "currentBytes"],
      "retainedBoundaryTotal.currentBytes",
    );
    addMemoryRangeIssue(
      context,
      memory.logicalGpuResident.peakBytes,
      Math.max(
        memory.logicalGpuBreakdown.geometryBufferArena.peakBytes,
        memory.logicalGpuBreakdown.retainedImageTextures.peakBytes,
      ),
      memory.logicalGpuBreakdown.geometryBufferArena.peakBytes +
        memory.logicalGpuBreakdown.retainedImageTextures.peakBytes,
      ["logicalGpuResident", "peakBytes"],
      "logicalGpuResident.peakBytes",
    );
    addMemoryRangeIssue(
      context,
      memory.retainedBoundaryTotal.peakBytes,
      Math.max(memory.wasmLinear.peakBytes, memory.logicalGpuResident.peakBytes),
      memory.wasmLinear.peakBytes + memory.logicalGpuResident.peakBytes,
      ["retainedBoundaryTotal", "peakBytes"],
      "retainedBoundaryTotal.peakBytes",
    );
    for (const [name, breakdown] of Object.entries(memory.wasmLinearBreakdown)) {
      if (
        breakdown.currentBytes > memory.wasmLinear.currentBytes ||
        breakdown.peakBytes > memory.wasmLinear.peakBytes
      ) {
        context.addIssue({
          code: "custom",
          message: `${name} must remain within WebAssembly linear memory`,
          path: ["wasmLinearBreakdown", name],
        });
      }
    }
    const currentBreakdownTotal = Object.values(memory.wasmLinearBreakdown).reduce(
      (total, breakdown) => total + breakdown.currentBytes,
      0,
    );
    if (!Number.isSafeInteger(currentBreakdownTotal) || currentBreakdownTotal > memory.wasmLinear.currentBytes) {
      context.addIssue({
        code: "custom",
        message: "current WebAssembly memory breakdowns cannot exceed linear memory",
        path: ["wasmLinearBreakdown"],
      });
    }
  });

export const canvasFrameMemoryTelemetryV1Schema = z.discriminatedUnion("kind", [
  canvasMeasuredMemoryTelemetryV1Schema,
  z.object({ kind: z.literal("unavailable"), reason: z.string().min(1).max(500) }).strict(),
]);

export const canvasFrameTelemetryV1Schema = z
  .object({
    caches: z
      .object({
        imageSamplerBinding: canvasCacheOutcomeV1Schema,
        imageTexture: canvasCacheOutcomeV1Schema,
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
        imageSamplerBindingCreations: nullableTelemetryCountSchema,
        imageTextureEvictions: nullableTelemetryCountSchema,
        imageTextureUploads: nullableTelemetryCountSchema,
        surfaceConfigurations: nullableTelemetryCountSchema,
        tessellationCalls: nullableTelemetryCountSchema,
        tessellatedIndices: nullableTelemetryCountSchema,
        tessellatedVertices: nullableTelemetryCountSchema,
        uploadBytes: nullableTelemetryCountSchema,
      })
      .strict(),
    memory: canvasFrameMemoryTelemetryV1Schema,
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
    "delta-rejected",
    "snapshot-rejected",
    "stale-revision",
    "telemetry-unavailable",
    "wasm-load-failed",
  ]),
  canvasRenderErrorCodeV1Schema,
]);

export const canvasSceneDeltaDirtySetV1Schema = z
  .object({
    assets: z.boolean(),
    camera: z.boolean(),
    channelIds: z.array(sourceIdentityV1Schema).max(256),
    entityIds: z.array(sourceIdentityV1Schema).max(256),
    sceneMetadata: z.boolean(),
  })
  .strict();

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

const sceneDeltaAppliedResponseV1Schema = z
  .object({
    ...canvasWorkerResponseEnvelopeV1,
    dirty: canvasSceneDeltaDirtySetV1Schema,
    kind: z.literal("scene-delta-applied"),
  })
  .strict();

const framePresentedResponseV1Schema = z
  .object({
    ...canvasWorkerResponseEnvelopeV1,
    interaction: tolerantCanvasInteractionResultV1Schema.optional(),
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
  sceneDeltaAppliedResponseV1Schema,
]);

export type CanvasAdapterEvidenceV1 = z.infer<typeof canvasAdapterEvidenceV1Schema>;
export type CanvasEngineSampleRequestV1 = z.infer<typeof canvasEngineSampleRequestV1Schema>;
export type CanvasFrameMemoryTelemetryV1 = z.infer<typeof canvasFrameMemoryTelemetryV1Schema>;
export type CanvasFrameTelemetryV1 = z.infer<typeof canvasFrameTelemetryV1Schema>;
export type CanvasMeasuredMemoryTelemetryV1 = z.infer<typeof canvasMeasuredMemoryTelemetryV1Schema>;
export type CanvasInteractionResultV1 = z.infer<typeof canvasInteractionResultV1Schema>;
export type CanvasSceneDeltaDirtySetV1 = z.infer<typeof canvasSceneDeltaDirtySetV1Schema>;
export type CanvasRenderErrorCodeV1 = z.infer<typeof canvasRenderErrorCodeV1Schema>;
export type CanvasRenderResponseV1 = z.infer<typeof canvasRenderResponseV1Schema>;
export type CanvasRenderTelemetryResponseV1 = z.infer<typeof canvasRenderTelemetryResponseV1Schema>;
export type CanvasWorkerErrorCodeV1 = z.infer<typeof canvasWorkerErrorCodeV1Schema>;
export type CanvasWorkerRequestV1 = z.infer<typeof canvasWorkerRequestV1Schema>;
export type CanvasWorkerResponseV1 = z.infer<typeof canvasWorkerResponseV1Schema>;
