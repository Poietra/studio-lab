import { type ReactNode, useEffect, useState } from "react";

import { PoietraBrand } from "../studio/poietra-brand";
import { AccountSessionRequestError, loadAccountSessionV1 } from "./account-session-client";
import type { AccountSessionViewV1 } from "./account-session-contract";

type AccountBootstrapState =
  | Readonly<{ phase: "error"; status: number | null }>
  | Readonly<{ phase: "loading" }>
  | Readonly<{ phase: "ready"; session: AccountSessionViewV1 | null }>
  | Readonly<{ phase: "signed-out" }>;

type AccountSessionBootstrapProps = Readonly<{
  children: (session: AccountSessionViewV1 | null) => ReactNode;
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

export function AccountSessionBootstrap({ children, enabled }: AccountSessionBootstrapProps) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AccountBootstrapState>(() =>
    enabled ? { phase: "loading" } : { phase: "ready", session: null },
  );

  useEffect(() => {
    if (!enabled) {
      setState({ phase: "ready", session: null });
      return;
    }
    const controller = new AbortController();
    let scheduled = true;
    queueMicrotask(() => {
      if (!scheduled) return;
      setState({ phase: "loading" });
      void loadAccountSessionV1(controller.signal)
        .then((session) => setState({ phase: "ready", session }))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof AccountSessionRequestError && error.status === 401) {
            setState({ phase: "signed-out" });
            return;
          }
          setState({
            phase: "error",
            status: error instanceof AccountSessionRequestError ? error.status : null,
          });
        });
    });
    return () => {
      scheduled = false;
      controller.abort();
    };
  }, [attempt, enabled]);

  if (state.phase === "ready") {
    if (state.session && !accountSessionAllowsStudioV1(state.session)) {
      return (
        <AccountBootstrapFrame>
          <section aria-labelledby="billing-account-title" className="w-full max-w-sm border border-zinc-800 p-6">
            <h2 className="text-balance text-lg font-semibold" id="billing-account-title">
              Billing account
            </h2>
            <p className="mt-3 text-pretty text-sm leading-6 text-zinc-400">
              {state.session.activeOrganization.displayName} gives this account billing access, but not Studio workspace
              access. Billing tools are coming next.
            </p>
          </section>
        </AccountBootstrapFrame>
      );
    }
    return children(state.session);
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
          <a
            className="mt-6 inline-flex min-h-10 items-center border border-sky-700 bg-sky-950 px-4 text-sm font-medium text-sky-100 hover:bg-sky-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
            href="/auth/oidc/start"
          >
            Sign in
          </a>
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
        <button
          className="mt-6 min-h-10 border border-red-800 px-4 text-sm font-medium text-red-100 hover:bg-red-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
          onClick={() => setAttempt((current) => current + 1)}
          type="button"
        >
          Retry
        </button>
      </section>
    </AccountBootstrapFrame>
  );
}
