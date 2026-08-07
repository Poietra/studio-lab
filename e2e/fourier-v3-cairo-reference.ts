import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { decodeRgbaPngV1 } from "./png-rgba";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const COMMIT_SHA = z.string().regex(/^[0-9a-f]{40}$/);
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;

export const FOURIER_V3_CAIRO_REFERENCE_ROOT_V1 = "fixtures/fourier-v3-cairo-reference-v1";
export const FOURIER_V3_CAIRO_FRAME_INDICES_V1 = [0, 300, 600, 630, 660, 690, 869] as const;
export const FOURIER_V3_CAIRO_PARITY_THRESHOLDS_V1 = {
  maximumPixelFractionAboveThreshold: 0.005,
  minimumSsim: 0.995,
} as const;

const FRAME_SAMPLE_TIMES = [0, 5, 10, 10.5, 11, 11.5, 14.483333333333333] as const;
const executableIdentitySchema = z.strictObject({ executableSha256: SHA256, version: z.string().min(1) });

function pngSchema(frameIndex: (typeof FOURIER_V3_CAIRO_FRAME_INDICES_V1)[number]) {
  return z.strictObject({
    byteLength: z.number().int().positive(),
    path: z.literal(`frame-${String(frameIndex).padStart(3, "0")}.png`),
    rgbaByteLength: z.literal(VIEWPORT.widthPx * VIEWPORT.heightPx * 4),
    rgbaSha256: SHA256,
    sha256: SHA256,
  });
}

const frameSchemas = FOURIER_V3_CAIRO_FRAME_INDICES_V1.map((frameIndex, index) =>
  z.strictObject({
    frameIndex: z.literal(frameIndex),
    png: pngSchema(frameIndex),
    sampleTime: z.literal(FRAME_SAMPLE_TIMES[index]!),
  }),
);

export const fourierV3CairoReferenceV1Schema = z.strictObject({
  codebase: z.strictObject({
    repository: z.literal("https://github.com/HarleyCoops/Math-To-Manim.git"),
    revision: COMMIT_SHA,
    tree: COMMIT_SHA,
  }),
  frame: z.strictObject({
    background: z.literal("opaque-black"),
    camera: z.strictObject({ height: z.literal(8), width: z.literal(128 / 9) }),
    colorDomain: z.literal("srgb-u8"),
    frameRate: z.literal(60),
    totalFrames: z.literal(870),
    viewport: z.strictObject({ heightPx: z.literal(360), widthPx: z.literal(640) }),
  }),
  frames: z.tuple(frameSchemas as [(typeof frameSchemas)[0], ...typeof frameSchemas]),
  producer: z.strictObject({
    cairoLibrarySha256: SHA256,
    cairoVersion: z.string().min(1),
    fastManimCommit: COMMIT_SHA,
    fastManimTree: COMMIT_SHA,
    identitySha256: SHA256,
    manimVersion: z.literal("0.20.1"),
    nodeExecutableSha256: SHA256,
    nodeVersion: z.string().min(1),
    nodeZlibVersion: z.string().min(1),
    numpyVersion: z.string().min(1),
    pillowImagingModuleSha256: SHA256,
    pillowVersion: z.string().min(1),
    pngEncoder: z.literal("poietra-filter-none-node-zlib-level-9-v1"),
    pycairoModuleSha256: SHA256,
    pycairoVersion: z.string().min(1),
    pythonExecutableSha256: SHA256,
    pythonImplementation: z.literal("CPython"),
    pythonVersion: z.string().min(1),
    renderer: z.literal("independent-cairo"),
    repository: z.literal("https://github.com/Poietra/fast-manim.git"),
    texToolchain: z.strictObject({ dvisvgm: executableIdentitySchema, latex: executableIdentitySchema }),
    uvLockSha256: SHA256,
  }),
  rendererConfig: z.strictObject({
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
    identitySha256: SHA256,
    pixelHeight: z.literal(360),
    pixelWidth: z.literal(640),
    renderer: z.literal("cairo"),
    saveLastFrame: z.literal(false),
    savePngs: z.literal(false),
    seed: z.literal(0),
    transparent: z.literal(false),
    verbosity: z.literal("WARNING"),
    writeToMovie: z.literal(false),
  }),
  reproducibility: z.strictObject({
    environment: z.strictObject({ PYTHONHASHSEED: z.literal("0") }),
    seeds: z.strictObject({ numpy: z.literal(0), pythonRandom: z.literal(0) }),
  }),
  scene: z.strictObject({
    className: z.literal("FourierSeriesSquareWave"),
    sourcePath: z.literal("legacy/Math-To-Manim/examples/mathematics/trigonometry/TrigInference.py"),
    sourceSha256: SHA256,
  }),
  schema: z.literal("poietra.fourier-v3-independent-cairo-reference"),
  version: z.literal(1),
});

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireCanonicalDigest(value: Record<string, unknown>, digest: string, label: string) {
  if (sha256(Buffer.from(canonicalJsonV1(value), "utf8")) !== digest) {
    throw new Error(`${label} identity does not match its pinned digest.`);
  }
}

export async function readFourierV3CairoReferenceV1(root = FOURIER_V3_CAIRO_REFERENCE_ROOT_V1) {
  const reference = fourierV3CairoReferenceV1Schema.parse(
    JSON.parse(await readFile(join(root, "reference.json"), "utf8")),
  );
  const { identitySha256: producerDigest, ...producerIdentity } = reference.producer;
  const { identitySha256: rendererDigest, ...rendererIdentity } = reference.rendererConfig;
  requireCanonicalDigest(producerIdentity, producerDigest, "Fourier Cairo producer");
  requireCanonicalDigest(rendererIdentity, rendererDigest, "Fourier Cairo renderer configuration");
  const frames = new Map<number, Readonly<{ rgba: Uint8Array; sampleTime: number }>>();
  for (const frame of reference.frames) {
    const png = new Uint8Array(await readFile(join(root, frame.png.path)));
    if (png.byteLength !== frame.png.byteLength || sha256(png) !== frame.png.sha256) {
      throw new Error(`Fourier Cairo frame ${frame.frameIndex} does not match its pinned PNG.`);
    }
    const rgba = decodeRgbaPngV1(png, VIEWPORT.widthPx, VIEWPORT.heightPx);
    if (rgba.byteLength !== frame.png.rgbaByteLength || sha256(rgba) !== frame.png.rgbaSha256) {
      throw new Error(`Fourier Cairo frame ${frame.frameIndex} does not match its pinned RGBA.`);
    }
    frames.set(frame.frameIndex, { rgba, sampleTime: frame.sampleTime });
  }
  return { frames, reference } as const;
}
