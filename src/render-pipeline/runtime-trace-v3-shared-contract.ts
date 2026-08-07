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
