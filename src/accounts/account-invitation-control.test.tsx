import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountInvitationControl, accountRoleCanIssueInvitationsV1 } from "./account-invitation-control";

describe("AccountInvitationControl", () => {
  it("exposes issuance only to owner and admin roles", () => {
    expect(accountRoleCanIssueInvitationsV1("owner")).toBe(true);
    expect(accountRoleCanIssueInvitationsV1("admin")).toBe(true);
    expect(accountRoleCanIssueInvitationsV1("member")).toBe(false);
    expect(accountRoleCanIssueInvitationsV1("billing")).toBe(false);
  });

  it("does not render a token or form before an explicit open action", () => {
    const html = renderToStaticMarkup(<AccountInvitationControl />);
    expect(html).toContain("Invite");
    expect(html).not.toContain("Invitation code");
    expect(html).not.toContain("localStorage");
  });
});
