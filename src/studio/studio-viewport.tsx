import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

import { cn } from "../lib/cn";
import type {
  Interval,
  Point,
  ProjectedEntity,
  ProposedStateProjection,
  TimelineEvent,
  TimelineObjectTrack,
} from "./model";
import { EquationContent } from "./prototype-rendering";
import { quadraticPathData, type StudioMotionPath } from "./motion-paths";
import { StudioToolbar, type StudioTool } from "./studio-toolbar";
import { isTransitionOverlay } from "./workspace-projection";

export const STUDIO_VIEWPORT = { height: 360, width: 640 } as const;

export type InteractionMode = "animate" | "position";
export type StudioTimelineAnchor = Readonly<{
  sourceTime: number;
  workingTime: number;
}>;
export type EntityDragPreview = Readonly<{
  delta: Readonly<{ x: number; y: number }>;
  entityIds: readonly string[];
}>;

const ZERO_DELTA = { x: 0, y: 0 } as const;

export function entityDragDelta(preview: EntityDragPreview | null, entityId: string) {
  return preview?.entityIds.includes(entityId) ? preview.delta : ZERO_DELTA;
}

export function entityLabel(entity: ProjectedEntity) {
  return entity.content?.label ?? entity.content?.text ?? entity.id.split(":").at(-1) ?? entity.id;
}

function positionStyle(position: Readonly<{ x: number; y: number }>) {
  return {
    left: `${(position.x / STUDIO_VIEWPORT.width) * 100}%`,
    top: `${(position.y / STUDIO_VIEWPORT.height) * 100}%`,
  };
}

function transitionStyle(entity: ProjectedEntity) {
  const [, shape, color] = entity.type.split(":");
  return {
    className: cn(
      "pointer-events-none absolute left-1/2 top-1/2 z-20 size-20 -translate-x-1/2 -translate-y-1/2",
      shape === "circle" && "rounded-full",
      shape === "diamond" && "rotate-45",
      shape === "hexagon" && "[clip-path:polygon(25%_6.7%,75%_6.7%,100%_50%,75%_93.3%,25%_93.3%,0%_50%)]",
      color === "black" && "bg-black",
      color === "sky" && "bg-sky-500",
      color === "white" && "bg-white",
    ),
    style: { opacity: entity.opacity, scale: 0.05 + entity.opacity * 14 },
  };
}

function ObjectVisual({ entity }: Readonly<{ entity: ProjectedEntity }>) {
  if (entity.type === "MathTex") {
    return <EquationContent lines={entity.content?.displayLines ?? [entityLabel(entity)]} texParts={entity.content?.texParts} />;
  }
  if (entity.type === "Text") {
    return <span className="block max-w-56 text-pretty text-center text-sm leading-5">{entity.content?.text ?? entityLabel(entity)}</span>;
  }
  if (entity.type === "Arrow") {
    return (
      <svg aria-hidden="true" className="h-5 w-24" viewBox="0 0 96 20">
        <path d="M 2 10 H 88 M 80 3 L 89 10 L 80 17" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  }
  if (entity.type === "Line") {
    return <span aria-hidden="true" className="block h-px w-24 bg-zinc-400" />;
  }
  if (entity.type === "Rectangle" || entity.type === "SurroundingRectangle" || entity.type === "Square") {
    return <span aria-hidden="true" className="block h-14 w-32 border border-zinc-500" />;
  }
  if (entity.type === "Circle" || entity.type === "Dot") {
    return <span aria-hidden="true" className="block size-16 rounded-full border border-zinc-500" />;
  }
  if (entity.type === "RegularPolygon") {
    return <span aria-hidden="true" className="block size-16 border border-zinc-500 [clip-path:polygon(50%_0%,93%_25%,93%_75%,50%_100%,7%_75%,7%_25%)]" />;
  }
  return <span className="block border border-zinc-600 px-3 py-2 text-xs text-zinc-300">{entityLabel(entity)}</span>;
}

function formatTime(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = (value % 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${seconds}`;
}

function intervalStyle(interval: Interval, duration: number) {
  return {
    left: `${(interval.start / duration) * 100}%`,
    width: `${Math.max(0.25, ((interval.end - interval.start) / duration) * 100)}%`,
  };
}

function MotionControlHandle({
  onChange,
  onPreviewChange,
  path,
  previewDelta,
}: Readonly<{
  onChange: (path: StudioMotionPath, delta: Point) => void;
  onPreviewChange: (path: StudioMotionPath, delta: Point | null) => void;
  path: StudioMotionPath;
  previewDelta: Point;
}>) {
  const drag = useRef<Readonly<{
    pointerId: number;
    scale: Point;
    start: Point;
  }> | null>(null);
  const point = {
    x: path.control.x + previewDelta.x,
    y: path.control.y + previewDelta.y,
  };

  function finish(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = {
      x: (event.clientX - active.start.x) * active.scale.x,
      y: (event.clientY - active.start.y) * active.scale.y,
    };
    drag.current = null;
    onPreviewChange(path, null);
    if (Math.hypot(delta.x, delta.y) >= 0.5) onChange(path, delta);
  }

  function cancel(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    onPreviewChange(path, null);
  }

  return (
    <button
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
      aria-label={`Adjust motion path for ${path.entityId}`}
      className="absolute z-30 size-4 touch-none -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-200 bg-sky-500 outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
      data-motion-control={path.motionId}
      onKeyDown={(event) => {
        const amount = event.shiftKey ? 10 : 2;
        const delta = {
          ArrowDown: { x: 0, y: amount },
          ArrowLeft: { x: -amount, y: 0 },
          ArrowRight: { x: amount, y: 0 },
          ArrowUp: { x: 0, y: -amount },
        }[event.key];
        if (!delta) return;
        event.preventDefault();
        onChange(path, delta);
      }}
      onLostPointerCapture={finish}
      onPointerCancel={cancel}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.closest<HTMLElement>("[data-studio-transform-layer]")?.getBoundingClientRect();
        drag.current = {
          pointerId: event.pointerId,
          scale: {
            x: bounds?.width ? STUDIO_VIEWPORT.width / bounds.width : 1,
            y: bounds?.height ? STUDIO_VIEWPORT.height / bounds.height : 1,
          },
          start: { x: event.clientX, y: event.clientY },
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        onPreviewChange(path, {
          x: (event.clientX - active.start.x) * active.scale.x,
          y: (event.clientY - active.start.y) * active.scale.y,
        });
      }}
      onPointerUp={finish}
      style={positionStyle(point)}
      title="Drag to bend the path · Arrow keys adjust precisely"
      type="button"
    />
  );
}

function MotionPathOverlay({
  dragPreview,
  editableMotionIds,
  entities,
  interactionMode,
  motionPaths,
  onMotionControlChange,
}: Readonly<{
  dragPreview: EntityDragPreview | null;
  editableMotionIds: ReadonlySet<string>;
  entities: readonly ProjectedEntity[];
  interactionMode: InteractionMode;
  motionPaths: readonly StudioMotionPath[];
  onMotionControlChange: (path: StudioMotionPath, delta: Point) => void;
}>) {
  const [controlPreviews, setControlPreviews] = useState<ReadonlyMap<string, Point>>(() => new Map());
  const previewedMotionPaths = motionPaths.map((path) => {
    const preview = controlPreviews.get(path.motionId);
    return preview ? {
      ...path,
      control: { x: path.control.x + preview.x, y: path.control.y + preview.y },
    } : path;
  });
  const dragPaths = interactionMode === "animate" && dragPreview
    ? entities.flatMap((entity) => {
      if (!dragPreview.entityIds.includes(entity.id)) return [];
      const end = {
        x: entity.position.x + dragPreview.delta.x,
        y: entity.position.y + dragPreview.delta.y,
      };
      return [{
        control: {
          x: (entity.position.x + end.x) / 2,
          y: (entity.position.y + end.y) / 2,
        },
        end,
        entityId: entity.id,
        interval: { end: 0, start: 0 },
        motionId: `${entity.id}/drag-preview`,
        start: entity.position,
      } satisfies StudioMotionPath];
    })
    : [];
  return (
    <>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 size-full" viewBox="0 0 640 360">
        <defs>
          <marker id="studio-motion-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#38bdf8" />
          </marker>
        </defs>
        {previewedMotionPaths.map((path) => (
          <g key={`${path.entityId}/${path.motionId}`}>
            <path
              d={quadraticPathData(path)}
              data-motion-path={path.motionId}
              fill="none"
              markerEnd="url(#studio-motion-arrow)"
              stroke="#38bdf8"
              strokeDasharray="5 4"
              strokeWidth="1.5"
            />
            {editableMotionIds.has(path.motionId) ? (
              <path
                d={`M ${path.start.x} ${path.start.y} L ${path.control.x} ${path.control.y} L ${path.end.x} ${path.end.y}`}
                fill="none"
                opacity="0.5"
                stroke="#7dd3fc"
                strokeWidth="1"
              />
            ) : null}
          </g>
        ))}
        {dragPaths.map((path) => (
          <path
            d={quadraticPathData(path)}
            data-motion-preview={path.entityId}
            fill="none"
            key={path.motionId}
            markerEnd="url(#studio-motion-arrow)"
            stroke="#38bdf8"
            strokeDasharray="5 4"
            strokeWidth="1.5"
          />
        ))}
      </svg>
      {motionPaths.filter((path) => editableMotionIds.has(path.motionId)).map((path) => (
        <MotionControlHandle
          key={`${path.entityId}/${path.motionId}/control`}
          onChange={onMotionControlChange}
          onPreviewChange={(previewPath, delta) => {
            setControlPreviews((current) => {
              const next = new Map(current);
              if (delta) next.set(previewPath.motionId, delta);
              else next.delete(previewPath.motionId);
              return next;
            });
          }}
          path={path}
          previewDelta={controlPreviews.get(path.motionId) ?? ZERO_DELTA}
        />
      ))}
    </>
  );
}

function TimelinePlayhead({ currentTime, duration }: Readonly<{ currentTime: number; duration: number }>) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-sky-400"
      style={{ left: `${(currentTime / duration) * 100}%` }}
    />
  );
}

type SelectedLifetime = Readonly<{
  entityId: string;
  index: number;
}>;

function lifetimeTrimAnchors(
  anchors: readonly StudioTimelineAnchor[],
  interval: Interval,
) {
  return anchors.filter((anchor) => (
    anchor.workingTime - interval.start >= 0.1
    && interval.end - anchor.workingTime >= 0.01
  ));
}

function closestLifetimeAnchor(
  anchors: readonly StudioTimelineAnchor[],
  desiredEnd: number,
) {
  return anchors.reduce<StudioTimelineAnchor | null>((closest, anchor) => (
    !closest
    || Math.abs(anchor.workingTime - desiredEnd) < Math.abs(closest.workingTime - desiredEnd)
      ? anchor
      : closest
  ), null);
}

function TimelineLifetime({
  anchors,
  disabled,
  duration,
  interval,
  label,
  onSelect,
  onTrim,
  provisional,
  selectDisabled,
  selected,
}: Readonly<{
  anchors: readonly StudioTimelineAnchor[];
  disabled: boolean;
  duration: number;
  interval: Interval;
  label: string;
  onSelect: () => void;
  onTrim: (sourceAnchor: number) => void;
  provisional: boolean;
  selectDisabled: boolean;
  selected: boolean;
}>) {
  const [previewAnchor, setPreviewAnchor] = useState<StudioTimelineAnchor | null>(null);
  const trimDrag = useRef<Readonly<{ pointerId: number; startX: number }> | null>(null);
  const eligibleAnchors = lifetimeTrimAnchors(anchors, interval);
  const displayedInterval = previewAnchor
    ? { ...interval, end: previewAnchor.workingTime }
    : interval;

  function anchorAtPointer(event: PointerEvent<HTMLButtonElement>) {
    const lane = event.currentTarget.closest<HTMLElement>("[data-timeline-lane]");
    const bounds = lane?.getBoundingClientRect();
    if (!bounds?.width) return null;
    const desiredEnd = Math.min(duration, Math.max(0, (
      (event.clientX - bounds.left) / bounds.width
    ) * duration));
    return closestLifetimeAnchor(eligibleAnchors, desiredEnd);
  }

  function startTrim(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    event.currentTarget.setPointerCapture(event.pointerId);
    trimDrag.current = { pointerId: event.pointerId, startX: event.clientX };
    setPreviewAnchor(null);
  }

  function moveTrim(event: PointerEvent<HTMLButtonElement>) {
    const drag = trimDrag.current;
    if (!drag || drag.pointerId !== event.pointerId || Math.abs(event.clientX - drag.startX) < 3) return;
    setPreviewAnchor(anchorAtPointer(event));
  }

  function finishTrim(event: PointerEvent<HTMLButtonElement>) {
    const drag = trimDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    trimDrag.current = null;
    const anchor = anchorAtPointer(event) ?? previewAnchor;
    setPreviewAnchor(null);
    if (anchor && Math.abs(event.clientX - drag.startX) >= 3) onTrim(anchor.sourceTime);
  }

  return (
    <div
      className="absolute inset-y-1"
      style={intervalStyle(displayedInterval, duration)}
    >
      <button
        aria-label={`Select ${label} lifetime from ${interval.start.toFixed(2)} to ${interval.end.toFixed(2)} seconds`}
        aria-pressed={selected}
        className={cn(
          "absolute inset-0 size-full border text-left",
          provisional ? "border-dashed border-sky-700 bg-sky-950" : "border-zinc-600 bg-zinc-800",
          selected && "border-sky-400 bg-sky-950",
          selectDisabled && "cursor-not-allowed",
        )}
        data-timeline-lifetime
        disabled={selectDisabled}
        onClick={onSelect}
        title={`Present ${interval.start.toFixed(2)}–${interval.end.toFixed(2)}s`}
        type="button"
      />
      {selected && !disabled && !selectDisabled && eligibleAnchors.length > 0 ? (
        <button
          aria-label={`Trim ${label} lifetime end`}
          className="absolute -right-1 top-1/2 z-30 size-3 -translate-y-1/2 cursor-ew-resize border border-sky-200 bg-sky-500"
          data-lifetime-trim-handle
          onLostPointerCapture={() => {
            trimDrag.current = null;
            setPreviewAnchor(null);
          }}
          onPointerCancel={() => {
            trimDrag.current = null;
            setPreviewAnchor(null);
          }}
          onPointerDown={startTrim}
          onPointerMove={moveTrim}
          onPointerUp={finishTrim}
          style={{ touchAction: "none" }}
          title="Drag left to trim. The end snaps to a safe source anchor."
          type="button"
        />
      ) : null}
    </div>
  );
}

function Timeline({
  anchors,
  appliedTransactionIds,
  currentTime,
  duration,
  events,
  interactionMode,
  isPlaying,
  lifetimeTrimDisabled,
  motionDuration,
  objectTracks,
  onInteractionModeChange,
  onLifetimeEndChange,
  onMotionDurationChange,
  onSelectEntity,
  onTimeChange,
  onTogglePlayback,
  readOnly,
  selectedIds,
}: Readonly<{
  anchors: readonly StudioTimelineAnchor[];
  appliedTransactionIds: ReadonlySet<string>;
  currentTime: number;
  duration: number;
  events: readonly TimelineEvent[];
  interactionMode: InteractionMode;
  isPlaying: boolean;
  motionDuration: number;
  objectTracks: readonly TimelineObjectTrack[];
  lifetimeTrimDisabled: boolean;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onLifetimeEndChange: (entityId: string, lifetimeStart: number, sourceAnchor: number) => void;
  onMotionDurationChange: (duration: number) => void;
  onSelectEntity: (entityId: string) => void;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  readOnly: boolean;
  selectedIds: ReadonlySet<string>;
}>) {
  const intervalEvents = events.flatMap((event) => event.interval ? [{ event, interval: event.interval }] : []);
  const [selectedLifetime, setSelectedLifetime] = useState<SelectedLifetime | null>(null);
  const selectedLifetimeTrack = selectedLifetime && selectedIds.has(selectedLifetime.entityId)
    ? objectTracks.find((track) => track.entityId === selectedLifetime.entityId)
    : null;
  const selectedLifetimeInterval = selectedLifetimeTrack && selectedLifetime
    ? selectedLifetimeTrack.lifetimes[selectedLifetime.index]
    : null;
  const selectedLifetimeAnchors = selectedLifetimeInterval
    ? lifetimeTrimAnchors(anchors, selectedLifetimeInterval)
    : [];
  return (
    <section className="shrink-0 border-t border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center gap-3">
        <button className="w-14 border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800" onClick={onTogglePlayback} type="button">
          {isPlaying ? "Pause" : "Play"}
        </button>
        <span className="w-24 tabular-nums text-xs text-zinc-400">{formatTime(currentTime)}</span>
        <input
          aria-label="Scene playhead"
          className="min-w-0 flex-1 accent-sky-500"
          max={duration}
          min="0"
          onChange={(event) => onTimeChange(Number(event.currentTarget.value))}
          step="0.01"
          type="range"
          value={currentTime}
        />
        <span className="w-16 text-right tabular-nums text-xs text-zinc-600">{formatTime(duration)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-zinc-800 pt-2 text-xs">
        <span className="text-zinc-400">When dragging an object</span>
        <div aria-label="Object drag behavior" className="flex border border-zinc-700" role="group">
          {(["position", "animate"] as const).map((mode) => (
            <button
              aria-pressed={interactionMode === mode}
              className={cn(
                "px-2.5 py-1 text-xs",
                interactionMode === mode ? "bg-sky-950 text-sky-300" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
              )}
              key={mode}
              onClick={() => onInteractionModeChange(mode)}
              type="button"
            >
              {mode === "position" ? "Set position" : "Create animation"}
            </button>
          ))}
        </div>
        <span className="hidden text-pretty text-[10px] text-zinc-600 md:inline">
          {interactionMode === "position" ? "Updates the layout without adding time." : "Adds motion starting at the playhead."}
        </span>
        {interactionMode === "animate" ? (
          <label className="ml-auto flex items-center gap-2 text-[10px] text-zinc-500">
            Motion duration
            <input
              aria-label="New motion duration in seconds"
              className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-xs text-zinc-200 outline-none focus:border-sky-500"
              min="0.1"
              onChange={(event) => onMotionDurationChange(Math.max(0.1, Number(event.currentTarget.value)))}
              step="0.1"
              type="number"
              value={motionDuration}
            />
            <span>s</span>
          </label>
        ) : null}
      </div>
      {selectedLifetimeTrack && selectedLifetimeInterval ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]"
          onSubmit={(event) => {
            event.preventDefault();
            const sourceAnchor = Number(new FormData(event.currentTarget).get("lifetime-source-anchor"));
            if (!Number.isFinite(sourceAnchor)) return;
            onLifetimeEndChange(
              selectedLifetimeTrack.entityId,
              selectedLifetimeInterval.start,
              sourceAnchor,
            );
          }}
        >
          <span className="max-w-40 truncate text-zinc-400" title={selectedLifetimeTrack.label}>
            Lifetime end · {selectedLifetimeTrack.label}
          </span>
          {selectedLifetimeAnchors.length > 0 ? (
            <>
              <select
                aria-label={`Lifetime end for ${selectedLifetimeTrack.label}`}
                className="h-7 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600"
                defaultValue={selectedLifetimeAnchors.at(-1)?.sourceTime}
                disabled={lifetimeTrimDisabled}
                key={`${selectedLifetimeTrack.entityId}/${selectedLifetimeInterval.start}/${selectedLifetimeInterval.end}`}
                name="lifetime-source-anchor"
              >
                {selectedLifetimeAnchors.map((anchor) => (
                  <option key={anchor.sourceTime} value={anchor.sourceTime}>
                    {anchor.workingTime.toFixed(2)} s
                  </option>
                ))}
              </select>
              <button
                className="h-7 border border-zinc-700 px-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
                disabled={lifetimeTrimDisabled}
                type="submit"
              >
                Trim
              </button>
              <span className="text-pretty text-zinc-600">Snaps to a safe .py source anchor.</span>
            </>
          ) : (
            <span className="text-pretty text-amber-500">No earlier source anchor is available for this interval.</span>
          )}
          {lifetimeTrimDisabled ? (
            <span className="text-pretty text-zinc-600">Apply or discard the current draft first.</span>
          ) : null}
        </form>
      ) : null}
      <div aria-label="Scene object timeline" className="mt-3 max-h-56 overflow-y-auto border border-zinc-800 bg-zinc-900" role="group">
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] border-b border-zinc-800 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <div className="flex min-w-0 items-center px-2 text-[10px] font-medium text-zinc-400">Scene</div>
            <div className="relative h-8 min-w-0 overflow-hidden">
              {intervalEvents.map(({ event, interval }) => (
                <div
                  className={cn(
                    "absolute top-1 h-5 min-w-px border px-1 text-[9px] leading-4",
                    event.transactionId ? "border-sky-800 bg-sky-950 text-sky-300" : "border-zinc-700 bg-zinc-800 text-zinc-500",
                  )}
                  key={event.id}
                  style={intervalStyle(interval, duration)}
                  title={`${event.label} ${interval.start.toFixed(2)}–${interval.end.toFixed(2)}s`}
                >
                  <span className="block truncate">{event.label}</span>
                </div>
              ))}
              {anchors.map((anchor) => (
                <button
                  aria-label={`Move playhead to source anchor ${anchor.sourceTime.toFixed(3)} seconds`}
                  className="absolute bottom-0 top-0 z-10 w-px bg-amber-500/70 focus-visible:w-0.5"
                  key={anchor.sourceTime}
                  onClick={() => onTimeChange(anchor.workingTime)}
                  style={{ left: `${(anchor.workingTime / duration) * 100}%` }}
                  title={`Source anchor ${anchor.sourceTime.toFixed(3)}s · working time ${anchor.workingTime.toFixed(3)}s`}
                  type="button"
                />
              ))}
              <TimelinePlayhead currentTime={currentTime} duration={duration} />
            </div>
          </div>
          {objectTracks.map((track) => {
            const selected = selectedIds.has(track.entityId);
            const locked = readOnly
              || (track.provisional && !(track.transactionId && appliedTransactionIds.has(track.transactionId)));
            return (
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] border-b border-zinc-800 last:border-b-0 sm:grid-cols-[8rem_minmax(0,1fr)]" data-timeline-track={track.entityId} key={track.entityId}>
                <button
                  aria-pressed={selected}
                  className={cn(
                    "min-w-0 truncate px-2 text-left text-[10px]",
                    locked ? "cursor-not-allowed text-zinc-700" : "hover:bg-zinc-800",
                    selected ? "bg-sky-950 text-sky-300" : "text-zinc-500",
                  )}
                  disabled={locked}
                  onClick={() => onSelectEntity(track.entityId)}
                  title={`${track.label} · ${track.type}`}
                  type="button"
                >
                  {track.label}
                </button>
                <div className="relative h-7 min-w-0 overflow-hidden" data-timeline-lane>
                  {track.lifetimes.map((interval, index) => {
                    const lifetimeSelected = selected
                      && selectedLifetime?.entityId === track.entityId
                      && selectedLifetime.index === index;
                    return (
                      <TimelineLifetime
                        anchors={anchors}
                        disabled={locked || lifetimeTrimDisabled}
                        duration={duration}
                        interval={interval}
                        key={`${track.entityId}/lifetime/${index}`}
                        label={track.label}
                        onSelect={() => {
                          onSelectEntity(track.entityId);
                          setSelectedLifetime({ entityId: track.entityId, index });
                        }}
                        onTrim={(sourceAnchor) => onLifetimeEndChange(
                          track.entityId,
                          interval.start,
                          sourceAnchor,
                        )}
                        provisional={track.provisional}
                        selectDisabled={locked}
                        selected={lifetimeSelected}
                      />
                    );
                  })}
                  {track.animatedChannels.map((channel, index) => (
                    <div
                      className="absolute bottom-1 z-10 h-1.5 min-w-px bg-sky-400"
                      data-timeline-animation
                      key={`${track.entityId}/${channel.key}/${index}`}
                      style={intervalStyle(channel.interval, duration)}
                      title={`${channel.key} animation ${channel.interval.start.toFixed(2)}–${channel.interval.end.toFixed(2)}s`}
                    />
                  ))}
                  {track.lifetimes.length === 0 ? (
                    <span className="absolute inset-0 flex items-center px-2 text-[9px] text-zinc-700">Not present</span>
                  ) : null}
                  <TimelinePlayhead currentTime={currentTime} duration={duration} />
                </div>
              </div>
            );
          })}
      </div>
    </section>
  );
}

export function StudioViewport({
  anchors,
  appliedTransactionIds,
  boundaryActive,
  className,
  currentTime,
  draftTransactionId,
  dragPreview,
  duration,
  editableMotionIds,
  entities,
  incomingSceneName,
  insertTool,
  insertValue,
  interactionMode,
  isPlaying,
  lifetimeTrimDisabled,
  motionDuration,
  motionPaths,
  onCanvasPlace,
  onEntityKeyDown,
  onEntityPointerCancel,
  onEntityPointerDown,
  onEntityPointerMove,
  onEntityPointerUp,
  onInteractionModeChange,
  onInsertAtCenter,
  onInsertToolChange,
  onInsertValueChange,
  onLifetimeEndChange,
  onMotionControlChange,
  onMotionDurationChange,
  onSelectEntity,
  onTimeChange,
  onTogglePlayback,
  projection,
  readOnly,
  selectedIds,
}: Readonly<{
  anchors: readonly StudioTimelineAnchor[];
  appliedTransactionIds: ReadonlySet<string>;
  boundaryActive: boolean;
  className?: string;
  currentTime: number;
  draftTransactionId: string | null;
  dragPreview: EntityDragPreview | null;
  duration: number;
  editableMotionIds: ReadonlySet<string>;
  entities: readonly ProjectedEntity[];
  incomingSceneName: string | null;
  insertTool: StudioTool;
  insertValue: string;
  interactionMode: InteractionMode;
  isPlaying: boolean;
  lifetimeTrimDisabled: boolean;
  motionDuration: number;
  motionPaths: readonly StudioMotionPath[];
  onCanvasPlace: (point: Point) => void;
  onEntityKeyDown: (event: KeyboardEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityPointerDown: (event: PointerEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onInsertAtCenter: () => void;
  onInsertToolChange: (tool: StudioTool) => void;
  onInsertValueChange: (value: string) => void;
  onLifetimeEndChange: (entityId: string, lifetimeStart: number, sourceAnchor: number) => void;
  onMotionControlChange: (path: StudioMotionPath, delta: Point) => void;
  onMotionDurationChange: (duration: number) => void;
  onSelectEntity: (entityId: string) => void;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  projection: ProposedStateProjection;
  readOnly?: boolean;
  selectedIds: ReadonlySet<string>;
}>) {
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col bg-zinc-900", className)}>
      <StudioToolbar
        insertValue={insertValue}
        onInsertAtCenter={onInsertAtCenter}
        onInsertValueChange={onInsertValueChange}
        onToolChange={onInsertToolChange}
        tool={insertTool}
      />
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4">
        <div
          className="relative aspect-video w-full max-w-5xl overflow-hidden border border-zinc-700 bg-black"
          data-studio-canvas
          data-proposed-state-sample={projection.canvas.sampleId}
          data-scene-phase={boundaryActive ? "incoming" : "outgoing"}
          onPointerDown={(event) => {
            if (insertTool === "select" || boundaryActive) return;
            const target = event.target;
            if (target instanceof Element && target.closest("[data-studio-entity], [data-motion-control]")) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            onCanvasPlace({
              x: ((event.clientX - bounds.left) / bounds.width) * STUDIO_VIEWPORT.width,
              y: ((event.clientY - bounds.top) / bounds.height) * STUDIO_VIEWPORT.height,
            });
          }}
        >
          <div className="absolute inset-0 origin-center" data-studio-transform-layer style={{ scale: projection.camera.scale }}>
            <svg aria-hidden="true" className="absolute inset-0 size-full opacity-10" viewBox="0 0 640 360">
              <g stroke="#a1a1aa" strokeWidth="1">
                {[80, 160, 240, 320, 400, 480, 560].map((x) => <line key={`x-${x}`} x1={x} x2={x} y1="0" y2="360" />)}
                {[90, 180, 270].map((y) => <line key={`y-${y}`} x1="0" x2="640" y1={y} y2={y} />)}
              </g>
            </svg>
            <MotionPathOverlay
              dragPreview={dragPreview}
              editableMotionIds={editableMotionIds}
              entities={entities}
              interactionMode={interactionMode}
              motionPaths={motionPaths}
              onMotionControlChange={onMotionControlChange}
            />
            {entities.map((entity) => {
              if (!entity.present) return null;
              if (isTransitionOverlay(entity)) {
                const transition = transitionStyle(entity);
                return <div className={transition.className} key={entity.id} style={transition.style} />;
              }
              const selected = selectedIds.has(entity.id);
              const locked = readOnly
                || (entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId)));
              const localDelta = entityDragDelta(dragPreview, entity.id);
              const position = { x: entity.position.x + localDelta.x, y: entity.position.y + localDelta.y };
              const opacity = draftTransactionId === entity.transactionId && entity.opacity === 0 ? 0.35 : entity.opacity;
              return (
                <button
                  aria-label={`Move ${entityLabel(entity)}`}
                  aria-pressed={selected}
                  className={cn(
                    "absolute -translate-x-1/2 -translate-y-1/2 border px-3 py-2 outline-none",
                    locked ? "pointer-events-none border-dashed border-sky-800 bg-zinc-950/70" : "cursor-grab active:cursor-grabbing",
                    selected ? "z-20 border-sky-400 bg-sky-950/60 focus-visible:ring-2 focus-visible:ring-sky-400" : "z-10 border-transparent hover:border-zinc-600",
                  )}
                  data-studio-entity={entity.id}
                  disabled={locked}
                  key={entity.id}
                  onKeyDown={(event) => onEntityKeyDown(event, entity.id)}
                  onLostPointerCapture={onEntityPointerCancel}
                  onPointerCancel={onEntityPointerCancel}
                  onPointerDown={(event) => onEntityPointerDown(event, entity.id)}
                  onPointerMove={onEntityPointerMove}
                  onPointerUp={onEntityPointerUp}
                  style={{ ...positionStyle(position), opacity, scale: entity.scale, touchAction: "none" }}
                  type="button"
                >
                  <ObjectVisual entity={entity} />
                  {selected ? (
                    <span className="absolute -top-6 left-0 max-w-56 truncate bg-sky-400 px-1.5 py-0.5 text-[10px] font-medium text-sky-950">
                      {entityLabel(entity)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {boundaryActive && incomingSceneName ? (
            <div className="absolute bottom-2 left-2 z-30 border border-zinc-700 bg-zinc-950/90 px-2 py-1 text-[10px] text-zinc-300">
              Incoming Scene · {incomingSceneName}
            </div>
          ) : null}
        </div>
      </div>

      <Timeline
        anchors={anchors}
        appliedTransactionIds={appliedTransactionIds}
        currentTime={currentTime}
        duration={duration}
        events={projection.timeline.events}
        interactionMode={interactionMode}
        isPlaying={isPlaying}
        lifetimeTrimDisabled={lifetimeTrimDisabled}
        motionDuration={motionDuration}
        objectTracks={projection.timeline.objectTracks}
        onInteractionModeChange={onInteractionModeChange}
        onLifetimeEndChange={onLifetimeEndChange}
        onMotionDurationChange={onMotionDurationChange}
        onSelectEntity={onSelectEntity}
        onTimeChange={onTimeChange}
        onTogglePlayback={onTogglePlayback}
        readOnly={readOnly ?? false}
        selectedIds={selectedIds}
      />
    </section>
  );
}
