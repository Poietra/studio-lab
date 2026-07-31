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
