import type {
  StudioBoundEntityProjectionV1,
  StudioCreationProjectionMutationV1,
  StudioCreationProjectionV1,
  StudioMathTexTransformProjectionV1,
  StudioMotionProjectionV1,
  StudioPersistentRemoveProjectionV1,
  StudioProjectedMotionV1,
  StudioStaticRootMutationV1,
  StudioStaticRootProjectionV1,
  StudioTimelineProjectionV1,
} from "../engine/scene-authoring";
import { canonicalEditableContent, STUDIO_TEXT_DEFAULT_LAYOUT, studioCreationTextContent } from "./editable-content";
import { insertSceneTime, projectProposedState } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene } from "./imported-workspace";
import {
  type EntityContent,
  type EntityDimensions,
  type ProgramRecord,
  type ProjectedEntity,
  type PropertyChannel,
  type PropertyChannelSample,
  type ProposedState,
  type RuntimeEntity,
  STUDIO_STATE_VERSION,
  type StudioEditProjectionAuthority,
  type WorkingState,
} from "./model";
import {
  isExactStaticRootProjectionProgramBatch,
  isSceneDurationOperation,
  isStaticRootTransformOperation,
  isStudioNativeAuthoringBatchOperation,
} from "./operations";
import { normalizeContentSamples } from "./property-sampling";
import {
  isExactStudioMathTexTransformProgramBatch,
  studioCreationMathTexTransformRoots,
  studioMotionProjectionBatchKind,
} from "./scene-authoring-wire";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { type AuthorableWorkspaceScene, studioWorkspaceWorkingState } from "./studio-native-workspace";
import {
  correlateTimelineProgramBatch,
  isSceneDurationProgram,
  isSceneDurationProgramBatch,
  projectLegacyTimelineProposedState,
  selectTimelineProgramBatchProjection,
} from "./timeline-projection";

export function isTransitionOverlay(entity: Pick<ProjectedEntity, "type">) {
  return entity.type.startsWith("TransitionOverlay:");
}

function isPersistentRemoveOperation(
  operation: SceneEditOperation,
): operation is Extract<SceneEditOperation, { kind: "ChangePresence" }> {
  return operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent;
}

function isPersistentRemoveProgramBatch(programs: readonly SceneEdit[]) {
  return (
    programs.length > 0 &&
    programs.every((program) => program.operations.length > 0 && program.operations.every(isPersistentRemoveOperation))
  );
}

function isStaticRootWorkspaceProjectionProgramBatch(programs: readonly SceneEdit[]) {
  if (
    isExactStaticRootProjectionProgramBatch(programs) ||
    studioMotionProjectionBatchKind(programs) === "static-root"
  ) {
    return true;
  }
  return (
    programs.some((program) => program.operations.some(isStaticRootTransformOperation)) &&
    programs.every(
      (program) =>
        program.operations.length > 0 &&
        program.operations.every(
          (operation) => isStaticRootTransformOperation(operation) || isPersistentRemoveOperation(operation),
        ),
    )
  );
}

export function selectStudioWorkspaceEditAuthority(
  records: readonly ProgramRecord[],
  previewRecords: readonly ProgramRecord[],
  authority: StudioEditProjectionAuthority | null,
) {
  if (records.length === 0) return null;
  if (isSceneDurationProgramBatch(records.map(({ program }) => program))) return null;
  if (!authority || records.length > previewRecords.length) return undefined;
  return records.every((record, index) => record === previewRecords[index]) ? authority : undefined;
}

export function selectPersistentRemoveProjection(
  programs: readonly SceneEdit[],
  projection: StudioPersistentRemoveProjectionV1 | null,
): StudioPersistentRemoveProjectionV1 | null {
  const expected = programs.flatMap((program) =>
    program.operations.flatMap((operation) =>
      isPersistentRemoveOperation(operation)
        ? [{ entityId: operation.entityId, operationId: operation.id, transactionId: program.transactionId }]
        : [],
    ),
  );
  if (expected.length === 0) return null;
  if (!projection) {
    throw new TypeError("A Rust persistent remove projection is required to project persistent remove Programs.");
  }
  const removalsByOperationId = new Map(projection.removals.map((removal) => [removal.operationId, removal] as const));
  if (removalsByOperationId.size !== projection.removals.length) {
    throw new TypeError("The Rust persistent remove projection contains duplicate operation IDs.");
  }
  return {
    removals: expected.map(({ entityId, operationId, transactionId }) => {
      const removal = removalsByOperationId.get(operationId);
      if (!removal || removal.studioEntityId !== entityId || removal.transactionId !== transactionId) {
        throw new TypeError(`Persistent remove ${operationId} is not correlated with the Rust authoring projection.`);
      }
      return removal;
    }),
  };
}

type CorrelatedStaticRootMutation = Readonly<{
  mutation: StudioStaticRootMutationV1;
  operation: SceneEditOperation;
  program: SceneEdit;
}>;

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const MATH_TEX_TRANSFORM_PROJECTION_EPSILON = 1e-9;

function sameProjectionNumber(left: number, right: number) {
  return (
    Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= MATH_TEX_TRANSFORM_PROJECTION_EPSILON
  );
}

function sameProjectionCoordinateAxis(
  left: Readonly<{ maximum: number; minimum: number; step: number }>,
  right: Readonly<{ maximum: number; minimum: number; step: number }>,
) {
  return (
    sameProjectionNumber(left.minimum, right.minimum) &&
    sameProjectionNumber(left.maximum, right.maximum) &&
    sameProjectionNumber(left.step, right.step)
  );
}

function sameProjectionDimensions(left: EntityDimensions, right: EntityDimensions) {
  const scalarDimensionsMatch = (["height", "radius", "sides", "width"] as const).every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    return leftValue === undefined || rightValue === undefined
      ? leftValue === rightValue
      : sameProjectionNumber(leftValue, rightValue);
  });
  return (
    scalarDimensionsMatch &&
    (left.angles === undefined || right.angles === undefined
      ? left.angles === right.angles
      : sameProjectionNumber(left.angles.start, right.angles.start) &&
        sameProjectionNumber(left.angles.sweep, right.angles.sweep)) &&
    (left.coordinateSystem === undefined || right.coordinateSystem === undefined
      ? left.coordinateSystem === right.coordinateSystem
      : sameProjectionCoordinateAxis(left.coordinateSystem.x, right.coordinateSystem.x) &&
        (left.coordinateSystem.y === undefined || right.coordinateSystem.y === undefined
          ? left.coordinateSystem.y === right.coordinateSystem.y
          : sameProjectionCoordinateAxis(left.coordinateSystem.y, right.coordinateSystem.y)))
  );
}

function sameProjectionCameraView(
  left: Readonly<{ center: Readonly<{ x: number; y: number }>; frameHeight: number; frameWidth: number }>,
  right: Readonly<{ center: Readonly<{ x: number; y: number }>; frameHeight: number; frameWidth: number }>,
) {
  return (
    sameProjectionNumber(left.center.x, right.center.x) &&
    sameProjectionNumber(left.center.y, right.center.y) &&
    sameProjectionNumber(left.frameHeight, right.frameHeight) &&
    sameProjectionNumber(left.frameWidth, right.frameWidth)
  );
}

function isFiniteProjectionPoint(point: Readonly<{ x: number; y: number }>) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

type CorrelatedProjectedMotion = Readonly<{
  motion: StudioProjectedMotionV1;
  operation: Extract<SceneEditOperation, { kind: "CreateMotion" }>;
  program: SceneEdit;
}>;

function motionProjectionKey(operationId: string, targetEntityId: string) {
  return `${operationId}\u0000${targetEntityId}`;
}

function correlateMotionProjection(
  baseDuration: number,
  programs: readonly SceneEdit[],
  projection: StudioMotionProjectionV1 | null,
  requireOneInsertionPerProgram = false,
): readonly CorrelatedProjectedMotion[] | null {
  const expected = programs.flatMap((program) =>
    program.operations.flatMap((operation) =>
      operation.kind === "CreateMotion"
        ? operation.targetEntityIds.map((targetEntityId) => ({ operation, program, targetEntityId }))
        : [],
    ),
  );
  if (expected.length === 0) return null;
  if (!projection) {
    throw new TypeError("A Rust motion projection is required to project CreateMotion Programs.");
  }
  const transactionIds = programs.map(({ transactionId }) => transactionId);
  const insertionsByTransactionId = new Map(
    projection.insertions.map((insertion) => [insertion.transactionId, insertion] as const),
  );
  if (
    new Set(transactionIds).size !== transactionIds.length ||
    (requireOneInsertionPerProgram && projection.insertions.length !== programs.length) ||
    insertionsByTransactionId.size !== projection.insertions.length ||
    projection.insertions.some(
      ({ at, duration, transactionId }) =>
        !transactionIds.includes(transactionId) ||
        !Number.isFinite(at) ||
        at < 0 ||
        !Number.isFinite(duration) ||
        duration <= 0,
    )
  ) {
    throw new TypeError("The Rust motion projection does not contain one unique insertion per Program.");
  }
  if (
    !Number.isFinite(projection.projectedDuration) ||
    !sameProjectionNumber(
      projection.projectedDuration,
      baseDuration + projection.insertions.reduce((total, insertion) => total + insertion.duration, 0),
    )
  ) {
    throw new TypeError("The Rust motion projection returned a stale projected duration.");
  }

  const expectedByKey = new Map(
    expected.map((entry) => [motionProjectionKey(entry.operation.id, entry.targetEntityId), entry] as const),
  );
  const projectedByKey = new Map(
    projection.motions.map(
      (motion) => [motionProjectionKey(motion.operationId, motion.targetEntityId), motion] as const,
    ),
  );
  if (
    expectedByKey.size !== expected.length ||
    projectedByKey.size !== projection.motions.length ||
    projection.motions.length !== expected.length
  ) {
    throw new TypeError("The Rust motion projection does not contain one unique result per operation target.");
  }
  return projection.motions.map((motion) => {
    const expectedMotion = expectedByKey.get(motionProjectionKey(motion.operationId, motion.targetEntityId));
    const operation = expectedMotion?.operation;
    const program = expectedMotion?.program;
    const insertion = program ? insertionsByTransactionId.get(program.transactionId) : undefined;
    if (
      !expectedMotion ||
      !operation ||
      !program ||
      !insertion ||
      motion.transactionId !== program.transactionId ||
      motion.easing !== (operation.easing === "smooth" ? "manim-smooth" : "linear") ||
      motion.orientToPath !== (operation.orientToPath === true) ||
      !Number.isFinite(motion.interval.start) ||
      !Number.isFinite(motion.interval.end) ||
      motion.interval.end <= motion.interval.start ||
      !isFiniteProjectionPoint(motion.from) ||
      !isFiniteProjectionPoint(motion.to) ||
      !isFiniteProjectionPoint(motion.control) ||
      !isFiniteProjectionPoint(motion.delta) ||
      !isFiniteProjectionPoint(motion.controlOffset) ||
      !sameProjectionNumber(motion.sourceInterval.start, operation.interval.start) ||
      !sameProjectionNumber(motion.sourceInterval.end, operation.interval.end) ||
      !sameProjectionNumber(motion.delta.x, operation.delta.x) ||
      !sameProjectionNumber(motion.delta.y, operation.delta.y) ||
      !sameProjectionNumber(motion.controlOffset.x, operation.controlOffset.x) ||
      !sameProjectionNumber(motion.controlOffset.y, operation.controlOffset.y)
    ) {
      throw new TypeError(`Motion operation ${motion.operationId} is not correlated with the Rust projection.`);
    }
    return { motion, operation, program };
  });
}

export function selectMotionProjection(
  baseDuration: number,
  programs: readonly SceneEdit[],
  projection: StudioMotionProjectionV1 | null,
): StudioMotionProjectionV1 | null {
  const correlated = correlateMotionProjection(
    baseDuration,
    programs,
    projection,
    studioMotionProjectionBatchKind(programs) === "standalone",
  );
  if (!correlated) return null;
  if (!projection) throw new TypeError("The correlated Rust motion projection is missing.");
  return { ...projection, motions: correlated.map(({ motion }) => motion) };
}

function creationEntityKind(type: string): StudioCreationProjectionV1["entities"][number]["kind"] | null {
  if (type === "Arc") return "arc";
  if (type === "Arrow") return "arrow";
  if (type === "Axes") return "axes";
  if (type === "Circle") return "circle";
  if (type === "CubicBezier") return "cubic-bezier";
  if (type === "DataPlot") return "data-plot";
  if (type === "Ellipse") return "ellipse";
  if (type === "Triangle" || type === "RegularPolygon") return "regular-polygon";
  if (type === "ImageMobject") return "image";
  if (type === "Line") return "line";
  if (type === "MathTex") return "math-tex";
  if (type === "NumberLine") return "number-line";
  if (type === "NumberPlane") return "number-plane";
  if (type === "Rectangle") return "rectangle";
  if (type === "Sector") return "sector";
  if (type === "SvgPath") return "svg-path";
  if (type === "Text") return "text";
  return null;
}

function sameCreationImage(
  projected: StudioCreationProjectionV1["entities"][number]["image"],
  expected: Extract<SceneEditOperation, { kind: "CreateEntity" }>["entity"]["image"],
) {
  if (!projected || !expected) return projected === undefined && expected === undefined;
  return (
    projected.asset.assetId === expected.asset.assetId &&
    projected.asset.sha256 === expected.asset.sha256 &&
    projected.sampler === expected.sampler &&
    sameProjectionNumber(projected.localRect.bottom, expected.localRect.bottom) &&
    sameProjectionNumber(projected.localRect.left, expected.localRect.left) &&
    sameProjectionNumber(projected.localRect.right, expected.localRect.right) &&
    sameProjectionNumber(projected.localRect.top, expected.localRect.top)
  );
}

function sameCreationDataSeries(
  projected: StudioCreationProjectionV1["entities"][number]["dataSeries"],
  expected: Extract<SceneEditOperation, { kind: "CreateEntity" }>["entity"]["dataSeries"],
) {
  if (!projected || !expected) return projected === undefined && expected === undefined;
  return (
    projected.interpolation === expected.interpolation &&
    projected.points.length === expected.points.length &&
    projected.points.every((point, index) => {
      const expectedPoint = expected.points[index];
      return (
        expectedPoint !== undefined &&
        sameProjectionNumber(point.x, expectedPoint.x) &&
        sameProjectionNumber(point.y, expectedPoint.y)
      );
    })
  );
}

function sameCubicBezierPath(
  projected: Extract<StudioCreationProjectionMutationV1, { kind: "path-morph" }>["fromPath"],
  expected: Extract<SceneEditOperation, { kind: "TransformPath" }>["from"],
) {
  return (
    projected.closed === expected.closed &&
    projected.segments.length === expected.segments.length &&
    sameProjectionNumber(projected.start.x, expected.start.x) &&
    sameProjectionNumber(projected.start.y, expected.start.y) &&
    projected.segments.every((segment, index) => {
      const expectedSegment = expected.segments[index];
      return (
        expectedSegment !== undefined &&
        sameProjectionNumber(segment.control1.x, expectedSegment.control1.x) &&
        sameProjectionNumber(segment.control1.y, expectedSegment.control1.y) &&
        sameProjectionNumber(segment.control2.x, expectedSegment.control2.x) &&
        sameProjectionNumber(segment.control2.y, expectedSegment.control2.y) &&
        sameProjectionNumber(segment.end.x, expectedSegment.end.x) &&
        sameProjectionNumber(segment.end.y, expectedSegment.end.y)
      );
    })
  );
}

function creationMutationKind(operation: SceneEditOperation): StudioCreationProjectionMutationV1["kind"] | null {
  if (operation.kind === "SetSceneBackground") return "scene-background";
  if (operation.kind === "SetProperty" && operation.key === "position") return "position";
  if (operation.kind === "SetProperty" && operation.key === "appearance") return "opacity";
  if (operation.kind === "AnimateProperty" && operation.key === "appearance") {
    return operation.materialParameter ? "material-parameter-keyframes" : "opacity-keyframes";
  }
  if (operation.kind === "AnimateProperty" && (operation.key === "fillColor" || operation.key === "strokeColor")) {
    return "paint-color-keyframes";
  }
  if (operation.kind === "SetProperty" && operation.key === "fillColor") return "fill-color";
  if (operation.kind === "SetProperty" && operation.key === "strokeColor") return "stroke-color";
  if (operation.kind === "SetProperty" && operation.key === "strokeCap") return "stroke-cap";
  if (operation.kind === "SetProperty" && operation.key === "strokeDash") return "stroke-dash";
  if (operation.kind === "SetProperty" && operation.key === "strokeWidth") return "stroke-width";
  if (operation.kind === "SetProperty" && operation.key === "sourceZIndex") return "source-z-index";
  if (operation.kind === "SetProperty" && operation.key === "visibility") return "visibility";
  if (operation.kind === "ChangePresence" && operation.effect === "fade-in") return "fade-in";
  if (operation.kind === "DrawIn") return "draw-in";
  if (operation.kind === "WriteIn") return "write-in";
  if (operation.kind === "TransformContent") return "math-tex-transform";
  if (operation.kind === "TransformPath") return "path-morph";
  if (operation.kind === "TransformShape") return "shape-transform";
  if (operation.kind === "AnimateCamera") return "animate-camera";
  if (operation.kind === "AnimateProperty" && operation.key === "rotation") return "rotation";
  if (operation.kind === "AnimateProperty" && operation.key === "scale") return "uniform-scale";
  if (operation.kind === "ResizeEntity") return "resize";
  return null;
}

function canonicalShapeTransformKind(shape: Extract<SceneEditOperation, { kind: "TransformShape" }>["to"]["shape"]) {
  return shape === "triangle" ? "regular-polygon" : shape;
}

function correlateCreationProjection(
  baseDuration: number,
  programs: readonly SceneEdit[],
  projection: StudioCreationProjectionV1 | null,
) {
  const operations = programs.flatMap((program) =>
    program.operations.map((operation) => ({ operation, program }) as const),
  );
  const createCount = operations.filter(({ operation }) => operation.kind === "CreateEntity").length;
  if (!operations.some(({ operation }) => isStudioNativeAuthoringBatchOperation(operation))) return null;
  if (!projection) throw new TypeError("A Rust creation projection is required to project Studio-native Programs.");
  const operationById = new Map(operations.map((entry) => [entry.operation.id, entry] as const));
  const mathTexTransformRoots = studioCreationMathTexTransformRoots(programs);
  const transactionIds = new Set(programs.map(({ transactionId }) => transactionId));
  if (operationById.size !== operations.length || transactionIds.size !== programs.length) {
    throw new TypeError("A Studio creation batch must contain unique operation and transaction IDs.");
  }
  const expectedMutationOperations = operations.filter(
    ({ operation }) =>
      creationMutationKind(operation) !== null ||
      (operation.kind === "CreateMotion" && operation.rotationDeltaRadians !== undefined),
  );
  const expectedMotionCount = operations.reduce(
    (count, { operation }) => count + (operation.kind === "CreateMotion" ? operation.targetEntityIds.length : 0),
    0,
  );
  const expectedRemovalCount = operations.filter(
    ({ operation }) => operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent,
  ).length;
  const durationPrograms = programs.filter(isSceneDurationProgram);
  const durationOperationCount = operations.filter(({ operation }) => isSceneDurationOperation(operation)).length;
  if (
    operations.some(
      ({ operation }) =>
        operation.kind !== "CreateEntity" &&
        operation.kind !== "CreateMotion" &&
        operation.kind !== "GroupEntities" &&
        operation.kind !== "UngroupEntity" &&
        !isSceneDurationOperation(operation) &&
        creationMutationKind(operation) === null &&
        !(operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent),
    ) ||
    durationPrograms.length !== durationOperationCount ||
    projection.entities.length !== createCount ||
    projection.mutations.length !== expectedMutationOperations.length ||
    projection.motions.length !== expectedMotionCount ||
    projection.removals.length !== expectedRemovalCount ||
    !Number.isFinite(projection.projectedDuration) ||
    !sameProjectionNumber(
      projection.projectedDuration,
      baseDuration + projection.insertions.reduce((total, insertion) => total + insertion.duration, 0),
    )
  ) {
    throw new TypeError("The Rust creation projection does not cover the complete Program batch.");
  }
  if (durationPrograms.length > 0) {
    correlateTimelineProgramBatch(durationPrograms, projection.timelineProjection);
    if (!sameProjectionNumber(projection.timelineProjection.projectedDuration, projection.projectedDuration)) {
      throw new TypeError("The Rust creation timeline projection does not match the projected Studio duration.");
    }
  } else if (
    projection.timelineProjection.programProjections.length > 0 ||
    projection.timelineProjection.transforms.length > 0 ||
    !sameProjectionNumber(projection.timelineProjection.projectedDuration, projection.projectedDuration)
  ) {
    throw new TypeError("The Rust creation projection contains an unexpected Scene duration projection.");
  }
  const insertionsByTransaction = new Map(
    projection.insertions.map((insertion) => [insertion.transactionId, insertion] as const),
  );
  if (
    insertionsByTransaction.size !== projection.insertions.length ||
    projection.insertions.some(
      ({ at, duration, transactionId }) =>
        !transactionIds.has(transactionId) ||
        !Number.isFinite(at) ||
        at < 0 ||
        !Number.isFinite(duration) ||
        duration <= 0,
    )
  ) {
    throw new TypeError("The Rust creation projection contains an invalid Program insertion.");
  }

  const seenEntityIds = new Set<string>();
  const seenEntityOperationIds = new Set<string>();
  const entities = projection.entities.map((entity) => {
    const expected = operationById.get(entity.operationId);
    const operation = expected?.operation;
    const expectedKind = operation?.kind === "CreateEntity" ? creationEntityKind(operation.entity.type) : null;
    const expectedTexParts =
      operation?.kind === "CreateEntity" && operation.entity.type === "MathTex"
        ? canonicalEditableContent(operation.entity.content, "MathTex")?.texParts
        : undefined;
    const expectedTextContent =
      operation?.kind === "CreateEntity" && operation.entity.type === "Text"
        ? (studioCreationTextContent(operation.entity.content) ?? undefined)
        : undefined;
    const projectedLayout = entity.layout ?? STUDIO_TEXT_DEFAULT_LAYOUT;
    const expectedImage = operation?.kind === "CreateEntity" ? operation.entity.image : undefined;
    const expectedDataSeries = operation?.kind === "CreateEntity" ? operation.entity.dataSeries : undefined;
    const textContentMismatch = expectedTextContent
      ? entity.text !== expectedTextContent.text ||
        projectedLayout.alignment !== expectedTextContent.layout.alignment ||
        (projectedLayout.fontFamily ?? STUDIO_TEXT_DEFAULT_LAYOUT.fontFamily) !==
          (expectedTextContent.layout.fontFamily ?? STUDIO_TEXT_DEFAULT_LAYOUT.fontFamily) ||
        !sameProjectionNumber(projectedLayout.fontSize, expectedTextContent.layout.fontSize) ||
        projectedLayout.fontWeight !== expectedTextContent.layout.fontWeight ||
        !sameProjectionNumber(projectedLayout.lineHeight, expectedTextContent.layout.lineHeight)
      : entity.text !== undefined || entity.layout !== undefined;
    if (
      !expected ||
      operation?.kind !== "CreateEntity" ||
      !expectedKind ||
      entity.transactionId !== expected.program.transactionId ||
      entity.entityId !== operation.entity.id ||
      entity.kind !== expectedKind ||
      !sameProjectionDimensions(entity.initialDimensions, operation.entity.dimensions ?? {}) ||
      !sameCreationDataSeries(entity.dataSeries, expectedDataSeries) ||
      !sameCreationImage(entity.image, expectedImage) ||
      seenEntityIds.has(entity.entityId) ||
      seenEntityOperationIds.has(entity.operationId) ||
      (expectedTexParts
        ? !entity.texParts || !sameStrings(entity.texParts, expectedTexParts)
        : entity.texParts !== undefined) ||
      textContentMismatch
    ) {
      throw new TypeError(`Created entity ${entity.operationId} is not correlated with the Rust projection.`);
    }
    seenEntityIds.add(entity.entityId);
    seenEntityOperationIds.add(entity.operationId);
    return { entity, operation, program: expected.program };
  });

  const motionProjection: StudioMotionProjectionV1 = {
    insertions: projection.insertions,
    motions: projection.motions,
    projectedDuration: projection.projectedDuration,
  };
  const motions = expectedMotionCount > 0 ? correlateMotionProjection(baseDuration, programs, motionProjection) : [];
  if (expectedMotionCount > 0 && !motions) {
    throw new TypeError("The Rust creation projection contains no correlated motion.");
  }
  const seenMutationIds = new Set<string>();
  const mutations = projection.mutations.map((mutation) => {
    const expected = operationById.get(mutation.operationId);
    const operation = expected?.operation;
    const expectedMutationKind = operation ? creationMutationKind(operation) : null;
    const motion =
      operation?.kind === "CreateMotion" && operation.rotationDeltaRadians !== undefined
        ? motions?.find(
            ({ motion: candidate }) =>
              candidate.operationId === operation.id && candidate.targetEntityId === operation.targetEntityIds[0],
          )?.motion
        : undefined;
    const isCorrelatedSpin =
      operation?.kind === "CreateMotion" &&
      operation.targetEntityIds.length === 1 &&
      motion !== undefined &&
      mutation.kind === "rotation-keyframes" &&
      mutation.entityId === operation.targetEntityIds[0] &&
      mutation.easing.kind === (operation.easing === "smooth" ? "manim-smooth" : "linear") &&
      sameProjectionNumber(mutation.from, 0) &&
      sameProjectionNumber(mutation.to, operation.rotationDeltaRadians ?? Number.NaN) &&
      sameProjectionNumber(mutation.interval.start, motion.interval.start) &&
      sameProjectionNumber(mutation.interval.end, motion.interval.end);
    const createdEntity =
      operation?.kind === "DrawIn" || operation?.kind === "WriteIn"
        ? projection.entities.find((entity) => entity.entityId === operation.entityId)
        : undefined;
    const isCorrelatedDraw =
      operation?.kind === "DrawIn" &&
      mutation.kind === "draw-in" &&
      createdEntity !== undefined &&
      mutation.entityId === operation.entityId &&
      mutation.easing.kind === (operation.easing === "smooth" ? "manim-smooth" : "linear") &&
      sameProjectionNumber(mutation.from, 0) &&
      sameProjectionNumber(mutation.to, 1) &&
      sameProjectionNumber(mutation.interval.start, createdEntity.createdLifetime.start) &&
      sameProjectionNumber(
        mutation.interval.end - mutation.interval.start,
        operation.interval.end - operation.interval.start,
      );
    const isCorrelatedWrite =
      operation?.kind === "WriteIn" &&
      mutation.kind === "write-in" &&
      createdEntity !== undefined &&
      mutation.entityId === operation.entityId &&
      mutation.easing.kind === "linear" &&
      sameProjectionNumber(mutation.from, 0) &&
      sameProjectionNumber(mutation.to, 1) &&
      sameProjectionNumber(mutation.interval.start, createdEntity.createdLifetime.start) &&
      sameProjectionNumber(
        mutation.interval.end - mutation.interval.start,
        operation.interval.end - operation.interval.start,
      );
    const isCorrelatedPaintColorTrack =
      operation?.kind === "AnimateProperty" &&
      (operation.key === "fillColor" || operation.key === "strokeColor") &&
      mutation.kind === "paint-color-keyframes" &&
      mutation.entityId === operation.entityId &&
      mutation.property === (operation.key === "fillColor" ? "fill-color" : "stroke-color") &&
      mutation.easing.kind === (operation.easing === "smooth" ? "manim-smooth" : "linear") &&
      mutation.from === operation.from &&
      mutation.to === operation.to;
    const isCorrelatedSceneBackground =
      operation?.kind === "SetSceneBackground" &&
      mutation.kind === "scene-background" &&
      mutation.value === operation.color &&
      sameProjectionNumber(mutation.interval.start, 0) &&
      sameProjectionNumber(mutation.interval.end, 0);
    const expectedMathTexContent =
      operation?.kind === "TransformContent" ? canonicalEditableContent(operation.replacement, "MathTex") : null;
    const mathTexTransformInsertion = expected
      ? insertionsByTransaction.get(expected.program.transactionId)
      : undefined;
    const isCorrelatedMathTexTransform =
      operation?.kind === "TransformContent" &&
      operation.strategy === "replacement-transform" &&
      expectedMathTexContent !== null &&
      expectedMathTexContent.texParts !== undefined &&
      mathTexTransformInsertion !== undefined &&
      mutation.kind === "math-tex-transform" &&
      mutation.entityId === mathTexTransformRoots.get(operation.id) &&
      mutation.sourceEntityId === operation.sourceEntityId &&
      mutation.targetEntityId === operation.targetEntityId &&
      mutation.easing.kind === ((operation.easing ?? "smooth") === "smooth" ? "manim-smooth" : "linear") &&
      mutation.content.label === expectedMathTexContent.label &&
      sameStrings(mutation.content.displayLines, expectedMathTexContent.displayLines) &&
      sameStrings(mutation.content.texParts, expectedMathTexContent.texParts) &&
      sameProjectionNumber(mutation.interval.start, mathTexTransformInsertion.at) &&
      sameProjectionNumber(
        mutation.interval.end - mutation.interval.start,
        operation.interval.end - operation.interval.start,
      ) &&
      sameProjectionNumber(mathTexTransformInsertion.duration, operation.interval.end - operation.interval.start);
    const shapeTransformInsertion = expected ? insertionsByTransaction.get(expected.program.transactionId) : undefined;
    const isCorrelatedShapeTransform =
      operation?.kind === "TransformShape" &&
      shapeTransformInsertion !== undefined &&
      mutation.kind === "shape-transform" &&
      mutation.entityId === operation.entityId &&
      mutation.easing.kind === (operation.easing === "smooth" ? "manim-smooth" : "linear") &&
      mutation.fromShape === canonicalShapeTransformKind(operation.from.shape) &&
      mutation.toShape === canonicalShapeTransformKind(operation.to.shape) &&
      sameProjectionDimensions(mutation.fromDimensions, operation.from.dimensions) &&
      sameProjectionDimensions(mutation.toDimensions, operation.to.dimensions) &&
      sameProjectionNumber(mutation.interval.start, shapeTransformInsertion.at) &&
      sameProjectionNumber(
        mutation.interval.end - mutation.interval.start,
        operation.interval.end - operation.interval.start,
      ) &&
      sameProjectionNumber(shapeTransformInsertion.duration, operation.interval.end - operation.interval.start);
    const pathMorphInsertion = expected ? insertionsByTransaction.get(expected.program.transactionId) : undefined;
    const isCorrelatedPathMorph =
      operation?.kind === "TransformPath" &&
      pathMorphInsertion !== undefined &&
      mutation.kind === "path-morph" &&
      mutation.entityId === operation.entityId &&
      mutation.easing.kind === (operation.easing === "smooth" ? "manim-smooth" : "linear") &&
      sameCubicBezierPath(mutation.fromPath, operation.from) &&
      sameCubicBezierPath(mutation.toPath, operation.to) &&
      sameProjectionNumber(mutation.interval.start, pathMorphInsertion.at) &&
      sameProjectionNumber(
        mutation.interval.end - mutation.interval.start,
        operation.interval.end - operation.interval.start,
      ) &&
      sameProjectionNumber(pathMorphInsertion.duration, operation.interval.end - operation.interval.start);
    const cameraInsertion = expected ? insertionsByTransaction.get(expected.program.transactionId) : undefined;
    const isCorrelatedCamera =
      operation?.kind === "AnimateCamera" &&
      cameraInsertion !== undefined &&
      mutation.kind === "animate-camera" &&
      mutation.easing.kind === (operation.easing === "smooth" ? "manim-smooth" : "linear") &&
      sameProjectionCameraView(mutation.fromView, operation.from) &&
      sameProjectionCameraView(mutation.toView, operation.to) &&
      sameProjectionNumber(mutation.interval.start, cameraInsertion.at) &&
      sameProjectionNumber(
        mutation.interval.end - mutation.interval.start,
        operation.interval.end - operation.interval.start,
      ) &&
      sameProjectionNumber(cameraInsertion.duration, operation.interval.end - operation.interval.start);
    const isCorrelatedMutation =
      operation?.kind !== "TransformContent" &&
      operation?.kind !== "TransformPath" &&
      operation?.kind !== "TransformShape" &&
      operation?.kind !== "AnimateCamera" &&
      operation?.kind !== "SetSceneBackground" &&
      operation?.kind !== "DrawIn" &&
      operation?.kind !== "WriteIn" &&
      !(operation?.kind === "AnimateProperty" && (operation.key === "fillColor" || operation.key === "strokeColor")) &&
      expectedMutationKind !== null &&
      expectedMutationKind === mutation.kind &&
      "entityId" in mutation &&
      mutation.entityId === (operation && "entityId" in operation ? operation.entityId : undefined);
    if (
      !expected ||
      seenMutationIds.has(mutation.operationId) ||
      mutation.transactionId !== expected.program.transactionId ||
      (!isCorrelatedMutation &&
        !isCorrelatedMathTexTransform &&
        !isCorrelatedPathMorph &&
        !isCorrelatedShapeTransform &&
        !isCorrelatedCamera &&
        !isCorrelatedSpin &&
        !isCorrelatedDraw &&
        !isCorrelatedWrite &&
        !isCorrelatedSceneBackground &&
        !isCorrelatedPaintColorTrack)
    ) {
      throw new TypeError(`Creation mutation ${mutation.operationId} is not correlated with the Rust projection.`);
    }
    seenMutationIds.add(mutation.operationId);
    return { mutation, ...expected };
  });
  const removals = selectPersistentRemoveProjection(programs, { removals: projection.removals });
  if (expectedRemovalCount > 0 && !removals) {
    throw new TypeError("The Rust creation projection contains no correlated persistent remove.");
  }
  return { entities, motions: motions ?? [], mutations, removals: removals ?? { removals: [] } };
}

export function selectCreationProjection(
  baseDuration: number,
  programs: readonly SceneEdit[],
  projection: StudioCreationProjectionV1 | null,
): StudioCreationProjectionV1 | null {
  return correlateCreationProjection(baseDuration, programs, projection) ? projection : null;
}

function timeBeforeInsertion(time: number, insertion: StudioCreationProjectionV1["insertions"][number]) {
  const insertionEnd = insertion.at + insertion.duration;
  if (time <= insertion.at) return time;
  if (time >= insertionEnd) return time - insertion.duration;
  throw new TypeError("A retained creation projection timestamp falls inside a draft-only insertion.");
}

function intervalBeforeInsertions(
  interval: Readonly<{ end: number; start: number }>,
  insertions: readonly StudioCreationProjectionV1["insertions"][number][],
) {
  return insertions.reduceRight(
    (current, insertion) => ({
      end: timeBeforeInsertion(current.end, insertion),
      start: timeBeforeInsertion(current.start, insertion),
    }),
    interval,
  );
}

/**
 * Reconstructs an older applied-history prefix only while bootstrapping an edit of that history.
 * Current workspace and draft-base projections must use an exact Rust projection instead.
 */
export function selectHistoricalCreationProjectionPrefix(
  baseDuration: number,
  programs: readonly SceneEdit[],
  fullPrograms: readonly SceneEdit[],
  projection: StudioCreationProjectionV1 | null,
): StudioCreationProjectionV1 | null {
  if (programs.length > fullPrograms.length || programs.some((program, index) => program !== fullPrograms[index])) {
    throw new TypeError("A creation projection can only select an exact Program prefix.");
  }
  const lastPrefixAnchor = Math.max(...programs.map(({ anchor }) => anchor.resolvedSeconds));
  if (fullPrograms.slice(programs.length).some(({ anchor }) => anchor.resolvedSeconds < lastPrefixAnchor)) {
    throw new TypeError("A creation projection can only select a Rust execution prefix.");
  }
  const fullProjection = selectCreationProjection(baseDuration, fullPrograms, projection);
  if (!fullProjection || programs.length === fullPrograms.length) return fullProjection;

  const transactionIds = new Set(programs.map(({ transactionId }) => transactionId));
  const operationIds = new Set(programs.flatMap(({ operations }) => operations.map(({ id }) => id)));
  const durationPrograms = programs.filter(isSceneDurationProgram);
  const durationTransactionIds = new Set(durationPrograms.map(({ transactionId }) => transactionId));
  const durationProgramByOperationId = new Map(
    durationPrograms.map((program) => [program.operations[0].id, program] as const),
  );
  const selectedAuthoringInsertions = fullProjection.insertions.filter(
    ({ transactionId }) => transactionIds.has(transactionId) && !durationTransactionIds.has(transactionId),
  );
  const mixedAuthoringOffsetBefore = (program: SceneEdit) => {
    const programIndex = fullPrograms.indexOf(program);
    return selectedAuthoringInsertions.reduce((offset, insertion) => {
      const insertionProgramIndex = fullPrograms.findIndex(
        ({ transactionId }) => transactionId === insertion.transactionId,
      );
      if (insertionProgramIndex < 0) {
        throw new TypeError("The Rust creation insertion is not correlated with the selected prefix.");
      }
      const insertionProgram = fullPrograms[insertionProgramIndex]!;
      const precedes =
        insertionProgram.anchor.resolvedSeconds < program.anchor.resolvedSeconds ||
        (insertionProgram.anchor.resolvedSeconds === program.anchor.resolvedSeconds &&
          insertionProgramIndex < programIndex);
      return precedes ? offset + insertion.duration : offset;
    }, 0);
  };
  const selectedTimelineProjection =
    durationPrograms.length > 0
      ? selectTimelineProgramBatchProjection(baseDuration, durationPrograms, fullProjection.timelineProjection)
          .projection
      : { programProjections: [], projectedDuration: baseDuration, transforms: [] };
  const selectedDurationInsertions = new Map<
    string,
    StudioCreationProjectionV1["insertions"][number] & Readonly<{ operationId: string }>
  >();
  for (const transform of selectedTimelineProjection.transforms) {
    if (transform.kind === "insert") {
      const program = durationProgramByOperationId.get(transform.operationId);
      if (!program) throw new TypeError("The Rust duration insertion is not correlated with the selected prefix.");
      selectedDurationInsertions.set(transform.operationId, {
        at: transform.interval.start + mixedAuthoringOffsetBefore(program),
        duration: transform.interval.end - transform.interval.start,
        operationId: transform.operationId,
        transactionId: program.transactionId,
      });
      continue;
    }
    for (const reduction of transform.waitReductions) {
      const insertion = selectedDurationInsertions.get(reduction.operationId);
      if (!insertion || reduction.removedDuration > insertion.duration + MATH_TEX_TRANSFORM_PROJECTION_EPSILON) {
        throw new TypeError("The Rust duration trim is not correlated with the selected prefix.");
      }
      selectedDurationInsertions.set(reduction.operationId, {
        ...insertion,
        duration: Math.max(0, insertion.duration - reduction.removedDuration),
      });
    }
  }
  const suffixInsertions = fullProjection.insertions.filter(({ transactionId }) => !transactionIds.has(transactionId));
  const rewindTime = (time: number) =>
    suffixInsertions.reduceRight((current, insertion) => timeBeforeInsertion(current, insertion), time);
  const selectedInsertions = [...selectedAuthoringInsertions, ...selectedDurationInsertions.values()]
    .filter(({ duration }) => duration > MATH_TEX_TRANSFORM_PROJECTION_EPSILON)
    .map(({ at, duration, transactionId }) => ({ at: rewindTime(at), duration, transactionId }))
    .sort((left, right) => {
      const leftIndex = fullPrograms.findIndex(({ transactionId }) => transactionId === left.transactionId);
      const rightIndex = fullPrograms.findIndex(({ transactionId }) => transactionId === right.transactionId);
      return left.at - right.at || leftIndex - rightIndex;
    });
  const suffixDurationOperationIds = new Set(
    fullPrograms.slice(programs.length).flatMap(({ operations }) => operations.map(({ id }) => id)),
  );
  const selectedWaitOperationIds = new Set(selectedDurationInsertions.keys());
  const suffixRemovals = fullProjection.timelineProjection.transforms.filter(
    (transform) =>
      transform.kind === "remove" &&
      suffixDurationOperationIds.has(transform.operationId) &&
      transform.waitReductions.every(({ operationId }) => selectedWaitOperationIds.has(operationId)),
  );
  const restoreTime = (time: number, includeBoundary: boolean) =>
    [...suffixRemovals].reverse().reduce((current, removal) => {
      const duration = removal.interval.end - removal.interval.start;
      return current > removal.interval.start + MATH_TEX_TRANSFORM_PROJECTION_EPSILON ||
        (includeBoundary && current >= removal.interval.start - MATH_TEX_TRANSFORM_PROJECTION_EPSILON)
        ? current + duration
        : current;
    }, time);
  const restoreInterval = (interval: Readonly<{ end: number; start: number }>) => ({
    end: restoreTime(interval.end, true),
    start: restoreTime(interval.start, false),
  });
  const projectedDuration =
    baseDuration + selectedInsertions.reduce((duration, insertion) => duration + insertion.duration, 0);
  const selectedProjection: StudioCreationProjectionV1 = {
    // This historical bootstrap view is never current trim authority.
    durationTrimBarrierOperationIds: [],
    entities: fullProjection.entities
      .filter(({ operationId }) => operationIds.has(operationId))
      .map((entity) => ({
        ...entity,
        createdLifetime: restoreInterval(intervalBeforeInsertions(entity.createdLifetime, suffixInsertions)),
      })),
    insertions: selectedInsertions,
    motions: fullProjection.motions
      .filter(({ operationId }) => operationIds.has(operationId))
      .map((motion) => ({
        ...motion,
        interval: restoreInterval(intervalBeforeInsertions(motion.interval, suffixInsertions)),
      })),
    mutations: fullProjection.mutations
      .filter(({ operationId }) => operationIds.has(operationId))
      .map((mutation) => ({
        ...mutation,
        interval: restoreInterval(intervalBeforeInsertions(mutation.interval, suffixInsertions)),
      })),
    projectedDuration,
    removals: fullProjection.removals
      .filter(({ operationId }) => operationIds.has(operationId))
      .map((removal) => ({
        ...removal,
        fadeInterval: removal.fadeInterval
          ? restoreInterval(intervalBeforeInsertions(removal.fadeInterval, suffixInsertions))
          : null,
        removedAt: restoreTime(rewindTime(removal.removedAt), false),
        resultingLifetimeEnd: restoreTime(rewindTime(removal.resultingLifetimeEnd), true),
      })),
    timelineProjection: { ...selectedTimelineProjection, projectedDuration },
  };
  return selectCreationProjection(baseDuration, programs, selectedProjection);
}

function mathTexContentMatches(
  left: StudioMathTexTransformProjectionV1["replacements"][number]["content"],
  right: EntityContent,
) {
  return (
    right.texParts !== undefined &&
    left.label === right.label &&
    sameStrings(left.displayLines, right.displayLines) &&
    sameStrings(left.texParts, right.texParts)
  );
}

type CorrelatedMathTexTransformReplacement = Readonly<{
  operation: Extract<SceneEditOperation, { kind: "TransformContent" }>;
  program: SceneEdit;
  replacement: StudioMathTexTransformProjectionV1["replacements"][number];
}>;

type CorrelatedMathTexTransformMotion = Readonly<{
  motion: StudioMathTexTransformProjectionV1["motions"][number];
  operation: Extract<SceneEditOperation, { kind: "CreateMotion" }>;
  program: SceneEdit;
}>;

type CorrelatedMathTexTransformProjection = Readonly<{
  motions: readonly CorrelatedMathTexTransformMotion[];
  replacements: readonly CorrelatedMathTexTransformReplacement[];
}>;

function correlateMathTexTransformProjection(
  baseDuration: number,
  programs: readonly SceneEdit[],
  projection: StudioMathTexTransformProjectionV1 | null,
): CorrelatedMathTexTransformProjection | null {
  if (!isExactStudioMathTexTransformProgramBatch(programs)) return null;
  if (!projection) {
    throw new TypeError("A Rust MathTex transform projection is required to project TransformContent Programs.");
  }
  const operations = programs.flatMap((program) =>
    program.operations.map((operation) => ({ operation, program }) as const),
  );
  const transformOperations = operations.filter(
    (
      entry,
    ): entry is Readonly<{
      operation: Extract<SceneEditOperation, { kind: "TransformContent" }>;
      program: SceneEdit;
    }> => entry.operation.kind === "TransformContent",
  );
  const motionOperations = operations.filter(
    (
      entry,
    ): entry is Readonly<{
      operation: Extract<SceneEditOperation, { kind: "CreateMotion" }>;
      program: SceneEdit;
    }> => entry.operation.kind === "CreateMotion",
  );
  const correlatedMotions =
    motionOperations.length > 0
      ? correlateMotionProjection(baseDuration, programs, {
          insertions: projection.insertions,
          motions: projection.motions,
          projectedDuration: projection.projectedDuration,
        })
      : [];
  if (motionOperations.length > 0 && !correlatedMotions) {
    throw new TypeError("The Rust MathTex transform motion projection is missing.");
  }
  const operationIds = operations.map(({ operation }) => operation.id);
  const transactionIds = programs.map(({ transactionId }) => transactionId);
  const projectedOperationIds = [
    ...projection.replacements.map(({ operationId }) => operationId),
    ...projection.motions.map(({ operationId }) => operationId),
  ];
  const projectedTransactionIds = projection.insertions.map(({ transactionId }) => transactionId);
  if (
    projection.replacements.length !== transformOperations.length ||
    projection.motions.length !== motionOperations.length ||
    projection.insertions.length !== programs.length ||
    new Set(operationIds).size !== operationIds.length ||
    new Set(transactionIds).size !== transactionIds.length ||
    new Set(projectedOperationIds).size !== projectedOperationIds.length ||
    new Set(projectedTransactionIds).size !== projectedTransactionIds.length
  ) {
    throw new TypeError(
      "The Rust MathTex transform projection does not contain one unique result per Program operation.",
    );
  }
  const operationsById = new Map(operations.map((entry) => [entry.operation.id, entry] as const));
  const insertionsByTransactionId = new Map(
    projection.insertions.map((insertion) => [insertion.transactionId, insertion] as const),
  );
  if (
    projection.insertions.some(
      ({ at, duration, transactionId }, index) =>
        !Number.isFinite(at) ||
        at < 0 ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        !transactionIds.includes(transactionId) ||
        (index > 0 &&
          at + MATH_TEX_TRANSFORM_PROJECTION_EPSILON <
            projection.insertions[index - 1]!.at + projection.insertions[index - 1]!.duration),
    ) ||
    !sameProjectionNumber(
      projection.projectedDuration,
      baseDuration + projection.insertions.reduce((duration, insertion) => duration + insertion.duration, 0),
    )
  ) {
    throw new TypeError("The Rust MathTex transform projection returned a stale projected duration.");
  }
  const correlatedReplacements = projection.replacements.map((replacement) => {
    const expected = operationsById.get(replacement.operationId);
    const operation = expected?.operation;
    const content =
      operation?.kind === "TransformContent" ? canonicalEditableContent(operation.replacement, "MathTex") : null;
    const insertion = expected ? insertionsByTransactionId.get(expected.program.transactionId) : undefined;
    if (
      !expected ||
      operation?.kind !== "TransformContent" ||
      !content ||
      !insertion ||
      replacement.transactionId !== expected.program.transactionId ||
      replacement.sourceEntityId !== operation.sourceEntityId ||
      replacement.targetEntityId !== operation.targetEntityId ||
      replacement.targetType !== "math-tex" ||
      (operation.targetType !== undefined && operation.targetType !== "MathTex") ||
      !mathTexContentMatches(replacement.content, content) ||
      !Number.isFinite(replacement.interval.start) ||
      !Number.isFinite(replacement.interval.end) ||
      replacement.interval.start < insertion.at - MATH_TEX_TRANSFORM_PROJECTION_EPSILON ||
      replacement.interval.end > insertion.at + insertion.duration + MATH_TEX_TRANSFORM_PROJECTION_EPSILON ||
      !sameProjectionNumber(
        replacement.interval.end - replacement.interval.start,
        operation.interval.end - operation.interval.start,
      ) ||
      !sameProjectionNumber(replacement.targetLifetime.start, replacement.interval.start) ||
      !Number.isFinite(replacement.targetLifetime.end) ||
      replacement.targetLifetime.end + MATH_TEX_TRANSFORM_PROJECTION_EPSILON < replacement.interval.end
    ) {
      throw new TypeError(
        `MathTex transform operation ${replacement.operationId} is not correlated with the Rust projection.`,
      );
    }
    return { operation, program: expected.program, replacement };
  });
  correlatedReplacements.forEach(({ replacement }, index) => {
    const next = correlatedReplacements[index + 1]?.replacement;
    if (
      (next &&
        (next.sourceEntityId !== replacement.targetEntityId ||
          next.interval.start + MATH_TEX_TRANSFORM_PROJECTION_EPSILON < replacement.interval.end ||
          !sameProjectionNumber(replacement.targetLifetime.end, next.interval.end))) ||
      (!next && replacement.targetLifetime.end > projection.projectedDuration + MATH_TEX_TRANSFORM_PROJECTION_EPSILON)
    ) {
      throw new TypeError(
        `MathTex transform lifetime ${replacement.operationId} is not correlated with the Rust chain.`,
      );
    }
  });
  return { motions: correlatedMotions ?? [], replacements: correlatedReplacements };
}

export function selectMathTexTransformProjection(
  baseDuration: number,
  programs: readonly SceneEdit[],
  projection: StudioMathTexTransformProjectionV1 | null,
): StudioMathTexTransformProjectionV1 | null {
  const correlated = correlateMathTexTransformProjection(baseDuration, programs, projection);
  if (!correlated) return null;
  if (!projection) throw new TypeError("The correlated MathTex transform projection is missing.");
  return {
    insertions: projection.insertions,
    motions: correlated.motions.map(({ motion }) => motion),
    projectedDuration: projection.projectedDuration,
    replacements: correlated.replacements.map(({ replacement }) => replacement),
  };
}

function mathTexContentMutationMatchesOperation(mutation: StudioStaticRootMutationV1, operation: SceneEditOperation) {
  const isContentOperation = operation.kind === "SetProperty" && operation.key === "content";
  if (mutation.kind !== "math-tex-content" || !isContentOperation) {
    return mutation.kind !== "math-tex-content" && !isContentOperation;
  }
  const expectedContent = canonicalEditableContent(operation.value, "MathTex");
  return (
    expectedContent?.texParts !== undefined &&
    mutation.entityId === operation.entityId &&
    mutation.interval.start === 0 &&
    mutation.interval.end === 0 &&
    mutation.content.label === expectedContent.label &&
    sameStrings(mutation.content.displayLines, expectedContent.displayLines) &&
    sameStrings(mutation.content.texParts, expectedContent.texParts)
  );
}

function correlateStaticRootProjection(
  programs: readonly SceneEdit[],
  projection: StudioStaticRootProjectionV1 | null,
): readonly CorrelatedStaticRootMutation[] | null {
  if (!isStaticRootWorkspaceProjectionProgramBatch(programs)) return null;
  if (!projection) {
    throw new TypeError("A Rust static-root projection is required to project static imported-root Programs.");
  }
  const operations = programs.flatMap((program) =>
    program.operations.flatMap((operation) =>
      operation.kind === "CreateMotion" || isPersistentRemoveOperation(operation)
        ? []
        : [{ operation, program } as const],
    ),
  );
  const operationById = new Map(operations.map((entry) => [entry.operation.id, entry] as const));
  if (operationById.size !== operations.length || projection.mutations.length !== operations.length) {
    throw new TypeError("The Rust static-root projection does not contain the complete Program batch.");
  }
  const operationIds = new Set<string>();
  return projection.mutations.map((mutation) => {
    const expected = operationById.get(mutation.operationId);
    if (
      !expected ||
      operationIds.has(mutation.operationId) ||
      mutation.transactionId !== expected.program.transactionId ||
      !mathTexContentMutationMatchesOperation(mutation, expected.operation)
    ) {
      throw new TypeError(`Static-root operation ${mutation.operationId} is not correlated with the Rust projection.`);
    }
    operationIds.add(mutation.operationId);
    return { mutation, ...expected };
  });
}

export function selectStaticRootProjection(
  programs: readonly SceneEdit[],
  projection: StudioStaticRootProjectionV1 | null,
): StudioStaticRootProjectionV1 | null {
  if (!isStaticRootWorkspaceProjectionProgramBatch(programs)) return null;
  const correlated = correlateStaticRootProjection(programs, projection);
  return correlated && projection
    ? {
        insertions: projection.insertions,
        mutations: correlated.map(({ mutation }) => mutation),
        projectedDuration: projection.projectedDuration,
      }
    : null;
}

function boundEntityProjectionPayloadMatches(operation: SceneEditOperation, projection: StudioBoundEntityProjectionV1) {
  if (projection.kind === "position") {
    return (
      operation.kind === "SetProperty" &&
      operation.key === "position" &&
      typeof operation.value === "object" &&
      operation.value !== null &&
      "x" in operation.value &&
      "y" in operation.value &&
      sameProjectionNumber(operation.value.x, projection.value.x) &&
      sameProjectionNumber(operation.value.y, projection.value.y)
    );
  }
  if (projection.kind === "opacity") {
    return (
      operation.kind === "SetProperty" &&
      operation.key === "appearance" &&
      typeof operation.value === "number" &&
      sameProjectionNumber(operation.value, projection.value)
    );
  }
  return (
    operation.kind === "AnimateProperty" &&
    operation.key === (projection.kind === "rotation" ? "rotation" : "scale") &&
    typeof operation.from === "number" &&
    typeof operation.to === "number" &&
    sameProjectionNumber(operation.from, projection.from) &&
    sameProjectionNumber(operation.to, projection.to)
  );
}

export function selectBoundEntityProjection(
  programs: readonly SceneEdit[],
  projection: StudioBoundEntityProjectionV1 | null,
): StudioBoundEntityProjectionV1 | null {
  const program = programs.length === 1 ? programs[0] : undefined;
  const operation = program?.operations.length === 1 ? program.operations[0] : undefined;
  if (!program || !operation) return null;
  if (!projection) {
    throw new TypeError("A Rust bound-entity projection is required to project a source-bound endpoint Program.");
  }
  if (
    projection.operationId !== operation.id ||
    projection.transactionId !== program.transactionId ||
    !("entityId" in operation) ||
    projection.studioEntityId !== operation.entityId ||
    !sameProjectionNumber(projection.interval.start, operation.interval.start) ||
    !sameProjectionNumber(projection.interval.end, operation.interval.end) ||
    !boundEntityProjectionPayloadMatches(operation, projection)
  ) {
    throw new TypeError(`Source-bound operation ${operation.id} is not correlated with the Rust projection.`);
  }
  return projection;
}

function appendProjectedSample(
  propertyChannels: Record<string, PropertyChannel>,
  entityId: string,
  key: PropertyChannel["key"],
  sample: PropertyChannelSample,
) {
  const id = `${entityId}/${key}`;
  const channel = propertyChannels[id];
  const samples = [...(channel?.samples ?? []), sample];
  propertyChannels[id] = {
    entityId,
    key,
    samples: key === "content" ? normalizeContentSamples(samples) : samples,
  };
}

function appendProjectedMutation(
  draft: MotionProjectionDraft,
  mutation: StudioBoundEntityProjectionV1 | StudioCreationProjectionMutationV1 | StudioStaticRootMutationV1,
  projectedDuration?: number,
  semanticShape?: Extract<SceneEditOperation, { kind: "TransformShape" }>["to"]["shape"],
) {
  if (mutation.kind === "animate-camera") {
    // The exact prepared interaction bounds already include the sampled Rust
    // camera. Adding a TypeScript camera channel would transform overlays twice.
    return;
  }
  if (mutation.kind === "scene-background") {
    // Rust has already materialized the camera clear color. The workspace
    // object graph has no duplicate Scene-level color channel to evaluate.
    return;
  }
  const entityId = "studioEntityId" in mutation ? mutation.studioEntityId : mutation.entityId;
  const metadata = {
    operationId: mutation.operationId,
    provenanceId: `${mutation.operationId}/provenance`,
  };
  if (mutation.kind === "position") {
    appendProjectedSample(draft.propertyChannels, entityId, "position", {
      ...metadata,
      interval:
        projectedDuration === undefined
          ? mutation.interval
          : { end: projectedDuration, start: mutation.interval.start },
      kind: "exact",
      value: mutation.value,
    });
  } else if (mutation.kind === "opacity") {
    appendProjectedSample(draft.propertyChannels, entityId, "appearance", {
      ...metadata,
      interval: { end: projectedDuration ?? mutation.interval.end, start: mutation.interval.start },
      kind: "exact",
      value: mutation.value,
    });
  } else if (mutation.kind === "opacity-keyframes") {
    appendProjectedSample(draft.propertyChannels, entityId, "appearance", {
      ...metadata,
      easing: mutation.easing,
      from: mutation.from,
      interval: mutation.interval,
      kind: mutation.interval.end > mutation.interval.start ? "animated" : "exact",
      value: mutation.to,
    });
  } else if (mutation.kind === "material-parameter-keyframes") {
    // The canonical VectorAppearance channel is sampled in Rust; this correlated mutation
    // only supplies working-time marker positions to the timeline.
  } else if (mutation.kind === "paint-color-keyframes") {
    // Rust owns color interpolation in the canonical VectorAppearance channel.
    // This mutation only correlates the Timeline marker interval with its Program.
  } else if (mutation.kind === "path-morph") {
    // Rust owns cubic-path interpolation and the WebGPU interaction projection.
    // This mutation only correlates the editable Timeline clip with its Program.
  } else if (mutation.kind === "draw-in" || mutation.kind === "write-in") {
    // Rust evaluates the canonical entrance channels. This projection only
    // correlates the Studio timeline clip with those authoritative channels.
  } else if (mutation.kind === "fill-color" || mutation.kind === "stroke-color") {
    appendProjectedSample(
      draft.propertyChannels,
      entityId,
      mutation.kind === "fill-color" ? "fillColor" : "strokeColor",
      {
        ...metadata,
        interval: { end: projectedDuration ?? mutation.interval.end, start: mutation.interval.start },
        kind: "exact",
        value: mutation.value,
      },
    );
  } else if (mutation.kind === "stroke-width") {
    appendProjectedSample(draft.propertyChannels, entityId, "strokeWidth", {
      ...metadata,
      interval: { end: projectedDuration ?? mutation.interval.end, start: mutation.interval.start },
      kind: "exact",
      value: mutation.value,
    });
  } else if (mutation.kind === "stroke-cap") {
    appendProjectedSample(draft.propertyChannels, entityId, "strokeCap", {
      ...metadata,
      interval: { end: projectedDuration ?? mutation.interval.end, start: mutation.interval.start },
      kind: "exact",
      value: mutation.value,
    });
  } else if (mutation.kind === "stroke-dash") {
    appendProjectedSample(draft.propertyChannels, entityId, "strokeDash", {
      ...metadata,
      interval: { end: projectedDuration ?? mutation.interval.end, start: mutation.interval.start },
      kind: "exact",
      value: mutation.value,
    });
  } else if (mutation.kind === "source-z-index") {
    appendProjectedSample(draft.propertyChannels, entityId, "sourceZIndex", {
      ...metadata,
      interval: { end: projectedDuration ?? mutation.interval.end, start: mutation.interval.start },
      kind: "exact",
      value: mutation.sourceZIndex,
    });
  } else if (mutation.kind === "visibility") {
    appendProjectedSample(draft.propertyChannels, entityId, "visibility", {
      ...metadata,
      interval: { end: projectedDuration ?? mutation.interval.end, start: mutation.interval.start },
      kind: "exact",
      value: mutation.visible,
    });
  } else if (mutation.kind === "rotation" || mutation.kind === "rotation-keyframes") {
    appendProjectedSample(draft.propertyChannels, entityId, "rotation", {
      ...metadata,
      easing: mutation.kind === "rotation-keyframes" ? mutation.easing : "smooth",
      from: mutation.from,
      interval: mutation.interval,
      kind: "animated",
      value: mutation.to,
    });
  } else if (mutation.kind === "fade-in") {
    appendProjectedSample(draft.propertyChannels, entityId, "appearance", {
      ...metadata,
      easing: "smooth",
      from: mutation.from,
      interval: mutation.interval,
      kind: "animated",
      value: mutation.to,
    });
    appendProjectedSample(draft.propertyChannels, entityId, "appearance", {
      ...metadata,
      interval: { end: projectedDuration ?? mutation.interval.end, start: mutation.interval.end },
      kind: "exact",
      value: mutation.to,
    });
  } else if (mutation.kind === "uniform-scale" || mutation.kind === "uniform-scale-keyframes") {
    appendProjectedSample(draft.propertyChannels, entityId, "scale", {
      ...metadata,
      easing:
        mutation.kind === "uniform-scale-keyframes"
          ? mutation.easing
          : ("easing" in mutation && mutation.easing) || "smooth",
      from: mutation.from,
      interval: mutation.interval,
      kind: "animated",
      value: mutation.to,
    });
  } else if (mutation.kind === "resize") {
    const kind = mutation.interval.end > mutation.interval.start ? "animated" : "exact";
    for (const [key, from, value] of [
      ["dimensions", mutation.fromDimensions, mutation.toDimensions],
      ["position", mutation.fromPosition, mutation.toPosition],
    ] as const) {
      appendProjectedSample(draft.propertyChannels, entityId, key, {
        ...metadata,
        from,
        interval: mutation.interval,
        kind,
        value,
      });
    }
  } else if (mutation.kind === "shape-transform") {
    appendProjectedSample(draft.propertyChannels, entityId, "dimensions", {
      ...metadata,
      easing: mutation.easing,
      from: mutation.fromDimensions,
      interval: mutation.interval,
      kind: "animated",
      value: mutation.toDimensions,
    });
    appendProjectedSample(draft.propertyChannels, entityId, "shape", {
      ...metadata,
      interval: { end: mutation.interval.end, start: mutation.interval.end },
      kind: "exact",
      value: semanticShape ?? mutation.toShape,
    });
  } else if (mutation.kind === "math-tex-transform") {
    appendProjectedSample(draft.propertyChannels, entityId, "content", {
      ...metadata,
      interval: { end: projectedDuration ?? mutation.interval.end, start: mutation.interval.end },
      kind: "exact",
      value: mutation.content,
    });
  } else {
    appendProjectedSample(draft.propertyChannels, entityId, "content", {
      ...metadata,
      interval: mutation.interval,
      kind: "exact",
      value: mutation.content,
    });
  }
}

type MotionProjectionDraft = {
  entities: Record<string, RuntimeEntity>;
  events: WorkingState["runtimeSceneState"]["eventTrack"]["events"][number][];
  propertyChannels: Record<string, PropertyChannel>;
  provenance: WorkingState["runtimeSceneState"]["provenanceGraph"]["records"][number][];
};

type WorkspaceProjectionDraft = MotionProjectionDraft & {
  constraints: WorkingState["runtimeSceneState"]["constraintGraph"]["constraints"][number][];
  duration: number;
  lineage: WorkingState["runtimeSceneState"]["objectGraph"]["lineage"][number][];
};

function cloneProjectionDraft(scene: WorkingState["runtimeSceneState"]): WorkspaceProjectionDraft {
  return {
    constraints: [...scene.constraintGraph.constraints],
    duration: scene.duration,
    entities: Object.fromEntries(
      Object.entries(scene.objectGraph.entities).map(([id, entity]) => [
        id,
        { ...entity, lifetime: entity.lifetime.map((interval) => ({ ...interval })) },
      ]),
    ),
    events: [...scene.eventTrack.events],
    lineage: [...scene.objectGraph.lineage],
    propertyChannels: Object.fromEntries(
      Object.entries(scene.propertyChannels).map(([id, channel]) => [
        id,
        { ...channel, samples: [...channel.samples] },
      ]),
    ),
    provenance: [...scene.provenanceGraph.records],
  };
}

function projectedWorkingState(
  workingState: WorkingState,
  records: readonly ProgramRecord[],
  draft: WorkspaceProjectionDraft,
): ProposedState {
  return {
    base: workingState,
    evaluatedScene: {
      ...workingState.runtimeSceneState,
      constraintGraph: { constraints: draft.constraints },
      duration: draft.duration,
      eventTrack: {
        events: draft.events.sort(
          (left, right) => (left.at ?? left.interval?.start ?? 0) - (right.at ?? right.interval?.start ?? 0),
        ),
      },
      objectGraph: { entities: draft.entities, lineage: draft.lineage },
      propertyChannels: draft.propertyChannels,
      provenanceGraph: { records: draft.provenance },
    },
    issues: [],
    programs: records.map((record) => ({ ...record, validation: { issues: [], status: "valid" } })),
    version: STUDIO_STATE_VERSION,
  };
}

function appendProjectedOperationRecord(
  draft: MotionProjectionDraft,
  operation: SceneEditOperation,
  program: SceneEdit,
  interval: Readonly<{ end: number; start: number }>,
) {
  const provenanceId = `${operation.id}/provenance`;
  draft.provenance.push({
    evidence: [...program.anchor.evidence, ...operation.provenance.evidence],
    id: provenanceId,
    operationId: operation.id,
    origin: operation.provenance.origin,
    transactionId: program.transactionId,
  });
  draft.events.push({
    id: `${operation.id}/event`,
    interval,
    kind: "operation",
    label: operation.kind,
    operationId: operation.id,
    transactionId: program.transactionId,
  });
}

function projectBoundEntityWorkingState(
  workingState: WorkingState,
  projection: StudioBoundEntityProjectionV1,
): ProposedState {
  const records = [...workingState.appliedEdits, ...workingState.stagedEdits];
  const programs = records.map(({ program }) => program);
  const correlated = selectBoundEntityProjection(programs, projection);
  const program = programs[0];
  const operation = program?.operations[0];
  if (!correlated || !program || !operation) {
    throw new TypeError("Only one source-bound endpoint Program can use the Rust bound-entity projection.");
  }
  const draft = cloneProjectionDraft(workingState.runtimeSceneState);
  if (!draft.entities[correlated.studioEntityId]) {
    throw new TypeError(`Source-bound entity ${correlated.studioEntityId} is not in the Studio workspace.`);
  }
  appendProjectedOperationRecord(draft, operation, program, correlated.interval);
  appendProjectedMutation(draft, correlated, draft.duration);
  return projectedWorkingState(workingState, records, draft);
}

function appendCorrelatedMotions(
  draft: MotionProjectionDraft,
  correlated: readonly CorrelatedProjectedMotion[],
  recordedOperationIds = new Set<string>(),
) {
  for (const { motion, operation, program } of correlated) {
    const target = draft.entities[motion.targetEntityId];
    if (
      !target ||
      !target.lifetime.some(
        (lifetime) =>
          lifetime.start <= motion.interval.start + MATH_TEX_TRANSFORM_PROJECTION_EPSILON &&
          lifetime.end + MATH_TEX_TRANSFORM_PROJECTION_EPSILON >= motion.interval.end,
      )
    ) {
      throw new TypeError(`Motion ${motion.operationId} targets an unavailable projected entity.`);
    }
    const provenanceId = `${motion.operationId}/provenance`;
    if (!recordedOperationIds.has(motion.operationId)) {
      appendProjectedOperationRecord(draft, operation, program, motion.interval);
      recordedOperationIds.add(motion.operationId);
    }
    appendProjectedSample(draft.propertyChannels, motion.targetEntityId, "position", {
      control: motion.control,
      easing: motion.easing,
      from: motion.from,
      interval: motion.interval,
      kind: "animated",
      operationId: motion.operationId,
      provenanceId,
      value: motion.to,
    });
  }
}

function appendPersistentRemovals(
  draft: WorkspaceProjectionDraft,
  programs: readonly SceneEdit[],
  projection: StudioPersistentRemoveProjectionV1,
) {
  const operationById = new Map(
    programs.flatMap((program) =>
      program.operations.map((operation) => [operation.id, { operation, program }] as const),
    ),
  );
  for (const removal of projection.removals) {
    const expected = operationById.get(removal.operationId);
    const operation = expected?.operation;
    const entity = draft.entities[removal.studioEntityId];
    if (!expected || !operation || !isPersistentRemoveOperation(operation) || !entity) {
      throw new TypeError(`Persistent remove ${removal.operationId} is not available in the workspace projection.`);
    }
    const eventInterval = removal.fadeInterval ?? { end: removal.removedAt, start: removal.removedAt };
    appendProjectedOperationRecord(draft, operation, expected.program, eventInterval);
    draft.entities[removal.studioEntityId] = {
      ...entity,
      lifetime: entity.lifetime.flatMap((interval) => {
        if (interval.start >= removal.removedAt) return [];
        return interval.end > removal.removedAt ? [{ ...interval, end: removal.resultingLifetimeEnd }] : [interval];
      }),
    };
    if (removal.fadeInterval) {
      appendProjectedSample(draft.propertyChannels, removal.studioEntityId, "appearance", {
        easing: "smooth",
        from: 1,
        interval: removal.fadeInterval,
        kind: "animated",
        operationId: removal.operationId,
        provenanceId: `${removal.operationId}/provenance`,
        value: 0,
      });
    }
    for (const key of ["appearance", "presence"] as const) {
      appendProjectedSample(draft.propertyChannels, removal.studioEntityId, key, {
        interval: { end: draft.duration, start: removal.removedAt },
        kind: "exact",
        operationId: removal.operationId,
        provenanceId: `${removal.operationId}/provenance`,
        value: key === "appearance" ? 0 : false,
      });
    }
    draft.lineage.push({
      at: removal.removedAt,
      from: removal.studioEntityId,
      operationId: removal.operationId,
      relation: "removed",
      to: removal.studioEntityId,
    });
  }
}

function projectCreationWorkingState(
  workingState: WorkingState,
  projection: StudioCreationProjectionV1,
): ProposedState {
  const records = [...workingState.appliedEdits, ...workingState.stagedEdits];
  const programs = records.map(({ program }) => program);
  const correlated = correlateCreationProjection(workingState.runtimeSceneState.duration, programs, projection);
  if (!correlated) throw new TypeError("Only a Studio creation Program batch can use this projection.");
  const draft = cloneProjectionDraft(workingState.runtimeSceneState);
  for (const insertion of projection.insertions) insertSceneTime(draft, insertion.at, insertion.duration);
  if (!sameProjectionNumber(draft.duration, projection.projectedDuration)) {
    throw new TypeError("The Rust creation projection returned a stale projected Scene duration.");
  }

  const appliedTransactionIds = new Set(workingState.appliedEdits.map(({ program }) => program.transactionId));
  for (const { entity, operation, program } of correlated.entities) {
    if (draft.entities[entity.entityId]) {
      throw new TypeError(`Created entity ${entity.entityId} already exists in the Studio workspace.`);
    }
    const hasShapeGeometry =
      entity.kind === "arc" ||
      entity.kind === "axes" ||
      entity.kind === "circle" ||
      entity.kind === "cubic-bezier" ||
      entity.kind === "data-plot" ||
      entity.kind === "ellipse" ||
      entity.kind === "number-line" ||
      entity.kind === "number-plane" ||
      entity.kind === "rectangle" ||
      entity.kind === "regular-polygon" ||
      entity.kind === "sector" ||
      entity.kind === "svg-path";
    draft.entities[entity.entityId] = {
      ...(operation.entity.content ? { content: operation.entity.content } : {}),
      ...(hasShapeGeometry
        ? {
            geometry: {
              dimensions: { kind: "known" as const, value: entity.initialDimensions },
              position: { kind: "unknown" as const, reason: "Position is projected by its creation mutation." },
              scale: { kind: "known" as const, value: entity.initialScale },
              style: {
                kind: "known" as const,
                value: {
                  ...(entity.fillColor === undefined ? {} : { fillColor: entity.fillColor }),
                  ...(entity.strokeColor === undefined ? {} : { strokeColor: entity.strokeColor }),
                },
              },
            },
          }
        : {}),
      id: entity.entityId,
      lifetime: [{ ...entity.createdLifetime }],
      provisional: !appliedTransactionIds.has(program.transactionId),
      sourceIdentity: {
        evidence: [operation.id],
        kind: "unknown",
        reason: "Entity has not been lowered to source yet.",
      },
      transactionId: program.transactionId,
      type: operation.entity.type,
    };
    appendProjectedOperationRecord(draft, operation, program, {
      end: entity.createdLifetime.start,
      start: entity.createdLifetime.start,
    });
    draft.lineage.push({
      at: entity.createdLifetime.start,
      from: entity.entityId,
      operationId: operation.id,
      relation: "created",
      to: entity.entityId,
    });
    appendProjectedSample(draft.propertyChannels, entity.entityId, "presence", {
      interval: entity.createdLifetime,
      kind: "exact",
      operationId: operation.id,
      provenanceId: `${operation.id}/provenance`,
      value: true,
    });
  }

  const recordedMotionOperationIds = new Set<string>();
  for (const { mutation, operation, program } of correlated.mutations) {
    if (
      mutation.kind !== "animate-camera" &&
      mutation.kind !== "scene-background" &&
      !draft.entities[mutation.entityId]
    ) {
      throw new TypeError(`Creation mutation ${mutation.operationId} targets a missing projected entity.`);
    }
    appendProjectedOperationRecord(draft, operation, program, mutation.interval);
    recordedMotionOperationIds.add(operation.id);
    appendProjectedMutation(
      draft,
      mutation,
      projection.projectedDuration,
      operation.kind === "TransformShape" ? operation.to.shape : undefined,
    );
  }
  appendCorrelatedMotions(draft, correlated.motions, recordedMotionOperationIds);
  appendPersistentRemovals(draft, programs, correlated.removals);

  return projectedWorkingState(workingState, records, draft);
}

function projectStaticRootWorkingState(
  workingState: WorkingState,
  projection: StudioStaticRootProjectionV1,
  motionProjection: StudioMotionProjectionV1 | null = null,
  persistentRemoveProjection: StudioPersistentRemoveProjectionV1 | null = null,
): ProposedState {
  const records = [...workingState.appliedEdits, ...workingState.stagedEdits];
  const programs = records.map(({ program }) => program);
  const correlated = correlateStaticRootProjection(programs, projection);
  if (!correlated) throw new TypeError("Only an exact static-root Program batch can use this projection.");
  const draft = cloneProjectionDraft(workingState.runtimeSceneState);
  for (const insertion of projection.insertions) {
    insertSceneTime(draft, insertion.at, insertion.duration);
  }
  for (const insertion of motionProjection?.insertions ?? []) {
    insertSceneTime(draft, insertion.at, insertion.duration);
  }
  if (
    !sameProjectionNumber(draft.duration, projection.projectedDuration) ||
    (motionProjection && !sameProjectionNumber(draft.duration, motionProjection.projectedDuration))
  ) {
    throw new TypeError("The Rust static-root projection returned a stale projected duration.");
  }
  correlated.forEach(({ mutation, operation, program }) => {
    if (!draft.entities[mutation.entityId]) {
      throw new TypeError(`Rust static-root projection target ${mutation.entityId} is not in the imported Scene.`);
    }
    appendProjectedOperationRecord(draft, operation, program, mutation.interval);
    appendProjectedMutation(draft, mutation);
  });
  if (motionProjection) {
    const correlatedMotions = correlateMotionProjection(
      workingState.runtimeSceneState.duration,
      programs,
      motionProjection,
    );
    if (!correlatedMotions) {
      throw new TypeError("The Rust static-root motion projection contains no motion.");
    }
    appendCorrelatedMotions(draft, correlatedMotions);
  }
  if (persistentRemoveProjection) appendPersistentRemovals(draft, programs, persistentRemoveProjection);
  return projectedWorkingState(workingState, records, draft);
}

function projectPersistentRemoveWorkingState(
  workingState: WorkingState,
  projection: StudioPersistentRemoveProjectionV1,
): ProposedState {
  const records = [...workingState.appliedEdits, ...workingState.stagedEdits];
  const programs = records.map(({ program }) => program);
  if (!isPersistentRemoveProgramBatch(programs)) {
    throw new TypeError("Persistent remove projection requires one closed remove-only Program batch.");
  }
  const draft = cloneProjectionDraft(workingState.runtimeSceneState);
  appendPersistentRemovals(draft, programs, projection);
  return projectedWorkingState(workingState, records, draft);
}

function projectMathTexTransformWorkingState(
  workingState: WorkingState,
  projection: StudioMathTexTransformProjectionV1,
): ProposedState {
  const records = [...workingState.appliedEdits, ...workingState.stagedEdits];
  const programs = records.map(({ program }) => program);
  const correlated = correlateMathTexTransformProjection(workingState.runtimeSceneState.duration, programs, projection);
  if (!correlated) throw new TypeError("Only an exact TransformContent Program batch can use this projection.");
  const draft = cloneProjectionDraft(workingState.runtimeSceneState);
  for (const insertion of projection.insertions) insertSceneTime(draft, insertion.at, insertion.duration);
  if (!sameProjectionNumber(draft.duration, projection.projectedDuration)) {
    throw new TypeError("The Rust MathTex transform projection did not produce the projected Scene duration.");
  }

  const first = correlated.replacements[0]?.replacement;
  const last = correlated.replacements.at(-1)?.replacement;
  const initialSource = first ? draft.entities[first.sourceEntityId] : undefined;
  const initialSourceLifetime = first
    ? initialSource?.lifetime.find(
        (lifetime) => first.interval.start >= lifetime.start && first.interval.start < lifetime.end,
      )
    : undefined;
  if (!first || !last || !initialSource || !initialSourceLifetime) {
    throw new TypeError("The Rust MathTex transform projection source is not active in the imported Scene.");
  }
  if (!sameProjectionNumber(initialSourceLifetime.end, last.targetLifetime.end)) {
    throw new TypeError("The Rust MathTex transform projection returned a stale terminal lifetime.");
  }

  const appliedTransactionIds = new Set(workingState.appliedEdits.map(({ program }) => program.transactionId));
  for (const { operation, program, replacement } of correlated.replacements) {
    const source = draft.entities[replacement.sourceEntityId];
    const sourceLifetime = source?.lifetime.find(
      (lifetime) => replacement.interval.start >= lifetime.start && replacement.interval.start < lifetime.end,
    );
    if (
      !source ||
      !sourceLifetime ||
      sourceLifetime.end + MATH_TEX_TRANSFORM_PROJECTION_EPSILON < replacement.interval.end ||
      draft.entities[replacement.targetEntityId]
    ) {
      throw new TypeError(`MathTex transform ${replacement.operationId} is stale for the Studio workspace.`);
    }
    draft.entities[replacement.sourceEntityId] = {
      ...source,
      lifetime: source.lifetime.map((lifetime) =>
        lifetime === sourceLifetime ? { ...lifetime, end: Math.min(lifetime.end, replacement.interval.end) } : lifetime,
      ),
    };
    draft.entities[replacement.targetEntityId] = {
      content: replacement.content,
      geometry: source.geometry,
      id: replacement.targetEntityId,
      lifetime: [{ ...replacement.targetLifetime }],
      provisional: !appliedTransactionIds.has(program.transactionId),
      sourceIdentity: source.sourceIdentity,
      transactionId: program.transactionId,
      type: "MathTex",
    };
    draft.lineage.push({
      at: replacement.interval.end,
      from: replacement.sourceEntityId,
      operationId: replacement.operationId,
      relation: "replaces",
      to: replacement.targetEntityId,
    });
    for (const channel of Object.values(draft.propertyChannels).filter(
      (entry) => entry.entityId === replacement.sourceEntityId && entry.key !== "content",
    )) {
      draft.propertyChannels[`${replacement.targetEntityId}/${channel.key}`] = {
        ...channel,
        entityId: replacement.targetEntityId,
        samples: [...channel.samples],
      };
    }

    const provenanceId = `${replacement.operationId}/provenance`;
    appendProjectedOperationRecord(draft, operation, program, replacement.interval);
    appendProjectedSample(draft.propertyChannels, replacement.targetEntityId, "content", {
      interval: { end: replacement.targetLifetime.end, start: replacement.interval.end },
      kind: "exact",
      operationId: replacement.operationId,
      provenanceId,
      value: replacement.content,
    });
    appendProjectedSample(draft.propertyChannels, replacement.sourceEntityId, "appearance", {
      easing: "smooth",
      from: 1,
      interval: replacement.interval,
      kind: "animated",
      operationId: replacement.operationId,
      provenanceId,
      value: 0,
    });
    appendProjectedSample(draft.propertyChannels, replacement.targetEntityId, "appearance", {
      easing: "smooth",
      from: 0,
      interval: replacement.interval,
      kind: "animated",
      operationId: replacement.operationId,
      provenanceId,
      value: 1,
    });
  }
  appendCorrelatedMotions(draft, correlated.motions);

  return projectedWorkingState(workingState, records, draft);
}

function projectMotionWorkingState(workingState: WorkingState, projection: StudioMotionProjectionV1): ProposedState {
  const records = [...workingState.appliedEdits, ...workingState.stagedEdits];
  const programs = records.map(({ program }) => program);
  if (studioMotionProjectionBatchKind(programs) !== "standalone") {
    throw new TypeError("Only a standalone CreateMotion batch can use the Rust motion projection directly.");
  }
  const correlated = correlateMotionProjection(workingState.runtimeSceneState.duration, programs, projection, true);
  if (!correlated) throw new TypeError("Only a motion-bearing Program batch can use the Rust motion projection.");
  const draft = cloneProjectionDraft(workingState.runtimeSceneState);
  for (const insertion of projection.insertions) insertSceneTime(draft, insertion.at, insertion.duration);
  if (!sameProjectionNumber(draft.duration, projection.projectedDuration)) {
    throw new TypeError("The Rust motion projection does not match the projected Studio duration.");
  }
  appendCorrelatedMotions(draft, correlated);
  return projectedWorkingState(workingState, records, draft);
}

function projectBaseWorkingState(workingState: WorkingState): ProposedState {
  if (workingState.appliedEdits.length > 0 || workingState.stagedEdits.length > 0) {
    throw new TypeError("A base workspace projection cannot contain Edit Programs.");
  }
  return projectedWorkingState(workingState, [], cloneProjectionDraft(workingState.runtimeSceneState));
}

export function projectStudioWorkspace(
  input: Readonly<{
    activeScene: AuthorableWorkspaceScene;
    appliedEdits: readonly ProgramRecord[];
    boundEntityProjection?: StudioBoundEntityProjectionV1 | null;
    creationProjection?: StudioCreationProjectionV1 | null;
    currentTime: number;
    draftEdit: ProgramRecord | null;
    nextScene: ManimWorkspaceScene | null;
    mathTexTransformProjection?: StudioMathTexTransformProjectionV1 | null;
    motionProjection?: StudioMotionProjectionV1 | null;
    persistentRemoveProjection?: StudioPersistentRemoveProjectionV1 | null;
    editAuthority?: StudioEditProjectionAuthority | null;
    selectedObjectIds: readonly string[];
    staticRootProjection?: StudioStaticRootProjectionV1 | null;
    timelineProjection?: StudioTimelineProjectionV1 | null;
  }>,
) {
  const workingState = studioWorkspaceWorkingState(input.activeScene, {
    appliedEdits: input.appliedEdits,
    playhead: input.currentTime,
    selection: input.selectedObjectIds,
    stagedEdits: input.draftEdit ? [input.draftEdit] : [],
  });
  const programs = [...workingState.appliedEdits, ...workingState.stagedEdits].map((record) => record.program);
  const hasStudioNativeAuthoring = programs.some((program) =>
    program.operations.some(isStudioNativeAuthoringBatchOperation),
  );
  const hasMotion = programs.some((program) => program.operations.some(({ kind }) => kind === "CreateMotion"));
  const hasMathTexTransform = programs.some((program) =>
    program.operations.some(({ kind }) => kind === "TransformContent"),
  );
  const motionBatchKind =
    hasMotion && !hasStudioNativeAuthoring && !hasMathTexTransform ? studioMotionProjectionBatchKind(programs) : null;
  const containsSceneDurationOperation = programs.some((program) => program.operations.some(isSceneDurationOperation));
  const persistentRemoveProjection = hasStudioNativeAuthoring
    ? null
    : selectPersistentRemoveProjection(programs, input.persistentRemoveProjection ?? null);
  let proposedState: ProposedState;
  if (containsSceneDurationOperation && !hasStudioNativeAuthoring) {
    if (persistentRemoveProjection) {
      throw new TypeError("Scene duration and persistent remove Programs cannot share one workspace projection.");
    }
    if (!isSceneDurationProgramBatch(programs)) {
      throw new TypeError(
        "Scene duration Programs cannot be mixed with another operation family in one workspace projection.",
      );
    }
    if (!input.timelineProjection) {
      throw new TypeError("A Rust timeline projection is required to project Scene duration Programs.");
    }
    proposedState = projectLegacyTimelineProposedState(
      workingState,
      correlateTimelineProgramBatch(programs, input.timelineProjection),
    );
  } else if (input.editAuthority === "source-bound-endpoint") {
    if (!input.boundEntityProjection) {
      throw new TypeError("A Rust bound-entity projection is required for a source-bound endpoint Program.");
    }
    proposedState = projectBoundEntityWorkingState(workingState, input.boundEntityProjection);
  } else if (hasStudioNativeAuthoring) {
    if (input.editAuthority !== "rust-authorized-batch") {
      throw new TypeError("Studio-native authoring requires one Rust-authorized batch.");
    }
    if (!input.creationProjection) {
      throw new TypeError("A Rust creation projection is required to project Studio-native Programs.");
    }
    proposedState = projectCreationWorkingState(workingState, input.creationProjection);
  } else if (
    input.editAuthority === "rust-authorized-batch" &&
    programs.some((program) => program.operations.some(({ kind }) => kind === "TransformContent"))
  ) {
    if (!isExactStudioMathTexTransformProgramBatch(programs)) {
      throw new TypeError("TransformContent requires one closed Rust MathTex transform batch.");
    }
    if (!input.mathTexTransformProjection) {
      throw new TypeError("A Rust MathTex transform projection is required to project TransformContent Programs.");
    }
    proposedState = projectMathTexTransformWorkingState(workingState, input.mathTexTransformProjection);
  } else if (input.editAuthority === "static-imported-root" && isStaticRootWorkspaceProjectionProgramBatch(programs)) {
    if (!input.staticRootProjection) {
      throw new TypeError("A Rust static-root projection is required to project static imported-root Programs.");
    }
    if (hasMotion && !input.motionProjection) {
      throw new TypeError("A Rust motion projection is required to project static-root CreateMotion Programs.");
    }
    proposedState = projectStaticRootWorkingState(
      workingState,
      input.staticRootProjection,
      hasMotion ? input.motionProjection : null,
      persistentRemoveProjection,
    );
  } else if (
    input.editAuthority === "rust-authorized-batch" &&
    persistentRemoveProjection &&
    isPersistentRemoveProgramBatch(programs)
  ) {
    proposedState = projectPersistentRemoveWorkingState(workingState, persistentRemoveProjection);
  } else if (input.editAuthority === "rust-authorized-batch" && motionBatchKind === "standalone") {
    if (!input.motionProjection) {
      throw new TypeError("A Rust motion projection is required to project standalone CreateMotion Programs.");
    }
    proposedState = projectMotionWorkingState(workingState, input.motionProjection);
  } else if (programs.length === 0) {
    proposedState = projectBaseWorkingState(workingState);
  } else {
    if (persistentRemoveProjection) {
      throw new TypeError("Persistent remove Programs require one closed Rust-authorized projection batch.");
    }
    throw new TypeError(
      "The Program batch has no supported Rust workspace projection and cannot be evaluated in TypeScript.",
    );
  }
  const projection = projectProposedState(proposedState, input.currentTime);
  const boundary =
    projection.timeline.events
      .filter((event) => event.kind === "scene-boundary" && event.at !== undefined && event.at <= input.currentTime)
      .at(-1) ?? null;
  const incomingProjection =
    input.nextScene && boundary
      ? projectProposedState(
          projectBaseWorkingState(
            importedWorkingState(input.nextScene, {
              playhead: 0,
              selection: [],
            }),
          ),
          0,
        )
      : null;
  const transitionEntities = projection.canvas.entities.filter(isTransitionOverlay);
  const visibleEntities =
    boundary && incomingProjection
      ? [...incomingProjection.canvas.entities, ...transitionEntities]
      : projection.canvas.entities;
  return {
    boundary,
    // The incoming Scene is a playback preview. Editing still targets the
    // active (outgoing) Scene, so exposing incoming identities as editable
    // would produce a guaranteed target-missing validation failure.
    editableEntities: boundary ? [] : projection.canvas.entities.filter((entity) => !isTransitionOverlay(entity)),
    projection,
    proposedState,
    visibleEntities,
  } as const;
}
