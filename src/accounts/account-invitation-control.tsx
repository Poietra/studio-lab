import { type FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { createAccountInvitationV1 } from "./account-invitation-client";
import type { AccountInvitationCreateResponseV1, AccountInvitationRoleV1 } from "./account-invitation-contract";
import type { AccountSessionViewV1 } from "./account-session-contract";

export function accountRoleCanIssueInvitationsV1(role: AccountSessionViewV1["activeOrganization"]["role"]) {
  return role === "owner" || role === "admin";
}

type InvitationControlStateV1 = Readonly<{
  copyMessage: string | null;
  created: AccountInvitationCreateResponseV1 | null;
  error: string | null;
  pending: boolean;
}>;

const INITIAL_STATE_V1: InvitationControlStateV1 = Object.freeze({
  copyMessage: null,
  created: null,
  error: null,
  pending: false,
});

export function AccountInvitationControl({ disabled = false }: Readonly<{ disabled?: boolean }>) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AccountInvitationRoleV1>("member");
  const [state, setState] = useState<InvitationControlStateV1>(INITIAL_STATE_V1);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const clearForPageHide = () => {
      request.current?.abort();
      request.current = null;
      flushSync(() => {
        setEmail("");
        setRole("member");
        setState(INITIAL_STATE_V1);
        setOpen(false);
      });
    };
    window.addEventListener("pagehide", clearForPageHide);
    return () => {
      window.removeEventListener("pagehide", clearForPageHide);
      request.current?.abort();
      request.current = null;
    };
  }, []);

  const close = () => {
    request.current?.abort();
    request.current = null;
    setEmail("");
    setRole("member");
    setState(INITIAL_STATE_V1);
    setOpen(false);
  };

  const createInvitation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.pending || disabled) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setState({ copyMessage: null, created: null, error: null, pending: true });
    void createAccountInvitationV1({ email, role }, controller.signal)
      .then((created) => {
        if (controller.signal.aborted || request.current !== controller) return;
        request.current = null;
        setState({ copyMessage: null, created, error: null, pending: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || request.current !== controller) return;
        request.current = null;
        setState({
          copyMessage: null,
          created: null,
          error: error instanceof Error ? error.message : "The invitation could not be created.",
          pending: false,
        });
      });
  };

  const copyInvitation = () => {
    const token = state.created?.invitationToken;
    if (!token || !navigator.clipboard?.writeText) {
      setState((current) => ({ ...current, copyMessage: "Copy is unavailable in this browser." }));
      return;
    }
    void navigator.clipboard.writeText(token).then(
      () => setState((current) => ({ ...current, copyMessage: "Invitation code copied." })),
      () => setState((current) => ({ ...current, copyMessage: "The invitation code could not be copied." })),
    );
  };

  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={open}
        className="min-h-8 border border-zinc-700 px-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-zinc-600"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        type="button"
      >
        Invite
      </button>
      {open ? (
        <section
          aria-label="Invite organization member"
          className="absolute right-0 top-10 z-50 w-80 border border-zinc-700 bg-zinc-950 p-4 text-left shadow-xl"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Invite a member</h2>
              <p className="mt-1 text-xs leading-5 text-zinc-500">Create one code for this organization.</p>
            </div>
            <button
              aria-label="Close invitation form"
              className="min-h-8 px-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
              onClick={close}
              type="button"
            >
              ×
            </button>
          </div>
          {state.created ? (
            <div className="mt-4">
              <p className="text-xs leading-5 text-amber-200">Copy now. This code is shown only in this panel.</p>
              <output
                aria-label="Invitation code"
                className="mt-2 block break-all border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs leading-5 text-zinc-200"
              >
                {state.created.invitationToken}
              </output>
              <button
                className="mt-3 min-h-9 w-full border border-sky-700 bg-sky-950 px-3 text-xs font-medium text-sky-100 hover:bg-sky-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
                onClick={copyInvitation}
                type="button"
              >
                Copy invitation code
              </button>
              {state.copyMessage ? (
                <p className="mt-2 text-xs text-zinc-400" role="status">
                  {state.copyMessage}
                </p>
              ) : null}
            </div>
          ) : (
            <form className="mt-4 space-y-3" onSubmit={createInvitation}>
              <label className="block text-xs font-medium text-zinc-300">
                Email
                <input
                  autoComplete="email"
                  className="mt-1 h-9 w-full border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:text-zinc-600"
                  disabled={state.pending}
                  maxLength={254}
                  onChange={(event) => setEmail(event.currentTarget.value)}
                  required
                  type="email"
                  value={email}
                />
              </label>
              <label className="block text-xs font-medium text-zinc-300">
                Role
                <select
                  className="mt-1 h-9 w-full border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:text-zinc-600"
                  disabled={state.pending}
                  onChange={(event) => setRole(event.currentTarget.value as AccountInvitationRoleV1)}
                  value={role}
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="billing">Billing</option>
                </select>
              </label>
              {state.error ? (
                <p className="text-xs leading-5 text-amber-300" role="alert">
                  {state.error}
                </p>
              ) : null}
              <button
                className="min-h-9 w-full border border-sky-700 bg-sky-950 px-3 text-xs font-medium text-sky-100 hover:bg-sky-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-sky-500"
                disabled={state.pending}
                type="submit"
              >
                {state.pending ? "Creating…" : "Create invitation"}
              </button>
            </form>
          )}
        </section>
      ) : null}
    </div>
  );
}
