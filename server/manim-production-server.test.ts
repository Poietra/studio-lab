import { request as createRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import {
  ISOLATED_MANIM_RUNTIME_CAPABILITY_V1,
  type ProductionManimServer,
  parseProductionManimServerConfig,
  startProductionManimServer,
} from "./manim-production-server";
import { ManimProjectRegistry } from "./manim-project-registry";

const servers: ProductionManimServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

function config(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    deployment: "production",
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "https://studio.example",
    ...overrides,
  };
}

function createRuntime(ready: () => boolean = () => true) {
  const api = new ManimProjectRegistry({
    command: ["unused"],
    frame: { height: 8, width: 14.222222222222221 },
    projects: [],
  });
  return {
    api,
    capability: ISOLATED_MANIM_RUNTIME_CAPABILITY_V1,
    close: () => api.close(),
    ready: async () => ready(),
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
      shutdownGraceMs: 10_000,
    });
  });

  it.each([
    [{ ...config(), deployment: "development" }, /production/i],
    [{ ...config(), host: "localhost" }, /explicit IP/i],
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
  it("rejects a runtime without the isolated production capability before listening", async () => {
    await expect(
      startProductionManimServer({
        admission: { admit: async () => true, ready: async () => true },
        config: config(),
        runtime: { ...createRuntime(), capability: "legacy-host-spawn" } as never,
      }),
    ).rejects.toThrow(/isolated runtime capability/i);
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
      config: config(),
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
      config: config(),
      runtime: createRuntime(),
    });
    servers.push(server);

    expect(await send(server, "/api/manim/projects")).toMatchObject({ status: 401 });
    admitted = true;
    expect(await send(server, "/api/manim/projects", { headers: { host: "attacker.example" } })).toMatchObject({
      status: 421,
    });
    expect(await send(server, "/api/manim/projects", { headers: { "x-forwarded-for": "203.0.113.5" } })).toMatchObject({
      status: 400,
    });

    const trustedServer = await startProductionManimServer({
      admission: { admit: async () => true, ready: async () => true },
      config: config({ trustedProxyAddresses: ["127.0.0.1"] }),
      runtime: createRuntime(),
    });
    servers.push(trustedServer);
    expect(
      await send(trustedServer, "/api/manim/projects", { headers: { "x-forwarded-for": "203.0.113.5" } }),
    ).toMatchObject({ status: 200 });
  });

  it("uses configured HTTPS origin behind a proxy and applies the global body ceiling", async () => {
    const server = await startProductionManimServer({
      admission: { admit: async () => true, ready: async () => true },
      config: config({
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
      config: config(),
      logger,
      runtime: createRuntime(),
    });
    servers.push(server);

    await send(server, "/api/manim/projects?sourcePath=%2Fprivate%2Fscene.py");
    expect(records.find((record) => record.event === "request.started")?.context.route).toBe("/api/manim/projects");
    expect(JSON.stringify(records)).not.toContain("private");
  });

  it("closes the listener and its isolated runtime exactly once", async () => {
    const runtime = createRuntime();
    let closes = 0;
    const server = await startProductionManimServer({
      admission: { admit: async () => true, ready: async () => true },
      config: config(),
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
      config: config({ limits: { readinessTimeoutMs: 100, shutdownGraceMs: 100 } }),
      runtime: { ...runtime, close: () => new Promise<void>(() => {}) },
    });
    servers.push(server);

    const readinessStarted = performance.now();
    expect(await send(server, "/readyz")).toMatchObject({ status: 503 });
    expect(performance.now() - readinessStarted).toBeLessThan(1_000);
    await expect(server.close()).rejects.toThrow(/grace period/i);
  });
});
