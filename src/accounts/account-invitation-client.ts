import {
  type AccountInvitationCreateRequestV1,
  accountInvitationCreateRequestSchemaV1,
  accountInvitationCreateResponseSchemaV1,
} from "./account-invitation-contract";

export class AccountInvitationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AccountInvitationRequestError";
  }
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function invitationFailureMessage(status: number) {
  if (status === 429) return "Too many invitation attempts. Try again later.";
  if (status === 503) return "Invitation service is temporarily unavailable.";
  return "The invitation could not be created.";
}

export async function createAccountInvitationV1(input: AccountInvitationCreateRequestV1, signal?: AbortSignal) {
  const request = accountInvitationCreateRequestSchemaV1.safeParse({ ...input, email: normalizeEmail(input.email) });
  if (!request.success) throw new TypeError("The invitation details are invalid.");
  const response = await fetch("/api/account/invitations", {
    body: JSON.stringify(request.data),
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "POST",
    signal,
  });
  if (response.status !== 201) {
    throw new AccountInvitationRequestError(invitationFailureMessage(response.status), response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("The invitation service returned malformed JSON.");
  }
  const parsed = accountInvitationCreateResponseSchemaV1.safeParse(body);
  if (!parsed.success) throw new Error("The invitation service returned an invalid invitation.");
  return parsed.data;
}
