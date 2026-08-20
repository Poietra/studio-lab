import { describe, expect, it } from "vitest";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import { createStudioNativePreviewSnapshotProviderV1 } from "./preview-snapshot-provider.native";
import { createStudioNativeBlankScene, createStudioNativeBlankSceneIrBundle } from "./studio-native-workspace";

const DOCUMENT_KEY = "d".repeat(64);
const PROJECT_ID = "native-project";

async function fixture() {
  const scene = createStudioNativeBlankScene(DOCUMENT_KEY);
  const bundle = await createStudioNativeBlankSceneIrBundle(scene, { height: 9, width: 16 });
  const identity = {
    documentKey: DOCUMENT_KEY,
    origin: "studio-native" as const,
    projectId: PROJECT_ID,
    sceneId: scene.sceneId,
  };
  return {
    bundle,
    identity,
    provider: createStudioNativePreviewSnapshotProviderV1({ assetPayloads: [], bundle, identity }),
  };
}

describe("createStudioNativePreviewSnapshotProviderV1", () => {
  it("serves the canonical local bundle with document and engine revisions kept distinct", async () => {
    const { bundle, identity, provider } = await fixture();
    const loaded = await provider.loadVerifiedSnapshot({ identity });

    expect(loaded.snapshot).toEqual(bundle);
    expect(loaded.correlation.context).toEqual({
      ...identity,
      sourceDuration: bundle.scene.duration,
      workingRevision: "pristine",
    });
    expect(loaded.correlation.engineRevisionHash).toBe(sceneIrSourceRevisionHash(bundle.scene));
    expect(loaded.correlation.engineRevisionHash).not.toBe(identity.documentKey);
    expect(loaded.sourceRuntimeIdentity).toBeNull();
  });

  it("rejects a request from any other owner lane", async () => {
    const { identity, provider } = await fixture();

    await expect(
      provider.loadVerifiedSnapshot({ identity: { ...identity, projectId: "other-project" } }),
    ).rejects.toThrow("document owner");
    await expect(
      provider.loadVerifiedSnapshot({
        identity: {
          projectId: identity.projectId,
          sceneName: "Scene",
          sourceHash: "a".repeat(64),
          sourcePath: "scene.py",
        },
      }),
    ).rejects.toThrow("requires a native document identity");
  });
});
