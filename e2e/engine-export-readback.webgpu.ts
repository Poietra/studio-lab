import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";
import type { FragmentMaterialRegistryV1 } from "../src/engine/fragment-material-registry";

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

test("proves the async offscreen export readback sequence in the browser WebGPU runtime", async ({ page }) => {
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
  const proof = await page.evaluate(
    async ({ fps, fragmentMaterialRegistry, snapshot, viewport }) => {
      const preview = (await import(
        /* @vite-ignore */ "/src/engine/preview-renderer.ts"
      )) as typeof import("../src/engine/preview-renderer");
      const evidence = (await import(
        /* @vite-ignore */ "/src/engine/canvas-worker-evidence.ts"
      )) as typeof import("../src/engine/canvas-worker-evidence");
      const browserExport = (await import(
        /* @vite-ignore */ "/src/engine/browser-mp4-export.ts"
      )) as typeof import("../src/engine/browser-mp4-export");
      if (snapshot.scene.source.kind !== "studio-edit-program") {
        throw new Error("The imported GLSL parity fixture lost its Studio revision.");
      }

      document.body.replaceChildren();
      const previewCanvas = document.createElement("canvas");
      previewCanvas.height = viewport.heightPx;
      previewCanvas.width = viewport.widthPx;
      document.body.append(previewCanvas);
      const host = new preview.StudioPreviewRendererHost({
        createRenderer: () =>
          preview.createCanvasPreviewRendererV1({
            evidence: evidence.createCanvasWorkerClientEvidenceAdapterV1(),
            requestTimeoutMs: 30_000,
          }),
        onStateChange: () => undefined,
      });
      let previewPixel: readonly number[];
      try {
        const revision = snapshot.scene.source.revisionHash;
        await host.install({ canvas: previewCanvas, fragmentMaterialRegistry, revision, snapshot });
        host.requestFrame({ sampleTime: 0, viewport });
        const deadline = performance.now() + 30_000;
        while (host.state.phase !== "presented" || host.state.frame.revision !== revision) {
          if (performance.now() >= deadline) throw new Error(`Preview failed: ${JSON.stringify(host.state)}`);
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        previewPixel = (await host.captureEvidence([{ fractionX: 0.5, fractionY: 0.5 }])).samples[0] ?? [];
      } finally {
        host.dispose();
      }

      const outcome = await browserExport.runBrowserMp4ExportV1({
        fragmentMaterialRegistry,
        profile: browserExport.DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
        snapshot,
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
          video.currentTime = 0.1 / fps;
        });
        const decodedCanvas = document.createElement("canvas");
        decodedCanvas.height = video.videoHeight;
        decodedCanvas.width = video.videoWidth;
        const context = decodedCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
        if (!context) throw new Error("The decoded-frame canvas is unavailable.");
        context.drawImage(video, 0, 0);
        const decodedPixel = Array.from(
          context.getImageData(Math.floor(video.videoWidth / 2), Math.floor(video.videoHeight / 2), 1, 1).data,
        );
        return { decodedPixel, kind: "decoded" as const, previewPixel };
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    {
      fps: FRAGMENT_EXPORT_FPS,
      fragmentMaterialRegistry,
      snapshot,
      viewport: FRAGMENT_READBACK_VIEWPORT,
    },
  );

  test.skip(
    proof.kind === "refused" && ["api-unavailable", "unsupported-codec"].includes(proof.reason),
    proof.kind === "refused" ? `Chromium has no usable H.264 WebCodecs encoder: ${proof.message}` : undefined,
  );
  if (proof.kind === "refused") {
    throw new Error(`Browser MP4 export refused with ${proof.reason}: ${proof.message}`);
  }
  expectPixelClose(proof.previewPixel, [188, 137, 225, 255], 4);
  expectPixelClose(proof.decodedPixel, proof.previewPixel, 4);
});
