import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";

import { z } from "zod";

import { sendJson } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import { handleManimRequest, type ManimApi } from "./manim-render-http";

const DEFAULT_LIMITS = {
  handlerTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  maxBodyBytes: 512 * 1024,
  maxConnections: 256,
  maxHeaderBytes: 16 * 1024,
  maxRequestsPerSocket: 100,
  readinessTimeoutMs: 2_000,
  requestDrainTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  runtimeCloseTimeoutMs: 10_000,
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
      .max(512 * 1024)
      .default(DEFAULT_LIMITS.maxBodyBytes),
    maxConnections: z.number().int().min(1).max(10_000).default(DEFAULT_LIMITS.maxConnections),
    maxHeaderBytes: z
      .number()
      .int()
      .min(4 * 1024)
      .max(64 * 1024)
      .default(DEFAULT_LIMITS.maxHeaderBytes),
    maxRequestsPerSocket: z.number().int().min(1).max(1_000).default(DEFAULT_LIMITS.maxRequestsPerSocket),
    readinessTimeoutMs: z.number().int().min(100).max(10_000).default(DEFAULT_LIMITS.readinessTimeoutMs),
    requestDrainTimeoutMs: z.number().int().min(100).max(60_000).default(DEFAULT_LIMITS.requestDrainTimeoutMs),
    requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_LIMITS.requestTimeoutMs),
    runtimeCloseTimeoutMs: z.number().int().min(100).max(60_000).default(DEFAULT_LIMITS.runtimeCloseTimeoutMs),
  })
  .strict()
  .refine(({ headersTimeoutMs, requestTimeoutMs }) => headersTimeoutMs <= requestTimeoutMs, {
    message: "headersTimeoutMs cannot exceed requestTimeoutMs.",
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
}>;

export type ProductionRequestAdmission = Readonly<{
  admit: (request: ProductionAdmissionRequest, signal: AbortSignal) => Promise<boolean>;
  ready: (signal: AbortSignal) => Promise<boolean>;
}>;

export type ProductionRuntimeReadinessV1 =
  | Readonly<{ ready: false }>
  | Readonly<{
      executionBoundary: "adapter-attests-external-sandbox";
      ready: true;
      tenantBoundary: "single-tenant-deployment";
    }>;

/**
 * This in-process adapter is trusted code. Its readiness result is an
 * operational assertion made after the adapter verifies its external sandbox;
 * it is not proof created or verified by this HTTP server. The current
 * host-spawn ManimProjectRegistry must not implement this contract (#117).
 */
export type ProductionManimRuntimeAdapterV1 = Readonly<{
  api: ManimApi;
  close: () => Promise<void>;
  /** Covers fresh sandbox attestation and single-tenant backing stores. */
  ready: (signal: AbortSignal) => Promise<ProductionRuntimeReadinessV1>;
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
  const bodyMethod = request.method === "POST" || request.method === "PATCH";
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
    logger?: StructuredLogger;
    runtime: ProductionManimRuntimeAdapterV1;
  }>,
): Promise<ProductionManimServer> {
  const config = parseProductionManimServerConfig(options.config);
  if (
    typeof options.runtime !== "object" ||
    options.runtime === null ||
    typeof options.runtime.api !== "object" ||
    options.runtime.api === null ||
    typeof options.runtime.ready !== "function" ||
    typeof options.runtime.close !== "function"
  ) {
    throw new TypeError("Production Manim runtime adapter is incomplete.");
  }
  if (
    typeof options.admission !== "object" ||
    options.admission === null ||
    typeof options.admission.admit !== "function" ||
    typeof options.admission.ready !== "function"
  ) {
    throw new TypeError("Production request admission adapter is incomplete.");
  }
  const logger = options.logger ?? nullLogger;
  const trustedProxyAddresses = new Set(config.trustedProxyAddresses);
  const activeRequests = new Set<AbortController>();
  const activeTasks = new Set<Promise<void>>();
  const activeRuntimeTasks = new Set<Promise<unknown>>();
  let lifecycle: "accepting" | "draining" | "closed" = "accepting";
  let runtimeCloseRequest: Promise<void> | null = null;

  const trackRuntimeTask = <T>(operation: () => Promise<T>) => {
    const task = Promise.resolve().then(operation);
    activeRuntimeTasks.add(task);
    void task.then(
      () => activeRuntimeTasks.delete(task),
      () => activeRuntimeTasks.delete(task),
    );
    return task;
  };
  const closeRuntime = () => {
    runtimeCloseRequest ??= Promise.resolve().then(() => options.runtime.close());
    return runtimeCloseRequest;
  };

  const dependenciesReady = async (signal: AbortSignal) => {
    try {
      const [admissionReady, runtimeReady] = await Promise.all([
        waitForProbe((probeSignal) => options.admission.ready(probeSignal), signal, config.limits.readinessTimeoutMs),
        waitForProbe(
          (probeSignal) => trackRuntimeTask(() => options.runtime.ready(probeSignal)),
          signal,
          config.limits.readinessTimeoutMs,
        ),
      ]);
      return (
        admissionReady === true &&
        runtimeReady !== ABORTED &&
        runtimeReady.ready === true &&
        runtimeReady.executionBoundary === "adapter-attests-external-sandbox" &&
        runtimeReady.tenantBoundary === "single-tenant-deployment"
      );
    } catch {
      logger.warn("production.readiness_probe_failed");
      return false;
    }
  };

  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const controller = new AbortController();
    activeRequests.add(controller);
    const abortOnClose = () => controller.abort(new Error("Client connection closed."));
    response.once("close", abortOnClose);
    const handlerTimeout = setTimeout(() => {
      controller.abort(new Error("Production request deadline exceeded."));
      request.resume();
      if (!response.headersSent) response.setHeader("connection", "close");
      sendJson(response, 504, { error: "Request deadline exceeded." });
    }, config.limits.handlerTimeoutMs);
    handlerTimeout.unref();

    try {
      const transport = validateTransportRequest(request, config, trustedProxyAddresses);
      const pathname = new URL(request.url!, config.publicOrigin).pathname;
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
      if (!pathname.startsWith("/api/manim/")) throw new TransportError("Endpoint not found.", 404);
      if (lifecycle !== "accepting") throw new TransportError("Production service is draining.", 503);
      if (!(await dependenciesReady(controller.signal))) {
        throw new TransportError("Production dependencies are not ready.", 503);
      }
      if (controller.signal.aborted) return;
      if (lifecycle !== "accepting") throw new TransportError("Production service is draining.", 503);
      const admitted = await raceWithSignal(
        () =>
          options.admission.admit(
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
            },
            controller.signal,
          ),
        controller.signal,
      );
      if (admitted === ABORTED || controller.signal.aborted) return;
      if (lifecycle !== "accepting") throw new TransportError("Production service is draining.", 503);
      if (admitted !== true) throw new TransportError("Authentication is required.", 401);
      await raceWithSignal(
        () =>
          trackRuntimeTask(() =>
            handleManimRequest(options.runtime.api, request, response, logger, {
              allowExistingProjectRegistration: false,
              expectedMutationOrigin: config.publicOrigin,
              maxJsonBodyBytes: config.limits.maxBodyBytes,
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
      logger.error("production.request_failed", {
        kind: error instanceof Error ? error.name : "UnknownError",
      });
      request.resume();
      response.setHeader("connection", "close");
      sendJson(response, 500, { error: "Production request failed." });
    } finally {
      clearTimeout(handlerTimeout);
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
  server.on("error", (error) => logger.error("production.server_error", { kind: error.name }));

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
    const runtimeClose = await settleWithin(closeRuntime(), config.limits.runtimeCloseTimeoutMs);
    if (runtimeClose.kind === "fulfilled") throw error;
    const closeError =
      runtimeClose.kind === "rejected"
        ? runtimeClose.reason
        : new Error("Production runtime cleanup timed out after listener startup failed.");
    throw new AggregateError([error, closeError], "Production listener and runtime cleanup both failed.");
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
          const runtimeClose = await settleWithin(closeRuntime(), config.limits.runtimeCloseTimeoutMs);
          if (runtimeClose.kind === "timeout") {
            errors.push(new Error("Production runtime close exceeded its configured deadline."));
          } else if (runtimeClose.kind === "rejected") {
            errors.push(runtimeClose.reason);
          }
        } else {
          // Calling close while an uncooperative runtime operation is still
          // executing can resume that operation against torn-down stores. The
          // HTTP boundary is already closed; defer teardown until quiescence
          // and let the process supervisor reclaim a permanently stuck adapter.
          void quiesce().then(
            () => closeRuntime().catch(() => logger.error("production.deferred_runtime_close_failed")),
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
