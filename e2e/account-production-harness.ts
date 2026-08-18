import type { IncomingMessage, ServerResponse } from "node:http";
import { request as createHttpRequest, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { calculatePKCECodeChallenge } from "openid-client";
import { Pool } from "pg";
import type { Plugin } from "vite";
import { createAccountInvitationFetchHandlerV1 } from "../server/accounts/account-invitation-fetch";
import { createAccountInvitationServiceV1 } from "../server/accounts/account-invitation-service";
import { createAccountMembershipFetchHandlerV1 } from "../server/accounts/account-membership-fetch";
import { createAccountOrganizationFetchHandlerV1 } from "../server/accounts/account-organization-fetch";
import { createAccountSessionIdentityAuthenticatorV1 } from "../server/accounts/account-session-authenticator";
import {
  createAccountSessionActionFetchHandlerV1,
  createAccountSessionFetchHandlerV1,
} from "../server/accounts/account-session-fetch";
import { createOidcLoginFetchHandlerV1 } from "../server/accounts/oidc-login-fetch";
import { createOidcLoginServiceV1 } from "../server/accounts/oidc-login-service";
import type {
  OidcAccountIdentityV1,
  OidcAuthorizationRequestV1,
  OidcAuthorizationResponseV1,
  OidcIdentityProviderV1,
} from "../server/accounts/openid-client-provider";
import { createOrganizationMembershipProductionAdmissionV1 } from "../server/accounts/organization-membership-admission";
import type { ManimApi } from "../server/manim-api";
import { type ProductionManimServer, startProductionManimServer } from "../server/manim-production-server";
import { isNeutralTenantRouteAlias } from "../server/manim-render-http";
import { applyBundledDurableStorageMigrations } from "../server/storage/postgres/migrate";
import { PostgresAccountInvitationRepositoryV1 } from "../server/storage/postgres/postgres-account-invitation-repository";
import { PostgresAccountOrganizationRepositoryV1 } from "../server/storage/postgres/postgres-account-organization-repository";
import { PostgresAccountSessionRepositoryV1 } from "../server/storage/postgres/postgres-account-session-repository";
import { PostgresEditorDocumentRepositoryV1 } from "../server/storage/postgres/postgres-editor-document-repository";
import { PostgresOidcLoginRepositoryV1 } from "../server/storage/postgres/postgres-oidc-login-repository";
import { PostgresOrganizationMembershipRepositoryV1 } from "../server/storage/postgres/postgres-organization-membership-repository";
import {
  ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1,
  ACCOUNT_E2E_IDENTITY as IDENTITY,
  ACCOUNT_E2E_IMPORTED_SCENE as IMPORTED_SCENE,
  ACCOUNT_E2E_INVITED_IDENTITY as INVITED_IDENTITY,
  ACCOUNT_E2E_INVITED_USER_ID as INVITED_USER_ID,
  ACCOUNT_E2E_MISMATCH_IDENTITY as MISMATCH_IDENTITY,
  ACCOUNT_E2E_PROJECT_ID as PROJECT_ID,
  ACCOUNT_E2E_SCENE_NAME as SCENE_NAME,
  ACCOUNT_E2E_SOURCE as SOURCE,
  ACCOUNT_E2E_SOURCE_PATH as SOURCE_PATH,
  ACCOUNT_E2E_STUDIO_ORGANIZATION_ID as STUDIO_ORGANIZATION_ID,
} from "./account-production-fixture";

const SOURCE_HASH = ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1.sourceHash;
const THUMBNAIL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type ManimRequestEvidence = Readonly<{
  method: string;
  organizationHeader: string | null;
  pathname: string;
}>;

class FakeOidcProvider implements OidcIdentityProviderV1 {
  private readonly authorizationRequests = new Map<string, OidcAuthorizationRequestV1>();
  private readonly codes = new Map<string, Readonly<{ identity: OidcAccountIdentityV1; state: string }>>();
  private nextCode = 0;

  constructor(private readonly publicOrigin: string) {}

  authorizationUrl(input: OidcAuthorizationRequestV1) {
    this.authorizationRequests.set(input.state, input);
    const url = new URL("/__e2e/oidc/authorize", this.publicOrigin);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("state", input.state);
    return Promise.resolve(url);
  }

  authorize(url: URL) {
    const state = url.searchParams.get("state");
    const request = state ? this.authorizationRequests.get(state) : null;
    const identity =
      url.searchParams.get("identity") === "owner"
        ? IDENTITY
        : url.searchParams.get("identity") === "invited"
          ? INVITED_IDENTITY
          : url.searchParams.get("identity") === "mismatch"
            ? MISMATCH_IDENTITY
            : null;
    if (
      !state ||
      !request ||
      !identity ||
      request.codeChallenge !== url.searchParams.get("code_challenge") ||
      request.nonce !== url.searchParams.get("nonce")
    ) {
      return null;
    }
    const code = `account-e2e-code-${++this.nextCode}`;
    this.codes.set(code, { identity, state });
    return { code, state };
  }

  pending(url: URL) {
    const state = url.searchParams.get("state");
    const request = state ? this.authorizationRequests.get(state) : null;
    return Boolean(
      state &&
        request &&
        request.codeChallenge === url.searchParams.get("code_challenge") &&
        request.nonce === url.searchParams.get("nonce"),
    );
  }

  async exchange(input: OidcAuthorizationResponseV1) {
    const code = input.callbackUrl.searchParams.get("code");
    const request = this.authorizationRequests.get(input.expectedState);
    const evidence = code ? this.codes.get(code) : null;
    if (
      !code ||
      !request ||
      evidence?.state !== input.expectedState ||
      request.nonce !== input.expectedNonce ||
      request.codeChallenge !== (await calculatePKCECodeChallenge(input.codeVerifier))
    ) {
      throw new Error("OIDC authorization evidence did not match.");
    }
    this.codes.delete(code);
    this.authorizationRequests.delete(input.expectedState);
    return evidence.identity;
  }
}

function deterministicRandomBytes() {
  let generation = 0;
  return (size: number) => {
    generation += 1;
    return Uint8Array.from({ length: size }, (_, index) => (generation * 31 + index * 17) & 0xff);
  };
}

function escapedHtmlAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function identitySelectionUrl(url: URL, identity: "invited" | "mismatch" | "owner") {
  const selected = new URL(url);
  selected.searchParams.set("identity", identity);
  return escapedHtmlAttribute(`${selected.pathname}${selected.search}`);
}

function fakeOidcIdentitySelection(url: URL) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Test identity</title></head>
<body><main><h1>Choose a test identity</h1>
<a href="${identitySelectionUrl(url, "owner")}">Continue as Ada Lovelace</a>
<a href="${identitySelectionUrl(url, "invited")}">Continue as invited member</a>
<a href="${identitySelectionUrl(url, "mismatch")}">Continue with mismatched email</a>
</main></body></html>`;
}

function runtimeApi(): ManimApi {
  return {
    exportOriginalSource: async () => ({ fileName: SOURCE_PATH, projectId: PROJECT_ID, source: SOURCE }),
    exportSource: async () => ({ fileName: SOURCE_PATH, projectId: PROJECT_ID, source: SOURCE }),
    projects: async () => ({
      defaultProjectId: PROJECT_ID,
      projects: [{ id: PROJECT_ID, kind: "managed", name: "Production Demo" }],
    }),
    storageBoundary: { kind: "shared-durable", namespace: "account-production-e2e" },
    tenantId: STUDIO_ORGANIZATION_ID,
    thumbnail: async () => ({
      body: THUMBNAIL,
      kind: "rendered",
      mediaType: "image/png",
      state: "current",
      status: 200,
    }),
    thumbnailStatus: async () => ({
      cachedSourceHash: SOURCE_HASH,
      error: null,
      generatedAt: "2026-08-01T00:00:00.000Z",
      imageKind: "rendered",
      projectId: PROJECT_ID,
      sceneName: SCENE_NAME,
      sourceHash: SOURCE_HASH,
      sourcePath: SOURCE_PATH,
      state: "current",
    }),
    workspace: async (projectId = PROJECT_ID) => {
      if (projectId !== PROJECT_ID) throw new TypeError("The account E2E workspace identity is unavailable.");
      return {
        commandAvailable: false,
        frame: { height: 8, width: 14.222 },
        projectId: PROJECT_ID,
        projectName: "Production Demo",
        renderCapability: {
          available: false,
          kind: "durable-sandbox",
          unavailableReason: "durable-render-unconfigured",
        },
        sources: [
          {
            path: SOURCE_PATH,
            scenes: [
              {
                anchors: IMPORTED_SCENE.anchors,
                name: IMPORTED_SCENE.name,
                nextSceneId: null,
                runtimeSceneState: IMPORTED_SCENE.runtimeSceneState,
                sceneId: IMPORTED_SCENE.sceneId,
                sourceHash: IMPORTED_SCENE.sourceHash,
                sourceVariables: IMPORTED_SCENE.sourceVariables,
                staticSemanticState: IMPORTED_SCENE.staticSemanticState,
              },
            ],
          },
        ],
      };
    },
  } as unknown as ManimApi;
}

async function availablePort() {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function requestHeaders(request: IncomingMessage) {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!;
    // Vite serves the HTTPS harness over HTTP/2, whose compatibility request
    // exposes pseudo-headers that the Fetch Headers API correctly rejects.
    if (!name.startsWith(":")) headers.append(name, request.rawHeaders[index + 1]!);
  }
  return headers;
}

function fetchRequest(request: IncomingMessage, publicOrigin: string) {
  const method = request.method ?? "GET";
  const contentLength = Number(request.headers["content-length"] ?? 0);
  const hasBody =
    method !== "GET" && method !== "HEAD" && (contentLength > 0 || request.headers["transfer-encoding"] !== undefined);
  return new Request(new URL(request.url ?? "/", publicOrigin), {
    ...(hasBody ? { body: Readable.toWeb(request), duplex: "half" } : {}),
    headers: requestHeaders(request),
    method,
  } as RequestInit & { duplex?: "half" });
}

function http1RequestHeaders(request: IncomingMessage) {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!name.startsWith(":") && name !== "connection" && value !== undefined) headers[name] = value;
  }
  return headers;
}

async function sendFetchResponse(response: Response, target: ServerResponse) {
  target.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") target.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) target.setHeader("set-cookie", cookies);
  target.end(Buffer.from(await response.arrayBuffer()));
}

function proxyManimRequest(
  request: IncomingMessage,
  response: ServerResponse,
  server: ProductionManimServer,
  publicOrigin: string,
) {
  const headers = { ...http1RequestHeaders(request), host: new URL(publicOrigin).host };
  const proxy = createHttpRequest(
    {
      headers,
      host: server.address.address,
      method: request.method,
      path: request.url,
      port: server.address.port,
    },
    (proxied) => {
      const responseHeaders = { ...proxied.headers };
      delete responseHeaders.connection;
      delete responseHeaders["keep-alive"];
      delete responseHeaders["transfer-encoding"];
      response.writeHead(proxied.statusCode ?? 500, responseHeaders);
      proxied.pipe(response);
    },
  );
  proxy.once("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Account E2E proxy failed: ${error.name}`);
  });
  request.pipe(proxy);
}

export function accountProductionHarnessPlugin(publicOrigin: string, databaseUrl: string): Plugin {
  return {
    name: "poietra-account-production-e2e",
    apply: "serve",
    async configurePreviewServer(preview) {
      const migrationPool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await applyBundledDurableStorageMigrations(migrationPool);
      } finally {
        await migrationPool.end();
      }
      const provider = new FakeOidcProvider(publicOrigin);
      const oidcRepository = new PostgresOidcLoginRepositoryV1({
        poolConfig: { connectionString: databaseUrl, max: 4 },
      });
      const accountSessions = new PostgresAccountSessionRepositoryV1({
        poolConfig: { connectionString: databaseUrl, max: 4 },
      });
      const invitationRepository = new PostgresAccountInvitationRepositoryV1({
        poolConfig: { connectionString: databaseUrl, max: 4 },
      });
      const organizationRepository = new PostgresAccountOrganizationRepositoryV1({
        poolConfig: { connectionString: databaseUrl, max: 4 },
      });
      const membershipRepository = new PostgresOrganizationMembershipRepositoryV1({
        poolConfig: { connectionString: databaseUrl, max: 4 },
      });
      const evidencePool = new Pool({ connectionString: databaseUrl, max: 2 });
      const loginService = createOidcLoginServiceV1({
        loginAttemptLifetimeMs: 60_000,
        provider,
        randomBytes: deterministicRandomBytes(),
        randomUuid: () => INVITED_USER_ID,
        repository: oidcRepository,
        sessionLifetimeMs: 60_000,
      });
      const invitationService = createAccountInvitationServiceV1(invitationRepository);
      const loginHandler = createOidcLoginFetchHandlerV1(loginService, publicOrigin);
      const invitationHandler = createAccountInvitationFetchHandlerV1(invitationService, publicOrigin);
      const membershipHandler = createAccountMembershipFetchHandlerV1(accountSessions, publicOrigin);
      const organizationHandler = createAccountOrganizationFetchHandlerV1(organizationRepository, publicOrigin);
      const sessionHandler = createAccountSessionFetchHandlerV1(accountSessions, publicOrigin);
      const actionHandler = createAccountSessionActionFetchHandlerV1(accountSessions, publicOrigin);
      const editorDocuments = new PostgresEditorDocumentRepositoryV1({
        poolConfig: { connectionString: databaseUrl, max: 4 },
      });
      const productionServer = await startProductionManimServer({
        admission: createOrganizationMembershipProductionAdmissionV1({
          identities: createAccountSessionIdentityAuthenticatorV1(accountSessions),
          memberships: membershipRepository,
        }),
        config: {
          deployment: "production",
          host: "127.0.0.1",
          port: await availablePort(),
          publicOrigin,
        },
        runtime: {
          api: runtimeApi(),
          close: () => editorDocuments.close(),
          editorDocuments,
          editorReady: async (signal) => editorDocuments.ready(signal),
          ready: async () => ({
            executionBoundary: "adapter-attests-external-sandbox",
            ready: true,
            storageBoundary: "shared-durable",
            tenantBoundary: "server-owned-tenant-key",
          }),
          renderReady: async () => true,
          workspaceReady: async () => true,
        },
      });
      const manimEvidence: ManimRequestEvidence[] = [];

      preview.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", publicOrigin);
        void (async () => {
          if (url.pathname === "/__e2e/oidc/authorize") {
            if (!url.searchParams.has("identity")) {
              if (!provider.pending(url)) {
                response.writeHead(400).end();
                return;
              }
              response.writeHead(200, {
                "cache-control": "no-store",
                "content-type": "text/html; charset=utf-8",
                "referrer-policy": "no-referrer",
              });
              response.end(fakeOidcIdentitySelection(url));
              return;
            }
            const authorized = provider.authorize(url);
            if (!authorized) {
              response.writeHead(400).end();
              return;
            }
            const callback = new URL("/auth/oidc/callback", publicOrigin);
            callback.searchParams.set("code", authorized.code);
            callback.searchParams.set("state", authorized.state);
            response.writeHead(302, { location: callback.href }).end();
            return;
          }
          if (url.pathname === "/__e2e/account/metrics") {
            const sessions = await evidencePool.query<{ count: string }>(
              `SELECT count(*)::text AS count
                 FROM public.account_sessions
                WHERE revoked_at IS NULL AND expires_at > clock_timestamp()`,
            );
            response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
            response.end(
              JSON.stringify({
                activeSessionCount: Number(sessions.rows[0]?.count ?? "0"),
                manimRequests: manimEvidence,
              }),
            );
            return;
          }
          if (url.pathname.startsWith("/auth/oidc/")) {
            await sendFetchResponse(await loginHandler.fetch(fetchRequest(request, publicOrigin)), response);
            return;
          }
          if (url.pathname === "/api/account/session" || url.pathname === "/api/account/logout") {
            const handler = request.method === "GET" ? sessionHandler : actionHandler;
            await sendFetchResponse(await handler.fetch(fetchRequest(request, publicOrigin)), response);
            return;
          }
          if (url.pathname === "/api/account/invitations") {
            await sendFetchResponse(await invitationHandler.fetch(fetchRequest(request, publicOrigin)), response);
            return;
          }
          if (url.pathname === "/api/account/members" || url.pathname.startsWith("/api/account/members/")) {
            await sendFetchResponse(await membershipHandler.fetch(fetchRequest(request, publicOrigin)), response);
            return;
          }
          if (url.pathname === "/api/account/organizations") {
            await sendFetchResponse(await organizationHandler.fetch(fetchRequest(request, publicOrigin)), response);
            return;
          }
          if (
            url.pathname.startsWith("/api/manim/") ||
            url.pathname.startsWith("/api/editor/") ||
            isNeutralTenantRouteAlias(url.pathname)
          ) {
            manimEvidence.push({
              method: request.method ?? "GET",
              organizationHeader:
                typeof request.headers["x-poietra-organization-id"] === "string"
                  ? request.headers["x-poietra-organization-id"]
                  : null,
              pathname: url.pathname,
            });
            proxyManimRequest(request, response, productionServer, publicOrigin);
            return;
          }
          next();
        })().catch((error: unknown) => {
          if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.name : "HarnessError" }));
        });
      });

      preview.httpServer?.once("close", () => {
        void Promise.allSettled([
          loginService.close(),
          invitationService.close(),
          organizationRepository.close(),
          productionServer.close(),
          evidencePool.end(),
        ]);
      });
    },
  };
}
