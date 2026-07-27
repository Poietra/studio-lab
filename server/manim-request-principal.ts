import { createHash } from "node:crypto";

import { z } from "zod";

import { HttpError } from "./http/json";

const principalBrand = Symbol("poietra.verified-manim-principal");

export const manimTenantIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);

const manimPrincipalClaimsSchema = z
  .object({
    subjectId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/),
    tenantId: manimTenantIdSchema,
  })
  .strict();

export type ManimPrincipalClaims = z.infer<typeof manimPrincipalClaimsSchema>;

export type VerifiedManimPrincipal = Readonly<
  ManimPrincipalClaims & {
    [principalBrand]: true;
  }
>;

export type ManimPrincipalAuthenticator<Input> = Readonly<{
  authenticate: (input: Input, signal: AbortSignal) => Promise<unknown>;
}>;

function verifiedPrincipal(claims: ManimPrincipalClaims): VerifiedManimPrincipal {
  return Object.freeze({ ...claims, [principalBrand]: true as const });
}

export function isReservedLocalManimTenantId(tenantId: unknown): tenantId is string {
  return tenantId === "studio-local" || (typeof tenantId === "string" && tenantId.startsWith("local-"));
}

export function isVerifiedManimPrincipal(value: unknown): value is VerifiedManimPrincipal {
  if (typeof value !== "object" || value === null || (value as Record<PropertyKey, unknown>)[principalBrand] !== true) {
    return false;
  }
  return manimPrincipalClaimsSchema.safeParse(value).success;
}

/**
 * The authenticator is the trust boundary: request payloads and headers must
 * never be passed directly as its result. Only validated authenticator output
 * becomes a principal accepted by the tenant registry.
 */
export async function authenticateManimPrincipal<Input>(
  authenticator: ManimPrincipalAuthenticator<Input>,
  input: Input,
  signal: AbortSignal,
): Promise<VerifiedManimPrincipal> {
  signal.throwIfAborted();
  const parsed = manimPrincipalClaimsSchema.safeParse(await authenticator.authenticate(input, signal));
  signal.throwIfAborted();
  if (!parsed.success || isReservedLocalManimTenantId(parsed.data.tenantId)) {
    throw new HttpError("Authentication is required.", 401);
  }
  return verifiedPrincipal(parsed.data);
}

export function localManimTenantId(canonicalDataRoot: string) {
  if (!canonicalDataRoot) throw new TypeError("The local data root must not be empty.");
  return `local-${createHash("sha256").update(canonicalDataRoot, "utf8").digest("hex").slice(0, 24)}`;
}

/**
 * Creates the explicit identity used by trusted local-only transports. The
 * runtime check prevents this convenience path from being enabled by a
 * production configuration, even when called from untyped JavaScript.
 */
export function createTrustedLocalManimPrincipal(
  options: Readonly<{
    deployment: "desktop" | "development" | "test";
    tenantId: string;
  }>,
): VerifiedManimPrincipal {
  if (!(["desktop", "development", "test"] as readonly unknown[]).includes(options.deployment)) {
    throw new TypeError("A trusted local principal cannot be configured for production.");
  }
  const parsed = manimPrincipalClaimsSchema.safeParse({
    subjectId: `${options.deployment}-local-user`,
    tenantId: options.tenantId,
  });
  if (!parsed.success) throw new TypeError("The trusted local principal configuration is invalid.");
  return verifiedPrincipal(parsed.data);
}
