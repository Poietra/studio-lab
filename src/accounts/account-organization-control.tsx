import { type FormEvent, useEffect, useRef, useState } from "react";

import { createAccountOrganizationV1 } from "./account-organization-client";
import type { AccountSessionViewV1 } from "./account-session-contract";

function organizationId() {
  return `org-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

type AccountOrganizationCreationIdentity = Readonly<{
  displayName: string;
  expectedVersion: number;
  mutationId: string;
  organizationId: string;
}>;

export function accountOrganizationCreationIdentity(
  current: AccountOrganizationCreationIdentity | null,
  displayName: string,
  expectedVersion: number,
): AccountOrganizationCreationIdentity {
  if (current?.displayName === displayName) return current;
  return {
    displayName,
    expectedVersion,
    mutationId: crypto.randomUUID(),
    organizationId: organizationId(),
  };
}

export async function runAccountOrganizationCreation(
  beforeCreate: (() => Promise<boolean>) | undefined,
  create: () => Promise<unknown>,
) {
  if (beforeCreate && !(await beforeCreate())) return false;
  await create();
  return true;
}

export function AccountOrganizationControl({
  beforeCreate,
  disabled = false,
  onCreated,
  session,
}: Readonly<{
  beforeCreate?: () => Promise<boolean>;
  disabled?: boolean;
  onCreated: () => void;
  session: AccountSessionViewV1;
}>) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  const creationIdentity = useRef<AccountOrganizationCreationIdentity | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  const close = () => {
    request.current?.abort();
    request.current = null;
    creationIdentity.current = null;
    setDisplayName("");
    setError(null);
    setPending(false);
    setOpen(false);
  };

  const createOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || disabled) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setPending(true);
    setError(null);
    void runAccountOrganizationCreation(beforeCreate, async () => {
      if (request.current !== controller || controller.signal.aborted) return;
      const identity = accountOrganizationCreationIdentity(creationIdentity.current, displayName, session.version);
      creationIdentity.current = identity;
      await createAccountOrganizationV1(
        {
          displayName: identity.displayName,
          expectedVersion: identity.expectedVersion,
          mutationId: identity.mutationId,
          organizationId: identity.organizationId,
        },
        controller.signal,
      );
    })
      .then((created) => {
        if (request.current !== controller || controller.signal.aborted) return;
        request.current = null;
        if (!created) {
          setPending(false);
          return;
        }
        close();
        onCreated();
      })
      .catch((reason: unknown) => {
        if (request.current !== controller || controller.signal.aborted) return;
        request.current = null;
        setPending(false);
        setError(reason instanceof Error ? reason.message : "The organization could not be created.");
      });
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
        New organization
      </button>
      {open ? (
        <section
          aria-label="Create organization"
          className="absolute right-0 top-10 z-50 w-80 border border-zinc-700 bg-zinc-950 p-4 text-left shadow-xl"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Create organization</h2>
              <p className="mt-1 text-xs leading-5 text-zinc-500">A new private workspace group owned by you.</p>
            </div>
            <button
              aria-label="Close organization form"
              className="min-h-8 px-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              onClick={close}
              type="button"
            >
              ×
            </button>
          </div>
          <form className="mt-4 space-y-3" onSubmit={createOrganization}>
            <label className="block text-xs font-medium text-zinc-300">
              Organization name
              <input
                className="mt-1 h-9 w-full border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                disabled={pending}
                maxLength={120}
                onChange={(event) => {
                  creationIdentity.current = null;
                  setDisplayName(event.currentTarget.value);
                }}
                required
                value={displayName}
              />
            </label>
            {error ? (
              <p className="text-xs text-amber-300" role="alert">
                {error}
              </p>
            ) : null}
            <button
              className="min-h-9 w-full border border-sky-700 bg-sky-950 px-3 text-xs font-medium text-sky-100 hover:bg-sky-900 disabled:text-sky-500"
              disabled={pending}
              type="submit"
            >
              {pending ? "Creating…" : "Create organization"}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
