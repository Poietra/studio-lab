import { createHash } from "node:crypto";

import {
  STUDIO_STATE_VERSION,
  type EntityContent,
  type Interval,
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
  bodyStart: number;
  classLine: number;
  lines: readonly string[];
  name: string;
}>;

type MutableEntity = {
  content?: EntityContent;
  id: string;
  initialization: string;
  lifetimes: Array<{ end: number | null; start: number }>;
  position: Point;
  relation?: Readonly<{ direction: "DOWN" | "LEFT" | "RIGHT" | "UP"; target: string }>;
  sourceVariable: string;
  type: string;
};

type SourceStatement = Readonly<{
  line: number;
  text: string;
}>;

const CLASS_PATTERN = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*Scene[^)]*)\)\s*:/;
const ASSIGNMENT_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)(.*)$/s;
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
const SCENE_BOUNDARY_PATTERN = /^\s*#\s*poietra:scene-boundary\s+(.+)\s*$/;

function hashSource(source: string) {
  return createHash("sha256").update(source).digest("hex");
}

function lineIndent(line: string) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function blockEnd(lines: readonly string[], start: number, limit: number, parentIndent: number) {
  for (let index = start; index < limit; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length > 0 && lineIndent(line) <= parentIndent) return index;
  }
  return limit;
}

export function findSceneBlocks(source: string): readonly SourceSceneBlock[] {
  const lines = source.split(/\r?\n/);
  const classes = lines.flatMap((line, index) => {
    const match = line.match(CLASS_PATTERN);
    return match ? [{ classLine: index, indent: lineIndent(line), name: match[1] }] : [];
  });
  return classes.map((entry) => {
    const classEnd = blockEnd(lines, entry.classLine + 1, lines.length, entry.indent);
    const constructLine = lines.findIndex((line, index) => (
      index > entry.classLine
      && index < classEnd
      && lineIndent(line) > entry.indent
      && /^\s*def\s+construct\s*\(\s*self\s*\)\s*:/.test(line)
    ));
    if (constructLine < 0) {
      return {
        bodyEnd: classEnd,
        bodyStart: classEnd,
        classLine: entry.classLine,
        lines,
        name: entry.name,
      };
    }
    const constructIndent = lineIndent(lines[constructLine] ?? "");
    const bodyStart = constructLine + 1;
    return {
      bodyEnd: blockEnd(lines, bodyStart, classEnd, constructIndent),
      bodyStart,
      classLine: entry.classLine,
      lines,
      name: entry.name,
    };
  });
}

export function findSourceSceneBlock(source: string, sceneName: string) {
  return findSceneBlocks(source).find((block) => block.name === sceneName) ?? null;
}

function collectStatements(block: SourceSceneBlock): readonly SourceStatement[] {
  const statements: SourceStatement[] = [];
  let current = "";
  let currentLine = block.bodyStart;
  let depth = 0;
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (let index = block.bodyStart; index < block.bodyEnd; index += 1) {
    const raw = block.lines[index] ?? "";
    const trimmed = raw.trim();
    if (!current && (!trimmed || trimmed.startsWith("#"))) {
      if (trimmed) statements.push({ line: index, text: trimmed });
      continue;
    }
    if (!current) currentLine = index;
    current = current ? `${current}\n${trimmed}` : trimmed;
    for (const character of trimmed) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && quote) {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === "\"" || character === "'") {
        quote = character;
        continue;
      }
      if (character === "(" || character === "[" || character === "{") depth += 1;
      if (character === ")" || character === "]" || character === "}") depth -= 1;
    }
    if (depth <= 0 && !quote) {
      statements.push({ line: currentLine, text: current });
      current = "";
      depth = 0;
    }
  }
  if (current) statements.push({ line: currentLine, text: current });
  return statements;
}

function decodeStringLiteral(literal: string) {
  if (literal.startsWith("\"") && literal.endsWith("\"")) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return literal.slice(1, -1);
    }
  }
  const body = literal.slice(1, -1);
  return body
    .replace(/\\'/g, "'")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function stringLiterals(value: string) {
  const literals: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const quote = value[index];
    if (quote !== "\"" && quote !== "'") continue;
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

function markerIdentity(statements: readonly SourceStatement[], assignmentIndex: number) {
  const previous = statements[assignmentIndex - 1]?.text.match(ENTITY_MARKER_PATTERN)?.[1];
  if (!previous) return null;
  try {
    const parsed = JSON.parse(previous) as unknown;
    return typeof parsed === "object"
      && parsed !== null
      && "id" in parsed
      && typeof parsed.id === "string"
      && parsed.id.length > 0
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

function add(left: Point, right: Point): Point {
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

type LinearValue =
  | Readonly<{ kind: "scalar"; value: number }>
  | Readonly<{ kind: "vector"; x: number; y: number }>;

type VectorToken = Readonly<{
  kind: "identifier" | "number" | "operator";
  value: string;
}>;

function tokenizeVectorExpression(source: string): readonly VectorToken[] | null {
  const tokens: VectorToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    const rest = source.slice(offset);
    const whitespace = rest.match(/^\s+/)?.[0];
    if (whitespace) {
      offset += whitespace.length;
      continue;
    }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)?.[0];
    if (number) {
      tokens.push({ kind: "number", value: number });
      offset += number.length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier });
      offset += identifier.length;
      continue;
    }
    const operator = rest[0];
    if (operator === "+" || operator === "-" || operator === "*" || operator === "(" || operator === ")") {
      tokens.push({ kind: "operator", value: operator });
      offset += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

function scaleLinearValue(value: LinearValue, amount: number): LinearValue {
  return value.kind === "scalar"
    ? { kind: "scalar", value: value.value * amount }
    : { kind: "vector", x: value.x * amount, y: value.y * amount };
}

function parseLinearVector(source: string): Readonly<{ x: number; y: number }> | null {
  const parsedTokens = tokenizeVectorExpression(source);
  if (!parsedTokens || parsedTokens.length === 0) return null;
  const tokens: readonly VectorToken[] = parsedTokens;
  let index = 0;

  const parsePrimary = (): LinearValue | null => {
    const token = tokens[index];
    if (!token) return null;
    if (token.kind === "number") {
      index += 1;
      const value = Number(token.value);
      return Number.isFinite(value) ? { kind: "scalar", value } : null;
    }
    if (token.kind === "identifier") {
      index += 1;
      const vector = {
        DOWN: { x: 0, y: 1 },
        LEFT: { x: -1, y: 0 },
        ORIGIN: { x: 0, y: 0 },
        RIGHT: { x: 1, y: 0 },
        UP: { x: 0, y: -1 },
      }[token.value];
      return vector ? { kind: "vector", ...vector } : null;
    }
    if (token.value !== "(") return null;
    index += 1;
    const value = parseSum();
    if (!value || tokens[index]?.value !== ")") return null;
    index += 1;
    return value;
  };

  const parseUnary = (): LinearValue | null => {
    const operator = tokens[index]?.value;
    if (operator !== "+" && operator !== "-") return parsePrimary();
    index += 1;
    const value = parseUnary();
    return value ? scaleLinearValue(value, operator === "-" ? -1 : 1) : null;
  };

  const parseProduct = (): LinearValue | null => {
    let value = parseUnary();
    if (!value) return null;
    while (tokens[index]?.value === "*") {
      index += 1;
      const right = parseUnary();
      if (!right) return null;
      if (value.kind === "scalar") {
        value = scaleLinearValue(right, value.value);
      } else {
        if (right.kind !== "scalar") return null;
        value = scaleLinearValue(value, right.value);
      }
    }
    return value;
  };

  function parseSum(): LinearValue | null {
    let value = parseProduct();
    if (!value) return null;
    while (tokens[index]?.value === "+" || tokens[index]?.value === "-") {
      const operator = tokens[index]?.value;
      index += 1;
      const right = parseProduct();
      if (!right) return null;
      const sign = operator === "-" ? -1 : 1;
      if (value.kind === "scalar") {
        if (right.kind !== "scalar") return null;
        value = { kind: "scalar", value: value.value + sign * right.value };
      } else {
        if (right.kind !== "vector") return null;
        value = { kind: "vector", x: value.x + sign * right.x, y: value.y + sign * right.y };
      }
    }
    return value;
  }

  const value = parseSum();
  return value?.kind === "vector" && index === tokens.length
    && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: value.x, y: value.y }
    : null;
}

function parenthesizedArgument(statement: string, openingParenthesis: number) {
  let depth = 1;
  let escaped = false;
  let quote: "\"" | "'" | null = null;
  for (let index = openingParenthesis + 1; index < statement.length; index += 1) {
    const character = statement[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character !== ")") continue;
    depth -= 1;
    if (depth === 0) return statement.slice(openingParenthesis + 1, index);
  }
  return null;
}

function shiftExpression(statement: string, sourceVariable: string) {
  const variablePattern = sourceVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\b${variablePattern}\\s*\\.\\s*animate\\s*\\.\\s*shift\\s*\\(`,
    "s",
  ).exec(statement);
  if (!match) return null;

  const openingParenthesis = match.index + match[0].length - 1;
  return parenthesizedArgument(statement, openingParenthesis);
}

function moveToExpression(statement: string) {
  const direct = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*move_to\s*\(/s.exec(statement);
  if (direct) {
    const openingParenthesis = direct.index + direct[0].length - 1;
    const expression = parenthesizedArgument(statement, openingParenthesis);
    return expression === null ? null : { expression, sourceVariable: direct[1] };
  }

  const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(statement);
  if (!assignment) return null;
  const constructorChain = /\.\s*move_to\s*\(/s.exec(statement.slice(assignment[0].length));
  if (!constructorChain) return null;
  const openingParenthesis = assignment[0].length + constructorChain.index + constructorChain[0].length - 1;
  const expression = parenthesizedArgument(statement, openingParenthesis);
  return expression === null ? null : { expression, sourceVariable: assignment[1] };
}

function screenDelta(
  vector: Readonly<{ x: number; y: number }>,
  frame: Readonly<{ height: number; width: number }>,
) {
  return {
    x: vector.x * (640 / frame.width),
    y: vector.y * (360 / frame.height),
  };
}

function moveToPosition(
  expression: string,
  byVariable: ReadonlyMap<string, MutableEntity>,
  frame: Readonly<{ height: number; width: number }>,
) {
  const centered = expression.match(
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*get_center\s*\(\s*\)\s*(?:\+\s*(.+))?\s*$/s,
  );
  if (centered) {
    const target = byVariable.get(centered[1]);
    if (!target) return null;
    if (!centered[2]) return { ...target.position };
    const offset = parseLinearVector(centered[2]);
    return offset ? add(target.position, screenDelta(offset, frame)) : null;
  }

  const absolute = parseLinearVector(expression);
  return absolute ? add({ x: 320, y: 180 }, screenDelta(absolute, frame)) : null;
}

function appendPositionSample(
  positionSamples: Map<string, PropertyChannelSample[]>,
  entityId: string,
  sample: PropertyChannelSample,
) {
  const samples = positionSamples.get(entityId) ?? [];
  const previous = samples.at(-1);
  if (previous && previous.interval.end > sample.interval.start) {
    samples[samples.length - 1] = {
      ...previous,
      interval: {
        ...previous.interval,
        end: Math.max(previous.interval.start, sample.interval.start),
      },
    };
  }
  samples.push(sample);
  positionSamples.set(entityId, samples);
}

function shiftedPosition(
  point: Point,
  statement: string,
  sourceVariable: string,
  frame: Readonly<{ height: number; width: number }>,
) {
  const shift = shiftExpression(statement, sourceVariable);
  const vector = shift === null ? null : parseLinearVector(shift);
  if (!vector) return null;
  return add(point, screenDelta(vector, frame));
}

export function importManimScene(
  source: string,
  sourcePath: string,
  sceneName: string,
  frame: Readonly<{ height: number; width: number }> = { height: 8, width: 14.222 },
): ImportedManimScene | null {
  const block = findSourceSceneBlock(source, sceneName);
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
    const match = statement.text.match(ASSIGNMENT_PATTERN);
    if (!match || !SUPPORTED_TYPES.has(match[2])) return;
    const [, sourceVariable, type, argumentsSource] = match;
    const markedIdentity = markerIdentity(statements, index);
    if (sourceVariable.startsWith("poietra_") && !markedIdentity) return;
    const entity: MutableEntity = {
      content: entityContent(type, sourceVariable, argumentsSource),
      id: markedIdentity ?? `source:${sceneId}:${sourceVariable}`,
      initialization: statement.text,
      lifetimes: [],
      position: defaultPosition(mutableEntities.length),
      relation: relationFrom(statement.text),
      sourceVariable,
      type,
    };
    mutableEntities.push(entity);
    byVariable.set(sourceVariable, entity);
  });
  for (const entity of mutableEntities) {
    if (entity.relation) {
      const target = byVariable.get(entity.relation.target);
      if (target) entity.position = add(target.position, relationOffset(entity.relation.direction));
    }
    const surrounded = entity.initialization.match(/SurroundingRectangle\(\s*([A-Za-z_][A-Za-z0-9_]*)/);
    if (surrounded) entity.position = byVariable.get(surrounded[1])?.position ?? entity.position;
  }

  let cursor = 0;
  let firstPlayEnd: number | null = null;
  const events: TimelineEvent[] = [];
  const positionSamples = new Map<string, PropertyChannelSample[]>();
  for (const entity of mutableEntities) {
    positionSamples.set(entity.id, [{
      interval: { end: Number.MAX_SAFE_INTEGER, start: 0 },
      kind: "exact",
      provenanceId: `import:${sceneId}:${entity.sourceVariable}:position`,
      value: entity.position,
    }]);
  }
  for (const statement of statements) {
    const sceneBoundary = statement.text.match(SCENE_BOUNDARY_PATTERN)?.[1];
    if (sceneBoundary) {
      try {
        const parsed = JSON.parse(sceneBoundary) as unknown;
        if (
          typeof parsed === "object"
          && parsed !== null
          && "at" in parsed
          && typeof parsed.at === "number"
          && "destination" in parsed
          && typeof parsed.destination === "string"
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
    const moveTo = moveToExpression(statement.text);
    if (moveTo) {
      const entity = byVariable.get(moveTo.sourceVariable);
      const position = entity ? moveToPosition(moveTo.expression, byVariable, frame) : null;
      if (entity && position) {
        appendPositionSample(positionSamples, entity.id, {
          interval: { end: Number.MAX_SAFE_INTEGER, start: cursor },
          kind: "exact",
          provenanceId: `import:${sceneId}:${entity.sourceVariable}:move-to:${statement.line}`,
          value: position,
        });
        entity.position = position;
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
      const shifted = shiftedPosition(entity.position, statement.text, entity.sourceVariable, frame);
      if (shifted) {
        const from = entity.position;
        const to = shifted;
        appendPositionSample(positionSamples, entity.id, {
          control: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
          easing: "smooth",
          from,
          interval,
          kind: "animated",
          provenanceId: `import:${sceneId}:${entity.sourceVariable}:motion:${statement.line}`,
          value: to,
        });
        entity.position = to;
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
  const entities = Object.fromEntries(mutableEntities.map((entity): [string, RuntimeEntity] => [entity.id, {
    content: entity.content,
    id: entity.id,
    lifetime: entity.lifetimes.map((lifetime) => ({
      end: Math.min(lifetime.end ?? duration, duration),
      start: Math.min(lifetime.start, duration),
    })),
    provisional: false,
    sourceIdentity: { kind: "known", value: entity.sourceVariable },
    type: entity.type,
  }]));
  const propertyChannels: Record<string, PropertyChannel> = Object.fromEntries(mutableEntities.map((entity) => {
    const samples = positionSamples.get(entity.id) ?? [];
    return [`${entity.id}/position`, {
      entityId: entity.id,
      key: "position" as const,
      samples: samples.map((sample) => ({
        ...sample,
        interval: { ...sample.interval, end: Math.min(sample.interval.end, duration) },
      })),
    }];
  }));
  for (const entity of mutableEntities) {
    if (!entity.content) continue;
    propertyChannels[`${entity.id}/content`] = {
      entityId: entity.id,
      key: "content",
      samples: [{
        interval: { end: duration, start: 0 },
        kind: "exact",
        provenanceId: `import:${sceneId}:${entity.sourceVariable}:content`,
        value: entity.content,
      }],
    };
  }
  const runtimeSceneState: RuntimeSceneState = {
    constraintGraph: {
      constraints: mutableEntities.flatMap((entity) => entity.relation ? [{
        id: `import:${sceneId}:${entity.sourceVariable}:next-to`,
        mode: "snapshot" as const,
        operationId: `import:${sceneId}:${entity.sourceVariable}:placement`,
        relation: "next-to" as const,
        sourceEntityId: entity.id,
        targetEntityId: byVariable.get(entity.relation.target)?.id ?? entity.id,
      }] : []),
    },
    duration,
    eventTrack: { events },
    objectGraph: { entities, lineage: [] },
    propertyChannels,
    provenanceGraph: {
      records: [{ evidence: [sourcePath, "conservative static source import"], id: `import:${sceneId}`, origin: "import" }],
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
    .filter((entity) => entity.lifetimes.some((lifetime) => (
      firstPlayEnd === null ? lifetime.start <= 0 : lifetime.start < firstPlayEnd
    )))
    .map((entity) => entity.sourceVariable);
  return {
    anchors,
    initialVisibleSourceVariables,
    initialization: mutableEntities
      .filter((entity) => statements.findIndex((statement) => statement.text === entity.initialization) < firstPlayIndex)
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
