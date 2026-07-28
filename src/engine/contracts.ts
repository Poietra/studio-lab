import { z } from "zod";

import {
  assetManifestV1Schema,
  type AssetManifestV1,
  EngineContractIntegrityError,
  hasValidAssetManifestDigestV1,
} from "./asset-manifest";
import { renderPacketV1Schema } from "./render-packet";
import { type SceneIrV1, sceneIrSourceRevisionHash, sceneIrV1Schema } from "./scene-ir";

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

const renderPacketBundleV1BaseSchema = z
  .object({
    assets: assetManifestV1Schema,
    packet: renderPacketV1Schema,
  })
  .strict();

export const renderPacketBundleV1Schema = renderPacketBundleV1BaseSchema.superRefine((bundle, context) => {
  validateManifestReference(bundle.packet.assetManifest, bundle.assets, context, ["packet", "assetManifest"]);
  const assets = assetIndex(bundle.assets);
  bundle.packet.draws.forEach((draw, index) => {
    if (draw.kind === "image") {
      validateAssetReference(draw.asset, assets, context, ["packet", "draws", index, "asset"]);
    }
  });
});

const engineFrameV1BaseSchema = z
  .object({
    assets: assetManifestV1Schema,
    packet: renderPacketV1Schema,
    scene: sceneIrV1Schema,
  })
  .strict();

export const engineFrameV1Schema = engineFrameV1BaseSchema.superRefine((frame, context) => {
  validateSceneAssets(frame.scene, frame.assets, context);
  validateManifestReference(frame.packet.assetManifest, frame.assets, context, ["packet", "assetManifest"]);

  if (frame.packet.sceneId !== frame.scene.sceneId) {
    context.addIssue({
      code: "custom",
      message: "Packet Scene ID does not match Scene IR.",
      path: ["packet", "sceneId"],
    });
  }
  if (frame.packet.sceneDuration !== frame.scene.duration) {
    context.addIssue({
      code: "custom",
      message: "Packet Scene duration does not match Scene IR.",
      path: ["packet", "sceneDuration"],
    });
  }
  if (frame.packet.sceneContractVersion !== frame.scene.version) {
    context.addIssue({
      code: "custom",
      message: "Packet Scene contract version does not match Scene IR.",
      path: ["packet", "sceneContractVersion"],
    });
  }
  if (frame.packet.sceneRevisionHash !== sceneIrSourceRevisionHash(frame.scene)) {
    context.addIssue({
      code: "custom",
      message: "Packet Scene revision does not match Scene IR source evidence.",
      path: ["packet", "sceneRevisionHash"],
    });
  }

  const entities = new Map(frame.scene.entities.map((entity) => [entity.id, entity]));
  const assets = assetIndex(frame.assets);
  const drawnEntityIds = new Set<string>();
  frame.packet.draws.forEach((draw, index) => {
    const entity = entities.get(draw.entityId);
    if (!entity) {
      context.addIssue({
        code: "custom",
        message: `Draw references unknown entity ${draw.entityId}.`,
        path: ["packet", "draws", index, "entityId"],
      });
      return;
    }
    if (drawnEntityIds.has(draw.entityId)) {
      context.addIssue({
        code: "custom",
        message: `Entity ${draw.entityId} has more than one draw.`,
        path: ["packet", "draws", index, "entityId"],
      });
    }
    if (
      !entity.lifetimes.some(
        (lifetime) => frame.packet.sampleTime >= lifetime.start && frame.packet.sampleTime < lifetime.end,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: `Draw entity ${draw.entityId} is outside its lifetime.`,
        path: ["packet", "draws", index, "entityId"],
      });
    }
    if (draw.sourceZIndex !== entity.sourceZIndex) {
      context.addIssue({
        code: "custom",
        message: `Draw entity ${draw.entityId} has stale source z-index evidence.`,
        path: ["packet", "draws", index, "sourceZIndex"],
      });
    }
    if ((draw.kind === "image") !== (entity.geometry.kind === "image")) {
      context.addIssue({
        code: "custom",
        message: `Draw kind does not match entity ${draw.entityId}.`,
        path: ["packet", "draws", index, "kind"],
      });
    }
    if (
      draw.kind === "empty" &&
      !frame.scene.animationChannels.some(
        (channel) => channel.kind === "path-trim" && channel.entityId === draw.entityId,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: `Empty draw entity ${draw.entityId} has no path-trim channel.`,
        path: ["packet", "draws", index, "reason"],
      });
    }
    if (
      draw.kind === "path" &&
      entity.appearance.kind === "vector" &&
      (JSON.stringify(draw.fill) !== JSON.stringify(entity.appearance.fill) ||
        JSON.stringify(draw.stroke) !== JSON.stringify(entity.appearance.stroke))
    ) {
      context.addIssue({
        code: "custom",
        message: `Path paint does not match entity ${draw.entityId}.`,
        path: ["packet", "draws", index],
      });
    }
    if (draw.kind === "image") {
      validateAssetReference(draw.asset, assets, context, ["packet", "draws", index, "asset"]);
      if (
        entity.geometry.kind === "image" &&
        (draw.asset.assetId !== entity.geometry.asset.assetId ||
          draw.asset.sha256 !== entity.geometry.asset.sha256 ||
          draw.sampler !== entity.geometry.sampler ||
          JSON.stringify(draw.localRect) !== JSON.stringify(entity.geometry.localRect))
      ) {
        context.addIssue({
          code: "custom",
          message: `Image draw does not match entity ${draw.entityId}.`,
          path: ["packet", "draws", index],
        });
      }
    }
    drawnEntityIds.add(draw.entityId);
  });

  for (const entity of frame.scene.entities) {
    const active = entity.lifetimes.some(
      (lifetime) => frame.packet.sampleTime >= lifetime.start && frame.packet.sampleTime < lifetime.end,
    );
    if (active && !drawnEntityIds.has(entity.id)) {
      context.addIssue({
        code: "custom",
        message: `Active entity ${entity.id} is missing from the packet.`,
        path: ["packet", "draws"],
      });
    }
  }

  for (let index = 1; index < frame.packet.draws.length; index += 1) {
    const previous = entities.get(frame.packet.draws[index - 1].entityId);
    const current = entities.get(frame.packet.draws[index].entityId);
    if (
      previous &&
      current &&
      (previous.sourceZIndex > current.sourceZIndex ||
        (previous.sourceZIndex === current.sourceZIndex && previous.sceneOrder > current.sceneOrder))
    ) {
      context.addIssue({
        code: "custom",
        message: "Packet draw order does not match Scene IR z-index and scene order.",
        path: ["packet", "draws", index, "paintOrder"],
      });
    }
  }
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

export async function parseVerifiedRenderPacketBundleV1(value: unknown) {
  const bundle = renderPacketBundleV1Schema.parse(value);
  await assertManifestDigest(bundle.assets);
  return bundle;
}

export async function parseVerifiedEngineFrameV1(value: unknown) {
  const frame = engineFrameV1Schema.parse(value);
  await assertManifestDigest(frame.assets);
  return frame;
}

export type EngineFrameV1 = z.infer<typeof engineFrameV1Schema>;
export type RenderPacketBundleV1 = z.infer<typeof renderPacketBundleV1Schema>;
export type SceneIrBundleV1 = z.infer<typeof sceneIrBundleV1Schema>;
