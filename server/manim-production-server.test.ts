import { createServer as createHttpServer, request as createRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./http/json";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import {
  createOrganizationMembershipProductionAdmissionV1,
  type ProductionManimServer,
  parseProductionManimServerConfig,
  startProductionManimServer,
} from "./manim-production-server";
import type { ManimApi } from "./manim-render-http";

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

function createRuntime(ready: () => boolean = () => true, onProjects: () => void = () => {}) {
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
  } as const;
}

function send(
  server: ProductionManimServer,
  path: string,
  options: Readonly<{
    body?: string;
    chunked?: boolean;
    headers?: Readonly<Record<string, string>>;
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
      maxBodyBytes: 512 * 1024,
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

  it("admits a browser-native cookie request through its verified session organization", async () => {
    const resolveActiveMembership = vi.fn(async (_identity: unknown, organizationId: string) => ({
      organizationId,
      role: "member" as const,
      userId: "00000000-0000-4000-8000-000000000001",
      version: 1n,
    }));
    const authenticate = vi.fn(async (input: Readonly<{ credentials: Readonly<{ cookie?: string }> }>) =>
      input.credentials.cookie === "__Host-poietra-session=verified"
        ? {
            issuer: "https://identity.example",
            sessionOrganizationId: "tenant-a",
            subject: "external-user",
          }
        : null,
    );
    const server = await startProductionManimServer({
      admission: createOrganizationMembershipProductionAdmissionV1({
        identities: { authenticate, ready: async () => true },
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
        headers: { cookie: "__Host-poietra-session=verified" },
      }),
    ).toMatchObject({ status: 200 });
    expect(resolveActiveMembership).toHaveBeenCalledWith(
      { issuer: "https://identity.example", subject: "external-user" },
      "tenant-a",
      expect.any(AbortSignal),
    );
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

  it("keeps liveness public while readiness and API fail closed on either required dependency", async () => {
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
      runtime: createRuntime(() => runtimeReady),
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
    expect(runtimeReadyCalls).toBe(1);

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
