import type { EnginePointV1 } from "../engine/primitives";
import type { Point } from "./model";
import { STUDIO_VIEWPORT } from "./studio-viewport-geometry";

export function studioPointToScenePoint(
  point: Point,
  frame: Readonly<{ height: number; width: number }>,
  cameraCenter: EnginePointV1,
): EnginePointV1 {
  return {
    x: cameraCenter.x + (point.x / STUDIO_VIEWPORT.width - 0.5) * frame.width,
    y: cameraCenter.y + (0.5 - point.y / STUDIO_VIEWPORT.height) * frame.height,
  };
}

export function studioVectorToSceneVector(
  vector: Point,
  frame: Readonly<{ height: number; width: number }>,
): EnginePointV1 {
  return {
    x: (vector.x / STUDIO_VIEWPORT.width) * frame.width,
    y: (-vector.y / STUDIO_VIEWPORT.height) * frame.height,
  };
}
