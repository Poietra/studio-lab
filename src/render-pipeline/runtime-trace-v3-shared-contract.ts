import { z } from "zod";

import { MAX_COORDINATE } from "../engine/contracts";

export const FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3 = 60 as const;
export const FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3 = 900 as const;
export const FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3 = 13 as const;
export const MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BINDINGS_V3 = 128;

export function canonicalFastManimRuntimeTraceSampleTimeV3(frameIndex: number) {
  return Number(
    (frameIndex / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3).toFixed(
      FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3,
    ),
  );
}

function isUnicodeScalarSequence(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const fastManimRuntimeTraceCoordinateV3Schema = z
  .number()
  .finite()
  .min(-MAX_COORDINATE)
  .max(MAX_COORDINATE)
  .refine(
    (value) => value === Number(value.toFixed(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3)),
    "Runtime Trace V3 coordinates must use the canonical 13-digit precision.",
  );

const runtimeTraceSourceBindingSpanV3Schema = z
  .object({
    endColumn: z.number().int().nonnegative().max(2_000_000),
    endLine: z.number().int().positive().max(10_000),
    startColumn: z.number().int().nonnegative().max(2_000_000),
    startLine: z.number().int().positive().max(10_000),
  })
  .strict()
  .refine(
    ({ endColumn, endLine, startColumn, startLine }) => startLine === endLine && startColumn < endColumn,
    "Runtime Trace V3 source binding spans must identify one single-line Name token.",
  );

export const fastManimRuntimeTraceSourceBindingV3Schema = z
  .object({
    id: z.string().regex(/^source-binding:[0-9a-f]{64}$/u),
    name: z
      .string()
      .min(1)
      .max(240)
      .refine(isUnicodeScalarSequence, "Runtime Trace V3 source binding names must contain Unicode scalars.")
      .refine(
        (name) => /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(name),
        "Runtime Trace V3 source binding names must be Python identifiers.",
      )
      .refine(
        (name) => name.normalize("NFKC") === name,
        "Runtime Trace V3 source binding names must use their NFKC spelling.",
      )
      .refine(
        (name) => new TextEncoder().encode(name).byteLength <= 240,
        "Runtime Trace V3 source binding names accept at most 240 UTF-8 bytes.",
      ),
    ordinal: z.number().int().positive().max(10_000),
    span: runtimeTraceSourceBindingSpanV3Schema,
  })
  .strict();

export const fastManimRuntimeTraceSourceBindingEndpointV3Schema = z
  .object({
    center: z
      .object({ x: fastManimRuntimeTraceCoordinateV3Schema, y: fastManimRuntimeTraceCoordinateV3Schema })
      .strict(),
    dimensions: z
      .object({
        height: fastManimRuntimeTraceCoordinateV3Schema.nonnegative(),
        width: fastManimRuntimeTraceCoordinateV3Schema.nonnegative(),
      })
      .strict(),
    frameIndex: z
      .number()
      .int()
      .nonnegative()
      .max(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3 - 1),
    sampleTime: fastManimRuntimeTraceCoordinateV3Schema
      .nonnegative()
      .max(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3 / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3),
  })
  .strict();

export type FastManimRuntimeTraceSourceBindingEndpointV3 = z.infer<
  typeof fastManimRuntimeTraceSourceBindingEndpointV3Schema
>;

function sampledCoordinatesMatchV3(left: number, right: number) {
  // Endpoint coordinates are canonicalized to thirteen decimals; admit that
  // decimal boundary plus binary64 noise and nothing wider.
  return Math.abs(left - right) <= Math.max(1e-12, Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right)));
}

/**
 * Names the sampled endpoint that observes a binding's constructed placement —
 * the geometry `move_to` positions and `scale` pivots about.
 *
 * A trace samples only frame zero and the settled frame, so the constructed
 * placement is never observed directly. Exactly two shapes are decidable from
 * that pair: an object complete at construction reports its placement at frame
 * zero (its box keeps its dimensions even when later animation moves it),
 * while an entrance animation such as `Write` or `Create` is still revealing
 * the object at frame zero and grows its box toward the settled placement.
 * Anything else is ambiguous, so this returns null and the caller must refuse
 * to claim where an edit lands.
 *
 * A misclassification cannot silently mislocate an edit: callers pin the
 * candidate against the endpoint named here, so naming the wrong one makes
 * that pin fail rather than admit a wrong placement.
 */
export function fastManimRuntimeTraceConstructedEndpointV3(
  endpoints: Readonly<{
    initial: FastManimRuntimeTraceSourceBindingEndpointV3;
    terminal: FastManimRuntimeTraceSourceBindingEndpointV3;
  }>,
): "initial" | "terminal" | null {
  const { initial, terminal } = endpoints;
  const sampled = [
    initial.center.x,
    initial.center.y,
    initial.dimensions.height,
    initial.dimensions.width,
    terminal.center.x,
    terminal.center.y,
    terminal.dimensions.height,
    terminal.dimensions.width,
  ];
  if (!sampled.every(Number.isFinite)) return null;
  if (
    sampledCoordinatesMatchV3(initial.center.x, terminal.center.x) &&
    sampledCoordinatesMatchV3(initial.center.y, terminal.center.y)
  ) {
    return "initial";
  }
  if (
    sampledCoordinatesMatchV3(initial.dimensions.height, terminal.dimensions.height) &&
    sampledCoordinatesMatchV3(initial.dimensions.width, terminal.dimensions.width)
  ) {
    return "initial";
  }
  if (terminal.dimensions.height > initial.dimensions.height && terminal.dimensions.width > initial.dimensions.width) {
    return "terminal";
  }
  return null;
}
