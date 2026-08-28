import { loadPoietraWasmModule } from "./poietra-wasm-module";
import { encodeScenePostEffectRegistryV1, type ScenePostEffectRegistryV1 } from "./scene-post-effect-registry";

type ScenePostEffectSourceValidationBindings = Readonly<{
  validateScenePostEffectSourceV1: (registryJson: Uint8Array) => void;
}>;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The Rust core rejected the Scene post-effect WGSL source.";
}

export function createScenePostEffectSourceValidator(
  getBindings: () => Promise<ScenePostEffectSourceValidationBindings>,
) {
  return async (registry: ScenePostEffectRegistryV1) => {
    const bindings = await getBindings();
    try {
      bindings.validateScenePostEffectSourceV1(new Uint8Array(encodeScenePostEffectRegistryV1(registry)));
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  };
}

let bindingsPromise: Promise<ScenePostEffectSourceValidationBindings> | null = null;

async function loadBindings(): Promise<ScenePostEffectSourceValidationBindings> {
  if (bindingsPromise) return bindingsPromise;
  bindingsPromise = (async () => {
    const module = await loadPoietraWasmModule();
    if (typeof module.validateScenePostEffectSourceV1 !== "function") {
      throw new Error("The Poietra Rust core does not export the Scene post-effect source validator.");
    }
    return {
      validateScenePostEffectSourceV1:
        module.validateScenePostEffectSourceV1 as ScenePostEffectSourceValidationBindings["validateScenePostEffectSourceV1"],
    };
  })();
  return bindingsPromise;
}

export const validateScenePostEffectSource = createScenePostEffectSourceValidator(loadBindings);
