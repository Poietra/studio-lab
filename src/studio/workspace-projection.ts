import type {
  StudioMathTexTransformProjectionV1,
  StudioMotionProjectionV1,
  StudioPersistentRemoveProjectionV1,
  StudioProjectedMotionV1,
  StudioStaticRootMutationV1,
  StudioStaticRootProjectionV1,
  StudioTimelineProjectionV1,
} from "../engine/scene-authoring";
import { canonicalEditableContent } from "./editable-content";
import { evaluateWorkingState, insertSceneTime, projectProposedState } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene } from "./imported-workspace";
import {
  type EntityContent,
  type ProgramBatchAuthority,
  type ProgramRecord,
  type ProjectedEntity,
  type PropertyChannel,
  type PropertyChannelSample,
  type ProposedState,
  type RuntimeEntity,
  STUDIO_STATE_VERSION,
  type WorkingState,
} from "./model";
import {
  type CanonicalEditOperation,
  type CanonicalEditProgram,
  isExactStaticRootProjectionProgramBatch,
  isSceneDurationOperation,
} from "./operations";
import { isPointValue, normalizeContentSamples, samplePropertyValue } from "./property-sampling";
import { isExactStudioMathTexTransformProgramBatch, studioMotionProjectionBatchKind } from "./scene-authoring-wire";
import {
  correlateTimelineProgramBatch,
  isSceneDurationProgramBatch,
  projectLegacyTimelineProposedState,
} from "./timeline-projection";

export function isTransitionOverlay(entity: Pick<ProjectedEntity, "type">) {
  return entity.type.startsWith("TransitionOverlay:");
}

export function selectStudioWorkspaceProgramAuthority(
  records: readonly ProgramRecord[],
  previewRecords: readonly ProgramRecord[],
  authority: ProgramBatchAuthority | null,
) {
  if (records.length === 0) return null;
  if (isSceneDurationProgramBatch(records.map(({ program }) => program))) return null;
  if (!authority || records.length !== previewRecords.length) return undefined;
  return records.every((record, index) => record === previewRecords[index]) ? authority : undefined;
}

export function selectPersistentRemoveProjection(
  programs: readonly CanonicalEditProgram[],
  projection: StudioPersistentRemoveProjectionV1 | null,
): StudioPersistentRemoveProjectionV1 | null {
  const expected = programs.flatMap((program) =>
    program.operations.flatMap((operation) =>
      operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent
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
  operation: CanonicalEditOperation;
  program: CanonicalEditProgram;
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

function isFiniteProjectionPoint(point: Readonly<{ x: number; y: number }>) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

type CorrelatedProjectedMotion = Readonly<{
  motion: StudioProjectedMotionV1;
  operation: Extract<CanonicalEditOperation, { kind: "CreateMotion" }>;
  program: CanonicalEditProgram;
}>;

function motionProjectionKey(operationId: string, targetEntityId: string) {
  return `${operationId}\u0000${targetEntityId}`;
}

function correlateMotionProjection(
  baseDuration: number,
  programs: readonly CanonicalEditProgram[],
  projection: StudioMotionProjectionV1 | null,
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
    insertionsByTransactionId.size !== projection.insertions.length ||
    projection.insertions.some(
      ({ at, duration, transactionId }) =>
        !transactionIds.includes(transactionId) || !Number.isFinite(at) || !Number.isFinite(duration) || duration <= 0,
    )
  ) {
    throw new TypeError("The Rust motion projection does not contain one unique insertion per Program.");
  }
  if (!Number.isFinite(projection.projectedDuration) || projection.projectedDuration < baseDuration) {
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
      motion.easing !== operation.easing ||
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
  programs: readonly CanonicalEditProgram[],
  projection: StudioMotionProjectionV1 | null,
): StudioMotionProjectionV1 | null {
  const correlated = correlateMotionProjection(baseDuration, programs, projection);
  if (!correlated) return null;
  if (!projection) throw new TypeError("The correlated Rust motion projection is missing.");
  return { ...projection, motions: correlated.map(({ motion }) => motion) };
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
  operation: Extract<CanonicalEditOperation, { kind: "TransformContent" }>;
  program: CanonicalEditProgram;
  replacement: StudioMathTexTransformProjectionV1["replacements"][number];
}>;

type CorrelatedMathTexTransformMotion = Readonly<{
  motion: StudioMathTexTransformProjectionV1["motions"][number];
  operation: Extract<CanonicalEditOperation, { kind: "CreateMotion" }>;
  program: CanonicalEditProgram;
}>;

type CorrelatedMathTexTransformProjection = Readonly<{
  motions: readonly CorrelatedMathTexTransformMotion[];
  replacements: readonly CorrelatedMathTexTransformReplacement[];
}>;

function correlateMathTexTransformProjection(
  baseDuration: number,
  programs: readonly CanonicalEditProgram[],
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
      operation: Extract<CanonicalEditOperation, { kind: "TransformContent" }>;
      program: CanonicalEditProgram;
    }> => entry.operation.kind === "TransformContent",
  );
  const motionOperations = operations.filter(
    (
      entry,
    ): entry is Readonly<{
      operation: Extract<CanonicalEditOperation, { kind: "CreateMotion" }>;
      program: CanonicalEditProgram;
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
  programs: readonly CanonicalEditProgram[],
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

function mathTexContentMutationMatchesOperation(
  mutation: StudioStaticRootMutationV1,
  operation: CanonicalEditOperation,
) {
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
  programs: readonly CanonicalEditProgram[],
  projection: StudioStaticRootProjectionV1 | null,
): readonly CorrelatedStaticRootMutation[] | null {
  if (!isExactStaticRootProjectionProgramBatch(programs) && studioMotionProjectionBatchKind(programs) !== "static-root")
    return null;
  if (!projection) {
    throw new TypeError("A Rust static-root projection is required to project static imported-root Programs.");
  }
  const operations = programs.flatMap((program) =>
    program.operations.flatMap((operation) =>
      operation.kind === "CreateMotion" ? [] : [{ operation, program } as const],
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
  programs: readonly CanonicalEditProgram[],
  projection: StudioStaticRootProjectionV1 | null,
): StudioStaticRootProjectionV1 | null {
  if (!isExactStaticRootProjectionProgramBatch(programs) && studioMotionProjectionBatchKind(programs) !== "static-root")
    return null;
  const correlated = correlateStaticRootProjection(programs, projection);
  return correlated ? { mutations: correlated.map(({ mutation }) => mutation) } : null;
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

type MotionProjectionDraft = {
  entities: Record<string, RuntimeEntity>;
  events: WorkingState["runtimeSceneState"]["eventTrack"]["events"][number][];
  propertyChannels: Record<string, PropertyChannel>;
  provenance: WorkingState["runtimeSceneState"]["provenanceGraph"]["records"][number][];
};

function appendCorrelatedMotions(draft: MotionProjectionDraft, correlated: readonly CorrelatedProjectedMotion[]) {
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
    const positionChannel = draft.propertyChannels[`${motion.targetEntityId}/position`];
    const sampledFrom = positionChannel
      ? samplePropertyValue(positionChannel.samples, motion.interval.start)
      : target.geometry?.position.kind === "known"
        ? target.geometry.position.value
        : undefined;
    if (
      !isPointValue(sampledFrom) ||
      !sameProjectionNumber(sampledFrom.x, motion.from.x) ||
      !sameProjectionNumber(sampledFrom.y, motion.from.y)
    ) {
      throw new TypeError(`Motion ${motion.operationId} has a stale projected start position.`);
    }
    const provenanceId = `${motion.operationId}/provenance`;
    draft.provenance.push({
      evidence: [...program.anchor.evidence, ...operation.provenance.evidence],
      id: provenanceId,
      operationId: motion.operationId,
      origin: operation.provenance.origin,
      transactionId: program.transactionId,
    });
    draft.events.push({
      id: `${motion.operationId}/event`,
      interval: motion.interval,
      kind: "operation",
      label: operation.kind,
      operationId: motion.operationId,
      transactionId: program.transactionId,
    });
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

function projectStaticRootWorkingState(
  workingState: WorkingState,
  projection: StudioStaticRootProjectionV1,
  motionProjection: StudioMotionProjectionV1 | null = null,
): ProposedState {
  const records = [...workingState.appliedPrograms, ...workingState.stagedPrograms];
  const programs = records.map(({ program }) => program);
  const correlated = correlateStaticRootProjection(programs, projection);
  if (!correlated) throw new TypeError("Only an exact static-root Program batch can use this projection.");
  const draft = {
    constraints: [...workingState.runtimeSceneState.constraintGraph.constraints],
    duration: workingState.runtimeSceneState.duration,
    entities: Object.fromEntries(
      Object.entries(workingState.runtimeSceneState.objectGraph.entities).map(([id, entity]) => [
        id,
        { ...entity, lifetime: entity.lifetime.map((interval) => ({ ...interval })) },
      ]),
    ),
    events: [...workingState.runtimeSceneState.eventTrack.events],
    lineage: [...workingState.runtimeSceneState.objectGraph.lineage],
    propertyChannels: Object.fromEntries(
      Object.entries(workingState.runtimeSceneState.propertyChannels).map(([id, channel]) => [
        id,
        { ...channel, samples: [...channel.samples] },
      ]),
    ) as Record<string, PropertyChannel>,
    provenance: [...workingState.runtimeSceneState.provenanceGraph.records],
  };
  for (const insertion of motionProjection?.insertions ?? []) {
    insertSceneTime(draft, insertion.at, insertion.duration);
  }
  if (motionProjection && !sameProjectionNumber(draft.duration, motionProjection.projectedDuration)) {
    throw new TypeError("The Rust static-root motion projection returned a stale projected duration.");
  }
  correlated.forEach(({ mutation, operation, program }) => {
    if (!draft.entities[mutation.entityId]) {
      throw new TypeError(`Rust static-root projection target ${mutation.entityId} is not in the imported Scene.`);
    }
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
      interval: mutation.interval,
      kind: "operation",
      label: operation.kind,
      operationId: operation.id,
      transactionId: program.transactionId,
    });
    if (mutation.kind === "position") {
      appendProjectedSample(draft.propertyChannels, mutation.entityId, "position", {
        interval: mutation.interval,
        kind: "exact",
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.value,
      });
    } else if (mutation.kind === "uniform-scale") {
      appendProjectedSample(draft.propertyChannels, mutation.entityId, "scale", {
        easing: "smooth",
        from: mutation.from,
        interval: mutation.interval,
        kind: "animated",
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.to,
      });
    } else if (mutation.kind === "resize") {
      const kind = mutation.interval.end > mutation.interval.start ? "animated" : "exact";
      appendProjectedSample(draft.propertyChannels, mutation.entityId, "dimensions", {
        from: mutation.fromDimensions,
        interval: mutation.interval,
        kind,
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.toDimensions,
      });
      appendProjectedSample(draft.propertyChannels, mutation.entityId, "position", {
        from: mutation.fromPosition,
        interval: mutation.interval,
        kind,
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.toPosition,
      });
    } else {
      appendProjectedSample(draft.propertyChannels, mutation.entityId, "content", {
        interval: mutation.interval,
        kind: "exact",
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.content,
      });
    }
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

function projectMathTexTransformWorkingState(
  workingState: WorkingState,
  projection: StudioMathTexTransformProjectionV1,
): ProposedState {
  const records = [...workingState.appliedPrograms, ...workingState.stagedPrograms];
  const programs = records.map(({ program }) => program);
  const correlated = correlateMathTexTransformProjection(workingState.runtimeSceneState.duration, programs, projection);
  if (!correlated) throw new TypeError("Only an exact TransformContent Program batch can use this projection.");
  const draft = {
    constraints: [...workingState.runtimeSceneState.constraintGraph.constraints],
    duration: workingState.runtimeSceneState.duration,
    entities: Object.fromEntries(
      Object.entries(workingState.runtimeSceneState.objectGraph.entities).map(([id, entity]) => [
        id,
        { ...entity, lifetime: entity.lifetime.map((interval) => ({ ...interval })) },
      ]),
    ),
    events: [...workingState.runtimeSceneState.eventTrack.events],
    lineage: [...workingState.runtimeSceneState.objectGraph.lineage],
    propertyChannels: Object.fromEntries(
      Object.entries(workingState.runtimeSceneState.propertyChannels).map(([id, channel]) => [
        id,
        { ...channel, samples: [...channel.samples] },
      ]),
    ) as Record<string, PropertyChannel>,
    provenance: [...workingState.runtimeSceneState.provenanceGraph.records],
  };
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

  const appliedTransactionIds = new Set(workingState.appliedPrograms.map(({ program }) => program.transactionId));
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
    draft.provenance.push({
      evidence: [...program.anchor.evidence, ...operation.provenance.evidence],
      id: provenanceId,
      operationId: replacement.operationId,
      origin: operation.provenance.origin,
      transactionId: program.transactionId,
    });
    draft.events.push({
      id: `${replacement.operationId}/event`,
      interval: replacement.interval,
      kind: "operation",
      label: operation.kind,
      operationId: replacement.operationId,
      transactionId: program.transactionId,
    });
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

  return {
    base: workingState,
    evaluatedScene: {
      ...workingState.runtimeSceneState,
      constraintGraph: { constraints: draft.constraints },
      duration: projection.projectedDuration,
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

function projectMotionWorkingState(
  workingState: WorkingState,
  base: ProposedState,
  projection: StudioMotionProjectionV1,
): ProposedState {
  const records = [...workingState.appliedPrograms, ...workingState.stagedPrograms];
  const correlated = correlateMotionProjection(
    workingState.runtimeSceneState.duration,
    records.map(({ program }) => program),
    projection,
  );
  if (!correlated) throw new TypeError("Only a motion-bearing Program batch can use the Rust motion projection.");
  if (!sameProjectionNumber(base.evaluatedScene.duration, projection.projectedDuration)) {
    throw new TypeError("The Rust motion projection does not match the projected Studio duration.");
  }
  const draft: MotionProjectionDraft = {
    entities: Object.fromEntries(
      Object.entries(base.evaluatedScene.objectGraph.entities).map(([id, entity]) => [
        id,
        { ...entity, lifetime: entity.lifetime.map((interval) => ({ ...interval })) },
      ]),
    ),
    events: [...base.evaluatedScene.eventTrack.events],
    propertyChannels: Object.fromEntries(
      Object.entries(base.evaluatedScene.propertyChannels).map(([id, channel]) => [
        id,
        { ...channel, samples: [...channel.samples] },
      ]),
    ),
    provenance: [...base.evaluatedScene.provenanceGraph.records],
  };
  appendCorrelatedMotions(draft, correlated);
  return {
    ...base,
    evaluatedScene: {
      ...base.evaluatedScene,
      eventTrack: {
        events: draft.events.sort(
          (left, right) => (left.at ?? left.interval?.start ?? 0) - (right.at ?? right.interval?.start ?? 0),
        ),
      },
      objectGraph: { ...base.evaluatedScene.objectGraph, entities: draft.entities },
      propertyChannels: draft.propertyChannels,
      provenanceGraph: { records: draft.provenance },
    },
  };
}

export function projectStudioWorkspace(
  input: Readonly<{
    activeScene: ManimWorkspaceScene;
    appliedPrograms: readonly ProgramRecord[];
    currentTime: number;
    draftProgram: ProgramRecord | null;
    nextScene: ManimWorkspaceScene | null;
    mathTexTransformProjection?: StudioMathTexTransformProjectionV1 | null;
    motionProjection?: StudioMotionProjectionV1 | null;
    persistentRemoveProjection?: StudioPersistentRemoveProjectionV1 | null;
    programAuthority?: ProgramBatchAuthority | null;
    selectedObjectIds: readonly string[];
    staticRootProjection?: StudioStaticRootProjectionV1 | null;
    timelineProjection?: StudioTimelineProjectionV1 | null;
  }>,
) {
  const workingState = importedWorkingState(input.activeScene, {
    appliedPrograms: input.appliedPrograms,
    playhead: input.currentTime,
    selection: input.selectedObjectIds,
    stagedPrograms: input.draftProgram ? [input.draftProgram] : [],
  });
  const programs = [...workingState.appliedPrograms, ...workingState.stagedPrograms].map((record) => record.program);
  const hasMotion = programs.some((program) => program.operations.some(({ kind }) => kind === "CreateMotion"));
  const hasMathTexTransform = programs.some((program) =>
    program.operations.some(({ kind }) => kind === "TransformContent"),
  );
  const correlatedMotions =
    hasMotion && !hasMathTexTransform
      ? correlateMotionProjection(workingState.runtimeSceneState.duration, programs, input.motionProjection ?? null)
      : null;
  const containsSceneDurationOperation = programs.some((program) => program.operations.some(isSceneDurationOperation));
  const persistentRemoveProjection = selectPersistentRemoveProjection(
    programs,
    input.persistentRemoveProjection ?? null,
  );
  let proposedState: ProposedState;
  if (containsSceneDurationOperation) {
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
  } else if (
    input.programAuthority === "rust-authorized-batch" &&
    programs.some((program) => program.operations.some(({ kind }) => kind === "TransformContent"))
  ) {
    if (!isExactStudioMathTexTransformProgramBatch(programs)) {
      throw new TypeError("TransformContent requires one closed Rust MathTex transform batch.");
    }
    if (!input.mathTexTransformProjection) {
      throw new TypeError("A Rust MathTex transform projection is required to project TransformContent Programs.");
    }
    proposedState = projectMathTexTransformWorkingState(workingState, input.mathTexTransformProjection);
  } else if (
    input.programAuthority === "static-imported-root" &&
    (isExactStaticRootProjectionProgramBatch(programs) || studioMotionProjectionBatchKind(programs) === "static-root")
  ) {
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
    );
  } else {
    proposedState = evaluateWorkingState(
      workingState,
      persistentRemoveProjection,
      input.programAuthority ?? null,
      correlatedMotions ? (input.motionProjection ?? null) : null,
    );
  }
  if (hasMotion && !hasMathTexTransform && studioMotionProjectionBatchKind(programs) !== "static-root") {
    if (!input.motionProjection) {
      throw new TypeError("A Rust motion projection is required to project CreateMotion Programs.");
    }
    proposedState = projectMotionWorkingState(workingState, proposedState, input.motionProjection);
  }
  const projection = projectProposedState(proposedState, input.currentTime);
  const boundary =
    projection.timeline.events
      .filter((event) => event.kind === "scene-boundary" && event.at !== undefined && event.at <= input.currentTime)
      .at(-1) ?? null;
  const incomingProjection =
    input.nextScene && boundary
      ? projectProposedState(
          evaluateWorkingState(
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
