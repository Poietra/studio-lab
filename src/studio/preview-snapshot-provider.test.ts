import { describe, expect, it, vi } from "vitest";
import harnessManifest from "../../fixtures/engine-v1/shared-circle-opacity.harness.json";
import mathTexHarnessManifest from "../../fixtures/engine-v1/studio-mathtex-preview.harness.json";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import {
  createUnavailableStudioPreviewSnapshotProviderV1,
  loadStudioPreviewSnapshotMetadataV1,
  PRISTINE_WORKING_REVISION,
  resolveStudioPreviewSnapshotProvider,
  type StudioPreviewSceneIdentityV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";
import {
  createExportFixturePreviewSnapshotProviderV1,
  createFixturePreviewSnapshotProviderV1,
  createMathTexFixturePreviewSnapshotProviderV1,
} from "./preview-snapshot-provider.fixture";

const HARNESS_IDENTITY: StudioPreviewSceneIdentityV1 = harnessManifest.expectedIdentity;
const MATHTEX_HARNESS_IDENTITY: StudioPreviewSceneIdentityV1 = mathTexHarnessManifest.expectedIdentity;

describe("resolveStudioPreviewSnapshotProvider", () => {
  it("resolves the controller-selected canonical server provider", async () => {
    const provider = await resolveStudioPreviewSnapshotProvider("server");
    expect(provider?.id).toBe("server-scene-snapshot");
    expect(provider?.evidence).toBeUndefined();
  });

  it("resolves the fixture provider only on explicit opt-in in a dev/test build", async () => {
    expect(import.meta.env.DEV).toBe(true);
    const provider = await resolveStudioPreviewSnapshotProvider("fixture");
    const mathTexProvider = await resolveStudioPreviewSnapshotProvider("mathtex-fixture");
    const exportProvider = await resolveStudioPreviewSnapshotProvider("export-fixture");
    expect(provider?.id).toBe("checked-in-fixture");
    expect(mathTexProvider?.id).toBe("checked-in-mathtex-fixture");
    expect(exportProvider?.id).toBe("checked-in-export-fixture");
    // The dev evidence client extension is wired explicitly by the harness
    // provider, never implicitly by being a snapshot provider.
    expect(provider?.evidence).toBeDefined();
    expect(typeof provider?.evidence?.capture).toBe("function");
    expect(typeof mathTexProvider?.evidence?.capture).toBe("function");
    expect(typeof exportProvider?.evidence?.capture).toBe("function");
  });

  it("keeps the export fixture to six frames at 30 fps", async () => {
    const provider = createExportFixturePreviewSnapshotProviderV1();
    const result = await provider.loadVerifiedSnapshot({ identity: HARNESS_IDENTITY });
    expect(result.duration).toBeCloseTo(0.2);
    expect(result.snapshot.scene.entities).toHaveLength(3);
    expect(result.snapshot.scene.animationChannels[0]?.keyframes.at(-1)?.at).toBeCloseTo(0.2);
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

describe("loadStudioPreviewSnapshotMetadataV1", () => {
  const context = { ...HARNESS_IDENTITY, sourceDuration: 0.1, workingRevision: "programs:tx-1" };

  it("does not execute without both an explicit provider and Scene context", async () => {
    const loadVerifiedSnapshot = vi.fn(async () => {
      throw new Error("must not execute");
    });
    const provider = { id: "test", loadVerifiedSnapshot };
    await expect(loadStudioPreviewSnapshotMetadataV1({ context, provider: null })).resolves.toBeNull();
    await expect(loadStudioPreviewSnapshotMetadataV1({ context: null, provider })).resolves.toBeNull();
    expect(loadVerifiedSnapshot).not.toHaveBeenCalled();
  });

  it("forwards identity and abort ownership while propagating provider failure", async () => {
    const failure = new Error("snapshot producer unavailable");
    const loadVerifiedSnapshot = vi.fn().mockRejectedValue(failure);
    const controller = new AbortController();
    await expect(
      loadStudioPreviewSnapshotMetadataV1({
        context,
        provider: { id: "test", loadVerifiedSnapshot },
        signal: controller.signal,
      }),
    ).rejects.toBe(failure);
    expect(loadVerifiedSnapshot).toHaveBeenCalledWith({ identity: HARNESS_IDENTITY, signal: controller.signal });
  });
});

describe("createUnavailableStudioPreviewSnapshotProviderV1", () => {
  it("turns a provider chunk failure into the regular snapshot-unavailable path", async () => {
    const cause = new Error("dynamic import failed");
    const provider = createUnavailableStudioPreviewSnapshotProviderV1(cause);

    await expect(provider.loadVerifiedSnapshot({ identity: HARNESS_IDENTITY })).rejects.toMatchObject({
      cause,
      message: "The requested Scene preview provider could not be loaded.",
    });
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
    expect(snapshot.snapshot.scene.source).toEqual({
      kind: "imported-manim-server-snapshot",
      runtimeConfigHash: harnessManifest.runtimeConfigHash,
      snapshotHash: "a".repeat(64),
      snapshotVersion: 1,
      sourceHash: harnessManifest.expectedIdentity.sourceHash,
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
    expect(snapshot.snapshot.scene.entities.find((entity) => entity.id === "earlier")?.geometry).toMatchObject({
      center: { x: -1, y: 0 },
    });
    expect(snapshot.sourceRuntimeIdentity?.get("earlier")).toEqual({
      bindingId: `source-binding:${"b".repeat(64)}`,
      entityId: "earlier",
      sourceName: "earlier",
    });
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

  it("loads the dedicated empty imported Scene only for its MathTex harness identity", async () => {
    const provider = createMathTexFixturePreviewSnapshotProviderV1();
    const snapshot = await provider.loadVerifiedSnapshot({ identity: MATHTEX_HARNESS_IDENTITY });

    expect(snapshot).toMatchObject({
      duration: mathTexHarnessManifest.expectedDuration,
      sceneId: mathTexHarnessManifest.sceneId,
      sourceLabel: "verified MathTex fixture",
    });
    expect(snapshot.snapshot.scene).toMatchObject({
      animationChannels: [],
      entities: [],
      source: {
        kind: "imported-manim-server-snapshot",
        sourceHash: mathTexHarnessManifest.expectedIdentity.sourceHash,
      },
    });
    expect(snapshot.correlation.context).toEqual({
      ...MATHTEX_HARNESS_IDENTITY,
      sourceDuration: mathTexHarnessManifest.expectedDuration,
      workingRevision: PRISTINE_WORKING_REVISION,
    });
    expect(snapshot.correlation.engineRevisionHash).toBe(sceneIrSourceRevisionHash(snapshot.snapshot.scene));
    expect(snapshot.sourceRuntimeIdentity).toEqual(new Map());

    await expect(
      provider.loadVerifiedSnapshot({
        identity: { ...MATHTEX_HARNESS_IDENTITY, sceneName: "SharedCircleOpacity" },
      }),
    ).rejects.toThrow(/checked-in harness Scene/);
  });
});
