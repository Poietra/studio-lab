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
  organizations: AccountSessionViewV1["organizations"];
  user: AccountSessionViewV1["user"];
}>;

/** Bounded account bootstrap read model for a server-issued opaque session. */
export interface AccountSessionViewRepositoryV1 {
  close(): Promise<void>;
  resolveAccountSession(
    sessionTokenHash: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ResolvedAccountSessionAccountV1 | null>;
}
