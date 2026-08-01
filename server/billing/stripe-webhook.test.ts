import { describe, expect, it } from "vitest";

import { STRIPE_API_VERSION_V1 } from "./stripe-gateway";
import {
  STRIPE_WEBHOOK_TOLERANCE_SECONDS_V1,
  StripeWebhookVerificationErrorV1,
  verifyAndParseStripeWebhookV1,
} from "./stripe-webhook";

const secret = "whsec_1234567890abcdef";
const now = new Date("2026-08-01T00:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);
const attemptId = "00000000-0000-4000-8000-000000000325";

function eventPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    api_version: STRIPE_API_VERSION_V1,
    created: timestamp,
    data: {
      object: {
        customer: "cus_1234567890",
        id: "sub_1234567890",
        object: "subscription",
        metadata: { poietra_checkout_attempt_id: attemptId },
        price: "price_untrusted_payload",
        status: "active",
      },
    },
    id: "evt_1234567890",
    livemode: false,
    object: "event",
    type: "customer.subscription.updated",
    ...overrides,
  });
}

async function signature(payload: Uint8Array, signedAt = timestamp, signingSecret = secret) {
  const prefix = new TextEncoder().encode(`${signedAt}.`);
  const content = new Uint8Array(prefix.byteLength + payload.byteLength);
  content.set(prefix);
  content.set(payload, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, content));
  return `${signedAt},${Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function signedHeader(payload: Uint8Array, signedAt = timestamp, signingSecret = secret) {
  const [encodedTimestamp, encodedSignature] = (await signature(payload, signedAt, signingSecret)).split(",");
  return `t=${encodedTimestamp},v1=${encodedSignature}`;
}

describe("Stripe raw-body webhook verification", () => {
  it("exposes only inbox metadata and canonical-fetch locators after signature verification", async () => {
    const payload = new TextEncoder().encode(eventPayload());
    const envelope = await verifyAndParseStripeWebhookV1(payload, await signedHeader(payload), secret, { now });

    expect(envelope).toMatchObject({
      apiVersion: STRIPE_API_VERSION_V1,
      checkoutAttemptId: attemptId,
      checkoutSessionId: null,
      createdAt: now,
      customerId: "cus_1234567890",
      eventId: "evt_1234567890",
      eventType: "customer.subscription.updated",
      livemode: false,
      sourceObjectId: "sub_1234567890",
      subscriptionId: "sub_1234567890",
    });
    expect(envelope.payloadBytes).toEqual(payload);
    expect(Object.keys(envelope).sort()).toEqual([
      "apiVersion",
      "checkoutAttemptId",
      "checkoutSessionId",
      "createdAt",
      "customerId",
      "eventId",
      "eventType",
      "livemode",
      "payloadBytes",
      "sourceObjectId",
      "subscriptionId",
    ]);
    expect(envelope).not.toHaveProperty("status");
    expect(envelope).not.toHaveProperty("priceId");
  });

  it("extracts Checkout customer and subscription only as wake-up locators", async () => {
    const payload = new TextEncoder().encode(
      eventPayload({
        data: {
          object: {
            client_reference_id: attemptId,
            customer: "cus_checkout_123",
            id: "cs_test_checkout_123",
            object: "checkout.session",
            payment_status: "paid",
            subscription: "sub_checkout_123",
          },
        },
        type: "checkout.session.completed",
      }),
    );

    await expect(
      verifyAndParseStripeWebhookV1(payload, await signedHeader(payload), secret, { now }),
    ).resolves.toMatchObject({
      checkoutAttemptId: attemptId,
      checkoutSessionId: "cs_test_checkout_123",
      customerId: "cus_checkout_123",
      sourceObjectId: "cs_test_checkout_123",
      subscriptionId: "sub_checkout_123",
    });
  });

  it("accepts secret rotation headers when one v1 signature matches", async () => {
    const payload = new TextEncoder().encode(eventPayload());
    const header = `${await signedHeader(payload)},v1=${"0".repeat(64)}`;

    await expect(verifyAndParseStripeWebhookV1(payload, header, secret, { now })).resolves.toMatchObject({
      eventId: "evt_1234567890",
    });
  });

  it("rejects body mutation, stale deliveries, and a mismatched API version", async () => {
    const original = new TextEncoder().encode(eventPayload());
    const mutated = new TextEncoder().encode(eventPayload({ id: "evt_mutated_123" }));
    const staleTimestamp = timestamp - STRIPE_WEBHOOK_TOLERANCE_SECONDS_V1 - 1;
    const wrongVersion = new TextEncoder().encode(eventPayload({ api_version: "2025-08-27.basil" }));

    await expect(
      verifyAndParseStripeWebhookV1(mutated, await signedHeader(original), secret, { now }),
    ).rejects.toBeInstanceOf(StripeWebhookVerificationErrorV1);
    await expect(
      verifyAndParseStripeWebhookV1(original, await signedHeader(original, staleTimestamp), secret, { now }),
    ).rejects.toThrow(/tolerance/i);
    await expect(
      verifyAndParseStripeWebhookV1(wrongVersion, await signedHeader(wrongVersion), secret, { now }),
    ).rejects.toThrow(/version/i);
  });

  it("does not include raw payload or signing secret in verification errors", async () => {
    const privateMarker = "PRIVATE_CUSTOMER_MARKER";
    const payload = new TextEncoder().encode(eventPayload({ privateMarker }));
    const error = await verifyAndParseStripeWebhookV1(payload, `t=${timestamp},v1=${"0".repeat(64)}`, secret, {
      now,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StripeWebhookVerificationErrorV1);
    expect(String(error)).not.toContain(privateMarker);
    expect(String(error)).not.toContain(secret);
  });
});
