import { z } from "zod";

import {
  assetIdV1Schema,
  opaqueIdV1Schema,
  POIETRA_ENGINE_CONTRACT_VERSION,
  reportDuplicateIds,
  sha256V1Schema,
} from "./primitives";

export const MAX_ASSETS = 4_096;
export const MAX_ENCODED_ASSET_BYTES = 268_435_456;
export const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_TOTAL_IMAGE_PIXELS = 33_554_432;

export const pngAssetV1Schema = z
  .object({
    alphaMode: z.literal("straight"),
    byteLength: z.number().int().positive().max(134_217_728),
    colorSpace: z.literal("srgb"),
    id: assetIdV1Schema,
    kind: z.literal("png-image"),
    mediaType: z.literal("image/png"),
    pixelHeight: z.number().int().positive().max(16_384),
    pixelWidth: z.number().int().positive().max(16_384),
    sha256: sha256V1Schema,
  })
  .strict()
  .refine((asset) => asset.pixelWidth * asset.pixelHeight <= MAX_IMAGE_PIXELS, {
    message: `A decoded image may contain at most ${MAX_IMAGE_PIXELS} pixels.`,
  });

const assetManifestV1BaseSchema = z
  .object({
    assets: z.array(pngAssetV1Schema).max(MAX_ASSETS),
    manifestDigest: sha256V1Schema,
    manifestId: opaqueIdV1Schema,
    schema: z.literal("poietra.asset-manifest"),
    version: z.literal(POIETRA_ENGINE_CONTRACT_VERSION),
  })
  .strict();

export const assetManifestV1Schema = assetManifestV1BaseSchema.superRefine((manifest, context) => {
  reportDuplicateIds(manifest.assets, "assets", context);
  let encodedBytes = 0;
  let decodedPixels = 0;
  manifest.assets.forEach((asset, index) => {
    const previous = manifest.assets[index - 1];
    if (previous && previous.id >= asset.id) {
      context.addIssue({
        code: "custom",
        message: "Assets must be sorted by portable ASCII ID.",
        path: ["assets", index, "id"],
      });
    }
    encodedBytes += asset.byteLength;
    decodedPixels += asset.pixelWidth * asset.pixelHeight;
  });
  if (encodedBytes > MAX_ENCODED_ASSET_BYTES) {
    context.addIssue({ code: "custom", message: "Asset manifest exceeds the total encoded-byte limit." });
  }
  if (decodedPixels > MAX_TOTAL_IMAGE_PIXELS) {
    context.addIssue({ code: "custom", message: "Asset manifest exceeds the total decoded-pixel limit." });
  }
});

export type AssetManifestV1 = z.infer<typeof assetManifestV1Schema>;
export type PngAssetV1 = z.infer<typeof pngAssetV1Schema>;

function canonicalManifestMetadata(manifest: AssetManifestV1) {
  return {
    assets: manifest.assets.map((asset) => ({
      alphaMode: asset.alphaMode,
      byteLength: asset.byteLength,
      colorSpace: asset.colorSpace,
      id: asset.id,
      kind: asset.kind,
      mediaType: asset.mediaType,
      pixelHeight: asset.pixelHeight,
      pixelWidth: asset.pixelWidth,
      sha256: asset.sha256,
    })),
    manifestId: manifest.manifestId,
    schema: manifest.schema,
    version: manifest.version,
  };
}

export function canonicalAssetManifestV1(manifest: AssetManifestV1) {
  return JSON.stringify(canonicalManifestMetadata(manifest));
}

export async function digestAssetManifestV1(manifest: AssetManifestV1) {
  const bytes = new TextEncoder().encode(canonicalAssetManifestV1(manifest));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hasValidAssetManifestDigestV1(manifest: AssetManifestV1) {
  return (await digestAssetManifestV1(manifest)) === manifest.manifestDigest;
}

export class EngineContractIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineContractIntegrityError";
  }
}

export async function parseVerifiedAssetManifestV1(value: unknown) {
  const manifest = assetManifestV1Schema.parse(value);
  if (!(await hasValidAssetManifestDigestV1(manifest))) {
    throw new EngineContractIntegrityError("Asset manifest digest does not match its canonical metadata.");
  }
  return manifest;
}
