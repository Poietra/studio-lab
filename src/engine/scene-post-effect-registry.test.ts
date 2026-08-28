import { describe, expect, it } from "vitest";

import {
  EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
  encodeScenePostEffectRegistryV1,
  MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
  scenePostEffectRegistryV1Schema,
} from "./scene-post-effect-registry";

describe("Scene post-effect registry", () => {
  it("encodes the one fixed custom effect identity", () => {
    const registry = scenePostEffectRegistryV1Schema.parse({
      effect: {
        revision: 2,
        shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
        source: STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
      },
      schema: "poietra.scene-post-effect-registry",
      version: 1,
    });

    expect(JSON.parse(new TextDecoder().decode(encodeScenePostEffectRegistryV1(registry)))).toEqual(registry);
  });

  it("keeps the empty registry explicit and rejects widened identities or source budgets", () => {
    expect(scenePostEffectRegistryV1Schema.parse(EMPTY_SCENE_POST_EFFECT_REGISTRY_V1)).toEqual(
      EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
    );
    expect(
      scenePostEffectRegistryV1Schema.safeParse({
        ...EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
        effect: { revision: 1, shaderId: "rgb-split", source: "x" },
      }).success,
    ).toBe(false);
    expect(
      scenePostEffectRegistryV1Schema.safeParse({
        ...EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
        effect: {
          revision: 1,
          shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          source: "x".repeat(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 + 1),
        },
      }).success,
    ).toBe(false);
  });

  it("encodes every admitted source even when JSON escaping expands it", () => {
    const registry = scenePostEffectRegistryV1Schema.parse({
      ...EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
      effect: {
        revision: 1,
        shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
        source: "\n".repeat(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1),
      },
    });

    expect(encodeScenePostEffectRegistryV1(registry).byteLength).toBeLessThanOrEqual(
      MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 * 6 + 1024,
    );
  });
});
