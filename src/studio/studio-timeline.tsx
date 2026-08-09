import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

import { cn } from "../lib/cn";
import {
  lifetimeControlKey,
  type LifetimeEditControls as StudioLifetimeControls,
  type LifetimeEditTarget as StudioLifetimeTarget,
} from "./lifetime-editing";
import type { Interval, TimelineEvent, TimelineObjectTrack } from "./model";
import { type AppliedMotionClip, type AppliedMotionClipChange, TimelineMotionClip } from "./motion-timeline-clip";
import { markStudioRenderBoundary } from "./studio-render-profiler";
import {
  formatTimelineTime,
  type StudioTimelineAnchor,
  timelineIntervalStyle,
  timelinePositionPercent,
} from "./studio-timeline-geometry";
import type { InteractionMode } from "./studio-viewport-geometry";

export type StudioTimelineProps = Readonly<{
  anchors: readonly StudioTimelineAnchor[];
  appliedMotionClips: readonly AppliedMotionClip[];
  appliedTransactionIds: ReadonlySet<string>;
  currentTime: number;
  duration: number;
  editingAppliedTransactionId: string | null;
  events: readonly TimelineEvent[];
  interactionMode: InteractionMode;
  isPlaying: boolean;
  lifetimeControls: Readonly<Record<string, StudioLifetimeControls>>;
  lifetimeEditMessage: string | null;
  lifetimeTrimDisabled: boolean;
  motionDuration: number;
  objectTracks: readonly TimelineObjectTrack[];
  onAppliedMotionClipChange: (clip: AppliedMotionClip, change: AppliedMotionClipChange) => void;
  onAppliedMotionClipSelect: (clip: AppliedMotionClip) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onLifetimeChange: (entityId: string, lifetimeStart: number, target: Interval) => void;
  onMotionDurationChange: (duration: number) => void;
  onSelectEntity: (entityId: string) => void;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  readOnly: boolean;
  selectedIds: ReadonlySet<string>;
}>;

function TimelinePlayhead({
  currentTime,
  duration,
  showHandle = false,
}: Readonly<{ currentTime: number; duration: number; showHandle?: boolean }>) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-sky-400"
      data-timeline-playhead
      style={{ left: `${timelinePositionPercent(currentTime, duration)}%` }}
    >
      {showHandle ? (
        <span className="absolute left-1/2 top-1 size-2 -translate-x-1/2 border border-sky-200 bg-sky-500" />
      ) : null}
    </div>
  );
}

type SelectedLifetime = Readonly<{
  entityId: string;
  index: number;
}>;

const EMPTY_LIFETIME_CONTROLS: StudioLifetimeControls = {
  endTargets: [],
  moveTargets: [],
  reason: null,
  startTargets: [],
};

type LifetimeDragKind = "end" | "move" | "start";

function targetEdge(target: StudioLifetimeTarget, kind: LifetimeDragKind) {
  return kind === "end" ? target.working.end : target.working.start;
}

function closestLifetimeTarget(targets: readonly StudioLifetimeTarget[], desired: number, kind: LifetimeDragKind) {
  return targets.reduce<StudioLifetimeTarget | null>(
    (closest, target) =>
      !closest || Math.abs(targetEdge(target, kind) - desired) < Math.abs(targetEdge(closest, kind) - desired)
        ? target
        : closest,
    null,
  );
}

function adjacentLifetimeTarget(
  targets: readonly StudioLifetimeTarget[],
  current: number,
  direction: -1 | 1,
  kind: LifetimeDragKind,
) {
  const ordered = [...targets].sort((left, right) => targetEdge(left, kind) - targetEdge(right, kind));
  return direction < 0
    ? (ordered.filter((target) => targetEdge(target, kind) < current - 0.001).at(-1) ?? null)
    : (ordered.find((target) => targetEdge(target, kind) > current + 0.001) ?? null);
}

function TimelineLifetime({
  controls,
  disabled,
  duration,
  interval,
  label,
  onChange,
  onSelect,
  provisional,
  selectDisabled,
  selected,
}: Readonly<{
  controls: StudioLifetimeControls;
  disabled: boolean;
  duration: number;
  interval: Interval;
  label: string;
  onChange: (target: Interval) => void;
  onSelect: () => void;
  provisional: boolean;
  selectDisabled: boolean;
  selected: boolean;
}>) {
  const [previewTarget, setPreviewTarget] = useState<StudioLifetimeTarget | null>(null);
  const lifetimeDrag = useRef<Readonly<{
    kind: LifetimeDragKind;
    pointerId: number;
    startX: number;
  }> | null>(null);
  const displayedInterval = previewTarget?.working ?? interval;

  function targetsFor(kind: LifetimeDragKind) {
    if (kind === "start") return controls.startTargets;
    if (kind === "end") return controls.endTargets;
    return controls.moveTargets;
  }

  function targetAtPointer(event: PointerEvent<HTMLButtonElement>, kind: LifetimeDragKind) {
    const lane = event.currentTarget.closest<HTMLElement>("[data-timeline-lane]");
    const bounds = lane?.getBoundingClientRect();
    if (!bounds?.width) return null;
    const pointerTime = Math.min(duration, Math.max(0, ((event.clientX - bounds.left) / bounds.width) * duration));
    const desired =
      kind === "move"
        ? interval.start + ((event.clientX - lifetimeDrag.current!.startX) / bounds.width) * duration
        : pointerTime;
    return closestLifetimeTarget(targetsFor(kind), desired, kind);
  }

  function startEdit(kind: LifetimeDragKind, event: PointerEvent<HTMLButtonElement>) {
    if (disabled || targetsFor(kind).length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    event.currentTarget.setPointerCapture(event.pointerId);
    lifetimeDrag.current = { kind, pointerId: event.pointerId, startX: event.clientX };
    setPreviewTarget(null);
  }

  function previewEdit(event: PointerEvent<HTMLButtonElement>) {
    const drag = lifetimeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId || Math.abs(event.clientX - drag.startX) < 3) return;
    setPreviewTarget(targetAtPointer(event, drag.kind));
  }

  function finishEdit(event: PointerEvent<HTMLButtonElement>) {
    const drag = lifetimeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = targetAtPointer(event, drag.kind) ?? previewTarget;
    lifetimeDrag.current = null;
    setPreviewTarget(null);
    if (target && Math.abs(event.clientX - drag.startX) >= 3) onChange(target.source);
  }

  function cancelEdit() {
    lifetimeDrag.current = null;
    setPreviewTarget(null);
  }

  function editWithKeyboard(kind: LifetimeDragKind, event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    const current = kind === "end" ? interval.end : interval.start;
    const target = adjacentLifetimeTarget(targetsFor(kind), current, event.key === "ArrowLeft" ? -1 : 1, kind);
    if (target) onChange(target.source);
  }

  return (
    <div className="absolute inset-y-1" style={timelineIntervalStyle(displayedInterval, duration)}>
      <button
        aria-label={`Select ${label} lifetime from ${interval.start.toFixed(2)} to ${interval.end.toFixed(2)} seconds`}
        aria-pressed={selected}
        className={cn(
          "absolute inset-0 size-full border text-left",
          provisional ? "border-dashed border-sky-700 bg-sky-950" : "border-zinc-600 bg-zinc-800",
          selected && "border-sky-400 bg-sky-950",
          selectDisabled && "cursor-not-allowed",
          selected && !disabled && controls.moveTargets.length > 0 && "cursor-grab active:cursor-grabbing",
        )}
        data-timeline-lifetime
        disabled={selectDisabled}
        onClick={onSelect}
        onKeyDown={(event) => editWithKeyboard("move", event)}
        onLostPointerCapture={cancelEdit}
        onPointerCancel={cancelEdit}
        onPointerDown={(event) => startEdit("move", event)}
        onPointerMove={previewEdit}
        onPointerUp={finishEdit}
        style={{ touchAction: "none" }}
        title={`Present ${interval.start.toFixed(2)}–${interval.end.toFixed(2)}s`}
        type="button"
      />
      {selected && !disabled && !selectDisabled && controls.startTargets.length > 0 ? (
        <button
          aria-label={`Adjust ${label} lifetime start`}
          className="absolute -left-1 top-1/2 z-30 size-3 -translate-y-1/2 cursor-ew-resize border border-sky-200 bg-sky-500"
          data-lifetime-handle="start"
          onKeyDown={(event) => editWithKeyboard("start", event)}
          onLostPointerCapture={cancelEdit}
          onPointerCancel={cancelEdit}
          onPointerDown={(event) => startEdit("start", event)}
          onPointerMove={previewEdit}
          onPointerUp={finishEdit}
          style={{ touchAction: "none" }}
          title="Drag or use Left/Right Arrow. The start snaps to a safe source anchor."
          type="button"
        />
      ) : null}
      {selected && !disabled && !selectDisabled && controls.endTargets.length > 0 ? (
        <button
          aria-label={`Trim ${label} lifetime end`}
          className="absolute -right-1 top-1/2 z-30 size-3 -translate-y-1/2 cursor-ew-resize border border-sky-200 bg-sky-500"
          data-lifetime-handle="end"
          data-lifetime-trim-handle
          onKeyDown={(event) => editWithKeyboard("end", event)}
          onLostPointerCapture={cancelEdit}
          onPointerCancel={cancelEdit}
          onPointerDown={(event) => startEdit("end", event)}
          onPointerMove={previewEdit}
          onPointerUp={finishEdit}
          style={{ touchAction: "none" }}
          title="Drag or use Left/Right Arrow. The end snaps to a safe source anchor or restores its source limit."
          type="button"
        />
      ) : null}
    </div>
  );
}

function LifetimeTargetForm({
  controls,
  disabled,
  edge,
  interval,
  onChange,
  track,
}: Readonly<{
  controls: StudioLifetimeControls;
  disabled: boolean;
  edge: "end" | "start";
  interval: Interval;
  onChange: (entityId: string, lifetimeStart: number, target: Interval) => void;
  track: TimelineObjectTrack;
}>) {
  const targets = edge === "start" ? controls.startTargets : controls.endTargets;
  if (targets.length === 0) return null;
  const label = edge === "start" ? "Start" : "End";
  const name = `lifetime-${edge}-target`;
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        const value = Number(new FormData(event.currentTarget).get(name));
        const target = targets.find((candidate) => Math.abs(candidate.source[edge] - value) < 0.001);
        if (target) onChange(track.entityId, interval.start, target.source);
      }}
    >
      <span className="text-zinc-600">{label}</span>
      <select
        aria-label={`Lifetime ${edge} for ${track.label}`}
        className="h-7 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600"
        defaultValue={targets.at(-1)?.source[edge]}
        disabled={disabled}
        key={`${edge}/${track.entityId}/${interval.start}/${interval.end}`}
        name={name}
      >
        {targets.map((target) => (
          <option key={`${target.source.start}/${target.source.end}`} value={target.source[edge]}>
            {target.working[edge].toFixed(2)} s
          </option>
        ))}
      </select>
      <button
        className="h-7 border border-zinc-700 px-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
        disabled={disabled}
        type="submit"
      >
        Set
      </button>
    </form>
  );
}

export function StudioTimeline({
  anchors,
  appliedMotionClips,
  appliedTransactionIds,
  currentTime,
  duration,
  editingAppliedTransactionId,
  events,
  interactionMode,
  isPlaying,
  lifetimeControls,
  lifetimeEditMessage,
  lifetimeTrimDisabled,
  motionDuration,
  objectTracks,
  onAppliedMotionClipChange,
  onAppliedMotionClipSelect,
  onInteractionModeChange,
  onLifetimeChange,
  onMotionDurationChange,
  onSelectEntity,
  onTimeChange,
  onTogglePlayback,
  readOnly,
  selectedIds,
}: StudioTimelineProps) {
  markStudioRenderBoundary("timeline");
  const intervalEvents = events.flatMap((event) => (event.interval ? [{ event, interval: event.interval }] : []));
  const [selectedLifetime, setSelectedLifetime] = useState<SelectedLifetime | null>(null);
  const selectedLifetimeTrack =
    selectedLifetime && selectedIds.has(selectedLifetime.entityId)
      ? objectTracks.find((track) => track.entityId === selectedLifetime.entityId)
      : null;
  const selectedLifetimeInterval =
    selectedLifetimeTrack && selectedLifetime ? selectedLifetimeTrack.lifetimes[selectedLifetime.index] : null;
  const selectedLifetimeControls = selectedLifetime
    ? (lifetimeControls[lifetimeControlKey(selectedLifetime.entityId, selectedLifetime.index)] ??
      EMPTY_LIFETIME_CONTROLS)
    : EMPTY_LIFETIME_CONTROLS;
  const editingMotionClip = editingAppliedTransactionId
    ? (appliedMotionClips.find((clip) => clip.transactionId === editingAppliedTransactionId) ?? null)
    : null;
  const displayedTimelineAnchors = editingMotionClip?.anchors ?? anchors;
  const motionClipBlockers = [
    ...new Set(appliedMotionClips.flatMap((clip) => (clip.readOnlyReason ? [clip.readOnlyReason] : []))),
  ];
  return (
    <section className="shrink-0 border-t border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center gap-3">
        <button
          className="w-14 border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          onClick={onTogglePlayback}
          type="button"
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <span className="w-24 tabular-nums text-xs text-zinc-400">{formatTimelineTime(currentTime)}</span>
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
        <span className="w-16 text-right tabular-nums text-xs text-zinc-600">{formatTimelineTime(duration)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-zinc-800 pt-2 text-xs">
        <span className="text-zinc-400">When dragging an object</span>
        <div aria-label="Object drag behavior" className="flex border border-zinc-700" role="group">
          {(["position", "animate"] as const).map((mode) => (
            <button
              aria-pressed={interactionMode === mode}
              className={cn(
                "px-2.5 py-1 text-xs",
                interactionMode === mode
                  ? "bg-sky-950 text-sky-300"
                  : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
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
          {interactionMode === "position"
            ? "Updates the layout without adding time."
            : "Adds motion starting at the playhead."}
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
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-40 truncate text-zinc-400" title={selectedLifetimeTrack.label}>
            Lifetime · {selectedLifetimeTrack.label}
          </span>
          <LifetimeTargetForm
            controls={selectedLifetimeControls}
            disabled={lifetimeTrimDisabled}
            edge="start"
            interval={selectedLifetimeInterval}
            onChange={onLifetimeChange}
            track={selectedLifetimeTrack}
          />
          <LifetimeTargetForm
            controls={selectedLifetimeControls}
            disabled={lifetimeTrimDisabled}
            edge="end"
            interval={selectedLifetimeInterval}
            onChange={onLifetimeChange}
            track={selectedLifetimeTrack}
          />
          {selectedLifetimeControls.startTargets.length > 0 ||
          selectedLifetimeControls.endTargets.length > 0 ||
          selectedLifetimeControls.moveTargets.length > 0 ? (
            <span className="text-pretty text-zinc-600">
              {selectedLifetimeControls.moveTargets.length > 0
                ? "Edges and interval drag snap to safe .py source anchors. Arrow keys work on the focused handle or interval."
                : "The editable end snaps to a safe .py source anchor or restores its source limit."}
            </span>
          ) : null}
          {selectedLifetimeControls.reason ? (
            <span className="text-pretty text-amber-500">{selectedLifetimeControls.reason}</span>
          ) : null}
          {lifetimeTrimDisabled ? (
            <span className="text-pretty text-zinc-600">Apply or discard the current draft first.</span>
          ) : null}
          {lifetimeEditMessage ? (
            <span className="text-pretty text-red-300" role="alert">
              {lifetimeEditMessage}
            </span>
          ) : null}
        </div>
      ) : null}
      {editingMotionClip ? (
        <p className="mt-2 border-t border-zinc-800 pt-2 text-pretty text-[10px] leading-4 text-zinc-500" role="status">
          Editing {editingMotionClip.label} motion. The body and left edge snap to safe amber source anchors; the right
          edge changes duration.
        </p>
      ) : motionClipBlockers.length > 0 ? (
        <p
          className="mt-2 border-t border-zinc-800 pt-2 text-pretty text-[10px] leading-4 text-amber-500"
          data-motion-clip-blocker
        >
          Motion clip editing is unavailable: {motionClipBlockers.join(" ")}
        </p>
      ) : null}
      <div
        aria-label="Scene object timeline"
        className="mt-3 max-h-56 overflow-y-auto border border-zinc-800 bg-zinc-900"
        role="group"
      >
        <div className="relative">
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] border-b border-zinc-800 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <div className="flex min-w-0 items-center px-2 text-[10px] font-medium text-zinc-400">Time</div>
            <div className="relative h-6 min-w-0 overflow-hidden" data-timeline-ruler>
              <input
                aria-label="Timeline playhead"
                aria-valuetext={`${currentTime.toFixed(2)} seconds of ${duration.toFixed(2)} seconds`}
                className="timeline-scrubber relative z-10 m-0 h-full w-full min-w-0"
                max={duration}
                min="0"
                onChange={(event) => onTimeChange(Number(event.currentTarget.value))}
                step="0.01"
                type="range"
                value={currentTime}
              />
              <TimelinePlayhead currentTime={currentTime} duration={duration} showHandle />
            </div>
          </div>
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] border-b border-zinc-800 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <div className="flex min-w-0 items-center px-2 text-[10px] font-medium text-zinc-400">Scene</div>
            <div className="relative h-8 min-w-0 overflow-hidden">
              {intervalEvents.map(({ event, interval }) => (
                <div
                  className={cn(
                    "absolute top-1 h-5 min-w-px border px-1 text-[9px] leading-4",
                    event.transactionId
                      ? "border-sky-800 bg-sky-950 text-sky-300"
                      : "border-zinc-700 bg-zinc-800 text-zinc-500",
                  )}
                  key={event.id}
                  style={timelineIntervalStyle(interval, duration)}
                  title={`${event.label} ${interval.start.toFixed(2)}–${interval.end.toFixed(2)}s`}
                >
                  <span className="block truncate">{event.label}</span>
                </div>
              ))}
              {displayedTimelineAnchors.map((anchor) => (
                <button
                  aria-label={`Move playhead to source anchor ${anchor.sourceTime.toFixed(3)} seconds`}
                  className="absolute bottom-0 top-0 z-30 w-px bg-amber-500/70 focus-visible:w-0.5"
                  key={anchor.sourceTime}
                  onClick={() => onTimeChange(anchor.workingTime)}
                  style={{ left: `${timelinePositionPercent(anchor.workingTime, duration)}%` }}
                  title={`Source anchor ${anchor.sourceTime.toFixed(3)}s · working time ${anchor.workingTime.toFixed(3)}s`}
                  type="button"
                />
              ))}
              <TimelinePlayhead currentTime={currentTime} duration={duration} />
            </div>
          </div>
          {objectTracks.map((track) => {
            const selected = selectedIds.has(track.entityId);
            const trackMotionClips = appliedMotionClips.filter((clip) => clip.entityId === track.entityId);
            const trackMotionOperationIds = new Set(trackMotionClips.map((clip) => clip.operationId));
            const locked =
              readOnly ||
              (track.provisional && !(track.transactionId && appliedTransactionIds.has(track.transactionId)));
            return (
              <div
                className="grid grid-cols-[6rem_minmax(0,1fr)] border-b border-zinc-800 last:border-b-0 sm:grid-cols-[8rem_minmax(0,1fr)]"
                data-timeline-track={track.entityId}
                key={track.entityId}
              >
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
                    const lifetimeSelected =
                      selected && selectedLifetime?.entityId === track.entityId && selectedLifetime.index === index;
                    return (
                      <TimelineLifetime
                        controls={
                          lifetimeControls[lifetimeControlKey(track.entityId, index)] ?? EMPTY_LIFETIME_CONTROLS
                        }
                        disabled={locked || lifetimeTrimDisabled}
                        duration={duration}
                        interval={interval}
                        key={`${track.entityId}/lifetime/${index}`}
                        label={track.label}
                        onSelect={() => {
                          onSelectEntity(track.entityId);
                          setSelectedLifetime({ entityId: track.entityId, index });
                        }}
                        onChange={(target) => onLifetimeChange(track.entityId, interval.start, target)}
                        provisional={track.provisional}
                        selectDisabled={locked}
                        selected={lifetimeSelected}
                      />
                    );
                  })}
                  {track.animatedChannels.map((channel, index) =>
                    channel.operationId && trackMotionOperationIds.has(channel.operationId) ? null : (
                      <div
                        className="absolute bottom-1 z-10 h-1.5 min-w-px bg-sky-400"
                        data-timeline-animation
                        key={`${track.entityId}/${channel.key}/${index}`}
                        style={timelineIntervalStyle(channel.interval, duration)}
                        title={`${channel.key} animation ${channel.interval.start.toFixed(2)}–${channel.interval.end.toFixed(2)}s`}
                      />
                    ),
                  )}
                  {trackMotionClips.map((clip) => (
                    <TimelineMotionClip
                      clip={clip}
                      duration={duration}
                      editing={editingAppliedTransactionId === clip.transactionId}
                      key={`${clip.operationId}/${clip.entityId}`}
                      onChange={(change) => onAppliedMotionClipChange(clip, change)}
                      onSelect={() => onAppliedMotionClipSelect(clip)}
                    />
                  ))}
                  {track.lifetimes.length === 0 ? (
                    <span className="absolute inset-0 flex items-center px-2 text-[9px] text-zinc-700">
                      Not present
                    </span>
                  ) : null}
                  <TimelinePlayhead currentTime={currentTime} duration={duration} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
