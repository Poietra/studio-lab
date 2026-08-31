import {
  canonicalTextOutlineInputV1,
  MAX_TEXT_OUTLINE_SCALARS,
  textOutlineRequestV1Schema,
} from "../engine/mathtex-outline";
import type { EntityContent, TextLayout } from "./model";

export type EditableContentType = "MathTex" | "Text";

export const UNKNOWN_EDITABLE_CONTENT = "__poietra_unknown_editable_content__" as const;

const CONTENT_KEYS = new Set(["displayLines", "label", "texParts", "text", "textLayout"]);
const MAX_CONTENT_LENGTH = 2_000;
const MAX_DISPLAY_LINES = 2_000;
const MAX_MATHTEX_PARTS = 16;
export const STUDIO_CREATION_TEXT_MAX_LENGTH = MAX_TEXT_OUTLINE_SCALARS;
export const STUDIO_TEXT_DEFAULT_LAYOUT: TextLayout = Object.freeze({
  alignment: "left",
  fontFamily: "sans",
  fontSize: 1,
  fontWeight: "regular",
  lineHeight: 1.2,
});
export const STUDIO_CREATION_TEXT_CONTRACT =
  "Text accepts visible Unicode text of at most 256 scalars and 8 explicit lines; unwrapped lines accept at most 128 scalars.";

function canonicalTextLayout(value: unknown): TextLayout | null {
  if (value === undefined) return STUDIO_TEXT_DEFAULT_LAYOUT;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !Object.keys(record).every(
      (key) =>
        key === "alignment" ||
        key === "fontFamily" ||
        key === "fontSize" ||
        key === "fontWeight" ||
        key === "lineHeight" ||
        key === "wrapWidth",
    )
  )
    return null;
  if (record.alignment !== "left" && record.alignment !== "center" && record.alignment !== "right") return null;
  const fontFamily = record.fontFamily ?? STUDIO_TEXT_DEFAULT_LAYOUT.fontFamily;
  if (fontFamily !== "mono" && fontFamily !== "sans") return null;
  const fontSize = record.fontSize ?? STUDIO_TEXT_DEFAULT_LAYOUT.fontSize;
  if (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize <= 0) return null;
  const fontWeight = record.fontWeight ?? STUDIO_TEXT_DEFAULT_LAYOUT.fontWeight;
  if (fontWeight !== "bold" && fontWeight !== "regular") return null;
  if (typeof record.lineHeight !== "number" || !Number.isFinite(record.lineHeight) || record.lineHeight <= 0)
    return null;
  const wrapWidth = record.wrapWidth;
  if (wrapWidth !== undefined && (typeof wrapWidth !== "number" || !Number.isFinite(wrapWidth) || wrapWidth <= 0))
    return null;
  return {
    alignment: record.alignment,
    fontFamily,
    fontSize,
    fontWeight,
    lineHeight: record.lineHeight,
    ...(wrapWidth === undefined ? {} : { wrapWidth }),
  };
}

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
    const textLayout = canonicalTextLayout(record.textLayout);
    if (textLayout === null || record.texParts !== undefined) return null;
    const wrappedRequest =
      textLayout.wrapWidth === undefined
        ? null
        : textOutlineRequestV1Schema.safeParse({
            layout: {
              alignment: textLayout.alignment,
              fontFamily: textLayout.fontFamily,
              fontWeight: textLayout.fontWeight,
              lineHeight: textLayout.lineHeight,
              wrapWidthEm: textLayout.wrapWidth / textLayout.fontSize,
            },
            schema: "poietra.text-outline-request",
            text: record.text,
            version: 1,
          });
    const text =
      wrappedRequest === null
        ? canonicalTextOutlineInputV1(record.text)
        : wrappedRequest.success
          ? wrappedRequest.data.text
          : null;
    if (text === null) return null;
    return {
      displayLines: text.split("\n"),
      ...(typeof record.label === "string" ? { label: record.label.replaceAll("\r\n", "\n") } : {}),
      text,
      textLayout,
    } as EntityContent;
  } else {
    if (
      record.text !== undefined ||
      record.textLayout !== undefined ||
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

/** The bounded LF/NFC-canonical text shared by browser outlining, Rust creation, and Python export. */
export function studioCreationText(value: unknown): string | null {
  const content = canonicalEditableContent(value, "Text");
  return content?.text ?? null;
}

/** The complete semantic Text input admitted by the Rust authoring and layout authorities. */
export function studioCreationTextContent(value: unknown): Readonly<{ layout: TextLayout; text: string }> | null {
  const content = canonicalEditableContent(value, "Text");
  return content?.text && content.textLayout ? { layout: content.textLayout, text: content.text } : null;
}
