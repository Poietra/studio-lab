import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasPngAssetTransferV1 } from "../engine/canvas-png-assets";
import { CanvasWorkerClientError, type CaptureCanvasFrameEvidenceInputV1 } from "../engine/canvas-worker-client";
import { MAX_CANVAS_INTERACTION_ENTITY_IDS } from "../engine/canvas-worker-protocol";
import type { SceneIrBundleV1 } from "../engine/contracts";
import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";
import {
  EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
  type FragmentMaterialRegistryV1,
} from "../engine/fragment-material-registry";
import {
  compileMathTexOutlineV1,
  compileTextOutlineV1,
  type MathTexOutlineArtifactV1,
  type MathTexOutlineCompilerV1,
  type MathTexOutlineResponseV1,
  mathTexOutlineResponseV1Schema,
  type TextOutlineArtifactV1,
  type TextOutlineCompilerV1,
  textOutlineResponseV1Schema,
} from "../engine/mathtex-outline";
import {
  createCanvasPreviewRendererV1,
  type PreviewRendererHostStateV1,
  type PreviewViewportV1,
  StudioPreviewRendererHost,
} from "../engine/preview-renderer";
import { sourceIdentityV1Schema } from "../engine/primitives";
import {
  type ApplyStaticPrimitiveTransformCompiler,
  type ApplyStaticRootTransformEditCompiler,
  type ApplyStaticRootTransformEditWireCommandV1,
  type ApplyStudioBoundEntityEditCompiler,
  type ApplyStudioCreationEditCompiler,
  type ApplyStudioCreationEditWireCommandV1,
  type ApplyStudioFragmentMaterialsCompiler,
  type ApplyStudioMathTexTransformEditCompiler,
  type ApplyStudioMathTexTransformEditWireCommandV1,
  type ApplyStudioMotionEditCompiler,
  type ApplyStudioTimelineEditCompiler,
  type ApplyStudioTimelineEditWireCommandV1,
  compileApplyStaticRootTransformEdit,
  compileApplyStaticPrimitiveTransform,
  compileApplyStudioCreationEdit,
  compileApplyStudioFragmentMaterials,
  compileApplyStudioMathTexTransformEdit,
  compileApplyStudioMotionEdit,
  compileApplyStudioTimelineEdit,
  type ProjectStudioMotionCompiler,
  type ProjectStudioTimelineCompiler,
  projectStudioMotion,
  projectStudioTimeline,
  type StudioBoundEntityProjectionV1,
  type StudioCreationProjectionV1,
  type StudioMathTexTransformProjectionV1,
  type StudioMotionProjectionV1,
  type StudioPersistentRemoveProjectionV1,
  type StudioStaticRootProjectionV1,
  type StudioTimelineProjectionV1,
} from "../engine/scene-authoring";
import type { StaticPrimitiveTransformSourceFactV1 } from "../render-pipeline/contracts";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import {
  EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1,
  type SceneFragmentMaterialStateV1,
} from "./fragment-material-authoring";
import type {
  ProgramRecord,
  ProjectedEntity,
  RuntimeSceneState,
  StudioEditProjectionAuthority,
  WorkingState,
} from "./model";
import {
  hasImportedRootTransformTarget,
  isExactStaticRootTransformProgramBatch,
  isExactStudioMathTexContentProgramBatch,
  isSceneDurationOperation,
} from "./operations";
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
} from "./preview-temporal-rebase";
import {
  buildStaticRootTransformEditCommand,
  buildStudioCreationEditCommand,
  buildStudioMathTexTransformEditCommand,
  buildStudioMotionEditCommand,
  buildStudioMotionProjectionCommand,
  isExactStudioMathTexTransformProgramBatch,
  isExactStudioMotionProgramBatch,
  staticRootTransformStudioEntities,
  studioCreationMathTexParts,
  studioCreationTextContent,
  studioMathTexTransformStudioEntities,
  studioMotionProjectionBatchKind,
  studioMotionStudioEntities,
} from "./scene-authoring-wire";
import { STUDIO_VIEWPORT } from "./studio-viewport-geometry";
import { normalizeTimelineProjectionCommand } from "./timeline-projection";
import {
  selectBoundEntityProjection,
  selectCreationProjection,
  selectMathTexTransformProjection,
  selectMotionProjection,
  selectStaticRootProjection,
} from "./workspace-projection";

export type StudioPreviewRendererView = Readonly<{
  attachCanvas: (canvas: HTMLCanvasElement | null) => void;
  /** Renders the exact currently presented Scene through the retained Rust/WGPU worker. */
  generateThumbnail: (signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
  /** Exact Rust-admitted Scene currently presented by the retained renderer. */
  canonicalScene: Readonly<{
    assetPayloads: readonly CanvasPngAssetTransferV1[];
    bundle: SceneIrBundleV1;
    fragmentMaterialRegistry: FragmentMaterialRegistryV1;
    sourceLineage: Readonly<{
      projectId: string;
      sceneId: string;
      sceneName: string;
      sourceHash: string;
      sourcePath: string;
      workingRevision: string;
    }>;
  }> | null;
  /** Verified world-space center used to project Studio viewport positions. */
  cameraCenter: Readonly<{ x: number; y: number }> | null;
  epoch: number;
  /**
   * Hit-target geometry derived from that frame's prepared GPU vertices,
   * keyed by verified runtime entity ID; non-null only while correlated.
   */
  interactionGeometry: StudioPreviewInteractionGeometry | null;
  interactionAuthority: StudioPreviewInteractionAuthority;
  /** Rust-authorized complete view facts for a Studio-created entity history. */
  creationProjection: StudioCreationProjectionV1 | null;
  /** Rust-authorized read-model facts for one source-bound endpoint edit. */
  boundEntityProjection: StudioBoundEntityProjectionV1 | null;
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
  /** Rust-authorized lifetime and fade facts for persistent remove operations. */
  persistentRemoveProjection: StudioPersistentRemoveProjectionV1 | null;
  /** Rust-authorized Bezier and timing facts for CreateMotion operations. */
  motionProjection: StudioMotionProjectionV1 | null;
  /** Rust-authorized entity, lifetime, and channel facts for an exact MathTex transform batch. */
  mathTexTransformProjection: StudioMathTexTransformProjectionV1 | null;
  /** Rust-authorized Studio channel facts for an exact imported static-root transform batch. */
  staticRootProjection: StudioStaticRootProjectionV1 | null;
  /** Rust-authorized source-to-working timeline projection for timeline-only edits. */
  timelineProjection: StudioTimelineProjectionV1 | null;
  /** Rust compiler path that admitted the exact current Program revision. */
  editAuthority: StudioPreviewEditAuthority | null;
  /** Preview-only endpoint authority; source lowering still verifies the exact boundary. */
  runtimeTraceEditAnchor: number | null;
  /** Validation bound to the staged Program and snapshot, independent of the playhead. */
  runtimeTraceProgramValidation: StudioPreviewRuntimeTraceProgramValidation;
  /** Verified fast-manim base duration for the current source identity. */
  verifiedSourceDuration: number | null;
}>;

export type StudioPreviewEditAuthority = StudioEditProjectionAuthority;

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
      reason: "runtime-trace-preview-only" | "source-edit-unsupported";
      verifiedRuntimeEntityIds: readonly string[];
    }>
  | Readonly<{
      kind: "selection-only";
      reason: "source-edit-anchor-unavailable";
    }>
  | Readonly<{
      kind: "display-only";
      reason: "source-runtime-identity-unverified";
    }>;

export type UseStudioPreviewRendererInput = Readonly<{
  context: StudioPreviewEditingContextV1 | null;
  frame: Readonly<{ height: number; width: number }>;
  provider: StudioPreviewSnapshotProviderV1 | null;
  sceneFragmentMaterials?: SceneFragmentMaterialStateV1;
  retainedSourceDuration: number | null;
  sampleTime: number;
  sceneBoundaryActive: boolean;
  sourceEvents: RuntimeSceneState["eventTrack"]["events"];
  staticPrimitiveTransforms: readonly StaticPrimitiveTransformSourceFactV1[];
  workingState: WorkingState | null;
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

/** Invalidates presentation/export synchronously while a changed material input recompiles. */
export function correlateStudioPreviewFragmentMaterialInputV1<
  T extends Readonly<{ fragmentMaterialInput?: SceneFragmentMaterialStateV1 }>,
>(scene: T | null, currentInput: SceneFragmentMaterialStateV1): T | null {
  return scene?.fragmentMaterialInput === currentInput ? scene : null;
}

type BoundHostStateV1 = Readonly<{
  binding: StudioPreviewHostBinding;
  host: StudioPreviewRendererHost;
  state: PreviewRendererHostStateV1;
}>;

type CompiledStudioPreviewSceneV1 = Readonly<{
  boundEntityProjection?: StudioBoundEntityProjectionV1;
  bundle: StudioVerifiedPreviewSnapshotV1["snapshot"];
  creationProjection?: StudioCreationProjectionV1;
  engineRevisionHash: string;
  frame: Readonly<{ height: number; width: number }>;
  fragmentMaterialInput?: SceneFragmentMaterialStateV1;
  fragmentMaterialRegistry?: FragmentMaterialRegistryV1;
  interactionEntityIds: readonly string[];
  mathTexTransformProjection?: StudioMathTexTransformProjectionV1;
  motionProjection?: StudioMotionProjectionV1;
  persistentRemoveProjection?: StudioPersistentRemoveProjectionV1;
  editAuthority?: StudioPreviewEditAuthority;
  snapshot: StudioVerifiedPreviewSnapshotV1;
  staticRootProjection?: StudioStaticRootProjectionV1;
  timelineProjection?: StudioTimelineProjectionV1;
  workingRevision: string;
  workspaceKey: string;
}>;

type StudioPreviewCompilationStateV1 =
  | Readonly<{ phase: "inactive" }>
  | Readonly<{
      error: string;
      fragmentMaterialInput: SceneFragmentMaterialStateV1;
      phase: "unsupported";
      workingRevision: string;
      workspaceKey: string;
    }>
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
    const candidates = studioPreviewRuntimeTraceEditCandidates(snapshot, sourceAnchor, sourceEvents);
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
  const identity = snapshot.sourceRuntimeIdentity;
  if (identity?.size === 0 && snapshot.snapshot.scene.entities.length === 0) {
    return { kind: "interactive" };
  }
  if (!identity || identity.size === 0) {
    return { kind: "display-only", reason: "source-runtime-identity-unverified" };
  }
  const entityById = new Map(snapshot.snapshot.scene.entities.map((entity) => [entity.id, entity] as const));
  if (snapshot.snapshot.scene.animationChannels.length > 0) {
    const verifiedRuntimeEntityIds = [...identity.values()].flatMap(({ entityId }) => {
      const entity = entityById.get(entityId);
      return entity && (entity.geometry.kind !== "group" || entity.parentId !== null) ? [entityId] : [];
    });
    return {
      kind: "selection-only",
      reason: "source-edit-unsupported",
      verifiedRuntimeEntityIds,
    };
  }
  const hasOnlyEditableRoots = [...identity.values()].every(({ entityId }) => {
    const entity = entityById.get(entityId);
    return entity?.parentId === null && entity.geometry.kind !== "group";
  });
  return hasOnlyEditableRoots
    ? { kind: "interactive" }
    : { kind: "selection-only", reason: "source-edit-anchor-unavailable" };
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
  const verifiedSelection =
    runtimeTraceSelection || (authority.kind === "selection-only" && authority.reason === "source-edit-unsupported");
  const verifiedRuntimeEntityIds = new Set(verifiedSelection ? authority.verifiedRuntimeEntityIds : []);
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
    if (verifiedSelection && !verifiedRuntimeEntityIds.has(mapping.entityId)) continue;
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
    textOutlines?: Readonly<Record<string, TextOutlineArtifactV1>>;
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
  // `workingRevision` canonically contains the raw Programs. The digest must
  // not include TypeScript's evaluated Scene mirror because Rust derives the
  // compiled Scene from those Programs.
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
    Object.entries(input.textOutlines ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entityId, outline]) => [entityId, outline.bounds, outline.fillRule, outline.path]),
  ];
  const bytes = new TextEncoder().encode(canonicalJsonV1(revisionBasis));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceEditRecords(workingState: WorkingState): readonly ProgramRecord[] {
  return [...workingState.appliedEdits, ...workingState.stagedEdits];
}

function staticRootTransformEditCommand(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    workingState: WorkingState;
  }>,
  nextRevision: string,
  mathTexOutlines: ApplyStaticRootTransformEditWireCommandV1["mathTexOutlines"] = [],
): ApplyStaticRootTransformEditWireCommandV1 {
  return buildStaticRootTransformEditCommand({
    expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
    frame: input.frame,
    mathTexOutlines,
    nextRevision,
    programs: sourceEditRecords(input.workingState).map(({ program }) => program),
    sourceRuntimeBindings: [...(input.snapshot.sourceRuntimeIdentity?.entries() ?? [])].map(
      ([sourceIdentityKey, { entityId, sourceName }]) => ({
        runtimeEntityId: entityId,
        sourceIdentityKey,
        sourceName,
      }),
    ),
    studioEntities: staticRootTransformStudioEntities(input.workingState.runtimeSceneState),
    viewport: STUDIO_VIEWPORT,
  });
}

function staticImportedSourceIsExact(
  input: Readonly<{ snapshot: StudioVerifiedPreviewSnapshotV1; workingState: WorkingState }>,
) {
  const scene = input.snapshot.snapshot.scene;
  return scene.source.kind === "imported-manim-server-snapshot" && importedWorkingSourceIsExact(input);
}

function importedWorkingSourceIsExact(
  input: Readonly<{ snapshot: StudioVerifiedPreviewSnapshotV1; workingState: WorkingState }>,
) {
  const correlation = input.snapshot.correlation;
  const base = input.workingState;
  return (
    importedSnapshotCorrelationIsExact(input.snapshot, true) &&
    base.runtimeSceneState.sceneId === base.editorContext.activeSceneId &&
    base.runtimeSceneState.sceneId === `${correlation.context.sourcePath}#${correlation.context.sceneName}` &&
    base.sourceSnapshot.sourceId === correlation.context.sourcePath &&
    base.sourceSnapshot.hash === `sha256:${correlation.context.sourceHash}`
  );
}

function studioMotionEditCommand(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    workingState: WorkingState;
  }>,
  nextRevision: string,
) {
  return buildStudioMotionEditCommand({
    expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
    frame: input.frame,
    nextRevision,
    programs: sourceEditRecords(input.workingState).map(({ program }) => program),
    sourceRuntimeBindings: [...(input.snapshot.sourceRuntimeIdentity?.entries() ?? [])].map(
      ([sourceIdentityKey, { entityId, sourceName }]) => ({
        runtimeEntityId: entityId,
        sourceIdentityKey,
        sourceName,
      }),
    ),
    studioEntities: studioMotionStudioEntities(input.workingState.runtimeSceneState),
    viewport: STUDIO_VIEWPORT,
  });
}

function studioTimelineCommands(
  input: Readonly<{ snapshot: StudioVerifiedPreviewSnapshotV1; workingState: WorkingState }>,
  nextRevision: string,
): Readonly<{
  apply: ApplyStudioTimelineEditWireCommandV1;
  projection: Parameters<ProjectStudioTimelineCompiler>[0];
}> {
  const projection = normalizeTimelineProjectionCommand(
    input.workingState.runtimeSceneState.duration,
    sourceEditRecords(input.workingState).map(({ program }) => program),
  );
  return {
    apply: {
      expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
      nextRevision,
      programs: projection.programs,
      schema: "poietra.apply-studio-timeline-edit",
      version: 1,
    },
    projection,
  };
}

async function compileStudioPreviewSceneWithoutFragmentMaterialsV1(
  input: Readonly<{
    applyStaticPrimitiveTransformCompiler?: ApplyStaticPrimitiveTransformCompiler;
    applyStaticRootTransformEditCompiler?: ApplyStaticRootTransformEditCompiler;
    applyStudioBoundEntityEditCompiler?: ApplyStudioBoundEntityEditCompiler;
    applyStudioCreationEditCompiler?: ApplyStudioCreationEditCompiler;
    applyStudioMathTexTransformEditCompiler?: ApplyStudioMathTexTransformEditCompiler;
    applyStudioMotionEditCompiler?: ApplyStudioMotionEditCompiler;
    applyStudioTimelineEditCompiler?: ApplyStudioTimelineEditCompiler;
    frame: Readonly<{ height: number; width: number }>;
    mathTexOutlineCompiler?: MathTexOutlineCompilerV1;
    projectStudioMotionCompiler?: ProjectStudioMotionCompiler;
    projectStudioTimelineCompiler?: ProjectStudioTimelineCompiler;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    staticPrimitiveTransforms?: readonly StaticPrimitiveTransformSourceFactV1[];
    textOutlineCompiler?: TextOutlineCompilerV1;
    workingState: WorkingState;
    workingRevision: string;
    workspaceKey: string;
  }>,
): Promise<
  Readonly<{ error: string; kind: "unsupported" }> | Readonly<{ kind: "compiled"; scene: CompiledStudioPreviewSceneV1 }>
> {
  const sourceEdits = sourceEditRecords(input.workingState);
  const staticPrimitiveTransforms = input.staticPrimitiveTransforms ?? [];
  if (Math.abs(input.workingState.runtimeSceneState.duration - input.snapshot.duration) >= 0.0005) {
    return {
      error: "Studio source state is not correlated with the verified imported Scene timing.",
      kind: "unsupported",
    };
  }
  if (input.workingRevision === PRISTINE_WORKING_REVISION && sourceEdits.length > 0) {
    return { error: "A pristine Studio revision cannot contain evaluated edit Programs.", kind: "unsupported" };
  }
  if (sourceEdits.length === 0) {
    const { correlation, snapshot } = input.snapshot;
    if (!importedSnapshotCorrelationIsExact(input.snapshot, true)) {
      return { error: "The base verified preview has inconsistent revision evidence.", kind: "unsupported" };
    }
    if (staticPrimitiveTransforms.length === 1) {
      if (snapshot.scene.source.kind !== "imported-manim-server-snapshot") {
        return {
          error: "Static primitive Transform compilation requires one server-verified static Scene snapshot.",
          kind: "unsupported",
        };
      }
      const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
        frame: input.frame,
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      });
      try {
        const bundle = await (input.applyStaticPrimitiveTransformCompiler ?? compileApplyStaticPrimitiveTransform)(
          snapshot,
          {
            expectedBaseRevision: correlation.engineRevisionHash,
            nextRevision: engineRevisionHash,
            schema: "poietra.apply-static-primitive-transform",
            sourceRuntimeBindings: [...(input.snapshot.sourceRuntimeIdentity?.entries() ?? [])].map(
              ([sourceIdentityKey, { entityId, sourceName }]) => ({
                runtimeEntityId: entityId,
                sourceIdentityKey,
                sourceName,
              }),
            ),
            transform: staticPrimitiveTransforms[0],
            version: 1,
          },
        );
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
                input.workingState.runtimeSceneState.eventTrack.events,
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
          error: `Rust core rejected the static primitive Transform: ${
            error instanceof Error ? error.message : String(error)
          }`,
          kind: "unsupported",
        };
      }
    }
    return {
      kind: "compiled",
      scene: {
        bundle: snapshot,
        engineRevisionHash: correlation.engineRevisionHash,
        frame: { ...input.frame },
        interactionEntityIds: studioPreviewInteractionEntityIdsV1(
          input.snapshot.sourceRuntimeIdentity,
          studioPreviewInteractionAuthority(input.snapshot, 0, input.workingState.runtimeSceneState.eventTrack.events),
          snapshot.scene.entities,
        ),
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      },
    };
  }
  if (staticPrimitiveTransforms.length > 0) {
    return {
      error: "Editing a statically compiled primitive Transform requires canonical base/edit composition support.",
      kind: "unsupported",
    };
  }
  const sourceProgramBatch = sourceEdits.map(({ program }) => program);
  const importedSource = input.snapshot.snapshot.scene.source;
  if (
    input.snapshot.snapshot.scene.animationChannels.length > 0 &&
    importedSource.kind !== "imported-manim-runtime-trace"
  ) {
    return {
      error: "Editing an imported animation requires generic Runtime Trace authoring support.",
      kind: "unsupported",
    };
  }
  const hasStudioCreation = sourceEdits.some(({ program }) =>
    program.operations.some(({ kind }) => kind === "CreateEntity"),
  );
  if (hasStudioCreation) {
    if (!importedSnapshotCorrelationIsExact(input.snapshot, true)) {
      return { error: "Studio creation requires an exactly correlated base snapshot.", kind: "unsupported" };
    }
    const mathTexOutlineInputs: Array<Readonly<{ entityId: string; texParts: readonly string[] }>> = [];
    const textOutlineInputs: Array<Readonly<{ entityId: string; text: string }>> = [];
    for (const { program } of sourceEdits) {
      for (const operation of program.operations) {
        if (operation.kind !== "CreateEntity") continue;
        if (operation.entity.type === "MathTex") {
          const texParts = studioCreationMathTexParts(operation.entity.content);
          if (texParts) mathTexOutlineInputs.push({ entityId: operation.entity.id, texParts });
        } else if (operation.entity.type === "Text") {
          const text = studioCreationTextContent(operation.entity.content);
          if (!text) {
            return {
              error: `Text entity ${operation.entity.id} must contain one printable ASCII line of at most 256 characters.`,
              kind: "unsupported",
            };
          }
          textOutlineInputs.push({ entityId: operation.entity.id, text });
        }
      }
    }
    const mathTexOutlines: ApplyStudioCreationEditWireCommandV1["mathTexOutlines"][number][] = [];
    const mathTexOutlineDigestMap: Record<string, MathTexOutlineArtifactV1> = {};
    try {
      const compiler = input.mathTexOutlineCompiler ?? compileMathTexOutlineV1;
      const responses = await Promise.all(
        mathTexOutlineInputs.map(async ({ entityId, texParts }) => ({
          entityId,
          response: mathTexOutlineResponseV1Schema.parse(await compiler(texParts)),
          texParts,
        })),
      );
      for (const { entityId, response, texParts } of responses) {
        if (response.result.kind === "unsupported") {
          return {
            error: `MathTex entity ${entityId} is unsupported (${response.result.code}): ${response.result.message}`,
            kind: "unsupported",
          };
        }
        mathTexOutlines.push({ entityId, path: response.result.path, texParts });
        mathTexOutlineDigestMap[entityId] = response.result;
      }
    } catch (error) {
      return {
        error: `MathTex outline compilation failed: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
    const textOutlines: ApplyStudioCreationEditWireCommandV1["textOutlines"][number][] = [];
    const textOutlineDigestMap: Record<string, TextOutlineArtifactV1> = {};
    try {
      const compiler = input.textOutlineCompiler ?? compileTextOutlineV1;
      const responses = await Promise.all(
        textOutlineInputs.map(async ({ entityId, text }) => ({
          entityId,
          response: textOutlineResponseV1Schema.parse(await compiler(text)),
          text,
        })),
      );
      for (const { entityId, response, text } of responses) {
        if (response.result.kind === "unsupported") {
          return {
            error: `Text entity ${entityId} is unsupported (${response.result.code}): ${response.result.message}`,
            kind: "unsupported",
          };
        }
        textOutlines.push({ entityId, path: response.result.path, text });
        textOutlineDigestMap[entityId] = response.result;
      }
    } catch (error) {
      return {
        error: `Text outline compilation failed: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      mathTexOutlines: mathTexOutlineDigestMap,
      snapshot: input.snapshot,
      textOutlines: textOutlineDigestMap,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    const command = buildStudioCreationEditCommand({
      expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
      frame: input.frame,
      mathTexOutlines,
      nextRevision: engineRevisionHash,
      programs: sourceEdits.map(({ program }) => program),
      textOutlines,
      viewport: STUDIO_VIEWPORT,
    });
    try {
      const result = await (input.applyStudioCreationEditCompiler ?? compileApplyStudioCreationEdit)(
        input.snapshot.snapshot,
        command,
      );
      let creationProjection: StudioCreationProjectionV1 | null;
      try {
        creationProjection = selectCreationProjection(
          input.snapshot.snapshot.scene.duration,
          sourceProgramBatch,
          result.creationProjection ?? null,
        );
      } catch {
        return { error: "Rust core returned an uncorrelated Studio creation projection.", kind: "unsupported" };
      }
      if (!creationProjection) {
        return { error: "Rust core did not return the Studio creation projection.", kind: "unsupported" };
      }
      const bundle = result.bundle;
      const baseEntityIds = new Set(input.snapshot.snapshot.scene.entities.map(({ id }) => id));
      const createdEntityIds = bundle.scene.entities.flatMap(({ id }) => (baseEntityIds.has(id) ? [] : [id]));
      const interactionEntityIds = studioPreviewInteractionEntityIdsV1(
        input.snapshot.sourceRuntimeIdentity,
        studioPreviewInteractionAuthority(input.snapshot, 0, input.workingState.runtimeSceneState.eventTrack.events),
        bundle.scene.entities,
      );
      for (const entityId of createdEntityIds) {
        if (
          !interactionEntityIds.includes(entityId) &&
          interactionEntityIds.length < MAX_CANVAS_INTERACTION_ENTITY_IDS
        ) {
          interactionEntityIds.push(entityId);
        }
      }
      return {
        kind: "compiled",
        scene: {
          bundle,
          creationProjection,
          engineRevisionHash,
          frame: { ...input.frame },
          interactionEntityIds,
          editAuthority: "rust-authorized-batch",
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
  const exactStaticRootBatch = isExactStaticRootTransformProgramBatch(sourceProgramBatch);
  if (
    importedSource.kind === "imported-manim-server-snapshot" &&
    isExactStudioMathTexContentProgramBatch(sourceProgramBatch)
  ) {
    if (!staticImportedSourceIsExact(input)) {
      return {
        error: "MathTex content editing requires one exactly correlated static Scene snapshot.",
        kind: "unsupported",
      };
    }
    const operation = sourceProgramBatch[0]?.operations[0];
    if (operation?.kind !== "SetProperty" || operation.key !== "content") {
      return { error: "MathTex content editing requires canonical non-empty TeX parts.", kind: "unsupported" };
    }
    const texParts = studioCreationMathTexParts(operation.value);
    if (!texParts) {
      return { error: "MathTex content editing requires canonical non-empty TeX parts.", kind: "unsupported" };
    }
    let outlineResponse: MathTexOutlineResponseV1;
    try {
      outlineResponse = mathTexOutlineResponseV1Schema.parse(
        await (input.mathTexOutlineCompiler ?? compileMathTexOutlineV1)(texParts),
      );
    } catch (error) {
      return {
        error: `MathTex content outline compilation failed: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
    if (outlineResponse.result.kind === "unsupported") {
      return {
        error: `MathTex content is unsupported (${outlineResponse.result.code}): ${outlineResponse.result.message}`,
        kind: "unsupported",
      };
    }
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      mathTexOutlines: { [operation.entityId]: outlineResponse.result },
      snapshot: input.snapshot,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    const mathTexOutlines: ApplyStaticRootTransformEditWireCommandV1["mathTexOutlines"] = [
      { entityId: operation.entityId, path: outlineResponse.result.path, texParts },
    ];
    const command = staticRootTransformEditCommand(input, engineRevisionHash, mathTexOutlines);
    try {
      const result = await (input.applyStaticRootTransformEditCompiler ?? compileApplyStaticRootTransformEdit)(
        input.snapshot.snapshot,
        command,
      );
      let staticRootProjection: StudioStaticRootProjectionV1 | null;
      try {
        staticRootProjection = selectStaticRootProjection(sourceProgramBatch, result.staticRootProjection ?? null);
      } catch {
        return { error: "Rust core returned an uncorrelated MathTex content projection.", kind: "unsupported" };
      }
      const projectedMutation = staticRootProjection?.mutations[0];
      if (
        !staticRootProjection ||
        staticRootProjection.mutations.length !== 1 ||
        projectedMutation?.kind !== "math-tex-content" ||
        projectedMutation.entityId !== operation.entityId
      ) {
        return { error: "Rust core did not return the exact MathTex content projection.", kind: "unsupported" };
      }
      const bundle = result.bundle;
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
              input.workingState.runtimeSceneState.eventTrack.events,
            ),
            bundle.scene.entities,
          ),
          persistentRemoveProjection: result.persistentRemoveProjection,
          editAuthority: "static-imported-root",
          snapshot: input.snapshot,
          staticRootProjection,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected the MathTex content edit: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
  }
  if (
    importedSource.kind === "imported-manim-server-snapshot" &&
    isExactStudioMathTexTransformProgramBatch(sourceProgramBatch)
  ) {
    if (!staticImportedSourceIsExact(input)) {
      return {
        error: "MathTex content transform requires one exactly correlated static Scene snapshot.",
        kind: "unsupported",
      };
    }
    const outlineInputs = sourceProgramBatch.flatMap((program) =>
      program.operations.flatMap((operation) => {
        if (operation.kind !== "TransformContent") return [];
        const texParts = studioCreationMathTexParts(operation.replacement);
        return texParts ? [{ entityId: operation.targetEntityId, texParts }] : [];
      }),
    );
    const mathTexOutlines: ApplyStudioMathTexTransformEditWireCommandV1["mathTexOutlines"][number][] = [];
    const mathTexOutlineDigestMap: Record<string, MathTexOutlineArtifactV1> = {};
    try {
      const compiler = input.mathTexOutlineCompiler ?? compileMathTexOutlineV1;
      const responses = await Promise.all(
        outlineInputs.map(async ({ entityId, texParts }) => ({
          entityId,
          response: mathTexOutlineResponseV1Schema.parse(await compiler(texParts)),
          texParts,
        })),
      );
      for (const { entityId, response, texParts } of responses) {
        if (response.result.kind === "unsupported") {
          return {
            error: `MathTex transform target ${entityId} is unsupported (${response.result.code}): ${response.result.message}`,
            kind: "unsupported",
          };
        }
        mathTexOutlines.push({ entityId, path: response.result.path, texParts });
        mathTexOutlineDigestMap[entityId] = response.result;
      }
    } catch (error) {
      return {
        error: `MathTex transform outline compilation failed: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      mathTexOutlines: mathTexOutlineDigestMap,
      snapshot: input.snapshot,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    const command = buildStudioMathTexTransformEditCommand({
      expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
      frame: input.frame,
      mathTexOutlines,
      nextRevision: engineRevisionHash,
      programs: sourceProgramBatch,
      sourceRuntimeBindings: [...(input.snapshot.sourceRuntimeIdentity?.entries() ?? [])].map(
        ([sourceIdentityKey, { entityId, sourceName }]) => ({
          runtimeEntityId: entityId,
          sourceIdentityKey,
          sourceName,
        }),
      ),
      studioEntities: studioMathTexTransformStudioEntities(input.workingState.runtimeSceneState),
      viewport: STUDIO_VIEWPORT,
    });
    try {
      const result = await (input.applyStudioMathTexTransformEditCompiler ?? compileApplyStudioMathTexTransformEdit)(
        input.snapshot.snapshot,
        command,
      );
      if (!result.mathTexTransformProjection) {
        return { error: "Rust core did not return the complete MathTex transform projection.", kind: "unsupported" };
      }
      let mathTexTransformProjection: StudioMathTexTransformProjectionV1 | null;
      try {
        mathTexTransformProjection = selectMathTexTransformProjection(
          input.snapshot.snapshot.scene.duration,
          sourceProgramBatch,
          result.mathTexTransformProjection,
        );
      } catch {
        return { error: "Rust core returned an uncorrelated MathTex transform projection.", kind: "unsupported" };
      }
      if (!mathTexTransformProjection) {
        return { error: "Rust core did not return the complete MathTex transform projection.", kind: "unsupported" };
      }
      const bundle = result.bundle;
      const baseEntityIds = new Set(input.snapshot.snapshot.scene.entities.map(({ id }) => id));
      const createdEntityIds = bundle.scene.entities.flatMap(({ id }) => (baseEntityIds.has(id) ? [] : [id]));
      const interactionEntityIds = studioPreviewInteractionEntityIdsV1(
        input.snapshot.sourceRuntimeIdentity,
        studioPreviewInteractionAuthority(input.snapshot, 0, input.workingState.runtimeSceneState.eventTrack.events),
        bundle.scene.entities,
      );
      for (const entityId of createdEntityIds) {
        if (
          !interactionEntityIds.includes(entityId) &&
          interactionEntityIds.length < MAX_CANVAS_INTERACTION_ENTITY_IDS
        ) {
          interactionEntityIds.push(entityId);
        }
      }
      return {
        kind: "compiled",
        scene: {
          bundle,
          engineRevisionHash,
          frame: { ...input.frame },
          interactionEntityIds,
          mathTexTransformProjection,
          ...(mathTexTransformProjection.motions.length > 0
            ? {
                motionProjection: {
                  insertions: mathTexTransformProjection.insertions,
                  motions: mathTexTransformProjection.motions,
                  projectedDuration: mathTexTransformProjection.projectedDuration,
                },
              }
            : {}),
          editAuthority: "rust-authorized-batch",
          snapshot: input.snapshot,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected the MathTex content transform: ${
          error instanceof Error ? error.message : String(error)
        }`,
        kind: "unsupported",
      };
    }
  }
  if (sourceProgramBatch.some((program) => program.operations.some(({ kind }) => kind === "TransformContent"))) {
    return {
      error: "TransformContent requires one closed Rust MathTex transform batch.",
      kind: "unsupported",
    };
  }
  const hasPersistentRemove = sourceEdits.some(({ program }) =>
    program.operations.some(
      (operation) => operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent,
    ),
  );
  if (hasPersistentRemove) {
    if (!staticImportedSourceIsExact(input)) {
      return {
        error: "Persistent remove requires one exactly correlated static Scene snapshot.",
        kind: "unsupported",
      };
    }
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    try {
      const result = await (input.applyStaticRootTransformEditCompiler ?? compileApplyStaticRootTransformEdit)(
        input.snapshot.snapshot,
        staticRootTransformEditCommand(input, engineRevisionHash),
      );
      const hasStaticRootTransform = hasImportedRootTransformTarget(sourceProgramBatch);
      let staticRootProjection: StudioStaticRootProjectionV1 | null = null;
      if (hasStaticRootTransform) {
        try {
          staticRootProjection = selectStaticRootProjection(sourceProgramBatch, result.staticRootProjection ?? null);
        } catch {
          return { error: "Rust core returned an uncorrelated persistent-remove transform.", kind: "unsupported" };
        }
        if (!staticRootProjection) {
          return { error: "Rust core did not return the persistent-remove transform projection.", kind: "unsupported" };
        }
      }
      const hasMotion = sourceProgramBatch.some((program) =>
        program.operations.some(({ kind }) => kind === "CreateMotion"),
      );
      let motionProjection: StudioMotionProjectionV1 | null = null;
      if (hasMotion) {
        try {
          motionProjection = selectMotionProjection(
            input.snapshot.snapshot.scene.duration,
            sourceProgramBatch,
            result.motionProjection ?? null,
          );
        } catch {
          return { error: "Rust core returned an uncorrelated persistent-remove motion.", kind: "unsupported" };
        }
        if (!motionProjection) {
          return { error: "Rust core did not return the persistent-remove motion projection.", kind: "unsupported" };
        }
      }
      const bundle = result.bundle;
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
              input.workingState.runtimeSceneState.eventTrack.events,
            ),
            bundle.scene.entities,
          ),
          ...(motionProjection ? { motionProjection } : {}),
          persistentRemoveProjection: result.persistentRemoveProjection,
          ...(staticRootProjection ? { staticRootProjection } : {}),
          ...(hasStaticRootTransform
            ? { editAuthority: "static-imported-root" as const }
            : { editAuthority: "rust-authorized-batch" as const }),
          snapshot: input.snapshot,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected persistent remove: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
  }
  const hasStudioSceneDurationEdit = sourceEdits.some(({ program }) =>
    program.operations.some(isSceneDurationOperation),
  );
  if (hasStudioSceneDurationEdit) {
    if (!staticImportedSourceIsExact(input)) {
      return {
        error: "The verified source snapshot is not one exact imported Scene.",
        kind: "unsupported",
      };
    }
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    try {
      const timelineCommands = studioTimelineCommands(input, engineRevisionHash);
      const bundle = await (input.applyStudioTimelineEditCompiler ?? compileApplyStudioTimelineEdit)(
        input.snapshot.snapshot,
        timelineCommands.apply,
      );
      const timelineProjection = await (input.projectStudioTimelineCompiler ?? projectStudioTimeline)(
        timelineCommands.projection,
      );
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
              input.workingState.runtimeSceneState.eventTrack.events,
            ),
            bundle.scene.entities,
          ),
          editAuthority: "rust-authorized-batch",
          snapshot: input.snapshot,
          timelineProjection,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected the imported Scene timeline edit: ${
          error instanceof Error ? error.message : String(error)
        }`,
        kind: "unsupported",
      };
    }
  }
  if (isExactStudioMotionProgramBatch(sourceProgramBatch)) {
    if (!staticImportedSourceIsExact(input)) {
      return {
        error: "The verified source snapshot is not one exact imported Scene.",
        kind: "unsupported",
      };
    }
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    const projectionCommand = buildStudioMotionProjectionCommand({
      baseDuration: input.snapshot.snapshot.scene.duration,
      programs: sourceProgramBatch,
      runtimeSceneState: input.workingState.runtimeSceneState,
    });
    if (!projectionCommand) {
      return { error: "The standalone motion batch has no Rust projection command.", kind: "unsupported" };
    }
    try {
      const bundle = await (input.applyStudioMotionEditCompiler ?? compileApplyStudioMotionEdit)(
        input.snapshot.snapshot,
        studioMotionEditCommand(input, engineRevisionHash),
      );
      const projected = await (input.projectStudioMotionCompiler ?? projectStudioMotion)(projectionCommand);
      const motionProjection = selectMotionProjection(
        input.snapshot.snapshot.scene.duration,
        sourceProgramBatch,
        projected,
      );
      if (!motionProjection) {
        return { error: "Rust core did not return the standalone motion projection.", kind: "unsupported" };
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
              input.workingState.runtimeSceneState.eventTrack.events,
            ),
            bundle.scene.entities,
          ),
          motionProjection,
          editAuthority: "rust-authorized-batch",
          snapshot: input.snapshot,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected the imported Scene motion: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
  }
  if (importedSource.kind === "imported-manim-runtime-trace") {
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    const rebased = await compileStudioPreviewRuntimeTraceEdit({
      boundEntityEditCompiler: input.applyStudioBoundEntityEditCompiler,
      frame: input.frame,
      snapshot: input.snapshot,
      sourceRevisionHash: engineRevisionHash,
      workingState: input.workingState,
    });
    if (rebased.kind === "unsupported") {
      return {
        error: `Runtime Trace endpoint edit is unsupported (${rebased.issue.code}): ${rebased.issue.message}`,
        kind: "unsupported",
      };
    }
    const { bundle, projection } = rebased.result;
    let boundEntityProjection: StudioBoundEntityProjectionV1 | null;
    try {
      boundEntityProjection = selectBoundEntityProjection(sourceProgramBatch, projection);
    } catch (error) {
      return {
        error: `Runtime Trace endpoint projection is not correlated: ${error instanceof Error ? error.message : String(error)}`,
        kind: "unsupported",
      };
    }
    if (!boundEntityProjection) {
      return { error: "Runtime Trace endpoint projection does not match one bound Program.", kind: "unsupported" };
    }
    return {
      kind: "compiled",
      scene: {
        boundEntityProjection,
        bundle,
        engineRevisionHash,
        frame: { ...input.frame },
        interactionEntityIds: studioPreviewInteractionEntityIdsV1(
          input.snapshot.sourceRuntimeIdentity,
          studioPreviewInteractionAuthority(input.snapshot, 0, input.workingState.runtimeSceneState.eventTrack.events),
          bundle.scene.entities,
        ),
        editAuthority: "source-bound-endpoint",
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      },
    };
  }
  if (importedSource.kind === "imported-manim-server-snapshot") {
    const base = input.workingState;
    const correlation = input.snapshot.correlation;
    if (
      !importedSnapshotCorrelationIsExact(input.snapshot, true) ||
      base.runtimeSceneState.sceneId !== base.editorContext.activeSceneId ||
      base.runtimeSceneState.sceneId !== `${correlation.context.sourcePath}#${correlation.context.sceneName}` ||
      base.sourceSnapshot.sourceId !== correlation.context.sourcePath ||
      base.sourceSnapshot.hash !== `sha256:${correlation.context.sourceHash}`
    ) {
      return {
        error: "Static imported Studio state is not correlated with one exact verified Scene.",
        kind: "unsupported",
      };
    }
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    try {
      const result = await (input.applyStaticRootTransformEditCompiler ?? compileApplyStaticRootTransformEdit)(
        input.snapshot.snapshot,
        staticRootTransformEditCommand(input, engineRevisionHash),
      );
      if (
        (exactStaticRootBatch || studioMotionProjectionBatchKind(sourceProgramBatch) === "static-root") &&
        !result.staticRootProjection
      ) {
        return {
          error: "Rust core did not return the static-root projection for the exact current Program batch.",
          kind: "unsupported",
        };
      }
      const hasMotion = sourceProgramBatch.some((program) =>
        program.operations.some(({ kind }) => kind === "CreateMotion"),
      );
      let motionProjection: StudioMotionProjectionV1 | null = null;
      if (hasMotion) {
        try {
          motionProjection = selectMotionProjection(
            input.snapshot.snapshot.scene.duration,
            sourceProgramBatch,
            result.motionProjection ?? null,
          );
        } catch {
          return { error: "Rust core returned an uncorrelated static-root motion.", kind: "unsupported" };
        }
        if (!motionProjection) {
          return { error: "Rust core did not return the static-root motion projection.", kind: "unsupported" };
        }
      }
      const bundle = result.bundle;
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
              input.workingState.runtimeSceneState.eventTrack.events,
            ),
            bundle.scene.entities,
          ),
          persistentRemoveProjection: result.persistentRemoveProjection,
          ...(motionProjection ? { motionProjection } : {}),
          ...(result.staticRootProjection ? { staticRootProjection: result.staticRootProjection } : {}),
          ...(hasImportedRootTransformTarget(sourceEdits.map(({ program }) => program))
            ? { editAuthority: "static-imported-root" as const }
            : { editAuthority: "rust-authorized-batch" as const }),
          snapshot: input.snapshot,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected the static imported root edit: ${
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

function resolveFragmentMaterialSceneEntityIdV1(
  studioEntityId: string,
  scene: CompiledStudioPreviewSceneV1,
  workingState: WorkingState,
) {
  const sourceIdentity = workingState.runtimeSceneState.objectGraph.entities[studioEntityId]?.sourceIdentity;
  if (sourceIdentity?.kind === "known") {
    return scene.snapshot.sourceRuntimeIdentity?.get(sourceIdentity.value)?.entityId ?? null;
  }
  return scene.bundle.scene.entities.some(({ id }) => id === studioEntityId) ? studioEntityId : null;
}

async function digestFragmentMaterialSceneRevisionV1(
  baseRevision: string,
  registry: FragmentMaterialRegistryV1,
  assignments: readonly Readonly<{ entityId: string; material: unknown }>[],
) {
  const bytes = new TextEncoder().encode(
    canonicalJsonV1(["poietra.studio-fragment-materials", baseRevision, registry, assignments]),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function compileStudioPreviewSceneV1(
  input: Parameters<typeof compileStudioPreviewSceneWithoutFragmentMaterialsV1>[0] &
    Readonly<{
      applyStudioFragmentMaterialsCompiler?: ApplyStudioFragmentMaterialsCompiler;
      sceneFragmentMaterials?: SceneFragmentMaterialStateV1;
    }>,
): ReturnType<typeof compileStudioPreviewSceneWithoutFragmentMaterialsV1> {
  const result = await compileStudioPreviewSceneWithoutFragmentMaterialsV1(input);
  if (result.kind !== "compiled") return result;
  const sceneMaterials = input.sceneFragmentMaterials ?? EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1;
  const assignments = Object.entries(sceneMaterials.assignments);
  if (assignments.length === 0) {
    return {
      kind: "compiled",
      scene: {
        ...result.scene,
        fragmentMaterialInput: sceneMaterials,
        fragmentMaterialRegistry: EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
      },
    };
  }
  const resolvedAssignments: Array<{
    entityId: string;
    material: SceneFragmentMaterialStateV1["assignments"][string];
  }> = [];
  const resolvedIds = new Set<string>();
  for (const [studioEntityId, material] of assignments) {
    const entityId = resolveFragmentMaterialSceneEntityIdV1(studioEntityId, result.scene, input.workingState);
    if (!entityId || resolvedIds.has(entityId)) {
      return {
        error: `Fragment material target ${studioEntityId} is not one unique rendered fill.`,
        kind: "unsupported",
      };
    }
    resolvedIds.add(entityId);
    resolvedAssignments.push({ entityId, material });
  }
  const nextRevision = await digestFragmentMaterialSceneRevisionV1(
    result.scene.engineRevisionHash,
    sceneMaterials.registry,
    resolvedAssignments,
  );
  try {
    const bundle = await (input.applyStudioFragmentMaterialsCompiler ?? compileApplyStudioFragmentMaterials)(
      result.scene.bundle,
      {
        assignments: resolvedAssignments,
        expectedBaseRevision: result.scene.engineRevisionHash,
        nextRevision,
        schema: "poietra.apply-studio-fragment-materials",
        version: 1,
      },
    );
    return {
      kind: "compiled",
      scene: {
        ...result.scene,
        bundle,
        engineRevisionHash: nextRevision,
        fragmentMaterialInput: sceneMaterials,
        fragmentMaterialRegistry: sceneMaterials.registry,
      },
    };
  } catch (error) {
    return {
      error: `Rust core rejected the fragment material assignment: ${
        error instanceof Error ? error.message : String(error)
      }`,
      kind: "unsupported",
    };
  }
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
    provider,
    sceneFragmentMaterials = EMPTY_SCENE_FRAGMENT_MATERIAL_STATE_V1,
    retainedSourceDuration,
    sampleTime,
    sceneBoundaryActive,
    sourceEvents,
    staticPrimitiveTransforms,
    workingState,
  } = input;
  const [bound, setBound] = useState<BoundHostStateV1 | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [metadata, setMetadata] = useState<StudioPreviewSnapshotMetadataStateV1>(INACTIVE_METADATA);
  const [compilation, setCompilation] = useState<StudioPreviewCompilationStateV1>(INACTIVE_COMPILATION);
  const [installation, setInstallation] = useState<StudioPreviewHostInstallationV1 | null>(null);
  const [viewport, setViewport] = useState<PreviewViewportV1 | null>(null);
  const latestWorkingState = useRef(workingState);
  latestWorkingState.current = workingState;
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
  useEffect(() => {
    const workingState = latestWorkingState.current;
    const workingRevision = context?.workingRevision;
    if (
      !snapshot ||
      !workingState ||
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
      sceneFragmentMaterials,
      snapshot,
      staticPrimitiveTransforms,
      workingState,
      workingRevision,
      workspaceKey,
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setCompilation(
          result.kind === "compiled"
            ? { phase: "ready", scene: result.scene }
            : {
                error: result.error,
                fragmentMaterialInput: sceneFragmentMaterials,
                phase: "unsupported",
                workingRevision,
                workspaceKey,
              },
        );
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setCompilation({
          error: error instanceof Error ? error.message : String(error),
          fragmentMaterialInput: sceneFragmentMaterials,
          phase: "unsupported",
          workingRevision,
          workspaceKey,
        });
      },
    );
    return () => controller.abort();
  }, [
    context?.workingRevision,
    frame.height,
    frame.width,
    sceneFragmentMaterials,
    retainedSourceDuration,
    snapshot,
    staticPrimitiveTransforms,
    workspaceKey,
  ]);

  const revisionCorrelatedCompiledScene =
    compilation.phase === "ready" &&
    compilation.scene.snapshot === snapshot &&
    compilation.scene.workspaceKey === workspaceKey &&
    compilation.scene.workingRevision === context?.workingRevision &&
    compilation.scene.frame.height === frame.height &&
    compilation.scene.frame.width === frame.width
      ? compilation.scene
      : null;
  const currentCompiledScene = correlateStudioPreviewFragmentMaterialInputV1(
    revisionCorrelatedCompiledScene,
    sceneFragmentMaterials,
  );
  const compilationError =
    compilation.phase === "unsupported" &&
    compilation.workspaceKey === workspaceKey &&
    compilation.workingRevision === context?.workingRevision &&
    compilation.fragmentMaterialInput === sceneFragmentMaterials
      ? compilation.error
      : null;
  const runtimeTraceSource = snapshot?.snapshot.scene.source;
  const runtimeTraceProgramValidation: StudioPreviewRuntimeTraceProgramValidation =
    runtimeTraceSource?.kind !== "imported-manim-runtime-trace" ||
    (workingState === null ? 0 : sourceEditRecords(workingState).length) === 0
      ? "not-applicable"
      : currentCompiledScene?.editAuthority === "source-bound-endpoint"
        ? "authorized"
        : "rejected";
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
      fragmentMaterialRegistry: installedScene.fragmentMaterialRegistry ?? EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
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
        fragmentMaterialRegistry: currentCompiledScene.fragmentMaterialRegistry ?? EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
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
  const presentedCompiledScene =
    state.phase === "presented" &&
    currentCompiledScene &&
    state.frame.revision === currentCompiledScene.engineRevisionHash
      ? currentCompiledScene
      : null;
  if (!provider) return null;
  const interactionAuthority = studioPreviewInteractionAuthority(snapshot, sampleTime, sourceEvents);
  const runtimeTraceOpaqueSelectionEntities = projectStudioPreviewRuntimeTraceOpaqueSelectionEntities({
    interactionGeometry,
    sourceRuntimeIdentity: snapshot?.sourceRuntimeIdentity ?? null,
    studioSceneId: context ? `${context.sourcePath}#${context.sceneName}` : null,
  });
  return {
    attachCanvas,
    generateThumbnail: (signal) => {
      if (!host || !presentedCompiledScene) {
        return Promise.reject(
          new CanvasWorkerClientError("invalid-state", "No current Scene can produce a thumbnail."),
        );
      }
      return host.generateThumbnail(presentedCompiledScene.engineRevisionHash, signal);
    },
    boundEntityProjection: state.phase === "presented" ? (currentCompiledScene?.boundEntityProjection ?? null) : null,
    cameraCenter: snapshot ? { ...snapshot.snapshot.scene.camera.view.center } : null,
    canonicalScene: presentedCompiledScene
      ? {
          assetPayloads: presentedCompiledScene.snapshot.assetPayloads,
          bundle: presentedCompiledScene.bundle,
          fragmentMaterialRegistry:
            presentedCompiledScene.fragmentMaterialRegistry ?? EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
          sourceLineage: {
            projectId: presentedCompiledScene.snapshot.correlation.context.projectId,
            sceneId: presentedCompiledScene.snapshot.correlation.sceneId,
            sceneName: presentedCompiledScene.snapshot.correlation.context.sceneName,
            sourceHash: presentedCompiledScene.snapshot.correlation.context.sourceHash,
            sourcePath: presentedCompiledScene.snapshot.correlation.context.sourcePath,
            workingRevision: presentedCompiledScene.workingRevision,
          },
        }
      : null,
    // The workspace needs the exact compiled projection to keep the canvas
    // mounted while WebGPU presents this revision. Mutation remains gated by
    // `state.phase === "presented"` in App; these values are not commit authority.
    creationProjection: currentCompiledScene?.creationProjection ?? null,
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
    mathTexTransformProjection:
      state.phase === "presented" ? (currentCompiledScene?.mathTexTransformProjection ?? null) : null,
    motionProjection: state.phase === "presented" ? (currentCompiledScene?.motionProjection ?? null) : null,
    persistentRemoveProjection: currentCompiledScene?.persistentRemoveProjection ?? null,
    editAuthority: currentCompiledScene?.editAuthority ?? null,
    staticRootProjection: state.phase === "presented" ? (currentCompiledScene?.staticRootProjection ?? null) : null,
    timelineProjection: currentCompiledScene?.timelineProjection ?? null,
    verifiedSourceDuration,
  };
}
