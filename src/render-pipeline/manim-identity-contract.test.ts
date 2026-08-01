import { describe, expect, it } from "vitest";

import { MAX_MANIM_SCENE_NAME_LENGTH_V1, manimSceneNameSchema } from "./manim-identity-contract";

describe("Manim identity contract", () => {
  it.each([
    [128, true],
    [129, true],
    [240, true],
    [241, false],
  ] as const)("validates a %i-character Scene name at the canonical boundary", (length, accepted) => {
    const sceneName = `S${"a".repeat(length - 1)}`;
    expect(manimSceneNameSchema.safeParse(sceneName).success).toBe(accepted);
  });

  it("keeps the product limit and Python identifier grammar explicit", () => {
    expect(MAX_MANIM_SCENE_NAME_LENGTH_V1).toBe(240);
    expect(manimSceneNameSchema.safeParse("_Scene2").success).toBe(true);
    expect(manimSceneNameSchema.safeParse("2Scene").success).toBe(false);
    expect(manimSceneNameSchema.safeParse("Scene.Name").success).toBe(false);
  });
});
