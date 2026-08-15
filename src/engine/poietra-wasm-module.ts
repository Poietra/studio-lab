const POIETRA_ENGINE_ABI_VERSION = 21;

type PoietraWasmModule = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is PoietraWasmModule {
  return typeof value === "object" && value !== null;
}

function browserModuleUrl() {
  if (typeof document === "undefined") return null;
  return new URL("./engine-wasm/poietra_wasm.js", document.baseURI);
}

async function nodeAssetUrl(fileName: string) {
  const currentUrl = import.meta.url;
  const serverMarker = "/dist-server/";
  const electronMarker = "/dist-electron/";
  const serverIndex = currentUrl.lastIndexOf(serverMarker);
  if (serverIndex >= 0) {
    return new URL(`engine-wasm/${fileName}`, currentUrl.slice(0, serverIndex + serverMarker.length));
  }
  const electronIndex = currentUrl.lastIndexOf(electronMarker);
  if (electronIndex >= 0) {
    return new URL(`dist/engine-wasm/${fileName}`, currentUrl.slice(0, electronIndex + 1));
  }

  const pathSpecifier = "node:path";
  const urlSpecifier = "node:url";
  const [{ resolve }, { pathToFileURL }] = await Promise.all([
    import(/* @vite-ignore */ pathSpecifier) as Promise<typeof import("node:path")>,
    import(/* @vite-ignore */ urlSpecifier) as Promise<typeof import("node:url")>,
  ]);
  return pathToFileURL(resolve(process.cwd(), "public", "engine-wasm", fileName));
}

let modulePromise: Promise<PoietraWasmModule> | null = null;

/** Loads the one production Rust core artifact in browsers, Node, and Electron. */
export function loadPoietraWasmModule(): Promise<PoietraWasmModule> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const browserUrl = browserModuleUrl();
    const moduleUrl = browserUrl ?? (await nodeAssetUrl("poietra_wasm.js"));
    const candidate: unknown = await import(/* @vite-ignore */ moduleUrl.href);
    if (!isRecord(candidate) || typeof candidate.default !== "function") {
      throw new Error("The Poietra WASM module does not export its initializer.");
    }
    if (browserUrl) {
      await candidate.default();
    } else {
      const fsSpecifier = "node:fs/promises";
      const { readFile } = (await import(/* @vite-ignore */ fsSpecifier)) as typeof import("node:fs/promises");
      const wasmBytes = await readFile(await nodeAssetUrl("poietra_wasm_bg.wasm"));
      await candidate.default({ module_or_path: wasmBytes });
    }
    if (
      typeof candidate.poietraEngineAbiVersion !== "function" ||
      candidate.poietraEngineAbiVersion() !== POIETRA_ENGINE_ABI_VERSION
    ) {
      throw new Error(`The Poietra WASM module does not support engine ABI ${POIETRA_ENGINE_ABI_VERSION}.`);
    }
    return candidate;
  })();
  return modulePromise;
}
