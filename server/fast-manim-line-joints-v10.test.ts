import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import type { FastManimSandboxBackendV1 } from "./fast-manim-sandbox-backend";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10,
  FAST_MANIM_LINE_JOINTS_SEMANTICS_SHA256_V10,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V10,
  fastManimSnapshotSceneIdV1,
  parseAndSealFastManimSnapshotProducerJsonV1,
  parseVerifiedFastManimSnapshotResultV1,
  ZERO_SHA256,
} from "./fast-manim-snapshot-contract";
import {
  createFastManimSnapshotSelectedProfileDigestV1,
  fastManimSnapshotProfileSelectionRequestV1Schema,
} from "./fast-manim-snapshot-profile-selection";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { parseFastManimProducerDocumentV1 } from "./fast-manim-source-runtime-document";
import {
  assertFastManimSnapshotIdentityAuthorityV1,
  verifyFastManimSourceRuntimeIdentityV1,
} from "./fast-manim-source-runtime-identity";
import { localSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const SOURCE_PATH = "example_scenes/basic.py";

/**
 * Actual fast-manim `29d21a2b` combined output, generated with
 * `PYTHONHASHSEED=0 python -m manim.renderer.source_runtime_identity` and the
 * exact V10 runtime config pinned below. The trace-session nonce makes a fresh
 * wire byte-different, so this fixture records its own wire hash while the
 * verifier pins the deterministic snapshot digest and renderer semantics.
 */
async function loadProducerFixture() {
  const [wire, sourceText, manifestText] = await Promise.all([
    readFile(new URL("./test-fixtures/fast-manim-line-joints-v10-combined.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url), "utf8"),
    readFile(new URL("./test-fixtures/fast-manim-line-joints-v10-manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    combinedWireSha256: createHash("sha256").update(wire, "utf8").digest("hex"),
    fastManimCommit: "29d21a2bd213df8ffeed0454278aa86289d190b8",
    fastManimTree: "d486d57ba637da1e915a5b29d6bda2d967570a54",
    fixtureKind: "actual-combined-producer-output",
    producerModule: "manim.renderer.source_runtime_identity",
    semanticSha256: FAST_MANIM_LINE_JOINTS_SEMANTICS_SHA256_V10,
    sourcePath: SOURCE_PATH,
    sourceSha256: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    version: 1,
  });
  expect(manifest.sourceSha256).toBe(FAST_MANIM_LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10);
  const producer = parseFastManimProducerDocumentV1(wire);
  if (!producer.combined) throw new Error("Expected one actual combined fast-manim V10 fixture.");
  const combined = producer.combined;
  expect(combined.snapshotDigest).toBe("4a8c02d31f85a0876e3b88d46c648a74726171a26e551c1d0e0f95535592fd88");
  const envelope = JSON.parse(producer.snapshotJson) as Record<string, unknown>;
  const runtimeConfigHash = envelope.runtimeConfigHash;
  if (typeof runtimeConfigHash !== "string") throw new Error("Expected the V10 runtime config digest.");
  expect(runtimeConfigHash).toBe("b99127c213f9e049ffd247c8287bfba4f8d12d77e89bee5b1308bafc2527e9ec");
  const expected = {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: "demo",
    requestId: "req-1",
    runtimeConfigHash,
    sceneId: fastManimSnapshotSceneIdV1(SOURCE_PATH, "LineJoints"),
    sceneName: "LineJoints",
    snapshotVersion: 10,
    sourceHash: FAST_MANIM_LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10,
    sourcePath: SOURCE_PATH,
  } as const satisfies ExpectedFastManimSnapshotCorrelationV1;
  return { combined, envelope, expected, manifest, producer, sourceText, wire };
}

describe("fast-manim LineJoints snapshot profile V10", () => {
  it("accepts, seals, and identity-maps the actual group plus three Triangle leaves", async () => {
    const { combined, expected, manifest, producer, sourceText } = await loadProducerFixture();
    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
    expect(sealed.kind).toBe("compiled");
    if (sealed.kind !== "compiled") throw new Error("Expected one compiled V10 snapshot.");
    expect(sealed.snapshotHash).toBe(manifest.sealedSnapshotHash);
    expect(sealed.snapshotHash).not.toBe(ZERO_SHA256);
    expect(sealed.bundle.scene.source).toMatchObject({
      snapshotHash: sealed.snapshotHash,
      snapshotVersion: 10,
      sourceHash: expected.sourceHash,
    });
    expect(sealed.bundle.scene).toMatchObject({
      animationChannels: [],
      duration: 1,
      requiredCapabilities: ["cubic-path-geometry", "logical-group"],
    });
    expect(sealed.bundle.scene.entities).toHaveLength(4);
    // The actual runtime VGroup owns no vector points and must remain a non-rendering hierarchy node.
    expect(sealed.bundle.scene.entities[0]?.geometry).toEqual({ kind: "group" });
    expect(Object.keys(sealed.bundle.scene.entities[0]?.geometry ?? {})).toEqual(["kind"]);
    expect(sealed.bundle.scene.entities.map(({ parentId }) => parentId)).toEqual([
      null,
      `${expected.sceneId}/entity:0`,
      `${expected.sceneId}/entity:0`,
      `${expected.sceneId}/entity:0`,
    ]);
    expect(
      sealed.bundle.scene.provenance.every(
        ({ evidence }) => canonicalJsonV1(evidence) === canonicalJsonV1([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V10]),
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expected)).resolves.toEqual(sealed);

    const identity = verifyFastManimSourceRuntimeIdentityV1(combined, {
      expected,
      snapshot: sealed,
      sourceText,
    });
    expect(identity?.mappings).toMatchObject([
      { binding: { name: "grp", ordinal: 4 }, entityId: `${expected.sceneId}/entity:0`, familyPath: [] },
      { binding: { name: "t1", ordinal: 1 }, entityId: `${expected.sceneId}/entity:1`, familyPath: [0] },
      { binding: { name: "t2", ordinal: 2 }, entityId: `${expected.sceneId}/entity:2`, familyPath: [1] },
      { binding: { name: "t3", ordinal: 3 }, entityId: `${expected.sceneId}/entity:3`, familyPath: [2] },
    ]);
    expect(() => assertFastManimSnapshotIdentityAuthorityV1(sealed, identity)).not.toThrow();
  });

  it("auto-selects V10 once, seals it, and reads the same publication by runtime identity", async () => {
    const { manifest, sourceText, wire } = await loadProducerFixture();
    let starts = 0;
    const backend: FastManimSandboxBackendV1 = {
      async close() {},
      start(request, context) {
        starts += 1;
        const selectionRequest = fastManimSnapshotProfileSelectionRequestV1Schema.parse(
          JSON.parse(Buffer.from(request.copyProducerRequestBytes()).toString("utf8")),
        );
        const selected = selectionRequest.policy.candidates.find(({ snapshotVersion }) => snapshotVersion === 10);
        if (!selected) throw new Error("AUTO did not offer the exact LineJoints V10 profile.");
        expect(selected.runtimeConfigHash).toBe("b99127c213f9e049ffd247c8287bfba4f8d12d77e89bee5b1308bafc2527e9ec");
        const producerDocumentBytes = Buffer.from(wire, "utf8");
        const resultBytes = Buffer.from(
          `${canonicalJsonV1({
            kind: "selected",
            policyHash: selectionRequest.policyHash,
            producerDocumentBase64: producerDocumentBytes.toString("base64"),
            producerDocumentDigest: createHash("sha256").update(producerDocumentBytes).digest("hex"),
            projectId: selectionRequest.projectId,
            requestId: selectionRequest.requestId,
            sceneId: selectionRequest.sceneId,
            sceneName: selectionRequest.sceneName,
            schema: "poietra.fast-manim-snapshot-profile-selection-result",
            selected: {
              runtimeConfigHash: selected.runtimeConfigHash,
              snapshotVersion: selected.snapshotVersion,
            },
            selectionDigest: createFastManimSnapshotSelectedProfileDigestV1(selectionRequest, selected),
            sourceHash: selectionRequest.sourceHash,
            sourcePath: selectionRequest.sourcePath,
            version: 1,
          })}\n`,
          "utf8",
        );
        return {
          abort() {},
          result: Promise.resolve({
            attestationDigest: context.attestationDigest,
            kind: "ok" as const,
            requestDigest: request.requestDigest,
            resultBytes: Uint8Array.from(resultBytes),
          }),
        };
      },
      async status() {
        return localSandboxReadyStatus();
      },
    };
    const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
    const runner = new FastManimSnapshotRunner({
      backend,
      deployment: "test",
      frame: { height: 8, width: 14.222222222222221 },
      projectId: "demo",
      sourceProvider: {
        async readVerified(sourcePath) {
          expect(sourcePath).toBe(SOURCE_PATH);
          return { hash: sourceHash, source: sourceText, versionToken: sourceHash };
        },
      },
      tenantId: "test-tenant",
    });

    try {
      const published = await runner.run({
        projectId: "demo",
        requestId: "req-1",
        sceneName: "LineJoints",
        sourcePath: SOURCE_PATH,
      });
      expect(starts).toBe(1);
      expect(published).toMatchObject({
        revision: 1,
        runtimeConfigHash: "b99127c213f9e049ffd247c8287bfba4f8d12d77e89bee5b1308bafc2527e9ec",
        status: "verified",
      });
      if (published.status !== "verified" || published.snapshot.kind !== "compiled") {
        throw new Error("Expected one verified AUTO-selected V10 snapshot.");
      }
      expect(published.snapshot.snapshotHash).toBe(manifest.sealedSnapshotHash);
      expect(
        (published.snapshot.bundle as { scene: { source: { snapshotVersion: number } } }).scene.source.snapshotVersion,
      ).toBe(10);
      expect(published.sourceRuntimeIdentity?.mappings).toHaveLength(4);

      await expect(
        runner.snapshot({
          runtimeConfigHash: published.runtimeConfigHash,
          sceneName: "LineJoints",
          sourcePath: SOURCE_PATH,
        }),
      ).resolves.toEqual(published);
      expect(starts).toBe(1);
      await expect(
        runner.snapshot({
          runtimeConfigHash: "f".repeat(64),
          sceneName: "LineJoints",
          sourcePath: SOURCE_PATH,
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await runner.close();
    }
  });

  it.each([
    [
      "parent membership",
      (envelope: LineJointsEnvelope) => {
        envelope.bundle.scene.entities[1]!.parentId = null;
      },
    ],
    [
      "effective join",
      (envelope: LineJointsEnvelope) => {
        const appearance = envelope.bundle.scene.entities[2]!.appearance;
        if (appearance.kind === "vector" && appearance.stroke) appearance.stroke.join = "miter";
      },
    ],
    [
      "arranged geometry",
      (envelope: LineJointsEnvelope) => {
        const geometry = envelope.bundle.scene.entities[3]!.geometry;
        if (geometry.kind === "cubic-path") geometry.path.subpaths[0]!.start.x += 0.001;
      },
    ],
  ])("rejects a %s substitution", async (_label, mutate) => {
    const { envelope, expected, sourceText } = await loadProducerFixture();
    const tampered = structuredClone(envelope) as unknown as LineJointsEnvelope;
    mutate(tampered);
    await expect(
      parseAndSealFastManimSnapshotProducerJsonV1(canonicalJsonV1(tampered), expected, sourceText),
    ).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("rejects family-path, runtime-type, and lifecycle substitutions", async () => {
    const { combined, expected, producer, sourceText } = await loadProducerFixture();
    const sealed = await parseAndSealFastManimSnapshotProducerJsonV1(producer.snapshotJson, expected, sourceText);
    if (sealed.kind !== "compiled") throw new Error("Expected one compiled V10 snapshot.");
    expect(() => assertFastManimSnapshotIdentityAuthorityV1(sealed, null)).toThrowError(
      expect.objectContaining({ code: "identity-evidence-invalid" }),
    );
    for (const mutate of [
      (document: LineJointsCombinedDocument) => {
        document.evidence.records[1]!.familyPath = [];
      },
      (document: LineJointsCombinedDocument) => {
        document.evidence.records[2]!.runtimeType = "manim.mobject.geometry.polygram.Square";
      },
      (document: LineJointsCombinedDocument) => {
        document.evidence.records[0]!.lifecycle[0]!.sequence = 5;
      },
    ]) {
      const document = structuredClone(combined.document) as unknown as LineJointsCombinedDocument;
      mutate(document);
      expect(() =>
        verifyFastManimSourceRuntimeIdentityV1({ ...combined, document }, { expected, snapshot: sealed, sourceText }),
      ).toThrowError(expect.objectContaining({ code: "identity-evidence-invalid" }));
    }
  });

  it("keeps the V10 renderer-semantics pin public for fixture and GPU evidence consumers", () => {
    expect(FAST_MANIM_LINE_JOINTS_SEMANTICS_SHA256_V10).toBe(
      "b6ffabc679f939f5fbbd9d3265c785edb0064d327df3a94c1fedcc79efd7a8cd",
    );
  });
});

type LineJointsEnvelope = {
  bundle: {
    scene: {
      entities: Array<{
        appearance:
          | { kind: "group"; opacity: number }
          | { kind: "vector"; stroke: null | { join: "bevel" | "miter" | "round" } };
        geometry:
          | { kind: "group" }
          | { kind: "cubic-path"; path: { subpaths: Array<{ start: { x: number; y: number } }> } };
        parentId: string | null;
      }>;
    };
  };
};

type LineJointsCombinedDocument = {
  evidence: {
    records: Array<{
      familyPath: number[];
      lifecycle: Array<{ action: string; sequence: number }>;
      runtimeType: string;
    }>;
  };
};
