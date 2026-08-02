import { useEffect, useRef } from "react";

type InvitationSecretEventTargetV1 = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export function bindInvitationSecretClearingV1(
  form: InvitationSecretEventTargetV1,
  input: { value: string },
  lifecycle: InvitationSecretEventTargetV1,
) {
  const clearSecret = () => {
    input.value = "";
  };
  form.addEventListener("formdata", clearSecret);
  lifecycle.addEventListener("pagehide", clearSecret);
  lifecycle.addEventListener("pageshow", clearSecret);
  return () => {
    form.removeEventListener("formdata", clearSecret);
    lifecycle.removeEventListener("pagehide", clearSecret);
    lifecycle.removeEventListener("pageshow", clearSecret);
    clearSecret();
  };
}

export function AccountInvitationSignInForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const form = formRef.current;
    const input = inputRef.current;
    if (!form || !input) return;
    // The native formdata event runs after the browser has constructed the
    // request body. Clear only the DOM copy, leaving the submitted FormData
    // intact and preventing BFCache/history restoration of the raw token.
    return bindInvitationSecretClearingV1(form, input, window);
  }, []);

  return (
    <form action="/auth/oidc/start" method="post" ref={formRef}>
      <label className="block text-sm font-medium text-zinc-300" htmlFor="account-invitation-token">
        Invitation code
      </label>
      <input
        autoComplete="off"
        className="mt-2 h-10 w-full border border-zinc-700 bg-zinc-900 px-3 font-mono text-sm text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
        id="account-invitation-token"
        maxLength={43}
        minLength={43}
        name="invitationToken"
        pattern="[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]"
        ref={inputRef}
        required
        spellCheck={false}
        type="text"
      />
      <button
        className="mt-3 min-h-10 w-full border border-zinc-700 px-4 text-sm font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
        type="submit"
      >
        Accept invitation
      </button>
    </form>
  );
}
