import type { AlignmentGuide } from "./frame-alignment-snap";
import type {
  EntityDragPreview,
  EntityGeometryPreview,
  EntityGroupResizePreview,
  EntityGroupRotationPreview,
  EntityRotationPreview,
  EntityScalePreview,
} from "./studio-viewport-geometry";

export type StudioGesturePreviewSnapshot = Readonly<{
  dragPreview: EntityDragPreview | null;
  geometryPreview: EntityGeometryPreview | null;
  groupRotationPreview: EntityGroupRotationPreview | null;
  groupResizePreview: EntityGroupResizePreview | null;
  kind: "drag" | "geometry" | "group-resize" | "group-rotation" | "idle" | "rotation" | "scale";
  rotationPreview: EntityRotationPreview | null;
  scalePreview: EntityScalePreview | null;
}>;

export type StudioGesturePreviewStore = Readonly<{
  clear: () => void;
  getSnapshot: () => StudioGesturePreviewSnapshot;
  setDragPreview: (preview: EntityDragPreview) => void;
  setGeometryPreview: (preview: EntityGeometryPreview) => void;
  setGroupRotationPreview: (preview: EntityGroupRotationPreview) => void;
  setGroupResizePreview: (preview: EntityGroupResizePreview) => void;
  setRotationPreview: (preview: EntityRotationPreview) => void;
  setScalePreview: (preview: EntityScalePreview) => void;
  subscribe: (listener: () => void) => () => void;
}>;

const IDLE_SNAPSHOT: StudioGesturePreviewSnapshot = {
  dragPreview: null,
  geometryPreview: null,
  groupRotationPreview: null,
  groupResizePreview: null,
  kind: "idle",
  rotationPreview: null,
  scalePreview: null,
};

function sameNumber(left: number | undefined, right: number | undefined) {
  return Object.is(left, right);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameAlignmentGuides(left: readonly AlignmentGuide[], right: readonly AlignmentGuide[]) {
  return (
    left.length === right.length &&
    left.every((guide, index) => {
      const candidate = right[index];
      if (typeof guide === "string" || typeof candidate === "string") return guide === candidate;
      return (
        candidate !== undefined &&
        guide.axis === candidate.axis &&
        guide.entityId === candidate.entityId &&
        sameNumber(guide.position, candidate.position)
      );
    })
  );
}

function sameDragPreview(left: EntityDragPreview | null, right: EntityDragPreview) {
  return (
    left !== null &&
    sameNumber(left.delta.x, right.delta.x) &&
    sameNumber(left.delta.y, right.delta.y) &&
    sameStrings(left.entityIds, right.entityIds) &&
    sameAlignmentGuides(left.guides, right.guides)
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

function sameGroupRotationPreview(left: EntityGroupRotationPreview | null, right: EntityGroupRotationPreview) {
  return (
    left !== null &&
    left.entities.length === right.entities.length &&
    left.entities.every((entity, index) => {
      const candidate = right.entities[index];
      return (
        candidate !== undefined &&
        entity.entityId === candidate.entityId &&
        sameNumber(entity.angleRadians, candidate.angleRadians) &&
        sameNumber(entity.delta.x, candidate.delta.x) &&
        sameNumber(entity.delta.y, candidate.delta.y)
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
        groupRotationPreview: null,
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
        groupRotationPreview: null,
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
        groupRotationPreview: null,
        groupResizePreview: preview,
        kind: "group-resize",
        rotationPreview: null,
        scalePreview: null,
      });
    },
    setGroupRotationPreview(preview) {
      if (snapshot.kind === "group-rotation" && sameGroupRotationPreview(snapshot.groupRotationPreview, preview))
        return;
      install({
        dragPreview: null,
        geometryPreview: null,
        groupRotationPreview: preview,
        groupResizePreview: null,
        kind: "group-rotation",
        rotationPreview: null,
        scalePreview: null,
      });
    },
    setRotationPreview(preview) {
      if (snapshot.kind === "rotation" && sameRotationPreview(snapshot.rotationPreview, preview)) return;
      install({
        dragPreview: null,
        geometryPreview: null,
        groupRotationPreview: null,
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
        groupRotationPreview: null,
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
