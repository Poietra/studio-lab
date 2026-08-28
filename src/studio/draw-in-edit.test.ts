import { describe, expect, it } from "vitest";

import {
  createStudioEntitiesProgram,
  replaceStudioEntityLifetimeProgram,
  type StudioEntityInput,
} from "./authoring-commands";
import { drawInClipFromProgram, drawInUnavailableReason, replaceDrawInProgram } from "./draw-in-edit";
import { programRecord } from "./evaluator";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { insertedProgramDuration } from "./program-composition";

const TEXTURE_FREE_FRAGMENT_MATERIAL = { texture: false } as const;

function materialDrawCreation(transactionId: string, entity: StudioEntityInput) {
  return createStudioEntitiesProgram({
    capturedPlayhead: 1,
    entities: [entity],
    scene: STUDIO_FIXTURE_SCENE,
    transactionId,
  });
}

function materialDrawPen(arrowEnd = false, closed = false): StudioEntityInput {
  return {
    cubicBezier: {
      arrowEnd,
      closed,
      control1: { x: -1, y: 1 },
      control2: { x: 1, y: -1 },
      end: { x: 2, y: 0 },
      start: { x: -2, y: 0 },
      strokeCap: "round",
      strokeWidth: 0.04,
    },
    dimensions: { height: 2, width: 4 },
    position: { x: 320, y: 180 },
    type: "CubicBezier",
  };
}

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
      fragmentMaterial: null,
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
      fragmentMaterial: null,
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
      fragmentMaterial: null,
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

  it.each([
    "Arc",
    "Axes",
    "CubicBezier",
    "DataPlot",
    "Ellipse",
    "Line",
    "NumberLine",
    "NumberPlane",
    "Sector",
    "Triangle",
    "RegularPolygon",
  ] as const)("supports Draw on a Studio-created %s", (type) => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        type === "CubicBezier"
          ? {
              cubicBezier: {
                arrowEnd: false,
                control1: { x: -1, y: 1 },
                control2: { x: 1, y: -1 },
                end: { x: 2, y: 0 },
                start: { x: -2, y: 0 },
                strokeCap: "round" as const,
                strokeWidth: 0.04,
              },
              dimensions: { height: 2, width: 4 },
              position: { x: 320, y: 180 },
              type,
            }
          : type === "DataPlot"
            ? {
                dataSeries: {
                  interpolation: "linear" as const,
                  points: [
                    { x: -1, y: 0 },
                    { x: 1, y: 1 },
                  ],
                },
                dimensions: {
                  coordinateSystem: {
                    x: { maximum: 5, minimum: -5, step: 1 },
                    y: { maximum: 3, minimum: -3, step: 1 },
                  },
                  height: 4,
                  width: 6,
                },
                position: { x: 320, y: 180 },
                type,
              }
            : { position: { x: 320, y: 180 }, type },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: `draw-${type}`,
    });
    const entityId = creation.entityIds[0]!;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "linear", end: 2 },
      entityId,
      fragmentMaterial: null,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(drawn.kind, JSON.stringify(drawn.issues)).toBe("valid");
    expect(drawInClipFromProgram(drawn.program)?.entityId).toBe(entityId);
    expect(drawn.program.loweringStatus).toBe(type === "Line" ? "supported" : "unsupported");
  });

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
      fragmentMaterial: null,
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
        fragmentMaterial: null,
        scene: STUDIO_FIXTURE_SCENE,
        svgHasFill: true,
      }),
    ).toThrow(/stroke-only SVG paths/);
  });

  it.each([
    ["Line", { position: { x: 320, y: 180 }, type: "Line" }],
    ["open Pen", materialDrawPen()],
  ] as const)("admits a texture-free material with Draw on a Studio-created %s in either order", (_, entity) => {
    const creation = materialDrawCreation(`draw-material-${entity.type}`, entity);
    const entityId = creation.entityIds[0]!;

    expect(
      drawInUnavailableReason(creation.validation.program, entityId, {
        fragmentMaterial: TEXTURE_FREE_FRAGMENT_MATERIAL,
      }),
    ).toBeNull();
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: 2 },
      entityId,
      fragmentMaterial: TEXTURE_FREE_FRAGMENT_MATERIAL,
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(drawn.kind, JSON.stringify(drawn.issues)).toBe("valid");
    expect(
      drawInUnavailableReason(drawn.program, entityId, { fragmentMaterial: TEXTURE_FREE_FRAGMENT_MATERIAL }),
    ).toBeNull();
  });

  it.each([
    ["unsupported target", { position: { x: 320, y: 180 }, type: "Circle" }, TEXTURE_FREE_FRAGMENT_MATERIAL, /Line/],
    ["arrow Pen", materialDrawPen(true), TEXTURE_FREE_FRAGMENT_MATERIAL, /non-arrow/],
    ["closed Pen", materialDrawPen(false, true), TEXTURE_FREE_FRAGMENT_MATERIAL, /open Pen/],
    ["texture", { position: { x: 320, y: 180 }, type: "Line" }, { texture: true }, /texture/],
  ] as const)("rejects a fragment material and Draw combination with %s", (name, entity, fragmentMaterial, reason) => {
    const creation = materialDrawCreation(`draw-material-${name.replaceAll(" ", "-")}`, entity);
    expect(drawInUnavailableReason(creation.validation.program, creation.entityIds[0]!, { fragmentMaterial })).toMatch(
      reason,
    );
  });

  it("rejects editing Draw after an incompatible material appears but always permits Draw removal", () => {
    const creation = materialDrawCreation("draw-material-recovery", {
      position: { x: 320, y: 180 },
      type: "Line",
    });
    const entityId = creation.entityIds[0]!;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: 2 },
      entityId,
      fragmentMaterial: TEXTURE_FREE_FRAGMENT_MATERIAL,
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(() =>
      replaceDrawInProgram({
        baseProgram: drawn.program,
        draw: { easing: "linear", end: 2.5 },
        entityId,
        fragmentMaterial: { texture: true },
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/texture/);
    const removed = replaceDrawInProgram({
      baseProgram: drawn.program,
      draw: null,
      entityId,
      fragmentMaterial: { texture: true },
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(removed.kind, JSON.stringify(removed.issues)).toBe("valid");
    expect(drawInClipFromProgram(removed.program)).toBeNull();
  });

  it("rejects Draw on a closed Pen path", () => {
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [
        {
          cubicBezier: {
            arrowEnd: false,
            closed: true,
            control1: { x: -1, y: 1 },
            control2: { x: 1, y: -1 },
            end: { x: 2, y: 1 },
            fillColor: "#38bdf8",
            start: { x: -2, y: 0 },
            strokeCap: "round" as const,
            strokeWidth: 0.04,
          },
          dimensions: { height: 2, width: 4 },
          position: { x: 320, y: 180 },
          type: "CubicBezier" as const,
        },
      ],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "draw-closed-pen",
    });
    const entityId = creation.entityIds[0]!;

    expect(() =>
      replaceDrawInProgram({
        baseProgram: creation.validation.program,
        draw: { easing: "linear", end: 2 },
        entityId,
        fragmentMaterial: null,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/open Pen paths/);
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
        fragmentMaterial: null,
        scene: STUDIO_FIXTURE_SCENE,
      }),
    ).toThrow(/path objects/);
  });
});
