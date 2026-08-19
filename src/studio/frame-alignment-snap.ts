import type { Point } from "./model";

export const FRAME_ALIGNMENT_SNAP_TOLERANCE_CSS_PX = 8;

export type FrameAlignmentGuide =
  | "frame-bottom"
  | "frame-center-x"
  | "frame-center-y"
  | "frame-left"
  | "frame-right"
  | "frame-top";

export type ObjectAlignmentGuide = Readonly<{
  axis: "x" | "y";
  entityId: string;
  kind: "object";
  position: number;
}>;

export type AlignmentGuide = FrameAlignmentGuide | ObjectAlignmentGuide;

export type FrameSnapBounds = Readonly<{
  bottom: number;
  left: number;
  right: number;
  top: number;
}>;

export type FrameSnapBasis = Readonly<{
  frame: FrameSnapBounds;
  objects?: readonly Readonly<{ bounds: FrameSnapBounds; entityId: string }>[];
  selection: FrameSnapBounds;
}>;

export type PreparedMoveSnapBasis = Readonly<{
  bounds: FrameSnapBounds;
  entityIds: readonly string[];
  objects?: readonly Readonly<{ bounds: FrameSnapBounds; entityId: string }>[];
}>;

type AxisCandidate = Readonly<{
  correction: number;
  guide: AlignmentGuide;
  priority: number;
}>;

type UniformResizeCandidate = Readonly<{
  factor: number;
  guide: AlignmentGuide;
  priority: number;
  screenDistance: number;
}>;

function center(start: number, end: number) {
  return start + (end - start) / 2;
}

function closestCandidate(candidates: readonly AxisCandidate[], tolerance: number): AxisCandidate | null {
  let closest: AxisCandidate | null = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate.correction) > tolerance) continue;
    const distance = Math.abs(candidate.correction);
    const closestDistance = closest === null ? Number.POSITIVE_INFINITY : Math.abs(closest.correction);
    if (
      closest === null ||
      distance < closestDistance ||
      (distance === closestDistance && candidate.priority < closest.priority)
    ) {
      closest = candidate;
    }
  }
  return closest;
}

function orderedObjectTargets(objects: FrameSnapBasis["objects"]) {
  if (!objects || objects.some(({ bounds }) => !validBounds(bounds))) return [];
  return [...objects].sort((left, right) =>
    left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
  );
}

function axisValues(bounds: FrameSnapBounds, axis: "x" | "y") {
  return axis === "x"
    ? [bounds.left, center(bounds.left, bounds.right), bounds.right]
    : [bounds.top, center(bounds.top, bounds.bottom), bounds.bottom];
}

function objectAxisCandidates(
  objects: ReturnType<typeof orderedObjectTargets>,
  movedSelection: FrameSnapBounds,
  axis: "x" | "y",
  priorityOffset: number,
) {
  const selectionValues = axisValues(movedSelection, axis);
  return objects.flatMap(({ bounds, entityId }, objectIndex) => {
    const targetValues = axisValues(bounds, axis);
    return targetValues.flatMap((target, targetIndex) =>
      selectionValues.map((selection, selectionIndex) => ({
        correction: target - selection,
        guide: { axis, entityId, kind: "object" as const, position: target },
        priority: priorityOffset + objectIndex * 9 + targetIndex * 3 + selectionIndex,
      })),
    );
  });
}

function uniformResizeAxisCandidates(
  input: Readonly<{
    axis: "x" | "y";
    factor: number;
    maximumFactor: number;
    minimumFactor: number;
    objects: ReturnType<typeof orderedObjectTargets>;
    pivot: number;
    selection: FrameSnapBounds;
    targets: readonly Readonly<{
      guide: AlignmentGuide;
      position: number;
      priority: number;
      selectionIndex?: number;
    }>[];
    tolerance: number;
    unitsPerCssPixel: number;
  }>,
) {
  const selectionValues = axisValues(input.selection, input.axis);
  const targets = [
    ...input.targets,
    ...input.objects.flatMap(({ bounds, entityId }, objectIndex) =>
      axisValues(bounds, input.axis).map((position, targetIndex) => ({
        guide: {
          axis: input.axis,
          entityId,
          kind: "object" as const,
          position,
        },
        position,
        priority: 3 + objectIndex * 9 + targetIndex * 3,
        selectionIndex: undefined,
      })),
    ),
  ];
  return targets.flatMap((target) =>
    selectionValues.flatMap((selection, selectionIndex) => {
      if (target.selectionIndex !== undefined && target.selectionIndex !== selectionIndex) return [];
      const offset = selection - input.pivot;
      if (Math.abs(offset) <= Number.EPSILON) return [];
      const current = input.pivot + offset * input.factor;
      const correction = target.position - current;
      if (Math.abs(correction) > input.tolerance) return [];
      const factor = (target.position - input.pivot) / offset;
      if (!Number.isFinite(factor) || factor < input.minimumFactor || factor > input.maximumFactor) {
        return [];
      }
      return [
        {
          factor,
          guide: target.guide,
          priority: target.priority + selectionIndex,
          screenDistance: Math.abs(correction) / input.unitsPerCssPixel,
        },
      ];
    }),
  );
}

function sameGuide(left: AlignmentGuide, right: AlignmentGuide) {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.axis === right.axis && left.entityId === right.entityId && left.position === right.position;
}

function validBounds(bounds: FrameSnapBounds) {
  return (
    Number.isFinite(bounds.bottom) &&
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.right) &&
    Number.isFinite(bounds.top) &&
    bounds.bottom >= bounds.top &&
    bounds.right >= bounds.left
  );
}

/**
 * Snaps exact prepared selection bounds to frame and object guide lines in
 * viewport space. Only the tolerance is converted from CSS pixels; device
 * pixels never enter the calculation. The chosen correction is converted back
 * to the existing authoring delta, so preview and commit share one value
 * without evaluating Scene geometry here.
 */
export function snapViewportDragToFrame(
  input: Readonly<{
    basis: FrameSnapBasis | null;
    cameraScale: number;
    disabled: boolean;
    toleranceCssPx?: number;
    viewportDelta: Point;
    viewportUnitsPerCssPixel: Point;
  }>,
): Readonly<{ delta: Point; guides: readonly AlignmentGuide[] }> {
  const { basis, disabled, viewportDelta, viewportUnitsPerCssPixel } = input;
  if (
    disabled ||
    basis === null ||
    !validBounds(basis.frame) ||
    !validBounds(basis.selection) ||
    !Number.isFinite(input.cameraScale) ||
    input.cameraScale <= 0 ||
    !Number.isFinite(viewportUnitsPerCssPixel.x) ||
    !Number.isFinite(viewportUnitsPerCssPixel.y) ||
    viewportUnitsPerCssPixel.x <= 0 ||
    viewportUnitsPerCssPixel.y <= 0
  ) {
    return { delta: viewportDelta, guides: [] };
  }

  const tolerance = input.toleranceCssPx ?? FRAME_ALIGNMENT_SNAP_TOLERANCE_CSS_PX;
  if (!Number.isFinite(tolerance) || tolerance < 0) return { delta: viewportDelta, guides: [] };

  const preparedDelta = {
    x: viewportDelta.x * input.cameraScale,
    y: viewportDelta.y * input.cameraScale,
  };
  const movedSelection = {
    bottom: basis.selection.bottom + preparedDelta.y,
    left: basis.selection.left + preparedDelta.x,
    right: basis.selection.right + preparedDelta.x,
    top: basis.selection.top + preparedDelta.y,
  };
  const objectTargets = orderedObjectTargets(basis.objects);
  const horizontal = closestCandidate(
    [
      { correction: basis.frame.left - movedSelection.left, guide: "frame-left", priority: 0 },
      {
        correction: center(basis.frame.left, basis.frame.right) - center(movedSelection.left, movedSelection.right),
        guide: "frame-center-x",
        priority: 1,
      },
      { correction: basis.frame.right - movedSelection.right, guide: "frame-right", priority: 2 },
      ...objectAxisCandidates(objectTargets, movedSelection, "x", 3),
    ],
    tolerance * viewportUnitsPerCssPixel.x,
  );
  const vertical = closestCandidate(
    [
      { correction: basis.frame.top - movedSelection.top, guide: "frame-top", priority: 0 },
      {
        correction: center(basis.frame.top, basis.frame.bottom) - center(movedSelection.top, movedSelection.bottom),
        guide: "frame-center-y",
        priority: 1,
      },
      { correction: basis.frame.bottom - movedSelection.bottom, guide: "frame-bottom", priority: 2 },
      ...objectAxisCandidates(objectTargets, movedSelection, "y", 3),
    ],
    tolerance * viewportUnitsPerCssPixel.y,
  );
  return {
    delta: {
      x: viewportDelta.x + (horizontal?.correction ?? 0) / input.cameraScale,
      y: viewportDelta.y + (vertical?.correction ?? 0) / input.cameraScale,
    },
    guides: [horizontal?.guide, vertical?.guide].filter((guide): guide is AlignmentGuide => guide !== undefined),
  };
}

/** Snaps a uniform resize factor using the same prepared frame/object guide
 * ordering as move snapping. The result stays a single factor, so the existing
 * Rust scale + position batch remains the only resize authority. */
export function snapUniformResizeToFrame(
  input: Readonly<{
    basis: FrameSnapBasis | null;
    disabled: boolean;
    factor: number;
    maximumFactor: number;
    minimumFactor: number;
    pivot: Point;
    toleranceCssPx?: number;
    viewportUnitsPerCssPixel: Point;
  }>,
): Readonly<{ factor: number; guides: readonly AlignmentGuide[] }> {
  const { basis, viewportUnitsPerCssPixel } = input;
  if (
    input.disabled ||
    basis === null ||
    !validBounds(basis.frame) ||
    !validBounds(basis.selection) ||
    !Number.isFinite(input.factor) ||
    !Number.isFinite(input.minimumFactor) ||
    !Number.isFinite(input.maximumFactor) ||
    input.minimumFactor <= 0 ||
    input.maximumFactor < input.minimumFactor ||
    input.factor < input.minimumFactor ||
    input.factor > input.maximumFactor ||
    !Number.isFinite(input.pivot.x) ||
    !Number.isFinite(input.pivot.y) ||
    !Number.isFinite(viewportUnitsPerCssPixel.x) ||
    !Number.isFinite(viewportUnitsPerCssPixel.y) ||
    viewportUnitsPerCssPixel.x <= 0 ||
    viewportUnitsPerCssPixel.y <= 0
  ) {
    return { factor: input.factor, guides: [] };
  }

  const tolerance = input.toleranceCssPx ?? FRAME_ALIGNMENT_SNAP_TOLERANCE_CSS_PX;
  if (!Number.isFinite(tolerance) || tolerance < 0) return { factor: input.factor, guides: [] };
  const objects = orderedObjectTargets(basis.objects);
  const horizontal = uniformResizeAxisCandidates({
    axis: "x",
    factor: input.factor,
    maximumFactor: input.maximumFactor,
    minimumFactor: input.minimumFactor,
    objects,
    pivot: input.pivot.x,
    selection: basis.selection,
    targets: [
      { guide: "frame-left", position: basis.frame.left, priority: 0, selectionIndex: 0 },
      {
        guide: "frame-center-x",
        position: center(basis.frame.left, basis.frame.right),
        priority: 0,
        selectionIndex: 1,
      },
      { guide: "frame-right", position: basis.frame.right, priority: 0, selectionIndex: 2 },
    ],
    tolerance: tolerance * viewportUnitsPerCssPixel.x,
    unitsPerCssPixel: viewportUnitsPerCssPixel.x,
  });
  const vertical = uniformResizeAxisCandidates({
    axis: "y",
    factor: input.factor,
    maximumFactor: input.maximumFactor,
    minimumFactor: input.minimumFactor,
    objects,
    pivot: input.pivot.y,
    selection: basis.selection,
    targets: [
      { guide: "frame-top", position: basis.frame.top, priority: 0, selectionIndex: 0 },
      {
        guide: "frame-center-y",
        position: center(basis.frame.top, basis.frame.bottom),
        priority: 0,
        selectionIndex: 1,
      },
      { guide: "frame-bottom", position: basis.frame.bottom, priority: 0, selectionIndex: 2 },
    ],
    tolerance: tolerance * viewportUnitsPerCssPixel.y,
    unitsPerCssPixel: viewportUnitsPerCssPixel.y,
  });
  const candidates = [...horizontal, ...vertical];
  const winner = candidates.reduce<UniformResizeCandidate | null>((closest, candidate) => {
    if (
      closest === null ||
      candidate.screenDistance < closest.screenDistance ||
      (candidate.screenDistance === closest.screenDistance && candidate.priority < closest.priority)
    ) {
      return candidate;
    }
    return closest;
  }, null);
  if (!winner) return { factor: input.factor, guides: [] };

  const guides: AlignmentGuide[] = [];
  for (const candidate of candidates) {
    if (Math.abs(candidate.factor - winner.factor) > 1e-9) continue;
    if (guides.some((guide) => sameGuide(guide, candidate.guide))) continue;
    guides.push(candidate.guide);
  }
  return { factor: winner.factor, guides };
}
