import type { KeyboardEvent, PointerEvent } from "react";

import { cn } from "../lib/cn";
import type {
  Interval,
  ProjectedEntity,
  ProposedStateProjection,
  TimelineEvent,
  TimelineObjectTrack,
} from "./model";
import { EquationContent } from "./prototype-rendering";
import { isTransitionOverlay } from "./workspace-projection";

export const STUDIO_VIEWPORT = { height: 360, width: 640 } as const;

export type InteractionMode = "animate" | "position";
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
  if (entity.type === "Arrow" || entity.type === "Line") {
    return <span aria-hidden="true" className="block h-px w-20 bg-zinc-400" />;
  }
  if (entity.type === "Rectangle" || entity.type === "SurroundingRectangle" || entity.type === "Square") {
    return <span aria-hidden="true" className="block h-14 w-32 border border-zinc-500" />;
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

function TimelinePlayhead({ currentTime, duration }: Readonly<{ currentTime: number; duration: number }>) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-sky-400"
      style={{ left: `${(currentTime / duration) * 100}%` }}
    />
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
  objectTracks,
  onInteractionModeChange,
  onSelectEntity,
  onTimeChange,
  onTogglePlayback,
  readOnly,
  selectedIds,
}: Readonly<{
  anchors: readonly number[];
  appliedTransactionIds: ReadonlySet<string>;
  currentTime: number;
  duration: number;
  events: readonly TimelineEvent[];
  interactionMode: InteractionMode;
  isPlaying: boolean;
  objectTracks: readonly TimelineObjectTrack[];
  onInteractionModeChange: (mode: InteractionMode) => void;
  onSelectEntity: (entityId: string) => void;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  readOnly: boolean;
  selectedIds: ReadonlySet<string>;
}>) {
  const intervalEvents = events.flatMap((event) => event.interval ? [{ event, interval: event.interval }] : []);
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
      </div>
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
                aria-label={`Move playhead to source anchor ${anchor.toFixed(3)} seconds`}
                className="absolute bottom-0 top-0 z-10 w-px bg-amber-500/70 focus-visible:w-0.5"
                key={anchor}
                onClick={() => onTimeChange(anchor)}
                style={{ left: `${(anchor / duration) * 100}%` }}
                title={`Source anchor ${anchor.toFixed(3)}s`}
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
              <div className="relative h-7 min-w-0 overflow-hidden">
                {track.lifetimes.map((interval, index) => (
                  <div
                    className={cn(
                      "absolute inset-y-1 border",
                      track.provisional ? "border-dashed border-sky-700 bg-sky-950" : "border-zinc-600 bg-zinc-800",
                    )}
                    key={`${track.entityId}/lifetime/${index}`}
                    style={intervalStyle(interval, duration)}
                    title={`Present ${interval.start.toFixed(2)}–${interval.end.toFixed(2)}s`}
                  />
                ))}
                {track.animatedChannels.map((channel, index) => (
                  <div
                    className="absolute bottom-1 z-10 h-1.5 min-w-px bg-sky-400"
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
  entities,
  incomingSceneName,
  interactionMode,
  isPlaying,
  onEntityKeyDown,
  onEntityPointerCancel,
  onEntityPointerDown,
  onEntityPointerMove,
  onEntityPointerUp,
  onInteractionModeChange,
  onSelectEntity,
  onTimeChange,
  onTogglePlayback,
  projection,
  readOnly,
  selectedIds,
}: Readonly<{
  anchors: readonly number[];
  appliedTransactionIds: ReadonlySet<string>;
  boundaryActive: boolean;
  className?: string;
  currentTime: number;
  draftTransactionId: string | null;
  dragPreview: EntityDragPreview | null;
  duration: number;
  entities: readonly ProjectedEntity[];
  incomingSceneName: string | null;
  interactionMode: InteractionMode;
  isPlaying: boolean;
  onEntityKeyDown: (event: KeyboardEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityPointerDown: (event: PointerEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onSelectEntity: (entityId: string) => void;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  projection: ProposedStateProjection;
  readOnly?: boolean;
  selectedIds: ReadonlySet<string>;
}>) {
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col bg-zinc-900", className)}>
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4">
        <div
          className="relative aspect-video w-full max-w-5xl overflow-hidden border border-zinc-700 bg-black"
          data-proposed-state-sample={projection.canvas.sampleId}
          data-scene-phase={boundaryActive ? "incoming" : "outgoing"}
        >
          <div className="absolute inset-0 origin-center" style={{ scale: projection.camera.scale }}>
            <svg aria-hidden="true" className="absolute inset-0 size-full opacity-10" viewBox="0 0 640 360">
              <g stroke="#a1a1aa" strokeWidth="1">
                {[80, 160, 240, 320, 400, 480, 560].map((x) => <line key={`x-${x}`} x1={x} x2={x} y1="0" y2="360" />)}
                {[90, 180, 270].map((y) => <line key={`y-${y}`} x1="0" x2="640" y1={y} y2={y} />)}
              </g>
            </svg>
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
        objectTracks={projection.timeline.objectTracks}
        onInteractionModeChange={onInteractionModeChange}
        onSelectEntity={onSelectEntity}
        onTimeChange={onTimeChange}
        onTogglePlayback={onTogglePlayback}
        readOnly={readOnly ?? false}
        selectedIds={selectedIds}
      />
    </section>
  );
}
