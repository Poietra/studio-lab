import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountInvitationSignInForm, bindInvitationSecretClearingV1 } from "./account-invitation-sign-in-form";

describe("AccountInvitationSignInForm", () => {
  it("uses a bounded native POST without putting a token in its target", () => {
    const html = renderToStaticMarkup(<AccountInvitationSignInForm />);
    expect(html).toContain('action="/auth/oidc/start"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="invitationToken"');
    expect(html).toContain('maxLength="43"');
    expect(html).not.toContain("invitationToken=");
  });

  it.each(["formdata", "pagehide", "pageshow"])("clears the DOM secret on %s", (eventName) => {
    const form = new EventTarget();
    const lifecycle = new EventTarget();
    const input = { value: "raw-invitation-secret" };
    const unbind = bindInvitationSecretClearingV1(form, input, lifecycle);

    (eventName === "formdata" ? form : lifecycle).dispatchEvent(new Event(eventName));
    expect(input.value).toBe("");

    input.value = "second-secret";
    unbind();
    expect(input.value).toBe("");
    input.value = "detached";
    (eventName === "formdata" ? form : lifecycle).dispatchEvent(new Event(eventName));
    expect(input.value).toBe("detached");
  });
});
