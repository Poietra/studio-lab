import {
  type AccountMembershipMutationRequestV1,
  accountMembershipMutationRequestSchemaV1,
  accountMembershipMutationResponseSchemaV1,
  accountOrganizationMembersViewSchemaV1,
} from "./account-membership-contract";

export class AccountMembershipRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AccountMembershipRequestError";
  }
}

function failure(status: number) {
  if (status === 409) return "The member changed. Refresh and try again.";
  if (status === 403) return "You cannot change this member.";
  return "Organization members are temporarily unavailable.";
}

export async function loadAccountOrganizationMembersV1(signal?: AbortSignal) {
  const response = await fetch("/api/account/members", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new AccountMembershipRequestError(failure(response.status), response.status);
  const parsed = accountOrganizationMembersViewSchemaV1.safeParse(await response.json());
  if (!parsed.success) throw new Error("The account service returned invalid members.");
  return parsed.data;
}

export async function mutateAccountOrganizationMemberV1(
  memberId: string,
  input: AccountMembershipMutationRequestV1,
  signal?: AbortSignal,
) {
  const request = accountMembershipMutationRequestSchemaV1.safeParse(input);
  if (!request.success) throw new TypeError("The member change is invalid.");
  const response = await fetch(`/api/account/members/${encodeURIComponent(memberId)}`, {
    body: JSON.stringify(request.data),
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    method: request.data.action === "set-role" ? "PATCH" : "DELETE",
    signal,
  });
  if (!response.ok) throw new AccountMembershipRequestError(failure(response.status), response.status);
  const parsed = accountMembershipMutationResponseSchemaV1.safeParse(await response.json());
  if (!parsed.success) throw new Error("The account service returned an invalid member change.");
  return parsed.data;
}
