import { createServer as createHttpServer, request as createRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "./http/json";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import {
  type ProductionManimServer,
  parseProductionManimServerConfig,
  startProductionManimServer,
} from "./manim-production-server";
import type { ManimApi } from "./manim-render-http";

const servers: ProductionManimServer[] = [];

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
  } as unknown as ManimApi;
  return {
    api,
    close: async () => {},
    ready: async () =>
      ready()
        ? ({
            executionBoundary: "adapter-attests-external-sandbox",
            ready: true,
            tenantBoundary: "single-tenant-deployment",
          } as const)
        : ({ ready: false } as const),
  } as const;
}

function send(
  server: ProductionManimServer,
  path: string,
  options: Readonly<{
    body?: string;
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
            ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
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
      runtimeCloseTimeoutMs: 10_000,
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
  it("rejects an incomplete production runtime adapter before listening", async () => {
    await expect(
      startProductionManimServer({
        admission: { admit: async () => true, ready: async () => true },
        config: await startConfig(),
        runtime: { ...createRuntime(), ready: undefined } as never,
      }),
    ).rejects.toThrow(/runtime adapter is incomplete/i);
  });

  it("keeps liveness public while readiness and API fail closed on either required dependency", async () => {
    let admissionReady = false;
    let runtimeReady = true;
    let admitCalls = 0;
    const server = await startProductionManimServer({
      admission: {
        admit: async () => {
          admitCalls += 1;
          return true;
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
    expect(admitCalls).toBe(0);

    admissionReady = true;
    runtimeReady = false;
    expect(await send(server, "/readyz")).toMatchObject({ status: 503 });
    runtimeReady = true;
    expect(await send(server, "/readyz")).toMatchObject({ status: 200 });
    expect(await send(server, "/api/manim/projects")).toMatchObject({ status: 200 });
    expect(admitCalls).toBe(1);
  });

  it("requires admission and validates Host plus the immediate proxy before API routing", async () => {
    let admitted = false;
    const server = await startProductionManimServer({
      admission: {
        admit: async () => admitted,
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
    admitted = true;
    expect(await send(server, "/api/manim/projects", { headers: { host: "attacker.example" } })).toMatchObject({
      status: 421,
    });
    expect(await send(server, "/api/manim/projects", { headers: { "x-forwarded-for": "203.0.113.5" } })).toMatchObject({
      status: 400,
    });

    let admissionContext: unknown;
    const trustedServer = await startProductionManimServer({
      admission: {
        admit: async (request) => {
          admissionContext = request;
          return true;
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
        },
      }),
    ).toMatchObject({ status: 200 });
    expect(admissionContext).toMatchObject({
      credentials: { authorization: "Bearer credential", cookie: "session=credential" },
      directPeerAddress: "127.0.0.1",
      forwardedHeaders: { immediatePeerTrusted: true, present: true },
    });
    expect(admissionContext).not.toHaveProperty("headers");
    expect(JSON.stringify(admissionContext)).not.toContain("203.0.113.5");
  });

  it("uses configured HTTPS origin behind a proxy and applies the global body ceiling", async () => {
    const server = await startProductionManimServer({
      admission: { admit: async () => true, ready: async () => true },
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
      admission: { admit: async () => true, ready: async () => true },
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
    let releaseAdmission!: (admitted: boolean) => void;
    let markAdmissionEntered!: () => void;
    const admissionEntered = new Promise<void>((resolveEntered) => {
      markAdmissionEntered = resolveEntered;
    });
    const admission = new Promise<boolean>((resolveAdmission) => {
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
        admit: async () => {
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
    releaseAdmission(true);

    expect(await response).toMatchObject({ status: 503 });
    await shutdown;
    expect(projectCalls).toBe(0);
    expect(runtimeClosed).toBe(true);
  });

  it("aborts and joins an admission adapter that ignores its signal before closing the runtime", async () => {
    let markAdmissionEntered!: () => void;
    const admissionEntered = new Promise<void>((resolveEntered) => {
      markAdmissionEntered = resolveEntered;
    });
    const order: string[] = [];
    const runtime = createRuntime();
    const server = await startProductionManimServer({
      admission: {
        admit: async (_request, signal) => {
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

  it("closes the listener and its runtime adapter exactly once", async () => {
    const runtime = createRuntime();
    let closes = 0;
    const server = await startProductionManimServer({
      admission: { admit: async () => true, ready: async () => true },
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
    expect(closes).toBe(1);
    await expect(send(server, "/healthz")).rejects.toThrow();
  });

  it("bounds readiness probes and shutdown even when an adapter does not settle", async () => {
    const runtime = createRuntime();
    const server = await startProductionManimServer({
      admission: { admit: async () => true, ready: async () => new Promise<boolean>(() => {}) },
      config: await startConfig({ limits: { readinessTimeoutMs: 100, runtimeCloseTimeoutMs: 100 } }),
      runtime: { ...runtime, close: () => new Promise<void>(() => {}) },
    });
    servers.push(server);

    const readinessStarted = performance.now();
    expect(await send(server, "/readyz")).toMatchObject({ status: 503 });
    expect(performance.now() - readinessStarted).toBeLessThan(1_000);
    await expect(server.close()).rejects.toThrow(/fully close/i);
  });

  it("closes the owned runtime when listener startup fails", async () => {
    const occupied = createHttpServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      occupied.once("error", rejectListen);
      occupied.listen(0, "127.0.0.1", () => resolveListen());
    });
    const port = (occupied.address() as AddressInfo).port;
    let runtimeCloses = 0;
    try {
      const runtime = createRuntime();
      await expect(
        startProductionManimServer({
          admission: { admit: async () => true, ready: async () => true },
          config: config({ port }),
          runtime: {
            ...runtime,
            close: async () => {
              runtimeCloses += 1;
            },
          },
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(runtimeCloses).toBe(1);
    } finally {
      await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));
    }
  });
});
