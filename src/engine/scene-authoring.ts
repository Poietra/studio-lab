import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1 } from "./contracts";

const POIETRA_ENGINE_ABI_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type RotateSceneEntityWireCommandV1 = Readonly<{
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
  command: RotateSceneEntityWireCommandV1,
) => Promise<SceneIrBundleV1>;

export type TransformSceneEntityWireCommandV1 = Readonly<{
  delta: Readonly<{ x: number; y: number }>;
  entityId: string;
  expectedBaseRevision: string;
  nextRevision: string;
  provenance: Readonly<{
    evidence: readonly string[];
    id: string;
    origin: "studio-edit-program";
  }>;
  scale?: Readonly<{
    pivot: Readonly<{ x: number; y: number }>;
    xFactor: number;
    yFactor: number;
  }>;
  schema: "poietra.transform-scene-entity";
  version: 1;
}>;

export type TransformSceneEntityCompiler = (
  snapshot: SceneIrBundleV1,
  command: TransformSceneEntityWireCommandV1,
) => Promise<SceneIrBundleV1>;

export type EditSceneTimelineWireCommandV1 = Readonly<{
  edits: readonly (
    | Readonly<{ at: number; duration: number; kind: "insert-wait" }>
    | Readonly<{ kind: "trim-scene-duration"; removedDuration: number; targetDuration: number }>
  )[];
  expectedBaseRevision: string;
  nextRevision: string;
  provenance: Readonly<{
    evidence: readonly string[];
    id: string;
    origin: "studio-edit-program";
  }>;
  schema: "poietra.edit-scene-timeline";
  version: 1;
}>;

export type EditSceneTimelineCompiler = (
  snapshot: SceneIrBundleV1,
  command: EditSceneTimelineWireCommandV1,
) => Promise<SceneIrBundleV1>;

type CreateSceneEntityGeometryV1 =
  | Readonly<{ kind: "circle"; radius: number }>
  | Readonly<{ height: number; kind: "rectangle"; width: number }>
  | Readonly<{
      kind: "mathtex";
      path: Extract<SceneIrBundleV1["scene"]["entities"][number]["geometry"], { kind: "cubic-path" }>["path"];
    }>;

export type CreateSceneEntitiesWireCommandV1 = Readonly<{
  entities: readonly Readonly<{
    fadeIn?: Readonly<{
      end: number;
    }>;
    geometry: CreateSceneEntityGeometryV1;
    id: string;
    instantTransform?: Readonly<{
      at: number;
      position: Readonly<{ x: number; y: number }>;
      scaleX: number;
      scaleY: number;
    }>;
    lifetime: Readonly<{ end: number; start: number }>;
    position: Readonly<{ x: number; y: number }>;
    scale: number;
  }>[];
  expectedBaseRevision: string;
  nextRevision: string;
  provenance: Readonly<{
    evidence: readonly string[];
    id: string;
    origin: "studio-edit-program";
  }>;
  schema: "poietra.create-scene-entities";
  timelineInsertions: readonly Readonly<{ at: number; duration: number }>[];
  version: 1;
}>;

export type CreateSceneEntitiesCompiler = (
  snapshot: SceneIrBundleV1,
  command: CreateSceneEntitiesWireCommandV1,
) => Promise<SceneIrBundleV1>;

export type SetSubtreeVectorPaintAlphaWireCommandV1 = Readonly<{
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
  command: SetSubtreeVectorPaintAlphaWireCommandV1,
) => Promise<SceneIrBundleV1>;

type RotateSceneAuthoringBindingsV1 = Readonly<{
  rotateSceneEntityV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type TransformSceneAuthoringBindingsV1 = Readonly<{
  transformSceneEntityV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type EditSceneTimelineBindingsV1 = Readonly<{
  editSceneTimelineV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type CreateSceneEntitiesBindingsV1 = Readonly<{
  createSceneEntitiesV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type SetSubtreeVectorPaintAlphaBindingsV1 = Readonly<{
  setSubtreeVectorPaintAlphaV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type SceneAuthoringBindingsV1 = CreateSceneEntitiesBindingsV1 &
  EditSceneTimelineBindingsV1 &
  RotateSceneAuthoringBindingsV1 &
  TransformSceneAuthoringBindingsV1 &
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
      typeof candidate.createSceneEntitiesV1 !== "function" ||
      typeof candidate.editSceneTimelineV1 !== "function" ||
      typeof candidate.rotateSceneEntityV1 !== "function" ||
      typeof candidate.setSubtreeVectorPaintAlphaV1 !== "function" ||
      typeof candidate.transformSceneEntityV1 !== "function"
    ) {
      throw new Error(`The Poietra WASM module does not support engine ABI ${POIETRA_ENGINE_ABI_VERSION}.`);
    }
    return {
      createSceneEntitiesV1: candidate.createSceneEntitiesV1 as SceneAuthoringBindingsV1["createSceneEntitiesV1"],
      editSceneTimelineV1: candidate.editSceneTimelineV1 as SceneAuthoringBindingsV1["editSceneTimelineV1"],
      rotateSceneEntityV1: candidate.rotateSceneEntityV1 as SceneAuthoringBindingsV1["rotateSceneEntityV1"],
      setSubtreeVectorPaintAlphaV1:
        candidate.setSubtreeVectorPaintAlphaV1 as SceneAuthoringBindingsV1["setSubtreeVectorPaintAlphaV1"],
      transformSceneEntityV1: candidate.transformSceneEntityV1 as SceneAuthoringBindingsV1["transformSceneEntityV1"],
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

/** Creates supported Studio entities through one atomic core command. */
export function createCreateSceneEntitiesCompiler(
  getBindings: () => Promise<CreateSceneEntitiesBindingsV1>,
): CreateSceneEntitiesCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.createSceneEntitiesV1);
  };
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

/** Creates the browser adapter around one atomic, profile-free entity transform. */
export function createTransformSceneEntityCompiler(
  getBindings: () => Promise<TransformSceneAuthoringBindingsV1>,
): TransformSceneEntityCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.transformSceneEntityV1);
  };
}

/** Creates the browser adapter around one ordered, atomic Scene timeline edit. */
export function createEditSceneTimelineCompiler(
  getBindings: () => Promise<EditSceneTimelineBindingsV1>,
): EditSceneTimelineCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.editSceneTimelineV1);
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

export const compileCreateSceneEntities = createCreateSceneEntitiesCompiler(loadBindings);
export const compileEditSceneTimeline = createEditSceneTimelineCompiler(loadBindings);
export const compileRotateSceneEntity = createRotateSceneEntityCompiler(loadBindings);
export const compileTransformSceneEntity = createTransformSceneEntityCompiler(loadBindings);
export const compileSetSubtreeVectorPaintAlpha = createSetSubtreeVectorPaintAlphaCompiler(loadBindings);
