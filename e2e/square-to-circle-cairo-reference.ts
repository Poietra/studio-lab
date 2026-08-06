import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;
const RGBA_BYTE_LENGTH = VIEWPORT.widthPx * VIEWPORT.heightPx * 4;

export const SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V1 =
  "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
export const SQUARE_TO_CIRCLE_CAIRO_FAST_MANIM_COMMIT_V1 = "68c1c9a649abcc64b36e80f967aac262a7ba92ac";
export const SQUARE_TO_CIRCLE_CAIRO_FAST_MANIM_TREE_V1 = "4e647408991999f132b5d48a6705571e8a82906f";

export const SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1 = [
  ["create-midpoint", 0.5],
  ["transform-midpoint", 1.5],
  ["analytic-winding-root", 1.5119159473817447],
  ["fade-midpoint", 2.5],
] as const;

function frameSchema(id: (typeof SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1)[number][0], sampleTime: number) {
  return z.strictObject({
    id: z.literal(id),
    sampleTime: z.literal(sampleTime),
    rgba: z.strictObject({
      byteLength: z.literal(RGBA_BYTE_LENGTH),
      channelOrder: z.literal("rgba"),
      path: z.literal(`${id}.rgba`),
      rowOrder: z.literal("top-to-bottom"),
      sha256: SHA256,
    }),
  });
}

export const squareToCircleCairoReferenceV1Schema = z.strictObject({
  frame: z.strictObject({
    background: z.literal("opaque-black"),
    camera: z.strictObject({ height: z.literal(8), width: z.literal(128 / 9) }),
    colorDomain: z.literal("srgb-u8"),
    frameRate: z.literal(60),
    viewport: z.strictObject({ heightPx: z.literal(VIEWPORT.heightPx), widthPx: z.literal(VIEWPORT.widthPx) }),
  }),
  frames: z.tuple([
    frameSchema("create-midpoint", 0.5),
    frameSchema("transform-midpoint", 1.5),
    frameSchema("analytic-winding-root", 1.5119159473817447),
    frameSchema("fade-midpoint", 2.5),
  ]),
  producer: z.strictObject({
    cairoVersion: z.string().min(1),
    fastManimCommit: z.literal(SQUARE_TO_CIRCLE_CAIRO_FAST_MANIM_COMMIT_V1),
    fastManimTree: z.literal(SQUARE_TO_CIRCLE_CAIRO_FAST_MANIM_TREE_V1),
    identitySha256: SHA256,
    manimVersion: z.literal("0.20.1"),
    numpyVersion: z.string().min(1),
    pycairoVersion: z.string().min(1),
    renderer: z.literal("cairo"),
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
    className: z.literal("SquareToCircle"),
    repository: z.literal("Poietra/fast-manim"),
    slice: z.strictObject({ duration: z.literal(3), start: z.literal(0) }),
    sourcePath: z.literal("example_scenes/basic.py"),
    sourceSha256: SHA256,
  }),
  schema: z.literal("poietra.square-to-circle-cairo-reference"),
  version: z.literal(1),
});

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label} hashes to ${actual}, expected ${expected}`);
}

export async function readSquareToCircleCairoReferenceV1(root: string, expectedSourceSha256: string) {
  const expectedSourceDigest = SHA256.parse(expectedSourceSha256);
  const reference = squareToCircleCairoReferenceV1Schema.parse(
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
    (typeof SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1)[number][0],
    Readonly<{ rgba: Uint8Array; sampleTime: number }>
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
    frames.set(frame.id, { rgba, sampleTime: frame.sampleTime });
  }
  return { frames, reference } as const;
}
