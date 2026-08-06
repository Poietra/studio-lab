import { describe, expect, it, vi } from "vitest";

import {
  resolveStripeSandboxE2eConfigurationV1,
  StripeCliSigningSecretCaptureV1,
  validateStripeSandboxPriceV1,
} from "./stripe-sandbox-e2e-support";

const requiredEnvironment = {
  POIETRA_STRIPE_E2E_DATABASE_URL: "postgresql://stripe_e2e:password@127.0.0.1:5432/poietra_stripe_e2e",
  POIETRA_STRIPE_E2E_PORTAL_CONFIGURATION_ID: "bpc_sandbox_portal",
  POIETRA_STRIPE_E2E_PRICE_ID: "price_sandbox_pro",
  POIETRA_STRIPE_E2E_REQUIRED: "1",
  POIETRA_STRIPE_E2E_SECRET_KEY: "sk_test_sandbox_secret",
} as const;

describe("Stripe Sandbox E2E support", () => {
  it("stays inert by default and rejects non-test keys before external I/O", async () => {
    expect(resolveStripeSandboxE2eConfigurationV1({})).toBeNull();
    for (const secretKey of ["sk_live_forbidden_secret", "rk_live_forbidden_secret", "rk_test_restricted_secret"]) {
      expect(() =>
        resolveStripeSandboxE2eConfigurationV1({
          ...requiredEnvironment,
          POIETRA_STRIPE_E2E_SECRET_KEY: secretKey,
        }),
      ).toThrow(/sk_test_/u);
    }

    const fetchRequest = vi.spyOn(globalThis, "fetch");
    try {
      expect(() =>
        resolveStripeSandboxE2eConfigurationV1({
          POIETRA_STRIPE_E2E_REQUIRED: "1",
          POIETRA_STRIPE_E2E_SECRET_KEY: "sk_test_sandbox_secret",
        }),
      ).toThrow(/POIETRA_STRIPE_E2E_PRICE_ID/u);
      expect(() =>
        resolveStripeSandboxE2eConfigurationV1({
          ...requiredEnvironment,
          POIETRA_STRIPE_E2E_PORTAL_CONFIGURATION_ID: "",
        }),
      ).toThrow(/POIETRA_STRIPE_E2E_PORTAL_CONFIGURATION_ID/u);
      expect(() =>
        resolveStripeSandboxE2eConfigurationV1({
          ...requiredEnvironment,
          POIETRA_STRIPE_E2E_PORTAL_CONFIGURATION_ID: "bpc-live-or-malformed",
        }),
      ).toThrow(/Customer Portal configuration ID/u);
      expect(fetchRequest).not.toHaveBeenCalled();
    } finally {
      fetchRequest.mockRestore();
    }
  });

  it("accepts only an exact active recurring test Price", async () => {
    const configuration = resolveStripeSandboxE2eConfigurationV1(requiredEnvironment);
    if (!configuration) throw new Error("The required Stripe Sandbox fixture did not resolve.");
    expect(configuration.portalConfigurationId).toBe(requiredEnvironment.POIETRA_STRIPE_E2E_PORTAL_CONFIGURATION_ID);
    const fetchRequest = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          active: true,
          id: configuration.priceId,
          livemode: false,
          object: "price",
          recurring: { interval: "month" },
          type: "recurring",
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );
    try {
      await expect(validateStripeSandboxPriceV1(configuration)).resolves.toEqual({
        id: configuration.priceId,
        livemode: false,
      });
      expect(fetchRequest).toHaveBeenCalledTimes(1);
      const [url, request] = fetchRequest.mock.calls[0]!;
      expect(url).toBe(`https://api.stripe.com/v1/prices/${configuration.priceId}`);
      expect(new Headers(request?.headers).get("authorization")).not.toContain("sk_test_");
      expect(new Headers(request?.headers).get("stripe-version")).toBeTruthy();
    } finally {
      fetchRequest.mockRestore();
    }
  });

  it("cancels an undeclared oversized Stripe response before parsing", async () => {
    const configuration = resolveStripeSandboxE2eConfigurationV1(requiredEnvironment);
    if (!configuration) throw new Error("The required Stripe Sandbox fixture did not resolve.");
    let canceled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1_024));
        controller.enqueue(Uint8Array.of(0));
      },
    });
    const fetchRequest = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(responseBody, { status: 200 }));
    try {
      await expect(validateStripeSandboxPriceV1(configuration)).rejects.toThrow(/bounded/u);
      expect(canceled).toBe(true);
    } finally {
      fetchRequest.mockRestore();
    }
  });

  it("extracts a split ephemeral CLI secret and bounds untrusted output", () => {
    const capture = new StripeCliSigningSecretCaptureV1();
    capture.append(Buffer.from("Ready! signing secret is whsec_split_"));
    capture.append(Buffer.from("sandbox_value\n"));
    expect(capture.take()).toBe("whsec_split_sandbox_value");
    expect(capture.take()).toBeNull();

    const splitAfterMinimum = new StripeCliSigningSecretCaptureV1();
    splitAfterMinimum.append(Buffer.from("Ready! signing secret is whsec_abcdefghij"));
    expect(splitAfterMinimum.take()).toBeNull();
    splitAfterMinimum.append(Buffer.from("klmnop\n"));
    expect(splitAfterMinimum.take()).toBe("whsec_abcdefghijklmnop");

    const overflow = new StripeCliSigningSecretCaptureV1();
    expect(() => overflow.append(Buffer.alloc(StripeCliSigningSecretCaptureV1.maximumBytes + 1))).toThrow(/bounded/u);
  });
});
