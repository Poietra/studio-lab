import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  insertAtSourceBoundaryV1,
  removeDirectSourceStatementsV1,
  SourceAnalysisError,
  type StudioSourceAnalysisV1,
  studioSourceAnalysisProviderV1,
} from "./source-analysis";

const officialPath = "example_scenes/basic.py";
const officialSource = readFileSync(
  new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);

function hash(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function analyze(source: string, sceneName = "SquareToCircle", sourcePath = officialPath) {
  return studioSourceAnalysisProviderV1.analyze({
    expectedSourceHash: hash(source),
    sceneName,
    sourcePath,
    sourceText: source,
  });
}

describe("Studio CST SourceAnalysis V1", () => {
  it("returns one source-only Scene occurrence, structural calls, bindings, and canonical insertion spans", () => {
    const analysis = analyze(officialSource);
    const setup = analysis.scene.statements.find(
      (statement) => statement.text === "circle.set_fill(PINK, opacity=0.5)",
    );
    const firstPlay = analysis.scene.statements.find((statement) => statement.text === "self.play(Create(square))");
    const bindings = analysis.bindings.filter(({ scopeId }) => scopeId === analysis.scene.construct.scopeId);

    expect(analysis).toMatchObject({
      schema: "poietra.studio-source-analysis",
      sourceHash: hash(officialSource),
      sourcePath: officialPath,
      toolVersion: "@lezer/python@1.1.19/studio-v1",
      version: 1,
    });
    expect(analysis.scene).toMatchObject({
      baseExpressions: [{ text: "Scene" }],
      bindingBlockers: [],
      classLine: 72,
      name: "SquareToCircle",
    });
    expect(analysis.scene.ordinal).toBeGreaterThan(1);
    expect(bindings.map(({ name }) => name)).toEqual(["self", "circle", "square"]);
    expect(bindings.find(({ name }) => name === "square")).toMatchObject({
      ambiguous: false,
      capabilities: {
        move: { status: "source-eligible" },
        uniformResize: { status: "source-eligible" },
      },
      constructorCall: { path: ["Square"] },
      kind: "assignment",
      ordinal: 2,
    });
    expect(setup?.calls.map(({ path }) => path)).toEqual([["circle", "set_fill"]]);
    expect(setup?.insertionAfter).toMatchObject({ indentation: "        ", line: 78 });
    expect(firstPlay?.insertionBefore).toMatchObject({ indentation: "        ", line: 80 });
    const expectedOffset = Buffer.byteLength(
      officialSource.slice(0, officialSource.indexOf("        self.play(Create")),
    );
    expect(firstPlay?.insertionBefore?.span).toEqual({ endByte: expectedOffset, startByte: expectedOffset });

    const inserted = insertAtSourceBoundaryV1(officialSource, analysis, firstPlay!.insertionBefore!, [
      "        square.move_to((2, 1, 0))",
      "        circle.move_to((2, 1, 0))",
    ]);
    expect(inserted.replace("        square.move_to((2, 1, 0))\n        circle.move_to((2, 1, 0))\n", "")).toBe(
      officialSource,
    );
  });

  it("keeps string, comment, and docstring identifiers inert and distinguishes nested function shadowing", () => {
    const source = [
      'decoy = """class Real(Scene):',
      "    def construct(self):",
      "        square = Square()",
      '"""',
      "# class Real(Scene):",
      "class Real(Scene):",
      "    def construct(self):",
      '        """square = Square() and circle.move_to(ORIGIN)"""',
      "        # square = Circle()",
      "        square = Square()",
      "        def nested(square):",
      "            square = Circle()",
      "            return square",
      "        square.move_to(ORIGIN)",
      "",
    ].join("\n");
    const analysis = analyze(source, "Real", "scene.py");
    const squareBindings = analysis.bindings.filter(({ name }) => name === "square");
    const outer = squareBindings.find(
      ({ kind, scopeId }) => kind === "assignment" && scopeId === analysis.scene.construct.scopeId,
    );
    const nestedParameter = squareBindings.find(({ kind }) => kind === "parameter");

    expect(analysis.scene.statements.map(({ text }) => text)).toEqual([
      '"""square = Square() and circle.move_to(ORIGIN)"""',
      "square = Square()",
      "def nested(square):\nsquare = Circle()\nreturn square",
      "square.move_to(ORIGIN)",
    ]);
    expect(analysis.identifierTokens.filter(({ name }) => name === "circle")).toHaveLength(0);
    expect(outer).toMatchObject({ ambiguous: false, constructorCall: { path: ["Square"] } });
    expect(nestedParameter).toMatchObject({ shadowedBindingId: outer?.id });
    expect(new Set(squareBindings.map(({ scopeId }) => scopeId)).size).toBe(2);
    expect(analysis.scene.bindingBlockers).toContainEqual({
      kind: "function-definition-binding",
      statementId: analysis.scene.statements[2]!.id,
    });
    expect(outer?.capabilities.move).toEqual({ status: "source-eligible" });
  });

  it("marks same-scope rebinding and control-flow assignments unknown instead of guessing capabilities", () => {
    const source = [
      "class Real(Scene):",
      "    def construct(self):",
      "        square = Square()",
      "        if enabled:",
      "            circle = Circle()",
      "        square = Circle()",
      "",
    ].join("\n");
    const analysis = analyze(source, "Real", "scene.py");
    const squares = analysis.bindings.filter(({ name }) => name === "square");
    const circle = analysis.bindings.find(({ name }) => name === "circle");

    expect(squares).toHaveLength(2);
    expect(squares.every(({ ambiguous }) => ambiguous)).toBe(true);
    expect(squares[0]?.capabilities.move).toEqual({ reason: "ambiguous-binding", status: "unknown" });
    expect(circle).toMatchObject({ controlPath: ["IfStatement"] });
    expect(circle?.capabilities.uniformResize).toEqual({ reason: "dynamic-control-flow", status: "unknown" });
  });

  it("fails closed when an exception handler introduces a construct-scope binding", () => {
    const source = [
      "class Real(Scene):",
      "    def construct(self):",
      "        square = Square()",
      "        try:",
      "            pass",
      "        except Exception as square:",
      "            pass",
      "",
    ].join("\n");
    const analysis = analyze(source, "Real", "scene.py");
    const square = analysis.bindings.find(({ kind, name }) => kind === "assignment" && name === "square");

    expect(analysis.scene.bindingBlockers).toContainEqual({
      kind: "TryStatement-target-binding",
      statementId: analysis.scene.statements[1]!.id,
    });
    expect(square?.capabilities.move).toEqual({ reason: "unsupported-binding-form", status: "unknown" });

    const destructuredLoop = [
      "class Real(Scene):",
      "    def construct(self):",
      "        for (left, right) in [(1, 2)]:",
      "            pass",
      "        square = Square()",
      "",
    ].join("\n");
    const loopAnalysis = analyze(destructuredLoop, "Real", "scene.py");
    expect(loopAnalysis.scene.bindingBlockers).toContainEqual({
      kind: "ForStatement-target-binding",
      statementId: loopAnalysis.scene.statements[0]!.id,
    });
    expect(loopAnalysis.bindings.find(({ name }) => name === "square")?.capabilities.move).toEqual({
      status: "source-eligible",
    });

    const unrelatedRhs = [
      "class Real(Scene):",
      "    def construct(self):",
      "        square = Square()",
      "        left, right = consume(square)",
      "        self.wait(1)",
      "",
    ].join("\n");
    expect(
      analyze(unrelatedRhs, "Real", "scene.py").bindings.find(({ name }) => name === "square")?.capabilities.move,
    ).toEqual({ status: "source-eligible" });

    const matchAlias = [
      "class Real(Scene):",
      "    def construct(self):",
      "        target = Circle()",
      "        alias = Square()",
      "        match value:",
      "            case pattern as alias:",
      "                pass",
      "        self.wait(1)",
      "",
    ].join("\n");
    const matchAnalysis = analyze(matchAlias, "Real", "scene.py");
    expect(matchAnalysis.bindings.find(({ name }) => name === "target")?.capabilities.move).toEqual({
      status: "source-eligible",
    });
    expect(matchAnalysis.bindings.find(({ name }) => name === "alias")?.capabilities.move).toEqual({
      reason: "unsupported-binding-form",
      status: "unknown",
    });
  });

  it("fails closed for stale bytes, duplicate Scene occurrences, strict-grammar gaps, and forged payloads", () => {
    expect(() =>
      studioSourceAnalysisProviderV1.analyze({
        expectedSourceHash: hash(officialSource),
        sceneName: "SquareToCircle",
        sourcePath: officialPath,
        sourceText: `${officialSource}# changed\n`,
      }),
    ).toThrowError(new SourceAnalysisError("stale-source", "Source analysis requires the exact current source hash."));

    const duplicate = `${officialSource}\nclass SquareToCircle(Scene):\n    def construct(self):\n        pass\n`;
    expect(() => analyze(duplicate)).toThrowError(/2 source occurrences/);
    const unsupportedSources = [
      "class Real(Scene):\n    def construct(self):\n        yield\n",
      "class Real(Scene):\n    def construct(self):\n        with (open('a') as a, open('b') as b):\n            pass\n",
    ];
    for (const unsupported of unsupportedSources) {
      expect(() => analyze(unsupported, "Real", "scene.py")).toThrowError(/Strict CST parsing rejected/);
    }
    expect(() =>
      analyze("class Real(Scene):\r    def construct(self):\r        pass\r", "Real", "scene.py"),
    ).toThrowError(/CR-only/);

    const analysis = analyze(officialSource);
    const boundary = analysis.scene.statements[5]!.insertionBefore!;
    expect(() =>
      insertAtSourceBoundaryV1(
        officialSource,
        analysis,
        { ...boundary, span: { ...boundary.span, startByte: boundary.span.startByte + 1 } },
        ["        square.move_to((2, 1, 0))"],
      ),
    ).toThrowError(/not canonical provider evidence/);
    const forged = { ...analysis, scene: { ...analysis.scene, id: "source-scene:forged" } } as StudioSourceAnalysisV1;
    expect(() =>
      insertAtSourceBoundaryV1(officialSource, forged, boundary, ["        square.move_to((2, 1, 0))"]),
    ).toThrowError(/payload is not canonical/);
  });

  it("counts UTF-8 bytes with CRLF exactly and uses the canonical boundary newline", () => {
    const source = [
      "# 日本語",
      "class First(Scene):",
      "    def construct(self):",
      "        pass",
      "class Real(Scene):",
      "    def construct(self):",
      "        circle = Circle()",
      "        self.add(circle)",
      "",
    ].join("\r\n");
    const analysis = analyze(source, "Real", "scene.py");
    const circle = analysis.bindings.find(({ name }) => name === "circle");
    const boundary = analysis.scene.statements[1]!.insertionBefore!;

    expect(analysis.scene.ordinal).toBe(2);
    expect(circle?.span).toMatchObject({ startColumn: 8, startLine: 7 });
    expect(circle?.span.startByte).toBe(Buffer.byteLength(source.slice(0, source.indexOf("circle = Circle()"))));
    expect(boundary.newline).toBe("\r\n");
    expect(insertAtSourceBoundaryV1(source, analysis, boundary, ["        circle.move_to((1, 0, 0))"])).toContain(
      "circle = Circle()\r\n        circle.move_to((1, 0, 0))\r\n        self.add(circle)",
    );
  });

  it("recovers candidate bytes only by deleting exact canonical direct statements", () => {
    const base = [
      "class Real(Scene):",
      "    def construct(self):",
      "        square = Square()",
      "        self.wait()",
      "",
    ].join("\n");
    const baseAnalysis = analyze(base, "Real", "scene.py");
    const candidate = insertAtSourceBoundaryV1(base, baseAnalysis, baseAnalysis.scene.statements[1]!.insertionBefore!, [
      "        square.move_to((2, 1, 0))",
      "        square.scale(1.5)",
    ]);
    const candidateAnalysis = analyze(candidate, "Real", "scene.py");
    const edits = candidateAnalysis.scene.statements.slice(1, 3);

    expect(
      removeDirectSourceStatementsV1(
        candidate,
        candidateAnalysis,
        edits.map((statement) => ({ expectedText: statement.text, statementId: statement.id })),
      ),
    ).toBe(base);
    expect(() =>
      removeDirectSourceStatementsV1(candidate, candidateAnalysis, [
        { expectedText: "square.scale(2)", statementId: edits[1]!.id },
      ]),
    ).toThrowError(/exact canonical direct statement/);
  });

  it("does not expose an insertion or deletion span when the final statement has no newline", () => {
    const source = "class Real(Scene):\n    def construct(self):\n        circle = Circle()";
    const analysis = analyze(source, "Real", "scene.py");

    expect(analysis.scene.statements[0]).toMatchObject({
      deletionSpan: null,
      insertionAfter: null,
      insertionBefore: null,
      text: "circle = Circle()",
    });
  });
});
