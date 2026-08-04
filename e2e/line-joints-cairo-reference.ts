import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { decodeRgbaPngV1 } from "./png-rgba";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const COMMIT_SHA = z.string().regex(/^[0-9a-f]{40}$/);
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;

export const LINE_JOINTS_CAIRO_REFERENCE_ROOT_V1 = "fixtures/line-joints-cairo-reference-v1";
export const LINE_JOINTS_CAIRO_PARITY_THRESHOLDS_V1 = {
  maximumPixelFractionAboveThreshold: 0.02,
  minimumSsim: 0.994,
  reason: "Independent Cairo and Lyon/WGPU edge antialiasing differ while preserving the three exact join silhouettes.",
} as const;

export const lineJointsCairoReferenceV1Schema = z.strictObject({
  frame: z.strictObject({
    background: z.literal("opaque-black"),
    camera: z.strictObject({ height: z.literal(8), width: z.literal(128 / 9) }),
    colorDomain: z.literal("srgb-u8"),
    sampleTime: z.literal(0),
    viewport: z.strictObject({ heightPx: z.literal(VIEWPORT.heightPx), widthPx: z.literal(VIEWPORT.widthPx) }),
  }),
  png: z.strictObject({
    byteLength: z.number().int().positive(),
    channelOrder: z.literal("rgba"),
    path: z.literal("expected.png"),
    rgbaByteLength: z.literal(VIEWPORT.widthPx * VIEWPORT.heightPx * 4),
    rgbaSha256: SHA256,
    rowOrder: z.literal("top-to-bottom"),
    sha256: SHA256,
  }),
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
      saveLastFrame: z.literal(true),
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
    className: z.literal("LineJoints"),
    repository: z.literal("Poietra/fast-manim"),
    sourcePath: z.literal("example_scenes/basic.py"),
    sourceSha256: SHA256,
  }),
  schema: z.literal("poietra.line-joints-cairo-reference"),
  version: z.literal(1),
});

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label} hashes to ${actual}, expected ${expected}`);
}

export async function readLineJointsCairoReferenceV1(root = LINE_JOINTS_CAIRO_REFERENCE_ROOT_V1) {
  const reference = lineJointsCairoReferenceV1Schema.parse(
    JSON.parse(await readFile(join(root, "reference.json"), "utf8")),
  );
  const { identitySha256: producerDigest, ...producerIdentity } = reference.producer;
  requireDigest(sha256(canonicalJsonV1(producerIdentity)), producerDigest, "the Cairo producer identity");
  requireDigest(
    sha256(canonicalJsonV1(reference.rendererConfig.values)),
    reference.rendererConfig.identitySha256,
    "the Cairo renderer configuration",
  );

  const png = new Uint8Array(await readFile(join(root, reference.png.path)));
  if (png.byteLength !== reference.png.byteLength) {
    throw new Error(`the Cairo PNG has ${png.byteLength} bytes, expected ${reference.png.byteLength}`);
  }
  requireDigest(sha256(png), reference.png.sha256, "the Cairo PNG");
  const rgba = decodeRgbaPngV1(png, reference.frame.viewport.widthPx, reference.frame.viewport.heightPx);
  if (rgba.byteLength !== reference.png.rgbaByteLength) {
    throw new Error(`the decoded Cairo frame has ${rgba.byteLength} bytes, expected ${reference.png.rgbaByteLength}`);
  }
  requireDigest(sha256(rgba), reference.png.rgbaSha256, "the top-to-bottom Cairo RGBA frame");
  return { png, reference, rgba } as const;
}
