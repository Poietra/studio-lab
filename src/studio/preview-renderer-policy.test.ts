import { describe, expect, it } from "vitest";
import sceneBundleFixture from "../../fixtures/engine-v1/shared-circle-opacity.json";
import type { SceneIrBundleV1 } from "../engine/contracts";
import {
  describeStudioPreviewFallback,
  evaluateStudioPreviewEligibility,
  projectStudioPreviewInteractionGeometry,
  resolveStudioPreviewViewState,
  type StudioPreviewCapabilities,
  type StudioPreviewHostBinding,
  type StudioPreviewViewStateInput,
  snapStudioPreviewViewport,
  studioPreviewHostBindingCurrent,
  studioPreviewSnapshotCorrelatesV1,
  studioPreviewSnapshotMatchesSourceV1,
  studioPreviewVerifiedSourceDurationV1,
} from "./preview-renderer-policy";
import {
  loadStudioPreviewSnapshotMetadataV1,
  type StudioPreviewEditingContextV1,
  type StudioPreviewSnapshotCorrelationV1,
  type StudioVerifiedPreviewSnapshotV1,
} from "./preview-snapshot-provider";

const CAPABLE: StudioPreviewCapabilities = {
  moduleWorkerSupported: true,
  offscreenCanvasTransferSupported: true,
  webgpuAvailable: true,
};

describe("evaluateStudioPreviewEligibility", () => {
  it("is eligible only when every browser capability is available", () => {
    expect(evaluateStudioPreviewEligibility(CAPABLE)).toEqual({ eligible: true });
  });

  it.each([
    ["moduleWorkerSupported", "Module workers"],
    ["offscreenCanvasTransferSupported", "OffscreenCanvas"],
    ["webgpuAvailable", "WebGPU"],
  ] as const)("reports capability-unsupported when %s is missing", (capability, detailFragment) => {
    const result = evaluateStudioPreviewEligibility({ ...CAPABLE, [capability]: false });
    expect(result).toMatchObject({ eligible: false, reason: "capability-unsupported" });
    if (result.eligible) throw new Error("Expected an ineligible result.");
    expect(result.detail).toContain(detailFragment);
  });

  it("explains how to recover when WebGPU is unavailable", () => {
    const result = evaluateStudioPreviewEligibility({ ...CAPABLE, webgpuAvailable: false });
    if (result.eligible) throw new Error("Expected an ineligible result.");
    expect(result.detail).toMatch(/HTTPS or localhost/i);
    expect(result.detail).toMatch(/hardware acceleration/i);
    expect(result.detail).toMatch(/fully restart/i);
  });

  it("never claims render, source, export, or final-render success in its labels", () => {
    for (const reason of [
      "capability-unsupported",
      "disposed",
      "frame-pending",
      "frame-stale",
      "install-failed",
      "installing",
      "render-error",
      "renderer-failed",
      "sample-out-of-range",
      "scene-unsupported",
      "snapshot-unavailable",
      "snapshot-uncorrelated",
      "viewport-unavailable",
    ] as const) {
      const label = describeStudioPreviewFallback(reason);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/export|final|source of truth|authoritative|success/i);
    }
  });
});

const CONTEXT: StudioPreviewEditingContextV1 = {
  projectId: "preview-harness",
  sceneName: "SharedCircleOpacity",
  sourceDuration: 2,
  sourceHash: "b".repeat(64),
  sourcePath: "shared_circle_opacity.py",
  workingRevision: "pristine",
};

const CORRELATION: StudioPreviewSnapshotCorrelationV1 = {
  assetsManifestDigest: "e".repeat(64),
  context: CONTEXT,
  engineRevisionHash: "a".repeat(64),
  sceneDuration: 2,
  sceneId: "shared:circle-opacity",
  serverPublicationRevision: null,
};

describe("studioPreviewSnapshotCorrelatesV1", () => {
  it("correlates a Studio-native document only on its explicit owner lane", () => {
    const nativeContext = {
      documentKey: "d".repeat(64),
      origin: "studio-native" as const,
      projectId: "native-project",
      sceneId: `native:${"d".repeat(64)}`,
      sourceDuration: 5,
      workingRevision: "pristine",
    };
    const nativeCorrelation: StudioPreviewSnapshotCorrelationV1 = {
      ...CORRELATION,
      context: nativeContext,
      sceneDuration: 5,
      sceneId: nativeContext.sceneId,
    };

    expect(studioPreviewSnapshotCorrelatesV1(nativeCorrelation, nativeContext)).toBe(true);
    expect(studioPreviewSnapshotCorrelatesV1(nativeCorrelation, { ...nativeContext, projectId: "other-project" })).toBe(
      false,
    );
    expect(studioPreviewSnapshotCorrelatesV1(nativeCorrelation, { ...nativeContext, sourceDuration: 6 })).toBe(false);
    expect(studioPreviewSnapshotMatchesSourceV1(CORRELATION, nativeContext)).toBe(false);
  });

  it("correlates only when every editing-context axis matches exactly", () => {
    expect(studioPreviewSnapshotCorrelatesV1(CORRELATION, CONTEXT)).toBe(true);
  });

  it.each([
    ["projectId", { projectId: "other-project" }],
    ["sceneName", { sceneName: "FieldSummary" }],
    ["sourceHash", { sourceHash: "c".repeat(64) }],
    ["sourcePath", { sourcePath: "other.py" }],
    ["workingRevision", { workingRevision: "programs:tx-1" }],
  ] as const)("breaks correlation when %s changes (workspace switch or Studio edit)", (_axis, change) => {
    expect(studioPreviewSnapshotCorrelatesV1(CORRELATION, { ...CONTEXT, ...change })).toBe(false);
  });

  it("uses the verified runtime duration instead of Studio's conservative static-import estimate", () => {
    expect(studioPreviewSnapshotCorrelatesV1(CORRELATION, { ...CONTEXT, sourceDuration: 0.1 })).toBe(true);
  });

  it("keeps immutable source identity separate from live timing and edit revision", () => {
    expect(
      studioPreviewSnapshotMatchesSourceV1(CORRELATION, {
        ...CONTEXT,
        sourceDuration: 14,
        workingRevision: "programs:opening-grid-title-position",
      }),
    ).toBe(true);
  });

  it("never treats an internally inconsistent Scene IR duration as correlated", () => {
    const unrelatedIr: StudioPreviewSnapshotCorrelationV1 = { ...CORRELATION, sceneDuration: 7 };
    expect(studioPreviewSnapshotCorrelatesV1(unrelatedIr, CONTEXT)).toBe(false);
    expect(
      studioPreviewSnapshotCorrelatesV1(
        { ...CORRELATION, context: { ...CORRELATION.context, sourceDuration: 7 } },
        CONTEXT,
      ),
    ).toBe(false);
  });

  it("never adopts a snapshot loaded for a previously active workspace", () => {
    const staleSnapshotCorrelation: StudioPreviewSnapshotCorrelationV1 = {
      ...CORRELATION,
      context: { ...CONTEXT, projectId: "previous-project" },
    };
    expect(studioPreviewSnapshotCorrelatesV1(staleSnapshotCorrelation, CONTEXT)).toBe(false);
  });
});

describe("snapStudioPreviewViewport", () => {
  it("returns the largest integer viewport matching the camera aspect exactly", () => {
    expect(snapStudioPreviewViewport({ height: 476.2, width: 846.4 }, 16 / 9)).toEqual({
      heightPx: 468,
      widthPx: 832,
    });
    expect(snapStudioPreviewViewport({ height: 90, width: 160 }, 16 / 9)).toEqual({ heightPx: 90, widthPx: 160 });
  });

  it("refuses boxes and aspects that cannot produce a matching viewport", () => {
    expect(snapStudioPreviewViewport({ height: 0.4, width: 100 }, 16 / 9)).toBeNull();
    expect(snapStudioPreviewViewport({ height: 100, width: 100 }, Number.NaN)).toBeNull();
    expect(snapStudioPreviewViewport({ height: 100, width: 100 }, 0)).toBeNull();
  });
});

const VIEW_SNAPSHOT = {
  assetPayloads: [],
  correlation: CORRELATION,
  duration: 2,
  sceneId: "shared:circle-opacity",
  snapshot: sceneBundleFixture as unknown as SceneIrBundleV1,
  sourceLabel: "verified fixture",
  sourceRuntimeIdentity: null,
} satisfies StudioVerifiedPreviewSnapshotV1;

describe("studioPreviewVerifiedSourceDurationV1", () => {
  it("keeps verified source time authoritative after Studio edits", () => {
    expect(
      studioPreviewVerifiedSourceDurationV1(VIEW_SNAPSHOT, {
        ...CONTEXT,
        sourceDuration: 0.1,
        workingRevision: "programs:tx-1",
      }),
    ).toBe(2);
  });

  it.each([
    ["project", { projectId: "previous-project" }],
    ["path", { sourcePath: "other.py" }],
    ["Scene", { sceneName: "FieldSummary" }],
    ["source hash", { sourceHash: "c".repeat(64) }],
  ] as const)("rejects a retained snapshot with stale %s identity", (_axis, change) => {
    expect(studioPreviewVerifiedSourceDurationV1(VIEW_SNAPSHOT, { ...CONTEXT, ...change })).toBeNull();
  });

  it("fails closed when the provider has no result or any duration seam disagrees", () => {
    expect(studioPreviewVerifiedSourceDurationV1(null, CONTEXT)).toBeNull();
    expect(studioPreviewVerifiedSourceDurationV1({ ...VIEW_SNAPSHOT, duration: 3 }, CONTEXT)).toBeNull();
    const tooShort = {
      ...VIEW_SNAPSHOT,
      correlation: { ...CORRELATION, context: { ...CONTEXT, sourceDuration: 0.05 }, sceneDuration: 0.05 },
      duration: 0.05,
      snapshot: { ...VIEW_SNAPSHOT.snapshot, scene: { ...VIEW_SNAPSHOT.snapshot.scene, duration: 0.05 } },
    };
    expect(studioPreviewVerifiedSourceDurationV1(tooShort, CONTEXT)).toBeNull();
    expect(
      studioPreviewVerifiedSourceDurationV1(
        {
          ...VIEW_SNAPSHOT,
          snapshot: {
            ...VIEW_SNAPSHOT.snapshot,
            scene: { ...VIEW_SNAPSHOT.snapshot.scene, duration: 3 },
          },
        },
        CONTEXT,
      ),
    ).toBeNull();
  });
});

const PRESENTED_VIEW_INPUT: StudioPreviewViewStateInput = {
  context: CONTEXT,
  eligibility: { eligible: true },
  hostActive: true,
  hostState: {
    frame: {
      packetId: "canvas:2",
      revision: CORRELATION.engineRevisionHash,
      sampleTime: 1,
      viewport: { heightPx: 90, widthPx: 160 },
    },
    phase: "presented",
  },
  sampleTime: 1,
  sceneBoundaryActive: false,
  snapshot: VIEW_SNAPSHOT,
  snapshotError: null,
  viewport: { heightPx: 90, widthPx: 160 },
};

describe("resolveStudioPreviewViewState", () => {
  it("presents a correlated Studio-owned revision while retaining the imported snapshot as source evidence", () => {
    const workingRevision = "programs:tx-1";
    const engineRevisionHash = "f".repeat(64);
    expect(
      resolveStudioPreviewViewState({
        ...PRESENTED_VIEW_INPUT,
        context: { ...CONTEXT, workingRevision },
        hostState: {
          frame: {
            packetId: "canvas:studio",
            revision: engineRevisionHash,
            sampleTime: 1,
            viewport: { heightPx: 90, widthPx: 160 },
          },
          phase: "presented",
        },
        workingScene: { engineRevisionHash, workingRevision },
      }),
    ).toMatchObject({ frame: { revision: engineRevisionHash }, phase: "presented" });
  });

  it("rejects a stale Studio-owned frame even while its imported source evidence still matches", () => {
    expect(
      resolveStudioPreviewViewState({
        ...PRESENTED_VIEW_INPUT,
        context: { ...CONTEXT, workingRevision: "programs:tx-2" },
        workingScene: { engineRevisionHash: CORRELATION.engineRevisionHash, workingRevision: "programs:tx-1" },
      }),
    ).toMatchObject({ phase: "fallback", reason: "snapshot-uncorrelated" });
  });

  it("loads verified source time while renderer capability stays unsupported", async () => {
    const editedContext = { ...CONTEXT, sourceDuration: 0.1, workingRevision: "programs:tx-1" };
    const loaded = await loadStudioPreviewSnapshotMetadataV1({
      context: editedContext,
      provider: { id: "metadata-only", loadVerifiedSnapshot: async () => VIEW_SNAPSHOT },
    });
    const eligibility = evaluateStudioPreviewEligibility({ ...CAPABLE, webgpuAvailable: false });

    expect(studioPreviewVerifiedSourceDurationV1(loaded, editedContext)).toBe(2);
    expect(
      resolveStudioPreviewViewState({
        ...PRESENTED_VIEW_INPUT,
        context: editedContext,
        eligibility,
        snapshot: loaded,
      }),
    ).toMatchObject({ phase: "fallback", reason: "capability-unsupported" });
  });

  it("fails closed when snapshot metadata loading reports a provider error", () => {
    expect(
      resolveStudioPreviewViewState({
        ...PRESENTED_VIEW_INPUT,
        snapshot: null,
        snapshotError: "snapshot producer unavailable",
      }),
    ).toMatchObject({ phase: "fallback", reason: "snapshot-unavailable" });
  });

  it("reports a metadata failure even when WebGPU is unavailable", () => {
    expect(
      resolveStudioPreviewViewState({
        ...PRESENTED_VIEW_INPUT,
        eligibility: evaluateStudioPreviewEligibility({ ...CAPABLE, webgpuAvailable: false }),
        snapshot: null,
        snapshotError: "snapshot producer unavailable",
      }),
    ).toEqual({
      detail: "snapshot producer unavailable",
      phase: "fallback",
      reason: "snapshot-unavailable",
    });
  });

  it("presents only when the host frame matches this render exactly", () => {
    expect(resolveStudioPreviewViewState(PRESENTED_VIEW_INPUT)).toBe(PRESENTED_VIEW_INPUT.hostState);
  });

  it.each([
    ["the playhead moved", { sampleTime: 1.25 }],
    ["the viewport changed", { viewport: { heightPx: 180, widthPx: 320 } }],
    ["the viewport disappeared", { viewport: null }],
    ["the host was disposed or replaced", { hostActive: false }],
  ] as const)("falls back synchronously when %s", (_case, change) => {
    expect(resolveStudioPreviewViewState({ ...PRESENTED_VIEW_INPUT, ...change })).toMatchObject({
      phase: "fallback",
      reason: "frame-stale",
    });
  });

  it("reports Scene-boundary composition as explicitly unsupported", () => {
    expect(resolveStudioPreviewViewState({ ...PRESENTED_VIEW_INPUT, sceneBoundaryActive: true })).toMatchObject({
      phase: "fallback",
      reason: "scene-unsupported",
    });
  });

  it("never presents a frame whose engine revision differs from the snapshot correlation", () => {
    expect(
      resolveStudioPreviewViewState({
        ...PRESENTED_VIEW_INPUT,
        hostState: {
          frame: {
            packetId: "canvas:2",
            revision: "f".repeat(64),
            sampleTime: 1,
            viewport: { heightPx: 90, widthPx: 160 },
          },
          phase: "presented",
        },
      }),
    ).toMatchObject({ phase: "fallback", reason: "snapshot-uncorrelated" });
  });

  it("reports uncorrelated snapshots ahead of frame staleness", () => {
    expect(
      resolveStudioPreviewViewState({
        ...PRESENTED_VIEW_INPUT,
        context: { ...CONTEXT, workingRevision: "programs:tx-1" },
        sampleTime: 1.25,
      }),
    ).toMatchObject({ phase: "fallback", reason: "snapshot-uncorrelated" });
  });
});

describe("studioPreviewHostBindingCurrent", () => {
  const canvas = {};
  const provider = {};
  const snapshot = {};
  const binding: StudioPreviewHostBinding = { canvas, provider, snapshot, workspaceKey: "key-1" };
  const current: StudioPreviewHostBinding = { canvas, provider, snapshot, workspaceKey: "key-1" };

  it("matches only the exact same canvas, provider, snapshot, and workspace", () => {
    expect(studioPreviewHostBindingCurrent(binding, current)).toBe(true);
  });

  it.each([
    ["StrictMode cleanup", null],
    ["canvas remount", { ...current, canvas: {} }],
    ["provider replacement", { ...current, provider: {} }],
    ["snapshot reload", { ...current, snapshot: {} }],
    ["workspace switch", { ...current, workspaceKey: "key-2" }],
  ] as const)("invalidates on %s", (_case, candidate) => {
    expect(studioPreviewHostBindingCurrent(candidate === null ? null : binding, candidate ?? current)).toBe(false);
  });
});

describe("projectStudioPreviewInteractionGeometry", () => {
  const FRAME = { height: 8, width: 16 } as const;

  it("maps clip-space centers and extents into Studio overlay and frame units", () => {
    const geometry = projectStudioPreviewInteractionGeometry(
      ["runtime:circle"],
      {
        entries: [{ bounds: [-0.5, 0, 0.5, 1], status: "present" }],
        space: "clip-v1",
        status: "available",
      },
      FRAME,
    );

    expect(geometry.get("runtime:circle")?.position).toEqual({ x: 320, y: 90 });
    expect(geometry.get("runtime:circle")?.dimensions).toEqual({ height: 4, width: 8 });
  });

  it("reports visual AABB dimensions without inferring an editable radius", () => {
    const geometry = projectStudioPreviewInteractionGeometry(
      ["runtime:circle"],
      {
        entries: [{ bounds: [-0.25, -0.5, 0.25, 0.5], status: "present" }],
        space: "clip-v1",
        status: "available",
      },
      FRAME,
    );
    const dimensions = geometry.get("runtime:circle")?.dimensions;

    expect(dimensions).toEqual({ height: 4, width: 4 });
    expect(dimensions).not.toHaveProperty("radius");
  });

  it.each(["inactive", "empty", "unavailable"] as const)(
    "returns no prepared target for a %s runtime entry",
    (status) => {
      const geometry = projectStudioPreviewInteractionGeometry(
        ["runtime:entity"],
        { entries: [{ status }], space: "clip-v1", status: "available" },
        FRAME,
      );

      expect(geometry.size).toBe(0);
    },
  );

  it.each([
    ["missing metadata", undefined],
    ["null metadata", null],
    ["unavailable metadata", { status: "unavailable" }],
  ] as const)("returns no prepared target for %s", (_case, interaction) => {
    expect(projectStudioPreviewInteractionGeometry(["runtime:entity"], interaction, FRAME).size).toBe(0);
  });

  it("rejects metadata whose ordered entry count does not match the requested IDs", () => {
    const geometry = projectStudioPreviewInteractionGeometry(
      ["runtime:first", "runtime:second"],
      {
        entries: [{ bounds: [-1, -1, 0, 0], status: "present" }],
        space: "clip-v1",
        status: "available",
      },
      FRAME,
    );

    expect(geometry.size).toBe(0);
  });
});
