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
