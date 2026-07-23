import { renderRequestPrograms, type ProgramRenderRequest, type SingleProgramRenderRequest } from "./contracts";
import { analyzePythonSource, isPythonStatementStart } from "./python-source-analysis";
import { findSourceComments, findSourceSceneBlock, findSourceSceneComments, importManimScene } from "./source-import";
import {
  pythonReferenceClosure,
  PythonReferenceAnalysisError,
  referencedPythonReference,
} from "./python-reference-analysis";
import { MAX_ENTITY_SCALE, MIN_ENTITY_SCALE } from "../studio/magic-edit-capabilities";
import type { MotionEasing } from "../studio/model";
import {
  EDIT_OPERATION_VERSION,
  type CanonicalEditOperation,
  type CanonicalEditProgram,
  type CreateEntityOperation,
} from "../studio/operations";
import { operationExecutionCapabilities, programExecutionCapabilities } from "../studio/operation-registry";
import { insertedProgramDuration } from "../studio/program-composition";
import { samplePropertyKnowledge, samplePropertyValue } from "../studio/property-sampling";
import { scaleTransformViolation, sceneBoundaryViolation } from "../studio/source-lowering-invariants";

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

function formatShiftAmount(value: number) {
  const formatted = formatAmount(Math.abs(value));
  return formatted === "0" && value !== 0 ? Number(Math.abs(value).toPrecision(4)).toString() : formatted;
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
) {
  const x = (point.x / viewport.width - 0.5) * frame.width;
  const y = (0.5 - point.y / viewport.height) * frame.height;
  const terms = [
    Math.abs(x) > 0.0001 ? `${formatAmount(Math.abs(x))} * ${x > 0 ? "RIGHT" : "LEFT"}` : null,
    Math.abs(y) > 0.0001 ? `${formatAmount(Math.abs(y))} * ${y > 0 ? "UP" : "DOWN"}` : null,
  ].filter((term): term is string => term !== null);
  return terms.length > 0 ? terms.join(" + ") : "ORIGIN";
}

function markerPoint(point: Readonly<{ x: number; y: number }>, viewport: Readonly<{ height: number; width: number }>) {
  return {
    x: Number(((point.x / viewport.width) * 640).toFixed(4)),
    y: Number(((point.y / viewport.height) * 360).toFixed(4)),
  };
}

function sourceMarker(kind: "motion" | "position" | "scale", value: Readonly<Record<string, unknown>>) {
  return `# poietra:${kind} ${JSON.stringify({ ...value, version: 1 })}`;
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
      operation.kind === "ChangePresence"
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

type LoweredAnimationOperation = Extract<
  CanonicalEditOperation,
  {
    kind: "AnimateProperty" | "ChangePresence" | "CreateMotion" | "TransformContent";
  }
>;

function animationOperation(operation: CanonicalEditOperation): operation is LoweredAnimationOperation {
  return (
    operation.kind === "ChangePresence" ||
    operation.kind === "CreateMotion" ||
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

function referencedVariableAfterAnchor(
  source: string,
  sceneBlock: NonNullable<ReturnType<typeof findSourceSceneBlock>>,
  anchorLine: number,
  variables: ReadonlySet<string>,
) {
  if (variables.size === 0) return null;
  let references: ReadonlySet<string>;
  try {
    references = pythonReferenceClosure(source, sceneBlock.bodyStart, anchorLine - 1, variables);
  } catch (error) {
    if (!(error instanceof PythonReferenceAnalysisError)) throw error;
    throw new ProgramLoweringError(
      "operation-unsupported",
      `Persistent removal cannot inspect source aliases safely. ${error.message}`,
    );
  }
  const analysis = analyzePythonSource(source);
  if (!analysis.valid) {
    throw new ProgramLoweringError(
      "operation-unsupported",
      "Persistent removal cannot inspect an invalid Python source suffix safely.",
    );
  }
  for (let index = anchorLine; index < sceneBlock.bodyEnd; index += 1) {
    const line = analysis.lines[index];
    if (!line) continue;
    const reference = referencedPythonReference(line, references);
    if (reference) return reference;
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
          output.push(
            sourceMarker("position", {
              kind: "absolute",
              value: markerPoint(operation.value, request.viewport),
              variable,
            }),
          );
          output.push(`${variable}.move_to(${pointExpression(operation.value, frame, request.viewport)})`);
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
      }
    }
    if (actions.length > 0) {
      if (motions.length > 0) {
        output.push(sourceMarker("motion", { motions }));
      }
      if (scales.length > 0) {
        output.push(sourceMarker("scale", { kind: "animated", scales }));
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
  return {
    anchorLine: anchor.line,
    entityAliases,
    entityBindings,
    insertedCode: insertedLines.join(newline),
    source: lines.join(newline),
  };
}

function singleProgramRequest(
  request: ProgramRenderRequest,
  program: SingleProgramRenderRequest["program"],
  sourceBindings: SingleProgramRenderRequest["sourceBindings"],
): SingleProgramRenderRequest {
  return {
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
  return {
    anchorLine: groups[0].anchorLine,
    anchorLines: groups.map((group) => group.anchorLine),
    insertedCode: groups.flatMap((group) => group.insertedLines).join(newline),
    source: lines.join(newline),
  };
}
