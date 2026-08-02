import type { ExternalAccountIdentityV1 } from "./organization-membership-repository";

export const OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1 = 10 * 60 * 1_000;
export const ACCOUNT_SESSION_MAX_LIFETIME_MS_V1 = 30 * 24 * 60 * 60 * 1_000;

export type CreateOidcLoginAttemptV1 = Readonly<{
  browserBindingHash: Uint8Array;
  codeVerifier: string;
  invitationTokenDigest?: Uint8Array;
  lifetimeMs: number;
  nonce: string;
  stateHash: Uint8Array;
}>;

export type ConsumedOidcLoginAttemptV1 = Readonly<{
  codeVerifier: string;
  invitationTokenDigest: Uint8Array | null;
  nonce: string;
}>;

export type IssueAccountSessionV1 = Readonly<{
  identity: ExternalAccountIdentityV1;
  lifetimeMs: number;
  sessionTokenHash: Uint8Array;
}>;

export type IssuedAccountSessionV1 = Readonly<{
  expiresAt: Date;
}>;

export type IssueInvitedAccountSessionV1 = IssueAccountSessionV1 &
  Readonly<{
    invitationTokenDigest: Uint8Array;
    newUserDisplayName: string;
    newUserId: string;
    verifiedEmail: string;
  }>;

/** Persistence boundary for a one-time OIDC callback and its opaque browser session. */
export interface OidcLoginRepositoryV1 {
  close(): Promise<void>;
  consumeLoginAttempt(
    selector: Readonly<{ browserBindingHash: Uint8Array; stateHash: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<ConsumedOidcLoginAttemptV1 | null>;
  createLoginAttempt(
    input: CreateOidcLoginAttemptV1,
    signal?: AbortSignal,
  ): Promise<Readonly<{ expiresAt: Date }> | null>;
  issueAccountSession(input: IssueAccountSessionV1, signal?: AbortSignal): Promise<IssuedAccountSessionV1 | null>;
  issueInvitedAccountSession(
    input: IssueInvitedAccountSessionV1,
    signal?: AbortSignal,
  ): Promise<IssuedAccountSessionV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
}
