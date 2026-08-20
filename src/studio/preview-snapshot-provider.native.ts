import { type CanvasPngAssetTransferV1, canvasPngAssetTransfersV1Schema } from "../engine/canvas-png-assets";
import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "../engine/contracts";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import {
  isStudioNativePreviewSceneIdentityV1,
  PRISTINE_WORKING_REVISION,
  type StudioNativePreviewSceneIdentityV1,
  type StudioPreviewSnapshotProviderV1,
} from "./preview-snapshot-provider";

const NATIVE_SCENE_PREFIX = "native:";

function payloadsMatchManifest(
  bundle: Awaited<ReturnType<typeof parseVerifiedSceneIrBundleV1>>,
  payloads: ReturnType<typeof canvasPngAssetTransfersV1Schema.parse>,
) {
  if (bundle.assets.assets.length !== payloads.length) return false;
  const payloadById = new Map(payloads.map((payload) => [payload.assetId, payload]));
  return bundle.assets.assets.every((asset) => {
    const payload = payloadById.get(asset.id);
    return (
      payload !== undefined &&
      payload.byteLength === asset.byteLength &&
      payload.mediaType === asset.mediaType &&
      payload.pixelHeight === asset.pixelHeight &&
      payload.pixelWidth === asset.pixelWidth &&
      payload.sha256 === asset.sha256
    );
  });
}

/**
 * Adapts the canonical browser-local native document pair to the retained
 * preview contract. It stores no asset registry and never consults Python or
 * the server: each load re-correlates the exact request with the Scene bundle.
 */
export function createStudioNativePreviewSnapshotProviderV1(
  input: Readonly<{
    assetPayloads: readonly CanvasPngAssetTransferV1[];
    bundle: SceneIrBundleV1;
    identity: StudioNativePreviewSceneIdentityV1;
  }>,
): StudioPreviewSnapshotProviderV1 {
  return {
    id: "studio-native-scene",
    loadVerifiedSnapshot: async ({ identity, signal }) => {
      signal?.throwIfAborted();
      if (!isStudioNativePreviewSceneIdentityV1(identity)) {
        throw new Error("The Studio-native preview provider requires a native document identity.");
      }
      if (
        identity.origin !== input.identity.origin ||
        identity.projectId !== input.identity.projectId ||
        identity.documentKey !== input.identity.documentKey ||
        identity.sceneId !== input.identity.sceneId
      ) {
        throw new Error("The Studio-native preview request does not match this provider's document owner.");
      }
      const [bundle, assetPayloads] = await Promise.all([
        parseVerifiedSceneIrBundleV1(input.bundle),
        Promise.resolve(canvasPngAssetTransfersV1Schema.parse(input.assetPayloads)),
      ]);
      signal?.throwIfAborted();
      if (bundle.scene.source.kind !== "studio-edit-program") {
        throw new Error("A Studio-native preview must use the canonical Studio Edit Program source.");
      }
      const expectedSceneId = `${NATIVE_SCENE_PREFIX}${identity.documentKey}`;
      if (identity.sceneId !== expectedSceneId || bundle.scene.sceneId !== expectedSceneId) {
        throw new Error("The Studio-native preview has stale Editor Document correlation.");
      }
      if (!payloadsMatchManifest(bundle, assetPayloads)) {
        throw new Error("The Studio-native preview asset payloads do not match its canonical manifest.");
      }
      const engineRevisionHash = sceneIrSourceRevisionHash(bundle.scene);
      return {
        assetPayloads,
        correlation: {
          assetsManifestDigest: bundle.assets.manifestDigest,
          context: {
            ...identity,
            sourceDuration: bundle.scene.duration,
            workingRevision: PRISTINE_WORKING_REVISION,
          },
          engineRevisionHash,
          sceneDuration: bundle.scene.duration,
          sceneId: bundle.scene.sceneId,
          serverPublicationRevision: null,
        },
        duration: bundle.scene.duration,
        sceneId: bundle.scene.sceneId,
        snapshot: bundle,
        sourceLabel: "Studio-native Scene",
        sourceRuntimeIdentity: null,
      };
    },
  };
}
