import { MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1 } from "./fragment-material-registry";
import { loadPoietraWasmModule } from "./poietra-wasm-module";

export const VULKAN_GLSL_FRAGMENT_ENTRY_POINT = "main" as const;

export type CompileFragmentMaterialGlslInput = Readonly<{
  entryPoint: string;
  source: string;
}>;

type FragmentMaterialGlslBindings = Readonly<{
  compileFragmentMaterialGlsl: (source: string, entryPoint: string) => string;
}>;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The Rust core rejected the GLSL source.";
}

export function createFragmentMaterialGlslCompiler(getBindings: () => Promise<FragmentMaterialGlslBindings>) {
  return async ({ entryPoint, source }: CompileFragmentMaterialGlslInput) => {
    const sourceBytes = new TextEncoder().encode(source).byteLength;
    if (sourceBytes < 1 || sourceBytes > MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1) {
      throw new Error(`GLSL source must contain 1 to ${MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1} UTF-8 bytes.`);
    }
    const bindings = await getBindings();
    try {
      return bindings.compileFragmentMaterialGlsl(source, entryPoint);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  };
}

let bindingsPromise: Promise<FragmentMaterialGlslBindings> | null = null;

async function loadBindings(): Promise<FragmentMaterialGlslBindings> {
  if (bindingsPromise) return bindingsPromise;
  bindingsPromise = (async () => {
    const module = await loadPoietraWasmModule();
    if (typeof module.compileFragmentMaterialGlsl !== "function") {
      throw new Error("The Poietra Rust core does not export the GLSL material compiler.");
    }
    return {
      compileFragmentMaterialGlsl:
        module.compileFragmentMaterialGlsl as FragmentMaterialGlslBindings["compileFragmentMaterialGlsl"],
    };
  })();
  return bindingsPromise;
}

export const compileFragmentMaterialGlsl = createFragmentMaterialGlslCompiler(loadBindings);
