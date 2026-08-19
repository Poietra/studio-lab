import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { projectedPositions, validatedProgramRecord, validateSuggestionDraft } from "./draft-validation";
import { projectProposedState } from "./evaluator";
import { createFixtureProposedState, STUDIO_FIXTURE_SCENE } from "./fixture";
import { canonicalOperationSchema, programExecutionCapabilities } from "./operation-registry";
import { STUDIO_STYLE_PROFILE, styleProfileRef } from "./style-profile";
import {
  createDirectManipulationColorProgram,
  createDirectManipulationGroupRotationProgram,
  createDirectManipulationLayerOrderProgram,
  createDirectManipulationOpacityProgram,
  createDirectManipulationPositionProgram,
  createDirectManipulationResizeProgram,
  createDirectManipulationRotationProgram,
  createDirectManipulationScaleProgram,
} from "./suggestion-program";

const transition: EditSuggestionOperation = {
  anchor: { kind: "playhead", referenceSeconds: 5 },
  color: "sky",
  destination: "next-scene",
  easing: "smooth",
  end: 6.5,
  kind: "create-scene-transition",
  shape: "diamond",
  start: 5,
  style: "cover-reveal",
};

describe("Studio draft validation boundary", () => {
  it("reserves the dimensions channel for ResizeEntity", () => {
    expect(
      canonicalOperationSchema.safeParse({
        dependsOn: [],
        entityId: "proof_box",
        id: "invalid-dimensions-property",
        interval: { end: 5, start: 5 },
        key: "dimensions",
        kind: "SetProperty",
        provenance: { evidence: [], origin: "remote-model" },
        value: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a Scene transition before canonicalization when no next Scene exists", () => {
    const result = validateSuggestionDraft(transition, {
      capturedPlayhead: 5,
      hasNextScene: false,
      origin: "remote-model",
      proposedState: createFixtureProposedState(),
      selectedObjectIds: [],
      transactionId: "no-destination",
    });

    expect(result).toEqual(expect.objectContaining({ kind: "invalid" }));
    if (result.kind === "invalid") expect(result.message).toMatch(/no next Scene/i);
  });

  it("does not turn an invalid direct manipulation into a draft record", () => {
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: 5,
      delta: { x: 2, y: 0 },
      positions: { missing: { x: 0, y: 0 } },
      scene: STUDIO_FIXTURE_SCENE,
      start: 5,
      targetEntityIds: ["missing"],
      transactionId: "invalid-position",
    });

    expect(validatedProgramRecord(validation)).toEqual(expect.objectContaining({ kind: "invalid" }));
  });

  it("keeps distinct sequential motions through the complete draft validation path", () => {
    const operation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          controlOffset: { x: 8, y: -12 },
          delta: { x: 40, y: 0 },
          easing: "smooth",
          end: 6,
          kind: "create-motion",
          start: 5,
          targetObjectIds: ["equation_1"],
        },
        {
          controlOffset: { x: -4, y: 16 },
          delta: { x: 0, y: 30 },
          easing: "smooth",
          end: 8,
          kind: "create-motion",
          start: 7,
          targetObjectIds: ["equation_1"],
        },
      ],
    } satisfies EditSuggestionOperation;

    const result = validateSuggestionDraft(operation, {
      capturedPlayhead: 5,
      hasNextScene: false,
      origin: "fixture",
      proposedState: createFixtureProposedState(),
      selectedObjectIds: ["equation_1"],
      transactionId: "sequential-motion-draft",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid" || result.operation.kind !== "edit-program") return;
    expect(result.operation.operations).toEqual(operation.operations);
    expect(
      result.record.program.operations.flatMap((entry) =>
        entry.kind === "CreateMotion"
          ? [
              {
                controlOffset: entry.controlOffset,
                delta: entry.delta,
                interval: entry.interval,
              },
            ]
          : [],
      ),
    ).toEqual([
      {
        controlOffset: { x: 8, y: -12 },
        delta: { x: 40, y: 0 },
        interval: { end: 6, start: 5 },
      },
      {
        controlOffset: { x: -4, y: 16 },
        delta: { x: 0, y: 30 },
        interval: { end: 8, start: 7 },
      },
    ]);
  });

  it("records the active style profile without warning for a matching suggestion", () => {
    const operation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      controlOffset: { x: 0, y: -10 },
      delta: { x: 40, y: 0 },
      easing: STUDIO_STYLE_PROFILE.easing,
      end: 5 + STUDIO_STYLE_PROFILE.durationSeconds.deliberate,
      kind: "create-motion",
      start: 5,
      targetObjectIds: ["equation_1"],
    } satisfies EditSuggestionOperation;

    const result = validateSuggestionDraft(operation, {
      capturedPlayhead: 5,
      hasNextScene: false,
      origin: "remote-model",
      proposedState: createFixtureProposedState(),
      selectedObjectIds: ["equation_1"],
      transactionId: "matching-style-profile",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.record.program.provenance.styleProfileRef).toEqual(styleProfileRef(STUDIO_STYLE_PROFILE));
    expect(result.record.validation.issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "style-profile-deviation" })]),
    );
  });

  it("warns about duration and easing deviations without blocking Apply", () => {
    const operation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      controlOffset: { x: 0, y: -10 },
      delta: { x: 40, y: 0 },
      easing: "linear",
      end: 6,
      kind: "create-motion",
      start: 5,
      targetObjectIds: ["equation_1"],
    } satisfies EditSuggestionOperation;

    const result = validateSuggestionDraft(operation, {
      capturedPlayhead: 5,
      hasNextScene: false,
      origin: "remote-model",
      proposedState: createFixtureProposedState(),
      selectedObjectIds: ["equation_1"],
      transactionId: "deviating-style-profile",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.record.validation.status).toBe("valid");
    expect(result.record.validation.issues.filter((issue) => issue.code === "style-profile-deviation")).toEqual([
      expect.objectContaining({ field: "duration", severity: "warning" }),
      expect.objectContaining({ field: "easing", severity: "warning" }),
    ]);
    expect(programExecutionCapabilities(result.record.program)).toMatchObject({ apply: "supported" });
  });

  it("uses the longest role duration for a mixed parallel program", () => {
    const operation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      execution: "parallel",
      kind: "edit-program",
      operations: [
        {
          controlOffset: { x: 0, y: -10 },
          delta: { x: 40, y: 0 },
          easing: "smooth",
          end: 6.5,
          kind: "create-motion",
          start: 5,
          targetObjectIds: ["equation_1"],
        },
        {
          animation: "fade-in",
          end: 6.5,
          kind: "create-explanation",
          objectKind: "text",
          placement: "below",
          start: 5,
          targetObjectId: "proof_box",
          text: "Explanation",
        },
      ],
    } satisfies EditSuggestionOperation;

    const result = validateSuggestionDraft(operation, {
      capturedPlayhead: 5,
      hasNextScene: false,
      origin: "remote-model",
      proposedState: createFixtureProposedState(),
      selectedObjectIds: ["equation_1", "proof_box"],
      transactionId: "parallel-style-profile",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.record.validation.issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "style-profile-deviation" })]),
    );
  });

  it("does not invent an origin position for an entity missing from the projection", () => {
    expect(projectedPositions([], ["missing"])).toEqual({
      kind: "invalid",
      message: "The projected position for missing is unavailable.",
    });
  });

  it("rejects direct movement when the imported source position is only approximate", () => {
    const entity = projectProposedState(createFixtureProposedState(), 5).canvas.entities[0];
    expect(entity).toBeDefined();
    if (!entity) return;
    const reason = "Position depends on a runtime move_to expression.";

    expect(
      projectedPositions(
        [
          {
            ...entity,
            geometry: { ...entity.geometry, position: { kind: "unknown", reason } },
          },
        ],
        [entity.id],
      ),
    ).toEqual({
      kind: "invalid",
      message: `Studio cannot move ${entity.id} safely: ${reason}`,
    });
  });

  it("projects a direct position change at the captured playhead", () => {
    const base = createFixtureProposedState();
    const before = projectProposedState(base, 5).canvas.entities.find((entity) => entity.id === "equation_1");
    expect(before).toBeDefined();
    if (!before) return;
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: 5,
      delta: { x: 100, y: 40 },
      positions: { equation_1: before.position },
      scene: base.evaluatedScene,
      start: 5,
      targetEntityIds: ["equation_1"],
      transactionId: "position-projection",
    });
    expect(validation.kind).toBe("valid");
  });

  it("creates an immediate scale from an explicit absolute scale pair", () => {
    const validation = createDirectManipulationScaleProgram({
      capturedPlayhead: 5,
      interval: { end: 5, start: 5 },
      scales: { equation_1: { from: 1, to: 1.5 } },
      scene: STUDIO_FIXTURE_SCENE,
      targetEntityIds: ["equation_1"],
      transactionId: "scale-projection",
    });

    expect(validation.kind).toBe("valid");
    expect(validation.program.operations).toEqual([
      expect.objectContaining({
        entityId: "equation_1",
        from: 1,
        interval: { end: 5, start: 5 },
        key: "scale",
        kind: "AnimateProperty",
        to: 1.5,
      }),
    ]);
  });

  it("creates finite construction-time rotations and rejects identity angles before validation", () => {
    const validation = createDirectManipulationRotationProgram({
      angleRadians: Math.PI / 4,
      capturedPlayhead: 0,
      entityId: "equation_1",
      scene: STUDIO_FIXTURE_SCENE,
      start: 0,
      transactionId: "rotation-projection",
    });

    expect(validation.kind).toBe("valid");
    expect(validation.program).toMatchObject({
      loweringStatus: "supported",
      operations: [
        {
          entityId: "equation_1",
          from: 0,
          interval: { end: 0, start: 0 },
          key: "rotation",
          kind: "AnimateProperty",
          relativeDelta: Math.PI / 4,
          to: Math.PI / 4,
        },
      ],
    });
    const create = (angleRadians: number) =>
      createDirectManipulationRotationProgram({
        angleRadians,
        capturedPlayhead: 0,
        entityId: "equation_1",
        scene: STUDIO_FIXTURE_SCENE,
        start: 0,
        transactionId: "rotation-noop",
      });
    expect(() => create(0)).toThrow(/must change the current angle/i);
    expect(() => create(2 * Math.PI)).toThrow(/must change the current angle/i);
    expect(
      createDirectManipulationRotationProgram({
        angleRadians: Math.PI / 4,
        capturedPlayhead: 5,
        entityId: "equation_1",
        scene: STUDIO_FIXTURE_SCENE,
        start: 5,
        transactionId: "rotation-after-zero",
      }),
    ).toMatchObject({
      kind: "valid",
      program: { operations: [{ interval: { end: 5, start: 5 } }] },
    });
    expect(
      programExecutionCapabilities({
        ...validation.program,
        operations: validation.program.operations.map((operation) => ({
          ...operation,
          interval: { end: 5, start: 5 },
        })),
      }),
    ).toMatchObject({ apply: "supported", lowering: "supported" });
  });

  it("creates one parallel Program for every position and rotation in a rigid selection", () => {
    const validation = createDirectManipulationGroupRotationProgram({
      angleRadians: Math.PI / 2,
      capturedPlayhead: 5,
      scene: STUDIO_FIXTURE_SCENE,
      start: 5,
      targets: [
        { entityId: "equation_1", toPosition: { x: 300, y: 220 } },
        { entityId: "proof_box", toPosition: { x: 300, y: 100 } },
      ],
      transactionId: "selection-rotation",
    });

    expect(validation.kind).toBe("valid");
    expect(validation.program).toMatchObject({
      intentCount: 1,
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel" },
      transactionId: "selection-rotation",
    });
    expect(validation.program.operations).toHaveLength(4);
    expect(validation.program.operations.slice(0, 2)).toEqual([
      expect.objectContaining({ entityId: "equation_1", key: "position", value: { x: 300, y: 220 } }),
      expect.objectContaining({ entityId: "proof_box", key: "position", value: { x: 300, y: 100 } }),
    ]);
    expect(validation.program.operations.slice(2)).toEqual([
      expect.objectContaining({
        entityId: "equation_1",
        from: 0,
        key: "rotation",
        relativeDelta: Math.PI / 2,
        to: Math.PI / 2,
      }),
      expect.objectContaining({
        entityId: "proof_box",
        from: 0,
        key: "rotation",
        relativeDelta: Math.PI / 2,
        to: Math.PI / 2,
      }),
    ]);
    expect(new Set(validation.program.operations.map(({ id }) => id)).size).toBe(4);
    expect(() =>
      createDirectManipulationGroupRotationProgram({
        angleRadians: Math.PI / 2,
        capturedPlayhead: 5,
        scene: STUDIO_FIXTURE_SCENE,
        start: 5,
        targets: [
          { entityId: "equation_1", toPosition: { x: 300, y: 220 } },
          { entityId: "equation_1", toPosition: { x: 300, y: 100 } },
        ],
        transactionId: "duplicate-selection-rotation",
      }),
    ).toThrow(/unique objects/i);
  });

  it("creates one bounded initial opacity edit", () => {
    const validation = createDirectManipulationOpacityProgram({
      capturedPlayhead: 0,
      entityId: "equation_1",
      opacity: 0.35,
      scene: STUDIO_FIXTURE_SCENE,
      start: 0,
      transactionId: "opacity-projection",
    });

    expect(validation.kind).toBe("valid");
    expect(validation.program).toMatchObject({
      loweringStatus: "supported",
      operations: [
        {
          entityId: "equation_1",
          interval: { end: 0, start: 0 },
          key: "appearance",
          kind: "SetProperty",
          value: 0.35,
        },
      ],
    });
    expect(() =>
      createDirectManipulationOpacityProgram({
        capturedPlayhead: 0,
        entityId: "equation_1",
        opacity: 1.01,
        scene: STUDIO_FIXTURE_SCENE,
        start: 0,
        transactionId: "opacity-out-of-range",
      }),
    ).toThrow(/0 to 1/i);
    expect(
      createDirectManipulationOpacityProgram({
        capturedPlayhead: 5,
        entityId: "equation_1",
        opacity: 0.35,
        scene: STUDIO_FIXTURE_SCENE,
        start: 5,
        transactionId: "opacity-after-zero",
      }),
    ).toMatchObject({
      kind: "valid",
      program: { operations: [{ interval: { end: 5, start: 5 } }] },
    });
  });

  it("creates one finite persistent paint-order edit", () => {
    const entityId = "tx:layer/entity:circle";
    const scene = {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          [entityId]: {
            id: entityId,
            lifetime: [{ end: STUDIO_FIXTURE_SCENE.duration, start: 0 }],
            provisional: false,
            sourceIdentity: { kind: "unknown" as const, reason: "Studio-created entity." },
            transactionId: "layer",
            type: "Circle",
          },
        },
      },
    };
    const validation = createDirectManipulationLayerOrderProgram({
      capturedPlayhead: 0,
      entityId,
      scene,
      sourceZIndex: 12.5,
      start: 0,
      transactionId: "layer-order",
    });

    expect(validation).toMatchObject({
      kind: "valid",
      program: {
        loweringStatus: "supported",
        operations: [
          {
            entityId,
            key: "sourceZIndex",
            kind: "SetProperty",
            value: 12.5,
          },
        ],
      },
    });
    expect(() =>
      createDirectManipulationLayerOrderProgram({
        capturedPlayhead: 0,
        entityId,
        scene,
        sourceZIndex: Number.NaN,
        start: 0,
        transactionId: "invalid-layer-order",
      }),
    ).toThrow(/finite canonical z-index/i);
    expect(
      createDirectManipulationLayerOrderProgram({
        capturedPlayhead: 0,
        entityId: "equation_1",
        scene: STUDIO_FIXTURE_SCENE,
        sourceZIndex: 12.5,
        start: 0,
        transactionId: "imported-layer-order",
      }),
    ).toMatchObject({
      issues: [expect.objectContaining({ code: "lowering-unsupported", field: "entityId" })],
      kind: "invalid",
    });
  });

  it("creates a canonical color edit only for a Studio-created shape", () => {
    const entityId = "tx:shape/entity:circle";
    const scene = {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          [entityId]: {
            id: entityId,
            lifetime: [{ end: STUDIO_FIXTURE_SCENE.duration, start: 0 }],
            provisional: false,
            sourceIdentity: { kind: "unknown" as const, reason: "Studio-created entity." },
            transactionId: "shape",
            type: "Circle",
          },
        },
      },
    };
    const validation = createDirectManipulationColorProgram({
      capturedPlayhead: 0,
      color: "#12abef",
      entityId,
      property: "fillColor",
      scene,
      start: 0,
      transactionId: "fill-shape",
    });

    expect(validation.issues).toEqual([]);
    expect(validation).toMatchObject({
      kind: "valid",
      program: {
        loweringStatus: "supported",
        operations: [{ entityId, key: "fillColor", kind: "SetProperty", value: "#12abef" }],
      },
    });
    expect(() =>
      createDirectManipulationColorProgram({
        capturedPlayhead: 0,
        color: "#12ABEF",
        entityId,
        property: "fillColor",
        scene,
        start: 0,
        transactionId: "invalid-fill-shape",
      }),
    ).toThrow(/lowercase canonical/i);
    expect(
      createDirectManipulationColorProgram({
        capturedPlayhead: 0,
        color: "#12abef",
        entityId: "equation_1",
        property: "strokeColor",
        scene,
        start: 0,
        transactionId: "imported-stroke",
      }),
    ).toMatchObject({ kind: "invalid" });
  });

  it("samples projected shape colors only from their edit time", () => {
    const base = createFixtureProposedState();
    const entityId = "equation_1";
    const proposed = {
      ...base,
      evaluatedScene: {
        ...base.evaluatedScene,
        propertyChannels: {
          ...base.evaluatedScene.propertyChannels,
          [`${entityId}/fillColor`]: {
            entityId,
            key: "fillColor" as const,
            samples: [
              {
                interval: { end: base.evaluatedScene.duration, start: 5 },
                kind: "exact" as const,
                provenanceId: "fill/provenance",
                value: "#12abef",
              },
            ],
          },
        },
      },
    };

    const before = projectProposedState(proposed, 4).canvas.entities.find((entity) => entity.id === entityId);
    const after = projectProposedState(proposed, 5).canvas.entities.find((entity) => entity.id === entityId);

    expect(before?.geometry.style.kind === "known" ? before.geometry.style.value.fillColor : undefined).not.toBe(
      "#12abef",
    );
    expect(after?.geometry.style).toMatchObject({ kind: "known", value: { fillColor: "#12abef" } });
  });

  it("rejects a resize shape that does not match its target", () => {
    const validation = createDirectManipulationResizeProgram({
      capturedPlayhead: 5,
      entityId: "proof_box",
      from: { dimensions: { radius: 1 }, position: { x: 320, y: 147 } },
      interval: { end: 5, start: 5 },
      scale: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shape: "circle",
      to: { dimensions: { radius: 2 }, position: { x: 340, y: 167 } },
      transactionId: "wrong-resize-shape",
    });

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "shape", severity: "error" })]),
    );
  });

  it("rejects extra dimension keys on a shape resize", () => {
    const validation = createDirectManipulationResizeProgram({
      capturedPlayhead: 5,
      entityId: "proof_box",
      from: { dimensions: { height: 2, radius: 99, width: 4 }, position: { x: 320, y: 147 } },
      interval: { end: 5, start: 5 },
      scale: 1,
      scene: STUDIO_FIXTURE_SCENE,
      shape: "rectangle",
      to: { dimensions: { height: 3, radius: 99, width: 6 }, position: { x: 340, y: 157 } },
      transactionId: "extra-resize-dimension",
    });

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "dimensions", severity: "error" })]),
    );
  });

  it("rejects dimensions that overflow during Manim lowering", () => {
    const validation = createDirectManipulationResizeProgram({
      capturedPlayhead: 5,
      entityId: "proof_box",
      from: { dimensions: { height: 2, width: 4 }, position: { x: 320, y: 147 } },
      interval: { end: 5, start: 5 },
      scale: 8,
      scene: STUDIO_FIXTURE_SCENE,
      shape: "rectangle",
      to: { dimensions: { height: 3, width: Number.MAX_VALUE }, position: { x: 340, y: 157 } },
      transactionId: "overflow-resize-dimension",
    });

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "dimensions", severity: "error" })]),
    );
  });
});
