import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { replaceMaterialParameterKeyframeProgram } from "./material-parameter-keyframe-edit";
import {
  appendPaintColorKeyframe,
  initialPaintColorKeyframes,
  paintColorKeyframeTrackFromProgram,
  replacePaintColorKeyframeProgram,
} from "./paint-color-keyframe-edit";
import { duplicatePropertyKeyframeAtTime } from "./property-keyframe-duplicate";
import { studioPaintColorTrackProperty } from "./scene-edit-contract";

describe("solid paint color keyframe editing", () => {
  it("stores one continuous closed-primitive fill track on the creation Program", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "paint-color-track",
    });
    const entityId = creation.entityIds[0]!;
    const tracked = replacePaintColorKeyframeProgram({
      baseProgram: creation.validation.program,
      baseline: "#ffffff",
      entityId,
      keyframes: [
        { easing: "linear", time: 2, value: "#ffffff" },
        { easing: "smooth", time: 4, value: "#0ea5e9" },
      ],
      property: "fillColor",
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(tracked.kind, JSON.stringify(tracked.issues)).toBe("valid");
    expect(tracked.program.loweringStatus).toBe("unsupported");
    expect(paintColorKeyframeTrackFromProgram(tracked.program, 0)).toMatchObject({
      entityId,
      keyframes: [
        { easing: "linear", time: 2, value: "#ffffff" },
        { easing: "smooth", time: 4, value: "#0ea5e9" },
      ],
      property: "fillColor",
    });

    const source = paintColorKeyframeTrackFromProgram(tracked.program, 0)!;
    const duplicated = replacePaintColorKeyframeProgram({
      baseProgram: tracked.program,
      baseline: "#ffffff",
      entityId,
      keyframes: duplicatePropertyKeyframeAtTime(source.keyframes, 1, 3),
      property: "fillColor",
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(paintColorKeyframeTrackFromProgram(duplicated.program, 0)?.keyframes).toEqual([
      { easing: "linear", time: 2, value: "#ffffff" },
      { easing: "smooth", time: 3, value: "#0ea5e9" },
      { easing: "smooth", time: 4, value: "#0ea5e9" },
    ]);

    const removed = replacePaintColorKeyframeProgram({
      baseProgram: duplicated.program,
      baseline: "#ffffff",
      entityId,
      keyframes: [],
      property: "fillColor",
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(removed.kind, JSON.stringify(removed.issues)).toBe("valid");
    expect(removed.program.loweringStatus).toBe("supported");
    expect(paintColorKeyframeTrackFromProgram(removed.program, 0)).toBeNull();
  });

  it("uses a two-marker first add and preserves the canonical baseline", () => {
    expect(initialPaintColorKeyframes({ baseline: "#ffffff", entranceEnd: 1, playhead: 3 })).toEqual([
      { easing: "smooth", time: 1.001, value: "#ffffff" },
      { easing: "smooth", time: 3, value: "#ffffff" },
    ]);
    expect(() => initialPaintColorKeyframes({ baseline: "#ffffff", entranceEnd: 1, playhead: 1.001 })).toThrow(
      /farther past/i,
    );
    expect(
      appendPaintColorKeyframe(
        [
          { easing: "linear", time: 1.001, value: "#ffffff" },
          { easing: "smooth", time: 3, value: "#0ea5e9" },
        ],
        4,
      ),
    ).toEqual([
      { easing: "linear", time: 1.001, value: "#ffffff" },
      { easing: "smooth", time: 3, value: "#0ea5e9" },
      { easing: "smooth", time: 4, value: "#0ea5e9" },
    ]);
    expect(() =>
      appendPaintColorKeyframe(
        [
          { easing: "linear", time: 1.001, value: "#ffffff" },
          { easing: "smooth", time: 3, value: "#0ea5e9" },
        ],
        2,
      ),
    ).toThrow(/after the final marker/i);
  });

  it("rejects the wrong target, a changed first color, malformed continuity, and material conflicts", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Line" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "stroke-color-track",
    });
    const entityId = creation.entityIds[0]!;
    const keyframes = [
      { easing: "linear" as const, time: 2, value: "#ffffff" },
      { easing: "smooth" as const, time: 4, value: "#22c55e" },
    ];
    expect(() =>
      replacePaintColorKeyframeProgram({
        baseProgram: creation.validation.program,
        baseline: "#ffffff",
        entityId,
        keyframes,
        property: "fillColor",
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/does not support/i);
    expect(() =>
      replacePaintColorKeyframeProgram({
        baseProgram: creation.validation.program,
        baseline: "#0ea5e9",
        entityId,
        keyframes,
        property: "strokeColor",
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/static color/i);

    const tracked = replacePaintColorKeyframeProgram({
      baseProgram: creation.validation.program,
      baseline: "#ffffff",
      entityId,
      keyframes,
      property: "strokeColor",
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(paintColorKeyframeTrackFromProgram(tracked.program, 0)?.property).toBe("strokeColor");
    const malformed = {
      ...tracked.program,
      operations: tracked.program.operations.map((operation) =>
        operation.kind === "AnimateProperty" && operation.key === "strokeColor"
          ? { ...operation, to: "#ABCDEF" }
          : operation,
      ),
    };
    expect(paintColorKeyframeTrackFromProgram(malformed, 0)).toBeNull();

    const materialCreation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "material-paint-conflict",
    });
    const materialEntityId = materialCreation.entityIds[0]!;
    const material = replaceMaterialParameterKeyframeProgram({
      baseProgram: materialCreation.validation.program,
      entityId: materialEntityId,
      keyframes: [
        { easing: "smooth", time: 2, value: 0 },
        { easing: "smooth", time: 3, value: 1 },
      ],
      material: { parameters: [0], revision: 1, shaderId: "shader" },
      name: "amount",
      parameterIndex: 0,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(() =>
      replacePaintColorKeyframeProgram({
        baseProgram: material.program,
        baseline: "#ffffff",
        entityId: materialEntityId,
        keyframes,
        property: "fillColor",
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/material/i);
  });

  it("keeps the first slice target table narrow", () => {
    for (const type of ["Circle", "Ellipse", "Rectangle", "RegularPolygon", "Triangle"]) {
      expect(studioPaintColorTrackProperty(type)).toBe("fillColor");
    }
    expect(studioPaintColorTrackProperty("Line")).toBe("strokeColor");
    for (const type of ["Arc", "Arrow", "MathTex", "Sector", "Text"]) {
      expect(studioPaintColorTrackProperty(type)).toBeNull();
    }
  });
});
