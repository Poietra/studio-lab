import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

import { cn } from "../lib/cn";
import type { Interval, MotionEasing } from "./model";

const MINIMUM_DURATION = 0.1;

export type AppliedMotionClipAnchor = Readonly<{
  maximumDuration: number;
  sourceTime: number;
  workingTime: number;
}>;

export type AppliedMotionClip = Readonly<{
  anchors: readonly AppliedMotionClipAnchor[];
  easing: MotionEasing;
  entityId: string;
  interval: Interval;
  label: string;
  maximumDuration: number;
  operationId: string;
  programIndex: number;
  readOnlyReason: string | null;
  sourceStart: number;
  transactionId: string;
}>;

export type AppliedMotionClipChange = Readonly<{
  duration: number;
  sourceStart: number;
}>;

type ClipPreview = AppliedMotionClipChange & Readonly<{ interval: Interval }>;
type DragMode = "end" | "move" | "start";
type ClipDrag = Readonly<{
  mode: DragMode;
  originX: number;
  pointerId: number;
}>;

function intervalStyle(interval: Interval, duration: number) {
  return {
    left: `${(interval.start / duration) * 100}%`,
    width: `${Math.max(0.25, ((interval.end - interval.start) / duration) * 100)}%`,
  };
}

function closestAnchor(
  anchors: readonly AppliedMotionClipAnchor[],
  desiredWorkingTime: number,
) {
  return anchors.reduce<AppliedMotionClipAnchor | null>((closest, anchor) => (
    !closest
    || Math.abs(anchor.workingTime - desiredWorkingTime) < Math.abs(closest.workingTime - desiredWorkingTime)
      ? anchor
      : closest
  ), null);
}

function adjacentAnchor(
  clip: AppliedMotionClip,
  direction: -1 | 1,
  duration: number,
  keepEnd: boolean,
) {
  const eligible = clip.anchors.filter((anchor) => {
    const nextDuration = keepEnd ? clip.interval.end - anchor.workingTime : duration;
    return nextDuration >= MINIMUM_DURATION - 0.0005 && nextDuration <= anchor.maximumDuration + 0.0005;
  });
  const currentIndex = eligible.findIndex((anchor) => (
    Math.abs(anchor.sourceTime - clip.sourceStart) < 0.0005
  ));
  const fallbackIndex = eligible.findIndex((anchor) => anchor.sourceTime > clip.sourceStart) - 1;
  const index = currentIndex >= 0 ? currentIndex : Math.max(0, fallbackIndex);
  return eligible[index + direction] ?? null;
}

export function TimelineMotionClip({
  clip,
  duration,
  editing,
  onChange,
  onSelect,
}: Readonly<{
  clip: AppliedMotionClip;
  duration: number;
  editing: boolean;
  onChange: (change: AppliedMotionClipChange) => void;
  onSelect: () => void;
}>) {
  const [preview, setPreview] = useState<ClipPreview | null>(null);
  const drag = useRef<ClipDrag | null>(null);
  const suppressClick = useRef(false);
  const displayedInterval = preview?.interval ?? clip.interval;
  const sourceDuration = clip.interval.end - clip.interval.start;

  function previewAtPointer(event: PointerEvent<HTMLButtonElement>, mode: DragMode): ClipPreview | null {
    const lane = event.currentTarget.closest<HTMLElement>("[data-timeline-lane]");
    const bounds = lane?.getBoundingClientRect();
    const active = drag.current;
    if (!bounds?.width || !active) return null;
    const pointerTime = Math.min(duration, Math.max(0, (
      (event.clientX - bounds.left) / bounds.width
    ) * duration));
    if (mode === "end") {
      const nextDuration = Math.min(
        clip.maximumDuration,
        Math.max(MINIMUM_DURATION, pointerTime - clip.interval.start),
      );
      return {
        duration: nextDuration,
        interval: { end: clip.interval.start + nextDuration, start: clip.interval.start },
        sourceStart: clip.sourceStart,
      };
    }
    const desiredStart = mode === "move"
      ? clip.interval.start + ((event.clientX - active.originX) / bounds.width) * duration
      : pointerTime;
    const anchor = closestAnchor(clip.anchors.filter((candidate) => {
      const nextDuration = mode === "start"
        ? clip.interval.end - candidate.workingTime
        : sourceDuration;
      return nextDuration >= MINIMUM_DURATION - 0.0005
        && nextDuration <= candidate.maximumDuration + 0.0005;
    }), desiredStart);
    if (!anchor) return null;
    const nextDuration = mode === "start"
      ? clip.interval.end - anchor.workingTime
      : sourceDuration;
    return {
      duration: nextDuration,
      interval: {
        end: mode === "start" ? clip.interval.end : anchor.workingTime + sourceDuration,
        start: anchor.workingTime,
      },
      sourceStart: anchor.sourceTime,
    };
  }

  function startDrag(mode: DragMode, event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    drag.current = { mode, originX: event.clientX, pointerId: event.pointerId };
    suppressClick.current = false;
    setPreview(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - active.originX) < 3) return;
    suppressClick.current = true;
    setPreview(previewAtPointer(event, active.mode));
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = Math.abs(event.clientX - active.originX) >= 3
      ? previewAtPointer(event, active.mode) ?? preview
      : null;
    drag.current = null;
    setPreview(null);
    if (next) onChange({ duration: next.duration, sourceStart: next.sourceStart });
  }

  function cancelDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setPreview(null);
  }

  function moveWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const anchor = adjacentAnchor(clip, event.key === "ArrowLeft" ? -1 : 1, sourceDuration, false);
    if (anchor) onChange({ duration: sourceDuration, sourceStart: anchor.sourceTime });
  }

  function startWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const anchor = adjacentAnchor(clip, event.key === "ArrowLeft" ? -1 : 1, sourceDuration, true);
    if (!anchor) return;
    onChange({ duration: clip.interval.end - anchor.workingTime, sourceStart: anchor.sourceTime });
  }

  function endWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const amount = event.shiftKey ? 0.5 : 0.1;
    const nextDuration = Math.min(
      clip.maximumDuration,
      Math.max(MINIMUM_DURATION, sourceDuration + (event.key === "ArrowLeft" ? -amount : amount)),
    );
    if (Math.abs(nextDuration - sourceDuration) >= 0.0005) {
      onChange({ duration: nextDuration, sourceStart: clip.sourceStart });
    }
  }

  const disabled = clip.readOnlyReason !== null;
  return (
    <div
      className="absolute inset-y-1 z-10 min-w-px"
      data-applied-motion-clip-wrapper={clip.operationId}
      style={intervalStyle(displayedInterval, duration)}
    >
      <button
        aria-keyshortcuts="ArrowLeft ArrowRight"
        aria-label={`Edit ${clip.label} motion clip`}
        aria-pressed={editing}
        className={cn(
          "absolute inset-0 size-full touch-none overflow-hidden border px-1 text-left text-[9px] outline-none",
          disabled
            ? "cursor-not-allowed border-zinc-700 bg-zinc-800 text-zinc-600"
            : "cursor-grab border-sky-700 bg-sky-950 text-sky-300 active:cursor-grabbing hover:bg-sky-900 focus-visible:ring-2 focus-visible:ring-sky-300",
          editing && "border-sky-300 bg-sky-900 text-sky-100",
        )}
        data-applied-motion-clip={clip.operationId}
        disabled={disabled}
        onClick={() => {
          if (!suppressClick.current) onSelect();
          suppressClick.current = false;
        }}
        onKeyDown={moveWithKeyboard}
        onLostPointerCapture={finishDrag}
        onPointerCancel={cancelDrag}
        onPointerDown={(event) => startDrag("move", event)}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        title={clip.readOnlyReason ?? `${clip.label} · ${clip.easing} · Drag to a safe source anchor`}
        type="button"
      >
        <span className="block truncate">Motion</span>
      </button>
      {editing && !disabled ? (
        <>
          <button
            aria-keyshortcuts="ArrowLeft ArrowRight"
            aria-label={`Adjust ${clip.label} motion start`}
            className="absolute -left-1 top-1/2 z-20 size-3 touch-none -translate-y-1/2 cursor-ew-resize border border-sky-100 bg-sky-500 outline-none focus-visible:ring-2 focus-visible:ring-sky-200"
            data-motion-clip-start-handle={clip.operationId}
            onKeyDown={startWithKeyboard}
            onLostPointerCapture={finishDrag}
            onPointerCancel={cancelDrag}
            onPointerDown={(event) => startDrag("start", event)}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            title="Drag or use Left/Right to snap the start to a safe source anchor"
            type="button"
          />
          <button
            aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
            aria-label={`Adjust ${clip.label} motion end`}
            className="absolute -right-1 top-1/2 z-20 size-3 touch-none -translate-y-1/2 cursor-ew-resize border border-sky-100 bg-sky-500 outline-none focus-visible:ring-2 focus-visible:ring-sky-200"
            data-motion-clip-end-handle={clip.operationId}
            onKeyDown={endWithKeyboard}
            onLostPointerCapture={finishDrag}
            onPointerCancel={cancelDrag}
            onPointerDown={(event) => startDrag("end", event)}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            title="Drag or use Left/Right to change duration"
            type="button"
          />
        </>
      ) : null}
    </div>
  );
}
