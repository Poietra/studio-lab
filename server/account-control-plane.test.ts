import { describe, expect, it, vi } from "vitest";
import { createOidcAccountControlPlaneV1 } from "./account-control-plane";
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

describe("OIDC account control-plane composition", () => {
  it("creates and closes request-scoped storage only for accepted routes", async () => {
    const created: ReturnType<typeof repository>[] = [];
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

    expect(created).toHaveLength(2);
    expect(created[0]?.value.ready).toHaveBeenCalledOnce();
    expect(created[1]?.value.consumeLoginAttempt).toHaveBeenCalledOnce();
    expect(created.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
  });
});
