import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isNativeError, isProxy } from "node:util/types";

import { parseVerifiedSceneIrBundleV1, sceneIrSourceRevisionHash } from "../src/engine/contracts";
import {
  browserManimProjectImportRequestV1Schema,
  createManimProjectRequestSchema,
  MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1,
  type ManimSourceExport,
  manimThumbnailGenerateRequestSchema,
  originalManimSourceExportRequestSchema,
  programRenderRequestSchema,
  RENDER_SESSION_CONTRACT_VERSION_HEADER,
  RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
  RENDER_SESSION_CONTRACT_VERSION_WITH_FAILURE_CODE,
  type RenderSessionView,
  type RenderSourceActionCancellationView,
  renameManimProjectRequestSchema,
  renderAbandonRequestSchema,
  renderCommitRequestSchema,
  renderSourceActionCancellationRequestSchema,
  renderSourceActionRequestSchema,
  studioNativeManimSourceExportRequestSchema,
} from "../src/render-pipeline/contracts";
import {
  FAST_MANIM_RUNTIME_TRACE_RUN_RESPONSE_ENVELOPE_BYTES_V2,
  type FastManimRuntimeTraceRunRequestV1,
  type FastManimRuntimeTraceRunViewV2,
  fastManimRuntimeTraceRunRequestV1Schema,
  fastManimRuntimeTraceRunViewSchema,
} from "../src/render-pipeline/runtime-trace-preview-contract";
import { canonicalFastManimRuntimeTraceSampleTimeV3 } from "../src/render-pipeline/runtime-trace-v3-shared-contract";
import { AmbiguousSourceSceneError } from "../src/render-pipeline/source-import";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";
import {
  createFastManimRuntimeTraceConfigV3,
  digestFastManimRuntimeTraceConfigV3,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
  fastManimRuntimeTraceSourceBindingV3Schema,
} from "./fast-manim-runtime-trace-v3-contract";
import { digestFastManimRuntimeTraceIdentityV3 } from "./fast-manim-runtime-trace-v3-lowering";
import {
  digestFastManimRuntimeTraceSourceBindingsV3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V3,
} from "./fast-manim-runtime-trace-v3-result-contract";
import { fastManimSnapshotQueryV1Schema, fastManimSnapshotRunRequestV1Schema } from "./fast-manim-snapshot-contract";
import { fastManimSourceBindingIdentifierV1 } from "./fast-manim-source-runtime-identity";
import { HttpError, readJsonBody, sendJson } from "./http/json";
import { streamHttpMediaV1 } from "./http/media-stream";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import type { BrowserManimProjectImportApiV1, ManimApi, MutableManimProjectApi } from "./manim-api";
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
const PROJECT_RUNTIME_TRACE_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})\/runtime-traces$/;
const PROJECT_SCENE_SNAPSHOT_ASSET_ROUTE =
  /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})\/scene-snapshot-assets\/([0-9a-f]{64})$/;
const PROJECT_ITEM_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})$/;
const BROWSER_PROJECT_IMPORT_ROUTE = "/api/manim/project-imports";

/**
 * Neutral tenant route aliases (#712, ADR 0005 §"API and compatibility
 * policy"): the storage-generic tenant surfaces are ALSO mounted under
 * neutral `/api/` routes. Both route families dispatch through the one
 * canonical matching layer below, so a neutral request and its legacy
 * `/api/manim/` twin reach the same handler with identical behavior, and the
 * legacy family stays byte-identical until a later versioned cutover removes
 * the aliases.
 *
 * Only the generic surfaces are aliased: project catalog CRUD
 * (`/api/projects`, `/api/projects/:projectId`), per-project workspace read,
 * thumbnails, and digest-addressed Scene snapshot assets. Browser project
 * import, render-session and render-start routes, Python source export,
 * Runtime Trace runs, and Scene snapshot runs/lookups remain exclusively
 * under the Manim namespace.
 */
const NEUTRAL_TENANT_ROUTE_ALIAS =
  /^\/api\/projects(?:\/[a-z][a-z0-9_-]{0,63}(?:\/(?:workspace|thumbnail(?:\/(?:status|generate))?|scene-snapshot-assets\/[0-9a-f]{64}))?)?$/;

export function isNeutralTenantRouteAlias(pathname: string) {
  return NEUTRAL_TENANT_ROUTE_ALIAS.test(pathname);
}

/**
 * Maps a neutral tenant route alias onto its canonical legacy pathname so a
 * single route-matching layer recognizes both prefixes. Every other pathname
 * — including every legacy `/api/manim/*` pathname — is returned unchanged,
 * which keeps the legacy family byte-identical.
 */
export function canonicalManimRoutePathname(pathname: string) {
  return isNeutralTenantRouteAlias(pathname) ? `/api/manim${pathname.slice("/api".length)}` : pathname;
}

export function isManimWorkspaceBootstrapRequest(method: string | undefined, pathname: string) {
  if (method !== "GET") return false;
  const canonical = canonicalManimRoutePathname(pathname);
  if (canonical === "/api/manim/projects" || canonical === "/api/manim/workspace") return true;
  return PROJECT_ROUTE.exec(canonical)?.[2] === "workspace";
}

export function isManimBrowserProjectImportRequest(method: string | undefined, pathname: string) {
  return method === "POST" && canonicalManimRoutePathname(pathname) === BROWSER_PROJECT_IMPORT_ROUTE;
}
const DEFAULT_MEDIA_STREAM_IDLE_TIMEOUT_MS = 30_000;
const MAX_MEDIA_STREAM_IDLE_TIMEOUT_MS = 120_000;

export { resolveByteRange } from "./http/media-stream";
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

// Render-session routes have no neutral alias (frozen legacy lane), so
// canonicalization is a structural no-op for the two render predicates; they
// still read through the shared layer so every admission predicate agrees on
// one route-matching authority.
export function isManimVideoRequest(method: string | undefined, pathname: string) {
  const match = canonicalManimRoutePathname(pathname).match(RENDER_ROUTE);
  return (method === "GET" || method === "HEAD") && match?.[2] === "video";
}

export function isManimRenderStartRequest(method: string | undefined, pathname: string) {
  const canonical = canonicalManimRoutePathname(pathname);
  if (method === "POST" && canonical === "/api/manim/renders") return true;
  return method === "POST" && PROJECT_ROUTE.exec(canonical)?.[2] === "renders";
}

/**
 * TenantCell storage lane (ADR 0005 §"Tenant Cell decision"): project catalog
 * mutations, thumbnail reads, and digest-addressed Scene snapshot PNG reads
 * are served entirely by durable storage, so production admission gates them
 * on storage/tenant readiness alone. Workspace bootstrap and browser import
 * keep their dedicated workspace gate; render starts, Scene snapshot runs and
 * lookups, Runtime Trace runs, source exports, and render-session routes keep
 * their execution-inclusive gates.
 *
 * Adding a route here requires extending the per-route dependency mapping in
 * `DurableManimRuntimeV1.tenantCellStorageReady`, which probes exactly the
 * storage dependencies these routes use.
 *
 * Storage-lane routes are exactly the aliased generic surfaces, so a neutral
 * alias classifies identically to its legacy twin via canonicalization.
 */
export function isTenantCellStorageLaneManimRequest(method: string | undefined, pathname: string) {
  const canonical = canonicalManimRoutePathname(pathname);
  if (method === "POST" && canonical === "/api/manim/projects") return true;
  if ((method === "PATCH" || method === "DELETE") && PROJECT_ITEM_ROUTE.test(canonical)) return true;
  const thumbnail = PROJECT_THUMBNAIL_ROUTE.exec(canonical);
  if (thumbnail) {
    if (thumbnail[2] === undefined || thumbnail[2] === "status") return method === "GET";
    return method === "POST";
  }
  return (method === "GET" || method === "HEAD") && PROJECT_SCENE_SNAPSHOT_ASSET_ROUTE.test(canonical);
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

function manimRouteTemplate(pathname: string) {
  if (
    pathname === "/api/manim/projects" ||
    pathname === "/api/manim/workspace" ||
    pathname === BROWSER_PROJECT_IMPORT_ROUTE
  )
    return pathname;
  if (PROJECT_SCENE_SNAPSHOT_ROUTE.test(pathname)) return "/api/manim/projects/:projectId/scene-snapshots";
  if (PROJECT_RUNTIME_TRACE_ROUTE.test(pathname)) return "/api/manim/projects/:projectId/runtime-traces";
  if (PROJECT_SCENE_SNAPSHOT_ASSET_ROUTE.test(pathname)) {
    return "/api/manim/projects/:projectId/scene-snapshot-assets/:digest";
  }
  if (PROJECT_THUMBNAIL_ROUTE.test(pathname)) return "/api/manim/projects/:projectId/thumbnail/:action?";
  if (PROJECT_ROUTE.test(pathname)) return "/api/manim/projects/:projectId/:action";
  if (PROJECT_ITEM_ROUTE.test(pathname)) return "/api/manim/projects/:projectId";
  if (RENDER_ROUTE.test(pathname)) return "/api/manim/renders/:renderId/:action?";
  return "unmatched";
}

function requestRouteTemplate(rawUrl: string | undefined) {
  let pathname: string;
  try {
    pathname = new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "invalid";
  }
  const canonical = canonicalManimRoutePathname(pathname);
  const template = manimRouteTemplate(canonical);
  if (canonical === pathname) return template;
  // A neutral alias logs its own route family so alias adoption and legacy
  // drain stay observable. "workspace" is the only PROJECT_ROUTE action with
  // a neutral alias, so its shared :action template names it exactly.
  if (template === "/api/manim/projects/:projectId/:action") return "/api/projects/:projectId/workspace";
  return template.replace("/api/manim/", "/api/");
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

function browserProjectImporter(manager: ManimApi) {
  const candidate = manager as Partial<BrowserManimProjectImportApiV1>;
  if (typeof candidate.importBrowserProject !== "function") {
    throw new HttpError("Browser project import is not configured.", 405);
  }
  return candidate as BrowserManimProjectImportApiV1;
}

function requireEmptyRenderActionBody(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new HttpError("This render action requires an empty JSON object.", 400);
  }
}

type RenderSessionContractVersion = "legacy" | "v2" | "v3";

function renderSessionContractVersion(request: IncomingMessage): RenderSessionContractVersion {
  const version = request.headers[RENDER_SESSION_CONTRACT_VERSION_HEADER];
  if (version === RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT) return "v3";
  if (version === RENDER_SESSION_CONTRACT_VERSION_WITH_FAILURE_CODE) return "v2";
  return "legacy";
}

function renderSessionHttpView(session: RenderSessionView, version: RenderSessionContractVersion) {
  if (version === "v3" || (version === "v2" && session.failureCode !== "cpu-limit")) return session;
  if (version === "v2") return { ...session, failureCode: "render-failed" as const };
  const { failureCode: _failureCode, ...legacySession } = session;
  return legacySession;
}

function renderSourceActionCancellationHttpView(
  view: RenderSourceActionCancellationView,
  version: RenderSessionContractVersion,
) {
  return {
    ...view,
    session: renderSessionHttpView(view.session, version),
  };
}

async function runRenderAction(
  manager: ManimApi,
  id: string,
  action: string | undefined,
  body: unknown,
  signal: AbortSignal,
  renderSessionVersion: RenderSessionContractVersion,
) {
  switch (action) {
    case "abandon": {
      const parsed = renderAbandonRequestSchema.safeParse(body);
      if (!parsed.success) throw new HttpError("The render abandonment request is invalid.", 400);
      return manager.abandon(id, parsed.data.renderRequestId);
    }
    case "cancel": {
      requireEmptyRenderActionBody(body);
      return renderSessionHttpView(await manager.cancel(id), renderSessionVersion);
    }
    case "commit": {
      const parsed = renderCommitRequestSchema.safeParse(body);
      if (!parsed.success) throw new HttpError("The render commit request is invalid or stale.", 400);
      return renderSessionHttpView(await manager.commit(id, parsed.data, signal), renderSessionVersion);
    }
    case "cancel-source-action": {
      const parsed = renderSourceActionCancellationRequestSchema.safeParse(body);
      if (!parsed.success) throw new HttpError("The source-action cancellation request is invalid.", 400);
      return renderSourceActionCancellationHttpView(
        await manager.cancelSourceAction(id, parsed.data),
        renderSessionVersion,
      );
    }
    case "discard": {
      requireEmptyRenderActionBody(body);
      return renderSessionHttpView(await manager.discard(id), renderSessionVersion);
    }
    case "undo": {
      const parsed = renderSourceActionRequestSchema.safeParse(body);
      if (!parsed.success) throw new HttpError("The Undo action request is invalid.", 400);
      return renderSessionHttpView(await manager.undo(id, parsed.data.actionId, signal), renderSessionVersion);
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

function sendSceneSnapshotAsset(
  request: IncomingMessage,
  response: ServerResponse,
  asset: Awaited<ReturnType<NonNullable<ManimApi["sceneSnapshotAsset"]>>>,
) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.headersSent) {
    response.destroy();
    return false;
  }
  response.statusCode = 200;
  response.setHeader("cache-control", "private, max-age=31536000, immutable");
  response.setHeader("content-length", asset.body.byteLength);
  response.setHeader("content-type", asset.mediaType);
  response.setHeader("etag", `"sha256:${asset.digest}"`);
  response.setHeader("x-content-type-options", "nosniff");
  response.end(request.method === "HEAD" ? undefined : asset.body);
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

function runtimeTraceV3EndpointMatchesLifetime(
  endpoint: FastManimRuntimeTraceRunViewV2["roots"][number]["evidence"]["endpoints"]["initial"],
  lifetimeBoundary: number,
  boundary: "start" | "end",
) {
  const boundaryFrameIndex = endpoint.frameIndex + (boundary === "end" ? 1 : 0);
  return (
    endpoint.sampleTime === canonicalFastManimRuntimeTraceSampleTimeV3(endpoint.frameIndex) &&
    lifetimeBoundary === boundaryFrameIndex / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3
  );
}

function verifyRuntimeTraceV3AuthorityEnvelope(
  run: FastManimRuntimeTraceRunViewV2,
  request: FastManimRuntimeTraceRunRequestV1,
  entities: ReadonlyMap<string, Awaited<ReturnType<typeof parseVerifiedSceneIrBundleV1>>["scene"]["entities"][number]>,
) {
  const bindingIds = new Set<string>();
  const bindingNames = new Set<string>();
  const rootIds = new Set<string>();
  let priorBindingOrdinal = 0;
  for (const root of run.roots) {
    const entity = entities.get(root.entityId);
    const binding = fastManimRuntimeTraceSourceBindingV3Schema.safeParse(root.binding);
    const initialLifetime = entity?.lifetimes[0];
    const terminalLifetime = entity?.lifetimes.at(-1);
    const { initial, terminal } = root.evidence.endpoints;
    if (
      !binding.success ||
      binding.data.id !== fastManimSourceBindingIdentifierV1(request.sourceHash, run.sceneId, binding.data) ||
      bindingIds.has(binding.data.id) ||
      bindingNames.has(binding.data.name) ||
      binding.data.ordinal <= priorBindingOrdinal ||
      rootIds.has(root.entityId) ||
      !entity ||
      entity.parentId !== null ||
      entity.geometry.kind !== "group" ||
      !initialLifetime ||
      !terminalLifetime ||
      !runtimeTraceV3EndpointMatchesLifetime(initial, initialLifetime.start, "start") ||
      !runtimeTraceV3EndpointMatchesLifetime(terminal, terminalLifetime.end, "end")
    ) {
      throw new HttpError("The Runtime Trace operation returned invalid source authority evidence.", 502);
    }
    bindingIds.add(binding.data.id);
    bindingNames.add(binding.data.name);
    priorBindingOrdinal = binding.data.ordinal;
    rootIds.add(root.entityId);
  }

  const sourceBindings = run.roots.map(({ binding, entityId, evidence }) => ({
    binding,
    endpoints: evidence.endpoints,
    rootId: entityId,
    updaterStatus: evidence.updaterStatus,
  }));
  const correlationSha256 = digestFastManimRuntimeTraceSourceBindingsV3(
    request.sourceHash,
    run.sceneId,
    sourceBindings,
  );
  if (
    run.producerEvidence.correlationSha256 !== correlationSha256 ||
    run.traceDigest !==
      digestFastManimRuntimeTraceIdentityV3({
        correlationSha256,
        runtimeConfigHash: run.runtimeConfigHash,
        sceneId: run.sceneId,
        semanticsSha256: run.producerEvidence.semanticsSha256,
        sourceHash: run.sourceHash,
      })
  ) {
    throw new HttpError("The Runtime Trace operation returned stale source authority evidence.", 502);
  }
}

async function verifiedRuntimeTraceHttpView(value: unknown, request: FastManimRuntimeTraceRunRequestV1) {
  const parsed = fastManimRuntimeTraceRunViewSchema.safeParse(value);
  if (!parsed.success) throw new HttpError("The Runtime Trace operation returned an invalid response.", 502);
  const run = parsed.data;
  const sceneId = fastManimRuntimeTraceSceneIdV1(request.sourcePath, request.sceneName);
  if (
    run.projectId !== request.projectId ||
    run.requestId !== request.requestId ||
    run.sceneId !== sceneId ||
    run.sceneName !== request.sceneName ||
    run.sourceHash !== request.sourceHash ||
    run.sourcePath !== request.sourcePath
  ) {
    throw new HttpError("The Runtime Trace operation returned stale correlation.", 502);
  }

  let maxResponseBytes = FAST_MANIM_RUNTIME_TRACE_RUN_RESPONSE_ENVELOPE_BYTES_V2;
  let safeView: typeof run = run;
  if (run.status === "verified") {
    let bundle;
    try {
      bundle = await parseVerifiedSceneIrBundleV1(run.bundle);
    } catch {
      throw new HttpError("The Runtime Trace operation returned an invalid Scene IR bundle.", 502);
    }
    const source = bundle.scene.source;
    if (
      bundle.scene.sceneId !== sceneId ||
      source.kind !== "imported-manim-runtime-trace" ||
      source.sourceHash !== request.sourceHash ||
      source.runtimeConfigHash !== run.runtimeConfigHash ||
      source.traceDigest !== run.traceDigest ||
      sceneIrSourceRevisionHash(bundle.scene) !== run.traceDigest ||
      bundle.assets.assets.length !== 0
    ) {
      throw new HttpError("The Runtime Trace operation returned stale Scene IR evidence.", 502);
    }
    const entities = new Map(bundle.scene.entities.map((entity) => [entity.id, entity]));
    if (run.version !== 2 || source.traceVersion !== 3) {
      throw new HttpError("The Runtime Trace operation returned a legacy preview response.", 502);
    }
    const expectedRuntimeConfigHash = digestFastManimRuntimeTraceConfigV3(
      createFastManimRuntimeTraceConfigV3({
        height: bundle.scene.camera.view.frameHeight,
        width: bundle.scene.camera.view.frameWidth,
      }),
    );
    if (
      run.runtimeConfigHash !== expectedRuntimeConfigHash ||
      !bundle.scene.entities.some((entity) => entity.parentId === null && entity.geometry.kind === "group")
    ) {
      throw new HttpError("The Runtime Trace operation returned invalid preview-only evidence.", 502);
    }
    verifyRuntimeTraceV3AuthorityEnvelope(run, request, entities);
    maxResponseBytes =
      MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V3 + FAST_MANIM_RUNTIME_TRACE_RUN_RESPONSE_ENVELOPE_BYTES_V2;
    safeView = { ...run, bundle };
  }
  if (Buffer.byteLength(JSON.stringify(safeView), "utf8") > maxResponseBytes) {
    throw new HttpError("The Runtime Trace operation response is too large.", 502);
  }
  return safeView;
}

async function routeManimRequest(
  manager: ManimApi,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
  policy: ManimRequestPolicy,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  // One route-matching layer recognizes both families: a neutral tenant alias
  // is folded onto its canonical legacy pathname before any route matching,
  // so both prefixes reach identical handlers (#712).
  const pathname = canonicalManimRoutePathname(url.pathname);
  const renderSessionVersion = renderSessionContractVersion(request);
  if (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE") {
    requireSameOriginJsonMutation(request, policy.expectedMutationOrigin);
  }
  if (pathname === BROWSER_PROJECT_IMPORT_ROUTE) {
    if (request.method !== "POST") throw new HttpError("Method not allowed.", 405);
    const parsed = browserManimProjectImportRequestV1Schema.safeParse(
      await readBoundedJsonBody(request, policy, MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1),
    );
    if (!parsed.success) throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid project import.", 400);
    signal.throwIfAborted();
    sendJson(response, 201, await browserProjectImporter(manager).importBrowserProject(parsed.data, signal));
    return;
  }
  if (pathname === "/api/manim/projects") {
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
    if (parsed.data.kind === "studio-native") {
      const createNativeStudioProject = registry.createNativeStudioProject?.bind(registry);
      if (!createNativeStudioProject) {
        throw new HttpError("Studio-native projects are not supported by this project registry.", 403);
      }
      sendJson(response, 201, await createNativeStudioProject(parsed.data.name, signal));
      return;
    }
    sendJson(
      response,
      201,
      parsed.data.kind === "managed"
        ? await registry.createManagedProject(parsed.data.name, signal)
        : await registry.createProject(parsed.data.name, parsed.data.root, signal),
    );
    return;
  }
  if (request.method === "GET" && pathname === "/api/manim/workspace") {
    sendJson(response, 200, await manager.workspace(undefined, signal));
    return;
  }
  if (request.method === "POST" && pathname === "/api/manim/renders") {
    const parsed = programRenderRequestSchema.safeParse(await readBoundedJsonBody(request, policy, 512 * 1024));
    if (!parsed.success) {
      throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid canonical EditProgram render request.", 400);
    }
    const started = await manager.start(parsed.data, signal);
    if (!(await sendJsonAndWaitForFinish(response, 202, renderSessionHttpView(started, renderSessionVersion)))) {
      await manager.abandonStart(started.id);
      const error = new Error("The render request was disconnected before its response was sent.");
      error.name = "AbortError";
      throw error;
    }
    return;
  }
  const projectItemMatch = pathname.match(PROJECT_ITEM_ROUTE);
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
  const sceneSnapshotMatch = pathname.match(PROJECT_SCENE_SNAPSHOT_ROUTE);
  if (sceneSnapshotMatch) {
    const projectId = sceneSnapshotMatch[1]!;
    if (request.method === "GET") {
      const parsedQuery = fastManimSnapshotQueryV1Schema.safeParse({
        ...(url.searchParams.get("runtimeConfigHash") === null
          ? {}
          : { runtimeConfigHash: url.searchParams.get("runtimeConfigHash") }),
        sceneName: url.searchParams.get("sceneName"),
        sourcePath: url.searchParams.get("sourcePath"),
      });
      if (!parsedQuery.success) {
        throw new HttpError(
          "Scene snapshot lookup requires sourcePath and sceneName plus an optional valid runtimeConfigHash.",
          400,
        );
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
    const snapshot = await manager.runSceneSnapshot(parsed.data, signal);
    if (!(await sendJsonAndWaitForFinish(response, 200, snapshot))) {
      const error = new Error("The Scene snapshot request was disconnected before its response was sent.");
      error.name = "AbortError";
      throw error;
    }
    return;
  }
  const runtimeTraceMatch = pathname.match(PROJECT_RUNTIME_TRACE_ROUTE);
  if (runtimeTraceMatch) {
    if (request.method !== "POST") throw new HttpError("Method not allowed.", 405);
    if (!manager.runRuntimeTrace) throw new HttpError("Runtime Trace preview is not configured.", 501);
    const projectId = runtimeTraceMatch[1]!;
    const parsed = fastManimRuntimeTraceRunRequestV1Schema.safeParse(
      await readBoundedJsonBody(request, policy, 16 * 1024),
    );
    if (!parsed.success) throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid Runtime Trace request.", 400);
    if (parsed.data.projectId !== projectId) {
      throw new HttpError("The request project does not match the project endpoint.", 409);
    }
    const trace = await verifiedRuntimeTraceHttpView(await manager.runRuntimeTrace(parsed.data, signal), parsed.data);
    if (!(await sendJsonAndWaitForFinish(response, 200, trace))) {
      const error = new Error("The Runtime Trace request was disconnected before its response was sent.");
      error.name = "AbortError";
      throw error;
    }
    return;
  }
  const sceneSnapshotAssetMatch = pathname.match(PROJECT_SCENE_SNAPSHOT_ASSET_ROUTE);
  if (sceneSnapshotAssetMatch) {
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError("Method not allowed.", 405);
    if (!manager.sceneSnapshotAsset) throw new HttpError("Scene snapshot assets are not configured.", 404);
    const [, projectId, digest] = sceneSnapshotAssetMatch;
    sendSceneSnapshotAsset(request, response, await manager.sceneSnapshotAsset(projectId!, digest!, signal));
    return;
  }
  const thumbnailMatch = pathname.match(PROJECT_THUMBNAIL_ROUTE);
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
  const projectMatch = pathname.match(PROJECT_ROUTE);
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
      const studioNativeRequest = studioNativeManimSourceExportRequestSchema.safeParse(body);
      const programRequest = programRenderRequestSchema.safeParse(body);
      const originalRequest = originalManimSourceExportRequestSchema.safeParse(body);
      let exported: ManimSourceExport;
      if (studioNativeRequest.success) {
        if (studioNativeRequest.data.projectId !== projectId) {
          throw new HttpError("The request project does not match the project endpoint.", 409);
        }
        if (!manager.exportStudioNativeSource) {
          throw new HttpError("Studio-native Manim source export is unavailable on this deployment.", 501);
        }
        exported = await manager.exportStudioNativeSource(studioNativeRequest.data, signal);
      } else if (programRequest.success) {
        if (programRequest.data.projectId !== projectId) {
          throw new HttpError("The request project does not match the project endpoint.", 409);
        }
        exported = await manager.exportSource(programRequest.data, signal);
      } else {
        if (!originalRequest.success) {
          const studioNativeIntent =
            typeof body === "object" && body !== null && "kind" in body && body.kind === "studio-native";
          const issue = studioNativeIntent ? studioNativeRequest.error?.issues[0] : originalRequest.error.issues[0];
          throw new HttpError(issue?.message ?? "Invalid Python export request.", 400);
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
    if (!(await sendJsonAndWaitForFinish(response, 202, renderSessionHttpView(started, renderSessionVersion)))) {
      await manager.abandonStart(started.id);
      const error = new Error("The render request was disconnected before its response was sent.");
      error.name = "AbortError";
      throw error;
    }
    return;
  }
  const match = pathname.match(RENDER_ROUTE);
  if (!match) throw new HttpError("Manim endpoint not found.", 404);
  const [, id, action] = match;
  if (request.method === "GET" && !action) {
    sendJson(response, 200, renderSessionHttpView(await manager.view(id), renderSessionVersion));
    return;
  }
  if ((request.method === "GET" || request.method === "HEAD") && action === "video") {
    const idleTimeoutMs = mediaStreamIdleTimeout(policy.mediaStreamIdleTimeoutMs);
    await streamHttpMediaV1(request, response, await manager.video(id, signal), signal, idleTimeoutMs);
    return;
  }
  if (request.method !== "POST") throw new HttpError("Method not allowed.", 405);
  const body = await readBoundedJsonBody(request, policy, 4 * 1024);
  sendJson(response, 200, await runRenderAction(manager, id, action, body, signal, renderSessionVersion));
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
