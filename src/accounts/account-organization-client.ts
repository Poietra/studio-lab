import {
  type AccountOrganizationBootstrapRequestV1,
  accountOrganizationBootstrapRequestSchemaV1,
  accountOrganizationBootstrapResponseSchemaV1,
} from "./account-organization-contract";

export class AccountOrganizationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AccountOrganizationRequestError";
  }
}

export async function createAccountOrganizationV1(input: AccountOrganizationBootstrapRequestV1, signal?: AbortSignal) {
  const request = accountOrganizationBootstrapRequestSchemaV1.safeParse(input);
  if (!request.success) throw new TypeError("The organization details are invalid.");
  const response = await fetch("/api/account/organizations", {
    body: JSON.stringify(request.data),
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "POST",
    signal,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new AccountOrganizationRequestError(
      response.status === 409
        ? "The organization changed. Refresh and try again."
        : "The organization could not be created.",
      response.status,
    );
  }
  const parsed = accountOrganizationBootstrapResponseSchemaV1.safeParse(await response.json());
  if (!parsed.success) throw new Error("The account service returned an invalid organization.");
  return parsed.data;
}
