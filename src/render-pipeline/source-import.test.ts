import { describe, expect, it } from "vitest";

import { runtimeSceneStateSchema } from "../studio/state-schema";
import { AmbiguousSourceSceneError, findSceneBlocks, importManimScene } from "./source-import";

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
    expect(
      imported?.runtimeSceneState.objectGraph.entities["source:scene.py#First:equation"]?.content?.texParts,
    ).toEqual(["E", "=", "m", "c^2"]);
    expect(imported?.runtimeSceneState.eventTrack.events.map((event) => event.kind)).toEqual(["play", "play", "wait"]);
    expect(
      imported?.runtimeSceneState.propertyChannels["source:scene.py#First:equation/position"]?.samples,
    ).toHaveLength(2);
    expect(imported?.initialVisibleSourceVariables).toEqual(["equation", "label"]);
    expect(imported?.runtimeSceneState.objectGraph.entities).not.toHaveProperty("source:scene.py#First:leaked");
    expect(imported?.runtimeSceneState.objectGraph.entities).not.toHaveProperty("source:scene.py#First:also_leaked");
  });

  it("ignores marker-looking strings and statements in nested dead scopes", () => {
    const unsafeMarkers = `from manim import *

class UnsafeMarkers(Scene):
    def construct(self):
        visible = Text("Visible")
        documentation = """
        # poietra:anchor 99.000
        leaked_from_string = Text("Not code")
        """
        if False:
            # poietra:anchor 88.000
            leaked_from_branch = Text("Not executed")
            self.wait(20)
        self.add(visible)
        self.wait(1)
`;
    const imported = importManimScene(unsafeMarkers, "scene.py", "UnsafeMarkers");

    expect(imported?.anchors).toEqual([]);
    expect(imported?.runtimeSceneState.duration).toBe(1);
    expect(imported?.runtimeSceneState.objectGraph.entities).not.toHaveProperty(
      "source:scene.py#UnsafeMarkers:leaked_from_string",
    );
    expect(imported?.runtimeSceneState.objectGraph.entities).not.toHaveProperty(
      "source:scene.py#UnsafeMarkers:leaked_from_branch",
    );
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
    expect(imported?.runtimeSceneState.objectGraph.entities["tx:one/entity:new-equation"]?.sourceIdentity).toEqual({
      kind: "known",
      value: "poietra_one_1",
    });
  });

  it("rejects duplicate Scene names instead of importing the first definition twice", () => {
    const duplicate = `from manim import *

class RepeatedName(Scene):
    def construct(self):
        first = Text("First definition")
        self.add(first)

class RepeatedName(Scene):
    def construct(self):
        second = Text("Effective Python definition")
        self.add(second)
`;

    expect(findSceneBlocks(duplicate).map((block) => block.name)).toEqual(["RepeatedName", "RepeatedName"]);
    expect(() => importManimScene(duplicate, "scenes/duplicate.py", "RepeatedName")).toThrowError(
      AmbiguousSourceSceneError,
    );
    expect(() => importManimScene(duplicate, "scenes/duplicate.py", "RepeatedName")).toThrow(
      /Scene "RepeatedName".*scenes\/duplicate\.py.*lines 3, 8/i,
    );
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
    expect(imported?.runtimeSceneState.eventTrack.events).toContainEqual(
      expect.objectContaining({
        at: 4,
        kind: "scene-boundary",
      }),
    );
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

    expect(imported?.runtimeSceneState.objectGraph.entities["source:scene.py#Added:visible"]?.lifetime).toEqual([
      { end: 1, start: 0 },
    ]);
    expect(imported?.runtimeSceneState.objectGraph.entities["source:scene.py#Added:unused"]?.lifetime).toEqual([]);
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

    expect(imported?.runtimeSceneState.objectGraph.entities["source:scene.py#Transforming:equation"]?.lifetime).toEqual(
      [{ end: 3, start: 0 }],
    );
    expect(imported?.runtimeSceneState.objectGraph.entities["tx:one/entity:replacement"]?.lifetime).toEqual([
      { end: 4, start: 1 },
    ]);
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

    expect(imported?.runtimeSceneState.objectGraph.entities["source:scene.py#Repeated:item"]?.lifetime).toEqual([
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
    const samples = (variable: string) =>
      imported?.runtimeSceneState.propertyChannels[`source:scene.py#Positioned:${variable}/position`]?.samples;

    expect(samples("base")?.[1]?.value).toMatchObject({ x: expect.closeTo(365, 2), y: 135 });
    expect(samples("label")?.[1]?.value).toMatchObject({ x: expect.closeTo(230, 2), y: 225 });
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
            MoveAlongPath(dot, CubicBezier(dot.get_center(), dot.get_center() + 0.4444 * RIGHT + 0.0741 * UP, dot.get_center() + 0.7407 * RIGHT + 0.1481 * DOWN, dot.get_center() + 0.8889 * RIGHT + 0.6667 * DOWN), rate_func=smooth), # keep path easing nested
            run_time=2,
            rate_func=linear,
        )
`;
    const imported = importManimScene(curved, "scene.py", "Curved");
    const sample = imported?.runtimeSceneState.propertyChannels["source:scene.py#Curved:dot/position"]?.samples.at(-1);

    expect(sample).toMatchObject({
      control: { x: 350, y: 175 },
      easing: "linear",
      from: { x: 320, y: 180 },
      interval: { end: 2, start: 0 },
      relative: true,
      value: { x: 360, y: 210 },
    });
  });

  it("separates literal geometry facts from runtime-dependent approximations", () => {
    const geometrySource = `from manim import *

class Geometry(Scene):
    def construct(self):
        circle = Circle(radius=2, color=RED)
        rectangle = Rectangle(width=3, height=1, fill_color="#123456").scale(0.5)
        dynamic = Circle(radius=get_radius(), color=choose_color()).move_to(where()).scale(get_scale())
        self.add(circle, rectangle, dynamic)
        self.wait(1)
`;
    const imported = importManimScene(geometrySource, "scene.py", "Geometry");
    const entities = imported?.runtimeSceneState.objectGraph.entities;
    const circle = entities?.["source:scene.py#Geometry:circle"];
    const rectangle = entities?.["source:scene.py#Geometry:rectangle"];
    const dynamic = entities?.["source:scene.py#Geometry:dynamic"];

    expect(circle?.geometry).toEqual({
      dimensions: { kind: "known", value: { radius: 2 } },
      position: { kind: "known", value: { x: 320, y: 180 } },
      scale: { kind: "known", value: 1 },
      style: { kind: "known", value: { color: "RED" } },
    });
    expect(rectangle?.geometry).toEqual({
      dimensions: { kind: "known", value: { height: 1, width: 3 } },
      position: { kind: "known", value: { x: 320, y: 180 } },
      scale: { kind: "known", value: 0.5 },
      style: { kind: "known", value: { fillColor: "#123456" } },
    });
    expect(dynamic?.geometry?.dimensions).toMatchObject({ kind: "unknown", reason: expect.any(String) });
    expect(dynamic?.geometry?.position).toMatchObject({ kind: "unknown", reason: expect.any(String) });
    expect(dynamic?.geometry?.scale).toMatchObject({ kind: "unknown", reason: expect.any(String) });
    expect(dynamic?.geometry?.style).toMatchObject({ kind: "unknown", reason: expect.any(String) });
    expect(runtimeSceneStateSchema.parse(JSON.parse(JSON.stringify(imported?.runtimeSceneState)))).toEqual(
      imported?.runtimeSceneState,
    );
  });

  it("marks an unverified source resize as unknown geometry", () => {
    const imported = importManimScene(`from manim import *

class Resized(Scene):
    def construct(self):
        shape = Rectangle(width=4, height=2)
        self.add(shape)
        shape.stretch_to_fit_width(get_width()).stretch_to_fit_height(3).move_to(where())
        self.wait(1)
`, "scene.py", "Resized");
    const entityId = "source:scene.py#Resized:shape";

    expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/dimensions`]?.samples.at(-1)?.knowledge)
      .toMatchObject({ kind: "unknown", reason: expect.stringMatching(/unverified resize/i) });
    expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples.at(-1)?.knowledge)
      .toMatchObject({ kind: "unknown", reason: expect.stringMatching(/unverified resize/i) });
  });

  it("fails closed for common unmarked dimension mutations without inventing position changes", () => {
    const imported = importManimScene(`from manim import *

class Resized(Scene):
    def construct(self):
        height_only = Rectangle(width=4, height=2)
        width_only = Rectangle(width=4, height=2)
        animated = Rectangle(width=4, height=2)
        self.add(height_only, width_only, animated)
        height_only.stretch_to_fit_height(3)
        width_only.set_width(5)
        self.play(animated.animate.scale_to_fit_height(4), run_time=1)
`, "scene.py", "Resized");

    for (const variable of ["height_only", "width_only", "animated"]) {
      const entityId = `source:scene.py#Resized:${variable}`;
      expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/dimensions`]?.samples.at(-1)?.knowledge)
        .toMatchObject({ kind: "unknown" });
      expect(imported?.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples)
        .toHaveLength(1);
      expect(imported?.runtimeSceneState.objectGraph.entities[entityId]?.geometry?.position)
        .toMatchObject({ kind: "known" });
    }
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

    expect(samples).toHaveLength(4);
    expect(samples?.slice(1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ knowledge: expect.objectContaining({ kind: "unknown" }) })]),
    );
    expect(samples?.slice(1).every((sample) => sample.knowledge?.kind === "unknown")).toBe(true);
    expect(imported?.runtimeSceneState.duration).toBe(4);
  });
});
