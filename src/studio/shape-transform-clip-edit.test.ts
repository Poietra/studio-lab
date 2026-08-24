import { describe, expect, it } from "vitest";

import { STUDIO_FIXTURE_SCENE } from "./fixture";
import type { RuntimeSceneState } from "./model";
import {
  createShapeTransformProgram,
  replaceShapeTransformProgram,
  shapeTransformClipFromProgram,
} from "./shape-transform-clip-edit";

const ROOT_ID = "tx:create-shape/entity:shape";

function studioScene(
  type = "Rectangle",
  dimensions: Readonly<{ height?: number; radius?: number; sides?: number; width?: number }> = {
    height: 2,
    width: 4,
  },
): RuntimeSceneState {
  return {
    ...STUDIO_FIXTURE_SCENE,
    objectGraph: {
      ...STUDIO_FIXTURE_SCENE.objectGraph,
      entities: {
        ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
        [ROOT_ID]: {
          geometry: {
            dimensions: { kind: "known", value: dimensions },
            position: { kind: "known", value: { x: 0, y: 0 } },
            scale: { kind: "known", value: 1 },
            style: { kind: "known", value: {} },
          },
          id: ROOT_ID,
          lifetime: [{ end: 10, start: 1 }],
          provisional: false,
          sourceIdentity: { kind: "unknown", reason: "Created in Studio." },
          transactionId: "create-shape",
          type,
        },
      },
    },
  };
}

describe("Studio Shape Transform clip editing", () => {
  it("creates and edits a Rectangle-to-Circle clip without changing the logical root", () => {
    const scene = studioScene();
    const created = createShapeTransformProgram({
      capturedPlayhead: 2,
      easing: "smooth",
      end: 3,
      entityId: ROOT_ID,
      from: { dimensions: { height: 2, width: 4 }, shape: "rectangle" },
      scene,
      start: 2,
      to: { dimensions: { radius: 1 }, shape: "circle" },
      transactionId: "transform-circle",
    });

    expect(created.kind, JSON.stringify(created.issues)).toBe("valid");
    expect(shapeTransformClipFromProgram(created.program)).toMatchObject({
      easing: "smooth",
      entityId: ROOT_ID,
      from: { dimensions: { height: 2, width: 4 }, shape: "rectangle" },
      interval: { end: 3, start: 2 },
      to: { dimensions: { radius: 1 }, shape: "circle" },
      transactionId: "transform-circle",
    });
    expect(created.program.operations[0]).toMatchObject({ kind: "TransformShape" });

    const edited = replaceShapeTransformProgram({
      baseProgram: created.program,
      duration: 1.5,
      easing: "linear",
      scene,
    });
    expect(edited.kind, JSON.stringify(edited.issues)).toBe("valid");
    expect(shapeTransformClipFromProgram(edited.program)).toMatchObject({
      easing: "linear",
      entityId: ROOT_ID,
      interval: { end: 3.5, start: 2 },
      operationId: shapeTransformClipFromProgram(created.program)?.operationId,
    });
  });

  it("chains Circle-to-Rectangle on the same logical root", () => {
    const created = createShapeTransformProgram({
      capturedPlayhead: 4,
      easing: "linear",
      end: 5,
      entityId: ROOT_ID,
      from: { dimensions: { radius: 1 }, shape: "circle" },
      scene: studioScene(),
      start: 4,
      to: { dimensions: { height: 2, width: 4 }, shape: "rectangle" },
      transactionId: "transform-rectangle",
    });

    expect(shapeTransformClipFromProgram(created.program)).toMatchObject({
      entityId: ROOT_ID,
      from: { shape: "circle" },
      to: { shape: "rectangle" },
    });
  });

  it("creates Ellipse-to-Triangle and Triangle-to-RegularPolygon clips", () => {
    const ellipseToTriangle = createShapeTransformProgram({
      capturedPlayhead: 2,
      easing: "smooth",
      end: 3,
      entityId: ROOT_ID,
      from: { dimensions: { height: 2, width: 4 }, shape: "ellipse" },
      scene: studioScene("Ellipse", { height: 2, width: 4 }),
      start: 2,
      to: { dimensions: { radius: 1, sides: 3 }, shape: "triangle" },
      transactionId: "transform-triangle",
    });
    expect(ellipseToTriangle.kind, JSON.stringify(ellipseToTriangle.issues)).toBe("valid");
    expect(shapeTransformClipFromProgram(ellipseToTriangle.program)).toMatchObject({
      from: { shape: "ellipse" },
      to: { dimensions: { radius: 1, sides: 3 }, shape: "triangle" },
    });

    const triangleToPolygon = createShapeTransformProgram({
      capturedPlayhead: 4,
      easing: "linear",
      end: 5,
      entityId: ROOT_ID,
      from: { dimensions: { radius: 1, sides: 3 }, shape: "triangle" },
      scene: studioScene("Triangle", { radius: 1, sides: 3 }),
      start: 4,
      to: { dimensions: { radius: 1.5, sides: 7 }, shape: "regular-polygon" },
      transactionId: "transform-polygon",
    });
    expect(triangleToPolygon.kind, JSON.stringify(triangleToPolygon.issues)).toBe("valid");
    expect(shapeTransformClipFromProgram(triangleToPolygon.program)?.to).toEqual({
      dimensions: { radius: 1.5, sides: 7 },
      shape: "regular-polygon",
    });

    const polygonSideChange = createShapeTransformProgram({
      capturedPlayhead: 4,
      easing: "smooth",
      end: 5,
      entityId: ROOT_ID,
      from: { dimensions: { radius: 1.5, sides: 7 }, shape: "regular-polygon" },
      scene: studioScene("RegularPolygon", { radius: 1.5, sides: 7 }),
      start: 4,
      to: { dimensions: { radius: 1.5, sides: 5 }, shape: "regular-polygon" },
      transactionId: "transform-polygon-sides",
    });
    expect(polygonSideChange.kind, JSON.stringify(polygonSideChange.issues)).toBe("valid");
    expect(shapeTransformClipFromProgram(polygonSideChange.program)?.to.dimensions.sides).toBe(5);
  });

  it("rejects a same-shape target and clips outside the root lifetime", () => {
    expect(() =>
      createShapeTransformProgram({
        capturedPlayhead: 2,
        easing: "smooth",
        end: 3,
        entityId: ROOT_ID,
        from: { dimensions: { height: 2, width: 4 }, shape: "rectangle" },
        scene: studioScene(),
        start: 2,
        to: { dimensions: { height: 1, width: 1 }, shape: "rectangle" },
        transactionId: "same-shape",
      }),
    ).toThrow(/different closed primitive/);

    expect(() =>
      createShapeTransformProgram({
        capturedPlayhead: 2,
        easing: "smooth",
        end: 3,
        entityId: ROOT_ID,
        from: { dimensions: { radius: 1, sides: 6 }, shape: "regular-polygon" },
        scene: studioScene("RegularPolygon", { radius: 1, sides: 6 }),
        start: 2,
        to: { dimensions: { radius: 1.2, sides: 6 }, shape: "regular-polygon" },
        transactionId: "same-polygon-sides",
      }),
    ).toThrow(/different closed primitive/);

    expect(() =>
      createShapeTransformProgram({
        capturedPlayhead: 9.5,
        easing: "smooth",
        end: 10.5,
        entityId: ROOT_ID,
        from: { dimensions: { height: 2, width: 4 }, shape: "rectangle" },
        scene: studioScene(),
        start: 9.5,
        to: { dimensions: { radius: 1 }, shape: "circle" },
        transactionId: "too-long",
      }),
    ).toThrow(/lifetime/);
  });

  it("rejects mismatched dimensions and out-of-range polygon sides", () => {
    expect(() =>
      createShapeTransformProgram({
        capturedPlayhead: 2,
        easing: "smooth",
        end: 3,
        entityId: ROOT_ID,
        from: { dimensions: { height: 2, sides: 6, width: 4 }, shape: "rectangle" },
        scene: studioScene(),
        start: 2,
        to: { dimensions: { radius: 1 }, shape: "circle" },
        transactionId: "polygon-metadata",
      }),
    ).toThrow(/exact finite dimensions/);
    expect(() =>
      createShapeTransformProgram({
        capturedPlayhead: 2,
        easing: "smooth",
        end: 3,
        entityId: ROOT_ID,
        from: { dimensions: { height: 2, width: 4 }, shape: "rectangle" },
        scene: studioScene(),
        start: 2,
        to: { dimensions: { radius: 1, sides: 33 }, shape: "regular-polygon" },
        transactionId: "too-many-sides",
      }),
    ).toThrow(/exact finite dimensions/);
  });
});
