import type { AccountOrganizationBootstrapRequestV1 } from "../../src/accounts/account-organization-contract";

export type AccountOrganizationBootstrapInputV1 = Readonly<
  AccountOrganizationBootstrapRequestV1 & { sessionTokenHash: Uint8Array }
>;

export type AccountOrganizationBootstrapResultV1 =
  | Readonly<{
      kind: "applied";
      mutationId: string;
      organization: Readonly<{ displayName: string; id: string; role: "owner" }>;
      replayed: boolean;
      version: number;
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "invalid-session" }>
  | Readonly<{ kind: "organization-unavailable" }>;

export interface AccountOrganizationRepositoryV1 {
  close(): Promise<void>;
  createOrganization(
    input: AccountOrganizationBootstrapInputV1,
    signal?: AbortSignal,
  ): Promise<AccountOrganizationBootstrapResultV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
}
