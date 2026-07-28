import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
} from "../src/engine/source-runtime-identity";
import { MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES } from "./fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "./fast-manim-source-runtime-document";
import { verifyFastManimSourceRuntimeIdentityV1 } from "./fast-manim-source-runtime-identity";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Non-JSON fixture value.");
}

function combinedDocument(snapshotJson = "{}") {
  return {
    evidence: {},
    schema: FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
    snapshotDigest: createHash("sha256").update(snapshotJson, "utf8").digest("hex"),
    snapshotJson,
    version: FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
  };
}

describe("parseFastManimProducerDocumentV1", () => {
  it("keeps legacy snapshot-only producers compatible", () => {
    const legacy = '{"schema":"poietra.fast-manim-snapshot-result","version":1}';
    expect(parseFastManimProducerDocumentV1(legacy)).toEqual({ combined: null, snapshotJson: legacy });
  });

  it("matches the current fast-manim snapshotJson envelope and raw byte budget", () => {
    // Python's canonical exponent spelling stays opaque inside snapshotJson;
    // JavaScript must never parse and reserialize these paired bytes.
    const currentSnapshotJson = '{"label":"円","value":1e-07}';
    const wire = `${canonicalJson(combinedDocument(currentSnapshotJson))}\n`;
    const parsed = parseFastManimProducerDocumentV1(wire);
    expect(MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES).toBe(12_681_216 + 1);
    expect(parsed.snapshotJson).toBe(currentSnapshotJson);
    expect(parsed.combined?.snapshotDigest).toBe(createHash("sha256").update(currentSnapshotJson).digest("hex"));
    expect(Object.keys(parsed.combined?.document ?? {})).toEqual([
      "evidence",
      "schema",
      "snapshotDigest",
      "snapshotJson",
      "version",
    ]);

    const removedWire = canonicalJson({
      evidence: {},
      schema: FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
      snapshot: {},
      snapshotDigest: createHash("sha256").update("{}", "utf8").digest("hex"),
      version: FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
    });
    expect(() => parseFastManimProducerDocumentV1(removedWire)).toThrowError(
      expect.objectContaining({ code: "identity-evidence-invalid" }),
    );
  });

  it.each([
    [
      "nested duplicate keys",
      `{"evidence":{"a":1,"a":2},"schema":"${FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1}","snapshotDigest":"${createHash("sha256").update("{}").digest("hex")}","snapshotJson":"{}","version":1}`,
    ],
    ["separator whitespace", canonicalJson(combinedDocument()).replace('"evidence":', '"evidence": ')],
    [
      "unsorted keys",
      `{"schema":"${FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1}","evidence":{},"snapshotDigest":"${createHash("sha256").update("{}").digest("hex")}","snapshotJson":"{}","version":1}`,
    ],
    ["more than one trailing LF", `${canonicalJson(combinedDocument())}\n\n`],
  ])("rejects noncanonical combined JSON with %s", (_case, wire) => {
    expect(() => parseFastManimProducerDocumentV1(wire)).toThrowError(
      expect.objectContaining({ code: "identity-evidence-invalid" }),
    );
  });

  it("enforces the dedicated raw combined-result cap before parsing", () => {
    const oversized = new Uint8Array(MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES + 1);
    expect(() => parseFastManimProducerDocumentV1(oversized)).toThrowError(
      expect.objectContaining({ code: "result-too-large" }),
    );
  });
});

describe("verifyFastManimSourceRuntimeIdentityV1 complexity", () => {
  it("pre-indexes one large UTF-8 source line once for the maximum 10,000 same-span claims", () => {
    const sourceText = `from manim import *\n\nclass ExampleScene(Scene):\n    def construct(self):\n        circle = Circle()  # ${"界".repeat(80_000)}\n        self.add(circle)\n`;
    const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
    const sceneId = `scene:${"a".repeat(64)}`;
    const runtimeConfigHash = "b".repeat(64);
    const snapshotHash = "c".repeat(64);
    const snapshotDigest = "d".repeat(64);
    const span = { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 };
    const binding = (ordinal: number) => {
      const payload = [
        FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
        String(FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1),
        sourceHash,
        sceneId,
        "circle",
        String(ordinal),
        String(span.startLine),
        String(span.startColumn),
        String(span.endLine),
        String(span.endColumn),
      ].join("\u0000");
      return {
        id: `source-binding:${createHash("sha256").update(payload, "utf8").digest("hex")}`,
        name: "circle",
        ordinal,
        span,
      };
    };
    const claimCount = 10_000;
    const claims = Array.from({ length: claimCount }, (_, index) => ({
      binding: binding(index + 1),
      boundSequence: index * 2 + 1,
      releasedSequence: index + 1 === claimCount ? null : index * 2 + 2,
    }));
    const records = Array.from({ length: Math.ceil(claimCount / 64) }, (_, sceneOrder) => {
      const recordClaims = claims.slice(sceneOrder * 64, (sceneOrder + 1) * 64);
      const active = recordClaims.some((claim) => claim.releasedSequence === null);
      return {
        bindings: recordClaims,
        entityId: `${sceneId}/entity:${sceneOrder}`,
        familyPath: [],
        lifecycle: [],
        provenanceId: `${sceneId}/provenance:entity:${sceneOrder}`,
        reasons: active ? [] : ["no-active-source-binding"],
        runtimeType: "manim.mobject.geometry.arc.Circle",
        sceneOrder,
        status: active ? "mapped" : "unmatched",
      };
    });
    const entities = records.map((record) => ({ id: record.entityId, provenanceId: record.provenanceId }));
    const expected = {
      frame: { height: 8, width: 14.222222222222221 },
      projectId: "default",
      requestId: "identity-complexity",
      runtimeConfigHash,
      snapshotVersion: 1 as const,
      sceneId,
      sceneName: "ExampleScene",
      sourceHash,
      sourcePath: "scene.py",
    };
    const evidence = {
      issues: [],
      kind: "complete",
      projectId: expected.projectId,
      records,
      requestId: expected.requestId,
      runtimeConfigHash,
      sceneId,
      sceneName: expected.sceneName,
      snapshotDigest,
      sourceHash,
      sourcePath: expected.sourcePath,
    };
    const result = verifyFastManimSourceRuntimeIdentityV1(
      {
        document: { evidence, snapshotDigest },
        snapshotDigest,
      },
      {
        expected,
        snapshot: {
          bundle: { scene: { entities } },
          kind: "compiled",
          runtimeConfigHash,
          sceneId,
          snapshotHash,
          sourceHash,
        } as never,
        sourceText,
      },
    );
    // Only ordinal 1 is a derivable source site; the sole active claim is the
    // forged ordinal 10,000, so validation completes but Studio gets no map.
    expect(result?.mappings).toEqual([]);
  });
});
