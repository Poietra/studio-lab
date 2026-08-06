import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Browser, chromium, type Frame, type Page } from "@playwright/test";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { authenticateManimPrincipal } from "../manim-request-principal";
import { applyBundledDurableStorageMigrations } from "../storage/postgres/migrate";
import { PostgresBillingEntitlementRepositoryV1 } from "../storage/postgres/postgres-entitlement-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "../storage/postgres/postgres-repository-connection";
import { PostgresStripeBillingRepositoryV1 } from "../storage/postgres/postgres-stripe-billing-repository";
import { createStripeCheckoutPlanCatalogV1 } from "./plan-catalog";
import { createStripeBillingServiceV1, type StripeBillingServiceV1 } from "./stripe-billing-service";
import { createStripeHttpBillingGatewayV1 } from "./stripe-http-gateway";
import {
  resolveStripeSandboxE2eConfigurationV1,
  StripeCliSigningSecretCaptureV1,
  type StripeSandboxE2eConfigurationV1,
  stripeSandboxRequestV1,
  validateStripeSandboxPriceV1,
} from "./stripe-sandbox-e2e-support";
import { MAX_STRIPE_WEBHOOK_BYTES_V1 } from "./stripe-webhook";

const configuration = resolveStripeSandboxE2eConfigurationV1(process.env);
const WEBHOOK_STARTUP_TIMEOUT_MS = 20_000;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;
const WEBHOOK_WAIT_TIMEOUT_MS = 60_000;

type CapturedWebhook = Readonly<{
  eventId: string;
  eventType: "checkout.session.completed" | "customer.subscription.deleted";
  livemode: false;
  rawBody: Uint8Array;
  stripeSignature: string;
}>;

function configuredLane(value: StripeSandboxE2eConfigurationV1 | null): StripeSandboxE2eConfigurationV1 {
  if (!value) throw new Error("Stripe Sandbox E2E was not explicitly enabled.");
  return value;
}

function boundedChildEnvironment(secretKey: string, privateHome: string) {
  const environment: NodeJS.ProcessEnv = {
    DO_NOT_TRACK: "1",
    HOME: privateHome,
    STRIPE_API_KEY: secretKey,
    STRIPE_CLI_TELEMETRY_OPTOUT: "1",
    XDG_CACHE_HOME: join(privateHome, "cache"),
    XDG_CONFIG_HOME: join(privateHome, "config"),
    XDG_DATA_HOME: join(privateHome, "data"),
  };
  for (const name of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function boundedBrowserEnvironment(privateHome: string) {
  const environment: NodeJS.ProcessEnv = {
    DO_NOT_TRACK: "1",
    HOME: privateHome,
    XDG_CACHE_HOME: join(privateHome, "cache"),
    XDG_CONFIG_HOME: join(privateHome, "config"),
    XDG_DATA_HOME: join(privateHome, "data"),
  };
  for (const name of [
    "DISPLAY",
    "FONTCONFIG_FILE",
    "FONTCONFIG_PATH",
    "LANG",
    "LC_ALL",
    "LD_LIBRARY_PATH",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TZ",
    "XDG_RUNTIME_DIR",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function stopChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function startStripeWebhookForwarder(options: {
  configuration: StripeSandboxE2eConfigurationV1;
  forwardUrl: string;
}) {
  const privateHome = await mkdtemp(join(tmpdir(), "poietra-stripe-cli-"));
  const child = spawn(
    options.configuration.stripeCliPath,
    [
      "listen",
      "--events",
      "checkout.session.completed,customer.subscription.deleted",
      "--forward-to",
      options.forwardUrl,
      "--skip-update",
    ],
    {
      env: boundedChildEnvironment(options.configuration.secretKey, privateHome),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const capture = new StripeCliSigningSecretCaptureV1();
  let settled = false;
  let startupTimer: NodeJS.Timeout | undefined;
  const signingSecret = await new Promise<string>((resolve, reject) => {
    const fail = (message = "Stripe CLI did not start the bounded webhook forwarder.") => {
      if (settled) return;
      settled = true;
      if (startupTimer) clearTimeout(startupTimer);
      reject(new Error(message));
    };
    const accept = (chunk: Buffer) => {
      if (settled) return;
      try {
        capture.append(chunk);
        const secret = capture.take();
        if (secret === null) return;
        settled = true;
        if (startupTimer) clearTimeout(startupTimer);
        resolve(secret);
      } catch {
        fail();
      }
    };
    child.stdout?.on("data", accept);
    child.stderr?.on("data", accept);
    child.once("error", () =>
      fail(
        "Stripe CLI is unavailable; install a current Stripe CLI or set POIETRA_STRIPE_E2E_STRIPE_CLI before the required lane.",
      ),
    );
    child.once("close", () =>
      fail(
        "Stripe CLI exited before forwarding; install a current Stripe CLI or set POIETRA_STRIPE_E2E_STRIPE_CLI before the required lane.",
      ),
    );
    startupTimer = setTimeout(fail, WEBHOOK_STARTUP_TIMEOUT_MS);
  }).catch(async (error: unknown) => {
    try {
      await stopChild(child);
    } finally {
      await rm(privateHome, { force: true, recursive: true });
    }
    throw error;
  });
  return Object.freeze({
    close: async () => {
      try {
        await stopChild(child);
      } finally {
        await rm(privateHome, { force: true, recursive: true });
      }
    },
    signingSecret,
  });
}

async function collectRawRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    byteSize += bytes.byteLength;
    if (byteSize > MAX_STRIPE_WEBHOOK_BYTES_V1) {
      request.destroy();
      throw new Error("Stripe webhook exceeded the bounded body size.");
    }
    chunks.push(bytes);
  }
  if (byteSize === 0) throw new Error("Stripe webhook body was empty.");
  return Uint8Array.from(Buffer.concat(chunks, byteSize));
}

async function rawRequestBody(request: IncomingMessage) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      collectRawRequestBody(request),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          request.destroy();
          reject(new Error("Stripe webhook body exceeded its bounded deadline."));
        }, WEBHOOK_BODY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function capturedWebhook(rawBody: Uint8Array, stripeSignature: string): CapturedWebhook | null {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const event = payload as Record<string, unknown>;
  if (
    event.livemode !== false ||
    typeof event.id !== "string" ||
    !/^evt_[A-Za-z0-9_]{1,247}$/u.test(event.id) ||
    (event.type !== "checkout.session.completed" && event.type !== "customer.subscription.deleted")
  ) {
    return null;
  }
  return Object.freeze({
    eventId: event.id,
    eventType: event.type,
    livemode: false,
    rawBody: Uint8Array.from(rawBody),
    stripeSignature,
  });
}

async function startWebhookReceiver(acceptWebhook: (rawBody: Uint8Array, stripeSignature: string) => Promise<void>) {
  const captured: CapturedWebhook[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/stripe-webhook") {
      response.writeHead(404).end();
      return;
    }
    const stripeSignature = request.headers["stripe-signature"];
    if (typeof stripeSignature !== "string" || stripeSignature.length > 4_096) {
      response.writeHead(400).end();
      return;
    }
    let rawBody: Uint8Array | undefined;
    try {
      rawBody = await rawRequestBody(request);
      let accepted = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await acceptWebhook(rawBody, stripeSignature);
          accepted = true;
          break;
        } catch {
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!accepted) throw new Error("Stripe webhook reconciliation failed after bounded retries.");
      const evidence = capturedWebhook(rawBody, stripeSignature);
      if (evidence && captured.length < 4 && !captured.some(({ eventId }) => eventId === evidence.eventId)) {
        captured.push(evidence);
      }
      response.writeHead(204).end();
    } catch {
      response.writeHead(503).end();
    } finally {
      rawBody?.fill(0);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Stripe webhook receiver did not bind TCP.");
  return Object.freeze({
    captured,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const event of captured) event.rawBody.fill(0);
      captured.length = 0;
    },
    url: `http://127.0.0.1:${address.port}/stripe-webhook`,
  });
}

async function eventually<T>(operation: () => Promise<T | null>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== null) return value;
    } catch {
      // Webhook delivery and canonical propagation are eventually consistent.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not complete within its bounded deadline.`);
}

async function seedOrganization(pool: Pool, tenantId: string, ownerId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1)", [tenantId]);
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, 'https://stripe-e2e.poietra.invalid/', $2, 'Stripe Sandbox E2E owner')`,
      [ownerId, `stripe-e2e-${ownerId}`],
    );
    await client.query("INSERT INTO public.organizations (tenant_id, display_name) VALUES ($1, $2)", [
      tenantId,
      "Stripe Sandbox E2E organization",
    ]);
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $2::uuid, 'owner')`,
      [tenantId, ownerId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type BrowserContext = Page | Frame;

async function fillHostedField(page: Page, selectors: readonly string[], value: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const contexts: BrowserContext[] = [page, ...page.frames()];
    for (const context of contexts) {
      for (const selector of selectors) {
        const locator = context.locator(selector).first();
        try {
          if ((await locator.count()) > 0 && (await locator.isVisible())) {
            await locator.fill(value, { timeout: 3_000 });
            return;
          }
        } catch {
          // Stripe can replace Payment Element frames while Checkout loads.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Stripe Hosted Checkout did not expose a required payment field.");
}

async function fillHostedFieldIfVisible(page: Page, selectors: readonly string[], value: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const context of [page, ...page.frames()] as BrowserContext[]) {
      for (const selector of selectors) {
        const locator = context.locator(selector).first();
        try {
          if ((await locator.count()) > 0 && (await locator.isVisible())) {
            await locator.fill(value, { timeout: 3_000 });
            return true;
          }
        } catch {
          // Stripe can replace Payment Element frames while Checkout loads.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function selectHostedOptionIfVisible(page: Page, selectors: readonly string[], value: string) {
  for (const context of [page, ...page.frames()] as BrowserContext[]) {
    for (const selector of selectors) {
      const locator = context.locator(selector).first();
      try {
        if ((await locator.count()) > 0 && (await locator.isVisible())) {
          await locator.selectOption(value, { timeout: 3_000 });
          return true;
        }
      } catch {
        // The country control is optional and can be replaced while loading.
      }
    }
  }
  return false;
}

async function completeHostedCheckout(browser: Browser, checkoutUrl: string, email: string, completed: () => boolean) {
  try {
    const page = await browser.newPage();
    await page.goto(checkoutUrl, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await fillHostedField(page, ['input[type="email"]', 'input[name="email"]'], email);
    await fillHostedField(
      page,
      ['input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[placeholder*="1234"]'],
      String(42).repeat(8),
    );
    await fillHostedField(
      page,
      ['input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[placeholder*="MM"]'],
      ["12", "34"].join(" / "),
    );
    await fillHostedField(
      page,
      ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[placeholder*="CVC"]'],
      String(123),
    );
    await fillHostedField(
      page,
      ['input[autocomplete="cc-name"]', 'input[name="billingName"]', 'input[placeholder*="name"]'],
      "Poietra Stripe E2E",
    );
    await selectHostedOptionIfVisible(
      page,
      ['select[autocomplete="country"]', 'select[name="billingAddressCountry"]', 'select[name="country"]'],
      "US",
    );
    await fillHostedFieldIfVisible(
      page,
      [
        'input[autocomplete="postal-code"]',
        'input[name="postalCode"]',
        'input[name="postal_code"]',
        'input[placeholder*="ZIP"]',
        'input[placeholder*="postal"]',
      ],
      "42424",
    );
    const submit = page
      .locator('[data-testid="hosted-payment-submit-button"]:visible, button[type="submit"]:visible')
      .last();
    await submit.click({ noWaitAfter: true, timeout: 30_000 });
    await eventually(
      async () => (completed() ? true : null),
      WEBHOOK_WAIT_TIMEOUT_MS,
      "Stripe Hosted Checkout webhook",
    );
  } catch {
    throw new Error("Stripe Hosted Checkout could not be completed with the official test payment method.");
  }
}

function exactStripeId(value: string, prefix: "cs" | "cus" | "sub") {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_]{1,247}$`, "u").test(value)) {
    throw new TypeError("Stripe Sandbox cleanup received an invalid object ID.");
  }
  return value;
}

function checkoutCleanupLocators(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const session = value as Record<string, unknown>;
  if (session.object !== "checkout.session" || session.livemode !== false) return null;
  return {
    customerId:
      typeof session.customer === "string" && /^cus_[A-Za-z0-9_]{1,247}$/u.test(session.customer)
        ? session.customer
        : null,
    subscriptionId:
      typeof session.subscription === "string" && /^sub_[A-Za-z0-9_]{1,247}$/u.test(session.subscription)
        ? session.subscription
        : null,
  } as const;
}

function isCredentialFreeHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin !== "null" && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function usageEvidence(pool: Pool, tenantId: string) {
  const result = await pool.query<{ events: string; reservations: string }>(
    `SELECT (SELECT count(*)::text FROM public.usage_reservations WHERE tenant_id = $1) AS reservations,
            (SELECT count(*)::text FROM public.usage_events WHERE tenant_id = $1) AS events`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Stripe Sandbox usage evidence was unavailable.");
  return row;
}

describe.skipIf(configuration === null)("Stripe Sandbox Checkout, Portal, and render admission", () => {
  it("proves Portal binding, signed webhook reconciliation, deduplication, cancellation, and bounded cleanup", async () => {
    const options = configuredLane(configuration);
    await expect(validateStripeSandboxPriceV1(options)).resolves.toEqual({ id: options.priceId, livemode: false });

    const suffix = randomUUID().replaceAll("-", "");
    const tenantId = `stripe-e2e-${suffix.slice(0, 24)}`;
    const ownerId = randomUUID();
    const testEmail = options.testEmail ?? `poietra-stripe-e2e+${suffix.slice(0, 16)}@example.com`;
    const pool = new Pool({
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: 5_000,
      max: 4,
      options: POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    const stripeRepository = new PostgresStripeBillingRepositoryV1({ pool });
    const entitlementRepository = new PostgresBillingEntitlementRepositoryV1({ pool });
    let browser: Browser | null = null;
    let browserHome: string | null = null;
    let service: StripeBillingServiceV1 | null = null;
    let receiver: Awaited<ReturnType<typeof startWebhookReceiver>> | null = null;
    let forwarder: Awaited<ReturnType<typeof startStripeWebhookForwarder>> | null = null;
    const stripeCheckoutSessionIds = new Set<string>();
    const stripeCustomerIds = new Set<string>();
    const stripeSubscriptionIds = new Set<string>();
    const canceledSubscriptionIds = new Set<string>();
    let expectedPortalCustomerId: string | null = null;
    let portalBindingEvidence: Readonly<{
      configuredByServer: boolean;
      customerBoundByServer: boolean;
      responseBoundToRequest: boolean;
      returnedInTestMode: boolean;
      returnUrlBoundByServer: boolean;
    }> | null = null;
    try {
      try {
        browserHome = await mkdtemp(join(tmpdir(), "poietra-stripe-browser-"));
        browser = await chromium.launch({ env: boundedBrowserEnvironment(browserHome), headless: true });
      } catch {
        throw new Error(
          "Playwright Chromium is unavailable; run pnpm exec playwright install chromium before the required Stripe lane.",
        );
      }
      await applyBundledDurableStorageMigrations(pool);
      await seedOrganization(pool, tenantId, ownerId);
      await expect(Promise.all([stripeRepository.ready(), entitlementRepository.ready()])).resolves.toEqual([
        true,
        true,
      ]);
      const principal = await authenticateManimPrincipal(
        { authenticate: async () => ({ subjectId: ownerId, tenantId }) },
        {},
        new AbortController().signal,
      );

      receiver = await startWebhookReceiver(async (rawBody, stripeSignature) => {
        if (!service) throw new Error("Stripe billing service is not ready.");
        await service.acceptWebhook({ rawBody, stripeSignature });
      });
      forwarder = await startStripeWebhookForwarder({ configuration: options, forwardUrl: receiver.url });
      const stripeGateway = createStripeHttpBillingGatewayV1({ secretKey: options.secretKey });
      const recordingGateway = Object.freeze({
        ...stripeGateway,
        async createCheckoutSession(...args: Parameters<typeof stripeGateway.createCheckoutSession>) {
          const checkout = await stripeGateway.createCheckoutSession(...args);
          stripeCheckoutSessionIds.add(checkout.id);
          return checkout;
        },
        async createPortalSession(...args: Parameters<typeof stripeGateway.createPortalSession>) {
          const [input] = args;
          const portal = await stripeGateway.createPortalSession(...args);
          portalBindingEvidence = Object.freeze({
            configuredByServer: input.configurationId === options.portalConfigurationId,
            customerBoundByServer: expectedPortalCustomerId !== null && input.customerId === expectedPortalCustomerId,
            responseBoundToRequest:
              portal.configurationId === input.configurationId &&
              portal.customerId === input.customerId &&
              portal.returnUrl === input.returnUrl,
            returnedInTestMode: portal.livemode === false,
            returnUrlBoundByServer: input.returnUrl === "https://stripe-e2e.poietra.invalid/?billing=portal-return",
          });
          return portal;
        },
      });
      service = createStripeBillingServiceV1({
        catalog: createStripeCheckoutPlanCatalogV1({
          pro: { renderJobLimit: 3, stripePriceId: options.priceId },
        }),
        gateway: recordingGateway,
        livemode: false,
        portalConfigurationId: options.portalConfigurationId,
        publicOrigin: "https://stripe-e2e.poietra.invalid",
        repository: stripeRepository,
        webhookSigningSecret: forwarder.signingSecret,
      });

      const firstCheckout = await service.startCheckout({ planKey: "pro", principal });
      const replayedCheckout = await service.startCheckout({ planKey: "pro", principal });
      expect(replayedCheckout.checkoutUrl === firstCheckout.checkoutUrl).toBe(true);
      const attemptEvidence = await pool.query<{
        attempts: string;
        sessions: string;
        stripe_checkout_session_id: string | null;
      }>(
        `SELECT count(*)::text AS attempts,
                  count(stripe_checkout_session_id)::text AS sessions,
                  min(stripe_checkout_session_id) AS stripe_checkout_session_id
             FROM public.billing_checkout_attempts
            WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(attemptEvidence).toMatchObject({ rows: [{ attempts: "1", sessions: "1" }] });
      const attemptRow = attemptEvidence.rows[0];
      if (!attemptRow?.stripe_checkout_session_id) {
        throw new Error("Stripe Checkout retry did not retain one canonical Session locator.");
      }
      const stripeCheckoutSessionId = exactStripeId(attemptRow.stripe_checkout_session_id, "cs");
      expect(stripeCheckoutSessionIds.has(stripeCheckoutSessionId)).toBe(true);

      await completeHostedCheckout(browser, firstCheckout.checkoutUrl, testEmail, () =>
        receiver!.captured.some(({ eventType }) => eventType === "checkout.session.completed"),
      );
      await eventually(
        async () => {
          const status = await service!.readStatus({ principal });
          return status.entitlement?.sourceGeneration === "1" && status.entitlement.renderEnabled ? status : null;
        },
        WEBHOOK_WAIT_TIMEOUT_MS,
        "Stripe Checkout reconciliation",
      );
      const checkoutEvent = await eventually(
        async () => receiver!.captured.find(({ eventType }) => eventType === "checkout.session.completed") ?? null,
        WEBHOOK_WAIT_TIMEOUT_MS,
        "Stripe Checkout webhook evidence",
      );
      expect(checkoutEvent.livemode).toBe(false);

      const accountBeforeReplay = await stripeRepository.readAccount(tenantId);
      expect(accountBeforeReplay).toMatchObject({ entitlementGeneration: 1n, livemode: false });
      await expect(
        entitlementRepository.reserveRender({ lifetimeMs: 60_000, operationId: randomUUID(), tenantId }),
      ).resolves.toMatchObject({ kind: "reserved", replayed: false });
      const usageBeforeReplay = await usageEvidence(pool, tenantId);
      await service.acceptWebhook({
        rawBody: checkoutEvent.rawBody,
        stripeSignature: checkoutEvent.stripeSignature,
      });
      await expect(stripeRepository.readAccount(tenantId)).resolves.toMatchObject({
        entitlementGeneration: 1n,
        observationGeneration: accountBeforeReplay?.observationGeneration,
        reconcileGeneration: accountBeforeReplay?.reconcileGeneration,
      });
      await expect(usageEvidence(pool, tenantId)).resolves.toEqual(usageBeforeReplay);

      const account = await stripeRepository.readAccount(tenantId);
      const subscription = await stripeRepository.readCurrentSubscription(tenantId);
      if (!account?.stripeCustomerId || !subscription) {
        throw new Error("Stripe Sandbox reconciliation did not persist canonical object locators.");
      }
      const stripeCustomerId = exactStripeId(account.stripeCustomerId, "cus");
      const stripeSubscriptionId = exactStripeId(subscription.stripeSubscriptionId, "sub");
      stripeCustomerIds.add(stripeCustomerId);
      stripeSubscriptionIds.add(stripeSubscriptionId);
      expect(subscription).toMatchObject({ livemode: false, planKey: "pro", status: "active" });

      expectedPortalCustomerId = stripeCustomerId;
      const statusBeforePortal = await service.readStatus({ principal });
      const accountBeforePortal = await stripeRepository.readAccount(tenantId);
      const subscriptionBeforePortal = await stripeRepository.readCurrentSubscription(tenantId);
      const portal = await service.openPortal({ principal });
      expect(isCredentialFreeHttpsUrl(portal.portalUrl)).toBe(true);
      expect(portalBindingEvidence).toEqual({
        configuredByServer: true,
        customerBoundByServer: true,
        responseBoundToRequest: true,
        returnedInTestMode: true,
        returnUrlBoundByServer: true,
      });
      await expect(service.readStatus({ principal })).resolves.toEqual(statusBeforePortal);
      await expect(stripeRepository.readAccount(tenantId)).resolves.toEqual(accountBeforePortal);
      await expect(stripeRepository.readCurrentSubscription(tenantId)).resolves.toEqual(subscriptionBeforePortal);

      const canceled = await stripeSandboxRequestV1(
        options,
        `/v1/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`,
        { method: "DELETE" },
      );
      expect(canceled).toMatchObject({ id: stripeSubscriptionId, livemode: false, status: "canceled" });
      canceledSubscriptionIds.add(stripeSubscriptionId);
      await eventually(
        async () => {
          const status = await service!.readStatus({ principal });
          return status.subscription?.status === "canceled" && status.entitlement?.renderEnabled === false
            ? status
            : null;
        },
        WEBHOOK_WAIT_TIMEOUT_MS,
        "Stripe cancellation reconciliation",
      );
      await expect(
        entitlementRepository.reserveRender({ lifetimeMs: 60_000, operationId: randomUUID(), tenantId }),
      ).resolves.toEqual({ kind: "denied", reason: "blocked" });
      expect(
        receiver.captured.some(({ eventType, livemode }) => eventType === "customer.subscription.deleted" && !livemode),
      ).toBe(true);
    } finally {
      await forwarder?.close().catch(() => undefined);
      forwarder = null;
      await receiver?.close().catch(() => undefined);
      receiver = null;
      for (const stripeCheckoutSessionId of stripeCheckoutSessionIds) {
        await stripeSandboxRequestV1(
          options,
          `/v1/checkout/sessions/${encodeURIComponent(stripeCheckoutSessionId)}/expire`,
          { method: "POST" },
        ).catch(() => undefined);
        const session = await stripeSandboxRequestV1(
          options,
          `/v1/checkout/sessions/${encodeURIComponent(stripeCheckoutSessionId)}`,
        )
          .then(checkoutCleanupLocators)
          .catch(() => null);
        if (session?.customerId) stripeCustomerIds.add(session.customerId);
        if (session?.subscriptionId) stripeSubscriptionIds.add(session.subscriptionId);
      }
      for (const stripeSubscriptionId of stripeSubscriptionIds) {
        if (canceledSubscriptionIds.has(stripeSubscriptionId)) continue;
        await stripeSandboxRequestV1(options, `/v1/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`, {
          method: "DELETE",
        }).catch(() => undefined);
      }
      for (const stripeCustomerId of stripeCustomerIds) {
        await stripeSandboxRequestV1(options, `/v1/customers/${encodeURIComponent(stripeCustomerId)}`, {
          method: "DELETE",
        }).catch(() => undefined);
      }
      await browser?.close().catch(() => undefined);
      await service?.close().catch(() => undefined);
      await entitlementRepository.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      if (browserHome) await rm(browserHome, { force: true, recursive: true }).catch(() => undefined);
    }
  }, 240_000);
});
