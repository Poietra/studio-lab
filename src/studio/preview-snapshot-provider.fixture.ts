import { z } from "zod";
import { createCanvasWorkerClientEvidenceAdapterV1 } from "../engine/canvas-worker-evidence";
import { parseVerifiedSceneIrBundleV1 } from "../engine/contracts";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../render-pipeline/manim-identity-contract";
import {
  type ImportedStudioPreviewSceneIdentityV1,
  isImportedStudioPreviewSceneIdentityV1,
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSnapshotProviderV1,
} from "./preview-snapshot-provider";

const fixtureSceneIdentitySchema = z
  .object({
    projectId: manimProjectIdSchema,
    sceneName: manimSceneNameSchema,
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourcePath: manimSourcePathSchema,
  })
  .strict();

const fixtureHarnessManifestSchema = z
  .object({
    expectedDuration: z.number().positive(),
    expectedIdentity: fixtureSceneIdentitySchema,
    fixtureId: z.literal("eng-v1-shared-circle-opacity"),
    runtimeConfigHash: z.string().regex(/^[0-9a-f]{64}$/),
    sceneId: z.literal("shared:circle-opacity"),
  })
  .strict();

const mathTexFixtureHarnessManifestSchema = z
  .object({
    expectedDuration: z.number().positive(),
    expectedIdentity: fixtureSceneIdentitySchema,
    fixtureId: z.literal("eng-v1-studio-mathtex-preview"),
    sceneId: z.literal("fixture:studio-mathtex-preview"),
  })
  .strict();

function sameSceneIdentity(left: ImportedStudioPreviewSceneIdentityV1, right: ImportedStudioPreviewSceneIdentityV1) {
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
      if (!isImportedStudioPreviewSceneIdentityV1(identity) || !sameSceneIdentity(identity, harness.expectedIdentity)) {
        throw new Error(
          `The fixture snapshot provider only serves its checked-in harness Scene ${harness.expectedIdentity.projectId}/${harness.expectedIdentity.sceneName}.`,
        );
      }
      const fixtureModule = await import("../../fixtures/engine-v1/shared-circle-opacity.json");
      signal?.throwIfAborted();
      const fixture = fixtureModule.default;
      const authoredFixture = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
      if (authoredFixture.scene.source.kind !== "studio-edit-program") {
        throw new Error("The shared renderer fixture does not carry its authored revision evidence.");
      }
      // The shared golden is authored as a Studio Edit Program so the
      // TypeScript contract boundary and canonical Rust evaluator consume the
      // same document. This provider wraps that revision in the imported
      // snapshot authority required by Studio's pristine correlation gate.
      const snapshot = await parseVerifiedSceneIrBundleV1({
        assets: authoredFixture.assets,
        scene: {
          ...authoredFixture.scene,
          source: {
            kind: "imported-manim-server-snapshot",
            runtimeConfigHash: harness.runtimeConfigHash,
            snapshotHash: authoredFixture.scene.source.revisionHash,
            snapshotVersion: 1,
            sourceHash: harness.expectedIdentity.sourceHash,
          },
        },
      });
      if (snapshot.scene.sceneId !== harness.sceneId || snapshot.scene.duration !== harness.expectedDuration) {
        throw new Error("The fixture Scene does not match its checked-in harness manifest.");
      }
      signal?.throwIfAborted();
      return {
        assetPayloads: [],
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

/** Six-frame variant used only by the browser MP4 E2E. */
export function createExportFixturePreviewSnapshotProviderV1(): StudioPreviewSnapshotProviderV1 {
  const base = createFixturePreviewSnapshotProviderV1();
  return {
    ...base,
    id: "checked-in-export-fixture",
    loadVerifiedSnapshot: async (input) => {
      const original = await base.loadVerifiedSnapshot(input);
      const scale = 0.1;
      const duration = original.snapshot.scene.duration * scale;
      const snapshot = await parseVerifiedSceneIrBundleV1({
        assets: original.snapshot.assets,
        scene: {
          ...original.snapshot.scene,
          animationChannels: original.snapshot.scene.animationChannels.map((channel) => ({
            ...channel,
            keyframes: channel.keyframes.map((keyframe) => ({ ...keyframe, at: keyframe.at * scale })),
          })),
          duration,
          entities: original.snapshot.scene.entities.map((entity) => ({
            ...entity,
            lifetimes: entity.lifetimes.map((lifetime) => ({
              end: lifetime.end * scale,
              start: lifetime.start * scale,
            })),
          })),
        },
      });
      return {
        ...original,
        correlation: {
          ...original.correlation,
          context: { ...original.correlation.context, sourceDuration: duration },
          sceneDuration: duration,
        },
        duration,
        snapshot,
        sourceLabel: "verified short export fixture",
      };
    },
  };
}

/**
 * Serves an empty, static imported Scene exclusively for the Studio-created
 * MathTex browser slice. Keeping it separate from the shared renderer fixture
 * avoids inheriting that Scene's imported entity and animation channel when
 * the Studio adapter recompiles an applied edit.
 */
export function createMathTexFixturePreviewSnapshotProviderV1(): StudioPreviewSnapshotProviderV1 {
  return {
    evidence: createCanvasWorkerClientEvidenceAdapterV1(),
    id: "checked-in-mathtex-fixture",
    loadVerifiedSnapshot: async ({ identity, signal }) => {
      signal?.throwIfAborted();
      const harnessModule = await import("../../fixtures/engine-v1/studio-mathtex-preview.harness.json");
      const harness = mathTexFixtureHarnessManifestSchema.parse(harnessModule.default);
      if (!isImportedStudioPreviewSceneIdentityV1(identity) || !sameSceneIdentity(identity, harness.expectedIdentity)) {
        throw new Error(
          `The MathTex fixture snapshot provider only serves its checked-in harness Scene ${harness.expectedIdentity.projectId}/${harness.expectedIdentity.sceneName}.`,
        );
      }
      const fixtureModule = await import("../../fixtures/engine-v1/studio-mathtex-preview.json");
      signal?.throwIfAborted();
      const fixture = fixtureModule.default;
      if (fixture.id !== harness.fixtureId) {
        throw new Error("The MathTex fixture document does not match its checked-in harness manifest.");
      }
      const snapshot = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
      if (
        snapshot.scene.sceneId !== harness.sceneId ||
        snapshot.scene.duration !== harness.expectedDuration ||
        snapshot.scene.entities.length !== 0 ||
        snapshot.scene.animationChannels.length !== 0 ||
        snapshot.scene.source.kind !== "imported-manim-server-snapshot" ||
        snapshot.scene.source.sourceHash !== harness.expectedIdentity.sourceHash
      ) {
        throw new Error("The MathTex fixture Scene does not match its checked-in harness manifest.");
      }
      signal?.throwIfAborted();
      return {
        assetPayloads: [],
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
        sourceLabel: "verified MathTex fixture",
        sourceRuntimeIdentity: new Map(),
      };
    },
  };
}
