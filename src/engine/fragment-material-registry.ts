import { z } from "zod";

import { opaqueIdV1Schema } from "./primitives";

export const MAX_PROJECT_FRAGMENT_MATERIALS_V1 = 8;
export const MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1 = 16 * 1024;
export const PROJECT_FRAGMENT_SHADER_ID_V1 = "project-studio-fragment";
export const PROJECT_FRAGMENT_SHADER_REVISION_V1 = 1;

const utf8SourceSchema = z
  .string()
  .min(1)
  .refine(
    (source) => new TextEncoder().encode(source).byteLength <= MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1,
    `WGSL source accepts at most ${MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1} UTF-8 bytes.`,
  );

export const fragmentMaterialSourceV1Schema = z
  .object({
    revision: z.number().int().positive().max(0xffff_ffff),
    shaderId: opaqueIdV1Schema.refine(
      (value) => value !== "time-gradient",
      "time-gradient is reserved by the built-in renderer.",
    ),
    source: utf8SourceSchema,
    textureSlot: z.literal("texture2d").optional(),
  })
  .strict();

export const fragmentMaterialRegistryV1Schema = z
  .object({
    materials: z.array(fragmentMaterialSourceV1Schema).max(MAX_PROJECT_FRAGMENT_MATERIALS_V1),
    schema: z.literal("poietra.fragment-material-registry"),
    version: z.literal(1),
  })
  .strict()
  .superRefine((registry, context) => {
    const identities = new Set<string>();
    for (const [index, material] of registry.materials.entries()) {
      const identity = `${material.shaderId}@${material.revision}`;
      if (identities.has(identity)) {
        context.addIssue({ code: "custom", message: `${identity} is duplicated.`, path: ["materials", index] });
      }
      identities.add(identity);
    }
  });

export type FragmentMaterialRegistryV1 = z.infer<typeof fragmentMaterialRegistryV1Schema>;
export type FragmentMaterialSourceV1 = z.infer<typeof fragmentMaterialSourceV1Schema>;

export const EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1: FragmentMaterialRegistryV1 = Object.freeze({
  materials: [],
  schema: "poietra.fragment-material-registry",
  version: 1,
});

/** One editable preset that exercises the fixed fragment-only host ABI. */
export const STUDIO_WAVE_FRAGMENT_SOURCE_V1 = `struct FragmentHostUniform {
    // xy = logical viewport pixels, z = Scene time, w = reserved.
    viewport_and_time: vec4<f32>,
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: FragmentHostUniform;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) base_color: vec4<f32>,
    // Normalized screen coordinates, top-left origin.
    @location(1) screen_position: vec2<f32>,
};

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    let speed = host.parameters_0.x;
    let bands = max(host.parameters_0.y, 1.0);
    let wave = 0.5 + 0.5 * sin(
        6.28318530718 * (input.screen_position.x * bands + host.viewport_and_time.z * speed)
    );
    let tint = vec3<f32>(0.25 + 0.75 * wave, 0.35 + 0.65 * (1.0 - wave), 1.0);
    return vec4<f32>(input.base_color.rgb * tint, input.base_color.a);
}
`;

/** A directional two-color tint using the fixed host parameter slots. */
export const STUDIO_GRADIENT_FRAGMENT_SOURCE_V1 = `struct FragmentHostUniform {
    // xy = logical viewport pixels, z = Scene time, w = reserved.
    viewport_and_time: vec4<f32>,
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: FragmentHostUniform;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) base_color: vec4<f32>,
    // Normalized screen coordinates, top-left origin.
    @location(1) screen_position: vec2<f32>,
};

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    let angle = host.parameters_0.x;
    let spread = host.parameters_0.y;
    let axis = vec2<f32>(cos(angle), sin(angle));
    let amount = clamp(
        0.5 + dot(input.screen_position - vec2<f32>(0.5, 0.5), axis) * spread,
        0.0,
        1.0
    );
    let cool = vec3<f32>(host.parameters_0.z, host.parameters_0.w, host.parameters_1.x);
    let warm = vec3<f32>(host.parameters_1.y, host.parameters_1.z, host.parameters_1.w);
    let tint = cool * (1.0 - amount) + warm * amount;
    return vec4<f32>(input.base_color.rgb * tint, input.base_color.a);
}
`;

/** An animated radial pulse using the fixed host time and parameter slots. */
export const STUDIO_PULSE_FRAGMENT_SOURCE_V1 = `struct FragmentHostUniform {
    // xy = logical viewport pixels, z = Scene time, w = reserved.
    viewport_and_time: vec4<f32>,
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: FragmentHostUniform;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) base_color: vec4<f32>,
    // Normalized screen coordinates, top-left origin.
    @location(1) screen_position: vec2<f32>,
};

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    let speed = host.parameters_0.x;
    let strength = clamp(host.parameters_0.y, 0.0, 1.0);
    let radius = distance(input.screen_position, vec2<f32>(0.5, 0.5));
    let pulse = 0.5 + 0.5 * sin(
        6.28318530718 * (radius * 5.0 - host.viewport_and_time.z * speed)
    );
    let blend = pulse * strength;
    let tint = vec3<f32>(1.0, 1.0, 1.0) * (1.0 - blend) + vec3<f32>(0.25, 0.65, 1.0) * blend;
    return vec4<f32>(input.base_color.rgb * tint, input.base_color.a);
}
`;

/** One fixed-slot material that samples a verified project PNG in screen UV space. */
export const STUDIO_TEXTURE_FRAGMENT_SOURCE_V1 = `struct FragmentHostUniform {
    // xy = logical viewport pixels, z = Scene time, w = reserved.
    viewport_and_time: vec4<f32>,
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: FragmentHostUniform;

@group(0) @binding(1)
var material_texture: texture_2d<f32>;

@group(0) @binding(2)
var material_sampler: sampler;

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) base_color: vec4<f32>,
    // Normalized screen coordinates, top-left origin.
    @location(1) screen_position: vec2<f32>,
};

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    let tiles = max(host.parameters_0.xy, vec2<f32>(0.001, 0.001));
    let offset = host.parameters_0.zw;
    let uv = fract(input.screen_position * tiles + offset);
    let sampled = textureSample(material_texture, material_sampler, uv);
    let textured = sampled * input.base_color;
    return mix(input.base_color, textured, clamp(host.parameters_1.x, 0.0, 1.0));
}
`;

export function encodeFragmentMaterialRegistryV1(registry: FragmentMaterialRegistryV1) {
  return new TextEncoder().encode(JSON.stringify(fragmentMaterialRegistryV1Schema.parse(registry))).buffer;
}
