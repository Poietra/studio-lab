import { describe, expect, it } from "vitest";
import {
  createImportedEntityLifetimeProgram,
  createInspectorEntityEditProgram,
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
  defaultEntityContent,
  duplicateEntityInput,
  replaceStudioEntityLifetimeProgram,
} from "./authoring-commands";
import { programRecord, projectProposedState } from "./evaluator";
import { createFixtureProposedState, projectPersistentRemoveFixture, STUDIO_FIXTURE_SCENE } from "./fixture";
import type { CanonicalEditOperation } from "./operations";
import { rebaseProgramTime } from "./program-composition";
import { validateAndScheduleProgram } from "./program-validation";
import { projectRuntimeSceneToSourceTimeline } from "./source-timeline";
import { STUDIO_STYLE_PROFILE, styleProfileRef } from "./style-profile";

describe("manual Studio authoring commands", () => {
  function studioOwnedCircleScene(
    id: string,
    transactionId: string,
    lifetime: Readonly<{ end: number; start: number }> = { end: STUDIO_FIXTURE_SCENE.duration, start: 1 },
  ) {
    const source = STUDIO_FIXTURE_SCENE.objectGraph.entities.proof_box!;
    const position = STUDIO_FIXTURE_SCENE.propertyChannels["proof_box/position"]!;
    return {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          [id]: {
            ...source,
            geometry: {
              dimensions: { kind: "known" as const, value: { radius: 2 } },
              position: { kind: "known" as const, value: { x: 180, y: 120 } },
              scale: { kind: "known" as const, value: 1 },
              style: { kind: "known" as const, value: {} },
            },
            id,
            lifetime: [lifetime],
            sourceIdentity: { kind: "unknown" as const, reason: "Studio-owned test entity." },
            transactionId,
            type: "Circle",
          },
        },
      },
      propertyChannels: {
        ...STUDIO_FIXTURE_SCENE.propertyChannels,
        [`${id}/position`]: {
          ...position,
          entityId: id,
          samples: position.samples.map((sample) => ({ ...sample, value: { x: 180, y: 120 } })),
        },
      },
    };
  }

  function trimAvailability(waitOperationId: string) {
    return {
      anchor: 7,
      blocker: null,
      minimumDuration: 12,
      removableDuration: 3,
      waitOperationIds: [waitOperationId],
    } as const;
  }

  it("projects Inspector position and content edits from one canonical program", () => {
    const validation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: {
        content: {
          displayLines: ["F = ma"],
          label: "equation",
          texParts: ["F", "=", "m", "a"],
        },
        position: { x: 410, y: 170 },
      },
      entityId: "equation_1",
      from: { position: { x: 384, y: 146 }, scale: 1 },
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "inspector-equation",
    });

    expect(validation.kind, JSON.stringify(validation.issues)).toBe("valid");
    expect(validation.program.operations).toEqual([
      expect.objectContaining({
        entityId: "equation_1",
        key: "position",
        kind: "SetProperty",
        value: { x: 410, y: 170 },
      }),
      expect.objectContaining({
        entityId: "equation_1",
        key: "content",
        kind: "SetProperty",
        value: expect.objectContaining({ texParts: ["F", "=", "m", "a"] }),
      }),
    ]);
  });

  it("preserves requested Text content in the canonical creation Program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        {
          content: defaultEntityContent("Text", "before"),
          position: { x: 200, y: 120 },
          type: "Text",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "inspector-text-source",
    });
    const create = creation.validation.program.operations.find((operation) => operation.kind === "CreateEntity");
    expect(create?.kind).toBe("CreateEntity");
    if (create?.kind !== "CreateEntity") return;
    expect(create.entity.content).toEqual(defaultEntityContent("Text", "before"));
  });

  it("combines Inspector position and shape dimensions into the existing ResizeEntity operation", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ dimensions: { radius: 2 }, position: { x: 180, y: 120 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "inspector-circle-source",
    });
    const scene = studioOwnedCircleScene(creation.entityIds[0]!, creation.validation.program.transactionId);
    const validation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: { dimensions: { radius: 3 }, position: { x: 210, y: 150 } },
      entityId: creation.entityIds[0],
      from: { dimensions: { radius: 2 }, position: { x: 180, y: 120 }, scale: 1 },
      scene,
      transactionId: "inspector-circle-edit",
    });

    expect(validation.kind, JSON.stringify(validation.issues)).toBe("valid");
    expect(validation.program.operations).toEqual([
      expect.objectContaining({
        from: { dimensions: { radius: 2 }, position: { x: 180, y: 120 } },
        kind: "ResizeEntity",
        to: { dimensions: { radius: 3 }, position: { x: 210, y: 150 } },
      }),
    ]);
  });

  it("fails closed when Inspector content targets an imported entity without source identity", () => {
    const scene = {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          equation_1: {
            ...STUDIO_FIXTURE_SCENE.objectGraph.entities.equation_1,
            sourceIdentity: { kind: "unknown" as const, reason: "Runtime alias" },
          },
        },
      },
    };

    const knownValidation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: { content: { displayLines: ["F = ma"], texParts: ["F", "=", "m", "a"] } },
      entityId: "equation_1",
      from: { position: { x: 384, y: 146 }, scale: 1 },
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "known-inspector-content",
    });
    const revalidated = validateAndScheduleProgram(knownValidation.program, scene);
    expect(revalidated.kind).toBe("invalid");
    expect(revalidated.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "identity-unknown", field: "entityId", severity: "error" }),
      ]),
    );

    expect(() =>
      createInspectorEntityEditProgram({
        capturedPlayhead: 5,
        edits: { content: { displayLines: ["F = ma"], texParts: ["F", "=", "m", "a"] } },
        entityId: "equation_1",
        from: { position: { x: 384, y: 146 }, scale: 1 },
        scene,
        transactionId: "unsafe-inspector-content",
      }),
    ).toThrow(/known or Studio-generated source identity/i);
  });

  it("rejects content whose canonical shape does not match the selected entity type", () => {
    const validation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: { content: { displayLines: ["plain text"], text: "plain text" } },
      entityId: "equation_1",
      from: { position: { x: 384, y: 146 }, scale: 1 },
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "invalid-inspector-content-shape",
    });

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "value", severity: "error" })]),
    );
  });

  it("rejects Inspector content outside the shared round-trip contract", () => {
    const validation = createInspectorEntityEditProgram({
      capturedPlayhead: 5,
      edits: {
        content: {
          displayLines: ["F = ma"],
          label: "equation".repeat(300),
          texParts: ["F", "=", "m", "a"],
        },
      },
      entityId: "equation_1",
      from: { position: { x: 384, y: 146 }, scale: 1 },
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "invalid-inspector-content-contract",
    });

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "value", severity: "error" })]),
    );
  });

  it("creates and positions an entity in one canonical Program", () => {
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

    expect(result.validation.program.operations).toEqual([
      expect.objectContaining({
        entity: expect.objectContaining({ id: result.entityIds[0], type: "Circle" }),
        kind: "CreateEntity",
      }),
      expect.objectContaining({
        entityId: result.entityIds[0],
        key: "position",
        kind: "SetProperty",
        value: { x: 180, y: 120 },
      }),
      expect.objectContaining({ effect: "fade-in", entityId: result.entityIds[0], kind: "ChangePresence" }),
    ]);
    const appearance = result.validation.program.operations.find(
      (operation) => operation.kind === "ChangePresence" && operation.effect === "fade-in",
    );
    expect(appearance).toBeDefined();
    if (!appearance) return;
    expect(appearance.interval.end - appearance.interval.start).toBeCloseTo(STUDIO_STYLE_PROFILE.durationSeconds.brief);
    expect(result.validation.program.provenance.styleProfileRef).toEqual(styleProfileRef(STUDIO_STYLE_PROFILE));
  });

  it("rejects creation dimensions that do not match the entity type", () => {
    const result = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          dimensions: { width: 4 },
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "invalid-circle-dimensions",
    });

    expect(result.validation.kind).toBe("invalid");
    expect(result.validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "entity.dimensions", severity: "error" })]),
    );
  });

  it("preserves custom shape dimensions in the canonical creation Program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ dimensions: { radius: 2 }, position: { x: 180, y: 120 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "custom-circle",
    });
    expect(creation.validation.kind).toBe("valid");
    expect(creation.validation.program.operations.find((operation) => operation.kind === "CreateEntity")).toEqual(
      expect.objectContaining({ entity: expect.objectContaining({ dimensions: { radius: 2 } }) }),
    );
  });

  it("writes canonical shape defaults into the creation Program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ position: { x: 180, y: 120 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "default-circle",
    });
    expect(creation.validation.program.operations.find((operation) => operation.kind === "CreateEntity")).toEqual(
      expect.objectContaining({ entity: expect.objectContaining({ dimensions: { radius: 1 } }) }),
    );
  });

  it("rejects resize of an entity created in the same unapplied program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ position: { x: 180, y: 120 }, type: "Rectangle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "create-and-resize",
    });
    const create = creation.validation.program.operations.find((operation) => operation.kind === "CreateEntity");
    if (!create) throw new Error("Expected a CreateEntity operation.");
    const resize = {
      dependsOn: [create.id],
      entityId: creation.entityIds[0],
      from: { dimensions: { radius: 1 }, position: { x: 180, y: 120 } },
      id: "tx:create-and-resize/operation:invalid-resize",
      interval: { end: 5, start: 5 },
      kind: "ResizeEntity" as const,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
      scale: 1,
      shape: "circle" as const,
      to: { dimensions: { radius: 2 }, position: { x: 200, y: 140 } },
    };
    const operations = [...creation.validation.program.operations, resize];
    const validation = validateAndScheduleProgram(
      {
        ...creation.validation.program,
        operations,
        schedule: {
          ...creation.validation.program.schedule,
          order: [...creation.validation.program.schedule.order, resize.id],
        },
      },
      STUDIO_FIXTURE_SCENE,
    );

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "target", operationId: resize.id, severity: "error" })]),
    );
  });

  it("duplicates only types supported by the Insert tool", () => {
    const equation = projectProposedState(createFixtureProposedState(), 5).canvas.entities.find(
      (entity) => entity.id === "equation_1",
    );
    expect(equation).toBeDefined();
    if (!equation) return;
    const duplicate = duplicateEntityInput(equation);
    expect(duplicate).toEqual(
      expect.objectContaining({
        position: {
          x: equation.position.x + STUDIO_STYLE_PROFILE.spacingUnitPx,
          y: equation.position.y + STUDIO_STYLE_PROFILE.spacingUnitPx,
        },
        type: "MathTex",
      }),
    );
    expect(duplicate).not.toHaveProperty("dimensions");
    if (!duplicate) return;
    expect(
      createStudioEntitiesProgram({
        capturedPlayhead: 5,
        entities: [duplicate],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "duplicate-equation",
      }).validation.kind,
    ).toBe("valid");
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
    expect(result.program.operations[0]!.interval.end - result.program.operations[0]!.interval.start).toBeCloseTo(
      STUDIO_STYLE_PROFILE.durationSeconds.brief,
    );
    expect(result.program.provenance.styleProfileRef).toEqual(styleProfileRef(STUDIO_STYLE_PROFILE));
    const proposed = projectPersistentRemoveFixture(result.program, STUDIO_FIXTURE_SCENE, true);
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

    const proposed = projectPersistentRemoveFixture(result.program);
    expect(proposed.evaluatedScene.objectGraph.entities.equation_1?.lifetime).toEqual([{ end: 7, start: 0 }]);
    expect(
      projectProposedState(proposed, 7.01).canvas.entities.find((entity) => entity.id === "equation_1")?.present,
    ).toBe(false);
  });

  it("rejects imported extension and a retained lifetime shorter than 0.1 seconds", () => {
    expect(() =>
      createImportedEntityLifetimeProgram({
        entityId: "arrow_1",
        original: { end: 9.5, start: 0 },
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchor: 9.5,
        targetEnd: 10,
        transactionId: "extend-arrow",
      }),
    ).toThrow(/cannot extend beyond/i);
    expect(() =>
      createImportedEntityLifetimeProgram({
        entityId: "arrow_1",
        original: { end: 9.5, start: 0 },
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchor: 0.05,
        targetEnd: 0.05,
        transactionId: "short-arrow",
      }),
    ).toThrow(/at least 0.1 seconds/i);
    expect(() =>
      createImportedEntityLifetimeProgram({
        entityId: "equation_1",
        original: { end: 12, start: 0 },
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchor: 5,
        sourceAnchorBounds: { minimum: 7 },
        targetEnd: 5,
        transactionId: "out-of-order-imported-trim",
      }),
    ).toThrow(/out of source order/i);
  });

  it("replaces a Studio creation Program to edit both lifetime edges", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
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
    expect(replacement.program.operations.find((operation) => operation.kind === "CreateEntity")).toEqual(
      expect.objectContaining({
        entity: expect.objectContaining({ lifetime: { end: null, start: 7 } }),
      }),
    );
    expect(replacement.program.operations.map((operation) => operation.interval.start)).toEqual([7, 7, 7]);
    expect(() =>
      replaceStudioEntityLifetimeProgram({
        entityId: insertion.entityIds[0]!,
        owner,
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchorBounds: { maximum: 5 },
        sourceAnchors: [5, 7],
        target: { end: 12, start: 7 },
      }),
    ).toThrow(/out of source order/i);
  });

  it("projects a finite Studio-owned lifetime back to its source endpoints", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
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
    const evaluatedScene = studioOwnedCircleScene(insertion.entityIds[0]!, replacement.program.transactionId, {
      end: 7.4,
      start: 5,
    });
    expect(
      projectRuntimeSceneToSourceTimeline(evaluatedScene, [replacement.program]).objectGraph.entities[
        insertion.entityIds[0]!
      ]?.lifetime,
    ).toEqual([{ end: 7, start: 5 }]);
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
    const lifetimes = replacement.program.operations.flatMap((operation) =>
      operation.kind === "CreateEntity" ? [operation.entity.lifetime] : [],
    );

    expect(replacement.kind).toBe("valid");
    expect(lifetimes).toEqual([
      { end: 7, start: 5 },
      { end: null, start: 5 },
    ]);
  });

  it("preserves a compound Program anchor for end-only edits", () => {
    const insertion = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [
        {
          content: defaultEntityContent("Circle", ""),
          position: { x: 180, y: 120 },
          type: "Circle",
        },
      ],
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
    expect(() =>
      replaceStudioEntityLifetimeProgram({
        entityId: insertion.entityIds[0]!,
        owner,
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchors: [5, 7, 9],
        target: { end: 12, start: 9 },
      }),
    ).toThrow(/created after its Program begins/i);
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
    expect(trimmed.program.operations[0]).toEqual(
      expect.objectContaining({
        effect: "remove",
        interval: { end: 7, start: 7 },
      }),
    );
    const restored = createImportedEntityLifetimeProgram({
      entityId: "equation_1",
      original: { end: 12, start: 0 },
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      sourceAnchorBounds: { minimum: 9 },
      targetEnd: 12,
      transactionId: trimmed.program.transactionId,
    });
    expect(restored.program.operations[0]).toEqual(
      expect.objectContaining({
        eventKind: "wait",
        interval: { end: 7, start: 7 },
      }),
    );
    expect(restored.kind).toBe("valid");
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
    const trim = createSceneDurationProgram({
      capturedPlayhead: 15,
      scene: { ...STUDIO_FIXTURE_SCENE, duration: 15 },
      sourceAnchor: 7,
      targetDuration: 14,
      transactionId: "trim-duration",
      trimAvailability: trimAvailability(extensionRecord.program.operations[0]!.id),
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
    const trim = createSceneDurationProgram({
      capturedPlayhead: 15,
      scene: { ...STUDIO_FIXTURE_SCENE, duration: 15 },
      sourceAnchor: 7,
      targetDuration: 12,
      transactionId: "delete-duration-wait",
      trimAvailability: trimAvailability(extensionRecord.program.operations[0]!.id),
    });
    expect(trim.kind).toBe("valid");
    expect(trim.program.operations[0]).toEqual(
      expect.objectContaining({
        kind: "TrimSceneDuration",
        removedDuration: 3,
        targetDuration: 12,
        waitOperationIds: [extension.program.operations[0]?.id],
      }),
    );
  });

  it("requires Rust trim availability and obeys its safe lower bound", () => {
    expect(() =>
      createSceneDurationProgram({
        capturedPlayhead: 12,
        scene: STUDIO_FIXTURE_SCENE,
        sourceAnchor: 7,
        targetDuration: 11,
        transactionId: "trim-imported-content",
      }),
    ).toThrow(/Rust timeline projection is required/i);

    const extension = createSceneDurationProgram({
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchor: 7,
      targetDuration: 15,
      transactionId: "extend-before-later-edit",
    });
    const extensionRecord = programRecord(extension.program, extension);
    const extendedScene = { ...STUDIO_FIXTURE_SCENE, duration: 15 };
    expect(() =>
      createSceneDurationProgram({
        capturedPlayhead: 15,
        scene: extendedScene,
        sourceAnchor: 7,
        targetDuration: 11,
        transactionId: "trim-too-far",
        trimAvailability: trimAvailability(extensionRecord.program.operations[0]!.id),
      }),
    ).toThrow(/shortest safe duration is 12\.00s/i);
  });
});
