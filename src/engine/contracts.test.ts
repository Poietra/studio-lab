import { describe, expect, it } from "vitest";

import {
  type AssetManifestV1,
  assetManifestV1Schema,
  countLoweredSceneGeometrySegmentsV1,
  digestAssetManifestV1,
  parseVerifiedSceneIrBundleV1,
  renderViewportV1Schema,
  type SceneIrV1,
  sceneEvaluationSampleTimeV1,
  sceneIrBundleV1Schema,
  sceneIrV1Schema,
  sceneSourceRenderCompositingV1,
  sceneSourceV1Schema,
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

describe("Poietra Engine v1 contracts", () => {
  it("admits Runtime Trace V2/V3 whole-frame durations without widening the sealed V1 grid", async () => {
    const assets = await manifest();
    const base = scene(assets);
    const source = {
      kind: "imported-manim-runtime-trace" as const,
      runtimeConfigHash: ZERO_HASH,
      sourceHash: SCENE_HASH,
      traceDigest: ASSET_HASH,
      traceVersion: 1 as const,
    };

    expect(sceneSourceV1Schema.parse(source)).toEqual(source);
    expect(sceneSourceV1Schema.parse({ ...source, traceVersion: 2 })).toEqual({ ...source, traceVersion: 2 });
    expect(sceneSourceV1Schema.parse({ ...source, traceVersion: 3 })).toEqual({ ...source, traceVersion: 3 });
    for (const unsupported of [0, 1.5, 4]) {
      expect(sceneSourceV1Schema.safeParse({ ...source, traceVersion: unsupported }).success).toBe(false);
    }

    expect(sceneIrV1Schema.safeParse({ ...base, duration: 3, source }).success).toBe(false);
    const v2 = sceneIrV1Schema.parse({ ...base, duration: 3, source: { ...source, traceVersion: 2 } });
    expect(sceneEvaluationSampleTimeV1(v2, 0)).toBe(0);
    expect(sceneEvaluationSampleTimeV1(v2, 1 / 60 + 1e-9)).toBe(1 / 60);
    expect(sceneEvaluationSampleTimeV1(v2, 3)).toBe(179 / 60);
    expect(sceneIrV1Schema.safeParse({ ...v2, duration: 3.01 }).success).toBe(false);
    const v3 = sceneIrV1Schema.parse({ ...base, duration: 3, source: { ...source, traceVersion: 3 } });
    expect(sceneEvaluationSampleTimeV1(v3, 3)).toBe(179 / 60);

    const v1 = sceneIrV1Schema.parse({ ...base, duration: 6, source });
    expect(sceneEvaluationSampleTimeV1(v1, 6)).toBe(359 / 60);
  });

  it("admits one Runtime Trace V3 path sample per bounded frame", async () => {
    const assets = await manifest();
    const base = scene(assets);
    const keyframes = Array.from({ length: 900 }, (_, frameIndex) => ({
      at: frameIndex / 60,
      easingToNext: frameIndex === 899 ? null : ({ kind: "linear" } as const),
      value: path,
    }));
    const source = {
      kind: "imported-manim-runtime-trace" as const,
      runtimeConfigHash: ZERO_HASH,
      sourceHash: SCENE_HASH,
      traceDigest: ASSET_HASH,
      traceVersion: 3 as const,
    };
    const morph = {
      ...base,
      animationChannels: [
        {
          entityId: "curve",
          id: "curve-runtime-morph",
          keyframes,
          kind: "path-morph" as const,
          provenanceId: "fixture",
        },
      ],
      duration: 15,
      entities: [{ ...base.entities[1]!, lifetimes: [{ end: 15, start: 0 }], sceneOrder: 0 }],
      requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"] as const,
      source,
    };
    expect(sceneIrV1Schema.safeParse(morph).success).toBe(true);
    expect(sceneIrV1Schema.safeParse({ ...morph, source: { ...source, traceVersion: 2 } }).success).toBe(false);
    expect(
      sceneIrV1Schema.safeParse({
        ...morph,
        animationChannels: [
          {
            ...morph.animationChannels[0],
            keyframes: [
              ...keyframes.map((keyframe, index) =>
                index === 899 ? { ...keyframe, easingToNext: { kind: "linear" } as const } : keyframe,
              ),
              { at: 15, easingToNext: null, value: path },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("round-trips imported snapshot profiles V6 through V12 without coercing the negotiated integer union", () => {
    const source = {
      kind: "imported-manim-server-snapshot" as const,
      runtimeConfigHash: ZERO_HASH,
      snapshotHash: ASSET_HASH,
      snapshotVersion: 7 as const,
      sourceHash: SCENE_HASH,
    };
    expect(sceneSourceV1Schema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
    expect(sceneSourceV1Schema.parse({ ...source, snapshotVersion: 6 })).toEqual({ ...source, snapshotVersion: 6 });
    expect(sceneSourceV1Schema.parse({ ...source, snapshotVersion: 8 })).toEqual({ ...source, snapshotVersion: 8 });
    expect(sceneSourceV1Schema.parse({ ...source, snapshotVersion: 9 })).toEqual({ ...source, snapshotVersion: 9 });
    expect(sceneSourceV1Schema.parse({ ...source, snapshotVersion: 10 })).toEqual({ ...source, snapshotVersion: 10 });
    expect(sceneSourceV1Schema.parse({ ...source, snapshotVersion: 11 })).toEqual({ ...source, snapshotVersion: 11 });
    expect(sceneSourceV1Schema.parse({ ...source, snapshotVersion: 12 })).toEqual({ ...source, snapshotVersion: 12 });
    expect(sceneSourceRenderCompositingV1({ ...source, snapshotVersion: 7 })).toBe("linear-light");
    expect(sceneSourceRenderCompositingV1({ ...source, snapshotVersion: 8 })).toBe("manim-cairo-srgb");
    expect(sceneSourceRenderCompositingV1({ ...source, snapshotVersion: 9 })).toBe("linear-light");
    expect(sceneSourceRenderCompositingV1({ ...source, snapshotVersion: 10 })).toBe("linear-light");
    expect(sceneSourceRenderCompositingV1({ ...source, snapshotVersion: 11 })).toBe("manim-cairo-srgb");
    expect(sceneSourceRenderCompositingV1({ ...source, snapshotVersion: 12 })).toBe("manim-cairo-srgb");
    for (const unsupported of [0, 2.5, 13]) {
      expect(sceneSourceV1Schema.safeParse({ ...source, snapshotVersion: unsupported }).success).toBe(false);
    }
  });

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

  it("accepts the parameter-free Manim smooth easing tag", async () => {
    const assets = await manifest();
    const validScene = scene(assets);
    const candidate = {
      ...validScene,
      animationChannels: validScene.animationChannels.map((channel) => ({
        ...channel,
        keyframes: channel.keyframes.map((keyframe, index) =>
          index === 0 ? { ...keyframe, easingToNext: { kind: "manim-smooth" } } : keyframe,
        ),
      })),
    };

    expect(sceneIrV1Schema.safeParse(candidate).success).toBe(true);
    expect(
      sceneIrV1Schema.safeParse({
        ...candidate,
        animationChannels: candidate.animationChannels.map((channel) => ({
          ...channel,
          keyframes: channel.keyframes.map((keyframe, index) =>
            index === 0 ? { ...keyframe, easingToNext: { inflection: 10, kind: "manim-smooth" } } : keyframe,
          ),
        })),
      }).success,
    ).toBe(false);
  });

  it("keeps path-trim parameterization optional and rejects unknown modes", async () => {
    const assets = await manifest();
    const validScene = scene(assets);
    const trimChannel = {
      entityId: "curve",
      id: "curve-trim",
      keyframes: [
        { at: 0, easingToNext: { kind: "linear" }, value: 0 },
        { at: 1, easingToNext: null, value: 1 },
      ],
      kind: "path-trim",
      provenanceId: "fixture",
    } as const;
    const withTrim = {
      ...validScene,
      animationChannels: [...validScene.animationChannels, trimChannel],
      requiredCapabilities: [...validScene.requiredCapabilities, "path-trim-animation"].sort(),
    };
    const omitted = sceneIrV1Schema.parse(withTrim);
    expect(omitted.animationChannels.at(-1)).not.toHaveProperty("parameterization");

    const explicit = sceneIrV1Schema.parse({
      ...withTrim,
      animationChannels: [
        ...validScene.animationChannels,
        { ...trimChannel, parameterization: "uniform-cubic-parameter-v1" },
      ],
    });
    expect(explicit.animationChannels.at(-1)).toMatchObject({ parameterization: "uniform-cubic-parameter-v1" });
    expect(
      sceneIrV1Schema.safeParse({
        ...withTrim,
        animationChannels: [...validScene.animationChannels, { ...trimChannel, parameterization: "future-mode" }],
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
