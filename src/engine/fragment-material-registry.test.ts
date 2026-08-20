import { describe, expect, it } from "vitest";

import {
  EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
  fragmentMaterialRegistryV1Schema,
  MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1,
  PROJECT_FRAGMENT_SHADER_ID_V1,
  PROJECT_FRAGMENT_SHADER_REVISION_V1,
  STUDIO_GRADIENT_FRAGMENT_SOURCE_V1,
  STUDIO_TEXTURE_FRAGMENT_SOURCE_V1,
  STUDIO_WAVE_FRAGMENT_SOURCE_V1,
} from "./fragment-material-registry";

describe("fragmentMaterialRegistryV1Schema", () => {
  it("accepts the bounded Studio preset", () => {
    expect(
      fragmentMaterialRegistryV1Schema.parse({
        ...EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
        materials: [
          {
            revision: PROJECT_FRAGMENT_SHADER_REVISION_V1,
            shaderId: PROJECT_FRAGMENT_SHADER_ID_V1,
            source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
          },
        ],
      }),
    ).toMatchObject({ materials: [{ shaderId: PROJECT_FRAGMENT_SHADER_ID_V1 }] });
  });

  it("admits one declared 2D texture slot", () => {
    expect(
      fragmentMaterialRegistryV1Schema.parse({
        ...EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
        materials: [
          {
            revision: 1,
            shaderId: "screen-texture",
            source: STUDIO_TEXTURE_FRAGMENT_SOURCE_V1,
            textureSlot: "texture2d",
          },
        ],
      }),
    ).toMatchObject({ materials: [{ textureSlot: "texture2d" }] });
  });

  it("reads both Gradient colors from the fixed eight-scalar host ABI", () => {
    expect(STUDIO_GRADIENT_FRAGMENT_SOURCE_V1).toContain(
      "vec3<f32>(host.parameters_0.z, host.parameters_0.w, host.parameters_1.x)",
    );
    expect(STUDIO_GRADIENT_FRAGMENT_SOURCE_V1).toContain(
      "vec3<f32>(host.parameters_1.y, host.parameters_1.z, host.parameters_1.w)",
    );
  });

  it("rejects reserved, duplicate, and oversized project sources", () => {
    const material = {
      revision: 1,
      shaderId: "project-material",
      source: "@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(); }",
    };
    expect(
      fragmentMaterialRegistryV1Schema.safeParse({
        ...EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
        materials: [material, material],
      }).success,
    ).toBe(false);
    expect(
      fragmentMaterialRegistryV1Schema.safeParse({
        ...EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
        materials: [{ ...material, shaderId: "time-gradient" }],
      }).success,
    ).toBe(false);
    expect(
      fragmentMaterialRegistryV1Schema.safeParse({
        ...EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
        materials: [{ ...material, source: "x".repeat(MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1 + 1) }],
      }).success,
    ).toBe(false);
  });
});
