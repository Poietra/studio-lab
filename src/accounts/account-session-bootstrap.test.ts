import { describe, expect, it } from "vitest";

import {
  accountSessionAllowsStudioV1,
  accountSessionMountKeyV1,
  productionBrowserAccountBootstrapRequired,
} from "./account-session-bootstrap";
import type { AccountSessionViewV1 } from "./account-session-contract";

function session(role: AccountSessionViewV1["activeOrganization"]["role"]): AccountSessionViewV1 {
  return {
    activeOrganization: { displayName: "Poietra", id: "organization-a", role },
    organizations: [{ displayName: "Poietra", id: "organization-a", role }],
    user: { displayName: "Ada", id: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8" },
    version: 1,
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
