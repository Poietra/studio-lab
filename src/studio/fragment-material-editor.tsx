import { useState } from "react";

import {
  MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1,
  MAX_PROJECT_FRAGMENT_MATERIALS_V1,
} from "../engine/fragment-material-registry";
import type {
  StudioFragmentMaterialGlslSource,
  StudioFragmentMaterialParameterSchemaV1,
  StudioFragmentMaterialPresetId,
} from "./fragment-material-authoring";

export type FragmentMaterialEditorItem = Readonly<{
  assignmentCount: number;
  glslSource: StudioFragmentMaterialGlslSource | null;
  name: string;
  parameterSchema: StudioFragmentMaterialParameterSchemaV1;
  revision: number;
  shaderId: string;
  source: string;
  textureSlot?: "texture2d";
}>;

export function fragmentMaterialsMatchingName(
  materials: readonly FragmentMaterialEditorItem[],
  query: string,
): readonly FragmentMaterialEditorItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return materials;
  return materials.filter(({ name }) => name.toLowerCase().includes(normalizedQuery));
}

export function FragmentMaterialEditor({
  active,
  assignedParameters,
  assignedShaderId,
  assignedTexture,
  available,
  compileError,
  materials,
  onAssign,
  onCreate,
  onCreatePreset,
  onCreateTexturePreset,
  onDuplicate,
  onImportGlsl,
  onRemoveAsset,
  onRename,
  onUpdateSource,
  onUpdateParameter,
  onUpdateTexture,
  textureAssets,
}: Readonly<{
  active: boolean;
  assignedParameters: readonly number[] | null;
  assignedShaderId: string | null;
  assignedTexture: Readonly<{
    asset: Readonly<{ assetId: string; sha256: string }>;
    sampler: "linear" | "nearest";
  }> | null;
  available: boolean;
  compileError: string | null;
  materials: readonly FragmentMaterialEditorItem[];
  onAssign: (shaderId: string | null) => void;
  onCreate: (name: string) => string | null;
  onCreatePreset: (preset: StudioFragmentMaterialPresetId) => string | null;
  onCreateTexturePreset: () => string | null;
  onDuplicate: (shaderId: string) => string | null;
  onImportGlsl: (shaderId: string, input: Readonly<{ entryPoint: "main"; source: string }>) => Promise<void>;
  onRemoveAsset: (shaderId: string) => void;
  onRename: (shaderId: string, name: string) => void;
  onUpdateSource: (shaderId: string, source: string) => void;
  onUpdateParameter: (name: string, value: number) => void;
  onUpdateTexture: (assetId: string, sampler: "linear" | "nearest") => void;
  textureAssets: readonly Readonly<{ assetId: string; label: string }>[];
}>) {
  const [inputError, setInputError] = useState<string | null>(null);
  const [materialSearchQuery, setMaterialSearchQuery] = useState("");
  const [editingShaderId, setEditingShaderId] = useState<string | null>(
    () => assignedShaderId ?? materials[0]?.shaderId ?? null,
  );
  const effectiveEditingShaderId = materials.some(({ shaderId }) => shaderId === editingShaderId)
    ? editingShaderId
    : assignedShaderId && materials.some(({ shaderId }) => shaderId === assignedShaderId)
      ? assignedShaderId
      : (materials[0]?.shaderId ?? null);
  const editingMaterial = materials.find(({ shaderId }) => shaderId === effectiveEditingShaderId) ?? null;
  const assignedMaterial = materials.find(({ shaderId }) => shaderId === assignedShaderId) ?? null;
  const assigned = assignedShaderId !== null;
  const matchingMaterials = fragmentMaterialsMatchingName(materials, materialSearchQuery);
  const editingMaterialMatches = editingMaterial
    ? matchingMaterials.some(({ shaderId }) => shaderId === editingMaterial.shaderId)
    : false;

  return (
    <section className="mt-4 border-t border-zinc-800 pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-balance text-xs font-medium text-zinc-300">Fragment materials</h3>
        <span className="text-[10px] text-zinc-500">
          {compileError ? "Rejected" : active ? "Active" : assigned ? "Assigned" : "Off"}
        </span>
      </div>
      <p className="mt-1 text-pretty text-[10px] leading-4 text-zinc-600">
        Project-local shader assets compile to canonical WGSL. Scene IR stores only the selected material reference.
      </p>

      <label className="mt-3 block text-[10px] font-medium text-zinc-500" htmlFor="fragment-material-assignment">
        Object material
      </label>
      <select
        aria-label="Assigned fragment material"
        className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
        disabled={!available && !assigned}
        id="fragment-material-assignment"
        onChange={(event) => onAssign(event.currentTarget.value || null)}
        value={assignedShaderId ?? ""}
      >
        <option value="">None</option>
        {materials.map((material) => (
          <option disabled={!available} key={material.shaderId} value={material.shaderId}>
            {material.name}
          </option>
        ))}
      </select>
      {!available ? (
        <p className="mt-1 text-pretty text-[10px] leading-4 text-zinc-600">
          Select a vector object with an existing fill to assign a material.
        </p>
      ) : null}

      {assignedMaterial && assignedParameters ? (
        assignedMaterial.parameterSchema.length > 0 ? (
          <fieldset className="mt-3 border border-zinc-800 p-2" aria-label="Material parameters">
            <legend className="px-1 text-[10px] font-medium text-zinc-400">Object parameters</legend>
            <div className="space-y-2">
              {assignedMaterial.parameterSchema.map((parameter, index) => {
                const value = assignedParameters[index] ?? parameter.default;
                return (
                  <label className="block" key={parameter.name}>
                    <span className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                      <span>{parameter.name}</span>
                      <output>{value}</output>
                    </span>
                    <input
                      aria-label={`${parameter.name} material parameter`}
                      className="mt-1 w-full accent-sky-500"
                      disabled={!available}
                      max={parameter.range.max}
                      min={parameter.range.min}
                      onChange={(event) => onUpdateParameter(parameter.name, event.currentTarget.valueAsNumber)}
                      step={parameter.range.step}
                      type="range"
                      value={value}
                    />
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
            This material does not expose object parameters.
          </p>
        )
      ) : null}

      {assignedMaterial?.textureSlot === "texture2d" ? (
        <fieldset className="mt-3 border border-zinc-800 p-2" aria-label="Material texture">
          <legend className="px-1 text-[10px] font-medium text-zinc-400">Object texture</legend>
          <label className="block text-[10px] text-zinc-500" htmlFor="fragment-material-texture-asset">
            Project PNG
          </label>
          <select
            className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
            disabled={!available || textureAssets.length === 0}
            id="fragment-material-texture-asset"
            onChange={(event) => onUpdateTexture(event.currentTarget.value, assignedTexture?.sampler ?? "linear")}
            value={assignedTexture?.asset.assetId ?? ""}
          >
            {textureAssets.length === 0 ? <option value="">No project PNG assets</option> : null}
            {textureAssets.map((asset) => (
              <option key={asset.assetId} value={asset.assetId}>
                {asset.label}
              </option>
            ))}
          </select>
          <label className="mt-2 block text-[10px] text-zinc-500" htmlFor="fragment-material-texture-filter">
            Filtering
          </label>
          <select
            className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
            disabled={!available || !assignedTexture}
            id="fragment-material-texture-filter"
            onChange={(event) =>
              assignedTexture &&
              onUpdateTexture(assignedTexture.asset.assetId, event.currentTarget.value as "linear" | "nearest")
            }
            value={assignedTexture?.sampler ?? "linear"}
          >
            <option value="linear">Linear</option>
            <option value="nearest">Nearest</option>
          </select>
        </fieldset>
      ) : null}

      <p className="mt-3 text-[10px] font-medium text-zinc-400">Built-in presets</p>
      <div className="mt-1 border border-sky-950 bg-sky-950/20 p-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-medium text-sky-200">Wave preset</p>
            <p className="mt-0.5 text-pretty text-[10px] leading-4 text-zinc-500">
              Animated color bands with Speed and Bands controls. No shader code required.
            </p>
          </div>
          <button
            className="shrink-0 border border-sky-800 bg-sky-950/50 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
            disabled={materials.length >= MAX_PROJECT_FRAGMENT_MATERIALS_V1}
            onClick={() => {
              const shaderId = onCreatePreset("wave");
              if (shaderId) setEditingShaderId(shaderId);
            }}
            type="button"
          >
            {available ? "Create & apply" : "Create"}
          </button>
        </div>
      </div>

      <div className="mt-2 border border-sky-950 bg-sky-950/20 p-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-medium text-sky-200">Gradient preset</p>
            <p className="mt-0.5 text-pretty text-[10px] leading-4 text-zinc-500">
              Directional cool-to-warm tint with Angle and Spread controls. No shader code required.
            </p>
          </div>
          <button
            className="shrink-0 border border-sky-800 bg-sky-950/50 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
            disabled={materials.length >= MAX_PROJECT_FRAGMENT_MATERIALS_V1}
            onClick={() => {
              const shaderId = onCreatePreset("gradient");
              if (shaderId) setEditingShaderId(shaderId);
            }}
            type="button"
          >
            {available ? "Create & apply" : "Create"}
          </button>
        </div>
      </div>

      <div className="mt-2 border border-sky-950 bg-sky-950/20 p-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-medium text-sky-200">Pulse preset</p>
            <p className="mt-0.5 text-pretty text-[10px] leading-4 text-zinc-500">
              Animated radial glow with Speed and Strength controls. No shader code required.
            </p>
          </div>
          <button
            className="shrink-0 border border-sky-800 bg-sky-950/50 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
            disabled={materials.length >= MAX_PROJECT_FRAGMENT_MATERIALS_V1}
            onClick={() => {
              const shaderId = onCreatePreset("pulse");
              if (shaderId) setEditingShaderId(shaderId);
            }}
            type="button"
          >
            {available ? "Create & apply" : "Create"}
          </button>
        </div>
      </div>

      <div className="mt-2 border border-sky-950 bg-sky-950/20 p-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-medium text-sky-200">Screen texture preset</p>
            <p className="mt-0.5 text-pretty text-[10px] leading-4 text-zinc-500">
              Samples one verified project PNG in top-left screen UV space through the fixed WGSL texture slot.
            </p>
          </div>
          <button
            className="shrink-0 border border-sky-800 bg-sky-950/50 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
            disabled={materials.length >= MAX_PROJECT_FRAGMENT_MATERIALS_V1}
            onClick={() => {
              const shaderId = onCreateTexturePreset();
              if (shaderId) setEditingShaderId(shaderId);
            }}
            type="button"
          >
            {available && textureAssets.length > 0 ? "Create & apply" : "Create"}
          </button>
        </div>
      </div>

      <label className="mt-3 block text-[10px] font-medium text-zinc-500" htmlFor="fragment-material-search">
        Project materials
      </label>
      <input
        aria-controls="fragment-material-asset"
        aria-describedby="fragment-material-search-status"
        aria-label="Search project materials"
        className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500"
        id="fragment-material-search"
        onChange={(event) => setMaterialSearchQuery(event.currentTarget.value)}
        placeholder="Search by name"
        type="search"
        value={materialSearchQuery}
      />
      <p className="mt-1 text-[10px] text-zinc-600" id="fragment-material-search-status" role="status">
        {materialSearchQuery.trim().length === 0
          ? `${materials.length} project material${materials.length === 1 ? "" : "s"}`
          : matchingMaterials.length === 0
            ? `No materials match “${materialSearchQuery.trim()}”.`
            : `${matchingMaterials.length} matching material${matchingMaterials.length === 1 ? "" : "s"}`}
      </p>

      <div className="mt-1.5 grid grid-cols-[1fr_auto_auto] gap-1.5">
        <select
          aria-label="Material asset"
          className="h-8 min-w-0 border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500"
          id="fragment-material-asset"
          onChange={(event) => setEditingShaderId(event.currentTarget.value || null)}
          value={effectiveEditingShaderId ?? ""}
        >
          {materials.length === 0 ? <option value="">No materials</option> : null}
          {editingMaterial && !editingMaterialMatches ? (
            <optgroup label="Currently editing">
              <option value={editingMaterial.shaderId}>{editingMaterial.name}</option>
            </optgroup>
          ) : null}
          {matchingMaterials.length > 0 ? (
            <optgroup label={materialSearchQuery.trim().length > 0 ? "Matches" : "All materials"}>
              {matchingMaterials.map((material) => (
                <option key={material.shaderId} value={material.shaderId}>
                  {material.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <button
          className="h-8 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!editingMaterial || materials.length >= MAX_PROJECT_FRAGMENT_MATERIALS_V1}
          onClick={() => {
            if (!editingMaterial) return;
            const shaderId = onDuplicate(editingMaterial.shaderId);
            if (shaderId) setEditingShaderId(shaderId);
          }}
          type="button"
        >
          Duplicate
        </button>
        <button
          className="h-8 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
          disabled={!editingMaterial || editingMaterial.assignmentCount > 0}
          onClick={() => {
            if (!editingMaterial) return;
            if (!globalThis.confirm(`Delete “${editingMaterial.name}”? This cannot be undone.`)) return;
            onRemoveAsset(editingMaterial.shaderId);
          }}
          title={
            editingMaterial && editingMaterial.assignmentCount > 0
              ? `Unassign this material from ${editingMaterial.assignmentCount} object(s) before deleting it.`
              : "Delete this material"
          }
          type="button"
        >
          Delete
        </button>
      </div>

      <form
        className="mt-1.5 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get("new-material-name") ?? "");
          const shaderId = onCreate(name);
          if (shaderId) {
            setEditingShaderId(shaderId);
            event.currentTarget.reset();
          }
        }}
      >
        <input
          aria-label="New material name"
          className="h-8 min-w-0 flex-1 border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500"
          disabled={materials.length >= MAX_PROJECT_FRAGMENT_MATERIALS_V1}
          maxLength={80}
          name="new-material-name"
          placeholder="New material name"
          required
        />
        <button
          className="h-8 border border-sky-800 bg-sky-950/50 px-3 text-xs text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
          disabled={materials.length >= MAX_PROJECT_FRAGMENT_MATERIALS_V1}
          type="submit"
        >
          Add
        </button>
      </form>

      {editingMaterial ? (
        <>
          <form
            className="mt-3 flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get("material-name") ?? "");
              onRename(editingMaterial.shaderId, name);
            }}
          >
            <input
              aria-label="Material name"
              className="h-8 min-w-0 flex-1 border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500"
              defaultValue={editingMaterial.name}
              key={`${editingMaterial.shaderId}/${editingMaterial.name}`}
              maxLength={80}
              name="material-name"
              required
            />
            <button className="h-8 border border-zinc-700 px-3 text-xs text-zinc-400 hover:bg-zinc-800" type="submit">
              Rename
            </button>
          </form>
          {editingMaterial.assignmentCount > 0 ? (
            <p className="mt-1 text-[10px] leading-4 text-zinc-600">
              Assigned to {editingMaterial.assignmentCount} object(s). Unassign all uses before deleting.
            </p>
          ) : null}
          <form
            className="mt-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = String(new FormData(event.currentTarget).get("wgsl") ?? "");
              if (new TextEncoder().encode(value).byteLength > MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1) {
                setInputError(`WGSL accepts at most ${MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1} UTF-8 bytes.`);
                return;
              }
              setInputError(null);
              onUpdateSource(editingMaterial.shaderId, value);
            }}
          >
            <textarea
              aria-label="Fragment material WGSL source"
              className="h-52 w-full resize-y border border-zinc-700 bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-300 outline-none focus:border-sky-500"
              defaultValue={editingMaterial.source}
              key={`${editingMaterial.shaderId}/${editingMaterial.revision}`}
              name="wgsl"
              required
              spellCheck={false}
            />
            <button
              className="mt-2 h-8 w-full border border-sky-800 bg-sky-950/50 text-xs text-sky-200 hover:bg-sky-900/50"
              type="submit"
            >
              Apply WGSL source
            </button>
          </form>
          {editingMaterial.textureSlot ? (
            <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
              Texture materials use canonical WGSL; the current Vulkan GLSL profile has no texture bindings.
            </p>
          ) : (
            <FragmentMaterialGlslImporter
              initialDiagnostic={editingMaterial.glslSource?.diagnostic ?? null}
              initialSource={editingMaterial.glslSource?.source ?? ""}
              key={`glsl/${editingMaterial.shaderId}/${editingMaterial.revision}/${
                editingMaterial.glslSource?.diagnostic ? "rejected" : editingMaterial.glslSource ? "accepted" : "wgsl"
              }`}
              onImport={async (input) => {
                await onImportGlsl(editingMaterial.shaderId, input);
                setInputError(null);
              }}
            />
          )}
        </>
      ) : null}
      {inputError || compileError ? (
        <p className="mt-2 whitespace-pre-wrap break-words border border-red-950 bg-red-950/20 p-2 font-mono text-[10px] leading-4 text-red-300">
          {inputError ?? compileError}
        </p>
      ) : null}
    </section>
  );
}

const GLSL_FRAGMENT_STARTER = `#version 450
layout(location = 0) in vec4 base_color;
layout(location = 1) in vec2 screen_position;
layout(location = 0) out vec4 output_color;
layout(set = 0, binding = 0, std140) uniform PoietraHost {
    vec4 viewport_and_time;
    vec4 parameters_0;
    vec4 parameters_1;
} host;

void main() {
    float wave = 0.5 + 0.5 * sin(
        6.2831853 * (screen_position.x * host.parameters_0.y + host.viewport_and_time.z * host.parameters_0.x)
    );
    output_color = vec4(base_color.rgb * wave, base_color.a);
}
`;

function FragmentMaterialGlslImporter({
  initialDiagnostic,
  initialSource,
  onImport,
}: Readonly<{
  initialDiagnostic: string | null;
  initialSource: string;
  onImport: (input: Readonly<{ entryPoint: "main"; source: string }>) => Promise<void>;
}>) {
  const [source, setSource] = useState(initialSource || GLSL_FRAGMENT_STARTER);
  const [error, setError] = useState<string | null>(initialDiagnostic);
  const [pending, setPending] = useState(false);

  return (
    <details className="mt-3 border border-zinc-800 p-2" open={initialSource.length > 0}>
      <summary className="cursor-pointer text-[10px] font-medium text-zinc-400 hover:text-zinc-200">
        Import Vulkan GLSL 450
      </summary>
      <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
        Fragment-only profile. Entry point main; locations 0/1 use base color and normalized screen position. Textures
        are not supported yet.
      </p>
      <label className="mt-2 block text-[10px] font-medium text-zinc-500" htmlFor="fragment-material-glsl-entry">
        Entry point
      </label>
      <input
        className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 font-mono text-xs text-zinc-400"
        id="fragment-material-glsl-entry"
        readOnly
        value="main"
      />
      <label className="mt-2 block text-[10px] font-medium text-zinc-500" htmlFor="fragment-material-glsl-file">
        Local .frag/.glsl file
      </label>
      <input
        accept=".frag,.glsl,text/plain"
        className="mt-1 block w-full text-[10px] text-zinc-500 file:mr-2 file:border file:border-zinc-700 file:bg-zinc-950 file:px-2 file:py-1 file:text-zinc-300 hover:file:bg-zinc-800"
        id="fragment-material-glsl-file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (!file) return;
          if (!/\.(?:frag|glsl)$/i.test(file.name)) {
            setError("Choose a .frag or .glsl file.");
            return;
          }
          if (file.size > MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1) {
            setError(`GLSL accepts at most ${MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1} UTF-8 bytes.`);
            return;
          }
          void file
            .arrayBuffer()
            .then((bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes))
            .then((value) => {
              setSource(value);
              setError(null);
            })
            .catch(() => setError("The GLSL file must be readable UTF-8 text."));
        }}
        type="file"
      />
      <form
        className="mt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (new TextEncoder().encode(source).byteLength > MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1) {
            setError(`GLSL accepts at most ${MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1} UTF-8 bytes.`);
            return;
          }
          setPending(true);
          setError(null);
          void onImport({ entryPoint: "main", source })
            .catch((caught) => {
              setError(caught instanceof Error ? caught.message : "The Rust core rejected the GLSL source.");
            })
            .finally(() => setPending(false));
        }}
      >
        <textarea
          aria-label="Vulkan GLSL fragment source"
          className="h-40 w-full resize-y border border-zinc-700 bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-300 outline-none focus:border-sky-500"
          onChange={(event) => setSource(event.currentTarget.value)}
          required
          spellCheck={false}
          value={source}
        />
        <button
          className="mt-2 h-8 w-full border border-sky-800 bg-sky-950/50 text-xs text-sky-200 hover:bg-sky-900/50 disabled:cursor-wait disabled:border-zinc-800 disabled:text-zinc-600"
          disabled={pending}
          type="submit"
        >
          {pending ? "Compiling…" : "Compile and apply GLSL"}
        </button>
      </form>
      {error ? (
        <p className="mt-2 whitespace-pre-wrap break-words border border-red-950 bg-red-950/20 p-2 font-mono text-[10px] leading-4 text-red-300">
          {error}
        </p>
      ) : null}
    </details>
  );
}
