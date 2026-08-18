import { describe, expect, it, vi } from "vitest";

import {
  compileFragmentMaterialGlsl,
  createFragmentMaterialGlslCompiler,
  VULKAN_GLSL_FRAGMENT_ENTRY_POINT,
} from "./fragment-material-glsl";
import { MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1 } from "./fragment-material-registry";

describe("fragment material GLSL compiler", () => {
  it("compiles the supported host ABI through the production Rust/WASM artifact", async () => {
    const source = `#version 450
layout(location = 0) in vec4 base_color;
layout(location = 1) in vec2 screen_position;
layout(location = 0) out vec4 output_color;

void main() {
    output_color = vec4(base_color.rgb * (0.5 + 0.5 * screen_position.x), base_color.a);
}
`;
    await expect(compileFragmentMaterialGlsl({ entryPoint: "main", source })).resolves.toContain("fn fs_main");

    await expect(
      compileFragmentMaterialGlsl({ entryPoint: "main", source: source.replace("output_color =", "output_color") }),
    ).rejects.toThrow(/material\.glsl:\d+:\d+/);
  });

  it("forwards the explicit entry point to the Rust compiler", async () => {
    const compile = vi.fn(() => "@fragment fn fs_main() {}");
    const compiler = createFragmentMaterialGlslCompiler(async () => ({
      compileFragmentMaterialGlsl: compile,
    }));

    await expect(
      compiler({ entryPoint: VULKAN_GLSL_FRAGMENT_ENTRY_POINT, source: "#version 450\nvoid main() {}" }),
    ).resolves.toBe("@fragment fn fs_main() {}");
    expect(compile).toHaveBeenCalledWith("#version 450\nvoid main() {}", "main");
  });

  it("preserves Rust line and column diagnostics", async () => {
    const compiler = createFragmentMaterialGlslCompiler(async () => ({
      compileFragmentMaterialGlsl: () => {
        throw "line 4, column 9: unsupported binding";
      },
    }));

    await expect(compiler({ entryPoint: "main", source: "#version 450" })).rejects.toThrow(
      "line 4, column 9: unsupported binding",
    );
  });

  it("rejects oversized source before loading WASM", async () => {
    const getBindings = vi.fn();
    const compiler = createFragmentMaterialGlslCompiler(getBindings);
    await expect(
      compiler({ entryPoint: "main", source: "x".repeat(MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1 + 1) }),
    ).rejects.toThrow("GLSL source must contain");
    expect(getBindings).not.toHaveBeenCalled();
  });
});
