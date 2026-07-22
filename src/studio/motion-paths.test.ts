import { describe, expect, it } from "vitest";

import { STUDIO_FIXTURE_SCENE } from "./fixture";
import type { RuntimeSceneState } from "./model";
import { projectMotionPaths, quadraticPathData } from "./motion-paths";

describe("motion path projection", () => {
  it("exposes the selected animated position as a quadratic path", () => {
    const paths = projectMotionPaths(STUDIO_FIXTURE_SCENE, new Set(["equation_1"]), 5);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual(expect.objectContaining({
      control: { x: 352, y: 126 },
      end: { x: 384, y: 146 },
      start: { x: 320, y: 146 },
    }));
    expect(quadraticPathData(paths[0])).toBe("M 320 146 Q 352 126 384 146");
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

    expect(projectMotionPaths(adjacentScene, selected, 7).map((path) => path.motionId))
      .toEqual(["second-motion"]);
    expect(projectMotionPaths(adjacentScene, selected, 9)).toEqual([]);
  });
});
