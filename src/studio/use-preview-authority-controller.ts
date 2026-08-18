import { useCallback, useEffect, useLayoutEffect, useReducer, useSyncExternalStore } from "react";
import type { StaticPrimitiveTransformSourceFactV1 } from "../render-pipeline/contracts";
import type { SceneFragmentMaterialStateV1 } from "./fragment-material-authoring";
import type { WorkingState } from "./model";
import {
  createUnavailableStudioPreviewSnapshotProviderV1,
  resolveStudioPreviewSnapshotProvider,
  type StudioPreviewEditingContextV1,
  type StudioPreviewProviderKind,
  type StudioPreviewSnapshotProviderV1,
} from "./preview-snapshot-provider";
import { type StudioPreviewRendererView, useStudioPreviewRenderer } from "./use-preview-renderer";

export type StudioPreviewAuthorityState =
  | Readonly<{
      generation: number;
      phase: "awaiting-consent" | "resolving";
      provider: null;
      providerKind: StudioPreviewProviderKind;
      projectId: string | null;
    }>
  | Readonly<{
      generation: number;
      phase: "active";
      provider: StudioPreviewSnapshotProviderV1;
      providerKind: StudioPreviewProviderKind;
      projectId: string | null;
    }>;

export type StudioPreviewAuthorityAction =
  | Readonly<{ projectId: string | null; providerKind: StudioPreviewProviderKind; type: "configure" }>
  | Readonly<{ allowed: boolean; type: "activate" }>
  | Readonly<{ allowed: boolean; type: "retry" }>
  | Readonly<{
      generation: number;
      provider: StudioPreviewSnapshotProviderV1;
      type: "provider-resolved";
    }>;

type UseStudioPreviewAuthorityControllerInput = Readonly<{
  context: StudioPreviewEditingContextV1 | null;
  frame: Readonly<{ height: number; width: number }>;
  sceneFragmentMaterials?: SceneFragmentMaterialStateV1;
  retainedSourceDuration: number | null;
  sampleTime: number;
  sceneBoundaryActive: boolean;
  sourceEvents: WorkingState["runtimeSceneState"]["eventTrack"]["events"];
  staticPrimitiveTransforms: readonly StaticPrimitiveTransformSourceFactV1[];
  workingState: WorkingState | null;
}>;

export type StudioPreviewAuthorityControllerView = Readonly<{
  activate: () => boolean;
  activationAllowed: boolean;
  awaitingConsent: boolean;
  providerPending: boolean;
  renderer: StudioPreviewRendererView | null;
  retry: () => boolean;
}>;

const STUDIO_PREVIEW_RENDERER_QUERY_PARAM = "previewRenderer";

function authorityStateForProvider(
  state: StudioPreviewAuthorityState,
  providerKind: StudioPreviewProviderKind,
  projectId: string | null,
): StudioPreviewAuthorityState {
  // Closing a workspace temporarily clears context; retain that scope so
  // reopening the same project in this tab does not prompt again. A different
  // non-null project always revokes the previous execution consent.
  const nextProjectId = projectId ?? state.projectId;
  if (state.providerKind === providerKind && state.projectId === nextProjectId) return state;
  return {
    generation: state.generation + 1,
    phase: "awaiting-consent",
    provider: null,
    providerKind,
    projectId: nextProjectId,
  };
}

export function createStudioPreviewAuthorityState(
  providerKind: StudioPreviewProviderKind,
): StudioPreviewAuthorityState {
  return { generation: 0, phase: "awaiting-consent", provider: null, providerKind, projectId: null };
}

/**
 * Owns the execution-consent boundary and monotonic provider generation. A
 * resolution can become active only for the exact request the user approved,
 * so URL fixture changes can never install a stale provider over the canonical
 * server provider.
 */
export function reduceStudioPreviewAuthority(
  state: StudioPreviewAuthorityState,
  action: StudioPreviewAuthorityAction,
): StudioPreviewAuthorityState {
  if (action.type === "configure") return authorityStateForProvider(state, action.providerKind, action.projectId);
  if (action.type === "activate") {
    if (!action.allowed || state.phase !== "awaiting-consent") return state;
    return { ...state, generation: state.generation + 1, phase: "resolving" };
  }
  if (action.type === "retry") {
    if (!action.allowed || state.phase !== "active") return state;
    return { ...state, generation: state.generation + 1, phase: "resolving", provider: null };
  }
  if (state.phase !== "resolving" || state.generation !== action.generation) return state;
  return { ...state, phase: "active", provider: action.provider };
}

/**
 * The production server provider is the standard authority. A recognized
 * DEV-only fixture query replaces it without making unknown query values an
 * opt-out from canonical rendering.
 */
export function selectStudioPreviewProvider(
  browserSearch: string | null,
  fixtureAllowed: boolean,
): StudioPreviewProviderKind {
  const requested = new URLSearchParams(browserSearch ?? "").get(STUDIO_PREVIEW_RENDERER_QUERY_PARAM);
  return fixtureAllowed &&
    (requested === "fixture" || requested === "mathtex-fixture" || requested === "export-fixture")
    ? requested
    : "server";
}

type StudioPreviewLocationSearchSources = Readonly<{
  navigationTarget: EventTarget | null;
  traversalTarget: EventTarget | null;
}>;

export function studioPreviewLocationSearchSnapshot(locationValue: Readonly<{ search: string }> | null) {
  return locationValue?.search ?? null;
}

/** Browser traversal is universally observable through popstate. The
 * Navigation API additionally reports same-document pushState/replaceState
 * without patching the shared History methods. */
export function subscribeStudioPreviewLocationSearchChanges(
  sources: StudioPreviewLocationSearchSources,
  onStoreChange: () => void,
) {
  sources.traversalTarget?.addEventListener("popstate", onStoreChange);
  sources.navigationTarget?.addEventListener("currententrychange", onStoreChange);
  return () => {
    sources.traversalTarget?.removeEventListener("popstate", onStoreChange);
    sources.navigationTarget?.removeEventListener("currententrychange", onStoreChange);
  };
}

function eventTargetOrNull(value: unknown): EventTarget | null {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as EventTarget).addEventListener !== "function" ||
    typeof (value as EventTarget).removeEventListener !== "function"
  )
    return null;
  return value as EventTarget;
}

function currentBrowserSearch() {
  return studioPreviewLocationSearchSnapshot(typeof location === "undefined" ? null : location);
}

function serverBrowserSearch() {
  return null;
}

function subscribeBrowserSearch(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return subscribeStudioPreviewLocationSearchChanges(
      { navigationTarget: null, traversalTarget: null },
      onStoreChange,
    );
  }
  const navigationTarget = eventTargetOrNull((window as Window & { navigation?: unknown }).navigation);
  return subscribeStudioPreviewLocationSearchChanges({ navigationTarget, traversalTarget: window }, onStoreChange);
}

function activationIsAllowed() {
  return typeof window === "undefined" || window.top === window.self;
}

/**
 * Composes the canonical provider and renderer authority. Selecting the server
 * provider is automatic, but executing workspace Python still requires a
 * top-level-tab confirmation. The lower hook owns snapshot, worker and canvas
 * resources only after that boundary.
 */
export function useStudioPreviewAuthorityController({
  context,
  frame,
  sceneFragmentMaterials,
  retainedSourceDuration,
  sampleTime,
  sceneBoundaryActive,
  sourceEvents,
  staticPrimitiveTransforms,
  workingState,
}: UseStudioPreviewAuthorityControllerInput): StudioPreviewAuthorityControllerView {
  const browserSearch = useSyncExternalStore(subscribeBrowserSearch, currentBrowserSearch, serverBrowserSearch);
  const providerKind = selectStudioPreviewProvider(browserSearch, import.meta.env.DEV);
  const [authority, dispatch] = useReducer(
    reduceStudioPreviewAuthority,
    providerKind,
    createStudioPreviewAuthorityState,
  );
  // Never expose a provider retained for a changed URL request during the
  // render before the layout effect commits the new generation.
  const projectId = context?.projectId ?? null;
  const currentAuthority = authorityStateForProvider(authority, providerKind, projectId);
  useLayoutEffect(() => {
    dispatch({ projectId, providerKind, type: "configure" });
  }, [projectId, providerKind]);

  useEffect(() => {
    if (currentAuthority.phase !== "resolving") return;
    const { generation, providerKind: resolvingProviderKind } = currentAuthority;
    let cancelled = false;
    void resolveStudioPreviewSnapshotProvider(resolvingProviderKind)
      .then((provider) => {
        if (!cancelled) dispatch({ generation, provider, type: "provider-resolved" });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          dispatch({
            generation,
            provider: createUnavailableStudioPreviewSnapshotProviderV1(cause),
            type: "provider-resolved",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentAuthority]);

  const provider = currentAuthority.phase === "active" ? currentAuthority.provider : null;
  const renderer = useStudioPreviewRenderer({
    context,
    frame,
    sceneFragmentMaterials,
    provider,
    retainedSourceDuration,
    sampleTime,
    sceneBoundaryActive,
    sourceEvents,
    staticPrimitiveTransforms,
    workingState,
  });
  const allowed = activationIsAllowed();
  const activate = useCallback(() => {
    if (!allowed || currentAuthority.phase !== "awaiting-consent") return false;
    dispatch({ allowed, type: "activate" });
    return true;
  }, [allowed, currentAuthority.phase]);
  const retry = useCallback(() => {
    if (!allowed || currentAuthority.phase !== "active") return false;
    dispatch({ allowed, type: "retry" });
    return true;
  }, [allowed, currentAuthority.phase]);

  return {
    activate,
    activationAllowed: allowed,
    awaitingConsent: currentAuthority.phase === "awaiting-consent",
    providerPending: currentAuthority.phase === "resolving",
    renderer,
    retry,
  };
}
