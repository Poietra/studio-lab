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
  });
});
