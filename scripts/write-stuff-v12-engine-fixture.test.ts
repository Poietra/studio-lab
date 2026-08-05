import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FAST_MANIM_WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12,
  FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
} from "../server/fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "../server/fast-manim-source-runtime-document";
import { canonicalEngineBenchmarkJsonV1 } from "../src/engine/benchmark";
import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";

const FIXTURE_URL = new URL("../fixtures/engine-v1/real-write-stuff-v12.json", import.meta.url);
const ENGINE_COMMIT = "8b19ef72e425d41f271c785c74a0fd295a14b5b5";
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
    readFile(new URL("../server/test-fixtures/fast-manim-write-stuff-v12-combined.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
    readFile(new URL("../server/test-fixtures/fast-manim-write-stuff-v12-manifest.json", import.meta.url), "utf8"),
  ]);
  const producer = parseFastManimProducerDocumentV1(wire);
  const manifest = JSON.parse(manifestText) as Readonly<{
    fastManimCommit: string;
    fastManimTree: string;
    runtimeConfigHash: string;
    snapshotDigest: string;
  }>;
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    requestId: "req-1",
    runtimeConfigHash: manifest.runtimeConfigHash,
    sceneId: fastManimSnapshotSceneIdV1(FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12, "WriteStuff"),
    sceneName: "WriteStuff",
    snapshotVersion: 12,
    sourceHash: FAST_MANIM_WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12,
    sourcePath: FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
  } as const;
  const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
  if (sealed.kind !== "compiled") throw new Error("WriteStuff V12 must seal as a compiled Scene IR bundle.");
  expect(sealed.bundle.scene.entities).toHaveLength(61);
  expect(sealed.bundle.scene.animationChannels).toHaveLength(58);

  const sampleDefinitions = [
    { drawCount: 1, id: "start", sampleTime: 0 },
    { drawCount: 3, id: "tex-early", sampleTime: 0.25 },
    { drawCount: 10, id: "tex-midpoint", sampleTime: 1 },
    { drawCount: 16, id: "math-start", sampleTime: 2 },
    { drawCount: 25, id: "math-midpoint", sampleTime: 2.5 },
    { drawCount: 29, id: "math-end", sampleTime: 3 },
    { drawCount: 29, id: "hold", sampleTime: 3.5 },
    { drawCount: 29, id: "end", sampleTime: 4 },
  ] as const;
  const samples = [];
  for (const sample of sampleDefinitions) {
    const packetId = `real-write-stuff-v12:${sample.id}`;
    const compiled = await compileEngineFrameV1({
      assets: sealed.bundle.assets,
      evidence: ["real WriteStuff V12 retained WebGPU fixture"],
      packetId,
      sampleTime: sample.sampleTime,
      scene: sealed.bundle.scene,
      viewport: VIEWPORT,
    });
    if (compiled.kind !== "ready") {
      throw new Error(`WriteStuff V12 ${sample.id} reference evaluation failed: ${compiled.message}`);
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

  return `${canonicalEngineBenchmarkJsonV1({
    assets: sealed.bundle.assets,
    id: "eng-v1-real-write-stuff-v12",
    producerReference: {
      engineCommit: ENGINE_COMMIT,
      fastManimCommit: manifest.fastManimCommit,
      fastManimTree: manifest.fastManimTree,
      kind: "server-sealed-real-fast-manim-profile-v12",
      producerSnapshotDigest: manifest.snapshotDigest,
      snapshotHash: sealed.snapshotHash,
      sourcePath: FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
      sourceSha256: FAST_MANIM_WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12,
    },
    samples,
    scene: sealed.bundle.scene,
  })}\n`;
}

describe("real WriteStuff V12 engine fixture", () => {
  it("is the reproducible sealed output of the actual fast-manim producer fixture", async () => {
    const generated = await generateFixture();
    if (process.env.POIETRA_UPDATE_WRITE_STUFF_V12_FIXTURE === "1") {
      await writeFile(FIXTURE_URL, generated, "utf8");
    }
    await expect(readFile(FIXTURE_URL, "utf8")).resolves.toBe(generated);
  });
});
