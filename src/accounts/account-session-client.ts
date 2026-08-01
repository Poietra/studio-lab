import { accountSessionViewSchemaV1 } from "./account-session-contract";

export class AccountSessionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AccountSessionRequestError";
  }
}

export async function loadAccountSessionV1(signal?: AbortSignal) {
  const response = await fetch("/api/account/session", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new AccountSessionRequestError(
      response.status === 401 ? "Sign in is required." : "Account access is unavailable.",
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("The account service returned malformed JSON.");
  }
  const parsed = accountSessionViewSchemaV1.safeParse(body);
  if (!parsed.success) throw new Error("The account service returned an invalid session.");
  return parsed.data;
}
