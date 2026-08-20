import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { replaceOpacityKeyframeProgram } from "./opacity-keyframe-edit";
import { insertedProgramDuration } from "./program-composition";
import { duplicatePropertyKeyframeAtTime } from "./property-keyframe-duplicate";
import {
  appendRotationKeyframe,
  replaceRotationKeyframeProgram,
  rotationKeyframeTrackFromProgram,
  rotationKeyframeTransformConflictEntity,
} from "./rotation-keyframe-edit";
import { replaceScaleKeyframeProgram } from "./scale-keyframe-edit";

describe("rotation keyframe editing", () => {
  it("stores one Studio-created rotation track without inserting Scene time", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "rotation-track",
    });
    const entityId = creation.entityIds[0]!;

    const tracked = replaceRotationKeyframeProgram({
      baseProgram: creation.validation.program,
      baseline: 0,
      entityId,
      keyframes: [
        { easing: "ease-in", time: 2, value: 0 },
        { easing: "smooth", time: 4, value: 5 * Math.PI },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(tracked.kind, JSON.stringify(tracked.issues)).toBe("valid");
    expect(tracked.program.loweringStatus).toBe("unsupported");
    expect(insertedProgramDuration(tracked.program)).toBe(insertedProgramDuration(creation.validation.program));
    expect(rotationKeyframeTrackFromProgram(tracked.program, 0)?.keyframes).toEqual([
      { easing: "ease-in", time: 2, value: 0 },
      { easing: "smooth", time: 4, value: 5 * Math.PI },
    ]);
    const sourceKeyframes = rotationKeyframeTrackFromProgram(tracked.program, 0)!.keyframes;
    const duplicated = replaceRotationKeyframeProgram({
      baseProgram: tracked.program,
      baseline: 0,
      entityId,
      keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, 3),
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(rotationKeyframeTrackFromProgram(duplicated.program, 0)?.keyframes).toEqual([
      { easing: "ease-in", time: 2, value: 0 },
      { easing: "smooth", time: 3, value: 5 * Math.PI },
      { easing: "smooth", time: 4, value: 5 * Math.PI },
    ]);
    expect(() =>
      replaceRotationKeyframeProgram({
        baseProgram: tracked.program,
        baseline: 0,
        entityId,
        keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, STUDIO_FIXTURE_SCENE.duration + 1),
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/inside the Scene/i);
    expect(rotationKeyframeTransformConflictEntity([tracked.program], [entityId])).toBe(entityId);
    expect(rotationKeyframeTransformConflictEntity([tracked.program], ["another-entity"])).toBeNull();

    const removed = replaceRotationKeyframeProgram({
      baseProgram: tracked.program,
      baseline: 0,
      entityId,
      keyframes: [],
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(removed.kind, JSON.stringify(removed.issues)).toBe("valid");
    expect(removed.program.loweringStatus).toBe("supported");
    expect(rotationKeyframeTrackFromProgram(removed.program, 0)).toBeNull();
  });

  it("keeps the first marker at the Rust baseline and insertion append-only", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Rectangle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "rotation-baseline",
    });
    const entityId = creation.entityIds[0]!;
    const fadeEnd = Math.max(
      ...creation.validation.program.operations.flatMap((operation) =>
        operation.kind === "ChangePresence" && operation.effect === "fade-in" ? [operation.interval.end] : [],
      ),
    );

    expect(() =>
      replaceRotationKeyframeProgram({
        baseProgram: creation.validation.program,
        baseline: 0,
        entityId,
        keyframes: [{ easing: "smooth", time: 2, value: Math.PI }],
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/baseline rotation/i);
    expect(() =>
      replaceRotationKeyframeProgram({
        baseProgram: creation.validation.program,
        baseline: 0,
        entityId,
        keyframes: [{ easing: "smooth", time: fadeEnd, value: 0 }],
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/initial fade/i);
    expect(() => appendRotationKeyframe([{ easing: "smooth", time: 3, value: 0 }], 2.5, 0)).toThrow(
      /after the final marker/i,
    );
    expect(appendRotationKeyframe([{ easing: "smooth", time: 3, value: Math.PI }], 4, 0)).toEqual([
      { easing: "smooth", time: 3, value: Math.PI },
      { easing: "smooth", time: 4, value: Math.PI },
    ]);
  });

  it("coexists with opacity but rejects the competing scale track", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "rotation-opacity",
    });
    const entityId = creation.entityIds[0]!;
    const opacity = replaceOpacityKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [{ easing: "smooth", time: 3, value: 1 }],
      scene: STUDIO_FIXTURE_SCENE,
    });
    const rotation = replaceRotationKeyframeProgram({
      baseProgram: opacity.program,
      baseline: 0,
      entityId,
      keyframes: [
        { easing: "linear", time: 2, value: 0 },
        { easing: "smooth", time: 4, value: Math.PI },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(rotation.kind, JSON.stringify(rotation.issues)).toBe("valid");

    const scale = replaceScaleKeyframeProgram({
      baseProgram: opacity.program,
      baseline: 1,
      entityId,
      keyframes: [
        { easing: "linear", time: 2, value: 1 },
        { easing: "smooth", time: 4, value: 2 },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(() =>
      replaceRotationKeyframeProgram({
        baseProgram: scale.program,
        baseline: 0,
        entityId,
        keyframes: [{ easing: "smooth", time: 2, value: 0 }],
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/scale or rotation edit/i);
  });
});
