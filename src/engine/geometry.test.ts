import { describe, expect, it } from "vitest";

import {
  applyMotionPathV1,
  composeAffineTransformsV1,
  interpolateCubicPathV1,
  sampleCubicPathV1,
  sceneGeometryAsCubicPathV1,
  trimCubicPathUniformParameterV1,
  trimCubicPathV1,
} from "./geometry";

const identity = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 };

describe("Poietra Engine cubic geometry v1", () => {
  it("normalizes a Line with the exact one-third cubic controls", () => {
    const path = sceneGeometryAsCubicPathV1({ kind: "line", start: { x: 0, y: 0 }, end: { x: 9, y: 3 } });
    expect(path).toEqual({
      subpaths: [
        {
          closed: false,
          segments: [{ control1: { x: 3, y: 1 }, control2: { x: 6, y: 2 }, end: { x: 9, y: 3 } }],
          start: { x: 0, y: 0 },
        },
      ],
    });
  });

  it("normalizes Circle and rounded Rectangle primitives to closed cubics", () => {
    const circle = sceneGeometryAsCubicPathV1({ center: { x: 0, y: 0 }, kind: "circle", radius: 2 });
    const rectangle = sceneGeometryAsCubicPathV1({
      center: { x: 0, y: 0 },
      cornerRadius: 0.5,
      height: 2,
      kind: "rectangle",
      width: 4,
    });
    expect(circle.subpaths[0]).toMatchObject({ closed: true });
    expect(circle.subpaths[0].segments).toHaveLength(4);
    expect(rectangle.subpaths[0]).toMatchObject({ closed: true });
    expect(rectangle.subpaths[0].segments).toHaveLength(8);
  });

  it("samples and trims a path by its fixed arc-length approximation", () => {
    const path = sceneGeometryAsCubicPathV1({ kind: "line", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } });
    const sample = sampleCubicPathV1(path, 0.5);
    const trimmed = trimCubicPathV1(path, 0.5);
    expect(sample.point).toEqual({ x: 5, y: 0 });
    expect(sample.tangent).not.toBeNull();
    if (sample.tangent === null) throw new Error("Expected a line tangent.");
    expect(sample.tangent.x).toBeGreaterThan(0);
    expect(sample.tangent.y).toBe(0);
    expect(trimmed.subpaths[0].closed).toBe(false);
    expect(trimmed.subpaths[0].segments[0].end).toEqual({ x: 5, y: 0 });
  });

  it("distinguishes uniform cubic parameters from arc length on a nonuniform rectangle", () => {
    const path = sceneGeometryAsCubicPathV1({
      center: { x: 0, y: 0 },
      cornerRadius: 0,
      height: 2,
      kind: "rectangle",
      width: 4,
    });
    const arcLength = trimCubicPathV1(path, 0.25);
    const uniformCubic = trimCubicPathUniformParameterV1(path, 0.25);
    expect(arcLength.subpaths[0].segments.at(-1)?.end).toEqual({ x: -1, y: -1 });
    expect(uniformCubic.subpaths[0].segments.at(-1)?.end).toEqual({ x: -2, y: -1 });
  });

  it("keeps serialized subpath order and exact cubic boundaries", () => {
    const path = {
      subpaths: [
        {
          closed: false,
          segments: [{ control1: { x: 2 / 3, y: 0 }, control2: { x: 4 / 3, y: 0 }, end: { x: 2, y: 0 } }],
          start: { x: 0, y: 0 },
        },
        {
          closed: false,
          segments: [{ control1: { x: 34 / 3, y: 0 }, control2: { x: 38 / 3, y: 0 }, end: { x: 14, y: 0 } }],
          start: { x: 10, y: 0 },
        },
      ],
    };
    expect(trimCubicPathUniformParameterV1(path, 0.5).subpaths).toEqual([path.subpaths[0]]);
    const partialSecond = trimCubicPathUniformParameterV1(path, 0.75);
    expect(partialSecond.subpaths).toHaveLength(2);
    expect(partialSecond.subpaths[1].segments[0].end).toEqual({ x: 12, y: 0 });
  });

  it("does not count an implicit renderer close as a serialized cubic", () => {
    const path = {
      subpaths: [
        {
          closed: true,
          segments: [{ control1: { x: 2 / 3, y: 0 }, control2: { x: 4 / 3, y: 0 }, end: { x: 2, y: 0 } }],
          start: { x: 0, y: 0 },
        },
      ],
    };
    const partial = trimCubicPathUniformParameterV1(path, 0.5);
    expect(partial.subpaths[0].closed).toBe(false);
    expect(partial.subpaths[0].segments[0].end).toEqual({ x: 1, y: 0 });
    expect(trimCubicPathUniformParameterV1(path, 1)).toBe(path);
  });

  it("interpolates topology-compatible cubic control points", () => {
    const left = sceneGeometryAsCubicPathV1({ kind: "line", start: { x: 0, y: 0 }, end: { x: 2, y: 0 } });
    const right = sceneGeometryAsCubicPathV1({ kind: "line", start: { x: 0, y: 2 }, end: { x: 2, y: 2 } });
    expect(interpolateCubicPathV1(left, right, 0.5).subpaths[0]).toMatchObject({
      segments: [{ end: { x: 2, y: 1 } }],
      start: { x: 0, y: 1 },
    });
  });

  it("composes parent transforms and replaces translation with a motion-path pose", () => {
    const parent = { ...identity, tx: 10, ty: 5 };
    const child = { ...identity, m11: 2, m22: 3, tx: 1, ty: 2 };
    expect(composeAffineTransformsV1(parent, child)).toEqual({
      m11: 2,
      m12: 0,
      m21: 0,
      m22: 3,
      tx: 11,
      ty: 7,
    });

    const vertical = sceneGeometryAsCubicPathV1({ kind: "line", start: { x: 0, y: 0 }, end: { x: 0, y: 10 } });
    const moved = applyMotionPathV1(child, vertical, 0.5, true);
    expect(moved.tx).toBeCloseTo(0);
    expect(moved.ty).toBeCloseTo(5);
    expect(moved.m11).toBeCloseTo(0);
    expect(moved.m21).toBeCloseTo(2);
  });

  it("finds a forward tangent at a stationary start and rejects undefined orientation", () => {
    const stationaryStart = {
      subpaths: [
        {
          closed: false,
          segments: [
            {
              control1: { x: 0, y: 0 },
              control2: { x: 0, y: 1 },
              end: { x: 0, y: 2 },
            },
          ],
          start: { x: 0, y: 0 },
        },
      ],
    };
    expect(sampleCubicPathV1(stationaryStart, 0).tangent).toMatchObject({ x: 0 });
    expect(sampleCubicPathV1(stationaryStart, 0).tangent?.y).toBeGreaterThan(0);

    const degenerate = {
      subpaths: [
        {
          closed: false,
          segments: [{ control1: { x: 1, y: 2 }, control2: { x: 1, y: 2 }, end: { x: 1, y: 2 } }],
          start: { x: 1, y: 2 },
        },
      ],
    };
    expect(() => applyMotionPathV1(identity, degenerate, 0.5, true)).toThrow(/non-zero tangent/);
    expect(applyMotionPathV1(identity, degenerate, 0.5, false)).toMatchObject({ tx: 1, ty: 2 });
  });
});
