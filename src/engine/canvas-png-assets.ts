import { z } from "zod";

import {
  type AssetManifestV1,
  MAX_ASSETS,
  MAX_ENCODED_ASSET_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_TOTAL_IMAGE_PIXELS,
  type PngAssetV1,
  parseVerifiedAssetManifestV1,
} from "./asset-manifest";
import { assetIdV1Schema, sha256V1Schema } from "./primitives";

export const canvasPngAssetTransferV1Schema = z
  .object({
    assetId: assetIdV1Schema,
    byteLength: z.number().int().positive().max(134_217_728),
    bytes: z.instanceof(ArrayBuffer),
    mediaType: z.literal("image/png"),
    pixelHeight: z.number().int().positive().max(16_384),
    pixelWidth: z.number().int().positive().max(16_384),
    sha256: sha256V1Schema,
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.bytes.byteLength !== asset.byteLength) {
      context.addIssue({
        code: "custom",
        message: "Transferred PNG byteLength does not match its ArrayBuffer.",
        path: ["bytes"],
      });
    }
    if ((asset.bytes as ArrayBuffer & Readonly<{ resizable?: boolean }>).resizable === true) {
      context.addIssue({
        code: "custom",
        message: "Transferred PNG bytes must use a fixed-length ArrayBuffer.",
        path: ["bytes"],
      });
    }
    if (asset.pixelWidth * asset.pixelHeight > MAX_IMAGE_PIXELS) {
      context.addIssue({
        code: "custom",
        message: `A decoded image may contain at most ${MAX_IMAGE_PIXELS} pixels.`,
        path: ["pixelWidth"],
      });
    }
  });

export const canvasPngAssetTransfersV1Schema = z
  .array(canvasPngAssetTransferV1Schema)
  .max(MAX_ASSETS)
  .superRefine((assets, context) => {
    let totalBytes = 0;
    const digests = new Set<string>();
    assets.forEach((asset, index) => {
      totalBytes += asset.byteLength;
      if (digests.has(asset.sha256)) {
        context.addIssue({
          code: "custom",
          message: `PNG digest ${asset.sha256} may be transferred only once per request.`,
          path: [index, "sha256"],
        });
      }
      digests.add(asset.sha256);
    });
    if (totalBytes > MAX_ENCODED_ASSET_BYTES) {
      context.addIssue({ code: "custom", message: "Transferred PNG assets exceed the encoded-byte limit." });
    }
  });

export type CanvasPngAssetTransferV1 = z.infer<typeof canvasPngAssetTransferV1Schema>;

export type CanvasPngDimensionDecoderV1 = (
  bytes: Uint8Array<ArrayBuffer>,
) => Promise<Readonly<{ pixelHeight: number; pixelWidth: number }>>;

export type CanvasPngAssetRegistrySnapshotV1 = Readonly<{
  byDigest: ReadonlyMap<string, Readonly<Pick<PngAssetV1, "byteLength" | "pixelHeight" | "pixelWidth">>>;
}>;

export type PreparedCanvasPngAssetTransferV1 = Readonly<{
  nextRegistry: CanvasPngAssetRegistrySnapshotV1;
  transfers: readonly CanvasPngAssetTransferV1[];
}>;

/** Encodes already-verified transfer metadata for the Rust PNG registry. */
export function encodeCanvasPngAssetTransfersForWasmV1(assets: readonly CanvasPngAssetTransferV1[]) {
  return {
    bytes: assets.map((asset) => new Uint8Array(asset.bytes)),
    metadataJson: new TextEncoder().encode(
      JSON.stringify(
        assets.map(({ assetId, bytes: _bytes, ...metadata }) => ({
          alphaMode: "straight",
          colorSpace: "srgb",
          id: assetId,
          kind: "png-image",
          ...metadata,
        })),
      ),
    ),
  };
}

export class CanvasPngAssetValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CanvasPngAssetValidationError";
  }
}

const EMPTY_REGISTRY: CanvasPngAssetRegistrySnapshotV1 = {
  byDigest: new Map(),
};

function metadataForDigest(asset: PngAssetV1) {
  return {
    byteLength: asset.byteLength,
    pixelHeight: asset.pixelHeight,
    pixelWidth: asset.pixelWidth,
  } as const;
}

function metadataMatches(
  left: Readonly<Pick<PngAssetV1, "byteLength" | "pixelHeight" | "pixelWidth">>,
  right: Readonly<Pick<PngAssetV1, "byteLength" | "pixelHeight" | "pixelWidth">>,
) {
  return (
    left.byteLength === right.byteLength &&
    left.pixelHeight === right.pixelHeight &&
    left.pixelWidth === right.pixelWidth
  );
}

function transferMatchesManifest(transfer: CanvasPngAssetTransferV1, asset: PngAssetV1) {
  return (
    transfer.assetId === asset.id &&
    transfer.sha256 === asset.sha256 &&
    transfer.byteLength === asset.byteLength &&
    transfer.mediaType === asset.mediaType &&
    transfer.pixelHeight === asset.pixelHeight &&
    transfer.pixelWidth === asset.pixelWidth
  );
}

async function sha256(bytes: ArrayBuffer) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const decodeCanvasPngDimensionsV1: CanvasPngDimensionDecoderV1 = async (bytes) => {
  if (typeof globalThis.createImageBitmap !== "function") {
    throw new CanvasPngAssetValidationError("This browser cannot decode PNG assets before Worker transfer.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await globalThis.createImageBitmap(new Blob([bytes], { type: "image/png" }));
  } catch (cause) {
    throw new CanvasPngAssetValidationError("The transferred PNG bytes could not be decoded.", { cause });
  }
  try {
    return { pixelHeight: bitmap.height, pixelWidth: bitmap.width };
  } finally {
    bitmap.close();
  }
};

/**
 * Verifies every newly needed PNG before ownership of its ArrayBuffer crosses
 * the page/Worker boundary. The returned registry is only committed after the
 * Worker acknowledges the matching Scene transaction.
 */
export async function prepareCanvasPngAssetTransfersV1(
  input: Readonly<{
    decodeDimensions?: CanvasPngDimensionDecoderV1;
    manifest: AssetManifestV1;
    payloads?: readonly CanvasPngAssetTransferV1[];
    registry?: CanvasPngAssetRegistrySnapshotV1;
  }>,
): Promise<PreparedCanvasPngAssetTransferV1> {
  let manifest: AssetManifestV1;
  let payloads: readonly CanvasPngAssetTransferV1[];
  try {
    manifest = await parseVerifiedAssetManifestV1(input.manifest);
    payloads = canvasPngAssetTransfersV1Schema.parse(input.payloads ?? []);
  } catch (cause) {
    throw new CanvasPngAssetValidationError("PNG asset metadata does not match the bounded transfer contract.", {
      cause,
    });
  }

  const registry = input.registry ?? EMPTY_REGISTRY;
  const nextByDigest = new Map(registry.byDigest);
  const manifestById = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const manifestDigests = new Set(manifest.assets.map((asset) => asset.sha256));
  const payloadByDigest = new Map(payloads.map((payload) => [payload.sha256, payload]));

  for (const digest of nextByDigest.keys()) {
    if (!manifestDigests.has(digest)) nextByDigest.delete(digest);
  }

  for (const payload of payloads) {
    const asset = manifestById.get(payload.assetId);
    if (!asset || !manifestDigests.has(payload.sha256) || !transferMatchesManifest(payload, asset)) {
      throw new CanvasPngAssetValidationError(
        `Transferred PNG ${payload.assetId} is stale or absent from the manifest.`,
      );
    }
  }

  const transfers: CanvasPngAssetTransferV1[] = [];
  const decodeDimensions = input.decodeDimensions ?? decodeCanvasPngDimensionsV1;
  for (const asset of manifest.assets) {
    const existingMetadata = nextByDigest.get(asset.sha256);
    if (existingMetadata !== undefined) {
      if (!metadataMatches(existingMetadata, asset)) {
        throw new CanvasPngAssetValidationError(`PNG digest ${asset.sha256} has conflicting immutable metadata.`);
      }
      continue;
    }

    const payload = payloadByDigest.get(asset.sha256);
    if (!payload) {
      throw new CanvasPngAssetValidationError(`PNG bytes for ${asset.id} are missing.`);
    }
    let ownedBytes: ArrayBuffer;
    try {
      ownedBytes = payload.bytes.slice(0);
    } catch (cause) {
      throw new CanvasPngAssetValidationError(`PNG bytes for ${asset.id} are detached or not copyable.`, { cause });
    }
    let actualDigest: string;
    let dimensions: Awaited<ReturnType<CanvasPngDimensionDecoderV1>>;
    try {
      [actualDigest, dimensions] = await Promise.all([
        sha256(ownedBytes),
        decodeDimensions(new Uint8Array(ownedBytes)),
      ]);
    } catch (cause) {
      if (cause instanceof CanvasPngAssetValidationError) throw cause;
      throw new CanvasPngAssetValidationError(`PNG bytes for ${asset.id} could not be verified.`, { cause });
    }
    if (actualDigest !== asset.sha256) {
      throw new CanvasPngAssetValidationError(`PNG bytes for ${asset.id} do not match their SHA-256 digest.`);
    }
    if (dimensions.pixelWidth !== asset.pixelWidth || dimensions.pixelHeight !== asset.pixelHeight) {
      throw new CanvasPngAssetValidationError(`PNG bytes for ${asset.id} do not match their decoded dimensions.`);
    }
    nextByDigest.set(asset.sha256, metadataForDigest(asset));
    transfers.push({ ...payload, bytes: ownedBytes });
  }

  const retainedBytes = [...nextByDigest.values()].reduce((total, asset) => total + asset.byteLength, 0);
  const retainedPixels = [...nextByDigest.values()].reduce(
    (total, asset) => total + asset.pixelWidth * asset.pixelHeight,
    0,
  );
  if (
    nextByDigest.size > MAX_ASSETS ||
    retainedBytes > MAX_ENCODED_ASSET_BYTES ||
    retainedPixels > MAX_TOTAL_IMAGE_PIXELS
  ) {
    throw new CanvasPngAssetValidationError("The immutable PNG registry would exceed its retained resource limits.");
  }
  return { nextRegistry: { byDigest: nextByDigest }, transfers };
}
