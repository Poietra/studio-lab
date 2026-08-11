import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "./contracts";

const POIETRA_ENGINE_ABI_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type RotateSceneEntityCommandV1 = Readonly<{
  angleRadians: number;
  entityId: string;
  expectedBaseRevision: string;
  nextRevision: string;
  pivot: Readonly<{ x: number; y: number }>;
  provenance: Readonly<{
    evidence: readonly string[];
    id: string;
    origin: "studio-edit-program";
  }>;
  schema: "poietra.rotate-scene-entity";
  version: 1;
}>;

export type RotateSceneEntityCompilerV1 = (
  snapshot: SceneIrBundleV1,
  command: RotateSceneEntityCommandV1,
) => Promise<SceneIrBundleV1>;

type SceneAuthoringBindingsV1 = Readonly<{
  rotateSceneEntityV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

let bindingsPromise: Promise<SceneAuthoringBindingsV1> | null = null;

async function loadBindings(): Promise<SceneAuthoringBindingsV1> {
  if (bindingsPromise) return bindingsPromise;
  const pending: Promise<SceneAuthoringBindingsV1> = (async () => {
    if (typeof document === "undefined") {
      throw new Error("Scene authoring requires a browser document.");
    }
    const moduleUrl = new URL("./engine-wasm/poietra_wasm.js", document.baseURI);
    const candidate: unknown = await import(/* @vite-ignore */ moduleUrl.href);
    if (!isRecord(candidate) || typeof candidate.default !== "function") {
      throw new Error("The Poietra WASM module does not export its initializer.");
    }
    await candidate.default();
    if (
      typeof candidate.poietraEngineAbiVersion !== "function" ||
      candidate.poietraEngineAbiVersion() !== POIETRA_ENGINE_ABI_VERSION ||
      typeof candidate.rotateSceneEntityV1 !== "function"
    ) {
      throw new Error(`The Poietra WASM module does not support engine ABI ${POIETRA_ENGINE_ABI_VERSION}.`);
    }
    return {
      rotateSceneEntityV1: candidate.rotateSceneEntityV1 as SceneAuthoringBindingsV1["rotateSceneEntityV1"],
    };
  })();
  bindingsPromise = pending;
  return pending;
}

/** Creates the browser adapter around one concrete, profile-free Rust command. */
export function createRotateSceneEntityCompilerV1(
  getBindings: () => Promise<SceneAuthoringBindingsV1>,
): RotateSceneEntityCompilerV1 {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    const response = bindings.rotateSceneEntityV1(
      encoder.encode(JSON.stringify(snapshot)),
      encoder.encode(JSON.stringify(command)),
    );
    return parseVerifiedSceneIrBundleV1(JSON.parse(decoder.decode(response)) as unknown);
  };
}

export const compileRotateSceneEntityV1 = createRotateSceneEntityCompilerV1(loadBindings);
