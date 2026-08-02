import type { IncomingMessage, ServerResponse } from "node:http";
import { request as createHttpRequest, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { calculatePKCECodeChallenge } from "openid-client";
import { Pool } from "pg";
import type { Plugin } from "vite";
import { createAccountSessionIdentityAuthenticatorV1 } from "../server/accounts/account-session-authenticator";
import {
  createAccountSessionActionFetchHandlerV1,
  createAccountSessionFetchHandlerV1,
} from "../server/accounts/account-session-fetch";
import type {
  AccountSessionControlRepositoryV1,
  ResolvedAccountSessionAccountV1,
  ResolvedAccountSessionV1,
} from "../server/accounts/account-session-repository";
import { createOidcLoginFetchHandlerV1 } from "../server/accounts/oidc-login-fetch";
import type {
  ConsumedOidcLoginAttemptV1,
  CreateOidcLoginAttemptV1,
  IssueAccountSessionV1,
  IssueInvitedAccountSessionV1,
  OidcLoginRepositoryV1,
} from "../server/accounts/oidc-login-repository";
import { createOidcLoginServiceV1 } from "../server/accounts/oidc-login-service";
import type {
  OidcAuthorizationRequestV1,
  OidcAuthorizationResponseV1,
  OidcIdentityProviderV1,
} from "../server/accounts/openid-client-provider";
import { createOrganizationMembershipProductionAdmissionV1 } from "../server/accounts/organization-membership-admission";
import type {
  ExternalAccountIdentityV1,
  OrganizationMembershipRepositoryV1,
} from "../server/accounts/organization-membership-repository";
import type { ManimApi } from "../server/manim-api";
import { type ProductionManimServer, startProductionManimServer } from "../server/manim-production-server";
import { applyBundledDurableStorageMigrations } from "../server/storage/postgres/migrate";
import { PostgresEditorDocumentRepositoryV1 } from "../server/storage/postgres/postgres-editor-document-repository";
import {
  ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1,
  ACCOUNT_E2E_BILLING_ORGANIZATION_ID as BILLING_ORGANIZATION_ID,
  ACCOUNT_E2E_IDENTITY as IDENTITY,
  ACCOUNT_E2E_IMPORTED_SCENE as IMPORTED_SCENE,
  ACCOUNT_E2E_PROJECT_ID as PROJECT_ID,
  ACCOUNT_E2E_SCENE_NAME as SCENE_NAME,
  ACCOUNT_E2E_SOURCE as SOURCE,
  ACCOUNT_E2E_SOURCE_PATH as SOURCE_PATH,
  ACCOUNT_E2E_STUDIO_ORGANIZATION_ID as STUDIO_ORGANIZATION_ID,
  ACCOUNT_E2E_USER_ID as USER_ID,
} from "./account-production-fixture";

const SOURCE_HASH = ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1.sourceHash;
const ORGANIZATIONS = Object.freeze([
  Object.freeze({ displayName: "Billing Team", id: BILLING_ORGANIZATION_ID, role: "billing" as const }),
  Object.freeze({ displayName: "Studio Team", id: STUDIO_ORGANIZATION_ID, role: "member" as const }),
]);
const THUMBNAIL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type LoginAttempt = Readonly<{
  browserBindingHash: string;
  codeVerifier: string;
  expiresAt: Date;
  invitationTokenDigest: Uint8Array | null;
  nonce: string;
}>;

type BrowserSession = {
  activeOrganizationId: string;
  expiresAt: Date;
  identity: ExternalAccountIdentityV1;
  version: number;
};

type ManimRequestEvidence = Readonly<{
  method: string;
  organizationHeader: string | null;
  pathname: string;
}>;

function digestKey(value: Uint8Array) {
  return Buffer.from(value).toString("hex");
}

function sameIdentity(identity: ExternalAccountIdentityV1) {
  return identity.issuer === IDENTITY.issuer && identity.subject === IDENTITY.subject;
}

class AccountMemoryAuthority implements OidcLoginRepositoryV1, AccountSessionControlRepositoryV1 {
  readonly attempts = new Map<string, LoginAttempt>();
  readonly sessions = new Map<string, BrowserSession>();

  close() {
    return Promise.resolve();
  }

  consumeLoginAttempt(
    selector: Readonly<{ browserBindingHash: Uint8Array; stateHash: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<ConsumedOidcLoginAttemptV1 | null> {
    signal?.throwIfAborted();
    const stateHash = digestKey(selector.stateHash);
    const attempt = this.attempts.get(stateHash);
    if (!attempt || attempt.browserBindingHash !== digestKey(selector.browserBindingHash)) {
      return Promise.resolve(null);
    }
    this.attempts.delete(stateHash);
    if (attempt.expiresAt.getTime() <= Date.now()) return Promise.resolve(null);
    return Promise.resolve({
      codeVerifier: attempt.codeVerifier,
      invitationTokenDigest: attempt.invitationTokenDigest,
      nonce: attempt.nonce,
    });
  }

  createLoginAttempt(input: CreateOidcLoginAttemptV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const expiresAt = new Date(Date.now() + input.lifetimeMs);
    this.attempts.set(digestKey(input.stateHash), {
      browserBindingHash: digestKey(input.browserBindingHash),
      codeVerifier: input.codeVerifier,
      expiresAt,
      invitationTokenDigest: input.invitationTokenDigest ?? null,
      nonce: input.nonce,
    });
    return Promise.resolve({ expiresAt });
  }

  issueAccountSession(input: IssueAccountSessionV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!sameIdentity(input.identity)) return Promise.resolve(null);
    const expiresAt = new Date(Date.now() + input.lifetimeMs);
    this.sessions.set(digestKey(input.sessionTokenHash), {
      activeOrganizationId: BILLING_ORGANIZATION_ID,
      expiresAt,
      identity: input.identity,
      version: 1,
    });
    return Promise.resolve({ expiresAt });
  }

  issueInvitedAccountSession(_input: IssueInvitedAccountSessionV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return Promise.resolve(null);
  }

  ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    return Promise.resolve(true);
  }

  resolveAccountSession(sessionTokenHash: Uint8Array, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const session = this.activeSession(sessionTokenHash);
    return Promise.resolve(session ? this.account(session.activeOrganizationId, session.version) : null);
  }

  resolveActiveSession(sessionTokenHash: Uint8Array, signal?: AbortSignal): Promise<ResolvedAccountSessionV1 | null> {
    signal?.throwIfAborted();
    const session = this.activeSession(sessionTokenHash);
    return Promise.resolve(
      session ? { ...session.identity, sessionOrganizationId: session.activeOrganizationId } : null,
    );
  }

  revokeAccountSession(sessionTokenHash: Uint8Array, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.sessions.delete(digestKey(sessionTokenHash));
    return Promise.resolve();
  }

  switchActiveOrganization(
    sessionTokenHash: Uint8Array,
    organizationId: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const session = this.activeSession(sessionTokenHash);
    if (!session) return Promise.resolve({ kind: "invalid-session" } as const);
    if (!ORGANIZATIONS.some((organization) => organization.id === organizationId)) {
      return Promise.resolve({ kind: "organization-unavailable" } as const);
    }
    if (session.activeOrganizationId === organizationId) {
      return Promise.resolve({ account: this.account(organizationId, session.version), kind: "updated" } as const);
    }
    if (session.version !== expectedVersion) return Promise.resolve({ kind: "conflict" } as const);
    session.activeOrganizationId = organizationId;
    session.version += 1;
    return Promise.resolve({ account: this.account(organizationId, session.version), kind: "updated" } as const);
  }

  private account(activeOrganizationId: string, version: number): ResolvedAccountSessionAccountV1 {
    return {
      activeOrganizationId,
      organizations: ORGANIZATIONS,
      user: { displayName: "Ada Lovelace", id: USER_ID },
      version,
    };
  }

  private activeSession(sessionTokenHash: Uint8Array) {
    const key = digestKey(sessionTokenHash);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }
}

class FakeOidcProvider implements OidcIdentityProviderV1 {
  private readonly authorizationRequests = new Map<string, OidcAuthorizationRequestV1>();
  private readonly codes = new Map<string, string>();
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
    if (
      !state ||
      !request ||
      request.codeChallenge !== url.searchParams.get("code_challenge") ||
      request.nonce !== url.searchParams.get("nonce")
    ) {
      return null;
    }
    const code = `account-e2e-code-${++this.nextCode}`;
    this.codes.set(code, state);
    return { code, state };
  }

  async exchange(input: OidcAuthorizationResponseV1) {
    const code = input.callbackUrl.searchParams.get("code");
    const request = this.authorizationRequests.get(input.expectedState);
    const state = code ? this.codes.get(code) : null;
    if (
      !code ||
      !request ||
      state !== input.expectedState ||
      request.nonce !== input.expectedNonce ||
      request.codeChallenge !== (await calculatePKCECodeChallenge(input.codeVerifier))
    ) {
      throw new Error("OIDC authorization evidence did not match.");
    }
    this.codes.delete(code);
    this.authorizationRequests.delete(input.expectedState);
    return IDENTITY;
  }
}

function deterministicRandomBytes() {
  let generation = 0;
  return (size: number) => {
    generation += 1;
    return Uint8Array.from({ length: size }, (_, index) => (generation * 31 + index * 17) & 0xff);
  };
}

function memberships(): OrganizationMembershipRepositoryV1 {
  return {
    close: async () => undefined,
    ready: async (signal) => {
      signal?.throwIfAborted();
      return true;
    },
    resolveActiveMembership: async (identity, organizationId, signal) => {
      signal?.throwIfAborted();
      if (!sameIdentity(identity)) return null;
      const organization = ORGANIZATIONS.find((candidate) => candidate.id === organizationId);
      return organization ? { organizationId, role: organization.role, userId: USER_ID, version: 1n } : null;
    },
  };
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
      const authority = new AccountMemoryAuthority();
      const provider = new FakeOidcProvider(publicOrigin);
      const loginService = createOidcLoginServiceV1({
        loginAttemptLifetimeMs: 60_000,
        provider,
        randomBytes: deterministicRandomBytes(),
        repository: authority,
        sessionLifetimeMs: 60_000,
      });
      const loginHandler = createOidcLoginFetchHandlerV1(loginService, publicOrigin);
      const sessionHandler = createAccountSessionFetchHandlerV1(authority, publicOrigin);
      const actionHandler = createAccountSessionActionFetchHandlerV1(authority, publicOrigin);
      const editorDocuments = new PostgresEditorDocumentRepositoryV1({
        poolConfig: { connectionString: databaseUrl, max: 4 },
      });
      const productionServer = await startProductionManimServer({
        admission: createOrganizationMembershipProductionAdmissionV1({
          identities: createAccountSessionIdentityAuthenticatorV1(authority),
          memberships: memberships(),
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
            response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
            response.end(JSON.stringify({ activeSessionCount: authority.sessions.size, manimRequests: manimEvidence }));
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
          if (url.pathname.startsWith("/api/manim/") || url.pathname.startsWith("/api/editor/")) {
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
        void Promise.allSettled([loginService.close(), productionServer.close()]);
      });
    },
  };
}
