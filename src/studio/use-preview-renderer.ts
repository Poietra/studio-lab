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
import { createSceneIrDeltaV1, type SceneIrDeltaV1 } from "../engine/scene-delta";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import {
  buildStudioSceneIrAdapterEvidenceV1,
  collectStudioMathTexOutlineInputsV1,
  compileStudioSceneIrV1,
} from "../engine/studio-scene-adapter";
import type { ProposedState } from "./model";
import {
  detectStudioPreviewCapabilitiesV1,
  evaluateStudioPreviewEligibilityV1,
  projectStudioPreviewInteractionGeometryV1,
  resolveStudioPreviewViewStateV1,
  type StudioPreviewHostBindingV1,
  type StudioPreviewInteractionGeometryV1,
  snapStudioPreviewViewportV1,
  studioPreviewHostBindingCurrentV1,
  studioPreviewVerifiedSourceDurationV1,
} from "./preview-renderer-policy";
import {
  loadStudioPreviewSnapshotMetadataV1,
  PRISTINE_WORKING_REVISION,
  type StudioPreviewEditingContextV1,
  type StudioPreviewSnapshotProviderV1,
  type StudioPreviewSourceRuntimeIdentityV1,
  type StudioVerifiedPreviewSnapshotV1,
  studioPreviewWorkspaceKeyV1,
} from "./preview-snapshot-provider";
import {
  compileStudioPreviewTemporalRebaseV1,
  type StudioPreviewInitialEditRuntimeAuthorityV1,
  studioPreviewInitialEditRuntimeAuthorityV1,
  studioPreviewSyntheticInitialEditAnchorV1,
} from "./preview-temporal-rebase";

export type StudioPreviewRendererViewV1 = Readonly<{
  attachCanvas: (canvas: HTMLCanvasElement | null) => void;
  /** Verified world-space center used to project Studio viewport positions. */
  cameraCenter: Readonly<{ x: number; y: number }> | null;
  epoch: number;
  /**
   * Hit-target geometry derived from that frame's prepared GPU vertices,
   * keyed by verified runtime entity ID; non-null only while correlated.
   */
  interactionGeometry: StudioPreviewInteractionGeometryV1 | null;
  interactionAuthority: StudioPreviewInteractionAuthorityV1;
  /** Exact runtime authority for one bounded initial imported-Scene edit. */
  initialEditRuntimeAuthority: StudioPreviewInitialEditRuntimeAuthorityV1 | null;
  sourceLabel: string | null;
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

export type StudioPreviewInteractionAuthorityV1 =
  | Readonly<{ kind: "interactive"; nestedGroupEntityIds?: readonly string[] }>
  | Readonly<{ kind: "selection-only"; reason: "source-edit-anchor-unavailable" }>
  | Readonly<{
      kind: "display-only";
      reason: "aggregate-mathtex-morph-lineage" | "source-runtime-identity-unverified" | "temporal-rebase-unavailable";
    }>;

export type UseStudioPreviewRendererInputV1 = Readonly<{
  committedProposedState: ProposedState | null;
  context: StudioPreviewEditingContextV1 | null;
  draftProposedState: ProposedState | null;
  frame: Readonly<{ height: number; width: number }>;
  provider: StudioPreviewSnapshotProviderV1 | null;
  retainedSourceDuration: number | null;
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
export function studioPreviewInteractionAuthorityV1(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
): StudioPreviewInteractionAuthorityV1 {
  const source = snapshot?.snapshot.scene.source;
  if (source?.kind !== "imported-manim-server-snapshot") return { kind: "interactive" };
  if (Number(source.snapshotVersion) === 5) {
    return { kind: "display-only", reason: "aggregate-mathtex-morph-lineage" };
  }
  if (Number(source.snapshotVersion) === 9) {
    return snapshot && studioPreviewSyntheticInitialEditAnchorV1(snapshot) === 0
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
    const initialEditAuthority = snapshot ? studioPreviewInitialEditRuntimeAuthorityV1(snapshot) : null;
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
  authority: StudioPreviewInteractionAuthorityV1 = { kind: "interactive" },
  entities: SceneIrBundleV1["scene"]["entities"] | null = null,
) {
  if (authority.kind === "display-only") return [];
  if (!identity) return [];
  // Canvas interaction must be derived from the verified render graph: a
  // top-level logical group has source identity but no independently useful
  // hit target. A nested source-bound group is selectable only when the worker
  // can aggregate prepared descendant bounds (V12 Tex/MathTex). Missing Scene
  // evidence remains fail-closed for selection-only mode.
  const editableNestedGroups =
    authority.kind === "interactive" ? new Set(authority.nestedGroupEntityIds ?? []) : new Set<string>();
  const drawableEntityIds =
    entities === null
      ? authority.kind === "selection-only"
        ? new Set<string>()
        : null
      : new Set(
          entities
            .filter(
              ({ geometry, id, parentId }) =>
                geometry.kind !== "group" ||
                (authority.kind === "selection-only" && parentId !== null) ||
                editableNestedGroups.has(id),
            )
            .map(({ id }) => id),
        );
  const entityIds: string[] = [];
  const seen = new Set<string>();
  for (const mapping of identity.values()) {
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

/** Unexpected producer failures use the same explicit full-snapshot recovery as an oversized delta. */
export async function createStudioPreviewDeltaOrReplacementV1(
  base: SceneIrBundleV1,
  next: SceneIrBundleV1,
  producer: (base: SceneIrBundleV1, next: SceneIrBundleV1) => Promise<SceneIrDeltaV1 | null> = createSceneIrDeltaV1,
) {
  try {
    return await producer(base, next);
  } catch {
    return null;
  }
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

export async function compileStudioPreviewSceneV1(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    mathTexOutlineCompiler?: MathTexOutlineCompilerV1;
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
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
    if (
      snapshot.scene.source.kind !== "imported-manim-server-snapshot" ||
      sceneIrSourceRevisionHash(snapshot.scene) !== correlation.engineRevisionHash ||
      snapshot.scene.source.sourceHash !== correlation.context.sourceHash ||
      snapshot.assets.manifestDigest !== correlation.assetsManifestDigest ||
      snapshot.scene.sceneId !== correlation.sceneId ||
      input.snapshot.sceneId !== correlation.sceneId ||
      snapshot.scene.duration !== correlation.sceneDuration ||
      input.snapshot.duration !== correlation.sceneDuration ||
      correlation.sceneDuration !== correlation.context.sourceDuration ||
      correlation.context.workingRevision !== PRISTINE_WORKING_REVISION
    ) {
      return { error: "The base server snapshot has inconsistent revision evidence.", kind: "unsupported" };
    }
    return {
      kind: "compiled",
      scene: {
        bundle: snapshot,
        engineRevisionHash: correlation.engineRevisionHash,
        frame: { ...input.frame },
        interactionEntityIds: studioPreviewInteractionEntityIdsV1(
          input.snapshot.sourceRuntimeIdentity,
          studioPreviewInteractionAuthorityV1(input.snapshot),
          snapshot.scene.entities,
        ),
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      },
    };
  }
  const importedSource = input.snapshot.snapshot.scene.source;
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
    const rebased = compileStudioPreviewTemporalRebaseV1({
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
          studioPreviewInteractionAuthorityV1(input.snapshot),
          rebased.scene.entities,
        ),
        snapshot: input.snapshot,
        workingRevision: input.workingRevision,
        workspaceKey: input.workspaceKey,
      },
    };
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

export function useStudioPreviewRenderer(input: UseStudioPreviewRendererInputV1): StudioPreviewRendererViewV1 | null {
  const {
    committedProposedState,
    context,
    draftProposedState,
    frame,
    provider,
    retainedSourceDuration,
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
  const latestCompiledScene = useRef<CompiledStudioPreviewSceneV1 | null>(null);
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

  useEffect(() => {
    const proposedState =
      snapshot && studioPreviewSyntheticInitialEditAnchorV1(snapshot) !== null
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
  latestCompiledScene.current = currentCompiledScene;
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
    let cancelled = false;
    const base = queued.scene;
    const dispatchUpdate = (delta: SceneIrDeltaV1 | null) => {
      if (cancelled || latestCompiledScene.current !== currentCompiledScene || queuedScene.current !== queued) return;
      queuedScene.current = { binding: updateBinding, scene: currentCompiledScene };
      void updateHost
        .update({
          assetPayloads: currentCompiledScene.snapshot.assetPayloads,
          delta,
          interactionEntityIds: currentCompiledScene.interactionEntityIds,
          revision: currentCompiledScene.engineRevisionHash,
          snapshot: currentCompiledScene.bundle,
        })
        .catch(() => undefined);
    };
    void createStudioPreviewDeltaOrReplacementV1(base.bundle, currentCompiledScene.bundle).then(dispatchUpdate, () =>
      dispatchUpdate(null),
    );
    return () => {
      cancelled = true;
    };
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
  const interactionAuthority = studioPreviewInteractionAuthorityV1(snapshot);
  return {
    attachCanvas,
    cameraCenter: snapshot ? { ...snapshot.snapshot.scene.camera.view.center } : null,
    epoch,
    initialEditRuntimeAuthority: snapshot ? studioPreviewInitialEditRuntimeAuthorityV1(snapshot) : null,
    interactionGeometry,
    interactionAuthority,
    sourceLabel: snapshot?.sourceLabel ?? null,
    sourceMetadataPhase: currentMetadata.phase,
    sourceRuntimeIdentity: snapshot?.sourceRuntimeIdentity ?? null,
    state,
    syntheticInitialEditAnchor:
      snapshot && state.phase === "presented" && interactionAuthority.kind === "interactive"
        ? studioPreviewSyntheticInitialEditAnchorV1(snapshot)
        : null,
    verifiedSourceDuration,
  };
}
