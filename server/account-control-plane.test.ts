import { describe, expect, it, vi } from "vitest";
import { createOidcAccountControlPlaneV1 } from "./account-control-plane";
import type { AccountSessionViewRepositoryV1 } from "./accounts/account-session-repository";
import type { OidcLoginRepositoryV1 } from "./accounts/oidc-login-repository";

function repository() {
  const close = vi.fn(async () => undefined);
  const value: OidcLoginRepositoryV1 = {
    close,
    consumeLoginAttempt: vi.fn(async () => null),
    createLoginAttempt: vi.fn(async () => ({ expiresAt: new Date(Date.now() + 60_000) })),
    issueAccountSession: vi.fn(async () => null),
    ready: vi.fn(async () => true),
  };
  return { close, value };
}

function sessionRepository() {
  const close = vi.fn(async () => undefined);
  const value: AccountSessionViewRepositoryV1 = {
    close,
    resolveAccountSession: vi.fn(async () => ({
      activeOrganizationId: "organization-a",
      organizations: [{ displayName: "Organization A", id: "organization-a", role: "billing" as const }],
      user: { displayName: "Ada Lovelace", id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3" },
    })),
  };
  return { close, value };
}

describe("OIDC account control-plane composition", () => {
  it("creates and closes request-scoped storage only for accepted routes", async () => {
    const created: ReturnType<typeof repository>[] = [];
    const sessionCreated: ReturnType<typeof sessionRepository>[] = [];
    const controlPlane = createOidcAccountControlPlaneV1({
      oidc: {
        clientId: "poietra",
        clientSecret: "secret",
        issuer: "https://identity.example",
        publicOrigin: "https://studio.example",
      },
      repository: (environment: { hyperdrive: string }) => {
        expect(environment).toEqual({ hyperdrive: "request-scoped" });
        const next = repository();
        created.push(next);
        return next.value;
      },
      sessionRepository: (environment: { hyperdrive: string }) => {
        expect(environment).toEqual({ hyperdrive: "request-scoped" });
        const next = sessionRepository();
        sessionCreated.push(next);
        return next.value;
      },
    });

    const environment = { hyperdrive: "request-scoped" };
    await expect(controlPlane.ready(environment)).resolves.toBe(true);
    await expect(
      controlPlane.fetch(new Request("https://attacker.example/auth/oidc/start"), environment),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      controlPlane.fetch(new Request("https://studio.example/auth/oidc/start", { method: "POST" }), environment),
    ).resolves.toMatchObject({ status: 405 });
    await expect(
      controlPlane.fetch(new Request("https://studio.example/auth/oidc/callback?state=invalid"), environment),
    ).resolves.toMatchObject({ status: 400 });
    const token = "A".repeat(43);
    await expect(
      controlPlane.fetch(
        new Request(`https://studio.example/auth/oidc/callback?state=${token}&code=authorization-code`, {
          headers: { cookie: `__Host-poietra_oidc_login=${token}` },
        }),
        environment,
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      controlPlane.fetch(
        new Request("https://studio.example/api/account/session", {
          headers: { cookie: `__Host-poietra_session=${token}` },
        }),
        environment,
      ),
    ).resolves.toMatchObject({ status: 200 });

    expect(created).toHaveLength(2);
    expect(sessionCreated).toHaveLength(1);
    expect(created[0]?.value.ready).toHaveBeenCalledOnce();
    expect(created[1]?.value.consumeLoginAttempt).toHaveBeenCalledOnce();
    expect(created.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
    expect(sessionCreated[0]?.close).toHaveBeenCalledOnce();
  });

  it("does not initialize OIDC configuration for an existing account session", async () => {
    const session = sessionRepository();
    const oidcRepository = vi.fn(() => {
      throw new Error("OIDC storage must not be opened");
    });
    const controlPlane = createOidcAccountControlPlaneV1({
      oidc: {
        clientId: "",
        clientSecret: "",
        issuer: "not-an-issuer",
        publicOrigin: "https://studio.example",
      },
      repository: oidcRepository,
      sessionRepository: () => session.value,
    });
    const token = "A".repeat(43);

    const response = await controlPlane.fetch(
      new Request("https://studio.example/api/account/session", {
        headers: { cookie: `__Host-poietra_session=${token}` },
      }),
      { hyperdrive: "request-scoped" },
    );

    expect(response.status).toBe(200);
    expect(oidcRepository).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
    await expect(
      controlPlane.fetch(new Request("https://studio.example/auth/oidc/start"), { hyperdrive: "request-scoped" }),
    ).rejects.toThrow();
    expect(oidcRepository).not.toHaveBeenCalled();
  });
});
