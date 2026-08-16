import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { STUDIO_FIXTURE_SCENE, validateMotionProgramFixture } from "./fixture";
import type { CanonicalEditProgram } from "./operations";
import {
  insertedProgramDuration,
  latestSafeSourceAnchor,
  rebaseProgramTime,
  sourceTimeToWorkingTime,
  workingTimeToSourceTime,
} from "./program-composition";
import type { ProgramValidationResult } from "./program-validation";

function validProgram(validation: ProgramValidationResult) {
  expect(validation.kind).toBe("valid");
  if (validation.kind !== "valid") throw new Error("Expected a valid fixture Program.");
  return validation.program;
}

function motionProgram(anchor: number, transactionId: string, targetEntityIds = ["equation_1"]) {
  return validProgram(
    validateMotionProgramFixture({
      capturedPlayhead: anchor,
      controlOffset: { x: 0, y: 0 },
      delta: { x: 20, y: 0 },
      interval: { end: anchor + 1, start: anchor },
      scene: STUDIO_FIXTURE_SCENE,
      targetEntityIds,
      transactionId,
    }),
  );
}

function timelineWaitProgram(): CanonicalEditProgram {
  const base = motionProgram(5, "timeline-wait");
  return {
    ...base,
    operations: [
      {
        dependsOn: [],
        eventKind: "wait",
        id: "timeline-wait/operation",
        interval: { end: 6, start: 5 },
        kind: "InsertTimelineEvent",
        label: "Wait",
        provenance: { evidence: [], origin: "studio-default" },
        purpose: "scene-duration",
      },
    ],
    schedule: { edges: [], mode: "sequence", order: ["timeline-wait/operation"] },
  };
}

describe("inserted Program timeline composition", () => {
  it("counts an animated scale as inserted playback time but not an immediate scale", () => {
    const base = motionProgram(5, "scale-duration");
    const operation = base.operations[0]!;
    const animated: CanonicalEditProgram = {
      ...base,
      operations: [
        {
          ...operation,
          easing: "smooth",
          entityId: "equation_1",
          from: 1,
          interval: { end: 6.5, start: 5 },
          key: "scale",
          kind: "AnimateProperty",
          to: 1.5,
        },
      ],
    };
    const immediate: CanonicalEditProgram = {
      ...animated,
      operations: [{ ...animated.operations[0]!, interval: { end: 5, start: 5 } }],
    };

    expect(insertedProgramDuration(animated)).toBe(1.5);
    expect(insertedProgramDuration(immediate)).toBe(0);
  });

  it("maps source and working time without applying insertion offsets twice", () => {
    const atFive = motionProgram(5, "time-map-five");
    const atSeven = motionProgram(7, "time-map-seven");
    const programs = [atSeven, atFive];

    expect(sourceTimeToWorkingTime(programs, 4)).toBe(4);
    expect(sourceTimeToWorkingTime(programs, 5)).toBe(6);
    expect(sourceTimeToWorkingTime(programs, 7)).toBe(9);
    expect(workingTimeToSourceTime(programs, 5.5)).toBe(5);
    expect(workingTimeToSourceTime(programs, 6.5)).toBe(5.5);
    expect(workingTimeToSourceTime(programs, 8.5)).toBe(7);
    expect(workingTimeToSourceTime(programs, 10)).toBe(8);
  });

  it("does not re-evaluate or rebase timeline Programs in TypeScript", () => {
    const timeline = timelineWaitProgram();

    expect(() => sourceTimeToWorkingTime([timeline], 5)).toThrow(/Rust timeline projection/i);
    expect(() => workingTimeToSourceTime([timeline], 5)).toThrow(/Rust timeline projection/i);
    expect(() => latestSafeSourceAnchor([timeline], [5], 5)).toThrow(/Rust timeline projection/i);
    expect(() => rebaseProgramTime(timeline, 1)).toThrow(/Rust timeline projection/i);
  });

  it("resolves manual edits to the latest prior safe anchor after existing insertions", () => {
    const atFive = motionProgram(5, "safe-anchor-five");
    const atSeven = motionProgram(7, "safe-anchor-seven");
    const programs = [atFive, atSeven];

    expect(latestSafeSourceAnchor(programs, [5, 7], 5.5)).toEqual({
      sourceTime: 5,
      workingTime: 6,
    });
    expect(latestSafeSourceAnchor(programs, [5, 7], 6.5)).toEqual({
      sourceTime: 5,
      workingTime: 6,
    });
    expect(latestSafeSourceAnchor(programs, [5, 7], 8.5)).toEqual({
      sourceTime: 7,
      workingTime: 9,
    });
    expect(latestSafeSourceAnchor(programs, [5, 7], 4.9)).toBeNull();
  });

  it("rebases operation intervals and created-entity lifetimes together", () => {
    const creation = validProgram(
      createStudioEntitiesProgram({
        capturedPlayhead: 5,
        entities: [{ position: { x: 120, y: 80 }, type: "Circle" }],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: "rebase-created-entity",
      }).validation,
    );
    const rebased = rebaseProgramTime(creation, 2);
    const created = rebased.operations.find((operation) => operation.kind === "CreateEntity");

    expect(rebased.anchor.resolvedSeconds).toBe(7);
    expect(created?.interval).toEqual({ end: 7, start: 7 });
    expect(created?.kind === "CreateEntity" ? created.entity.lifetime : null).toEqual({ end: null, start: 7 });
    expect(insertedProgramDuration(rebased)).toBeCloseTo(0.4);
  });
});
