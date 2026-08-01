import { accountOrganizationSwitchRequestSchemaV1, accountSessionViewSchemaV1 } from "./account-session-contract";

export class AccountSessionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AccountSessionRequestError";
  }
}

async function readAccountSessionResponseV1(response: Response) {
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

export async function loadAccountSessionV1(signal?: AbortSignal) {
  return readAccountSessionResponseV1(
    await fetch("/api/account/session", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    }),
  );
}

export async function switchAccountOrganizationV1(
  organizationId: string,
  expectedVersion: number,
  signal?: AbortSignal,
) {
  const request = accountOrganizationSwitchRequestSchemaV1.safeParse({ expectedVersion, organizationId });
  if (!request.success) throw new TypeError("The account organization is invalid.");
  const session = await readAccountSessionResponseV1(
    await fetch("/api/account/session", {
      body: JSON.stringify(request.data),
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "PATCH",
      signal,
    }),
  );
  if (session.activeOrganization.id !== request.data.organizationId) {
    throw new Error("The account service did not confirm the selected organization.");
  }
  return session;
}

export async function logoutAccountSessionV1(signal?: AbortSignal) {
  const response = await fetch("/api/account/logout", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    throw new AccountSessionRequestError(
      response.status === 401 ? "Sign in is required." : "Account access is unavailable.",
      response.status,
    );
  }
  if (response.status !== 204) throw new Error("The account service returned an invalid logout response.");
}
