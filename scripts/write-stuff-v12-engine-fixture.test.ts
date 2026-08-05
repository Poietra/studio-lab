import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  deriveWriteStuffV12TransformPlan,
  FAST_MANIM_WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12,
  FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
} from "../server/fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "../server/fast-manim-source-runtime-document";
import { verifyFastManimSourceRuntimeIdentityV1 } from "../server/fast-manim-source-runtime-identity";
import { canonicalEngineBenchmarkJsonV1 } from "../src/engine/benchmark";
import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";

const FIXTURE_URL = new URL("../fixtures/engine-v1/real-write-stuff-v12.json", import.meta.url);
const EDITED_FIXTURE_URL = new URL("../fixtures/engine-v1/real-write-stuff-v12-edited.json", import.meta.url);
const ENGINE_COMMIT = "8b19ef72e425d41f271c785c74a0fd295a14b5b5";
const EDITED_ENGINE_COMMIT = "7b25d1ca96b8e6c3369344622de3ef5c32ac06fb";
const EDITED_SOURCE_SHA256 = "37179e2a50fc22e784962d26a7778f5c273c296d5fcbccf04d89fb7e55885d98";
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

function editedWriteStuffSource(official: string) {
  const anchor = '        group.width = config["frame_width"] - 2 * LARGE_BUFF\n';
  if (official.split(anchor).length !== 2) throw new Error("The exact official WriteStuff edit anchor is missing.");
  return official.replace(
    anchor,
    `${anchor}        example_tex.move_to((1.25, -0.5, 0))\n        example_tex.scale(0.5)\n`,
  );
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

async function generateEditedFixture() {
  const [wire, officialSource, manifestText] = await Promise.all([
    readFile(
      new URL("../server/test-fixtures/fast-manim-write-stuff-v12-edited-combined.json", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
    readFile(
      new URL("../server/test-fixtures/fast-manim-write-stuff-v12-edited-manifest.json", import.meta.url),
      "utf8",
    ),
  ]);
  const sourceText = editedWriteStuffSource(officialSource);
  expect(createHash("sha256").update(sourceText, "utf8").digest("hex")).toBe(EDITED_SOURCE_SHA256);
  const producer = parseFastManimProducerDocumentV1(wire);
  if (!producer.combined) throw new Error("Expected one actual combined edited fast-manim V12 fixture.");
  const manifest = JSON.parse(manifestText) as Readonly<{
    combinedWireSha256: string;
    fastManimCommit: string;
    fastManimTree: string;
    runtimeConfigHash: string;
    sealedSnapshotHash: string;
    snapshotDigest: string;
    sourceSha256: string;
  }>;
  expect(createHash("sha256").update(wire, "utf8").digest("hex")).toBe(manifest.combinedWireSha256);
  expect(producer.combined.snapshotDigest).toBe(manifest.snapshotDigest);
  expect(manifest.sourceSha256).toBe(EDITED_SOURCE_SHA256);
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    requestId: "req-1",
    runtimeConfigHash: manifest.runtimeConfigHash,
    sceneId: fastManimSnapshotSceneIdV1(FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12, "WriteStuff"),
    sceneName: "WriteStuff",
    snapshotVersion: 12,
    sourceHash: EDITED_SOURCE_SHA256,
    sourcePath: FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
    writeStuffV12Plan: deriveWriteStuffV12TransformPlan(sourceText, "WriteStuff"),
  } as const;
  expect(expected.writeStuffV12Plan).toEqual({ moveTo: { x: 1.25, y: -0.5 }, scale: 0.5 });
  const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
  if (sealed.kind !== "compiled") throw new Error("Edited WriteStuff V12 must seal as a compiled Scene IR bundle.");
  expect(sealed.snapshotHash).toBe(manifest.sealedSnapshotHash);
  expect(sealed.bundle.scene.entities).toHaveLength(61);
  expect(sealed.bundle.scene.animationChannels).toHaveLength(58);
  const identity = verifyFastManimSourceRuntimeIdentityV1(producer.combined, {
    expected,
    snapshot: sealed,
    sourceText,
  });
  expect(identity?.mappings.map(({ binding, familyPath }) => ({ familyPath, name: binding.name }))).toEqual([
    { familyPath: [], name: "group" },
    { familyPath: [0], name: "example_text" },
    { familyPath: [1], name: "example_tex" },
  ]);

  const sample = {
    evidence: ["actual producer-backed edited WriteStuff V12 hold fixture"],
    packetId: "real-write-stuff-v12-edited:hold",
    sampleTime: 3.5,
    viewport: VIEWPORT,
  } as const;
  const compiled = await compileEngineFrameV1({
    assets: sealed.bundle.assets,
    scene: sealed.bundle.scene,
    ...sample,
  });
  if (compiled.kind !== "ready") {
    throw new Error(`Edited WriteStuff V12 hold reference evaluation failed: ${compiled.message}`);
  }
  expect(compiled.frame.packet.draws).toHaveLength(29);

  return `${canonicalEngineBenchmarkJsonV1({
    assets: sealed.bundle.assets,
    id: "eng-v1-real-write-stuff-v12-edited",
    producerReference: {
      engineCommit: EDITED_ENGINE_COMMIT,
      fastManimCommit: manifest.fastManimCommit,
      fastManimTree: manifest.fastManimTree,
      kind: "server-sealed-real-fast-manim-profile-v12",
      producerSnapshotDigest: manifest.snapshotDigest,
      snapshotHash: sealed.snapshotHash,
      sourcePath: FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
      sourceSha256: EDITED_SOURCE_SHA256,
    },
    samples: [
      {
        expected: {
          semanticDigest: digestSemanticValue({
            camera: compiled.frame.packet.camera,
            compositing: compiled.frame.packet.compositing,
            draws: compiled.frame.packet.draws,
          }),
        },
        id: "hold",
        packetId: sample.packetId,
        sampleTime: sample.sampleTime,
        viewport: sample.viewport,
      },
    ],
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

  it("pins the actual producer output after the bounded equation move and scale", async () => {
    const generated = await generateEditedFixture();
    if (process.env.POIETRA_UPDATE_WRITE_STUFF_V12_EDITED_FIXTURE === "1") {
      await writeFile(EDITED_FIXTURE_URL, generated, "utf8");
    }
    await expect(readFile(EDITED_FIXTURE_URL, "utf8")).resolves.toBe(generated);
  });
});
