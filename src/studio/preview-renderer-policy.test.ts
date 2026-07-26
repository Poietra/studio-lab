import { describe, expect, it } from "vitest";
import type { SceneIrBundleV1 } from "../engine/contracts";
import {
  describeStudioPreviewFallbackV1,
  evaluateStudioPreviewEligibilityV1,
  projectStudioPreviewStaticInteractionGeometryV1,
  resolveStudioPreviewViewStateV1,
  type StudioPreviewEligibilityInputV1,
  type StudioPreviewHostBindingV1,
  type StudioPreviewViewStateInputV1,
  snapStudioPreviewViewportV1,
  studioPreviewHostBindingCurrentV1,
  studioPreviewSnapshotCorrelatesV1,
} from "./preview-renderer-policy";
import type {
  StudioPreviewEditingContextV1,
  StudioPreviewSnapshotCorrelationV1,
  StudioVerifiedPreviewSnapshotV1,
} from "./preview-snapshot-provider";

const CAPABLE: StudioPreviewEligibilityInputV1 = {
  moduleWorkerSupported: true,
  offscreenCanvasTransferSupported: true,
  providerAvailable: true,
  webgpuAvailable: true,
};

describe("evaluateStudioPreviewEligibilityV1", () => {
  it("stays disabled without a verified snapshot provider even in a capable browser", () => {
    const result = evaluateStudioPreviewEligibilityV1({ ...CAPABLE, providerAvailable: false });
    expect(result).toMatchObject({ eligible: false, reason: "disabled" });
  });

  it("is eligible only when every capability and the provider are available", () => {
    expect(evaluateStudioPreviewEligibilityV1(CAPABLE)).toEqual({ eligible: true });
  });

  it.each([
    ["moduleWorkerSupported", "Module workers"],
    ["offscreenCanvasTransferSupported", "OffscreenCanvas"],
    ["webgpuAvailable", "WebGPU"],
  ] as const)("reports capability-unsupported when %s is missing", (capability, detailFragment) => {
    const result = evaluateStudioPreviewEligibilityV1({ ...CAPABLE, [capability]: false });
    expect(result).toMatchObject({ eligible: false, reason: "capability-unsupported" });
    if (result.eligible) throw new Error("Expected an ineligible result.");
    expect(result.detail).toContain(detailFragment);
  });

  it("never claims render, source, export, or final-render success in its labels", () => {
    for (const reason of [
      "capability-unsupported",
      "disabled",
      "disposed",
      "frame-pending",
      "frame-stale",
      "install-failed",
      "installing",
      "render-error",
      "renderer-failed",
      "sample-out-of-range",
      "snapshot-unavailable",
      "snapshot-uncorrelated",
      "transient-edit",
      "viewport-unavailable",
    ] as const) {
      const label = describeStudioPreviewFallbackV1(reason);
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
  it("correlates only when every editing-context axis matches exactly", () => {
    expect(studioPreviewSnapshotCorrelatesV1(CORRELATION, CONTEXT)).toBe(true);
  });

  it.each([
    ["projectId", { projectId: "other-project" }],
    ["sceneName", { sceneName: "FieldSummary" }],
    ["sourceHash", { sourceHash: "c".repeat(64) }],
    ["sourcePath", { sourcePath: "other.py" }],
    ["sourceDuration", { sourceDuration: 12 }],
    ["workingRevision", { workingRevision: "programs:tx-1" }],
  ] as const)("breaks correlation when %s changes (workspace switch or Studio edit)", (_axis, change) => {
    expect(studioPreviewSnapshotCorrelatesV1(CORRELATION, { ...CONTEXT, ...change })).toBe(false);
  });

  it("never treats a Scene IR whose duration differs from the source as correlated", () => {
    const unrelatedIr: StudioPreviewSnapshotCorrelationV1 = { ...CORRELATION, sceneDuration: 7 };
    expect(studioPreviewSnapshotCorrelatesV1(unrelatedIr, CONTEXT)).toBe(false);
  });

  it("never adopts a snapshot loaded for a previously active workspace", () => {
    const staleSnapshotCorrelation: StudioPreviewSnapshotCorrelationV1 = {
      ...CORRELATION,
      context: { ...CONTEXT, projectId: "previous-project" },
    };
    expect(studioPreviewSnapshotCorrelatesV1(staleSnapshotCorrelation, CONTEXT)).toBe(false);
  });
});

describe("snapStudioPreviewViewportV1", () => {
  it("returns the largest integer viewport matching the camera aspect exactly", () => {
    expect(snapStudioPreviewViewportV1({ height: 476.2, width: 846.4 }, 16 / 9)).toEqual({
      heightPx: 468,
      widthPx: 832,
    });
    expect(snapStudioPreviewViewportV1({ height: 90, width: 160 }, 16 / 9)).toEqual({ heightPx: 90, widthPx: 160 });
  });

  it("refuses boxes and aspects that cannot produce a matching viewport", () => {
    expect(snapStudioPreviewViewportV1({ height: 0.4, width: 100 }, 16 / 9)).toBeNull();
    expect(snapStudioPreviewViewportV1({ height: 100, width: 100 }, Number.NaN)).toBeNull();
    expect(snapStudioPreviewViewportV1({ height: 100, width: 100 }, 0)).toBeNull();
  });
});

const VIEW_SNAPSHOT = {
  correlation: CORRELATION,
  duration: 2,
  sceneId: "shared:circle-opacity",
  snapshot: {} as SceneIrBundleV1,
  sourceLabel: "verified fixture",
} satisfies StudioVerifiedPreviewSnapshotV1;

const PRESENTED_VIEW_INPUT: StudioPreviewViewStateInputV1 = {
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
  snapshot: VIEW_SNAPSHOT,
  snapshotError: null,
  transientEdit: false,
  viewport: { heightPx: 90, widthPx: 160 },
};

describe("resolveStudioPreviewViewStateV1", () => {
  it("presents only when the host frame matches this render exactly", () => {
    expect(resolveStudioPreviewViewStateV1(PRESENTED_VIEW_INPUT)).toBe(PRESENTED_VIEW_INPUT.hostState);
  });

  it.each([
    ["the playhead moved", { sampleTime: 1.25 }],
    ["the viewport changed", { viewport: { heightPx: 180, widthPx: 320 } }],
    ["the viewport disappeared", { viewport: null }],
    ["the host was disposed or replaced", { hostActive: false }],
  ] as const)("falls back synchronously when %s", (_case, change) => {
    expect(resolveStudioPreviewViewStateV1({ ...PRESENTED_VIEW_INPUT, ...change })).toMatchObject({
      phase: "fallback",
      reason: "frame-stale",
    });
  });

  it("gates transient edits synchronously in the render that starts the drag", () => {
    expect(resolveStudioPreviewViewStateV1({ ...PRESENTED_VIEW_INPUT, transientEdit: true })).toMatchObject({
      phase: "fallback",
      reason: "transient-edit",
    });
  });

  it("never presents a frame whose engine revision differs from the snapshot correlation", () => {
    expect(
      resolveStudioPreviewViewStateV1({
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
      resolveStudioPreviewViewStateV1({
        ...PRESENTED_VIEW_INPUT,
        context: { ...CONTEXT, workingRevision: "programs:tx-1" },
        sampleTime: 1.25,
      }),
    ).toMatchObject({ phase: "fallback", reason: "snapshot-uncorrelated" });
  });
});

describe("studioPreviewHostBindingCurrentV1", () => {
  const canvas = {};
  const provider = {};
  const snapshot = {};
  const binding: StudioPreviewHostBindingV1 = { canvas, provider, snapshot, workspaceKey: "key-1" };
  const current: StudioPreviewHostBindingV1 = { canvas, provider, snapshot, workspaceKey: "key-1" };

  it("matches only the exact same canvas, provider, snapshot, and workspace", () => {
    expect(studioPreviewHostBindingCurrentV1(binding, current)).toBe(true);
  });

  it.each([
    ["StrictMode cleanup", null],
    ["canvas remount", { ...current, canvas: {} }],
    ["provider replacement", { ...current, provider: {} }],
    ["snapshot reload", { ...current, snapshot: {} }],
    ["workspace switch", { ...current, workspaceKey: "key-2" }],
  ] as const)("invalidates on %s", (_case, candidate) => {
    expect(studioPreviewHostBindingCurrentV1(candidate === null ? null : binding, candidate ?? current)).toBe(false);
  });
});

describe("projectStudioPreviewStaticInteractionGeometryV1", () => {
  const IDENTITY = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 } as const;
  const LIFETIME = [{ end: 2, start: 0 }] as const;

  function entityWith(overrides: Record<string, unknown>) {
    return { lifetimes: LIFETIME, parentId: null, transform: IDENTITY, ...overrides };
  }

  function sceneWith(entities: readonly Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
    return {
      animationChannels: [],
      camera: { view: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 } },
      entities,
      ...overrides,
    } as unknown as SceneIrBundleV1["scene"];
  }

  const scene = sceneWith(
    [
      entityWith({ geometry: { center: { x: -1, y: 0 }, kind: "circle", radius: 1 }, id: "earlier" }),
      entityWith({ geometry: { end: { x: -2, y: 2 }, kind: "line", start: { x: -4, y: 2 } }, id: "stroke" }),
    ],
    // Opacity-only channels keep the static-Scene guarantee intact.
    { animationChannels: [{ entityId: "earlier", kind: "opacity" }] },
  );

  it("projects hit targets to the exact snapshot positions in Studio viewport space", () => {
    const geometry = projectStudioPreviewStaticInteractionGeometryV1(scene, { height: 8, width: 14.222 }, 1);
    // Scene (-1, 0) inside a 16x9 camera is the 0.4375 width fraction.
    expect(geometry.get("earlier")?.position).toEqual({ x: 0.4375 * 640, y: 180 });
    // The circle radius is scaled from camera units into workspace frame units.
    expect(geometry.get("earlier")?.dimensions).toEqual({ radius: 8 / 9 });
    // Lines anchor at their midpoint with no synthetic dimensions.
    expect(geometry.get("stroke")?.position).toEqual({ x: (0.5 - 3 / 16) * 640, y: (0.5 - 2 / 9) * 360 });
    expect(geometry.get("stroke")?.dimensions).toBeNull();
  });

  // The engine's affine convention (prepare.rs) is x' = m11·x + m12·y + tx
  // and y' = m21·x + m22·y + ty. The unit frame below makes both frame ratios
  // exactly 1 so the expectations read directly in camera units.
  const UNIT_FRAME = { height: 9, width: 16 } as const;

  it("projects rotated centers with the engine's row convention, not its transpose", () => {
    // Rotation by 90° with uniform scale 2: m = [0 -2; 2 0].
    const geometry = projectStudioPreviewStaticInteractionGeometryV1(
      sceneWith([
        entityWith({
          geometry: { center: { x: 1, y: 0.5 }, kind: "circle", radius: 1 },
          id: "rotated",
          transform: { m11: 0, m12: -2, m21: 2, m22: 0, tx: 0.5, ty: -0.25 },
        }),
      ]),
      UNIT_FRAME,
      1,
    );
    // World center: x = 0·1 + (-2)·0.5 + 0.5 = -0.5, y = 2·1 + 0·0.5 - 0.25 = 1.75.
    expect(geometry.get("rotated")?.position.x).toBeCloseTo((0.5 - 0.5 / 16) * 640, 10);
    expect(geometry.get("rotated")?.position.y).toBeCloseTo((0.5 - 1.75 / 9) * 360, 10);
    // A rotated uniform scale keeps the circle a circle: radius 1 × scale 2.
    expect(geometry.get("rotated")?.dimensions?.radius).toBeCloseTo(2, 10);
  });

  it.each([
    ["non-uniform scale", "ellipse", { m11: 3, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 }, 12, 4],
    ["equal-norm shear", "shear", { m11: 1, m12: 0, m21: 0.6, m22: 0.8, tx: 0, ty: 0 }, 4, 4],
  ] as const)(
    "projects a circle under %s as bounds without a resizable radius",
    (_case, id, transform, width, height) => {
      const geometry = projectStudioPreviewStaticInteractionGeometryV1(
        sceneWith([entityWith({ geometry: { center: { x: 0, y: 0 }, kind: "circle", radius: 2 }, id, transform })]),
        UNIT_FRAME,
        1,
      );
      const dimensions = geometry.get(id)?.dimensions;
      expect(dimensions?.radius).toBeUndefined();
      expect(dimensions?.width).toBeCloseTo(width, 10);
      expect(dimensions?.height).toBeCloseTo(height, 10);
    },
  );

  it("projects rotated and sheared rectangles as their exact axis-aligned bounds", () => {
    const geometry = projectStudioPreviewStaticInteractionGeometryV1(
      sceneWith([
        entityWith({
          geometry: { center: { x: 0, y: 0 }, height: 2, kind: "rectangle", width: 4 },
          id: "quarter-turn",
          transform: { m11: 0, m12: -1, m21: 1, m22: 0, tx: 0, ty: 0 },
        }),
        entityWith({
          geometry: { center: { x: 0, y: 0 }, height: 2, kind: "rectangle", width: 4 },
          id: "sheared",
          transform: { m11: 1, m12: 0.5, m21: 0, m22: 1, tx: 0, ty: 0 },
        }),
      ]),
      UNIT_FRAME,
      1,
    );
    // 90° rotation swaps the extents: |m11|w+|m12|h = 2, |m21|w+|m22|h = 4.
    expect(geometry.get("quarter-turn")?.dimensions).toEqual({ height: 4, width: 2 });
    // Horizontal shear widens the AABB: 1·4 + 0.5·2 = 5 wide, 2 tall.
    expect(geometry.get("sheared")?.dimensions).toEqual({ height: 2, width: 5 });
  });

  it("keeps transformed line hit targets center-anchored only", () => {
    const geometry = projectStudioPreviewStaticInteractionGeometryV1(
      sceneWith([
        entityWith({
          geometry: { end: { x: -2, y: 2 }, kind: "line", start: { x: -4, y: 2 } },
          id: "rotated-stroke",
          transform: { m11: 0, m12: -1, m21: 1, m22: 0, tx: 0, ty: 0 },
        }),
      ]),
      UNIT_FRAME,
      1,
    );
    // Midpoint (-3, 2) rotates to (-2, -3); the stroke's extent stays the
    // semantic placeholder's responsibility (dimensions stay null).
    expect(geometry.get("rotated-stroke")?.position.x).toBeCloseTo((0.5 - 2 / 16) * 640, 10);
    expect(geometry.get("rotated-stroke")?.position.y).toBeCloseTo((0.5 + 3 / 9) * 360, 10);
    expect(geometry.get("rotated-stroke")?.dimensions).toBeNull();
  });

  const STATIC_CIRCLE = entityWith({
    geometry: { center: { x: 0, y: 0 }, kind: "circle", radius: 1 },
    id: "plain",
  });

  it.each([
    [
      "a parent-composed entity",
      sceneWith([STATIC_CIRCLE, entityWith({ ...STATIC_CIRCLE, id: "child", parentId: "plain" })]),
    ],
    ["an animated camera", sceneWith([STATIC_CIRCLE], { animationChannels: [{ kind: "camera" }] })],
    [
      "an affine-transform channel",
      sceneWith([STATIC_CIRCLE], { animationChannels: [{ entityId: "plain", kind: "affine-transform" }] }),
    ],
    [
      "a motion-path channel",
      sceneWith([STATIC_CIRCLE], { animationChannels: [{ entityId: "plain", kind: "motion-path" }] }),
    ],
    [
      "a path-morph channel",
      sceneWith([STATIC_CIRCLE], { animationChannels: [{ entityId: "plain", kind: "path-morph" }] }),
    ],
    [
      "a path-trim channel",
      sceneWith([STATIC_CIRCLE], { animationChannels: [{ entityId: "plain", kind: "path-trim" }] }),
    ],
  ] as const)(
    "provides no projection when the Scene contains %s (the semantic geometry stays authoritative)",
    (_shape, dynamicScene) => {
      expect(projectStudioPreviewStaticInteractionGeometryV1(dynamicScene, UNIT_FRAME, 1).size).toBe(0);
    },
  );

  it.each([
    ["before its lifetime starts", 0.25, false],
    ["at its inclusive lifetime start", 0.5, true],
    ["inside its lifetime", 1, true],
    ["at its exclusive lifetime end", 1.5, false],
  ] as const)("projects an entity %s: present=%s", (_when, sampleTime, present) => {
    const bounded = sceneWith([
      entityWith({
        geometry: { center: { x: 0, y: 0 }, kind: "circle", radius: 1 },
        id: "bounded",
        lifetimes: [{ end: 1.5, start: 0.5 }],
      }),
    ]);
    expect(projectStudioPreviewStaticInteractionGeometryV1(bounded, UNIT_FRAME, sampleTime).has("bounded")).toBe(
      present,
    );
  });
});
