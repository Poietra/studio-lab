import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;
const RGBA_BYTE_LENGTH = VIEWPORT.widthPx * VIEWPORT.heightPx * 4;

export const OPENING_MANIM_CAIRO_PARITY_THRESHOLDS_V1 = {
  maximumPixelFractionAboveThreshold: 0.008,
  minimumSsim: 0.999,
  reason:
    "Independent Cairo and retained WebGPU edge antialiasing differ while preserving the exact OpeningManim geometry, timing, paint, and hold.",
} as const;

export const OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V1 = [
  ["initial", 0, 0],
  ["animation-midpoint", 60, 1],
  ["play-end", 120, 2],
  ["wait-end", 179, 3],
] as const;

function frameSchema(
  id: (typeof OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V1)[number][0],
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

function executableSchema(executableSha256: string, version: string) {
  return z.strictObject({
    executableSha256: z.literal(executableSha256),
    version: z.literal(version),
  });
}

function artifactFileSchema(cacheFileName: string, path: string, byteLength: number, sha256: string) {
  return z.strictObject({
    byteLength: z.literal(byteLength),
    cacheFileName: z.literal(cacheFileName),
    path: z.literal(path),
    sha256: z.literal(sha256),
  });
}

export const openingManimCairoReferenceV1Schema = z.strictObject({
  frame: z.strictObject({
    background: z.literal("opaque-black"),
    camera: z.strictObject({ height: z.literal(8), width: z.literal(128 / 9) }),
    colorDomain: z.literal("srgb-u8"),
    frameRate: z.literal(60),
    viewport: z.strictObject({ heightPx: z.literal(VIEWPORT.heightPx), widthPx: z.literal(VIEWPORT.widthPx) }),
  }),
  frames: z.tuple([
    frameSchema("initial", 0, 0),
    frameSchema("animation-midpoint", 60, 1),
    frameSchema("play-end", 120, 2),
    frameSchema("wait-end", 179, 3),
  ]),
  producer: z.strictObject({
    cairoLibrarySha256: SHA256,
    cairoVersion: z.string().min(1),
    fastManimCommit: z.literal("1227d2c03f16a6d504e90ffc23ba574ee0a88b37"),
    fastManimTree: z.literal("63e0e988235fb103aa01288593c5d7dbe7421564"),
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
    texArtifacts: z.tuple([
      z.strictObject({
        role: z.literal("title"),
        svg: artifactFileSchema(
          "1b14fa4e39b328e9.svg",
          "tex/title.svg",
          10_374,
          "520a19f97782bb5ddae2009e67745d1e95f42af235715220b45a6d30d943b5d2",
        ),
        tex: artifactFileSchema(
          "1b14fa4e39b328e9.tex",
          "tex/title.tex",
          251,
          "1b14fa4e39b328e9e7cefa1c6635728d74461825efd834128132ace12e7e007c",
        ),
      }),
      z.strictObject({
        role: z.literal("basel"),
        svg: artifactFileSchema(
          "e931457a6a9eb28b.svg",
          "tex/basel.svg",
          10_725,
          "3bd472c6869a6b0019633570fc63861063cc4c98c39e6ee54da677278b63b133",
        ),
        tex: artifactFileSchema(
          "e931457a6a9eb28b.tex",
          "tex/basel.tex",
          281,
          "e931457a6a9eb28bf2c3d4be9881d4070484a446f60454f37df94fb5eff7ffe3",
        ),
      }),
    ]),
    texToolchain: z.strictObject({
      dvisvgm: executableSchema("f71f47113ad9a77b9d2b01dd5d938e3537c60d1ee7f342ec273ed061d5e51b38", "dvisvgm 3.6"),
      kpsewhich: executableSchema(
        "c6236612bf273b4ce314c6fc5536401d1bd9e3597d1ee8b34900692879cd3fe9",
        "kpathsea version 6.4.2",
      ),
      latex: executableSchema(
        "1c5ff71156ee990c3a18402cf06d3671ecf748bd84fb3983dbd5d62b600bc40b",
        "pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)",
      ),
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
    className: z.literal("OpeningManim"),
    repository: z.literal("Poietra/fast-manim"),
    slice: z.strictObject({
      duration: z.literal(3),
      frameCount: z.literal(180),
      start: z.literal(0),
    }),
    sourcePath: z.literal("example_scenes/basic.py"),
    sourceSha256: z.literal("d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f"),
    texImplementation: z.literal("normal-manim-latex-dvisvgm"),
  }),
  schema: z.literal("poietra.opening-manim-cairo-reference"),
  version: z.literal(1),
});

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label} hashes to ${actual}, expected ${expected}`);
}

export async function readOpeningManimCairoReferenceV1(root: string) {
  const reference = openingManimCairoReferenceV1Schema.parse(
    JSON.parse(await readFile(join(root, "reference.json"), "utf8")),
  );
  const { identitySha256: producerDigest, ...producerIdentity } = reference.producer;
  requireDigest(sha256(canonicalJsonV1(producerIdentity)), producerDigest, "the Cairo producer identity");
  requireDigest(
    sha256(canonicalJsonV1(reference.rendererConfig.values)),
    reference.rendererConfig.identitySha256,
    "the Cairo renderer configuration",
  );

  for (const artifact of reference.producer.texArtifacts) {
    for (const kind of ["tex", "svg"] as const) {
      const metadata = artifact[kind];
      const bytes = new Uint8Array(await readFile(join(root, metadata.path)));
      if (bytes.byteLength !== metadata.byteLength) {
        throw new Error(`the ${artifact.role} ${kind} has ${bytes.byteLength} bytes, expected ${metadata.byteLength}`);
      }
      requireDigest(sha256(bytes), metadata.sha256, `the ${artifact.role} generated ${kind}`);
    }
  }

  const frames = new Map<
    (typeof OPENING_MANIM_CAIRO_REFERENCE_SAMPLES_V1)[number][0],
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
