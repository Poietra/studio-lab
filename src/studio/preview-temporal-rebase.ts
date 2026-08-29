import {
  type ApplyStudioBoundEntityEditCompiler,
  type ApplyStudioBoundEntityEditWireCommandV1,
  compileApplyStudioBoundEntityEdit,
  type StudioBoundEntityEditResultV1,
  type StudioBoundEntityProjectionV1,
} from "../engine/scene-authoring";
import { type SceneEntityV1, type SceneIrV1, sceneIrSourceRevisionHash } from "../engine/scene-ir";
import type { Point, ProgramRecord, ProjectedEntity, RuntimeSceneState, WorkingState } from "./model";
import {
  isStudioNativePreviewSceneIdentityV1,
  PRISTINE_WORKING_REVISION,
  type StudioVerifiedPreviewSnapshotV1,
} from "./preview-snapshot-provider";
import { STUDIO_VIEWPORT } from "./studio-viewport-geometry";

export type StudioPreviewTemporalRebaseIssueCode = "source-correlation-invalid" | "target-edit-unsupported";

export type StudioPreviewTemporalRebaseIssue = Readonly<{
  code: StudioPreviewTemporalRebaseIssueCode;
  message: string;
}>;

export type StudioPreviewTemporalRebaseResult =
  | Readonly<{ issue: StudioPreviewTemporalRebaseIssue; kind: "unsupported" }>
  | Readonly<{ kind: "rebased"; result: StudioBoundEntityEditResultV1 }>;

/**
 * Source-bound Runtime Trace evidence for one bounded endpoint edit. Studio may
 * expose only the operations declared by these capabilities; the server still
 * re-derives the source edit and verifies a fresh trace before export.
 */
export type StudioPreviewRuntimeTraceEditCandidate = Readonly<{
  baseCenter: Point;
  /** Runtime endpoint dimensions in Scene units; never an assumed scale=1. */
  baseDimensions: Readonly<{ height: number; width: number }>;
  /** Uniform existing paint alpha, or null when the static subtree mixes alpha values. */
  baseOpacity: number | null;
  bindingId: string;
  duration: number;
  capabilities: StudioPreviewRuntimeTraceEditCapabilities;
  entityProjection: Readonly<{
    baseCenter: Point;
    kind: "source-position-and-lifetime";
    lifetime: Readonly<{ end: number; start: number }>;
  }>;
  phase: "construction" | "settled";
  restrictionMessage: string;
  runtimeEntityId: string;
  sourceAnchor: number;
  studioEntityId: string;
  studioSceneId: string;
  targetSourceName: string;
  targetType: string | null;
}>;

export type StudioPreviewRuntimeTraceEditCapabilities = Readonly<{
  paintOpacity: boolean;
  rotation: boolean;
  uniformScale: boolean;
}>;

const NO_RUNTIME_TRACE_EDIT_CAPABILITIES = {
  paintOpacity: false,
  rotation: false,
  uniformScale: false,
} as const satisfies StudioPreviewRuntimeTraceEditCapabilities;

export function studioPreviewRuntimeTraceEditBaseCenter(
  authority: StudioPreviewRuntimeTraceEditCandidate,
): Point | null {
  const projection = authority.entityProjection;
  return "baseCenter" in projection ? projection.baseCenter : null;
}

export type StudioPreviewRuntimeTraceProgramValidation = "authorized" | "not-applicable" | "rejected";

function unsupported(code: StudioPreviewTemporalRebaseIssueCode, message: string) {
  return { issue: { code, message }, kind: "unsupported" } as const;
}

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function genericRuntimeTraceSnapshotCorrelationIsExact(snapshot: StudioVerifiedPreviewSnapshotV1) {
  const { correlation, snapshot: bundle } = snapshot;
  const source = bundle.scene.source;
  if (isStudioNativePreviewSceneIdentityV1(correlation.context)) return false;
  return (
    source.kind === "imported-manim-runtime-trace" &&
    sceneIrSourceRevisionHash(bundle.scene) === correlation.engineRevisionHash &&
    source.sourceHash === correlation.context.sourceHash &&
    bundle.assets.manifestDigest === correlation.assetsManifestDigest &&
    bundle.scene.sceneId === correlation.sceneId &&
    snapshot.sceneId === correlation.sceneId &&
    bundle.scene.duration === correlation.sceneDuration &&
    snapshot.duration === correlation.sceneDuration &&
    correlation.sceneDuration === correlation.context.sourceDuration &&
    correlation.context.workingRevision === PRISTINE_WORKING_REVISION
  );
}

function genericRuntimeTraceSubtreePaintEvidence(scene: SceneIrV1, rootId: string) {
  const entityById = new Map(scene.entities.map((entity) => [entity.id, entity] as const));
  const childrenByParent = new Map<string, SceneEntityV1[]>();
  for (const entity of scene.entities) {
    if (entity.parentId === null) continue;
    const children = childrenByParent.get(entity.parentId) ?? [];
    children.push(entity);
    childrenByParent.set(entity.parentId, children);
  }
  const entityIds = new Set<string>();
  const queue = [rootId];
  const paintAlphas: number[] = [];
  let vectorPaintCount = 0;
  let surfacesAreVectorPaint = true;
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const entityId = queue[queueIndex]!;
    if (entityIds.has(entityId)) continue;
    entityIds.add(entityId);
    const entity = entityById.get(entityId);
    if (!entity) {
      surfacesAreVectorPaint = false;
      continue;
    }
    queue.push(...(childrenByParent.get(entityId) ?? []).map(({ id }) => id));
    if (entity.geometry.kind === "group") continue;
    if (entity.appearance.kind !== "vector") {
      surfacesAreVectorPaint = false;
      continue;
    }
    const paints = [entity.appearance.fill, entity.appearance.stroke].flatMap((paint) =>
      paint === null ? [] : [paint],
    );
    if (paints.length === 0) {
      surfacesAreVectorPaint = false;
      continue;
    }
    vectorPaintCount += paints.length;
    paintAlphas.push(...paints.map(({ color }) => color.alpha));
  }
  const paintIsDynamic = scene.animationChannels.some(
    (channel) =>
      "entityId" in channel &&
      entityIds.has(channel.entityId) &&
      (channel.kind === "fragment-material-parameter" ||
        channel.kind === "opacity" ||
        channel.kind === "vector-appearance"),
  );
  const opacityEditable = surfacesAreVectorPaint && vectorPaintCount > 0 && !paintIsDynamic;
  const firstAlpha = paintAlphas[0];
  const baseOpacity =
    opacityEditable && firstAlpha !== undefined && paintAlphas.every((alpha) => alpha === firstAlpha)
      ? firstAlpha
      : null;
  return { baseOpacity, entityIds, opacityEditable } as const;
}

/**
 * Projects every pristine Runtime Trace mapping into a bounded edit
 * candidate. Each candidate rechecks every fact it consumes. Updater-conflicted
 * or degenerate mappings mint no candidate, so their roots stay selection-only.
 */
export function studioPreviewRuntimeTraceEditCandidates(
  snapshot: StudioVerifiedPreviewSnapshotV1,
  sourceAnchor: number,
  sourceEvents: RuntimeSceneState["eventTrack"]["events"],
): readonly StudioPreviewRuntimeTraceEditCandidate[] {
  if (!genericRuntimeTraceSnapshotCorrelationIsExact(snapshot)) return [];
  const identity = snapshot.sourceRuntimeIdentity;
  if (!identity || identity.size === 0) return [];
  const camera = snapshot.snapshot.scene.camera.view;
  if (
    !Number.isFinite(camera.frameHeight) ||
    !Number.isFinite(camera.frameWidth) ||
    camera.frameHeight <= 0 ||
    camera.frameWidth <= 0
  ) {
    return [];
  }
  const context = snapshot.correlation.context;
  if (isStudioNativePreviewSceneIdentityV1(context)) return [];
  // The provider enforces one-to-one source/runtime identity; a synthetic map
  // that aliases one runtime root under two names is never edit evidence.
  const mappedEntityIds = [...identity.values()].map(({ entityId }) => entityId);
  if (new Set(mappedEntityIds).size !== mappedEntityIds.length) return [];
  const candidates: StudioPreviewRuntimeTraceEditCandidate[] = [];
  for (const [sourceName, mapping] of identity) {
    const evidence = mapping.runtimeTraceEvidence;
    if (mapping.sourceName !== sourceName || !evidence || evidence.updaterStatus !== "none") continue;
    const root = snapshot.snapshot.scene.entities.find(({ id }) => id === mapping.entityId);
    const lifetime = root?.lifetimes[0];
    if (
      !root ||
      root.parentId !== null ||
      root.geometry.kind !== "group" ||
      root.lifetimes.length !== 1 ||
      !lifetime ||
      !Number.isFinite(lifetime.start) ||
      lifetime.start < 0 ||
      !Number.isFinite(lifetime.end) ||
      lifetime.end <= lifetime.start
    ) {
      continue;
    }
    const { initial, terminal } = evidence.endpoints;
    const finiteEndpoint = (endpoint: typeof initial) =>
      [
        endpoint.center.x,
        endpoint.center.y,
        endpoint.dimensions.height,
        endpoint.dimensions.width,
        endpoint.sampleTime,
      ].every(Number.isFinite) &&
      endpoint.dimensions.height > 0 &&
      endpoint.dimensions.width > 0;
    if (
      !finiteEndpoint(initial) ||
      !finiteEndpoint(terminal) ||
      terminal.frameIndex < initial.frameIndex ||
      terminal.sampleTime < initial.sampleTime
    ) {
      continue;
    }
    // The gesture edits the settled object: `move_to`/`scale` act on the
    // constructed placement, observed by the terminal endpoint. An entrance
    // animation's partial frame-zero box is evidence-gated above but never
    // the manipulation anchor.
    const paintEvidence = genericRuntimeTraceSubtreePaintEvidence(snapshot.snapshot.scene, mapping.entityId);
    const constructionEligible = initial.frameIndex === 0 && initial.sampleTime === 0 && lifetime.start === 0;
    const settledWaits = sourceEvents.filter(
      (event) =>
        event.kind === "wait" &&
        event.operationId === undefined &&
        event.transactionId === undefined &&
        event.interval !== undefined &&
        Number.isFinite(event.interval.start) &&
        Number.isFinite(event.interval.end) &&
        closeEnough(event.interval.end, snapshot.duration) &&
        event.interval.start <= terminal.sampleTime &&
        terminal.sampleTime < event.interval.end &&
        event.interval.start >= lifetime.start &&
        event.interval.start < lifetime.end,
    );
    const settledWait = settledWaits.length === 1 ? settledWaits[0]!.interval! : null;
    const settledSourceAnchor = settledWait?.start ?? null;
    const playheadInsideSettledWait =
      settledWait !== null && sourceAnchor >= settledWait.start && sourceAnchor < settledWait.end;
    const phase = closeEnough(sourceAnchor, 0)
      ? constructionEligible
        ? "construction"
        : null
      : settledSourceAnchor !== null && playheadInsideSettledWait
        ? "settled"
        : null;
    if (phase === null) continue;
    const constructionEdit = phase === "construction";
    candidates.push({
      baseCenter: scenePointToStudioPoint(
        terminal.center,
        { height: camera.frameHeight, width: camera.frameWidth },
        camera.center,
      ),
      baseDimensions: { ...terminal.dimensions },
      baseOpacity: paintEvidence.baseOpacity,
      bindingId: mapping.bindingId,
      capabilities: {
        ...NO_RUNTIME_TRACE_EDIT_CAPABILITIES,
        paintOpacity: constructionEdit && paintEvidence.opacityEditable,
        rotation: constructionEdit,
        uniformScale: true,
      },
      duration: snapshot.duration,
      entityProjection: {
        baseCenter: scenePointToStudioPoint(
          terminal.center,
          { height: camera.frameHeight, width: camera.frameWidth },
          camera.center,
        ),
        kind: "source-position-and-lifetime",
        lifetime: { end: lifetime.end, start: lifetime.start },
      },
      phase,
      restrictionMessage: constructionEdit
        ? "Use the dedicated Rotate and Opacity controls for those edits; these Inspector fields support position and uniform scale only."
        : "The settled Runtime Trace target supports position and positive uniform scale at its verified terminal frame.",
      runtimeEntityId: mapping.entityId,
      sourceAnchor: constructionEdit ? 0 : settledSourceAnchor!,
      studioEntityId: `source:${context.sourcePath}#${context.sceneName}:${sourceName}`,
      studioSceneId: `${context.sourcePath}#${context.sceneName}`,
      targetSourceName: sourceName,
      targetType: null,
    });
  }
  return candidates;
}

function studioRuntimeTraceEditTargetMatches(
  entity: RuntimeSceneState["objectGraph"]["entities"][string] | ProjectedEntity | undefined,
  authority: StudioPreviewRuntimeTraceEditCandidate,
) {
  return (
    entity?.id === authority.studioEntityId &&
    (authority.targetType === null || entity.type === authority.targetType) &&
    !entity.provisional &&
    entity.transactionId === undefined &&
    entity.sourceIdentity.kind === "known" &&
    entity.sourceIdentity.value === authority.targetSourceName
  );
}

/** Projects only the exact runtime-backed edit target into Studio's interaction UI. */
export function projectStudioPreviewRuntimeTraceEntityPresence(
  entities: readonly ProjectedEntity[],
  authority: StudioPreviewRuntimeTraceEditCandidate | null,
  interactionGeometry: ReadonlyMap<string, unknown> | null,
  sampleTime: number,
  authorizedProjection: StudioBoundEntityProjectionV1 | null = null,
) {
  if (!authority || !interactionGeometry?.has(authority.runtimeEntityId)) {
    return entities;
  }
  const projection = authority.entityProjection;
  const target = entities.find(({ id }) => id === authority.studioEntityId);
  if (!target || !studioRuntimeTraceEditTargetMatches(target, authority)) return entities;
  const mutation =
    authorizedProjection?.studioEntityId === target.id && sampleTime >= authorizedProjection.interval.start - 0.0005
      ? authorizedProjection
      : null;
  const position = mutation?.kind === "position" ? mutation.value : projection.baseCenter;
  const scale = mutation?.kind === "uniform-scale" ? mutation.to : 1;
  // One is a normalized basis for the candidate's relative scale factor, not
  // a claim about the absolute scale computed by Python source.
  return entities.map((entity) =>
    entity.id === target.id
      ? {
          ...entity,
          geometry: {
            ...entity.geometry,
            position: { kind: "known" as const, value: position },
            ...(authority.capabilities.uniformScale ? { scale: { kind: "known" as const, value: scale } } : {}),
          },
          position,
          present: true,
          ...(authority.capabilities.uniformScale ? { scale } : {}),
        }
      : entity,
  );
}

/**
 * Supplies runtime-proven lifetime evidence only to validation of the exact
 * endpoint edit. The imported base remains untouched.
 */
export function projectStudioPreviewRuntimeTraceValidationScene(
  scene: RuntimeSceneState,
  authority: StudioPreviewRuntimeTraceEditCandidate | null,
) {
  if (!authority || scene.duration !== authority.duration || scene.sceneId !== authority.studioSceneId) return scene;
  const projection = authority.entityProjection;
  const target = scene.objectGraph.entities[authority.studioEntityId];
  if (!studioRuntimeTraceEditTargetMatches(target, authority) || !target.geometry) return scene;
  // The server applies and verifies only the relative factor. Supply its
  // normalized authoring basis inside this candidate-scoped validation copy.
  const projectedTarget: RuntimeSceneState["objectGraph"]["entities"][string] = {
    ...target,
    geometry: {
      ...target.geometry,
      position: { kind: "known", value: projection.baseCenter },
      ...(authority.capabilities.uniformScale ? { scale: { kind: "known" as const, value: 1 } } : {}),
    },
    lifetime: [projection.lifetime],
  };
  const propertyChannels = Object.fromEntries(
    Object.entries(scene.propertyChannels).map(([channelId, channel]) =>
      channel.entityId === target.id && channel.key === "position"
        ? [
            channelId,
            {
              ...channel,
              samples: channel.samples.map((sample) =>
                sample.operationId
                  ? sample
                  : {
                      ...sample,
                      knowledge: { kind: "known" as const, value: projection.baseCenter },
                      value: projection.baseCenter,
                    },
              ),
            },
          ]
        : [channelId, channel],
    ),
  );
  return {
    ...scene,
    objectGraph: {
      ...scene.objectGraph,
      entities: { ...scene.objectGraph.entities, [target.id]: projectedTarget },
    },
    propertyChannels,
  };
}

export function studioPreviewRuntimeTraceEditTargetIsPresent(
  scene: RuntimeSceneState,
  entityId: string,
  sourceTime: number,
  authority: StudioPreviewRuntimeTraceEditCandidate | null,
) {
  const projected =
    authority && closeEnough(sourceTime, authority.sourceAnchor)
      ? projectStudioPreviewRuntimeTraceValidationScene(scene, authority)
      : scene;
  return (
    projected.objectGraph.entities[entityId]?.lifetime.some(
      (interval) => sourceTime >= interval.start - 0.0005 && sourceTime < interval.end,
    ) ?? false
  );
}

/** Returns the exact authoring anchor minted by Runtime Trace endpoint evidence. */
export function studioPreviewRuntimeTraceEditAnchor(
  snapshot: StudioVerifiedPreviewSnapshotV1,
  sourceAnchor: number,
  sourceEvents: RuntimeSceneState["eventTrack"]["events"],
) {
  const candidates = studioPreviewRuntimeTraceEditCandidates(snapshot, sourceAnchor, sourceEvents);
  const candidateSourceAnchors = new Set(candidates.map((candidate) => candidate.sourceAnchor));
  return candidateSourceAnchors.size === 1 ? candidates[0]!.sourceAnchor : null;
}

function scenePointToStudioPoint(
  point: Point,
  frame: Readonly<{ height: number; width: number }>,
  cameraCenter: Point,
) {
  return {
    x: ((point.x - cameraCenter.x) / frame.width + 0.5) * STUDIO_VIEWPORT.width,
    y: (0.5 - (point.y - cameraCenter.y) / frame.height) * STUDIO_VIEWPORT.height,
  };
}

function boundEntityOperation(
  operation: ProgramRecord["program"]["operations"][number],
): ApplyStudioBoundEntityEditWireCommandV1["programs"][number]["operations"][number] {
  const common = {
    dependsOn: operation.dependsOn,
    id: operation.id,
    interval: operation.interval,
    origin: operation.provenance.origin,
  };
  if (operation.kind === "SetProperty" && operation.key === "position") {
    return { ...common, entityId: operation.entityId, kind: "move", position: operation.value as Point };
  }
  if (operation.kind === "SetProperty" && operation.key === "appearance") {
    return {
      ...common,
      alpha: typeof operation.value === "number" ? operation.value : null,
      entityId: operation.entityId,
      kind: "opacity",
    };
  }
  if (operation.kind === "AnimateProperty" && operation.key === "rotation") {
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
  return { ...common, entityId: "entityId" in operation ? operation.entityId : null, kind: "unsupported" };
}

function boundEntityAnchorSource(
  record: ProgramRecord,
): ApplyStudioBoundEntityEditWireCommandV1["programs"][number]["anchorSource"] {
  const source = record.program.anchor.source;
  if (source.kind === "absolute") return { kind: "absolute", seconds: source.seconds };
  if (source.kind === "playhead") return { kind: "playhead", referenceSeconds: source.referenceSeconds };
  return { kind: "unsupported" };
}

/**
 * Passes complete normalized Programs and integration-verified endpoint facts
 * to the canonical core. This adapter owns source correlation only; Rust owns
 * admission, binding, coordinate conversion, provenance, and mutation.
 */
export async function compileStudioPreviewRuntimeTraceEdit(
  input: Readonly<{
    boundEntityEditCompiler?: ApplyStudioBoundEntityEditCompiler;
    frame: Readonly<{ height: number; width: number }>;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    sourceRevisionHash: string;
    workingState: WorkingState;
  }>,
): Promise<StudioPreviewTemporalRebaseResult> {
  const sourcePrograms = [...input.workingState.appliedEdits, ...input.workingState.stagedEdits];
  const sourceAnchor = sourcePrograms[0]?.program.anchor.resolvedSeconds;
  const candidates =
    sourceAnchor === undefined
      ? []
      : studioPreviewRuntimeTraceEditCandidates(
          input.snapshot,
          sourceAnchor,
          input.workingState.runtimeSceneState.eventTrack.events,
        );
  if (candidates.length === 0) {
    return unsupported("source-correlation-invalid", "Runtime Trace edit evidence is unavailable at this time.");
  }
  const scene = input.snapshot.snapshot.scene;
  const context = input.snapshot.correlation.context;
  if (isStudioNativePreviewSceneIdentityV1(context)) {
    return unsupported("source-correlation-invalid", "A Studio-native Scene has no Runtime Trace source binding.");
  }
  const base = input.workingState;
  const correlation = candidates[0]!;
  if (
    input.frame.width !== scene.camera.view.frameWidth ||
    input.frame.height !== scene.camera.view.frameHeight ||
    base.runtimeSceneState.sceneId !== correlation.studioSceneId ||
    base.runtimeSceneState.duration !== correlation.duration ||
    base.editorContext.activeSceneId !== correlation.studioSceneId ||
    base.sourceSnapshot?.sourceId !== context.sourcePath ||
    base.sourceSnapshot?.hash !== `sha256:${context.sourceHash}`
  ) {
    return unsupported(
      "source-correlation-invalid",
      "Studio state is not correlated with the Runtime Trace edit evidence.",
    );
  }
  try {
    const rebased = await (input.boundEntityEditCompiler ?? compileApplyStudioBoundEntityEdit)(
      input.snapshot.snapshot,
      {
        candidates: candidates.map((candidate) => ({
          baseCenter: candidate.baseCenter,
          baseOpacity: candidate.baseOpacity,
          capabilities: candidate.capabilities,
          evidenceId: candidate.bindingId,
          phase: candidate.phase,
          sceneEntityId: candidate.runtimeEntityId,
          sourceAnchor: candidate.sourceAnchor,
          studioEntityId: candidate.studioEntityId,
        })),
        expectedBaseRevision: sceneIrSourceRevisionHash(scene),
        frame: input.frame,
        nextRevision: input.sourceRevisionHash,
        programs: sourcePrograms.map((record) => ({
          anchorCapturedPlayhead: record.program.anchor.capturedPlayhead,
          anchorResolvedSeconds: record.program.anchor.resolvedSeconds,
          anchorSource: boundEntityAnchorSource(record),
          intentCount: record.program.intentCount,
          loweringSupported: record.program.loweringStatus === "supported",
          operations: record.program.operations.map(boundEntityOperation),
          origin: record.program.provenance.origin,
          requestedExecution: record.program.requestedExecution,
          scheduleEdgeCount: record.program.schedule.edges.length,
          scheduleMode: record.program.schedule.mode,
          scheduleOrder: record.program.schedule.order,
          transactionId: record.program.transactionId,
        })),
        schema: "poietra.apply-studio-bound-entity-edit",
        version: 1,
        viewport: STUDIO_VIEWPORT,
      },
    );
    return { kind: "rebased", result: rebased };
  } catch (error) {
    return unsupported(
      "target-edit-unsupported",
      `Rust core rejected the source-bound endpoint edit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
