import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountInvitationSignInForm } from "./account-invitation-sign-in-form";

describe("AccountInvitationSignInForm", () => {
  it("uses a bounded native POST without putting a token in its target", () => {
    const html = renderToStaticMarkup(<AccountInvitationSignInForm />);
    expect(html).toContain('action="/auth/oidc/start"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="invitationToken"');
    expect(html).toContain('maxLength="43"');
    expect(html).not.toContain("invitationToken=");
  });
});
