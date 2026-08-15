import { describe, expect, it } from "vitest";

import {
  type AssetManifestV1,
  assetManifestV1Schema,
  countLoweredSceneGeometrySegmentsV1,
  digestAssetManifestV1,
  parseVerifiedSceneIrBundleV1,
  renderViewportV1Schema,
  type SceneIrV1,
  sceneIrBundleV1Schema,
  sceneIrV1Schema,
} from "./contracts";

const ZERO_HASH = "0".repeat(64);
const SCENE_HASH = "b".repeat(64);
const ASSET_HASH = "c".repeat(64);
const OTHER_HASH = "d".repeat(64);

const identity = {
  m11: 1,
  m12: 0,
  m21: 0,
  m22: 1,
  tx: 0,
  ty: 0,
};

const white = {
  alpha: 1,
  blue: 1,
  green: 1,
  red: 1,
};

const path = {
  subpaths: [
    {
      closed: true,
      segments: [
        {
          control1: { x: 1, y: 0 },
          control2: { x: 1, y: 1 },
          end: { x: 0, y: 1 },
        },
      ],
      start: { x: 0, y: 0 },
    },
  ],
};

async function manifest(): Promise<AssetManifestV1> {
  const draft = assetManifestV1Schema.parse({
    assets: [
      {
        alphaMode: "straight",
        byteLength: 128,
        colorSpace: "srgb",
        id: "image-asset",
        kind: "png-image",
        mediaType: "image/png",
        pixelHeight: 64,
        pixelWidth: 96,
        sha256: ASSET_HASH,
      },
    ],
    manifestDigest: ZERO_HASH,
    manifestId: "manifest",
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
}

function scene(assets: AssetManifestV1): SceneIrV1 {
  return sceneIrV1Schema.parse({
    animationChannels: [
      {
        entityId: "circle",
        id: "circle-opacity",
        keyframes: [
          {
            at: 0,
            easingToNext: { kind: "cubic-bezier", x1: 0.25, x2: 0.75, y1: 0.1, y2: 1 },
            value: 0,
          },
          { at: 1, easingToNext: null, value: 1 },
        ],
        kind: "opacity",
        provenanceId: "fixture",
      },
    ],
    assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
    camera: {
      background: { ...white, blue: 0, green: 0, red: 0 },
      view: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
    },
    compositing: "linear-light",
    coordinateSpace: {
      cpuPrecision: "f64",
      kind: "cartesian-2d",
      origin: "center",
      unit: "scene-unit",
      xAxis: "right",
      yAxis: "up",
    },
    duration: 2,
    entities: [
      {
        appearance: { fill: { color: white, rule: "nonzero" }, kind: "vector", opacity: 1, stroke: null },
        geometry: { center: { x: 0, y: 0 }, kind: "circle", radius: 1 },
        id: "circle",
        lifetimes: [{ end: 2, start: 0 }],
        parentId: null,
        provenanceId: "fixture",
        sceneOrder: 0,
        sourceZIndex: 0,
        transform: identity,
      },
      {
        appearance: {
          fill: null,
          kind: "vector",
          opacity: 1,
          stroke: { cap: "round", color: white, join: "round", miterLimit: 4, widthWorld: 0.05 },
        },
        geometry: { kind: "cubic-path", path },
        id: "curve",
        lifetimes: [{ end: 2, start: 0 }],
        parentId: null,
        provenanceId: "fixture",
        sceneOrder: 1,
        sourceZIndex: 0,
        transform: identity,
      },
      {
        appearance: { kind: "image", opacity: 0.75 },
        geometry: {
          asset: { assetId: "image-asset", sha256: ASSET_HASH },
          kind: "image",
          localRect: { bottom: -1, left: -1.5, right: 1.5, top: 1 },
          sampler: "linear",
        },
        id: "image",
        lifetimes: [{ end: 2, start: 0 }],
        parentId: null,
        provenanceId: "fixture",
        sceneOrder: 2,
        sourceZIndex: 1,
        transform: identity,
      },
    ],
    fidelity: { kind: "exact" },
    provenance: [{ evidence: ["engine contract fixture"], id: "fixture", origin: "fixture" }],
    requiredCapabilities: ["cubic-path-geometry", "opacity-animation", "png-image", "shape-primitives"],
    sceneId: "scene",
    schema: "poietra.scene-ir",
    source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: SCENE_HASH },
    stateSampling: { frameRate: null, retainsTerminalState: false },
    version: 1,
  });
}

describe("Poietra Engine v1 contracts", () => {
  it("accepts and integrity-checks a complete Scene IR bundle", async () => {
    const assets = await manifest();
    const sceneIr = scene(assets);
    const bundle = { assets, scene: sceneIr };

    expect(sceneIrBundleV1Schema.safeParse(bundle).success).toBe(true);
    await expect(parseVerifiedSceneIrBundleV1(JSON.parse(JSON.stringify(bundle)))).resolves.toEqual(bundle);
  });

  it("rejects newer versions, unknown fields, and padded identities", async () => {
    const assets = await manifest();
    const validScene = scene(assets);
    expect(sceneIrV1Schema.safeParse({ ...validScene, version: 2 }).success).toBe(false);
    expect(sceneIrV1Schema.safeParse({ ...validScene, sceneId: " scene " }).success).toBe(false);
    expect(
      sceneIrV1Schema.safeParse({
        ...validScene,
        camera: { ...validScene.camera, filesystemPath: "/tmp/camera.json" },
      }).success,
    ).toBe(false);
  });

  it("delegates Scene semantic invariants to the Rust core", async () => {
    const assets = await manifest();
    const validScene = scene(assets);

    await expect(
      parseVerifiedSceneIrBundleV1({
        assets,
        scene: { ...validScene, requiredCapabilities: ["shape-primitives"] },
      }),
    ).rejects.toThrow(/requiredCapabilities/);
    await expect(
      parseVerifiedSceneIrBundleV1({
        assets,
        scene: {
          ...validScene,
          animationChannels: validScene.animationChannels.map((channel) => ({
            ...channel,
            keyframes: channel.keyframes.map((keyframe) => ({ ...keyframe, at: 3 })),
          })),
        },
      }),
    ).rejects.toThrow(/keyframe/i);
  });

  it("accounts for primitive lowering and synthetic close segments", () => {
    expect(countLoweredSceneGeometrySegmentsV1({ center: { x: 0, y: 0 }, kind: "circle", radius: 1 })).toBe(4);
    expect(
      countLoweredSceneGeometrySegmentsV1({
        center: { x: 0, y: 0 },
        cornerRadius: 0.25,
        height: 2,
        kind: "rectangle",
        width: 3,
      }),
    ).toBe(8);
    expect(countLoweredSceneGeometrySegmentsV1({ kind: "cubic-path", path })).toBe(2);
  });

  it("rejects stale asset references and tampered manifest metadata", async () => {
    const assets = await manifest();
    const validScene = scene(assets);
    const staleScene = {
      ...validScene,
      entities: validScene.entities.map((entity) =>
        entity.geometry.kind === "image"
          ? { ...entity, geometry: { ...entity.geometry, asset: { ...entity.geometry.asset, sha256: OTHER_HASH } } }
          : entity,
      ),
    };
    await expect(parseVerifiedSceneIrBundleV1({ assets, scene: staleScene })).rejects.toThrow(/stale asset/i);

    const tampered = { ...assets, assets: [{ ...assets.assets[0], byteLength: assets.assets[0].byteLength + 1 }] };
    expect(sceneIrBundleV1Schema.safeParse({ assets: tampered, scene: validScene }).success).toBe(true);
    await expect(parseVerifiedSceneIrBundleV1({ assets: tampered, scene: validScene })).rejects.toThrow(/digest/i);
  });

  it("enforces aggregate asset resource limits", () => {
    const oversized = {
      assets: ["a", "b", "c"].map((id) => ({
        alphaMode: "straight",
        byteLength: 1,
        colorSpace: "srgb",
        id,
        kind: "png-image",
        mediaType: "image/png",
        pixelHeight: 4_096,
        pixelWidth: 4_096,
        sha256: ASSET_HASH,
      })),
      manifestDigest: ZERO_HASH,
      manifestId: "oversized",
      schema: "poietra.asset-manifest",
      version: 1,
    };
    expect(assetManifestV1Schema.safeParse(oversized).success).toBe(false);
  });

  it("bounds render viewports used by the Canvas protocol", () => {
    expect(renderViewportV1Schema.parse({ heightPx: 1_080, widthPx: 1_920 })).toEqual({
      heightPx: 1_080,
      widthPx: 1_920,
    });
    expect(renderViewportV1Schema.safeParse({ heightPx: 4_096, widthPx: 8_192 }).success).toBe(true);
    expect(renderViewportV1Schema.safeParse({ heightPx: 4_096, widthPx: 8_193 }).success).toBe(false);
    expect(renderViewportV1Schema.safeParse({ heightPx: 0, widthPx: 1_920 }).success).toBe(false);
    expect(renderViewportV1Schema.safeParse({ heightPx: 1_080, widthPx: 1_920.5 }).success).toBe(false);
  });
});
