import { z } from "zod";

import { manimProjectIdSchema } from "../render-pipeline/contracts";

/**
 * Wire contract for the neutral client-export publication routes
 * (`/api/projects/:projectId/exports`, ADR 0005 §"Artifact lineage and
 * publication" and §"API and compatibility policy").
 *
 * The finalize request is a single versioned binary envelope so the exact MP4
 * bytes travel untouched next to their bounded JSON metadata:
 * a 4-byte big-endian metadata length, the UTF-8 JSON metadata, then the MP4
 * bytes. There is no upload-session aggregate and no chunked transport in v1;
 * a later direct-R2 signed upload grant is a transport change, not a new
 * domain aggregate.
 */
export const CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1 = "application/vnd.poietra.client-export-finalize-v1";
export const MAX_CLIENT_EXPORT_FINALIZE_METADATA_BYTES_V1 = 64 * 1024;
export const MAX_CLIENT_EXPORT_FINALIZE_VIDEO_BYTES_V1 = 134_217_728;
export const MAX_CLIENT_EXPORT_FINALIZE_BODY_BYTES_V1 =
  4 + MAX_CLIENT_EXPORT_FINALIZE_METADATA_BYTES_V1 + MAX_CLIENT_EXPORT_FINALIZE_VIDEO_BYTES_V1;

const sha256SchemaV1 = z.string().regex(/^[0-9a-f]{64}$/u);
const revisionStringSchemaV1 = z.string().regex(/^(0|[1-9][0-9]{0,15})$/u);

export const clientExportFinalizeMetadataSchemaV1 = z
  .object({
    byteSize: z.number().int().min(1).max(MAX_CLIENT_EXPORT_FINALIZE_VIDEO_BYTES_V1),
    contentDigest: sha256SchemaV1,
    documentEpoch: z.uuid(),
    documentKey: sha256SchemaV1,
    documentRevision: revisionStringSchemaV1,
    encoderEvidence: z.record(z.string(), z.unknown()),
    exportProfile: z.unknown(),
    projectId: manimProjectIdSchema,
    publicationId: z.uuid(),
    schema: z.literal("poietra.client-export-finalize"),
    sceneRevisionHash: sha256SchemaV1,
    version: z.literal(1),
  })
  .strict();

export type ClientExportFinalizeMetadataV1 = z.infer<typeof clientExportFinalizeMetadataSchemaV1>;

export const clientExportPublicationViewSchemaV1 = z
  .object({
    byteSize: z.number().int().min(1).max(MAX_CLIENT_EXPORT_FINALIZE_VIDEO_BYTES_V1),
    contentDigest: sha256SchemaV1,
    createdBySubjectId: z.uuid(),
    documentEpoch: z.uuid(),
    documentKey: sha256SchemaV1,
    documentRevision: revisionStringSchemaV1,
    encoderEvidenceVersion: z.literal(1),
    expiresAt: z.string().min(1),
    exportProfileHash: sha256SchemaV1,
    producerKind: z.literal("browser-webcodecs"),
    projectId: manimProjectIdSchema,
    publicationId: z.uuid(),
    publishedAt: z.string().min(1),
    sceneContractVersion: z.literal(1),
    sceneRevisionHash: sha256SchemaV1,
    videoPath: z.string().min(1),
  })
  .strict();

export type ClientExportPublicationViewV1 = z.infer<typeof clientExportPublicationViewSchemaV1>;

export const clientExportFinalizeResponseSchemaV1 = clientExportPublicationViewSchemaV1
  .extend({ replayed: z.boolean() })
  .strict();

export type ClientExportFinalizeResponseV1 = z.infer<typeof clientExportFinalizeResponseSchemaV1>;

export function clientExportPublicationVideoPathV1(projectId: string, publicationId: string) {
  return `/api/projects/${projectId}/exports/${publicationId}/video`;
}

/** Builds the versioned finalize envelope: length-prefixed metadata JSON followed by the exact MP4 bytes. */
export function encodeClientExportFinalizeBodyV1(
  metadata: ClientExportFinalizeMetadataV1,
  video: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const parsed = clientExportFinalizeMetadataSchemaV1.parse(metadata);
  if (video.byteLength !== parsed.byteSize) {
    throw new TypeError("The client export finalize metadata byte size does not match the video bytes.");
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(parsed));
  if (metadataBytes.byteLength > MAX_CLIENT_EXPORT_FINALIZE_METADATA_BYTES_V1) {
    throw new RangeError("The client export finalize metadata exceeds the 64 KiB bound.");
  }
  const body = new Uint8Array(4 + metadataBytes.byteLength + video.byteLength);
  new DataView(body.buffer).setUint32(0, metadataBytes.byteLength, false);
  body.set(metadataBytes, 4);
  body.set(video, 4 + metadataBytes.byteLength);
  return body;
}

export type DecodedClientExportFinalizeBodyV1 = Readonly<{
  metadata: ClientExportFinalizeMetadataV1;
  video: Uint8Array;
}>;

/** Decodes and validates the finalize envelope; throws a TypeError sentence for any malformed framing. */
export function decodeClientExportFinalizeBodyV1(body: Uint8Array): DecodedClientExportFinalizeBodyV1 {
  if (!(body instanceof Uint8Array) || body.byteLength < 4) {
    throw new TypeError("The client export finalize envelope is truncated.");
  }
  const metadataLength = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, false);
  if (metadataLength < 2 || metadataLength > MAX_CLIENT_EXPORT_FINALIZE_METADATA_BYTES_V1) {
    throw new TypeError("The client export finalize metadata length is out of bounds.");
  }
  if (body.byteLength < 4 + metadataLength + 1) {
    throw new TypeError("The client export finalize envelope is truncated.");
  }
  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(4, 4 + metadataLength)));
  } catch {
    throw new TypeError("The client export finalize metadata is not valid JSON.");
  }
  const parsed = clientExportFinalizeMetadataSchemaV1.safeParse(metadataValue);
  if (!parsed.success) {
    throw new TypeError("The client export finalize metadata does not match the versioned contract.");
  }
  const video = body.subarray(4 + metadataLength);
  if (video.byteLength !== parsed.data.byteSize) {
    throw new TypeError("The client export finalize metadata byte size does not match the video bytes.");
  }
  return { metadata: parsed.data, video };
}
