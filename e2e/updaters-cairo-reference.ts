import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;
const RGBA_BYTE_LENGTH = VIEWPORT.widthPx * VIEWPORT.heightPx * 4;
export const UPDATERS_OFFICIAL_SOURCE_SHA256_V1 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";

export const UPDATERS_CAIRO_REFERENCE_SAMPLES_V1 = [
  ["initial", 0, 0],
  ["descent", 75, 75 / 60],
  ["bottom", 150, 150 / 60],
  ["return", 225, 225 / 60],
  ["play-end", 299, 299 / 60],
  ["hold", 330, 330 / 60],
  ["duration-end", 359, 6],
] as const;

function frameSchema(
  id: (typeof UPDATERS_CAIRO_REFERENCE_SAMPLES_V1)[number][0],
  capturedFrameIndex: number,
  requestSampleTime: number,
) {
  return z.strictObject({
    capturedFrameIndex: z.literal(capturedFrameIndex),
    capturedTime: z.literal(capturedFrameIndex / 60),
    id: z.literal(id),
    requestSampleTime: z.literal(requestSampleTime),
    rgba: z.strictObject({
      byteLength: z.literal(RGBA_BYTE_LENGTH),
      channelOrder: z.literal("rgba"),
      path: z.literal(`${id}.rgba`),
      rowOrder: z.literal("top-to-bottom"),
      sha256: SHA256,
    }),
  });
}

export const updatersCairoReferenceV1Schema = z.strictObject({
  frame: z.strictObject({
    background: z.literal("opaque-black"),
    camera: z.strictObject({ height: z.literal(8), width: z.literal(128 / 9) }),
    colorDomain: z.literal("srgb-u8"),
    frameRate: z.literal(60),
    viewport: z.strictObject({ heightPx: z.literal(VIEWPORT.heightPx), widthPx: z.literal(VIEWPORT.widthPx) }),
  }),
  frames: z.tuple([
    frameSchema("initial", 0, 0),
    frameSchema("descent", 75, 75 / 60),
    frameSchema("bottom", 150, 150 / 60),
    frameSchema("return", 225, 225 / 60),
    frameSchema("play-end", 299, 299 / 60),
    frameSchema("hold", 330, 330 / 60),
    frameSchema("duration-end", 359, 6),
  ]),
  producer: z.strictObject({
    cairoLibrarySha256: SHA256,
    cairoVersion: z.string().min(1),
    decimalGlyphResourceSha256: SHA256,
    fastManimCommit: z.literal("4ed7d01176438e612a8e9b6a080bf61ff906226e"),
    fastManimTree: z.literal("e1d62d7d0d4ceb238ea9afb68cfdedf1510e9a03"),
    glyphProviderSha256: z.literal("b95975405e4df8302088ac0b01afb55b42bd1892d8fa8161a1ca556e023e6322"),
    identitySha256: SHA256,
    manimVersion: z.literal("0.20.1"),
    numpyVersion: z.string().min(1),
    pillowImagingModuleSha256: SHA256,
    pillowVersion: z.string().min(1),
    pycairoModuleSha256: SHA256,
    pycairoVersion: z.string().min(1),
    pythonExecutableSha256: SHA256,
    pythonImplementation: z.literal("CPython"),
    pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    renderer: z.literal("cairo"),
    rendererModuleSha256: SHA256,
    uvLockSha256: SHA256,
  }),
  rendererConfig: z.strictObject({
    identitySha256: SHA256,
    values: z.strictObject({
      antialias: z.literal("default"),
      backgroundColor: z.literal("#000000"),
      backgroundOpacity: z.literal(1),
      cairoCompositor: z.literal(false),
      cairoCompositorFades: z.literal(false),
      cairoForkWorkers: z.literal(0),
      cairoStaticLayers: z.literal(false),
      disableCaching: z.literal(true),
      format: z.literal("png"),
      frameHeight: z.literal(8),
      frameRate: z.literal(60),
      frameWidth: z.literal(128 / 9),
      pixelHeight: z.literal(VIEWPORT.heightPx),
      pixelWidth: z.literal(VIEWPORT.widthPx),
      renderer: z.literal("cairo"),
      saveLastFrame: z.literal(false),
      savePngs: z.literal(false),
      seed: z.literal(0),
      transparent: z.literal(false),
      verbosity: z.literal("WARNING"),
      writeToMovie: z.literal(false),
    }),
  }),
  reproducibility: z.strictObject({
    environment: z.strictObject({ PYTHONHASHSEED: z.literal("0") }),
    seeds: z.strictObject({ numpy: z.literal(0), pythonRandom: z.literal(0) }),
  }),
  scene: z.strictObject({
    className: z.literal("UpdatersExample"),
    decimalImplementation: z.literal("hermetic-runtime-trace-v1"),
    repository: z.literal("Poietra/fast-manim"),
    sourcePath: z.literal("example_scenes/basic.py"),
    sourceSha256: SHA256,
  }),
  schema: z.literal("poietra.updaters-cairo-reference"),
  version: z.literal(1),
});

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label} hashes to ${actual}, expected ${expected}`);
}

export async function readUpdatersCairoReferenceV1(root: string, expectedSourceSha256: string) {
  const expectedSourceDigest = SHA256.parse(expectedSourceSha256);
  const reference = updatersCairoReferenceV1Schema.parse(
    JSON.parse(await readFile(join(root, "reference.json"), "utf8")),
  );
  const { identitySha256: producerDigest, ...producerIdentity } = reference.producer;
  requireDigest(sha256(canonicalJsonV1(producerIdentity)), producerDigest, "the Cairo producer identity");
  requireDigest(
    sha256(canonicalJsonV1(reference.rendererConfig.values)),
    reference.rendererConfig.identitySha256,
    "the Cairo renderer configuration",
  );
  requireDigest(reference.scene.sourceSha256, expectedSourceDigest, "the Cairo source");

  const frames = new Map<
    (typeof UPDATERS_CAIRO_REFERENCE_SAMPLES_V1)[number][0],
    Readonly<{ capturedFrameIndex: number; requestSampleTime: number; rgba: Uint8Array }>
  >();
  for (const frame of reference.frames) {
    const rgba = new Uint8Array(await readFile(join(root, frame.rgba.path)));
    if (rgba.byteLength !== frame.rgba.byteLength) {
      throw new Error(`the ${frame.id} Cairo frame has ${rgba.byteLength} bytes, expected ${frame.rgba.byteLength}`);
    }
    requireDigest(sha256(rgba), frame.rgba.sha256, `the ${frame.id} top-to-bottom Cairo RGBA frame`);
    for (let offset = 3; offset < rgba.byteLength; offset += 4) {
      if (rgba[offset] !== 255) throw new Error(`the ${frame.id} Cairo frame is not opaque`);
    }
    frames.set(frame.id, {
      capturedFrameIndex: frame.capturedFrameIndex,
      requestSampleTime: frame.requestSampleTime,
      rgba,
    });
  }
  return { frames, reference } as const;
}
