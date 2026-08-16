import { z } from "zod";
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
  id: string;
  interval: Readonly<{ end: number; start: number }>;
  origin: StudioAuthoringOrigin;
}> &
  (
    | Readonly<{
        entityId: string;
        kind: "position";
        position: Readonly<{ x: number; y: number }> | null;
      }>
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
        fromDimensions: StaticRootTransformDimensions;
        fromPosition: Readonly<{ x: number; y: number }>;
        fromScale: number;
        kind: "resize";
        shape: StaticRootTransformEntityKind;
        toDimensions: StaticRootTransformDimensions;
        toPosition: Readonly<{ x: number; y: number }>;
      }>
    | Readonly<{
        content: StudioMathTexContentV1;
        entityId: string;
        kind: "math-tex-content";
      }>
    | Readonly<{
        controlOffset: Readonly<{ x: number; y: number }>;
        delta: Readonly<{ x: number; y: number }>;
        easing: "linear" | "smooth";
        kind: "create-motion";
        targetEntityIds: readonly string[];
      }>
    | Readonly<{ entityId: string; kind: "persistent-remove"; persistent: boolean }>
    | Readonly<{ kind: "unsupported" }>
  );

export type StudioPersistentRemoveProjectionEntryV1 = Readonly<{
  affectedSceneEntityIds: readonly string[];
  fadeInterval: Readonly<{ end: number; start: number }> | null;
  operationId: string;
  removedAt: number;
  resultingLifetimeEnd: number;
  sceneEntityId: string;
  studioEntityId: string;
  transactionId: string;
}>;

export type StudioPersistentRemoveProjectionV1 = Readonly<{
  removals: readonly StudioPersistentRemoveProjectionEntryV1[];
}>;

export type StudioMathTexContentV1 = Readonly<{
  displayLines: readonly string[];
  label?: string;
  texParts: readonly string[];
}>;

export type StudioStaticRootMutationV1 =
  | Readonly<{
      entityId: string;
      interval: Readonly<{ end: number; start: number }>;
      kind: "position";
      operationId: string;
      transactionId: string;
      value: Readonly<{ x: number; y: number }>;
    }>
  | Readonly<{
      content: StudioMathTexContentV1;
      entityId: string;
      interval: Readonly<{ end: number; start: number }>;
      kind: "math-tex-content";
      operationId: string;
      transactionId: string;
    }>
  | Readonly<{
      easing?: "manim-smooth";
      entityId: string;
      from: number;
      interval: Readonly<{ end: number; start: number }>;
      kind: "uniform-scale";
      operationId: string;
      to: number;
      transactionId: string;
    }>
  | Readonly<{
      entityId: string;
      fromDimensions: StaticRootTransformDimensions;
      fromPosition: Readonly<{ x: number; y: number }>;
      interval: Readonly<{ end: number; start: number }>;
      kind: "resize";
      operationId: string;
      toDimensions: StaticRootTransformDimensions;
      toPosition: Readonly<{ x: number; y: number }>;
      transactionId: string;
    }>;

export type StudioStaticRootProjectionV1 = Readonly<{
  insertions: StudioMotionProjectionV1["insertions"];
  mutations: readonly StudioStaticRootMutationV1[];
  projectedDuration: number;
}>;

export type StudioMathTexTransformProjectionV1 = Readonly<{
  insertions: readonly Readonly<{
    at: number;
    duration: number;
    transactionId: string;
  }>[];
  projectedDuration: number;
  motions: readonly StudioProjectedMotionV1[];
  replacements: readonly Readonly<{
    content: StudioMathTexContentV1;
    interval: Readonly<{ end: number; start: number }>;
    operationId: string;
    sourceEntityId: string;
    targetEntityId: string;
    targetLifetime: Readonly<{ end: number; start: number }>;
    targetType: "math-tex";
    transactionId: string;
  }>[];
}>;

export type StudioProjectedMotionV1 = Readonly<{
  control: Readonly<{ x: number; y: number }>;
  controlOffset: Readonly<{ x: number; y: number }>;
  delta: Readonly<{ x: number; y: number }>;
  easing: "linear" | "smooth";
  from: Readonly<{ x: number; y: number }>;
  interval: Readonly<{ end: number; start: number }>;
  operationId: string;
  sourceInterval: Readonly<{ end: number; start: number }>;
  targetEntityId: string;
  to: Readonly<{ x: number; y: number }>;
  transactionId: string;
}>;

export type StudioMotionProjectionV1 = Readonly<{
  insertions: readonly Readonly<{
    at: number;
    duration: number;
    transactionId: string;
  }>[];
  motions: readonly StudioProjectedMotionV1[];
  projectedDuration: number;
}>;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/** Complete snapshot-free Rust projection for one Studio-created entity history. */
export type StudioCreationProjectionV1 = DeepReadonly<z.infer<typeof studioCreationProjectionV1Schema>>;
export type StudioCreationProjectionEntityV1 = StudioCreationProjectionV1["entities"][number];
export type StudioCreationProjectionMutationV1 = StudioCreationProjectionV1["mutations"][number];

export type StudioAuthoringEditResultV1 = Readonly<{
  bundle: SceneIrBundleV1;
  creationProjection?: StudioCreationProjectionV1;
  mathTexTransformProjection?: StudioMathTexTransformProjectionV1;
  motionProjection?: StudioMotionProjectionV1;
  persistentRemoveProjection: StudioPersistentRemoveProjectionV1;
  staticRootProjection?: StudioStaticRootProjectionV1;
}>;

export type ApplyStaticRootTransformEditWireCommandV1 = Readonly<{
  expectedBaseRevision: string;
  frame: Readonly<{ height: number; width: number }>;
  mathTexOutlines: readonly Readonly<{
    entityId: string;
    path: Extract<SceneIrBundleV1["scene"]["entities"][number]["geometry"], { kind: "cubic-path" }>["path"];
    texParts: readonly string[];
  }>[];
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
) => Promise<StudioAuthoringEditResultV1>;

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

export type ProjectStudioTimelineWireCommandV1 = Readonly<{
  baseDuration: number;
  programs: readonly StudioAuthoringProgramV1<StudioTimelineOperationV1>[];
  schema: "poietra.project-studio-timeline";
  version: 1;
}>;

export type StudioTimelineProgramProjectionV1 = Readonly<{
  operationId: string;
  transactionId: string;
  workingAnchor: number;
  workingInterval: Readonly<{ end: number; start: number }>;
}>;

export type StudioTimelineEditTransformV1 =
  | Readonly<{
      interval: Readonly<{ end: number; start: number }>;
      kind: "insert";
      operationId: string;
    }>
  | Readonly<{
      interval: Readonly<{ end: number; start: number }>;
      kind: "remove";
      operationId: string;
      waitReductions: readonly StudioTimelineWaitReductionV1[];
    }>;

export type StudioTimelineWaitReductionV1 = Readonly<{
  operationId: string;
  removedDuration: number;
}>;

export type StudioTimelineProjectionV1 = Readonly<{
  programProjections: readonly StudioTimelineProgramProjectionV1[];
  projectedDuration: number;
  transforms: readonly StudioTimelineEditTransformV1[];
}>;

export type ProjectStudioTimelineCompiler = (
  command: ProjectStudioTimelineWireCommandV1,
) => Promise<StudioTimelineProjectionV1>;

const finiteNumberSchema = z.number().finite();
const studioTimelineProjectionIntervalV1Schema = z
  .object({ end: finiteNumberSchema, start: finiteNumberSchema })
  .strict();
const studioPersistentRemoveProjectionV1Schema = z
  .object({
    removals: z.array(
      z
        .object({
          affectedSceneEntityIds: z.array(z.string().min(1)),
          fadeInterval: studioTimelineProjectionIntervalV1Schema.nullable(),
          operationId: z.string().min(1),
          removedAt: finiteNumberSchema,
          resultingLifetimeEnd: finiteNumberSchema,
          sceneEntityId: z.string().min(1),
          studioEntityId: z.string().min(1),
          transactionId: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
const studioStaticRootPointV1Schema = z.object({ x: finiteNumberSchema, y: finiteNumberSchema }).strict();
const studioStaticRootDimensionsV1Schema = z
  .object({
    height: finiteNumberSchema.optional(),
    radius: finiteNumberSchema.optional(),
    width: finiteNumberSchema.optional(),
  })
  .strict();
const studioMathTexContentV1Schema = z
  .object({
    displayLines: z.array(z.string()).min(1),
    label: z.string().optional(),
    texParts: z.array(z.string().min(1)).min(1),
  })
  .strict();
const studioProjectedMotionV1Schema = z
  .object({
    control: studioStaticRootPointV1Schema,
    controlOffset: studioStaticRootPointV1Schema,
    delta: studioStaticRootPointV1Schema,
    easing: z.enum(["linear", "smooth"]),
    from: studioStaticRootPointV1Schema,
    interval: studioTimelineProjectionIntervalV1Schema,
    operationId: z.string().min(1),
    sourceInterval: studioTimelineProjectionIntervalV1Schema,
    targetEntityId: z.string().min(1),
    to: studioStaticRootPointV1Schema,
    transactionId: z.string().min(1),
  })
  .strict();
const studioMotionProjectionV1Schema = z
  .object({
    insertions: z.array(
      z
        .object({
          at: finiteNumberSchema,
          duration: finiteNumberSchema,
          transactionId: z.string().min(1),
        })
        .strict(),
    ),
    motions: z.array(studioProjectedMotionV1Schema),
    projectedDuration: finiteNumberSchema,
  })
  .strict();
const studioCreationProjectionV1Schema = z
  .object({
    entities: z.array(
      z
        .object({
          createdLifetime: studioTimelineProjectionIntervalV1Schema,
          entityId: z.string().min(1),
          initialDimensions: studioStaticRootDimensionsV1Schema,
          initialScale: finiteNumberSchema.positive(),
          kind: z.enum(["circle", "line", "math-tex", "rectangle"]),
          operationId: z.string().min(1),
          texParts: z.array(z.string().min(1)).optional(),
          transactionId: z.string().min(1),
        })
        .strict(),
    ),
    insertions: studioMotionProjectionV1Schema.shape.insertions,
    motions: z.array(studioProjectedMotionV1Schema),
    mutations: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            entityId: z.string().min(1),
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("position"),
            operationId: z.string().min(1),
            transactionId: z.string().min(1),
            value: studioStaticRootPointV1Schema,
          })
          .strict(),
        z
          .object({
            entityId: z.string().min(1),
            from: finiteNumberSchema,
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("fade-in"),
            operationId: z.string().min(1),
            to: finiteNumberSchema,
            transactionId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            entityId: z.string().min(1),
            from: finiteNumberSchema.positive(),
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("uniform-scale"),
            operationId: z.string().min(1),
            to: finiteNumberSchema.positive(),
            transactionId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            entityId: z.string().min(1),
            fromDimensions: studioStaticRootDimensionsV1Schema,
            fromPosition: studioStaticRootPointV1Schema,
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("resize"),
            operationId: z.string().min(1),
            toDimensions: studioStaticRootDimensionsV1Schema,
            toPosition: studioStaticRootPointV1Schema,
            transactionId: z.string().min(1),
          })
          .strict(),
      ]),
    ),
    projectedDuration: finiteNumberSchema,
    removals: studioPersistentRemoveProjectionV1Schema.shape.removals,
  })
  .strict();
const studioStaticRootProjectionV1Schema = z
  .object({
    insertions: studioMotionProjectionV1Schema.shape.insertions,
    mutations: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            entityId: z.string().min(1),
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("position"),
            operationId: z.string().min(1),
            transactionId: z.string().min(1),
            value: studioStaticRootPointV1Schema,
          })
          .strict(),
        z
          .object({
            content: studioMathTexContentV1Schema,
            entityId: z.string().min(1),
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("math-tex-content"),
            operationId: z.string().min(1),
            transactionId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            easing: z.literal("manim-smooth").optional(),
            entityId: z.string().min(1),
            from: finiteNumberSchema,
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("uniform-scale"),
            operationId: z.string().min(1),
            to: finiteNumberSchema,
            transactionId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            entityId: z.string().min(1),
            fromDimensions: studioStaticRootDimensionsV1Schema,
            fromPosition: studioStaticRootPointV1Schema,
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("resize"),
            operationId: z.string().min(1),
            toDimensions: studioStaticRootDimensionsV1Schema,
            toPosition: studioStaticRootPointV1Schema,
            transactionId: z.string().min(1),
          })
          .strict(),
      ]),
    ),
    projectedDuration: finiteNumberSchema,
  })
  .strict();
const studioMathTexTransformProjectionV1Schema = z
  .object({
    insertions: z.array(
      z
        .object({
          at: finiteNumberSchema,
          duration: finiteNumberSchema,
          transactionId: z.string().min(1),
        })
        .strict(),
    ),
    projectedDuration: finiteNumberSchema,
    motions: z.array(studioProjectedMotionV1Schema),
    replacements: z.array(
      z
        .object({
          content: studioMathTexContentV1Schema,
          interval: studioTimelineProjectionIntervalV1Schema,
          operationId: z.string().min(1),
          sourceEntityId: z.string().min(1),
          targetEntityId: z.string().min(1),
          targetLifetime: studioTimelineProjectionIntervalV1Schema,
          targetType: z.literal("math-tex"),
          transactionId: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
const studioAuthoringEditResultV1Schema = z
  .object({
    bundle: sceneIrBundleV1Schema,
    creationProjection: studioCreationProjectionV1Schema.optional(),
    mathTexTransformProjection: studioMathTexTransformProjectionV1Schema.optional(),
    motionProjection: studioMotionProjectionV1Schema.optional(),
    persistentRemoveProjection: studioPersistentRemoveProjectionV1Schema,
    staticRootProjection: studioStaticRootProjectionV1Schema.optional(),
  })
  .strict();
const studioTimelineProjectionV1Schema = z
  .object({
    programProjections: z.array(
      z
        .object({
          operationId: z.string().min(1),
          transactionId: z.string().min(1),
          workingAnchor: finiteNumberSchema,
          workingInterval: studioTimelineProjectionIntervalV1Schema,
        })
        .strict(),
    ),
    projectedDuration: finiteNumberSchema,
    transforms: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("insert"),
            operationId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            interval: studioTimelineProjectionIntervalV1Schema,
            kind: z.literal("remove"),
            operationId: z.string().min(1),
            waitReductions: z.array(
              z
                .object({
                  operationId: z.string().min(1),
                  removedDuration: finiteNumberSchema.positive(),
                })
                .strict(),
            ),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

type StudioCreationDimensionsV1 = Readonly<{ height?: number; radius?: number; width?: number }>;
type StudioCreationEntityKindV1 = "circle" | "image" | "line" | "math-tex" | "other" | "rectangle";
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
    | Readonly<{ entityId: string; kind: "persistent-remove"; persistent: boolean }>
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
    | Readonly<{
        controlOffset: Readonly<{ x: number; y: number }>;
        delta: Readonly<{ x: number; y: number }>;
        easing: "linear" | "smooth";
        kind: "create-motion";
        targetEntityIds: readonly string[];
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
) => Promise<StudioAuthoringEditResultV1>;

export type ProjectStudioCreationEditWireCommandV1 = Readonly<{
  baseDuration: number;
  programs: readonly StudioAuthoringProgramV1<StudioCreationOperationV1>[];
  schema: "poietra.project-studio-creation-edit";
  version: 1;
}>;

export type ProjectStudioCreationCompiler = (
  command: ProjectStudioCreationEditWireCommandV1,
) => Promise<StudioCreationProjectionV1>;

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

type ProjectStudioMotionBatchV1 =
  | Readonly<{
      kind: "standalone";
      programs: readonly StudioAuthoringProgramV1<StudioMotionOperationV1>[];
      studioEntities: readonly Readonly<{
        lifetime: readonly Readonly<{ end: number; start: number }>[];
        objectGraphKey: string;
        position: Readonly<{ x: number; y: number }> | null;
        provisional: boolean;
        sourceIdentity: string | null;
      }>[];
    }>
  | Readonly<{
      kind: "static-root";
      programs: readonly StudioAuthoringProgramV1<StaticRootTransformOperation>[];
      studioEntities: readonly Readonly<{
        dimensions: StaticRootTransformDimensions;
        id: string;
        kind: StaticRootTransformEntityKind;
        lifetime: readonly Readonly<{ end: number; start: number }>[];
        objectGraphKey: string;
        position: Readonly<{ x: number; y: number }> | null;
        provisional: boolean;
        scale: number | null;
        sourceIdentity: string | null;
        transactionId?: string;
      }>[];
    }>;

export type ProjectStudioMotionEditWireCommandV1 = Readonly<{
  baseDuration: number;
  batch: ProjectStudioMotionBatchV1;
  schema: "poietra.project-studio-motion-edit";
  version: 1;
}>;

export type ProjectStudioMotionCompiler = (
  command: ProjectStudioMotionEditWireCommandV1,
) => Promise<StudioMotionProjectionV1>;

type StudioMathTexTransformOperationV1 = Readonly<{
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
    | Readonly<{
        kind: "transform-content";
        replacement: StudioMathTexContentV1 | null;
        sourceEntityId: string;
        strategy: "replacement-transform" | "transform-matching-tex";
        targetEntityId: string;
        targetType: string | null;
      }>
    | Readonly<{ kind: "unsupported" }>
  );

export type ApplyStudioMathTexTransformEditWireCommandV1 = Readonly<{
  expectedBaseRevision: string;
  frame: Readonly<{ height: number; width: number }>;
  mathTexOutlines: readonly Readonly<{
    entityId: string;
    path: Extract<SceneIrBundleV1["scene"]["entities"][number]["geometry"], { kind: "cubic-path" }>["path"];
    texParts: readonly string[];
  }>[];
  nextRevision: string;
  programs: readonly StudioAuthoringProgramV1<StudioMathTexTransformOperationV1>[];
  schema: "poietra.apply-studio-math-tex-transform-edit";
  sourceRuntimeBindings: readonly Readonly<{
    runtimeEntityId: string;
    sourceIdentityKey: string;
    sourceName: string;
  }>[];
  studioEntities: readonly Readonly<{
    objectGraphKey: string;
    position: Readonly<{ x: number; y: number }> | null;
    provisional: boolean;
    scale: number | null;
    sourceIdentity: string | null;
    type: StaticRootTransformEntityKind;
  }>[];
  version: 1;
  viewport: Readonly<{ height: number; width: number }>;
}>;

export type ApplyStudioMathTexTransformEditCompiler = (
  snapshot: SceneIrBundleV1,
  command: ApplyStudioMathTexTransformEditWireCommandV1,
) => Promise<StudioAuthoringEditResultV1>;

export type ProjectStudioMathTexTransformWireCommandV1 = Readonly<{
  baseDuration: number;
  programs: readonly StudioAuthoringProgramV1<StudioMathTexTransformOperationV1>[];
  schema: "poietra.project-studio-math-tex-transform";
  studioEntities: readonly Readonly<{
    lifetime: readonly Readonly<{ end: number; start: number }>[];
    objectGraphKey: string;
    position: Readonly<{ x: number; y: number }> | null;
    provisional: boolean;
    scale: number | null;
    sourceIdentity: string | null;
    type: StaticRootTransformEntityKind;
  }>[];
  version: 1;
}>;

export type ProjectStudioMathTexTransformCompiler = (
  command: ProjectStudioMathTexTransformWireCommandV1,
) => Promise<StudioMathTexTransformProjectionV1>;

type ApplyStudioBoundEntityEditBindingsV1 = Readonly<{
  applyStudioBoundEntityEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStaticRootTransformEditBindingsV1 = Readonly<{
  applyStaticRootTransformEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStudioTimelineEditBindingsV1 = Readonly<{
  applyStudioTimelineEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ProjectStudioTimelineBindingsV1 = Readonly<{
  projectStudioTimelineV1: (commandJson: Uint8Array) => Uint8Array;
}>;

type ProjectStudioMathTexTransformBindingsV1 = Readonly<{
  projectStudioMathTexTransformV1: (commandJson: Uint8Array) => Uint8Array;
}>;

type ProjectStudioMotionBindingsV1 = Readonly<{
  projectStudioMotionEditV1: (commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStudioCreationEditBindingsV1 = Readonly<{
  applyStudioCreationEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ProjectStudioCreationBindingsV1 = Readonly<{
  projectStudioCreationEditV1: (commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStudioMotionEditBindingsV1 = Readonly<{
  applyStudioMotionEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type ApplyStudioMathTexTransformEditBindingsV1 = Readonly<{
  applyStudioMathTexTransformEditV1: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array;
}>;

type SceneAuthoringBindingsV1 = ApplyStaticRootTransformEditBindingsV1 &
  ApplyStudioBoundEntityEditBindingsV1 &
  ApplyStudioCreationEditBindingsV1 &
  ApplyStudioMathTexTransformEditBindingsV1 &
  ApplyStudioMotionEditBindingsV1 &
  ApplyStudioTimelineEditBindingsV1 &
  ProjectStudioCreationBindingsV1 &
  ProjectStudioMathTexTransformBindingsV1 &
  ProjectStudioMotionBindingsV1 &
  ProjectStudioTimelineBindingsV1;

let bindingsPromise: Promise<SceneAuthoringBindingsV1> | null = null;

async function loadBindings(): Promise<SceneAuthoringBindingsV1> {
  if (bindingsPromise) return bindingsPromise;
  const pending: Promise<SceneAuthoringBindingsV1> = (async () => {
    const candidate = await loadPoietraWasmModule();
    if (
      typeof candidate.applyStaticRootTransformEditV1 !== "function" ||
      typeof candidate.applyStudioBoundEntityEditV1 !== "function" ||
      typeof candidate.applyStudioCreationEditV1 !== "function" ||
      typeof candidate.applyStudioMathTexTransformEditV1 !== "function" ||
      typeof candidate.applyStudioMotionEditV1 !== "function" ||
      typeof candidate.applyStudioTimelineEditV1 !== "function" ||
      typeof candidate.projectStudioCreationEditV1 !== "function" ||
      typeof candidate.projectStudioMathTexTransformV1 !== "function" ||
      typeof candidate.projectStudioMotionEditV1 !== "function" ||
      typeof candidate.projectStudioTimelineV1 !== "function"
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
      applyStudioMathTexTransformEditV1:
        candidate.applyStudioMathTexTransformEditV1 as SceneAuthoringBindingsV1["applyStudioMathTexTransformEditV1"],
      applyStudioMotionEditV1: candidate.applyStudioMotionEditV1 as SceneAuthoringBindingsV1["applyStudioMotionEditV1"],
      applyStudioTimelineEditV1:
        candidate.applyStudioTimelineEditV1 as SceneAuthoringBindingsV1["applyStudioTimelineEditV1"],
      projectStudioCreationEditV1:
        candidate.projectStudioCreationEditV1 as SceneAuthoringBindingsV1["projectStudioCreationEditV1"],
      projectStudioMathTexTransformV1:
        candidate.projectStudioMathTexTransformV1 as SceneAuthoringBindingsV1["projectStudioMathTexTransformV1"],
      projectStudioMotionEditV1:
        candidate.projectStudioMotionEditV1 as SceneAuthoringBindingsV1["projectStudioMotionEditV1"],
      projectStudioTimelineV1: candidate.projectStudioTimelineV1 as SceneAuthoringBindingsV1["projectStudioTimelineV1"],
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
    return invokeStudioAuthoringEditCommand(snapshot, command, bindings.applyStaticRootTransformEditV1);
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

async function invokeStudioAuthoringEditCommand(
  snapshot: SceneIrBundleV1,
  command: unknown,
  invoke: (snapshotJson: Uint8Array, commandJson: Uint8Array) => Uint8Array,
) {
  const response = invoke(encoder.encode(JSON.stringify(snapshot)), encoder.encode(JSON.stringify(command)));
  return studioAuthoringEditResultV1Schema.parse(JSON.parse(decoder.decode(response)) as unknown);
}

/** Passes the complete normalized Studio creation edit to the canonical core. */
export function createApplyStudioCreationEditCompiler(
  getBindings: () => Promise<ApplyStudioCreationEditBindingsV1>,
): ApplyStudioCreationEditCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeStudioAuthoringEditCommand(snapshot, command, bindings.applyStudioCreationEditV1);
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

/** Passes one complete normalized MathTex content-transform batch to the canonical core. */
export function createApplyStudioMathTexTransformEditCompiler(
  getBindings: () => Promise<ApplyStudioMathTexTransformEditBindingsV1>,
): ApplyStudioMathTexTransformEditCompiler {
  return async (snapshot, command) => {
    const bindings = await getBindings();
    return invokeStudioAuthoringEditCommand(snapshot, command, bindings.applyStudioMathTexTransformEditV1);
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

/** Projects normalized timeline Programs through the canonical core without a Scene snapshot. */
export function createProjectStudioTimelineCompiler(
  getBindings: () => Promise<ProjectStudioTimelineBindingsV1>,
): ProjectStudioTimelineCompiler {
  return async (command) => {
    const bindings = await getBindings();
    const response = bindings.projectStudioTimelineV1(encoder.encode(JSON.stringify(command)));
    return studioTimelineProjectionV1Schema.parse(JSON.parse(decoder.decode(response)) as unknown);
  };
}

/** Projects one normalized MathTex transform batch without requiring a render snapshot. */
export function createProjectStudioMathTexTransformCompiler(
  getBindings: () => Promise<ProjectStudioMathTexTransformBindingsV1>,
): ProjectStudioMathTexTransformCompiler {
  return async (command) => {
    const bindings = await getBindings();
    const response = bindings.projectStudioMathTexTransformV1(encoder.encode(JSON.stringify(command)));
    return studioMathTexTransformProjectionV1Schema.parse(JSON.parse(decoder.decode(response)) as unknown);
  };
}

/** Projects one normalized motion-bearing Program batch without requiring a render snapshot. */
export function createProjectStudioMotionCompiler(
  getBindings: () => Promise<ProjectStudioMotionBindingsV1>,
): ProjectStudioMotionCompiler {
  return async (command) => {
    const bindings = await getBindings();
    const response = bindings.projectStudioMotionEditV1(encoder.encode(JSON.stringify(command)));
    return studioMotionProjectionV1Schema.parse(JSON.parse(decoder.decode(response)) as unknown);
  };
}

/** Projects one complete Studio-created entity history without a Scene snapshot. */
export function createProjectStudioCreationCompiler(
  getBindings: () => Promise<ProjectStudioCreationBindingsV1>,
): ProjectStudioCreationCompiler {
  return async (command) => {
    const bindings = await getBindings();
    const response = bindings.projectStudioCreationEditV1(encoder.encode(JSON.stringify(command)));
    return studioCreationProjectionV1Schema.parse(JSON.parse(decoder.decode(response)) as unknown);
  };
}

export const compileApplyStaticRootTransformEdit = createApplyStaticRootTransformEditCompiler(loadBindings);
export const compileApplyStudioBoundEntityEdit = createApplyStudioBoundEntityEditCompiler(loadBindings);
export const compileApplyStudioCreationEdit = createApplyStudioCreationEditCompiler(loadBindings);
export const compileApplyStudioMathTexTransformEdit = createApplyStudioMathTexTransformEditCompiler(loadBindings);
export const compileApplyStudioMotionEdit = createApplyStudioMotionEditCompiler(loadBindings);
export const compileApplyStudioTimelineEdit = createApplyStudioTimelineEditCompiler(loadBindings);
export const projectStudioCreation = createProjectStudioCreationCompiler(loadBindings);
export const projectStudioMathTexTransform = createProjectStudioMathTexTransformCompiler(loadBindings);
export const projectStudioMotion = createProjectStudioMotionCompiler(loadBindings);
export const projectStudioTimeline = createProjectStudioTimelineCompiler(loadBindings);
