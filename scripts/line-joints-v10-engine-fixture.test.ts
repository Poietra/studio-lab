import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FAST_MANIM_LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
} from "../server/fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "../server/fast-manim-source-runtime-document";

const FIXTURE_URL = new URL("../fixtures/engine-v1/real-line-joints-v10.json", import.meta.url);
const SOURCE_PATH = "example_scenes/basic.py";

async function reproduceSealedScene() {
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
  expect(sealed.snapshotHash).toBe(manifest.sealedSnapshotHash);
  return {
    bundle: sealed.bundle,
    producerReference: {
      engineCommit: "99a6dcfc3831e77c18977ffa29879b1ef30c2c7c",
      fastManimCommit: manifest.fastManimCommit,
      kind: "server-sealed-real-fast-manim-profile-v10",
      snapshotHash: sealed.snapshotHash,
      sourcePath: SOURCE_PATH,
      sourceSha256: FAST_MANIM_LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10,
    },
  };
}

describe("real LineJoints V10 engine fixture", () => {
  it("pins the producer-sealed Scene while Rust owns sample evaluation", async () => {
    const reproduced = await reproduceSealedScene();
    const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
    expect(fixture).toMatchObject({
      assets: reproduced.bundle.assets,
      id: "eng-v1-real-line-joints-v10",
      producerReference: reproduced.producerReference,
      scene: reproduced.bundle.scene,
    });
    expect(
      fixture.samples.map(({ id, packetId, sampleTime }: Record<string, unknown>) => ({ id, packetId, sampleTime })),
    ).toEqual([{ id: "static", packetId: "real-line-joints-v10:static", sampleTime: 0.5 }]);
  });
});
