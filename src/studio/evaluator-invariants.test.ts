import { describe, expect, it } from "vitest";

import { importManimScene } from "../render-pipeline/source-import";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import { STUDIO_STATE_VERSION, type WorkingState } from "./model";
import {
  EDIT_OPERATION_VERSION,
  operationId,
  provisionalEntityId,
  type CanonicalEditOperation,
  type CanonicalEditProgram,
} from "./operations";
import { validateAndScheduleProgram } from "./program-validation";
import { normalizePositionSamples, normalizeScaleSamples } from "./property-sampling";
import {
  createDirectManipulationMotionProgram,
  canonicalizeSuggestionProgram,
} from "./suggestion-program";

function programWith(
  operations: readonly CanonicalEditOperation[],
  transactionId: string,
  anchor = 8,
): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead", referenceSeconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "illustrative",
    operations,
    provenance: { evidence: [], origin: "fixture" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: operations.map((operation) => operation.id) },
    transactionId,
    version: EDIT_OPERATION_VERSION,
  };
}

describe("Studio evaluator invariants", () => {
  it("rejects an EditProgram that declares an intent but contains no operations", () => {
    const validation = validateAndScheduleProgram(programWith([], "empty-program"), STUDIO_FIXTURE_SCENE);

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: "operation-count",
        field: "operations",
      }),
    );
  });

  it("samples an omitted animation origin from the channel at its start", () => {
    const transactionId = "inferred-animation-origin";
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      easing: "smooth",
      entityId: "equation_1",
      id: operationId(transactionId, "move"),
      interval: { end: 10, start: 8 },
      key: "position",
      kind: "AnimateProperty",
      provenance: { evidence: [], origin: "fixture" },
      to: { x: 484, y: 146 },
    };
    const validation = validateAndScheduleProgram(programWith([operation], transactionId), STUDIO_FIXTURE_SCENE);
    expect(validation.kind).toBe("valid");

    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );
    const equation = projectProposedState(proposed, 9).canvas.entities.find((entity) => entity.id === "equation_1");

    expect(equation?.position).toEqual({ x: 434, y: 146 });
  });

  it("rebases a source shift after a motion inserted at its anchor", () => {
    const source = `from manim import *

class Moving(Scene):
    def construct(self):
        dot = Dot()
        self.add(dot)
        self.wait(1)
        # poietra:anchor 1.000
        self.play(dot.animate.shift(RIGHT), run_time=1)
`;
    const imported = importManimScene(source, "moving.py", "Moving");
    expect(imported).not.toBeNull();
    if (!imported) return;
    const entityId = "source:moving.py#Moving:dot";
    const validation = createDirectManipulationMotionProgram({
      capturedPlayhead: 1,
      controlOffset: { x: 0, y: -10 },
      delta: { x: 40, y: 20 },
      interval: { end: 2, start: 1 },
      scene: imported.runtimeSceneState,
      targetEntityIds: [entityId],
      transactionId: "insert-before-source-motion",
    });
    expect(validation.kind).toBe("valid");
    const workingState: WorkingState = {
      appliedPrograms: [],
      editorContext: {
        activeSceneId: imported.sceneId,
        playhead: 1,
        selection: [entityId],
        version: STUDIO_STATE_VERSION,
        viewport: { height: 360, width: 640 },
      },
      runtimeSceneState: imported.runtimeSceneState,
      sourceSnapshot: {
        configId: "test",
        hash: imported.sourceHash,
        sourceId: "moving.py",
        version: STUDIO_STATE_VERSION,
      },
      stagedPrograms: [programRecord(validation.program, validation)],
      staticSemanticState: imported.staticSemanticState,
      version: STUDIO_STATE_VERSION,
    };

    const proposed = evaluateWorkingState(workingState);
    const samples = proposed.evaluatedScene.propertyChannels[`${entityId}/position`]?.samples ?? [];
    const inserted = samples.find((sample) => sample.operationId?.includes("motion-0"));
    const shifted = samples.find((sample) => sample.provenanceId.includes(":motion:"));
    expect(inserted).toMatchObject({
      control: { x: 340, y: 180 },
      from: { x: 320, y: 180 },
      interval: { end: 2, start: 1 },
      relative: true,
      value: { x: 360, y: 200 },
    });
    expect(shifted).toMatchObject({
      from: { x: 360, y: 200 },
      interval: { end: 3, start: 2 },
      relative: true,
      value: { x: expect.closeTo(405, 2), y: 200 },
    });
  });

  it("lets exact samples reset the base for later relative motion", () => {
    const samples = normalizePositionSamples([
      {
        interval: { end: 10, start: 0 },
        kind: "exact",
        provenanceId: "initial",
        value: { x: 10, y: 20 },
      },
      {
        interval: { end: 2, start: 2 },
        kind: "exact",
        operationId: "set-position",
        provenanceId: "set-position/provenance",
        value: { x: 100, y: 200 },
      },
      {
        control: { x: 15, y: 20 },
        easing: "smooth",
        from: { x: 10, y: 20 },
        interval: { end: 3, start: 2 },
        kind: "animated",
        provenanceId: "imported-shift",
        relative: true,
        value: { x: 20, y: 20 },
      },
    ]);

    expect(samples.map((sample) => sample.provenanceId)).toEqual([
      "initial",
      "set-position/provenance",
      "imported-shift",
    ]);
    expect(samples.at(-1)).toMatchObject({
      control: { x: 105, y: 200 },
      from: { x: 100, y: 200 },
      value: { x: 110, y: 200 },
    });
  });

  it("sorts and rebases relative scale samples around an inserted absolute scale", () => {
    const samples = normalizeScaleSamples([
      {
        interval: { end: 10, start: 0 },
        kind: "exact",
        knowledge: { kind: "known", value: 1 },
        provenanceId: "initial",
        value: 1,
      },
      {
        easing: "smooth",
        from: 1,
        interval: { end: 8, start: 7 },
        kind: "animated",
        knowledge: { kind: "known", value: 0.5 },
        provenanceId: "later-source-half",
        relative: true,
        value: 0.5,
      },
      {
        easing: "smooth",
        from: 1,
        interval: { end: 3, start: 2 },
        kind: "animated",
        knowledge: { kind: "known", value: 2 },
        provenanceId: "earlier-source-double",
        relative: true,
        value: 2,
      },
      {
        easing: "smooth",
        from: 2,
        interval: { end: 6, start: 5 },
        kind: "animated",
        operationId: "magic-scale",
        provenanceId: "magic-scale/provenance",
        value: 3,
      },
    ]);

    expect(samples.map((sample) => sample.provenanceId)).toEqual([
      "initial",
      "earlier-source-double",
      "magic-scale/provenance",
      "later-source-half",
    ]);
    expect(samples.at(-1)).toMatchObject({ from: 3, value: 1.5 });
  });

  it("previews source scales before and after Magic scale with Manim's multiplicative semantics", () => {
    const source = `from manim import *

class Scaling(Scene):
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
    const imported = importManimScene(source, "scaling.py", "Scaling");
    expect(imported).not.toBeNull();
    if (!imported) return;
    const entityId = "source:scaling.py#Scaling:equation";
    const validation = canonicalizeSuggestionProgram({
      anchor: { kind: "playhead", referenceSeconds: 5 },
      easing: "smooth",
      end: 6,
      factor: 1.5,
      kind: "scale-objects",
      start: 5,
      targetObjectIds: [entityId],
    }, {
      capturedPlayhead: 5,
      origin: "remote-model",
      scene: imported.runtimeSceneState,
      transactionId: "scale-between-source-scales",
    });
    expect(validation.kind).toBe("valid");
    const workingState: WorkingState = {
      appliedPrograms: [],
      editorContext: {
        activeSceneId: imported.sceneId,
        playhead: 5,
        selection: [entityId],
        version: STUDIO_STATE_VERSION,
        viewport: { height: 360, width: 640 },
      },
      runtimeSceneState: imported.runtimeSceneState,
      sourceSnapshot: {
        configId: "test",
        hash: imported.sourceHash,
        sourceId: "scaling.py",
        version: STUDIO_STATE_VERSION,
      },
      stagedPrograms: [programRecord(validation.program, validation)],
      staticSemanticState: imported.staticSemanticState,
      version: STUDIO_STATE_VERSION,
    };

    const proposed = evaluateWorkingState(workingState);
    const scaleSamples = proposed.evaluatedScene.propertyChannels[`${entityId}/scale`]?.samples ?? [];
    expect(scaleSamples.map((sample) => sample.provenanceId)).toEqual([
      expect.stringMatching(/:equation:scale$/),
      expect.stringMatching(/:equation:scale:\d+$/),
      expect.stringMatching(/scale-0-0\/provenance$/),
      expect.stringMatching(/:equation:scale:\d+$/),
    ]);
    expect(scaleSamples.at(-1)).toMatchObject({ from: 3, relative: true, value: 1.5 });
    expect(projectProposedState(proposed, 8.5).canvas.entities.find((entity) => (
      entity.id === entityId
    ))?.scale).toBeCloseTo(1.5);
  });

  it("rejects two operations that produce the same provisional identity", () => {
    const transactionId = "duplicate-producer";
    const entityId = provisionalEntityId(transactionId, "created");
    const create = (index: number): CanonicalEditOperation => ({
      dependsOn: [],
      entity: {
        id: entityId,
        lifetime: { end: null, start: 8 },
        type: "Text",
      },
      id: operationId(transactionId, `create-${index}`),
      interval: { end: 8, start: 8 },
      kind: "CreateEntity",
      provenance: { evidence: [], origin: "fixture" },
    });

    const validation = validateAndScheduleProgram(
      programWith([create(0), create(1)], transactionId),
      STUDIO_FIXTURE_SCENE,
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: "schema-invalid",
        message: expect.stringMatching(/produced more than once/i),
      }),
    );
  });
});
