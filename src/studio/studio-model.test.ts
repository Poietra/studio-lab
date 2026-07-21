import { describe, expect, it } from "vitest";

import { parseEditSuggestionResult } from "../ai/edit-suggestion-schema";
import { suggestEditWithFixture, type EditSuggestionOperation } from "../ai/edit-suggestions";
import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import { EDIT_OPERATION_VERSION, operationId, type CanonicalEditProgram } from "./operations";
import { validateAndScheduleProgram } from "./program-validation";
import {
  canonicalizeSuggestionProgram,
  createDirectManipulationModifyMotionProgram,
  createDirectManipulationMotionProgram,
} from "./suggestion-program";
import { applyStagedPrograms, stageProgram, undoLastAppliedProgram, withoutTransaction } from "./transactions";

function fixtureSuggestion(
  prompt: string,
  options: Readonly<{ playhead?: number; selectedObjectIds?: readonly string[] }> = {},
) {
  const result = suggestEditWithFixture({
    objects: Object.values(STUDIO_FIXTURE_SCENE.objectGraph.entities).map((entity) => ({
      displayName: entity.id,
      id: entity.id,
      lifetimes: entity.lifetime,
      mathTex: entity.type === "MathTex" && entity.content?.texParts
        ? { displayLines: entity.content.displayLines, texParts: entity.content.texParts }
        : null,
      type: entity.type,
    })),
    playhead: options.playhead ?? 8,
    prompt,
    sceneDuration: STUDIO_FIXTURE_SCENE.duration,
    selectedObjectIds: options.selectedObjectIds ?? ["equation_1"],
  });
  expect(parseEditSuggestionResult(result).success).toBe(true);
  expect(result.kind).toBe("suggestion");
  if (result.kind !== "suggestion") throw new Error(result.message);
  return result.suggestion.operation;
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
  it("runs fixture and remote-shaped results through the same closed validator", () => {
    const operation = fixtureSuggestion("右に96px動かして");
    const fixtureResult = {
      kind: "suggestion" as const,
      suggestion: {
        assumptions: [],
        confidence: "medium" as const,
        operation,
        provider: "fixture" as const,
        summary: "fixture",
      },
    };
    const remoteResult = {
      ...fixtureResult,
      suggestion: { ...fixtureResult.suggestion, provider: "remote" as const, summary: "remote" },
    };
    expect(parseEditSuggestionResult(fixtureResult).success).toBe(true);
    expect(parseEditSuggestionResult(remoteResult).success).toBe(true);
  });

  it("rejects remote values that the browser would otherwise clamp to a different operation", () => {
    const operation = fixtureSuggestion("右に96px動かして");
    expect(operation.kind).toBe("create-motion");
    if (operation.kind !== "create-motion") return;
    const remoteResult = {
      kind: "suggestion" as const,
      suggestion: {
        assumptions: [],
        confidence: "medium" as const,
        operation: {
          ...operation,
          delta: { x: 221, y: 0 },
        },
        provider: "remote" as const,
        summary: "out-of-bounds remote motion",
      },
    };
    expect(parseEditSuggestionResult(remoteResult).success).toBe(false);
  });

  it("normalizes bounded model strings before canonical evaluation", () => {
    const operation = fixtureSuggestion("マクスウェル方程式に変形して", { playhead: 5 });
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
    const operation = fixtureSuggestion("5秒前からマクスウェル方程式に文字を出現させて解説して");
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
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      editorContext: movedEditorContext,
      stagedPrograms: [record],
    }));
    expect(proposed.programs[0].program.anchor.resolvedSeconds).toBe(3);
    expect(proposed.programs[0].program.operations.some((candidate) => (
      candidate.kind === "TransformContent" && candidate.sourceEntityId === "equation_1"
    ))).toBe(true);
  });

  it("applies and undoes a whole EditProgram as one transaction", () => {
    const operation = fixtureSuggestion("5秒前からマクスウェル方程式に文字を出現させて解説して");
    const validation = canonicalize(operation, "atomic-program");
    expect(validation.kind).toBe("valid");
    expect(validation.program.operations.length).toBeGreaterThan(2);
    const staged = stageProgram(createFixtureWorkingState(), programRecord(validation.program, validation));
    const applied = applyStagedPrograms(staged);
    expect(applied.stagedPrograms).toHaveLength(0);
    expect(applied.appliedPrograms).toHaveLength(1);
    expect(applied.appliedPrograms[0].program.transactionId).toBe("atomic-program");
    const undone = undoLastAppliedProgram(applied);
    expect(undone.appliedPrograms).toHaveLength(0);
  });

  it("removes only legacy projections owned by the canonical transaction being undone", () => {
    const records = [
      { id: "older-a", transactionId: "transaction-a" },
      { id: "newer-b", transactionId: "transaction-b" },
      { id: "older-a-second-leaf", transactionId: "transaction-a" },
    ];
    expect(withoutTransaction(records, "transaction-b").map((record) => record.id)).toEqual([
      "older-a",
      "older-a-second-leaf",
    ]);
  });
});

describe("canonical operation expansion and DAG validation", () => {
  it("normalizes new and existing motion gestures through the operation registry", () => {
    const created = createDirectManipulationMotionProgram({
      capturedPlayhead: 5,
      controlOffset: { x: 0, y: -24 },
      delta: { x: 96, y: 0 },
      interval: { end: 6, start: 5 },
      scene: STUDIO_FIXTURE_SCENE,
      targetEntityIds: ["equation_1"],
      transactionId: "gesture-create-motion",
    });
    const modified = createDirectManipulationModifyMotionProgram({
      capturedPlayhead: 5,
      controlOffset: { x: 0, y: -32 },
      interval: { end: 7, start: 4 },
      motionId: "move-equation",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "gesture-modify-motion",
    });
    expect(created.kind).toBe("valid");
    expect(created.program.operations[0].kind).toBe("CreateMotion");
    expect(modified.kind).toBe("valid");
    expect(modified.program.operations[0].kind).toBe("ModifyMotion");
    expect(modified.program.loweringStatus).toBe("illustrative");
  });

  it("keeps transform and explanation atomic and targets the post-transform identity", () => {
    const validation = canonicalize(fixtureSuggestion(
      "5秒前からマクスウェル方程式に文字を出現させて解説して",
    ));
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
    expect(validation.program.schedule.edges.some((edge) => (
      edge.from === transform.id && edge.to === relation.id && edge.reason === "identity"
    ))).toBe(true);
  });

  it("preserves all three supported clauses as three leaf intents", () => {
    const operation = fixtureSuggestion(
      "右に動かして、マクスウェル方程式に変形して、初心者向けの文字を表示して解説して",
      { playhead: 5 },
    );
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
    expect(new Set(validation.program.operations.map((candidate) => candidate.kind))).toEqual(new Set([
      "ChangePresence",
      "CreateEntity",
      "CreateMotion",
      "SetRelation",
      "TransformContent",
    ]));
  });

  it("returns one focused execution issue for conflicting parallel channel writes", () => {
    const base = canonicalize(fixtureSuggestion("右に96px動かして"), "conflict-base").program;
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
    const base = canonicalize(
      fixtureSuggestion("右に96px動かして", { playhead: 5 }),
      "read-write-conflict",
      5,
    ).program;
    const first = base.operations[0];
    expect(first.kind).toBe("CreateMotion");
    if (first.kind !== "CreateMotion") return;
    const second = {
      ...first,
      delta: { x: 24, y: 0 },
      id: operationId("read-write-conflict", "motion-second"),
    };
    const validation = validateAndScheduleProgram({
      ...base,
      intentCount: 2,
      operations: [first, second],
      requestedExecution: "parallel",
    }, STUDIO_FIXTURE_SCENE);
    expect(validation.kind).toBe("invalid");
    expect(validation.issues.filter((issue) => issue.field === "execution")).toHaveLength(1);
    expect(validation.issues.some((issue) => issue.code === "cycle")).toBe(false);
    expect(validation.program.schedule.edges).toContainEqual({
      from: first.id,
      reason: "write-conflict",
      to: second.id,
    });
    expect(validation.program.schedule.edges).not.toContainEqual(expect.objectContaining({
      from: second.id,
      to: first.id,
    }));
  });

  it("evaluates a ModifyMotion gesture into the shared position channel", () => {
    const validation = createDirectManipulationModifyMotionProgram({
      capturedPlayhead: 5,
      controlOffset: { x: 0, y: -32 },
      interval: { end: 7, start: 4 },
      motionId: "move-equation",
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "modify-motion-projection",
    });
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    const equation = projectProposedState(proposed, 5.5).canvas.entities.find((entity) => entity.id === "equation_1");
    expect(equation?.position).toEqual({ x: 352, y: 120 });
  });

  it("revalidates later programs against identities changed by earlier programs", () => {
    const firstOperation = fixtureSuggestion("マクスウェル方程式に変形して", { playhead: 5 });
    expect(firstOperation.kind).toBe("create-transform");
    if (firstOperation.kind !== "create-transform") return;
    const first = canonicalize(firstOperation, "first-transform", 5);
    const secondOperation = {
      ...firstOperation,
      anchor: { kind: "absolute" as const, seconds: 7 },
      end: 8.5,
      start: 7,
    };
    const second = canonicalize(secondOperation, "stale-second-transform", 5);
    expect(first.kind).toBe("valid");
    expect(second.kind).toBe("valid");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [
        programRecord(first.program, first),
        programRecord(second.program, second),
      ],
    }));
    expect(proposed.programs[0].validation.status).toBe("valid");
    expect(proposed.programs[1].validation.status).toBe("invalid");
    expect(proposed.programs[1].validation.issues.some((issue) => issue.code === "lifetime-unknown")).toBe(true);
    expect(proposed.evaluatedScene.objectGraph.entities).not.toHaveProperty(
      "tx:stale-second-transform/entity:transform-target-0",
    );
  });
});

describe("one ProposedState feeds every Studio projection", () => {
  it("evaluates camera focus and selected-object emphasis through shared channels", () => {
    const operation = fixtureSuggestion("カメラを寄せながら重要部分を強調して", { playhead: 4.42 });
    expect(operation.kind).toBe("create-camera-focus");
    if (operation.kind !== "create-camera-focus") return;
    const validation = canonicalize(operation, "camera-focus", 4.42);
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    const projection = projectProposedState(proposed, operation.end);
    const equation = projection.canvas.entities.find((entity) => entity.id === "equation_1");
    expect(projection.camera.scale).toBeCloseTo(1.35);
    expect(equation?.scale).toBeCloseTo(1.12);
    expect(projection.camera.sampleId).toBe(projection.canvas.sampleId);
  });

  it("resolves immediately-before once and replaces MathTex with explanatory Text", () => {
    const operation = fixtureSuggestion("直前から説明を開始して文字に変形する", { playhead: 4.42 });
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
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    const midpoint = projectProposedState(proposed, (operation.start + operation.end) / 2);
    const midpointReplacement = midpoint.canvas.entities.find((entity) => (
      entity.present
      && entity.type === "Text"
      && entity.sourceIdentity.kind === "known"
      && entity.sourceIdentity.value === "equation"
    ));
    expect(midpointReplacement?.opacity).toBeGreaterThan(0);
    expect(midpointReplacement?.opacity).toBeLessThan(1);
    const projection = projectProposedState(proposed, operation.end);
    const replacement = projection.canvas.entities.find((entity) => (
      entity.present
      && entity.type === "Text"
      && entity.sourceIdentity.kind === "known"
      && entity.sourceIdentity.value === "equation"
    ));
    expect(replacement?.content?.text).toContain("この式の意味");
    expect(projection.canvas.entities.find((entity) => entity.id === "equation_1")?.present).toBe(false);
  });

  it("creates a visible provisional MathTex without requiring selection", () => {
    const operation = fixtureSuggestion("あたらしく数式を書いて", {
      playhead: 5,
      selectedObjectIds: [],
    });
    expect(operation.kind).toBe("create-equation");
    if (operation.kind !== "create-equation") return;
    expect(operation.target.displayLines).toEqual(["F = ma"]);
    const validation = canonicalize(operation, "new-equation", 5);
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      editorContext: { ...createFixtureWorkingState().editorContext, playhead: 5, selection: [] },
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    const projection = projectProposedState(proposed, operation.end);
    const equation = projection.canvas.entities.find((entity) => (
      entity.present && entity.provisional && entity.type === "MathTex"
    ));
    expect(equation?.content?.displayLines).toEqual(["F = ma"]);
    expect(equation?.position).toEqual({ x: 480, y: 180 });
    expect(projection.objectList.entities.find((entity) => entity.id === equation?.id)).toBe(equation);
    expect(projection.timeline.events.some((event) => event.transactionId === "new-equation")).toBe(true);
  });

  it("shows a provisional Text consistently on canvas, object list, timeline and playback", () => {
    const validation = canonicalize(fixtureSuggestion(
      "5秒前からマクスウェル方程式に文字を出現させて解説して",
    ), "projection-program");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
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
    expect(proposed.evaluatedScene.constraintGraph.constraints.some((constraint) => (
      constraint.sourceEntityId === explanation?.id && constraint.mode === "snapshot"
    ))).toBe(true);
  });

  it("creates a Scene-level transition without selection and exposes the full-cover boundary", () => {
    const operation = fixtureSuggestion("ここで良い感じの図形でシーンチェンジしたい", {
      playhead: 5,
      selectedObjectIds: [],
    });
    expect(operation.kind).toBe("create-scene-transition");
    if (operation.kind !== "create-scene-transition") return;
    expect(operation.shape).toBe("diamond");
    expect(operation.color).toBe("sky");
    const validation = canonicalize(operation, "scene-transition", 5);
    expect(validation.kind).toBe("valid");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      editorContext: { ...createFixtureWorkingState().editorContext, playhead: 5, selection: [] },
      stagedPrograms: [programRecord(validation.program, validation)],
    }));
    const boundary = proposed.evaluatedScene.eventTrack.events.find((event) => event.kind === "scene-boundary");
    expect(boundary?.at).toBe(5.75);
    expect(boundary?.label).toBe("Full-cover Scene boundary");
    const projection = projectProposedState(proposed, 5.25);
    const overlay = projection.canvas.entities.find((entity) => entity.type === "TransitionOverlay:diamond:sky");
    expect(overlay).toBeDefined();
    expect(projection.objectList.entities.find((entity) => entity.id === overlay?.id)).toBe(overlay);
    expect(projection.timeline.events.some((event) => event.transactionId === "scene-transition")).toBe(true);
  });

  it("rejects destructive transforms whose source identity is Unknown", () => {
    const operation = fixtureSuggestion("マクスウェル方程式に変形して", { playhead: 5 });
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
