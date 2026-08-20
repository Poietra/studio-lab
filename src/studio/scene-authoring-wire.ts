import type {
  ApplyStaticRootTransformEditWireCommandV1,
  ApplyStudioCreationEditWireCommandV1,
  ApplyStudioMathTexTransformEditWireCommandV1,
  ApplyStudioMotionEditWireCommandV1,
  ProjectStudioCreationEditWireCommandV1,
  ProjectStudioMathTexTransformWireCommandV1,
  ProjectStudioMotionEditWireCommandV1,
  StudioMathTexContentV1,
} from "../engine/scene-authoring";
import {
  canonicalEditableContent,
  studioCreationTextContent as canonicalStudioCreationTextContent,
} from "./editable-content";
import type { RuntimeSceneState } from "./model";
import { isPointValue } from "./property-sampling";
import { isCanonicalRgbHex, type SceneEdit, type SceneEditOperation } from "./scene-edit-contract";

type StaticRootTransformCommandInput = Omit<
  ApplyStaticRootTransformEditWireCommandV1,
  "mathTexOutlines" | "programs" | "schema" | "version"
> &
  Readonly<{
    mathTexOutlines?: ApplyStaticRootTransformEditWireCommandV1["mathTexOutlines"];
    programs: readonly SceneEdit[];
  }>;

type StudioCreationCommandInput = Omit<
  ApplyStudioCreationEditWireCommandV1,
  "programs" | "schema" | "textOutlines" | "version"
> &
  Readonly<{
    programs: readonly SceneEdit[];
    textOutlines?: ApplyStudioCreationEditWireCommandV1["textOutlines"];
  }>;

type StudioMotionCommandInput = Omit<ApplyStudioMotionEditWireCommandV1, "programs" | "schema" | "version"> &
  Readonly<{ programs: readonly SceneEdit[] }>;

type StudioMathTexTransformCommandInput = Omit<
  ApplyStudioMathTexTransformEditWireCommandV1,
  "programs" | "schema" | "version"
> &
  Readonly<{ programs: readonly SceneEdit[] }>;

type StudioMathTexTransformProjectionCommandInput = Omit<
  ProjectStudioMathTexTransformWireCommandV1,
  "programs" | "schema" | "version"
> &
  Readonly<{ programs: readonly SceneEdit[] }>;

type StudioMotionProjectionCommandInput = Readonly<{
  baseDuration: number;
  programs: readonly SceneEdit[];
  runtimeSceneState: RuntimeSceneState;
}>;

type StudioCreationProjectionCommandInput = Omit<
  ProjectStudioCreationEditWireCommandV1,
  "programs" | "schema" | "version"
> &
  Readonly<{ programs: readonly SceneEdit[] }>;

function studioProgramEnvelope(program: SceneEdit) {
  const source = program.anchor.source;
  const anchorSource =
    source.kind === "absolute"
      ? ({ kind: "absolute", seconds: source.seconds } as const)
      : source.kind === "playhead"
        ? ({ kind: "playhead", referenceSeconds: source.referenceSeconds } as const)
        : ({ kind: "unsupported" } as const);
  return {
    anchorCapturedPlayhead: program.anchor.capturedPlayhead,
    anchorResolvedSeconds: program.anchor.resolvedSeconds,
    anchorSource,
    intentCount: program.intentCount,
    loweringSupported: program.loweringStatus === "supported",
    origin: program.provenance.origin,
    requestedExecution: program.requestedExecution,
    scheduleEdgeCount: program.schedule.edges.length,
    scheduleMode: program.schedule.mode,
    scheduleOrder: program.schedule.order,
    transactionId: program.transactionId,
  };
}

function normalizedStaticRootOperation(
  operation: SceneEditOperation,
): ApplyStaticRootTransformEditWireCommandV1["programs"][number]["operations"][number] {
  const common = {
    dependsOn: operation.dependsOn,
    id: operation.id,
    interval: operation.interval,
    origin: operation.provenance.origin,
  };
  if (operation.kind === "SetProperty" && operation.key === "position") {
    return {
      ...common,
      entityId: operation.entityId,
      kind: "position",
      position: isPointValue(operation.value) ? operation.value : null,
    };
  }
  if (operation.kind === "SetProperty" && operation.key === "content") {
    const content = canonicalEditableContent(operation.value, "MathTex");
    if (content?.texParts) {
      return {
        ...common,
        content: content as StudioMathTexContentV1,
        entityId: operation.entityId,
        kind: "math-tex-content",
      };
    }
  }
  if (operation.kind === "AnimateProperty" && operation.key === "scale") {
    return {
      ...common,
      controlPresent: operation.control !== undefined,
      entityId: operation.entityId,
      from: typeof operation.from === "number" ? operation.from : null,
      kind: "uniform-scale",
      relativeFactor: operation.relativeFactor ?? null,
      to: typeof operation.to === "number" ? operation.to : null,
    };
  }
  if (operation.kind === "ResizeEntity") {
    return {
      ...common,
      entityId: operation.entityId,
      fromDimensions: operation.from.dimensions,
      fromPosition: operation.from.position,
      fromScale: operation.scale,
      kind: "resize",
      shape: operation.shape,
      toDimensions: operation.to.dimensions,
      toPosition: operation.to.position,
    };
  }
  if (operation.kind === "CreateMotion") {
    return {
      ...common,
      controlOffset: operation.controlOffset,
      delta: operation.delta,
      easing: operation.easing,
      kind: "create-motion",
      targetEntityIds: operation.targetEntityIds,
    };
  }
  if (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent) {
    return { ...common, entityId: operation.entityId, kind: "persistent-remove", persistent: true };
  }
  return { ...common, kind: "unsupported" };
}

function normalizedStaticRootPrograms(programs: readonly SceneEdit[]) {
  return programs.map((program) => ({
    ...studioProgramEnvelope(program),
    operations: program.operations.map(normalizedStaticRootOperation),
  }));
}

/** Normalizes one complete Canonical Program batch for the static-root Rust authority. */
export function buildStaticRootTransformEditCommand(
  input: StaticRootTransformCommandInput,
): ApplyStaticRootTransformEditWireCommandV1 {
  return {
    ...input,
    mathTexOutlines: input.mathTexOutlines ?? [],
    programs: normalizedStaticRootPrograms(input.programs),
    schema: "poietra.apply-static-root-transform-edit",
    version: 1,
  };
}

export function studioCreationMathTexParts(value: unknown): readonly string[] | null {
  return canonicalEditableContent(value, "MathTex")?.texParts ?? null;
}

export function studioCreationTextContent(value: unknown) {
  return canonicalStudioCreationTextContent(value);
}

function normalizedStudioCreationOperation(
  operation: SceneEditOperation,
): ApplyStudioCreationEditWireCommandV1["programs"][number]["operations"][number] {
  const common = {
    dependsOn: operation.dependsOn,
    id: operation.id,
    interval: operation.interval,
    origin: operation.provenance.origin,
  };
  if (operation.kind === "CreateEntity") {
    const type = operation.entity.type;
    const textContent = type === "Text" ? studioCreationTextContent(operation.entity.content) : null;
    return {
      ...common,
      entity: {
        dimensions: operation.entity.dimensions ?? {},
        id: operation.entity.id,
        kind:
          type === "Arrow"
            ? "arrow"
            : type === "Circle"
              ? "circle"
              : type === "Line"
                ? "line"
                : type === "ImageMobject"
                  ? "image"
                  : type === "MathTex"
                    ? "math-tex"
                    : type === "Rectangle"
                      ? "rectangle"
                      : type === "Text"
                        ? "text"
                        : "other",
        layout: textContent?.layout ?? null,
        lifetimeEnd: operation.entity.lifetime.end,
        lifetimeStart: operation.entity.lifetime.start,
        text: textContent?.text ?? null,
        texParts: type === "MathTex" ? studioCreationMathTexParts(operation.entity.content) : null,
      },
      kind: "create",
    };
  }
  if (operation.kind === "SetProperty" && operation.key === "position") {
    return {
      ...common,
      entityId: operation.entityId,
      kind: "position",
      position: isPointValue(operation.value) ? operation.value : null,
    };
  }
  if (operation.kind === "SetProperty" && (operation.key === "fillColor" || operation.key === "strokeColor")) {
    return {
      ...common,
      color: isCanonicalRgbHex(operation.value) ? operation.value : null,
      entityId: operation.entityId,
      kind: operation.key === "fillColor" ? "fill-color" : "stroke-color",
    };
  }
  if (operation.kind === "SetProperty" && operation.key === "appearance") {
    return {
      ...common,
      alpha: typeof operation.value === "number" ? operation.value : null,
      entityId: operation.entityId,
      kind: "opacity",
    };
  }
  if (operation.kind === "SetProperty" && operation.key === "sourceZIndex") {
    return {
      ...common,
      entityId: operation.entityId,
      kind: "source-z-index",
      sourceZIndex: typeof operation.value === "number" && Number.isFinite(operation.value) ? operation.value : null,
    };
  }
  if (operation.kind === "SetProperty" && operation.key === "visibility") {
    return {
      ...common,
      entityId: operation.entityId,
      kind: "visibility",
      visible: typeof operation.value === "boolean" ? operation.value : null,
    };
  }
  if (operation.kind === "AnimateProperty" && operation.key === "appearance") {
    if (operation.materialParameter) {
      return {
        ...common,
        easing: operation.easing,
        entityId: operation.entityId,
        from: typeof operation.from === "number" ? operation.from : null,
        kind: "material-parameter-keyframes",
        material: operation.materialParameter.material,
        name: operation.materialParameter.name,
        parameterIndex: operation.materialParameter.parameterIndex,
        to: typeof operation.to === "number" ? operation.to : null,
      };
    }
    return {
      ...common,
      easing: operation.easing,
      entityId: operation.entityId,
      from: typeof operation.from === "number" ? operation.from : null,
      kind: "opacity-keyframes",
      to: typeof operation.to === "number" ? operation.to : null,
    };
  }
  if (operation.kind === "ChangePresence" && operation.effect === "fade-in") {
    return { ...common, entityId: operation.entityId, kind: "fade-in", persistent: operation.persistent };
  }
  if (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent) {
    return { ...common, entityId: operation.entityId, kind: "persistent-remove", persistent: true };
  }
  if (operation.kind === "AnimateProperty" && operation.key === "scale") {
    if (operation.timelineTrack === true) {
      return {
        ...common,
        easing: operation.easing,
        entityId: operation.entityId,
        from: typeof operation.from === "number" ? operation.from : null,
        kind: "uniform-scale-keyframes",
        to: typeof operation.to === "number" ? operation.to : null,
      };
    }
    return {
      ...common,
      controlPresent: operation.control !== undefined,
      entityId: operation.entityId,
      from: typeof operation.from === "number" ? operation.from : null,
      kind: "uniform-scale",
      relativeFactor: operation.relativeFactor ?? null,
      to: typeof operation.to === "number" ? operation.to : null,
    };
  }
  if (operation.kind === "AnimateProperty" && operation.key === "rotation") {
    if (operation.timelineTrack === true) {
      return {
        ...common,
        easing: operation.easing,
        entityId: operation.entityId,
        from: typeof operation.from === "number" ? operation.from : null,
        kind: "rotation-keyframes",
        to: typeof operation.to === "number" ? operation.to : null,
      };
    }
    return {
      ...common,
      controlPresent: operation.control !== undefined,
      entityId: operation.entityId,
      from: typeof operation.from === "number" ? operation.from : null,
      kind: "rotation",
      relativeDelta: operation.relativeDelta ?? null,
      to: typeof operation.to === "number" ? operation.to : null,
    };
  }
  if (operation.kind === "ResizeEntity") {
    return {
      ...common,
      entityId: operation.entityId,
      fromDimensions: operation.from.dimensions,
      fromPosition: operation.from.position,
      fromScale: operation.scale,
      kind: "resize",
      shape: operation.shape,
      toDimensions: operation.to.dimensions,
      toPosition: operation.to.position,
    };
  }
  if (operation.kind === "CreateMotion") {
    return {
      ...common,
      controlOffset: operation.controlOffset,
      delta: operation.delta,
      easing: operation.easing,
      kind: "create-motion",
      targetEntityIds: operation.targetEntityIds,
    };
  }
  return { ...common, kind: "unsupported" };
}

/** Normalizes one complete Canonical Program batch for the Studio-creation Rust authority. */
export function buildStudioCreationEditCommand(
  input: StudioCreationCommandInput,
): ApplyStudioCreationEditWireCommandV1 {
  return {
    ...input,
    programs: input.programs.map((program) => ({
      ...studioProgramEnvelope(program),
      operations: program.operations.map(normalizedStudioCreationOperation),
    })),
    schema: "poietra.apply-studio-creation-edit",
    textOutlines: input.textOutlines ?? [],
    version: 1,
  };
}

/** Normalizes one complete creation history for snapshot-free Rust admission. */
export function buildStudioCreationProjectionCommand(
  input: StudioCreationProjectionCommandInput,
): ProjectStudioCreationEditWireCommandV1 {
  return {
    ...input,
    programs: input.programs.map((program) => ({
      ...studioProgramEnvelope(program),
      operations: program.operations.map(normalizedStudioCreationOperation),
    })),
    schema: "poietra.project-studio-creation-edit",
    version: 1,
  };
}

/** Selects the bounded MathTex transform family; Rust owns sequence, target, and motion semantics. */
export function isExactStudioMathTexTransformProgramBatch(programs: readonly SceneEdit[]): boolean {
  const operations = programs.flatMap(({ operations }) => operations);
  const transformCount = operations.filter(({ kind }) => kind === "TransformContent").length;
  const motionCount = operations.filter(({ kind }) => kind === "CreateMotion").length;
  return (
    programs.length > 0 &&
    transformCount >= 1 &&
    transformCount <= 2 &&
    motionCount <= 1 &&
    programs.every((program) => program.operations.length > 0) &&
    operations.every(({ kind }) => kind === "TransformContent" || kind === "CreateMotion")
  );
}

/** Normalizes the complete MathTex content-transform batch without deciding its validity in TypeScript. */
export function buildStudioMathTexTransformEditCommand(
  input: StudioMathTexTransformCommandInput,
): ApplyStudioMathTexTransformEditWireCommandV1 {
  return {
    ...input,
    programs: normalizedStudioMathTexTransformPrograms(input.programs),
    schema: "poietra.apply-studio-math-tex-transform-edit",
    version: 1,
  };
}

function normalizedStudioMathTexTransformPrograms(
  programs: readonly SceneEdit[],
): ProjectStudioMathTexTransformWireCommandV1["programs"] {
  return programs.map((program) => ({
    ...studioProgramEnvelope(program),
    operations: program.operations.map(
      (operation): ProjectStudioMathTexTransformWireCommandV1["programs"][number]["operations"][number] => {
        const common = {
          dependsOn: operation.dependsOn,
          id: operation.id,
          interval: operation.interval,
          origin: operation.provenance.origin,
        };
        if (operation.kind === "CreateMotion") {
          return {
            ...common,
            controlOffset: operation.controlOffset,
            delta: operation.delta,
            easing: operation.easing,
            kind: "create-motion",
            targetEntityIds: operation.targetEntityIds,
          };
        }
        if (operation.kind !== "TransformContent") return { ...common, kind: "unsupported" };
        const replacement = canonicalEditableContent(operation.replacement, "MathTex");
        return {
          ...common,
          kind: "transform-content",
          replacement: replacement?.texParts ? (replacement as StudioMathTexContentV1) : null,
          sourceEntityId: operation.sourceEntityId,
          strategy: operation.strategy,
          targetEntityId: operation.targetEntityId,
          targetType: operation.targetType ?? null,
        };
      },
    ),
  }));
}

/** Normalizes the complete MathTex transform batch for snapshot-free Rust admission. */
export function buildStudioMathTexTransformProjectionCommand(
  input: StudioMathTexTransformProjectionCommandInput,
): ProjectStudioMathTexTransformWireCommandV1 {
  return {
    ...input,
    programs: normalizedStudioMathTexTransformPrograms(input.programs),
    schema: "poietra.project-studio-math-tex-transform",
    version: 1,
  };
}

/** Projects the imported Studio identity facts consumed by MathTex transform admission. */
export function studioMathTexTransformStudioEntities(
  runtimeSceneState: RuntimeSceneState,
): ApplyStudioMathTexTransformEditWireCommandV1["studioEntities"] {
  return Object.entries(runtimeSceneState.objectGraph.entities).map(([objectGraphKey, entity]) => ({
    objectGraphKey,
    position: entity.geometry?.position.kind === "known" ? entity.geometry.position.value : null,
    provisional: entity.provisional,
    scale: entity.geometry?.scale.kind === "known" ? entity.geometry.scale.value : null,
    sourceIdentity: entity.sourceIdentity.kind === "known" ? entity.sourceIdentity.value : null,
    type:
      entity.type === "Circle"
        ? "circle"
        : entity.type === "ImageMobject"
          ? "image"
          : entity.type === "MathTex"
            ? "math-tex"
            : entity.type === "Rectangle"
              ? "rectangle"
              : "other",
  }));
}

/** Projects imported identity and lifetime facts for snapshot-free MathTex admission. */
export function studioMathTexTransformProjectionStudioEntities(
  runtimeSceneState: RuntimeSceneState,
): ProjectStudioMathTexTransformWireCommandV1["studioEntities"] {
  return studioMathTexTransformStudioEntities(runtimeSceneState).map((identity) => ({
    ...identity,
    lifetime: runtimeSceneState.objectGraph.entities[identity.objectGraphKey]?.lifetime ?? [],
  }));
}

function normalizedStudioMotionOperation(
  operation: SceneEditOperation,
): ApplyStudioMotionEditWireCommandV1["programs"][number]["operations"][number] {
  const common = {
    dependsOn: operation.dependsOn,
    id: operation.id,
    interval: operation.interval,
    origin: operation.provenance.origin,
  };
  if (operation.kind === "CreateMotion") {
    return {
      ...common,
      controlOffset: operation.controlOffset,
      delta: operation.delta,
      easing: operation.easing,
      kind: "create-motion",
      targetEntityIds: operation.targetEntityIds,
    };
  }
  return { ...common, kind: "unsupported" };
}

/** Selects the closed server-authorized motion family without validating its semantics in TypeScript. */
export function isExactStudioMotionProgramBatch(programs: readonly SceneEdit[]): boolean {
  return (
    programs.length > 0 &&
    programs.every(
      (program) => program.operations.length > 0 && program.operations.every(({ kind }) => kind === "CreateMotion"),
    )
  );
}

/** Normalizes one complete Canonical Program batch for the Studio-motion Rust authority. */
export function buildStudioMotionEditCommand(input: StudioMotionCommandInput): ApplyStudioMotionEditWireCommandV1 {
  return {
    ...input,
    programs: input.programs.map((program) => ({
      ...studioProgramEnvelope(program),
      operations: program.operations.map(normalizedStudioMotionOperation),
    })),
    schema: "poietra.apply-studio-motion-edit",
    version: 1,
  };
}

export type StudioMotionProjectionBatchKind = "standalone" | "static-root";

/** Coarsely selects a Rust motion planner; exact family admission remains in Rust. */
export function studioMotionProjectionBatchKind(
  programs: readonly SceneEdit[],
): StudioMotionProjectionBatchKind | null {
  if (programs.length === 0 || programs.some((program) => program.operations.length === 0)) return null;
  const operations = programs.flatMap(({ operations }) => operations);
  if (!operations.some(({ kind }) => kind === "CreateMotion")) return null;
  if (operations.some(({ kind }) => kind === "TransformContent")) return null;
  if (operations.some(({ kind }) => kind === "CreateEntity")) return null;
  if (operations.every(({ kind }) => kind === "CreateMotion")) return "standalone";
  if (
    operations.every(
      (operation) =>
        operation.kind === "CreateMotion" ||
        operation.kind === "ResizeEntity" ||
        (operation.kind === "SetProperty" && (operation.key === "position" || operation.key === "content")) ||
        (operation.kind === "AnimateProperty" && operation.key === "scale") ||
        (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent),
    )
  ) {
    return "static-root";
  }
  return null;
}

/** Normalizes a motion-bearing batch for snapshot-free Rust admission. */
export function buildStudioMotionProjectionCommand(
  input: StudioMotionProjectionCommandInput,
): ProjectStudioMotionEditWireCommandV1 | null {
  const kind = studioMotionProjectionBatchKind(input.programs);
  if (!kind) return null;
  const base = {
    baseDuration: input.baseDuration,
    schema: "poietra.project-studio-motion-edit" as const,
    version: 1 as const,
  };
  if (kind === "standalone") {
    return {
      ...base,
      batch: {
        kind,
        programs: input.programs.map((program) => ({
          ...studioProgramEnvelope(program),
          operations: program.operations.map(normalizedStudioMotionOperation),
        })),
        studioEntities: studioMotionProjectionStudioEntities(input.runtimeSceneState),
      },
    };
  }
  return {
    ...base,
    batch: {
      kind,
      programs: normalizedStaticRootPrograms(input.programs),
      studioEntities: staticRootMotionProjectionStudioEntities(input.runtimeSceneState),
    },
  };
}

/** Projects imported Studio identity facts for Rust motion admission. */
export function studioMotionStudioEntities(
  runtimeSceneState: RuntimeSceneState,
): ApplyStudioMotionEditWireCommandV1["studioEntities"] {
  return Object.entries(runtimeSceneState.objectGraph.entities).map(([objectGraphKey, entity]) => ({
    objectGraphKey,
    provisional: entity.provisional,
    sourceIdentity: entity.sourceIdentity.kind === "known" ? entity.sourceIdentity.value : null,
  }));
}

/** Projects the logical position and lifetime facts needed by standalone motion admission. */
export function studioMotionProjectionStudioEntities(
  runtimeSceneState: RuntimeSceneState,
): Extract<ProjectStudioMotionEditWireCommandV1["batch"], { kind: "standalone" }>["studioEntities"] {
  return Object.entries(runtimeSceneState.objectGraph.entities).map(([objectGraphKey, entity]) => ({
    lifetime: entity.lifetime,
    objectGraphKey,
    position: entity.geometry?.position.kind === "known" ? entity.geometry.position.value : null,
    provisional: entity.provisional,
    sourceIdentity: entity.sourceIdentity.kind === "known" ? entity.sourceIdentity.value : null,
  }));
}

/** Projects imported Studio entity facts for Rust to verify against Scene IR. */
export function staticRootTransformStudioEntities(
  runtimeSceneState: RuntimeSceneState,
): ApplyStaticRootTransformEditWireCommandV1["studioEntities"] {
  return Object.entries(runtimeSceneState.objectGraph.entities).map(([objectGraphKey, entity]) => ({
    dimensions: entity.geometry?.dimensions.kind === "known" ? entity.geometry.dimensions.value : {},
    id: entity.id,
    kind:
      entity.type === "Circle"
        ? "circle"
        : entity.type === "ImageMobject"
          ? "image"
          : entity.type === "MathTex"
            ? "math-tex"
            : entity.type === "Rectangle"
              ? "rectangle"
              : "other",
    objectGraphKey,
    position: entity.geometry?.position.kind === "known" ? entity.geometry.position.value : null,
    provisional: entity.provisional,
    scale: entity.geometry?.scale.kind === "known" ? entity.geometry.scale.value : null,
    sourceIdentity: entity.sourceIdentity.kind === "known" ? entity.sourceIdentity.value : null,
    ...(entity.transactionId === undefined ? {} : { transactionId: entity.transactionId }),
  }));
}

/** Adds logical lifetime facts to the static-root identity projection used by motion admission. */
export function staticRootMotionProjectionStudioEntities(
  runtimeSceneState: RuntimeSceneState,
): Extract<ProjectStudioMotionEditWireCommandV1["batch"], { kind: "static-root" }>["studioEntities"] {
  return staticRootTransformStudioEntities(runtimeSceneState).map((identity) => ({
    ...identity,
    lifetime: runtimeSceneState.objectGraph.entities[identity.objectGraphKey]?.lifetime ?? [],
  }));
}
