import { z } from "zod";

import { loadPoietraWasmModule } from "./poietra-wasm-module";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();

export const studioCubicBezierSpecSchema = z
  .object({
    arrowEnd: z.boolean(),
    control1: pointSchema,
    control2: pointSchema,
    end: pointSchema,
    start: pointSchema,
    strokeCap: z.enum(["butt", "round", "square"]),
    strokeWidth: z.number().finite().min(0.005).max(0.5),
  })
  .strict();

export const studioCubicBezierInspectionSchema = z
  .object({
    centerOffset: pointSchema,
    cubicBezier: studioCubicBezierSpecSchema,
    dimensions: z
      .object({
        height: z.number().finite().positive().optional(),
        width: z.number().finite().positive().optional(),
      })
      .strict()
      .refine((dimensions) => dimensions.height !== undefined || dimensions.width !== undefined),
  })
  .strict();

export type StudioCubicBezierSpec = z.infer<typeof studioCubicBezierSpecSchema>;
export type StudioCubicBezierInspection = z.infer<typeof studioCubicBezierInspectionSchema>;
export type StudioCubicBezierPointName = "control1" | "control2" | "end" | "start";

type CubicBezierBindings = Readonly<{
  inspectStudioCubicBezierV1: (commandJson: Uint8Array) => Uint8Array;
}>;

let bindingsPromise: Promise<CubicBezierBindings> | null = null;

async function loadBindings(): Promise<CubicBezierBindings> {
  if (bindingsPromise) return bindingsPromise;
  const pending = loadPoietraWasmModule().then((candidate) => {
    if (typeof candidate.inspectStudioCubicBezierV1 !== "function") {
      throw new Error("The Poietra WASM module does not export cubic Bézier normalization.");
    }
    return {
      inspectStudioCubicBezierV1:
        candidate.inspectStudioCubicBezierV1 as CubicBezierBindings["inspectStudioCubicBezierV1"],
    };
  });
  bindingsPromise = pending;
  return pending;
}

/** Normalizes four authoring points without exposing CubicPath evaluation to TypeScript. */
export async function inspectStudioCubicBezier(input: StudioCubicBezierSpec): Promise<StudioCubicBezierInspection> {
  const command = studioCubicBezierSpecSchema.parse(input);
  const bindings = await loadBindings();
  const response = bindings.inspectStudioCubicBezierV1(encoder.encode(JSON.stringify(command)));
  return studioCubicBezierInspectionSchema.parse(JSON.parse(decoder.decode(response)) as unknown);
}
