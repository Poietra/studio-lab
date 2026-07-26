import { z } from "zod";

import { evidenceV1Schema, finiteNumberV1Schema, opaqueIdV1Schema, sha256V1Schema } from "./primitives";
import { renderPacketV1Schema, renderViewportV1Schema } from "./render-packet";

export const POIETRA_PREVIEW_WORKER_VERSION = 1 as const;
export const MAX_PREVIEW_SNAPSHOT_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_PREVIEW_SAMPLE_JSON_BYTES = 256 * 1024;
export const MAX_PREVIEW_ENGINE_RESPONSE_JSON_BYTES = 8 * 1024 * 1024;

export function previewUrlsShareOrigin(left: URL, right: URL) {
  if (left.origin !== "null" || right.origin !== "null") return left.origin === right.origin;
  return left.protocol !== "file:" && left.protocol === right.protocol && left.host === right.host;
}

const requestIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revisionSchema = sha256V1Schema;
const snapshotJsonSchema = z
  .instanceof(ArrayBuffer)
  .refine((bytes) => bytes.byteLength <= MAX_PREVIEW_SNAPSHOT_JSON_BYTES, {
    message: `Scene snapshot JSON accepts at most ${MAX_PREVIEW_SNAPSHOT_JSON_BYTES} bytes.`,
  });

const workerRequestEnvelope = {
  requestId: requestIdSchema,
  schema: z.literal("poietra.preview-worker-request"),
  version: z.literal(POIETRA_PREVIEW_WORKER_VERSION),
};

export const engineSampleRequestV1Schema = z
  .object({
    evidence: z.array(evidenceV1Schema).max(64),
    packetId: opaqueIdV1Schema,
    sampleTime: finiteNumberV1Schema.nonnegative(),
    schema: z.literal("poietra.engine-sample-request"),
    version: z.literal(POIETRA_PREVIEW_WORKER_VERSION),
    viewport: renderViewportV1Schema,
  })
  .strict();

const installSceneRequestV1Schema = z
  .object({
    ...workerRequestEnvelope,
    kind: z.literal("install-scene"),
    revision: revisionSchema,
    snapshotJson: snapshotJsonSchema,
    wasmModuleUrl: z.string().url().max(2_048),
  })
  .strict();

const replaceSceneRequestV1Schema = z
  .object({
    ...workerRequestEnvelope,
    baseRevision: revisionSchema,
    kind: z.literal("replace-scene"),
    revision: revisionSchema,
    snapshotJson: snapshotJsonSchema,
  })
  .strict();

const sampleSceneRequestV1Schema = z
  .object({
    ...workerRequestEnvelope,
    kind: z.literal("sample"),
    revision: revisionSchema,
    sampleTime: finiteNumberV1Schema.nonnegative(),
    viewport: renderViewportV1Schema,
  })
  .strict();

export const previewWorkerRequestV1Schema = z.discriminatedUnion("kind", [
  installSceneRequestV1Schema,
  replaceSceneRequestV1Schema,
  sampleSceneRequestV1Schema,
]);

export const engineWorkerResponseV1Schema = z
  .object({
    result: z.discriminatedUnion("kind", [
      z
        .object({
          code: z.enum(["evaluation-failed", "invalid-request", "response-too-large", "serialization-failed"]),
          kind: z.literal("error"),
          message: z.string().min(1).max(4_096),
        })
        .strict(),
      z.object({ kind: z.literal("ready"), packet: renderPacketV1Schema }).strict(),
    ]),
    schema: z.literal("poietra.engine-worker-response"),
    version: z.literal(POIETRA_PREVIEW_WORKER_VERSION),
  })
  .strict();

export const previewWorkerErrorCodeV1Schema = z.enum([
  "internal-error",
  "invalid-message",
  "invalid-state",
  "sample-rejected",
  "snapshot-rejected",
  "stale-revision",
  "wasm-load-failed",
]);

const workerResponseEnvelope = {
  requestId: requestIdSchema,
  revision: revisionSchema,
  schema: z.literal("poietra.preview-worker-response"),
  version: z.literal(POIETRA_PREVIEW_WORKER_VERSION),
};

const sceneReadyResponseV1Schema = z
  .object({
    ...workerResponseEnvelope,
    kind: z.literal("scene-ready"),
    operation: z.enum(["install", "replace"]),
  })
  .strict();

const sampleResponseV1Schema = z
  .object({
    ...workerResponseEnvelope,
    kind: z.literal("sample-response"),
    responseJson: z
      .instanceof(ArrayBuffer)
      .refine((bytes) => bytes.byteLength <= MAX_PREVIEW_ENGINE_RESPONSE_JSON_BYTES, {
        message: `Engine responses accept at most ${MAX_PREVIEW_ENGINE_RESPONSE_JSON_BYTES} bytes.`,
      }),
  })
  .strict();

const errorResponseV1Schema = z
  .object({
    code: previewWorkerErrorCodeV1Schema,
    kind: z.literal("error"),
    message: z.string().min(1).max(4_096),
    requestId: requestIdSchema.nullable(),
    revision: revisionSchema.nullable(),
    schema: z.literal("poietra.preview-worker-response"),
    version: z.literal(POIETRA_PREVIEW_WORKER_VERSION),
  })
  .strict();

export const previewWorkerResponseV1Schema = z.discriminatedUnion("kind", [
  errorResponseV1Schema,
  sampleResponseV1Schema,
  sceneReadyResponseV1Schema,
]);

export type EngineSampleRequestV1 = z.infer<typeof engineSampleRequestV1Schema>;
export type PreviewWorkerErrorCodeV1 = z.infer<typeof previewWorkerErrorCodeV1Schema>;
export type PreviewWorkerRequestV1 = z.infer<typeof previewWorkerRequestV1Schema>;
export type PreviewWorkerResponseV1 = z.infer<typeof previewWorkerResponseV1Schema>;
