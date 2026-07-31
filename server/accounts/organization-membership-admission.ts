import { z } from "zod";

import { HttpError } from "../http/json";
import type { ProductionAdmissionRequest, ProductionRequestAdmission } from "../manim-production-server";
import { accountUserIdSchemaV1, organizationIdSchemaV1, organizationRoleAllowsV1 } from "./account-domain";
import type {
  ExternalAccountIdentityV1,
  OrganizationMembershipRepositoryV1,
} from "./organization-membership-repository";

const externalAccountIdentitySchemaV1 = z
  .object({
    issuer: z
      .string()
      .min(1)
      .max(2_048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            value.trim() === value
          );
        } catch {
          return false;
        }
      }),
    subject: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\u0000-\u001f\u007f]+$/u)
      .refine((value) => value.trim() === value),
    /** Verified active organization carried by the server-owned browser session. */
    sessionOrganizationId: organizationIdSchemaV1.optional(),
  })
  .strict();

const resolvedMembershipSchemaV1 = z
  .object({
    organizationId: organizationIdSchemaV1,
    role: z.enum(["owner", "admin", "member", "billing"]),
    userId: accountUserIdSchemaV1,
    version: z.bigint().positive(),
  })
  .strict();

export type ExternalAccountIdentityAuthenticatorV1 = Readonly<{
  /** Returns null/malformed output or HttpError(401) for invalid credentials; HttpError(503) means provider outage. */
  authenticate(input: ProductionAdmissionRequest, signal: AbortSignal): Promise<unknown>;
  ready(signal: AbortSignal): Promise<boolean>;
}>;

function authenticationRequired(): never {
  throw new HttpError("Authentication is required.", 401);
}

function organizationAccessDenied(): never {
  throw new HttpError("Organization access is not available.", 403);
}

function organizationDirectoryUnavailable(): never {
  throw new HttpError("Organization access is temporarily unavailable.", 503);
}

async function resolveMembership(
  repository: OrganizationMembershipRepositoryV1,
  identity: ExternalAccountIdentityV1,
  organizationId: string,
  signal: AbortSignal,
) {
  try {
    return await repository.resolveActiveMembership(identity, organizationId, signal);
  } catch {
    signal.throwIfAborted();
    return organizationDirectoryUnavailable();
  }
}

async function authenticateExternalIdentity(
  authenticator: ExternalAccountIdentityAuthenticatorV1,
  input: ProductionAdmissionRequest,
  signal: AbortSignal,
) {
  try {
    return await authenticator.authenticate(input, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof HttpError && (error.status === 401 || error.status === 503)) throw error;
    return organizationDirectoryUnavailable();
  }
}

/**
 * Connects a verified external identity to the existing tenant-scoped API.
 * Organization selection is an untrusted selector: only the PostgreSQL
 * membership result supplies the internal user and tenant identities.
 */
export function createOrganizationMembershipProductionAdmissionV1(
  options: Readonly<{
    identities: ExternalAccountIdentityAuthenticatorV1;
    memberships: OrganizationMembershipRepositoryV1;
  }>,
): ProductionRequestAdmission {
  if (
    typeof options.identities?.authenticate !== "function" ||
    typeof options.identities.ready !== "function" ||
    typeof options.memberships?.resolveActiveMembership !== "function" ||
    typeof options.memberships.ready !== "function"
  ) {
    throw new TypeError("Organization membership admission requires complete identity and membership adapters.");
  }
  let closeRequest: Promise<void> | null = null;

  return Object.freeze({
    async authenticate(input: ProductionAdmissionRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      const identity = externalAccountIdentitySchemaV1.safeParse(
        await authenticateExternalIdentity(options.identities, input, signal),
      );
      signal.throwIfAborted();
      if (!identity.success) return authenticationRequired();

      const selectedOrganization = organizationIdSchemaV1.safeParse(
        input.requestedOrganizationId ?? identity.data.sessionOrganizationId,
      );
      if (!selectedOrganization.success) return organizationAccessDenied();
      const externalIdentity: ExternalAccountIdentityV1 = {
        issuer: identity.data.issuer,
        subject: identity.data.subject,
      };
      const candidate = await resolveMembership(
        options.memberships,
        externalIdentity,
        selectedOrganization.data,
        signal,
      );
      signal.throwIfAborted();
      if (candidate === null) return organizationAccessDenied();
      const membership = resolvedMembershipSchemaV1.safeParse(candidate);
      if (!membership.success || membership.data.organizationId !== selectedOrganization.data) {
        return organizationDirectoryUnavailable();
      }
      const permission = input.method === "GET" || input.method === "HEAD" ? "manim:read" : "manim:write";
      if (!organizationRoleAllowsV1(membership.data.role, permission)) return organizationAccessDenied();
      return {
        subjectId: membership.data.userId,
        tenantId: membership.data.organizationId,
      };
    },
    close() {
      closeRequest ??= Promise.resolve().then(() => options.memberships.close());
      return closeRequest;
    },
    async ready(signal: AbortSignal) {
      signal.throwIfAborted();
      const [identitiesReady, membershipsReady] = await Promise.all([
        options.identities.ready(signal),
        options.memberships.ready(signal),
      ]);
      signal.throwIfAborted();
      return identitiesReady === true && membershipsReady === true;
    },
  });
}
