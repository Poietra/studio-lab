import { z } from "zod";

import {
  finiteF32V1Schema,
  MAX_FRAGMENT_MATERIAL_PARAMETERS_V1,
  type SampledTextureV1,
  type ScenePostEffectV1,
  sampledTextureV1Schema,
  scenePostEffectV1Schema,
} from "../engine/primitives";
import {
  MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
  scenePostEffectWgslSourceV1Schema,
} from "../engine/scene-post-effect-registry";

export { MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1, PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 };

export const MAX_PROJECT_SCENE_POST_EFFECT_ASSETS = 8;
const MAX_SCENE_POST_EFFECT_ASSET_REVISION = 0xffff_ffff;

const diagnosticSchema = z.string().min(1).max(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1);
export const scenePostEffectSourceLanguageV1Schema = z.enum(["wgsl", "glsl"]);
const scenePostEffectEditableSourceV1Schema = z
  .string()
  .min(1, "Shader source must not be empty.")
  .refine(
    (source) => new TextEncoder().encode(source).byteLength <= MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
    `Scene post-effect source accepts at most ${MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1} UTF-8 bytes.`,
  );
const parameterNameSchema = z
  .string()
  .min(1)
  .max(40)
  .refine((name) => name === name.trim(), "Parameter names must not have surrounding whitespace.")
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "Parameter names must not contain control characters.");
const scenePostEffectAssetNameSchema = z
  .string()
  .min(1, "Effect name must not be empty.")
  .max(80)
  .refine((name) => name === name.trim(), "Effect name must not have surrounding whitespace.")
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "Effect name must not contain control characters.");
const scenePostEffectAssetRevisionSchema = z.number().int().positive().max(MAX_SCENE_POST_EFFECT_ASSET_REVISION);

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
    originalGlslSource: scenePostEffectEditableSourceV1Schema.optional(),
    parameterSchema: scenePostEffectParameterSchemaListV1,
    shaderId: z.literal(PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1),
    /** Canonical WGSL consumed by the renderer registry for every source language. */
    source: scenePostEffectWgslSourceV1Schema,
    textureSlot: z.literal("texture2d").optional(),
  })
  .strict();

const scenePostEffectSourceDraftSchemaV1 = z
  .object({
    diagnostic: diagnosticSchema.nullable(),
    parameterSchema: scenePostEffectParameterSchemaListV1,
    source: scenePostEffectEditableSourceV1Schema,
    sourceLanguage: scenePostEffectSourceLanguageV1Schema.default("wgsl"),
    textureSlot: z.literal("texture2d").optional(),
  })
  .strict();

const scenePostEffectSourceAssetSchemaV1 = z
  .object({
    accepted: acceptedScenePostEffectSourceSchemaV1.nullable(),
    draft: scenePostEffectSourceDraftSchemaV1,
    name: scenePostEffectAssetNameSchema,
    revision: scenePostEffectAssetRevisionSchema,
  })
  .strict();

const canonicalProjectScenePostEffectLibraryStateSchema = z
  .object({
    assets: z.array(scenePostEffectSourceAssetSchemaV1).max(MAX_PROJECT_SCENE_POST_EFFECT_ASSETS),
    nextAssetRevision: z
      .number()
      .int()
      .positive()
      .max(MAX_SCENE_POST_EFFECT_ASSET_REVISION + 1),
    schema: z.literal("poietra.scene-post-effect-library-state"),
    version: z.literal(1),
  })
  .strict()
  .superRefine((state, context) => {
    const revisions = new Set<number>();
    for (const [index, asset] of state.assets.entries()) {
      if (revisions.has(asset.revision)) {
        context.addIssue({
          code: "custom",
          message: "Effect asset revisions must be unique.",
          path: ["assets", index, "revision"],
        });
      }
      revisions.add(asset.revision);
      if (asset.revision >= state.nextAssetRevision) {
        context.addIssue({
          code: "custom",
          message: "The next effect asset revision must be newer than every asset.",
          path: ["nextAssetRevision"],
        });
      }
    }
  });

const legacyProjectScenePostEffectSourceStateSchema = z
  .object({
    asset: z
      .object({
        accepted: acceptedScenePostEffectSourceSchemaV1.nullable(),
        draft: scenePostEffectSourceDraftSchemaV1,
      })
      .strict()
      .nullable(),
    schema: z.literal("poietra.scene-post-effect-source-state"),
    version: z.literal(1),
  })
  .strict();

/** Parses the canonical library and migrates the former singleton state in memory. */
export const projectScenePostEffectLibraryStateSchema = z
  .union([canonicalProjectScenePostEffectLibraryStateSchema, legacyProjectScenePostEffectSourceStateSchema])
  .transform((state) => {
    if (state.schema === "poietra.scene-post-effect-library-state") return state;
    return canonicalProjectScenePostEffectLibraryStateSchema.parse({
      assets: state.asset ? [{ ...state.asset, name: "Custom Scene effect", revision: 1 }] : [],
      nextAssetRevision: state.asset ? 2 : 1,
      schema: "poietra.scene-post-effect-library-state",
      version: 1,
    });
  });

export type StudioScenePostEffectParameterV1 = z.infer<typeof scenePostEffectParameterSchemaV1>;
export type StudioScenePostEffectParameterSchemaV1 = z.infer<typeof scenePostEffectParameterSchemaListV1>;
export type StudioScenePostEffectSourceLanguageV1 = z.infer<typeof scenePostEffectSourceLanguageV1Schema>;
export type StudioScenePostEffectTextureV1 = SampledTextureV1;
export type StudioAcceptedScenePostEffectSourceV1 = z.infer<typeof acceptedScenePostEffectSourceSchemaV1>;
export type StudioScenePostEffectSourceDraftV1 = z.infer<typeof scenePostEffectSourceDraftSchemaV1>;
export type StudioScenePostEffectSourceAssetV1 = z.infer<typeof scenePostEffectSourceAssetSchemaV1>;
export type ProjectScenePostEffectLibraryState = z.output<typeof projectScenePostEffectLibraryStateSchema>;

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

export const EMPTY_PROJECT_SCENE_POST_EFFECT_LIBRARY_STATE: ProjectScenePostEffectLibraryState = Object.freeze({
  assets: [],
  nextAssetRevision: 1,
  schema: "poietra.scene-post-effect-library-state",
  version: 1,
});

function parseState(state: ProjectScenePostEffectLibraryState) {
  return projectScenePostEffectLibraryStateSchema.parse(state);
}

function requireAsset(state: ProjectScenePostEffectLibraryState, assetRevision: number) {
  const revision = scenePostEffectAssetRevisionSchema.parse(assetRevision);
  const asset = state.assets.find((candidate) => candidate.revision === revision);
  if (!asset) throw new Error(`Scene post-effect asset revision ${revision} does not exist.`);
  return asset;
}

function sameParameterSchema(
  left: StudioScenePostEffectParameterSchemaV1,
  right: StudioScenePostEffectParameterSchemaV1,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createStudioScenePostEffectSourceV1(
  state: ProjectScenePostEffectLibraryState,
  input: Readonly<{ name: string }>,
): Readonly<{ revision: number; state: ProjectScenePostEffectLibraryState }> {
  const current = parseState(state);
  if (current.assets.length >= MAX_PROJECT_SCENE_POST_EFFECT_ASSETS) {
    throw new Error(`A project accepts at most ${MAX_PROJECT_SCENE_POST_EFFECT_ASSETS} Scene post-effect assets.`);
  }
  const name = scenePostEffectAssetNameSchema.parse(input.name);
  if (current.nextAssetRevision > MAX_SCENE_POST_EFFECT_ASSET_REVISION) {
    throw new Error("The Scene post-effect asset revision space is exhausted.");
  }
  const revision = current.nextAssetRevision;
  const nextState = parseState({
    ...current,
    assets: [
      ...current.assets,
      {
        accepted: null,
        draft: {
          diagnostic: null,
          parameterSchema: STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1,
          source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
          sourceLanguage: "wgsl",
        },
        name,
        revision,
      },
    ],
    nextAssetRevision: revision + 1,
  });
  return { revision, state: nextState };
}

export function listStudioScenePostEffectSourcesV1(
  state: ProjectScenePostEffectLibraryState,
): readonly StudioScenePostEffectSourceAssetV1[] {
  return parseState(state).assets;
}

export function findStudioScenePostEffectSourceV1(
  state: ProjectScenePostEffectLibraryState,
  assetRevision: number,
): StudioScenePostEffectSourceAssetV1 | null {
  const revision = scenePostEffectAssetRevisionSchema.parse(assetRevision);
  return parseState(state).assets.find((asset) => asset.revision === revision) ?? null;
}

export function acceptStudioScenePostEffectSourceV1(
  state: ProjectScenePostEffectLibraryState,
  assetRevision: number,
  input: Readonly<{
    canonicalWgslSource?: string;
    parameterSchema: StudioScenePostEffectParameterSchemaV1;
    source: string;
    sourceLanguage?: StudioScenePostEffectSourceLanguageV1;
    textureSlot?: "texture2d";
  }>,
): ProjectScenePostEffectLibraryState {
  const current = parseState(state);
  const asset = requireAsset(current, assetRevision);
  const parameterSchema = scenePostEffectParameterSchemaListV1.parse(input.parameterSchema);
  const sourceLanguage = scenePostEffectSourceLanguageV1Schema.parse(input.sourceLanguage ?? "wgsl");
  const draftSource = scenePostEffectEditableSourceV1Schema.parse(input.source);
  if (sourceLanguage === "glsl" && input.canonicalWgslSource === undefined) {
    throw new Error("Accepted GLSL requires the canonical WGSL emitted by the Rust core.");
  }
  const source = scenePostEffectWgslSourceV1Schema.parse(
    sourceLanguage === "glsl" ? input.canonicalWgslSource : draftSource,
  );
  const originalGlslSource = sourceLanguage === "glsl" ? draftSource : undefined;
  const textureSlot = input.textureSlot;
  const currentAccepted = asset.accepted;
  const generation =
    currentAccepted?.source === source &&
    currentAccepted.originalGlslSource === originalGlslSource &&
    currentAccepted.textureSlot === textureSlot &&
    sameParameterSchema(currentAccepted.parameterSchema, parameterSchema)
      ? currentAccepted.generation
      : (currentAccepted?.generation ?? 0) + 1;
  if (generation > 0xffff_ffff) throw new Error("The custom Scene post-effect generation is exhausted.");
  const accepted = acceptedScenePostEffectSourceSchemaV1.parse({
    generation,
    ...(originalGlslSource === undefined ? {} : { originalGlslSource }),
    parameterSchema,
    shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
    source,
    ...(textureSlot ? { textureSlot } : {}),
  });
  return parseState({
    ...current,
    assets: current.assets.map((candidate) =>
      candidate.revision === asset.revision
        ? {
            ...candidate,
            accepted,
            draft: {
              diagnostic: null,
              parameterSchema,
              source: draftSource,
              sourceLanguage,
              ...(textureSlot ? { textureSlot } : {}),
            },
          }
        : candidate,
    ),
  });
}

export function rejectStudioScenePostEffectSourceV1(
  state: ProjectScenePostEffectLibraryState,
  assetRevision: number,
  input: Readonly<{
    diagnostic: string;
    parameterSchema: StudioScenePostEffectParameterSchemaV1;
    source: string;
    sourceLanguage?: StudioScenePostEffectSourceLanguageV1;
    textureSlot?: "texture2d";
  }>,
): ProjectScenePostEffectLibraryState {
  const current = parseState(state);
  const asset = requireAsset(current, assetRevision);
  const sourceLanguage = scenePostEffectSourceLanguageV1Schema.parse(input.sourceLanguage ?? "wgsl");
  return parseState({
    ...current,
    assets: current.assets.map((candidate) =>
      candidate.revision === asset.revision
        ? {
            ...candidate,
            accepted: asset.accepted,
            draft: {
              diagnostic: input.diagnostic,
              parameterSchema: input.parameterSchema,
              source: input.source,
              sourceLanguage,
              ...(input.textureSlot ? { textureSlot: input.textureSlot } : {}),
            },
          }
        : candidate,
    ),
  });
}

export function removeStudioScenePostEffectSourceV1(
  state: ProjectScenePostEffectLibraryState,
  assetRevision: number,
): ProjectScenePostEffectLibraryState {
  const current = parseState(state);
  const asset = requireAsset(current, assetRevision);
  if (asset.accepted) {
    throw new Error("An accepted custom Scene post effect remains a project asset so Undo and Redo can resolve it.");
  }
  return parseState({
    ...current,
    assets: current.assets.filter((candidate) => candidate.revision !== asset.revision),
  });
}

/** Projection consumed by the separate renderer registry wire contract. */
export function acceptedStudioScenePostEffectRegistrySourceV1(
  state: ProjectScenePostEffectLibraryState,
  assetRevision: number,
) {
  const asset = findStudioScenePostEffectSourceV1(state, assetRevision);
  const accepted = asset?.accepted;
  return accepted
    ? {
        revision: asset.revision,
        shaderId: accepted.shaderId,
        source: accepted.source,
        ...(accepted.textureSlot ? { textureSlot: accepted.textureSlot } : {}),
      }
    : null;
}

/** Creates the source-free Scene IR reference from the accepted asset. */
export function acceptedStudioScenePostEffectReferenceV1(
  state: ProjectScenePostEffectLibraryState,
  assetRevision: number,
  parameters?: readonly number[],
  texture?: StudioScenePostEffectTextureV1,
): ScenePostEffectV1 | null {
  const asset = findStudioScenePostEffectSourceV1(state, assetRevision);
  const accepted = asset?.accepted;
  if (!accepted) return null;
  if ((accepted.textureSlot === "texture2d") !== (texture !== undefined)) {
    throw new Error(
      accepted.textureSlot === "texture2d"
        ? "The Scene post effect requires one project texture assignment."
        : "The Scene post effect does not declare a texture slot.",
    );
  }
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
    revision: asset.revision,
    shaderId: accepted.shaderId,
    ...(texture ? { texture: sampledTextureV1Schema.parse(texture) } : {}),
  });
}

/** Rebuilds one accepted Scene reference while preserving its scalar parameters. */
export function updateStudioScenePostEffectReferenceTextureV1(
  state: ProjectScenePostEffectLibraryState,
  assetRevision: number,
  effect: ScenePostEffectV1,
  texture: StudioScenePostEffectTextureV1 | null,
): ScenePostEffectV1 {
  if (
    effect.shaderId !== PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 ||
    effect.revision !== scenePostEffectAssetRevisionSchema.parse(assetRevision)
  ) {
    throw new Error("The Scene post-effect reference does not belong to the selected project effect asset.");
  }
  const updated = acceptedStudioScenePostEffectReferenceV1(
    state,
    assetRevision,
    effect.parameters,
    texture ?? undefined,
  );
  if (!updated) throw new Error("The selected Scene post-effect source has not been accepted.");
  return updated;
}
