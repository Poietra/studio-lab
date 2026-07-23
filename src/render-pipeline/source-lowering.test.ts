import { describe, expect, it } from "vitest";

import { programRenderRequestSchema, type ProgramRenderRequest } from "./contracts";
import {
  findMotionAnchors,
  findSceneMotionAnchors,
  lowerCanonicalProgramBatchSource,
  lowerCanonicalProgramSource,
} from "./source-lowering";
import { importManimScene } from "./source-import";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";

const source = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        # poietra:anchor 7.000
        self.wait(1)
`;

const roundTripSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.play(equation.animate.shift(2 * RIGHT + UP), run_time=1)
        self.wait(6)
        # poietra:anchor 7.000
        self.wait(1)
`;

const temporalMetadataSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(5)
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:cursor 7.000
        self.wait(1)
        # poietra:anchor 8.000
        # poietra:scene-boundary {"at":8,"destination":"scene.py#Next"}
        self.wait(1)
`;

function canonicalProgram(
  operations: readonly CanonicalEditOperation[],
  transactionId = "render-test",
): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: 7,
      evidence: ["captured-playhead:7.000"],
      resolvedSeconds: 7,
      source: { kind: "playhead", referenceSeconds: 7 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations,
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: operations.map((operation) => operation.id) },
    transactionId,
    version: 1,
  };
}

function motionOperation(overrides: Partial<Extract<CanonicalEditOperation, { kind: "CreateMotion" }>> = {}) {
  return {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 64, y: -45 },
    dependsOn: [],
    easing: "smooth",
    id: "tx:render-test/operation:motion",
    interval: { end: 8.5, start: 7 },
    kind: "CreateMotion",
    provenance: { evidence: [], origin: "direct-manipulation" },
    targetEntityIds: ["equation_1"],
    ...overrides,
  } satisfies CanonicalEditOperation;
}

function motionProgramAt(anchor: number, duration: number, transactionId: string) {
  const operation = motionOperation({
    id: `tx:${transactionId}/operation:motion`,
    interval: { end: anchor + duration, start: anchor },
  });
  return {
    ...canonicalProgram([operation], transactionId),
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead" as const, referenceSeconds: anchor },
    },
  } satisfies CanonicalEditProgram;
}

function request(
  program = canonicalProgram([motionOperation()]),
  sourceBindings: ProgramRenderRequest["sourceBindings"] = [{ entityId: "equation_1", sourceVariable: "equation" }],
): ProgramRenderRequest {
  return {
    destination: null,
    program,
    projectId: "default",
    sceneName: "GroupedEquation",
    sourceBindings,
    sourceHash: "a".repeat(64),
    sourcePath: "examples/relativity.py",
    viewport: { height: 360, width: 640 },
  };
}

function operationBase(id: string, start: number, end = start) {
  return {
    dependsOn: [],
    id,
    interval: { end, start },
    provenance: { evidence: [], origin: "remote-model" as const },
  };
}

function durationWaitProgram(duration: number, transactionId: string) {
  const operation: CanonicalEditOperation = {
    ...operationBase(`tx:${transactionId}/operation:duration-wait`, 7, 7 + duration),
    eventKind: "wait",
    kind: "InsertTimelineEvent",
    label: `Extend Scene by ${duration}s`,
    purpose: "scene-duration",
    provenance: { evidence: ["Scene duration control"], origin: "studio-default" },
  };
  return {
    ...canonicalProgram([operation], transactionId),
    provenance: { evidence: ["manual Scene duration"], origin: "studio-default" as const },
  };
}

function durationTrimProgram(
  removedDuration: number,
  targetDuration: number,
  waitOperationIds: readonly string[],
  transactionId: string,
) {
  const operation: CanonicalEditOperation = {
    ...operationBase(`tx:${transactionId}/operation:duration-trim`, 7),
    kind: "TrimSceneDuration",
    provenance: { evidence: ["Scene duration control"], origin: "studio-default" },
    removedDuration,
    targetDuration,
    waitOperationIds,
  };
  return {
    ...canonicalProgram([operation], transactionId),
    provenance: { evidence: ["manual Scene duration"], origin: "studio-default" as const },
  };
}

function transformOperation(
  id: string,
  start: number,
  sourceEntityId: string,
  targetEntityId: string,
  texParts: readonly string[],
): CanonicalEditOperation {
  return {
    ...operationBase(id, start, start + 1),
    kind: "TransformContent",
    replacement: { displayLines: [texParts.join(" ")], texParts },
    sourceEntityId,
    strategy: "transform-matching-tex",
    targetEntityId,
    targetType: "MathTex",
  };
}

function latestPosition(imported: NonNullable<ReturnType<typeof importManimScene>>, entityId: string) {
  return imported.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples.at(-1)?.value as Readonly<{
    x: number;
    y: number;
  }>;
}

describe("Canonical EditProgram source lowering", () => {
  it("discovers explicit source anchors inside their Scene", () => {
    expect(findMotionAnchors(source)).toEqual([{ line: 6, seconds: 7 }]);
    expect(findSceneMotionAnchors(source, "GroupedEquation")).toEqual([{ line: 6, seconds: 7 }]);
  });

  it("does not expose marker-looking text inside a triple-quoted string", () => {
    const stringMarkerSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        documentation = """
        # poietra:anchor 7.000
        """
        self.wait(1)
`;

    expect(findMotionAnchors(stringMarkerSource)).toEqual([]);
    expect(findSceneMotionAnchors(stringMarkerSource, "GroupedEquation")).toEqual([]);
    expect(() =>
      lowerCanonicalProgramSource(stringMarkerSource, request(), { height: 8, width: 14.222 }, null),
    ).toThrow(/No # poietra:anchor 7.000/);
  });

  it("does not expose anchors from dead or nested construct scopes", () => {
    const nestedMarkerSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        if False:
            # poietra:anchor 7.000
            self.wait(1)

        def helper():
            # poietra:anchor 8.000
            return None

        class Nested:
            # poietra:anchor 9.000
            pass

        return
        # poietra:anchor 10.000
        self.wait(1)
`;

    expect(findMotionAnchors(nestedMarkerSource)).toEqual([]);
    expect(findSceneMotionAnchors(nestedMarkerSource, "GroupedEquation")).toEqual([]);
    expect(() =>
      lowerCanonicalProgramSource(nestedMarkerSource, request(), { height: 8, width: 14.222 }, null),
    ).toThrow(/No # poietra:anchor 7.000/);
  });

  it("keeps direct construct anchors while ignoring nearby unsafe markers", () => {
    const mixedMarkerSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        note = """
        # poietra:anchor 99.000
        """
        if False:
            # poietra:anchor 88.000
            self.wait(1)
        # poietra:anchor 7.000
        self.wait(1)
`;

    expect(findMotionAnchors(mixedMarkerSource)).toEqual([{ line: 12, seconds: 7 }]);
    expect(findSceneMotionAnchors(mixedMarkerSource, "GroupedEquation")).toEqual([{ line: 12, seconds: 7 }]);
    const lowered = lowerCanonicalProgramSource(mixedMarkerSource, request(), { height: 8, width: 14.222 }, null);

    expect(lowered.insertedCode).toContain("equation.animate.shift(");
    expect(lowered.source).toContain("        # poietra:anchor 99.000");
    expect(lowered.source).toContain("            # poietra:anchor 88.000");
  });

  it("refuses to lower into an ambiguous Scene name", () => {
    const duplicate = `${source}
class GroupedEquation(Scene):
    def construct(self):
        other = MathTex("F", "=", "m", "a")
        # poietra:anchor 7.000
        self.wait(1)
`;

    expect(() => lowerCanonicalProgramSource(duplicate, request(), { height: 8, width: 14.222 }, null)).toThrow(
      /Scene "GroupedEquation".*examples\/relativity\.py.*duplicate/i,
    );
  });

  it("converts a canonical screen-space motion at the exact anchor", () => {
    const lowered = lowerCanonicalProgramSource(source, request(), { height: 8, width: 14.222 }, null);
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.anchorLine).toBe(6);
    expect(lowered.insertedCode).toContain(
      '# poietra:motion {"motions":[{"delta":{"x":64,"y":-45},"variables":["equation"]}],"version":1}',
    );
    expect(lowered.insertedCode).toContain("equation.animate.shift(1.4222 * RIGHT + 1 * UP)");
    expect(lowered.insertedCode).not.toContain("MoveAlongPath(");
    expect(lowered.insertedCode).toContain("run_time=1.5");
    expect(lowered.source.indexOf("# poietra:cursor 7")).toBeLessThan(lowered.source.indexOf("self.play("));
    expect(lowered.source.indexOf("self.play(")).toBeLessThan(lowered.source.indexOf("# poietra:anchor 8.5"));
    expect(
      imported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.at(-1)?.interval,
    ).toEqual({ end: 8.5, start: 7 });
  });

  it("round-trips a retimed linear motion through its generated source marker", () => {
    const program = canonicalProgram(
      [
        motionOperation({
          easing: "linear",
          interval: { end: 8.25, start: 7 },
        }),
      ],
      "retimed-linear-motion",
    );
    const lowered = lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null);
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const sample =
      imported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.at(-1);

    expect(lowered.insertedCode).toContain('"easing":"linear"');
    expect(lowered.insertedCode).toContain("run_time=1.25");
    expect(lowered.insertedCode).toContain("rate_func=linear");
    expect(sample).toMatchObject({
      easing: "linear",
      interval: { end: 8.25, start: 7 },
      kind: "animated",
    });
  });

  it("uses the Python rate function when a motion marker disagrees", () => {
    const lowered = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([motionOperation({ easing: "linear" })], "linear-motion")),
      { height: 8, width: 14.222 },
      null,
    );
    const tampered = lowered.source.replace("rate_func=linear", "rate_func=smooth");
    const imported = importManimScene(tampered, "examples/relativity.py", "GroupedEquation");

    expect(
      imported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.at(-1)?.easing,
    ).toBe("smooth");
  });

  it("lowers an immediate absolute scale as a relative Manim factor and reimports its absolute value", () => {
    const scaledSource = source.replace(
      'equation = MathTex("E", "=", "m", "c^2")',
      'equation = MathTex("E", "=", "m", "c^2").scale(1.25)',
    );
    const scale: CanonicalEditOperation = {
      ...operationBase("scale-now", 7),
      easing: "smooth",
      entityId: "equation_1",
      from: 1.25,
      key: "scale",
      kind: "AnimateProperty",
      to: 2,
    };

    const lowered = lowerCanonicalProgramSource(
      scaledSource,
      request(canonicalProgram([scale], "scale-now")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const samples =
      imported?.runtimeSceneState.propertyChannels["source:examples/relativity.py#GroupedEquation:equation/scale"]
        ?.samples ?? [];

    expect(lowered.insertedCode).toContain(
      '# poietra:scale {"kind":"exact","value":2,"variable":"equation","version":1}',
    );
    expect(lowered.insertedCode).toContain("equation.scale(1.6)");
    expect(lowered.insertedCode).not.toContain("self.play(");
    expect(samples.at(-1)).toMatchObject({
      interval: { end: 8, start: 7 },
      kind: "exact",
      value: 2,
    });
  });

  it("lowers an animated absolute scale as a relative Manim factor and reimports its animation", () => {
    const scaledSource = source.replace(
      'equation = MathTex("E", "=", "m", "c^2")',
      'equation = MathTex("E", "=", "m", "c^2").scale(1.5)',
    );
    const scale: CanonicalEditOperation = {
      ...operationBase("scale-over-time", 7, 8.5),
      easing: "smooth",
      entityId: "equation_1",
      from: 1.5,
      key: "scale",
      kind: "AnimateProperty",
      to: 3,
    };

    const lowered = lowerCanonicalProgramSource(
      scaledSource,
      request(canonicalProgram([scale], "scale-over-time")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const sample =
      imported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/scale"
      ]?.samples.at(-1);

    expect(lowered.insertedCode).toContain(
      '# poietra:scale {"kind":"animated","scales":[{"from":1.5,"to":3,"variable":"equation"}],"version":1}',
    );
    expect(lowered.insertedCode).toContain("equation.animate.scale(2)");
    expect(lowered.insertedCode).toContain("run_time=1.5");
    expect(sample).toMatchObject({
      easing: "smooth",
      from: 1.5,
      interval: { end: 8.5, start: 7 },
      kind: "animated",
      value: 3,
    });
  });

  it("reimports adjacent motion and scale markers from one parallel play", () => {
    const scale: CanonicalEditOperation = {
      ...operationBase("scale-with-motion", 7, 8.5),
      easing: "smooth",
      entityId: "equation_1",
      from: 1,
      key: "scale",
      kind: "AnimateProperty",
      to: 1.5,
    };

    const lowered = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([motionOperation(), scale], "motion-and-scale")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const entityId = "source:examples/relativity.py#GroupedEquation:equation";
    const motionSample = imported?.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples.at(-1);
    const scaleSample = imported?.runtimeSceneState.propertyChannels[`${entityId}/scale`]?.samples.at(-1);

    expect(lowered.insertedCode.indexOf("# poietra:motion")).toBeLessThan(
      lowered.insertedCode.indexOf("# poietra:scale"),
    );
    expect(motionSample).toMatchObject({
      interval: { end: 8.5, start: 7 },
      kind: "animated",
    });
    expect(scaleSample).toMatchObject({
      from: 1,
      interval: { end: 8.5, start: 7 },
      kind: "animated",
      value: 1.5,
    });
  });

  it("rejects scale lowering without finite positive absolute endpoints", () => {
    const scale: CanonicalEditOperation = {
      ...operationBase("invalid-scale", 7),
      easing: "smooth",
      entityId: "equation_1",
      from: 0,
      key: "scale",
      kind: "AnimateProperty",
      to: 2,
    };

    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([scale], "invalid-scale")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/finite positive absolute from and to/i);
  });

  it("rejects a scale whose absolute origin disagrees with source at the anchor", () => {
    const scale: CanonicalEditOperation = {
      ...operationBase("stale-scale", 7, 8),
      easing: "smooth",
      entityId: "equation_1",
      from: 1.25,
      key: "scale",
      kind: "AnimateProperty",
      to: 2,
    };

    expect(() => lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([scale], "stale-scale")),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/expects 1\.25x but source is 1x/i);
  });

  it("rejects scale combined with TransformContent on the same logical identity", () => {
    const targetEntityId = "tx:scale-transform/entity:target";
    const transform = transformOperation("transform", 7, "equation_1", targetEntityId, ["F", "=", "m", "a"]);
    const scale: CanonicalEditOperation = {
      ...operationBase("scale-target", 8, 9),
      dependsOn: [transform.id],
      easing: "smooth",
      entityId: targetEntityId,
      from: 2,
      key: "scale",
      kind: "AnimateProperty",
      to: 3,
    };
    const scaledSource = source.replace(
      'equation = MathTex("E", "=", "m", "c^2")',
      'equation = MathTex("E", "=", "m", "c^2").scale(2)',
    );

    expect(() => lowerCanonicalProgramSource(
      scaledSource,
      request(canonicalProgram([transform, scale], "scale-transform")),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/Scale and TransformContent cannot target the same logical object/i);
  });

  it("verifies consecutive same-anchor scale Programs against accumulated batch factors", () => {
    const firstScale: CanonicalEditOperation = {
      ...operationBase("first-scale", 7, 8),
      easing: "smooth",
      entityId: "equation_1",
      from: 1,
      key: "scale",
      kind: "AnimateProperty",
      to: 1.5,
    };
    const secondScale: CanonicalEditOperation = {
      ...operationBase("second-scale", 8, 9),
      easing: "smooth",
      entityId: "equation_1",
      from: 1.5,
      key: "scale",
      kind: "AnimateProperty",
      to: 3,
    };
    const firstProgram = canonicalProgram([firstScale], "first-scale");
    const secondProgram: CanonicalEditProgram = {
      ...canonicalProgram([secondScale], "second-scale"),
      anchor: {
        capturedPlayhead: 8,
        evidence: ["captured-playhead:8.000"],
        resolvedSeconds: 8,
        source: { kind: "playhead", referenceSeconds: 8 },
      },
    };

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(firstProgram),
      [
        { program: firstProgram, sourceAnchor: 7 },
        { program: secondProgram, sourceAnchor: 7 },
      ],
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const samples = imported?.runtimeSceneState.propertyChannels[
      "source:examples/relativity.py#GroupedEquation:equation/scale"
    ]?.samples ?? [];

    expect(lowered.insertedCode).toContain("equation.animate.scale(1.5)");
    expect(lowered.insertedCode).toContain("equation.animate.scale(2)");
    expect(samples.at(-1)).toMatchObject({ from: 1.5, value: 3 });
  });

  it("rebases relative scale Programs added in reverse source-anchor order and reimports the same result", () => {
    const multiAnchorSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("x")
        self.add(equation)
        self.wait(5)
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const scaleProgram = (transactionId: string, anchor: number, factor: number) => {
      const scale: CanonicalEditOperation = {
        ...operationBase(`tx:${transactionId}/operation:scale`, anchor, anchor + 1),
        easing: "smooth",
        entityId: "equation_1",
        from: 1,
        key: "scale",
        kind: "AnimateProperty",
        relativeFactor: factor,
        to: factor,
      };
      return {
        ...canonicalProgram([scale], transactionId),
        anchor: {
          capturedPlayhead: anchor,
          evidence: [`captured-playhead:${anchor.toFixed(3)}`],
          resolvedSeconds: anchor,
          source: { kind: "playhead" as const, referenceSeconds: anchor },
        },
      } satisfies CanonicalEditProgram;
    };
    const later = scaleProgram("later-relative-scale", 7, 2);
    const earlier = scaleProgram("earlier-relative-scale", 5, 1.5);

    const lowered = lowerCanonicalProgramBatchSource(
      multiAnchorSource,
      request(later),
      [
        { program: later, sourceAnchor: 7 },
        { program: earlier, sourceAnchor: 5 },
      ],
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const samples = imported?.runtimeSceneState.propertyChannels[
      "source:examples/relativity.py#GroupedEquation:equation/scale"
    ]?.samples ?? [];

    expect(lowered.insertedCode.indexOf("equation.animate.scale(1.5)"))
      .toBeLessThan(lowered.insertedCode.indexOf("equation.animate.scale(2)"));
    expect(lowered.insertedCode).toContain(
      '# poietra:scale {"kind":"animated","scales":[{"from":1.5,"to":3,"variable":"equation"}],"version":1}',
    );
    expect(samples.at(-1)).toMatchObject({ from: 1.5, relative: true, value: 3 });
  });

  it("rejects TransformContent when the imported object has a non-1 effective scale", () => {
    const scaledSource = source.replace(
      'equation = MathTex("E", "=", "m", "c^2")',
      'equation = MathTex("E", "=", "m", "c^2").scale(2)',
    );
    const transform = transformOperation(
      "transform-scaled-source",
      7,
      "equation_1",
      "tx:transform-scaled-source/entity:target",
      ["F", "=", "m", "a"],
    );

    expect(() => lowerCanonicalProgramSource(
      scaledSource,
      request(canonicalProgram([transform], "transform-scaled-source")),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/TransformContent requires .* effective 1x scale.*2x/i);
  });

  it("rejects TransformContent after a previous Program leaves the object at a non-1 scale", () => {
    const scale: CanonicalEditOperation = {
      ...operationBase("scale-before-transform", 7, 8),
      easing: "smooth",
      entityId: "equation_1",
      from: 1,
      key: "scale",
      kind: "AnimateProperty",
      relativeFactor: 1.5,
      to: 1.5,
    };
    const first = canonicalProgram([scale], "scale-before-transform");
    const transform = transformOperation(
      "transform-after-scale",
      8,
      "equation_1",
      "tx:transform-after-scale/entity:target",
      ["F", "=", "m", "a"],
    );
    const second = {
      ...canonicalProgram([transform], "transform-after-scale"),
      anchor: {
        capturedPlayhead: 8,
        evidence: ["captured-playhead:8.000"],
        resolvedSeconds: 8,
        source: { kind: "playhead" as const, referenceSeconds: 8 },
      },
    } satisfies CanonicalEditProgram;

    expect(() => lowerCanonicalProgramBatchSource(
      source,
      request(first),
      [
        { program: first, sourceAnchor: 7 },
        { program: second, sourceAnchor: 7 },
      ],
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/TransformContent requires .* effective 1x scale.*1\.5x/i);
  });

  it("lowers an immediate lifetime end to self.remove without a zero-duration play", () => {
    const remove: CanonicalEditOperation = {
      ...operationBase("trim-lifetime", 7),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };

    const lowered = lowerCanonicalProgramSource(
      roundTripSource,
      request(canonicalProgram([remove], "trim-lifetime")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("self.remove(equation)");
    expect(lowered.insertedCode).not.toContain("self.play(");
    expect(
      imported?.runtimeSceneState.objectGraph.entities["source:examples/relativity.py#GroupedEquation:equation"]
        ?.lifetime,
    ).toEqual([{ end: 7, start: 0 }]);
  });

  it.each([
    "self.play(FadeIn(equation), run_time=1)",
    "self.add(equation)",
    "self.play(equation.animate.shift(RIGHT), run_time=1)",
    'self.add(globals()[f"equation"])',
  ])("rejects persistent removal before a source suffix reference: %s", (suffix) => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const sourceWithReference = source.replace("self.wait(1)", suffix);

    expect(() => lowerCanonicalProgramSource(
      sourceWithReference,
      request(canonicalProgram([remove], "persistent-delete")),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/equation is referenced after the selected anchor/i);
  });

  it.each([
    ["direct alias", "alias = equation", "self.add(alias)", "alias"],
    ["Manim container", "group = VGroup(equation)", "self.add(group)", "group"],
    ["list container", "items = [equation]", "self.add(items[0])", "items"],
    ["dict container", 'lookup = {"primary": equation}', 'self.add(lookup["primary"])', "lookup"],
    ["attribute", "self.cached_equation = equation", "self.add(self.cached_equation)", "self.cached_equation"],
    ["subscript assignment", 'cache = {}\n        cache["primary"] = equation', 'self.add(cache["primary"])', "cache"],
    ["globals binding", 'globals()["cached_equation"] = equation', "self.add(cached_equation)", "cached_equation"],
    ["prefixed globals binding", 'globals()[f"cached_equation"] = equation', "self.add(cached_equation)", "cached_equation"],
    ["globals subscript", 'globals()["cached_equation"] = equation', 'self.add(globals()["cached_equation"])', "globals"],
    ["container mutation", "items = []\n        items.append(equation)", "self.add(items[0])", "items"],
    ["nested container mutation", 'buckets = {"primary": []}\n        buckets["primary"].append(equation)', 'self.add(buckets["primary"][0])', "buckets"],
    ["for binding", "for alias in [equation]:\n            pass", "self.add(alias)", "alias"],
    ["with binding", "with nullcontext(equation) as alias:\n            pass", "self.add(alias)", "alias"],
    ["assignment expression", "if (alias := equation):\n            pass", "self.add(alias)", "alias"],
    ["function body", "def revive():\n            self.add(equation)", "revive()", "revive"],
    ["function return", "def get():\n            return equation", "self.add(get())", "get"],
    ["async function body", "async def revive():\n            self.add(equation)", "self.add(revive)", "revive"],
    ["function default", "def revive(value=equation):\n            return value", "self.add(revive())", "revive"],
    ["function decorator", "@register(equation)\n        def revive():\n            pass", "self.add(revive)", "revive"],
    ["class body", "class Holder:\n            cached = equation", "self.add(Holder.cached)", "Holder"],
    ["class decorator", "@register(equation)\n        class Holder:\n            pass", "self.add(Holder)", "Holder"],
  ])("rejects persistent removal through a pre-anchor %s", (_label, setup, suffix, reference) => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-alias", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const aliasedSource = source
      .replace("        # poietra:anchor 7.000", `        ${setup}\n        # poietra:anchor 7.000`)
      .replace("self.wait(1)", suffix);

    expect(() => lowerCanonicalProgramSource(
      aliasedSource,
      request(canonicalProgram([remove], "persistent-delete-alias")),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(new RegExp(`${reference.replaceAll(".", "\\.")} is referenced after the selected anchor`, "i"));
  });

  it("tracks multi-hop alias and container closure before persistent removal", () => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-closure", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const aliasedSource = source
      .replace(
        "        # poietra:anchor 7.000",
        '        alias = equation\n        group = VGroup(alias)\n        registry = {"primary": group}\n        # poietra:anchor 7.000',
      )
      .replace("self.wait(1)", 'self.add(registry["primary"])');

    expect(() => lowerCanonicalProgramSource(
      aliasedSource,
      request(canonicalProgram([remove], "persistent-delete-closure")),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/registry is referenced after the selected anchor/i);
  });

  it.each([
    'make_registry()["primary"] = equation',
    "globals()[dynamic_key] = equation",
    "make_registry().append(equation)",
    "with nullcontext(equation) as make_holder().value:\n            pass",
  ])("fails closed when a target-retaining assignment cannot be tracked: %s", (setup) => {
    const remove: CanonicalEditOperation = {
      ...operationBase("persistent-delete-unknown-alias", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const ambiguousSource = source.replace(
      "        # poietra:anchor 7.000",
      `        ${setup}\n        # poietra:anchor 7.000`,
    );

    expect(() => lowerCanonicalProgramSource(
      ambiguousSource,
      request(canonicalProgram([remove], "persistent-delete-unknown-alias")),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/cannot track (?:an alias\/container assignment|a container mutation) target/i);
  });

  it.each(["f", "r", "b"])(
    "does not confuse the %s string prefix with a removed one-letter source variable",
    (sourceVariable) => {
      const remove: CanonicalEditOperation = {
        ...operationBase("persistent-delete-string-prefix", 7, 7.4),
        effect: "remove",
        entityId: "equation_1",
        kind: "ChangePresence",
        persistent: true,
      };
      const prefixSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        ${sourceVariable} = MathTex("E", "=", "m", "c^2")
        # poietra:anchor 7.000
        message = ${sourceVariable}"equation"
        self.wait(1)
`;

      expect(lowerCanonicalProgramSource(
        prefixSource,
        request(
          canonicalProgram([remove], "persistent-delete-string-prefix"),
          [{ entityId: "equation_1", sourceVariable }],
        ),
        { height: 8, width: 14.222 },
        null,
      ).insertedCode).toContain(`FadeOut(${sourceVariable})`);
    },
  );

  it("ignores source-variable text in comments and strings when guarding persistent removal", () => {
    const remove: CanonicalEditOperation = {
      ...operationBase("safe-delete", 7, 7.4),
      effect: "remove",
      entityId: "equation_1",
      kind: "ChangePresence",
      persistent: true,
    };
    const safeSuffix = source.replace(
      "self.wait(1)",
      'documentation = "equation"\n        # self.add(equation)\n        self.wait(1)',
    );

    expect(lowerCanonicalProgramSource(
      safeSuffix,
      request(canonicalProgram([remove], "safe-delete")),
      { height: 8, width: 14.222 },
      null,
    ).insertedCode).toContain("FadeOut(equation)");
  });

  it("guards the original source alias when a transformed target is persistently removed", () => {
    const targetEntityId = "tx:transform-delete/entity:target";
    const transform = transformOperation("transform", 7, "equation_1", targetEntityId, ["F", "=", "m", "a"]);
    const remove: CanonicalEditOperation = {
      ...operationBase("delete-target", 8, 8.4),
      dependsOn: [transform.id],
      effect: "remove",
      entityId: targetEntityId,
      kind: "ChangePresence",
      persistent: true,
    };
    const sourceWithReference = source.replace("self.wait(1)", "self.add(equation)");

    expect(() => lowerCanonicalProgramSource(
      sourceWithReference,
      request(canonicalProgram([transform, remove], "transform-delete")),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/equation is referenced after the selected anchor/i);
  });

  it("rejects a non-transition operation at or after a Scene boundary", () => {
    const boundary: CanonicalEditOperation = {
      ...operationBase("boundary", 7),
      at: 7,
      destination: "next-scene",
      kind: "InsertSceneBoundary",
    };
    const motion = motionOperation({
      id: "motion-after-boundary",
      interval: { end: 8, start: 7 },
    });

    expect(() => lowerCanonicalProgramSource(
      source,
      { ...request(canonicalProgram([boundary, motion], "boundary-first")), destination: { sceneName: "Next", sourcePath: "scene.py" } },
      { height: 8, width: 14.222 },
      { initialization: [], visibleSourceVariables: [] },
    )).toThrow(/Scene boundary must be terminal/i);
  });

  it("advances the consumed anchor so a second commit appends in playback order", () => {
    const firstProgram = canonicalProgram([motionOperation()], "first-commit");
    const first = lowerCanonicalProgramSource(source, request(firstProgram), { height: 8, width: 14.222 }, null);
    const secondOperation = motionOperation({
      id: "tx:second-commit/operation:motion",
      interval: { end: 10, start: 8.5 },
    });
    const secondProgram: CanonicalEditProgram = {
      ...canonicalProgram([secondOperation], "second-commit"),
      anchor: {
        capturedPlayhead: 8.5,
        evidence: ["captured-playhead:8.500"],
        resolvedSeconds: 8.5,
        source: { kind: "playhead", referenceSeconds: 8.5 },
      },
    };
    const second = lowerCanonicalProgramSource(
      first.source,
      request(secondProgram),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(second.source, "examples/relativity.py", "GroupedEquation");
    const samples =
      imported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.filter((sample) => sample.kind === "animated") ?? [];

    expect(first.source).toContain("# poietra:cursor 7");
    expect(findSceneMotionAnchors(first.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([8.5]);
    expect(second.source.indexOf('poietra:transaction "first-commit"')).toBeLessThan(
      second.source.indexOf('poietra:transaction "second-commit"'),
    );
    expect(findSceneMotionAnchors(second.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([10]);
    expect(samples.map((sample) => sample.interval)).toEqual([
      { end: 8.5, start: 7 },
      { end: 10, start: 8.5 },
    ]);
  });

  it("shifts downstream source anchors by the inserted duration", () => {
    const sourceWithDownstreamAnchor = source.replace(
      "        self.wait(1)",
      "        self.wait(3)\n        # poietra:anchor 10.000\n        self.wait(1)",
    );

    const lowered = lowerCanonicalProgramSource(
      sourceWithDownstreamAnchor,
      request(),
      { height: 8, width: 14.222 },
      null,
    );

    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([
      8.5, 11.5,
    ]);
  });

  it("shifts every safe downstream temporal marker and reimports execution-aligned timing", () => {
    const lowered = lowerCanonicalProgramSource(
      temporalMetadataSource,
      request(motionProgramAt(5, 1, "temporal-single")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const motion = imported?.runtimeSceneState.propertyChannels[
      "source:examples/relativity.py#GroupedEquation:equation/position"
    ]?.samples.find((sample) => sample.kind === "animated");
    const boundary = imported?.runtimeSceneState.eventTrack.events.find((event) => event.kind === "scene-boundary");

    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([6, 9]);
    expect(lowered.source).toContain("# poietra:cursor 8");
    expect(lowered.source).toContain('# poietra:scene-boundary {"at":9,"destination":"scene.py#Next"}');
    expect(motion?.interval).toEqual({ end: 6, start: 5 });
    expect(boundary).toMatchObject({ at: 9, kind: "scene-boundary" });
    expect(imported?.runtimeSceneState.duration).toBe(10);
  });

  it("moves original metadata at the exact insertion boundary and remains stable across repeated insertion", () => {
    const sourceWithEqualMetadata = temporalMetadataSource
      .replace(
        "        self.wait(5)\n        # poietra:anchor 5.000",
        [
          "        self.wait(5)",
          "        # poietra:cursor 5.000",
          '        # poietra:scene-boundary {"at":5,"destination":"scene.py#BeforeAnchor"}',
          "        # poietra:anchor 5.000",
        ].join("\n"),
      )
      .replace(
        "        # poietra:anchor 5.000",
        [
          "        # poietra:anchor 5.000",
          "        # poietra:cursor 5.000",
          '        # poietra:scene-boundary {"at":5,"destination":"scene.py#AfterAnchor"}',
        ].join("\n"),
      );
    const first = lowerCanonicalProgramSource(
      sourceWithEqualMetadata,
      request(motionProgramAt(5, 1, "temporal-first")),
      { height: 8, width: 14.222 },
      null,
    );
    const second = lowerCanonicalProgramSource(
      first.source,
      request(motionProgramAt(6, 0.75, "temporal-second")),
      { height: 8, width: 14.222 },
      null,
    );

    expect(first.source.match(/# poietra:cursor [0-9.]+/g)).toEqual([
      "# poietra:cursor 5.000",
      "# poietra:cursor 5",
      "# poietra:cursor 6",
      "# poietra:cursor 8",
    ]);
    expect(first.source).toContain('# poietra:scene-boundary {"at":5,"destination":"scene.py#BeforeAnchor"}');
    expect(first.source).toContain('# poietra:scene-boundary {"at":6,"destination":"scene.py#AfterAnchor"}');
    expect(second.source.match(/# poietra:cursor [0-9.]+/g)).toEqual([
      "# poietra:cursor 5.000",
      "# poietra:cursor 5",
      "# poietra:cursor 6",
      "# poietra:cursor 6.75",
      "# poietra:cursor 8.75",
    ]);
    expect(second.source).toContain('# poietra:scene-boundary {"at":5,"destination":"scene.py#BeforeAnchor"}');
    expect(second.source).toContain('# poietra:scene-boundary {"at":6.75,"destination":"scene.py#AfterAnchor"}');
    expect(second.source).toContain('# poietra:scene-boundary {"at":9.75,"destination":"scene.py#Next"}');
    expect(findSceneMotionAnchors(second.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([
      6.75, 9.75,
    ]);
  });

  it("applies the same cumulative temporal rewrite to distinct source anchors in a batch", () => {
    const earlier = motionProgramAt(5, 1, "temporal-batch-earlier");
    const later = motionProgramAt(9, 1.25, "temporal-batch-later");
    const lowered = lowerCanonicalProgramBatchSource(
      temporalMetadataSource,
      request(earlier),
      [
        { program: later, sourceAnchor: 8 },
        { program: earlier, sourceAnchor: 5 },
      ],
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([
      6, 10.25,
    ]);
    expect(lowered.source).toContain("# poietra:cursor 8");
    expect(lowered.source).toContain("# poietra:cursor 9");
    expect(lowered.source).toContain('# poietra:scene-boundary {"at":10.25,"destination":"scene.py#Next"}');
    expect(imported?.runtimeSceneState.eventTrack.events).toContainEqual(
      expect.objectContaining({
        at: 10.25,
        kind: "scene-boundary",
      }),
    );
  });

  it("leaves string, nested, and malformed temporal markers inert while shifting valid markers", () => {
    const sourceWithUnsafeMetadata = temporalMetadataSource.replace(
      "        self.add(equation)",
      `        self.add(equation)
        documentation = """
        # poietra:cursor 70.000
        # poietra:scene-boundary {"at":80,"destination":"scene.py#String"}
        """
        if False:
            # poietra:cursor 60.000
            # poietra:scene-boundary {"at":70,"destination":"scene.py#Nested"}
        # poietra:cursor later
        # poietra:scene-boundary {"at":7}`,
    );
    const lowered = lowerCanonicalProgramSource(
      sourceWithUnsafeMetadata,
      request(motionProgramAt(5, 1, "temporal-safe-only")),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.source).toContain("        # poietra:cursor 70.000");
    expect(lowered.source).toContain('        # poietra:scene-boundary {"at":80,"destination":"scene.py#String"}');
    expect(lowered.source).toContain("            # poietra:cursor 60.000");
    expect(lowered.source).toContain('            # poietra:scene-boundary {"at":70,"destination":"scene.py#Nested"}');
    expect(lowered.source).toContain("        # poietra:cursor later");
    expect(lowered.source).toContain('        # poietra:scene-boundary {"at":7');
    expect(lowered.source).toContain("# poietra:cursor 8");
    expect(lowered.source).toContain('# poietra:scene-boundary {"at":9,"destination":"scene.py#Next"}');
  });

  it("lowers equation, explanation, and an actual imported Scene boundary as one transaction", () => {
    const equationId = "tx:compound/entity:new-equation";
    const textId = "tx:compound/entity:explanation";
    const overlayId = "tx:compound/entity:overlay";
    const operations: CanonicalEditOperation[] = [
      {
        ...operationBase("create-equation", 7),
        entity: {
          content: { displayLines: ["E = mc^2"], label: "equation", texParts: ["E", "=", "m", "c^2"] },
          id: equationId,
          lifetime: { end: null, start: 7 },
          type: "MathTex",
        },
        kind: "CreateEntity",
      },
      {
        ...operationBase("create-text", 7),
        entity: {
          content: { displayLines: ["Energy"], text: "Energy" },
          id: textId,
          lifetime: { end: null, start: 7 },
          type: "Text",
        },
        kind: "CreateEntity",
      },
      {
        ...operationBase("place-text", 7),
        kind: "SetRelation",
        mode: "snapshot",
        offset: { x: 145, y: 0 },
        placement: "right",
        relation: "next-to",
        sourceEntityId: textId,
        targetEntityId: equationId,
      },
      {
        ...operationBase("position-text", 7),
        entityId: textId,
        key: "position",
        kind: "SetProperty",
        value: { x: 320, y: 180 },
      },
      {
        ...operationBase("show-equation", 7, 8),
        effect: "fade-in",
        entityId: equationId,
        kind: "ChangePresence",
        persistent: true,
      },
      {
        ...operationBase("show-text", 7, 8),
        effect: "fade-in",
        entityId: textId,
        kind: "ChangePresence",
        persistent: true,
      },
      {
        ...operationBase("create-overlay", 8),
        entity: {
          content: { displayLines: ["sky circle"] },
          id: overlayId,
          lifetime: { end: 9, start: 8 },
          type: "TransitionOverlay:circle:sky",
        },
        kind: "CreateEntity",
      },
      {
        ...operationBase("cover", 8, 8.5),
        effect: "cover",
        entityId: overlayId,
        kind: "ChangePresence",
        persistent: false,
      },
      { ...operationBase("boundary", 8.5), at: 8.5, destination: "next-scene", kind: "InsertSceneBoundary" },
      {
        ...operationBase("reveal", 8.5, 9),
        dependsOn: ["boundary"],
        effect: "reveal",
        entityId: overlayId,
        kind: "ChangePresence",
        persistent: true,
      },
    ];
    const program = {
      ...canonicalProgram(operations, "compound"),
      intentCount: 3,
      schedule: { edges: [], mode: "sequence" as const, order: operations.map((operation) => operation.id) },
    };
    const lowered = lowerCanonicalProgramBatchSource(
      source,
      { ...request(program, []), destination: { sceneName: "Next", sourcePath: "scene.py" } },
      [{ program, sourceAnchor: 7 }],
      { height: 8, width: 14.222 },
      {
        initialization: ['title = Text("Next")'],
        visibleSourceVariables: ["title"],
      },
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain('MathTex("E", "=", "m", "c^2")');
    expect(lowered.insertedCode).toContain('Text("Energy")');
    expect(lowered.insertedCode).toContain(".get_center() + 3.2222 * RIGHT");
    expect(lowered.insertedCode.indexOf(".get_center() + 3.2222 * RIGHT")).toBeLessThan(
      lowered.insertedCode.indexOf(".move_to(ORIGIN)"),
    );
    expect(lowered.insertedCode).toContain("FadeIn(");
    expect(lowered.insertedCode).toContain("self.clear()");
    expect(lowered.insertedCode).toContain('# poietra:scene-boundary {"at":8.5,"destination":"scene.py#Next"}');
    expect(lowered.insertedCode).toContain("# poietra:incoming-start");
    expect(lowered.insertedCode).toContain('title = Text("Next")');
    expect(lowered.insertedCode).toContain("return  # The imported next Scene now owns the composition.");
    expect(lowered.insertedCode.match(/# poietra:entity/g)).toHaveLength(2);
    expect(lowered.insertedCode.match(/# poietra:position/g)).toHaveLength(2);
    expect(imported).not.toBeNull();
    if (imported) expect(latestPosition(imported, textId)).toEqual({ x: 320, y: 180 });
  });

  it("lowers manually inserted geometry with safe default constructors", () => {
    const types = ["Circle", "Rectangle", "Square", "Line", "Arrow"] as const;
    const operations = types.flatMap((type, index): CanonicalEditOperation[] => {
      const entityId = `tx:manual-shapes/entity:shape-${index}`;
      const createId = `tx:manual-shapes/operation:create-${index}`;
      const positionId = `tx:manual-shapes/operation:position-${index}`;
      return [
        {
          ...operationBase(createId, 7),
          entity: {
            content: { displayLines: [type], label: type },
            id: entityId,
            lifetime: { end: null, start: 7 },
            type,
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase(positionId, 7),
          dependsOn: [createId],
          entityId,
          key: "position",
          kind: "SetProperty",
          value: { x: 120 + index * 80, y: 180 },
        },
        {
          ...operationBase(`tx:manual-shapes/operation:show-${index}`, 7, 7.4),
          dependsOn: [positionId],
          effect: "fade-in",
          entityId,
          kind: "ChangePresence",
          persistent: true,
        },
      ];
    });
    const program = canonicalProgram(operations, "manual-shapes");
    const lowered = lowerCanonicalProgramSource(source, request(program, []), { height: 8, width: 14.222 }, null);

    expect(lowered.insertedCode).toContain("Circle(radius=1)");
    expect(lowered.insertedCode).toContain("Rectangle(width=4, height=2)");
    expect(lowered.insertedCode).toContain("Square(side_length=2)");
    expect(lowered.insertedCode).toContain("Line(LEFT, RIGHT)");
    expect(lowered.insertedCode).toContain("Arrow(LEFT, RIGHT, buff=0)");
    expect(lowered.insertedCode.match(/FadeIn\(/g)).toHaveLength(types.length);
  });

  it("lowers a Scene duration extension to an explicit wait", () => {
    const wait: CanonicalEditOperation = {
      ...operationBase("extend-duration", 7, 10),
      eventKind: "wait",
      kind: "InsertTimelineEvent",
      label: "Extend Scene to 11s",
    };
    const lowered = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([wait], "extend-duration"), []),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("self.wait(3)");
    expect(imported?.runtimeSceneState.duration).toBe(11);
  });

  it("rejects an inserted wait that shares its source bucket", () => {
    const position: CanonicalEditOperation = {
      ...operationBase("position-with-wait", 7),
      entityId: "equation_1",
      key: "position",
      kind: "SetProperty",
      value: { x: 320, y: 180 },
    };
    const wait: CanonicalEditOperation = {
      ...operationBase("shared-wait", 7, 8),
      eventKind: "wait",
      kind: "InsertTimelineEvent",
      label: "wait",
    };

    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([position, wait])),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow("An inserted wait must occupy its own source interval.");
  });

  it("lowers a Scene duration trim by reducing only its referenced Studio wait", () => {
    const extension = durationWaitProgram(3, "duration-extension");
    const wait = extension.operations[0];
    expect(wait?.kind).toBe("InsertTimelineEvent");
    if (wait?.kind !== "InsertTimelineEvent") return;
    const trim = durationTrimProgram(1, 10, [wait.id], "duration-trim");

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(extension),
      [extension, trim].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("self.wait(2)");
    expect(lowered.insertedCode).not.toContain("self.wait(3)");
    expect(lowered.source).not.toContain('poietra:transaction "duration-trim"');
    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([9]);
    expect(imported?.runtimeSceneState.duration).toBe(10);
  });

  it("restores the original source exactly when a Scene duration wait is fully removed", () => {
    const extension = durationWaitProgram(3, "duration-to-remove");
    const wait = extension.operations[0];
    expect(wait?.kind).toBe("InsertTimelineEvent");
    if (wait?.kind !== "InsertTimelineEvent") return;
    const trim = durationTrimProgram(3, 8, [wait.id], "remove-duration-wait");

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(extension),
      [extension, trim].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.source).toBe(source);
    expect(lowered.insertedCode).toBe("");
    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([7]);
    expect(
      importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation")?.runtimeSceneState.duration,
    ).toBe(8);
  });

  it("refuses a Scene duration trim that cannot be proven against a Studio wait", () => {
    const trim = durationTrimProgram(1, 7, ["missing-wait"], "unproven-duration-trim");

    expect(() =>
      lowerCanonicalProgramBatchSource(
        source,
        request(trim),
        [{ program: trim, sourceAnchor: 7 }],
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/does not reference an earlier Studio duration wait/i);
  });

  it("lowers a quadratic screen-space motion to an exact Manim cubic path", () => {
    const operation = motionOperation({ controlOffset: { x: 32, y: 45 } });
    const lowered = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([operation])),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const sample =
      imported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.at(-1);

    expect(lowered.insertedCode).toContain(
      '# poietra:motion {"motions":[{"controlOffset":{"x":32,"y":45},"delta":{"x":64,"y":-45},"variables":["equation"]}],"version":1}',
    );
    expect(lowered.insertedCode).toContain(
      "MoveAlongPath(equation, CubicBezier(equation.get_center(), equation.get_center() + 0.9481 * RIGHT + 0.3333 * DOWN, equation.get_center() + 1.4222 * RIGHT, equation.get_center() + 1.4222 * RIGHT + 1 * UP))",
    );
    expect(lowered.insertedCode).not.toContain("equation.animate.shift(");
    expect(sample).toMatchObject({
      control: { x: 384, y: 202.5 },
      from: { x: 320, y: 180 },
      interval: { end: 8.5, start: 7 },
      value: { x: 384, y: 135 },
    });
  });

  it("preserves curved zero-displacement paths and tiny straight displacements", () => {
    const curved = lowerCanonicalProgramSource(
      source,
      request(
        canonicalProgram([
          motionOperation({
            controlOffset: { x: 0, y: 30 },
            delta: { x: 0, y: 0 },
          }),
        ]),
      ),
      { height: 8, width: 14.222 },
      null,
    );
    const tiny = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([motionOperation({ delta: { x: 0.001, y: 0 } })])),
      { height: 8, width: 14.222 },
      null,
    );

    expect(curved.insertedCode).toContain("MoveAlongPath(equation, CubicBezier(");
    expect(tiny.insertedCode).toContain("equation.animate.shift(0.00002222 * RIGHT)");
  });

  it("rejects operations that do not have truthful source lowering instead of dropping them", () => {
    const unsupported: CanonicalEditOperation = {
      ...operationBase("modify", 7, 8),
      controlOffset: { x: 0, y: 10 },
      kind: "ModifyMotion",
      motionId: "source-motion",
      preserve: ["start", "end", "duration"],
    };
    expect(() =>
      lowerCanonicalProgramSource(source, request(canonicalProgram([unsupported])), { height: 8, width: 14.222 }, null),
    ).toThrow(/ModifyMotion has no truthful source lowering/);
  });

  it("rejects CameraFocus camera changes through the shared capability contract", () => {
    const cameraFocus: CanonicalEditOperation = {
      ...operationBase("camera-focus", 7, 8),
      kind: "ChangeCamera",
      property: "scale",
      value: 1.35,
    };
    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([cameraFocus]), []),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/CameraFocus can be previewed.*ChangeCamera cannot yet be lowered/);
  });

  it("rejects live relations because a one-shot move cannot preserve that constraint", () => {
    const liveRelation: CanonicalEditOperation = {
      ...operationBase("live-relation", 7),
      kind: "SetRelation",
      mode: "live",
      offset: { x: 145, y: 0 },
      placement: "right",
      relation: "next-to",
      sourceEntityId: "label_1",
      targetEntityId: "equation_1",
    };
    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([liveRelation]), [
          { entityId: "equation_1", sourceVariable: "equation" },
          { entityId: "label_1", sourceVariable: "label" },
        ]),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/SetRelation live has no truthful source lowering/);
  });

  it("requires imported source identity and an exact source anchor", () => {
    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([motionOperation()]), []),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/no imported Python source identity/i);
    const program = {
      ...canonicalProgram([motionOperation()]),
      anchor: {
        capturedPlayhead: 5,
        evidence: [],
        resolvedSeconds: 5,
        source: { kind: "playhead" as const, referenceSeconds: 5 },
      },
    };
    expect(() => lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null)).toThrow(
      /No # poietra:anchor 5.000/,
    );
  });

  it("keeps transaction text data-only while generating safe Python variables", () => {
    const unsafeId = "unsafe\nself.remove(equation)";
    const program = canonicalProgram([motionOperation()], unsafeId);
    expect(programRenderRequestSchema.safeParse(request(program)).success).toBe(true);
    const lowered = lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null);
    expect(lowered.insertedCode).toContain("unsafe\\nself.remove(equation)");
    expect(lowered.insertedCode).not.toContain("\nself.remove(equation)\n");
  });

  it("does not overwrite an existing Python identifier when allocating transaction variables", () => {
    const collisionSource = source.replace(
      "        equation = MathTex",
      '        poietra_collision_1 = Text("Existing")\n        equation = MathTex',
    );
    const create: CanonicalEditOperation = {
      ...operationBase("create", 7),
      entity: {
        content: { displayLines: ["x"], texParts: ["x"] },
        id: "tx:collision/entity:new",
        lifetime: { end: null, start: 7 },
        type: "MathTex",
      },
      kind: "CreateEntity",
    };
    const code = lowerCanonicalProgramSource(
      collisionSource,
      request(canonicalProgram([create], "collision"), []),
      { height: 8, width: 14.222 },
      null,
    ).insertedCode;

    expect(code).toContain('poietra_collision_1_2 = MathTex("x")');
    expect(code).not.toContain('poietra_collision_1 = MathTex("x")');
  });

  it("orders same-bucket dependencies and carries chained transform identities", () => {
    const firstTarget = "tx:chain/entity:first";
    const secondTarget = "tx:chain/entity:second";
    const explanationId = "tx:chain/entity:explanation";
    const relation: CanonicalEditOperation = {
      ...operationBase("place-explanation", 7),
      kind: "SetRelation",
      mode: "snapshot",
      offset: { x: 145, y: 0 },
      placement: "right",
      relation: "next-to",
      sourceEntityId: explanationId,
      targetEntityId: firstTarget,
    };
    const explanation: CanonicalEditOperation = {
      ...operationBase("create-explanation", 7),
      entity: {
        content: { displayLines: ["Explanation"], text: "Explanation" },
        id: explanationId,
        lifetime: { end: null, start: 7 },
        type: "Text",
      },
      kind: "CreateEntity",
    };
    const operations: CanonicalEditOperation[] = [
      explanation,
      transformOperation("first-transform", 7, "equation_1", firstTarget, ["F", "=", "m", "a"]),
      relation,
      transformOperation("second-transform", 8, firstTarget, secondTarget, ["p", "=", "m", "v"]),
    ];
    const lowered = lowerCanonicalProgramSource(
      roundTripSource,
      request(canonicalProgram(operations, "chain")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const targetVariable = imported?.sourceVariables[firstTarget];
    const explanationVariable = imported?.sourceVariables[explanationId];

    expect(lowered.insertedCode.match(/# poietra:position/g)).toHaveLength(3);
    expect(lowered.insertedCode).toContain("equation = poietra_chain_3");
    expect(lowered.insertedCode.indexOf(`${targetVariable} = MathTex(`)).toBeLessThan(
      lowered.insertedCode.indexOf(`${explanationVariable}.move_to(${targetVariable}.get_center()`),
    );
    expect(imported?.sourceVariables).toMatchObject({
      [explanationId]: "poietra_chain_1",
      [firstTarget]: "poietra_chain_2",
      [secondTarget]: "poietra_chain_3",
    });
    expect(
      [firstTarget, secondTarget].map((id) => imported?.runtimeSceneState.objectGraph.entities[id]?.lifetime),
    ).toEqual([[{ end: 9, start: 7 }], [{ end: 10, start: 8 }]]);
    expect(imported).not.toBeNull();
    if (!imported) return;
    const sourcePosition = latestPosition(imported, "source:examples/relativity.py#GroupedEquation:equation");
    expect(sourcePosition).toMatchObject({ x: expect.closeTo(410, 2), y: 135 });
    expect(latestPosition(imported, firstTarget)).toEqual(sourcePosition);
    expect(latestPosition(imported, secondTarget)).toEqual(sourcePosition);
    const explanationPosition = latestPosition(imported, explanationId);
    expect(explanationPosition).toMatchObject({
      x: expect.closeTo(sourcePosition.x + 145, 1),
      y: expect.closeTo(sourcePosition.y, 2),
    });
  });

  it("carries transform alias lineage across Programs in one batch", () => {
    const firstTarget = "tx:alias-a/entity:first";
    const secondTarget = "tx:alias-b/entity:second";
    const first = canonicalProgram(
      [transformOperation("tx:alias-a/operation:transform", 7, "equation_1", firstTarget, ["F", "=", "m", "a"])],
      "alias-a",
    );
    const secondBase = canonicalProgram(
      [transformOperation("tx:alias-b/operation:transform", 8, firstTarget, secondTarget, ["p", "=", "m", "v"])],
      "alias-b",
    );
    const second: CanonicalEditProgram = {
      ...secondBase,
      anchor: {
        capturedPlayhead: 8,
        evidence: [],
        resolvedSeconds: 8,
        source: { kind: "playhead", referenceSeconds: 8 },
      },
    };
    const laterMotion = motionOperation({
      id: "tx:alias-motion/operation:motion",
      interval: { end: 10, start: 9 },
      targetEntityIds: ["equation_1"],
    });
    const motionBase = canonicalProgram([laterMotion], "alias-motion");
    const motion: CanonicalEditProgram = {
      ...motionBase,
      anchor: {
        capturedPlayhead: 9,
        evidence: [],
        resolvedSeconds: 9,
        source: { kind: "playhead", referenceSeconds: 9 },
      },
    };

    const lowered = lowerCanonicalProgramBatchSource(
      source,
      request(first),
      [first, second, motion].map((program) => ({ program, sourceAnchor: 7 })),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.insertedCode).toContain("poietra_alias_a_1 = poietra_alias_b_1");
    expect(lowered.insertedCode).toContain("equation = poietra_alias_b_1");
    expect(lowered.insertedCode.lastIndexOf("equation = poietra_alias_b_1")).toBeLessThan(
      lowered.insertedCode.indexOf("equation.animate.shift("),
    );
  });

  it("lowers a finite Studio-created lifetime at separate safe anchors", () => {
    const finiteSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const entityId = "tx:finite-owned/entity:circle";
    const createId = "tx:finite-owned/operation:create";
    const appearId = "tx:finite-owned/operation:appear";
    const program: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 5,
        evidence: [],
        resolvedSeconds: 5,
        source: { kind: "absolute", seconds: 5 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          ...operationBase(createId, 5),
          entity: {
            content: { displayLines: ["Circle"], label: "Circle" },
            id: entityId,
            lifetime: { end: 7, start: 5 },
            type: "Circle",
          },
          kind: "CreateEntity",
        },
        {
          ...operationBase(appearId, 5, 5.4),
          dependsOn: [createId],
          effect: "fade-in",
          entityId,
          kind: "ChangePresence",
          persistent: true,
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: {
        edges: [{ from: createId, reason: "explicit", to: appearId }],
        mode: "sequence",
        order: [createId, appearId],
      },
      transactionId: "finite-owned",
      version: 1,
    };

    expect(() =>
      lowerCanonicalProgramSource(finiteSource, request(program, []), { height: 8, width: 14.222 }, null),
    ).toThrow(/batch source pipeline/i);

    const lowered = lowerCanonicalProgramBatchSource(
      finiteSource,
      request(program, []),
      [{ program, sourceAnchor: 5 }],
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.anchorLines).toHaveLength(2);
    expect(lowered.source.indexOf("Circle(radius=1)")).toBeLessThan(lowered.source.indexOf("self.remove("));
    expect(lowered.source).toContain("# poietra:anchor 5.4");
    expect(lowered.source).toContain("# poietra:anchor 7.4");
    const imported = importManimScene(lowered.source, "finite.py", "GroupedEquation", { height: 8, width: 14.222 });
    expect(imported?.runtimeSceneState.objectGraph.entities[entityId]?.lifetime).toEqual([{ end: 7.4, start: 5 }]);

    const endWait = canonicalProgram(
      [
        {
          ...operationBase("end-anchor-wait/operation/wait", 7, 8),
          eventKind: "wait",
          kind: "InsertTimelineEvent",
          label: "Wait at lifetime end",
        },
      ],
      "end-anchor-wait",
    );
    const sameAnchor = lowerCanonicalProgramBatchSource(
      finiteSource,
      request(program, []),
      [
        { program, sourceAnchor: 5 },
        { program: endWait, sourceAnchor: 7 },
      ],
      { height: 8, width: 14.222 },
      null,
    );
    expect(sameAnchor.insertedCode.indexOf("self.remove(")).toBeLessThan(
      sameAnchor.insertedCode.indexOf('# poietra:transaction "end-anchor-wait"'),
    );
    expect(
      importManimScene(sameAnchor.source, "finite.py", "GroupedEquation", { height: 8, width: 14.222 })
        ?.runtimeSceneState.objectGraph.entities[entityId]?.lifetime,
    ).toEqual([{ end: 7.4, start: 5 }]);
  });
});
