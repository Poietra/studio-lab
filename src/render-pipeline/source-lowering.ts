import { MAX_COORDINATE } from "../engine/primitives";
import { canonicalEditableContent, type EditableContentType } from "../studio/editable-content";
import { MAX_ENTITY_SCALE, MIN_ENTITY_SCALE } from "../studio/magic-edit-capabilities";
import type { EntityContent, MotionEasing } from "../studio/model";
import { operationExecutionCapabilities, programExecutionCapabilities } from "../studio/operation-registry";
import {
  type CanonicalEditOperation,
  type CanonicalEditProgram,
  type CreateEntityOperation,
  EDIT_OPERATION_VERSION,
} from "../studio/operations";
import { insertedProgramDuration } from "../studio/program-composition";
import { samplePropertyKnowledge, samplePropertyValue } from "../studio/property-sampling";
import { scaleTransformViolation, sceneBoundaryViolation } from "../studio/source-lowering-invariants";
import { type ProgramRenderRequest, renderRequestPrograms, type SingleProgramRenderRequest } from "./contracts";
import {
  PythonReferenceAnalysisError,
  pythonReferenceClosure,
  referencedPythonReferences,
} from "./python-reference-analysis";
import { analyzePythonSource, isPythonStatementStart } from "./python-source-analysis";
import {
  findSourceComments,
  findSourceSceneBlock,
  findSourceSceneComments,
  findSourceSceneStatements,
  importManimScene,
  isSimpleShiftAnimationStatement,
} from "./source-import";

export type MotionAnchor = Readonly<{
  line: number;
  seconds: number;
}>;

export type IncomingSceneSetup = Readonly<{
  initialization: readonly string[];
  visibleSourceVariables: readonly string[];
}>;

export type LoweredProgramSource = Readonly<{
  anchorLine: number;
  entityAliases: readonly Readonly<{ entityId: string; sourceVariables: readonly string[] }>[];
  entityBindings: readonly Readonly<{ entityId: string; sourceVariable: string }>[];
  insertedCode: string;
  source: string;
}>;

export type LoweredProgramBatchEntry = Readonly<{
  program: SingleProgramRenderRequest["program"];
  sourceAnchor: number;
}>;

export type LoweredProgramBatchSource = Readonly<{
  anchorLine: number;
  anchorLines: readonly number[];
  insertedCode: string;
  preflight?: Readonly<{
    baseSourceHash: typeof WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9;
    kind:
      | "fast-manim-line-joints-v10"
      | "fast-manim-opening-terminal-v2"
      | "fast-manim-square-to-circle-v8"
      | "fast-manim-updaters-terminal-v1"
      | "fast-manim-warp-square-v9"
      | "fast-manim-write-stuff-v12";
  }>;
  source: string;
}>;

type ProgramSourceLoweringOptions = Readonly<{
  entityAliases?: ReadonlyMap<string, ReadonlySet<string>>;
  entityScaleStates?: Map<string, SourceScaleState>;
  finiteCreatedLifetimesHandled?: boolean;
  generatedEntityIds?: ReadonlySet<string>;
  reservedSourceVariables?: ReadonlySet<string>;
  sourceAnchor?: number;
}>;

type SourceScaleState =
  | Readonly<{
      factor: number;
      kind: "relative-to-source";
    }>
  | Readonly<{
      kind: "absolute";
      value: number;
    }>;

export class ProgramLoweringError extends Error {
  constructor(
    readonly code:
      | "anchor-missing"
      | "destination-missing"
      | "operation-unsupported"
      | "source-variable-missing"
      | "zero-delta",
    message: string,
  ) {
    super(message);
    this.name = "ProgramLoweringError";
  }
}

const ANCHOR_PATTERN = /^\s*#\s*poietra:anchor\s+([0-9]+(?:\.[0-9]+)?)\s*$/;
const CURSOR_PATTERN = /^\s*#\s*poietra:cursor\s+([0-9]+(?:\.[0-9]+)?)\s*$/;
const SCENE_BOUNDARY_PATTERN = /^\s*#\s*poietra:scene-boundary\s+(.+)\s*$/;
const EPSILON = 0.0005;
const SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_PATH_V8 = "example_scenes/basic.py";
const SQUARE_TO_CIRCLE_SCENE_NAME_V8 = "SquareToCircle";
const SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8 =
  "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f" as const;
const WARP_SQUARE_OFFICIAL_SOURCE_PATH_V9 = "example_scenes/basic.py";
const WARP_SQUARE_SCENE_NAME_V9 = "WarpSquare";
const WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9 =
  "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f" as const;
const LINE_JOINTS_OFFICIAL_SOURCE_PATH_V10 = "example_scenes/basic.py";
const LINE_JOINTS_SCENE_NAME_V10 = "LineJoints";
const LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10 = WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9;
const WRITE_STUFF_OFFICIAL_SOURCE_PATH_V12 = "example_scenes/basic.py";
const WRITE_STUFF_SCENE_NAME_V12 = "WriteStuff";
const WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12 = WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9;
const UPDATERS_TERMINAL_OFFICIAL_SOURCE_PATH_V1 = "example_scenes/basic.py";
const UPDATERS_TERMINAL_SCENE_NAME_V1 = "UpdatersExample";
const UPDATERS_TERMINAL_OFFICIAL_SOURCE_SHA256_V1 = WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9;
const UPDATERS_TERMINAL_SOURCE_TIME_V1 = 5;
const OPENING_TERMINAL_OFFICIAL_SOURCE_PATH_V2 = "example_scenes/basic.py";
const OPENING_TERMINAL_SCENE_NAME_V2 = "OpeningManim";
const OPENING_TERMINAL_OFFICIAL_SOURCE_SHA256_V2 = WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9;
const OPENING_TERMINAL_SOURCE_TIME_V2 = 14;

type TemporalSourceMarker =
  | Readonly<{
      kind: "anchor" | "cursor";
      line: number;
      seconds: number;
    }>
  | Readonly<{
      kind: "scene-boundary";
      line: number;
      payload: Readonly<Record<string, unknown>>;
      seconds: number;
    }>;

type SourceTimeInsertion = Readonly<{
  anchorLine: number;
  duration: number;
  sourceAnchor: number;
}>;

export function findMotionAnchors(source: string): readonly MotionAnchor[] {
  return findSourceComments(source).flatMap((comment) => {
    const match = comment.text.match(ANCHOR_PATTERN);
    return match ? [{ line: comment.line, seconds: Number(match[1]) }] : [];
  });
}

export function findSceneMotionAnchors(
  source: string,
  sceneName: string,
  sourcePath = "<source>",
): readonly MotionAnchor[] {
  return findSourceSceneComments(source, sceneName, sourcePath).flatMap((comment) => {
    const match = comment.text.match(ANCHOR_PATTERN);
    return match ? [{ line: comment.line, seconds: Number(match[1]) }] : [];
  });
}

function sceneTemporalMarkers(source: string, sceneName: string, sourcePath: string): readonly TemporalSourceMarker[] {
  return findSourceSceneComments(source, sceneName, sourcePath).flatMap((comment): readonly TemporalSourceMarker[] => {
    const anchor = comment.text.match(ANCHOR_PATTERN);
    if (anchor) return [{ kind: "anchor", line: comment.line, seconds: Number(anchor[1]) }];
    const cursor = comment.text.match(CURSOR_PATTERN);
    if (cursor) return [{ kind: "cursor", line: comment.line, seconds: Number(cursor[1]) }];
    const boundary = comment.text.match(SCENE_BOUNDARY_PATTERN);
    if (!boundary) return [];
    try {
      const payload = JSON.parse(boundary[1]) as unknown;
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        !("at" in payload) ||
        typeof payload.at !== "number" ||
        !Number.isFinite(payload.at) ||
        payload.at < 0 ||
        !("destination" in payload) ||
        typeof payload.destination !== "string"
      )
        return [];
      return [{ kind: "scene-boundary", line: comment.line, payload, seconds: payload.at }];
    } catch {
      // Malformed Studio-looking comments are inert metadata and must never be partially rewritten.
      return [];
    }
  });
}

function formatAmount(value: number) {
  const normalized = Math.abs(value) < 0.00005 ? 0 : value;
  return Number(normalized.toFixed(4)).toString();
}

function formatPointCoordinate(value: number) {
  const normalized = Math.abs(value) < 0.0000000000005 ? 0 : value;
  return Number(normalized.toFixed(12)).toString();
}

function formatShiftAmount(value: number) {
  const formatted = formatAmount(Math.abs(value));
  return formatted === "0" && value !== 0 ? Number(Math.abs(value).toPrecision(4)).toString() : formatted;
}

function formatPositiveAmount(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProgramLoweringError("operation-unsupported", "A positive finite Manim size is required.");
  }
  return Number(value.toPrecision(12)).toString();
}

function rewriteSceneTemporalMetadata(
  source: string,
  sceneName: string,
  sourcePath: string,
  lines: string[],
  insertions: readonly SourceTimeInsertion[],
) {
  for (const marker of sceneTemporalMarkers(source, sceneName, sourcePath)) {
    // At an equal timestamp, source order decides which side of the insertion owns the marker.
    // This keeps metadata before the consumed anchor unchanged while moving metadata after it.
    const offset = insertions.reduce(
      (total, insertion) =>
        insertion.sourceAnchor < marker.seconds - EPSILON ||
        (Math.abs(insertion.sourceAnchor - marker.seconds) < EPSILON && insertion.anchorLine <= marker.line)
          ? total + insertion.duration
          : total,
      0,
    );
    if (Math.abs(offset) < 0.00005) continue;
    const shiftedSeconds = Number(formatAmount(marker.seconds + offset));
    const index = marker.line - 1;
    const indentation = lines[index]?.match(/^\s*/)?.[0] ?? "";
    if (marker.kind === "scene-boundary") {
      lines[index] = `${indentation}# poietra:scene-boundary ${JSON.stringify({
        ...marker.payload,
        at: shiftedSeconds,
      })}`;
    } else {
      lines[index] = `${indentation}# poietra:${marker.kind} ${formatAmount(shiftedSeconds)}`;
    }
  }
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shiftExpression(
  delta: Readonly<{ x: number; y: number }>,
  frame: Readonly<{ height: number; width: number }>,
  viewport: Readonly<{ height: number; width: number }>,
) {
  const worldX = (delta.x / viewport.width) * frame.width;
  const worldY = (-delta.y / viewport.height) * frame.height;
  const terms = [
    worldX !== 0 ? `${formatShiftAmount(worldX)} * ${worldX > 0 ? "RIGHT" : "LEFT"}` : null,
    worldY !== 0 ? `${formatShiftAmount(worldY)} * ${worldY > 0 ? "UP" : "DOWN"}` : null,
  ].filter((term): term is string => term !== null);
  if (terms.length === 0) {
    throw new ProgramLoweringError("zero-delta", "CreateMotion has no visible displacement to render.");
  }
  return terms.join(" + ");
}

function offsetExpression(
  offset: Readonly<{ x: number; y: number }>,
  frame: Readonly<{ height: number; width: number }>,
  viewport: Readonly<{ height: number; width: number }>,
) {
  if (Math.abs(offset.x) < 0.0001 && Math.abs(offset.y) < 0.0001) return "ORIGIN";
  return shiftExpression(offset, frame, viewport);
}

function centerWithOffsetExpression(
  variable: string,
  offset: Readonly<{ x: number; y: number }>,
  frame: Readonly<{ height: number; width: number }>,
  viewport: Readonly<{ height: number; width: number }>,
) {
  const expression = offsetExpression(offset, frame, viewport);
  return expression === "ORIGIN" ? `${variable}.get_center()` : `${variable}.get_center() + ${expression}`;
}

function quadraticMotionExpression(
  variable: string,
  delta: Readonly<{ x: number; y: number }>,
  controlOffset: Readonly<{ x: number; y: number }>,
  frame: Readonly<{ height: number; width: number }>,
  viewport: Readonly<{ height: number; width: number }>,
) {
  // Manim exposes CubicBezier paths. These handles are the exact cubic
  // representation of the Studio quadratic whose control point is
  // midpoint(start, end) + controlOffset.
  const startHandleOffset = {
    x: delta.x / 3 + (controlOffset.x * 2) / 3,
    y: delta.y / 3 + (controlOffset.y * 2) / 3,
  };
  const endHandleOffset = {
    x: (delta.x * 2) / 3 + (controlOffset.x * 2) / 3,
    y: (delta.y * 2) / 3 + (controlOffset.y * 2) / 3,
  };
  const start = `${variable}.get_center()`;
  return `MoveAlongPath(${variable}, CubicBezier(${start}, ${centerWithOffsetExpression(variable, startHandleOffset, frame, viewport)}, ${centerWithOffsetExpression(variable, endHandleOffset, frame, viewport)}, ${centerWithOffsetExpression(variable, delta, frame, viewport)}))`;
}

function pointExpression(
  point: Readonly<{ x: number; y: number }>,
  frame: Readonly<{ height: number; width: number }>,
  viewport: Readonly<{ height: number; width: number }>,
  cameraCenter: Readonly<{ x: number; y: number }> = { x: 0, y: 0 },
) {
  const x = cameraCenter.x + (point.x / viewport.width - 0.5) * frame.width;
  const y = cameraCenter.y + (0.5 - point.y / viewport.height) * frame.height;
  // An absolute point must stay executable even when a source uses explicit
  // Manim imports. A numeric point tuple is accepted by Mobject.move_to and
  // does not silently depend on RIGHT/LEFT/UP/DOWN/ORIGIN being in scope.
  return `(${formatPointCoordinate(x)}, ${formatPointCoordinate(y)}, 0)`;
}

function markerPoint(point: Readonly<{ x: number; y: number }>, viewport: Readonly<{ height: number; width: number }>) {
  return {
    x: Number(((point.x / viewport.width) * 640).toFixed(12)),
    y: Number(((point.y / viewport.height) * 360).toFixed(12)),
  };
}

const SOURCE_MARKER_VIEWPORT = { height: 360, width: 640 } as const;

function sourceMarker(
  kind: "content" | "dimensions" | "motion" | "position" | "scale",
  value: Readonly<Record<string, unknown>>,
) {
  return `# poietra:${kind} ${JSON.stringify({ ...value, version: 1 })}`;
}

type StaticTransformPair =
  | Readonly<{
      callLine: number;
      kind: "position";
      markerLine: number;
      variable: string;
    }>
  | Readonly<{
      callLine: number;
      factor: number;
      kind: "scale";
      markerLine: number;
      value: number;
      variable: string;
    }>;

function jsonRecord(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function staticTransformPairAt(
  lines: readonly string[],
  callLine: number,
  frame: Readonly<{ height: number; width: number }>,
  cameraCenter: Readonly<{ x: number; y: number }>,
): StaticTransformPair | null {
  if (callLine < 1) return null;
  const markerLine = callLine - 1;
  const marker = lines[markerLine] ?? "";
  const call = lines[callLine] ?? "";
  const position = marker.match(/^(\s*)#\s*poietra:position\s+(.+)\s*$/);
  if (position) {
    const parsed = jsonRecord(position[2]);
    const value = parsed?.value;
    if (
      !parsed ||
      !hasExactKeys(parsed, ["kind", "value", "variable", "version"]) ||
      parsed.kind !== "absolute" ||
      parsed.version !== 1 ||
      typeof parsed.variable !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.variable) ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !hasExactKeys(value as Record<string, unknown>, ["x", "y"]) ||
      !("x" in value) ||
      !("y" in value) ||
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y)
    ) {
      return null;
    }
    const point = { x: value.x, y: value.y } as Readonly<{ x: number; y: number }>;
    const expected = `${position[1]}${parsed.variable}.move_to(${pointExpression(
      point,
      frame,
      SOURCE_MARKER_VIEWPORT,
      cameraCenter,
    )})`;
    return call === expected ? { callLine, kind: "position", markerLine, variable: parsed.variable } : null;
  }

  const scale = marker.match(/^(\s*)#\s*poietra:scale\s+(.+)\s*$/);
  if (!scale) return null;
  const parsed = jsonRecord(scale[2]);
  if (
    !parsed ||
    !hasExactKeys(parsed, ["kind", "value", "variable", "version"]) ||
    parsed.kind !== "exact" ||
    parsed.version !== 1 ||
    typeof parsed.value !== "number" ||
    !Number.isFinite(parsed.value) ||
    parsed.value <= 0 ||
    typeof parsed.variable !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.variable)
  ) {
    return null;
  }
  const escapedVariable = escapePattern(parsed.variable);
  const factorExpression = call.match(
    new RegExp(`^${escapePattern(scale[1])}${escapedVariable}\\.scale\\(([^()]*)\\)$`),
  )?.[1];
  if (!factorExpression || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(factorExpression.trim())) return null;
  const factor = Number(factorExpression);
  return Number.isFinite(factor) && factor > 0
    ? { callLine, factor, kind: "scale", markerLine, value: parsed.value, variable: parsed.variable }
    : null;
}

/**
 * A committed zero-duration edit is imported as source-proven geometry. A
 * later edit at that same anchor must not grow an unbounded chain of
 * move_to/scale calls. Collapse only exact Studio marker + literal call pairs;
 * unmarked or altered Python remains user-owned and is never rewritten.
 */
function collapseRepeatedStaticTransformHistory(
  source: string,
  frame: Readonly<{ height: number; width: number }>,
  cameraCenter: Readonly<{ x: number; y: number }>,
  currentTransactionIds: ReadonlySet<string>,
  sceneName: string,
  sourcePath: string,
) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const sceneBlock = findSourceSceneBlock(source, sceneName, sourcePath);
  if (!sceneBlock || sceneBlock.bodyIndent === null) return source;
  const directSceneLines = new Set(findSourceSceneStatements(source, sceneName, sourcePath).map(({ line }) => line));
  for (
    let anchorLine = Math.min(lines.length, sceneBlock.bodyEnd) - 1;
    anchorLine >= sceneBlock.bodyStart;
    anchorLine -= 1
  ) {
    if (!directSceneLines.has(anchorLine)) continue;
    const anchor = lines[anchorLine]?.match(/^\s*#\s*poietra:anchor\s+([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (!anchor) continue;
    const anchorSeconds = Number(anchor[1]);
    const cursorLines: number[] = [];
    const transactionLines: Array<Readonly<{ id: string; line: number }>> = [];
    const pairs: StaticTransformPair[] = [];
    let line = anchorLine - 1;
    while (line >= 0) {
      if (!directSceneLines.has(line)) break;
      const cursor = lines[line]?.match(/^\s*#\s*poietra:cursor\s+([0-9]+(?:\.[0-9]+)?)\s*$/);
      if (cursor && Math.abs(Number(cursor[1]) - anchorSeconds) < EPSILON) {
        cursorLines.push(line);
        line -= 1;
        continue;
      }
      const transaction = lines[line]?.match(/^\s*#\s*poietra:transaction\s+(.+)\s*$/);
      if (transaction) {
        try {
          const id = JSON.parse(transaction[1]) as unknown;
          if (typeof id !== "string") break;
          transactionLines.push({ id, line });
          line -= 1;
          continue;
        } catch {
          break;
        }
      }
      const pair = staticTransformPairAt(lines, line, frame, cameraCenter);
      if (!pair || !directSceneLines.has(pair.markerLine)) break;
      pairs.push(pair);
      line = pair.markerLine - 1;
    }
    if (
      cursorLines.length < 2 ||
      pairs.length === 0 ||
      !transactionLines.some(({ id }) => currentTransactionIds.has(id))
    ) {
      continue;
    }

    const orderedPairs = [...pairs].reverse();
    const latestPair = new Map<string, StaticTransformPair>();
    const scaleProducts = new Map<string, number>();
    const scaleValues = new Map<string, number>();
    let inconsistentScaleMarker = false;
    for (const pair of orderedPairs) {
      latestPair.set(`${pair.kind}:${pair.variable}`, pair);
      if (pair.kind === "scale") {
        const previousValue = scaleValues.get(pair.variable);
        const expectedValue = previousValue === undefined ? pair.value : previousValue * pair.factor;
        if (Math.abs(pair.value - expectedValue) > EPSILON * Math.max(1, pair.value, expectedValue)) {
          inconsistentScaleMarker = true;
          break;
        }
        scaleProducts.set(pair.variable, (scaleProducts.get(pair.variable) ?? 1) * pair.factor);
        scaleValues.set(pair.variable, pair.value);
      }
    }
    if (inconsistentScaleMarker) continue;
    const removed = new Set<number>();
    for (const pair of orderedPairs) {
      if (latestPair.get(`${pair.kind}:${pair.variable}`) !== pair) {
        removed.add(pair.markerLine);
        removed.add(pair.callLine);
      }
    }
    for (const pair of latestPair.values()) {
      if (pair.kind !== "scale") continue;
      const indentation = lines[pair.callLine]?.match(/^\s*/)?.[0] ?? "";
      lines[pair.callLine] =
        `${indentation}${pair.variable}.scale(${formatPositiveAmount(scaleProducts.get(pair.variable) ?? 1)})`;
    }
    const firstCursor = Math.min(...cursorLines);
    for (const cursorLine of cursorLines) {
      if (cursorLine !== firstCursor) removed.add(cursorLine);
    }
    for (const transaction of transactionLines) {
      if (!currentTransactionIds.has(transaction.id)) removed.add(transaction.line);
    }
    lines.splice(
      line + 1,
      anchorLine - line - 1,
      ...lines.slice(line + 1, anchorLine).filter((_, index) => !removed.has(line + 1 + index)),
    );
  }
  return lines.join(newline);
}

type CanonicalInsertionEvidence = Readonly<{
  anchorLine: number;
  anchorLines: readonly number[];
  insertedCode: string;
}>;

/**
 * Rebuild render evidence from the final source bytes. Compaction can remove
 * an appended cursor, retain an older Studio-owned position, and replace a
 * relative scale call with its canonical product. The evidence returned to a
 * render session must therefore be selected after compaction instead of from
 * the lowering buffer that existed before it.
 */
function canonicalInsertionEvidence(
  source: string,
  currentTransactionIds: ReadonlySet<string>,
  sceneName: string,
  sourcePath: string,
): CanonicalInsertionEvidence {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const sceneBlock = findSourceSceneBlock(source, sceneName, sourcePath);
  if (!sceneBlock || sceneBlock.bodyIndent === null) {
    throw new ProgramLoweringError(
      "anchor-missing",
      `Canonical source evidence for ${sceneName} is unavailable in ${sourcePath}.`,
    );
  }
  const directSceneLines = new Set(findSourceSceneStatements(source, sceneName, sourcePath).map(({ line }) => line));
  const evidenceBlocks: Array<
    Readonly<{
      anchorLine: number;
      insertedLines: readonly string[];
      transactionIds: readonly string[];
    }>
  > = [];
  let cursorLine: number | null = null;
  let transactionIds: string[] = [];

  for (let line = sceneBlock.bodyStart; line < sceneBlock.bodyEnd; line += 1) {
    if (!directSceneLines.has(line)) continue;
    if (/^\s*#\s*poietra:cursor\s+[0-9]+(?:\.[0-9]+)?\s*$/.test(lines[line] ?? "")) {
      cursorLine = line;
      transactionIds = [];
      continue;
    }
    if (cursorLine === null) continue;

    const transaction = lines[line]?.match(/^\s*#\s*poietra:transaction\s+(.+)\s*$/);
    if (transaction) {
      try {
        const id = JSON.parse(transaction[1]) as unknown;
        if (typeof id === "string" && currentTransactionIds.has(id)) transactionIds.push(id);
      } catch {
        // A malformed user-owned marker is not evidence for this lowering.
      }
    }
    if (!/^\s*#\s*poietra:anchor\s+[0-9]+(?:\.[0-9]+)?\s*$/.test(lines[line] ?? "")) continue;
    if (transactionIds.length > 0) {
      evidenceBlocks.push({
        anchorLine: cursorLine + 1,
        insertedLines: lines.slice(cursorLine + 1, line),
        transactionIds,
      });
    }
    cursorLine = null;
    transactionIds = [];
  }

  const evidenceTransactionCounts = new Map<string, number>();
  for (const id of evidenceBlocks.flatMap((block) => block.transactionIds)) {
    evidenceTransactionCounts.set(id, (evidenceTransactionCounts.get(id) ?? 0) + 1);
  }
  const invalidTransactionId = [...currentTransactionIds].find((id) => evidenceTransactionCounts.get(id) !== 1);
  if (invalidTransactionId || evidenceBlocks.length === 0) {
    throw new ProgramLoweringError(
      "anchor-missing",
      invalidTransactionId
        ? `Canonical source evidence for transaction ${invalidTransactionId} is not unique in ${sourcePath}.`
        : `Canonical source evidence for ${sceneName} is unavailable in ${sourcePath}.`,
    );
  }

  const anchorLines = evidenceBlocks.map((block) => block.anchorLine);
  return {
    anchorLine: anchorLines[0]!,
    anchorLines,
    insertedCode: evidenceBlocks.flatMap((block) => block.insertedLines).join(newline),
  };
}

function variableToken(transactionId: string, index: number) {
  const normalized = transactionId
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([^A-Za-z_])/, "_$1")
    .slice(0, 48);
  return `poietra_${normalized || "edit"}_${index + 1}`;
}

function variableAllocator(source: string, transactionId: string, additionalReserved: ReadonlySet<string> = new Set()) {
  const reserved = new Set([...(source.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []), ...additionalReserved]);
  let index = 0;
  return () => {
    const base = variableToken(transactionId, index);
    index += 1;
    let variable = base;
    let suffix = 2;
    while (reserved.has(variable)) {
      variable = `${base}_${suffix}`;
      suffix += 1;
    }
    reserved.add(variable);
    return variable;
  };
}

function entityConstructor(operation: CreateEntityOperation) {
  const { content, dimensions, type } = operation.entity;
  if (type === "MathTex") {
    const parts = content?.texParts?.length ? content.texParts : content?.displayLines;
    if (!parts?.length) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        "MathTex creation requires canonical texParts or displayLines.",
      );
    }
    return `MathTex(${parts.map((part) => JSON.stringify(part)).join(", ")})`;
  }
  if (type === "Text") {
    const text = content?.text ?? content?.displayLines.join(" ") ?? "";
    return `Text(${JSON.stringify(text)})`;
  }
  const shapeConstructor = {
    Arrow: "Arrow(LEFT, RIGHT, buff=0)",
    Circle: `Circle(radius=${formatAmount(dimensions?.radius ?? 1)})`,
    Line: "Line(LEFT, RIGHT)",
    Rectangle: `Rectangle(width=${formatAmount(dimensions?.width ?? 4)}, height=${formatAmount(dimensions?.height ?? 2)})`,
    Square: "Square(side_length=2)",
  }[type];
  if (shapeConstructor) return shapeConstructor;
  if (type.startsWith("TransitionOverlay:")) {
    const [, shape, color] = type.split(":");
    const constructor = {
      circle: "Circle(radius=1)",
      diamond: "Square(side_length=2).rotate(PI / 4)",
      hexagon: "RegularPolygon(6, radius=1)",
    }[shape];
    const fill = { black: "BLACK", sky: "BLUE_D", white: "WHITE" }[color];
    if (!constructor || !fill) {
      throw new ProgramLoweringError("operation-unsupported", `Unsupported transition overlay ${type}.`);
    }
    return `${constructor}.set_fill(${fill}, opacity=1).set_stroke(width=0).scale(0.01)`;
  }
  throw new ProgramLoweringError("operation-unsupported", `CreateEntity type ${type} has no safe Manim lowering.`);
}

function referencedBaseEntityIds(operations: readonly CanonicalEditOperation[]) {
  const created = new Set(
    operations.flatMap((operation) => {
      if (operation.kind === "CreateEntity") return [operation.entity.id];
      if (operation.kind === "TransformContent") return [operation.targetEntityId];
      return [];
    }),
  );
  const referenced = operations.flatMap((operation): readonly string[] => {
    if (operation.kind === "CreateMotion") return operation.targetEntityIds;
    if (
      operation.kind === "SetProperty" ||
      operation.kind === "AnimateProperty" ||
      operation.kind === "ChangePresence" ||
      operation.kind === "ResizeEntity"
    ) {
      return [operation.entityId];
    }
    if (operation.kind === "TransformContent") return [operation.sourceEntityId];
    if (operation.kind === "SetRelation") return [operation.sourceEntityId, operation.targetEntityId];
    return [];
  });
  return [...new Set(referenced.filter((entityId) => !created.has(entityId)))];
}

function operationTime(operation: CanonicalEditOperation) {
  return operation.kind === "InsertSceneBoundary" ? operation.at : operation.interval.start;
}

function isPoint(value: unknown): value is Readonly<{ x: number; y: number }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number"
  );
}

function contentTarget(value: unknown): Readonly<{
  content: EntityContent;
  constructor: string;
  type: "MathTex" | "Text";
}> | null {
  const candidate = value as Partial<EntityContent> | null;
  const type: EditableContentType | null =
    typeof candidate?.text === "string" ? "Text" : Array.isArray(candidate?.texParts) ? "MathTex" : null;
  if (!type) return null;
  const content = canonicalEditableContent(value, type);
  if (!content) return null;
  if (type === "Text" && content.text !== undefined) {
    return { content, constructor: `Text(${JSON.stringify(content.text)})`, type: "Text" };
  }
  if (!content.texParts) return null;
  return {
    content,
    constructor: `MathTex(${content.texParts.map((part) => JSON.stringify(part)).join(", ")})`,
    type: "MathTex",
  };
}

function contentReplacementExpression(variable: string, target: NonNullable<ReturnType<typeof contentTarget>>) {
  return (
    `${variable}.become(${target.constructor}` +
    `.match_style(${variable})` +
    `.match_height(${variable})` +
    `.move_to(${variable}.get_center()))`
  );
}

type LoweredAnimationOperation = Extract<
  CanonicalEditOperation,
  {
    kind: "AnimateProperty" | "ChangePresence" | "CreateMotion" | "ResizeEntity" | "TransformContent";
  }
>;

function animationOperation(operation: CanonicalEditOperation): operation is LoweredAnimationOperation {
  return (
    operation.kind === "ChangePresence" ||
    operation.kind === "CreateMotion" ||
    operation.kind === "ResizeEntity" ||
    operation.kind === "TransformContent" ||
    (operation.kind === "AnimateProperty" && operation.key === "scale")
  );
}

function animationEasing(operation: LoweredAnimationOperation): MotionEasing {
  return operation.kind === "CreateMotion" || operation.kind === "AnimateProperty" ? operation.easing : "smooth";
}

function scaleChange(operation: Extract<CanonicalEditOperation, { kind: "AnimateProperty" }>) {
  if (
    operation.key !== "scale" ||
    typeof operation.from !== "number" ||
    typeof operation.to !== "number" ||
    !Number.isFinite(operation.from) ||
    !Number.isFinite(operation.to) ||
    operation.from <= 0 ||
    operation.to <= 0
  ) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Scale animation requires finite positive absolute from and to values.",
    );
  }
  const capturedFactor = operation.to / operation.from;
  if (
    operation.relativeFactor !== undefined &&
    (!Number.isFinite(operation.relativeFactor) ||
      operation.relativeFactor <= 0 ||
      Math.abs(capturedFactor - operation.relativeFactor) >= 0.000001)
  ) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "A relative scale factor must be finite, positive, and match its captured absolute scale pair.",
    );
  }
  return {
    factor: operation.relativeFactor ?? capturedFactor,
    from: operation.from,
    to: operation.to,
  };
}

function resizeExpression(
  variable: string,
  operation: Extract<CanonicalEditOperation, { kind: "ResizeEntity" }>,
  frame: Readonly<{ height: number; width: number }>,
  viewport: Readonly<{ height: number; width: number }>,
  cameraCenter: Readonly<{ x: number; y: number }>,
  animated: boolean,
) {
  const target = operation.to.dimensions;
  const prefix = `${variable}${animated ? ".animate" : ""}`;
  const width =
    operation.shape === "circle" ? 2 * (target.radius ?? 0) * operation.scale : (target.width ?? 0) * operation.scale;
  const height = operation.shape === "rectangle" ? (target.height ?? 0) * operation.scale : null;
  if (!Number.isFinite(width) || width <= 0 || (height !== null && (!Number.isFinite(height) || height <= 0))) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "ResizeEntity produces a non-finite or non-positive Manim size.",
    );
  }
  const resize =
    operation.shape === "circle"
      ? `${prefix}.scale_to_fit_width(${formatPositiveAmount(width)})`
      : `${prefix}.stretch_to_fit_width(${formatPositiveAmount(width)})` +
        `.stretch_to_fit_height(${formatPositiveAmount(height ?? 0)})`;
  return `${resize}.move_to(${pointExpression(operation.to.position, frame, viewport, cameraCenter)})`;
}

function resizeMarkerEntry(
  variable: string,
  operation: Extract<CanonicalEditOperation, { kind: "ResizeEntity" }>,
  viewport: Readonly<{ height: number; width: number }>,
) {
  return {
    from: { dimensions: operation.from.dimensions, position: markerPoint(operation.from.position, viewport) },
    scale: operation.scale,
    shape: operation.shape,
    to: { dimensions: operation.to.dimensions, position: markerPoint(operation.to.position, viewport) },
    variable,
  } as const;
}

function assertLoweringSupported(operation: CanonicalEditOperation, options: ProgramSourceLoweringOptions) {
  if (operation.kind === "CreateEntity") {
    if (
      operation.entity.lifetime.end !== null &&
      !operation.entity.type.startsWith("TransitionOverlay:") &&
      !options.finiteCreatedLifetimesHandled
    ) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        "A finite created lifetime must be lowered through the batch source pipeline.",
      );
    }
  }
  if (operation.kind === "SetProperty" && operation.key === "content" && contentTarget(operation.value)) return;
  const execution = operationExecutionCapabilities(operation);
  if (execution.lowering === "supported") return;
  throw new ProgramLoweringError(
    "operation-unsupported",
    execution.applyBlocker ?? `${operation.kind} has no truthful source lowering.`,
  );
}

function requireVariable(variables: ReadonlyMap<string, string>, entityId: string) {
  const variable = variables.get(entityId);
  if (!variable)
    throw new ProgramLoweringError("source-variable-missing", `No source variable exists for ${entityId}.`);
  return variable;
}

function sourceThroughAnchor(
  source: string,
  sceneBlock: NonNullable<ReturnType<typeof findSourceSceneBlock>>,
  anchorLine: number,
) {
  const lines = source.split(/\r?\n/);
  lines.splice(anchorLine, Math.max(0, sceneBlock.bodyEnd - anchorLine));
  return lines.join(source.includes("\r\n") ? "\r\n" : "\n");
}

type ResolvedScaleChange = Readonly<{
  factor: number;
  from: number;
  to: number;
}>;

function resolveScaleChangesAndTransforms(
  source: string,
  sourcePath: string,
  sceneName: string,
  sceneBlock: NonNullable<ReturnType<typeof findSourceSceneBlock>>,
  anchorLine: number,
  sourceAnchor: number,
  operations: readonly CanonicalEditOperation[],
  sourceBindings: ReadonlyMap<string, string>,
  generatedEntityIds: ReadonlySet<string> | undefined,
  entityScaleStates: Map<string, SourceScaleState> | undefined,
  frame: Readonly<{ height: number; width: number }>,
) {
  const scales = operations.filter(
    (
      operation,
    ): operation is Extract<
      CanonicalEditOperation,
      {
        kind: "AnimateProperty";
      }
    > => operation.kind === "AnimateProperty" && operation.key === "scale",
  );
  const transforms = operations.filter(
    (
      operation,
    ): operation is Extract<
      CanonicalEditOperation,
      {
        kind: "TransformContent";
      }
    > => operation.kind === "TransformContent",
  );
  let imported: ReturnType<typeof importManimScene> | undefined;
  const sourceScale = (entityId: string) => {
    imported ??=
      importManimScene(sourceThroughAnchor(source, sceneBlock, anchorLine), sourcePath, sceneName, frame) ?? undefined;
    if (!imported) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        "Object-edit lowering cannot verify the source scale at the selected anchor.",
      );
    }
    const sourceVariable = sourceBindings.get(entityId);
    const entity = sourceVariable
      ? Object.values(imported.runtimeSceneState.objectGraph.entities).find(
          (candidate) => candidate.sourceIdentity.kind === "known" && candidate.sourceIdentity.value === sourceVariable,
        )
      : undefined;
    const samples = entity ? (imported.runtimeSceneState.propertyChannels[`${entity.id}/scale`]?.samples ?? []) : [];
    const value = samplePropertyValue(samples, sourceAnchor);
    const numericValue = typeof value === "number" ? value : undefined;
    const knowledge = samplePropertyKnowledge(samples, sourceAnchor, numericValue);
    if (knowledge?.kind !== "known" || !Number.isFinite(knowledge.value) || knowledge.value <= 0) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Object-edit lowering cannot verify a finite positive source scale for ${entityId} at the selected anchor.`,
      );
    }
    return knowledge.value;
  };
  const createdScales = new Map(
    operations.flatMap((operation) =>
      operation.kind === "CreateEntity"
        ? [[operation.entity.id, operation.entity.type.startsWith("TransitionOverlay:") ? 0.01 : 1] as const]
        : [],
    ),
  );
  const currentScales = new Map<string, number>();
  const currentScaleStates = new Map<string, SourceScaleState>();
  for (const [entityId, scale] of createdScales) {
    const state = { kind: "absolute", value: scale } as const;
    currentScaleStates.set(entityId, state);
    entityScaleStates?.set(entityId, state);
  }
  const effectiveScale = (entityId: string) => {
    const current = currentScales.get(entityId);
    if (current !== undefined) return { current, state: currentScaleStates.get(entityId) };
    let state = currentScaleStates.get(entityId) ?? entityScaleStates?.get(entityId);
    if (state?.kind === "absolute") return { current: state.value, state };
    if (state?.kind === "relative-to-source") {
      return { current: sourceScale(entityId) * state.factor, state };
    }
    const created = createdScales.get(entityId);
    if (created !== undefined) {
      state = { kind: "absolute", value: created };
      return { current: created, state };
    }
    if (generatedEntityIds?.has(entityId)) {
      state = { kind: "absolute", value: 1 };
      return { current: 1, state };
    }
    state = { factor: 1, kind: "relative-to-source" };
    return { current: sourceScale(entityId), state };
  };
  const resolvedChanges = new Map<string, ResolvedScaleChange>();
  for (const operation of scales) {
    const captured = scaleChange(operation);
    const { current, state } = effectiveScale(operation.entityId);
    const tolerance = Math.max(EPSILON, Math.abs(current) * 0.000001);
    if (operation.relativeFactor === undefined && Math.abs(captured.from - current) >= tolerance) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Scale operation ${operation.id} expects ${formatAmount(captured.from)}x but source is ${formatAmount(current)}x at that point.`,
      );
    }
    const change: ResolvedScaleChange = {
      factor: captured.factor,
      from: current,
      to: current * captured.factor,
    };
    if (!Number.isFinite(change.to) || change.to < MIN_ENTITY_SCALE || change.to > MAX_ENTITY_SCALE) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Scale operation ${operation.id} must resolve between ${MIN_ENTITY_SCALE}x and ${MAX_ENTITY_SCALE}x.`,
      );
    }
    resolvedChanges.set(operation.id, change);
    currentScales.set(operation.entityId, change.to);
    const nextState: SourceScaleState =
      state?.kind === "relative-to-source"
        ? { factor: state.factor * change.factor, kind: "relative-to-source" }
        : { kind: "absolute", value: change.to };
    currentScaleStates.set(operation.entityId, nextState);
    entityScaleStates?.set(operation.entityId, nextState);
  }
  for (const operation of transforms) {
    const { current } = effectiveScale(operation.sourceEntityId);
    if (!Number.isFinite(current) || Math.abs(current - 1) >= EPSILON) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `TransformContent requires ${operation.sourceEntityId} to have an effective 1x scale; source lowering resolved ${formatAmount(current)}x.`,
      );
    }
    const targetState = { kind: "absolute", value: 1 } as const;
    currentScaleStates.set(operation.targetEntityId, targetState);
    entityScaleStates?.set(operation.targetEntityId, targetState);
  }
  return resolvedChanges;
}

function persistentRemovalVariables(
  operations: readonly CanonicalEditOperation[],
  variableByEntity: ReadonlyMap<string, string>,
  initialAliases: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const aliases = new Map([...initialAliases].map(([entityId, values]) => [entityId, new Set(values)]));
  const removed = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "TransformContent") {
      const source =
        aliases.get(operation.sourceEntityId) ?? new Set([requireVariable(variableByEntity, operation.sourceEntityId)]);
      const target =
        aliases.get(operation.targetEntityId) ?? new Set([requireVariable(variableByEntity, operation.targetEntityId)]);
      const merged = new Set([...source, ...target]);
      aliases.set(operation.sourceEntityId, merged);
      aliases.set(operation.targetEntityId, merged);
    }
    if (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent) {
      const values =
        aliases.get(operation.entityId) ?? new Set([requireVariable(variableByEntity, operation.entityId)]);
      for (const value of values) removed.add(value);
    }
  }
  return removed;
}

function sourceReferenceClosureBeforeAnchor(
  source: string,
  sceneBlock: NonNullable<ReturnType<typeof findSourceSceneBlock>>,
  anchorLine: number,
  variables: ReadonlySet<string>,
  context = "Persistent removal",
) {
  try {
    return pythonReferenceClosure(source, sceneBlock.bodyStart, anchorLine - 1, variables);
  } catch (error) {
    if (!(error instanceof PythonReferenceAnalysisError)) throw error;
    throw new ProgramLoweringError(
      "operation-unsupported",
      `${context} cannot inspect source aliases safely. ${error.message}`,
    );
  }
}

function referencedSourceAfterAnchor(
  source: string,
  sceneBlock: NonNullable<ReturnType<typeof findSourceSceneBlock>>,
  anchorLine: number,
  references: ReadonlySet<string>,
  context: string,
  safeReference?: (line: Readonly<{ code: string; raw: string }>, reference: string) => boolean,
) {
  const analysis = analyzePythonSource(source);
  if (!analysis.valid) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      `${context} cannot inspect an invalid Python source suffix safely.`,
    );
  }
  for (let index = anchorLine; index < sceneBlock.bodyEnd; index += 1) {
    const line = analysis.lines[index];
    if (!line) continue;
    for (const reference of referencedPythonReferences(line, references)) {
      if (!safeReference?.(line, reference)) return reference;
    }
    if (
      sceneBlock.bodyIndent !== null &&
      line.indentation === sceneBlock.bodyIndent &&
      isPythonStatementStart(line) &&
      /^(?:raise|return)\b/.test(line.code.trimStart())
    )
      break;
  }
  return null;
}

/**
 * A static source shift changes only the object's center, so it remains
 * truthful after a content-only replacement. Keep this exception deliberately
 * narrow: the importer must recognize the cardinal vector and the tracked
 * object may appear exactly once in the physical statement.
 */
function safeContentReferenceAfterAnchor(line: Readonly<{ code: string; raw: string }>, reference: string) {
  return (
    referencedPythonReferences(line, new Set([reference])).length === 1 &&
    isSimpleShiftAnimationStatement(line.raw, reference)
  );
}

function referencedVariableAfterAnchor(
  source: string,
  sceneBlock: NonNullable<ReturnType<typeof findSourceSceneBlock>>,
  anchorLine: number,
  variables: ReadonlySet<string>,
  context = "Persistent removal",
) {
  if (variables.size === 0) return null;
  const references = sourceReferenceClosureBeforeAnchor(source, sceneBlock, anchorLine, variables, context);
  return referencedSourceAfterAnchor(source, sceneBlock, anchorLine, references, context);
}

function assertContentReplacementSafety(
  source: string,
  sourcePath: string,
  sceneName: string,
  sceneBlock: NonNullable<ReturnType<typeof findSourceSceneBlock>>,
  anchorLine: number,
  operations: readonly CanonicalEditOperation[],
  sourceBindings: ReadonlyMap<string, string>,
  options: ProgramSourceLoweringOptions,
  frame: Readonly<{ height: number; width: number }>,
) {
  const contentEdits = operations.filter(
    (operation): operation is Extract<CanonicalEditOperation, { kind: "SetProperty" }> =>
      operation.kind === "SetProperty" && operation.key === "content",
  );
  if (contentEdits.length === 0) return;
  const locallyCreated = new Set(
    operations.flatMap((operation) => {
      if (operation.kind === "CreateEntity") return [operation.entity.id];
      if (operation.kind === "TransformContent") return [operation.targetEntityId];
      return [];
    }),
  );
  const imported = importManimScene(sourceThroughAnchor(source, sceneBlock, anchorLine), sourcePath, sceneName, frame);
  if (!imported) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Content replacement cannot verify the imported object state at the selected anchor.",
    );
  }
  for (const operation of contentEdits) {
    if (locallyCreated.has(operation.entityId) || options.generatedEntityIds?.has(operation.entityId)) continue;
    const sourceVariable = sourceBindings.get(operation.entityId);
    if (!sourceVariable) {
      throw new ProgramLoweringError("source-variable-missing", `No source variable exists for ${operation.entityId}.`);
    }
    const safety = imported.contentReplacementSafety[sourceVariable];
    if (safety?.kind !== "safe") {
      const detail = safety?.reason ?? "Studio could not verify a default Text or MathTex constructor.";
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Content replacement for ${sourceVariable} cannot preserve its source appearance. ${detail}`,
      );
    }
    const sourceAliases = new Set([sourceVariable, ...(options.entityAliases?.get(operation.entityId) ?? [])]);
    const sourceReferences = sourceReferenceClosureBeforeAnchor(
      source,
      sceneBlock,
      anchorLine,
      sourceAliases,
      "Content replacement",
    );
    const retainedAlias = [...sourceReferences].find((reference) => !sourceAliases.has(reference));
    if (retainedAlias) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Content replacement for ${sourceVariable} is unsafe because source alias ${retainedAlias} retains the object before the selected anchor.`,
      );
    }
    const unsafeReference = referencedSourceAfterAnchor(
      source,
      sceneBlock,
      anchorLine,
      sourceReferences,
      "Content replacement",
      safeContentReferenceAfterAnchor,
    );
    if (unsafeReference) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Content replacement for ${sourceVariable} is unsafe because source reference ${unsafeReference} is used after the selected anchor.`,
      );
    }
  }
}

function operationBuckets(operations: readonly CanonicalEditOperation[]) {
  const buckets: Array<{ operations: CanonicalEditOperation[]; time: number }> = [];
  for (const operation of operations) {
    const time = operationTime(operation);
    const current = buckets.at(-1);
    if (current && Math.abs(current.time - time) < EPSILON) current.operations.push(operation);
    else buckets.push({ operations: [operation], time });
  }
  return buckets;
}

export function lowerCanonicalProgramSource(
  source: string,
  inputRequest: ProgramRenderRequest,
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
  options: ProgramSourceLoweringOptions = {},
): LoweredProgramSource {
  const programs = renderRequestPrograms(inputRequest);
  if (programs.length !== 1) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "lowerCanonicalProgramSource accepts exactly one Program; use batch lowering for multiple Programs.",
    );
  }
  const request = singleProgramRequest(inputRequest, programs[0], inputRequest.sourceBindings);
  const cameraCenter = request.cameraCenter ?? { x: 0, y: 0 };
  const execution = programExecutionCapabilities(request.program);
  if (execution.lowering !== "supported") {
    throw new ProgramLoweringError(
      "operation-unsupported",
      execution.applyBlocker ??
        `Program ${request.program.transactionId} is marked ${execution.lowering}, not supported.`,
    );
  }
  request.program.operations.forEach((operation) => assertLoweringSupported(operation, options));
  const transformScale = scaleTransformViolation(request.program.operations);
  if (transformScale) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Scale and TransformContent cannot target the same logical object during truthful source lowering.",
    );
  }
  const boundaryViolation = sceneBoundaryViolation(request.program.operations);
  if (boundaryViolation) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "A Scene boundary must be terminal; only its transition reveal may execute afterward.",
    );
  }
  const sourceAnchor = options.sourceAnchor ?? request.program.anchor.resolvedSeconds;
  const anchor = findSceneMotionAnchors(source, request.sceneName, request.sourcePath).find(
    (candidate) => Math.abs(candidate.seconds - sourceAnchor) < EPSILON,
  );
  if (!anchor) {
    throw new ProgramLoweringError(
      "anchor-missing",
      `No # poietra:anchor ${sourceAnchor.toFixed(3)} executable construct-level marker exists in ${request.sourcePath}. ` +
        "Markers inside strings, continuations, nested scopes, or unreachable code are ignored.",
    );
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const markerLine = lines[anchor.line - 1] ?? "";
  const indentation = markerLine.match(/^\s*/)?.[0] ?? "";
  const sceneBlock = findSourceSceneBlock(source, request.sceneName, request.sourcePath);
  if (!sceneBlock) {
    throw new ProgramLoweringError("anchor-missing", `${request.sceneName} is not present in ${request.sourcePath}.`);
  }
  const sourceBeforeAnchor = lines.slice(sceneBlock?.bodyStart ?? 0, anchor.line - 1).join(newline);
  const sourceBindings = new Map(request.sourceBindings.map((binding) => [binding.entityId, binding.sourceVariable]));
  for (const entityId of referencedBaseEntityIds(request.program.operations)) {
    const sourceVariable = sourceBindings.get(entityId);
    if (!sourceVariable) {
      throw new ProgramLoweringError(
        "source-variable-missing",
        `Runtime entity ${entityId} has no imported Python source identity.`,
      );
    }
    if (options.generatedEntityIds?.has(entityId)) continue;
    const assignment = new RegExp(`^${escapePattern(indentation)}${escapePattern(sourceVariable)}\\s*=`, "m");
    if (!assignment.test(sourceBeforeAnchor)) {
      throw new ProgramLoweringError(
        "source-variable-missing",
        `Source variable ${sourceVariable} is not defined before the ${anchor.seconds.toFixed(3)}s anchor.`,
      );
    }
  }

  const order = new Map(request.program.schedule.order.map((id, index) => [id, index]));
  const operations = [...request.program.operations].sort(
    (left, right) =>
      operationTime(left) - operationTime(right) || (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
  );
  assertContentReplacementSafety(
    source,
    request.sourcePath,
    request.sceneName,
    sceneBlock,
    anchor.line,
    operations,
    sourceBindings,
    options,
    frame,
  );
  const resolvedScaleChanges = resolveScaleChangesAndTransforms(
    source,
    request.sourcePath,
    request.sceneName,
    sceneBlock,
    anchor.line,
    sourceAnchor,
    operations,
    sourceBindings,
    options.generatedEntityIds,
    options.entityScaleStates,
    frame,
  );
  const variableByEntity = new Map(sourceBindings);
  const aliasesByEntity = new Map(
    [...sourceBindings].map(([entityId, sourceVariable]) => [
      entityId,
      new Set([sourceVariable, ...(options.entityAliases?.get(entityId) ?? [])]),
    ]),
  );
  const allocateVariable = variableAllocator(source, request.program.transactionId, options.reservedSourceVariables);
  for (const operation of operations) {
    const entityId =
      operation.kind === "CreateEntity"
        ? operation.entity.id
        : operation.kind === "TransformContent"
          ? operation.targetEntityId
          : null;
    if (!entityId || variableByEntity.has(entityId)) continue;
    const variable = allocateVariable();
    variableByEntity.set(entityId, variable);
    aliasesByEntity.set(entityId, new Set([variable]));
  }
  const unsafeRemovalReference = referencedVariableAfterAnchor(
    source,
    sceneBlock,
    anchor.line,
    persistentRemovalVariables(operations, variableByEntity, aliasesByEntity),
  );
  if (unsafeRemovalReference) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      `Persistent removal is unsafe because source reference ${unsafeRemovalReference} is referenced after the selected anchor.`,
    );
  }
  const output: string[] = [];
  let cursor = request.program.anchor.resolvedSeconds;
  for (const { operations: bucket, time } of operationBuckets(operations)) {
    if (time > cursor + EPSILON) {
      output.push(`self.wait(${formatAmount(time - cursor)})`);
      cursor = time;
    }
    if (time < cursor - EPSILON) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        `Operation at ${time.toFixed(3)}s overlaps source time already lowered through ${cursor.toFixed(3)}s.`,
      );
    }
    for (const operation of bucket) {
      if (operation.kind === "CreateEntity") {
        const variable = requireVariable(variableByEntity, operation.entity.id);
        if (!operation.entity.type.startsWith("TransitionOverlay:")) {
          output.push(`# poietra:entity ${JSON.stringify({ id: operation.entity.id, variable })}`);
        }
        output.push(`${variable} = ${entityConstructor(operation)}`);
      } else if (operation.kind === "TransformContent") {
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        const target =
          operation.targetType === "Text"
            ? `Text(${JSON.stringify(operation.replacement.text ?? operation.replacement.displayLines.join(" "))})`
            : `MathTex(${(operation.replacement.texParts ?? operation.replacement.displayLines).map((part) => JSON.stringify(part)).join(", ")})`;
        output.push(`# poietra:entity ${JSON.stringify({ id: operation.targetEntityId, variable: targetVariable })}`);
        output.push(`${targetVariable} = ${target}`);
      }
    }
    for (const operation of bucket) {
      if (operation.kind === "SetProperty") {
        const variable = requireVariable(variableByEntity, operation.entityId);
        if (operation.key === "position" && isPoint(operation.value)) {
          const canonicalPosition = markerPoint(operation.value, request.viewport);
          output.push(
            sourceMarker("position", {
              kind: "absolute",
              value: canonicalPosition,
              variable,
            }),
          );
          output.push(
            `${variable}.move_to(${pointExpression(canonicalPosition, frame, SOURCE_MARKER_VIEWPORT, cameraCenter)})`,
          );
        } else if (operation.key === "content") {
          const target = contentTarget(operation.value);
          if (!target) {
            throw new ProgramLoweringError(
              "operation-unsupported",
              "Content edit requires canonical Text or MathTex content.",
            );
          }
          output.push(
            sourceMarker("content", {
              content: target.content,
              type: target.type,
              variable,
            }),
          );
          output.push(contentReplacementExpression(variable, target));
        }
      } else if (operation.kind === "TransformContent") {
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        const sourceVariable = requireVariable(variableByEntity, operation.sourceEntityId);
        output.push(
          sourceMarker("position", {
            kind: "relative",
            offset: { x: 0, y: 0 },
            relativeTo: sourceVariable,
            variable: targetVariable,
          }),
        );
        output.push(`${targetVariable}.move_to(${sourceVariable}.get_center())`);
      } else if (operation.kind === "SetRelation") {
        const sourceVariable = requireVariable(variableByEntity, operation.sourceEntityId);
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        output.push(
          sourceMarker("position", {
            kind: "relative",
            offset: markerPoint(operation.offset, request.viewport),
            relativeTo: targetVariable,
            variable: sourceVariable,
          }),
        );
        output.push(
          `${sourceVariable}.move_to(${targetVariable}.get_center() + ${offsetExpression(operation.offset, frame, request.viewport)})`,
        );
      }
    }
    for (const operation of bucket) {
      if (
        operation.kind !== "AnimateProperty" ||
        operation.key !== "scale" ||
        operation.interval.end - operation.interval.start > EPSILON
      )
        continue;
      const variable = requireVariable(variableByEntity, operation.entityId);
      const change = resolvedScaleChanges.get(operation.id) ?? scaleChange(operation);
      output.push(
        sourceMarker("scale", {
          kind: "exact",
          value: change.to,
          variable,
        }),
      );
      output.push(`${variable}.scale(${formatAmount(change.factor)})`);
    }
    for (const operation of bucket) {
      if (operation.kind !== "ResizeEntity" || operation.interval.end - operation.interval.start > EPSILON) continue;
      const variable = requireVariable(variableByEntity, operation.entityId);
      output.push(
        sourceMarker("dimensions", {
          kind: "exact",
          resize: resizeMarkerEntry(variable, operation, request.viewport),
        }),
      );
      output.push(resizeExpression(variable, operation, frame, request.viewport, cameraCenter, false));
    }

    const boundaries = bucket.filter((operation) => operation.kind === "InsertSceneBoundary");
    for (const boundary of boundaries) {
      if (!incoming) {
        throw new ProgramLoweringError(
          "destination-missing",
          "The Scene transition has no imported next Scene destination.",
        );
      }
      output.push(
        `# poietra:scene-boundary ${JSON.stringify({
          at: boundary.at,
          destination: request.destination
            ? `${request.destination.sourcePath}#${request.destination.sceneName}`
            : "next-scene",
        })}`,
      );
      output.push("self.clear()");
      output.push("# poietra:incoming-start");
      output.push(...incoming.initialization);
      output.push("# poietra:incoming-end");
      if (incoming.visibleSourceVariables.length > 0) {
        output.push(`self.add(${incoming.visibleSourceVariables.join(", ")})`);
      }
      const overlay = operations.find(
        (operation) => operation.kind === "CreateEntity" && operation.entity.type.startsWith("TransitionOverlay:"),
      );
      if (overlay?.kind === "CreateEntity") {
        const overlayVariable = requireVariable(variableByEntity, overlay.entity.id);
        output.push(`self.add(${overlayVariable})`);
        output.push(`self.bring_to_front(${overlayVariable})`);
      }
    }

    const insertedWaits = bucket.filter(
      (operation) => operation.kind === "InsertTimelineEvent" && operation.eventKind === "wait",
    );
    if (insertedWaits.length > 0) {
      if (insertedWaits.length !== 1 || bucket.length !== 1) {
        throw new ProgramLoweringError(
          "operation-unsupported",
          "An inserted wait must occupy its own source interval.",
        );
      }
      const wait = insertedWaits[0];
      const waitDuration = wait.interval.end - wait.interval.start;
      if (waitDuration > EPSILON) output.push(`self.wait(${formatAmount(waitDuration)})`);
      cursor = wait.interval.end;
      continue;
    }

    const instantPresenceChanges = bucket.filter(
      (operation): operation is Extract<CanonicalEditOperation, { kind: "ChangePresence" }> =>
        operation.kind === "ChangePresence" && operation.interval.end - operation.interval.start <= EPSILON,
    );
    for (const operation of instantPresenceChanges) {
      if (operation.effect !== "remove") {
        throw new ProgramLoweringError(
          "operation-unsupported",
          `Zero-duration ${operation.effect} has no truthful source lowering.`,
        );
      }
      output.push(`self.remove(${requireVariable(variableByEntity, operation.entityId)})`);
    }

    const animations = bucket.filter(
      (operation): operation is LoweredAnimationOperation =>
        animationOperation(operation) && operation.interval.end - operation.interval.start > EPSILON,
    );
    if (animations.length === 0) continue;
    const animationEnd = animations[0].interval.end;
    if (animations.some((operation) => Math.abs(operation.interval.end - animationEnd) >= EPSILON)) {
      throw new ProgramLoweringError("operation-unsupported", "Concurrent source animations must share one interval.");
    }
    const animationEasings = new Set(animations.map(animationEasing));
    if (animationEasings.size !== 1) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        "Concurrent source animations must share one easing function.",
      );
    }
    const rateFunction = animationEasings.values().next().value ?? "smooth";
    const actions: string[] = [];
    const motions: Array<
      Readonly<{
        controlOffset?: Readonly<{ x: number; y: number }>;
        delta: Readonly<{ x: number; y: number }>;
        variables: readonly string[];
      }>
    > = [];
    const scales: Array<
      Readonly<{
        from: number;
        to: number;
        variable: string;
      }>
    > = [];
    const resizes: Array<ReturnType<typeof resizeMarkerEntry>> = [];
    const postludes: string[] = [];
    for (const operation of animations) {
      if (operation.kind === "CreateMotion") {
        const curved = Math.abs(operation.controlOffset.x) > 0.001 || Math.abs(operation.controlOffset.y) > 0.001;
        const variables = operation.targetEntityIds.map((entityId) => requireVariable(variableByEntity, entityId));
        motions.push({
          ...(curved ? { controlOffset: markerPoint(operation.controlOffset, request.viewport) } : {}),
          delta: markerPoint(operation.delta, request.viewport),
          ...(operation.easing === "linear" ? { easing: operation.easing } : {}),
          variables,
        });
        for (const variable of variables) {
          actions.push(
            curved
              ? quadraticMotionExpression(variable, operation.delta, operation.controlOffset, frame, request.viewport)
              : `${variable}.animate.shift(${shiftExpression(operation.delta, frame, request.viewport)})`,
          );
        }
      } else if (operation.kind === "TransformContent") {
        const sourceVariable = requireVariable(variableByEntity, operation.sourceEntityId);
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        const sourceAliases = aliasesByEntity.get(operation.sourceEntityId) ?? new Set([sourceVariable]);
        const targetAliases = aliasesByEntity.get(operation.targetEntityId) ?? new Set([targetVariable]);
        const inheritedAliases = new Set([...targetAliases, ...sourceAliases]);
        aliasesByEntity.set(operation.sourceEntityId, inheritedAliases);
        aliasesByEntity.set(operation.targetEntityId, inheritedAliases);
        actions.push(
          operation.strategy === "transform-matching-tex"
            ? `TransformMatchingTex(${sourceVariable}, ${targetVariable}, transform_mismatches=True)`
            : `ReplacementTransform(${sourceVariable}, ${targetVariable})`,
        );
        postludes.push(
          ...[...sourceAliases]
            .filter((alias) => alias !== targetVariable)
            .map((alias) => `${alias} = ${targetVariable}`),
        );
      } else if (operation.kind === "ChangePresence") {
        const variable = requireVariable(variableByEntity, operation.entityId);
        if (operation.effect === "fade-in") actions.push(`FadeIn(${variable})`);
        else if (operation.effect === "remove") actions.push(`FadeOut(${variable})`);
        else if (operation.effect === "cover") actions.push(`${variable}.animate.scale(800)`);
        else {
          actions.push(`${variable}.animate.scale(0.00125)`);
          postludes.push(`self.remove(${variable})`);
        }
      } else if (operation.kind === "AnimateProperty" && operation.key === "scale") {
        const variable = requireVariable(variableByEntity, operation.entityId);
        const change = resolvedScaleChanges.get(operation.id) ?? scaleChange(operation);
        scales.push({ from: change.from, to: change.to, variable });
        actions.push(`${variable}.animate.scale(${formatAmount(change.factor)})`);
      } else if (operation.kind === "ResizeEntity") {
        const variable = requireVariable(variableByEntity, operation.entityId);
        resizes.push(resizeMarkerEntry(variable, operation, request.viewport));
        actions.push(resizeExpression(variable, operation, frame, request.viewport, cameraCenter, true));
      }
    }
    if (actions.length > 0) {
      if (motions.length > 0) {
        output.push(sourceMarker("motion", { motions }));
      }
      if (scales.length > 0) {
        output.push(sourceMarker("scale", { kind: "animated", scales }));
      }
      if (resizes.length > 0) {
        output.push(sourceMarker("dimensions", { kind: "animated", resizes }));
      }
      output.push("self.play(");
      output.push(...actions.map((action) => `    ${action},`));
      output.push(`    run_time=${formatAmount(animationEnd - time)},`);
      output.push(`    rate_func=${rateFunction},`);
      output.push(")");
    }
    output.push(...postludes);
    cursor = animationEnd;
  }
  output.push(`# poietra:transaction ${JSON.stringify(request.program.transactionId)}`);
  if (operations.some((operation) => operation.kind === "InsertSceneBoundary")) {
    output.push("return  # The imported next Scene now owns the composition.");
  }
  const insertedLines = output.map((line) => `${indentation}${line}`);
  const producedEntityIds = new Set(
    request.program.operations.flatMap((operation) => {
      if (operation.kind === "CreateEntity") return [operation.entity.id];
      if (operation.kind === "TransformContent") return [operation.targetEntityId];
      return [];
    }),
  );
  const entityBindings = [...producedEntityIds].map((entityId) => ({
    entityId,
    sourceVariable: requireVariable(variableByEntity, entityId),
  }));
  const entityAliases = [...aliasesByEntity].map(([entityId, sourceVariables]) => ({
    entityId,
    sourceVariables: [...sourceVariables],
  }));
  const insertedDuration = insertedProgramDuration(request.program);
  rewriteSceneTemporalMetadata(source, request.sceneName, request.sourcePath, lines, [
    {
      anchorLine: anchor.line,
      duration: insertedDuration,
      sourceAnchor,
    },
  ]);
  const advancedAnchor = request.program.anchor.resolvedSeconds + insertedDuration;
  lines.splice(
    anchor.line - 1,
    1,
    `${indentation}# poietra:cursor ${formatAmount(request.program.anchor.resolvedSeconds)}`,
    ...insertedLines,
    `${indentation}# poietra:anchor ${formatAmount(advancedAnchor)}`,
  );
  const loweredSource = lines.join(newline);
  if (options.sourceAnchor === undefined) {
    const currentTransactionIds = new Set([request.program.transactionId]);
    const compactedSource = collapseRepeatedStaticTransformHistory(
      loweredSource,
      frame,
      cameraCenter,
      currentTransactionIds,
      request.sceneName,
      request.sourcePath,
    );
    const evidence = canonicalInsertionEvidence(
      compactedSource,
      currentTransactionIds,
      request.sceneName,
      request.sourcePath,
    );
    return {
      anchorLine: evidence.anchorLine,
      entityAliases,
      entityBindings,
      insertedCode: evidence.insertedCode,
      source: compactedSource,
    };
  }
  return {
    anchorLine: anchor.line,
    entityAliases,
    entityBindings,
    insertedCode: insertedLines.join(newline),
    source: loweredSource,
  };
}

function singleProgramRequest(
  request: ProgramRenderRequest,
  program: SingleProgramRenderRequest["program"],
  sourceBindings: SingleProgramRenderRequest["sourceBindings"],
): SingleProgramRenderRequest {
  return {
    ...(request.cameraCenter ? { cameraCenter: request.cameraCenter } : {}),
    destination: request.destination,
    program,
    projectId: request.projectId,
    sceneName: request.sceneName,
    sourceBindings,
    sourceHash: request.sourceHash,
    sourcePath: request.sourcePath,
    viewport: request.viewport,
  };
}

type MutableBatchGroup = {
  anchorLine: number;
  duration: number;
  insertedLines: string[];
  sourceAnchor: number;
};

function normalizeSceneDurationTrims(
  entries: readonly LoweredProgramBatchEntry[],
): readonly LoweredProgramBatchEntry[] {
  const remainingWaitDuration = new Map<string, number>();
  const waitEntry = new Map<string, Readonly<{ entryIndex: number; sourceAnchor: number }>>();

  entries.forEach((entry, entryIndex) => {
    for (const operation of entry.program.operations) {
      if (
        operation.kind === "InsertTimelineEvent" &&
        operation.eventKind === "wait" &&
        operation.purpose === "scene-duration"
      ) {
        if (entry.program.provenance.origin !== "studio-default" || operation.provenance.origin !== "studio-default") {
          throw new ProgramLoweringError(
            "operation-unsupported",
            `Duration wait ${operation.id} was not authored by the Studio Scene duration control.`,
          );
        }
        if (remainingWaitDuration.has(operation.id)) {
          throw new ProgramLoweringError(
            "operation-unsupported",
            `Studio duration wait operation ID ${operation.id} occurs more than once in the render batch.`,
          );
        }
        remainingWaitDuration.set(operation.id, operation.interval.end - operation.interval.start);
        waitEntry.set(operation.id, { entryIndex, sourceAnchor: entry.sourceAnchor });
      }
    }
    const trims = entry.program.operations.filter((operation) => operation.kind === "TrimSceneDuration");
    if (trims.length === 0) return;
    if (trims.length !== entry.program.operations.length) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        "A Scene duration trim cannot be lowered together with unrelated operations in one Program.",
      );
    }
    for (const trim of trims) {
      let remaining = trim.removedDuration;
      for (const waitOperationId of trim.waitOperationIds) {
        const source = waitEntry.get(waitOperationId);
        const available = remainingWaitDuration.get(waitOperationId) ?? 0;
        if (
          !source ||
          source.entryIndex >= entryIndex ||
          Math.abs(source.sourceAnchor - entry.sourceAnchor) >= EPSILON
        ) {
          throw new ProgramLoweringError(
            "operation-unsupported",
            `Scene duration trim ${trim.id} does not reference an earlier Studio duration wait at the same source anchor.`,
          );
        }
        const removed = Math.min(available, remaining);
        remainingWaitDuration.set(waitOperationId, available - removed);
        remaining -= removed;
        if (remaining <= EPSILON) break;
      }
      if (remaining > EPSILON) {
        throw new ProgramLoweringError(
          "operation-unsupported",
          `Scene duration trim ${trim.id} would remove non-Studio source time.`,
        );
      }
    }
  });

  return entries.flatMap((entry) => {
    const operations = entry.program.operations.flatMap((operation): readonly CanonicalEditOperation[] => {
      if (operation.kind === "TrimSceneDuration") return [];
      if (
        operation.kind !== "InsertTimelineEvent" ||
        operation.eventKind !== "wait" ||
        operation.purpose !== "scene-duration"
      )
        return [operation];
      const duration = remainingWaitDuration.get(operation.id) ?? operation.interval.end - operation.interval.start;
      return duration > EPSILON
        ? [{ ...operation, interval: { end: operation.interval.start + duration, start: operation.interval.start } }]
        : [];
    });
    if (operations.length === 0) return [];
    const operationIds = new Set(operations.map((operation) => operation.id));
    return [
      {
        ...entry,
        program: {
          ...entry.program,
          operations,
          schedule: {
            ...entry.program.schedule,
            edges: entry.program.schedule.edges.filter(
              (edge) => operationIds.has(edge.from) && operationIds.has(edge.to),
            ),
            order: entry.program.schedule.order.filter((id) => operationIds.has(id)),
          },
        },
      },
    ];
  });
}

function finiteCreatedLifetimeEntries(
  entries: readonly LoweredProgramBatchEntry[],
): readonly LoweredProgramBatchEntry[] {
  return entries.flatMap((entry) => {
    const rebaseOffset = entry.program.anchor.resolvedSeconds - entry.sourceAnchor;
    return entry.program.operations.flatMap((operation, index): readonly LoweredProgramBatchEntry[] => {
      if (
        operation.kind !== "CreateEntity" ||
        operation.entity.lifetime.end === null ||
        operation.entity.type.startsWith("TransitionOverlay:")
      )
        return [];
      const sourceEnd = operation.entity.lifetime.end - rebaseOffset;
      if (!Number.isFinite(sourceEnd) || sourceEnd <= entry.sourceAnchor + EPSILON) {
        throw new ProgramLoweringError(
          "operation-unsupported",
          `Created lifetime for ${operation.entity.id} must end after its source anchor.`,
        );
      }
      const transactionId = `${entry.program.transactionId}/lifetime-end-${index}`;
      const removeId = `${transactionId}/operation/remove`;
      const program: CanonicalEditProgram = {
        anchor: {
          capturedPlayhead: sourceEnd,
          evidence: ["finite Studio-owned lifetime", `source-anchor:${sourceEnd.toFixed(3)}`],
          resolvedSeconds: sourceEnd,
          source: { kind: "absolute", seconds: sourceEnd },
        },
        intentCount: 1,
        loweringStatus: "supported",
        operations: [
          {
            dependsOn: [],
            effect: "remove",
            entityId: operation.entity.id,
            id: removeId,
            interval: { end: sourceEnd, start: sourceEnd },
            kind: "ChangePresence",
            persistent: true,
            provenance: { evidence: ["finite Studio-owned lifetime end"], origin: "direct-manipulation" },
          },
        ],
        provenance: { evidence: ["finite Studio-owned lifetime end"], origin: "direct-manipulation" },
        requestedExecution: "sequence",
        schedule: { edges: [], mode: "sequence", order: [removeId] },
        transactionId,
        version: EDIT_OPERATION_VERSION,
      };
      return [{ program, sourceAnchor: sourceEnd }];
    });
  });
}

function warpSquareV9LoweringError(message: string): never {
  throw new ProgramLoweringError("operation-unsupported", `WarpSquare V9 initial transform: ${message}`);
}

function boundedInitialTransformPlan(
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  targetEntityId: string,
  targetLabel: string,
  fail: (message: string) => never,
) {
  const programs = renderRequestPrograms(request);
  if (
    programs.length < 1 ||
    programs.length > 2 ||
    entries.length !== programs.length ||
    programs.some((program, index) => JSON.stringify(program) !== JSON.stringify(entries[index]?.program))
  ) {
    fail("one or two correlated initial-transform Programs are accepted.");
  }
  for (const { program, sourceAnchor } of entries) {
    const operation = program.operations[0];
    if (
      sourceAnchor !== 0 ||
      program.version !== EDIT_OPERATION_VERSION ||
      program.anchor.capturedPlayhead !== 0 ||
      program.anchor.resolvedSeconds !== 0 ||
      program.intentCount !== 1 ||
      program.loweringStatus !== "supported" ||
      program.provenance.origin !== "direct-manipulation" ||
      program.requestedExecution !== "parallel" ||
      program.operations.length !== 1 ||
      !operation ||
      operation.dependsOn.length !== 0 ||
      operation.provenance.origin !== "direct-manipulation" ||
      program.schedule.mode !== "parallel" ||
      program.schedule.edges.length !== 0 ||
      program.schedule.order.length !== 1 ||
      program.schedule.order[0] !== operation.id
    ) {
      fail("each edit must be one exact direct-manipulation Program at source time zero.");
    }
  }

  let position: Readonly<{ x: number; y: number }> | null = null;
  let scale: number | null = null;
  for (const operation of entries.flatMap(({ program }) => program.operations)) {
    if (operation.interval.start !== 0 || operation.interval.end !== 0) {
      fail("the Program and every edit must be instantaneous at source time zero.");
    }
    if (!("entityId" in operation) || operation.entityId !== targetEntityId) {
      fail(`every operation must target the one verified ${targetLabel} binding.`);
    }
    if (operation.kind === "SetProperty" && operation.key === "position") {
      if (
        position !== null ||
        !isPoint(operation.value) ||
        !Number.isFinite(operation.value.x) ||
        !Number.isFinite(operation.value.y)
      ) {
        fail("position must be one finite absolute point.");
      }
      position = { x: operation.value.x, y: operation.value.y };
      continue;
    }
    if (
      operation.kind === "AnimateProperty" &&
      operation.key === "scale" &&
      operation.control === undefined &&
      typeof operation.from === "number" &&
      typeof operation.to === "number" &&
      typeof operation.relativeFactor === "number" &&
      Number.isFinite(operation.from) &&
      Number.isFinite(operation.to) &&
      Number.isFinite(operation.relativeFactor) &&
      operation.from > 0 &&
      operation.to > 0 &&
      operation.relativeFactor > 0 &&
      Math.abs(operation.from - 1) < 0.000001 &&
      Math.abs(operation.to / operation.from - operation.relativeFactor) < 0.000001
    ) {
      if (scale !== null) fail("scale may be changed only once.");
      scale = operation.relativeFactor;
      continue;
    }
    fail("only one finite position and/or one positive uniform relative scale is accepted.");
  }
  if (position === null && scale === null) fail("the Program contains no supported initial transform.");
  return { position, scale } as const;
}

function squareToCircleV8LoweringError(message: string): never {
  throw new ProgramLoweringError("operation-unsupported", `SquareToCircle V8 initial position: ${message}`);
}

/**
 * Lowers the one position edit admitted by the exact official SquareToCircle
 * source family. The hidden Circle is dependency closure for Transform, not a
 * second editable runtime entity: both source objects receive the same center
 * before Create so the complete timeline remains one world-space translation.
 */
export function lowerSquareToCircleInitialPositionSourceV8(
  source: string,
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
): LoweredProgramBatchSource | null {
  if (
    request.sourcePath !== SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_PATH_V8 ||
    request.sceneName !== SQUARE_TO_CIRCLE_SCENE_NAME_V8
  ) {
    return null;
  }
  if (request.sourceHash !== SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8) {
    squareToCircleV8LoweringError("the edit must be rebased from the pinned official source generation.");
  }
  const imported = importManimScene(source, request.sourcePath, request.sceneName, frame);
  if (!imported || imported.sourceHash !== SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8) {
    squareToCircleV8LoweringError("the current source bytes are not the pinned official source generation.");
  }
  if (incoming !== null || request.destination !== null) {
    squareToCircleV8LoweringError("Scene transitions are outside this bounded round-trip profile.");
  }
  if (
    !Number.isFinite(frame.height) ||
    !Number.isFinite(frame.width) ||
    frame.height <= 0 ||
    frame.width <= 0 ||
    !Number.isFinite(request.viewport.height) ||
    !Number.isFinite(request.viewport.width) ||
    request.viewport.height <= 0 ||
    request.viewport.width <= 0
  ) {
    squareToCircleV8LoweringError("the Studio frame and viewport must be finite and positive.");
  }
  const cameraCenter = request.cameraCenter ?? { x: 0, y: 0 };
  if (
    !Number.isFinite(cameraCenter.x) ||
    !Number.isFinite(cameraCenter.y) ||
    cameraCenter.x !== 0 ||
    cameraCenter.y !== 0
  ) {
    squareToCircleV8LoweringError("the pinned static camera must remain centered.");
  }

  const expectedVariables = new Set(["circle", "square"]);
  if (
    Object.keys(imported.sourceVariables).length !== expectedVariables.size ||
    request.sourceBindings.length !== expectedVariables.size ||
    new Set(request.sourceBindings.map(({ sourceVariable }) => sourceVariable)).size !== expectedVariables.size ||
    request.sourceBindings.some(
      ({ entityId, sourceVariable }) =>
        !expectedVariables.has(sourceVariable) || imported.sourceVariables[entityId] !== sourceVariable,
    )
  ) {
    squareToCircleV8LoweringError("the exact imported `circle` and `square` source bindings are required.");
  }
  const squareBinding = request.sourceBindings.find(({ sourceVariable }) => sourceVariable === "square");
  if (!squareBinding) squareToCircleV8LoweringError("the source-bound `square` target is unavailable.");

  const programs = renderRequestPrograms(request);
  if (programs.length !== 1 || entries.length !== 1) {
    squareToCircleV8LoweringError("exactly one correlated position Program is accepted.");
  }
  const program = programs[0]!;
  const sourceAnchorIsZero =
    (program.anchor.source.kind === "absolute" && program.anchor.source.seconds === 0) ||
    (program.anchor.source.kind === "playhead" && program.anchor.source.referenceSeconds === 0);
  if (!sourceAnchorIsZero) {
    squareToCircleV8LoweringError("the Program source authority must resolve exactly to source time zero.");
  }
  const { position, scale } = boundedInitialTransformPlan(
    request,
    entries,
    squareBinding.entityId,
    "`square`",
    squareToCircleV8LoweringError,
  );
  if (position === null || scale !== null) {
    squareToCircleV8LoweringError("only one finite absolute position edit is accepted.");
  }
  const worldPosition = {
    x: (position.x / request.viewport.width - 0.5) * frame.width,
    y: (0.5 - position.y / request.viewport.height) * frame.height,
  };
  if (
    !Number.isFinite(worldPosition.x) ||
    !Number.isFinite(worldPosition.y) ||
    Math.abs(worldPosition.x) > MAX_COORDINATE ||
    Math.abs(worldPosition.y) > MAX_COORDINATE
  ) {
    squareToCircleV8LoweringError("the requested position is outside Studio's bounded coordinate range.");
  }
  const target = pointExpression(position, frame, request.viewport);
  if (target === "(0, 0, 0)") {
    throw new ProgramLoweringError("zero-delta", "SquareToCircle V8 position must change the source center.");
  }

  const statements = findSourceSceneStatements(source, request.sceneName, request.sourcePath);
  const expectedStatements = [
    "circle = Circle()",
    "square = Square()",
    "square.flip(RIGHT)",
    "square.rotate(-3 * TAU / 8)",
    "circle.set_fill(PINK, opacity=0.5)",
    "self.play(Create(square))",
    "self.play(Transform(square, circle))",
    "self.play(FadeOut(square))",
  ] as const;
  if (
    statements.length !== expectedStatements.length ||
    expectedStatements.some((text, index) => statements[index]?.text !== text)
  ) {
    squareToCircleV8LoweringError(
      "the exact Square to Circle Transform dependency and pre-play boundary are unavailable.",
    );
  }
  const setup = statements[4]!;
  const firstPlay = statements[5]!;
  if (setup.line >= firstPlay.line) {
    squareToCircleV8LoweringError("the paired position edit must precede the first play.");
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const indentation = lines[setup.line]?.match(/^\s*/)?.[0] ?? "";
  if (indentation !== "        ") {
    squareToCircleV8LoweringError("the pinned pre-play setup indentation changed.");
  }
  const insertedLines = [`${indentation}square.move_to(${target})`, `${indentation}circle.move_to(${target})`];
  lines.splice(setup.line + 1, 0, ...insertedLines);
  return {
    anchorLine: setup.line + 1,
    anchorLines: [setup.line + 1],
    insertedCode: insertedLines.join(newline),
    preflight: {
      baseSourceHash: SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8,
      kind: "fast-manim-square-to-circle-v8",
    },
    source: lines.join(newline),
  };
}

export function lowerWarpSquareInitialTransformSourceV9(
  source: string,
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
): LoweredProgramBatchSource | null {
  if (request.sourcePath !== WARP_SQUARE_OFFICIAL_SOURCE_PATH_V9 || request.sceneName !== WARP_SQUARE_SCENE_NAME_V9) {
    return null;
  }
  if (request.sourceHash !== WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9) {
    warpSquareV9LoweringError("the edit must be rebased from the pinned official source generation.");
  }
  const imported = importManimScene(source, request.sourcePath, request.sceneName, frame);
  if (!imported || imported.sourceHash !== WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9) {
    warpSquareV9LoweringError("the current source bytes are not the pinned official source generation.");
  }
  if (incoming !== null || request.destination !== null) {
    warpSquareV9LoweringError("Scene transitions are outside this bounded round-trip profile.");
  }
  if (
    !Number.isFinite(frame.height) ||
    !Number.isFinite(frame.width) ||
    frame.height <= 0 ||
    frame.width <= 0 ||
    !Number.isFinite(request.viewport.height) ||
    !Number.isFinite(request.viewport.width) ||
    request.viewport.height <= 0 ||
    request.viewport.width <= 0
  ) {
    warpSquareV9LoweringError("the Studio frame and viewport must be finite and positive.");
  }
  const cameraCenter = request.cameraCenter ?? { x: 0, y: 0 };
  if (
    !Number.isFinite(cameraCenter.x) ||
    !Number.isFinite(cameraCenter.y) ||
    cameraCenter.x !== 0 ||
    cameraCenter.y !== 0
  ) {
    warpSquareV9LoweringError("the pinned static camera must remain centered.");
  }

  if (request.sourceBindings.length !== 1 || request.sourceBindings[0]!.sourceVariable !== "square") {
    warpSquareV9LoweringError("exactly one imported `square` source binding is required.");
  }
  const binding = request.sourceBindings[0]!;
  if (imported.sourceVariables[binding.entityId] !== "square") {
    warpSquareV9LoweringError("the target does not match the pinned imported Square identity.");
  }

  const { position, scale } = boundedInitialTransformPlan(
    request,
    entries,
    binding.entityId,
    "`square`",
    warpSquareV9LoweringError,
  );

  const statements = findSourceSceneStatements(source, request.sceneName, request.sourcePath);
  const assignments = statements.filter((statement) => statement.text === "square = Square()");
  const firstPlay = statements.find((statement) => statement.text.startsWith("self.play("));
  const assignment = assignments[0];
  if (assignments.length !== 1 || !assignment || !firstPlay || assignment.line >= firstPlay.line) {
    warpSquareV9LoweringError("the pinned `square = Square()` → first `self.play` source boundary is unavailable.");
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const indentation = lines[assignment.line]?.match(/^\s*/)?.[0] ?? "";
  if (indentation !== "        ") {
    warpSquareV9LoweringError("the pinned Square assignment indentation changed.");
  }
  const insertedLines = [
    ...(position === null
      ? []
      : [`${indentation}square.move_to(${pointExpression(position, frame, request.viewport)})`]),
    ...(scale === null ? [] : [`${indentation}square.scale(${formatPositiveAmount(scale)})`]),
  ];
  lines.splice(assignment.line + 1, 0, ...insertedLines);
  return {
    anchorLine: assignment.line + 1,
    anchorLines: [assignment.line + 1],
    insertedCode: insertedLines.join(newline),
    preflight: {
      baseSourceHash: WARP_SQUARE_OFFICIAL_SOURCE_SHA256_V9,
      kind: "fast-manim-warp-square-v9",
    },
    source: lines.join(newline),
  };
}

function lineJointsV10LoweringError(message: string): never {
  throw new ProgramLoweringError("operation-unsupported", `LineJoints V10 central-leaf transform: ${message}`);
}

export function lowerLineJointsInitialTransformSourceV10(
  source: string,
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
): LoweredProgramBatchSource | null {
  if (request.sourcePath !== LINE_JOINTS_OFFICIAL_SOURCE_PATH_V10 || request.sceneName !== LINE_JOINTS_SCENE_NAME_V10) {
    return null;
  }
  if (request.sourceHash !== LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10) {
    lineJointsV10LoweringError("the edit must be rebased from the pinned official source generation.");
  }
  const imported = importManimScene(source, request.sourcePath, request.sceneName, frame);
  if (!imported || imported.sourceHash !== LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10) {
    lineJointsV10LoweringError("the current source bytes are not the pinned official source generation.");
  }
  if (incoming !== null || request.destination !== null) {
    lineJointsV10LoweringError("Scene transitions are outside this bounded round-trip profile.");
  }
  if (
    !Number.isFinite(frame.height) ||
    !Number.isFinite(frame.width) ||
    frame.height <= 0 ||
    frame.width <= 0 ||
    !Number.isFinite(request.viewport.height) ||
    !Number.isFinite(request.viewport.width) ||
    request.viewport.height <= 0 ||
    request.viewport.width <= 0
  ) {
    lineJointsV10LoweringError("the Studio frame and viewport must be finite and positive.");
  }
  const cameraCenter = request.cameraCenter ?? { x: 0, y: 0 };
  if (
    !Number.isFinite(cameraCenter.x) ||
    !Number.isFinite(cameraCenter.y) ||
    cameraCenter.x !== 0 ||
    cameraCenter.y !== 0
  ) {
    lineJointsV10LoweringError("the pinned static camera must remain centered.");
  }

  const expectedVariables = new Set(["grp", "t1", "t2", "t3"]);
  if (
    Object.keys(imported.sourceVariables).length !== expectedVariables.size ||
    request.sourceBindings.length !== expectedVariables.size ||
    new Set(request.sourceBindings.map(({ sourceVariable }) => sourceVariable)).size !== expectedVariables.size ||
    request.sourceBindings.some(
      ({ entityId, sourceVariable }) =>
        !expectedVariables.has(sourceVariable) || imported.sourceVariables[entityId] !== sourceVariable,
    )
  ) {
    lineJointsV10LoweringError("the exact imported `grp`, `t1`, `t2`, and `t3` source bindings are required.");
  }
  const binding = request.sourceBindings.find(({ sourceVariable }) => sourceVariable === "t2");
  if (!binding) lineJointsV10LoweringError("the central `t2` source binding is unavailable.");
  const { position, scale } = boundedInitialTransformPlan(
    request,
    entries,
    binding.entityId,
    "central `t2`",
    lineJointsV10LoweringError,
  );

  const statements = findSourceSceneStatements(source, request.sceneName, request.sourcePath);
  const t2Assignments = statements.filter(({ text }) => text === "t2 = Triangle(joint_type=LineJointType.ROUND)");
  const groupLayouts = statements.filter(({ text }) => text === "grp.set(width=config.frame_width - 1)");
  const additions = statements.filter(({ text }) => text === "self.add(grp)");
  const t2Assignment = t2Assignments[0];
  const groupLayout = groupLayouts[0];
  const addition = additions[0];
  if (
    t2Assignments.length !== 1 ||
    groupLayouts.length !== 1 ||
    additions.length !== 1 ||
    !t2Assignment ||
    !groupLayout ||
    !addition ||
    t2Assignment.line >= groupLayout.line ||
    groupLayout.line >= addition.line
  ) {
    lineJointsV10LoweringError("the pinned `t2` assignment and post-layout source boundary are unavailable.");
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const indentation = lines[groupLayout.line]?.match(/^\s*/)?.[0] ?? "";
  if (indentation !== "        ") {
    lineJointsV10LoweringError("the pinned group layout indentation changed.");
  }
  const insertedLines = [
    ...(position === null ? [] : [`${indentation}t2.move_to(${pointExpression(position, frame, request.viewport)})`]),
    ...(scale === null ? [] : [`${indentation}t2.scale(${formatPositiveAmount(scale)})`]),
  ];
  lines.splice(groupLayout.line + 1, 0, ...insertedLines);
  return {
    anchorLine: groupLayout.line + 1,
    anchorLines: [groupLayout.line + 1],
    insertedCode: insertedLines.join(newline),
    preflight: {
      baseSourceHash: LINE_JOINTS_OFFICIAL_SOURCE_SHA256_V10,
      kind: "fast-manim-line-joints-v10",
    },
    source: lines.join(newline),
  };
}

function writeStuffV12LoweringError(message: string): never {
  throw new ProgramLoweringError("operation-unsupported", `WriteStuff V12 equation transform: ${message}`);
}

/**
 * Lowers the only source mutation admitted by the exact WriteStuff V12
 * family. The MathTex root may move and/or scale once, after the audited
 * VGroup layout has completed and before either Write animation starts.
 */
export function lowerWriteStuffInitialTransformSourceV12(
  source: string,
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
): LoweredProgramBatchSource | null {
  if (request.sourcePath !== WRITE_STUFF_OFFICIAL_SOURCE_PATH_V12 || request.sceneName !== WRITE_STUFF_SCENE_NAME_V12) {
    return null;
  }
  if (request.sourceHash !== WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12) {
    writeStuffV12LoweringError("the edit must be rebased from the pinned official source generation.");
  }
  const imported = importManimScene(source, request.sourcePath, request.sceneName, frame);
  if (!imported || imported.sourceHash !== WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12) {
    writeStuffV12LoweringError("the current source bytes are not the pinned official source generation.");
  }
  if (incoming !== null || request.destination !== null) {
    writeStuffV12LoweringError("Scene transitions are outside this bounded round-trip profile.");
  }
  if (
    !Number.isFinite(frame.height) ||
    !Number.isFinite(frame.width) ||
    frame.height <= 0 ||
    frame.width <= 0 ||
    !Number.isFinite(request.viewport.height) ||
    !Number.isFinite(request.viewport.width) ||
    request.viewport.height <= 0 ||
    request.viewport.width <= 0
  ) {
    writeStuffV12LoweringError("the Studio frame and viewport must be finite and positive.");
  }
  const cameraCenter = request.cameraCenter ?? { x: 0, y: 0 };
  if (
    !Number.isFinite(cameraCenter.x) ||
    !Number.isFinite(cameraCenter.y) ||
    cameraCenter.x !== 0 ||
    cameraCenter.y !== 0
  ) {
    writeStuffV12LoweringError("the pinned static camera must remain centered.");
  }

  const expectedVariables = new Set(["example_text", "example_tex", "group"]);
  if (
    Object.keys(imported.sourceVariables).length !== expectedVariables.size ||
    request.sourceBindings.length !== expectedVariables.size ||
    new Set(request.sourceBindings.map(({ sourceVariable }) => sourceVariable)).size !== expectedVariables.size ||
    request.sourceBindings.some(
      ({ entityId, sourceVariable }) =>
        !expectedVariables.has(sourceVariable) || imported.sourceVariables[entityId] !== sourceVariable,
    )
  ) {
    writeStuffV12LoweringError(
      "the exact imported `group`, `example_text`, and `example_tex` source bindings are required.",
    );
  }
  const binding = request.sourceBindings.find(({ sourceVariable }) => sourceVariable === "example_tex");
  if (!binding) writeStuffV12LoweringError("the source-bound `example_tex` equation is unavailable.");
  const { position, scale } = boundedInitialTransformPlan(
    request,
    entries,
    binding.entityId,
    "`example_tex` equation",
    writeStuffV12LoweringError,
  );

  const statements = findSourceSceneStatements(source, request.sceneName, request.sourcePath);
  const equationAssignments = statements.filter(({ text }) => text.startsWith("example_tex = MathTex("));
  const groupLayouts = statements.filter(({ text }) => text === 'group.width = config["frame_width"] - 2 * LARGE_BUFF');
  const firstWrite = statements.filter(({ text }) => text === "self.play(Write(example_text))");
  const equationAssignment = equationAssignments[0];
  const groupLayout = groupLayouts[0];
  const write = firstWrite[0];
  if (
    equationAssignments.length !== 1 ||
    groupLayouts.length !== 1 ||
    firstWrite.length !== 1 ||
    !equationAssignment ||
    !groupLayout ||
    !write ||
    equationAssignment.line >= groupLayout.line ||
    groupLayout.line >= write.line
  ) {
    writeStuffV12LoweringError("the pinned equation assignment and post-layout source boundary are unavailable.");
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const indentation = lines[groupLayout.line]?.match(/^\s*/)?.[0] ?? "";
  if (indentation !== "        ") {
    writeStuffV12LoweringError("the pinned group layout indentation changed.");
  }
  const insertedLines = [
    ...(position === null
      ? []
      : [`${indentation}example_tex.move_to(${pointExpression(position, frame, request.viewport)})`]),
    ...(scale === null ? [] : [`${indentation}example_tex.scale(${formatPositiveAmount(scale)})`]),
  ];
  lines.splice(groupLayout.line + 1, 0, ...insertedLines);
  return {
    anchorLine: groupLayout.line + 1,
    anchorLines: [groupLayout.line + 1],
    insertedCode: insertedLines.join(newline),
    preflight: {
      baseSourceHash: WRITE_STUFF_OFFICIAL_SOURCE_SHA256_V12,
      kind: "fast-manim-write-stuff-v12",
    },
    source: lines.join(newline),
  };
}

function openingTerminalV2LoweringError(message: string): never {
  throw new ProgramLoweringError("operation-unsupported", `OpeningManim terminal position V2: ${message}`);
}

export type OpeningManimTerminalPositionSourceEditPlanV2 = Readonly<{
  anchorLine: number;
  binding: Readonly<{ name: "grid_title"; sourceLine: 38 }>;
  sourceTime: typeof OPENING_TERMINAL_SOURCE_TIME_V2;
  translation: Readonly<{ x: number; y: number; z: 0 }> | null;
}>;

function parseCanonicalOpeningTranslationV2(statement: string) {
  const match = statement.match(/^grid_title\.shift\(\(([^,()]+), ([^,()]+), 0\)\)$/);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    (x === 0 && y === 0) ||
    Math.abs(x) > MAX_COORDINATE ||
    Math.abs(y) > MAX_COORDINATE ||
    formatPointCoordinate(x) !== match[1] ||
    formatPointCoordinate(y) !== match[2]
  ) {
    return null;
  }
  return { x, y, z: 0 as const };
}

function inspectOpeningManimTerminalPositionSourceV2(candidateSource: string, sceneName: string) {
  if (sceneName !== OPENING_TERMINAL_SCENE_NAME_V2) {
    openingTerminalV2LoweringError("candidate Scene identity is outside the pinned profile.");
  }
  const analysis = analyzePythonSource(candidateSource);
  let block: ReturnType<typeof findSourceSceneBlock>;
  try {
    block = findSourceSceneBlock(
      candidateSource,
      OPENING_TERMINAL_SCENE_NAME_V2,
      OPENING_TERMINAL_OFFICIAL_SOURCE_PATH_V2,
    );
  } catch {
    openingTerminalV2LoweringError("SourceAnalysis found an ambiguous Scene occurrence.");
  }
  const statements = findSourceSceneStatements(
    candidateSource,
    OPENING_TERMINAL_SCENE_NAME_V2,
    OPENING_TERMINAL_OFFICIAL_SOURCE_PATH_V2,
  );
  const assignments = statements.filter(({ text }) => text === 'grid_title = Tex("This is a grid", font_size=72)');
  const transforms = statements.filter(({ text }) => text === "self.play(Transform(grid_title, grid_transform_title))");
  const assignment = assignments[0];
  const transform = transforms[0];
  const transformIndex = transform ? statements.indexOf(transform) : -1;
  const trailing = transformIndex < 0 ? [] : statements.slice(transformIndex + 1);
  const wait = trailing.at(-1);
  const translationStatement = trailing.length === 2 ? trailing[0] : undefined;
  const directStatementLines = block
    ? analysis.lines
        .slice(block.bodyStart, block.bodyEnd)
        .flatMap((line, offset) => (isPythonStatementStart(line) ? [block.bodyStart + offset] : []))
    : [];
  if (
    !analysis.valid ||
    !block ||
    block.classLine !== 17 ||
    block.bodyIndent !== 8 ||
    assignments.length !== 1 ||
    transforms.length !== 1 ||
    !assignment ||
    assignment.line !== 37 ||
    !transform ||
    transform.line !== 67 ||
    trailing.length < 1 ||
    trailing.length > 2 ||
    wait?.text !== "self.wait()" ||
    transform.line + 1 !== (translationStatement?.line ?? wait.line) ||
    (translationStatement !== undefined && translationStatement.line + 1 !== wait.line) ||
    directStatementLines.length !== statements.length ||
    directStatementLines.some((line, index) => line !== statements[index]?.line) ||
    directStatementLines.some((line) => analysis.lines[line]?.indentation !== block.bodyIndent) ||
    analysis.lines[transform.line]?.code.trim() !== "self.play(Transform(grid_title, grid_transform_title))" ||
    analysis.lines[wait.line]?.code.trim() !== "self.wait()" ||
    analysis.lines[(translationStatement?.line ?? wait.line) - 1]?.bracketDepthAfter !== 0
  ) {
    openingTerminalV2LoweringError(
      "SourceAnalysis could not prove the grid_title occurrence and direct final-Transform-to-wait boundary.",
    );
  }

  const translation = translationStatement ? parseCanonicalOpeningTranslationV2(translationStatement.text) : null;
  if (translationStatement && !translation) {
    openingTerminalV2LoweringError("candidate edit must be one canonical finite bounded grid_title translation.");
  }
  const newline = candidateSource.includes("\r\n") ? "\r\n" : "\n";
  const baseLines = candidateSource.split(/\r?\n/);
  if (translationStatement) baseLines.splice(translationStatement.line, 1);
  const officialSource = baseLines.join(newline);
  const imported = importManimScene(
    officialSource,
    OPENING_TERMINAL_OFFICIAL_SOURCE_PATH_V2,
    OPENING_TERMINAL_SCENE_NAME_V2,
  );
  const bindingEntries = Object.entries(imported?.sourceVariables ?? {}).filter(([, name]) => name === "grid_title");
  if (!imported || imported.sourceHash !== OPENING_TERMINAL_OFFICIAL_SOURCE_SHA256_V2 || bindingEntries.length !== 1) {
    openingTerminalV2LoweringError("candidate bytes do not reduce to the pinned source occurrence and binding.");
  }
  return {
    bindingEntityId: bindingEntries[0]![0],
    officialSource,
    plan: {
      anchorLine: wait.line - Number(translationStatement !== undefined),
      binding: { name: "grid_title", sourceLine: 38 },
      sourceTime: OPENING_TERMINAL_SOURCE_TIME_V2,
      translation,
    } satisfies OpeningManimTerminalPositionSourceEditPlanV2,
  } as const;
}

export function deriveOpeningManimTerminalPositionSourceEditPlanV2(
  candidateSource: string,
  sceneName: string,
): OpeningManimTerminalPositionSourceEditPlanV2 {
  return inspectOpeningManimTerminalPositionSourceV2(candidateSource, sceneName).plan;
}

export function recoverOpeningManimOfficialSourceV2(candidateSource: string, sceneName: string) {
  const inspected = inspectOpeningManimTerminalPositionSourceV2(candidateSource, sceneName);
  if (!inspected.plan.translation) openingTerminalV2LoweringError("candidate source contains no terminal translation.");
  return inspected.officialSource;
}

/**
 * SourceAnalysis half of the OpeningManim V2 edit slice. The caller must pass
 * the grid_title center from separately verified and fully correlated Runtime
 * Trace evidence; that runtime position cannot authorize a rewrite by itself.
 */
export function lowerOpeningManimTerminalPositionSourceV2(
  source: string,
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
  runtimeSourceCenter: Readonly<{ x: number; y: number }> | null,
): LoweredProgramBatchSource | null {
  if (
    request.sourcePath !== OPENING_TERMINAL_OFFICIAL_SOURCE_PATH_V2 ||
    request.sceneName !== OPENING_TERMINAL_SCENE_NAME_V2
  ) {
    return null;
  }
  if (request.sourceHash !== OPENING_TERMINAL_OFFICIAL_SOURCE_SHA256_V2) {
    openingTerminalV2LoweringError("the edit must be rebased from the pinned official source generation.");
  }
  if (
    incoming !== null ||
    request.destination !== null ||
    frame.height !== 8 ||
    frame.width !== 128 / 9 ||
    !Number.isFinite(request.viewport.height) ||
    !Number.isFinite(request.viewport.width) ||
    request.viewport.height <= 0 ||
    request.viewport.width <= 0 ||
    (request.cameraCenter?.x ?? 0) !== 0 ||
    (request.cameraCenter?.y ?? 0) !== 0
  ) {
    openingTerminalV2LoweringError("the exact terminal Scene and default Runtime Trace camera are required.");
  }
  const base = inspectOpeningManimTerminalPositionSourceV2(source, request.sceneName);
  if (base.plan.translation) openingTerminalV2LoweringError("the pinned base source must not contain a prior edit.");
  const bindings = request.sourceBindings.filter(
    ({ entityId, sourceVariable }) => sourceVariable === "grid_title" || entityId === base.bindingEntityId,
  );
  if (
    bindings.length !== 1 ||
    bindings[0]?.entityId !== base.bindingEntityId ||
    bindings[0].sourceVariable !== "grid_title"
  ) {
    openingTerminalV2LoweringError("one exact SourceAnalysis grid_title binding is required.");
  }
  const programs = renderRequestPrograms(request);
  const entry = entries[0];
  const program = programs[0];
  const operation = program?.operations[0];
  const anchorSource = program?.anchor.source;
  if (
    programs.length !== 1 ||
    entries.length !== 1 ||
    !entry ||
    !program ||
    JSON.stringify(entry.program) !== JSON.stringify(program) ||
    entry.sourceAnchor !== OPENING_TERMINAL_SOURCE_TIME_V2 ||
    program.version !== EDIT_OPERATION_VERSION ||
    program.anchor.capturedPlayhead !== OPENING_TERMINAL_SOURCE_TIME_V2 ||
    program.anchor.resolvedSeconds !== OPENING_TERMINAL_SOURCE_TIME_V2 ||
    !anchorSource ||
    !(
      (anchorSource.kind === "absolute" && anchorSource.seconds === OPENING_TERMINAL_SOURCE_TIME_V2) ||
      (anchorSource.kind === "playhead" && anchorSource.referenceSeconds === OPENING_TERMINAL_SOURCE_TIME_V2)
    ) ||
    program.intentCount !== 1 ||
    program.loweringStatus !== "supported" ||
    program.provenance.origin !== "direct-manipulation" ||
    program.requestedExecution !== "parallel" ||
    program.operations.length !== 1 ||
    !operation ||
    operation.kind !== "SetProperty" ||
    operation.key !== "position" ||
    operation.entityId !== base.bindingEntityId ||
    operation.dependsOn.length !== 0 ||
    operation.provenance.origin !== "direct-manipulation" ||
    operation.interval.start !== OPENING_TERMINAL_SOURCE_TIME_V2 ||
    operation.interval.end !== OPENING_TERMINAL_SOURCE_TIME_V2 ||
    program.schedule.mode !== "parallel" ||
    program.schedule.edges.length !== 0 ||
    program.schedule.order.length !== 1 ||
    program.schedule.order[0] !== operation.id ||
    !isPoint(operation.value) ||
    !Number.isFinite(operation.value.x) ||
    !Number.isFinite(operation.value.y)
  ) {
    openingTerminalV2LoweringError("one exact grid_title position Program at source time fourteen is required.");
  }
  if (
    !runtimeSourceCenter ||
    !Number.isFinite(runtimeSourceCenter.x) ||
    !Number.isFinite(runtimeSourceCenter.y) ||
    Math.abs(runtimeSourceCenter.x) > MAX_COORDINATE ||
    Math.abs(runtimeSourceCenter.y) > MAX_COORDINATE
  ) {
    openingTerminalV2LoweringError("a finite bounded correlated Runtime Trace grid_title center is required.");
  }
  const target = {
    x: (operation.value.x / request.viewport.width - 0.5) * frame.width,
    y: (0.5 - operation.value.y / request.viewport.height) * frame.height,
  };
  const translation = { x: target.x - runtimeSourceCenter.x, y: target.y - runtimeSourceCenter.y };
  if (
    !Number.isFinite(translation.x) ||
    !Number.isFinite(translation.y) ||
    (nearlyEqual(translation.x, 0) && nearlyEqual(translation.y, 0)) ||
    Math.abs(translation.x) > MAX_COORDINATE ||
    Math.abs(translation.y) > MAX_COORDINATE
  ) {
    openingTerminalV2LoweringError("the correlated position must produce one finite nonzero bounded translation.");
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const indentation = source.split(/\r?\n/)[base.plan.anchorLine]?.match(/^\s*/)?.[0] ?? "";
  if (indentation !== "        ") openingTerminalV2LoweringError("the pinned final-wait indentation changed.");
  const insertedCode = `${indentation}grid_title.shift((${formatPointCoordinate(translation.x)}, ${formatPointCoordinate(translation.y)}, 0))`;
  const lines = source.split(/\r?\n/);
  lines.splice(base.plan.anchorLine, 0, insertedCode);
  const loweredSource = lines.join(newline);
  const derived = deriveOpeningManimTerminalPositionSourceEditPlanV2(loweredSource, request.sceneName);
  if (
    !derived.translation ||
    !nearlyEqual(derived.translation.x, translation.x) ||
    !nearlyEqual(derived.translation.y, translation.y)
  ) {
    openingTerminalV2LoweringError("the emitted source does not re-derive the correlated translation.");
  }
  return {
    anchorLine: base.plan.anchorLine,
    anchorLines: [base.plan.anchorLine],
    insertedCode,
    preflight: {
      baseSourceHash: OPENING_TERMINAL_OFFICIAL_SOURCE_SHA256_V2,
      kind: "fast-manim-opening-terminal-v2",
    },
    source: loweredSource,
  };
}

function updatersTerminalV1LoweringError(message: string): never {
  throw new ProgramLoweringError("operation-unsupported", `UpdatersExample terminal edit V1: ${message}`);
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 0.000001 * Math.max(1, Math.abs(left), Math.abs(right));
}

function exactUpdatersTerminalAnchor(program: CanonicalEditProgram) {
  const source = program.anchor.source;
  return (
    (source.kind === "absolute" && source.seconds === UPDATERS_TERMINAL_SOURCE_TIME_V1) ||
    (source.kind === "playhead" && source.referenceSeconds === UPDATERS_TERMINAL_SOURCE_TIME_V1)
  );
}

function boundedUpdatersTerminalEditPlan(
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  squareEntityId: string,
) {
  const programs = renderRequestPrograms(request);
  if (
    programs.length < 1 ||
    programs.length > 2 ||
    entries.length !== programs.length ||
    programs.some((program, index) => JSON.stringify(program) !== JSON.stringify(entries[index]?.program))
  ) {
    updatersTerminalV1LoweringError("one or two correlated terminal Programs are accepted.");
  }

  let position: Readonly<{ x: number; y: number }> | null = null;
  let scale: number | null = null;
  for (const { program, sourceAnchor } of entries) {
    const operation = program.operations[0];
    const expectedMode = operation?.kind === "ResizeEntity" ? "sequence" : "parallel";
    if (
      sourceAnchor !== UPDATERS_TERMINAL_SOURCE_TIME_V1 ||
      program.version !== EDIT_OPERATION_VERSION ||
      program.anchor.capturedPlayhead !== UPDATERS_TERMINAL_SOURCE_TIME_V1 ||
      program.anchor.resolvedSeconds !== UPDATERS_TERMINAL_SOURCE_TIME_V1 ||
      !exactUpdatersTerminalAnchor(program) ||
      program.intentCount !== 1 ||
      program.loweringStatus !== "supported" ||
      program.provenance.origin !== "direct-manipulation" ||
      program.requestedExecution !== expectedMode ||
      program.operations.length !== 1 ||
      !operation ||
      operation.dependsOn.length !== 0 ||
      operation.provenance.origin !== "direct-manipulation" ||
      program.schedule.mode !== expectedMode ||
      program.schedule.edges.length !== 0 ||
      program.schedule.order.length !== 1 ||
      program.schedule.order[0] !== operation.id ||
      operation.interval.start !== UPDATERS_TERMINAL_SOURCE_TIME_V1 ||
      operation.interval.end !== UPDATERS_TERMINAL_SOURCE_TIME_V1 ||
      !("entityId" in operation) ||
      operation.entityId !== squareEntityId
    ) {
      updatersTerminalV1LoweringError(
        "each edit must be one exact direct-manipulation operation on `square` at source time five.",
      );
    }

    if (operation.kind === "SetProperty" && operation.key === "position") {
      if (
        position !== null ||
        !isPoint(operation.value) ||
        !Number.isFinite(operation.value.x) ||
        !Number.isFinite(operation.value.y)
      ) {
        updatersTerminalV1LoweringError("position must be one finite absolute point.");
      }
      position = { x: operation.value.x, y: operation.value.y };
      continue;
    }

    if (operation.kind === "ResizeEntity") {
      const from = operation.from.dimensions;
      const to = operation.to.dimensions;
      const fromWidth = from.width;
      const fromHeight = from.height;
      const toWidth = to.width;
      const toHeight = to.height;
      const sameCenter =
        Number.isFinite(operation.from.position.x) &&
        Number.isFinite(operation.from.position.y) &&
        Number.isFinite(operation.to.position.x) &&
        Number.isFinite(operation.to.position.y) &&
        nearlyEqual(operation.from.position.x, operation.to.position.x) &&
        nearlyEqual(operation.from.position.y, operation.to.position.y);
      if (
        scale !== null ||
        operation.shape !== "rectangle" ||
        operation.scale !== 1 ||
        from.radius !== undefined ||
        to.radius !== undefined ||
        typeof fromWidth !== "number" ||
        typeof fromHeight !== "number" ||
        typeof toWidth !== "number" ||
        typeof toHeight !== "number" ||
        !Number.isFinite(fromWidth) ||
        !Number.isFinite(fromHeight) ||
        !Number.isFinite(toWidth) ||
        !Number.isFinite(toHeight) ||
        fromWidth <= 0 ||
        fromHeight <= 0 ||
        toWidth <= 0 ||
        toHeight <= 0 ||
        !nearlyEqual(fromWidth, 2) ||
        !nearlyEqual(fromHeight, 2) ||
        !nearlyEqual(fromWidth, fromHeight) ||
        !nearlyEqual(toWidth, toHeight) ||
        !sameCenter
      ) {
        updatersTerminalV1LoweringError(
          "resize must be one center-preserving positive uniform resize from the pinned 2x2 Square.",
        );
      }
      const widthFactor = toWidth / fromWidth;
      const heightFactor = toHeight / fromHeight;
      if (
        !Number.isFinite(widthFactor) ||
        widthFactor <= 0 ||
        widthFactor > MAX_COORDINATE ||
        !nearlyEqual(widthFactor, heightFactor)
      ) {
        updatersTerminalV1LoweringError(
          `resize must have one finite positive uniform scale factor at most ${MAX_COORDINATE}.`,
        );
      }
      scale = widthFactor;
      continue;
    }

    updatersTerminalV1LoweringError("only canonical position and positive uniform resize operations are accepted.");
  }

  if (position === null && scale === null) {
    updatersTerminalV1LoweringError("the Programs contain no supported terminal edit.");
  }
  return { position, scale } as const;
}

export type UpdatersTerminalSourceEditPlanV1 = Readonly<{
  anchorLine: number;
  moveTo: Readonly<{ x: number; y: number; z: 0 }> | null;
  refreshDependentUpdater: boolean;
  scale: number | null;
  sourceTime: typeof UPDATERS_TERMINAL_SOURCE_TIME_V1;
}>;

const UPDATERS_TERMINAL_BASE_STATEMENTS_V1 = [
  "decimal = DecimalNumber(\n0,\nshow_ellipsis=True,\nnum_decimal_places=3,\ninclude_sign=True,\n)",
  "square = Square().to_edge(UP)",
  "decimal.add_updater(lambda d: d.next_to(square, RIGHT))",
  "decimal.add_updater(lambda d: d.set_value(square.get_center()[1]))",
  "self.add(square, decimal)",
  "self.play(\nsquare.animate.to_edge(DOWN),\nrate_func=there_and_back,\nrun_time=5,\n)",
] as const;

function parseCanonicalUpdatersMoveV1(statement: string) {
  const match = statement.match(/^square\.move_to\(\(([^,()]+), ([^,()]+), 0\)\)$/);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.abs(x) > MAX_COORDINATE ||
    Math.abs(y) > MAX_COORDINATE ||
    formatPointCoordinate(x) !== match[1] ||
    formatPointCoordinate(y) !== match[2]
  ) {
    return null;
  }
  return { x, y, z: 0 as const };
}

function parseCanonicalUpdatersScaleV1(statement: string) {
  const match = statement.match(/^square\.scale\(([^()]+)\)$/);
  if (!match) return null;
  const scale = Number(match[1]);
  if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_COORDINATE || formatPositiveAmount(scale) !== match[1]) {
    return null;
  }
  return scale;
}

/**
 * Independently derives the only edited-source plan admitted for the pinned
 * UpdatersExample family. Removing the optional canonical statements must
 * reproduce the exact official source bytes, so aliases, control flow,
 * updater changes, reordered statements, and any unrelated edit fail closed.
 */
function inspectUpdatersTerminalSourceV1(candidateSource: string, sceneName: string) {
  if (sceneName !== UPDATERS_TERMINAL_SCENE_NAME_V1) {
    updatersTerminalV1LoweringError("candidate Scene identity is outside the pinned profile.");
  }
  const analysis = analyzePythonSource(candidateSource);
  const block = findSourceSceneBlock(
    candidateSource,
    UPDATERS_TERMINAL_SCENE_NAME_V1,
    UPDATERS_TERMINAL_OFFICIAL_SOURCE_PATH_V1,
  );
  const statements = findSourceSceneStatements(
    candidateSource,
    UPDATERS_TERMINAL_SCENE_NAME_V1,
    UPDATERS_TERMINAL_OFFICIAL_SOURCE_PATH_V1,
  );
  const play = statements[UPDATERS_TERMINAL_BASE_STATEMENTS_V1.length - 1];
  const wait = statements.at(-1);
  const editStatements = statements.slice(UPDATERS_TERMINAL_BASE_STATEMENTS_V1.length, -1);
  const directStatementLines = block
    ? analysis.lines
        .slice(block.bodyStart, block.bodyEnd)
        .flatMap((line, offset) => (isPythonStatementStart(line) ? [block.bodyStart + offset] : []))
    : [];
  if (
    !analysis.valid ||
    !block ||
    block.bodyIndent !== 8 ||
    statements.length < UPDATERS_TERMINAL_BASE_STATEMENTS_V1.length + 1 ||
    statements.length > UPDATERS_TERMINAL_BASE_STATEMENTS_V1.length + 4 ||
    UPDATERS_TERMINAL_BASE_STATEMENTS_V1.some((text, index) => statements[index]?.text !== text) ||
    wait?.text !== "self.wait()" ||
    directStatementLines.length !== statements.length ||
    directStatementLines.some((line, index) => line !== statements[index]?.line) ||
    directStatementLines.some((line) => analysis.lines[line]?.indentation !== block.bodyIndent) ||
    !play ||
    !wait ||
    play.line + play.text.split("\n").length !== (editStatements[0]?.line ?? wait.line) ||
    editStatements.some((statement, index) => statement.line + 1 !== (editStatements[index + 1]?.line ?? wait.line)) ||
    analysis.lines[play.line]?.code.trim() !== "self.play(" ||
    analysis.lines[wait.line]?.code.trim() !== "self.wait()" ||
    analysis.lines[(editStatements[0]?.line ?? wait.line) - 1]?.bracketDepthAfter !== 0
  ) {
    updatersTerminalV1LoweringError(
      "SourceAnalysis could not prove the direct boundary after the five-second play and before the final wait.",
    );
  }

  const refreshDependentUpdater = editStatements.length > 0;
  const transformStatements = refreshDependentUpdater ? editStatements.slice(0, -1) : editStatements;
  if (refreshDependentUpdater && editStatements.at(-1)?.text !== "decimal.update(0)") {
    updatersTerminalV1LoweringError(
      "candidate edits must end with the exact `decimal.update(0)` dependent-updater refresh.",
    );
  }

  let moveTo: Readonly<{ x: number; y: number; z: 0 }> | null = null;
  let scale: number | null = null;
  for (const [index, statement] of transformStatements.entries()) {
    const parsedMove = parseCanonicalUpdatersMoveV1(statement.text);
    if (parsedMove && moveTo === null && scale === null && index === 0) {
      moveTo = parsedMove;
      continue;
    }
    const parsedScale = parseCanonicalUpdatersScaleV1(statement.text);
    if (parsedScale !== null && scale === null && (index === 0 || (index === 1 && moveTo !== null))) {
      scale = parsedScale;
      continue;
    }
    updatersTerminalV1LoweringError("candidate edits must be one canonical move followed by one canonical scale.");
  }
  if (refreshDependentUpdater && moveTo === null && scale === null) {
    updatersTerminalV1LoweringError("the dependent-updater refresh requires one preceding terminal Square edit.");
  }

  const newline = candidateSource.includes("\r\n") ? "\r\n" : "\n";
  const baseLines = candidateSource.split(/\r?\n/);
  for (const statement of [...editStatements].reverse()) baseLines.splice(statement.line, 1);
  const baseSource = baseLines.join(newline);
  const importedBase = importManimScene(
    baseSource,
    UPDATERS_TERMINAL_OFFICIAL_SOURCE_PATH_V1,
    UPDATERS_TERMINAL_SCENE_NAME_V1,
  );
  if (
    !importedBase ||
    importedBase.sourceHash !== UPDATERS_TERMINAL_OFFICIAL_SOURCE_SHA256_V1 ||
    Object.keys(importedBase.sourceVariables).length !== 1 ||
    !Object.values(importedBase.sourceVariables).includes("square")
  ) {
    updatersTerminalV1LoweringError("candidate bytes do not reduce to the pinned official source generation.");
  }
  return {
    officialSource: baseSource,
    plan: {
      anchorLine: wait.line - editStatements.length,
      moveTo,
      refreshDependentUpdater,
      scale,
      sourceTime: UPDATERS_TERMINAL_SOURCE_TIME_V1,
    } satisfies UpdatersTerminalSourceEditPlanV1,
  } as const;
}

export function deriveUpdatersTerminalSourceEditPlanV1(
  candidateSource: string,
  sceneName: string,
): UpdatersTerminalSourceEditPlanV1 {
  return inspectUpdatersTerminalSourceV1(candidateSource, sceneName).plan;
}

/** Recovers only the exact pinned generation after the candidate family has
 * passed the same SourceAnalysis proof used by lowering. */
export function recoverUpdatersTerminalOfficialSourceV1(candidateSource: string, sceneName: string) {
  const inspected = inspectUpdatersTerminalSourceV1(candidateSource, sceneName);
  if ((inspected.plan.moveTo === null && inspected.plan.scale === null) || !inspected.plan.refreshDependentUpdater) {
    updatersTerminalV1LoweringError("candidate source must contain one supported terminal edit.");
  }
  return inspected.officialSource;
}

/**
 * Lowers the first bounded dynamic-Python edit family. SourceAnalysis owns the
 * rewrite boundary; Runtime Trace evidence may identify the terminal Square,
 * but it never authorizes source mutation by itself.
 */
export function lowerUpdatersTerminalTransformSourceV1(
  source: string,
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
): LoweredProgramBatchSource | null {
  if (
    request.sourcePath !== UPDATERS_TERMINAL_OFFICIAL_SOURCE_PATH_V1 ||
    request.sceneName !== UPDATERS_TERMINAL_SCENE_NAME_V1
  ) {
    return null;
  }
  if (request.sourceHash !== UPDATERS_TERMINAL_OFFICIAL_SOURCE_SHA256_V1) {
    updatersTerminalV1LoweringError("the edit must be rebased from the pinned official source generation.");
  }
  const imported = importManimScene(source, request.sourcePath, request.sceneName, frame);
  if (!imported || imported.sourceHash !== UPDATERS_TERMINAL_OFFICIAL_SOURCE_SHA256_V1) {
    updatersTerminalV1LoweringError("the current source bytes are not the pinned official source generation.");
  }
  if (incoming !== null || request.destination !== null) {
    updatersTerminalV1LoweringError("Scene transitions are outside this bounded round-trip profile.");
  }
  if (
    !Number.isFinite(frame.height) ||
    !Number.isFinite(frame.width) ||
    frame.height <= 0 ||
    frame.width <= 0 ||
    !Number.isFinite(request.viewport.height) ||
    !Number.isFinite(request.viewport.width) ||
    request.viewport.height <= 0 ||
    request.viewport.width <= 0
  ) {
    updatersTerminalV1LoweringError("the Studio frame and viewport must be finite and positive.");
  }
  const cameraCenter = request.cameraCenter ?? { x: 0, y: 0 };
  if (
    !Number.isFinite(cameraCenter.x) ||
    !Number.isFinite(cameraCenter.y) ||
    cameraCenter.x !== 0 ||
    cameraCenter.y !== 0
  ) {
    updatersTerminalV1LoweringError("the pinned static camera must remain centered.");
  }

  if (
    Object.keys(imported.sourceVariables).length !== 1 ||
    request.sourceBindings.length !== 1 ||
    request.sourceBindings[0]?.sourceVariable !== "square"
  ) {
    updatersTerminalV1LoweringError("the one exact imported `square` source binding is required.");
  }
  const binding = request.sourceBindings[0]!;
  if (imported.sourceVariables[binding.entityId] !== "square") {
    updatersTerminalV1LoweringError("the target does not match the pinned source-bound Square identity.");
  }
  const { position, scale } = boundedUpdatersTerminalEditPlan(request, entries, binding.entityId);
  const expectedMove =
    position === null
      ? null
      : {
          x: (request.cameraCenter?.x ?? 0) + (position.x / request.viewport.width - 0.5) * frame.width,
          y: (request.cameraCenter?.y ?? 0) + (0.5 - position.y / request.viewport.height) * frame.height,
          z: 0 as const,
        };
  if (
    expectedMove !== null &&
    (!Number.isFinite(expectedMove.x) ||
      !Number.isFinite(expectedMove.y) ||
      Math.abs(expectedMove.x) > MAX_COORDINATE ||
      Math.abs(expectedMove.y) > MAX_COORDINATE)
  ) {
    updatersTerminalV1LoweringError(
      `position must lower to finite Manim coordinates between -${MAX_COORDINATE} and ${MAX_COORDINATE}.`,
    );
  }

  const basePlan = deriveUpdatersTerminalSourceEditPlanV1(source, request.sceneName);
  if (basePlan.moveTo !== null || basePlan.scale !== null || basePlan.refreshDependentUpdater) {
    updatersTerminalV1LoweringError("the pinned base source must not contain a prior terminal edit.");
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const indentation = lines[basePlan.anchorLine]?.match(/^\s*/)?.[0] ?? "";
  if (indentation !== "        ") {
    updatersTerminalV1LoweringError("the pinned final-wait indentation changed.");
  }
  const insertedLines = [
    ...(position === null
      ? []
      : [`${indentation}square.move_to(${pointExpression(position, frame, request.viewport)})`]),
    ...(scale === null ? [] : [`${indentation}square.scale(${formatPositiveAmount(scale)})`]),
    `${indentation}decimal.update(0)`,
  ];
  lines.splice(basePlan.anchorLine, 0, ...insertedLines);
  const loweredSource = lines.join(newline);
  const derivedPlan = deriveUpdatersTerminalSourceEditPlanV1(loweredSource, request.sceneName);
  if (
    (expectedMove === null) !== (derivedPlan.moveTo === null) ||
    (expectedMove !== null &&
      derivedPlan.moveTo !== null &&
      (!nearlyEqual(expectedMove.x, derivedPlan.moveTo.x) || !nearlyEqual(expectedMove.y, derivedPlan.moveTo.y))) ||
    (scale === null) !== (derivedPlan.scale === null) ||
    (scale !== null && derivedPlan.scale !== null && !nearlyEqual(scale, derivedPlan.scale)) ||
    !derivedPlan.refreshDependentUpdater
  ) {
    updatersTerminalV1LoweringError("the emitted source does not re-derive the requested terminal edit plan.");
  }
  return {
    anchorLine: basePlan.anchorLine,
    anchorLines: [basePlan.anchorLine],
    insertedCode: insertedLines.join(newline),
    preflight: {
      baseSourceHash: UPDATERS_TERMINAL_OFFICIAL_SOURCE_SHA256_V1,
      kind: "fast-manim-updaters-terminal-v1",
    },
    source: loweredSource,
  };
}

/**
 * Lowers validated Programs as one atomic source export. Entries carry both
 * their rebased runtime Program and the immutable source anchor that selected
 * the insertion boundary. Programs sharing one source anchor remain in input
 * order; distinct anchors are emitted in source order.
 */
export function lowerCanonicalProgramBatchSource(
  source: string,
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
): LoweredProgramBatchSource {
  const squareToCircleV8 = lowerSquareToCircleInitialPositionSourceV8(source, request, entries, frame, incoming);
  if (squareToCircleV8) return squareToCircleV8;
  const warpSquareV9 = lowerWarpSquareInitialTransformSourceV9(source, request, entries, frame, incoming);
  if (warpSquareV9) return warpSquareV9;
  const lineJointsV10 = lowerLineJointsInitialTransformSourceV10(source, request, entries, frame, incoming);
  if (lineJointsV10) return lineJointsV10;
  const writeStuffV12 = lowerWriteStuffInitialTransformSourceV12(source, request, entries, frame, incoming);
  if (writeStuffV12) return writeStuffV12;
  const updatersTerminalV1 = lowerUpdatersTerminalTransformSourceV1(source, request, entries, frame, incoming);
  if (updatersTerminalV1) return updatersTerminalV1;
  if (entries.length === 0) {
    throw new ProgramLoweringError("operation-unsupported", "A source export batch must contain at least one Program.");
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const sourceBindings = new Map(request.sourceBindings.map((binding) => [binding.entityId, binding.sourceVariable]));
  const generatedEntityIds = new Set<string>();
  const generatedSourceVariables = new Set<string>();
  const entityScaleStates = new Map<string, SourceScaleState>();
  const entityAliases = new Map<string, ReadonlySet<string>>(
    [...sourceBindings].map(([entityId, sourceVariable]) => [entityId, new Set([sourceVariable])]),
  );
  const groups: MutableBatchGroup[] = [];
  // A finite lifetime ends immediately before Programs inserted at that same
  // source boundary, matching the evaluator's strict end > insertion check.
  const sourceEntries = [...finiteCreatedLifetimeEntries(entries), ...entries];
  const orderedEntries = sourceEntries
    .map((entry, inputIndex) => ({ ...entry, inputIndex }))
    .sort((left, right) => left.sourceAnchor - right.sourceAnchor || left.inputIndex - right.inputIndex);
  const normalizedEntries = normalizeSceneDurationTrims(orderedEntries);

  if (normalizedEntries.length === 0) {
    const anchor = findSceneMotionAnchors(source, request.sceneName).find(
      (candidate) => Math.abs(candidate.seconds - orderedEntries[0]!.sourceAnchor) < EPSILON,
    );
    if (!anchor) {
      throw new ProgramLoweringError(
        "anchor-missing",
        `No # poietra:anchor ${orderedEntries[0]!.sourceAnchor.toFixed(3)} marker exists in ${request.sourcePath}.`,
      );
    }
    return { anchorLine: anchor.line, anchorLines: [anchor.line], insertedCode: "", source };
  }

  for (const entry of normalizedEntries) {
    const lowered = lowerCanonicalProgramSource(
      source,
      singleProgramRequest(
        request,
        entry.program,
        [...sourceBindings].map(([entityId, sourceVariable]) => ({
          entityId,
          sourceVariable,
        })),
      ),
      frame,
      incoming,
      {
        entityAliases,
        entityScaleStates,
        finiteCreatedLifetimesHandled: true,
        generatedEntityIds,
        reservedSourceVariables: generatedSourceVariables,
        sourceAnchor: entry.sourceAnchor,
      },
    );
    for (const aliases of lowered.entityAliases) {
      entityAliases.set(aliases.entityId, new Set(aliases.sourceVariables));
    }
    for (const binding of lowered.entityBindings) {
      const existing = sourceBindings.get(binding.entityId);
      if (existing && existing !== binding.sourceVariable) {
        throw new ProgramLoweringError(
          "source-variable-missing",
          `Entity ${binding.entityId} resolves to conflicting generated source variables.`,
        );
      }
      sourceBindings.set(binding.entityId, binding.sourceVariable);
      generatedEntityIds.add(binding.entityId);
      generatedSourceVariables.add(binding.sourceVariable);
    }
    let group = groups.at(-1);
    if (!group || Math.abs(group.sourceAnchor - entry.sourceAnchor) >= EPSILON) {
      group = {
        anchorLine: lowered.anchorLine,
        duration: 0,
        insertedLines: [],
        sourceAnchor: entry.sourceAnchor,
      };
      groups.push(group);
    }
    group.duration += insertedProgramDuration(entry.program);
    if (lowered.insertedCode) group.insertedLines.push(...lowered.insertedCode.split(/\r?\n/));
  }

  const lines = source.split(/\r?\n/);
  const sceneBlock = findSourceSceneBlock(source, request.sceneName, request.sourcePath);
  if (!sceneBlock) {
    throw new ProgramLoweringError("anchor-missing", `${request.sceneName} is not present in ${request.sourcePath}.`);
  }
  rewriteSceneTemporalMetadata(source, request.sceneName, request.sourcePath, lines, groups);
  for (const group of [...groups].sort((left, right) => right.anchorLine - left.anchorLine)) {
    const priorDuration = groups.reduce(
      (duration, candidate) =>
        candidate.sourceAnchor < group.sourceAnchor - EPSILON ? duration + candidate.duration : duration,
      0,
    );
    const indentation = lines[group.anchorLine - 1]?.match(/^\s*/)?.[0] ?? "";
    lines.splice(
      group.anchorLine - 1,
      1,
      `${indentation}# poietra:cursor ${formatAmount(group.sourceAnchor + priorDuration)}`,
      ...group.insertedLines,
      `${indentation}# poietra:anchor ${formatAmount(group.sourceAnchor + priorDuration + group.duration)}`,
    );
  }
  const currentTransactionIds = new Set(normalizedEntries.map(({ program }) => program.transactionId));
  const compactedSource = collapseRepeatedStaticTransformHistory(
    lines.join(newline),
    frame,
    request.cameraCenter ?? { x: 0, y: 0 },
    currentTransactionIds,
    request.sceneName,
    request.sourcePath,
  );
  return {
    ...canonicalInsertionEvidence(compactedSource, currentTransactionIds, request.sceneName, request.sourcePath),
    source: compactedSource,
  };
}
