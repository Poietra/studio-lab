import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { opacityKeyframeTrackFromProgram, replaceOpacityKeyframeProgram } from "./opacity-keyframe-edit";
import { insertedProgramDuration } from "./program-composition";

describe("opacity keyframe editing", () => {
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
        { easing: "linear", time: 2, value: 1 },
        { easing: "smooth", time: 4, value: 0 },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(result.kind, JSON.stringify(result.issues)).toBe("valid");
    expect(insertedProgramDuration(result.program)).toBe(insertedProgramDuration(creation.validation.program));
    expect(opacityKeyframeTrackFromProgram(result.program, 0)?.keyframes).toEqual([
      { easing: "linear", time: 2, value: 1 },
      { easing: "smooth", time: 4, value: 0 },
    ]);
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

  it("rejects markers during the initial fade and a second track in one creation Program", () => {
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
    expect(() =>
      replaceOpacityKeyframeProgram({
        baseProgram: creation.validation.program,
        entityId: firstId!,
        keyframes: [{ easing: "smooth", time: 1.2, value: 1 }],
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/after the object's initial fade/i);

    const firstTrack = replaceOpacityKeyframeProgram({
      baseProgram: creation.validation.program,
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
