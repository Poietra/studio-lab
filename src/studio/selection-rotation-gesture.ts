import type { StudioPersistentRemoveProjectionV1, StudioStaticRootProjectionV1 } from "../engine/scene-authoring";
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

type CreationStaticTransformAuthority = Readonly<{
  entities: readonly Readonly<{ entityId: string; transactionId: string }>[];
  motions?: readonly Readonly<{ targetEntityId: string }>[];
  mutations: readonly Readonly<{
    entityId: string;
    kind: string;
    transactionId: string;
  }>[];
  removals?: readonly Readonly<{ studioEntityId: string }>[];
}>;

type CreationProgramAnchorAuthority = Readonly<{
  anchor: Readonly<{ resolvedSeconds: number }>;
  transactionId: string;
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

/** Correlates the closed history already admitted and projected by Rust. This
 * does not replay positions or evaluate rotation geometry in the browser. */
export function importedGroupRotationHistoryIsSupported(
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

/** Correlates one Rust-admitted static transform history back to its source
 * Program anchor. Motion and transform keyframes deliberately stay outside
 * this static direct-manipulation lane. */
export function studioCreationStaticTransformAnchorForEntity(
  projection: CreationStaticTransformAuthority | null | undefined,
  programs: readonly CreationProgramAnchorAuthority[],
  entityId: string,
): number | null {
  const entity = projection?.entities.find((candidate) => candidate.entityId === entityId);
  if (!projection || !entity) return null;
  if (projection.motions?.some((motion) => motion.targetEntityId === entityId)) return null;
  if (projection.removals?.some((removal) => removal.studioEntityId === entityId)) return null;

  const targetMutations = projection.mutations.filter((mutation) => mutation.entityId === entityId);
  if (
    targetMutations.some(
      (mutation) => mutation.kind === "rotation-keyframes" || mutation.kind === "uniform-scale-keyframes",
    )
  ) {
    return null;
  }

  const programsByTransaction = new Map(programs.map((program) => [program.transactionId, program]));
  const creationAnchor = programsByTransaction.get(entity.transactionId)?.anchor.resolvedSeconds;
  if (creationAnchor === undefined || !Number.isFinite(creationAnchor)) return null;

  let staticAnchor: number | null = null;
  for (const mutation of targetMutations) {
    if (
      mutation.transactionId === entity.transactionId ||
      (mutation.kind !== "position" &&
        mutation.kind !== "resize" &&
        mutation.kind !== "rotation" &&
        mutation.kind !== "uniform-scale")
    ) {
      continue;
    }
    const anchor = programsByTransaction.get(mutation.transactionId)?.anchor.resolvedSeconds;
    if (anchor === undefined || !Number.isFinite(anchor)) return null;
    if (staticAnchor !== null && Math.abs(staticAnchor - anchor) >= 0.0005) return null;
    staticAnchor = anchor;
  }
  return staticAnchor ?? creationAnchor;
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
