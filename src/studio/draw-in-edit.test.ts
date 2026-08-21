import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram, replaceStudioEntityLifetimeProgram } from "./authoring-commands";
import { drawInClipFromProgram, replaceDrawInProgram } from "./draw-in-edit";
import { programRecord } from "./evaluator";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { insertedProgramDuration } from "./program-composition";

describe("Draw entrance editing", () => {
  it("replaces the automatic fade, retimes the canonical clip, and removes it", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ position: { x: 320, y: 180 }, type: "Circle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "draw-circle",
    });
    const entityId = creation.entityIds[0]!;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: 2.5 },
      entityId,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(drawn.kind, JSON.stringify(drawn.issues)).toBe("valid");
    expect(drawn.program.loweringStatus).toBe("unsupported");
    expect(drawn.program.operations.some((operation) => operation.kind === "ChangePresence")).toBe(false);
    expect(insertedProgramDuration(drawn.program)).toBe(1.5);
    expect(drawInClipFromProgram(drawn.program)).toMatchObject({
      easing: "smooth",
      entityId,
      interval: { end: 2.5, start: 1 },
    });

    const removed = replaceDrawInProgram({
      baseProgram: drawn.program,
      draw: null,
      entityId,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(removed.kind, JSON.stringify(removed.issues)).toBe("valid");
    expect(removed.program.loweringStatus).toBe("supported");
    expect(drawInClipFromProgram(removed.program)).toBeNull();
  });

  it("keeps Draw inside a shortened Studio lifetime", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ position: { x: 320, y: 180 }, type: "Rectangle" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "draw-lifetime",
    });
    const entityId = creation.entityIds[0]!;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "linear", end: 2.5 },
      entityId,
      scene: STUDIO_FIXTURE_SCENE,
    });
    const shortened = replaceStudioEntityLifetimeProgram({
      entityId,
      owner: programRecord(drawn.program, drawn),
      scene: STUDIO_FIXTURE_SCENE,
      sourceAnchors: [1, 2],
      target: { end: 2, start: 1 },
    });

    expect(drawInClipFromProgram(shortened.program)?.interval).toEqual({ end: 2, start: 1 });
  });

  it.each(["Arc", "Axes", "Ellipse", "NumberLine", "NumberPlane", "Sector", "Triangle", "RegularPolygon"] as const)(
    "supports Draw on a Studio-created %s",
    (type) => {
      const creation = createStudioEntitiesProgram({
        capturedPlayhead: 1,
        entities: [{ position: { x: 320, y: 180 }, type }],
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: `draw-${type}`,
      });
      const entityId = creation.entityIds[0]!;
      const drawn = replaceDrawInProgram({
        baseProgram: creation.validation.program,
        draw: { easing: "linear", end: 2 },
        entityId,
        scene: STUDIO_FIXTURE_SCENE,
      });

      expect(drawn.kind, JSON.stringify(drawn.issues)).toBe("valid");
      expect(drawInClipFromProgram(drawn.program)?.entityId).toBe(entityId);
    },
  );

  it("supports Draw on a Rust-validated stroke-only SVG path and rejects filled SVG paths", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        {
          dimensions: { height: 2, width: 3 },
          position: { x: 320, y: 180 },
          svg: { source: '<svg viewBox="0 0 3 2"><path d="M0 0 L3 2" fill="none" stroke="white"/></svg>' },
          type: "SvgPath",
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "draw-svg",
    });
    const entityId = creation.entityIds[0]!;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "linear", end: 2 },
      entityId,
      scene: STUDIO_FIXTURE_SCENE,
      svgHasFill: false,
    });

    expect(drawn.kind, JSON.stringify(drawn.issues)).toBe("valid");
    expect(drawInClipFromProgram(drawn.program)?.entityId).toBe(entityId);
    expect(() =>
      replaceDrawInProgram({
        baseProgram: creation.validation.program,
        draw: { easing: "linear", end: 2 },
        entityId,
        scene: STUDIO_FIXTURE_SCENE,
        svgHasFill: true,
      }),
    ).toThrow(/stroke-only SVG paths/);
  });

  it("rejects non-stroke Studio objects", () => {
    const arrow = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ position: { x: 320, y: 180 }, type: "Arrow" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "draw-arrow",
    });
    expect(() =>
      replaceDrawInProgram({
        baseProgram: arrow.validation.program,
        draw: { easing: "linear", end: 2 },
        entityId: arrow.entityIds[0]!,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/path objects/);
  });
});
