import type { ProjectedEntity } from "./model";

export type StudioLayerOrderDirection = "back" | "backward" | "forward" | "front";

export type StudioLayerEntry = Readonly<{
  canMove: Readonly<Record<StudioLayerOrderDirection, boolean>>;
  entity: ProjectedEntity;
  readOnlyReason: string | null;
  sceneOrder: number | null;
  sourceAnchor: number | null;
  sourceZIndex: number | null;
}>;

type CanonicalLayerEntity = Readonly<{
  id: string;
  sceneOrder: number;
  sourceZIndex: number;
}>;

type SourceRuntimeIdentity = ReadonlyMap<string, Readonly<{ entityId: string }>>;

const IMPORTED_ORDERING_REASON = "Imported Manim object: z-order round-trip is not supported yet.";
const PREVIEW_ORDERING_REASON = "Wait for the canonical preview before changing this layer order.";

function comparePaintOrder(left: CanonicalLayerEntity, right: CanonicalLayerEntity) {
  return left.sourceZIndex - right.sourceZIndex || left.sceneOrder - right.sceneOrder;
}

function movementAvailability(index: number, length: number): StudioLayerEntry["canMove"] {
  return {
    back: index > 0,
    backward: index > 0,
    forward: index >= 0 && index < length - 1,
    front: index >= 0 && index < length - 1,
  };
}

/** Projects the exact Scene IR paint order front-first for presentation.
 * Imported rows remain selectable, but only Studio-created roots expose a
 * source-safe ordering command. */
export function projectStudioLayers(
  input: Readonly<{
    canonicalEntities: readonly CanonicalLayerEntity[] | null;
    creationSourceAnchors: ReadonlyMap<string, number>;
    entities: readonly ProjectedEntity[];
    sourceRuntimeIdentity: SourceRuntimeIdentity | null;
  }>,
): readonly StudioLayerEntry[] {
  const canonicalById = new Map(input.canonicalEntities?.map((entity) => [entity.id, entity] as const) ?? []);
  const projected = input.entities.map((entity, fallbackIndex) => {
    const studioCreated = entity.transactionId !== undefined || input.creationSourceAnchors.has(entity.id);
    const runtimeId = studioCreated
      ? entity.id
      : entity.sourceIdentity.kind === "known"
        ? (input.sourceRuntimeIdentity?.get(entity.sourceIdentity.value)?.entityId ?? entity.id)
        : entity.id;
    const canonical = canonicalById.get(runtimeId) ?? null;
    const sourceAnchor = input.creationSourceAnchors.get(entity.id) ?? null;
    return {
      canMove: movementAvailability(-1, 0),
      entity,
      fallbackIndex,
      readOnlyReason: !studioCreated
        ? IMPORTED_ORDERING_REASON
        : sourceAnchor === null || canonical === null
          ? PREVIEW_ORDERING_REASON
          : null,
      sceneOrder: canonical?.sceneOrder ?? null,
      sourceAnchor,
      sourceZIndex: canonical?.sourceZIndex ?? null,
    };
  });
  projected.sort((left, right) => {
    if (
      left.sourceZIndex !== null &&
      left.sceneOrder !== null &&
      right.sourceZIndex !== null &&
      right.sceneOrder !== null
    ) {
      return -comparePaintOrder(
        { id: left.entity.id, sceneOrder: left.sceneOrder, sourceZIndex: left.sourceZIndex },
        { id: right.entity.id, sceneOrder: right.sceneOrder, sourceZIndex: right.sourceZIndex },
      );
    }
    if (left.sourceZIndex !== null) return -1;
    if (right.sourceZIndex !== null) return 1;
    return left.fallbackIndex - right.fallbackIndex;
  });
  return projected.map(({ fallbackIndex: _fallbackIndex, ...entry }, frontFirstIndex, entries) => ({
    ...entry,
    canMove:
      entry.readOnlyReason === null
        ? movementAvailability(entries.length - frontFirstIndex - 1, entries.length)
        : entry.canMove,
  }));
}

export type StudioLayerOrderPlan =
  | Readonly<{ kind: "planned"; sourceAnchor: number; sourceZIndex: number }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

function finiteOutside(value: number, direction: "above" | "below") {
  const result = value + (direction === "above" ? 1 : -1);
  return Number.isFinite(result) ? result : null;
}

function canonicalPaintOrder(entries: readonly StudioLayerEntry[]) {
  return entries
    .filter(
      (entry): entry is StudioLayerEntry & Readonly<{ sceneOrder: number; sourceZIndex: number }> =>
        entry.sceneOrder !== null && entry.sourceZIndex !== null,
    )
    .sort((left, right) =>
      comparePaintOrder(
        { id: left.entity.id, sceneOrder: left.sceneOrder, sourceZIndex: left.sourceZIndex },
        { id: right.entity.id, sceneOrder: right.sceneOrder, sourceZIndex: right.sourceZIndex },
      ),
    );
}

/** Chooses one absolute z-index that places a Studio-created root at the
 * requested index in the front-first Layers presentation. The whole visible
 * order must be backed by the canonical preview so a drop never silently
 * skips an unresolved row. */
export function planStudioLayerReorder(
  entries: readonly StudioLayerEntry[],
  targetEntityId: string,
  frontFirstIndex: number,
): StudioLayerOrderPlan {
  if (!Number.isInteger(frontFirstIndex) || frontFirstIndex < 0 || frontFirstIndex >= entries.length) {
    return { kind: "unavailable", reason: "The requested layer position is outside the current paint order." };
  }
  const canonical = canonicalPaintOrder(entries);
  if (canonical.length !== entries.length) {
    return {
      kind: "unavailable",
      reason: "Wait for every layer to appear in the canonical preview before reordering.",
    };
  }
  const frontFirst = canonical.toReversed();
  const currentIndex = frontFirst.findIndex(({ entity }) => entity.id === targetEntityId);
  if (currentIndex < 0) {
    return { kind: "unavailable", reason: "The selected layer has no current canonical paint order." };
  }
  const target = frontFirst[currentIndex]!;
  if (target.readOnlyReason) return { kind: "unavailable", reason: target.readOnlyReason };
  if (target.sourceAnchor === null) return { kind: "unavailable", reason: PREVIEW_ORDERING_REASON };
  if (frontFirstIndex === currentIndex) {
    return { kind: "unavailable", reason: "This layer is already at the requested paint position." };
  }

  const reordered = frontFirst.filter(({ entity }) => entity.id !== targetEntityId);
  reordered.splice(frontFirstIndex, 0, target);
  const frontNeighbor = reordered[frontFirstIndex - 1];
  const backNeighbor = reordered[frontFirstIndex + 1];
  let sourceZIndex: number | null;
  if (!frontNeighbor && backNeighbor) sourceZIndex = finiteOutside(backNeighbor.sourceZIndex, "above");
  else if (frontNeighbor && !backNeighbor) sourceZIndex = finiteOutside(frontNeighbor.sourceZIndex, "below");
  else if (!frontNeighbor || !backNeighbor) {
    return { kind: "unavailable", reason: "This layer is already at the only available paint position." };
  } else if (frontNeighbor.sourceZIndex === backNeighbor.sourceZIndex) {
    return {
      kind: "unavailable",
      reason: "The destination layers share one canonical z-index and cannot be split independently.",
    };
  } else sourceZIndex = (frontNeighbor.sourceZIndex + backNeighbor.sourceZIndex) / 2;

  if (sourceZIndex === null || !Number.isFinite(sourceZIndex)) {
    return { kind: "unavailable", reason: "The canonical z-index range cannot be extended safely." };
  }
  return { kind: "planned", sourceAnchor: target.sourceAnchor, sourceZIndex };
}

/** Chooses one absolute z-index for the selected Studio-created root. The
 * canonical renderer remains the only paint-order evaluator; this helper only
 * selects the adjacent slot requested by the presentation. */
export function planStudioLayerOrder(
  entries: readonly StudioLayerEntry[],
  targetEntityId: string,
  direction: StudioLayerOrderDirection,
): StudioLayerOrderPlan {
  const canonical = canonicalPaintOrder(entries);
  const target = canonical.find(({ entity }) => entity.id === targetEntityId);
  if (!target) return { kind: "unavailable", reason: "The selected layer has no current canonical paint order." };
  if (target.readOnlyReason) return { kind: "unavailable", reason: target.readOnlyReason };
  if (target.sourceAnchor === null) return { kind: "unavailable", reason: PREVIEW_ORDERING_REASON };
  const from = canonical.findIndex(({ entity }) => entity.id === targetEntityId);
  const to =
    direction === "front"
      ? canonical.length - 1
      : direction === "back"
        ? 0
        : direction === "forward"
          ? from + 1
          : from - 1;
  if (to < 0 || to >= canonical.length || to === from) {
    return { kind: "unavailable", reason: `This object is already at the ${direction} edge.` };
  }

  let sourceZIndex: number | null;
  if (direction === "front") sourceZIndex = finiteOutside(canonical.at(-1)!.sourceZIndex, "above");
  else if (direction === "back") sourceZIndex = finiteOutside(canonical[0]!.sourceZIndex, "below");
  else {
    const neighbor = canonical[to]!;
    if (neighbor.sourceZIndex === target.sourceZIndex) {
      return {
        kind: "unavailable",
        reason:
          "This adjacent layer shares one canonical z-index and cannot be crossed without reordering imported objects.",
      };
    }
    const outer = canonical[to + (direction === "forward" ? 1 : -1)];
    if (!outer) sourceZIndex = finiteOutside(neighbor.sourceZIndex, direction === "forward" ? "above" : "below");
    else if (outer.sourceZIndex === neighbor.sourceZIndex) {
      return {
        kind: "unavailable",
        reason: "This adjacent layer shares one canonical z-index and cannot be crossed independently.",
      };
    } else sourceZIndex = (neighbor.sourceZIndex + outer.sourceZIndex) / 2;
  }
  if (sourceZIndex === null || !Number.isFinite(sourceZIndex)) {
    return { kind: "unavailable", reason: "The canonical z-index range cannot be extended safely." };
  }
  return { kind: "planned", sourceAnchor: target.sourceAnchor, sourceZIndex };
}
