import { useState, type FormEvent, type KeyboardEvent } from "react";

import { cn } from "../lib/cn";
import {
  initialInspectorEditValues,
  validateInspectorEdits,
  type InspectorEditField,
  type InspectorEditValues,
  type ValidatedInspectorEdits,
} from "./inspector-edit";
import type { ProjectedEntity } from "./model";
import { entityLabel } from "./studio-viewport";

type EntityInspectorEditorProps = Readonly<{
  entity: ProjectedEntity;
  onCreateDraft: (
    entityId: string,
    edits: ValidatedInspectorEdits,
    returnFocus: InspectorEditField,
  ) => boolean;
  onFocusRestored: () => void;
  restoreFocus: InspectorEditField | null;
}>;

const inputClass = "mt-1 h-9 w-full border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-xs text-zinc-200 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40";
const textareaClass = "mt-1 min-h-20 w-full resize-y border border-zinc-700 bg-zinc-950 p-2 text-xs leading-5 text-zinc-200 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40";

function fieldErrorId(entityId: string, field: InspectorEditField) {
  return `${entityId.replace(/[^A-Za-z0-9_-]/g, "-")}-${field}-error`;
}

function FieldError({ entityId, error, field }: Readonly<{
  entityId: string;
  error?: string;
  field: InspectorEditField;
}>) {
  return error ? (
    <span className="mt-1 block text-pretty text-[10px] leading-4 text-red-300" id={fieldErrorId(entityId, field)} role="alert">
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
  return (element: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (!element || restored || restoreFocus !== field) return;
    restored = true;
    element.focus();
    onFocusRestored();
  };
}

function firstChangedField(
  entity: ProjectedEntity,
  edits: ValidatedInspectorEdits,
): InspectorEditField {
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
  entity,
  onCreateDraft,
  onFocusRestored,
  restoreFocus,
}: EntityInspectorEditorProps) {
  const initialValues = initialInspectorEditValues(entity);
  const [values, setValues] = useState<InspectorEditValues>(initialValues);
  const [errors, setErrors] = useState<Partial<Record<InspectorEditField, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const positionAvailable = entity.geometry.position.kind === "known";
  const contentAvailable = (entity.type === "Text" || entity.type === "MathTex")
    && (entity.sourceIdentity.kind === "known" || Boolean(entity.transactionId));
  const dimensionsAvailable = entity.geometry.dimensions.kind === "known"
    && entity.geometry.position.kind === "known"
    && entity.geometry.scale.kind === "known"
    && (entity.type === "Circle" || entity.type === "Rectangle");

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
      const firstInvalid = (["x", "y", "content", "radius", "width", "height"] as const)
        .find((field) => validation.errors[field] !== undefined);
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
    const activeField = event.currentTarget.ownerDocument.activeElement instanceof HTMLElement
      ? event.currentTarget.ownerDocument.activeElement.dataset.inspectorField as InspectorEditField | undefined
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

  return (
    <form className="mt-4 space-y-4 border-t border-zinc-800 pt-4" noValidate onKeyDown={keyboardSubmit} onSubmit={submit}>
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
            <label className="mt-2 block text-[10px] text-zinc-500">
              {entity.type === "MathTex" ? "One constructor argument per line" : "Content"}
              <textarea
                aria-label={`${entity.type} content of ${entityLabel(entity)}`}
                aria-describedby={errors.content ? fieldErrorId(entity.id, "content") : undefined}
                aria-invalid={errors.content ? "true" : undefined}
                className={cn(textareaClass, entity.type === "MathTex" && "font-mono", errors.content && "border-red-800")}
                data-inspector-field="content"
                maxLength={2_000}
                onChange={(event) => update("content", event.currentTarget.value)}
                ref={restoreFieldRef("content", restoreFocus, onFocusRestored)}
                value={values.content ?? ""}
              />
              <FieldError entityId={entity.id} error={errors.content} field="content" />
            </label>
          ) : (
            <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-300">
              Reimport this object with a stable source identity before editing its content.
            </p>
          )}
        </fieldset>
      ) : null}

      {entity.type === "Circle" || entity.type === "Rectangle" ? (
        <fieldset>
          <legend className="text-balance text-xs font-medium text-zinc-300">Shape geometry</legend>
          {dimensionsAvailable ? (
            <div className={cn("mt-2 grid gap-2", entity.type === "Rectangle" && "grid-cols-2")}>
              {(entity.type === "Circle" ? ["radius"] as const : ["width", "height"] as const).map((field) => (
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

      {message ? <p className="text-pretty text-[10px] leading-4 text-zinc-400" role="status">{message}</p> : null}
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
