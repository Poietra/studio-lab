import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { createServerPreviewSnapshotProviderV1 } from "../src/studio/preview-snapshot-provider.server";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V11,
  FAST_MANIM_SPIRAL_IN_OFFICIAL_SOURCE_SHA256_V11,
  FAST_MANIM_SPIRAL_IN_SEMANTICS_SHA256_V11,
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

const SOURCE_PATH = "example_scenes/basic.py";
const RUNTIME_CONFIG_HASH = "5e5999869eec1e504524113678df6b55f38cc850efa4fbda569e2f2601beb520";

async function loadProducerFixture() {
  const [wire, sourceText, manifestText] = await Promise.all([
    readFile(new URL("./test-fixtures/fast-manim-spiral-in-v11-combined.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
    readFile(new URL("./test-fixtures/fast-manim-spiral-in-v11-manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    combinedWireSha256: createHash("sha256").update(wire, "utf8").digest("hex"),
    fastManimCommit: "4a6eaf1b4085ed643698da5116dd23814411eb5b",
    fastManimTree: "6fad77addc72e1a97440265e27d02630cf5b37b4",
    runtimeConfigHash: RUNTIME_CONFIG_HASH,
    semanticSha256: FAST_MANIM_SPIRAL_IN_SEMANTICS_SHA256_V11,
    sourceSha256: FAST_MANIM_SPIRAL_IN_OFFICIAL_SOURCE_SHA256_V11,
  });
  const producer = parseFastManimProducerDocumentV1(wire);
  if (!producer.combined) throw new Error("Expected one actual combined fast-manim V11 fixture.");
  const envelope = JSON.parse(producer.snapshotJson) as SpiralInEnvelope;
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    requestId: "req-1",
    runtimeConfigHash: RUNTIME_CONFIG_HASH,
    sceneId: fastManimSnapshotSceneIdV1(SOURCE_PATH, "SpiralInExample"),
    sceneName: "SpiralInExample",
    snapshotVersion: 11,
    sourceHash: FAST_MANIM_SPIRAL_IN_OFFICIAL_SOURCE_SHA256_V11,
    sourcePath: SOURCE_PATH,
  } as const satisfies ExpectedFastManimSnapshotCorrelationV1;
  return { combined: producer.combined, envelope, expected, manifest, producer, sourceText };
}

describe("fast-manim SpiralIn snapshot profile V11", () => {
  it("accepts and seals the actual group, five leaves, and sampled SpiralIn timeline", async () => {
    const { combined, expected, manifest, producer, sourceText } = await loadProducerFixture();
    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
    expect(sealed.kind).toBe("compiled");
    if (sealed.kind !== "compiled") throw new Error("Expected one compiled V11 snapshot.");
    expect(sealed.snapshotHash).toBe(manifest.sealedSnapshotHash);
    expect(sealed.snapshotHash).not.toBe(ZERO_SHA256);
    expect(sealed.bundle.scene).toMatchObject({
      duration: 3,
      requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "logical-group", "opacity-animation"],
      source: { snapshotVersion: 11 },
    });
    expect(sealed.bundle.scene.entities).toHaveLength(6);
    expect(sealed.bundle.scene.animationChannels).toHaveLength(11);
    expect(sealed.bundle.scene.provenance).toHaveLength(18);
    const leafOpacityChannels = sealed.bundle.scene.animationChannels.filter(
      (channel, index) => channel.kind === "opacity" && index > 0,
    );
    expect(leafOpacityChannels).toHaveLength(5);
    expect(leafOpacityChannels.map(({ keyframes }) => keyframes.at(-1)?.value)).toEqual([1, 1, 1, 1, 0]);
    expect(leafOpacityChannels[4]?.keyframes.every(({ value }) => value === 0)).toBe(true);
    expect(
      sealed.bundle.scene.provenance.every(
        ({ evidence }) => canonicalJsonV1(evidence) === canonicalJsonV1([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V11]),
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expected)).resolves.toEqual(sealed);

    const identity = verifyFastManimSourceRuntimeIdentityV1(combined, {
      expected,
      snapshot: sealed,
      sourceText,
    });
    expect(identity?.mappings.map(({ binding, familyPath }) => ({ familyPath, name: binding.name }))).toEqual([
      { familyPath: [], name: "shapes" },
      { familyPath: [0], name: "triangle" },
      { familyPath: [1], name: "square" },
      { familyPath: [2], name: "circle" },
      { familyPath: [3], name: "pentagon" },
      { familyPath: [4], name: "pi" },
    ]);
    expect(() => assertFastManimSnapshotIdentityAuthorityV1(sealed, identity)).not.toThrow();
    expect(identity && parseVerifiedSourceRuntimeIdentityMapV1(identity, sealed)).toEqual(identity);

    const publication = {
      projectId: expected.projectId,
      publishedAt: "2026-08-05T00:00:00.000Z",
      requestId: expected.requestId,
      revision: 1,
      runtimeConfigHash: expected.runtimeConfigHash,
      sceneName: expected.sceneName,
      schema: "poietra.fast-manim-snapshot-run",
      snapshot: sealed,
      sourcePath: expected.sourcePath,
      sourceRuntimeIdentity: identity,
      status: "verified",
      version: 1,
    } as const;
    const provider = createServerPreviewSnapshotProviderV1({
      fetcher: async () =>
        new Response(JSON.stringify(publication), { headers: { "content-type": "application/json" } }),
      requestIdFactory: () => expected.requestId,
    });
    const preview = await provider.loadVerifiedSnapshot({
      identity: {
        projectId: expected.projectId,
        sceneName: expected.sceneName,
        sourceHash: expected.sourceHash,
        sourcePath: expected.sourcePath,
      },
    });
    expect([...preview.sourceRuntimeIdentity!.entries()].map(([name, mapping]) => [name, mapping.entityId])).toEqual(
      identity!.mappings.map(({ binding, entityId }) => [binding.name, entityId]),
    );
  });

  it.each([
    ["base geometry", (value: SpiralInEnvelope) => (value.bundle.scene.entities[1]!.transform.tx += 0.001)],
    ["sample time", (value: SpiralInEnvelope) => (value.bundle.scene.animationChannels[1]!.keyframes[1]!.at += 0.001)],
    ["producer provenance", (value: SpiralInEnvelope) => value.bundle.scene.provenance[1]!.evidence.push("extra")],
  ])("rejects tampered %s evidence", async (_label, mutate) => {
    const { envelope, expected, sourceText } = await loadProducerFixture();
    const tampered = structuredClone(envelope);
    mutate(tampered);
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(canonicalJsonV1(tampered), expected, sourceText),
    ).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("pins the audited producer semantic generation", () => {
    expect(FAST_MANIM_SPIRAL_IN_SEMANTICS_SHA256_V11).toBe(
      "90def786b1509d018acf333fb5239059e6eaf108b3ff521be14ef3f87494be31",
    );
  });
});

type SpiralInEnvelope = {
  bundle: {
    scene: {
      animationChannels: Array<{ keyframes: Array<{ at: number }> }>;
      entities: Array<{ transform: { tx: number } }>;
      provenance: Array<{ evidence: string[] }>;
    };
  };
};
