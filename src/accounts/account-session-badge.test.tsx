import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccountSessionBadge } from "./account-session-badge";

describe("AccountSessionBadge", () => {
  it("uses native account controls with the active organization selected", () => {
    const markup = renderToStaticMarkup(
      <AccountSessionBadge
        actions={{ actionError: null, logout: vi.fn(), switchOrganization: vi.fn() }}
        session={{
          activeOrganization: { displayName: "Studio Team", id: "organization-b", role: "member" },
          organizations: [
            { displayName: "Poietra", id: "organization-a", role: "owner" },
            { displayName: "Studio Team", id: "organization-b", role: "member" },
          ],
          user: { displayName: "Ada", id: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8" },
          version: 1,
        }}
      />,
    );

    expect(markup).toContain("<select");
    expect(markup).toContain('aria-label="Active organization"');
    expect(markup).toContain('value="organization-a"');
    expect(markup).toContain('value="organization-b" selected=""');
    expect(markup).toContain(">Sign out</button>");
    expect(markup).not.toContain(">Invite</button>");
    expect(markup).not.toContain(">Billing</button>");
  });

  it("offers billing settings to an owner without putting provider identifiers in the UI", () => {
    const markup = renderToStaticMarkup(
      <AccountSessionBadge
        actions={{ actionError: null, logout: vi.fn(), switchOrganization: vi.fn() }}
        session={{
          activeOrganization: { displayName: "Poietra", id: "organization-a", role: "owner" },
          organizations: [{ displayName: "Poietra", id: "organization-a", role: "owner" }],
          user: { displayName: "Ada", id: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8" },
          version: 1,
        }}
      />,
    );

    expect(markup).toContain(">Billing</button>");
    expect(markup).toContain(">Invite</button>");
    expect(markup).toContain("Billing settings");
    expect(markup).not.toMatch(/customerId|priceId|configurationId|returnUrl/);
  });

  it("disables every account navigation control while an Editor session transition is pending", () => {
    const markup = renderToStaticMarkup(
      <AccountSessionBadge
        actions={{ actionError: null, logout: vi.fn(), switchOrganization: vi.fn() }}
        beforeExternalNavigation={vi.fn(async () => true)}
        disabled
        session={{
          activeOrganization: { displayName: "Poietra", id: "organization-a", role: "owner" },
          organizations: [{ displayName: "Poietra", id: "organization-a", role: "owner" }],
          user: { displayName: "Ada", id: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8" },
          version: 1,
        }}
      />,
    );

    expect(markup.match(/disabled=""/g)).toHaveLength(4);
  });
});
