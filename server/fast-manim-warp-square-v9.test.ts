import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  deriveWarpSquareV9TransformPlan,
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V9,
  FAST_MANIM_WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9,
  FAST_MANIM_WARP_SQUARE_SEMANTICS_SHA256_V9,
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

const SOURCE_PATH = "example_scenes/basic.py";

async function loadProducerFixture() {
  const [wire, sourceText, manifestText] = await Promise.all([
    readFile(new URL("./test-fixtures/fast-manim-warp-square-v9-combined.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
    readFile(new URL("./test-fixtures/fast-manim-warp-square-v9-manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    combinedWireSha256: createHash("sha256").update(wire, "utf8").digest("hex"),
    fastManimCommit: "2c1e56287193e3acddbe6779f6ecd4bd91094588",
    fastManimFeatureCommit: "8c95a10f",
    runtimeConfigHash: "a2a789613c64b68c4b9b0c3542975b334b3b03388b7c8b0b903f690cca69c38a",
    sealedSnapshotHash: "b8854f07baa588b01a2a5694d8ade2800601f1e26b6e12d626cc170ffa1be9ed",
    semanticSha256: FAST_MANIM_WARP_SQUARE_SEMANTICS_SHA256_V9,
    sourcePath: SOURCE_PATH,
    sourceSha256: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    version: 1,
  });
  const producer = parseFastManimProducerDocumentV1(wire);
  if (!producer.combined) throw new Error("Expected one combined fast-manim V9 fixture.");
  expect(manifest.snapshotDigest).toBe(producer.combined.snapshotDigest);
  const envelope = JSON.parse(producer.snapshotJson) as Record<string, unknown>;
  if (typeof envelope.runtimeConfigHash !== "string") {
    throw new Error("Expected the V9 fixture to declare a runtimeConfigHash.");
  }
  expect(envelope.runtimeConfigHash).toBe(manifest.runtimeConfigHash);
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    requestId: "req-1",
    runtimeConfigHash: envelope.runtimeConfigHash,
    sceneId: fastManimSnapshotSceneIdV1(SOURCE_PATH, "WarpSquare"),
    sceneName: "WarpSquare",
    snapshotVersion: 9,
    sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    sourcePath: SOURCE_PATH,
  } as const satisfies ExpectedFastManimSnapshotCorrelationV1;
  return { combined: producer.combined, envelope, expected, manifest, producer, sourceText };
}

describe("fast-manim WarpSquare snapshot profile V9", () => {
  it("derives only the canonical bounded Studio base edits after reconstructing the official bytes", async () => {
    const { sourceText } = await loadProducerFixture();
    const anchor = "class WarpSquare(Scene):\n    def construct(self):\n        square = Square()\n";
    const edited = (lines: readonly string[]) => sourceText.replace(anchor, `${anchor}${lines.join("\n")}\n`);

    expect(deriveWarpSquareV9TransformPlan(sourceText, "WarpSquare")).toEqual({ moveTo: null, scale: null });
    expect(
      deriveWarpSquareV9TransformPlan(
        edited(["        square.move_to((1.25, -0.5, 0))", "        square.scale(1.5)"]),
        "WarpSquare",
      ),
    ).toEqual({ moveTo: { x: 1.25, y: -0.5 }, scale: 1.5 });
    expect(deriveWarpSquareV9TransformPlan(edited(["        square.move_to((0, 0, 0))"]), "WarpSquare")).toEqual({
      moveTo: { x: 0, y: 0 },
      scale: null,
    });
    expect(deriveWarpSquareV9TransformPlan(edited(["        square.scale(1)"]), "WarpSquare")).toEqual({
      moveTo: null,
      scale: 1,
    });
  });

  it.each([
    ["repeated move", ["        square.move_to((1, 2, 0))", "        square.move_to((2, 1, 0))"]],
    ["repeated scale", ["        square.scale(2)", "        square.scale(0.5)"]],
    ["reversed order", ["        square.scale(1.5)", "        square.move_to((1.25, -0.5, 0))"]],
    ["dynamic coordinate", ["        square.move_to((position(), -0.5, 0))"]],
    ["negative scale", ["        square.scale(-1)"]],
    ["noncanonical numeric spelling", ["        square.scale(1.0)"]],
    ["noncanonical spacing", ["        square.move_to((1.25,-0.5,0))"]],
  ])("rejects a %s source edit before producer geometry can become authority", async (_label, lines) => {
    const { sourceText } = await loadProducerFixture();
    const anchor = "class WarpSquare(Scene):\n    def construct(self):\n        square = Square()\n";
    const edited = sourceText.replace(anchor, `${anchor}${lines.join("\n")}\n`);
    expect(() => deriveWarpSquareV9TransformPlan(edited, "WarpSquare")).toThrowError(
      expect.objectContaining({ code: "profile-violation" }),
    );
  });

  it("rejects a canonical-looking edit after the V9 timeline starts", async () => {
    const { sourceText } = await loadProducerFixture();
    const tail = "        )\n        self.wait()\n\n\nclass WriteStuff";
    const edited = sourceText.replace(
      tail,
      "        )\n        square.scale(2)\n        self.wait()\n\n\nclass WriteStuff",
    );
    expect(() => deriveWarpSquareV9TransformPlan(edited, "WarpSquare")).toThrowError(
      expect.objectContaining({ code: "profile-violation" }),
    );
  });

  it("accepts, seals, and identity-maps the frozen official producer output", async () => {
    const { combined, expected, manifest, producer, sourceText } = await loadProducerFixture();
    expect(expected.sourceHash).toBe(FAST_MANIM_WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9);

    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
    expect(sealed.kind).toBe("compiled");
    if (sealed.kind !== "compiled") throw new Error("Expected one compiled V9 snapshot.");
    expect(sealed.snapshotHash).toBe(manifest.sealedSnapshotHash);
    expect(sealed.snapshotHash).not.toBe(ZERO_SHA256);
    expect(sealed.bundle.scene.source).toMatchObject({
      snapshotHash: sealed.snapshotHash,
      snapshotVersion: 9,
      sourceHash: expected.sourceHash,
    });
    expect(sealed.bundle.scene).toMatchObject({
      duration: 4,
      requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
    });
    expect(sealed.bundle.scene.entities).toHaveLength(1);
    expect(sealed.bundle.scene.animationChannels).toHaveLength(1);
    expect(sealed.bundle.scene.animationChannels[0]).toMatchObject({
      entityId: `${expected.sceneId}/entity:0`,
      keyframes: [
        { at: 0, easingToNext: { kind: "manim-smooth" } },
        { at: 3, easingToNext: null },
      ],
      kind: "path-morph",
    });
    expect(
      sealed.bundle.scene.provenance.every(
        ({ evidence }) => canonicalJsonV1(evidence) === canonicalJsonV1([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V9]),
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expected)).resolves.toEqual(sealed);

    const identity = verifyFastManimSourceRuntimeIdentityV1(combined, {
      expected,
      snapshot: sealed,
      sourceText,
    });
    expect(identity?.mappings).toEqual([
      expect.objectContaining({
        binding: expect.objectContaining({
          name: "square",
          ordinal: 1,
          span: { endColumn: 14, endLine: 87, startColumn: 8, startLine: 87 },
        }),
        entityId: `${expected.sceneId}/entity:0`,
        familyPath: [],
      }),
    ]);
    expect(() => assertFastManimSnapshotIdentityAuthorityV1(sealed, identity)).not.toThrow();
  });

  it.each([
    [
      "endpoint geometry",
      (envelope: WarpSquareEnvelope) => {
        envelope.bundle.scene.animationChannels[0]!.keyframes[1]!.value.subpaths[0]!.start.x += 0.001;
      },
    ],
    [
      "easing",
      (envelope: WarpSquareEnvelope) => {
        envelope.bundle.scene.animationChannels[0]!.keyframes[0]!.easingToNext = { kind: "linear" };
      },
    ],
    [
      "appearance",
      (envelope: WarpSquareEnvelope) => {
        const appearance = envelope.bundle.scene.entities[0]!.appearance;
        if (appearance.stroke) appearance.stroke.widthWorld = 0.05;
      },
    ],
    [
      "producer provenance",
      (envelope: WarpSquareEnvelope) => {
        envelope.bundle.scene.provenance[2]!.evidence[0] =
          "runtime observed direct compatible ApplyPointwiseFunction from 0.0s to 4.0s";
      },
    ],
  ])("rejects a %s substitution", async (_label, mutate) => {
    const { envelope, expected, sourceText } = await loadProducerFixture();
    const tampered = structuredClone(envelope) as WarpSquareEnvelope;
    mutate(tampered);
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(canonicalJsonV1(tampered), expected, sourceText),
    ).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("rejects a substituted source generation", async () => {
    const { envelope, expected, sourceText } = await loadProducerFixture();
    const alteredSource = `${sourceText}\n# not the pinned official generation\n`;
    const sourceHash = createHash("sha256").update(alteredSource, "utf8").digest("hex");
    const tampered = structuredClone(envelope) as WarpSquareEnvelope;
    tampered.sourceHash = sourceHash;
    tampered.bundle.scene.source.sourceHash = sourceHash;
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(
        canonicalJsonV1(tampered),
        { ...expected, sourceHash },
        alteredSource,
      ),
    ).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("rejects incomplete, lifecycle-substituted, or runtime-substituted V9 identity evidence", async () => {
    const { combined, expected, producer, sourceText } = await loadProducerFixture();
    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
    if (sealed.kind !== "compiled") throw new Error("Expected one compiled combined fixture.");
    expect(() => assertFastManimSnapshotIdentityAuthorityV1(sealed, null)).toThrowError(
      expect.objectContaining({ code: "identity-evidence-invalid" }),
    );

    for (const mutate of [
      (document: WarpSquareCombinedDocument) => document.evidence.records.splice(0),
      (document: WarpSquareCombinedDocument) => {
        document.evidence.records[0]!.lifecycle[0]!.sequence = 4;
      },
      (document: WarpSquareCombinedDocument) => {
        document.evidence.records[0]!.runtimeType = "manim.mobject.geometry.arc.Circle";
      },
    ]) {
      const document = structuredClone(combined.document) as unknown as WarpSquareCombinedDocument;
      mutate(document);
      expect(() =>
        verifyFastManimSourceRuntimeIdentityV1(
          { document: document as never, snapshotDigest: combined.snapshotDigest },
          { expected, snapshot: sealed, sourceText },
        ),
      ).toThrowError(expect.objectContaining({ code: "identity-evidence-invalid" }));
    }
  });
});

type WarpSquareEnvelope = {
  bundle: {
    scene: {
      animationChannels: Array<{
        keyframes: Array<{
          easingToNext: unknown;
          value: { subpaths: Array<{ start: { x: number } }> };
        }>;
      }>;
      entities: Array<{ appearance: { stroke: null | { widthWorld: number } } }>;
      provenance: Array<{ evidence: string[] }>;
      source: { sourceHash: string };
    };
  };
  sourceHash: string;
};

type WarpSquareCombinedDocument = {
  evidence: {
    records: Array<{
      lifecycle: Array<{ sequence: number }>;
      runtimeType: string;
    }>;
  };
};
