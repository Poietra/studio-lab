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

function latestPosition(
  imported: NonNullable<ReturnType<typeof importManimScene>>,
  entityId: string,
) {
  return imported.runtimeSceneState.propertyChannels[`${entityId}/position`]
    ?.samples.at(-1)?.value as Readonly<{ x: number; y: number }>;
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
    expect(() => lowerCanonicalProgramSource(
      stringMarkerSource,
      request(),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/No # poietra:anchor 7.000/);
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
    expect(() => lowerCanonicalProgramSource(
      nestedMarkerSource,
      request(),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/No # poietra:anchor 7.000/);
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
    expect(findSceneMotionAnchors(mixedMarkerSource, "GroupedEquation"))
      .toEqual([{ line: 12, seconds: 7 }]);
    const lowered = lowerCanonicalProgramSource(
      mixedMarkerSource,
      request(),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.insertedCode).toContain("equation.animate.shift(");
    expect(lowered.source).toContain("        # poietra:anchor 99.000");
    expect(lowered.source).toContain("            # poietra:anchor 88.000");
  });

  it("converts a canonical screen-space motion at the exact anchor", () => {
    const lowered = lowerCanonicalProgramSource(source, request(), { height: 8, width: 14.222 }, null);
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.anchorLine).toBe(6);
    expect(lowered.insertedCode).toContain('# poietra:motion {"motions":[{"delta":{"x":64,"y":-45},"variables":["equation"]}],"version":1}');
    expect(lowered.insertedCode).toContain("equation.animate.shift(1.4222 * RIGHT + 1 * UP)");
    expect(lowered.insertedCode).not.toContain("MoveAlongPath(");
    expect(lowered.insertedCode).toContain("run_time=1.5");
    expect(lowered.source.indexOf("# poietra:cursor 7")).toBeLessThan(lowered.source.indexOf("self.play("));
    expect(lowered.source.indexOf("self.play(")).toBeLessThan(lowered.source.indexOf("# poietra:anchor 8.5"));
    expect(imported?.runtimeSceneState.propertyChannels[
      "source:examples/relativity.py#GroupedEquation:equation/position"
    ]?.samples.at(-1)?.interval).toEqual({ end: 8.5, start: 7 });
  });

  it("lowers an immediate absolute scale as a relative Manim factor and reimports its absolute value", () => {
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
      source,
      request(canonicalProgram([scale], "scale-now")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const samples = imported?.runtimeSceneState.propertyChannels[
      "source:examples/relativity.py#GroupedEquation:equation/scale"
    ]?.samples ?? [];

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
      source,
      request(canonicalProgram([scale], "scale-over-time")),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const sample = imported?.runtimeSceneState.propertyChannels[
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
    const motionSample = imported?.runtimeSceneState.propertyChannels[`${entityId}/position`]
      ?.samples.at(-1);
    const scaleSample = imported?.runtimeSceneState.propertyChannels[`${entityId}/scale`]
      ?.samples.at(-1);

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

    expect(() => lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([scale], "invalid-scale")),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/finite positive absolute from and to/i);
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
    expect(imported?.runtimeSceneState.objectGraph.entities[
      "source:examples/relativity.py#GroupedEquation:equation"
    ]?.lifetime).toEqual([{ end: 7, start: 0 }]);
  });

  it("advances the consumed anchor so a second commit appends in playback order", () => {
    const firstProgram = canonicalProgram([motionOperation()], "first-commit");
    const first = lowerCanonicalProgramSource(
      source,
      request(firstProgram),
      { height: 8, width: 14.222 },
      null,
    );
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
    const samples = imported?.runtimeSceneState.propertyChannels[
      "source:examples/relativity.py#GroupedEquation:equation/position"
    ]?.samples.filter((sample) => sample.kind === "animated") ?? [];

    expect(first.source).toContain("# poietra:cursor 7");
    expect(findSceneMotionAnchors(first.source, "GroupedEquation").map((anchor) => anchor.seconds)).toEqual([8.5]);
    expect(second.source.indexOf('poietra:transaction "first-commit"'))
      .toBeLessThan(second.source.indexOf('poietra:transaction "second-commit"'));
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

    expect(findSceneMotionAnchors(lowered.source, "GroupedEquation").map((anchor) => anchor.seconds))
      .toEqual([8.5, 11.5]);
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
      { ...operationBase("create-text", 7), entity: { content: { displayLines: ["Energy"], text: "Energy" }, id: textId, lifetime: { end: null, start: 7 }, type: "Text" }, kind: "CreateEntity" },
      { ...operationBase("place-text", 7), kind: "SetRelation", mode: "snapshot", offset: { x: 145, y: 0 }, placement: "right", relation: "next-to", sourceEntityId: textId, targetEntityId: equationId },
      { ...operationBase("position-text", 7), entityId: textId, key: "position", kind: "SetProperty", value: { x: 320, y: 180 } },
      { ...operationBase("show-equation", 7, 8), effect: "fade-in", entityId: equationId, kind: "ChangePresence", persistent: true },
      { ...operationBase("show-text", 7, 8), effect: "fade-in", entityId: textId, kind: "ChangePresence", persistent: true },
      { ...operationBase("create-overlay", 8), entity: { content: { displayLines: ["sky circle"] }, id: overlayId, lifetime: { end: 9, start: 8 }, type: "TransitionOverlay:circle:sky" }, kind: "CreateEntity" },
      { ...operationBase("cover", 8, 8.5), effect: "cover", entityId: overlayId, kind: "ChangePresence", persistent: false },
      { ...operationBase("boundary", 8.5), at: 8.5, destination: "next-scene", kind: "InsertSceneBoundary" },
      { ...operationBase("reveal", 8.5, 9), effect: "reveal", entityId: overlayId, kind: "ChangePresence", persistent: true },
    ];
    const program = {
      ...canonicalProgram(operations, "compound"),
      intentCount: 3,
      schedule: { edges: [], mode: "sequence" as const, order: operations.map((operation) => operation.id) },
    };
    const lowered = lowerCanonicalProgramSource(
      source,
      { ...request(program, []), destination: { sceneName: "Next", sourcePath: "scene.py" } },
      { height: 8, width: 14.222 },
      {
        initialization: ["title = Text(\"Next\")"],
        visibleSourceVariables: ["title"],
      },
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode).toContain("MathTex(\"E\", \"=\", \"m\", \"c^2\")");
    expect(lowered.insertedCode).toContain("Text(\"Energy\")");
    expect(lowered.insertedCode).toContain(".get_center() + 3.2222 * RIGHT");
    expect(lowered.insertedCode.indexOf(".get_center() + 3.2222 * RIGHT"))
      .toBeLessThan(lowered.insertedCode.indexOf(".move_to(ORIGIN)"));
    expect(lowered.insertedCode).toContain("FadeIn(");
    expect(lowered.insertedCode).toContain("self.clear()");
    expect(lowered.insertedCode).toContain('# poietra:scene-boundary {"at":8.5,"destination":"scene.py#Next"}');
    expect(lowered.insertedCode).toContain("# poietra:incoming-start");
    expect(lowered.insertedCode).toContain("title = Text(\"Next\")");
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
          entity: { content: { displayLines: [type], label: type }, id: entityId, lifetime: { end: null, start: 7 }, type },
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

    expect(() => lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([position, wait])),
      { height: 8, width: 14.222 },
      null,
    )).toThrow("An inserted wait must occupy its own source interval.");
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
    const sample = imported?.runtimeSceneState.propertyChannels[
      "source:examples/relativity.py#GroupedEquation:equation/position"
    ]?.samples.at(-1);

    expect(lowered.insertedCode).toContain('# poietra:motion {"motions":[{"controlOffset":{"x":32,"y":45},"delta":{"x":64,"y":-45},"variables":["equation"]}],"version":1}');
    expect(lowered.insertedCode).toContain(
      "MoveAlongPath(equation, CubicBezier(equation.get_center(), equation.get_center() + 0.9481 * RIGHT + 0.3333 * DOWN, equation.get_center() + 1.4222 * RIGHT, equation.get_center() + 1.4222 * RIGHT + 1 * UP))",
    );
    expect(lowered.insertedCode).not.toContain("equation.animate.shift(");
    expect(sample).toMatchObject({
      control: { x: 234, y: 157.5 },
      from: { x: 170, y: 135 },
      interval: { end: 8.5, start: 7 },
      value: { x: 234, y: 90 },
    });
  });

  it("preserves curved zero-displacement paths and tiny straight displacements", () => {
    const curved = lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([motionOperation({
        controlOffset: { x: 0, y: 30 },
        delta: { x: 0, y: 0 },
      })])),
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
    expect(() => lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([unsupported])),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/ModifyMotion has no truthful source lowering/);
  });

  it("rejects CameraFocus camera changes through the shared capability contract", () => {
    const cameraFocus: CanonicalEditOperation = {
      ...operationBase("camera-focus", 7, 8),
      kind: "ChangeCamera",
      property: "scale",
      value: 1.35,
    };
    expect(() => lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([cameraFocus]), []),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/CameraFocus can be previewed.*ChangeCamera cannot yet be lowered/);
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
    expect(() => lowerCanonicalProgramSource(
      source,
      request(canonicalProgram([liveRelation]), [
        { entityId: "equation_1", sourceVariable: "equation" },
        { entityId: "label_1", sourceVariable: "label" },
      ]),
      { height: 8, width: 14.222 },
      null,
    )).toThrow(/SetRelation live has no truthful source lowering/);
  });

  it("requires imported source identity and an exact source anchor", () => {
    expect(() => lowerCanonicalProgramSource(source, request(canonicalProgram([motionOperation()]), []), { height: 8, width: 14.222 }, null))
      .toThrow(/no imported Python source identity/i);
    const program = {
      ...canonicalProgram([motionOperation()]),
      anchor: {
        capturedPlayhead: 5,
        evidence: [],
        resolvedSeconds: 5,
        source: { kind: "playhead" as const, referenceSeconds: 5 },
      },
    };
    expect(() => lowerCanonicalProgramSource(source, request(program), { height: 8, width: 14.222 }, null))
      .toThrow(/No # poietra:anchor 5.000/);
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
      "        poietra_collision_1 = Text(\"Existing\")\n        equation = MathTex",
    );
    const create: CanonicalEditOperation = {
      ...operationBase("create", 7),
      entity: { content: { displayLines: ["x"], texParts: ["x"] }, id: "tx:collision/entity:new", lifetime: { end: null, start: 7 }, type: "MathTex" },
      kind: "CreateEntity",
    };
    const code = lowerCanonicalProgramSource(
      collisionSource,
      request(canonicalProgram([create], "collision"), []),
      { height: 8, width: 14.222 },
      null,
    ).insertedCode;

    expect(code).toContain("poietra_collision_1_2 = MathTex(\"x\")");
    expect(code).not.toContain("poietra_collision_1 = MathTex(\"x\")");
  });

  it("orders same-bucket dependencies and carries chained transform identities", () => {
    const firstTarget = "tx:chain/entity:first";
    const secondTarget = "tx:chain/entity:second";
    const explanationId = "tx:chain/entity:explanation";
    const relation: CanonicalEditOperation = {
      ...operationBase("place-explanation", 7),
      kind: "SetRelation", mode: "snapshot", offset: { x: 145, y: 0 }, placement: "right", relation: "next-to",
      sourceEntityId: explanationId, targetEntityId: firstTarget,
    };
    const explanation: CanonicalEditOperation = {
      ...operationBase("create-explanation", 7),
      entity: { content: { displayLines: ["Explanation"], text: "Explanation" }, id: explanationId, lifetime: { end: null, start: 7 }, type: "Text" },
      kind: "CreateEntity",
    };
    const operations: CanonicalEditOperation[] = [
      explanation,
      transformOperation("first-transform", 7, "equation_1", firstTarget, ["F", "=", "m", "a"]),
      relation,
      transformOperation("second-transform", 8, firstTarget, secondTarget, ["p", "=", "m", "v"]),
    ];
    const lowered = lowerCanonicalProgramSource(roundTripSource, request(canonicalProgram(operations, "chain")), { height: 8, width: 14.222 }, null);
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const targetVariable = imported?.sourceVariables[firstTarget];
    const explanationVariable = imported?.sourceVariables[explanationId];

    expect(lowered.insertedCode.match(/# poietra:position/g)).toHaveLength(3);
    expect(lowered.insertedCode).toContain("equation = poietra_chain_3");
    expect(lowered.insertedCode.indexOf(`${targetVariable} = MathTex(`))
      .toBeLessThan(lowered.insertedCode.indexOf(`${explanationVariable}.move_to(${targetVariable}.get_center()`));
    expect(imported?.sourceVariables).toMatchObject({
      [explanationId]: "poietra_chain_1",
      [firstTarget]: "poietra_chain_2",
      [secondTarget]: "poietra_chain_3",
    });
    expect([firstTarget, secondTarget].map((id) => imported?.runtimeSceneState.objectGraph.entities[id]?.lifetime))
      .toEqual([[{ end: 9, start: 7 }], [{ end: 10, start: 8 }]]);
    expect(imported).not.toBeNull();
    if (!imported) return;
    const sourcePosition = latestPosition(imported, "source:examples/relativity.py#GroupedEquation:equation");
    expect(sourcePosition).toMatchObject({ x: expect.closeTo(260, 2), y: 90 });
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
    const first = canonicalProgram([
      transformOperation("tx:alias-a/operation:transform", 7, "equation_1", firstTarget, ["F", "=", "m", "a"]),
    ], "alias-a");
    const secondBase = canonicalProgram([
      transformOperation("tx:alias-b/operation:transform", 8, firstTarget, secondTarget, ["p", "=", "m", "v"]),
    ], "alias-b");
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
    expect(lowered.insertedCode.lastIndexOf("equation = poietra_alias_b_1"))
      .toBeLessThan(lowered.insertedCode.indexOf("equation.animate.shift("));
  });
});
