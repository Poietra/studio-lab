import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FAST_MANIM_WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12,
  FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
} from "../server/fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "../server/fast-manim-source-runtime-document";

const FIXTURE_URL = new URL("../fixtures/engine-v1/real-write-stuff-v12.json", import.meta.url);
const ENGINE_COMMIT = "8b19ef72e425d41f271c785c74a0fd295a14b5b5";

async function reproduceOfficialScene() {
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
  return {
    bundle: sealed.bundle,
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
  };
}

describe("real WriteStuff V12 engine fixture", () => {
  it("pins the official producer-sealed Scene while Rust owns sample evaluation", async () => {
    const reproduced = await reproduceOfficialScene();
    const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
    expect(fixture).toMatchObject({
      assets: reproduced.bundle.assets,
      id: "eng-v1-real-write-stuff-v12",
      producerReference: reproduced.producerReference,
      scene: reproduced.bundle.scene,
    });
  });
});
