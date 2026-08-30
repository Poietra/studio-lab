import {
  appendScenePostEffectParameterSchemaDraftV1,
  moveScenePostEffectParameterSchemaDraftV1,
  removeScenePostEffectParameterSchemaDraftV1,
  SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1,
  type StudioScenePostEffectParameterSchemaDraftRowV1,
} from "./scene-post-effect-parameter-schema-draft";

export type ScenePostEffectParameterSchemaEditorProps = Readonly<{
  disabledReason: string | null;
  draft: readonly StudioScenePostEffectParameterSchemaDraftRowV1[];
  onChange: (draft: readonly StudioScenePostEffectParameterSchemaDraftRowV1[]) => void;
}>;

type DraftField = keyof StudioScenePostEffectParameterSchemaDraftRowV1;

function replaceDraftField(
  draft: readonly StudioScenePostEffectParameterSchemaDraftRowV1[],
  index: number,
  field: DraftField,
  value: string,
) {
  return draft.map((row, candidateIndex) => (candidateIndex === index ? { ...row, [field]: value } : row));
}

const numericFields = [
  ["Default", "defaultValue"],
  ["Min", "min"],
  ["Max", "max"],
  ["Step", "step"],
] as const satisfies readonly (readonly [string, DraftField])[];

export function ScenePostEffectParameterSchemaEditor({
  disabledReason,
  draft,
  onChange,
}: ScenePostEffectParameterSchemaEditorProps) {
  const disabled = disabledReason !== null;
  const full = draft.length >= SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1.length;
  const disabledReasonId = "scene-post-effect-parameter-schema-disabled-reason";

  return (
    <fieldset
      aria-describedby={disabledReason ? disabledReasonId : undefined}
      aria-label="Scene post-effect parameter schema"
      className="mt-3 border border-zinc-800 p-2"
    >
      <legend className="px-1 text-[10px] font-medium text-zinc-400">Shader parameter schema</legend>
      <div className="flex items-start justify-between gap-2">
        <p className="text-pretty text-[10px] leading-4 text-zinc-600">
          Map scalar controls to the eight fixed Scene effect host slots.
        </p>
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">
          {draft.length} / {SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1.length}
        </span>
      </div>

      {disabledReason ? (
        <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-500" id={disabledReasonId} role="status">
          {disabledReason}
        </p>
      ) : null}

      {draft.length === 0 ? (
        <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
          No parameters are declared. Add one to expose a scalar control to WGSL or GLSL.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {draft.map((row, index) => {
            const slot = SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1[index];
            const rowLabel = `Scene effect parameter ${index + 1}`;
            return (
              <section aria-label={rowLabel} className="border border-zinc-800 p-2" key={slot}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium text-zinc-400">Parameter {index + 1}</span>
                  <code className="text-[10px] text-zinc-600">{slot}</code>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="text-[10px] text-zinc-500">
                    Name
                    <input
                      aria-label={`${rowLabel} name`}
                      className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
                      disabled={disabled}
                      maxLength={40}
                      onChange={(event) => onChange(replaceDraftField(draft, index, "name", event.currentTarget.value))}
                      placeholder="Amount"
                      value={row.name}
                    />
                  </label>
                  {numericFields.map(([label, field]) => (
                    <label className="text-[10px] text-zinc-500" key={field}>
                      {label}
                      <input
                        aria-label={`${rowLabel} ${label.toLowerCase()}`}
                        className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs tabular-nums text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
                        disabled={disabled}
                        onChange={(event) =>
                          onChange(replaceDraftField(draft, index, field, event.currentTarget.value))
                        }
                        step="any"
                        type="number"
                        value={row[field]}
                      />
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <button
                    aria-label={`Move parameter ${index + 1} up`}
                    className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
                    disabled={disabled || index === 0}
                    onClick={() => onChange(moveScenePostEffectParameterSchemaDraftV1(draft, index, -1))}
                    type="button"
                  >
                    Move up
                  </button>
                  <button
                    aria-label={`Move parameter ${index + 1} down`}
                    className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
                    disabled={disabled || index === draft.length - 1}
                    onClick={() => onChange(moveScenePostEffectParameterSchemaDraftV1(draft, index, 1))}
                    type="button"
                  >
                    Move down
                  </button>
                  <button
                    aria-label={`Remove parameter ${index + 1}`}
                    className="ml-auto h-7 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
                    disabled={disabled}
                    onClick={() => onChange(removeScenePostEffectParameterSchemaDraftV1(draft, index))}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <button
        className="mt-2 h-8 w-full border border-sky-800 bg-sky-950/50 text-xs text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
        disabled={disabled || full}
        onClick={() => onChange(appendScenePostEffectParameterSchemaDraftV1(draft))}
        type="button"
      >
        {full ? "All 8 parameter slots used" : "Add parameter"}
      </button>
    </fieldset>
  );
}
