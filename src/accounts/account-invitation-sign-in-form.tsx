import { useEffect, useRef } from "react";

export function AccountInvitationSignInForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const form = formRef.current;
    const clearSecret = () => {
      if (inputRef.current) inputRef.current.value = "";
    };
    if (!form) return;
    // The native formdata event runs after the browser has constructed the
    // request body. Clear only the DOM copy, leaving the submitted FormData
    // intact and preventing BFCache/history restoration of the raw token.
    form.addEventListener("formdata", clearSecret);
    window.addEventListener("pagehide", clearSecret);
    window.addEventListener("pageshow", clearSecret);
    return () => {
      form.removeEventListener("formdata", clearSecret);
      window.removeEventListener("pagehide", clearSecret);
      window.removeEventListener("pageshow", clearSecret);
      clearSecret();
    };
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
        type="password"
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
