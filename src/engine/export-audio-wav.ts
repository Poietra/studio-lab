import { loadPoietraWasmModule } from "./poietra-wasm-module";

type ExportAudioWavBindings = Readonly<{
  validateExportAudioWavV1: (wavBytes: Uint8Array) => void;
}>;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The Rust core rejected the WAV audio track.";
}

export function createExportAudioWavValidator(getBindings: () => Promise<ExportAudioWavBindings>) {
  return async (wavBytes: ArrayBuffer) => {
    const bindings = await getBindings();
    try {
      bindings.validateExportAudioWavV1(new Uint8Array(wavBytes));
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  };
}

let bindingsPromise: Promise<ExportAudioWavBindings> | null = null;

async function loadBindings(): Promise<ExportAudioWavBindings> {
  if (bindingsPromise) return bindingsPromise;
  bindingsPromise = (async () => {
    const module = await loadPoietraWasmModule();
    if (typeof module.validateExportAudioWavV1 !== "function") {
      throw new Error("The Poietra Rust core does not export the WAV validator.");
    }
    return {
      validateExportAudioWavV1: module.validateExportAudioWavV1 as ExportAudioWavBindings["validateExportAudioWavV1"],
    };
  })();
  return bindingsPromise;
}

export const validateExportAudioWav = createExportAudioWavValidator(loadBindings);
