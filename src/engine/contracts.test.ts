import { describe, expect, it } from "vitest";

import {
  type AssetManifestV1,
  assetManifestV1Schema,
  countLoweredSceneGeometrySegmentsV1,
  digestAssetManifestV1,
  engineFrameV1Schema,
  parseVerifiedEngineFrameV1,
  parseVerifiedSceneIrBundleV1,
  renderPacketV1Schema,
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
    version: 1,
  });
}

function packet(sceneIr: SceneIrV1, assets: AssetManifestV1) {
  return {
    assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
    camera: {
      bottom: -4.5,
      clearColor: { ...white, blue: 0, green: 0, red: 0 },
      kind: "orthographic-2d",
      left: -8,
      right: 8,
      top: 4.5,
    },
    coordinateSpace: {
      cpuPrecision: "f64",
      kind: "cartesian-2d",
      origin: "center",
      unit: "scene-unit",
      xAxis: "right",
      yAxis: "up",
    },
    draws: [
      {
        drawId: "circle-fill",
        entityId: "circle",
        fill: { color: white, rule: "nonzero" },
        kind: "path",
        opacity: 1,
        paintOrder: 0,
        path,
        sourceZIndex: 0,
        stroke: null,
        transform: identity,
      },
      {
        drawId: "curve-stroke",
        entityId: "curve",
        fill: null,
        kind: "path",
        opacity: 1,
        paintOrder: 1,
        path,
        sourceZIndex: 0,
        stroke: { cap: "round", color: white, join: "round", miterLimit: 4, widthWorld: 0.05 },
        transform: identity,
      },
      {
        asset: { assetId: "image-asset", sha256: ASSET_HASH },
        drawId: "image",
        entityId: "image",
        kind: "image",
        localRect: { bottom: -1, left: -1.5, right: 1.5, top: 1 },
        opacity: 0.75,
        paintOrder: 2,
        sampler: "linear",
        sourceZIndex: 1,
        transform: identity,
      },
    ],
    evidence: ["sampled from Scene IR v1"],
    packetId: "scene@1",
    requiredCapabilities: ["cubic-path-fill", "cubic-path-stroke", "png-image"],
    sampleTime: 1,
    sceneContractVersion: 1,
    sceneDuration: sceneIr.duration,
    sceneId: sceneIr.sceneId,
    sceneRevisionHash: SCENE_HASH,
    schema: "poietra.render-packet",
    version: 1,
    viewport: { heightPx: 1_080, widthPx: 1_920 },
  };
}

describe("Poietra Engine v1 contracts", () => {
  it("accepts and integrity-checks a complete Scene IR to RenderPacket frame", async () => {
    const assets = await manifest();
    const sceneIr = scene(assets);
    const renderPacket = packet(sceneIr, assets);
    const frame = { assets, packet: renderPacket, scene: sceneIr };

    expect(sceneIrBundleV1Schema.safeParse({ assets, scene: sceneIr }).success).toBe(true);
    expect(renderPacketV1Schema.safeParse(renderPacket).success).toBe(true);
    expect(engineFrameV1Schema.safeParse(frame).success).toBe(true);
    await expect(parseVerifiedEngineFrameV1(frame)).resolves.toEqual(frame);
  });

  it("round-trips every contract through JSON without coercion", async () => {
    const assets = await manifest();
    const frame = { assets, packet: packet(scene(assets), assets), scene: scene(assets) };
    expect(await parseVerifiedEngineFrameV1(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
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

  it("preserves imported source identities without relaxing asset IDs", async () => {
    const assets = await manifest();
    const validScene = scene(assets);
    const importedEntityId = "source:scene.py#Scene:circle";
    expect(
      sceneIrV1Schema.safeParse({
        ...validScene,
        animationChannels: validScene.animationChannels.map((channel) =>
          channel.kind === "camera" || channel.entityId !== "circle"
            ? channel
            : { ...channel, entityId: importedEntityId },
        ),
        entities: validScene.entities.map((entity) =>
          entity.id === "circle" ? { ...entity, id: importedEntityId } : entity,
        ),
        sceneId: "scene.py#Scene",
      }).success,
    ).toBe(true);
    expect(
      assetManifestV1Schema.safeParse({
        ...assets,
        assets: assets.assets.map((asset) => ({ ...asset, id: "image#asset" })),
      }).success,
    ).toBe(false);
  });

  it("derives an exact, closed Scene capability set", async () => {
    const assets = await manifest();
    const validScene = scene(assets);
    expect(sceneIrV1Schema.safeParse({ ...validScene, requiredCapabilities: ["future-feature"] }).success).toBe(false);
    expect(
      sceneIrV1Schema.safeParse({
        ...validScene,
        requiredCapabilities: validScene.requiredCapabilities.filter((capability) => capability !== "png-image"),
      }).success,
    ).toBe(false);
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

  it("rejects fill semantics that path-trim v1 cannot represent truthfully", async () => {
    const assets = await manifest();
    const validScene = scene(assets);
    const trimChannel = {
      entityId: "circle",
      id: "circle-trim",
      keyframes: [
        { at: 0, easingToNext: { kind: "linear" }, value: 0 },
        { at: 1, easingToNext: null, value: 1 },
      ],
      kind: "path-trim",
      provenanceId: "fixture",
    } as const;
    const result = sceneIrV1Schema.safeParse({
      ...validScene,
      animationChannels: [...validScene.animationChannels, trimChannel],
      requiredCapabilities: [...validScene.requiredCapabilities, "path-trim-animation"].sort(),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => /stroke-only/.test(issue.message))).toBe(true);
  });

  it("requires resolved provenance, lifetime, hierarchy, and keyframe invariants", async () => {
    const assets = await manifest();
    const validScene = scene(assets);
    expect(
      sceneIrV1Schema.safeParse({
        ...validScene,
        entities: validScene.entities.map((entity, index) => ({
          ...entity,
          parentId: index === 0 ? "image" : index === 2 ? "circle" : null,
        })),
      }).success,
    ).toBe(false);
    expect(
      sceneIrV1Schema.safeParse({
        ...validScene,
        animationChannels: validScene.animationChannels.map((channel) => ({
          ...channel,
          keyframes: channel.keyframes.map((keyframe) => ({ ...keyframe, at: 3 })),
        })),
      }).success,
    ).toBe(false);
    expect(
      sceneIrV1Schema.safeParse({
        ...validScene,
        animationChannels: [
          ...validScene.animationChannels,
          { ...validScene.animationChannels[0], id: "duplicate-opacity" },
        ],
      }).success,
    ).toBe(false);
    expect(
      sceneIrV1Schema.safeParse({
        ...validScene,
        animationChannels: validScene.animationChannels.map((channel) => ({
          ...channel,
          keyframes: channel.keyframes.map((keyframe, index) =>
            index === 0 ? { ...keyframe, easingToNext: null } : keyframe,
          ),
        })),
      }).success,
    ).toBe(false);
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
    expect(sceneIrBundleV1Schema.safeParse({ assets, scene: staleScene }).success).toBe(false);

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

  it("uses a single back-to-front paint order and exact renderer capabilities", async () => {
    const assets = await manifest();
    const validPacket = packet(scene(assets), assets);
    expect(
      renderPacketV1Schema.safeParse({
        ...validPacket,
        draws: [validPacket.draws[1], validPacket.draws[0], validPacket.draws[2]],
      }).success,
    ).toBe(false);
    expect(
      renderPacketV1Schema.safeParse({ ...validPacket, requiredCapabilities: ["cubic-path-fill", "png-image"] })
        .success,
    ).toBe(false);
    expect(
      renderPacketV1Schema.safeParse({
        ...validPacket,
        draws: [{ ...validPacket.draws[0], fill: null, stroke: null }, ...validPacket.draws.slice(1)],
      }).success,
    ).toBe(false);
  });

  it("binds packets to the exact Scene, revision, entities, and lifetimes", async () => {
    const assets = await manifest();
    const sceneIr = scene(assets);
    const validPacket = packet(sceneIr, assets);
    expect(
      engineFrameV1Schema.safeParse({ assets, packet: { ...validPacket, sceneId: "other" }, scene: sceneIr }).success,
    ).toBe(false);
    expect(
      engineFrameV1Schema.safeParse({
        assets,
        packet: {
          ...validPacket,
          draws: [{ ...validPacket.draws[0], entityId: "missing" }, ...validPacket.draws.slice(1)],
        },
        scene: sceneIr,
      }).success,
    ).toBe(false);
    expect(
      engineFrameV1Schema.safeParse({ assets, packet: { ...validPacket, sampleTime: 2 }, scene: sceneIr }).success,
    ).toBe(false);
    expect(
      engineFrameV1Schema.safeParse({
        assets,
        packet: {
          ...validPacket,
          draws: validPacket.draws.slice(1).map((draw, index) => ({ ...draw, paintOrder: index })),
        },
        scene: sceneIr,
      }).success,
    ).toBe(false);
  });

  it("rejects non-finite time and non-matching viewport aspect ratios", async () => {
    const assets = await manifest();
    const validPacket = packet(scene(assets), assets);
    expect(renderPacketV1Schema.safeParse({ ...validPacket, sampleTime: Number.NaN }).success).toBe(false);
    expect(
      renderPacketV1Schema.safeParse({ ...validPacket, viewport: { heightPx: 1_000, widthPx: 1_000 } }).success,
    ).toBe(false);
  });
});
