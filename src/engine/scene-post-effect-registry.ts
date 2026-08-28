import { z } from "zod";

export const MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 = 16 * 1024;
export const MAX_SCENE_POST_EFFECT_REGISTRY_JSON_BYTES_V1 = 20 * 1024;
export const PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 = "project-scene-post-effect";

export const scenePostEffectWgslSourceV1Schema = z
  .string()
  .min(1, "WGSL source must not be empty.")
  .refine(
    (source) => new TextEncoder().encode(source).byteLength <= MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
    `Scene post-effect WGSL accepts at most ${MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1} UTF-8 bytes.`,
  );

export const scenePostEffectSourceV1Schema = z
  .object({
    revision: z.number().int().positive().max(0xffff_ffff),
    shaderId: z.literal(PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1),
    source: scenePostEffectWgslSourceV1Schema,
  })
  .strict();

export const scenePostEffectRegistryV1Schema = z
  .object({
    effect: scenePostEffectSourceV1Schema.nullable(),
    schema: z.literal("poietra.scene-post-effect-registry"),
    version: z.literal(1),
  })
  .strict();

export type ScenePostEffectRegistryV1 = z.infer<typeof scenePostEffectRegistryV1Schema>;
export type ScenePostEffectSourceV1 = z.infer<typeof scenePostEffectSourceV1Schema>;

export const EMPTY_SCENE_POST_EFFECT_REGISTRY_V1: ScenePostEffectRegistryV1 = Object.freeze({
  effect: null,
  schema: "poietra.scene-post-effect-registry",
  version: 1,
});

/** Editable starter that exercises the fixed Scene texture, time, viewport, and scalar ABI. */
export const STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1 = `struct ScenePostEffectHost {
    // xy = logical viewport pixels, z = sampled Scene time, w = reserved.
    viewport_and_time: vec4<f32>,
    // x = amplitude px, y = wavelength px, z = cycles per second, w = phase radians.
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: ScenePostEffectHost;

@group(0) @binding(1)
var scene_texture: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let viewport = max(vec2<i32>(host.viewport_and_time.xy), vec2<i32>(1));
    let maximum = viewport - vec2<i32>(1);
    let center = clamp(vec2<i32>(position.xy), vec2<i32>(0), maximum);
    let wavelength = max(host.parameters_0.y, 1.0);
    let phase = 6.28318530718 * (
        position.y / wavelength + host.viewport_and_time.z * host.parameters_0.z
    ) + host.parameters_0.w;
    let offset = i32(round(host.parameters_0.x * sin(phase)));
    let coordinate = clamp(center + vec2<i32>(offset, 0), vec2<i32>(0), maximum);
    return textureLoad(scene_texture, coordinate, 0);
}
`;

export function encodeScenePostEffectRegistryV1(registry: ScenePostEffectRegistryV1) {
  return new TextEncoder().encode(JSON.stringify(scenePostEffectRegistryV1Schema.parse(registry))).buffer;
}
