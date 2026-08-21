import { z } from "zod";

import { loadPoietraWasmModule } from "./poietra-wasm-module";

const decoder = new TextDecoder();

export const studioSvgPathAssetInspectionSchema = z
  .object({
    dimensions: z
      .object({
        height: z.number().finite().positive(),
        width: z.number().finite().positive(),
      })
      .strict(),
    hasFill: z.boolean(),
    hasStroke: z.boolean(),
    segmentCount: z.number().int().positive().max(8_192),
    subpathCount: z.number().int().positive().max(128),
  })
  .strict();

export type StudioSvgPathAssetInspection = z.infer<typeof studioSvgPathAssetInspectionSchema>;

type SvgPathAssetBindings = Readonly<{
  inspectStudioSvgPathAssetV1: (source: string) => Uint8Array;
}>;

let bindingsPromise: Promise<SvgPathAssetBindings> | null = null;

async function loadBindings(): Promise<SvgPathAssetBindings> {
  if (bindingsPromise) return bindingsPromise;
  const pending = loadPoietraWasmModule().then((candidate) => {
    if (typeof candidate.inspectStudioSvgPathAssetV1 !== "function") {
      throw new Error("The Poietra WASM module does not export SVG path asset inspection.");
    }
    return {
      inspectStudioSvgPathAssetV1:
        candidate.inspectStudioSvgPathAssetV1 as SvgPathAssetBindings["inspectStudioSvgPathAssetV1"],
    };
  });
  bindingsPromise = pending;
  return pending;
}

/** Returns only Rust-owned metadata; SVG geometry never gets parsed or evaluated in TypeScript. */
export async function inspectStudioSvgPathAsset(source: string): Promise<StudioSvgPathAssetInspection> {
  const bindings = await loadBindings();
  const response = bindings.inspectStudioSvgPathAssetV1(source);
  return studioSvgPathAssetInspectionSchema.parse(JSON.parse(decoder.decode(response)) as unknown);
}
