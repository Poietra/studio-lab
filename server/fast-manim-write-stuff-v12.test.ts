import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  deriveWriteStuffV12TransformPlan,
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V12,
  FAST_MANIM_WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12,
  FAST_MANIM_WRITE_STUFF_SEMANTICS_SHA256_V12,
  FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
  parseVerifiedFastManimSnapshotResultV1,
  ZERO_SHA256,
} from "./fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "./fast-manim-source-runtime-document";
import {
  assertFastManimSnapshotIdentityAuthorityV1,
  parseVerifiedSourceRuntimeIdentityMapV1,
  verifyFastManimSourceRuntimeIdentityV1,
} from "./fast-manim-source-runtime-identity";

const RUNTIME_CONFIG_HASH = "2022ea1ccebb06668fc92386455c4d4928305e72a5a5459d103e3d86261a4593";
const SNAPSHOT_DIGEST = "dd6ca2c3e1015718f9fa9b8ad0e926de8260013eb85d17574c3c7fdeaba89817";

async function loadProducerFixture() {
  const [wire, sourceText, manifestText] = await Promise.all([
    readFile(new URL("./test-fixtures/fast-manim-write-stuff-v12-combined.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
    readFile(new URL("./test-fixtures/fast-manim-write-stuff-v12-manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    combinedWireSha256: createHash("sha256").update(wire, "utf8").digest("hex"),
    fastManimCommit: "044a61aa0d868fc9e799588f2eb88006594b6c44",
    fastManimTree: "996ad2b7375a6f911b1b00747eaad38834bde25c",
    fixtureKind: "actual-combined-producer-output",
    producerModule: "manim.renderer.source_runtime_identity",
    runtimeConfigHash: RUNTIME_CONFIG_HASH,
    segmentedTexProviderAbi: 1,
    segmentedTexProviderSha256: "26e4a495715f9efeb8eeb922952d2a0965314aae274e0145af8968cb1baa78b5",
    semanticSha256: FAST_MANIM_WRITE_STUFF_SEMANTICS_SHA256_V12,
    snapshotDigest: SNAPSHOT_DIGEST,
    sourcePath: FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
    sourceSha256: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    version: 1,
  });
  expect(manifest.sourceSha256).toBe(FAST_MANIM_WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12);

  const producer = parseFastManimProducerDocumentV1(wire);
  if (!producer.combined) throw new Error("Expected one actual combined fast-manim V12 fixture.");
  expect(producer.combined.snapshotDigest).toBe(SNAPSHOT_DIGEST);
  const envelope = JSON.parse(producer.snapshotJson) as WriteStuffEnvelope;
  expect(envelope.runtimeConfigHash).toBe(RUNTIME_CONFIG_HASH);
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    requestId: "req-1",
    runtimeConfigHash: RUNTIME_CONFIG_HASH,
    sceneId: fastManimSnapshotSceneIdV1(FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12, "WriteStuff"),
    sceneName: "WriteStuff",
    snapshotVersion: 12,
    sourceHash: FAST_MANIM_WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12,
    sourcePath: FAST_MANIM_WRITE_STUFF_SOURCE_PATH_V12,
  } as const satisfies ExpectedFastManimSnapshotCorrelationV1;
  return { combined: producer.combined, envelope, expected, manifest, producer, sourceText };
}

describe("fast-manim WriteStuff snapshot profile V12", () => {
  it("derives only the canonical post-layout equation move and scale", async () => {
    const { sourceText } = await loadProducerFixture();
    const anchor = '        group.width = config["frame_width"] - 2 * LARGE_BUFF\n';
    const editedSource = sourceText.replace(
      anchor,
      `${anchor}        example_tex.move_to((1.25, -0.5, 0))\n        example_tex.scale(0.5)\n`,
    );

    expect(deriveWriteStuffV12TransformPlan(sourceText, "WriteStuff")).toEqual({ moveTo: null, scale: null });
    expect(deriveWriteStuffV12TransformPlan(editedSource, "WriteStuff")).toEqual({
      moveTo: { x: 1.25, y: -0.5 },
      scale: 0.5,
    });
  });

  it.each([
    ["a different target", "        example_text.move_to((1.25, -0.5, 0))\n"],
    ["reversed edit order", "        example_tex.scale(0.5)\n        example_tex.move_to((1.25, -0.5, 0))\n"],
    ["a repeated move", "        example_tex.move_to((1.25, -0.5, 0))\n        example_tex.move_to((2, 1, 0))\n"],
    ["a negative scale", "        example_tex.scale(-0.5)\n"],
    ["a dynamic scale", "        example_tex.scale(factor)\n"],
    ["a nonzero z coordinate", "        example_tex.move_to((1.25, -0.5, 1))\n"],
    ["an unrelated statement", "        example_tex.set_color(RED)\n"],
  ] as const)("rejects %s in the bounded source edit slot", async (_label, inserted) => {
    const { sourceText } = await loadProducerFixture();
    const anchor = '        group.width = config["frame_width"] - 2 * LARGE_BUFF\n';
    expect(() =>
      deriveWriteStuffV12TransformPlan(sourceText.replace(anchor, `${anchor}${inserted}`), "WriteStuff"),
    ).toThrowError(/WriteStuff profile V12/);
  });

  it("rejects an otherwise canonical edit after the first Write", async () => {
    const { sourceText } = await loadProducerFixture();
    const anchor = "        self.play(Write(example_text))\n";
    const editedSource = sourceText.replace(anchor, `${anchor}        example_tex.scale(0.5)\n`);
    expect(() => deriveWriteStuffV12TransformPlan(editedSource, "WriteStuff")).toThrowError(/WriteStuff profile V12/);
  });

  it("seals move-then-scale geometry against its server-derived source plan", async () => {
    const { envelope, expected, sourceText } = await loadProducerFixture();
    const anchor = '        group.width = config["frame_width"] - 2 * LARGE_BUFF\n';
    const editedSource = sourceText.replace(
      anchor,
      `${anchor}        example_tex.move_to((1.25, -0.5, 0))\n        example_tex.scale(0.5)\n`,
    );
    const editedSourceHash = createHash("sha256").update(editedSource, "utf8").digest("hex");
    const edited = structuredClone(envelope);
    edited.sourceHash = editedSourceHash;
    edited.bundle.scene.source.sourceHash = editedSourceHash;
    transformWriteStuffMathGeometry(edited, { x: 1.25, y: -0.5 }, 0.5);
    const editedExpected = {
      ...expected,
      sourceHash: editedSourceHash,
      writeStuffV12Plan: { moveTo: { x: 1.25, y: -0.5 }, scale: 0.5 },
    } as const satisfies ExpectedFastManimSnapshotCorrelationV1;

    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(
      canonicalJsonV1(edited),
      editedExpected,
      editedSource,
    );
    expect(sealed).toMatchObject({ kind: "compiled", sourceHash: editedSourceHash });

    const tampered = structuredClone(edited);
    const firstPath = tampered.bundle.scene.entities.find(({ sceneOrder }) => sceneOrder === 33)?.geometry.path;
    if (!firstPath) throw new Error("Expected the first MathTex role path.");
    firstPath.subpaths[0]!.start.x += 0.001;
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(canonicalJsonV1(tampered), editedExpected, editedSource),
    ).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("seals the exact two-root, 58-role Write timeline and its three editable source identities", async () => {
    const { combined, envelope, expected, manifest, producer, sourceText } = await loadProducerFixture();
    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
    expect(sealed.kind).toBe("compiled");
    if (sealed.kind !== "compiled") throw new Error("Expected one compiled V12 snapshot.");
    expect(sealed.snapshotHash).toBe(manifest.sealedSnapshotHash);
    expect(sealed.snapshotHash).not.toBe(ZERO_SHA256);
    expect(sealed.bundle.scene).toMatchObject({
      duration: 4,
      requiredCapabilities: [
        "cubic-path-geometry",
        "logical-group",
        "path-trim-animation",
        "vector-appearance-animation",
      ],
      source: {
        snapshotHash: sealed.snapshotHash,
        snapshotVersion: 12,
        sourceHash: expected.sourceHash,
      },
    });

    const texRootEvidence = envelope.bundle.scene.provenance[2]?.evidence;
    const mathRootEvidence = envelope.bundle.scene.provenance[33]?.evidence;
    expect(texRootEvidence).toEqual(
      expect.arrayContaining([
        "segmented Tex source/paint/correlation content digest a55fd97d17b5aae8b5b452eb2c8ae16432ad99c441821675c0defca0719497b8",
        "exact real-Manim LaTeX/dvisvgm geometry resource digest 3b8e1914566b1f9e9627ba1ff9c4847cf8a26e518559e2da2e460f8b3c858963",
        "exact real-Manim LaTeX/dvisvgm source SVG digest 1496ea173fbe28fab26772d9509d9b34dc58ce8bd6b01a8950899a9adcb4139d",
        "exact real-Manim LaTeX/dvisvgm producer identity digest ea1d5eeceb19faad930cfab02ae4d649f5c89f120fc4c18947d96574ab53d55c",
        "exact real-Manim TeX font bundle digest c08c8616a0b95c16cd0c1bfcae0f30361e8bb89868bfdb5135369d3b59b56b5e",
      ]),
    );
    expect(mathRootEvidence).toEqual(
      expect.arrayContaining([
        "segmented Tex source/paint/correlation content digest 0762997c70a0abe2280e1f8a798a19141ea29057fa0735ecc4dfd4f416cc5121",
        "exact real-Manim LaTeX/dvisvgm geometry resource digest 3b8e1914566b1f9e9627ba1ff9c4847cf8a26e518559e2da2e460f8b3c858963",
        "exact real-Manim LaTeX/dvisvgm source SVG digest cb2e99f837c1316e47b67157bf787b1f096a14b01f4392482eba740dd3ac1dbc",
        "exact real-Manim LaTeX/dvisvgm producer identity digest ea1d5eeceb19faad930cfab02ae4d649f5c89f120fc4c18947d96574ab53d55c",
        "exact real-Manim TeX font bundle digest c08c8616a0b95c16cd0c1bfcae0f30361e8bb89868bfdb5135369d3b59b56b5e",
      ]),
    );

    const { animationChannels, entities, provenance } = sealed.bundle.scene;
    expect(entities).toHaveLength(61);
    expect(animationChannels).toHaveLength(58);
    expect(provenance).toHaveLength(120);
    expect(entities.map(({ sceneOrder }) => sceneOrder)).toEqual(Array.from({ length: 61 }, (_, index) => index));
    expect(entities.slice(0, 2).map(({ geometry }) => geometry)).toEqual([{ kind: "group" }, { kind: "group" }]);
    expect(entities[32]?.geometry).toEqual({ kind: "group" });
    expect(entities.map(({ parentId }, index) => [index, parentId])).toEqual([
      [0, null],
      [1, `${expected.sceneId}/entity:0`],
      ...Array.from({ length: 30 }, (_, index) => [index + 2, `${expected.sceneId}/entity:1`]),
      [32, `${expected.sceneId}/entity:0`],
      ...Array.from({ length: 28 }, (_, index) => [index + 33, `${expected.sceneId}/entity:32`]),
    ]);
    expect(entities[0]?.lifetimes).toEqual([{ end: 4, start: 0 }]);
    expect(entities[1]?.lifetimes).toEqual([{ end: 4, start: 0 }]);
    expect(entities[32]?.lifetimes).toEqual([{ end: 4, start: 2 }]);

    expect(animationChannels.map(({ kind }) => kind)).toEqual(
      Array.from({ length: 29 }, () => ["path-trim", "vector-appearance"]).flat(),
    );
    expect(animationChannels[0]?.keyframes.map(({ at }) => at)).toEqual([0, 0.2631578947368421]);
    expect(animationChannels[1]?.keyframes.map(({ at }) => at)).toEqual([0.2631578947368421, 0.5263157894736842]);
    expect(animationChannels[28]?.keyframes.map(({ at }) => at)).toEqual([1.473684210526316, 1.736842105263158]);
    expect(animationChannels[29]?.keyframes.map(({ at }) => at)).toEqual([1.736842105263158, 2]);
    expect(animationChannels[30]?.keyframes.map(({ at }) => at)).toEqual([2, 2.138888888888889]);
    expect(animationChannels[31]?.keyframes.map(({ at }) => at)).toEqual([2.138888888888889, 2.2777777777777777]);
    expect(animationChannels[56]?.keyframes.map(({ at }) => at)).toEqual([2.7222222222222223, 2.861111111111111]);
    expect(animationChannels[57]?.keyframes.map(({ at }) => at)).toEqual([2.861111111111111, 3]);

    const finalFillColors = animationChannels.flatMap((channel) => {
      if (channel.kind !== "vector-appearance") return [];
      const value = channel.keyframes.at(-1)?.value;
      return typeof value === "object" && value !== null && "fill" in value && value.fill !== null
        ? [value.fill.color]
        : [];
    });
    expect(
      finalFillColors.filter(
        (color) =>
          color.alpha === 1 && color.red === 247 / 255 && color.green === 217 / 255 && color.blue === 111 / 255,
      ),
    ).toHaveLength(4);
    expect(
      provenance.every(
        ({ evidence }) => canonicalJsonV1(evidence) === canonicalJsonV1([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V12]),
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expected)).resolves.toEqual(sealed);

    const evidence = combined.document.evidence as WriteStuffIdentityEvidence;
    expect(evidence.records).toHaveLength(61);
    expect(evidence.records.filter(({ status }) => status === "mapped")).toHaveLength(3);
    expect(evidence.records.filter(({ status }) => status === "unmatched")).toHaveLength(58);
    const identity = verifyFastManimSourceRuntimeIdentityV1(combined, { expected, snapshot: sealed, sourceText });
    expect(identity?.mappings).toMatchObject([
      { binding: { name: "group", ordinal: 3 }, entityId: `${expected.sceneId}/entity:0`, familyPath: [] },
      { binding: { name: "example_text", ordinal: 1 }, entityId: `${expected.sceneId}/entity:1`, familyPath: [0] },
      { binding: { name: "example_tex", ordinal: 2 }, entityId: `${expected.sceneId}/entity:32`, familyPath: [1] },
    ]);
    expect(() => assertFastManimSnapshotIdentityAuthorityV1(sealed, identity)).not.toThrow();
    expect(identity && parseVerifiedSourceRuntimeIdentityMapV1(identity, sealed)).toEqual(identity);
    if (!identity) throw new Error("Expected one verified V12 source/runtime identity map.");
    const stalePublishedIdentity = structuredClone(identity);
    stalePublishedIdentity.mappings[0]!.binding.ordinal += 1;
    expect(() => parseVerifiedSourceRuntimeIdentityMapV1(stalePublishedIdentity, sealed)).toThrowError(
      expect.objectContaining({ code: "identity-evidence-invalid" }),
    );
  });

  it.each([
    [
      "geometry",
      (value: WriteStuffEnvelope) => (value.bundle.scene.entities[2]!.geometry.path!.subpaths[0]!.start.x += 0.001),
    ],
    ["timing", (value: WriteStuffEnvelope) => (value.bundle.scene.animationChannels[0]!.keyframes[1]!.at += 0.001)],
    ["provenance", (value: WriteStuffEnvelope) => value.bundle.scene.provenance[1]!.evidence.push("extra")],
  ])("rejects tampered %s semantics", async (_label, mutate) => {
    const { envelope, expected, sourceText } = await loadProducerFixture();
    const tampered = structuredClone(envelope);
    mutate(tampered);
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(canonicalJsonV1(tampered), expected, sourceText),
    ).rejects.toMatchObject({ code: "profile-violation" });
  });

  it.each([
    ["missing fragment", (value: WriteStuffEnvelope) => value.bundle.scene.entities.splice(2, 1)],
    [
      "extra fragment",
      (value: WriteStuffEnvelope) => value.bundle.scene.entities.push(structuredClone(value.bundle.scene.entities[2]!)),
    ],
    [
      "reordered fragments",
      (value: WriteStuffEnvelope) =>
        value.bundle.scene.entities.splice(2, 2, value.bundle.scene.entities[3]!, value.bundle.scene.entities[2]!),
    ],
    ["unsupported channel", (value: WriteStuffEnvelope) => (value.bundle.scene.animationChannels[0]!.kind = "opacity")],
    ["stale correlation", (value: WriteStuffEnvelope) => (value.requestId = "req-stale")],
  ])("rejects a %s substitution", async (_label, mutate) => {
    const { envelope, expected, sourceText } = await loadProducerFixture();
    const tampered = structuredClone(envelope);
    mutate(tampered);
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(canonicalJsonV1(tampered), expected, sourceText),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects a self-consistent source substitution outside the pinned producer generation", async () => {
    const { envelope, expected, sourceText } = await loadProducerFixture();
    const alteredSource = `${sourceText}\n# substituted producer generation\n`;
    const sourceHash = createHash("sha256").update(alteredSource, "utf8").digest("hex");
    const tampered = structuredClone(envelope);
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

  it("rejects absent, role-substituted, or hierarchy-substituted V12 identity authority", async () => {
    const { combined, expected, producer, sourceText } = await loadProducerFixture();
    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
    if (sealed.kind !== "compiled") throw new Error("Expected one compiled V12 snapshot.");
    expect(() => assertFastManimSnapshotIdentityAuthorityV1(sealed, null)).toThrowError(
      expect.objectContaining({ code: "identity-evidence-invalid" }),
    );

    const runtimeSubstitution = structuredClone(combined.document);
    const runtimeEvidence = runtimeSubstitution.evidence as WriteStuffIdentityEvidence;
    runtimeEvidence.records[2]!.runtimeType = runtimeEvidence.records[0]!.runtimeType;
    expect(() =>
      verifyFastManimSourceRuntimeIdentityV1(
        { document: runtimeSubstitution, snapshotDigest: combined.snapshotDigest },
        { expected, snapshot: sealed, sourceText },
      ),
    ).toThrowError(expect.objectContaining({ code: "identity-evidence-invalid" }));

    const hierarchySubstitution = structuredClone(combined.document);
    const hierarchyEvidence = hierarchySubstitution.evidence as WriteStuffIdentityEvidence;
    hierarchyEvidence.records[32]!.familyPath = [0];
    expect(() =>
      verifyFastManimSourceRuntimeIdentityV1(
        { document: hierarchySubstitution, snapshotDigest: combined.snapshotDigest },
        { expected, snapshot: sealed, sourceText },
      ),
    ).toThrowError(expect.objectContaining({ code: "identity-evidence-invalid" }));
  });
});

type WriteStuffEnvelope = {
  bundle: {
    scene: {
      animationChannels: Array<{ keyframes: Array<{ at: number }>; kind: string }>;
      entities: Array<{
        geometry: {
          path?: {
            subpaths: Array<{
              segments: Array<{ control1: WriteStuffPoint; control2: WriteStuffPoint; end: WriteStuffPoint }>;
              start: WriteStuffPoint;
            }>;
          };
        };
        sceneOrder: number;
      }>;
      provenance: Array<{ evidence: string[] }>;
      source: { sourceHash: string };
    };
  };
  requestId: string;
  runtimeConfigHash: string;
  sourceHash: string;
};

type WriteStuffPoint = { x: number; y: number };

function transformWriteStuffMathGeometry(
  envelope: WriteStuffEnvelope,
  target: Readonly<WriteStuffPoint>,
  scale: number,
) {
  const paths = envelope.bundle.scene.entities.flatMap(({ geometry, sceneOrder }) =>
    sceneOrder >= 33 && sceneOrder <= 60 && geometry.path ? [geometry.path] : [],
  );
  const points = paths.flatMap(({ subpaths }) =>
    subpaths.flatMap((subpath) => [
      subpath.start,
      ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end]),
    ]),
  );
  if (points.length === 0) throw new Error("Expected WriteStuff MathTex role geometry.");
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const sourceCenter = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
  for (const point of points) {
    point.x = target.x + (point.x - sourceCenter.x) * scale;
    point.y = target.y + (point.y - sourceCenter.y) * scale;
  }
}

type WriteStuffIdentityEvidence = {
  records: Array<{ familyPath: number[]; runtimeType: string; status: string }>;
};
