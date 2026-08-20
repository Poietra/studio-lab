import { operationAccess } from "./operation-registry";
import type { SceneEdit } from "./scene-edit-contract";

export const LOCKED_ENTITY_MUTATION_MESSAGE = "Unlock this object in Layers before editing it.";

/** Returns locked entities written by a canonical edit without changing Scene semantics. */
export function lockedEntityMutationTargets(program: SceneEdit, lockedEntityIds: ReadonlySet<string>) {
  const targets = new Set<string>();
  for (const operation of program.operations) {
    for (const access of operationAccess(operation).writes) {
      if (access.entityId !== "camera" && lockedEntityIds.has(access.entityId)) targets.add(access.entityId);
    }
  }
  return [...targets];
}

export function toggleEntityLock(lockedEntityIds: readonly string[], entityId: string) {
  return lockedEntityIds.includes(entityId)
    ? lockedEntityIds.filter((candidate) => candidate !== entityId)
    : [...lockedEntityIds, entityId];
}
