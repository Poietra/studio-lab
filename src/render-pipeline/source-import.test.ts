import { describe, expect, it } from "vitest";

import { findSceneBlocks, importManimScene } from "./source-import";

const source = `from manim import *

class First(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        label = Text("energy").next_to(equation, DOWN)
        self.play(FadeIn(equation), FadeIn(label), run_time=2)
        self.play(equation.animate.shift(RIGHT), run_time=1)
        # poietra:anchor 3.000
        self.wait(1)

    # poietra:anchor 88.000
    def helper(self):
        leaked = Text("Must not be imported")
        # poietra:anchor 99.000

class NotAScene:
    def construct(self):
        also_leaked = Text("Not a Scene")

class Second(Scene):
    def construct(self):
        title = Text("Next")
        self.play(FadeIn(title), run_time=1)
`;

describe("conservative Manim source import", () => {
  it("discovers ordered Scene blocks and imports runtime identities, timing, and content", () => {
    expect(findSceneBlocks(source).map((block) => block.name)).toEqual(["First", "Second"]);
    const imported = importManimScene(source, "scene.py", "First");

    expect(imported).not.toBeNull();
    expect(imported?.sceneId).toBe("scene.py#First");
    expect(imported?.anchors).toEqual([3]);
    expect(imported?.runtimeSceneState.duration).toBe(4);
    expect(imported?.sourceVariables).toEqual({
      "source:scene.py#First:equation": "equation",
      "source:scene.py#First:label": "label",
    });
    expect(imported?.runtimeSceneState.objectGraph.entities["source:scene.py#First:equation"]?.content?.texParts)
      .toEqual(["E", "=", "m", "c^2"]);
    expect(imported?.runtimeSceneState.eventTrack.events.map((event) => event.kind)).toEqual(["play", "play", "wait"]);
    expect(imported?.runtimeSceneState.propertyChannels["source:scene.py#First:equation/position"]?.samples)
      .toHaveLength(2);
    expect(imported?.initialVisibleSourceVariables).toEqual(["equation", "label"]);
    expect(imported?.runtimeSceneState.objectGraph.entities).not.toHaveProperty("source:scene.py#First:leaked");
    expect(imported?.runtimeSceneState.objectGraph.entities).not.toHaveProperty("source:scene.py#First:also_leaked");
  });

  it("restores a transaction-scoped Studio identity from a committed source marker", () => {
    const marked = source
      .replace(
        "        equation = MathTex",
        '        # poietra:entity {"id":"tx:one/entity:new-equation","variable":"poietra_one_1"}\n        poietra_one_1 = MathTex',
      )
      .replace("next_to(equation", "next_to(poietra_one_1")
      .replace("FadeIn(equation)", "FadeIn(poietra_one_1)")
      .replace("equation.animate", "poietra_one_1.animate");
    const imported = importManimScene(marked, "scene.py", "First");

    expect(imported?.sourceVariables["tx:one/entity:new-equation"]).toBe("poietra_one_1");
    expect(imported?.runtimeSceneState.objectGraph.entities["tx:one/entity:new-equation"]?.sourceIdentity)
      .toEqual({ kind: "known", value: "poietra_one_1" });
  });

  it("restores a committed Scene boundary without importing its transient incoming copy", () => {
    const committed = `from manim import *

class First(Scene):
    def construct(self):
        base = Text("Base")
        self.play(FadeIn(base), run_time=3)
        # poietra:anchor 3.000
        # poietra:entity {"id":"tx:one/entity:equation","variable":"poietra_one_1"}
        poietra_one_1 = MathTex("F", "=", "m", "a")
        self.play(FadeIn(poietra_one_1), run_time=1)
        # poietra:scene-boundary {"at":4,"destination":"scene.py#Second"}
        self.clear()
        # poietra:incoming-start
        incoming_title = Text("Incoming")
        # poietra:incoming-end
        self.add(incoming_title)
        return
        self.wait(20)
`;
    const imported = importManimScene(committed, "scene.py", "First");

    expect(imported?.runtimeSceneState.duration).toBe(4);
    expect(imported?.runtimeSceneState.objectGraph.entities).toHaveProperty("tx:one/entity:equation");
    expect(imported?.runtimeSceneState.objectGraph.entities).not.toHaveProperty("source:scene.py#First:incoming_title");
    expect(imported?.runtimeSceneState.eventTrack.events).toContainEqual(expect.objectContaining({
      at: 4,
      kind: "scene-boundary",
    }));
  });

  it("does not treat assignment as presence without add or an introducing animation", () => {
    const addSource = `from manim import *

class Added(Scene):
    def construct(self):
        visible = Text("Visible")
        unused = Text("Unused")
        self.add(visible)
        self.wait(1)
`;
    const imported = importManimScene(addSource, "scene.py", "Added");

    expect(imported?.runtimeSceneState.objectGraph.entities["source:scene.py#Added:visible"]?.lifetime)
      .toEqual([{ end: 1, start: 0 }]);
    expect(imported?.runtimeSceneState.objectGraph.entities["source:scene.py#Added:unused"]?.lifetime)
      .toEqual([]);
    expect(imported?.initialVisibleSourceVariables).toEqual(["visible"]);
  });

  it("records replacement lineage as non-overlapping source and target lifetimes", () => {
    const transformed = `from manim import *

class Transforming(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(1)
        # poietra:entity {"id":"tx:one/entity:replacement","variable":"replacement"}
        replacement = MathTex("F", "=", "m", "a")
        self.play(TransformMatchingTex(equation, replacement), run_time=2)
        self.wait(1)
`;
    const imported = importManimScene(transformed, "scene.py", "Transforming");

    expect(imported?.runtimeSceneState.objectGraph.entities["source:scene.py#Transforming:equation"]?.lifetime)
      .toEqual([{ end: 3, start: 0 }]);
    expect(imported?.runtimeSceneState.objectGraph.entities["tx:one/entity:replacement"]?.lifetime)
      .toEqual([{ end: 4, start: 1 }]);
  });

  it("preserves repeated presence intervals and ignores removal before first presence", () => {
    const repeated = `from manim import *

class Repeated(Scene):
    def construct(self):
        item = Text("Again")
        self.remove(item)
        self.wait(1)
        self.add(item)
        self.wait(1)
        self.remove(item)
        self.wait(1)
        self.add(item)
        self.wait(1)
`;
    const imported = importManimScene(repeated, "scene.py", "Repeated");

    expect(imported?.runtimeSceneState.objectGraph.entities["source:scene.py#Repeated:item"]?.lifetime)
      .toEqual([
        { end: 2, start: 1 },
        { end: 4, start: 3 },
      ]);
  });

  it("imports each object's own vector when concurrent shifts use different directions", () => {
    const concurrent = `from manim import *

class Concurrent(Scene):
    def construct(self):
        first = Dot()
        second = Dot()
        self.add(first, second)
        self.play(
            first.animate.shift(RIGHT + UP),
            second.animate.shift(2 * LEFT + DOWN),
            run_time=1,
        )
`;
    const imported = importManimScene(concurrent, "scene.py", "Concurrent");
    const first = imported?.runtimeSceneState.propertyChannels[
      "source:scene.py#Concurrent:first/position"
    ]?.samples.at(-1)?.value;
    const second = imported?.runtimeSceneState.propertyChannels[
      "source:scene.py#Concurrent:second/position"
    ]?.samples.at(-1)?.value;

    expect(first).toMatchObject({ x: expect.closeTo(215, 2), y: 90 });
    expect(second).toMatchObject({ x: expect.closeTo(230, 2), y: 180 });
  });

  it("applies a scalar to every term in a parenthesized shift vector", () => {
    const scaled = `from manim import *

class Scaled(Scene):
    def construct(self):
        dot = Dot()
        self.add(dot)
        self.play(dot.animate.shift(2 * (RIGHT + UP)), run_time=1)
`;
    const imported = importManimScene(scaled, "scene.py", "Scaled");
    const position = imported?.runtimeSceneState.propertyChannels[
      "source:scene.py#Scaled:dot/position"
    ]?.samples.at(-1)?.value;

    expect(position).toMatchObject({ x: expect.closeTo(260, 2), y: 45 });
  });

  it("imports generated absolute and center-relative move_to calls in cursor order", () => {
    const positioned = `from manim import *

class Positioned(Scene):
    def construct(self):
        base = Dot().move_to(LEFT + 2 * UP)
        label = Text("Label")
        self.add(base, label)
        self.wait(1)
        base.move_to(2 * RIGHT + UP)
        label.move_to(base.get_center() + 3 * DOWN)
        self.wait(1)
`;
    const imported = importManimScene(positioned, "scene.py", "Positioned");
    const baseSamples = imported?.runtimeSceneState.propertyChannels[
      "source:scene.py#Positioned:base/position"
    ]?.samples;
    const labelSamples = imported?.runtimeSceneState.propertyChannels[
      "source:scene.py#Positioned:label/position"
    ]?.samples;

    expect(baseSamples).toHaveLength(3);
    expect(baseSamples?.map((sample) => sample.interval)).toEqual([
      { end: 0, start: 0 },
      { end: 1, start: 0 },
      { end: 2, start: 1 },
    ]);
    expect(baseSamples?.at(-1)?.value).toMatchObject({ x: expect.closeTo(410, 2), y: 135 });
    expect(labelSamples?.map((sample) => sample.interval)).toEqual([
      { end: 1, start: 0 },
      { end: 2, start: 1 },
    ]);
    expect(labelSamples?.at(-1)?.value).toMatchObject({ x: expect.closeTo(410, 2), y: 270 });
  });

  it("ignores malformed or unsupported shift expressions instead of applying a partial vector", () => {
    const unsupported = `from manim import *

class Unsupported(Scene):
    def construct(self):
        malformed = Dot()
        function_call = Dot()
        self.add(malformed, function_call)
        self.play(
            malformed.animate.shift(RIGHT + (UP *)),
            function_call.animate.shift(RIGHT + normalize(UP)),
            run_time=1,
        )
`;
    const imported = importManimScene(unsupported, "scene.py", "Unsupported");

    expect(imported?.runtimeSceneState.propertyChannels[
      "source:scene.py#Unsupported:malformed/position"
    ]?.samples).toHaveLength(1);
    expect(imported?.runtimeSceneState.propertyChannels[
      "source:scene.py#Unsupported:function_call/position"
    ]?.samples).toHaveLength(1);
  });
});
