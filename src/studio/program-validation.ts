import type { RuntimeSceneState } from "./model";
import { channelKey, type CanonicalEditOperation, type CanonicalEditProgram, type DependencyEdge, type ProgramValidationIssue } from "./operations";
import { operationAccess, operationCapability, validateOperation } from "./operation-registry";

const EPSILON = 0.001;

export type ProgramValidationResult = Readonly<{
  issues: readonly ProgramValidationIssue[];
  kind: "invalid" | "valid";
  program: CanonicalEditProgram;
}>;

function intervalsOverlap(left: CanonicalEditOperation["interval"], right: CanonicalEditOperation["interval"]) {
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

function producedEntityIds(program: CanonicalEditProgram) {
  return new Set(program.operations.flatMap((operation) => {
    if (operation.kind === "CreateEntity") return [operation.entity.id];
    if (operation.kind === "TransformContent") return [operation.targetEntityId];
    return [];
  }));
}

function referencedEntityIds(operation: CanonicalEditOperation) {
  const access = operationAccess(operation);
  return [...new Set([...access.reads, ...access.writes].map((entry) => entry.entityId))]
    .filter((id) => id !== "camera");
}

export function validateAndScheduleProgram(
  input: CanonicalEditProgram,
  scene: RuntimeSceneState,
): ProgramValidationResult {
  const issues: ProgramValidationIssue[] = [];
  if (input.intentCount < 1 || input.intentCount > 3) {
    issues.push({
      code: "operation-count",
      field: "intentCount",
      message: "The first Studio slice accepts one standalone intent or two to three composed intents.",
      severity: "error",
    });
  }
  if (input.loweringStatus === "unsupported") {
    issues.push({
      code: "lowering-unsupported",
      field: "loweringStatus",
      message: "This EditProgram cannot be applied confidently because source lowering is unsupported.",
      severity: "error",
    });
  }
  if (Math.abs((input.operations[0]?.interval.start ?? Number.NaN) - input.anchor.resolvedSeconds) >= EPSILON) {
    issues.push({
      code: "anchor-invalid",
      field: "anchor.resolvedSeconds",
      message: "The resolved anchor must equal the first operation start.",
      severity: "error",
    });
  }

  const operationIds = input.operations.map((operation) => operation.id);
  if (new Set(operationIds).size !== operationIds.length) {
    issues.push({ code: "schema-invalid", field: "operations[].id", message: "Operation IDs must be unique within a transaction.", severity: "error" });
  }
  for (const operation of input.operations) issues.push(...validateOperation(operation, scene));

  const produced = producedEntityIds(input);
  for (const operation of input.operations) {
    for (const entityId of referencedEntityIds(operation)) {
      if (!entityId.startsWith("tx:")) continue;
      if (!entityId.startsWith(`tx:${input.transactionId}/entity:`)) {
        issues.push({
          code: "provisional-id-invalid",
          field: "target",
          message: `Provisional identity ${entityId} is outside transaction ${input.transactionId}.`,
          operationId: operation.id,
          severity: "error",
        });
      } else if (!produced.has(entityId)) {
        issues.push({
          code: "identity-unknown",
          field: "target",
          message: `Provisional identity ${entityId} is not produced by this EditProgram.`,
          operationId: operation.id,
          severity: "error",
        });
      }
    }
    if (operationCapability(operation).lowering === "unsupported") {
      const destructive = operation.kind === "ChangeConstraint";
      issues.push({
        code: "lowering-unsupported",
        field: "loweringStatus",
        message: `${operation.kind} has no truthful source lowering yet.`,
        operationId: operation.id,
        severity: destructive ? "error" : "warning",
      });
    }
    if (operation.kind === "TransformContent") {
      const source = scene.objectGraph.entities[operation.sourceEntityId];
      if (source?.sourceIdentity.kind === "unknown") {
        issues.push({
          code: "identity-unknown",
          field: "sourceEntityId",
          message: `TransformContent cannot destructively replace ${operation.sourceEntityId} while source identity is Unknown.`,
          operationId: operation.id,
          severity: "error",
        });
      }
    }
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
        const reason = conflict.endsWith("/identity") ? "identity" as const : "read-after-write" as const;
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
    issues.push({ code: "cycle", field: "schedule.edges", message: "Operation dependencies contain a cycle.", severity: "error" });
  }
  const program: CanonicalEditProgram = {
    ...input,
    schedule: {
      edges: normalizedEdges,
      mode: input.requestedExecution === "sequence"
        ? "sequence"
        : normalizedEdges.length > 0
          ? "dependency-dag"
          : "parallel",
      order: order ?? operationIds,
    },
  };
  return {
    issues,
    kind: issues.some((issue) => issue.severity === "error") ? "invalid" : "valid",
    program,
  };
}
