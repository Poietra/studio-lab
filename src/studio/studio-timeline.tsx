import { type PointerEvent, useRef, useState } from "react";

import { cn } from "../lib/cn";
import type { Interval, TimelineEvent, TimelineObjectTrack } from "./model";
import { type AppliedMotionClip, type AppliedMotionClipChange, TimelineMotionClip } from "./motion-timeline-clip";
import {
  closestLifetimeAnchor,
  formatTimelineTime,
  lifetimeTrimAnchors,
  type StudioTimelineAnchor,
  timelineIntervalStyle,
  timelinePositionPercent,
  timelineTimeAtClientX,
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
  lifetimeTrimDisabled: boolean;
  motionDuration: number;
  objectTracks: readonly TimelineObjectTrack[];
  onAppliedMotionClipChange: (clip: AppliedMotionClip, change: AppliedMotionClipChange) => void;
  onAppliedMotionClipSelect: (clip: AppliedMotionClip) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onLifetimeEndChange: (entityId: string, lifetimeStart: number, sourceAnchor: number) => void;
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
  const displayedInterval = previewAnchor ? { ...interval, end: previewAnchor.workingTime } : interval;

  function anchorAtPointer(event: PointerEvent<HTMLButtonElement>) {
    const lane = event.currentTarget.closest<HTMLElement>("[data-timeline-lane]");
    const bounds = lane?.getBoundingClientRect();
    if (!bounds?.width) return null;
    return closestLifetimeAnchor(eligibleAnchors, timelineTimeAtClientX(event.clientX, bounds, duration));
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
    <div className="absolute inset-y-1" style={timelineIntervalStyle(displayedInterval, duration)}>
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
  lifetimeTrimDisabled,
  motionDuration,
  objectTracks,
  onAppliedMotionClipChange,
  onAppliedMotionClipSelect,
  onInteractionModeChange,
  onLifetimeEndChange,
  onMotionDurationChange,
  onSelectEntity,
  onTimeChange,
  onTogglePlayback,
  readOnly,
  selectedIds,
}: StudioTimelineProps) {
  const intervalEvents = events.flatMap((event) => (event.interval ? [{ event, interval: event.interval }] : []));
  const [selectedLifetime, setSelectedLifetime] = useState<SelectedLifetime | null>(null);
  const selectedLifetimeTrack =
    selectedLifetime && selectedIds.has(selectedLifetime.entityId)
      ? objectTracks.find((track) => track.entityId === selectedLifetime.entityId)
      : null;
  const selectedLifetimeInterval =
    selectedLifetimeTrack && selectedLifetime ? selectedLifetimeTrack.lifetimes[selectedLifetime.index] : null;
  const selectedLifetimeAnchors = selectedLifetimeInterval
    ? lifetimeTrimAnchors(anchors, selectedLifetimeInterval)
    : [];
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
        <form
          className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]"
          onSubmit={(event) => {
            event.preventDefault();
            const sourceAnchor = Number(new FormData(event.currentTarget).get("lifetime-source-anchor"));
            if (!Number.isFinite(sourceAnchor)) return;
            onLifetimeEndChange(selectedLifetimeTrack.entityId, selectedLifetimeInterval.start, sourceAnchor);
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
                        onTrim={(sourceAnchor) => onLifetimeEndChange(track.entityId, interval.start, sourceAnchor)}
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
