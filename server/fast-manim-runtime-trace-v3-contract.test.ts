import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { studioSourceAnalysisProviderV1 } from "../src/render-pipeline/source-analysis";
import {
  createFastManimRuntimeTraceConfigV3,
  createFastManimRuntimeTraceProducerRequestV3,
  digestFastManimRuntimeTraceConfigV3,
  FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3,
  fastManimRuntimeTraceProducerRequestV3Schema,
  fastManimRuntimeTraceSourceBindingsFromAnalysisV3,
} from "./fast-manim-runtime-trace-v3-contract";

const frame = { height: 8, width: 128 / 9 } as const;
const sourceText = [
  "from manim import *",
  "",
  "class DynamicDemo(Scene):",
  "    def construct(self):",
  "        self.add(Square())",
  "",
].join("\n");
const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");

function run(sceneName = "DynamicDemo") {
  return {
    projectId: "demo",
    requestId: `trace-${sceneName.toLowerCase()}`,
    sceneName,
    sourceHash,
    sourcePath: "scenes/demo.py",
  };
}

describe("generic Runtime Trace V3 request contract", () => {
  it("matches the producer's canonical config digest", () => {
    const config = createFastManimRuntimeTraceConfigV3(frame);
    expect(config.maxFrameCount).toBe(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3);
    expect(digestFastManimRuntimeTraceConfigV3(config)).toBe(
      "746f68cc656a3045643730e4fab8a94d35351c04354d83d5a2ca88808fcef720",
    );
  });

  it("builds requests without a Scene-name or source-hash allowlist", () => {
    const request = createFastManimRuntimeTraceProducerRequestV3(
      run(),
      sourceText,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
    );
    expect(request).toMatchObject({
      profileVersion: 3,
      sceneName: "DynamicDemo",
      sourceHash,
      sourceBindings: [],
      version: 3,
    });

    const secondSource = sourceText.replace("DynamicDemo", "AnotherDemo");
    const second = createFastManimRuntimeTraceProducerRequestV3(
      {
        ...run("AnotherDemo"),
        sourceHash: createHash("sha256").update(secondSource, "utf8").digest("hex"),
      },
      secondSource,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
    );
    expect(second.sceneName).toBe("AnotherDemo");
    expect(second.sceneId).not.toBe(request.sceneId);
  });

  it("projects exact direct SourceAnalysis assignments into canonical bounded bindings", () => {
    const boundSource = [
      "from manim import *",
      "",
      "class BoundDemo(Scene):",
      "    def construct(self):",
      "        square = Square()",
      "        if True:",
      "            conditional = Circle()",
      "        self.add(square)",
      "",
    ].join("\n");
    const boundSourceHash = createHash("sha256").update(boundSource, "utf8").digest("hex");
    const boundRun = {
      ...run("BoundDemo"),
      sourceHash: boundSourceHash,
      sourcePath: "scenes/bound.py",
    };
    const generic = createFastManimRuntimeTraceProducerRequestV3(
      boundRun,
      boundSource,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
    );
    const analysis = studioSourceAnalysisProviderV1.analyze({
      expectedSourceHash: boundSourceHash,
      sceneName: "BoundDemo",
      sourcePath: boundRun.sourcePath,
      sourceText: boundSource,
    });
    const sourceBindings = fastManimRuntimeTraceSourceBindingsFromAnalysisV3(analysis, generic.sceneId);
    expect(() => fastManimRuntimeTraceSourceBindingsFromAnalysisV3(analysis, "scene:forged")).toThrow("another Scene");
    const request = createFastManimRuntimeTraceProducerRequestV3(
      boundRun,
      boundSource,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
      sourceBindings,
    );

    expect(request.sourceBindings).toEqual([
      {
        id: expect.stringMatching(/^source-binding:[0-9a-f]{64}$/u),
        name: "square",
        ordinal: 1,
        span: { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 },
      },
    ]);
    expect(
      fastManimRuntimeTraceProducerRequestV3Schema.safeParse({
        ...request,
        sourceBindings: [{ ...request.sourceBindings[0]!, id: `source-binding:${"f".repeat(64)}` }],
      }).success,
    ).toBe(false);
    expect(
      fastManimRuntimeTraceProducerRequestV3Schema.safeParse({
        ...request,
        sourceBindings: [request.sourceBindings[0]!, request.sourceBindings[0]!],
      }).success,
    ).toBe(false);
  });

  it("omits bindings that SourceAnalysis cannot edit without ambiguity", () => {
    const aliasedSource = [
      "from manim import *",
      "",
      "class AliasedDemo(Scene):",
      "    def construct(self):",
      "        square = Square()",
      "        alias = square",
      "        self.add(alias)",
      "",
    ].join("\n");
    const aliasedSourceHash = createHash("sha256").update(aliasedSource, "utf8").digest("hex");
    const analysis = studioSourceAnalysisProviderV1.analyze({
      expectedSourceHash: aliasedSourceHash,
      sceneName: "AliasedDemo",
      sourcePath: "scenes/aliased.py",
      sourceText: aliasedSource,
    });

    expect(
      fastManimRuntimeTraceSourceBindingsFromAnalysisV3(
        analysis,
        createFastManimRuntimeTraceProducerRequestV3(
          {
            ...run("AliasedDemo"),
            sourceHash: aliasedSourceHash,
            sourcePath: "scenes/aliased.py",
          },
          aliasedSource,
          { constructStartLine: 4, definitionOrdinal: 1 },
          frame,
        ).sceneId,
      ),
    ).toEqual([]);
  });

  it("omits producer-inexpressible candidates without disabling the preview", () => {
    const boundSource = [
      "from manim import *",
      "",
      "class BoundDemo(Scene):",
      "    def construct(self):",
      "        square = Square()",
      "",
    ].join("\n");
    const boundSourceHash = createHash("sha256").update(boundSource, "utf8").digest("hex");
    const analysis = studioSourceAnalysisProviderV1.analyze({
      expectedSourceHash: boundSourceHash,
      sceneName: "BoundDemo",
      sourcePath: "scenes/bound.py",
      sourceText: boundSource,
    });
    const binding = analysis.bindings.find(({ name }) => name === "square")!;
    const projectedAnalysis = {
      ...analysis,
      bindings: [
        binding,
        { ...binding, name: "not valid", ordinal: 2 },
        {
          ...binding,
          name: "other",
          ordinal: 3,
          span: { ...binding.span, endLine: binding.span.endLine + 1 },
        },
      ],
    };
    const request = createFastManimRuntimeTraceProducerRequestV3(
      {
        ...run("BoundDemo"),
        sourceHash: boundSourceHash,
        sourcePath: "scenes/bound.py",
      },
      boundSource,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
    );

    const sourceBindings = fastManimRuntimeTraceSourceBindingsFromAnalysisV3(projectedAnalysis, request.sceneId);
    expect(sourceBindings).toEqual([expect.objectContaining({ name: "square", ordinal: 1 })]);
    expect(() =>
      createFastManimRuntimeTraceProducerRequestV3(
        {
          ...run("BoundDemo"),
          sourceHash: boundSourceHash,
          sourcePath: "scenes/bound.py",
        },
        boundSource,
        { constructStartLine: 4, definitionOrdinal: 1 },
        frame,
        sourceBindings,
      ),
    ).not.toThrow();
  });

  it("omits NFKC-changing names and deterministically caps projected bindings", () => {
    const assignmentLines = Array.from(
      { length: 130 },
      (_, index) => `        shape_${String(index + 1).padStart(3, "0")} = Square()`,
    );
    const manySource = [
      "from manim import *",
      "",
      "class ManyDemo(Scene):",
      "    def construct(self):",
      ...assignmentLines,
      "",
    ].join("\n");
    const manySourceHash = createHash("sha256").update(manySource, "utf8").digest("hex");
    const analysis = studioSourceAnalysisProviderV1.analyze({
      expectedSourceHash: manySourceHash,
      sceneName: "ManyDemo",
      sourcePath: "scenes/many.py",
      sourceText: manySource,
    });
    const first = analysis.bindings.find(({ name }) => name === "shape_001")!;
    const projectedAnalysis = {
      ...analysis,
      bindings: [{ ...first, name: "𝐬quare", ordinal: 0 }, ...analysis.bindings],
    };
    const request = createFastManimRuntimeTraceProducerRequestV3(
      {
        ...run("ManyDemo"),
        sourceHash: manySourceHash,
        sourcePath: "scenes/many.py",
      },
      manySource,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
    );

    const projected = fastManimRuntimeTraceSourceBindingsFromAnalysisV3(projectedAnalysis, request.sceneId);
    expect(projected).toHaveLength(128);
    expect(projected.map(({ ordinal }) => ordinal)).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
    expect(projected.some(({ name }) => name === "𝐬quare")).toBe(false);
  });

  it("rejects stale source identity, non-canonical cameras, and invalid Unicode", () => {
    const request = createFastManimRuntimeTraceProducerRequestV3(
      run(),
      sourceText,
      { constructStartLine: 4, definitionOrdinal: 1 },
      frame,
    );
    expect(
      fastManimRuntimeTraceProducerRequestV3Schema.safeParse({ ...request, sourceHash: "0".repeat(64) }).success,
    ).toBe(false);
    expect(() => createFastManimRuntimeTraceConfigV3({ height: 8, width: 16 })).toThrow();
    expect(fastManimRuntimeTraceProducerRequestV3Schema.safeParse({ ...request, sourceText: "\ud800" }).success).toBe(
      false,
    );
  });
});
