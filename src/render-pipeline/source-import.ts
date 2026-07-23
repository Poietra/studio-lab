import { createHash } from "node:crypto";
import { z } from "zod";

import { analyzePythonSource, isPythonStatementStart, isStandalonePythonComment } from "./python-source-analysis";
import {
  STUDIO_STATE_VERSION,
  type EntityContent,
  type EntityDimensions,
  type EntityGeometryKnowledge,
  type EntityStyle,
  type Interval,
  type Knowledge,
  type Point,
  type PropertyChannel,
  type PropertyChannelSample,
  type RuntimeEntity,
  type RuntimeSceneState,
  type StaticSemanticState,
  type TimelineEvent,
} from "../studio/model";

export type ImportedManimEntity = Readonly<{
  id: string;
  initialization: string;
  sourceVariable: string;
}>;

export type ImportedManimScene = Readonly<{
  anchors: readonly number[];
  initialVisibleSourceVariables: readonly string[];
  initialization: readonly string[];
  name: string;
  runtimeSceneState: RuntimeSceneState;
  sceneId: string;
  sourceHash: string;
  sourceVariables: Readonly<Record<string, string>>;
  staticSemanticState: StaticSemanticState;
}>;

export type SourceSceneBlock = Readonly<{
  bodyEnd: number;
  bodyIndent: number | null;
  bodyStart: number;
  classLine: number;
  lines: readonly string[];
  name: string;
}>;

export class AmbiguousSourceSceneError extends Error {
  readonly classLines: readonly number[];
  readonly sceneName: string;
  readonly sourcePath: string;

  constructor(sourcePath: string, sceneName: string, classLines: readonly number[]) {
    const definitionLines = classLines.map((line) => line + 1);
    super(
      `Cannot import Scene "${sceneName}" from ${sourcePath}: duplicate Scene class definitions were found at lines ${definitionLines.join(", ")}. Rename or remove the duplicate definitions before editing.`,
    );
    this.name = "AmbiguousSourceSceneError";
    this.classLines = definitionLines;
    this.sceneName = sceneName;
    this.sourcePath = sourcePath;
  }
}

type MutableEntity = {
  content?: EntityContent;
  dimensions: Knowledge<EntityDimensions>;
  id: string;
  initialization: string;
  lifetimes: Array<{ end: number | null; start: number }>;
  position: Point;
  positionKnowledge: Knowledge<Point>;
  relation?: Readonly<{ direction: "DOWN" | "LEFT" | "RIGHT" | "UP"; target: string }>;
  scale: number;
  scaleKnowledge: Knowledge<number>;
  sourceVariable: string;
  style: Knowledge<EntityStyle>;
  type: string;
};

type SourceStatement = Readonly<{
  line: number;
  text: string;
}>;

const CLASS_PATTERN = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*Scene[^)]*)\)\s*:/;
const ASSIGNMENT_PREFIX_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const SUPPORTED_TYPES = new Set([
  "Arrow",
  "Circle",
  "Dot",
  "Group",
  "Line",
  "MathTex",
  "Rectangle",
  "RegularPolygon",
  "Square",
  "SurroundingRectangle",
  "Text",
  "VGroup",
]);
const ENTITY_MARKER_PATTERN = /^\s*#\s*poietra:entity\s+(.+)\s*$/;
const ANCHOR_PATTERN = /^\s*#\s*poietra:anchor\s+([0-9]+(?:\.[0-9]+)?)\s*$/;
const CURSOR_PATTERN = /^\s*#\s*poietra:cursor\s+([0-9]+(?:\.[0-9]+)?)\s*$/;
const SCENE_BOUNDARY_PATTERN = /^\s*#\s*poietra:scene-boundary\s+(.+)\s*$/;
// Studio-emitted v1 markers are authoritative 640x360 geometry metadata, not Python facts.
const POSITION_MARKER_PATTERN = /^\s*#\s*poietra:position(?:\s+(.*))?\s*$/;
const MOTION_MARKER_PATTERN = /^\s*#\s*poietra:motion(?:\s+(.*))?\s*$/;
const SCALE_MARKER_PATTERN = /^\s*#\s*poietra:scale(?:\s+(.*))?\s*$/;
const identifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const markerPointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const positionMarkerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("absolute"),
      value: markerPointSchema,
      variable: identifierSchema,
      version: z.literal(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("relative"),
      offset: markerPointSchema,
      relativeTo: identifierSchema,
      variable: identifierSchema,
      version: z.literal(1),
    })
    .strict(),
]);
const motionMarkerSchema = z
  .object({
    motions: z
      .array(
        z
          .object({
            controlOffset: markerPointSchema.optional(),
            delta: markerPointSchema,
            variables: z.array(identifierSchema).min(1).max(128),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    version: z.literal(1),
  })
  .strict();
const positiveScaleSchema = z.number().finite().positive();
const scaleMarkerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact"),
      value: positiveScaleSchema,
      variable: identifierSchema,
      version: z.literal(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("animated"),
      scales: z
        .array(
          z
            .object({
              from: positiveScaleSchema,
              to: positiveScaleSchema,
              variable: identifierSchema,
            })
            .strict(),
        )
        .min(1)
        .max(128),
      version: z.literal(1),
    })
    .strict(),
]);

function hashSource(source: string) {
  return createHash("sha256").update(source).digest("hex");
}

function blockEnd(
  lines: ReturnType<typeof analyzePythonSource>["lines"],
  start: number,
  limit: number,
  parentIndent: number,
) {
  for (let index = start; index < limit; index += 1) {
    const line = lines[index];
    if (line && isPythonStatementStart(line) && line.indentation <= parentIndent) return index;
  }
  return limit;
}

function suiteIndent(
  lines: ReturnType<typeof analyzePythonSource>["lines"],
  start: number,
  limit: number,
  parentIndent: number,
) {
  const indentation = lines
    .slice(start, limit)
    .filter((line) => isPythonStatementStart(line) && line.indentation > parentIndent)
    .map((line) => line.indentation);
  return indentation.length > 0 ? Math.min(...indentation) : null;
}

export function findSceneBlocks(source: string): readonly SourceSceneBlock[] {
  const analysis = analyzePythonSource(source);
  if (!analysis.valid) return [];
  const rawLines = source.split(/\r?\n/);
  const classes = analysis.lines.flatMap((line, index) => {
    const match = isPythonStatementStart(line) && line.indentation === 0 ? line.code.match(CLASS_PATTERN) : null;
    return match ? [{ classLine: index, indent: line.indentation, name: match[1] }] : [];
  });
  return classes.map((entry) => {
    const classEnd = blockEnd(analysis.lines, entry.classLine + 1, analysis.lines.length, entry.indent);
    const classBodyIndent = suiteIndent(analysis.lines, entry.classLine + 1, classEnd, entry.indent);
    const constructLine = analysis.lines.findIndex(
      (line, index) =>
        index > entry.classLine &&
        index < classEnd &&
        classBodyIndent !== null &&
        isPythonStatementStart(line) &&
        line.indentation === classBodyIndent &&
        /^\s*def\s+construct\s*\(\s*self\s*\)\s*:/.test(line.code),
    );
    if (constructLine < 0) {
      return {
        bodyEnd: classEnd,
        bodyIndent: null,
        bodyStart: classEnd,
        classLine: entry.classLine,
        lines: rawLines,
        name: entry.name,
      };
    }
    const constructIndent = analysis.lines[constructLine]?.indentation ?? entry.indent;
    const bodyStart = constructLine + 1;
    const bodyEnd = blockEnd(analysis.lines, bodyStart, classEnd, constructIndent);
    return {
      bodyEnd,
      bodyIndent: suiteIndent(analysis.lines, bodyStart, bodyEnd, constructIndent),
      bodyStart,
      classLine: entry.classLine,
      lines: rawLines,
      name: entry.name,
    };
  });
}

export function findSourceSceneBlock(source: string, sceneName: string, sourcePath = "<source>") {
  const matches = findSceneBlocks(source).filter((block) => block.name === sceneName);
  if (matches.length > 1) {
    throw new AmbiguousSourceSceneError(
      sourcePath,
      sceneName,
      matches.map((block) => block.classLine),
    );
  }
  return matches[0] ?? null;
}

export type SourceSceneComment = Readonly<{
  line: number;
  text: string;
}>;

function commentsInSceneBlock(
  analysis: ReturnType<typeof analyzePythonSource>,
  block: SourceSceneBlock,
): readonly SourceSceneComment[] {
  if (!block || block.bodyIndent === null) return [];
  const terminalOffset = analysis.lines
    .slice(block.bodyStart, block.bodyEnd)
    .findIndex(
      (line) =>
        isPythonStatementStart(line) &&
        line.indentation === block.bodyIndent &&
        /^(?:raise|return)\b/.test(line.code.trimStart()),
    );
  const reachableEnd = terminalOffset < 0 ? block.bodyEnd : block.bodyStart + terminalOffset;
  return analysis.lines
    .slice(block.bodyStart, reachableEnd)
    .flatMap((line, index) =>
      isStandalonePythonComment(line) && line.indentation === block.bodyIndent && line.comment
        ? [{ line: block.bodyStart + index + 1, text: line.comment.text }]
        : [],
    );
}

export function findSourceComments(source: string): readonly SourceSceneComment[] {
  const analysis = analyzePythonSource(source);
  if (!analysis.valid) return [];
  return findSceneBlocks(source).flatMap((block) => commentsInSceneBlock(analysis, block));
}

export function findSourceSceneComments(
  source: string,
  sceneName: string,
  sourcePath = "<source>",
): readonly SourceSceneComment[] {
  const analysis = analyzePythonSource(source);
  const block = findSourceSceneBlock(source, sceneName, sourcePath);
  return analysis.valid && block ? commentsInSceneBlock(analysis, block) : [];
}

function collectStatements(block: SourceSceneBlock): readonly SourceStatement[] {
  if (block.bodyIndent === null) return [];
  const analysis = analyzePythonSource(block.lines.join("\n"));
  if (!analysis.valid) return [];
  const statements: SourceStatement[] = [];
  let current = "";
  let currentLine = block.bodyStart;
  for (let index = block.bodyStart; index < block.bodyEnd; index += 1) {
    const raw = block.lines[index] ?? "";
    const line = analysis.lines[index];
    if (!line) continue;
    const trimmed = raw.trim();
    if (!current && isStandalonePythonComment(line)) {
      if (line.indentation === block.bodyIndent && line.comment) {
        statements.push({ line: index, text: line.comment.text });
      }
      continue;
    }
    if (!current) {
      if (!isPythonStatementStart(line) || line.indentation !== block.bodyIndent) continue;
      currentLine = index;
    }
    current = current ? `${current}\n${trimmed}` : trimmed;
    if (line.bracketDepthAfter === 0 && !line.continuesToNext && !line.endsInString) {
      statements.push({ line: currentLine, text: current });
      current = "";
    }
  }
  if (current) statements.push({ line: currentLine, text: current });
  return statements;
}

function decodeStringLiteral(literal: string) {
  if (literal.startsWith('"') && literal.endsWith('"')) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return literal.slice(1, -1);
    }
  }
  const body = literal.slice(1, -1);
  return body.replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
}

function stringLiterals(value: string) {
  const literals: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const quote = value[index];
    if (quote !== '"' && quote !== "'") continue;
    let end = index + 1;
    let escaped = false;
    for (; end < value.length; end += 1) {
      const character = value[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) break;
    }
    if (end >= value.length) break;
    literals.push(decodeStringLiteral(value.slice(index, end + 1)));
    index = end;
  }
  return literals;
}

function matchingCallEnd(source: string, openingIndex: number) {
  let depth = 0;
  let quote: '"' | "'" | '"""' | "'''" | null = null;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (quote) {
      if (source.startsWith(quote, index)) {
        index += quote.length - 1;
        quote = null;
      } else if (source[index] === "\\" && quote.length === 1) {
        index += 1;
      }
      continue;
    }
    if (source[index] === "#") {
      const newline = source.indexOf("\n", index);
      if (newline < 0) return null;
      index = newline;
      continue;
    }
    if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
      quote = source.slice(index, index + 3) as '"""' | "'''";
      index += 2;
      continue;
    }
    if (source[index] === '"' || source[index] === "'") {
      quote = source[index] as '"' | "'";
      continue;
    }
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function parseEntityAssignment(source: string) {
  const match = source.match(ASSIGNMENT_PREFIX_PATTERN);
  if (!match || !SUPPORTED_TYPES.has(match[2])) return null;
  const openingIndex = match[0].lastIndexOf("(");
  const closingIndex = matchingCallEnd(source, openingIndex);
  if (closingIndex === null) return null;
  return {
    argumentsSource: source.slice(openingIndex + 1, closingIndex),
    sourceVariable: match[1],
    suffix: source.slice(closingIndex + 1),
    type: match[2],
  };
}

function splitTopLevelArguments(source: string) {
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      const segment = source.slice(start, index).trim();
      if (segment) segments.push(segment);
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

function constructorArguments(source: string) {
  const positional: string[] = [];
  const keywords = new Map<string, string>();
  for (const argument of splitTopLevelArguments(source)) {
    const keyword = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s);
    if (keyword) keywords.set(keyword[1], keyword[2].trim());
    else positional.push(argument);
  }
  return { keywords, positional };
}

function positiveNumberLiteral(source: string) {
  const normalized = source.trim().replaceAll("_", "");
  if (!/^[+]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function unknown<T>(reason: string, evidence: readonly string[]): Knowledge<T> {
  return { evidence, kind: "unknown", reason };
}

function dimensionsFrom(type: string, argumentsSource: string): Knowledge<EntityDimensions> {
  const { keywords, positional } = constructorArguments(argumentsSource);
  const read = (keyword: string, index: number, fallback: number) => {
    const expression = keywords.get(keyword) ?? positional[index];
    return expression === undefined ? fallback : positiveNumberLiteral(expression);
  };
  let dimensions: EntityDimensions | null = null;
  if (type === "Circle") {
    const radius = read("radius", 0, 1);
    if (radius !== null) dimensions = { radius };
  } else if (type === "Dot") {
    const radius = read("radius", 1, 0.08);
    if (radius !== null) dimensions = { radius };
  } else if (type === "Rectangle") {
    const width = read("width", 0, 4);
    const height = read("height", 1, 2);
    if (width !== null && height !== null) dimensions = { height, width };
  } else if (type === "Square") {
    const side = read("side_length", 0, 2);
    if (side !== null) dimensions = { height: side, width: side };
  } else if (type === "RegularPolygon") {
    const radius = read("radius", Number.MAX_SAFE_INTEGER, 1);
    if (radius !== null) dimensions = { radius };
  }
  if (dimensions) return { kind: "known", value: dimensions };
  return unknown(`${type} dimensions depend on a dynamic constructor expression or Manim runtime layout.`, [
    argumentsSource || `${type}()`,
  ]);
}

function literalStyleValue(source: string) {
  const value = source.trim();
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return value;
  if (/^(?:[rRuUbB]{0,2})?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/s.test(value)) {
    return stringLiterals(value)[0] ?? null;
  }
  return null;
}

function styleFrom(argumentsSource: string, suffix: string): Knowledge<EntityStyle> {
  const { keywords } = constructorArguments(argumentsSource);
  const properties: Array<readonly ["color" | "fillColor" | "strokeColor", string | undefined]> = [
    ["color", keywords.get("color")],
    ["fillColor", keywords.get("fill_color")],
    ["strokeColor", keywords.get("stroke_color")],
  ];
  if (/\.(?:set_fill|set_stroke)\s*\(/.test(suffix)) {
    return unknown("Object style is changed by a chained source method.", [suffix.trim()]);
  }
  const setColor = suffix.match(/\.set_color\(\s*([^()]*)\s*\)/s)?.[1];
  if (setColor !== undefined) properties.push(["color", setColor]);
  if (suffix.includes(".set_color(") && setColor === undefined) {
    return unknown("Object color uses a dynamic set_color expression.", [suffix.trim()]);
  }
  const style: Record<string, string> = {};
  for (const [property, expression] of properties) {
    if (expression === undefined) continue;
    const literal = literalStyleValue(expression);
    if (literal === null) {
      return unknown(`Object ${property} uses a dynamic source expression.`, [expression]);
    }
    style[property] = literal;
  }
  return { kind: "known", value: style };
}

function initialScaleFrom(suffix: string): Readonly<{ knowledge: Knowledge<number>; value: number }> {
  if (/\.(?:stretch|set_width|set_height)\s*\(/.test(suffix)) {
    return {
      knowledge: unknown("Initial scale is changed by a dimension-dependent source method.", [suffix.trim()]),
      value: 1,
    };
  }
  const scaleCalls = [...suffix.matchAll(/\.scale\(\s*([^()]*)\s*\)/g)];
  if (suffix.includes(".scale(") && scaleCalls.length === 0) {
    return { knowledge: unknown("Initial scale uses a dynamic source expression.", [suffix.trim()]), value: 1 };
  }
  let value = 1;
  for (const call of scaleCalls) {
    const factor = positiveNumberLiteral(call[1]);
    if (factor === null) {
      return { knowledge: unknown("Initial scale uses a dynamic source expression.", [call[1]]), value };
    }
    value *= factor;
  }
  return { knowledge: { kind: "known", value }, value };
}

function initialPositionFrom(type: string, suffix: string, approximate: Point) {
  if (/\.(?:align_to|arrange|move_to|next_to|shift|to_corner|to_edge)\s*\(/.test(suffix)) {
    return {
      knowledge: unknown<Point>("Initial position depends on a source placement expression.", [suffix.trim()]),
      value: approximate,
    };
  }
  if (["Arrow", "Group", "Line", "SurroundingRectangle", "VGroup"].includes(type)) {
    return {
      knowledge: unknown<Point>(`${type} position depends on other runtime geometry.`, [`${type}(...)`]),
      value: approximate,
    };
  }
  const center = { x: 320, y: 180 };
  return { knowledge: { kind: "known" as const, value: center }, value: center };
}

function markerIdentity(statements: readonly SourceStatement[], assignmentIndex: number, sourceVariable: string) {
  const previous = statements[assignmentIndex - 1]?.text.match(ENTITY_MARKER_PATTERN)?.[1];
  if (!previous) return null;
  try {
    const parsed = JSON.parse(previous) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0 &&
      "variable" in parsed &&
      parsed.variable === sourceVariable
      ? parsed.id
      : null;
  } catch {
    return null;
  }
}

function entityContent(type: string, variable: string, argumentsSource: string): EntityContent | undefined {
  const strings = stringLiterals(argumentsSource);
  if (type === "MathTex") {
    const texParts = strings.length > 0 ? strings : [variable];
    return {
      displayLines: [texParts.join(" ")],
      label: variable.replaceAll("_", " "),
      texParts,
    };
  }
  if (type === "Text") {
    const text = strings[0] ?? variable.replaceAll("_", " ");
    return { displayLines: [text], label: variable.replaceAll("_", " "), text };
  }
  return { displayLines: [variable.replaceAll("_", " ")], label: variable.replaceAll("_", " ") };
}

function relationFrom(source: string) {
  const match = source.match(/\.next_to\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(UP|DOWN|LEFT|RIGHT)\b/);
  return match ? { direction: match[2] as "DOWN" | "LEFT" | "RIGHT" | "UP", target: match[1] } : undefined;
}

function defaultPosition(index: number): Point {
  const column = index % 3;
  const row = Math.floor(index / 3);
  return { x: 170 + column * 150, y: 135 + row * 90 };
}

function relationOffset(direction: "DOWN" | "LEFT" | "RIGHT" | "UP"): Point {
  return {
    DOWN: { x: 0, y: 75 },
    LEFT: { x: -150, y: 0 },
    RIGHT: { x: 150, y: 0 },
    UP: { x: 0, y: -75 },
  }[direction];
}

function addPoint(left: Point, right: Point): Point {
  return { x: left.x + right.x, y: left.y + right.y };
}

function beginPresence(entity: MutableEntity, at: number) {
  if (entity.lifetimes.at(-1)?.end === null) return;
  entity.lifetimes.push({ end: null, start: at });
}

function endPresence(entity: MutableEntity, at: number) {
  const active = entity.lifetimes.at(-1);
  if (active?.end !== null) return;
  active.end = Math.max(active.start, at);
}

function durationFrom(statement: string, fallback = 1) {
  const match = statement.match(/\brun_time\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : fallback;
}

function waitDuration(statement: string) {
  const match = statement.match(/^self\.wait\(\s*([0-9]+(?:\.[0-9]+)?)?\s*\)/s);
  return match ? Number(match[1] ?? 1) : null;
}

function markerBefore(statements: readonly SourceStatement[], statementIndex: number, pattern: RegExp): unknown {
  for (let index = statementIndex - 1; index >= 0; index -= 1) {
    const text = statements[index]?.text ?? "";
    const match = text.match(pattern);
    if (match) {
      try {
        return JSON.parse(match[1] ?? "") as unknown;
      } catch {
        return null;
      }
    }
    if (!text.startsWith("#")) return undefined;
  }
  return undefined;
}

function simpleShiftVector(statement: string, sourceVariable: string) {
  const variable = sourceVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `(?:^self\\.play\\(\\s*|\\n\\s*)${variable}\\s*\\.\\s*animate\\s*\\.\\s*shift\\s*\\(\\s*([^()]*)\\s*\\)`,
    "s",
  )
    .exec(statement)?.[1]
    .replace(/\s/g, "");
  const number = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  const direction = "(?:DOWN|LEFT|RIGHT|UP)";
  if (
    !expression ||
    !new RegExp(`^[+-]?(?:${number}\\*)?${direction}(?:[+-](?:${number}\\*)?${direction})*$`).test(expression)
  ) {
    return null;
  }
  const vector = { x: 0, y: 0 };
  for (const term of expression.matchAll(/([+-]?)(?:(\d+(?:\.\d*)?|\.\d+)\*)?(DOWN|LEFT|RIGHT|UP)/g)) {
    const amount = (term[1] === "-" ? -1 : 1) * Number(term[2] ?? 1);
    if (term[3] === "LEFT") vector.x -= amount;
    if (term[3] === "RIGHT") vector.x += amount;
    if (term[3] === "UP") vector.y -= amount;
    if (term[3] === "DOWN") vector.y += amount;
  }
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) ? vector : null;
}

function appendChannelSample(
  channelSamples: Map<string, PropertyChannelSample[]>,
  entityId: string,
  sample: PropertyChannelSample,
) {
  const samples = channelSamples.get(entityId) ?? [];
  const previous = samples.at(-1);
  if (previous && previous.interval.end > sample.interval.start) {
    samples[samples.length - 1] = {
      ...previous,
      interval: { ...previous.interval, end: Math.max(previous.interval.start, sample.interval.start) },
    };
  }
  samples.push(sample);
  channelSamples.set(entityId, samples);
}

function shiftedPosition(
  point: Point,
  statement: string,
  sourceVariable: string,
  frame: Readonly<{ height: number; width: number }>,
) {
  const vector = simpleShiftVector(statement, sourceVariable);
  if (!vector) return null;
  return addPoint(point, {
    x: vector.x * (640 / frame.width),
    y: vector.y * (360 / frame.height),
  });
}

export function importManimScene(
  source: string,
  sourcePath: string,
  sceneName: string,
  frame: Readonly<{ height: number; width: number }> = { height: 8, width: 14.222 },
): ImportedManimScene | null {
  const block = findSourceSceneBlock(source, sceneName, sourcePath);
  if (!block) return null;
  const collectedStatements = collectStatements(block);
  const returnIndex = collectedStatements.findIndex((statement) => /^return\b/.test(statement.text));
  const statements = returnIndex < 0 ? collectedStatements : collectedStatements.slice(0, returnIndex + 1);
  const sceneId = `${sourcePath}#${sceneName}`;
  const mutableEntities: MutableEntity[] = [];
  const byVariable = new Map<string, MutableEntity>();
  let insideIncomingCopy = false;
  statements.forEach((statement, index) => {
    if (statement.text === "# poietra:incoming-start") {
      insideIncomingCopy = true;
      return;
    }
    if (statement.text === "# poietra:incoming-end") {
      insideIncomingCopy = false;
      return;
    }
    if (insideIncomingCopy) return;
    const assignment = parseEntityAssignment(statement.text);
    if (!assignment) return;
    const { argumentsSource, sourceVariable, suffix, type } = assignment;
    const markedIdentity = markerIdentity(statements, index, sourceVariable);
    if (sourceVariable.startsWith("poietra_") && !markedIdentity) return;
    const approximatePosition = defaultPosition(mutableEntities.length);
    const initialPosition = initialPositionFrom(type, suffix, approximatePosition);
    const initialScale = initialScaleFrom(suffix);
    const entity: MutableEntity = {
      content: entityContent(type, sourceVariable, argumentsSource),
      dimensions: dimensionsFrom(type, argumentsSource),
      id: markedIdentity ?? `source:${sceneId}:${sourceVariable}`,
      initialization: statement.text,
      lifetimes: [],
      position: initialPosition.value,
      positionKnowledge: initialPosition.knowledge,
      relation: relationFrom(statement.text),
      scale: initialScale.value,
      scaleKnowledge: initialScale.knowledge,
      sourceVariable,
      style: styleFrom(argumentsSource, suffix),
      type,
    };
    mutableEntities.push(entity);
    byVariable.set(sourceVariable, entity);
  });
  for (const entity of mutableEntities) {
    if (entity.relation) {
      const target = byVariable.get(entity.relation.target);
      if (target) entity.position = addPoint(target.position, relationOffset(entity.relation.direction));
    }
    const surrounded = entity.initialization.match(/SurroundingRectangle\(\s*([A-Za-z_][A-Za-z0-9_]*)/);
    if (surrounded) {
      const target = byVariable.get(surrounded[1]);
      if (target) entity.position = target.position;
    }
  }

  let cursor = 0;
  let firstPlayEnd: number | null = null;
  let insideIncomingEvents = false;
  const events: TimelineEvent[] = [];
  const positionSamples = new Map<string, PropertyChannelSample[]>();
  const scaleSamples = new Map<string, PropertyChannelSample[]>();
  for (const entity of mutableEntities) {
    positionSamples.set(entity.id, [
      {
        interval: { end: Number.MAX_SAFE_INTEGER, start: 0 },
        kind: "exact",
        knowledge: entity.positionKnowledge,
        provenanceId: `import:${sceneId}:${entity.sourceVariable}:position`,
        value: entity.position,
      },
    ]);
    scaleSamples.set(entity.id, [
      {
        interval: { end: Number.MAX_SAFE_INTEGER, start: 0 },
        kind: "exact",
        knowledge: entity.scaleKnowledge,
        provenanceId: `import:${sceneId}:${entity.sourceVariable}:scale`,
        value: entity.scale,
      },
    ]);
  }
  for (const [statementIndex, statement] of statements.entries()) {
    if (statement.text === "# poietra:incoming-start") {
      insideIncomingEvents = true;
      continue;
    }
    if (statement.text === "# poietra:incoming-end") {
      insideIncomingEvents = false;
      continue;
    }
    if (insideIncomingEvents) continue;
    const sourceAnchor = statement.text.match(ANCHOR_PATTERN)?.[1];
    if (sourceAnchor) {
      cursor = Number(sourceAnchor);
      continue;
    }
    const sourceCursor = statement.text.match(CURSOR_PATTERN)?.[1];
    if (sourceCursor) {
      cursor = Number(sourceCursor);
      continue;
    }
    const sceneBoundary = statement.text.match(SCENE_BOUNDARY_PATTERN)?.[1];
    if (sceneBoundary) {
      try {
        const parsed = JSON.parse(sceneBoundary) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "at" in parsed &&
          typeof parsed.at === "number" &&
          "destination" in parsed &&
          typeof parsed.destination === "string"
        ) {
          events.push({
            at: parsed.at,
            id: `import:${sceneId}:scene-boundary:${statement.line}`,
            kind: "scene-boundary",
            label: `Scene boundary → ${parsed.destination}`,
          });
        }
      } catch {
        // Invalid markers remain inert comments.
      }
      continue;
    }
    const wait = waitDuration(statement.text);
    if (wait !== null) {
      events.push({
        id: `import:${sceneId}:wait:${statement.line}`,
        interval: { end: cursor + wait, start: cursor },
        kind: "wait",
        label: "wait",
      });
      cursor += wait;
      continue;
    }
    const positionMarker = markerBefore(statements, statementIndex, POSITION_MARKER_PATTERN);
    const moveToVariable = statement.text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*move_to\s*\(/s)?.[1];
    if (moveToVariable) {
      const parsed = positionMarkerSchema.safeParse(positionMarker);
      const entity = byVariable.get(moveToVariable);
      if (entity) {
        let position = entity.position;
        let knowledge: Knowledge<Point> = unknown("Position is changed by an unverified move_to expression.", [
          statement.text.trim(),
        ]);
        if (parsed.success && parsed.data.variable === moveToVariable) {
          if (parsed.data.kind === "absolute") {
            position = parsed.data.value;
            knowledge = { kind: "known", value: position };
          } else {
            const relative = byVariable.get(parsed.data.relativeTo);
            if (relative) {
              position = addPoint(relative.position, parsed.data.offset);
              knowledge =
                relative.positionKnowledge.kind === "known"
                  ? { kind: "known", value: position }
                  : unknown(`Relative position depends on the unknown position of ${parsed.data.relativeTo}.`, [
                      statement.text.trim(),
                    ]);
            }
          }
        }
        if (Number.isFinite(position.x) && Number.isFinite(position.y)) {
          appendChannelSample(positionSamples, entity.id, {
            interval: { end: Number.MAX_SAFE_INTEGER, start: cursor },
            kind: "exact",
            knowledge,
            provenanceId: `import:${sceneId}:${entity.sourceVariable}:position:${statement.line}`,
            value: position,
          });
          entity.position = position;
          entity.positionKnowledge = knowledge;
        }
      }
      continue;
    }
    const directScaleMarker = markerBefore(statements, statementIndex, SCALE_MARKER_PATTERN);
    const directScale = statement.text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*scale\s*\((.*)\)\s*$/s);
    if (directScale) {
      const [, directScaleVariable, expression] = directScale;
      const entity = byVariable.get(directScaleVariable);
      if (entity) {
        const parsed = scaleMarkerSchema.safeParse(directScaleMarker);
        const factor = positiveNumberLiteral(expression);
        let value = entity.scale;
        let knowledge: Knowledge<number>;
        if (parsed.success && parsed.data.kind === "exact" && parsed.data.variable === directScaleVariable) {
          value = parsed.data.value;
          knowledge = { kind: "known", value };
        } else if (factor !== null) {
          value *= factor;
          knowledge = entity.scaleKnowledge.kind === "known" ? { kind: "known", value } : entity.scaleKnowledge;
        } else {
          knowledge = unknown("Scale is changed by a dynamic source expression.", [expression.trim()]);
        }
        appendChannelSample(scaleSamples, entity.id, {
          interval: { end: Number.MAX_SAFE_INTEGER, start: cursor },
          kind: "exact",
          knowledge,
          provenanceId: `import:${sceneId}:${entity.sourceVariable}:scale:${statement.line}`,
          value,
        });
        entity.scale = value;
        entity.scaleKnowledge = knowledge;
      }
      continue;
    }
    const add = statement.text.match(/^self\.add\((.*)\)$/s)?.[1];
    if (add) {
      for (const entity of mutableEntities) {
        const variablePattern = entity.sourceVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${variablePattern}\\b`).test(add)) beginPresence(entity, cursor);
      }
      continue;
    }
    const remove = statement.text.match(/^self\.remove\((.*)\)$/s)?.[1];
    if (remove) {
      for (const entity of mutableEntities) {
        const variablePattern = entity.sourceVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${variablePattern}\\b`).test(remove)) endPresence(entity, cursor);
      }
      continue;
    }
    if (/^self\.clear\(\s*\)$/.test(statement.text)) {
      for (const entity of mutableEntities) endPresence(entity, cursor);
      continue;
    }
    if (!statement.text.startsWith("self.play(")) continue;
    const duration = durationFrom(statement.text);
    const interval = { end: cursor + duration, start: cursor };
    const motionMarker = markerBefore(statements, statementIndex, MOTION_MARKER_PATTERN);
    const scaleMarker = markerBefore(statements, statementIndex, SCALE_MARKER_PATTERN);
    const parsedMotion = motionMarkerSchema.safeParse(motionMarker);
    const parsedScale = scaleMarkerSchema.safeParse(scaleMarker);
    const markedVariables = parsedMotion.success ? parsedMotion.data.motions.flatMap((motion) => motion.variables) : [];
    const actualShiftVariables = [
      ...statement.text.matchAll(
        /(?:^self\.play\(\s*|\n\s*)([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*animate\s*\.\s*shift\s*\(/g,
      ),
    ].map((match) => match[1]);
    const actualPathVariables = [
      ...statement.text.matchAll(
        /(?:^self\.play\(\s*|\n\s*)MoveAlongPath\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*CubicBezier\s*\(/g,
      ),
    ].map((match) => match[1]);
    const actualMotionVariables = [...actualShiftVariables, ...actualPathVariables];
    const actualScaleCalls = [
      ...statement.text.matchAll(
        /(?:^self\.play\(\s*|\n\s*)([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*animate\s*\.\s*scale\s*\(\s*([^()]*)\s*\)/g,
      ),
    ];
    const actualScaleVariables = [
      ...statement.text.matchAll(
        /(?:^self\.play\(\s*|\n\s*)([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*animate\s*\.\s*scale\s*\(/g,
      ),
    ].map((match) => match[1]);
    const literalScaleFactors = new Map(
      actualScaleCalls.flatMap((match) => {
        const factor = positiveNumberLiteral(match[2]);
        return factor === null ? [] : [[match[1], factor] as const];
      }),
    );
    const validMarkedMotion =
      motionMarker !== undefined &&
      parsedMotion.success &&
      new Set(markedVariables).size === markedVariables.length &&
      markedVariables.length === actualMotionVariables.length &&
      markedVariables.every((variable) => byVariable.has(variable) && actualMotionVariables.includes(variable));
    const markedMotions =
      validMarkedMotion && parsedMotion.success
        ? new Map(
            parsedMotion.data.motions.flatMap((motion) =>
              motion.variables.map(
                (variable) =>
                  [
                    variable,
                    {
                      controlOffset: motion.controlOffset ?? { x: 0, y: 0 },
                      delta: motion.delta,
                    },
                  ] as const,
              ),
            ),
          )
        : new Map<string, Readonly<{ controlOffset: Point; delta: Point }>>();
    const validMarkedScale =
      scaleMarker !== undefined &&
      parsedScale.success &&
      parsedScale.data.kind === "animated" &&
      new Set(parsedScale.data.scales.map((scale) => scale.variable)).size === parsedScale.data.scales.length &&
      parsedScale.data.scales.length === actualScaleVariables.length &&
      parsedScale.data.scales.every(
        (scale) => byVariable.has(scale.variable) && actualScaleVariables.includes(scale.variable),
      );
    const markedScales =
      validMarkedScale && parsedScale.success && parsedScale.data.kind === "animated"
        ? new Map(parsedScale.data.scales.map((scale) => [scale.variable, scale] as const))
        : new Map<string, Readonly<{ from: number; to: number; variable: string }>>();
    firstPlayEnd ??= interval.end;
    events.push({
      id: `import:${sceneId}:play:${statement.line}`,
      interval,
      kind: "play",
      label: statement.text.split("\n", 1)[0].slice(0, 80),
    });
    for (const entity of mutableEntities) {
      const variablePattern = entity.sourceVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:FadeIn|Create|Write)\\(\\s*${variablePattern}\\b`).test(statement.text)) {
        beginPresence(entity, cursor);
      }
      if (new RegExp(`(?:FadeOut|Uncreate|Unwrite)\\(\\s*${variablePattern}\\b`).test(statement.text)) {
        endPresence(entity, interval.end);
      }
      const marked = markedMotions.get(entity.sourceVariable);
      const shifted = marked
        ? addPoint(entity.position, marked.delta)
        : motionMarker !== undefined
          ? null
          : shiftedPosition(entity.position, statement.text, entity.sourceVariable, frame);
      if (shifted && Number.isFinite(shifted.x) && Number.isFinite(shifted.y)) {
        const from = entity.position;
        const to = shifted;
        const controlOffset = marked?.controlOffset ?? { x: 0, y: 0 };
        const knowledge: Knowledge<Point> =
          entity.positionKnowledge.kind === "known" ? { kind: "known", value: to } : entity.positionKnowledge;
        appendChannelSample(positionSamples, entity.id, {
          control: {
            x: (from.x + to.x) / 2 + controlOffset.x,
            y: (from.y + to.y) / 2 + controlOffset.y,
          },
          easing: "smooth",
          from,
          interval,
          kind: "animated",
          knowledge,
          provenanceId: `import:${sceneId}:${entity.sourceVariable}:motion:${statement.line}`,
          relative: true,
          value: to,
        });
        entity.position = to;
        entity.positionKnowledge = knowledge;
      } else if (actualMotionVariables.includes(entity.sourceVariable)) {
        const knowledge = unknown<Point>(
          "Position is changed by a motion expression that Studio cannot evaluate safely.",
          [statement.text.trim()],
        );
        appendChannelSample(positionSamples, entity.id, {
          easing: "smooth",
          from: entity.position,
          interval,
          kind: "animated",
          knowledge,
          provenanceId: `import:${sceneId}:${entity.sourceVariable}:unknown-motion:${statement.line}`,
          value: entity.position,
        });
        entity.positionKnowledge = knowledge;
      }
      const scale = markedScales.get(entity.sourceVariable);
      if (scale) {
        const knowledge = { kind: "known" as const, value: scale.to };
        appendChannelSample(scaleSamples, entity.id, {
          easing: "smooth",
          from: scale.from,
          interval,
          kind: "animated",
          knowledge,
          provenanceId: `import:${sceneId}:${entity.sourceVariable}:scale-marker:${statement.line}`,
          value: scale.to,
        });
        entity.scale = scale.to;
        entity.scaleKnowledge = knowledge;
      } else if (actualScaleVariables.includes(entity.sourceVariable)) {
        const factor = literalScaleFactors.get(entity.sourceVariable);
        const from = entity.scale;
        const to = factor === undefined ? from : from * factor;
        const knowledge: Knowledge<number> =
          factor !== undefined && entity.scaleKnowledge.kind === "known"
            ? { kind: "known", value: to }
            : unknown("Scale is changed by an animation expression that Studio cannot evaluate safely.", [
                statement.text.trim(),
              ]);
        appendChannelSample(scaleSamples, entity.id, {
          easing: "smooth",
          from,
          interval,
          kind: "animated",
          knowledge,
          provenanceId: `import:${sceneId}:${entity.sourceVariable}:scale:${statement.line}`,
          value: to,
        });
        entity.scale = to;
        entity.scaleKnowledge = knowledge;
      }
    }
    for (const transform of statement.text.matchAll(
      /(?:ReplacementTransform|TransformMatchingTex)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      const sourceEntity = byVariable.get(transform[1]);
      const targetEntity = byVariable.get(transform[2]);
      if (sourceEntity) endPresence(sourceEntity, interval.end);
      if (targetEntity) beginPresence(targetEntity, interval.start);
    }
    cursor = interval.end;
  }
  const anchors = statements.flatMap((statement) => {
    const match = statement.text.match(ANCHOR_PATTERN);
    return match ? [Number(match[1])] : [];
  });
  const duration = Math.max(0.1, cursor, ...anchors);
  const entities = Object.fromEntries(
    mutableEntities.map((entity): [string, RuntimeEntity] => [
      entity.id,
      {
        content: entity.content,
        geometry: {
          dimensions: entity.dimensions,
          position: entity.positionKnowledge,
          scale: entity.scaleKnowledge,
          style: entity.style,
        } satisfies EntityGeometryKnowledge,
        id: entity.id,
        lifetime: entity.lifetimes.map((lifetime) => ({
          end: Math.min(lifetime.end ?? duration, duration),
          start: Math.min(lifetime.start, duration),
        })),
        provisional: false,
        sourceIdentity: { kind: "known", value: entity.sourceVariable },
        type: entity.type,
      },
    ]),
  );
  const propertyChannels: Record<string, PropertyChannel> = Object.fromEntries(
    mutableEntities.flatMap((entity) =>
      (
        [
          ["position", positionSamples.get(entity.id) ?? []],
          ["scale", scaleSamples.get(entity.id) ?? []],
        ] as const
      ).map(([key, samples]) => [
        `${entity.id}/${key}`,
        {
          entityId: entity.id,
          key,
          samples: samples.map((sample) => ({
            ...sample,
            interval: { ...sample.interval, end: Math.min(sample.interval.end, duration) },
          })),
        },
      ]),
    ),
  );
  for (const entity of mutableEntities) {
    if (!entity.content) continue;
    propertyChannels[`${entity.id}/content`] = {
      entityId: entity.id,
      key: "content",
      samples: [
        {
          interval: { end: duration, start: 0 },
          kind: "exact",
          provenanceId: `import:${sceneId}:${entity.sourceVariable}:content`,
          value: entity.content,
        },
      ],
    };
  }
  const runtimeSceneState: RuntimeSceneState = {
    constraintGraph: {
      constraints: mutableEntities.flatMap((entity) =>
        entity.relation
          ? [
              {
                id: `import:${sceneId}:${entity.sourceVariable}:next-to`,
                mode: "snapshot" as const,
                operationId: `import:${sceneId}:${entity.sourceVariable}:placement`,
                relation: "next-to" as const,
                sourceEntityId: entity.id,
                targetEntityId: byVariable.get(entity.relation.target)?.id ?? entity.id,
              },
            ]
          : [],
      ),
    },
    duration,
    eventTrack: { events },
    objectGraph: { entities, lineage: [] },
    propertyChannels,
    provenanceGraph: {
      records: [
        { evidence: [sourcePath, "conservative static source import"], id: `import:${sceneId}`, origin: "import" },
      ],
    },
    sceneId,
    version: STUDIO_STATE_VERSION,
  };
  const staticSemanticState: StaticSemanticState = {
    entities: mutableEntities.map((entity) => ({
      runtimeIdentities: { kind: "known", value: [entity.id] },
      sourceIdentity: entity.sourceVariable,
      type: { kind: "known", value: entity.type },
    })),
    unknowns: [],
    version: STUDIO_STATE_VERSION,
  };
  const firstPlay = statements.find((statement) => statement.text.startsWith("self.play("));
  const firstPlayIndex = firstPlay ? statements.indexOf(firstPlay) : statements.length;
  const initialVisibleSourceVariables = mutableEntities
    .filter((entity) =>
      entity.lifetimes.some((lifetime) =>
        firstPlayEnd === null ? lifetime.start <= 0 : lifetime.start < firstPlayEnd,
      ),
    )
    .map((entity) => entity.sourceVariable);
  return {
    anchors,
    initialVisibleSourceVariables,
    initialization: mutableEntities
      .filter(
        (entity) => statements.findIndex((statement) => statement.text === entity.initialization) < firstPlayIndex,
      )
      .map((entity) => entity.initialization),
    name: sceneName,
    runtimeSceneState,
    sceneId,
    sourceHash: hashSource(source),
    sourceVariables: Object.fromEntries(mutableEntities.map((entity) => [entity.id, entity.sourceVariable])),
    staticSemanticState,
  };
}

export function importedEntityInterval(entity: RuntimeEntity): Interval {
  return entity.lifetime[0] ?? { end: 0, start: 0 };
}
