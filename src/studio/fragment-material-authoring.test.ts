import { describe, expect, it } from "vitest";

import {
  STUDIO_GRADIENT_FRAGMENT_SOURCE_V1,
  STUDIO_PULSE_FRAGMENT_SOURCE_V1,
  STUDIO_TEXTURE_FRAGMENT_SOURCE_V1,
  STUDIO_WAVE_FRAGMENT_SOURCE_V1,
} from "../engine/fragment-material-registry";
import {
  assignStudioFragmentMaterialV1,
  CUBIC_BEZIER_FRAGMENT_MATERIAL_FILL_BLOCKER,
  createStudioFragmentMaterialV1,
  createStudioGradientFragmentMaterialPresetV1,
  createStudioPulseFragmentMaterialPresetV1,
  createStudioTextureFragmentMaterialPresetV1,
  createStudioWaveFragmentMaterialPresetV1,
  cubicBezierFragmentMaterialTransitionBlocker,
  duplicateStudioFragmentMaterialV1,
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
  listStudioFragmentMaterialsV1,
  projectFragmentMaterialStateV1Schema,
  projectFragmentMaterialsForSceneV1,
  recordStudioFragmentMaterialGlslDiagnosticV1,
  removeStudioFragmentMaterialAssetV1,
  removeStudioFragmentMaterialV1,
  renameStudioFragmentMaterialV1,
  sceneHasFragmentMaterialAssignmentsV1,
  studioFragmentMaterialCompileErrorV1,
  studioFragmentMaterialParameterLayoutV1,
  updateStudioFragmentMaterialFromGlslV1,
  updateStudioFragmentMaterialParameterSchemaV1,
  updateStudioFragmentMaterialParameterV1,
  updateStudioFragmentMaterialSourceV1,
  updateStudioFragmentMaterialTextureV1,
} from "./fragment-material-authoring";

describe("project-local fragment material authoring", () => {
  it("blocks history from reopening a Pen path while its fill material remains assigned", () => {
    const assignment = {
      parameters: [0.35, 8],
      revision: 1,
      shaderId: "project-fragment:material-1",
    };
    const program = (closed: boolean, fillColor?: string) => ({
      operations: [
        {
          entity: {
            cubicBezier: { closed, ...(fillColor ? { fillColor } : {}) },
            id: "curve",
            type: "CubicBezier",
          },
          kind: "CreateEntity",
        },
      ],
    });

    expect(cubicBezierFragmentMaterialTransitionBlocker({ curve: assignment }, [program(true, "#ffffff")])).toBeNull();
    expect(cubicBezierFragmentMaterialTransitionBlocker({ curve: assignment }, [program(false)])).toBe(
      CUBIC_BEZIER_FRAGMENT_MATERIAL_FILL_BLOCKER,
    );
    expect(cubicBezierFragmentMaterialTransitionBlocker({}, [program(false)])).toBeNull();
  });

  it("assigns one declared screen texture per object and preserves the slot while duplicating", () => {
    const preset = createStudioTextureFragmentMaterialPresetV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1);
    expect(listStudioFragmentMaterialsV1(preset.state)).toMatchObject([
      {
        name: "Screen texture",
        parameterSchema: [
          { default: 1, name: "Tiles X", range: { max: 8, min: 0.25, step: 0.25 }, type: "f32" },
          { default: 1, name: "Tiles Y", range: { max: 8, min: 0.25, step: 0.25 }, type: "f32" },
          { default: 0, name: "Offset X", range: { max: 2, min: -2, step: 0.05 }, type: "f32" },
          { default: 0, name: "Offset Y", range: { max: 2, min: -2, step: 0.05 }, type: "f32" },
          { default: 1, name: "Mix", range: { max: 1, min: 0, step: 0.05 }, type: "f32" },
        ],
        source: STUDIO_TEXTURE_FRAGMENT_SOURCE_V1,
        textureSlot: "texture2d",
      },
    ]);
    const firstTexture = {
      asset: { assetId: "asset:first", sha256: "1".repeat(64) },
      sampler: "linear" as const,
    };
    const assigned = assignStudioFragmentMaterialV1(preset.state, {
      entityId: "circle",
      sceneId: "scene-a",
      shaderId: preset.shaderId,
      texture: firstTexture,
    });
    expect(assigned.assignmentsByScene["scene-a"]?.circle?.parameters).toEqual([1, 1, 0, 0, 1]);
    const tiled = updateStudioFragmentMaterialParameterV1(assigned, {
      entityId: "circle",
      name: "Tiles X",
      sceneId: "scene-a",
      value: 3,
    });
    const mixed = updateStudioFragmentMaterialParameterV1(tiled, {
      entityId: "circle",
      name: "Mix",
      sceneId: "scene-a",
      value: 0.6,
    });
    expect(mixed.assignmentsByScene["scene-a"]?.circle?.parameters).toEqual([3, 1, 0, 0, 0.6]);
    const changed = updateStudioFragmentMaterialTextureV1(mixed, {
      entityId: "circle",
      sceneId: "scene-a",
      texture: {
        asset: { assetId: "asset:second", sha256: "2".repeat(64) },
        sampler: "nearest",
      },
    });
    expect(changed.assignmentsByScene["scene-a"]?.circle?.texture).toEqual({
      asset: { assetId: "asset:second", sha256: "2".repeat(64) },
      sampler: "nearest",
    });
    expect(() =>
      assignStudioFragmentMaterialV1(preset.state, {
        entityId: "circle",
        sceneId: "scene-a",
        shaderId: preset.shaderId,
      }),
    ).toThrow("Select a project PNG");
    const duplicated = duplicateStudioFragmentMaterialV1(changed, preset.shaderId);
    expect(duplicated.state.registry.materials[1]).toMatchObject({ textureSlot: "texture2d" });
    expect(duplicated.state.parameterSchemasByShaderId[duplicated.shaderId]).toEqual(
      changed.parameterSchemasByShaderId[preset.shaderId],
    );
  });

  it("creates the Wave preset and updates one object's bounded parameters without changing another object", () => {
    const preset = createStudioWaveFragmentMaterialPresetV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1);
    expect(listStudioFragmentMaterialsV1(preset.state)).toMatchObject([
      {
        name: "Wave",
        parameterSchema: [
          { default: 0.35, name: "Speed", range: { max: 2, min: -2, step: 0.05 }, type: "f32" },
          { default: 8, name: "Bands", range: { max: 24, min: 1, step: 1 }, type: "f32" },
        ],
      },
    ]);
    const first = assignStudioFragmentMaterialV1(preset.state, {
      entityId: "circle",
      sceneId: "scene-a",
      shaderId: preset.shaderId,
    });
    const both = assignStudioFragmentMaterialV1(first, {
      entityId: "rectangle",
      sceneId: "scene-a",
      shaderId: preset.shaderId,
    });
    expect(both.assignmentsByScene["scene-a"]?.circle?.parameters).toEqual([0.35, 8]);

    const changed = updateStudioFragmentMaterialParameterV1(both, {
      entityId: "circle",
      name: "Bands",
      sceneId: "scene-a",
      value: 13,
    });
    expect(changed.assignmentsByScene["scene-a"]?.circle?.parameters).toEqual([0.35, 13]);
    expect(changed.assignmentsByScene["scene-a"]?.rectangle?.parameters).toEqual([0.35, 8]);
    expect(projectFragmentMaterialsForSceneV1(changed, "scene-a").assignments.circle?.parameters).toEqual([0.35, 13]);
    expect(() =>
      updateStudioFragmentMaterialParameterV1(changed, {
        entityId: "circle",
        name: "Bands",
        sceneId: "scene-a",
        value: 25,
      }),
    ).toThrow("Bands must be between 1 and 24");
    expect(changed.assignmentsByScene["scene-a"]?.circle?.parameters).toEqual([0.35, 13]);
  });

  it("creates fixed Gradient and Pulse presets and applies their declared parameters", () => {
    const gradient = createStudioGradientFragmentMaterialPresetV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1);
    const pulse = createStudioPulseFragmentMaterialPresetV1(gradient.state);

    expect(listStudioFragmentMaterialsV1(pulse.state)).toMatchObject([
      {
        name: "Gradient",
        parameterSchema: [
          { default: 0.75, name: "Angle", range: { max: 3.14, min: -3.14, step: 0.05 }, type: "f32" },
          { default: 1.5, name: "Spread", range: { max: 4, min: 0.25, step: 0.05 }, type: "f32" },
          { default: [0.2, 0.55, 1], name: "Cool", type: "rgb" },
          { default: [1, 0.3, 0.65], name: "Warm", type: "rgb" },
        ],
        source: STUDIO_GRADIENT_FRAGMENT_SOURCE_V1,
      },
      {
        name: "Pulse",
        parameterSchema: [
          { default: 1, name: "Speed", range: { max: 3, min: -3, step: 0.05 }, type: "f32" },
          { default: 0.65, name: "Strength", range: { max: 1, min: 0, step: 0.05 }, type: "f32" },
        ],
        source: STUDIO_PULSE_FRAGMENT_SOURCE_V1,
      },
    ]);

    const assigned = assignStudioFragmentMaterialV1(pulse.state, {
      entityId: "circle",
      sceneId: "scene-a",
      shaderId: gradient.shaderId,
    });
    const changed = updateStudioFragmentMaterialParameterV1(assigned, {
      entityId: "circle",
      name: "Spread",
      sceneId: "scene-a",
      value: 2.25,
    });
    const recolored = updateStudioFragmentMaterialParameterV1(changed, {
      entityId: "circle",
      name: "Cool",
      sceneId: "scene-a",
      value: [0.1, 0.2, 0.3],
    });

    expect(studioFragmentMaterialParameterLayoutV1(pulse.state.parameterSchemasByShaderId[gradient.shaderId]!)).toEqual(
      {
        defaults: [0.75, 1.5, 0.2, 0.55, 1, 1, 0.3, 0.65],
        entries: [
          expect.objectContaining({ offset: 0, parameter: expect.objectContaining({ name: "Angle" }) }),
          expect.objectContaining({ offset: 1, parameter: expect.objectContaining({ name: "Spread" }) }),
          expect.objectContaining({ offset: 2, parameter: expect.objectContaining({ name: "Cool" }) }),
          expect.objectContaining({ offset: 5, parameter: expect.objectContaining({ name: "Warm" }) }),
        ],
      },
    );
    expect(recolored.assignmentsByScene["scene-a"]?.circle?.parameters).toEqual([
      0.75, 2.25, 0.1, 0.2, 0.3, 1, 0.3, 0.65,
    ]);
    expect(() =>
      updateStudioFragmentMaterialParameterV1(recolored, {
        entityId: "circle",
        name: "Warm",
        sceneId: "scene-a",
        value: [1.1, 0.2, 0.3],
      }),
    ).toThrow("Warm color components must be between 0 and 1");
    expect(
      projectFragmentMaterialStateV1Schema.safeParse({
        ...recolored,
        assignmentsByScene: {
          "scene-a": {
            circle: {
              ...recolored.assignmentsByScene["scene-a"]!.circle!,
              parameters: [0.75, 2.25, 0.1, 0.2, 1.1, 1, 0.3, 0.65],
            },
          },
        },
      }).success,
    ).toBe(false);

    const duplicated = duplicateStudioFragmentMaterialV1(recolored, gradient.shaderId);
    expect(duplicated.state.parameterSchemasByShaderId[duplicated.shaderId]).toEqual(
      recolored.parameterSchemasByShaderId[gradient.shaderId],
    );
    expect(
      assignStudioFragmentMaterialV1(duplicated.state, {
        entityId: "copy",
        sceneId: "scene-a",
        shaderId: duplicated.shaderId,
      }).assignmentsByScene["scene-a"]?.copy?.parameters,
    ).toEqual([0.75, 1.5, 0.2, 0.55, 1, 1, 0.3, 0.65]);
  });

  it("rejects invalid authoring schemas before they can replace project state", () => {
    expect(() =>
      createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, {
        name: "Invalid preset",
        parameterSchema: [{ default: 2, name: "Strength", range: { max: 1, min: 0, step: 0.1 }, type: "f32" }],
      }),
    ).toThrow("Parameter default must be inside its range");
    expect(() =>
      createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, {
        name: "Too many colors",
        parameterSchema: [
          { default: [0, 0, 0], name: "First", type: "rgb" },
          { default: [0, 0, 0], name: "Second", type: "rgb" },
          { default: [0, 0, 0], name: "Third", type: "rgb" },
        ],
      }),
    ).toThrow("at most 8 scalar values");
    expect(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1.registry.materials).toEqual([]);
  });

  it("authors scalar and RGB slots for custom WGSL and applies their defaults without changing the render ABI", () => {
    const created = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "Custom" });
    const custom = updateStudioFragmentMaterialSourceV1(created.state, {
      shaderId: created.shaderId,
      source: `${STUDIO_WAVE_FRAGMENT_SOURCE_V1}\n// custom host.parameters_0`,
    });
    const parameterSchema = [
      { default: 0.4, name: "Amplitude", range: { max: 1, min: 0, step: 0.05 }, type: "f32" as const },
      { default: 3, name: "Frequency", range: { max: 12, min: 1, step: 0.5 }, type: "f32" as const },
      { default: [0.2, 0.4, 0.8] as const, name: "Tint", type: "rgb" as const },
    ];
    const authored = updateStudioFragmentMaterialParameterSchemaV1(custom, {
      parameterSchema,
      shaderId: created.shaderId,
    });
    expect(authored.parameterSchemasByShaderId[created.shaderId]).toEqual(parameterSchema);

    const duplicated = duplicateStudioFragmentMaterialV1(authored, created.shaderId);
    expect(duplicated.state.parameterSchemasByShaderId[duplicated.shaderId]).toEqual(parameterSchema);
    const assigned = assignStudioFragmentMaterialV1(duplicated.state, {
      entityId: "circle",
      sceneId: "scene-a",
      shaderId: created.shaderId,
    });
    expect(projectFragmentMaterialsForSceneV1(assigned, "scene-a").assignments.circle?.parameters).toEqual([
      0.4, 3, 0.2, 0.4, 0.8,
    ]);
    expect(() =>
      updateStudioFragmentMaterialParameterSchemaV1(assigned, {
        parameterSchema: parameterSchema.slice(0, 1),
        shaderId: created.shaderId,
      }),
    ).toThrow("Unassign this material from 1 object(s) before editing its parameter schema");

    const unassigned = removeStudioFragmentMaterialV1(assigned, { entityId: "circle", sceneId: "scene-a" });
    expect(
      updateStudioFragmentMaterialParameterSchemaV1(unassigned, {
        parameterSchema: parameterSchema.slice(0, 1),
        shaderId: created.shaderId,
      }).parameterSchemasByShaderId[created.shaderId],
    ).toEqual(parameterSchema.slice(0, 1));
    expect(() =>
      updateStudioFragmentMaterialParameterSchemaV1(custom, {
        parameterSchema: [parameterSchema[0]!, { ...parameterSchema[1]!, name: "amplitude" }],
        shaderId: created.shaderId,
      }),
    ).toThrow("Parameter names must be unique");
    expect(() =>
      updateStudioFragmentMaterialParameterSchemaV1(custom, {
        parameterSchema: [{ default: 0.4, name: "Amplitude", range: { max: 0, min: 1, step: 0.05 }, type: "f32" }],
        shaderId: created.shaderId,
      }),
    ).toThrow("Parameter range max must be greater than min");
    expect(() =>
      updateStudioFragmentMaterialParameterSchemaV1(custom, {
        parameterSchema: Array.from({ length: 9 }, (_, index) => ({
          default: 0,
          name: `Value ${index + 1}`,
          range: { max: 1, min: 0, step: 0.1 },
          type: "f32" as const,
        })),
        shaderId: created.shaderId,
      }),
    ).toThrow("at most 8 scalar values");
  });

  it("does not invent Wave parameter metadata while duplicating a schema-less material", () => {
    const created = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "Wave" });
    const custom = updateStudioFragmentMaterialSourceV1(created.state, {
      shaderId: created.shaderId,
      source: `${STUDIO_WAVE_FRAGMENT_SOURCE_V1}\n// custom`,
    });
    const legacyWave = updateStudioFragmentMaterialSourceV1(custom, {
      shaderId: created.shaderId,
      source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
    });

    const duplicated = duplicateStudioFragmentMaterialV1(legacyWave, created.shaderId);

    expect(legacyWave.parameterSchemasByShaderId).not.toHaveProperty(created.shaderId);
    expect(duplicated.state.parameterSchemasByShaderId).not.toHaveProperty(duplicated.shaderId);
    expect(
      assignStudioFragmentMaterialV1(duplicated.state, {
        entityId: "circle",
        sceneId: "scene-a",
        shaderId: duplicated.shaderId,
      }).assignmentsByScene["scene-a"]?.circle?.parameters,
    ).toEqual([0.35, 8]);
  });

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
    expect(listStudioFragmentMaterialsV1(edited)[0]?.parameterSchema).toEqual([]);
    expect(edited.assignmentsByScene["scene-a"]?.rectangle?.parameters).toEqual([0.35, 8]);

    const duplicated = duplicateStudioFragmentMaterialV1(edited, created.shaderId);
    expect(listStudioFragmentMaterialsV1(duplicated.state)).toMatchObject([
      { name: "Ocean wave", revision: 2, shaderId: created.shaderId },
      { name: "Ocean wave copy", revision: 1, shaderId: duplicated.shaderId },
    ]);
    expect(duplicated.state.registry.materials[1]?.source).toContain("// edited");
    expect(duplicated.state.parameterSchemasByShaderId).not.toHaveProperty(duplicated.shaderId);
    expect(
      assignStudioFragmentMaterialV1(duplicated.state, {
        entityId: "duplicate",
        sceneId: "scene-a",
        shaderId: duplicated.shaderId,
      }).assignmentsByScene["scene-a"]?.duplicate?.parameters,
    ).toEqual([0.35, 8]);

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

  it("atomically unassigns an in-use material across Scenes before deleting its asset", () => {
    const first = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "First" });
    const second = createStudioFragmentMaterialV1(first.state, { name: "Second" });
    const sceneAFirst = assignStudioFragmentMaterialV1(second.state, {
      entityId: "circle",
      sceneId: "scene-a",
      shaderId: first.shaderId,
    });
    const sceneBFirst = assignStudioFragmentMaterialV1(sceneAFirst, {
      entityId: "rectangle",
      sceneId: "scene-b",
      shaderId: first.shaderId,
    });
    const assigned = assignStudioFragmentMaterialV1(sceneBFirst, {
      entityId: "label",
      sceneId: "scene-a",
      shaderId: second.shaderId,
    });

    expect(removeStudioFragmentMaterialAssetV1(assigned, first.shaderId)).toEqual({
      assignmentCount: 2,
      kind: "in-use",
    });

    const result = removeStudioFragmentMaterialAssetV1(assigned, first.shaderId, "unassign-all");
    expect(result.kind).toBe("removed");
    if (result.kind !== "removed") throw new Error("Expected the in-use material deletion to be resolved.");
    expect(listStudioFragmentMaterialsV1(result.state)).toMatchObject([{ shaderId: second.shaderId }]);
    expect(result.state.assignmentsByScene).toEqual({
      "scene-a": {
        label: expect.objectContaining({ shaderId: second.shaderId }),
      },
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
        parameterSchema: [],
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

  it("retains rejected GLSL and its diagnostic without replacing the last compiled WGSL", () => {
    const created = createStudioFragmentMaterialV1(EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1, { name: "GLSL" });
    const canonicalWgsl = created.state.registry.materials[0]?.source ?? "";
    const rejectedSource = "#version 450\nvoid main( {";
    const rejected = recordStudioFragmentMaterialGlslDiagnosticV1(created.state, {
      diagnostic: "material.glsl:2:12: expected ')'",
      entryPoint: "main",
      shaderId: created.shaderId,
      source: rejectedSource,
    });

    expect(rejected.registry).toEqual(created.state.registry);
    expect(rejected.glslSourcesByShaderId[created.shaderId]).toEqual({
      diagnostic: "material.glsl:2:12: expected ')'",
      entryPoint: "main",
      source: rejectedSource,
    });

    const accepted = updateStudioFragmentMaterialFromGlslV1(rejected, {
      entryPoint: "main",
      shaderId: created.shaderId,
      source: rejectedSource,
      wgsl: canonicalWgsl,
    });
    expect(accepted.registry).toEqual(created.state.registry);
    expect(accepted.glslSourcesByShaderId[created.shaderId]).toEqual({
      entryPoint: "main",
      source: rejectedSource,
    });
  });
});
