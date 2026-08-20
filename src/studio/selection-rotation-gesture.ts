import type { Point } from "./model";
import type { PreparedSelectionResizeBasis } from "./selection-resize-gesture";
import type { EntityGroupRotationPreview, SurfaceBounds } from "./studio-viewport-geometry";

export type SelectionRotationGesture = Readonly<{
  cameraScale: number;
  entities: readonly Readonly<{
    center: Point;
    entityId: string;
    fromPosition: Point;
  }>[];
  pivot: Point;
  pointerId: number;
  sourceAnchor: number;
  start: Point;
  surfaceBounds: SurfaceBounds;
}>;

type CreationPositionAuthority = Readonly<{
  entities?: readonly Readonly<{ entityId: string }>[];
  mutations: readonly Readonly<{
    entityId: string;
    kind: string;
    to?: unknown;
    toPosition?: unknown;
    value?: unknown;
  }>[];
}>;

function finiteProjectedPoint(value: unknown): Point | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("x" in value) ||
    !("y" in value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y)
  ) {
    return null;
  }
  return { x: value.x, y: value.y };
}

export function latestCreationPositionForEntity(
  projection: CreationPositionAuthority | null | undefined,
  entityId: string,
): Point | null {
  if (!projection) return null;
  for (let index = projection.mutations.length - 1; index >= 0; index -= 1) {
    const mutation = projection.mutations[index];
    if (mutation?.entityId !== entityId) continue;
    if (mutation.kind === "position") return finiteProjectedPoint(mutation.value);
    if (mutation.kind === "resize") return finiteProjectedPoint(mutation.toPosition);
  }
  return null;
}

/** Selects the final transform facts already resolved by the Rust creation
 * planner. This is correlation only; gesture code does not reconstruct Scene
 * geometry or replay authoring operations. */
export function currentCreationTransformForEntity(
  projection: CreationPositionAuthority | null | undefined,
  entityId: string,
): Readonly<{ rotation: number; transformOrigin: Point }> | null {
  if (!projection?.entities?.some((entity) => entity.entityId === entityId)) return null;
  const transformOrigin = latestCreationPositionForEntity(projection, entityId);
  if (!transformOrigin) return null;
  let rotation = 0;
  for (const mutation of projection.mutations) {
    if (mutation.entityId !== entityId || mutation.kind !== "rotation") continue;
    if (typeof mutation.to !== "number" || !Number.isFinite(mutation.to)) return null;
    rotation = mutation.to;
  }
  return { rotation, transformOrigin };
}

export function createSelectionRotationGesture(
  input: Readonly<{
    basis: PreparedSelectionResizeBasis;
    cameraScale: number;
    pointerId: number;
    sourceAnchor: number;
    start: Point;
    surfaceBounds: SurfaceBounds;
    targets: readonly Readonly<{ entityId: string; fromPosition: Point }>[];
  }>,
): SelectionRotationGesture | null {
  const centers = new Map(input.basis.entities.map((entity) => [entity.entityId, entity.center]));
  const entities = input.targets.flatMap((target) => {
    const center = centers.get(target.entityId);
    return center ? [{ ...target, center }] : [];
  });
  if (entities.length !== input.targets.length) return null;
  return {
    cameraScale: Math.max(Math.abs(input.cameraScale), Number.EPSILON),
    entities,
    pivot: {
      x: (input.basis.bounds.left + input.basis.bounds.right) / 2,
      y: (input.basis.bounds.top + input.basis.bounds.bottom) / 2,
    },
    pointerId: input.pointerId,
    sourceAnchor: input.sourceAnchor,
    start: input.start,
    surfaceBounds: input.surfaceBounds,
  };
}

export function selectionRotationPreviewAtAngle(rotation: SelectionRotationGesture, angleRadians: number) {
  const cosine = Math.cos(angleRadians);
  const sine = Math.sin(angleRadians);
  return {
    entities: rotation.entities.map((entity) => {
      const fromPivot = {
        x: entity.center.x - rotation.pivot.x,
        y: entity.center.y - rotation.pivot.y,
      };
      const rotatedCenter = {
        // Studio viewport Y points down, while canonical positive rotation is
        // counter-clockwise in Manim's Y-up scene coordinates.
        x: rotation.pivot.x + cosine * fromPivot.x + sine * fromPivot.y,
        y: rotation.pivot.y - sine * fromPivot.x + cosine * fromPivot.y,
      };
      return {
        angleRadians,
        delta: {
          x: (rotatedCenter.x - entity.center.x) / rotation.cameraScale,
          y: (rotatedCenter.y - entity.center.y) / rotation.cameraScale,
        },
        entityId: entity.entityId,
      };
    }),
  } satisfies EntityGroupRotationPreview;
}

export function selectionRotationCommandTargets(
  rotation: SelectionRotationGesture,
  preview: EntityGroupRotationPreview,
) {
  const transforms = new Map(preview.entities.map((entity) => [entity.entityId, entity]));
  if (preview.entities.length !== rotation.entities.length || transforms.size !== rotation.entities.length) {
    throw new Error("Selection rotation preview must cover every selected object exactly once.");
  }
  return rotation.entities.map((entity) => {
    const transform = transforms.get(entity.entityId);
    if (!transform) throw new Error("Selection rotation preview must cover every selected object exactly once.");
    return {
      entityId: entity.entityId,
      toPosition: {
        x: entity.fromPosition.x + transform.delta.x,
        y: entity.fromPosition.y + transform.delta.y,
      },
    };
  });
}
