import { createServer as createHttpServer, request as createRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1 } from "../src/render-pipeline/contracts";
import { fastManimSnapshotSceneIdV1 } from "./fast-manim-snapshot-contract";
import { HttpError } from "./http/json";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import {
  ACCOUNT_SESSION_COOKIE_NAME_V1,
  BoundedProductionManimRuntimeCellResolverV1,
  createAccountSessionIdentityAuthenticatorV1,
  createOrganizationMembershipProductionAdmissionV1,
  type ProductionManimServer,
  type ProductionRequestAdmission,
  parseProductionManimServerConfig,
  startProductionManimServer,
} from "./manim-production-server";
import type { ManimApi } from "./manim-render-http";
import { request as renderRequest } from "./manim-render-pipeline-test-fixtures";
import {
  canonicalEditorSessionSnapshotV1,
  createEditorDocumentKeyV1,
  type EditorDocumentRepositoryV1,
} from "./storage/editor-document-repository";

const servers: ProductionManimServer[] = [];
const TEST_PRINCIPAL = Object.freeze({ subjectId: "production-user", tenantId: "tenant-a" });

function editSuggestionBody() {
  return {
    clarification: {
      answer: { kind: "text", text: "SECRET_CLARIFICATION" },
      history: [],
      options: [],
      question: "SECRET_CLARIFICATION_QUESTION",
    },
    objects: [],
    playhead: 0,
    prompt: "SECRET_PROMPT_SOURCE_ENV_API_KEY_TRACEBACK",
    scene: { id: "SECRET_SOURCE_PATH.py#Scene", name: "Scene", nextSceneId: null },
    sceneDuration: 1,
    selectedObjectIds: [],
  };
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

function config(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    deployment: "production",
    host: "127.0.0.1",
    port: 4_175,
    publicOrigin: "https://studio.example",
    ...overrides,
  };
}

async function availablePort() {
  const server = createHttpServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return port;
}

async function startConfig(overrides: Readonly<Record<string, unknown>> = {}) {
  return config({ port: await availablePort(), ...overrides });
}

function createRuntime(
  ready: () => boolean = () => true,
  onProjects: () => void = () => {},
  workspaceReady: () => boolean = () => true,
  renderReady: () => boolean = ready,
) {
  const api = {
    cancel() {
      throw new HttpError("Render session not found.", 404);
    },
    projects() {
      onProjects();
      return { defaultProjectId: null, projects: [] };
    },
    storageBoundary: { kind: "shared-durable", namespace: "production-test" },
    tenantId: "tenant-a",
  } as unknown as ManimApi;
  return {
    api,
    close: async () => {},
    ready: async () =>
      ready()
        ? ({
            executionBoundary: "adapter-attests-external-sandbox",
            ready: true,
            storageBoundary: "shared-durable",
            tenantBoundary: "server-owned-tenant-key",
          } as const)
        : ({ ready: false } as const),
    renderReady: async () => renderReady(),
    workspaceReady: async () => workspaceReady(),
  } as const;
}

function send(
  server: ProductionManimServer,
  path: string,
  options: Readonly<{
    body?: string;
    chunked?: boolean;
    headers?: Readonly<Record<string, string | string[]>>;
    method?: string;
  }> = {},
) {
  return new Promise<Readonly<{ body: string; headers: NodeJS.Dict<string | string[]>; status: number }>>(
    (resolveResponse, rejectResponse) => {
      const body = options.body ?? "";
      const request = createRequest(
        {
          headers: {
            connection: "close",
            host: new URL(server.config.publicOrigin).host,
            ...(body && !options.chunked ? { "content-length": Buffer.byteLength(body) } : {}),
            ...(options.chunked ? { "transfer-encoding": "chunked" } : {}),
            ...options.headers,
          },
          host: server.address.address,
          method: options.method ?? "GET",
          path,
          port: server.address.port,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () => {
            resolveResponse({
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers,
              status: response.statusCode ?? 0,
            });
          });
        },
      );
      request.once("error", rejectResponse);
      request.end(body);
    },
  );
}

describe("production Manim server configuration", () => {
  it("normalizes a strict production-only config with bounded defaults", () => {
    const parsed = parseProductionManimServerConfig(config({ trustedProxyAddresses: ["127.0.0.1", "127.0.0.1"] }));

    expect(parsed.publicOrigin).toBe("https://studio.example");
    expect(parsed.trustedProxyAddresses).toEqual(["127.0.0.1"]);
    expect(parsed.limits).toMatchObject({
      maxBodyBytes: MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1,
      maxConnections: 256,
      maxHeaderBytes: 16 * 1024,
      requestDrainTimeoutMs: 10_000,
      runtimeCloseTimeoutMs: 45_000,
    });
  });

  it.each([
    [{ ...config(), deployment: "development" }, /production/i],
    [{ ...config(), host: "localhost" }, /explicit IP/i],
    [{ ...config(), port: 0 }, />=1/],
    [{ ...config(), publicOrigin: "http://studio.example" }, /HTTPS/i],
    [{ ...config(), publicOrigin: "http://127.evil.example" }, /HTTPS/i],
    [{ ...config(), publicOrigin: "https://studio.example/api" }, /scheme, host/i],
    [{ ...config(), trustedProxyAddresses: ["10.0.0.0/8"] }, /explicit IP/i],
    [{ ...config(), unknown: true }, /unrecognized/i],
    [
      {
        ...config(),
        limits: { headersTimeoutMs: 2_000, requestTimeoutMs: 1_000 },
      },
      /headersTimeoutMs/i,
    ],
  ])("rejects invalid or development-only input %#", (input, message) => {
    expect(() => parseProductionManimServerConfig(input)).toThrow(message);
  });
});

describe("standalone production Manim HTTP adapter", () => {
  it("resolves the selected organization through active membership before entering its tenant cell", async () => {
    const resolveActiveMembership = vi.fn(async (_identity: unknown, organizationId: string) =>
      organizationId === "tenant-a"
        ? {
            organizationId,
            role: "member" as const,
            userId: "00000000-0000-4000-8000-000000000001",
            version: 1n,
          }
        : null,
    );
    const server = await startProductionManimServer({
      admission: createOrganizationMembershipProductionAdmissionV1({
        identities: {
          authenticate: async () => ({ issuer: "https://identity.example", subject: "external-user" }),
          ready: async () => true,
        },
        memberships: {
          close: async () => undefined,
          ready: async () => true,
          resolveActiveMembership,
        },
      }),
      config: await startConfig(),
      runtime: createRuntime(),
    });
    servers.push(server);

    expect(
      await send(server, "/api/manim/projects", {
        headers: { authorization: "Bearer verified", "x-poietra-organization-id": "tenant-a" },
      }),
    ).toMatchObject({ status: 200 });
    expect(
      await send(server, "/api/manim/projects", {
        headers: { authorization: "Bearer verified", "x-poietra-organization-id": "tenant-b" },
      }),
    ).toMatchObject({ status: 403 });
    expect(resolveActiveMembership).toHaveBeenCalledWith(
      { issuer: "https://identity.example", subject: "external-user" },
      "tenant-a",
      expect.any(AbortSignal),
    );
  });

  it("routes two authorized Organizations through server-owned runtime assignments without a restart", async () => {
    const order: string[] = [];
    const assignments = new Map<string, unknown>([
      ["tenant-a", { cellId: "cell-a", generation: 1, state: "active", tenantId: "tenant-a" }],
    ]);
    const provisioned = new Map<string, ReturnType<typeof createRuntime>>();
    const runtimeResolver = new BoundedProductionManimRuntimeCellResolverV1({
      assignments: {
        ready: async () => true,
        resolve: async (tenantId) => {
          order.push(`cell:${tenantId}`);
          return assignments.get(tenantId) ?? null;
        },
      },
      maxCells: 2,
      provisioner: {
        provision: async ({ tenantId }) => {
          order.push(`provision:${tenantId}`);
          const base = createRuntime();
          const selected = {
            ...base,
            api: {
              ...base.api,
              projects: async () => ({
                defaultProjectId: `${tenantId}-project`,
                projects: [{ id: `${tenantId}-project`, kind: "managed", name: tenantId }],
              }),
              tenantId,
              workspace: async (projectId?: string) => {
                if (projectId !== undefined && projectId !== `${tenantId}-project`) {
                  throw new HttpError("Project not found.", 404);
                }
                return { projectId: `${tenantId}-project`, projectName: tenantId, sources: [] };
              },
            } as unknown as ManimApi,
          };
          provisioned.set(tenantId, selected);
          return selected;
        },
      },
    });
    const server = await startProductionManimServer({
      admission: createOrganizationMembershipProductionAdmissionV1({
        identities: {
          authenticate: async ({ credentials }) => {
            const subject = credentials.authorization?.replace("Bearer ", "");
            return subject === "user-a" || subject === "user-b" || subject === "user-c"
              ? { issuer: "https://identity.example", subject }
              : null;
          },
          ready: async () => true,
        },
        memberships: {
          close: async () => undefined,
          ready: async () => true,
          resolveActiveMembership: async ({ subject }, organizationId) => {
            order.push(`membership:${organizationId}`);
            const expected = `tenant-${subject.slice(-1)}`;
            return organizationId === expected
              ? {
                  organizationId,
                  role: "member" as const,
                  userId: `00000000-0000-4000-8000-00000000000${subject.slice(-1).charCodeAt(0) - 96}`,
                  version: 1n,
                }
              : null;
          },
        },
      }),
      config: await startConfig(),
      runtimeResolver,
    });
    servers.push(server);

    const tenantA = await send(server, "/api/manim/projects?runtimeCell=cell-b", {
      headers: {
        authorization: "Bearer user-a",
        "x-poietra-organization-id": "tenant-a",
        "x-poietra-runtime-cell": "cell-b",
      },
    });
    expect(tenantA.status).toBe(200);
    expect(JSON.parse(tenantA.body).defaultProjectId).toBe("tenant-a-project");
    expect(order.indexOf("membership:tenant-a")).toBeLessThan(order.indexOf("cell:tenant-a"));

    assignments.set("tenant-b", { cellId: "cell-b", generation: 1, state: "active", tenantId: "tenant-b" });
    const [tenantAConcurrent, tenantB] = await Promise.all([
      send(server, "/api/manim/projects", {
        headers: { authorization: "Bearer user-a", "x-poietra-organization-id": "tenant-a" },
      }),
      send(server, "/api/manim/projects", {
        headers: { authorization: "Bearer user-b", "x-poietra-organization-id": "tenant-b" },
      }),
    ]);
    expect(JSON.parse(tenantAConcurrent.body).defaultProjectId).toBe("tenant-a-project");
    expect(JSON.parse(tenantB.body).defaultProjectId).toBe("tenant-b-project");
    expect(provisioned.size).toBe(2);

    const crossTenantProject = await send(server, "/api/manim/projects/tenant-b-project/workspace", {
      headers: { authorization: "Bearer user-a", "x-poietra-organization-id": "tenant-a" },
    });
    expect(crossTenantProject.status).toBe(404);

    const missingAssignment = await send(server, "/api/manim/projects", {
      headers: { authorization: "Bearer user-c", "x-poietra-organization-id": "tenant-c" },
    });
    expect(missingAssignment.status).toBe(503);
    expect(JSON.parse(missingAssignment.body)).toEqual({ error: "Tenant access is temporarily unavailable." });

    const forgedMembership = await send(server, "/api/manim/projects", {
      headers: { authorization: "Bearer user-a", "x-poietra-organization-id": "tenant-b" },
    });
    expect(forgedMembership.status).toBe(403);
  });

  it("admits a browser-native cookie request through its verified session organization", async () => {
    const resolveActiveMembership = vi.fn(async (_identity: unknown, organizationId: string) => ({
      organizationId,
      role: "member" as const,
      userId: "00000000-0000-4000-8000-000000000001",
      version: 1n,
    }));
    const sessionToken = Buffer.alloc(32, 7).toString("base64url");
    const resolveActiveSession = vi.fn(async () => ({
      issuer: "https://identity.example",
      sessionOrganizationId: "tenant-a",
      subject: "external-user",
    }));
    const server = await startProductionManimServer({
      admission: createOrganizationMembershipProductionAdmissionV1({
        identities: createAccountSessionIdentityAuthenticatorV1({
          close: async () => undefined,
          ready: async () => true,
          resolveActiveSession,
        }),
        memberships: {
          close: async () => undefined,
          ready: async () => true,
          resolveActiveMembership,
        },
      }),
      config: await startConfig(),
      runtime: createRuntime(),
    });
    servers.push(server);

    expect(
      await send(server, "/api/manim/projects", {
        headers: { cookie: `${ACCOUNT_SESSION_COOKIE_NAME_V1}=${sessionToken}` },
      }),
    ).toMatchObject({ status: 200 });
    expect(resolveActiveSession).toHaveBeenCalledOnce();
    expect(resolveActiveMembership).toHaveBeenCalledWith(
      { issuer: "https://identity.example", subject: "external-user" },
      "tenant-a",
      expect.any(AbortSignal),
    );
  });

  it("normalizes the organization selector at the transport without judging its bytes", async () => {
    const authenticate = vi.fn<ProductionRequestAdmission["authenticate"]>(async () => TEST_PRINCIPAL);
    const server = await startProductionManimServer({
      admission: { authenticate, ready: async () => true },
      config: await startConfig(),
      runtime: createRuntime(),
    });
    servers.push(server);

    const conflicting = await send(server, "/api/manim/projects", {
      headers: { authorization: "Bearer verified", "x-poietra-organization-id": ["tenant-a", "tenant-b"] },
    });
    expect(conflicting.status).toBe(400);
    expect(JSON.parse(conflicting.body)).toEqual({ error: "The organization selector must be a single header value." });
    expect(authenticate).not.toHaveBeenCalled();

    const malformed = "A".repeat(65);
    expect(
      await send(server, "/api/manim/projects", {
        headers: { authorization: "Bearer verified", "x-poietra-organization-id": malformed },
      }),
    ).toMatchObject({ status: 200 });
    expect(authenticate).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestedOrganizationId: malformed }),
      expect.any(AbortSignal),
    );

    expect(await send(server, "/api/manim/projects", { headers: { authorization: "Bearer verified" } })).toMatchObject({
      status: 200,
    });
    expect(authenticate.mock.calls.at(-1)?.[0]).not.toHaveProperty("requestedOrganizationId");
  });

  it("rejects an incomplete production runtime adapter before listening", async () => {
    await expect(
      startProductionManimServer({
        admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
        config: await startConfig(),
        runtime: { ...createRuntime(), ready: undefined } as never,
      }),
    ).rejects.toThrow(/runtime adapter is incomplete/i);
  });

  it("requires exactly one pinned runtime or dynamic runtime resolver", async () => {
    const runtime = createRuntime();
    const runtimeResolver = {
      acquire: async () => ({ release: () => undefined, runtime }),
      close: async () => undefined,
      ready: async () => true,
    };
    await expect(
      startProductionManimServer({
        admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
        config: await startConfig(),
      }),
    ).rejects.toThrow(/exactly one runtime/i);
    await expect(
      startProductionManimServer({
        admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
        config: await startConfig(),
        runtime,
        runtimeResolver,
      }),
    ).rejects.toThrow(/exactly one runtime/i);
  });

  it("fails closed when a custom resolver returns a runtime for another tenant", async () => {
    const release = vi.fn();
    const foreignRuntime = createRuntime();
    const server = await startProductionManimServer({
      admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
      config: await startConfig(),
      runtimeResolver: {
        acquire: async () => ({
          release,
          runtime: {
            ...foreignRuntime,
            api: { ...foreignRuntime.api, tenantId: "tenant-b" } as unknown as ManimApi,
          },
        }),
        close: async () => undefined,
        ready: async () => true,
      },
    });
    servers.push(server);

    const response = await send(server, "/api/manim/projects");
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "Tenant access is temporarily unavailable." });
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects an editor adapter that omits the private-session methods before listening", async () => {
    await expect(
      startProductionManimServer({
        admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
        config: await startConfig(),
        runtime: {
          ...createRuntime(),
          editorDocuments: {
            commitMutation: async () => ({ kind: "conflict", reason: "not-found" }),
            openDocument: async () => ({ kind: "not-found" }),
            readEventTail: async () => null,
          },
          editorReady: async () => true,
        } as never,
      }),
    ).rejects.toThrow(/editor document adapter is incomplete/i);
  });

  it("rejects a runtime without a tenant-keyed durable storage namespace", async () => {
    const runtime = createRuntime();
    await expect(
      startProductionManimServer({
        admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
        config: await startConfig(),
        runtime: {
          ...runtime,
          api: { ...runtime.api, storageBoundary: undefined } as unknown as ManimApi,
        },
      }),
    ).rejects.toThrow(/shared durable boundary/i);
  });

  it.each(["studio-local", "local-000000000000000000000000"])(
    "rejects the reserved production runtime tenant %s before listening",
    async (tenantId) => {
      const runtime = createRuntime();
      await expect(
        startProductionManimServer({
          admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
          config: await startConfig(),
          runtime: {
            ...runtime,
            api: { ...runtime.api, tenantId } as unknown as ManimApi,
          },
        }),
      ).rejects.toThrow(/reserved local identity/i);
    },
  );

  it("keeps liveness public while readiness reflects every dependency and admission fail-closes APIs", async () => {
    let admissionReady = false;
    let runtimeReady = true;
    let authenticateCalls = 0;
    const server = await startProductionManimServer({
      admission: {
        authenticate: async () => {
          authenticateCalls += 1;
          return TEST_PRINCIPAL;
        },
        ready: async () => admissionReady,
      },
      config: await startConfig(),
      runtime: createRuntime(
        () => runtimeReady,
        () => undefined,
        () => runtimeReady,
      ),
    });
    servers.push(server);

    expect(await send(server, "/healthz")).toMatchObject({ status: 200 });
    expect(JSON.parse((await send(server, "/readyz")).body)).toEqual({ status: "unavailable" });
    expect(await send(server, "/api/manim/projects")).toMatchObject({ status: 503 });
    expect(authenticateCalls).toBe(0);

    admissionReady = true;
    runtimeReady = false;
    expect(await send(server, "/readyz")).toMatchObject({ status: 503 });
    runtimeReady = true;
    expect(await send(server, "/readyz")).toMatchObject({ status: 200 });
    expect(await send(server, "/api/manim/projects")).toMatchObject({ status: 200 });
    expect(authenticateCalls).toBe(1);
  });

  it("keeps authenticated workspace bootstrap and source import available during a render outage", async () => {
    const fullReadiness = vi.fn(async () => ({ ready: false }) as const);
    const renderReadiness = vi.fn(async () => false);
    let workspaceAvailable = true;
    const workspaceReadiness = vi.fn(async () => workspaceAvailable);
    const projects = vi.fn(async () => ({ defaultProjectId: "project-a", projects: [] }));
    const workspace = vi.fn(async () => ({
      commandAvailable: false,
      frame: { height: 8, width: 14.222 },
      projectId: "project-a",
      projectName: "Project A",
      renderCapability: {
        available: false,
        kind: "durable-sandbox",
        unavailableReason: "durable-render-unavailable",
      },
      sources: [],
    }));
    const start = vi.fn();
    const importBrowserProject = vi.fn(async () => ({
      catalog: {
        defaultProjectId: "project-imported",
        projects: [{ id: "project-imported", kind: "managed" as const, name: "Imported" }],
      },
      project: { id: "project-imported", kind: "managed" as const, name: "Imported" },
    }));
    const baseRuntime = createRuntime(() => false);
    const server = await startProductionManimServer({
      admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
      config: await startConfig(),
      runtime: {
        ...baseRuntime,
        api: { ...baseRuntime.api, importBrowserProject, projects, start, workspace } as unknown as ManimApi,
        ready: fullReadiness,
        renderReady: renderReadiness,
        workspaceReady: workspaceReadiness,
      },
    });
    servers.push(server);

    expect(await send(server, "/readyz")).toMatchObject({ status: 200 });
    expect(await send(server, "/api/manim/projects")).toMatchObject({ status: 200 });
    expect(await send(server, "/api/manim/workspace")).toMatchObject({ status: 200 });
    const scoped = await send(server, "/api/manim/projects/project-a/workspace");
    expect(scoped).toMatchObject({ status: 200 });
    expect(JSON.parse(scoped.body).renderCapability).toEqual({
      available: false,
      kind: "durable-sandbox",
      unavailableReason: "durable-render-unavailable",
    });
    expect(fullReadiness).not.toHaveBeenCalled();
    expect(workspaceReadiness).toHaveBeenCalledTimes(4);

    const imported = await send(server, "/api/manim/project-imports", {
      body: JSON.stringify({
        imagePngBase64: null,
        name: "Imported",
        source: "from manim import *\nclass DemoScene(Scene):\n    def construct(self):\n        self.wait(1)\n",
        sourceName: "demo.py",
      }),
      headers: { "content-type": "application/json", origin: "https://studio.example" },
      method: "POST",
    });
    expect(imported).toMatchObject({ status: 201 });
    expect(importBrowserProject).toHaveBeenCalledOnce();
    expect(workspaceReadiness).toHaveBeenCalledTimes(5);
    expect(fullReadiness).not.toHaveBeenCalled();

    workspaceAvailable = false;
    expect(await send(server, "/api/manim/projects")).toMatchObject({ status: 503 });
    expect(workspaceReadiness).toHaveBeenCalledTimes(6);
    expect(projects).toHaveBeenCalledOnce();

    const render = await send(server, "/api/manim/projects/project-a/renders", {
      body: "{}",
      headers: { "content-type": "application/json", origin: "https://studio.example" },
      method: "POST",
    });
    expect(render).toMatchObject({ status: 503 });
    expect(renderReadiness).toHaveBeenCalledOnce();
    expect(fullReadiness).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(projects).toHaveBeenCalledOnce();
    expect(workspace).toHaveBeenCalledTimes(2);
  });

  it("admits render lifecycle routes through their reported boundary without requiring unrelated snapshot readiness", async () => {
    const fullReadiness = vi.fn(async () => ({ ready: false }) as const);
    const renderReadiness = vi.fn(async () => true);
    const start = vi.fn(async () => {
      throw new HttpError("Render admission reached the tenant runtime.", 409);
    });
    const video = vi.fn();
    const workspace = vi.fn(async () => ({
      commandAvailable: false,
      frame: { height: 8, width: 14.222 },
      projectId: "project-a",
      projectName: "Project A",
      renderCapability: { available: true, kind: "durable-sandbox", unavailableReason: null },
      sources: [],
    }));
    const baseRuntime = createRuntime(() => false);
    const server = await startProductionManimServer({
      admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
      config: await startConfig(),
      runtime: {
        ...baseRuntime,
        api: { ...baseRuntime.api, start, video, workspace } as unknown as ManimApi,
        ready: fullReadiness,
        renderReady: renderReadiness,
      },
    });
    servers.push(server);

    const inspected = await send(server, "/api/manim/projects/project-a/workspace");
    expect(inspected).toMatchObject({ status: 200 });
    expect(JSON.parse(inspected.body).renderCapability).toMatchObject({ available: true });

    const request = { ...renderRequest(), projectId: "project-a" };
    const render = await send(server, "/api/manim/projects/project-a/renders", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json", origin: "https://studio.example" },
      method: "POST",
    });
    expect(render).toMatchObject({ status: 409 });
    expect(start).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(renderReadiness).toHaveBeenCalledOnce();
    expect(fullReadiness).not.toHaveBeenCalled();

    const existingVideo = await send(server, "/api/manim/renders/00000000-0000-4000-8000-000000000001/video");
    expect(existingVideo).toMatchObject({ status: 503 });
    expect(fullReadiness).toHaveBeenCalledOnce();
    expect(renderReadiness).toHaveBeenCalledOnce();
    expect(video).not.toHaveBeenCalled();
  });

  it("serves authenticated editor storage independently from render readiness", async () => {
    const openedAt = new Date("2026-08-01T00:00:00.000Z");
    const sceneId = fastManimSnapshotSceneIdV1("scene.py", "Scene");
    const documentKey = createEditorDocumentKeyV1("scene.py", sceneId);
    const epoch = "10000000-0000-4000-8000-000000000001";
    const accountSubject = "00000000-0000-4000-8000-000000000001";
    const sessionSnapshot = {
      appliedPrograms: [],
      currentTime: 0,
      draftOperation: null,
      draftProgram: null,
      editingAppliedProgram: null,
      insertTool: "select" as const,
      interactionMode: "position" as const,
      motionDuration: 1,
      programUndoEntries: [],
      redoPrograms: [],
      selectedObjectIds: [],
      verifiedSourceDurationBasis: null,
    };
    const canonicalSession = canonicalEditorSessionSnapshotV1(sessionSnapshot);
    const openDocument = vi.fn<EditorDocumentRepositoryV1["openDocument"]>(async (input) => ({
      created: true,
      document: {
        documentKey,
        epoch,
        openedAt,
        origin: "imported-manim",
        projectId: input.projectId,
        revision: 0n,
        sealedAt: null,
        sourceHash: input.sourceHash,
        sourcePath: input.sourcePath,
        tenantId: input.tenantId,
        updatedAt: openedAt,
      },
      kind: "opened",
      projection: { programs: [], revision: 0n },
    }));
    const putSessionSnapshot = vi.fn<EditorDocumentRepositoryV1["putSessionSnapshot"]>(async (input) => ({
      kind: "stored",
      replayed: false,
      session: {
        documentKey: input.documentKey,
        documentRevision: input.documentRevision,
        epoch: input.epoch,
        projectId: input.projectId,
        sessionGeneration: input.expectedSessionGeneration + 1n,
        snapshot: canonicalSession.snapshot,
        snapshotByteSize: canonicalSession.byteSize,
        snapshotDigest: canonicalSession.digest,
        snapshotVersion: input.snapshotVersion,
        subjectId: input.subjectId,
        tenantId: input.tenantId,
        updatedAt: openedAt,
      },
    }));
    const editorDocuments: EditorDocumentRepositoryV1 = {
      close: async () => undefined,
      commitMutation: async () => {
        throw new Error("commitMutation was not expected");
      },
      createNativeDocument: async () => {
        throw new Error("createNativeDocument was not expected");
      },
      openDocument,
      putSessionSnapshot,
      readEventTail: async () => {
        throw new Error("readEventTail was not expected");
      },
      readSessionSnapshot: async () => {
        throw new Error("readSessionSnapshot was not expected");
      },
      ready: async () => true,
    };
    const fullReadiness = vi.fn(async () => ({ ready: false }) as const);
    const workspaceReadiness = vi.fn(async () => true);
    let editorAvailable = true;
    const editorReadiness = vi.fn(async () => editorAvailable);
    const baseRuntime = createRuntime(() => false);
    const admission = {
      authenticate: async ({ credentials }: { credentials: { authorization?: string } }) => {
        if (credentials.authorization === "Bearer tenant-a") {
          return { subjectId: accountSubject, tenantId: "tenant-a" };
        }
        if (credentials.authorization === "Bearer tenant-b") {
          return { subjectId: "foreign-user", tenantId: "tenant-b" };
        }
        return null;
      },
      ready: async () => true,
    };
    const server = await startProductionManimServer({
      admission,
      config: await startConfig(),
      runtime: {
        ...baseRuntime,
        editorDocuments,
        editorReady: editorReadiness,
        ready: fullReadiness,
        workspaceReady: workspaceReadiness,
      },
    });
    servers.push(server);
    const body = JSON.stringify({
      sceneName: "Scene",
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
    });
    const request = (authorization?: string) =>
      send(server, "/api/editor/projects/project-a/documents/open", {
        body,
        headers: {
          ...(authorization ? { authorization } : {}),
          "content-type": "application/json",
          origin: "https://studio.example",
        },
        method: "POST",
      });

    expect(await request()).toMatchObject({ status: 401 });
    expect(await request("Bearer tenant-b")).toMatchObject({ status: 403 });
    expect(openDocument).not.toHaveBeenCalled();
    const opened = await request("Bearer tenant-a");
    expect(opened).toMatchObject({ status: 201 });
    expect(JSON.parse(opened.body)).toMatchObject({
      document: { revision: "0" },
      kind: "opened",
      projection: { programs: [], revision: "0" },
    });
    expect(openDocument).toHaveBeenCalledWith(
      {
        projectId: "project-a",
        sceneId,
        sourceHash: "a".repeat(64),
        sourcePath: "scene.py",
        tenantId: "tenant-a",
      },
      expect.any(AbortSignal),
    );
    expect(fullReadiness).not.toHaveBeenCalled();
    expect(workspaceReadiness).toHaveBeenCalledOnce();
    expect(editorReadiness).toHaveBeenCalledOnce();

    const storedSession = await send(
      server,
      `/api/editor/projects/project-a/documents/${documentKey}/session?epoch=${epoch}`,
      {
        body: JSON.stringify({
          documentRevision: "0",
          epoch,
          expectedSessionGeneration: "0",
          snapshot: sessionSnapshot,
          snapshotVersion: 1,
        }),
        headers: {
          authorization: "Bearer tenant-a",
          "content-type": "application/json",
          origin: "https://studio.example",
        },
        method: "PUT",
      },
    );
    expect(storedSession).toMatchObject({ status: 200 });
    expect(JSON.parse(storedSession.body)).toMatchObject({
      kind: "stored",
      session: { sessionGeneration: "1", tenantId: "tenant-a" },
    });
    expect(putSessionSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        documentKey,
        epoch,
        subjectId: accountSubject,
        tenantId: "tenant-a",
      }),
      expect.any(AbortSignal),
    );

    const atomicBoundaryBody = JSON.stringify({ padding: "x".repeat(520 * 1024) });
    expect(Buffer.byteLength(atomicBoundaryBody)).toBeGreaterThan(512 * 1024);
    expect(Buffer.byteLength(atomicBoundaryBody)).toBeLessThanOrEqual(672 * 1024);
    expect(
      await send(server, `/api/editor/projects/project-a/documents/${documentKey}/events`, {
        body: atomicBoundaryBody,
        headers: {
          authorization: "Bearer tenant-a",
          "content-type": "application/json",
          origin: "https://studio.example",
        },
        method: "POST",
      }),
    ).toMatchObject({ status: 400 });

    editorAvailable = false;
    expect(await request("Bearer tenant-a")).toMatchObject({ status: 503 });
    expect(openDocument).toHaveBeenCalledOnce();

    const unconfigured = await startProductionManimServer({
      admission,
      config: await startConfig(),
      runtime: createRuntime(),
    });
    servers.push(unconfigured);
    expect(
      await send(unconfigured, "/api/editor/projects/project-a/documents/open", {
        body,
        headers: {
          authorization: "Bearer tenant-a",
          "content-type": "application/json",
          origin: "https://studio.example",
        },
        method: "POST",
      }),
    ).toMatchObject({ status: 503 });
  });

  it("requires admission and validates Host plus the immediate proxy before API routing", async () => {
    let principal: unknown = null;
    const server = await startProductionManimServer({
      admission: {
        authenticate: async () => principal,
        ready: async () => true,
      },
      config: await startConfig(),
      runtime: createRuntime(),
    });
    servers.push(server);

    expect(await send(server, "/api/manim/projects")).toMatchObject({
      headers: { connection: "close" },
      status: 401,
    });
    principal = TEST_PRINCIPAL;
    expect(await send(server, "/api/manim/projects", { headers: { host: "attacker.example" } })).toMatchObject({
      status: 421,
    });
    expect(await send(server, "/api/manim/projects", { headers: { "x-forwarded-for": "203.0.113.5" } })).toMatchObject({
      status: 400,
    });

    let admissionContext: unknown;
    const trustedServer = await startProductionManimServer({
      admission: {
        authenticate: async (request) => {
          admissionContext = request;
          return TEST_PRINCIPAL;
        },
        ready: async () => true,
      },
      config: await startConfig({ trustedProxyAddresses: ["127.0.0.1"] }),
      runtime: createRuntime(),
    });
    servers.push(trustedServer);
    expect(
      await send(trustedServer, "/api/manim/projects", {
        headers: {
          authorization: "Bearer credential",
          cookie: "session=credential",
          "x-forwarded-for": "203.0.113.5",
          "x-poietra-organization-id": "tenant-a",
        },
      }),
    ).toMatchObject({ status: 200 });
    expect(admissionContext).toMatchObject({
      credentials: { authorization: "Bearer credential", cookie: "session=credential" },
      directPeerAddress: "127.0.0.1",
      forwardedHeaders: { immediatePeerTrusted: true, present: true },
      requestedOrganizationId: "tenant-a",
    });
    expect(admissionContext).not.toHaveProperty("headers");
    expect(JSON.stringify(admissionContext)).not.toContain("203.0.113.5");
  });

  it.each([
    [403, "Tenant access is not available."],
    [503, "Tenant access is temporarily unavailable."],
  ] as const)("normalizes an authenticator %i without exposing adapter details", async (status, message) => {
    const server = await startProductionManimServer({
      admission: {
        authenticate: async () => {
          throw new HttpError("trusted adapter detail must remain private", status);
        },
        ready: async () => true,
      },
      config: await startConfig(),
      runtime: createRuntime(),
    });
    servers.push(server);

    const response = await send(server, "/api/manim/projects");
    expect(response.status).toBe(status);
    expect(JSON.parse(response.body)).toEqual({ error: message });
    expect(response.body).not.toContain("trusted adapter detail");
  });

  it("derives tenant access from verified claims and keeps local or foreign tenants outside the runtime", async () => {
    let createExistingCalls = 0;
    let projectCalls = 0;
    let runtimeReadyCalls = 0;
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const baseRuntime = createRuntime(
      () => {
        runtimeReadyCalls += 1;
        return true;
      },
      () => {
        projectCalls += 1;
      },
    );
    const server = await startProductionManimServer({
      admission: {
        authenticate: async ({ credentials }) => {
          if (credentials.authorization === "Bearer tenant-a") return TEST_PRINCIPAL;
          if (credentials.authorization === "Bearer tenant-b") {
            return { subjectId: "foreign-user", tenantId: "tenant-b" };
          }
          if (credentials.authorization === "Bearer local") {
            return { subjectId: "local-user", tenantId: "local-000000000000000000000000" };
          }
          return null;
        },
        ready: async () => true,
      },
      config: await startConfig(),
      logger,
      runtime: {
        ...baseRuntime,
        api: {
          ...baseRuntime.api,
          createProject: () => {
            createExistingCalls += 1;
            return {};
          },
        } as unknown as ManimApi,
      },
    });
    servers.push(server);

    expect(await send(server, "/api/manim/projects")).toMatchObject({ status: 401 });
    expect(await send(server, "/api/manim/projects", { headers: { authorization: "Bearer local" } })).toMatchObject({
      status: 401,
    });
    expect(await send(server, "/api/manim/projects", { headers: { authorization: "Bearer tenant-b" } })).toMatchObject({
      status: 403,
    });
    expect(records.filter(({ event }) => event === "production.authentication_rejected")).toHaveLength(2);
    expect(records.filter(({ event }) => event === "production.foreign_tenant_rejected")).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("Bearer local");
    expect(JSON.stringify(records)).not.toContain("Bearer tenant-b");
    expect(projectCalls).toBe(0);
    expect(runtimeReadyCalls).toBe(0);

    expect(await send(server, "/api/manim/projects", { headers: { authorization: "Bearer tenant-a" } })).toMatchObject({
      status: 200,
    });
    expect(projectCalls).toBe(1);
    expect(runtimeReadyCalls).toBe(0);

    const existingRegistration = await send(server, "/api/manim/projects", {
      body: JSON.stringify({ kind: "existing", name: "Foreign root", root: "/tenant-b/private" }),
      headers: {
        authorization: "Bearer tenant-a",
        "content-type": "application/json",
        origin: "https://studio.example",
      },
      method: "POST",
    });
    expect(existingRegistration).toMatchObject({ status: 403 });
    expect(runtimeReadyCalls).toBe(1);
    expect(createExistingCalls).toBe(0);
  });

  it("routes the injected AI adapter only after existing principal and tenant authorization", async () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    let generatorCalls = 0;
    let generatorBoundary: unknown;
    let runtimeReadyCalls = 0;
    const server = await startProductionManimServer({
      admission: {
        authenticate: async ({ credentials }) => {
          if (credentials.authorization === "Bearer tenant-a") return TEST_PRINCIPAL;
          if (credentials.authorization === "Bearer tenant-b") {
            return { subjectId: "foreign-user", tenantId: "tenant-b" };
          }
          return null;
        },
        ready: async () => true,
      },
      config: await startConfig(),
      editSuggestions: {
        generator: {
          async generate(request, signal) {
            generatorCalls += 1;
            generatorBoundary = signal;
            expect(request.prompt).toBe("SECRET_PROMPT_SOURCE_ENV_API_KEY_TRACEBACK");
            const possibleLogger = signal as unknown as {
              info?: (event: string, data: unknown) => void;
            };
            possibleLogger.info?.("adapter.injected_payload", {
              path: request.scene.id,
              prompt: request.prompt,
            });
            return {
              suggestion: {
                assumptions: [],
                kind: "clarification",
                message: "SECRET_MODEL_OUTPUT",
                operation: null,
                options: [],
                summary: "",
              },
              telemetry: {
                repairAttempted: false,
                usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
              },
            };
          },
        },
      },
      logger,
      runtime: createRuntime(() => {
        runtimeReadyCalls += 1;
        return true;
      }),
    });
    servers.push(server);
    const request = {
      body: JSON.stringify(editSuggestionBody()),
      headers: {
        authorization: "Bearer tenant-a",
        "content-type": "application/json",
        origin: "https://studio.example",
      },
      method: "POST",
    } as const;

    expect(
      await send(server, "/api/ai/edit-suggestions", {
        ...request,
        headers: { ...request.headers, authorization: "" },
      }),
    ).toMatchObject({
      status: 401,
    });
    expect(
      await send(server, "/api/ai/edit-suggestions", {
        ...request,
        headers: { ...request.headers, authorization: "Bearer tenant-b" },
      }),
    ).toMatchObject({ status: 403 });
    expect(generatorCalls).toBe(0);

    const response = await send(server, "/api/ai/edit-suggestions", request);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ kind: "clarification", message: "SECRET_MODEL_OUTPUT" });
    expect(generatorCalls).toBe(1);
    expect(generatorBoundary).toBeInstanceOf(AbortSignal);
    expect(generatorBoundary).not.toHaveProperty("info");
    expect(generatorBoundary).not.toHaveProperty("child");
    expect(runtimeReadyCalls).toBe(0);

    const aiRecords = records.filter((record) => record.context.component === "edit-suggestions-api");
    expect(aiRecords.some((record) => record.event === "response.sent")).toBe(true);
    expect(aiRecords.find((record) => record.event === "response.sent")?.data).toMatchObject({
      latencyMs: expect.any(Number),
      status: 200,
    });
    expect(aiRecords.find((record) => record.event === "model.responded")?.data).toEqual({
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    });
    expect(JSON.stringify(aiRecords)).not.toMatch(
      /SECRET_(?:CLARIFICATION|MODEL_OUTPUT|PROMPT|SOURCE|ENV|API_KEY|TRACEBACK)|production-user|tenant-a/,
    );
    expect(aiRecords.every((record) => /^[0-9a-f]{24}$/.test(String(record.context.tenantCorrelation)))).toBe(true);
  });

  it("requires the configured production Origin before calling the AI provider", async () => {
    let calls = 0;
    const server = await startProductionManimServer({
      admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
      config: await startConfig(),
      editSuggestions: {
        generator: {
          async generate() {
            calls += 1;
            throw new Error("must not run");
          },
        },
      },
      runtime: createRuntime(),
    });
    servers.push(server);

    const response = await send(server, "/api/ai/edit-suggestions", {
      body: JSON.stringify(editSuggestionBody()),
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  it("rejects non-origin-form targets and every unbounded or bodyless-method payload before routing", async () => {
    let projectCalls = 0;
    let unregisterCalls = 0;
    const baseRuntime = createRuntime(
      () => true,
      () => {
        projectCalls += 1;
      },
    );
    const server = await startProductionManimServer({
      admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
      config: await startConfig(),
      runtime: {
        ...baseRuntime,
        api: {
          ...baseRuntime.api,
          createProject() {},
          unregisterProject: async () => {
            unregisterCalls += 1;
            return {};
          },
        } as unknown as ManimApi,
      },
    });
    servers.push(server);

    expect(await send(server, "/\\evil.example/api/manim/projects")).toMatchObject({ status: 400 });
    expect(
      await send(server, "/api/manim/projects/example", {
        body: "{}",
        headers: { "content-type": "application/json", origin: "https://studio.example" },
        method: "DELETE",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await send(server, "/api/manim/projects/example", {
        body: "x".repeat(2_048),
        chunked: true,
        headers: { "content-type": "application/json", origin: "https://studio.example" },
        method: "DELETE",
      }),
    ).toMatchObject({ status: 400 });
    expect(projectCalls).toBe(0);
    expect(unregisterCalls).toBe(0);
  });

  it("uses configured HTTPS origin behind a proxy and applies the global body ceiling", async () => {
    const server = await startProductionManimServer({
      admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
      config: await startConfig({
        limits: { maxBodyBytes: 1_024 },
      }),
      runtime: createRuntime(),
    });
    servers.push(server);
    const endpoint = "/api/manim/renders/deadbeef/cancel";

    expect(
      await send(server, endpoint, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    ).toMatchObject({ status: 403 });
    expect(
      await send(server, endpoint, {
        body: "{}",
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        method: "POST",
      }),
    ).toMatchObject({ status: 403 });
    expect(
      await send(server, endpoint, {
        body: "{}",
        headers: { "content-type": "application/json", origin: "https://studio.example" },
        method: "POST",
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await send(server, endpoint, {
        body: JSON.stringify({ padding: "x".repeat(1_024) }),
        headers: { "content-type": "application/json", origin: "https://studio.example" },
        method: "POST",
      }),
    ).toMatchObject({ status: 413 });
  });

  it("logs a stable route template without query values or resource identifiers", async () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const server = await startProductionManimServer({
      admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
      config: await startConfig(),
      logger,
      runtime: createRuntime(),
    });
    servers.push(server);

    await send(server, "/api/manim/projects?sourcePath=%2Fprivate%2Fscene.py");
    expect(records.find((record) => record.event === "request.started")?.context.route).toBe("/api/manim/projects");
    expect(JSON.stringify(records)).not.toContain("private");
  });

  it("does not enter the runtime after shutdown starts while admission is pending", async () => {
    let releaseAdmission!: (principal: unknown) => void;
    let markAdmissionEntered!: () => void;
    const admissionEntered = new Promise<void>((resolveEntered) => {
      markAdmissionEntered = resolveEntered;
    });
    const admission = new Promise<unknown>((resolveAdmission) => {
      releaseAdmission = resolveAdmission;
    });
    let projectCalls = 0;
    let runtimeClosed = false;
    const runtime = createRuntime(
      () => true,
      () => {
        projectCalls += 1;
      },
    );
    const server = await startProductionManimServer({
      admission: {
        authenticate: async () => {
          markAdmissionEntered();
          return admission;
        },
        ready: async () => true,
      },
      config: await startConfig(),
      runtime: {
        ...runtime,
        close: async () => {
          runtimeClosed = true;
        },
      },
    });
    servers.push(server);

    const response = send(server, "/api/manim/projects");
    await admissionEntered;
    const shutdown = server.close();
    releaseAdmission(TEST_PRINCIPAL);

    expect(await response).toMatchObject({ status: 503 });
    await shutdown;
    expect(projectCalls).toBe(0);
    expect(runtimeClosed).toBe(true);
  });

  it("abandons an admission wait that ignores its signal before closing the runtime", async () => {
    let markAdmissionEntered!: () => void;
    const admissionEntered = new Promise<void>((resolveEntered) => {
      markAdmissionEntered = resolveEntered;
    });
    const order: string[] = [];
    const runtime = createRuntime();
    const server = await startProductionManimServer({
      admission: {
        authenticate: async (_request, signal) => {
          markAdmissionEntered();
          signal.addEventListener("abort", () => order.push("admission-aborted"), { once: true });
          return new Promise<boolean>(() => {});
        },
        ready: async () => true,
      },
      config: await startConfig({ limits: { requestDrainTimeoutMs: 100 } }),
      runtime: {
        ...runtime,
        close: async () => {
          order.push("runtime-closed");
        },
      },
    });
    servers.push(server);

    const request = send(server, "/api/manim/projects").catch(() => null);
    await admissionEntered;
    await expect(server.close()).rejects.toThrow(/fully close/i);
    await request;
    expect(order).toEqual(["admission-aborted", "runtime-closed"]);
  });

  it("never tears down the runtime underneath an API operation that ignores cancellation", async () => {
    let enterOperation!: () => void;
    const operationEntered = new Promise<void>((resolveEntered) => {
      enterOperation = resolveEntered;
    });
    let releaseOperation!: () => void;
    const operation = new Promise<void>((resolveOperation) => {
      releaseOperation = resolveOperation;
    });
    let markRuntimeClosed!: () => void;
    const runtimeClosed = new Promise<void>((resolveClosed) => {
      markRuntimeClosed = resolveClosed;
    });
    let closed = false;
    let resumedAfterClose = false;
    const baseRuntime = createRuntime();
    const server = await startProductionManimServer({
      admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => true },
      config: await startConfig({ limits: { requestDrainTimeoutMs: 100, runtimeCloseTimeoutMs: 100 } }),
      runtime: {
        ...baseRuntime,
        api: {
          ...baseRuntime.api,
          workspace: async () => {
            enterOperation();
            await operation;
            resumedAfterClose = closed;
            return {};
          },
        } as unknown as ManimApi,
        close: async () => {
          closed = true;
          markRuntimeClosed();
        },
      },
    });
    servers.push(server);

    const response = send(server, "/api/manim/workspace").catch(() => null);
    await operationEntered;
    await expect(server.close()).rejects.toThrow(/fully close/i);
    expect(closed).toBe(false);

    releaseOperation();
    await runtimeClosed;
    await response;
    expect(resumedAfterClose).toBe(false);
  });

  it("closes the listener and its runtime adapter exactly once", async () => {
    const runtime = createRuntime();
    let admissionCloses = 0;
    let closes = 0;
    const server = await startProductionManimServer({
      admission: {
        authenticate: async () => TEST_PRINCIPAL,
        close: async () => {
          admissionCloses += 1;
        },
        ready: async () => true,
      },
      config: await startConfig(),
      runtime: {
        ...runtime,
        close: async () => {
          closes += 1;
          await runtime.close();
        },
      },
    });
    servers.push(server);

    await server.close();
    await server.close();
    expect(admissionCloses).toBe(1);
    expect(closes).toBe(1);
    await expect(send(server, "/healthz")).rejects.toThrow();
  });

  it("bounds readiness probes and shutdown even when an adapter does not settle", async () => {
    const runtime = createRuntime();
    const server = await startProductionManimServer({
      admission: { authenticate: async () => TEST_PRINCIPAL, ready: async () => new Promise<boolean>(() => {}) },
      config: await startConfig({ limits: { readinessTimeoutMs: 100, runtimeCloseTimeoutMs: 100 } }),
      runtime: { ...runtime, close: () => new Promise<void>(() => {}) },
    });
    servers.push(server);

    const readinessStarted = performance.now();
    expect(await send(server, "/readyz")).toMatchObject({ status: 503 });
    expect(performance.now() - readinessStarted).toBeLessThan(2_000);
    await expect(server.close()).rejects.toThrow(/fully close/i);
  });

  it("closes the owned runtime when listener startup fails", async () => {
    const occupied = createHttpServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      occupied.once("error", rejectListen);
      occupied.listen(0, "127.0.0.1", () => resolveListen());
    });
    const port = (occupied.address() as AddressInfo).port;
    let admissionCloses = 0;
    let runtimeCloses = 0;
    try {
      const runtime = createRuntime();
      await expect(
        startProductionManimServer({
          admission: {
            authenticate: async () => TEST_PRINCIPAL,
            close: async () => {
              admissionCloses += 1;
            },
            ready: async () => true,
          },
          config: config({ port }),
          runtime: {
            ...runtime,
            close: async () => {
              runtimeCloses += 1;
            },
          },
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(admissionCloses).toBe(1);
      expect(runtimeCloses).toBe(1);
    } finally {
      await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));
    }
  });
});
