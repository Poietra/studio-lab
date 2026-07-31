import { cn } from "../lib/cn";
import type { AccountSessionViewV1 } from "./account-session-contract";

export function AccountSessionBadge({
  className,
  session,
}: Readonly<{ className?: string; session: AccountSessionViewV1 }>) {
  return (
    <div
      aria-label={`Account: ${session.user.displayName}, organization: ${session.activeOrganization.displayName}`}
      className={cn("flex min-w-0 items-center gap-2 text-xs", className)}
    >
      <span className="max-w-40 truncate font-medium text-zinc-300" title={session.activeOrganization.displayName}>
        {session.activeOrganization.displayName}
      </span>
      <span aria-hidden="true" className="text-zinc-700">
        /
      </span>
      <span className="max-w-32 truncate text-zinc-500" title={session.user.displayName}>
        {session.user.displayName}
      </span>
    </div>
  );
}
