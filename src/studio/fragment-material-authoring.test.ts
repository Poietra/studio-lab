import { describe, expect, it } from "vitest";

import { STUDIO_WAVE_FRAGMENT_SOURCE_V1 } from "../engine/fragment-material-registry";
import {
  assignStudioFragmentMaterialV1,
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
  projectFragmentMaterialsForSceneV1,
  removeStudioFragmentMaterialV1,
  sceneHasFragmentMaterialAssignmentsV1,
} from "./fragment-material-authoring";

describe("project-local fragment material authoring", () => {
  it("assigns and removes one entity without mutating the prior project state", () => {
    const assigned = assignStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, {
      entityId: "rectangle",
      sceneId: "scene-a",
      source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
    });
    expect(sceneHasFragmentMaterialAssignmentsV1(projectFragmentMaterialsForSceneV1(assigned, "scene-a"))).toBe(true);
    expect(assigned.assignmentsByScene["scene-a"]?.rectangle).toMatchObject({
      shaderId: "project-studio-fragment",
    });
    expect(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1.assignmentsByScene).toEqual({});

    const edited = assignStudioFragmentMaterialV1(assigned, {
      entityId: "circle",
      sceneId: "scene-b",
      source: `${STUDIO_WAVE_FRAGMENT_SOURCE_V1}\n// edited`,
    });
    expect(edited.registry.materials[0]?.revision).toBe(2);
    expect(edited.assignmentsByScene["scene-a"]?.rectangle?.revision).toBe(2);
    expect(edited.assignmentsByScene["scene-b"]?.circle?.revision).toBe(2);
    expect(projectFragmentMaterialsForSceneV1(edited, "scene-b").assignments.circle).toBeDefined();
    expect(projectFragmentMaterialsForSceneV1(edited, "scene-a").assignments.circle).toBeUndefined();

    const removed = removeStudioFragmentMaterialV1(assigned, { entityId: "rectangle", sceneId: "scene-a" });
    expect(sceneHasFragmentMaterialAssignmentsV1(projectFragmentMaterialsForSceneV1(removed, "scene-a"))).toBe(false);
    expect(removed.registry.materials[0]?.source).toBe(STUDIO_WAVE_FRAGMENT_SOURCE_V1);

    const reassigned = assignStudioFragmentMaterialV1(removed, {
      entityId: "circle",
      sceneId: "scene-a",
      source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
    });
    expect(reassigned.registry.materials[0]?.revision).toBe(1);
  });

  it("does not leak assignments when the active scene changes", () => {
    const assigned = assignStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, {
      entityId: "shared-studio-id",
      sceneId: "scene-a",
      source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
    });

    expect(projectFragmentMaterialsForSceneV1(assigned, "scene-a").assignments).toHaveProperty("shared-studio-id");
    expect(projectFragmentMaterialsForSceneV1(assigned, "scene-b")).toEqual({
      assignments: {},
      registry: { materials: [], schema: "poietra.fragment-material-registry", version: 1 },
    });
  });
});
