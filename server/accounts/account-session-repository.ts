import type { AccountOrganizationMemberV1 } from "../../src/accounts/account-membership-contract";
import type { AccountSessionViewV1 } from "../../src/accounts/account-session-contract";
import type { ExternalAccountIdentityV1 } from "./organization-membership-repository";

export type ResolvedAccountSessionV1 = ExternalAccountIdentityV1 &
  Readonly<{
    sessionOrganizationId: string;
  }>;

/** Resolves only server-issued opaque session tokens; raw tokens are never persisted. */
export interface AccountSessionRepositoryV1 {
  close(): Promise<void>;
  ready(signal?: AbortSignal): Promise<boolean>;
  resolveActiveSession(sessionTokenHash: Uint8Array, signal?: AbortSignal): Promise<ResolvedAccountSessionV1 | null>;
}

export type ResolvedAccountSessionAccountV1 = Readonly<{
  /** The session-owned selector; the fetch boundary must find it in organizations or deny access. */
  activeOrganizationId: string;
  organizationSwitch: AccountSessionViewV1["organizationSwitch"];
  organizations: AccountSessionViewV1["organizations"];
  user: AccountSessionViewV1["user"];
  version: number;
}>;

/** Bounded account bootstrap read model for a server-issued opaque session. */
export interface AccountSessionViewRepositoryV1 {
  close(): Promise<void>;
  resolveAccountSession(
    sessionTokenHash: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ResolvedAccountSessionAccountV1 | null>;
}

export type SwitchActiveOrganizationResultV1 =
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "invalid-session" }>
  | Readonly<{ kind: "organization-unavailable" }>
  | Readonly<{
      account: ResolvedAccountSessionAccountV1;
      kind: "updated";
      mutation: NonNullable<AccountSessionViewV1["organizationSwitch"]>;
    }>;

export type ListActiveOrganizationMembersResultV1 =
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "invalid-session" }>
  | Readonly<{ kind: "listed"; members: readonly AccountOrganizationMemberV1[] }>;

export interface AccountMembershipViewRepositoryV1 {
  close(): Promise<void>;
  listActiveOrganizationMembers(
    sessionTokenHash: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ListActiveOrganizationMembersResultV1>;
}

/** Request-scoped browser account mutations; raw session tokens never cross this boundary. */
export interface AccountSessionControlRepositoryV1
  extends AccountSessionViewRepositoryV1,
    AccountMembershipViewRepositoryV1 {
  revokeAccountSession(sessionTokenHash: Uint8Array, signal?: AbortSignal): Promise<void>;
  switchActiveOrganization(
    sessionTokenHash: Uint8Array,
    organizationId: string,
    expectedVersion: number,
    mutationId: string,
    signal?: AbortSignal,
  ): Promise<SwitchActiveOrganizationResultV1>;
}
