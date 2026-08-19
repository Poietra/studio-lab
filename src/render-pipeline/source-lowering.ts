import { createHash } from "node:crypto";

import { MAX_COORDINATE } from "../engine/primitives";
import type { StudioTimelineEditTransformV1 } from "../engine/scene-authoring";
import {
  canonicalEditableContent,
  type EditableContentType,
  STUDIO_TEXT_DEFAULT_LAYOUT,
} from "../studio/editable-content";
import { MAX_ENTITY_SCALE, MIN_ENTITY_SCALE } from "../studio/magic-edit-capabilities";
import type { EntityContent, MotionEasing } from "../studio/model";
import { operationExecutionCapabilities, programExecutionCapabilities } from "../studio/operation-registry";
import { type CreateEntityOperation, EDIT_OPERATION_VERSION } from "../studio/operations";
import { insertedProgramDuration } from "../studio/program-composition";
import { samplePropertyKnowledge, samplePropertyValue } from "../studio/property-sampling";
import { isCanonicalRgbHex, type SceneEdit, type SceneEditOperation } from "../studio/scene-edit-contract";
import { scaleTransformViolation, sceneBoundaryViolation } from "../studio/source-lowering-invariants";
import { type ProgramRenderRequest, renderRequestPrograms, type SingleProgramRenderRequest } from "./contracts";
import {
  PythonReferenceAnalysisError,
  pythonReferenceClosure,
  referencedPythonReferences,
} from "./python-reference-analysis";
import { analyzePythonSource, isPythonStatementStart } from "./python-source-analysis";
import {
  fastManimRuntimeTraceSourceBindingV3Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BINDINGS_V3,
} from "./runtime-trace-v3-shared-contract";
import {
  insertAtSourceBoundaryV1,
  removeDirectSourceStatementsV1,
  SourceAnalysisError,
  type SourceBindingFactV1,
  type SourceInsertionBoundaryV1,
  type SourceStatementFactV1,
  type StudioSourceAnalysisV1,
  studioSourceAnalysisProviderV1,
} from "./source-analysis";
import {
  findSourceSceneBlock,
  findSourceSceneComments,
  findSourceSceneStatements,
  importManimScene,
  isSimpleShiftAnimationStatement,
} from "./source-import";
import { fastManimSourceBindingIdentifierV1, sourceRuntimeSceneIdentifierV1 } from "./source-runtime-identity-digest";

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

export type RuntimeTraceSourceBindingEvidence = Readonly<{
  id: string;
  name: string;
  ordinal: number;
  span: Readonly<{
    endColumn: number;
    endLine: number;
    startColumn: number;
    startLine: number;
  }>;
}>;

export type RuntimeTraceMoveEditPreflight = Readonly<{
  baseBinding: RuntimeTraceSourceBindingEvidence;
  baseSourceHash: string;
  entityId: string;
  expectedWorldCenter: Readonly<{ x: number; y: number }>;
  kind: "runtime-trace-move-edit";
  sourceAnchor: number;
}>;

export type RuntimeTraceResizeEditPreflight = Readonly<{
  baseBinding: RuntimeTraceSourceBindingEvidence;
  baseSourceHash: string;
  entityId: string;
  expectedScaleFactor: number;
  kind: "runtime-trace-resize-edit";
  sourceAnchor: number;
}>;

export type RuntimeTraceRotationEditPreflight = Readonly<{
  baseBinding: RuntimeTraceSourceBindingEvidence;
  baseSourceHash: string;
  entityId: string;
  expectedAngleRadians: number;
  kind: "runtime-trace-rotation-edit";
  sourceAnchor: 0;
}>;

export type RuntimeTraceOpacityEditPreflight = Readonly<{
  baseBinding: RuntimeTraceSourceBindingEvidence;
  baseSourceHash: string;
  entityId: string;
  expectedOpacity: number;
  kind: "runtime-trace-opacity-edit";
  sourceAnchor: 0;
}>;

export type RuntimeTraceEditPreflight =
  | RuntimeTraceMoveEditPreflight
  | RuntimeTraceOpacityEditPreflight
  | RuntimeTraceResizeEditPreflight
  | RuntimeTraceRotationEditPreflight;

export type LoweredProgramBatchSource = Readonly<{
  anchorLine: number;
  anchorLines: readonly number[];
  insertedCode: string;
  preflight?: RuntimeTraceEditPreflight;
  source: string;
}>;

type ProgramSourceLoweringOptions = Readonly<{
  entityAliases?: ReadonlyMap<string, ReadonlySet<string>>;
  entityOpacityStates?: Map<string, number>;
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

function loweredProgramDuration(program: SceneEdit) {
  const waitEnd = Math.max(
    program.anchor.resolvedSeconds,
    ...program.operations.flatMap((operation) =>
      operation.kind === "InsertTimelineEvent" && operation.eventKind === "wait" ? [operation.interval.end] : [],
    ),
  );
  return Math.max(insertedProgramDuration(program), waitEnd - program.anchor.resolvedSeconds);
}
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

function worldPointFromViewport(
  point: Readonly<{ x: number; y: number }>,
  frame: Readonly<{ height: number; width: number }>,
  viewport: Readonly<{ height: number; width: number }>,
  cameraCenter: Readonly<{ x: number; y: number }> = { x: 0, y: 0 },
) {
  return {
    x: Number(formatPointCoordinate(cameraCenter.x + (point.x / viewport.width - 0.5) * frame.width)),
    y: Number(formatPointCoordinate(cameraCenter.y + (0.5 - point.y / viewport.height) * frame.height)),
  } as const;
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

function manimTextConstructor(
  text: string,
  options: Readonly<{ layout?: EntityContent["textLayout"]; unitHeight?: boolean }> = {},
) {
  if (/[^\u0020-\u007e]/u.test(text)) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Manim .py export does not yet preserve Unicode or multiline Text faithfully. Preview and MP4 export support this text, but Python export would not preserve it faithfully.",
    );
  }
  const layout = options.layout ?? STUDIO_TEXT_DEFAULT_LAYOUT;
  if (
    layout.alignment !== STUDIO_TEXT_DEFAULT_LAYOUT.alignment ||
    layout.lineHeight !== STUDIO_TEXT_DEFAULT_LAYOUT.lineHeight
  ) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Manim .py export does not yet preserve Studio Text alignment or line height faithfully. Preview and MP4 export support this layout, but Python export would not preserve it faithfully.",
    );
  }
  if (!options.unitHeight) return `Text(${JSON.stringify(text)})`;
  return `Text(${JSON.stringify(text)}, font="DejaVu Sans", disable_ligatures=True).scale_to_fit_height(${formatAmount(layout.fontSize)})`;
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
    return manimTextConstructor(text, { layout: content?.textLayout, unitHeight: true });
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

function referencedBaseEntityIds(operations: readonly SceneEditOperation[]) {
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

function operationTime(operation: SceneEditOperation) {
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
    return { content, constructor: manimTextConstructor(content.text, { layout: content.textLayout }), type: "Text" };
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
  SceneEditOperation,
  {
    kind: "AnimateProperty" | "ChangePresence" | "CreateMotion" | "ResizeEntity" | "TransformContent";
  }
>;

function animationOperation(operation: SceneEditOperation): operation is LoweredAnimationOperation {
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

function scaleChange(operation: Extract<SceneEditOperation, { kind: "AnimateProperty" }>) {
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
  operation: Extract<SceneEditOperation, { kind: "ResizeEntity" }>,
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
  operation: Extract<SceneEditOperation, { kind: "ResizeEntity" }>,
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

function assertLoweringSupported(operation: SceneEditOperation, options: ProgramSourceLoweringOptions) {
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
  if (operation.kind === "SetProperty" && operation.key === "appearance") {
    if (options.generatedEntityIds?.has(operation.entityId)) return;
    throw new ProgramLoweringError("operation-unsupported", "Opacity requires the Runtime Trace source lowerer.");
  }
  if (operation.kind === "SetProperty" && operation.key === "sourceZIndex") {
    if (
      options.generatedEntityIds?.has(operation.entityId) &&
      typeof operation.value === "number" &&
      Number.isFinite(operation.value)
    )
      return;
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Layer order currently supports only Studio-created objects with a finite canonical z-index.",
    );
  }
  if (operation.kind === "AnimateProperty" && operation.key === "appearance") {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Opacity keyframes are available in the canonical client preview and video export, but not Manim source export.",
    );
  }
  if (operation.kind === "SetProperty" && (operation.key === "fillColor" || operation.key === "strokeColor")) {
    if (!isCanonicalRgbHex(operation.value)) {
      throw new ProgramLoweringError(
        "operation-unsupported",
        "Shape colors require a lowercase canonical #rrggbb value.",
      );
    }
    if (options.generatedEntityIds?.has(operation.entityId)) return;
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Shape colors currently support only Studio-created Circle and Rectangle entities.",
    );
  }
  if (operation.kind === "AnimateProperty" && operation.key === "rotation") {
    if (options.generatedEntityIds?.has(operation.entityId)) return;
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Relative rotation requires the Runtime Trace source lowerer.",
    );
  }
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
  operations: readonly SceneEditOperation[],
  sourceBindings: ReadonlyMap<string, string>,
  generatedEntityIds: ReadonlySet<string> | undefined,
  entityScaleStates: Map<string, SourceScaleState> | undefined,
  frame: Readonly<{ height: number; width: number }>,
) {
  const scales = operations.filter(
    (
      operation,
    ): operation is Extract<
      SceneEditOperation,
      {
        kind: "AnimateProperty";
      }
    > => operation.kind === "AnimateProperty" && operation.key === "scale",
  );
  const transforms = operations.filter(
    (
      operation,
    ): operation is Extract<
      SceneEditOperation,
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
  operations: readonly SceneEditOperation[],
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
  operations: readonly SceneEditOperation[],
  sourceBindings: ReadonlyMap<string, string>,
  options: ProgramSourceLoweringOptions,
  frame: Readonly<{ height: number; width: number }>,
) {
  const contentEdits = operations.filter(
    (operation): operation is Extract<SceneEditOperation, { kind: "SetProperty" }> =>
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

function operationBuckets(operations: readonly SceneEditOperation[]) {
  const buckets: Array<{ operations: SceneEditOperation[]; time: number }> = [];
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
  request.program.operations.forEach((operation) => assertLoweringSupported(operation, options));
  const execution = programExecutionCapabilities(request.program);
  if (execution.lowering !== "supported") {
    throw new ProgramLoweringError(
      "operation-unsupported",
      execution.applyBlocker ??
        `Program ${request.program.transactionId} is marked ${execution.lowering}, not supported.`,
    );
  }
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
        options.entityOpacityStates?.set(operation.entity.id, 1);
      } else if (operation.kind === "TransformContent") {
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        const target =
          operation.targetType === "Text"
            ? manimTextConstructor(operation.replacement.text ?? operation.replacement.displayLines.join(" "), {
                layout: operation.replacement.textLayout,
              })
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
    for (const operation of bucket) {
      const variable = "entityId" in operation ? requireVariable(variableByEntity, operation.entityId) : null;
      if (
        variable &&
        operation.kind === "SetProperty" &&
        operation.key === "appearance" &&
        typeof operation.value === "number"
      ) {
        output.push(`${variable}.set_opacity(${formatAmount(operation.value)})`);
        options.entityOpacityStates?.set(operation.entityId, operation.value);
      } else if (
        variable &&
        operation.kind === "SetProperty" &&
        operation.key === "sourceZIndex" &&
        typeof operation.value === "number" &&
        Number.isFinite(operation.value)
      ) {
        output.push(`${variable}.set_z_index(${formatAmount(operation.value)})`);
      } else if (
        variable &&
        operation.kind === "SetProperty" &&
        operation.key === "fillColor" &&
        isCanonicalRgbHex(operation.value)
      ) {
        const opacity = options.entityOpacityStates?.get(operation.entityId) ?? 1;
        output.push(`${variable}.set_fill(${JSON.stringify(operation.value)}, opacity=${formatAmount(opacity)})`);
      } else if (
        variable &&
        operation.kind === "SetProperty" &&
        operation.key === "strokeColor" &&
        isCanonicalRgbHex(operation.value)
      ) {
        output.push(`${variable}.set_stroke(${JSON.stringify(operation.value)})`);
      } else if (
        variable &&
        operation.kind === "AnimateProperty" &&
        operation.key === "rotation" &&
        typeof operation.relativeDelta === "number"
      ) {
        output.push(`${variable}.rotate(${formatAmount(operation.relativeDelta)})`);
      }
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
      (operation): operation is Extract<SceneEditOperation, { kind: "ChangePresence" }> =>
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
  const insertedDuration = loweredProgramDuration(request.program);
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

function applySceneDurationProjection(
  entries: readonly LoweredProgramBatchEntry[],
  transforms: readonly StudioTimelineEditTransformV1[] | null,
): readonly LoweredProgramBatchEntry[] {
  const durationOperationIds = entries.flatMap((entry) =>
    entry.program.operations.flatMap((operation) =>
      operation.kind === "TrimSceneDuration" ||
      (operation.kind === "InsertTimelineEvent" && operation.purpose === "scene-duration")
        ? [operation.id]
        : [],
    ),
  );
  if (durationOperationIds.length === 0) return entries;
  if (!transforms) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Scene duration source lowering requires the canonical Rust timeline projection.",
    );
  }

  const remainingWaitDuration = new Map<string, number>();
  const projectedOperationIds = new Set<string>();
  for (const transform of transforms) {
    projectedOperationIds.add(transform.operationId);
    if (transform.kind === "insert") {
      remainingWaitDuration.set(transform.operationId, transform.interval.end - transform.interval.start);
      continue;
    }
    for (const reduction of transform.waitReductions) {
      const available = remainingWaitDuration.get(reduction.operationId);
      if (available === undefined || reduction.removedDuration > available + EPSILON) {
        throw new ProgramLoweringError(
          "operation-unsupported",
          `Rust timeline projection returned an uncorrelated wait reduction for ${reduction.operationId}.`,
        );
      }
      remainingWaitDuration.set(reduction.operationId, Math.max(0, available - reduction.removedDuration));
    }
  }
  if (durationOperationIds.some((operationId) => !projectedOperationIds.has(operationId))) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Rust timeline projection did not correlate every Scene duration operation in the source batch.",
    );
  }

  return entries.flatMap((entry) => {
    const operations = entry.program.operations.flatMap((operation): readonly SceneEditOperation[] => {
      if (operation.kind === "TrimSceneDuration") return [];
      if (
        operation.kind !== "InsertTimelineEvent" ||
        operation.eventKind !== "wait" ||
        operation.purpose !== "scene-duration"
      )
        return [operation];
      const duration = remainingWaitDuration.get(operation.id);
      if (duration === undefined) {
        throw new ProgramLoweringError(
          "operation-unsupported",
          `Rust timeline projection did not return duration wait ${operation.id}.`,
        );
      }
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
      const program: SceneEdit = {
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

type ProjectedRuntimeTraceSourceBinding = Readonly<{
  binding: SourceBindingFactV1;
  evidence: RuntimeTraceSourceBindingEvidence;
}>;

export type RuntimeTraceMoveSourceEditPlan = Readonly<{
  baseBinding: RuntimeTraceSourceBindingEvidence;
  baseSource: string;
  baseSourceHash: string;
  candidateBinding: RuntimeTraceSourceBindingEvidence;
  expectedWorldCenter: Readonly<{ x: number; y: number }>;
  sourceAnchor: number;
}>;

export type RuntimeTraceResizeSourceEditPlan = Readonly<{
  baseBinding: RuntimeTraceSourceBindingEvidence;
  baseSource: string;
  baseSourceHash: string;
  candidateBinding: RuntimeTraceSourceBindingEvidence;
  expectedScaleFactor: number;
  sourceAnchor: number;
}>;

export type RuntimeTraceRotationSourceEditPlan = Readonly<{
  baseBinding: RuntimeTraceSourceBindingEvidence;
  baseSource: string;
  baseSourceHash: string;
  candidateBinding: RuntimeTraceSourceBindingEvidence;
  expectedAngleRadians: number;
  sourceAnchor: 0;
}>;

export type RuntimeTraceOpacitySourceEditPlan = Readonly<{
  baseBinding: RuntimeTraceSourceBindingEvidence;
  baseSource: string;
  baseSourceHash: string;
  candidateBinding: RuntimeTraceSourceBindingEvidence;
  expectedOpacity: number;
  sourceAnchor: 0;
}>;

function runtimeTraceEditLoweringError(message: string): never {
  throw new ProgramLoweringError("operation-unsupported", `Runtime Trace edit: ${message}`);
}

function analyzeRuntimeTraceEditSource(source: string, sceneName: string, sourcePath: string) {
  const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
  try {
    return studioSourceAnalysisProviderV1.analyze({
      expectedSourceHash: sourceHash,
      sceneName,
      sourcePath,
      sourceText: source,
    });
  } catch (error) {
    runtimeTraceEditLoweringError(
      `SourceAnalysis rejected the selected Scene${error instanceof SourceAnalysisError ? ` (${error.code})` : ""}.`,
    );
  }
}

/**
 * Mirrors the Runtime Trace producer projection without importing a server
 * module into the shared lowering layer. Only one unambiguous construct-local
 * assignment can authorize the bounded edit.
 */
function projectedRuntimeTraceSourceBindings(
  analysis: StudioSourceAnalysisV1,
): readonly ProjectedRuntimeTraceSourceBinding[] {
  const sceneId = sourceRuntimeSceneIdentifierV1(analysis.sourcePath, analysis.scene.name);
  const candidates = analysis.bindings
    .filter(
      (binding) =>
        binding.kind === "assignment" &&
        binding.scopeId === analysis.scene.construct.scopeId &&
        binding.controlPath.length === 0 &&
        binding.ordinal !== null &&
        !binding.ambiguous &&
        binding.capabilities.move.status === "source-eligible" &&
        binding.capabilities.uniformResize.status === "source-eligible",
    )
    .sort((left, right) => left.ordinal! - right.ordinal!);
  const projected: ProjectedRuntimeTraceSourceBinding[] = [];
  for (const binding of candidates) {
    if (binding.name.normalize("NFKC") !== binding.name) continue;
    const candidate = {
      id: "",
      name: binding.name,
      ordinal: binding.ordinal!,
      span: {
        endColumn: binding.span.endColumn,
        endLine: binding.span.endLine,
        startColumn: binding.span.startColumn,
        startLine: binding.span.startLine,
      },
    };
    candidate.id = fastManimSourceBindingIdentifierV1(analysis.sourceHash, sceneId, candidate);
    const parsed = fastManimRuntimeTraceSourceBindingV3Schema.safeParse(candidate);
    if (!parsed.success) continue;
    projected.push({ binding, evidence: parsed.data });
    if (projected.length === MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BINDINGS_V3) break;
  }
  return projected;
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseCanonicalRuntimeTraceMoveEdit(statement: string, bindingName: string) {
  const match = statement.match(
    new RegExp(`^${escapeRegularExpression(bindingName)}\\.move_to\\(\\(([^,]+), ([^,]+), 0\\)\\)$`, "u"),
  );
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
  return { x, y } as const;
}

function parseCanonicalRuntimeTraceResizeEdit(statement: string, bindingName: string) {
  const match = statement.match(new RegExp(`^${escapeRegularExpression(bindingName)}\\.scale\\(([^()]+)\\)$`, "u"));
  if (!match) return null;
  const factor = Number(match[1]);
  if (
    !Number.isFinite(factor) ||
    factor <= 0 ||
    factor === 1 ||
    factor > MAX_COORDINATE ||
    formatPositiveAmount(factor) !== match[1]
  ) {
    return null;
  }
  return factor;
}

function formatRuntimeTraceRotationAngle(angleRadians: number) {
  return Number(angleRadians.toPrecision(12)).toString();
}

function runtimeTraceRotationIsNoop(angleRadians: number) {
  return Math.abs(Math.atan2(Math.sin(angleRadians), Math.cos(angleRadians))) <= 1e-12;
}

function parseCanonicalRuntimeTraceRotationEdit(statement: string, bindingName: string) {
  const match = statement.match(new RegExp(`^${escapeRegularExpression(bindingName)}\\.rotate\\(([^()]+)\\)$`, "u"));
  if (!match) return null;
  const angleRadians = Number(match[1]);
  if (
    !Number.isFinite(angleRadians) ||
    runtimeTraceRotationIsNoop(angleRadians) ||
    Math.abs(angleRadians) > MAX_COORDINATE ||
    formatRuntimeTraceRotationAngle(angleRadians) !== match[1]
  ) {
    return null;
  }
  return angleRadians;
}

function formatRuntimeTraceOpacity(opacity: number) {
  return Number(opacity.toPrecision(12)).toString();
}

function parseCanonicalRuntimeTraceOpacityEdit(statement: string, bindingName: string) {
  const match = statement.match(
    new RegExp(`^${escapeRegularExpression(bindingName)}\\.set_opacity\\(([^()]+)\\)$`, "u"),
  );
  if (!match) return null;
  const opacity = Number(match[1]);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || formatRuntimeTraceOpacity(opacity) !== match[1]) {
    return null;
  }
  return opacity;
}

function contiguousCanonicalRuntimeTraceEditStatements(
  analysis: StudioSourceAnalysisV1,
  assignmentIndex: number,
  bindingName: string,
) {
  const statements: StudioSourceAnalysisV1["scene"]["statements"][number][] = [];
  let previous = analysis.scene.statements[assignmentIndex];
  for (let index = assignmentIndex + 1; previous; index += 1) {
    const statement = analysis.scene.statements[index];
    if (
      !statement ||
      statement.line !== previous.span.endLine + 1 ||
      statement.indentation !== previous.indentation ||
      (parseCanonicalRuntimeTraceMoveEdit(statement.text, bindingName) === null &&
        parseCanonicalRuntimeTraceResizeEdit(statement.text, bindingName) === null &&
        parseCanonicalRuntimeTraceRotationEdit(statement.text, bindingName) === null &&
        parseCanonicalRuntimeTraceOpacityEdit(statement.text, bindingName) === null)
    ) {
      break;
    }
    statements.push(statement);
    previous = statement;
  }
  return statements;
}

function selectedRuntimeTraceSourceBinding(
  bindings: readonly ProjectedRuntimeTraceSourceBinding[],
  bindingName: string,
  side: "base" | "candidate",
) {
  const matching = bindings.filter(({ evidence }) => evidence.name === bindingName);
  const selected = matching[0];
  if (matching.length !== 1 || !selected) {
    runtimeTraceEditLoweringError(
      `${side} SourceAnalysis must project exactly one unambiguous top-level binding named by the request.`,
    );
  }
  return selected;
}

type RuntimeTraceSourceEditBoundary = Readonly<{
  insertionBoundary: SourceInsertionBoundaryV1;
  statement: SourceStatementFactV1;
  side: "after-assignment" | "before-wait";
}>;

/**
 * Source time zero is the binding assignment boundary. A later Runtime Trace
 * edit is only source-authoritative when the conservative importer proves one
 * static wait beginning at that exact time and SourceAnalysis proves the
 * matching construct-level boundary before it.
 */
function runtimeTraceSourceEditBoundary(
  source: string,
  analysis: StudioSourceAnalysisV1,
  binding: ProjectedRuntimeTraceSourceBinding,
  sourceAnchor: number,
  frame: Readonly<{ height: number; width: number }> = { height: 8, width: 128 / 9 },
): RuntimeTraceSourceEditBoundary {
  if (!Number.isFinite(sourceAnchor) || sourceAnchor < 0) {
    runtimeTraceEditLoweringError("source time must be one finite non-negative value.");
  }
  const assignment = analysis.scene.statements.find(({ id }) => id === binding.binding.statementId);
  if (!assignment) {
    runtimeTraceEditLoweringError("SourceAnalysis could not recover the projected assignment statement.");
  }
  if (sourceAnchor === 0) {
    const insertionBoundary = assignment.insertionAfter;
    if (!insertionBoundary || insertionBoundary.indentation !== assignment.indentation) {
      runtimeTraceEditLoweringError(
        "SourceAnalysis could not prove the direct insertion boundary after the projected assignment.",
      );
    }
    return { insertionBoundary, side: "after-assignment", statement: assignment };
  }

  const imported = importManimScene(source, analysis.sourcePath, analysis.scene.name, frame);
  if (!imported || imported.sourceHash !== analysis.sourceHash) {
    runtimeTraceEditLoweringError("the static source importer could not prove the selected Scene generation.");
  }
  const staticWaits = imported.runtimeSceneState.eventTrack.events.filter(
    (event) =>
      event.kind === "wait" &&
      event.interval !== undefined &&
      Number.isFinite(event.interval.start) &&
      Number.isFinite(event.interval.end) &&
      event.interval.end > event.interval.start &&
      Math.abs(event.interval.end - imported.runtimeSceneState.duration) < EPSILON,
  );
  const matchingWaits = staticWaits.filter(
    (event) => event.interval && Math.abs(event.interval.start - sourceAnchor) < EPSILON,
  );
  const waitEvent = matchingWaits[0];
  const waitLine = waitEvent?.id.match(/:wait:([0-9]+)$/u)?.[1];
  const matchingStatements =
    waitLine === undefined ? [] : analysis.scene.statements.filter(({ line }) => line === Number(waitLine) + 1);
  const waitStatement = matchingStatements[0];
  const insertionBoundary = waitStatement?.insertionBefore;
  if (
    matchingWaits.length !== 1 ||
    !waitEvent?.interval ||
    matchingStatements.length !== 1 ||
    !waitStatement ||
    !insertionBoundary ||
    insertionBoundary.indentation !== assignment.indentation ||
    waitStatement.indentation !== assignment.indentation ||
    assignment.span.endByte >= insertionBoundary.span.startByte
  ) {
    runtimeTraceEditLoweringError(
      "source time must equal the start of the final statically imported construct-level wait after the projected assignment.",
    );
  }
  return {
    insertionBoundary,
    side: "before-wait",
    statement: waitStatement,
  };
}

/**
 * Re-derives one Runtime Trace source edit from candidate bytes and the edited
 * binding name. The candidate may project several top-level bindings; exactly
 * one canonical edit statement must be recoverable from the named binding's
 * direct edit prefix, and removing it must recover exact base evidence.
 */
function deriveRuntimeTraceSourceEditPlan<Value>(
  candidateSource: string,
  sceneName: string,
  sourcePath: string,
  bindingName: string,
  edit: Readonly<{
    label: "move" | "opacity" | "resize" | "rotation";
    malformed: string;
    parse: (statement: string, bindingName: string) => Value | null;
  }>,
  sourceAnchor: number,
) {
  const candidateAnalysis = analyzeRuntimeTraceEditSource(candidateSource, sceneName, sourcePath);
  const candidateBindings = projectedRuntimeTraceSourceBindings(candidateAnalysis);
  const candidateBinding = selectedRuntimeTraceSourceBinding(candidateBindings, bindingName, "candidate");
  if ((edit.label === "opacity" || edit.label === "rotation") && sourceAnchor !== 0) {
    runtimeTraceEditLoweringError(`${edit.label} remains restricted to source time zero.`);
  }
  const candidateBoundary = runtimeTraceSourceEditBoundary(
    candidateSource,
    candidateAnalysis,
    candidateBinding,
    sourceAnchor,
  );
  const assignmentIndex = candidateAnalysis.scene.statements.findIndex(
    ({ id }) => id === candidateBinding.binding.statementId,
  );
  const assignment = candidateAnalysis.scene.statements[assignmentIndex];
  const boundaryStatementIndex = candidateAnalysis.scene.statements.findIndex(
    ({ id }) => id === candidateBoundary.statement.id,
  );
  const directStatement =
    candidateBoundary.side === "after-assignment"
      ? candidateAnalysis.scene.statements[assignmentIndex + 1]
      : candidateAnalysis.scene.statements[boundaryStatementIndex - 1];
  const appendedEdit =
    edit.label === "opacity" || edit.label === "rotation" || (edit.label === "move" && sourceAnchor === 0);
  const statement = appendedEdit
    ? (contiguousCanonicalRuntimeTraceEditStatements(
        candidateAnalysis,
        assignmentIndex,
        candidateBinding.evidence.name,
      ).reduce<(typeof candidateAnalysis.scene.statements)[number] | undefined>(
        (selected, candidate) =>
          edit.parse(candidate.text, candidateBinding.evidence.name) === null ? selected : candidate,
        undefined,
      ) ?? directStatement)
    : directStatement;
  if (
    assignmentIndex < 0 ||
    !assignment ||
    !statement ||
    (!appendedEdit &&
      (statement.indentation !== assignment.indentation ||
        (candidateBoundary.side === "after-assignment"
          ? statement.line !== assignment.span.endLine + 1
          : boundaryStatementIndex < 1 || statement.span.endLine + 1 !== candidateBoundary.statement.line)))
  ) {
    runtimeTraceEditLoweringError(
      `candidate ${edit.label} must be one canonical statement at the proven source-time boundary.`,
    );
  }
  const value = edit.parse(statement.text, candidateBinding.evidence.name);
  if (value === null) {
    runtimeTraceEditLoweringError(`candidate ${edit.label} is not ${edit.malformed}.`);
  }

  let baseSource: string;
  try {
    baseSource = removeDirectSourceStatementsV1(candidateSource, candidateAnalysis, [
      { expectedText: statement.text, statementId: statement.id },
    ]);
  } catch {
    runtimeTraceEditLoweringError(`candidate ${edit.label} does not have one canonical removable source span.`);
  }
  const baseAnalysis = analyzeRuntimeTraceEditSource(baseSource, sceneName, sourcePath);
  const baseBindings = projectedRuntimeTraceSourceBindings(baseAnalysis);
  const baseBinding = selectedRuntimeTraceSourceBinding(baseBindings, bindingName, "base");
  const baseBoundary = runtimeTraceSourceEditBoundary(baseSource, baseAnalysis, baseBinding, sourceAnchor);
  if (
    baseBinding.evidence.name !== candidateBinding.evidence.name ||
    baseBinding.evidence.ordinal !== candidateBinding.evidence.ordinal ||
    JSON.stringify(baseBinding.evidence.span) !== JSON.stringify(candidateBinding.evidence.span) ||
    baseBoundary.side !== candidateBoundary.side
  ) {
    runtimeTraceEditLoweringError(
      `removing the candidate ${edit.label} must recover the same one exact base binding occurrence.`,
    );
  }
  // Removing the edit statement must not disturb any sibling candidate: every
  // other projected binding recovers with identical name/ordinal evidence.
  const candidateSiblings = candidateBindings.filter(({ evidence }) => evidence.name !== bindingName);
  const baseSiblings = baseBindings.filter(({ evidence }) => evidence.name !== bindingName);
  if (
    candidateSiblings.length !== baseSiblings.length ||
    candidateSiblings.some(
      (sibling, index) =>
        baseSiblings[index]?.evidence.name !== sibling.evidence.name ||
        baseSiblings[index]?.evidence.ordinal !== sibling.evidence.ordinal,
    )
  ) {
    runtimeTraceEditLoweringError(
      `removing the candidate ${edit.label} must leave every sibling binding occurrence unchanged.`,
    );
  }
  return {
    baseBinding: baseBinding.evidence,
    baseSource,
    baseSourceHash: baseAnalysis.sourceHash,
    candidateBinding: candidateBinding.evidence,
    sourceAnchor,
    value,
  };
}

export function deriveRuntimeTraceMoveSourceEditPlan(
  candidateSource: string,
  sceneName: string,
  sourcePath: string,
  bindingName: string,
  sourceAnchor = 0,
): RuntimeTraceMoveSourceEditPlan {
  const derived = deriveRuntimeTraceSourceEditPlan(
    candidateSource,
    sceneName,
    sourcePath,
    bindingName,
    {
      label: "move",
      malformed: "one canonical finite bounded move_to call",
      parse: parseCanonicalRuntimeTraceMoveEdit,
    },
    sourceAnchor,
  );
  return {
    baseBinding: derived.baseBinding,
    baseSource: derived.baseSource,
    baseSourceHash: derived.baseSourceHash,
    candidateBinding: derived.candidateBinding,
    expectedWorldCenter: derived.value,
    sourceAnchor: derived.sourceAnchor,
  };
}

export function deriveRuntimeTraceResizeSourceEditPlan(
  candidateSource: string,
  sceneName: string,
  sourcePath: string,
  bindingName: string,
  sourceAnchor = 0,
): RuntimeTraceResizeSourceEditPlan {
  const derived = deriveRuntimeTraceSourceEditPlan(
    candidateSource,
    sceneName,
    sourcePath,
    bindingName,
    {
      label: "resize",
      malformed: "one canonical positive non-identity bounded scale call",
      parse: parseCanonicalRuntimeTraceResizeEdit,
    },
    sourceAnchor,
  );
  return {
    baseBinding: derived.baseBinding,
    baseSource: derived.baseSource,
    baseSourceHash: derived.baseSourceHash,
    candidateBinding: derived.candidateBinding,
    expectedScaleFactor: derived.value,
    sourceAnchor: derived.sourceAnchor,
  };
}

export function deriveRuntimeTraceRotationSourceEditPlan(
  candidateSource: string,
  sceneName: string,
  sourcePath: string,
  bindingName: string,
  sourceAnchor: 0 = 0,
): RuntimeTraceRotationSourceEditPlan {
  const derived = deriveRuntimeTraceSourceEditPlan(
    candidateSource,
    sceneName,
    sourcePath,
    bindingName,
    {
      label: "rotation",
      malformed: "one canonical finite non-noop bounded rotate call",
      parse: parseCanonicalRuntimeTraceRotationEdit,
    },
    sourceAnchor,
  );
  return {
    baseBinding: derived.baseBinding,
    baseSource: derived.baseSource,
    baseSourceHash: derived.baseSourceHash,
    candidateBinding: derived.candidateBinding,
    expectedAngleRadians: derived.value,
    sourceAnchor: 0,
  };
}

export function deriveRuntimeTraceOpacitySourceEditPlan(
  candidateSource: string,
  sceneName: string,
  sourcePath: string,
  bindingName: string,
  sourceAnchor: 0 = 0,
): RuntimeTraceOpacitySourceEditPlan {
  const derived = deriveRuntimeTraceSourceEditPlan(
    candidateSource,
    sceneName,
    sourcePath,
    bindingName,
    {
      label: "opacity",
      malformed: "one canonical finite opacity between zero and one",
      parse: parseCanonicalRuntimeTraceOpacityEdit,
    },
    sourceAnchor,
  );
  return {
    baseBinding: derived.baseBinding,
    baseSource: derived.baseSource,
    baseSourceHash: derived.baseSourceHash,
    candidateBinding: derived.candidateBinding,
    expectedOpacity: derived.value,
    sourceAnchor: 0,
  };
}

type RuntimeTraceEditOperation =
  | Readonly<{
      entityId: string;
      kind: "move";
      sourceAnchor: number;
      value: Readonly<{ x: number; y: number }>;
    }>
  | Readonly<{ entityId: string; kind: "opacity"; sourceAnchor: 0; value: number }>
  | Readonly<{ entityId: string; factor: number; kind: "resize"; sourceAnchor: number }>
  | Readonly<{ angleRadians: number; entityId: string; kind: "rotation"; sourceAnchor: 0 }>;

function runtimeTraceEditOperation(
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
): RuntimeTraceEditOperation | null {
  const programs = renderRequestPrograms(request);
  const fail: () => never = () =>
    runtimeTraceEditLoweringError(
      "only one exact direct-manipulation position move or uniform resize at a finite source time is accepted; opacity and rotation remain restricted to source time zero.",
    );
  const program = programs[0];
  const entry = entries[0];
  const operation = program?.operations[0];
  const runtimeTraceOperation =
    operation?.kind === "SetProperty" || operation?.kind === "ResizeEntity"
      ? true
      : operation?.kind === "AnimateProperty";
  if (!runtimeTraceOperation) return null;
  const sourceAnchor = entry?.sourceAnchor;
  if (
    programs.length !== 1 ||
    entries.length !== 1 ||
    !program ||
    !entry ||
    JSON.stringify(program) !== JSON.stringify(entry.program) ||
    typeof sourceAnchor !== "number" ||
    !Number.isFinite(sourceAnchor) ||
    sourceAnchor < 0 ||
    program.version !== EDIT_OPERATION_VERSION ||
    program.anchor.capturedPlayhead !== sourceAnchor ||
    program.anchor.resolvedSeconds !== sourceAnchor ||
    !(
      (program.anchor.source.kind === "absolute" && program.anchor.source.seconds === sourceAnchor) ||
      (program.anchor.source.kind === "playhead" && program.anchor.source.referenceSeconds === sourceAnchor)
    ) ||
    program.intentCount !== 1 ||
    program.loweringStatus !== "supported" ||
    program.provenance.origin !== "direct-manipulation" ||
    program.requestedExecution !== "parallel" ||
    program.operations.length !== 1 ||
    !operation ||
    operation.dependsOn.length !== 0 ||
    operation.interval.start !== sourceAnchor ||
    operation.interval.end !== sourceAnchor ||
    operation.provenance.origin !== "direct-manipulation" ||
    program.schedule.mode !== "parallel" ||
    program.schedule.edges.length !== 0 ||
    program.schedule.order.length !== 1 ||
    program.schedule.order[0] !== operation.id
  ) {
    fail();
  }
  if (operation.kind === "SetProperty" && operation.key === "position") {
    if (!isPoint(operation.value) || !Number.isFinite(operation.value.x) || !Number.isFinite(operation.value.y)) {
      fail();
    }
    const value = operation.value as Readonly<{ x: number; y: number }>;
    return { entityId: operation.entityId, kind: "move", sourceAnchor, value: { x: value.x, y: value.y } };
  }
  if (
    operation.kind === "SetProperty" &&
    operation.key === "appearance" &&
    typeof operation.value === "number" &&
    Number.isFinite(operation.value) &&
    operation.value >= 0 &&
    operation.value <= 1
  ) {
    if (sourceAnchor !== 0) fail();
    return { entityId: operation.entityId, kind: "opacity", sourceAnchor: 0, value: operation.value };
  }
  if (
    operation.kind === "AnimateProperty" &&
    operation.key === "rotation" &&
    operation.control === undefined &&
    typeof operation.from === "number" &&
    typeof operation.to === "number" &&
    typeof operation.relativeDelta === "number" &&
    Number.isFinite(operation.from) &&
    Number.isFinite(operation.to) &&
    Number.isFinite(operation.relativeDelta) &&
    operation.from === 0 &&
    operation.to === operation.relativeDelta
  ) {
    if (sourceAnchor !== 0) fail();
    return { angleRadians: operation.relativeDelta, entityId: operation.entityId, kind: "rotation", sourceAnchor: 0 };
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
    Math.abs(operation.to / operation.from - operation.relativeFactor) < 0.000001
  ) {
    return {
      entityId: operation.entityId,
      factor: operation.relativeFactor,
      kind: "resize",
      sourceAnchor,
    };
  }
  fail();
}

/**
 * Promotes Runtime Trace move, opacity, uniform-resize, and rotation edits.
 * Browser evidence is correlation only: current source bytes and canonical
 * SourceAnalysis independently choose the one rewritable binding occurrence.
 */
export function lowerRuntimeTraceEditSource(
  source: string,
  request: ProgramRenderRequest,
  entries: readonly LoweredProgramBatchEntry[],
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
): LoweredProgramBatchSource | null {
  const operation = runtimeTraceEditOperation(request, entries);
  if (!operation) return null;
  if (incoming !== null || request.destination !== null) {
    runtimeTraceEditLoweringError("Scene transitions are outside bounded Runtime Trace editing.");
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
    runtimeTraceEditLoweringError("the Studio frame and viewport must be finite and positive.");
  }
  const cameraCenter = request.cameraCenter ?? { x: 0, y: 0 };
  if (!Number.isFinite(cameraCenter.x) || !Number.isFinite(cameraCenter.y)) {
    runtimeTraceEditLoweringError("the Studio camera center must be finite.");
  }

  const analysis = analyzeRuntimeTraceEditSource(source, request.sceneName, request.sourcePath);
  if (analysis.sourceHash !== request.sourceHash) {
    runtimeTraceEditLoweringError("the edit must be rebased from the current source generation.");
  }
  const projectedBindings = projectedRuntimeTraceSourceBindings(analysis);
  const requestBindings = request.sourceBindings.filter(({ entityId }) => entityId === operation.entityId);
  const requestBinding = requestBindings[0];
  const matchingBindings = requestBinding
    ? projectedBindings.filter(({ evidence }) => evidence.name === requestBinding.sourceVariable)
    : [];
  const projected = matchingBindings[0];
  if (requestBindings.length !== 1 || !requestBinding || matchingBindings.length !== 1 || !projected) {
    runtimeTraceEditLoweringError("one exact request binding must match one projected top-level source occurrence.");
  }
  // Runtime Trace candidates only ever mint the canonical Studio identity of their
  // binding, so the gesture entity must resolve to that exact identity here.
  // A request row aliasing another entity id (for example through a duplicate
  // imported entity marker) could otherwise cross-wire a gesture authorized
  // against one binding into a lowered edit of another.
  if (operation.entityId !== `source:${request.sourcePath}#${request.sceneName}:${projected.evidence.name}`) {
    runtimeTraceEditLoweringError("the gesture entity must be the canonical Studio identity of the selected binding.");
  }
  const assignment = analysis.scene.statements.find(({ id }) => id === projected.binding.statementId);
  if (!assignment) runtimeTraceEditLoweringError("SourceAnalysis could not recover the projected assignment.");
  const { insertionBoundary } = runtimeTraceSourceEditBoundary(
    source,
    analysis,
    projected,
    operation.sourceAnchor,
    frame,
  );

  const emitLoweredSource = (insertedCode: string, boundary = insertionBoundary) => {
    try {
      return insertAtSourceBoundaryV1(source, analysis, boundary, [insertedCode]);
    } catch {
      runtimeTraceEditLoweringError("SourceAnalysis rejected the canonical source-time insertion.");
    }
  };

  if (operation.kind === "move") {
    const expectedWorldCenter = worldPointFromViewport(operation.value, frame, request.viewport, cameraCenter);
    if (
      !Number.isFinite(expectedWorldCenter.x) ||
      !Number.isFinite(expectedWorldCenter.y) ||
      Math.abs(expectedWorldCenter.x) > MAX_COORDINATE ||
      Math.abs(expectedWorldCenter.y) > MAX_COORDINATE
    ) {
      runtimeTraceEditLoweringError(
        `position must lower to finite Manim coordinates between -${MAX_COORDINATE} and ${MAX_COORDINATE}.`,
      );
    }
    const assignmentIndex = analysis.scene.statements.findIndex(({ id }) => id === assignment.id);
    const directEdits = contiguousCanonicalRuntimeTraceEditStatements(
      analysis,
      assignmentIndex,
      projected.evidence.name,
    );
    const priorMove =
      operation.sourceAnchor === 0
        ? directEdits.reduce<(typeof directEdits)[number] | undefined>(
            (selected, statement) =>
              parseCanonicalRuntimeTraceMoveEdit(statement.text, projected.evidence.name) === null
                ? selected
                : statement,
            undefined,
          )
        : undefined;
    const moveBoundary = priorMove?.insertionAfter ?? insertionBoundary;
    if (!moveBoundary || moveBoundary.indentation !== assignment.indentation) {
      runtimeTraceEditLoweringError("SourceAnalysis could not append the absolute move edit.");
    }
    const insertedCode = `${moveBoundary.indentation}${projected.evidence.name}.move_to((${formatPointCoordinate(expectedWorldCenter.x)}, ${formatPointCoordinate(expectedWorldCenter.y)}, 0))`;
    const loweredSource = emitLoweredSource(insertedCode, moveBoundary);
    const derived = deriveRuntimeTraceMoveSourceEditPlan(
      loweredSource,
      request.sceneName,
      request.sourcePath,
      projected.evidence.name,
      operation.sourceAnchor,
    );
    if (
      derived.baseSource !== source ||
      derived.baseSourceHash !== request.sourceHash ||
      JSON.stringify(derived.baseBinding) !== JSON.stringify(projected.evidence) ||
      derived.expectedWorldCenter.x !== expectedWorldCenter.x ||
      derived.expectedWorldCenter.y !== expectedWorldCenter.y ||
      derived.sourceAnchor !== operation.sourceAnchor
    ) {
      runtimeTraceEditLoweringError(
        "the emitted source does not re-derive the exact base binding and requested world center.",
      );
    }
    return {
      anchorLine: moveBoundary.line,
      anchorLines: [moveBoundary.line],
      insertedCode,
      preflight: {
        baseBinding: derived.baseBinding,
        baseSourceHash: derived.baseSourceHash,
        entityId: operation.entityId,
        expectedWorldCenter: derived.expectedWorldCenter,
        kind: "runtime-trace-move-edit",
        sourceAnchor: derived.sourceAnchor,
      },
      source: loweredSource,
    };
  }

  if (operation.kind === "opacity") {
    const formattedOpacity = formatRuntimeTraceOpacity(operation.value);
    const expectedOpacity = Number(formattedOpacity);
    if (!Number.isFinite(expectedOpacity) || expectedOpacity < 0 || expectedOpacity > 1) {
      runtimeTraceEditLoweringError("opacity must lower to one finite value between zero and one.");
    }
    const assignmentIndex = analysis.scene.statements.findIndex(({ id }) => id === assignment.id);
    const directEdits = contiguousCanonicalRuntimeTraceEditStatements(
      analysis,
      assignmentIndex,
      projected.evidence.name,
    );
    const priorOpacity = directEdits.reduce<(typeof directEdits)[number] | undefined>(
      (selected, statement) =>
        parseCanonicalRuntimeTraceOpacityEdit(statement.text, projected.evidence.name) === null ? selected : statement,
      undefined,
    );
    const opacityBoundary = priorOpacity?.insertionAfter ?? insertionBoundary;
    if (!opacityBoundary || opacityBoundary.indentation !== assignment.indentation) {
      runtimeTraceEditLoweringError("SourceAnalysis could not append the opacity edit.");
    }
    const insertedCode = `${opacityBoundary.indentation}${projected.evidence.name}.set_opacity(${formattedOpacity})`;
    const loweredSource = emitLoweredSource(insertedCode, opacityBoundary);
    const derived = deriveRuntimeTraceOpacitySourceEditPlan(
      loweredSource,
      request.sceneName,
      request.sourcePath,
      projected.evidence.name,
      operation.sourceAnchor,
    );
    if (
      derived.baseSource !== source ||
      derived.baseSourceHash !== request.sourceHash ||
      JSON.stringify(derived.baseBinding) !== JSON.stringify(projected.evidence) ||
      derived.expectedOpacity !== expectedOpacity ||
      derived.sourceAnchor !== operation.sourceAnchor
    ) {
      runtimeTraceEditLoweringError(
        "the emitted source does not re-derive the exact base binding and requested opacity.",
      );
    }
    return {
      anchorLine: opacityBoundary.line,
      anchorLines: [opacityBoundary.line],
      insertedCode,
      preflight: {
        baseBinding: derived.baseBinding,
        baseSourceHash: derived.baseSourceHash,
        entityId: operation.entityId,
        expectedOpacity: derived.expectedOpacity,
        kind: "runtime-trace-opacity-edit",
        sourceAnchor: 0,
      },
      source: loweredSource,
    };
  }

  if (operation.kind === "rotation") {
    const formattedAngleRadians = formatRuntimeTraceRotationAngle(operation.angleRadians);
    const expectedAngleRadians = Number(formattedAngleRadians);
    if (
      !Number.isFinite(expectedAngleRadians) ||
      runtimeTraceRotationIsNoop(expectedAngleRadians) ||
      Math.abs(expectedAngleRadians) > MAX_COORDINATE
    ) {
      runtimeTraceEditLoweringError("rotation must lower to one finite non-noop bounded angle in radians.");
    }
    const assignmentIndex = analysis.scene.statements.findIndex(({ id }) => id === assignment.id);
    const directEdits = contiguousCanonicalRuntimeTraceEditStatements(
      analysis,
      assignmentIndex,
      projected.evidence.name,
    );
    const priorRotation = directEdits.reduce<(typeof directEdits)[number] | undefined>(
      (selected, statement) =>
        parseCanonicalRuntimeTraceRotationEdit(statement.text, projected.evidence.name) === null ? selected : statement,
      undefined,
    );
    const rotationBoundary = priorRotation?.insertionAfter ?? insertionBoundary;
    if (!rotationBoundary || rotationBoundary.indentation !== assignment.indentation) {
      runtimeTraceEditLoweringError("SourceAnalysis could not append the relative rotation.");
    }
    const insertedCode = `${rotationBoundary.indentation}${projected.evidence.name}.rotate(${formattedAngleRadians})`;
    const loweredSource = emitLoweredSource(insertedCode, rotationBoundary);
    const derived = deriveRuntimeTraceRotationSourceEditPlan(
      loweredSource,
      request.sceneName,
      request.sourcePath,
      projected.evidence.name,
      operation.sourceAnchor,
    );
    if (
      derived.baseSource !== source ||
      derived.baseSourceHash !== request.sourceHash ||
      JSON.stringify(derived.baseBinding) !== JSON.stringify(projected.evidence) ||
      derived.expectedAngleRadians !== expectedAngleRadians ||
      derived.sourceAnchor !== operation.sourceAnchor
    ) {
      runtimeTraceEditLoweringError(
        "the emitted source does not re-derive the exact base binding and requested rotation angle.",
      );
    }
    return {
      anchorLine: rotationBoundary.line,
      anchorLines: [rotationBoundary.line],
      insertedCode,
      preflight: {
        baseBinding: derived.baseBinding,
        baseSourceHash: derived.baseSourceHash,
        entityId: operation.entityId,
        expectedAngleRadians: derived.expectedAngleRadians,
        kind: "runtime-trace-rotation-edit",
        sourceAnchor: 0,
      },
      source: loweredSource,
    };
  }

  // A uniform resize is a dimensionless multiplicative intent; it needs no
  // viewport-to-world conversion, only the canonical positive bounded factor.
  const formattedFactor = formatPositiveAmount(operation.factor);
  const expectedScaleFactor = Number(formattedFactor);
  if (
    !Number.isFinite(expectedScaleFactor) ||
    expectedScaleFactor <= 0 ||
    expectedScaleFactor === 1 ||
    expectedScaleFactor > MAX_COORDINATE
  ) {
    runtimeTraceEditLoweringError("uniform resize must lower to one positive non-identity bounded scale factor.");
  }
  const insertedCode = `${insertionBoundary.indentation}${projected.evidence.name}.scale(${formattedFactor})`;
  const loweredSource = emitLoweredSource(insertedCode);
  const derived = deriveRuntimeTraceResizeSourceEditPlan(
    loweredSource,
    request.sceneName,
    request.sourcePath,
    projected.evidence.name,
    operation.sourceAnchor,
  );
  if (
    derived.baseSource !== source ||
    derived.baseSourceHash !== request.sourceHash ||
    JSON.stringify(derived.baseBinding) !== JSON.stringify(projected.evidence) ||
    derived.expectedScaleFactor !== expectedScaleFactor ||
    derived.sourceAnchor !== operation.sourceAnchor
  ) {
    runtimeTraceEditLoweringError(
      "the emitted source does not re-derive the exact base binding and requested scale factor.",
    );
  }
  return {
    anchorLine: insertionBoundary.line,
    anchorLines: [insertionBoundary.line],
    insertedCode,
    preflight: {
      baseBinding: derived.baseBinding,
      baseSourceHash: derived.baseSourceHash,
      entityId: operation.entityId,
      expectedScaleFactor: derived.expectedScaleFactor,
      kind: "runtime-trace-resize-edit",
      sourceAnchor: derived.sourceAnchor,
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
  timelineTransforms: readonly StudioTimelineEditTransformV1[] | null = null,
): LoweredProgramBatchSource {
  if (entries.length === 0) {
    throw new ProgramLoweringError("operation-unsupported", "A source export batch must contain at least one Program.");
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const sourceBindings = new Map(request.sourceBindings.map((binding) => [binding.entityId, binding.sourceVariable]));
  const generatedEntityIds = new Set<string>();
  const generatedSourceVariables = new Set<string>();
  const entityOpacityStates = new Map<string, number>();
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
  const normalizedEntries = applySceneDurationProjection(orderedEntries, timelineTransforms);

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
        entityOpacityStates,
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
    group.duration += loweredProgramDuration(entry.program);
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
