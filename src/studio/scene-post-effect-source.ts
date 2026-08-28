import { z } from "zod";

import {
  finiteF32V1Schema,
  MAX_FRAGMENT_MATERIAL_PARAMETERS_V1,
  type ScenePostEffectV1,
  scenePostEffectV1Schema,
} from "../engine/primitives";
import {
  MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
  scenePostEffectWgslSourceV1Schema,
} from "../engine/scene-post-effect-registry";

export { MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1, PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 };

const diagnosticSchema = z.string().min(1).max(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1);
const parameterNameSchema = z
  .string()
  .min(1)
  .max(40)
  .refine((name) => name === name.trim(), "Parameter names must not have surrounding whitespace.")
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "Parameter names must not contain control characters.");

const scenePostEffectParameterSchemaV1 = z
  .object({
    default: finiteF32V1Schema,
    name: parameterNameSchema,
    range: z
      .object({
        max: finiteF32V1Schema,
        min: finiteF32V1Schema,
        step: finiteF32V1Schema.positive(),
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

export const scenePostEffectParameterSchemaListV1 = z
  .array(scenePostEffectParameterSchemaV1)
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

const acceptedScenePostEffectSourceSchemaV1 = z
  .object({
    generation: z.number().int().positive().max(0xffff_ffff),
    parameterSchema: scenePostEffectParameterSchemaListV1,
    shaderId: z.literal(PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1),
    source: scenePostEffectWgslSourceV1Schema,
  })
  .strict();

const scenePostEffectSourceDraftSchemaV1 = z
  .object({
    diagnostic: diagnosticSchema.nullable(),
    parameterSchema: scenePostEffectParameterSchemaListV1,
    source: scenePostEffectWgslSourceV1Schema,
  })
  .strict();

const scenePostEffectSourceAssetSchemaV1 = z
  .object({
    accepted: acceptedScenePostEffectSourceSchemaV1.nullable(),
    draft: scenePostEffectSourceDraftSchemaV1,
  })
  .strict();

export const projectScenePostEffectSourceStateV1Schema = z
  .object({
    asset: scenePostEffectSourceAssetSchemaV1.nullable(),
    schema: z.literal("poietra.scene-post-effect-source-state"),
    version: z.literal(1),
  })
  .strict();

export type StudioScenePostEffectParameterV1 = z.infer<typeof scenePostEffectParameterSchemaV1>;
export type StudioScenePostEffectParameterSchemaV1 = z.infer<typeof scenePostEffectParameterSchemaListV1>;
export type StudioAcceptedScenePostEffectSourceV1 = z.infer<typeof acceptedScenePostEffectSourceSchemaV1>;
export type StudioScenePostEffectSourceDraftV1 = z.infer<typeof scenePostEffectSourceDraftSchemaV1>;
export type StudioScenePostEffectSourceAssetV1 = z.infer<typeof scenePostEffectSourceAssetSchemaV1>;
export type ProjectScenePostEffectSourceStateV1 = z.infer<typeof projectScenePostEffectSourceStateV1Schema>;

/**
 * Fragment-only starter for the fixed Scene post-effect host ABI.
 * The fullscreen vertex stage remains renderer-owned.
 */
export const STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1 = STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1;

export const STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1 = scenePostEffectParameterSchemaListV1.parse([
  {
    default: 12,
    name: "Amplitude",
    range: { max: 64, min: 0, step: 1 },
    type: "f32",
  },
  {
    default: 64,
    name: "Wavelength",
    range: { max: 512, min: 8, step: 4 },
    type: "f32",
  },
  {
    default: 0.75,
    name: "Speed",
    range: { max: 4, min: -4, step: 0.05 },
    type: "f32",
  },
]);

export const EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1: ProjectScenePostEffectSourceStateV1 = Object.freeze({
  asset: null,
  schema: "poietra.scene-post-effect-source-state",
  version: 1,
});

function parseState(state: ProjectScenePostEffectSourceStateV1) {
  return projectScenePostEffectSourceStateV1Schema.parse(state);
}

function requireAsset(state: ProjectScenePostEffectSourceStateV1) {
  if (!state.asset) throw new Error("The custom Scene post effect does not exist.");
  return state.asset;
}

function sameParameterSchema(
  left: StudioScenePostEffectParameterSchemaV1,
  right: StudioScenePostEffectParameterSchemaV1,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createStudioScenePostEffectSourceV1(
  state: ProjectScenePostEffectSourceStateV1,
): ProjectScenePostEffectSourceStateV1 {
  if (state.asset) throw new Error("A project accepts exactly one custom Scene post effect.");
  return parseState({
    ...state,
    asset: {
      accepted: null,
      draft: {
        diagnostic: null,
        parameterSchema: STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1,
        source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
      },
    },
  });
}

export function acceptStudioScenePostEffectSourceV1(
  state: ProjectScenePostEffectSourceStateV1,
  input: Readonly<{
    parameterSchema: StudioScenePostEffectParameterSchemaV1;
    source: string;
  }>,
): ProjectScenePostEffectSourceStateV1 {
  const asset = requireAsset(state);
  const parameterSchema = scenePostEffectParameterSchemaListV1.parse(input.parameterSchema);
  const source = scenePostEffectWgslSourceV1Schema.parse(input.source);
  const currentAccepted = asset.accepted;
  const generation =
    currentAccepted?.source === source && sameParameterSchema(currentAccepted.parameterSchema, parameterSchema)
      ? currentAccepted.generation
      : (currentAccepted?.generation ?? 0) + 1;
  if (generation > 0xffff_ffff) throw new Error("The custom Scene post-effect generation is exhausted.");
  const accepted = acceptedScenePostEffectSourceSchemaV1.parse({
    generation,
    parameterSchema,
    shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
    source,
  });
  return parseState({
    ...state,
    asset: {
      accepted,
      draft: { diagnostic: null, parameterSchema, source },
    },
  });
}

export function rejectStudioScenePostEffectSourceV1(
  state: ProjectScenePostEffectSourceStateV1,
  input: Readonly<{
    diagnostic: string;
    parameterSchema: StudioScenePostEffectParameterSchemaV1;
    source: string;
  }>,
): ProjectScenePostEffectSourceStateV1 {
  const asset = requireAsset(state);
  return parseState({
    ...state,
    asset: {
      accepted: asset.accepted,
      draft: {
        diagnostic: input.diagnostic,
        parameterSchema: input.parameterSchema,
        source: input.source,
      },
    },
  });
}

export function removeStudioScenePostEffectSourceV1(
  state: ProjectScenePostEffectSourceStateV1,
): ProjectScenePostEffectSourceStateV1 {
  const asset = requireAsset(state);
  if (asset.accepted) {
    throw new Error("An accepted custom Scene post effect remains a project asset so Undo and Redo can resolve it.");
  }
  return { ...EMPTY_PROJECT_SCENE_POST_EFFECT_SOURCE_STATE_V1 };
}

/** Projection consumed by the separate renderer registry wire contract. */
export function acceptedStudioScenePostEffectRegistrySourceV1(state: ProjectScenePostEffectSourceStateV1) {
  const accepted = state.asset?.accepted;
  return accepted ? { revision: 1, shaderId: accepted.shaderId, source: accepted.source } : null;
}

/** Creates the source-free Scene IR reference from the accepted asset. */
export function acceptedStudioScenePostEffectReferenceV1(
  state: ProjectScenePostEffectSourceStateV1,
  parameters?: readonly number[],
): ScenePostEffectV1 | null {
  const accepted = state.asset?.accepted;
  if (!accepted) return null;
  const values = parameters ? [...parameters] : accepted.parameterSchema.map((parameter) => parameter.default);
  if (values.length !== accepted.parameterSchema.length) {
    throw new Error("The Scene post effect must contain every declared parameter value.");
  }
  values.forEach((value, index) => {
    const parameter = accepted.parameterSchema[index]!;
    finiteF32V1Schema.parse(value);
    if (value < parameter.range.min || value > parameter.range.max) {
      throw new Error(`${parameter.name} must be between ${parameter.range.min} and ${parameter.range.max}.`);
    }
  });
  return scenePostEffectV1Schema.parse({
    parameters: values,
    revision: 1,
    shaderId: accepted.shaderId,
  });
}
