import { z } from "zod";

import { readBoundedJsonResponseV1 } from "./bounded-json-response";
import { STRIPE_API_VERSION_V1 } from "./stripe-gateway";

const STRIPE_API_ORIGIN_V1 = "https://api.stripe.com";
const MAX_STRIPE_E2E_RESPONSE_BYTES_V1 = 512 * 1_024;
const STRIPE_E2E_REQUEST_TIMEOUT_MS_V1 = 10_000;

const priceSchemaV1 = z
  .object({
    active: z.literal(true),
    id: z.string().regex(/^price_[A-Za-z0-9_]{1,247}$/u),
    livemode: z.literal(false),
    object: z.literal("price"),
    recurring: z
      .object({
        interval: z.enum(["day", "week", "month", "year"]),
      })
      .passthrough(),
    type: z.literal("recurring"),
  })
  .passthrough();

export type StripeSandboxE2eConfigurationV1 = Readonly<{
  databaseUrl: string;
  priceId: string;
  secretKey: string;
  stripeCliPath: string;
  testEmail: string | null;
}>;

function requiredEnvironmentValue(environment: Readonly<NodeJS.ProcessEnv>, name: string) {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`Stripe Sandbox E2E requires ${name}.`);
  }
  if (value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Stripe Sandbox E2E ${name} is invalid.`);
  }
  return value;
}

function testSecretKey(value: string) {
  if (value.length > 512 || !/^sk_test_[A-Za-z0-9_]{8,}$/u.test(value)) {
    throw new TypeError("Stripe Sandbox E2E requires an sk_test_ secret key; live and restricted keys are forbidden.");
  }
  return value;
}

function databaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Stripe Sandbox E2E requires a valid dedicated PostgreSQL URL.");
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname.length === 0 ||
    parsed.pathname.length <= 1
  ) {
    throw new TypeError("Stripe Sandbox E2E requires a valid dedicated PostgreSQL URL.");
  }
  return value;
}

function optionalTestEmail(environment: Readonly<NodeJS.ProcessEnv>) {
  const value = environment.POIETRA_STRIPE_E2E_TEST_EMAIL;
  if (value === undefined || value.length === 0) return null;
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new TypeError("Stripe Sandbox E2E test email is invalid.");
  }
  return value;
}

/** Resolves the explicit live-evidence lane without performing I/O. */
export function resolveStripeSandboxE2eConfigurationV1(
  environment: Readonly<NodeJS.ProcessEnv>,
): StripeSandboxE2eConfigurationV1 | null {
  if (environment.POIETRA_STRIPE_E2E_REQUIRED !== "1") return null;
  const secretKey = testSecretKey(requiredEnvironmentValue(environment, "POIETRA_STRIPE_E2E_SECRET_KEY"));
  const priceId = requiredEnvironmentValue(environment, "POIETRA_STRIPE_E2E_PRICE_ID");
  if (!/^price_[A-Za-z0-9_]{1,247}$/u.test(priceId)) {
    throw new TypeError("Stripe Sandbox E2E price ID is invalid.");
  }
  const stripeCliPath = environment.POIETRA_STRIPE_E2E_STRIPE_CLI ?? "stripe";
  if (stripeCliPath.length === 0 || stripeCliPath.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(stripeCliPath)) {
    throw new TypeError("Stripe Sandbox E2E CLI path is invalid.");
  }
  return Object.freeze({
    databaseUrl: databaseUrl(requiredEnvironmentValue(environment, "POIETRA_STRIPE_E2E_DATABASE_URL")),
    priceId,
    secretKey,
    stripeCliPath,
    testEmail: optionalTestEmail(environment),
  });
}

function stripeAuthorization(secretKey: string) {
  return `Basic ${Buffer.from(`${testSecretKey(secretKey)}:`, "utf8").toString("base64")}`;
}

async function boundedJson(response: Response) {
  try {
    return await readBoundedJsonResponseV1(response, MAX_STRIPE_E2E_RESPONSE_BYTES_V1);
  } catch {
    throw new Error("Stripe Sandbox returned an invalid bounded response.");
  }
}

export async function stripeSandboxRequestV1(
  configuration: Pick<StripeSandboxE2eConfigurationV1, "secretKey">,
  path: string,
  init: Readonly<{ body?: URLSearchParams; method?: "DELETE" | "GET" | "POST" }> = {},
) {
  if (!/^\/v1\/[A-Za-z0-9_./-]+$/u.test(path) || path.includes("..")) {
    throw new TypeError("Stripe Sandbox request path is invalid.");
  }
  const headers = new Headers({
    accept: "application/json",
    authorization: stripeAuthorization(configuration.secretKey),
    "stripe-version": STRIPE_API_VERSION_V1,
  });
  if (init.body) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API_ORIGIN_V1}${path}`, {
      body: init.body,
      headers,
      method: init.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(STRIPE_E2E_REQUEST_TIMEOUT_MS_V1),
    });
  } catch {
    throw new Error("Stripe Sandbox request failed before receiving a response.");
  }
  const body = await boundedJson(response);
  if (!response.ok) throw new Error(`Stripe Sandbox rejected the request with HTTP ${response.status}.`);
  return body;
}

/** Proves that the configured Price is an active recurring test-mode object before Checkout mutates Stripe. */
export async function validateStripeSandboxPriceV1(configuration: StripeSandboxE2eConfigurationV1) {
  const response = await stripeSandboxRequestV1(
    configuration,
    `/v1/prices/${encodeURIComponent(configuration.priceId)}`,
  );
  const price = priceSchemaV1.safeParse(response);
  if (!price.success || price.data.id !== configuration.priceId) {
    throw new TypeError("Stripe Sandbox E2E requires the configured active recurring test Price.");
  }
  return Object.freeze({ id: price.data.id, livemode: price.data.livemode });
}

/** Captures one ephemeral Stripe CLI signing secret without retaining or echoing CLI output. */
export class StripeCliSigningSecretCaptureV1 {
  static readonly maximumBytes = 64 * 1_024;

  #buffer = "";
  #done = false;
  #secret: string | null = null;
  #size = 0;

  append(chunk: Uint8Array) {
    if (this.#done || this.#secret !== null || chunk.byteLength === 0) return;
    this.#size += chunk.byteLength;
    if (this.#size > StripeCliSigningSecretCaptureV1.maximumBytes) {
      this.#buffer = "";
      throw new Error("Stripe CLI exceeded the bounded startup output.");
    }
    this.#buffer += new TextDecoder().decode(chunk, { stream: true });
    const match = this.#buffer.match(/whsec_[A-Za-z0-9_]{10,}/u);
    if (!match) return;
    this.#secret = match[0];
    this.#buffer = "";
  }

  take() {
    const secret = this.#secret;
    if (secret === null) return null;
    this.#secret = null;
    this.#buffer = "";
    this.#done = true;
    return secret;
  }
}
