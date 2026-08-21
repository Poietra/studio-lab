import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { replaceDrawInProgram } from "./draw-in-edit";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { replaceOpacityKeyframeProgram } from "./opacity-keyframe-edit";
import { insertedProgramDuration } from "./program-composition";
import { duplicatePropertyKeyframeAtTime } from "./property-keyframe-duplicate";
import {
  appendScaleKeyframe,
  replaceScaleKeyframeProgram,
  scaleKeyframeTrackFromProgram,
  scaleKeyframeTransformConflictEntity,
} from "./scale-keyframe-edit";

describe("uniform scale keyframe editing", () => {
  it("stores one Studio-created scale track without inserting Scene time", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "scale-track",
    });
    const entityId = creation.entityIds[0]!;

    const tracked = replaceScaleKeyframeProgram({
      baseProgram: creation.validation.program,
      baseline: 1,
      entityId,
      keyframes: [
        { easing: "ease-in-out", time: 2, value: 1 },
        { easing: "smooth", time: 4, value: 2 },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(tracked.kind, JSON.stringify(tracked.issues)).toBe("valid");
    expect(tracked.program.loweringStatus).toBe("unsupported");
    expect(insertedProgramDuration(tracked.program)).toBe(insertedProgramDuration(creation.validation.program));
    expect(scaleKeyframeTrackFromProgram(tracked.program, 0)?.keyframes).toEqual([
      { easing: "ease-in-out", time: 2, value: 1 },
      { easing: "smooth", time: 4, value: 2 },
    ]);
    const sourceKeyframes = scaleKeyframeTrackFromProgram(tracked.program, 0)!.keyframes;
    const duplicated = replaceScaleKeyframeProgram({
      baseProgram: tracked.program,
      baseline: 1,
      entityId,
      keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, 3),
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(scaleKeyframeTrackFromProgram(duplicated.program, 0)?.keyframes).toEqual([
      { easing: "ease-in-out", time: 2, value: 1 },
      { easing: "smooth", time: 3, value: 2 },
      { easing: "smooth", time: 4, value: 2 },
    ]);
    expect(() =>
      replaceScaleKeyframeProgram({
        baseProgram: tracked.program,
        baseline: 1,
        entityId,
        keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, STUDIO_FIXTURE_SCENE.duration + 1),
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/inside the Scene/i);
    expect(scaleKeyframeTransformConflictEntity([tracked.program], [entityId])).toBe(entityId);
    expect(scaleKeyframeTransformConflictEntity([tracked.program], ["another-entity"])).toBeNull();

    const removed = replaceScaleKeyframeProgram({
      baseProgram: tracked.program,
      baseline: 1,
      entityId,
      keyframes: [],
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(removed.kind, JSON.stringify(removed.issues)).toBe("valid");
    expect(removed.program.loweringStatus).toBe("supported");
    expect(scaleKeyframeTrackFromProgram(removed.program, 0)).toBeNull();
    expect(scaleKeyframeTransformConflictEntity([removed.program], [entityId])).toBeNull();
  });

  it("keeps the first marker at the Rust baseline, after Draw, and insertion append-only", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Rectangle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "scale-baseline",
    });
    const entityId = creation.entityIds[0]!;
    const drawEnd = 2.5;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: drawEnd },
      entityId,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(drawn.kind, JSON.stringify(drawn.issues)).toBe("valid");

    expect(() =>
      replaceScaleKeyframeProgram({
        baseProgram: drawn.program,
        baseline: 1,
        entityId,
        keyframes: [{ easing: "smooth", time: 3, value: 1.5 }],
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/baseline scale/i);
    for (const time of [drawEnd - 0.1, drawEnd]) {
      expect(() =>
        replaceScaleKeyframeProgram({
          baseProgram: drawn.program,
          baseline: 1,
          entityId,
          keyframes: [{ easing: "smooth", time, value: 1 }],
          scene: STUDIO_FIXTURE_SCENE,
        }),
      ).toThrow(/initial entrance/i);
    }
    expect(() => appendScaleKeyframe([{ easing: "smooth", time: 3, value: 1 }], 2.5, 1)).toThrow(
      /after the final marker/i,
    );
    expect(appendScaleKeyframe([{ easing: "smooth", time: 3, value: 1.5 }], 4, 1)).toEqual([
      { easing: "smooth", time: 3, value: 1.5 },
      { easing: "smooth", time: 4, value: 1.5 },
    ]);
  });

  it("coexists with an opacity marker inside the scale interval", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "scale-opacity",
    });
    const entityId = creation.entityIds[0]!;
    const opacity = replaceOpacityKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [{ easing: "smooth", time: 3, value: 1 }],
      scene: STUDIO_FIXTURE_SCENE,
    });

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

    expect(scale.kind, JSON.stringify(scale.issues)).toBe("valid");
  });
});
