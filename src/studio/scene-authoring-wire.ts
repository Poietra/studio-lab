import type {
  ApplyStaticRootTransformEditWireCommandV1,
  ApplyStudioCreationEditWireCommandV1,
  ApplyStudioMotionEditWireCommandV1,
} from "../engine/scene-authoring";
import { canonicalEditableContent } from "./editable-content";
import type { RuntimeSceneState } from "./model";
import type { CanonicalEditOperation, CanonicalEditProgram } from "./operations";
import { isPointValue } from "./property-sampling";

type StaticRootTransformCommandInput = Omit<
  ApplyStaticRootTransformEditWireCommandV1,
  "programs" | "schema" | "version"
> &
  Readonly<{ programs: readonly CanonicalEditProgram[] }>;

type StudioCreationCommandInput = Omit<ApplyStudioCreationEditWireCommandV1, "programs" | "schema" | "version"> &
  Readonly<{ programs: readonly CanonicalEditProgram[] }>;

type StudioMotionCommandInput = Omit<ApplyStudioMotionEditWireCommandV1, "programs" | "schema" | "version"> &
  Readonly<{ programs: readonly CanonicalEditProgram[] }>;

function studioProgramEnvelope(program: CanonicalEditProgram) {
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

/** Normalizes one complete Canonical Program batch for the static-root Rust authority. */
export function buildStaticRootTransformEditCommand(
  input: StaticRootTransformCommandInput,
): ApplyStaticRootTransformEditWireCommandV1 {
  return {
    ...input,
    programs: input.programs.map((program) => ({
      ...studioProgramEnvelope(program),
      operations: program.operations.map(
        (operation): ApplyStaticRootTransformEditWireCommandV1["programs"][number]["operations"][number] => {
          const common = {
            dependsOn: operation.dependsOn,
            entityId: "entityId" in operation && typeof operation.entityId === "string" ? operation.entityId : "",
            id: operation.id,
            interval: operation.interval,
            origin: operation.provenance.origin,
          };
          if (operation.kind === "SetProperty" && operation.key === "position") {
            return { ...common, kind: "position", position: isPointValue(operation.value) ? operation.value : null };
          }
          if (operation.kind === "AnimateProperty" && operation.key === "scale") {
            return {
              ...common,
              controlPresent: operation.control !== undefined,
              from: typeof operation.from === "number" ? operation.from : null,
              kind: "uniform-scale",
              relativeFactor: operation.relativeFactor ?? null,
              to: typeof operation.to === "number" ? operation.to : null,
            };
          }
          if (operation.kind === "ResizeEntity") {
            return {
              ...common,
              fromDimensions: operation.from.dimensions,
              fromPosition: operation.from.position,
              fromScale: operation.scale,
              kind: "resize",
              shape: operation.shape,
              toDimensions: operation.to.dimensions,
              toPosition: operation.to.position,
            };
          }
          if (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent) {
            return { ...common, kind: "persistent-remove", persistent: true };
          }
          return { ...common, kind: "unsupported" };
        },
      ),
    })),
    schema: "poietra.apply-static-root-transform-edit",
    version: 1,
  };
}

export function studioCreationMathTexParts(value: unknown): readonly string[] | null {
  return canonicalEditableContent(value, "MathTex")?.texParts ?? null;
}

function normalizedStudioCreationOperation(
  operation: CanonicalEditOperation,
): ApplyStudioCreationEditWireCommandV1["programs"][number]["operations"][number] {
  const common = {
    dependsOn: operation.dependsOn,
    id: operation.id,
    interval: operation.interval,
    origin: operation.provenance.origin,
  };
  if (operation.kind === "CreateEntity") {
    const type = operation.entity.type;
    return {
      ...common,
      entity: {
        dimensions: operation.entity.dimensions ?? {},
        id: operation.entity.id,
        kind:
          type === "Circle"
            ? "circle"
            : type === "ImageMobject"
              ? "image"
              : type === "MathTex"
                ? "math-tex"
                : type === "Rectangle"
                  ? "rectangle"
                  : "other",
        lifetimeEnd: operation.entity.lifetime.end,
        lifetimeStart: operation.entity.lifetime.start,
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
  if (operation.kind === "ChangePresence" && operation.effect === "fade-in") {
    return { ...common, entityId: operation.entityId, kind: "fade-in", persistent: operation.persistent };
  }
  if (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent) {
    return { ...common, entityId: operation.entityId, kind: "persistent-remove", persistent: true };
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
    version: 1,
  };
}

function normalizedStudioMotionOperation(
  operation: CanonicalEditOperation,
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
export function isExactStudioMotionProgramBatch(programs: readonly CanonicalEditProgram[]): boolean {
  return (
    programs.length > 0 &&
    programs.every((program) => program.operations.length === 1 && program.operations[0]?.kind === "CreateMotion")
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
