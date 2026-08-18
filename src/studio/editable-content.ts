import { canonicalTextOutlineInputV1, MAX_TEXT_OUTLINE_SCALARS } from "../engine/mathtex-outline";
import type { EntityContent } from "./model";

export type EditableContentType = "MathTex" | "Text";

export const UNKNOWN_EDITABLE_CONTENT = "__poietra_unknown_editable_content__" as const;

const CONTENT_KEYS = new Set(["displayLines", "label", "texParts", "text"]);
const MAX_CONTENT_LENGTH = 2_000;
const MAX_DISPLAY_LINES = 2_000;
const MAX_MATHTEX_PARTS = 16;
export const STUDIO_CREATION_TEXT_MAX_LENGTH = MAX_TEXT_OUTLINE_SCALARS;
export const STUDIO_CREATION_TEXT_CONTRACT =
  "Text accepts visible Unicode text of at most 256 scalars, 8 lines, and 128 scalars per line.";

/**
 * Accepts only the exact, round-trippable content shape used by Inspector edits.
 * Keeping this contract shared prevents validation, Python lowering, and import
 * markers from assigning different meanings to the same Canonical operation.
 */
export function canonicalEditableContent(value: unknown, type: EditableContentType): EntityContent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (!Object.keys(record).every((key) => CONTENT_KEYS.has(key))) return null;
  if (
    !Array.isArray(record.displayLines) ||
    record.displayLines.length === 0 ||
    record.displayLines.length > MAX_DISPLAY_LINES ||
    !record.displayLines.every((line) => typeof line === "string" && line.length <= MAX_CONTENT_LENGTH) ||
    record.displayLines.reduce((length, line) => length + line.length, 0) > MAX_CONTENT_LENGTH ||
    (record.label !== undefined && (typeof record.label !== "string" || record.label.length > MAX_CONTENT_LENGTH))
  )
    return null;

  if (type === "Text") {
    const text = canonicalTextOutlineInputV1(record.text);
    if (text === null || record.texParts !== undefined) return null;
    return {
      displayLines: text.split("\n"),
      ...(typeof record.label === "string" ? { label: record.label.replaceAll("\r\n", "\n") } : {}),
      text,
    } as EntityContent;
  } else {
    if (
      record.text !== undefined ||
      !Array.isArray(record.texParts) ||
      record.texParts.length === 0 ||
      record.texParts.length > MAX_MATHTEX_PARTS ||
      !record.texParts.every(
        (part) => typeof part === "string" && part.trim().length > 0 && part.length <= MAX_CONTENT_LENGTH,
      ) ||
      record.texParts.reduce((length, part) => length + part.length, 0) > MAX_CONTENT_LENGTH
    )
      return null;
  }
  return value as EntityContent;
}

/** The bounded LF-canonical text shared by browser outlining, Rust creation, and Python export. */
export function studioCreationText(value: unknown): string | null {
  const content = canonicalEditableContent(value, "Text");
  return content?.text ?? null;
}
