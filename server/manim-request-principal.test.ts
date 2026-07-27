import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HttpError, sendJson } from "./http/json";
import { createStructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { ManimProjectRegistry } from "./manim-project-registry";
import { authenticateManimRequestContext, handleManimRequest, type ManimRequestContext } from "./manim-render-http";
import { fakeRenderer, request, sceneSource } from "./manim-render-pipeline-test-fixtures";
import {
  authenticateManimPrincipal,
  createTrustedLocalManimPrincipal,
  isVerifiedManimPrincipal,
  localManimTenantId,
  type ManimPrincipalAuthenticator,
} from "./manim-request-principal";
import { ManimTenantRegistry } from "./manim-tenant-registry";

const roots: string[] = [];
const registries: ManimProjectRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Manim request principals", () => {
  it("only accepts bounded authenticator output and keeps local identities out of production", async () => {
    const signal = new AbortController().signal;
    const principal = await authenticateManimPrincipal(
      { authenticate: async () => ({ subjectId: "user-1", tenantId: "tenant-a" }) },
      null,
      signal,
    );
    expect(principal).toMatchObject({ subjectId: "user-1", tenantId: "tenant-a" });
    expect(isVerifiedManimPrincipal(principal)).toBe(true);
    expect(isVerifiedManimPrincipal({ subjectId: "user-1", tenantId: "tenant-a" })).toBe(false);
    expect(Object.isFrozen(principal)).toBe(true);

    for (const claims of [
      null,
      { subjectId: "user-1" },
      { subjectId: "user-1", tenantId: "tenant-a", untrustedRole: "admin" },
      { subjectId: "user 1", tenantId: "tenant-a" },
      { subjectId: "user-1", tenantId: "../tenant-a" },
      { subjectId: "user-1", tenantId: "studio-local" },
      { subjectId: "user-1", tenantId: localManimTenantId("/private/a") },
    ]) {
      const rejected = await authenticateManimPrincipal({ authenticate: async () => claims }, null, signal).catch(
        (error: unknown) => error,
      );
      expect(rejected).toMatchObject({ message: "Authentication is required.", status: 401 });
    }

    expect(() =>
      createTrustedLocalManimPrincipal({
        deployment: "production" as "test",
        tenantId: "tenant-a",
      }),
    ).toThrow(/cannot be configured for production/i);
    expect(localManimTenantId("/private/a")).toBe(localManimTenantId("/private/a"));
    expect(localManimTenantId("/private/a")).not.toBe(localManimTenantId("/private/b"));
  });

  it("routes one authenticated request into only its tenant registry", async () => {
    const [tenantARoot, tenantBRoot, tenantBOnlyRoot] = await Promise.all([
      mkdtemp(join(tmpdir(), "poietra-tenant-a-")),
      mkdtemp(join(tmpdir(), "poietra-tenant-b-")),
      mkdtemp(join(tmpdir(), "poietra-tenant-b-only-")),
    ]);
    roots.push(tenantARoot, tenantBRoot, tenantBOnlyRoot);
    await Promise.all(
      [tenantARoot, tenantBRoot, tenantBOnlyRoot].map((root) => writeFile(join(root, "scene.py"), sceneSource, "utf8")),
    );
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const tenantA = new ManimProjectRegistry({
      command: [process.execPath, fakeRenderer],
      frame: { height: 8, width: 14.222 },
      logger,
      projects: [{ id: "shared-project", name: "Tenant A workspace", root: tenantARoot }],
      tenantId: "tenant-a",
    });
    const tenantB = new ManimProjectRegistry({
      command: [process.execPath, fakeRenderer],
      frame: { height: 8, width: 14.222 },
      logger,
      projects: [
        { id: "shared-project", name: "Tenant B workspace", root: tenantBRoot },
        { id: "tenant-b-only", name: "Tenant B only", root: tenantBOnlyRoot },
      ],
      tenantId: "tenant-b",
    });
    registries.push(tenantA, tenantB);
    const tenants = new ManimTenantRegistry([tenantA, tenantB]);
    const authenticator: ManimPrincipalAuthenticator<string | undefined> = {
      authenticate: async (authorization) => {
        if (authorization === "Bearer tenant-a") return { subjectId: "user-a", tenantId: "tenant-a" };
        if (authorization === "Bearer tenant-b") return { subjectId: "user-b", tenantId: "tenant-b" };
        if (authorization === "Bearer unknown") return { subjectId: "user-c", tenantId: "tenant-c" };
        return null;
      },
    };
    const server = createServer((incoming, response) => {
      const signal = new AbortController().signal;
      void authenticateManimRequestContext(authenticator, incoming.headers.authorization, tenants, signal)
        .then((context) => handleManimRequest(context, incoming, response, logger))
        .catch((error: unknown) => {
          const status = error instanceof HttpError ? error.status : 500;
          sendJson(response, status, {
            error: error instanceof HttpError ? error.message : "Authentication failed.",
          });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const load = (path: string, authorization?: string) =>
        fetch(`${origin}${path}`, { headers: authorization ? { authorization } : {} });

      const unauthenticated = await load("/api/manim/projects");
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toEqual({ error: "Authentication is required." });
      const unknownTenant = await load("/api/manim/projects", "Bearer unknown");
      expect(unknownTenant.status).toBe(403);
      expect(await unknownTenant.json()).toEqual({ error: "Tenant access is not available." });

      const projectsA = await load("/api/manim/projects", "Bearer tenant-a");
      const projectsB = await load("/api/manim/projects", "Bearer tenant-b");
      expect(await projectsA.json()).toMatchObject({
        projects: [{ id: "shared-project", name: "Tenant A workspace" }],
      });
      expect(await projectsB.json()).toMatchObject({
        projects: [
          { id: "shared-project", name: "Tenant B workspace" },
          { id: "tenant-b-only", name: "Tenant B only" },
        ],
      });

      const crossProject = await load("/api/manim/projects/tenant-b-only/workspace", "Bearer tenant-a");
      const missingProject = await load("/api/manim/projects/missing-project/workspace", "Bearer tenant-a");
      expect([crossProject.status, await crossProject.text()]).toEqual([
        missingProject.status,
        await missingProject.text(),
      ]);
      expect(crossProject.status).toBe(404);

      const tenantBSession = await tenantB.start({ ...request(), projectId: "shared-project" });
      const crossSession = await load(`/api/manim/renders/${tenantBSession.id}`, "Bearer tenant-a");
      const missingSession = await load("/api/manim/renders/00000000-0000-4000-8000-000000000099", "Bearer tenant-a");
      expect([crossSession.status, await crossSession.text()]).toEqual([
        missingSession.status,
        await missingSession.text(),
      ]);
      expect(crossSession.status).toBe(404);

      const tenantAEvents = records.filter((record) => record.context.tenantId === "tenant-a");
      const tenantBEvents = records.filter((record) => record.context.tenantId === "tenant-b");
      expect(tenantAEvents.some((record) => record.event === "response.sent")).toBe(true);
      expect(tenantBEvents.some((record) => record.event === "response.sent")).toBe(true);
      expect(
        records
          .filter((record) => record.event.startsWith("render.") || record.event.startsWith("thumbnail."))
          .every((record) => typeof record.context.tenantId === "string"),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects an unbranded request context before selecting a tenant", () => {
    const tenants = new ManimTenantRegistry<{ storageRoots: readonly string[]; tenantId: string }>([
      { storageRoots: [join(tmpdir(), "poietra-test-tenant-a")], tenantId: "tenant-a" },
    ]);
    const context = {
      principal: { subjectId: "user-a", tenantId: "tenant-a" },
      tenants,
    } as unknown as ManimRequestContext;
    expect(() => context.tenants.forPrincipal(context.principal)).toThrow(
      expect.objectContaining({ message: "Authentication is required.", status: 401 }),
    );
  });

  it("rejects different tenants configured over the same physical project root", async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), "poietra-shared-tenant-root-"));
    roots.push(sharedRoot);
    await writeFile(join(sharedRoot, "scene.py"), sceneSource, "utf8");
    const first = new ManimProjectRegistry({
      command: ["poietra-command-that-does-not-exist"],
      frame: { height: 8, width: 14.222 },
      projects: [{ id: "shared-project", root: sharedRoot }],
      tenantId: "tenant-a",
    });
    const second = new ManimProjectRegistry({
      command: ["poietra-command-that-does-not-exist"],
      frame: { height: 8, width: 14.222 },
      projects: [{ id: "shared-project", root: sharedRoot }],
      tenantId: "tenant-b",
    });
    registries.push(first, second);
    expect(() => new ManimTenantRegistry([first, second])).toThrow(/storage roots must not overlap/i);
  });

  it("allows tenants to share one durable namespace because every durable key is tenant-owned", () => {
    expect(
      () =>
        new ManimTenantRegistry([
          {
            storageBoundary: { kind: "shared-durable", namespace: "production-primary" } as const,
            tenantId: "tenant-a",
          },
          {
            storageBoundary: { kind: "shared-durable", namespace: "production-primary" } as const,
            tenantId: "tenant-b",
          },
        ]),
    ).not.toThrow();
  });

  it.each([undefined, [], ["relative/root"], [1], Array.from({ length: 129 }, () => "/tmp/root")])(
    "rejects an invalid runtime storage namespace %#",
    (storageRoots) => {
      expect(
        () =>
          new ManimTenantRegistry([
            { storageRoots, tenantId: "tenant-a" } as unknown as {
              storageRoots: readonly string[];
              tenantId: string;
            },
          ]),
      ).toThrow(/absolute storage roots/i);
    },
  );
});
