import type { EnginePointV1 } from "../engine/primitives";
import type { SceneEntityV1 } from "../engine/scene-ir";
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

type SceneEntityLocalBounds = Readonly<{ bottom: number; left: number; right: number; top: number }>;

export function sceneEntityLocalBounds(entity: Pick<SceneEntityV1, "geometry">): SceneEntityLocalBounds | null {
  const geometry = entity.geometry;
  if (geometry.kind === "circle") {
    return {
      bottom: geometry.center.y - geometry.radius,
      left: geometry.center.x - geometry.radius,
      right: geometry.center.x + geometry.radius,
      top: geometry.center.y + geometry.radius,
    };
  }
  if (geometry.kind === "rectangle") {
    return {
      bottom: geometry.center.y - geometry.height / 2,
      left: geometry.center.x - geometry.width / 2,
      right: geometry.center.x + geometry.width / 2,
      top: geometry.center.y + geometry.height / 2,
    };
  }
  if (geometry.kind === "image") return geometry.localRect;
  if (geometry.kind !== "cubic-path") return null;
  const points = geometry.path.subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end]),
  ]);
  if (points.length === 0) return null;
  return {
    bottom: Math.min(...points.map(({ y }) => y)),
    left: Math.min(...points.map(({ x }) => x)),
    right: Math.max(...points.map(({ x }) => x)),
    top: Math.max(...points.map(({ y }) => y)),
  };
}

export function sceneEntityWorldCenter(entity: Pick<SceneEntityV1, "geometry" | "transform">): EnginePointV1 | null {
  const bounds = sceneEntityLocalBounds(entity);
  if (!bounds) return null;
  const center = { x: (bounds.left + bounds.right) / 2, y: (bounds.bottom + bounds.top) / 2 };
  return {
    x: entity.transform.m11 * center.x + entity.transform.m12 * center.y + entity.transform.tx,
    y: entity.transform.m21 * center.x + entity.transform.m22 * center.y + entity.transform.ty,
  };
}

export function sceneEntityUniformPositiveScale(transform: SceneEntityV1["transform"]): number | null {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(transform.m11), Math.abs(transform.m22)) * 32;
  return transform.m11 > 0 &&
    transform.m12 === 0 &&
    transform.m21 === 0 &&
    Math.abs(transform.m11 - transform.m22) <= tolerance
    ? transform.m11
    : null;
}
