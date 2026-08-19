import katex from "katex";

import {
  STUDIO_CREATION_TEXT_CONTRACT,
  STUDIO_TEXT_DEFAULT_LAYOUT,
  studioCreationText,
  studioCreationTextContent,
} from "./editable-content";
import type { EntityContent, EntityDimensions, Point, ProjectedEntity } from "./model";

export type InspectorEditField =
  | "content"
  | "height"
  | "radius"
  | "textAlignment"
  | "textLineHeight"
  | "width"
  | "x"
  | "y";

export type InspectorEditValues = Readonly<{
  content: string | null;
  height: string | null;
  radius: string | null;
  textAlignment: "center" | "left" | "right" | null;
  textLineHeight: string | null;
  width: string | null;
  x: string | null;
  y: string | null;
}>;

export type ValidatedInspectorEdits = Readonly<{
  content?: EntityContent;
  dimensions?: EntityDimensions;
  position?: Point;
}>;

export type InspectorEditValidation =
  | Readonly<{
      errors: Readonly<Partial<Record<InspectorEditField, string>>>;
      kind: "invalid";
    }>
  | Readonly<{
      edits: ValidatedInspectorEdits;
      kind: "valid";
    }>;

const MAX_CONTENT_LENGTH = 2_000;
const MAX_MATHTEX_PARTS = 16;
const MIN_SHAPE_SIZE = 0.1;
const NUMBER_EPSILON = 0.0005;

function changed(left: number, right: number) {
  return Math.abs(left - right) >= NUMBER_EPSILON;
}

function formattedNumber(value: number, fractionDigits: number) {
  const fixed = value.toFixed(fractionDigits);
  return changed(Number(fixed), value) ? value.toString() : fixed;
}

function parseFiniteNumber(
  value: string,
  field: InspectorEditField,
  errors: Partial<Record<InspectorEditField, string>>,
) {
  if (value.trim().length === 0) {
    errors[field] = "Enter a number.";
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors[field] = "Enter a finite number.";
    return null;
  }
  return number;
}

function validateMathTex(parts: readonly string[]) {
  try {
    katex.renderToString(parts.join(" "), {
      displayMode: false,
      maxExpand: 100,
      maxSize: 12,
      output: "htmlAndMathml",
      strict: "error",
      throwOnError: true,
      trust: false,
    });
    return null;
  } catch {
    return "MathTex contains syntax that the Studio preview cannot parse.";
  }
}

function currentContentValue(entity: ProjectedEntity) {
  if (entity.type === "Text") {
    const text = entity.content?.text ?? entity.content?.displayLines.join("\n") ?? "";
    return studioCreationText({ displayLines: text.split(/\r?\n/u), text }) ?? text;
  }
  if (entity.type === "MathTex") return (entity.content?.texParts ?? entity.content?.displayLines ?? []).join("\n");
  return null;
}

function validateContent(
  entity: ProjectedEntity,
  value: string,
  textLayout: Readonly<{ alignment: "center" | "left" | "right"; lineHeight: number }> | null,
  errors: Partial<Record<InspectorEditField, string>>,
) {
  if (entity.sourceIdentity.kind === "unknown" && !entity.transactionId) {
    errors.content = "Reimport this object with a stable source identity before editing its content.";
    return undefined;
  }
  if (value.trim().length === 0) {
    errors.content = entity.type === "MathTex" ? "Enter at least one MathTex part." : "Enter text content.";
    return undefined;
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    errors.content = `Content must contain at most ${MAX_CONTENT_LENGTH.toLocaleString()} characters.`;
    return undefined;
  }
  if (entity.type === "Text") {
    if (!textLayout) return undefined;
    const text = studioCreationText({ displayLines: value.split(/\r?\n/u), text: value, textLayout });
    if (text === null) {
      errors.content = STUDIO_CREATION_TEXT_CONTRACT;
      return undefined;
    }
    return {
      displayLines: text.split("\n"),
      label: entity.content?.label?.replaceAll("\r\n", "\n"),
      text,
      textLayout,
    } satisfies EntityContent;
  }
  const rawParts = value.split("\n");
  if (rawParts.length > MAX_MATHTEX_PARTS) {
    errors.content = `MathTex accepts at most ${MAX_MATHTEX_PARTS} parts.`;
    return undefined;
  }
  if (rawParts.some((part) => part.trim().length === 0)) {
    errors.content = "Each MathTex line must contain a non-empty part.";
    return undefined;
  }
  const texParts = rawParts.map((part) => part.trim());
  const syntaxError = validateMathTex(texParts);
  if (syntaxError) {
    errors.content = syntaxError;
    return undefined;
  }
  return {
    displayLines: [texParts.join(" ")],
    label: entity.content?.label,
    texParts,
  } satisfies EntityContent;
}

export function initialInspectorEditValues(entity: ProjectedEntity): InspectorEditValues {
  const dimensions = entity.geometry.dimensions.kind === "known" ? entity.geometry.dimensions.value : {};
  const textContent = entity.type === "Text" ? studioCreationTextContent(entity.content) : null;
  return {
    content: currentContentValue(entity),
    height: dimensions.height === undefined ? null : formattedNumber(dimensions.height, 2),
    radius: dimensions.radius === undefined ? null : formattedNumber(dimensions.radius, 2),
    textAlignment:
      textContent?.layout.alignment ?? (entity.type === "Text" ? STUDIO_TEXT_DEFAULT_LAYOUT.alignment : null),
    textLineHeight:
      entity.type === "Text"
        ? formattedNumber(textContent?.layout.lineHeight ?? STUDIO_TEXT_DEFAULT_LAYOUT.lineHeight, 2)
        : null,
    width: dimensions.width === undefined ? null : formattedNumber(dimensions.width, 2),
    x: entity.geometry.position.kind === "known" ? formattedNumber(entity.position.x, 1) : null,
    y: entity.geometry.position.kind === "known" ? formattedNumber(entity.position.y, 1) : null,
  };
}

export function validateInspectorEdits(entity: ProjectedEntity, values: InspectorEditValues): InspectorEditValidation {
  const errors: Partial<Record<InspectorEditField, string>> = {};
  const edits: {
    content?: EntityContent;
    dimensions?: EntityDimensions;
    position?: Point;
  } = {};

  if (values.x !== null && values.y !== null) {
    if (entity.geometry.position.kind === "unknown") {
      errors.x = `Position is runtime-dependent: ${entity.geometry.position.reason}`;
      errors.y = "Position editing is unavailable until x and y are known.";
    } else {
      const x = parseFiniteNumber(values.x, "x", errors);
      const y = parseFiniteNumber(values.y, "y", errors);
      if (x !== null && y !== null && (changed(x, entity.position.x) || changed(y, entity.position.y)))
        edits.position = { x, y };
    }
  }

  if (values.content !== null && (entity.type === "Text" || entity.type === "MathTex")) {
    let textLayout: Readonly<{ alignment: "center" | "left" | "right"; lineHeight: number }> | null = null;
    if (entity.type === "Text") {
      if (!values.textAlignment) errors.textAlignment = "Choose a Text alignment.";
      const lineHeight =
        values.textLineHeight === null ? null : parseFiniteNumber(values.textLineHeight, "textLineHeight", errors);
      if (lineHeight !== null && lineHeight <= 0) {
        errors.textLineHeight = "Line height must be greater than zero.";
      } else if (values.textAlignment && lineHeight !== null) {
        textLayout = { alignment: values.textAlignment, lineHeight };
      }
    }
    const currentText = studioCreationTextContent(entity.content);
    const layoutChanged =
      entity.type === "Text" &&
      textLayout !== null &&
      (currentText?.layout.alignment !== textLayout.alignment ||
        currentText?.layout.lineHeight !== textLayout.lineHeight);
    const contentChanged = values.content !== currentContentValue(entity) || layoutChanged;
    if (contentChanged) {
      const content = validateContent(entity, values.content, textLayout, errors);
      if (content) edits.content = content;
    }
  }

  if (entity.type === "Circle" && values.radius !== null) {
    if (
      entity.geometry.dimensions.kind === "unknown" ||
      entity.geometry.position.kind === "unknown" ||
      entity.geometry.scale.kind === "unknown"
    ) {
      errors.radius = "Radius editing requires known dimensions, position, and scale.";
    } else {
      const radius = parseFiniteNumber(values.radius, "radius", errors);
      if (radius !== null && radius < MIN_SHAPE_SIZE) {
        errors.radius = `Radius must be at least ${MIN_SHAPE_SIZE}.`;
      } else if (
        radius !== null &&
        (entity.geometry.dimensions.value.radius === undefined ||
          changed(radius, entity.geometry.dimensions.value.radius))
      )
        edits.dimensions = { radius };
    }
  }

  if (entity.type === "Rectangle" && values.width !== null && values.height !== null) {
    if (
      entity.geometry.dimensions.kind === "unknown" ||
      entity.geometry.position.kind === "unknown" ||
      entity.geometry.scale.kind === "unknown"
    ) {
      errors.width = "Width editing requires known dimensions, position, and scale.";
      errors.height = "Height editing requires known dimensions, position, and scale.";
    } else {
      const width = parseFiniteNumber(values.width, "width", errors);
      const height = parseFiniteNumber(values.height, "height", errors);
      if (width !== null && width < MIN_SHAPE_SIZE) errors.width = `Width must be at least ${MIN_SHAPE_SIZE}.`;
      if (height !== null && height < MIN_SHAPE_SIZE) errors.height = `Height must be at least ${MIN_SHAPE_SIZE}.`;
      if (
        width !== null &&
        height !== null &&
        errors.width === undefined &&
        errors.height === undefined &&
        (entity.geometry.dimensions.value.width === undefined ||
          entity.geometry.dimensions.value.height === undefined ||
          changed(width, entity.geometry.dimensions.value.width) ||
          changed(height, entity.geometry.dimensions.value.height))
      )
        edits.dimensions = { height, width };
    }
  }

  return Object.keys(errors).length > 0 ? { errors, kind: "invalid" } : { edits, kind: "valid" };
}
