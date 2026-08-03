import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { applyEngineEasingV1 } from "../src/engine/easing";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
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
const CUBIC_SIGNED_AREA_ROOT_PROGRESS = 0.5301583604406768;
// Inverse of Manim's normalized logistic smooth rate function for the
// analytic cubic signed-area root above. Scene time is one second plus this
// local Transform progress because the morph occupies [1, 2].
const CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME = 1.5119159473817447;

type ReadyReferenceSample = Extract<Awaited<ReturnType<typeof compileEngineFrameV1>>, { kind: "ready" }>;

function referenceSampleSemantics(sample: ReadyReferenceSample) {
  const { evidence: _evidence, packetId: _packetId, ...semantics } = sample.frame.packet;
  return semantics;
}

function semanticSequenceDigest(samples: readonly ReadyReferenceSample[]) {
  return createHash("sha256")
    .update(canonicalJsonV1(samples.map(referenceSampleSemantics)), "utf8")
    .digest("hex");
}

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
  it("accepts, seals, identity-maps, and samples the frozen real producer output", async () => {
    const { combined, expected, manifest, producer, sourceText } = await loadProducerFixture();
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

    expect(applyEngineEasingV1({ kind: "manim-smooth" }, CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME - 1)).toBeCloseTo(
      CUBIC_SIGNED_AREA_ROOT_PROGRESS,
      14,
    );
    const sampled = new Map<number, Awaited<ReturnType<typeof compileEngineFrameV1>>>();
    for (const sampleTime of [0, 0.5, 1, 1.5, CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME, 2, 2.5, 3]) {
      const sample = await compileEngineFrameV1({
        assets: sealed.bundle.assets,
        packetId: `square-to-circle-v8:${sampleTime}`,
        sampleTime,
        scene: sealed.bundle.scene,
        viewport: { heightPx: 360, widthPx: 640 },
      });
      expect(sample.kind, `sampleTime=${sampleTime}`).toBe("ready");
      sampled.set(sampleTime, sample);
    }
    const start = sampled.get(0);
    if (start?.kind !== "ready") throw new Error("Expected the start boundary sample to be ready.");
    expect(start.frame.packet.draws).toEqual([expect.objectContaining({ kind: "empty", reason: "path-trim-zero" })]);
    const end = sampled.get(3);
    if (end?.kind !== "ready") throw new Error("Expected the end boundary sample to be ready.");
    expect(end.frame.packet.draws).toHaveLength(0);
    for (const sampleTime of [0.5, 1, 1.5, CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME, 2, 2.5]) {
      const sample = sampled.get(sampleTime);
      if (sample?.kind !== "ready") throw new Error(`Expected a ready interior sample at ${sampleTime}.`);
      expect(sample.frame.packet.draws, `sampleTime=${sampleTime}`).toHaveLength(1);
    }
    const midpoint = sampled.get(1.5);
    if (midpoint?.kind !== "ready") throw new Error("Expected the midpoint sample to be ready.");
    const draw = midpoint.frame.packet.draws[0];
    if (draw?.kind !== "path" || draw.fill === null || draw.stroke === null) {
      throw new Error("Expected one sampled fill-and-stroke SquareToCircle path.");
    }
    expect(draw.path.subpaths[0]?.segments).toHaveLength(8);
    expect(draw.fill.color.alpha).toBeCloseTo(0.25, 14);
    expect(draw.stroke.widthWorld).toBeCloseTo(0.04, 14);
    const root = sampled.get(CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME);
    if (root?.kind !== "ready") throw new Error("Expected the analytic-root sample to be ready.");
    const rootDraw = root.frame.packet.draws[0];
    if (rootDraw?.kind !== "path" || rootDraw.fill === null || rootDraw.stroke === null) {
      throw new Error("Expected one fill-and-stroke path at the analytic winding root.");
    }
    expect(rootDraw.path.subpaths[0]?.segments).toHaveLength(8);

    const forwardSamples = [0, 0.5, 1, 1.5, CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME, 2, 2.5, 3].map((sampleTime) => {
      const sample = sampled.get(sampleTime);
      if (sample?.kind !== "ready") throw new Error(`Expected a ready forward sample at ${sampleTime}.`);
      return sample;
    });
    const nonMonotonicSamples: ReadyReferenceSample[] = [];
    for (const sampleTime of [
      2.5,
      0.5,
      CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME,
      1,
      2,
      0,
      1.5,
      3,
      CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME,
    ]) {
      const sample = await compileEngineFrameV1({
        assets: sealed.bundle.assets,
        packetId: `square-to-circle-v8:seek:${sampleTime}`,
        sampleTime,
        scene: sealed.bundle.scene,
        viewport: { heightPx: 360, widthPx: 640 },
      });
      if (sample.kind !== "ready") throw new Error(`Expected a ready non-monotonic sample at ${sampleTime}.`);
      const forward = sampled.get(sampleTime);
      if (forward?.kind !== "ready") throw new Error(`Expected a corresponding forward sample at ${sampleTime}.`);
      expect(referenceSampleSemantics(sample)).toEqual(referenceSampleSemantics(forward));
      nonMonotonicSamples.push(sample);
    }
    expect(manifest).toMatchObject({
      forwardSampleSemanticsSha256: semanticSequenceDigest(forwardSamples),
      nonMonotonicSampleSemanticsSha256: semanticSequenceDigest(nonMonotonicSamples),
    });
  });

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
