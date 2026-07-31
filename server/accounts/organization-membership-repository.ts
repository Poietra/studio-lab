import type { OrganizationRoleV1 } from "./account-domain";

export type ExternalAccountIdentityV1 = Readonly<{
  issuer: string;
  subject: string;
}>;

export type ResolvedOrganizationMembershipV1 = Readonly<{
  organizationId: string;
  role: OrganizationRoleV1;
  userId: string;
  version: bigint;
}>;

/**
 * Resolves a verified external identity against the server-owned membership
 * ledger. Implementations must return only active users, organizations, and
 * memberships; callers treat a missing row as an authorization denial.
 */
export interface OrganizationMembershipRepositoryV1 {
  close(): Promise<void>;
  ready(signal?: AbortSignal): Promise<boolean>;
  resolveActiveMembership(
    identity: ExternalAccountIdentityV1,
    organizationId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedOrganizationMembershipV1 | null>;
}
