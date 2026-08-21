import type { StudioPersistentRemoveProjectionV1, StudioStaticRootProjectionV1 } from "../engine/scene-authoring";
import { type AlignmentGuide, type FrameSnapBasis, snapUniformResizeToFrame } from "./frame-alignment-snap";
import type { Point } from "./model";
import { oppositeResizeCorner, type ResizeHandleDirection, uniformCornerResizeFactor } from "./shape-resize";
import { type EntityGroupResizePreview, type SurfaceBounds, viewportScaleForBounds } from "./studio-viewport-geometry";

export type PreparedSelectionResizeBasis = Readonly<{
  bounds: Readonly<{ bottom: number; left: number; right: number; top: number }>;
  entities: readonly Readonly<{ center: Point; entityId: string }>[];
  frame?: FrameSnapBasis["frame"];
  objects?: FrameSnapBasis["objects"];
}>;

export type SelectionResizeGesture = Readonly<{
  cameraScale: number;
  entities: readonly Readonly<{
    center: Point;
    entityId: string;
    fromPosition: Point;
    fromScale: number;
  }>[];
  maximumFactor: number;
  minimumFactor: number;
  pivot: Point;
  pointerId: number;
  sourceAnchor: number;
  snapBasis: FrameSnapBasis | null;
  start: Point;
  surfaceBounds: SurfaceBounds;
}>;

type CreationRotationAuthority = Readonly<{
  entities: readonly Readonly<{ entityId: string }>[];
  motions?: readonly Readonly<{ targetEntityId: string }>[];
  mutations: readonly Readonly<{
    entityId: string;
    kind: string;
    to?: number;
    transactionId?: string;
  }>[];
}>;

function validSelectionBounds(bounds: PreparedSelectionResizeBasis["bounds"]) {
  return (
    Number.isFinite(bounds.bottom) &&
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.right) &&
    Number.isFinite(bounds.top) &&
    bounds.bottom >= bounds.top &&
    bounds.right >= bounds.left
  );
}

export function importedGroupResizeHistoryIsSupported(
  staticRootProjection: StudioStaticRootProjectionV1 | null | undefined,
  persistentRemoveProjection: StudioPersistentRemoveProjectionV1 | null | undefined,
) {
  if (staticRootProjection === undefined || persistentRemoveProjection !== null) {
    return false;
  }
  if (staticRootProjection === null) return true;
  if (staticRootProjection.insertions.length > 0) return false;

  const transactions = new Map<string, { positions: string[]; rotations: string[]; scales: string[] }>();
  for (const mutation of staticRootProjection.mutations) {
    if (mutation.kind !== "position" && mutation.kind !== "rotation" && mutation.kind !== "uniform-scale") return false;
    const transaction = transactions.get(mutation.transactionId) ?? { positions: [], rotations: [], scales: [] };
    const targets =
      mutation.kind === "position"
        ? transaction.positions
        : mutation.kind === "rotation"
          ? transaction.rotations
          : transaction.scales;
    targets.push(mutation.entityId);
    transactions.set(mutation.transactionId, transaction);
  }

  return [...transactions.values()].every(({ positions, rotations, scales }) => {
    if (rotations.length > 0 && scales.length > 0) return false;
    const transforms = rotations.length > 0 ? rotations : scales;
    if (transforms.length === 0) return true;
    const positionIds = new Set(positions);
    const transformIds = new Set(transforms);
    return (
      positionIds.size >= 2 &&
      positionIds.size <= 8 &&
      positions.length === positionIds.size &&
      transforms.length === transformIds.size &&
      positionIds.size === transformIds.size &&
      [...positionIds].every((entityId) => transformIds.has(entityId))
    );
  });
}

export function groupResizeEligibleCreationEntityIds(
  projection: CreationRotationAuthority | null | undefined,
): ReadonlySet<string> {
  if (!projection) return new Set();
  const positionsByTransaction = new Map<string, Set<string>>();
  const rotationsByTransaction = new Map<string, Set<string>>();
  for (const mutation of projection.mutations) {
    if (!mutation.transactionId) continue;
    const target =
      mutation.kind === "position"
        ? positionsByTransaction
        : mutation.kind === "rotation"
          ? rotationsByTransaction
          : null;
    if (!target) continue;
    const entityIds = target.get(mutation.transactionId) ?? new Set<string>();
    entityIds.add(mutation.entityId);
    target.set(mutation.transactionId, entityIds);
  }
  const admittedGroupRotationTransactions = new Set(
    [...rotationsByTransaction].flatMap(([transactionId, rotationEntityIds]) => {
      const positionEntityIds = positionsByTransaction.get(transactionId);
      return rotationEntityIds.size >= 2 &&
        positionEntityIds &&
        [...rotationEntityIds].every((entityId) => positionEntityIds.has(entityId))
        ? [transactionId]
        : [];
    }),
  );
  const unsupportedRotatedEntityIds = new Set(
    projection.mutations.flatMap((mutation) =>
      mutation.kind === "rotation" &&
      (mutation.to ?? Number.NaN) !== 0 &&
      (!mutation.transactionId || !admittedGroupRotationTransactions.has(mutation.transactionId))
        ? [mutation.entityId]
        : [],
    ),
  );
  const motionTargetEntityIds = new Set(projection.motions?.map(({ targetEntityId }) => targetEntityId) ?? []);
  return new Set(
    projection.entities
      .filter(({ entityId }) => !unsupportedRotatedEntityIds.has(entityId) && !motionTargetEntityIds.has(entityId))
      .map(({ entityId }) => entityId),
  );
}

export function createSelectionResizeGesture(
  input: Readonly<{
    basis: PreparedSelectionResizeBasis;
    cameraScale: number;
    direction: ResizeHandleDirection;
    maximumScale: number;
    minimumScale: number;
    pointerId: number;
    sourceAnchor: number;
    start: Point;
    surfaceBounds: SurfaceBounds;
    targets: readonly Readonly<{ entityId: string; fromPosition: Point; fromScale: number }>[];
  }>,
): SelectionResizeGesture | null {
  if (!validSelectionBounds(input.basis.bounds)) return null;
  const centers = new Map(input.basis.entities.map((entity) => [entity.entityId, entity.center]));
  const entities = input.targets.flatMap((target) => {
    const center = centers.get(target.entityId);
    return center ? [{ ...target, center }] : [];
  });
  if (entities.length !== input.targets.length) return null;
  return {
    cameraScale: Math.max(Math.abs(input.cameraScale), Number.EPSILON),
    entities,
    maximumFactor: Math.min(...entities.map(({ fromScale }) => input.maximumScale / fromScale)),
    minimumFactor: Math.max(...entities.map(({ fromScale }) => input.minimumScale / fromScale)),
    pivot: oppositeResizeCorner(input.direction, input.basis.bounds),
    pointerId: input.pointerId,
    sourceAnchor: input.sourceAnchor,
    snapBasis: input.basis.frame
      ? {
          frame: input.basis.frame,
          objects: input.basis.objects,
          selection: input.basis.bounds,
        }
      : null,
    start: input.start,
    surfaceBounds: input.surfaceBounds,
  };
}

export function selectionResizePreviewAtFactor(
  resize: SelectionResizeGesture,
  factor: number,
  guides: readonly AlignmentGuide[] = [],
) {
  return {
    entities: resize.entities.map((entity) => ({
      // Prepared centers, ProjectedEntity.position, and direct-manipulation
      // deltas all use the 640x360 Studio viewport. The Rust authoring
      // boundary performs the single viewport-to-Scene conversion.
      delta: {
        x: ((entity.center.x - resize.pivot.x) * (factor - 1)) / resize.cameraScale,
        y: ((entity.center.y - resize.pivot.y) * (factor - 1)) / resize.cameraScale,
      },
      entityId: entity.entityId,
      scale: entity.fromScale * factor,
    })),
    guides,
  } satisfies EntityGroupResizePreview;
}

export function resizeSelectionAtPoint(resize: SelectionResizeGesture, point: Point, disableSnap = false) {
  if (Math.hypot(point.x - resize.start.x, point.y - resize.start.y) <= 0.001) {
    return { factor: 1, preview: selectionResizePreviewAtFactor(resize, 1) };
  }
  const rawFactor = uniformCornerResizeFactor({
    current: point,
    maximum: resize.maximumFactor,
    minimum: resize.minimumFactor,
    pivot: resize.pivot,
    start: resize.start,
  });
  const snapped = snapUniformResizeToFrame({
    basis: resize.snapBasis,
    disabled: disableSnap,
    factor: rawFactor,
    maximumFactor: resize.maximumFactor,
    minimumFactor: resize.minimumFactor,
    pivot: resize.pivot,
    viewportUnitsPerCssPixel: viewportScaleForBounds(resize.surfaceBounds),
  });
  return {
    factor: snapped.factor,
    preview: selectionResizePreviewAtFactor(resize, snapped.factor, snapped.guides),
  };
}

export function selectionResizeCommandTargets(resize: SelectionResizeGesture, preview: EntityGroupResizePreview) {
  const transforms = new Map(preview.entities.map((entity) => [entity.entityId, entity]));
  if (preview.entities.length !== resize.entities.length || transforms.size !== resize.entities.length) {
    throw new Error("Selection resize preview must cover every selected object exactly once.");
  }
  return resize.entities.map((entity) => {
    const transform = transforms.get(entity.entityId);
    if (!transform) throw new Error("Selection resize preview must cover every selected object exactly once.");
    return {
      entityId: entity.entityId,
      fromScale: entity.fromScale,
      toPosition: {
        x: entity.fromPosition.x + transform.delta.x,
        y: entity.fromPosition.y + transform.delta.y,
      },
      toScale: transform.scale,
    };
  });
}
