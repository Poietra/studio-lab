import { useCallback, useEffect, useRef, useState } from "react";

import type { AccountSessionViewV1 } from "../accounts/account-session-contract";
import { cn } from "../lib/cn";
import { loadBillingStatusV1, startBillingPortalV1, startProCheckoutV1 } from "./billing-client";
import type { BillingStatusViewV1 } from "./billing-contract";

type BillingReturnKindV1 = "cancelled" | "portal-return" | "success";
export type BillingActionV1 = "checkout" | "portal";
type BillingSettingsStateV1 =
  | Readonly<{ phase: "idle" | "loading" }>
  | Readonly<{ message: string; phase: "error" }>
  | Readonly<{ phase: "ready"; status: BillingStatusViewV1 }>;

const secondaryButtonClassName =
  "min-h-9 border border-zinc-700 px-3 text-xs font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-zinc-600";
const primaryButtonClassName =
  "min-h-9 bg-sky-500 px-3 text-xs font-medium text-sky-950 hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-wait disabled:bg-zinc-700 disabled:text-zinc-500";

export function accountRoleCanManageBillingV1(role: AccountSessionViewV1["activeOrganization"]["role"]) {
  return role === "owner" || role === "billing";
}

export function billingReturnKindV1(search: string): BillingReturnKindV1 | null {
  const values = new URLSearchParams(search).getAll("billing");
  if (values.length !== 1) return null;
  const value = values[0];
  return value === "cancelled" || value === "portal-return" || value === "success" ? value : null;
}

export function billingAvailableActionsV1(status: BillingStatusViewV1): readonly BillingActionV1[] {
  const subscription = status.subscription;
  const canCheckout =
    subscription === null || subscription.status === "canceled" || subscription.status === "incomplete_expired";
  return [...(status.configured ? (["portal"] as const) : []), ...(canCheckout ? (["checkout"] as const) : [])];
}

export async function billingExternalNavigationAllowedV1(beforeExternalNavigation?: () => Promise<boolean>) {
  return beforeExternalNavigation ? await beforeExternalNavigation() : true;
}

function billingStatusLabelV1(status: NonNullable<BillingStatusViewV1["subscription"]>["status"]) {
  switch (status) {
    case "active":
      return "Active";
    case "canceled":
      return "Canceled";
    case "incomplete":
      return "Incomplete";
    case "incomplete_expired":
      return "Expired";
    case "past_due":
      return "Past due";
    case "paused":
      return "Paused";
    case "trialing":
      return "Trialing";
    case "unpaid":
      return "Unpaid";
  }
}

function entitlementStatusLabelV1(entitlement: NonNullable<BillingStatusViewV1["entitlement"]>) {
  if (!entitlement.renderEnabled) return "Blocked";
  return entitlement.accessState === "grace" ? "Grace period" : "Active";
}

function BillingDate({ value }: Readonly<{ value: string }>) {
  const label = new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
  return <time dateTime={value}>{label}</time>;
}

export function BillingStatusDetailsV1({ status }: Readonly<{ status: BillingStatusViewV1 }>) {
  const { entitlement, subscription } = status;
  return (
    <div className="mt-5 border-y border-zinc-800 py-1">
      <dl className="divide-y divide-zinc-800 text-xs">
        <div className="grid grid-cols-[7rem_1fr] gap-3 py-3">
          <dt className="text-zinc-500">Subscription</dt>
          <dd className="text-zinc-200">
            {subscription ? billingStatusLabelV1(subscription.status) : "No subscription"}
            {subscription?.cancelAtPeriodEnd ? " · Cancels at period end" : null}
          </dd>
        </div>
        {subscription ? (
          <div className="grid grid-cols-[7rem_1fr] gap-3 py-3">
            <dt className="text-zinc-500">Billing period</dt>
            <dd className="tabular-nums text-zinc-200">
              <BillingDate value={subscription.periodStart} /> – <BillingDate value={subscription.periodEnd} />
            </dd>
          </div>
        ) : null}
        {entitlement ? (
          <>
            <div className="grid grid-cols-[7rem_1fr] gap-3 py-3">
              <dt className="text-zinc-500">Rendering</dt>
              <dd className="text-zinc-200">{entitlementStatusLabelV1(entitlement)}</dd>
            </div>
            <div className="grid grid-cols-[7rem_1fr] gap-3 py-3">
              <dt className="text-zinc-500">Render limit</dt>
              <dd className="tabular-nums text-zinc-200">
                {entitlement.renderJobLimit.toLocaleString("en")} jobs per billing period
              </dd>
            </div>
          </>
        ) : null}
      </dl>
    </div>
  );
}

export function BillingSettingsControl({
  beforeExternalNavigation,
  className,
  disabled = false,
  organization,
}: Readonly<{
  beforeExternalNavigation?: () => Promise<boolean>;
  className?: string;
  disabled?: boolean;
  organization: AccountSessionViewV1["activeOrganization"];
}>) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const [state, setState] = useState<BillingSettingsStateV1>({ phase: "idle" });
  const [pendingAction, setPendingAction] = useState<BillingActionV1 | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    setState({ phase: "loading" });
    setActionError(null);
    void loadBillingStatusV1(organization.id, controller.signal)
      .then((status) => {
        if (readRequest.current !== controller || controller.signal.aborted) return;
        setState({ phase: "ready", status });
      })
      .catch((error: unknown) => {
        if (readRequest.current !== controller || controller.signal.aborted) return;
        setState({
          message: error instanceof Error ? error.message : "Billing is temporarily unavailable.",
          phase: "error",
        });
      });
  }, [organization.id]);

  const open = useCallback(() => {
    if (disabled) return;
    if (!dialog.current?.open) dialog.current?.showModal?.();
    refresh();
  }, [disabled, refresh]);

  const close = useCallback(() => {
    readRequest.current?.abort();
    actionRequest.current?.abort();
    readRequest.current = null;
    actionRequest.current = null;
    setPendingAction(null);
    dialog.current?.close();
  }, []);

  useEffect(() => {
    return () => {
      readRequest.current?.abort();
      actionRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || billingReturnKindV1(window.location.search) === null) return;
    const scheduled = { active: true };
    queueMicrotask(() => {
      if (!scheduled.active) return;
      open();
      const url = new URL(window.location.href);
      url.searchParams.delete("billing");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    });
    return () => {
      scheduled.active = false;
    };
  }, [open]);

  function beginBillingAction(action: BillingActionV1) {
    if (disabled || state.phase !== "ready" || pendingAction !== null) return;
    actionRequest.current?.abort();
    const controller = new AbortController();
    actionRequest.current = controller;
    setPendingAction(action);
    setActionError(null);
    const request = action === "portal" ? startBillingPortalV1 : startProCheckoutV1;
    void request(organization.id, controller.signal)
      .then(async (response) => {
        if (actionRequest.current !== controller || controller.signal.aborted) return;
        const location = "portalUrl" in response ? response.portalUrl : response.checkoutUrl;
        if (!(await billingExternalNavigationAllowedV1(beforeExternalNavigation))) {
          if (actionRequest.current !== controller || controller.signal.aborted) return;
          actionRequest.current = null;
          setPendingAction(null);
          setActionError("Save the current Editor session before leaving for billing.");
          return;
        }
        if (actionRequest.current !== controller || controller.signal.aborted) return;
        window.location.assign(location);
      })
      .catch((error: unknown) => {
        if (actionRequest.current !== controller || controller.signal.aborted) return;
        setPendingAction(null);
        setActionError(error instanceof Error ? error.message : "Billing is temporarily unavailable.");
      });
  }

  const actions = state.phase === "ready" ? billingAvailableActionsV1(state.status) : [];

  return (
    <>
      <button
        className={cn(
          "min-h-8 shrink-0 border border-zinc-700 px-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-zinc-600",
          className,
        )}
        disabled={disabled}
        onClick={open}
        type="button"
      >
        Billing
      </button>
      <dialog
        aria-describedby="billing-settings-description"
        aria-labelledby="billing-settings-title"
        className="m-auto w-full max-w-md border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-xl backdrop:bg-black/70"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => {
          readRequest.current?.abort();
          actionRequest.current?.abort();
        }}
        ref={dialog}
      >
        <section className="p-5">
          <h2 className="text-balance text-base font-semibold" id="billing-settings-title">
            Billing settings
          </h2>
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400" id="billing-settings-description">
            Manage rendering access for {organization.displayName}.
          </p>

          {state.phase === "idle" || state.phase === "loading" ? (
            <div aria-busy="true" aria-label="Loading billing status" className="mt-5" role="status">
              <div className="h-4 w-32 bg-zinc-800" />
              <div className="mt-3 h-3 w-full bg-zinc-900" />
              <div className="mt-2 h-3 w-3/4 bg-zinc-900" />
            </div>
          ) : null}
          {state.phase === "error" ? (
            <div className="mt-5 border border-red-900 p-3" role="alert">
              <p className="text-pretty text-xs leading-5 text-red-200">{state.message}</p>
              <button className={cn(secondaryButtonClassName, "mt-3")} onClick={refresh} type="button">
                Retry
              </button>
            </div>
          ) : null}
          {state.phase === "ready" ? <BillingStatusDetailsV1 status={state.status} /> : null}
          {actionError ? (
            <p className="mt-3 text-pretty text-xs leading-5 text-red-300" role="alert">
              {actionError}
            </p>
          ) : null}

          <div className="mt-5 flex justify-end gap-2">
            <button className={secondaryButtonClassName} onClick={close} type="button">
              Close
            </button>
            {actions.map((action) => (
              <button
                className={action === "checkout" ? primaryButtonClassName : secondaryButtonClassName}
                disabled={disabled || pendingAction !== null}
                key={action}
                onClick={() => beginBillingAction(action)}
                type="button"
              >
                {pendingAction === action
                  ? action === "portal"
                    ? "Opening…"
                    : "Redirecting…"
                  : action === "portal"
                    ? "Manage billing"
                    : "Upgrade to Pro"}
              </button>
            ))}
          </div>
        </section>
      </dialog>
    </>
  );
}
