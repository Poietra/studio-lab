import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { decodeRgbaPngV1 } from "./png-rgba";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const COMMIT_SHA = z.string().regex(/^[0-9a-f]{40}$/);
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;

export const WRITE_STUFF_CAIRO_REFERENCE_ROOT_V1 = "fixtures/write-stuff-cairo-reference-v1";
export const WRITE_STUFF_EDITED_CAIRO_REFERENCE_ROOT_V1 = "fixtures/write-stuff-cairo-reference-v1-edited";
export const WRITE_STUFF_CAIRO_REFERENCE_SAMPLES_V1 = [
  ["real-write-stuff-v12--start", "start", 0],
  ["real-write-stuff-v12--tex-early", "tex-early", 0.25],
  ["real-write-stuff-v12--tex-midpoint", "tex-midpoint", 1],
  ["real-write-stuff-v12--math-start", "math-start", 2],
  ["real-write-stuff-v12--math-midpoint", "math-midpoint", 2.5],
  ["real-write-stuff-v12--math-end", "math-end", 3],
  ["real-write-stuff-v12--hold", "hold", 3.5],
  ["real-write-stuff-v12--end", "end", 4],
] as const;
export const WRITE_STUFF_CAIRO_REFERENCE_ENTRY_IDS_V1 = WRITE_STUFF_CAIRO_REFERENCE_SAMPLES_V1.map(
  ([entryId]) => entryId,
);
export const WRITE_STUFF_EDITED_CAIRO_REFERENCE_SAMPLES_V1 = [
  ["real-write-stuff-v12-edited--hold", "hold", 3.5],
] as const;
export const WRITE_STUFF_EDITED_CAIRO_REFERENCE_ENTRY_IDS_V1 = WRITE_STUFF_EDITED_CAIRO_REFERENCE_SAMPLES_V1.map(
  ([entryId]) => entryId,
);
export const WRITE_STUFF_CAIRO_PARITY_THRESHOLDS_V1 = {
  maximumPixelFractionAboveThreshold: 0.02,
  minimumSsim: 0.994,
  reason:
    "Independent Cairo and Lyon/WGPU edge antialiasing differ while preserving the exact WriteStuff glyph order, paint, two Write phases, and final hold.",
} as const;

const PRODUCER_IDENTITY_FIELDS = {
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
} as const;

function texCacheFileSchema(path: string) {
  return z.strictObject({ path: z.literal(path), sha256: SHA256 });
}

function frameSchema(id: (typeof WRITE_STUFF_CAIRO_REFERENCE_SAMPLES_V1)[number][1], sampleTime: number) {
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

export const writeStuffCairoReferenceV1Schema = z.strictObject({
  frame: z.strictObject({
    background: z.literal("opaque-black"),
    camera: z.strictObject({ height: z.literal(8), width: z.literal(128 / 9) }),
    colorDomain: z.literal("srgb-u8"),
    frameRate: z.literal(60),
    viewport: z.strictObject({ heightPx: z.literal(VIEWPORT.heightPx), widthPx: z.literal(VIEWPORT.widthPx) }),
  }),
  frames: z.tuple([
    frameSchema("start", 0),
    frameSchema("tex-early", 0.25),
    frameSchema("tex-midpoint", 1),
    frameSchema("math-start", 2),
    frameSchema("math-midpoint", 2.5),
    frameSchema("math-end", 3),
    frameSchema("hold", 3.5),
    frameSchema("end", 4),
  ]),
  producer: z.union([
    z.strictObject({
      ...PRODUCER_IDENTITY_FIELDS,
      texToolchain: z.strictObject({
        dvisvgm: z.strictObject({ executableSha256: SHA256, version: z.string().min(1) }),
        latex: z.strictObject({ executableSha256: SHA256, version: z.string().min(1) }),
      }),
    }),
    z.strictObject({
      ...PRODUCER_IDENTITY_FIELDS,
      texCache: z.strictObject({
        files: z.tuple([
          texCacheFileSchema("2001da0d734dc8fc.tex"),
          texCacheFileSchema("2001da0d734dc8fc.svg"),
          texCacheFileSchema("5c2081ce9e37598c.tex"),
          texCacheFileSchema("5c2081ce9e37598c.svg"),
          texCacheFileSchema("8f249e3b899ba7b1.tex"),
          texCacheFileSchema("8f249e3b899ba7b1.svg"),
        ]),
        kind: z.literal("pinned-manim-dvisvgm-svg"),
      }),
    }),
  ]),
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
    className: z.literal("WriteStuff"),
    repository: z.literal("Poietra/fast-manim"),
    sourcePath: z.literal("example_scenes/basic.py"),
    sourceSha256: SHA256,
  }),
  schema: z.literal("poietra.write-stuff-cairo-reference"),
  version: z.literal(1),
});

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label} hashes to ${actual}, expected ${expected}`);
}

export async function readWriteStuffCairoReferenceV1(root = WRITE_STUFF_CAIRO_REFERENCE_ROOT_V1) {
  const reference = writeStuffCairoReferenceV1Schema.parse(
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
    (typeof WRITE_STUFF_CAIRO_REFERENCE_SAMPLES_V1)[number][1],
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

export async function readWriteStuffCairoReferenceForEntryV1(entryId: string) {
  const official = WRITE_STUFF_CAIRO_REFERENCE_SAMPLES_V1.find(([candidate]) => candidate === entryId);
  const edited = WRITE_STUFF_EDITED_CAIRO_REFERENCE_SAMPLES_V1.find(([candidate]) => candidate === entryId);
  const sample = official ?? edited;
  if (!sample) throw new Error(`Visual-parity entry ${entryId} has no independent WriteStuff Cairo reference.`);
  const result = await readWriteStuffCairoReferenceV1(
    edited ? WRITE_STUFF_EDITED_CAIRO_REFERENCE_ROOT_V1 : WRITE_STUFF_CAIRO_REFERENCE_ROOT_V1,
  );
  const frame = result.frames.get(sample[1]);
  if (!frame) throw new Error(`WriteStuff Cairo reference is missing ${sample[1]}.`);
  return { ...frame, reference: result.reference } as const;
}
