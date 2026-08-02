import { z } from "zod";

export const accountInvitationRoleSchemaV1 = z.enum(["admin", "member", "billing"]);

export const accountInvitationCreateRequestSchemaV1 = z
  .object({
    email: z
      .string()
      .min(3)
      .max(254)
      .regex(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/u),
    role: accountInvitationRoleSchemaV1,
  })
  .strict();

const accountInvitationIdSchemaV1 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

// A 32-byte base64url value has 43 characters and only four significant bits
// in its final character. Restricting that character rejects alternate,
// non-canonical encodings without decoding the secret in the browser.
export const accountInvitationTokenSchemaV1 = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);

export const accountInvitationCreateResponseSchemaV1 = z
  .object({
    expiresAt: z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    invitationId: accountInvitationIdSchemaV1,
    invitationToken: accountInvitationTokenSchemaV1,
  })
  .strict();

export type AccountInvitationCreateRequestV1 = z.infer<typeof accountInvitationCreateRequestSchemaV1>;
export type AccountInvitationCreateResponseV1 = z.infer<typeof accountInvitationCreateResponseSchemaV1>;
export type AccountInvitationRoleV1 = z.infer<typeof accountInvitationRoleSchemaV1>;
