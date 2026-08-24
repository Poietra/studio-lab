import { z } from "zod";

import { loadPoietraWasmModule } from "./poietra-wasm-module";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const studioCubicBezierContinuationSegmentSchema = z
  .object({
    control1: pointSchema,
    control2: pointSchema,
    end: pointSchema,
  })
  .strict();

export const studioCubicBezierSpecSchema = z
  .object({
    arrowEnd: z.boolean(),
    control1: pointSchema,
    control2: pointSchema,
    continuationSegments: z.array(studioCubicBezierContinuationSegmentSchema).max(7).optional(),
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

export type StudioCubicBezierPoint = Readonly<{ x: number; y: number }>;
export type StudioCubicBezierContinuationSegment = Readonly<{
  control1: StudioCubicBezierPoint;
  control2: StudioCubicBezierPoint;
  end: StudioCubicBezierPoint;
}>;
export type StudioCubicBezierSpec = Readonly<{
  arrowEnd: boolean;
  control1: StudioCubicBezierPoint;
  control2: StudioCubicBezierPoint;
  continuationSegments?: readonly StudioCubicBezierContinuationSegment[];
  end: StudioCubicBezierPoint;
  start: StudioCubicBezierPoint;
  strokeCap: "butt" | "round" | "square";
  strokeWidth: number;
}>;
export type StudioCubicBezierInspection = Readonly<{
  centerOffset: StudioCubicBezierPoint;
  cubicBezier: StudioCubicBezierSpec;
  dimensions: Readonly<{ height?: number; width?: number }>;
}>;
export type StudioCubicBezierPointRef =
  | Readonly<{ kind: "start" }>
  | Readonly<{
      kind: "segment";
      point: "control1" | "control2" | "end";
      segmentIndex: number;
    }>;

type CubicBezierBindings = Readonly<{
  inspectStudioCubicBezierV1: (commandJson: Uint8Array) => Uint8Array;
}>;

let bindingsPromise: Promise<CubicBezierBindings> | null = null;

async function loadBindings(): Promise<CubicBezierBindings> {
  if (bindingsPromise) return bindingsPromise;
  const pending = loadPoietraWasmModule().then((candidate) => {
    if (typeof candidate.inspectStudioCubicBezierV1 !== "function") {
      throw new Error("The Poietra WASM module does not export cubic Bézier authoring.");
    }
    return {
      inspectStudioCubicBezierV1:
        candidate.inspectStudioCubicBezierV1 as CubicBezierBindings["inspectStudioCubicBezierV1"],
    };
  });
  bindingsPromise = pending;
  return pending;
}

/** Normalizes one bounded authoring path without exposing CubicPath evaluation to TypeScript. */
export async function inspectStudioCubicBezier(input: StudioCubicBezierSpec): Promise<StudioCubicBezierInspection> {
  const command = studioCubicBezierSpecSchema.parse(input);
  const bindings = await loadBindings();
  const response = bindings.inspectStudioCubicBezierV1(encoder.encode(JSON.stringify(command)));
  return studioCubicBezierInspectionSchema.parse(JSON.parse(decoder.decode(response)) as unknown);
}

/** Appends one normalized segment through the canonical Rust authoring authority. */
export async function extendStudioCubicBezier(
  input: Readonly<{
    cubicBezier: StudioCubicBezierSpec;
    end: Readonly<{ x: number; y: number }>;
  }>,
): Promise<StudioCubicBezierInspection> {
  const cubicBezier = studioCubicBezierSpecSchema.parse(input.cubicBezier);
  const end = pointSchema.parse(input.end);
  const bindings = await loadBindings();
  const response = bindings.inspectStudioCubicBezierV1(
    encoder.encode(
      JSON.stringify({
        action: "extend",
        cubicBezier,
        end,
      }),
    ),
  );
  return studioCubicBezierInspectionSchema.parse(JSON.parse(decoder.decode(response)) as unknown);
}
