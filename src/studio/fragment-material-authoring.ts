import { z } from "zod";
import {
  EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
  type FragmentMaterialRegistryV1,
  type FragmentMaterialSourceV1,
  fragmentMaterialRegistryV1Schema,
  MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1,
  MAX_PROJECT_FRAGMENT_MATERIALS_V1,
  PROJECT_FRAGMENT_SHADER_ID_V1,
  STUDIO_WAVE_FRAGMENT_SOURCE_V1,
} from "../engine/fragment-material-registry";
import type { PreviewRendererHostStateV1 } from "../engine/preview-renderer";
import {
  fragmentMaterialV1Schema,
  MAX_FINITE_F32,
  MAX_FRAGMENT_MATERIAL_PARAMETERS_V1,
  opaqueIdV1Schema,
  sourceIdentityV1Schema,
} from "../engine/primitives";

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
  glslSourcesByShaderId: Readonly<Record<string, StudioFragmentMaterialGlslSource>>;
  namesByShaderId: Readonly<Record<string, string>>;
  parameterSchemasByShaderId: Readonly<Record<string, StudioFragmentMaterialParameterSchemaV1>>;
  registry: FragmentMaterialRegistryV1;
}>;

export type StudioFragmentMaterialGlslSource = Readonly<{
  entryPoint: "main";
  source: string;
}>;

export type StudioFragmentMaterialF32ParameterV1 = Readonly<{
  default: number;
  name: string;
  range: Readonly<{ max: number; min: number; step: number }>;
  type: "f32";
}>;

export type StudioFragmentMaterialParameterSchemaV1 = readonly StudioFragmentMaterialF32ParameterV1[];

export type StudioNamedFragmentMaterialV1 = FragmentMaterialSourceV1 &
  Readonly<{
    glslSource: StudioFragmentMaterialGlslSource | null;
    name: string;
    parameterSchema: StudioFragmentMaterialParameterSchemaV1;
  }>;

const fragmentMaterialNameSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((name) => name === name.trim(), "Material names must not have surrounding whitespace.")
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "Material names must not contain control characters.");

const fragmentMaterialGlslSourceSchema = z
  .object({
    entryPoint: z.literal("main"),
    source: z
      .string()
      .min(1)
      .refine(
        (source) => new TextEncoder().encode(source).byteLength <= MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1,
        `GLSL source accepts at most ${MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1} UTF-8 bytes.`,
      ),
  })
  .strict();

const finiteF32Schema = z.number().finite().min(-MAX_FINITE_F32).max(MAX_FINITE_F32);
const fragmentMaterialF32ParameterSchema = z
  .object({
    default: finiteF32Schema,
    name: z
      .string()
      .min(1)
      .max(40)
      .refine((name) => name === name.trim(), "Parameter names must not have surrounding whitespace.")
      .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "Parameter names must not contain control characters."),
    range: z
      .object({
        max: finiteF32Schema,
        min: finiteF32Schema,
        step: finiteF32Schema.positive(),
      })
      .strict(),
    type: z.literal("f32"),
  })
  .strict()
  .superRefine((parameter, context) => {
    if (parameter.range.max <= parameter.range.min) {
      context.addIssue({ code: "custom", message: "Parameter range max must be greater than min.", path: ["range"] });
    }
    if (parameter.default < parameter.range.min || parameter.default > parameter.range.max) {
      context.addIssue({ code: "custom", message: "Parameter default must be inside its range.", path: ["default"] });
    }
    if (parameter.range.step > parameter.range.max - parameter.range.min) {
      context.addIssue({
        code: "custom",
        message: "Parameter step must not exceed its range.",
        path: ["range", "step"],
      });
    }
  });

const fragmentMaterialParameterSchema = z
  .array(fragmentMaterialF32ParameterSchema)
  .max(MAX_FRAGMENT_MATERIAL_PARAMETERS_V1)
  .superRefine((parameters, context) => {
    const names = new Set<string>();
    for (const [index, parameter] of parameters.entries()) {
      const folded = parameter.name.toLowerCase();
      if (names.has(folded)) {
        context.addIssue({ code: "custom", message: "Parameter names must be unique.", path: [index, "name"] });
      }
      names.add(folded);
    }
  });

export const STUDIO_WAVE_FRAGMENT_PARAMETER_SCHEMA_V1: StudioFragmentMaterialParameterSchemaV1 = Object.freeze([
  Object.freeze({ default: 0.35, name: "Speed", range: Object.freeze({ max: 2, min: -2, step: 0.05 }), type: "f32" }),
  Object.freeze({ default: 8, name: "Bands", range: Object.freeze({ max: 24, min: 1, step: 1 }), type: "f32" }),
]);

const rawProjectFragmentMaterialStateSchema = z
  .object({
    assignmentsByScene: z.record(sourceIdentityV1Schema, z.record(sourceIdentityV1Schema, fragmentMaterialV1Schema)),
    glslSourcesByShaderId: z.record(opaqueIdV1Schema, fragmentMaterialGlslSourceSchema).optional(),
    namesByShaderId: z.record(opaqueIdV1Schema, fragmentMaterialNameSchema).optional(),
    parameterSchemasByShaderId: z.record(opaqueIdV1Schema, fragmentMaterialParameterSchema).optional(),
    registry: fragmentMaterialRegistryV1Schema,
  })
  .strict();

function legacyMaterialName(shaderId: string) {
  return shaderId === PROJECT_FRAGMENT_SHADER_ID_V1 ? "Wave material" : shaderId;
}

export const projectFragmentMaterialStateV1Schema = rawProjectFragmentMaterialStateSchema
  .transform(
    (state): ProjectFragmentMaterialStateV1 => ({
      ...state,
      glslSourcesByShaderId: state.glslSourcesByShaderId ?? {},
      namesByShaderId: Object.fromEntries(
        state.registry.materials.map((material) => [
          material.shaderId,
          state.namesByShaderId?.[material.shaderId] ?? legacyMaterialName(material.shaderId),
        ]),
      ),
      parameterSchemasByShaderId: Object.fromEntries(
        state.registry.materials.flatMap((material) => {
          const parameterSchema = state.parameterSchemasByShaderId?.[material.shaderId] ?? null;
          return parameterSchema === null ? [] : [[material.shaderId, parameterSchema]];
        }),
      ),
    }),
  )
  .superRefine((state, context) => {
    const availableMaterials = new Set(
      state.registry.materials.map((material) => `${material.shaderId}\0${material.revision}`),
    );
    const shaderIds = new Set<string>();
    for (const [index, material] of state.registry.materials.entries()) {
      if (shaderIds.has(material.shaderId)) {
        context.addIssue({
          code: "custom",
          message: "A project material shader ID must identify exactly one current revision.",
          path: ["registry", "materials", index, "shaderId"],
        });
      }
      shaderIds.add(material.shaderId);
    }
    for (const shaderId of Object.keys(state.glslSourcesByShaderId)) {
      if (!shaderIds.has(shaderId)) {
        context.addIssue({
          code: "custom",
          message: "GLSL authoring source must belong to an existing project material.",
          path: ["glslSourcesByShaderId", shaderId],
        });
      }
    }
    for (const shaderId of Object.keys(state.parameterSchemasByShaderId)) {
      if (!shaderIds.has(shaderId)) {
        context.addIssue({
          code: "custom",
          message: "Parameter schema must belong to an existing project material.",
          path: ["parameterSchemasByShaderId", shaderId],
        });
      }
    }
    for (const [sceneId, assignments] of Object.entries(state.assignmentsByScene)) {
      for (const [entityId, assignment] of Object.entries(assignments)) {
        if (!availableMaterials.has(`${assignment.shaderId}\0${assignment.revision}`)) {
          context.addIssue({
            code: "custom",
            message: "The fragment material assignment has no matching project source revision.",
            path: ["assignmentsByScene", sceneId, entityId],
          });
        }
        const parameterSchema = state.parameterSchemasByShaderId[assignment.shaderId];
        if (parameterSchema && assignment.parameters.length !== parameterSchema.length) {
          context.addIssue({
            code: "custom",
            message: "The material reference must contain one value for every declared parameter.",
            path: ["assignmentsByScene", sceneId, entityId, "parameters"],
          });
        }
        parameterSchema?.forEach((parameter, index) => {
          const value = assignment.parameters[index];
          if (value !== undefined && (value < parameter.range.min || value > parameter.range.max)) {
            context.addIssue({
              code: "custom",
              message: `${parameter.name} must be between ${parameter.range.min} and ${parameter.range.max}.`,
              path: ["assignmentsByScene", sceneId, entityId, "parameters", index],
            });
          }
        });
      }
    }
  });

export const EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1: ProjectFragmentMaterialStateV1 = Object.freeze({
  assignmentsByScene: Object.freeze({}),
  glslSourcesByShaderId: Object.freeze({}),
  namesByShaderId: Object.freeze({}),
  parameterSchemasByShaderId: Object.freeze({}),
  registry: EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
});

export const EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1: SceneFragmentMaterialStateV1 = Object.freeze({
  assignments: Object.freeze({}),
  registry: EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
});

function materialNameTaken(state: ProjectFragmentMaterialStateV1, name: string, exceptShaderId?: string) {
  const folded = name.toLowerCase();
  return Object.entries(state.namesByShaderId).some(
    ([shaderId, candidate]) => shaderId !== exceptShaderId && candidate.toLowerCase() === folded,
  );
}

function checkedMaterialName(state: ProjectFragmentMaterialStateV1, name: string, exceptShaderId?: string) {
  const checked = fragmentMaterialNameSchema.parse(name);
  if (materialNameTaken(state, checked, exceptShaderId))
    throw new Error(`A material named “${checked}” already exists.`);
  return checked;
}

function nextMaterialShaderId(state: ProjectFragmentMaterialStateV1) {
  const existing = new Set(state.registry.materials.map(({ shaderId }) => shaderId));
  for (let index = 1; index <= MAX_PROJECT_FRAGMENT_MATERIALS_V1 + 1; index += 1) {
    const candidate = `project-material-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("No project material identity is available.");
}

function parseProjectFragmentMaterialState(state: ProjectFragmentMaterialStateV1) {
  return projectFragmentMaterialStateV1Schema.parse(state);
}

export function listStudioFragmentMaterialsV1(
  state: ProjectFragmentMaterialStateV1,
): readonly StudioNamedFragmentMaterialV1[] {
  return state.registry.materials.map((material) => ({
    ...material,
    glslSource: state.glslSourcesByShaderId[material.shaderId] ?? null,
    name: state.namesByShaderId[material.shaderId] ?? legacyMaterialName(material.shaderId),
    parameterSchema: state.parameterSchemasByShaderId[material.shaderId] ?? [],
  }));
}

export function createStudioFragmentMaterialV1(
  state: ProjectFragmentMaterialStateV1,
  input: Readonly<{
    glslSource?: StudioFragmentMaterialGlslSource;
    name: string;
    parameterSchema?: StudioFragmentMaterialParameterSchemaV1;
    source?: string;
  }>,
): Readonly<{ shaderId: string; state: ProjectFragmentMaterialStateV1 }> {
  if (state.registry.materials.length >= MAX_PROJECT_FRAGMENT_MATERIALS_V1) {
    throw new Error(`A project accepts at most ${MAX_PROJECT_FRAGMENT_MATERIALS_V1} materials.`);
  }
  const name = checkedMaterialName(state, input.name);
  const shaderId = nextMaterialShaderId(state);
  return {
    shaderId,
    state: parseProjectFragmentMaterialState({
      assignmentsByScene: state.assignmentsByScene,
      glslSourcesByShaderId: input.glslSource
        ? { ...state.glslSourcesByShaderId, [shaderId]: input.glslSource }
        : state.glslSourcesByShaderId,
      namesByShaderId: { ...state.namesByShaderId, [shaderId]: name },
      parameterSchemasByShaderId: {
        ...state.parameterSchemasByShaderId,
        [shaderId]: input.parameterSchema ?? STUDIO_WAVE_FRAGMENT_PARAMETER_SCHEMA_V1,
      },
      registry: {
        ...state.registry,
        materials: [
          ...state.registry.materials,
          { revision: 1, shaderId, source: input.source ?? STUDIO_WAVE_FRAGMENT_SOURCE_V1 },
        ],
      },
    }),
  };
}

function uniquePresetName(state: ProjectFragmentMaterialStateV1, baseName: string) {
  if (!materialNameTaken(state, baseName)) return baseName;
  for (let suffix = 2; suffix <= MAX_PROJECT_FRAGMENT_MATERIALS_V1 + 1; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!materialNameTaken(state, candidate)) return candidate;
  }
  throw new Error("No preset material name is available.");
}

export function createStudioWaveFragmentMaterialPresetV1(
  state: ProjectFragmentMaterialStateV1,
): Readonly<{ shaderId: string; state: ProjectFragmentMaterialStateV1 }> {
  return createStudioFragmentMaterialV1(state, {
    name: uniquePresetName(state, "Wave"),
    parameterSchema: STUDIO_WAVE_FRAGMENT_PARAMETER_SCHEMA_V1,
    source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
  });
}

export function renameStudioFragmentMaterialV1(
  state: ProjectFragmentMaterialStateV1,
  input: Readonly<{ name: string; shaderId: string }>,
): ProjectFragmentMaterialStateV1 {
  if (!state.registry.materials.some(({ shaderId }) => shaderId === input.shaderId)) {
    throw new Error("The material no longer exists.");
  }
  const name = checkedMaterialName(state, input.name, input.shaderId);
  return parseProjectFragmentMaterialState({
    ...state,
    namesByShaderId: { ...state.namesByShaderId, [input.shaderId]: name },
  });
}

function uniqueDuplicateName(state: ProjectFragmentMaterialStateV1, originalName: string) {
  for (let copy = 1; copy <= MAX_PROJECT_FRAGMENT_MATERIALS_V1; copy += 1) {
    const suffix = copy === 1 ? " copy" : ` copy ${copy}`;
    const candidate = `${originalName.slice(0, 80 - suffix.length)}${suffix}`;
    if (!materialNameTaken(state, candidate)) return candidate;
  }
  throw new Error("No duplicate material name is available.");
}

export function duplicateStudioFragmentMaterialV1(
  state: ProjectFragmentMaterialStateV1,
  shaderId: string,
): Readonly<{ shaderId: string; state: ProjectFragmentMaterialStateV1 }> {
  const source = state.registry.materials.find((material) => material.shaderId === shaderId);
  if (!source) throw new Error("The material no longer exists.");
  return createStudioFragmentMaterialV1(state, {
    name: uniqueDuplicateName(state, state.namesByShaderId[shaderId] ?? legacyMaterialName(shaderId)),
    parameterSchema: state.parameterSchemasByShaderId[shaderId] ?? [],
    ...(state.glslSourcesByShaderId[shaderId] ? { glslSource: state.glslSourcesByShaderId[shaderId] } : {}),
    source: source.source,
  });
}

export function studioFragmentMaterialAssignmentCountV1(state: ProjectFragmentMaterialStateV1, shaderId: string) {
  return Object.values(state.assignmentsByScene).reduce(
    (count, assignments) =>
      count + Object.values(assignments).filter((assignment) => assignment.shaderId === shaderId).length,
    0,
  );
}

export type RemoveStudioFragmentMaterialResultV1 =
  | Readonly<{ assignmentCount: number; kind: "in-use" }>
  | Readonly<{ kind: "removed"; state: ProjectFragmentMaterialStateV1 }>;

export function removeStudioFragmentMaterialAssetV1(
  state: ProjectFragmentMaterialStateV1,
  shaderId: string,
): RemoveStudioFragmentMaterialResultV1 {
  if (!state.registry.materials.some((material) => material.shaderId === shaderId)) {
    throw new Error("The material no longer exists.");
  }
  const assignmentCount = studioFragmentMaterialAssignmentCountV1(state, shaderId);
  if (assignmentCount > 0) return { assignmentCount, kind: "in-use" };
  const namesByShaderId = { ...state.namesByShaderId };
  delete namesByShaderId[shaderId];
  const glslSourcesByShaderId = { ...state.glslSourcesByShaderId };
  delete glslSourcesByShaderId[shaderId];
  const parameterSchemasByShaderId = { ...state.parameterSchemasByShaderId };
  delete parameterSchemasByShaderId[shaderId];
  return {
    kind: "removed",
    state: parseProjectFragmentMaterialState({
      assignmentsByScene: state.assignmentsByScene,
      glslSourcesByShaderId,
      namesByShaderId,
      parameterSchemasByShaderId,
      registry: {
        ...state.registry,
        materials: state.registry.materials.filter((material) => material.shaderId !== shaderId),
      },
    }),
  };
}

export function updateStudioFragmentMaterialSourceV1(
  state: ProjectFragmentMaterialStateV1,
  input: Readonly<{ shaderId: string; source: string }>,
): ProjectFragmentMaterialStateV1 {
  const activeMaterial = state.registry.materials.find(({ shaderId }) => shaderId === input.shaderId);
  if (!activeMaterial) throw new Error("The material no longer exists.");
  if (activeMaterial.source === input.source) {
    if (!(input.shaderId in state.glslSourcesByShaderId)) return state;
    const glslSourcesByShaderId = { ...state.glslSourcesByShaderId };
    delete glslSourcesByShaderId[input.shaderId];
    return parseProjectFragmentMaterialState({
      ...state,
      glslSourcesByShaderId,
    });
  }
  const revision = activeMaterial.revision + 1;
  const assignmentsByScene = Object.fromEntries(
    Object.entries(state.assignmentsByScene).map(([sceneId, assignments]) => [
      sceneId,
      Object.fromEntries(
        Object.entries(assignments).map(([entityId, material]) => [
          entityId,
          material.shaderId === input.shaderId ? { ...material, revision } : material,
        ]),
      ),
    ]),
  );
  const glslSourcesByShaderId = { ...state.glslSourcesByShaderId };
  delete glslSourcesByShaderId[input.shaderId];
  return parseProjectFragmentMaterialState({
    assignmentsByScene,
    glslSourcesByShaderId,
    namesByShaderId: state.namesByShaderId,
    parameterSchemasByShaderId: state.parameterSchemasByShaderId,
    registry: {
      ...state.registry,
      materials: state.registry.materials.map((material) =>
        material.shaderId === input.shaderId ? { ...material, revision, source: input.source } : material,
      ),
    },
  });
}

export function updateStudioFragmentMaterialFromGlslV1(
  state: ProjectFragmentMaterialStateV1,
  input: Readonly<{
    entryPoint: "main";
    shaderId: string;
    source: string;
    wgsl: string;
  }>,
): ProjectFragmentMaterialStateV1 {
  const activeMaterial = state.registry.materials.find(({ shaderId }) => shaderId === input.shaderId);
  if (!activeMaterial) throw new Error("The material no longer exists.");
  const currentGlsl = state.glslSourcesByShaderId[input.shaderId];
  if (
    activeMaterial.source === input.wgsl &&
    currentGlsl?.entryPoint === input.entryPoint &&
    currentGlsl.source === input.source
  ) {
    return state;
  }
  if (activeMaterial.source === input.wgsl) {
    return parseProjectFragmentMaterialState({
      ...state,
      glslSourcesByShaderId: {
        ...state.glslSourcesByShaderId,
        [input.shaderId]: { entryPoint: input.entryPoint, source: input.source },
      },
    });
  }
  const updated = updateStudioFragmentMaterialSourceV1(state, {
    shaderId: input.shaderId,
    source: input.wgsl,
  });
  return parseProjectFragmentMaterialState({
    ...updated,
    glslSourcesByShaderId: {
      ...updated.glslSourcesByShaderId,
      [input.shaderId]: { entryPoint: input.entryPoint, source: input.source },
    },
  });
}

export function assignStudioFragmentMaterialV1(
  state: ProjectFragmentMaterialStateV1,
  input: Readonly<{ entityId: string; sceneId: string; shaderId: string }>,
): ProjectFragmentMaterialStateV1 {
  const activeMaterial = state.registry.materials.find(({ shaderId }) => shaderId === input.shaderId);
  if (!activeMaterial) throw new Error("The material no longer exists.");
  const assignmentsByScene = { ...state.assignmentsByScene };
  assignmentsByScene[input.sceneId] = {
    ...assignmentsByScene[input.sceneId],
    [input.entityId]: {
      parameters: state.parameterSchemasByShaderId[activeMaterial.shaderId]?.map((parameter) => parameter.default) ?? [
        0.35, 8,
      ],
      revision: activeMaterial.revision,
      shaderId: activeMaterial.shaderId,
    },
  };
  return parseProjectFragmentMaterialState({
    assignmentsByScene,
    glslSourcesByShaderId: state.glslSourcesByShaderId,
    namesByShaderId: state.namesByShaderId,
    parameterSchemasByShaderId: state.parameterSchemasByShaderId,
    registry: state.registry,
  });
}

export function updateStudioFragmentMaterialParameterV1(
  state: ProjectFragmentMaterialStateV1,
  input: Readonly<{ entityId: string; name: string; sceneId: string; value: number }>,
): ProjectFragmentMaterialStateV1 {
  const assignment = state.assignmentsByScene[input.sceneId]?.[input.entityId];
  if (!assignment) throw new Error("The selected object no longer has a material.");
  const parameterSchema = state.parameterSchemasByShaderId[assignment.shaderId];
  if (!parameterSchema) throw new Error("This material does not declare editable parameters.");
  const parameterIndex = parameterSchema.findIndex((parameter) => parameter.name === input.name);
  if (parameterIndex < 0) throw new Error("The material parameter no longer exists.");
  const parameter = parameterSchema[parameterIndex];
  if (!parameter || !Number.isFinite(input.value) || Math.abs(input.value) > MAX_FINITE_F32) {
    throw new Error("The material parameter must be a finite f32 value.");
  }
  if (input.value < parameter.range.min || input.value > parameter.range.max) {
    throw new Error(`${parameter.name} must be between ${parameter.range.min} and ${parameter.range.max}.`);
  }
  const parameters = [...assignment.parameters];
  parameters[parameterIndex] = input.value;
  return parseProjectFragmentMaterialState({
    ...state,
    assignmentsByScene: {
      ...state.assignmentsByScene,
      [input.sceneId]: {
        ...state.assignmentsByScene[input.sceneId],
        [input.entityId]: { ...assignment, parameters },
      },
    },
  });
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
    glslSourcesByShaderId: state.glslSourcesByShaderId,
    namesByShaderId: state.namesByShaderId,
    parameterSchemasByShaderId: state.parameterSchemasByShaderId,
    registry: state.registry,
  };
}

export function projectFragmentMaterialsForSceneV1(
  state: ProjectFragmentMaterialStateV1,
  sceneId: string | null,
): SceneFragmentMaterialStateV1 {
  if (sceneId === null) return EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1;
  const assignments = state.assignmentsByScene[sceneId] ?? EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1.assignments;
  const referencedMaterials = new Set(
    Object.values(assignments).map((assignment) => `${assignment.shaderId}\0${assignment.revision}`),
  );
  return {
    assignments,
    registry:
      referencedMaterials.size > 0
        ? {
            ...state.registry,
            materials: state.registry.materials.filter((material) =>
              referencedMaterials.has(`${material.shaderId}\0${material.revision}`),
            ),
          }
        : EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
  };
}

export function sceneHasFragmentMaterialAssignmentsV1(state: SceneFragmentMaterialStateV1) {
  return Object.keys(state.assignments).length > 0;
}

export function studioFragmentMaterialCompileErrorV1(
  state: SceneFragmentMaterialStateV1,
  rendererState: PreviewRendererHostStateV1 | null | undefined,
) {
  if (!sceneHasFragmentMaterialAssignmentsV1(state) || rendererState?.phase !== "fallback") return null;
  return rendererState.reason === "renderer-failed" ||
    rendererState.reason === "install-failed" ||
    rendererState.reason === "scene-unsupported"
    ? rendererState.detail
    : null;
}
