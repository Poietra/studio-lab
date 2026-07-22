import { describe, expect, it } from "vitest";

import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import {
  EDIT_OPERATION_VERSION,
  operationId,
  provisionalEntityId,
  type CanonicalEditOperation,
  type CanonicalEditProgram,
} from "./operations";
import { validateAndScheduleProgram } from "./program-validation";

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
