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

describe("verifyFastManimSourceRuntimeIdentityV1 profile constructors", () => {
  it.each([
    [1, false],
    [2, false],
    [3, false],
    [4, true],
  ] as const)("maps a direct ImageMobject assignment only for snapshot profile %i", (snapshotVersion, supported) => {
    const sourceText = `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class ImageScene(Scene):
    def construct(self):
        image = ImageMobject("image.png", resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"])
        self.add(image)
`;
    const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
    const sceneId = `scene:${"a".repeat(64)}`;
    const runtimeConfigHash = "b".repeat(64);
    const snapshotHash = "c".repeat(64);
    const snapshotDigest = "d".repeat(64);
    const span = { endColumn: 13, endLine: 5, startColumn: 8, startLine: 5 };
    const bindingPayload = [
      FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
      String(FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1),
      sourceHash,
      sceneId,
      "image",
      "1",
      String(span.startLine),
      String(span.startColumn),
      String(span.endLine),
      String(span.endColumn),
    ].join("\u0000");
    const binding = {
      id: `source-binding:${createHash("sha256").update(bindingPayload, "utf8").digest("hex")}`,
      name: "image",
      ordinal: 1,
      span,
    };
    const entity = {
      id: `${sceneId}/entity:0`,
      provenanceId: `${sceneId}/provenance:entity:0`,
    };
    const expected = {
      frame: { height: 8, width: 14.222222222222221 },
      projectId: "default",
      requestId: `image-identity-v${snapshotVersion}`,
      runtimeConfigHash,
      snapshotVersion,
      sceneId,
      sceneName: "ImageScene",
      sourceHash,
      sourcePath: "scene.py",
    };
    const evidence = {
      issues: [],
      kind: "complete",
      projectId: expected.projectId,
      records: [
        {
          bindings: [{ binding, boundSequence: 1, releasedSequence: null }],
          entityId: entity.id,
          familyPath: [],
          lifecycle: [],
          provenanceId: entity.provenanceId,
          reasons: [],
          runtimeType: "manim.mobject.types.image_mobject.ImageMobject",
          sceneOrder: 0,
          status: "mapped",
        },
      ],
      requestId: expected.requestId,
      runtimeConfigHash,
      sceneId,
      sceneName: expected.sceneName,
      snapshotDigest,
      sourceHash,
      sourcePath: expected.sourcePath,
    };
    const result = verifyFastManimSourceRuntimeIdentityV1(
      { document: { evidence, snapshotDigest }, snapshotDigest },
      {
        expected,
        snapshot: {
          bundle: { scene: { entities: [entity] } },
          kind: "compiled",
          runtimeConfigHash,
          sceneId,
          snapshotHash,
          sourceHash,
        } as never,
        sourceText,
      },
    );

    expect(result?.mappings).toEqual(
      supported ? [{ binding, entityId: entity.id, familyPath: [], provenanceId: entity.provenanceId }] : [],
    );
  });

  it("maps parenthesized multiline Polygon and CubicBezier assignments with exact source ordinals in V6", () => {
    const sourceText = `from manim import Circle, CubicBezier, Polygon, Scene

class GenericLeaves(Scene):
    def construct(self):
        polygon = Polygon(
            [-2, -1, 0],
            [0, 1, 0],
            [2, -1, 0],
        )
        curve = CubicBezier(
            [-1, 0, 0],
            [-0.5, 1, 0],
            [0.5, -1, 0],
            [1, 0, 0],
        )
        circle = Circle(
            radius=1,
        )
        self.add(polygon, curve, circle)
`;
    const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
    const sceneId = `scene:${"e".repeat(64)}`;
    const runtimeConfigHash = "f".repeat(64);
    const snapshotHash = "1".repeat(64);
    const snapshotDigest = "2".repeat(64);
    const sourceLines = sourceText.split("\n");
    const bindings = ["polygon", "curve", "circle"].map((name, index) => {
      const lineIndex = sourceLines.findIndex((line) => line.trimStart().startsWith(`${name} =`));
      if (lineIndex < 0) throw new Error(`Expected the ${name} assignment in the identity fixture.`);
      const startColumn = Buffer.byteLength(
        sourceLines[lineIndex]!.slice(0, sourceLines[lineIndex]!.indexOf(name)),
        "utf8",
      );
      const span = {
        endColumn: startColumn + Buffer.byteLength(name, "utf8"),
        endLine: lineIndex + 1,
        startColumn,
        startLine: lineIndex + 1,
      };
      const ordinal = index + 1;
      const payload = [
        FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
        String(FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1),
        sourceHash,
        sceneId,
        name,
        String(ordinal),
        String(span.startLine),
        String(span.startColumn),
        String(span.endLine),
        String(span.endColumn),
      ].join("\u0000");
      return {
        id: `source-binding:${createHash("sha256").update(payload, "utf8").digest("hex")}`,
        name,
        ordinal,
        span,
      };
    });
    const entities = bindings.map((_, sceneOrder) => ({
      id: `${sceneId}/entity:${sceneOrder}`,
      provenanceId: `${sceneId}/provenance:entity:${sceneOrder}`,
    }));
    const verify = (snapshotVersion: 1 | 6) => {
      const expected = {
        frame: { height: 8, width: 14.222222222222221 },
        projectId: "default",
        requestId: `generic-multiline-identity-v${snapshotVersion}`,
        runtimeConfigHash,
        snapshotVersion,
        sceneId,
        sceneName: "GenericLeaves",
        sourceHash,
        sourcePath: "scene.py",
      };
      const evidence = {
        issues: [],
        kind: "complete",
        projectId: expected.projectId,
        records: bindings.map((binding, sceneOrder) => ({
          bindings: [{ binding, boundSequence: sceneOrder + 1, releasedSequence: null }],
          entityId: entities[sceneOrder]!.id,
          familyPath: [],
          lifecycle: [],
          provenanceId: entities[sceneOrder]!.provenanceId,
          reasons: [],
          runtimeType: `manim.${["Polygon", "CubicBezier", "Circle"][sceneOrder]}`,
          sceneOrder,
          status: "mapped",
        })),
        requestId: expected.requestId,
        runtimeConfigHash,
        sceneId,
        sceneName: expected.sceneName,
        snapshotDigest,
        sourceHash,
        sourcePath: expected.sourcePath,
      };
      const result = verifyFastManimSourceRuntimeIdentityV1(
        { document: { evidence, snapshotDigest }, snapshotDigest },
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
      return result?.mappings;
    };

    expect(verify(6)).toEqual(
      bindings.map((binding, index) => ({
        binding,
        entityId: entities[index]!.id,
        familyPath: [],
        provenanceId: entities[index]!.provenanceId,
      })),
    );
    expect(verify(1)).toEqual([]);
  });

  it("publishes V5 as one explicitly ambiguous display-only render track", () => {
    const sourceText = String.raw`from manim import MathTex, Scene, TransformMatchingTex, smoothstep

class EquationMorph(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        maxwell = MathTex(r"\nabla \cdot \mathbf{E}")
        maxwell.move_to(equation.get_center())
        self.play(TransformMatchingTex(equation, maxwell, transform_mismatches=True), run_time=1, rate_func=smoothstep)
        equation = maxwell
        restored = MathTex("E = mc^2")
        restored.move_to(maxwell.get_center())
        self.play(TransformMatchingTex(maxwell, restored, transform_mismatches=True), run_time=1, rate_func=smoothstep)
        maxwell = restored
        equation = restored
`;
    const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
    const sceneId = `scene:${"a".repeat(64)}`;
    const runtimeConfigHash = "b".repeat(64);
    const snapshotHash = "c".repeat(64);
    const snapshotDigest = "d".repeat(64);
    const lines = sourceText.split("\n");
    const binding = (name: string, ordinal: number) => {
      const lineIndex = lines.findIndex((line) => line.trimStart().startsWith(`${name} = MathTex`));
      const startColumn = Buffer.byteLength(lines[lineIndex]!.slice(0, lines[lineIndex]!.indexOf(name)), "utf8");
      const span = {
        endColumn: startColumn + Buffer.byteLength(name, "utf8"),
        endLine: lineIndex + 1,
        startColumn,
        startLine: lineIndex + 1,
      };
      const payload = [
        FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
        String(FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1),
        sourceHash,
        sceneId,
        name,
        String(ordinal),
        String(span.startLine),
        String(span.startColumn),
        String(span.endLine),
        String(span.endColumn),
      ].join("\u0000");
      return {
        id: `source-binding:${createHash("sha256").update(payload, "utf8").digest("hex")}`,
        name,
        ordinal,
        span,
      };
    };
    const bindings = [binding("equation", 1), binding("maxwell", 2), binding("restored", 3)];
    const entity = {
      id: `${sceneId}/entity:0`,
      provenanceId: `${sceneId}/provenance:entity:0`,
    };
    const expected = {
      frame: { height: 8, width: 14.222222222222221 },
      projectId: "default",
      requestId: "mathtex-morph-identity-v5",
      runtimeConfigHash,
      snapshotVersion: 5 as const,
      sceneId,
      sceneName: "EquationMorph",
      sourceHash,
      sourcePath: "scene.py",
    };
    const record = {
      bindings: bindings.map((sourceBinding, index) => ({
        binding: sourceBinding,
        boundSequence: index + 1,
        releasedSequence: null,
      })),
      entityId: entity.id,
      familyPath: [],
      lifecycle: [],
      provenanceId: entity.provenanceId,
      reasons: ["multiple-active-source-bindings"],
      runtimeType: "manim.mobject.text.tex_mobject.MathTex",
      sceneOrder: 0,
      status: "ambiguous",
    };
    const evidence = {
      issues: [],
      kind: "complete",
      projectId: expected.projectId,
      records: [record],
      requestId: expected.requestId,
      runtimeConfigHash,
      sceneId,
      sceneName: expected.sceneName,
      snapshotDigest,
      sourceHash,
      sourcePath: expected.sourcePath,
    };
    const input = {
      expected,
      snapshot: {
        bundle: { scene: { entities: [entity] } },
        kind: "compiled",
        runtimeConfigHash,
        sceneId,
        snapshotHash,
        sourceHash,
      } as never,
      sourceText,
    };

    expect(
      verifyFastManimSourceRuntimeIdentityV1({ document: { evidence, snapshotDigest }, snapshotDigest }, input)
        ?.mappings,
    ).toEqual([]);

    const forgedMappedEvidence = {
      ...evidence,
      records: [{ ...record, bindings: [record.bindings[0]!], reasons: [], status: "mapped" }],
    };
    expect(() =>
      verifyFastManimSourceRuntimeIdentityV1(
        { document: { evidence: forgedMappedEvidence, snapshotDigest }, snapshotDigest },
        input,
      ),
    ).toThrowError(expect.objectContaining({ code: "identity-evidence-invalid" }));
  });
});
