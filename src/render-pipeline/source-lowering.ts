import { renderRequestPrograms, type ProgramRenderRequest, type SingleProgramRenderRequest } from "./contracts";
import { findSourceSceneBlock } from "./source-import";
import type { CanonicalEditOperation, CreateEntityOperation } from "../studio/operations";
import { insertedProgramDuration } from "../studio/program-composition";

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
  generatedEntityIds?: ReadonlySet<string>;
  reservedSourceVariables?: ReadonlySet<string>;
  sourceAnchor?: number;
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
const EPSILON = 0.0005;

export function findMotionAnchors(source: string): readonly MotionAnchor[] {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(ANCHOR_PATTERN);
    return match ? [{ line: index + 1, seconds: Number(match[1]) }] : [];
  });
}

export function findSceneMotionAnchors(source: string, sceneName: string): readonly MotionAnchor[] {
  const block = findSourceSceneBlock(source, sceneName);
  if (!block) return [];
  return block.lines.slice(block.bodyStart, block.bodyEnd).flatMap((line, index) => {
    const match = line.match(ANCHOR_PATTERN);
    return match ? [{ line: block.bodyStart + index + 1, seconds: Number(match[1]) }] : [];
  });
}

function formatAmount(value: number) {
  const normalized = Math.abs(value) < 0.00005 ? 0 : value;
  return Number(normalized.toFixed(4)).toString();
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
    Math.abs(worldX) > 0.0001
      ? `${formatAmount(Math.abs(worldX))} * ${worldX > 0 ? "RIGHT" : "LEFT"}`
      : null,
    Math.abs(worldY) > 0.0001
      ? `${formatAmount(Math.abs(worldY))} * ${worldY > 0 ? "UP" : "DOWN"}`
      : null,
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
  return expression === "ORIGIN"
    ? `${variable}.get_center()`
    : `${variable}.get_center() + ${expression}`;
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
    x: delta.x / 3 + controlOffset.x * 2 / 3,
    y: delta.y / 3 + controlOffset.y * 2 / 3,
  };
  const endHandleOffset = {
    x: delta.x * 2 / 3 + controlOffset.x * 2 / 3,
    y: delta.y * 2 / 3 + controlOffset.y * 2 / 3,
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

function markerPoint(
  point: Readonly<{ x: number; y: number }>,
  viewport: Readonly<{ height: number; width: number }>,
) {
  return { x: Number(((point.x / viewport.width) * 640).toFixed(4)), y: Number(((point.y / viewport.height) * 360).toFixed(4)) };
}

function sourceMarker(kind: "motion" | "position", value: Readonly<Record<string, unknown>>) {
  return `# poietra:${kind} ${JSON.stringify({ ...value, version: 1 })}`;
}

function variableToken(transactionId: string, index: number) {
  const normalized = transactionId.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1").slice(0, 48);
  return `poietra_${normalized || "edit"}_${index + 1}`;
}

function variableAllocator(
  source: string,
  transactionId: string,
  additionalReserved: ReadonlySet<string> = new Set(),
) {
  const reserved = new Set([
    ...(source.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []),
    ...additionalReserved,
  ]);
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
  const { content, type } = operation.entity;
  if (type === "MathTex") {
    const parts = content?.texParts?.length ? content.texParts : content?.displayLines;
    if (!parts?.length) {
      throw new ProgramLoweringError("operation-unsupported", "MathTex creation requires canonical texParts or displayLines.");
    }
    return `MathTex(${parts.map((part) => JSON.stringify(part)).join(", ")})`;
  }
  if (type === "Text") {
    const text = content?.text ?? content?.displayLines.join(" ") ?? "";
    return `Text(${JSON.stringify(text)})`;
  }
  const shapeConstructor = {
    Arrow: "Arrow(LEFT, RIGHT, buff=0)",
    Circle: "Circle(radius=1)",
    Line: "Line(LEFT, RIGHT)",
    Rectangle: "Rectangle(width=4, height=2)",
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
  const created = new Set(operations.flatMap((operation) => {
    if (operation.kind === "CreateEntity") return [operation.entity.id];
    if (operation.kind === "TransformContent") return [operation.targetEntityId];
    return [];
  }));
  const referenced = operations.flatMap((operation): readonly string[] => {
    if (operation.kind === "CreateMotion") return operation.targetEntityIds;
    if (operation.kind === "SetProperty" || operation.kind === "AnimateProperty" || operation.kind === "ChangePresence") {
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
  return typeof value === "object" && value !== null && "x" in value && "y" in value
    && typeof value.x === "number" && typeof value.y === "number";
}

type LoweredAnimationOperation = Extract<CanonicalEditOperation, {
  kind: "ChangePresence" | "CreateMotion" | "TransformContent";
}>;

function animationOperation(operation: CanonicalEditOperation): operation is LoweredAnimationOperation {
  return operation.kind === "ChangePresence"
    || operation.kind === "CreateMotion"
    || operation.kind === "TransformContent";
}

function assertLoweringSupported(operation: CanonicalEditOperation) {
  if (operation.kind === "CreateEntity" || operation.kind === "CreateMotion"
    || operation.kind === "ChangePresence" || operation.kind === "TransformContent"
    || operation.kind === "InsertSceneBoundary") return;
  if (operation.kind === "InsertTimelineEvent" && operation.eventKind === "wait") return;
  if (operation.kind === "SetProperty" && operation.key === "position" && isPoint(operation.value)) return;
  if (operation.kind === "SetRelation" && operation.mode === "snapshot") return;
  const detail = operation.kind === "SetProperty" ? ` ${operation.key}`
    : operation.kind === "SetRelation" ? ` ${operation.mode}`
      : "";
  throw new ProgramLoweringError(
    "operation-unsupported",
    `${operation.kind}${detail} has no truthful source lowering.`,
  );
}

function requireVariable(variables: ReadonlyMap<string, string>, entityId: string) {
  const variable = variables.get(entityId);
  if (!variable) throw new ProgramLoweringError("source-variable-missing", `No source variable exists for ${entityId}.`);
  return variable;
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
  if (request.program.loweringStatus !== "supported") {
    throw new ProgramLoweringError(
      "operation-unsupported",
      `Program ${request.program.transactionId} is marked ${request.program.loweringStatus}, not supported.`,
    );
  }
  request.program.operations.forEach(assertLoweringSupported);
  const sourceAnchor = options.sourceAnchor ?? request.program.anchor.resolvedSeconds;
  const anchor = findSceneMotionAnchors(source, request.sceneName)
    .find((candidate) => Math.abs(candidate.seconds - sourceAnchor) < EPSILON);
  if (!anchor) {
    throw new ProgramLoweringError(
      "anchor-missing",
      `No # poietra:anchor ${sourceAnchor.toFixed(3)} marker exists in ${request.sourcePath}.`,
    );
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const markerLine = lines[anchor.line - 1] ?? "";
  const indentation = markerLine.match(/^\s*/)?.[0] ?? "";
  const sceneBlock = findSourceSceneBlock(source, request.sceneName);
  const sourceBeforeAnchor = lines.slice(sceneBlock?.bodyStart ?? 0, anchor.line - 1).join(newline);
  const sourceBindings = new Map(request.sourceBindings.map((binding) => [binding.entityId, binding.sourceVariable]));
  for (const entityId of referencedBaseEntityIds(request.program.operations)) {
    const sourceVariable = sourceBindings.get(entityId);
    if (!sourceVariable) {
      throw new ProgramLoweringError("source-variable-missing", `Runtime entity ${entityId} has no imported Python source identity.`);
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
  const operations = [...request.program.operations].sort((left, right) => (
    operationTime(left) - operationTime(right)
    || (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)
  ));
  const variableByEntity = new Map(sourceBindings);
  const aliasesByEntity = new Map([...sourceBindings].map(([entityId, sourceVariable]) => [
    entityId,
    new Set([sourceVariable, ...(options.entityAliases?.get(entityId) ?? [])]),
  ]));
  const allocateVariable = variableAllocator(
    source,
    request.program.transactionId,
    options.reservedSourceVariables,
  );
  for (const operation of operations) {
    const entityId = operation.kind === "CreateEntity" ? operation.entity.id
      : operation.kind === "TransformContent" ? operation.targetEntityId : null;
    if (!entityId || variableByEntity.has(entityId)) continue;
    const variable = allocateVariable();
    variableByEntity.set(entityId, variable);
    aliasesByEntity.set(entityId, new Set([variable]));
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
        const target = operation.targetType === "Text"
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
          output.push(sourceMarker("position", { kind: "absolute", value: markerPoint(operation.value, request.viewport), variable }));
          output.push(`${variable}.move_to(${pointExpression(operation.value, frame, request.viewport)})`);
        }
      } else if (operation.kind === "TransformContent") {
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        const sourceVariable = requireVariable(variableByEntity, operation.sourceEntityId);
        output.push(sourceMarker("position", { kind: "relative", offset: { x: 0, y: 0 }, relativeTo: sourceVariable, variable: targetVariable }));
        output.push(`${targetVariable}.move_to(${sourceVariable}.get_center())`);
      } else if (operation.kind === "SetRelation") {
        const sourceVariable = requireVariable(variableByEntity, operation.sourceEntityId);
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        output.push(sourceMarker("position", { kind: "relative", offset: markerPoint(operation.offset, request.viewport), relativeTo: targetVariable, variable: sourceVariable }));
        output.push(`${sourceVariable}.move_to(${targetVariable}.get_center() + ${offsetExpression(operation.offset, frame, request.viewport)})`);
      }
    }

    const boundaries = bucket.filter((operation) => operation.kind === "InsertSceneBoundary");
    for (const boundary of boundaries) {
      if (!incoming) {
        throw new ProgramLoweringError("destination-missing", "The Scene transition has no imported next Scene destination.");
      }
      output.push(`# poietra:scene-boundary ${JSON.stringify({
        at: boundary.at,
        destination: request.destination
          ? `${request.destination.sourcePath}#${request.destination.sceneName}`
          : "next-scene",
      })}`);
      output.push("self.clear()");
      output.push("# poietra:incoming-start");
      output.push(...incoming.initialization);
      output.push("# poietra:incoming-end");
      if (incoming.visibleSourceVariables.length > 0) {
        output.push(`self.add(${incoming.visibleSourceVariables.join(", ")})`);
      }
      const overlay = operations.find((operation) => (
        operation.kind === "CreateEntity" && operation.entity.type.startsWith("TransitionOverlay:")
      ));
      if (overlay?.kind === "CreateEntity") {
        const overlayVariable = requireVariable(variableByEntity, overlay.entity.id);
        output.push(`self.add(${overlayVariable})`);
        output.push(`self.bring_to_front(${overlayVariable})`);
      }
    }

    const insertedWaits = bucket.filter((operation) => (
      operation.kind === "InsertTimelineEvent" && operation.eventKind === "wait"
    ));
    if (insertedWaits.length > 0) {
      if (insertedWaits.length !== 1 || bucket.length !== 1) {
        throw new ProgramLoweringError("operation-unsupported", "An inserted wait must occupy its own source interval.");
      }
      const wait = insertedWaits[0];
      const waitDuration = wait.interval.end - wait.interval.start;
      if (waitDuration > EPSILON) output.push(`self.wait(${formatAmount(waitDuration)})`);
      cursor = wait.interval.end;
      continue;
    }

    const animations = bucket.filter(animationOperation);
    if (animations.length === 0) continue;
    const animationEnd = animations[0].interval.end;
    if (animations.some((operation) => Math.abs(operation.interval.end - animationEnd) >= EPSILON)) {
      throw new ProgramLoweringError("operation-unsupported", "Concurrent source animations must share one interval.");
    }
    const actions: string[] = [];
    const motions: Array<Readonly<{
      controlOffset?: Readonly<{ x: number; y: number }>;
      delta: Readonly<{ x: number; y: number }>;
      variables: readonly string[];
    }>> = [];
    const postludes: string[] = [];
    for (const operation of animations) {
      if (operation.kind === "CreateMotion") {
        const curved = Math.abs(operation.controlOffset.x) > 0.001
          || Math.abs(operation.controlOffset.y) > 0.001;
        const variables = operation.targetEntityIds.map((entityId) => requireVariable(variableByEntity, entityId));
        motions.push({
          ...(curved ? { controlOffset: markerPoint(operation.controlOffset, request.viewport) } : {}),
          delta: markerPoint(operation.delta, request.viewport),
          variables,
        });
        for (const variable of variables) {
          actions.push(curved
            ? quadraticMotionExpression(variable, operation.delta, operation.controlOffset, frame, request.viewport)
            : `${variable}.animate.shift(${shiftExpression(operation.delta, frame, request.viewport)})`);
        }
      } else if (operation.kind === "TransformContent") {
        const sourceVariable = requireVariable(variableByEntity, operation.sourceEntityId);
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        const sourceAliases = aliasesByEntity.get(operation.sourceEntityId) ?? new Set([sourceVariable]);
        const targetAliases = aliasesByEntity.get(operation.targetEntityId) ?? new Set([targetVariable]);
        const inheritedAliases = new Set([...targetAliases, ...sourceAliases]);
        aliasesByEntity.set(operation.sourceEntityId, inheritedAliases);
        aliasesByEntity.set(operation.targetEntityId, inheritedAliases);
        actions.push(operation.strategy === "transform-matching-tex"
          ? `TransformMatchingTex(${sourceVariable}, ${targetVariable}, transform_mismatches=True)`
          : `ReplacementTransform(${sourceVariable}, ${targetVariable})`);
        postludes.push(...[...sourceAliases]
          .filter((alias) => alias !== targetVariable)
          .map((alias) => `${alias} = ${targetVariable}`));
      } else if (operation.kind === "ChangePresence") {
        const variable = requireVariable(variableByEntity, operation.entityId);
        if (operation.effect === "fade-in") actions.push(`FadeIn(${variable})`);
        else if (operation.effect === "remove") actions.push(`FadeOut(${variable})`);
        else if (operation.effect === "cover") actions.push(`${variable}.animate.scale(800)`);
        else {
          actions.push(`${variable}.animate.scale(0.00125)`);
          postludes.push(`self.remove(${variable})`);
        }
      }
    }
    if (actions.length > 0) {
      if (motions.length > 0) {
        output.push(sourceMarker("motion", { motions }));
      }
      output.push("self.play(");
      output.push(...actions.map((action) => `    ${action},`));
      output.push(`    run_time=${formatAmount(animationEnd - time)},`);
      output.push("    rate_func=smooth,");
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
  const producedEntityIds = new Set(request.program.operations.flatMap((operation) => {
    if (operation.kind === "CreateEntity") return [operation.entity.id];
    if (operation.kind === "TransformContent") return [operation.targetEntityId];
    return [];
  }));
  const entityBindings = [...producedEntityIds].map((entityId) => ({
    entityId,
    sourceVariable: requireVariable(variableByEntity, entityId),
  }));
  const entityAliases = [...aliasesByEntity].map(([entityId, sourceVariables]) => ({
    entityId,
    sourceVariables: [...sourceVariables],
  }));
  const insertedDuration = insertedProgramDuration(request.program);
  if (sceneBlock) {
    for (let index = sceneBlock.bodyStart; index < sceneBlock.bodyEnd; index += 1) {
      if (index === anchor.line - 1) continue;
      const match = lines[index]?.match(ANCHOR_PATTERN);
      if (!match) continue;
      const seconds = Number(match[1]);
      if (seconds <= sourceAnchor + EPSILON) continue;
      const lineIndentation = lines[index]?.match(/^\s*/)?.[0] ?? "";
      lines[index] = `${lineIndentation}# poietra:anchor ${formatAmount(seconds + insertedDuration)}`;
    }
  }
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
  const entityAliases = new Map<string, ReadonlySet<string>>(
    [...sourceBindings].map(([entityId, sourceVariable]) => [entityId, new Set([sourceVariable])]),
  );
  const groups: MutableBatchGroup[] = [];
  const orderedEntries = entries.map((entry, inputIndex) => ({ ...entry, inputIndex }))
    .sort((left, right) => left.sourceAnchor - right.sourceAnchor || left.inputIndex - right.inputIndex);

  for (const entry of orderedEntries) {
    const lowered = lowerCanonicalProgramSource(
      source,
      singleProgramRequest(request, entry.program, [...sourceBindings].map(([entityId, sourceVariable]) => ({
        entityId,
        sourceVariable,
      }))),
      frame,
      incoming,
      {
        entityAliases,
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
  const sceneBlock = findSourceSceneBlock(source, request.sceneName);
  if (!sceneBlock) {
    throw new ProgramLoweringError("anchor-missing", `${request.sceneName} is not present in ${request.sourcePath}.`);
  }
  for (let index = sceneBlock.bodyStart; index < sceneBlock.bodyEnd; index += 1) {
    const match = lines[index]?.match(ANCHOR_PATTERN);
    if (!match) continue;
    const sourceAnchor = Number(match[1]);
    const priorDuration = groups.reduce((duration, group) => (
      group.sourceAnchor < sourceAnchor - EPSILON ? duration + group.duration : duration
    ), 0);
    const indentation = lines[index]?.match(/^\s*/)?.[0] ?? "";
    lines[index] = `${indentation}# poietra:anchor ${formatAmount(sourceAnchor + priorDuration)}`;
  }
  for (const group of [...groups].sort((left, right) => right.anchorLine - left.anchorLine)) {
    const priorDuration = groups.reduce((duration, candidate) => (
      candidate.sourceAnchor < group.sourceAnchor - EPSILON ? duration + candidate.duration : duration
    ), 0);
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
