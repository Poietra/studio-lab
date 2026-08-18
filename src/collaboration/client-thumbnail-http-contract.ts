import { z } from "zod";

import { manimProjectIdSchema } from "../render-pipeline/contracts";

export const CLIENT_THUMBNAIL_FINALIZE_MEDIA_TYPE_V1 = "application/vnd.poietra.client-thumbnail-finalize-v1";
export const MAX_CLIENT_THUMBNAIL_METADATA_BYTES_V1 = 16 * 1024;
export const MAX_CLIENT_THUMBNAIL_PNG_BYTES_V1 = 4 * 1024 * 1024;
export const MAX_CLIENT_THUMBNAIL_FINALIZE_BODY_BYTES_V1 =
  4 + MAX_CLIENT_THUMBNAIL_METADATA_BYTES_V1 + MAX_CLIENT_THUMBNAIL_PNG_BYTES_V1;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^(0|[1-9][0-9]{0,15})$/u);

export const clientThumbnailFinalizeMetadataSchemaV1 = z
  .object({
    byteSize: z.number().int().min(1).max(MAX_CLIENT_THUMBNAIL_PNG_BYTES_V1),
    contentDigest: sha256Schema,
    documentEpoch: z.uuid(),
    documentKey: sha256Schema,
    documentRevision: revisionSchema,
    producerKind: z.literal("browser-wasm-wgpu"),
    projectId: manimProjectIdSchema,
    publicationId: z.uuid(),
    representativeFrameRule: z.literal("last-representable-in-duration"),
    sceneContractVersion: z.literal(1),
    sceneRevisionHash: sha256Schema,
    schema: z.literal("poietra.client-thumbnail-finalize"),
    version: z.literal(1),
  })
  .strict();

export type ClientThumbnailFinalizeMetadataV1 = z.infer<typeof clientThumbnailFinalizeMetadataSchemaV1>;

export const clientThumbnailPublicationViewSchemaV1 = clientThumbnailFinalizeMetadataSchemaV1
  .omit({ schema: true, version: true })
  .extend({
    createdBySubjectId: z.uuid(),
    imagePath: z.string().min(1),
    publishedAt: z.string().min(1),
    replayed: z.boolean(),
  })
  .strict();

export type ClientThumbnailPublicationViewV1 = z.infer<typeof clientThumbnailPublicationViewSchemaV1>;

export function clientThumbnailImagePathV1(projectId: string) {
  return `/api/projects/${projectId}/thumbnail`;
}

export function encodeClientThumbnailFinalizeBodyV1(
  metadataValue: ClientThumbnailFinalizeMetadataV1,
  png: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const metadata = clientThumbnailFinalizeMetadataSchemaV1.parse(metadataValue);
  if (png.byteLength !== metadata.byteSize) {
    throw new TypeError("The thumbnail metadata byte size does not match the PNG bytes.");
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > MAX_CLIENT_THUMBNAIL_METADATA_BYTES_V1) {
    throw new RangeError("The thumbnail metadata exceeds the 16 KiB bound.");
  }
  const body = new Uint8Array(4 + metadataBytes.byteLength + png.byteLength);
  new DataView(body.buffer).setUint32(0, metadataBytes.byteLength, false);
  body.set(metadataBytes, 4);
  body.set(png, 4 + metadataBytes.byteLength);
  return body;
}

export function decodeClientThumbnailFinalizeBodyV1(body: Uint8Array) {
  if (!(body instanceof Uint8Array) || body.byteLength < 5) {
    throw new TypeError("The thumbnail finalize envelope is truncated.");
  }
  const metadataLength = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, false);
  if (metadataLength < 2 || metadataLength > MAX_CLIENT_THUMBNAIL_METADATA_BYTES_V1) {
    throw new TypeError("The thumbnail metadata length is out of bounds.");
  }
  if (body.byteLength <= 4 + metadataLength) throw new TypeError("The thumbnail finalize envelope is truncated.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(4, 4 + metadataLength)));
  } catch {
    throw new TypeError("The thumbnail metadata is not valid JSON.");
  }
  const parsed = clientThumbnailFinalizeMetadataSchemaV1.safeParse(value);
  if (!parsed.success) throw new TypeError("The thumbnail metadata does not match the versioned contract.");
  const png = body.subarray(4 + metadataLength);
  if (png.byteLength !== parsed.data.byteSize) {
    throw new TypeError("The thumbnail metadata byte size does not match the PNG bytes.");
  }
  return { metadata: parsed.data, png } as const;
}
