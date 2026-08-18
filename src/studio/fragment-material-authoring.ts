import {
  EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
  type FragmentMaterialRegistryV1,
  fragmentMaterialRegistryV1Schema,
  PROJECT_FRAGMENT_SHADER_ID_V1,
  PROJECT_FRAGMENT_SHADER_REVISION_V1,
  STUDIO_WAVE_FRAGMENT_SOURCE_V1,
} from "../engine/fragment-material-registry";

export type StudioFragmentMaterialReferenceV1 = Readonly<{
  parameters: readonly number[];
  revision: number;
  shaderId: string;
}>;

export type SceneFragmentMaterialStateV1 = Readonly<{
  assignments: Readonly<Record<string, StudioFragmentMaterialReferenceV1>>;
  registry: FragmentMaterialRegistryV1;
}>;

export type ProjectFragmentMaterialStateV1 = Readonly<{
  assignmentsByScene: Readonly<Record<string, Readonly<Record<string, StudioFragmentMaterialReferenceV1>>>>;
  registry: FragmentMaterialRegistryV1;
}>;

export const EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1: ProjectFragmentMaterialStateV1 = Object.freeze({
  assignmentsByScene: Object.freeze({}),
  registry: EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
});

export const EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1: SceneFragmentMaterialStateV1 = Object.freeze({
  assignments: Object.freeze({}),
  registry: EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
});

export function assignStudioFragmentMaterialV1(
  state: ProjectFragmentMaterialStateV1,
  input: Readonly<{ entityId: string; sceneId: string; source: string }>,
): ProjectFragmentMaterialStateV1 {
  const activeMaterial = state.registry.materials.find(({ shaderId }) => shaderId === PROJECT_FRAGMENT_SHADER_ID_V1);
  const revision =
    activeMaterial?.source === input.source
      ? activeMaterial.revision
      : activeMaterial
        ? activeMaterial.revision + 1
        : PROJECT_FRAGMENT_SHADER_REVISION_V1;
  const registry = fragmentMaterialRegistryV1Schema.parse({
    materials: [
      {
        revision,
        shaderId: PROJECT_FRAGMENT_SHADER_ID_V1,
        source: input.source,
      },
    ],
    schema: "poietra.fragment-material-registry",
    version: 1,
  });
  const assignmentsByScene = Object.fromEntries(
    Object.entries(state.assignmentsByScene).map(([sceneId, assignments]) => [
      sceneId,
      Object.fromEntries(
        Object.entries(assignments).map(([entityId, material]) => [entityId, { ...material, revision }]),
      ),
    ]),
  );
  assignmentsByScene[input.sceneId] = {
    ...assignmentsByScene[input.sceneId],
    [input.entityId]: {
      parameters: [0.35, 8],
      revision,
      shaderId: PROJECT_FRAGMENT_SHADER_ID_V1,
    },
  };
  return {
    assignmentsByScene,
    registry,
  };
}

export function removeStudioFragmentMaterialV1(
  state: ProjectFragmentMaterialStateV1,
  input: Readonly<{ entityId: string; sceneId: string }>,
): ProjectFragmentMaterialStateV1 {
  const sceneAssignments = { ...state.assignmentsByScene[input.sceneId] };
  delete sceneAssignments[input.entityId];
  const assignmentsByScene = { ...state.assignmentsByScene };
  if (Object.keys(sceneAssignments).length === 0) delete assignmentsByScene[input.sceneId];
  else assignmentsByScene[input.sceneId] = sceneAssignments;
  return {
    assignmentsByScene,
    registry: state.registry,
  };
}

export function projectFragmentMaterialsForSceneV1(
  state: ProjectFragmentMaterialStateV1,
  sceneId: string | null,
): SceneFragmentMaterialStateV1 {
  if (sceneId === null) return EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1;
  const assignments = state.assignmentsByScene[sceneId] ?? EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1.assignments;
  return {
    assignments,
    registry: Object.keys(assignments).length > 0 ? state.registry : EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
  };
}

export function projectFragmentMaterialSourceV1(state: ProjectFragmentMaterialStateV1) {
  return state.registry.materials[0]?.source ?? STUDIO_WAVE_FRAGMENT_SOURCE_V1;
}

export function sceneHasFragmentMaterialAssignmentsV1(state: SceneFragmentMaterialStateV1) {
  return Object.keys(state.assignments).length > 0;
}
