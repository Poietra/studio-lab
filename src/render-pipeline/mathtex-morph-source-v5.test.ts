import { describe, expect, it } from "vitest";
import {
  deriveHermeticMathTexMorphSourcePlanV5,
  HERMETIC_MATHTEX_MORPH_SOURCE_REFUSAL_MESSAGE_V5,
} from "./mathtex-morph-source-v5";
import { importManimScene } from "./source-import";

const INITIAL_TEX = "E = mc^2";
const MAXWELL_TEX = String.raw`\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}`;
const SCENE_NAME = "RealMathTexMorphScene";
const SOURCE = String.raw`from manim import MathTex, Scene, TransformMatchingTex, smoothstep


class RealMathTexMorphScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        self.wait(1, frozen_frame=True)
        maxwell = MathTex(r"\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}")
        maxwell.move_to(equation.get_center())
        self.play(
            TransformMatchingTex(equation, maxwell, transform_mismatches=True),
            run_time=1,
            rate_func=smoothstep,
        )
        equation = maxwell
        self.wait(0.5, frozen_frame=True)
        restored = MathTex("E = mc^2")
        restored.move_to(maxwell.get_center())
        self.play(
            TransformMatchingTex(maxwell, restored, transform_mismatches=True),
            run_time=2,
            rate_func=smoothstep,
        )
        maxwell = restored
        equation = restored
        self.wait(1, frozen_frame=True)
`;

function acceptedPlan(source = SOURCE) {
  const result = deriveHermeticMathTexMorphSourcePlanV5(source, SCENE_NAME);
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error("Expected the bounded V5 source to be accepted.");
  return result.plan;
}

describe("hermetic MathTex morph V5 source import", () => {
  it("derives the exact A/B/A lineage and canonical timeline", () => {
    expect(acceptedPlan()).toEqual({
      initialName: "equation",
      initialTexParts: [INITIAL_TEX],
      stages: [
        {
          placementSourceName: "equation",
          reboundAliases: ["equation"],
          runTime: 1,
          sourceName: "equation",
          targetName: "maxwell",
          targetTexParts: [MAXWELL_TEX],
        },
        {
          placementSourceName: "maxwell",
          reboundAliases: ["maxwell", "equation"],
          runTime: 2,
          sourceName: "maxwell",
          targetName: "restored",
          targetTexParts: [INITIAL_TEX],
        },
      ],
      timeline: [
        { duration: 1, kind: "wait" },
        { duration: 1, kind: "path-morph", stageIndex: 0 },
        { duration: 0.5, kind: "wait" },
        { duration: 2, kind: "path-morph", stageIndex: 1 },
        { duration: 1, kind: "wait" },
      ],
      version: 5,
    });
  });

  it("preserves raw TeX bytes and accepts only the exact import set", () => {
    expect(acceptedPlan().stages[0].targetTexParts).toEqual([MAXWELL_TEX]);
    const reordered = SOURCE.replace(
      "from manim import MathTex, Scene, TransformMatchingTex, smoothstep",
      "from manim import smoothstep, TransformMatchingTex, Scene, MathTex",
    );
    expect(acceptedPlan(reordered).stages[0].targetTexParts).toEqual([MAXWELL_TEX]);
  });

  it("keeps importer timing aligned for every upstream numeric literal form", () => {
    const source = SOURCE.replaceAll("self.wait(1, frozen_frame=True)", "self.wait(1e0, frozen_frame=True)")
      .replace("self.wait(0.5, frozen_frame=True)", "self.wait(.5e0, frozen_frame=True)")
      .replace("run_time=1,", "run_time=1_0,")
      .replace("run_time=2,", "run_time=2e0,");
    expect(deriveHermeticMathTexMorphSourcePlanV5(source, SCENE_NAME).kind).toBe("accepted");

    const imported = importManimScene(source, "scene.py", SCENE_NAME);
    expect(imported?.runtimeSceneState.duration).toBe(14.5);
    expect(imported?.runtimeSceneState.eventTrack.events.map(({ interval, kind }) => ({ interval, kind }))).toEqual([
      { interval: { end: 1, start: 0 }, kind: "wait" },
      { interval: { end: 11, start: 1 }, kind: "play" },
      { interval: { end: 11.5, start: 11 }, kind: "wait" },
      { interval: { end: 13.5, start: 11.5 }, kind: "play" },
      { interval: { end: 14.5, start: 13.5 }, kind: "wait" },
    ]);
  });

  it("imports frozen holds, centered targets, contents, and transform lifetimes", () => {
    const imported = importManimScene(SOURCE, "scene.py", SCENE_NAME);
    expect(imported?.runtimeSceneState.duration).toBe(5.5);
    expect(imported?.runtimeSceneState.eventTrack.events.map(({ interval, kind }) => ({ interval, kind }))).toEqual([
      { interval: { end: 1, start: 0 }, kind: "wait" },
      { interval: { end: 2, start: 1 }, kind: "play" },
      { interval: { end: 2.5, start: 2 }, kind: "wait" },
      { interval: { end: 4.5, start: 2.5 }, kind: "play" },
      { interval: { end: 5.5, start: 4.5 }, kind: "wait" },
    ]);
    const entities = imported?.runtimeSceneState.objectGraph.entities;
    expect(entities?.["source:scene.py#RealMathTexMorphScene:equation"]).toMatchObject({
      content: { texParts: [INITIAL_TEX] },
      lifetime: [{ end: 2, start: 0 }],
    });
    expect(entities?.["source:scene.py#RealMathTexMorphScene:maxwell"]).toMatchObject({
      content: { texParts: [MAXWELL_TEX] },
      geometry: { position: { kind: "known", value: { x: 320, y: 180 } } },
      lifetime: [{ end: 4.5, start: 1 }],
    });
    expect(entities?.["source:scene.py#RealMathTexMorphScene:restored"]).toMatchObject({
      content: { texParts: [INITIAL_TEX] },
      geometry: { position: { kind: "known", value: { x: 320, y: 180 } } },
      lifetime: [{ end: 5.5, start: 2.5 }],
    });
  });

  it.each([
    ["module side effect", (source: string) => `import os\n${source}`],
    [
      "one stage",
      (source: string) => source.replace("TransformMatchingTex(maxwell, restored", "FadeTransform(maxwell, restored"),
    ],
    [
      "three stages",
      (source: string) =>
        source.replace(
          /\n\s*self\.wait\(1, frozen_frame=True\)\n$/,
          "\n        self.play(TransformMatchingTex(restored, equation))\n",
        ),
    ],
    [
      "alternate animation",
      (source: string) => source.replace("TransformMatchingTex(equation", "TransformMatchingShapes(equation"),
    ],
    [
      "custom key map",
      (source: string) =>
        source.replace("transform_mismatches=True)", 'transform_mismatches=True, key_map={"E": "E"})'),
    ],
    ["custom rate", (source: string) => source.replace("rate_func=smoothstep", "rate_func=smooth")],
    ["custom path", (source: string) => source.replace("rate_func=smoothstep,", "rate_func=smoothstep, path_arc=1,")],
    ["dynamic target", (source: string) => source.replace('MathTex("E = mc^2")', "MathTex(make_tex())")],
    ["styled target", (source: string) => source.replace('MathTex("E = mc^2")', 'MathTex("E = mc^2", color=RED)')],
    [
      "updater",
      (source: string) =>
        source.replace("        maxwell.move_to", "        maxwell.add_updater(lambda m: m)\n        maxwell.move_to"),
    ],
    ["ordinary wait", (source: string) => source.replace("self.wait(0.5, frozen_frame=True)", "self.wait(0.5)")],
    ["implicit strings", (source: string) => source.replace(String.raw`r"\nabla`, String.raw`r"\nabla" r"`)],
  ])("fails closed for %s without returning source evidence", (_name, mutate) => {
    const result = deriveHermeticMathTexMorphSourcePlanV5(mutate(SOURCE), SCENE_NAME);
    expect(result).toEqual({
      code: "source-profile-mismatch",
      kind: "refused",
      message: HERMETIC_MATHTEX_MORPH_SOURCE_REFUSAL_MESSAGE_V5,
    });
    expect(JSON.stringify(result)).not.toContain(MAXWELL_TEX);
  });

  it("matches the producer's exact canonical-duration predicate", () => {
    const producerRejectedDuration = 23 / 60;
    expect(
      deriveHermeticMathTexMorphSourcePlanV5(
        SOURCE.replace("run_time=1,", `run_time=${producerRejectedDuration},`),
        SCENE_NAME,
      ),
    ).toMatchObject({ code: "source-profile-mismatch", kind: "refused" });
  });
});
