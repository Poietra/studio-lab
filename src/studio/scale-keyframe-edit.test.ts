import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { replaceOpacityKeyframeProgram } from "./opacity-keyframe-edit";
import { insertedProgramDuration } from "./program-composition";
import { appendScaleKeyframe, replaceScaleKeyframeProgram, scaleKeyframeTrackFromProgram } from "./scale-keyframe-edit";

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
        { easing: "linear", time: 2, value: 1 },
        { easing: "smooth", time: 4, value: 2 },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(tracked.kind, JSON.stringify(tracked.issues)).toBe("valid");
    expect(tracked.program.loweringStatus).toBe("unsupported");
    expect(insertedProgramDuration(tracked.program)).toBe(insertedProgramDuration(creation.validation.program));
    expect(scaleKeyframeTrackFromProgram(tracked.program, 0)?.keyframes).toEqual([
      { easing: "linear", time: 2, value: 1 },
      { easing: "smooth", time: 4, value: 2 },
    ]);

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
  });

  it("keeps the first marker at the Rust baseline and insertion append-only", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Rectangle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "scale-baseline",
    });
    const entityId = creation.entityIds[0]!;
    const fadeEnd = Math.max(
      ...creation.validation.program.operations.flatMap((operation) =>
        operation.kind === "ChangePresence" && operation.effect === "fade-in" ? [operation.interval.end] : [],
      ),
    );

    expect(() =>
      replaceScaleKeyframeProgram({
        baseProgram: creation.validation.program,
        baseline: 1,
        entityId,
        keyframes: [{ easing: "smooth", time: 2, value: 1.5 }],
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/baseline scale/i);
    expect(() =>
      replaceScaleKeyframeProgram({
        baseProgram: creation.validation.program,
        baseline: 1,
        entityId,
        keyframes: [{ easing: "smooth", time: fadeEnd, value: 1 }],
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/initial fade/i);
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
