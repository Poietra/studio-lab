import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { decodeRgbaPngV1 } from "./png-rgba";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const COMMIT_SHA = z.string().regex(/^[0-9a-f]{40}$/);
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;

export const SPIRAL_IN_CAIRO_REFERENCE_ROOT_V1 = "fixtures/spiral-in-cairo-reference-v1";
export const SPIRAL_IN_CAIRO_REFERENCE_SAMPLES_V1 = [
  ["real-spiral-in-v11--start", "start", 0],
  ["real-spiral-in-v11--early-reveal", "early-reveal", 0.1],
  ["real-spiral-in-v11--spiral-midpoint", "spiral-midpoint", 0.5],
  ["real-spiral-in-v11--spiral-end", "spiral-end", 1],
  ["real-spiral-in-v11--hold", "hold", 1.5],
  ["real-spiral-in-v11--group-fade-midpoint", "group-fade-midpoint", 2.5],
  ["real-spiral-in-v11--end", "end", 3],
] as const;
export const SPIRAL_IN_CAIRO_REFERENCE_ENTRY_IDS_V1 = SPIRAL_IN_CAIRO_REFERENCE_SAMPLES_V1.map(([entryId]) => entryId);
export const SPIRAL_IN_CAIRO_PARITY_THRESHOLDS_V1 = {
  maximumPixelFractionAboveThreshold: 0.02,
  minimumSsim: 0.994,
  reason:
    "Independent Cairo and Lyon/WGPU edge antialiasing differ while preserving the exact official SpiralIn transforms, paint, hold, and group fade.",
} as const;

function frameSchema(id: (typeof SPIRAL_IN_CAIRO_REFERENCE_SAMPLES_V1)[number][1], sampleTime: number) {
  return z.strictObject({
    id: z.literal(id),
    png: z.strictObject({
      byteLength: z.number().int().positive(),
      channelOrder: z.literal("rgba"),
      path: z.literal(`${id}.png`),
      rgbaByteLength: z.literal(VIEWPORT.widthPx * VIEWPORT.heightPx * 4),
      rgbaSha256: SHA256,
      rowOrder: z.literal("top-to-bottom"),
      sha256: SHA256,
    }),
    sampleTime: z.literal(sampleTime),
  });
}

export const spiralInCairoReferenceV1Schema = z.strictObject({
  frame: z.strictObject({
    background: z.literal("opaque-black"),
    camera: z.strictObject({ height: z.literal(8), width: z.literal(128 / 9) }),
    colorDomain: z.literal("srgb-u8"),
    frameRate: z.literal(60),
    viewport: z.strictObject({ heightPx: z.literal(VIEWPORT.heightPx), widthPx: z.literal(VIEWPORT.widthPx) }),
  }),
  frames: z.tuple([
    frameSchema("start", 0),
    frameSchema("early-reveal", 0.1),
    frameSchema("spiral-midpoint", 0.5),
    frameSchema("spiral-end", 1),
    frameSchema("hold", 1.5),
    frameSchema("group-fade-midpoint", 2.5),
    frameSchema("end", 3),
  ]),
  producer: z.strictObject({
    cairoLibrarySha256: SHA256,
    cairoVersion: z.string().min(1),
    fastManimCommit: COMMIT_SHA,
    fastManimTree: COMMIT_SHA,
    identitySha256: SHA256,
    manimVersion: z.string().min(1),
    numpyVersion: z.string().min(1),
    pillowImagingModuleSha256: SHA256,
    pillowVersion: z.string().min(1),
    pycairoModuleSha256: SHA256,
    pycairoVersion: z.string().min(1),
    pythonExecutableSha256: SHA256,
    pythonImplementation: z.literal("CPython"),
    pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    renderer: z.literal("cairo"),
    texToolchain: z.strictObject({
      dvisvgm: z.strictObject({ executableSha256: SHA256, version: z.string().min(1) }),
      latex: z.strictObject({ executableSha256: SHA256, version: z.string().min(1) }),
    }),
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
    className: z.literal("SpiralInExample"),
    repository: z.literal("Poietra/fast-manim"),
    sourcePath: z.literal("example_scenes/basic.py"),
    sourceSha256: SHA256,
  }),
  schema: z.literal("poietra.spiral-in-cairo-reference"),
  version: z.literal(1),
});

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label} hashes to ${actual}, expected ${expected}`);
}

export async function readSpiralInCairoReferenceV1(root = SPIRAL_IN_CAIRO_REFERENCE_ROOT_V1) {
  const reference = spiralInCairoReferenceV1Schema.parse(
    JSON.parse(await readFile(join(root, "reference.json"), "utf8")),
  );
  const { identitySha256: producerDigest, ...producerIdentity } = reference.producer;
  requireDigest(sha256(canonicalJsonV1(producerIdentity)), producerDigest, "the Cairo producer identity");
  requireDigest(
    sha256(canonicalJsonV1(reference.rendererConfig.values)),
    reference.rendererConfig.identitySha256,
    "the Cairo renderer configuration",
  );

  const frames = new Map<
    (typeof SPIRAL_IN_CAIRO_REFERENCE_SAMPLES_V1)[number][1],
    Readonly<{ png: Uint8Array; rgba: Uint8Array; sampleTime: number }>
  >();
  for (const frame of reference.frames) {
    const png = new Uint8Array(await readFile(join(root, frame.png.path)));
    if (png.byteLength !== frame.png.byteLength) {
      throw new Error(`the ${frame.id} Cairo PNG has ${png.byteLength} bytes, expected ${frame.png.byteLength}`);
    }
    requireDigest(sha256(png), frame.png.sha256, `the ${frame.id} Cairo PNG`);
    const rgba = decodeRgbaPngV1(png, reference.frame.viewport.widthPx, reference.frame.viewport.heightPx);
    if (rgba.byteLength !== frame.png.rgbaByteLength) {
      throw new Error(
        `the decoded ${frame.id} Cairo frame has ${rgba.byteLength} bytes, expected ${frame.png.rgbaByteLength}`,
      );
    }
    requireDigest(sha256(rgba), frame.png.rgbaSha256, `the ${frame.id} top-to-bottom Cairo RGBA frame`);
    frames.set(frame.id, { png, rgba, sampleTime: frame.sampleTime });
  }
  return { frames, reference } as const;
}

export function spiralInCairoReferenceSampleForEntryV1(entryId: string) {
  const sample = SPIRAL_IN_CAIRO_REFERENCE_SAMPLES_V1.find(([candidate]) => candidate === entryId);
  if (!sample) throw new Error(`Visual-parity entry ${entryId} has no independent SpiralIn Cairo reference.`);
  return { entryId: sample[0], sampleId: sample[1], sampleTime: sample[2] } as const;
}

export async function readSpiralInCairoReferenceForEntryV1(entryId: string) {
  const sample = spiralInCairoReferenceSampleForEntryV1(entryId);
  const result = await readSpiralInCairoReferenceV1();
  const frame = result.frames.get(sample.sampleId);
  if (!frame) throw new Error(`SpiralIn Cairo reference is missing ${sample.sampleId}.`);
  return { ...frame, reference: result.reference } as const;
}
