import { describe, expect, it } from "vitest";

import { type AssetManifestV1, assetManifestV1Schema, digestAssetManifestV1 } from "./asset-manifest";
import { compileEngineFrameV1 } from "./reference-evaluator";
import { type SceneIrV1, sceneIrV1Schema } from "./scene-ir";

const ZERO_HASH = "0".repeat(64);
const SCENE_HASH = "a".repeat(64);
const identity = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 };
const white = { alpha: 1, blue: 1, green: 1, red: 1 };

async function emptyManifest(): Promise<AssetManifestV1> {
  const draft = assetManifestV1Schema.parse({
    assets: [],
    manifestDigest: ZERO_HASH,
    manifestId: "empty",
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
}

async function pngManifest(): Promise<AssetManifestV1> {
  const draft = assetManifestV1Schema.parse({
    assets: [
      {
        alphaMode: "straight",
        byteLength: 68,
        colorSpace: "srgb",
        id: "pixel",
        kind: "png-image",
        mediaType: "image/png",
        pixelHeight: 1,
        pixelWidth: 1,
        sha256: ZERO_HASH,
      },
    ],
    manifestDigest: ZERO_HASH,
    manifestId: "one-png",
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
}

function vectorEntity(
  id: string,
  sceneOrder: number,
  geometry: unknown,
  options: Readonly<{
    opacity?: number;
    parentId?: string | null;
    sourceZIndex?: number;
    transform?: typeof identity;
  }> = {},
) {
  return {
    appearance: {
      fill: { color: white, rule: "nonzero" },
      kind: "vector",
      opacity: options.opacity ?? 1,
      stroke: null,
    },
    geometry,
    id,
    lifetimes: [{ end: 2, start: 0 }],
    parentId: options.parentId ?? null,
    provenanceId: "fixture",
    sceneOrder,
    sourceZIndex: options.sourceZIndex ?? 0,
    transform: options.transform ?? identity,
  };
}

function groupEntity(
  id: string,
  sceneOrder: number,
  options: Readonly<{ opacity?: number; parentId?: string | null; transform?: typeof identity }> = {},
) {
  return {
    appearance: { kind: "group", opacity: options.opacity ?? 1 },
    geometry: { kind: "group" },
    id,
    lifetimes: [{ end: 2, start: 0 }],
    parentId: options.parentId ?? null,
    provenanceId: "fixture",
    sceneOrder,
    sourceZIndex: 0,
    transform: options.transform ?? identity,
  };
}

function createScene(
  assets: AssetManifestV1,
  options: Readonly<{
    animationChannels?: readonly unknown[];
    entities: readonly unknown[];
    requiredCapabilities: readonly string[];
  }>,
): SceneIrV1 {
  return sceneIrV1Schema.parse({
    animationChannels: options.animationChannels ?? [],
    assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
    camera: {
      background: { alpha: 1, blue: 0, green: 0, red: 0 },
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
    entities: options.entities,
    fidelity: { kind: "exact" },
    provenance: [{ evidence: ["reference evaluator fixture"], id: "fixture", origin: "fixture" }],
    requiredCapabilities: options.requiredCapabilities,
    sceneId: "reference-scene",
    schema: "poietra.scene-ir",
    source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: SCENE_HASH },
    version: 1,
  });
}

async function compile(scene: SceneIrV1, assets: AssetManifestV1, sampleTime: number) {
  const result = await compileEngineFrameV1({
    assets,
    packetId: `sample-${String(sampleTime).replace(".", "-")}`,
    sampleTime,
    scene,
    viewport: { heightPx: 1_080, widthPx: 1_920 },
  });
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error(result.message);
  return result.frame;
}

describe("Poietra TypeScript reference evaluator v1", () => {
  it("emits explicit Cairo compositing for sealed Manim snapshot and Runtime Trace sources", async () => {
    const assets = await emptyManifest();
    const base = createScene(assets, { entities: [], requiredCapabilities: [] });
    const importedSource = {
      kind: "imported-manim-server-snapshot" as const,
      runtimeConfigHash: SCENE_HASH,
      snapshotHash: SCENE_HASH,
      snapshotVersion: 11 as const,
      sourceHash: SCENE_HASH,
    };
    const v8 = await compile({ ...base, source: { ...importedSource, snapshotVersion: 8 as const } }, assets, 0.5);
    expect(v8.packet.compositing).toBe("manim-cairo-srgb");

    const v11 = await compile({ ...base, source: importedSource }, assets, 0.5);
    expect(v11.packet.compositing).toBe("manim-cairo-srgb");

    const v12 = await compile({ ...base, source: { ...importedSource, snapshotVersion: 12 as const } }, assets, 0.5);
    expect(v12.packet.compositing).toBe("manim-cairo-srgb");

    const runtimeTrace = await compile(
      {
        ...base,
        duration: 6,
        source: {
          kind: "imported-manim-runtime-trace",
          runtimeConfigHash: SCENE_HASH,
          sourceHash: SCENE_HASH,
          traceDigest: ZERO_HASH,
          traceVersion: 1,
        },
      },
      assets,
      0.5,
    );
    expect(runtimeTrace.packet.compositing).toBe("manim-cairo-srgb");
    expect(runtimeTrace.packet.sceneRevisionHash).toBe(ZERO_HASH);

    const v10 = await compile({ ...base, source: { ...importedSource, snapshotVersion: 10 as const } }, assets, 0.5);
    expect("compositing" in v10.packet).toBe(false);
  });

  it("keeps sealed imported terminal holds present at their exact endpoint", async () => {
    const assets = await emptyManifest();
    const base = createScene(assets, {
      entities: [vectorEntity("held-write", 0, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 })],
      requiredCapabilities: ["shape-primitives"],
    });
    const importedSource = {
      kind: "imported-manim-server-snapshot" as const,
      runtimeConfigHash: SCENE_HASH,
      snapshotHash: SCENE_HASH,
      snapshotVersion: 12 as const,
      sourceHash: SCENE_HASH,
    };

    const endpoint = await compile({ ...base, source: importedSource }, assets, 2);
    expect(endpoint.packet.sampleTime).toBe(2);
    expect(endpoint.packet.draws).toHaveLength(1);

    const ordinaryHalfOpenEndpoint = await compile(
      { ...base, source: { ...importedSource, snapshotVersion: 11 as const } },
      assets,
      2,
    );
    expect(ordinaryHalfOpenEndpoint.packet.draws).toEqual([]);

    const runtimeTraceEndpoint = await compile(
      {
        ...base,
        duration: 6,
        entities: base.entities.map((entity) => ({ ...entity, lifetimes: [{ end: 6, start: 0 }] })),
        source: {
          kind: "imported-manim-runtime-trace",
          runtimeConfigHash: SCENE_HASH,
          sourceHash: SCENE_HASH,
          traceDigest: ZERO_HASH,
          traceVersion: 1,
        },
      },
      assets,
      6,
    );
    expect(runtimeTraceEndpoint.packet.draws).toHaveLength(1);
  });

  it("lowers shape primitives to cubic RenderPacket draws in source order", async () => {
    const assets = await emptyManifest();
    const scene = createScene(assets, {
      entities: [
        vectorEntity("circle", 0, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 }),
        vectorEntity("rectangle", 1, {
          center: { x: 0, y: 0 },
          cornerRadius: 0,
          height: 2,
          kind: "rectangle",
          width: 3,
        }),
        {
          ...vectorEntity("line", 2, { end: { x: 2, y: 0 }, kind: "line", start: { x: 0, y: 0 } }),
          appearance: {
            fill: null,
            kind: "vector",
            opacity: 1,
            stroke: { cap: "butt", color: white, join: "miter", miterLimit: 4, widthWorld: 0.05 },
          },
        },
      ],
      requiredCapabilities: ["shape-primitives"],
    });
    const frame = await compile(scene, assets, 0.5);
    expect(frame.packet.draws.map((draw) => draw.entityId)).toEqual(["circle", "rectangle", "line"]);
    expect(
      frame.packet.draws.map((draw) => (draw.kind === "path" ? draw.path.subpaths[0].segments.length : 0)),
    ).toEqual([4, 4, 1]);
  });

  it("samples smooth opacity without dropping the active draw", async () => {
    const assets = await emptyManifest();
    const scene = createScene(assets, {
      animationChannels: [
        {
          entityId: "circle",
          id: "fade",
          keyframes: [
            { at: 0, easingToNext: { kind: "smooth" }, value: 0 },
            { at: 1, easingToNext: null, value: 1 },
          ],
          kind: "opacity",
          provenanceId: "fixture",
        },
      ],
      entities: [vectorEntity("circle", 0, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 })],
      requiredCapabilities: ["opacity-animation", "shape-primitives"],
    });
    const frame = await compile(scene, assets, 0.25);
    expect(frame.packet.draws).toHaveLength(1);
    expect(frame.packet.draws[0].opacity).toBe(0.15625);
  });

  it("samples Manim default smooth opacity without changing smoothstep semantics", async () => {
    const assets = await emptyManifest();
    const scene = createScene(assets, {
      animationChannels: [
        {
          entityId: "circle",
          id: "fade",
          keyframes: [
            { at: 0, easingToNext: { kind: "manim-smooth" }, value: 0 },
            { at: 1, easingToNext: null, value: 1 },
          ],
          kind: "opacity",
          provenanceId: "fixture",
        },
      ],
      entities: [vectorEntity("circle", 0, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 })],
      requiredCapabilities: ["opacity-animation", "shape-primitives"],
    });
    const frame = await compile(scene, assets, 0.25);
    expect(frame.packet.draws).toHaveLength(1);
    expect(frame.packet.draws[0].opacity).toBeCloseTo(0.07010371654510815, 15);
  });

  it("lowers a sampled singular affine midpoint without dropping sibling draws", async () => {
    const assets = await emptyManifest();
    const scene = createScene(assets, {
      animationChannels: [
        {
          entityId: "circle",
          id: "reflect",
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: identity },
            { at: 1, easingToNext: null, value: { ...identity, m11: -1 } },
          ],
          kind: "affine-transform",
          provenanceId: "fixture",
        },
      ],
      entities: [
        vectorEntity("circle", 0, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 }),
        vectorEntity("sibling", 1, { center: { x: 2, y: 0 }, kind: "circle", radius: 0.5 }),
        vectorEntity("inherited", 2, { center: { x: -2, y: 0 }, kind: "circle", radius: 0.5 }, { parentId: "circle" }),
      ],
      requiredCapabilities: ["affine-transform-animation", "shape-primitives"],
    });

    const identityFrame = await compile(scene, assets, 0);
    const singularFrame = await compile(scene, assets, 0.5);
    const reflectedFrame = await compile(scene, assets, 1);
    const singularRepeat = await compile(scene, assets, 0.5);
    const identityRepeat = await compile(scene, assets, 0);

    expect(identityFrame.packet.draws[0].kind).toBe("path");
    expect(singularFrame.packet.draws[0]).toMatchObject({
      entityId: "circle",
      kind: "empty",
      reason: "singular-affine-sample",
      transform: { m11: 0 },
    });
    expect(singularFrame.packet.draws[1]).toMatchObject({ entityId: "sibling", kind: "path" });
    expect(singularFrame.packet.draws[2]).toMatchObject({ entityId: "inherited", kind: "path" });
    expect(reflectedFrame.packet.draws[0]).toMatchObject({ kind: "path", transform: { m11: -1 } });
    expect(singularRepeat.packet.draws).toEqual(singularFrame.packet.draws);
    expect(identityRepeat.packet.draws).toEqual(identityFrame.packet.draws);
  });

  it("lowers a near-singular affine sample that would collapse in f32 preparation", async () => {
    // The production snapshot profile seals every finite, bounded, non-zero
    // matrix, so `stretch(1e-50, 1)` arrives verified. Its f64 determinant is
    // non-zero, but the entry rounds to zero in the renderer's f32 geometry
    // and preparation fails the complete frame. Lowering it draw-locally is
    // the deterministic policy; siblings stay visible.
    const assets = await emptyManifest();
    const nearSingular = { ...identity, m11: 1e-50 };
    const scene = createScene(assets, {
      animationChannels: [
        {
          entityId: "circle",
          id: "collapse",
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: nearSingular },
            { at: 1, easingToNext: null, value: nearSingular },
          ],
          kind: "affine-transform",
          provenanceId: "fixture",
        },
      ],
      entities: [
        vectorEntity("circle", 0, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 }),
        vectorEntity("sibling", 1, { center: { x: 2, y: 0 }, kind: "circle", radius: 0.5 }),
      ],
      requiredCapabilities: ["affine-transform-animation", "shape-primitives"],
    });

    const frame = await compile(scene, assets, 0.5);
    expect(frame.packet.draws[0]).toMatchObject({
      entityId: "circle",
      kind: "empty",
      reason: "singular-affine-sample",
    });
    expect(frame.packet.draws[1]).toMatchObject({ entityId: "sibling", kind: "path" });
  });

  it("keeps small-but-renderable scales drawn and is stable under non-monotonic seeks", async () => {
    // The threshold is the smallest normal f32 determinant, so an ordinary
    // small scale stays a path. Seeking backwards and forwards across the
    // boundary must produce the same draws every time it lands on the same
    // time, or a retained-frame consumer would see the boundary flicker.
    const assets = await emptyManifest();
    const renderable = { ...identity, m11: 1e-3, m22: 1e-3 };
    const collapsing = { ...identity, m11: 1e-45, m22: 1e-45 };
    const scene = createScene(assets, {
      animationChannels: [
        {
          entityId: "circle",
          id: "shrink",
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: renderable },
            { at: 1, easingToNext: null, value: collapsing },
          ],
          kind: "affine-transform",
          provenanceId: "fixture",
        },
      ],
      entities: [vectorEntity("circle", 0, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 })],
      requiredCapabilities: ["affine-transform-animation", "shape-primitives"],
    });

    const seekOrder = [0, 1, 0.5, 0, 1, 0.5, 1, 0];
    const byTime = new Map<number, unknown>();
    for (const time of seekOrder) {
      const draws = (await compile(scene, assets, time)).packet.draws;
      const previous = byTime.get(time);
      if (previous === undefined) byTime.set(time, draws);
      else expect(draws).toEqual(previous);
    }

    expect((await compile(scene, assets, 0)).packet.draws[0].kind).toBe("path");
    expect((await compile(scene, assets, 1)).packet.draws[0]).toMatchObject({
      kind: "empty",
      reason: "singular-affine-sample",
    });
  });

  it("composes hierarchy transforms and opacity from root to leaf", async () => {
    const assets = await emptyManifest();
    const scene = createScene(assets, {
      entities: [
        vectorEntity(
          "parent",
          0,
          { center: { x: 0, y: 0 }, cornerRadius: 0, height: 1, kind: "rectangle", width: 1 },
          { opacity: 0.5, transform: { ...identity, tx: 10, ty: 5 } },
        ),
        vectorEntity(
          "child",
          1,
          { center: { x: 0, y: 0 }, kind: "circle", radius: 1 },
          {
            opacity: 0.5,
            parentId: "parent",
            transform: { ...identity, tx: 2, ty: 3 },
          },
        ),
      ],
      requiredCapabilities: ["shape-primitives"],
    });
    const frame = await compile(scene, assets, 0.5);
    const child = frame.packet.draws.find((draw) => draw.entityId === "child");
    expect(child?.opacity).toBe(0.25);
    expect(child?.transform).toMatchObject({ tx: 12, ty: 8 });
  });

  it("uses a logical group for hierarchy state without emitting a draw", async () => {
    const assets = await emptyManifest();
    const scene = createScene(assets, {
      entities: [
        groupEntity("group", 0, { opacity: 0.5, transform: { ...identity, tx: 10, ty: 5 } }),
        vectorEntity(
          "child",
          1,
          { center: { x: 0, y: 0 }, kind: "circle", radius: 1 },
          { opacity: 0.5, parentId: "group", transform: { ...identity, tx: 2, ty: 3 } },
        ),
      ],
      requiredCapabilities: ["logical-group", "shape-primitives"],
    });

    const frame = await compile(scene, assets, 0.5);

    expect(frame.packet.draws).toHaveLength(1);
    expect(frame.packet.draws[0]).toMatchObject({
      entityId: "child",
      opacity: 0.25,
      paintOrder: 0,
      transform: { tx: 12, ty: 8 },
    });

    expect(
      sceneIrV1Schema.safeParse({
        ...scene,
        animationChannels: [
          {
            entityId: "group",
            id: "invalid-group-trim",
            keyframes: [
              { at: 0, easingToNext: { kind: "linear" }, value: 0 },
              { at: 1, easingToNext: null, value: 1 },
            ],
            kind: "path-trim",
            provenanceId: "fixture",
          },
        ],
        requiredCapabilities: ["logical-group", "path-trim-animation", "shape-primitives"],
      }).success,
    ).toBe(false);
  });

  it("fails closed when finite hierarchy inputs overflow during affine composition", async () => {
    const assets = await emptyManifest();
    const scene = createScene(assets, {
      entities: [
        vectorEntity(
          "parent",
          0,
          { center: { x: 0, y: 0 }, kind: "circle", radius: 1 },
          { transform: { ...identity, m11: Number.MAX_VALUE } },
        ),
        vectorEntity(
          "child",
          1,
          { center: { x: 0, y: 0 }, kind: "circle", radius: 1 },
          { parentId: "parent", transform: { ...identity, m11: 2 } },
        ),
      ],
      requiredCapabilities: ["shape-primitives"],
    });

    await expect(
      compileEngineFrameV1({
        assets,
        packetId: "overflowed-hierarchy",
        sampleTime: 0.5,
        scene,
        viewport: { heightPx: 1_080, widthPx: 1_920 },
      }),
    ).resolves.toMatchObject({ code: "invalid-output", kind: "error" });
  });

  it("sorts draws by source z-index and scene order, then preserves image evidence", async () => {
    const assets = await pngManifest();
    const scene = createScene(assets, {
      entities: [
        vectorEntity("front", 2, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 }, { sourceZIndex: 1 }),
        {
          appearance: { kind: "image", opacity: 0.75 },
          geometry: {
            asset: { assetId: "pixel", sha256: ZERO_HASH },
            kind: "image",
            localRect: { bottom: -1, left: -1, right: 1, top: 1 },
            sampler: "nearest",
          },
          id: "image",
          lifetimes: [{ end: 2, start: 0 }],
          parentId: null,
          provenanceId: "fixture",
          sceneOrder: 1,
          sourceZIndex: 0,
          transform: identity,
        },
        vectorEntity("back", 0, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 }),
      ],
      requiredCapabilities: ["png-image", "shape-primitives"],
    });
    const frame = await compile(scene, assets, 0.5);
    expect(frame.packet.draws.map((draw) => draw.entityId)).toEqual(["back", "image", "front"]);
    expect(frame.packet.requiredCapabilities).toEqual(["cubic-path-fill", "png-image"]);
    expect(frame.packet.draws[1]).toMatchObject({
      asset: { assetId: "pixel", sha256: ZERO_HASH },
      kind: "image",
      opacity: 0.75,
      paintOrder: 1,
      sampler: "nearest",
    });
  });

  it("samples path trim and motion path by deterministic arc length", async () => {
    const assets = await emptyManifest();
    const straightPath = {
      subpaths: [
        {
          closed: false,
          segments: [{ control1: { x: 10 / 3, y: 0 }, control2: { x: 20 / 3, y: 0 }, end: { x: 10, y: 0 } }],
          start: { x: 0, y: 0 },
        },
      ],
    };
    const scene = createScene(assets, {
      animationChannels: [
        {
          entityId: "line",
          id: "create",
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: 0 },
            { at: 1, easingToNext: null, value: 1 },
          ],
          kind: "path-trim",
          provenanceId: "fixture",
        },
        {
          entityId: "mover",
          id: "move",
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: 0 },
            { at: 1, easingToNext: null, value: 1 },
          ],
          kind: "motion-path",
          orientToPath: false,
          path: straightPath,
          provenanceId: "fixture",
        },
      ],
      entities: [
        {
          ...vectorEntity("line", 0, { end: { x: 10, y: 0 }, kind: "line", start: { x: 0, y: 0 } }),
          appearance: {
            fill: null,
            kind: "vector",
            opacity: 1,
            stroke: { cap: "butt", color: white, join: "miter", miterLimit: 4, widthWorld: 0.05 },
          },
        },
        vectorEntity("mover", 1, { center: { x: 0, y: 0 }, kind: "circle", radius: 0.25 }),
      ],
      requiredCapabilities: ["motion-path-animation", "path-trim-animation", "shape-primitives"],
    });
    const emptyFrame = await compile(scene, assets, 0);
    expect(emptyFrame.packet.draws.find((draw) => draw.entityId === "line")).toMatchObject({
      kind: "empty",
      reason: "path-trim-zero",
    });
    expect(emptyFrame.packet.draws.find((draw) => draw.entityId === "mover")?.kind).toBe("path");

    const frame = await compile(scene, assets, 0.5);
    const line = frame.packet.draws.find((draw) => draw.entityId === "line");
    const mover = frame.packet.draws.find((draw) => draw.entityId === "mover");
    expect(line?.kind === "path" ? line.path.subpaths[0].segments[0].end.x : null).toBeCloseTo(5);
    expect(mover?.transform).toMatchObject({ tx: 5, ty: 0 });
  });

  it("samples uniform cubic path trim deterministically across non-monotonic seeks", async () => {
    const assets = await emptyManifest();
    const rectangle = {
      ...vectorEntity("rectangle", 0, {
        center: { x: 0, y: 0 },
        cornerRadius: 0,
        height: 2,
        kind: "rectangle",
        width: 4,
      }),
      appearance: {
        fill: null,
        kind: "vector",
        opacity: 1,
        stroke: { cap: "butt", color: white, join: "miter", miterLimit: 4, widthWorld: 0.05 },
      },
    };
    const scene = createScene(assets, {
      animationChannels: [
        {
          entityId: "rectangle",
          id: "create",
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: 0 },
            { at: 1, easingToNext: null, value: 1 },
          ],
          kind: "path-trim",
          parameterization: "uniform-cubic-parameter-v1",
          provenanceId: "fixture",
        },
      ],
      entities: [rectangle],
      requiredCapabilities: ["path-trim-animation", "shape-primitives"],
    });
    const endpointAt = async (time: number) => {
      const draw = (await compile(scene, assets, time)).packet.draws[0];
      return draw.kind === "path" ? draw.path.subpaths.at(-1)?.segments.at(-1)?.end : null;
    };
    const first = await endpointAt(0.25);
    expect(await endpointAt(0.5)).toEqual({ x: -2, y: 1 });
    expect(await endpointAt(0.25)).toEqual(first);
    expect(first).toEqual({ x: -2, y: -1 });
  });

  it("samples affine and topology-compatible path-morph channels without replacing the base early", async () => {
    const assets = await emptyManifest();
    const pathAt = (y: number) => ({
      subpaths: [
        {
          closed: false,
          segments: [{ control1: { x: 1, y }, control2: { x: 2, y }, end: { x: 3, y } }],
          start: { x: 0, y },
        },
      ],
    });
    const scene = createScene(assets, {
      animationChannels: [
        {
          entityId: "curve",
          id: "curve-transform",
          keyframes: [
            { at: 0.5, easingToNext: { kind: "linear" }, value: identity },
            { at: 1.5, easingToNext: null, value: { ...identity, tx: 4 } },
          ],
          kind: "affine-transform",
          provenanceId: "fixture",
        },
        {
          entityId: "curve",
          id: "curve-morph",
          keyframes: [
            { at: 0.5, easingToNext: { kind: "linear" }, value: pathAt(1) },
            { at: 1.5, easingToNext: null, value: pathAt(3) },
          ],
          kind: "path-morph",
          provenanceId: "fixture",
        },
      ],
      entities: [vectorEntity("curve", 0, { kind: "cubic-path", path: pathAt(0) })],
      requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "path-morph-animation"],
    });

    const before = await compile(scene, assets, 0.25);
    const midpoint = await compile(scene, assets, 1);
    const ended = await compile(scene, assets, 2);
    expect(before.packet.draws[0]).toMatchObject({ transform: { tx: 0 } });
    expect(before.packet.draws[0].kind === "path" ? before.packet.draws[0].path.subpaths[0].start.y : null).toBe(0);
    expect(midpoint.packet.draws[0]).toMatchObject({ transform: { tx: 2 } });
    expect(midpoint.packet.draws[0].kind === "path" ? midpoint.packet.draws[0].path.subpaths[0].start.y : null).toBe(2);
    expect(ended.packet.draws).toEqual([]);
  });

  it("samples camera channels into orthographic packet extents", async () => {
    const assets = await emptyManifest();
    const scene = createScene(assets, {
      animationChannels: [
        {
          id: "camera-pan",
          keyframes: [
            {
              at: 0,
              easingToNext: { kind: "linear" },
              value: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
            },
            {
              at: 1,
              easingToNext: null,
              value: { center: { x: 4, y: 2 }, frameHeight: 4.5, frameWidth: 8 },
            },
          ],
          kind: "camera",
          provenanceId: "fixture",
        },
      ],
      entities: [],
      requiredCapabilities: ["camera-animation"],
    });
    const frame = await compile(scene, assets, 0.5);
    expect(frame.packet.camera).toMatchObject({ bottom: -2.375, left: -4, right: 8, top: 4.375 });
  });

  it("does not sample or lower inactive entities", async () => {
    const assets = await emptyManifest();
    const point = { x: 3, y: 4 };
    const stationaryPath = {
      subpaths: [
        {
          closed: false,
          segments: [{ control1: point, control2: point, end: point }],
          start: point,
        },
      ],
    };
    const scene = createScene(assets, {
      animationChannels: [
        {
          entityId: "circle",
          id: "motion:circle",
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: 0 },
            { at: 2, easingToNext: null, value: 1 },
          ],
          kind: "motion-path",
          orientToPath: true,
          path: stationaryPath,
          provenanceId: "fixture",
        },
      ],
      entities: [
        {
          ...vectorEntity("circle", 0, { center: { x: 0, y: 0 }, kind: "circle", radius: 1 }),
          lifetimes: [{ end: 2, start: 1 }],
        },
      ],
      requiredCapabilities: ["motion-path-animation", "shape-primitives"],
    });

    const frame = await compile(scene, assets, 0.5);
    expect(frame.packet.draws).toEqual([]);
  });

  it("returns a fail-closed error for invalid time or viewport evidence", async () => {
    const assets = await emptyManifest();
    const scene = createScene(assets, { entities: [], requiredCapabilities: [] });
    const invalidTime = await compileEngineFrameV1({
      assets,
      packetId: "invalid-time",
      sampleTime: 3,
      scene,
      viewport: { heightPx: 1_080, widthPx: 1_920 },
    });
    const invalidAspect = await compileEngineFrameV1({
      assets,
      packetId: "invalid-aspect",
      sampleTime: 1,
      scene,
      viewport: { heightPx: 1_000, widthPx: 1_000 },
    });
    expect(invalidTime).toMatchObject({ code: "invalid-input", kind: "error" });
    expect(invalidAspect).toMatchObject({ code: "invalid-output", kind: "error" });
  });
});
