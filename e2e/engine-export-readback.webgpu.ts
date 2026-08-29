import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import {
  type FragmentMaterialRegistryV1,
  STUDIO_TEXTURE_FRAGMENT_SOURCE_V1,
} from "../src/engine/fragment-material-registry";
import type { ScenePostEffectRegistryV1 } from "../src/engine/scene-post-effect-registry";

const VIEWPORT = { heightPx: 90, widthPx: 160 } as const;
const FPS = 2;
/** `ceil(duration 2 s * 2 fps)` uniform-grid frames at 0, 0.5, 1.0, 1.5 s. */
const EXPECTED_FRAME_COUNT = 4;
const FRAME_BYTES = VIEWPORT.widthPx * VIEWPORT.heightPx * 4;

const FRAGMENT_EXPORT_VIEWPORT = { heightPx: 480, widthPx: 854 } as const;
const FRAGMENT_READBACK_VIEWPORT = { heightPx: 90, widthPx: 160 } as const;
const FRAGMENT_EXPORT_FPS = 30;
const FRAGMENT_EXPORT_DURATION = 0.2;
const FRAGMENT_EXPORT_FRAME_COUNT = 6;
const FRAGMENT_EXPORT_SAMPLE_FRAMES = [0, 3] as const;
const IMPORTED_GLSL_SHADER_ID = "imported-glsl-parity";
const SCREEN_TEXTURE_SHADER_ID = "screen-texture-parity";
const IMPORTED_GLSL_SOURCE = `#version 450
layout(location = 0) in vec4 base_color;
layout(location = 1) in vec2 screen_position;
layout(location = 0) out vec4 output_color;
layout(set = 0, binding = 0, std140) uniform PoietraHost {
    vec4 viewport_and_time;
    vec4 parameters_0;
    vec4 parameters_1;
} host;

void main() {
    output_color = vec4(base_color.rgb * host.parameters_0.xyz, base_color.a);
}
`;

type ExportReadbackProof = Readonly<{
  frameCount: number;
  kind: string;
  rgba: readonly number[];
}>;

type BrowserAssetPayloadFixture = Readonly<{
  assetId: string;
  byteLength: number;
  encodedBytes: readonly number[];
  mediaType: "image/png";
  pixelHeight: number;
  pixelWidth: number;
  sha256: string;
}>;

type PreviewMp4PixelProof =
  | Readonly<{ decodedPixels: readonly (readonly number[])[]; kind: "decoded"; previewPixels: readonly number[][] }>
  | Readonly<{ kind: "refused"; message: string; reason: string }>;

function pixelAt(rgba: readonly number[], frame: number, x: number, y: number) {
  const offset = frame * FRAME_BYTES + (y * VIEWPORT.widthPx + x) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]] as const;
}

function pixelAtViewport(
  rgba: readonly number[],
  frame: number,
  x: number,
  y: number,
  viewport: Readonly<{ heightPx: number; widthPx: number }>,
) {
  const frameBytes = viewport.widthPx * viewport.heightPx * 4;
  const offset = frame * frameBytes + (y * viewport.widthPx + x) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]] as const;
}

function expectPixelClose(actual: readonly (number | undefined)[], expected: readonly number[], tolerance: number) {
  expected.forEach((component, index) => {
    expect(Math.abs((actual[index] ?? -1) - component)).toBeLessThanOrEqual(tolerance);
  });
}

function fragmentMaterialExportFixture(
  fixture: SceneIrBundleV1,
  fragmentMaterial: Readonly<{ parameters: readonly number[]; revision: number; shaderId: string }> = {
    parameters: [0, 3, 0, 0.2],
    revision: 1,
    shaderId: "time-gradient",
  },
): SceneIrBundleV1 {
  const material = fixture.scene.entities.find((entity) => entity.id === "earlier");
  if (!material?.appearance?.fill || material.geometry?.kind !== "circle") {
    throw new Error("The shared Scene fixture lost its editable filled circle.");
  }
  if (fixture.scene.source.kind !== "studio-edit-program") {
    throw new Error("The shared Scene fixture lost its authored revision source.");
  }
  return {
    assets: fixture.assets,
    scene: {
      ...fixture.scene,
      animationChannels: [],
      duration: FRAGMENT_EXPORT_DURATION,
      entities: [
        {
          ...material,
          appearance: {
            ...material.appearance,
            fill: {
              ...material.appearance.fill,
              color: { alpha: 1, blue: 1, green: 1, red: 1 },
              fragmentMaterial,
            },
          },
          geometry: { ...material.geometry, center: { x: 0, y: 0 }, radius: 3 },
          id: "time-gradient",
          lifetimes: [{ end: FRAGMENT_EXPORT_DURATION, start: 0 }],
        },
      ],
      requiredCapabilities: ["fragment-material", "shape-primitives"],
      sceneId: "fixture:fragment-material-export",
      source: { ...fixture.scene.source, revisionHash: "f".repeat(64) },
    },
  };
}

function screenTextureExportFixture(fixture: SceneIrBundleV1, assets: SceneIrBundleV1["assets"]): SceneIrBundleV1 {
  const base = fixture.scene.entities.find((entity) => entity.id === "earlier");
  const asset = assets.assets[0];
  if (!base?.appearance?.fill || base.geometry?.kind !== "circle" || !asset) {
    throw new Error("The Screen texture fixture lost its vector or PNG asset.");
  }
  if (fixture.scene.source.kind !== "studio-edit-program") {
    throw new Error("The Screen texture fixture lost its authored revision source.");
  }
  const entity = (
    id: string,
    center: Readonly<{ x: number; y: number }>,
    sampler: "linear" | "nearest",
    sceneOrder: number,
  ) => ({
    ...base,
    appearance: {
      ...base.appearance,
      fill: {
        ...base.appearance.fill,
        color: { alpha: 1, blue: 1, green: 1, red: 1 },
        fragmentMaterial: {
          parameters: [1, 1, 0, 0, 1],
          revision: 1,
          shaderId: SCREEN_TEXTURE_SHADER_ID,
          texture: {
            asset: { assetId: asset.id, sha256: asset.sha256 },
            sampler,
          },
        },
      },
    },
    geometry: { ...base.geometry, center, radius: 1 },
    id,
    lifetimes: [{ end: FRAGMENT_EXPORT_DURATION, start: 0 }],
    sceneOrder,
    sourceZIndex: sceneOrder,
  });
  return {
    assets,
    scene: {
      ...fixture.scene,
      animationChannels: [],
      assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
      duration: FRAGMENT_EXPORT_DURATION,
      entities: [
        entity("nearest-texture", { x: -0.8, y: 1.35 }, "nearest", 0),
        entity("linear-texture", { x: -0.8, y: -1.35 }, "linear", 1),
        entity("local-left", { x: -4, y: 0 }, "nearest", 2),
        entity("local-right", { x: 4, y: 0 }, "nearest", 3),
      ],
      requiredCapabilities: ["fragment-material", "png-image", "shape-primitives"],
      sceneId: "fixture:screen-texture-export",
      source: { ...fixture.scene.source, revisionHash: "e".repeat(64) },
    },
  };
}

async function renderExportReadback(
  page: Page,
  snapshot: SceneIrBundleV1,
  viewport: Readonly<{ heightPx: number; widthPx: number }>,
  fps: number,
): Promise<ExportReadbackProof> {
  return page.evaluate(
    async ({ fps, snapshot, viewport }) => {
      const worker = new Worker("/e2e/export-readback.worker.ts", { type: "module" });
      const done = new Promise<{ frameCount?: number; kind: string; message?: string; rgba?: ArrayBuffer }>(
        (resolve, reject) => {
          worker.addEventListener(
            "error",
            (event) => reject(new Error(event.message || "The export readback worker crashed.")),
            { once: true },
          );
          worker.addEventListener("message", (event) => resolve(event.data as never), { once: true });
        },
      );
      const snapshotJson = new TextEncoder().encode(JSON.stringify(snapshot)).buffer;
      worker.postMessage(
        {
          fps,
          kind: "prove-export-readback",
          snapshotJson,
          viewport,
          wasmModuleUrl: new URL("/engine-wasm/poietra_wasm.js", location.href).href,
        },
        [snapshotJson],
      );
      const result = await done.finally(() => worker.terminate());
      if (result.kind !== "export-readback-proof" || !result.rgba || result.frameCount === undefined) {
        throw new Error(`The export readback proof failed: ${result.message ?? JSON.stringify(result)}`);
      }
      return {
        frameCount: result.frameCount,
        kind: result.kind,
        rgba: Array.from(new Uint8Array(result.rgba)),
      };
    },
    { fps, snapshot, viewport },
  );
}

async function renderPreviewAndDecodedMp4Pixels(
  page: Page,
  input: Readonly<{
    assetPayloads?: readonly BrowserAssetPayloadFixture[];
    fps: number;
    fragmentMaterialRegistry: FragmentMaterialRegistryV1;
    sampleFractions: readonly Readonly<{ fractionX: number; fractionY: number }>[];
    scenePostEffectRegistry?: ScenePostEffectRegistryV1;
    snapshot: SceneIrBundleV1;
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>,
): Promise<PreviewMp4PixelProof> {
  return page.evaluate(async (input) => {
    const preview = (await import(
      /* @vite-ignore */ "/src/engine/preview-renderer.ts"
    )) as typeof import("../src/engine/preview-renderer");
    const evidence = (await import(
      /* @vite-ignore */ "/src/engine/canvas-worker-evidence.ts"
    )) as typeof import("../src/engine/canvas-worker-evidence");
    const browserExport = (await import(
      /* @vite-ignore */ "/src/engine/browser-mp4-export.ts"
    )) as typeof import("../src/engine/browser-mp4-export");
    if (input.snapshot.scene.source.kind !== "studio-edit-program") {
      throw new Error("The material parity fixture lost its Studio revision.");
    }
    const assetPayloads = (input.assetPayloads ?? []).map(({ encodedBytes, ...metadata }) => ({
      ...metadata,
      bytes: Uint8Array.from(encodedBytes).buffer,
    }));

    document.body.replaceChildren();
    const previewCanvas = document.createElement("canvas");
    previewCanvas.height = input.viewport.heightPx;
    previewCanvas.width = input.viewport.widthPx;
    document.body.append(previewCanvas);
    const host = new preview.StudioPreviewRendererHost({
      createRenderer: () =>
        preview.createCanvasPreviewRendererV1({
          evidence: evidence.createCanvasWorkerClientEvidenceAdapterV1(),
          requestTimeoutMs: 30_000,
        }),
      onStateChange: () => undefined,
    });
    let previewPixels: readonly number[][];
    try {
      const revision = input.snapshot.scene.source.revisionHash;
      await host.install({
        assetPayloads,
        canvas: previewCanvas,
        fragmentMaterialRegistry: input.fragmentMaterialRegistry,
        revision,
        scenePostEffectRegistry: input.scenePostEffectRegistry,
        snapshot: input.snapshot,
      });
      host.requestFrame({ sampleTime: 0, viewport: input.viewport });
      const deadline = performance.now() + 30_000;
      while (host.state.phase !== "presented" || host.state.frame.revision !== revision) {
        if (performance.now() >= deadline) throw new Error(`Preview failed: ${JSON.stringify(host.state)}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      previewPixels = (await host.captureEvidence(input.sampleFractions)).samples;
    } finally {
      host.dispose();
    }

    const outcome = await browserExport.runBrowserMp4ExportV1({
      assetPayloads,
      fragmentMaterialRegistry: input.fragmentMaterialRegistry,
      profile: browserExport.DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      scenePostEffectRegistry: input.scenePostEffectRegistry,
      snapshot: input.snapshot,
    });
    if (outcome.kind === "refused") {
      return { kind: "refused" as const, message: outcome.message, reason: outcome.reason };
    }
    const url = URL.createObjectURL(outcome.mp4);
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error("Chromium rejected the exported MP4.")), {
          once: true,
        });
        video.load();
      });
      await new Promise<void>((resolve) => {
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.currentTime = 0.1 / input.fps;
      });
      const decodedCanvas = document.createElement("canvas");
      decodedCanvas.height = video.videoHeight;
      decodedCanvas.width = video.videoWidth;
      const context = decodedCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
      if (!context) throw new Error("The decoded-frame canvas is unavailable.");
      context.drawImage(video, 0, 0);
      const decodedPixels = input.sampleFractions.map(({ fractionX, fractionY }) =>
        Array.from(
          context.getImageData(
            Math.floor(video.videoWidth * fractionX),
            Math.floor(video.videoHeight * fractionY),
            1,
            1,
          ).data,
        ),
      );
      return { decodedPixels, kind: "decoded" as const, previewPixels };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, input);
}

test("proves the async offscreen export readback sequence in the browser WebGPU runtime", { tag: "@ci-main" }, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Pick<
    SceneIrBundleV1,
    "assets" | "scene"
  >;
  const bundle = { assets: fixture.assets, scene: fixture.scene };

  await page.goto("/");
  const proof = await renderExportReadback(page, bundle, VIEWPORT, FPS);

  expect(proof.kind).toBe("export-readback-proof");
  expect(proof.frameCount).toBe(EXPECTED_FRAME_COUNT);
  expect(proof.rgba).toHaveLength(EXPECTED_FRAME_COUNT * FRAME_BYTES);

  // The shared fixture animates the red circle (center pixel 70,45) from
  // opacity 0 to 1 with smoothstep easing across its 2-second duration while
  // the blue circle (center pixel 90,45) stays statically opaque. Smoothstep
  // progress 0.5 -> opacity 0.5 and 0.75 -> 0.84375; sRGB-encoding those
  // linear reds yields 188 and 237.
  for (let frame = 0; frame < EXPECTED_FRAME_COUNT; frame += 1) {
    expectPixelClose(pixelAt(proof.rgba, frame, 0, 0), [0, 0, 0, 255], 0);
    expectPixelClose(pixelAt(proof.rgba, frame, 90, 45), [0, 0, 255, 255], 3);
  }
  expectPixelClose(pixelAt(proof.rgba, 0, 70, 45), [0, 0, 0, 255], 0);
  expectPixelClose(pixelAt(proof.rgba, 2, 70, 45), [188, 0, 0, 255], 3);
  expectPixelClose(pixelAt(proof.rgba, 3, 70, 45), [237, 0, 0, 255], 3);
});

test("decoded WebCodecs MP4 frames preserve the Rust time-gradient render", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Pick<
    SceneIrBundleV1,
    "assets" | "scene"
  >;
  const snapshot = fragmentMaterialExportFixture({ assets: fixture.assets, scene: fixture.scene });

  await page.goto("/");
  // The exact 16:9 proof viewport avoids the 854 px export rung's intentional
  // camera widening. This material is spatially uniform, so its center pixel
  // remains the same expected Rust output at either viewport.
  const readback = await renderExportReadback(page, snapshot, FRAGMENT_READBACK_VIEWPORT, FRAGMENT_EXPORT_FPS);
  expect(readback.frameCount).toBe(FRAGMENT_EXPORT_FRAME_COUNT);
  const expected = FRAGMENT_EXPORT_SAMPLE_FRAMES.map((frameIndex) =>
    pixelAtViewport(
      readback.rgba,
      frameIndex,
      Math.floor(FRAGMENT_READBACK_VIEWPORT.widthPx / 2),
      Math.floor(FRAGMENT_READBACK_VIEWPORT.heightPx / 2),
      FRAGMENT_READBACK_VIEWPORT,
    ),
  );
  const proof = await page.evaluate(
    async ({ exportViewport, fps, sampleFrames, snapshot }) => {
      const browserExport = (await import(
        /* @vite-ignore */ "/src/engine/browser-mp4-export.ts"
      )) as typeof import("../src/engine/browser-mp4-export");
      const outcome = await browserExport.runBrowserMp4ExportV1({
        profile: browserExport.DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
        snapshot,
      });
      if (outcome.kind === "refused") {
        return { kind: "refused" as const, message: outcome.message, reason: outcome.reason };
      }

      const url = URL.createObjectURL(outcome.mp4);
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = url;
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("The exported MP4 did not become decodable.")), 15_000);
          video.addEventListener(
            "loadeddata",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
          video.addEventListener(
            "error",
            () => {
              clearTimeout(timeout);
              reject(new Error(video.error?.message || "Chromium rejected the exported MP4."));
            },
            { once: true },
          );
          video.load();
        });
        if (video.videoWidth !== exportViewport.widthPx || video.videoHeight !== exportViewport.heightPx) {
          throw new Error(`Decoded MP4 dimensions were ${video.videoWidth}x${video.videoHeight}.`);
        }
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
        if (!context) throw new Error("The decoded-frame canvas is unavailable.");

        const decoded = [];
        for (const frameIndex of sampleFrames) {
          const targetTime = (frameIndex + 0.1) / fps;
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`MP4 seek to frame ${frameIndex} timed out.`)), 15_000);
            const onSeeked = () => {
              clearTimeout(timeout);
              resolve();
            };
            video.addEventListener("seeked", onSeeked, { once: true });
            video.currentTime = targetTime;
          });
          context.drawImage(video, 0, 0);
          decoded.push(
            Array.from(
              context.getImageData(
                Math.floor(exportViewport.widthPx / 2),
                Math.floor(exportViewport.heightPx / 2),
                1,
                1,
              ).data,
            ),
          );
        }
        return { decoded, kind: "decoded" as const };
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    {
      exportViewport: FRAGMENT_EXPORT_VIEWPORT,
      fps: FRAGMENT_EXPORT_FPS,
      sampleFrames: FRAGMENT_EXPORT_SAMPLE_FRAMES,
      snapshot,
    },
  );

  test.skip(
    proof.kind === "refused" && ["api-unavailable", "unsupported-codec"].includes(proof.reason),
    proof.kind === "refused" ? `Chromium has no usable H.264 WebCodecs encoder: ${proof.message}` : undefined,
  );
  if (proof.kind === "refused") {
    throw new Error(`Browser MP4 export refused with ${proof.reason}: ${proof.message}`);
  }
  expect(expected).toHaveLength(2);
  expect(proof.decoded).toHaveLength(2);
  expect(Math.abs((expected[1]?.[0] ?? 0) - (expected[0]?.[0] ?? 0))).toBeGreaterThan(32);
  expect(Math.abs((proof.decoded[1]?.[0] ?? 0) - (proof.decoded[0]?.[0] ?? 0))).toBeGreaterThan(32);
  for (const [index, expectedPixel] of expected.entries()) {
    expectPixelClose(proof.decoded[index] ?? [], expectedPixel, 4);
  }
});

test("imported GLSL stays pixel-equivalent between Preview and decoded WebCodecs MP4", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Pick<
    SceneIrBundleV1,
    "assets" | "scene"
  >;

  await page.goto("/");
  const canonicalWgsl = await page.evaluate(async (source) => {
    const compiler = (await import(
      /* @vite-ignore */ "/src/engine/fragment-material-glsl.ts"
    )) as typeof import("../src/engine/fragment-material-glsl");
    return compiler.compileFragmentMaterialGlsl({ entryPoint: "main", source });
  }, IMPORTED_GLSL_SOURCE);
  expect(canonicalWgsl).toContain("fn fs_main");
  expect(canonicalWgsl).not.toContain("#version 450");

  const fragmentMaterialRegistry = {
    materials: [
      {
        revision: 1,
        shaderId: IMPORTED_GLSL_SHADER_ID,
        source: canonicalWgsl,
      },
    ],
    schema: "poietra.fragment-material-registry",
    version: 1,
  } satisfies FragmentMaterialRegistryV1;
  const snapshot = fragmentMaterialExportFixture(
    { assets: fixture.assets, scene: fixture.scene },
    {
      parameters: [0.5, 0.25, 0.75, 0],
      revision: 1,
      shaderId: IMPORTED_GLSL_SHADER_ID,
    },
  );
  const proof = await renderPreviewAndDecodedMp4Pixels(page, {
    fps: FRAGMENT_EXPORT_FPS,
    fragmentMaterialRegistry,
    sampleFractions: [{ fractionX: 0.5, fractionY: 0.5 }],
    snapshot,
    viewport: FRAGMENT_READBACK_VIEWPORT,
  });

  test.skip(
    proof.kind === "refused" && ["api-unavailable", "unsupported-codec"].includes(proof.reason),
    proof.kind === "refused" ? `Chromium has no usable H.264 WebCodecs encoder: ${proof.message}` : undefined,
  );
  if (proof.kind === "refused") {
    throw new Error(`Browser MP4 export refused with ${proof.reason}: ${proof.message}`);
  }
  expectPixelClose(proof.previewPixels[0] ?? [], [188, 137, 225, 255], 4);
  expectPixelClose(proof.decodedPixels[0] ?? [], proof.previewPixels[0] ?? [], 4);
});

test("a project PNG material stays pixel-equivalent between Preview and decoded WebCodecs MP4", async ({ page }) => {
  test.setTimeout(120_000);
  const [sceneFixture, pngFixture] = await Promise.all([
    readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8"),
    readFile("fixtures/engine-v1/png-alpha-edge-camera.json", "utf8"),
  ]);
  const base = JSON.parse(sceneFixture) as Pick<SceneIrBundleV1, "assets" | "scene">;
  const png = JSON.parse(pngFixture) as Readonly<{
    assetPayloads: readonly Readonly<{ assetId: string; encodedBytes: readonly number[] }>[];
    assets: SceneIrBundleV1["assets"];
  }>;
  const snapshot = screenTextureExportFixture({ assets: base.assets, scene: base.scene }, png.assets);
  const fragmentMaterialRegistry = {
    materials: [
      {
        revision: 1,
        shaderId: SCREEN_TEXTURE_SHADER_ID,
        source: STUDIO_TEXTURE_FRAGMENT_SOURCE_V1,
        textureSlot: "texture2d",
      },
    ],
    schema: "poietra.fragment-material-registry",
    version: 1,
  } satisfies FragmentMaterialRegistryV1;
  const assetPayloads = png.assetPayloads.map((payload) => {
    const metadata = png.assets.assets.find((asset) => asset.id === payload.assetId);
    if (!metadata) throw new Error(`PNG payload ${payload.assetId} has no manifest entry.`);
    return {
      assetId: metadata.id,
      byteLength: metadata.byteLength,
      encodedBytes: payload.encodedBytes,
      mediaType: metadata.mediaType,
      pixelHeight: metadata.pixelHeight,
      pixelWidth: metadata.pixelWidth,
      sha256: metadata.sha256,
    };
  });

  await page.goto("/");
  const proof = await renderPreviewAndDecodedMp4Pixels(page, {
    assetPayloads,
    fps: FRAGMENT_EXPORT_FPS,
    fragmentMaterialRegistry,
    sampleFractions: [
      // Both samples address the same inner-left object-local UV after the two
      // circles move to different y positions. Nearest stays on the opaque
      // texel while linear filtering crosses the PNG's alpha edge.
      { fractionX: 0.44375, fractionY: 0.35 },
      { fractionX: 0.44375, fractionY: 0.65 },
      // These circles occupy different screen X ranges but address the same
      // inner-left local UV. A screen-space regression makes the right sample
      // hit the PNG's transparent texel instead.
      { fractionX: 0.225, fractionY: 0.5 },
      { fractionX: 0.725, fractionY: 0.5 },
    ],
    snapshot,
    viewport: FRAGMENT_READBACK_VIEWPORT,
  });

  test.skip(
    proof.kind === "refused" && ["api-unavailable", "unsupported-codec"].includes(proof.reason),
    proof.kind === "refused" ? `Chromium has no usable H.264 WebCodecs encoder: ${proof.message}` : undefined,
  );
  if (proof.kind === "refused") {
    throw new Error(`Browser MP4 export refused with ${proof.reason}: ${proof.message}`);
  }
  expect(proof.previewPixels).toHaveLength(4);
  expect(proof.decodedPixels).toHaveLength(4);
  expect(proof.previewPixels[0]?.[0]).toBeGreaterThan(245);
  expect(proof.previewPixels[1]?.[0]).toBeLessThan(230);
  expect((proof.previewPixels[0]?.[0] ?? 0) - (proof.previewPixels[1]?.[0] ?? 0)).toBeGreaterThan(20);
  expectPixelClose(proof.previewPixels[2] ?? [], [255, 0, 0, 255], 0);
  expectPixelClose(proof.previewPixels[3] ?? [], proof.previewPixels[2] ?? [], 0);
  for (const [index, previewPixel] of proof.previewPixels.entries()) {
    // H.264 may shift a channel by up to 6/255 at this deliberate one-pixel
    // alpha edge; the nearest/linear semantic assertions above stay strict.
    expectPixelClose(proof.decodedPixels[index] ?? [], previewPixel, 6);
  }
});

test("an effect-only project PNG stays pixel-equivalent between Preview and decoded WebCodecs MP4", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const [sceneFixture, pngFixture] = await Promise.all([
    readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8"),
    readFile("fixtures/engine-v1/png-alpha-edge-camera.json", "utf8"),
  ]);
  const base = JSON.parse(sceneFixture) as SceneIrBundleV1;
  const png = JSON.parse(pngFixture) as Readonly<{
    assetPayloads: readonly Readonly<{ assetId: string; encodedBytes: readonly number[] }>[];
    assets: SceneIrBundleV1["assets"];
  }>;
  const asset = png.assets.assets[0];
  const payload = png.assetPayloads[0];
  if (!asset || !payload || asset.id !== payload.assetId) throw new Error("The PNG effect fixture is incomplete.");
  const snapshot: SceneIrBundleV1 = {
    assets: png.assets,
    scene: {
      ...base.scene,
      animationChannels: [],
      assetManifest: { manifestDigest: png.assets.manifestDigest, manifestId: png.assets.manifestId },
      duration: FRAGMENT_EXPORT_DURATION,
      entities: [],
      postEffects: [
        {
          parameters: [],
          revision: 1,
          shaderId: "project-scene-post-effect",
          texture: {
            asset: { assetId: asset.id, sha256: asset.sha256 },
            sampler: "nearest",
          },
        },
      ],
      requiredCapabilities: ["png-image", "scene-post-effect"],
      sceneId: "fixture:textured-effect-export",
      source: { ...base.scene.source, revisionHash: "d".repeat(64) },
    },
  };
  const scenePostEffectRegistry = {
    effects: [
      {
        revision: 1,
        shaderId: "project-scene-post-effect",
        source: `struct Host {
  viewport_and_time: vec4<f32>,
  parameters_0: vec4<f32>,
  parameters_1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> host: Host;
@group(0) @binding(1) var scene_texture: texture_2d<f32>;
@group(0) @binding(3) var auxiliary_texture: texture_2d<f32>;
@group(0) @binding(4) var auxiliary_sampler: sampler;
@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  return textureSample(auxiliary_texture, auxiliary_sampler, vec2<f32>(0.25, 0.5));
}`,
        textureSlot: "texture2d",
      },
    ],
    schema: "poietra.scene-post-effect-registry",
    version: 1,
  } satisfies ScenePostEffectRegistryV1;
  const assetPayloads = [
    {
      assetId: asset.id,
      byteLength: asset.byteLength,
      encodedBytes: payload.encodedBytes,
      mediaType: asset.mediaType,
      pixelHeight: asset.pixelHeight,
      pixelWidth: asset.pixelWidth,
      sha256: asset.sha256,
    },
  ];

  await page.goto("/");
  const proof = await renderPreviewAndDecodedMp4Pixels(page, {
    assetPayloads,
    fps: FRAGMENT_EXPORT_FPS,
    fragmentMaterialRegistry: {
      materials: [],
      schema: "poietra.fragment-material-registry",
      version: 1,
    },
    sampleFractions: [{ fractionX: 0.5, fractionY: 0.5 }],
    scenePostEffectRegistry,
    snapshot,
    viewport: FRAGMENT_READBACK_VIEWPORT,
  });

  test.skip(
    proof.kind === "refused" && ["api-unavailable", "unsupported-codec"].includes(proof.reason),
    proof.kind === "refused" ? `Chromium has no usable H.264 WebCodecs encoder: ${proof.message}` : undefined,
  );
  if (proof.kind === "refused") {
    throw new Error(`Browser MP4 export refused with ${proof.reason}: ${proof.message}`);
  }
  expectPixelClose(proof.previewPixels[0] ?? [], [255, 0, 0, 255], 0);
  expectPixelClose(proof.decodedPixels[0] ?? [], proof.previewPixels[0] ?? [], 6);
});
