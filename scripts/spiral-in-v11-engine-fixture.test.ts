import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FAST_MANIM_SPIRAL_IN_OFFICIAL_SOURCE_SHA256_V11,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
} from "../server/fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "../server/fast-manim-source-runtime-document";

const FIXTURE_URL = new URL("../fixtures/engine-v1/real-spiral-in-v11.json", import.meta.url);
const SOURCE_PATH = "example_scenes/basic.py";

async function reproduceSealedScene() {
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
  expect(sealed.snapshotHash).toBe(manifest.sealedSnapshotHash);
  return {
    bundle: sealed.bundle,
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
  };
}

describe("real SpiralIn V11 engine fixture", () => {
  it("pins the producer-sealed Scene while Rust owns sample evaluation", async () => {
    const reproduced = await reproduceSealedScene();
    const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
    expect(fixture).toMatchObject({
      assets: reproduced.bundle.assets,
      id: "eng-v1-real-spiral-in-v11",
      producerReference: reproduced.producerReference,
      scene: reproduced.bundle.scene,
    });
    expect(
      fixture.samples.map(({ id, packetId, sampleTime }: Record<string, unknown>) => ({ id, packetId, sampleTime })),
    ).toEqual([
      { id: "start", packetId: "real-spiral-in-v11:start", sampleTime: 0 },
      { id: "early-reveal", packetId: "real-spiral-in-v11:early-reveal", sampleTime: 0.1 },
      { id: "spiral-midpoint", packetId: "real-spiral-in-v11:spiral-midpoint", sampleTime: 0.5 },
      { id: "spiral-end", packetId: "real-spiral-in-v11:spiral-end", sampleTime: 1 },
      { id: "hold", packetId: "real-spiral-in-v11:hold", sampleTime: 1.5 },
      { id: "group-fade-midpoint", packetId: "real-spiral-in-v11:group-fade-midpoint", sampleTime: 2.5 },
      { id: "end", packetId: "real-spiral-in-v11:end", sampleTime: 3 },
    ]);
  });
});
