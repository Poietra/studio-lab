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
});
