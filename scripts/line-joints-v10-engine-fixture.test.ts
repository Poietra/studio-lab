import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FAST_MANIM_LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
} from "../server/fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "../server/fast-manim-source-runtime-document";
import { canonicalEngineBenchmarkJsonV1 } from "../src/engine/benchmark";
import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";

const FIXTURE_URL = new URL("../fixtures/engine-v1/real-line-joints-v10.json", import.meta.url);
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
    readFile(new URL("../server/test-fixtures/fast-manim-line-joints-v10-combined.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
    readFile(new URL("../server/test-fixtures/fast-manim-line-joints-v10-manifest.json", import.meta.url), "utf8"),
  ]);
  const producer = parseFastManimProducerDocumentV1(wire);
  const manifest = JSON.parse(manifestText) as Readonly<{
    fastManimCommit: string;
    runtimeConfigHash: string;
    sealedSnapshotHash: string;
  }>;
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    requestId: "req-1",
    runtimeConfigHash: manifest.runtimeConfigHash,
    sceneId: fastManimSnapshotSceneIdV1(SOURCE_PATH, "LineJoints"),
    sceneName: "LineJoints",
    snapshotVersion: 10,
    sourceHash: FAST_MANIM_LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10,
    sourcePath: SOURCE_PATH,
  } as const;
  const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
  if (sealed.kind !== "compiled") throw new Error("LineJoints V10 must seal as a compiled Scene IR bundle.");
  const sample = {
    evidence: ["real LineJoints V10 retained WebGPU fixture"],
    packetId: "real-line-joints-v10:static",
    sampleTime: 0.5,
    viewport: VIEWPORT,
  } as const;
  const compiled = await compileEngineFrameV1({ assets: sealed.bundle.assets, scene: sealed.bundle.scene, ...sample });
  if (compiled.kind !== "ready") throw new Error(`LineJoints V10 reference evaluation failed: ${compiled.message}`);
  const fixture = {
    assets: sealed.bundle.assets,
    id: "eng-v1-real-line-joints-v10",
    producerReference: {
      engineCommit: "99a6dcfc3831e77c18977ffa29879b1ef30c2c7c",
      fastManimCommit: manifest.fastManimCommit,
      kind: "server-sealed-real-fast-manim-profile-v10",
      snapshotHash: sealed.snapshotHash,
      sourcePath: SOURCE_PATH,
      sourceSha256: FAST_MANIM_LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10,
    },
    samples: [
      {
        expected: {
          semanticDigest: digestSemanticValue({
            camera: compiled.frame.packet.camera,
            draws: compiled.frame.packet.draws,
          }),
        },
        id: "static",
        packetId: sample.packetId,
        sampleTime: sample.sampleTime,
        viewport: sample.viewport,
      },
    ],
    scene: sealed.bundle.scene,
  };
  expect(sealed.snapshotHash).toBe(manifest.sealedSnapshotHash);
  expect(compiled.frame.packet.draws).toHaveLength(3);
  return `${canonicalEngineBenchmarkJsonV1(fixture)}\n`;
}

describe("real LineJoints V10 engine fixture", () => {
  it("is the reproducible sealed output of the actual fast-manim producer fixture", async () => {
    const generated = await generateFixture();
    if (process.env.POIETRA_UPDATE_LINE_JOINTS_V10_FIXTURE === "1") {
      await writeFile(FIXTURE_URL, generated, "utf8");
    }
    await expect(readFile(FIXTURE_URL, "utf8")).resolves.toBe(generated);
  });
});
