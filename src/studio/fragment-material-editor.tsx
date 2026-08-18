import { useState } from "react";

import {
  MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1,
  MAX_PROJECT_FRAGMENT_MATERIALS_V1,
} from "../engine/fragment-material-registry";

export type FragmentMaterialEditorItem = Readonly<{
  assignmentCount: number;
  name: string;
  revision: number;
  shaderId: string;
  source: string;
}>;

export function FragmentMaterialEditor({
  active,
  assignedShaderId,
  available,
  compileError,
  materials,
  onAssign,
  onCreate,
  onDuplicate,
  onRemoveAsset,
  onRename,
  onUpdateSource,
}: Readonly<{
  active: boolean;
  assignedShaderId: string | null;
  available: boolean;
  compileError: string | null;
  materials: readonly FragmentMaterialEditorItem[];
  onAssign: (shaderId: string | null) => void;
  onCreate: (name: string) => string | null;
  onDuplicate: (shaderId: string) => string | null;
  onRemoveAsset: (shaderId: string) => void;
  onRename: (shaderId: string, name: string) => void;
  onUpdateSource: (shaderId: string, source: string) => void;
}>) {
  const [inputError, setInputError] = useState<string | null>(null);
  const [editingShaderId, setEditingShaderId] = useState<string | null>(
    () => assignedShaderId ?? materials[0]?.shaderId ?? null,
  );
  const effectiveEditingShaderId = materials.some(({ shaderId }) => shaderId === editingShaderId)
    ? editingShaderId
    : assignedShaderId && materials.some(({ shaderId }) => shaderId === assignedShaderId)
      ? assignedShaderId
      : (materials[0]?.shaderId ?? null);
  const editingMaterial = materials.find(({ shaderId }) => shaderId === effectiveEditingShaderId) ?? null;
  const assigned = assignedShaderId !== null;

  return (
    <section className="mt-4 border-t border-zinc-800 pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-balance text-xs font-medium text-zinc-300">Fragment materials</h3>
        <span className="text-[10px] text-zinc-500">
          {compileError ? "Rejected" : active ? "Active" : assigned ? "Assigned" : "Off"}
        </span>
      </div>
      <p className="mt-1 text-pretty text-[10px] leading-4 text-zinc-600">
        Project-local WGSL assets. Scene IR stores only the selected material reference.
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

      <div className="mt-3 grid grid-cols-[1fr_auto_auto] gap-1.5">
        <select
          aria-label="Material asset"
          className="h-8 min-w-0 border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500"
          onChange={(event) => setEditingShaderId(event.currentTarget.value || null)}
          value={effectiveEditingShaderId ?? ""}
        >
          {materials.length === 0 ? <option value="">No materials</option> : null}
          {materials.map((material) => (
            <option key={material.shaderId} value={material.shaderId}>
              {material.name}
            </option>
          ))}
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
              Apply source
            </button>
          </form>
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
