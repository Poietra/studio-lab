import { exactEntityScaleAt } from "./magic-edit-capabilities";
import { isMotionEasing, type MotionEasing, type RuntimeSceneState } from "./model";
import {
  operationAccess,
  operationExecutionCapabilities,
  programExecutionCapabilities,
  validateOperation,
} from "./operation-registry";
import { channelKey, type DependencyEdge, type SceneEditValidationIssue } from "./operations";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { scaleTransformViolation, sceneBoundaryViolation } from "./source-lowering-invariants";

const EPSILON = 0.001;

export type SceneEditValidationResult = Readonly<{
  issues: readonly SceneEditValidationIssue[];
  kind: "invalid" | "valid";
  program: SceneEdit;
}>;

export type ProgramValidationResult = SceneEditValidationResult;

function intervalsOverlap(left: SceneEditOperation["interval"], right: SceneEditOperation["interval"]) {
  return left.start < right.end - EPSILON && right.start < left.end - EPSILON;
}

function edgeKey(edge: DependencyEdge) {
  return `${edge.from}|${edge.to}|${edge.reason}`;
}

function uniqueEdges(edges: readonly DependencyEdge[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = edgeKey(edge);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function topologicalOrder(operationIds: readonly string[], edges: readonly DependencyEdge[]) {
  const indegree = new Map(operationIds.map((id) => [id, 0]));
  const outgoing = new Map(operationIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to) || edge.from === edge.to) continue;
    outgoing.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
  }
  const queue = operationIds.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return order.length === operationIds.length ? order : null;
}

function producedEntityIds(program: SceneEdit) {
  return new Set(
    program.operations.flatMap((operation) => {
      if (operation.kind === "CreateEntity") return [operation.entity.id];
      if (operation.kind === "TransformContent") return [operation.targetEntityId];
      if (operation.kind === "GroupEntities") return [operation.groupId];
      return [];
    }),
  );
}

function referencedEntityIds(operation: SceneEditOperation) {
  const access = operationAccess(operation);
  return [...new Set([...access.reads, ...access.writes].map((entry) => entry.entityId))].filter(
    (id) => id !== "camera",
  );
}

function sourceAnimationEasing(operation: SceneEditOperation): MotionEasing | null {
  if (operation.kind === "CreateMotion") return operation.easing;
  if (operation.kind === "AnimateProperty" && operation.key === "scale" && isMotionEasing(operation.easing))
    return operation.easing;
  if (operation.kind === "TransformContent") return operation.easing ?? "smooth";
  if (operation.kind === "TransformPath") return operation.easing;
  if (operation.kind === "TransformShape") return operation.easing;
  if (operation.kind === "AnimateCamera") return operation.easing;
  if (operation.kind === "ChangePresence" || operation.kind === "ResizeEntity") return "smooth";
  return null;
}

export function validateAndScheduleProgram(input: SceneEdit, scene: RuntimeSceneState): SceneEditValidationResult {
  const issues: SceneEditValidationIssue[] = [];
  if (input.intentCount < 1 || input.intentCount > 16) {
    issues.push({
      code: "operation-count",
      field: "intentCount",
      message: "A Canonical EditProgram accepts between one and sixteen composed intents.",
      severity: "error",
    });
  }
  if (input.operations.length === 0) {
    issues.push({
      code: "operation-count",
      field: "operations",
      message: "An EditProgram must contain at least one Canonical operation.",
      severity: "error",
    });
  }
  if (
    input.operations.some((operation) => operation.kind === "TrimSceneDuration") &&
    (input.operations.length !== 1 ||
      input.requestedExecution !== "sequence" ||
      input.provenance.origin !== "studio-default")
  ) {
    issues.push({
      code: "schema-invalid",
      field: "operations",
      message: "A Scene duration trim must be the only Studio-authored operation in a sequential EditProgram.",
      severity: "error",
    });
  }
  const firstOperationStart = input.operations[0]?.interval.start;
  if (
    !Number.isFinite(input.anchor.resolvedSeconds) ||
    input.anchor.resolvedSeconds < 0 ||
    input.anchor.resolvedSeconds > scene.duration ||
    (firstOperationStart !== undefined && Math.abs(firstOperationStart - input.anchor.resolvedSeconds) >= EPSILON)
  ) {
    issues.push({
      code: "anchor-invalid",
      field: "anchor.resolvedSeconds",
      message: "The resolved anchor must equal the first operation start.",
      severity: "error",
    });
  }

  const operationIds = input.operations.map((operation) => operation.id);
  if (new Set(operationIds).size !== operationIds.length) {
    issues.push({
      code: "schema-invalid",
      field: "operations[].id",
      message: "Operation IDs must be unique within a transaction.",
      severity: "error",
    });
  }
  for (const operation of input.operations) issues.push(...validateOperation(operation, scene));

  const transformScale = scaleTransformViolation(input.operations);
  if (transformScale) {
    issues.push({
      code: "lowering-unsupported",
      field: "operations",
      message:
        "Scale and TransformContent cannot target the same logical object because source lowering cannot preserve the replacement's exact scale.",
      operationId: transformScale.scaleOperationId,
      severity: "error",
    });
  }
  const boundary = sceneBoundaryViolation(input.operations);
  if (boundary) {
    issues.push({
      code: "lowering-unsupported",
      field: "operations",
      message:
        "A Scene boundary must be terminal; only its transition reveal may execute after ownership transfers to the next Scene.",
      operationId: boundary.operationId,
      severity: "error",
    });
  }

  const produced = producedEntityIds(input);
  const producerIds = new Set<string>();
  for (const operation of input.operations) {
    const entityId =
      operation.kind === "CreateEntity"
        ? operation.entity.id
        : operation.kind === "TransformContent"
          ? operation.targetEntityId
          : operation.kind === "GroupEntities"
            ? operation.groupId
            : null;
    if (!entityId) continue;
    if (producerIds.has(entityId)) {
      issues.push({
        code: "schema-invalid",
        field: "target",
        message: `Provisional identity ${entityId} is produced more than once in this EditProgram.`,
        operationId: operation.id,
        severity: "error",
      });
    }
    producerIds.add(entityId);
    if (!entityId.startsWith(`tx:${input.transactionId}/entity:`)) {
      issues.push({
        code: "provisional-id-invalid",
        field:
          operation.kind === "CreateEntity"
            ? "entity.id"
            : operation.kind === "GroupEntities"
              ? "groupId"
              : "targetEntityId",
        message: `Produced identity ${entityId} must belong to transaction ${input.transactionId}.`,
        operationId: operation.id,
        severity: "error",
      });
    }
    if (scene.objectGraph.entities[entityId]) {
      issues.push({
        code: "provisional-id-invalid",
        field:
          operation.kind === "CreateEntity"
            ? "entity.id"
            : operation.kind === "GroupEntities"
              ? "groupId"
              : "targetEntityId",
        message: `Produced identity ${entityId} would overwrite an existing entity.`,
        operationId: operation.id,
        severity: "error",
      });
    }
  }
  for (const operation of input.operations) {
    if (
      operation.kind === "ResizeEntity" &&
      produced.has(operation.entityId) &&
      !scene.objectGraph.entities[operation.entityId]
    ) {
      issues.push({
        code: "identity-unknown",
        field: "target",
        message: "ResizeEntity cannot target an entity created in the same unapplied EditProgram.",
        operationId: operation.id,
        severity: "error",
      });
    }
    for (const entityId of referencedEntityIds(operation)) {
      if (!entityId.startsWith("tx:")) continue;
      if (produced.has(entityId)) continue;
      const existingEntity = scene.objectGraph.entities[entityId];
      if (existingEntity && !existingEntity.provisional) continue;
      // A Studio MathTex transform keeps one visible logical root while its
      // retained path morph advances through transaction-scoped stage IDs.
      // Only the Rust creation planner sees the complete Program batch and can
      // prove that this source is the immediately preceding transform target.
      if (operation.kind === "TransformContent" && entityId === operation.sourceEntityId) continue;
      if (!entityId.startsWith(`tx:${input.transactionId}/entity:`)) {
        issues.push({
          code: "provisional-id-invalid",
          field: "target",
          message: `Provisional identity ${entityId} is outside transaction ${input.transactionId}.`,
          operationId: operation.id,
          severity: "error",
        });
      } else {
        issues.push({
          code: "identity-unknown",
          field: "target",
          message: `Provisional identity ${entityId} is not produced by this EditProgram.`,
          operationId: operation.id,
          severity: "error",
        });
      }
    }
    const execution = operationExecutionCapabilities(operation);
    if (execution.lowering !== "supported") {
      issues.push({
        code: "lowering-unsupported",
        field: "loweringStatus",
        message: execution.applyBlocker ?? `${operation.kind} has no truthful source lowering yet.`,
        operationId: operation.id,
        severity:
          execution.apply === "supported" ? "warning" : execution.lowering === "unsupported" ? "error" : "warning",
      });
    }
    if (operation.kind === "TransformContent") {
      const source = scene.objectGraph.entities[operation.sourceEntityId];
      const isStudioOwned = Boolean(source?.transactionId);
      if (source?.sourceIdentity.kind === "unknown" && !isStudioOwned) {
        issues.push({
          code: "identity-unknown",
          field: "sourceEntityId",
          message: `TransformContent cannot destructively replace ${operation.sourceEntityId} while source identity is Unknown.`,
          operationId: operation.id,
          severity: "error",
        });
      }
      if (source && !isStudioOwned) {
        const scale = exactEntityScaleAt(scene, source, operation.interval.start);
        if (scale.kind !== "known" || !Number.isFinite(scale.value) || Math.abs(scale.value - 1) >= EPSILON) {
          issues.push({
            code: "lowering-unsupported",
            field: "sourceEntityId",
            message:
              scale.kind === "unknown"
                ? `TransformContent cannot verify the exact 1x source scale for ${operation.sourceEntityId}: ${scale.reason}`
                : `TransformContent requires ${operation.sourceEntityId} to have an effective 1x scale; the source is ${scale.value}x.`,
            operationId: operation.id,
            severity: "error",
          });
        }
      }
    }
    if (operation.kind === "SetProperty" && operation.key === "content") {
      const source = scene.objectGraph.entities[operation.entityId];
      if (source?.sourceIdentity.kind === "unknown" && !source.transactionId) {
        issues.push({
          code: "identity-unknown",
          field: "entityId",
          message: `SetProperty content cannot replace ${operation.entityId} while source identity is Unknown.`,
          operationId: operation.id,
          severity: "error",
        });
      }
    }
  }

  const sourceAnimationGroups: Array<
    Readonly<{
      easings: Set<MotionEasing>;
      operationIds: string[];
      start: number;
    }>
  > = [];
  for (const operation of input.operations) {
    const easing = sourceAnimationEasing(operation);
    if (!easing) continue;
    const group = sourceAnimationGroups.find(
      (candidate) => Math.abs(candidate.start - operation.interval.start) < EPSILON,
    );
    if (group) {
      group.easings.add(easing);
      group.operationIds.push(operation.id);
    } else {
      sourceAnimationGroups.push({
        easings: new Set([easing]),
        operationIds: [operation.id],
        start: operation.interval.start,
      });
    }
  }
  for (const group of sourceAnimationGroups) {
    if (group.easings.size < 2) continue;
    issues.push({
      code: "lowering-unsupported",
      field: "easing",
      message: "Concurrent source animations must share one easing function before this Program can be applied.",
      operationId: group.operationIds.at(-1),
      severity: "error",
    });
  }

  const edges: DependencyEdge[] = [];
  for (const operation of input.operations) {
    for (const dependency of operation.dependsOn) {
      edges.push({ from: dependency, reason: "explicit", to: operation.id });
      if (!operationIds.includes(dependency)) {
        issues.push({
          code: "schema-invalid",
          field: "dependsOn",
          message: `Dependency ${dependency} is not part of this EditProgram.`,
          operationId: operation.id,
          severity: "error",
        });
      }
    }
  }

  const producerByEntity = new Map<string, string>();
  for (const operation of input.operations) {
    if (operation.kind === "CreateEntity") producerByEntity.set(operation.entity.id, operation.id);
    if (operation.kind === "TransformContent") producerByEntity.set(operation.targetEntityId, operation.id);
    if (operation.kind === "GroupEntities") producerByEntity.set(operation.groupId, operation.id);
  }
  for (const operation of input.operations) {
    for (const entityId of referencedEntityIds(operation)) {
      const producer = producerByEntity.get(entityId);
      if (producer && producer !== operation.id) edges.push({ from: producer, reason: "identity", to: operation.id });
    }
  }

  for (let leftIndex = 0; leftIndex < input.operations.length; leftIndex += 1) {
    const left = input.operations[leftIndex];
    const leftAccess = operationAccess(left);
    for (let rightIndex = leftIndex + 1; rightIndex < input.operations.length; rightIndex += 1) {
      const right = input.operations[rightIndex];
      if (!intervalsOverlap(left.interval, right.interval)) continue;
      const rightAccess = operationAccess(right);
      const leftWrites = new Set(leftAccess.writes.map(channelKey));
      const rightWrites = new Set(rightAccess.writes.map(channelKey));
      const rightReads = new Set(rightAccess.reads.map(channelKey));
      const leftReads = new Set(leftAccess.reads.map(channelKey));
      const writeConflict = [...leftWrites].find((key) => rightWrites.has(key));
      const leftWriteRead = [...leftWrites].find((key) => rightReads.has(key));
      const rightWriteRead = [...rightWrites].find((key) => leftReads.has(key));
      let hasParallelConflictIssue = false;
      if (writeConflict) {
        edges.push({ from: left.id, reason: "write-conflict", to: right.id });
        if (input.requestedExecution === "parallel") {
          issues.push({
            code: "parallel-conflict",
            field: "execution",
            message: `execution is unresolved: ${left.kind} and ${right.kind} both write ${writeConflict}. Choose their order.`,
            operationId: right.id,
            severity: "error",
          });
          hasParallelConflictIssue = true;
        }
      }
      for (const { conflict, from, to } of [
        { conflict: leftWriteRead, from: left.id, to: right.id },
        { conflict: rightWriteRead, from: right.id, to: left.id },
      ]) {
        if (!conflict || conflict === writeConflict) continue;
        const reason = conflict.endsWith("/identity") ? ("identity" as const) : ("read-after-write" as const);
        edges.push({ from, reason, to });
        if (input.requestedExecution === "parallel" && reason === "read-after-write" && !hasParallelConflictIssue) {
          issues.push({
            code: "parallel-conflict",
            field: "execution",
            message: `execution is unresolved: ${to} reads ${conflict} while another operation writes it. Choose their order.`,
            operationId: to,
            severity: "error",
          });
          hasParallelConflictIssue = true;
        }
      }
    }
  }

  if (input.requestedExecution === "sequence") {
    for (let index = 1; index < input.operations.length; index += 1) {
      edges.push({ from: input.operations[index - 1].id, reason: "explicit", to: input.operations[index].id });
    }
  }

  const normalizedEdges = uniqueEdges(edges);
  const order = topologicalOrder(operationIds, normalizedEdges);
  if (!order) {
    issues.push({
      code: "cycle",
      field: "schedule.edges",
      message: "Operation dependencies contain a cycle.",
      severity: "error",
    });
  }
  const scheduledProgram: SceneEdit = {
    ...input,
    schedule: {
      edges: normalizedEdges,
      mode:
        input.requestedExecution === "sequence"
          ? "sequence"
          : normalizedEdges.length > 0
            ? "dependency-dag"
            : "parallel",
      order: order ?? operationIds,
    },
  };
  const execution = programExecutionCapabilities(scheduledProgram);
  if (
    execution.apply === "blocked" &&
    execution.applyBlocker &&
    !issues.some((issue) => issue.code === "lowering-unsupported")
  ) {
    issues.push({
      code: "lowering-unsupported",
      field: "loweringStatus",
      message: execution.applyBlocker,
      severity: execution.lowering === "unsupported" ? "error" : "warning",
    });
  }
  const program: SceneEdit = {
    ...scheduledProgram,
    loweringStatus: execution.lowering,
  };
  return {
    issues,
    kind: issues.some((issue) => issue.severity === "error") ? "invalid" : "valid",
    program,
  };
}
