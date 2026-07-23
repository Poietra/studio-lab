import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { evaluateWorkingState, programRecord } from "./evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./fixture";
import type { CanonicalEditProgram } from "./operations";
import {
  composeProgramsAtSourceAnchor,
  insertedProgramDuration,
  rebaseProgramTime,
  sourceTimeToWorkingTime,
  workingTimeToSourceTime,
} from "./program-composition";
import { validateAndScheduleProgram, type ProgramValidationResult } from "./program-validation";
import { canonicalizeSuggestionProgram, createDirectManipulationMotionProgram } from "./suggestion-program";

function validProgram(validation: ProgramValidationResult) {
  expect(validation.kind).toBe("valid");
  if (validation.kind !== "valid") throw new Error("Expected a valid fixture Program.");
  return validation.program;
}

function motionProgram(anchor: number, transactionId: string, targetEntityIds = ["equation_1"]) {
  return validProgram(createDirectManipulationMotionProgram({
    capturedPlayhead: anchor,
    controlOffset: { x: 0, y: 0 },
    delta: { x: 20, y: 0 },
    interval: { end: anchor + 1, start: anchor },
    scene: STUDIO_FIXTURE_SCENE,
    targetEntityIds,
    transactionId,
  }));
}

function record(program: CanonicalEditProgram) {
  return programRecord(program, { issues: [], kind: "valid" });
}

function transformProgram(
  sourceObjectId: string,
  transactionId: string,
  scene = STUDIO_FIXTURE_SCENE,
  label = "Maxwell equations",
) {
  return validProgram(canonicalizeSuggestionProgram({
    anchor: { kind: "playhead", referenceSeconds: 5 },
    easing: "smooth",
    end: 6,
    identityAfter: "target-replaces-source",
    kind: "create-transform",
    mismatchMode: "transform",
    sourceObjectId,
    start: 5,
    strategy: "transform-matching-tex",
    target: {
      displayLines: [label],
      kind: "mathtex",
      label,
      texParts: [label],
    },
  }, {
    capturedPlayhead: 5,
    origin: "fixture",
    scene,
    transactionId,
  }));
}

describe("inserted Program timeline composition", () => {
  it("counts an animated scale as inserted playback time but not an immediate scale", () => {
    const base = motionProgram(5, "scale-duration");
    const operation = base.operations[0]!;
    const animated: CanonicalEditProgram = {
      ...base,
      operations: [{
        ...operation,
        easing: "smooth",
        entityId: "equation_1",
        from: 1,
        interval: { end: 6.5, start: 5 },
        key: "scale",
        kind: "AnimateProperty",
        to: 1.5,
      }],
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

  it("places later applied Programs after earlier Programs at the same source anchor", () => {
    const first = motionProgram(5, "same-anchor-first");
    const second = motionProgram(5, "same-anchor-second");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [record(first), record(second)],
    }));
    const firstEvent = proposed.evaluatedScene.eventTrack.events.find((event) => (
      event.transactionId === first.transactionId && event.kind === "operation"
    ));
    const secondEvent = proposed.evaluatedScene.eventTrack.events.find((event) => (
      event.transactionId === second.transactionId && event.kind === "operation"
    ));

    expect(firstEvent?.interval).toEqual({ end: 6, start: 5 });
    expect(secondEvent?.interval).toEqual({ end: 7, start: 6 });
    expect(proposed.programs.map((entry) => entry.validation.status)).toEqual(["valid", "valid"]);
  });

  it("uses original anchors for offsets even when Programs were applied out of timeline order", () => {
    const laterFirst = motionProgram(7, "out-of-order-later-first");
    const earlierSecond = motionProgram(5, "out-of-order-earlier-second");
    const laterThird = motionProgram(7, "out-of-order-later-third");
    const proposed = evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [record(laterFirst), record(earlierSecond), record(laterThird)],
    }));
    const intervalFor = (transactionId: string) => proposed.evaluatedScene.eventTrack.events.find((event) => (
      event.transactionId === transactionId && event.kind === "operation"
    ))?.interval;

    expect(intervalFor(earlierSecond.transactionId)).toEqual({ end: 6, start: 5 });
    expect(intervalFor(laterFirst.transactionId)).toEqual({ end: 9, start: 8 });
    expect(intervalFor(laterThird.transactionId)).toEqual({ end: 10, start: 9 });
    expect(proposed.programs.map((entry) => entry.validation.status)).toEqual(["valid", "valid", "valid"]);
  });

  it("rebases operation intervals and created-entity lifetimes together", () => {
    const creation = validProgram(createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ position: { x: 120, y: 80 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "rebase-created-entity",
    }).validation);
    const rebased = rebaseProgramTime(creation, 2);
    const created = rebased.operations.find((operation) => operation.kind === "CreateEntity");

    expect(rebased.anchor.resolvedSeconds).toBe(7);
    expect(created?.interval).toEqual({ end: 7, start: 7 });
    expect(created?.kind === "CreateEntity" ? created.entity.lifetime : null).toEqual({ end: null, start: 7 });
    expect(insertedProgramDuration(rebased)).toBeCloseTo(0.4);
  });
});

describe("renderable Program composition", () => {
  it("remaps produced identities and offsets a dependent Program at one source anchor", () => {
    const creationResult = createStudioEntitiesProgram({
      capturedPlayhead: 5,
      entities: [{ position: { x: 120, y: 80 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "composition-create",
    });
    const creation = validProgram(creationResult.validation);
    const createdState = evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [record(creation)],
    }));
    const movement = validProgram(createDirectManipulationMotionProgram({
      capturedPlayhead: 5,
      controlOffset: { x: 0, y: 0 },
      delta: { x: 40, y: 0 },
      interval: { end: 6, start: 5 },
      scene: createdState.evaluatedScene,
      targetEntityIds: creationResult.entityIds,
      transactionId: "composition-move",
    }));

    const composition = composeProgramsAtSourceAnchor([creation, movement]);
    expect(composition.kind).toBe("composed");
    if (composition.kind !== "composed") return;
    const created = composition.program.operations.find((operation) => operation.kind === "CreateEntity");
    const motion = composition.program.operations.find((operation) => operation.kind === "CreateMotion");
    expect(created?.kind).toBe("CreateEntity");
    expect(motion?.kind).toBe("CreateMotion");
    if (created?.kind !== "CreateEntity" || motion?.kind !== "CreateMotion") return;
    expect(created.entity.id).toMatch(new RegExp(`^tx:${composition.program.transactionId}/entity:`));
    expect(motion.targetEntityIds).toEqual([created.entity.id]);
    expect(motion.interval).toEqual({ end: 6.4, start: 5.4 });
    expect(composition.program.operations.every((operation) => (
      operation.id.startsWith(`tx:${composition.program.transactionId}/operation:`)
    ))).toBe(true);

    const validation = validateAndScheduleProgram(composition.program, STUDIO_FIXTURE_SCENE);
    expect(validation.kind).toBe("valid");
    expect(validation.program.schedule.edges).toContainEqual(expect.objectContaining({
      reason: "identity",
      to: motion.id,
    }));
  });

  it("preserves a transform identity chain split across applied Programs", () => {
    const first = transformProgram("equation_1", "composition-transform-first");
    const firstTransform = first.operations.find((operation) => operation.kind === "TransformContent");
    expect(firstTransform?.kind).toBe("TransformContent");
    if (firstTransform?.kind !== "TransformContent") return;
    const afterFirst = evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [record(first)],
    }));
    const second = transformProgram(
      firstTransform.targetEntityId,
      "composition-transform-second",
      afterFirst.evaluatedScene,
      "E = mc²",
    );

    const evaluated = evaluateWorkingState(createFixtureWorkingState({
      appliedPrograms: [record(first), record(second)],
    }));
    const intervals = evaluated.evaluatedScene.eventTrack.events.filter((event) => (
      event.kind === "operation" && [first.transactionId, second.transactionId].includes(event.transactionId ?? "")
    )).map((event) => event.interval);
    expect(intervals).toEqual([{ end: 6, start: 5 }, { end: 7, start: 6 }]);

    const composition = composeProgramsAtSourceAnchor([first, second]);
    expect(composition.kind).toBe("composed");
    if (composition.kind !== "composed") return;
    const transforms = composition.program.operations.filter((operation) => operation.kind === "TransformContent");
    const [composedFirst, composedSecond] = transforms;
    expect(composedFirst?.kind).toBe("TransformContent");
    expect(composedSecond?.kind).toBe("TransformContent");
    if (composedFirst?.kind !== "TransformContent" || composedSecond?.kind !== "TransformContent") return;
    expect(composedSecond.sourceEntityId).toBe(composedFirst.targetEntityId);
    expect(composedSecond.interval).toEqual({ end: 7, start: 6 });
    expect(validateAndScheduleProgram(composition.program, STUDIO_FIXTURE_SCENE).kind).toBe("valid");
  });

  it("remaps ModifyMotion operation references into the composite transaction", () => {
    const motion = motionProgram(5, "composition-motion-source");
    const sourceMotion = motion.operations.find((operation) => operation.kind === "CreateMotion");
    expect(sourceMotion?.kind).toBe("CreateMotion");
    if (sourceMotion?.kind !== "CreateMotion") return;
    const modify: CanonicalEditProgram = {
      ...motion,
      intentCount: 1,
      loweringStatus: "illustrative",
      operations: [{
        controlOffset: { x: 0, y: -20 },
        dependsOn: [],
        id: "tx:composition-modify/operation:modify",
        interval: { end: 6, start: 5 },
        kind: "ModifyMotion",
        motionId: sourceMotion.id,
        preserve: ["duration", "end", "start"],
        provenance: { evidence: [], origin: "fixture" },
      }],
      schedule: { edges: [], mode: "sequence", order: ["tx:composition-modify/operation:modify"] },
      transactionId: "composition-modify",
    };

    const composition = composeProgramsAtSourceAnchor([motion, modify]);
    expect(composition.kind).toBe("composed");
    if (composition.kind !== "composed") return;
    const composedMotion = composition.program.operations.find((operation) => operation.kind === "CreateMotion");
    const composedModify = composition.program.operations.find((operation) => operation.kind === "ModifyMotion");
    expect(composedModify?.kind === "ModifyMotion" ? composedModify.motionId : null).toBe(composedMotion?.id);
  });

  it("supports more than three intents in a render composition", () => {
    const programs = [0, 1, 2, 3].map((index) => motionProgram(5, `many-intents-${index}`));
    const composition = composeProgramsAtSourceAnchor(programs);
    expect(composition.kind).toBe("composed");
    if (composition.kind !== "composed") return;
    expect(composition.program.intentCount).toBe(4);
    expect(validateAndScheduleProgram(composition.program, STUDIO_FIXTURE_SCENE).kind).toBe("valid");
  });

  it("returns an explicit incompatibility for different source anchors", () => {
    const composition = composeProgramsAtSourceAnchor([
      motionProgram(5, "different-anchor-first"),
      motionProgram(6, "different-anchor-second"),
    ]);

    expect(composition).toEqual({
      kind: "incompatible",
      message: "Programs from different source anchors cannot be rendered or exported as one source insertion.",
    });
  });
});
