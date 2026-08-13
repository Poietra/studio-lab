import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CaptureCanvasFrameEvidenceInputV1 } from "../engine/canvas-worker-client";
import { MAX_CANVAS_INTERACTION_ENTITY_IDS } from "../engine/canvas-worker-protocol";
import type { SceneIrBundleV1 } from "../engine/contracts";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import {
  compileMathTexOutlineV1,
  type MathTexOutlineArtifactV1,
  type MathTexOutlineCompilerV1,
  mathTexOutlineResponseV1Schema,
} from "../engine/mathtex-outline";
import {
  createCanvasPreviewRendererV1,
  type PreviewRendererHostStateV1,
  type PreviewViewportV1,
  StudioPreviewRendererHost,
} from "../engine/preview-renderer";
import { sourceIdentityV1Schema } from "../engine/primitives";
import {
  type CreateSceneEntitiesCompiler,
  type CreateSceneEntitiesWireCommandV1,
  type CreateSceneMotionCompiler,
  compileCreateSceneEntities,
  compileCreateSceneMotion,
  compileEditSceneTimeline,
  compileTransformSceneEntity,
  type EditSceneTimelineCompiler,
  type EditSceneTimelineWireCommandV1,
  type RotateSceneEntityCompiler,
  type SetSubtreeVectorPaintAlphaCompiler,
  type TransformSceneEntityAtTimeCompiler,
  type TransformSceneEntityCompiler,
  type TransformSceneEntityWireCommandV1,
} from "../engine/scene-authoring";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import { canonicalEditableContent } from "./editable-content";
import type {
  EntityDimensions,
  Point,
  ProgramRecord,
  ProjectedEntity,
  ProposedState,
  RuntimeSceneState,
} from "./model";
import type { CanonicalEditOperation } from "./operations";
import {
  detectStudioPreviewCapabilities,
  evaluateStudioPreviewEligibility,
  projectStudioPreviewInteractionGeometry,
  resolveStudioPreviewViewState,
  type StudioPreviewHostBinding,
  type StudioPreviewInteractionGeometry,
  snapStudioPreviewViewport,
  studioPreviewHostBindingCurrent,
  studioPreviewVerifiedSourceDurationV1,
} from "./preview-renderer-policy";
import {
  loadStudioPreviewSnapshotMetadataV1,
  PRISTINE_WORKING_REVISION,
  type StudioPreviewEditingContextV1,
  type StudioPreviewSnapshotFailureKindV1,
  type StudioPreviewSnapshotProviderV1,
  type StudioPreviewSourceRuntimeIdentityV1,
  type StudioVerifiedPreviewSnapshotV1,
  studioPreviewSnapshotFailureKindV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";
import {
  compileStudioPreviewRuntimeTraceEdit,
  type StudioPreviewRuntimeTraceEditCandidate,
  type StudioPreviewRuntimeTraceProgramValidation,
  studioPreviewRuntimeTraceEditAnchor,
  studioPreviewRuntimeTraceEditCandidates,
  studioPreviewRuntimeTraceProgramValidation,
} from "./preview-temporal-rebase";
import { insertedProgramDuration } from "./program-composition";
import { isEntityDimensionsValue, isPointValue } from "./property-sampling";
import { studioPointToScenePoint, studioVectorToSceneVector } from "./scene-authoring-geometry";

export type StudioPreviewRendererView = Readonly<{
  attachCanvas: (canvas: HTMLCanvasElement | null) => void;
  /** Verified world-space center used to project Studio viewport positions. */
  cameraCenter: Readonly<{ x: number; y: number }> | null;
  epoch: number;
  /**
   * Hit-target geometry derived from that frame's prepared GPU vertices,
   * keyed by verified runtime entity ID; non-null only while correlated.
   */
  interactionGeometry: StudioPreviewInteractionGeometry | null;
  interactionAuthority: StudioPreviewInteractionAuthority;
  /** Verified Runtime Trace candidates editable at this exact endpoint. */
  runtimeTraceEditCandidates: readonly StudioPreviewRuntimeTraceEditCandidate[];
  /** Runtime roots with no static Studio entity; selectors only, never authoring evidence. */
  runtimeTraceOpaqueSelectionEntities: readonly ProjectedEntity[];
  sourceLabel: string | null;
  /** Typed provider outcome; never inferred from diagnostic text. */
  sourceMetadataFailureKind: StudioPreviewSnapshotFailureKindV1 | null;
  /** Lifecycle of verified source metadata for the current provider/Scene. */
  sourceMetadataPhase: "failed" | "inactive" | "loading" | "ready";
  /** Server-verified source name to runtime entity mapping for this snapshot. */
  sourceRuntimeIdentity: StudioPreviewSourceRuntimeIdentityV1 | null;
  state: PreviewRendererHostStateV1;
  /** Preview-only endpoint authority; source lowering still verifies the exact boundary. */
  runtimeTraceEditAnchor: number | null;
  /** Validation bound to the staged Program and snapshot, independent of the playhead. */
  runtimeTraceProgramValidation: StudioPreviewRuntimeTraceProgramValidation;
  /** Verified fast-manim base duration for the current source identity. */
  verifiedSourceDuration: number | null;
}>;

export type StudioPreviewInteractionAuthority =
  | Readonly<{ kind: "interactive"; nestedGroupEntityIds?: readonly string[] }>
  | Readonly<{
      editableRuntimeEntityIds: readonly string[];
      kind: "bounded-interactive";
      reason: "runtime-trace-edit";
      sourceAnchor: number;
      verifiedRuntimeEntityIds: readonly string[];
    }>
  | Readonly<{
      kind: "selection-only";
      reason: "runtime-trace-preview-only";
      verifiedRuntimeEntityIds: readonly string[];
    }>
  | Readonly<{
      kind: "selection-only";
      reason: "source-edit-anchor-unavailable" | "source-edit-unsupported";
    }>
  | Readonly<{
      kind: "display-only";
      reason: "aggregate-mathtex-morph-lineage" | "source-runtime-identity-unverified" | "temporal-rebase-unavailable";
    }>;

export type UseStudioPreviewRendererInput = Readonly<{
  context: StudioPreviewEditingContextV1 | null;
  frame: Readonly<{ height: number; width: number }>;
  proposedState: ProposedState | null;
  provider: StudioPreviewSnapshotProviderV1 | null;
  retainedSourceDuration: number | null;
  sampleTime: number;
  sceneBoundaryActive: boolean;
  sourceEvents: RuntimeSceneState["eventTrack"]["events"];
}>;

// transferControlToOffscreen is irreversible per element, so a canvas that
// already fed one worker can never be reused; the epoch key mints a fresh one.
const consumedCanvases = new WeakSet<object>();

/**
 * Returns true exactly once per canvas element. A second claim (StrictMode
 * double-mount, workspace switch onto a kept-alive element) must instead mint
 * a fresh canvas via the epoch key.
 */
export function claimStudioPreviewCanvasV1(canvas: object): boolean {
  if (consumedCanvases.has(canvas)) return false;
  consumedCanvases.add(canvas);
  return true;
}

type BoundHostStateV1 = Readonly<{
  binding: StudioPreviewHostBinding;
  host: StudioPreviewRendererHost;
  state: PreviewRendererHostStateV1;
}>;

type CompiledStudioPreviewSceneV1 = Readonly<{
  bundle: StudioVerifiedPreviewSnapshotV1["snapshot"];
  engineRevisionHash: string;
  frame: Readonly<{ height: number; width: number }>;
  interactionEntityIds: readonly string[];
  snapshot: StudioVerifiedPreviewSnapshotV1;
  workingRevision: string;
  workspaceKey: string;
}>;

type StudioPreviewCompilationStateV1 =
  | Readonly<{ phase: "inactive" }>
  | Readonly<{ error: string; phase: "unsupported"; workingRevision: string; workspaceKey: string }>
  | Readonly<{ phase: "ready"; scene: CompiledStudioPreviewSceneV1 }>;

const INACTIVE_COMPILATION: StudioPreviewCompilationStateV1 = { phase: "inactive" };

type StudioPreviewHostInstallationV1 = Readonly<{
  scene: CompiledStudioPreviewSceneV1;
  snapshot: StudioVerifiedPreviewSnapshotV1;
  workspaceKey: string;
}>;

function importedSnapshotCorrelationIsExact(
  snapshot: StudioVerifiedPreviewSnapshotV1,
  requirePristineWorkingRevision: boolean,
) {
  const { correlation, snapshot: bundle } = snapshot;
  const source = bundle.scene.source;
  return (
    (source.kind === "imported-manim-runtime-trace" || source.kind === "imported-manim-server-snapshot") &&
    sceneIrSourceRevisionHash(bundle.scene) === correlation.engineRevisionHash &&
    source.sourceHash === correlation.context.sourceHash &&
    bundle.assets.manifestDigest === correlation.assetsManifestDigest &&
    bundle.scene.sceneId === correlation.sceneId &&
    snapshot.sceneId === correlation.sceneId &&
    bundle.scene.duration === correlation.sceneDuration &&
    snapshot.duration === correlation.sceneDuration &&
    correlation.sceneDuration === correlation.context.sourceDuration &&
    (!requirePristineWorkingRevision || correlation.context.workingRevision === PRISTINE_WORKING_REVISION)
  );
}

export function projectStudioPreviewRuntimeTraceOpaqueSelectionEntities(
  input: Readonly<{
    interactionGeometry: StudioPreviewInteractionGeometry | null;
    sourceRuntimeIdentity: StudioPreviewSourceRuntimeIdentityV1 | null;
    studioSceneId: string | null;
  }>,
): readonly ProjectedEntity[] {
  if (!input.studioSceneId || !input.interactionGeometry || !input.sourceRuntimeIdentity) return [];
  const runtimeOnly = (field: string) => ({
    kind: "unknown" as const,
    reason: `The verified Runtime Trace owns ${field}; it is selection-only Studio evidence.`,
  });
  return [...input.sourceRuntimeIdentity].flatMap(([sourceName, mapping]) => {
    if (mapping.sourceName !== sourceName) return [];
    const geometry = input.interactionGeometry?.get(mapping.entityId);
    if (!geometry) return [];
    return [
      {
        content: { displayLines: [sourceName], label: `${sourceName} · runtime` },
        geometry: {
          dimensions: runtimeOnly("visual bounds"),
          position: runtimeOnly("position"),
          scale: runtimeOnly("scale"),
          style: runtimeOnly("paint"),
        },
        id: `source:${input.studioSceneId}:${sourceName}`,
        opacity: 1,
        position: geometry.position,
        present: true,
        provisional: false,
        scale: 1,
        sourceIdentity: { kind: "known", value: sourceName },
        type: "RuntimeMobject",
      },
    ];
  });
}

/** Runtime pixels may be presented without granting source mutation authority. */
export function studioPreviewInteractionAuthority(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
  sourceAnchor: number,
  sourceEvents: RuntimeSceneState["eventTrack"]["events"],
): StudioPreviewInteractionAuthority {
  if (!snapshot) return { kind: "interactive" };
  const source = snapshot.snapshot.scene.source;
  if (source?.kind === "imported-manim-runtime-trace") {
    const verifiedRuntimeEntityIds = snapshot.sourceRuntimeIdentity
      ? [...snapshot.sourceRuntimeIdentity.values()].map(({ entityId }) => entityId)
      : [];
    const candidates =
      source.traceVersion === 3 ? studioPreviewRuntimeTraceEditCandidates(snapshot, sourceAnchor, sourceEvents) : [];
    if (
      candidates.length > 0 &&
      candidates.every(({ runtimeEntityId }) => verifiedRuntimeEntityIds.includes(runtimeEntityId))
    ) {
      const candidateSourceAnchors = new Set(candidates.map(({ sourceAnchor }) => sourceAnchor));
      if (candidateSourceAnchors.size !== 1) {
        return {
          kind: "selection-only",
          reason: "runtime-trace-preview-only",
          verifiedRuntimeEntityIds,
        };
      }
      return {
        editableRuntimeEntityIds: candidates.map(({ runtimeEntityId }) => runtimeEntityId),
        kind: "bounded-interactive",
        reason: "runtime-trace-edit",
        sourceAnchor: candidates[0]!.sourceAnchor,
        verifiedRuntimeEntityIds,
      };
    }
    return {
      kind: "selection-only",
      reason: "runtime-trace-preview-only",
      verifiedRuntimeEntityIds,
    };
  }
  if (source.kind !== "imported-manim-server-snapshot") return { kind: "interactive" };
  if (Number(source.snapshotVersion) === 5) {
    return { kind: "display-only", reason: "aggregate-mathtex-morph-lineage" };
  }
  const snapshotVersion = Number(source.snapshotVersion);
  // Dynamic authoring belongs to the generic Runtime Trace authority above.
  // A legacy server snapshot may still render, but it never advertises an
  // editable target that cannot be reproduced by that canonical path.
  if (snapshot.snapshot.scene.animationChannels.length > 0) {
    return (snapshot.sourceRuntimeIdentity?.size ?? 0) > 0
      ? { kind: "selection-only", reason: "source-edit-unsupported" }
      : { kind: "display-only", reason: "source-runtime-identity-unverified" };
  }
  if (snapshotVersion === 6) {
    return (snapshot?.sourceRuntimeIdentity?.size ?? 0) > 0
      ? { kind: "interactive" }
      : { kind: "display-only", reason: "source-runtime-identity-unverified" };
  }
  if (snapshotVersion >= 7 && snapshotVersion <= 12) {
    return (snapshot?.sourceRuntimeIdentity?.size ?? 0) > 0
      ? { kind: "selection-only", reason: "source-edit-anchor-unavailable" }
      : { kind: "display-only", reason: "source-runtime-identity-unverified" };
  }
  return { kind: "interactive" };
}

/** Selects only IDs admitted by the server-verified source/runtime map. */
export function studioPreviewInteractionEntityIdsV1(
  identity: StudioPreviewSourceRuntimeIdentityV1 | null,
  authority: StudioPreviewInteractionAuthority = { kind: "interactive" },
  entities: SceneIrBundleV1["scene"]["entities"] | null = null,
) {
  if (authority.kind === "display-only") return [];
  if (!identity) return [];
  // Canvas interaction admission comes from the verified render graph, not
  // from every bound emitted by the geometry provider. A verified Runtime
  // Trace root may be a top-level group; other groups are selectable only when
  // explicitly admitted here. Missing Scene evidence remains fail-closed for
  // selection-only mode.
  const editableNestedGroups =
    authority.kind === "interactive" ? new Set(authority.nestedGroupEntityIds ?? []) : new Set<string>();
  const runtimeTraceSelection =
    (authority.kind === "selection-only" && authority.reason === "runtime-trace-preview-only") ||
    authority.kind === "bounded-interactive";
  const verifiedRuntimeEntityIds = new Set(runtimeTraceSelection ? authority.verifiedRuntimeEntityIds : []);
  const genericRuntimeTraceRootIds = new Set(
    [...identity.values()]
      .filter(({ runtimeTraceEvidence }) => runtimeTraceEvidence !== undefined)
      .map(({ entityId }) => entityId),
  );
  const drawableEntityIds =
    entities === null
      ? authority.kind === "selection-only" || authority.kind === "bounded-interactive"
        ? new Set<string>()
        : null
      : new Set(
          entities
            .filter(({ geometry, id, parentId }) =>
              runtimeTraceSelection
                ? geometry.kind === "group" && (parentId !== null || genericRuntimeTraceRootIds.has(id))
                : geometry.kind !== "group" ||
                  (authority.kind === "selection-only" && parentId !== null) ||
                  editableNestedGroups.has(id),
            )
            .map(({ id }) => id),
        );
  const entityIds: string[] = [];
  const seen = new Set<string>();
  for (const mapping of identity.values()) {
    if (runtimeTraceSelection && !verifiedRuntimeEntityIds.has(mapping.entityId)) continue;
    if (
      seen.has(mapping.entityId) ||
      !sourceIdentityV1Schema.safeParse(mapping.entityId).success ||
      (drawableEntityIds !== null && !drawableEntityIds.has(mapping.entityId))
    )
      continue;
    seen.add(mapping.entityId);
    entityIds.push(mapping.entityId);
    if (entityIds.length === MAX_CANVAS_INTERACTION_ENTITY_IDS) break;
  }
  return entityIds;
}

export function studioPreviewPresentedRuntimeTraceEditAnchor(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
  state: PreviewRendererHostStateV1,
  authority: StudioPreviewInteractionAuthority,
  sourceEvents: RuntimeSceneState["eventTrack"]["events"],
) {
  return snapshot && state.phase === "presented" && authority.kind === "bounded-interactive"
    ? studioPreviewRuntimeTraceEditAnchor(snapshot, authority.sourceAnchor, sourceEvents)
    : null;
}

export function studioPreviewHostReadyForSceneUpdateV1(state: PreviewRendererHostStateV1) {
  return !(state.phase === "fallback" && state.reason === "installing");
}

export async function digestStudioPreviewSceneRevisionV1(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    mathTexOutlines?: Readonly<Record<string, MathTexOutlineArtifactV1>>;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    studioScene: Readonly<{ duration: number; sceneId: string }>;
    workingRevision: string;
    workspaceKey: string;
  }>,
) {
  const source = input.snapshot.snapshot.scene.source;
  const sourceAuthority =
    source.kind === "imported-manim-server-snapshot"
      ? [source.kind, source.sourceHash, source.runtimeConfigHash, source.snapshotVersion, source.snapshotHash]
      : source.kind === "imported-manim-runtime-trace"
        ? [source.kind, source.sourceHash, source.runtimeConfigHash, source.traceVersion, source.traceDigest]
        : [source.kind, source.editProgramVersion, source.revisionHash];
  // An ordered scalar tuple is the canonical serialization for this digest.
  // Every authority axis that can alter the compiled bundle is included so a
  // retained worker never observes two different scenes under one revision.
  const revisionBasis = [
    "poietra.studio-scene-ir-v1",
    input.workspaceKey,
    input.workingRevision,
    input.snapshot.correlation.engineRevisionHash,
    input.snapshot.correlation.assetsManifestDigest,
    input.snapshot.correlation.sceneId,
    input.snapshot.correlation.sceneDuration,
    input.snapshot.snapshot.assets.manifestDigest,
    sourceAuthority,
    input.studioScene.sceneId,
    input.studioScene.duration,
    input.frame.width,
    input.frame.height,
    Object.entries(input.mathTexOutlines ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entityId, outline]) => [
        entityId,
        outline.contentDigest,
        outline.toolchainDigest,
        outline.fontDigest,
        outline.bounds,
        outline.path,
      ]),
  ];
  const bytes = new TextEncoder().encode(canonicalJsonV1(revisionBasis));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type StaticImportedRootTransformPlan =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "unsupported"; message: string }>
  | Readonly<{
      effect:
        | Readonly<{ delta: Point; kind: "translate" }>
        | Readonly<{
            baseline: Extract<TransformSceneEntityWireCommandV1["intent"], { kind: "from-baseline" }>["baseline"];
            kind: "from-baseline";
            scale?: Readonly<{ xFactor: number; yFactor: number }>;
            targetCenter?: Point;
          }>;
      kind: "authorized";
      operationIds: readonly string[];
      runtimeEntityId: string;
    }>;

type ImportedTimelinePlan =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "unsupported"; message: string }>
  | Readonly<{
      edits: EditSceneTimelineWireCommandV1["edits"];
      kind: "authorized";
      operationIds: readonly string[];
    }>;

type ImportedMotionPlan =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "unsupported"; message: string }>
  | Readonly<{
      controlOffset: Point;
      delta: Point;
      easing: "linear" | "smooth";
      interval: Readonly<{ end: number; start: number }>;
      kind: "authorized";
      operationId: string;
      runtimeEntityIds: readonly string[];
    }>;

type StaticImportedPositionOperation = Extract<CanonicalEditOperation, { kind: "SetProperty" }> &
  Readonly<{ key: "position" }>;
type StaticImportedScaleOperation = Extract<CanonicalEditOperation, { kind: "AnimateProperty" }> &
  Readonly<{ key: "scale" }>;
type StaticImportedResizeOperation = Extract<CanonicalEditOperation, { kind: "ResizeEntity" }>;
type StaticImportedTransformOperation =
  | StaticImportedPositionOperation
  | StaticImportedResizeOperation
  | StaticImportedScaleOperation;

type StaticImportedTransformEntry = Readonly<{
  operation: StaticImportedTransformOperation;
  record: ProgramRecord;
}>;

type StudioCreatedEntityEntry = Readonly<{
  create: Extract<CanonicalEditOperation, { kind: "CreateEntity" }>;
  entity: RuntimeSceneState["objectGraph"]["entities"][string];
  fadeIn?: Extract<CanonicalEditOperation, { kind: "ChangePresence" }>;
  instantTransform?: Readonly<{
    at: number;
    position: Point;
    scaleX: number;
    scaleY: number;
  }>;
  position: Extract<CanonicalEditOperation, { kind: "SetProperty" }> & Readonly<{ key: "position"; value: Point }>;
}>;

type StudioCreatedEntityAuthoringState = {
  dimensions?: EntityDimensions;
  initialDimensions?: EntityDimensions;
  instantAt?: number;
  position: Point;
  scale: number;
  type: "Circle" | "MathTex" | "Rectangle";
};

type StudioCreatedEntityPlan =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "unsupported"; message: string }>
  | Readonly<{
      entities: readonly StudioCreatedEntityEntry[];
      kind: "authorized";
      operationCount: number;
      programCount: number;
      timelineInsertions: readonly Readonly<{ at: number; duration: number }>[];
    }>;

function evaluatedOperationStart(scene: RuntimeSceneState, operationId: string) {
  const events = scene.eventTrack.events.filter((event) => event.operationId === operationId);
  const interval = events.length === 1 ? events[0]?.interval : undefined;
  return interval && interval.start === interval.end && Number.isFinite(interval.start) ? interval.start : null;
}

function planStudioCreatedEntities(proposedState: ProposedState): StudioCreatedEntityPlan {
  const createPrograms = proposedState.programs
    .map((record, index) => ({ index, record }))
    .filter(({ record }) => record.program.operations.some(({ kind }) => kind === "CreateEntity"))
    .sort(
      (left, right) =>
        left.record.program.anchor.resolvedSeconds - right.record.program.anchor.resolvedSeconds ||
        left.index - right.index,
    )
    .map(({ record }) => record);
  const createProgramSet = new Set(createPrograms);
  const followupPrograms = proposedState.programs
    .map((record, index) => ({ index, record }))
    .filter(({ record }) => !createProgramSet.has(record))
    .sort(
      (left, right) =>
        left.record.program.anchor.resolvedSeconds - right.record.program.anchor.resolvedSeconds ||
        left.index - right.index,
    )
    .map(({ record }) => record);
  const createRecords = createPrograms.flatMap((record) =>
    record.program.operations.flatMap((create) => (create.kind === "CreateEntity" ? [{ create, record }] : [])),
  );
  if (createRecords.length === 0) return { kind: "not-applicable" };
  if (proposedState.programs.some(({ validation }) => validation.status !== "valid")) {
    return { kind: "unsupported", message: "Studio creation requires only validated edit Programs." };
  }
  const createdIds = new Set(createRecords.map(({ create }) => create.entity.id));
  if (createdIds.size !== createRecords.length) {
    return { kind: "unsupported", message: "Studio creation contains duplicate entity identities." };
  }
  for (const { create } of createRecords) {
    if (create.entity.type !== "Circle" && create.entity.type !== "Rectangle" && create.entity.type !== "MathTex") {
      return {
        kind: "unsupported",
        message: `Studio-created ${create.entity.type} is not supported by the canonical core creation command.`,
      };
    }
  }

  const permitted = createPrograms.every((record) => {
    const programCreatedIds = new Set(
      record.program.operations.flatMap((operation) =>
        operation.kind === "CreateEntity" ? [operation.entity.id] : [],
      ),
    );
    return record.program.operations.every(
      (operation) =>
        operation.kind === "CreateEntity" ||
        (operation.kind === "SetProperty" &&
          operation.key === "position" &&
          programCreatedIds.has(operation.entityId)) ||
        (operation.kind === "ChangePresence" &&
          operation.effect === "fade-in" &&
          operation.persistent &&
          programCreatedIds.has(operation.entityId)),
    );
  });
  if (!permitted) {
    return {
      kind: "unsupported",
      message:
        "Studio creation cannot be combined with edits outside the canonical create/position/fade operation set.",
    };
  }

  const evaluatedOrder = new Map(
    Object.keys(proposedState.evaluatedScene.objectGraph.entities).map((entityId, index) => [entityId, index]),
  );
  const orderedCreates = [...createRecords].sort(
    (left, right) =>
      (evaluatedOrder.get(left.create.entity.id) ?? Infinity) -
      (evaluatedOrder.get(right.create.entity.id) ?? Infinity),
  );
  const entities: StudioCreatedEntityEntry[] = [];
  const authoringState = new Map<string, StudioCreatedEntityAuthoringState>();
  for (const { create, record } of orderedCreates) {
    const entity = proposedState.evaluatedScene.objectGraph.entities[create.entity.id];
    const positions = record.program.operations.filter(
      (operation): operation is StudioCreatedEntityEntry["position"] =>
        operation.kind === "SetProperty" &&
        operation.key === "position" &&
        operation.entityId === create.entity.id &&
        isFinitePoint(operation.value),
    );
    const fades = record.program.operations.filter(
      (operation): operation is NonNullable<StudioCreatedEntityEntry["fadeIn"]> =>
        operation.kind === "ChangePresence" && operation.entityId === create.entity.id,
    );
    const lifetime = entity?.lifetime.length === 1 ? entity.lifetime[0] : undefined;
    if (
      !entity ||
      entity.sourceIdentity.kind !== "unknown" ||
      entity.transactionId === undefined ||
      entity.transactionId !== record.program.transactionId ||
      !entity.id.startsWith(`tx:${entity.transactionId}/entity:`) ||
      entity.type !== create.entity.type ||
      positions.length !== 1 ||
      fades.length > 1 ||
      !lifetime ||
      !Number.isFinite(lifetime.start) ||
      !Number.isFinite(lifetime.end) ||
      lifetime.end <= lifetime.start ||
      lifetime.start !== create.entity.lifetime.start ||
      (fades[0] !== undefined &&
        (fades[0].interval.start !== lifetime.start ||
          !Number.isFinite(fades[0].interval.end) ||
          fades[0].interval.end <= lifetime.start ||
          fades[0].interval.end > lifetime.end))
    ) {
      return {
        kind: "unsupported",
        message: `Studio-created entity ${create.entity.id} has incomplete canonical creation evidence.`,
      };
    }
    if (
      (create.entity.type === "Circle" &&
        (!Number.isFinite(create.entity.dimensions?.radius) || (create.entity.dimensions?.radius ?? 0) <= 0)) ||
      (create.entity.type === "Rectangle" &&
        (!Number.isFinite(create.entity.dimensions?.width) ||
          !Number.isFinite(create.entity.dimensions?.height) ||
          (create.entity.dimensions?.width ?? 0) <= 0 ||
          (create.entity.dimensions?.height ?? 0) <= 0))
    ) {
      return { kind: "unsupported", message: `Studio-created entity ${create.entity.id} has invalid dimensions.` };
    }
    entities.push({ create, entity, ...(fades[0] ? { fadeIn: fades[0] } : {}), position: positions[0] });
    authoringState.set(create.entity.id, {
      dimensions: create.entity.dimensions,
      initialDimensions: create.entity.dimensions,
      position: positions[0].value,
      scale: 1,
      type: create.entity.type as StudioCreatedEntityAuthoringState["type"],
    });
  }
  for (const { program } of followupPrograms) {
    const operationById = new Map(program.operations.map((operation) => [operation.id, operation]));
    for (const operationId of program.schedule.order) {
      const operation = operationById.get(operationId);
      if (!operation || !("entityId" in operation) || !createdIds.has(operation.entityId)) {
        return { kind: "unsupported", message: "Studio creation contains an unrelated follow-up operation." };
      }
      const state = authoringState.get(operation.entityId);
      const instantAt = evaluatedOperationStart(proposedState.evaluatedScene, operation.id);
      const supportedPosition =
        operation.kind === "SetProperty" && operation.key === "position" && isFinitePoint(operation.value);
      const supportedScale =
        operation.kind === "AnimateProperty" &&
        operation.key === "scale" &&
        Number.isFinite(operation.relativeFactor) &&
        (operation.relativeFactor ?? 0) > 0;
      const supportedResize =
        operation.kind === "ResizeEntity" &&
        ((state?.type === "Circle" && operation.shape === "circle") ||
          (state?.type === "Rectangle" && operation.shape === "rectangle"));
      if (!state || instantAt === null || (!supportedPosition && !supportedScale && !supportedResize)) {
        return {
          kind: "unsupported",
          message: "Studio creation supports one instant move, uniform scale, or shape resize anchor per entity.",
        };
      }
      if (state.instantAt !== undefined && Math.abs(state.instantAt - instantAt) > 1e-9) {
        return {
          kind: "unsupported",
          message: `Studio-created entity ${operation.entityId} has edits at more than one instant anchor.`,
        };
      }
      state.instantAt = instantAt;
      if (supportedPosition) state.position = operation.value;
      if (supportedScale) state.scale *= operation.relativeFactor!;
      if (supportedResize && operation.kind === "ResizeEntity") {
        state.dimensions = operation.to.dimensions;
        state.position = operation.to.position;
      }
    }
  }
  const timelineInsertions = createPrograms.map(({ program }) => ({
    at: program.anchor.resolvedSeconds,
    duration: insertedProgramDuration(program),
  }));
  const insertedDuration = timelineInsertions.reduce((total, insertion) => total + insertion.duration, 0);
  if (
    timelineInsertions.some(({ at, duration }) => !Number.isFinite(at) || !Number.isFinite(duration) || duration < 0) ||
    Math.abs(proposedState.base.runtimeSceneState.duration + insertedDuration - proposedState.evaluatedScene.duration) >
      1e-9
  ) {
    return {
      kind: "unsupported",
      message: "Studio creation does not resolve to canonical timeline insertions.",
    };
  }
  const authorizedEntities: StudioCreatedEntityEntry[] = [];
  for (const entry of entities) {
    const state = authoringState.get(entry.entity.id)!;
    if (state.instantAt === undefined) {
      authorizedEntities.push(entry);
      continue;
    }
    const initial = state.initialDimensions;
    const current = state.dimensions;
    const ratios =
      state.type === "Circle" && initial?.radius && current?.radius
        ? { x: current.radius / initial.radius, y: current.radius / initial.radius }
        : state.type === "Rectangle" && initial?.width && initial.height && current?.width && current.height
          ? { x: current.width / initial.width, y: current.height / initial.height }
          : state.type === "MathTex"
            ? { x: 1, y: 1 }
            : null;
    if (!ratios || ratios.x <= 0 || ratios.y <= 0 || !Number.isFinite(ratios.x) || !Number.isFinite(ratios.y)) {
      return { kind: "unsupported", message: `Studio-created entity ${entry.entity.id} has invalid resize facts.` };
    }
    authorizedEntities.push({
      ...entry,
      instantTransform: {
        at: state.instantAt,
        position: state.position,
        scaleX: state.scale * ratios.x,
        scaleY: state.scale * ratios.y,
      },
    });
  }
  return {
    entities: authorizedEntities,
    kind: "authorized",
    operationCount: proposedState.programs.reduce((count, { program }) => count + program.operations.length, 0),
    programCount: proposedState.programs.length,
    timelineInsertions,
  };
}

function isFinitePoint(value: unknown): value is Point {
  return isPointValue(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function closeStaticTransformValue(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function sameStaticTransformPoint(left: Point, right: Point) {
  return closeStaticTransformValue(left.x, right.x) && closeStaticTransformValue(left.y, right.y);
}

function planImportedMotion(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
  }>,
): ImportedMotionPlan {
  const entries = input.proposedState.programs.flatMap((record) =>
    record.program.operations.map((operation) => ({ operation, record })),
  );
  const motionEntries = entries.filter(
    (
      entry,
    ): entry is Readonly<{
      operation: Extract<CanonicalEditOperation, { kind: "CreateMotion" }>;
      record: ProgramRecord;
    }> => entry.operation.kind === "CreateMotion",
  );
  if (motionEntries.length === 0) return { kind: "not-applicable" };
  if (motionEntries.length !== 1 || entries.length !== 1) {
    return { kind: "unsupported", message: "A canonical motion preview currently requires one CreateMotion." };
  }

  const { operation, record } = motionEntries[0]!;
  const program = record.program;
  const scene = input.snapshot.snapshot.scene;
  const correlation = input.snapshot.correlation;
  const base = input.proposedState.base;
  if (
    record.validation.status !== "valid" ||
    program.loweringStatus !== "supported" ||
    program.schedule.order.length !== 1 ||
    program.schedule.order[0] !== operation.id ||
    program.anchor.resolvedSeconds !== operation.interval.start ||
    operation.provenance.origin !== program.provenance.origin
  ) {
    return { kind: "unsupported", message: "The motion has no validated Studio authoring authority." };
  }
  if (
    scene.source.kind !== "imported-manim-server-snapshot" ||
    !importedSnapshotCorrelationIsExact(input.snapshot, true) ||
    input.frame.width !== scene.camera.view.frameWidth ||
    input.frame.height !== scene.camera.view.frameHeight
  ) {
    return { kind: "unsupported", message: "The motion target is not one exact imported Scene." };
  }
  if (scene.animationChannels.some((channel) => channel.kind !== "opacity")) {
    return {
      kind: "unsupported",
      message: "Motion authoring requires a static camera and geometry; existing opacity animation is supported.",
    };
  }
  if (
    base.runtimeSceneState.sceneId !== base.editorContext.activeSceneId ||
    base.runtimeSceneState.sceneId !== `${correlation.context.sourcePath}#${correlation.context.sceneName}` ||
    input.proposedState.evaluatedScene.sceneId !== base.runtimeSceneState.sceneId ||
    base.sourceSnapshot.sourceId !== correlation.context.sourcePath ||
    base.sourceSnapshot.hash !== `sha256:${correlation.context.sourceHash}`
  ) {
    return { kind: "unsupported", message: "Studio motion state is not correlated with the verified Scene." };
  }
  const baseEntities = base.runtimeSceneState.objectGraph.entities;
  const identity = input.snapshot.sourceRuntimeIdentity;
  const runtimeEntityIds = operation.targetEntityIds.flatMap((studioEntityId) => {
    const studioEntity = baseEntities[studioEntityId];
    if (!studioEntity || studioEntity.provisional || studioEntity.sourceIdentity.kind !== "known") return [];
    const mapping = identity?.get(studioEntity.sourceIdentity.value);
    return mapping?.sourceName === studioEntity.sourceIdentity.value ? [mapping.entityId] : [];
  });
  if (runtimeEntityIds.length !== operation.targetEntityIds.length) {
    return { kind: "unsupported", message: "A motion target has no verified runtime identity." };
  }
  return {
    controlOffset: studioVectorToSceneVector(operation.controlOffset, input.frame),
    delta: studioVectorToSceneVector(operation.delta, input.frame),
    easing: operation.easing,
    interval: operation.interval,
    kind: "authorized",
    operationId: operation.id,
    runtimeEntityIds,
  };
}

function positiveShapeDimensions(type: "Circle" | "Rectangle", value: unknown): value is EntityDimensions {
  if (!isEntityDimensionsValue(value)) return false;
  return type === "Circle"
    ? value.radius !== undefined && value.radius > 0 && value.width === undefined && value.height === undefined
    : value.width !== undefined &&
        value.width > 0 &&
        value.height !== undefined &&
        value.height > 0 &&
        value.radius === undefined;
}

function sameShapeDimensions(type: "Circle" | "Rectangle", left: EntityDimensions, right: EntityDimensions) {
  return type === "Circle"
    ? closeStaticTransformValue(left.radius!, right.radius!)
    : closeStaticTransformValue(left.width!, right.width!) && closeStaticTransformValue(left.height!, right.height!);
}

function planStaticImportedRootTransform(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
  }>,
): StaticImportedRootTransformPlan {
  const base = input.proposedState.base;
  const baseEntities = base.runtimeSceneState.objectGraph.entities;
  const entries = input.proposedState.programs.flatMap((record) =>
    record.program.operations.map((operation) => ({ operation, record })),
  );
  const transformEntries = entries.filter((entry): entry is StaticImportedTransformEntry => {
    const { operation } = entry;
    if (!("entityId" in operation)) return false;
    const entity = baseEntities[operation.entityId];
    const scalable =
      entity?.type === "Circle" ||
      entity?.type === "Rectangle" ||
      entity?.type === "ImageMobject" ||
      entity?.type === "MathTex";
    return (
      entity !== undefined &&
      ((operation.kind === "SetProperty" && operation.key === "position") ||
        (scalable && operation.kind === "AnimateProperty" && operation.key === "scale") ||
        ((entity.type === "Circle" || entity.type === "Rectangle") && operation.kind === "ResizeEntity"))
    );
  });
  if (transformEntries.length === 0) return { kind: "not-applicable" };
  const scene = input.snapshot.snapshot.scene;
  if (scene.source.kind !== "imported-manim-server-snapshot") return { kind: "not-applicable" };
  const operations = transformEntries.map(({ operation }) => operation);
  const entityIds = new Set(operations.map(({ entityId }) => entityId));
  const positionOperations = operations.filter(
    (operation): operation is StaticImportedPositionOperation =>
      operation.kind === "SetProperty" && operation.key === "position",
  );
  const scaleOperations = operations.filter(
    (operation): operation is StaticImportedScaleOperation =>
      operation.kind === "AnimateProperty" && operation.key === "scale",
  );
  const resizeOperations = operations.filter(
    (operation): operation is StaticImportedResizeOperation => operation.kind === "ResizeEntity",
  );
  const targetId = operations[0]?.entityId;
  const target = targetId ? baseEntities[targetId] : undefined;
  const imageOrMathTex = target?.type === "ImageMobject" || target?.type === "MathTex";
  const primitiveType = target?.type === "Circle" || target?.type === "Rectangle" ? target.type : null;
  if (
    entityIds.size !== 1 ||
    positionOperations.length > 1 ||
    scaleOperations.length > 1 ||
    resizeOperations.length > 1
  ) {
    return { kind: "unsupported", message: "The static transform must identify one target." };
  }
  if (
    entries.length !== transformEntries.length ||
    (resizeOperations.length === 1 ? operations.length !== 1 : operations.length > 2)
  ) {
    return {
      kind: "unsupported",
      message: "One static imported transform may contain one resize or one position plus one uniform scale edit.",
    };
  }
  for (const { operation, record } of transformEntries) {
    const program = record.program;
    const origin = program.provenance.origin;
    const positionIsAuthorized =
      operation.kind === "SetProperty" &&
      operation.key === "position" &&
      isFinitePoint(operation.value) &&
      (origin === "direct-manipulation" || origin === "studio-default");
    const scaleIsAuthorized =
      operation.kind === "AnimateProperty" &&
      operation.key === "scale" &&
      origin === "direct-manipulation" &&
      operation.control === undefined &&
      typeof operation.relativeFactor === "number" &&
      Number.isFinite(operation.relativeFactor) &&
      operation.relativeFactor > 0 &&
      operation.relativeFactor !== 1;
    const resizeIsAuthorized =
      operation.kind === "ResizeEntity" &&
      primitiveType !== null &&
      operation.shape === (primitiveType === "Circle" ? "circle" : "rectangle") &&
      (origin === "direct-manipulation" || origin === "studio-default") &&
      Number.isFinite(operation.scale) &&
      operation.scale > 0 &&
      positiveShapeDimensions(primitiveType, operation.from.dimensions) &&
      positiveShapeDimensions(primitiveType, operation.to.dimensions) &&
      isFinitePoint(operation.from.position) &&
      isFinitePoint(operation.to.position);
    if (
      record.validation.status !== "valid" ||
      program.anchor.resolvedSeconds !== 0 ||
      program.loweringStatus !== "supported" ||
      operation.interval.start !== 0 ||
      operation.interval.end !== 0 ||
      operation.provenance.origin !== origin ||
      (!positionIsAuthorized && !scaleIsAuthorized && !resizeIsAuthorized)
    ) {
      return {
        kind: "unsupported",
        message: "Only exact t=0 pointer, keyboard, or Inspector transforms are supported.",
      };
    }
  }

  const correlation = input.snapshot.correlation;
  if (
    scene.animationChannels.length !== 0 ||
    input.frame.width !== scene.camera.view.frameWidth ||
    input.frame.height !== scene.camera.view.frameHeight ||
    !importedSnapshotCorrelationIsExact(input.snapshot, true)
  ) {
    return { kind: "unsupported", message: "The verified source snapshot is not one exact static Scene." };
  }
  if (
    base.runtimeSceneState.sceneId !== base.editorContext.activeSceneId ||
    base.runtimeSceneState.sceneId !== `${correlation.context.sourcePath}#${correlation.context.sceneName}` ||
    input.proposedState.evaluatedScene.sceneId !== base.runtimeSceneState.sceneId ||
    base.sourceSnapshot.sourceId !== correlation.context.sourcePath ||
    base.sourceSnapshot.hash !== `sha256:${correlation.context.sourceHash}`
  ) {
    return { kind: "unsupported", message: "Studio state is not correlated with the verified static Scene." };
  }

  const baseEntity = target;
  const basePosition = baseEntity?.geometry?.position;
  const baseScale = baseEntity?.geometry?.scale;
  const baseDimensions = baseEntity?.geometry?.dimensions;
  const semanticScale =
    baseScale?.kind === "known" && Number.isFinite(baseScale.value) && baseScale.value > 0 ? baseScale.value : null;
  const primitiveTransform = primitiveType !== null && (scaleOperations.length === 1 || resizeOperations.length === 1);
  const requiresSemanticPosition = !imageOrMathTex;
  if (
    !baseEntity ||
    baseEntity.provisional ||
    baseEntity.transactionId !== undefined ||
    baseEntity.sourceIdentity.kind !== "known" ||
    (requiresSemanticPosition && (basePosition?.kind !== "known" || !isFinitePoint(basePosition.value))) ||
    (primitiveTransform && semanticScale === null) ||
    (primitiveTransform &&
      (baseDimensions?.kind !== "known" || !positiveShapeDimensions(primitiveType, baseDimensions.value)))
  ) {
    return { kind: "unsupported", message: "The imported transform has no stable semantic identity and baseline." };
  }
  const mapping = input.snapshot.sourceRuntimeIdentity?.get(baseEntity.sourceIdentity.value);
  const runtimeEntity = mapping ? scene.entities.find(({ id }) => id === mapping.entityId) : undefined;
  const reverseMappingCount = mapping
    ? [...(input.snapshot.sourceRuntimeIdentity?.values() ?? [])].filter(
        ({ entityId }) => entityId === mapping.entityId,
      ).length
    : 0;
  const runtimeTypeMatches =
    (primitiveType === "Circle" &&
      (runtimeEntity?.geometry.kind === "circle" || runtimeEntity?.geometry.kind === "cubic-path") &&
      runtimeEntity.appearance.kind === "vector") ||
    (primitiveType === "Rectangle" &&
      (runtimeEntity?.geometry.kind === "rectangle" || runtimeEntity?.geometry.kind === "cubic-path") &&
      runtimeEntity.appearance.kind === "vector") ||
    (!imageOrMathTex && primitiveType === null) ||
    (baseEntity.type === "ImageMobject" &&
      runtimeEntity?.geometry.kind === "image" &&
      runtimeEntity.appearance.kind === "image") ||
    (baseEntity.type === "MathTex" &&
      runtimeEntity?.geometry.kind === "cubic-path" &&
      runtimeEntity.appearance.kind === "vector");
  if (
    !mapping ||
    mapping.sourceName !== baseEntity.sourceIdentity.value ||
    reverseMappingCount !== 1 ||
    !runtimeEntity ||
    runtimeEntity.parentId !== null ||
    !runtimeTypeMatches
  ) {
    return { kind: "unsupported", message: "The Studio entity does not resolve to one verified runtime root." };
  }
  const semanticCenter =
    basePosition?.kind === "known" && isFinitePoint(basePosition.value)
      ? studioPointToScenePoint(basePosition.value, input.frame, scene.camera.view.center)
      : null;
  const resize = resizeOperations[0];
  const resizeBaselineMatches =
    !resize ||
    (primitiveType !== null &&
      baseDimensions?.kind === "known" &&
      semanticScale !== null &&
      basePosition?.kind === "known" &&
      sameShapeDimensions(primitiveType, resize.from.dimensions, baseDimensions.value) &&
      sameStaticTransformPoint(resize.from.position, basePosition.value) &&
      closeStaticTransformValue(resize.scale, semanticScale));
  if (!resizeBaselineMatches) {
    return { kind: "unsupported", message: "The semantic transform baseline does not match verified geometry." };
  }

  const position = positionOperations[0];
  const targetPosition = resize?.to.position ?? (position && isFinitePoint(position.value) ? position.value : null);
  const targetCenter = targetPosition
    ? studioPointToScenePoint(targetPosition, input.frame, scene.camera.view.center)
    : semanticCenter;
  const scaleFactor = scaleOperations[0]?.relativeFactor;
  const xFactor = resize
    ? primitiveType === "Circle"
      ? resize.to.dimensions.radius! / resize.from.dimensions.radius!
      : resize.to.dimensions.width! / resize.from.dimensions.width!
    : scaleFactor;
  const yFactor = resize
    ? primitiveType === "Circle"
      ? resize.to.dimensions.radius! / resize.from.dimensions.radius!
      : resize.to.dimensions.height! / resize.from.dimensions.height!
    : scaleFactor;
  const hasScale = xFactor !== undefined && yFactor !== undefined && (xFactor !== 1 || yFactor !== 1);
  if (
    (targetCenter !== null && !isFinitePoint(targetCenter)) ||
    (xFactor !== undefined && (!Number.isFinite(xFactor) || xFactor <= 0)) ||
    (yFactor !== undefined && (!Number.isFinite(yFactor) || yFactor <= 0)) ||
    (!hasScale && targetPosition === null)
  ) {
    return { kind: "unsupported", message: "The static transform must have one finite non-zero effect." };
  }

  const geometryVerifiedTransform = imageOrMathTex || primitiveTransform;
  let effect: Extract<StaticImportedRootTransformPlan, { kind: "authorized" }>["effect"];
  if (!geometryVerifiedTransform) {
    if (semanticCenter === null || targetCenter === null) {
      return { kind: "unsupported", message: "The imported move has no stable semantic position." };
    }
    const semanticDelta = { x: targetCenter.x - semanticCenter.x, y: targetCenter.y - semanticCenter.y };
    if (!isFinitePoint(semanticDelta) || (semanticDelta.x === 0 && semanticDelta.y === 0)) {
      return { kind: "unsupported", message: "The static transform must have one finite non-zero effect." };
    }
    effect = { delta: semanticDelta, kind: "translate" };
  } else {
    let baseline: Extract<TransformSceneEntityWireCommandV1["intent"], { kind: "from-baseline" }>["baseline"] = {
      kind: "current-center",
    };
    if (
      primitiveTransform &&
      primitiveType !== null &&
      baseDimensions?.kind === "known" &&
      semanticScale !== null &&
      semanticCenter !== null
    ) {
      const width =
        primitiveType === "Circle"
          ? baseDimensions.value.radius! * semanticScale * 2
          : baseDimensions.value.width! * semanticScale;
      const height =
        primitiveType === "Circle"
          ? baseDimensions.value.radius! * semanticScale * 2
          : baseDimensions.value.height! * semanticScale;
      baseline = { height, kind: "world-size", width, worldCenter: semanticCenter };
    } else if (baseEntity.type === "MathTex" && hasScale) {
      baseline = { kind: "current-uniform-affine" };
    }
    effect = {
      baseline,
      kind: "from-baseline",
      ...(!hasScale ? {} : { scale: { xFactor: xFactor!, yFactor: yFactor! } }),
      ...(targetPosition === null || targetCenter === null ? {} : { targetCenter }),
    };
  }
  return {
    effect,
    kind: "authorized",
    operationIds: operations.map(({ id }) => id),
    runtimeEntityId: runtimeEntity.id,
  };
}

function planImportedTimeline(
  input: Readonly<{ proposedState: ProposedState; snapshot: StudioVerifiedPreviewSnapshotV1 }>,
): ImportedTimelinePlan {
  const orderedRecords = input.proposedState.programs
    .map((record, inputIndex) => ({ inputIndex, record }))
    .sort(
      (left, right) =>
        (left.record.program.anchor.source.kind === "absolute"
          ? left.record.program.anchor.source.seconds
          : left.record.program.anchor.resolvedSeconds) -
          (right.record.program.anchor.source.kind === "absolute"
            ? right.record.program.anchor.source.seconds
            : right.record.program.anchor.resolvedSeconds) || left.inputIndex - right.inputIndex,
    )
    .map(({ record }) => record);
  const timelineOperations = orderedRecords.flatMap(({ program }) =>
    program.schedule.order.flatMap((operationId) => {
      const operation = program.operations.find(({ id }) => id === operationId);
      return operation?.kind === "InsertTimelineEvent" || operation?.kind === "TrimSceneDuration"
        ? [{ operation, program }]
        : [];
    }),
  );
  if (timelineOperations.length === 0) return { kind: "not-applicable" };

  const scene = input.snapshot.snapshot.scene;
  const allOperationsAreTimelineEdits = orderedRecords.every(
    ({ program, validation }) =>
      validation.status === "valid" &&
      program.loweringStatus === "supported" &&
      program.operations.length === 1 &&
      program.schedule.order.length === 1 &&
      program.schedule.order[0] === program.operations[0]?.id &&
      (program.operations[0]?.kind === "InsertTimelineEvent" || program.operations[0]?.kind === "TrimSceneDuration"),
  );
  if (!allOperationsAreTimelineEdits) {
    return {
      kind: "unsupported",
      message: "A Scene timeline edit cannot be combined with another preview operation.",
    };
  }
  if (
    scene.source.kind !== "imported-manim-server-snapshot" ||
    !importedSnapshotCorrelationIsExact(input.snapshot, true) ||
    Math.abs(input.proposedState.base.runtimeSceneState.duration - scene.duration) >= 0.0005 ||
    input.proposedState.base.runtimeSceneState.sceneId !== input.proposedState.base.editorContext.activeSceneId ||
    input.proposedState.base.runtimeSceneState.sceneId !==
      `${input.snapshot.correlation.context.sourcePath}#${input.snapshot.correlation.context.sceneName}` ||
    input.proposedState.base.sourceSnapshot.sourceId !== input.snapshot.correlation.context.sourcePath ||
    input.proposedState.base.sourceSnapshot.hash !== `sha256:${input.snapshot.correlation.context.sourceHash}`
  ) {
    return { kind: "unsupported", message: "The verified source snapshot is not one exact imported Scene." };
  }

  const authorizedWaitOperationIds: string[] = [];
  const edits: EditSceneTimelineWireCommandV1["edits"][number][] = [];
  const operationIds: string[] = [];
  for (const { operation, program } of timelineOperations) {
    const origin = program.provenance.origin;
    if (
      operation.provenance.origin !== origin ||
      origin !== "studio-default" ||
      program.anchor.source.kind !== "absolute" ||
      !Number.isFinite(program.anchor.source.seconds) ||
      !Number.isFinite(program.anchor.resolvedSeconds) ||
      program.anchor.resolvedSeconds < 0
    ) {
      return { kind: "unsupported", message: "The Scene timeline edit has no exact Studio duration authority." };
    }
    if (operation.kind === "InsertTimelineEvent") {
      const waitDuration = operation.interval.end - operation.interval.start;
      if (
        operation.eventKind !== "wait" ||
        operation.purpose !== "scene-duration" ||
        !closeStaticTransformValue(operation.interval.start, program.anchor.resolvedSeconds)
      ) {
        return { kind: "unsupported", message: "Only an exact Studio Scene duration wait can be inserted." };
      }
      edits.push({ at: operation.interval.start, duration: waitDuration, kind: "insert-wait" });
      authorizedWaitOperationIds.push(operation.id);
      operationIds.push(operation.id);
      continue;
    }

    const expectedWaitOperationIds = authorizedWaitOperationIds.toReversed();
    if (
      !closeStaticTransformValue(operation.interval.start, operation.interval.end) ||
      operation.waitOperationIds.length !== expectedWaitOperationIds.length ||
      operation.waitOperationIds.some((operationId, index) => operationId !== expectedWaitOperationIds[index])
    ) {
      return { kind: "unsupported", message: "The Scene duration trim has no exact Studio wait authority." };
    }
    edits.push({
      at: operation.interval.start,
      kind: "trim-scene-duration",
      removedDuration: operation.removedDuration,
      targetDuration: operation.targetDuration,
    });
    operationIds.push(operation.id);
  }

  if (input.proposedState.evaluatedScene.sceneId !== input.proposedState.base.runtimeSceneState.sceneId) {
    return { kind: "unsupported", message: "The Scene timeline edit does not preserve the Studio Scene identity." };
  }
  return { edits, kind: "authorized", operationIds };
}

export async function compileStudioPreviewSceneV1(
  input: Readonly<{
    createSceneEntitiesCompiler?: CreateSceneEntitiesCompiler;
    createSceneMotionCompiler?: CreateSceneMotionCompiler;
    editSceneTimelineCompiler?: EditSceneTimelineCompiler;
    frame: Readonly<{ height: number; width: number }>;
    mathTexOutlineCompiler?: MathTexOutlineCompilerV1;
    proposedState: ProposedState;
    rotationCompiler?: RotateSceneEntityCompiler;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    subtreePaintAlphaCompiler?: SetSubtreeVectorPaintAlphaCompiler;
    transformAtTimeCompiler?: TransformSceneEntityAtTimeCompiler;
    transformCompiler?: TransformSceneEntityCompiler;
    workingRevision: string;
    workspaceKey: string;
  }>,
): Promise<
  Readonly<{ error: string; kind: "unsupported" }> | Readonly<{ kind: "compiled"; scene: CompiledStudioPreviewSceneV1 }>
> {
  if (Math.abs(input.proposedState.base.runtimeSceneState.duration - input.snapshot.duration) >= 0.0005) {
    return {
      error: "Studio source state is not correlated with the verified imported Scene timing.",
      kind: "unsupported",
    };
  }
  if (input.workingRevision === PRISTINE_WORKING_REVISION && input.proposedState.programs.length > 0) {
    return { error: "A pristine Studio revision cannot contain evaluated edit Programs.", kind: "unsupported" };
  }
  if (input.proposedState.programs.length === 0) {
    const { correlation, snapshot } = input.snapshot;
    if (!importedSnapshotCorrelationIsExact(input.snapshot, true)) {
      return { error: "The base verified preview has inconsistent revision evidence.", kind: "unsupported" };
    }
    return {
      kind: "compiled",
      scene: {
        bundle: snapshot,
        engineRevisionHash: correlation.engineRevisionHash,
        frame: { ...input.frame },
        interactionEntityIds: studioPreviewInteractionEntityIdsV1(
          input.snapshot.sourceRuntimeIdentity,
          studioPreviewInteractionAuthority(
            input.snapshot,
            0,
            input.proposedState.base.runtimeSceneState.eventTrack.events,
          ),
          snapshot.scene.entities,
        ),
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      },
    };
  }
  const importedSource = input.snapshot.snapshot.scene.source;
  if (
    input.snapshot.snapshot.scene.animationChannels.length > 0 &&
    (importedSource.kind !== "imported-manim-runtime-trace" || importedSource.traceVersion !== 3)
  ) {
    return {
      error: "Editing an imported animation requires generic Runtime Trace authoring support.",
      kind: "unsupported",
    };
  }
  const createdEntityPlan = planStudioCreatedEntities(input.proposedState);
  if (createdEntityPlan.kind === "unsupported") {
    return { error: createdEntityPlan.message, kind: "unsupported" };
  }
  if (createdEntityPlan.kind === "authorized") {
    const outlineInputs: Array<Readonly<{ entityId: string; texParts: readonly string[] }>> = [];
    for (const { create, entity } of createdEntityPlan.entities) {
      if (create.entity.type !== "MathTex") continue;
      const sourceContent = canonicalEditableContent(create.entity.content, "MathTex");
      const evaluatedContent = canonicalEditableContent(entity.content, "MathTex");
      const contentSamples = input.proposedState.evaluatedScene.propertyChannels[`${entity.id}/content`]?.samples ?? [];
      const contentChanges = contentSamples.some((sample) => {
        const sampled = canonicalEditableContent(sample.value, "MathTex");
        return (
          !sampled?.texParts ||
          !sourceContent?.texParts ||
          sampled.texParts.length !== sourceContent.texParts.length ||
          sampled.texParts.some((part, index) => part !== sourceContent.texParts?.[index])
        );
      });
      if (
        !sourceContent?.texParts ||
        !evaluatedContent?.texParts ||
        contentChanges ||
        sourceContent.texParts.length !== evaluatedContent.texParts.length ||
        sourceContent.texParts.some((part, index) => part !== evaluatedContent.texParts?.[index])
      ) {
        return {
          error: `Studio-created MathTex entity ${entity.id} changes content or has no stable canonical content.`,
          kind: "unsupported",
        };
      }
      outlineInputs.push({ entityId: entity.id, texParts: sourceContent.texParts });
    }
    const mathTexOutlines: Record<string, MathTexOutlineArtifactV1> = {};
    try {
      const compiler = input.mathTexOutlineCompiler ?? compileMathTexOutlineV1;
      const responses = await Promise.all(
        outlineInputs.map(async ({ entityId, texParts }) => ({
          entityId,
          response: mathTexOutlineResponseV1Schema.parse(await compiler(texParts)),
        })),
      );
      for (const { entityId, response } of responses) {
        if (response.result.kind === "unsupported") {
          return {
            error: `MathTex entity ${entityId} is unsupported (${response.result.code}): ${response.result.message}`,
            kind: "unsupported",
          };
        }
        mathTexOutlines[entityId] = response.result;
      }
    } catch (error) {
      return {
        error: `MathTex outline compilation failed: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
    if (!importedSnapshotCorrelationIsExact(input.snapshot, true)) {
      return { error: "Studio creation requires an exactly correlated base snapshot.", kind: "unsupported" };
    }
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      mathTexOutlines,
      snapshot: input.snapshot,
      studioScene: input.proposedState.evaluatedScene,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    const entities: CreateSceneEntitiesWireCommandV1["entities"] = createdEntityPlan.entities.map(
      ({ create, entity, fadeIn, instantTransform, position }) => {
        const dimensions = create.entity.dimensions;
        const outline = mathTexOutlines[entity.id];
        const geometry =
          create.entity.type === "Circle" && dimensions?.radius !== undefined
            ? ({ kind: "circle", radius: dimensions.radius } as const)
            : create.entity.type === "Rectangle" && dimensions?.height !== undefined && dimensions.width !== undefined
              ? ({ height: dimensions.height, kind: "rectangle", width: dimensions.width } as const)
              : outline
                ? ({ kind: "mathtex", path: outline.path } as const)
                : null;
        if (!geometry) throw new Error(`Studio-created entity ${entity.id} has no compiled geometry.`);
        return {
          ...(fadeIn ? { fadeIn: { end: fadeIn.interval.end } } : {}),
          geometry,
          id: entity.id,
          ...(instantTransform
            ? {
                instantTransform: {
                  at: instantTransform.at,
                  position: studioPointToScenePoint(
                    instantTransform.position,
                    input.frame,
                    input.snapshot.snapshot.scene.camera.view.center,
                  ),
                  scaleX: instantTransform.scaleX,
                  scaleY: instantTransform.scaleY,
                },
              }
            : {}),
          lifetime: entity.lifetime[0]!,
          position: studioPointToScenePoint(
            position.value,
            input.frame,
            input.snapshot.snapshot.scene.camera.view.center,
          ),
          scale: 1,
        };
      },
    );
    try {
      const bundle = await (input.createSceneEntitiesCompiler ?? compileCreateSceneEntities)(input.snapshot.snapshot, {
        entities,
        expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
        nextRevision: engineRevisionHash,
        provenance: {
          evidence: [
            `${createdEntityPlan.programCount} validated Studio Program(s) with ${createdEntityPlan.operationCount} operation(s) lowered as one atomic creation/transform core command`,
          ],
          id: `studio-create:${engineRevisionHash}`,
          origin: "studio-edit-program",
        },
        schema: "poietra.create-scene-entities",
        timelineInsertions: createdEntityPlan.timelineInsertions,
        version: 1,
      });
      const bundleEntityIds = new Set(bundle.scene.entities.map(({ id }) => id));
      const interactionEntityIds = studioPreviewInteractionEntityIdsV1(
        input.snapshot.sourceRuntimeIdentity,
        studioPreviewInteractionAuthority(
          input.snapshot,
          0,
          input.proposedState.base.runtimeSceneState.eventTrack.events,
        ),
        bundle.scene.entities,
      );
      for (const { entity } of createdEntityPlan.entities) {
        if (
          bundleEntityIds.has(entity.id) &&
          !interactionEntityIds.includes(entity.id) &&
          interactionEntityIds.length < MAX_CANVAS_INTERACTION_ENTITY_IDS
        ) {
          interactionEntityIds.push(entity.id);
        }
      }
      return {
        kind: "compiled",
        scene: {
          bundle,
          engineRevisionHash,
          frame: { ...input.frame },
          interactionEntityIds,
          snapshot: input.snapshot,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected Studio entity creation: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
  }
  const importedTimeline = planImportedTimeline(input);
  if (importedTimeline.kind === "unsupported") {
    return { error: `Imported Scene timeline edit is unsupported: ${importedTimeline.message}`, kind: "unsupported" };
  }
  if (importedTimeline.kind === "authorized") {
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      studioScene: input.proposedState.evaluatedScene,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    try {
      const bundle = await (input.editSceneTimelineCompiler ?? compileEditSceneTimeline)(input.snapshot.snapshot, {
        edits: importedTimeline.edits,
        expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
        nextRevision: engineRevisionHash,
        provenance: {
          evidence: importedTimeline.operationIds.map((operationId) => `authorized operation ${operationId}`),
          id: `studio-imported-timeline:${engineRevisionHash}`,
          origin: "studio-edit-program",
        },
        schema: "poietra.edit-scene-timeline",
        version: 1,
      });
      if (
        bundle.scene.sceneId !== input.snapshot.snapshot.scene.sceneId ||
        Math.abs(bundle.scene.duration - input.proposedState.evaluatedScene.duration) >= 0.0005
      ) {
        return {
          error: "Rust core timeline result does not reproduce the Studio evaluated Scene.",
          kind: "unsupported",
        };
      }
      return {
        kind: "compiled",
        scene: {
          bundle,
          engineRevisionHash,
          frame: { ...input.frame },
          interactionEntityIds: studioPreviewInteractionEntityIdsV1(
            input.snapshot.sourceRuntimeIdentity,
            studioPreviewInteractionAuthority(
              input.snapshot,
              0,
              input.proposedState.base.runtimeSceneState.eventTrack.events,
            ),
            bundle.scene.entities,
          ),
          snapshot: input.snapshot,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected the imported Scene timeline edit: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        kind: "unsupported",
      };
    }
  }
  const importedMotion = planImportedMotion(input);
  if (importedMotion.kind === "unsupported") {
    return { error: `Imported Scene motion is unsupported: ${importedMotion.message}`, kind: "unsupported" };
  }
  if (importedMotion.kind === "authorized") {
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      studioScene: input.proposedState.evaluatedScene,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    try {
      const bundle = await (input.createSceneMotionCompiler ?? compileCreateSceneMotion)(input.snapshot.snapshot, {
        controlOffset: importedMotion.controlOffset,
        delta: importedMotion.delta,
        easing: importedMotion.easing,
        expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
        interval: importedMotion.interval,
        nextRevision: engineRevisionHash,
        provenance: {
          evidence: [`authorized operation ${importedMotion.operationId}`],
          id: `studio-motion:${engineRevisionHash}`,
          origin: "studio-edit-program",
        },
        schema: "poietra.create-scene-motion",
        targetEntityIds: importedMotion.runtimeEntityIds,
        version: 1,
      });
      return {
        kind: "compiled",
        scene: {
          bundle,
          engineRevisionHash,
          frame: { ...input.frame },
          interactionEntityIds: studioPreviewInteractionEntityIdsV1(
            input.snapshot.sourceRuntimeIdentity,
            studioPreviewInteractionAuthority(
              input.snapshot,
              0,
              input.proposedState.base.runtimeSceneState.eventTrack.events,
            ),
            bundle.scene.entities,
          ),
          snapshot: input.snapshot,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected the imported Scene motion: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        kind: "unsupported",
      };
    }
  }
  if (importedSource.kind === "imported-manim-runtime-trace" && importedSource.traceVersion === 3) {
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      studioScene: input.proposedState.evaluatedScene,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    const rebased = await compileStudioPreviewRuntimeTraceEdit({
      frame: input.frame,
      proposedState: input.proposedState,
      rotationCompiler: input.rotationCompiler,
      snapshot: input.snapshot,
      sourceRevisionHash: engineRevisionHash,
      subtreePaintAlphaCompiler: input.subtreePaintAlphaCompiler,
      transformAtTimeCompiler: input.transformAtTimeCompiler,
      transformCompiler: input.transformCompiler,
    });
    if (rebased.kind === "unsupported") {
      return {
        error: `Runtime Trace endpoint edit is unsupported (${rebased.issue.code}): ${rebased.issue.message}`,
        kind: "unsupported",
      };
    }
    const bundle = { assets: input.snapshot.snapshot.assets, scene: rebased.scene };
    return {
      kind: "compiled",
      scene: {
        bundle,
        engineRevisionHash,
        frame: { ...input.frame },
        interactionEntityIds: studioPreviewInteractionEntityIdsV1(
          input.snapshot.sourceRuntimeIdentity,
          studioPreviewInteractionAuthority(
            input.snapshot,
            0,
            input.proposedState.base.runtimeSceneState.eventTrack.events,
          ),
          rebased.scene.entities,
        ),
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      },
    };
  }
  const staticRootTransform = planStaticImportedRootTransform(input);
  if (staticRootTransform.kind === "unsupported") {
    return {
      error: `Static imported root transform is unsupported: ${staticRootTransform.message}`,
      kind: "unsupported",
    };
  }
  if (staticRootTransform.kind === "authorized") {
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      studioScene: input.proposedState.evaluatedScene,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    try {
      const includesScale = staticRootTransform.effect.kind === "from-baseline" && staticRootTransform.effect.scale;
      const provenance = {
        evidence: [
          includesScale
            ? "Studio t=0 transform projected onto one verified static imported root"
            : "Studio t=0 position request projected onto one verified static imported root",
          ...staticRootTransform.operationIds.map((operationId) => `authorized operation ${operationId}`),
        ],
        id: `studio-static-${includesScale ? "transform" : "move"}:${engineRevisionHash}`,
        origin: "studio-edit-program" as const,
      };
      const intent: TransformSceneEntityWireCommandV1["intent"] =
        staticRootTransform.effect.kind === "from-baseline"
          ? {
              baseline: staticRootTransform.effect.baseline,
              kind: "from-baseline",
              ...(staticRootTransform.effect.scale ? { scale: staticRootTransform.effect.scale } : {}),
              ...(staticRootTransform.effect.targetCenter
                ? { targetCenter: staticRootTransform.effect.targetCenter }
                : {}),
            }
          : { delta: staticRootTransform.effect.delta, kind: "relative" };
      const bundle = await (input.transformCompiler ?? compileTransformSceneEntity)(input.snapshot.snapshot, {
        entityId: staticRootTransform.runtimeEntityId,
        expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
        intent,
        nextRevision: engineRevisionHash,
        provenance,
        schema: "poietra.transform-scene-entity",
        version: 1,
      });
      return {
        kind: "compiled",
        scene: {
          bundle,
          engineRevisionHash,
          frame: { ...input.frame },
          interactionEntityIds: studioPreviewInteractionEntityIdsV1(
            input.snapshot.sourceRuntimeIdentity,
            studioPreviewInteractionAuthority(
              input.snapshot,
              0,
              input.proposedState.base.runtimeSceneState.eventTrack.events,
            ),
            bundle.scene.entities,
          ),
          snapshot: input.snapshot,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected the static imported root transform: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        kind: "unsupported",
      };
    }
  }
  return {
    error: "No canonical Rust preview command supports this Studio edit.",
    kind: "unsupported",
  };
}

export type StudioPreviewSnapshotMetadataStateV1 =
  | Readonly<{ phase: "inactive"; provider: null; snapshot: null; workspaceKey: null }>
  | Readonly<{ phase: "loading"; provider: StudioPreviewSnapshotProviderV1; snapshot: null; workspaceKey: string }>
  | Readonly<{
      phase: "ready";
      provider: StudioPreviewSnapshotProviderV1;
      snapshot: StudioVerifiedPreviewSnapshotV1;
      workspaceKey: string;
    }>
  | Readonly<{
      error: string;
      failureKind: StudioPreviewSnapshotFailureKindV1;
      phase: "failed";
      provider: StudioPreviewSnapshotProviderV1;
      snapshot: null;
      workspaceKey: string;
    }>;

const INACTIVE_METADATA: StudioPreviewSnapshotMetadataStateV1 = {
  phase: "inactive",
  provider: null,
  snapshot: null,
  workspaceKey: null,
};

/**
 * Resolves metadata synchronously for this render. A result retained from a
 * previous workspace/provider is represented as loading, never as current
 * duration evidence, while the replacement request starts in a passive effect.
 */
export function studioPreviewSnapshotMetadataForWorkspaceV1(
  state: StudioPreviewSnapshotMetadataStateV1,
  input: Readonly<{ provider: StudioPreviewSnapshotProviderV1 | null; workspaceKey: string | null }>,
): StudioPreviewSnapshotMetadataStateV1 {
  if (!input.provider || input.workspaceKey === null) return INACTIVE_METADATA;
  if (state.provider === input.provider && state.workspaceKey === input.workspaceKey) return state;
  return { phase: "loading", provider: input.provider, snapshot: null, workspaceKey: input.workspaceKey };
}

const INSTALLING_STATE: PreviewRendererHostStateV1 = { detail: null, phase: "fallback", reason: "installing" };

export function useStudioPreviewRenderer(input: UseStudioPreviewRendererInput): StudioPreviewRendererView | null {
  const {
    context,
    frame,
    proposedState,
    provider,
    retainedSourceDuration,
    sampleTime,
    sceneBoundaryActive,
    sourceEvents,
  } = input;
  const [bound, setBound] = useState<BoundHostStateV1 | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [metadata, setMetadata] = useState<StudioPreviewSnapshotMetadataStateV1>(INACTIVE_METADATA);
  const [compilation, setCompilation] = useState<StudioPreviewCompilationStateV1>(INACTIVE_COMPILATION);
  const [installation, setInstallation] = useState<StudioPreviewHostInstallationV1 | null>(null);
  const [viewport, setViewport] = useState<PreviewViewportV1 | null>(null);
  const latestProposedState = useRef(proposedState);
  latestProposedState.current = proposedState;
  const queuedScene = useRef<Readonly<{
    binding: StudioPreviewHostBinding;
    scene: CompiledStudioPreviewSceneV1;
  }> | null>(null);

  const eligibility = useMemo(() => evaluateStudioPreviewEligibility(detectStudioPreviewCapabilities()), []);

  // The Scene identity that owns the installed worker; the working revision
  // gates presentation instead of tearing the retained worker down. A project
  // switch always changes the key, even onto a Scene with an identical source
  // hash and name.
  const workspaceKey = context ? studioPreviewWorkspaceKeyV1(context) : null;
  const currentMetadata = studioPreviewSnapshotMetadataForWorkspaceV1(metadata, { provider, workspaceKey });
  const snapshot = currentMetadata.phase === "ready" ? currentMetadata.snapshot : null;
  const snapshotError = currentMetadata.phase === "failed" ? currentMetadata.error : null;
  const runtimeTraceEditCandidates = snapshot
    ? studioPreviewRuntimeTraceEditCandidates(snapshot, sampleTime, sourceEvents)
    : [];
  const runtimeTraceProgramValidation = snapshot
    ? studioPreviewRuntimeTraceProgramValidation(snapshot, proposedState?.programs ?? [], sourceEvents)
    : "not-applicable";

  useEffect(() => {
    const proposedState = latestProposedState.current;
    const workingRevision = context?.workingRevision;
    if (
      !snapshot ||
      !proposedState ||
      !workingRevision ||
      workspaceKey === null ||
      retainedSourceDuration === null ||
      Math.abs(retainedSourceDuration - snapshot.duration) >= 0.0005
    ) {
      setCompilation(INACTIVE_COMPILATION);
      return;
    }
    const controller = new AbortController();
    void compileStudioPreviewSceneV1({
      frame,
      proposedState,
      snapshot,
      workingRevision,
      workspaceKey,
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setCompilation(
          result.kind === "compiled"
            ? { phase: "ready", scene: result.scene }
            : { error: result.error, phase: "unsupported", workingRevision, workspaceKey },
        );
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setCompilation({
          error: error instanceof Error ? error.message : String(error),
          phase: "unsupported",
          workingRevision,
          workspaceKey,
        });
      },
    );
    return () => controller.abort();
  }, [context?.workingRevision, frame.height, frame.width, retainedSourceDuration, snapshot, workspaceKey]);

  const currentCompiledScene =
    compilation.phase === "ready" &&
    compilation.scene.snapshot === snapshot &&
    compilation.scene.workspaceKey === workspaceKey &&
    compilation.scene.workingRevision === context?.workingRevision &&
    compilation.scene.frame.height === frame.height &&
    compilation.scene.frame.width === frame.width
      ? compilation.scene
      : null;
  const compilationError =
    compilation.phase === "unsupported" &&
    compilation.workspaceKey === workspaceKey &&
    compilation.workingRevision === context?.workingRevision
      ? compilation.error
      : null;
  const interactionEntityIds = currentCompiledScene?.interactionEntityIds ?? [];

  useEffect(() => {
    if (!currentCompiledScene || !snapshot || workspaceKey === null) return;
    setInstallation((current) =>
      current?.snapshot === snapshot && current.workspaceKey === workspaceKey
        ? current
        : { scene: currentCompiledScene, snapshot, workspaceKey },
    );
  }, [currentCompiledScene, snapshot, workspaceKey]);
  const currentInstallation =
    installation?.snapshot === snapshot && installation.workspaceKey === workspaceKey ? installation : null;

  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => setCanvasEl(canvas), []);

  useEffect(() => {
    if (!provider || !context || workspaceKey === null) return;
    const controller = new AbortController();
    setMetadata({ phase: "loading", provider, snapshot: null, workspaceKey });
    loadStudioPreviewSnapshotMetadataV1({ context, provider, signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted && loaded) {
          setMetadata({ phase: "ready", provider, snapshot: loaded, workspaceKey });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setMetadata({
            error: error instanceof Error ? error.message : String(error),
            failureKind: studioPreviewSnapshotFailureKindV1(error),
            phase: "failed",
            provider,
            snapshot: null,
            workspaceKey,
          });
        }
      });
    return () => controller.abort();
    // Keyed by Scene identity, not the full context: the working revision must
    // not re-trigger loads, only gate presentation.
  }, [workspaceKey, provider]);

  // The engine rejects frames whose viewport aspect deviates from the camera,
  // so the measured box is snapped to the snapshot camera's exact aspect.
  const cameraAspect = snapshot
    ? snapshot.snapshot.scene.camera.view.frameWidth / snapshot.snapshot.scene.camera.view.frameHeight
    : null;

  useEffect(() => {
    if (!canvasEl || cameraAspect === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = canvasEl.getBoundingClientRect();
      setViewport(snapStudioPreviewViewport({ height: rect.height, width: rect.width }, cameraAspect));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvasEl);
    return () => {
      observer.disconnect();
      setViewport(null);
    };
  }, [cameraAspect, canvasEl]);

  // Frame evidence is never implicit: it requires a dev/test build AND a
  // provider that explicitly wires the dev client extension (the checked-in
  // fixture harness). A server provider stays extension-free.
  const evidenceAdapter = import.meta.env.DEV ? (provider?.evidence ?? null) : null;

  useEffect(() => {
    if (!eligibility.eligible || !provider || !snapshot || !canvasEl || !currentInstallation || workspaceKey === null)
      return;
    if (!claimStudioPreviewCanvasV1(canvasEl)) {
      setEpoch((current) => current + 1);
      return;
    }
    const binding: StudioPreviewHostBinding = { canvas: canvasEl, provider, snapshot, workspaceKey };
    const installedScene = currentInstallation.scene;
    const nextHost = new StudioPreviewRendererHost({
      createRenderer: () => createCanvasPreviewRendererV1(evidenceAdapter ? { evidence: evidenceAdapter } : {}),
      onStateChange: (state) => {
        setBound((current) => (current?.binding === binding ? { binding, host: nextHost, state } : current));
      },
    });
    queuedScene.current = { binding, scene: installedScene };
    setBound({ binding, host: nextHost, state: nextHost.state });
    void nextHost.install({
      assetPayloads: snapshot.assetPayloads,
      canvas: canvasEl,
      interactionEntityIds: installedScene.interactionEntityIds,
      revision: installedScene.engineRevisionHash,
      snapshot: installedScene.bundle,
    });
    return () => {
      // Cleanup invalidates the binding immediately: an old host's presented
      // state can never authorize paint on a remounted canvas or new snapshot.
      nextHost.dispose();
      if (queuedScene.current?.binding === binding) queuedScene.current = null;
      setBound((current) => (current?.binding === binding ? null : current));
      setEpoch((current) => current + 1);
    };
  }, [canvasEl, currentInstallation, eligibility.eligible, evidenceAdapter, provider, workspaceKey, snapshot]);

  const updateBinding = bound?.binding ?? null;
  const updateHost = bound?.host ?? null;
  const hostReadyForSceneUpdate = bound ? studioPreviewHostReadyForSceneUpdateV1(bound.state) : false;
  useEffect(() => {
    if (!updateBinding || !updateHost || !hostReadyForSceneUpdate || !currentCompiledScene) return;
    const queued = queuedScene.current;
    if (
      !queued ||
      queued.binding !== updateBinding ||
      queued.scene.engineRevisionHash === currentCompiledScene.engineRevisionHash
    )
      return;
    queuedScene.current = { binding: updateBinding, scene: currentCompiledScene };
    void updateHost
      .update({
        assetPayloads: currentCompiledScene.snapshot.assetPayloads,
        interactionEntityIds: currentCompiledScene.interactionEntityIds,
        revision: currentCompiledScene.engineRevisionHash,
        snapshot: currentCompiledScene.bundle,
      })
      .catch(() => undefined);
  }, [currentCompiledScene, hostReadyForSceneUpdate, updateBinding, updateHost]);

  const host = bound?.host ?? null;
  useEffect(() => {
    host?.requestFrame({ sampleTime, viewport });
  }, [host, sampleTime, viewport]);

  // Dev/test-only: expose the host-bound frame evidence channel so E2E can
  // prove the retained worker's own pixels. Requires the provider capability;
  // never present in production.
  useEffect(() => {
    if (!evidenceAdapter || !host) return;
    const scope = globalThis as Record<string, unknown>;
    scope.__poietraPreviewFrameEvidence = (samples: CaptureCanvasFrameEvidenceInputV1["samples"]) =>
      host.captureEvidence(samples);
    return () => {
      delete scope.__poietraPreviewFrameEvidence;
    };
  }, [evidenceAdapter, host]);

  // The host emission is only trusted when its binding matches this render's
  // exact canvas element, provider, snapshot, and workspace key.
  const bindingCurrent =
    bound !== null &&
    provider !== null &&
    snapshot !== null &&
    canvasEl !== null &&
    workspaceKey !== null &&
    studioPreviewHostBindingCurrent(bound.binding, { canvas: canvasEl, provider, snapshot, workspaceKey });

  // Every gate — transient edit, snapshot correlation, host binding, and exact
  // frame match against this render's own playhead and viewport — is applied
  // synchronously here, so the first paint after a scrub, resize, drag start,
  // canvas remount, or host teardown never trusts a stale presented emission.
  const verifiedSourceDuration = studioPreviewVerifiedSourceDurationV1(snapshot, context);
  const sourceDurationMismatch =
    retainedSourceDuration !== null &&
    verifiedSourceDuration !== null &&
    Math.abs(retainedSourceDuration - verifiedSourceDuration) >= 0.0005;
  const state = useMemo<PreviewRendererHostStateV1>(() => {
    if (sourceDurationMismatch) {
      return {
        detail: "The verified Scene timing changed after this editor session adopted its source basis.",
        phase: "fallback",
        reason: "snapshot-uncorrelated",
      };
    }
    if (compilationError) {
      return {
        detail: compilationError,
        phase: "fallback",
        reason: "scene-unsupported",
      };
    }
    return resolveStudioPreviewViewState({
      context,
      eligibility,
      hostActive: bindingCurrent,
      hostState: bound !== null && bindingCurrent ? bound.state : INSTALLING_STATE,
      sampleTime,
      snapshot,
      snapshotError,
      sceneBoundaryActive,
      viewport,
      workingScene: currentCompiledScene
        ? {
            engineRevisionHash: currentCompiledScene.engineRevisionHash,
            workingRevision: currentCompiledScene.workingRevision,
          }
        : null,
    });
  }, [
    bindingCurrent,
    bound,
    compilationError,
    context,
    currentCompiledScene,
    eligibility,
    sampleTime,
    snapshot,
    snapshotError,
    sourceDurationMismatch,
    sceneBoundaryActive,
    viewport,
  ]);

  // Geometry comes from the exact prepared vertices of this correlated frame.
  // Non-present or unavailable entries do not mint interaction targets.
  const interactionGeometry = useMemo(
    () =>
      state.phase === "presented"
        ? projectStudioPreviewInteractionGeometry(interactionEntityIds, state.frame.interaction, frame)
        : null,
    [frame, interactionEntityIds, state],
  );
  if (!provider) return null;
  const interactionAuthority = studioPreviewInteractionAuthority(snapshot, sampleTime, sourceEvents);
  const runtimeTraceOpaqueSelectionEntities = projectStudioPreviewRuntimeTraceOpaqueSelectionEntities({
    interactionGeometry,
    sourceRuntimeIdentity: snapshot?.sourceRuntimeIdentity ?? null,
    studioSceneId: context ? `${context.sourcePath}#${context.sceneName}` : null,
  });
  return {
    attachCanvas,
    cameraCenter: snapshot ? { ...snapshot.snapshot.scene.camera.view.center } : null,
    epoch,
    interactionGeometry,
    interactionAuthority,
    runtimeTraceEditCandidates,
    runtimeTraceOpaqueSelectionEntities,
    sourceLabel: snapshot?.sourceLabel ?? null,
    sourceMetadataFailureKind: currentMetadata.phase === "failed" ? currentMetadata.failureKind : null,
    sourceMetadataPhase: currentMetadata.phase,
    sourceRuntimeIdentity: snapshot?.sourceRuntimeIdentity ?? null,
    state,
    runtimeTraceEditAnchor: studioPreviewPresentedRuntimeTraceEditAnchor(
      snapshot,
      state,
      interactionAuthority,
      sourceEvents,
    ),
    runtimeTraceProgramValidation,
    verifiedSourceDuration,
  };
}
