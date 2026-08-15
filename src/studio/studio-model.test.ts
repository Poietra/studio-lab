import { describe, expect, it } from "vitest";

import { validateEditProgram } from "../ai/edit-program-validation";
import { parseEditSuggestionResult } from "../ai/edit-suggestion-schema";
import type {
  CreateExplainedEquationSuggestion,
  EditSuggestionOperation,
  MathTexSuggestionTarget,
} from "../ai/edit-suggestions";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE, validateMotionProgramFixture } from "./fixture";
import { type CanonicalEditProgram, EDIT_OPERATION_VERSION, operationId } from "./operations";
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

function cameraFocusSuggestion(playhead = 4.42): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: playhead },
    easing: "smooth",
    emphasisScale: 1.12,
    end: playhead + 1.5,
    kind: "create-camera-focus",
    start: playhead,
    targetObjectIds: ["equation_1"],
    zoomScale: 1.35,
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

describe("one ProposedState feeds every Studio projection", () => {
  it("evaluates camera focus and selected-object emphasis through shared channels", () => {
    const operation = cameraFocusSuggestion();
    expect(operation.kind).toBe("create-camera-focus");
    if (operation.kind !== "create-camera-focus") return;
    const validation = canonicalize(operation, "camera-focus", 4.42);
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );
    const projection = projectProposedState(proposed, operation.end);
    const equation = projection.canvas.entities.find((entity) => entity.id === "equation_1");
    expect(projection.camera.scale).toBeCloseTo(1.35);
    expect(equation?.scale).toBeCloseTo(1.12);
    expect(projection.camera.sampleId).toBe(projection.canvas.sampleId);
  });

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

  it("creates a visible provisional MathTex without requiring selection", () => {
    const operation = newEquationSuggestion();
    expect(operation.kind).toBe("create-equation");
    if (operation.kind !== "create-equation") return;
    expect(operation.target.displayLines).toEqual(["F = ma"]);
    const validation = canonicalize(operation, "new-equation", 5);
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        editorContext: { ...createFixtureWorkingState().editorContext, playhead: 5, selection: [] },
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );
    const projection = projectProposedState(proposed, operation.end);
    const equation = projection.canvas.entities.find(
      (entity) => entity.present && entity.provisional && entity.type === "MathTex",
    );
    expect(equation?.content?.displayLines).toEqual(["F = ma"]);
    expect(equation?.position).toEqual({ x: 480, y: 180 });
    expect(projection.objectList.entities.find((entity) => entity.id === equation?.id)).toBe(equation);
    expect(projection.timeline.events.some((event) => event.transactionId === "new-equation")).toBe(true);
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

    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );
    const projection = projectProposedState(proposed, operation.end);
    expect(
      projection.canvas.entities.find((entity) => entity.id === equation.entity.id)?.content?.displayLines,
    ).toEqual(MAXWELL_TARGET.displayLines);
    expect(projection.canvas.entities.find((entity) => entity.id === explanation.entity.id)?.content?.text).toBe(
      operation.explanation.text,
    );
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

    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );
    const beforeTransition = projectProposedState(proposed, 6.5);
    expect(
      beforeTransition.canvas.entities.some(
        (entity) => entity.present && entity.type === "MathTex" && entity.content?.label === MAXWELL_TARGET.label,
      ),
    ).toBe(true);
    expect(
      beforeTransition.canvas.entities.some(
        (entity) => entity.present && entity.type === "Text" && entity.content?.text?.includes("電場と磁場"),
      ),
    ).toBe(true);
    expect(
      proposed.evaluatedScene.eventTrack.events.some((event) => event.kind === "scene-boundary" && event.at === 7.25),
    ).toBe(true);
  });

  it("accepts an applied created entity as the target of the next direct edit", () => {
    const operation = newEquationSuggestion();
    expect(operation.kind).toBe("create-equation");
    if (operation.kind !== "create-equation") return;
    const creation = canonicalize(operation, "editable-equation", 5);
    expect(creation.kind).toBe("valid");
    const creationRecord = programRecord(creation.program, creation);
    const createdState = evaluateWorkingState(
      createFixtureWorkingState({
        appliedPrograms: [creationRecord],
      }),
    );
    const createdId = creation.program.operations.find((candidate) => candidate.kind === "CreateEntity")?.entity.id;
    expect(createdId).toBeDefined();
    if (!createdId) return;

    const movement = validateMotionProgramFixture({
      capturedPlayhead: operation.end,
      controlOffset: { x: 0, y: 0 },
      delta: { x: 64, y: 0 },
      interval: { end: operation.end + 1, start: operation.end },
      scene: createdState.evaluatedScene,
      targetEntityIds: [createdId],
      transactionId: "move-created-equation",
    });
    expect(movement.issues).toEqual([]);
    expect(movement.kind).toBe("valid");
    const moved = evaluateWorkingState(
      createFixtureWorkingState({
        appliedPrograms: [creationRecord, programRecord(movement.program, movement)],
      }),
    );
    const movementEvent = moved.evaluatedScene.eventTrack.events.find(
      (event) => event.transactionId === movement.program.transactionId && event.kind === "operation",
    );
    expect(movementEvent?.interval).toEqual({ end: 8, start: 7 });
    const projected = projectProposedState(moved, movementEvent?.interval?.end ?? 8);
    expect(projected.canvas.entities.find((entity) => entity.id === createdId)?.position).toEqual({
      x: 544,
      y: 180,
    });
  });

  it("keeps a created entity transaction-local until its creation is applied", () => {
    const operation = newEquationSuggestion();
    expect(operation.kind).toBe("create-equation");
    if (operation.kind !== "create-equation") return;
    const creation = canonicalize(operation, "preview-equation", 5);
    const creationRecord = programRecord(creation.program, creation);
    const previewState = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [creationRecord],
      }),
    );
    const createdId = creation.program.operations.find((candidate) => candidate.kind === "CreateEntity")?.entity.id;
    expect(createdId).toBeDefined();
    if (!createdId) return;

    const movement = validateMotionProgramFixture({
      capturedPlayhead: operation.end,
      controlOffset: { x: 0, y: 0 },
      delta: { x: 64, y: 0 },
      interval: { end: operation.end + 1, start: operation.end },
      scene: previewState.evaluatedScene,
      targetEntityIds: [createdId],
      transactionId: "move-unapplied-equation",
    });
    expect(movement.kind).toBe("invalid");
    expect(movement.issues.some((issue) => issue.code === "provisional-id-invalid")).toBe(true);
  });

  it("shows a provisional Text consistently on canvas, object list, timeline and playback", () => {
    const validation = canonicalize(explanationSuggestion(), "projection-program", 3);
    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );
    const projection = projectProposedState(proposed, 3.5);
    const explanation = projection.canvas.entities.find((entity) => entity.type === "Text" && entity.provisional);
    expect(explanation?.id).toMatch(/^tx:projection-program\/entity:explanation-/);
    expect(projection.objectList.entities).toBe(projection.canvas.entities);
    expect(projection.semanticThumbnail.entities).toBe(projection.canvas.entities);
    expect(projection.workingPlayback.entities).toBe(projection.canvas.entities);
    expect(projection.objectList.sampleId).toBe(projection.canvas.sampleId);
    expect(projection.inspector.sampleId).toBe(projection.canvas.sampleId);
    expect(projection.semanticThumbnail.sampleId).toBe(projection.canvas.sampleId);
    expect(projection.sourcePreview.sampleId).toBe(projection.canvas.sampleId);
    expect(projection.timeline.sampleId).toBe(projection.canvas.sampleId);
    expect(projection.workingPlayback.sampleId).toBe(projection.canvas.sampleId);
    expect(projection.timeline.events.some((event) => event.transactionId === "projection-program")).toBe(true);
    expect(projection.timeline.objectTracks).toContainEqual(
      expect.objectContaining({
        entityId: explanation?.id,
        provisional: true,
        type: "Text",
      }),
    );
    expect(
      proposed.evaluatedScene.constraintGraph.constraints.some(
        (constraint) => constraint.sourceEntityId === explanation?.id && constraint.mode === "snapshot",
      ),
    ).toBe(true);
  });

  it("creates a Scene-level transition without selection and exposes the full-cover boundary", () => {
    const operation = sceneTransitionSuggestion();
    expect(operation.kind).toBe("create-scene-transition");
    if (operation.kind !== "create-scene-transition") return;
    expect(operation.shape).toBe("diamond");
    expect(operation.color).toBe("sky");
    const validation = canonicalize(operation, "scene-transition", 5);
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        editorContext: { ...createFixtureWorkingState().editorContext, playhead: 5, selection: [] },
        stagedPrograms: [programRecord(validation.program, validation)],
      }),
    );
    const boundary = proposed.evaluatedScene.eventTrack.events.find((event) => event.kind === "scene-boundary");
    expect(boundary?.at).toBe(5.75);
    expect(boundary?.label).toBe("Full-cover Scene boundary");
    const projection = projectProposedState(proposed, 5.25);
    const overlay = projection.canvas.entities.find((entity) => entity.type === "TransitionOverlay:diamond:sky");
    expect(overlay).toBeDefined();
    expect(proposed.evaluatedScene.objectGraph.entities[overlay!.id]?.lifetime).toEqual([{ end: 6.5, start: 5 }]);
    expect(projection.objectList.entities.find((entity) => entity.id === overlay?.id)).toBe(overlay);
    expect(projection.timeline.events.some((event) => event.transactionId === "scene-transition")).toBe(true);
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
