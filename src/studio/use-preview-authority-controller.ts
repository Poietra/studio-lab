import { useCallback, useEffect, useLayoutEffect, useReducer, useState, useSyncExternalStore } from "react";
import type { ProgramRecord, ProposedState } from "./model";
import {
  createUnavailableStudioPreviewSnapshotProviderV1,
  resolveStudioPreviewSnapshotProviderV1,
  STUDIO_PREVIEW_RENDERER_QUERY_PARAM,
  type StudioPreviewEditingContextV1,
  type StudioPreviewSnapshotProviderV1,
} from "./preview-snapshot-provider";
import { type StudioPreviewRendererViewV1, useStudioPreviewRenderer } from "./use-preview-renderer";

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
  | Readonly<{ allowed: boolean; type: "retry" }>
  | Readonly<{
      generation: number;
      provider: StudioPreviewSnapshotProviderV1 | null;
      type: "provider-resolved";
    }>;

type UseStudioPreviewAuthorityControllerInput = Readonly<{
  committedProposedState: ProposedState | null;
  context: StudioPreviewEditingContextV1 | null;
  draftProposedState: ProposedState | null;
  frame: Readonly<{ height: number; width: number }>;
  retainedSourceDuration: number | null;
  runtimeTraceTerminalProgramRecords: readonly ProgramRecord[];
  sampleTime: number;
  transientEdit: boolean;
}>;

export type StudioPreviewAuthorityControllerViewV1 = Readonly<{
  activate: () => boolean;
  activationAllowed: boolean;
  activationRequested: boolean;
  activated: boolean;
  providerPending: boolean;
  requestServer: () => boolean;
  renderer: StudioPreviewRendererViewV1 | null;
  retry: () => boolean;
}>;

export const STUDIO_PREVIEW_SERVER_REQUEST_SEARCH_V1 = `?${STUDIO_PREVIEW_RENDERER_QUERY_PARAM}=server`;

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
  if (action.type === "retry") {
    if (!action.allowed || state.phase !== "active") return state;
    return { ...state, generation: state.generation + 1, phase: "resolving", provider: null };
  }
  if (state.phase !== "resolving" || state.generation !== action.generation) return state;
  return { ...state, phase: "active", provider: action.provider };
}

/** Keeps semantic preview as default and admits only the production provider,
 * plus the checked-in fixtures in development/test builds. */
export function requestedStudioPreviewRendererSearchV1(search: string | null, fixtureAllowed: boolean) {
  if (search === null) return null;
  const requested = new URLSearchParams(search).get(STUDIO_PREVIEW_RENDERER_QUERY_PARAM);
  return requested === "server" || (fixtureAllowed && (requested === "fixture" || requested === "mathtex-fixture"))
    ? search
    : null;
}

/**
 * URL requests remain an independent developer/fixture entry point. The
 * standard UI contributes only a tab-local server request, so it neither
 * rewrites the address bar nor accidentally grants fixture authority.
 */
export function effectiveStudioPreviewRendererSearchV1(
  browserSearch: string | null,
  fixtureAllowed: boolean,
  manualServerRequested: boolean,
) {
  return (
    requestedStudioPreviewRendererSearchV1(browserSearch, fixtureAllowed) ??
    (manualServerRequested ? STUDIO_PREVIEW_SERVER_REQUEST_SEARCH_V1 : null)
  );
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
 * The editor revision controller supplies its already fail-closed context.
 * The lower renderer hook continues to own snapshot/worker/canvas resources;
 * this controller decides whether it may receive any provider authority.
 */
export function useStudioPreviewAuthorityController({
  committedProposedState,
  context,
  draftProposedState,
  frame,
  retainedSourceDuration,
  runtimeTraceTerminalProgramRecords,
  sampleTime,
  transientEdit,
}: UseStudioPreviewAuthorityControllerInput): StudioPreviewAuthorityControllerViewV1 {
  const browserSearch = useSyncExternalStore(subscribeBrowserSearch, currentBrowserSearch, serverBrowserSearch);
  const [manualServerRequested, setManualServerRequested] = useState(false);
  const requestSearch = effectiveStudioPreviewRendererSearchV1(
    browserSearch,
    import.meta.env.DEV,
    manualServerRequested,
  );
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

  const provider = currentAuthority.phase === "active" ? currentAuthority.provider : null;
  const renderer = useStudioPreviewRenderer({
    committedProposedState,
    context,
    draftProposedState,
    frame,
    provider,
    retainedSourceDuration,
    runtimeTraceTerminalProgramRecords,
    sampleTime,
    transientEdit,
  });
  const allowed = activationIsAllowed();
  const activate = useCallback(() => {
    if (!allowed || currentAuthority.phase !== "awaiting-consent") return false;
    dispatch({ allowed, type: "activate" });
    return true;
  }, [allowed, currentAuthority.phase]);
  const requestServer = useCallback(() => {
    if (!allowed) return false;
    setManualServerRequested(true);
    return true;
  }, [allowed]);
  const retry = useCallback(() => {
    if (!allowed || currentAuthority.phase !== "active") return false;
    dispatch({ allowed, type: "retry" });
    return true;
  }, [allowed, currentAuthority.phase]);

  return {
    activate,
    activationAllowed: allowed,
    activationRequested: currentAuthority.phase !== "disabled",
    activated: currentAuthority.phase === "resolving" || currentAuthority.phase === "active",
    providerPending: currentAuthority.phase === "resolving",
    requestServer,
    renderer,
    retry,
  };
}
