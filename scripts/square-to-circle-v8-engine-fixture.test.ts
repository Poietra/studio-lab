import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import {
  FAST_MANIM_SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
} from "../server/fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "../server/fast-manim-source-runtime-document";
import {
  assertFastManimSnapshotIdentityAuthorityV1,
  verifyFastManimSourceRuntimeIdentityV1,
} from "../server/fast-manim-source-runtime-identity";
import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSourceRuntimeMappingV1,
  type StudioVerifiedPreviewSnapshotV1,
} from "../src/studio/preview-snapshot-provider";
import {
  studioPreviewInteractionAuthority,
  studioPreviewInteractionEntityIdsV1,
} from "../src/studio/use-preview-renderer";

const SOURCE_PATH = "example_scenes/basic.py";
const SOURCE_FIXTURE_PATH = "fixtures/real-preview-harness/example_scenes/basic.py";
const ENGINE_COMMIT = "2e63bbd550f794ec7d728c4e409145c61e1795d2";
const FAST_MANIM_COMMIT = "5db5254b61b20359878b7b331c63ceadb6580e4b";
const FAST_MANIM_TREE = "13d985d0b8d5e5ffafdddc3a7351bf0e838c17fa";

async function reproduceOfficialScene() {
  const [wire, sourceText, manifestText] = await Promise.all([
    readFile(
      new URL("../server/test-fixtures/fast-manim-square-to-circle-official-v8-combined.json", import.meta.url),
      "utf8",
    ),
    readFile(new URL(`../${SOURCE_FIXTURE_PATH}`, import.meta.url), "utf8"),
    readFile(
      new URL("../server/test-fixtures/fast-manim-square-to-circle-official-v8-manifest.json", import.meta.url),
      "utf8",
    ),
  ]);
  const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
  expect(sourceHash).toBe(FAST_MANIM_SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8);
  const producer = parseFastManimProducerDocumentV1(wire);
  if (!producer.combined) throw new Error("Expected combined official SquareToCircle V8 evidence.");
  const envelope = JSON.parse(producer.snapshotJson) as Readonly<{ runtimeConfigHash: string }>;
  const manifest = JSON.parse(manifestText) as Readonly<{
    combinedWireSha256: string;
    fastManimCommit: string;
    fastManimTree: string;
    runtimeConfigHash: string;
    snapshotDigest: string;
    sourcePath: string;
    sourceSha256: string;
    version: number;
  }>;
  expect(manifest).toMatchObject({
    combinedWireSha256: createHash("sha256").update(wire, "utf8").digest("hex"),
    fastManimCommit: FAST_MANIM_COMMIT,
    fastManimTree: FAST_MANIM_TREE,
    runtimeConfigHash: envelope.runtimeConfigHash,
    snapshotDigest: producer.combined.snapshotDigest,
    sourcePath: SOURCE_PATH,
    sourceSha256: sourceHash,
    version: 1,
  });
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "default",
    requestId: "real-snapshot-request-v8-official",
    runtimeConfigHash: envelope.runtimeConfigHash,
    sceneId: fastManimSnapshotSceneIdV1(SOURCE_PATH, "SquareToCircle"),
    sceneName: "SquareToCircle",
    snapshotVersion: 8,
    sourceHash,
    sourcePath: SOURCE_PATH,
  } as const;
  const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
  if (sealed.kind !== "compiled") throw new Error("The official SquareToCircle V8 fixture must compile.");
  const identity = verifyFastManimSourceRuntimeIdentityV1(producer.combined, {
    expected,
    snapshot: sealed,
    sourceText,
  });
  assertFastManimSnapshotIdentityAuthorityV1(sealed, identity);
  return { identity, manifest, sealed, sourceHash };
}

describe("official SquareToCircle V8 engine fixture", () => {
  it("reproduces one server-sealed Scene IR bundle from the exact full source and producer evidence", async () => {
    const [{ identity, manifest, sealed, sourceHash }, fixtureText] = await Promise.all([
      reproduceOfficialScene(),
      readFile(new URL("../fixtures/engine-v1/real-square-to-circle-v8.json", import.meta.url), "utf8"),
    ]);
    const fixture = JSON.parse(fixtureText) as Readonly<{
      assets: unknown;
      producerReference: unknown;
      scene: unknown;
    }>;
    const bundle = await parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });

    expect(bundle).toEqual(sealed.bundle);
    expect(fixture.producerReference).toEqual({
      engineCommit: ENGINE_COMMIT,
      fastManimCommit: FAST_MANIM_COMMIT,
      fastManimTree: FAST_MANIM_TREE,
      kind: "server-sealed-real-fast-manim-profile-v8",
      producerSnapshotDigest: manifest.snapshotDigest,
      snapshotHash: sealed.snapshotHash,
      sourcePath: SOURCE_FIXTURE_PATH,
      sourceSha256: sourceHash,
    });
    expect(identity?.mappings).toEqual([
      expect.objectContaining({
        binding: expect.objectContaining({ name: "square", ordinal: 2 }),
        entityId: bundle.scene.entities[0]?.id,
        familyPath: [],
      }),
    ]);
    expect(bundle.scene.animationChannels.map(({ kind }) => kind)).toEqual([
      "opacity",
      "path-morph",
      "vector-appearance",
      "path-trim",
    ]);
  });

  it("keeps the verified full-source root selectable without advertising source mutation", async () => {
    const { identity, sealed, sourceHash } = await reproduceOfficialScene();
    if (!identity) throw new Error("Expected verified source/runtime identity.");
    const source = sealed.bundle.scene.source;
    if (source.kind !== "imported-manim-server-snapshot") throw new Error("Expected the V8 server snapshot.");
    const studioIdentity = new Map<string, StudioPreviewSourceRuntimeMappingV1>(
      identity.mappings.map(({ binding, entityId }) => [
        binding.name,
        { bindingId: binding.id, entityId, sourceName: binding.name },
      ]),
    );
    const verifiedRuntimeEntityIds = identity.mappings.map(({ entityId }) => entityId);
    const snapshot: StudioVerifiedPreviewSnapshotV1 = {
      assetPayloads: [],
      correlation: {
        assetsManifestDigest: sealed.bundle.assets.manifestDigest,
        context: {
          projectId: "square-to-circle-generic-preview",
          sceneName: "SquareToCircle",
          sourceDuration: sealed.bundle.scene.duration,
          sourceHash,
          sourcePath: SOURCE_PATH,
          workingRevision: PRISTINE_WORKING_REVISION,
        },
        engineRevisionHash: source.snapshotHash,
        sceneDuration: sealed.bundle.scene.duration,
        sceneId: sealed.bundle.scene.sceneId,
        serverPublicationRevision: null,
      },
      duration: sealed.bundle.scene.duration,
      sceneId: sealed.bundle.scene.sceneId,
      snapshot: sealed.bundle,
      sourceLabel: "verified official SquareToCircle V8 fixture",
      sourceRuntimeIdentity: studioIdentity,
    };
    const authority = studioPreviewInteractionAuthority(snapshot, 0, []);

    expect(identity.mappings.map(({ binding }) => binding.name)).toEqual(["square"]);
    expect(authority).toEqual({
      kind: "selection-only",
      reason: "source-edit-unsupported",
      verifiedRuntimeEntityIds,
    });
    expect(studioPreviewInteractionEntityIdsV1(studioIdentity, authority, sealed.bundle.scene.entities)).toEqual(
      verifiedRuntimeEntityIds,
    );
  });
});
