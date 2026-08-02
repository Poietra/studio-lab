import {
  ACCOUNT_INVITATION_DEFAULT_LIFETIME_MS_V1,
  ACCOUNT_INVITATION_MAX_LIFETIME_MS_V1,
  ACCOUNT_INVITATION_MIN_LIFETIME_MS_V1,
  type AccountInvitationRepositoryV1,
} from "./account-invitation-repository";
import {
  normalizeAccountEmailV1,
  organizationInvitationRoleSchemaV1,
  type OrganizationInvitationRoleV1,
} from "./account-domain";

const OPAQUE_TOKEN_PATTERN_V1 = /^[A-Za-z0-9_-]{43}$/u;

export type AccountInvitationViewV1 = Readonly<{
  expiresAt: string;
  invitationId: string;
  invitationToken: string;
}>;

export interface AccountInvitationServiceV1 {
  close(): Promise<void>;
  create(
    input: Readonly<{
      email: string;
      lifetimeMs?: number;
      role: OrganizationInvitationRoleV1;
      sessionTokenHash: Uint8Array;
    }>,
    signal?: AbortSignal,
  ): Promise<AccountInvitationViewV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
  revoke(
    input: Readonly<{ invitationId: string; sessionTokenHash: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

function encodeBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
}

function generatedToken(generator: (size: number) => Uint8Array) {
  const bytes = generator(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new TypeError("Invitation token generator must return exactly 32 random bytes.");
  }
  const token = encodeBase64Url(bytes);
  if (!OPAQUE_TOKEN_PATTERN_V1.test(token)) throw new TypeError("Invitation token generation failed.");
  return { bytes, token };
}

function lifetimeMs(value: number | undefined) {
  const lifetime = value ?? ACCOUNT_INVITATION_DEFAULT_LIFETIME_MS_V1;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime < ACCOUNT_INVITATION_MIN_LIFETIME_MS_V1 ||
    lifetime > ACCOUNT_INVITATION_MAX_LIFETIME_MS_V1
  ) {
    throw new RangeError("Invitation lifetime is outside its allowed range.");
  }
  return lifetime;
}

function canonicalUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError("Invitation ID generator returned an invalid UUID.");
  }
  return value;
}

/** Generates invitation secrets in trusted memory and persists only their digest. */
export function createAccountInvitationServiceV1(
  repository: AccountInvitationRepositoryV1,
  options: Readonly<{
    randomBytes?: (size: number) => Uint8Array;
    randomUuid?: () => string;
  }> = {},
): AccountInvitationServiceV1 {
  if (
    typeof repository?.createInvitation !== "function" ||
    typeof repository.revokeInvitation !== "function" ||
    typeof repository.ready !== "function" ||
    typeof repository.close !== "function"
  ) {
    throw new TypeError("Account invitations require a complete repository.");
  }
  const generateBytes = options.randomBytes ?? ((size: number) => crypto.getRandomValues(new Uint8Array(size)));
  const generateUuid = options.randomUuid ?? (() => crypto.randomUUID());
  let closeRequest: Promise<void> | null = null;
  return Object.freeze({
    close() {
      closeRequest ??= Promise.resolve().then(() => repository.close());
      return closeRequest;
    },
    async create(input: Parameters<AccountInvitationServiceV1["create"]>[0], signal?: AbortSignal) {
      signal?.throwIfAborted();
      const email = normalizeAccountEmailV1(input.email);
      const role = organizationInvitationRoleSchemaV1.parse(input.role);
      const lifetime = lifetimeMs(input.lifetimeMs);
      const invitationId = canonicalUuid(generateUuid());
      const generated = generatedToken(generateBytes);
      const created = await repository.createInvitation(
        {
          invitationId,
          lifetimeMs: lifetime,
          normalizedEmail: email,
          role,
          sessionTokenHash: input.sessionTokenHash,
          tokenDigest: await sha256(generated.bytes),
        },
        signal,
      );
      signal?.throwIfAborted();
      if (created === null) return null;
      if (created.invitationId !== invitationId || !Number.isFinite(created.expiresAt.getTime())) {
        throw new TypeError("Invitation repository returned an invalid result.");
      }
      return Object.freeze({
        expiresAt: created.expiresAt.toISOString(),
        invitationId,
        invitationToken: generated.token,
      });
    },
    ready(signal?: AbortSignal) {
      signal?.throwIfAborted();
      return repository.ready(signal);
    },
    revoke(input: Parameters<AccountInvitationServiceV1["revoke"]>[0], signal?: AbortSignal) {
      signal?.throwIfAborted();
      return repository.revokeInvitation(input, signal);
    },
  });
}
