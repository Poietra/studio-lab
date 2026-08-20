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
  materialParameterOptions: readonly StudioMaterialParameterTimelineOption[];
  materialParameterTracks: readonly StudioMaterialParameterTimelineTrack[];
  objectTracks: readonly TimelineObjectTrack[];
  opacityTrackEligibleIds: ReadonlySet<string>;
  opacityTracks: readonly StudioOpacityTimelineTrack[];
  onAppliedMotionClipChange: (clip: AppliedMotionClip, change: AppliedMotionClipChange) => void;
  onAppliedMotionClipSelect: (clip: AppliedMotionClip) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onLifetimeChange: (entityId: string, lifetimeStart: number, target: Interval) => void;
  onMotionDurationChange: (duration: number) => void;
  onMaterialParameterKeyframeAdd: (entityId: string, name: string) => void;
  onMaterialParameterKeyframeChange: (
    track: StudioMaterialParameterTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioMaterialParameterTimelineKeyframe, "easing" | "time" | "value">>,
  ) => void;
  onMaterialParameterKeyframeDelete: (track: StudioMaterialParameterTimelineTrack, index: number) => void;
  onOpacityKeyframeAdd: (entityId: string) => void;
  onOpacityKeyframeChange: (
    track: StudioOpacityTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioOpacityTimelineKeyframe, "easing" | "time" | "value">>,
  ) => void;
  onOpacityKeyframeDelete: (track: StudioOpacityTimelineTrack, index: number) => void;
  onSelectEntity: (entityId: string) => void;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  readOnly: boolean;
  selectedIds: ReadonlySet<string>;
}>;

export type StudioOpacityTimelineKeyframe = Readonly<{
  easing: "linear" | "smooth";
  sourceTime: number;
  time: number;
  value: number;
}>;

export type StudioOpacityTimelineTrack = Readonly<{
  entityId: string;
  keyframes: readonly StudioOpacityTimelineKeyframe[];
  label: string;
  programIndex: number;
  readOnlyReason: string | null;
  transactionId: string;
}>;

export type StudioMaterialParameterTimelineKeyframe = StudioOpacityTimelineKeyframe;

export type StudioMaterialParameterTimelineTrack = Readonly<{
  assignmentChanged: boolean;
  entityId: string;
  keyframes: readonly StudioMaterialParameterTimelineKeyframe[];
  label: string;
  materialName: string;
  parameterIndex: number;
  parameterName: string;
  programIndex: number;
  range: Readonly<{ max: number; min: number; step: number }>;
  readOnlyReason: string | null;
  transactionId: string;
}>;

export type StudioMaterialParameterTimelineOption = Readonly<{
  entityId: string;
  materialName: string;
  name: string;
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

type SelectedOpacityKeyframe = Readonly<{
  index: number;
  transactionId: string;
}>;

const EMPTY_LIFETIME_CONTROLS: StudioLifetimeControls = {
  endTargets: [],
  moveTargets: [],
  reason: null,
  startTargets: [],
};

function PropertyKeyframeMarker({
  duration,
  index,
  keyframe,
  kind,
  locked,
  onChange,
  onSelect,
  selected,
}: Readonly<{
  duration: number;
  index: number;
  keyframe: StudioOpacityTimelineKeyframe;
  kind: "material" | "opacity";
  locked: boolean;
  onChange: (patch: Partial<Pick<StudioOpacityTimelineKeyframe, "time">>) => void;
  onSelect: () => void;
  selected: boolean;
}>) {
  const drag = useRef<Readonly<{ pointerId: number }> | null>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);

  function pointerTime(event: PointerEvent<HTMLButtonElement>) {
    const lane = event.currentTarget.closest<HTMLElement>("[data-timeline-lane]");
    const bounds = lane?.getBoundingClientRect();
    if (!bounds?.width) return keyframe.time;
    return Math.min(duration, Math.max(0, ((event.clientX - bounds.left) / bounds.width) * duration));
  }

  function cancelDrag() {
    drag.current = null;
    setPreviewTime(null);
  }

  const displayedTime = previewTime ?? keyframe.time;
  return (
    <button
      aria-label={`${kind === "material" ? "Material parameter" : "Opacity"} keyframe ${index + 1} at ${keyframe.time.toFixed(2)} seconds`}
      aria-pressed={selected}
      className={cn(
        "absolute z-40 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border",
        kind === "material" ? "top-1/4" : "top-1/2",
        selected
          ? kind === "material"
            ? "border-fuchsia-100 bg-fuchsia-400"
            : "border-sky-100 bg-sky-400"
          : kind === "material"
            ? "border-fuchsia-300 bg-fuchsia-800"
            : "border-sky-300 bg-sky-700",
        locked ? "cursor-not-allowed opacity-50" : "cursor-ew-resize",
      )}
      data-property-keyframe={kind}
      data-opacity-keyframe={kind === "opacity" ? "" : undefined}
      disabled={locked}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        onChange({ time: Math.min(duration, Math.max(0, keyframe.time + (event.key === "ArrowLeft" ? -0.05 : 0.05))) });
      }}
      onLostPointerCapture={cancelDrag}
      onPointerCancel={cancelDrag}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId };
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        setPreviewTime(pointerTime(event));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const time = pointerTime(event);
        cancelDrag();
        onChange({ time });
      }}
      style={{ left: `${timelinePositionPercent(displayedTime, duration)}%`, touchAction: "none" }}
      title={`${kind === "material" ? "Material" : "Opacity"} ${keyframe.value.toFixed(2)} · ${keyframe.easing}`}
      type="button"
    />
  );
}

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
  materialParameterOptions,
  materialParameterTracks,
  motionDuration,
  objectTracks,
  opacityTrackEligibleIds,
  opacityTracks,
  onAppliedMotionClipChange,
  onAppliedMotionClipSelect,
  onInteractionModeChange,
  onLifetimeChange,
  onMaterialParameterKeyframeAdd,
  onMaterialParameterKeyframeChange,
  onMaterialParameterKeyframeDelete,
  onMotionDurationChange,
  onOpacityKeyframeAdd,
  onOpacityKeyframeChange,
  onOpacityKeyframeDelete,
  onSelectEntity,
  onTimeChange,
  onTogglePlayback,
  readOnly,
  selectedIds,
}: StudioTimelineProps) {
  markStudioRenderBoundary("timeline");
  const intervalEvents = events.flatMap((event) => (event.interval ? [{ event, interval: event.interval }] : []));
  const [selectedLifetime, setSelectedLifetime] = useState<SelectedLifetime | null>(null);
  const [selectedMaterialParameterByEntity, setSelectedMaterialParameterByEntity] = useState<
    Readonly<Record<string, string>>
  >({});
  const [selectedMaterialKeyframe, setSelectedMaterialKeyframe] = useState<SelectedOpacityKeyframe | null>(null);
  const [selectedOpacityKeyframe, setSelectedOpacityKeyframe] = useState<SelectedOpacityKeyframe | null>(null);
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
  const selectedOpacityTrack = selectedOpacityKeyframe
    ? (opacityTracks.find((track) => track.transactionId === selectedOpacityKeyframe.transactionId) ?? null)
    : null;
  const selectedOpacityMarker = selectedOpacityTrack?.keyframes[selectedOpacityKeyframe?.index ?? -1] ?? null;
  const selectedMaterialTrack = selectedMaterialKeyframe
    ? (materialParameterTracks.find((track) => track.transactionId === selectedMaterialKeyframe.transactionId) ?? null)
    : null;
  const selectedMaterialMarker = selectedMaterialTrack?.keyframes[selectedMaterialKeyframe?.index ?? -1] ?? null;
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
      {selectedOpacityTrack && selectedOpacityMarker ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-40 truncate text-zinc-400" title={selectedOpacityTrack.label}>
            Opacity · {selectedOpacityTrack.label}
          </span>
          <label className="flex items-center gap-1 text-zinc-500">
            Time
            <input
              aria-label="Opacity keyframe time"
              className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-sky-500"
              disabled={selectedOpacityTrack.readOnlyReason !== null}
              max={duration}
              min="0"
              onChange={(event) =>
                onOpacityKeyframeChange(selectedOpacityTrack, selectedOpacityKeyframe!.index, {
                  time: Number(event.currentTarget.value),
                })
              }
              step="0.05"
              type="number"
              value={selectedOpacityMarker.time}
            />
            s
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Value
            <input
              aria-label="Opacity keyframe value"
              className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-sky-500"
              disabled={selectedOpacityTrack.readOnlyReason !== null || selectedOpacityKeyframe!.index === 0}
              max="1"
              min="0"
              onChange={(event) =>
                onOpacityKeyframeChange(selectedOpacityTrack, selectedOpacityKeyframe!.index, {
                  value: Number(event.currentTarget.value),
                })
              }
              step="0.05"
              type="number"
              value={selectedOpacityMarker.value}
            />
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label="Opacity segment easing"
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-sky-500"
              disabled={
                selectedOpacityTrack.readOnlyReason !== null ||
                selectedOpacityKeyframe!.index === selectedOpacityTrack.keyframes.length - 1
              }
              onChange={(event) =>
                onOpacityKeyframeChange(selectedOpacityTrack, selectedOpacityKeyframe!.index, {
                  easing: event.currentTarget.value as "linear" | "smooth",
                })
              }
              value={selectedOpacityMarker.easing}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={
              selectedOpacityTrack.readOnlyReason !== null ||
              (selectedOpacityKeyframe!.index === 0 && selectedOpacityTrack.keyframes.length > 1)
            }
            onClick={() => {
              if (selectedOpacityKeyframe!.index === 0 && selectedOpacityTrack.keyframes.length > 1) return;
              onOpacityKeyframeDelete(selectedOpacityTrack, selectedOpacityKeyframe!.index);
              setSelectedOpacityKeyframe(null);
            }}
            type="button"
          >
            Delete keyframe
          </button>
          {selectedOpacityTrack.readOnlyReason ? (
            <span className="text-amber-500">{selectedOpacityTrack.readOnlyReason}</span>
          ) : null}
        </div>
      ) : null}
      {selectedMaterialTrack && selectedMaterialMarker ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-48 truncate text-fuchsia-300" title={selectedMaterialTrack.label}>
            {selectedMaterialTrack.materialName} · {selectedMaterialTrack.parameterName}
          </span>
          <label className="flex items-center gap-1 text-zinc-500">
            Time
            <input
              aria-label="Material parameter keyframe time"
              className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-fuchsia-500"
              disabled={selectedMaterialTrack.readOnlyReason !== null}
              max={duration}
              min="0"
              onChange={(event) =>
                onMaterialParameterKeyframeChange(selectedMaterialTrack, selectedMaterialKeyframe!.index, {
                  time: Number(event.currentTarget.value),
                })
              }
              step="0.05"
              type="number"
              value={selectedMaterialMarker.time}
            />
            s
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Value
            <input
              aria-label="Material parameter keyframe value"
              className="h-7 w-24 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-fuchsia-500"
              disabled={selectedMaterialTrack.readOnlyReason !== null || selectedMaterialKeyframe!.index === 0}
              max={selectedMaterialTrack.range.max}
              min={selectedMaterialTrack.range.min}
              onChange={(event) =>
                onMaterialParameterKeyframeChange(selectedMaterialTrack, selectedMaterialKeyframe!.index, {
                  value: Number(event.currentTarget.value),
                })
              }
              step={selectedMaterialTrack.range.step}
              type="number"
              value={selectedMaterialMarker.value}
            />
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label="Material parameter segment easing"
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-fuchsia-500"
              disabled={
                selectedMaterialTrack.readOnlyReason !== null ||
                selectedMaterialKeyframe!.index === selectedMaterialTrack.keyframes.length - 1
              }
              onChange={(event) =>
                onMaterialParameterKeyframeChange(selectedMaterialTrack, selectedMaterialKeyframe!.index, {
                  easing: event.currentTarget.value as "linear" | "smooth",
                })
              }
              value={selectedMaterialMarker.easing}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={
              (selectedMaterialTrack.readOnlyReason !== null && !selectedMaterialTrack.assignmentChanged) ||
              (!selectedMaterialTrack.assignmentChanged &&
                selectedMaterialKeyframe!.index === 0 &&
                selectedMaterialTrack.keyframes.length > 1)
            }
            onClick={() => {
              if (
                !selectedMaterialTrack.assignmentChanged &&
                selectedMaterialKeyframe!.index === 0 &&
                selectedMaterialTrack.keyframes.length > 1
              )
                return;
              onMaterialParameterKeyframeDelete(selectedMaterialTrack, selectedMaterialKeyframe!.index);
              setSelectedMaterialKeyframe(null);
            }}
            type="button"
          >
            {selectedMaterialTrack.assignmentChanged ? "Remove track" : "Delete keyframe"}
          </button>
          {selectedMaterialTrack.readOnlyReason ? (
            <span className="text-amber-500">{selectedMaterialTrack.readOnlyReason}</span>
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
            const materialTracks = materialParameterTracks.filter((candidate) => candidate.entityId === track.entityId);
            const staleMaterialTrack = materialTracks.find(({ assignmentChanged }) => assignmentChanged) ?? null;
            const materialOptions = materialParameterOptions.filter(
              (candidate) => candidate.entityId === track.entityId,
            );
            const selectedMaterialName =
              selectedMaterialParameterByEntity[track.entityId] ??
              materialTracks[0]?.parameterName ??
              materialOptions[0]?.name ??
              "";
            const opacityTrack = opacityTracks.find((candidate) => candidate.entityId === track.entityId) ?? null;
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
                <div className={cn("flex min-w-0 items-center", selected && "bg-sky-950")}>
                  <button
                    aria-pressed={selected}
                    className={cn(
                      "min-w-0 flex-1 truncate px-2 text-left text-[10px]",
                      locked ? "cursor-not-allowed text-zinc-700" : "hover:bg-zinc-800",
                      selected ? "text-sky-300" : "text-zinc-500",
                    )}
                    disabled={locked}
                    onClick={() => onSelectEntity(track.entityId)}
                    title={`${track.label} · ${track.type}`}
                    type="button"
                  >
                    {track.label}
                  </button>
                  {selected && opacityTrackEligibleIds.has(track.entityId) ? (
                    <button
                      aria-label={`Add opacity keyframe for ${track.label}`}
                      className="mr-1 size-5 shrink-0 text-sm leading-none text-sky-400 hover:bg-sky-900 disabled:cursor-not-allowed disabled:text-zinc-600"
                      disabled={locked || readOnly}
                      onClick={() => onOpacityKeyframeAdd(track.entityId)}
                      title="Add opacity keyframe at the playhead"
                      type="button"
                    >
                      +
                    </button>
                  ) : null}
                  {staleMaterialTrack ? (
                    <button
                      aria-label={`Remove stale material track for ${track.label}`}
                      className="mr-1 h-5 shrink-0 border border-red-900 px-1 text-[9px] text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
                      disabled={locked || readOnly}
                      onClick={() => onMaterialParameterKeyframeDelete(staleMaterialTrack, 0)}
                      title="Remove the material parameter track whose assignment changed"
                      type="button"
                    >
                      Remove track
                    </button>
                  ) : null}
                  {selected && materialOptions.length > 0 ? (
                    <div className="mr-1 flex min-w-0 items-center">
                      <select
                        aria-label={`Material parameter for ${track.label}`}
                        className="h-5 max-w-20 border border-zinc-700 bg-zinc-950 px-1 text-[9px] text-fuchsia-300"
                        onChange={(event) =>
                          setSelectedMaterialParameterByEntity((current) => ({
                            ...current,
                            [track.entityId]: event.currentTarget.value,
                          }))
                        }
                        value={selectedMaterialName}
                      >
                        {materialOptions.map((option) => (
                          <option key={option.name} value={option.name}>
                            {option.name}
                          </option>
                        ))}
                      </select>
                      <button
                        aria-label={`Add ${selectedMaterialName} material keyframe for ${track.label}`}
                        className="size-5 shrink-0 text-sm leading-none text-fuchsia-400 hover:bg-fuchsia-950 disabled:cursor-not-allowed disabled:text-zinc-600"
                        disabled={locked || readOnly || selectedMaterialName === ""}
                        onClick={() => onMaterialParameterKeyframeAdd(track.entityId, selectedMaterialName)}
                        title="Add material parameter keyframe at the playhead"
                        type="button"
                      >
                        +
                      </button>
                    </div>
                  ) : null}
                </div>
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
                  {opacityTrack?.keyframes.map((keyframe, index) => (
                    <PropertyKeyframeMarker
                      duration={duration}
                      index={index}
                      key={`${opacityTrack.transactionId}/${index}`}
                      keyframe={keyframe}
                      kind="opacity"
                      locked={locked || readOnly || opacityTrack.readOnlyReason !== null}
                      onChange={(patch) => onOpacityKeyframeChange(opacityTrack, index, patch)}
                      onSelect={() => {
                        onSelectEntity(track.entityId);
                        setSelectedOpacityKeyframe({ index, transactionId: opacityTrack.transactionId });
                      }}
                      selected={
                        selectedOpacityKeyframe?.transactionId === opacityTrack.transactionId &&
                        selectedOpacityKeyframe.index === index
                      }
                    />
                  ))}
                  {materialTracks.flatMap((materialTrack) =>
                    materialTrack.keyframes.map((keyframe, index) => (
                      <PropertyKeyframeMarker
                        duration={duration}
                        index={index}
                        key={`${materialTrack.transactionId}/${materialTrack.parameterName}/${index}`}
                        keyframe={keyframe}
                        kind="material"
                        locked={locked || readOnly || materialTrack.readOnlyReason !== null}
                        onChange={(patch) => onMaterialParameterKeyframeChange(materialTrack, index, patch)}
                        onSelect={() => {
                          onSelectEntity(track.entityId);
                          setSelectedMaterialParameterByEntity((current) => ({
                            ...current,
                            [track.entityId]: materialTrack.parameterName,
                          }));
                          setSelectedMaterialKeyframe({ index, transactionId: materialTrack.transactionId });
                        }}
                        selected={
                          selectedMaterialKeyframe?.transactionId === materialTrack.transactionId &&
                          selectedMaterialKeyframe.index === index
                        }
                      />
                    )),
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
