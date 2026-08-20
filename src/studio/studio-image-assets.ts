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
  label: "image.png";
  pixelHeight: number;
  pixelWidth: number;
}>;

type CanonicalImageSourceV1 = Readonly<{
  assetPayloads: readonly CanvasPngAssetTransferV1[];
  bundle: SceneIrBundleV1;
}>;

function defaultLocalRect(pixelWidth: number, pixelHeight: number) {
  const width = pixelWidth >= pixelHeight ? 3 : (3 * pixelWidth) / pixelHeight;
  const height = pixelHeight >= pixelWidth ? 3 : (3 * pixelHeight) / pixelWidth;
  return { bottom: -height / 2, left: -width / 2, right: width / 2, top: height / 2 };
}

/** Selects the one verified project image already installed in the canonical
 * Scene. It neither reads a URL nor invents a second asset registry. */
export function studioNativeImageAssetsV1(source: CanonicalImageSourceV1 | null): readonly StudioNativeImageAssetV1[] {
  if (!source) return [];
  const payloads = new Map(source.assetPayloads.map((payload) => [payload.assetId, payload]));
  return source.bundle.assets.assets.slice(0, 1).flatMap((asset) => {
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
        label: "image.png",
        pixelHeight: asset.pixelHeight,
        pixelWidth: asset.pixelWidth,
      },
    ];
  });
}
