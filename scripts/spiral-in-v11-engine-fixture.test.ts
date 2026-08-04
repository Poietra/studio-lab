import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FAST_MANIM_SPIRAL_IN_OFFICIAL_SOURCE_SHA256_V11,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
} from "../server/fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "../server/fast-manim-source-runtime-document";
import { canonicalEngineBenchmarkJsonV1 } from "../src/engine/benchmark";
import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";

const FIXTURE_URL = new URL("../fixtures/engine-v1/real-spiral-in-v11.json", import.meta.url);
const SOURCE_PATH = "example_scenes/basic.py";
const VIEWPORT = { heightPx: 360, widthPx: 640 } as const;
const SEMANTIC_NUMBER_SCALE = 1_000_000_000;

function normalizeSemanticNumbers(value: unknown): unknown {
  if (typeof value === "number") return Math.sign(value) * Math.round(Math.abs(value) * SEMANTIC_NUMBER_SCALE);
  if (Array.isArray(value)) return value.map(normalizeSemanticNumbers);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeSemanticNumbers(entry)]));
  }
  return value;
}

function digestSemanticValue(value: unknown) {
  return createHash("sha256")
    .update(canonicalEngineBenchmarkJsonV1(normalizeSemanticNumbers(value)), "utf8")
    .digest("hex");
}

async function generateFixture() {
  const [wire, sourceText, manifestText] = await Promise.all([
    readFile(new URL("../server/test-fixtures/fast-manim-spiral-in-v11-combined.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
    readFile(new URL("../server/test-fixtures/fast-manim-spiral-in-v11-manifest.json", import.meta.url), "utf8"),
  ]);
  const producer = parseFastManimProducerDocumentV1(wire);
  const manifest = JSON.parse(manifestText) as Readonly<{
    fastManimCommit: string;
    fastManimTree: string;
    runtimeConfigHash: string;
    sealedSnapshotHash: string;
    snapshotDigest: string;
  }>;
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    requestId: "req-1",
    runtimeConfigHash: manifest.runtimeConfigHash,
    sceneId: fastManimSnapshotSceneIdV1(SOURCE_PATH, "SpiralInExample"),
    sceneName: "SpiralInExample",
    snapshotVersion: 11,
    sourceHash: FAST_MANIM_SPIRAL_IN_OFFICIAL_SOURCE_SHA256_V11,
    sourcePath: SOURCE_PATH,
  } as const;
  const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
  if (sealed.kind !== "compiled") throw new Error("SpiralIn V11 must seal as a compiled Scene IR bundle.");
  const sampleDefinitions = [
    { drawCount: 5, id: "start", sampleTime: 0 },
    { drawCount: 5, id: "early-reveal", sampleTime: 0.1 },
    { drawCount: 5, id: "spiral-midpoint", sampleTime: 0.5 },
    { drawCount: 5, id: "spiral-end", sampleTime: 1 },
    { drawCount: 5, id: "hold", sampleTime: 1.5 },
    { drawCount: 5, id: "group-fade-midpoint", sampleTime: 2.5 },
    { drawCount: 0, id: "end", sampleTime: 3 },
  ] as const;
  const samples = [];
  for (const sample of sampleDefinitions) {
    const packetId = `real-spiral-in-v11:${sample.id}`;
    const compiled = await compileEngineFrameV1({
      assets: sealed.bundle.assets,
      evidence: ["real SpiralIn V11 retained WebGPU fixture"],
      packetId,
      sampleTime: sample.sampleTime,
      scene: sealed.bundle.scene,
      viewport: VIEWPORT,
    });
    if (compiled.kind !== "ready") {
      throw new Error(`SpiralIn V11 ${sample.id} reference evaluation failed: ${compiled.message}`);
    }
    expect(compiled.frame.packet.draws).toHaveLength(sample.drawCount);
    samples.push({
      expected: {
        semanticDigest: digestSemanticValue({
          camera: compiled.frame.packet.camera,
          compositing: compiled.frame.packet.compositing,
          draws: compiled.frame.packet.draws,
        }),
      },
      id: sample.id,
      packetId,
      sampleTime: sample.sampleTime,
      viewport: VIEWPORT,
    });
  }
  const fixture = {
    assets: sealed.bundle.assets,
    id: "eng-v1-real-spiral-in-v11",
    producerReference: {
      engineCommit: "e5423a8cb79a8326d42337e204ed12784750cdf1",
      fastManimCommit: manifest.fastManimCommit,
      fastManimTree: manifest.fastManimTree,
      kind: "server-sealed-real-fast-manim-profile-v11",
      producerSnapshotDigest: manifest.snapshotDigest,
      snapshotHash: sealed.snapshotHash,
      sourcePath: SOURCE_PATH,
      sourceSha256: FAST_MANIM_SPIRAL_IN_OFFICIAL_SOURCE_SHA256_V11,
    },
    samples,
    scene: sealed.bundle.scene,
  };
  expect(sealed.snapshotHash).toBe(manifest.sealedSnapshotHash);
  return `${canonicalEngineBenchmarkJsonV1(fixture)}\n`;
}

describe("real SpiralIn V11 engine fixture", () => {
  it("is the reproducible sealed output of the actual fast-manim producer fixture", async () => {
    const generated = await generateFixture();
    if (process.env.POIETRA_UPDATE_SPIRAL_IN_V11_FIXTURE === "1") {
      await writeFile(FIXTURE_URL, generated, "utf8");
    }
    await expect(readFile(FIXTURE_URL, "utf8")).resolves.toBe(generated);
  });
});
