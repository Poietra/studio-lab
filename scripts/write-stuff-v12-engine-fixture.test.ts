import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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

const FIXTURE_URL = new URL("../fixtures/engine-v1/real-write-stuff-v12.json", import.meta.url);
const EDITED_FIXTURE_URL = new URL("../fixtures/engine-v1/real-write-stuff-v12-edited.json", import.meta.url);
const ENGINE_COMMIT = "8b19ef72e425d41f271c785c74a0fd295a14b5b5";
const EDITED_ENGINE_COMMIT = "7b25d1ca96b8e6c3369344622de3ef5c32ac06fb";
const EDITED_SOURCE_SHA256 = "37179e2a50fc22e784962d26a7778f5c273c296d5fcbccf04d89fb7e55885d98";

function editedWriteStuffSource(official: string) {
  const anchor = '        group.width = config["frame_width"] - 2 * LARGE_BUFF\n';
  if (official.split(anchor).length !== 2) throw new Error("The exact official WriteStuff edit anchor is missing.");
  return official.replace(
    anchor,
    `${anchor}        example_tex.move_to((1.25, -0.5, 0))\n        example_tex.scale(0.5)\n`,
  );
}

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

async function reproduceEditedScene() {
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
  return {
    bundle: sealed.bundle,
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

  it("pins the actual producer output after the bounded equation move and scale", async () => {
    const reproduced = await reproduceEditedScene();
    const fixture = JSON.parse(await readFile(EDITED_FIXTURE_URL, "utf8"));
    expect(fixture).toMatchObject({
      assets: reproduced.bundle.assets,
      id: "eng-v1-real-write-stuff-v12-edited",
      producerReference: reproduced.producerReference,
      scene: reproduced.bundle.scene,
    });
  });
});
