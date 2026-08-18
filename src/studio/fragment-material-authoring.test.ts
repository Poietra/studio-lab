import { describe, expect, it } from "vitest";

import { STUDIO_WAVE_FRAGMENT_SOURCE_V1 } from "../engine/fragment-material-registry";
import {
  assignStudioFragmentMaterialV1,
  createStudioFragmentMaterialV1,
  duplicateStudioFragmentMaterialV1,
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
  listStudioFragmentMaterialsV1,
  projectFragmentMaterialsForSceneV1,
  removeStudioFragmentMaterialAssetV1,
  removeStudioFragmentMaterialV1,
  renameStudioFragmentMaterialV1,
  sceneHasFragmentMaterialAssignmentsV1,
  studioFragmentMaterialCompileErrorV1,
  updateStudioFragmentMaterialFromGlslV1,
  updateStudioFragmentMaterialSourceV1,
} from "./fragment-material-authoring";

describe("project-local fragment material authoring", () => {
  it("creates, renames, duplicates, edits, and safely removes named materials", () => {
    const created = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "Wave" });
    expect(listStudioFragmentMaterialsV1(created.state)).toMatchObject([
      { name: "Wave", revision: 1, shaderId: created.shaderId },
    ]);

    const assigned = assignStudioFragmentMaterialV1(created.state, {
      entityId: "rectangle",
      sceneId: "scene-a",
      shaderId: created.shaderId,
    });
    expect(sceneHasFragmentMaterialAssignmentsV1(projectFragmentMaterialsForSceneV1(assigned, "scene-a"))).toBe(true);
    expect(assigned.assignmentsByScene["scene-a"]?.rectangle).toMatchObject({
      revision: 1,
      shaderId: created.shaderId,
    });
    expect(removeStudioFragmentMaterialAssetV1(assigned, created.shaderId)).toEqual({
      assignmentCount: 1,
      kind: "in-use",
    });

    const renamed = renameStudioFragmentMaterialV1(assigned, { name: "Ocean wave", shaderId: created.shaderId });
    const edited = updateStudioFragmentMaterialSourceV1(renamed, {
      shaderId: created.shaderId,
      source: `${STUDIO_WAVE_FRAGMENT_SOURCE_V1}\n// edited`,
    });
    expect(edited.registry.materials[0]?.revision).toBe(2);
    expect(edited.assignmentsByScene["scene-a"]?.rectangle?.revision).toBe(2);
    expect(edited.namesByShaderId[created.shaderId]).toBe("Ocean wave");

    const duplicated = duplicateStudioFragmentMaterialV1(edited, created.shaderId);
    expect(listStudioFragmentMaterialsV1(duplicated.state)).toMatchObject([
      { name: "Ocean wave", revision: 2, shaderId: created.shaderId },
      { name: "Ocean wave copy", revision: 1, shaderId: duplicated.shaderId },
    ]);
    expect(duplicated.state.registry.materials[1]?.source).toContain("// edited");

    const unassigned = removeStudioFragmentMaterialV1(duplicated.state, {
      entityId: "rectangle",
      sceneId: "scene-a",
    });
    const removed = removeStudioFragmentMaterialAssetV1(unassigned, created.shaderId);
    expect(removed.kind).toBe("removed");
    if (removed.kind !== "removed") throw new Error("Expected the unused material to be removed.");
    expect(listStudioFragmentMaterialsV1(removed.state)).toMatchObject([{ shaderId: duplicated.shaderId }]);
  });

  it("updates only one material family and projects both referenced sources without leaking across Scenes", () => {
    const first = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "First" });
    const second = createStudioFragmentMaterialV1(first.state, { name: "Second" });
    const sceneA = assignStudioFragmentMaterialV1(second.state, {
      entityId: "rectangle",
      sceneId: "scene-a",
      shaderId: first.shaderId,
    });
    const sceneAWithSecond = assignStudioFragmentMaterialV1(sceneA, {
      entityId: "circle",
      sceneId: "scene-a",
      shaderId: second.shaderId,
    });
    const sceneB = assignStudioFragmentMaterialV1(sceneAWithSecond, {
      entityId: "rectangle",
      sceneId: "scene-b",
      shaderId: first.shaderId,
    });
    const edited = updateStudioFragmentMaterialSourceV1(sceneB, {
      shaderId: first.shaderId,
      source: `${STUDIO_WAVE_FRAGMENT_SOURCE_V1}\n// first edited`,
    });

    const projectedA = projectFragmentMaterialsForSceneV1(edited, "scene-a");
    expect(projectedA.assignments.rectangle).toMatchObject({ revision: 2, shaderId: first.shaderId });
    expect(projectedA.assignments.circle).toMatchObject({ revision: 1, shaderId: second.shaderId });
    expect(projectedA.registry.materials.map(({ revision, shaderId }) => ({ revision, shaderId }))).toEqual([
      { revision: 2, shaderId: first.shaderId },
      { revision: 1, shaderId: second.shaderId },
    ]);
    expect(projectFragmentMaterialsForSceneV1(edited, "scene-b").assignments.rectangle).toMatchObject({
      revision: 2,
      shaderId: first.shaderId,
    });
    expect(projectFragmentMaterialsForSceneV1(edited, "scene-c")).toEqual({
      assignments: {},
      registry: { materials: [], schema: "poietra.fragment-material-registry", version: 1 },
    });
  });

  it("reports active Scene material compilation failure independently of the selected object", () => {
    const material = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "Wave" });
    const assigned = assignStudioFragmentMaterialV1(material.state, {
      entityId: "object-a",
      sceneId: "scene-a",
      shaderId: material.shaderId,
    });
    const activeScene = projectFragmentMaterialsForSceneV1(assigned, "scene-a");
    const emptyScene = projectFragmentMaterialsForSceneV1(assigned, "scene-b");
    const failure = { detail: "WGSL compilation failed", phase: "fallback", reason: "install-failed" } as const;

    expect(studioFragmentMaterialCompileErrorV1(activeScene, failure)).toBe("WGSL compilation failed");
    expect(studioFragmentMaterialCompileErrorV1(emptyScene, failure)).toBeNull();
    expect(
      studioFragmentMaterialCompileErrorV1(activeScene, {
        detail: "still compiling",
        phase: "fallback",
        reason: "installing",
      }),
    ).toBeNull();
  });

  it("retains editable GLSL beside canonical WGSL and clears it on a direct WGSL edit", () => {
    const created = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "GLSL" });
    const glsl = "#version 450\nvoid main() {}";
    const imported = updateStudioFragmentMaterialFromGlslV1(created.state, {
      entryPoint: "main",
      shaderId: created.shaderId,
      source: glsl,
      wgsl: "@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }",
    });

    expect(listStudioFragmentMaterialsV1(imported)).toMatchObject([
      {
        glslSource: { entryPoint: "main", source: glsl },
        revision: 2,
        source: expect.stringContaining("fn fs_main"),
      },
    ]);
    const assigned = assignStudioFragmentMaterialV1(imported, {
      entityId: "rectangle",
      sceneId: "scene-a",
      shaderId: created.shaderId,
    });
    const rendererInput = projectFragmentMaterialsForSceneV1(assigned, "scene-a");
    expect(rendererInput.registry.materials[0]?.source).toContain("fn fs_main");
    expect(JSON.stringify(rendererInput)).not.toContain("#version 450");

    const duplicated = duplicateStudioFragmentMaterialV1(imported, created.shaderId);
    expect(duplicated.state.glslSourcesByShaderId[duplicated.shaderId]).toEqual({ entryPoint: "main", source: glsl });

    const editedAsWgsl = updateStudioFragmentMaterialSourceV1(imported, {
      shaderId: created.shaderId,
      source: imported.registry.materials[0]?.source ?? "",
    });
    expect(editedAsWgsl.glslSourcesByShaderId).not.toHaveProperty(created.shaderId);
    expect(editedAsWgsl.registry.materials[0]?.revision).toBe(2);

    expect(
      updateStudioFragmentMaterialFromGlslV1(imported, {
        entryPoint: "main",
        shaderId: created.shaderId,
        source: glsl,
        wgsl: imported.registry.materials[0]?.source ?? "",
      }),
    ).toBe(imported);
  });
});
