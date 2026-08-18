import { validateEditProgram } from "../ai/edit-program-validation";
import type { EditProgramStep, EditSuggestionLeafOperation, EditSuggestionOperation } from "../ai/edit-suggestions";
import { programRecord } from "./evaluator";
import { MAX_ENTITY_SCALE, MIN_ENTITY_SCALE, magicEditCapabilities } from "./magic-edit-capabilities";
import type { ProgramRecord, ProjectedEntity, ProposedState } from "./model";
import type { OperationOrigin, SceneEditValidationIssue } from "./operations";
import type { SceneEditValidationResult } from "./program-validation";
import { STUDIO_STYLE_PROFILE, styleProfileRef } from "./style-profile";
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

function magicObjectEditIssue(
  operation: EditSuggestionOperation,
  context: Readonly<{
    proposedState: ProposedState;
    selectedObjectIds: readonly string[];
  }>,
) {
  const steps = operation.kind === "edit-program" ? operation.operations : [operation];
  const selected = new Set(context.selectedObjectIds);
  const scene = context.proposedState.evaluatedScene;
  for (const step of steps) {
    if (step.kind !== "scale-objects" && step.kind !== "delete-objects") continue;
    for (const entityId of step.targetObjectIds) {
      const entity = scene.objectGraph.entities[entityId];
      if (!entity || !selected.has(entityId)) {
        return "Magic Edit can scale or delete only selected objects that are still available.";
      }
      const lifetime = entity.lifetime.find((interval) => step.start >= interval.start && step.start < interval.end);
      if (!lifetime || step.end > lifetime.end + 0.001) {
        return `Object ${entityId} is not present for the complete ${step.kind} interval.`;
      }
      const capabilities = magicEditCapabilities(scene, entity, step.start);
      if (step.kind === "scale-objects") {
        if (capabilities.scale.kind === "blocked") {
          return `Studio cannot scale ${entityId} safely: ${capabilities.scale.reason}`;
        }
        const target = capabilities.scale.current * step.factor;
        if (!Number.isFinite(target) || target < MIN_ENTITY_SCALE || target > MAX_ENTITY_SCALE) {
          return `Scale must produce an absolute value between ${MIN_ENTITY_SCALE}x and ${MAX_ENTITY_SCALE}x.`;
        }
      } else if (capabilities.delete.kind === "blocked") {
        return `Studio cannot delete ${entityId} safely: ${capabilities.delete.reason}`;
      }
    }
  }
  return null;
}

type StyleProfileStep = EditProgramStep | EditSuggestionLeafOperation;

function styleProfileSteps(operation: EditSuggestionOperation): readonly StyleProfileStep[] {
  return operation.kind === "edit-program" ? operation.operations : [operation];
}

function expectedDurationSeconds(step: StyleProfileStep) {
  if (step.kind === "delete-objects") return STUDIO_STYLE_PROFILE.durationSeconds.brief;
  if (step.kind === "create-explanation" || step.kind === "scale-objects") {
    return STUDIO_STYLE_PROFILE.durationSeconds.standard;
  }
  return STUDIO_STYLE_PROFILE.durationSeconds.deliberate;
}

function secondsLabel(seconds: number) {
  return Number(seconds.toFixed(3)).toString();
}

function styleProfileDeviationIssues(operation: EditSuggestionOperation): readonly SceneEditValidationIssue[] {
  const steps = styleProfileSteps(operation);
  const nested = operation.kind === "edit-program";
  const parallelDuration =
    operation.kind === "edit-program" && operation.execution === "parallel"
      ? Math.max(...steps.map(expectedDurationSeconds))
      : null;
  return steps.flatMap((step, index) => {
    const issues: SceneEditValidationIssue[] = [];
    const duration = step.end - step.start;
    const expectedDuration = parallelDuration ?? expectedDurationSeconds(step);
    if (Math.abs(duration - expectedDuration) >= 0.001) {
      issues.push({
        code: "style-profile-deviation",
        field: nested ? `operations[${index}].duration` : "duration",
        message: `${step.kind} lasts ${secondsLabel(duration)}s; ${STUDIO_STYLE_PROFILE.id} recommends ${secondsLabel(expectedDuration)}s.`,
        severity: "warning",
      });
    }
    if ("easing" in step && step.easing !== STUDIO_STYLE_PROFILE.easing) {
      issues.push({
        code: "style-profile-deviation",
        field: nested ? `operations[${index}].easing` : "easing",
        message: `${step.kind} uses ${step.easing} easing; ${STUDIO_STYLE_PROFILE.id} recommends ${STUDIO_STYLE_PROFILE.easing}.`,
        severity: "warning",
      });
    }
    return issues;
  });
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
  const objectEditIssue = magicObjectEditIssue(normalizedOperation, context);
  if (objectEditIssue) return { kind: "invalid", message: objectEditIssue };
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
  const program = {
    ...canonical.program,
    provenance: {
      ...canonical.program.provenance,
      styleProfileRef: styleProfileRef(STUDIO_STYLE_PROFILE),
    },
  };
  const validation: SceneEditValidationResult = {
    ...canonical,
    issues: [...canonical.issues, ...styleProfileDeviationIssues(normalizedOperation)],
    program,
  };
  return {
    kind: "valid",
    operation: normalizedOperation,
    record: programRecord(program, validation),
  };
}

export function validatedProgramRecord(validation: SceneEditValidationResult):
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
