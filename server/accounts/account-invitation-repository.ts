import type { OrganizationInvitationRoleV1 } from "./account-domain";

export const ACCOUNT_INVITATION_MIN_LIFETIME_MS_V1 = 5 * 60_000;
export const ACCOUNT_INVITATION_MAX_LIFETIME_MS_V1 = 7 * 24 * 60 * 60_000;
export const ACCOUNT_INVITATION_DEFAULT_LIFETIME_MS_V1 = 72 * 60 * 60_000;

export type CreateAccountInvitationV1 = Readonly<{
  invitationId: string;
  lifetimeMs: number;
  normalizedEmail: string;
  role: OrganizationInvitationRoleV1;
  sessionTokenHash: Uint8Array;
  tokenDigest: Uint8Array;
}>;

export type CreatedAccountInvitationV1 = Readonly<{
  expiresAt: Date;
  invitationId: string;
}>;

export interface AccountInvitationRepositoryV1 {
  close(): Promise<void>;
  createInvitation(input: CreateAccountInvitationV1, signal?: AbortSignal): Promise<CreatedAccountInvitationV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
  revokeInvitation(
    input: Readonly<{ invitationId: string; sessionTokenHash: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<boolean>;
}
