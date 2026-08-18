import { useEffect, useRef, useState } from "react";

import { loadAccountOrganizationMembersV1, mutateAccountOrganizationMemberV1 } from "./account-membership-client";
import type { AccountOrganizationMemberV1 } from "./account-membership-contract";
import type { AccountSessionViewV1 } from "./account-session-contract";

export function accountRoleCanManageMembersV1(role: AccountSessionViewV1["activeOrganization"]["role"]) {
  return role === "owner" || role === "admin";
}

export function AccountMembershipControl({
  disabled = false,
  session,
}: Readonly<{ disabled?: boolean; session: AccountSessionViewV1 }>) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<readonly AccountOrganizationMemberV1[]>([]);
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  const loadMembers = () => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setError(null);
    void loadAccountOrganizationMembersV1(controller.signal)
      .then((view) => {
        if (request.current !== controller || controller.signal.aborted) return;
        request.current = null;
        setMembers(view.members);
      })
      .catch((reason: unknown) => {
        if (request.current !== controller || controller.signal.aborted) return;
        request.current = null;
        setError(reason instanceof Error ? reason.message : "Organization members are unavailable.");
      });
  };

  useEffect(() => () => request.current?.abort(), []);

  const close = () => {
    request.current?.abort();
    request.current = null;
    setMembers([]);
    setError(null);
    setPendingMemberId(null);
    setOpen(false);
  };

  const mutate = (member: AccountOrganizationMemberV1, role?: AccountOrganizationMemberV1["role"]) => {
    if (pendingMemberId || disabled) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setPendingMemberId(member.id);
    setError(null);
    void mutateAccountOrganizationMemberV1(
      member.id,
      role
        ? { action: "set-role", expectedVersion: member.version, mutationId: crypto.randomUUID(), role }
        : { action: "remove", expectedVersion: member.version, mutationId: crypto.randomUUID() },
      controller.signal,
    )
      .then((result) => {
        if (request.current !== controller || controller.signal.aborted) return;
        request.current = null;
        setPendingMemberId(null);
        const outcome = result.member;
        if (outcome.status === "removed") {
          setMembers((current) => current.filter(({ id }) => id !== outcome.id));
        } else {
          setMembers((current) =>
            current.map((candidate) =>
              candidate.id === outcome.id ? { ...candidate, role: outcome.role, version: outcome.version } : candidate,
            ),
          );
        }
      })
      .catch((reason: unknown) => {
        if (request.current !== controller || controller.signal.aborted) return;
        request.current = null;
        setPendingMemberId(null);
        setError(reason instanceof Error ? reason.message : "The member could not be changed.");
      });
  };

  const owner = session.activeOrganization.role === "owner";
  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={open}
        className="min-h-8 border border-zinc-700 px-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:text-zinc-600"
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            loadMembers();
          }
        }}
        type="button"
      >
        Members
      </button>
      {open ? (
        <section
          aria-label="Manage organization members"
          className="absolute right-0 top-10 z-50 w-[28rem] border border-zinc-700 bg-zinc-950 p-4 text-left shadow-xl"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Organization members</h2>
              <p className="mt-1 text-xs text-zinc-500">Change access or remove a member.</p>
            </div>
            <button
              aria-label="Close member manager"
              className="min-h-8 px-2 text-zinc-500"
              onClick={close}
              type="button"
            >
              ×
            </button>
          </div>
          <div className="mt-4 space-y-2">
            {members.map((member) => {
              const mutable = owner || (member.role !== "owner" && member.role !== "admin");
              return (
                <div className="flex items-center gap-2 border border-zinc-800 p-2" key={member.id}>
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">
                    {member.displayName}
                    {member.id === session.user.id ? " (you)" : ""}
                  </span>
                  <select
                    aria-label={`Role for ${member.displayName}`}
                    className="h-8 border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200"
                    disabled={!mutable || pendingMemberId !== null || member.id === session.user.id}
                    onChange={(event) =>
                      mutate(member, event.currentTarget.value as AccountOrganizationMemberV1["role"])
                    }
                    value={member.role}
                  >
                    {owner || member.role === "owner" ? <option value="owner">Owner</option> : null}
                    {owner || member.role === "admin" ? <option value="admin">Admin</option> : null}
                    <option value="member">Member</option>
                    <option value="billing">Billing</option>
                  </select>
                  <button
                    aria-label={`Remove ${member.displayName}`}
                    className="min-h-8 border border-red-900 px-2 text-xs text-red-300 hover:bg-red-950 disabled:text-zinc-600"
                    disabled={!mutable || pendingMemberId !== null || member.id === session.user.id}
                    onClick={() => mutate(member)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
            {members.length === 0 && !error ? <p className="text-xs text-zinc-500">Loading…</p> : null}
          </div>
          {error ? (
            <p className="mt-3 text-xs text-amber-300" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
