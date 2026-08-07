import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";
import { sceneIrBundleV1Schema } from "../src/engine/contracts";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FOURIER_V3_CAIRO_FRAME_INDICES_V1,
  FOURIER_V3_CAIRO_PARITY_THRESHOLDS_V1,
  fourierV3CairoReferenceV1Schema,
  readFourierV3CairoReferenceV1,
} from "./fourier-v3-cairo-reference";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("FourierSeriesSquareWave independent Cairo reference v1", () => {
  it("pins the reproducible V3 bundle without retaining the raw trace", async () => {
    const compressed = new Uint8Array(await readFile("fixtures/fourier-v3-runtime-trace-bundle-v1.json.gz"));
    expect(compressed).toHaveLength(578_619);
    expect(sha256(compressed)).toBe("7f0ec3ae93254aa729b9132ea9254a23463b8174ba5422ab9f6aeb4eb97af01a");
    const bundleBytes = gunzipSync(compressed);
    expect(bundleBytes).toHaveLength(4_946_702);
    expect(sha256(bundleBytes)).toBe("23e4c7bc36d093d240a3050ba8f49eb5e2f80bed1bafa43f5563bc4f99908d5d");
    const bundle = sceneIrBundleV1Schema.parse(JSON.parse(bundleBytes.toString("utf8")));
    expect(bundle.scene).toMatchObject({
      duration: 14.5,
      source: {
        kind: "imported-manim-runtime-trace",
        runtimeConfigHash: "746f68cc656a3045643730e4fab8a94d35351c04354d83d5a2ca88808fcef720",
        sourceHash: "3071f55153631e1b74df945fb0ebf57a56372bc0cb58498c58a01fcdf31fbd72",
        traceDigest: "2db39a97be84cc48c1547a09642b254f39b9cf46aabc403a9998d3ffa60b0f6b",
        traceVersion: 3,
      },
    });
    expect(bundle.scene.entities).toHaveLength(173);
    expect(bundle.scene.animationChannels).toHaveLength(50);
    expect(bundle.scene.provenance).toContainEqual({
      evidence: expect.arrayContaining([
        "post-evaluation 60 fps evidence from edcf6578d7b5515d39f9378d48b2c5e8f9a99fa6",
      ]),
      id: expect.any(String),
      origin: "fast-manim-runtime-trace",
    });
  });

  it("pins the source checkout, producer, renderer configuration, and seven complete frames", async () => {
    const { frames, reference } = await readFourierV3CairoReferenceV1();
    expect(sha256(Buffer.from(canonicalJsonV1(reference), "utf8"))).toBe(
      "03180de913824ff7aaa5b413721d9297c2314e112dbef74c613118b14342a353",
    );
    expect(reference).toMatchObject({
      codebase: {
        repository: "https://github.com/HarleyCoops/Math-To-Manim.git",
        revision: "fcad0674c9791690d47664492fd1a052024b63a0",
        tree: "d71dcdbdac8bf52bd8fd2e6540d36136ce9ae698",
      },
      frame: { frameRate: 60, totalFrames: 870, viewport: { heightPx: 360, widthPx: 640 } },
      producer: {
        identitySha256: "acc0c1fcaeab6fed6cfea1ba9d5b6f0c720adad6f3b8f51031051527a07ea9e6",
        fastManimCommit: "edcf6578d7b5515d39f9378d48b2c5e8f9a99fa6",
        fastManimTree: "806b84287549a874393046e35663f07a7ed576d4",
      },
      rendererConfig: { identitySha256: "b1b2f6e851e59bbc0938b0bf59afcc72139368f8e3ab027e7bbf9d87e6f47df1" },
      scene: {
        className: "FourierSeriesSquareWave",
        sourcePath: "legacy/Math-To-Manim/examples/mathematics/trigonometry/TrigInference.py",
        sourceSha256: "3071f55153631e1b74df945fb0ebf57a56372bc0cb58498c58a01fcdf31fbd72",
      },
    });
    expect(reference.frames.map(({ frameIndex }) => frameIndex)).toEqual(FOURIER_V3_CAIRO_FRAME_INDICES_V1);
    expect(frames.size).toBe(7);
    for (const frame of frames.values()) expect(frame.rgba).toHaveLength(640 * 360 * 4);
    expect(FOURIER_V3_CAIRO_PARITY_THRESHOLDS_V1).toEqual({
      maximumPixelFractionAboveThreshold: 0.005,
      minimumSsim: 0.995,
    });
  });

  it("keeps the 10-second play-end state distinct from the following Create start", async () => {
    const { frames } = await readFourierV3CairoReferenceV1();
    const digest = (frameIndex: number) => {
      const frame = frames.get(frameIndex);
      if (!frame) throw new Error(`Missing Fourier Cairo frame ${frameIndex}.`);
      return sha256(frame.rgba);
    };
    expect(digest(600)).not.toBe(digest(630));
    expect(digest(690)).toBe(digest(869));
    expect(frames.get(600)?.sampleTime).toBe(10);
    expect(frames.get(630)?.sampleTime).toBe(10.5);
  });

  it("rejects an unpinned frame envelope", () => {
    expect(
      fourierV3CairoReferenceV1Schema.safeParse({
        schema: "poietra.fourier-v3-independent-cairo-reference",
        version: 1,
      }).success,
    ).toBe(false);
  });
});
