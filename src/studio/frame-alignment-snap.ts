import type { Point } from "./model";

export const FRAME_ALIGNMENT_SNAP_TOLERANCE_CSS_PX = 8;

export type FrameAlignmentGuide =
  | "frame-bottom"
  | "frame-center-x"
  | "frame-center-y"
  | "frame-left"
  | "frame-right"
  | "frame-top";

export type FrameSnapBounds = Readonly<{
  bottom: number;
  left: number;
  right: number;
  top: number;
}>;

export type FrameSnapBasis = Readonly<{
  frame: FrameSnapBounds;
  selection: FrameSnapBounds;
}>;

export type PreparedMoveSnapBasis = Readonly<{
  bounds: FrameSnapBounds;
  entityIds: readonly string[];
}>;

type AxisCandidate = Readonly<{
  correction: number;
  guide: FrameAlignmentGuide;
}>;

function center(start: number, end: number) {
  return start + (end - start) / 2;
}

function closestCandidate(candidates: readonly AxisCandidate[], tolerance: number): AxisCandidate | null {
  let closest: AxisCandidate | null = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate.correction) > tolerance) continue;
    if (closest === null || Math.abs(candidate.correction) < Math.abs(closest.correction)) closest = candidate;
  }
  return closest;
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
 * Snaps exact prepared selection bounds in viewport space. Only the tolerance
 * is converted from CSS pixels; device pixels never enter the calculation.
 * The chosen correction is converted back to the existing authoring delta, so
 * preview and commit share one value without evaluating Scene geometry here.
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
): Readonly<{ delta: Point; guides: readonly FrameAlignmentGuide[] }> {
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
  const horizontal = closestCandidate(
    [
      { correction: basis.frame.left - movedSelection.left, guide: "frame-left" },
      {
        correction: center(basis.frame.left, basis.frame.right) - center(movedSelection.left, movedSelection.right),
        guide: "frame-center-x",
      },
      { correction: basis.frame.right - movedSelection.right, guide: "frame-right" },
    ],
    tolerance * viewportUnitsPerCssPixel.x,
  );
  const vertical = closestCandidate(
    [
      { correction: basis.frame.top - movedSelection.top, guide: "frame-top" },
      {
        correction: center(basis.frame.top, basis.frame.bottom) - center(movedSelection.top, movedSelection.bottom),
        guide: "frame-center-y",
      },
      { correction: basis.frame.bottom - movedSelection.bottom, guide: "frame-bottom" },
    ],
    tolerance * viewportUnitsPerCssPixel.y,
  );
  return {
    delta: {
      x: viewportDelta.x + (horizontal?.correction ?? 0) / input.cameraScale,
      y: viewportDelta.y + (vertical?.correction ?? 0) / input.cameraScale,
    },
    guides: [horizontal?.guide, vertical?.guide].filter((guide): guide is FrameAlignmentGuide => guide !== undefined),
  };
}
