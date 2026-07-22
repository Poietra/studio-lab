import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useRef,
  useState,
} from "react";
import { useMotionValue } from "motion/react";

import { cn } from "../lib/cn";

export type ResizeDirection = "e" | "n" | "ne" | "nw" | "s" | "se" | "sw" | "w";

type Rect = Readonly<{
  bottom: number;
  left: number;
  right: number;
  top: number;
}>;

type ResizeSnapshot = Readonly<{
  bounds: Rect;
  motionX: number;
  motionY: number;
  rect: Rect;
}>;

const MINIMUM_SIZE = { height: 176, width: 288 } as const;
const EDGE_INSET = 4;
const KEYBOARD_STEP = 8;

function constrainedBounds(bounds: DOMRect): Rect {
  return {
    bottom: bounds.bottom - EDGE_INSET,
    left: bounds.left + EDGE_INSET,
    right: bounds.right - EDGE_INSET,
    top: bounds.top + EDGE_INSET,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function usePanelResize(boundsRef: RefObject<HTMLElement | null>) {
  const panelRef = useRef<HTMLElement | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [size, setSize] = useState(() => ({
    height: Math.min(190, window.innerHeight - 112),
    width: Math.min(400, window.innerWidth - 32),
  }));
  const active = useRef<Readonly<{
    direction: ResizeDirection;
    pointerId: number;
    snapshot: ResizeSnapshot;
    start: Readonly<{ x: number; y: number }>;
  }> | null>(null);

  function snapshot(): ResizeSnapshot | null {
    const panel = panelRef.current;
    const bounds = boundsRef.current;
    if (!panel || !bounds) return null;
    return {
      bounds: constrainedBounds(bounds.getBoundingClientRect()),
      motionX: x.get(),
      motionY: y.get(),
      rect: panel.getBoundingClientRect(),
    };
  }

  function applyResize(direction: ResizeDirection, deltaX: number, deltaY: number, start: ResizeSnapshot) {
    const minimumWidth = Math.min(MINIMUM_SIZE.width, start.bounds.right - start.bounds.left);
    const minimumHeight = Math.min(MINIMUM_SIZE.height, start.bounds.bottom - start.bounds.top);
    let left = start.rect.left;
    let right = start.rect.right;
    let top = start.rect.top;
    let bottom = start.rect.bottom;

    if (direction.includes("w")) left = clamp(left + deltaX, start.bounds.left, right - minimumWidth);
    if (direction.includes("e")) right = clamp(right + deltaX, left + minimumWidth, start.bounds.right);
    if (direction.includes("n")) top = clamp(top + deltaY, start.bounds.top, bottom - minimumHeight);
    if (direction.includes("s")) bottom = clamp(bottom + deltaY, top + minimumHeight, start.bounds.bottom);

    x.set(start.motionX + left - start.rect.left);
    y.set(start.motionY + top - start.rect.top);
    setSize({ height: bottom - top, width: right - left });
  }

  function onPointerDown(direction: ResizeDirection, event: PointerEvent<HTMLButtonElement>) {
    const initial = snapshot();
    if (!initial) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = {
      direction,
      pointerId: event.pointerId,
      snapshot: initial,
      start: { x: event.clientX, y: event.clientY },
    };
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const resize = active.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    applyResize(
      resize.direction,
      event.clientX - resize.start.x,
      event.clientY - resize.start.y,
      resize.snapshot,
    );
  }

  function finishPointerResize(event: PointerEvent<HTMLButtonElement>) {
    if (active.current?.pointerId !== event.pointerId) return;
    active.current = null;
  }

  function onKeyDown(direction: ResizeDirection, event: KeyboardEvent<HTMLButtonElement>) {
    const horizontal = direction.includes("e") || direction.includes("w");
    const vertical = direction.includes("n") || direction.includes("s");
    const deltaX = horizontal
      ? event.key === "ArrowLeft" ? -KEYBOARD_STEP : event.key === "ArrowRight" ? KEYBOARD_STEP : 0
      : 0;
    const deltaY = vertical
      ? event.key === "ArrowUp" ? -KEYBOARD_STEP : event.key === "ArrowDown" ? KEYBOARD_STEP : 0
      : 0;
    if (deltaX === 0 && deltaY === 0) return;
    const initial = snapshot();
    if (!initial) return;
    event.preventDefault();
    applyResize(direction, deltaX, deltaY, initial);
  }

  return {
    onKeyDown,
    onPointerCancel: finishPointerResize,
    onPointerDown,
    onPointerMove,
    onPointerUp: finishPointerResize,
    panelRef,
    size,
    x,
    y,
  } as const;
}

const HANDLES: readonly Readonly<{
  className: string;
  direction: ResizeDirection;
  label: string;
}>[] = [
  { className: "left-3 right-3 top-0 h-1.5 cursor-n-resize", direction: "n", label: "top edge" },
  { className: "bottom-0 left-3 right-3 h-1.5 cursor-s-resize", direction: "s", label: "bottom edge" },
  { className: "bottom-3 left-0 top-3 w-1.5 cursor-w-resize", direction: "w", label: "left edge" },
  { className: "bottom-3 right-0 top-3 w-1.5 cursor-e-resize", direction: "e", label: "right edge" },
  { className: "left-0 top-0 size-2.5 cursor-nw-resize border-l border-t border-zinc-500", direction: "nw", label: "top-left corner" },
  { className: "right-0 top-0 size-2.5 cursor-ne-resize border-r border-t border-zinc-500", direction: "ne", label: "top-right corner" },
  { className: "bottom-0 left-0 size-2.5 cursor-sw-resize border-b border-l border-zinc-500", direction: "sw", label: "bottom-left corner" },
  { className: "bottom-0 right-0 size-2.5 cursor-se-resize border-b border-r border-zinc-500", direction: "se", label: "bottom-right corner" },
];

export function PanelResizeHandles({
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: Readonly<Pick<ReturnType<typeof usePanelResize>,
  "onKeyDown" | "onPointerCancel" | "onPointerDown" | "onPointerMove" | "onPointerUp"
>>) {
  return HANDLES.map((handle) => (
    <button
      aria-label={`Resize Magic Edit from ${handle.label}`}
      className={cn("absolute z-20 touch-none bg-transparent hover:bg-sky-400/30 focus-visible:bg-sky-400/30", handle.className)}
      data-resize-direction={handle.direction}
      key={handle.direction}
      onKeyDown={(event) => onKeyDown(handle.direction, event)}
      onPointerCancel={onPointerCancel}
      onPointerDown={(event) => onPointerDown(handle.direction, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      title={`Resize from ${handle.label}`}
      type="button"
    />
  ));
}
