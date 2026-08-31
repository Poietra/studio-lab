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

const scenePostEffectF32ParameterSchemaV1 = z
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

const unitF32Schema = finiteF32V1Schema.min(0).max(1);
const scenePostEffectRgbParameterSchemaV1 = z
  .object({
    default: z.tuple([unitF32Schema, unitF32Schema, unitF32Schema]),
    name: parameterNameSchema,
    type: z.literal("rgb"),
  })
  .strict();

export const scenePostEffectParameterSchemaListV1 = z
  .array(z.discriminatedUnion("type", [scenePostEffectF32ParameterSchemaV1, scenePostEffectRgbParameterSchemaV1]))
  .max(MAX_FRAGMENT_MATERIAL_PARAMETERS_V1)
  .superRefine((parameters, context) => {
    if (studioScenePostEffectParameterLayoutV1(parameters).defaults.length > MAX_FRAGMENT_MATERIAL_PARAMETERS_V1) {
      context.addIssue({
        code: "custom",
        message: `Parameter schema accepts at most ${MAX_FRAGMENT_MATERIAL_PARAMETERS_V1} scalar values.`,
      });
    }
    const names = new Set<string>();
    for (const [index, parameter] of parameters.entries()) {
      const folded = parameter.name.toLowerCase();
      if (names.has(folded)) {
        context.addIssue({ code: "custom", message: "Parameter names must be unique.", path: [index, "name"] });
      }
      names.add(folded);
    }
  });

export type StudioScenePostEffectF32ParameterV1 = z.infer<typeof scenePostEffectF32ParameterSchemaV1>;
export type StudioScenePostEffectRgbV1 = readonly [number, number, number];
export type StudioScenePostEffectRgbParameterV1 = z.infer<typeof scenePostEffectRgbParameterSchemaV1>;
export type StudioScenePostEffectParameterV1 =
  | StudioScenePostEffectF32ParameterV1
  | StudioScenePostEffectRgbParameterV1;

export function studioScenePostEffectParameterLayoutV1(schema: readonly StudioScenePostEffectParameterV1[]) {
  const defaults: number[] = [];
  const entries: Readonly<{ offset: number; parameter: StudioScenePostEffectParameterV1 }>[] = [];
  for (const parameter of schema) {
    entries.push({ offset: defaults.length, parameter });
    if (parameter.type === "f32") defaults.push(parameter.default);
    else defaults.push(...parameter.default);
  }
  return { defaults, entries } as const;
}

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

export const STUDIO_VIGNETTE_POST_EFFECT_SOURCE_V1 =
  scenePostEffectWgslSourceV1Schema.parse(`struct ScenePostEffectHost {
    viewport_and_time: vec4<f32>,
    // x = strength, y = softness.
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: ScenePostEffectHost;

@group(0) @binding(1)
var scene_texture: texture_2d<f32>;

@group(0) @binding(2)
var scene_sampler: sampler;

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let viewport = max(host.viewport_and_time.xy, vec2<f32>(1.0));
    let coordinate = position.xy / viewport;
    let color = textureSample(scene_texture, scene_sampler, coordinate);
    let distance_from_center = length((coordinate - vec2<f32>(0.5)) * 2.0);
    let strength = clamp(host.parameters_0.x, 0.0, 1.0);
    let softness = clamp(host.parameters_0.y, 0.05, 1.0);
    let edge = smoothstep(1.0 - softness, 1.0, distance_from_center);
    return vec4<f32>(color.rgb * (1.0 - strength * edge), color.a);
}
`);

export const STUDIO_VIGNETTE_POST_EFFECT_PARAMETERS_V1 = scenePostEffectParameterSchemaListV1.parse([
  {
    default: 0.55,
    name: "Strength",
    range: { max: 1, min: 0, step: 0.05 },
    type: "f32",
  },
  {
    default: 0.45,
    name: "Softness",
    range: { max: 1, min: 0.05, step: 0.05 },
    type: "f32",
  },
]);

export const STUDIO_COLOR_TINT_POST_EFFECT_SOURCE_V1 =
  scenePostEffectWgslSourceV1Schema.parse(`struct ScenePostEffectHost {
    viewport_and_time: vec4<f32>,
    // xyz = tint color, w = mix.
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: ScenePostEffectHost;

@group(0) @binding(1)
var scene_texture: texture_2d<f32>;

@group(0) @binding(2)
var scene_sampler: sampler;

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let viewport = max(host.viewport_and_time.xy, vec2<f32>(1.0));
    let coordinate = position.xy / viewport;
    let color = textureSample(scene_texture, scene_sampler, coordinate);
    let tint = clamp(host.parameters_0.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
    let mix_amount = clamp(host.parameters_0.w, 0.0, 1.0);
    return vec4<f32>(mix(color.rgb, color.rgb * tint, mix_amount), color.a);
}
`);

export const STUDIO_COLOR_TINT_POST_EFFECT_PARAMETERS_V1 = scenePostEffectParameterSchemaListV1.parse([
  {
    default: [0.2, 0.55, 1],
    name: "Tint",
    type: "rgb",
  },
  {
    default: 0.4,
    name: "Mix",
    range: { max: 1, min: 0, step: 0.05 },
    type: "f32",
  },
]);

export const STUDIO_DUOTONE_POST_EFFECT_SOURCE_V1 =
  scenePostEffectWgslSourceV1Schema.parse(`struct ScenePostEffectHost {
    viewport_and_time: vec4<f32>,
    // p0.xyz = shadow, p0.w/p1.xy = highlight, p1.z = mix.
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: ScenePostEffectHost;

@group(0) @binding(1)
var scene_texture: texture_2d<f32>;

@group(0) @binding(2)
var scene_sampler: sampler;

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let viewport = max(host.viewport_and_time.xy, vec2<f32>(1.0));
    let coordinate = position.xy / viewport;
    let color = textureSample(scene_texture, scene_sampler, coordinate);
    let straight_rgb = clamp(
        color.rgb / max(color.a, 0.000001),
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    );
    let luminance = dot(straight_rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    let shadow = clamp(host.parameters_0.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
    let highlight = clamp(
        vec3<f32>(host.parameters_0.w, host.parameters_1.x, host.parameters_1.y),
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    );
    let mix_amount = clamp(host.parameters_1.z, 0.0, 1.0);
    let duotone = mix(shadow, highlight, luminance);
    return vec4<f32>(mix(color.rgb, duotone * color.a, mix_amount), color.a);
}
`);

export const STUDIO_DUOTONE_POST_EFFECT_PARAMETERS_V1 = scenePostEffectParameterSchemaListV1.parse([
  {
    default: [0.05, 0.1, 0.3],
    name: "Shadow",
    type: "rgb",
  },
  {
    default: [1, 0.72, 0.25],
    name: "Highlight",
    type: "rgb",
  },
  {
    default: 1,
    name: "Mix",
    range: { max: 1, min: 0, step: 0.05 },
    type: "f32",
  },
]);

export const STUDIO_SOFT_BLUR_POST_EFFECT_SOURCE_V1 =
  scenePostEffectWgslSourceV1Schema.parse(`struct ScenePostEffectHost {
    viewport_and_time: vec4<f32>,
    // x = radius in pixels, y = mix.
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: ScenePostEffectHost;

@group(0) @binding(1)
var scene_texture: texture_2d<f32>;

@group(0) @binding(2)
var scene_sampler: sampler;

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let viewport = max(host.viewport_and_time.xy, vec2<f32>(1.0));
    let coordinate = position.xy / viewport;
    let center = textureSample(scene_texture, scene_sampler, coordinate);
    let radius = clamp(host.parameters_0.x, 0.0, 16.0);
    if radius == 0.0 {
        return center;
    }

    let offset = vec2<f32>(radius) / viewport;
    let minimum_coordinate = vec2<f32>(0.5) / viewport;
    let maximum_coordinate = vec2<f32>(1.0) - minimum_coordinate;
    let top_left = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate + offset * vec2<f32>(-1.0, -1.0), minimum_coordinate, maximum_coordinate),
    );
    let top = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate + offset * vec2<f32>(0.0, -1.0), minimum_coordinate, maximum_coordinate),
    );
    let top_right = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate + offset * vec2<f32>(1.0, -1.0), minimum_coordinate, maximum_coordinate),
    );
    let left = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate + offset * vec2<f32>(-1.0, 0.0), minimum_coordinate, maximum_coordinate),
    );
    let right = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate + offset * vec2<f32>(1.0, 0.0), minimum_coordinate, maximum_coordinate),
    );
    let bottom_left = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate + offset * vec2<f32>(-1.0, 1.0), minimum_coordinate, maximum_coordinate),
    );
    let bottom = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate + offset * vec2<f32>(0.0, 1.0), minimum_coordinate, maximum_coordinate),
    );
    let bottom_right = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate + offset * vec2<f32>(1.0, 1.0), minimum_coordinate, maximum_coordinate),
    );
    let blurred = (
        center * 4.0 +
        (top + left + right + bottom) * 2.0 +
        top_left + top_right + bottom_left + bottom_right
    ) / 16.0;
    let mix_amount = clamp(host.parameters_0.y, 0.0, 1.0);
    return mix(center, blurred, mix_amount);
}
`);

export const STUDIO_SOFT_BLUR_POST_EFFECT_PARAMETERS_V1 = scenePostEffectParameterSchemaListV1.parse([
  {
    default: 4,
    name: "Radius (px)",
    range: { max: 16, min: 0, step: 1 },
    type: "f32",
  },
  {
    default: 1,
    name: "Mix",
    range: { max: 1, min: 0, step: 0.05 },
    type: "f32",
  },
]);

export const STUDIO_PIXELATE_POST_EFFECT_SOURCE_V1 =
  scenePostEffectWgslSourceV1Schema.parse(`struct ScenePostEffectHost {
    viewport_and_time: vec4<f32>,
    // x = block size in pixels.
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: ScenePostEffectHost;

@group(0) @binding(1)
var scene_texture: texture_2d<f32>;

@group(0) @binding(2)
var scene_sampler: sampler;

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let viewport = max(host.viewport_and_time.xy, vec2<f32>(1.0));
    let block_size = max(host.parameters_0.x, 1.0);
    let texel_center = floor(block_size * 0.5) + 0.5;
    let block_center = floor(position.xy / block_size) * block_size + vec2<f32>(texel_center);
    let sample_pixel = clamp(block_center, vec2<f32>(0.5), viewport - vec2<f32>(0.5));
    return textureSample(scene_texture, scene_sampler, sample_pixel / viewport);
}
`);

export const STUDIO_PIXELATE_POST_EFFECT_PARAMETERS_V1 = scenePostEffectParameterSchemaListV1.parse([
  {
    default: 16,
    name: "Block size",
    range: { max: 128, min: 1, step: 1 },
    type: "f32",
  },
]);

export const STUDIO_CHROMATIC_SHIFT_POST_EFFECT_SOURCE_V1 =
  scenePostEffectWgslSourceV1Schema.parse(`struct ScenePostEffectHost {
    viewport_and_time: vec4<f32>,
    // x = horizontal channel offset in pixels.
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: ScenePostEffectHost;

@group(0) @binding(1)
var scene_texture: texture_2d<f32>;

@group(0) @binding(2)
var scene_sampler: sampler;

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let viewport = max(host.viewport_and_time.xy, vec2<f32>(1.0));
    let coordinate = position.xy / viewport;
    let pixel_offset = max(host.parameters_0.x, 0.0);
    let channel_offset = vec2<f32>(pixel_offset / viewport.x, 0.0);
    let minimum_coordinate = vec2<f32>(0.5) / viewport;
    let maximum_coordinate = vec2<f32>(1.0) - minimum_coordinate;
    let center = textureSample(scene_texture, scene_sampler, coordinate);
    let red = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate + channel_offset, minimum_coordinate, maximum_coordinate),
    ).r;
    let blue = textureSample(
        scene_texture,
        scene_sampler,
        clamp(coordinate - channel_offset, minimum_coordinate, maximum_coordinate),
    ).b;
    return vec4<f32>(red, center.g, blue, center.a);
}
`);

export const STUDIO_CHROMATIC_SHIFT_POST_EFFECT_PARAMETERS_V1 = scenePostEffectParameterSchemaListV1.parse([
  {
    default: 6,
    name: "Pixel offset",
    range: { max: 64, min: 0, step: 1 },
    type: "f32",
  },
]);

export const studioScenePostEffectPresetIdSchema = z.enum([
  "wave-distortion",
  "vignette",
  "color-tint",
  "duotone",
  "soft-blur",
  "pixelate",
  "chromatic-shift",
]);
export type StudioScenePostEffectPresetId = z.infer<typeof studioScenePostEffectPresetIdSchema>;

export const STUDIO_SCENE_POST_EFFECT_PRESETS: readonly Readonly<{
  id: StudioScenePostEffectPresetId;
  name: string;
  parameterSchema: StudioScenePostEffectParameterSchemaV1;
  source: string;
}>[] = [
  {
    id: "wave-distortion",
    name: "Wave Distortion",
    parameterSchema: STUDIO_WAVE_DISTORTION_POST_EFFECT_PARAMETERS_V1,
    source: STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
  },
  {
    id: "vignette",
    name: "Vignette",
    parameterSchema: STUDIO_VIGNETTE_POST_EFFECT_PARAMETERS_V1,
    source: STUDIO_VIGNETTE_POST_EFFECT_SOURCE_V1,
  },
  {
    id: "color-tint",
    name: "Color Tint",
    parameterSchema: STUDIO_COLOR_TINT_POST_EFFECT_PARAMETERS_V1,
    source: STUDIO_COLOR_TINT_POST_EFFECT_SOURCE_V1,
  },
  {
    id: "duotone",
    name: "Duotone",
    parameterSchema: STUDIO_DUOTONE_POST_EFFECT_PARAMETERS_V1,
    source: STUDIO_DUOTONE_POST_EFFECT_SOURCE_V1,
  },
  {
    id: "soft-blur",
    name: "Soft Blur",
    parameterSchema: STUDIO_SOFT_BLUR_POST_EFFECT_PARAMETERS_V1,
    source: STUDIO_SOFT_BLUR_POST_EFFECT_SOURCE_V1,
  },
  {
    id: "pixelate",
    name: "Pixelate",
    parameterSchema: STUDIO_PIXELATE_POST_EFFECT_PARAMETERS_V1,
    source: STUDIO_PIXELATE_POST_EFFECT_SOURCE_V1,
  },
  {
    id: "chromatic-shift",
    name: "Chromatic Shift",
    parameterSchema: STUDIO_CHROMATIC_SHIFT_POST_EFFECT_PARAMETERS_V1,
    source: STUDIO_CHROMATIC_SHIFT_POST_EFFECT_SOURCE_V1,
  },
];

export function studioScenePostEffectPreset(presetId: StudioScenePostEffectPresetId) {
  const id = studioScenePostEffectPresetIdSchema.parse(presetId);
  const preset = STUDIO_SCENE_POST_EFFECT_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown Scene post-effect preset: ${id}`);
  return preset;
}

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
  input: Readonly<{ name: string; presetId?: StudioScenePostEffectPresetId }>,
): Readonly<{ revision: number; state: ProjectScenePostEffectLibraryState }> {
  const current = parseState(state);
  if (current.assets.length >= MAX_PROJECT_SCENE_POST_EFFECT_ASSETS) {
    throw new Error(`A project accepts at most ${MAX_PROJECT_SCENE_POST_EFFECT_ASSETS} Scene post-effect assets.`);
  }
  const name = scenePostEffectAssetNameSchema.parse(input.name);
  const preset = studioScenePostEffectPreset(input.presetId ?? "wave-distortion");
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
          parameterSchema: preset.parameterSchema,
          source: preset.source,
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
  if (currentAccepted && currentAccepted.textureSlot !== textureSlot) {
    throw new Error(
      "A Scene post-effect texture-slot contract is immutable after its first acceptance. Create a new effect to change it.",
    );
  }
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
  const layout = studioScenePostEffectParameterLayoutV1(accepted.parameterSchema);
  const values = parameters ? [...parameters] : layout.defaults;
  if (values.length !== layout.defaults.length) {
    throw new Error("The Scene post effect must contain every declared parameter value.");
  }
  for (const { offset, parameter } of layout.entries) {
    const width = parameter.type === "f32" ? 1 : 3;
    for (let component = 0; component < width; component += 1) {
      const value = values[offset + component];
      finiteF32V1Schema.parse(value);
      if (parameter.type === "f32" && (value! < parameter.range.min || value! > parameter.range.max)) {
        throw new Error(`${parameter.name} must be between ${parameter.range.min} and ${parameter.range.max}.`);
      }
      if (parameter.type === "rgb" && (value! < 0 || value! > 1)) {
        throw new Error(`${parameter.name} RGB components must be between 0 and 1.`);
      }
    }
  }
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
