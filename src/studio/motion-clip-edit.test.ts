import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import {
  adjustAppliedMotionClipControl,
  appliedMotionClipReadOnlyReason,
  retimeAppliedMotionClip,
  setMotionSpinDegrees,
} from "./motion-clip-edit";
import { samplePropertyValue } from "./property-sampling";
import { canonicalizeSuggestionProgram } from "./suggestion-program";

function canonical(operation: EditSuggestionOperation, scene = STUDIO_FIXTURE_SCENE) {
  const result = canonicalizeSuggestionProgram(operation, {
    capturedPlayhead: 5,
    origin: "fixture",
    scene,
    transactionId: "motion-clip-edit",
  });
  expect(result.kind).toBe("valid");
  if (result.kind !== "valid") throw new Error("Expected a valid motion fixture.");
  return result.program;
}

const motion = {
  anchor: { kind: "absolute", seconds: 5 },
  controlOffset: { x: 0, y: -20 },
  delta: { x: 80, y: 0 },
  easing: "smooth",
  end: 6,
  kind: "create-motion",
  start: 5,
  targetObjectIds: ["equation_1"],
} satisfies EditSuggestionOperation;

const STUDIO_CREATED_ENTITY_ID = "tx:motion-clip/entity:circle";
const studioMotion = { ...motion, targetObjectIds: [STUDIO_CREATED_ENTITY_ID] } satisfies EditSuggestionOperation;
const studioScene = {
  ...STUDIO_FIXTURE_SCENE,
  objectGraph: {
    ...STUDIO_FIXTURE_SCENE.objectGraph,
    entities: {
      ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
      [STUDIO_CREATED_ENTITY_ID]: {
        id: STUDIO_CREATED_ENTITY_ID,
        lifetime: [{ end: STUDIO_FIXTURE_SCENE.duration, start: 0 }],
        provisional: false,
        sourceIdentity: { kind: "unknown" as const, reason: "Created in Studio." },
        transactionId: "motion-clip",
        type: "Circle",
      },
    },
  },
};

describe("applied motion clip editing", () => {
  it("retimes the authoring operation matched to a canonical motion identity", () => {
    const program = canonical(motion);
    const canonicalMotion = program.operations.find((operation) => operation.kind === "CreateMotion");
    expect(canonicalMotion).toBeDefined();
    if (!canonicalMotion) return;

    const result = retimeAppliedMotionClip({
      duration: 1.75,
      operation: motion,
      operationId: canonicalMotion.id,
      program,
      start: 7,
    });

    expect(result).toMatchObject({
      kind: "valid",
      operation: { anchor: { kind: "absolute", seconds: 7 }, end: 8.75, start: 7 },
      stepIndex: 0,
    });
  });

  it("adds, updates, removes, and preserves one relative spin", () => {
    const addedStep = setMotionSpinDegrees(studioMotion, 360);
    expect(addedStep.rotationDeltaRadians).toBeCloseTo(2 * Math.PI);
    const updated = setMotionSpinDegrees(addedStep, -180);
    expect(updated.rotationDeltaRadians).toBeCloseTo(-Math.PI);
    expect(setMotionSpinDegrees(updated, 0)).not.toHaveProperty("rotationDeltaRadians");

    const added = {
      ...studioMotion,
      rotationDeltaRadians: addedStep.rotationDeltaRadians,
    } satisfies EditSuggestionOperation;
    const program = canonical(added, studioScene);
    const canonicalMotion = program.operations.find((operation) => operation.kind === "CreateMotion");
    if (!canonicalMotion) throw new Error("Expected a canonical motion.");
    expect(canonicalMotion.rotationDeltaRadians).toBeCloseTo(2 * Math.PI);
    const retimed = retimeAppliedMotionClip({
      duration: 2,
      operation: added,
      operationId: canonicalMotion.id,
      program,
      start: 7,
    });
    expect(retimed.kind).toBe("valid");
    if (retimed.kind !== "valid" || retimed.operation.kind !== "create-motion") return;
    expect(retimed.operation.rotationDeltaRadians).toBeCloseTo(2 * Math.PI);
  });

  it("retimes every parallel step as one composed interval", () => {
    const operation = {
      anchor: { kind: "absolute", seconds: 5 },
      execution: "parallel",
      kind: "edit-program",
      operations: [
        {
          controlOffset: motion.controlOffset,
          delta: motion.delta,
          easing: motion.easing,
          end: motion.end,
          kind: motion.kind,
          start: motion.start,
          targetObjectIds: motion.targetObjectIds,
        },
        {
          animation: "fade-in" as const,
          end: 6,
          kind: "create-explanation" as const,
          objectKind: "text" as const,
          placement: "below" as const,
          start: 5,
          targetObjectId: "equation_1",
          text: "Motion explanation",
        },
      ],
    } satisfies EditSuggestionOperation;
    const program = canonical(operation);
    const canonicalMotion = program.operations.find((candidate) => candidate.kind === "CreateMotion");
    if (!canonicalMotion) throw new Error("Expected a canonical motion.");

    const result = retimeAppliedMotionClip({
      duration: 2,
      operation,
      operationId: canonicalMotion.id,
      program,
      start: 7,
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid" || result.operation.kind !== "edit-program") return;
    expect(result.operation.operations.map(({ start, end }) => ({ end, start }))).toEqual([
      { end: 9, start: 7 },
      { end: 9, start: 7 },
    ]);
  });

  it("explicitly rejects overlap with a previous sequential step", () => {
    const operation = {
      anchor: { kind: "absolute", seconds: 5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          animation: "fade-in",
          end: 6,
          kind: "create-explanation",
          objectKind: "text",
          placement: "below",
          start: 5,
          targetObjectId: "equation_1",
          text: "Motion explanation",
        },
        {
          controlOffset: motion.controlOffset,
          delta: motion.delta,
          easing: motion.easing,
          end: 7,
          kind: motion.kind,
          start: 6,
          targetObjectIds: motion.targetObjectIds,
        },
      ],
    } satisfies EditSuggestionOperation;
    const program = canonical(operation);
    const canonicalMotion = program.operations.find((candidate) => candidate.kind === "CreateMotion");
    if (!canonicalMotion) throw new Error("Expected a canonical motion.");

    expect(
      retimeAppliedMotionClip({
        duration: 1,
        operation,
        operationId: canonicalMotion.id,
        program,
        start: 5.5,
      }),
    ).toEqual({
      kind: "invalid",
      message:
        "The motion clip would overlap the previous sequential step. Move it after that step or switch the Program to parallel execution.",
    });
  });

  it("marks canonical motion without authoring metadata as read-only", () => {
    const program = canonical(motion);
    const canonicalMotion = program.operations.find((operation) => operation.kind === "CreateMotion");
    if (!canonicalMotion) throw new Error("Expected a canonical motion.");
    expect(appliedMotionClipReadOnlyReason(program, null, canonicalMotion.id)).toMatch(/metadata is unavailable/i);
  });

  it("adjusts only the selected control without rescheduling any composed interval", () => {
    const operation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          controlOffset: { x: 0, y: -10 },
          delta: { x: 40, y: 0 },
          easing: "smooth",
          end: 6,
          kind: "create-motion",
          start: 5,
          targetObjectIds: ["equation_1"],
        },
        {
          controlOffset: { x: 5, y: 10 },
          delta: { x: -20, y: 30 },
          easing: "smooth",
          end: 8,
          kind: "create-motion",
          start: 7,
          targetObjectIds: ["equation_1"],
        },
      ],
    } satisfies EditSuggestionOperation;
    const program = canonical(operation);
    const canonicalMotions = program.operations.filter((candidate) => candidate.kind === "CreateMotion");
    expect(canonicalMotions).toHaveLength(2);

    const result = adjustAppliedMotionClipControl({
      delta: { x: 7, y: -4 },
      operation,
      operationId: canonicalMotions[0].id,
      program,
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid" || result.operation.kind !== "edit-program") return;
    expect(result.stepIndex).toBe(0);
    expect(result.operation.anchor).toBe(operation.anchor);
    expect(result.operation.operations.map(({ start, end }) => ({ end, start }))).toEqual([
      { end: 6, start: 5 },
      { end: 8, start: 7 },
    ]);
    expect(
      result.operation.operations.map((step) => (step.kind === "create-motion" ? step.controlOffset : null)),
    ).toEqual([
      { x: 7, y: -14 },
      { x: 5, y: 10 },
    ]);
  });

  it("samples canonical easing consistently in the working preview", () => {
    const base = {
      from: 0,
      interval: { end: 1, start: 0 },
      kind: "animated" as const,
      provenanceId: "motion-easing",
      value: 100,
    };
    expect(samplePropertyValue([{ ...base, easing: "linear" }], 0.25)).toBeCloseTo(25);
    expect(samplePropertyValue([{ ...base, easing: "smooth" }], 0.25)).toBeCloseTo(15.625);
    expect(samplePropertyValue([{ ...base, easing: "manim-smooth" }], 0.25)).toBeCloseTo(7.010371654);
    expect(
      samplePropertyValue([{ ...base, easing: { kind: "cubic-bezier", x1: 0.42, x2: 1, y1: 0, y2: 1 } }], 0.5),
    ).toBeCloseTo(31.53568, 4);
  });
});
