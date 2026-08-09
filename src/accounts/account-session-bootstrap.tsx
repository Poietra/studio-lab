import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { PoietraBrand } from "../studio/poietra-brand";
import { AccountInvitationSignInForm } from "./account-invitation-sign-in-form";
import { AccountSessionBadge } from "./account-session-badge";
import {
  AccountSessionRequestError,
  loadAccountSessionV1,
  logoutAccountSessionV1,
  switchAccountOrganizationV1,
} from "./account-session-client";
import type { AccountSessionViewV1 } from "./account-session-contract";
import { setManimOrganizationScopeV1 } from "./organization-scoped-manim-fetch";

const ACCOUNT_SESSION_INVALIDATION_CHANNEL_V1 = "poietra:account-session:v1";

type AccountBootstrapState =
  | Readonly<{ phase: "error"; status: number | null }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{ actionError: string | null; phase: "ready"; session: AccountSessionViewV1 | null }>
  | Readonly<{ actionError: string | null; phase: "signed-out" }>;

export type AccountSessionActionsV1 = Readonly<{
  actionError: string | null;
  logout: () => void;
  switchOrganization: (organizationId: string) => void;
}>;

type AccountSessionBootstrapProps = Readonly<{
  children: (session: AccountSessionViewV1 | null, actions: AccountSessionActionsV1 | null) => ReactNode;
  enabled: boolean;
}>;

export function productionBrowserAccountBootstrapRequired(
  input: Readonly<{
    electron: boolean;
    production: boolean;
    tauri: boolean;
  }>,
) {
  return input.production && !input.electron && !input.tauri;
}

export function accountSessionAllowsStudioV1(session: AccountSessionViewV1) {
  return session.activeOrganization.role !== "billing";
}

export function accountSessionMountKeyV1(session: AccountSessionViewV1) {
  return `${session.user.id}/${session.activeOrganization.id}`;
}

function AccountBootstrapFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-zinc-950 text-zinc-100">
      <header className="flex min-h-12 shrink-0 items-center border-b border-zinc-800 px-4 py-2">
        <PoietraBrand />
      </header>
      <div className="grid min-h-0 flex-1 place-items-center px-6 py-12">{children}</div>
    </main>
  );
}

function accountRequestStatus(error: unknown) {
  return error instanceof AccountSessionRequestError ? error.status : null;
}

type AccountOrganizationSwitchIdentityV1 = Readonly<{
  mutationId: string;
  organizationId: string;
}>;

type AccountOrganizationSwitchRecoveryV1 =
  | Readonly<{ kind: "confirmed"; session: AccountSessionViewV1 }>
  | Readonly<{ kind: "not-confirmed"; session: AccountSessionViewV1 }>
  | Readonly<{ kind: "signed-out" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "unavailable"; status: number | null }>;

/** Resolve an ambiguous PATCH outcome against one newer authoritative GET. */
export async function recoverAccountOrganizationSwitchV1(
  identity: AccountOrganizationSwitchIdentityV1,
  signal: AbortSignal,
  isCurrent: () => boolean,
  load: (signal?: AbortSignal) => Promise<AccountSessionViewV1> = loadAccountSessionV1,
): Promise<AccountOrganizationSwitchRecoveryV1> {
  try {
    const session = await load(signal);
    if (!isCurrent()) return { kind: "stale" };
    return session.organizationSwitch?.mutationId === identity.mutationId &&
      session.organizationSwitch.organizationId === identity.organizationId
      ? { kind: "confirmed", session }
      : { kind: "not-confirmed", session };
  } catch (error) {
    if (!isCurrent()) return { kind: "stale" };
    if (error instanceof AccountSessionRequestError && error.status === 401) return { kind: "signed-out" };
    return { kind: "unavailable", status: accountRequestStatus(error) };
  }
}

export function AccountSessionBootstrap({ children, enabled }: AccountSessionBootstrapProps) {
  const [state, setState] = useState<AccountBootstrapState>(() =>
    enabled ? { phase: "loading" } : { actionError: null, phase: "ready", session: null },
  );
  const readRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);
  const pendingInvalidation = useRef(false);
  const requestGeneration = useRef(0);
  const invalidationChannel = useRef<BroadcastChannel | null>(null);

  const beginReadTransition = useCallback(() => {
    if (mutationRequest.current) {
      pendingInvalidation.current = true;
      return null;
    }
    setManimOrganizationScopeV1(null);
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    requestGeneration.current += 1;
    setState({ phase: "loading" });
    return { controller, generation: requestGeneration.current };
  }, []);

  const beginMutationTransition = useCallback(() => {
    if (mutationRequest.current) return null;
    setManimOrganizationScopeV1(null);
    readRequest.current?.abort();
    readRequest.current = null;
    const controller = new AbortController();
    mutationRequest.current = controller;
    requestGeneration.current += 1;
    setState({ phase: "loading" });
    return { controller, generation: requestGeneration.current };
  }, []);

  const isCurrentRead = useCallback((controller: AbortController, generation: number) => {
    return !controller.signal.aborted && readRequest.current === controller && requestGeneration.current === generation;
  }, []);

  const finishMutation = useCallback((controller: AbortController, generation: number) => {
    if (
      controller.signal.aborted ||
      mutationRequest.current !== controller ||
      requestGeneration.current !== generation
    ) {
      return null;
    }
    mutationRequest.current = null;
    const shouldRefresh = pendingInvalidation.current;
    pendingInvalidation.current = false;
    return shouldRefresh;
  }, []);

  const loadAuthoritativeSession = useCallback(
    (actionError: string | null = null) => {
      if (!enabled) return;
      const transition = beginReadTransition();
      if (!transition) return;
      const { controller, generation } = transition;
      void loadAccountSessionV1(controller.signal)
        .then((session) => {
          if (!isCurrentRead(controller, generation)) return;
          setManimOrganizationScopeV1(session.activeOrganization.id);
          setState({ actionError, phase: "ready", session });
        })
        .catch((error: unknown) => {
          if (!isCurrentRead(controller, generation)) return;
          if (error instanceof AccountSessionRequestError && error.status === 401) {
            setState({ actionError, phase: "signed-out" });
            return;
          }
          setState({ phase: "error", status: accountRequestStatus(error) });
        });
    },
    [beginReadTransition, enabled, isCurrentRead],
  );

  const broadcastInvalidation = useCallback(() => {
    invalidationChannel.current?.postMessage(null);
  }, []);

  const recoverOrganizationSwitch = useCallback(
    (identity: AccountOrganizationSwitchIdentityV1) => {
      const transition = beginReadTransition();
      if (!transition) return;
      const { controller, generation } = transition;
      void recoverAccountOrganizationSwitchV1(identity, controller.signal, () =>
        isCurrentRead(controller, generation),
      ).then((result) => {
        if (result.kind === "stale" || !isCurrentRead(controller, generation)) return;
        if (result.kind === "confirmed") {
          broadcastInvalidation();
          setManimOrganizationScopeV1(result.session.activeOrganization.id);
          setState({ actionError: null, phase: "ready", session: result.session });
          return;
        }
        if (result.kind === "not-confirmed") {
          setManimOrganizationScopeV1(result.session.activeOrganization.id);
          setState({
            actionError: "The organization could not be changed. Your account was refreshed.",
            phase: "ready",
            session: result.session,
          });
          return;
        }
        if (result.kind === "signed-out") {
          setState({ actionError: null, phase: "signed-out" });
          broadcastInvalidation();
          return;
        }
        setState({ phase: "error", status: result.status });
      });
    },
    [beginReadTransition, broadcastInvalidation, isCurrentRead],
  );

  const switchOrganization = useCallback(
    (organizationId: string) => {
      if (state.phase !== "ready" || !state.session) return;
      const expectedVersion = state.session.version;
      const mutationId = crypto.randomUUID();
      const transition = beginMutationTransition();
      if (!transition) return;
      const { controller, generation } = transition;
      void switchAccountOrganizationV1(organizationId, expectedVersion, mutationId, controller.signal)
        .then((session) => {
          const shouldRefresh = finishMutation(controller, generation);
          if (shouldRefresh === null) return;
          broadcastInvalidation();
          if (shouldRefresh) {
            loadAuthoritativeSession();
            return;
          }
          setManimOrganizationScopeV1(session.activeOrganization.id);
          setState({ actionError: null, phase: "ready", session });
        })
        .catch((error: unknown) => {
          if (finishMutation(controller, generation) === null) return;
          if (error instanceof AccountSessionRequestError && error.status === 401) {
            setState({ actionError: null, phase: "signed-out" });
            broadcastInvalidation();
            return;
          }
          recoverOrganizationSwitch({ mutationId, organizationId });
        });
    },
    [beginMutationTransition, broadcastInvalidation, finishMutation, recoverOrganizationSwitch, state],
  );

  const logout = useCallback(() => {
    const transition = beginMutationTransition();
    if (!transition) return;
    const { controller, generation } = transition;
    void logoutAccountSessionV1(controller.signal)
      .then(() => {
        if (finishMutation(controller, generation) === null) return;
        setState({ actionError: null, phase: "signed-out" });
        broadcastInvalidation();
      })
      .catch((error: unknown) => {
        if (finishMutation(controller, generation) === null) return;
        if (error instanceof AccountSessionRequestError && error.status === 401) {
          setState({ actionError: null, phase: "signed-out" });
          broadcastInvalidation();
          return;
        }
        loadAuthoritativeSession("Sign out could not be confirmed. Your account was refreshed.");
      });
  }, [beginMutationTransition, broadcastInvalidation, finishMutation, loadAuthoritativeSession]);

  useEffect(() => {
    if (!enabled) {
      setManimOrganizationScopeV1(undefined);
      queueMicrotask(() => setState({ actionError: null, phase: "ready", session: null }));
      return;
    }
    const scheduled = { active: true };
    queueMicrotask(() => {
      if (scheduled.active) loadAuthoritativeSession();
    });
    return () => {
      scheduled.active = false;
      readRequest.current?.abort();
      mutationRequest.current?.abort();
    };
  }, [enabled, loadAuthoritativeSession]);

  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(ACCOUNT_SESSION_INVALIDATION_CHANNEL_V1);
    invalidationChannel.current = channel;
    const handleInvalidation = () => loadAuthoritativeSession();
    channel.addEventListener("message", handleInvalidation);
    return () => {
      channel.removeEventListener("message", handleInvalidation);
      channel.close();
      if (invalidationChannel.current === channel) invalidationChannel.current = null;
    };
  }, [enabled, loadAuthoritativeSession]);

  if (state.phase === "ready") {
    const actions: AccountSessionActionsV1 | null = state.session
      ? { actionError: state.actionError, logout, switchOrganization }
      : null;
    if (state.session && !accountSessionAllowsStudioV1(state.session)) {
      return (
        <AccountBootstrapFrame>
          <section aria-labelledby="billing-account-title" className="w-full max-w-md border border-zinc-800 p-6">
            <h2 className="text-balance text-lg font-semibold" id="billing-account-title">
              Billing account
            </h2>
            <p className="mt-3 text-pretty text-sm leading-6 text-zinc-400">
              This membership can manage billing for {state.session.activeOrganization.displayName}, but cannot open its
              Studio workspaces.
            </p>
            <AccountSessionBadge className="mt-6 flex-wrap" actions={actions!} session={state.session} />
          </section>
        </AccountBootstrapFrame>
      );
    }
    return children(state.session, actions);
  }
  if (state.phase === "loading") {
    return (
      <AccountBootstrapFrame>
        <section aria-busy="true" aria-label="Loading account" className="w-full max-w-sm" role="status">
          <div className="h-5 w-40 bg-zinc-800" />
          <div className="mt-4 h-4 w-full bg-zinc-900" />
          <div className="mt-2 h-4 w-3/4 bg-zinc-900" />
        </section>
      </AccountBootstrapFrame>
    );
  }
  if (state.phase === "signed-out") {
    return (
      <AccountBootstrapFrame>
        <section aria-labelledby="sign-in-title" className="w-full max-w-sm border border-zinc-800 p-6">
          <h2 className="text-balance text-lg font-semibold" id="sign-in-title">
            Sign in to Poietra
          </h2>
          <p className="mt-3 text-pretty text-sm leading-6 text-zinc-400">
            Continue with your organization account to open its workspaces.
          </p>
          {state.actionError ? (
            <p className="mt-3 text-pretty text-sm text-amber-300" role="alert">
              {state.actionError}
            </p>
          ) : null}
          <a
            className="mt-6 inline-flex min-h-10 items-center border border-sky-700 bg-sky-950 px-4 text-sm font-medium text-sky-100 hover:bg-sky-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
            href="/auth/oidc/start"
          >
            Sign in
          </a>
          <div className="my-6 flex items-center gap-3 text-xs text-zinc-600">
            <span className="h-px flex-1 bg-zinc-800" />
            or use an invitation
            <span className="h-px flex-1 bg-zinc-800" />
          </div>
          <AccountInvitationSignInForm />
        </section>
      </AccountBootstrapFrame>
    );
  }
  return (
    <AccountBootstrapFrame>
      <section aria-labelledby="account-error-title" className="w-full max-w-sm border border-red-900 p-6" role="alert">
        <h2 className="text-balance text-lg font-semibold text-red-100" id="account-error-title">
          Account access is unavailable
        </h2>
        <p className="mt-3 text-pretty text-sm leading-6 text-red-200/80">
          {state.status === 403
            ? "Your active organization is no longer available. Contact an organization administrator."
            : "Poietra could not verify your account. Try again in a moment."}
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <button
            className="min-h-10 border border-red-800 px-4 text-sm font-medium text-red-100 hover:bg-red-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
            onClick={() => loadAuthoritativeSession()}
            type="button"
          >
            Retry
          </button>
          {state.status === 403 ? (
            <button
              className="min-h-10 border border-zinc-700 px-4 text-sm font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
              onClick={logout}
              type="button"
            >
              Sign out
            </button>
          ) : null}
        </div>
      </section>
    </AccountBootstrapFrame>
  );
}
