import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { drawInClipFromProgram, replaceDrawInProgram } from "./draw-in-edit";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import {
  appendMaterialParameterKeyframe,
  materialParameterAssignmentBlocker,
  materialParameterIdentityEditBlocker,
  materialParameterKeyframeTrackFromProgram,
  replaceMaterialParameterKeyframeProgram,
} from "./material-parameter-keyframe-edit";
import { opacityKeyframeTrackFromProgram, replaceOpacityKeyframeProgram } from "./opacity-keyframe-edit";
import { insertedProgramDuration } from "./program-composition";
import { duplicatePropertyKeyframeAtTime } from "./property-keyframe-duplicate";

const material = {
  parameters: [0.35, 8],
  revision: 1,
  shaderId: "project-wave",
} as const;

describe("material parameter keyframe editing", () => {
  it("stores one named f32 track in the Studio creation Program without inserting Scene time", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-track",
    });
    const entityId = creation.entityIds[0]!;
    const result = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "ease-out", time: 2, value: 0.35 },
        { easing: "smooth", time: 4, value: 0.8 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(result.kind, JSON.stringify(result.issues)).toBe("valid");
    expect(result.program.loweringStatus).toBe("unsupported");
    expect(insertedProgramDuration(result.program)).toBe(insertedProgramDuration(creation.validation.program));
    expect(materialParameterKeyframeTrackFromProgram(result.program, 0)).toMatchObject({
      entityId,
      keyframes: [
        { easing: "ease-out", time: 2, value: 0.35 },
        { easing: "smooth", time: 4, value: 0.8 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
    });
    const sourceKeyframes = materialParameterKeyframeTrackFromProgram(result.program, 0)!.keyframes;
    const duplicated = replaceMaterialParameterKeyframeProgram({
      baseProgram: result.program,
      entityId,
      keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, 3),
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(materialParameterKeyframeTrackFromProgram(duplicated.program, 0)?.keyframes).toEqual([
      { easing: "ease-out", time: 2, value: 0.35 },
      { easing: "smooth", time: 3, value: 0.8 },
      { easing: "smooth", time: 4, value: 0.8 },
    ]);
    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: result.program,
        entityId,
        keyframes: duplicatePropertyKeyframeAtTime(sourceKeyframes, 1, STUDIO_FIXTURE_SCENE.duration + 1),
        material,
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/inside the Scene/i);
    const removed = replaceMaterialParameterKeyframeProgram({
      baseProgram: result.program,
      entityId,
      keyframes: [],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(removed.program.loweringStatus).toBe("supported");
    expect(removed.program.provenance.evidence).not.toContain("Studio material f32 parameter keyframes");
    expect(materialParameterKeyframeTrackFromProgram(removed.program, 0)).toBeNull();
  });

  it("coexists with opacity and fails closed when the assigned material changes", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-and-opacity",
    });
    const entityId = creation.entityIds[0]!;
    const withOpacity = replaceOpacityKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "smooth", time: 2, value: 1 },
        { easing: "linear", time: 4, value: 0.5 },
      ],
      scene: STUDIO_FIXTURE_SCENE,
    });
    const withBoth = replaceMaterialParameterKeyframeProgram({
      baseProgram: withOpacity.program,
      entityId,
      keyframes: [
        { easing: "smooth", time: 2.5, value: 0.35 },
        { easing: "linear", time: 4.5, value: 0.7 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(withBoth.kind, JSON.stringify(withBoth.issues)).toBe("valid");
    expect(opacityKeyframeTrackFromProgram(withBoth.program, 0)).not.toBeNull();
    expect(materialParameterKeyframeTrackFromProgram(withBoth.program, 0)).not.toBeNull();
    expect(materialParameterAssignmentBlocker([withBoth.program], { [entityId]: material })).toBeNull();
    expect(
      materialParameterAssignmentBlocker([withBoth.program], {
        [entityId]: { ...material, revision: 2 },
      }),
    ).toMatch(/no longer matches/i);
    expect(materialParameterAssignmentBlocker([withBoth.program], {})).toMatch(/restore that material/i);
    const opacityOnly = replaceMaterialParameterKeyframeProgram({
      baseProgram: withBoth.program,
      entityId,
      keyframes: [],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(opacityOnly.program.loweringStatus).toBe("unsupported");
    expect(opacityOnly.program.provenance.evidence).not.toContain("Studio material f32 parameter keyframes");
    expect(opacityKeyframeTrackFromProgram(opacityOnly.program, 0)).not.toBeNull();
  });

  it("rejects stale material identity and changing the fixed baseline marker", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-stale",
    });
    const entityId = creation.entityIds[0]!;
    const first = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [{ easing: "smooth", time: 2, value: 0.35 }],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: first.program,
        entityId,
        keyframes: [{ easing: "smooth", time: 2, value: 0.5 }],
        material,
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/first material keyframe/i);
    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: first.program,
        entityId,
        keyframes: [{ easing: "smooth", time: 2, value: 0.4 }],
        material: { ...material, parameters: [0.4, 8], revision: 2 },
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/one material parameter track/i);

    const recovered = replaceMaterialParameterKeyframeProgram({
      baseProgram: first.program,
      entityId,
      keyframes: [],
      material: { ...material, parameters: [0.4, 8], revision: 2 },
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(recovered.kind, JSON.stringify(recovered.issues)).toBe("valid");
    expect(materialParameterKeyframeTrackFromProgram(recovered.program, 0)).toBeNull();
  });

  it("keeps keyframe insertion append-only and composes a Line material track with Draw in either order", () => {
    expect(() => appendMaterialParameterKeyframe([{ easing: "smooth", time: 3, value: 0.35 }], 2.5, 0.35)).toThrow(
      /after the final marker/i,
    );
    expect(appendMaterialParameterKeyframe([{ easing: "smooth", time: 3, value: 0.6 }], 4, 0.35)).toEqual([
      { easing: "smooth", time: 3, value: 0.6 },
      { easing: "smooth", time: 4, value: 0.6 },
    ]);

    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Line" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-entrance-guard",
    });
    const entityId = creation.entityIds[0]!;
    const drawEnd = 2.5;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: drawEnd },
      entityId,
      fragmentMaterial: { texture: false },
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(drawn.kind, JSON.stringify(drawn.issues)).toBe("valid");
    const drawThenKeyframes = replaceMaterialParameterKeyframeProgram({
      baseProgram: drawn.program,
      entityId,
      fragmentMaterial: { texture: false },
      keyframes: [
        { easing: "smooth", time: 1.25, value: 0.35 },
        { easing: "linear", time: 2, value: 0.7 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(drawThenKeyframes.kind, JSON.stringify(drawThenKeyframes.issues)).toBe("valid");
    expect(drawInClipFromProgram(drawThenKeyframes.program)?.interval.end).toBe(drawEnd);
    expect(materialParameterKeyframeTrackFromProgram(drawThenKeyframes.program, 0)?.keyframes).toHaveLength(2);

    const edited = replaceMaterialParameterKeyframeProgram({
      baseProgram: drawThenKeyframes.program,
      entityId,
      fragmentMaterial: { texture: false },
      keyframes: [
        { easing: "smooth", time: 1.25, value: 0.35 },
        { easing: "ease-out", time: 2.25, value: 0.9 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(edited.kind, JSON.stringify(edited.issues)).toBe("valid");
    const removedTrack = replaceMaterialParameterKeyframeProgram({
      baseProgram: edited.program,
      entityId,
      keyframes: [],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(drawInClipFromProgram(removedTrack.program)).not.toBeNull();
    expect(materialParameterKeyframeTrackFromProgram(removedTrack.program, 0)).toBeNull();

    const keyframesFirst = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [
        { easing: "smooth", time: 2, value: 0.35 },
        { easing: "linear", time: 3, value: 0.7 },
      ],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    const keyframesThenDraw = replaceDrawInProgram({
      baseProgram: keyframesFirst.program,
      draw: { easing: "smooth", end: drawEnd },
      entityId,
      fragmentMaterial: { texture: false },
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(keyframesThenDraw.kind, JSON.stringify(keyframesThenDraw.issues)).toBe("valid");
    expect(drawInClipFromProgram(keyframesThenDraw.program)).not.toBeNull();
    expect(materialParameterKeyframeTrackFromProgram(keyframesThenDraw.program, 0)).not.toBeNull();
  });

  it("requires material admission and rejects texture parameter tracks when Draw exists", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Line" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-draw-recovery",
    });
    const entityId = creation.entityIds[0]!;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: 2 },
      entityId,
      fragmentMaterial: { texture: false },
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: drawn.program,
        entityId,
        keyframes: [{ easing: "smooth", time: 2.5, value: 0.35 }],
        material,
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/metadata/);
    expect(() =>
      replaceMaterialParameterKeyframeProgram({
        baseProgram: drawn.program,
        entityId,
        fragmentMaterial: { texture: true },
        keyframes: [{ easing: "smooth", time: 2.5, value: 0.35 }],
        material,
        name: "amplitude",
        parameterIndex: 0,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/texture/);
  });

  it("blocks material identity edits only while a matching active track exists", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-identity-guard",
    });
    const entityId = creation.entityIds[0]!;
    const tracked = replaceMaterialParameterKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId,
      keyframes: [{ easing: "smooth", time: 2, value: 0.35 }],
      material,
      name: "amplitude",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(materialParameterIdentityEditBlocker([tracked.program], { entityId })).toMatch(/remove.*track/i);
    expect(materialParameterIdentityEditBlocker([tracked.program], { shaderId: material.shaderId })).toMatch(
      /remove.*track/i,
    );
    expect(materialParameterIdentityEditBlocker([tracked.program], { shaderId: "other" })).toBeNull();
  });
});
