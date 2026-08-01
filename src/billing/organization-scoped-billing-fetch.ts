import { accountOrganizationIdSchemaV1 } from "../accounts/account-session-contract";

export const POIETRA_BILLING_ORGANIZATION_HEADER_V1 = "X-Poietra-Organization-Id";

const BILLING_API_PATHS_V1 = new Set(["/api/billing/checkout", "/api/billing/portal", "/api/billing/status"]);

export async function fetchOrganizationScopedBillingApiV1(
  organizationId: string,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const parsedOrganizationId = accountOrganizationIdSchemaV1.safeParse(organizationId);
  if (!parsedOrganizationId.success) throw new TypeError("The billing API organization scope is invalid.");
  if (typeof input !== "string" || !BILLING_API_PATHS_V1.has(input)) {
    throw new TypeError("The billing API client accepts only known same-origin API paths.");
  }
  const headers = new Headers(init?.headers);
  const suppliedOrganizationId = headers.get(POIETRA_BILLING_ORGANIZATION_HEADER_V1);
  if (suppliedOrganizationId !== null && suppliedOrganizationId !== parsedOrganizationId.data) {
    throw new Error("The billing request organization does not match the active account.");
  }
  headers.set(POIETRA_BILLING_ORGANIZATION_HEADER_V1, parsedOrganizationId.data);
  return fetch(input, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers,
  });
}
