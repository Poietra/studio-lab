import {
  type AccountInvitationCreateRequestV1,
  accountInvitationCreateRequestSchemaV1,
  accountInvitationCreateResponseSchemaV1,
} from "./account-invitation-contract";

const MAX_ACCOUNT_INVITATION_RESPONSE_BYTES_V1 = 2 * 1_024;

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

async function readBoundedInvitationResponseV1(response: Response) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentLength = response.headers.get("content-length");
  if (contentType !== "application/json") throw new Error("The invitation service returned an invalid response.");
  if (
    contentLength !== null &&
    (!/^(0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > MAX_ACCOUNT_INVITATION_RESPONSE_BYTES_V1)
  ) {
    throw new Error("The invitation service returned an invalid response.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The invitation service returned an invalid response.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_ACCOUNT_INVITATION_RESPONSE_BYTES_V1) {
        await reader.cancel();
        throw new Error("The invitation service returned an invalid response.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("The invitation service returned malformed JSON.");
  }
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
  const body = await readBoundedInvitationResponseV1(response);
  const parsed = accountInvitationCreateResponseSchemaV1.safeParse(body);
  if (!parsed.success) throw new Error("The invitation service returned an invalid invitation.");
  return parsed.data;
}
