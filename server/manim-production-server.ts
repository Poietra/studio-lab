import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";

import { z } from "zod";

import { MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1 } from "../src/render-pipeline/contracts";
import {
  normalizeOrganizationSelectorHeaderV1,
  ORGANIZATION_SELECTOR_HEADER_V1,
} from "./accounts/organization-selector-header";
import { EditSuggestionAdmissionController } from "./edit-suggestions/admission";
import { createEditSuggestionRequestHandler, EDIT_SUGGESTION_ROUTE } from "./edit-suggestions/handler";
import type { EditSuggestionGenerator } from "./edit-suggestions/service";
import { handleEditorDocumentRequest, isEditorDocumentRequest } from "./editor-document-http";
import { HttpError, sendJson } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import {
  handleManimRequest,
  isManimBrowserProjectImportRequest,
  isManimRenderStartRequest,
  isManimVideoRequest,
  isManimWorkspaceBootstrapRequest,
  isTenantCellStorageLaneManimRequest,
  type ManimApi,
} from "./manim-render-http";
import { authenticateManimPrincipal, type ManimPrincipalAuthenticator } from "./manim-request-principal";
import { ManimTenantRegistry } from "./manim-tenant-registry";
import {
  assertProductionManimRuntimeCellLeaseV1,
  assertProductionManimRuntimeCellResolverV1,
  createPinnedProductionManimRuntimeCellResolverV1,
  hasTenantCellStorageReadinessV1,
  type ProductionManimRuntimeAdapterV1,
  type ProductionManimRuntimeCellLeaseV1,
  type ProductionManimRuntimeCellResolverV1,
} from "./production-runtime-cell";

export {
  ACCOUNT_SESSION_COOKIE_NAME_V1,
  createAccountSessionIdentityAuthenticatorV1,
} from "./accounts/account-session-authenticator";
export type { AccountSessionRepositoryV1, ResolvedAccountSessionV1 } from "./accounts/account-session-repository";
export {
  createOrganizationMembershipProductionAdmissionV1,
  type ExternalAccountIdentityAuthenticatorV1,
} from "./accounts/organization-membership-admission";
export type {
  ExternalAccountIdentityV1,
  OrganizationMembershipRepositoryV1,
  ResolvedOrganizationMembershipV1,
} from "./accounts/organization-membership-repository";
export {
  createDurablePostgresS3ProductionRuntimeCellProvisionerV1,
  createDurablePostgresS3ProductionRuntimeV1,
  createPostgresProductionManimRuntimeCellResolverV1,
  type DurablePostgresS3ProductionRuntimeCellProvisionerOptionsV1,
  type DurablePostgresS3ProductionRuntimeOptionsV1,
  type PostgresProductionManimRuntimeCellResolverOptionsV1,
} from "./durable-manim-production-composition";
export {
  createDurableManimRuntimeV1,
  createDurableProductionManimRuntimeAdapterV1,
  createTenantCellProductionManimRuntimeAdapterV1,
  DurableManimRuntimeV1,
  type TenantCellMaintenanceReadinessV1,
  type TenantCellMaintenanceSplitV1,
} from "./durable-manim-runtime";
export type {
  ProductionManimRuntimeAdapterV1,
  ProductionManimRuntimeCellLeaseV1,
  ProductionManimRuntimeCellProvisionerV1,
  ProductionManimRuntimeCellResolverV1,
  ProductionRuntimeCellAssignmentSourceV1,
  ProductionRuntimeCellAssignmentV1,
  ProductionRuntimeReadinessV1,
  TenantCellRuntimeAdapterV1,
  TenantCellStorageReadinessV1,
} from "./production-runtime-cell";
export {
  assertProductionManimRuntimeCellLeaseV1,
  BoundedProductionManimRuntimeCellResolverV1,
  createPinnedProductionManimRuntimeCellResolverV1,
  hasTenantCellStorageReadinessV1,
  productionRuntimeCellIdSchemaV1,
} from "./production-runtime-cell";
export {
  type CreateRuntimeCellAssignmentInputV1,
  createRuntimeCellAssignmentInputSchemaV1,
  type DisableRuntimeCellAssignmentInputV1,
  disableRuntimeCellAssignmentInputSchemaV1,
  type RotateRuntimeCellAssignmentInputV1,
  type RuntimeCellAssignmentMutationResultV1,
  type RuntimeCellAssignmentRepositoryV1,
  rotateRuntimeCellAssignmentInputSchemaV1,
  runtimeCellAssignmentMutationIdSchemaV1,
} from "./runtime-cell-assignment-repository";
export {
  applyBundledWorkspaceSourceMigrationV1,
  WORKSPACE_SOURCE_MIGRATION_V1_SOURCE,
} from "./storage/postgres/migrate";
export { PostgresAccountSessionRepositoryV1 } from "./storage/postgres/postgres-account-session-repository";
export { PostgresOrganizationMembershipRepositoryV1 } from "./storage/postgres/postgres-organization-membership-repository";
export { PostgresRuntimeCellAssignmentRepositoryV1 } from "./storage/postgres/postgres-runtime-cell-assignment-repository";
export { PostgresWorkspaceSourceRepositoryV1 } from "./storage/postgres/postgres-workspace-source-repository";
export { S3ContentBlobStoreV1 } from "./storage/s3/s3-content-blob-store";
export {
  createDurableSourceBlobGcWorkerV1,
  DurableSourceBlobGcWorkerV1,
  runSourceBlobGcV1,
} from "./storage/source-blob-gc";

const DEFAULT_LIMITS = {
  handlerTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  maxBodyBytes: MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1,
  maxConnections: 256,
  maxHeaderBytes: 16 * 1024,
  maxRequestsPerSocket: 100,
  mediaStreamIdleTimeoutMs: 30_000,
  mediaStreamTimeoutMs: 15 * 60_000,
  readinessTimeoutMs: 2_000,
  requestDrainTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  runtimeCloseTimeoutMs: 45_000,
} as const;

const PRODUCTION_AUTH_ERROR_MESSAGES = {
  401: "Authentication is required.",
  403: "Tenant access is not available.",
  503: "Tenant access is temporarily unavailable.",
} as const;

const limitsSchema = z
  .object({
    handlerTimeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_LIMITS.handlerTimeoutMs),
    headersTimeoutMs: z.number().int().min(1_000).max(60_000).default(DEFAULT_LIMITS.headersTimeoutMs),
    keepAliveTimeoutMs: z.number().int().min(250).max(30_000).default(DEFAULT_LIMITS.keepAliveTimeoutMs),
    maxBodyBytes: z
      .number()
      .int()
      .min(1_024)
      .max(MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1)
      .default(DEFAULT_LIMITS.maxBodyBytes),
    maxConnections: z.number().int().min(1).max(10_000).default(DEFAULT_LIMITS.maxConnections),
    maxHeaderBytes: z
      .number()
      .int()
      .min(4 * 1024)
      .max(64 * 1024)
      .default(DEFAULT_LIMITS.maxHeaderBytes),
    maxRequestsPerSocket: z.number().int().min(1).max(1_000).default(DEFAULT_LIMITS.maxRequestsPerSocket),
    mediaStreamIdleTimeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_LIMITS.mediaStreamIdleTimeoutMs),
    mediaStreamTimeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(15 * 60_000)
      .default(DEFAULT_LIMITS.mediaStreamTimeoutMs),
    readinessTimeoutMs: z.number().int().min(100).max(10_000).default(DEFAULT_LIMITS.readinessTimeoutMs),
    requestDrainTimeoutMs: z.number().int().min(100).max(60_000).default(DEFAULT_LIMITS.requestDrainTimeoutMs),
    requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_LIMITS.requestTimeoutMs),
    runtimeCloseTimeoutMs: z.number().int().min(100).max(60_000).default(DEFAULT_LIMITS.runtimeCloseTimeoutMs),
  })
  .strict()
  .refine(({ headersTimeoutMs, requestTimeoutMs }) => headersTimeoutMs <= requestTimeoutMs, {
    message: "headersTimeoutMs cannot exceed requestTimeoutMs.",
  })
  .refine(({ mediaStreamIdleTimeoutMs, mediaStreamTimeoutMs }) => mediaStreamIdleTimeoutMs < mediaStreamTimeoutMs, {
    message: "mediaStreamIdleTimeoutMs must be shorter than mediaStreamTimeoutMs.",
  });

const productionServerConfigSchema = z
  .object({
    deployment: z.literal("production"),
    host: z.string().min(1).max(64),
    limits: limitsSchema.default(DEFAULT_LIMITS),
    port: z.number().int().min(1).max(65_535),
    publicOrigin: z.string().min(1).max(2_048),
    trustedProxyAddresses: z.array(z.string().min(1).max(64)).max(64).default([]),
  })
  .strict();

export type ProductionManimServerConfig = Readonly<{
  deployment: "production";
  host: string;
  limits: Readonly<{
    handlerTimeoutMs: number;
    headersTimeoutMs: number;
    keepAliveTimeoutMs: number;
    maxBodyBytes: number;
    maxConnections: number;
    maxHeaderBytes: number;
    maxRequestsPerSocket: number;
    mediaStreamIdleTimeoutMs: number;
    mediaStreamTimeoutMs: number;
    readinessTimeoutMs: number;
    requestDrainTimeoutMs: number;
    requestTimeoutMs: number;
    runtimeCloseTimeoutMs: number;
  }>;
  port: number;
  publicOrigin: string;
  trustedProxyAddresses: readonly string[];
}>;

export type ProductionAdmissionRequest = Readonly<{
  credentials: Readonly<{
    authorization?: string;
    cookie?: string;
  }>;
  directPeerAddress: string | null;
  forwardedHeaders: Readonly<{
    immediatePeerTrusted: boolean;
    present: boolean;
  }>;
  method: string;
  pathname: string;
  /** Untrusted organization selector; admission must resolve it through server-owned membership state. */
  requestedOrganizationId?: string;
}>;

export type ProductionRequestAdmission = ManimPrincipalAuthenticator<ProductionAdmissionRequest> &
  Readonly<{
    close?: () => Promise<void>;
    ready: (signal: AbortSignal) => Promise<boolean>;
  }>;

export type ProductionEditSuggestionAdapterV1 = Readonly<{
  admission?: EditSuggestionAdmissionController;
  generationTimeoutMs?: number;
  generator: EditSuggestionGenerator;
}>;

export type ProductionManimServer = Readonly<{
  address: Readonly<{ address: string; family: string; port: number }>;
  close: () => Promise<void>;
  config: ProductionManimServerConfig;
}>;

class TransportError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TransportError";
    this.status = status;
  }
}

function isLoopback(hostname: string) {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unwrapped === "localhost" || unwrapped === "::1" || (isIP(unwrapped) === 4 && unwrapped.startsWith("127."));
}

export function parseProductionManimServerConfig(input: unknown): ProductionManimServerConfig {
  const parsed = productionServerConfigSchema.parse(input);
  if (isIP(parsed.host) === 0) throw new TypeError("Production server host must be an explicit IP address.");
  for (const address of parsed.trustedProxyAddresses) {
    if (isIP(address) === 0) throw new TypeError("Trusted proxy entries must be explicit IP addresses.");
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(parsed.publicOrigin);
  } catch {
    throw new TypeError("Production publicOrigin must be an absolute HTTP(S) origin.");
  }
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.origin === "null" ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new TypeError("Production publicOrigin must contain only an HTTP(S) scheme, host, and optional port.");
  }
  if (publicUrl.protocol !== "https:" && !isLoopback(publicUrl.hostname)) {
    throw new TypeError("A non-loopback production publicOrigin must use HTTPS.");
  }

  return {
    ...parsed,
    limits: { ...parsed.limits },
    publicOrigin: publicUrl.origin,
    trustedProxyAddresses: [...new Set(parsed.trustedProxyAddresses)],
  };
}

const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

function remoteAddressCandidates(address: string | undefined) {
  if (!address) return [];
  return address.startsWith("::ffff:") ? [address, address.slice("::ffff:".length)] : [address];
}

function validateTransportRequest(
  request: IncomingMessage,
  config: ProductionManimServerConfig,
  trustedProxyAddresses: ReadonlySet<string>,
) {
  if (
    !request.url?.startsWith("/") ||
    request.url.startsWith("//") ||
    request.url.includes("\\") ||
    request.url.includes("#") ||
    /[\u0000-\u0020\u007f]/.test(request.url)
  ) {
    throw new TransportError("Absolute request targets are not accepted.", 400);
  }
  const expectedHost = new URL(config.publicOrigin).host.toLowerCase();
  if (request.headers.host?.toLowerCase() !== expectedHost) {
    throw new TransportError("The request Host does not match the configured public origin.", 421);
  }
  const hasForwardedHeaders = FORWARDED_HEADERS.some((name) => request.headers[name] !== undefined);
  const remoteIsTrusted = remoteAddressCandidates(request.socket.remoteAddress).some((address) =>
    trustedProxyAddresses.has(address),
  );
  if (hasForwardedHeaders && !remoteIsTrusted) {
    throw new TransportError("Forwarded headers require an explicitly trusted immediate proxy.", 400);
  }
  if (request.headers["transfer-encoding"] !== undefined) {
    request.resume();
    throw new TransportError("Transfer-encoded request bodies are not accepted.", 400);
  }
  const contentLength = request.headers["content-length"];
  const parsedContentLength = contentLength === undefined ? 0 : Number(contentLength);
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) ||
      !Number.isSafeInteger(parsedContentLength) ||
      parsedContentLength > config.limits.maxBodyBytes)
  ) {
    request.resume();
    throw new TransportError("Request body is too large.", 413);
  }
  const bodyMethod = request.method === "POST" || request.method === "PUT" || request.method === "PATCH";
  if (bodyMethod && contentLength === undefined) {
    request.resume();
    throw new TransportError("A bounded Content-Length header is required.", 411);
  }
  if (!bodyMethod && parsedContentLength > 0) {
    request.resume();
    throw new TransportError("This request method does not accept a body.", 400);
  }
  return {
    forwardedHeadersPresent: hasForwardedHeaders,
    immediatePeerTrusted: remoteIsTrusted,
  } as const;
}

const ABORTED = Symbol("aborted");

async function raceWithSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return ABORTED;
  let abortListener: (() => void) | null = null;
  const aborted = new Promise<typeof ABORTED>((resolveAbort) => {
    abortListener = () => resolveAbort(ABORTED);
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

async function waitForProbe<T>(
  probe: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Readiness probe timed out.")), timeoutMs);
  timeout.unref();
  return raceWithSignal(() => probe(controller.signal), controller.signal).finally(() => {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: NodeJS.Timeout;
  const deadline = new Promise<Readonly<{ kind: "timeout" }>>((resolveDeadline) => {
    timeout = setTimeout(() => resolveDeadline({ kind: "timeout" }), timeoutMs);
  });
  const settled = promise.then(
    (value) => ({ kind: "fulfilled", value }) as const,
    (reason: unknown) => ({ kind: "rejected", reason }) as const,
  );
  const result = await Promise.race([settled, deadline]);
  clearTimeout(timeout!);
  return result;
}

export async function startProductionManimServer(
  options: Readonly<{
    admission: ProductionRequestAdmission;
    config: unknown;
    editSuggestions?: ProductionEditSuggestionAdapterV1;
    logger?: StructuredLogger;
    /** Migration/rollback path for a deployment pinned to one Organization. */
    runtime?: ProductionManimRuntimeAdapterV1;
    /** Server-owned dynamic Organization-to-cell routing path. */
    runtimeResolver?: ProductionManimRuntimeCellResolverV1;
  }>,
): Promise<ProductionManimServer> {
  const config = parseProductionManimServerConfig(options.config);
  if ((options.runtime === undefined) === (options.runtimeResolver === undefined)) {
    throw new TypeError("Production server requires exactly one runtime or runtime cell resolver.");
  }
  const runtimeResolver = options.runtimeResolver ?? createPinnedProductionManimRuntimeCellResolverV1(options.runtime!);
  assertProductionManimRuntimeCellResolverV1(runtimeResolver);
  if (
    typeof options.admission !== "object" ||
    options.admission === null ||
    typeof options.admission.authenticate !== "function" ||
    typeof options.admission.ready !== "function" ||
    (options.admission.close !== undefined && typeof options.admission.close !== "function")
  ) {
    throw new TypeError("Production request admission adapter is incomplete.");
  }
  if (
    options.editSuggestions !== undefined &&
    (typeof options.editSuggestions !== "object" ||
      options.editSuggestions === null ||
      typeof options.editSuggestions.generator !== "object" ||
      options.editSuggestions.generator === null ||
      typeof options.editSuggestions.generator.generate !== "function" ||
      (options.editSuggestions.admission !== undefined &&
        !(options.editSuggestions.admission instanceof EditSuggestionAdmissionController)))
  ) {
    throw new TypeError("Production edit-suggestion adapter is incomplete.");
  }
  const logger = options.logger ?? nullLogger;
  const editSuggestionHandler = options.editSuggestions
    ? createEditSuggestionRequestHandler({
        admission: options.editSuggestions.admission,
        generationTimeoutMs: options.editSuggestions.generationTimeoutMs,
        generator: () => options.editSuggestions!.generator,
        logger: logger.child({ component: "edit-suggestions-api" }),
      })
    : null;
  const trustedProxyAddresses = new Set(config.trustedProxyAddresses);
  const activeRequests = new Set<AbortController>();
  const activeTasks = new Set<Promise<void>>();
  const activeRuntimeTasks = new Set<Promise<unknown>>();
  let lifecycle: "accepting" | "draining" | "closed" = "accepting";
  let admissionCloseRequest: Promise<void> | null = null;
  let runtimeResolverCloseRequest: Promise<void> | null = null;

  const trackRuntimeTask = <T>(operation: () => Promise<T>) => {
    const task = Promise.resolve().then(operation);
    activeRuntimeTasks.add(task);
    void task.then(
      () => activeRuntimeTasks.delete(task),
      () => activeRuntimeTasks.delete(task),
    );
    return task;
  };
  const closeRuntimeResolver = () => {
    runtimeResolverCloseRequest ??= Promise.resolve().then(() => runtimeResolver.close());
    return runtimeResolverCloseRequest;
  };
  const closeAdmission = () => {
    admissionCloseRequest ??= options.admission.close
      ? Promise.resolve().then(() => options.admission.close!())
      : Promise.resolve();
    return admissionCloseRequest;
  };
  const closeOwnedAdapters = async () => {
    const results = await Promise.allSettled([closeAdmission(), closeRuntimeResolver()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "Production adapter cleanup failed.");
  };

  const admissionIsReady = async (signal: AbortSignal) => {
    try {
      return (
        (await waitForProbe(
          (probeSignal) => options.admission.ready(probeSignal),
          signal,
          config.limits.readinessTimeoutMs,
        )) === true
      );
    } catch {
      logger.warn("production.admission_readiness_probe_failed");
      return false;
    }
  };

  const runtimeResolverIsReady = async (signal: AbortSignal) => {
    try {
      return (
        (await waitForProbe(
          (probeSignal) => trackRuntimeTask(() => runtimeResolver.ready(probeSignal)),
          signal,
          config.limits.readinessTimeoutMs,
        )) === true
      );
    } catch {
      logger.warn("production.runtime_resolver_readiness_probe_failed");
      return false;
    }
  };

  const runtimeIsReady = async (runtime: ProductionManimRuntimeAdapterV1, signal: AbortSignal) => {
    try {
      const runtimeReady = await waitForProbe(
        (probeSignal) => trackRuntimeTask(() => runtime.ready(probeSignal)),
        signal,
        config.limits.readinessTimeoutMs,
      );
      return (
        runtimeReady !== ABORTED &&
        runtimeReady.ready === true &&
        runtimeReady.executionBoundary === "adapter-attests-external-sandbox" &&
        runtimeReady.storageBoundary === "shared-durable" &&
        runtimeReady.tenantBoundary === "server-owned-tenant-key"
      );
    } catch {
      logger.warn("production.runtime_readiness_probe_failed");
      return false;
    }
  };

  const runtimeWorkspaceIsReady = async (runtime: ProductionManimRuntimeAdapterV1, signal: AbortSignal) => {
    try {
      return (
        (await waitForProbe(
          (probeSignal) => trackRuntimeTask(() => runtime.workspaceReady(probeSignal)),
          signal,
          config.limits.readinessTimeoutMs,
        )) === true
      );
    } catch {
      logger.warn("production.workspace_readiness_probe_failed");
      return false;
    }
  };

  const runtimeStorageIsReady = async (runtime: ProductionManimRuntimeAdapterV1, signal: AbortSignal) => {
    // Adapters that predate the TenantCell readiness split keep the full
    // fail-closed production attestation for storage-lane routes.
    if (!hasTenantCellStorageReadinessV1(runtime)) return runtimeIsReady(runtime, signal);
    try {
      return (
        (await waitForProbe(
          (probeSignal) => trackRuntimeTask(() => runtime.tenantCellStorageReady(probeSignal)),
          signal,
          config.limits.readinessTimeoutMs,
        )) === true
      );
    } catch {
      logger.warn("production.storage_readiness_probe_failed");
      return false;
    }
  };

  const runtimeRenderIsReady = async (runtime: ProductionManimRuntimeAdapterV1, signal: AbortSignal) => {
    try {
      return (
        (await waitForProbe(
          (probeSignal) => trackRuntimeTask(() => runtime.renderReady(probeSignal)),
          signal,
          config.limits.readinessTimeoutMs,
        )) === true
      );
    } catch {
      logger.warn("production.render_readiness_probe_failed");
      return false;
    }
  };

  const runtimeEditorIsReady = async (runtime: ProductionManimRuntimeAdapterV1, signal: AbortSignal) => {
    if (!runtime.editorReady) return false;
    try {
      return (
        (await waitForProbe(
          (probeSignal) => trackRuntimeTask(() => runtime.editorReady!(probeSignal)),
          signal,
          config.limits.readinessTimeoutMs,
        )) === true
      );
    } catch {
      logger.warn("production.editor_readiness_probe_failed");
      return false;
    }
  };

  const dependenciesReady = async (signal: AbortSignal) => {
    const [admissionReady, resolverReady] = await Promise.all([
      admissionIsReady(signal),
      runtimeResolverIsReady(signal),
    ]);
    return admissionReady && resolverReady;
  };

  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const controller = new AbortController();
    activeRequests.add(controller);
    const abortOnClose = () => controller.abort(new Error("Client connection closed."));
    response.once("close", abortOnClose);
    let handlerTimeout: NodeJS.Timeout | null = null;
    const armHandlerTimeout = (timeoutMs: number) => {
      if (handlerTimeout) clearTimeout(handlerTimeout);
      handlerTimeout = setTimeout(() => {
        const error = new Error("Production request deadline exceeded.");
        controller.abort(error);
        request.resume();
        if (response.headersSent) response.destroy(error);
        else {
          response.setHeader("connection", "close");
          sendJson(response, 504, { error: "Request deadline exceeded." });
        }
      }, timeoutMs);
      handlerTimeout.unref();
    };
    armHandlerTimeout(config.limits.handlerTimeoutMs);
    let accessBoundary: "authentication" | "tenant" | null = null;
    let runtimeLease: ProductionManimRuntimeCellLeaseV1 | null = null;

    try {
      const transport = validateTransportRequest(request, config, trustedProxyAddresses);
      const pathname = new URL(request.url!, config.publicOrigin).pathname;
      const isMediaStream = request.method === "GET" && isManimVideoRequest(request.method, pathname);
      if (pathname === "/healthz") {
        if (request.method !== "GET") throw new TransportError("Method not allowed.", 405);
        sendJson(response, lifecycle === "accepting" ? 200 : 503, {
          status: lifecycle === "accepting" ? "ok" : "draining",
        });
        return;
      }
      if (pathname === "/readyz") {
        if (request.method !== "GET") throw new TransportError("Method not allowed.", 405);
        const ready =
          lifecycle === "accepting" && (await dependenciesReady(controller.signal)) && lifecycle === "accepting";
        sendJson(response, ready ? 200 : 503, { status: ready ? "ready" : "unavailable" });
        return;
      }
      const isEditSuggestionRequest = pathname === EDIT_SUGGESTION_ROUTE;
      const isEditorRequest = isEditorDocumentRequest(pathname);
      if (
        (!isEditSuggestionRequest || !editSuggestionHandler) &&
        !isEditorRequest &&
        !pathname.startsWith("/api/manim/")
      ) {
        throw new TransportError("Endpoint not found.", 404);
      }
      if (lifecycle !== "accepting") throw new TransportError("Production service is draining.", 503);
      if (!(await admissionIsReady(controller.signal))) {
        throw new TransportError("Production authentication is not ready.", 503);
      }
      if (controller.signal.aborted) return;
      if (lifecycle !== "accepting") throw new TransportError("Production service is draining.", 503);
      accessBoundary = "authentication";
      const organizationSelector = normalizeOrganizationSelectorHeaderV1(
        request.headersDistinct[ORGANIZATION_SELECTOR_HEADER_V1],
      );
      if (organizationSelector.kind === "conflicting") {
        throw new TransportError("The organization selector must be a single header value.", 400);
      }
      const principal = await raceWithSignal(
        () =>
          authenticateManimPrincipal(
            options.admission,
            {
              credentials: {
                ...(typeof request.headers.authorization === "string"
                  ? { authorization: request.headers.authorization }
                  : {}),
                ...(typeof request.headers.cookie === "string" ? { cookie: request.headers.cookie } : {}),
              },
              directPeerAddress: request.socket.remoteAddress ?? null,
              forwardedHeaders: {
                immediatePeerTrusted: transport.immediatePeerTrusted,
                present: transport.forwardedHeadersPresent,
              },
              method: request.method ?? "UNKNOWN",
              pathname,
              ...(organizationSelector.kind === "selected"
                ? { requestedOrganizationId: organizationSelector.requestedOrganizationId }
                : {}),
            },
            controller.signal,
          ),
        controller.signal,
      );
      if (principal === ABORTED || controller.signal.aborted) return;
      if (lifecycle !== "accepting") throw new TransportError("Production service is draining.", 503);
      accessBoundary = "tenant";
      const resolvedLease = await raceWithSignal(
        () =>
          trackRuntimeTask(async () => {
            const acquired = await runtimeResolver.acquire(principal, controller.signal);
            try {
              assertProductionManimRuntimeCellLeaseV1(acquired, principal.tenantId);
            } catch {
              try {
                acquired?.release?.();
              } catch {
                // The resolver owns final cleanup; HTTP still fails closed.
              }
              throw new HttpError("Tenant runtime cell is temporarily unavailable.", 503);
            }
            if (controller.signal.aborted || lifecycle !== "accepting") {
              acquired.release();
              controller.signal.throwIfAborted();
              throw new TransportError("Production service is draining.", 503);
            }
            return acquired;
          }),
        controller.signal,
      );
      if (resolvedLease === ABORTED || controller.signal.aborted) return;
      runtimeLease = resolvedLease;
      const runtime = runtimeLease.runtime;
      const context = {
        principal,
        tenants: new ManimTenantRegistry<ManimApi>([runtime.api]),
      };
      context.tenants.forPrincipal(context.principal);
      accessBoundary = null;
      if (isEditSuggestionRequest && editSuggestionHandler) {
        await editSuggestionHandler(request, response, {
          expectedOrigin: config.publicOrigin,
          maxJsonBodyBytes: config.limits.maxBodyBytes,
          principal: context.principal,
          requestSignal: controller.signal,
        });
        return;
      }
      if (isEditorRequest) {
        if (!runtime.editorDocuments || !runtime.editorReady) {
          throw new TransportError("Production editor storage is not configured.", 503);
        }
        const [workspaceReady, editorReady] = await Promise.all([
          runtimeWorkspaceIsReady(runtime, controller.signal),
          runtimeEditorIsReady(runtime, controller.signal),
        ]);
        if (!workspaceReady || !editorReady) {
          throw new TransportError("Production editor storage is not ready.", 503);
        }
        if (controller.signal.aborted) return;
        if (lifecycle !== "accepting") throw new TransportError("Production service is draining.", 503);
        await raceWithSignal(
          () =>
            trackRuntimeTask(() =>
              handleEditorDocumentRequest(runtime.editorDocuments!, context.principal, request, response, {
                expectedMutationOrigin: config.publicOrigin,
                maxJsonBodyBytes: config.limits.maxBodyBytes,
                requestSignal: controller.signal,
              }),
            ),
          controller.signal,
        );
        return;
      }
      // Project/workspace bootstrap and bounded browser import require only
      // their durable source, editor-document, and optional PNG stores, so they
      // remain available through a render outage. Render-start routes use the
      // exact reported render boundary.
      // TenantCell storage-lane routes (project catalog mutations, thumbnail
      // reads, Scene snapshot PNG reads) gate on storage/tenant readiness
      // alone, so a cell without a configured sandbox still serves them;
      // execution-lane and render-session routes retain full runtime
      // attestation.
      const requestRuntimeReady =
        isManimWorkspaceBootstrapRequest(request.method, pathname) ||
        isManimBrowserProjectImportRequest(request.method, pathname)
          ? await runtimeWorkspaceIsReady(runtime, controller.signal)
          : isManimRenderStartRequest(request.method, pathname)
            ? await runtimeRenderIsReady(runtime, controller.signal)
            : isTenantCellStorageLaneManimRequest(request.method, pathname)
              ? await runtimeStorageIsReady(runtime, controller.signal)
              : await runtimeIsReady(runtime, controller.signal);
      if (!requestRuntimeReady) {
        throw new TransportError("Production runtime is not ready.", 503);
      }
      if (controller.signal.aborted) return;
      if (lifecycle !== "accepting") throw new TransportError("Production service is draining.", 503);
      if (isMediaStream) armHandlerTimeout(config.limits.mediaStreamTimeoutMs);
      await raceWithSignal(
        () =>
          trackRuntimeTask(() =>
            handleManimRequest(context, request, response, logger, {
              allowExistingProjectRegistration: false,
              expectedMutationOrigin: config.publicOrigin,
              maxJsonBodyBytes: config.limits.maxBodyBytes,
              mediaStreamIdleTimeoutMs: config.limits.mediaStreamIdleTimeoutMs,
              requestSignal: controller.signal,
            }),
          ),
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
      if (error instanceof TransportError) {
        request.resume();
        response.setHeader("connection", "close");
        sendJson(response, error.status, { error: error.message });
        return;
      }
      if (error instanceof HttpError && [401, 403, 503].includes(error.status)) {
        if (accessBoundary === "authentication" && [401, 403].includes(error.status)) {
          logger.warn("production.authentication_rejected");
        } else if (accessBoundary === "tenant" && error.status === 403) {
          logger.warn("production.foreign_tenant_rejected");
        } else if (accessBoundary === "tenant" && error.status === 503) {
          logger.warn("production.tenant_runtime_unavailable");
        }
        request.resume();
        response.setHeader("connection", "close");
        sendJson(response, error.status, {
          error: PRODUCTION_AUTH_ERROR_MESSAGES[error.status as keyof typeof PRODUCTION_AUTH_ERROR_MESSAGES],
        });
        return;
      }
      logger.error("production.request_failed", { kind: "UnhandledError" });
      request.resume();
      response.setHeader("connection", "close");
      sendJson(response, 500, { error: "Production request failed." });
    } finally {
      runtimeLease?.release();
      if (handlerTimeout) clearTimeout(handlerTimeout);
      response.removeListener("close", abortOnClose);
      activeRequests.delete(controller);
    }
  };

  const server = createServer(
    {
      headersTimeout: config.limits.headersTimeoutMs,
      keepAliveTimeout: config.limits.keepAliveTimeoutMs,
      maxHeaderSize: config.limits.maxHeaderBytes,
      requestTimeout: config.limits.requestTimeoutMs,
    },
    (request, response) => {
      response.setHeader("x-content-type-options", "nosniff");
      const task = serve(request, response);
      activeTasks.add(task);
      void task.then(
        () => activeTasks.delete(task),
        () => activeTasks.delete(task),
      );
    },
  );
  server.maxConnections = config.limits.maxConnections;
  server.maxRequestsPerSocket = config.limits.maxRequestsPerSocket;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.on("error", () => logger.error("production.server_error", { kind: "ServerError" }));

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(config.port, config.host, () => {
        server.removeListener("error", rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    server.closeAllConnections();
    const adapterClose = await settleWithin(closeOwnedAdapters(), config.limits.runtimeCloseTimeoutMs);
    if (adapterClose.kind === "fulfilled") throw error;
    const closeError =
      adapterClose.kind === "rejected"
        ? adapterClose.reason
        : new Error("Production adapter cleanup timed out after listener startup failed.");
    throw new AggregateError([error, closeError], "Production listener and adapter cleanup both failed.");
  }

  const address = server.address() as AddressInfo;
  const waitForActiveTasks = async () => {
    while (activeTasks.size > 0) {
      const batch = [...activeTasks];
      await Promise.allSettled(batch);
      for (const task of batch) activeTasks.delete(task);
    }
  };
  const waitForRuntimeTasks = async () => {
    while (activeRuntimeTasks.size > 0) {
      const batch = [...activeRuntimeTasks];
      await Promise.allSettled(batch);
      for (const task of batch) activeRuntimeTasks.delete(task);
    }
  };
  let closeRequest: Promise<void> | null = null;
  return {
    address: { address: address.address, family: address.family, port: address.port },
    close() {
      closeRequest ??= (async () => {
        lifecycle = "draining";
        const errors: unknown[] = [];
        const networkClosed = new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => (error ? rejectClose(error) : resolveClose()));
          server.closeIdleConnections();
        });
        const quiesce = async () => {
          const network = await Promise.allSettled([networkClosed]);
          await waitForActiveTasks();
          // Runtime operations can be created by an already accepted handler,
          // so they are joined only after every handler wrapper has stopped.
          await waitForRuntimeTasks();
          return network;
        };
        const drain = await settleWithin(quiesce(), config.limits.requestDrainTimeoutMs);
        let runtimeCanClose = drain.kind === "fulfilled";
        if (drain.kind === "timeout") {
          errors.push(new Error("Production request drain exceeded its configured deadline."));
          for (const controller of activeRequests) controller.abort(new Error("Production service is shutting down."));
          server.closeAllConnections();
          const forced = await settleWithin(quiesce(), config.limits.requestDrainTimeoutMs);
          runtimeCanClose = forced.kind === "fulfilled";
          if (forced.kind === "timeout") {
            errors.push(new Error("Production runtime operations did not stop after forced request cancellation."));
          } else if (forced.kind === "rejected") {
            errors.push(forced.reason);
          } else {
            errors.push(...forced.value.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
          }
        } else if (drain.kind === "rejected") {
          errors.push(drain.reason);
        } else {
          errors.push(...drain.value.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
        }

        if (runtimeCanClose) {
          const adapterClose = await settleWithin(closeOwnedAdapters(), config.limits.runtimeCloseTimeoutMs);
          if (adapterClose.kind === "timeout") {
            errors.push(new Error("Production adapter close exceeded its configured deadline."));
          } else if (adapterClose.kind === "rejected") {
            errors.push(adapterClose.reason);
          }
        } else {
          // Calling close while an uncooperative runtime operation is still
          // executing can resume that operation against torn-down stores. The
          // HTTP boundary is already closed; defer teardown until quiescence
          // and let the process supervisor reclaim a permanently stuck adapter.
          void quiesce().then(
            () => closeOwnedAdapters().catch(() => logger.error("production.deferred_adapter_close_failed")),
            () => logger.error("production.deferred_runtime_quiescence_failed"),
          );
        }
        lifecycle = "closed";
        if (errors.length > 0) throw new AggregateError(errors, "Could not fully close the production Manim service.");
      })();
      return closeRequest;
    },
    config,
  };
}
