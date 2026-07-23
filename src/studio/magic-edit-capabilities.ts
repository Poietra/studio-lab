import type { SuggestionObject } from "../ai/edit-suggestions";
import type { RuntimeEntity, RuntimeSceneState } from "./model";
import {
  samplePropertyKnowledge,
  samplePropertyValue,
} from "./property-sampling";

export const MIN_ENTITY_SCALE = 0.1;
export const MAX_ENTITY_SCALE = 8;

function isAppliedStudioEntity(entity: RuntimeEntity) {
  return entity.transactionId !== undefined
    && !entity.provisional
    && entity.id.startsWith(`tx:${entity.transactionId}/entity:`);
}

export function exactEntityScaleAt(
  scene: RuntimeSceneState,
  entity: RuntimeEntity,
  time: number,
) {
  const samples = scene.propertyChannels[`${entity.id}/scale`]?.samples ?? [];
  const sampled = samplePropertyValue(samples, time);
  const sampledValue = typeof sampled === "number" ? sampled : undefined;
  const sampledKnowledge = samplePropertyKnowledge(samples, time, sampledValue);
  if (sampledKnowledge) return sampledKnowledge;
  if (entity.geometry?.scale) return entity.geometry.scale;
  if (samples.length === 0 && isAppliedStudioEntity(entity)) {
    return { kind: "known" as const, value: 1 };
  }
  return {
    kind: "unknown" as const,
    reason: "No exact source scale is available at this time.",
  };
}

export function magicEditCapabilities(
  scene: RuntimeSceneState,
  entity: RuntimeEntity,
  time: number,
): SuggestionObject["editCapabilities"] {
  const scale = exactEntityScaleAt(scene, entity, time);
  const safeScale = scale.kind === "known"
    && Number.isFinite(scale.value)
    && scale.value > 0;
  const safeDelete = entity.sourceIdentity.kind === "known" || isAppliedStudioEntity(entity);
  return {
    delete: safeDelete
      ? { kind: "supported" }
      : {
          kind: "blocked",
          reason: entity.sourceIdentity.reason,
        },
    scale: safeScale
      ? { current: scale.value, kind: "supported" }
      : {
          kind: "blocked",
          reason: scale.kind === "unknown"
            ? scale.reason
            : "The source scale is not a finite positive number.",
        },
  };
}
