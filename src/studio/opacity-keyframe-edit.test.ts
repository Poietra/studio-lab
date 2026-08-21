import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { replaceDrawInProgram } from "./draw-in-edit";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { opacityKeyframeTrackFromProgram, replaceOpacityKeyframeProgram } from "./opacity-keyframe-edit";
import { insertedProgramDuration } from "./program-composition";
import { duplicatePropertyKeyframeAtTime } from "./property-keyframe-duplicate";

describe("opacity keyframe editing", () => {
  it("keeps Studio Image opacity on the Timeline keyframe path", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        {
          image: {
            asset: { assetId: "image-scene/asset:image.png", sha256: "4".repeat(64) },
            localRect: { bottom: -0.5, left: -1, right: 1, top: 0.5 },
            sampler: "nearest",
          },
          position: { x: 320, y: 180 },
          type: "ImageMobject",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "image-opacity-track",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const entityId = creation.entityIds[0]!;

    const result = replaceOpacityKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "linear", time: 2, value: 1 },
        { easing: "smooth", time: 3, value: 0.4 },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(result.kind, JSON.stringify(result.issues)).toBe("valid");
    expect(result.program.loweringStatus).toBe("unsupported");
    expect(opacityKeyframeTrackFromProgram(result.program, 0)?.keyframes).toEqual([
      { easing: "linear", time: 2, value: 1 },
      { easing: "smooth", time: 3, value: 0.4 },
    ]);
  });

  it("replaces the Studio creation Program without inserting Scene time", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "opacity-track",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const entityId = creation.entityIds[0]!;

    const result = replaceOpacityKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "ease-in", time: 2, value: 1 },
        { easing: "smooth", time: 4, value: 0 },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(result.kind, JSON.stringify(result.issues)).toBe("valid");
    expect(insertedProgramDuration(result.program)).toBe(insertedProgramDuration(creation.validation.program));
    expect(opacityKeyframeTrackFromProgram(result.program, 0)?.keyframes).toEqual([
      { easing: "ease-in", time: 2, value: 1 },
      { easing: "smooth", time: 4, value: 0 },
    ]);
    const sourceKeyframes = opacityKeyframeTrackFromProgram(result.program, 0)!.keyframes;
    const duplicated = replaceOpacityKeyframeProgram({
      baseProgram: result.program,
      entityId,
      keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, 3),
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(opacityKeyframeTrackFromProgram(duplicated.program, 0)?.keyframes).toEqual([
      { easing: "ease-in", time: 2, value: 1 },
      { easing: "smooth", time: 3, value: 0 },
      { easing: "smooth", time: 4, value: 0 },
    ]);
    expect(() =>
      replaceOpacityKeyframeProgram({
        baseProgram: result.program,
        entityId,
        keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, STUDIO_FIXTURE_SCENE.duration + 1),
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/inside the Scene/i);
    const dragged = replaceOpacityKeyframeProgram({
      baseProgram: result.program,
      entityId,
      keyframes: [
        { easing: "linear", time: 2.5, value: 1 },
        { easing: "smooth", time: 4, value: 0 },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(dragged.program.provenance.evidence).toEqual(result.program.provenance.evidence);
  });

  it("removes the final marker by restoring the same creation Program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Rectangle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "opacity-delete",
    });
    const entityId = creation.entityIds[0]!;
    const withMarker = replaceOpacityKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [{ easing: "smooth", time: 2, value: 1 }],
      scene: STUDIO_FIXTURE_SCENE,
    });
    const removed = replaceOpacityKeyframeProgram({
      baseProgram: withMarker.program,
      entityId,
      keyframes: [],
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(removed.kind, JSON.stringify(removed.issues)).toBe("valid");
    expect(opacityKeyframeTrackFromProgram(removed.program, 0)).toBeNull();
  });

  it("rejects markers through the initial Draw entrance and a second track in one creation Program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        { content: undefined, position: { x: 240, y: 180 }, type: "Circle" },
        { content: undefined, position: { x: 400, y: 180 }, type: "Rectangle" },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "shared-opacity",
    });
    const [firstId, secondId] = creation.entityIds;
    const drawEnd = 1.8;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: drawEnd },
      entityId: firstId!,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(drawn.kind, JSON.stringify(drawn.issues)).toBe("valid");
    for (const time of [drawEnd - 0.1, drawEnd]) {
      expect(() =>
        replaceOpacityKeyframeProgram({
          baseProgram: drawn.program,
          entityId: firstId!,
          keyframes: [{ easing: "smooth", time, value: 1 }],
          scene: STUDIO_FIXTURE_SCENE,
        }),
      ).toThrow(/after the object's initial entrance/i);
    }

    const firstTrack = replaceOpacityKeyframeProgram({
      baseProgram: drawn.program,
      entityId: firstId!,
      keyframes: [{ easing: "smooth", time: 2, value: 1 }],
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(() =>
      replaceOpacityKeyframeProgram({
        baseProgram: firstTrack.program,
        entityId: secondId!,
        keyframes: [{ easing: "smooth", time: 2, value: 1 }],
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/only one object/i);

    const withoutTargetCreate = {
      ...firstTrack.program,
      operations: firstTrack.program.operations.filter(
        (operation) => operation.kind !== "CreateEntity" || operation.entity.id !== firstId,
      ),
    };
    expect(opacityKeyframeTrackFromProgram(withoutTargetCreate, 0)).toBeNull();
  });
});
