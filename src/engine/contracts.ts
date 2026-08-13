import { z } from "zod";

import {
  type AssetManifestV1,
  assetManifestV1Schema,
  EngineContractIntegrityError,
  hasValidAssetManifestDigestV1,
} from "./asset-manifest";
import { type SceneIrV1, sceneIrV1Schema } from "./scene-ir";

export * from "./asset-manifest";
export * from "./primitives";
export * from "./render-packet";
export * from "./scene-ir";

function assetIndex(manifest: AssetManifestV1) {
  return new Map(manifest.assets.map((asset) => [asset.id, asset]));
}

function validateManifestReference(
  reference: Readonly<{ manifestDigest: string; manifestId: string }>,
  manifest: AssetManifestV1,
  context: z.RefinementCtx,
  path: (string | number)[],
) {
  if (reference.manifestId !== manifest.manifestId || reference.manifestDigest !== manifest.manifestDigest) {
    context.addIssue({ code: "custom", message: "Asset manifest reference is stale.", path });
  }
}

function validateAssetReference(
  reference: Readonly<{ assetId: string; sha256: string }>,
  assets: ReturnType<typeof assetIndex>,
  context: z.RefinementCtx,
  path: (string | number)[],
) {
  const asset = assets.get(reference.assetId);
  if (!asset) {
    context.addIssue({ code: "custom", message: `Missing asset ${reference.assetId}.`, path });
  } else if (asset.sha256 !== reference.sha256) {
    context.addIssue({ code: "custom", message: `Stale asset reference ${reference.assetId}.`, path });
  }
}

function validateSceneAssets(scene: SceneIrV1, manifest: AssetManifestV1, context: z.RefinementCtx) {
  validateManifestReference(scene.assetManifest, manifest, context, ["scene", "assetManifest"]);
  const assets = assetIndex(manifest);
  scene.entities.forEach((entity, index) => {
    if (entity.geometry.kind === "image") {
      validateAssetReference(entity.geometry.asset, assets, context, ["scene", "entities", index, "geometry", "asset"]);
    }
  });
}

const sceneIrBundleV1BaseSchema = z
  .object({
    assets: assetManifestV1Schema,
    scene: sceneIrV1Schema,
  })
  .strict();

export const sceneIrBundleV1Schema = sceneIrBundleV1BaseSchema.superRefine((bundle, context) => {
  validateSceneAssets(bundle.scene, bundle.assets, context);
});

async function assertManifestDigest(manifest: AssetManifestV1) {
  if (!(await hasValidAssetManifestDigestV1(manifest))) {
    throw new EngineContractIntegrityError("Asset manifest digest does not match its canonical metadata.");
  }
}

export async function parseVerifiedSceneIrBundleV1(value: unknown) {
  const bundle = sceneIrBundleV1Schema.parse(value);
  await assertManifestDigest(bundle.assets);
  return bundle;
}

export type SceneIrBundleV1 = z.infer<typeof sceneIrBundleV1Schema>;
