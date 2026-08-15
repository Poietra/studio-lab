import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "./contracts";
import { loadPoietraWasmModule } from "./poietra-wasm-module";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type StudioAuthoringOrigin = "direct-manipulation" | "fixture" | "remote-model" | "studio-default";
type StudioAuthoringAnchorSourceV1 =
  | Readonly<{ kind: "absolute"; seconds: number | null }>
  | Readonly<{ kind: "playhead"; referenceSeconds: number | null }>
  | Readonly<{ kind: "unsupported" }>;
type StudioAuthoringProgramV1<Operation> = Readonly<{
  anchorCapturedPlayhead: number;
  anchorResolvedSeconds: number;
  anchorSource: StudioAuthoringAnchorSourceV1;
  intentCount: number;
  loweringSupported: boolean;
  operations: readonly Operation[];
  origin: StudioAuthoringOrigin;
  requestedExecution: "parallel" | "sequence";
  scheduleEdgeCount: number;
  scheduleMode: "dependency-dag" | "parallel" | "sequence";
  scheduleOrder: readonly string[];
  transactionId: string;
}>;

type StudioBoundEntityEditOperationV1 = Readonly<{
  dependsOn: readonly string[];
  id: string;
  interval: Readonly<{ end: number; start: number }>;
  origin: StudioAuthoringOrigin;
}> &
  (
    | Readonly<{ entityId: string; kind: "move"; position: Readonly<{ x: number; y: number }> | null }>
    | Readonly<{ alpha: number | null; entityId: string; kind: "opacity" }>
    | Readonly<{
        controlPresent: boolean;
        entityId: string;
        from: number | null;
        kind: "rotation";
        relativeDelta: number | null;
        to: number | null;
      }>
    | Readonly<{
        controlPresent: boolean;
        entityId: string;
        from: number | null;
        kind: "uniform-scale";
        relativeFactor: number | null;
        to: number | null;
      }>
    | Readonly<{ entityId: string | null; kind: "unsupported" }>
  );

export type ApplyStudioBoundEntityEditWireCommandV1 = Readonly<{
  candidates: readonly Readonly<{
    baseCenter: Readonly<{ x: number; y: number }>;
    baseOpacity: number | null;
    capabilities: Readonly<{ paintOpacity: boolean; rotation: boolean; uniformScale: boolean }>;
    evidenceId: string;
    phase: "construction" | "settled";
    sceneEntityId: string;
    sourceAnchor: number;
    studioEntityId: string;
  }>[];
  expectedBaseRevision: string;
  frame: Readonly<{ height: number; width: number }>;
  nextRevision: string;
  programs: readonly StudioAuthoringProgramV1<StudioBoundEntityEditOperationV1>[];
  schema: "poietra.apply-studio-bound-entity-edit";
  version: 1;
  viewport: Readonly<{ height: number; width: number }>;
}>;

export type ApplyStudioBoundEntityEditCompiler = (
  snapshot: SceneIrBundleV1,
  command: ApplyStudioBoundEntityEditWireCommandV1,
) => Promise<SceneIrBundleV1>;
type StaticRootTransformEntityKind = "circle" | "image" | "math-tex" | "other" | "rectangle";
type StaticRootTransformDimensions = Readonly<{ height?: number; radius?: number; width?: number }>;
type StaticRootTransformOperation = Readonly<{
  dependsOn: readonly string[];
  entityId: string;
  id: string;
  interval: Readonly<{ end: number; start: number }>;
  origin: StudioAuthoringOrigin;
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
  programs: readonly StudioAuthoringProgramV1<StaticRootTransformOperation>[];
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

type StudioTimelineOperationV1 = Readonly<{
  dependsOn: readonly string[];
  id: string;
  interval: Readonly<{ end: number; start: number }>;
  origin: StudioAuthoringOrigin;
}> &
  (
    | Readonly<{
        eventKind: "play" | "wait";
        kind: "insert-wait";
        purpose: "scene-duration" | null;
      }>
    | Readonly<{
        kind: "trim-scene-duration";
        removedDuration: number;
        targetDuration: number;
        waitOperationIds: readonly string[];
      }>
    | Readonly<{ kind: "unsupported" }>
  );

export type ApplyStudioTimelineEditWireCommandV1 = Readonly<{
  expectedBaseRevision: string;
  nextRevision: string;
  programs: readonly StudioAuthoringProgramV1<StudioTimelineOperationV1>[];
  schema: "poietra.apply-studio-timeline-edit";
  version: 1;
}>;

export type ApplyStudioTimelineEditCompiler = (
  snapshot: SceneIrBundleV1,
  command: ApplyStudioTimelineEditWireCommandV1,
) => Promise<SceneIrBundleV1>;

type StudioCreationDimensionsV1 = Readonly<{ height?: number; radius?: number; width?: number }>;
type StudioCreationEntityKindV1 = "circle" | "image" | "math-tex" | "other" | "rectangle";
type StudioCreationOperationV1 = Readonly<{
  dependsOn: readonly string[];
  entityId?: string;
  id: string;
  interval: Readonly<{ end: number; start: number }>;
  origin: StudioAuthoringOrigin;
}> &
  (
    | Readonly<{
        entity: Readonly<{
          dimensions: StudioCreationDimensionsV1;
          id: string;
          kind: StudioCreationEntityKindV1;
          lifetimeEnd: number | null;
          lifetimeStart: number;
          texParts: readonly string[] | null;
        }>;
        kind: "create";
      }>
    | Readonly<{ entityId: string; kind: "position"; position: Readonly<{ x: number; y: number }> | null }>
    | Readonly<{ entityId: string; kind: "fade-in"; persistent: boolean }>
    | Readonly<{
        controlPresent: boolean;
        entityId: string;
        from: number | null;
        kind: "uniform-scale";
        relativeFactor: number | null;
        to: number | null;
      }>
    | Readonly<{
        entityId: string;
        fromDimensions: StudioCreationDimensionsV1;
        fromPosition: Readonly<{ x: number; y: number }>;
        fromScale: number;
        kind: "resize";
        shape: StudioCreationEntityKindV1;
        toDimensions: StudioCreationDimensionsV1;
        toPosition: Readonly<{ x: number; y: number }>;
      }>
    | Readonly<{ kind: "unsupported" }>
  );

export type ApplyStudioCreationEditWireCommandV1 = Readonly<{
  expectedBaseRevision: string;
  frame: Readonly<{ height: number; width: number }>;
  mathTexOutlines: readonly Readonly<{
    entityId: string;
    path: Extract<SceneIrBundleV1["scene"]["entities"][number]["geometry"], { kind: "cubic-path" }>["path"];
    texParts: readonly string[];
  }>[];
  nextRevision: string;
  programs: readonly StudioAuthoringProgramV1<StudioCreationOperationV1>[];
  schema: "poietra.apply-studio-creation-edit";
  version: 1;
  viewport: Readonly<{ height: number; width: number }>;
}>;

export type ApplyStudioCreationEditCompiler = (
  snapshot: SceneIrBundleV1,
  command: ApplyStudioCreationEditWireCommandV1,
) => Promise<SceneIrBundleV1>;

type StudioMotionOperationV1 = Readonly<{
  dependsOn: readonly string[];
  id: string;
  interval: Readonly<{ end: number; start: number }>;
  origin: StudioAuthoringOrigin;
}> &
  (
    | Readonly<{
        controlOffset: Readonly<{ x: number; y: number }>;
        delta: Readonly<{ x: number; y: number }>;
        easing: "linear" | "smooth";
        kind: "create-motion";
        targetEntityIds: readonly string[];
      }>
    | Readonly<{ kind: "unsupported" }>
  );

export type ApplyStudioMotionEditWireCommandV1 = Readonly<{
  expectedBaseRevision: string;
  frame: Readonly<{ height: number; width: number }>;
  nextRevision: string;
  programs: readonly StudioAuthoringProgramV1<StudioMotionOperationV1>[];
  schema: "poietra.apply-studio-motion-edit";
  sourceRuntimeBindings: readonly Readonly<{
    runtimeEntityId: string;
    sourceIdentityKey: string;
    sourceName: string;
  }>[];
  studioEntities: readonly Readonly<{
    objectGraphKey: string;
    provisional: boolean;
    sourceIdentity: string | null;
  }>[];
  version: 1;
  viewport: Readonly<{ height: number; width: number }>;
}>;

export type ApplyStudioMotionEditCompiler = (
  snapshot: SceneIrBundleV1,
  command: ApplyStudioMotionEditWireCommandV1,
) => Promise<SceneIrBundleV1>;

type ApplyStudioBoundEntityEditBindingsV1 = Readonly<{
  applyStudioBoundEntityEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStaticRootTransformEditBindingsV1 = Readonly<{
  applyStaticRootTransformEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStudioTimelineEditBindingsV1 = Readonly<{
  applyStudioTimelineEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStudioCreationEditBindingsV1 = Readonly<{
  applyStudioCreationEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStudioMotionEditBindingsV1 = Readonly<{
  applyStudioMotionEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type SceneAuthoringBindingsV1 = ApplyStaticRootTransformEditBindingsV1 &
  ApplyStudioBoundEntityEditBindingsV1 &
  ApplyStudioCreationEditBindingsV1 &
  ApplyStudioMotionEditBindingsV1 &
  ApplyStudioTimelineEditBindingsV1;

let bindingsPromise: Promise<SceneAuthoringBindingsV1> | null = null;

async function loadBindings(): Promise<SceneAuthoringBindingsV1> {
  if (bindingsPromise) return bindingsPromise;
  const pending: Promise<SceneAuthoringBindingsV1> = (async () => {
    const candidate = await loadPoietraWasmModule();
    if (
      typeof candidate.applyStaticRootTransformEditV1 !== "function" ||
      typeof candidate.applyStudioBoundEntityEditV1 !== "function" ||
      typeof candidate.applyStudioCreationEditV1 !== "function" ||
      typeof candidate.applyStudioMotionEditV1 !== "function" ||
      typeof candidate.applyStudioTimelineEditV1 !== "function"
    ) {
      throw new Error("The Poietra WASM module does not export Scene authoring.");
    }
    return {
      applyStaticRootTransformEditV1:
        candidate.applyStaticRootTransformEditV1 as SceneAuthoringBindingsV1["applyStaticRootTransformEditV1"],
      applyStudioBoundEntityEditV1:
        candidate.applyStudioBoundEntityEditV1 as SceneAuthoringBindingsV1["applyStudioBoundEntityEditV1"],
      applyStudioCreationEditV1:
        candidate.applyStudioCreationEditV1 as SceneAuthoringBindingsV1["applyStudioCreationEditV1"],
      applyStudioMotionEditV1: candidate.applyStudioMotionEditV1 as SceneAuthoringBindingsV1["applyStudioMotionEditV1"],
      applyStudioTimelineEditV1:
        candidate.applyStudioTimelineEditV1 as SceneAuthoringBindingsV1["applyStudioTimelineEditV1"],
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

/** Passes one complete normalized Studio motion edit to the canonical core. */
export function createApplyStudioMotionEditCompiler(
  getBindings: () => Promise<ApplyStudioMotionEditBindingsV1>,
): ApplyStudioMotionEditCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.applyStudioMotionEditV1);
  };
}

/** Passes one complete source-bound endpoint edit to the canonical core. */
export function createApplyStudioBoundEntityEditCompiler(
  getBindings: () => Promise<ApplyStudioBoundEntityEditBindingsV1>,
): ApplyStudioBoundEntityEditCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.applyStudioBoundEntityEditV1);
  };
}

/** Passes one complete normalized Studio timeline edit to the canonical core. */
export function createApplyStudioTimelineEditCompiler(
  getBindings: () => Promise<ApplyStudioTimelineEditBindingsV1>,
): ApplyStudioTimelineEditCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeSceneAuthoringCommand(snapshot, command, bindings.applyStudioTimelineEditV1);
  };
}

export const compileApplyStaticRootTransformEdit = createApplyStaticRootTransformEditCompiler(loadBindings);
export const compileApplyStudioBoundEntityEdit = createApplyStudioBoundEntityEditCompiler(loadBindings);
export const compileApplyStudioCreationEdit = createApplyStudioCreationEditCompiler(loadBindings);
export const compileApplyStudioMotionEdit = createApplyStudioMotionEditCompiler(loadBindings);
export const compileApplyStudioTimelineEdit = createApplyStudioTimelineEditCompiler(loadBindings);
