import type {
  EntityDragPreview,
  EntityGeometryPreview,
  EntityGroupResizePreview,
  EntityRotationPreview,
  EntityScalePreview,
} from "./studio-viewport-geometry";

export type StudioGesturePreviewSnapshot = Readonly<{
  dragPreview: EntityDragPreview | null;
  geometryPreview: EntityGeometryPreview | null;
  groupResizePreview: EntityGroupResizePreview | null;
  kind: "drag" | "geometry" | "group-resize" | "idle" | "rotation" | "scale";
  rotationPreview: EntityRotationPreview | null;
  scalePreview: EntityScalePreview | null;
}>;

export type StudioGesturePreviewStore = Readonly<{
  clear: () => void;
  getSnapshot: () => StudioGesturePreviewSnapshot;
  setDragPreview: (preview: EntityDragPreview) => void;
  setGeometryPreview: (preview: EntityGeometryPreview) => void;
  setGroupResizePreview: (preview: EntityGroupResizePreview) => void;
  setRotationPreview: (preview: EntityRotationPreview) => void;
  setScalePreview: (preview: EntityScalePreview) => void;
  subscribe: (listener: () => void) => () => void;
}>;

const IDLE_SNAPSHOT: StudioGesturePreviewSnapshot = {
  dragPreview: null,
  geometryPreview: null,
  groupResizePreview: null,
  kind: "idle",
  rotationPreview: null,
  scalePreview: null,
};

function sameNumber(left: number | undefined, right: number | undefined) {
  return Object.is(left, right);
}

function sameEntityIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((entityId, index) => entityId === right[index]);
}

function sameDragPreview(left: EntityDragPreview | null, right: EntityDragPreview) {
  return (
    left !== null &&
    sameNumber(left.delta.x, right.delta.x) &&
    sameNumber(left.delta.y, right.delta.y) &&
    sameEntityIds(left.entityIds, right.entityIds)
  );
}

function sameGeometryPreview(left: EntityGeometryPreview | null, right: EntityGeometryPreview) {
  return (
    left !== null &&
    left.entityId === right.entityId &&
    sameNumber(left.position.x, right.position.x) &&
    sameNumber(left.position.y, right.position.y) &&
    sameNumber(left.dimensions.height, right.dimensions.height) &&
    sameNumber(left.dimensions.radius, right.dimensions.radius) &&
    sameNumber(left.dimensions.width, right.dimensions.width)
  );
}

function sameScalePreview(left: EntityScalePreview | null, right: EntityScalePreview) {
  return left !== null && left.entityId === right.entityId && sameNumber(left.scale, right.scale);
}

function sameRotationPreview(left: EntityRotationPreview | null, right: EntityRotationPreview) {
  return left !== null && left.entityId === right.entityId && sameNumber(left.angleRadians, right.angleRadians);
}

function sameGroupResizePreview(left: EntityGroupResizePreview | null, right: EntityGroupResizePreview) {
  return (
    left !== null &&
    left.entities.length === right.entities.length &&
    left.entities.every((entity, index) => {
      const candidate = right.entities[index];
      return (
        candidate !== undefined &&
        entity.entityId === candidate.entityId &&
        sameNumber(entity.delta.x, candidate.delta.x) &&
        sameNumber(entity.delta.y, candidate.delta.y) &&
        sameNumber(entity.scale, candidate.scale)
      );
    })
  );
}

export function createStudioGesturePreviewStore(): StudioGesturePreviewStore {
  let snapshot = IDLE_SNAPSHOT;
  const listeners = new Set<() => void>();

  function install(next: StudioGesturePreviewSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  return {
    clear() {
      if (snapshot.kind === "idle") return;
      install(IDLE_SNAPSHOT);
    },
    getSnapshot() {
      return snapshot;
    },
    setDragPreview(preview) {
      if (snapshot.kind === "drag" && sameDragPreview(snapshot.dragPreview, preview)) return;
      install({
        dragPreview: preview,
        geometryPreview: null,
        groupResizePreview: null,
        kind: "drag",
        rotationPreview: null,
        scalePreview: null,
      });
    },
    setGeometryPreview(preview) {
      if (snapshot.kind === "geometry" && sameGeometryPreview(snapshot.geometryPreview, preview)) return;
      install({
        dragPreview: null,
        geometryPreview: preview,
        groupResizePreview: null,
        kind: "geometry",
        rotationPreview: null,
        scalePreview: null,
      });
    },
    setGroupResizePreview(preview) {
      if (snapshot.kind === "group-resize" && sameGroupResizePreview(snapshot.groupResizePreview, preview)) return;
      install({
        dragPreview: null,
        geometryPreview: null,
        groupResizePreview: preview,
        kind: "group-resize",
        rotationPreview: null,
        scalePreview: null,
      });
    },
    setRotationPreview(preview) {
      if (snapshot.kind === "rotation" && sameRotationPreview(snapshot.rotationPreview, preview)) return;
      install({
        dragPreview: null,
        geometryPreview: null,
        groupResizePreview: null,
        kind: "rotation",
        rotationPreview: preview,
        scalePreview: null,
      });
    },
    setScalePreview(preview) {
      if (snapshot.kind === "scale" && sameScalePreview(snapshot.scalePreview, preview)) return;
      install({
        dragPreview: null,
        geometryPreview: null,
        groupResizePreview: null,
        kind: "scale",
        rotationPreview: null,
        scalePreview: preview,
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
