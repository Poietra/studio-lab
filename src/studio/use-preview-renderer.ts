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
  compileMoveSceneEntity,
  type MoveSceneEntityCompiler,
  type RotateSceneEntityCompiler,
  type SetSubtreeVectorPaintAlphaCompiler,
  type UniformScaleSceneEntityCompiler,
} from "../engine/scene-authoring";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import type {
  EntityDimensions,
  Point,
  ProgramRecord,
  ProjectedEntity,
  ProposedState,
  RuntimeSceneState,
} from "./model";
import type { CanonicalEditProgram } from "./operations";
import {
  detectStudioPreviewCapabilitiesV1,
  evaluateStudioPreviewEligibilityV1,
  projectStudioPreviewInteractionGeometryV1,
  resolveStudioPreviewViewStateV1,
  type StudioPreviewHostBindingV1,
  type StudioPreviewInteractionGeometryV1,
  snapStudioPreviewViewportV1,
  studioPreviewHostBindingCurrentV1,
  studioPreviewSnapshotMatchesSourceV1,
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
  compileStudioPreviewGenericInitialEdit,
  compileStudioPreviewTemporalRebase,
  type StudioPreviewGenericInitialEditCandidate,
  type StudioPreviewInitialEditProjectionAuthority,
  studioPreviewGenericInitialEditCandidates,
  studioPreviewInitialEditIntegrationAuthority,
  studioPreviewInitialEditProjection,
  studioPreviewSyntheticInitialEditAnchor,
} from "./preview-temporal-rebase";
import {
  isPointValue,
  normalizeDimensionsSamples,
  normalizePositionSamples,
  normalizeScaleSamples,
} from "./property-sampling";
import {
  buildStudioSceneIrAdapterEvidenceV1,
  collectStudioMathTexOutlineInputsV1,
  compileStudioSceneIrV1,
  studioPointToScenePointV1,
} from "./scene-ir-adapter";

export type StudioPreviewRendererView = Readonly<{
  attachCanvas: (canvas: HTMLCanvasElement | null) => void;
  /** Verified world-space center used to project Studio viewport positions. */
  cameraCenter: Readonly<{ x: number; y: number }> | null;
  epoch: number;
  /**
   * Hit-target geometry derived from that frame's prepared GPU vertices,
   * keyed by verified runtime entity ID; non-null only while correlated.
   */
  interactionGeometry: StudioPreviewInteractionGeometryV1 | null;
  interactionAuthority: StudioPreviewInteractionAuthority;
  /** Verified generic V3 candidates that may request one server-authorized t=0 edit. */
  genericInitialEditCandidates: readonly StudioPreviewGenericInitialEditCandidate[];
  /** Exact runtime authority for one bounded initial imported-Scene edit. */
  initialEditAuthority: StudioPreviewInitialEditProjectionAuthority | null;
  /** Profile-free edit authority for one reviewed Runtime Trace terminal target. */
  runtimeTraceTerminalEdit: StudioPreviewRuntimeTraceTerminalEditProjection | null;
  /** A retained exact source-anchor frame is visible behind a target-only ghost. */
  runtimeTraceBaseFrameRetained: boolean;
  /** Runtime roots with no static Studio entity; selectors only, never authoring evidence. */
  runtimeTraceOpaqueSelectionEntities: readonly ProjectedEntity[];
  /** Presentation for a target-only ghost awaiting real-Manim validation. */
  runtimeTracePendingPresentation: StudioPreviewRuntimeTracePendingPresentation | null;
  sourceLabel: string | null;
  /** Typed provider outcome; never inferred from diagnostic text. */
  sourceMetadataFailureKind: StudioPreviewSnapshotFailureKindV1 | null;
  /** Lifecycle of verified source metadata for the current provider/Scene. */
  sourceMetadataPhase: "failed" | "inactive" | "loading" | "ready";
  /** Server-verified source name to runtime entity mapping for this snapshot. */
  sourceRuntimeIdentity: StudioPreviewSourceRuntimeIdentityV1 | null;
  state: PreviewRendererHostStateV1;
  /** Preview-only t=0 authority; it does not imply a lowerable source marker. */
  syntheticInitialEditAnchor: number | null;
  /** Verified fast-manim base duration for the current source identity. */
  verifiedSourceDuration: number | null;
}>;

export type StudioPreviewInteractionAuthority =
  | Readonly<{ kind: "interactive"; nestedGroupEntityIds?: readonly string[] }>
  | Readonly<{
      editableRuntimeEntityIds: readonly string[];
      kind: "bounded-interactive";
      reason: "runtime-trace-initial-edit";
      sourceAnchor: 0;
      verifiedRuntimeEntityIds: readonly string[];
    }>
  | Readonly<{
      editableRuntimeEntityId: string;
      kind: "bounded-interactive";
      reason: "runtime-trace-terminal-edit";
      sourceAnchor: 5 | 14;
      verifiedRuntimeEntityIds: readonly string[];
    }>
  | Readonly<{
      kind: "selection-only";
      reason: "runtime-trace-preview-only";
      verifiedRuntimeEntityIds: readonly string[];
    }>
  | Readonly<{ kind: "selection-only"; reason: "source-edit-anchor-unavailable" }>
  | Readonly<{
      kind: "display-only";
      reason: "aggregate-mathtex-morph-lineage" | "source-runtime-identity-unverified" | "temporal-rebase-unavailable";
    }>;

type UpdatersTerminalEditAuthority = Readonly<{
  baseCenter: Point;
  duration: 6;
  profile: "updaters-terminal-v1";
  relativeScale: 1;
  runtimeEntityId: string;
  sourceAnchor: 5;
  sourceDimensions: Readonly<{ height: 2; width: 2 }>;
  studioEntityId: string;
  studioSceneId: string;
}>;

type OpeningTerminalEditAuthority = Readonly<{
  baseCenter: Point;
  duration: 15;
  profile: "opening-grid-title-terminal-v2";
  runtimeEntityId: string;
  sourceAnchor: 14;
  studioEntityId: string;
  studioSceneId: string;
}>;

type RuntimeTraceTerminalEditAuthority = UpdatersTerminalEditAuthority | OpeningTerminalEditAuthority;

type RuntimeTraceTerminalEditProjectionCommon = Readonly<{
  baseCenter: Point;
  controlLabel: string;
  restrictionMessage: string;
  runtimeEntityId: string;
  studioEntityId: string;
  studioSceneId: string;
}>;

/** Studio-facing edit authority. Profile identity is isolated in renderProof. */
export type StudioPreviewRuntimeTraceTerminalEditProjection =
  | (RuntimeTraceTerminalEditProjectionCommon &
      Readonly<{
        capabilities: Readonly<{ uniformScale: true }>;
        duration: 6;
        renderProof: Readonly<{ profile: "updaters-terminal-v1"; sourceAnchor: 5 }>;
        sourceAnchor: 5;
        target: Readonly<{ sourceName: "square"; type: "Square" }>;
        uniformScaleBasis: Readonly<{
          relativeScale: 1;
          sourceDimensions: Readonly<{ height: 2; width: 2 }>;
        }>;
      }>)
  | (RuntimeTraceTerminalEditProjectionCommon &
      Readonly<{
        capabilities: Readonly<{ uniformScale: false }>;
        duration: 15;
        renderProof: Readonly<{ profile: "opening-grid-title-terminal-v2"; sourceAnchor: 14 }>;
        sourceAnchor: 14;
        target: Readonly<{ sourceName: "grid_title"; type: "Tex" }>;
        uniformScaleBasis: null;
      }>);

export type StudioPreviewRuntimeTracePendingPresentation =
  | Readonly<{
      baseFrameRetained: boolean;
      dimensions: Readonly<{ height: number; width: number }>;
      draftGhost: "position-and-dimensions";
      position: Point;
      renderProof: Readonly<{ profile: "updaters-terminal-v1"; sourceAnchor: 5 }>;
      sourceAnchor: 5;
      studioEntityId: string;
      target: Readonly<{ sourceName: "square"; type: "Square" }>;
      validationStatusLabel: string;
    }>
  | Readonly<{
      baseFrameRetained: boolean;
      dimensions: null;
      draftGhost: "position-only";
      position: Point;
      renderProof: Readonly<{ profile: "opening-grid-title-terminal-v2"; sourceAnchor: 14 }>;
      sourceAnchor: 14;
      studioEntityId: string;
      target: Readonly<{ sourceName: "grid_title"; type: "Tex" }>;
      validationStatusLabel: string;
    }>;

export type UseStudioPreviewRendererInput = Readonly<{
  committedProposedState: ProposedState | null;
  context: StudioPreviewEditingContextV1 | null;
  draftProposedState: ProposedState | null;
  frame: Readonly<{ height: number; width: number }>;
  provider: StudioPreviewSnapshotProviderV1 | null;
  retainedSourceDuration: number | null;
  runtimeTraceTerminalProgramRecords: readonly ProgramRecord[];
  sampleTime: number;
  transientEdit: boolean;
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
  binding: StudioPreviewHostBindingV1;
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

const UPDATERS_TERMINAL_SOURCE_PATH_V1 = "example_scenes/basic.py";
const UPDATERS_TERMINAL_SCENE_NAME_V1 = "UpdatersExample";
const UPDATERS_TERMINAL_SOURCE_HASH_V1 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const UPDATERS_TERMINAL_RUNTIME_CONFIG_HASH_V1 = "9b69b6296dc706b1deebbc1d9f88b05ef2f97aa9acf1e87eae9a8efd13b33c97";
const UPDATERS_TERMINAL_SOURCE_ANCHOR_V1 = 5 as const;
const OPENING_TERMINAL_SOURCE_PATH_V2 = "example_scenes/basic.py";
const OPENING_TERMINAL_SCENE_NAME_V2 = "OpeningManim";
const OPENING_TERMINAL_SOURCE_HASH_V2 = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const OPENING_TERMINAL_RUNTIME_CONFIG_HASH_V2 = "0b5d2eae4a3709627a7ccae44ce5a977171452ed73e90ab6bfcfdffda604b977";
const OPENING_TERMINAL_SOURCE_ANCHOR_V2 = 14 as const;

type WithoutBaseCenter<T> = T extends Readonly<{ baseCenter: Point }> ? Omit<T, "baseCenter"> : never;
type RuntimeTraceTerminalEditSeed = WithoutBaseCenter<RuntimeTraceTerminalEditAuthority>;
export type StudioPreviewRuntimeTraceTerminalEditSeed =
  WithoutBaseCenter<StudioPreviewRuntimeTraceTerminalEditProjection>;
type StudioPreviewRuntimeTraceUpdatersSelectionProfileV1 = Readonly<{
  profile: "updaters-terminal-v1";
  studioSceneId: string;
}>;

type StudioPreviewRuntimeTraceOpeningSelectionProfileV2 = Readonly<{
  profile: "opening-grid-title-terminal-v2";
  runtimeEntityId: string;
  studioSceneId: string;
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

function runtimeTraceSnapshotCorrelationIsExact(
  snapshot: StudioVerifiedPreviewSnapshotV1,
  requirePristineWorkingRevision: boolean,
) {
  return (
    snapshot.snapshot.scene.source.kind === "imported-manim-runtime-trace" &&
    importedSnapshotCorrelationIsExact(snapshot, requirePristineWorkingRevision)
  );
}

/**
 * Selection needs only a freshly correlated, verified Updaters trace. Unlike
 * source rewrite authority, it deliberately accepts a post-commit candidate
 * source hash so its runtime-only Decimal root does not disappear after
 * successful reimport.
 */
export function studioPreviewRuntimeTraceUpdatersSelectionProfileV1(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
): StudioPreviewRuntimeTraceUpdatersSelectionProfileV1 | null {
  if (!snapshot || !runtimeTraceSnapshotCorrelationIsExact(snapshot, false)) return null;
  const scene = snapshot.snapshot.scene;
  const source = scene.source;
  const context = snapshot.correlation.context;
  const identity = snapshot.sourceRuntimeIdentity;
  if (
    source.kind !== "imported-manim-runtime-trace" ||
    source.traceVersion !== 1 ||
    source.runtimeConfigHash !== UPDATERS_TERMINAL_RUNTIME_CONFIG_HASH_V1 ||
    context.sourcePath !== UPDATERS_TERMINAL_SOURCE_PATH_V1 ||
    context.sceneName !== UPDATERS_TERMINAL_SCENE_NAME_V1 ||
    scene.duration !== 6 ||
    identity?.size !== 2
  ) {
    return null;
  }
  const square = identity.get("square");
  const decimal = identity.get("decimal");
  if (square?.sourceName !== "square" || decimal?.sourceName !== "decimal" || square.entityId === decimal.entityId) {
    return null;
  }
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const squareRoot = entities.get(square.entityId);
  const decimalRoot = entities.get(decimal.entityId);
  const motionRoot = squareRoot?.parentId === null ? undefined : entities.get(squareRoot?.parentId ?? "");
  if (
    squareRoot?.geometry.kind !== "group" ||
    decimalRoot?.geometry.kind !== "group" ||
    squareRoot.parentId === null ||
    decimalRoot.parentId !== squareRoot.parentId ||
    motionRoot?.geometry.kind !== "group" ||
    motionRoot.parentId !== null
  ) {
    return null;
  }
  return { profile: "updaters-terminal-v1", studioSceneId: `${context.sourcePath}#${context.sceneName}` };
}

function studioPreviewRuntimeTraceUpdatersTerminalEditSeedV1(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
): RuntimeTraceTerminalEditSeed | null {
  const selectionProfile = studioPreviewRuntimeTraceUpdatersSelectionProfileV1(snapshot);
  if (!snapshot || !selectionProfile) return null;
  const source = snapshot.snapshot.scene.source;
  const context = snapshot.correlation.context;
  if (
    source.kind !== "imported-manim-runtime-trace" ||
    source.sourceHash !== UPDATERS_TERMINAL_SOURCE_HASH_V1 ||
    context.sourceHash !== UPDATERS_TERMINAL_SOURCE_HASH_V1 ||
    context.workingRevision !== PRISTINE_WORKING_REVISION
  ) {
    return null;
  }
  const square = snapshot.sourceRuntimeIdentity?.get("square");
  if (!square) return null;
  return {
    duration: 6,
    profile: "updaters-terminal-v1",
    relativeScale: 1,
    runtimeEntityId: square.entityId,
    sourceAnchor: UPDATERS_TERMINAL_SOURCE_ANCHOR_V1,
    sourceDimensions: { height: 2, width: 2 },
    studioEntityId: `source:${context.sourcePath}#${context.sceneName}:square`,
    studioSceneId: selectionProfile.studioSceneId,
  };
}

/**
 * Pins the second Runtime Trace edit slice to one source-bound V2 root. The
 * runtime hierarchy supplies correlated presentation evidence; static source
 * analysis remains responsible for whether `grid_title` may be rewritten.
 */
function studioPreviewRuntimeTraceOpeningTerminalEditSeedV2(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
): RuntimeTraceTerminalEditSeed | null {
  const selectionProfile = studioPreviewRuntimeTraceOpeningSelectionProfileV2(snapshot);
  if (!snapshot || !selectionProfile) return null;
  const source = snapshot.snapshot.scene.source;
  const context = snapshot.correlation.context;
  if (
    source.kind !== "imported-manim-runtime-trace" ||
    source.sourceHash !== OPENING_TERMINAL_SOURCE_HASH_V2 ||
    context.sourceHash !== OPENING_TERMINAL_SOURCE_HASH_V2 ||
    context.workingRevision !== PRISTINE_WORKING_REVISION
  ) {
    return null;
  }
  return {
    duration: 15,
    profile: selectionProfile.profile,
    runtimeEntityId: selectionProfile.runtimeEntityId,
    sourceAnchor: OPENING_TERMINAL_SOURCE_ANCHOR_V2,
    studioEntityId: `source:${context.sourcePath}#${context.sceneName}:grid_title`,
    studioSceneId: selectionProfile.studioSceneId,
  };
}

/** Keeps reviewed OpeningManim roots selectable after a verified candidate reimport. */
export function studioPreviewRuntimeTraceOpeningSelectionProfileV2(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
): StudioPreviewRuntimeTraceOpeningSelectionProfileV2 | null {
  if (!snapshot || !runtimeTraceSnapshotCorrelationIsExact(snapshot, false)) return null;
  const scene = snapshot.snapshot.scene;
  const source = scene.source;
  const context = snapshot.correlation.context;
  const identity = snapshot.sourceRuntimeIdentity;
  if (
    source.kind !== "imported-manim-runtime-trace" ||
    source.traceVersion !== 2 ||
    source.runtimeConfigHash !== OPENING_TERMINAL_RUNTIME_CONFIG_HASH_V2 ||
    context.sourcePath !== OPENING_TERMINAL_SOURCE_PATH_V2 ||
    context.sceneName !== OPENING_TERMINAL_SCENE_NAME_V2 ||
    scene.duration !== 15 ||
    identity?.size !== 4
  ) {
    return null;
  }
  const expectedRoots = [
    ["title", "title"],
    ["basel", "basel"],
    ["grid", "grid"],
    ["grid_title", "grid-title"],
  ] as const;
  const mappings = expectedRoots.map(([name]) => identity.get(name));
  if (
    mappings.some(
      (mapping, index) =>
        mapping?.sourceName !== expectedRoots[index]?.[0] ||
        mapping.entityId !== `${scene.sceneId}/runtime-root:${expectedRoots[index]?.[1]}`,
    ) ||
    new Set(mappings.map((mapping) => mapping?.entityId)).size !== expectedRoots.length
  ) {
    return null;
  }
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const roots = mappings.map((mapping) => entities.get(mapping?.entityId ?? ""));
  const parentId = roots[0]?.parentId;
  const parent = parentId ? entities.get(parentId) : undefined;
  if (
    !parentId ||
    parent?.geometry.kind !== "group" ||
    parent.parentId !== null ||
    roots.some((root) => root?.geometry.kind !== "group" || root.parentId !== parentId)
  ) {
    return null;
  }
  const gridTitle = identity.get("grid_title");
  if (!gridTitle) return null;
  return {
    profile: "opening-grid-title-terminal-v2",
    runtimeEntityId: gridTitle.entityId,
    studioSceneId: `${context.sourcePath}#${context.sceneName}`,
  };
}

/**
 * Runtime identity alone never opens mutation: exact source, configuration,
 * correlation, hierarchy, and the profile-specific source roots must agree.
 */
function projectRuntimeTraceTerminalEditSeed(
  authority: RuntimeTraceTerminalEditSeed,
): StudioPreviewRuntimeTraceTerminalEditSeed {
  if (authority.profile === "updaters-terminal-v1") {
    return {
      capabilities: { uniformScale: true },
      controlLabel: `Square terminal edit at ${authority.sourceAnchor.toFixed(2)}s`,
      duration: authority.duration,
      renderProof: { profile: authority.profile, sourceAnchor: authority.sourceAnchor },
      restrictionMessage: "This updater-backed Square supports terminal position and positive uniform resize only.",
      runtimeEntityId: authority.runtimeEntityId,
      sourceAnchor: authority.sourceAnchor,
      studioEntityId: authority.studioEntityId,
      studioSceneId: authority.studioSceneId,
      target: { sourceName: "square", type: "Square" },
      uniformScaleBasis: {
        relativeScale: authority.relativeScale,
        sourceDimensions: authority.sourceDimensions,
      },
    };
  }
  return {
    capabilities: { uniformScale: false },
    controlLabel: `Grid title terminal edit at ${authority.sourceAnchor.toFixed(2)}s`,
    duration: authority.duration,
    renderProof: { profile: authority.profile, sourceAnchor: authority.sourceAnchor },
    restrictionMessage: "This source-bound grid title supports terminal position only.",
    runtimeEntityId: authority.runtimeEntityId,
    sourceAnchor: authority.sourceAnchor,
    studioEntityId: authority.studioEntityId,
    studioSceneId: authority.studioSceneId,
    target: { sourceName: "grid_title", type: "Tex" },
    uniformScaleBasis: null,
  };
}

/**
 * Public snapshot projection for tests and interaction policy. Exact profile
 * verification stays private to this integration module.
 */
export function studioPreviewRuntimeTraceTerminalEditSeed(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
): StudioPreviewRuntimeTraceTerminalEditSeed | null {
  const authority =
    studioPreviewRuntimeTraceUpdatersTerminalEditSeedV1(snapshot) ??
    studioPreviewRuntimeTraceOpeningTerminalEditSeedV2(snapshot);
  return authority ? projectRuntimeTraceTerminalEditSeed(authority) : null;
}

function studioRuntimeTraceTerminalTargetMatches(
  entity: RuntimeSceneState["objectGraph"]["entities"][string] | ProjectedEntity | undefined,
  authority: StudioPreviewRuntimeTraceTerminalEditProjection,
) {
  if (
    entity?.id !== authority.studioEntityId ||
    entity.type !== authority.target.type ||
    entity.provisional ||
    entity.transactionId !== undefined ||
    entity.sourceIdentity.kind !== "known" ||
    entity.sourceIdentity.value !== authority.target.sourceName
  ) {
    return false;
  }
  if (!authority.uniformScaleBasis) return true;
  const dimensions = entity?.geometry?.dimensions;
  const scale = entity?.geometry?.scale;
  return (
    dimensions?.kind === "known" &&
    dimensions.value.height === authority.uniformScaleBasis.sourceDimensions.height &&
    dimensions.value.width === authority.uniformScaleBasis.sourceDimensions.width &&
    dimensions.value.radius === undefined &&
    scale?.kind === "known" &&
    scale.value === authority.uniformScaleBasis.relativeScale
  );
}

function runtimeTracePendingMatchesEdit(
  pending: StudioPreviewRuntimeTracePendingPresentation,
  authority: StudioPreviewRuntimeTraceTerminalEditProjection,
) {
  return (
    pending.studioEntityId === authority.studioEntityId &&
    pending.sourceAnchor === authority.sourceAnchor &&
    pending.renderProof.profile === authority.renderProof.profile &&
    pending.target.sourceName === authority.target.sourceName &&
    pending.target.type === authority.target.type
  );
}

/** Runtime evidence supplies the terminal center; pending dimensions are presentation-only. */
export function projectStudioPreviewRuntimeTraceTerminalEntity(
  entities: readonly ProjectedEntity[],
  authority: StudioPreviewRuntimeTraceTerminalEditProjection | null,
  pendingPresentation: StudioPreviewRuntimeTracePendingPresentation | null = null,
) {
  const pending =
    pendingPresentation && (!authority || runtimeTracePendingMatchesEdit(pendingPresentation, authority))
      ? pendingPresentation
      : null;
  if (!authority && !pending) return entities;
  const targetId = authority?.studioEntityId ?? pending?.studioEntityId;
  const target = entities.find(({ id }) => id === targetId);
  const targetMatchesPending =
    pending !== null &&
    target?.id === pending.studioEntityId &&
    !target.provisional &&
    target.transactionId === undefined &&
    target.sourceIdentity.kind === "known" &&
    target.type === pending.target.type &&
    target.sourceIdentity.value === pending.target.sourceName;
  const targetMatchesAuthority = authority !== null && studioRuntimeTraceTerminalTargetMatches(target, authority);
  if (!target || (!targetMatchesAuthority && !targetMatchesPending)) {
    return entities;
  }
  const projectedPosition =
    pending !== null &&
    pending.studioEntityId === target.id &&
    pending.sourceAnchor === pending.renderProof.sourceAnchor &&
    Number.isFinite(pending.position.x) &&
    Number.isFinite(pending.position.y)
      ? pending.position
      : authority?.baseCenter;
  if (!projectedPosition) return entities;
  const projectedDimensions =
    pending?.dimensions &&
    Number.isFinite(pending.dimensions.height) &&
    pending.dimensions.height > 0 &&
    Number.isFinite(pending.dimensions.width) &&
    pending.dimensions.width > 0
      ? pending.dimensions
      : null;
  return entities.map((entity) =>
    entity.id === target.id
      ? {
          ...entity,
          geometry: {
            ...entity.geometry,
            ...(projectedDimensions ? { dimensions: { kind: "known" as const, value: projectedDimensions } } : {}),
            position: { kind: "known" as const, value: projectedPosition },
          },
          position: projectedPosition,
          present: true,
        }
      : entity,
  );
}

/**
 * Adds profile-owned terminal facts only to one validation clone. The
 * imported source model remains conservative, and runtime-only geometry is
 * never synthesized as editable semantic state.
 */
export function projectStudioPreviewRuntimeTraceTerminalValidationScene(
  scene: RuntimeSceneState,
  authority: StudioPreviewRuntimeTraceTerminalEditProjection | null,
): RuntimeSceneState {
  if (
    !authority ||
    scene.duration !== authority.duration ||
    scene.sceneId !== authority.studioSceneId ||
    !studioRuntimeTraceTerminalTargetMatches(scene.objectGraph.entities[authority.studioEntityId], authority)
  ) {
    return scene;
  }
  const target = scene.objectGraph.entities[authority.studioEntityId];
  if (!target?.geometry) return scene;
  const scaleBasis = authority.uniformScaleBasis;
  const terminalValues: Readonly<Record<string, EntityDimensions | Point | number>> = scaleBasis
    ? {
        dimensions: scaleBasis.sourceDimensions,
        position: authority.baseCenter,
        scale: scaleBasis.relativeScale,
      }
    : { position: authority.baseCenter };
  const propertyChannels = { ...scene.propertyChannels };
  for (const key of Object.keys(terminalValues) as ("dimensions" | "position" | "scale")[]) {
    const channelId = `${target.id}/${key}`;
    const channel = propertyChannels[channelId];
    if (!channel || channel.entityId !== target.id || channel.key !== key) return scene;
    const value = terminalValues[key]!;
    const samples = [
      ...channel.samples,
      {
        interval: { end: authority.sourceAnchor, start: authority.sourceAnchor },
        kind: "exact" as const,
        knowledge: { kind: "known" as const, value },
        provenanceId: `${target.id}/runtime-trace-terminal-${key}`,
        sameAnchorOrder: "before-studio-insertion" as const,
        value,
      },
    ];
    propertyChannels[channelId] = {
      ...channel,
      samples:
        key === "dimensions"
          ? normalizeDimensionsSamples(samples)
          : key === "position"
            ? normalizePositionSamples(samples)
            : normalizeScaleSamples(samples),
    };
  }
  return {
    ...scene,
    objectGraph: {
      ...scene.objectGraph,
      entities: {
        ...scene.objectGraph.entities,
        [target.id]: {
          ...target,
          geometry: {
            ...target.geometry,
            position: { kind: "known" as const, value: authority.baseCenter },
            ...(scaleBasis
              ? {
                  dimensions: { kind: "known" as const, value: scaleBasis.sourceDimensions },
                  scale: { kind: "known" as const, value: scaleBasis.relativeScale },
                }
              : {}),
          },
          lifetime: [
            {
              end: authority.duration,
              start: scaleBasis ? 0 : authority.sourceAnchor,
            },
          ],
        },
      },
    },
    propertyChannels,
  };
}

/** Common UI boundary: no other Program family may escape the bounded trace editor. */
export function studioPreviewRuntimeTraceTerminalProgramIsAuthorized(
  program: CanonicalEditProgram,
  authority: StudioPreviewRuntimeTraceTerminalEditProjection,
  authorizedResizeCenters: readonly Point[] = [authority.baseCenter],
) {
  const [operation] = program.operations;
  if (
    program.operations.length !== 1 ||
    !operation ||
    program.intentCount !== 1 ||
    program.loweringStatus !== "supported" ||
    program.provenance.origin !== "direct-manipulation" ||
    program.anchor.capturedPlayhead !== authority.sourceAnchor ||
    program.anchor.resolvedSeconds !== authority.sourceAnchor ||
    !(
      (program.anchor.source.kind === "absolute" && program.anchor.source.seconds === authority.sourceAnchor) ||
      (program.anchor.source.kind === "playhead" && program.anchor.source.referenceSeconds === authority.sourceAnchor)
    ) ||
    operation.dependsOn.length !== 0 ||
    operation.provenance.origin !== "direct-manipulation" ||
    operation.interval.start !== authority.sourceAnchor ||
    operation.interval.end !== authority.sourceAnchor ||
    !("entityId" in operation) ||
    operation.entityId !== authority.studioEntityId
  ) {
    return false;
  }
  if (operation.kind === "SetProperty" && operation.key === "position") {
    return (
      program.requestedExecution === "parallel" &&
      program.schedule.mode === "parallel" &&
      program.schedule.edges.length === 0 &&
      program.schedule.order.length === 1 &&
      program.schedule.order[0] === operation.id &&
      typeof operation.value === "object" &&
      operation.value !== null &&
      "x" in operation.value &&
      "y" in operation.value &&
      Number.isFinite(operation.value.x) &&
      Number.isFinite(operation.value.y)
    );
  }
  const scaleBasis = authority.uniformScaleBasis;
  if (
    !authority.capabilities.uniformScale ||
    !scaleBasis ||
    operation.kind !== "ResizeEntity" ||
    operation.shape !== "rectangle"
  ) {
    return false;
  }
  const from = operation.from.dimensions;
  const to = operation.to.dimensions;
  const factor =
    typeof to.width === "number" && typeof from.width === "number" && from.width > 0
      ? to.width / from.width
      : Number.NaN;
  return (
    program.requestedExecution === "sequence" &&
    program.schedule.mode === "sequence" &&
    program.schedule.edges.length === 0 &&
    program.schedule.order.length === 1 &&
    program.schedule.order[0] === operation.id &&
    operation.scale === scaleBasis.relativeScale &&
    from.radius === undefined &&
    from.height === scaleBasis.sourceDimensions.height &&
    from.width === scaleBasis.sourceDimensions.width &&
    to.radius === undefined &&
    typeof to.height === "number" &&
    typeof to.width === "number" &&
    Number.isFinite(to.height) &&
    Number.isFinite(to.width) &&
    Number.isFinite(factor) &&
    factor > 0 &&
    Math.abs(to.height / scaleBasis.sourceDimensions.height - factor) < 0.000001 &&
    Number.isFinite(operation.from.position.x) &&
    Number.isFinite(operation.from.position.y) &&
    Number.isFinite(operation.to.position.x) &&
    Number.isFinite(operation.to.position.y) &&
    Math.abs(operation.from.position.x - operation.to.position.x) < 0.000001 &&
    Math.abs(operation.from.position.y - operation.to.position.y) < 0.000001 &&
    authorizedResizeCenters.some(
      (center) =>
        Math.abs(operation.from.position.x - center.x) < 0.000001 &&
        Math.abs(operation.from.position.y - center.y) < 0.000001,
    )
  );
}

export type StudioPreviewRuntimeTraceTerminalOperationKind = "position" | "resize";

export type StudioPreviewRuntimeTraceTerminalProgramSet =
  | Readonly<{
      kind: "none";
      remainingOperations: readonly StudioPreviewRuntimeTraceTerminalOperationKind[];
    }>
  | Readonly<{
      kind: "authorized";
      operationKinds: readonly StudioPreviewRuntimeTraceTerminalOperationKind[];
      remainingOperations: readonly StudioPreviewRuntimeTraceTerminalOperationKind[];
    }>
  | Readonly<{ kind: "unauthorized" }>;

function runtimeTraceTerminalOperationKind(
  program: CanonicalEditProgram,
): StudioPreviewRuntimeTraceTerminalOperationKind | null {
  const operation = program.operations[0];
  if (operation?.kind === "SetProperty" && operation.key === "position") return "position";
  return operation?.kind === "ResizeEntity" ? "resize" : null;
}

/**
 * Exact #492 batch policy. The source lowerer accepts at most one move and one
 * resize, so the UI must validate the whole pending/applied set rather than
 * independently blessing whichever Program was staged last.
 */
export function studioPreviewRuntimeTraceTerminalProgramSet(
  records: readonly ProgramRecord[],
  authority: StudioPreviewRuntimeTraceTerminalEditProjection,
): StudioPreviewRuntimeTraceTerminalProgramSet {
  const allOperations: readonly StudioPreviewRuntimeTraceTerminalOperationKind[] = authority.capabilities.uniformScale
    ? ["position", "resize"]
    : ["position"];
  if (records.length === 0) return { kind: "none", remainingOperations: allOperations };
  if (records.length > 2) return { kind: "unauthorized" };
  const authorizedResizeCenters = [authority.baseCenter, runtimeTraceTerminalPendingPosition(records, authority)];
  const operationKinds: StudioPreviewRuntimeTraceTerminalOperationKind[] = [];
  for (const record of records) {
    const operationKind = runtimeTraceTerminalOperationKind(record.program);
    if (
      record.validation.status !== "valid" ||
      operationKind === null ||
      operationKinds.includes(operationKind) ||
      !studioPreviewRuntimeTraceTerminalProgramIsAuthorized(record.program, authority, authorizedResizeCenters)
    ) {
      return { kind: "unauthorized" };
    }
    operationKinds.push(operationKind);
  }
  return {
    kind: "authorized",
    operationKinds,
    remainingOperations: allOperations.filter((operation) => !operationKinds.includes(operation)),
  };
}

/** No epsilon is valid here: the retained AABB must be the exact source-anchor frame. */
export function studioPreviewRuntimeTraceTerminalAnchorIsExact(sampleTime: number, sourceAnchor: 5 | 14 = 5) {
  return sampleTime === sourceAnchor;
}

export type StudioPreviewRuntimeTraceTerminalUiState = Readonly<{
  baseFrameRetained: boolean;
  editAuthority: StudioPreviewRuntimeTraceTerminalEditProjection | null;
  pendingPresentation: StudioPreviewRuntimeTracePendingPresentation | null;
  programSet: StudioPreviewRuntimeTraceTerminalProgramSet;
}>;

function runtimeTraceTerminalPendingPosition(
  records: readonly ProgramRecord[],
  authority: StudioPreviewRuntimeTraceTerminalEditProjection,
) {
  for (const record of records) {
    const operation = record.program.operations[0];
    if (operation?.kind !== "SetProperty" || operation.key !== "position") continue;
    const value: unknown = operation.value;
    if (
      !value ||
      typeof value !== "object" ||
      !("x" in value) ||
      !("y" in value) ||
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y)
    ) {
      return authority.baseCenter;
    }
    return { x: value.x, y: value.y };
  }
  return authority.baseCenter;
}

function runtimeTraceTerminalPendingDimensions(
  records: readonly ProgramRecord[],
  authority: StudioPreviewRuntimeTraceTerminalEditProjection &
    Readonly<{ uniformScaleBasis: NonNullable<StudioPreviewRuntimeTraceTerminalEditProjection["uniformScaleBasis"]> }>,
) {
  for (const record of records) {
    const operation = record.program.operations[0];
    if (
      operation?.kind === "ResizeEntity" &&
      operation.shape === "rectangle" &&
      typeof operation.to.dimensions.height === "number" &&
      typeof operation.to.dimensions.width === "number"
    ) {
      return { height: operation.to.dimensions.height, width: operation.to.dimensions.width };
    }
  }
  return authority.uniformScaleBasis.sourceDimensions;
}

/**
 * Small, profile-specific state machine for the reviewed terminal edit
 * families. An authorized edit remains pending across scrub and Apply; only
 * operations explicitly listed by that profile remain available.
 */
export function resolveStudioPreviewRuntimeTraceTerminalUiState(
  input: Readonly<{
    atExactAnchor: boolean;
    contextMatches: boolean;
    presentedAuthority: StudioPreviewRuntimeTraceTerminalEditProjection | null;
    programRecords: readonly ProgramRecord[];
    retainedAuthority: StudioPreviewRuntimeTraceTerminalEditProjection | null;
    transientEdit: boolean;
    workingRevisionPristine: boolean;
  }>,
): StudioPreviewRuntimeTraceTerminalUiState {
  const evidenceAuthority = input.presentedAuthority ?? input.retainedAuthority;
  const programSet = evidenceAuthority
    ? studioPreviewRuntimeTraceTerminalProgramSet(input.programRecords, evidenceAuthority)
    : input.programRecords.length === 0
      ? ({ kind: "none", remainingOperations: ["position", "resize"] } as const)
      : ({ kind: "unauthorized" } as const);
  const authorizedEdit = programSet.kind === "authorized" && input.contextMatches && evidenceAuthority !== null;
  const pendingPresentation: StudioPreviewRuntimeTracePendingPresentation | null = authorizedEdit
    ? evidenceAuthority.uniformScaleBasis
      ? {
          baseFrameRetained: input.atExactAnchor && input.retainedAuthority !== null,
          dimensions: runtimeTraceTerminalPendingDimensions(input.programRecords, evidenceAuthority),
          draftGhost: "position-and-dimensions",
          position: runtimeTraceTerminalPendingPosition(input.programRecords, evidenceAuthority),
          renderProof: evidenceAuthority.renderProof,
          sourceAnchor: evidenceAuthority.sourceAnchor,
          studioEntityId: evidenceAuthority.studioEntityId,
          target: evidenceAuthority.target,
          validationStatusLabel: "Draft ghost · dependent updater validation pending",
        }
      : {
          baseFrameRetained: input.atExactAnchor && input.retainedAuthority !== null,
          dimensions: null,
          draftGhost: "position-only",
          position: runtimeTraceTerminalPendingPosition(input.programRecords, evidenceAuthority),
          renderProof: evidenceAuthority.renderProof,
          sourceAnchor: evidenceAuthority.sourceAnchor,
          studioEntityId: evidenceAuthority.studioEntityId,
          target: evidenceAuthority.target,
          validationStatusLabel: "Draft ghost · OpeningManim validation pending",
        }
    : null;
  const editAuthority =
    input.contextMatches && input.atExactAnchor
      ? programSet.kind === "authorized"
        ? programSet.remainingOperations.length > 0
          ? evidenceAuthority
          : null
        : programSet.kind === "none"
          ? (input.presentedAuthority ??
            (input.transientEdit && input.workingRevisionPristine ? input.retainedAuthority : null))
          : null
      : null;
  const baseFrameRetained =
    input.contextMatches &&
    input.atExactAnchor &&
    input.retainedAuthority !== null &&
    (input.transientEdit || pendingPresentation !== null);
  return { baseFrameRetained, editAuthority, pendingPresentation, programSet };
}

/**
 * The static importer intentionally does not model runtime-only roots such as
 * UpdatersExample's DecimalNumber or OpeningManim's generated NumberPlane.
 * For the sealed profiles only, expose the exact verified root as an opaque
 * selector. Every semantic geometry field remains unknown and it is never
 * added to App's editable entity collection.
 */
export function projectStudioPreviewRuntimeTraceOpaqueSelectionEntities(
  input: Readonly<{
    authority:
      | Pick<StudioPreviewRuntimeTraceUpdatersSelectionProfileV1, "profile" | "studioSceneId">
      | Pick<StudioPreviewRuntimeTraceOpeningSelectionProfileV2, "profile" | "studioSceneId">
      | null;
    interactionGeometry: StudioPreviewInteractionGeometryV1 | null;
    sourceRuntimeIdentity: StudioPreviewSourceRuntimeIdentityV1 | null;
  }>,
): readonly ProjectedEntity[] {
  if (!input.authority || !input.interactionGeometry || !input.sourceRuntimeIdentity) return [];
  const target =
    input.authority.profile === "updaters-terminal-v1"
      ? { label: "decimal · runtime", sourceName: "decimal", type: "DecimalNumber" }
      : { label: "grid", sourceName: "grid", type: "NumberPlane" };
  const mapping = input.sourceRuntimeIdentity.get(target.sourceName);
  if (mapping?.sourceName !== target.sourceName) return [];
  const geometry = input.interactionGeometry.get(mapping.entityId);
  if (!geometry) return [];
  const runtimeOnly = (field: string) => ({
    kind: "unknown" as const,
    reason: `The verified Runtime Trace owns ${field}; it is selection-only Studio evidence.`,
  });
  return [
    {
      content: { displayLines: [target.sourceName], label: target.label },
      geometry: {
        dimensions: runtimeOnly("visual bounds"),
        position: runtimeOnly("position"),
        scale: runtimeOnly("scale"),
        style: runtimeOnly("paint"),
      },
      id: `source:${input.authority.studioSceneId}:${target.sourceName}`,
      opacity: 1,
      position: geometry.position,
      present: true,
      provisional: false,
      scale: 1,
      sourceIdentity: { kind: "known", value: target.sourceName },
      type: target.type,
    },
  ];
}

/**
 * Runtime pixels may be presented without source interaction authority. V5
 * deliberately has aggregate morph lineage, while V9's pointwise-function
 * morph remains display-only unless the exact WarpSquare V9 temporal slice can
 * be truthfully rebased. V6 through V9 require server-verified source/runtime
 * bindings. V10 additionally requires the sealed LineJoints hierarchy and
 * admits mutation only for its runtime-proven center leaf. V11 requires its
 * complete SpiralIn hierarchy but remains selection-only because it has no
 * source rewrite contract. V12 admits only its exact source-bound example_tex
 * root for mutation; example_text remains a paint-free selector and both root
 * bounds come from their prepared drawable descendants. Older snapshot-only
 * profiles retain their semantic interaction fallback; no gesture guesses
 * from Scene order.
 */
export function studioPreviewInteractionAuthority(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
): StudioPreviewInteractionAuthority {
  const source = snapshot?.snapshot.scene.source;
  if (source?.kind === "imported-manim-runtime-trace") {
    const verifiedRuntimeEntityIds = snapshot?.sourceRuntimeIdentity
      ? [...snapshot.sourceRuntimeIdentity.values()].map(({ entityId }) => entityId)
      : [];
    // Generic V3 stays selection-only unless at least one exact initial-edit
    // candidate exists. Updater-conflicted or degenerate roots mint no
    // candidate and never receive a gesture; the browser may submit one
    // bounded request per candidate; the fresh-source server lowerer remains
    // the mutation authority.
    if (source.traceVersion === 3) {
      const candidates = snapshot ? studioPreviewGenericInitialEditCandidates(snapshot) : [];
      if (
        candidates.length > 0 &&
        candidates.every(({ runtimeEntityId }) => verifiedRuntimeEntityIds.includes(runtimeEntityId))
      ) {
        return {
          editableRuntimeEntityIds: candidates.map(({ runtimeEntityId }) => runtimeEntityId),
          kind: "bounded-interactive",
          reason: "runtime-trace-initial-edit",
          sourceAnchor: 0,
          verifiedRuntimeEntityIds,
        };
      }
      return {
        kind: "selection-only",
        reason: "runtime-trace-preview-only",
        verifiedRuntimeEntityIds,
      };
    }
    const terminalEdit = studioPreviewRuntimeTraceTerminalEditSeed(snapshot);
    if (terminalEdit) {
      return {
        editableRuntimeEntityId: terminalEdit.runtimeEntityId,
        kind: "bounded-interactive",
        reason: "runtime-trace-terminal-edit",
        sourceAnchor: terminalEdit.sourceAnchor,
        verifiedRuntimeEntityIds,
      };
    }
    return {
      kind: "selection-only",
      reason: "runtime-trace-preview-only",
      verifiedRuntimeEntityIds,
    };
  }
  if (source?.kind !== "imported-manim-server-snapshot") return { kind: "interactive" };
  if (Number(source.snapshotVersion) === 5) {
    return { kind: "display-only", reason: "aggregate-mathtex-morph-lineage" };
  }
  if (Number(source.snapshotVersion) === 9) {
    return snapshot && studioPreviewSyntheticInitialEditAnchor(snapshot) === 0
      ? { kind: "interactive" }
      : { kind: "display-only", reason: "temporal-rebase-unavailable" };
  }
  if (
    Number(source.snapshotVersion) !== 6 &&
    Number(source.snapshotVersion) !== 7 &&
    Number(source.snapshotVersion) !== 8 &&
    Number(source.snapshotVersion) !== 10 &&
    Number(source.snapshotVersion) !== 11 &&
    Number(source.snapshotVersion) !== 12
  ) {
    return { kind: "interactive" };
  }
  const identity = snapshot?.sourceRuntimeIdentity;
  if (
    Number(source.snapshotVersion) === 7 ||
    Number(source.snapshotVersion) === 8 ||
    Number(source.snapshotVersion) === 10 ||
    Number(source.snapshotVersion) === 11 ||
    Number(source.snapshotVersion) === 12
  ) {
    const entities = snapshot?.snapshot.scene.entities;
    const mappedEntityIds = new Set(identity ? [...identity.values()].map(({ entityId }) => entityId) : []);
    const writeStuffComplete = (() => {
      if (Number(source.snapshotVersion) !== 12 || !identity || !entities || entities.length !== 61) return false;
      const group = identity.get("group");
      const exampleText = identity.get("example_text");
      const exampleTex = identity.get("example_tex");
      if (
        identity.size !== 3 ||
        group?.sourceName !== "group" ||
        exampleText?.sourceName !== "example_text" ||
        exampleTex?.sourceName !== "example_tex"
      ) {
        return false;
      }
      const byId = new Map(entities.map((entity) => [entity.id, entity]));
      const groupEntity = byId.get(group.entityId);
      const textEntity = byId.get(exampleText.entityId);
      const texEntity = byId.get(exampleTex.entityId);
      return (
        groupEntity?.geometry.kind === "group" &&
        groupEntity.parentId === null &&
        groupEntity.sceneOrder === 0 &&
        textEntity?.geometry.kind === "group" &&
        textEntity.parentId === groupEntity.id &&
        textEntity.sceneOrder === 1 &&
        texEntity?.geometry.kind === "group" &&
        texEntity.parentId === groupEntity.id &&
        texEntity.sceneOrder === 32
      );
    })();
    const complete =
      Number(source.snapshotVersion) === 12
        ? writeStuffComplete
        : identity !== null &&
          identity !== undefined &&
          entities !== undefined &&
          mappedEntityIds.size === entities.length &&
          entities.every(({ id }) => mappedEntityIds.has(id));
    if (!complete) return { kind: "display-only", reason: "source-runtime-identity-unverified" };
    if (
      Number(source.snapshotVersion) !== 10 &&
      Number(source.snapshotVersion) !== 11 &&
      Number(source.snapshotVersion) !== 12
    ) {
      return { kind: "interactive" };
    }
    if (Number(source.snapshotVersion) === 11) {
      return { kind: "selection-only", reason: "source-edit-anchor-unavailable" };
    }
    const initialEditAuthority = snapshot ? studioPreviewInitialEditIntegrationAuthority(snapshot) : null;
    if (Number(source.snapshotVersion) === 12) {
      const exampleText = identity?.get("example_text");
      const exampleTex = identity?.get("example_tex");
      return initialEditAuthority?.profile === "write-stuff-v12" && exampleText && exampleTex
        ? { kind: "interactive", nestedGroupEntityIds: [exampleText.entityId, exampleTex.entityId] }
        : { kind: "selection-only", reason: "source-edit-anchor-unavailable" };
    }
    return initialEditAuthority?.profile === "line-joints-v10"
      ? { kind: "interactive" }
      : { kind: "selection-only", reason: "source-edit-anchor-unavailable" };
  }
  return identity && identity.size > 0
    ? { kind: "interactive" }
    : { kind: "display-only", reason: "source-runtime-identity-unverified" };
}

/** Local affine rebasing is truthful for WarpSquare V9 only at its source endpoint. */
export function studioPreviewEditedV9SampleFallbackV1(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
  workingRevision: string | null | undefined,
  sampleTime: number,
): PreviewRendererHostStateV1 | null {
  const source = snapshot?.snapshot.scene.source;
  const unsupported =
    source?.kind === "imported-manim-server-snapshot" &&
    Number(source.snapshotVersion) === 9 &&
    workingRevision !== null &&
    workingRevision !== undefined &&
    workingRevision !== PRISTINE_WORKING_REVISION &&
    sampleTime !== 0;
  return unsupported
    ? {
        detail: "A local WarpSquare edit is truthful only at t=0 until producer-backed reimport completes.",
        phase: "fallback",
        reason: "snapshot-uncorrelated",
      }
    : null;
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

export function studioPreviewPresentedSyntheticInitialEditAnchor(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
  state: PreviewRendererHostStateV1,
  authority: StudioPreviewInteractionAuthority,
) {
  const admitsInitialEdit =
    authority.kind === "interactive" ||
    (authority.kind === "bounded-interactive" && authority.reason === "runtime-trace-initial-edit");
  return snapshot && state.phase === "presented" && admitsInitialEdit
    ? studioPreviewSyntheticInitialEditAnchor(snapshot)
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

type StaticImportedRootMovePlan =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "unsupported"; message: string }>
  | Readonly<{
      delta: Point;
      kind: "authorized";
      operationId: string;
      runtimeEntityId: string;
    }>;

function isFinitePoint(value: unknown): value is Point {
  return isPointValue(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function planStaticImportedRootMove(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
  }>,
): StaticImportedRootMovePlan {
  const base = input.proposedState.base;
  const baseEntities = base.runtimeSceneState.objectGraph.entities;
  const operations = input.proposedState.programs.flatMap(({ program }) => program.operations);
  const existingPositionOperations = operations.filter(
    (operation) =>
      operation.kind === "SetProperty" &&
      operation.key === "position" &&
      baseEntities[operation.entityId] !== undefined,
  );
  if (existingPositionOperations.length === 0) return { kind: "not-applicable" };
  const scene = input.snapshot.snapshot.scene;
  if (scene.source.kind !== "imported-manim-server-snapshot") return { kind: "not-applicable" };
  if (existingPositionOperations.length > 1) {
    return { kind: "unsupported", message: "A static Rust move must target exactly one imported entity." };
  }
  if (operations.length > 1) {
    // Compound transforms remain on the existing adapter until Rust has an
    // equivalent atomic command; this slice claims only a standalone move.
    return { kind: "not-applicable" };
  }

  const [record] = input.proposedState.programs;
  const [operation] = record?.program.operations ?? [];
  if (
    input.proposedState.programs.length !== 1 ||
    !record ||
    record.validation.status !== "valid" ||
    record.program.operations.length !== 1 ||
    !operation ||
    operation.kind !== "SetProperty" ||
    operation.key !== "position" ||
    !isFinitePoint(operation.value)
  ) {
    return { kind: "unsupported", message: "The edit must contain one valid position operation." };
  }

  const program = record.program;
  const origin = program.provenance.origin;
  if (
    program.anchor.resolvedSeconds !== 0 ||
    operation.interval.start !== 0 ||
    operation.interval.end !== 0 ||
    program.loweringStatus !== "supported" ||
    (origin !== "direct-manipulation" && origin !== "studio-default") ||
    operation.provenance.origin !== origin
  ) {
    return { kind: "unsupported", message: "Only one exact t=0 pointer, keyboard, or Inspector move is supported." };
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

  const baseEntity = baseEntities[operation.entityId];
  if (
    !baseEntity ||
    baseEntity.sourceIdentity.kind !== "known" ||
    baseEntity.geometry?.position.kind !== "known" ||
    !isFinitePoint(baseEntity.geometry.position.value)
  ) {
    return { kind: "unsupported", message: "The moved Studio entity has no stable imported position identity." };
  }

  const identity = input.snapshot.sourceRuntimeIdentity;
  const sourceName = baseEntity.sourceIdentity.value;
  const mapping = identity?.get(sourceName);
  const runtimeEntity = mapping ? scene.entities.find(({ id }) => id === mapping.entityId) : null;
  if (
    !identity ||
    !mapping ||
    [...identity.values()].filter(({ entityId }) => entityId === mapping.entityId).length !== 1 ||
    !runtimeEntity ||
    runtimeEntity.parentId !== null
  ) {
    return { kind: "unsupported", message: "The Studio entity does not resolve to one verified runtime root." };
  }

  const baseCenter = studioPointToScenePointV1(
    baseEntity.geometry.position.value,
    input.frame,
    scene.camera.view.center,
  );
  const targetCenter = studioPointToScenePointV1(operation.value, input.frame, scene.camera.view.center);
  const delta = { x: targetCenter.x - baseCenter.x, y: targetCenter.y - baseCenter.y };
  if (!isFinitePoint(delta) || (delta.x === 0 && delta.y === 0)) {
    return { kind: "unsupported", message: "The static root move must have one finite non-zero displacement." };
  }
  return {
    delta,
    kind: "authorized",
    operationId: operation.id,
    runtimeEntityId: runtimeEntity.id,
  };
}

export async function compileStudioPreviewSceneV1(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    mathTexOutlineCompiler?: MathTexOutlineCompilerV1;
    moveCompiler?: MoveSceneEntityCompiler;
    proposedState: ProposedState;
    rotationCompiler?: RotateSceneEntityCompiler;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    subtreePaintAlphaCompiler?: SetSubtreeVectorPaintAlphaCompiler;
    uniformScaleCompiler?: UniformScaleSceneEntityCompiler;
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
          studioPreviewInteractionAuthority(input.snapshot),
          snapshot.scene.entities,
        ),
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      },
    };
  }
  const importedSource = input.snapshot.snapshot.scene.source;
  if (importedSource.kind === "imported-manim-runtime-trace" && importedSource.traceVersion === 3) {
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      studioScene: input.proposedState.evaluatedScene,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    const rebased = await compileStudioPreviewGenericInitialEdit({
      frame: input.frame,
      moveCompiler: input.moveCompiler,
      proposedState: input.proposedState,
      rotationCompiler: input.rotationCompiler,
      snapshot: input.snapshot,
      sourceRevisionHash: engineRevisionHash,
      subtreePaintAlphaCompiler: input.subtreePaintAlphaCompiler,
      uniformScaleCompiler: input.uniformScaleCompiler,
    });
    if (rebased.kind === "unsupported") {
      return {
        error: `Generic Runtime Trace initial edit is unsupported (${rebased.issue.code}): ${rebased.issue.message}`,
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
          studioPreviewInteractionAuthority(input.snapshot),
          rebased.scene.entities,
        ),
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      },
    };
  }
  const importedProfile =
    importedSource.kind === "imported-manim-server-snapshot" ? Number(importedSource.snapshotVersion) : null;
  if (input.snapshot.snapshot.scene.animationChannels.length > 0 || importedProfile === 10) {
    const source = input.snapshot.snapshot.scene.source;
    if (
      source.kind !== "imported-manim-server-snapshot" ||
      (Number(source.snapshotVersion) !== 7 &&
        Number(source.snapshotVersion) !== 8 &&
        Number(source.snapshotVersion) !== 9 &&
        Number(source.snapshotVersion) !== 10 &&
        Number(source.snapshotVersion) !== 12)
    ) {
      return {
        error: "Editing a verified Scene with imported animation channels requires temporal rebasing support.",
        kind: "unsupported",
      };
    }
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      studioScene: input.proposedState.evaluatedScene,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    const rebased = compileStudioPreviewTemporalRebase({
      frame: input.frame,
      proposedState: input.proposedState,
      snapshot: input.snapshot,
      sourceRevisionHash: engineRevisionHash,
    });
    if (rebased.kind === "unsupported") {
      return {
        error: `Imported temporal rebase is unsupported (${rebased.issue.code}): ${rebased.issue.message}`,
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
          studioPreviewInteractionAuthority(input.snapshot),
          rebased.scene.entities,
        ),
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      },
    };
  }
  const staticRootMove = planStaticImportedRootMove(input);
  if (staticRootMove.kind === "unsupported") {
    return { error: `Static imported root move is unsupported: ${staticRootMove.message}`, kind: "unsupported" };
  }
  if (staticRootMove.kind === "authorized") {
    const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
      frame: input.frame,
      snapshot: input.snapshot,
      studioScene: input.proposedState.evaluatedScene,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    });
    try {
      const bundle = await (input.moveCompiler ?? compileMoveSceneEntity)(input.snapshot.snapshot, {
        delta: staticRootMove.delta,
        entityId: staticRootMove.runtimeEntityId,
        expectedBaseRevision: input.snapshot.correlation.engineRevisionHash,
        nextRevision: engineRevisionHash,
        provenance: {
          evidence: [
            "Studio t=0 position request projected onto one verified static imported root",
            `authorized operation ${staticRootMove.operationId}`,
          ],
          id: `studio-static-move:${engineRevisionHash}`,
          origin: "studio-edit-program",
        },
        schema: "poietra.move-scene-entity",
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
            studioPreviewInteractionAuthority(input.snapshot),
            bundle.scene.entities,
          ),
          snapshot: input.snapshot,
          workingRevision: input.workingRevision,
          workspaceKey: input.workspaceKey,
        },
      };
    } catch (error) {
      return {
        error: `Rust core rejected the static imported root move: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        kind: "unsupported",
      };
    }
  }
  const outlineInputs = collectStudioMathTexOutlineInputsV1(input.proposedState);
  if (outlineInputs.kind === "unsupported") {
    return { error: outlineInputs.issues.map(({ message }) => message).join(" "), kind: "unsupported" };
  }
  const mathTexOutlines: Record<string, MathTexOutlineArtifactV1> = {};
  try {
    const compiler = input.mathTexOutlineCompiler ?? compileMathTexOutlineV1;
    const responses = await Promise.all(
      outlineInputs.inputs.map(async ({ entityId, texParts }) => ({
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
  const evidence = buildStudioSceneIrAdapterEvidenceV1({
    mathTexOutlines,
    proposedState: input.proposedState,
    snapshot: input.snapshot.snapshot,
    sourceRuntimeIdentity: input.snapshot.sourceRuntimeIdentity,
  });
  if (evidence.kind === "unsupported") {
    return { error: evidence.issues.map(({ message }) => message).join(" "), kind: "unsupported" };
  }
  const engineRevisionHash = await digestStudioPreviewSceneRevisionV1({
    frame: input.frame,
    mathTexOutlines,
    snapshot: input.snapshot,
    studioScene: input.proposedState.evaluatedScene,
    workingRevision: input.workingRevision,
    workspaceKey: input.workspaceKey,
  });
  const compiled = await compileStudioSceneIrV1({
    assets: input.snapshot.snapshot.assets,
    evidence: evidence.evidence,
    frame: input.frame,
    proposedState: input.proposedState,
    sourceRevisionHash: engineRevisionHash,
  });
  if (compiled.kind === "unsupported") {
    return { error: compiled.issues.map(({ message }) => message).join(" "), kind: "unsupported" };
  }
  const bundle = { assets: input.snapshot.snapshot.assets, scene: compiled.scene };
  return {
    kind: "compiled",
    scene: {
      bundle,
      engineRevisionHash,
      frame: { ...input.frame },
      interactionEntityIds: compiled.scene.entities.map(({ id }) => id).slice(0, MAX_CANVAS_INTERACTION_ENTITY_IDS),
      snapshot: input.snapshot,
      workingRevision: input.workingRevision,
      workspaceKey: input.workspaceKey,
    },
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
    committedProposedState,
    context,
    draftProposedState,
    frame,
    provider,
    retainedSourceDuration,
    runtimeTraceTerminalProgramRecords,
    sampleTime,
    transientEdit,
  } = input;
  const [bound, setBound] = useState<BoundHostStateV1 | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [metadata, setMetadata] = useState<StudioPreviewSnapshotMetadataStateV1>(INACTIVE_METADATA);
  const [compilation, setCompilation] = useState<StudioPreviewCompilationStateV1>(INACTIVE_COMPILATION);
  const [installation, setInstallation] = useState<StudioPreviewHostInstallationV1 | null>(null);
  const [viewport, setViewport] = useState<PreviewViewportV1 | null>(null);
  const latestCommittedProposedState = useRef(committedProposedState);
  latestCommittedProposedState.current = committedProposedState;
  const latestDraftProposedState = useRef(draftProposedState);
  latestDraftProposedState.current = draftProposedState;
  const retainedRuntimeTraceTerminalFrame = useRef<Readonly<{
    authority: StudioPreviewRuntimeTraceTerminalEditProjection;
    geometry: StudioPreviewInteractionGeometryV1;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    workspaceKey: string;
  }> | null>(null);
  const queuedScene = useRef<Readonly<{
    binding: StudioPreviewHostBindingV1;
    scene: CompiledStudioPreviewSceneV1;
  }> | null>(null);

  const eligibility = useMemo(
    () =>
      evaluateStudioPreviewEligibilityV1({
        ...detectStudioPreviewCapabilitiesV1(),
        providerAvailable: provider !== null,
      }),
    [provider],
  );

  // The Scene identity that owns the installed worker; the working revision
  // gates presentation instead of tearing the retained worker down. A project
  // switch always changes the key, even onto a Scene with an identical source
  // hash and name.
  const workspaceKey = context ? studioPreviewWorkspaceKeyV1(context) : null;
  const currentMetadata = studioPreviewSnapshotMetadataForWorkspaceV1(metadata, { provider, workspaceKey });
  const snapshot = currentMetadata.phase === "ready" ? currentMetadata.snapshot : null;
  const snapshotError = currentMetadata.phase === "failed" ? currentMetadata.error : null;
  const runtimeTraceSelectionProfile =
    studioPreviewRuntimeTraceUpdatersSelectionProfileV1(snapshot) ??
    studioPreviewRuntimeTraceOpeningSelectionProfileV2(snapshot);
  const runtimeTraceTerminalSeed = studioPreviewRuntimeTraceTerminalEditSeed(snapshot);
  const genericInitialEditCandidates = snapshot ? studioPreviewGenericInitialEditCandidates(snapshot) : [];

  useEffect(() => {
    const proposedState =
      snapshot && studioPreviewSyntheticInitialEditAnchor(snapshot) !== null
        ? (latestDraftProposedState.current ?? latestCommittedProposedState.current)
        : latestCommittedProposedState.current;
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
      setViewport(snapStudioPreviewViewportV1({ height: rect.height, width: rect.width }, cameraAspect));
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
    const binding: StudioPreviewHostBindingV1 = { canvas: canvasEl, provider, snapshot, workspaceKey };
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

  useEffect(() => {
    host?.setTransientEdit(transientEdit);
  }, [host, transientEdit]);

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
    studioPreviewHostBindingCurrentV1(bound.binding, { canvas: canvasEl, provider, snapshot, workspaceKey });

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
    const editedV9SampleFallback = studioPreviewEditedV9SampleFallbackV1(
      snapshot,
      context?.workingRevision,
      sampleTime,
    );
    if (editedV9SampleFallback) return editedV9SampleFallback;
    if (compilationError) {
      return {
        detail: compilationError,
        phase: "fallback",
        reason: "snapshot-uncorrelated",
      };
    }
    return resolveStudioPreviewViewStateV1({
      context,
      eligibility,
      hostActive: bindingCurrent,
      hostState: bound !== null && bindingCurrent ? bound.state : INSTALLING_STATE,
      sampleTime,
      snapshot,
      snapshotError,
      transientEdit,
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
    transientEdit,
    viewport,
  ]);

  // Geometry comes from the exact prepared vertices of this correlated frame.
  // Non-present or unavailable entries retain the semantic DOM hit targets.
  const interactionGeometry = useMemo(
    () =>
      state.phase === "presented"
        ? projectStudioPreviewInteractionGeometryV1(interactionEntityIds, state.frame.interaction, frame)
        : null,
    [frame, interactionEntityIds, state],
  );
  if (!provider) return null;
  const snapshotInteractionAuthority = studioPreviewInteractionAuthority(snapshot);
  const contextMatchesRuntimeTraceTerminalSeed =
    runtimeTraceTerminalSeed !== null &&
    context !== null &&
    snapshot !== null &&
    studioPreviewSnapshotMatchesSourceV1(snapshot.correlation, context);
  const atRuntimeTraceTerminalAnchor =
    runtimeTraceTerminalSeed !== null &&
    studioPreviewRuntimeTraceTerminalAnchorIsExact(sampleTime, runtimeTraceTerminalSeed.sourceAnchor);
  const terminalGeometry =
    runtimeTraceTerminalSeed && interactionGeometry
      ? interactionGeometry.get(runtimeTraceTerminalSeed.runtimeEntityId)
      : null;
  const presentedRuntimeTraceTerminalAuthority =
    runtimeTraceTerminalSeed &&
    terminalGeometry &&
    state.phase === "presented" &&
    studioPreviewRuntimeTraceTerminalAnchorIsExact(state.frame.sampleTime, runtimeTraceTerminalSeed.sourceAnchor) &&
    atRuntimeTraceTerminalAnchor &&
    contextMatchesRuntimeTraceTerminalSeed &&
    context?.workingRevision === PRISTINE_WORKING_REVISION
      ? { ...runtimeTraceTerminalSeed, baseCenter: terminalGeometry.position }
      : null;
  if (presentedRuntimeTraceTerminalAuthority && interactionGeometry && snapshot && workspaceKey !== null) {
    retainedRuntimeTraceTerminalFrame.current = {
      authority: presentedRuntimeTraceTerminalAuthority,
      geometry: interactionGeometry,
      snapshot,
      workspaceKey,
    };
  }
  const retainedTerminalFrame = retainedRuntimeTraceTerminalFrame.current;
  const retainedTerminalFrameContextCurrent =
    retainedTerminalFrame !== null &&
    retainedTerminalFrame.snapshot === snapshot &&
    retainedTerminalFrame.workspaceKey === workspaceKey &&
    contextMatchesRuntimeTraceTerminalSeed
      ? retainedTerminalFrame
      : null;
  const runtimeTraceTerminalUiState = resolveStudioPreviewRuntimeTraceTerminalUiState({
    atExactAnchor: atRuntimeTraceTerminalAnchor,
    contextMatches: contextMatchesRuntimeTraceTerminalSeed,
    presentedAuthority: presentedRuntimeTraceTerminalAuthority,
    programRecords: runtimeTraceTerminalProgramRecords,
    retainedAuthority: retainedTerminalFrameContextCurrent?.authority ?? null,
    transientEdit,
    workingRevisionPristine: context?.workingRevision === PRISTINE_WORKING_REVISION,
  });
  const runtimeTracePendingPresentation = runtimeTraceTerminalUiState.pendingPresentation;
  const runtimeTraceTerminalEdit = runtimeTraceTerminalUiState.editAuthority;
  const interactionAuthority: StudioPreviewInteractionAuthority =
    snapshotInteractionAuthority.kind !== "bounded-interactive" ||
    snapshotInteractionAuthority.reason === "runtime-trace-initial-edit" ||
    runtimeTraceTerminalEdit
      ? snapshotInteractionAuthority
      : {
          kind: "selection-only",
          reason: "runtime-trace-preview-only",
          verifiedRuntimeEntityIds: snapshotInteractionAuthority.verifiedRuntimeEntityIds,
        };
  const presentedOrRetainedInteractionGeometry =
    interactionGeometry ??
    (runtimeTraceTerminalUiState.baseFrameRetained ? (retainedTerminalFrameContextCurrent?.geometry ?? null) : null);
  const runtimeTraceOpaqueSelectionEntities = projectStudioPreviewRuntimeTraceOpaqueSelectionEntities({
    authority: runtimeTraceSelectionProfile,
    interactionGeometry: presentedOrRetainedInteractionGeometry,
    sourceRuntimeIdentity: snapshot?.sourceRuntimeIdentity ?? null,
  });
  return {
    attachCanvas,
    cameraCenter: snapshot ? { ...snapshot.snapshot.scene.camera.view.center } : null,
    epoch,
    genericInitialEditCandidates,
    initialEditAuthority: snapshot
      ? ((authority) => (authority ? studioPreviewInitialEditProjection(authority) : null))(
          studioPreviewInitialEditIntegrationAuthority(snapshot),
        )
      : null,
    interactionGeometry: presentedOrRetainedInteractionGeometry,
    interactionAuthority,
    runtimeTraceBaseFrameRetained: runtimeTraceTerminalUiState.baseFrameRetained,
    runtimeTraceTerminalEdit,
    runtimeTraceOpaqueSelectionEntities,
    runtimeTracePendingPresentation,
    sourceLabel: snapshot?.sourceLabel ?? null,
    sourceMetadataFailureKind: currentMetadata.phase === "failed" ? currentMetadata.failureKind : null,
    sourceMetadataPhase: currentMetadata.phase,
    sourceRuntimeIdentity: snapshot?.sourceRuntimeIdentity ?? null,
    state,
    syntheticInitialEditAnchor: studioPreviewPresentedSyntheticInitialEditAnchor(snapshot, state, interactionAuthority),
    verifiedSourceDuration,
  };
}
