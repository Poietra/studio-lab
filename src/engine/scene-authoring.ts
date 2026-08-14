import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "./contracts";
import { loadPoietraWasmModule } from "./poietra-wasm-module";

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
  entityId: string;
  expectedBaseRevision: string;
  intent:
    | Readonly<{
        delta: Readonly<{ x: number; y: number }>;
        kind: "relative";
        scale?: Readonly<{
          pivot: Readonly<{ x: number; y: number }>;
          xFactor: number;
          yFactor: number;
        }>;
      }>
    | Readonly<{
        baseline:
          | Readonly<{ kind: "current-center" }>
          | Readonly<{ kind: "current-uniform-affine" }>
          | Readonly<{
              height: number;
              kind: "world-size";
              width: number;
              worldCenter: Readonly<{ x: number; y: number }>;
            }>;
        kind: "from-baseline";
        scale?: Readonly<{ xFactor: number; yFactor: number }>;
        targetCenter?: Readonly<{ x: number; y: number }>;
      }>;
  nextRevision: string;
  provenance: Readonly<{
    evidence: readonly string[];
    id: string;
    origin: "studio-edit-program";
  }>;
  schema: "poietra.transform-scene-entity";
  version: 1;
}>;

export type TransformSceneEntityCompiler = (
  snapshot: SceneIrBundleV1,
  command: TransformSceneEntityWireCommandV1,
) => Promise<SceneIrBundleV1>;

type StaticRootTransformOrigin = "direct-manipulation" | "fixture" | "remote-model" | "studio-default";
type StaticRootTransformEntityKind = "circle" | "image" | "math-tex" | "other" | "rectangle";
type StaticRootTransformDimensions = Readonly<{ height?: number; radius?: number; width?: number }>;
type StaticRootTransformOperation = Readonly<{
  anchorSeconds: number;
  entityId: string;
  id: string;
  interval: Readonly<{ end: number; start: number }>;
  loweringSupported: boolean;
  origin: StaticRootTransformOrigin;
  programOrigin: StaticRootTransformOrigin;
  validationValid: boolean;
}> &
  (
    | Readonly<{ kind: "position"; position: Readonly<{ x: number; y: number }> | null }>
    | Readonly<{
        controlPresent: boolean;
        from: number | null;
        kind: "uniform-scale";
        relativeFactor: number | null;
        to: number | null;
      }>
    | Readonly<{
        fromDimensions: StaticRootTransformDimensions;
        fromPosition: Readonly<{ x: number; y: number }>;
        fromScale: number;
        kind: "resize";
        shape: StaticRootTransformEntityKind;
        toDimensions: StaticRootTransformDimensions;
        toPosition: Readonly<{ x: number; y: number }>;
      }>
    | Readonly<{ kind: "unsupported" }>
  );

export type ApplyStaticRootTransformEditWireCommandV1 = Readonly<{
  expectedBaseRevision: string;
  frame: Readonly<{ height: number; width: number }>;
  nextRevision: string;
  operations: readonly StaticRootTransformOperation[];
  schema: "poietra.apply-static-root-transform-edit";
  sourceRuntimeBindings: readonly Readonly<{
    runtimeEntityId: string;
    sourceIdentityKey: string;
    sourceName: string;
  }>[];
  studioEntities: readonly Readonly<{
    dimensions: StaticRootTransformDimensions;
    id: string;
    kind: StaticRootTransformEntityKind;
    objectGraphKey: string;
    position: Readonly<{ x: number; y: number }> | null;
    provisional: boolean;
    scale: number | null;
    sourceIdentity: string | null;
    transactionId?: string;
  }>[];
  version: 1;
  viewport: Readonly<{ height: number; width: number }>;
}>;

export type ApplyStaticRootTransformEditCompiler = (
  snapshot: SceneIrBundleV1,
  command: ApplyStaticRootTransformEditWireCommandV1,
) => Promise<SceneIrBundleV1>;

export type TransformSceneEntityAtTimeWireCommandV1 = Readonly<{
  at: number;
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
  schema: "poietra.transform-scene-entity-at-time";
  version: 1;
}>;

export type TransformSceneEntityAtTimeCompiler = (
  snapshot: SceneIrBundleV1,
  command: TransformSceneEntityAtTimeWireCommandV1,
) => Promise<SceneIrBundleV1>;

export type EditSceneTimelineWireCommandV1 = Readonly<{
  edits: readonly (
    | Readonly<{ at: number; duration: number; kind: "insert-wait" }>
    | Readonly<{ at: number; kind: "trim-scene-duration"; removedDuration: number; targetDuration: number }>
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

type StudioCreationDimensionsV1 = Readonly<{ height?: number; radius?: number; width?: number }>;
type StudioCreationEntityKindV1 = "circle" | "image" | "math-tex" | "other" | "rectangle";
type StudioCreationOperationV1 = Readonly<{
  entityId?: string;
  id: string;
  interval: Readonly<{ end: number; start: number }>;
}> &
  (
    | Readonly<{
        entity: Readonly<{
          dimensions: StudioCreationDimensionsV1;
          id: string;
          kind: StudioCreationEntityKindV1;
          lifetimeStart: number;
          texParts: readonly string[] | null;
        }>;
        kind: "create";
      }>
    | Readonly<{ entityId: string; kind: "position"; position: Readonly<{ x: number; y: number }> | null }>
    | Readonly<{ entityId: string; kind: "fade-in"; persistent: boolean }>
    | Readonly<{ entityId: string; kind: "uniform-scale"; relativeFactor: number | null }>
    | Readonly<{
        entityId: string;
        kind: "resize";
        shape: StudioCreationEntityKindV1;
        toDimensions: StudioCreationDimensionsV1;
        toPosition: Readonly<{ x: number; y: number }>;
      }>
    | Readonly<{ kind: "unsupported" }>
  );

export type ApplyStudioCreationEditWireCommandV1 = Readonly<{
  evaluatedDuration: number;
  evaluatedEntities: readonly Readonly<{
    contentSampleTexParts: readonly (readonly string[] | null)[];
    id: string;
    kind: StudioCreationEntityKindV1;
    lifetimes: readonly Readonly<{ end: number; start: number }>[];
    objectGraphKey: string;
    sourceIdentity: string | null;
    contentTexParts: readonly string[] | null;
    transactionId: string | null;
  }>[];
  evaluatedEvents: readonly Readonly<{
    interval: Readonly<{ end: number; start: number }> | null;
    operationId: string | null;
  }>[];
  expectedBaseRevision: string;
  frame: Readonly<{ height: number; width: number }>;
  mathTexOutlines: readonly Readonly<{
    entityId: string;
    path: Extract<SceneIrBundleV1["scene"]["entities"][number]["geometry"], { kind: "cubic-path" }>["path"];
    texParts: readonly string[];
  }>[];
  nextRevision: string;
  programs: readonly Readonly<{
    anchorSeconds: number;
    loweringSupported: boolean;
    operations: readonly StudioCreationOperationV1[];
    scheduleOrder: readonly string[];
    transactionId: string;
    validationValid: boolean;
  }>[];
  schema: "poietra.apply-studio-creation-edit";
  version: 1;
  viewport: Readonly<{ height: number; width: number }>;
}>;

export type ApplyStudioCreationEditCompiler = (
  snapshot: SceneIrBundleV1,
  command: ApplyStudioCreationEditWireCommandV1,
) => Promise<SceneIrBundleV1>;

export type CreateSceneMotionWireCommandV1 = Readonly<{
  controlOffset: Readonly<{ x: number; y: number }>;
  delta: Readonly<{ x: number; y: number }>;
  easing: "linear" | "smooth";
  expectedBaseRevision: string;
  interval: Readonly<{ end: number; start: number }>;
  nextRevision: string;
  provenance: Readonly<{
    evidence: readonly string[];
    id: string;
    origin: "studio-edit-program";
  }>;
  schema: "poietra.create-scene-motion";
  targetEntityIds: readonly string[];
  version: 1;
}>;

export type CreateSceneMotionCompiler = (
  snapshot: SceneIrBundleV1,
  command: CreateSceneMotionWireCommandV1,
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

type ApplyStaticRootTransformEditBindingsV1 = Readonly<{
  applyStaticRootTransformEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type TransformSceneAtTimeAuthoringBindingsV1 = Readonly<{
  transformSceneEntityAtTimeV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type EditSceneTimelineBindingsV1 = Readonly<{
  editSceneTimelineV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStudioCreationEditBindingsV1 = Readonly<{
  applyStudioCreationEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type CreateSceneMotionBindingsV1 = Readonly<{
  createSceneMotionV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type SetSubtreeVectorPaintAlphaBindingsV1 = Readonly<{
  setSubtreeVectorPaintAlphaV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type SceneAuthoringBindingsV1 = ApplyStaticRootTransformEditBindingsV1 &
  ApplyStudioCreationEditBindingsV1 &
  CreateSceneMotionBindingsV1 &
  EditSceneTimelineBindingsV1 &
  RotateSceneAuthoringBindingsV1 &
  TransformSceneAuthoringBindingsV1 &
  TransformSceneAtTimeAuthoringBindingsV1 &
  SetSubtreeVectorPaintAlphaBindingsV1;

let bindingsPromise: Promise<SceneAuthoringBindingsV1> | null = null;

async function loadBindings(): Promise<SceneAuthoringBindingsV1> {
  if (bindingsPromise) return bindingsPromise;
  const pending: Promise<SceneAuthoringBindingsV1> = (async () => {
    const candidate = await loadPoietraWasmModule();
    if (
      typeof candidate.applyStaticRootTransformEditV1 !== "function" ||
      typeof candidate.applyStudioCreationEditV1 !== "function" ||
      typeof candidate.createSceneMotionV1 !== "function" ||
      typeof candidate.editSceneTimelineV1 !== "function" ||
      typeof candidate.rotateSceneEntityV1 !== "function" ||
      typeof candidate.setSubtreeVectorPaintAlphaV1 !== "function" ||
      typeof candidate.transformSceneEntityAtTimeV1 !== "function" ||
      typeof candidate.transformSceneEntityV1 !== "function"
    ) {
      throw new Error("The Poietra WASM module does not export Scene authoring.");
    }
    return {
      applyStaticRootTransformEditV1:
        candidate.applyStaticRootTransformEditV1 as SceneAuthoringBindingsV1["applyStaticRootTransformEditV1"],
      applyStudioCreationEditV1:
        candidate.applyStudioCreationEditV1 as SceneAuthoringBindingsV1["applyStudioCreationEditV1"],
      createSceneMotionV1: candidate.createSceneMotionV1 as SceneAuthoringBindingsV1["createSceneMotionV1"],
      editSceneTimelineV1: candidate.editSceneTimelineV1 as SceneAuthoringBindingsV1["editSceneTimelineV1"],
      rotateSceneEntityV1: candidate.rotateSceneEntityV1 as SceneAuthoringBindingsV1["rotateSceneEntityV1"],
      setSubtreeVectorPaintAlphaV1:
        candidate.setSubtreeVectorPaintAlphaV1 as SceneAuthoringBindingsV1["setSubtreeVectorPaintAlphaV1"],
      transformSceneEntityAtTimeV1:
        candidate.transformSceneEntityAtTimeV1 as SceneAuthoringBindingsV1["transformSceneEntityAtTimeV1"],
      transformSceneEntityV1: candidate.transformSceneEntityV1 as SceneAuthoringBindingsV1["transformSceneEntityV1"],
    };
  })();
  bindingsPromise = pending;
  return pending;
}

/** Applies the supported static imported-root edit subset through the canonical core. */
export function createApplyStaticRootTransformEditCompiler(
  getBindings: () => Promise<ApplyStaticRootTransformEditBindingsV1>,
): ApplyStaticRootTransformEditCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.applyStaticRootTransformEditV1);
  };
}

async function invokeSceneAuthoringCommand(
  snapshot: SceneIrBundleV1,
  command: unknown,
  invoke: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array,
) {
  const response = invoke(encoder.encode(JSON.stringify(snapshot)), encoder.encode(JSON.stringify(command)));
  return sceneIrBundleV1Schema.parse(JSON.parse(decoder.decode(response)) as unknown);
}

/** Passes the complete normalized Studio creation edit to the canonical core. */
export function createApplyStudioCreationEditCompiler(
  getBindings: () => Promise<ApplyStudioCreationEditBindingsV1>,
): ApplyStudioCreationEditCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.applyStudioCreationEditV1);
  };
}

/** Creates one Studio motion through the canonical Scene core. */
export function createCreateSceneMotionCompiler(
  getBindings: () => Promise<CreateSceneMotionBindingsV1>,
): CreateSceneMotionCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.createSceneMotionV1);
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

/** Creates the browser adapter around one atomic transform at an exact Scene time. */
export function createTransformSceneEntityAtTimeCompiler(
  getBindings: () => Promise<TransformSceneAtTimeAuthoringBindingsV1>,
): TransformSceneEntityAtTimeCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.transformSceneEntityAtTimeV1);
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

export const compileApplyStaticRootTransformEdit = createApplyStaticRootTransformEditCompiler(loadBindings);
export const compileApplyStudioCreationEdit = createApplyStudioCreationEditCompiler(loadBindings);
export const compileCreateSceneMotion = createCreateSceneMotionCompiler(loadBindings);
export const compileEditSceneTimeline = createEditSceneTimelineCompiler(loadBindings);
export const compileRotateSceneEntity = createRotateSceneEntityCompiler(loadBindings);
export const compileTransformSceneEntity = createTransformSceneEntityCompiler(loadBindings);
export const compileTransformSceneEntityAtTime = createTransformSceneEntityAtTimeCompiler(loadBindings);
export const compileSetSubtreeVectorPaintAlpha = createSetSubtreeVectorPaintAlphaCompiler(loadBindings);
