/** Wire name of the untrusted organization selector header (ADR 0005). */
export const ORGANIZATION_SELECTOR_HEADER_V1 = "x-poietra-organization-id";

export type OrganizationSelectorHeaderResultV1 =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "conflicting" }>
  | Readonly<{ kind: "selected"; requestedOrganizationId: string }>;

const ORGANIZATION_SELECTOR_ABSENT_V1: OrganizationSelectorHeaderResultV1 = Object.freeze({
  kind: "absent",
});

const ORGANIZATION_SELECTOR_CONFLICTING_V1: OrganizationSelectorHeaderResultV1 = Object.freeze({
  kind: "conflicting",
});

/**
 * Transport-side cardinality normalization of the untrusted organization
 * selector header, shared by the Node production server and the billing
 * control plane. It only decides whether zero, one, or conflicting selector
 * values were supplied; each transport maps a conflicting result onto its own
 * unchanged wire response, the selector stays untrusted bytes, and the tenant
 * decision flows exclusively through organization membership admission.
 */
export function normalizeOrganizationSelectorHeaderV1(
  distinctValues: readonly string[] | undefined,
): OrganizationSelectorHeaderResultV1 {
  const [selector, ...conflicting] = distinctValues ?? [];
  if (selector === undefined) return ORGANIZATION_SELECTOR_ABSENT_V1;
  if (conflicting.length > 0) return ORGANIZATION_SELECTOR_CONFLICTING_V1;
  return Object.freeze({ kind: "selected", requestedOrganizationId: selector });
}

/**
 * Fetch `Headers.get` joins repeated header values into one comma-separated
 * string. A valid organization id can never contain a comma, so a comma always
 * means conflicting selector values; this mirrors the Node transport's
 * distinct-header conflict detection for the Fetch transport.
 */
export function normalizeCombinedOrganizationSelectorHeaderV1(
  combinedValue: string | null,
): OrganizationSelectorHeaderResultV1 {
  if (combinedValue === null) return ORGANIZATION_SELECTOR_ABSENT_V1;
  return normalizeOrganizationSelectorHeaderV1(combinedValue.split(","));
}
