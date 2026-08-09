import type { EntityDragPreview, EntityGeometryPreview, EntityScalePreview } from "./studio-viewport-geometry";

export type StudioGesturePreviewSnapshot = Readonly<{
  dragPreview: EntityDragPreview | null;
  geometryPreview: EntityGeometryPreview | null;
  kind: "drag" | "geometry" | "idle" | "scale";
  scalePreview: EntityScalePreview | null;
}>;

export type StudioGesturePreviewStore = Readonly<{
  clear: () => void;
  getSnapshot: () => StudioGesturePreviewSnapshot;
  setDragPreview: (preview: EntityDragPreview) => void;
  setGeometryPreview: (preview: EntityGeometryPreview) => void;
  setScalePreview: (preview: EntityScalePreview) => void;
  subscribe: (listener: () => void) => () => void;
}>;

const IDLE_SNAPSHOT: StudioGesturePreviewSnapshot = {
  dragPreview: null,
  geometryPreview: null,
  kind: "idle",
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
      install({ dragPreview: preview, geometryPreview: null, kind: "drag", scalePreview: null });
    },
    setGeometryPreview(preview) {
      if (snapshot.kind === "geometry" && sameGeometryPreview(snapshot.geometryPreview, preview)) return;
      install({ dragPreview: null, geometryPreview: preview, kind: "geometry", scalePreview: null });
    },
    setScalePreview(preview) {
      if (snapshot.kind === "scale" && sameScalePreview(snapshot.scalePreview, preview)) return;
      install({ dragPreview: null, geometryPreview: null, kind: "scale", scalePreview: preview });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
