import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import {
  createDirectManipulationPositionProgram,
  createDirectManipulationScaleProgram,
} from "../studio/suggestion-program";
import { programRenderRequestSchema } from "./contracts";
import { importManimScene } from "./source-import";
import {
  findSceneMotionAnchors,
  lowerCanonicalProgramBatchSource,
  lowerCanonicalProgramSource,
} from "./source-lowering";
import {
  canonicalProgram,
  lowerTextContentSource,
  motionOperation,
  operationBase,
  request,
  source,
  transformOperation,
} from "./source-lowering.test-fixtures";

describe("Canonical EditProgram source lowering", () => {
  it("discovers explicit source anchors inside their Scene", () => {
    expect(findSceneMotionAnchors(source, "GroupedEquation")).toEqual([{ line: 6, seconds: 7 }]);
  });

  it("preserves an unsupported constructor byte-for-byte while editing another object", () => {
    const customStatement = '        custom = widgets.CustomMobject("keep  spaces", option={"x": 1})';
    const mixedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
${customStatement}
        circle = Circle()
        self.add(circle, custom)
        self.wait(7)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const program = canonicalProgram([motionOperation({ targetEntityIds: ["circle_1"] })]);
    const lowered = lowerCanonicalProgramSource(
      mixedSource,
      request(program, [{ entityId: "circle_1", sourceVariable: "circle" }]),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.source.split("\n").filter((line) => line === customStatement)).toHaveLength(1);
    expect(importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation")?.importOutcomes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "source-preserved", sourceVariable: "custom" })]),
    );
  });

  it("round-trips canonical Inspector Text and MathTex content edits", () => {
    const contentSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        label = Text("energy").scale(1.25).set_color(RED).move_to(LEFT)
        self.add(equation, label)
        self.wait(7)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const operations: CanonicalEditOperation[] = [
      {
        ...operationBase("set-equation-content", 7),
        entityId: "equation_1",
        key: "content",
        kind: "SetProperty",
        value: {
          displayLines: ["F = m a"],
          label: "equation",
          texParts: ["F", "=", "m", "a"],
        },
      },
      {
        ...operationBase("set-label-content", 7),
        entityId: "label_1",
        key: "content",
        kind: "SetProperty",
        value: { displayLines: ["force"], label: "label", text: "force" },
      },
    ];
    const lowered = lowerCanonicalProgramSource(
      contentSource,
      request(canonicalProgram(operations, "inspector-content"), [
        { entityId: "equation_1", sourceVariable: "equation" },
        { entityId: "label_1", sourceVariable: "label" },
      ]),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");

    expect(lowered.insertedCode.match(/# poietra:content/g)).toHaveLength(2);
    expect(lowered.insertedCode).toContain(
      'equation.become(MathTex("F", "=", "m", "a").match_style(equation).match_height(equation).move_to(equation.get_center()))',
    );
    expect(lowered.insertedCode).toContain(
      'label.become(Text("force").match_style(label).match_height(label).move_to(label.get_center()))',
    );
    expect(
      imported?.runtimeSceneState.propertyChannels["source:examples/relativity.py#GroupedEquation:equation/content"]
        ?.samples,
    ).toHaveLength(2);
    expect(
      imported?.runtimeSceneState.objectGraph.entities["source:examples/relativity.py#GroupedEquation:equation"]
        ?.content,
    ).toEqual(expect.objectContaining({ texParts: ["F", "=", "m", "a"] }));
    expect(
      imported?.runtimeSceneState.objectGraph.entities["source:examples/relativity.py#GroupedEquation:label"]?.content,
    ).toEqual(expect.objectContaining({ text: "force" }));
  });

  it.each([
    [
      "SetProperty",
      {
        ...operationBase("set-unicode-content", 7),
        entityId: "label_1",
        key: "content",
        kind: "SetProperty",
        value: { displayLines: ["日本語"], text: "日本語" },
      },
    ],
    [
      "TransformContent",
      {
        ...operationBase("transform-unicode-content", 7, 8),
        kind: "TransformContent",
        replacement: { displayLines: ["日本語"], text: "日本語" },
        sourceEntityId: "label_1",
        strategy: "replacement-transform",
        targetEntityId: "tx:unicode-content/entity:target",
        targetType: "Text",
      },
    ],
  ] satisfies readonly (readonly [string, CanonicalEditOperation])[])(
    "rejects Unicode Text Python export through %s",
    (_label, operation) => {
      expect(() =>
        lowerCanonicalProgramSource(
          `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        label = Text("before")
        self.add(label)
        self.wait(7)
        # poietra:anchor 7.000
        self.wait(1)
`,
          request(canonicalProgram([operation], `unicode-${operation.kind}`), [
            { entityId: "label_1", sourceVariable: "label" },
          ]),
          { height: 8, width: 14.222 },
          null,
        ),
      ).toThrow(/Python export would not preserve it faithfully/i);
    },
  );

  it.each([
    ["constructor typography", 'Text("before", font="Noto Sans", weight=BOLD)', /constructor keyword arguments/i],
    ["dynamic Text content", "Text(name)", /static string literal arguments/i],
    ["dynamic MathTex content", "MathTex(expression)", /static string literal arguments/i],
    ["chained rotation", 'Text("before").rotate(PI / 4)', /unsupported chained source mutation/i],
    ["dynamic chained scale", 'Text("before").scale(factor)', /unsupported chained source mutation/i],
    ["negative chained scale", 'Text("before").scale(-1)', /unsupported chained source mutation/i],
    ["unknown chained mutation", 'Text("before").apply_matrix(matrix)', /unsupported chained source mutation/i],
  ])("rejects a content edit that cannot preserve imported Text %s", (_label, constructor, reason) => {
    const styledSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        label = ${constructor}
        self.add(label)
        self.wait(7)
        # poietra:anchor 7.000
        self.wait(1)
`;
    expect(() => lowerTextContentSource(styledSource, "styled-content")).toThrow(reason);
  });

  it.each([
    ["direct stretch", "label.stretch_to_fit_width(4)"],
    ["animated rotation", "self.play(Rotate(label), run_time=1)"],
    ["dynamic direct scale", "label.scale(factor)"],
    ["negative animated scale", "self.play(label.animate.scale(-1), run_time=1)"],
    ["content transform", 'self.play(Transform(label, Text("transformed")), run_time=1)'],
  ])("rejects a content edit after a prefix %s", (_label, mutation) => {
    const mutatedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        label = Text("before")
        self.add(label)
        ${mutation}
        self.wait(7)
        # poietra:anchor 7.000
        self.wait(1)
`;
    expect(() => lowerTextContentSource(mutatedSource, "mutated-content")).toThrow(
      /cannot preserve its source appearance/i,
    );
  });

  it.each([
    ["direct alias", "alias = label\n        alias.rotate(PI / 4)", "alias"],
    ["group alias", "group = VGroup(label)\n        group.rotate(PI / 4)", "group"],
  ])("rejects a content edit when a prefix %s retains the object", (_label, setup, expectedAlias) => {
    const aliasedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        label = Text("before")
        self.add(label)
        ${setup}
        self.wait(7)
        # poietra:anchor 7.000
        self.wait(1)
`;
    expect(() => lowerTextContentSource(aliasedSource, "aliased-content")).toThrow(
      new RegExp(`source alias ${expectedAlias} retains the object before the selected anchor`, "i"),
    );
  });

  it.each([
    ["content property", "", "value = label.text", "label"],
    ["subobject indexing", "", "self.add(label[0])", "label"],
    ["unknown call", "", "remember(label)", "label"],
  ])("rejects a content edit before a post-anchor %s reference", (_label, setup, suffix, expectedReference) => {
    const referencedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        label = Text("before")
        self.add(label)
        ${setup}
        self.wait(7)
        # poietra:anchor 7.000
        ${suffix}
`;
    expect(() => lowerTextContentSource(referencedSource, "referenced-content")).toThrow(
      new RegExp(`source reference ${expectedReference} is used after the selected anchor`, "i"),
    );
  });

  it("allows a content edit before a static source shift", () => {
    const shiftedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        label = Text("before")
        self.add(label)
        self.wait(7)
        # poietra:anchor 7.000
        self.play(label.animate.shift(0.5 * RIGHT), run_time=1, rate_func=smooth)
`;

    const lowered = lowerTextContentSource(shiftedSource, "shifted-content");

    expect(lowered.insertedCode).toContain('label.become(Text("after")');
  });

  it.each([
    ["a second tracked reference", "label.width * RIGHT"],
    ["a dynamic vector", "direction"],
  ])("rejects a content edit before a source shift with %s", (_label, vector) => {
    const shiftedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        label = Text("before")
        self.add(label)
        self.wait(7)
        # poietra:anchor 7.000
        self.play(label.animate.shift(${vector}), run_time=1, rate_func=smooth)
`;

    expect(() => lowerTextContentSource(shiftedSource, "unsafe-shifted-content")).toThrow(
      /source reference label is used after the selected anchor/i,
    );
  });

  it("rejects a static source shift combined with a globals reference to the same object", () => {
    const shiftedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        label = Text("before")
        other = Text("other")
        self.add(label, other)
        self.wait(7)
        # poietra:anchor 7.000
        self.play(label.animate.shift(RIGHT), Transform(other, globals()["label"]), run_time=1)
`;

    expect(() => lowerTextContentSource(shiftedSource, "globals-shifted-content")).toThrow(
      /source reference label is used after the selected anchor/i,
    );
  });

  it.each([
    ["rotation", ".rotate(PI / 2)"],
    ["stretch", ".stretch(2, 0)"],
    ["dynamic scale", ".scale(factor)"],
    ["an unknown call", ".apply_matrix(matrix)"],
  ])("rejects a content edit before a source shift followed by %s", (_label, suffix) => {
    const shiftedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        label = Text("before")
        self.add(label)
        self.wait(7)
        # poietra:anchor 7.000
        self.play(label.animate.shift(RIGHT)${suffix}, run_time=1)
`;

    expect(() => lowerTextContentSource(shiftedSource, "chained-shifted-content")).toThrow(
      /source reference label is used after the selected anchor/i,
    );
  });

  it("rejects content payloads that cannot round-trip through the strict marker contract", () => {
    const invalidContent = {
      ...operationBase("invalid-content", 7),
      entityId: "equation_1",
      key: "content",
      kind: "SetProperty",
      value: {
        displayLines: ["x"],
        label: "x".repeat(2_001),
        rogue: true,
        texParts: ["x"],
      },
    } as CanonicalEditOperation;

    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([invalidContent], "invalid-content")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/no truthful source lowering/i);
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

  it("moves and uniformly scales a direct ImageMobject without reconstructing its asset source", () => {
    const imageSource = `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class GroupedEquation(Scene):
    def construct(self):
        image = ImageMobject("image.png", resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"])
        self.add(image)
        # poietra:anchor 7.000
        self.wait(1)
`;
    const position: CanonicalEditOperation = {
      ...operationBase("move-image", 7),
      entityId: "image_1",
      key: "position",
      kind: "SetProperty",
      value: { x: 400.123456, y: 135.654321 },
    };
    const scale: CanonicalEditOperation = {
      ...operationBase("scale-image", 7),
      easing: "smooth",
      entityId: "image_1",
      from: 1,
      key: "scale",
      kind: "AnimateProperty",
      to: 1.5,
    };

    const lowered = lowerCanonicalProgramSource(
      imageSource,
      request(canonicalProgram([position, scale], "edit-image"), [{ entityId: "image_1", sourceVariable: "image" }]),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const entityId = "source:examples/relativity.py#GroupedEquation:image";

    expect(lowered.source.match(/ImageMobject\("image\.png"/g)).toHaveLength(1);
    expect(lowered.source).toContain('resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"]');
    expect(lowered.insertedCode).toContain(
      '# poietra:position {"kind":"absolute","value":{"x":400.123456,"y":135.654321},"variable":"image","version":1}',
    );
    expect(lowered.insertedCode).toContain("image.move_to((1.7804934238, 0.985459533333, 0))");
    expect(lowered.insertedCode).not.toMatch(/\b(?:RIGHT|LEFT|UP|DOWN|ORIGIN)\b/);
    expect(lowered.insertedCode).toContain(
      '# poietra:scale {"kind":"exact","value":1.5,"variable":"image","version":1}',
    );
    expect(lowered.insertedCode).toContain("image.scale(1.5)");
    expect(imported?.runtimeSceneState.objectGraph.entities[entityId]).toMatchObject({
      geometry: { dimensions: { kind: "unknown" } },
      type: "ImageMobject",
    });
    expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples.at(-1)).toMatchObject({
      kind: "exact",
      value: { x: 400.123456, y: 135.654321 },
    });
    expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/scale`]?.samples.at(-1)).toMatchObject({
      kind: "exact",
      value: 1.5,
    });
  });

  it("round-trips viewport positions as world-space move_to calls through a non-origin camera", () => {
    const frame = { height: 8, width: 14.222 };
    const cameraCenter = { x: 2.5, y: -1.25 };
    const positionProgram = (transactionId: string, value: Readonly<{ x: number; y: number }>) =>
      canonicalProgram(
        [
          {
            ...operationBase(`position-${transactionId}`, 7),
            entityId: "equation_1",
            key: "position",
            kind: "SetProperty",
            value,
          },
        ],
        transactionId,
      );
    const firstProgram = positionProgram("panned-position-first", { x: 400.123456, y: 135.654321 });
    const firstRequest = { ...request(firstProgram), cameraCenter };
    expect(programRenderRequestSchema.safeParse(firstRequest).success).toBe(true);
    const first = lowerCanonicalProgramBatchSource(
      source,
      firstRequest,
      [{ program: firstProgram, sourceAnchor: 7 }],
      frame,
      null,
    );
    const firstImported = importManimScene(first.source, "examples/relativity.py", "GroupedEquation", frame);

    expect(first.insertedCode).toContain("equation.move_to((4.2804934238, -0.264540466667, 0))");
    expect(
      firstImported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.at(-1),
    ).toMatchObject({ kind: "exact", value: { x: 400.123456, y: 135.654321 } });

    const secondProgram = positionProgram("panned-position-second", { x: 320, y: 180 });
    const second = lowerCanonicalProgramBatchSource(
      first.source,
      { ...request(secondProgram), cameraCenter },
      [{ program: secondProgram, sourceAnchor: 7 }],
      frame,
      null,
    );
    const secondImported = importManimScene(second.source, "examples/relativity.py", "GroupedEquation", frame);

    expect(second.source.match(/^\s*# poietra:position /gm)).toHaveLength(1);
    expect(second.source).toContain("equation.move_to((2.5, -1.25, 0))");
    expect(second.source).not.toContain("equation.move_to((4.2804934238, -0.264540466667, 0))");
    expect(
      secondImported?.runtimeSceneState.propertyChannels[
        "source:examples/relativity.py#GroupedEquation:equation/position"
      ]?.samples.at(-1),
    ).toMatchObject({ kind: "exact", value: { x: 320, y: 180 } });
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

  it("lowers and reimports an immediate Rectangle geometry resize", () => {
    const rectangleSource = source.replace(
      'equation = MathTex("E", "=", "m", "c^2")',
      "shape = Rectangle(width=4, height=2)",
    );
    const resize: CanonicalEditOperation = {
      ...operationBase("resize-rectangle", 7),
      entityId: "rectangle_1",
      from: { dimensions: { height: 2, width: 4 }, position: { x: 640, y: 360 } },
      kind: "ResizeEntity",
      scale: 1,
      shape: "rectangle",
      to: { dimensions: { height: 3, width: 6 }, position: { x: 730, y: 405 } },
    };
    const lowered = lowerCanonicalProgramSource(
      rectangleSource,
      {
        ...request(canonicalProgram([resize], "resize-rectangle"), [
          { entityId: "rectangle_1", sourceVariable: "shape" },
        ]),
        viewport: { height: 720, width: 1280 },
      },
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const entityId = "source:examples/relativity.py#GroupedEquation:shape";

    expect(lowered.insertedCode).toContain('# poietra:dimensions {"kind":"exact"');
    expect(lowered.insertedCode).toContain("shape.stretch_to_fit_width(6).stretch_to_fit_height(3).move_to(");
    expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/dimensions`]?.samples.at(-1)).toMatchObject({
      interval: { end: 8, start: 7 },
      kind: "exact",
      value: { height: 3, width: 6 },
    });
    expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples.at(-1)).toMatchObject({
      kind: "exact",
      value: { x: 365, y: 202.5 },
    });
  });

  it("keeps Circle aspect while lowering and reimporting an animated geometry resize", () => {
    const circleSource = source.replace(
      'equation = MathTex("E", "=", "m", "c^2")',
      "shape = Circle(radius=1).scale(1.25)",
    );
    const resize: CanonicalEditOperation = {
      ...operationBase("resize-circle", 7, 8.5),
      entityId: "circle_1",
      from: { dimensions: { radius: 1 }, position: { x: 320, y: 180 } },
      kind: "ResizeEntity",
      scale: 1.25,
      shape: "circle",
      to: { dimensions: { radius: 2 }, position: { x: 342.5, y: 157.5 } },
    };
    const lowered = lowerCanonicalProgramSource(
      circleSource,
      request(canonicalProgram([resize], "resize-circle"), [{ entityId: "circle_1", sourceVariable: "shape" }]),
      { height: 8, width: 14.222 },
      null,
    );
    const imported = importManimScene(lowered.source, "examples/relativity.py", "GroupedEquation");
    const entityId = "source:examples/relativity.py#GroupedEquation:shape";

    expect(lowered.insertedCode).toContain('# poietra:dimensions {"kind":"animated"');
    expect(lowered.insertedCode).toContain("shape.animate.scale_to_fit_width(5).move_to(");
    expect(lowered.insertedCode).not.toContain("stretch_to_fit_height");
    expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/dimensions`]?.samples.at(-1)).toMatchObject({
      from: { radius: 1 },
      interval: { end: 8.5, start: 7 },
      kind: "animated",
      value: { radius: 2 },
    });
    expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples.at(-1)).toMatchObject({
      from: { x: 320, y: 180 },
      kind: "animated",
      value: { x: 342.5, y: 157.5 },
    });
  });

  it("preserves a tiny positive effective resize instead of rounding it to zero", () => {
    const circleSource = source.replace(
      'equation = MathTex("E", "=", "m", "c^2")',
      "shape = Circle(radius=1).scale(0.00001)",
    );
    const resize: CanonicalEditOperation = {
      ...operationBase("tiny-circle", 7),
      entityId: "circle_1",
      from: { dimensions: { radius: 1 }, position: { x: 320, y: 180 } },
      kind: "ResizeEntity",
      scale: 0.00001,
      shape: "circle",
      to: { dimensions: { radius: 2 }, position: { x: 320, y: 180 } },
    };
    const lowered = lowerCanonicalProgramSource(
      circleSource,
      request(canonicalProgram([resize], "tiny-circle"), [{ entityId: "circle_1", sourceVariable: "shape" }]),
      { height: 8, width: 14.222 },
      null,
    );

    expect(lowered.insertedCode).toContain("shape.scale_to_fit_width(0.00004)");
    expect(lowered.insertedCode).not.toContain("scale_to_fit_width(0)");
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

    expect(() =>
      lowerCanonicalProgramSource(
        source,
        request(canonicalProgram([scale], "stale-scale")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/expects 1\.25x but source is 1x/i);
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

    expect(() =>
      lowerCanonicalProgramSource(
        scaledSource,
        request(canonicalProgram([transform, scale], "scale-transform")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/Scale and TransformContent cannot target the same logical object/i);
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
    const samples =
      imported?.runtimeSceneState.propertyChannels["source:examples/relativity.py#GroupedEquation:equation/scale"]
        ?.samples ?? [];

    expect(lowered.insertedCode).toContain("equation.animate.scale(1.5)");
    expect(lowered.insertedCode).toContain("equation.animate.scale(2)");
    expect(samples.at(-1)).toMatchObject({ from: 1.5, value: 3 });
  });

  it("round-trips Studio move and resize after repeated direct source transforms at the same anchor", () => {
    const repeatedSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("x")
        self.add(equation)
        equation.move_to((2, -1, 0))
        equation.scale(2)
        equation.move_to((3, 1, 0))
        equation.scale(0.75)
        # poietra:anchor 0.000
        self.wait(1)

class MarkerText(Scene):
    def construct(self):
        note = """
        # poietra:cursor 0
        # poietra:position {"kind":"absolute","value":{"x":320,"y":180},"variable":"decoy","version":1}
        decoy.move_to((0, 0, 0))
        # poietra:transaction "old-decoy"
        # poietra:cursor 0
        # poietra:position {"kind":"absolute","value":{"x":360,"y":180},"variable":"decoy","version":1}
        decoy.move_to((1, 0, 0))
        # poietra:transaction "resize-reimported-source"
        # poietra:anchor 0
        """
`;
    const frame = { height: 9, width: 16 };
    const imported = importManimScene(repeatedSource, "examples/relativity.py", "GroupedEquation", frame);
    const entityId = "source:examples/relativity.py#GroupedEquation:equation";
    const entity = imported?.runtimeSceneState.objectGraph.entities[entityId];
    if (!imported || entity?.geometry?.position.kind !== "known" || entity.geometry.scale.kind !== "known") {
      throw new Error("Repeated source transform fixture did not import with exact geometry");
    }
    const targetPosition = {
      x: entity.geometry.position.value.x + 40,
      y: entity.geometry.position.value.y - 20,
    };
    const move = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 40, y: -20 },
      positions: { [entityId]: entity.geometry.position.value },
      scene: imported.runtimeSceneState,
      start: 0,
      targetEntityIds: [entityId],
      transactionId: "move-after-source-transforms",
    });
    const resize = createDirectManipulationScaleProgram({
      capturedPlayhead: 0,
      interval: { end: 0, start: 0 },
      scales: { [entityId]: { from: entity.geometry.scale.value, to: 3 } },
      scene: imported.runtimeSceneState,
      targetEntityIds: [entityId],
      transactionId: "resize-after-source-transforms",
    });
    if (move.kind !== "valid" || resize.kind !== "valid") {
      throw new Error(`Direct manipulation did not validate: ${JSON.stringify([move.issues, resize.issues])}`);
    }

    const first = lowerCanonicalProgramBatchSource(
      repeatedSource,
      request(move.program, [{ entityId, sourceVariable: "equation" }]),
      [
        { program: move.program, sourceAnchor: 0 },
        { program: resize.program, sourceAnchor: 0 },
      ],
      frame,
      null,
    );
    const firstReimport = importManimScene(first.source, "examples/relativity.py", "GroupedEquation", frame);
    const firstEntity = firstReimport?.runtimeSceneState.objectGraph.entities[entityId];
    if (firstEntity?.geometry?.position.kind !== "known") {
      throw new Error("First compacted source did not reimport with an exact position");
    }
    expect(firstEntity?.geometry).toMatchObject({
      position: { kind: "known", value: targetPosition },
      scale: { kind: "known", value: 3 },
    });

    const secondTargetPosition = {
      x: firstEntity.geometry.position.value.x + 20,
      y: firstEntity.geometry.position.value.y + 10,
    };
    const moveAgain = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 20, y: 10 },
      positions: { [entityId]: firstEntity.geometry.position.value },
      scene: firstReimport?.runtimeSceneState ?? imported.runtimeSceneState,
      start: 0,
      targetEntityIds: [entityId],
      transactionId: "move-reimported-source",
    });
    const resizeAgain = createDirectManipulationScaleProgram({
      capturedPlayhead: 0,
      interval: { end: 0, start: 0 },
      scales: { [entityId]: { from: 3, to: 4.5 } },
      scene: firstReimport?.runtimeSceneState ?? imported.runtimeSceneState,
      targetEntityIds: [entityId],
      transactionId: "resize-reimported-source",
    });
    if (moveAgain.kind !== "valid" || resizeAgain.kind !== "valid") {
      throw new Error(
        `Reimported transform did not validate: ${JSON.stringify([moveAgain.issues, resizeAgain.issues])}`,
      );
    }
    const second = lowerCanonicalProgramBatchSource(
      first.source,
      request(moveAgain.program, [{ entityId, sourceVariable: "equation" }]),
      [
        { program: moveAgain.program, sourceAnchor: 0 },
        { program: resizeAgain.program, sourceAnchor: 0 },
      ],
      frame,
      null,
    );
    const secondReimport = importManimScene(second.source, "examples/relativity.py", "GroupedEquation", frame);
    const scaleSamples = secondReimport?.runtimeSceneState.propertyChannels[`${entityId}/scale`]?.samples ?? [];
    const groupedSource = second.source.slice(0, second.source.indexOf("class MarkerText"));

    expect(groupedSource.indexOf("equation.scale(0.75)")).toBeLessThan(groupedSource.indexOf("# poietra:cursor 0"));
    expect(groupedSource.match(/^\s*# poietra:cursor 0$/gm)).toHaveLength(1);
    expect(groupedSource.match(/^\s*# poietra:position /gm)).toHaveLength(1);
    expect(groupedSource.match(/^\s*# poietra:scale /gm)).toHaveLength(1);
    expect(groupedSource).toContain("equation.scale(3)");
    expect(groupedSource).not.toContain('poietra:transaction "move-after-source-transforms"');
    expect(groupedSource).not.toContain('poietra:transaction "resize-after-source-transforms"');
    expect(groupedSource).toContain('poietra:transaction "move-reimported-source"');
    expect(groupedSource).toContain('poietra:transaction "resize-reimported-source"');
    expect(second.source.match(/^\s*decoy\.move_to/gm)).toHaveLength(2);
    expect(second.anchorLines).toEqual([second.anchorLine]);
    const secondSourceLines = second.source.split(/\r?\n/);
    const secondEvidenceLines = second.insertedCode.split(/\r?\n/);
    expect(secondSourceLines.slice(second.anchorLine, second.anchorLine + secondEvidenceLines.length)).toEqual(
      secondEvidenceLines,
    );
    expect(secondSourceLines[second.anchorLine + secondEvidenceLines.length]).toMatch(/^\s*# poietra:anchor 0$/);
    expect(second.insertedCode).toContain("# poietra:position ");
    expect(second.insertedCode).toContain("# poietra:scale ");
    expect(second.insertedCode).toContain("equation.scale(3)");
    expect(second.insertedCode).not.toContain("equation.scale(1.5)");
    expect(second.insertedCode).toContain('poietra:transaction "move-reimported-source"');
    expect(second.insertedCode).toContain('poietra:transaction "resize-reimported-source"');
    expect(scaleSamples.at(-1)).toMatchObject({
      knowledge: { kind: "known", value: 4.5 },
      sameAnchorOrder: "before-studio-insertion",
      value: 4.5,
    });
    expect(secondReimport?.runtimeSceneState.objectGraph.entities[entityId]?.geometry?.position).toEqual({
      kind: "known",
      value: secondTargetPosition,
    });

    const mismatchedFirst = first.source.replace(
      /(# poietra:position [^\r\n]+\r?\n\s*)equation\.move_to\([^\r\n]+\)/,
      "$1equation.move_to((0, 0, 0))",
    );
    const mismatchedOutput = lowerCanonicalProgramSource(
      mismatchedFirst,
      request(resizeAgain.program, [{ entityId, sourceVariable: "equation" }]),
      frame,
      null,
    ).source;
    const mismatchedSecond = mismatchedOutput.slice(0, mismatchedOutput.indexOf("class MarkerText"));
    expect(mismatchedSecond.match(/^\s*# poietra:cursor 0$/gm)).toHaveLength(2);
    expect(mismatchedSecond.match(/^\s*# poietra:scale /gm)).toHaveLength(2);

    const mismatchedScaleFirst = first.source.replace(
      '"value":3,"variable":"equation"',
      '"value":300,"variable":"equation"',
    );
    const mismatchedScaleOutput = lowerCanonicalProgramSource(
      mismatchedScaleFirst,
      request(resizeAgain.program, [{ entityId, sourceVariable: "equation" }]),
      frame,
      null,
    ).source;
    const mismatchedScale = mismatchedScaleOutput.slice(0, mismatchedScaleOutput.indexOf("class MarkerText"));
    expect(mismatchedScale.match(/^\s*# poietra:cursor 0$/gm)).toHaveLength(2);
    expect(mismatchedScale.match(/^\s*# poietra:scale /gm)).toHaveLength(2);
    expect(mismatchedScale).not.toContain("equation.scale(3)");
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
    const samples =
      imported?.runtimeSceneState.propertyChannels["source:examples/relativity.py#GroupedEquation:equation/scale"]
        ?.samples ?? [];

    expect(lowered.insertedCode.indexOf("equation.animate.scale(1.5)")).toBeLessThan(
      lowered.insertedCode.indexOf("equation.animate.scale(2)"),
    );
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

    expect(() =>
      lowerCanonicalProgramSource(
        scaledSource,
        request(canonicalProgram([transform], "transform-scaled-source")),
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/TransformContent requires .* effective 1x scale.*2x/i);
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

    expect(() =>
      lowerCanonicalProgramBatchSource(
        source,
        request(first),
        [
          { program: first, sourceAnchor: 7 },
          { program: second, sourceAnchor: 7 },
        ],
        { height: 8, width: 14.222 },
        null,
      ),
    ).toThrow(/TransformContent requires .* effective 1x scale.*1\.5x/i);
  });
});
