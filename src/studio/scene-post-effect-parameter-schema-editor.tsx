import {
  appendScenePostEffectParameterSchemaDraftV1,
  moveScenePostEffectParameterSchemaDraftV1,
  removeScenePostEffectParameterSchemaDraftV1,
  SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1,
  type StudioScenePostEffectF32ParameterSchemaDraftRowV1,
  type StudioScenePostEffectParameterSchemaDraftRowV1,
  scenePostEffectHexColorToRgbV1,
  scenePostEffectParameterSchemaDraftSlotCountV1,
  scenePostEffectRgbToHexColorV1,
} from "./scene-post-effect-parameter-schema-draft";

export type ScenePostEffectParameterSchemaEditorProps = Readonly<{
  disabledReason: string | null;
  draft: readonly StudioScenePostEffectParameterSchemaDraftRowV1[];
  onChange: (draft: readonly StudioScenePostEffectParameterSchemaDraftRowV1[]) => void;
}>;

type F32DraftField = "defaultValue" | "max" | "min" | "step";

function replaceDraftName(
  draft: readonly StudioScenePostEffectParameterSchemaDraftRowV1[],
  index: number,
  name: string,
) {
  return draft.map((row, candidateIndex) => (candidateIndex === index ? { ...row, name } : row));
}

function replaceF32DraftField(
  draft: readonly StudioScenePostEffectParameterSchemaDraftRowV1[],
  index: number,
  field: F32DraftField,
  value: string,
) {
  return draft.map((row, candidateIndex) =>
    candidateIndex === index && row.type === "f32" ? { ...row, [field]: value } : row,
  );
}

function replaceRgbDraftColor(
  draft: readonly StudioScenePostEffectParameterSchemaDraftRowV1[],
  index: number,
  color: string,
) {
  const rgb = scenePostEffectHexColorToRgbV1(color);
  if (!rgb) return draft;
  return draft.map((row, candidateIndex) =>
    candidateIndex === index && row.type === "rgb"
      ? { ...row, blue: String(rgb[2]), green: String(rgb[1]), red: String(rgb[0]) }
      : row,
  );
}

const numericFields = [
  ["Default", "defaultValue"],
  ["Min", "min"],
  ["Max", "max"],
  ["Step", "step"],
] as const satisfies readonly (readonly [string, F32DraftField])[];

function F32Fields({
  disabled,
  draft,
  index,
  onChange,
  row,
  rowLabel,
}: Readonly<{
  disabled: boolean;
  draft: readonly StudioScenePostEffectParameterSchemaDraftRowV1[];
  index: number;
  onChange: ScenePostEffectParameterSchemaEditorProps["onChange"];
  row: StudioScenePostEffectF32ParameterSchemaDraftRowV1;
  rowLabel: string;
}>) {
  return numericFields.map(([label, field]) => (
    <label className="text-[10px] text-zinc-500" key={field}>
      {label}
      <input
        aria-label={`${rowLabel} ${label.toLowerCase()}`}
        className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs tabular-nums text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
        disabled={disabled}
        onChange={(event) => onChange(replaceF32DraftField(draft, index, field, event.currentTarget.value))}
        step="any"
        type="number"
        value={row[field]}
      />
    </label>
  ));
}

export function ScenePostEffectParameterSchemaEditor({
  disabledReason,
  draft,
  onChange,
}: ScenePostEffectParameterSchemaEditorProps) {
  const disabled = disabledReason !== null;
  const usedSlots = scenePostEffectParameterSchemaDraftSlotCountV1(draft);
  const full = usedSlots >= SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1.length;
  const rgbFull = usedSlots > SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1.length - 3;
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
          Map scalar and RGB controls to the eight fixed Scene effect host slots.
        </p>
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">
          {usedSlots} / {SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1.length}
        </span>
      </div>

      {disabledReason ? (
        <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-500" id={disabledReasonId} role="status">
          {disabledReason}
        </p>
      ) : null}

      {draft.length === 0 ? (
        <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
          No parameters are declared. Add a scalar or color control for WGSL or GLSL.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {draft.map((row, index) => {
            const offset = scenePostEffectParameterSchemaDraftSlotCountV1(draft.slice(0, index));
            const width = row.type === "rgb" ? 3 : 1;
            const slots = SCENE_POST_EFFECT_PARAMETER_HOST_SLOTS_V1.slice(offset, offset + width).join(", ");
            const rowLabel = `Scene effect parameter ${index + 1}`;
            return (
              <section aria-label={rowLabel} className="border border-zinc-800 p-2" key={`${row.type}/${index}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium text-zinc-400">
                    Parameter {index + 1} · {row.type === "rgb" ? "Color" : "Scalar"}
                  </span>
                  <code className="text-right text-[10px] text-zinc-600">{slots}</code>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="text-[10px] text-zinc-500">
                    Name
                    <input
                      aria-label={`${rowLabel} name`}
                      className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
                      disabled={disabled}
                      maxLength={40}
                      onChange={(event) => onChange(replaceDraftName(draft, index, event.currentTarget.value))}
                      placeholder={row.type === "rgb" ? "Tint" : "Amount"}
                      value={row.name}
                    />
                  </label>
                  {row.type === "rgb" ? (
                    <label className="text-[10px] text-zinc-500">
                      Default
                      <input
                        aria-label={`${rowLabel} default color`}
                        className="mt-1 h-8 w-full cursor-pointer border border-zinc-700 bg-zinc-950 p-1 disabled:cursor-not-allowed"
                        disabled={disabled}
                        onChange={(event) => onChange(replaceRgbDraftColor(draft, index, event.currentTarget.value))}
                        type="color"
                        value={scenePostEffectRgbToHexColorV1([Number(row.red), Number(row.green), Number(row.blue)])}
                      />
                    </label>
                  ) : (
                    <F32Fields
                      disabled={disabled}
                      draft={draft}
                      index={index}
                      onChange={onChange}
                      row={row}
                      rowLabel={rowLabel}
                    />
                  )}
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

      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          className="h-8 border border-sky-800 bg-sky-950/50 text-xs text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
          disabled={disabled || full}
          onClick={() => onChange(appendScenePostEffectParameterSchemaDraftV1(draft))}
          type="button"
        >
          {full ? "All 8 parameter slots used" : "Add parameter"}
        </button>
        <button
          className="h-8 border border-sky-800 bg-sky-950/50 text-xs text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
          disabled={disabled || rgbFull}
          onClick={() => onChange(appendScenePostEffectParameterSchemaDraftV1(draft, "rgb"))}
          type="button"
        >
          {rgbFull ? "3 contiguous slots required" : "Add color parameter"}
        </button>
      </div>
    </fieldset>
  );
}
