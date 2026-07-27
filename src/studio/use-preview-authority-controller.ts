import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useSyncExternalStore } from "react";

import {
  PRISTINE_WORKING_REVISION,
  STUDIO_PREVIEW_RENDERER_QUERY_PARAM,
  createUnavailableStudioPreviewSnapshotProviderV1,
  resolveStudioPreviewSnapshotProviderV1,
  type StudioPreviewEditingContextV1,
  type StudioPreviewSnapshotProviderV1,
} from "./preview-snapshot-provider";
import { useStudioPreviewRenderer, type StudioPreviewRendererViewV1 } from "./use-preview-renderer";

export type StudioPreviewAuthoritySceneV1 = Readonly<{
  name: string;
  runtimeSceneState: Readonly<{ duration: number }>;
  sourceHash: string;
  sourcePath: string;
}>;

export type StudioPreviewAuthorityStateV1 =
  | Readonly<{
      generation: number;
      phase: "disabled";
      provider: null;
      requestSearch: null;
    }>
  | Readonly<{
      generation: number;
      phase: "awaiting-consent" | "resolving";
      provider: null;
      requestSearch: string;
    }>
  | Readonly<{
      generation: number;
      phase: "active";
      provider: StudioPreviewSnapshotProviderV1 | null;
      requestSearch: string;
    }>;

export type StudioPreviewAuthorityActionV1 =
  | Readonly<{ requestSearch: string | null; type: "configure" }>
  | Readonly<{ allowed: boolean; type: "activate" }>
  | Readonly<{
      generation: number;
      provider: StudioPreviewSnapshotProviderV1 | null;
      type: "provider-resolved";
    }>;

type UseStudioPreviewAuthorityControllerInput = Readonly<{
  appliedTransactionIds: readonly string[];
  draftActive: boolean;
  editingAppliedProgram: boolean;
  frame: Readonly<{ height: number; width: number }>;
  projectId: string | null;
  redoProgramCount: number;
  retainedSourceDuration: number | null;
  sampleTime: number;
  scene: StudioPreviewAuthoritySceneV1 | null;
  transientEdit: boolean;
}>;

export type StudioPreviewAuthorityControllerViewV1 = Readonly<{
  activate: () => boolean;
  activationAllowed: boolean;
  activationRequested: boolean;
  activated: boolean;
  providerPending: boolean;
  renderer: StudioPreviewRendererViewV1 | null;
}>;

function authorityStateForRequest(
  state: StudioPreviewAuthorityStateV1,
  requestSearch: string | null,
): StudioPreviewAuthorityStateV1 {
  if (state.requestSearch === requestSearch) return state;
  const generation = state.generation + 1;
  return requestSearch === null
    ? { generation, phase: "disabled", provider: null, requestSearch: null }
    : { generation, phase: "awaiting-consent", provider: null, requestSearch };
}

export function createStudioPreviewAuthorityStateV1(requestSearch: string | null): StudioPreviewAuthorityStateV1 {
  return requestSearch === null
    ? { generation: 0, phase: "disabled", provider: null, requestSearch: null }
    : { generation: 0, phase: "awaiting-consent", provider: null, requestSearch };
}

/**
 * Owns the explicit-consent boundary and the monotonic provider authority
 * generation. A provider resolution can become active only for the exact
 * request generation that the user consented to; reconfiguration resets to
 * semantic preview synchronously and permanently rejects stale completions.
 */
export function reduceStudioPreviewAuthorityV1(
  state: StudioPreviewAuthorityStateV1,
  action: StudioPreviewAuthorityActionV1,
): StudioPreviewAuthorityStateV1 {
  if (action.type === "configure") return authorityStateForRequest(state, action.requestSearch);
  if (action.type === "activate") {
    if (!action.allowed || state.phase !== "awaiting-consent") return state;
    return { ...state, generation: state.generation + 1, phase: "resolving" };
  }
  if (state.phase !== "resolving" || state.generation !== action.generation) return state;
  return { ...state, phase: "active", provider: action.provider };
}

/** Keeps semantic preview as default and admits only the production provider,
 * plus the checked-in fixture in development/test builds. */
export function requestedStudioPreviewRendererSearchV1(search: string | null, fixtureAllowed: boolean) {
  if (search === null) return null;
  const requested = new URLSearchParams(search).get(STUDIO_PREVIEW_RENDERER_QUERY_PARAM);
  return requested === "server" || (fixtureAllowed && requested === "fixture") ? search : null;
}

type StudioPreviewEditingContextInputV1 = Readonly<{
  appliedTransactionIds: readonly string[];
  draftActive: boolean;
  editingAppliedProgram: boolean;
  projectId: string | null;
  redoProgramCount: number;
  scene: StudioPreviewAuthoritySceneV1 | null;
}>;

export function createStudioPreviewEditingContextV1({
  appliedTransactionIds,
  draftActive,
  editingAppliedProgram,
  projectId,
  redoProgramCount,
  scene,
}: StudioPreviewEditingContextInputV1): StudioPreviewEditingContextV1 | null {
  if (!projectId || !scene) return null;
  const editorPristine =
    appliedTransactionIds.length === 0 && !draftActive && !editingAppliedProgram && redoProgramCount === 0;
  return {
    projectId,
    sceneName: scene.name,
    sourceDuration: scene.runtimeSceneState.duration,
    sourceHash: scene.sourceHash,
    sourcePath: scene.sourcePath,
    workingRevision: editorPristine
      ? PRISTINE_WORKING_REVISION
      : `programs:${appliedTransactionIds.join(",")}${draftActive ? "+draft" : ""}`,
  };
}

type StudioPreviewLocationSearchSourcesV1 = Readonly<{
  navigationTarget: EventTarget | null;
  traversalTarget: EventTarget | null;
}>;

export function studioPreviewLocationSearchSnapshotV1(locationValue: Readonly<{ search: string }> | null) {
  return locationValue?.search ?? null;
}

/** Browser traversal is universally observable through popstate. The
 * Navigation API additionally reports same-document pushState/replaceState
 * without patching the shared History methods. */
export function subscribeStudioPreviewLocationSearchChangesV1(
  sources: StudioPreviewLocationSearchSourcesV1,
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
  return studioPreviewLocationSearchSnapshotV1(typeof location === "undefined" ? null : location);
}

function serverBrowserSearch() {
  return null;
}

function subscribeBrowserSearch(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return subscribeStudioPreviewLocationSearchChangesV1(
      { navigationTarget: null, traversalTarget: null },
      onStoreChange,
    );
  }
  const navigationTarget = eventTargetOrNull((window as Window & { navigation?: unknown }).navigation);
  return subscribeStudioPreviewLocationSearchChangesV1({ navigationTarget, traversalTarget: window }, onStoreChange);
}

function activationIsAllowed() {
  return typeof window === "undefined" || window.top === window.self;
}

/**
 * Composes App's preview request, consent, provider and renderer authority.
 * The lower renderer hook continues to own snapshot/worker/canvas resources;
 * this controller decides whether it may receive any provider authority.
 */
export function useStudioPreviewAuthorityController({
  appliedTransactionIds,
  draftActive,
  editingAppliedProgram,
  frame,
  projectId,
  redoProgramCount,
  retainedSourceDuration,
  sampleTime,
  scene,
  transientEdit,
}: UseStudioPreviewAuthorityControllerInput): StudioPreviewAuthorityControllerViewV1 {
  const browserSearch = useSyncExternalStore(subscribeBrowserSearch, currentBrowserSearch, serverBrowserSearch);
  const requestSearch = requestedStudioPreviewRendererSearchV1(browserSearch, import.meta.env.DEV);
  const [authority, dispatch] = useReducer(
    reduceStudioPreviewAuthorityV1,
    requestSearch,
    createStudioPreviewAuthorityStateV1,
  );
  // Never expose a provider retained for a changed URL request during the
  // render before the layout effect commits the new generation.
  const currentAuthority = authorityStateForRequest(authority, requestSearch);
  useLayoutEffect(() => {
    dispatch({ requestSearch, type: "configure" });
  }, [requestSearch]);

  useEffect(() => {
    if (currentAuthority.phase !== "resolving") return;
    const { generation, requestSearch: resolvingSearch } = currentAuthority;
    let cancelled = false;
    void resolveStudioPreviewSnapshotProviderV1(resolvingSearch)
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

  const context = useMemo(
    () =>
      createStudioPreviewEditingContextV1({
        appliedTransactionIds,
        draftActive,
        editingAppliedProgram,
        projectId,
        redoProgramCount,
        scene,
      }),
    [appliedTransactionIds, draftActive, editingAppliedProgram, projectId, redoProgramCount, scene],
  );
  const provider = currentAuthority.phase === "active" ? currentAuthority.provider : null;
  const renderer = useStudioPreviewRenderer({
    context,
    frame,
    provider,
    retainedSourceDuration,
    sampleTime,
    transientEdit,
  });
  const allowed = activationIsAllowed();
  const activate = useCallback(() => {
    if (!allowed || currentAuthority.phase !== "awaiting-consent") return false;
    dispatch({ allowed, type: "activate" });
    return true;
  }, [allowed, currentAuthority.phase]);

  return {
    activate,
    activationAllowed: allowed,
    activationRequested: currentAuthority.phase !== "disabled",
    activated: currentAuthority.phase === "resolving" || currentAuthority.phase === "active",
    providerPending: currentAuthority.phase === "resolving",
    renderer,
  };
}
