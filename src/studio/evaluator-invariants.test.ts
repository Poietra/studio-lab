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
import { normalizePositionSamples } from "./property-sampling";
import { createDirectManipulationMotionProgram } from "./suggestion-program";

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
    expect(validation.issues).toContainEqual(expect.objectContaining({
      code: "operation-count",
      field: "operations",
    }));
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
    const validation = validateAndScheduleProgram(
      programWith([operation], transactionId),
      STUDIO_FIXTURE_SCENE,
    );
    expect(validation.kind).toBe("valid");

    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    const equation = projectProposedState(proposed, 9).canvas.entities.find((entity) => (
      entity.id === "equation_1"
    ));

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
      control: { x: 190, y: 135 },
      from: { x: 170, y: 135 },
      interval: { end: 2, start: 1 },
      relative: true,
      value: { x: 210, y: 155 },
    });
    expect(shifted).toMatchObject({
      from: { x: 210, y: 155 },
      interval: { end: 3, start: 2 },
      relative: true,
      value: { x: expect.closeTo(255, 2), y: 155 },
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
    expect(validation.issues).toContainEqual(expect.objectContaining({
      code: "schema-invalid",
      message: expect.stringMatching(/produced more than once/i),
    }));
  });
});
