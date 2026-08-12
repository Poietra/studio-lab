import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "./contracts";

const POIETRA_ENGINE_ABI_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type RotateSceneEntityCommand = Readonly<{
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

export type RotateSceneEntityCompiler = (
  snapshot: SceneIrBundleV1,
  command: RotateSceneEntityCommand,
) => Promise<SceneIrBundleV1>;

export type MoveSceneEntityCommand = Readonly<{
  delta: Readonly<{ x: number; y: number }>;
  entityId: string;
  expectedBaseRevision: string;
  nextRevision: string;
  provenance: Readonly<{
    evidence: readonly string[];
    id: string;
    origin: "studio-edit-program";
  }>;
  schema: "poietra.move-scene-entity";
  version: 1;
}>;

export type MoveSceneEntityCompiler = (
  snapshot: SceneIrBundleV1,
  command: MoveSceneEntityCommand,
) => Promise<SceneIrBundleV1>;

export type UniformScaleSceneEntityCommand = Readonly<{
  entityId: string;
  expectedBaseRevision: string;
  factor: number;
  nextRevision: string;
  pivot: Readonly<{ x: number; y: number }>;
  provenance: Readonly<{
    evidence: readonly string[];
    id: string;
    origin: "studio-edit-program";
  }>;
  schema: "poietra.uniform-scale-scene-entity";
  version: 1;
}>;

export type UniformScaleSceneEntityCompiler = (
  snapshot: SceneIrBundleV1,
  command: UniformScaleSceneEntityCommand,
) => Promise<SceneIrBundleV1>;

export type SetSubtreeVectorPaintAlphaCommand = Readonly<{
  alpha: number;
  expectedBaseRevision: string;
  nextRevision: string;
  provenance: Readonly<{
    evidence: readonly string[];
    id: string;
    origin: "studio-edit-program";
  }>;
  rootEntityId: string;
  schema: "poietra.set-subtree-vector-paint-alpha";
  version: 1;
}>;

export type SetSubtreeVectorPaintAlphaCompiler = (
  snapshot: SceneIrBundleV1,
  command: SetSubtreeVectorPaintAlphaCommand,
) => Promise<SceneIrBundleV1>;

type RotateSceneAuthoringBindingsV1 = Readonly<{
  rotateSceneEntityV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type MoveSceneAuthoringBindingsV1 = Readonly<{
  moveSceneEntityV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type UniformScaleSceneAuthoringBindingsV1 = Readonly<{
  uniformScaleSceneEntityV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type SetSubtreeVectorPaintAlphaBindingsV1 = Readonly<{
  setSubtreeVectorPaintAlphaV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type SceneAuthoringBindingsV1 = MoveSceneAuthoringBindingsV1 &
  RotateSceneAuthoringBindingsV1 &
  UniformScaleSceneAuthoringBindingsV1 &
  SetSubtreeVectorPaintAlphaBindingsV1;

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
      typeof candidate.moveSceneEntityV1 !== "function" ||
      typeof candidate.rotateSceneEntityV1 !== "function" ||
      typeof candidate.setSubtreeVectorPaintAlphaV1 !== "function" ||
      typeof candidate.uniformScaleSceneEntityV1 !== "function"
    ) {
      throw new Error(`The Poietra WASM module does not support engine ABI ${POIETRA_ENGINE_ABI_VERSION}.`);
    }
    return {
      moveSceneEntityV1: candidate.moveSceneEntityV1 as SceneAuthoringBindingsV1["moveSceneEntityV1"],
      rotateSceneEntityV1: candidate.rotateSceneEntityV1 as SceneAuthoringBindingsV1["rotateSceneEntityV1"],
      setSubtreeVectorPaintAlphaV1:
        candidate.setSubtreeVectorPaintAlphaV1 as SceneAuthoringBindingsV1["setSubtreeVectorPaintAlphaV1"],
      uniformScaleSceneEntityV1:
        candidate.uniformScaleSceneEntityV1 as SceneAuthoringBindingsV1["uniformScaleSceneEntityV1"],
    };
  })();
  bindingsPromise = pending;
  return pending;
}

async function invokeSceneAuthoringCommand(
  snapshot: SceneIrBundleV1,
  command: unknown,
  invoke: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array,
) {
  const response = invoke(encoder.encode(JSON.stringify(snapshot)), encoder.encode(JSON.stringify(command)));
  return parseVerifiedSceneIrBundleV1(JSON.parse(decoder.decode(response)) as unknown);
}

/** Creates the browser adapter around one concrete, profile-free Rust command. */
export function createRotateSceneEntityCompiler(
  getBindings: () => Promise<RotateSceneAuthoringBindingsV1>,
): RotateSceneEntityCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.rotateSceneEntityV1);
  };
}

/** Creates the browser adapter around one concrete, profile-free Rust command. */
export function createMoveSceneEntityCompiler(
  getBindings: () => Promise<MoveSceneAuthoringBindingsV1>,
): MoveSceneEntityCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.moveSceneEntityV1);
  };
}

/** Creates the browser adapter around one concrete, profile-free Rust command. */
export function createUniformScaleSceneEntityCompiler(
  getBindings: () => Promise<UniformScaleSceneAuthoringBindingsV1>,
): UniformScaleSceneEntityCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.uniformScaleSceneEntityV1);
  };
}

/** Creates the browser adapter for the canonical subtree vector-paint command. */
export function createSetSubtreeVectorPaintAlphaCompiler(
  getBindings: () => Promise<SetSubtreeVectorPaintAlphaBindingsV1>,
): SetSubtreeVectorPaintAlphaCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.setSubtreeVectorPaintAlphaV1);
  };
}

export const compileRotateSceneEntity = createRotateSceneEntityCompiler(loadBindings);
export const compileMoveSceneEntity = createMoveSceneEntityCompiler(loadBindings);
export const compileUniformScaleSceneEntity = createUniformScaleSceneEntityCompiler(loadBindings);
export const compileSetSubtreeVectorPaintAlpha = createSetSubtreeVectorPaintAlphaCompiler(loadBindings);
