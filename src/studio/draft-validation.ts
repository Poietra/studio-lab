import { validateEditProgram } from "../ai/edit-program-validation";
import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { programRecord } from "./evaluator";
import type { ProgramRecord, ProjectedEntity, ProposedState } from "./model";
import type { OperationOrigin } from "./operations";
import type { ProgramValidationResult } from "./program-validation";
import { canonicalizeSuggestionProgram } from "./suggestion-program";

export type DraftValidationResult =
  | Readonly<{
      kind: "invalid";
      message: string;
    }>
  | Readonly<{
      kind: "valid";
      operation: EditSuggestionOperation;
      record: ProgramRecord;
    }>;

function includesSceneTransition(operation: EditSuggestionOperation) {
  return (
    operation.kind === "create-scene-transition" ||
    (operation.kind === "edit-program" && operation.operations.some((step) => step.kind === "create-scene-transition"))
  );
}

export function validateSuggestionDraft(
  operation: EditSuggestionOperation,
  context: Readonly<{
    capturedPlayhead: number;
    hasNextScene: boolean;
    origin: OperationOrigin;
    proposedState: ProposedState;
    selectedObjectIds: readonly string[];
    transactionId: string;
  }>,
): DraftValidationResult {
  let normalizedOperation = operation;
  if (operation.kind === "edit-program") {
    const validation = validateEditProgram(operation, {
      capturedPlayhead: context.capturedPlayhead,
      objects: Object.values(context.proposedState.evaluatedScene.objectGraph.entities).map((entity) => ({
        id: entity.id,
        lifetimes: entity.lifetime,
        type: entity.type,
      })),
      sceneDuration: context.proposedState.evaluatedScene.duration,
      selectedObjectIds: context.selectedObjectIds,
    });
    if (validation.kind === "invalid") return { kind: "invalid", message: validation.message };
    normalizedOperation = validation.program.operation;
  }
  if (includesSceneTransition(normalizedOperation) && !context.hasNextScene) {
    return {
      kind: "invalid",
      message: "The active imported Scene has no next Scene. Choose another Scene or add one to the project.",
    };
  }
  const canonical = canonicalizeSuggestionProgram(normalizedOperation, {
    capturedPlayhead: context.capturedPlayhead,
    origin: context.origin,
    scene: context.proposedState.evaluatedScene,
    transactionId: context.transactionId,
  });
  if (canonical.kind === "invalid") {
    return {
      kind: "invalid",
      message:
        canonical.issues.find((issue) => issue.severity === "error")?.message ??
        "The Canonical EditProgram is invalid.",
    };
  }
  return {
    kind: "valid",
    operation: normalizedOperation,
    record: programRecord(canonical.program, canonical),
  };
}

export function validatedProgramRecord(validation: ProgramValidationResult):
  | Readonly<{
      kind: "invalid";
      message: string;
    }>
  | Readonly<{
      kind: "valid";
      record: ProgramRecord;
    }> {
  if (validation.kind === "invalid") {
    return {
      kind: "invalid",
      message:
        validation.issues.find((issue) => issue.severity === "error")?.message ??
        "The Canonical EditProgram is invalid.",
    };
  }
  return { kind: "valid", record: programRecord(validation.program, validation) };
}

export function projectedPositions(
  entities: readonly ProjectedEntity[],
  entityIds: readonly string[],
):
  | Readonly<{
      kind: "invalid";
      message: string;
    }>
  | Readonly<{
      kind: "valid";
      positions: Readonly<Record<string, Readonly<{ x: number; y: number }>>>;
    }> {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const positions: Record<string, Readonly<{ x: number; y: number }>> = {};
  for (const entityId of entityIds) {
    const entity = byId.get(entityId);
    if (!entity) return { kind: "invalid", message: `The projected position for ${entityId} is unavailable.` };
    if (entity.geometry.position.kind === "unknown") {
      return {
        kind: "invalid",
        message: `Studio cannot move ${entityId} safely: ${entity.geometry.position.reason}`,
      };
    }
    positions[entityId] = entity.position;
  }
  return {
    kind: "valid",
    positions,
  };
}
