import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { canonicalizeSuggestionProgram } from "../studio/suggestion-program";
import type { ProgramRenderRequest } from "./contracts";
import {
  lowerCanonicalProgramSource,
} from "./source-lowering";
import { importManimScene } from "./source-import";

const source = `from manim import *

class MagicObjectEdits(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(5)
        # poietra:anchor 5.000
        self.wait(3)
`;

describe("Magic Edit scale/delete source lowering", () => {
  it("exports one canonical scale-then-delete sequence without dropping either effect", () => {
    const imported = importManimScene(source, "scene.py", "MagicObjectEdits");
    expect(imported).not.toBeNull();
    if (!imported) return;
    const entity = Object.values(imported.runtimeSceneState.objectGraph.entities).find((candidate) => (
      candidate.sourceIdentity.kind === "known" && candidate.sourceIdentity.value === "equation"
    ));
    expect(entity).toBeDefined();
    if (!entity) return;
    const operation: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          easing: "smooth",
          end: 6,
          factor: 1.5,
          kind: "scale-objects",
          start: 5,
          targetObjectIds: [entity.id],
        },
        {
          animation: "fade-out",
          end: 6.4,
          kind: "delete-objects",
          start: 6,
          targetObjectIds: [entity.id],
        },
      ],
    };
    const validation = canonicalizeSuggestionProgram(operation, {
      capturedPlayhead: 5,
      origin: "remote-model",
      scene: imported.runtimeSceneState,
      transactionId: "magic-scale-delete",
    });
    expect(validation.kind).toBe("valid");
    const request: ProgramRenderRequest = {
      destination: null,
      program: validation.program,
      projectId: "studio-lab",
      sceneName: "MagicObjectEdits",
      sourceBindings: [{ entityId: entity.id, sourceVariable: "equation" }],
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
      viewport: { height: 360, width: 640 },
    };

    const lowered = lowerCanonicalProgramSource(
      source,
      request,
      { height: 8, width: 14.222 },
      null,
    );
    expect(lowered.insertedCode).toContain(
      '# poietra:scale {"kind":"animated","scales":[{"from":1,"to":1.5,"variable":"equation"}],"version":1}',
    );
    expect(lowered.insertedCode).toContain("equation.animate.scale(1.5)");
    expect(lowered.insertedCode).toContain("FadeOut(equation)");
    expect(lowered.insertedCode.indexOf("equation.animate.scale(1.5)"))
      .toBeLessThan(lowered.insertedCode.indexOf("FadeOut(equation)"));

    const roundTrip = importManimScene(lowered.source, "scene.py", "MagicObjectEdits");
    expect(roundTrip?.runtimeSceneState.propertyChannels[`${entity.id}/scale`]?.samples.at(-1))
      .toMatchObject({ value: 1.5 });
    expect(roundTrip?.runtimeSceneState.objectGraph.entities[entity.id]?.lifetime.at(-1)?.end)
      .toBeCloseTo(6.4);
  });

  it("keeps preview/export semantics when imported relative scales surround Magic scale", () => {
    const scaledSource = `from manim import *

class MagicObjectEdits(Scene):
    def construct(self):
        equation = MathTex("x")
        self.add(equation)
        self.play(equation.animate.scale(2), run_time=1)
        self.wait(4)
        # poietra:anchor 5.000
        self.wait(1)
        self.play(equation.animate.scale(0.5), run_time=1)
        self.wait(1)
`;
    const imported = importManimScene(scaledSource, "scene.py", "MagicObjectEdits");
    expect(imported).not.toBeNull();
    if (!imported) return;
    const entity = Object.values(imported.runtimeSceneState.objectGraph.entities).find((candidate) => (
      candidate.sourceIdentity.kind === "known" && candidate.sourceIdentity.value === "equation"
    ));
    expect(entity).toBeDefined();
    if (!entity) return;
    const validation = canonicalizeSuggestionProgram({
      anchor: { kind: "playhead", referenceSeconds: 5 },
      easing: "smooth",
      end: 6,
      factor: 1.5,
      kind: "scale-objects",
      start: 5,
      targetObjectIds: [entity.id],
    }, {
      capturedPlayhead: 5,
      origin: "remote-model",
      scene: imported.runtimeSceneState,
      transactionId: "scale-between-source-scales",
    });
    expect(validation.kind).toBe("valid");

    const lowered = lowerCanonicalProgramSource(scaledSource, {
      destination: null,
      program: validation.program,
      projectId: "studio-lab",
      sceneName: "MagicObjectEdits",
      sourceBindings: [{ entityId: entity.id, sourceVariable: "equation" }],
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
      viewport: { height: 360, width: 640 },
    }, { height: 8, width: 14.222 }, null);
    const roundTrip = importManimScene(lowered.source, "scene.py", "MagicObjectEdits");
    const samples = roundTrip?.runtimeSceneState.propertyChannels[`${entity.id}/scale`]?.samples ?? [];

    expect(lowered.insertedCode).toContain("equation.animate.scale(1.5)");
    expect(samples.map((sample) => sample.value)).toEqual([1, 2, 3, 1.5]);
    expect(samples.at(-1)).toMatchObject({ from: 3, relative: true, value: 1.5 });
  });
});
