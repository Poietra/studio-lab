import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";

import { cn } from "../lib/cn";
import { CAMERA_CLIP_EASINGS, type CameraClipEasing } from "./camera-clip-edit";
import { CONTENT_TRANSFORM_EASINGS, type ContentTransformEasing } from "./content-transform-clip-edit";
import {
  type InspectorEditField,
  type InspectorEditValues,
  initialInspectorEditValues,
  type ValidatedInspectorEdits,
  validateInspectorEdits,
} from "./inspector-edit";
import type { ProjectedEntity } from "./model";
import {
  isShapeTransformTarget,
  SHAPE_TRANSFORM_EASINGS,
  SHAPE_TRANSFORM_TARGETS,
  type ShapeTransformEasing,
  type ShapeTransformTarget,
} from "./shape-transform-clip-edit";
import { entityLabel } from "./studio-viewport";

export type ContentTransformInspectorInput = Readonly<{
  content: NonNullable<ValidatedInspectorEdits["content"]>;
  duration: number;
  easing: ContentTransformEasing;
}>;

export type ContentTransformInspectorAuthoring = Readonly<{
  defaultDuration: number;
  onCreate: (entityId: string, input: ContentTransformInspectorInput) => boolean;
  unavailableReason: string | null;
}>;

export type ShapeTransformInspectorTarget = ShapeTransformTarget;

type ShapeTransformInspectorInputBase = Readonly<{
  duration: number;
  easing: ShapeTransformEasing;
}>;

export type ShapeTransformInspectorInput = ShapeTransformInspectorInputBase &
  (
    | Readonly<{ radius: number; target: "Circle" | "Triangle" }>
    | Readonly<{ height: number; target: "Ellipse" | "Rectangle"; width: number }>
    | Readonly<{ radius: number; sides: number; target: "RegularPolygon" }>
  );

export type ShapeTransformInspectorAuthoring = Readonly<{
  currentShape: ShapeTransformInspectorTarget;
  defaultDuration: number;
  onCreate: (entityId: string, input: ShapeTransformInspectorInput) => boolean;
  unavailableReason: string | null;
}>;

function defaultShapeTransformTarget(currentShape: ShapeTransformInspectorTarget | undefined) {
  return currentShape === "Circle" ? "Rectangle" : "Circle";
}

function shapeTransformTargetLabel(target: ShapeTransformInspectorTarget) {
  return target === "RegularPolygon" ? "Regular Polygon" : target;
}

export type CameraInspectorAuthoring = Readonly<{
  defaultDuration: number;
  focusUnavailableReason: string | null;
  onFocus: (input: Readonly<{ duration: number; easing: CameraClipEasing }>) => boolean;
  onReset: (input: Readonly<{ duration: number; easing: CameraClipEasing }>) => boolean;
  resetUnavailableReason: string | null;
}>;

export function CameraInspectorEditor({ authoring }: Readonly<{ authoring: CameraInspectorAuthoring }>) {
  const [duration, setDuration] = useState(String(authoring.defaultDuration));
  const [easing, setEasing] = useState<CameraClipEasing>("smooth");
  const [message, setMessage] = useState<string | null>(null);

  function invoke(kind: "focus" | "reset") {
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds < 0.1) {
      setMessage("Camera duration must be at least 0.1 seconds.");
      return;
    }
    const unavailable = kind === "focus" ? authoring.focusUnavailableReason : authoring.resetUnavailableReason;
    if (unavailable) {
      setMessage(unavailable);
      return;
    }
    const accepted =
      kind === "focus"
        ? authoring.onFocus({ duration: seconds, easing })
        : authoring.onReset({ duration: seconds, easing });
    setMessage(accepted ? null : `Camera ${kind === "focus" ? "Focus" : "Reset"} could not be created.`);
  }

  return (
    <fieldset className="mt-3 border border-zinc-800 bg-zinc-950/40 p-2">
      <legend className="text-balance text-xs font-medium text-zinc-300">Camera</legend>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-[10px] text-zinc-500">
          Duration
          <input
            aria-label="New Camera duration"
            className={inputClass}
            min="0.1"
            onChange={(event) => setDuration(event.currentTarget.value)}
            step="0.1"
            type="number"
            value={duration}
          />
        </label>
        <label className="text-[10px] text-zinc-500">
          Easing
          <select
            aria-label="New Camera easing"
            className={inputClass}
            onChange={(event) => setEasing(event.currentTarget.value as CameraClipEasing)}
            value={easing}
          >
            {CAMERA_CLIP_EASINGS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate === "smooth" ? "Smooth" : "Linear"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          aria-disabled={authoring.focusUnavailableReason !== null}
          className="h-8 border border-sky-800 text-xs text-sky-300 hover:bg-sky-950 aria-disabled:cursor-not-allowed aria-disabled:border-zinc-800 aria-disabled:text-zinc-600"
          onClick={() => invoke("focus")}
          title={authoring.focusUnavailableReason ?? "Pan and zoom to the exact prepared selection bounds"}
          type="button"
        >
          Focus selection
        </button>
        <button
          aria-disabled={authoring.resetUnavailableReason !== null}
          className="h-8 border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800 aria-disabled:cursor-not-allowed aria-disabled:border-zinc-800 aria-disabled:text-zinc-600"
          onClick={() => invoke("reset")}
          title={authoring.resetUnavailableReason ?? "Return to the base Scene view"}
          type="button"
        >
          Reset view
        </button>
      </div>
      {message ? (
        <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-500" role="status">
          {message}
        </p>
      ) : null}
    </fieldset>
  );
}

type EntityInspectorEditorProps = Readonly<{
  entity: ProjectedEntity;
  contentTransform?: ContentTransformInspectorAuthoring;
  onCreateDraft: (entityId: string, edits: ValidatedInspectorEdits, returnFocus: InspectorEditField) => boolean;
  onFocusRestored: () => void;
  restoreFocus: InspectorEditField | null;
  shapeTransform?: ShapeTransformInspectorAuthoring;
}>;

const inputClass =
  "mt-1 h-9 w-full border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-xs text-zinc-200 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40";
const textareaClass =
  "mt-1 min-h-20 w-full resize-y border border-zinc-700 bg-zinc-950 p-2 text-xs leading-5 text-zinc-200 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40";

function fieldErrorId(entityId: string, field: InspectorEditField) {
  return `${entityId.replace(/[^A-Za-z0-9_-]/g, "-")}-${field}-error`;
}

function FieldError({
  entityId,
  error,
  field,
}: Readonly<{
  entityId: string;
  error?: string;
  field: InspectorEditField;
}>) {
  return error ? (
    <span
      className="mt-1 block text-pretty text-[10px] leading-4 text-red-300"
      id={fieldErrorId(entityId, field)}
      role="alert"
    >
      {error}
    </span>
  ) : null;
}

function restoreFieldRef(
  field: InspectorEditField,
  restoreFocus: InspectorEditField | null,
  onFocusRestored: () => void,
) {
  let restored = false;
  return (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => {
    if (!element || restored || restoreFocus !== field) return;
    restored = true;
    element.focus();
    onFocusRestored();
  };
}

function firstChangedField(entity: ProjectedEntity, edits: ValidatedInspectorEdits): InspectorEditField {
  if (edits.content) return "content";
  if (edits.position) return "x";
  if (edits.dimensions?.radius !== undefined) return "radius";
  if (edits.dimensions?.width !== undefined) return "width";
  if (edits.dimensions?.height !== undefined) return "height";
  return entity.type === "Text" || entity.type === "MathTex" ? "content" : "x";
}

export function entityInspectorKey(entity: ProjectedEntity) {
  return JSON.stringify({
    content: entity.content,
    geometry: {
      dimensions: entity.geometry.dimensions,
      position: entity.geometry.position,
      scale: entity.geometry.scale,
    },
    id: entity.id,
    position: entity.position,
  });
}

export function EntityInspectorEditor({
  contentTransform,
  entity,
  onCreateDraft,
  onFocusRestored,
  restoreFocus,
  shapeTransform,
}: EntityInspectorEditorProps) {
  const initialValues = initialInspectorEditValues(entity);
  const [values, setValues] = useState<InspectorEditValues>(initialValues);
  const [errors, setErrors] = useState<Partial<Record<InspectorEditField, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [transformDuration, setTransformDuration] = useState(String(contentTransform?.defaultDuration ?? 1));
  const [transformEasing, setTransformEasing] = useState<ContentTransformEasing>("smooth");
  const [transformMessage, setTransformMessage] = useState<string | null>(null);
  const [transformTarget, setTransformTarget] = useState(initialValues.content ?? "");
  const [shapeTransformDuration, setShapeTransformDuration] = useState(String(shapeTransform?.defaultDuration ?? 1));
  const [shapeTransformEasing, setShapeTransformEasing] = useState<ShapeTransformEasing>("smooth");
  const [shapeTransformMessage, setShapeTransformMessage] = useState<string | null>(null);
  const [shapeTransformTarget, setShapeTransformTarget] = useState<ShapeTransformInspectorTarget>(
    defaultShapeTransformTarget(shapeTransform?.currentShape),
  );
  const [shapeTransformTargetHeight, setShapeTransformTargetHeight] = useState("2");
  const [shapeTransformTargetRadius, setShapeTransformTargetRadius] = useState("1");
  const [shapeTransformTargetSides, setShapeTransformTargetSides] = useState("6");
  const [shapeTransformTargetWidth, setShapeTransformTargetWidth] = useState("4");
  const positionAvailable = entity.geometry.position.kind === "known";
  const contentAvailable =
    (entity.type === "Text" || entity.type === "MathTex") &&
    (entity.sourceIdentity.kind === "known" || Boolean(entity.transactionId));
  const typographyAvailable =
    entity.type === "Text" && entity.sourceIdentity.kind === "unknown" && Boolean(entity.transactionId);
  const dimensionsAvailable =
    entity.geometry.dimensions.kind === "known" &&
    entity.geometry.position.kind === "known" &&
    entity.geometry.scale.kind === "known" &&
    (entity.type === "Circle" || entity.type === "Rectangle");

  useEffect(() => {
    if (!shapeTransform) return;
    setShapeTransformTarget(defaultShapeTransformTarget(shapeTransform.currentShape));
    setShapeTransformMessage(null);
  }, [shapeTransform?.currentShape]);

  function update(field: InspectorEditField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setMessage(null);
  }

  function reset() {
    setValues(initialValues);
    setErrors({});
    setMessage(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateInspectorEdits(entity, values);
    if (validation.kind === "invalid") {
      setErrors(validation.errors);
      setMessage("Fix the highlighted fields before creating a draft.");
      const firstInvalid = (
        [
          "x",
          "y",
          "content",
          "textAlignment",
          "textFontFamily",
          "textFontSize",
          "textFontWeight",
          "textLineHeight",
          "textWrapWidth",
          "radius",
          "width",
          "height",
        ] as const
      ).find((field) => validation.errors[field] !== undefined);
      if (firstInvalid) {
        event.currentTarget.querySelector<HTMLElement>(`[data-inspector-field="${firstInvalid}"]`)?.focus();
      }
      return;
    }
    if (Object.keys(validation.edits).length === 0) {
      setErrors({});
      setMessage("No Inspector fields have changed.");
      return;
    }
    const activeField =
      event.currentTarget.ownerDocument.activeElement instanceof HTMLElement
        ? (event.currentTarget.ownerDocument.activeElement.dataset.inspectorField as InspectorEditField | undefined)
        : undefined;
    const returnFocus = activeField ?? firstChangedField(entity, validation.edits);
    if (onCreateDraft(entity.id, validation.edits, returnFocus)) {
      setErrors({});
      setMessage(null);
    }
  }

  function keyboardSubmit(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      reset();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  }

  function createContentTransform() {
    if (!contentTransform || (entity.type !== "MathTex" && entity.type !== "Text")) return;
    if (contentTransform.unavailableReason) {
      setTransformMessage(contentTransform.unavailableReason);
      return;
    }
    const duration = Number(transformDuration);
    if (!Number.isFinite(duration) || duration < 0.1) {
      setTransformMessage("Transform duration must be at least 0.1 seconds.");
      return;
    }
    const validation = validateInspectorEdits(entity, { ...initialValues, content: transformTarget });
    if (validation.kind === "invalid") {
      setTransformMessage(
        validation.errors.content ??
          (entity.type === "MathTex" ? "Enter a valid MathTex target expression." : "Enter valid target text."),
      );
      return;
    }
    if (!validation.edits.content) {
      setTransformMessage(`Enter target content different from the current ${entity.type} content.`);
      return;
    }
    if (
      contentTransform.onCreate(entity.id, {
        content: validation.edits.content,
        duration,
        easing: transformEasing,
      })
    ) {
      setTransformMessage(null);
    }
  }

  function createShapeTransform() {
    if (!shapeTransform || !isShapeTransformTarget(entity.type)) return;
    if (shapeTransform.unavailableReason) {
      setShapeTransformMessage(shapeTransform.unavailableReason);
      return;
    }
    const duration = Number(shapeTransformDuration);
    if (!Number.isFinite(duration) || duration < 0.1) {
      setShapeTransformMessage("Shape Transform duration must be at least 0.1 seconds.");
      return;
    }
    if (shapeTransformTarget === shapeTransform.currentShape && shapeTransformTarget !== "RegularPolygon") {
      setShapeTransformMessage("Choose a different shape as the Transform target.");
      return;
    }
    const radius = Number(shapeTransformTargetRadius);
    if (
      (shapeTransformTarget === "Circle" ||
        shapeTransformTarget === "Triangle" ||
        shapeTransformTarget === "RegularPolygon") &&
      (!Number.isFinite(radius) || radius <= 0)
    ) {
      setShapeTransformMessage("Shape Transform target radius must be a positive number.");
      return;
    }
    const height = Number(shapeTransformTargetHeight);
    const width = Number(shapeTransformTargetWidth);
    if (
      (shapeTransformTarget === "Ellipse" || shapeTransformTarget === "Rectangle") &&
      (!Number.isFinite(height) || height <= 0 || !Number.isFinite(width) || width <= 0)
    ) {
      setShapeTransformMessage("Shape Transform target width and height must be positive numbers.");
      return;
    }
    const sides = Number(shapeTransformTargetSides);
    if (shapeTransformTarget === "RegularPolygon" && (!Number.isInteger(sides) || sides < 3 || sides > 32)) {
      setShapeTransformMessage("Regular Polygon sides must be an integer from 3 to 32.");
      return;
    }
    const common = { duration, easing: shapeTransformEasing } as const;
    const input: ShapeTransformInspectorInput =
      shapeTransformTarget === "Circle" || shapeTransformTarget === "Triangle"
        ? { ...common, radius, target: shapeTransformTarget }
        : shapeTransformTarget === "Ellipse" || shapeTransformTarget === "Rectangle"
          ? { ...common, height, target: shapeTransformTarget, width }
          : sides === 3
            ? { ...common, radius, target: "Triangle" }
            : { ...common, radius, sides, target: "RegularPolygon" };
    if (shapeTransform.onCreate(entity.id, input)) {
      setShapeTransformMessage(null);
    }
  }

  return (
    <form
      className="mt-4 space-y-4 border-t border-zinc-800 pt-4"
      noValidate
      onKeyDown={keyboardSubmit}
      onSubmit={submit}
    >
      <fieldset>
        <legend className="text-balance text-xs font-medium text-zinc-300">Position</legend>
        {positionAvailable ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(["x", "y"] as const).map((field) => (
              <label className="text-[10px] text-zinc-500" key={field}>
                {field.toUpperCase()}
                <input
                  aria-label={`${field.toUpperCase()} position of ${entityLabel(entity)}`}
                  aria-describedby={errors[field] ? fieldErrorId(entity.id, field) : undefined}
                  aria-invalid={errors[field] ? "true" : undefined}
                  className={cn(inputClass, errors[field] && "border-red-800")}
                  data-inspector-field={field}
                  inputMode="decimal"
                  onChange={(event) => update(field, event.currentTarget.value)}
                  ref={restoreFieldRef(field, restoreFocus, onFocusRestored)}
                  step="0.1"
                  type="number"
                  value={values[field] ?? ""}
                />
                <FieldError entityId={entity.id} error={errors[field]} field={field} />
              </label>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-300">
            Runtime-dependent position cannot be edited safely.
          </p>
        )}
      </fieldset>

      {entity.type === "Text" || entity.type === "MathTex" ? (
        <fieldset>
          <legend className="text-balance text-xs font-medium text-zinc-300">
            {entity.type === "MathTex" ? "MathTex content" : "Text content"}
          </legend>
          {contentAvailable ? (
            <div className="mt-2 space-y-3">
              <label className="block text-[10px] text-zinc-500">
                {entity.type === "MathTex" ? "One constructor argument per line" : "Content"}
                <textarea
                  aria-label={`${entity.type} content of ${entityLabel(entity)}`}
                  aria-describedby={errors.content ? fieldErrorId(entity.id, "content") : undefined}
                  aria-invalid={errors.content ? "true" : undefined}
                  className={cn(
                    textareaClass,
                    entity.type === "MathTex" && "font-mono",
                    errors.content && "border-red-800",
                  )}
                  data-inspector-field="content"
                  maxLength={2_000}
                  onChange={(event) => update("content", event.currentTarget.value)}
                  ref={restoreFieldRef("content", restoreFocus, onFocusRestored)}
                  value={values.content ?? ""}
                />
                <FieldError entityId={entity.id} error={errors.content} field="content" />
              </label>
              {typographyAvailable ? (
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[10px] text-zinc-500">
                    Alignment
                    <select
                      aria-label={`Text alignment of ${entityLabel(entity)}`}
                      aria-describedby={errors.textAlignment ? fieldErrorId(entity.id, "textAlignment") : undefined}
                      aria-invalid={errors.textAlignment ? "true" : undefined}
                      className={cn(inputClass, errors.textAlignment && "border-red-800")}
                      data-inspector-field="textAlignment"
                      onChange={(event) => update("textAlignment", event.currentTarget.value)}
                      ref={restoreFieldRef("textAlignment", restoreFocus, onFocusRestored)}
                      value={values.textAlignment ?? "left"}
                    >
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                    <FieldError entityId={entity.id} error={errors.textAlignment} field="textAlignment" />
                  </label>
                  <label className="text-[10px] text-zinc-500">
                    Family
                    <select
                      aria-label={`Text font family of ${entityLabel(entity)}`}
                      aria-describedby={errors.textFontFamily ? fieldErrorId(entity.id, "textFontFamily") : undefined}
                      aria-invalid={errors.textFontFamily ? "true" : undefined}
                      className={cn(inputClass, errors.textFontFamily && "border-red-800")}
                      data-inspector-field="textFontFamily"
                      onChange={(event) => update("textFontFamily", event.currentTarget.value)}
                      ref={restoreFieldRef("textFontFamily", restoreFocus, onFocusRestored)}
                      value={values.textFontFamily ?? "sans"}
                    >
                      <option value="sans">Sans</option>
                      <option value="mono">Mono</option>
                    </select>
                    <FieldError entityId={entity.id} error={errors.textFontFamily} field="textFontFamily" />
                  </label>
                  <label className="text-[10px] text-zinc-500">
                    Size (scene units)
                    <input
                      aria-label={`Text font size of ${entityLabel(entity)}`}
                      aria-describedby={errors.textFontSize ? fieldErrorId(entity.id, "textFontSize") : undefined}
                      aria-invalid={errors.textFontSize ? "true" : undefined}
                      className={cn(inputClass, errors.textFontSize && "border-red-800")}
                      data-inspector-field="textFontSize"
                      inputMode="decimal"
                      min="0.1"
                      onChange={(event) => update("textFontSize", event.currentTarget.value)}
                      ref={restoreFieldRef("textFontSize", restoreFocus, onFocusRestored)}
                      step="0.1"
                      type="number"
                      value={values.textFontSize ?? ""}
                    />
                    <FieldError entityId={entity.id} error={errors.textFontSize} field="textFontSize" />
                  </label>
                  <label className="text-[10px] text-zinc-500">
                    Weight
                    <select
                      aria-label={`Text font weight of ${entityLabel(entity)}`}
                      aria-describedby={errors.textFontWeight ? fieldErrorId(entity.id, "textFontWeight") : undefined}
                      aria-invalid={errors.textFontWeight ? "true" : undefined}
                      className={cn(inputClass, errors.textFontWeight && "border-red-800")}
                      data-inspector-field="textFontWeight"
                      onChange={(event) => update("textFontWeight", event.currentTarget.value)}
                      ref={restoreFieldRef("textFontWeight", restoreFocus, onFocusRestored)}
                      value={values.textFontWeight ?? "regular"}
                    >
                      <option value="regular">Regular</option>
                      <option value="bold">Bold</option>
                    </select>
                    <FieldError entityId={entity.id} error={errors.textFontWeight} field="textFontWeight" />
                  </label>
                  <label className="text-[10px] text-zinc-500">
                    Line height (em)
                    <input
                      aria-label={`Text line height of ${entityLabel(entity)}`}
                      aria-describedby={errors.textLineHeight ? fieldErrorId(entity.id, "textLineHeight") : undefined}
                      aria-invalid={errors.textLineHeight ? "true" : undefined}
                      className={cn(inputClass, errors.textLineHeight && "border-red-800")}
                      data-inspector-field="textLineHeight"
                      inputMode="decimal"
                      min="0.1"
                      onChange={(event) => update("textLineHeight", event.currentTarget.value)}
                      ref={restoreFieldRef("textLineHeight", restoreFocus, onFocusRestored)}
                      step="0.1"
                      type="number"
                      value={values.textLineHeight ?? ""}
                    />
                    <FieldError entityId={entity.id} error={errors.textLineHeight} field="textLineHeight" />
                  </label>
                  <label className="text-[10px] text-zinc-500">
                    Wrap width (scene units)
                    <input
                      aria-label={`Text wrap width of ${entityLabel(entity)}`}
                      aria-describedby={errors.textWrapWidth ? fieldErrorId(entity.id, "textWrapWidth") : undefined}
                      aria-invalid={errors.textWrapWidth ? "true" : undefined}
                      className={cn(inputClass, errors.textWrapWidth && "border-red-800")}
                      data-inspector-field="textWrapWidth"
                      inputMode="decimal"
                      min="0.1"
                      onChange={(event) => update("textWrapWidth", event.currentTarget.value)}
                      placeholder="No wrap"
                      ref={restoreFieldRef("textWrapWidth", restoreFocus, onFocusRestored)}
                      step="0.1"
                      type="number"
                      value={values.textWrapWidth ?? ""}
                    />
                    <FieldError entityId={entity.id} error={errors.textWrapWidth} field="textWrapWidth" />
                  </label>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-300">
              Reimport this object with a stable source identity before editing its content.
            </p>
          )}
        </fieldset>
      ) : null}

      {(entity.type === "MathTex" || entity.type === "Text") && contentTransform ? (
        <fieldset className="border-t border-zinc-800 pt-4">
          <legend className="text-balance text-xs font-medium text-zinc-300">Animate content transform</legend>
          <div className="mt-2 space-y-3">
            <label className="block text-[10px] text-zinc-500">
              {entity.type === "MathTex" ? "Target · one constructor argument per line" : "Target text"}
              <textarea
                aria-label={`Content transform target of ${entityLabel(entity)}`}
                className={cn(textareaClass, entity.type === "MathTex" && "font-mono")}
                disabled={contentTransform.unavailableReason !== null}
                maxLength={2_000}
                onChange={(event) => {
                  setTransformTarget(event.currentTarget.value);
                  setTransformMessage(null);
                }}
                value={transformTarget}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[10px] text-zinc-500">
                Duration (seconds)
                <input
                  aria-label={`Content transform duration of ${entityLabel(entity)}`}
                  className={inputClass}
                  disabled={contentTransform.unavailableReason !== null}
                  min="0.1"
                  onChange={(event) => {
                    setTransformDuration(event.currentTarget.value);
                    setTransformMessage(null);
                  }}
                  step="0.1"
                  type="number"
                  value={transformDuration}
                />
              </label>
              <label className="text-[10px] text-zinc-500">
                Easing
                <select
                  aria-label={`Content transform easing of ${entityLabel(entity)}`}
                  className={inputClass}
                  disabled={contentTransform.unavailableReason !== null}
                  onChange={(event) => setTransformEasing(event.currentTarget.value as ContentTransformEasing)}
                  value={transformEasing}
                >
                  {CONTENT_TRANSFORM_EASINGS.map((easing) => (
                    <option key={easing} value={easing}>
                      {easing === "linear" ? "Linear" : "Smooth"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className="h-9 w-full border border-teal-700 bg-teal-950 px-3 text-xs font-medium text-teal-200 hover:bg-teal-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
              disabled={contentTransform.unavailableReason !== null}
              onClick={createContentTransform}
              title={contentTransform.unavailableReason ?? "Create a replacement Transform at the playhead"}
              type="button"
            >
              Create Transform clip
            </button>
            {(transformMessage ?? contentTransform.unavailableReason) ? (
              <p className="text-pretty text-[10px] leading-4 text-amber-400" role="status">
                {transformMessage ?? contentTransform.unavailableReason}
              </p>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {entity.type === "Circle" || entity.type === "Rectangle" ? (
        <fieldset>
          <legend className="text-balance text-xs font-medium text-zinc-300">Shape geometry</legend>
          {dimensionsAvailable ? (
            <div className={cn("mt-2 grid gap-2", entity.type === "Rectangle" && "grid-cols-2")}>
              {(entity.type === "Circle" ? (["radius"] as const) : (["width", "height"] as const)).map((field) => (
                <label className="text-[10px] text-zinc-500" key={field}>
                  {field[0].toUpperCase() + field.slice(1)}
                  <input
                    aria-label={`${field[0].toUpperCase() + field.slice(1)} of ${entityLabel(entity)}`}
                    aria-describedby={errors[field] ? fieldErrorId(entity.id, field) : undefined}
                    aria-invalid={errors[field] ? "true" : undefined}
                    className={cn(inputClass, errors[field] && "border-red-800")}
                    data-inspector-field={field}
                    inputMode="decimal"
                    min="0.1"
                    onChange={(event) => update(field, event.currentTarget.value)}
                    ref={restoreFieldRef(field, restoreFocus, onFocusRestored)}
                    required
                    step="0.1"
                    type="number"
                    value={values[field] ?? ""}
                  />
                  <FieldError entityId={entity.id} error={errors[field]} field={field} />
                </label>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-300">
              Geometry editing requires known dimensions, position, and scale.
            </p>
          )}
        </fieldset>
      ) : null}

      {isShapeTransformTarget(entity.type) && shapeTransform ? (
        <fieldset className="border-t border-zinc-800 pt-4">
          <legend className="text-balance text-xs font-medium text-zinc-300">Animate Shape Transform</legend>
          <div className="mt-2 space-y-3">
            <label className="block text-[10px] text-zinc-500">
              Target shape
              <select
                aria-label={`Shape transform target of ${entityLabel(entity)}`}
                className={inputClass}
                disabled={shapeTransform.unavailableReason !== null}
                onChange={(event) => {
                  setShapeTransformTarget(event.currentTarget.value as ShapeTransformInspectorTarget);
                  setShapeTransformMessage(null);
                }}
                value={shapeTransformTarget}
              >
                {SHAPE_TRANSFORM_TARGETS.map((target) => (
                  <option
                    disabled={shapeTransform.currentShape === target && target !== "RegularPolygon"}
                    key={target}
                    value={target}
                  >
                    {shapeTransformTargetLabel(target)}
                  </option>
                ))}
              </select>
            </label>
            {shapeTransformTarget === "Ellipse" || shapeTransformTarget === "Rectangle" ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] text-zinc-500">
                  Target width
                  <input
                    aria-label={`Shape transform target width of ${entityLabel(entity)}`}
                    className={inputClass}
                    disabled={shapeTransform.unavailableReason !== null}
                    min="0.01"
                    onChange={(event) => {
                      setShapeTransformTargetWidth(event.currentTarget.value);
                      setShapeTransformMessage(null);
                    }}
                    step="0.1"
                    type="number"
                    value={shapeTransformTargetWidth}
                  />
                </label>
                <label className="text-[10px] text-zinc-500">
                  Target height
                  <input
                    aria-label={`Shape transform target height of ${entityLabel(entity)}`}
                    className={inputClass}
                    disabled={shapeTransform.unavailableReason !== null}
                    min="0.01"
                    onChange={(event) => {
                      setShapeTransformTargetHeight(event.currentTarget.value);
                      setShapeTransformMessage(null);
                    }}
                    step="0.1"
                    type="number"
                    value={shapeTransformTargetHeight}
                  />
                </label>
              </div>
            ) : (
              <div className={shapeTransformTarget === "RegularPolygon" ? "grid grid-cols-2 gap-2" : undefined}>
                <label className="text-[10px] text-zinc-500">
                  Target radius
                  <input
                    aria-label={`Shape transform target radius of ${entityLabel(entity)}`}
                    className={inputClass}
                    disabled={shapeTransform.unavailableReason !== null}
                    min="0.01"
                    onChange={(event) => {
                      setShapeTransformTargetRadius(event.currentTarget.value);
                      setShapeTransformMessage(null);
                    }}
                    step="0.1"
                    type="number"
                    value={shapeTransformTargetRadius}
                  />
                </label>
                {shapeTransformTarget === "RegularPolygon" ? (
                  <label className="text-[10px] text-zinc-500">
                    Target sides
                    <input
                      aria-label={`Shape transform target sides of ${entityLabel(entity)}`}
                      className={inputClass}
                      disabled={shapeTransform.unavailableReason !== null}
                      max="32"
                      min="3"
                      onChange={(event) => {
                        setShapeTransformTargetSides(event.currentTarget.value);
                        setShapeTransformMessage(null);
                      }}
                      step="1"
                      type="number"
                      value={shapeTransformTargetSides}
                    />
                  </label>
                ) : null}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[10px] text-zinc-500">
                Duration (seconds)
                <input
                  aria-label={`Shape transform duration of ${entityLabel(entity)}`}
                  className={inputClass}
                  disabled={shapeTransform.unavailableReason !== null}
                  min="0.1"
                  onChange={(event) => {
                    setShapeTransformDuration(event.currentTarget.value);
                    setShapeTransformMessage(null);
                  }}
                  step="0.1"
                  type="number"
                  value={shapeTransformDuration}
                />
              </label>
              <label className="text-[10px] text-zinc-500">
                Easing
                <select
                  aria-label={`Shape transform easing of ${entityLabel(entity)}`}
                  className={inputClass}
                  disabled={shapeTransform.unavailableReason !== null}
                  onChange={(event) => setShapeTransformEasing(event.currentTarget.value as ShapeTransformEasing)}
                  value={shapeTransformEasing}
                >
                  {SHAPE_TRANSFORM_EASINGS.map((easing) => (
                    <option key={easing} value={easing}>
                      {easing === "linear" ? "Linear" : "Smooth"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className="h-9 w-full border border-cyan-700 bg-cyan-950 px-3 text-xs font-medium text-cyan-200 hover:bg-cyan-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
              disabled={shapeTransform.unavailableReason !== null}
              onClick={createShapeTransform}
              title={shapeTransform.unavailableReason ?? "Create a shape Transform at the playhead"}
              type="button"
            >
              Create Shape Transform clip
            </button>
            {(shapeTransformMessage ?? shapeTransform.unavailableReason) ? (
              <p className="text-pretty text-[10px] leading-4 text-amber-400" role="status">
                {shapeTransformMessage ?? shapeTransform.unavailableReason}
              </p>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {message ? (
        <p className="text-pretty text-[10px] leading-4 text-zinc-400" role="status">
          {message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 border-t border-zinc-800 pt-3">
        <button
          className="h-9 border border-zinc-700 px-3 text-xs text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
          onClick={reset}
          type="button"
        >
          Reset fields
        </button>
        <button
          aria-keyshortcuts="Control+Enter Meta+Enter"
          className="h-9 bg-sky-500 px-3 text-xs font-medium text-sky-950 hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
          type="submit"
        >
          Create draft
        </button>
      </div>
      <p className="text-pretty text-[10px] leading-4 text-zinc-600">
        Press Ctrl/⌘+Enter to create a draft. Escape resets these fields.
      </p>
    </form>
  );
}
