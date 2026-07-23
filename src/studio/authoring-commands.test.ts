import { describe, expect, it } from "vitest";

import { evaluateWorkingState, programRecord, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import type { CanonicalEditOperation } from "./operations";
import {
  rebaseProgramTime,
  sourceTimeToWorkingTime,
  workingTimeToSourceTime,
} from "./program-composition";
import { projectRuntimeSceneToSourceTimeline } from "./source-timeline";
import {
  createImportedEntityLifetimeProgram,
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
  defaultEntityContent,
  duplicateEntityInput,
  replaceStudioEntityLifetimeProgram,
} from "./authoring-commands";

describe("manual Studio authoring commands", () => {
  it("creates and positions an entity through the canonical operation pipeline", () => {
    const result = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-circle",
    });
    expect(result.validation.kind).toBe("valid");
    expect(result.validation.program.operations.map((operation) => operation.kind)).toEqual([
      "CreateEntity",
      "SetProperty",
      "ChangePresence",
    ]);

    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(result.validation.program, result.validation)],
      }),
    );
    const inserted = projectProposedState(proposed, 5.4).canvas.entities.find(
      (entity) => entity.id === result.entityIds[0],
    );
    expect(inserted).toEqual(
      expect.objectContaining({
        position: { x: 180, y: 120 },
        type: "Circle",
      }),
    );
  });

  it("duplicates only types supported by the Insert tool", () => {
    const equation = projectProposedState(evaluateWorkingState(createFixtureWorkingState()), 5).canvas.entities.find(
      (entity) => entity.id === "equation_1",
    );
    expect(equation).toBeDefined();
    if (!equation) return;
    expect(duplicateEntityInput(equation)).toEqual(
      expect.objectContaining({
        position: { x: equation.position.x + 20, y: equation.position.y + 20 },
        type: "MathTex",
      }),
    );
  });

  it("creates a persistent remove operation for the Delete command", () => {
    const result = createRemoveEntitiesProgram({
      capturedPlayhead: 5,
      entityIds: ["equation_1"],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "delete-equation",
    });
    expect(result.kind).toBe("valid");
    expect(result.program.operations).toEqual([
      expect.objectContaining({ effect: "remove", entityId: "equation_1", persistent: true }),
    ]);
    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(result.program, result)],
      }),
    );
    expect(
      projectProposedState(proposed, 5.5).canvas.entities.find((entity) => entity.id === "equation_1")?.present,
    ).toBe(false);
  });

  it("trims a lifetime through a persistent removal from a safe source anchor", () => {
    const result = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetEnd: 7,
      transactionId: "trim-equation",
    });
    expect(result.kind).toBe("valid");
    expect(result.program.requestedExecution).toBe("sequence");
    expect(result.program.operations).toEqual([
      expect.objectContaining({
        effect: "remove",
        entityId: "equation_1",
        interval: { end: 7, start: 7 },
        kind: "ChangePresence",
        persistent: true,
      }),
    ]);

    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(result.program, result)],
      }),
    );
    expect(proposed.evaluatedScene.objectGraph.entities.equation_1?.lifetime).toEqual([{ end: 7, start: 0 }]);
    expect(
      projectProposedState(proposed, 7.01).canvas.entities.find((entity) => entity.id === "equation_1")?.present,
    ).toBe(false);
  });

  it("rejects imported extension and a retained lifetime shorter than 0.1 seconds", () => {
    expect(() => createImportedEntityLifetimeProgram({
      entityId: "arrow_1",
      original: { end: 9.5, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 9.5,
      targetEnd: 10,
      transactionId: "extend-arrow",
    })).toThrow(/cannot extend beyond/i);
    expect(() => createImportedEntityLifetimeProgram({
      entityId: "arrow_1",
      original: { end: 9.5, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 0.05,
      targetEnd: 0.05,
      transactionId: "short-arrow",
    })).toThrow(/at least 0.1 seconds/i);
    expect(() => createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 5,
      sourceAnchorBounds: { minimum: 7 },
      targetEnd: 5,
      transactionId: "out-of-order-imported-trim",
    })).toThrow(/out of source order/i);
  });

  it("replaces a Studio creation Program to edit both lifetime edges", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{
        content: defaultEntityContent("Circle", ""),
        position: { x: 180, y: 120 },
        type: "Circle",
      }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-owned-circle",
    });
    const owner = programRecord(insertion.validation.program, insertion.validation);
    const replacement = replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [5, 7],
      target: { end: 12, start: 7 },
    });

    expect(replacement.kind).toBe("valid");
    expect(replacement.program.transactionId).toBe("insert-owned-circle");
    expect(replacement.program.anchor.resolvedSeconds).toBe(7);
    expect(replacement.program.operations.find((operation) => operation.kind === "CreateEntity"))
      .toEqual(expect.objectContaining({
        entity: expect.objectContaining({ lifetime: { end: null, start: 7 } }),
      }));
    expect(replacement.program.operations.map((operation) => operation.interval.start))
      .toEqual([7, 7, 7]);
    expect(() => replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchorBounds: { maximum: 5 },
      sourceAnchors: [5, 7],
      target: { end: 12, start: 7 },
    })).toThrow(/out of source order/i);
  });

  it("projects a finite Studio-owned lifetime back to its source endpoints", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{
        content: defaultEntityContent("Circle", ""),
        position: { x: 180, y: 120 },
        type: "Circle",
      }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-finite-circle",
    });
    const owner = programRecord(insertion.validation.program, insertion.validation);
    const replacement = replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [5, 7],
      target: { end: 7, start: 5 },
    });
    const record = programRecord(replacement.program, replacement);
    const evaluated = evaluateWorkingState(createFixtureWorkingState({ appliedPrograms: [record] }));
    expect(evaluated.evaluatedScene.objectGraph.entities[insertion.entityIds[0]!]?.lifetime)
      .toEqual([{ end: 7.4, start: 5 }]);
    expect(projectRuntimeSceneToSourceTimeline(evaluated.evaluatedScene, [replacement.program])
      .objectGraph.entities[insertion.entityIds[0]!]?.lifetime).toEqual([{ end: 7, start: 5 }]);
  });

  it("edits one end without moving a shared Studio creation Program", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: (["Circle", "Rectangle"] as const).map((type) => ({
        content: defaultEntityContent(type, ""),
        position: { x: 180, y: 120 },
        type,
      })),
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-shared-shapes",
    });
    const owner = programRecord(insertion.validation.program, insertion.validation);
    const replacement = replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [5, 7],
      target: { end: 7, start: 5 },
    });
    const lifetimes = replacement.program.operations.flatMap((operation) => (
      operation.kind === "CreateEntity" ? [operation.entity.lifetime] : []
    ));

    expect(replacement.kind).toBe("valid");
    expect(lifetimes).toEqual([{ end: 7, start: 5 }, { end: null, start: 5 }]);
  });

  it("preserves a compound Program anchor for end-only edits", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{
        content: defaultEntityContent("Circle", ""),
        position: { x: 180, y: 120 },
        type: "Circle",
      }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "insert-delayed-shape",
    });
    const rebased = rebaseProgramTime(insertion.validation.program, 2);
    const wait: CanonicalEditOperation = {
      dependsOn: [],
      eventKind: "wait",
      id: "insert-delayed-shape/operation/wait",
      interval: { end: 7, start: 5 },
      kind: "InsertTimelineEvent",
      label: "Wait before creation",
      provenance: { evidence: [], origin: "fixture" },
    };
    const delayedProgram = {
      ...rebased,
      anchor: insertion.validation.program.anchor,
      operations: [wait, ...rebased.operations],
      requestedExecution: "sequence" as const,
      schedule: {
        edges: [],
        mode: "sequence" as const,
        order: [wait.id, ...rebased.schedule.order],
      },
    };
    const owner = programRecord(delayedProgram, { issues: [], kind: "valid" });
    const replacement = replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [5, 7, 9],
      target: { end: 9, start: 7 },
    });

    expect(replacement.kind).toBe("valid");
    expect(replacement.program.anchor.resolvedSeconds).toBe(5);
    expect(() => replaceStudioEntityLifetimeProgram({
      entityId: insertion.entityIds[0]!,
      owner,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [5, 7, 9],
      target: { end: 12, start: 9 },
    })).toThrow(/created after its Program begins/i);
  });

  it("replaces an imported end trim with a source-truthful restore", () => {
    const trimmed = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetEnd: 7,
      transactionId: "imported-lifetime-equation",
    });
    expect(trimmed.program.operations[0]).toEqual(expect.objectContaining({
      effect: "remove",
      interval: { end: 7, start: 7 },
    }));
    const restored = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      sourceAnchorBounds: { minimum: 9 },
      targetEnd: 12,
      transactionId: trimmed.program.transactionId,
    });
    expect(restored.program.operations[0]).toEqual(expect.objectContaining({
      eventKind: "wait",
      interval: { end: 7, start: 7 },
    }));
    const evaluated = evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [programRecord(restored.program, restored)],
    }));
    expect(evaluated.evaluatedScene.objectGraph.entities.equation_1?.lifetime)
      .toEqual([{ end: 12, start: 0 }]);
  });

  it("extends the composition with an explicit source wait", () => {
    const result = createSceneDurationProgram({
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 15,
      transactionId: "extend-duration",
    });
    expect(result.kind).toBe("valid");
    expect(result.program.operations[0]).toEqual(
      expect.objectContaining({
        eventKind: "wait",
        interval: { end: 10, start: 7 },
        purpose: "scene-duration",
      }),
    );
    const proposed = evaluateWorkingState(
      createFixtureWorkingState({
        stagedPrograms: [programRecord(result.program, result)],
      }),
    );
    expect(proposed.evaluatedScene.duration).toBe(15);
  });

  it("previews a shorter Scene by reducing only the trailing Studio duration wait", () => {
    const extension = createSceneDurationProgram({
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 15,
      transactionId: "extend-before-trim",
    });
    const extensionRecord = programRecord(extension.program, extension);
    const extended = evaluateWorkingState(
      createFixtureWorkingState({
        appliedPrograms: [extensionRecord],
      }),
    );
    const trim = createSceneDurationProgram({
      appliedPrograms: [extensionRecord],
      capturedPlayhead: 15,
      scene: extended.evaluatedScene,
      sourceAnchor: 7,
      targetDuration: 14,
      transactionId: "trim-duration",
    });

    expect(trim.kind).toBe("valid");
    expect(trim.program.operations).toEqual([
      expect.objectContaining({
        kind: "TrimSceneDuration",
        removedDuration: 1,
        targetDuration: 14,
        waitOperationIds: [extension.program.operations[0]?.id],
      }),
    ]);

    const preview = evaluateWorkingState(
      createFixtureWorkingState({
        appliedPrograms: [extensionRecord],
        stagedPrograms: [programRecord(trim.program, trim)],
      }),
    );
    expect(preview.evaluatedScene.duration).toBe(14);
    expect(preview.evaluatedScene.objectGraph.entities.equation_1?.lifetime).toEqual([{ end: 14, start: 0 }]);
    expect(
      preview.evaluatedScene.eventTrack.events.every((event) => (event.at ?? event.interval?.end ?? 0) <= 14),
    ).toBe(true);
    expect(
      Object.values(preview.evaluatedScene.propertyChannels).every((channel) =>
        channel.samples.every((sample) => sample.interval.end <= 14),
      ),
    ).toBe(true);
    expect(sourceTimeToWorkingTime([extension.program, trim.program], 12)).toBe(14);
    expect(workingTimeToSourceTime([extension.program, trim.program], 14)).toBe(12);
  });

  it("removes a Studio duration wait completely at the safe boundary", () => {
    const extension = createSceneDurationProgram({
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 15,
      transactionId: "extend-to-delete",
    });
    const extensionRecord = programRecord(extension.program, extension);
    const extended = evaluateWorkingState(createFixtureWorkingState({ appliedPrograms: [extensionRecord] }));
    const trim = createSceneDurationProgram({
      appliedPrograms: [extensionRecord],
      capturedPlayhead: 15,
      scene: extended.evaluatedScene,
      sourceAnchor: 7,
      targetDuration: 12,
      transactionId: "delete-duration-wait",
    });
    const restored = evaluateWorkingState(
      createFixtureWorkingState({
        appliedPrograms: [extensionRecord, programRecord(trim.program, trim)],
      }),
    );

    expect(trim.kind).toBe("valid");
    expect(restored.evaluatedScene.duration).toBe(12);
    expect(restored.evaluatedScene.eventTrack.events).not.toContainEqual(
      expect.objectContaining({
        operationId: extension.program.operations[0]?.id,
      }),
    );
    expect(sourceTimeToWorkingTime([extension.program, trim.program], 7)).toBe(7);
  });

  it("rejects shortening that would cut source content or a later applied Program", () => {
    expect(() =>
      createSceneDurationProgram({
        appliedPrograms: [],
        capturedPlayhead: 12,
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchor: 7,
        targetDuration: 11,
        transactionId: "trim-imported-content",
      }),
    ).toThrow(/imported or animated content is never truncated/i);

    const extension = createSceneDurationProgram({
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 15,
      transactionId: "extend-before-later-edit",
    });
    const extensionRecord = programRecord(extension.program, extension);
    const later = createRemoveEntitiesProgram({
      capturedPlayhead: 5,
      entityIds: ["equation_1"],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "later-edit",
    });
    expect(() =>
      createSceneDurationProgram({
        appliedPrograms: [extensionRecord, programRecord(later.program, later)],
        capturedPlayhead: 15,
        scene: evaluateWorkingState(
          createFixtureWorkingState({
            appliedPrograms: [extensionRecord],
          }),
        ).evaluatedScene,
        sourceAnchor: 7,
        targetDuration: 14,
        transactionId: "blocked-trim",
      }),
    ).toThrow(/later-edit.*Undo later edits/i);

    expect(() =>
      createSceneDurationProgram({
        appliedPrograms: [extensionRecord],
        capturedPlayhead: 15,
        scene: evaluateWorkingState(
          createFixtureWorkingState({
            appliedPrograms: [extensionRecord],
          }),
        ).evaluatedScene,
        sourceAnchor: 7,
        targetDuration: 11,
        transactionId: "trim-too-far",
      }),
    ).toThrow(/shortest safe duration is 12\.00s/i);
  });
});
