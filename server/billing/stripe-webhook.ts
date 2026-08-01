import { z } from "zod";

import { STRIPE_API_VERSION_V1 } from "./stripe-gateway";

export const MAX_STRIPE_WEBHOOK_BYTES_V1 = 1_024 * 1_024;
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS_V1 = 5 * 60;

const stripeEventIdSchemaV1 = z.string().regex(/^evt_[A-Za-z0-9_]{1,247}$/u);
const stripeCheckoutSessionIdSchemaV1 = z.string().regex(/^cs_[A-Za-z0-9_]{1,247}$/u);
const stripeCustomerIdSchemaV1 = z.string().regex(/^cus_[A-Za-z0-9_]{1,247}$/u);
const stripeSubscriptionIdSchemaV1 = z.string().regex(/^sub_[A-Za-z0-9_]{1,247}$/u);
const checkoutAttemptIdSchemaV1 = z.uuid();
const eventTypeSchemaV1 = z
  .string()
  .regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/u)
  .max(255);
const eventPayloadSchemaV1 = z
  .object({
    api_version: z.string(),
    created: z.number().int().positive().max(253_402_300_799),
    data: z.object({ object: z.record(z.string(), z.unknown()) }).passthrough(),
    id: stripeEventIdSchemaV1,
    livemode: z.boolean(),
    object: z.literal("event"),
    type: eventTypeSchemaV1,
  })
  .passthrough();

export type StripeWebhookEventEnvelopeV1 = Readonly<{
  apiVersion: typeof STRIPE_API_VERSION_V1;
  checkoutAttemptId: string | null;
  checkoutSessionId: string | null;
  createdAt: Date;
  customerId: string | null;
  eventId: string;
  eventType: string;
  livemode: boolean;
  /** Exact verified request bytes. The durable inbox owns deduplication and hashing. */
  payloadBytes: Uint8Array;
  sourceObjectId: string | null;
  /** Locator only: entitlement fields must come from a canonical Stripe API fetch. */
  subscriptionId: string | null;
}>;

export type VerifyStripeWebhookOptionsV1 = Readonly<{
  crypto?: Pick<Crypto, "subtle">;
  now?: Date;
  toleranceSeconds?: number;
}>;

export class StripeWebhookVerificationErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeWebhookVerificationErrorV1";
  }
}

function fail(message: string): never {
  throw new StripeWebhookVerificationErrorV1(message);
}

function rawPayloadBytes(value: unknown) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_STRIPE_WEBHOOK_BYTES_V1) {
    fail("Stripe webhook payload is invalid.");
  }
  return Uint8Array.from(value);
}

function signingSecret(value: unknown) {
  if (typeof value !== "string" || value.length < 16 || value.length > 512 || !/^whsec_[A-Za-z0-9_]+$/u.test(value)) {
    fail("Stripe webhook signing is unavailable.");
  }
  return value;
}

function signatureHeader(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || /\s/u.test(value)) {
    fail("Stripe webhook signature is invalid.");
  }
  let timestamp: number | null = null;
  const signatures: Uint8Array[] = [];
  for (const item of value.split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0 || separator === item.length - 1 || item.indexOf("=", separator + 1) !== -1) {
      fail("Stripe webhook signature is invalid.");
    }
    const scheme = item.slice(0, separator);
    const encoded = item.slice(separator + 1);
    if (scheme === "t") {
      if (timestamp !== null || !/^[1-9][0-9]{0,15}$/u.test(encoded)) {
        fail("Stripe webhook signature is invalid.");
      }
      timestamp = Number(encoded);
      if (!Number.isSafeInteger(timestamp)) fail("Stripe webhook signature is invalid.");
    } else if (scheme === "v1") {
      if (!/^[0-9a-f]{64}$/u.test(encoded)) fail("Stripe webhook signature is invalid.");
      signatures.push(Uint8Array.from(encoded.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16)));
    }
  }
  if (timestamp === null || signatures.length < 1 || signatures.length > 8) {
    fail("Stripe webhook signature is invalid.");
  }
  return { signatures, timestamp };
}

function verifiedClock(value: Date | undefined) {
  const now = value ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("Stripe webhook verification clock is invalid.");
  return Math.floor(now.getTime() / 1_000);
}

function toleranceSeconds(value: number | undefined) {
  const tolerance = value ?? STRIPE_WEBHOOK_TOLERANCE_SECONDS_V1;
  if (!Number.isSafeInteger(tolerance) || tolerance < 1 || tolerance > 15 * 60) {
    fail("Stripe webhook timestamp tolerance is invalid.");
  }
  return tolerance;
}

function signedPayload(timestamp: number, payload: Uint8Array) {
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const bytes = new Uint8Array(prefix.byteLength + payload.byteLength);
  bytes.set(prefix, 0);
  bytes.set(payload, prefix.byteLength);
  return bytes;
}

async function hasMatchingSignature(
  cryptoProvider: Pick<Crypto, "subtle">,
  secret: string,
  content: Uint8Array,
  signatures: readonly Uint8Array[],
) {
  let key: CryptoKey;
  try {
    key = await cryptoProvider.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["verify"],
    );
    for (const signature of signatures) {
      if (
        await cryptoProvider.subtle.verify(
          "HMAC",
          key,
          Uint8Array.from(signature).buffer,
          Uint8Array.from(content).buffer,
        )
      ) {
        return true;
      }
    }
  } catch {
    fail("Stripe webhook signature could not be verified.");
  }
  return false;
}

function optionalStringId(value: unknown, schema: z.ZodType<string>) {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function metadataCheckoutAttemptId(dataObject: Record<string, unknown>) {
  const metadata = dataObject.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  return optionalStringId((metadata as Record<string, unknown>).poietra_checkout_attempt_id, checkoutAttemptIdSchemaV1);
}

function eventLocators(dataObject: Record<string, unknown>) {
  const objectType = dataObject.object;
  if (objectType === "subscription") {
    const subscriptionId = optionalStringId(dataObject.id, stripeSubscriptionIdSchemaV1);
    return {
      checkoutAttemptId: metadataCheckoutAttemptId(dataObject),
      checkoutSessionId: null,
      customerId: optionalStringId(dataObject.customer, stripeCustomerIdSchemaV1),
      sourceObjectId: subscriptionId,
      subscriptionId,
    };
  }
  if (objectType === "checkout.session") {
    const checkoutSessionId = optionalStringId(dataObject.id, stripeCheckoutSessionIdSchemaV1);
    return {
      checkoutAttemptId: optionalStringId(dataObject.client_reference_id, checkoutAttemptIdSchemaV1),
      checkoutSessionId,
      customerId: optionalStringId(dataObject.customer, stripeCustomerIdSchemaV1),
      sourceObjectId: checkoutSessionId,
      subscriptionId: optionalStringId(dataObject.subscription, stripeSubscriptionIdSchemaV1),
    };
  }
  return {
    checkoutAttemptId: null,
    checkoutSessionId: null,
    customerId: null,
    sourceObjectId: null,
    subscriptionId: null,
  };
}

/** Verifies the exact raw body first, then exposes only durable-inbox metadata and canonical-fetch locators. */
export async function verifyAndParseStripeWebhookV1(
  payloadValue: unknown,
  stripeSignatureValue: unknown,
  signingSecretValue: unknown,
  options: VerifyStripeWebhookOptionsV1 = {},
): Promise<StripeWebhookEventEnvelopeV1> {
  const payloadBytes = rawPayloadBytes(payloadValue);
  const secret = signingSecret(signingSecretValue);
  const { signatures, timestamp } = signatureHeader(stripeSignatureValue);
  const currentTimestamp = verifiedClock(options.now);
  const tolerance = toleranceSeconds(options.toleranceSeconds);
  const cryptoProvider = options.crypto ?? globalThis.crypto;
  if (!cryptoProvider?.subtle) fail("Stripe webhook signature verification is unavailable.");
  if (!(await hasMatchingSignature(cryptoProvider, secret, signedPayload(timestamp, payloadBytes), signatures))) {
    fail("Stripe webhook signature is invalid.");
  }
  if (Math.abs(currentTimestamp - timestamp) > tolerance) fail("Stripe webhook timestamp is outside tolerance.");

  let decoded: string;
  let payload: z.infer<typeof eventPayloadSchemaV1>;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    payload = eventPayloadSchemaV1.parse(JSON.parse(decoded) as unknown);
  } catch {
    fail("Stripe webhook payload is invalid.");
  }
  if (payload.api_version !== STRIPE_API_VERSION_V1) {
    fail("Stripe webhook API version is unsupported.");
  }
  const locators = eventLocators(payload.data.object);
  return Object.freeze({
    apiVersion: STRIPE_API_VERSION_V1,
    checkoutAttemptId: locators.checkoutAttemptId,
    checkoutSessionId: locators.checkoutSessionId,
    createdAt: new Date(payload.created * 1_000),
    customerId: locators.customerId,
    eventId: payload.id,
    eventType: payload.type,
    livemode: payload.livemode,
    payloadBytes,
    sourceObjectId: locators.sourceObjectId,
    subscriptionId: locators.subscriptionId,
  });
}
