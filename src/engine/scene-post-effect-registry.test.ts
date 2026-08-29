import { describe, expect, it } from "vitest";

import {
  EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
  encodeScenePostEffectRegistryV1,
  MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
  MAX_SCENE_POST_EFFECTS_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
  scenePostEffectRegistryV1Schema,
} from "./scene-post-effect-registry";

describe("Scene post-effect registry", () => {
  it("encodes an ordered bounded stack of fixed custom effect revisions", () => {
    const registry = scenePostEffectRegistryV1Schema.parse({
      effects: [
        {
          revision: 2,
          shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          source: STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
        },
      ],
      schema: "poietra.scene-post-effect-registry",
      version: 1,
    });

    expect(STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1).toContain("@group(0) @binding(2)");
    expect(STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1).toContain("textureSample(scene_texture, scene_sampler");
    expect(JSON.parse(new TextDecoder().decode(encodeScenePostEffectRegistryV1(registry)))).toEqual(registry);
  });

  it("keeps the empty registry explicit and rejects widened identities or source budgets", () => {
    expect(scenePostEffectRegistryV1Schema.parse(EMPTY_SCENE_POST_EFFECT_REGISTRY_V1)).toEqual(
      EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
    );
    expect(
      scenePostEffectRegistryV1Schema.safeParse({
        ...EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
        effects: [{ revision: 1, shaderId: "rgb-split", source: "x" }],
      }).success,
    ).toBe(false);
    expect(
      scenePostEffectRegistryV1Schema.safeParse({
        ...EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
        effects: [
          {
            revision: 1,
            shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
            source: "x".repeat(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 + 1),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("encodes every admitted source even when JSON escaping expands it", () => {
    const registry = scenePostEffectRegistryV1Schema.parse({
      ...EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
      effects: [
        {
          revision: 1,
          shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
          source: "\n".repeat(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1),
        },
      ],
    });

    expect(encodeScenePostEffectRegistryV1(registry).byteLength).toBeLessThanOrEqual(
      MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 * 6 * MAX_SCENE_POST_EFFECTS_V1 + 4096,
    );
  });

  it("migrates the legacy singleton envelope at parse time and only encodes the plural form", () => {
    const migrated = scenePostEffectRegistryV1Schema.parse({
      effect: {
        revision: 3,
        shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
        source: STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
      },
      schema: "poietra.scene-post-effect-registry",
      version: 1,
    });

    expect(migrated.effects).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(encodeScenePostEffectRegistryV1(migrated)))).not.toHaveProperty(
      "effect",
    );
  });

  it("rejects more than four sources and duplicate shader revisions", () => {
    const source = {
      shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
      source: STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
    } as const;
    expect(
      scenePostEffectRegistryV1Schema.safeParse({
        ...EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
        effects: Array.from({ length: MAX_SCENE_POST_EFFECTS_V1 + 1 }, (_, index) => ({
          ...source,
          revision: index + 1,
        })),
      }).success,
    ).toBe(false);
    expect(
      scenePostEffectRegistryV1Schema.safeParse({
        ...EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
        effects: [
          { ...source, revision: 1 },
          { ...source, revision: 1 },
        ],
      }).success,
    ).toBe(false);
  });
});
