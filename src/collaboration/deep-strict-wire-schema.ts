import { z } from "zod";

function isPlainWireObjectV1(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownWireKeyPathsV1(
  input: unknown,
  parsed: unknown,
  path: readonly (number | string)[] = [],
): readonly (readonly (number | string)[])[] {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    return input.flatMap((value, index) => unknownWireKeyPathsV1(value, parsed[index], [...path, index]));
  }
  if (!isPlainWireObjectV1(input) || !isPlainWireObjectV1(parsed)) return [];
  return Object.keys(input).flatMap((key) =>
    Object.hasOwn(parsed, key) ? unknownWireKeyPathsV1(input[key], parsed[key], [...path, key]) : [[...path, key]],
  );
}

/** Rejects unknown object keys at every depth, including schemas that strip internally. */
export function deepStrictWireSchemaV1<Output>(schema: z.ZodType<Output>) {
  return z.unknown().transform((value, context) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: parsed.error.issues[0]?.message ?? "Wire value is invalid." });
      return z.NEVER;
    }
    const unknownPaths = unknownWireKeyPathsV1(value, parsed.data);
    for (const path of unknownPaths) {
      context.addIssue({ code: "custom", message: "Unknown wire field.", path: [...path] });
    }
    return parsed.data;
  });
}
