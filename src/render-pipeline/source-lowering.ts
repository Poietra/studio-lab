import type { ProgramRenderRequest } from "./contracts";
import { findSourceSceneBlock } from "./source-import";
import type { CanonicalEditOperation, CreateEntityOperation } from "../studio/operations";

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
  insertedCode: string;
  source: string;
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

function variableToken(transactionId: string, index: number) {
  const normalized = transactionId.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1").slice(0, 48);
  return `poietra_${normalized || "edit"}_${index + 1}`;
}

function variableAllocator(source: string, transactionId: string) {
  const reserved = new Set(source.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []);
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
  request: ProgramRenderRequest,
  frame: Readonly<{ height: number; width: number }>,
  incoming: IncomingSceneSetup | null,
): LoweredProgramSource {
  if (request.program.loweringStatus !== "supported") {
    throw new ProgramLoweringError(
      "operation-unsupported",
      `Program ${request.program.transactionId} is marked ${request.program.loweringStatus}, not supported.`,
    );
  }
  request.program.operations.forEach(assertLoweringSupported);
  const anchor = findSceneMotionAnchors(source, request.sceneName)
    .find((candidate) => Math.abs(candidate.seconds - request.program.anchor.resolvedSeconds) < EPSILON);
  if (!anchor) {
    throw new ProgramLoweringError(
      "anchor-missing",
      `No # poietra:anchor ${request.program.anchor.resolvedSeconds.toFixed(3)} marker exists in ${request.sourcePath}.`,
    );
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const markerLine = lines[anchor.line - 1] ?? "";
  const indentation = markerLine.match(/^\s*/)?.[0] ?? "";
  const block = findSourceSceneBlock(source, request.sceneName);
  const sourceBeforeAnchor = lines.slice(block?.bodyStart ?? 0, anchor.line - 1).join(newline);
  const sourceBindings = new Map(request.sourceBindings.map((binding) => [binding.entityId, binding.sourceVariable]));
  for (const entityId of referencedBaseEntityIds(request.program.operations)) {
    const sourceVariable = sourceBindings.get(entityId);
    if (!sourceVariable) {
      throw new ProgramLoweringError("source-variable-missing", `Runtime entity ${entityId} has no imported Python source identity.`);
    }
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
  const aliasesByEntity = new Map(
    [...sourceBindings].map(([entityId, sourceVariable]) => [entityId, new Set([sourceVariable])]),
  );
  const allocateVariable = variableAllocator(source, request.program.transactionId);
  const createdOperations = operations.filter((operation): operation is CreateEntityOperation => operation.kind === "CreateEntity");
  createdOperations.forEach((operation) => {
    const variable = allocateVariable();
    variableByEntity.set(operation.entity.id, variable);
    aliasesByEntity.set(operation.entity.id, new Set([variable]));
  });
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
      } else if (operation.kind === "SetProperty") {
        const variable = requireVariable(variableByEntity, operation.entityId);
        if (operation.key === "position" && isPoint(operation.value)) {
          output.push(`${variable}.move_to(${pointExpression(operation.value, frame, request.viewport)})`);
        }
      } else if (operation.kind === "SetRelation") {
        const sourceVariable = requireVariable(variableByEntity, operation.sourceEntityId);
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        output.push(`${sourceVariable}.move_to(${targetVariable}.get_center() + ${offsetExpression(operation.offset, frame, request.viewport)})`);
      } else if (operation.kind === "TransformContent") {
        const targetVariable = variableByEntity.get(operation.targetEntityId)
          ?? allocateVariable();
        variableByEntity.set(operation.targetEntityId, targetVariable);
        aliasesByEntity.set(
          operation.targetEntityId,
          aliasesByEntity.get(operation.targetEntityId) ?? new Set([targetVariable]),
        );
        const target = operation.targetType === "Text"
          ? `Text(${JSON.stringify(operation.replacement.text ?? operation.replacement.displayLines.join(" "))})`
          : `MathTex(${(operation.replacement.texParts ?? operation.replacement.displayLines).map((part) => JSON.stringify(part)).join(", ")})`;
        const sourceVariable = requireVariable(variableByEntity, operation.sourceEntityId);
        output.push(`# poietra:entity ${JSON.stringify({ id: operation.targetEntityId, variable: targetVariable })}`);
        output.push(`${targetVariable} = ${target}`);
        output.push(`${targetVariable}.move_to(${sourceVariable}.get_center())`);
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

    const animations = bucket.filter(animationOperation);
    if (animations.length === 0) continue;
    const animationEnd = animations[0].interval.end;
    if (animations.some((operation) => Math.abs(operation.interval.end - animationEnd) >= EPSILON)) {
      throw new ProgramLoweringError("operation-unsupported", "Concurrent source animations must share one interval.");
    }
    const actions: string[] = [];
    const postludes: string[] = [];
    for (const operation of animations) {
      if (operation.kind === "CreateMotion") {
        if (Math.abs(operation.controlOffset.x) > 0.001 || Math.abs(operation.controlOffset.y) > 0.001) {
          throw new ProgramLoweringError("operation-unsupported", "Rendered validation currently supports straight CreateMotion paths only.");
        }
        const shift = shiftExpression(operation.delta, frame, request.viewport);
        for (const entityId of operation.targetEntityIds) {
          const variable = requireVariable(variableByEntity, entityId);
          actions.push(`${variable}.animate.shift(${shift})`);
        }
      } else if (operation.kind === "TransformContent") {
        const sourceVariable = requireVariable(variableByEntity, operation.sourceEntityId);
        const targetVariable = requireVariable(variableByEntity, operation.targetEntityId);
        const sourceAliases = aliasesByEntity.get(operation.sourceEntityId) ?? new Set([sourceVariable]);
        const targetAliases = aliasesByEntity.get(operation.targetEntityId) ?? new Set([targetVariable]);
        aliasesByEntity.set(operation.targetEntityId, new Set([...targetAliases, ...sourceAliases]));
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
  lines.splice(anchor.line, 0, ...insertedLines);
  return {
    anchorLine: anchor.line,
    insertedCode: insertedLines.join(newline),
    source: lines.join(newline),
  };
}
