import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { digestAssetManifestV1 } from "../src/engine/asset-manifest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V8,
  FAST_MANIM_SQUARE_TO_CIRCLE_MINIMAL_SOURCE_SHA256_V8,
  FAST_MANIM_SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8,
  FAST_MANIM_SQUARE_TO_CIRCLE_SEMANTICS_SHA256_V8,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
  parseVerifiedFastManimSnapshotResultV1,
  ZERO_SHA256,
} from "./fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "./fast-manim-source-runtime-document";
import {
  assertFastManimSnapshotIdentityAuthorityV1,
  verifyFastManimSourceRuntimeIdentityV1,
} from "./fast-manim-source-runtime-identity";

const SOURCE_PATH = "fixtures/real-preview-harness/scene_square_to_circle.py";

async function loadProducerFixture() {
  const [wire, sourceText, manifestText] = await Promise.all([
    readFile(new URL("./test-fixtures/fast-manim-square-to-circle-v8-combined.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/real-preview-harness/scene_square_to_circle.py", import.meta.url), "utf8"),
    readFile(new URL("./test-fixtures/fast-manim-square-to-circle-v8-manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    combinedWireSha256: createHash("sha256").update(wire, "utf8").digest("hex"),
    fastManimCommit: "a1e886fb854268ad7d06b00168f9a5ce3339857d",
    semanticSha256: FAST_MANIM_SQUARE_TO_CIRCLE_SEMANTICS_SHA256_V8,
    sourcePath: SOURCE_PATH,
    sourceSha256: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    version: 1,
  });
  const producer = parseFastManimProducerDocumentV1(wire);
  if (!producer.combined) throw new Error("Expected one combined fast-manim V8 fixture.");
  const combined = producer.combined;
  expect(manifest.snapshotDigest).toBe(combined.snapshotDigest);
  const envelope = JSON.parse(producer.snapshotJson) as Record<string, unknown>;
  if (typeof envelope.runtimeConfigHash !== "string") {
    throw new Error("Expected the V8 fixture to declare a runtimeConfigHash.");
  }
  expect(envelope.runtimeConfigHash).toBe("9650b633875a68d2e6c000e89cb21bdffabe2b6fbf08f2262b54842344e000a2");
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    requestId: "req-1",
    runtimeConfigHash: envelope.runtimeConfigHash,
    sceneId: fastManimSnapshotSceneIdV1(SOURCE_PATH, "SquareToCircle"),
    sceneName: "SquareToCircle",
    snapshotVersion: 8,
    sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    sourcePath: SOURCE_PATH,
  } as const satisfies ExpectedFastManimSnapshotCorrelationV1;
  return { combined, envelope, expected, manifest, producer, sourceText };
}

describe("fast-manim SquareToCircle snapshot profile V8", () => {
  it("keeps legacy edit plans out of producer admission", async () => {
    const { expected, producer, sourceText } = await loadProducerFixture();
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(
        producer.snapshotJson,
        { ...expected, squareToCircleV8Plan: { moveTo: { x: 1.25, y: -0.5 } } },
        sourceText,
      ),
    ).rejects.toMatchObject({ code: "profile-violation", message: "Legacy snapshot edit plans are playback-only." });
  });

  it("accepts, seals, identity-maps, and verifies the frozen real producer Scene IR", async () => {
    const { combined, expected, producer, sourceText } = await loadProducerFixture();
    expect(expected.sourceHash).toBe(FAST_MANIM_SQUARE_TO_CIRCLE_MINIMAL_SOURCE_SHA256_V8);
    expect(FAST_MANIM_SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8).toBe(
      "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
    );

    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
    expect(sealed.kind).toBe("compiled");
    if (sealed.kind !== "compiled") throw new Error("Expected one compiled V8 snapshot.");
    expect(sealed.snapshotHash).not.toBe(ZERO_SHA256);
    expect(sealed.bundle.scene.source).toMatchObject({
      snapshotHash: sealed.snapshotHash,
      snapshotVersion: 8,
      sourceHash: expected.sourceHash,
    });
    expect(sealed.bundle.scene.provenance).toHaveLength(6);
    expect(
      sealed.bundle.scene.provenance.every(
        ({ evidence }) => canonicalJsonV1(evidence) === canonicalJsonV1([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V8]),
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expected)).resolves.toEqual(sealed);

    const identity = verifyFastManimSourceRuntimeIdentityV1(combined, {
      expected,
      snapshot: sealed,
      sourceText,
    });
    expect(identity?.mappings).toHaveLength(1);
    expect(identity?.mappings[0]).toMatchObject({
      binding: { name: "square", ordinal: 2 },
      entityId: `${expected.sceneId}/entity:0`,
      familyPath: [],
    });
    expect(() => assertFastManimSnapshotIdentityAuthorityV1(sealed, identity)).not.toThrow();

    const scene = sealed.bundle.scene;
    expect(scene).toMatchObject({
      duration: 3,
      requiredCapabilities: [
        "cubic-path-geometry",
        "opacity-animation",
        "path-morph-animation",
        "path-trim-animation",
        "vector-appearance-animation",
      ],
    });
    expect(scene.camera.view).toEqual({ center: { x: 0, y: 0 }, frameHeight: 8, frameWidth: 14.222222222222221 });
    expect(scene.entities).toHaveLength(1);
    const entity = scene.entities[0];
    if (!entity || entity.geometry.kind !== "cubic-path" || entity.appearance.kind !== "vector") {
      throw new Error("Expected one vector cubic-path SquareToCircle entity.");
    }
    expect(entity.lifetimes).toEqual([{ end: 3, start: 0 }]);
    expect(entity.geometry.path.subpaths[0]?.segments).toHaveLength(8);
    expect(entity.appearance.fill).toBeNull();
    expect(entity.appearance.stroke?.widthWorld).toBeCloseTo(0.04, 14);

    expect(scene.animationChannels.map(({ kind }) => kind)).toEqual([
      "opacity",
      "path-morph",
      "vector-appearance",
      "path-trim",
    ]);
    const opacity = scene.animationChannels.find((channel) => channel.kind === "opacity");
    const morph = scene.animationChannels.find((channel) => channel.kind === "path-morph");
    const appearance = scene.animationChannels.find((channel) => channel.kind === "vector-appearance");
    const trim = scene.animationChannels.find((channel) => channel.kind === "path-trim");
    if (!opacity || !morph || !appearance || !trim) {
      throw new Error("Expected the complete SquareToCircle animation channel set.");
    }
    expect(opacity.keyframes).toEqual([
      { at: 2, easingToNext: { kind: "manim-smooth" }, value: 1 },
      { at: 3, easingToNext: null, value: 0 },
    ]);
    expect(morph.keyframes.map(({ at, easingToNext }) => ({ at, easingToNext }))).toEqual([
      { at: 1, easingToNext: { kind: "manim-smooth" } },
      { at: 2, easingToNext: null },
    ]);
    expect(morph.keyframes.every(({ value }) => value.subpaths[0]?.segments.length === 8)).toBe(true);
    expect(appearance.keyframes[0]?.value.fill?.color.alpha).toBe(0);
    expect(appearance.keyframes[1]?.value.fill?.color.alpha).toBe(0.5);
    expect(appearance.keyframes.every(({ value }) => value.stroke?.widthWorld === 0.04)).toBe(true);
    expect(trim).toMatchObject({
      keyframes: [
        { at: 0, easingToNext: { kind: "manim-smooth" }, value: 0 },
        { at: 1, easingToNext: null, value: 1 },
      ],
      parameterization: "uniform-cubic-parameter-v1",
    });
  });

  it.each([
    ["minimal", FAST_MANIM_SQUARE_TO_CIRCLE_MINIMAL_SOURCE_SHA256_V8, 7],
    ["official", FAST_MANIM_SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8, 75],
  ] as const)(
    "keeps legacy %s base-source publications valid under their original logical path",
    async (kind, sourceHash, sourceAnchorLine) => {
      const { envelope, expected, sourceText: minimalSourceText } = await loadProducerFixture();
      const sourceText =
        kind === "minimal"
          ? minimalSourceText
          : await readFile(
              new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
              "utf8",
            );
      expect(createHash("sha256").update(sourceText, "utf8").digest("hex")).toBe(sourceHash);
      const legacySourcePath = `legacy/examples/square_to_circle_${kind}.py`;
      const legacySceneId = fastManimSnapshotSceneIdV1(legacySourcePath, expected.sceneName);
      const legacyEnvelope = JSON.parse(
        canonicalJsonV1(envelope)
          .replaceAll(expected.sceneId, legacySceneId)
          .replaceAll(expected.sourcePath, legacySourcePath)
          .replaceAll(expected.sourceHash, sourceHash)
          .replace(`${legacySourcePath}:7`, `${legacySourcePath}:${sourceAnchorLine}`),
      ) as {
        bundle: {
          assets: Parameters<typeof digestAssetManifestV1>[0];
          scene: { assetManifest: { manifestDigest: string } };
        };
      };
      const manifestDigest = await digestAssetManifestV1(legacyEnvelope.bundle.assets);
      legacyEnvelope.bundle.assets.manifestDigest = manifestDigest;
      legacyEnvelope.bundle.scene.assetManifest.manifestDigest = manifestDigest;
      const legacyExpected = {
        ...expected,
        sceneId: legacySceneId,
        sourceHash,
        sourcePath: legacySourcePath,
      } satisfies ExpectedFastManimSnapshotCorrelationV1;

      const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(
        canonicalJsonV1(legacyEnvelope),
        legacyExpected,
        sourceText,
      );

      expect(sealed).toMatchObject({
        kind: "compiled",
        sourceHash,
      });
      await expect(parseVerifiedFastManimSnapshotResultV1(sealed, legacyExpected)).resolves.toEqual(sealed);
    },
  );

  it("rejects geometry, easing, and source-semantic substitutions independently", async () => {
    const { envelope, expected, sourceText } = await loadProducerFixture();
    const compiled = envelope as {
      bundle: {
        scene: {
          animationChannels: Array<{
            keyframes: Array<{ easingToNext: unknown; value: { subpaths: Array<{ start: { x: number } }> } }>;
          }>;
          provenance: Array<{ evidence: string[] }>;
          source: { sourceHash: string };
        };
      };
      sourceHash: string;
    };

    const geometry = structuredClone(compiled);
    geometry.bundle.scene.animationChannels[1]!.keyframes[1]!.value.subpaths[0]!.start.x += 0.001;
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(canonicalJsonV1(geometry), expected, sourceText),
    ).rejects.toMatchObject({ code: "profile-violation" });

    const easing = structuredClone(compiled);
    easing.bundle.scene.animationChannels[0]!.keyframes[0]!.easingToNext = { kind: "linear" };
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(canonicalJsonV1(easing), expected, sourceText),
    ).rejects.toMatchObject({ code: "profile-violation" });

    const provenance = structuredClone(compiled);
    provenance.bundle.scene.provenance[1]!.evidence[5] = `source anchor ${SOURCE_PATH}:8 in construct`;
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(canonicalJsonV1(provenance), expected, sourceText),
    ).rejects.toMatchObject({ code: "profile-violation" });

    const alteredSource = `${sourceText}\n# not the pinned source generation\n`;
    const alteredHash = createHash("sha256").update(alteredSource, "utf8").digest("hex");
    const sourceSubstitution = structuredClone(compiled);
    sourceSubstitution.sourceHash = alteredHash;
    sourceSubstitution.bundle.scene.source.sourceHash = alteredHash;
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(
        canonicalJsonV1(sourceSubstitution),
        { ...expected, sourceHash: alteredHash },
        alteredSource,
      ),
    ).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("rejects incomplete, lifecycle-substituted, or runtime-substituted V8 identity evidence", async () => {
    const { combined, expected, producer, sourceText } = await loadProducerFixture();
    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
    if (sealed.kind !== "compiled") throw new Error("Expected one compiled combined fixture.");
    expect(() => assertFastManimSnapshotIdentityAuthorityV1(sealed, null)).toThrowError(
      expect.objectContaining({ code: "identity-evidence-invalid" }),
    );

    const tampered = structuredClone(combined.document);
    const evidence = tampered.evidence as { records: Array<{ lifecycle: Array<{ sequence: number }> }> };
    evidence.records[0]!.lifecycle[1]!.sequence = 12;
    expect(() =>
      verifyFastManimSourceRuntimeIdentityV1(
        { document: tampered, snapshotDigest: combined.snapshotDigest },
        { expected, snapshot: sealed, sourceText },
      ),
    ).toThrowError(expect.objectContaining({ code: "identity-evidence-invalid" }));

    const runtimeSubstitution = structuredClone(combined.document);
    const runtimeEvidence = runtimeSubstitution.evidence as { records: Array<{ runtimeType: string }> };
    runtimeEvidence.records[0]!.runtimeType = "manim.mobject.geometry.arc.Circle";
    expect(() =>
      verifyFastManimSourceRuntimeIdentityV1(
        { document: runtimeSubstitution, snapshotDigest: combined.snapshotDigest },
        { expected, snapshot: sealed, sourceText },
      ),
    ).toThrowError(expect.objectContaining({ code: "identity-evidence-invalid" }));
  });
});
