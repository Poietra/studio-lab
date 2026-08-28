import { describe, expect, it, vi } from "vitest";

import {
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
  scenePostEffectRegistryV1Schema,
} from "./scene-post-effect-registry";
import { createScenePostEffectSourceValidator } from "./scene-post-effect-source-compiler";

const registry = scenePostEffectRegistryV1Schema.parse({
  effect: {
    revision: 1,
    shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
    source: STUDIO_WAVE_SCENE_POST_EFFECT_SOURCE_V1,
  },
  schema: "poietra.scene-post-effect-registry",
  version: 1,
});

describe("Scene post-effect source validation", () => {
  it("passes the strict registry JSON to the Rust core", async () => {
    const validateScenePostEffectSourceV1 = vi.fn();
    const validate = createScenePostEffectSourceValidator(async () => ({ validateScenePostEffectSourceV1 }));

    await validate(registry);

    const input = validateScenePostEffectSourceV1.mock.calls[0]?.[0];
    expect(input).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(input))).toEqual(registry);
  });

  it("preserves the Rust compiler diagnostic", async () => {
    const validate = createScenePostEffectSourceValidator(async () => ({
      validateScenePostEffectSourceV1() {
        throw new Error("post-effect.wgsl:7:4: expected expression");
      },
    }));

    await expect(validate(registry)).rejects.toThrow("post-effect.wgsl:7:4: expected expression");
  });
});
