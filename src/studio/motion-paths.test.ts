import { describe, expect, it } from "vitest";

import { STUDIO_FIXTURE_SCENE } from "./fixture";
import type { RuntimeSceneState } from "./model";
import { projectMotionPaths, quadraticPathData } from "./motion-paths";
import { samplePropertyValue } from "./property-sampling";

describe("motion path projection", () => {
  it("exposes the selected animated position as a quadratic path", () => {
    const paths = projectMotionPaths(STUDIO_FIXTURE_SCENE, new Set(["equation_1"]), 5);
    expect(paths).toHaveLength(1);
    expect(paths[0]?.kind).toBe("quadratic");
    expect(paths[0]).toEqual(
      expect.objectContaining({
        control: { x: 352, y: 126 },
        end: { x: 384, y: 146 },
        start: { x: 320, y: 146 },
      }),
    );
    const path = paths[0];
    if (!path || path.kind !== "quadratic") throw new TypeError("Expected one quadratic motion path.");
    expect(quadraticPathData(path)).toBe("M 320 146 Q 352 126 384 146");
  });

  it("exposes an exact Rust-projected Pen path without quadratic sampling", () => {
    const path = {
      closed: false,
      segments: [
        {
          control1: { x: 16, y: 8 },
          control2: { x: 24, y: 32 },
          end: { x: 30, y: 20 },
        },
        {
          control1: { x: 36, y: 8 },
          control2: { x: 44, y: 52 },
          end: { x: 50, y: 40 },
        },
      ],
      start: { x: 10, y: 20 },
    } as const;
    const sample = {
      easing: "manim-smooth" as const,
      from: path.start,
      interval: { end: 3, start: 1 },
      kind: "animated" as const,
      operationId: "path-motion",
      pathMotion: { path, pathEntityId: "pen" },
      provenanceId: "path-motion/provenance",
      value: path.segments[1].end,
    };
    const scene: RuntimeSceneState = {
      ...STUDIO_FIXTURE_SCENE,
      propertyChannels: {
        ...STUDIO_FIXTURE_SCENE.propertyChannels,
        "equation_1/position": {
          entityId: "equation_1",
          key: "position",
          samples: [sample],
        },
      },
    };

    expect(projectMotionPaths(scene, new Set(["equation_1"]), 2)).toEqual([
      {
        end: { x: 50, y: 40 },
        entityId: "equation_1",
        interval: { end: 3, start: 1 },
        kind: "cubic",
        motionId: "path-motion",
        path,
        pathEntityId: "pen",
        start: { x: 10, y: 20 },
      },
    ]);
    expect(samplePropertyValue([sample], 2)).toEqual(path.start);
    expect(samplePropertyValue([sample], 3)).toEqual(path.segments[1].end);
  });

  it("does not expose paths outside the playhead or selection", () => {
    expect(projectMotionPaths(STUDIO_FIXTURE_SCENE, new Set(["label_1"]), 5)).toEqual([]);
    expect(projectMotionPaths(STUDIO_FIXTURE_SCENE, new Set(["equation_1"]), 8)).toEqual([]);
  });

  it("treats adjacent motion intervals as start-inclusive and end-exclusive", () => {
    const adjacentScene: RuntimeSceneState = {
      ...STUDIO_FIXTURE_SCENE,
      propertyChannels: {
        ...STUDIO_FIXTURE_SCENE.propertyChannels,
        "equation_1/position": {
          entityId: "equation_1",
          key: "position",
          samples: [
            {
              control: { x: 352, y: 126 },
              easing: "smooth",
              from: { x: 320, y: 146 },
              interval: { end: 7, start: 4 },
              kind: "animated",
              operationId: "first-motion",
              provenanceId: "first-motion",
              value: { x: 384, y: 146 },
            },
            {
              control: { x: 416, y: 166 },
              easing: "smooth",
              from: { x: 384, y: 146 },
              interval: { end: 9, start: 7 },
              kind: "animated",
              operationId: "second-motion",
              provenanceId: "second-motion",
              value: { x: 448, y: 146 },
            },
          ],
        },
      },
    };
    const selected = new Set(["equation_1"]);

    expect(projectMotionPaths(adjacentScene, selected, 7).map((path) => path.motionId)).toEqual(["second-motion"]);
    expect(projectMotionPaths(adjacentScene, selected, 9)).toEqual([]);
  });
});
