import { type KeyboardEvent, type PointerEvent, useRef, useState, useSyncExternalStore } from "react";

import { STUDIO_PROPERTY_KEYFRAME_EASINGS, type StudioPropertyKeyframeEasing } from "../engine/scene-authoring";
import { cn } from "../lib/cn";
import type { CameraClipEasing, CameraView } from "./camera-clip-edit";
import type { DrawInEasing } from "./draw-in-edit";
import { LOCKED_ENTITY_MUTATION_MESSAGE } from "./entity-lock";
import {
  lifetimeControlKey,
  type LifetimeEditControls as StudioLifetimeControls,
  type LifetimeEditTarget as StudioLifetimeTarget,
} from "./lifetime-editing";
import type { MathTexTransformEasing } from "./mathtex-transform-clip-edit";
import type { Interval, MotionEasing, TimelineEvent, TimelineObjectTrack } from "./model";
import { type AppliedMotionClip, type AppliedMotionClipChange, TimelineMotionClip } from "./motion-timeline-clip";
import type { PaintColorKeyframeEasing, PaintColorProperty } from "./paint-color-keyframe-edit";
import type { PathMorphEasing } from "./path-morph-clip-edit";
import {
  type ShapeTransformEasing,
  type ShapeTransformKind,
  shapeTransformKindLabel,
} from "./shape-transform-clip-edit";
import type { StudioPlaybackClock } from "./studio-playback-clock";
import { markStudioRenderBoundary } from "./studio-render-profiler";
import {
  formatTimelineTime,
  type StudioTimelineAnchor,
  timelineIntervalStyle,
  timelinePositionPercent,
} from "./studio-timeline-geometry";
import type { InteractionMode } from "./studio-viewport-geometry";
import type { WriteInEasing } from "./write-in-edit";

export type StudioTimelineProps = Readonly<{
  anchors: readonly StudioTimelineAnchor[];
  appliedMotionClips: readonly AppliedMotionClip[];
  appliedTransactionIds: ReadonlySet<string>;
  currentTime: number;
  playbackClock?: StudioPlaybackClock;
  cameraClips?: readonly StudioCameraTimelineClip[];
  duration: number;
  drawInClips: readonly StudioDrawInTimelineClip[];
  drawInAvailability: ReadonlyMap<string, string | null>;
  editingAppliedTransactionId: string | null;
  events: readonly TimelineEvent[];
  interactionMode: InteractionMode;
  isPlaying: boolean;
  lifetimeControls: Readonly<Record<string, StudioLifetimeControls>>;
  lifetimeEditMessage: string | null;
  lifetimeTrimDisabled: boolean;
  lockedEntityIds?: ReadonlySet<string>;
  motionDuration: number;
  materialParameterOptions: readonly StudioMaterialParameterTimelineOption[];
  materialParameterTracks: readonly StudioMaterialParameterTimelineTrack[];
  mathTexTransformClips?: readonly StudioMathTexTransformTimelineClip[];
  objectTracks: readonly TimelineObjectTrack[];
  opacityTrackEligibleIds: ReadonlySet<string>;
  opacityTracks: readonly StudioOpacityTimelineTrack[];
  paintColorTrackEligibleProperties?: ReadonlyMap<string, PaintColorProperty>;
  paintColorTracks?: readonly StudioPaintColorTimelineTrack[];
  pathMorphClips?: readonly StudioPathMorphTimelineClip[];
  pathMotionUnavailableReason?: string | null;
  rotationTrackEligibleIds: ReadonlySet<string>;
  rotationTracks: readonly StudioRotationTimelineTrack[];
  scaleTrackEligibleIds: ReadonlySet<string>;
  scaleTracks: readonly StudioScaleTimelineTrack[];
  shapeTransformClips?: readonly StudioShapeTransformTimelineClip[];
  writeInClips: readonly StudioWriteInTimelineClip[];
  writeInAvailability: ReadonlyMap<string, string | null>;
  onAppliedMotionClipChange: (clip: AppliedMotionClip, change: AppliedMotionClipChange) => void;
  onAppliedMotionClipDelete?: (clip: AppliedMotionClip) => void;
  onAppliedMotionClipSelect: (clip: AppliedMotionClip) => void;
  onCameraClipChange?: (clip: StudioCameraTimelineClip, change: StudioCameraClipChange) => void;
  onCameraClipDelete?: (clip: StudioCameraTimelineClip) => void;
  onCameraClipSelect?: (clip: StudioCameraTimelineClip) => void;
  onDrawInAdd: (entityId: string) => void;
  onDrawInChange: (clip: StudioDrawInTimelineClip, change: StudioDrawInClipChange) => void;
  onDrawInDelete: (clip: StudioDrawInTimelineClip) => void;
  onDrawInSelect: (clip: StudioDrawInTimelineClip) => void;
  onInteractionModeChange: (mode: InteractionMode) => void;
  onLifetimeChange: (entityId: string, lifetimeStart: number, target: Interval) => void;
  onMotionDurationChange: (duration: number) => void;
  onPathMotionAdd?: (easing: MotionEasing) => void;
  onMaterialParameterKeyframeAdd: (entityId: string, name: string) => void;
  onMaterialParameterKeyframeChange: (
    track: StudioMaterialParameterTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioMaterialParameterTimelineKeyframe, "easing" | "time" | "value">>,
  ) => void;
  onMaterialParameterKeyframeDelete: (track: StudioMaterialParameterTimelineTrack, index: number) => void;
  onMaterialParameterKeyframeDuplicate: (track: StudioMaterialParameterTimelineTrack, index: number) => number | null;
  onMathTexTransformClipChange?: (
    clip: StudioMathTexTransformTimelineClip,
    change: StudioMathTexTransformClipChange,
  ) => void;
  onMathTexTransformClipDelete?: (clip: StudioMathTexTransformTimelineClip) => void;
  onMathTexTransformClipSelect?: (clip: StudioMathTexTransformTimelineClip) => void;
  onOpacityKeyframeAdd: (entityId: string) => void;
  onOpacityKeyframeChange: (
    track: StudioOpacityTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioOpacityTimelineKeyframe, "easing" | "time" | "value">>,
  ) => void;
  onOpacityKeyframeDelete: (track: StudioOpacityTimelineTrack, index: number) => void;
  onOpacityKeyframeDuplicate: (track: StudioOpacityTimelineTrack, index: number) => number | null;
  onPaintColorKeyframeAdd?: (entityId: string) => void;
  onPaintColorKeyframeChange?: (
    track: StudioPaintColorTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioPaintColorTimelineKeyframe, "easing" | "time" | "value">>,
  ) => void;
  onPaintColorKeyframeDelete?: (track: StudioPaintColorTimelineTrack, index: number) => void;
  onPaintColorKeyframeDuplicate?: (track: StudioPaintColorTimelineTrack, index: number) => number | null;
  onPathMorphClipChange?: (clip: StudioPathMorphTimelineClip, change: StudioPathMorphClipChange) => void;
  onPathMorphClipDelete?: (clip: StudioPathMorphTimelineClip) => void;
  onPathMorphClipSelect?: (clip: StudioPathMorphTimelineClip) => void;
  onRotationKeyframeAdd: (entityId: string) => void;
  onRotationKeyframeChange: (
    track: StudioRotationTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioRotationTimelineKeyframe, "easing" | "time" | "value">>,
  ) => void;
  onRotationKeyframeDelete: (track: StudioRotationTimelineTrack, index: number) => void;
  onRotationKeyframeDuplicate: (track: StudioRotationTimelineTrack, index: number) => number | null;
  onScaleKeyframeAdd: (entityId: string) => void;
  onScaleKeyframeChange: (
    track: StudioScaleTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioScaleTimelineKeyframe, "easing" | "time" | "value">>,
  ) => void;
  onScaleKeyframeDelete: (track: StudioScaleTimelineTrack, index: number) => void;
  onScaleKeyframeDuplicate: (track: StudioScaleTimelineTrack, index: number) => number | null;
  onShapeTransformClipChange?: (clip: StudioShapeTransformTimelineClip, change: StudioShapeTransformClipChange) => void;
  onShapeTransformClipDelete?: (clip: StudioShapeTransformTimelineClip) => void;
  onShapeTransformClipSelect?: (clip: StudioShapeTransformTimelineClip) => void;
  onSelectEntity: (entityId: string) => void;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  onWriteInAdd: (entityId: string) => void;
  onWriteInChange: (clip: StudioWriteInTimelineClip, change: StudioWriteInClipChange) => void;
  onWriteInDelete: (clip: StudioWriteInTimelineClip) => void;
  onWriteInSelect: (clip: StudioWriteInTimelineClip) => void;
  readOnly: boolean;
  selectedIds: ReadonlySet<string>;
}>;

export type StudioDrawInTimelineClip = Readonly<{
  easing: DrawInEasing;
  entityId: string;
  interval: Interval;
  label: string;
  maximumDuration: number;
  operationId: string;
  readOnlyReason: string | null;
  transactionId: string;
}>;

export type StudioDrawInClipChange = Readonly<{
  duration?: number;
  easing?: DrawInEasing;
}>;

export type StudioWriteInTimelineClip = Readonly<{
  easing: WriteInEasing;
  entityId: string;
  interval: Interval;
  label: string;
  maximumDuration: number;
  operationId: string;
  readOnlyReason: string | null;
  transactionId: string;
}>;

export type StudioWriteInClipChange = Readonly<{
  duration?: number;
  easing?: WriteInEasing;
}>;

export type StudioMathTexTransformTimelineClip = Readonly<{
  easing: MathTexTransformEasing;
  entityId: string;
  interval: Interval;
  label: string;
  maximumDuration: number;
  operationId: string;
  readOnlyReason: string | null;
  targetLabel: string;
  transactionId: string;
}>;

export type StudioMathTexTransformClipChange = Readonly<{
  duration?: number;
  easing?: MathTexTransformEasing;
}>;

export type StudioShapeTransformTimelineClip = Readonly<{
  easing: ShapeTransformEasing;
  entityId: string;
  interval: Interval;
  label: string;
  maximumDuration: number;
  operationId: string;
  readOnlyReason: string | null;
  targetShape: ShapeTransformKind;
  transactionId: string;
}>;

export type StudioShapeTransformClipChange = Readonly<{
  duration?: number;
  easing?: ShapeTransformEasing;
}>;

export type StudioPathMorphTimelineClip = Readonly<{
  easing: PathMorphEasing;
  entityId: string;
  interval: Interval;
  label: string;
  maximumDuration: number;
  operationId: string;
  readOnlyReason: string | null;
  transactionId: string;
}>;

export type StudioPathMorphClipChange = Readonly<{
  duration?: number;
  easing?: PathMorphEasing;
}>;

export type StudioCameraTimelineClip = Readonly<{
  easing: CameraClipEasing;
  from: CameraView;
  interval: Interval;
  maximumDuration: number;
  operationId: string;
  readOnlyReason: string | null;
  to: CameraView;
  transactionId: string;
}>;

export type StudioCameraClipChange = Readonly<{
  duration?: number;
  easing?: CameraClipEasing;
}>;

function CameraDurationInput({
  clip,
  onCommit,
}: Readonly<{ clip: StudioCameraTimelineClip; onCommit: (duration: number) => void }>) {
  const duration = Math.max(0.1, clip.interval.end - clip.interval.start);
  const [draft, setDraft] = useState(String(duration));
  function commit() {
    const next = Number(draft);
    if (!Number.isFinite(next) || next < 0.1 || next > clip.maximumDuration) {
      setDraft(String(duration));
      return;
    }
    if (Math.abs(next - duration) > 0.0005) onCommit(next);
  }
  return (
    <input
      aria-label="Camera duration"
      className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-sky-500"
      disabled={clip.readOnlyReason !== null}
      max={clip.maximumDuration}
      min="0.1"
      onBlur={commit}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      step="0.1"
      type="number"
      value={draft}
    />
  );
}

function EntranceDurationInput({
  clip,
  kind,
  onCommit,
}: Readonly<{
  clip:
    | StudioDrawInTimelineClip
    | StudioMathTexTransformTimelineClip
    | StudioShapeTransformTimelineClip
    | StudioWriteInTimelineClip;
  kind: "Draw" | "Path Morph" | "Shape Transform" | "Transform" | "Write";
  onCommit: (duration: number) => void;
}>) {
  const duration = Math.max(0.1, clip.interval.end - clip.interval.start);
  const [draft, setDraft] = useState(String(duration));

  function commit() {
    const next = Number(draft);
    if (!Number.isFinite(next) || next < 0.1 || next > clip.maximumDuration) {
      setDraft(String(duration));
      return;
    }
    if (Math.abs(next - duration) > 0.0005) onCommit(next);
  }

  return (
    <input
      aria-label={`${kind} duration for ${clip.label}`}
      className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-violet-500"
      disabled={clip.readOnlyReason !== null}
      max={clip.maximumDuration}
      min="0.1"
      onBlur={commit}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      step="0.1"
      type="number"
      value={draft}
    />
  );
}

export type StudioOpacityTimelineKeyframe = Readonly<{
  easing: StudioPropertyKeyframeEasing;
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

export type StudioPaintColorTimelineKeyframe = Readonly<{
  easing: PaintColorKeyframeEasing;
  sourceTime: number;
  time: number;
  value: string;
}>;

export type StudioPaintColorTimelineTrack = Readonly<{
  entityId: string;
  keyframes: readonly StudioPaintColorTimelineKeyframe[];
  label: string;
  programIndex: number;
  property: PaintColorProperty;
  readOnlyReason: string | null;
  transactionId: string;
}>;

function paintColorPropertyLabel(property: PaintColorProperty) {
  return property === "fillColor" ? "Fill color" : "Stroke color";
}

export type StudioMaterialParameterTimelineKeyframe = StudioOpacityTimelineKeyframe;
export type StudioRotationTimelineKeyframe = StudioOpacityTimelineKeyframe;
export type StudioScaleTimelineKeyframe = StudioOpacityTimelineKeyframe;

const PROPERTY_KEYFRAME_EASING_LABELS: Record<StudioPropertyKeyframeEasing, string> = {
  "ease-in": "Ease in",
  "ease-in-out": "Ease in & out",
  "ease-out": "Ease out",
  linear: "Linear",
  smooth: "Smooth",
};

function PropertyKeyframeEasingOptions() {
  return STUDIO_PROPERTY_KEYFRAME_EASINGS.map((easing) => (
    <option key={easing} value={easing}>
      {PROPERTY_KEYFRAME_EASING_LABELS[easing]}
    </option>
  ));
}

export type StudioRotationTimelineTrack = Readonly<{
  entityId: string;
  keyframes: readonly StudioRotationTimelineKeyframe[];
  label: string;
  programIndex: number;
  readOnlyReason: string | null;
  transactionId: string;
}>;

export type StudioScaleTimelineTrack = Readonly<{
  entityId: string;
  keyframes: readonly StudioScaleTimelineKeyframe[];
  label: string;
  programIndex: number;
  readOnlyReason: string | null;
  transactionId: string;
}>;

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

const STATIC_PLAYBACK_CLOCK_SNAPSHOT = { currentTime: 0, playing: false };

function subscribeToStaticPlaybackClock(_listener: () => void) {
  return () => undefined;
}

function getStaticPlaybackClockSnapshot() {
  return STATIC_PLAYBACK_CLOCK_SNAPSHOT;
}

function useDisplayedTimelineTime(currentTime: number, playbackClock?: StudioPlaybackClock) {
  const snapshot = useSyncExternalStore(
    playbackClock?.subscribe ?? subscribeToStaticPlaybackClock,
    playbackClock?.getSnapshot ?? getStaticPlaybackClockSnapshot,
    playbackClock?.getSnapshot ?? getStaticPlaybackClockSnapshot,
  );
  return snapshot.playing ? snapshot.currentTime : currentTime;
}

function TimelinePlayhead({
  currentTime,
  duration,
  playbackClock,
  showHandle = false,
}: Readonly<{ currentTime: number; duration: number; playbackClock?: StudioPlaybackClock; showHandle?: boolean }>) {
  const displayedTime = useDisplayedTimelineTime(currentTime, playbackClock);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-sky-400"
      data-timeline-playhead
      style={{ left: `${timelinePositionPercent(displayedTime, duration)}%` }}
    >
      {showHandle ? (
        <span className="absolute left-1/2 top-1 size-2 -translate-x-1/2 border border-sky-200 bg-sky-500" />
      ) : null}
    </div>
  );
}

function ScenePlaybackControl({
  currentTime,
  duration,
  isPlaying,
  onTimeChange,
  onTogglePlayback,
  playbackClock,
}: Readonly<{
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onTimeChange: (time: number) => void;
  onTogglePlayback: () => void;
  playbackClock?: StudioPlaybackClock;
}>) {
  const displayedTime = useDisplayedTimelineTime(currentTime, playbackClock);
  return (
    <div className="flex items-center gap-3">
      <button
        className="w-14 border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        onClick={onTogglePlayback}
        type="button"
      >
        {isPlaying ? "Pause" : "Play"}
      </button>
      <span className="w-24 tabular-nums text-xs text-zinc-400">{formatTimelineTime(displayedTime)}</span>
      <input
        aria-label="Scene playhead"
        className="min-w-0 flex-1 accent-sky-500"
        max={duration}
        min="0"
        onChange={(event) => onTimeChange(Number(event.currentTarget.value))}
        step="0.01"
        type="range"
        value={displayedTime}
      />
      <span className="w-16 text-right tabular-nums text-xs text-zinc-600">{formatTimelineTime(duration)}</span>
    </div>
  );
}

function TimelineRulerScrubber({
  currentTime,
  duration,
  onTimeChange,
  playbackClock,
}: Readonly<{
  currentTime: number;
  duration: number;
  onTimeChange: (time: number) => void;
  playbackClock?: StudioPlaybackClock;
}>) {
  const displayedTime = useDisplayedTimelineTime(currentTime, playbackClock);
  return (
    <input
      aria-label="Timeline playhead"
      aria-valuetext={`${displayedTime.toFixed(2)} seconds of ${duration.toFixed(2)} seconds`}
      className="timeline-scrubber relative z-10 m-0 h-full w-full min-w-0"
      max={duration}
      min="0"
      onChange={(event) => onTimeChange(Number(event.currentTarget.value))}
      step="0.01"
      type="range"
      value={displayedTime}
    />
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

function DuplicateKeyframeButton({
  disabledReason,
  onClick,
  propertyLabel,
}: Readonly<{
  disabledReason: string | null;
  onClick: () => void;
  propertyLabel: string;
}>) {
  const label = `Duplicate ${propertyLabel} keyframe at the playhead`;
  return (
    <button
      aria-label={label}
      className="h-7 border border-zinc-700 px-2 text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
      disabled={disabledReason !== null}
      onClick={onClick}
      title={disabledReason ?? label}
      type="button"
    >
      Duplicate at playhead
    </button>
  );
}

function keyframeDuplicateDisabledReason(readOnly: boolean, locked: boolean, trackReason: string | null) {
  if (readOnly) return "Timeline editing is unavailable in read-only mode.";
  if (locked) return LOCKED_ENTITY_MUTATION_MESSAGE;
  return trackReason;
}

function PropertyKeyframeMarker({
  duration,
  index,
  keyframe,
  kind,
  locked,
  onChange,
  onSelect,
  paintProperty,
  selected,
}: Readonly<{
  duration: number;
  index: number;
  keyframe: StudioOpacityTimelineKeyframe | StudioPaintColorTimelineKeyframe;
  kind: "material" | "opacity" | "paint-color" | "rotation" | "scale";
  locked: boolean;
  onChange: (patch: Partial<Pick<StudioOpacityTimelineKeyframe, "time">>) => void;
  onSelect: () => void;
  paintProperty?: PaintColorProperty;
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
  const propertyLabel =
    kind === "material"
      ? "Material parameter"
      : kind === "paint-color"
        ? paintProperty === "strokeColor"
          ? "Stroke color"
          : "Fill color"
        : kind === "rotation"
          ? "Rotation"
          : kind === "scale"
            ? "Scale"
            : "Opacity";
  const displayedValue =
    typeof keyframe.value === "string"
      ? keyframe.value
      : kind === "rotation"
        ? `${keyframe.value.toFixed(1)}°`
        : keyframe.value.toFixed(2);
  return (
    <button
      aria-label={`${propertyLabel} keyframe ${index + 1} at ${keyframe.time.toFixed(2)} seconds`}
      aria-pressed={selected}
      className={cn(
        "absolute z-40 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border",
        kind === "material" || kind === "paint-color"
          ? "top-1/4"
          : kind === "scale" || kind === "rotation"
            ? "top-3/4"
            : "top-1/2",
        selected
          ? kind === "material"
            ? "border-fuchsia-100 bg-fuchsia-400"
            : kind === "paint-color"
              ? "border-white"
              : kind === "rotation"
                ? "border-amber-100 bg-amber-400"
                : kind === "scale"
                  ? "border-emerald-100 bg-emerald-400"
                  : "border-sky-100 bg-sky-400"
          : kind === "material"
            ? "border-fuchsia-300 bg-fuchsia-800"
            : kind === "paint-color"
              ? "border-zinc-300"
              : kind === "rotation"
                ? "border-amber-300 bg-amber-800"
                : kind === "scale"
                  ? "border-emerald-300 bg-emerald-800"
                  : "border-sky-300 bg-sky-700",
        locked ? "cursor-not-allowed opacity-50" : "cursor-ew-resize",
      )}
      data-property-keyframe={kind}
      data-opacity-keyframe={kind === "opacity" ? "" : undefined}
      data-paint-color-keyframe={kind === "paint-color" ? "" : undefined}
      data-rotation-keyframe={kind === "rotation" ? "" : undefined}
      data-scale-keyframe={kind === "scale" ? "" : undefined}
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
        if (Math.abs(time - keyframe.time) > 0.0005) onChange({ time });
      }}
      style={{
        ...(kind === "paint-color" && typeof keyframe.value === "string" ? { backgroundColor: keyframe.value } : {}),
        left: `${timelinePositionPercent(displayedTime, duration)}%`,
        touchAction: "none",
      }}
      title={`${propertyLabel} ${displayedValue} · ${keyframe.easing}`}
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
  cameraClips = [],
  currentTime,
  playbackClock,
  duration,
  drawInClips,
  drawInAvailability,
  editingAppliedTransactionId,
  events,
  interactionMode,
  isPlaying,
  lifetimeControls,
  lifetimeEditMessage,
  lifetimeTrimDisabled,
  lockedEntityIds = new Set(),
  materialParameterOptions,
  materialParameterTracks,
  mathTexTransformClips = [],
  motionDuration,
  objectTracks,
  opacityTrackEligibleIds,
  opacityTracks,
  paintColorTrackEligibleProperties = new Map(),
  paintColorTracks = [],
  pathMorphClips = [],
  pathMotionUnavailableReason = "Select one Studio-created object and one open multi-segment Pen.",
  rotationTrackEligibleIds,
  rotationTracks,
  scaleTrackEligibleIds,
  scaleTracks,
  shapeTransformClips = [],
  writeInClips,
  writeInAvailability,
  onAppliedMotionClipChange,
  onAppliedMotionClipDelete,
  onAppliedMotionClipSelect,
  onCameraClipChange,
  onCameraClipDelete,
  onCameraClipSelect,
  onDrawInAdd,
  onDrawInChange,
  onDrawInDelete,
  onDrawInSelect,
  onInteractionModeChange,
  onLifetimeChange,
  onMaterialParameterKeyframeAdd,
  onMaterialParameterKeyframeChange,
  onMaterialParameterKeyframeDelete,
  onMaterialParameterKeyframeDuplicate,
  onMathTexTransformClipChange,
  onMathTexTransformClipDelete,
  onMathTexTransformClipSelect,
  onMotionDurationChange,
  onPathMotionAdd,
  onOpacityKeyframeAdd,
  onOpacityKeyframeChange,
  onOpacityKeyframeDelete,
  onOpacityKeyframeDuplicate,
  onPaintColorKeyframeAdd,
  onPaintColorKeyframeChange,
  onPaintColorKeyframeDelete,
  onPaintColorKeyframeDuplicate,
  onPathMorphClipChange,
  onPathMorphClipDelete,
  onPathMorphClipSelect,
  onRotationKeyframeAdd,
  onRotationKeyframeChange,
  onRotationKeyframeDelete,
  onRotationKeyframeDuplicate,
  onScaleKeyframeAdd,
  onScaleKeyframeChange,
  onScaleKeyframeDelete,
  onScaleKeyframeDuplicate,
  onShapeTransformClipChange,
  onShapeTransformClipDelete,
  onShapeTransformClipSelect,
  onSelectEntity,
  onTimeChange,
  onTogglePlayback,
  onWriteInAdd,
  onWriteInChange,
  onWriteInDelete,
  onWriteInSelect,
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
  const [selectedPaintColorKeyframe, setSelectedPaintColorKeyframe] = useState<SelectedOpacityKeyframe | null>(null);
  const [selectedRotationKeyframe, setSelectedRotationKeyframe] = useState<SelectedOpacityKeyframe | null>(null);
  const [selectedScaleKeyframe, setSelectedScaleKeyframe] = useState<SelectedOpacityKeyframe | null>(null);
  const [pathMotionEasing, setPathMotionEasing] = useState<MotionEasing>("smooth");
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
  const selectedCameraClip = editingAppliedTransactionId
    ? (cameraClips.find((clip) => clip.transactionId === editingAppliedTransactionId) ?? null)
    : null;
  const editingCameraClip = selectedCameraClip
    ? {
        ...selectedCameraClip,
        readOnlyReason: readOnly
          ? "The timeline is read-only."
          : (selectedCameraClip.readOnlyReason ?? (!onCameraClipChange ? "Camera clip editing is unavailable." : null)),
      }
    : null;
  const selectedDrawInClip = editingAppliedTransactionId
    ? (drawInClips.find((clip) => clip.transactionId === editingAppliedTransactionId) ?? null)
    : null;
  const editingDrawInClip = selectedDrawInClip
    ? {
        ...selectedDrawInClip,
        readOnlyReason: readOnly
          ? "The timeline is read-only."
          : lockedEntityIds.has(selectedDrawInClip.entityId)
            ? LOCKED_ENTITY_MUTATION_MESSAGE
            : selectedDrawInClip.readOnlyReason,
      }
    : null;
  const selectedWriteInClip = editingAppliedTransactionId
    ? (writeInClips.find((clip) => clip.transactionId === editingAppliedTransactionId) ?? null)
    : null;
  const editingWriteInClip = selectedWriteInClip
    ? {
        ...selectedWriteInClip,
        readOnlyReason: readOnly
          ? "The timeline is read-only."
          : lockedEntityIds.has(selectedWriteInClip.entityId)
            ? LOCKED_ENTITY_MUTATION_MESSAGE
            : selectedWriteInClip.readOnlyReason,
      }
    : null;
  const selectedMathTexTransformClip = editingAppliedTransactionId
    ? (mathTexTransformClips.find((clip) => clip.transactionId === editingAppliedTransactionId) ?? null)
    : null;
  const editingMathTexTransformClip = selectedMathTexTransformClip
    ? {
        ...selectedMathTexTransformClip,
        readOnlyReason: readOnly
          ? "The timeline is read-only."
          : lockedEntityIds.has(selectedMathTexTransformClip.entityId)
            ? LOCKED_ENTITY_MUTATION_MESSAGE
            : (selectedMathTexTransformClip.readOnlyReason ??
              (!onMathTexTransformClipChange ? "MathTex Transform clip editing is unavailable." : null)),
      }
    : null;
  const selectedShapeTransformClip = editingAppliedTransactionId
    ? (shapeTransformClips.find((clip) => clip.transactionId === editingAppliedTransactionId) ?? null)
    : null;
  const editingShapeTransformClip = selectedShapeTransformClip
    ? {
        ...selectedShapeTransformClip,
        readOnlyReason: readOnly
          ? "The timeline is read-only."
          : lockedEntityIds.has(selectedShapeTransformClip.entityId)
            ? LOCKED_ENTITY_MUTATION_MESSAGE
            : (selectedShapeTransformClip.readOnlyReason ??
              (!onShapeTransformClipChange ? "Shape Transform clip editing is unavailable." : null)),
      }
    : null;
  const selectedPathMorphClip = editingAppliedTransactionId
    ? (pathMorphClips.find((clip) => clip.transactionId === editingAppliedTransactionId) ?? null)
    : null;
  const editingPathMorphClip = selectedPathMorphClip
    ? {
        ...selectedPathMorphClip,
        readOnlyReason: readOnly
          ? "The timeline is read-only."
          : lockedEntityIds.has(selectedPathMorphClip.entityId)
            ? LOCKED_ENTITY_MUTATION_MESSAGE
            : (selectedPathMorphClip.readOnlyReason ??
              (!onPathMorphClipChange ? "Path Morph clip editing is unavailable." : null)),
      }
    : null;
  const displayedTimelineAnchors = editingMotionClip?.anchors ?? anchors;
  const motionClipBlockers = [
    ...new Set(appliedMotionClips.flatMap((clip) => (clip.readOnlyReason ? [clip.readOnlyReason] : []))),
  ];
  const selectedOpacityTrack = selectedOpacityKeyframe
    ? (opacityTracks.find((track) => track.transactionId === selectedOpacityKeyframe.transactionId) ?? null)
    : null;
  const selectedOpacityMarker = selectedOpacityTrack?.keyframes[selectedOpacityKeyframe?.index ?? -1] ?? null;
  const selectedPaintColorTrack = selectedPaintColorKeyframe
    ? (paintColorTracks.find((track) => track.transactionId === selectedPaintColorKeyframe.transactionId) ?? null)
    : null;
  const selectedPaintColorMarker = selectedPaintColorTrack?.keyframes[selectedPaintColorKeyframe?.index ?? -1] ?? null;
  const selectedMaterialTrack = selectedMaterialKeyframe
    ? (materialParameterTracks.find((track) => track.transactionId === selectedMaterialKeyframe.transactionId) ?? null)
    : null;
  const selectedMaterialMarker = selectedMaterialTrack?.keyframes[selectedMaterialKeyframe?.index ?? -1] ?? null;
  const selectedScaleTrack = selectedScaleKeyframe
    ? (scaleTracks.find((track) => track.transactionId === selectedScaleKeyframe.transactionId) ?? null)
    : null;
  const selectedScaleMarker = selectedScaleTrack?.keyframes[selectedScaleKeyframe?.index ?? -1] ?? null;
  const selectedRotationTrack = selectedRotationKeyframe
    ? (rotationTracks.find((track) => track.transactionId === selectedRotationKeyframe.transactionId) ?? null)
    : null;
  const selectedRotationMarker = selectedRotationTrack?.keyframes[selectedRotationKeyframe?.index ?? -1] ?? null;
  const selectedLifetimeLocked = Boolean(selectedLifetime && lockedEntityIds.has(selectedLifetime.entityId));
  const selectedOpacityLocked = Boolean(selectedOpacityTrack && lockedEntityIds.has(selectedOpacityTrack.entityId));
  const selectedPaintColorLocked = Boolean(
    selectedPaintColorTrack && lockedEntityIds.has(selectedPaintColorTrack.entityId),
  );
  const selectedMaterialLocked = Boolean(selectedMaterialTrack && lockedEntityIds.has(selectedMaterialTrack.entityId));
  const selectedScaleLocked = Boolean(selectedScaleTrack && lockedEntityIds.has(selectedScaleTrack.entityId));
  const selectedRotationLocked = Boolean(selectedRotationTrack && lockedEntityIds.has(selectedRotationTrack.entityId));
  return (
    <section className="shrink-0 border-t border-zinc-800 bg-zinc-950 p-3">
      <ScenePlaybackControl
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        onTimeChange={onTimeChange}
        onTogglePlayback={onTogglePlayback}
        playbackClock={playbackClock}
      />
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
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <label className="flex items-center gap-2 text-[10px] text-zinc-500">
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
            <label className="flex items-center gap-1 text-[10px] text-zinc-500">
              Easing
              <select
                aria-label="Pen motion easing"
                className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-sky-500"
                onChange={(event) => setPathMotionEasing(event.currentTarget.value as MotionEasing)}
                value={pathMotionEasing}
              >
                <option value="smooth">Smooth</option>
                <option value="linear">Linear</option>
              </select>
            </label>
            <button
              className="h-7 border border-sky-800 px-2 text-[10px] font-medium text-sky-300 hover:bg-sky-950 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-700 disabled:hover:bg-transparent"
              disabled={readOnly || pathMotionUnavailableReason !== null || onPathMotionAdd === undefined}
              onClick={() => onPathMotionAdd?.(pathMotionEasing)}
              title={pathMotionUnavailableReason ?? "Use the selected Pen as the selected object's exact motion path"}
              type="button"
            >
              Use Pen as motion path
            </button>
            {pathMotionUnavailableReason ? (
              <span className="basis-full text-right text-[10px] text-amber-500" role="status">
                {pathMotionUnavailableReason}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {editingDrawInClip ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-48 truncate text-violet-300" title={editingDrawInClip.label}>
            Draw · {editingDrawInClip.label}
          </span>
          <div className="flex items-center gap-1 text-zinc-500">
            Duration
            <EntranceDurationInput
              clip={editingDrawInClip}
              kind="Draw"
              key={`${editingDrawInClip.transactionId}/${editingDrawInClip.interval.start}/${editingDrawInClip.interval.end}/${editingDrawInClip.maximumDuration}`}
              onCommit={(duration) => onDrawInChange(editingDrawInClip, { duration })}
            />
            s
          </div>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label={`Draw easing for ${editingDrawInClip.label}`}
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-violet-500"
              disabled={editingDrawInClip.readOnlyReason !== null}
              onChange={(event) =>
                onDrawInChange(editingDrawInClip, { easing: event.currentTarget.value as DrawInEasing })
              }
              value={editingDrawInClip.easing}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={editingDrawInClip.readOnlyReason !== null}
            onClick={() => onDrawInDelete(editingDrawInClip)}
            type="button"
          >
            Remove Draw
          </button>
          {editingDrawInClip.readOnlyReason ? (
            <span className="text-amber-500">{editingDrawInClip.readOnlyReason}</span>
          ) : (
            <span className="text-zinc-600">Apply or discard the Program replacement when finished.</span>
          )}
        </div>
      ) : null}
      {editingWriteInClip ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-48 truncate text-fuchsia-300" title={editingWriteInClip.label}>
            Write · {editingWriteInClip.label}
          </span>
          <div className="flex items-center gap-1 text-zinc-500">
            Duration
            <EntranceDurationInput
              clip={editingWriteInClip}
              key={`${editingWriteInClip.transactionId}/${editingWriteInClip.interval.start}/${editingWriteInClip.interval.end}/${editingWriteInClip.maximumDuration}`}
              kind="Write"
              onCommit={(duration) => onWriteInChange(editingWriteInClip, { duration })}
            />
            s
          </div>
          <span className="text-zinc-500" data-write-in-easing={editingWriteInClip.easing}>
            Easing · Linear
          </span>
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={editingWriteInClip.readOnlyReason !== null}
            onClick={() => onWriteInDelete(editingWriteInClip)}
            type="button"
          >
            Remove Write
          </button>
          {editingWriteInClip.readOnlyReason ? (
            <span className="text-amber-500">{editingWriteInClip.readOnlyReason}</span>
          ) : (
            <span className="text-zinc-600">Apply or discard the Program replacement when finished.</span>
          )}
        </div>
      ) : null}
      {editingMathTexTransformClip ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span
            className="max-w-64 truncate text-teal-300"
            title={`${editingMathTexTransformClip.label} → ${editingMathTexTransformClip.targetLabel}`}
          >
            Transform · {editingMathTexTransformClip.label} → {editingMathTexTransformClip.targetLabel}
          </span>
          <div className="flex items-center gap-1 text-zinc-500">
            Duration
            <EntranceDurationInput
              clip={editingMathTexTransformClip}
              key={`${editingMathTexTransformClip.transactionId}/${editingMathTexTransformClip.interval.start}/${editingMathTexTransformClip.interval.end}/${editingMathTexTransformClip.maximumDuration}`}
              kind="Transform"
              onCommit={(duration) => onMathTexTransformClipChange?.(editingMathTexTransformClip, { duration })}
            />
            s
          </div>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label={`Transform easing for ${editingMathTexTransformClip.label}`}
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-teal-500"
              disabled={editingMathTexTransformClip.readOnlyReason !== null}
              onChange={(event) =>
                onMathTexTransformClipChange?.(editingMathTexTransformClip, {
                  easing: event.currentTarget.value as MathTexTransformEasing,
                })
              }
              value={editingMathTexTransformClip.easing}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={editingMathTexTransformClip.readOnlyReason !== null || !onMathTexTransformClipDelete}
            onClick={() => onMathTexTransformClipDelete?.(editingMathTexTransformClip)}
            type="button"
          >
            Remove Transform
          </button>
          {editingMathTexTransformClip.readOnlyReason ? (
            <span className="text-amber-500">{editingMathTexTransformClip.readOnlyReason}</span>
          ) : (
            <span className="text-zinc-600">Apply or discard the Program replacement when finished.</span>
          )}
        </div>
      ) : null}
      {editingCameraClip ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="text-sky-300">Camera</span>
          <div className="flex items-center gap-1 text-zinc-500">
            Duration
            <CameraDurationInput
              clip={editingCameraClip}
              key={`${editingCameraClip.transactionId}/${editingCameraClip.interval.start}/${editingCameraClip.interval.end}/${editingCameraClip.maximumDuration}`}
              onCommit={(duration) => onCameraClipChange?.(editingCameraClip, { duration })}
            />
            s
          </div>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label="Camera easing"
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-sky-500"
              disabled={editingCameraClip.readOnlyReason !== null}
              onChange={(event) =>
                onCameraClipChange?.(editingCameraClip, {
                  easing: event.currentTarget.value as CameraClipEasing,
                })
              }
              value={editingCameraClip.easing}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={editingCameraClip.readOnlyReason !== null || !onCameraClipDelete}
            onClick={() => onCameraClipDelete?.(editingCameraClip)}
            type="button"
          >
            Remove Camera clip
          </button>
          {editingCameraClip.readOnlyReason ? (
            <span className="text-amber-500">{editingCameraClip.readOnlyReason}</span>
          ) : (
            <span className="text-zinc-600">Apply or discard the Program replacement when finished.</span>
          )}
        </div>
      ) : null}
      {editingShapeTransformClip ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-64 truncate text-cyan-300" title={editingShapeTransformClip.label}>
            Shape Transform · {editingShapeTransformClip.label} →{" "}
            {shapeTransformKindLabel(editingShapeTransformClip.targetShape)}
          </span>
          <div className="flex items-center gap-1 text-zinc-500">
            Duration
            <EntranceDurationInput
              clip={editingShapeTransformClip}
              key={`${editingShapeTransformClip.transactionId}/${editingShapeTransformClip.interval.start}/${editingShapeTransformClip.interval.end}/${editingShapeTransformClip.maximumDuration}`}
              kind="Shape Transform"
              onCommit={(duration) => onShapeTransformClipChange?.(editingShapeTransformClip, { duration })}
            />
            s
          </div>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label={`Shape Transform easing for ${editingShapeTransformClip.label}`}
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-cyan-500"
              disabled={editingShapeTransformClip.readOnlyReason !== null}
              onChange={(event) =>
                onShapeTransformClipChange?.(editingShapeTransformClip, {
                  easing: event.currentTarget.value as ShapeTransformEasing,
                })
              }
              value={editingShapeTransformClip.easing}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={editingShapeTransformClip.readOnlyReason !== null || !onShapeTransformClipDelete}
            onClick={() => onShapeTransformClipDelete?.(editingShapeTransformClip)}
            type="button"
          >
            Remove Shape Transform
          </button>
          {editingShapeTransformClip.readOnlyReason ? (
            <span className="text-amber-500">{editingShapeTransformClip.readOnlyReason}</span>
          ) : (
            <span className="text-zinc-600">Apply or discard the Program replacement when finished.</span>
          )}
        </div>
      ) : null}
      {editingPathMorphClip ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-64 truncate text-violet-300" title={editingPathMorphClip.label}>
            Path Morph · {editingPathMorphClip.label}
          </span>
          <div className="flex items-center gap-1 text-zinc-500">
            Duration
            <EntranceDurationInput
              clip={editingPathMorphClip}
              key={`${editingPathMorphClip.transactionId}/${editingPathMorphClip.interval.start}/${editingPathMorphClip.interval.end}/${editingPathMorphClip.maximumDuration}`}
              kind="Path Morph"
              onCommit={(duration) => onPathMorphClipChange?.(editingPathMorphClip, { duration })}
            />
            s
          </div>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label={`Path Morph easing for ${editingPathMorphClip.label}`}
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-violet-500"
              disabled={editingPathMorphClip.readOnlyReason !== null}
              onChange={(event) =>
                onPathMorphClipChange?.(editingPathMorphClip, {
                  easing: event.currentTarget.value as PathMorphEasing,
                })
              }
              value={editingPathMorphClip.easing}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={editingPathMorphClip.readOnlyReason !== null || !onPathMorphClipDelete}
            onClick={() => onPathMorphClipDelete?.(editingPathMorphClip)}
            type="button"
          >
            Remove Path Morph
          </button>
          {editingPathMorphClip.readOnlyReason ? (
            <span className="text-amber-500">{editingPathMorphClip.readOnlyReason}</span>
          ) : (
            <span className="text-zinc-600">Drag the violet target handles, then apply the replacement.</span>
          )}
        </div>
      ) : null}
      {selectedLifetimeTrack && selectedLifetimeInterval ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-40 truncate text-zinc-400" title={selectedLifetimeTrack.label}>
            Lifetime · {selectedLifetimeTrack.label}
          </span>
          <LifetimeTargetForm
            controls={selectedLifetimeControls}
            disabled={lifetimeTrimDisabled || selectedLifetimeLocked}
            edge="start"
            interval={selectedLifetimeInterval}
            onChange={onLifetimeChange}
            track={selectedLifetimeTrack}
          />
          <LifetimeTargetForm
            controls={selectedLifetimeControls}
            disabled={lifetimeTrimDisabled || selectedLifetimeLocked}
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
          {selectedLifetimeLocked ? (
            <span className="text-pretty text-amber-500">{LOCKED_ENTITY_MUTATION_MESSAGE}</span>
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
              disabled={selectedOpacityLocked || selectedOpacityTrack.readOnlyReason !== null}
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
              disabled={
                selectedOpacityLocked ||
                selectedOpacityTrack.readOnlyReason !== null ||
                selectedOpacityKeyframe!.index === 0
              }
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
                selectedOpacityLocked ||
                selectedOpacityTrack.readOnlyReason !== null ||
                selectedOpacityKeyframe!.index === selectedOpacityTrack.keyframes.length - 1
              }
              onChange={(event) =>
                onOpacityKeyframeChange(selectedOpacityTrack, selectedOpacityKeyframe!.index, {
                  easing: event.currentTarget.value as StudioPropertyKeyframeEasing,
                })
              }
              value={selectedOpacityMarker.easing}
            >
              <PropertyKeyframeEasingOptions />
            </select>
          </label>
          <DuplicateKeyframeButton
            disabledReason={keyframeDuplicateDisabledReason(
              readOnly,
              selectedOpacityLocked,
              selectedOpacityTrack.readOnlyReason,
            )}
            onClick={() => {
              const index = onOpacityKeyframeDuplicate(selectedOpacityTrack, selectedOpacityKeyframe!.index);
              if (index !== null)
                setSelectedOpacityKeyframe({ index, transactionId: selectedOpacityTrack.transactionId });
            }}
            propertyLabel="opacity"
          />
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={
              selectedOpacityLocked ||
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
          {selectedOpacityLocked ? <span className="text-amber-500">{LOCKED_ENTITY_MUTATION_MESSAGE}</span> : null}
        </div>
      ) : null}
      {selectedPaintColorTrack && selectedPaintColorMarker ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-48 truncate text-cyan-300" title={selectedPaintColorTrack.label}>
            {paintColorPropertyLabel(selectedPaintColorTrack.property)} · {selectedPaintColorTrack.label}
          </span>
          <label className="flex items-center gap-1 text-zinc-500">
            Time
            <input
              aria-label={`${paintColorPropertyLabel(selectedPaintColorTrack.property)} keyframe time`}
              className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-cyan-500"
              disabled={
                selectedPaintColorLocked ||
                selectedPaintColorTrack.readOnlyReason !== null ||
                !onPaintColorKeyframeChange
              }
              max={duration}
              min="0"
              onChange={(event) =>
                onPaintColorKeyframeChange?.(selectedPaintColorTrack, selectedPaintColorKeyframe!.index, {
                  time: Number(event.currentTarget.value),
                })
              }
              step="0.05"
              type="number"
              value={selectedPaintColorMarker.time}
            />
            s
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Color
            <input
              aria-label={`${paintColorPropertyLabel(selectedPaintColorTrack.property)} keyframe value`}
              className="h-7 w-10 cursor-pointer border border-zinc-700 bg-zinc-950 p-0.5 disabled:cursor-not-allowed"
              disabled={
                selectedPaintColorLocked ||
                selectedPaintColorTrack.readOnlyReason !== null ||
                selectedPaintColorKeyframe!.index === 0 ||
                !onPaintColorKeyframeChange
              }
              onChange={(event) =>
                onPaintColorKeyframeChange?.(selectedPaintColorTrack, selectedPaintColorKeyframe!.index, {
                  value: event.currentTarget.value,
                })
              }
              type="color"
              value={selectedPaintColorMarker.value}
            />
            <span className="font-mono text-zinc-300">{selectedPaintColorMarker.value}</span>
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label={`${paintColorPropertyLabel(selectedPaintColorTrack.property)} segment easing`}
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-cyan-500"
              disabled={
                selectedPaintColorLocked ||
                selectedPaintColorTrack.readOnlyReason !== null ||
                selectedPaintColorKeyframe!.index === selectedPaintColorTrack.keyframes.length - 1 ||
                !onPaintColorKeyframeChange
              }
              onChange={(event) =>
                onPaintColorKeyframeChange?.(selectedPaintColorTrack, selectedPaintColorKeyframe!.index, {
                  easing: event.currentTarget.value as PaintColorKeyframeEasing,
                })
              }
              value={selectedPaintColorMarker.easing}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <DuplicateKeyframeButton
            disabledReason={
              onPaintColorKeyframeDuplicate
                ? keyframeDuplicateDisabledReason(
                    readOnly,
                    selectedPaintColorLocked,
                    selectedPaintColorTrack.readOnlyReason,
                  )
                : "Paint color keyframe duplication is unavailable."
            }
            onClick={() => {
              const index = onPaintColorKeyframeDuplicate?.(selectedPaintColorTrack, selectedPaintColorKeyframe!.index);
              if (index !== undefined && index !== null) {
                setSelectedPaintColorKeyframe({
                  index,
                  transactionId: selectedPaintColorTrack.transactionId,
                });
              }
            }}
            propertyLabel="paint color"
          />
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={
              selectedPaintColorLocked ||
              selectedPaintColorTrack.readOnlyReason !== null ||
              selectedPaintColorKeyframe!.index === 0 ||
              !onPaintColorKeyframeDelete
            }
            onClick={() => {
              if (selectedPaintColorKeyframe!.index === 0) return;
              onPaintColorKeyframeDelete?.(selectedPaintColorTrack, selectedPaintColorKeyframe!.index);
              setSelectedPaintColorKeyframe(null);
            }}
            type="button"
          >
            {selectedPaintColorTrack.keyframes.length === 2 ? "Remove color track" : "Delete keyframe"}
          </button>
          {selectedPaintColorTrack.readOnlyReason ? (
            <span className="text-amber-500">{selectedPaintColorTrack.readOnlyReason}</span>
          ) : null}
          {selectedPaintColorLocked ? <span className="text-amber-500">{LOCKED_ENTITY_MUTATION_MESSAGE}</span> : null}
        </div>
      ) : null}
      {selectedScaleTrack && selectedScaleMarker ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-48 truncate text-emerald-300" title={selectedScaleTrack.label}>
            Scale · {selectedScaleTrack.label}
          </span>
          <label className="flex items-center gap-1 text-zinc-500">
            Time
            <input
              aria-label="Scale keyframe time"
              className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-emerald-500"
              disabled={selectedScaleLocked || selectedScaleTrack.readOnlyReason !== null}
              max={duration}
              min="0"
              onChange={(event) =>
                onScaleKeyframeChange(selectedScaleTrack, selectedScaleKeyframe!.index, {
                  time: Number(event.currentTarget.value),
                })
              }
              step="0.05"
              type="number"
              value={selectedScaleMarker.time}
            />
            s
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Value
            <input
              aria-label="Scale keyframe value"
              className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-emerald-500"
              disabled={
                selectedScaleLocked || selectedScaleTrack.readOnlyReason !== null || selectedScaleKeyframe!.index === 0
              }
              max="8"
              min="0.1"
              onChange={(event) =>
                onScaleKeyframeChange(selectedScaleTrack, selectedScaleKeyframe!.index, {
                  value: Number(event.currentTarget.value),
                })
              }
              step="0.05"
              type="number"
              value={selectedScaleMarker.value}
            />
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label="Scale segment easing"
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-emerald-500"
              disabled={
                selectedScaleLocked ||
                selectedScaleTrack.readOnlyReason !== null ||
                selectedScaleKeyframe!.index === selectedScaleTrack.keyframes.length - 1
              }
              onChange={(event) =>
                onScaleKeyframeChange(selectedScaleTrack, selectedScaleKeyframe!.index, {
                  easing: event.currentTarget.value as StudioPropertyKeyframeEasing,
                })
              }
              value={selectedScaleMarker.easing}
            >
              <PropertyKeyframeEasingOptions />
            </select>
          </label>
          <DuplicateKeyframeButton
            disabledReason={keyframeDuplicateDisabledReason(
              readOnly,
              selectedScaleLocked,
              selectedScaleTrack.readOnlyReason,
            )}
            onClick={() => {
              const index = onScaleKeyframeDuplicate(selectedScaleTrack, selectedScaleKeyframe!.index);
              if (index !== null) setSelectedScaleKeyframe({ index, transactionId: selectedScaleTrack.transactionId });
            }}
            propertyLabel="scale"
          />
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={
              selectedScaleLocked ||
              selectedScaleTrack.readOnlyReason !== null ||
              (selectedScaleKeyframe!.index === 0 && selectedScaleTrack.keyframes.length > 1)
            }
            onClick={() => {
              if (selectedScaleKeyframe!.index === 0 && selectedScaleTrack.keyframes.length > 1) return;
              onScaleKeyframeDelete(selectedScaleTrack, selectedScaleKeyframe!.index);
              setSelectedScaleKeyframe(null);
            }}
            type="button"
          >
            Delete keyframe
          </button>
          {selectedScaleTrack.readOnlyReason ? (
            <span className="text-amber-500">{selectedScaleTrack.readOnlyReason}</span>
          ) : null}
          {selectedScaleLocked ? <span className="text-amber-500">{LOCKED_ENTITY_MUTATION_MESSAGE}</span> : null}
        </div>
      ) : null}
      {selectedRotationTrack && selectedRotationMarker ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <span className="max-w-48 truncate text-amber-300" title={selectedRotationTrack.label}>
            Rotation · {selectedRotationTrack.label}
          </span>
          <label className="flex items-center gap-1 text-zinc-500">
            Time
            <input
              aria-label="Rotation keyframe time"
              className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-amber-500"
              disabled={selectedRotationLocked || selectedRotationTrack.readOnlyReason !== null}
              max={duration}
              min="0"
              onChange={(event) =>
                onRotationKeyframeChange(selectedRotationTrack, selectedRotationKeyframe!.index, {
                  time: Number(event.currentTarget.value),
                })
              }
              step="0.05"
              type="number"
              value={selectedRotationMarker.time}
            />
            s
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Degrees
            <input
              aria-label="Rotation keyframe value (degrees)"
              className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-zinc-200 outline-none focus:border-amber-500"
              disabled={
                selectedRotationLocked ||
                selectedRotationTrack.readOnlyReason !== null ||
                selectedRotationKeyframe!.index === 0
              }
              onChange={(event) =>
                onRotationKeyframeChange(selectedRotationTrack, selectedRotationKeyframe!.index, {
                  value: Number(event.currentTarget.value),
                })
              }
              step="1"
              type="number"
              value={selectedRotationMarker.value}
            />
            °
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Easing
            <select
              aria-label="Rotation segment easing"
              className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-amber-500"
              disabled={
                selectedRotationLocked ||
                selectedRotationTrack.readOnlyReason !== null ||
                selectedRotationKeyframe!.index === selectedRotationTrack.keyframes.length - 1
              }
              onChange={(event) =>
                onRotationKeyframeChange(selectedRotationTrack, selectedRotationKeyframe!.index, {
                  easing: event.currentTarget.value as StudioPropertyKeyframeEasing,
                })
              }
              value={selectedRotationMarker.easing}
            >
              <PropertyKeyframeEasingOptions />
            </select>
          </label>
          <DuplicateKeyframeButton
            disabledReason={keyframeDuplicateDisabledReason(
              readOnly,
              selectedRotationLocked,
              selectedRotationTrack.readOnlyReason,
            )}
            onClick={() => {
              const index = onRotationKeyframeDuplicate(selectedRotationTrack, selectedRotationKeyframe!.index);
              if (index !== null)
                setSelectedRotationKeyframe({ index, transactionId: selectedRotationTrack.transactionId });
            }}
            propertyLabel="rotation"
          />
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={
              selectedRotationLocked ||
              selectedRotationTrack.readOnlyReason !== null ||
              (selectedRotationKeyframe!.index === 0 && selectedRotationTrack.keyframes.length > 1)
            }
            onClick={() => {
              if (selectedRotationKeyframe!.index === 0 && selectedRotationTrack.keyframes.length > 1) return;
              onRotationKeyframeDelete(selectedRotationTrack, selectedRotationKeyframe!.index);
              setSelectedRotationKeyframe(null);
            }}
            type="button"
          >
            Delete keyframe
          </button>
          {selectedRotationTrack.readOnlyReason ? (
            <span className="text-amber-500">{selectedRotationTrack.readOnlyReason}</span>
          ) : null}
          {selectedRotationLocked ? <span className="text-amber-500">{LOCKED_ENTITY_MUTATION_MESSAGE}</span> : null}
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
              disabled={selectedMaterialLocked || selectedMaterialTrack.readOnlyReason !== null}
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
              disabled={
                selectedMaterialLocked ||
                selectedMaterialTrack.readOnlyReason !== null ||
                selectedMaterialKeyframe!.index === 0
              }
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
                selectedMaterialLocked ||
                selectedMaterialTrack.readOnlyReason !== null ||
                selectedMaterialKeyframe!.index === selectedMaterialTrack.keyframes.length - 1
              }
              onChange={(event) =>
                onMaterialParameterKeyframeChange(selectedMaterialTrack, selectedMaterialKeyframe!.index, {
                  easing: event.currentTarget.value as StudioPropertyKeyframeEasing,
                })
              }
              value={selectedMaterialMarker.easing}
            >
              <PropertyKeyframeEasingOptions />
            </select>
          </label>
          <DuplicateKeyframeButton
            disabledReason={keyframeDuplicateDisabledReason(
              readOnly,
              selectedMaterialLocked,
              selectedMaterialTrack.readOnlyReason,
            )}
            onClick={() => {
              const index = onMaterialParameterKeyframeDuplicate(
                selectedMaterialTrack,
                selectedMaterialKeyframe!.index,
              );
              if (index !== null)
                setSelectedMaterialKeyframe({ index, transactionId: selectedMaterialTrack.transactionId });
            }}
            propertyLabel="material parameter"
          />
          <button
            className="h-7 border border-zinc-700 px-2 text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
            disabled={
              selectedMaterialLocked ||
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
          {selectedMaterialLocked ? <span className="text-amber-500">{LOCKED_ENTITY_MUTATION_MESSAGE}</span> : null}
        </div>
      ) : null}
      {editingMotionClip ? (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-800 pt-2 text-[10px]">
          <p className="text-pretty leading-4 text-zinc-500" role="status">
            Editing {editingMotionClip.label} motion. The body and left edge snap to safe amber source anchors; the
            right edge changes duration. Duration{" "}
            {(editingMotionClip.interval.end - editingMotionClip.interval.start).toFixed(2)}s.
          </p>
          {editingMotionClip.penPathMotion ? (
            <label className="ml-auto flex shrink-0 items-center gap-1 text-zinc-500">
              Easing
              <select
                aria-label={`Easing for ${editingMotionClip.label} Pen motion`}
                className="h-7 border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-sky-500"
                onChange={(event) =>
                  onAppliedMotionClipChange(editingMotionClip, {
                    duration: editingMotionClip.interval.end - editingMotionClip.interval.start,
                    easing: event.currentTarget.value as MotionEasing,
                    sourceStart: editingMotionClip.sourceStart,
                  })
                }
                value={editingMotionClip.easing}
              >
                <option value="smooth">Smooth</option>
                <option value="linear">Linear</option>
              </select>
            </label>
          ) : null}
          {onAppliedMotionClipDelete && editingMotionClip.penPathMotion ? (
            <button
              aria-label={`Delete ${editingMotionClip.label} motion clip`}
              className="shrink-0 border border-red-950 px-2 py-1 text-red-300 hover:bg-red-950/50 disabled:cursor-not-allowed disabled:text-zinc-700"
              disabled={editingMotionClip.readOnlyReason !== null || Boolean(editingMotionClip.deleteUnavailableReason)}
              onClick={() => onAppliedMotionClipDelete(editingMotionClip)}
              title={editingMotionClip.deleteUnavailableReason ?? editingMotionClip.readOnlyReason ?? undefined}
              type="button"
            >
              Delete clip
            </button>
          ) : null}
        </div>
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
              <TimelineRulerScrubber
                currentTime={currentTime}
                duration={duration}
                onTimeChange={onTimeChange}
                playbackClock={playbackClock}
              />
              <TimelinePlayhead
                currentTime={currentTime}
                duration={duration}
                playbackClock={playbackClock}
                showHandle
              />
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
              <TimelinePlayhead currentTime={currentTime} duration={duration} playbackClock={playbackClock} />
            </div>
          </div>
          <div
            className="grid grid-cols-[6rem_minmax(0,1fr)] border-b border-zinc-800 sm:grid-cols-[8rem_minmax(0,1fr)]"
            data-camera-track
          >
            <div className="flex min-w-0 items-center px-2 text-[10px] font-medium text-sky-300">Camera</div>
            <div className="relative h-8 min-w-0 overflow-hidden">
              {cameraClips.map((clip) => {
                const readOnlyReason = readOnly
                  ? "The timeline is read-only."
                  : (clip.readOnlyReason ?? (!onCameraClipSelect ? "Camera clip editing is unavailable." : null));
                const displayedClip = { ...clip, readOnlyReason };
                return (
                  <button
                    aria-label="Edit Camera clip"
                    className={cn(
                      "absolute top-1 z-10 h-5 min-w-2 border border-sky-500 bg-sky-950/90 px-1 text-left text-[9px] leading-4 text-sky-200 hover:bg-sky-900",
                      editingAppliedTransactionId === clip.transactionId && "ring-1 ring-sky-300",
                      readOnlyReason && "cursor-not-allowed border-zinc-700 bg-zinc-900 text-zinc-600",
                    )}
                    data-camera-clip={clip.operationId}
                    disabled={readOnlyReason !== null}
                    key={clip.operationId}
                    onClick={() => onCameraClipSelect?.(displayedClip)}
                    style={timelineIntervalStyle(clip.interval, duration)}
                    title={
                      readOnlyReason ??
                      `Camera ${clip.interval.start.toFixed(2)}–${clip.interval.end.toFixed(2)}s · ${clip.easing}`
                    }
                    type="button"
                  >
                    <span className="block truncate">Camera</span>
                  </button>
                );
              })}
              <TimelinePlayhead currentTime={currentTime} duration={duration} playbackClock={playbackClock} />
            </div>
          </div>
          {objectTracks.map((track, trackIndex) => {
            const selected = selectedIds.has(track.entityId);
            const materialTracks = materialParameterTracks.filter((candidate) => candidate.entityId === track.entityId);
            const staleMaterialTrack = materialTracks.find(({ assignmentChanged }) => assignmentChanged) ?? null;
            const materialOptions = materialParameterOptions.filter(
              (candidate) => candidate.entityId === track.entityId,
            );
            const requestedMaterialName = selectedMaterialParameterByEntity[track.entityId];
            const selectedMaterialName =
              requestedMaterialName !== undefined && materialOptions.some(({ name }) => name === requestedMaterialName)
                ? requestedMaterialName
                : (materialTracks[0]?.parameterName ?? materialOptions[0]?.name ?? "");
            const opacityTrack = opacityTracks.find((candidate) => candidate.entityId === track.entityId) ?? null;
            const paintColorProperty = paintColorTrackEligibleProperties.get(track.entityId) ?? null;
            const paintColorTrack = paintColorTracks.find((candidate) => candidate.entityId === track.entityId) ?? null;
            const rotationTrack = rotationTracks.find((candidate) => candidate.entityId === track.entityId) ?? null;
            const scaleTrack = scaleTracks.find((candidate) => candidate.entityId === track.entityId) ?? null;
            const trackMotionClips = appliedMotionClips.filter((clip) => clip.entityId === track.entityId);
            const trackDrawInClips = drawInClips.filter((clip) => clip.entityId === track.entityId);
            const trackMathTexTransformClips = mathTexTransformClips.filter((clip) => clip.entityId === track.entityId);
            const trackPathMorphClips = pathMorphClips.filter((clip) => clip.entityId === track.entityId);
            const trackShapeTransformClips = shapeTransformClips.filter((clip) => clip.entityId === track.entityId);
            const trackWriteInClips = writeInClips.filter((clip) => clip.entityId === track.entityId);
            const drawInUnavailableReason = drawInAvailability.has(track.entityId)
              ? (drawInAvailability.get(track.entityId) ?? null)
              : "Draw supports only Studio-created objects.";
            const writeInUnavailableReason = writeInAvailability.has(track.entityId)
              ? (writeInAvailability.get(track.entityId) ?? null)
              : "Write supports only Studio-created objects.";
            const authoredClipOperationIds = new Set([
              ...trackMotionClips.map((clip) => clip.operationId),
              ...trackDrawInClips.map((clip) => clip.operationId),
              ...trackMathTexTransformClips.map((clip) => clip.operationId),
              ...trackPathMorphClips.map((clip) => clip.operationId),
              ...trackShapeTransformClips.map((clip) => clip.operationId),
              ...trackWriteInClips.map((clip) => clip.operationId),
            ]);
            const selectionLocked =
              readOnly ||
              (track.provisional && !(track.transactionId && appliedTransactionIds.has(track.transactionId)));
            const authoringLocked = lockedEntityIds.has(track.entityId);
            const mutationLocked = selectionLocked || authoringLocked;
            const drawInAddBlocker = selectionLocked
              ? "The timeline is read-only."
              : authoringLocked
                ? LOCKED_ENTITY_MUTATION_MESSAGE
                : drawInUnavailableReason;
            const drawInBlockerId = `draw-in-blocker-${trackIndex}`;
            const writeInAddBlocker = selectionLocked
              ? "The timeline is read-only."
              : authoringLocked
                ? LOCKED_ENTITY_MUTATION_MESSAGE
                : writeInUnavailableReason;
            const writeInBlockerId = `write-in-blocker-${trackIndex}`;
            return (
              <div
                className="grid grid-cols-[6rem_minmax(0,1fr)] border-b border-zinc-800 last:border-b-0 sm:grid-cols-[8rem_minmax(0,1fr)]"
                data-timeline-track={track.entityId}
                key={track.entityId}
              >
                <div className={cn("relative z-20 flex min-w-0 items-center", selected && "bg-sky-950")}>
                  <button
                    aria-pressed={selected}
                    className={cn(
                      "min-w-0 flex-1 truncate px-2 text-left text-[10px]",
                      selectionLocked ? "cursor-not-allowed text-zinc-700" : "hover:bg-zinc-800",
                      selected ? "text-sky-300" : "text-zinc-500",
                    )}
                    disabled={selectionLocked}
                    onClick={() => onSelectEntity(track.entityId)}
                    title={authoringLocked ? `${track.label} · Locked in Layers` : `${track.label} · ${track.type}`}
                    type="button"
                  >
                    {track.label}
                  </button>
                  {selected && trackDrawInClips.length === 0 ? (
                    <>
                      <button
                        aria-describedby={drawInAddBlocker ? drawInBlockerId : undefined}
                        aria-disabled={mutationLocked || drawInUnavailableReason !== null}
                        aria-label={`Add Draw entrance for ${track.label}`}
                        className="mr-1 h-5 shrink-0 px-1 text-[9px] leading-none text-violet-300 hover:bg-violet-950 aria-disabled:cursor-not-allowed aria-disabled:text-zinc-600"
                        onClick={() => {
                          if (!drawInAddBlocker) onDrawInAdd(track.entityId);
                        }}
                        title={drawInAddBlocker ?? "Replace the initial fade with a stroke Draw entrance"}
                        type="button"
                      >
                        D+
                      </button>
                      {drawInAddBlocker ? (
                        <span className="sr-only" id={drawInBlockerId}>
                          {drawInAddBlocker}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {selected && trackWriteInClips.length === 0 ? (
                    <>
                      <button
                        aria-describedby={writeInAddBlocker ? writeInBlockerId : undefined}
                        aria-disabled={mutationLocked || writeInUnavailableReason !== null}
                        aria-label={`Add Write entrance for ${track.label}`}
                        className="mr-1 h-5 shrink-0 px-1 text-[9px] leading-none text-fuchsia-300 hover:bg-fuchsia-950 aria-disabled:cursor-not-allowed aria-disabled:text-zinc-600"
                        onClick={() => {
                          if (!writeInAddBlocker) onWriteInAdd(track.entityId);
                        }}
                        title={writeInAddBlocker ?? "Replace the initial fade with a glyph-ordered Write entrance"}
                        type="button"
                      >
                        W+
                      </button>
                      {writeInAddBlocker ? (
                        <span className="sr-only" id={writeInBlockerId}>
                          {writeInAddBlocker}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {selected && opacityTrackEligibleIds.has(track.entityId) ? (
                    <button
                      aria-label={`Add opacity keyframe for ${track.label}`}
                      className="mr-1 size-5 shrink-0 text-sm leading-none text-sky-400 hover:bg-sky-900 disabled:cursor-not-allowed disabled:text-zinc-600"
                      disabled={mutationLocked}
                      onClick={() => onOpacityKeyframeAdd(track.entityId)}
                      title="Add opacity keyframe at the playhead"
                      type="button"
                    >
                      +
                    </button>
                  ) : null}
                  {selected && paintColorProperty && onPaintColorKeyframeAdd ? (
                    <button
                      aria-label={`Add ${paintColorProperty === "fillColor" ? "fill" : "stroke"} color keyframe for ${track.label}`}
                      className="mr-1 h-5 shrink-0 px-1 text-[9px] leading-none text-cyan-300 hover:bg-cyan-950 disabled:cursor-not-allowed disabled:text-zinc-600"
                      disabled={mutationLocked}
                      onClick={() => onPaintColorKeyframeAdd(track.entityId)}
                      title={`Add ${paintColorProperty === "fillColor" ? "fill" : "stroke"} color keyframe at the playhead`}
                      type="button"
                    >
                      {paintColorProperty === "fillColor" ? "F+" : "St+"}
                    </button>
                  ) : null}
                  {selected && scaleTrackEligibleIds.has(track.entityId) ? (
                    <button
                      aria-label={`Add scale keyframe for ${track.label}`}
                      className="mr-1 h-5 shrink-0 px-1 text-[9px] leading-none text-emerald-400 hover:bg-emerald-950 disabled:cursor-not-allowed disabled:text-zinc-600"
                      disabled={mutationLocked}
                      onClick={() => onScaleKeyframeAdd(track.entityId)}
                      title="Add uniform scale keyframe at the playhead"
                      type="button"
                    >
                      S+
                    </button>
                  ) : null}
                  {selected && rotationTrackEligibleIds.has(track.entityId) ? (
                    <button
                      aria-label={`Add rotation keyframe for ${track.label}`}
                      className="mr-1 h-5 shrink-0 px-1 text-[9px] leading-none text-amber-400 hover:bg-amber-950 disabled:cursor-not-allowed disabled:text-zinc-600"
                      disabled={mutationLocked}
                      onClick={() => onRotationKeyframeAdd(track.entityId)}
                      title="Add rotation keyframe at the playhead"
                      type="button"
                    >
                      R+
                    </button>
                  ) : null}
                  {staleMaterialTrack ? (
                    <button
                      aria-label={`Remove stale material track for ${track.label}`}
                      className="mr-1 h-5 shrink-0 border border-red-900 px-1 text-[9px] text-red-300 hover:bg-red-950 disabled:cursor-not-allowed disabled:text-zinc-600"
                      disabled={mutationLocked}
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
                        onChange={(event) => {
                          const parameterName = event.currentTarget.value;
                          setSelectedMaterialParameterByEntity((current) => ({
                            ...current,
                            [track.entityId]: parameterName,
                          }));
                        }}
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
                        disabled={mutationLocked || selectedMaterialName === ""}
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
                        disabled={mutationLocked || lifetimeTrimDisabled}
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
                        selectDisabled={selectionLocked}
                        selected={lifetimeSelected}
                      />
                    );
                  })}
                  {track.animatedChannels.map((channel, index) =>
                    channel.operationId && authoredClipOperationIds.has(channel.operationId) ? null : (
                      <div
                        aria-label={
                          channel.readOnlyReason ? `${channel.key} animation · ${channel.readOnlyReason}` : undefined
                        }
                        className={cn(
                          "absolute bottom-1 z-10 h-1.5 min-w-px bg-sky-400",
                          channel.readOnlyReason && "cursor-help focus-visible:h-2",
                        )}
                        data-timeline-animation
                        data-timeline-read-only-animation={channel.readOnlyReason ? "" : undefined}
                        key={`${track.entityId}/${channel.key}/${index}`}
                        style={timelineIntervalStyle(channel.interval, duration)}
                        tabIndex={channel.readOnlyReason ? 0 : undefined}
                        title={`${channel.key} animation ${channel.interval.start.toFixed(2)}–${channel.interval.end.toFixed(2)}s${channel.readOnlyReason ? ` · ${channel.readOnlyReason}` : ""}`}
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
                      locked={mutationLocked || opacityTrack.readOnlyReason !== null}
                      onChange={(patch) => onOpacityKeyframeChange(opacityTrack, index, patch)}
                      onSelect={() => {
                        onSelectEntity(track.entityId);
                        setSelectedMaterialKeyframe(null);
                        setSelectedPaintColorKeyframe(null);
                        setSelectedRotationKeyframe(null);
                        setSelectedScaleKeyframe(null);
                        setSelectedOpacityKeyframe({ index, transactionId: opacityTrack.transactionId });
                      }}
                      selected={
                        selectedOpacityKeyframe?.transactionId === opacityTrack.transactionId &&
                        selectedOpacityKeyframe.index === index
                      }
                    />
                  ))}
                  {paintColorTrack?.keyframes.map((keyframe, index) => (
                    <PropertyKeyframeMarker
                      duration={duration}
                      index={index}
                      key={`${paintColorTrack.transactionId}/${paintColorTrack.property}/${index}`}
                      keyframe={keyframe}
                      kind="paint-color"
                      locked={mutationLocked || paintColorTrack.readOnlyReason !== null}
                      onChange={(patch) => onPaintColorKeyframeChange?.(paintColorTrack, index, patch)}
                      onSelect={() => {
                        onSelectEntity(track.entityId);
                        setSelectedMaterialKeyframe(null);
                        setSelectedOpacityKeyframe(null);
                        setSelectedRotationKeyframe(null);
                        setSelectedScaleKeyframe(null);
                        setSelectedPaintColorKeyframe({ index, transactionId: paintColorTrack.transactionId });
                      }}
                      paintProperty={paintColorTrack.property}
                      selected={
                        selectedPaintColorKeyframe?.transactionId === paintColorTrack.transactionId &&
                        selectedPaintColorKeyframe.index === index
                      }
                    />
                  ))}
                  {scaleTrack?.keyframes.map((keyframe, index) => (
                    <PropertyKeyframeMarker
                      duration={duration}
                      index={index}
                      key={`${scaleTrack.transactionId}/${index}`}
                      keyframe={keyframe}
                      kind="scale"
                      locked={mutationLocked || scaleTrack.readOnlyReason !== null}
                      onChange={(patch) => onScaleKeyframeChange(scaleTrack, index, patch)}
                      onSelect={() => {
                        onSelectEntity(track.entityId);
                        setSelectedMaterialKeyframe(null);
                        setSelectedOpacityKeyframe(null);
                        setSelectedPaintColorKeyframe(null);
                        setSelectedRotationKeyframe(null);
                        setSelectedScaleKeyframe({ index, transactionId: scaleTrack.transactionId });
                      }}
                      selected={
                        selectedScaleKeyframe?.transactionId === scaleTrack.transactionId &&
                        selectedScaleKeyframe.index === index
                      }
                    />
                  ))}
                  {rotationTrack?.keyframes.map((keyframe, index) => (
                    <PropertyKeyframeMarker
                      duration={duration}
                      index={index}
                      key={`${rotationTrack.transactionId}/${index}`}
                      keyframe={keyframe}
                      kind="rotation"
                      locked={mutationLocked || rotationTrack.readOnlyReason !== null}
                      onChange={(patch) => onRotationKeyframeChange(rotationTrack, index, patch)}
                      onSelect={() => {
                        onSelectEntity(track.entityId);
                        setSelectedMaterialKeyframe(null);
                        setSelectedOpacityKeyframe(null);
                        setSelectedPaintColorKeyframe(null);
                        setSelectedScaleKeyframe(null);
                        setSelectedRotationKeyframe({ index, transactionId: rotationTrack.transactionId });
                      }}
                      selected={
                        selectedRotationKeyframe?.transactionId === rotationTrack.transactionId &&
                        selectedRotationKeyframe.index === index
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
                        locked={mutationLocked || materialTrack.readOnlyReason !== null}
                        onChange={(patch) => onMaterialParameterKeyframeChange(materialTrack, index, patch)}
                        onSelect={() => {
                          onSelectEntity(track.entityId);
                          setSelectedOpacityKeyframe(null);
                          setSelectedPaintColorKeyframe(null);
                          setSelectedRotationKeyframe(null);
                          setSelectedScaleKeyframe(null);
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
                      clip={{
                        ...clip,
                        readOnlyReason: authoringLocked ? LOCKED_ENTITY_MUTATION_MESSAGE : clip.readOnlyReason,
                      }}
                      duration={duration}
                      editing={editingAppliedTransactionId === clip.transactionId}
                      key={`${clip.operationId}/${clip.entityId}`}
                      onChange={(change) => onAppliedMotionClipChange(clip, change)}
                      onSelect={() => onAppliedMotionClipSelect(clip)}
                    />
                  ))}
                  {trackDrawInClips.map((clip) => {
                    const readOnlyReason = selectionLocked
                      ? "The timeline is read-only."
                      : authoringLocked
                        ? LOCKED_ENTITY_MUTATION_MESSAGE
                        : clip.readOnlyReason;
                    const displayedClip = { ...clip, readOnlyReason };
                    return (
                      <button
                        aria-label={`Edit ${clip.label} Draw entrance`}
                        className={cn(
                          "absolute top-1 z-10 h-5 min-w-2 border border-violet-500 bg-violet-950/90 px-1 text-left text-[9px] leading-4 text-violet-200 hover:bg-violet-900",
                          readOnlyReason && "cursor-not-allowed border-zinc-700 bg-zinc-900 text-zinc-600",
                        )}
                        disabled={readOnlyReason !== null}
                        data-draw-in-clip={clip.operationId}
                        key={clip.operationId}
                        onClick={() => onDrawInSelect(displayedClip)}
                        style={timelineIntervalStyle(clip.interval, duration)}
                        title={
                          readOnlyReason ??
                          `Draw ${clip.interval.start.toFixed(2)}–${clip.interval.end.toFixed(2)}s · ${clip.easing}`
                        }
                        type="button"
                      >
                        <span className="block truncate">Draw</span>
                      </button>
                    );
                  })}
                  {trackWriteInClips.map((clip) => {
                    const readOnlyReason = selectionLocked
                      ? "The timeline is read-only."
                      : authoringLocked
                        ? LOCKED_ENTITY_MUTATION_MESSAGE
                        : clip.readOnlyReason;
                    const displayedClip = { ...clip, readOnlyReason };
                    return (
                      <button
                        aria-label={`Edit ${clip.label} Write entrance`}
                        className={cn(
                          "absolute top-1 z-10 h-5 min-w-2 border border-fuchsia-500 bg-fuchsia-950/90 px-1 text-left text-[9px] leading-4 text-fuchsia-200 hover:bg-fuchsia-900",
                          readOnlyReason && "cursor-not-allowed border-zinc-700 bg-zinc-900 text-zinc-600",
                        )}
                        disabled={readOnlyReason !== null}
                        data-write-in-clip={clip.operationId}
                        key={clip.operationId}
                        onClick={() => onWriteInSelect(displayedClip)}
                        style={timelineIntervalStyle(clip.interval, duration)}
                        title={
                          readOnlyReason ??
                          `Write ${clip.interval.start.toFixed(2)}–${clip.interval.end.toFixed(2)}s · ${clip.easing}`
                        }
                        type="button"
                      >
                        <span className="block truncate">Write</span>
                      </button>
                    );
                  })}
                  {trackMathTexTransformClips.map((clip) => {
                    const readOnlyReason = selectionLocked
                      ? "The timeline is read-only."
                      : authoringLocked
                        ? LOCKED_ENTITY_MUTATION_MESSAGE
                        : (clip.readOnlyReason ??
                          (!onMathTexTransformClipSelect ? "MathTex Transform clip editing is unavailable." : null));
                    const displayedClip = { ...clip, readOnlyReason };
                    return (
                      <button
                        aria-label={`Edit ${clip.label} MathTex Transform`}
                        className={cn(
                          "absolute top-1 z-10 h-5 min-w-2 border border-teal-500 bg-teal-950/90 px-1 text-left text-[9px] leading-4 text-teal-200 hover:bg-teal-900",
                          editingAppliedTransactionId === clip.transactionId && "ring-1 ring-teal-300",
                          readOnlyReason && "cursor-not-allowed border-zinc-700 bg-zinc-900 text-zinc-600",
                        )}
                        disabled={readOnlyReason !== null}
                        data-mathtex-transform-clip={clip.operationId}
                        key={clip.operationId}
                        onClick={() => onMathTexTransformClipSelect?.(displayedClip)}
                        style={timelineIntervalStyle(clip.interval, duration)}
                        title={
                          readOnlyReason ??
                          `Transform to ${clip.targetLabel} · ${clip.interval.start.toFixed(2)}–${clip.interval.end.toFixed(2)}s · ${clip.easing}`
                        }
                        type="button"
                      >
                        <span className="block truncate">Transform</span>
                      </button>
                    );
                  })}
                  {trackShapeTransformClips.map((clip) => {
                    const readOnlyReason = selectionLocked
                      ? "The timeline is read-only."
                      : authoringLocked
                        ? LOCKED_ENTITY_MUTATION_MESSAGE
                        : (clip.readOnlyReason ??
                          (!onShapeTransformClipSelect ? "Shape Transform clip editing is unavailable." : null));
                    const displayedClip = { ...clip, readOnlyReason };
                    const targetLabel = shapeTransformKindLabel(clip.targetShape);
                    return (
                      <button
                        aria-label={`Edit ${clip.label} Shape Transform`}
                        className={cn(
                          "absolute top-1 z-10 h-5 min-w-2 border border-cyan-500 bg-cyan-950/90 px-1 text-left text-[9px] leading-4 text-cyan-200 hover:bg-cyan-900",
                          editingAppliedTransactionId === clip.transactionId && "ring-1 ring-cyan-300",
                          readOnlyReason && "cursor-not-allowed border-zinc-700 bg-zinc-900 text-zinc-600",
                        )}
                        disabled={readOnlyReason !== null}
                        data-shape-transform-clip={clip.operationId}
                        key={clip.operationId}
                        onClick={() => onShapeTransformClipSelect?.(displayedClip)}
                        style={timelineIntervalStyle(clip.interval, duration)}
                        title={
                          readOnlyReason ??
                          `Transform to ${targetLabel} · ${clip.interval.start.toFixed(2)}–${clip.interval.end.toFixed(2)}s · ${clip.easing}`
                        }
                        type="button"
                      >
                        <span className="block truncate">Shape</span>
                      </button>
                    );
                  })}
                  {trackPathMorphClips.map((clip) => {
                    const readOnlyReason = selectionLocked
                      ? "The timeline is read-only."
                      : authoringLocked
                        ? LOCKED_ENTITY_MUTATION_MESSAGE
                        : (clip.readOnlyReason ??
                          (!onPathMorphClipSelect ? "Path Morph clip editing is unavailable." : null));
                    const displayedClip = { ...clip, readOnlyReason };
                    return (
                      <button
                        aria-label={`Edit ${clip.label} Path Morph`}
                        className={cn(
                          "absolute top-1 z-10 h-5 min-w-2 border border-violet-500 bg-violet-950/90 px-1 text-left text-[9px] leading-4 text-violet-200 hover:bg-violet-900",
                          editingAppliedTransactionId === clip.transactionId && "ring-1 ring-violet-300",
                          readOnlyReason && "cursor-not-allowed border-zinc-700 bg-zinc-900 text-zinc-600",
                        )}
                        disabled={readOnlyReason !== null}
                        data-path-morph-clip={clip.operationId}
                        key={clip.operationId}
                        onClick={() => onPathMorphClipSelect?.(displayedClip)}
                        style={timelineIntervalStyle(clip.interval, duration)}
                        title={
                          readOnlyReason ??
                          `Path Morph · ${clip.interval.start.toFixed(2)}–${clip.interval.end.toFixed(2)}s · ${clip.easing}`
                        }
                        type="button"
                      >
                        <span className="block truncate">Path</span>
                      </button>
                    );
                  })}
                  {track.lifetimes.length === 0 ? (
                    <span className="absolute inset-0 flex items-center px-2 text-[9px] text-zinc-700">
                      Not present
                    </span>
                  ) : null}
                  <TimelinePlayhead currentTime={currentTime} duration={duration} playbackClock={playbackClock} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
