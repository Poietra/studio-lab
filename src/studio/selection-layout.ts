import type { FrameSnapBounds } from "./frame-alignment-snap";
import type { Point } from "./model";

export const SELECTION_LAYOUT_COMMANDS = [
  "align-left",
  "align-horizontal-center",
  "align-right",
  "align-top",
  "align-vertical-middle",
  "align-bottom",
  "distribute-horizontal",
  "distribute-vertical",
] as const;

export type SelectionLayoutCommand = (typeof SELECTION_LAYOUT_COMMANDS)[number];

export type SelectionLayoutTarget = Readonly<{
  bounds: FrameSnapBounds;
  entityId: string;
  position: Point;
}>;

export type SelectionLayoutPlan =
  | Readonly<{
      kind: "unavailable";
      reason: string;
    }>
  | Readonly<{
      kind: "valid";
      positions: Readonly<Record<string, Point>>;
      targetEntityIds: readonly string[];
    }>;

const POSITION_EPSILON = 0.000_001;

export function isSelectionLayoutCommand(command: string): command is SelectionLayoutCommand {
  return (SELECTION_LAYOUT_COMMANDS as readonly string[]).includes(command);
}

export function selectionLayoutMinimumCount(command: SelectionLayoutCommand) {
  return command.startsWith("distribute-") ? 3 : 2;
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

function center(start: number, end: number) {
  return start + (end - start) / 2;
}

function axisLayout(
  command: SelectionLayoutCommand,
  targets: readonly SelectionLayoutTarget[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  if (command === "align-left" || command === "align-horizontal-center" || command === "align-right") {
    const outerLeft = Math.min(...targets.map(({ bounds }) => bounds.left));
    const outerRight = Math.max(...targets.map(({ bounds }) => bounds.right));
    const target =
      command === "align-left" ? outerLeft : command === "align-right" ? outerRight : center(outerLeft, outerRight);
    for (const item of targets) {
      const current =
        command === "align-left"
          ? item.bounds.left
          : command === "align-right"
            ? item.bounds.right
            : center(item.bounds.left, item.bounds.right);
      result.set(item.entityId, target - current);
    }
    return result;
  }
  if (command === "align-top" || command === "align-vertical-middle" || command === "align-bottom") {
    const outerTop = Math.min(...targets.map(({ bounds }) => bounds.top));
    const outerBottom = Math.max(...targets.map(({ bounds }) => bounds.bottom));
    const target =
      command === "align-top" ? outerTop : command === "align-bottom" ? outerBottom : center(outerTop, outerBottom);
    for (const item of targets) {
      const current =
        command === "align-top"
          ? item.bounds.top
          : command === "align-bottom"
            ? item.bounds.bottom
            : center(item.bounds.top, item.bounds.bottom);
      result.set(item.entityId, target - current);
    }
    return result;
  }

  const horizontal = command === "distribute-horizontal";
  const ordered = [...targets].sort((left, right) => {
    const leftEdge = horizontal ? left.bounds.left : left.bounds.top;
    const rightEdge = horizontal ? right.bounds.left : right.bounds.top;
    return leftEdge - rightEdge || left.entityId.localeCompare(right.entityId);
  });
  const outerStart = Math.min(...ordered.map(({ bounds }) => (horizontal ? bounds.left : bounds.top)));
  const outerEnd = Math.max(...ordered.map(({ bounds }) => (horizontal ? bounds.right : bounds.bottom)));
  const sizes = ordered.map(({ bounds }) => (horizontal ? bounds.right - bounds.left : bounds.bottom - bounds.top));
  const gap = (outerEnd - outerStart - sizes.reduce((total, size) => total + size, 0)) / (ordered.length - 1);
  let cursor = outerStart;
  ordered.forEach((item, index) => {
    const current = horizontal ? item.bounds.left : item.bounds.top;
    result.set(item.entityId, cursor - current);
    cursor += sizes[index]! + gap;
  });
  return result;
}

export function planSelectionLayout(
  command: SelectionLayoutCommand,
  input: Readonly<{
    cameraScale: number;
    targets: readonly SelectionLayoutTarget[];
  }>,
): SelectionLayoutPlan {
  const minimumCount = selectionLayoutMinimumCount(command);
  if (input.targets.length < minimumCount) {
    return {
      kind: "unavailable",
      reason:
        minimumCount === 3
          ? "Select at least three objects to distribute them."
          : "Select at least two objects to align them.",
    };
  }
  if (!Number.isFinite(input.cameraScale) || input.cameraScale <= 0) {
    return { kind: "unavailable", reason: "The current camera scale cannot be used for layout." };
  }
  const ids = new Set<string>();
  for (const target of input.targets) {
    if (
      ids.has(target.entityId) ||
      !validBounds(target.bounds) ||
      !Number.isFinite(target.position.x) ||
      !Number.isFinite(target.position.y)
    ) {
      return { kind: "unavailable", reason: "Exact geometry is unavailable for the complete selection." };
    }
    ids.add(target.entityId);
  }

  const corrections = axisLayout(command, input.targets);
  const horizontal =
    command === "distribute-horizontal" ||
    (command.startsWith("align-") &&
      (command === "align-left" || command === "align-horizontal-center" || command === "align-right"));
  const positions: Record<string, Point> = {};
  let changed = false;
  for (const target of input.targets) {
    const correction = corrections.get(target.entityId);
    if (correction === undefined || !Number.isFinite(correction)) {
      return { kind: "unavailable", reason: "Exact geometry is unavailable for the complete selection." };
    }
    const position = {
      x: target.position.x + (horizontal ? correction / input.cameraScale : 0),
      y: target.position.y + (horizontal ? 0 : correction / input.cameraScale),
    };
    positions[target.entityId] = position;
    changed ||=
      Math.abs(position.x - target.position.x) > POSITION_EPSILON ||
      Math.abs(position.y - target.position.y) > POSITION_EPSILON;
  }
  if (!changed) return { kind: "unavailable", reason: "The selected objects already have this layout." };
  return {
    kind: "valid",
    positions,
    targetEntityIds: [...ids].sort(),
  };
}
