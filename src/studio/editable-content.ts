import type { EntityContent } from "./model";

export type EditableContentType = "MathTex" | "Text";

export const UNKNOWN_EDITABLE_CONTENT = "__poietra_unknown_editable_content__" as const;

const CONTENT_KEYS = new Set(["displayLines", "label", "texParts", "text"]);
const MAX_CONTENT_LENGTH = 2_000;
const MAX_DISPLAY_LINES = 2_000;
const MAX_MATHTEX_PARTS = 16;

/**
 * Accepts only the exact, round-trippable content shape used by Inspector edits.
 * Keeping this contract shared prevents validation, Python lowering, and import
 * markers from assigning different meanings to the same Canonical operation.
 */
export function canonicalEditableContent(
  value: unknown,
  type: EditableContentType,
): EntityContent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (!Object.keys(record).every((key) => CONTENT_KEYS.has(key))) return null;
  if (
    !Array.isArray(record.displayLines)
    || record.displayLines.length === 0
    || record.displayLines.length > MAX_DISPLAY_LINES
    || !record.displayLines.every((line) => typeof line === "string" && line.length <= MAX_CONTENT_LENGTH)
    || record.displayLines.reduce((length, line) => length + line.length, 0) > MAX_CONTENT_LENGTH
    || (record.label !== undefined
      && (typeof record.label !== "string" || record.label.length > MAX_CONTENT_LENGTH))
  ) return null;

  if (type === "Text") {
    if (
      typeof record.text !== "string"
      || record.text.trim().length === 0
      || record.text.length > MAX_CONTENT_LENGTH
      || record.texParts !== undefined
    ) return null;
  } else {
    if (
      record.text !== undefined
      || !Array.isArray(record.texParts)
      || record.texParts.length === 0
      || record.texParts.length > MAX_MATHTEX_PARTS
      || !record.texParts.every((part) => (
        typeof part === "string" && part.trim().length > 0 && part.length <= MAX_CONTENT_LENGTH
      ))
      || record.texParts.reduce((length, part) => length + part.length, 0) > MAX_CONTENT_LENGTH
    ) return null;
  }
  return value as EntityContent;
}
