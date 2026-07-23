import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { validateEditProgram } from "../ai/edit-program-validation";
import { validateSuggestionDraft } from "./draft-validation";
import { evaluateWorkingState, projectProposedState } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import type { RuntimeSceneState } from "./model";
import { canonicalizeSuggestionProgram } from "./suggestion-program";
import { applyStagedPrograms, stageProgram, undoLastAppliedProgram } from "./transactions";

const KNOWN_SCALE_SCENE: RuntimeSceneState = {
  ...STUDIO_FIXTURE_SCENE,
  propertyChannels: {
    ...STUDIO_FIXTURE_SCENE.propertyChannels,
    "equation_1/scale": {
      entityId: "equation_1",
      key: "scale",
      samples: [
        {
          interval: { end: 12, start: 0 },
          kind: "exact",
          provenanceId: "source:equation-scale",
          value: 1,
        },
      ],
    },
  },
};

function scaleSuggestion(factor = 1.5): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: 5 },
    easing: "smooth",
    end: 6,
    factor,
    kind: "scale-objects",
    start: 5,
    targetObjectIds: ["equation_1"],
  };
}

function deleteSuggestion(): EditSuggestionOperation {
  return {
    anchor: { kind: "playhead", referenceSeconds: 5 },
    animation: "fade-out",
    end: 5.4,
    kind: "delete-objects",
    start: 5,
    targetObjectIds: ["equation_1"],
  };
}

function validate(
  operation: EditSuggestionOperation,
  scene: RuntimeSceneState = KNOWN_SCALE_SCENE,
  selectedObjectIds: readonly string[] = ["equation_1"],
) {
  const workingState = createFixtureWorkingState({
    editorContext: {
      ...createFixtureWorkingState().editorContext,
      playhead: 5,
      selection: selectedObjectIds,
    },
  });
  return validateSuggestionDraft(operation, {
    capturedPlayhead: 5,
    hasNextScene: true,
    origin: "remote-model",
    proposedState: evaluateWorkingState({ ...workingState, runtimeSceneState: scene }),
    selectedObjectIds,
    transactionId: "magic-object-edit",
  });
}

describe("Magic Edit scale and delete canonicalization", () => {
  it("previews, applies, and undoes a relative scale through absolute Canonical values", () => {
    const result = validate(scaleSuggestion());
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.record.program.operations).toEqual([
      expect.objectContaining({
        entityId: "equation_1",
        from: 1,
        key: "scale",
        kind: "AnimateProperty",
        relativeFactor: 1.5,
        to: 1.5,
      }),
    ]);

    const staged = stageProgram(createFixtureWorkingState(), result.record);
    const preview = evaluateWorkingState(staged);
    expect(
      projectProposedState(preview, 5.5).canvas.entities.find((entity) => entity.id === "equation_1")?.scale,
    ).toBeCloseTo(1.25);
    const applied = applyStagedPrograms(staged);
    expect(applied.appliedPrograms).toHaveLength(1);
    expect(undoLastAppliedProgram(applied).appliedPrograms).toHaveLength(0);
  });

  it("previews a persistent deletion and keeps Apply/Undo atomic", () => {
    const result = validate(deleteSuggestion());
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.record.program.operations).toEqual([
      expect.objectContaining({
        effect: "remove",
        entityId: "equation_1",
        kind: "ChangePresence",
        persistent: true,
      }),
    ]);

    const staged = stageProgram(createFixtureWorkingState(), result.record);
    const preview = evaluateWorkingState(staged);
    expect(
      projectProposedState(preview, 5.2).canvas.entities.find((entity) => entity.id === "equation_1")?.opacity,
    ).toBeGreaterThan(0);
    expect(
      projectProposedState(preview, 5.4).canvas.entities.find((entity) => entity.id === "equation_1")?.present,
    ).toBe(false);
    const applied = applyStagedPrograms(staged);
    expect(applied.appliedPrograms).toHaveLength(1);
    expect(undoLastAppliedProgram(applied).appliedPrograms).toHaveLength(0);
  });

  it("rejects unselected, unknown-scale, and unknown-identity targets", () => {
    expect(validate(scaleSuggestion(), STUDIO_FIXTURE_SCENE, [])).toEqual({
      kind: "invalid",
      message: "Magic Edit can scale or delete only selected objects that are still available.",
    });
    const entity = STUDIO_FIXTURE_SCENE.objectGraph.entities.equation_1;
    const unknownScene: RuntimeSceneState = {
      ...STUDIO_FIXTURE_SCENE,
      objectGraph: {
        ...STUDIO_FIXTURE_SCENE.objectGraph,
        entities: {
          ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
          equation_1: {
            ...entity,
            geometry: {
              dimensions: { kind: "known", value: {} },
              position: { kind: "known", value: { x: 320, y: 146 } },
              scale: { kind: "unknown", reason: "Scale comes from a runtime function." },
              style: { kind: "known", value: {} },
            },
            sourceIdentity: { kind: "unknown", reason: "Runtime identity is unresolved." },
          },
        },
      },
    };

    expect(validate(scaleSuggestion(), unknownScene)).toEqual({
      kind: "invalid",
      message: "Studio cannot scale equation_1 safely: Runtime identity is unresolved.",
    });
    expect(validate(deleteSuggestion(), unknownScene)).toEqual({
      kind: "invalid",
      message: "Studio cannot delete equation_1 safely: Runtime identity is unresolved.",
    });
  });

  it("defends canonicalization against a known scale with an unknown source identity", () => {
    const entity = KNOWN_SCALE_SCENE.objectGraph.entities.equation_1;
    const unsafeScene: RuntimeSceneState = {
      ...KNOWN_SCALE_SCENE,
      objectGraph: {
        ...KNOWN_SCALE_SCENE.objectGraph,
        entities: {
          ...KNOWN_SCALE_SCENE.objectGraph.entities,
          equation_1: {
            ...entity,
            sourceIdentity: { kind: "unknown", reason: "Runtime identity is unresolved." },
          },
        },
      },
    };
    const result = canonicalizeSuggestionProgram(scaleSuggestion(), {
      capturedPlayhead: 5,
      origin: "remote-model",
      scene: unsafeScene,
      transactionId: "unsafe-scale",
    });

    expect(result.kind).toBe("invalid");
    expect(result.issues[0]?.message).toBe("Studio cannot scale equation_1 safely: Runtime identity is unresolved.");
  });

  it("keeps scale then delete as one safe sequence and rejects unsafe orderings", () => {
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
          targetObjectIds: ["equation_1"],
        },
        {
          animation: "fade-out",
          end: 6.4,
          kind: "delete-objects",
          start: 6,
          targetObjectIds: ["equation_1"],
        },
      ],
    };
    const result = validate(operation);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.record.program.operations.map((entry) => entry.kind)).toEqual([
        "AnimateProperty",
        "ChangePresence",
      ]);
    }

    const context = {
      capturedPlayhead: 5,
      objects: [{ id: "equation_1", lifetimes: [{ end: 12, start: 0 }], type: "MathTex" }],
      sceneDuration: 12,
      selectedObjectIds: ["equation_1"],
    } as const;
    expect(
      validateEditProgram(
        {
          ...operation,
          execution: "parallel",
          operations:
            operation.kind === "edit-program"
              ? operation.operations.map((step) => ({ ...step, end: 6, start: 5 }))
              : [],
        },
        context,
      ),
    ).toEqual({
      kind: "invalid",
      message:
        "Scaling or deleting an object cannot run in parallel with another edit on that object. Express those steps in sequence.",
    });
    expect(
      validateEditProgram(
        {
          ...operation,
          operations:
            operation.kind === "edit-program"
              ? [
                  { ...operation.operations[1], end: 5.4, start: 5 },
                  { ...operation.operations[0], end: 6.4, start: 5.4 },
                ]
              : [],
        },
        context,
      ),
    ).toEqual({
      kind: "invalid",
      message: "delete-objects must be the last step that targets an object. Move the later edit before deletion.",
    });
  });

  it("rebinds deletion to a preceding transform identity", () => {
    const operation: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          easing: "smooth",
          end: 6,
          identityAfter: "target-replaces-source",
          kind: "create-transform",
          mismatchMode: "transform",
          sourceObjectId: "equation_1",
          start: 5,
          strategy: "transform-matching-tex",
          target: {
            displayLines: ["F = ma"],
            kind: "mathtex",
            label: "Newton's second law",
            texParts: ["F", "=", "m", "a"],
          },
        },
        {
          animation: "fade-out",
          end: 6.4,
          kind: "delete-objects",
          start: 6,
          targetObjectIds: ["equation_1"],
        },
      ],
    };
    const result = validate(operation);
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    const transform = result.record.program.operations.find((entry) => entry.kind === "TransformContent");
    const deletion = result.record.program.operations.find(
      (entry) => entry.kind === "ChangePresence" && entry.effect === "remove",
    );
    expect(transform?.kind).toBe("TransformContent");
    expect(deletion?.kind).toBe("ChangePresence");
    if (transform?.kind !== "TransformContent" || deletion?.kind !== "ChangePresence") return;
    expect(deletion.entityId).toBe(transform.targetEntityId);
    expect(deletion.dependsOn).toContain(transform.id);
  });

  it("rejects scale combined with TransformContent instead of previewing a default-scale replacement", () => {
    const operation: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          easing: "smooth",
          end: 6,
          identityAfter: "target-replaces-source",
          kind: "create-transform",
          mismatchMode: "transform",
          sourceObjectId: "equation_1",
          start: 5,
          strategy: "transform-matching-tex",
          target: {
            displayLines: ["F = ma"],
            kind: "mathtex",
            label: "Newton's second law",
            texParts: ["F", "=", "m", "a"],
          },
        },
        {
          easing: "smooth",
          end: 7,
          factor: 1.25,
          kind: "scale-objects",
          start: 6,
          targetObjectIds: ["equation_1"],
        },
      ],
    };

    expect(validate(operation)).toEqual({
      kind: "invalid",
      message:
        "Scaling and transforming the same logical object in one Edit Program is not supported because Studio cannot preserve the target object's exact source scale.",
    });
  });

  it("rejects TransformContent when the imported source has a non-1 effective scale", () => {
    const scaledScene: RuntimeSceneState = {
      ...KNOWN_SCALE_SCENE,
      propertyChannels: {
        ...KNOWN_SCALE_SCENE.propertyChannels,
        "equation_1/scale": {
          entityId: "equation_1",
          key: "scale",
          samples: [
            {
              interval: { end: 12, start: 0 },
              kind: "exact",
              provenanceId: "source:scaled-equation",
              value: 2,
            },
          ],
        },
      },
    };
    const operation: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      easing: "smooth",
      end: 6,
      identityAfter: "target-replaces-source",
      kind: "create-transform",
      mismatchMode: "transform",
      sourceObjectId: "equation_1",
      start: 5,
      strategy: "transform-matching-tex",
      target: {
        displayLines: ["F = ma"],
        kind: "mathtex",
        label: "Newton's second law",
        texParts: ["F", "=", "m", "a"],
      },
    };

    expect(validate(operation, scaledScene)).toEqual({
      kind: "invalid",
      message: expect.stringMatching(/requires .* effective 1x scale.*2x/i),
    });
  });

  it("rejects a later TransformContent after an applied scale Program", () => {
    const scaled = validate(scaleSuggestion());
    expect(scaled.kind).toBe("valid");
    if (scaled.kind !== "valid") return;
    const proposed = evaluateWorkingState({
      ...createFixtureWorkingState(),
      appliedPrograms: [scaled.record],
      runtimeSceneState: KNOWN_SCALE_SCENE,
    });
    const transform: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 7 },
      easing: "smooth",
      end: 8,
      identityAfter: "target-replaces-source",
      kind: "create-transform",
      mismatchMode: "transform",
      sourceObjectId: "equation_1",
      start: 7,
      strategy: "transform-matching-tex",
      target: {
        displayLines: ["F = ma"],
        kind: "mathtex",
        label: "Newton's second law",
        texParts: ["F", "=", "m", "a"],
      },
    };

    const validation = canonicalizeSuggestionProgram(transform, {
      capturedPlayhead: 7,
      origin: "remote-model",
      scene: proposed.evaluatedScene,
      transactionId: "transform-after-applied-scale",
    });

    expect(validation.kind).toBe("invalid");
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: "lowering-unsupported",
        message: expect.stringMatching(/requires .* effective 1x scale.*1\.5x/i),
      }),
    );
  });

  it("requires source-sequential execution with a Scene transition", () => {
    const operation = {
      anchor: { kind: "playhead" as const, referenceSeconds: 5 },
      execution: "parallel" as const,
      kind: "edit-program" as const,
      operations: [
        {
          easing: "smooth" as const,
          end: 6.5,
          factor: 1.25,
          kind: "scale-objects" as const,
          start: 5,
          targetObjectIds: ["equation_1"],
        },
        {
          color: "sky" as const,
          destination: "next-scene" as const,
          easing: "smooth" as const,
          end: 6.5,
          kind: "create-scene-transition" as const,
          shape: "circle" as const,
          start: 5,
          style: "cover-reveal" as const,
        },
      ],
    };
    expect(
      validateEditProgram(operation, {
        capturedPlayhead: 5,
        objects: [{ id: "equation_1", lifetimes: [{ end: 12, start: 0 }], type: "MathTex" }],
        sceneDuration: 12,
        selectedObjectIds: ["equation_1"],
      }),
    ).toEqual({
      kind: "invalid",
      message:
        "Scale or deletion must run in sequence with a Scene transition so Studio can lower one truthful source timeline.",
    });
  });

  it("requires a Scene transition to be the final sequence step", () => {
    const operation: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          color: "sky",
          destination: "next-scene",
          easing: "smooth",
          end: 6.5,
          kind: "create-scene-transition",
          shape: "circle",
          start: 5,
          style: "cover-reveal",
        },
        {
          easing: "smooth",
          end: 7.5,
          factor: 1.25,
          kind: "scale-objects",
          start: 6.5,
          targetObjectIds: ["equation_1"],
        },
      ],
    };

    expect(validate(operation)).toEqual({
      kind: "invalid",
      message:
        "create-scene-transition must be the final Edit Program step because its Scene boundary transfers ownership to the next Scene.",
    });
  });

  it("reports multi-target standalone scale with the parallel schedule it lowers", () => {
    const scene: RuntimeSceneState = {
      ...KNOWN_SCALE_SCENE,
      propertyChannels: {
        ...KNOWN_SCALE_SCENE.propertyChannels,
        "arrow_1/scale": {
          entityId: "arrow_1",
          key: "scale",
          samples: [
            {
              interval: { end: 12, start: 0 },
              kind: "exact",
              provenanceId: "source:arrow-scale",
              value: 2,
            },
          ],
        },
      },
    };
    const result = canonicalizeSuggestionProgram(
      {
        anchor: { kind: "playhead", referenceSeconds: 5 },
        easing: "smooth",
        end: 6,
        factor: 1.5,
        kind: "scale-objects",
        start: 5,
        targetObjectIds: ["equation_1", "arrow_1"],
      },
      {
        capturedPlayhead: 5,
        origin: "remote-model",
        scene,
        transactionId: "multi-scale",
      },
    );

    expect(result.kind).toBe("valid");
    expect(result.program.requestedExecution).toBe("parallel");
    expect(result.program.schedule.mode).toBe("parallel");
    expect(result.program.operations.map((entry) => entry.interval)).toEqual([
      { end: 6, start: 5 },
      { end: 6, start: 5 },
    ]);
  });
});
