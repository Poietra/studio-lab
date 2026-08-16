import { describe, expect, it } from "vitest";

import { validateEditProgram } from "../ai/edit-program-validation";
import { parseEditSuggestionResult } from "../ai/edit-suggestion-schema";
import type {
  CreateExplainedEquationSuggestion,
  EditSuggestionOperation,
  MathTexSuggestionTarget,
} from "../ai/edit-suggestions";
import { programRecord } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE, validateMotionProgramFixture } from "./fixture";
import {
  type CanonicalEditOperation,
  type CanonicalEditProgram,
  EDIT_OPERATION_VERSION,
  operationId,
  provisionalEntityId,
} from "./operations";
import { validateAndScheduleProgram } from "./program-validation";
import { canonicalizeSuggestionProgram } from "./suggestion-program";
import { appendAppliedProgram, replaceAppliedProgram } from "./transactions";

const MAXWELL_TARGET: MathTexSuggestionTarget = {
  displayLines: ["∇·E = ρ/ε₀", "∇·B = 0", "∇×E = −∂B/∂t", "∇×B = μ₀J + μ₀ε₀∂E/∂t"],
  kind: "mathtex",
  label: "Maxwell's equations",
  texParts: [
    String.raw`\begin{aligned}\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\ \nabla \cdot \mathbf{B} &= 0 \\ \nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} \\ \nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}\end{aligned}`,
  ],
};

const NEWTON_TARGET: MathTexSuggestionTarget = {
  displayLines: ["F = ma"],
  kind: "mathtex",
  label: "Newton's equation of motion",
  texParts: ["F", "=", "m", "a"],
};

function motionSuggestion(playhead = 8): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    controlOffset: { x: 0, y: 0 },
    delta: { x: 96, y: 0 },
    easing: "smooth",
    end: playhead + 1.5,
    kind: "create-motion",
    start: playhead,
    targetObjectIds: ["equation_1"],
  };
}

function maxwellTransformSuggestion(playhead = 5): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    easing: "smooth",
    end: playhead + 1.5,
    identityAfter: "target-replaces-source",
    kind: "create-transform",
    mismatchMode: "transform",
    sourceObjectId: "equation_1",
    start: playhead,
    strategy: "transform-matching-tex",
    target: MAXWELL_TARGET,
  };
}

function chainedTransformSuggestion(playhead = 5): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    execution: "sequence",
    kind: "edit-program",
    operations: [
      {
        easing: "smooth",
        end: playhead + 1,
        identityAfter: "target-replaces-source",
        kind: "create-transform",
        mismatchMode: "transform",
        sourceObjectId: "equation_1",
        start: playhead,
        strategy: "transform-matching-tex",
        target: MAXWELL_TARGET,
      },
      {
        easing: "smooth",
        end: playhead + 2,
        identityAfter: "target-replaces-source",
        kind: "create-transform",
        mismatchMode: "transform",
        sourceObjectId: "equation_1",
        start: playhead + 1,
        strategy: "transform-matching-tex",
        target: {
          displayLines: ["E = mc²"],
          kind: "mathtex",
          label: "mass-energy equivalence",
          texParts: ["E", "=", "m", "c^2"],
        },
      },
    ],
  };
}

function transformThenMotionSuggestion(playhead = 8): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    execution: "sequence",
    kind: "edit-program",
    operations: [
      {
        easing: "smooth",
        end: playhead + 1,
        identityAfter: "target-replaces-source",
        kind: "create-transform",
        mismatchMode: "transform",
        sourceObjectId: "equation_1",
        start: playhead,
        strategy: "transform-matching-tex",
        target: MAXWELL_TARGET,
      },
      {
        controlOffset: { x: 0, y: -20 },
        delta: { x: 96, y: 24 },
        easing: "smooth",
        end: playhead + 2,
        kind: "create-motion",
        start: playhead + 1,
        targetObjectIds: ["equation_1"],
      },
    ],
  };
}

function transformAndExplanationSuggestion(playhead = 8): EditSuggestionOperation {
  const start = playhead - 5;
  const end = start + 1;
  return {
    anchor: { kind: "playhead-offset", offsetSeconds: -5, referenceSeconds: playhead },
    execution: "parallel",
    kind: "edit-program",
    operations: [
      {
        easing: "smooth",
        end,
        identityAfter: "target-replaces-source",
        kind: "create-transform",
        mismatchMode: "transform",
        sourceObjectId: "equation_1",
        start,
        strategy: "transform-matching-tex",
        target: MAXWELL_TARGET,
      },
      {
        animation: "fade-in",
        end,
        kind: "create-explanation",
        objectKind: "text",
        placement: "right",
        start,
        targetObjectId: "equation_1",
        text: "電場と磁場の変化が互いを生み出します",
      },
    ],
  };
}

function explanationSuggestion(playhead = 3): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    animation: "fade-in",
    end: playhead + 1,
    kind: "create-explanation",
    objectKind: "text",
    placement: "right",
    start: playhead,
    targetObjectId: "equation_1",
    text: "電場と磁場の変化が互いを生み出します",
  };
}

function threeStepSuggestion(playhead = 5): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    execution: "sequence",
    kind: "edit-program",
    operations: [
      {
        controlOffset: { x: 0, y: 0 },
        delta: { x: 96, y: 0 },
        easing: "smooth",
        end: playhead + 1.5,
        kind: "create-motion",
        start: playhead,
        targetObjectIds: ["equation_1"],
      },
      {
        easing: "smooth",
        end: playhead + 3,
        identityAfter: "target-replaces-source",
        kind: "create-transform",
        mismatchMode: "transform",
        sourceObjectId: "equation_1",
        start: playhead + 1.5,
        strategy: "transform-matching-tex",
        target: MAXWELL_TARGET,
      },
      {
        animation: "fade-in",
        end: playhead + 4,
        kind: "create-explanation",
        objectKind: "text",
        placement: "right",
        start: playhead + 3,
        targetObjectId: "equation_1",
        text: "電場と磁場の変化が互いを生み出します",
      },
    ],
  };
}

function textTransformSuggestion(playhead = 4.42): EditSuggestionOperation {
  const start = playhead - 1;
  return {
    anchor: { kind: "playhead-offset", offsetSeconds: -1, referenceSeconds: playhead },
    easing: "smooth",
    end: start + 1.5,
    kind: "create-text-transform",
    sourceObjectId: "equation_1",
    start,
    strategy: "replacement-transform",
    text: "この式の意味を、項どうしの関係から読み解きます",
  };
}

function newEquationSuggestion(playhead = 5): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    animation: "fade-in",
    end: playhead + 1,
    kind: "create-equation",
    placement: "right",
    start: playhead,
    target: NEWTON_TARGET,
  };
}

function explainedMaxwellEquationSuggestion(playhead = 5): CreateExplainedEquationSuggestion {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    animation: "fade-in",
    end: playhead + 1.5,
    explanation: {
      placement: "right",
      text: "電場と磁場の発生と変化を四つの式で表します",
    },
    kind: "create-explained-equation",
    placement: "center",
    start: playhead,
    target: MAXWELL_TARGET,
  };
}

function explainedMaxwellThenTransitionSuggestion(playhead = 5): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    execution: "sequence",
    kind: "edit-program",
    operations: [
      {
        animation: "fade-in",
        end: playhead + 1.5,
        explanation: {
          placement: "right",
          text: "電場と磁場の発生と変化を四つの式で表します",
        },
        kind: "create-explained-equation",
        placement: "center",
        start: playhead,
        target: MAXWELL_TARGET,
      },
      {
        color: "black",
        destination: "next-scene",
        easing: "smooth",
        end: playhead + 3,
        kind: "create-scene-transition",
        shape: "circle",
        start: playhead + 1.5,
        style: "cover-reveal",
      },
    ],
  };
}

function sceneTransitionSuggestion(playhead = 5): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    color: "sky",
    destination: "next-scene",
    easing: "smooth",
    end: playhead + 1.5,
    kind: "create-scene-transition",
    shape: "diamond",
    start: playhead,
    style: "cover-reveal",
  };
}

function canonicalize(operation: EditSuggestionOperation, transactionId = "test-transaction", playhead = 8) {
  return canonicalizeSuggestionProgram(operation, {
    capturedPlayhead: playhead,
    origin: "fixture",
    scene: STUDIO_FIXTURE_SCENE,
    transactionId,
  });
}

function studioOwnedMathTexScene(program: CanonicalEditProgram, provisional: boolean) {
  const create = program.operations.find(
    (operation) => operation.kind === "CreateEntity" && operation.entity.type === "MathTex",
  );
  if (create?.kind !== "CreateEntity") throw new Error("Expected one canonical MathTex creation fixture.");
  const source = STUDIO_FIXTURE_SCENE.objectGraph.entities.equation_1!;
  const position = STUDIO_FIXTURE_SCENE.propertyChannels["equation_1/position"]!;
  return {
    ...STUDIO_FIXTURE_SCENE,
    objectGraph: {
      ...STUDIO_FIXTURE_SCENE.objectGraph,
      entities: {
        ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
        [create.entity.id]: {
          ...source,
          content: create.entity.content,
          id: create.entity.id,
          lifetime: [
            { end: create.entity.lifetime.end ?? STUDIO_FIXTURE_SCENE.duration, start: create.entity.lifetime.start },
          ],
          provisional,
          sourceIdentity: { kind: "unknown" as const, reason: "Studio-owned test entity." },
          transactionId: program.transactionId,
          type: "MathTex",
        },
      },
    },
    propertyChannels: {
      ...STUDIO_FIXTURE_SCENE.propertyChannels,
      [`${create.entity.id}/position`]: {
        ...position,
        entityId: create.entity.id,
      },
    },
  };
}

describe("Studio time and transaction invariants", () => {
  it("enforces remote motion bounds instead of relying on browser clamping", () => {
    const operation = motionSuggestion();
    expect(operation.kind).toBe("create-motion");
    if (operation.kind !== "create-motion") return;
    const remoteResult = (candidate: EditSuggestionOperation) => ({
      kind: "suggestion" as const,
      suggestion: {
        assumptions: [],
        confidence: "medium" as const,
        operation: candidate,
        provider: "remote" as const,
        summary: "remote motion",
      },
    });
    expect(parseEditSuggestionResult(remoteResult(operation)).success).toBe(true);
    expect(
      parseEditSuggestionResult(
        remoteResult({
          ...operation,
          delta: { x: 221, y: 0 },
        }),
      ).success,
    ).toBe(false);
  });

  it("normalizes bounded model strings before canonical evaluation", () => {
    const operation = maxwellTransformSuggestion();
    expect(operation.kind).toBe("create-transform");
    if (operation.kind !== "create-transform") return;
    const parsed = parseEditSuggestionResult({
      kind: "suggestion",
      suggestion: {
        assumptions: [],
        confidence: "medium",
        operation: {
          ...operation,
          target: {
            ...operation.target,
            displayLines: ["  F = ma  "],
            label: "  Newton's equation  ",
            texParts: [" F ", " = ", " m ", " a "],
          },
        },
        provider: "remote",
        summary: "normalized target",
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.kind !== "suggestion") return;
    const normalized = parsed.data.suggestion.operation;
    expect(normalized.kind).toBe("create-transform");
    if (normalized.kind !== "create-transform") return;
    expect(normalized.target.displayLines).toEqual(["F = ma"]);
    expect(normalized.target.label).toBe("Newton's equation");
    expect(normalized.target.texParts).toEqual(["F", "=", "m", "a"]);
  });

  it("captures a past-relative anchor once and keeps its evidence when the playhead moves", () => {
    const operation = transformAndExplanationSuggestion();
    const validation = canonicalize(operation);
    expect(validation.kind).toBe("valid");
    expect(validation.program.anchor.source).toEqual({
      kind: "playhead-offset",
      offsetSeconds: -5,
      referenceSeconds: 8,
    });
    expect(validation.program.anchor.resolvedSeconds).toBe(3);
    expect(validation.program.anchor.evidence).toContain("captured-playhead:8.000");
    expect(validation.program.anchor.evidence).toContain("playhead-offset:-5.000");

    const record = programRecord(validation.program, validation);
    const movedEditorContext = {
      ...createFixtureWorkingState().editorContext,
      playhead: 11,
      selection: ["label_1"],
    };
    const movedWorkingState = createFixtureWorkingState({
      editorContext: movedEditorContext,
      stagedPrograms: [record],
    });
    expect(movedWorkingState.stagedPrograms[0].program.anchor.resolvedSeconds).toBe(3);
    expect(
      movedWorkingState.stagedPrograms[0].program.operations.some(
        (candidate) => candidate.kind === "TransformContent" && candidate.sourceEntityId === "equation_1",
      ),
    ).toBe(true);
  });

  it("replaces one applied transaction without disturbing identity or source order", () => {
    const firstValidation = canonicalize(motionSuggestion(5), "first-program", 5);
    const originalValidation = canonicalize(motionSuggestion(7), "edited-program", 7);
    const lastValidation = canonicalize(motionSuggestion(9), "last-program", 9);
    const replacementOperation = motionSuggestion(7);
    expect(replacementOperation.kind).toBe("create-motion");
    if (replacementOperation.kind !== "create-motion") return;
    const replacementValidation = canonicalize(
      {
        ...replacementOperation,
        controlOffset: { x: 24, y: -16 },
        end: 9,
      },
      "edited-program",
      7,
    );
    const first = programRecord(firstValidation.program, firstValidation);
    const original = programRecord(originalValidation.program, originalValidation);
    const last = programRecord(lastValidation.program, lastValidation);
    const replacement = programRecord(replacementValidation.program, replacementValidation);

    const result = replaceAppliedProgram([first, original, last], "edited-program", replacement);

    expect(result.kind).toBe("replaced");
    if (result.kind !== "replaced") return;
    expect(result.index).toBe(1);
    expect(result.previous).toBe(original);
    expect(result.programs).toEqual([first, replacement, last]);
    expect(result.programs[0]).toBe(first);
    expect(result.programs[2]).toBe(last);
    expect(result.programs.map((record) => record.program.transactionId)).toEqual([
      "first-program",
      "edited-program",
      "last-program",
    ]);
    expect(result.programs[1].program.anchor).toEqual(original.program.anchor);
  });

  it("rejects a replacement that changes the transaction identity", () => {
    const originalValidation = canonicalize(motionSuggestion(7), "edited-program", 7);
    const replacementValidation = canonicalize(motionSuggestion(7), "different-program", 7);
    const original = programRecord(originalValidation.program, originalValidation);
    const replacement = programRecord(replacementValidation.program, replacementValidation);

    expect(replaceAppliedProgram([original], "edited-program", replacement)).toEqual({
      kind: "rejected",
      reason: "A replacement must preserve the original transaction identity.",
    });
  });
  it("rejects a replacement that would cross a neighboring source anchor", () => {
    const firstValidation = canonicalize(motionSuggestion(5), "first-program", 5);
    const originalValidation = canonicalize(motionSuggestion(7), "edited-program", 7);
    const lastValidation = canonicalize(motionSuggestion(9), "last-program", 9);
    const crossingValidation = canonicalize(motionSuggestion(10), "edited-program", 10);
    const first = programRecord(firstValidation.program, firstValidation);
    const original = programRecord(originalValidation.program, originalValidation);
    const last = programRecord(lastValidation.program, lastValidation);
    const crossing = programRecord(crossingValidation.program, crossingValidation);

    expect(replaceAppliedProgram([first, original, last], "edited-program", crossing)).toEqual({
      kind: "rejected",
      reason:
        "The replacement source anchor 10.000 would cross the next applied Program at 9.000. Applied Program source order must remain stable.",
    });
  });

  it("rejects a reverse append while keeping the first Program editable in place", () => {
    const atThreeValidation = canonicalize(motionSuggestion(3), "first-program", 3);
    const atOneValidation = canonicalize(motionSuggestion(1), "reverse-program", 1);
    const editedOperation = motionSuggestion(3);
    expect(editedOperation.kind).toBe("create-motion");
    if (editedOperation.kind !== "create-motion") return;
    const editedValidation = canonicalize(
      {
        ...editedOperation,
        controlOffset: { x: 18, y: -12 },
      },
      "first-program",
      3,
    );
    const atThree = programRecord(atThreeValidation.program, atThreeValidation);
    const atOne = programRecord(atOneValidation.program, atOneValidation);
    const edited = programRecord(editedValidation.program, editedValidation);

    const firstAppend = appendAppliedProgram([], atThree);
    expect(firstAppend.kind).toBe("appended");
    if (firstAppend.kind !== "appended") return;
    expect(appendAppliedProgram(firstAppend.programs, atOne)).toEqual({
      kind: "rejected",
      reason:
        "The new source anchor 1.000 is earlier than the latest applied Program at 3.000. Apply Programs in source order or edit the existing transaction in place.",
    });

    const replacement = replaceAppliedProgram(firstAppend.programs, "first-program", edited);
    expect(replacement.kind).toBe("replaced");
    if (replacement.kind !== "replaced") return;
    expect(replacement.programs).toEqual([edited]);
  });
});

describe("canonical operation expansion and DAG validation", () => {
  function validationProgram(
    operations: readonly CanonicalEditOperation[],
    transactionId: string,
  ): CanonicalEditProgram {
    return {
      anchor: {
        capturedPlayhead: 8,
        evidence: ["captured-playhead:8.000"],
        resolvedSeconds: 8,
        source: { kind: "playhead", referenceSeconds: 8 },
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

  it("rejects an EditProgram that declares an intent but contains no operations", () => {
    const validation = validateAndScheduleProgram(validationProgram([], "empty-program"), STUDIO_FIXTURE_SCENE);

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(expect.objectContaining({ code: "operation-count", field: "operations" }));
  });

  it("rejects two operations that produce the same provisional identity", () => {
    const transactionId = "duplicate-producer";
    const entityId = provisionalEntityId(transactionId, "created");
    const create = (index: number): CanonicalEditOperation => ({
      dependsOn: [],
      entity: { id: entityId, lifetime: { end: null, start: 8 }, type: "Text" },
      id: operationId(transactionId, `create-${index}`),
      interval: { end: 8, start: 8 },
      kind: "CreateEntity",
      provenance: { evidence: [], origin: "fixture" },
    });

    const validation = validateAndScheduleProgram(
      validationProgram([create(0), create(1)], transactionId),
      STUDIO_FIXTURE_SCENE,
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: "schema-invalid", message: expect.stringMatching(/produced more than once/i) }),
    );
  });

  it("rejects canonical scale on a TransformContent identity", () => {
    const transactionId = "canonical-scale-transform";
    const targetEntityId = provisionalEntityId(transactionId, "target");
    const transform: CanonicalEditOperation = {
      dependsOn: [],
      id: operationId(transactionId, "transform"),
      interval: { end: 9, start: 8 },
      kind: "TransformContent",
      provenance: { evidence: [], origin: "fixture" },
      replacement: { displayLines: ["F = ma"], texParts: ["F", "=", "m", "a"] },
      sourceEntityId: "equation_1",
      strategy: "transform-matching-tex",
      targetEntityId,
    };
    const scale: CanonicalEditOperation = {
      dependsOn: [transform.id],
      easing: "smooth",
      entityId: targetEntityId,
      from: 2,
      id: operationId(transactionId, "scale"),
      interval: { end: 10, start: 9 },
      key: "scale",
      kind: "AnimateProperty",
      provenance: { evidence: [], origin: "fixture" },
      to: 3,
    };

    const validation = validateAndScheduleProgram(
      validationProgram([transform, scale], transactionId),
      STUDIO_FIXTURE_SCENE,
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: "lowering-unsupported",
        message: expect.stringMatching(/Scale and TransformContent/),
        operationId: scale.id,
      }),
    );
  });

  it("rejects canonical work after a Scene boundary", () => {
    const transactionId = "canonical-boundary-first";
    const boundary: CanonicalEditOperation = {
      at: 8,
      dependsOn: [],
      destination: "next-scene",
      id: operationId(transactionId, "boundary"),
      interval: { end: 8, start: 8 },
      kind: "InsertSceneBoundary",
      provenance: { evidence: [], origin: "fixture" },
    };
    const motion: CanonicalEditOperation = {
      controlOffset: { x: 0, y: 0 },
      delta: { x: 10, y: 0 },
      dependsOn: [boundary.id],
      easing: "smooth",
      id: operationId(transactionId, "motion"),
      interval: { end: 9, start: 8 },
      kind: "CreateMotion",
      provenance: { evidence: [], origin: "fixture" },
      targetEntityIds: ["equation_1"],
    };

    const validation = validateAndScheduleProgram(
      validationProgram([boundary, motion], transactionId),
      STUDIO_FIXTURE_SCENE,
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: "lowering-unsupported",
        message: expect.stringMatching(/Scene boundary must be terminal/),
        operationId: motion.id,
      }),
    );
  });

  it("rejects mixed easing before a parallel Program can be applied", () => {
    const validation = canonicalize(
      {
        anchor: { kind: "playhead", referenceSeconds: 5 },
        execution: "parallel",
        kind: "edit-program",
        operations: [
          {
            controlOffset: { x: 0, y: 0 },
            delta: { x: 64, y: 0 },
            easing: "linear",
            end: 6,
            kind: "create-motion",
            start: 5,
            targetObjectIds: ["equation_1"],
          },
          {
            animation: "fade-in",
            end: 6,
            kind: "create-equation",
            placement: "center",
            start: 5,
            target: NEWTON_TARGET,
          },
        ],
      },
      "mixed-easing",
      5,
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "lowering-unsupported",
          field: "easing",
          message: expect.stringMatching(/must share one easing function/i),
        }),
      ]),
    );
  });

  it("keeps transform and explanation atomic and targets the post-transform identity", () => {
    const validation = canonicalize(transformAndExplanationSuggestion());
    expect(validation.kind).toBe("valid");
    expect(validation.program.intentCount).toBe(2);
    const transform = validation.program.operations.find((operation) => operation.kind === "TransformContent");
    const relation = validation.program.operations.find((operation) => operation.kind === "SetRelation");
    const presence = validation.program.operations.find((operation) => operation.kind === "ChangePresence");
    expect(transform?.kind).toBe("TransformContent");
    expect(relation?.kind).toBe("SetRelation");
    if (transform?.kind !== "TransformContent" || relation?.kind !== "SetRelation") return;
    expect(relation.targetEntityId).toBe(transform.targetEntityId);
    expect(relation.mode).toBe("snapshot");
    expect(relation.dependsOn).toContain(transform.id);
    expect(presence?.kind === "ChangePresence" && presence.persistent).toBe(true);
    expect(
      validation.program.schedule.edges.some(
        (edge) => edge.from === transform.id && edge.to === relation.id && edge.reason === "identity",
      ),
    ).toBe(true);
  });

  it("rebinds sequential transforms into one provisional identity chain", () => {
    const operation = chainedTransformSuggestion();
    expect(operation.kind).toBe("edit-program");
    if (operation.kind !== "edit-program") return;
    expect(
      validateEditProgram(operation, {
        capturedPlayhead: 5,
        objects: Object.values(STUDIO_FIXTURE_SCENE.objectGraph.entities).map((entity) => ({
          id: entity.id,
          lifetimes: entity.lifetime,
          type: entity.type,
        })),
        sceneDuration: STUDIO_FIXTURE_SCENE.duration,
        selectedObjectIds: ["equation_1"],
      }).kind,
    ).toBe("valid");

    const validation = canonicalize(operation, "transform-chain", 5);
    expect(validation.kind).toBe("valid");
    const transforms = validation.program.operations.filter((candidate) => candidate.kind === "TransformContent");
    expect(transforms).toHaveLength(2);
    const [first, second] = transforms;
    if (first?.kind !== "TransformContent" || second?.kind !== "TransformContent") return;
    expect(first.sourceEntityId).toBe("equation_1");
    expect(second.sourceEntityId).toBe(first.targetEntityId);
    expect(second.dependsOn).toContain(first.id);
    expect(validation.program.schedule.edges).toContainEqual({
      from: first.id,
      reason: "identity",
      to: second.id,
    });
  });

  it("rebinds motion after a transform to the replacement identity", () => {
    const validation = canonicalize(transformThenMotionSuggestion(), "transform-then-motion", 8);
    expect(validation.kind).toBe("valid");
    const transform = validation.program.operations.find((operation) => operation.kind === "TransformContent");
    const motion = validation.program.operations.find((operation) => operation.kind === "CreateMotion");
    expect(transform?.kind).toBe("TransformContent");
    expect(motion?.kind).toBe("CreateMotion");
    if (transform?.kind !== "TransformContent" || motion?.kind !== "CreateMotion") return;

    expect(motion.targetEntityIds).toEqual([transform.targetEntityId]);
    expect(motion.dependsOn).toContain(transform.id);
    expect(validation.program.schedule.edges).toContainEqual({
      from: transform.id,
      reason: "explicit",
      to: motion.id,
    });
  });

  it("preserves all three supported clauses as three leaf intents", () => {
    const operation = threeStepSuggestion();
    expect(operation.kind).toBe("edit-program");
    if (operation.kind !== "edit-program") return;
    expect(operation.operations.map((step) => step.kind)).toEqual([
      "create-motion",
      "create-transform",
      "create-explanation",
    ]);
    const validation = canonicalize(operation, "three-intents", 5);
    expect(validation.kind).toBe("valid");
    expect(validation.program.intentCount).toBe(3);
    expect(new Set(validation.program.operations.map((candidate) => candidate.kind))).toEqual(
      new Set(["ChangePresence", "CreateEntity", "CreateMotion", "SetRelation", "TransformContent"]),
    );
  });

  it("returns one focused execution issue for conflicting parallel channel writes", () => {
    const base = canonicalize(motionSuggestion(), "conflict-base").program;
    const interval = { end: 6, start: 5 };
    const conflictProgram: CanonicalEditProgram = {
      ...base,
      anchor: { ...base.anchor, resolvedSeconds: 5, source: { kind: "playhead", referenceSeconds: 5 } },
      intentCount: 2,
      operations: [
        {
          dependsOn: [],
          id: operationId("parallel-conflict", "position-a"),
          interval,
          kind: "SetProperty",
          entityId: "equation_1",
          key: "position",
          provenance: { evidence: [], origin: "fixture" },
          value: { x: 10, y: 0 },
        },
        {
          dependsOn: [],
          id: operationId("parallel-conflict", "position-b"),
          interval,
          kind: "SetProperty",
          entityId: "equation_1",
          key: "position",
          provenance: { evidence: [], origin: "fixture" },
          value: { x: 20, y: 0 },
        },
      ],
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [] },
      transactionId: "parallel-conflict",
      version: EDIT_OPERATION_VERSION,
    };
    const validation = validateAndScheduleProgram(conflictProgram, STUDIO_FIXTURE_SCENE);
    const executionIssues = validation.issues.filter((issue) => issue.field === "execution");
    expect(validation.kind).toBe("invalid");
    expect(executionIssues).toHaveLength(1);
    expect(executionIssues[0].message).toContain("Choose their order");
  });

  it("does not reverse a dependency or add a cycle when both operations read and write one channel", () => {
    const base = canonicalize(motionSuggestion(5), "read-write-conflict", 5).program;
    const first = base.operations[0];
    expect(first.kind).toBe("CreateMotion");
    if (first.kind !== "CreateMotion") return;
    const second = {
      ...first,
      delta: { x: 24, y: 0 },
      id: operationId("read-write-conflict", "motion-second"),
    };
    const validation = validateAndScheduleProgram(
      {
        ...base,
        intentCount: 2,
        operations: [first, second],
        requestedExecution: "parallel",
      },
      STUDIO_FIXTURE_SCENE,
    );
    expect(validation.kind).toBe("invalid");
    expect(validation.issues.filter((issue) => issue.field === "execution")).toHaveLength(1);
    expect(validation.issues.some((issue) => issue.code === "cycle")).toBe(false);
    expect(validation.program.schedule.edges).toContainEqual({
      from: first.id,
      reason: "write-conflict",
      to: second.id,
    });
    expect(validation.program.schedule.edges).not.toContainEqual(
      expect.objectContaining({
        from: second.id,
        to: first.id,
      }),
    );
  });
});

describe("Studio semantic model", () => {
  it("resolves immediately-before once and preserves the replacement identity", () => {
    const operation = textTransformSuggestion();
    expect(operation.kind).toBe("create-text-transform");
    if (operation.kind !== "create-text-transform") return;
    const validation = canonicalize(operation, "text-transform", 4.42);
    expect(validation.kind).toBe("valid");
    expect(validation.program.anchor.source).toEqual({
      kind: "playhead-offset",
      offsetSeconds: -1,
      referenceSeconds: 4.42,
    });
    expect(validation.program.anchor.resolvedSeconds).toBeCloseTo(3.42);
    const transform = validation.program.operations.find((candidate) => candidate.kind === "TransformContent");
    expect(transform?.kind).toBe("TransformContent");
    if (transform?.kind !== "TransformContent") return;
    expect(transform?.sourceEntityId).toBe("equation_1");
    expect(transform?.targetType).toBe("Text");
    expect(transform?.replacement.text).toContain("この式の意味");
  });

  it("creates a canonical MathTex Program without requiring selection", () => {
    const operation = newEquationSuggestion();
    expect(operation.kind).toBe("create-equation");
    if (operation.kind !== "create-equation") return;
    expect(operation.target.displayLines).toEqual(["F = ma"]);
    const validation = canonicalize(operation, "new-equation", 5);
    expect(validation.kind).toBe("valid");
    expect(validation.program.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: expect.objectContaining({
            content: expect.objectContaining({ displayLines: ["F = ma"] }),
            type: "MathTex",
          }),
          kind: "CreateEntity",
        }),
        expect.objectContaining({ key: "position", kind: "SetProperty", value: { x: 480, y: 180 } }),
        expect.objectContaining({ effect: "fade-in", kind: "ChangePresence" }),
      ]),
    );
  });

  it("creates a new equation and explanation as one atomic program", () => {
    const operation = explainedMaxwellEquationSuggestion();
    expect(
      parseEditSuggestionResult({
        kind: "suggestion",
        suggestion: {
          assumptions: [],
          confidence: "medium",
          operation,
          provider: "remote",
          summary: "Add Maxwell equations with an explanation.",
        },
      }).success,
    ).toBe(true);
    const validation = canonicalize(operation, "explained-maxwell", 5);
    expect(validation.kind).toBe("valid");
    expect(validation.program.intentCount).toBe(2);
    const equation = validation.program.operations.find(
      (candidate) => candidate.kind === "CreateEntity" && candidate.entity.type === "MathTex",
    );
    const explanation = validation.program.operations.find(
      (candidate) => candidate.kind === "CreateEntity" && candidate.entity.type === "Text",
    );
    const relation = validation.program.operations.find((candidate) => candidate.kind === "SetRelation");
    expect(equation?.kind).toBe("CreateEntity");
    expect(explanation?.kind).toBe("CreateEntity");
    expect(relation?.kind).toBe("SetRelation");
    if (equation?.kind !== "CreateEntity" || explanation?.kind !== "CreateEntity" || relation?.kind !== "SetRelation")
      return;
    expect(relation.sourceEntityId).toBe(explanation.entity.id);
    expect(relation.targetEntityId).toBe(equation.entity.id);

    expect(equation.entity.content).toEqual(expect.objectContaining({ displayLines: MAXWELL_TARGET.displayLines }));
    expect(explanation.entity.content).toEqual(expect.objectContaining({ text: operation.explanation.text }));
  });

  it("creates an explained Maxwell equation and then transitions Scene in one transaction", () => {
    const operation = explainedMaxwellThenTransitionSuggestion();
    expect(operation.kind).toBe("edit-program");
    if (operation.kind !== "edit-program") return;
    expect(
      parseEditSuggestionResult({
        kind: "suggestion",
        suggestion: {
          assumptions: [],
          confidence: "medium",
          operation,
          provider: "remote",
          summary: "Add Maxwell equations and then transition to the next Scene.",
        },
      }).success,
    ).toBe(true);
    expect(
      validateEditProgram(operation, {
        capturedPlayhead: 5,
        objects: [],
        sceneDuration: 12,
        selectedObjectIds: [],
      }).kind,
    ).toBe("valid");

    const validation = canonicalize(operation, "maxwell-then-transition", 5);
    expect(validation.kind).toBe("valid");
    expect(validation.program.intentCount).toBe(3);
    expect(validation.program.loweringStatus).toBe("supported");
    expect(validation.program.schedule.mode).toBe("sequence");
    expect(
      validation.program.operations.every((candidate) => candidate.id.startsWith("tx:maxwell-then-transition/")),
    ).toBe(true);
    expect(
      validation.program.operations.some(
        (candidate) => candidate.kind === "CreateEntity" && candidate.entity.type === "MathTex",
      ),
    ).toBe(true);
    expect(
      validation.program.operations.some(
        (candidate) => candidate.kind === "CreateEntity" && candidate.entity.type === "Text",
      ),
    ).toBe(true);
    expect(
      validation.program.operations.find((candidate) => candidate.kind === "InsertSceneBoundary")?.interval.start,
    ).toBe(7.25);

    expect(
      validation.program.operations.find(
        (candidate) => candidate.kind === "CreateEntity" && candidate.entity.type === "MathTex",
      ),
    ).toEqual(
      expect.objectContaining({
        entity: expect.objectContaining({ content: expect.objectContaining({ label: MAXWELL_TARGET.label }) }),
      }),
    );
    expect(
      validation.program.operations.find(
        (candidate) => candidate.kind === "CreateEntity" && candidate.entity.type === "Text",
      ),
    ).toEqual(
      expect.objectContaining({
        entity: expect.objectContaining({
          content: expect.objectContaining({ text: expect.stringContaining("電場と磁場") }),
        }),
      }),
    );
    expect(validation.program.operations.find((candidate) => candidate.kind === "InsertSceneBoundary")).toEqual(
      expect.objectContaining({ interval: expect.objectContaining({ start: 7.25 }) }),
    );
  });

  it("accepts an applied created entity as the target of the next direct edit", () => {
    const operation = newEquationSuggestion();
    expect(operation.kind).toBe("create-equation");
    if (operation.kind !== "create-equation") return;
    const creation = canonicalize(operation, "editable-equation", 5);
    expect(creation.kind).toBe("valid");
    const createdScene = studioOwnedMathTexScene(creation.program, false);
    const createdId = creation.program.operations.find((candidate) => candidate.kind === "CreateEntity")?.entity.id;
    expect(createdId).toBeDefined();
    if (!createdId) return;

    const movement = validateMotionProgramFixture({
      capturedPlayhead: operation.end,
      controlOffset: { x: 0, y: 0 },
      delta: { x: 64, y: 0 },
      interval: { end: operation.end + 1, start: operation.end },
      scene: createdScene,
      targetEntityIds: [createdId],
      transactionId: "move-created-equation",
    });
    expect(movement.issues).toEqual([]);
    expect(movement.kind).toBe("valid");
    expect(movement.program.operations).toEqual([
      expect.objectContaining({
        kind: "CreateMotion",
        targetEntityIds: [createdId],
      }),
    ]);
  });

  it("keeps a created entity transaction-local until its creation is applied", () => {
    const operation = newEquationSuggestion();
    expect(operation.kind).toBe("create-equation");
    if (operation.kind !== "create-equation") return;
    const creation = canonicalize(operation, "preview-equation", 5);
    const previewScene = studioOwnedMathTexScene(creation.program, true);
    const createdId = creation.program.operations.find((candidate) => candidate.kind === "CreateEntity")?.entity.id;
    expect(createdId).toBeDefined();
    if (!createdId) return;

    const movement = validateMotionProgramFixture({
      capturedPlayhead: operation.end,
      controlOffset: { x: 0, y: 0 },
      delta: { x: 64, y: 0 },
      interval: { end: operation.end + 1, start: operation.end },
      scene: previewScene,
      targetEntityIds: [createdId],
      transactionId: "move-unapplied-equation",
    });
    expect(movement.kind).toBe("invalid");
    expect(movement.issues.some((issue) => issue.code === "provisional-id-invalid")).toBe(true);
  });

  it("keeps unsupported Text creation explicit instead of using a second evaluator", () => {
    const validation = canonicalize(explanationSuggestion(), "projection-program", 3);
    expect(
      validation.program.operations.find(
        (candidate) => candidate.kind === "CreateEntity" && candidate.entity.type === "Text",
      ),
    ).toEqual(
      expect.objectContaining({
        entity: expect.objectContaining({ id: expect.stringMatching(/^tx:projection-program\/entity:explanation-/) }),
      }),
    );
    expect(validation.program.operations.some((candidate) => candidate.kind === "SetRelation")).toBe(true);
  });

  it("keeps Scene-level transition creation explicit until Rust supports its overlay", () => {
    const operation = sceneTransitionSuggestion();
    expect(operation.kind).toBe("create-scene-transition");
    if (operation.kind !== "create-scene-transition") return;
    expect(operation.shape).toBe("diamond");
    expect(operation.color).toBe("sky");
    const validation = canonicalize(operation, "scene-transition", 5);
    expect(validation.kind).toBe("valid");
    expect(
      validation.program.operations.find(
        (candidate) => candidate.kind === "CreateEntity" && candidate.entity.type === "TransitionOverlay:diamond:sky",
      ),
    ).toEqual(expect.objectContaining({ entity: expect.objectContaining({ lifetime: { end: 6.5, start: 5 } }) }));
    expect(validation.program.operations.find((candidate) => candidate.kind === "InsertSceneBoundary")).toEqual(
      expect.objectContaining({ destination: "next-scene", interval: { end: 5.75, start: 5.75 } }),
    );
  });

  it("rejects destructive transforms whose source identity is Unknown", () => {
    const operation = maxwellTransformSuggestion();
    const unknownScene = {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          equation_1: {
            ...STUDIO_FIXTURE_SCENE.objectGraph.entities.equation_1,
            sourceIdentity: { kind: "unknown" as const, reason: "Static/runtime rematching is unresolved." },
          },
        },
      },
    };
    const validation = canonicalizeSuggestionProgram(operation, {
      capturedPlayhead: 5,
      origin: "fixture",
      scene: unknownScene,
      transactionId: "unknown-identity",
    });
    expect(validation.kind).toBe("invalid");
    expect(validation.issues.some((issue) => issue.code === "identity-unknown")).toBe(true);
  });
});
