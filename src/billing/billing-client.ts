import { z } from "zod";

import {
  billingCheckoutRequestSchemaV1,
  billingCheckoutViewSchemaV1,
  billingPortalRequestSchemaV1,
  billingPortalViewSchemaV1,
  billingStatusViewSchemaV1,
} from "./billing-contract";
import { fetchOrganizationScopedBillingApiV1 } from "./organization-scoped-billing-fetch";

const MAX_BILLING_RESPONSE_BYTES_V1 = 32 * 1_024;
const errorViewSchemaV1 = z.object({ error: z.string().max(512) }).strict();

export class BillingRequestErrorV1 extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BillingRequestErrorV1";
  }
}

async function readBoundedJsonV1(response: Response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_BILLING_RESPONSE_BYTES_V1) {
      throw new Error("The billing service returned an oversized response.");
    }
  }
  if (!response.body) throw new Error("The billing service returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BILLING_RESPONSE_BYTES_V1) {
        await reader.cancel().catch(() => undefined);
        throw new Error("The billing service returned an oversized response.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The billing service returned malformed JSON.");
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new Error("The billing service returned malformed JSON.");
  }
}

function publicErrorMessageV1(status: number) {
  if (status === 401) return "Sign in is required.";
  if (status === 403) return "Billing access is not available for this account.";
  if (status === 409) return "Billing state changed. Refresh and try again.";
  if (status === 429) return "Billing is busy. Try again in a moment.";
  return "Billing is temporarily unavailable.";
}

async function readBillingResponseV1<Schema extends z.ZodType>(response: Response, schema: Schema) {
  const body = await readBoundedJsonV1(response);
  if (!response.ok) {
    const error = errorViewSchemaV1.safeParse(body);
    throw new BillingRequestErrorV1(
      error.success ? error.data.error : publicErrorMessageV1(response.status),
      response.status,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error("The billing service returned an invalid response.");
  return parsed.data as z.infer<Schema>;
}

export async function loadBillingStatusV1(organizationId: string, signal?: AbortSignal) {
  return readBillingResponseV1(
    await fetchOrganizationScopedBillingApiV1(organizationId, "/api/billing/status", {
      headers: { accept: "application/json" },
      signal,
    }),
    billingStatusViewSchemaV1,
  );
}

export async function startProCheckoutV1(organizationId: string, signal?: AbortSignal) {
  const body = billingCheckoutRequestSchemaV1.parse({ planKey: "pro" });
  return readBillingResponseV1(
    await fetchOrganizationScopedBillingApiV1(organizationId, "/api/billing/checkout", {
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      signal,
    }),
    billingCheckoutViewSchemaV1,
  );
}

export async function startBillingPortalV1(organizationId: string, signal?: AbortSignal) {
  const body = billingPortalRequestSchemaV1.parse({});
  return readBillingResponseV1(
    await fetchOrganizationScopedBillingApiV1(organizationId, "/api/billing/portal", {
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      signal,
    }),
    billingPortalViewSchemaV1,
  );
}
