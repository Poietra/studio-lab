import type { CanvasPngAssetTransferV1 } from "../engine/canvas-png-assets";
import type { SceneIrBundleV1 } from "../engine/contracts";

export type StudioNativeImageAssetV1 = Readonly<{
  byteLength: number;
  bytes: ArrayBuffer;
  image: Readonly<{
    asset: Readonly<{ assetId: string; sha256: string }>;
    localRect: Readonly<{ bottom: number; left: number; right: number; top: number }>;
    sampler: "linear" | "nearest";
  }>;
  label: string;
  pixelHeight: number;
  pixelWidth: number;
}>;

export const STUDIO_IMAGE_ASSET_DRAG_TYPE = "application/x-poietra-image-asset";

type CanonicalImageSourceV1 = Readonly<{
  assetPayloads: readonly CanvasPngAssetTransferV1[];
  bundle: SceneIrBundleV1;
}>;

function defaultLocalRect(pixelWidth: number, pixelHeight: number) {
  const width = pixelWidth >= pixelHeight ? 3 : (3 * pixelWidth) / pixelHeight;
  const height = pixelHeight >= pixelWidth ? 3 : (3 * pixelHeight) / pixelWidth;
  return { bottom: -height / 2, left: -width / 2, right: width / 2, top: height / 2 };
}

/** Selects verified project images already installed in the canonical Scene.
 * It neither reads a URL nor invents a second asset registry. */
export function studioNativeImageAssetsV1(source: CanonicalImageSourceV1 | null): readonly StudioNativeImageAssetV1[] {
  if (!source) return [];
  const payloads = new Map(source.assetPayloads.map((payload) => [payload.assetId, payload]));
  return source.bundle.assets.assets.flatMap((asset) => {
    const payload = payloads.get(asset.id);
    if (
      !payload ||
      payload.sha256 !== asset.sha256 ||
      payload.byteLength !== asset.byteLength ||
      payload.pixelWidth !== asset.pixelWidth ||
      payload.pixelHeight !== asset.pixelHeight
    ) {
      return [];
    }
    const retainedPlacement = source.bundle.scene.entities.find(
      (entity) =>
        entity.geometry.kind === "image" &&
        entity.geometry.asset.assetId === asset.id &&
        entity.geometry.asset.sha256 === asset.sha256,
    )?.geometry;
    return [
      {
        byteLength: asset.byteLength,
        bytes: payload.bytes,
        image: {
          asset: { assetId: asset.id, sha256: asset.sha256 },
          localRect:
            retainedPlacement?.kind === "image"
              ? retainedPlacement.localRect
              : defaultLocalRect(asset.pixelWidth, asset.pixelHeight),
          sampler: retainedPlacement?.kind === "image" ? retainedPlacement.sampler : "linear",
        },
        label: `image-${asset.sha256.slice(0, 8)}.png`,
        pixelHeight: asset.pixelHeight,
        pixelWidth: asset.pixelWidth,
      },
    ];
  });
}

export function studioImageAssetDragPayload(asset: StudioNativeImageAssetV1): string {
  return JSON.stringify(asset.image.asset);
}

export function resolveStudioImageAssetDrag(
  assets: readonly StudioNativeImageAssetV1[],
  payload: string,
): StudioNativeImageAssetV1 | null {
  if (payload.length === 0 || payload.length > 4096) return null;
  try {
    const reference: unknown = JSON.parse(payload);
    if (
      typeof reference !== "object" ||
      reference === null ||
      !("assetId" in reference) ||
      !("sha256" in reference) ||
      typeof reference.assetId !== "string" ||
      typeof reference.sha256 !== "string"
    ) {
      return null;
    }
    return (
      assets.find(
        ({ image }) => image.asset.assetId === reference.assetId && image.asset.sha256 === reference.sha256,
      ) ?? null
    );
  } catch {
    return null;
  }
}
