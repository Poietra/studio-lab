import { describe, expect, it, vi } from "vitest";

import {
  accountSessionAllowsStudioV1,
  accountSessionMountKeyV1,
  productionBrowserAccountBootstrapRequired,
  recoverAccountOrganizationSwitchV1,
} from "./account-session-bootstrap";
import { AccountSessionRequestError } from "./account-session-client";
import type { AccountSessionViewV1 } from "./account-session-contract";

function session(role: AccountSessionViewV1["activeOrganization"]["role"]): AccountSessionViewV1 {
  return {
    activeOrganization: { displayName: "Poietra", id: "organization-a", role },
    organizationSwitch: null,
    organizations: [{ displayName: "Poietra", id: "organization-a", role }],
    user: { displayName: "Ada", id: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8" },
    version: 1,
  };
}

const switchIdentity = {
  mutationId: "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b",
  organizationId: "organization-b",
} as const;

function switchedSession(
  organizationSwitch: AccountSessionViewV1["organizationSwitch"] = { ...switchIdentity, version: 2 },
): AccountSessionViewV1 {
  return {
    activeOrganization: { displayName: "Studio Team", id: "organization-b", role: "member" },
    organizations: [
      { displayName: "Poietra", id: "organization-a", role: "owner" },
      { displayName: "Studio Team", id: "organization-b", role: "member" },
    ],
    organizationSwitch,
    user: { displayName: "Ada", id: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8" },
    version: 2,
  };
}

describe("account session bootstrap policy", () => {
  it.each(["owner", "admin", "member"] as const)("mounts Studio for the %s role", (role) => {
    expect(accountSessionAllowsStudioV1(session(role))).toBe(true);
  });

  it("keeps billing-only accounts out of Studio workspace requests", () => {
    expect(accountSessionAllowsStudioV1(session("billing"))).toBe(false);
  });

  it("changes the App remount boundary across both users and organizations", () => {
    const first = session("owner");
    const nextUser = { ...first, user: { ...first.user, id: "35b33044-5387-4c29-aed1-cad82750f4cc" } };
    const nextOrganization = {
      ...first,
      activeOrganization: { ...first.activeOrganization, id: "organization-b" },
    };

    expect(accountSessionMountKeyV1(first)).not.toBe(accountSessionMountKeyV1(nextUser));
    expect(accountSessionMountKeyV1(first)).not.toBe(accountSessionMountKeyV1(nextOrganization));
  });

  it.each([
    [{ electron: false, production: true, tauri: false }, true],
    [{ electron: false, production: false, tauri: false }, false],
    [{ electron: true, production: true, tauri: false }, false],
    [{ electron: false, production: true, tauri: true }, false],
  ] as const)("selects the account boundary for the active shell", (input, expected) => {
    expect(productionBrowserAccountBootstrapRequired(input)).toBe(expected);
  });
});

describe("ambiguous organization switch recovery", () => {
  it("confirms a lost PATCH response only from the exact authoritative mutation", async () => {
    const controller = new AbortController();
    const session = switchedSession();
    const load = vi.fn(async () => session);

    await expect(
      recoverAccountOrganizationSwitchV1(switchIdentity, controller.signal, () => true, load),
    ).resolves.toEqual({ kind: "confirmed", session });
    expect(load).toHaveBeenCalledWith(controller.signal);
  });

  it.each([
    null,
    { ...switchIdentity, mutationId: "5a5dcb34-541d-4805-9d70-fbf6db8e325b", version: 2 },
    { ...switchIdentity, organizationId: "organization-a", version: 2 },
  ] as const)("keeps an ambiguous switch unconfirmed for a non-matching GET result", async (organizationSwitch) => {
    const session = switchedSession(organizationSwitch);

    await expect(
      recoverAccountOrganizationSwitchV1(
        switchIdentity,
        new AbortController().signal,
        () => true,
        async () => session,
      ),
    ).resolves.toEqual({ kind: "not-confirmed", session });
  });

  it("distinguishes signed-out recovery from an unavailable authoritative GET", async () => {
    await expect(
      recoverAccountOrganizationSwitchV1(
        switchIdentity,
        new AbortController().signal,
        () => true,
        async () => {
          throw new AccountSessionRequestError("Sign in is required.", 401);
        },
      ),
    ).resolves.toEqual({ kind: "signed-out" });

    await expect(
      recoverAccountOrganizationSwitchV1(
        switchIdentity,
        new AbortController().signal,
        () => true,
        async () => {
          throw new AccountSessionRequestError("Account access is unavailable.", 503);
        },
      ),
    ).resolves.toEqual({ kind: "unavailable", status: 503 });
  });

  it("drops an authoritative recovery result after its request generation becomes stale", async () => {
    let resolveSession: ((session: AccountSessionViewV1) => void) | undefined;
    const pendingSession = new Promise<AccountSessionViewV1>((resolve) => {
      resolveSession = resolve;
    });
    let current = true;
    const recovery = recoverAccountOrganizationSwitchV1(
      switchIdentity,
      new AbortController().signal,
      () => current,
      () => pendingSession,
    );

    current = false;
    resolveSession?.(switchedSession());

    await expect(recovery).resolves.toEqual({ kind: "stale" });
  });
});
