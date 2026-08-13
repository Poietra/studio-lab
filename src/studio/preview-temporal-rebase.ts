import {
  compileRotateSceneEntity,
  compileSetSubtreeVectorPaintAlpha,
  compileTransformSceneEntity,
  compileTransformSceneEntityAtTime,
  type RotateSceneEntityCompiler,
  type SetSubtreeVectorPaintAlphaCompiler,
  type TransformSceneEntityAtTimeCompiler,
  type TransformSceneEntityCompiler,
} from "../engine/scene-authoring";
import { type SceneEntityV1, type SceneIrV1, sceneIrSourceRevisionHash } from "../engine/scene-ir";
import type { Point, ProgramRecord, ProjectedEntity, ProposedState, RuntimeSceneState } from "./model";
import { PRISTINE_WORKING_REVISION, type StudioVerifiedPreviewSnapshotV1 } from "./preview-snapshot-provider";
import { STUDIO_VIEWPORT } from "./studio-viewport-geometry";

export type StudioPreviewTemporalRebaseIssueCode =
  | "camera-edit-unsupported"
  | "channel-timing-edit-unsupported"
  | "conflicting-edit-unsupported"
  | "geometry-edit-unsupported"
  | "identity-unverified"
  | "mid-animation-edit-unsupported"
  | "motion-path-edit-unsupported"
  | "profile-unsupported"
  | "source-correlation-invalid"
  | "target-edit-unsupported";

export type StudioPreviewTemporalRebaseIssue = Readonly<{
  code: StudioPreviewTemporalRebaseIssueCode;
  message: string;
}>;

export type StudioPreviewTemporalRebaseResult =
  | Readonly<{ issue: StudioPreviewTemporalRebaseIssue; kind: "unsupported" }>
  | Readonly<{ kind: "rebased"; scene: SceneIrV1 }>;

type AuthorizedImportedAnimationEdit = Readonly<{
  operationIds: readonly string[];
  position: Point | null;
  runtimeEntityId: string;
  scaleFactor: number | null;
}>;

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

export type StudioPreviewRuntimeTraceEdit =
  | Readonly<{ kind: "move"; position: Point }>
  | Readonly<{ kind: "opacity"; opacity: number }>
  | Readonly<{ kind: "resize"; scaleFactor: number }>
  | Readonly<{ angleRadians: number; kind: "rotation" }>;

export type StudioPreviewRuntimeTraceEditProgramSet =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      candidate: StudioPreviewRuntimeTraceEditCandidate;
      edit: StudioPreviewRuntimeTraceEdit;
      kind: "authorized";
    }>
  | Readonly<{ kind: "unauthorized" }>;

export type StudioPreviewRuntimeTraceProgramValidation = "authorized" | "not-applicable" | "rejected";

function unsupported(code: StudioPreviewTemporalRebaseIssueCode, message: string) {
  return { issue: { code, message }, kind: "unsupported" } as const;
}

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function isFinitePoint(value: unknown): value is Point {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  );
}

function genericRuntimeTraceSnapshotCorrelationIsExactV3(snapshot: StudioVerifiedPreviewSnapshotV1) {
  const { correlation, snapshot: bundle } = snapshot;
  const source = bundle.scene.source;
  return (
    source.kind === "imported-manim-runtime-trace" &&
    source.traceVersion === 3 &&
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
      (channel.kind === "opacity" || channel.kind === "vector-appearance"),
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
  if (!genericRuntimeTraceSnapshotCorrelationIsExactV3(snapshot)) return [];
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

function runtimeTraceEditProgram(
  record: ProgramRecord,
  candidate: StudioPreviewRuntimeTraceEditCandidate,
): StudioPreviewRuntimeTraceEdit | null {
  const program = record.program;
  const operation = program.operations[0];
  if (
    record.validation.status !== "valid" ||
    program.operations.length !== 1 ||
    !operation ||
    program.intentCount !== 1 ||
    program.loweringStatus !== "supported" ||
    program.provenance.origin !== "direct-manipulation" ||
    program.requestedExecution !== "parallel" ||
    program.schedule.mode !== "parallel" ||
    program.schedule.edges.length !== 0 ||
    program.schedule.order.length !== 1 ||
    program.schedule.order[0] !== operation.id ||
    !closeEnough(program.anchor.capturedPlayhead, candidate.sourceAnchor) ||
    !closeEnough(program.anchor.resolvedSeconds, candidate.sourceAnchor) ||
    !(
      (program.anchor.source.kind === "absolute" &&
        closeEnough(program.anchor.source.seconds, candidate.sourceAnchor)) ||
      (program.anchor.source.kind === "playhead" &&
        closeEnough(program.anchor.source.referenceSeconds, candidate.sourceAnchor))
    ) ||
    !("entityId" in operation) ||
    operation.entityId !== candidate.studioEntityId ||
    operation.dependsOn.length !== 0 ||
    !closeEnough(operation.interval.start, candidate.sourceAnchor) ||
    !closeEnough(operation.interval.end, candidate.sourceAnchor) ||
    operation.provenance.origin !== "direct-manipulation"
  ) {
    return null;
  }
  if (operation.kind === "SetProperty" && operation.key === "position" && isFinitePoint(operation.value)) {
    return { kind: "move", position: { x: operation.value.x, y: operation.value.y } };
  }
  if (
    operation.kind === "SetProperty" &&
    operation.key === "appearance" &&
    candidate.capabilities.paintOpacity &&
    typeof operation.value === "number" &&
    Number.isFinite(operation.value) &&
    operation.value >= 0 &&
    operation.value <= 1 &&
    (candidate.baseOpacity === null || !closeEnough(operation.value, candidate.baseOpacity))
  ) {
    return { kind: "opacity", opacity: operation.value };
  }
  if (
    operation.kind === "AnimateProperty" &&
    operation.key === "rotation" &&
    candidate.capabilities.rotation &&
    operation.control === undefined &&
    typeof operation.from === "number" &&
    typeof operation.to === "number" &&
    typeof operation.relativeDelta === "number" &&
    Number.isFinite(operation.from) &&
    Number.isFinite(operation.to) &&
    Number.isFinite(operation.relativeDelta) &&
    Math.abs(operation.to - operation.from - operation.relativeDelta) < 0.000001 &&
    Math.abs(Math.atan2(Math.sin(operation.relativeDelta), Math.cos(operation.relativeDelta))) > 1e-12
  ) {
    return { angleRadians: operation.relativeDelta, kind: "rotation" };
  }
  if (
    operation.kind === "AnimateProperty" &&
    operation.key === "scale" &&
    operation.control === undefined &&
    typeof operation.from === "number" &&
    typeof operation.to === "number" &&
    typeof operation.relativeFactor === "number" &&
    Number.isFinite(operation.from) &&
    Number.isFinite(operation.to) &&
    Number.isFinite(operation.relativeFactor) &&
    operation.from > 0 &&
    operation.to > 0 &&
    operation.relativeFactor > 0 &&
    // The server lowerer canonicalizes to twelve significant digits and
    // rejects the identity factor; mirror it so an authorized set never
    // carries a request the mutation authority is guaranteed to refuse.
    Number(operation.relativeFactor.toPrecision(12)) !== 1 &&
    closeEnough(operation.to / operation.from, operation.relativeFactor)
  ) {
    return { kind: "resize", scaleFactor: operation.relativeFactor };
  }
  return null;
}

/**
 * Browser-side capability gate for the one request #523/#510 may send to the
 * server. The one staged Program must target exactly one minted candidate;
 * it does not verify Python source authority; the fresh-source V3 lowerer
 * owns that decision and must reject independently.
 */
export function studioPreviewRuntimeTraceEditProgramSet(
  records: readonly ProgramRecord[],
  candidates: readonly StudioPreviewRuntimeTraceEditCandidate[],
): StudioPreviewRuntimeTraceEditProgramSet {
  if (records.length === 0) return { kind: "none" };
  if (records.length !== 1 || candidates.length === 0) return { kind: "unauthorized" };
  const record = records[0]!;
  const operation = record.program.operations[0];
  const targetEntityId = operation && "entityId" in operation ? operation.entityId : null;
  const matching = candidates.filter(({ studioEntityId }) => studioEntityId === targetEntityId);
  const candidate = matching[0];
  if (matching.length !== 1 || !candidate) return { kind: "unauthorized" };
  const edit = runtimeTraceEditProgram(record, candidate);
  return edit ? { candidate, edit, kind: "authorized" } : { kind: "unauthorized" };
}

/**
 * Binds Runtime Trace validation to the staged Program and verified snapshot,
 * rather than to the current playhead. Scrubbing away from an edit endpoint
 * must never downgrade the same Program to ordinary source lowering.
 */
export function studioPreviewRuntimeTraceProgramValidation(
  snapshot: StudioVerifiedPreviewSnapshotV1,
  records: readonly ProgramRecord[],
  sourceEvents: RuntimeSceneState["eventTrack"]["events"],
): StudioPreviewRuntimeTraceProgramValidation {
  const source = snapshot.snapshot.scene.source;
  if (source.kind !== "imported-manim-runtime-trace" || source.traceVersion !== 3 || records.length === 0) {
    return "not-applicable";
  }
  const sourceAnchor = records[0]?.program.anchor.resolvedSeconds;
  if (sourceAnchor === undefined) return "rejected";
  const candidates = studioPreviewRuntimeTraceEditCandidates(snapshot, sourceAnchor, sourceEvents);
  return studioPreviewRuntimeTraceEditProgramSet(records, candidates).kind === "authorized" ? "authorized" : "rejected";
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
  _sampleTime: number,
) {
  if (!authority || !interactionGeometry?.has(authority.runtimeEntityId)) {
    return entities;
  }
  const projection = authority.entityProjection;
  const target = entities.find(({ id }) => id === authority.studioEntityId);
  if (!target || !studioRuntimeTraceEditTargetMatches(target, authority)) return entities;
  // One is a normalized basis for the candidate's relative scale factor, not
  // a claim about the absolute scale computed by Python source.
  return entities.map((entity) =>
    entity.id === target.id
      ? {
          ...entity,
          geometry: {
            ...entity.geometry,
            position: { kind: "known" as const, value: projection.baseCenter },
            ...(authority.capabilities.uniformScale ? { scale: { kind: "known" as const, value: 1 } } : {}),
          },
          position: projection.baseCenter,
          present: true,
          ...(authority.capabilities.uniformScale ? { scale: 1 } : {}),
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

function studioPointToScenePoint(
  point: Point,
  frame: Readonly<{ height: number; width: number }>,
  cameraCenter: Point,
) {
  return {
    x: cameraCenter.x + (point.x / STUDIO_VIEWPORT.width - 0.5) * frame.width,
    y: cameraCenter.y + (0.5 - point.y / STUDIO_VIEWPORT.height) * frame.height,
  };
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

function importedAnimationSnapshotCorrelationIsExact(snapshot: StudioVerifiedPreviewSnapshotV1) {
  const { correlation, snapshot: bundle } = snapshot;
  const source = bundle.scene.source;
  return (
    source.kind === "imported-manim-server-snapshot" &&
    Number(source.snapshotVersion) === 7 &&
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

function isExactCreateChannel(channel: SceneIrV1["animationChannels"][number]) {
  return (
    channel.kind === "path-trim" &&
    channel.parameterization === "uniform-cubic-parameter-v1" &&
    channel.keyframes.length === 2 &&
    channel.keyframes[0]?.at === 0 &&
    channel.keyframes[0]?.value === 0 &&
    channel.keyframes[1]?.value === 1
  );
}

function applyTransform(point: Point, transform: SceneEntityV1["transform"]): Point {
  return {
    x: transform.m11 * point.x + transform.m12 * point.y + transform.tx,
    y: transform.m21 * point.x + transform.m22 * point.y + transform.ty,
  };
}

function localBoundaryCenter(scene: SceneIrV1, entity: SceneEntityV1) {
  const byId = new Map(scene.entities.map((candidate) => [candidate.id, candidate]));
  const points = scene.entities.flatMap((candidate) => {
    if (candidate.geometry.kind !== "cubic-path") return [];
    const transforms: SceneEntityV1["transform"][] = [];
    let cursor: SceneEntityV1 | undefined = candidate;
    const seen = new Set<string>();
    while (cursor.id !== entity.id) {
      if (seen.has(cursor.id)) return [];
      seen.add(cursor.id);
      transforms.push(cursor.transform);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
      if (!cursor) return [];
    }
    return candidate.geometry.path.subpaths.flatMap((subpath) =>
      [subpath.start, ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end])].map(
        (point) => transforms.reduce((transformed, transform) => applyTransform(transformed, transform), point),
      ),
    );
  });
  if (points.length === 0) return null;
  return {
    x: (Math.min(...points.map(({ x }) => x)) + Math.max(...points.map(({ x }) => x))) / 2,
    y: (Math.min(...points.map(({ y }) => y)) + Math.max(...points.map(({ y }) => y))) / 2,
  };
}

function uniformSourceTransform(entity: SceneEntityV1, localCenter: Point) {
  const { m11, m12, m21, m22, tx, ty } = entity.transform;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(m11), Math.abs(m22)) * 32;
  if (
    ![m11, m12, m21, m22, tx, ty].every(Number.isFinite) ||
    m11 <= 0 ||
    m12 !== 0 ||
    m21 !== 0 ||
    Math.abs(m11 - m22) > tolerance
  ) {
    return null;
  }
  const worldCenter = { x: m11 * localCenter.x + tx, y: m22 * localCenter.y + ty };
  return Number.isFinite(worldCenter.x) && Number.isFinite(worldCenter.y) ? { scale: m11, worldCenter } : null;
}

function operationIssueCode(
  kind: ProposedState["programs"][number]["program"]["operations"][number]["kind"],
): StudioPreviewTemporalRebaseIssueCode {
  if (kind === "ChangeCamera") return "camera-edit-unsupported";
  if (kind === "CreateMotion" || kind === "ModifyMotion") return "motion-path-edit-unsupported";
  if (kind === "InsertSceneBoundary" || kind === "InsertTimelineEvent" || kind === "TrimSceneDuration") {
    return "channel-timing-edit-unsupported";
  }
  if (kind === "ResizeEntity" || kind === "TransformContent") return "geometry-edit-unsupported";
  return "target-edit-unsupported";
}

function planImportedAnimationInitialTransform(
  input: Readonly<{ proposedState: ProposedState; snapshot: StudioVerifiedPreviewSnapshotV1 }>,
): Readonly<{ edit: AuthorizedImportedAnimationEdit; kind: "supported" }> | StudioPreviewTemporalRebaseResult {
  const scene = input.snapshot.snapshot.scene;
  if (!importedAnimationSnapshotCorrelationIsExact(input.snapshot)) {
    return unsupported("source-correlation-invalid", "The verified imported animation has inconsistent authority.");
  }
  if (input.proposedState.evaluatedScene.duration !== scene.duration) {
    return unsupported(
      "channel-timing-edit-unsupported",
      "Initial imported-animation edits cannot change Scene or channel timing.",
    );
  }
  const base = input.proposedState.base;
  const context = input.snapshot.correlation.context;
  const expectedStudioSceneId = `${context.sourcePath}#${context.sceneName}`;
  if (
    base.runtimeSceneState.duration !== scene.duration ||
    base.runtimeSceneState.sceneId !== expectedStudioSceneId ||
    base.editorContext.activeSceneId !== expectedStudioSceneId ||
    input.proposedState.evaluatedScene.sceneId !== expectedStudioSceneId ||
    base.sourceSnapshot.sourceId !== context.sourcePath ||
    base.sourceSnapshot.hash !== `sha256:${context.sourceHash}`
  ) {
    return unsupported("source-correlation-invalid", "Studio state is not correlated with the imported animation.");
  }

  const identity = input.snapshot.sourceRuntimeIdentity;
  if (!identity || identity.size !== scene.entities.length) {
    return unsupported("identity-unverified", "Imported-animation edits require complete runtime identity.");
  }
  const runtimeEntities = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const verifiedRuntimeIds = new Set<string>();
  for (const [sourceName, mapping] of identity) {
    if (
      mapping.sourceName !== sourceName ||
      !runtimeEntities.has(mapping.entityId) ||
      verifiedRuntimeIds.has(mapping.entityId)
    ) {
      return unsupported("identity-unverified", "Imported animation identity is incomplete or ambiguous.");
    }
    verifiedRuntimeIds.add(mapping.entityId);
  }
  if (verifiedRuntimeIds.size !== runtimeEntities.size) {
    return unsupported("identity-unverified", "Imported animation identity does not cover every entity.");
  }

  const baseEntities = base.runtimeSceneState.objectGraph.entities;
  const evaluatedEntities = input.proposedState.evaluatedScene.objectGraph.entities;
  if (Object.keys(baseEntities).length !== Object.keys(evaluatedEntities).length) {
    return unsupported(
      "target-edit-unsupported",
      "Initial imported-animation edits cannot create, remove, or replace imported entities.",
    );
  }
  const mappedStudioRuntimeIds = new Set<string>();
  const studioToRuntime = new Map<string, string>();
  for (const entity of Object.values(evaluatedEntities)) {
    const baseEntity = baseEntities[entity.id];
    if (
      !baseEntity ||
      entity.provisional ||
      entity.transactionId !== undefined ||
      entity.type !== baseEntity.type ||
      entity.sourceIdentity.kind !== "known" ||
      baseEntity.sourceIdentity.kind !== "known" ||
      entity.sourceIdentity.value !== baseEntity.sourceIdentity.value
    ) {
      return unsupported("identity-unverified", "An imported animation target has no stable identity.");
    }
    const mapping = identity.get(entity.sourceIdentity.value);
    if (
      !mapping ||
      mapping.sourceName !== entity.sourceIdentity.value ||
      !runtimeEntities.has(mapping.entityId) ||
      mappedStudioRuntimeIds.has(mapping.entityId)
    ) {
      return unsupported("identity-unverified", "Imported animation identity is incomplete or ambiguous.");
    }
    mappedStudioRuntimeIds.add(mapping.entityId);
    studioToRuntime.set(entity.id, mapping.entityId);
  }

  const channelsByEntity = new Map<string, SceneIrV1["animationChannels"]>();
  for (const channel of scene.animationChannels) {
    if (!("entityId" in channel) || (channel.kind !== "path-trim" && channel.kind !== "motion-path")) {
      return unsupported("profile-unsupported", "The imported animation contains an unsupported channel.");
    }
    channelsByEntity.set(channel.entityId, [...(channelsByEntity.get(channel.entityId) ?? []), channel]);
  }

  let edit: AuthorizedImportedAnimationEdit | null = null;
  const authorizedOperations = new Map<
    string,
    Readonly<{ key: "position" | "scale"; studioEntityId: string; value: Point | number }>
  >();
  for (const record of input.proposedState.programs) {
    const { program } = record;
    if (record.validation.status !== "valid") {
      return unsupported("conflicting-edit-unsupported", "Imported animation edits require a valid Program.");
    }
    if (program.anchor.resolvedSeconds !== 0 || program.anchor.capturedPlayhead !== 0) {
      return unsupported("mid-animation-edit-unsupported", "Imported animation edits must be anchored at time zero.");
    }
    if (program.loweringStatus !== "supported") {
      return unsupported("target-edit-unsupported", "Imported animation edits must be source-lowerable.");
    }
    for (const operation of program.operations) {
      if (operation.interval.start !== 0 || operation.interval.end !== 0) {
        return unsupported("mid-animation-edit-unsupported", "Imported animation edits must be instantaneous.");
      }
      if (authorizedOperations.has(operation.id)) {
        return unsupported("conflicting-edit-unsupported", "Imported animation operation IDs must be unique.");
      }
      if (!("entityId" in operation)) {
        return unsupported(operationIssueCode(operation.kind), "The operation does not commute with imported time.");
      }
      const runtimeEntityId = studioToRuntime.get(operation.entityId);
      if (!runtimeEntityId) {
        return unsupported("identity-unverified", "An edited Studio entity has no verified runtime identity.");
      }
      if (edit && edit.runtimeEntityId !== runtimeEntityId) {
        return unsupported("conflicting-edit-unsupported", "One imported animation revision may edit one target.");
      }
      const targetChannels = channelsByEntity.get(runtimeEntityId) ?? [];
      if (targetChannels.some(({ kind }) => kind === "motion-path")) {
        return unsupported("motion-path-edit-unsupported", "A MoveAlongPath target cannot be edited locally.");
      }
      const studioEntity = evaluatedEntities[operation.entityId];
      const staticMathTex = studioEntity?.type === "MathTex" && targetChannels.length === 0;
      const createTarget = targetChannels.length === 1 && isExactCreateChannel(targetChannels[0]!);
      const runtimeEntity = runtimeEntities.get(runtimeEntityId);
      if ((!staticMathTex && !createTarget) || runtimeEntity?.geometry.kind !== "cubic-path") {
        return unsupported("target-edit-unsupported", "The imported animation does not authorize this target.");
      }
      const prior: AuthorizedImportedAnimationEdit = edit ?? {
        operationIds: [],
        position: null,
        runtimeEntityId,
        scaleFactor: null,
      };
      if (operation.kind === "SetProperty" && operation.key === "position" && isFinitePoint(operation.value)) {
        if (prior.position) {
          return unsupported("conflicting-edit-unsupported", "The target has conflicting position edits.");
        }
        edit = { ...prior, operationIds: [...prior.operationIds, operation.id], position: { ...operation.value } };
        authorizedOperations.set(operation.id, {
          key: "position",
          studioEntityId: operation.entityId,
          value: operation.value,
        });
        continue;
      }
      if (
        operation.kind === "AnimateProperty" &&
        operation.key === "scale" &&
        operation.control === undefined &&
        typeof operation.from === "number" &&
        typeof operation.to === "number" &&
        typeof operation.relativeFactor === "number" &&
        Number.isFinite(operation.from) &&
        Number.isFinite(operation.to) &&
        Number.isFinite(operation.relativeFactor) &&
        operation.from > 0 &&
        operation.to > 0 &&
        operation.relativeFactor > 0 &&
        closeEnough(operation.to / operation.from, operation.relativeFactor)
      ) {
        if (prior.scaleFactor !== null) {
          return unsupported("conflicting-edit-unsupported", "The target has conflicting scale edits.");
        }
        edit = {
          ...prior,
          operationIds: [...prior.operationIds, operation.id],
          scaleFactor: operation.relativeFactor,
        };
        authorizedOperations.set(operation.id, {
          key: "scale",
          studioEntityId: operation.entityId,
          value: operation.to,
        });
        continue;
      }
      return unsupported(operationIssueCode(operation.kind), "Only position and uniform scale edits are supported.");
    }
  }
  if (!edit) return unsupported("target-edit-unsupported", "The imported animation has no supported edit.");

  const observedOperations = new Map<string, number>();
  for (const channel of Object.values(input.proposedState.evaluatedScene.propertyChannels)) {
    for (const sample of channel.samples) {
      if (!sample.operationId) continue;
      const authorized = authorizedOperations.get(sample.operationId);
      const positionMatches =
        authorized?.key === "position" &&
        sample.kind === "exact" &&
        isFinitePoint(sample.value) &&
        isFinitePoint(authorized.value) &&
        closeEnough(sample.value.x, authorized.value.x) &&
        closeEnough(sample.value.y, authorized.value.y);
      const scaleMatches =
        authorized?.key === "scale" &&
        sample.kind === "animated" &&
        typeof sample.from === "number" &&
        typeof sample.value === "number" &&
        typeof authorized.value === "number" &&
        closeEnough(sample.value, authorized.value);
      if (
        !authorized ||
        authorized.studioEntityId !== channel.entityId ||
        authorized.key !== channel.key ||
        (!positionMatches && !scaleMatches)
      ) {
        return unsupported(
          "conflicting-edit-unsupported",
          "Evaluated imported-animation evidence does not match its authorized operation.",
        );
      }
      observedOperations.set(sample.operationId, (observedOperations.get(sample.operationId) ?? 0) + 1);
    }
  }
  if ([...authorizedOperations].some(([operationId]) => observedOperations.get(operationId) !== 1)) {
    return unsupported(
      "conflicting-edit-unsupported",
      "Imported animation edits require one evaluated sample per authorized operation.",
    );
  }
  return { edit, kind: "supported" };
}

/** Rebase one supported imported-animation edit through the canonical Rust transform command. */
export async function compileStudioPreviewImportedAnimationEdit(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    sourceRevisionHash: string;
    transformCompiler?: TransformSceneEntityCompiler;
  }>,
): Promise<StudioPreviewTemporalRebaseResult> {
  const scene = input.snapshot.snapshot.scene;
  if (
    !Number.isFinite(input.frame.width) ||
    !Number.isFinite(input.frame.height) ||
    input.frame.width !== scene.camera.view.frameWidth ||
    input.frame.height !== scene.camera.view.frameHeight
  ) {
    return unsupported("camera-edit-unsupported", "Imported animation editing requires the verified camera frame.");
  }
  const planned = planImportedAnimationInitialTransform(input);
  if (planned.kind !== "supported") return planned;
  const { edit } = planned;
  const target = scene.entities.find(({ id }) => id === edit.runtimeEntityId);
  const center = target ? localBoundaryCenter(scene, target) : null;
  if (!target || !center) {
    return unsupported("geometry-edit-unsupported", "The imported animation target has no bounded cubic geometry.");
  }
  const sourceTransform = uniformSourceTransform(target, center);
  if (!sourceTransform) {
    return unsupported(
      "profile-unsupported",
      "Imported animation entities must use a finite positive uniform transform without rotation or shear.",
    );
  }
  const targetCenter = edit.position
    ? studioPointToScenePoint(edit.position, input.frame, scene.camera.view.center)
    : sourceTransform.worldCenter;
  const delta = {
    x: targetCenter.x - sourceTransform.worldCenter.x,
    y: targetCenter.y - sourceTransform.worldCenter.y,
  };
  const scaleFactor = edit.scaleFactor === null || edit.scaleFactor === 1 ? null : edit.scaleFactor;
  if (
    !Number.isFinite(delta.x) ||
    !Number.isFinite(delta.y) ||
    (scaleFactor === null && delta.x === 0 && delta.y === 0)
  ) {
    return unsupported("profile-unsupported", "The imported animation transform is not finite and positive.");
  }
  const provenanceId = `studio-imported-animation-edit:${input.sourceRevisionHash}`;
  try {
    const rebased = await (input.transformCompiler ?? compileTransformSceneEntity)(input.snapshot.snapshot, {
      entityId: edit.runtimeEntityId,
      expectedBaseRevision: sceneIrSourceRevisionHash(scene),
      intent: {
        delta,
        kind: "relative",
        ...(scaleFactor === null
          ? {}
          : { scale: { pivot: sourceTransform.worldCenter, xFactor: scaleFactor, yFactor: scaleFactor } }),
      },
      nextRevision: input.sourceRevisionHash,
      provenance: {
        evidence: [
          "Studio t=0 transform rebased onto verified imported animation geometry",
          ...edit.operationIds.map((operationId) => `authorized operation ${operationId}`),
        ],
        id: provenanceId,
        origin: "studio-edit-program",
      },
      schema: "poietra.transform-scene-entity",
      version: 1,
    });
    return { kind: "rebased", scene: rebased.scene };
  } catch (error) {
    return unsupported(
      "geometry-edit-unsupported",
      `Rust core rejected the imported animation transform: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * Reprojects one endpoint-authorized edit onto the verified Runtime Trace
 * hierarchy. Construction edits mutate the root transform; settled edits add
 * one exact-time root transform in Rust so every earlier frame stays intact.
 */
export async function compileStudioPreviewRuntimeTraceEdit(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    proposedState: ProposedState;
    rotationCompiler?: RotateSceneEntityCompiler;
    subtreePaintAlphaCompiler?: SetSubtreeVectorPaintAlphaCompiler;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    sourceRevisionHash: string;
    transformCompiler?: TransformSceneEntityCompiler;
    transformAtTimeCompiler?: TransformSceneEntityAtTimeCompiler;
  }>,
): Promise<StudioPreviewTemporalRebaseResult> {
  const sourceAnchor = input.proposedState.programs[0]?.program.anchor.resolvedSeconds;
  const candidates =
    sourceAnchor === undefined
      ? []
      : studioPreviewRuntimeTraceEditCandidates(
          input.snapshot,
          sourceAnchor,
          input.proposedState.base.runtimeSceneState.eventTrack.events,
        );
  if (candidates.length === 0) {
    return unsupported("source-correlation-invalid", "Runtime Trace edit evidence is unavailable at this time.");
  }
  const scene = input.snapshot.snapshot.scene;
  const context = input.snapshot.correlation.context;
  const base = input.proposedState.base;
  const correlation = candidates[0]!;
  if (
    input.frame.width !== scene.camera.view.frameWidth ||
    input.frame.height !== scene.camera.view.frameHeight ||
    base.runtimeSceneState.sceneId !== correlation.studioSceneId ||
    base.runtimeSceneState.duration !== correlation.duration ||
    base.editorContext.activeSceneId !== correlation.studioSceneId ||
    base.sourceSnapshot.sourceId !== context.sourcePath ||
    base.sourceSnapshot.hash !== `sha256:${context.sourceHash}` ||
    input.proposedState.evaluatedScene.sceneId !== correlation.studioSceneId ||
    input.proposedState.evaluatedScene.duration !== correlation.duration
  ) {
    return unsupported(
      "source-correlation-invalid",
      "Studio state is not correlated with the Runtime Trace edit evidence.",
    );
  }
  const programSet = studioPreviewRuntimeTraceEditProgramSet(input.proposedState.programs, candidates);
  if (programSet.kind !== "authorized") {
    return unsupported(
      "target-edit-unsupported",
      "Runtime Trace permits one position move or uniform resize at this verified endpoint; construction-time evidence may also permit rotation or opacity.",
    );
  }
  const candidate = programSet.candidate;
  const targetIndex = scene.entities.findIndex(({ id }) => id === candidate.runtimeEntityId);
  const target = scene.entities[targetIndex];
  if (!target || target.parentId !== null || target.geometry.kind !== "group") {
    return unsupported("identity-unverified", "The Runtime Trace edit target is not its verified root group.");
  }
  const edit = programSet.edit;
  const provenanceId = `studio-runtime-trace-${candidate.phase}-${edit.kind}:${input.sourceRevisionHash}`;
  if (scene.provenance.some(({ id }) => id === provenanceId)) {
    return unsupported("conflicting-edit-unsupported", "The Runtime Trace edit provenance identity already exists.");
  }
  const provenance = {
    evidence: [
      edit.kind === "move"
        ? `Studio ${candidate.phase} position request projected onto one verified Runtime Trace root`
        : edit.kind === "opacity"
          ? "Studio construction-time absolute opacity request projected onto static vector paints in one verified Runtime Trace root"
          : edit.kind === "resize"
            ? `Studio ${candidate.phase} uniform resize request projected onto one verified Runtime Trace root`
            : "Studio construction-time planar rotation request projected onto one verified Runtime Trace root",
      `source binding ${candidate.bindingId}`,
      `authorized operation ${input.proposedState.programs[0]!.program.operations[0]!.id}`,
    ],
    id: provenanceId,
    origin: "studio-edit-program" as const,
  };
  if (edit.kind === "opacity") {
    const paintEvidence = genericRuntimeTraceSubtreePaintEvidence(scene, target.id);
    if (!paintEvidence.opacityEditable || !candidate.capabilities.paintOpacity) {
      return unsupported(
        "target-edit-unsupported",
        "Runtime Trace opacity edits require static vector paint throughout the selected subtree.",
      );
    }
    try {
      const rebased = await (input.subtreePaintAlphaCompiler ?? compileSetSubtreeVectorPaintAlpha)(
        input.snapshot.snapshot,
        {
          alpha: edit.opacity,
          expectedBaseRevision: sceneIrSourceRevisionHash(scene),
          nextRevision: input.sourceRevisionHash,
          provenance,
          rootEntityId: target.id,
          schema: "poietra.set-subtree-vector-paint-alpha",
          version: 1,
        },
      );
      return { kind: "rebased", scene: rebased.scene };
    } catch (error) {
      return unsupported(
        "target-edit-unsupported",
        `Rust core rejected the Runtime Trace paint opacity: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  const baseCenter = studioPointToScenePoint(candidate.baseCenter, input.frame, scene.camera.view.center);
  if (edit.kind === "move") {
    const targetCenter = studioPointToScenePoint(edit.position, input.frame, scene.camera.view.center);
    const delta = { x: targetCenter.x - baseCenter.x, y: targetCenter.y - baseCenter.y };
    try {
      const rebased =
        candidate.phase === "construction"
          ? await (input.transformCompiler ?? compileTransformSceneEntity)(input.snapshot.snapshot, {
              entityId: target.id,
              expectedBaseRevision: sceneIrSourceRevisionHash(scene),
              intent: { delta, kind: "relative" },
              nextRevision: input.sourceRevisionHash,
              provenance,
              schema: "poietra.transform-scene-entity",
              version: 1,
            })
          : await (input.transformAtTimeCompiler ?? compileTransformSceneEntityAtTime)(input.snapshot.snapshot, {
              at: candidate.sourceAnchor,
              delta,
              entityId: target.id,
              expectedBaseRevision: sceneIrSourceRevisionHash(scene),
              nextRevision: input.sourceRevisionHash,
              provenance,
              schema: "poietra.transform-scene-entity-at-time",
              version: 1,
            });
      return { kind: "rebased", scene: rebased.scene };
    } catch (error) {
      return unsupported(
        "geometry-edit-unsupported",
        `Rust core rejected the Runtime Trace move: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  if (edit.kind === "rotation") {
    try {
      const rebased = await (input.rotationCompiler ?? compileRotateSceneEntity)(input.snapshot.snapshot, {
        angleRadians: edit.angleRadians,
        entityId: target.id,
        expectedBaseRevision: sceneIrSourceRevisionHash(scene),
        nextRevision: input.sourceRevisionHash,
        pivot: baseCenter,
        provenance,
        schema: "poietra.rotate-scene-entity",
        version: 1,
      });
      return { kind: "rebased", scene: rebased.scene };
    } catch (error) {
      return unsupported(
        "geometry-edit-unsupported",
        `Rust core rejected the Runtime Trace rotation: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  try {
    const common = {
      entityId: target.id,
      expectedBaseRevision: sceneIrSourceRevisionHash(scene),
      nextRevision: input.sourceRevisionHash,
      provenance,
      version: 1 as const,
    };
    const rebased =
      candidate.phase === "construction"
        ? await (input.transformCompiler ?? compileTransformSceneEntity)(input.snapshot.snapshot, {
            ...common,
            intent: {
              delta: { x: 0, y: 0 },
              kind: "relative",
              scale: { pivot: baseCenter, xFactor: edit.scaleFactor, yFactor: edit.scaleFactor },
            },
            schema: "poietra.transform-scene-entity",
          })
        : await (input.transformAtTimeCompiler ?? compileTransformSceneEntityAtTime)(input.snapshot.snapshot, {
            ...common,
            at: candidate.sourceAnchor,
            delta: { x: 0, y: 0 },
            scale: { pivot: baseCenter, xFactor: edit.scaleFactor, yFactor: edit.scaleFactor },
            schema: "poietra.transform-scene-entity-at-time",
          });
    return { kind: "rebased", scene: rebased.scene };
  } catch (error) {
    return unsupported(
      "geometry-edit-unsupported",
      `Rust core rejected the Runtime Trace uniform resize: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}
