import { accountRoleCanManageBillingV1, BillingSettingsControl } from "../billing/billing-settings";
import { cn } from "../lib/cn";
import type { AccountSessionActionsV1 } from "./account-session-bootstrap";
import type { AccountSessionViewV1 } from "./account-session-contract";

export function AccountSessionBadge({
  actions,
  className,
  compact = false,
  session,
}: Readonly<{
  actions: AccountSessionActionsV1;
  className?: string;
  compact?: boolean;
  session: AccountSessionViewV1;
}>) {
  return (
    <div
      aria-label={`Account: ${session.user.displayName}, organization: ${session.activeOrganization.displayName}`}
      className={cn("flex min-w-0 items-center gap-2 text-xs", className)}
    >
      <label className="sr-only" htmlFor={`account-organization-${session.user.id}`}>
        Active organization
      </label>
      <select
        aria-label="Active organization"
        className="h-8 min-w-28 max-w-48 border border-zinc-700 bg-zinc-950 px-2 text-xs font-medium text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
        id={`account-organization-${session.user.id}`}
        onChange={(event) => {
          const organizationId = event.currentTarget.value;
          if (organizationId !== session.activeOrganization.id) actions.switchOrganization(organizationId);
        }}
        value={session.activeOrganization.id}
      >
        {session.organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.displayName}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className={cn("text-zinc-700", compact && "hidden")}>
        /
      </span>
      <span className={cn("max-w-32 truncate text-zinc-500", compact && "hidden")} title={session.user.displayName}>
        {session.user.displayName}
      </span>
      {accountRoleCanManageBillingV1(session.activeOrganization.role) ? (
        <BillingSettingsControl key={session.activeOrganization.id} organization={session.activeOrganization} />
      ) : null}
      <button
        className="min-h-8 shrink-0 border border-zinc-700 px-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
        onClick={actions.logout}
        type="button"
      >
        Sign out
      </button>
      {actions.actionError ? (
        <span className={cn("max-w-64 text-pretty text-amber-300", compact && "sr-only")} role="alert">
          {actions.actionError}
        </span>
      ) : null}
    </div>
  );
}
