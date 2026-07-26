import { describe, expect, it } from "vitest";
import harnessManifest from "../../fixtures/engine-v1/shared-circle-opacity.harness.json";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import {
  PRISTINE_WORKING_REVISION,
  resolveStudioPreviewSnapshotProviderV1,
  type StudioPreviewSceneIdentityV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";
import { createFixturePreviewSnapshotProviderV1 } from "./preview-snapshot-provider.fixture";

const HARNESS_IDENTITY: StudioPreviewSceneIdentityV1 = harnessManifest.expectedIdentity;

describe("resolveStudioPreviewSnapshotProviderV1", () => {
  it("keeps the existing semantic preview as the default", async () => {
    await expect(resolveStudioPreviewSnapshotProviderV1("")).resolves.toBeNull();
    await expect(resolveStudioPreviewSnapshotProviderV1("?other=1")).resolves.toBeNull();
  });

  it("resolves the production server provider only on explicit opt-in", async () => {
    const provider = await resolveStudioPreviewSnapshotProviderV1("?previewRenderer=server");
    expect(provider?.id).toBe("server-scene-snapshot");
    expect(provider?.evidence).toBeUndefined();
  });

  it("resolves the fixture provider only on explicit opt-in in a dev/test build", async () => {
    expect(import.meta.env.DEV).toBe(true);
    const provider = await resolveStudioPreviewSnapshotProviderV1("?previewRenderer=fixture");
    expect(provider?.id).toBe("checked-in-fixture");
    // The dev evidence client extension is wired explicitly by the harness
    // provider, never implicitly by being a snapshot provider.
    expect(provider?.evidence).toBeDefined();
    expect(typeof provider?.evidence?.capture).toBe("function");
  });
});

describe("studioPreviewWorkspaceKeyV1", () => {
  it("separates projects even when source hash and Scene name are identical", () => {
    const context = { ...HARNESS_IDENTITY, sourceDuration: 2, workingRevision: PRISTINE_WORKING_REVISION };
    const key = studioPreviewWorkspaceKeyV1(context);
    // A cross-project switch onto a Scene with the same source hash and name
    // must tear the old worker down instead of keeping it installed.
    expect(studioPreviewWorkspaceKeyV1({ ...context, projectId: "another-project" })).not.toBe(key);
    // Studio edits gate presentation instead of churning worker ownership;
    // incremental snapshot replacement is issue #67's boundary.
    expect(studioPreviewWorkspaceKeyV1({ ...context, workingRevision: "programs:tx-1" })).toBe(key);
    expect(studioPreviewWorkspaceKeyV1({ ...context })).toBe(key);
  });
});

describe("createFixturePreviewSnapshotProviderV1", () => {
  it("loads a digest-verified snapshot correlated to the checked-in harness identity", async () => {
    const snapshot = await createFixturePreviewSnapshotProviderV1().loadVerifiedSnapshot({
      identity: HARNESS_IDENTITY,
    });
    expect(snapshot.sceneId).toBe("shared:circle-opacity");
    expect(snapshot.duration).toBe(2);
    expect(snapshot.sourceLabel).toBe("verified fixture");
    expect(snapshot.correlation.context).toEqual({
      ...HARNESS_IDENTITY,
      sourceDuration: harnessManifest.expectedDuration,
      workingRevision: PRISTINE_WORKING_REVISION,
    });
    expect(snapshot.correlation.engineRevisionHash).toBe(sceneIrSourceRevisionHash(snapshot.snapshot.scene));
    expect(snapshot.correlation.engineRevisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.correlation.assetsManifestDigest).toBe(snapshot.snapshot.assets.manifestDigest);
    // The correlation records the Scene IR's own duration and identity, and
    // the checked-in manifest pins them: a provider cannot claim a duration
    // the fixture Scene does not have.
    expect(snapshot.correlation.sceneDuration).toBe(snapshot.snapshot.scene.duration);
    expect(snapshot.correlation.sceneId).toBe(snapshot.snapshot.scene.sceneId);
    expect(snapshot.correlation.serverPublicationRevision).toBeNull();
    expect(snapshot.snapshot.scene.entities.length).toBeGreaterThan(0);
  });

  it("refuses every identity that deviates from the checked-in evidence on any axis", async () => {
    const provider = createFixturePreviewSnapshotProviderV1();
    for (const spoofed of [
      { ...HARNESS_IDENTITY, projectId: "another-project" },
      { ...HARNESS_IDENTITY, sceneName: "FieldSummary" },
      { ...HARNESS_IDENTITY, sourceHash: "d".repeat(64) },
      { ...HARNESS_IDENTITY, sourcePath: "other.py" },
    ]) {
      await expect(provider.loadVerifiedSnapshot({ identity: spoofed })).rejects.toThrow(/checked-in harness Scene/);
    }
  });

  it("never copies a caller-supplied identity into the correlation evidence", async () => {
    // Even the accepted request cannot influence the correlation: the context
    // is rebuilt from the checked-in manifest, so equality with the manifest
    // is the only way to correlate.
    const snapshot = await createFixturePreviewSnapshotProviderV1().loadVerifiedSnapshot({
      identity: { ...HARNESS_IDENTITY },
    });
    expect(snapshot.correlation.context.projectId).toBe(harnessManifest.expectedIdentity.projectId);
    expect(snapshot.correlation.context.sourceHash).toBe(harnessManifest.expectedIdentity.sourceHash);
    expect(snapshot.correlation.context.sourcePath).toBe(harnessManifest.expectedIdentity.sourcePath);
  });

  it("rejects an aborted load so a superseded workspace never adopts its result", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createFixturePreviewSnapshotProviderV1().loadVerifiedSnapshot({
        identity: HARNESS_IDENTITY,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
