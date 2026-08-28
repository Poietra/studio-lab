import { loadPoietraWasmModule } from "./poietra-wasm-module";
import { MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 } from "./scene-post-effect-registry";

export const VULKAN_GLSL_SCENE_POST_EFFECT_ENTRY_POINT = "main" as const;

export type CompileScenePostEffectGlslInput = Readonly<{
  entryPoint: typeof VULKAN_GLSL_SCENE_POST_EFFECT_ENTRY_POINT;
  source: string;
}>;

type ScenePostEffectGlslBindings = Readonly<{
  compileScenePostEffectGlsl: (source: string, entryPoint: string) => string;
}>;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The Rust core rejected the Scene post-effect GLSL source.";
}

export function createScenePostEffectGlslCompiler(getBindings: () => Promise<ScenePostEffectGlslBindings>) {
  return async ({ entryPoint, source }: CompileScenePostEffectGlslInput) => {
    const sourceBytes = new TextEncoder().encode(source).byteLength;
    if (sourceBytes < 1 || sourceBytes > MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1) {
      throw new Error(`GLSL source must contain 1 to ${MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1} UTF-8 bytes.`);
    }
    const bindings = await getBindings();
    try {
      return bindings.compileScenePostEffectGlsl(source, entryPoint);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  };
}

let bindingsPromise: Promise<ScenePostEffectGlslBindings> | null = null;

async function loadBindings(): Promise<ScenePostEffectGlslBindings> {
  if (bindingsPromise) return bindingsPromise;
  bindingsPromise = (async () => {
    const module = await loadPoietraWasmModule();
    if (typeof module.compileScenePostEffectGlsl !== "function") {
      throw new Error("The Poietra Rust core does not export the Scene post-effect GLSL compiler.");
    }
    return {
      compileScenePostEffectGlsl:
        module.compileScenePostEffectGlsl as ScenePostEffectGlslBindings["compileScenePostEffectGlsl"],
    };
  })();
  return bindingsPromise;
}

export const compileScenePostEffectGlsl = createScenePostEffectGlslCompiler(loadBindings);
