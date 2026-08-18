import { useState } from "react";

import { MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1 } from "../engine/fragment-material-registry";

export function FragmentMaterialEditor({
  active,
  assigned,
  available,
  compileError,
  entityId,
  onApply,
  onRemove,
  source,
}: Readonly<{
  active: boolean;
  assigned: boolean;
  available: boolean;
  compileError: string | null;
  entityId: string | null;
  onApply: (source: string) => void;
  onRemove: () => void;
  source: string;
}>) {
  const [inputError, setInputError] = useState<string | null>(null);
  return (
    <section className="mt-4 border-t border-zinc-800 pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-zinc-300">Fragment material</h3>
        <span className="text-[10px] text-zinc-500">
          {compileError ? "Rejected" : active ? "Active" : assigned ? "Validating…" : "Off"}
        </span>
      </div>
      <p className="mt-1 text-pretty text-[10px] leading-4 text-zinc-600">
        Fragment-only WGSL. The host owns geometry, blending, uniforms, and the <code>fs_main</code> entry point.
      </p>
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
          onApply(value);
        }}
      >
        <textarea
          aria-label="Fragment material WGSL source"
          className="h-52 w-full resize-y border border-zinc-700 bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-300 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:text-zinc-700"
          defaultValue={source}
          disabled={!available}
          key={`${entityId ?? "none"}/${source}`}
          name="wgsl"
          required
          spellCheck={false}
        />
        <div className="mt-2 flex gap-2">
          <button
            className="h-8 flex-1 border border-sky-800 bg-sky-950/50 text-xs text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
            disabled={!available}
            type="submit"
          >
            Apply
          </button>
          <button
            className="h-8 border border-zinc-700 px-3 text-xs text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!assigned}
            onClick={onRemove}
            type="button"
          >
            Remove
          </button>
        </div>
      </form>
      {!available ? (
        <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
          Select a vector object with an existing fill.
        </p>
      ) : null}
      {inputError || compileError ? (
        <p className="mt-2 whitespace-pre-wrap break-words border border-red-950 bg-red-950/20 p-2 font-mono text-[10px] leading-4 text-red-300">
          {inputError ?? compileError}
        </p>
      ) : null}
    </section>
  );
}
