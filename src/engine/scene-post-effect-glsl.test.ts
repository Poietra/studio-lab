import { describe, expect, it, vi } from "vitest";

import {
  compileScenePostEffectGlsl,
  createScenePostEffectGlslCompiler,
  VULKAN_GLSL_SCENE_POST_EFFECT_ENTRY_POINT,
} from "./scene-post-effect-glsl";
import { MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 } from "./scene-post-effect-registry";

describe("Scene post-effect GLSL compiler", () => {
  it("compiles the supported Scene texture ABI through the production Rust/WASM artifact", async () => {
    const source = `#version 450
layout(location = 0) out vec4 output_color;
layout(set = 0, binding = 0, std140) uniform PoietraHost {
    vec4 viewport_and_time;
    vec4 parameters_0;
    vec4 parameters_1;
} host;
layout(set = 0, binding = 1) uniform texture2D scene_texture;
void main() {
    output_color = texelFetch(scene_texture, ivec2(gl_FragCoord.xy), 0);
}`;

    const compiled = await compileScenePostEffectGlsl({
      entryPoint: VULKAN_GLSL_SCENE_POST_EFFECT_ENTRY_POINT,
      source,
    });
    expect(compiled).toContain("@fragment");
    expect(compiled).toContain("fn fs_main");
    expect(compiled).toContain("textureLoad");
    await expect(
      compileScenePostEffectGlsl({
        entryPoint: VULKAN_GLSL_SCENE_POST_EFFECT_ENTRY_POINT,
        source: source.replace("void main()", "void main("),
      }),
    ).rejects.toThrow(/scene-post-effect\.glsl:\d+:\d+/u);
  });

  it("forwards the bounded Vulkan GLSL profile to the Rust core", async () => {
    const compile = vi.fn(() => "@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4(1.0); }");
    const compiler = createScenePostEffectGlslCompiler(async () => ({ compileScenePostEffectGlsl: compile }));
    const source = "#version 450\nvoid main() {}";

    await expect(compiler({ entryPoint: VULKAN_GLSL_SCENE_POST_EFFECT_ENTRY_POINT, source })).resolves.toContain(
      "fn fs_main",
    );
    expect(compile).toHaveBeenCalledWith(source, "main");
  });

  it("preserves Rust diagnostics", async () => {
    const compiler = createScenePostEffectGlslCompiler(async () => ({
      compileScenePostEffectGlsl: () => {
        throw "line 4, column 9: unsupported binding";
      },
    }));

    await expect(
      compiler({ entryPoint: VULKAN_GLSL_SCENE_POST_EFFECT_ENTRY_POINT, source: "#version 450" }),
    ).rejects.toThrow("line 4, column 9: unsupported binding");
  });

  it("rejects oversized UTF-8 source before loading WASM", async () => {
    const getBindings = vi.fn();
    const compiler = createScenePostEffectGlslCompiler(getBindings);

    await expect(
      compiler({
        entryPoint: VULKAN_GLSL_SCENE_POST_EFFECT_ENTRY_POINT,
        source: "x".repeat(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 + 1),
      }),
    ).rejects.toThrow("GLSL source must contain");
    expect(getBindings).not.toHaveBeenCalled();
  });
});
