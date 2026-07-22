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
        self.wait(99)
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

  it("imports simple per-object shifts and round-trips Studio markers", () => {
    const positioned = `from manim import *

class Positioned(Scene):
    def construct(self):
        base = Dot()
        label = Text("Label")
        self.add(base, label)
        self.play(
            base.animate.shift(RIGHT + UP),
            label.animate.shift(2 * LEFT + DOWN),
            run_time=1,
        )
        # poietra:position {"kind":"absolute","value":{"x":280,"y":120},"variable":"base","version":1}
        base.move_to(0.8889 * LEFT + 1.3333 * UP)
        # poietra:position {"kind":"relative","offset":{"x":10,"y":20},"relativeTo":"base","variable":"label","version":1}
        label.move_to(base.get_center() + 0.2222 * RIGHT + 0.4444 * DOWN)
        # poietra:motion {"motions":[{"delta":{"x":5,"y":-5},"variables":["base","label"]}],"version":1}
        self.play(
            base.animate.shift(0.1111 * RIGHT + 0.1111 * UP),
            label.animate.shift(0.1111 * RIGHT + 0.1111 * UP),
            run_time=2,
        )
        self.wait(1)
`;
    const imported = importManimScene(positioned, "scene.py", "Positioned");
    const samples = (variable: string) => imported?.runtimeSceneState.propertyChannels[
      `source:scene.py#Positioned:${variable}/position`
    ]?.samples;

    expect(samples("base")?.[1]?.value).toMatchObject({ x: expect.closeTo(215, 2), y: 90 });
    expect(samples("label")?.[1]?.value).toMatchObject({ x: expect.closeTo(230, 2), y: 180 });
    expect(samples("base")).toHaveLength(4);
    expect(samples("base")?.at(-1)).toMatchObject({
      control: { x: 282.5, y: 117.5 },
      from: { x: 280, y: 120 },
      interval: { end: 3, start: 1 },
      relative: true,
      value: { x: 285, y: 115 },
    });
    expect(samples("label")?.at(-1)).toMatchObject({
      from: { x: 290, y: 140 },
      interval: { end: 3, start: 1 },
      value: { x: 295, y: 135 },
    });
  });

  it("round-trips Studio quadratic control offsets from MoveAlongPath source", () => {
    const curved = `from manim import *

class Curved(Scene):
    def construct(self):
        dot = Dot()
        self.add(dot)
        # poietra:motion {"motions":[{"controlOffset":{"x":10,"y":-20},"delta":{"x":40,"y":30},"variables":["dot"]}],"version":1}
        self.play(
            MoveAlongPath(dot, CubicBezier(dot.get_center(), dot.get_center() + 0.4444 * RIGHT + 0.0741 * UP, dot.get_center() + 0.7407 * RIGHT + 0.1481 * DOWN, dot.get_center() + 0.8889 * RIGHT + 0.6667 * DOWN)),
            run_time=2,
            rate_func=smooth,
        )
`;
    const imported = importManimScene(curved, "scene.py", "Curved");
    const sample = imported?.runtimeSceneState.propertyChannels[
      "source:scene.py#Curved:dot/position"
    ]?.samples.at(-1);

    expect(sample).toMatchObject({
      control: { x: 200, y: 130 },
      from: { x: 170, y: 135 },
      interval: { end: 2, start: 0 },
      relative: true,
      value: { x: 210, y: 165 },
    });
  });

  it("fails closed for complex Python and an invalid marker", () => {
    const marked = `from manim import *

class Marked(Scene):
    def construct(self):
        dot = Dot()
        self.add(dot)
        # poietra:position {}
        self.play(Write(Text("dot.animate.shift(RIGHT)")), run_time=1)
        self.play(dot.animate.shift(RIGHT + normalize(UP)), run_time=1)
        # poietra:motion {"motions":[{"delta":{"x":5,"y":0},"variables":["dot","missing"]}],"version":1}
        self.play(dot.animate.shift(RIGHT), missing.animate.shift(LEFT), run_time=1)
        # poietra:motion
        self.play(dot.animate.shift(RIGHT), run_time=1)
`;
    const imported = importManimScene(marked, "scene.py", "Marked");
    const samples = imported?.runtimeSceneState.propertyChannels["source:scene.py#Marked:dot/position"]?.samples;

    expect(samples).toHaveLength(1);
    expect(imported?.runtimeSceneState.duration).toBe(4);
  });
});
