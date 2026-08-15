import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { withGeneratedRuntimeTraceCairoReferenceV1 } from "./runtime-trace-cairo-reference-runner";
import { compareSquareToCircleCairoWebGpuFramesV1 } from "./square-to-circle-cairo-parity";
import {
  readSquareToCircleCairoReferenceV1,
  SQUARE_TO_CIRCLE_CAIRO_FAST_MANIM_COMMIT_V1,
  SQUARE_TO_CIRCLE_CAIRO_FAST_MANIM_TREE_V1,
  SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1,
  SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V1,
  squareToCircleCairoReferenceV1Schema,
} from "./square-to-circle-cairo-reference";

const REAL_GENERATOR_AVAILABLE = Boolean(
  process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND?.trim() &&
    process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_REPOSITORY?.trim(),
);
const GENERATOR_PATH = "scripts/generate-square-to-circle-cairo-reference.py";
const temporaryRoots: string[] = [];

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

const digest = "0".repeat(64);
const rendererValues = {
  antialias: "default",
  backgroundColor: "#000000",
  backgroundOpacity: 1,
  cairoCompositor: false,
  cairoCompositorFades: false,
  cairoForkWorkers: 0,
  cairoStaticLayers: false,
  disableCaching: true,
  format: "png",
  frameHeight: 8,
  frameRate: 60,
  frameWidth: 128 / 9,
  pixelHeight: 360,
  pixelWidth: 640,
  renderer: "cairo",
  saveLastFrame: false,
  savePngs: false,
  seed: 0,
  transparent: false,
  verbosity: "WARNING",
  writeToMovie: false,
} as const;

async function writeValidReference() {
  const root = await mkdtemp(join(tmpdir(), "poietra-square-to-circle-reader-"));
  temporaryRoots.push(root);
  const rgba = new Uint8Array(640 * 360 * 4);
  for (let offset = 3; offset < rgba.byteLength; offset += 4) rgba[offset] = 255;
  const rgbaSha256 = sha256(rgba);
  const producerIdentity = {
    cairoVersion: "1.18.0",
    fastManimCommit: SQUARE_TO_CIRCLE_CAIRO_FAST_MANIM_COMMIT_V1,
    fastManimTree: SQUARE_TO_CIRCLE_CAIRO_FAST_MANIM_TREE_V1,
    manimVersion: "0.20.1",
    numpyVersion: "2.0.0",
    pycairoVersion: "1.27.0",
    renderer: "cairo",
  } as const;
  const frames = SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1.map(([id, sampleTime]) => ({
    id,
    sampleTime,
    rgba: {
      byteLength: rgba.byteLength,
      channelOrder: "rgba",
      path: `${id}.rgba`,
      rowOrder: "top-to-bottom",
      sha256: rgbaSha256,
    },
  }));
  await Promise.all(frames.map((frame) => writeFile(join(root, frame.rgba.path), rgba)));
  const reference = {
    frame: {
      background: "opaque-black",
      camera: { height: 8, width: 128 / 9 },
      colorDomain: "srgb-u8",
      frameRate: 60,
      viewport: { heightPx: 360, widthPx: 640 },
    },
    frames,
    producer: { ...producerIdentity, identitySha256: sha256(canonicalJsonV1(producerIdentity)) },
    rendererConfig: {
      identitySha256: sha256(canonicalJsonV1(rendererValues)),
      values: rendererValues,
    },
    reproducibility: {
      environment: { PYTHONHASHSEED: "0" },
      seeds: { numpy: 0, pythonRandom: 0 },
    },
    scene: {
      className: "SquareToCircle",
      repository: "Poietra/fast-manim",
      slice: { duration: 3, start: 0 },
      sourcePath: "example_scenes/basic.py",
      sourceSha256: SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V1,
    },
    schema: "poietra.square-to-circle-cairo-reference",
    version: 1,
  };
  await writeFile(join(root, "reference.json"), `${JSON.stringify(reference)}\n`, "utf8");
  return { reference, rgba, root };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("SquareToCircle Cairo reference v1", () => {
  it("keeps the generated evidence envelope strict", () => {
    expect(
      squareToCircleCairoReferenceV1Schema.safeParse({
        schema: "poietra.square-to-circle-cairo-reference",
        unverifiedFrame: true,
        version: 1,
      }).success,
    ).toBe(false);
  });

  it("validates the source identity and all four opaque RGBA payloads", async () => {
    const { rgba, root } = await writeValidReference();
    const { frames, reference } = await readSquareToCircleCairoReferenceV1(
      root,
      SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V1,
    );
    expect(reference.frames.map(({ id, sampleTime }) => [id, sampleTime])).toEqual(
      SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1,
    );
    expect(frames.size).toBe(4);
    expect(sha256(frames.get("analytic-winding-root")?.rgba ?? new Uint8Array())).toBe(sha256(rgba));
    await expect(readSquareToCircleCairoReferenceV1(root, digest)).rejects.toThrow(/Cairo source hashes/u);
  });

  it("fails closed when a referenced RGBA payload changes", async () => {
    const { root } = await writeValidReference();
    await writeFile(join(root, "transform-midpoint.rgba"), new Uint8Array(640 * 360 * 4));
    await expect(readSquareToCircleCairoReferenceV1(root, SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V1)).rejects.toThrow(
      /transform-midpoint top-to-bottom Cairo RGBA frame hashes/u,
    );
  });

  it("uses the shared visual-parity contract and emits per-sample diagnostics", async () => {
    const { rgba, root } = await writeValidReference();
    const outputRoot = await mkdtemp(join(tmpdir(), "poietra-square-to-circle-parity-"));
    temporaryRoots.push(outputRoot);
    const comparisons = await compareSquareToCircleCairoWebGpuFramesV1({
      cairoReferenceRoot: root,
      expectedSourceSha256: SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V1,
      frames: SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1.map(([id, sampleTime]) => ({
        id,
        rgba,
        sampleTime,
      })),
      outputRoot,
    });
    expect(comparisons.map(({ id, passed }) => [id, passed])).toEqual(
      SQUARE_TO_CIRCLE_CAIRO_REFERENCE_SAMPLES_V1.map(([id]) => [id, true]),
    );
    const rootReport = JSON.parse(await readFile(join(outputRoot, "analytic-winding-root/report.json"), "utf8"));
    expect(rootReport).toMatchObject({
      frame: { id: "analytic-winding-root", sampleTime: 1.5119159473817447 },
      gate: { passed: true },
      schema: "poietra.square-to-circle-cairo-parity-report",
      version: 1,
    });
  });

  it.runIf(REAL_GENERATOR_AVAILABLE)(
    "renders a paired move_to candidate at all four exact sample times while retaining its logical path",
    async () => {
      const official = await readFile(
        new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
        "utf8",
      );
      const anchor = "        circle.set_fill(PINK, opacity=0.5)\n\n        self.play(Create(square))";
      const sourceText = official.replace(
        anchor,
        "        circle.set_fill(PINK, opacity=0.5)\n        square.move_to((2, 1, 0))\n        circle.move_to((2, 1, 0))\n\n        self.play(Create(square))",
      );
      if (sourceText === official || sourceText.includes(anchor)) {
        throw new Error("The SquareToCircle candidate source anchor is not unique.");
      }
      const expectedSourceSha256 = sha256(sourceText);
      const { frames, reference } = await withGeneratedRuntimeTraceCairoReferenceV1({
        generatorPath: GENERATOR_PATH,
        read: (root) => readSquareToCircleCairoReferenceV1(root, expectedSourceSha256),
        sourceText,
        temporaryPrefix: "poietra-square-to-circle-cairo-candidate-",
      });
      expect(reference.scene).toEqual({
        className: "SquareToCircle",
        repository: "Poietra/fast-manim",
        slice: { duration: 3, start: 0 },
        sourcePath: "example_scenes/basic.py",
        sourceSha256: expectedSourceSha256,
      });
      expect(frames.size).toBe(4);
      expect(new Set([...frames.values()].map((frame) => sha256(frame.rgba))).size).toBe(4);
    },
  );
});
