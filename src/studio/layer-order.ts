import type { ProjectedEntity } from "./model";

export type StudioLayerOrderDirection = "back" | "backward" | "forward" | "front";

export type StudioLayerEntry = Readonly<{
  canMove: Readonly<Record<StudioLayerOrderDirection, boolean>>;
  entity: ProjectedEntity;
  childEntityIds?: readonly string[];
  depth?: number;
  groupId?: string | null;
  isGroup?: boolean;
  orderingReadOnlyReason?: string | null;
  parentGroupId?: string | null;
  readOnlyReason: string | null;
  sceneOrder: number | null;
  sourceAnchor: number | null;
  sourceZIndex: number | null;
  visibilityReadOnlyReason: string | null;
  visible: boolean;
  rotationKeyframed?: boolean;
}>;

type CanonicalLayerEntity = Readonly<{
  geometry?: Readonly<{ kind: string }>;
  id: string;
  parentId?: string | null;
  sceneOrder: number;
  sourceZIndex: number;
  visible?: boolean;
}>;

type SourceRuntimeIdentity = ReadonlyMap<string, Readonly<{ entityId: string }>>;

const IMPORTED_ORDERING_REASON = "Imported Manim object: z-order round-trip is not supported yet.";
const PREVIEW_ORDERING_REASON = "Wait for the canonical preview before changing this layer order.";
const IMPORTED_VISIBILITY_REASON = "Imported Manim object: visibility round-trip is not supported yet.";
const PREVIEW_VISIBILITY_REASON = "Wait for the canonical preview before changing this layer visibility.";
const ACTIVE_GROUP_ORDERING_REASON = "Move the logical group as one layer before changing an individual child order.";

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
    rotationKeyframeEntityIds?: ReadonlySet<string>;
    sourceRuntimeIdentity: SourceRuntimeIdentity | null;
  }>,
): readonly StudioLayerEntry[] {
  const canonicalById = new Map(input.canonicalEntities?.map((entity) => [entity.id, entity] as const) ?? []);
  const hasActiveStudioGroup = [...canonicalById.values()].some(
    ({ geometry, id }) => geometry?.kind === "group" && id.startsWith("tx:"),
  );
  const projected = input.entities.map((entity, fallbackIndex) => {
    const studioCreated = entity.transactionId !== undefined || input.creationSourceAnchors.has(entity.id);
    const runtimeId = studioCreated
      ? entity.id
      : entity.sourceIdentity.kind === "known"
        ? (input.sourceRuntimeIdentity?.get(entity.sourceIdentity.value)?.entityId ?? entity.id)
        : entity.id;
    const canonical = canonicalById.get(runtimeId) ?? null;
    const sourceAnchor = input.creationSourceAnchors.get(entity.id) ?? null;
    const parentGroupId =
      canonical?.parentId?.startsWith("tx:") && canonicalById.get(canonical.parentId)?.geometry?.kind === "group"
        ? canonical.parentId
        : null;
    const hierarchyReason = parentGroupId ? "Grouped child: change hierarchy before changing child z-order." : null;
    return {
      canMove: movementAvailability(-1, 0),
      entity,
      depth: parentGroupId ? 1 : 0,
      fallbackIndex,
      groupId: null,
      isGroup: false,
      parentGroupId,
      readOnlyReason:
        hierarchyReason ??
        (!studioCreated
          ? IMPORTED_ORDERING_REASON
          : sourceAnchor === null || canonical === null
            ? PREVIEW_ORDERING_REASON
            : null),
      rotationKeyframed: input.rotationKeyframeEntityIds?.has(runtimeId) ?? false,
      sceneOrder: canonical?.sceneOrder ?? null,
      sourceAnchor,
      sourceZIndex: canonical?.sourceZIndex ?? null,
      visibilityReadOnlyReason: parentGroupId
        ? "Grouped child: ungroup before changing child visibility."
        : !studioCreated
          ? IMPORTED_VISIBILITY_REASON
          : sourceAnchor === null || canonical === null
            ? PREVIEW_VISIBILITY_REASON
            : null,
      visible: canonical?.visible !== false,
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
  const entityEntries: StudioLayerEntry[] = projected.map(
    ({ fallbackIndex: _fallbackIndex, ...entry }, frontFirstIndex, entries) => ({
      ...entry,
      canMove:
        entry.readOnlyReason === null
          ? movementAvailability(entries.length - frontFirstIndex - 1, entries.length)
          : entry.canMove,
    }),
  );
  const groupChildren = new Map<string, StudioLayerEntry[]>();
  for (const entry of entityEntries) {
    if (!entry.parentGroupId) continue;
    groupChildren.set(entry.parentGroupId, [...(groupChildren.get(entry.parentGroupId) ?? []), entry]);
  }
  const rows: StudioLayerEntry[] = [];
  const emittedGroups = new Set<string>();
  for (const entry of entityEntries) {
    const orderingEntry = hasActiveStudioGroup
      ? {
          ...entry,
          canMove: movementAvailability(-1, 0),
          orderingReadOnlyReason: ACTIVE_GROUP_ORDERING_REASON,
        }
      : entry;
    const groupId = entry.parentGroupId;
    if (groupId && !emittedGroups.has(groupId)) {
      const children = groupChildren.get(groupId) ?? [];
      const childIndexes = children.map((child) => entityEntries.indexOf(child));
      const firstChildIndex = Math.min(...childIndexes);
      const lastChildIndex = Math.max(...childIndexes);
      const visibilityReadOnlyReason = children.some(({ sourceAnchor }) => sourceAnchor === null)
        ? PREVIEW_VISIBILITY_REASON
        : null;
      emittedGroups.add(groupId);
      rows.push({
        ...orderingEntry,
        canMove: {
          back: lastChildIndex < entityEntries.length - 1,
          backward: false,
          forward: false,
          front: firstChildIndex > 0,
        },
        childEntityIds: children.map(({ entity }) => entity.id),
        depth: 0,
        groupId,
        isGroup: true,
        orderingReadOnlyReason: children.some(
          ({ sceneOrder, sourceAnchor, sourceZIndex }) =>
            sceneOrder === null || sourceAnchor === null || sourceZIndex === null,
        )
          ? PREVIEW_ORDERING_REASON
          : null,
        parentGroupId: null,
        readOnlyReason: null,
        visibilityReadOnlyReason,
        visible: children.every(({ visible }) => visible),
      });
    }
    rows.push(orderingEntry);
  }
  return rows;
}

export type StudioLayerGroupPlan =
  | Readonly<{ childEntityIds: readonly string[]; kind: "planned" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export function planStudioLayerGroup(
  entries: readonly StudioLayerEntry[],
  selectedEntityIds: ReadonlySet<string>,
): StudioLayerGroupPlan {
  const leaves = entries.filter((entry) => !entry.isGroup);
  const selected = leaves.filter(({ entity }) => selectedEntityIds.has(entity.id));
  if (selected.length < 2 || selected.length !== selectedEntityIds.size) {
    return { kind: "unavailable", reason: "Select at least two visible layer objects to group." };
  }
  if (selected.some(({ parentGroupId }) => parentGroupId)) {
    return { kind: "unavailable", reason: "Nested groups are not supported in this vertical slice." };
  }
  if (selected.some(({ visible }) => !visible)) {
    return { kind: "unavailable", reason: "Hidden objects cannot be grouped." };
  }
  if (selected.some(({ entity }) => !entity.present)) {
    return { kind: "unavailable", reason: "Every grouped object must be present at the playhead." };
  }
  if (selected.some(({ rotationKeyframed }) => rotationKeyframed)) {
    return { kind: "unavailable", reason: "Objects with rotation keyframes cannot be grouped." };
  }
  const readOnly = selected.find(
    ({ readOnlyReason, sourceAnchor }) => readOnlyReason !== null || sourceAnchor === null,
  );
  if (readOnly) {
    return {
      kind: "unavailable",
      reason: readOnly.readOnlyReason ?? "Wait for the canonical preview before grouping.",
    };
  }
  const rootPaintOrder = leaves.filter(({ parentGroupId }) => !parentGroupId);
  const indexes = selected.map((entry) => rootPaintOrder.indexOf(entry)).sort((left, right) => left - right);
  if (
    indexes.some((index) => index < 0) ||
    indexes.some((index, offset) => offset > 0 && index !== indexes[offset - 1]! + 1)
  ) {
    return { kind: "unavailable", reason: "Selected objects must be contiguous in canonical paint order." };
  }
  return { childEntityIds: selected.map(({ entity }) => entity.id), kind: "planned" };
}

export function selectedStudioLayerGroup(entries: readonly StudioLayerEntry[], selectedEntityIds: ReadonlySet<string>) {
  return (
    entries.find(
      (entry) =>
        entry.isGroup &&
        entry.groupId &&
        entry.childEntityIds?.length === selectedEntityIds.size &&
        entry.childEntityIds.every((id) => selectedEntityIds.has(id)),
    ) ?? null
  );
}

export type StudioLayerGroupOrderPlan =
  | Readonly<{
      kind: "planned";
      targets: readonly Readonly<{ entityId: string; fromSourceZIndex: number; sourceZIndex: number }>[];
    }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** Moves one contiguous logical group to the outer paint edge while retaining
 * every child's canonical relative z-index. Adjacent group movement remains a
 * separate gesture because it needs a block-level drop target. */
export function planStudioLayerGroupOrder(
  entries: readonly StudioLayerEntry[],
  groupId: string,
  direction: "back" | "front",
): StudioLayerGroupOrderPlan {
  const group = entries.find((entry) => entry.isGroup && entry.groupId === groupId);
  if (!group?.childEntityIds?.length) {
    return { kind: "unavailable", reason: "The selected logical group is not available in the canonical preview." };
  }
  if (
    entries.some(({ isGroup, sceneOrder, sourceZIndex }) => !isGroup && (sceneOrder === null || sourceZIndex === null))
  ) {
    return { kind: "unavailable", reason: "Wait for every layer to resolve its canonical paint order." };
  }
  const canonical = canonicalPaintOrder(entries);
  const childIds = new Set(group.childEntityIds);
  const children = canonical.filter(({ entity }) => childIds.has(entity.id));
  if (children.length !== childIds.size) {
    return { kind: "unavailable", reason: "Wait for every grouped object to appear in the canonical preview." };
  }
  const indexes = children.map((child) => canonical.indexOf(child)).sort((left, right) => left - right);
  if (indexes.some((index, offset) => offset > 0 && index !== indexes[offset - 1]! + 1)) {
    return { kind: "unavailable", reason: "The logical group is no longer contiguous in canonical paint order." };
  }
  const atEdge = direction === "front" ? indexes.at(-1) === canonical.length - 1 : indexes[0] === 0;
  if (atEdge) return { kind: "unavailable", reason: `This group is already at the ${direction} edge.` };

  const outside = canonical.filter(({ entity }) => !childIds.has(entity.id));
  const childMinimum = Math.min(...children.map(({ sourceZIndex }) => sourceZIndex));
  const childMaximum = Math.max(...children.map(({ sourceZIndex }) => sourceZIndex));
  const outsideMinimum = Math.min(...outside.map(({ sourceZIndex }) => sourceZIndex));
  const outsideMaximum = Math.max(...outside.map(({ sourceZIndex }) => sourceZIndex));
  const delta = direction === "front" ? outsideMaximum + 1 - childMinimum : outsideMinimum - 1 - childMaximum;
  if (!Number.isFinite(delta)) {
    return { kind: "unavailable", reason: "The canonical z-index range cannot be extended safely." };
  }
  return {
    kind: "planned",
    targets: children.map(({ entity, sourceZIndex }) => ({
      entityId: entity.id,
      fromSourceZIndex: sourceZIndex,
      sourceZIndex: sourceZIndex + delta,
    })),
  };
}

export function selectionContainsGroupedChild(
  entries: readonly StudioLayerEntry[],
  selectedEntityIds: ReadonlySet<string>,
) {
  return entries.some(
    ({ entity, isGroup, parentGroupId }) => !isGroup && parentGroupId && selectedEntityIds.has(entity.id),
  );
}

/** Keeps the Layers row while removing hidden canonical entities from Canvas
 * interaction overlays. The WebGPU draw is removed independently in Rust. */
export function filterStudioCanvasEntitiesByVisibility(
  entities: readonly ProjectedEntity[],
  canonicalEntities: readonly Readonly<{ id: string; visible?: boolean }>[] | null,
) {
  const hidden = new Set(canonicalEntities?.filter(({ visible }) => visible === false).map(({ id }) => id) ?? []);
  return entities.filter(({ id }) => !hidden.has(id));
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
        !entry.isGroup && entry.sceneOrder !== null && entry.sourceZIndex !== null,
    )
    .sort((left, right) =>
      comparePaintOrder(
        { id: left.entity.id, sceneOrder: left.sceneOrder, sourceZIndex: left.sourceZIndex },
        { id: right.entity.id, sceneOrder: right.sceneOrder, sourceZIndex: right.sourceZIndex },
      ),
    );
}

function activeGroupOrderingReason(entries: readonly StudioLayerEntry[]) {
  return entries.some(
    ({ groupId, isGroup, orderingReadOnlyReason: reason }) =>
      reason === ACTIVE_GROUP_ORDERING_REASON || (isGroup && groupId?.startsWith("tx:")),
  )
    ? ACTIVE_GROUP_ORDERING_REASON
    : null;
}

function orderingReadOnlyReason(entry: StudioLayerEntry) {
  return entry.orderingReadOnlyReason ?? entry.readOnlyReason;
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
  const hierarchyReason = activeGroupOrderingReason(entries);
  if (hierarchyReason) return { kind: "unavailable", reason: hierarchyReason };
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
  const targetReadOnlyReason = orderingReadOnlyReason(target);
  if (targetReadOnlyReason) return { kind: "unavailable", reason: targetReadOnlyReason };
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
  const hierarchyReason = activeGroupOrderingReason(entries);
  if (hierarchyReason) return { kind: "unavailable", reason: hierarchyReason };
  const canonical = canonicalPaintOrder(entries);
  const target = canonical.find(({ entity }) => entity.id === targetEntityId);
  if (!target) return { kind: "unavailable", reason: "The selected layer has no current canonical paint order." };
  const targetReadOnlyReason = orderingReadOnlyReason(target);
  if (targetReadOnlyReason) return { kind: "unavailable", reason: targetReadOnlyReason };
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
