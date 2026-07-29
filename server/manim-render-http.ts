import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isNativeError, isProxy } from "node:util/types";

import {
  createManimProjectRequestSchema,
  type ManimSourceExport,
  manimThumbnailGenerateRequestSchema,
  originalManimSourceExportRequestSchema,
  programRenderRequestSchema,
  renameManimProjectRequestSchema,
  renderAbandonRequestSchema,
  renderCommitRequestSchema,
  renderSourceActionCancellationRequestSchema,
  renderSourceActionRequestSchema,
} from "../src/render-pipeline/contracts";
import { AmbiguousSourceSceneError } from "../src/render-pipeline/source-import";
import { fastManimSnapshotQueryV1Schema, fastManimSnapshotRunRequestV1Schema } from "./fast-manim-snapshot-contract";
import { HttpError, readJsonBody, sendJson } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import type { ManimApi, MutableManimProjectApi } from "./manim-api";
import {
  authenticateManimPrincipal,
  type ManimPrincipalAuthenticator,
  type VerifiedManimPrincipal,
} from "./manim-request-principal";
import type { ManimTenantRegistry } from "./manim-tenant-registry";
import { EMPTY_MANIM_THUMBNAIL_SVG } from "./manim-thumbnail";
import type { ThumbnailAsset } from "./manim-thumbnail-cache";

const RENDER_ROUTE =
  /^\/api\/manim\/renders\/([0-9a-f-]+)(?:\/(abandon|cancel|cancel-source-action|commit|discard|undo|video))?$/;
const PROJECT_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})\/(workspace|renders|export)$/;
const PROJECT_THUMBNAIL_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})\/thumbnail(?:\/(status|generate))?$/;
const PROJECT_SCENE_SNAPSHOT_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})\/scene-snapshots$/;
const PROJECT_ITEM_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})$/;
const DEFAULT_MEDIA_STREAM_IDLE_TIMEOUT_MS = 30_000;
const MAX_MEDIA_STREAM_IDLE_TIMEOUT_MS = 120_000;

export type { ManimApi } from "./manim-api";
export type ManimRequestContext = Readonly<{
  principal: VerifiedManimPrincipal;
  tenants: ManimTenantRegistry<ManimApi>;
}>;

export async function authenticateManimRequestContext<Input>(
  authenticator: ManimPrincipalAuthenticator<Input>,
  input: Input,
  tenants: ManimTenantRegistry<ManimApi>,
  signal: AbortSignal,
): Promise<ManimRequestContext> {
  return {
    principal: await authenticateManimPrincipal(authenticator, input, signal),
    tenants,
  };
}
export type ManimRequestPolicy = Readonly<{
  allowExistingProjectRegistration: boolean;
  expectedMutationOrigin?: string;
  maxJsonBodyBytes?: number;
  mediaStreamIdleTimeoutMs?: number;
  requestSignal?: AbortSignal;
}>;

const DEFAULT_MANIM_REQUEST_POLICY: ManimRequestPolicy = {
  allowExistingProjectRegistration: true,
};
const DOM_EXCEPTION_NAME_GETTER = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;

function hasNativeErrorName(error: unknown, name: string) {
  if (isProxy(error) || !isNativeError(error)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "name");
  if (descriptor !== undefined) return "value" in descriptor && descriptor.value === name;
  if (!DOM_EXCEPTION_NAME_GETTER) return false;
  try {
    return DOM_EXCEPTION_NAME_GETTER.call(error) === name;
  } catch {
    return false;
  }
}

export function isManimVideoRequest(method: string | undefined, pathname: string) {
  const match = pathname.match(RENDER_ROUTE);
  return (method === "GET" || method === "HEAD") && match?.[2] === "video";
}

function mediaStreamIdleTimeout(value: number | undefined) {
  const timeout = value ?? DEFAULT_MEDIA_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_MEDIA_STREAM_IDLE_TIMEOUT_MS) {
    throw new RangeError("Media stream idle timeout must be between one and 120 seconds.");
  }
  return timeout;
}

function requireSameOriginJsonMutation(request: IncomingMessage, expectedOrigin?: string) {
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    request.resume();
    throw new HttpError("Request content type must be application/json.", 415);
  }
  const fetchSite = request.headers["sec-fetch-site"]?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    request.resume();
    throw new HttpError("Cross-origin mutation requests are not allowed.", 403);
  }
  const origin = request.headers.origin;
  if (expectedOrigin) {
    let actualOrigin: string | null = null;
    try {
      const parsedOrigin = origin ? new URL(origin) : null;
      actualOrigin =
        parsedOrigin &&
        parsedOrigin.pathname === "/" &&
        !parsedOrigin.search &&
        !parsedOrigin.hash &&
        !parsedOrigin.username &&
        !parsedOrigin.password
          ? parsedOrigin.origin
          : null;
    } catch {
      // The generic rejection below intentionally does not echo the value.
    }
    if (actualOrigin !== expectedOrigin) {
      request.resume();
      throw new HttpError("Mutation requests require the configured public Origin.", 403);
    }
    return;
  }
  if (!origin) return;
  const host = request.headers.host;
  try {
    const parsedOrigin = new URL(origin);
    if (
      !host ||
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.protocol !== ("encrypted" in request.socket && request.socket.encrypted ? "https:" : "http:") ||
      parsedOrigin.username ||
      parsedOrigin.password ||
      parsedOrigin.host.toLowerCase() !== host.toLowerCase()
    )
      throw new Error("Origin does not match Host.");
  } catch {
    request.resume();
    throw new HttpError("Mutation requests require a same-origin request.", 403);
  }
}

function readBoundedJsonBody(request: IncomingMessage, policy: ManimRequestPolicy, routeLimit = 64 * 1024) {
  return readJsonBody(request, Math.min(routeLimit, policy.maxJsonBodyBytes ?? routeLimit));
}

function requestRouteTemplate(rawUrl: string | undefined) {
  let pathname: string;
  try {
    pathname = new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "invalid";
  }
  if (pathname === "/api/manim/projects" || pathname === "/api/manim/workspace") return pathname;
  if (PROJECT_SCENE_SNAPSHOT_ROUTE.test(pathname)) return "/api/manim/projects/:projectId/scene-snapshots";
  if (PROJECT_THUMBNAIL_ROUTE.test(pathname)) return "/api/manim/projects/:projectId/thumbnail/:action?";
  if (PROJECT_ROUTE.test(pathname)) return "/api/manim/projects/:projectId/:action";
  if (PROJECT_ITEM_ROUTE.test(pathname)) return "/api/manim/projects/:projectId";
  if (RENDER_ROUTE.test(pathname)) return "/api/manim/renders/:renderId/:action?";
  return "unmatched";
}

function mutableProjectRegistry(manager: ManimApi) {
  const candidate = manager as Partial<MutableManimProjectApi>;
  if (
    typeof candidate.createManagedProject !== "function" ||
    typeof candidate.createProject !== "function" ||
    typeof candidate.renameProject !== "function" ||
    typeof candidate.unregisterProject !== "function"
  ) {
    throw new HttpError("Workspace registry mutations are not configured.", 405);
  }
  return candidate as MutableManimProjectApi;
}

export function resolveByteRange(
  header: string | undefined,
  size: number,
):
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ end: number; kind: "partial"; start: number }> {
  if (!header) return { kind: "full" };
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return { kind: "invalid" };
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
  const start = suffixLength === null ? Number(match[1]) : Math.max(0, size - suffixLength);
  const end = suffixLength === null && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (suffixLength !== null && (!Number.isInteger(suffixLength) || suffixLength <= 0)) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    return { kind: "invalid" };
  return { end, kind: "partial", start };
}

async function streamVideo(
  request: IncomingMessage,
  response: ServerResponse,
  asset: Awaited<ReturnType<ManimApi["video"]>>,
  signal: AbortSignal,
  idleTimeoutMs: number,
) {
  const idleAbort = new AbortController();
  const streamSignal = AbortSignal.any([signal, idleAbort.signal]);
  let idleTimer: NodeJS.Timeout | null = null;
  const armIdleTimeout = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => idleAbort.abort(new Error("Media stream stalled beyond its idle deadline.")),
      idleTimeoutMs,
    );
    idleTimer.unref();
  };
  try {
    const range = resolveByteRange(request.headers.range, asset.byteSize);
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", asset.mediaType);
    response.setHeader("x-content-type-options", "nosniff");
    if (range.kind === "invalid") {
      response.statusCode = 416;
      response.setHeader("content-range", `bytes */${asset.byteSize}`);
      response.end();
      return;
    }
    const selected = range.kind === "partial" ? { end: range.end, start: range.start } : null;
    response.statusCode = selected ? 206 : 200;
    response.setHeader("content-length", selected ? selected.end - selected.start + 1 : asset.byteSize);
    if (selected) response.setHeader("content-range", `bytes ${selected.start}-${selected.end}/${asset.byteSize}`);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    armIdleTimeout();
    const body = await asset.open(selected, streamSignal);
    const boundedBody = (async function* () {
      for await (const chunk of body) {
        streamSignal.throwIfAborted();
        armIdleTimeout();
        yield chunk;
      }
    })();
    await pipeline(Readable.from(boundedBody), response, { signal: streamSignal });
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    await asset.close();
  }
}

function requireEmptyRenderActionBody(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new HttpError("This render action requires an empty JSON object.", 400);
  }
}

async function runRenderAction(
  manager: ManimApi,
  id: string,
  action: string | undefined,
  body: unknown,
  signal: AbortSignal,
) {
  switch (action) {
    case "abandon": {
      const parsed = renderAbandonRequestSchema.safeParse(body);
      if (!parsed.success) throw new HttpError("The render abandonment request is invalid.", 400);
      return manager.abandon(id, parsed.data.renderRequestId);
    }
    case "cancel": {
      requireEmptyRenderActionBody(body);
      return manager.cancel(id);
    }
    case "commit": {
      const parsed = renderCommitRequestSchema.safeParse(body);
      if (!parsed.success) throw new HttpError("The render commit request is invalid or stale.", 400);
      return manager.commit(id, parsed.data, signal);
    }
    case "cancel-source-action": {
      const parsed = renderSourceActionCancellationRequestSchema.safeParse(body);
      if (!parsed.success) throw new HttpError("The source-action cancellation request is invalid.", 400);
      return manager.cancelSourceAction(id, parsed.data);
    }
    case "discard": {
      requireEmptyRenderActionBody(body);
      return manager.discard(id);
    }
    case "undo": {
      const parsed = renderSourceActionRequestSchema.safeParse(body);
      if (!parsed.success) throw new HttpError("The Undo action request is invalid.", 400);
      return manager.undo(id, parsed.data.actionId, signal);
    }
    default:
      throw new HttpError("Method not allowed.", 405);
  }
}

function sendPythonAttachment(response: ServerResponse, exported: ManimSourceExport) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.headersSent) {
    response.destroy();
    return false;
  }
  response.statusCode = 200;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-disposition", `attachment; filename="${exported.fileName}"`);
  response.setHeader("content-length", Buffer.byteLength(exported.source));
  response.setHeader("content-type", "text/x-python; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-poietra-project-id", exported.projectId);
  response.end(exported.source);
  return true;
}

function sendThumbnailAsset(response: ServerResponse, asset: ThumbnailAsset) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.headersSent) {
    response.destroy();
    return false;
  }
  const body = asset.status === 404 ? Buffer.from(EMPTY_MANIM_THUMBNAIL_SVG, "utf8") : asset.body;
  response.statusCode = asset.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", body.byteLength);
  if (asset.mediaType.startsWith("image/svg+xml")) {
    response.setHeader("content-security-policy", "default-src 'none'; sandbox");
  }
  response.setHeader("content-type", asset.mediaType);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-poietra-thumbnail-kind", asset.kind);
  response.setHeader("x-poietra-thumbnail-state", asset.state);
  response.end(body);
  return true;
}

function sendJsonAndWaitForFinish(response: ServerResponse, status: number, body: unknown) {
  return new Promise<boolean>((resolveDelivery, rejectDelivery) => {
    let settled = false;
    const cleanup = () => {
      response.removeListener("close", onClose);
      response.removeListener("finish", onFinish);
    };
    const settle = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveDelivery(delivered);
    };
    const onClose = () => settle(false);
    const onFinish = () => settle(true);
    response.once("close", onClose);
    response.once("finish", onFinish);
    try {
      if (!sendJson(response, status, body)) settle(false);
    } catch (error) {
      cleanup();
      rejectDelivery(error);
    }
  });
}

async function routeManimRequest(
  manager: ManimApi,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
  policy: ManimRequestPolicy,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE") {
    requireSameOriginJsonMutation(request, policy.expectedMutationOrigin);
  }
  if (url.pathname === "/api/manim/projects") {
    if (request.method === "GET") {
      sendJson(response, 200, await manager.projects(signal));
      return;
    }
    if (request.method !== "POST") throw new HttpError("Method not allowed.", 405);
    const parsed = createManimProjectRequestSchema.safeParse(await readBoundedJsonBody(request, policy));
    if (!parsed.success) throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid workspace registration.", 400);
    if (parsed.data.kind === "existing" && !policy.allowExistingProjectRegistration) {
      throw new HttpError("Existing-folder registration requires the native folder picker.", 403);
    }
    signal.throwIfAborted();
    const registry = mutableProjectRegistry(manager);
    sendJson(
      response,
      201,
      parsed.data.kind === "managed"
        ? await registry.createManagedProject(parsed.data.name, signal)
        : await registry.createProject(parsed.data.name, parsed.data.root, signal),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/manim/workspace") {
    sendJson(response, 200, await manager.workspace(undefined, signal));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/manim/renders") {
    const parsed = programRenderRequestSchema.safeParse(await readBoundedJsonBody(request, policy, 512 * 1024));
    if (!parsed.success) {
      throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid canonical EditProgram render request.", 400);
    }
    const started = await manager.start(parsed.data, signal);
    if (!(await sendJsonAndWaitForFinish(response, 202, started))) {
      await manager.abandonStart(started.id);
      const error = new Error("The render request was disconnected before its response was sent.");
      error.name = "AbortError";
      throw error;
    }
    return;
  }
  const projectItemMatch = url.pathname.match(PROJECT_ITEM_ROUTE);
  if (projectItemMatch) {
    const projectId = projectItemMatch[1]!;
    const registry = mutableProjectRegistry(manager);
    if (request.method === "PATCH") {
      const parsed = renameManimProjectRequestSchema.safeParse(await readBoundedJsonBody(request, policy));
      if (!parsed.success) throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid workspace name.", 400);
      signal.throwIfAborted();
      sendJson(response, 200, await registry.renameProject(projectId, parsed.data.name, signal));
      return;
    }
    if (request.method === "DELETE") {
      signal.throwIfAborted();
      sendJson(response, 200, await registry.unregisterProject(projectId, signal));
      return;
    }
    throw new HttpError("Method not allowed.", 405);
  }
  const sceneSnapshotMatch = url.pathname.match(PROJECT_SCENE_SNAPSHOT_ROUTE);
  if (sceneSnapshotMatch) {
    const projectId = sceneSnapshotMatch[1]!;
    if (request.method === "GET") {
      const parsedQuery = fastManimSnapshotQueryV1Schema.safeParse({
        sceneName: url.searchParams.get("sceneName"),
        sourcePath: url.searchParams.get("sourcePath"),
      });
      if (!parsedQuery.success) {
        throw new HttpError("Scene snapshot lookup requires sourcePath and sceneName query parameters.", 400);
      }
      sendJson(response, 200, await manager.sceneSnapshot(projectId, parsedQuery.data));
      return;
    }
    if (request.method !== "POST") throw new HttpError("Method not allowed.", 405);
    const parsed = fastManimSnapshotRunRequestV1Schema.safeParse(await readBoundedJsonBody(request, policy, 16 * 1024));
    if (!parsed.success) throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid Scene snapshot request.", 400);
    if (parsed.data.projectId !== projectId) {
      throw new HttpError("The request project does not match the project endpoint.", 409);
    }
    sendJson(response, 200, await manager.runSceneSnapshot(parsed.data, signal));
    return;
  }
  const thumbnailMatch = url.pathname.match(PROJECT_THUMBNAIL_ROUTE);
  if (thumbnailMatch) {
    const [, projectId, action] = thumbnailMatch;
    if (!action && request.method === "GET") {
      try {
        sendThumbnailAsset(response, await manager.thumbnail(projectId, signal));
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        sendThumbnailAsset(response, {
          body: Buffer.from("", "utf8"),
          kind: "empty",
          mediaType: "image/svg+xml; charset=utf-8",
          state: "missing",
          status: 404,
        });
      }
      return;
    }
    if (action === "status" && request.method === "GET") {
      sendJson(response, 200, await manager.thumbnailStatus(projectId, signal));
      return;
    }
    if (action === "generate" && request.method === "POST") {
      const parsed = manimThumbnailGenerateRequestSchema.safeParse(await readBoundedJsonBody(request, policy, 1_024));
      if (!parsed.success) throw new HttpError("Thumbnail generation requires an empty JSON object.", 400);
      signal.throwIfAborted();
      sendJson(response, 202, await manager.generateThumbnail(projectId));
      return;
    }
    throw new HttpError("Method not allowed.", 405);
  }
  const projectMatch = url.pathname.match(PROJECT_ROUTE);
  if (projectMatch) {
    const [, projectId, endpoint] = projectMatch;
    if (request.method === "GET" && endpoint === "workspace") {
      sendJson(response, 200, await manager.workspace(projectId, signal));
      return;
    }
    if (request.method !== "POST" || endpoint === "workspace") {
      throw new HttpError("Method not allowed.", 405);
    }
    if (endpoint === "export") {
      const body = await readBoundedJsonBody(request, policy, 512 * 1024);
      const programRequest = programRenderRequestSchema.safeParse(body);
      const originalRequest = originalManimSourceExportRequestSchema.safeParse(body);
      let exported: ManimSourceExport;
      if (programRequest.success) {
        if (programRequest.data.projectId !== projectId) {
          throw new HttpError("The request project does not match the project endpoint.", 409);
        }
        exported = await manager.exportSource(programRequest.data, signal);
      } else {
        if (!originalRequest.success) {
          throw new HttpError(originalRequest.error.issues[0]?.message ?? "Invalid Python export request.", 400);
        }
        if (originalRequest.data.projectId !== projectId) {
          throw new HttpError("The request project does not match the project endpoint.", 409);
        }
        exported = await manager.exportOriginalSource(originalRequest.data, signal);
      }
      sendPythonAttachment(response, exported);
      return;
    }
    const parsed = programRenderRequestSchema.safeParse(await readBoundedJsonBody(request, policy, 512 * 1024));
    if (!parsed.success) {
      throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid canonical EditProgram request.", 400);
    }
    if (parsed.data.projectId !== projectId) {
      throw new HttpError("The request project does not match the project endpoint.", 409);
    }
    const started = await manager.start(parsed.data, signal);
    if (!(await sendJsonAndWaitForFinish(response, 202, started))) {
      await manager.abandonStart(started.id);
      const error = new Error("The render request was disconnected before its response was sent.");
      error.name = "AbortError";
      throw error;
    }
    return;
  }
  const match = url.pathname.match(RENDER_ROUTE);
  if (!match) throw new HttpError("Manim endpoint not found.", 404);
  const [, id, action] = match;
  if (request.method === "GET" && !action) {
    sendJson(response, 200, await manager.view(id));
    return;
  }
  if ((request.method === "GET" || request.method === "HEAD") && action === "video") {
    const idleTimeoutMs = mediaStreamIdleTimeout(policy.mediaStreamIdleTimeoutMs);
    await streamVideo(request, response, await manager.video(id, signal), signal, idleTimeoutMs);
    return;
  }
  if (request.method !== "POST") throw new HttpError("Method not allowed.", 405);
  const body = await readBoundedJsonBody(request, policy, 4 * 1024);
  sendJson(response, 200, await runRenderAction(manager, id, action, body, signal));
}

export async function handleManimRequest(
  context: ManimRequestContext,
  request: IncomingMessage,
  response: ServerResponse,
  baseLogger: StructuredLogger = nullLogger,
  policy: ManimRequestPolicy = DEFAULT_MANIM_REQUEST_POLICY,
) {
  const requestId = randomUUID();
  let logger = baseLogger.child({
    method: request.method,
    requestId,
    route: requestRouteTemplate(request.url),
  });
  response.setHeader("x-poietra-request-id", requestId);
  const requestAbort = new AbortController();
  const abortFromPolicy = () => requestAbort.abort(policy.requestSignal?.reason);
  let responseFinished = false;
  const abortRequest = () => requestAbort.abort();
  const markResponseFinished = () => {
    responseFinished = true;
  };
  const abortOnClosedResponse = () => {
    if (!responseFinished) abortRequest();
  };
  request.once("aborted", abortRequest);
  if (policy.requestSignal?.aborted) abortFromPolicy();
  else policy.requestSignal?.addEventListener("abort", abortFromPolicy, { once: true });
  response.once("close", abortOnClosedResponse);
  response.once("finish", markResponseFinished);
  try {
    const manager = context.tenants.forPrincipal(context.principal);
    logger = logger.child({ tenantId: manager.tenantId });
    logger.info("request.started");
    await routeManimRequest(manager, request, response, requestAbort.signal, policy);
    logger.info("response.sent", { status: response.statusCode });
  } catch (error) {
    if (requestAbort.signal.aborted || (response.destroyed && hasNativeErrorName(error, "AbortError"))) {
      const expectedAbort =
        error === requestAbort.signal.reason ||
        hasNativeErrorName(error, "AbortError") ||
        (error instanceof HttpError && error.message === "Request body was interrupted.");
      const details = { kind: expectedAbort ? "ExpectedAbort" : "AbortCleanupFailure" };
      if (expectedAbort) logger.info("request.aborted", details);
      else logger.error("request.abort_cleanup_failed", details);
      return;
    }
    const ambiguousScene = error instanceof AmbiguousSourceSceneError;
    const expected = error instanceof HttpError || ambiguousScene;
    const status = error instanceof HttpError ? error.status : ambiguousScene ? 409 : 500;
    const message = expected && error instanceof Error ? error.message : "Manim render pipeline failed.";
    const details = {
      kind: error instanceof HttpError ? "HttpError" : ambiguousScene ? "AmbiguousSourceSceneError" : "UnhandledError",
      status,
    };
    if (expected) logger.warn("request.rejected", details);
    else logger.error("request.failed", details);
    if (!sendJson(response, status, { error: message })) {
      logger.warn("response.abandoned", { status });
    }
  } finally {
    request.removeListener("aborted", abortRequest);
    policy.requestSignal?.removeEventListener("abort", abortFromPolicy);
    response.removeListener("close", abortOnClosedResponse);
    response.removeListener("finish", markResponseFinished);
  }
}
