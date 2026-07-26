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
export const MAX_CANVAS_SNAPSHOT_JSON_BYTES = MAX_PREVIEW_SNAPSHOT_JSON_BYTES;
export const MAX_CANVAS_SAMPLE_JSON_BYTES = MAX_PREVIEW_SAMPLE_JSON_BYTES;
export const MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES = 16 * 1024;
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

export const canvasWorkerRequestV1Schema = z.discriminatedUnion("kind", [
  installCanvasRequestV1Schema,
  replaceSceneRequestV1Schema,
  renderFrameRequestV1Schema,
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

export const canvasRenderResponseV1Schema = z
  .object({
    result: z.discriminatedUnion("kind", [
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
    ]),
    schema: z.literal("poietra.canvas-render-response"),
    version: z.literal(1),
  })
  .strict();

export const canvasWorkerErrorCodeV1Schema = z.union([
  z.enum([
    "internal-error",
    "invalid-message",
    "invalid-state",
    "protocol-violation",
    "renderer-unavailable",
    "snapshot-rejected",
    "stale-revision",
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

export const canvasWorkerResponseV1Schema = z.discriminatedUnion("kind", [
  canvasReadyResponseV1Schema,
  errorResponseV1Schema,
  framePresentedResponseV1Schema,
]);

export type CanvasEngineSampleRequestV1 = z.infer<typeof canvasEngineSampleRequestV1Schema>;
export type CanvasRenderErrorCodeV1 = z.infer<typeof canvasRenderErrorCodeV1Schema>;
export type CanvasRenderResponseV1 = z.infer<typeof canvasRenderResponseV1Schema>;
export type CanvasWorkerErrorCodeV1 = z.infer<typeof canvasWorkerErrorCodeV1Schema>;
export type CanvasWorkerRequestV1 = z.infer<typeof canvasWorkerRequestV1Schema>;
export type CanvasWorkerResponseV1 = z.infer<typeof canvasWorkerResponseV1Schema>;
