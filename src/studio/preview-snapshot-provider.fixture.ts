import { z } from "zod";
import { createCanvasWorkerClientEvidenceAdapterV1 } from "../engine/canvas-worker-evidence";
import { parseVerifiedSceneIrBundleV1 } from "../engine/contracts";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSceneIdentityV1,
  type StudioPreviewSnapshotProviderV1,
} from "./preview-snapshot-provider";

const fixtureHarnessManifestSchema = z
  .object({
    expectedDuration: z.number().positive(),
    expectedIdentity: z
      .object({
        projectId: z.string().min(1),
        sceneName: z.string().min(1),
        sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
        sourcePath: z.string().min(1),
      })
      .strict(),
    fixtureId: z.literal("eng-v1-shared-circle-opacity"),
    sceneId: z.literal("shared:circle-opacity"),
  })
  .strict();

function sameSceneIdentity(left: StudioPreviewSceneIdentityV1, right: StudioPreviewSceneIdentityV1) {
  return (
    left.projectId === right.projectId &&
    left.sceneName === right.sceneName &&
    left.sourceHash === right.sourceHash &&
    left.sourcePath === right.sourcePath
  );
}

/**
 * The fixture provider serves exactly one harness Scene whose complete
 * identity — project, source path, source hash, and Scene name — is checked-in
 * evidence next to the fixture. A caller can never choose or spoof the
 * identity the fixture claims to correlate with: requests are compared against
 * the manifest and the correlation context is built from the manifest alone.
 * Its snapshot correlates only to the pristine working revision, so any
 * applied program, draft, or workspace switch forces whole-Scene fallback.
 */
export function createFixturePreviewSnapshotProviderV1(): StudioPreviewSnapshotProviderV1 {
  return {
    evidence: createCanvasWorkerClientEvidenceAdapterV1(),
    id: "checked-in-fixture",
    loadVerifiedSnapshot: async ({ identity, signal }) => {
      signal?.throwIfAborted();
      const harnessModule = await import("../../fixtures/engine-v1/shared-circle-opacity.harness.json");
      const harness = fixtureHarnessManifestSchema.parse(harnessModule.default);
      if (!sameSceneIdentity(identity, harness.expectedIdentity)) {
        throw new Error(
          `The fixture snapshot provider only serves its checked-in harness Scene ${harness.expectedIdentity.projectId}/${harness.expectedIdentity.sceneName}.`,
        );
      }
      const fixtureModule = await import("../../fixtures/engine-v1/shared-circle-opacity.json");
      signal?.throwIfAborted();
      const fixture = fixtureModule.default;
      const snapshot = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
      if (snapshot.scene.sceneId !== harness.sceneId || snapshot.scene.duration !== harness.expectedDuration) {
        throw new Error("The fixture Scene does not match its checked-in harness manifest.");
      }
      signal?.throwIfAborted();
      return {
        correlation: {
          assetsManifestDigest: snapshot.assets.manifestDigest,
          context: {
            ...harness.expectedIdentity,
            sourceDuration: harness.expectedDuration,
            workingRevision: PRISTINE_WORKING_REVISION,
          },
          engineRevisionHash: sceneIrSourceRevisionHash(snapshot.scene),
          sceneDuration: snapshot.scene.duration,
          sceneId: snapshot.scene.sceneId,
          serverPublicationRevision: null,
        },
        duration: snapshot.scene.duration,
        sceneId: snapshot.scene.sceneId,
        snapshot,
        sourceLabel: "verified fixture",
        sourceRuntimeIdentity: new Map([
          [
            "earlier",
            {
              bindingId: `source-binding:${"b".repeat(64)}`,
              entityId: "earlier",
              sourceName: "earlier",
            },
          ],
          [
            "later",
            {
              bindingId: `source-binding:${"c".repeat(64)}`,
              entityId: "later",
              sourceName: "later",
            },
          ],
          [
            "stroke",
            {
              bindingId: `source-binding:${"d".repeat(64)}`,
              entityId: "stroke",
              sourceName: "stroke",
            },
          ],
        ]),
      };
    },
  };
}
